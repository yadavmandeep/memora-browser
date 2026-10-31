import crypto from 'crypto';
import { OrbisPage, MemoraPage } from './page.js';
import type { OrbisBrowser } from './browser.js';
import { CookieJar } from '../network/cookie-jar.js';
import { NetworkOptions } from '../types/index.js';

export interface ContextOptions {
  id?: string;
  stealth?: boolean;
  network?: NetworkOptions;
}

/**
 * ⬡ OrbisContext — Isolated execution context within OrbisBrowser (similar to Playwright BrowserContext).
 * Provides isolated CookieJar, isolated storage, and dedicated worker tabs.
 */
export class OrbisContext {
  public readonly id: string;
  public readonly browser: OrbisBrowser;
  public readonly cookieJar: CookieJar;
  public readonly options: ContextOptions;
  private pages: Map<string, OrbisPage> = new Map();

  constructor(browser: OrbisBrowser, options: ContextOptions = {}, cookieJar?: CookieJar) {
    this.id = options.id || crypto.randomUUID();
    this.browser = browser;
    this.options = options;
    this.cookieJar = cookieJar || new CookieJar();
  }

  /**
   * Create a new page/tab inside this isolated context.
   */
  public newPage(): OrbisPage {
    const stealth = this.options.stealth !== false && this.browser.options.stealth !== false;
    const network = { ...this.browser.options.network, ...(this.options.network || {}) };

    const page = new MemoraPage(stealth, network, this.browser.pool, this.cookieJar);
    page.context = this;
    page.browser = this.browser;

    this.pages.set(page.id, page);
    this.browser._registerPage(page);
    return page;
  }

  public listPages(): OrbisPage[] {
    return Array.from(this.pages.values());
  }

  public getPage(id: string): OrbisPage | undefined {
    return this.pages.get(id);
  }

  public closePage(id: string): boolean {
    const page = this.pages.get(id);
    if (!page) return false;
    page.close();
    this.pages.delete(id);
    this.browser._unregisterPage(id);
    return true;
  }

  public _attachPage(page: OrbisPage): void {
    this.pages.set(page.id, page);
  }

  public _detachPage(id: string): void {
    this.pages.delete(id);
  }

  /**
   * Close all pages in this context, clear context cookies, and release resources.
   */
  public close(): void {
    for (const page of this.pages.values()) {
      page.close();
      this.browser._unregisterPage(page.id);
    }
    this.pages.clear();
    this.cookieJar.clear();
    this.browser._unregisterContext(this.id);
  }
}

/**
 * Backward compatibility alias: MemoraContext
 */
export const MemoraContext = OrbisContext;
export type MemoraContext = OrbisContext;

