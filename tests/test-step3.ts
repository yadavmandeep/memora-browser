import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PIIMasker, validateLuhn } from '../src/firewall/pii/index.js';
import { FlightRecorder } from '../src/recorder/index.js';
import { ChromeEngine } from '../src/engine/chrome-engine.js';

console.log('=== Running Step 3 (v0.4.0 Local Features) Test Suite ===\n');

async function testPIIMasker() {
  console.log('Testing Component 3.1: Client-Side Two-Way PII & Secret Masking...');

  const masker = new PIIMasker();

  // 1. Credit Card Luhn validation
  const validVisa = '4242 4242 4242 4242'; // passes Luhn (Stripe standard)
  const invalidCard = '4242 4242 4242 4241'; // fails Luhn
  assert.equal(validateLuhn(validVisa), true, 'Valid card should pass Luhn');
  assert.equal(validateLuhn(invalidCard), false, 'Invalid card should fail Luhn');

  // 2. Sensitive text containing multiple secrets
  const rawText = `
    User Profile:
    Name: Mandeep Yadav
    Email: mandeep@corp.example.com
    Phone: +1 555-234-5678
    OpenAI Key: sk-proj-abc123def456ghi789jkl012mno345pqr
    GitHub Token: ghp_1234567890abcdefghijklmnopqrstuvwx
    Payment Card: 4242 4242 4242 4242
    Password: mySuperSecretPassword!
  `;

  const maskRes = masker.mask(rawText);
  assert.ok(maskRes.count >= 4, `Should mask at least 4 PII items, got: ${maskRes.count}`);
  assert.ok(maskRes.text.includes('[PII:EMAIL:1]'), 'Email should be masked');
  assert.ok(maskRes.text.includes('[PII:API_KEY:'), 'API Keys should be masked');
  assert.ok(maskRes.text.includes('[PII:CREDIT_CARD:1]'), 'Credit card should be masked');
  assert.ok(!maskRes.text.includes('mandeep@corp.example.com'), 'Original email must not exist in masked text');
  assert.ok(!maskRes.text.includes('4242 4242 4242 4242'), 'Original card must not exist in masked text');
  console.log(`  Masked ${maskRes.count} secrets with types:`, maskRes.types);

  // 3. Two-Way Unmasking (Inbound LLM -> Outbound Web Form)
  const syntheticActionPayload = {
    emailField: '[PII:EMAIL:1]',
    cardField: '[PII:CREDIT_CARD:1]'
  };

  const unmasked = masker.unmaskObject(syntheticActionPayload);
  assert.equal(unmasked.emailField, 'mandeep@corp.example.com');
  assert.equal(unmasked.cardField, '4242 4242 4242 4242');
  console.log('  ✓ Two-way unmasking transparently restored real credentials');

  console.log('  ✓ Client-side PII Masking passed 100%\n');
}

async function testFlightRecorder() {
  console.log('Testing Component 3.2: Agent Flight Recorder & HTML Replay Generation...');

  const testTraceDir = path.join(process.cwd(), '.test-traces');
  if (fs.existsSync(testTraceDir)) {
    fs.rmSync(testTraceDir, { recursive: true, force: true });
  }

  const recorder = new FlightRecorder({ traceDir: testTraceDir });
  const session = recorder.startSession('https://app.example.com/login', 'E2E-Login-Test');

  // Step 1: Navigated
  recorder.recordStep({
    url: 'https://app.example.com/login',
    title: 'Sign In — Example App',
    action: { type: 'navigate', target: 'https://app.example.com/login', success: true },
    actionMapText: '[@1] [input:text] "Email"\n[@2] [input:password] "Password"\n[@3] [button] "Sign In"',
    diffSummary: { addedNodes: 15, removedNodes: 0, urlChanged: true, titleChanged: true }
  });

  // Step 2: Typed credentials
  recorder.recordStep({
    url: 'https://app.example.com/login',
    title: 'Sign In — Example App',
    action: { type: 'type', target: '@1', value: '[PII:EMAIL:1]', success: true },
    actionMapText: '[@1] [input:text] "Email" (filled)\n[@2] [input:password] "Password"\n[@3] [button] "Sign In"',
    diffSummary: { addedNodes: 0, removedNodes: 0, urlChanged: false, titleChanged: false }
  });

  // Step 3: Clicked Sign In
  recorder.recordStep({
    url: 'https://app.example.com/dashboard',
    title: 'Dashboard — Example App',
    action: { type: 'click', target: '@3', success: true },
    actionMapText: '[@1] [button] "Logout"\n[@2] [a] "Settings"',
    diffSummary: { addedNodes: 24, removedNodes: 10, urlChanged: true, titleChanged: true },
    consoleLogs: [{ type: 'info', text: 'User logged in successfully' }]
  });

  const ended = recorder.endSession();
  assert.equal(ended.steps.length, 3);
  assert.ok(ended.totalDurationMs !== undefined && ended.totalDurationMs >= 0);

  // Check generated files
  const files = fs.readdirSync(testTraceDir);
  const jsonFile = files.find(f => f.endsWith('.json'));
  const htmlFile = files.find(f => f.endsWith('.html'));

  assert.ok(jsonFile, 'Flight JSON trace file should be generated');
  assert.ok(htmlFile, 'Flight HTML replay player should be generated');

  const htmlContent = fs.readFileSync(path.join(testTraceDir, htmlFile!), 'utf8');
  assert.ok(htmlContent.includes('<!DOCTYPE html>'), 'HTML replay must be valid HTML');
  assert.ok(htmlContent.includes('FLIGHT RECORDER'), 'HTML replay must contain brand header');
  assert.ok(htmlContent.includes('step-scrubber'), 'HTML replay must contain interactive scrubber slider');
  assert.ok(htmlContent.includes('session-data'), 'HTML replay must contain embedded session data script');
  console.log(`  ✓ Generated standalone offline HTML replay player (${htmlContent.length} bytes)`);

  // Clean up
  try {
    fs.rmSync(testTraceDir, { recursive: true, force: true });
  } catch {}

  console.log('  ✓ Agent Flight Recorder passed 100%\n');
}

async function testEngineStep3Integration() {
  console.log('Testing Component 3.3: ChromeEngine Step 3 Integration (PII + Recorder)...');

  let engine: ChromeEngine | null = null;
  try {
    engine = new ChromeEngine({ lowMemory: true }, { headless: true });

    // Enable PII masking and recording
    engine.setPIIMasking(true);
    const session = engine.enableRecording('Test-Integration-Run');
    assert.ok(session, 'Flight session should be initialized');

    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <h2>Checkout Page</h2>
          <div>Contact Support: support@company.org</div>
          <input id="email" placeholder="Email" />
          <button id="btn">Submit</button>
        </body>
      </html>
    `;
    await engine.goto(`data:text/html,${encodeURIComponent(html)}`);

    // Act with PII synthetic token
    engine.getPIIMasker().mask('Pre-seed email: support@company.org');
    await engine.act('#email', 'type', '[PII:EMAIL:1]');

    // Verify input contains the UNMASKED real email
    const val = await (await engine.ensurePage()).$eval('#email', (el: any) => el.value);
    assert.equal(val, 'support@company.org', 'Transparent unmasking must fill input with real email');
    console.log('  ✓ Chrome Engine typed unmasked real value into input');

    // Stop recording and verify steps captured
    const ended = engine.stopRecording();
    assert.ok(ended && ended.steps.length >= 1, 'Flight recorder should capture engine actions');
    console.log(`  ✓ Flight recorder automatically captured ${ended?.steps.length} steps in engine`);

    console.log('  ✓ ChromeEngine Step 3 Integration passed 100%\n');
  } finally {
    if (engine) await engine.close();
  }
}

async function run() {
  await testPIIMasker();
  await testFlightRecorder();
  await testEngineStep3Integration();
  console.log('🎉 ALL STEP 3 (v0.4.0) LOCAL FEATURES PASSED 100%!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
