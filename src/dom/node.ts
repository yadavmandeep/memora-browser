import { NodeType, BoundingRect } from '../types/index.js';

export type EventCallback = (event: any) => void;

let fragmentParser: ((html: string, container: MemoraElement) => void) | null = null;
let selectorEngine: {
  selectOne: (selector: string, root: MemoraNode) => MemoraElement | null;
  selectAll: (selector: string, root: MemoraNode) => MemoraElement[];
} | null = null;

export function setFragmentParser(fn: (html: string, container: MemoraElement) => void): void {
  fragmentParser = fn;
}

export function setSelectorEngine(engine: {
  selectOne: (selector: string, root: MemoraNode) => MemoraElement | null;
  selectAll: (selector: string, root: MemoraNode) => MemoraElement[];
}): void {
  selectorEngine = engine;
}

export abstract class MemoraNode {
  public abstract nodeType: NodeType;
  public parentNode: MemoraElement | null = null;
  public childNodes: MemoraNode[] = [];

  public abstract get textContent(): string;
  public abstract set textContent(val: string);

  public appendChild<T extends MemoraNode>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this as any;
    this.childNodes.push(child);
    return child;
  }

  public removeChild<T extends MemoraNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  public insertBefore<T extends MemoraNode>(newChild: T, refChild: MemoraNode | null): T {
    if (!refChild) {
      return this.appendChild(newChild);
    }
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) {
      return this.appendChild(newChild);
    }
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    newChild.parentNode = this as any;
    this.childNodes.splice(idx, 0, newChild);
    return newChild;
  }

  // ---- Standard DOM traversal surface (what real-world scripts and Playwright expect)
  static readonly ELEMENT_NODE = 1;
  static readonly TEXT_NODE = 3;
  static readonly COMMENT_NODE = 8;
  static readonly DOCUMENT_NODE = 9;
  static readonly DOCUMENT_FRAGMENT_NODE = 11;
  // Instance-visible constants live on the prototype (defined below the class), not as
  // per-node fields: a page has thousands of nodes
  declare readonly ELEMENT_NODE: 1;
  declare readonly TEXT_NODE: 3;
  declare readonly COMMENT_NODE: 8;
  declare readonly DOCUMENT_NODE: 9;
  declare readonly DOCUMENT_FRAGMENT_NODE: 11;

  public abstract get nodeName(): string;

  public get nodeValue(): string | null {
    return this.nodeType === 3 || this.nodeType === 8 ? this.textContent : null;
  }

  public get parentElement(): MemoraElement | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  public get ownerDocument(): MemoraDocument | null {
    let cur: MemoraNode = this;
    while (cur.parentNode) cur = cur.parentNode;
    if (this instanceof MemoraDocument) return null;
    return cur instanceof MemoraDocument ? cur : null;
  }

  public get isConnected(): boolean {
    let cur: MemoraNode = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur instanceof MemoraDocument;
  }

  public getRootNode(): MemoraNode {
    let cur: MemoraNode = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur;
  }

  public get firstChild(): MemoraNode | null {
    return this.childNodes[0] ?? null;
  }

  public get lastChild(): MemoraNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  public get nextSibling(): MemoraNode | null {
    const sibs = this.parentNode?.childNodes;
    return sibs ? sibs[sibs.indexOf(this) + 1] ?? null : null;
  }

  public get previousSibling(): MemoraNode | null {
    const sibs = this.parentNode?.childNodes;
    return sibs ? sibs[sibs.indexOf(this) - 1] ?? null : null;
  }

  public get nextElementSibling(): MemoraElement | null {
    let n = this.nextSibling;
    while (n && n.nodeType !== 1) n = n.nextSibling;
    return n as MemoraElement | null;
  }

  public get previousElementSibling(): MemoraElement | null {
    let n = this.previousSibling;
    while (n && n.nodeType !== 1) n = n.previousSibling;
    return n as MemoraElement | null;
  }

  public hasChildNodes(): boolean {
    return this.childNodes.length > 0;
  }

  public contains(other: MemoraNode | null): boolean {
    let cur: MemoraNode | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
}

for (const [name, value] of Object.entries({ ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 })) {
  Object.defineProperty(MemoraNode.prototype, name, { value, enumerable: true, configurable: true, writable: false });
}

export class MemoraTextNode extends MemoraNode {
  public nodeType: NodeType = 3;
  public data: string;

  public get nodeName(): string {
    return '#text';
  }

  public get wholeText(): string {
    return this.data;
  }

  constructor(data: string) {
    super();
    this.data = data;
  }

  public get textContent(): string {
    return this.data;
  }

  public set textContent(val: string) {
    this.data = val;
  }
}

export class MemoraCommentNode extends MemoraNode {
  public nodeType: NodeType = 8;
  public data: string;

  public get nodeName(): string {
    return '#comment';
  }

  constructor(data: string) {
    super();
    this.data = data;
  }

  public get textContent(): string {
    return this.data;
  }

  public set textContent(val: string) {
    this.data = val;
  }
}

export class MemoraElement extends MemoraNode {
  public nodeType: NodeType = 1;
  public tagName: string;
  public attributes: Map<string, string> = new Map();
  // Created on first addEventListener (most elements never get a listener)
  private eventListeners?: Map<string, Set<EventCallback>>;
  private _layoutBox?: BoundingRect;

  // Synthetic layout box estimate for agentic interaction (allocated on first use)
  public get layoutBox(): BoundingRect {
    return (this._layoutBox ??= { x: 0, y: 0, width: 100, height: 30 });
  }

  public set layoutBox(box: BoundingRect) {
    this._layoutBox = box;
  }

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toLowerCase();
  }

  public get nodeName(): string {
    return this.tagName.startsWith('#') ? this.tagName : this.tagName.toUpperCase();
  }

  public get localName(): string {
    return this.tagName;
  }

  public readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  public readonly shadowRoot = null;

  public get children(): MemoraElement[] {
    return this.childNodes.filter((c): c is MemoraElement => c.nodeType === 1);
  }

  public get childElementCount(): number {
    return this.children.length;
  }

  public get firstElementChild(): MemoraElement | null {
    return this.children[0] ?? null;
  }

  public get lastElementChild(): MemoraElement | null {
    const kids = this.children;
    return kids[kids.length - 1] ?? null;
  }

  public getAttributeNames(): string[] {
    return Array.from(this.attributes.keys());
  }

  public matches(selector: string): boolean {
    const root = this.getRootNode();
    return root instanceof MemoraElement && root.querySelectorAll(selector).includes(this);
  }

  public closest(selector: string): MemoraElement | null {
    let cur: MemoraElement | null = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  public get id(): string {
    return this.getAttribute('id') || '';
  }

  public set id(val: string) {
    this.setAttribute('id', val);
  }

  public get className(): string {
    return this.getAttribute('class') || '';
  }

  public set className(val: string) {
    this.setAttribute('class', val);
  }

  public get classList(): {
    contains: (cls: string) => boolean;
    add: (...classes: string[]) => void;
    remove: (...classes: string[]) => void;
    toggle: (cls: string) => boolean;
  } {
    return {
      contains: (cls: string) => this.className.split(/\s+/).filter(Boolean).includes(cls),
      add: (...classes: string[]) => {
        const cur = new Set(this.className.split(/\s+/).filter(Boolean));
        classes.forEach(c => cur.add(c));
        this.className = Array.from(cur).join(' ');
      },
      remove: (...classes: string[]) => {
        const cur = new Set(this.className.split(/\s+/).filter(Boolean));
        classes.forEach(c => cur.delete(c));
        this.className = Array.from(cur).join(' ');
      },
      toggle: (cls: string) => {
        const cur = new Set(this.className.split(/\s+/).filter(Boolean));
        const has = cur.has(cls);
        if (has) cur.delete(cls); else cur.add(cls);
        this.className = Array.from(cur).join(' ');
        return !has;
      }
    };
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  public get textContent(): string {
    let text = '';
    for (const child of this.childNodes) {
      text += child.textContent;
    }
    return text;
  }

  public set textContent(val: string) {
    this.childNodes = [];
    if (val) {
      this.appendChild(new MemoraTextNode(val));
    }
  }

  public get innerHTML(): string {
    return this.childNodes.map(child => {
      if (child instanceof MemoraElement) return child.outerHTML;
      if (child instanceof MemoraTextNode) return escapeHtml(child.data);
      return '';
    }).join('');
  }

  public set innerHTML(html: string) {
    this.childNodes = [];
    if (fragmentParser) {
      fragmentParser(html, this);
    }
  }

  public get outerHTML(): string {
    const attrs = Array.from(this.attributes.entries())
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join('');
    
    const selfClosing = ['img', 'br', 'hr', 'input', 'meta', 'link'].includes(this.tagName);
    if (selfClosing && this.childNodes.length === 0) {
      return `<${this.tagName}${attrs} />`;
    }
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }

  public get value(): string {
    return this.getAttribute('value') || '';
  }

  public set value(val: string) {
    this.setAttribute('value', val);
  }

  public getBoundingClientRect(): BoundingRect {
    return { ...this.layoutBox };
  }

  // EventTarget implementation
  public addEventListener(type: string, listener: EventCallback): void {
    const map = (this.eventListeners ??= new Map());
    if (!map.has(type)) {
      map.set(type, new Set());
    }
    map.get(type)!.add(listener);
  }

  public removeEventListener(type: string, listener: EventCallback): void {
    this.eventListeners?.get(type)?.delete(listener);
  }

  public dispatchEvent(event: any): boolean {
    if (typeof event.preventDefault !== 'function') {
      event.defaultPrevented = event.defaultPrevented || false;
      event.preventDefault = function () { if (this.cancelable !== false) this.defaultPrevented = true; };
      event.stopPropagation = function () { this.__stopped = true; };
    }
    event.currentTarget = this;

    let propHandler = (this as any)[`on${event.type}`];
    const inlineCode = typeof propHandler !== 'function' ? this.getAttribute(`on${event.type}`) : null;
    if (inlineCode) {
      const compile = this.ownerDocument?.inlineHandlerCompiler;
      if (compile) {
        try {
          propHandler = compile(inlineCode);
        } catch (err) {
          console.error(`[MemoraDOM] Invalid inline on${event.type} handler:`, err);
        }
      }
    }
    if (typeof propHandler === 'function') {
      try {
        if (propHandler.call(this, event) === false) event.preventDefault();
      } catch (err) {
        console.error(`[MemoraDOM] Error in on${event.type} handler:`, err);
      }
    }

    const listeners = this.eventListeners?.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener.call(this, event);
        } catch (err) {
          console.error(`[MemoraDOM] Error in ${event.type} listener:`, err);
        }
      }
    }
    // Bubble up to parent
    if (this.parentNode && event.bubbles !== false && !event.__stopped) {
      this.parentNode.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }

  // Returns false when a listener called preventDefault()
  public click(): boolean {
    return this.dispatchEvent({
      type: 'click',
      target: this,
      currentTarget: this,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
    });
  }

  public focus(): void {
    this.dispatchEvent({
      type: 'focus',
      target: this,
      currentTarget: this,
      bubbles: false,
    });
  }

  // Selector matching hooks (delegated to css-select adapter)
  public querySelector(selector: string): MemoraElement | null {
    if (!selectorEngine) return null;
    return selectorEngine.selectOne(selector, this);
  }

  public querySelectorAll(selector: string): MemoraElement[] {
    if (!selectorEngine) return [];
    return selectorEngine.selectAll(selector, this);
  }
}

export class MemoraDocument extends MemoraElement {
  public nodeType: NodeType = 9;
  public readonly readyState = 'complete';
  public inlineHandlerCompiler?: (code: string) => Function;

  constructor() {
    super('#document');
  }

  public get title(): string {
    const titleEl = this.querySelector('title');
    return titleEl ? titleEl.textContent : '';
  }

  public set title(val: string) {
    let titleEl = this.querySelector('title');
    if (!titleEl) {
      const head = this.querySelector('head') || this;
      titleEl = new MemoraElement('title');
      head.appendChild(titleEl);
    }
    titleEl.textContent = val;
  }

  public get documentElement(): MemoraElement {
    const html = this.querySelector('html');
    return html || this;
  }

  public get head(): MemoraElement | null {
    return this.querySelector('head');
  }

  public get body(): MemoraElement | null {
    return this.querySelector('body');
  }

  public createElement(tagName: string): MemoraElement {
    return new MemoraElement(tagName);
  }

  public createTextNode(data: string): MemoraTextNode {
    return new MemoraTextNode(data);
  }

  public getElementById(id: string): MemoraElement | null {
    return this.querySelector(`#${id}`);
  }

  public getElementsByTagName(tagName: string): MemoraElement[] {
    return this.querySelectorAll(tagName);
  }

  public getElementsByClassName(className: string): MemoraElement[] {
    return this.querySelectorAll(`.${className}`);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
