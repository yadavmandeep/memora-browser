/**
 * Challenge detection (CAPTCHA / bot-management / rate limits) and per-host cooldown
 *   npm run test:challenge
 *
 * Fixtures are synthetic, trimmed to the signal-bearing parts. No third-party site is contacted.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { detectChallenge, parseRetryAfter } from '../src/challenge/detector.js';
import { ChallengeCooldown, ChallengeCooldownError } from '../src/challenge/cooldown.js';
import { MemoraBrowser } from '../src/engine/browser.js';
import { MCPServer } from '../src/mcp/server.js';
import { CDPServer } from '../src/cdp/server.js';
import { ChallengeDetectedError } from '../src/challenge/errors.js';
import { HumanHandoff } from '../src/challenge/handoff.js';
import { ChromeEngine, findSystemChrome } from '../src/engine/chrome-engine.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const URL_ = 'https://shop.test/p';
const page = (head: string, body = '<p>content</p>') =>
  `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;

// ── Detector: blocking ─────────────────────────────────────────────────────
console.log('\nDetector — blocking');

await test('Cloudflare cf-mitigated header → interstitial, high', () => {
  const s = detectChallenge({ url: URL_, status: 403, headers: { 'CF-Mitigated': 'challenge', server: 'cloudflare' }, html: page('<title>Just a moment...</title>') });
  assert.equal(s?.vendor, 'cloudflare');
  assert.equal(s?.kind, 'interstitial');
  assert.equal(s?.blocking, true);
  assert.equal(s?.confidence, 'high');
});

await test('Cloudflare 503 with _cf_chl_opt (no header) → interstitial', () => {
  const s = detectChallenge({ url: URL_, status: 503, headers: { server: 'cloudflare' }, html: page('<title>Just a moment...</title>', '<script>window._cf_chl_opt={cvId:"3"}</script>') });
  assert.equal(s?.kind, 'interstitial');
  assert.equal(s?.vendor, 'cloudflare');
});

await test('Cloudflare 1020 error page → blocked', () => {
  const s = detectChallenge({ url: URL_, status: 403, headers: { server: 'cloudflare', 'cf-ray': 'abc' }, html: page('<title>Access denied</title>', '<div id="cf-error-details">Error 1020</div>') });
  assert.equal(s?.kind, 'blocked');
  assert.equal(s?.blocking, true);
});

await test('AWS WAF header → interstitial', () => {
  const s = detectChallenge({ url: URL_, status: 405, headers: { 'x-amzn-waf-action': 'captcha' }, html: page('') });
  assert.equal(s?.vendor, 'aws-waf');
  assert.equal(s?.blocking, true);
});

await test('DataDome 403 with captcha-delivery → interstitial', () => {
  const s = detectChallenge({ url: URL_, status: 403, headers: { 'x-datadome': 'protected' }, html: page('', '<script src="https://ct.captcha-delivery.com/c.js"></script>') });
  assert.equal(s?.vendor, 'datadome');
  assert.equal(s?.confidence, 'high');
});

await test('PerimeterX px-captcha → interstitial', () => {
  const s = detectChallenge({ url: URL_, status: 403, headers: {}, html: page('', '<div id="px-captcha"></div>') });
  assert.equal(s?.vendor, 'perimeterx');
  assert.equal(s?.blocking, true);
});

await test('Imperva incident page → blocked', () => {
  const s = detectChallenge({ url: URL_, status: 200, headers: {}, html: page('', 'Request unsuccessful. Incapsula incident ID: 123-456') });
  assert.equal(s?.vendor, 'imperva');
  assert.equal(s?.kind, 'blocked');
});

await test('Akamai Access Denied + Reference # → blocked', () => {
  const s = detectChallenge({ url: URL_, status: 403, headers: { server: 'AkamaiGHost' }, html: page('<title>Access Denied</title>', 'Reference #18.4f2c1702.1700000000.abc') });
  assert.equal(s?.vendor, 'akamai');
  assert.equal(s?.confidence, 'high');
});

await test('429 → rate_limited with Retry-After', () => {
  const s = detectChallenge({ url: URL_, status: 429, headers: { 'Retry-After': '120' }, html: '' });
  assert.equal(s?.kind, 'rate_limited');
  assert.equal(s?.retryAfterSec, 120);
});

// ── Detector: embedded and passive ─────────────────────────────────────────
console.log('\nDetector — embedded / passive');

await test('reCAPTCHA v2 widget → captcha, not blocking', () => {
  const s = detectChallenge({ url: URL_, status: 200, headers: {}, html: page('<script src="https://www.google.com/recaptcha/api.js" async defer></script>', '<form><div class="g-recaptcha" data-sitekey="k"></div></form>') });
  assert.equal(s?.vendor, 'recaptcha');
  assert.equal(s?.kind, 'captcha');
  assert.equal(s?.blocking, false);
  assert.equal(s?.confidence, 'high');
});

await test('reCAPTCHA v3 (render=<sitekey>) → passive', () => {
  const s = detectChallenge({ url: URL_, status: 200, headers: {}, html: page('<script src="https://www.google.com/recaptcha/api.js?render=6LcAAAAA&amp;hl=en"></script>') });
  assert.equal(s?.kind, 'passive');
  assert.equal(s?.blocking, false);
});

await test('hCaptcha widget → captcha', () => {
  const s = detectChallenge({ url: URL_, status: 200, headers: {}, html: page('<script src="https://js.hcaptcha.com/1/api.js"></script>', '<div class="h-captcha" data-sitekey="k"></div>') });
  assert.equal(s?.vendor, 'hcaptcha');
  assert.equal(s?.kind, 'captcha');
});

await test('Turnstile widget → captcha', () => {
  const s = detectChallenge({ url: URL_, status: 200, headers: {}, html: page('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>', '<div class="cf-turnstile" data-sitekey="k"></div>') });
  assert.equal(s?.vendor, 'turnstile');
  assert.equal(s?.blocking, false);
});

// ── Detector: negatives (false positives would break normal browsing) ──────
console.log('\nDetector — negatives');

await test('normal Cloudflare page with jsd beacon → null', () => {
  const html = page('<title>Shop</title>', '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>');
  assert.equal(detectChallenge({ url: URL_, status: 200, headers: { server: 'cloudflare', 'cf-ray': 'x' }, html }), null);
});

await test("app's own 403 (no vendor markers) → null", () => {
  assert.equal(detectChallenge({ url: URL_, status: 403, headers: { server: 'nginx' }, html: page('<title>Forbidden</title>', 'You do not have access') }), null);
});

await test('blog post mentioning Cloudflare / "Just a moment" → null', () => {
  const html = page('<title>Why I see "Just a moment..." on Cloudflare sites</title>', '<p>Cloudflare challenge pages…</p>');
  assert.equal(detectChallenge({ url: URL_, status: 200, headers: {}, html }), null);
});

await test('503 maintenance page → null', () => {
  assert.equal(detectChallenge({ url: URL_, status: 503, headers: { server: 'nginx' }, html: page('<title>Down for maintenance</title>') }), null);
});

await test('Retry-After HTTP-date parses to seconds', () => {
  const sec = parseRetryAfter(new Date(Date.now() + 30_000).toUTCString());
  assert.ok(sec !== undefined && sec >= 28 && sec <= 31, `got ${sec}`);
  assert.equal(parseRetryAfter('garbage'), undefined);
});

// ── Cooldown ───────────────────────────────────────────────────────────────
console.log('\nCooldown');

await test('blocking signal pauses the host, other hosts unaffected', () => {
  const c = new ChallengeCooldown(60);
  const s = detectChallenge({ url: 'https://a.test/x', status: 403, headers: { 'cf-mitigated': 'challenge' }, html: '' })!;
  assert.equal(c.record(s), 60);
  assert.throws(() => c.assertClear('https://a.test/other'), ChallengeCooldownError);
  c.assertClear('https://b.test/');
});

await test('non-blocking signal and disabled cooldown record nothing', () => {
  const embedded = detectChallenge({ url: 'https://a.test/', status: 200, headers: {}, html: '<div class="g-recaptcha"></div>' });
  assert.equal(new ChallengeCooldown(60).record(embedded), 0);
  const blocking = detectChallenge({ url: 'https://a.test/', status: 429, headers: {}, html: '' });
  const off = new ChallengeCooldown(0);
  assert.equal(off.record(blocking), 0);
  off.assertClear('https://a.test/');
});

// ── Native engine end to end (local server) ────────────────────────────────
console.log('\nNative engine');

const hits: Record<string, number> = {};
const server = createServer((req, res) => {
  const path = req.url || '/';
  hits[path] = (hits[path] || 0) + 1;
  if (path === '/challenge') {
    res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge', server: 'cloudflare' });
    // A script that never finishes: must not be executed for a blocking challenge
    res.end(page('<title>Just a moment...</title>', '<script>window._cf_chl_opt={};while(true){}</script>'));
  } else if (path === '/gate') {
    if ((req.headers.cookie || '').includes('passed=1')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page('<title>Real page</title>', '<h1>Inventory</h1>'));
    } else {
      // Stand-in for a check only a person completes: a button the "human" clicks
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      res.end(page('<title>Just a moment...</title>', '<button id="human" onclick="document.cookie=\'passed=1; path=/\'; location.reload()">I am here</button>'));
    }
  } else if (path === '/form') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('<title>Sign in</title>', '<form action="/welcome" method="get"><div class="g-recaptcha" data-sitekey="k"></div><button id="go">Go</button></form>'));
  } else if (path.startsWith('/welcome')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('<title>Welcome</title>'));
  } else if (path === '/limited') {
    res.writeHead(429, { 'content-type': 'text/html', 'retry-after': '2' });
    res.end(page('<title>Too Many Requests</title>'));
  } else if (path === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('<title>Login</title><script src="https://www.google.com/recaptcha/api.js"></script>', '<form><input name="u"><div class="g-recaptcha" data-sitekey="k"></div><button>Go</button></form>'));
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('<title>Home</title>'));
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  await test('blocking challenge: scripts skipped, signal set, host paused', async () => {
    const browser = new MemoraBrowser({ network: { challengeCooldownSec: 60 } });
    const p = browser.newPage();
    const t0 = Date.now();
    const res = await p.goto(`${base}/challenge`, 5000);
    assert.ok(Date.now() - t0 < 2000, 'goto should not wait on the challenge script');
    assert.equal(res.status, 403);
    assert.equal(p.lastChallenge?.vendor, 'cloudflare');
    assert.equal(p.lastChallengeCooldownSec, 60);
    assert.equal(p.title(), 'Just a moment...');
    await assert.rejects(() => p.goto(`${base}/`), ChallengeCooldownError);
    assert.equal(hits['/'] ?? 0, 0, 'no request may reach the paused host');
    browser.close();
  });

  await test('429 uses Retry-After for the pause', async () => {
    const browser = new MemoraBrowser({});
    const p = browser.newPage();
    await p.goto(`${base}/limited`);
    assert.equal(p.lastChallenge?.kind, 'rate_limited');
    assert.equal(p.lastChallengeCooldownSec, 2);
    browser.close();
  });

  await test('embedded widget: page loads normally, no pause', async () => {
    const browser = new MemoraBrowser({});
    const p = browser.newPage();
    await p.goto(`${base}/login`);
    assert.equal(p.lastChallenge?.kind, 'captcha');
    assert.equal(p.lastChallengeCooldownSec, 0);
    await p.goto(`${base}/`);
    assert.equal(p.lastChallenge, null);
    browser.close();
  });

  await test('MCP memora_browse returns CHALLENGE block instead of content', async () => {
    const mcp = new MCPServer({}, 'native');
    const out: string = await (mcp as any).executeTool('memora_browse', { url: `${base}/challenge` });
    assert.match(out, /^# CHALLENGE DETECTED/);
    assert.match(out, /Vendor: cloudflare/);
    assert.match(out, /paused for 60s/);
    // Same session, same host: paused, no request sent
    await assert.rejects(() => (mcp as any).executeTool('memora_browse', { url: `${base}/login` }), ChallengeCooldownError);
    const fresh = new MCPServer({}, 'native');
    const login: string = await (fresh as any).executeTool('memora_browse', { url: `${base}/login` });
    assert.match(login, /^# CHALLENGE ON PAGE/);
    assert.match(login, /# Page Loaded: Login/);
  });
  // ── Stop mode (onChallenge: 'stop') ──────────────────────────────────────
  console.log('\nStop mode');

  await test('stop: blocking challenge throws ChallengeDetectedError with the signal', async () => {
    const browser = new MemoraBrowser({ network: { onChallenge: 'stop' } });
    const p = browser.newPage();
    const err = await p.goto(`${base}/challenge`).then(() => null, (e) => e);
    assert.ok(err instanceof ChallengeDetectedError, `got ${err}`);
    assert.equal(err.code, 'ERR_CHALLENGE_DETECTED');
    assert.equal(err.signal.vendor, 'cloudflare');
    assert.equal(err.cooldownSec, 60);
    assert.match(err.message, /^# CHALLENGE DETECTED/);
    assert.equal(p.challenge()?.vendor, 'cloudflare', 'signal stays readable on the page');
    browser.close();
  });

  await test('stop: embedded widget does not throw', async () => {
    const browser = new MemoraBrowser({ network: { onChallenge: 'stop' } });
    const p = browser.newPage();
    await p.goto(`${base}/login`);
    assert.equal(p.challenge()?.kind, 'captcha');
    browser.close();
  });

  await test('stop: MCP tool call returns the challenge as an error', async () => {
    const mcp = new MCPServer({ onChallenge: 'stop' }, 'native');
    const resp = await (mcp as any).handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memora_browse', arguments: { url: `${base}/challenge` } } });
    assert.equal(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /CHALLENGE DETECTED[\s\S]*Vendor: cloudflare/);
  });

  await test('CDP: Page.navigate maps stop → ERR_BLOCKED_BY_RESPONSE, cooldown → ERR_BLOCKED_BY_CLIENT', async () => {
    const { default: WebSocket } = await import('ws');
    const browser = new MemoraBrowser({ port: 9412, network: { onChallenge: 'stop' } });
    const cdp = new CDPServer(browser);
    await cdp.start();
    const p = browser.newPage();
    const ws = new WebSocket('ws://127.0.0.1:9412/devtools/browser/memora-root');
    await new Promise((r) => ws.once('open', r));
    let id = 0;
    const call = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
      const myId = ++id;
      const onMsg = (raw: any) => {
        const msg = JSON.parse(String(raw));
        if (msg.id === myId) { ws.off('message', onMsg); resolve(msg); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
    });
    const { result } = await call('Target.attachToTarget', { targetId: p.id, flatten: true });
    const blocked = await call('Page.navigate', { url: `${base}/challenge` }, result.sessionId);
    assert.equal(blocked.result.errorText, 'net::ERR_BLOCKED_BY_RESPONSE');
    const paused = await call('Page.navigate', { url: `${base}/` }, result.sessionId);
    assert.equal(paused.result.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
    ws.close();
    await cdp.stop();
    browser.close();
  });

  await test('MCP stdio: each response ends with a real newline (clients split on \\n)', async () => {
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', '--mcp', '--engine', 'native'], {
        env: { ...process.env, ORBIS_NO_TELEMETRY: '1' },
      });
      let text = '';
      p.stdout.on('data', (d) => (text += d));
      p.on('exit', () => resolve(text));
      p.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    });
    const lines = out.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, JSON.stringify(out.slice(-80)));
    assert.equal(JSON.parse(lines[1]).id, 2);
  });

  // ── REST API and Python SDK ──────────────────────────────────────────────
  console.log('\nREST API / Python SDK');

  const reportBrowser = new MemoraBrowser({ port: 9413 });
  const reportDaemon = new CDPServer(reportBrowser);
  const stopBrowser = new MemoraBrowser({ port: 9414, network: { onChallenge: 'stop' } });
  const stopDaemon = new CDPServer(stopBrowser);
  await reportDaemon.start();
  await stopDaemon.start();
  try {
    await test('REST /orbis/goto: report → 200 + challenge, cooldown → 429 + Retry-After', async () => {
      const r1 = await fetch(`http://127.0.0.1:9413/orbis/goto?url=${encodeURIComponent(`${base}/challenge`)}`);
      assert.equal(r1.status, 200);
      const b1: any = await r1.json();
      assert.equal(b1.challenge.vendor, 'cloudflare');
      assert.equal(b1.challengeCooldownSec, 60);
      const snap: any = await (await fetch('http://127.0.0.1:9413/orbis/snapshot')).json();
      assert.equal(snap.challenge.kind, 'interstitial');
      const r2 = await fetch(`http://127.0.0.1:9413/orbis/goto?url=${encodeURIComponent(`${base}/`)}`);
      assert.equal(r2.status, 429);
      assert.ok(Number(r2.headers.get('retry-after')) > 0);
      assert.equal(((await r2.json()) as any).code, 'ERR_CHALLENGE_COOLDOWN');
    });

    await test('REST /orbis/goto: stop → 409 ERR_CHALLENGE_DETECTED', async () => {
      const r = await fetch(`http://127.0.0.1:9414/orbis/goto?url=${encodeURIComponent(`${base}/challenge`)}`);
      assert.equal(r.status, 409);
      const b: any = await r.json();
      assert.equal(b.code, 'ERR_CHALLENGE_DETECTED');
      assert.equal(b.challenge.vendor, 'cloudflare');
    });

    const python = await new Promise<string | null>((resolve) => {
      const p = spawn(process.platform === 'win32' ? 'python' : 'python3', ['--version']);
      p.on('error', () => resolve(null));
      p.on('exit', (code) => resolve(code === 0 ? (process.platform === 'win32' ? 'python' : 'python3') : null));
    });
    if (!python) {
      console.log('  - skipped Python SDK test: no python on PATH');
    } else {
      await test('Python SDK: snapshot.challenge, ChallengeDetectedError, ChallengeCooldownError', async () => {
        // Fresh daemons: the cooldown from the REST tests above must not leak in
        const rb = new MemoraBrowser({ port: 9415 });
        const rd = new CDPServer(rb);
        const sb = new MemoraBrowser({ port: 9416, network: { onChallenge: 'stop' } });
        const sd = new CDPServer(sb);
        await rd.start();
        await sd.start();
        try {
          const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
            const p = spawn(python, ['tests/test_challenge_python.py', 'http://127.0.0.1:9415', 'http://127.0.0.1:9416', base]);
            let text = '';
            p.stdout.on('data', (d) => (text += d));
            p.stderr.on('data', (d) => (text += d));
            p.on('exit', (code) => resolve({ code, text }));
          });
          assert.equal(out.code, 0, out.text);
          assert.match(out.text, /PYTHON_OK/);
        } finally {
          await rd.stop();
          await sd.stop();
          rb.close();
          sb.close();
        }
      });
    }
  } finally {
    await reportDaemon.stop();
    await stopDaemon.stop();
    reportBrowser.close();
    stopBrowser.close();
  }

  // ── Human handoff ────────────────────────────────────────────────────────
  // Chrome runs headless here and the test plays the person (clicks the button). The real
  // feature opens a visible window.
  console.log('\nHuman handoff');

  await test('unavailable: reports the reason, opens nothing', async () => {
    const h = new HumanHandoff({}, { available: () => 'no display' });
    const st = await h.start(`${base}/gate`);
    assert.equal(st.state, 'unavailable');
    assert.equal(st.reason, 'no display');
  });

  if (!findSystemChrome()) {
    console.log('  - skipped Chrome handoff tests: no Chrome/Edge installed');
  } else {
    const waitFor = async (fn: () => Promise<boolean>, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('condition not met in time');
    };

    await test('MCP: blocked → handoff start → person completes → session continues in Chrome', async () => {
      let human: ChromeEngine | null = null;
      const mcp = new MCPServer({ onChallenge: 'stop' }, 'native', {
        handoffAvailable: () => null,
        handoffEngineFactory: (n) => (human = new ChromeEngine(n)),
      });
      const call = async (name: string, args: any) => {
        const r = await (mcp as any).handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
        return r.result.content[0].text as string;
      };
      const blocked = await call('memora_browse', { url: `${base}/gate` });
      assert.match(blocked, /CHALLENGE DETECTED[\s\S]*memora_handoff/);

      const started = await call('memora_handoff', { action: 'start' });
      assert.match(started, /Handoff started: a Chrome window is open at .*\/gate/);
      assert.match(await call('memora_handoff', { action: 'status' }), /Handoff state: waiting/);

      await human!.evaluate(`document.getElementById('human').click()`);
      let out = '';
      await waitFor(async () => /Handoff resolved/.test(out = await call('memora_handoff', { action: 'status' })));
      assert.match(out, /Page Title: "Real page"/);

      // Same host right after: no cooldown carried over, served by the handed-over Chrome window
      const after = await call('memora_browse', { url: `${base}/gate` });
      assert.match(after, /# Page Loaded: Real page/);
      await mcp.close();
    });

    await test('cancel closes the window', async () => {
      let human: ChromeEngine | null = null;
      const h = new HumanHandoff({}, { available: () => null, engineFactory: (n) => (human = new ChromeEngine(n)) });
      assert.equal((await h.start(`${base}/gate`)).state, 'waiting');
      assert.equal((await h.cancel()).state, 'cancelled');
      await waitFor(async () => human!.isClosed());
      assert.throws(() => h.take());
    });

    await test('timeout expires the handoff and closes the window', async () => {
      let human: ChromeEngine | null = null;
      const h = new HumanHandoff({}, { timeoutSec: 1, available: () => null, engineFactory: (n) => (human = new ChromeEngine(n)) });
      await h.start(`${base}/gate`);
      await new Promise((r) => setTimeout(r, 1500));
      const st = await h.status();
      assert.equal(st.state, 'expired');
      await waitFor(async () => human!.isClosed());
    });

    await test('embedded widget: resolves only after the person submits', async () => {
      let human: ChromeEngine | null = null;
      const h = new HumanHandoff({}, { available: () => null, engineFactory: (n) => (human = new ChromeEngine(n)) });
      const initial = detectChallenge({ url: `${base}/form`, status: 200, headers: {}, html: '<div class="g-recaptcha"></div>' });
      await h.start(`${base}/form`, initial);
      assert.equal((await h.status()).state, 'waiting', 'widget page alone is not "done"');
      await human!.evaluate(`document.getElementById('go').click()`);
      await waitFor(async () => (await h.status()).state === 'resolved');
      const engine = h.take();
      assert.match(await engine.html('title'), /Welcome/);
      await engine.close();
    });
  }
} finally {
  server.close();
}

console.log(`\n${passed} passed\n`);
process.exit(0);
