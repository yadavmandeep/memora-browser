import * as CSSselect from 'css-select';
import type { Options } from 'css-select';
import { MemoraNode, MemoraElement, setSelectorEngine } from './node.js';

export type Adapter<Node, ElementNode extends Node> = NonNullable<Options<Node, ElementNode>['adapter']>;

// Custom adapter connecting css-select to Memora's ultra-fast DOM
export const memoraAdapter: Adapter<MemoraNode, MemoraElement> = {
  isTag(node: MemoraNode): node is MemoraElement {
    return node instanceof MemoraElement && !node.tagName.startsWith('#');
  },

  getAttributeValue(elem: MemoraElement, name: string): string | undefined {
    return elem.getAttribute(name) ?? undefined;
  },

  getChildren(node: MemoraNode): MemoraNode[] {
    return node.childNodes;
  },

  getName(elem: MemoraElement): string {
    return elem.tagName.toLowerCase();
  },

  getParent(node: MemoraElement): MemoraNode | null {
    return node.parentNode;
  },

  getSiblings(node: MemoraNode): MemoraNode[] {
    return node.parentNode ? node.parentNode.childNodes : [node];
  },

  prevElementSibling(node: MemoraNode): MemoraElement | null {
    if (!node.parentNode) return null;
    const siblings = node.parentNode.childNodes;
    const idx = siblings.indexOf(node);
    for (let i = idx - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling instanceof MemoraElement && !sibling.tagName.startsWith('#')) {
        return sibling;
      }
    }
    return null;
  },

  getText(node: MemoraNode): string {
    return node.textContent;
  },

  hasAttrib(elem: MemoraElement, name: string): boolean {
    return elem.hasAttribute(name);
  },

  removeSubsets(nodes: MemoraNode[]): MemoraNode[] {
    const set = new Set(nodes);
    return nodes.filter(node => {
      let cur = node.parentNode;
      while (cur) {
        if (set.has(cur as MemoraNode)) return false;
        cur = cur.parentNode;
      }
      return true;
    });
  },

  equals(a: MemoraNode, b: MemoraNode): boolean {
    return a === b;
  },

  existsOne(test: (elem: MemoraElement) => boolean, elems: MemoraNode[]): boolean {
    return elems.some(elem => (elem instanceof MemoraElement && !elem.tagName.startsWith('#') && test(elem)) || 
      this.existsOne(test, elem.childNodes));
  },

  findAll(test: (elem: MemoraElement) => boolean, nodes: MemoraNode[]): MemoraElement[] {
    const result: MemoraElement[] = [];
    const walk = (items: MemoraNode[]) => {
      for (const item of items) {
        if (item instanceof MemoraElement && !item.tagName.startsWith('#')) {
          if (test(item)) {
            result.push(item);
          }
          walk(item.childNodes);
        }
      }
    };
    walk(nodes);
    return result;
  },

  findOne(test: (elem: MemoraElement) => boolean, nodes: MemoraNode[]): MemoraElement | null {
    for (const item of nodes) {
      if (item instanceof MemoraElement && !item.tagName.startsWith('#')) {
        if (test(item)) return item;
        const sub = this.findOne(test, item.childNodes);
        if (sub) return sub;
      }
    }
    return null;
  }
};

export function selectOne(selector: string, root: MemoraNode): MemoraElement | null {
  try {
    return CSSselect.selectOne(selector, root.childNodes, { adapter: memoraAdapter }) ?? null;
  } catch (err) {
    return null;
  }
}

export function selectAll(selector: string, root: MemoraNode): MemoraElement[] {
  try {
    return CSSselect.selectAll(selector, root.childNodes, { adapter: memoraAdapter });
  } catch (err) {
    return [];
  }
}

setSelectorEngine({ selectOne, selectAll });
