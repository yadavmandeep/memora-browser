import vm from 'node:vm';
import { MemoraDocument, MemoraElement } from '../dom/node.js';
import { generateStealthScript } from '../stealth/fingerprint.js';

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

const RUNNABLE_SCRIPT_TYPES = new Set(['text/javascript', 'application/javascript', 'module']);

// Inline <script> sources the page would execute, in document order
export function collectRunnableScripts(document: MemoraDocument): string[] {
  const out: string[] = [];
  for (const script of document.querySelectorAll('script')) {
    const type = script.getAttribute('type') || 'text/javascript';
    if (!RUNNABLE_SCRIPT_TYPES.has(type)) continue;
    const code = script.textContent;
    if (code && code.trim()) out.push(code);
  }
  return out;
}

export class V8Sandbox {
  private context: vm.Context;
  private document: MemoraDocument;
  private url: URL;
  private pendingNavigation: string | null = null;
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
        log: (...args: any[]) => {
          const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
          this.logs.push({ type: 'log', text, timestamp: Date.now() });
        },
        warn: (...args: any[]) => {
          const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
          this.logs.push({ type: 'warn', text, timestamp: Date.now() });
        },
        error: (...args: any[]) => {
          const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
          this.logs.push({ type: 'error', text, timestamp: Date.now() });
        },
        info: (...args: any[]) => {
          const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
          this.logs.push({ type: 'info', text, timestamp: Date.now() });
        },
      },
      setTimeout: (fn: Function, delay: number, ...args: any[]) => setTimeout(fn, delay, ...args),
      clearTimeout: (id: any) => clearTimeout(id),
      setInterval: (fn: Function, delay: number, ...args: any[]) => setInterval(fn, delay, ...args),
      clearInterval: (id: any) => clearInterval(id),
      URL,
      URLSearchParams,
      Headers,
      Request,
      Response,
      FormData,
      AbortController,
      Blob,
      fetch: options.fetch || (async (input: any, init?: any) => fetch(input, init)),
    };

    this.context = vm.createContext(sandbox);
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

  public executeScriptElements(scripts: string[] = collectRunnableScripts(this.document)): void {
    // Completion values of page scripts are discarded, so evaluate()'s serialization is skipped.
    // A vm `timeout` starts a watchdog thread per call (~0.2 ms each), so all scripts of the page
    // run inside ONE timed call: a host function runs them one by one (each as its own classic
    // script, sharing the global lexical scope like a browser does). An exception in one script
    // is caught and the next one runs; a script that exhausts the time budget is terminated and
    // execution continues with the following script under a fresh budget.
    let next = 0;
    const runAll = () => {
      for (; next < scripts.length; next++) {
        try {
          vm.runInContext(scripts[next], this.context);
        } catch (_) {
          // graceful execution: a failing script does not stop the next one
        }
      }
    };
    while (next < scripts.length) {
      Object.defineProperty(this.context, SCRIPT_RUNNER_GLOBAL, { value: runAll, configurable: true, writable: false, enumerable: false });
      try {
        RUN_SCRIPTS.runInContext(this.context, { timeout: SCRIPT_TIMEOUT_MS });
      } catch (_) {
        // timed out (or terminated): skip the script that was running
        next++;
      } finally {
        delete (this.context as any)[SCRIPT_RUNNER_GLOBAL];
      }
    }
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
