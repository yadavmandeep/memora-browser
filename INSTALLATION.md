# <img src="https://orbis.memora.company/orbis-logo.svg" alt="Orbis Logo" width="36" height="36" align="center" /> Orbis by Memora — Installation & Setup Guide
### *The Web, Working for You. Built for Autonomous Intelligence.*
> **Product Portal:** [orbis.memora.company](https://orbis.memora.company) • **Company:** [memora.company](https://memora.company)  
> **Core Engine:** Memora Browser Engine (MBE) (`memora-orbis`)  
> *In our tests: 11x faster and 11x less memory than headless Chrome, 33–40% fewer tokens than raw HTML*

---

## Distribution Architecture (Closed-Source & Pre-Compiled)

Orbis by Memora is distributed through npm as a **pre-compiled, fully bundled, and minified production release (`memora-orbis`)**:
- **Intellectual Property Protection:** Raw TypeScript sources (`src/`), internal test suites (`tests/`), and sourcemap debug traces are completely stripped from distribution tarballs.
- **Zero Compilation Overhead:** End users and CI/CD pipelines never require `tsc`, build toolchains, or local C++ compilers.
- **Universal CLI Commands:** Installing `memora-orbis` registers three aliased commands: `orbis`, `memora-orbis`, and `memora-browser`.

---

## 30-Second Stack Selector

Choose how you want to use Orbis:

| If you are using... | Jump to Section | Setup Method |
| :--- | :--- | :--- |
| **Cursor, Claude Desktop, Antigravity** | [1. AI Coding Assistants (MCP)](#1-ai-coding-assistants-mcp-setup) | No install needed (`npx`) |
| **Global Terminal CLI** | [2. Global CLI Installation](#2-global-cli-installation) | `npm install -g @memoracompany/memora-orbis` |
| **TypeScript / Node.js Agents** | [3. TypeScript / Node.js Developers](#3-typescript--nodejs-developers) | `npm install @memoracompany/memora-orbis` |
| **Python Agents (Browser-Use, LangChain, CrewAI)** | [4. Python AI Developers](#4-python-ai-developers-pip) | `pip install memora-orbis` |
| **Playwright / Puppeteer** | [5. Playwright & Puppeteer Users](#5-playwright--puppeteer-drop-in) | Drop-in CDP (`ws://...`) |
| **Selenium / W3C WebDriver** | [6. Selenium (W3C WebDriver)](#6-selenium-w3c-webdriver-classic) | No chromedriver needed |

---

## 1. AI Coding Assistants (MCP Setup)

Orbis acts as a high-speed **Model Context Protocol (MCP)** server over stdio. Your AI assistant gains real-time web browsing with compact output (returns clean Markdown + indexed action maps `[@1]`, `[@2]` instead of 50,000 tokens of raw HTML).

### A. Claude Desktop
1. Open your Claude Desktop configuration file:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`

2. Add `orbis` to `mcpServers`:
   ```json
   {
     "mcpServers": {
       "orbis": {
         "command": "npx",
         "args": ["-y", "memora-orbis", "--mcp"]
       }
     }
   }
   ```
3. Restart Claude Desktop. The tools (hammer) icon will list Orbis tools: `orbis_browse`, `orbis_act`, `orbis_diff`, `orbis_fill_form`, and `orbis_session`.

### B. Cursor IDE
1. Open Cursor Settings (`Ctrl + ,` or `Cmd + ,`).
2. Navigate to **Features** **MCP Servers** Click **Add New MCP Server**.
3. Fill in:
   - **Name:** `orbis`
   - **Type:** `command`
   - **Command:** `npx -y @memoracompany/memora-orbis --mcp`
4. Click **Save**. Composer and Chat can now browse documentation, search live sites, and interact with web applications at 10x lower token cost.

### C. Google Antigravity / Windsurf
Add to your project's `.mcp.json` or global config:
```json
{
  "mcpServers": {
    "orbis": {
      "command": "npx",
      "args": ["-y", "memora-orbis", "--mcp"]
    }
  }
}
```

---

### D. Prompt Injection Firewall (recommended for agents that browse untrusted sites)

Add firewall flags to the `args` of any MCP config above:

```json
"args": ["-y", "memora-orbis", "--mcp", "--firewall", "standard", "--audit-log", "/absolute/path/orbis-audit.jsonl"]
```

- `--firewall standard`: page content is fenced as untrusted data; cookies, storage, JavaScript eval, session files and form submits need your approval; email, banking, identity and cloud-console sites are blocked.
- Approval prompts use MCP elicitation. If your client does not support it, those actions are refused; allow the ones you need up front, e.g. `--firewall-allow submit`.
- `--allow-domain <host>` (repeatable) limits where the agent may navigate. Set `ORBIS_AUDIT_KEY` in the server's `env` to HMAC-sign the audit log.

Full reference: [PROMPT_INJECTION_FIREWALL.md](PROMPT_INJECTION_FIREWALL.md).

---

## 2. Global CLI Installation

To run Orbis commands from any terminal without re-downloading via `npx`:

```bash
npm install -g @memoracompany/memora-orbis
```

Once installed globally, you have instant access to:
```bash
# Verify installation
orbis --version

# Run instant semantic page distillation
orbis --eval https://example.com

# Start daemon server (anti-detect stealth is on by default)
orbis --port 9222
```
*(Aliases: `orbis`, `memora-orbis`, and `memora-browser` all point to the same compiled binary).*

---

## 3. TypeScript / Node.js Developers

### Step 1: Install Package
```bash
npm install @memoracompany/memora-orbis
```

### Step 2: 1-Line Autonomous Agent Loop (`OrbisAgent`)
```typescript
import { OrbisAgent } from '@memoracompany/memora-orbis';

// Launch standalone browser daemon with stealth and CDP on port 9222
const agent = await OrbisAgent.launch({ stealth: true, cdpPort: 9222 });

// Navigate & get compact LLM representation (<1000 tokens)
const snapshot = await agent.goto('https://example.com');
console.log(snapshot.actionMapText);

// Multi-modal form filling (supports @IDs, labels, placeholders, or CSS):
await agent.fillForm({
  'label:Email Address': 'user@example.com',
  'placeholder:Password': 'Password123!',
  '#country': 'United States'
}, /* submit: */ 'text=Sign In');

// Direct interaction with any locator:
await agent.act('@1', 'user@example.com');                  // Ephemeral @ID (AI agents)
await agent.act('label:Email Address', 'user@example.com'); // Playwright label (Tests)
agent.selectOption('#country', 'India');              // Dropdown selection by label/value
await agent.act('text=Sign In');                            // Playwright text

// Check what changed in the DOM
const diff = agent.diff();
console.log(diff.summary);

// Save persistent session vault (cookies, storage)
agent.saveSession('./sessions/auth-state.json');

await agent.close();
```

#### Universal Locators Reference

Orbis provides a modular **Strategy Pattern locator engine** that works across all agent commands:

| Locator Strategy | Syntax Pattern | Code Example | Best For |
| :--- | :--- | :--- | :--- |
| **Action ID (Default)** | `@<number>` | `await agent.act('@4', 'alex@example.com')` | Autonomous AI agents (zero XPath hallucination, minimal tokens) |
| **Semantic Alias** | `@<name>` | `await agent.act('@email', 'alex@example.com')` | AI agent workflows resilient to new DOM insertions |
| **Playwright Label** | `label:<text>` | `await agent.act('label:Email Address', 'alex@...')` | Deterministic test suites (never breaks on layout changes) |
| **Playwright Text** | `text=<text>` | `await agent.act('text=Create Account')` | Buttons, links, and clickable text elements |
| **Playwright Placeholder** | `placeholder:<text>` | `await agent.act('placeholder:Password', '...')` | Modern web forms with placeholder hints |
| **Playwright Role** | `role:<role>[name="..."]` | `await agent.act('role:button[name="Submit"]')` | Accessible ARIA-compliant applications |
| **Test ID** | `testid:<id>` | `await agent.act('testid:submit-btn')` | Cypress, Playwright, and React `data-testid` attributes |
| **Selenium XPath** | `//...` or `xpath:...` | `await agent.act('//button[@type="submit"]')` | Enterprise Selenium test migrations |
| **Standard CSS** | `#id`, `.class`, `[attr]` | `await agent.act('#country-select')` | Standard web automation scripts |
| **Dropdown Selection** | `agent.selectOption(target, val)` | `agent.selectOption('#country', 'India')` | Native `<select>` & dynamic ARIA listboxes |

### Integration with Stagehand
```typescript
import { OrbisAgent, getStagehandConfig } from '@memoracompany/memora-orbis';
import { Stagehand } from '@browserbasehq/stagehand';

const agent = await OrbisAgent.launch({ cdpPort: 9222 });
const stagehand = new Stagehand(getStagehandConfig(agent));
await stagehand.init();

await stagehand.page.goto('https://example.com');
```

### Integration with LangChain
```typescript
import { OrbisAgent, createOrbisLangChainTools } from '@memoracompany/memora-orbis';

const agent = await OrbisAgent.launch();
const tools = createOrbisLangChainTools(agent);
// Exported tools: orbis_navigate, orbis_snapshot, orbis_act, orbis_diff, orbis_fill_form
```

---

## 4. Python AI Developers (`pip`)

Ideal for **Browser-Use**, **LangChain**, **CrewAI**, **AutoGen**, and Python LLM scrapers.

### Step 1: Start the Orbis Daemon
In your terminal (or run as background service):
```bash
npx @memoracompany/memora-orbis --port 9222
```

### Step 2: Install Python SDK
```bash
pip install memora-orbis
```

### Step 3: Quick Start Script
```python
from memora import MemoraAgent

# 1-line connection to Orbis daemon
agent = MemoraAgent.connect("http://localhost:9222")

# Navigate to target page (returns distilled token-efficient snapshot)
snap = agent.goto("https://example.com")
print(f"Title: {snap.title} | Tokens: ~{snap.token_estimate}")
print(snap.action_map_text)

# Interact via @actionId, Playwright label, or text
agent.act("@1")
agent.act("label:Email Address", "agent@memora.company")
agent.act("text=Sign In")

# Check state changes between turns
diff = agent.diff()
print(diff["diff"]["summary"])

# Fill out forms with resilient locators (labels, placeholders, @ids, #ids)
agent.fill_form({
    "label:Email Address": "agent_007@memora.company",
    "placeholder:Password": "secret"
}, submit="text=Sign In")
```

### Integration with Browser-Use (Python)
```python
from memora import MemoraAgent
from browser_use import Agent
from langchain_openai import ChatOpenAI

memora = MemoraAgent.connect("http://localhost:9222")

# Browser-Use automatically connects over Orbis's ultra-lightweight CDP
agent = Agent(
    task="Search news for AI agent announcements",
    llm=ChatOpenAI(model="gpt-4o"),
    browser_context_kwargs=memora.to_browser_use()
)
```

---

## 5. Playwright & Puppeteer (Drop-in)

Orbis speaks the raw Chrome DevTools Protocol (CDP). Existing Playwright and Puppeteer suites run with **zero code changes**:

### Step 1: Start Orbis CDP Server
```bash
npx @memoracompany/memora-orbis --port 9222
```

### Step 2: Connect Playwright
```typescript
import { chromium } from 'playwright';

// Connect directly to Orbis CDP socket
const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = await browser.newPage();

await page.goto('https://example.com');
console.log('Title:', await page.title());

await browser.close();
```

---

## 6. Selenium (W3C WebDriver Classic)

Orbis speaks W3C WebDriver natively, meaning **no chromedriver binary is required**:

### Step 1: Launch WebDriver Server
```bash
npx @memoracompany/memora-orbis serve --protocol webdriver --port 9222
```

### Step 2: Connect Selenium (Python)
```python
from selenium import webdriver

options = webdriver.ChromeOptions()
driver = webdriver.Remote(
    command_executor="http://localhost:9222",
    options=options
)

driver.get("https://example.com")
print(driver.title)
driver.quit()
```

## Troubleshooting & FAQs

### Q: Does Orbis require Chrome to be installed?
**A:** No! By default, Orbis runs on its pure TypeScript Native Engine with an in-memory V8 sandbox (no GPU or system browser needed). If a site requires heavy GPU WebGL or Chrome-specific extensions, simply pass `--engine chrome` to use system Chromium.

### Q: Why do I see `@1`, `@2` instead of CSS selectors?
**A:** Orbis generates indexed semantic action maps. Instead of sending brittle 50-character CSS or XPath strings to LLMs (which cost tokens and fail often), agents can reliably target `@1`, `@2` directly.

### Q: Is source code or build tools needed to install Orbis?
**A:** No. Orbis is pre-compiled and distributed in minified binary JavaScript form via npm (`memora-orbis`). No local build steps or compiler tools are required.

### Q: How do I test that my installation works?
Run the built-in eval command:
```bash
npx orbis --eval https://example.com
```
If you see the page title, the action map and the Markdown, your installation works.

---

---

## About Memora

**[Memora](https://memora.company/)** is an AI organizational memory and knowledge management platform that stops teams from losing what they know.

Memora connects conversations, code, tickets, documents, and meetings across Slack, GitHub, Jira, Notion, Confluence, and Google Drive into a single, verifiable, searchable organizational memory.

- **Company Website:** [https://memora.company](https://memora.company)
- **Product Portal:** [https://orbis.memora.company](https://orbis.memora.company)

*Need help or feature requests? Open an issue on [GitHub](https://github.com/memora-company/memora-orbis).*
