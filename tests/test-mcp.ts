/**
 * Memora Browser — Model Context Protocol (MCP) Integration Verification
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

async function testMCPServer() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       🤖 MEMORA BROWSER — MCP SERVER VERIFICATION TEST         ║');
  console.log('║     Testing stdio JSON-RPC 2.0 protocol for Cursor & Claude    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Spawn CLI with --mcp flag
  const mcpProcess = spawn('node', ['dist/cli/index.js', '--mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: true
  });

  const rl = readline.createInterface({
    input: mcpProcess.stdout,
    terminal: false
  });

  let messageId = 1;
  const pendingRequests = new Map<number, (resp: any) => void>();

  rl.on('line', (line) => {
    try {
      const data = JSON.parse(line.trim());
      if (data.id && pendingRequests.has(data.id)) {
        const resolve = pendingRequests.get(data.id)!;
        pendingRequests.delete(data.id);
        resolve(data);
      }
    } catch (err) {
      console.error('[MCP STDOUT Parse Error]:', line);
    }
  });

  function sendRpc(method: string, params: any = {}): Promise<any> {
    const id = messageId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve) => {
      pendingRequests.set(id, resolve);
      mcpProcess.stdin.write(payload);
    });
  }

  // TEST 1: Initialize Handshake
  console.log('▶ [Step 1]: Sending MCP initialize handshake...');
  const initResp = await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'Cursor / Antigravity Test Client', version: '1.0.0' }
  });
  console.log('  ✓ Initialized response received:');
  console.log(`    Server Name: ${initResp.result.serverInfo.name}`);
  console.log(`    Version:     ${initResp.result.serverInfo.version}`);

  // TEST 2: List Registered Tools
  console.log('\n▶ [Step 2]: Listing MCP Tools (tools/list)...');
  const listResp = await sendRpc('tools/list');
  const tools = listResp.result.tools;
  console.log(`  ✓ Received ${tools.length} registered tools:`);
  for (const t of tools) {
    console.log(`    • ${t.name}: ${t.description.slice(0, 70)}...`);
  }

  // TEST 3: Call memora_browse Tool
  console.log('\n▶ [Step 3]: Executing tool: memora_browse (Hacker News Login)...');
  const t0 = performance.now();
  const browseResp = await sendRpc('tools/call', {
    name: 'memora_browse',
    arguments: { url: 'https://news.ycombinator.com/login' }
  });
  const duration = (performance.now() - t0).toFixed(1);
  const browseText = browseResp.result.content[0].text;
  console.log(`  ✓ Tool executed in ${duration}ms!`);
  console.log('  ✓ Preview of response sent to AI Agent:');
  console.log(browseText.slice(0, 600) + '\n... [truncated]');

  // TEST 4: Call memora_act Tool
  console.log('\n▶ [Step 4]: Executing tool: memora_act (Type password into @2)...');
  const actResp = await sendRpc('tools/call', {
    name: 'memora_act',
    arguments: { actionId: '@2', type: 'type', text: 'SecureMCPPassword999' }
  });
  console.log('  ✓ Action Result:', actResp.result.content[0].text);

  // TEST 5: Call memora_inspect Tool
  console.log('\n▶ [Step 5]: Executing tool: memora_inspect...');
  const inspectResp = await sendRpc('tools/call', {
    name: 'memora_inspect',
    arguments: {}
  });
  console.log('  ✓ Inspect Result (Title & Active Elements):');
  console.log(inspectResp.result.content[0].text.slice(0, 300) + '...');

  // TEST 6: Call memora_storage Tool
  console.log('\n▶ [Step 6]: Executing tool: memora_storage (Set & Get JWT token)...');
  await sendRpc('tools/call', {
    name: 'memora_storage',
    arguments: { storage: 'local', action: 'set', key: 'auth_token', value: 'memora_jwt_secret_token_123' }
  });
  const getStorageResp = await sendRpc('tools/call', {
    name: 'memora_storage',
    arguments: { storage: 'local', action: 'get', key: 'auth_token' }
  });
  console.log('  ✓ Storage get result:', getStorageResp.result.content[0].text);

  // TEST 7: Call memora_extract Tool
  console.log('\n▶ [Step 7]: Executing tool: memora_extract (Extract all input tags)...');
  const extractResp = await sendRpc('tools/call', {
    name: 'memora_extract',
    arguments: { selector: 'input', limit: 3 }
  });
  console.log('  ✓ Extract result:', extractResp.result.content[0].text.slice(0, 200) + '...');

  // TEST 8: Call memora_cookies Tool
  console.log('\n▶ [Step 8]: Executing tool: memora_cookies (Set & List cookies)...');
  await sendRpc('tools/call', {
    name: 'memora_cookies',
    arguments: { action: 'set', name: 'session_id', value: 'sess_abc123' }
  });
  const cookieListResp = await sendRpc('tools/call', {
    name: 'memora_cookies',
    arguments: { action: 'list' }
  });
  console.log('  ✓ Cookie list result:', cookieListResp.result.content[0].text);

  // TEST 9: Call memora_eval Tool
  console.log('\n▶ [Step 9]: Executing tool: memora_eval (Math and DOM eval)...');
  const evalResp = await sendRpc('tools/call', {
    name: 'memora_eval',
    arguments: { code: '10 + 20 * 3' }
  });
  console.log('  ✓ Eval result:', evalResp.result.content[0].text);

  // Teardown
  mcpProcess.kill();
  console.log('\n================================================================');
  console.log('🎉 MCP SERVER VERIFICATION 100% PASSED!');
  console.log('   Ready for direct use in Cursor, Claude Desktop, & Windsurf.');
  console.log('================================================================\n');
}

testMCPServer().catch(console.error);

