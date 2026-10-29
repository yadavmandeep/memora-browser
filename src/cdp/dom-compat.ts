import { MemoraNode, MemoraElement, MemoraDocument, MemoraTextNode } from '../dom/node.js';
import type { MemoraPage } from '../engine/page.js';

// Browser surface that CDP automation clients (Playwright's injected script in particular)
// expect from a page, layered on top of Memora's DOM without touching the engine:
//  - additive DOM members (focus tracking, form control properties, computed style, ...)
//  - per-sandbox globals (Event classes, Node/Element for instanceof, rAF, viewport, ...)
//  - a synthetic layout so protocol hit-testing (content quads -> elementsFromPoint -> input
//    events) resolves back to the element the client targeted.

export const VIEWPORT = { width: 1280, height: 720 };

export interface Rect { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------
// Synthetic layout: every element a client asks geometry for gets its own cell in a grid that
// fits the viewport, so a point maps back to exactly one element.
// ---------------------------------------------------------------------------------------------
const CELL_W = 80;
const CELL_H = 24;
const COLS = Math.floor(VIEWPORT.width / CELL_W);
const ROWS = Math.floor(VIEWPORT.height / CELL_H);
const SLOTS = COLS * ROWS;

export class LayoutModel {
  private rects: Map<MemoraElement, number> = new Map();
  private slots: Array<MemoraElement | undefined> = new Array(SLOTS);
  private next = 0;

  public rectFor(el: MemoraElement): Rect {
    let slot = this.rects.get(el);
    if (slot === undefined) {
      slot = this.next++ % SLOTS;
      const evicted = this.slots[slot];
      if (evicted) this.rects.delete(evicted);
      this.slots[slot] = el;
      this.rects.set(el, slot);
    }
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    return { x: col * CELL_W + 2, y: row * CELL_H + 2, width: CELL_W - 4, height: CELL_H - 4 };
  }

  public elementAt(x: number, y: number): MemoraElement | null {
    if (x < 0 || y < 0 || x >= COLS * CELL_W || y >= ROWS * CELL_H) return null;
    const slot = Math.floor(y / CELL_H) * COLS + Math.floor(x / CELL_W);
    const el = this.slots[slot];
    return el && el.isConnected ? el : null;
  }
}

const layouts: WeakMap<MemoraDocument, LayoutModel> = new WeakMap();

export function layoutFor(doc: MemoraDocument): LayoutModel {
  let l = layouts.get(doc);
  if (!l) {
    l = new LayoutModel();
    layouts.set(doc, l);
  }
  return l;
}

export function quadFor(r: Rect): number[] {
  return [r.x, r.y, r.x + r.width, r.y, r.x + r.width, r.y + r.height, r.x, r.y + r.height];
}

// Deepest element at a point followed by its ancestors, like document.elementsFromPoint()
export function elementsFromPoint(doc: MemoraDocument, x: number, y: number): MemoraElement[] {
  const hit = layoutFor(doc).elementAt(x, y) || doc.body || doc.documentElement;
  const out: MemoraElement[] = [];
  for (let cur: MemoraElement | null = hit; cur && cur.nodeType === 1; cur = cur.parentNode) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Computed style (heuristic: inline style + hidden attribute + UA defaults)
// ---------------------------------------------------------------------------------------------
const HIDDEN_TAGS = new Set(['head', 'script', 'style', 'title', 'meta', 'link', 'template', 'noscript', 'base', 'datalist', 'param']);
const INLINE_TAGS = new Set(['a', 'span', 'b', 'i', 'em', 'strong', 'small', 'code', 'label', 'abbr', 'cite', 'q', 'sub', 'sup', 'u', 's', 'mark', 'time', 'kbd', 'var', 'img', 'br']);
const INLINE_BLOCK_TAGS = new Set(['input', 'button', 'select', 'textarea']);

export function parseInlineStyle(css: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!css) return out;
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i <= 0) continue;
    const name = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).replace(/!important/i, '').trim();
    if (name) out[name] = value;
  }
  return out;
}

function serializeInlineStyle(decls: Record<string, string>): string {
  return Object.entries(decls).map(([k, v]) => `${k}: ${v};`).join(' ');
}

const camelToKebab = (s: string) => s.startsWith('--') ? s : s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());

function defaultDisplay(el: MemoraElement): string {
  const tag = el.tagName;
  if (HIDDEN_TAGS.has(tag)) return 'none';
  if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return 'none';
  if (INLINE_TAGS.has(tag)) return 'inline';
  if (INLINE_BLOCK_TAGS.has(tag)) return 'inline-block';
  if (tag === 'li') return 'list-item';
  if (tag === 'table') return 'table';
  if (tag === 'tr') return 'table-row';
  if (tag === 'td' || tag === 'th') return 'table-cell';
  return 'block';
}

export function computedStyle(el: MemoraElement): Record<string, any> {
  const inline = parseInlineStyle(el.getAttribute('style'));
  let display = inline['display'] || (el.hasAttribute('hidden') ? 'none' : defaultDisplay(el));
  let visibility = inline['visibility'] || '';
  if (!visibility) {
    visibility = 'visible';
    for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
      const v = parseInlineStyle(p.getAttribute('style'))['visibility'];
      if (v) { visibility = v; break; }
    }
  }
  if (display === 'contents' && !el.parentNode) display = 'block';
  const style: Record<string, any> = {
    display,
    visibility,
    opacity: inline['opacity'] || '1',
    cursor: inline['cursor'] || (el.tagName === 'a' && el.hasAttribute('href') ? 'pointer' : 'auto'),
    pointerEvents: inline['pointer-events'] || 'auto',
    position: inline['position'] || 'static',
    transform: inline['transform'] || 'none',
    overflow: inline['overflow'] || 'visible',
    overflowX: inline['overflow-x'] || inline['overflow'] || 'visible',
    overflowY: inline['overflow-y'] || inline['overflow'] || 'visible',
    borderLeftWidth: '0px',
    borderTopWidth: '0px',
    direction: 'ltr',
    fontSize: '16px',
    content: 'normal',
    zIndex: 'auto',
  };
  for (const [k, v] of Object.entries(inline)) {
    const camel = k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (!(camel in style)) style[camel] = v;
  }
  style.getPropertyValue = (name: string) => {
    const camel = String(name).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return style[camel] ?? inline[String(name)] ?? '';
  };
  return style;
}

function isRendered(el: MemoraElement): boolean {
  for (let cur: MemoraElement | null = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
    if (computedStyle(cur).display === 'none') return false;
  }
  return true;
}

export function isElementRendered(el: MemoraElement): boolean {
  return el.isConnected && isRendered(el);
}

// ---------------------------------------------------------------------------------------------
// Additive prototype members (only defined when Memora's DOM does not provide them already)
// ---------------------------------------------------------------------------------------------
let prototypesPatched = false;

function define(proto: any, name: string, desc: PropertyDescriptor): void {
  if (Object.prototype.hasOwnProperty.call(proto, name) || name in proto) return;
  Object.defineProperty(proto, name, { configurable: true, enumerable: false, ...desc });
}

const FOCUSABLE = new Set(['input', 'textarea', 'select', 'button', 'a', 'iframe', 'summary']);

export function isFocusable(el: MemoraElement): boolean {
  if (el.hasAttribute('tabindex') || el.hasAttribute('contenteditable')) return true;
  if (el.tagName === 'a') return el.hasAttribute('href');
  return FOCUSABLE.has(el.tagName) && !el.hasAttribute('disabled');
}

function textValue(el: MemoraElement): string {
  if (el.tagName === 'textarea' && !el.hasAttribute('value')) return el.textContent;
  return el.value;
}

export function setTextValue(el: MemoraElement, value: string): void {
  if (el.tagName === 'textarea') {
    el.textContent = value;
    el.setAttribute('value', value);
    return;
  }
  el.value = value;
}

export function installPrototypeCompat(): void {
  if (prototypesPatched) return;
  prototypesPatched = true;
  const nodeProto = MemoraNode.prototype as any;
  const elProto = MemoraElement.prototype as any;
  const docProto = MemoraDocument.prototype as any;
  const textProto = MemoraTextNode.prototype as any;

  define(nodeProto, 'compareDocumentPosition', {
    value(this: MemoraNode, other: MemoraNode): number {
      if (this === other) return 0;
      const chain = (n: MemoraNode) => { const c: MemoraNode[] = []; for (let x: MemoraNode | null = n; x; x = x.parentNode) c.unshift(x); return c; };
      const a = chain(this);
      const b = chain(other);
      if (a[0] !== b[0]) return 1 | 32 | 2; // DISCONNECTED | IMPLEMENTATION_SPECIFIC | PRECEDING
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      if (i === a.length) return 16 | 4; // other is contained by this, follows
      if (i === b.length) return 8 | 2; // other contains this, precedes
      const parent = a[i - 1];
      return parent.childNodes.indexOf(b[i]) > parent.childNodes.indexOf(a[i]) ? 4 : 2;
    },
  });
  define(nodeProto, 'isSameNode', { value(this: MemoraNode, o: MemoraNode) { return this === o; } });
  define(nodeProto, 'cloneNode', {
    value(this: MemoraNode, deep?: boolean): MemoraNode {
      if (this instanceof MemoraTextNode) return new MemoraTextNode(this.data);
      if (this instanceof MemoraElement) {
        const copy = new MemoraElement(this.tagName);
        for (const [k, v] of this.attributes) copy.attributes.set(k, v);
        if (deep) for (const c of this.childNodes) copy.appendChild((c as any).cloneNode(true));
        return copy;
      }
      return this;
    },
  });
  define(textProto, 'nodeValue', { get(this: MemoraTextNode) { return this.data; }, set(this: MemoraTextNode, v: string) { this.data = String(v); } });

  // ---- focus tracking
  const originalFocus = elProto.focus;
  if (!elProto.__memoraFocusTracked) {
    Object.defineProperty(elProto, '__memoraFocusTracked', { value: true });
    elProto.focus = function (this: MemoraElement, ...args: any[]) {
      const doc = this.ownerDocument as any;
      if (doc) {
        if (doc.__memoraActive === this) return;
        const prev: MemoraElement | undefined = doc.__memoraActive;
        doc.__memoraActive = this;
        if (prev && prev !== this && prev.isConnected) prev.dispatchEvent({ type: 'blur', target: prev, bubbles: false });
      }
      return originalFocus.apply(this, args);
    };
    const originalDispatch = elProto.dispatchEvent;
    elProto.dispatchEvent = function (this: MemoraElement, event: any) {
      if (event && typeof event === 'object' && event.target == null) {
        try { event.target = this; } catch { /* read-only target */ }
      }
      return originalDispatch.call(this, event);
    };
  }
  define(elProto, 'blur', {
    value(this: MemoraElement) {
      const doc = this.ownerDocument as any;
      if (doc && doc.__memoraActive === this) {
        doc.__memoraActive = undefined;
        this.dispatchEvent({ type: 'blur', target: this, bubbles: false });
      }
    },
  });

  // ---- form control properties
  define(elProto, 'type', {
    get(this: MemoraElement) {
      const t = (this.getAttribute('type') || '').toLowerCase();
      if (this.tagName === 'input') return t || 'text';
      if (this.tagName === 'button') return t === 'reset' || t === 'button' ? t : 'submit';
      if (this.tagName === 'select') return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
      if (this.tagName === 'textarea') return 'textarea';
      return t || undefined;
    },
    set(this: MemoraElement, v: string) { this.setAttribute('type', v); },
  });
  const boolAttr = (name: string, attr = name) => define(elProto, name, {
    get(this: MemoraElement) { return this.hasAttribute(attr); },
    set(this: MemoraElement, v: any) { if (v) this.setAttribute(attr, ''); else this.removeAttribute(attr); },
  });
  boolAttr('checked');
  boolAttr('disabled');
  boolAttr('selected');
  boolAttr('readOnly', 'readonly');
  boolAttr('required');
  boolAttr('multiple');
  boolAttr('hidden');
  boolAttr('indeterminate', 'data-memora-indeterminate');
  const strAttr = (name: string, attr = name) => define(elProto, name, {
    get(this: MemoraElement) { return this.getAttribute(attr) ?? ''; },
    set(this: MemoraElement, v: any) { this.setAttribute(attr, String(v)); },
  });
  strAttr('name');
  strAttr('placeholder');
  strAttr('title');
  strAttr('lang');
  strAttr('htmlFor', 'for');
  define(elProto, 'tabIndex', {
    get(this: MemoraElement) { const t = this.getAttribute('tabindex'); return t !== null ? Number(t) : (isFocusable(this) ? 0 : -1); },
    set(this: MemoraElement, v: any) { this.setAttribute('tabindex', String(v)); },
  });
  define(elProto, 'isContentEditable', {
    get(this: MemoraElement) {
      for (let cur: MemoraElement | null = this; cur && cur.nodeType === 1; cur = cur.parentNode) {
        const v = cur.getAttribute('contenteditable');
        if (v !== null) return v.toLowerCase() !== 'false';
      }
      return false;
    },
  });
  define(elProto, 'form', {
    get(this: MemoraElement) {
      for (let cur = this.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) if (cur.tagName === 'form') return cur;
      return null;
    },
  });
  define(elProto, 'labels', {
    get(this: MemoraElement) {
      const doc = this.ownerDocument;
      const out: MemoraElement[] = [];
      const id = this.getAttribute('id');
      if (doc && id) for (const l of doc.querySelectorAll('label')) if (l.getAttribute('for') === id) out.push(l);
      for (let cur = this.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) if (cur.tagName === 'label' && !out.includes(cur)) out.push(cur);
      return out;
    },
  });
  define(elProto, 'control', {
    get(this: MemoraElement) {
      if (this.tagName !== 'label') return undefined;
      const f = this.getAttribute('for');
      const doc = this.ownerDocument;
      if (f && doc) return doc.querySelector(`[id="${f.replace(/"/g, '\\"')}"]`);
      return this.querySelector('input, select, textarea, button');
    },
  });
  define(elProto, 'options', {
    get(this: MemoraElement) { return this.tagName === 'select' || this.tagName === 'datalist' ? this.querySelectorAll('option') : undefined; },
  });
  define(elProto, 'selectedOptions', {
    get(this: MemoraElement) {
      if (this.tagName !== 'select') return undefined;
      const opts = this.querySelectorAll('option');
      const sel = opts.filter(o => o.hasAttribute('selected'));
      return sel.length || this.hasAttribute('multiple') ? sel : opts.slice(0, 1);
    },
  });
  define(elProto, 'selectedIndex', {
    get(this: MemoraElement) {
      if (this.tagName !== 'select') return undefined;
      const opts = this.querySelectorAll('option');
      const i = opts.findIndex(o => o.hasAttribute('selected'));
      return i >= 0 ? i : (opts.length && !this.hasAttribute('multiple') ? 0 : -1);
    },
  });
  define(elProto, 'href', {
    get(this: MemoraElement) {
      const h = this.getAttribute('href');
      if (h === null) return '';
      try { return new URL(h, (this.ownerDocument as any)?.__memoraUrl || undefined).toString(); } catch { return h; }
    },
    set(this: MemoraElement, v: string) { this.setAttribute('href', v); },
  });
  define(elProto, 'select', {
    value(this: MemoraElement) { (this as any).__selStart = 0; (this as any).__selEnd = textValue(this).length; },
  });
  define(elProto, 'setSelectionRange', {
    value(this: MemoraElement, start: number, end: number) {
      const len = textValue(this).length;
      (this as any).__selStart = Math.max(0, Math.min(start, len));
      (this as any).__selEnd = Math.max((this as any).__selStart, Math.min(end, len));
    },
  });
  define(elProto, 'selectionStart', {
    get(this: MemoraElement) { return (this as any).__selStart ?? textValue(this).length; },
    set(this: MemoraElement, v: number) { (this as any).__selStart = v; },
  });
  define(elProto, 'selectionEnd', {
    get(this: MemoraElement) { return (this as any).__selEnd ?? textValue(this).length; },
    set(this: MemoraElement, v: number) { (this as any).__selEnd = v; },
  });

  // ---- style / geometry
  define(elProto, 'style', {
    get(this: MemoraElement) {
      const el = this;
      const read = () => parseInlineStyle(el.getAttribute('style'));
      const write = (d: Record<string, string>) => {
        const s = serializeInlineStyle(d);
        if (s) el.setAttribute('style', s); else el.removeAttribute('style');
      };
      const api: Record<string, any> = {
        getPropertyValue: (n: string) => read()[String(n).toLowerCase()] ?? '',
        setProperty: (n: string, v: string) => { const d = read(); if (v === null || v === '') delete d[n]; else d[n] = String(v); write(d); },
        removeProperty: (n: string) => { const d = read(); const old = d[n] ?? ''; delete d[n]; write(d); return old; },
      };
      return new Proxy(api, {
        get(target, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop in target) return target[prop];
          if (prop === 'cssText') return el.getAttribute('style') || '';
          if (prop === 'length') return Object.keys(read()).length;
          return read()[camelToKebab(prop)] ?? '';
        },
        set(_target, prop, value) {
          if (typeof prop !== 'string') return true;
          if (prop === 'cssText') { el.setAttribute('style', String(value)); return true; }
          const d = read();
          const k = camelToKebab(prop);
          if (value === null || value === undefined || value === '') delete d[k]; else d[k] = String(value);
          write(d);
          return true;
        },
      });
    },
  });
  define(elProto, 'checkVisibility', { value(this: MemoraElement) { return isElementRendered(this); } });
  define(elProto, 'getClientRects', {
    value(this: MemoraElement) { return isElementRendered(this) ? [this.getBoundingClientRect()] : []; },
  });
  for (const m of ['scrollIntoView', 'scrollIntoViewIfNeeded', 'scrollTo', 'scrollBy']) define(elProto, m, { value() {} });
  for (const p of ['scrollTop', 'scrollLeft']) define(elProto, p, { get() { return 0; }, set() {} });
  define(elProto, 'clientWidth', { get(this: MemoraElement) { return isElementRendered(this) ? this.getBoundingClientRect().width : 0; } });
  define(elProto, 'clientHeight', { get(this: MemoraElement) { return isElementRendered(this) ? this.getBoundingClientRect().height : 0; } });
  define(elProto, 'offsetWidth', { get(this: MemoraElement) { return isElementRendered(this) ? this.getBoundingClientRect().width : 0; } });
  define(elProto, 'offsetHeight', { get(this: MemoraElement) { return isElementRendered(this) ? this.getBoundingClientRect().height : 0; } });
  define(elProto, 'innerText', {
    get(this: MemoraElement) { return isElementRendered(this) ? this.textContent : ''; },
    set(this: MemoraElement, v: string) { this.textContent = v; },
  });
  define(elProto, 'dataset', {
    get(this: MemoraElement) {
      const el = this;
      const key = (p: string) => 'data-' + camelToKebab(p);
      return new Proxy({}, {
        get: (_t, p) => typeof p === 'string' ? el.getAttribute(key(p)) ?? undefined : undefined,
        set: (_t, p, v) => { if (typeof p === 'string') el.setAttribute(key(p), String(v)); return true; },
        has: (_t, p) => typeof p === 'string' && el.hasAttribute(key(p)),
      });
    },
  });
  define(elProto, 'append', { value(this: MemoraElement, ...nodes: any[]) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new MemoraTextNode(n) : n); } });
  define(elProto, 'remove', { value(this: MemoraElement) { this.parentNode?.removeChild(this); } });
  define(elProto, 'insertAdjacentText', { value() {} });
  define(elProto, 'getAttributeNS', { value(this: MemoraElement, _ns: string, n: string) { return this.getAttribute(n); } });
  define(elProto, 'toggleAttribute', {
    value(this: MemoraElement, n: string, force?: boolean) {
      const on = force === undefined ? !this.hasAttribute(n) : force;
      if (on) this.setAttribute(n, ''); else this.removeAttribute(n);
      return on;
    },
  });

  // ---- document
  define(docProto, 'activeElement', {
    get(this: MemoraDocument) {
      const a = (this as any).__memoraActive as MemoraElement | undefined;
      return a && a.isConnected && a.ownerDocument === this ? a : this.body;
    },
  });
  define(docProto, 'hasFocus', { value() { return true; } });
  define(docProto, 'scrollingElement', { get(this: MemoraDocument) { return this.documentElement; } });
  define(docProto, 'doctype', { get() { return null; } });
  define(docProto, 'visibilityState', { get() { return 'visible'; } });
  define(docProto, 'elementsFromPoint', { value(this: MemoraDocument, x: number, y: number) { return elementsFromPoint(this, x, y); } });
  define(docProto, 'elementFromPoint', { value(this: MemoraDocument, x: number, y: number) { return elementsFromPoint(this, x, y)[0] ?? null; } });
  define(docProto, 'createDocumentFragment', { value() { return new MemoraElement('#document-fragment'); } });
  define(docProto, 'createComment', { value(this: MemoraDocument) { return this.createTextNode(''); } });
  define(docProto, 'createElementNS', { value(this: MemoraDocument, _ns: string, tag: string) { return this.createElement(tag); } });
  define(docProto, 'createRange', {
    value() {
      let node: MemoraNode | null = null;
      return {
        selectNode(n: MemoraNode) { node = n; },
        selectNodeContents(n: MemoraNode) { node = n; },
        setStart() {}, setEnd() {}, collapse() {}, detach() {},
        getBoundingClientRect() {
          const text = node ? node.textContent.trim() : '';
          const parent = node && (node.nodeType === 1 ? node as MemoraElement : node.parentElement);
          const visible = !!text && !!parent && isElementRendered(parent);
          return { x: 0, y: 0, top: 0, left: 0, right: visible ? 10 : 0, bottom: visible ? 10 : 0, width: visible ? 10 : 0, height: visible ? 10 : 0 };
        },
        getClientRects() { return []; },
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Per-sandbox globals
// ---------------------------------------------------------------------------------------------
const installedGlobals: WeakSet<object> = new WeakSet();

export function installSandboxCompat(page: MemoraPage): void {
  installPrototypeCompat();
  const g: any = page.sandbox.evaluateRaw('globalThis');
  const doc: any = page.document;
  // Document-level properties that point back at this page's realm
  if (doc.defaultView !== g) {
    for (const [k, v] of Object.entries({ defaultView: g, __memoraUrl: page.url, location: g.location })) {
      Object.defineProperty(doc, k, { value: v, configurable: true, writable: true, enumerable: false });
    }
  }
  if (installedGlobals.has(g)) return;
  installedGlobals.add(g);

  const isObj = (o: any) => o !== null && typeof o === 'object';
  const tagTest = (...tags: string[]) => (o: any) => isObj(o) && o.nodeType === 1 && tags.includes(o.tagName);
  const klass = (name: string, test: (o: any) => boolean, statics: Record<string, any> = {}) => {
    if (name in g) return;
    const C = ({ [name]: class {} } as any)[name];
    Object.defineProperty(C, Symbol.hasInstance, { value: test });
    Object.assign(C, statics);
    g[name] = C;
  };
  const nodeConsts = {
    ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11,
    DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
  };
  klass('Node', o => o instanceof MemoraNode, nodeConsts);
  klass('Element', o => isObj(o) && o.nodeType === 1);
  klass('HTMLElement', o => isObj(o) && o.nodeType === 1);
  klass('SVGElement', () => false);
  klass('Text', o => o instanceof MemoraTextNode);
  klass('CharacterData', o => isObj(o) && (o.nodeType === 3 || o.nodeType === 8));
  klass('Comment', o => isObj(o) && o.nodeType === 8);
  klass('Document', o => o instanceof MemoraDocument);
  klass('HTMLDocument', o => o instanceof MemoraDocument);
  klass('DocumentFragment', o => isObj(o) && o.nodeType === 11);
  klass('ShadowRoot', () => false);
  klass('Window', o => o === g);
  klass('HTMLInputElement', tagTest('input'));
  klass('HTMLTextAreaElement', tagTest('textarea'));
  klass('HTMLSelectElement', tagTest('select'));
  klass('HTMLOptionElement', tagTest('option'));
  klass('HTMLButtonElement', tagTest('button'));
  klass('HTMLFormElement', tagTest('form'));
  klass('HTMLAnchorElement', tagTest('a'));
  klass('HTMLLabelElement', tagTest('label'));
  klass('HTMLImageElement', tagTest('img'));
  klass('HTMLIFrameElement', tagTest('iframe'));
  klass('HTMLFrameElement', tagTest('frame'));
  klass('HTMLTemplateElement', tagTest('template'));
  klass('HTMLSlotElement', tagTest('slot'));
  klass('HTMLBodyElement', tagTest('body'));
  klass('HTMLHtmlElement', tagTest('html'));

  // Events are created inside the page realm so page code sees ordinary objects
  page.sandbox.evaluateRaw(`(() => {
    const g = globalThis;
    const def = (name, cls) => { if (!(name in g)) g[name] = cls; };
    class Event {
      constructor(type, init = {}) {
        this.type = String(type);
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.composed = !!init.composed;
        this.defaultPrevented = false;
        this.isTrusted = false;
        this.timeStamp = (g.performance ? g.performance.now() : Date.now());
        this.currentTarget = null;
        this.eventPhase = 0;
      }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
      stopPropagation() { this.__stopped = true; }
      stopImmediatePropagation() { this.__stopped = true; this.__immediateStopped = true; }
      composedPath() { const p = []; for (let n = this.target; n; n = n.parentNode) p.push(n); p.push(g); return p; }
      get returnValue() { return !this.defaultPrevented; }
    }
    Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
    class CustomEvent extends Event { constructor(t, i = {}) { super(t, i); this.detail = i.detail === undefined ? null : i.detail; } }
    class UIEvent extends Event { constructor(t, i = {}) { super(t, i); this.detail = i.detail || 0; this.view = i.view || null; } }
    class FocusEvent extends UIEvent { constructor(t, i = {}) { super(t, i); this.relatedTarget = i.relatedTarget || null; } }
    class MouseEvent extends UIEvent {
      constructor(t, i = {}) {
        super(t, i);
        for (const k of ['screenX', 'screenY', 'clientX', 'clientY', 'button', 'buttons', 'movementX', 'movementY']) this[k] = i[k] || 0;
        for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) this[k] = !!i[k];
        this.pageX = this.clientX; this.pageY = this.clientY; this.x = this.clientX; this.y = this.clientY;
        this.offsetX = 0; this.offsetY = 0;
        this.relatedTarget = i.relatedTarget || null;
      }
      getModifierState(k) { return !!({ Control: this.ctrlKey, Shift: this.shiftKey, Alt: this.altKey, Meta: this.metaKey })[k]; }
    }
    class PointerEvent extends MouseEvent {
      constructor(t, i = {}) { super(t, i); this.pointerId = i.pointerId || 1; this.pointerType = i.pointerType || 'mouse'; this.isPrimary = i.isPrimary !== false; this.width = i.width || 1; this.height = i.height || 1; this.pressure = i.pressure || 0; }
    }
    class WheelEvent extends MouseEvent { constructor(t, i = {}) { super(t, i); this.deltaX = i.deltaX || 0; this.deltaY = i.deltaY || 0; this.deltaZ = i.deltaZ || 0; this.deltaMode = i.deltaMode || 0; } }
    class DragEvent extends MouseEvent { constructor(t, i = {}) { super(t, i); this.dataTransfer = i.dataTransfer || null; } }
    class KeyboardEvent extends UIEvent {
      constructor(t, i = {}) {
        super(t, i);
        this.key = i.key || ''; this.code = i.code || ''; this.location = i.location || 0; this.repeat = !!i.repeat;
        this.keyCode = i.keyCode || 0; this.which = i.which || this.keyCode; this.charCode = i.charCode || 0; this.isComposing = !!i.isComposing;
        for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) this[k] = !!i[k];
      }
      getModifierState(k) { return !!({ Control: this.ctrlKey, Shift: this.shiftKey, Alt: this.altKey, Meta: this.metaKey })[k]; }
    }
    class InputEvent extends UIEvent { constructor(t, i = {}) { super(t, i); this.data = i.data === undefined ? null : i.data; this.inputType = i.inputType || ''; this.isComposing = !!i.isComposing; } }
    class CompositionEvent extends UIEvent { constructor(t, i = {}) { super(t, i); this.data = i.data || ''; } }
    class SubmitEvent extends Event { constructor(t, i = {}) { super(t, i); this.submitter = i.submitter || null; } }
    def('Event', Event); def('CustomEvent', CustomEvent); def('UIEvent', UIEvent); def('FocusEvent', FocusEvent);
    def('MouseEvent', MouseEvent); def('PointerEvent', PointerEvent); def('WheelEvent', WheelEvent); def('DragEvent', DragEvent);
    def('KeyboardEvent', KeyboardEvent); def('InputEvent', InputEvent); def('CompositionEvent', CompositionEvent); def('SubmitEvent', SubmitEvent);
    def('EventTarget', class EventTarget {
      constructor() { this.__l = new Map(); }
      addEventListener(t, f) { if (!this.__l.has(t)) this.__l.set(t, new Set()); this.__l.get(t).add(f); }
      removeEventListener(t, f) { this.__l.get(t)?.delete(f); }
      dispatchEvent(e) { for (const f of [...(this.__l.get(e.type) || [])]) { typeof f === 'function' ? f.call(this, e) : f.handleEvent(e); } return !e.defaultPrevented; }
    });
    def('IntersectionObserver', class IntersectionObserver {
      constructor(cb) { this.cb = cb; this.targets = new Set(); }
      observe(el) {
        this.targets.add(el);
        setTimeout(() => {
          if (!this.targets.has(el)) return;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
          const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
          this.cb([{ target: el, isIntersecting: visible, intersectionRatio: visible ? 1 : 0, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: Date.now() }], this);
        }, 0);
      }
      unobserve(el) { this.targets.delete(el); }
      disconnect() { this.targets.clear(); }
      takeRecords() { return []; }
    });
    def('ResizeObserver', class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
    def('CSS', { escape: (s) => String(s).replace(/([\\0-\\x1f\\x7f]|^-?\\d)|^-$|[^\\x80-\\uFFFF\\w-]/g, (m, c) => c ? '\\\\' + m.charCodeAt(0).toString(16) + ' ' : '\\\\' + m), supports: () => false });
  })()`);

  let rafId = 0;
  const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const globals: Record<string, any> = {
    getComputedStyle: (el: any) => (el instanceof MemoraElement ? computedStyle(el) : computedStyle(new MemoraElement('div'))),
    requestAnimationFrame: (cb: (t: number) => void) => {
      const id = ++rafId;
      rafTimers.set(id, setTimeout(() => { rafTimers.delete(id); cb(performance.now()); }, 16));
      return id;
    },
    cancelAnimationFrame: (id: number) => { clearTimeout(rafTimers.get(id)); rafTimers.delete(id); },
    requestIdleCallback: (cb: (d: any) => void) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1),
    cancelIdleCallback: (id: any) => clearTimeout(id),
    queueMicrotask: (fn: () => void) => queueMicrotask(fn),
    structuredClone: (v: any) => structuredClone(v),
    atob: (s: string) => Buffer.from(String(s), 'base64').toString('latin1'),
    btoa: (s: string) => Buffer.from(String(s), 'latin1').toString('base64'),
    TextEncoder,
    TextDecoder,
    performance,
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    outerWidth: VIEWPORT.width,
    outerHeight: VIEWPORT.height,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    scrollTo: () => {},
    scrollBy: () => {},
    scroll: () => {},
    focus: () => {},
    blur: () => {},
    matchMedia: (q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {}, collapse() {}, toString: () => '' }),
    visualViewport: { width: VIEWPORT.width, height: VIEWPORT.height, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0 },
    frames: g,
    frameElement: null,
    opener: null,
    closed: false,
    origin: (() => { try { return new URL(page.url).origin; } catch { return 'null'; } })(),
    isSecureContext: true,
  };
  for (const [k, v] of Object.entries(globals)) {
    if (!(k in g)) g[k] = v;
  }
}
