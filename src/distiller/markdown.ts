import { MemoraDocument, MemoraElement, MemoraNode, MemoraTextNode } from '../dom/node.js';

export function convertToMarkdown(doc: MemoraDocument): string {
  const body = doc.body || doc;
  const lines: string[] = [];

  function processNode(node: MemoraNode, listLevel = 0) {
    if (node instanceof MemoraTextNode) {
      const text = node.data.replace(/\s+/g, ' ');
      if (text) lines.push(text);
      return;
    }

    if (node instanceof MemoraElement) {
      const tag = node.tagName.toLowerCase();

      // Skip non-visible or script elements
      if (['script', 'style', 'noscript', 'svg', 'canvas', 'template'].includes(tag)) {
        return;
      }

      // Headings
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        const level = parseInt(tag.charAt(1), 10);
        const hashes = '#'.repeat(level);
        const headingText = node.textContent.trim().replace(/\s+/g, ' ');
        if (headingText) {
          lines.push(`\n${hashes} ${headingText}\n`);
        }
        return;
      }

      // Paragraphs
      if (tag === 'p') {
        const pText = node.textContent.trim().replace(/\s+/g, ' ');
        if (pText) {
          lines.push(`\n${pText}\n`);
        }
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
            const itemText = child.textContent.trim().replace(/\s+/g, ' ');
            if (itemText) {
              lines.push(`${indent}${prefix}${itemText}`);
            }
          }
        }
        lines.push('');
        return;
      }

      // Links
      if (tag === 'a') {
        const href = node.getAttribute('href');
        const text = node.textContent.trim().replace(/\s+/g, ' ');
        if (text && href) {
          lines.push(`[${text}](${href})`);
          return;
        }
      }

      // Blockquotes
      if (tag === 'blockquote') {
        const bqText = node.textContent.trim().replace(/\s+/g, ' ');
        if (bqText) {
          lines.push(`\n> ${bqText}\n`);
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

      // Tables
      if (tag === 'table') {
        lines.push('\n' + renderMarkdownTable(node) + '\n');
        return;
      }

      // Generic recursion
      for (const child of node.childNodes) {
        processNode(child, listLevel);
      }
    }
  }

  processNode(body);

  // Normalize blank lines
  return lines
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

function renderMarkdownTable(table: MemoraElement): string {
  const rows: string[][] = [];
  const trElements = table.querySelectorAll('tr');

  for (const tr of trElements) {
    const cells: string[] = [];
    for (const cell of tr.childNodes) {
      if (cell instanceof MemoraElement && (cell.tagName === 'td' || cell.tagName === 'th')) {
        cells.push(cell.textContent.trim().replace(/\s+/g, ' ') || '-');
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
