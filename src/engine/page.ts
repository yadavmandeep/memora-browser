import crypto from 'node:crypto';
import { MemoraDocument, MemoraElement, MemoraNode } from '../dom/node.js';
import { parseHTML } from '../dom/parser.js';
import { V8Sandbox, collectRunnableScripts } from '../runtime/v8-sandbox.js';
import { NetworkFetcher } from '../network/fetcher.js';
import { extractSemanticSnapshot } from '../distiller/semantic-tree.js';
import { convertToMarkdown } from '../distiller/markdown.js';
import { extractStructuredData, StructuredPageData } from '../distiller/structured-data.js';
import { SemanticPageSnapshot, PageState, NetworkOptions } from '../types/index.js';
import { DispatcherPool } from '../network/proxy.js';

export interface NavigateOptions {
  timeoutMs?: number;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  // 'push' adds a history entry, 'replace' overwrites the current one, 'none' leaves history alone
  history?: 'push' | 'replace' | 'none';
}

const MAX_SCRIPT_REDIRECTS = 5;

export class MemoraPage {
  public readonly id: string;
  public url: string = 'about:blank';
  public document: MemoraDocument;
  // JS context for the current document, created on first use (see the sandbox getter)
  private _sandbox: V8Sandbox | null = null;
  public fetcher: NetworkFetcher;
  public lastStatus: number = 200;
  private stealth: boolean;
  private network: NetworkOptions;
  private pool?: DispatcherPool;
  private history: string[] = [];
  private historyIndex: number = -1;

  constructor(stealth: boolean = true, network: NetworkOptions = {}, pool?: DispatcherPool) {
    this.id = crypto.randomUUID();
    this.stealth = stealth;
    this.network = network;
    this.pool = pool;
    this.fetcher = new NetworkFetcher(network, pool);
    this.document = this.adoptDocument(parseHTML('<!DOCTYPE html><html><head><title>Memora Empty Page</title></head><body></body></html>'));
  }

  // The V8 context (node:vm context + stealth script, ~1ms and a few hundred KB each) is only
  // built when something needs JS: a page <script>, an inline on* handler, evaluate() / CDP /
  // WebDriver script calls, storage or console access. Script-less pages never pay for it.
  public get sandbox(): V8Sandbox {
    if (!this._sandbox) this._sandbox = this.createSandbox();
    return this._sandbox;
  }

  // Installs a new document with a fresh (lazy) JS context, like a browser navigation
  private adoptDocument(doc: MemoraDocument): MemoraDocument {
    this.document = doc;
    this._sandbox = null;
    // Inline handlers (onclick="...") need the context; creating it replaces this compiler
    doc.inlineHandlerCompiler = (code: string) => {
      if (this.document !== doc) throw new Error('inline handler on a document that is no longer loaded');
      this.sandbox;
      return doc.inlineHandlerCompiler!(code);
    };
    return doc;
  }

  // Parses the HTML and runs its inline scripts; the JS context is only created if there are any
  private loadDocument(html: string): void {
    const doc = this.adoptDocument(parseHTML(html));
    const scripts = collectRunnableScripts(doc);
    if (scripts.length) this.sandbox.executeScriptElements(scripts);
  }

  private createSandbox(): V8Sandbox {
    return new V8Sandbox(this.document, this.url, this.stealth, {
      // Page fetch()/XHR goes through the same proxy, cookies and headers as navigations
      fetch: (input: any, init?: any) => this.fetcher.pageFetch(input, init, this.url),
    });
  }

  public async goto(url: string, timeoutOrOpts: number | NavigateOptions = 20000): Promise<{ status: number; url: string }> {
    const opts: NavigateOptions = typeof timeoutOrOpts === 'number' ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts;
    let target = this.url !== 'about:blank' ? new URL(url, this.url).toString() : url;
    let request = { method: opts.method, body: opts.body, headers: opts.headers };
    let historyMode = opts.history || 'push';

    for (let i = 0; i <= MAX_SCRIPT_REDIRECTS; i++) {
      const resp = await this.fetcher.request(target, { ...request, timeoutMs: opts.timeoutMs ?? 20000 });
      this.url = resp.url;
      this.lastStatus = resp.status;
      this.recordHistory(this.url, historyMode);

      // Parse HTML into high-speed DOM, then run its scripts (SPAs / client-side hydration)
      // in a fresh V8 context
      this.loadDocument(resp.body);

      // Scripts that assign window.location trigger a follow-up navigation
      const pending = this.takePendingNavigation();
      if (!pending || pending === this.url) break;
      target = pending;
      request = { method: 'GET', body: undefined, headers: undefined };
      historyMode = 'replace';
    }

    return { status: this.lastStatus, url: this.url };
  }

  private recordHistory(url: string, mode: 'push' | 'replace' | 'none'): void {
    if (mode === 'none') return;
    if (mode === 'replace' && this.historyIndex >= 0) {
      this.history[this.historyIndex] = url;
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
  }

  public canGoBack(): boolean {
    return this.historyIndex > 0;
  }

  public canGoForward(): boolean {
    return this.historyIndex < this.history.length - 1;
  }

  public async back(): Promise<{ status: number; url: string } | null> {
    if (!this.canGoBack()) return null;
    this.historyIndex--;
    return this.goto(this.history[this.historyIndex], { history: 'none' });
  }

  public async forward(): Promise<{ status: number; url: string } | null> {
    if (!this.canGoForward()) return null;
    this.historyIndex++;
    return this.goto(this.history[this.historyIndex], { history: 'none' });
  }

  // Click with browser default actions: follows links, submits forms, toggles
  // checkboxes/radios and selects <option>s. Returns true when it navigated.
  public async activate(target: string | MemoraElement): Promise<boolean> {
    const elem = typeof target === 'string' ? this.resolveElement(target) : target;
    if (!elem) throw new Error(`Element "${target}" not found`);

    const prevChecked = elem.hasAttribute('checked');
    const type = (elem.getAttribute('type') || '').toLowerCase();
    const isCheckable = elem.tagName === 'input' && (type === 'checkbox' || type === 'radio');

    // Checkbox/radio state flips before listeners run, as in browsers
    if (isCheckable) this.setChecked(elem, type === 'radio' ? true : !prevChecked);

    const notPrevented = elem.click();

    if (!notPrevented) {
      if (isCheckable) this.setChecked(elem, prevChecked);
      return false;
    }
    if (isCheckable) {
      elem.dispatchEvent({ type: 'input', target: elem, bubbles: true });
      elem.dispatchEvent({ type: 'change', target: elem, bubbles: true });
    }

    if (elem.tagName === 'option') {
      this.selectOption(elem);
      return false;
    }

    // Navigation requested by a click handler (location.href = ...)
    const pending = this.takePendingNavigation();
    if (pending) {
      await this.goto(pending);
      return true;
    }

    const link = closest(elem, e => e.tagName === 'a' && e.hasAttribute('href'));
    if (link) {
      const href = link.getAttribute('href')!;
      if (href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return false;
      await this.goto(new URL(href, this.url).toString());
      return true;
    }

    const isSubmitter =
      (elem.tagName === 'button' && (type === '' || type === 'submit')) ||
      (elem.tagName === 'input' && (type === 'submit' || type === 'image'));
    if (isSubmitter && !elem.hasAttribute('disabled')) {
      const form = this.formOwner(elem);
      if (form) return this.submitForm(form, elem);
    }
    return false;
  }

  private setChecked(elem: MemoraElement, checked: boolean): void {
    if (checked) {
      const type = (elem.getAttribute('type') || '').toLowerCase();
      const name = elem.getAttribute('name');
      if (type === 'radio' && name) {
        const scope = this.formOwner(elem) || this.document;
        for (const other of scope.querySelectorAll(`input[type="radio"]`)) {
          if (other !== elem && other.getAttribute('name') === name) other.removeAttribute('checked');
        }
      }
      elem.setAttribute('checked', '');
    } else {
      elem.removeAttribute('checked');
    }
  }

  public selectOption(option: MemoraElement): void {
    const select = closest(option, e => e.tagName === 'select');
    if (select && !select.hasAttribute('multiple')) {
      for (const o of select.querySelectorAll('option')) o.removeAttribute('selected');
      option.setAttribute('selected', '');
    } else if (option.hasAttribute('selected')) {
      option.removeAttribute('selected');
    } else {
      option.setAttribute('selected', '');
    }
    if (select) {
      select.dispatchEvent({ type: 'input', target: select, bubbles: true });
      select.dispatchEvent({ type: 'change', target: select, bubbles: true });
    }
  }

  public formOwner(elem: MemoraElement): MemoraElement | null {
    const formId = elem.getAttribute('form');
    if (formId) {
      const byId = this.document.querySelector(`form[id="${formId.replace(/"/g, '\\"')}"]`);
      if (byId) return byId;
    }
    return closest(elem, e => e.tagName === 'form');
  }

  // Implicit/explicit form submission: fires "submit", then navigates with the form data
  public async submitForm(form: MemoraElement, submitter?: MemoraElement): Promise<boolean> {
    const event: any = {
      type: 'submit',
      target: form,
      submitter,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
    };
    form.dispatchEvent(event);
    if (event.defaultPrevented) {
      const pending = this.takePendingNavigation();
      if (pending) {
        await this.goto(pending);
        return true;
      }
      return false;
    }

    const params = new URLSearchParams();
    for (const [name, value] of collectFormData(form, this.document, submitter)) {
      params.append(name, value);
    }

    const method = ((submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'get')).toUpperCase();
    const actionAttr = submitter?.getAttribute('formaction') || form.getAttribute('action') || this.url;
    const action = new URL(actionAttr, this.url);

    if (method === 'POST') {
      await this.goto(action.toString(), {
        method: 'POST',
        body: params.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': new URL(this.url).origin, 'Referer': this.url },
      });
    } else {
      action.search = params.toString();
      await this.goto(action.toString());
    }
    return true;
  }

  public setContent(html: string, url: string = 'about:blank'): void {
    this.url = url;
    this.loadDocument(html);
  }

  // Location change requested by page JS (none possible if no context was ever created)
  public takePendingNavigation(): string | null {
    return this._sandbox ? this._sandbox.takePendingNavigation() : null;
  }

  public title(): string {
    return this.document.title;
  }

  public content(): string {
    return this.document.outerHTML;
  }

  public evaluate(script: string): any {
    return this.sandbox.evaluate(script);
  }

  public querySelector(selector: string): MemoraElement | null {
    return this.document.querySelector(selector);
  }

  public querySelectorAll(selector: string): MemoraElement[] {
    return this.document.querySelectorAll(selector);
  }

  // Resolve target element by either standard CSS selector OR agent action ID like '@1'
  public resolveElement(target: string): MemoraElement | null {
    if (target.startsWith('@')) {
      const snapshot = this.getSemanticSnapshot();
      
      // Look for direct node reference via stamped actionId
      const findByActionId = (node: MemoraNode): MemoraElement | null => {
        if (node instanceof MemoraElement) {
          if ((node as any).__actionId === target) return node;
          for (const child of node.childNodes) {
            const found = findByActionId(child);
            if (found) return found;
          }
        }
        return null;
      };

      const direct = findByActionId(this.document);
      if (direct) return direct;

      const match = snapshot.actions.find(a => a.actionId === target);
      if (match) {
        return this.document.querySelector(match.selector);
      }
      return null;
    }
    return this.document.querySelector(target);
  }

  public click(target: string): boolean {
    const elem = this.resolveElement(target);
    if (!elem) return false;
    elem.click();
    return true;
  }

  public type(target: string, text: string): boolean {
    const elem = this.resolveElement(target);
    if (!elem) return false;
    elem.value = text;
    elem.dispatchEvent({
      type: 'input',
      target: elem,
      bubbles: true,
      cancelable: false
    });
    elem.dispatchEvent({
      type: 'change',
      target: elem,
      bubbles: true,
      cancelable: false
    });
    return true;
  }

  public async reload(): Promise<{ status: number; url: string }> {
    if (!this.url || this.url === 'about:blank') {
      return { status: 200, url: this.url };
    }
    return this.goto(this.url, { history: 'replace' });
  }

  public getLogs(): Array<{ type: string; text: string; timestamp: number }> {
    return this._sandbox ? [...this._sandbox.logs] : [];
  }

  public clearLogs(): void {
    if (this._sandbox) this._sandbox.logs.length = 0;
  }

  public extract(selector: string, attribute?: string, limit: number = 50): any[] {
    const elements = this.querySelectorAll(selector).slice(0, limit);
    return elements.map(el => {
      if (attribute === 'text' || attribute === 'textContent') {
        return el.textContent.trim();
      }
      if (attribute === 'html' || attribute === 'innerHTML') {
        return el.innerHTML;
      }
      if (attribute) {
        return el.getAttribute(attribute);
      }
      return {
        tag: el.tagName,
        text: el.textContent.trim().replace(/\s+/g, ' '),
        attributes: el.attributes
      };
    });
  }

  public getSemanticSnapshot(): SemanticPageSnapshot {
    return extractSemanticSnapshot(this.document, this.url);
  }

  public getMarkdown(): string {
    return convertToMarkdown(this.document);
  }

  public getStructuredData(): StructuredPageData {
    return extractStructuredData(this.document, this.url);
  }

  public dumpState(): PageState {
    return {
      url: this.url,
      html: this.document.outerHTML,
      cookies: this.fetcher.dumpCookies(),
      localStorage: this._sandbox ? this._sandbox.localStorage.dump() : {},
      sessionStorage: this._sandbox ? this._sandbox.sessionStorage.dump() : {},
    };
  }

  public restoreState(state: PageState): void {
    this.setContent(state.html, state.url);
    this.fetcher.restoreCookies(state.cookies);
    this.sandbox.localStorage.restore(state.localStorage);
    this.sandbox.sessionStorage.restore(state.sessionStorage);
  }

  public fork(): MemoraPage {
    const cloned = new MemoraPage(this.stealth, this.network, this.pool);
    const state = this.dumpState();
    cloned.restoreState(state);
    return cloned;
  }
}

function closest(elem: MemoraElement, test: (e: MemoraElement) => boolean): MemoraElement | null {
  let cur: MemoraElement | null = elem;
  while (cur && cur.nodeType === 1) {
    if (test(cur)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Successful controls per the HTML form submission algorithm (urlencoded subset)
export function collectFormData(form: MemoraElement, doc: MemoraDocument, submitter?: MemoraElement): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const formId = form.getAttribute('id');
  const controls = form.querySelectorAll('input, select, textarea, button');
  if (formId) {
    for (const el of doc.querySelectorAll(`[form="${formId.replace(/"/g, '\\"')}"]`)) {
      if (!controls.includes(el)) controls.push(el);
    }
  }

  for (const el of controls) {
    const name = el.getAttribute('name');
    if (!name || el.hasAttribute('disabled')) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (el.tagName === 'button' || (el.tagName === 'input' && ['submit', 'image', 'reset', 'button'].includes(type))) {
      if (el === submitter && type !== 'reset' && type !== 'button') entries.push([name, el.getAttribute('value') || '']);
      continue;
    }
    if (el.tagName === 'input') {
      if (type === 'file') continue;
      if (type === 'checkbox' || type === 'radio') {
        if (el.hasAttribute('checked')) entries.push([name, el.getAttribute('value') ?? 'on']);
        continue;
      }
      entries.push([name, el.value]);
    } else if (el.tagName === 'select') {
      const options = el.querySelectorAll('option');
      const selected = options.filter(o => o.hasAttribute('selected'));
      const picked = selected.length ? selected : (el.hasAttribute('multiple') ? [] : options.slice(0, 1));
      for (const o of picked) entries.push([name, o.getAttribute('value') ?? o.textContent.trim()]);
    } else if (el.tagName === 'textarea') {
      entries.push([name, el.hasAttribute('value') ? el.value : el.textContent]);
    }
  }
  return entries;
}
