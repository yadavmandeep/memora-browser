import { MemoraPage } from './page.js';
import { BrowserOptions } from '../types/index.js';
import { DispatcherPool } from '../network/proxy.js';

export class MemoraBrowser {
  private pages: Map<string, MemoraPage> = new Map();
  public readonly options: BrowserOptions;
  // One connection pool (direct + proxy agents) shared by every page
  private readonly pool: DispatcherPool;

  constructor(options: BrowserOptions = {}) {
    this.options = {
      port: 9222,
      host: '127.0.0.1',
      stealth: true,
      ...options,
    };
    this.options.network = {
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      ...(this.options.network || {}),
    };
    this.pool = new DispatcherPool(this.options.network!);
  }

  public newPage(): MemoraPage {
    const page = new MemoraPage(this.options.stealth !== false, this.options.network, this.pool);
    this.pages.set(page.id, page);
    return page;
  }

  public getPage(id: string): MemoraPage | undefined {
    return this.pages.get(id);
  }

  public closePage(id: string): boolean {
    // Stop the page's timers / in-flight requests
    this.pages.get(id)?.close();
    return this.pages.delete(id);
  }

  public listPages(): MemoraPage[] {
    return Array.from(this.pages.values());
  }

  public get defaultPage(): MemoraPage {
    if (this.pages.size === 0) {
      return this.newPage();
    }
    return this.pages.values().next().value!;
  }

  public close(): void {
    for (const page of this.pages.values()) page.close();
    this.pages.clear();
    this.pool.close().catch(() => {});
  }
}
