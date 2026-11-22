# Orbis Developer Handbook: Local AI Agent Workflows

> **Version:** v0.3.0  
> **Target Audience:** Developers running AI agents on their local machines (macOS, Windows, Linux) without requiring external cloud browser infrastructure.

---

## 1. Local-First Philosophy

When building autonomous agents or web automation pipelines, cloud browser SaaS platforms often introduce:
- Latency overhead (200ms–800ms round trips per click/keystroke)
- Heavy subscription costs for VM compute
- Security risks from transmitting user credentials or session tokens over public clouds
- Complex configuration and proxy setups

**Orbis v0.3.0 is designed from the core for local desktop execution**:
- It runs directly on your development machine or local container.
- It shares host cookies effortlessly to bypass logins and 2FA.
- It safeguards your private data using client-side PII masking.
- It records session replays to offline HTML files that open instantly in your default browser.
- It optimizes V8 memory usage so multiple tabs consume <100MB of RAM.

---

## 2. Setting Up Your Local Environment

### Quick Install
```bash
# Global CLI install
npm install -g @memoracompany/memora-orbis

# Or run instantly with npx
npx orbis --help
```

### Starting the Local CDP Daemon
Run Orbis in background daemon mode on your preferred port:
```bash
# Standard mode
orbis --port 9222

# Eco mode (Recommended for laptops with limited RAM: caps heap at 256MB, blocks media)
orbis --eco --port 9222
```

---

## 3. Zero-Login Friction with Host Cookie Import

One of the biggest obstacles in local agent development is navigating login screens, 2-Factor Authentication (2FA), and CAPTCHA puzzles.

### Step-by-Step Cookie Import:
1. In your regular daily browser (Chrome, Firefox, Brave), log into the target web application (e.g., GitHub, Jira, AWS Console).
2. Export your cookies to a file using any standard extension (e.g. *Get cookies.txt LOCALLY*) or copy from Chrome DevTools Application tab as JSON.
3. Run the Orbis import command:
   ```bash
   orbis import-cookies ~/Downloads/cookies.txt --url https://github.com --profile github-work
   ```
4. Now your agent can navigate to `https://github.com` and is **already authenticated**, bypassing login forms and bot checks completely!

In your TypeScript code:
```typescript
import { OrbisAgent } from '@memoracompany/memora-orbis';

const agent = await OrbisAgent.launch();
// Instantly load the authenticated session
await agent.loadVaultProfile('github-work');

// Directly access protected dashboard
await agent.goto('https://github.com/settings/tokens');
```

---

## 4. Cursor, Claude Desktop & Windsurf MCP Setup

Integrate Orbis directly into your favorite AI code editor as an MCP tool.

### Adding to `claude_desktop_config.json` or `cursor_mcp.json`:
```json
{
  "mcpServers": {
    "orbis": {
      "command": "npx",
      "args": ["-y", "@memoracompany/memora-orbis", "--mcp", "--engine", "auto"]
    }
  }
}
```

### Example Prompts for Cursor / Claude:
- *"Browse https://news.ycombinator.com using Orbis, wait for hydration, and extract the top 5 stories."*
- *"Open GitHub, use my 'github-work' vault profile, and check my recent pull requests."*
- *"Take a screenshot with bounding boxes on the dashboard to see what visual action badges are available."*

---

## 5. Debugging with Agent Flight Recorder

When your agent takes an unexpected path or fails an assertion, do not guess what happened.

1. Launch your agent with `--record` (or `record: true` in code):
   ```bash
   orbis --record --port 9222
   ```
2. After the session finishes, open the interactive trace player:
   ```bash
   orbis replay
   ```
3. A rich interactive HTML dashboard opens in your browser showing:
   - Every step, action ID, and selector used
   - Exact DOM snapshot that the LLM saw
   - Visual changes (DOM diffs)
   - Console logs and warnings

---

## 6. Self-Healing in Production Scripts

Selectors change unexpectedly when web apps deploy updates. Orbis handles this gracefully with autonomous self-healing:

```typescript
// If #old-checkout-btn was renamed to #submit-order-v3, Orbis will:
// 1. Attempt the primary selector for 2.5s
// 2. Fall back to matching button text "Checkout" or "Place Order"
// 3. Fall back to aria-label and role="button"
// 4. Click the target successfully without throwing an unhandled exception!
await agent.act('#old-checkout-btn');
```

You can inspect all self-healing events in your session logs or trace viewer.

---

## 7. Multi-Tab Reasoning with Blackboard

When an agent needs to perform multi-step workflows across tabs:

```typescript
const agent = await OrbisAgent.launch();

// Tab 1: Find product price
await agent.goto('https://store.example.com/item/42');
agent.blackboard.recordFact('Item price is $129.99', 'pricing');
agent.blackboard.setVar('item_id', '42');

// Tab 2: Compare with competitor
const tab2 = await agent.newPage();
await tab2.goto('https://competitor.example.com/search?q=item42');
agent.blackboard.recordFact('Competitor price is $149.00', 'pricing');

// Get compact Markdown summary of all tabs and facts:
const contextForLLM = agent.blackboard.generateSummary();
console.log(contextForLLM);
/*
### Active Browser Blackboard
- Open Tabs: 2
- Facts:
  - [pricing] Item price is $129.99
  - [pricing] Competitor price is $149.00
*/
```
