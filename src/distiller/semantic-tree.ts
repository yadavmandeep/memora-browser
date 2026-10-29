import { MemoraDocument, MemoraElement, MemoraNode, MemoraTextNode } from '../dom/node.js';
import { InteractiveElement, SemanticPageSnapshot } from '../types/index.js';
import { convertToMarkdown } from './markdown.js';

export function extractSemanticSnapshot(doc: MemoraDocument, url: string): SemanticPageSnapshot {
  const actions: InteractiveElement[] = [];
  let actionCounter = 1;

  function walk(node: MemoraNode) {
    if (node instanceof MemoraElement) {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') || '';
      const isAriaInteractive = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'].includes(role);
      const isNativeInteractive = ['button', 'a', 'input', 'select', 'textarea'].includes(tag);
      const hasTabIndex = node.getAttribute('tabindex') === '0';
      const hasOnClick = node.hasAttribute('onclick');

      if (isNativeInteractive || isAriaInteractive || hasTabIndex || hasOnClick) {
        // Collect text / accessible name
        let text = (node.getAttribute('aria-label') ||
                    node.getAttribute('placeholder') ||
                    node.getAttribute('title') ||
                    node.getAttribute('value') ||
                    node.textContent).trim();
        
        // Clean up excessive whitespace
        text = text.replace(/\s+/g, ' ').slice(0, 80);

        const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
        const isClickable = !isInput || node.getAttribute('type') === 'submit' || node.getAttribute('type') === 'button';
        const type = node.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : undefined);
        const name = node.getAttribute('name') || undefined;
        const value = node.getAttribute('value') || undefined;
        const placeholder = node.getAttribute('placeholder') || undefined;
        const href = node.getAttribute('href') || undefined;
        const disabled = node.hasAttribute('disabled');

        // Formulate shortest reliable selector
        let selector = '';
        if (node.id) {
          selector = `#${node.id}`;
        } else if (name) {
          selector = `${tag}[name="${name}"]`;
        } else if (node.className) {
          const firstCls = node.className.split(/\s+/)[0];
          selector = firstCls ? `${tag}.${firstCls}` : tag;
        } else {
          selector = tag;
        }

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
          disabled
        });
      }

      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }

  walk(doc);

  // Build clean action map string for LLM
  const actionLines = actions.map(act => {
    let details = '';
    if (act.type) details += ` type="${act.type}"`;
    if (act.placeholder) details += ` placeholder="${act.placeholder}"`;
    if (act.value) details += ` value="${act.value}"`;
    if (act.href) details += ` href="${act.href}"`;
    if (act.disabled) details += ` [DISABLED]`;

    return `[${act.actionId}] [${act.role}] "${act.text}"${details} (selector: ${act.selector})`;
  });

  const actionMapText = actions.length > 0
    ? `=== INTERACTIVE ACTION MAP (${actions.length} elements) ===\n` + actionLines.join('\n')
    : `=== NO INTERACTIVE ELEMENTS FOUND ===`;

  const markdown = convertToMarkdown(doc);

  // Rough token estimation: 1 token ~= 4 characters of text
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
