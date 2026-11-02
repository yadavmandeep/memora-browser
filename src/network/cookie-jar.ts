/**
 * ⬡ Orbis CookieJar — per-context cookie store.
 * Cookies are scoped like a browser does it (RFC 6265 subset): a cookie set by one site is only sent back
 * to that site (host-only, or the Domain it named), under its Path, over https when Secure, until it expires.
 */

export interface StoredCookie {
  name: string;
  value: string;
  // Host the cookie belongs to. Empty = legacy unscoped cookie (only from old session files / old APIs).
  domain: string;
  // true: only this exact host. false: domain and its subdomains (a Domain= attribute was given)
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  // Unix ms; undefined = session cookie
  expires?: number;
}

export interface CookieScope {
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  if (!domain) return true; // legacy unscoped
  if (hostOnly || isIpLiteral(host)) return host === domain;
  return host === domain || host.endsWith('.' + domain);
}

function defaultPath(url: string): string {
  try {
    const p = new URL(url).pathname;
    if (!p.startsWith('/') || p === '/') return '/';
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  } catch {
    return '/';
  }
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}

const key = (c: Pick<StoredCookie, 'name' | 'domain' | 'path'>) => `${c.domain}\u0000${c.path}\u0000${c.name}`;

export class CookieJar {
  private cookies: Map<string, StoredCookie> = new Map();

  private live(now = Date.now()): StoredCookie[] {
    const out: StoredCookie[] = [];
    for (const [k, c] of this.cookies) {
      if (c.expires !== undefined && c.expires <= now) this.cookies.delete(k);
      else out.push(c);
    }
    return out;
  }

  // Cookies that would be sent to `url` (all cookies when no URL is given)
  public forUrl(url?: string): StoredCookie[] {
    const all = this.live();
    if (!url) return all;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return [];
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const secureOk = u.protocol === 'https:' || u.protocol === 'wss:' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return all
      .filter((c) => domainMatches(host, c.domain, c.hostOnly) && pathMatches(u.pathname || '/', c.path) && (!c.secure || secureOk))
      // Longer paths first, as browsers order them
      .sort((a, b) => b.path.length - a.path.length);
  }

  public get(name: string, url?: string): string | undefined {
    return this.forUrl(url).find((c) => c.name === name)?.value;
  }

  // Sets a cookie for the site of `url` (host-only). Without a URL or domain the cookie is unscoped (legacy).
  public set(name: string, value: string, urlOrScope?: string | CookieScope): void {
    const scope: CookieScope = typeof urlOrScope === 'string' ? { domain: hostOf(urlOrScope) } : urlOrScope || {};
    const rawDomain = (scope.domain || '').toLowerCase().replace(/^\./, '');
    const c: StoredCookie = {
      name,
      value: String(value),
      domain: rawDomain,
      hostOnly: typeof urlOrScope === 'string' || !(scope.domain || '').startsWith('.'),
      path: scope.path || '/',
      secure: !!scope.secure,
      httpOnly: !!scope.httpOnly,
      expires: scope.expires,
    };
    // Replacing a cookie: drop any same-name cookie for the same scope (and legacy unscoped duplicates)
    for (const [k, old] of this.cookies) {
      if (old.name === name && (old.domain === c.domain || old.domain === '') && old.path === c.path) this.cookies.delete(k);
    }
    this.cookies.set(key(c), c);
  }

  // Inserts a fully specified cookie (CDP Network.setCookie / Storage.setCookies), replacing same name+domain+path
  public add(cookie: StoredCookie): void {
    const c: StoredCookie = {
      name: cookie.name,
      value: String(cookie.value ?? ''),
      domain: String(cookie.domain || '').toLowerCase().replace(/^\./, ''),
      hostOnly: cookie.hostOnly !== false,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      expires: typeof cookie.expires === 'number' ? cookie.expires : undefined,
    };
    for (const [k, old] of this.cookies) {
      if (old.name === c.name && old.domain === c.domain && old.path === c.path) this.cookies.delete(k);
    }
    this.cookies.set(key(c), c);
  }

  // Removes cookies matching name and, when given, domain (leading '.' ignored) and path
  public remove(name: string, domain?: string, path?: string): void {
    const d = domain ? domain.toLowerCase().replace(/^\./, '') : undefined;
    for (const [k, c] of this.cookies) {
      if (c.name === name && (d === undefined || c.domain === d) && (path === undefined || c.path === path)) this.cookies.delete(k);
    }
  }

  public delete(name: string, url?: string): void {
    const host = hostOf(url);
    for (const [k, c] of this.cookies) {
      if (c.name === name && (!host || domainMatches(host, c.domain, c.hostOnly))) this.cookies.delete(k);
    }
  }

  public clear(): void {
    this.cookies.clear();
  }

  public get size(): number {
    return this.live().length;
  }

  public has(name: string, url?: string): boolean {
    return this.get(name, url) !== undefined;
  }

  // name → value. With a URL: only cookies that site would receive.
  public dump(url?: string): Record<string, string> {
    const out: Record<string, string> = {};
    // Reverse so that the most specific cookie wins on duplicate names
    for (const c of this.forUrl(url).reverse()) out[c.name] = c.value;
    return out;
  }

  public list(): StoredCookie[] {
    return this.live().map((c) => ({ ...c }));
  }

  // Replaces the jar. A name → value map is scoped to `url`'s host when given (old session files).
  public restore(cookies: Record<string, string> | Map<string, string> | StoredCookie[], url?: string): void {
    this.cookies.clear();
    if (Array.isArray(cookies)) {
      for (const c of cookies) {
        if (!c || typeof c.name !== 'string') continue;
        const sc: StoredCookie = {
          name: c.name,
          value: String(c.value ?? ''),
          domain: String(c.domain || '').toLowerCase().replace(/^\./, ''),
          hostOnly: c.hostOnly !== false,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expires: typeof c.expires === 'number' ? c.expires : undefined,
        };
        this.cookies.set(key(sc), sc);
      }
      return;
    }
    const entries = cookies instanceof Map ? [...cookies.entries()] : Object.entries(cookies || {});
    for (const [k, v] of entries) this.set(k, String(v), url ? url : undefined);
  }

  // Cookie header for a request to `url` (every cookie when no URL is given, as before 0.2.0)
  public getCookieHeader(url?: string): string {
    return this.forUrl(url).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  // Stores Set-Cookie headers of a response from `url`
  public storeSetCookies(headers: { getSetCookie?(): string[] } | any, url?: string): void {
    const lines: string[] = typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : Array.isArray(headers?.['set-cookie'])
      ? headers['set-cookie']
      : headers?.['set-cookie']
      ? [headers['set-cookie']]
      : [];

    const host = hostOf(url);
    const now = Date.now();
    for (const line of lines) {
      if (!line) continue;
      const [pair, ...attrParts] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = '';
      let path = '';
      let secure = false;
      let httpOnly = false;
      let expires: number | undefined;
      let maxAge: number | undefined;
      for (const part of attrParts) {
        const i = part.indexOf('=');
        const k = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : part.slice(i + 1).trim();
        if (k === 'domain') domain = v.toLowerCase().replace(/^\./, '');
        else if (k === 'path') path = v;
        else if (k === 'secure') secure = true;
        else if (k === 'httponly') httpOnly = true;
        else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
        else if (k === 'expires') {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) expires = t;
        }
      }
      if (maxAge !== undefined) expires = now + maxAge * 1000;

      let hostOnly = true;
      if (host) {
        if (domain) {
          // A site may only set cookies for itself or a parent domain, never for another site
          if (!domainMatches(host, domain, false) || isIpLiteral(host) && host !== domain) continue;
          hostOnly = false;
        } else {
          domain = host;
        }
      }
      if (!path || !path.startsWith('/')) path = url ? defaultPath(url) : '/';

      const c: StoredCookie = { name, value, domain, hostOnly, path, secure, httpOnly, expires };
      if (expires !== undefined && expires <= now) {
        this.cookies.delete(key(c));
        continue;
      }
      this.cookies.set(key(c), c);
    }
  }

  public clone(): CookieJar {
    const jar = new CookieJar();
    jar.restore(this.list());
    return jar;
  }
}
