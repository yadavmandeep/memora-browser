/**
 * Crawler benchmark — same protocol as Lightpanda's published benchmark
 * (github.com/lightpanda-io/demo/blob/main/BENCHMARKS.md):
 * crawl https://demo-browser.lightpanda.io/amiibo/ and every same-host link
 * until no new URLs are left (933 pages), reading `a[href]` on each page.
 *
 * Every browser is driven the same way: Playwright connectOverCDP, `--pool` workers.
 * By default the workers are tabs in one browser. With `--fork`, each worker gets
 * its own browser process on port PORT+i (Lightpanda's own benchmark does this
 * via the crawler's `-fork` flag, since Lightpanda can't do multiple tabs).
 * Per page, like the original chromedp crawler: navigate (load event), then wait
 * for at least one `a[href]` (chromedp.Nodes(..., AtLeast(1))), then read them.
 * Peak memory = highest summed PSS of all browser process trees, sampled every
 * 100 ms from /proc (Linux only), like `smem -c pss` in the original.
 *
 * `{port}` in --cmd is replaced with the port of that browser (default 9222);
 * required with --fork.
 *
 * Usage (Linux):
 *   node tests/crawl-compare.mjs --browser memora     --cmd "node dist/cli/index.js --port {port}"
 *   node tests/crawl-compare.mjs --browser lightpanda --cmd "./lightpanda serve --port {port}" --pool 10 --fork
 *   node tests/crawl-compare.mjs --browser chrome     --cmd "<chrome-headless-shell> --remote-debugging-port={port}" --pool 10
 * Options: --pool 1  --fork  --port 9222  --url <seed>  --limit 0
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (!a.startsWith('--')) return acc;
    const v = all[i + 1];
    return [...acc, [a.slice(2), v === undefined || v.startsWith('--') ? 'true' : v]];
  }, []),
);
const FORK = args.fork === 'true';
const BROWSER = args.browser || 'memora';
const CMD = args.cmd;
const POOL = Number(args.pool || 1);
const SEED = new URL(args.url || 'https://demo-browser.lightpanda.io/amiibo/');
const LIMIT = Number(args.limit || 0);
const PORT = Number(args.port || 9222);

// ── memory sampling (PSS of process tree) ──
function children(pid) {
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(d));
    } catch { /* process exited */ }
  }
  return out;
}
function tree(pid) {
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...children(all[i]));
  return all;
}
function pssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function waitForCdp(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`browser did not open CDP on port ${port}`);
}

let killAll = () => {};

async function main() {
  if (FORK && !CMD.includes('{port}')) throw new Error('--fork needs {port} in --cmd');
  const ports = Array.from({ length: FORK ? POOL : 1 }, (_, i) => PORT + i);
  // a leftover browser on the port would silently be benchmarked instead of ours
  for (const port of ports) {
    const busy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} already serves CDP — kill the leftover browser first`);
  }
  // detached: own process group, so the whole tree can be killed with kill(-pid)
  const procs = ports.map((port) =>
    spawn(CMD.replaceAll('{port}', String(port)), { shell: true, stdio: 'ignore', detached: true }));
  const allPids = () => procs.flatMap((p) => tree(p.pid));
  killAll = () => {
    const pids = allPids(); // collect before killing, or children get reparented and leak
    for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  };
  let peakKb = 0;
  const sampler = setInterval(process.env.NOSAMPLE ? () => {} : () => {
    const kb = allPids().reduce((s, p) => s + pssKb(p), 0);
    if (kb > peakKb) peakKb = kb;
  }, 100);

  await Promise.all(ports.map(waitForCdp));
  const t0 = performance.now();
  const browsers = [];
  const contexts = [];
  for (const port of ports) {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    browsers.push(b);
    contexts.push(b.contexts()[0] || (await b.newContext()));
  }

  const known = new Map([[SEED.href, 'ready']]);
  let failed = 0;

  async function fetchPage(page, url) {
    await page.goto(url, { timeout: 30000, waitUntil: 'load' });
    // like chromedp.Nodes('a[href]', AtLeast(1)): links may be inserted by page JS after load
    await page.waitForSelector('a[href]', { state: 'attached', timeout: 30000 });
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    const links = [];
    for (const h of hrefs) {
      try { links.push(new URL(h, url)); } catch { /* invalid */ }
    }
    return links;
  }

  async function worker(_, i) {
    const page = await contexts[FORK ? i : 0].newPage();
    for (;;) {
      const next = [...known].find(([, s]) => s === 'ready');
      if (!next) {
        if ([...known.values()].some((s) => s === 'queued')) { await new Promise((r) => setTimeout(r, 5)); continue; }
        break;
      }
      const [url] = next;
      known.set(url, 'queued');
      const tp = performance.now();
      try {
        const links = await fetchPage(page, url);
        if (process.env.VERBOSE) console.error('ok', i, url, Math.round(performance.now() - tp), 'ms');
        for (const u of links) {
          if (LIMIT && known.size >= LIMIT) break;
          if (u.host !== SEED.host) continue;
          if (!known.has(u.href)) known.set(u.href, 'ready');
        }
      } catch (e) {
        failed++;
        if (process.env.VERBOSE) console.error('fail', url, e.message);
      }
      known.set(url, 'done');
    }
  }

  await Promise.all(Array.from({ length: POOL }, worker));
  const seconds = (performance.now() - t0) / 1000;

  clearInterval(sampler);
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  killAll();

  console.log(JSON.stringify({
    browser: BROWSER,
    pool: POOL,
    processes: procs.length,
    pages: known.size,
    failed,
    seconds: Number(seconds.toFixed(2)),
    peakMemoryMB: Number((peakKb / 1024).toFixed(1)),
  }));
  process.exit(0);
}

main().catch((e) => { console.error(e); killAll(); process.exit(1); });
