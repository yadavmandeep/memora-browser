import type { SemanticPageSnapshot, SnapshotOptions, PageDiff } from '../types/index.js';
import { FirewallBlockedError } from '../firewall/errors.js';
import { ChallengeDetectedError } from '../challenge/errors.js';
import { ChallengeCooldownError } from '../challenge/cooldown.js';

export interface RemoteAgentOptions {
  apiKey?: string;
  // Page (tab) id on the daemon; default: the daemon's default page
  pageId?: string;
  // Milliseconds to wait for each call; longer than the daemon's own 20 s navigation timeout
  timeoutMs?: number;
}

export class RemoteOrbisError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly body?: any) {
    super(message);
    this.name = 'RemoteOrbisError';
  }
}

/**
 * Drives a running Orbis daemon (`orbis --port 9222`) over its HTTP API. Returned by OrbisAgent.connect().
 * Everything happens in the daemon: pages, cookies and storage live there, not in this process.
 * Every method is async because each one is a network call.
 */
export class RemoteOrbisAgent {
  public readonly endpoint: string;
  public pageId?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(endpoint: string, options: RemoteAgentOptions = {}) {
    this.endpoint = new URL(endpoint).origin;
    this.apiKey = options.apiKey || process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY;
    this.pageId = options.pageId;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) {
      h['x-api-key'] = this.apiKey;
      h['authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async call(method: 'GET' | 'POST', path: string, query: Record<string, string | undefined> = {}, body?: any, raw = false): Promise<any> {
    const u = new URL(path, this.endpoint);
    for (const [k, v] of Object.entries({ ...query, id: query.id ?? this.pageId })) if (v !== undefined) u.searchParams.set(k, v);
    const res = await fetch(u, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify({ ...body, id: body.id ?? this.pageId }) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (res.ok) return raw ? text : JSON.parse(text || '{}');
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {}
    const msg = data.error || `HTTP ${res.status} from ${u.pathname}`;
    if (data.code === 'ERR_FIREWALL_BLOCKED') throw new FirewallBlockedError(msg, data.rule || 'domain', { url: data.url });
    if (data.code === 'ERR_CHALLENGE_DETECTED' && data.challenge) throw new ChallengeDetectedError(data.challenge, data.cooldownSec ?? 0);
    if (data.code === 'ERR_CHALLENGE_COOLDOWN' && data.challenge) throw new ChallengeCooldownError(data.host || '', data.remainingSec ?? 0, data.challenge);
    throw new RemoteOrbisError(msg, res.status, data.code, data);
  }

  private snapshotQuery(options: SnapshotOptions = {}): Record<string, string | undefined> {
    return { focus: options.focusSelector, exclude: options.excludeSelectors?.join(',') };
  }

  /** Navigate the daemon's page and return its snapshot. */
  public async goto(url: string, _options: SnapshotOptions = {}): Promise<SemanticPageSnapshot & { status: number; challenge?: any }> {
    const r = await this.call('GET', '/orbis/goto', { url });
    return { ...r.snapshot, status: r.status, challenge: r.challenge };
  }

  public async snapshot(options: SnapshotOptions = {}): Promise<SemanticPageSnapshot> {
    return this.call('GET', '/orbis/snapshot', this.snapshotQuery(options));
  }

  public async markdown(options: SnapshotOptions = {}): Promise<string> {
    return this.call('GET', '/orbis/snapshot', { ...this.snapshotQuery(options), format: 'markdown' }, undefined, true);
  }

  public async diff(options: SnapshotOptions = {}): Promise<PageDiff> {
    const r = await this.call('GET', '/orbis/diff', this.snapshotQuery(options));
    return r.diff ?? r;
  }

  /** Click (no text) or type (text given). A click follows links and submits forms. */
  public async act(actionId: string, text?: string): Promise<boolean> {
    const r = await this.call('POST', '/orbis/act', {}, text !== undefined ? { actionId, type: 'type', text } : { actionId, type: 'click' });
    return !!r.success;
  }

  public async fillForm(fields: Record<string, string>, submit: boolean | string = false) {
    return this.call('POST', '/orbis/fill-form', {}, { fields, submit });
  }

  public async selectOption(target: string, valueOrText: string): Promise<boolean> {
    const r = await this.call('POST', '/orbis/select-option', {}, { target, value: valueOrText });
    return !!r.success;
  }

  /** Save the daemon page's session to a file on the daemon's machine (inside its session folder). */
  public async saveSession(filePath: string): Promise<void> {
    await this.call('POST', '/orbis/session/save', {}, { filePath });
  }

  public async loadSession(filePath: string): Promise<void> {
    await this.call('POST', '/orbis/session', {}, { filePath });
  }

  /** CDP endpoint of the daemon, for Playwright / Puppeteer. */
  public get cdpEndpoint(): string {
    return this.endpoint;
  }

  /** Ends this client. The daemon and its pages keep running. */
  public async close(): Promise<void> {}
}
