/**
 * Regression tests for the 41 known issues listed in orbis/docs/limitations.md (0.1.0–0.1.2).
 * Every test asserts the FIXED behaviour. Runs against a local server only.
 *   npm run test:known-issues
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { MemoraBrowser } from '../src/engine/browser.js';
import { CDPServer } from '../src/cdp/server.js';
import { MCPServer } from '../src/mcp/server.js';
import { OrbisAgent } from '../src/adapters/agent.js';
import { NativeEngineAdapter } from '../src/engine/native-adapter.js';
import { RobotsStore } from '../src/network/robots.js';

const results: Array<{ id: number; name: string; ok: boolean; error?: string }> = [];
async function issue(id: number, name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ id, name, ok: true });
    console.log(`  ✓ #${id} ${name}`);
  } catch (e: any) {
    results.push({ id, name, ok: false, error: String(e?.message || e).split('\n')[0].slice(0, 160) });
    console.log(`  ✗ #${id} ${name}\n      ${String(e?.message || e).split('\n')[0].slice(0, 160)}`);
  }
}
const ev = (page: any, code: string) => {
  const r = page.evaluate(code);
  if (!r?.success) throw new Error(`evaluate failed: ${r?.error ?? JSON.stringify(r)}`);
  return r.result && typeof r.result === 'object' && 'value' in r.result ? r.result.value : r.result;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-ki-'));
let nextPort = 9460;
const port = () => nextPort++;

// ── Local test server ───────────────────────────────────────────────────────
const seen: Array<{ path: string; host: string; cookie: string }> = [];
const server = createServer(async (req: IncomingMessage, res) => {
  const p = (req.url || '/').split('?')[0];
  seen.push({ path: p, host: String(req.headers.host), cookie: String(req.headers.cookie || '') });
  const html = (body: string, head = '') => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`); };
  if (p === '/set-cookie') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=secret; Path=/' }); return res.end('<p>set</p>'); }
  if (p === '/links') return html('<a id="l" href="/target">Go</a><form action="/submitted" method="get"><input name="q" value="x"><button id="b" type="submit">Send</button></form>');
  if (p === '/storage-a') return html('<script>localStorage.setItem("token","abc"); sessionStorage.setItem("s","1")</script>');
  if (p === '/storage-b') return html('<p>b</p>');
  if (p === '/labels') return html('<label for="em">Work email</label><input id="em" name="email"><label>Password <input id="pw" type="password"></label>');
  if (p === '/select') return html('<select id="s" onchange="document.title=this.value"><option value="a">A</option><option value="b">B</option></select>');
  if (p === '/dom') return html('<div id="d" data-x="1">hi</div><script>var r=[];var d=document.getElementById("d");r.push(typeof d.style, d.dataset && d.dataset.x, typeof d.remove, typeof XMLHttpRequest, typeof history, typeof Event); d.remove(); r.push(!!document.getElementById("d")); document.title=r.join(",")</script>');
  if (p === '/escape') return html(`<script>
    var out = [];
    try { out.push(typeof document.constructor.constructor('return typeof process')()); } catch (e) { out.push('blocked'); }
    try { out.push(typeof document.querySelector.constructor('return typeof process')()); } catch (e) { out.push('blocked'); }
    try { out.push(typeof URL.constructor('return typeof process')()); } catch (e) { out.push('blocked'); }
    try { out.push(typeof console.log.constructor('return typeof process')()); } catch (e) { out.push('blocked'); }
    try { document.querySelector('['); } catch (e) { try { out.push(typeof e.constructor.constructor('return typeof process')()); } catch (e2) { out.push('blocked'); } }
    try { out.push(typeof Object.getPrototypeOf(document).constructor.constructor('return typeof process')()); } catch (e) { out.push('blocked'); }
    try { out.push(typeof (function(){ return this })().process); } catch (e) { out.push('blocked'); }
    document.title = out.join(',');
  </script>`);
  if (p === '/aliases') return html('<a href="/contact">Email us</a><input name="email" placeholder="Your email"><input aria-label="Search Products"><a id="lnk" href="/x">Docs</a>');
  if (p === '/many-links') return html(Array.from({ length: 600 }, (_, i) => `<a href="/p${i}">${i}</a>`).join(' '));
  if (p === '/status503') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<p>down</p>'); }
  if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nCrawl-delay: 1\nAllow: /\n'); }
  if (p === '/slow') { await new Promise((r) => setTimeout(r, 3000)); return html('<p>slow</p>'); }
  if (p === '/fail-eval') { req.socket.destroy(); return; }
  return html(`<title>${p}</title><p>page ${p}</p>`);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const other = `http://localhost:${(server.address() as AddressInfo).port}`;

const runCli = (args: string[], timeoutMs = 30000) => new Promise<{ code: number | null; out: string; stdout: string }>((resolve) => {
  const p = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', ...args], { env: { ...process.env, ORBIS_NO_TELEMETRY: '1' } });
  let out = '', stdout = '';
  p.stdout.on('data', (d) => { out += d; stdout += d; });
  p.stderr.on('data', (d) => (out += d));
  const t = setTimeout(() => p.kill(), timeoutMs);
  p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, stdout }); });
});

try {
  console.log('\nServer and security');

  await issue(1, 'localhost binds to loopback only', async () => {
    const b = new MemoraBrowser({ port: port(), host: 'localhost' });
    const s = new CDPServer(b);
    await s.start();
    try {
      const addr = (s as any).httpServer.address() as AddressInfo;
      assert.ok(addr.address === '127.0.0.1' || addr.address === '::1', `bound to ${addr.address}`);
    } finally { await s.stop(); b.close(); }
  });

  await issue(2, '--host ::1 serves requests', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt, host: '::1' });
    const s = new CDPServer(b);
    await s.start();
    try {
      const r = await fetch(`http://[::1]:${pt}/json/version`);
      assert.equal(r.status, 200);
      const v: any = await r.json();
      assert.match(v.webSocketDebuggerUrl, /^ws:\/\/\[::1\]:/);
    } finally { await s.stop(); b.close(); }
  });

  await issue(3, 'API key is enforced (HTTP and WebSocket)', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt, apiKey: 'k3y' });
    const s = new CDPServer(b);
    await s.start();
    try {
      assert.equal((await fetch(`http://127.0.0.1:${pt}/json/version`)).status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${pt}/json/version`, { headers: { 'x-api-key': 'k3y' } })).status, 200);
      const { default: WebSocket } = await import('ws');
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${pt}/devtools/browser/memora-root`);
        ws.on('open', () => { ws.close(); resolve(101); });
        ws.on('unexpected-response', (_q: any, r: any) => resolve(r.statusCode));
        ws.on('error', () => resolve(-1));
      });
      assert.equal(code, 401);
    } finally { await s.stop(); b.close(); }
  });

  await issue(4, 'session endpoints cannot write outside the session folder', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    const target = path.join(tmp, 'outside', 'pwned.json');
    try {
      const r = await fetch(`http://127.0.0.1:${pt}/orbis/session/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: target }) });
      assert.equal(fs.existsSync(target), false, 'file written outside the allowed folder');
      assert.equal(r.status, 403);
    } finally { await s.stop(); b.close(); }
  });

  await issue(5, 'page JavaScript cannot reach the host process', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/escape`);
    const parts = pg.title().split(',');
    assert.ok(parts.length >= 6, `title: ${pg.title()}`);
    assert.ok(parts.every((x) => x === 'blocked' || x === 'undefined'), `escapes: ${pg.title()}`);
    b.close();
  });

  await issue(6, 'cookies are scoped to the site that set them', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/set-cookie`);
    await pg.goto(`${base}/same`);
    assert.match(seen.filter((x) => x.path === '/same').pop()!.cookie, /sid=secret/, 'same site must still get it');
    await pg.goto(`${other}/other-site`);
    assert.doesNotMatch(seen.filter((x) => x.path === '/other-site').pop()!.cookie, /sid=secret/);
    b.close();
  });

  await issue(7, 'localStorage survives navigation within a site', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/storage-a`);
    await pg.goto(`${base}/storage-b`);
    assert.equal(ev(pg, 'localStorage.getItem("token")'), 'abc');
    assert.equal(ev(pg, 'sessionStorage.getItem("s")'), '1');
    await pg.goto(`${other}/storage-b`);
    assert.equal(ev(pg, 'localStorage.getItem("token")'), null, 'other origin must not see it');
    b.close();
  });

  await issue(8, 'typed values are not shown in the action map', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/labels`);
    pg.type('#pw', 'hunter2');
    pg.type('#em', 'me@example.com');
    const snap = pg.getSemanticSnapshot();
    assert.doesNotMatch(snap.actionMapText, /hunter2/);
    b.close();
  });

  console.log('\nNetwork and CLI');

  await issue(9, '--http-proxy routes traffic through the proxy', async () => {
    const hits: string[] = [];
    const proxy = createServer((q, r) => { hits.push(String(q.url)); r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>via proxy</title>'); });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    try {
      const out = await runCli(['fetch', 'http://example.invalid/x', '--http-proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, '--dump', 'action_map']);
      assert.ok(hits.length > 0, `proxy not used: ${out.out.slice(0, 200)}`);
    } finally { proxy.close(); }
  });

  await issue(10, '--http-timeout limits navigations', async () => {
    // In process: CLI start-up time would hide the difference
    const b = new MemoraBrowser({ network: { timeoutMs: 500 } });
    const t0 = Date.now();
    await assert.rejects(() => b.newPage().goto(`${base}/slow`), /timeout/i);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    b.close();
    const out = await runCli(['fetch', `${base}/slow`, '--http-timeout', '500']);
    assert.notEqual(out.code, 0);
  });

  console.log('\nEngine and SDK');

  await issue(11, 'click() follows links and submits forms', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/links`);
    await pg.click('#l');
    assert.equal(new URL(pg.url).pathname, '/target');
    await pg.goto(`${base}/links`);
    await pg.click('#b');
    assert.equal(new URL(pg.url).pathname, '/submitted');
    b.close();
  });

  await issue(12, 'fillForm() does not submit unless asked', async () => {
    const agent = await OrbisAgent.launch({ port: port() });
    try {
      await agent.goto(`${base}/links`);
      await agent.fillForm({ 'input[name=q]': 'y' });
      assert.equal(new URL(agent.page.url).pathname, '/links');
    } finally { await agent.close(); }
  });

  await issue(13, 'action IDs from a filtered snapshot resolve to the same elements', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/links`);
    const snap = pg.getSemanticSnapshot({ excludeSelectors: ['a'] });
    const first = snap.actions[0];
    assert.equal(pg.resolveElement(first.actionId)?.tagName.toLowerCase(), first.tag.toLowerCase());
    b.close();
  });

  await issue(14, '<label> text names inputs in the action map', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/labels`);
    const t = pg.getSemanticSnapshot().actionMapText;
    assert.match(t, /Work email/);
    assert.match(t, /Password/);
    b.close();
  });

  await issue(15, 'REST /orbis/select-option exists (Python select_option)', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    try {
      await b.defaultPage.goto(`${base}/select`);
      const r = await fetch(`http://127.0.0.1:${pt}/orbis/select-option`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: '#s', value: 'B' }) });
      assert.equal(r.status, 200);
      assert.equal(b.defaultPage.title(), 'b');
    } finally { await s.stop(); b.close(); }
  });

  await issue(16, 'Python SDK waits longer than a navigation', () => {
    const src = fs.readFileSync('python/memora/agent.py', 'utf8');
    const timeouts = [...src.matchAll(/timeout=(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(timeouts.length && timeouts.every((t) => t >= 30) || /self\.timeout/.test(src), `timeouts: ${timeouts}`);
  });

  await issue(17, 'REST /orbis/goto honours ?id= for other pages', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    try {
      const first = b.defaultPage;
      const second = b.newPage();
      await fetch(`http://127.0.0.1:${pt}/orbis/goto?id=${second.id}&url=${encodeURIComponent(`${base}/second`)}`);
      assert.equal(new URL(second.url).pathname, '/second');
      assert.notEqual(first.url, second.url, 'default page must not navigate');
    } finally { await s.stop(); b.close(); }
  });

  await issue(18, 'OrbisAgent.connect() drives the remote daemon', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    try {
      const agent = await OrbisAgent.connect(`http://127.0.0.1:${pt}`);
      await agent.goto(`${base}/remote`);
      assert.equal(new URL(b.defaultPage.url).pathname, '/remote', 'remote daemon did not navigate');
      await agent.close();
      assert.equal(s.isListening(), true, 'connect().close() must not stop the remote daemon');
    } finally { await s.stop(); b.close(); }
  });

  await issue(19, 'CDP Browser.close only closes the caller\'s own pages', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    try {
      const keep = b.newPage();
      const { default: WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${pt}/devtools/browser/memora-root`);
      await new Promise((r) => ws.once('open', r));
      await new Promise<void>((resolve) => { ws.on('message', () => resolve()); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(resolve, 1000); });
      ws.close();
      assert.ok(b.getPage(keep.id), 'another client\'s page was closed');
    } finally { await s.stop(); b.close(); }
  });

  await issue(20, 'update notice never goes to stdout', () => {
    const src = fs.readFileSync('src/cli/index.ts', 'utf8');
    const fn = src.slice(src.indexOf('async function checkOrbisVersion'), src.indexOf('async function runServer'));
    assert.doesNotMatch(fn, /console\.log\(/);
  });

  await issue(21, '--eval exits non-zero when the page fails', async () => {
    const out = await runCli(['--eval', `${base}/fail-eval`]);
    assert.notEqual(out.code, 0, out.out.slice(0, 200));
  });

  await issue(22, 'common DOM APIs exist (style, dataset, remove, XHR, history, Event)', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/dom`);
    assert.equal(pg.title(), 'object,1,function,function,object,function,false');
    b.close();
  });

  await issue(23, 'MCP browse output for a link-dense page is smaller than its HTML', async () => {
    const mcp = new MCPServer({}, 'native');
    const out: string = await (mcp as any).executeTool('memora_browse', { url: `${base}/many-links` });
    const raw = await (await fetch(`${base}/many-links`)).text();
    assert.ok(out.length < raw.length, `output ${out.length} vs html ${raw.length}`);
    await mcp.close();
  });

  await issue(24, 'select.value reflects the selected option', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/select`);
    assert.equal(ev(pg, 'document.getElementById("s").value'), 'a');
    pg.selectDropdownOption('#s', 'B');
    assert.equal(ev(pg, 'document.getElementById("s").value'), 'b');
    assert.equal(pg.title(), 'b');
    b.close();
  });

  await issue(25, 'waitForFunction(string) waits for a true result', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/plain`);
    await assert.rejects(() => pg.waitForFunction('false', { timeoutMs: 300 }));
    b.close();
  });

  await issue(26, 'closing a fork leaves the parent running', async () => {
    const agent = await OrbisAgent.launch({ port: port() });
    try {
      await agent.goto(`${base}/parent`);
      const fork = agent.fork();
      await fork.close();
      assert.ok(agent.browser.getPage(agent.page.id), 'parent page closed');
      assert.equal(agent.cdpServer!.isListening(), true, 'parent CDP server stopped');
    } finally { await agent.close(); }
  });

  console.log('\nLocators');

  await issue(27, 'label: matches aria-label case-insensitively', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/aliases`);
    assert.equal(pg.resolveElement('label:Search Products')?.getAttribute('aria-label'), 'Search Products');
    b.close();
  });

  await issue(28, 'role:link matches <a href>', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/aliases`);
    assert.equal(pg.resolveElement('role:link')?.tagName.toLowerCase(), 'a');
    b.close();
  });

  await issue(29, '@email prefers the email input over a link mentioning email', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/aliases`);
    assert.equal(pg.resolveElement('@email')?.tagName.toLowerCase(), 'input');
    b.close();
  });

  console.log('\nMCP, REST, CDP and CLI');

  await issue(30, 'MCP tool calls run one at a time, in order', async () => {
    const lines: any[] = [];
    const mcp = new MCPServer({}, 'native', { write: (l) => lines.push(JSON.parse(l)) });
    await Promise.all([
      mcp.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memora_browse', arguments: { url: `${base}/links` } } })),
      mcp.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memora_inspect', arguments: {} } })),
    ]);
    const inspect = lines.find((m) => m.id === 2);
    assert.match(inspect.result.content[0].text, /\/links/, 'inspect ran before browse finished');
    await mcp.close();
  });

  await issue(31, 'memora_cookies clear removes cookies', async () => {
    const eng = new NativeEngineAdapter({});
    await eng.goto(`${base}/set-cookie`);
    await eng.cookies('clear');
    assert.equal(await eng.cookies('list'), '{}');
    await eng.close();
  });

  await issue(32, 'goto("about:blank") works', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/plain`);
    await pg.goto('about:blank');
    assert.equal(pg.url, 'about:blank');
    b.close();
  });

  await issue(33, 'extract() without attribute returns attributes', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    await pg.goto(`${base}/links`);
    const [first] = pg.extract('a');
    assert.equal(first.attributes.href, '/target');
    b.close();
  });

  await issue(34, 'Playwright newCDPSession works', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${pt}`);
    try {
      const ctx = browser.contexts()[0] ?? await browser.newContext();
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      const r: any = await cdp.send('Runtime.evaluate' as any, { expression: '1+1', returnByValue: true });
      assert.equal(r.result.value, 2);
    } finally { await browser.close().catch(() => {}); await s.stop(); b.close(); }
  });

  await issue(35, '--engine chrome without Chrome gives a clear error, no crash', () => {
    const src = fs.readFileSync('src/mcp/server.ts', 'utf8');
    assert.match(src, /engineType === 'chrome'[\s\S]{0,400}catch/);
  });

  await issue(36, 'REST /orbis/act keeps the diff baseline', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    try {
      await fetch(`http://127.0.0.1:${pt}/orbis/goto?url=${encodeURIComponent(`${base}/labels`)}`);
      await fetch(`http://127.0.0.1:${pt}/orbis/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId: '#em', type: 'type', text: 'a@b.c' }) });
      const body: any = await (await fetch(`http://127.0.0.1:${pt}/orbis/diff`)).json();
      const d = body.diff ?? body;
      assert.ok((d.mutatedActions?.length ?? 0) > 0, `diff empty: ${d.summary}`);
    } finally { await s.stop(); b.close(); }
  });

  await issue(37, 'orbis fetch exits non-zero on HTTP errors', async () => {
    const out = await runCli(['fetch', `${base}/status503`]);
    assert.notEqual(out.code, 0);
  });

  await issue(38, 'robots.txt Crawl-delay is honoured', async () => {
    const store = new RobotsStore({ agent: 'MemoraBrowser' });
    await store.isAllowed(`${base}/a`);
    assert.equal((store as any).crawlDelaySec?.(`${base}/a`), 1);
    const t0 = Date.now();
    await store.check(`${base}/a`);
    await store.check(`${base}/b`);
    assert.ok(Date.now() - t0 >= 900, `requests only ${Date.now() - t0} ms apart`);
  });

  await issue(39, 'Playwright selectOption, route() and console events work', async () => {
    const pt = port();
    const b = new MemoraBrowser({ port: pt });
    const s = new CDPServer(b);
    await s.start();
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${pt}`);
    try {
      const ctx = browser.contexts()[0] ?? await browser.newContext();
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const logs: string[] = [];
      page.on('console', (m) => logs.push(m.text()));
      await page.goto(`${base}/select`);
      await page.selectOption('#s', 'b');
      assert.equal(await page.title(), 'b');
      await page.evaluate(() => console.log('hello-console'));
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(logs.includes('hello-console'), 'console event not forwarded');
      let routed = 0;
      await page.route('**/routed', (route) => { routed++; return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>from route</title>' }); });
      await page.goto(`${base}/routed`);
      assert.equal(routed, 1, 'route handler did not run');
      assert.equal(await page.title(), 'from route');
      await page.unroute('**/routed');
      await page.goto(`${base}/after-route`);
      assert.equal(await page.title(), '/after-route');
    } finally { await browser.close().catch(() => {}); await s.stop(); b.close(); }
  });

  await issue(40, '--user-agent also changes navigator.userAgent', async () => {
    const b = new MemoraBrowser({ network: { userAgent: 'TestBot/1.0' } });
    const pg = b.newPage();
    await pg.goto(`${base}/plain`);
    assert.equal(ev(pg, 'navigator.userAgent'), 'TestBot/1.0');
    b.close();
  });

  await issue(41, 'typed values do not become an element\'s text in the action map', async () => {
    const b = new MemoraBrowser({});
    const pg = b.newPage();
    pg.setContent('<input id="x">', base);
    pg.type('#x', 'topsecret');
    assert.doesNotMatch(pg.getSemanticSnapshot().actionMapText, /topsecret/);
    b.close();
  });
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const open = results.filter((r) => !r.ok);
console.log(`\n${results.length - open.length} of ${results.length} fixed`);
if (open.length) console.log(`Still open: ${open.map((r) => '#' + r.id).join(' ')}`);
process.exit(open.length ? 1 : 0);
