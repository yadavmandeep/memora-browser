// Human handoff: when a site shows a CAPTCHA or bot check, open it in a visible Chrome window
// so a person can complete it, then let the agent continue in that same window.
//
// The agent never touches the window while a handoff is waiting: the handoff engine is only
// handed to the caller (take()) after the check is cleared. Nothing here clicks, types or solves.

import { ChromeEngine, findSystemChrome } from '../engine/chrome-engine.js';
import { NetworkOptions } from '../types/index.js';
import { ChallengeSignal } from './detector.js';

export const DEFAULT_HANDOFF_TIMEOUT_SEC = 300;

export type HandoffState = 'idle' | 'waiting' | 'resolved' | 'expired' | 'cancelled' | 'unavailable';

export interface HandoffStatus {
  state: HandoffState;
  url?: string;
  elapsedSec?: number;
  timeoutSec?: number;
  reason?: string;
  // What is on screen now (waiting) or after resolution
  signal?: ChallengeSignal | null;
}

export interface HandoffEngine {
  openForHuman(url: string): Promise<void>;
  currentChallenge(): Promise<ChallengeSignal | null>;
  readonly navigationCount: number;
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface HumanHandoffOptions {
  timeoutSec?: number;
  // Test seam; defaults to a visible ChromeEngine
  engineFactory?: (network: NetworkOptions) => HandoffEngine;
  // Test seam; defaults to hasDisplay() && a Chrome/Edge install
  available?: () => string | null;
}

// Linux servers and containers usually have no display to show a window on
export function hasDisplay(): boolean {
  if (process.platform === 'linux') return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
}

function defaultAvailability(): string | null {
  if (!hasDisplay()) return 'no display (headless server or container): a person cannot see a browser window here';
  if (!findSystemChrome()) return 'no Google Chrome or Microsoft Edge installation found';
  return null;
}

export class HumanHandoff<E extends HandoffEngine = ChromeEngine> {
  private engine: E | null = null;
  private state: HandoffState = 'idle';
  private url = '';
  private startedAt = 0;
  private startNavigations = 0;
  private initialBlocking = false;
  private lastSignal: ChallengeSignal | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private reason = '';
  public readonly timeoutSec: number;

  constructor(private readonly network: NetworkOptions, private readonly options: HumanHandoffOptions = {}) {
    this.timeoutSec = options.timeoutSec ?? DEFAULT_HANDOFF_TIMEOUT_SEC;
  }

  public get active(): boolean {
    return this.state === 'waiting';
  }

  // Opens the window. `initial` is the challenge that triggered the handoff (if known).
  public async start(url: string, initial: ChallengeSignal | null = null): Promise<HandoffStatus> {
    if (this.state === 'waiting' || this.state === 'resolved') return this.status();
    const unavailable = (this.options.available ?? defaultAvailability)();
    if (unavailable) {
      this.state = 'unavailable';
      this.reason = unavailable;
      return this.snapshot();
    }

    // The window must open even though the agent's engine is in cooldown / stop mode for this host
    const network: NetworkOptions = { ...this.network, onChallenge: 'report' };
    const factory = this.options.engineFactory ?? ((n: NetworkOptions): HandoffEngine => new ChromeEngine(n, { headless: false }));
    this.engine = factory(network) as E;
    this.url = url;
    this.reason = '';
    this.startedAt = Date.now();
    this.initialBlocking = initial?.blocking ?? true;
    this.lastSignal = initial;
    this.state = 'waiting';

    try {
      await this.engine.openForHuman(url);
    } catch (e: any) {
      this.state = 'unavailable';
      this.reason = `could not open a browser window: ${e?.message || e}`;
      await this.disposeEngine();
      return this.snapshot();
    }
    this.startNavigations = this.engine.navigationCount;

    this.expiryTimer = setTimeout(() => {
      if (this.state !== 'waiting') return;
      this.state = 'expired';
      this.reason = `not completed within ${this.timeoutSec}s`;
      this.disposeEngine();
    }, this.timeoutSec * 1000);
    this.expiryTimer.unref?.();

    return this.status();
  }

  // Non-blocking: inspects the window once and returns the current state
  public async status(): Promise<HandoffStatus> {
    if (this.state !== 'waiting' || !this.engine) return this.snapshot();

    if (this.engine.isClosed()) {
      this.finish('cancelled', 'the browser window was closed before the check was completed');
      return this.snapshot();
    }

    const signal = await this.engine.currentChallenge();
    this.lastSignal = signal;
    const blocking = signal?.blocking ?? false;
    let done: boolean;
    if (this.initialBlocking) {
      // Interstitial / block page / 429: done once it is gone
      done = !blocking;
    } else {
      // Embedded widget (e.g. login form with reCAPTCHA): done once the person submitted, the
      // page navigated, and it isn't the same widget page again (failed attempt)
      const navigated = this.engine.navigationCount > this.startNavigations;
      const sameWidgetAgain = signal?.kind === 'captcha' && signal.url === this.url;
      done = navigated && !blocking && !sameWidgetAgain;
    }
    if (done) {
      this.state = 'resolved';
      this.clearTimer();
    }
    return this.snapshot();
  }

  public async cancel(): Promise<HandoffStatus> {
    if (this.state === 'waiting') this.finish('cancelled', 'cancelled by the agent');
    return this.snapshot();
  }

  // Transfers the resolved window to the caller, who now owns (and must close) it
  public take(): E {
    if (this.state !== 'resolved' || !this.engine) throw new Error('Handoff is not resolved; nothing to take');
    const engine = this.engine;
    this.engine = null;
    this.state = 'idle';
    return engine;
  }

  public get resolvedSignal(): ChallengeSignal | null {
    return this.lastSignal;
  }

  public async close(): Promise<void> {
    this.clearTimer();
    await this.disposeEngine();
    this.state = 'idle';
  }

  private finish(state: 'cancelled' | 'expired', reason: string): void {
    this.state = state;
    this.reason = reason;
    this.clearTimer();
    void this.disposeEngine();
  }

  private async disposeEngine(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.close().catch(() => {});
  }

  private clearTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private snapshot(): HandoffStatus {
    const out: HandoffStatus = { state: this.state };
    if (this.url) out.url = this.url;
    if (this.startedAt && this.state !== 'unavailable') out.elapsedSec = Math.round((Date.now() - this.startedAt) / 1000);
    if (this.state === 'waiting') out.timeoutSec = this.timeoutSec;
    if (this.reason) out.reason = this.reason;
    if (this.state === 'waiting' || this.state === 'resolved') out.signal = this.lastSignal;
    return out;
  }
}
