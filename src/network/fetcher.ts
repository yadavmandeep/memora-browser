import { fetch as undiciFetch } from './undici.js';
import { getStealthHeaders } from '../stealth/fingerprint.js';
import { NetworkOptions } from '../types/index.js';
import { DispatcherPool } from './proxy.js';
import { CookieJar } from './cookie-jar.js';
import type { ChallengeSignal } from '../challenge/detector.js';

export interface FetchResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  // Subresource request (script, ...): fetch-style headers instead of navigation headers
  resource?: boolean;
}

const MAX_REDIRECTS = 20;

export class NetworkFetcher {
  public readonly cookieJar: CookieJar;
  private inFlightControllers: Set<AbortController> = new Set();
  private extraHeaders: Record<string, string> = {};
  private readonly options: NetworkOptions;
  private readonly pool: DispatcherPool;
  private readonly ownsPool: boolean;

  constructor(options: NetworkOptions = {}, pool?: DispatcherPool, cookieJar?: CookieJar) {
    this.options = options;
    this.pool = pool || new DispatcherPool(options);
    this.ownsPool = !pool;
    this.cookieJar = cookieJar || new CookieJar();
  }

  // Pauses further requests to the signal's host when it blocks; returns the pause in seconds
  public recordChallenge(signal: ChallengeSignal | null): number {
    return this.pool.cooldown.record(signal);
  }

  public setExtraHeaders(headers: Record<string, string>): void {
    this.extraHeaders = { ...this.extraHeaders, ...headers };
  }

  public setCookie(name: string, value: string): void {
    this.cookieJar.set(name, value);
  }

  public deleteCookie(name: string): void {
    this.cookieJar.delete(name);
  }

  public clearCookies(): void {
    this.cookieJar.clear();
  }

  public dumpCookies(): Record<string, string> {
    return this.cookieJar.dump();
  }

  public restoreCookies(cookies: Record<string, string>): void {
    this.cookieJar.restore(cookies);
  }

  public getCookieHeader(): string {
    return this.cookieJar.getCookieHeader();
  }

  public abortInFlight(): void {
    for (const ctrl of this.inFlightControllers) {
      try {
        ctrl.abort();
      } catch {}
    }
    this.inFlightControllers.clear();
  }

  private storeSetCookies(headers: { getSetCookie(): string[] } | any): void {
    this.cookieJar.storeSetCookies(headers);
  }

  private baseHeaders(navigation: boolean): Record<string, string> {
    const headers: Record<string, string> = navigation
      ? { ...getStealthHeaders() }
      : { 'User-Agent': getStealthHeaders()['User-Agent'], 'Accept': '*/*' };
    if (this.options.userAgent) headers['User-Agent'] = this.options.userAgent;
    // CLI headers win over script-set headers
    Object.assign(headers, this.extraHeaders, this.options.headers || {});
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    return headers;
  }

  public async get(url: string, timeoutMs?: number): Promise<FetchResponse> {
    return this.request(url, { method: 'GET', timeoutMs });
  }

  // Top-level navigation request. Redirects are followed manually so cookies set on
  // 3xx hops (typical login flows) are captured.
  public async request(url: string, opts: RequestOptions = {}): Promise<FetchResponse> {
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.inFlightControllers.add(controller);

    let method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    let currentUrl = url;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // --obey-robots: every hop, redirect targets included, is checked against its origin's robots.txt
        await this.pool.robots?.check(currentUrl);
        this.pool.cooldown.assertClear(currentUrl);
        const headers = this.baseHeaders(!opts.resource);
        Object.assign(headers, opts.headers || {});
        if (body === undefined) delete headers['Content-Type'];

        const resp = await undiciFetch(currentUrl, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: controller.signal,
          redirect: 'manual',
          dispatcher: this.pool.forUrl(currentUrl),
        });

        this.storeSetCookies(resp.headers);

        const location = resp.headers.get('location');
        if (resp.status >= 300 && resp.status < 400 && location) {
          await resp.body?.cancel().catch(() => {});
          currentUrl = new URL(location, currentUrl).toString();
          if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          continue;
        }

        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          respHeaders[k.toLowerCase()] = v;
        });

        return {
          url: currentUrl,
          status: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
          body: await resp.text(),
          contentType: respHeaders['content-type'] || 'text/html',
        };
      }
      throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`${opts.resource ? 'Request' : 'Navigation'} timeout after ${timeoutMs}ms: ${url}`);
      }
      // undici wraps socket/proxy failures as "fetch failed" with the real reason nested in cause
      if (err?.cause) {
        let root = err.cause;
        while (root?.cause) root = root.cause;
        let reason = root?.message || root?.code || String(root);
        if (/\(407\)/.test(reason)) reason += ' — proxy rejected the credentials (check user:pass in --http-proxy or --proxy-bearer-token)';
        throw new Error(`Request to ${currentUrl} failed: ${reason}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.inFlightControllers.delete(controller);
    }
  }

  // Subresource fetch for page-loaded resources such as <script src>: same proxy, cookies,
  // headers and --obey-robots checks (on every redirect hop) as request()
  public async fetchResource(url: string, opts: { timeoutMs?: number; referer?: string; accept?: string } = {}): Promise<FetchResponse> {
    const headers: Record<string, string> = {};
    if (opts.accept) headers['Accept'] = opts.accept;
    if (opts.referer && /^https?:/.test(opts.referer)) headers['Referer'] = opts.referer;
    return this.request(url, { method: 'GET', headers, timeoutMs: opts.timeoutMs, resource: true });
  }

  // fetch() exposed to page scripts: same proxy, cookies and headers as navigations
  public async pageFetch(input: any, init: any = {}, baseUrl?: string): Promise<any> {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const target = baseUrl ? new URL(rawUrl, baseUrl).toString() : rawUrl;
    await this.pool.robots?.check(target);
    this.pool.cooldown.assertClear(target);
    const headers = this.baseHeaders(false);
    if (init.headers) {
      const given = typeof init.headers.forEach === 'function'
        ? Object.fromEntries((init.headers as any).entries())
        : init.headers;
      Object.assign(headers, given);
    }
    const resp = await undiciFetch(target, {
      ...init,
      headers,
      dispatcher: this.pool.forUrl(target),
    });
    this.storeSetCookies(resp.headers);
    return resp;
  }

  public async close(): Promise<void> {
    this.abortInFlight();
    if (this.ownsPool) await this.pool.close();
  }
}
