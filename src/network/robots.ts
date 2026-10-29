// robots.txt support (RFC 9309), opt-in with --obey-robots.
//
// - One robots.txt fetch per origin per session, shared by every page (RobotsStore).
// - Concurrent requests to the same origin wait on a single in-flight fetch ("singleflight").
// - Every request is checked, subresources and page fetch()/XHR included.
// - Status handling per RFC 9309 §2.3.1: 2xx → parse, 4xx → allow all,
//   5xx / network error → disallow all.

import { fetch as undiciFetch, type Dispatcher } from './undici.js';

export const DEFAULT_ROBOTS_AGENT = 'MemoraBrowser';

// RFC 9309 §2.5: parse at least 500 KiB
const MAX_ROBOTS_BYTES = 500 * 1024;
// RFC 9309 §2.4: don't use a cached copy for more than 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export class RobotsBlockedError extends Error {
  public readonly code = 'ERR_BLOCKED_BY_ROBOTS';
  constructor(public readonly url: string, public readonly robotsUrl: string) {
    super(`Blocked by robots.txt: ${url} (rules from ${robotsUrl})`);
    this.name = 'RobotsBlockedError';
  }
}

// Percent-encoding normalisation (RFC 9309 §2.2.2): encode octets that need it,
// upper-case existing escapes and decode escapes of unreserved characters.
function normalize(path: string): string {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(path.slice(i + 1, i + 3))) {
      const hex = path.slice(i + 1, i + 3).toUpperCase();
      const decoded = String.fromCharCode(parseInt(hex, 16));
      out += /[A-Za-z0-9\-._~]/.test(decoded) ? decoded : `%${hex}`;
      i += 2;
    } else if (/[\x21-\x7E]/.test(ch)) {
      out += ch;
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

// "*" matches any sequence; a trailing "$" anchors the end of the path.
function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

export class RobotsRules {
  constructor(private readonly groups: Group[], private readonly mode: 'rules' | 'allow-all' | 'disallow-all') {}

  static allowAll(): RobotsRules {
    return new RobotsRules([], 'allow-all');
  }

  static disallowAll(): RobotsRules {
    return new RobotsRules([], 'disallow-all');
  }

  static parse(text: string): RobotsRules {
    const groups: Group[] = [];
    let current: Group | null = null;
    let lastWasAgent = false;

    for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (key === 'user-agent') {
        // Consecutive user-agent lines share one group
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
      } else if (key === 'allow' || key === 'disallow') {
        lastWasAgent = false;
        // Rules before any user-agent line, and empty rules, have no effect
        if (!current || value === '') continue;
        const pattern = normalize(value);
        current.rules.push({ allow: key === 'allow', pattern, regex: compile(pattern) });
      } else {
        // sitemap, crawl-delay and unknown keys don't end a run of user-agent lines
      }
    }
    return new RobotsRules(groups, 'rules');
  }

  // Rules for an agent: every group naming the product token (case-insensitive),
  // otherwise every "*" group, combined (RFC 9309 §2.2.1).
  private rulesFor(agent: string): Rule[] {
    const token = agent.toLowerCase();
    const named = this.groups.filter(g => g.agents.includes(token));
    const chosen = named.length ? named : this.groups.filter(g => g.agents.includes('*'));
    return chosen.flatMap(g => g.rules);
  }

  public isAllowed(url: string, agent: string = DEFAULT_ROBOTS_AGENT): boolean {
    if (this.mode === 'allow-all') return true;
    if (this.mode === 'disallow-all') return false;

    const { pathname, search } = new URL(url);
    if (pathname === '/robots.txt') return true;
    const path = normalize(pathname + search);

    // Longest matching pattern wins; on a tie, allow wins (§2.2.2)
    let best: Rule | null = null;
    for (const rule of this.rulesFor(agent)) {
      if (!rule.regex.test(path)) continue;
      if (
        !best ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
    return best ? best.allow : true;
  }
}

export interface RobotsStoreOptions {
  agent?: string;
  userAgent?: string;
  dispatcherFor?: (url: string) => Dispatcher;
  // Called once per blocked request; defaults to a warning on stderr
  onBlocked?: (url: string, robotsUrl: string) => void;
}

// Session cache of parsed robots.txt files, keyed by origin.
export class RobotsStore {
  public readonly agent: string;
  private readonly cache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<RobotsRules>>();
  public fetchCount = 0;

  constructor(private readonly options: RobotsStoreOptions = {}) {
    this.agent = options.agent || DEFAULT_ROBOTS_AGENT;
  }

  public static robotsUrlFor(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/robots.txt`;
  }

  public async rulesFor(url: string): Promise<RobotsRules> {
    const robotsUrl = RobotsStore.robotsUrlFor(url);
    if (!robotsUrl) return RobotsRules.allowAll();

    const cached = this.cache.get(robotsUrl);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rules;

    // Singleflight: requests to the same origin share one robots.txt fetch
    let pending = this.inflight.get(robotsUrl);
    if (!pending) {
      pending = this.load(robotsUrl).finally(() => this.inflight.delete(robotsUrl));
      this.inflight.set(robotsUrl, pending);
    }
    return pending;
  }

  public async isAllowed(url: string): Promise<boolean> {
    const rules = await this.rulesFor(url);
    return rules.isAllowed(url, this.agent);
  }

  // Throws RobotsBlockedError when the URL is disallowed for this agent.
  public async check(url: string): Promise<void> {
    if (await this.isAllowed(url)) return;
    const robotsUrl = RobotsStore.robotsUrlFor(url)!;
    if (this.options.onBlocked) this.options.onBlocked(url, robotsUrl);
    else process.stderr.write(`[Memora] blocked by robots.txt: ${url}\n`);
    throw new RobotsBlockedError(url, robotsUrl);
  }

  private async load(robotsUrl: string): Promise<RobotsRules> {
    this.fetchCount++;
    let rules: RobotsRules;
    try {
      const resp = await undiciFetch(robotsUrl, {
        headers: this.options.userAgent ? { 'User-Agent': this.options.userAgent } : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        dispatcher: this.options.dispatcherFor?.(robotsUrl),
      });
      if (resp.status >= 200 && resp.status < 300) {
        rules = RobotsRules.parse(await resp.text());
      } else if (resp.status >= 400 && resp.status < 500) {
        await resp.body?.cancel().catch(() => {});
        rules = RobotsRules.allowAll();
      } else {
        await resp.body?.cancel().catch(() => {});
        rules = RobotsRules.disallowAll();
      }
    } catch {
      // Unreachable: assume complete disallow
      rules = RobotsRules.disallowAll();
    }
    this.cache.set(robotsUrl, { rules, fetchedAt: Date.now() });
    return rules;
  }
}
