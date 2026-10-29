/**
 * robots.txt support (--obey-robots, RFC 9309)
 *   npm run test:robots
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RobotsRules, RobotsBlockedError } from '../src/network/robots.js';
import { MemoraBrowser } from '../src/engine/browser.js';
import { CDPServer } from '../src/cdp/server.js';

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

// ── Parser ────────────────────────────────────────────────────────────────
console.log('\nParser (RFC 9309)');

await test('no matching rule → allowed', () => {
  const r = RobotsRules.parse('User-agent: *\nDisallow: /private/');
  assert.equal(r.isAllowed('https://a.test/public/x'), true);
  assert.equal(r.isAllowed('https://a.test/private/x'), false);
});

await test('longest match wins, allow wins ties', () => {
  const r = RobotsRules.parse('User-agent: *\nDisallow: /shop/\nAllow: /shop/public\nDisallow: /a\nAllow: /a');
  assert.equal(r.isAllowed('https://a.test/shop/cart'), false);
  assert.equal(r.isAllowed('https://a.test/shop/public/item'), true);
  assert.equal(r.isAllowed('https://a.test/a/b'), true);
});

await test('"*" wildcard and "$" end anchor', () => {
  const r = RobotsRules.parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache');
  assert.equal(r.isAllowed('https://a.test/docs/file.pdf'), false);
  assert.equal(r.isAllowed('https://a.test/docs/file.pdf?x=1'), true);
  assert.equal(r.isAllowed('https://a.test/tmp-1/cache/x'), false);
  assert.equal(r.isAllowed('https://a.test/tmp-1/other'), true);
});

await test('query string is part of the matched path', () => {
  const r = RobotsRules.parse('User-agent: *\nDisallow: /search?q=');
  assert.equal(r.isAllowed('https://a.test/search?q=shoes'), false);
  assert.equal(r.isAllowed('https://a.test/search'), true);
});

await test('agent groups: case-insensitive, merged, fall back to "*"', () => {
  const txt = [
    'User-agent: *', 'Disallow: /',
    '', 'User-agent: memorabrowser', 'Disallow: /admin',
    '', 'User-agent: Googlebot', 'User-agent: MEMORABROWSER', 'Disallow: /drafts',
  ].join('\n');
  const r = RobotsRules.parse(txt);
  assert.equal(r.isAllowed('https://a.test/page', 'MemoraBrowser'), true);
  assert.equal(r.isAllowed('https://a.test/admin', 'MemoraBrowser'), false);
  assert.equal(r.isAllowed('https://a.test/drafts/1', 'MemoraBrowser'), false);
  assert.equal(r.isAllowed('https://a.test/page', 'OtherBot'), false);
});

await test('empty Disallow, comments, unknown keys and /robots.txt', () => {
  const r = RobotsRules.parse('# hi\nUser-agent: * # all\nCrawl-delay: 5\nDisallow:\nSitemap: https://a.test/s.xml');
  assert.equal(r.isAllowed('https://a.test/anything'), true);
  const all = RobotsRules.parse('User-agent: *\nDisallow: /');
  assert.equal(all.isAllowed('https://a.test/robots.txt'), true);
});

await test('percent-encoding is normalised', () => {
  const r = RobotsRules.parse('User-agent: *\nDisallow: /caf%c3%a9\nDisallow: /%7Euser');
  assert.equal(r.isAllowed('https://a.test/café'), false);
  assert.equal(r.isAllowed('https://a.test/~user/x'), false);
});

// ── Engine ────────────────────────────────────────────────────────────────
console.log('\nEngine (--obey-robots)');

const hits = { robots: 0, pages: 0 };
let robotsMode: 'rules' | '404' | '500' = 'rules';
const server = createServer(async (req, res) => {
  const url = req.url || '/';
  if (url === '/robots.txt') {
    hits.robots++;
    await new Promise((r) => setTimeout(r, 50)); // keep the fetch in flight for singleflight
    if (robotsMode === '404') { res.writeHead(404); res.end(); return; }
    if (robotsMode === '500') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /private\nDisallow: /api/secret\n');
    return;
  }
  hits.pages++;
  if (url === '/redirect-to-private') { res.writeHead(302, { location: '/private/page' }); res.end(); return; }
  if (url === '/fetches-secret') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><script>
      fetch('/api/secret').then(() => { window.result = 'loaded' }, (e) => { window.result = e.name });
    </script></body></html>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><head><title>${url}</title></head><body><a href="/private">p</a></body></html>`);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

await test('allowed page loads, disallowed page throws RobotsBlockedError', async () => {
  const browser = new MemoraBrowser({ network: { obeyRobots: true } });
  const page = browser.newPage();
  await page.goto(`${base}/public`);
  assert.equal(page.title(), '/public');
  await assert.rejects(page.goto(`${base}/private/x`), (e: any) => e instanceof RobotsBlockedError && e.code === 'ERR_BLOCKED_BY_ROBOTS');
  browser.close();
});

await test('singleflight: 20 concurrent pages fetch robots.txt once per session', async () => {
  hits.robots = 0;
  const browser = new MemoraBrowser({ network: { obeyRobots: true } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => browser.newPage().goto(`${base}/page-${i}`)));
  await browser.newPage().goto(`${base}/later`);
  assert.equal(hits.robots, 1);
  browser.close();
});

await test('redirect into a disallowed path is blocked before it is requested', async () => {
  const browser = new MemoraBrowser({ network: { obeyRobots: true } });
  const before = hits.pages;
  await assert.rejects(browser.newPage().goto(`${base}/redirect-to-private`), RobotsBlockedError);
  assert.equal(hits.pages, before + 1); // only the redirect itself hit the server
  browser.close();
});

await test('page fetch() to a disallowed URL is blocked', async () => {
  const browser = new MemoraBrowser({ network: { obeyRobots: true } });
  const page = browser.newPage();
  await page.goto(`${base}/fetches-secret`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(page.evaluate('window.result').result.value, 'RobotsBlockedError');
  browser.close();
});

await test('robots.txt 404 → everything allowed; 500 → everything blocked', async () => {
  robotsMode = '404';
  let browser = new MemoraBrowser({ network: { obeyRobots: true } });
  await browser.newPage().goto(`${base}/private/x`);
  browser.close();

  robotsMode = '500';
  browser = new MemoraBrowser({ network: { obeyRobots: true } });
  await assert.rejects(browser.newPage().goto(`${base}/public`), RobotsBlockedError);
  browser.close();
  robotsMode = 'rules';
});

await test('without --obey-robots nothing is checked', async () => {
  hits.robots = 0;
  const browser = new MemoraBrowser();
  await browser.newPage().goto(`${base}/private/x`);
  assert.equal(hits.robots, 0);
  browser.close();
});

await test('CDP: Page.navigate reports net::ERR_BLOCKED_BY_CLIENT like Chrome', async () => {
  const { default: WebSocket } = await import('ws');
  const browser = new MemoraBrowser({ port: 9411, network: { obeyRobots: true } });
  const cdp = new CDPServer(browser);
  await cdp.start();
  const page = browser.newPage();
  const ws = new WebSocket('ws://127.0.0.1:9411/devtools/browser/memora-root');
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
  const { result } = await call('Target.attachToTarget', { targetId: page.id, flatten: true });
  const ok = await call('Page.navigate', { url: `${base}/public` }, result.sessionId);
  assert.equal(ok.result.errorText, undefined);
  const blocked = await call('Page.navigate', { url: `${base}/private/x` }, result.sessionId);
  assert.equal(blocked.result.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
  ws.close();
  await cdp.stop();
  browser.close();
});

server.close();
console.log(`\n${passed} robots.txt tests passed\n`);
process.exit(0);
