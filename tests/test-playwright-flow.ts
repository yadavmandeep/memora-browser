// Playwright connectOverCDP end-to-end flow against a local HTTP server:
// existing page + context.newPage(), goto(waitUntil: load), $$eval, title, fill/click form,
// repeated navigation (leak / hang check), goBack, close.
import http from 'node:http';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { MemoraBrowser } from '../src/index.js';
import { CDPServer } from '../src/cdp/server.js';

const PORT = 9244;

const pages: Record<string, (q: URLSearchParams) => string> = {
  '/': () => `<!DOCTYPE html><html><head><title>Home</title></head><body>
    <h1>Home</h1>
    <a href="/a">Page A</a> <a href="/b?x=1">Page B</a> <a href="https://example.com/ext">External</a>
    <a href="/form"><span id="to-form">Go to form</span></a>
    <div id="secret" style="display:none">hidden</div>
  </body></html>`,
  '/a': () => `<html><head><title>Page A</title></head><body><a href="/">home</a><a href="/b">b</a></body></html>`,
  '/b': () => `<html><head><title>Page B</title></head><body><a href="/">home</a></body></html>`,
  '/form': () => `<html><head><title>Form</title></head><body>
    <p id="status">idle</p>
    <button id="js-btn" onclick="document.getElementById('status').textContent = 'clicked'">JS</button>
    <form action="/result" method="get">
      <label for="name">Name</label><input id="name" name="name" type="text" value="old">
      <textarea id="msg" name="msg"></textarea>
      <input type="checkbox" id="agree" name="agree" value="yes">
      <button id="submit" type="submit">Send</button>
    </form>
    <form id="post-form" action="/result" method="post">
      <input id="email" name="email" type="email">
    </form>
  </body></html>`,
  '/result': (q) => `<html><head><title>Result</title></head><body><pre id="out">${[...q].map(([k, v]) => `${k}=${v}`).join('&')}</pre></body></html>`,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const respond = (q: URLSearchParams) => {
    const render = pages[url.pathname];
    res.writeHead(render ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(render ? render(q) : '<html><head><title>404</title></head><body>missing</body></html>');
  };
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => respond(new URLSearchParams(body)));
  } else {
    respond(url.searchParams);
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = new MemoraBrowser({ port: PORT });
browser.newPage(); // pre-existing tab that Playwright must pick up
const cdp = new CDPServer(browser);
await cdp.start();

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  await fn();
  passed++;
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

let exitCode = 0;
try {
  const pw = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
  const context = pw.contexts()[0];

  async function exercise(page: import('playwright-core').Page, label: string) {
    await step(`${label}: goto + $$eval links + title`, async () => {
      const resp = await page.goto(`${base}/`, { waitUntil: 'load', timeout: 10000 });
      assert.equal(resp?.status(), 200);
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
      assert.deepEqual(hrefs, ['/a', '/b?x=1', 'https://example.com/ext', '/form']);
      assert.equal(await page.title(), 'Home');
      assert.equal(page.url(), `${base}/`);
    });

    await step(`${label}: visibility`, async () => {
      assert.equal(await page.isVisible('h1'), true);
      assert.equal(await page.isVisible('#secret'), false);
    });

    await step(`${label}: click link (nested span) navigates`, async () => {
      await page.click('#to-form', { timeout: 5000 });
      await page.waitForURL(`${base}/form`, { timeout: 5000 });
      assert.equal(await page.title(), 'Form');
    });

    await step(`${label}: click runs onclick handler`, async () => {
      await page.click('#js-btn', { timeout: 5000 });
      assert.equal(await page.textContent('#status'), 'clicked');
    });

    await step(`${label}: fill + check + submit GET form`, async () => {
      await page.fill('#name', 'Ada Lovelace', { timeout: 5000 });
      assert.equal(await page.inputValue('#name'), 'Ada Lovelace');
      await page.fill('#msg', 'hello there');
      await page.check('#agree');
      assert.equal(await page.isChecked('#agree'), true);
      await Promise.all([page.waitForURL(/\/result/, { timeout: 5000 }), page.click('#submit')]);
      assert.equal(await page.title(), 'Result');
      assert.equal(await page.textContent('#out'), 'name=Ada Lovelace&msg=hello there&agree=yes');
    });

    await step(`${label}: Enter submits POST form`, async () => {
      await page.goto(`${base}/form`);
      await page.fill('#email', 'a@b.c');
      await Promise.all([page.waitForURL(/\/result/, { timeout: 5000 }), page.press('#email', 'Enter')]);
      assert.equal(await page.locator('#out').textContent(), 'email=a@b.c');
    });

    await step(`${label}: goBack`, async () => {
      await page.goto(`${base}/a`);
      await page.goto(`${base}/b`);
      await page.goBack({ timeout: 5000 });
      assert.equal(await page.title(), 'Page A');
    });

    await step(`${label}: navigation errors`, async () => {
      const resp = await page.goto(`${base}/missing`);
      assert.equal(resp?.status(), 404);
      await assert.rejects(page.goto('http://127.0.0.1:1/', { timeout: 5000 }), /net::ERR_/);
    });
  }

  const existing = context.pages()[0];
  assert.ok(existing, 'existing page is visible to Playwright');
  await exercise(existing, 'existing page');

  const fresh = await context.newPage();
  assert.equal(context.pages().length, 2);
  await exercise(fresh, 'new page');

  await step('50x goto on the same page (no hang / leak)', async () => {
    const urls = ['/', '/a', '/b', '/form'];
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      const path = urls[i % urls.length];
      await fresh.goto(`${base}${path}`, { waitUntil: 'load', timeout: 5000 });
      const hrefs = await fresh.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
      assert.ok(Array.isArray(hrefs));
      assert.ok((await fresh.title()).length > 0);
    }
    const ms = Date.now() - t0;
    global.gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    const growthMb = (heapAfter - heapBefore) / 1024 / 1024;
    console.log(`    50 navigations in ${ms} ms (${(ms / 50).toFixed(1)} ms/page), heap growth ${growthMb.toFixed(1)} MB`);
    assert.ok(growthMb < 50, `heap grew ${growthMb.toFixed(1)} MB`);
  });

  await step('page.close()', async () => {
    await fresh.close();
    assert.equal(context.pages().length, 1);
  });

  await pw.close();
  console.log(`\n${passed} Playwright flow checks passed`);
} catch (err) {
  console.error('FAILED:', err);
  exitCode = 1;
} finally {
  await cdp.stop().catch(() => {});
  browser.close();
  server.close();
}
process.exit(exitCode);
