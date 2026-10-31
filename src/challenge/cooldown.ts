import type { ChallengeSignal } from './detector.js';

export const DEFAULT_CHALLENGE_COOLDOWN_SEC = 60;
const MAX_COOLDOWN_SEC = 3600;

export class ChallengeCooldownError extends Error {
  public readonly code = 'ERR_CHALLENGE_COOLDOWN';
  constructor(public readonly host: string, public readonly remainingSec: number, public readonly signal: ChallengeSignal) {
    super(
      `Requests to ${host} are paused for ${remainingSec}s after a ${signal.vendor} ${signal.kind} (HTTP ${signal.status}). ` +
      'Orbis does not retry around challenges; wait and try again later.'
    );
    this.name = 'ChallengeCooldownError';
  }
}

// After a blocking challenge or a 429, further requests to that host fail fast instead of
// hitting the site again. Uses Retry-After when the site sends one.
export class ChallengeCooldown {
  private entries: Map<string, { until: number; signal: ChallengeSignal }> = new Map();

  constructor(private readonly defaultSec: number = DEFAULT_CHALLENGE_COOLDOWN_SEC) {}

  public get enabled(): boolean {
    return this.defaultSec > 0;
  }

  // Returns the cooldown applied in seconds (0 when none)
  public record(signal: ChallengeSignal | null): number {
    if (!signal || !signal.blocking || !this.enabled) return 0;
    const host = hostOf(signal.url);
    if (!host) return 0;
    const sec = Math.min(MAX_COOLDOWN_SEC, Math.max(1, signal.retryAfterSec ?? this.defaultSec));
    this.entries.set(host, { until: Date.now() + sec * 1000, signal });
    return sec;
  }

  public assertClear(url: string): void {
    const host = hostOf(url);
    if (!host) return;
    const entry = this.entries.get(host);
    if (!entry) return;
    const remainingMs = entry.until - Date.now();
    if (remainingMs <= 0) {
      this.entries.delete(host);
      return;
    }
    throw new ChallengeCooldownError(host, Math.ceil(remainingMs / 1000), entry.signal);
  }

  public clear(): void {
    this.entries.clear();
  }
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
