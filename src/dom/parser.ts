import * as parse5 from 'parse5';
import { MemoraNode, MemoraElement, MemoraTextNode, MemoraCommentNode, MemoraDocument, setFragmentParser } from './node.js';
import './selector.js';

export function parseHTML(html: string): MemoraDocument {
  const doc = new MemoraDocument();
  const parsed = parse5.parse(html);
  convertChildren(parsed.childNodes, doc);
  return doc;
}

export function parseFragmentInto(html: string, container: MemoraElement): void {
  const parsed = parse5.parseFragment(html);
  convertChildren(parsed.childNodes, container);
}

function convertChildren(sourceNodes: any[], targetParent: MemoraNode): void {
  if (!sourceNodes) return;

  for (const src of sourceNodes) {
    if (src.nodeName === '#text') {
      const textNode = new MemoraTextNode(src.value || '');
      targetParent.appendChild(textNode);
    } else if (src.nodeName === '#comment') {
      const commentNode = new MemoraCommentNode(src.data || '');
      targetParent.appendChild(commentNode);
    } else if (src.nodeName === '#documentType') {
      // ignore doctype in inner tree
    } else {
      // Element
      const elem = new MemoraElement(src.tagName || src.nodeName);
      if (src.attrs && Array.isArray(src.attrs)) {
        for (const attr of src.attrs) {
          elem.setAttribute(attr.name, attr.value);
        }
      }
      targetParent.appendChild(elem);

      if (src.childNodes && src.childNodes.length > 0) {
        convertChildren(src.childNodes, elem);
      }
    }
  }
}

setFragmentParser(parseFragmentInto);

