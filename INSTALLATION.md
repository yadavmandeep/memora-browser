# 🪐 ORBIS BY MEMORA — End-User Installation & Setup Guide
### *The Web, Working for You. Built for Autonomous Intelligence.*
> 🌐 **Product Portal:** [orbis.memora.company](https://orbis.memora.company) • **Company:** [memora.company](https://memora.company)  
> ⚡ **Core Engine:** Memora Browser Engine (MBE) (`memora-orbis`)  
> *< 15ms Startup | 8.5x Less RAM than Chromium | Up to 95% LLM Token Savings*

---

## 📦 Distribution Architecture (Closed-Source & Pre-Compiled)

Orbis by Memora is distributed through npm as a **pre-compiled, fully bundled, and minified production release (`memora-orbis`)**:
- 🛡️ **Intellectual Property Protection:** Raw TypeScript sources (`src/`), internal test suites (`tests/`), and sourcemap debug traces are completely stripped from distribution tarballs.
- ⚡ **Zero Compilation Overhead:** End users and CI/CD pipelines never require `tsc`, build toolchains, or local C++ compilers.
- 🚀 **Universal CLI Commands:** Installing `memora-orbis` registers three aliased commands: `orbis`, `memora-orbis`, and `memora-browser`.

---

## ⚡ 30-Second Stack Selector

Choose how you want to use Orbis:

| If you are using... | Jump to Section | Setup Method |
| :--- | :--- | :--- |
| **Cursor, Claude Desktop, Antigravity** | [1. AI Coding Assistants (MCP)](#1-ai-coding-assistants-mcp-setup) | No install needed (`npx`) |
| **Global Terminal CLI** | [2. Global CLI Installation](#2-global-cli-installation) | `npm install -g memora-orbis` |
| **TypeScript / Node.js Agents** | [3. TypeScript / Node.js Developers](#3-typescript--nodejs-developers) | `npm install memora-orbis` |
| **Python Agents (Browser-Use, LangChain, CrewAI)** | [4. Python AI Developers](#4-python-ai-developers-pip) | `pip install memora-browser` |
| **Playwright / Puppeteer** | [5. Playwright & Puppeteer Users](#5-playwright--puppeteer-drop-in) | Drop-in CDP (`ws://...`) |
| **Selenium / W3C WebDriver** | [6. Selenium (W3C WebDriver)](#6-selenium-w3c-webdriver-classic) | No chromedriver needed |
| **Docker / Cloud / Kubernetes** | [7. Docker & Cloud Deployment](#7-docker--cloud-deployments) | Pre-built Docker container |

---

## 1. AI Coding Assistants (MCP Setup)

Orbis acts as a high-speed **Model Context Protocol (MCP)** server over stdio. Your AI assistant gains real-time web browsing with 95% token compression (returns clean Markdown + indexed action maps `[@1]`, `[@2]` instead of 50,000 tokens of raw HTML).

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
3. Restart Claude Desktop. The hammer icon 🔨 will expose Orbis tools: `orbis_browse`, `orbis_act`, `orbis_diff`, `orbis_fill_form`, and `orbis_session`.

### B. Cursor IDE
1. Open Cursor Settings (`Ctrl + ,` or `Cmd + ,`).
2. Navigate to **Features** ➔ **MCP Servers** ➔ Click **Add New MCP Server**.
3. Fill in:
   - **Name:** `orbis`
   - **Type:** `command`
   - **Command:** `npx -y memora-orbis --mcp`
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

## 2. Global CLI Installation

To run Orbis commands from any terminal without re-downloading via `npx`:

```bash
npm install -g memora-orbis
```

Once installed globally, you have instant access to:
```bash
# Verify installation
orbis --version

# Run instant semantic page distillation
orbis --eval https://example.com

# Start daemon server with anti-detect stealth
orbis --port 9222 --stealth
```
*(Aliases: `orbis`, `memora-orbis`, and `memora-browser` all point to the same compiled binary).*

---

## 3. TypeScript / Node.js Developers

### Step 1: Install Package
```bash
npm install memora-orbis
```

### Step 2: 1-Line Autonomous Agent Loop (`OrbisAgent`)
```typescript
import { OrbisAgent } from 'memora-orbis';

// Launch standalone browser daemon with stealth and CDP on port 9222
const agent = await OrbisAgent.launch({ stealth: true, cdpPort: 9222 });

// Navigate & get compact LLM representation (<1000 tokens)
const snapshot = await agent.goto('https://example.com');
console.log(snapshot.actionMapText);

// Autonomous self-healing form fill
await agent.fillForm({
  '@1': 'user@example.com',
  '@2': 'Password123!'
}, /* submit: */ true);

// Check what changed in the DOM
const diff = agent.diff();
console.log(diff.summary);

// Save persistent session vault (cookies, storage)
agent.saveSession('./sessions/auth-state.json');

await agent.close();
```

### Integration with Stagehand
```typescript
import { OrbisAgent, getStagehandConfig } from 'memora-orbis';
import { Stagehand } from '@browserbasehq/stagehand';

const agent = await OrbisAgent.launch({ cdpPort: 9222 });
const stagehand = new Stagehand(getStagehandConfig(agent));
await stagehand.init();

await stagehand.page.goto('https://example.com');
```

### Integration with LangChain
```typescript
import { OrbisAgent, createOrbisLangChainTools } from 'memora-orbis';

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
npx memora-orbis --port 9222 --stealth
```

### Step 2: Install Python SDK
```bash
pip install memora-browser
```

### Step 3: Quick Start Script
```python
from memora import MemoraAgent

# 1-line connection to Orbis daemon
agent = MemoraAgent.connect("http://127.0.0.1:9222")

# Navigate to target page (returns distilled token-efficient snapshot)
snap = agent.goto("https://example.com")
print(f"Title: {snap.title} | Tokens: ~{snap.token_estimate}")
print(snap.action_map_text)

# Interact directly via @actionId
agent.act("@1")

# Check state changes between turns
diff = agent.diff()
print(diff["diff"]["summary"])

# Fill out forms in 1 turn
agent.fill_form({"#username": "agent_007", "#password": "secret"}, submit=True)
```

### Integration with Browser-Use (Python)
```python
from memora import MemoraAgent
from browser_use import Agent
from langchain_openai import ChatOpenAI

memora = MemoraAgent.connect("http://127.0.0.1:9222")

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
npx memora-orbis --port 9222 --stealth
```

### Step 2: Connect Playwright
```typescript
import { chromium } from 'playwright';

// Connect directly to Orbis CDP socket
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
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
npx memora-orbis serve --protocol webdriver --port 9222
```

### Step 2: Connect Selenium (Python)
```python
from selenium import webdriver

options = webdriver.ChromeOptions()
driver = webdriver.Remote(
    command_executor="http://127.0.0.1:9222",
    options=options
)

driver.get("https://example.com")
print(driver.title)
driver.quit()
```

---

## 7. Docker & Cloud Deployments

For containerized cloud deployments (AWS ECS, GCP Cloud Run, Kubernetes, Railway, Render):

### Run Pre-Built Container
```bash
docker run -d -p 9222:9222 ghcr.io/yadavmandeep/memora-browser:latest
```

### Docker Compose (`docker-compose.yml`)
```yaml
version: '3.8'

services:
  orbis:
    image: ghcr.io/yadavmandeep/memora-browser:latest
    ports:
      - "9222:9222"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:9222/json/version"]
      interval: 15s
      timeout: 3s
      retries: 3
```

---

## 🌐 Enterprise Proxy Configuration

All commands (`npx orbis`, `npx memora-orbis`, `fetch`, `serve`) support HTTP, HTTPS, and SOCKS5 proxies:

```bash
# HTTP proxy with basic authentication
npx orbis --http-proxy 'http://user:pass@proxy.example.com:3128'

# SOCKS5 proxy with bypass list for internal corporate domains
npx orbis --http-proxy 'socks5://127.0.0.1:1080' --proxy-bypass 'localhost,.internal.corp'

# Respect environment variables (HTTP_PROXY / HTTPS_PROXY / NO_PROXY)
npx orbis --use-env-proxy

# Comply with RFC 9309 robots.txt rules automatically
npx orbis --obey-robots
```

---

## 🛠️ CLI One-Shot Utilities

Inspect any website and distill it directly from your terminal:

```bash
# Evaluate and output distilled semantic action map
npx orbis --eval https://example.com

# Fetch as clean Markdown
npx orbis fetch https://example.com --dump markdown

# Fetch structured JSON-LD and microdata metadata
npx orbis fetch https://example.com --dump structured_data
```

---

## ❓ Troubleshooting & FAQs

### Q: Does Orbis require Chrome to be installed?
**A:** No! By default, Orbis runs on its pure TypeScript Native Engine with an in-memory V8 sandbox (<15ms startup, zero GPU). If a site requires heavy GPU WebGL or Chrome-specific extensions, simply pass `--engine chrome` to use system Chromium.

### Q: Why do I see `@1`, `@2` instead of CSS selectors?
**A:** Orbis generates indexed semantic action maps. Instead of sending brittle 50-character CSS or XPath strings to LLMs (which cost tokens and fail often), agents can reliably target `@1`, `@2` directly.

### Q: Is source code or build tools needed to install Orbis?
**A:** No. Orbis is pre-compiled and distributed in minified binary JavaScript form via npm (`memora-orbis`). No local build steps or compiler tools are required.

### Q: How do I test that my installation works?
Run the built-in eval command:
```bash
npx orbis --eval https://example.com
```
If you see the distilled Markdown and Action Map output in < 20ms, your installation is 100% verified!

---

*Need help or feature requests? Open an issue on [GitHub](https://github.com/yadavmandeep/memora-browser).*
