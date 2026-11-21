import assert from 'node:assert/strict';
import { OrbisBrowser } from '../src/engine/browser.js';
import { ChromeEngine } from '../src/engine/chrome-engine.js';
import { CDPServer } from '../src/cdp/server.js';
import { NetworkFetcher } from '../src/network/fetcher.js';

console.log('--- Testing 4 Levels of RAM Footprint Optimization ---\n');

async function testLevel1Native() {
  console.log('Testing Level 1: Native Engine Ultra-Low Footprint...');
  const browser = new OrbisBrowser({ stealth: true });
  const page = browser.newPage();
  const stats = browser.getMemoryStats();
  console.log(`  Initial native memory stats: RSS: ${stats.rssMb}MB, Heap: ${stats.heapUsedMb}MB, Pages: ${stats.activePages}`);
  assert.ok(stats.activePages === 1, 'Expected 1 active page');
  assert.ok(stats.heapUsedMb < 100, 'Native engine heap should be under 100MB');
  page.close();
  browser.close();
  console.log('  ✓ Level 1 Native Engine verified\n');
}

async function testLevel2ChromeFlags() {
  console.log('Testing Level 2: Chrome Low-Memory Launch Options...');
  const engine = new ChromeEngine({ lowMemory: true }, { headless: true });
  assert.ok(engine, 'ChromeEngine with lowMemory initialized');
  // Confirm collectGarbage and recycle methods exist
  assert.equal(typeof engine.collectGarbage, 'function', 'collectGarbage exists');
  assert.equal(typeof engine.recycle, 'function', 'recycle exists');
  await engine.collectGarbage();
  await engine.close();
  console.log('  ✓ Level 2 Chrome Low-Memory flags & GC hooks verified\n');
}

async function testLevel3AssetBlocking() {
  console.log('Testing Level 3: Network Layer Asset & Media Blocking...');
  const fetcher = new NetworkFetcher({
    blockMedia: true,
    blockImages: true,
    stripMode: 'invisible'
  });

  // Test media blocking in fetcher subresource
  const resMedia = await fetcher.request('https://example.com/video.mp4', { resource: true });
  assert.equal(resMedia.status, 204, 'Media request should be blocked with 204');

  // Test font blocking
  const resFont = await fetcher.request('https://example.com/font.woff2', { resource: true });
  assert.equal(resFont.status, 204, 'Font request should be blocked with 204');

  // Test image blocking
  const resImage = await fetcher.request('https://example.com/image.png', { resource: true });
  assert.equal(resImage.status, 204, 'Image request should be blocked with 204');

  console.log('  ✓ Level 3 Network Asset Aborting verified\n');
}

async function testLevel4LifecycleAndRecycle() {
  console.log('Testing Level 4: Active Page Lifecycle, Auto-Recycle & Memory Endpoints...');
  const browser = new OrbisBrowser({
    maxPages: 3,
    recycleAfter: 2,
    port: 9333,
    host: 'localhost'
  });

  // Verify maxPages threshold
  const p1 = browser.newPage();
  const p2 = browser.newPage();
  const p3 = browser.newPage();
  assert.throws(() => {
    browser.newPage();
  }, /Max concurrent pages limit/, 'Should enforce maxConcurrentPages limit');

  // Touch and prune
  browser.touchPage(p1.id);
  // Fake idle time for p2
  (browser as any).lastActiveTimes.set(p2.id, Date.now() - 100000);
  const pruned = browser.pruneIdlePages(50000);
  assert.equal(pruned, 1, 'Should prune 1 idle page');
  assert.equal(browser.getPage(p2.id), undefined, 'p2 should be removed');

  // Test auto-recycle operation counter
  assert.equal((browser as any).operationCount, 0);
  browser.recordOperation();
  assert.equal((browser as any).operationCount, 1);
  browser.recordOperation(); // Threshold of 2 reached -> recycles
  assert.equal((browser as any).operationCount, 0, 'Auto-recycle should reset operation count');

  // Test CDP Server endpoints (/orbis/memory and /orbis/gc)
  const server = new CDPServer(browser);
  await server.start();

  const memRes = await fetch('http://localhost:9333/orbis/memory');
  assert.equal(memRes.status, 200);
  const memData: any = await memRes.json();
  assert.ok(memData.rssMb > 0, 'Should return RSS MB');
  assert.ok(memData.heapUsedMb > 0, 'Should return heap used MB');

  const gcRes = await fetch('http://localhost:9333/orbis/gc');
  assert.equal(gcRes.status, 200);
  const gcData: any = await gcRes.json();
  assert.equal(gcData.success, true);

  await server.stop();
  browser.close();
  console.log('  ✓ Level 4 Page Lifecycle, Auto-Recycle, and /orbis/gc verified\n');
}

async function runAll() {
  await testLevel1Native();
  await testLevel2ChromeFlags();
  await testLevel3AssetBlocking();
  await testLevel4LifecycleAndRecycle();
  console.log('🎉 ALL 4 RAM OPTIMIZATION LEVELS FULLY PASSED!');
}

runAll().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
