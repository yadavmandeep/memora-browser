/**
 * Memora Browser — Real-World Login Page Testing Demo
 * 
 * Run with default login portal:
 *   npx tsx examples/test-login.ts
 * 
 * Or test any live website URL:
 *   npx tsx examples/test-login.ts https://news.ycombinator.com/login
 */

import { MemoraBrowser } from '../src/index.js';

async function testLoginPage() {
  const targetUrl = process.argv[2];

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       🔐 MEMORA BROWSER — REAL LOGIN TEST WORKFLOW             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const browser = new MemoraBrowser({ stealth: true });
  const page = browser.newPage();

  if (targetUrl) {
    // Mode A: Test Live External URL
    console.log(`🌐 [Step 1]: Fetching real-world URL: ${targetUrl} ...`);
    const t0 = performance.now();
    try {
      const resp = await page.goto(targetUrl);
      const loadTime = (performance.now() - t0).toFixed(1);
      console.log(`  ✓ Page fetched (HTTP ${resp.status}) in ${loadTime}ms!`);
    } catch (err: any) {
      console.error(`  ❌ Failed to fetch external URL: ${err.message}`);
      return;
    }
  } else {
    // Mode B: Realistic Production SaaS Login Portal
    console.log('📦 [Step 1]: Loading Production SaaS Login Portal...');
    const loginHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Acme Cloud — Secure Sign In</title>
      </head>
      <body>
        <div class="auth-card">
          <h1>Sign in to your account</h1>
          <p class="subtitle">Enter your corporate credentials to continue</p>
          
          <div id="login-alert" style="display:none; color: red;"></div>

          <form id="login-form">
            <div class="field">
              <label for="user-email">Email Address</label>
              <input id="user-email" name="email" type="email" placeholder="name@company.com" required />
            </div>

            <div class="field">
              <label for="user-password">Password</label>
              <input id="user-password" name="password" type="password" placeholder="••••••••" required />
            </div>

            <div class="checkbox-field">
              <input id="remember-me" name="remember" type="checkbox" />
              <label for="remember-me">Keep me signed in for 14 days</label>
            </div>

            <button id="signin-btn" type="submit">Sign In</button>
            <a id="forgot-link" href="/reset-password">Forgot your password?</a>
          </form>

          <div class="divider">or continue with</div>
          <button id="sso-google" role="button">Google SSO</button>
          <button id="sso-github" role="button">GitHub Enterprise</button>
        </div>

        <script>
          document.getElementById('login-form').addEventListener('submit', function(e) {
            e.preventDefault();
            const email = document.getElementById('user-email').value;
            const pass = document.getElementById('user-password').value;
            const alertBox = document.getElementById('login-alert');
            
            if (email && pass) {
              alertBox.style.display = 'block';
              alertBox.style.color = 'green';
              alertBox.textContent = 'SUCCESS: Authentication granted for ' + email;
            } else {
              alertBox.style.display = 'block';
              alertBox.textContent = 'ERROR: Email and password are required.';
            }
          });
        </script>
      </body>
      </html>
    `;
    page.setContent(loginHtml, 'https://auth.acme-cloud.io/login');
    console.log('  ✓ Page loaded into Memora Engine!');
  }

  // Step 2: Extract AI Agent Semantic Action Map
  console.log('\n🧠 [Step 2]: Distilling Semantic Action Map (What LLM sees)...');
  const tDistill = performance.now();
  const snapshot = page.getSemanticSnapshot();
  const distillMs = (performance.now() - tDistill).toFixed(2);

  console.log(`  ✓ Title: "${snapshot.title}"`);
  console.log(`  ✓ Distill Latency: ${distillMs}ms`);
  console.log(`  ✓ Tokens Needed by LLM: ~${snapshot.tokenEstimate} tokens (vs thousands for raw HTML)`);
  console.log(`  ✓ Found ${snapshot.interactiveCount} Interactive Elements:\n`);
  console.log(snapshot.actionMapText);

  // Step 3: Find inputs automatically using Action IDs or Selectors
  console.log('\n🤖 [Step 3]: AI Agent Auto-Locating Credentials Fields...');

  // Auto-detect email input
  const emailAction = snapshot.actions.find(a => 
    a.tag === 'input' && (a.type === 'email' || a.name?.includes('email') || a.placeholder?.includes('email') || a.selector.includes('user') || a.selector.includes('email'))
  );

  // Auto-detect password input
  const passAction = snapshot.actions.find(a => 
    a.tag === 'input' && a.type === 'password'
  );

  // Auto-detect submit button
  const submitAction = snapshot.actions.find(a => 
    a.tag === 'button' && (a.type === 'submit' || a.text.toLowerCase().includes('sign in') || a.text.toLowerCase().includes('log in') || a.text.toLowerCase().includes('login') || a.text.toLowerCase().includes('submit'))
  ) || snapshot.actions.find(a => a.tag === 'button');

  if (emailAction) {
    console.log(`  ▶ Found Email Input: [${emailAction.actionId}] ${emailAction.selector}`);
    console.log(`  ▶ Typing: "admin@memora.company" into ${emailAction.actionId} ...`);
    page.type(emailAction.actionId, 'admin@memora.company');
  }

  if (passAction) {
    console.log(`  ▶ Found Password Input: [${passAction.actionId}] ${passAction.selector}`);
    console.log(`  ▶ Typing: "SuperSecretKey999!" into ${passAction.actionId} ...`);
    page.type(passAction.actionId, 'SuperSecretKey999!');
  }

  // Step 4: Verify field values before submission
  console.log('\n📋 [Step 4]: Verifying In-Memory Form State:');
  const emailVal = page.querySelector(emailAction ? emailAction.selector : 'input[type="email"]')?.value;
  const passVal = page.querySelector(passAction ? passAction.selector : 'input[type="password"]')?.value;
  console.log(`  → Email Field Value:    "${emailVal}"`);
  console.log(`  → Password Field Value: "••••••••••••••••" (Length: ${passVal?.length})`);

  // Step 5: Submit the form
  if (submitAction) {
    console.log(`\n🚀 [Step 5]: Clicking Submit Action [${submitAction.actionId}] ("${submitAction.text}")...`);
    const clicked = page.click(submitAction.actionId);
    console.log(`  ✓ Click Event Dispatched: ${clicked}`);
  }

  // Step 6: Check post-action DOM state
  console.log('\n🔍 [Step 6]: Inspecting Resulting State After Action:');
  const alertText = page.querySelector('#login-alert')?.textContent;
  if (alertText) {
    console.log(`  🎉 Form Response: "${alertText}"`);
  } else {
    console.log(`  ✓ Action completed on page: ${page.url}`);
  }

  browser.close();
  console.log('\n================================================================');
  console.log('✅ LOGIN TEST COMPLETED SUCCESSFULLY IN MEMORA ENGINE!');
  console.log('================================================================\n');
}

testLoginPage().catch(console.error);

