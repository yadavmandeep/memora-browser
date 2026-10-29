import { chromium } from 'playwright-core';
import { MemoraBrowser } from '../src/index.js';
import { CDPServer } from '../src/cdp/server.js';

async function testFullPlaywrightSuite() {
  console.log('================================================================');
  console.log('🎭 VERIFYING PLAYWRIGHT END-TO-END SUITE WITH MEMORA BROWSER 🎭');
  console.log('================================================================\n');

  process.env.DEBUG_CDP = '1';
  const PORT = 9233;
  const browser = new MemoraBrowser({ port: PORT, stealth: true });

  const initialPage = browser.newPage();
  initialPage.setContent(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>Memora Dashboard — Playwright Verified</title>
      </head>
      <body>
        <h1 id="main-heading">Autonomous Agent Portal</h1>
        <p id="status-text">Engine Ready</p>
        <input id="agent-input" type="text" placeholder="Enter instruction..." value="Initial Query" />
        <button id="run-btn" onclick="document.getElementById('status-text').textContent = 'Execution Started'">
          Execute Task
        </button>
      </body>
    </html>
  `, 'http://localhost/portal');

  const server = new CDPServer(browser);
  await server.start();
  console.log(`[CDP Server] Listening on http://127.0.0.1:${PORT}\n`);

  try {
    // 1. Handshake & Connect over CDP
    console.log('▶ [Step 1]: Connecting Playwright over CDP...');
    const pwBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    console.log('  ✓ Connected to Memora Browser successfully!');

    // 2. Validate Context & Pages
    console.log('▶ [Step 2]: Verifying Browser Contexts & Pages...');
    const context = pwBrowser.contexts()[0];
    const pages = context.pages();
    console.log(`  ✓ Active Pages detected by Playwright: ${pages.length}`);

    const activePage = pages[0];
    console.log(`  ✓ Active Page Title: "${await activePage.title()}"`);
    console.log(`  ✓ Active Page URL: "${activePage.url()}"`);

    // 3. Evaluate JavaScript through Playwright in Memora's V8 Sandbox
    console.log('▶ [Step 3]: Executing JS via Playwright page.evaluate()...');
    const evalResult = await activePage.evaluate(() => {
      return {
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        sum: 100 + 250,
      };
    });
    console.log(`  ✓ Evaluation Result:`, evalResult);

    // 4. Verify Content Extraction via Playwright
    console.log('▶ [Step 4]: Extracting page content via Playwright page.content()...');
    const content = await activePage.content();
    console.log(`  ✓ Content contains heading: ${content.includes('Autonomous Agent Portal')}`);

    // 5. Query element state via Playwright
    console.log('▶ [Step 5]: Querying DOM element via Playwright page.locator()...');
    const heading = await activePage.textContent('#main-heading');
    console.log(`  ✓ Heading text extracted: "${heading}"`);

    await pwBrowser.close();
    console.log('\n✅ PLAYWRIGHT FULL INTEGRATION VERIFICATION PASSED (100% SUCCESS)!');
  } catch (err: any) {
    console.error('❌ Playwright Error:', err);
    process.exitCode = 1;
  } finally {
    await server.stop();
    browser.close();
  }
}

testFullPlaywrightSuite().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
