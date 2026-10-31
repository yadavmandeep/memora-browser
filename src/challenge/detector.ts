// Recognises CAPTCHA widgets, bot-management interstitials, WAF blocks and rate limits in a
// navigation response. Detection only: Orbis never solves or works around these (see
// CHALLENGE_HANDLING_DESIGN.md). Pure function, no I/O, shared by the native and Chrome engines.

export type ChallengeKind =
  | 'interstitial'   // the whole page is a challenge (e.g. "Just a moment...")
  | 'captcha'        // interactive widget embedded in an otherwise real page
  | 'passive'        // score-only / invisible script; the page is usable
  | 'blocked'        // WAF / bot-manager denial with no challenge offered
  | 'rate_limited';  // HTTP 429

export type ChallengeVendor =
  | 'cloudflare' | 'turnstile' | 'recaptcha' | 'hcaptcha' | 'aws-waf'
  | 'datadome' | 'perimeterx' | 'akamai' | 'imperva' | 'arkose' | 'geetest'
  | 'unknown';

export interface ChallengeSignal {
  kind: ChallengeKind;
  vendor: ChallengeVendor;
  // true => the loaded document is not the real page
  blocking: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  url: string;
  status: number;
  retryAfterSec?: number;
}

export interface DetectInput {
  url: string;
  status: number;
  headers: Record<string, string>;
  html: string;
}

// Challenge markers sit in <head> or near the top of <body>; huge pages are not scanned in full
const MAX_SCAN_CHARS = 256 * 1024;

export function detectChallenge(input: DetectInput): ChallengeSignal | null {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers || {})) headers[k.toLowerCase()] = String(v);
  const html = (input.html || '').slice(0, MAX_SCAN_CHARS);
  const status = input.status;
  const title = extractTitle(html);
  const server = (headers['server'] || '').toLowerCase();

  const make = (
    kind: ChallengeKind,
    vendor: ChallengeVendor,
    confidence: ChallengeSignal['confidence'],
    evidence: string[]
  ): ChallengeSignal => {
    const signal: ChallengeSignal = {
      kind,
      vendor,
      blocking: kind === 'interstitial' || kind === 'blocked' || kind === 'rate_limited',
      confidence,
      evidence,
      url: input.url,
      status,
    };
    const retryAfter = parseRetryAfter(headers['retry-after']);
    if (retryAfter !== undefined) signal.retryAfterSec = retryAfter;
    return signal;
  };

  // ── Blocking: header-level signals (strongest) ──────────────────────────
  if ((headers['cf-mitigated'] || '').toLowerCase() === 'challenge') {
    const ev = ['header cf-mitigated=challenge'];
    if (title) ev.push(`title "${title}"`);
    return make('interstitial', 'cloudflare', 'high', ev);
  }

  const wafAction = (headers['x-amzn-waf-action'] || '').toLowerCase();
  if (wafAction === 'captcha' || wafAction === 'challenge') {
    return make('interstitial', 'aws-waf', 'high', [`header x-amzn-waf-action=${wafAction}`, `HTTP ${status}`]);
  }

  // ── Blocking: status + markup ───────────────────────────────────────────
  const isCloudflare = server === 'cloudflare' || 'cf-ray' in headers;
  if (status === 403 || status === 503) {
    // "/cdn-cgi/challenge-platform/scripts/jsd/" is a beacon Cloudflare injects on normal pages
    // too, so it is deliberately not a signal; _cf_chl_opt only appears on challenge pages.
    if (html.includes('_cf_chl_opt') || (isCloudflare && /^just a moment/i.test(title))) {
      const ev = [`HTTP ${status}`];
      if (html.includes('_cf_chl_opt')) ev.push('markup _cf_chl_opt');
      if (title) ev.push(`title "${title}"`);
      if (isCloudflare) ev.push('server cloudflare');
      return make('interstitial', 'cloudflare', isCloudflare ? 'high' : 'medium', ev);
    }
    if (isCloudflare && status === 403 && (html.includes('cf-error-details') || /error\s*10(0\d|1\d|20)\b/i.test(html))) {
      return make('blocked', 'cloudflare', 'high', [`HTTP ${status}`, 'server cloudflare', 'Cloudflare error page']);
    }
  }

  if (status === 403 && (html.includes('captcha-delivery.com') || 'x-datadome' in headers || 'x-dd-b' in headers)) {
    const ev = [`HTTP ${status}`];
    if (html.includes('captcha-delivery.com')) ev.push('script captcha-delivery.com');
    if ('x-datadome' in headers) ev.push('header x-datadome');
    if ('x-dd-b' in headers) ev.push('header x-dd-b');
    return make('interstitial', 'datadome', html.includes('captcha-delivery.com') ? 'high' : 'medium', ev);
  }

  if (/id=["']?px-captcha\b/i.test(html) || html.includes('captcha.px-cdn.net')) {
    return make('interstitial', 'perimeterx', status === 403 ? 'high' : 'medium', [`HTTP ${status}`, 'markup px-captcha']);
  }

  if (/incapsula incident id/i.test(html)) {
    return make('blocked', 'imperva', 'high', [`HTTP ${status}`, 'text "Incapsula incident ID"']);
  }

  if (status === 403 && /^access denied$/i.test(title) && /reference\s*#\s*[\d.a-f]+/i.test(html)) {
    const akamai = server.includes('akamai');
    return make('blocked', 'akamai', akamai ? 'high' : 'medium', [`HTTP ${status}`, 'title "Access Denied"', 'text "Reference #"', ...(akamai ? [`server ${server}`] : [])]);
  }

  if (status === 429) {
    return make('rate_limited', isCloudflare ? 'cloudflare' : 'unknown', 'high', ['HTTP 429']);
  }

  // ── Embedded widgets: the page is real, a protected submit will fail ────
  const widgets: Array<[ChallengeVendor, RegExp, RegExp]> = [
    ['turnstile', /challenges\.cloudflare\.com\/turnstile/i, /class=["'][^"']*\bcf-turnstile\b/i],
    ['hcaptcha', /(?:js\.)?hcaptcha\.com\/1\/api\.js/i, /class=["'][^"']*\bh-captcha\b/i],
    ['arkose', /arkoselabs\.com|funcaptcha\.com/i, /id=["']?(?:funcaptcha|arkose)/i],
    ['geetest', /static\.geetest\.com|geetest\.com\/(?:v\d\/)?gt\.js/i, /class=["'][^"']*\bgeetest_/i],
  ];
  for (const [vendor, script, container] of widgets) {
    const hasScript = script.test(html);
    const hasContainer = container.test(html);
    if (hasScript || hasContainer) {
      const ev: string[] = [];
      if (hasScript) ev.push(`script ${vendor}`);
      if (hasContainer) ev.push(`container ${vendor}`);
      return make('captcha', vendor, hasScript && hasContainer ? 'high' : 'medium', ev);
    }
  }

  const recaptchaScript = html.match(/(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api|enterprise)\.js(\?[^"'\s>]*)?/i);
  const recaptchaContainer = /class=["'][^"']*\bg-recaptcha\b/i.test(html);
  if (recaptchaContainer) {
    return make('captcha', 'recaptcha', recaptchaScript ? 'high' : 'medium', [
      ...(recaptchaScript ? ['script recaptcha'] : []),
      'container g-recaptcha',
    ]);
  }
  if (recaptchaScript) {
    const render = new URLSearchParams((recaptchaScript[1] || '').replace(/^\?/, '').replace(/&amp;/g, '&')).get('render');
    if (render && render !== 'explicit' && render !== 'onload') {
      // v3: score-only, many sites load it on every page
      return make('passive', 'recaptcha', 'high', ['script recaptcha render=<sitekey> (v3)']);
    }
    return make('captcha', 'recaptcha', 'low', ['script recaptcha (explicit render, no container yet)']);
  }

  return null;
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

// Retry-After is either delta-seconds or an HTTP-date
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

// Text block shown to agents (MCP) in place of page content when a challenge blocks the page
export function formatChallenge(signal: ChallengeSignal, cooldownSec?: number): string {
  const lines = [
    signal.blocking ? '# CHALLENGE DETECTED — page content not available' : '# CHALLENGE ON PAGE',
    `Vendor: ${signal.vendor} | Kind: ${signal.kind} | Confidence: ${signal.confidence}`,
    `Evidence: ${signal.evidence.join('; ')}`,
    `URL: ${signal.url} [HTTP ${signal.status}]`,
  ];
  if (signal.blocking) {
    const wait = cooldownSec ? ` Requests to this host are paused for ${cooldownSec}s.` : '';
    lines.push(`Next steps: stop, or try again later.${wait} Orbis does not solve or bypass challenges.`);
  } else if (signal.kind === 'captcha') {
    lines.push('The page is readable, but submitting the form protected by this widget will fail without a human.');
  }
  return lines.join('\n');
}
