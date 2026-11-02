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

// Request interception (CDP Fetch domain, Playwright route()). Off unless a CDP client enables it.
export interface InterceptedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  resourceType: 'Document' | 'Script' | 'Fetch';
  // Set by the interceptor: the id the client knows this request by
  networkId?: string;
}
export type InterceptDecision =
  | { action: 'continue'; url?: string; method?: string; headers?: Record<string, string>; body?: string }
  | { action: 'fulfill'; status: number; headers: Record<string, string>; body: string }
  | { action: 'fail'; reason: string };
export interface RequestInterceptor {
  intercept(req: InterceptedRequest): Promise<InterceptDecision>;
  responded?(req: InterceptedRequest, res: { url: string; status: number; headers: Record<string, string> }): void;
  failed?(req: InterceptedRequest, error: string): void;
}

export class NetworkFetcher {
  public readonly cookieJar: CookieJar;
  public interceptor?: RequestInterceptor;
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

  // `url`: the site the cookie belongs to. Without it the cookie is unscoped (sent everywhere, the pre-0.2.0 behaviour).
  public setCookie(name: string, value: string, url?: string): void {
    this.cookieJar.set(name, value, url);
  }

  public deleteCookie(name: string, url?: string): void {
    this.cookieJar.delete(name, url);
  }

  public clearCookies(): void {
    this.cookieJar.clear();
  }

  // name → value; with a URL only the cookies that site receives
  public dumpCookies(url?: string): Record<string, string> {
    return this.cookieJar.dump(url);
  }

  // A name → value map is scoped to `url`'s site
  public restoreCookies(cookies: Record<string, string>, url?: string): void {
    this.cookieJar.restore(cookies, url);
  }

  public getCookieHeader(url?: string): string {
    return this.cookieJar.getCookieHeader(url);
  }

  public abortInFlight(): void {
    for (const ctrl of this.inFlightControllers) {
      try {
        ctrl.abort();
      } catch {}
    }
    this.inFlightControllers.clear();
  }

  private storeSetCookies(headers: { getSetCookie(): string[] } | any, url: string): void {
    this.cookieJar.storeSetCookies(headers, url);
  }

  private baseHeaders(navigation: boolean, url: string): Record<string, string> {
    const headers: Record<string, string> = navigation
      ? { ...getStealthHeaders() }
      : { 'User-Agent': getStealthHeaders()['User-Agent'], 'Accept': '*/*' };
    if (this.options.userAgent) {
      headers['User-Agent'] = this.options.userAgent;
      // Client Hints describe Chrome 130; with a non-Chrome UA they would contradict it
      if (!/Chrome\//.test(this.options.userAgent)) {
        for (const h of Object.keys(headers)) if (/^sec-ch-ua/i.test(h)) delete headers[h];
      }
    }
    // CLI headers win over script-set headers
    Object.assign(headers, this.extraHeaders, this.options.headers || {});
    const cookieHeader = this.getCookieHeader(url);
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

    // The intercepted request (CDP Fetch); its response is reported after the last redirect hop
    let intercepted: InterceptedRequest | undefined;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Firewall domain rules: every hop, so an allowed site cannot redirect the agent somewhere blocked
        this.pool.domains?.assertAllowed(currentUrl, { navigation: !opts.resource });
        // --obey-robots: every hop, redirect targets included, is checked against its origin's robots.txt
        await this.pool.robots?.check(currentUrl);
        this.pool.cooldown.assertClear(currentUrl);
        const headers = this.baseHeaders(!opts.resource, currentUrl);
        Object.assign(headers, opts.headers || {});
        if (body === undefined) delete headers['Content-Type'];

        if (this.interceptor && hop === 0) {
          intercepted = { url: currentUrl, method, headers: { ...headers }, body, resourceType: opts.resource ? 'Script' : 'Document' };
          const d = await this.interceptor.intercept(intercepted);
          if (d.action === 'fail') throw new Error(`net::ERR_${d.reason.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`);
          if (d.action === 'fulfill') {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(d.headers)) h[k.toLowerCase()] = v;
            this.storeSetCookies({ 'set-cookie': h['set-cookie'] ? h['set-cookie'].split('\n') : [] }, currentUrl);
            this.interceptor.responded?.(intercepted, { url: currentUrl, status: d.status, headers: h });
            return { url: currentUrl, status: d.status, statusText: '', headers: h, body: d.body, contentType: h['content-type'] || 'text/html' };
          }
          if (d.url && d.url !== currentUrl) currentUrl = d.url;
          if (d.method) method = d.method.toUpperCase();
          if (d.headers) {
            for (const k of Object.keys(headers)) delete headers[k];
            Object.assign(headers, d.headers);
          }
          if (d.body !== undefined) body = d.body;
        }

        const resp = await undiciFetch(currentUrl, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: controller.signal,
          redirect: 'manual',
          dispatcher: this.pool.forUrl(currentUrl),
        });

        this.storeSetCookies(resp.headers, currentUrl);

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
        if (intercepted) this.interceptor?.responded?.(intercepted, { url: currentUrl, status: resp.status, headers: respHeaders });

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
    this.pool.domains?.assertAllowed(target, { navigation: false });
    await this.pool.robots?.check(target);
    this.pool.cooldown.assertClear(target);
    const headers = this.baseHeaders(false, target);
    if (init.headers) {
      const given = typeof init.headers.forEach === 'function'
        ? Object.fromEntries((init.headers as any).entries())
        : init.headers;
      Object.assign(headers, given);
    }
    let fetchUrl = target;
    let fetchInit: any = { ...init, headers };
    let intercepted: InterceptedRequest | undefined;
    if (this.interceptor) {
      intercepted = {
        url: target,
        method: String(init.method || 'GET').toUpperCase(),
        headers: { ...headers },
        body: typeof init.body === 'string' ? init.body : undefined,
        resourceType: 'Fetch',
      };
      const d = await this.interceptor.intercept(intercepted);
      if (d.action === 'fail') throw new TypeError(`Failed to fetch (net::ERR_${d.reason.toUpperCase()})`);
      if (d.action === 'fulfill') {
        this.interceptor.responded?.(intercepted, { url: target, status: d.status, headers: d.headers });
        return new Response(d.body, { status: d.status, headers: d.headers });
      }
      if (d.url) fetchUrl = d.url;
      fetchInit = { ...fetchInit, method: d.method ?? fetchInit.method, headers: d.headers ?? headers, body: d.body ?? fetchInit.body };
    }
    let resp: any;
    try {
      resp = await undiciFetch(fetchUrl, {
        ...fetchInit,
        dispatcher: this.pool.forUrl(fetchUrl),
      });
    } catch (e: any) {
      if (intercepted) this.interceptor?.failed?.(intercepted, String(e?.message || e));
      throw e;
    }
    this.storeSetCookies(resp.headers, fetchUrl);
    if (intercepted) {
      const h: Record<string, string> = {};
      resp.headers.forEach((v: string, k: string) => { h[k.toLowerCase()] = v; });
      this.interceptor?.responded?.(intercepted, { url: fetchUrl, status: resp.status, headers: h });
    }
    return resp;
  }

  public async close(): Promise<void> {
    this.abortInFlight();
    if (this.ownsPool) await this.pool.close();
  }
}
