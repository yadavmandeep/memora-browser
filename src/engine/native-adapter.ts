import { MemoraBrowser } from './browser.js';
import { MemoraPage } from './page.js';
import {
  NetworkOptions,
  SemanticPageSnapshot,
  SnapshotOptions,
  PageDiff,
  FormFillOptions,
  SessionData,
  StructuredPageData
} from '../types/index.js';
import { MarkdownOptions } from '../distiller/markdown.js';
import type { ChallengeSignal } from '../challenge/detector.js';

export class NativeEngineAdapter {
  public browser: MemoraBrowser;
  public page: MemoraPage;
  private actionSelectorMap: Map<string, string> = new Map();

  constructor(network: NetworkOptions = {}) {
    this.browser = new MemoraBrowser({ stealth: true, network });
    this.page = this.browser.newPage();
  }

  public async goto(url: string, timeoutMs?: number): Promise<{ status: number; url: string }> {
    const res = await this.page.goto(url, timeoutMs === undefined ? {} : timeoutMs);
    const snap = this.page.getSemanticSnapshot();
    this.actionSelectorMap.clear();
    for (const act of snap.actions) {
      this.actionSelectorMap.set(act.actionId, act.selector);
    }
    return res;
  }

  public getChallenge(): { signal: ChallengeSignal | null; cooldownSec: number } {
    return { signal: this.page.lastChallenge, cooldownSec: this.page.lastChallengeCooldownSec };
  }

  public async getSemanticSnapshot(options: SnapshotOptions = {}): Promise<SemanticPageSnapshot> {
    const snap = this.page.getSemanticSnapshot(options);
    this.actionSelectorMap.clear();
    for (const act of snap.actions) {
      this.actionSelectorMap.set(act.actionId, act.selector);
    }
    return snap;
  }

  public async getMarkdown(options: MarkdownOptions = {}): Promise<string> {
    return this.page.getMarkdown(options);
  }

  public async diff(previous?: SemanticPageSnapshot, options?: SnapshotOptions): Promise<PageDiff> {
    const diff = this.page.diff(previous, options);
    this.actionSelectorMap.clear();
    for (const act of this.page.lastSnapshot?.actions || []) {
      this.actionSelectorMap.set(act.actionId, act.selector);
    }
    return diff;
  }

  public async fillForm(options: FormFillOptions): Promise<{
    success: boolean;
    fieldsFilled: number;
    submitted: boolean;
    url: string;
    title: string;
  }> {
    return await this.page.fillForm(options);
  }

  public async act(target: string, type: 'click' | 'type', text?: string): Promise<{ success: boolean; url: string; title: string }> {
    if (type === 'type') {
      const ok = this.page.type(target, text || '');
      if (!ok) throw new Error(`Could not type into element "${target}"`);
    } else {
      await this.page.activate(target);
    }
    return {
      success: true,
      url: this.page.url,
      title: this.page.title()
    };
  }

  // Tag, type attribute and form membership of an action target (firewall: is this click a form submit?)
  public async describeTarget(target: string): Promise<{ tag: string; type: string | null; inForm: boolean } | null> {
    let el;
    try {
      const mapped = target.startsWith('@') ? this.actionSelectorMap.get(target) : undefined;
      el = mapped ? this.page.querySelector(mapped) : target.startsWith('@') ? null : this.page.resolveElement(target);
    } catch {
      return null;
    }
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), inForm: !!this.page.formOwner(el) };
  }

  public async inspect(): Promise<SemanticPageSnapshot> {
    return this.getSemanticSnapshot();
  }

  public async extract(selector: string, attribute?: string, limit: number = 50): Promise<any[]> {
    return this.page.extract(selector, attribute, limit);
  }

  public async storage(storageType: 'local' | 'session', action: string, key?: string, value?: string): Promise<string> {
    const store = storageType === 'session' ? this.page.sandbox.sessionStorage : this.page.sandbox.localStorage;
    switch (action) {
      case 'get':
        return store.getItem(key || '') ?? `Key "${key}" not found`;
      case 'set':
        if (!key || value === undefined) throw new Error('Key and value required');
        store.setItem(key, value);
        return `Set ${storageType}Storage["${key}"] = "${value}"`;
      case 'remove':
        if (!key) throw new Error('Key required');
        store.removeItem(key);
        return `Removed "${key}" from ${storageType}Storage`;
      case 'clear':
        store.clear();
        return `Cleared ${storageType}Storage`;
      case 'list': {
        const out = store.dump();
        return JSON.stringify(out, null, 2);
      }
      default:
        throw new Error(`Unknown storage action: ${action}`);
    }
  }

  public async cookies(action: string, name?: string, value?: string): Promise<string> {
    switch (action) {
      case 'list': {
        // Cookies the current site receives
        const dump = this.page.fetcher.dumpCookies(/^https?:/.test(this.page.url) ? this.page.url : undefined);
        return JSON.stringify(dump, null, 2);
      }
      case 'set': {
        if (!name || value === undefined) throw new Error('Cookie name and value required');
        this.page.fetcher.setCookie(name, value, /^https?:/.test(this.page.url) ? this.page.url : undefined);
        return `Cookie "${name}" set for ${/^https?:/.test(this.page.url) ? new URL(this.page.url).host : 'every site'}`;
      }
      case 'clear': {
        this.page.fetcher.clearCookies();
        return 'All cookies cleared';
      }
      default:
        throw new Error(`Cookie action "${action}" not supported`);
    }
  }

  public getLogs(clear: boolean = false): Array<{ type: string; text: string; timestamp: number }> {
    const logs = this.page.getLogs();
    if (clear) this.page.clearLogs();
    return logs;
  }

  public async reload(): Promise<{ status: number; url: string }> {
    return await this.page.reload();
  }

  public async html(selector?: string): Promise<string> {
    if (selector) {
      const el = this.page.querySelector(selector);
      if (!el) return `Element "${selector}" not found.`;
      return el.outerHTML;
    }
    return this.page.content();
  }

  // Runs code in the page; awaits a returned promise (10 s) and returns a plain, JSON-safe value.
  // Thrown errors and rejections propagate as errors.
  public async evaluate(code: string, promiseTimeoutMs: number = 10000): Promise<any> {
    let value = this.page.sandbox.evaluateRaw(code, 5000);
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the promise')), promiseTimeoutMs);
      });
      try {
        value = await Promise.race([Promise.resolve(value), timeout]);
      } catch (err: any) {
        throw err instanceof Error ? err : new Error(err?.message || String(err));
      } finally {
        clearTimeout(timer);
      }
    }
    return toPlainValue(value);
  }

  public async getStructuredData(): Promise<StructuredPageData> {
    return this.page.getStructuredData();
  }

  public async extractSchema(schema?: any): Promise<any> {
    return this.page.extractSchema(schema);
  }

  public async fork(): Promise<string> {
    const forked = this.page.fork();
    this.page = forked;
    return `Forked tab created! Switched active context to cloned tab at ${this.page.url}`;
  }

  public async saveSession(filePath: string): Promise<void> {
    this.page.saveSession(filePath);
  }

  public async loadSession(filePath: string): Promise<void> {
    this.page.loadSession(filePath);
  }

  public async waitForSelector(
    selector: string,
    options: { timeoutMs?: number; state?: 'attached' | 'visible' } = {}
  ): Promise<any> {
    return await this.page.waitForSelector(selector, options);
  }

  public async waitForFunction(
    fn: string | (() => boolean),
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<boolean> {
    return await this.page.waitForFunction(fn, options);
  }

  public async settleOnDOMMutation(options: { quietPeriodMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
    return await this.page.settleOnDOMMutation(options);
  }

  public async close(): Promise<void> {
    this.page.close();
    this.browser.close();
  }
}

// Page value -> JSON-safe value: undefined -> "undefined", functions and DOM nodes -> short strings
function toPlainValue(val: any, depth = 0, seen: WeakSet<object> = new WeakSet()): any {
  if (val === undefined) return depth === 0 ? 'undefined' : null;
  if (val === null) return null;
  const t = typeof val;
  if (t === 'string' || t === 'boolean') return val;
  if (t === 'number') return Number.isFinite(val) ? val : String(val);
  if (t === 'bigint') return `${val}n`;
  if (t === 'symbol') return val.toString();
  if (t === 'function') return `[Function${val.name ? ` ${val.name}` : ''}]`;
  if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') {
    if (val.nodeType === 1) {
      const id = val.getAttribute?.('id');
      return `<${String(val.tagName).toLowerCase()}${id ? `#${id}` : ''}>`;
    }
    return `[${val.nodeName}]`;
  }
  if (seen.has(val)) return '[Circular]';
  if (depth >= 8) return '[Object]';
  seen.add(val);
  try {
    if (Array.isArray(val)) return val.slice(0, 1000).map(v => toPlainValue(v, depth + 1, seen));
    if (val instanceof Error || (typeof val.message === 'string' && typeof val.stack === 'string')) return `${val.name || 'Error'}: ${val.message}`;
    if (typeof val.toJSON === 'function') {
      try { return toPlainValue(val.toJSON(), depth + 1, seen); } catch { /* fall through */ }
    }
    const out: Record<string, any> = {};
    for (const key of Object.keys(val).slice(0, 1000)) {
      let v: any;
      try { v = val[key]; } catch { continue; }
      if (v === undefined) continue;
      out[key] = toPlainValue(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(val);
  }
}

