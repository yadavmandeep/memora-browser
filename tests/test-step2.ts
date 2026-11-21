import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionVault, encryptData, decryptData } from '../src/vault/index.js';
import { OrbisBrowser } from '../src/engine/browser.js';
import { ChromeEngine } from '../src/engine/chrome-engine.js';
import { SessionData } from '../src/types/index.js';

console.log('=== Running Step 2 (v0.3.0) Test Suite ===\n');

async function testSessionVault() {
  console.log('Testing Component 2.1: Encrypted Session Vault (AES-256-GCM)...');

  const testDir = path.join(process.cwd(), '.test-vault');
  const vaultPath = path.join(testDir, 'vault-test.enc');
  if (fs.existsSync(vaultPath)) fs.unlinkSync(vaultPath);

  // 1. Direct Cipher Test
  const secretText = JSON.stringify({ token: 'ghp_secret_token_12345', user: 'ai-agent' });
  const passphrase = 'MySuperSecurePassphrase!2026';
  const encrypted = encryptData(secretText, passphrase);
  assert.ok(encrypted && typeof encrypted === 'string', 'Encrypted output should be a string');
  assert.notEqual(encrypted, secretText, 'Encrypted output must not match plaintext');

  const decrypted = decryptData(encrypted, passphrase);
  assert.equal(decrypted, secretText, 'Decrypted output must match original plaintext');

  // Tamper detection
  assert.throws(() => {
    decryptData(encrypted, 'WrongPassphrase!');
  }, /authentication failed|bad decrypt|unsupported state/i, 'Wrong passphrase should throw error');

  // 2. SessionVault Manager Test
  const vault = new SessionVault({ vaultPath, masterKey: passphrase });

  const mockSession: SessionData = {
    version: 1,
    createdAt: new Date().toISOString(),
    url: 'https://github.com/login',
    cookies: { user_session: 'xyz789_auth' },
    cookieList: [
      {
        name: 'user_session',
        value: 'xyz789_auth',
        domain: 'github.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600 // expires in 1 hour
      }
    ],
    localStorage: { token: 'jwt_123' },
    sessionStorage: {}
  };

  const summary = vault.saveProfile('work-github', mockSession);
  assert.equal(summary.name, 'work-github');
  assert.equal(summary.domain, 'github.com');
  assert.equal(summary.isExpired, false);
  assert.ok(fs.existsSync(vaultPath), 'Vault file should exist on disk');

  // Load profile
  const loaded = vault.loadProfile('work-github');
  assert.ok(loaded, 'Loaded session should exist');
  assert.equal(loaded?.cookies.user_session, 'xyz789_auth');

  // Find for domain
  const domainFound = vault.findSessionForDomain('github.com');
  assert.ok(domainFound, 'Should find session for github.com');
  assert.equal(domainFound?.name, 'work-github');

  // List profiles
  const profiles = vault.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'work-github');

  // Delete profile
  const deleted = vault.deleteProfile('work-github');
  assert.equal(deleted, true);
  assert.equal(vault.listProfiles().length, 0);

  // Clean up
  try {
    if (fs.existsSync(vaultPath)) fs.unlinkSync(vaultPath);
    if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
  } catch {}

  console.log('  ✓ Encrypted Session Vault passed 100%\n');
}

async function testSmartWaitNative() {
  console.log('Testing Component 2.2: smartWait on Native Engine...');
  const browser = new OrbisBrowser();
  const page = browser.newPage();

  const waitRes = await page.smartWait({ timeoutMs: 1000 });
  assert.ok(waitRes, 'smartWait should return result object');
  assert.equal(waitRes.settled, true);
  assert.equal(waitRes.hydrated, true);
  assert.equal(waitRes.frameworkDetected, 'Native AST Engine');

  browser.close();
  console.log('  ✓ Native smartWait passed 100%\n');
}

async function testChromeStep2Features() {
  console.log('Testing Component 2.3: ChromeEngine Vision & smartWait...');
  let engine: ChromeEngine | null = null;
  try {
    engine = new ChromeEngine({ lowMemory: true }, { headless: true });

    // Navigate to a rich data URI HTML page with canvas, buttons and inputs
    const testHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Orbis Vision & SmartWait Test</title></head>
        <body style="margin: 0; padding: 20px; font-family: sans-serif;">
          <h1>Welcome to Orbis Test Page</h1>
          <button id="btn-submit" style="padding: 10px 20px; font-size: 16px;">Click Me</button>
          <input type="text" id="input-name" placeholder="Enter your name" style="margin-left: 10px;" />
          <div style="margin-top: 20px;">
            <canvas id="chart-canvas" width="300" height="150" style="border: 1px solid #ccc;"></canvas>
          </div>
          <script>
            // Draw something on canvas
            const ctx = document.getElementById('chart-canvas').getContext('2d');
            ctx.fillStyle = '#ff0055';
            ctx.fillRect(20, 20, 100, 50);

            let clicked = false;
            document.getElementById('btn-submit').addEventListener('click', () => {
              clicked = true;
              document.getElementById('btn-submit').textContent = 'Clicked Successfully!';
            });
          </script>
        </body>
      </html>
    `;

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`;
    await engine.goto(dataUrl);

    // 1. Test smartWait
    const waitRes = await engine.smartWait({ timeoutMs: 1500 });
    assert.ok(waitRes, 'smartWait should return result');
    assert.equal(waitRes.settled, true);
    console.log(`  smartWait settled in ${waitRes.elapsedMs}ms (reason: ${waitRes.reason})`);

    // 2. Test Vision Snapshot
    const vision = await engine.getVisionSnapshot({ withOverlay: true });
    assert.ok(vision, 'Vision snapshot should be returned');
    assert.ok(vision.imageBuffer.length > 0, 'Screenshot image buffer should not be empty');
    assert.equal(vision.hasCanvas, true, 'Canvas should be detected');
    assert.ok(vision.elements.length >= 2, 'Should detect button, input, and canvas');
    console.log(`  Detected ${vision.elements.length} interactive visual elements with @v IDs:`);
    for (const el of vision.elements) {
      console.log(`    [${el.id}] <${el.tag}> "${el.text}" at (${el.center.x}, ${el.center.y})`);
    }

    // 3. Test act() using visual ID @v1
    const firstBtn = vision.elements.find(e => e.tag === 'button');
    assert.ok(firstBtn, 'Should find visual button element');
    const actRes = await engine.act(firstBtn.id, 'click');
    assert.equal(actRes.success, true);

    // Verify button text changed to 'Clicked Successfully!'
    const btnText = await engine.html('#btn-submit');
    assert.ok(btnText.includes('Clicked Successfully!'), 'Button click via @v action ID should trigger event listener');
    console.log('  ✓ Visual action ID click triggered in-page listener successfully!');

    // 4. Test screenshot method
    const png = await engine.screenshot();
    assert.ok(png instanceof Buffer && png.length > 1000, 'screenshot() returns valid buffer');
    console.log(`  ✓ Raw screenshot captured: ${png.length} bytes`);

    console.log('  ✓ Chrome Engine Vision & smartWait passed 100%\n');
  } finally {
    if (engine) await engine.close();
  }
}

async function runAll() {
  await testSessionVault();
  await testSmartWaitNative();
  await testChromeStep2Features();
  console.log('🎉 ALL STEP 2 (v0.3.0) FEATURES PASSED WITH 100% SUCCESS!');
}

runAll().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
