import { MemoraBrowser } from '../engine/browser.js';
import { MemoraPage } from '../engine/page.js';
import { CDPServer } from '../cdp/server.js';
import {
  BrowserOptions,
  SemanticPageSnapshot,
  SnapshotOptions,
  PageDiff,
  FormFillOptions,
  SessionData
} from '../types/index.js';

export interface MemoraAgentOptions extends BrowserOptions {
  cdpPort?: number;
}

/**
 * ⚡ MemoraAgent — High-level 1-line Agent Controller
 * Provides seamless, high-velocity automation for LLM agents (LangChain, Stagehand, Browser-Use, etc.)
 */
export class MemoraAgent {
  public readonly browser: MemoraBrowser;
  public page: MemoraPage;
  public readonly cdpServer?: CDPServer;
  private isExternalCdp = false;
  private cdpHttpUrl?: string;

  constructor(browser: MemoraBrowser, page: MemoraPage, cdpServer?: CDPServer) {
    this.browser = browser;
    this.page = page;
    this.cdpServer = cdpServer;
  }

  /**
   * Launch a new local Memora browser instance and return an active agent controller.
   * Example:
   *   const agent = await MemoraAgent.launch({ stealth: true, cdpPort: 9222 });
   */
  public static async launch(options: MemoraAgentOptions = {}): Promise<MemoraAgent> {
    const port = options.cdpPort ?? options.port ?? 9222;
    const browser = new MemoraBrowser({
      port,
      stealth: options.stealth ?? true,
      ...options
    });
    const cdpServer = new CDPServer(browser);
    await cdpServer.start();
    const page = browser.newPage();
    const agent = new MemoraAgent(browser, page, cdpServer);
    agent.cdpHttpUrl = `http://127.0.0.1:${port}`;
    return agent;
  }

  /**
   * Connect to an existing running Memora CDP endpoint over HTTP / WebSocket.
   * Example:
   *   const agent = await MemoraAgent.connect('http://127.0.0.1:9222');
   */
  public static async connect(cdpUrl: string = 'http://127.0.0.1:9222'): Promise<MemoraAgent> {
    const parsed = new URL(cdpUrl);
    const versionRes = await fetch(`${parsed.origin}/json/version`);
    if (!versionRes.ok) {
      throw new Error(`Failed to connect to Memora CDP at ${cdpUrl}: HTTP ${versionRes.status}`);
    }
    const browser = new MemoraBrowser({ port: Number(parsed.port) || 9222, host: parsed.hostname });
    const page = browser.newPage();
    const agent = new MemoraAgent(browser, page);
    agent.isExternalCdp = true;
    agent.cdpHttpUrl = parsed.origin;
    return agent;
  }

  /**
   * Navigate to target URL and return distilled semantic snapshot.
   */
  public async goto(url: string, options: SnapshotOptions = {}): Promise<SemanticPageSnapshot> {
    await this.page.goto(url);
    return this.page.getSemanticSnapshot(options);
  }

  /**
   * Get semantic AXTree snapshot with numbered interactive actions (@1, @2, ...).
   */
  public snapshot(options: SnapshotOptions = {}): SemanticPageSnapshot {
    return this.page.getSemanticSnapshot(options);
  }

  /**
   * Return token-optimized clean Markdown.
   */
  public markdown(options: SnapshotOptions = {}): string {
    return this.page.getMarkdown(options);
  }

  /**
   * Compute token-efficient diff against previous page state.
   */
  public diff(options: SnapshotOptions = {}): PageDiff {
    return this.page.diff(undefined, options);
  }

  /**
   * Execute an interaction by action ID (e.g. '@1', '@2') or CSS selector.
   */
  public act(actionId: string, text?: string): boolean {
    if (text !== undefined) {
      return this.page.type(actionId, text);
    }
    return this.page.click(actionId);
  }

  /**
   * Fill out an entire form in a single atomic turn and optionally submit.
   */
  public async fillForm(fields: Record<string, string>, submit: boolean = true) {
    return this.page.fillForm({
      fields,
      submit
    });
  }

  /**
   * Speculatively fork the current page in < 1ms to test alternative paths without network cost.
   */
  public fork(): MemoraAgent {
    const forkedPage = this.page.fork();
    return new MemoraAgent(this.browser, forkedPage, this.cdpServer);
  }

  /**
   * Export the current session (cookies, localStorage, sessionStorage) to a JSON file.
   */
  public saveSession(filePath: string): void {
    this.page.saveSession(filePath);
  }

  /**
   * Restore a previously saved session from a JSON file.
   */
  public loadSession(filePath: string): void {
    this.page.loadSession(filePath);
  }

  /**
   * Dump raw session state object.
   */
  public dumpSession(): SessionData {
    return this.page.dumpSession();
  }

  /**
   * Return CDP connection URLs for Playwright, Stagehand, or Browser-Use.
   */
  public get cdpEndpoint(): string {
    return this.cdpHttpUrl || `http://127.0.0.1:${this.browser.options.port || 9222}`;
  }

  /**
   * Close the agent and underlying browser resources.
   */
  public async close(): Promise<void> {
    this.page.close();
    if (!this.isExternalCdp) {
      if (this.cdpServer) {
        await this.cdpServer.close();
      }
      this.browser.close();
    }
  }
}

/**
 * 🪐 OrbisAgent — Autonomous Task Runner & Agent Controller
 * Built into Orbis by Memora (https://orbis.memora.company).
 */
export const OrbisAgent = MemoraAgent;
export type OrbisAgent = MemoraAgent;
export type OrbisAgentOptions = MemoraAgentOptions;
