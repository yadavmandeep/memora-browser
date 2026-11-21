import { MemoraDocument, MemoraElement, MemoraNode, MemoraTextNode } from '../dom/node.js';
import { cleanUrlForLLM } from './semantic-tree.js';

export interface MarkdownOptions {
  focusSelector?: string;
  excludeSelectors?: string[];
  filterHidden?: boolean;
  readerMode?: boolean;
  includeLinks?: boolean;
  baseUrl?: string;
}

const NON_RENDERABLE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'template', 'head', 'meta', 'link'
]);

function isElementHidden(elem: MemoraElement): boolean {
  if (elem.hasAttribute('hidden')) return true;
  if (elem.getAttribute('aria-hidden') === 'true') return true;
  const style = elem.getAttribute('style') || '';
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return true;
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

function renderInlineChildren(element: MemoraElement, options?: MarkdownOptions): string {
  const parts: string[] = [];
  for (const child of element.childNodes) {
    parts.push(renderInline(child, options));
  }
  return parts.join('');
}

export function renderInline(node: MemoraNode, options?: MarkdownOptions): string {
  if (node instanceof MemoraTextNode) {
    return node.data.replace(/\s+/g, ' ');
  }

  if (node instanceof MemoraElement) {
    const tag = node.tagName.toLowerCase();
    if (NON_RENDERABLE_TAGS.has(tag)) return '';
    if (options?.filterHidden !== false && isElementHidden(node)) return '';
    if (isElementExcluded(node, options?.excludeSelectors)) return '';

    switch (tag) {
      case 'a': {
        const href = node.getAttribute('href');
        const text = renderInlineChildren(node, options).trim();
        if (!text) return '';
        const cleanHref = href ? cleanUrlForLLM(href) : undefined;
        return cleanHref ? `[${text}](${cleanHref})` : text;
      }
      case 'strong':
      case 'b': {
        const text = renderInlineChildren(node, options).trim();
        return text ? `**${text}**` : '';
      }
      case 'em':
      case 'i': {
        const text = renderInlineChildren(node, options).trim();
        return text ? `*${text}*` : '';
      }
      case 'code': {
        const codeText = node.textContent.trim();
        return codeText ? `\`${codeText}\`` : '';
      }
      case 'del':
      case 's': {
        const text = renderInlineChildren(node, options).trim();
        return text ? `~~${text}~~` : '';
      }
      case 'img': {
        const alt = node.getAttribute('alt') || 'image';
        const src = node.getAttribute('src');
        return src ? `![${alt}](${src})` : '';
      }
      case 'br':
        return '\n';
      default:
        return renderInlineChildren(node, options);
    }
  }

  return '';
}

const READER_EXCLUDES = [
  'nav', 'header', 'footer',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.nav', '.navbar', '.header', '.footer', '.menu', '.sidebar',
  '.cookie-banner', '.cookie-notice', '#cookie', '#consent',
  '.advertisement', '.ad-container', '.promo-bar'
];

export function convertToMarkdown(doc: MemoraDocument, options: MarkdownOptions = {}): string {
  let rootNode: MemoraNode = doc.body || doc;

  const effectiveExcludes = [
    ...(options.excludeSelectors || []),
    ...(options.readerMode ? READER_EXCLUDES : [])
  ];
  options = { ...options, excludeSelectors: effectiveExcludes };

  if (options.focusSelector) {
    try {
      const focused = doc.querySelector(options.focusSelector);
      if (focused) {
        rootNode = focused;
      }
    } catch {
      // Fall back to default root if focusSelector is invalid
    }
  } else if (options.readerMode) {
    try {
      const main = doc.querySelector('main, article, [role="main"], #content, #main, .content, .main');
      if (main) {
        rootNode = main;
      }
    } catch {}
  }

  const lines: string[] = [];

  function processBlockNode(node: MemoraNode, listLevel = 0) {
    if (node instanceof MemoraTextNode) {
      const text = node.data.replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      return;
    }

    if (node instanceof MemoraElement) {
      const tag = node.tagName.toLowerCase();

      if (NON_RENDERABLE_TAGS.has(tag)) return;
      if (options.filterHidden !== false && isElementHidden(node)) return;
      if (isElementExcluded(node, options.excludeSelectors)) return;

      // Headings
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag.charAt(1), 10);
        const hashes = '#'.repeat(level);
        const headingText = renderInlineChildren(node, options).trim();
        if (headingText) {
          lines.push(`\n${hashes} ${headingText}\n`);
        }
        return;
      }

      // Paragraphs (preserves inline links, bold, code, etc.)
      if (tag === 'p') {
        const pText = renderInlineChildren(node, options).trim();
        if (pText) {
          lines.push(`\n${pText}\n`);
        }
        return;
      }

      // Blockquotes
      if (tag === 'blockquote') {
        const bqText = renderInlineChildren(node, options).trim();
        if (bqText) {
          const quoted = bqText.split('\n').map(l => `> ${l}`).join('\n');
          lines.push(`\n${quoted}\n`);
        }
        return;
      }

      // Code blocks
      if (tag === 'pre') {
        const codeText = node.textContent.trim();
        if (codeText) {
          lines.push(`\n\`\`\`\n${codeText}\n\`\`\`\n`);
        }
        return;
      }

      // Horizontal rules
      if (tag === 'hr') {
        lines.push('\n---\n');
        return;
      }

      // Lists
      if (tag === 'ul' || tag === 'ol') {
        lines.push('');
        let itemIndex = 1;
        for (const child of node.childNodes) {
          if (child instanceof MemoraElement && child.tagName.toLowerCase() === 'li') {
            const indent = '  '.repeat(listLevel);
            const prefix = tag === 'ol' ? `${itemIndex++}. ` : '- ';
            const itemText = renderInlineChildren(child, options).trim();
            if (itemText) {
              lines.push(`${indent}${prefix}${itemText}`);
            }
          }
        }
        lines.push('');
        return;
      }

      // Tables
      if (tag === 'table') {
        lines.push('\n' + renderMarkdownTable(node, options) + '\n');
        return;
      }

      // Generic container elements (div, section, article, main, etc.)
      for (const child of node.childNodes) {
        processBlockNode(child, listLevel);
      }
    }
  }

  processBlockNode(rootNode);

  // Normalize blank lines and spacing
  let result = lines
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  if (options.includeLinks) {
    const anchors = doc.querySelectorAll('a[href]');
    const seen = new Set<string>();
    const internalList: string[] = [];
    const externalList: string[] = [];

    let baseOrigin = '';
    try {
      baseOrigin = new URL((options.baseUrl || "") || '').origin;
    } catch {}

    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) continue;

      let abs = href;
      try {
        if ((options.baseUrl || "")) abs = new URL(href, (options.baseUrl || "")).href;
      } catch {}

      const isInternal = baseOrigin && abs.startsWith(baseOrigin);
      if (isInternal) {
        internalList.push(`- [${text}](${abs})`);
      } else if (abs.startsWith('http')) {
        externalList.push(`- [${text}](${abs})`);
      }
    }

    if (internalList.length > 0) {
      result += '\n\n---\n\n### 🔗 Interlinked Pages (' + internalList.length + ')\n\n' + internalList.slice(0, 30).join('\n');
    }
    if (externalList.length > 0) {
      result += '\n\n### 🌐 External References (' + externalList.length + ')\n\n' + externalList.slice(0, 15).join('\n');
    }
  }

  return result;
}

function renderMarkdownTable(table: MemoraElement, options?: MarkdownOptions): string {
  const rows: string[][] = [];
  const trElements = table.querySelectorAll('tr');

  for (const tr of trElements) {
    const cells: string[] = [];
    for (const cell of tr.childNodes) {
      if (cell instanceof MemoraElement && (cell.tagName === 'td' || cell.tagName === 'th')) {
        const cellText = renderInlineChildren(cell, options).trim() || '-';
        cells.push(cellText);
      }
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map(r => r.length));
  const output: string[] = [];

  // Header row
  const header = rows[0].concat(Array(colCount - rows[0].length).fill('-'));
  output.push(`| ${header.join(' | ')} |`);

  // Separator row
  const sep = Array(colCount).fill('---');
  output.push(`| ${sep.join(' | ')} |`);

  // Data rows
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].concat(Array(colCount - rows[i].length).fill('-'));
    output.push(`| ${row.join(' | ')} |`);
  }

  return output.join('\n');
}
