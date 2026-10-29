/**
 * Local crawl micro-benchmark for MemoraBrowser (no Playwright / CDP).
 *
 * Spawns a separate HTTP server process serving N synthetic pages (each with
 * ~60 a[href] links, text, and every other page an inline script), then
 * loads them through MemoraBrowser:
 *   1. sequentially (1 page object, N navigations)
 *   2. with concurrency C (C page objects sharing the pool)
 * and reports wall time, pages/s, and RSS (after + peak sampled every 20 ms).
 *
 * Usage:
 *   npx tsx tests/crawl-local.mjs            # imports src/ (TypeScript via tsx)
 *   node tests/crawl-local.mjs --dist        # imports dist/ (after npm run build)
 * Options: --pages 200 --concurrency 10 --eval (read links via page.evaluate, like CDP $$eval)
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const PAGES = Number(opt('pages', 200));
const CONC = Number(opt('concurrency', 10));
const USE_DIST = flag('dist');
const VIA_EVAL = flag('eval');

// ── server child process ──
if (flag('serve')) {
  const http = await import('node:http');
  const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ';
  const html = (i) => {
    const links = [];
    for (let k = 1; k <= 60; k++) links.push(`<li><a href="/p/${(i * 7 + k) % PAGES}">Item ${k} of page ${i}</a></li>`);
    const script = i % 2 === 0
      ? `<script>document.getElementById('c').textContent = 'hydrated ' + ${i}; window.__n = (window.__n||0)+1;</script>`
      : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page ${i}</title>
<link rel="stylesheet" href="/s.css"><style>body{font-family:sans-serif}</style></head>
<body><header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<main><h1>Page ${i}</h1><p id="c">${filler.repeat(8)}</p><ul>${links.join('')}</ul>
<table>${'<tr><td>cell</td><td>value</td></tr>'.repeat(20)}</table></main>${script}
<footer>${filler}</footer></body></html>`;
  };
  const server = http.createServer((req, res) => {
    const m = /^\/p\/(\d+)/.exec(req.url || '');
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html(m ? Number(m[1]) : 0));
  });
  server.keepAliveTimeout = 5000;
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
} else {
  await main();
}

async function startServer() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', '--pages', String(PAGES)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const port = await new Promise((resolve, reject) => {
    child.once('message', (m) => resolve(m.port));
    child.once('error', reject);
  });
  return { child, port };
}

async function main() {
  const rssStart = process.memoryUsage().rss;
  // --dist-dir <path>: A/B against another build output (e.g. a baseline copy)
  const distDir = opt('dist-dir');
  const mod = distDir
    ? await import(new URL(`file:///${distDir.replace(/\\/g, '/').replace(/^\//, '')}/engine/browser.js`).href)
    : USE_DIST
      ? await import('../dist/engine/browser.js')
      : await import('../src/engine/browser.js');
  const { MemoraBrowser } = mod;
  const rssLoaded = process.memoryUsage().rss;
  const { child, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;

  let peak = 0;
  const sampler = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, 20);

  const browser = new MemoraBrowser({ network: {} });
  let linkCount = 0;
  const readLinks = (page) => {
    if (VIA_EVAL) {
      const r = page.sandbox.evaluateRaw(`Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'))`);
      linkCount += r.length;
    } else {
      linkCount += page.querySelectorAll('a[href]').map((a) => a.getAttribute('href')).length;
    }
  };

  // warm-up (JIT + first connection), not timed
  {
    const p = browser.newPage();
    for (let i = 0; i < 10; i++) { await p.goto(`${base}/p/${i}`); readLinks(p); }
    browser.closePage(p.id);
  }
  linkCount = 0;

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  const results = {};

  // 1) sequential
  {
    const page = browser.newPage();
    const t0 = performance.now();
    for (let i = 0; i < PAGES; i++) {
      await page.goto(`${base}/p/${i}`);
      readLinks(page);
    }
    const ms = performance.now() - t0;
    browser.closePage(page.id);
    results.sequential = { ms: +ms.toFixed(1), perPageMs: +(ms / PAGES).toFixed(3), pagesPerSec: +(PAGES / (ms / 1000)).toFixed(0) };
  }

  // 2) concurrent
  {
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: CONC }, async () => {
      const page = browser.newPage();
      while (next < PAGES) {
        const i = next++;
        await page.goto(`${base}/p/${i}`);
        readLinks(page);
      }
      browser.closePage(page.id);
    }));
    const ms = performance.now() - t0;
    results.concurrent = { concurrency: CONC, ms: +ms.toFixed(1), perPageMs: +(ms / PAGES).toFixed(3), pagesPerSec: +(PAGES / (ms / 1000)).toFixed(0) };
  }

  clearInterval(sampler);
  const rssEnd = process.memoryUsage().rss;
  // run with --expose-gc to see retained heap (detects leaked pages/contexts)
  let heapAfterGcMB;
  if (globalThis.gc) { gc(); gc(); heapAfterGcMB = +mb(process.memoryUsage().heapUsed); }
  browser.close();
  child.kill();

  console.log(JSON.stringify({
    runtime: distDir ? `node ${distDir}` : USE_DIST ? 'node dist' : 'tsx src',
    mode: VIA_EVAL ? 'evaluate' : 'querySelectorAll',
    pages: PAGES,
    links: linkCount,
    ...results,
    rssMB: { start: +mb(rssStart), afterImport: +mb(rssLoaded), peak: +mb(peak), end: +mb(rssEnd) },
    heapAfterGcMB,
  }, null, 2));
  process.exit(0);
}
