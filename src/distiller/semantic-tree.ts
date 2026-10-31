import { MemoraDocument, MemoraElement, MemoraNode } from '../dom/node.js';
import { InteractiveElement, SemanticPageSnapshot, SnapshotOptions } from '../types/index.js';
import { convertToMarkdown } from './markdown.js';

function isElementHidden(node: MemoraElement): boolean {
  if (node.hasAttribute('hidden')) return true;
  if (node.getAttribute('aria-hidden') === 'true') return true;
  if (node.tagName.toLowerCase() === 'input' && node.getAttribute('type') === 'hidden') return true;
  const style = node.getAttribute('style') || '';
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return true;
  return false;
}

export function cleanUrlForLLM(href?: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('javascript:')) return 'javascript:void(0)';
  try {
    const u = new URL(href, 'https://memora-distill.local');
    // If it is an ad redirect wrapper, unwrap the target url if present
    if (u.pathname.includes('/clk') || u.pathname.includes('/sspa/click') || u.pathname.includes('/adclick')) {
      const target = u.searchParams.get('url') || u.searchParams.get('r');
      if (target) {
        return cleanUrlForLLM(target);
      }
    }
    // Strip heavy tracking tokens, affiliate hashes, session tracking
    const trackingParams = [
      'ref', 'ref_', 'pf_rd_r', 'pf_rd_p', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg',
      'qid', 'spc', 'sp_csd', 'dib', 'dib_tag', 'aref', 'content-id', 'p',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'msclkid', 'dclid'
    ];
    for (const p of trackingParams) {
      u.searchParams.delete(p);
    }
    const hasOrigin = u.origin !== 'https://memora-distill.local';
    let clean = (hasOrigin ? u.origin : '') + u.pathname;
    if (u.search && u.search.length > 1) {
      clean += u.search;
    }
    // Truncate if still excessively long
    return clean.length > 120 ? clean.slice(0, 117) + '...' : clean;
  } catch {
    return href.length > 120 ? href.slice(0, 117) + '...' : href;
  }
}

// Common noisy layout/boilerplate elements to automatically skip in Action Map
const DEFAULT_NOISE_SELECTORS = [
  '#nav-assist-skip-to-main-content',
  '#nav-assist-skip-to-results',
  '#nav-assist-skip-to-filters',
  '.skip-to-content',
  '.skip-link',
  '#cookie-banner',
  '.cookie-banner',
  '#onetrust-banner-sdk'
];

function hasHiddenAncestor(node: MemoraElement): boolean {
  let cur: MemoraElement | null = node.parentNode;
  while (cur && cur.nodeType === 1) {
    if (isElementHidden(cur)) return true;
    cur = cur.parentNode;
  }
  return false;
}

function isElementExcluded(elem: MemoraElement, excludeSelectors?: string[]): boolean {
  if (!excludeSelectors || excludeSelectors.length === 0) return false;
  for (const sel of excludeSelectors) {
    try {
      if (elem.matches(sel)) return true;
    } catch {
      // Ignore invalid selector syntax
    }
  }
  return false;
}

function isUnique(selector: string, node: MemoraElement, root: MemoraDocument | MemoraElement): boolean {
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === node;
  } catch {
    return false;
  }
}

function getSiblingNthOfType(element: MemoraElement): number {
  if (!element.parentNode) return 1;
  const tag = element.tagName.toLowerCase();
  let count = 0;
  for (const child of element.parentNode.childNodes) {
    if (child instanceof MemoraElement && child.tagName.toLowerCase() === tag) {
      count++;
      if (child === element) return count;
    }
  }
  return 1;
}

export function generateUniqueSelector(node: MemoraElement, root: MemoraDocument | MemoraElement): string {
  const tag = node.tagName.toLowerCase();

  // 1. Try standard simple ID
  if (node.id) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(node.id)) {
      const cand = `#${node.id}`;
      if (isUnique(cand, node, root)) return cand;
    }
    const idAttr = `[id="${node.id.replace(/"/g, '\\"')}"]`;
    if (isUnique(idAttr, node, root)) return idAttr;
  }

  // 2. Try Test ID attributes
  for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'data-cy']) {
    const val = node.getAttribute(attr);
    if (val) {
      const cand = `[${attr}="${val.replace(/"/g, '\\"')}"]`;
      if (isUnique(cand, node, root)) return cand;
    }
  }

  // 3. Try name attribute
  const name = node.getAttribute('name');
  if (name) {
    const cand = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
    if (isUnique(cand, node, root)) return cand;
  }

  // 4. Try aria-label
  const ariaLabel = node.getAttribute('aria-label');
  if (ariaLabel) {
    const cand = `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    if (isUnique(cand, node, root)) return cand;
  }

  // 5. Try placeholder
  const placeholder = node.getAttribute('placeholder');
  if (placeholder) {
    const cand = `${tag}[placeholder="${placeholder.replace(/"/g, '\\"')}"]`;
    if (isUnique(cand, node, root)) return cand;
  }

  // 6. Try unique classes
  if (node.className) {
    const classes = node.className.trim().split(/\s+/).filter(c => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c));
    for (const cls of classes) {
      const cand = `${tag}.${cls}`;
      if (isUnique(cand, node, root)) return cand;
    }
    if (classes.length > 1) {
      const cand = `${tag}.${classes.slice(0, 3).join('.')}`;
      if (isUnique(cand, node, root)) return cand;
    }
  }

  // 7. Build hierarchical path with :nth-of-type disambiguation
  const path: string[] = [];
  let current: MemoraElement | null = node;

  while (current && current !== root && current.nodeType === 1) {
    const curTag = current.tagName.toLowerCase();
    if (current.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(current.id)) {
      path.unshift(`#${current.id}`);
      break;
    }
    const nth = getSiblingNthOfType(current);
    path.unshift(`${curTag}:nth-of-type(${nth})`);
    current = current.parentNode;
  }

  const hierarchical = path.join(' > ');
  if (hierarchical && isUnique(hierarchical, node, root)) {
    return hierarchical;
  }

  return hierarchical || tag;
}

export function extractSemanticSnapshot(
  doc: MemoraDocument,
  url: string,
  options: SnapshotOptions = {}
): SemanticPageSnapshot {
  let rootNode: MemoraNode = doc;

  if (options.focusSelector) {
    try {
      const focused = doc.querySelector(options.focusSelector);
      if (focused) {
        rootNode = focused;
      }
    } catch {
      // Fallback to doc
    }
  }

  const actions: InteractiveElement[] = [];
  let actionCounter = 1;

  function walk(node: MemoraNode) {
    if (node instanceof MemoraElement) {
      const tag = node.tagName.toLowerCase();

      // Skip non-renderable tags
      if (['script', 'style', 'noscript', 'svg', 'canvas', 'template'].includes(tag)) {
        return;
      }

      // Check visibility filtering
      if (options.filterHidden !== false) {
        if (isElementHidden(node) || hasHiddenAncestor(node)) {
          return;
        }
      }

      // Check excluded selectors
      const effectiveExclude = [...(options.excludeSelectors || []), ...DEFAULT_NOISE_SELECTORS];
      if (isElementExcluded(node, effectiveExclude)) {
        return;
      }

      const role = (node.getAttribute('role') || '').toLowerCase();
      const isAriaInteractive = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'option', 'treeitem'].includes(role);
      const isNativeInteractive = ['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag);
      const hasTabIndex = node.getAttribute('tabindex') === '0';
      const hasOnClick = node.hasAttribute('onclick');

      if (isNativeInteractive || isAriaInteractive || hasTabIndex || hasOnClick) {
        // Collect accessible name / text
        let text = (
          node.getAttribute('aria-label') ||
          node.getAttribute('placeholder') ||
          node.getAttribute('title') ||
          node.getAttribute('value') ||
          node.textContent
        ).trim();

        text = text.replace(/\s+/g, ' ').slice(0, 80);

        const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
        const isClickable = !isInput || node.getAttribute('type') === 'submit' || node.getAttribute('type') === 'button';
        const type = node.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : undefined);
        const name = node.getAttribute('name') || undefined;
        const value = node.getAttribute('value') || undefined;
        const placeholder = node.getAttribute('placeholder') || undefined;
        const href = node.getAttribute('href') || undefined;

        // Computed accessible state
        const disabled = node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';
        const checked = node.hasAttribute('checked') || node.getAttribute('aria-checked') === 'true';
        const expanded = node.getAttribute('aria-expanded') === 'true';
        const selected = node.hasAttribute('selected') || node.getAttribute('aria-selected') === 'true';

        // Collision-free unique selector
        const selector = generateUniqueSelector(node, doc);

        const actionId = `@${actionCounter++}`;
        (node as any).__actionId = actionId;

        actions.push({
          actionId,
          tag,
          role: role || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag),
          text: text || `[Untitled ${tag}]`,
          name,
          type,
          value,
          placeholder,
          href,
          selector,
          isClickable,
          isInput,
          disabled,
          checked: checked || undefined,
          expanded: expanded || undefined,
          selected: selected || undefined,
        });
      }

      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }

  walk(rootNode);

  // Intelligent Capping: If page has hundreds of actions (like massive catalogs),
  // cap Action Map to maxActions (default: 80) to preserve agent context window
  const maxActions = options.maxActions ?? 80;
  const totalFound = actions.length;
  const visibleActions = actions.slice(0, maxActions);

  // Build clean, token-condensed action map string for LLM
  const actionLines = visibleActions.map(act => {
    let details = '';
    if (act.type) details += ` type="${act.type}"`;
    if (act.placeholder) details += ` placeholder="${act.placeholder}"`;
    if (act.value) details += ` value="${act.value}"`;
    if (act.href) {
      const cleanHref = cleanUrlForLLM(act.href);
      if (cleanHref) details += ` href="${cleanHref}"`;
    }
    if (act.disabled) details += ` [DISABLED]`;
    if (act.checked) details += ` [CHECKED]`;
    if (act.expanded) details += ` [EXPANDED]`;
    if (act.selected) details += ` [SELECTED]`;

    // Only include selector if compactSelectors is explicitly false (normally agent only needs actionId @1, @2)
    if (options.compactSelectors === false) {
      return `[${act.actionId}] [${act.role}] "${act.text}"${details} (selector: ${act.selector})`;
    }
    return `[${act.actionId}] [${act.role}] "${act.text}"${details}`;
  });

  if (totalFound > maxActions) {
    actionLines.push(`... [${totalFound - maxActions} lower-priority interactive elements omitted for token savings. Use focus="selector" to zoom in.]`);
  }

  const actionMapText = actions.length > 0
    ? `=== INTERACTIVE ACTION MAP (${actions.length} elements${totalFound > maxActions ? `, showing top ${maxActions}` : ''}) ===\n` + actionLines.join('\n')
    : `=== NO INTERACTIVE ELEMENTS FOUND ===`;

  const markdown = convertToMarkdown(doc, {
    focusSelector: options.focusSelector,
    excludeSelectors: options.excludeSelectors,
    filterHidden: options.filterHidden,
  });

  const totalChars = (doc.title + actionMapText + markdown).length;
  const tokenEstimate = Math.ceil(totalChars / 4);

  return {
    url,
    title: doc.title || 'Untitled Page',
    tokenEstimate,
    interactiveCount: actions.length,
    actions,
    actionMapText,
    markdown
  };
}
