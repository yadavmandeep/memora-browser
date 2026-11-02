import { isIP } from 'node:net';
import { FirewallBlockedError } from './errors.js';
import type { DomainRules } from './policy.js';

export interface DomainDecision {
  allowed: boolean;
  url: string;
  navigation: boolean;
  rule: string;      // "domain:allow", "domain:block", "domain:not-allowlisted", "domain:sensitive:<category>", ...
  reason: string;
  enforced: boolean; // false in monitor mode: the request went ahead anyway
}

export interface DomainPolicy extends DomainRules {
  // monitor: decide and report, never refuse
  monitor?: boolean;
  // Called for every refused (or, in monitor mode, would-be refused) request
  onDecision?: (d: DomainDecision) => void;
}

// Built-in sensitive categories. Not exhaustive: there are thousands of banks and mail providers.
// The keyword rule below catches many bank hostnames; an explicit `allow` entry overrides any of these.
export const SENSITIVE_DOMAINS: Record<string, string[]> = {
  email: [
    'mail.google.com', 'gmail.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'mail.yahoo.com', 'mail.proton.me', 'mail.protonmail.com', 'fastmail.com', 'mail.zoho.com', 'mail.aol.com',
    'www.icloud.com/mail', 'mail.yandex.com', 'mail.gmx.com',
  ],
  'banking-payments': [
    'paypal.com', 'venmo.com', 'wise.com', 'revolut.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com',
    'citi.com', 'capitalone.com', 'americanexpress.com', 'discover.com', 'usbank.com', 'hsbc.com', 'barclays.co.uk',
    'lloydsbank.com', 'natwest.com', 'santander.com', 'onlinesbi.sbi', 'hdfcbank.com', 'icicibank.com',
    'axisbank.com', 'kotak.com', 'paytm.com', 'phonepe.com', 'dashboard.stripe.com', 'squareup.com/dashboard',
    'coinbase.com', 'binance.com', 'kraken.com', 'robinhood.com', 'schwab.com', 'fidelity.com', 'vanguard.com',
    'etrade.com', 'kite.zerodha.com', 'groww.in',
  ],
  identity: [
    'accounts.google.com', 'myaccount.google.com', 'login.microsoftonline.com', 'account.microsoft.com',
    'login.live.com', 'appleid.apple.com', 'account.apple.com', 'vault.bitwarden.com', 'my.1password.com',
    'lastpass.com', 'github.com/settings', 'okta.com', 'auth0.com/u',
  ],
  'cloud-console': [
    'console.aws.amazon.com', 'signin.aws.amazon.com', 'portal.azure.com', 'console.cloud.google.com',
    'admin.google.com', 'admin.microsoft.com', 'dash.cloudflare.com', 'cloud.digitalocean.com',
    'dashboard.heroku.com', 'app.supabase.com', 'console.firebase.google.com',
  ],
  // SSRF targets: instance credentials live here
  'cloud-metadata': ['169.254.169.254', 'metadata.google.internal', '100.100.100.200', '[fd00:ec2::254]'],
};

// Admin paths on any host (WordPress, phpMyAdmin, cPanel, generic /admin)
const ADMIN_PATH = /^\/(wp-admin|wp-login\.php|administrator|admin|phpmyadmin|cpanel|whm|plesk)(\/|$|\?)/i;
// A hostname label that starts or ends with "bank" or contains "banking" (hdfcbank, bankofamerica, netbanking)
const BANK_LABEL = /^bank|bank$|banking/i;

interface Pattern {
  raw: string;
  host: string;
  subdomainsOnly: boolean;
  path: string; // '' = any path
}

function parsePattern(raw: string): Pattern {
  let p = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
  let subdomainsOnly = false;
  if (p.startsWith('*.')) {
    subdomainsOnly = true;
    p = p.slice(2);
  } else if (p.startsWith('.')) {
    subdomainsOnly = true;
    p = p.slice(1);
  }
  let host = p;
  let path = '';
  // IPv6 literal "[::1]/x" keeps its brackets
  const slash = p.startsWith('[') ? p.indexOf('/', p.indexOf(']')) : p.indexOf('/');
  if (slash >= 0) {
    host = p.slice(0, slash);
    path = p.slice(slash);
  }
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host) throw new Error(`Invalid domain pattern "${raw}"`);
  return { raw, host, subdomainsOnly, path };
}

function hostMatches(host: string, p: Pattern): boolean {
  if (p.subdomainsOnly) return host.endsWith('.' + p.host);
  return host === p.host || host.endsWith('.' + p.host);
}

function patternMatches(u: URL, p: Pattern): boolean {
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostMatches(host, p)) return false;
  return !p.path || u.pathname.toLowerCase().startsWith(p.path);
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:127.') || h.startsWith('::ffff:10.') || h.startsWith('::ffff:192.168.');
  }
  return false;
}

// Decides whether a URL may be requested. Lives in the network layer (native fetcher and the Chrome
// engine's request router), so it also covers redirects, link clicks, form posts, script-driven
// navigation and CDP / WebDriver clients, not only the agent's explicit "browse" calls.
export class DomainGuard {
  private readonly allow: Pattern[];
  private readonly block: Pattern[];
  private readonly sensitive: Array<{ category: string; pattern: Pattern }>;

  constructor(private readonly policy: DomainPolicy) {
    this.allow = (policy.allow || []).map(parsePattern);
    this.block = (policy.block || []).map(parsePattern);
    this.sensitive = policy.blockSensitive
      ? Object.entries(SENSITIVE_DOMAINS).flatMap(([category, list]) => list.map((raw) => ({ category, pattern: parsePattern(raw) })))
      : [];
  }

  public get monitor(): boolean {
    return !!this.policy.monitor;
  }

  // navigation: top-level document loads (agent browse, clicks, form submits, redirects of those).
  // Subresources and page fetch() only face the explicit block list, so allowlisting a site does not
  // break the CDNs it loads from.
  public check(rawUrl: string, opts: { navigation: boolean }): DomainDecision {
    const navigation = opts.navigation;
    const verdict = (allowed: boolean, rule: string, reason: string): DomainDecision =>
      ({ allowed, url: rawUrl, navigation, rule, reason, enforced: !allowed && !this.policy.monitor });

    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return verdict(false, 'domain:invalid-url', `not a valid URL: ${rawUrl}`);
    }
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') {
      // In-page documents; they never leave the process
      return navigation && u.protocol !== 'about:' ? verdict(false, 'domain:scheme', `navigation to ${u.protocol} URLs is not allowed`) : verdict(true, 'domain:scheme', 'in-page URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      return verdict(false, 'domain:scheme', `${u.protocol} URLs are not allowed`);
    }

    for (const p of this.block) {
      if (patternMatches(u, p)) return verdict(false, 'domain:block', `matches block rule "${p.raw}"`);
    }
    if (!navigation) return verdict(true, 'domain:subresource', 'subresource');

    const allowHit = this.allow.find((p) => patternMatches(u, p));
    if (this.allow.length && !allowHit) return verdict(false, 'domain:not-allowlisted', `${u.hostname} is not on the allow list`);
    if (allowHit) return verdict(true, 'domain:allow', `matches allow rule "${allowHit.raw}"`);

    if (this.policy.blockPrivateNetwork && isPrivateHost(u.hostname)) {
      return verdict(false, 'domain:private-network', `${u.hostname} is a local or private network address`);
    }
    if (this.policy.blockSensitive) {
      const hit = this.sensitive.find((s) => patternMatches(u, s.pattern));
      if (hit) return verdict(false, `domain:sensitive:${hit.category}`, `${u.hostname} is in the sensitive category "${hit.category}"`);
      const host = u.hostname.toLowerCase();
      if (!isIP(host.replace(/^\[|\]$/g, '')) && host.split('.').slice(0, -1).some((label) => BANK_LABEL.test(label))) {
        return verdict(false, 'domain:sensitive:banking-keyword', `${u.hostname} looks like a bank (hostname keyword)`);
      }
      if (ADMIN_PATH.test(u.pathname)) {
        return verdict(false, 'domain:sensitive:admin-path', `${u.pathname} looks like an admin panel`);
      }
    }
    return verdict(true, 'domain:default', 'no rule matched');
  }

  // Hands a refusal to onDecision (the firewall's audit log)
  public report(d: DomainDecision): void {
    if (d.allowed) return;
    try {
      this.policy.onDecision?.(d);
    } catch {}
  }

  // Throws FirewallBlockedError when refused and enforced. Reports every refusal through onDecision.
  public assertAllowed(rawUrl: string, opts: { navigation: boolean }): DomainDecision {
    const d = this.check(rawUrl, opts);
    if (!d.allowed) {
      this.report(d);
      if (d.enforced) {
        throw new FirewallBlockedError(`Blocked by Orbis firewall: ${d.reason} (${rawUrl})`, d.rule, { url: rawUrl, capability: 'navigate' });
      }
    }
    return d;
  }
}
