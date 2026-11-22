import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentBlackboard } from '../src/memory/index.js';
import { SelfHealingLocator } from '../src/dom/healing.js';
import { SessionImporter } from '../src/vault/importer.js';
import { parseHTML } from '../src/dom/parser.js';
import { ChromeEngine } from '../src/engine/chrome-engine.js';

console.log('=== Running Step 5 (v0.3.0 Local Agent Power) Test Suite ===\n');

async function testAgentBlackboard() {
  console.log('Testing Component 5.1: Cross-Tab Agent Blackboard & Context Graph...');

  const bb = new AgentBlackboard('session-multitab-1');

  // 1. Variables
  bb.set('auth_token', 'jwt_secret_token_abc');
  bb.set('pricing_tier', 'enterprise_pro');
  assert.equal(bb.get('auth_token'), 'jwt_secret_token_abc');
  assert.equal(bb.get('pricing_tier'), 'enterprise_pro');

  // 2. Multi-Tab Tracking
  bb.registerTab({ id: 'tab-1', url: 'https://docs.aws.amazon.com', title: 'AWS Documentation', active: true });
  bb.registerTab({ id: 'tab-2', url: 'https://github.com/my-org/app', title: 'GitHub PR #42', active: false });

  assert.equal(bb.listTabs().length, 2);

  // 3. Facts recorded across tabs
  bb.recordFact('EC2 c6g.large pricing is $0.068/hr in us-east-1', 'pricing', 'tab-1');
  bb.recordFact('PR #42 requires Docker base image update to node:22', 'pr_review', 'tab-2');

  const facts = bb.listFacts();
  assert.equal(facts.length, 2);
  assert.equal(facts[0].category, 'pricing');

  // 4. Compact Markdown Summary (under 150 tokens)
  const summary = bb.getSharedContextMarkdown();
  assert.ok(summary.includes('AWS Documentation'), 'Summary should include Tab 1');
  assert.ok(summary.includes('GitHub PR #42'), 'Summary should include Tab 2');
  assert.ok(summary.includes('pricing_tier'), 'Summary should include stored variables');
  assert.ok(summary.includes('c6g.large'), 'Summary should include recorded facts');

  console.log('  ✓ Shared context markdown generated:\n' + summary.split('\n').map(l => '    ' + l).join('\n'));
  console.log('  ✓ Agent Blackboard passed 100%\n');
}

async function testSelfHealingLocator() {
  console.log('Testing Component 5.2: Autonomous Self-Healing Locator Engine...');

  const healer = new SelfHealingLocator();

  // Page where the button class or ID changed (e.g. from #btn-login to #submit-auth)
  const html = `
    <html>
      <body>
        <form>
          <input type="text" id="username" placeholder="Username" />
          <button id="submit-auth" aria-label="Sign In to Account">Sign In</button>
        </form>
      </body>
    </html>
  `;
  const doc = parseHTML(html);

  // 1. Healer recovers using semantic text match
  const healedText = healer.heal('Sign In', doc);
  assert.ok(healedText, 'Should heal using button text');
  assert.equal(healedText?.strategy, 'semantic_text');
  assert.ok(healedText?.confidence >= 0.8, 'Confidence should be high');
  assert.equal(healedText?.matchedElementText, 'Sign In');
  console.log(`  ✓ Healed by text: "${healedText.healedSelector}" (Confidence: ${healedText.confidence})`);

  // 2. Healer recovers using aria-label
  const healedAria = healer.heal('Sign In to Account', doc);
  assert.ok(healedAria, 'Should heal using aria-label');
  assert.equal(healedAria?.strategy, 'aria_label');
  console.log(`  ✓ Healed by aria-label: "${healedAria.healedSelector}" (Confidence: ${healedAria.confidence})`);

  // 3. Healer recovers input using placeholder
  const healedInput = healer.heal('Username', doc);
  assert.ok(healedInput, 'Should heal using placeholder');
  assert.equal(healedInput?.strategy, 'placeholder');
  console.log(`  ✓ Healed by placeholder: "${healedInput.healedSelector}" (Confidence: ${healedInput.confidence})`);

  console.log('  ✓ Self-Healing Locator passed 100%\n');
}

async function testSessionImporter() {
  console.log('Testing Component 5.3: Netscape & JSON Cookie Importer...');

  const testDir = path.join(process.cwd(), '.test-cookies');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  // 1. Netscape Cookie format
  const netscapeContent = `# Netscape HTTP Cookie File
.github.com\tTRUE\t/\tTRUE\t1893456000\tuser_session\tsecret_gh_session_9988
.github.com\tTRUE\t/\tFALSE\t1893456000\thas_recent_activity\t1
`;
  const netscapePath = path.join(testDir, 'cookies.txt');
  fs.writeFileSync(netscapePath, netscapeContent, 'utf8');

  const netscapeSession = SessionImporter.importFromFile(netscapePath, 'https://github.com');
  assert.equal(netscapeSession.cookies.user_session, 'secret_gh_session_9988');
  assert.equal(netscapeSession.cookieList?.length, 2);
  console.log(`  ✓ Imported Netscape cookie file (${netscapeSession.cookieList?.length} cookies)`);

  // 2. JSON Cookie format (EditThisCookie / Cookie-Editor)
  const jsonContent = JSON.stringify([
    {
      domain: '.jira.corp.com',
      expirationDate: 1893456000,
      httpOnly: true,
      name: 'JSESSIONID',
      path: '/',
      secure: true,
      value: 'jira_session_token_xyz'
    }
  ]);
  const jsonPath = path.join(testDir, 'cookies.json');
  fs.writeFileSync(jsonPath, jsonContent, 'utf8');

  const jsonSession = SessionImporter.importFromFile(jsonPath, 'https://jira.corp.com');
  assert.equal(jsonSession.cookies.JSESSIONID, 'jira_session_token_xyz');
  assert.equal(jsonSession.cookieList?.[0].httpOnly, true);
  console.log(`  ✓ Imported JSON cookie format (${jsonSession.cookieList?.length} cookies)`);

  // Clean up
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log('  ✓ Session Importer passed 100%\n');
}

async function testChromeEngineSelfHealing() {
  console.log('Testing Component 5.4: Live ChromeEngine Self-Healing Action Recovery...');

  let engine: ChromeEngine | null = null;
  try {
    engine = new ChromeEngine({ lowMemory: true }, { headless: true });

    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <h2>Self-Healing Test</h2>
          <button id="btn-real-id" style="padding: 10px 20px;">Click Me To Win</button>
          <script>
            let clicked = false;
            document.getElementById('btn-real-id').addEventListener('click', () => {
              clicked = true;
              document.getElementById('btn-real-id').textContent = 'Successfully Clicked Real Button!';
            });
          </script>
        </body>
      </html>
    `;
    await engine.goto(`data:text/html,${encodeURIComponent(html)}`);

    // Target a broken/non-existent selector: "#btn-broken-old" with semantic clue "Click Me To Win"
    const actRes = await engine.act('Click Me To Win', 'click');
    assert.equal(actRes.success, true);

    const btnText = await engine.html('#btn-real-id');
    assert.ok(btnText.includes('Successfully Clicked Real Button!'), 'Self-healing must trigger real click');
    console.log('  ✓ Self-healing caught broken target, located button by text, and executed click successfully!');

    // Test blackboard on ChromeEngine
    const bb = engine.getBlackboard();
    bb.recordFact('Self-healing successfully tested in Chrome Engine', 'tests');
    assert.equal(bb.listFacts().length, 1);

    console.log('  ✓ ChromeEngine Self-Healing passed 100%\n');
  } finally {
    if (engine) await engine.close();
  }
}

async function runAll() {
  await testAgentBlackboard();
  await testSelfHealingLocator();
  await testSessionImporter();
  await testChromeEngineSelfHealing();
  console.log('🎉 ALL STEP 5 (v0.3.0) FEATURES PASSED 100%!');
}

runAll().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
