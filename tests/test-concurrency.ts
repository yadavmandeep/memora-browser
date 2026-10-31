import assert from 'node:assert/strict';
import { OrbisBrowser } from '../src/engine/browser.js';
import { OrbisAgent } from '../src/adapters/agent.js';
import { CookieJar } from '../src/network/cookie-jar.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║   🚀 ORBIS MULTI-TAB & WORKER CONCURRENCY VERIFICATION         ║');
  console.log('║   Isolated Contexts, Cookie Jars, Fork Lifecycle & Scale Tests ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('--- 1. Shared Cookie Jar in Same Context ---');
  await test('Tabs in the same context share session cookies', async () => {
    const browser = new OrbisBrowser();
    try {
      const page1 = browser.newPage();
      const page2 = browser.newPage();

      page1.fetcher.setCookie('session_id', 'tok_user_12345');
      assert.equal(page2.fetcher.dumpCookies()['session_id'], 'tok_user_12345', 'Page 2 should see cookie set by Page 1 in default context');
    } finally {
      browser.close();
    }
  });

  console.log('\n--- 2. Isolated Cookie Jars for Multi-Account Workers ---');
  await test('Different browser contexts maintain 100% isolated cookie jars and storage', async () => {
    const browser = new OrbisBrowser();
    try {
      const ctxAlice = browser.newContext({ id: 'worker-alice' });
      const ctxBob = browser.newContext({ id: 'worker-bob' });

      const pageAlice = ctxAlice.newPage();
      const pageBob = ctxBob.newPage();

      pageAlice.fetcher.setCookie('auth', 'alice_token_secret');
      pageBob.fetcher.setCookie('auth', 'bob_token_secret');

      assert.equal(pageAlice.fetcher.dumpCookies()['auth'], 'alice_token_secret');
      assert.equal(pageBob.fetcher.dumpCookies()['auth'], 'bob_token_secret');
      assert.equal(browser.defaultContext.cookieJar.get('auth'), undefined, 'Default context must remain isolated');

      assert.equal(ctxAlice.listPages().length, 1);
      assert.equal(ctxBob.listPages().length, 1);
      assert.equal(browser.listPages().length, 2); // 2 workers (Alice + Bob)
    } finally {
      browser.close();
    }
  });

  console.log('\n--- 3. Page Fork Lifecycle & Registration ---');
  await test('page.fork() copies state, clones cookies independently, and registers with browser', async () => {
    const browser = new OrbisBrowser();
    try {
      const parent = browser.newPage();
      parent.setContent('<html><body><h1>Shopping Cart</h1><div id="items">Item 1</div></body></html>', 'https://shop.local/cart');
      parent.fetcher.setCookie('cart_id', 'cart_abc');

      const forked = parent.fork();
      assert.notEqual(forked.id, parent.id, 'Fork must have unique page ID');
      assert.equal(forked.url, 'https://shop.local/cart');
      assert.ok(browser.listPages().some(p => p.id === forked.id), 'Forked page must register with browser.listPages()');

      // Verify cookie cloning is independent (mutating copy does not affect original)
      assert.equal(forked.fetcher.dumpCookies()['cart_id'], 'cart_abc');
      forked.fetcher.setCookie('cart_id', 'cart_modified_branch');
      assert.equal(parent.fetcher.dumpCookies()['cart_id'], 'cart_abc', 'Parent cookie must not be altered by fork mutation');

      // Clean disposal
      forked.close();
      assert.ok(!browser.listPages().some(p => p.id === forked.id), 'Closed fork must unregister cleanly from browser');
    } finally {
      browser.close();
    }
  });

  console.log('\n--- 4. OrbisAgent Multi-Tab Orchestration ---');
  await test('OrbisAgent can open, switch, and close multiple tabs smoothly', async () => {
    const browser = new OrbisBrowser();
    try {
      const page1 = browser.newPage();
      page1.setContent('<h1>Tab 1</h1>', 'https://app.local/dashboard');

      const agent = new OrbisAgent(browser, page1);
      assert.equal(agent.tabs.length, 1);
      assert.equal(agent.page.url, 'https://app.local/dashboard');

      // Open new tab
      const page2 = await agent.newTab();
      page2.setContent('<h1>Tab 2</h1>', 'https://app.local/settings');
      assert.equal(agent.tabs.length, 2);
      assert.equal(agent.page.id, page2.id, 'Agent active page should switch to new tab by default');

      // Switch back to tab 1
      agent.switchTab(0);
      assert.equal(agent.page.id, page1.id, 'Switched back to tab 1');

      // Close current tab
      agent.closeTab();
      assert.equal(agent.tabs.length, 1, 'Closed tab must reduce open count');
      assert.equal(agent.page.id, page2.id, 'Active page must automatically fall back to remaining tab');
    } finally {
      browser.close();
    }
  });

  console.log('\n--- 5. High-Concurrency Parallel Workers Fleet ---');
  await test('Runs 25 concurrent tabs in parallel with zero leaks and clean disposal', async () => {
    const browser = new OrbisBrowser();
    try {
      const concurrency = 25;
      const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
        const page = browser.newPage({ isolated: true });
        page.setContent(`<html><body><span id="worker">Worker #${idx}</span></body></html>`, `https://fleet.local/task/${idx}`);
        const text = page.querySelector('#worker')?.textContent;
        assert.equal(text, `Worker #${idx}`);
        const res = page.evaluate(`100 + ${idx}`);
        assert.equal(res.result.value, 100 + idx);
        return page;
      });

      const pages = await Promise.all(tasks);
      assert.equal(browser.activePageCount, concurrency, 'All 25 pages should be active');

      // Close all 25 pages concurrently
      for (const p of pages) {
        p.close();
      }
      assert.equal(browser.activePageCount, 0, 'All pages should be disposed without lingering handles');
    } finally {
      browser.close();
    }
  });

  console.log('\n--- 6. Context Cleanup & Resource Teardown ---');
  await test('context.close() closes all assigned pages and wipes context cookies', async () => {
    const browser = new OrbisBrowser();
    try {
      const ctx = browser.newContext({ id: 'temp-job' });
      const p1 = ctx.newPage();
      const p2 = ctx.newPage();
      ctx.cookieJar.set('token', 'temporary_job_secret');

      assert.equal(browser.listPages().length, 2);
      assert.equal(ctx.listPages().length, 2);

      ctx.close();
      assert.equal(ctx.listPages().length, 0, 'Context pages must be empty after close()');
      assert.equal(ctx.cookieJar.size, 0, 'Context cookie jar must be cleared');
      assert.equal(browser.listPages().length, 0, 'Browser page list must be empty');
      assert.equal(browser.listContexts().length, 0, 'Context must be unregistered');
    } finally {
      browser.close();
    }
  });

  console.log(`\n================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
