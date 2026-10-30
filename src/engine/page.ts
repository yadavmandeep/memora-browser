import crypto from 'node:crypto';
import { MemoraDocument, MemoraElement, MemoraNode } from '../dom/node.js';
import { parseHTML } from '../dom/parser.js';
import { V8Sandbox, PageScript, collectRunnableScripts, scriptKind } from '../runtime/v8-sandbox.js';
import { bundleModuleScript, parseImportMap } from '../runtime/esm-bundler.js';
import { NetworkFetcher } from '../network/fetcher.js';
import { extractSemanticSnapshot } from '../distiller/semantic-tree.js';
import { convertToMarkdown } from '../distiller/markdown.js';
import { extractStructuredData, StructuredPageData } from '../distiller/structured-data.js';
import {
  SemanticPageSnapshot,
  PageState,
  NetworkOptions,
  SnapshotOptions,
  PageDiff,
  FormFillOptions,
  FormFillResult,
  SessionData
} from '../types/index.js';
import { MarkdownOptions } from '../distiller/markdown.js';
import { computePageDiff } from '../distiller/diff.js';
import { saveSessionToFile, loadSessionFromFile, validateSessionData } from './session.js';
import { DispatcherPool } from '../network/proxy.js';

export interface NavigateOptions {
  timeoutMs?: number;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  // 'push' adds a history entry, 'replace' overwrites the current one, 'none' leaves history alone
  history?: 'push' | 'replace' | 'none';
  // After scripts ran, wait up to this long for the page's async work (fetch/XHR, promise
  // chains, short timers) to finish before goto() resolves. 0 disables. Default: page.settleTimeoutMs
  settleTimeoutMs?: number;
}

const MAX_SCRIPT_REDIRECTS = 5;
const DEFAULT_SETTLE_TIMEOUT_MS = 5000;

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
  // Default upper bound for the post-load settle phase of goto() (see NavigateOptions)
  public settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS;
  public lastSnapshot: SemanticPageSnapshot | null = null;

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
    // Unload the previous document's JS: its timers and in-flight requests must not keep running
    this._sandbox?.dispose();
    this._sandbox = null;
    // Inline handlers (onclick="...") need the context; creating it replaces this compiler
    doc.inlineHandlerCompiler = (code: string) => {
      if (this.document !== doc) throw new Error('inline handler on a document that is no longer loaded');
      this.sandbox;
      return doc.inlineHandlerCompiler!(code);
    };
    return doc;
  }

  // Parses the HTML and runs its inline scripts synchronously (setContent / restoreState);
  // the JS context is only created if there are any
  private loadDocument(html: string): void {
    const doc = this.adoptDocument(parseHTML(html));
    const scripts = collectRunnableScripts(doc);
    if (scripts.length) this.sandbox.executeScriptElements(scripts);
  }

  // Navigation load: parses the HTML, then runs every classic <script> like a browser parser
  // does. External scripts are fetched in parallel (through this page's fetcher: proxy,
  // cookies, --obey-robots) but executed in document order, interleaved with inline ones;
  // defer scripts run after them and async scripts last. Module scripts are not supported
  // (skipped with a console warning); data blocks (JSON, templates...) never execute.
  // Script-less pages never create a JS context.
  private async loadDocumentWithScripts(html: string, deadline: number): Promise<void> {
    const doc = this.adoptDocument(parseHTML(html));
    const elements = doc.querySelectorAll('script');
    if (!elements.length) return;

    type Entry = { element: MemoraElement; code?: string; src?: string; load?: Promise<string | null> };
    const inOrder: Entry[] = [];
    const deferred: Entry[] = [];
    const asynced: Entry[] = [];
    const warnings: string[] = [];
    const baseUrl = this.baseUrlFor(doc);
    const importMap = parseImportMap(doc, baseUrl);

    for (const element of elements) {
      const kind = scriptKind(element);
      if (kind === 'data') continue;
      if (kind === 'module') {
        const isAsync = element.hasAttribute('async');
        const srcAttr = element.getAttribute('src');
        if (srcAttr === null) {
          const code = element.textContent;
          if (code && code.trim()) {
            const entry: Entry = { element, src: baseUrl };
            entry.load = bundleModuleScript({
              entryCode: code,
              entryUrl: baseUrl,
              baseUrl,
              fetcher: this.fetcher,
              importMap,
              timeoutMs: Math.max(1, deadline - Date.now())
            }).catch(err => {
              this.sandbox.log('error', [`Failed to bundle inline module: ${err?.message || err}`]);
              return null;
            });
            if (isAsync) asynced.push(entry);
            else deferred.push(entry);
          }
          continue;
        }

        let src: string;
        try {
          src = new URL(srcAttr.trim(), baseUrl).toString();
        } catch {
          warnings.push(`Module script with invalid src skipped: ${srcAttr}`);
          continue;
        }
        if (!/^https?:/.test(src)) {
          warnings.push(`Module script with unsupported URL scheme skipped: ${src}`);
          continue;
        }

        const entry: Entry = { element, src };
        entry.load = this.fetcher.fetchResource(src, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          referer: this.url,
          accept: '*/*'
        }).then(async resp => {
          if (resp.status >= 200 && resp.status < 300) {
            return await bundleModuleScript({
              entryCode: resp.body,
              entryUrl: src,
              baseUrl,
              fetcher: this.fetcher,
              importMap,
              timeoutMs: Math.max(1, deadline - Date.now())
            });
          }
          this.sandbox.log('error', [`Failed to load module script ${src}: HTTP ${resp.status}`]);
          return null;
        }, err => {
          this.sandbox.log('error', [`Failed to load module script ${src}: ${err?.message || err}`]);
          return null;
        });

        if (isAsync) asynced.push(entry);
        else deferred.push(entry);
        continue;
        continue;
      }
      const srcAttr = element.getAttribute('src');
      if (srcAttr === null) {
        // async/defer have no effect on inline classic scripts
        const code = element.textContent;
        if (code && code.trim()) inOrder.push({ element, code });
        continue;
      }
      let src: string;
      try {
        src = new URL(srcAttr.trim(), baseUrl).toString();
      } catch {
        warnings.push(`Script with invalid src skipped: ${srcAttr}`);
        continue;
      }
      if (!/^https?:/.test(src)) {
        warnings.push(`Script with unsupported URL scheme skipped: ${src}`);
        continue;
      }
      const entry: Entry = { element, src };
      if (element.hasAttribute('async')) asynced.push(entry);
      else if (element.hasAttribute('defer')) deferred.push(entry);
      else inOrder.push(entry);
    }

    const all = [...inOrder, ...deferred, ...asynced];
    if (!all.length && !warnings.length) return;
    const sandbox = this.sandbox;
    for (const w of warnings) sandbox.log('warn', [w]);
    if (!all.length) return;

    // Start every download at once; a failure (network, HTTP error, robots.txt) only drops that script
    for (const e of all) {
      if (e.load) continue;
      if (!e.src) continue;
      const src = e.src;
      e.load = this.fetcher.fetchResource(src, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        referer: this.url,
        accept: '*/*',
      }).then(
        resp => {
          if (resp.status >= 200 && resp.status < 300) return resp.body;
          sandbox.log('error', [`Failed to load script ${src}: HTTP ${resp.status}`]);
          return null;
        },
        err => {
          sandbox.log('error', [`Failed to load script ${src}: ${err?.message || err}`]);
          return null;
        },
      );
    }

    // Execute in document order. Consecutive scripts whose source is available run in one
    // batch (one vm watchdog); the batch is flushed before waiting for the next download.
    let batch: PageScript[] = [];
    const flush = () => {
      if (batch.length && this.document === doc) sandbox.executeScriptElements(batch);
      batch = [];
    };
    for (const e of all) {
      if (e.code !== undefined) {
        batch.push({ code: e.code, element: e.element });
        continue;
      }
      flush();
      const code = await e.load!;
      if (this.document !== doc) return; // navigated away meanwhile
      if (code !== null && code.trim()) batch.push({ code, element: e.element, filename: e.src });
    }
    flush();
  }

  // <base href> aware document base URL
  private baseUrlFor(doc: MemoraDocument): string {
    const base = doc.querySelector('base[href]')?.getAttribute('href');
    if (base) {
      try { return new URL(base, this.url).toString(); } catch { /* ignore invalid base */ }
    }
    return this.url;
  }

  // Waits until the current document has no pending async work: in-flight fetch() and
  // their promise chains (body reads included), plus short one-shot timers (setInterval and
  // long timeouts are ignored). Resolves true when idle, false when timeoutMs elapsed first.
  // Pages that never created a JS context are idle immediately.
  public async waitForIdle(timeoutMs: number = this.settleTimeoutMs): Promise<boolean> {
    if (!this._sandbox) return true;
    return this._sandbox.waitForIdle(timeoutMs);
  }

  // Releases the page's JS context (timers, in-flight requests)
  public close(): void {
    this._sandbox?.dispose();
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
    const timeoutMs = opts.timeoutMs ?? 20000;
    const settleMs = opts.settleTimeoutMs ?? this.settleTimeoutMs;

    for (let i = 0; i <= MAX_SCRIPT_REDIRECTS; i++) {
      const deadline = Date.now() + timeoutMs;
      const resp = await this.fetcher.request(target, { ...request, timeoutMs });
      this.url = resp.url;
      this.lastStatus = resp.status;
      this.recordHistory(this.url, historyMode);

      // Parse HTML into high-speed DOM, then run its scripts (inline + external; SPAs /
      // client-side hydration) in a fresh V8 context
      await this.loadDocumentWithScripts(resp.body, deadline);

      // Settle: let the fetch()/promise/timer work the scripts started finish before "load",
      // bounded by the settle timeout and never past the navigation timeout
      if (this._sandbox && settleMs > 0) {
        const budget = Math.min(settleMs, deadline - Date.now());
        if (budget > 0) await this._sandbox.waitForIdle(budget);
      }

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

  public getSemanticSnapshot(options: SnapshotOptions = {}): SemanticPageSnapshot {
    const snap = extractSemanticSnapshot(this.document, this.url, options);
    this.lastSnapshot = snap;
    return snap;
  }

  public getMarkdown(options: MarkdownOptions = {}): string {
    return convertToMarkdown(this.document, options);
  }

  public diff(previous?: SemanticPageSnapshot, options?: SnapshotOptions): PageDiff {
    const prev = previous || this.lastSnapshot;
    const current = this.getSemanticSnapshot(options);
    return computePageDiff(prev, current);
  }

  public async fillForm(options: FormFillOptions): Promise<FormFillResult> {
    // 1. Recursive sequence support (multi-step or chained interactions)
    if (options.steps && options.steps.length > 0) {
      const allFilled: string[] = [];
      const allSkipped: string[] = [];
      let anySubmitted = false;
      let lastUrl = this.url;
      let lastTitle = this.title();

      for (const step of options.steps) {
        const stepRes = await this.fillForm(step);
        allFilled.push(...stepRes.filled);
        allSkipped.push(...stepRes.skipped);
        if (stepRes.submitted) anySubmitted = true;
        lastUrl = stepRes.url;
        lastTitle = stepRes.title;
        // Natural micro-turn pause for DOM to settle after step interaction
        await new Promise(r => setTimeout(r, 20));
      }

      return {
        success: true,
        filled: allFilled,
        skipped: allSkipped,
        fieldsFilled: allFilled.length,
        submitted: anySubmitted,
        url: lastUrl,
        title: lastTitle
      };
    }

    // 2. Autonomous, self-healing field population
    const filled: string[] = [];
    const skipped: string[] = [];
    const fields = options.fields || {};

    for (const [target, val] of Object.entries(fields)) {
      const elem = this.resolveElement(target);
      if (!elem) {
        // Target not present on current screen -> gracefully record as skipped without crashing
        skipped.push(target);
        continue;
      }

      const type = (elem.getAttribute('type') || '').toLowerCase();
      if (elem.tagName === 'input' && (type === 'checkbox' || type === 'radio')) {
        const shouldCheck = val === 'true' || val === '1' || val === 'yes' || val === 'checked' || val === 'on';
        this.setChecked(elem, shouldCheck);
        elem.dispatchEvent({ type: 'input', target: elem, bubbles: true });
        elem.dispatchEvent({ type: 'change', target: elem, bubbles: true });
      } else if (elem.tagName === 'select') {
        const option = elem.querySelector(`option[value="${val}"]`) ||
          elem.querySelectorAll('option').find(o => o.textContent.trim() === val);
        if (option) {
          this.selectOption(option);
        } else {
          elem.value = val;
          elem.dispatchEvent({ type: 'change', target: elem, bubbles: true });
        }
      } else if (elem.getAttribute('contenteditable') === 'true' || elem.getAttribute('contenteditable') === '') {
        elem.textContent = val;
        elem.dispatchEvent({ type: 'input', target: elem, bubbles: true });
        elem.dispatchEvent({ type: 'change', target: elem, bubbles: true });
      } else {
        this.type(target, val);
      }
      filled.push(target);
    }

    // 3. Trigger submit / next action if specified
    let submitted = false;
    const submitTarget = options.submitActionId ?? options.submit;
    if (submitTarget !== undefined && submitTarget !== false) {
      if (typeof submitTarget === 'string') {
        const submitElem = this.resolveElement(submitTarget);
        if (submitElem) {
          if (submitElem.tagName === 'form') {
            await this.submitForm(submitElem);
          } else {
            await this.activate(submitElem);
          }
          submitted = true;
        }
      } else if (submitTarget === true && filled.length > 0) {
        // Find form of first filled element or first form on page
        const firstElem = this.resolveElement(filled[0]);
        let form = firstElem ? closest(firstElem, e => e.tagName === 'form') : null;
        if (!form) form = this.document.querySelector('form');
        if (form) {
          await this.submitForm(form);
          submitted = true;
        }
      }
    }

    return {
      success: true,
      filled,
      skipped,
      fieldsFilled: filled.length,
      submitted,
      url: this.url,
      title: this.title()
    };
  }

  public dumpSession(): SessionData {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      url: this.url,
      cookies: this.fetcher.dumpCookies(),
      localStorage: this._sandbox ? this._sandbox.localStorage.dump() : {},
      sessionStorage: this._sandbox ? this._sandbox.sessionStorage.dump() : {},
    };
  }

  public restoreSession(session: SessionData): void {
    validateSessionData(session);
    this.fetcher.restoreCookies(session.cookies);
    this.sandbox.localStorage.restore(session.localStorage);
    this.sandbox.sessionStorage.restore(session.sessionStorage);
  }

  public saveSession(filePath: string): void {
    saveSessionToFile(filePath, this.dumpSession());
  }

  public loadSession(filePath: string): void {
    this.restoreSession(loadSessionFromFile(filePath));
  }

  public async waitForSelector(
    selector: string,
    options: { timeoutMs?: number; state?: 'attached' | 'visible' } = {}
  ): Promise<MemoraElement> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const state = options.state ?? 'visible';
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const el = this.resolveElement(selector);
      if (el) {
        if (state === 'attached') return el;
        const isHidden = el.hasAttribute('hidden') ||
          el.getAttribute('aria-hidden') === 'true' ||
          /display\s*:\s*none/i.test(el.getAttribute('style') || '');
        if (!isHidden) return el;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Timeout waiting for selector "${selector}" to be ${state} (${timeoutMs}ms)`);
  }

  public async waitForFunction(
    fn: string | (() => boolean),
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const interval = options.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let result: any;
      if (typeof fn === 'function') {
        result = fn();
      } else {
        const evalRes = this.evaluate(fn);
        result = evalRes && evalRes.success ? evalRes.result : false;
      }
      if (result) return true;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Timeout waiting for condition (${timeoutMs}ms)`);
  }

  public async settleOnDOMMutation(options: { quietPeriodMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
    const quietMs = options.quietPeriodMs ?? 200;
    const timeoutMs = options.timeoutMs ?? 5000;
    return this.waitForIdle(Math.min(quietMs, timeoutMs));
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

/**
 * 🪐 OrbisPage — Active Page context in Orbis Browser
 */
export const OrbisPage = MemoraPage;
export type OrbisPage = MemoraPage;
