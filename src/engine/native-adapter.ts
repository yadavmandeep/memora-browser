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

  public async goto(url: string, timeoutMs: number = 20000): Promise<{ status: number; url: string }> {
    const res = await this.page.goto(url, timeoutMs);
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
        const dump = this.page.fetcher.dumpCookies();
        return JSON.stringify(dump, null, 2);
      }
      case 'set': {
        if (!name || value === undefined) throw new Error('Cookie name and value required');
        const dump = this.page.fetcher.dumpCookies();
        dump[name] = value;
        this.page.fetcher.restoreCookies(dump);
        return `Cookie "${name}" set`;
      }
      case 'clear': {
        this.page.fetcher.restoreCookies({});
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

  public async evaluate(code: string): Promise<any> {
    const res = this.page.evaluate(code);
    return res && res.success !== undefined ? (res.success ? res.result : { error: res.error }) : res;
  }

  public async getStructuredData(): Promise<StructuredPageData> {
    return this.page.getStructuredData();
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

