import { AgentBlackboard } from '../memory/index.js';
import { SessionVault, SessionVaultConfig } from '../vault/index.js';
import { MemoraPage, OrbisPage } from './page.js';
import { BrowserOptions } from '../types/index.js';
import { DispatcherPool } from '../network/proxy.js';
import { OrbisContext, ContextOptions } from './context.js';

export interface NewPageOptions {
  context?: OrbisContext | string;
  isolated?: boolean;
}

/**
 * ⬡ OrbisBrowser — Next-Gen Agentic Browser Engine (https://orbis.memora.company)
 * Powered by Memora Browser Engine (MBE) with multi-tab concurrency, isolated contexts,
 * native CDP, W3C WebDriver, and anti-detect stealth.
 */
export class OrbisBrowser {
  private pages: Map<string, OrbisPage> = new Map();
  private contexts: Map<string, OrbisContext> = new Map();
  private _defaultContext: OrbisContext | null = null;
  public readonly options: BrowserOptions;
  // One connection pool (direct + proxy agents) shared by every page
  public readonly pool: DispatcherPool;
  // High-concurrency safety threshold to prevent OOM
  public maxConcurrentPages: number = 100;
  public readonly recycleAfter: number = 0;
  private operationCount: number = 0;
  private lastActiveTimes: Map<string, number> = new Map();
  private vault: SessionVault | null = null;
  private blackboard: AgentBlackboard = new AgentBlackboard();

  constructor(options: BrowserOptions = {}) {
    this.options = {
      port: 9222,
      host: 'localhost',
      stealth: true,
      ...options,
    };
    this.options.network = {
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      ...(this.options.network || {}),
    };
    // BrowserOptions.timeout is the default navigation timeout unless network.timeoutMs is set
    if (this.options.timeout !== undefined && this.options.network.timeoutMs === undefined) {
      this.options.network.timeoutMs = this.options.timeout;
    }
    this.maxConcurrentPages = this.options.maxPages || 100;
    this.recycleAfter = this.options.recycleAfter || 0;
    this.pool = new DispatcherPool(this.options.network!);
  }

  /**
   * Primary shared context for default pages.
   */
  public get defaultContext(): OrbisContext {
    if (!this._defaultContext) {
      this._defaultContext = new OrbisContext(this, { id: 'default' });
      this.contexts.set(this._defaultContext.id, this._defaultContext);
    }
    return this._defaultContext;
  }

  /**
   * Create an isolated browser context with its own cookie jar, storage, and worker tabs.
   * Enables parallel multi-account sessions within the same browser instance.
   */
  public newContext(options: ContextOptions = {}): OrbisContext {
    const context = new OrbisContext(this, options);
    this.contexts.set(context.id, context);
    return context;
  }

  public getContext(id: string): OrbisContext | undefined {
    return this.contexts.get(id);
  }

  public listContexts(): OrbisContext[] {
    return Array.from(this.contexts.values());
  }

  public closeContext(id: string): boolean {
    const ctx = this.contexts.get(id);
    if (!ctx) return false;
    ctx.close();
    return true;
  }

  /**
   * Create a new page/tab.
   * - By default, opens in the `defaultContext` (sharing cookies with other default tabs).
   * - If `isolated: true`, automatically creates a fresh isolated context.
   * - If `context` is provided, binds the page to that specific context.
   */
  public newPage(options?: NewPageOptions): OrbisPage {
    if (this.pages.size >= this.maxConcurrentPages) {
      throw new Error(`Max concurrent pages limit (${this.maxConcurrentPages}) reached. Close inactive tabs before creating more.`);
    }

    let targetContext: OrbisContext;
    if (options?.isolated) {
      targetContext = this.newContext();
    } else if (options?.context) {
      if (typeof options.context === 'string') {
        targetContext = this.contexts.get(options.context) || this.newContext({ id: options.context });
      } else {
        targetContext = options.context;
      }
    } else {
      targetContext = this.defaultContext;
    }

    return targetContext.newPage();
  }

  public getPage(id: string): OrbisPage | undefined {
    return this.pages.get(id);
  }

  public closePage(id: string): boolean {
    const page = this.pages.get(id);
    if (!page) return false;
    page.close();
    return true;
  }

  public listPages(): OrbisPage[] {
    return Array.from(this.pages.values());
  }

  public get activePageCount(): number {
    return this.pages.size;
  }

  public get defaultPage(): OrbisPage {
    if (this.pages.size === 0) {
      return this.newPage();
    }
    return this.pages.values().next().value!;
  }

  public _registerPage(page: OrbisPage): void {
    this.pages.set(page.id, page);
    this.lastActiveTimes.set(page.id, Date.now());
  }

  public _unregisterPage(id: string): void {
    this.pages.delete(id);
    this.lastActiveTimes.delete(id);
  }

  public _unregisterContext(id: string): void {
    if (this._defaultContext?.id === id) {
      this._defaultContext = null;
    }
    this.contexts.delete(id);
  }

  /**
   * Touch a page timestamp to keep it active.
   */
  public touchPage(id: string): void {
    if (this.pages.has(id)) {
      this.lastActiveTimes.set(id, Date.now());
    }
  }

  /**
   * Close idle background pages that have been inactive longer than maxIdleMs.
   */
  public pruneIdlePages(maxIdleMs: number = 60000): number {
    const now = Date.now();
    let pruned = 0;
    const defaultId = this.pages.size > 0 ? this.pages.keys().next().value : null;
    for (const [id, lastTime] of Array.from(this.lastActiveTimes.entries())) {
      if (id !== defaultId && now - lastTime > maxIdleMs) {
        const page = this.pages.get(id);
        if (page) {
          page.close();
          pruned++;
        }
      }
    }
    return pruned;
  }

  /**
   * Record an operation towards the auto-recycle threshold.
   */
  public recordOperation(): void {
    this.operationCount++;
    if (this.recycleAfter > 0 && this.operationCount >= this.recycleAfter) {
      this.recycle();
    }
  }

  /**
   * Recycle memory: clean idle tabs, empty contexts, and run GC.
   */
  public recycle(): void {
    this.pruneIdlePages(30000);
    this.operationCount = 0;
    if (typeof (global as any).gc === 'function') {
      try { (global as any).gc(); } catch {}
    }
  }

  /**
   * Diagnostic memory metrics for monitoring and auto-scaling.
   */
  public getMemoryStats(): {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    activePages: number;
    activeContexts: number;
    operations: number;
  } {
    const mem = process.memoryUsage();
    return {
      rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
      activePages: this.pages.size,
      activeContexts: this.contexts.size,
      operations: this.operationCount
    };
  }

  /**
   * Terminate all contexts, pages, background timers, and the HTTP dispatcher pool.
   */
  public getVault(config?: SessionVaultConfig): SessionVault {
    if (!this.vault) {
      this.vault = new SessionVault(config);
    }
    return this.vault;
  }

  public getBlackboard(): AgentBlackboard {
    return this.blackboard;
  }

  public close(): void {
    for (const context of Array.from(this.contexts.values())) {
      context.close();
    }
    for (const page of Array.from(this.pages.values())) {
      page.close();
    }
    this.pages.clear();
    this.contexts.clear();
    this._defaultContext = null;
    this.pool.close().catch(() => {});
  }
}

/**
 * Backward compatibility alias: MemoraBrowser
 * @deprecated Please use `OrbisBrowser` directly.
 */
export const MemoraBrowser = OrbisBrowser;
export type MemoraBrowser = OrbisBrowser;
