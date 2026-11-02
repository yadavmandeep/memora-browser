/**
 * MCP server on the native engine: memora_eval, memora_diff baseline, tool descriptions
 *   npx tsx tests/test-open-mcp.ts
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MCPServer } from '../src/mcp/server.js';

process.env.ORBIS_NO_TELEMETRY = '1';

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

const PAGE = `<!doctype html><html><head><title>Form</title></head><body>
  <h1>Sign up</h1>
  <form><label for="name">Name</label><input id="name" name="name" type="text"><button type="submit">Go</button></form>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let nextId = 1;
async function call(mcp: MCPServer, name: string, args: any = {}): Promise<{ text: string; isError: boolean }> {
  const res = await (mcp as any).handleMessage({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  return { text: res.result.content[0].text, isError: !!res.result.isError };
}

const mcp = new MCPServer({}, 'native');

try {
  await call(mcp, 'memora_browse', { url: `${base}/` });

  await test('memora_eval awaits a promise and returns the plain value', async () => {
    const r = await call(mcp, 'memora_eval', { code: 'Promise.resolve(6*7)' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.text, '42');
  });

  await test('memora_eval returns strings as-is and objects as pretty JSON', async () => {
    assert.equal((await call(mcp, 'memora_eval', { code: 'document.title' })).text, 'Form');
    assert.equal((await call(mcp, 'memora_eval', { code: '({a:1})' })).text, JSON.stringify({ a: 1 }, null, 2));
    assert.equal((await call(mcp, 'memora_eval', { code: 'new Promise(r => setTimeout(() => r("late"), 20))' })).text, 'late');
    assert.equal((await call(mcp, 'memora_eval', { code: 'undefined' })).text, 'undefined');
    const fn = await call(mcp, 'memora_eval', { code: '(function foo() {})' });
    assert.equal(fn.isError, false);
    const node = await call(mcp, 'memora_eval', { code: 'document.querySelector("h1")' });
    assert.equal(node.isError, false, node.text);
    assert.ok(node.text.length < 200, node.text);
  });

  await test('memora_eval reports thrown and rejected errors as tool errors', async () => {
    const t = await call(mcp, 'memora_eval', { code: 'throw new Error("kaboom")' });
    assert.equal(t.isError, true);
    assert.match(t.text, /kaboom/);
    const r = await call(mcp, 'memora_eval', { code: 'Promise.reject(new Error("nope"))' });
    assert.equal(r.isError, true);
    assert.match(r.text, /nope/);
  });

  await test('memora_eval times out on a promise that never settles', async () => {
    const t0 = Date.now();
    const r = await call(mcp, 'memora_eval', { code: 'new Promise(() => {})' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Timed out waiting for the promise/);
    assert.ok(Date.now() - t0 < 15000);
  });

  await test('memora_diff after memora_act shows the change', async () => {
    await call(mcp, 'memora_browse', { url: `${base}/` });
    const act = await call(mcp, 'memora_act', { actionId: '#name', type: 'type', text: 'Ada' });
    assert.equal(act.isError, false, act.text);
    const diff = await call(mcp, 'memora_diff');
    assert.match(diff.text, /Mutated/, diff.text);
    assert.match(diff.text, /\[filled\]/, diff.text);
    // the diff moves the baseline: a second diff sees nothing new
    const again = await call(mcp, 'memora_diff');
    assert.doesNotMatch(again.text, /Mutated/, again.text);
  });

  await test('memora_diff after memora_fill_form shows the change', async () => {
    await call(mcp, 'memora_browse', { url: `${base}/` });
    const fill = await call(mcp, 'memora_fill_form', { fields: { '#name': 'Grace' } });
    assert.equal(fill.isError, false, fill.text);
    const diff = await call(mcp, 'memora_diff');
    assert.match(diff.text, /Mutated/, diff.text);
  });

  await test('action IDs from memora_act reply still resolve', async () => {
    await call(mcp, 'memora_browse', { url: `${base}/` });
    const act = await call(mcp, 'memora_act', { actionId: '#name', type: 'type', text: 'X' });
    const m = act.text.match(/(@\d+)[^\n]*(?:input|textbox|Name)/i);
    assert.ok(m, act.text);
    const again = await call(mcp, 'memora_act', { actionId: m![1], type: 'type', text: 'Y' });
    assert.equal(again.isError, false, again.text);
    assert.equal((await call(mcp, 'memora_eval', { code: 'document.getElementById("name").value' })).text, 'Y');
  });

  await test('tools/list has no unmeasured "95%" claim', async () => {
    const res = await (mcp as any).handleMessage({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const text = JSON.stringify(res.result.tools);
    assert.ok(!text.includes('95%'), 'tools/list still says 95%');
    assert.ok(!/massive token savings/i.test(text), 'tools/list still says "Massive token savings"');
  });

  console.log(`\n${passed} passed`);
} finally {
  await (mcp as any).engine.close().catch(() => {});
  server.close();
}
process.exit(0);
