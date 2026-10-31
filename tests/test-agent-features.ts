/**
 * Memora Browser — Agent Features Verification Suite
 * Verifies:
 *   1. Markdown Distiller with inline link/formatting preservation
 *   2. Collision-free deterministic unique selector generation
 *   3. True AXTree visibility filtering
 *   4. State Diffing Engine (memora_diff)
 *   5. Batch Form Filling (memora_fill_form)
 *   6. Session Vault (save/load cookies & storage)
 *   7. Native MCP Server operation
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import WebSocket from 'ws';
import {
  MemoraBrowser,
  OrbisBrowser,
  parseHTML,
  convertToMarkdown,
  extractSemanticSnapshot,
  computePageDiff,
  MCPServer,
  CDPServer,
  MemoraAgent,
  OrbisAgent,
  getBrowserUseConfig,
  getOrbisBrowserUseConfig,
  getStagehandConfig,
  getOrbisStagehandConfig,
  createMemoraLangChainTools,
  createOrbisLangChainTools
} from '../src/index.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    throw err;
  }
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       🤖 MEMORA BROWSER — AGENT FEATURES VERIFICATION          ║');
  console.log('║   Testing AXTree Distiller, Diffing, Form Fill & Session Vault ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('--- 1. Markdown Distiller & Inline Links Preservation ---');

  await test('Preserves inline links, bold, code inside paragraphs', () => {
    const html = `
      <html>
        <body>
          <p>Welcome to <strong>Memora</strong>! Read the <a href="https://orbis.memora.company/docs">documentation</a> or check <code>src/index.ts</code>.</p>
        </body>
      </html>
    `;
    const doc = parseHTML(html);
    const md = convertToMarkdown(doc);

    assert.ok(md.includes('**Memora**'), 'Bold text must be preserved in markdown');
    assert.ok(md.includes('[documentation](https://orbis.memora.company/docs)'), 'Paragraph link must be preserved in markdown');
    assert.ok(md.includes('`src/index.ts`'), 'Inline code must be preserved in markdown');
  });

  await test('Honors focusSelector and excludeSelectors in Markdown distillation', () => {
    const html = `
      <html>
        <body>
          <nav>Navigation Bar <a href="/home">Home</a></nav>
          <main id="content">
            <h1>Article Heading</h1>
            <p>Main content paragraph.</p>
            <div class="ad-banner">Ad Banner Text</div>
          </main>
          <footer>Footer Copyright</footer>
        </body>
      </html>
    `;
    const doc = parseHTML(html);
    const md = convertToMarkdown(doc, {
      focusSelector: '#content',
      excludeSelectors: ['.ad-banner']
    });

    assert.ok(md.includes('# Article Heading'), 'Focused article heading should be present');
    assert.ok(md.includes('Main content paragraph.'), 'Focused content paragraph should be present');
    assert.ok(!md.includes('Navigation Bar'), 'Header navigation outside focus should be excluded');
    assert.ok(!md.includes('Ad Banner Text'), 'Ad banner should be excluded');
    assert.ok(!md.includes('Footer Copyright'), 'Footer outside focus should be excluded');
  });

  console.log('\n--- 2. Collision-Free Unique Selector Generation ---');

  await test('Disambiguates duplicate elements sharing identical CSS classes', () => {
    const html = `
      <html>
        <body>
          <div class="card-list">
            <div class="card">
              <h3>Item 1</h3>
              <button class="btn p-2">Delete</button>
            </div>
            <div class="card">
              <h3>Item 2</h3>
              <button class="btn p-2">Delete</button>
            </div>
            <div class="card">
              <h3>Item 3</h3>
              <button class="btn p-2">Delete</button>
            </div>
          </div>
        </body>
      </html>
    `;
    const doc = parseHTML(html);
    const snap = extractSemanticSnapshot(doc, 'http://test/cards');

    assert.equal(snap.actions.length, 3, 'Should have mapped 3 delete buttons');

    // All selectors must be unique
    const selectors = snap.actions.map(a => a.selector);
    const uniqueSelectors = new Set(selectors);
    assert.equal(uniqueSelectors.size, 3, 'All 3 buttons must receive unique, non-colliding selectors');

    // Each selector must resolve to exactly one corresponding element
    for (const action of snap.actions) {
      const matches = doc.querySelectorAll(action.selector);
      assert.equal(matches.length, 1, `Selector "${action.selector}" must resolve to exactly 1 element`);
    }
  });

  console.log('\n--- 3. AXTree Visibility Filtering & Accessible States ---');

  await test('Filters out hidden elements, aria-hidden, and hidden inputs', () => {
    const html = `
      <html>
        <body>
          <button id="visible-btn">Click Me</button>
          <input type="hidden" name="csrf" value="secret123" />
          <button id="hidden-btn-1" style="display: none;">Invisible Button</button>
          <div aria-hidden="true">
            <button id="hidden-btn-2">Aria Hidden Button</button>
          </div>
          <button id="disabled-btn" disabled>Disabled Action</button>
          <input id="checked-box" type="checkbox" checked />
        </body>
      </html>
    `;
    const doc = parseHTML(html);
    const snap = extractSemanticSnapshot(doc, 'http://test/visibility');

    const mappedIds = snap.actions.map(a => a.name || a.selector);

    assert.ok(mappedIds.some(s => s.includes('visible-btn')), 'Visible button must be present');
    assert.ok(mappedIds.some(s => s.includes('disabled-btn')), 'Disabled button must be present');
    assert.ok(mappedIds.some(s => s.includes('checked-box')), 'Checked box must be present');

    assert.ok(!mappedIds.some(s => s.includes('hidden-btn-1')), 'display:none button must be pruned');
    assert.ok(!mappedIds.some(s => s.includes('hidden-btn-2')), 'aria-hidden button must be pruned');
    assert.ok(!mappedIds.some(s => s.includes('csrf')), 'type="hidden" input must be pruned');

    const disabledAct = snap.actions.find(a => a.selector.includes('disabled-btn'));
    assert.equal(disabledAct?.disabled, true, 'Disabled state must be detected');

    const checkedAct = snap.actions.find(a => a.selector.includes('checked-box'));
    assert.equal(checkedAct?.checked, true, 'Checked state must be detected');
  });

  console.log('\n--- 4. Page State Diffing Engine (memora_diff) ---');

  await test('Computes accurate page diff between consecutive snapshots', () => {
    const html1 = `
      <html><head><title>Dashboard</title></head><body>
        <button id="menu-btn" aria-expanded="false">Menu</button>
        <button id="refresh-btn">Refresh</button>
      </body></html>
    `;
    const html2 = `
      <html><head><title>Dashboard (Updated)</title></head><body>
        <button id="menu-btn" aria-expanded="true">Menu</button>
        <button id="refresh-btn">Refresh</button>
        <button id="logout-btn">Log Out</button>
      </body></html>
    `;

    const doc1 = parseHTML(html1);
    const doc2 = parseHTML(html2);

    const snap1 = extractSemanticSnapshot(doc1, 'http://test/app');
    const snap2 = extractSemanticSnapshot(doc2, 'http://test/app');

    const diff = computePageDiff(snap1, snap2);

    assert.equal(diff.titleChanged, true, 'Title change should be detected');
    assert.equal(diff.addedActions.length, 1, 'Should detect 1 added action (logout-btn)');
    assert.equal(diff.addedActions[0].text, 'Log Out');
    assert.equal(diff.mutatedActions.length, 1, 'Should detect 1 mutated action (menu-btn expanded)');
    assert.ok(diff.summary.includes('Added (1 elements)'), 'Summary must mention added elements');
    assert.ok(diff.summary.includes('Log Out'), 'Summary must contain new element text');
  });

  console.log('\n--- 5. Batch Form Filling (memora_fill_form) ---');

  await test('Fills multiple fields and submits form in one atomic turn', async () => {
    const browser = new MemoraBrowser({ stealth: true });
    const page = browser.newPage();

    let submitted = false;
    let submittedData = '';

    page.setContent(`
      <html><body>
        <form id="contact-form">
          <input id="f-name" type="text" value="" />
          <input id="f-email" type="email" value="" />
          <textarea id="f-message"></textarea>
          <button id="f-submit" type="button">Send Message</button>
        </form>
      </body></html>
    `, 'http://test/form');

    // Attach click listener in page
    const btn = page.querySelector('#f-submit')!;
    btn.addEventListener('click', () => {
      submitted = true;
      submittedData = `${page.querySelector('#f-name')?.value}|${page.querySelector('#f-email')?.value}|${page.querySelector('#f-message')?.value}`;
    });

    const res = await page.fillForm({
      fields: {
        '#f-name': 'Alice Smith',
        '#f-email': 'alice@example.com',
        '#f-message': 'Hello from Memora Autonomous Agent!'
      },
      submitActionId: '#f-submit'
    });

    assert.equal(res.success, true);
    assert.equal(res.fieldsFilled, 3);
    assert.equal(res.submitted, true);
    assert.equal(submitted, true, 'Submit click event must have fired');
    assert.equal(submittedData, 'Alice Smith|alice@example.com|Hello from Memora Autonomous Agent!');

    page.close();
    browser.close();
  });

  await test('Executes Multi-Step Form Wizard sequentially or atomically via steps', async () => {
    const browser = new MemoraBrowser({ stealth: true });
    const page = browser.newPage();

    let stepReached = 1;
    let finalPayload = '';

    page.setContent(`
      <html><body>
        <div id="wizard">
          <div id="step1">
            <h3>Step 1: Account</h3>
            <input id="wiz-user" type="text" value="" />
            <button id="wiz-next">Next</button>
          </div>
          <div id="step2" style="display: none;">
            <h3>Step 2: Profile</h3>
            <input id="wiz-role" type="text" value="" />
            <div id="wiz-bio" contenteditable="true"></div>
            <button id="wiz-finish">Finish</button>
          </div>
        </div>
      </body></html>
    `, 'http://test/multistep-form');

    const nextBtn = page.querySelector('#wiz-next')!;
    nextBtn.addEventListener('click', () => {
      stepReached = 2;
      const s1 = page.querySelector('#step1')!;
      const s2 = page.querySelector('#step2')!;
      s1.setAttribute('style', 'display: none;');
      s2.setAttribute('style', 'display: block;');
    });

    const finishBtn = page.querySelector('#wiz-finish')!;
    finishBtn.addEventListener('click', () => {
      stepReached = 3;
      finalPayload = `${page.querySelector('#wiz-user')?.value} -> ${page.querySelector('#wiz-role')?.value} -> ${page.querySelector('#wiz-bio')?.textContent}`;
    });

    // Execute multi-step wizard atomically via options.steps
    const res = await page.fillForm({
      steps: [
        {
          fields: { '#wiz-user': 'architect_alex' },
          submitActionId: '#wiz-next'
        },
        {
          fields: {
            '#wiz-role': 'Staff Engineer',
            '#wiz-bio': 'Building autonomous agents'
          },
          submitActionId: '#wiz-finish'
        }
      ]
    });

    assert.equal(res.success, true);
    assert.equal(res.fieldsFilled, 3);
    assert.equal(stepReached, 3, 'Multi-step wizard must reach final step');
    assert.equal(finalPayload, 'architect_alex -> Staff Engineer -> Building autonomous agents');

    page.close();
    browser.close();
  });

  await test('Autonomous self-healing: gracefully skips absent fields and steps without failure', async () => {
    const browser = new MemoraBrowser({ stealth: true });
    const page = browser.newPage();

    let finalSubmitted = false;

    // Simulating a wizard where Step 2 (Company Details) was skipped by the site
    page.setContent(`
      <html><body>
        <div id="step1">
          <input id="user-name" value="" />
          <button id="step1-next">Continue</button>
        </div>
        <!-- Step 2 is not present / skipped -->
        <div id="step3">
          <input id="shipping-address" value="" />
          <button id="btn-complete">Complete Order</button>
        </div>
      </body></html>
    `, 'http://test/conditional-wizard');

    const btnComplete = page.querySelector('#btn-complete')!;
    btnComplete.addEventListener('click', () => {
      finalSubmitted = true;
    });

    const res = await page.fillForm({
      steps: [
        // Step 1: Matches and fills
        {
          fields: { '#user-name': 'Alex' },
          submit: '#step1-next'
        },
        // Step 2: Not in DOM -> naturally skipped without throwing or needing hardcoded flags
        {
          fields: { '#company-tax-id': '99-887766' },
          submit: '#company-next'
        },
        // Step 3: Matches and completes
        {
          fields: { '#shipping-address': '742 Evergreen Terrace' },
          submit: '#btn-complete'
        }
      ]
    });

    assert.equal(res.success, true);
    assert.deepEqual(res.filled, ['#user-name', '#shipping-address']);
    assert.deepEqual(res.skipped, ['#company-tax-id']);
    assert.equal(res.fieldsFilled, 2);
    assert.equal(finalSubmitted, true, 'Form wizard must successfully complete despite absent step');

    page.close();
    browser.close();
  });

  console.log('\n--- 6. Session Vault (Save & Load Persistent State) ---');

  await test('Exports session to file and restores into a new page session', async () => {
    const browser = new MemoraBrowser({ stealth: true });
    const page = browser.newPage();

    page.setContent('<html><body><h1>Authenticated Area</h1></body></html>', 'https://secure.app.com/home');

    // Inject cookies and localStorage
    page.fetcher.restoreCookies({ 'auth_token': 'jwt-secret-xyz-999', 'user_id': 'user_42' });
    page.sandbox.localStorage.setItem('theme', 'dark');
    page.sandbox.localStorage.setItem('role', 'admin');

    const tmpFile = path.join(os.tmpdir(), `memora-test-session-${Date.now()}.json`);

    try {
      // 1. Save session
      page.saveSession(tmpFile);
      assert.ok(fs.existsSync(tmpFile), 'Session file must be written to disk');

      // 2. Open brand new page and load session
      const cleanPage = browser.newPage();
      cleanPage.setContent('<html><body><h1>Clean Page</h1></body></html>', 'https://secure.app.com/home');
      cleanPage.loadSession(tmpFile);

      // 3. Verify cookies & storage restored
      const cookies = cleanPage.fetcher.dumpCookies();
      assert.equal(cookies['auth_token'], 'jwt-secret-xyz-999');
      assert.equal(cookies['user_id'], 'user_42');

      const theme = cleanPage.sandbox.localStorage.getItem('theme');
      assert.equal(theme, 'dark');
      const role = cleanPage.sandbox.localStorage.getItem('role');
      assert.equal(role, 'admin');

      cleanPage.close();
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      page.close();
      browser.close();
    }
  });

  console.log('\n--- 7. Native Engine MCP Server ---');

  await test('Native MCPServer initializes and executes tools cleanly', async () => {
    const server = new MCPServer({}, 'native');
    assert.equal(server.engineType, 'native', 'Server must be running on native engine');

    // Browse local fixture page
    const browseRes = await (server as any).executeTool('memora_browse', {
      url: 'https://demo-browser.lightpanda.io/amiibo/',
      timeout: 5000
    }).catch(() => null);

    // Test session export via tool
    const tmpMcpFile = path.join(os.tmpdir(), `memora-mcp-session-${Date.now()}.json`);
    try {
      const saveRes = await (server as any).executeTool('memora_session', {
        action: 'save',
        path: tmpMcpFile
      });
      assert.ok(saveRes.includes('successfully exported'), 'Session tool save must succeed');
      assert.ok(fs.existsSync(tmpMcpFile), 'File must exist');
    } finally {
      if (fs.existsSync(tmpMcpFile)) fs.unlinkSync(tmpMcpFile);
    }
  });

  console.log('\n--- 8. Native ES Module (<script type="module">) Support ---');

  await test('Executes inline <script type="module"> and modifies DOM & window state', async () => {
    const browser = new MemoraBrowser({ stealth: true });
    const page = browser.newPage();

    page.setContent(`
      <html>
        <head>
          <script type="module">
            export const secretNum = 777;
            window.esmLoaded = true;
            window.esmValue = secretNum * 2;
            const heading = document.createElement('h1');
            heading.id = 'esm-heading';
            heading.textContent = 'Rendered by ES Module';
            document.body.appendChild(heading);
          </script>
        </head>
        <body>
          <p id="info">Static Text</p>
        </body>
      </html>
    `, 'http://test/esm-inline');

    // Wait for microtask / async module resolution
    await new Promise(r => setTimeout(r, 50));

    const winEsmLoaded = page.evaluate('window.esmLoaded');
    assert.equal(winEsmLoaded.result?.value, true, 'window.esmLoaded should be true');

    const winEsmValue = page.evaluate('window.esmValue');
    assert.equal(winEsmValue.result?.value, 1554, 'window.esmValue should equal 777 * 2');

    const heading = page.querySelector('#esm-heading');
    assert.ok(heading, 'Heading element created by module should exist in DOM');
    assert.equal(heading?.textContent, 'Rendered by ES Module');

    page.close();
    browser.close();
  });

  await test('Loads external <script type="module" src="..."> with dependency resolution & importmap', async () => {
    // Spin up local HTTP server to serve real module files
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <script type="importmap">
                {
                  "imports": {
                    "helper": "/js/math-helper.js"
                  }
                }
              </script>
              <script type="module" src="/js/main-app.js"></script>
            </head>
            <body>
              <div id="app">Loading...</div>
            </body>
          </html>
        `);
      } else if (url.pathname === '/js/main-app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          import { add } from 'helper';
          import { getGreeting } from './sub/greeter.js';

          window.calculation = add(20, 22);
          window.greeting = getGreeting('Agent');

          const el = document.getElementById('app');
          el.textContent = 'App Ready: ' + window.greeting + ' (' + window.calculation + ')';
        `);
      } else if (url.pathname === '/js/math-helper.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          export function add(a, b) { return a + b; }
        `);
      } else if (url.pathname === '/js/sub/greeter.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          export function getGreeting(name) { return 'Hello ' + name; }
        `);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const testUrl = `http://127.0.0.1:${port}/index.html`;

    const browser = new MemoraBrowser({ stealth: true });
    const page = browser.newPage();

    try {
      await page.goto(testUrl);
      await new Promise(r => setTimeout(r, 100));

      const calc = page.evaluate('window.calculation');
      assert.equal(calc.result?.value, 42, 'Module importmap dependency calculation must be 42');

      const greeting = page.evaluate('window.greeting');
      assert.equal(greeting.result?.value, 'Hello Agent', 'Module relative import greeting must be Hello Agent');

      const appText = page.querySelector('#app')?.textContent;
      assert.equal(appText, 'App Ready: Hello Agent (42)', 'DOM must be hydrated by loaded ESM graph');
    } finally {
      page.close();
      browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });

  console.log('\n--- 9. CDP WebSocket & REST Memora Extensions ---');

  await test('Handles Memora.* domain over raw CDP WebSocket', async () => {
    const cdpPort = 9444;
    const browser = new MemoraBrowser({ port: cdpPort, stealth: true });
    const cdpServer = new CDPServer(browser);
    await cdpServer.start();

    const page = browser.newPage();
    page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <h1 id="title">Dashboard</h1>
          <form id="login-form">
            <input type="text" id="username" name="user" value="" />
            <input type="password" id="password" name="pass" value="" />
            <button type="submit" id="btn-submit">Log In</button>
          </form>
        </body>
      </html>
    `, 'http://test/cdp-memora');

    const wsUrl = `ws://127.0.0.1:${cdpPort}/devtools/browser/memora-root`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const sendCDP = (method: string, params: Record<string, any> = {}): Promise<any> => {
      return new Promise((resolve) => {
        const id = Math.floor(Math.random() * 100000);
        const onMsg = (data: any) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            ws.off('message', onMsg);
            resolve(msg);
          }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    try {
      // 1. Memora.getSemanticSnapshot
      const snapRes = await sendCDP('Memora.getSemanticSnapshot');
      assert.ok(snapRes.result?.actions?.length >= 3, 'CDP snapshot must contain actions');

      // 2. Memora.fillForm
      const fillRes = await sendCDP('Memora.fillForm', {
        fields: {
          '#username': 'agent@memora.company',
          '#password': 'secretPass'
        },
        submit: false
      });
      assert.equal(fillRes.result?.success, true, 'Memora.fillForm over CDP must succeed');
      assert.equal(fillRes.result?.fieldsFilled, 2, '2 fields should be filled');

      // 3. Memora.diff
      const diffRes = await sendCDP('Memora.diff');
      assert.ok(diffRes.result?.diff, 'Memora.diff must return a valid diff object');

      // 4. Memora.saveSession & Memora.loadSession
      const tmpSession = path.join(os.tmpdir(), `cdp-session-${Date.now()}.json`);
      const saveRes = await sendCDP('Memora.saveSession', { filePath: tmpSession });
      assert.equal(saveRes.result?.success, true);
      assert.ok(fs.existsSync(tmpSession));

      const loadRes = await sendCDP('Memora.loadSession', { filePath: tmpSession });
      assert.equal(loadRes.result?.success, true);

      if (fs.existsSync(tmpSession)) fs.unlinkSync(tmpSession);
    } finally {
      ws.close();
      await cdpServer.stop();
      browser.close();
    }
  });

  await test('Handles HTTP REST /memora/diff, /memora/fill-form, and /memora/session endpoints', async () => {
    const cdpPort = 9446;
    const browser = new MemoraBrowser({ port: cdpPort, stealth: true });
    const cdpServer = new CDPServer(browser);
    await cdpServer.start();

    const page = browser.newPage();
    page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <input type="text" id="email" value="" />
          <button id="send">Send</button>
        </body>
      </html>
    `, 'http://test/rest-memora');

    try {
      // 1. GET /memora/snapshot?format=markdown
      const mdRes = await fetch(`http://127.0.0.1:${cdpPort}/memora/snapshot?format=markdown`);
      assert.equal(mdRes.status, 200);
      const mdText = await mdRes.text();
      assert.ok(mdText.includes('Send'));

      // 2. POST /memora/fill-form
      const fillRes = await fetch(`http://127.0.0.1:${cdpPort}/memora/fill-form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: { '#email': 'rest.agent@memora.company' },
          submit: false
        })
      });
      assert.equal(fillRes.status, 200);
      const fillJson = await fillRes.json();
      assert.equal(fillJson.success, true);
      assert.equal(fillJson.fieldsFilled, 1);

      // 3. GET /memora/diff
      const diffRes = await fetch(`http://127.0.0.1:${cdpPort}/memora/diff`);
      assert.equal(diffRes.status, 200);
      const diffJson = await diffRes.json();
      assert.ok(diffJson.diff, 'REST /memora/diff must return diff payload');

      // 4. GET & POST /memora/session
      const sessionGetRes = await fetch(`http://127.0.0.1:${cdpPort}/memora/session`);
      assert.equal(sessionGetRes.status, 200);
      const sessionData = await sessionGetRes.json();
      assert.equal(sessionData.version, 1);

      const sessionPostRes = await fetch(`http://127.0.0.1:${cdpPort}/memora/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionData })
      });
      assert.equal(sessionPostRes.status, 200);
      const postResult = await sessionPostRes.json();
      assert.equal(postResult.success, true);
    } finally {
      await cdpServer.stop();
      browser.close();
    }
  });

  console.log('\n--- 10. Official Framework Adapters (MemoraAgent, Stagehand, LangChain) ---');

  await test('MemoraAgent 1-line launcher and framework configs work out of the box', async () => {
    const agent = await MemoraAgent.launch({ cdpPort: 9448, stealth: true });

    agent.page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <h2>Quick Automation</h2>
          <input type="text" id="query" value="" />
          <button id="search">Search</button>
        </body>
      </html>
    `, 'http://test/agent-sdk');

    try {
      const snap = agent.snapshot();
      assert.ok(snap.interactiveCount >= 2, 'Snapshot should detect interactive elements');

      // Test high level agent methods
      const actOk = agent.act('@1', 'quantum computing');
      assert.equal(actOk, true);

      const diff = agent.diff();
      assert.ok(diff.summary);

      // Test Browser-Use config helper
      const buConfig = getBrowserUseConfig(agent);
      assert.ok(buConfig.cdpUrl.includes('9448'));
      assert.equal(buConfig.disableSecurity, true);

      // Test Stagehand config helper
      const shConfig = getStagehandConfig(agent);
      assert.equal(shConfig.env, 'LOCAL');
      assert.ok(shConfig.localBrowserUrl.includes('9448'));

      // Test LangChain tools adapter
      const tools = createMemoraLangChainTools(agent);
      assert.equal(tools.length, 5, 'Should export 5 LangChain tools');
      const snapToolResult = await tools[1].invoke({});
      assert.ok(snapToolResult.includes('INTERACTIVE ACTION MAP'));
    } finally {
      await agent.close();
    }
  });

  await test('Verifies Orbis aliases, OrbisAgent, Orbis CDP domains and REST endpoints', async () => {
    assert.equal(OrbisBrowser, MemoraBrowser);
    assert.equal(OrbisAgent, MemoraAgent);
    assert.equal(getOrbisBrowserUseConfig, getBrowserUseConfig);
    assert.equal(getOrbisStagehandConfig, getStagehandConfig);

    const agent = await OrbisAgent.launch({ cdpPort: 9449, stealth: true });
    try {
      agent.page.setContent(`
        <html>
          <head><title>Orbis by Memora</title></head>
          <body>
            <h1>Welcome to Orbis by Memora</h1>
            <input type="text" id="query" value="ai" />
            <button id="search">Search</button>
          </body>
        </html>
      `, 'http://test/orbis');

      // Test Orbis LangChain tools
      const orbisTools = createOrbisLangChainTools(agent);
      assert.equal(orbisTools.length, 5);
      assert.equal(orbisTools[0].name, 'orbis_navigate');

      // Test /orbis/snapshot REST endpoint
      const res = await fetch('http://127.0.0.1:9449/orbis/snapshot');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.title.includes('Orbis by Memora'));

      // Test /json/version product branding
      const verRes = await fetch('http://127.0.0.1:9449/json/version');
      assert.equal(verRes.status, 200);
      const verData = await verRes.json();
      assert.equal(verData.product, 'Orbis/0.1.1');
      assert.equal(verData.website, 'https://orbis.memora.company');
    } finally {
      await agent.close();
    }
  });
  console.log('\n--- 11. Universal Multi-Modal Locators (Playwright, Selenium, Semantic & Dropdowns) ---');

  await test('Resolves elements via labels, placeholders, text, role, testid, XPath and semantic aliases', async () => {
    const browser = new OrbisBrowser({ stealth: true });
    const page = browser.newPage();

    page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Universal Locators Test</title></head>
        <body>
          <form id="signup-form" onsubmit="return false;">
            <label for="user-email">Email Address</label>
            <input type="email" id="user-email" name="email" placeholder="you@domain.com" />

            <label>
              Password
              <input type="password" name="pwd" placeholder="Enter secure password" />
            </label>

            <select id="country-select" name="country">
              <option value="">Select country...</option>
              <option value="US">United States</option>
              <option value="IN">India</option>
              <option value="UK">United Kingdom</option>
            </select>

            <button type="button" data-testid="submit-btn" role="button">Create Account</button>
          </form>
        </body>
      </html>
    `, 'http://test/locators');

    // 1. Playwright Label Locator
    const emailByLabel = page.resolveElement('label:Email Address');
    assert.ok(emailByLabel, 'Should resolve input by label text');
    assert.equal(emailByLabel?.id, 'user-email');

    // 2. Playwright Nested Label
    const pwdByLabel = page.resolveElement('label:Password');
    assert.ok(pwdByLabel, 'Should resolve nested input inside label');
    assert.equal(pwdByLabel?.getAttribute('name'), 'pwd');

    // 3. Playwright Placeholder Locator
    const emailByPh = page.resolveElement('placeholder:you@domain.com');
    assert.ok(emailByPh, 'Should resolve by placeholder');
    assert.equal(emailByPh?.id, 'user-email');

    // 4. Playwright TestID Locator
    const btnByTestId = page.resolveElement('testid:submit-btn');
    assert.ok(btnByTestId, 'Should resolve by data-testid');
    assert.equal(btnByTestId?.tagName, 'button');

    // 5. Playwright Text Locator
    const btnByText = page.resolveElement('text=Create Account');
    assert.ok(btnByText, 'Should resolve by text=');
    assert.equal(btnByText?.tagName, 'button');

    // 6. Playwright Role Locator
    const btnByRole = page.resolveElement('role:button[name="Create Account"]');
    assert.ok(btnByRole, 'Should resolve by role:button[name="..."]');
    assert.equal(btnByRole?.tagName, 'button');

    // 7. XPath Locator
    const btnByXPath = page.resolveElement('//button[@data-testid="submit-btn"]');
    assert.ok(btnByXPath, 'Should resolve by XPath //');
    assert.equal(btnByXPath?.tagName, 'button');

    // 8. Semantic Alias Locator (@email)
    const emailByAlias = page.resolveElement('@email');
    assert.ok(emailByAlias, 'Should resolve by semantic alias @email');
    assert.equal(emailByAlias?.id, 'user-email');

    // 9. Dropdown selectOption by text / value
    const selectSuccess = page.selectDropdownOption('#country-select', 'India');
    assert.equal(selectSuccess, true, 'Should successfully select India from dropdown');
    const selectedOpt = page.document.querySelector('option[value="IN"]');
    assert.ok(selectedOpt?.hasAttribute('selected'), 'India option must have selected attribute');

    // 10. fillForm with multi-modal locators
    const fillRes = await page.fillForm({
      fields: {
        'label:Email Address': 'alex@memora.company',
        'placeholder:Enter secure password': 'SecretPassword123!',
        '#country-select': 'United States'
      },
      submit: 'testid:submit-btn'
    });
    assert.equal(fillRes.success, true);
    assert.equal(emailByLabel?.value, 'alex@memora.company');
    assert.equal(pwdByLabel?.value, 'SecretPassword123!');
    const usOpt = page.document.querySelector('option[value="US"]');
    assert.ok(usOpt?.hasAttribute('selected'), 'US option must be selected');

    page.close();
    browser.close();
  });
}

run().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});

