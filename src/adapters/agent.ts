import { OrbisBrowser, MemoraBrowser } from '../engine/browser.js';
import { MemoraPage, OrbisPage } from '../engine/page.js';
import { OrbisContext, ContextOptions } from '../engine/context.js';
import { CDPServer } from '../cdp/server.js';
import { RemoteOrbisAgent, RemoteAgentOptions } from './remote-agent.js';
import type { ChallengeSignal } from '../challenge/detector.js';
import { PromptFirewall, ActionRequest, ConfirmHandler, ContentResult } from '../firewall/firewall.js';
import type { Capability, FirewallPolicyInput, FirewallPreset } from '../firewall/policy.js';
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
  // Prompt-injection firewall: preset name, policy, or a ready PromptFirewall. Omitted: off.
  firewall?: FirewallPreset | FirewallPolicyInput | PromptFirewall;
  // Asked for actions the policy marks "confirm". Must reach a person. Without it those actions are refused.
  onConfirm?: ConfirmHandler;
}

export interface ObserveOptions extends SnapshotOptions {
  // Max characters of page Markdown included (default 4000)
  maxContentChars?: number;
}

export type MemoraAgentOptions = OrbisAgentOptions;

/**
 * ⬡ OrbisAgent — Autonomous Task Runner & High-Velocity Agent Controller
 * Official Agent SDK for Orbis by Memora (https://orbis.memora.company).
 * Provides seamless 1-line automation for LLM agents (LangChain, Stagehand, Browser-Use, etc.)
 */
export class OrbisAgent {
  public readonly browser: OrbisBrowser;
  public page: OrbisPage;
  public readonly cdpServer?: CDPServer;
  public apiKey?: string;
  // Off unless launched with `firewall`. Domain rules are enforced by the browser's network layer;
  // action gates and content isolation by the methods below.
  public firewall: PromptFirewall = PromptFirewall.from(null);
  public onConfirm?: ConfirmHandler;
  private isExternalCdp = false;
  // A fork shares its parent's browser and CDP server: closing it closes only its own page
  private isFork = false;
  private cdpHttpUrl?: string;

  constructor(browser: OrbisBrowser, page: OrbisPage, cdpServer?: CDPServer) {
    this.browser = browser;
    this.page = page;
    this.cdpServer = cdpServer;
  }

  private request(tool: string, capability: Capability, extra: Partial<ActionRequest> = {}): ActionRequest {
    return { tool, capability, url: this.page.url !== 'about:blank' ? this.page.url : undefined, ...extra };
  }

  // A click on a submit button inside a form submits it
  private clickCapability(target: string): Capability {
    let el = null;
    try {
      el = this.page.resolveElement(target);
    } catch {}
    if (!el || !this.page.formOwner(el)) return 'interact';
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    return (tag === 'button' && (!type || type === 'submit')) || (tag === 'input' && (type === 'submit' || type === 'image')) ? 'submit' : 'interact';
  }

  private async guarded<T>(req: ActionRequest, run: () => Promise<T> | T): Promise<T> {
    if (!this.firewall.enabled) return run();
    const decision = await this.firewall.authorize(req, this.onConfirm);
    const t0 = performance.now();
    try {
      const out = await run();
      this.firewall.recordResult(req, decision, { ok: true, durationMs: performance.now() - t0 });
      return out;
    } catch (e: any) {
      this.firewall.recordResult(req, decision, { ok: false, error: e?.message || String(e), durationMs: performance.now() - t0 });
      throw e;
    }
  }

  private guardedSync<T>(req: ActionRequest, run: () => T): T {
    if (!this.firewall.enabled) return run();
    const decision = this.firewall.authorizeSync(req, this.onConfirm);
    const t0 = performance.now();
    try {
      const out = run();
      this.firewall.recordResult(req, decision, { ok: true, durationMs: performance.now() - t0 });
      return out;
    } catch (e: any) {
      this.firewall.recordResult(req, decision, { ok: false, error: e?.message || String(e), durationMs: performance.now() - t0 });
      throw e;
    }
  }

  /**
   * Launch a new local Orbis browser instance and return an active agent controller.
   * Example:
   *   const agent = await OrbisAgent.launch({ stealth: true, cdpPort: 9222 });
   */
  public static async launch(options: OrbisAgentOptions = {}): Promise<OrbisAgent> {
    const port = options.cdpPort ?? options.port ?? 9222;
    const apiKey = options.apiKey || process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY;
    const firewall = PromptFirewall.from(options.firewall);
    const browser = new OrbisBrowser({
      port,
      stealth: options.stealth ?? true,
      apiKey,
      ...options,
      network: firewall.applyToNetwork(options.network),
    });
    const cdpServer = new CDPServer(browser);
    await cdpServer.start();
    const page = browser.newPage();
    const agent = new OrbisAgent(browser, page, cdpServer);
    agent.cdpHttpUrl = `http://localhost:${port}`;
    agent.apiKey = apiKey;
    agent.firewall = firewall;
    agent.onConfirm = options.onConfirm;
    return agent;
  }

  /**
   * Connect to an existing running Orbis CDP endpoint over HTTP / WebSocket.
   * Example:
   *   const agent = await OrbisAgent.connect('http://localhost:9222', { apiKey: '...' });
   */
  // 0.2.0: returns a RemoteOrbisAgent that drives the daemon itself (before, it ran a local browser).
  public static async connect(cdpUrl: string = 'http://localhost:9222', options: RemoteAgentOptions = {}): Promise<RemoteOrbisAgent> {
    const remote = new RemoteOrbisAgent(cdpUrl, options);
    const apiKey = options.apiKey || process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const versionRes = await fetch(`${remote.endpoint}/json/version`, { headers });
    if (!versionRes.ok) {
      throw new Error(`Failed to connect to Orbis at ${cdpUrl}: HTTP ${versionRes.status}`);
    }
    return remote;
  }

  /**
   * Navigate to target URL and return distilled semantic snapshot.
   */
  public async goto(url: string, options: SnapshotOptions = {}): Promise<SemanticPageSnapshot> {
    await this.guarded(this.request('goto', 'navigate', { url }), () => this.page.goto(url));
    return this.page.getSemanticSnapshot(options);
  }

  /**
   * The current page as text for an LLM prompt: title, URL, action map and Markdown. With the firewall
   * on, invisible characters are stripped, injection phrases flagged or removed, and the whole text
   * fenced as untrusted data. `findings` lists what the scanner matched.
   */
  public observe(options: ObserveOptions = {}): ContentResult {
    const snap = this.page.getSemanticSnapshot(options);
    const max = options.maxContentChars ?? 4000;
    const text = [
      `# ${snap.title}`,
      `URL: ${snap.url}`,
      '',
      snap.actionMapText,
      '',
      '--- Page Content ---',
      snap.markdown.slice(0, max) + (snap.markdown.length > max ? '\n... [content truncated]' : ''),
    ].join('\n');
    return this.firewall.processContent(text, { source: snap.url, tool: 'observe', html: this.firewall.policy.content.scanHidden ? this.page.content() : undefined });
  }

  /**
   * CAPTCHA / bot-check / rate-limit signal from the last navigation, or null.
   * Orbis detects these but never solves them; `blocking: true` means the page content is not the real page.
   */
  public challenge(): ChallengeSignal | null {
    return this.page.challenge();
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
  // 0.2.0: async, so that a click can follow a link or submit a form. Resolves false when the target is not found.
  public async act(actionId: string, text?: string): Promise<boolean> {
    const capability = text !== undefined ? 'interact' : this.clickCapability(actionId);
    return this.guarded(this.request('act', capability, { target: actionId, args: { actionId, text } }), async () =>
      text !== undefined ? this.page.type(actionId, text) : this.page.click(actionId));
  }

  /**
   * Alias of act(), kept for code written against 0.2.0 pre-releases.
   */
  public async actAsync(actionId: string, text?: string): Promise<boolean> {
    return this.act(actionId, text);
  }

  /**
   * Select a dropdown option by label, value, or option index on <select> or ARIA listboxes.
   * Example:
   *   agent.selectOption('#country', 'India');
   *   agent.selectOption('@4', 'India');
   *   agent.selectOption('label:Country', 'India');
   */
  public selectOption(target: string, valueOrText: string): boolean {
    return this.guardedSync(this.request('selectOption', 'interact', { target, args: { target, value: valueOrText } }), () =>
      this.page.selectDropdownOption(target, valueOrText));
  }

  /**
   * Fill out an entire form in a single atomic turn and optionally submit.
   * Supports @IDs, semantic aliases (@email), CSS selectors, labels (label:Email), and placeholders.
   */
  // 0.2.0: does not submit unless `submit` is true or names the submit button
  public async fillForm(fields: Record<string, string>, submit: boolean | string = false) {
    const req = this.request('fillForm', submit ? 'submit' : 'interact', { args: { fields, submit } });
    return this.guarded(req, () => this.page.fillForm({
      fields,
      submit
    }));
  }

  /**
   * List all active browser tabs.
   */
  public get tabs(): OrbisPage[] {
    return this.browser.listPages();
  }

  /**
   * Open a new tab in the agent's browser session.
   * If `isolated: true`, tab runs in a dedicated browser context with separate cookies.
   */
  public async newTab(url?: string, options?: { isolated?: boolean; switch?: boolean }): Promise<OrbisPage> {
    const page = this.browser.newPage({ isolated: options?.isolated });
    if (options?.switch !== false) {
      this.page = page;
    }
    if (url) {
      await page.goto(url);
    }
    return page;
  }

  /**
   * Switch the agent's active working page/tab.
   */
  public switchTab(tabIdOrIndex: string | number): OrbisPage {
    const pages = this.browser.listPages();
    let target: OrbisPage | undefined;
    if (typeof tabIdOrIndex === 'number') {
      target = pages[tabIdOrIndex];
    } else {
      target = this.browser.getPage(tabIdOrIndex);
    }
    if (!target) {
      throw new Error(`Tab not found: ${tabIdOrIndex}`);
    }
    this.page = target;
    return target;
  }

  /**
   * Close a specific tab (or the current active tab) and cleanly reclaim memory.
   */
  public closeTab(tabId?: string): boolean {
    const targetId = tabId || this.page.id;
    const closed = this.browser.closePage(targetId);
    if (this.page.id === targetId) {
      const remaining = this.browser.listPages();
      if (remaining.length > 0) {
        this.page = remaining[remaining.length - 1];
      }
    }
    return closed;
  }

  /**
   * Create an isolated context for a parallel worker agent with separate cookies and storage.
   */
  public newContext(options?: ContextOptions): OrbisContext {
    return this.browser.newContext(options);
  }

  /**
   * Speculatively fork the current page in < 1ms to test alternative paths without network cost.
   */
  public fork(): OrbisAgent {
    const forkedPage = this.page.fork();
    const forked = new OrbisAgent(this.browser, forkedPage, this.cdpServer);
    forked.isFork = true;
    forked.firewall = this.firewall;
    forked.onConfirm = this.onConfirm;
    return forked;
  }

  /**
   * Export the current session (cookies, localStorage, sessionStorage) to a JSON file.
   */
  public saveSession(filePath: string): void {
    this.guardedSync(this.request('saveSession', 'session', { args: { action: 'save', path: filePath } }), () => this.page.saveSession(filePath));
  }

  /**
   * Restore a previously saved session from a JSON file.
   */
  public loadSession(filePath: string): void {
    this.guardedSync(this.request('loadSession', 'session', { args: { action: 'load', path: filePath } }), () => this.page.loadSession(filePath));
  }

  /**
   * Dump raw session state object.
   */
  public dumpSession(): SessionData {
    return this.guardedSync(this.request('dumpSession', 'session'), () => this.page.dumpSession());
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
    if (this.isFork) {
      this.browser.closePage(this.page.id);
      return;
    }
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
