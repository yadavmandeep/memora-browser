import { Agent, undiciFull, type Dispatcher } from './undici.js';
import { NetworkOptions } from '../types/index.js';
import { RobotsStore } from './robots.js';
import { getStealthHeaders } from '../stealth/fingerprint.js';

const SUPPORTED_PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'];

export function validateProxyUrl(proxy: string): URL {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error(`Invalid proxy URL "${proxy}". Expected e.g. http://host:3128 or socks5://user:pass@host:1080`);
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.includes(url.protocol)) {
    throw new Error(`Unsupported proxy protocol "${url.protocol}". Use http://, https:// or socks5://`);
  }
  return url;
}

// Proxy URL with credentials masked, safe for logs and banners
export function redactProxyUrl(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return '[invalid proxy url]';
  }
}

function envVar(name: string): string | undefined {
  return process.env[name] || process.env[name.toLowerCase()] || undefined;
}

// Explicit proxy wins; otherwise standard env vars when useEnvProxy is on
export function resolveProxyFor(targetUrl: string, options: NetworkOptions): string | undefined {
  if (options.proxy) return options.proxy;
  if (!options.useEnvProxy) return undefined;
  const isHttps = targetUrl.startsWith('https:');
  return (isHttps ? envVar('HTTPS_PROXY') : envVar('HTTP_PROXY')) || envVar('ALL_PROXY');
}

export function resolveNoProxy(options: NetworkOptions): string[] {
  const list = [...(options.noProxy || [])];
  if (!options.proxy && options.useEnvProxy) {
    const env = envVar('NO_PROXY');
    if (env) list.push(...env.split(','));
  }
  return list.map(s => s.trim().toLowerCase()).filter(Boolean);
}

// NO_PROXY semantics: "*" matches all, ".example.com" / "*.example.com" match subdomains,
// "example.com" matches itself and subdomains, "host:port" matches that port only
export function shouldBypassProxy(targetUrl: string, noProxy: string[]): boolean {
  if (noProxy.length === 0) return false;
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  return noProxy.some(rule => {
    if (rule === '*') return true;
    let ruleHost = rule;
    let rulePort: string | undefined;
    const portMatch = rule.match(/^(.*):(\d+)$/);
    if (portMatch && !rule.includes(']')) {
      ruleHost = portMatch[1];
      rulePort = portMatch[2];
    }
    if (rulePort && rulePort !== port) return false;
    ruleHost = ruleHost.replace(/^\*\./, '.').replace(/^\[|\]$/g, '');
    if (ruleHost.startsWith('.')) {
      return host.endsWith(ruleHost) || host === ruleHost.slice(1);
    }
    return host === ruleHost || host.endsWith('.' + ruleHost);
  });
}

export function createProxyDispatcher(proxy: string, options: NetworkOptions): Dispatcher {
  const url = validateProxyUrl(proxy);
  const tls = options.insecureTls ? { rejectUnauthorized: false } : undefined;

  if (url.protocol.startsWith('socks')) {
    if (options.proxyBearerToken) {
      throw new Error('--proxy-bearer-token is only supported with http:// and https:// proxies');
    }
    // undici's SOCKS agent only accepts the socks5: scheme; socks5h/socks resolve remotely anyway
    const normalized = new URL(proxy);
    const socksUrl = `socks5://${normalized.username ? `${normalized.username}:${normalized.password}@` : ''}${normalized.host}`;
    // requestTls is honoured at runtime but missing from undici's typings
    return new (undiciFull().Socks5ProxyAgent)(socksUrl, { requestTls: tls } as any);
  }

  return new (undiciFull().ProxyAgent)({
    uri: proxy,
    token: options.proxyBearerToken ? `Bearer ${options.proxyBearerToken}` : undefined,
    requestTls: tls,
    proxyTls: tls,
  });
}

// Picks a direct or proxied dispatcher per request URL, caching one agent per proxy URL
export class DispatcherPool {
  private direct: Dispatcher;
  private proxied: Map<string, Dispatcher> = new Map();
  private noProxy: string[];
  // Session-wide robots.txt cache, present when --obey-robots is on
  public readonly robots?: RobotsStore;

  constructor(private options: NetworkOptions) {
    this.direct = new Agent({ connect: options.insecureTls ? { rejectUnauthorized: false } : undefined });
    this.noProxy = resolveNoProxy(options);
    if (options.proxy) validateProxyUrl(options.proxy);
    if (options.obeyRobots) {
      this.robots = new RobotsStore({
        agent: options.robotsAgent,
        userAgent: options.userAgent || getStealthHeaders()['User-Agent'],
        dispatcherFor: (url) => this.forUrl(url),
      });
    }
  }

  public forUrl(targetUrl: string): Dispatcher {
    const proxy = resolveProxyFor(targetUrl, this.options);
    if (!proxy || shouldBypassProxy(targetUrl, this.noProxy)) {
      return this.direct;
    }
    let agent = this.proxied.get(proxy);
    if (!agent) {
      agent = createProxyDispatcher(proxy, this.options);
      this.proxied.set(proxy, agent);
    }
    return agent;
  }

  public async close(): Promise<void> {
    const all = [this.direct, ...this.proxied.values()];
    this.proxied.clear();
    await Promise.allSettled(all.map(d => d.close()));
  }
}

// Playwright launch() proxy config for the Chrome-backed engine
export function toPlaywrightProxy(options: NetworkOptions): { server: string; username?: string; password?: string; bypass?: string } | undefined {
  const proxy = options.proxy || (options.useEnvProxy ? envVar('HTTPS_PROXY') || envVar('HTTP_PROXY') || envVar('ALL_PROXY') : undefined);
  if (!proxy) return undefined;
  const url = validateProxyUrl(proxy);
  const scheme = url.protocol.startsWith('socks') ? 'socks5:' : url.protocol;
  const noProxy = resolveNoProxy(options);
  return {
    server: `${scheme}//${url.host}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    bypass: noProxy.length ? noProxy.join(',') : undefined,
  };
}
