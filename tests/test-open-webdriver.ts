/**
 * WebDriver server: API-key auth, cross-site refusal, idle timeout, CLI flag.
 */
process.env.ORBIS_NO_TELEMETRY = '1';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';
import { Builder, Browser } from 'selenium-webdriver';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome.js';
import { WebDriverServer } from '../src/webdriver/server.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL ${name}\n      ${e?.message}`);
  }
}

const KEY = 'test-key-123';

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { let json: any = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode || 0, json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Auth Page</title></head><body>hi</body></html>');
  });
  await new Promise<void>(r => site.listen(9495, '127.0.0.1', () => r()));

  const wd = new WebDriverServer({ port: 9490, host: '127.0.0.1', apiKey: KEY });
  await wd.start();
  const caps = { capabilities: { alwaysMatch: { browserName: 'chrome' } } };

  await test('POST /session without key -> 401', async () => {
    const r = await post(9490, '/session', caps);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json?.value?.error, 'unknown error');
    assert.strictEqual(r.json?.value?.message, 'Missing or wrong API key');
  });

  await test('wrong key -> 401', async () => {
    const r = await post(9490, '/session', caps, { 'x-api-key': 'nope' });
    assert.strictEqual(r.status, 401);
  });

  await test('cross-site browser request -> 403', async () => {
    const r = await post(9490, '/session', caps, { 'x-api-key': KEY, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' });
    assert.strictEqual(r.status, 403);
  });

  await test('x-api-key and Bearer and ?apiKey accepted', async () => {
    for (const [path, h] of [['/session', { 'x-api-key': KEY }], ['/session', { authorization: `Bearer ${KEY}` }], [`/session?apiKey=${KEY}`, {}]] as const) {
      const r = await post(9490, path, caps, h as Record<string, string>);
      assert.strictEqual(r.status, 200, `${path} ${JSON.stringify(h)} -> ${r.status}`);
      const id = r.json.value.sessionId;
      await new Promise<void>((res, rej) => { const q = http.request({ host: '127.0.0.1', port: 9490, path: `/session/${id}`, method: 'DELETE', headers: { 'x-api-key': KEY } }, s => { s.resume(); s.on('end', () => res()); }); q.on('error', rej); q.end(); });
    }
  });

  await test('selenium with Basic auth URL creates session and loads page', async () => {
    const driver = await new Builder().forBrowser(Browser.CHROME).setChromeOptions(new ChromeOptions()).usingServer(`http://orbis:${KEY}@127.0.0.1:9490`).build();
    try {
      await driver.get('http://127.0.0.1:9495/');
      assert.strictEqual(await driver.getTitle(), 'Auth Page');
    } finally {
      await driver.quit();
    }
  });
  await wd.stop();

  await test('no key configured -> no auth required', async () => {
    const saved = [process.env.ORBIS_API_KEY, process.env.MEMORA_API_KEY];
    delete process.env.ORBIS_API_KEY; delete process.env.MEMORA_API_KEY;
    const open = new WebDriverServer({ port: 9491, host: '127.0.0.1' });
    await open.start();
    try {
      const r = await post(9491, '/session', caps);
      assert.strictEqual(r.status, 200);
    } finally {
      await open.stop();
      if (saved[0] !== undefined) process.env.ORBIS_API_KEY = saved[0];
      if (saved[1] !== undefined) process.env.MEMORA_API_KEY = saved[1];
    }
  });

  await test('sessionIdleTimeoutMs 1000 closes idle session', async () => {
    const s = new WebDriverServer({ port: 9492, host: '127.0.0.1', sessionIdleTimeoutMs: 1000 });
    await s.start();
    try {
      const r = await post(9492, '/session', caps);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(s.sessionCount, 1);
      await new Promise(r => setTimeout(r, 2200));
      assert.strictEqual(s.sessionCount, 0);
    } finally {
      await s.stop();
    }
  });

  await test('CLI --help lists --session-idle-timeout', async () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'serve', '--help'], { encoding: 'utf8', env: { ...process.env, ORBIS_NO_TELEMETRY: '1' } });
    assert.ok(out.includes('--session-idle-timeout'), out);
  });

  site.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
