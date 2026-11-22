import { MemoraDocument, MemoraElement } from './node.js';
import { SemanticPageSnapshot, InteractiveElement } from '../types/index.js';

export interface HealedLocator {
  originalTarget: string;
  healedSelector: string;
  strategy: 'exact' | 'semantic_text' | 'aria_label' | 'placeholder' | 'tag_proximity';
  confidence: number;
  matchedElementText?: string;
}

/**
 * Self-Healing Locator Engine.
 * Automatically recovers from broken selectors, altered CSS classes, and shifted action IDs
 * by matching semantic role, accessible text, ARIA attributes, and structural proximity.
 */
export class SelfHealingLocator {
  /**
   * Attempts to find an alternate working selector when an original target fails.
   */
  public heal(
    target: string,
    doc: MemoraDocument,
    lastSnapshot?: SemanticPageSnapshot | null
  ): HealedLocator | null {
    // 1. Clues from last known snapshot action items
    let targetClue: Partial<InteractiveElement> | null = null;
    if (lastSnapshot && target.startsWith('@')) {
      const found = lastSnapshot.actions?.find(a => a.actionId === target);
      if (found) targetClue = found;
    }

    const allInteractive = doc.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [onclick]');

    // Strategy A: Match by accessible text or button content
    const targetText = (targetClue?.text || target.replace(/^[#.@]/, '')).trim().toLowerCase();
    if (targetText.length >= 2) {
      for (const el of allInteractive) {
        const text = (el.textContent || el.getAttribute('value') || '').trim().toLowerCase();
        if (text === targetText || (text.includes(targetText) && targetText.length > 3)) {
          const tag = el.tagName.toLowerCase();
          const selector = el.getAttribute('id')
            ? `#${el.getAttribute('id')}`
            : `${tag}:has-text("${el.textContent.trim().slice(0, 30)}")`;
          return {
            originalTarget: target,
            healedSelector: selector,
            strategy: 'semantic_text',
            confidence: text === targetText ? 0.95 : 0.85,
            matchedElementText: el.textContent.trim()
          };
        }
      }
    }

    // Strategy B: Match by aria-label
    if (targetClue?.name || targetText) {
      const searchName = (targetClue?.name || targetText).toLowerCase();
      for (const el of allInteractive) {
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (aria && (aria === searchName || aria.includes(searchName))) {
          const selector = `[aria-label="${el.getAttribute('aria-label')}"]`;
          return {
            originalTarget: target,
            healedSelector: selector,
            strategy: 'aria_label',
            confidence: 0.9,
            matchedElementText: aria
          };
        }
      }
    }

    // Strategy C: Match by placeholder
    if (targetClue?.placeholder || targetText) {
      const searchPlaceholder = (targetClue?.placeholder || targetText).toLowerCase();
      for (const el of allInteractive) {
        const ph = (el.getAttribute('placeholder') || '').trim().toLowerCase();
        if (ph && (ph === searchPlaceholder || ph.includes(searchPlaceholder))) {
          const selector = `input[placeholder="${el.getAttribute('placeholder')}"]`;
          return {
            originalTarget: target,
            healedSelector: selector,
            strategy: 'placeholder',
            confidence: 0.88,
            matchedElementText: ph
          };
        }
      }
    }

    return null;
  }
}
