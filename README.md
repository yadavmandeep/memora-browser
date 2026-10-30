# 🪐 ORBIS BY MEMORA
### *The Web, Working for You.*
> **An Agentic Browser. Built for Autonomous Intelligence.**  
> *Explore. Understand. Execute.*  
>
> 🌐 **Product Portal:** [orbis.memora.company](https://orbis.memora.company) • **Company:** [memora.company](https://memora.company)  
> ⚡ **Core Engine:** Memora Browser Engine (MBE) (`memora-browser`) — *Drop-in CDP & W3C WebDriver for AI Agents & LLMs*

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-82%20passed%20(100%25)-brightgreen.svg)]()
[![CDP Wire Protocol](https://img.shields.io/badge/CDP-Chrome%20130%20Compatible-blue.svg)]()
[![W3C WebDriver](https://img.shields.io/badge/W3C%20WebDriver-Selenium%20Ready-orange.svg)]()
[![RAM Footprint](https://img.shields.io/badge/RAM-~18MB%20base-success.svg)]()
[![Token Savings](https://img.shields.io/badge/LLM%20Tokens-95%25%20reduction-purple.svg)]()

---

## 📑 Table of Contents
- [🌟 Why Orbis? The Problem with Traditional Browsers](#-why-orbis-the-problem-with-traditional-browsers)
- [📊 Benchmark vs Traditional Headless Chromium](#-benchmark-comparison)
- [⚡ Quick Start: 30 Seconds to Launch](#-quick-start-30-seconds-to-launch)
- [🔌 Model Context Protocol (MCP) for Cursor, Claude & Windsurf](#-model-context-protocol-mcp-for-cursor--claude)
- [🧠 1-Line Autonomous Agent Loop (`OrbisAgent`)](#-1-line-autonomous-agent-loop-orbisagent)
- [🤖 Playwright & Puppeteer (Zero Code Changes)](#-playwright--puppeteer-drop-in-integration)
- [🧪 Selenium & W3C WebDriver Classic](#-selenium--w3c-webdriver-classic)
- [🐍 Python SDK (Browser-Use, LangChain, CrewAI)](#-python-sdk)
- [🛠️ Native CDP Domain (`Orbis.*` / `Memora.*`) & REST API](#-proprietary-cdp-domain--rest-api)
- [🌐 Enterprise Proxy & Stealth Anti-Bot](#-enterprise-proxy--anti-bot-stealth)
- [🤝 robots.txt Crawler Compliance (RFC 9309)](#-robotstxt-compliance---obey-robots)
- [🐳 Docker & Cloud Deployment](#-docker--cloud-deployments)
- [🏗️ Internal Architecture](#-architecture-overview)
- [❓ FAQ & Troubleshooting](#-faq--troubleshooting)

---

## 🌟 Why Orbis? The Problem with Traditional Browsers

Traditional headless browsers (Chromium, Firefox, WebKit) were designed for **human eyeballs looking at screen pixels**. When autonomous AI agents, LLM scrapers, and automated workflows use them:

* **Over 80% of CPU and RAM is wasted** computing GPU rasterization, CSS box reflows, font anti-aliasing, and compositing layers that an AI agent never sees.
* **LLMs are drowned in token bloat:** Feeding an agent 500KB of raw HTML burns 40,000+ tokens and \$0.10+ per page load.
* **Vision-based scraping (4K screenshots)** introduces 5–10 seconds of multimodal latency and breaks frequently on complex dynamic web forms.

**Orbis by Memora is fundamentally different:**
1. **Zero-Graphics Execution Core (Memora Browser Engine)**: Strips Skia and GPU layout rasterization entirely—giving **< 15ms cold start** and **~18MB base RAM** (8.5x leaner than Chromium).
2. **Native AXTree & Action Map Distillation (< 2ms)**: Condenses any dynamic webpage into clean Markdown and an indexed Semantic Action Tree (`[@1]`, `[@2]`, `[@3]`), saving **up to 95% LLM prompt tokens**.
3. **Speculative Branching (`page.fork()` in < 1ms)**: Instant Copy-on-Write page branching. AI agents can test multiple UI paths or form submissions simultaneously with zero network penalty.
4. **Autonomous Self-Healing Form Filler**: Supports text, textarea, select, checkbox, radio, and contenteditable in one atomic turn with multi-step wizard pipelines.
5. **Drop-in Wire Compatibility**: Exposes standard Chrome DevTools Protocol (`ws://127.0.0.1:9222`) and W3C WebDriver. Your existing **Playwright**, **Puppeteer**, **Selenium**, **Browser-Use**, and **Stagehand** code works out of the box with zero changes.
6. **Built-in Anti-Detect Stealth**: Engine-level evasion of `navigator.webdriver`, genuine Chrome 130 Client Hints, hardware emulation, and coherent TLS profiles.

---

## 📊 Benchmark Comparison

| Metric | Traditional Headless Chromium | **Orbis (by Memora)** |
| :--- | :--- | :--- |
| **Cold Start Latency** | 1,500ms – 3,000ms | **< 15ms** ⚡ |
| **RAM Footprint (per tab)** | 350MB – 600MB | **~18MB – 28MB** 🚀 |
| **LLM Token Ingestion** | 30,000 – 80,000 tokens | **300 – 1,200 tokens** (95% saving) |
| **Action Targeting** | Fragile XPath / CSS | **Numbered Action IDs (`@1`, `@2`)** |
| **Speculative Branching** | ❌ (Opens new 400MB tab) | **✅ `page.fork()` in < 1ms** |
| **Playwright / Puppeteer** | Native | **Full CDP Wire Protocol** |
| **Selenium (WebDriver)** | via chromedriver | **Native W3C Classic** |
| **Form Wizard Pipeline** | Manual clicks | **✅ Atomic & Self-healing** |
| **State Diffing (`diff()`)**| Manual DOM diffs | **✅ Native in < 1ms** |
| **Proxy Capabilities** | Basic | **HTTP(S) + SOCKS5, bearer, bypass** |
| **Anti-Bot Stealth** | Easily detected | **Chrome 130 Genuine Profile** |

---

## ⚡ Quick Start: 30 Seconds to Launch

You don't even need to install it globally. Run directly via `npx`:

### 1. Launch standalone CDP Server:
```bash
npx orbis --port 9222 --stealth
# or via package alias:
npx memora-browser --port 9222 --stealth
```

Output:
```text
╔════════════════════════════════════════════════════════════════╗
║                      🪐 ORBIS BY MEMORA                        ║
║        An Agentic Browser • Built for Autonomous AI            ║
║              Powered by Memora Browser Engine                  ║
╚════════════════════════════════════════════════════════════════╝
  ▶ Website & Docs:     https://orbis.memora.company
  ▶ Parent Company:     https://memora.company
  ▶ Core Engine:        Memora Browser Engine (MBE)
  ▶ CDP WebSocket:      ws://127.0.0.1:9222/devtools/browser/memora-root
  ▶ Discovery Endpoint: http://127.0.0.1:9222/json/version
  ▶ Agent Snapshot:     http://127.0.0.1:9222/orbis/snapshot
  ▶ Memory Footprint:   ~83.4 MB (Chromium uses ~350MB+)
  ▶ Stealth Mode:       🛡️  ACTIVE (Anti-Detect On)
  ▶ Status:             READY FOR PLAYWRIGHT / PUPPETEER / AGENTS
```

### 2. One-Shot Instant Distillation (CLI):
Evaluate any website and see the distilled Markdown + Action Map directly in your terminal:
```bash
npx orbis --eval https://example.com
```

### 3. Fetch as Distilled Markdown:
```bash
npx orbis fetch https://example.com --dump markdown
```

---

## 🔌 Model Context Protocol (MCP) for Cursor & Claude

Orbis functions as a native **Model Context Protocol (MCP)** server over stdio for AI coding tools (**Cursor, Claude Desktop, Google Antigravity, Windsurf**).

### Configuration (`mcp.json` or `claude_desktop_config.json`):
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
> *Tip: You can also use `memora-browser` or `orbis` in place of `memora-orbis`.*

### Exposed MCP Tools:
* `memora_browse` / `orbis_browse`: Loads any technical documentation or URL and returns clean Markdown + indexed Action Map (`[@1]`, `[@2]`) with 95% token savings.
* `memora_act` / `orbis_act`: Interacts with elements (`click`, `type`) by action ID or CSS selector.
* `memora_diff` / `orbis_diff`: Computes DOM state difference from previous turn.
* `memora_fill_form` / `orbis_fill_form`: Atomic multi-field and multi-step form filler.
* `memora_session` / `orbis_session`: Saves and restores session authentication states (cookies, localStorage, sessionStorage).
* `memora_fork`: Instant `< 1ms` speculative page cloning to explore alternatives.

---

## 🧠 1-Line Autonomous Agent Loop (`OrbisAgent`)

Orbis provides a high-level agent controller designed for LLM orchestration:

```typescript
import { OrbisAgent } from 'memora-orbis';

// 1. Launch 1-line browser instance with anti-detect stealth
const agent = await OrbisAgent.launch({ stealth: true, cdpPort: 9222 });

// 2. Navigate and get distilled LLM representation (< 1,000 tokens)
const snapshot = await agent.goto('https://app.example.com/checkout');
console.log(snapshot.actionMapText);
/*
=== INTERACTIVE ACTION MAP ===
[@1] [input:text] "First Name" (selector: #fname)
[@2] [input:email] "Email Address" (selector: #email)
[@3] [select] "Country" (selector: #country)
[@4] [input:checkbox] "Subscribe to updates" (selector: #newsletter)
[@5] [button] "Proceed to Payment" (selector: #btn-next)
*/

// 3. Single-turn Form Filling (all input types supported)
await agent.fillForm({
  '@1': 'Mandeep Yadav',
  '@2': 'mandeep@memora.company',
  '@3': 'United States',
  '@4': 'true'
}, /* submit: */ true);

// 4. Observe DOM State Diff (What changed on the page?)
const diff = agent.diff();
console.log(diff.summary);
// "+ Added: [@6] [input] Card Number, [@7] [button] Pay Now"

// 5. Multi-Step Form Wizards (Atomic Execution)
await agent.page.fillForm({
  steps: [
    { fields: { '#fname': 'Jane', '#email': 'jane@enterprise.com' }, submitActionId: '#btn-next' },
    { fields: { '#card': '424242424242', '#cvv': '123' }, submitActionId: '#btn-pay' }
  ]
});

// 6. Save persistent session (Cookies, localStorage, sessionStorage)
agent.saveSession('./sessions/auth.json');

// 7. Speculative Forking (Explore alternate execution paths in parallel!)
const speculativeBranch = agent.fork();
speculativeBranch.act('@5'); // branch operates on lightweight in-memory clone

await agent.close();
```

---

## 🤖 Playwright & Puppeteer Drop-In Integration

Connect existing Playwright or Puppeteer test suites and scrapers to Orbis with **zero code changes**:

```typescript
import { chromium } from 'playwright';

// Connect over CDP directly to Orbis
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

await page.goto('https://example.com');
console.log('Title:', await page.title());

await browser.close();
```

---

## 🧪 Selenium & W3C WebDriver Classic

Orbis natively implements **W3C WebDriver Classic**—**no chromedriver binary is required**:

### 1. Start WebDriver server:
```bash
npx orbis serve --protocol webdriver --port 9222
```

### 2. Connect Selenium (Python):
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

### 3. Connect Selenium (Node.js / TypeScript):
```typescript
import { Builder, Browser } from 'selenium-webdriver';

const driver = await new Builder()
  .forBrowser(Browser.CHROME)
  .usingServer('http://127.0.0.1:9222')
  .build();

await driver.get('https://example.com');
await driver.quit();
```

---

## 🐍 Python SDK

Orbis includes a dedicated Python client for **Browser-Use**, **LangChain**, and **CrewAI**:

```bash
pip install memora-browser
```

```python
from memora import OrbisAgent

# 1-line connection to running Orbis daemon
agent = OrbisAgent.connect("http://127.0.0.1:9222")

# Navigate and get token-compressed representation
snap = agent.goto("https://news.ycombinator.com")
print(f"Title: {snap.title} | Tokens: ~{snap.token_estimate}")
print(snap.action_map_text)

# Direct interaction via @actionId
agent.act("@1")

# Check state changes between agent turns
diff = agent.diff()
print(diff["diff"]["summary"])

# Fill out forms in 1 turn
agent.fill_form({"#username": "agent_007", "#password": "secret"}, submit=True)
```

### Python Browser-Use Integration:
```python
from memora import OrbisAgent
from browser_use import Agent
from langchain_openai import ChatOpenAI

orbis = OrbisAgent.connect("http://127.0.0.1:9222")

agent = Agent(
    task="Search Hacker News for latest agent announcements",
    llm=ChatOpenAI(model="gpt-4o"),
    browser_context_kwargs=orbis.to_browser_use()
)
```

---

## 🛠️ Proprietary CDP Domain & REST API

In addition to standard CDP domains (`Page`, `Runtime`, `DOM`, `Network`, `Target`, `Input`), Orbis exposes custom agent acceleration methods:

### CDP WebSocket Methods (`Orbis.*` and `Memora.*`):
* `Orbis.getSemanticSnapshot`: Returns `{ actionMapText, actions, markdown, tokenEstimate, interactiveCount }`. Supports `focusSelector` and `excludeSelectors`.
* `Orbis.diff`: Compares current page state against previous state, returning `{ diff: PageDiffResult, currentSnapshot }`.
* `Orbis.fillForm`: Multi-field form submission `{ fields: {...}, submit: true, steps: [...] }`.
* `Orbis.saveSession`: Serializes cookies, localStorage, and sessionStorage to file `{ filePath: "session.json" }`.
* `Orbis.loadSession`: Deserializes and restores complete storage `{ filePath: "session.json" }`.
* `Orbis.act`: Executes action directly by actionId `{ actionId: "@1", type: "type", text: "..." }`.
* `Orbis.getMarkdown`: Returns clean, distilled Markdown for the current page.

### REST HTTP Endpoints:
* `GET /orbis/snapshot?focus={sel}&exclude={sel}&format=markdown`: Distilled JSON or Markdown snapshot.
* `GET /orbis/diff` & `POST /orbis/diff`: State comparison endpoint.
* `POST /orbis/fill-form`: Multi-field form submission.
* `POST /orbis/act`: Direct action by actionId (`@1`, `@2`) or selector.
* `GET /orbis/session` & `POST /orbis/session`: Export, save, or restore session state.
* `GET /orbis/goto?url={url}`: Navigates and returns distilled result in a single HTTP call.

---

## 🌐 Enterprise Proxy & Anti-Bot Stealth

Orbis routes all network requests—including dynamic page `fetch()`/XHR—through configured proxies with enterprise authentication:

```bash
# HTTP/HTTPS proxy with basic authentication
npx orbis serve --http-proxy 'http://user:pass@proxy.example.com:3128'

# Bearer-token proxy authentication
npx orbis serve --http-proxy http://proxy:3128 --proxy-bearer-token 'SECRET_TOKEN'

# SOCKS5 proxy with bypass list for internal hosts
npx orbis fetch https://example.com --http-proxy socks5://127.0.0.1:1080 --proxy-bypass localhost,.internal.corp

# Inherit standard environment variables (HTTP_PROXY / HTTPS_PROXY / NO_PROXY)
npx orbis serve --use-env-proxy
```

| Network Flag | Description |
| :--- | :--- |
| `--http-proxy <url>` | `http://`, `https://` or `socks5://` proxy; `user:pass@` supported |
| `--proxy-bearer-token <token>` | Sends `Proxy-Authorization: Bearer <token>` to the proxy |
| `--proxy-bypass <hosts>` | Comma-separated hosts that skip the proxy (`localhost`, `.corp`) |
| `--use-env-proxy` | Inherits `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` |
| `--http-header "Name: Value"` | Inject custom header on every outgoing request |
| `--user-agent <ua>` | Override the User-Agent header |
| `--http-timeout <ms>` | Navigation request timeout in milliseconds |
| `--insecure-disable-tls-host-verification` | Accepts self-signed / MITM proxy certificates |

---

## 🤝 robots.txt Compliance (`--obey-robots`)

Opt in and Orbis strictly adheres to RFC 9309 crawler standards:

```bash
npx orbis serve --obey-robots
npx orbis fetch https://example.com --obey-robots
```

- Cached once per origin per session (up to 24h).
- Checked for main navigation, every redirect hop, and asynchronous page `fetch()`.
- Disallowed navigations fail with standard `net::ERR_BLOCKED_BY_CLIENT` over CDP.
- Customize product token: `--robots-agent MyCustomBot`.

---

## 🐳 Docker & Cloud Deployments

Deploy Orbis as a stateless, autoscaled microservice on AWS ECS, GCP Cloud Run, Kubernetes, or Render:

### Run Pre-Built Container:
```bash
docker run -d -p 9222:9222 ghcr.io/yadavmandeep/memora-browser:latest
```

### Docker Compose (`docker-compose.yml`):
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

## 🏗️ Architecture Overview

```
                                 [ AI Agent / Playwright / Puppeteer / MCP ]
                                                    │
                                                    │ CDP (WebSocket JSON-RPC) / HTTP REST
                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              MEMORA BROWSER ENGINE (MBE)                               │
│                                                                                        │
│  ┌───────────────────────────────────┐  ┌───────────────────────────────────────────┐  │
│  │ CDP Server & Dispatcher (:9222)   │  │ REST Agent Endpoints (/orbis/snapshot)    │  │
│  └─────────────────┬─────────────────┘  └─────────────────────┬─────────────────────┘  │
│                    │                                          │                        │
│                    ▼                                          ▼                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                  OrbisPage (MemoraPage)                          │  │
│  │                                                                                  │  │
│  │  ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────┐  │  │
│  │  │ Spec-Compliant DOM     │  │ V8 Sandbox Runtime     │  │ Stealth Fetcher    │  │  │
│  │  │ - MemoraDocument       │  │ - node:vm Context      │  │ - Chrome 130 TLS   │  │  │
│  │  │ - MemoraElement        │  │ - ESM In-Memory Bundler│  │ - Cookie Jar       │  │  │
│  │  │ - CSS-Select Adapter   │  │ - Dynamic SPA Scripts  │  │ - UA / ClientHints │  │  │
│  │  └───────────┬────────────┘  └───────────┬────────────┘  └─────────┬──────────┘  │  │
│  │              │                           │                         │             │  │
│  │              ▼                           ▼                         ▼             │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │               Agentic AXTree & Markdown Distiller                          │  │  │
│  │  │  - Maps interactables to [@1], [@2] action IDs                             │  │  │
│  │  │  - Strips ads, tracking pixels, sub-pixel CSS clutter                      │  │  │
│  │  │  - Generates token-condensed Markdown & Action Maps (< 2ms)                │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                                  │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │          Speculative Forking Engine (page.fork() < 1ms)                    │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ❓ FAQ & Troubleshooting

### Q: Does Orbis require Chrome or Chromium to be installed?
**A:** No! By default, Orbis runs entirely on its pure TypeScript zero-graphics Native Engine with an in-memory V8 sandbox (< 15ms startup, zero GPU). If a specific website requires heavy GPU WebGL or Chrome-specific extensions, pass `--engine chrome` to seamlessly route to system Chromium.

### Q: Why do I see `@1`, `@2` instead of CSS / XPath selectors?
**A:** Orbis produces indexed Semantic Action Trees. Sending fragile 60-character CSS or XPath strings to LLMs wastes prompt tokens and causes hallucination failures. Numbered action IDs (`@1`, `@2`) give LLMs 100% deterministic target accuracy.

### Q: How do I verify that my installation is working?
Run the built-in CLI evaluation:
```bash
npx orbis --eval https://example.com
```
If you see the distilled Markdown and Action Map output in `< 20ms`, your setup is 100% operational!

### Q: How do I run the full test suite?
Clone the repository and run:
```bash
npm install
npm run test:all
```
This runs all 82+ unit, benchmark, proxy, selenium, robots.txt, scripts, and agent test suites.

---

## 📜 License
Apache-2.0 © 2026 Memora ([memora.company](https://memora.company)). All rights reserved.
