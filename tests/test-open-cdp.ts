/**
 * CDP / REST gaps: cookie CDP methods, REST 405 on wrong method, /json/new?<url>.
 *   npx tsx tests/test-open-cdp.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoraBrowser } from '../src/engine/browser.js';
import { CDPServer } from '../src/cdp/server.js';

process.env.ORBIS_NO_TELEMETRY = '1';

let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e?.message || e).split('\n')[0]}`);
  }
}

const seen: Array<{ path: string; cookie: string }> = [];
const http = createServer((req, res) => {
  seen.push({ path: req.url || '/', cookie: String(req.headers.cookie || '') });
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!DOCTYPE html><html><head><title>Page ${req.url}</title></head><body><p>hi</p></body></html>`);
});
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

async function withOrbis(port: number, fn: () => Promise<void>) {
  const b = new MemoraBrowser({ port } as any);
  const s = new CDPServer(b as any);
  await s.start();
  try {
    await fn();
  } finally {
    await s.stop();
    b.close();
  }
}

await test('Playwright addCookies / cookies / clearCookies', () =>
  withOrbis(9480, async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9480');
    try {
      const ctx = browser.contexts()[0] || (await browser.newContext());
      await ctx.addCookies([{ name: 'k', value: 'v', url: base }]);
      const cookies = await ctx.cookies();
      const k = cookies.find((c) => c.name === 'k');
      assert.ok(k, 'cookie k listed: ' + JSON.stringify(cookies));
      assert.equal(k!.value, 'v');
      assert.equal(k!.domain, '127.0.0.1');
      const page = ctx.pages()[0] || (await ctx.newPage());
      seen.length = 0;
      await page.goto(base + '/c');
      assert.ok(seen.some((s) => s.path === '/c' && s.cookie.includes('k=v')), 'Cookie sent: ' + JSON.stringify(seen));
      await ctx.clearCookies();
      assert.deepEqual(await ctx.cookies(), []);

      // New isolated context
      const ctx2 = await browser.newContext();
      await ctx2.addCookies([{ name: 'a', value: '1', domain: '.example.com', path: '/' }]);
      const c2 = await ctx2.cookies();
      assert.equal(c2.length, 1);
      assert.equal(c2[0].domain, '.example.com');
      assert.equal((await ctx.cookies()).length, 0, 'contexts isolated');
      await ctx2.close();
    } finally {
      await browser.close();
    }
  }));

await test('REST wrong method returns 405 (no hang)', () =>
  withOrbis(9481, async () => {
    for (const [path, method, allow] of [
      ['/orbis/session', 'PUT', 'GET, POST'],
      ['/memora/session', 'DELETE', 'GET, POST'],
      ['/orbis/act', 'GET', 'POST'],
      ['/orbis/fill-form', 'PUT', 'POST'],
      ['/orbis/session/save', 'GET', 'POST'],
    ]) {
      const r = await fetch('http://127.0.0.1:9481' + path, { method, signal: AbortSignal.timeout(3000) });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.equal(r.headers.get('allow'), allow);
      const body = await r.json();
      assert.equal(body.code, 'ERR_METHOD_NOT_ALLOWED');
      assert.equal(body.error, 'Method not allowed');
    }
  }));

await test('/json/new?<url> navigates the new page', () =>
  withOrbis(9482, async () => {
    for (const [q, method] of [[`${base}/one`, 'PUT'], [`url=${encodeURIComponent(base + '/two')}`, 'GET']]) {
      const r = await fetch(`http://127.0.0.1:9482/json/new?${q}`, { method, signal: AbortSignal.timeout(5000) });
      assert.equal(r.status, 200);
      const t = await r.json();
      const p = q.includes('one') ? '/one' : '/two';
      assert.equal(t.url, base + p);
      assert.equal(t.title, 'Page ' + p);
    }
  }));

http.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
