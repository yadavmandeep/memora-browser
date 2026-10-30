/**
 * Page scripts: external <script src>, execution order, async settle before "load"
 *   npm run test:scripts
 */

import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoraBrowser } from '../src/engine/browser.js';

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hits: string[] = [];

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {
  '/robots.txt': (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /private/\n'); },

  // inline / external interleaving; slow first script must still run first
  '/order.html': (_q, res) => html(res, `<html><head>
    <script>window.log = ['inline1'];</script>
    <script src="/js/slow.js"></script>
    <script>log.push('inline2');</script>
    <script src="js/fast.js"></script>
    <script defer src="/js/deferred.js"></script>
    <script async src="/js/async.js"></script>
    <script type="application/json" id="data">{"log": "never"}</script>
    <script type="application/ld+json">{"@type": "Thing"}</script>
    <script type="text/template">log.push('template');</script>
    <script type="module">log.push('module');</script>
    <script src="/js/missing.js"></script>
    <script src="/js/throws.js"></script>
    <script>log.push('inline3:' + (document.currentScript ? document.currentScript.nodeName : 'none'));</script>
  </head><body><p id="out"></p></body></html>`),
  '/js/slow.js': async (_q, res) => { await sleep(150); js(res, `log.push('slow'); window.slowSrc = document.currentScript.getAttribute('src');`); },
  '/js/fast.js': (_q, res) => js(res, `log.push('fast');`),
  '/js/deferred.js': (_q, res) => js(res, `log.push('deferred');`),
  '/js/async.js': (_q, res) => js(res, `log.push('async');`),
  '/js/throws.js': (_q, res) => js(res, `log.push('throws'); throw new Error('boom');`),

  // async fetch + DOM building like Lightpanda's amiibo demo
  '/amiibo.html': (_q, res) => html(res, `<html><body><h1 id="name">x</h1><ul id="alt"></ul><p id="nav"></p></body>
    <script src="load.js"></script><script>loadAmiibo('data.json');</script></html>`),
  '/load.js': (_q, res) => js(res, `async function loadAmiibo(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('status ' + response.status);
      const data = await response.json();
      await new Promise(r => setTimeout(r, 50));
      document.getElementById('name').textContent = data.name;
      const nav = document.getElementById('nav');
      const next = document.createElement('a');
      next.setAttribute('href', data.next);
      next.textContent = 'Next';
      nav.appendChild(next);
      nav.appendChild(document.createTextNode(' | '));
      for (const key in data.list) {
        const a = document.createElement('a');
        a.setAttribute('href', key + '.html');
        a.textContent = data.list[key];
        const li = document.createElement('li');
        li.append(a);
        document.getElementById('alt').append(li);
      }
    } catch (error) { console.error(error.message); }
  }`),
  '/data.json': async (_q, res) => {
    await sleep(200);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'Sandy', next: 'n.html', list: { a1: 'Isabelle', b2: 'Coach' } }));
  },

  // robots.txt disallows /private/: the script must not be fetched, later scripts still run
  '/robots-page.html': (_q, res) => html(res, `<html><body>
    <script>window.log = [];</script>
    <script src="/private/secret.js"></script>
    <script>log.push('after');</script>
  </body></html>`),
  '/private/secret.js': (_q, res) => js(res, `log.push('secret');`),

  // never-ending interval + a long timeout must not hang navigation; a short timer does count
  '/interval.html': (_q, res) => html(res, `<html><body><div id="t"></div><script>
    window.ticks = 0;
    setInterval(() => { ticks++; }, 10);
    setTimeout(() => { document.getElementById('t').textContent = 'late'; }, 60000);
    setTimeout(() => { document.body.setAttribute('data-short', 'done'); }, 100);
    (function poll() { setTimeout(poll, 5); })();
    Promise.reject(new Error('unhandled page rejection'));
    fetch('/never-ending');
  </script></body></html>`),
  '/never-ending': () => { /* never responds */ },

  '/plain.html': (_q, res) => html(res, `<html><body><a href="/x">x</a></body></html>`),
};

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}
function js(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'application/javascript' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://x').pathname;
  hits.push(path);
  const route = routes[path];
  if (!route) { res.writeHead(404); res.end('not found'); return; }
  await route(req, res);
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = new MemoraBrowser();

console.log('\nExternal scripts');

await test('inline + external scripts run in document order; defer, then async after', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/order.html`);
  const log = [...page.evaluate('log').result.value].map((v: any) => v.value);
  assert.deepEqual(log, ['inline1', 'slow', 'inline2', 'fast', 'throws', 'inline3:SCRIPT', 'deferred', 'module', 'async']);
  assert.equal(page.evaluate('slowSrc').result.value, '/js/slow.js');
  const logs = page.getLogs().map(l => l.text).join('\n');
  assert.match(logs, /Failed to load script .*missing\.js: HTTP 404/);
  assert.match(logs, /boom/);
});

await test('external scripts are downloaded in parallel', async () => {
  const page = browser.newPage();
  const t0 = Date.now();
  await page.goto(`${base}/order.html`);
  // slow.js takes 150ms; the others must not wait for it sequentially (still bounded)
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});

await test('pages without scripts never create a JS context', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/plain.html`);
  assert.equal((page as any)._sandbox, null);
  assert.equal(await page.waitForIdle(), true);
});

console.log('\nSettle before load');

await test('fetch() + response.json() + timer chain finish before goto() resolves', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/amiibo.html`);
  const links = page.querySelectorAll('a[href]').map(a => a.getAttribute('href'));
  assert.deepEqual(links.sort(), ['a1.html', 'b2.html', 'n.html']);
  assert.equal(page.querySelector('#name')!.textContent, 'Sandy');
  assert.equal(page.getLogs().filter(l => l.type === 'error').length, 0);
});

await test('settleTimeoutMs: 0 returns before async work (waitForIdle finishes it)', async () => {
  const page = browser.newPage();
  await page.goto(`${base}/amiibo.html`, { settleTimeoutMs: 0 });
  assert.equal(page.querySelectorAll('a[href]').length, 0);
  assert.equal(await page.waitForIdle(5000), true);
  assert.equal(page.querySelectorAll('a[href]').length, 3);
});

await test('never-ending setInterval / polling / hung fetch do not hang goto()', async () => {
  const page = browser.newPage();
  const t0 = Date.now();
  await page.goto(`${base}/interval.html`, { settleTimeoutMs: 1500 });
  const took = Date.now() - t0;
  assert.ok(took < 2500, `goto took ${took}ms`);
  assert.equal(page.querySelector('body')!.getAttribute('data-short'), 'done');
  assert.ok(page.evaluate('ticks').result.value > 0);
  assert.match(page.getLogs().map(l => l.text).join('\n'), /Uncaught \(in promise\).*unhandled page rejection/);
  // navigating away stops the old document's timers
  const sandbox = (page as any)._sandbox;
  await page.goto(`${base}/plain.html`);
  assert.equal(sandbox.isDisposed, true);
  page.close();
});

await test('interval-only page settles immediately', async () => {
  const page = browser.newPage();
  page.setContent('<html><body></body></html>', base + '/x');
  page.evaluate('setInterval(() => {}, 5)');
  const t0 = Date.now();
  assert.equal(await page.waitForIdle(3000), true);
  assert.ok(Date.now() - t0 < 200);
  page.close();
});

console.log('\nrobots.txt');

await test('--obey-robots blocks a disallowed script; later scripts still run', async () => {
  const robotsBrowser = new MemoraBrowser({ network: { obeyRobots: true } });
  const page = robotsBrowser.newPage();
  hits.length = 0;
  await page.goto(`${base}/robots-page.html`);
  assert.deepEqual([...page.evaluate('log').result.value].map((v: any) => v.value), ['after']);
  assert.ok(!hits.includes('/private/secret.js'), 'blocked script must not be requested');
  assert.match(page.getLogs().map(l => l.text).join('\n'), /Failed to load script .*secret\.js: Blocked by robots\.txt/);
  robotsBrowser.close();
});

browser.close();
server.closeAllConnections();
server.close();
console.log(`\n${passed} passed`);
