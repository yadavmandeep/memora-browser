# 🚀 Memora Browser — End-User Installation & Setup Guide
> **The Agent-Native, Zero-Graphics Headless Browser Engine for AI Agents & LLMs**  
> *< 15ms Startup | 8.5x Less RAM than Chromium | Up to 95% LLM Token Savings*

---

## ⚡ 30-Second Stack Selector

Choose how you want to use Memora:

| If you are using... | Jump to Section | Setup Method |
| :--- | :--- | :--- |
| **Cursor, Claude Desktop, Antigravity** | [1. AI Coding Assistants (MCP)](#1-ai-coding-assistants-mcp-setup) | No install needed (`npx`) |
| **Python Agents (Browser-Use, LangChain, CrewAI)** | [2. Python AI Developers](#2-python-ai-developers-pip) | `pip install memora-browser` |
| **TypeScript / Node.js Agents** | [3. TypeScript / Node.js Developers](#3-typescript--nodejs-developers) | `npm install memora-browser` |
| **Playwright / Puppeteer** | [4. Playwright & Puppeteer Users](#4-playwright--puppeteer-drop-in) | Drop-in CDP (`ws://...`) |
| **Selenium / W3C WebDriver** | [5. Selenium (W3C WebDriver)](#5-selenium-w3c-webdriver-classic) | No chromedriver needed |
| **Docker / Cloud / Kubernetes** | [6. Docker & Cloud Deployment](#6-docker--cloud-deployments) | Official Docker image |

---

## 1. AI Coding Assistants (MCP Setup)

Memora acts as an ultra-fast **Model Context Protocol (MCP)** server. Your AI assistant gains real-time web browsing with 95% token compression (returns clean Markdown + indexed action maps `[@1]`, `[@2]` instead of 50,000 tokens of raw HTML).

### A. Claude Desktop
1. Open your Claude Desktop configuration file:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`

2. Add `memora-browser` to `mcpServers`:
   ```json
   {
     "mcpServers": {
       "memora-browser": {
         "command": "npx",
         "args": ["-y", "memora-browser", "--mcp"]
       }
     }
   }
   ```
3. Restart Claude Desktop. You will see the hammer icon 🔨 with tools like `memora_browse`, `memora_act`, `memora_diff`, and `memora_fill_form`.

### B. Cursor IDE
1. Open Cursor Settings (`Ctrl + ,` or `Cmd + ,`).
2. Navigate to **Features** ➔ **MCP Servers** ➔ Click **Add New MCP Server**.
3. Fill in:
   - **Name:** `memora-browser`
   - **Type:** `command`
   - **Command:** `npx -y memora-browser --mcp`
4. Click **Save**. Cursor Composer / Chat will now browse docs and live websites at 10x lower token cost.

### C. Google Antigravity / Windsurf
Add to your project's `.mcp.json` or global config:
```json
{
  "mcpServers": {
    "memora-browser": {
      "command": "npx",
      "args": ["-y", "memora-browser", "--mcp"]
    }
  }
}
```

---

## 2. Python AI Developers (`pip`)

Ideal for **Browser-Use**, **LangChain**, **CrewAI**, **AutoGen**, and custom Python LLM scrapers.

### Step 1: Start the Memora Browser Daemon
In your terminal (or run as background service):
```bash
npx memora-browser --port 9222 --stealth
```

### Step 2: Install Python SDK
```bash
pip install memora-browser
```

### Step 3: Quick Start Script
```python
from memora import MemoraAgent

# 1-line connection to Memora daemon
agent = MemoraAgent.connect("http://127.0.0.1:9222")

# Navigate to target page (returns distilled token-efficient snapshot)
snap = agent.goto("https://news.ycombinator.com")
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

# Browser-Use automatically connects over Memora's ultra-lightweight CDP
agent = Agent(
    task="Search Hacker News for latest LLM agent announcements",
    llm=ChatOpenAI(model="gpt-4o"),
    browser_context_kwargs=memora.to_browser_use()
)
```

---

## 3. TypeScript / Node.js Developers

### Step 1: Install Package
```bash
npm install memora-browser
```

### Step 2: High-Level 1-Line Agent Controller
```typescript
import { MemoraAgent } from 'memora-browser';

// 1-line launcher with anti-detect stealth and built-in CDP server
const agent = await MemoraAgent.launch({ stealth: true, cdpPort: 9222 });

// Navigate & get compact LLM representation (<1000 tokens)
const snapshot = await agent.goto('https://app.example.com/login');
console.log(snapshot.actionMapText);

// Autonomous self-healing form fill
await agent.fillForm({
  '@1': 'alex@enterprise.com',
  '@2': 'SuperSecretPassword'
}, /* submit: */ true);

// Check what changed in the DOM
const diff = agent.diff();
console.log(diff.summary);

// Save persistent session (cookies, localStorage)
agent.saveSession('./sessions/user-auth.json');

await agent.close();
```

### Integration with Stagehand
```typescript
import { MemoraAgent, getStagehandConfig } from 'memora-browser';
import { Stagehand } from '@browserbasehq/stagehand';

const agent = await MemoraAgent.launch({ cdpPort: 9222 });
const stagehand = new Stagehand(getStagehandConfig(agent));
await stagehand.init();

await stagehand.page.goto('https://example.com');
```

### Integration with LangChain
```typescript
import { MemoraAgent, createMemoraLangChainTools } from 'memora-browser';

const agent = await MemoraAgent.launch();
const tools = createMemoraLangChainTools(agent);
// Exported tools: memora_navigate, memora_snapshot, memora_act, memora_diff, memora_fill_form
```

---

## 4. Playwright & Puppeteer (Drop-in)

Memora Browser speaks the raw Chrome DevTools Protocol (CDP). Existing Playwright and Puppeteer suites run with **zero code changes**:

### Step 1: Start Memora CDP Server
```bash
npx memora-browser --port 9222 --stealth
```

### Step 2: Connect Playwright
```typescript
import { chromium } from 'playwright';

// Connect directly to Memora's CDP socket
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.newPage();

await page.goto('https://example.com');
console.log('Title:', await page.title());

await browser.close();
```

---

## 5. Selenium (W3C WebDriver Classic)

Memora speaks W3C WebDriver natively, meaning **no chromedriver binary is required**:

### Step 1: Launch WebDriver Server
```bash
npx memora-browser serve --protocol webdriver --port 9222
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

## 6. Docker & Cloud Deployments

For containerized cloud deployments (AWS ECS, GCP Cloud Run, Kubernetes, Railway, Render):

### Run Pre-Built Container
```bash
docker run -d -p 9222:9222 ghcr.io/yadavmandeep/memora-browser:latest
```

### Docker Compose (`docker-compose.yml`)
```yaml
version: '3.8'

services:
  memora:
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

All commands (`npx memora-browser`, `fetch`, `serve`) support HTTP, HTTPS, and SOCKS5 proxies:

```bash
# HTTP proxy with basic authentication
npx memora-browser --http-proxy 'http://user:pass@proxy.example.com:3128'

# SOCKS5 proxy with bypass list for internal corporate domains
npx memora-browser --http-proxy 'socks5://127.0.0.1:1080' --proxy-bypass 'localhost,.internal.corp'

# Respect environment variables (HTTP_PROXY / HTTPS_PROXY / NO_PROXY)
npx memora-browser --use-env-proxy

# Comply with RFC 9309 robots.txt rules automatically
npx memora-browser --obey-robots
```

---

## 🛠️ CLI One-Shot Utilities

Inspect any website and distill it directly from your terminal:

```bash
# Evaluate and output distilled semantic action map
npx memora-browser --eval https://news.ycombinator.com

# Fetch as clean Markdown
npx memora-browser fetch https://example.com --dump markdown

# Fetch structured JSON-LD and microdata metadata
npx memora-browser fetch https://example.com --dump structured_data
```

---

## ❓ Troubleshooting & FAQs

### Q: Does Memora require Chrome to be installed?
**A:** No! By default, Memora runs on its pure TypeScript Native Engine with an in-memory V8 sandbox (<15ms startup, zero GPU). If a site requires heavy GPU WebGL or Chrome-specific extensions, simply pass `--engine chrome` to use system Chromium.

### Q: Why do I see `@1`, `@2` instead of CSS selectors?
**A:** Memora generates indexed semantic action maps. Instead of sending brittle 50-character CSS or XPath strings to LLMs (which cost tokens and fail often), agents can reliably target `@1`, `@2` directly.

### Q: How do I test that my installation works?
Run the built-in benchmark fixture:
```bash
npx memora-browser --eval https://example.com
```
If you see the distilled Markdown and Action Map output in < 20ms, your installation is 100% verified!

---

*Need help or feature requests? Open an issue on [GitHub](https://github.com/yadavmandeep/memora-browser).*
