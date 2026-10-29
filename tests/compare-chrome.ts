/**
 * Memora Browser vs headless Chrome on the same local pages.
 *
 * Serves the four HTML fixtures from tests/benchmark.ts on 127.0.0.1:9555, then for each browser:
 *   - loads N pages one after another in a single tab (timed after the browser has started)
 *   - opens 10 tabs and reads memory (Memora: process RSS; Chrome: summed working set of
 *     chrome-headless-shell processes, Windows only)
 *
 * Usage:  npm run benchmark:chrome            (N defaults to 200)
 * Needs:  npx playwright install chromium-headless-shell
 *         or HS_EXE=<path to chrome-headless-shell executable>
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const src = readFileSync(new URL('./benchmark.ts', import.meta.url), 'utf8');
const pages: string[] = [];
for (const m of src.matchAll(/const [A-Z_]+_HTML = `([\s\S]*?)`;/g)) pages.push(m[1]);

const server = createServer((req, res) => {
  const i = Number((req.url || '/0').replace(/\D/g, '')) % pages.length;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pages[i]);
}).listen(9555);

const N = Number(process.env.N || 200);
const urls = Array.from({ length: N }, (_, i) => `http://127.0.0.1:9555/${i}`);

function chromeMemoryMb(): number | null {
  if (process.platform !== 'win32') return null;
  const out = execSync(
    'powershell -NoProfile -Command "(Get-Process chrome-headless-shell -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"',
  ).toString().trim();
  return Math.round(Number(out || 0) / 1048576);
}

async function runChrome() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HS_EXE || undefined });
  const ctx = await browser.newContext();
  const first = await ctx.newPage();
  const t = performance.now();
  for (const u of urls) await first.goto(u);
  const loadMs = performance.now() - t;
  for (let i = 1; i < 10; i++) await (await ctx.newPage()).goto(urls[i]);
  await new Promise((r) => setTimeout(r, 1500));
  const memMb = chromeMemoryMb();
  await browser.close();
  return { loadMs: Math.round(loadMs), perPageMs: +(loadMs / N).toFixed(2), memMb };
}

async function runMemora() {
  const { MemoraBrowser } = await import('../src/engine/browser.js');
  const browser = new MemoraBrowser({ stealth: true });
  const page: any = browser.newPage();
  const t = performance.now();
  for (const u of urls) await page.goto(u);
  const loadMs = performance.now() - t;
  for (let i = 1; i < 10; i++) await (browser.newPage() as any).goto(urls[i]);
  return {
    loadMs: Math.round(loadMs),
    perPageMs: +(loadMs / N).toFixed(2),
    memMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

(async () => {
  const memora = await runMemora();
  const chrome = await runChrome();
  console.log(`\nMemora Browser vs headless Chrome — ${N} local pages, single tab`);
  console.table({ 'Memora Browser': memora, 'Headless Chrome': chrome });
  console.log(`Speed:  ${(chrome.loadMs / memora.loadMs).toFixed(1)}x faster`);
  if (chrome.memMb) console.log(`Memory: ${(chrome.memMb / memora.memMb).toFixed(1)}x less (10 tabs open)`);
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
