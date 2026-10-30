import vm from 'node:vm';
import { MemoraDocument, MemoraElement } from '../dom/node.js';
import { generateStealthScript } from '../stealth/fingerprint.js';
import { transformInlineModule } from './esm-bundler.js';

export class MemoraStorage {
  private data: Map<string, string> = new Map();

  public getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  public removeItem(key: string): void {
    this.data.delete(key);
  }

  public clear(): void {
    this.data.clear();
  }

  public key(index: number): string | null {
    const keys = Array.from(this.data.keys());
    return keys[index] ?? null;
  }

  public get length(): number {
    return this.data.size;
  }

  public dump(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.data.entries()) {
      out[k] = v;
    }
    return out;
  }

  public restore(items: Record<string, string>): void {
    this.data.clear();
    for (const [k, v] of Object.entries(items)) {
      this.data.set(k, v);
    }
  }
}

export interface V8ConsoleLog {
  type: 'log' | 'warn' | 'error' | 'info';
  text: string;
  timestamp: number;
}

export interface SandboxOptions {
  // Replaces the global fetch inside the page (proxy / cookie aware)
  fetch?: (input: any, init?: any) => Promise<any>;
}

// Context setup scripts are identical for every page: compile them once and only run
// them per context (saves a parse/compile per navigation).
// window / self / globalThis must be the real global so builtins (eval, Array, ...) and
// globals declared by page scripts are reachable through window.*
// window is an EventTarget (load, message, custom events used by automation scripts)
const PRELUDE_SCRIPT = new vm.Script(`globalThis.window = globalThis; globalThis.self = globalThis; globalThis.top = globalThis; globalThis.parent = globalThis;
(() => {
  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  globalThis.removeEventListener = (type, fn) => { listeners.get(type)?.delete(fn); };
  globalThis.dispatchEvent = (event) => {
    for (const fn of [...(listeners.get(event.type) || [])]) {
      try { typeof fn === 'function' ? fn.call(globalThis, event) : fn.handleEvent(event); } catch (e) { console.error(String(e)); }
    }
    return !event.defaultPrevented;
  };
  // DOM mutations are not observable yet; scripts may still construct observers
  globalThis.MutationObserver = class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
})();`, { filename: 'memora-prelude.js' });

let stealthScript: vm.Script | undefined;

const SCRIPT_TIMEOUT_MS = 5000;
const SCRIPT_RUNNER_GLOBAL = '__memoraRunPageScripts__';
const RUN_SCRIPTS = new vm.Script(`${SCRIPT_RUNNER_GLOBAL}()`, { filename: 'memora-script-runner.js' });

// Classic-script MIME types (HTML "JavaScript MIME type essence match"); an absent or empty
// type attribute also means classic JavaScript. Anything else (JSON, ld+json, templates,
// text/x-*) is a data block and never executes.
const JS_MIME_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

export type ScriptKind = 'classic' | 'module' | 'data';

export function scriptKind(script: MemoraElement): ScriptKind {
  const typeAttr = script.getAttribute('type');
  if (typeAttr === null || typeAttr.trim() === '') {
    const lang = script.getAttribute('language');
    if (lang === null || lang.trim() === '') return 'classic';
    return JS_MIME_TYPES.has(`text/${lang.trim().toLowerCase()}`) ? 'classic' : 'data';
  }
  const type = typeAttr.trim().toLowerCase();
  if (type === 'module') return 'module';
  // essence match: parameters such as ";charset=utf-8" are ignored
  return JS_MIME_TYPES.has(type.split(';')[0].trim()) ? 'classic' : 'data';
}

// One page script ready to run: source plus the element it came from (document.currentScript)
export interface PageScript {
  code: string;
  element?: MemoraElement;
  filename?: string;
}

// Inline classic <script> sources the page would execute, in document order
// (external scripts are fetched and interleaved by MemoraPage)
export function collectRunnableScripts(document: MemoraDocument): string[] {
  const out: string[] = [];
  for (const script of document.querySelectorAll('script')) {
    if (scriptKind(script) !== 'classic' && scriptKind(script) !== 'module') continue;
    if (script.hasAttribute('src')) continue;
    const code = script.textContent;
    if (!code || !code.trim()) continue;
    if (scriptKind(script) === 'classic') {
      out.push(code);
    } else {
      try { out.push(transformInlineModule(code)); } catch { /* ignore */ }
      continue;
    }
  }
  return out;
}

// ---- Async work tracking (fetch / timers) for "settle" after load
// One-shot timers up to this delay keep the page busy; longer ones (and every setInterval) do not
const MAX_TRACKED_TIMER_DELAY_MS = 1000;
// A timer scheduled from a timer callback is nested one level deeper; polling loops stop
// counting as pending work past this depth (like the browser's nesting-level clamp)
const MAX_TRACKED_TIMER_NESTING = 10;
const BODY_METHODS = ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'];

// Rejections nobody handles in page code (an async function throwing, an un-awaited fetch
// failing) must not take the whole Node process down: they are reported to the page console.
const contextPromiseProtos = new WeakMap<object, V8Sandbox>();
const hostPagePromises = new WeakMap<object, V8Sandbox>();
let rejectionGuardInstalled = false;

function installRejectionGuard(): void {
  if (rejectionGuardInstalled) return;
  rejectionGuardInstalled = true;
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    const owner = hostPagePromises.get(promise) || contextPromiseProtos.get(Object.getPrototypeOf(promise));
    if (owner) {
      owner.reportError('Uncaught (in promise)', reason);
      return;
    }
    // Not page work: keep Node's default (crash) unless the application handles rejections itself
    if (process.listenerCount('unhandledRejection') > 1) return;
    throw reason;
  });
}

function formatLogArg(a: any): string {
  if (a !== null && typeof a === 'object' && typeof a.message === 'string' && typeof a.stack === 'string') {
    return a.stack || `${a.name}: ${a.message}`;
  }
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

export class V8Sandbox {
  private context: vm.Context;
  private document: MemoraDocument;
  private url: URL;
  private pendingNavigation: string | null = null;
  // Settle tracking: in-flight fetch()/body reads and short one-shot timers
  private pendingOps = 0;
  private timers = new Map<number, { handle: ReturnType<typeof setTimeout>; tracked: boolean }>();
  private trackedTimers = 0;
  private nextTimerId = 1;
  private timerDepth = 0;
  private wake: (() => void) | null = null;
  private readonly abortController = new AbortController();
  private disposed = false;
  public readonly localStorage: MemoraStorage = new MemoraStorage();
  public readonly sessionStorage: MemoraStorage = new MemoraStorage();
  public readonly logs: V8ConsoleLog[] = [];

  constructor(document: MemoraDocument, initialUrl: string = 'about:blank', enableStealth: boolean = true, options: SandboxOptions = {}) {
    this.document = document;
    this.url = new URL(initialUrl);


    const self = this;
    // Assigning location records a navigation the page performs once the script returns
    const navigate = (v: string) => {
      try {
        self.pendingNavigation = new URL(String(v), self.url).toString();
      } catch {
        // invalid URL: browsers throw, scripts usually don't care
      }
    };
    const locationObj = {
      get href(): string { return self.url.href; },
      set href(v: string) { navigate(v); },
      get protocol(): string { return self.url.protocol; },
      get host(): string { return self.url.host; },
      get hostname(): string { return self.url.hostname; },
      get port(): string { return self.url.port; },
      get pathname(): string { return self.url.pathname; },
      get search(): string { return self.url.search; },
      get hash(): string { return self.url.hash; },
      assign: (url: string) => navigate(url),
      replace: (url: string) => navigate(url),
      reload: () => navigate(self.url.href),
      toString: () => self.url.href,
    };

    const navigatorObj = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      language: 'en-US',
      languages: ['en-US', 'en'],
      webdriver: false,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      platform: 'Win32',
      cookieEnabled: true,
      onLine: true,
    };

    const screenObj = {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
    };

    const sandbox = {
      document: this.document,
      location: locationObj,
      navigator: navigatorObj,
      screen: screenObj,
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      console: {
        log: (...args: any[]) => this.log('log', args),
        warn: (...args: any[]) => this.log('warn', args),
        error: (...args: any[]) => this.log('error', args),
        info: (...args: any[]) => this.log('info', args),
        debug: (...args: any[]) => this.log('log', args),
      },
      setTimeout: (fn: any, delay?: number, ...args: any[]) => this.addTimer(fn, delay, args, false),
      clearTimeout: (id: any) => this.clearTimer(id),
      setInterval: (fn: any, delay?: number, ...args: any[]) => this.addTimer(fn, delay, args, true),
      clearInterval: (id: any) => this.clearTimer(id),
      queueMicrotask: (fn: () => void) => queueMicrotask(() => {
        try { fn(); } catch (err) { this.reportError('Uncaught', err); }
      }),
      URL,
      URLSearchParams,
      Headers,
      Request,
      Response,
      FormData,
      AbortController,
      Blob,
      fetch: (input: any, init?: any) => this.trackedFetch(rawFetch, input, init),
    };
    const rawFetch = options.fetch || ((input: any, init?: any) => fetch(input, init));

    this.context = vm.createContext(sandbox);
    installRejectionGuard();
    contextPromiseProtos.set(vm.runInContext('Promise.prototype', this.context), this);
    // window/self/top/parent aliases + window EventTarget, compiled once per process
    PRELUDE_SCRIPT.runInContext(this.context);

    // Lets the DOM run inline handlers like onclick="..." inside this page's context
    this.document.inlineHandlerCompiler = (code: string) =>
      vm.runInContext(`(function(event) {\n${code}\n})`, this.context);

    if (enableStealth) {
      try {
        (stealthScript ??= new vm.Script(generateStealthScript(), { filename: 'memora-stealth.js' })).runInContext(this.context);
      } catch (err: any) {
        process.stderr.write(`[Stealth Init Warning]: ${err.message}\n`);
      }
    }
  }

  public updateUrl(newUrl: string): void {
    try {
      this.url = new URL(newUrl);
    } catch {
      // keep previous
    }
  }

  public takePendingNavigation(): string | null {
    const nav = this.pendingNavigation;
    this.pendingNavigation = null;
    return nav;
  }

  // Runs a WebDriver-style function body with arguments; returns the raw value
  public callFunction(body: string, args: any[], timeoutMs: number = 30000): any {
    const fn = vm.runInContext(`(function() {\n${body}\n})`, this.context, { timeout: timeoutMs });
    return fn.apply(null, args);
  }

  // Evaluates code and returns the raw value (throws on error); used by CDP remote objects
  public evaluateRaw(code: string, timeoutMs: number = 30000): any {
    return vm.runInContext(code, this.context, { timeout: timeoutMs });
  }

  public evaluate(code: string): any {
    try {
      const result = vm.runInContext(code, this.context, {
        timeout: 5000,
        displayErrors: true,
      });
      return { success: true, result: serializeV8Result(result) };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  public executeScriptElements(scripts: Array<string | PageScript> = collectRunnableScripts(this.document)): void {
    // Completion values of page scripts are discarded, so evaluate()'s serialization is skipped.
    // A vm `timeout` starts a watchdog thread per call (~0.2 ms each), so all scripts of the page
    // run inside ONE timed call: a host function runs them one by one (each as its own classic
    // script, sharing the global lexical scope like a browser does). An exception in one script
    // is caught and the next one runs; a script that exhausts the time budget is terminated and
    // execution continues with the following script under a fresh budget.
    if (this.disposed) return;
    const doc = this.document;
    let next = 0;
    const runAll = () => {
      for (; next < scripts.length; next++) {
        const s = scripts[next];
        const code = typeof s === 'string' ? s : s.code;
        doc.currentScript = typeof s === 'string' ? null : s.element ?? null;
        try {
          vm.runInContext(code, this.context, typeof s !== 'string' && s.filename ? { filename: s.filename } : undefined);
        } catch (err) {
          // graceful execution: a failing script does not stop the next one
          this.reportError('Uncaught', err);
        }
      }
    };
    while (next < scripts.length) {
      Object.defineProperty(this.context, SCRIPT_RUNNER_GLOBAL, { value: runAll, configurable: true, writable: false, enumerable: false });
      try {
        RUN_SCRIPTS.runInContext(this.context, { timeout: SCRIPT_TIMEOUT_MS });
      } catch (_) {
        // timed out (or terminated): skip the script that was running
        this.log('error', [`Script terminated after ${SCRIPT_TIMEOUT_MS}ms`]);
        next++;
      } finally {
        delete (this.context as any)[SCRIPT_RUNNER_GLOBAL];
        doc.currentScript = null;
      }
    }
  }

  // ---- console

  public log(type: V8ConsoleLog['type'], args: any[]): void {
    this.logs.push({ type, text: args.map(formatLogArg).join(' '), timestamp: Date.now() });
  }

  public reportError(prefix: string, err: any): void {
    this.log('error', [`${prefix} ${formatLogArg(err)}`]);
  }

  // ---- timers (ids are per page; every handle is unref'd and cleared on dispose)

  private addTimer(fn: any, delay: any, args: any[], repeat: boolean): number {
    if (this.disposed) return 0;
    const id = this.nextTimerId++;
    const ms = Math.max(0, Number(delay) || 0);
    const depth = this.timerDepth + 1;
    const tracked = !repeat && ms <= MAX_TRACKED_TIMER_DELAY_MS && depth <= MAX_TRACKED_TIMER_NESTING;
    const callback = typeof fn === 'function' ? fn : null;
    const source = callback ? null : String(fn);
    const run = () => {
      if (this.disposed) return;
      const prevDepth = this.timerDepth;
      this.timerDepth = depth;
      try {
        if (callback) callback.apply(undefined, args);
        else vm.runInContext(source!, this.context);
      } catch (err) {
        this.reportError('Uncaught', err);
      } finally {
        this.timerDepth = prevDepth;
        // removed after the callback so work it starts (fetch, nested timer) is already counted
        if (!repeat) this.removeTimer(id);
      }
    };
    const handle = repeat ? setInterval(run, Math.max(ms, 1)) : setTimeout(run, ms);
    // Page timers never keep the Node process alive on their own (navigation / settle waits do)
    handle.unref();
    this.timers.set(id, { handle, tracked });
    if (tracked) this.trackedTimers++;
    return id;
  }

  private removeTimer(id: number): void {
    const t = this.timers.get(id);
    if (!t) return;
    this.timers.delete(id);
    if (t.tracked) {
      this.trackedTimers--;
      this.notify();
    }
  }

  private clearTimer(id: any): void {
    const key = Number(id);
    const t = this.timers.get(key);
    if (!t) return;
    clearTimeout(t.handle);
    clearInterval(t.handle);
    this.removeTimer(key);
  }

  // ---- fetch tracking

  private track<T>(p: Promise<T>): Promise<T> {
    this.pendingOps++;
    const tracked = p.finally(() => {
      this.pendingOps--;
      this.notify();
    });
    hostPagePromises.set(tracked, this);
    return tracked;
  }

  private trackedFetch(rawFetch: (input: any, init?: any) => Promise<any>, input: any, init?: any): Promise<any> {
    if (this.disposed) {
      const p = Promise.reject(new TypeError('Failed to fetch: page was unloaded'));
      hostPagePromises.set(p, this);
      return p;
    }
    const pageSignal: AbortSignal | undefined = init?.signal ?? undefined;
    const signal = pageSignal ? AbortSignal.any([pageSignal, this.abortController.signal]) : this.abortController.signal;
    const request = Promise.resolve()
      .then(() => rawFetch(input, { ...(init || {}), signal }))
      .then((resp: any) => {
        // Body reads (response.json() / text() ...) are async work of the page too
        if (resp && typeof resp === 'object') {
          for (const m of BODY_METHODS) {
            const orig = resp[m];
            if (typeof orig !== 'function') continue;
            Object.defineProperty(resp, m, {
              value: (...a: any[]) => this.track(Promise.resolve().then(() => orig.apply(resp, a))),
              configurable: true,
              writable: true,
            });
          }
        }
        return resp;
      });
    return this.track(request);
  }

  public get pendingWork(): { fetches: number; timers: number } {
    return { fetches: this.pendingOps, timers: this.trackedTimers };
  }

  private isIdle(): boolean {
    return this.pendingOps <= 0 && this.trackedTimers <= 0;
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  // Resolves once the page has no in-flight fetch()/body reads and no pending short timers,
  // and the microtask queue has drained (promise chains of finished requests ran). Repeating
  // timers, long timeouts and deeply nested timer chains are ignored. Returns false when the
  // timeout elapsed first.
  public async waitForIdle(timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const turn = () => new Promise<void>(r => setImmediate(r));
    while (!this.disposed) {
      // one macrotask turn: every microtask queued so far (promise continuations) has run
      await turn();
      if (this.isIdle()) {
        await turn();
        if (this.isIdle()) return true;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { if (this.wake === done) this.wake = null; resolve(); }, remaining);
        this.wake = done;
      });
    }
    return true;
  }

  // Page unload: stop timers and abort in-flight requests; later callbacks become no-ops
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers.values()) {
      clearTimeout(t.handle);
      clearInterval(t.handle);
    }
    this.timers.clear();
    this.trackedTimers = 0;
    this.abortController.abort();
    this.notify();
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }
}

function serializeV8Result(val: any): any {
  if (val === undefined) return { type: 'undefined' };
  if (val === null) return { type: 'null', value: null };
  const t = typeof val;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return { type: t, value: val };
  }
  if (Array.isArray(val)) {
    return { type: 'object', subtype: 'array', value: val.slice(0, 50).map(serializeV8Result) };
  }
  if (val instanceof MemoraElement) {
    return { type: 'object', subtype: 'node', description: `<${val.tagName}>` };
  }
  if (typeof val === 'object') {
    try {
      return { type: 'object', value: JSON.parse(JSON.stringify(val)) };
    } catch {
      return { type: 'object', description: Object.prototype.toString.call(val) };
    }
  }
  return { type: t, description: String(val) };
}
