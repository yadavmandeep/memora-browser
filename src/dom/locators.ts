import { MemoraDocument, MemoraElement, MemoraNode } from './node.js';
import { evaluateXPath } from './xpath.js';
import { SemanticPageSnapshot } from '../types/index.js';

/**
 * Context provided to locator strategies during element resolution.
 */
export interface LocatorContext {
  document: MemoraDocument;
  getSemanticSnapshot?: () => SemanticPageSnapshot;
}

/**
 * Strategy interface for resolving an element from a string expression.
 * Modeled after Playwright's modular SelectorEngine architecture.
 */
export interface LocatorStrategy {
  readonly name: string;
  matches(selector: string): boolean;
  resolve(selector: string, ctx: LocatorContext): MemoraElement | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sequential Action ID Strategy (@1, @2, @4, ...)
// ─────────────────────────────────────────────────────────────────────────────
export class ActionIdStrategy implements LocatorStrategy {
  public readonly name = 'action-id';

  public matches(selector: string): boolean {
    return /^@\d+$/.test(selector.trim());
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const trimmed = selector.trim();
    if (!ctx.getSemanticSnapshot) return null;

    const snapshot = ctx.getSemanticSnapshot();

    // Fast-path: Check direct stamped __actionId on DOM nodes
    const findByActionId = (node: MemoraNode): MemoraElement | null => {
      if (node instanceof MemoraElement) {
        if ((node as any).__actionId === trimmed) return node;
        for (const child of node.childNodes) {
          const found = findByActionId(child);
          if (found) return found;
        }
      }
      return null;
    };

    const direct = findByActionId(ctx.document);
    if (direct) return direct;

    // Fallback: Resolve via snapshot action selector
    const match = snapshot.actions.find(a => a.actionId === trimmed);
    if (match) {
      try {
        return ctx.document.querySelector(match.selector);
      } catch {
        return null;
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Semantic Action Alias Strategy (@email, @password, @submit, @country, ...)
// ─────────────────────────────────────────────────────────────────────────────
export class SemanticAliasStrategy implements LocatorStrategy {
  public readonly name = 'semantic-alias';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return trimmed.startsWith('@') && !/^@\d+$/.test(trimmed);
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    if (!ctx.getSemanticSnapshot) return null;
    const alias = selector.trim().slice(1).toLowerCase();
    const snapshot = ctx.getSemanticSnapshot();

    const match = snapshot.actions.find(a => {
      const name = (a.name || '').toLowerCase();
      const text = (a.text || '').toLowerCase();
      const placeholder = (a.placeholder || '').toLowerCase();
      const sel = (a.selector || '').toLowerCase();
      return (
        name === alias ||
        placeholder === alias ||
        text === alias ||
        name.includes(alias) ||
        placeholder.includes(alias) ||
        sel.includes(alias) ||
        text.includes(alias)
      );
    });

    if (match) {
      try {
        return ctx.document.querySelector(match.selector);
      } catch {
        return null;
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. XPath Strategy (//button, xpath://div/button, xpath=//...)
// ─────────────────────────────────────────────────────────────────────────────
export class XPathStrategy implements LocatorStrategy {
  public readonly name = 'xpath';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('xpath:') || trimmed.startsWith('xpath=');
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const expr = selector.trim().replace(/^xpath[:=]/, '').trim();
    try {
      const matches = evaluateXPath(expr, ctx.document, ctx.document);
      return matches.length > 0 ? matches[0] : null;
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Playwright Text Locator Strategy (text=Submit, text="Sign In", text:...)
// ─────────────────────────────────────────────────────────────────────────────
export class TextLocatorStrategy implements LocatorStrategy {
  public readonly name = 'text';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return trimmed.startsWith('text=') || trimmed.startsWith('text:');
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const textQuery = selector
      .trim()
      .replace(/^text[:=]/, '')
      .replace(/^["']|["']$/g, '')
      .trim()
      .toLowerCase();

    const allElements: MemoraElement[] = [];
    const collect = (node: MemoraNode) => {
      if (node instanceof MemoraElement) {
        allElements.push(node);
        for (const c of node.childNodes) collect(c);
      }
    };
    collect(ctx.document);

    // 1. Prioritize interactive elements (button, a, input, select)
    const interactive = allElements.filter(
      e => ['button', 'a', 'input', 'select'].includes(e.tagName.toLowerCase()) || e.getAttribute('role') === 'button'
    );
    const interMatch = interactive.find(
      e => (e.textContent || e.getAttribute('value') || '').trim().toLowerCase() === textQuery
    );
    if (interMatch) return interMatch;

    const interSub = interactive.find(
      e => (e.textContent || e.getAttribute('value') || '').toLowerCase().includes(textQuery)
    );
    if (interSub) return interSub;

    // 2. Fallback to any element with exact text
    return allElements.find(e => (e.textContent || '').trim().toLowerCase() === textQuery) ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Playwright Label Strategy (label:Email, label="Email Address", label=...)
// ─────────────────────────────────────────────────────────────────────────────
export class LabelLocatorStrategy implements LocatorStrategy {
  public readonly name = 'label';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return trimmed.startsWith('label:') || trimmed.startsWith('label=');
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const labelQuery = selector
      .trim()
      .replace(/^label[:=]/, '')
      .replace(/^["']|["']$/g, '')
      .trim()
      .toLowerCase();

    // A. Match <label> with text
    const labels = ctx.document.querySelectorAll('label');
    for (const lbl of labels) {
      if (lbl.textContent.trim().toLowerCase().includes(labelQuery)) {
        const forId = lbl.getAttribute('for');
        if (forId) {
          try {
            const input = ctx.document.querySelector(`#${forId.replace(/"/g, '\\"')}`);
            if (input) return input;
          } catch {}
        }
        const nested = lbl.querySelector('input, select, textarea');
        if (nested) return nested;
      }
    }

    // B. Match aria-label or aria-labelledby
    try {
      const ariaMatch = ctx.document.querySelector(`[aria-label*="${labelQuery.replace(/"/g, '\\"')}"]`);
      if (ariaMatch) return ariaMatch;
    } catch {}

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Playwright Placeholder Strategy (placeholder:Email, placeholder=...)
// ─────────────────────────────────────────────────────────────────────────────
export class PlaceholderLocatorStrategy implements LocatorStrategy {
  public readonly name = 'placeholder';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return trimmed.startsWith('placeholder:') || trimmed.startsWith('placeholder=');
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const phQuery = selector
      .trim()
      .replace(/^placeholder[:=]/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    try {
      return ctx.document.querySelector(`[placeholder*="${phQuery.replace(/"/g, '\\"')}"]`);
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. TestID Strategy (testid:submit-btn, data-testid=..., data-qa=...)
// ─────────────────────────────────────────────────────────────────────────────
export class TestIdLocatorStrategy implements LocatorStrategy {
  public readonly name = 'testid';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return (
      trimmed.startsWith('testid:') ||
      trimmed.startsWith('testid=') ||
      trimmed.startsWith('data-testid:') ||
      trimmed.startsWith('data-testid=')
    );
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const tid = selector
      .trim()
      .replace(/^(data-)?testid[:=]/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'data-cy']) {
      try {
        const el = ctx.document.querySelector(`[${attr}="${tid.replace(/"/g, '\\"')}"]`);
        if (el) return el;
      } catch {}
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Playwright Role Strategy (role:button[name="Submit"], role=...)
// ─────────────────────────────────────────────────────────────────────────────
export class RoleLocatorStrategy implements LocatorStrategy {
  public readonly name = 'role';

  public matches(selector: string): boolean {
    const trimmed = selector.trim();
    return trimmed.startsWith('role:') || trimmed.startsWith('role=');
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const roleMatch = selector.trim().match(/^role[:=]([a-zA-Z]+)(?:\[name=["']?([^"']+)["']?\])?/);
    if (!roleMatch) return null;

    const [, roleName, accessibleName] = roleMatch;
    try {
      const candidates = ctx.document.querySelectorAll(`[role="${roleName}"], ${roleName}`);
      if (!accessibleName) {
        return candidates.length > 0 ? candidates[0] : null;
      }
      const accLower = accessibleName.toLowerCase();
      for (const cand of candidates) {
        const txt = (
          cand.getAttribute('aria-label') ||
          cand.getAttribute('value') ||
          cand.textContent ||
          ''
        )
          .trim()
          .toLowerCase();
        if (txt.includes(accLower)) return cand;
      }
    } catch {}

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Standard CSS Selector Strategy (#id, .class, input[name="..."])
// ─────────────────────────────────────────────────────────────────────────────
export class CssLocatorStrategy implements LocatorStrategy {
  public readonly name = 'css';

  public matches(selector: string): boolean {
    // Attempt standard CSS unless it has obvious non-CSS prefixes
    const s = selector.trim();
    return !s.startsWith('@') && !s.startsWith('//') && !s.includes(':') && !s.includes('=')
      ? true
      : /^[#.\[a-zA-Z]/.test(s);
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    try {
      return ctx.document.querySelector(selector.trim());
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Fuzzy Attribute Strategy (Bare string like "username" -> #username or [name="username"])
// ─────────────────────────────────────────────────────────────────────────────
export class FuzzyAttributeStrategy implements LocatorStrategy {
  public readonly name = 'fuzzy-attribute';

  public matches(selector: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(selector.trim());
  }

  public resolve(selector: string, ctx: LocatorContext): MemoraElement | null {
    const val = selector.trim();
    try {
      const byId = ctx.document.querySelector(`#${val}`);
      if (byId) return byId;
      const byName = ctx.document.querySelector(`[name="${val}"]`);
      if (byName) return byName;
      const byTestId = ctx.document.querySelector(`[data-testid="${val}"]`);
      if (byTestId) return byTestId;
    } catch {}
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal Locator Engine (Orchestrator)
// ─────────────────────────────────────────────────────────────────────────────
export class LocatorEngine {
  private strategies: LocatorStrategy[] = [
    new ActionIdStrategy(),
    new SemanticAliasStrategy(),
    new XPathStrategy(),
    new TextLocatorStrategy(),
    new LabelLocatorStrategy(),
    new PlaceholderLocatorStrategy(),
    new TestIdLocatorStrategy(),
    new RoleLocatorStrategy(),
    new CssLocatorStrategy(),
    new FuzzyAttributeStrategy(),
  ];

  /**
   * Register a custom locator strategy (plugin / extension point)
   */
  public registerStrategy(strategy: LocatorStrategy, prepend = false): void {
    if (prepend) {
      this.strategies.unshift(strategy);
    } else {
      this.strategies.push(strategy);
    }
  }

  /**
   * Resolve an element using the registered strategy pipeline.
   */
  public resolve(target: string, ctx: LocatorContext): MemoraElement | null {
    if (!target || typeof target !== 'string') return null;
    const trimmed = target.trim();

    for (const strategy of this.strategies) {
      if (strategy.matches(trimmed)) {
        const found = strategy.resolve(trimmed, ctx);
        if (found) return found;
      }
    }

    // Fallback: If no specialized strategy matched or found element, try standard CSS
    try {
      return ctx.document.querySelector(trimmed);
    } catch {
      return null;
    }
  }
}

// Default singleton instance
export const defaultLocatorEngine = new LocatorEngine();

