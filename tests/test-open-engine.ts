/**
 * Engine fixes: content() serialization, fillForm success flag, BrowserOptions.timeout
 *   ORBIS_NO_TELEMETRY=1 npx tsx tests/test-open-engine.ts
 */

import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoraBrowser } from '../src/engine/browser.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(e);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {
  '/robots.txt': (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); },
  '/page.html': (_q, res) => html(res, `<!DOCTYPE html><html><head><title>Hello</title></head><body><p id="x">hi</p></body></html>`),
  '/form.html': (_q, res) => html(res, `<html><head><title>Form</title></head><body>
    <form id="f" action="/done.html" method="get">
      <input id="name" name="name">
      <input id="email" name="email">
      <button id="go" type="submit">Go</button>
    </form></body></html>`),
  '/done.html': (_q, res) => html(res, `<html><head><title>Done</title></head><body>ok</body></html>`),
  '/slow.html': async (_q, res) => { await sleep(3000); if (!res.destroyed) html(res, `<html><body>slow</body></html>`); },
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://x').pathname;
  const route = routes[path];
  if (route) await route(req, res);
  else { res.writeHead(404); res.end('not found'); }
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = new MemoraBrowser({});

await test('content() returns real HTML with doctype and no #document wrapper', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/page.html`);
  const out = page.content();
  assert.ok(out.startsWith('<!DOCTYPE html>'), `starts with: ${out.slice(0, 40)}`);
  assert.ok(out.includes('<html'), 'contains <html');
  assert.ok(!out.includes('#document'), 'no #document');
  assert.ok(out.includes('<p id="x">hi</p>'));
  page.close();
});

await test('fillForm: all fields filled + submit -> success true', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/form.html`);
  const r = await page.fillForm({ fields: { '#name': 'Ada', '#email': 'a@b.c' }, submit: '#go' });
  assert.equal(r.success, true);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.submitted, true);
  page.close();
});

await test('fillForm: missing field -> success false, skipped lists it', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/form.html`);
  const r = await page.fillForm({ fields: { '#name': 'Ada', '#nope': 'x' } });
  assert.equal(r.success, false);
  assert.deepEqual(r.skipped, ['#nope']);
  assert.deepEqual(r.filled, ['#name']);
  page.close();
});

await test('fillForm: requested submit that does not happen -> success false', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/form.html`);
  const r = await page.fillForm({ fields: { '#name': 'Ada' }, submit: '#missing-button' });
  assert.equal(r.submitted, false);
  assert.equal(r.success, false);
  page.close();
});

await test('fillForm steps: success only if every step succeeded', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/form.html`);
  const ok = await page.fillForm({ steps: [{ fields: { '#name': 'Ada' } }, { fields: { '#email': 'a@b.c' } }] });
  assert.equal(ok.success, true);
  const bad = await page.fillForm({ steps: [{ fields: { '#name': 'Ada' } }, { fields: { '#ghost': 'x' } }] });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.skipped, ['#ghost']);
  page.close();
});

await test('BrowserOptions.timeout is the default navigation timeout', async () => {
  const b = new MemoraBrowser({ timeout: 500 });
  const page = b.newPage();
  const t0 = Date.now();
  await assert.rejects(page.goto(`${base}/slow.html`), (e: any) => /timeout|timed out|abort/i.test(String(e?.message ?? e)));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `took ${elapsed}ms`);
  b.close();
});

browser.close();
server.closeAllConnections();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
