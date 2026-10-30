/**
 * Memora Browser — Autonomous AI Agent Loop Example
 * 
 * Demonstrates:
 * 1. Ultra-fast page loading & DOM parsing.
 * 2. Instant Semantic Action Map & Markdown extraction (95% token reduction vs raw HTML).
 * 3. High-level agent actions using '@1', '@2' action IDs.
 * 4. Speculative branching via page.fork() for testing multiple paths.
 */

import { MemoraBrowser } from '../src/index.js';

async function runAgentLoop() {
  console.log('🚀 Initializing Memora Browser Engine...\n');
  const browser = new MemoraBrowser({ stealth: true });
  const page = browser.newPage();

  // 1. Load a realistic SaaS application login & onboarding form
  const sampleHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Memora Cloud — Workspace Login</title>
      <style>body { font-family: sans-serif; }</style>
    </head>
    <body>
      <header>
        <nav>
          <a href="/features">Features</a>
          <a href="/pricing">Pricing</a>
          <a href="/docs">Documentation</a>
        </nav>
      </header>
      <main>
        <h1>Welcome back to Memora</h1>
        <p>Access your autonomous AI agents, neural workflows, and code lineage.</p>

        <form id="auth-form" action="/api/login" method="POST">
          <div>
            <label for="email">Work Email</label>
            <input id="email" name="email" type="email" placeholder="you@company.com" required />
          </div>
          <div>
            <label for="password">Password</label>
            <input id="password" name="password" type="password" placeholder="••••••••" required />
          </div>
          <div>
            <label>
              <input id="remember" type="checkbox" name="remember_me" checked />
              Remember this device for 30 days
            </label>
          </div>
          <div>
            <button id="btn-submit" type="submit">Sign In to Dashboard</button>
            <a class="forgot-pwd" href="/forgot-password">Forgot password?</a>
          </div>
        </form>

        <section class="quick-links">
          <h2>Enterprise SSO</h2>
          <button id="btn-google" role="button">Continue with Google Workspace</button>
          <button id="btn-github" role="button">Continue with GitHub Enterprise</button>
        </section>
      </main>
    </body>
    </html>
  `;

  page.setContent(sampleHtml, 'https://app.memora.company/login');

  // 2. Extract Semantic Action Map for the AI Agent
  console.log('🧠 Extracting Semantic Action Map for LLM prompt...');
  const snapshot = page.getSemanticSnapshot();

  console.log(`\n📌 Page Title: ${snapshot.title}`);
  console.log(`🎯 Found ${snapshot.interactiveCount} interactive elements.`);
  console.log(`💡 Raw HTML size: ${sampleHtml.length} chars (~${Math.ceil(sampleHtml.length / 4)} tokens)`);
  console.log(`⚡ Distilled LLM Payload: ${snapshot.actionMapText.length + snapshot.markdown.length} chars (~${snapshot.tokenEstimate} tokens)`);
  const savings = ((1 - snapshot.tokenEstimate / (sampleHtml.length / 4)) * 100).toFixed(1);
  console.log(`🔥 Token Reduction: ${savings}% SAVINGS!\n`);

  console.log(snapshot.actionMapText);
  console.log('\n--- Distilled Page Content ---');
  console.log(snapshot.markdown);

  // 3. Autonomous Agent Execution (No fragile CSS/XPath selectors needed!)
  console.log('\n🤖 Agent Action 1: Typing work email into [@4] (input:email)...');
  page.type('@4', 'founder@startup.io');

  console.log('🤖 Agent Action 2: Typing password into [@5] (input:password)...');
  page.type('@5', 'SuperSecretPass123!');

  // 4. Speculative Branching (Fork-on-action)
  console.log('\n🔀 Demonstrating Speculative Branching: Forking page state...');
  const forkBranch = page.fork();
  console.log(`   Fork created with URL: ${forkBranch.url}`);
  console.log(`   Parent Email Value: ${page.querySelector('#email')?.value}`);
  console.log(`   Forked Email Value: ${forkBranch.querySelector('#email')?.value}`);

  // Modify fork without affecting parent
  forkBranch.type('@4', 'altered_email@fork.io');
  console.log(`   After Fork mutation:`);
  console.log(`   → Parent Page Email: ${page.querySelector('#email')?.value}`);
  console.log(`   → Forked Branch Email: ${forkBranch.querySelector('#email')?.value}`);

  // 5. Submit form on main page
  console.log('\n🤖 Agent Action 3: Clicking [@7] ("Sign In to Dashboard")...');
  const clicked = page.click('@7');
  console.log(`   Click executed successfully: ${clicked}`);

  browser.close();
  console.log('\n✅ Agent Workflow Complete!');
}

runAgentLoop().catch(console.error);

