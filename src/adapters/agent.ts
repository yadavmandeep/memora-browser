import { OrbisBrowser, MemoraBrowser } from '../engine/browser.js';
import { MemoraPage, OrbisPage } from '../engine/page.js';
import { CDPServer } from '../cdp/server.js';
import {
  BrowserOptions,
  SemanticPageSnapshot,
  SnapshotOptions,
  PageDiff,
  FormFillOptions,
  SessionData
} from '../types/index.js';

export interface OrbisAgentOptions extends BrowserOptions {
  cdpPort?: number;
}

export type MemoraAgentOptions = OrbisAgentOptions;

/**
 * 🪐 OrbisAgent — Autonomous Task Runner & High-Velocity Agent Controller
 * Official Agent SDK for Orbis by Memora (https://orbis.memora.company).
 * Provides seamless 1-line automation for LLM agents (LangChain, Stagehand, Browser-Use, etc.)
 */
export class OrbisAgent {
  public readonly browser: OrbisBrowser;
  public page: OrbisPage;
  public readonly cdpServer?: CDPServer;
  public apiKey?: string;
  private isExternalCdp = false;
  private cdpHttpUrl?: string;

  constructor(browser: OrbisBrowser, page: OrbisPage, cdpServer?: CDPServer) {
    this.browser = browser;
    this.page = page;
    this.cdpServer = cdpServer;
  }

  /**
   * Launch a new local Orbis browser instance and return an active agent controller.
   * Example:
   *   const agent = await OrbisAgent.launch({ stealth: true, cdpPort: 9222 });
   */
  public static async launch(options: OrbisAgentOptions = {}): Promise<OrbisAgent> {
    const port = options.cdpPort ?? options.port ?? 9222;
    const apiKey = options.apiKey || process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY;
    const browser = new OrbisBrowser({
      port,
      stealth: options.stealth ?? true,
      apiKey,
      ...options
    });
    const cdpServer = new CDPServer(browser);
    await cdpServer.start();
    const page = browser.newPage();
    const agent = new OrbisAgent(browser, page, cdpServer);
    agent.cdpHttpUrl = `http://localhost:${port}`;
    agent.apiKey = apiKey;
    return agent;
  }

  /**
   * Connect to an existing running Orbis CDP endpoint over HTTP / WebSocket.
   * Example:
   *   const agent = await OrbisAgent.connect('http://localhost:9222', { apiKey: '...' });
   */
  public static async connect(cdpUrl: string = 'http://localhost:9222', options: { apiKey?: string } = {}): Promise<OrbisAgent> {
    const parsed = new URL(cdpUrl);
    const apiKey = options.apiKey || process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const versionRes = await fetch(`${parsed.origin}/json/version`, { headers });
    if (!versionRes.ok) {
      throw new Error(`Failed to connect to Orbis CDP at ${cdpUrl}: HTTP ${versionRes.status}`);
    }
    const browser = new OrbisBrowser({ port: Number(parsed.port) || 9222, host: parsed.hostname, apiKey });
    const page = browser.newPage();
    const agent = new OrbisAgent(browser, page);
    agent.isExternalCdp = true;
    agent.cdpHttpUrl = parsed.origin;
    agent.apiKey = apiKey;
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
   * Execute an interaction by action ID (e.g. '@1', '@email'), Playwright locator (label:, text=, placeholder:), XPath, or CSS selector.
   */
  public act(actionId: string, text?: string): boolean {
    if (text !== undefined) {
      return this.page.type(actionId, text);
    }
    return this.page.click(actionId);
  }

  /**
   * Select a dropdown option by label, value, or option index on <select> or ARIA listboxes.
   * Example:
   *   agent.selectOption('#country', 'India');
   *   agent.selectOption('@4', 'India');
   *   agent.selectOption('label:Country', 'India');
   */
  public selectOption(target: string, valueOrText: string): boolean {
    return this.page.selectDropdownOption(target, valueOrText);
  }

  /**
   * Fill out an entire form in a single atomic turn and optionally submit.
   * Supports @IDs, semantic aliases (@email), CSS selectors, labels (label:Email), and placeholders.
   */
  public async fillForm(fields: Record<string, string>, submit: boolean | string = true) {
    return this.page.fillForm({
      fields,
      submit
    });
  }

  /**
   * Speculatively fork the current page in < 1ms to test alternative paths without network cost.
   */
  public fork(): OrbisAgent {
    const forkedPage = this.page.fork();
    return new OrbisAgent(this.browser, forkedPage, this.cdpServer);
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
    return this.cdpHttpUrl || `http://localhost:${this.browser.options.port || 9222}`;
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
 * Backward compatibility alias: MemoraAgent
 * @deprecated Please use `OrbisAgent` directly.
 */
export const MemoraAgent = OrbisAgent;
export type MemoraAgent = OrbisAgent;
