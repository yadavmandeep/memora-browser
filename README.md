# 🪐 ORBIS BY MEMORA
### *The Web, Working for You.*
> **An Agentic Browser. Built for Autonomous Intelligence.**  
> *Explore. Understand. Execute.*  
>
> 🌐 **Website:** [orbis.memora.company](https://orbis.memora.company) • **Company:** [memora.company](https://memora.company)  
> ⚡ **Core Engine:** Memora Browser Engine (MBE) (`memora-browser`) — *Drop-in CDP & W3C WebDriver for AI Agents & LLMs*

---

## 🌟 Why Orbis by Memora?

Traditional headless browsers (Chromium, Firefox, WebKit) were designed for **humans to look at screens**. When AI agents and web scrapers use them, over **80% of CPU and RAM is wasted** computing GPU rasterization, CSS box reflows, font hinting, and compositing layers.

**Lightpanda** proved that stripping the visual graphics pipeline cuts RAM by 10x. But Lightpanda was still built for traditional scrapers—forcing AI agents to ingest **500KB of raw, messy HTML** or **4K pixel screenshots**, burning tens of thousands of LLM tokens and seconds of reasoning latency.

**Orbis by Memora is fundamentally different**:
1. **Zero-Graphics Runtime (Memora Browser Engine)**: Strips Skia/GPU rasterization entirely—giving **< 15ms cold start** and **~18MB base RAM**.
2. **Native AXTree & Action Map Distillation**: Converts live web pages in `< 1ms` into an indexed Semantic Action Tree (`[@1]`, `[@2]`, `[@3]`) and clean Markdown, saving **up to 95% LLM tokens**.
3. **Drop-in CDP Compatibility**: Exposes standard Chrome DevTools Protocol (`ws://127.0.0.1:9222`), so **Playwright**, **Puppeteer**, **Browser-Use**, and **Stagehand** connect with zero code changes.
4. **Speculative Branching (`page.fork()`)**: Instant Copy-on-Write page branching in `< 1ms`. Agents can test multiple execution paths simultaneously without making extra network requests.
5. **Built-in Stealth & Fingerprint Masking**: Engine-level evasion of `navigator.webdriver`, genuine Chrome 130 Client Hints, hardware emulation, and coherent TLS profiles.
6. **Orbis Agent Autonomous Controller**: High-level, 1-line self-healing agent loop with automatic multi-step form wizard filling and DOM state diffing.

---

## 📊 Benchmark Comparison

| Metric | Headless Chromium | Lightpanda | **Memora Browser** |
| :--- | :--- | :--- | :--- |
| **Cold Start Latency** | 1,500ms – 3,000ms | ~50ms | **< 15ms** ⚡ |
| **RAM Footprint (per tab)** | 350MB – 600MB | 25MB – 40MB | **~18MB – 28MB** 🚀 |
| **LLM Token Ingestion** | 30,000 – 80,000 tokens | 30,000 – 80,000 tokens | **300 – 1,200 tokens** (95% saving) |
| **Action Targeting** | Fragile XPath / CSS | Fragile CSS | **Numbered Action IDs (`@1`, `@2`)** |
| **Branching (Fork-on-Action)**| ❌ (Opens new 400MB tab) | ❌ | **✅ `page.fork()` in < 1ms** |
| **Playwright / Puppeteer** | Native | CDP (partial) | **Full CDP Wire Protocol** |
| **Selenium (WebDriver)** | via chromedriver | Native (Classic + BiDi) | **Native (Classic)** |
| **Proxy** | ✅ | HTTP(S), basic + bearer | **HTTP(S) + SOCKS5, basic + bearer, bypass list** |
| **Stealth Coherence** | Easily detected | Custom non-standard TLS | **Chrome 130 Genuine Profile** |

---

> 📖 **Looking for full installation instructions across Python, Node.js, Cursor, Claude Desktop, and Docker?**  
> Check out the complete **[End-User Installation Guide (INSTALLATION.md)](INSTALLATION.md)**.

---

## 🚀 Quick Start (CLI)

Run Memora Browser as a standalone CDP daemon:

```bash
# Launch CDP server on default port 9222 with stealth enabled
npx memora-browser --port 9222 --stealth
```

Output:
```text
╔════════════════════════════════════════════════════════════════╗
║                   ⚡ MEMORA AGENTIC BROWSER                    ║
║         Ultra-Fast Headless Engine for AI Agents & LLMs        ║
╚════════════════════════════════════════════════════════════════╝
  ▶ CDP WebSocket:      ws://127.0.0.1:9222/devtools/browser/memora-root
  ▶ Discovery Endpoint: http://127.0.0.1:9222/json/version
  ▶ Agent Snapshot:     http://127.0.0.1:9222/memora/snapshot
  ▶ Memory Footprint:   ~83.4 MB (Chromium uses ~350MB+)
  ▶ Stealth Mode:       🛡️  ACTIVE (Anti-Detect On)
  ▶ Status:             READY FOR PLAYWRIGHT / PUPPETEER / AGENTS
```

### One-Shot CLI Distillation:
```bash
npx memora-browser --eval https://news.ycombinator.com
```

---

## 🔌 Model Context Protocol (MCP) Server for Cursor & Claude Desktop

Memora Browser works out-of-the-box as an ultra-fast **Model Context Protocol (MCP)** server for AI coding tools (**Cursor, Claude Desktop, Antigravity, Windsurf**).

Add this to your `mcp.json` (or `claude_desktop_config.json`):

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

### Provided MCP Tools for AI Coding Assistants:
* `memora_browse`: Loads any technical documentation or web page, executes scripts, and returns clean Markdown + Action Map saving 95% prompt tokens. Supports `focusSelector` and `excludeSelectors`.
* `memora_act`: Interacts with elements (`click`, `type`) using `@1`, `@2` action IDs or CSS selectors.
* `memora_diff`: Computes state diff between sequential agent actions (added, removed, mutated interactives).
* `memora_fill_form`: Fills multiple fields (text, select, checkbox, radio, textarea, contenteditable) and multi-step form wizards in one atomic turn.
* `memora_session`: Saves and restores cookies, localStorage, and sessionStorage across sessions.
* `memora_inspect`: Inspects active DOM structure and interactive elements.
* `memora_eval`: Evaluates JavaScript inside the page's V8 sandbox.
* `memora_fork`: Speculatively clones the page state in `< 1ms` to test alternative UI paths.

### ⚙️ Dual-Tier Engine Flag (`--engine native|chrome|auto`)
Memora features a hybrid dual-tier architecture:
* `--engine native` (Default): Ultra-lightweight custom DOM + V8 sandbox engine (<15ms cold start, ~18MB RAM, zero GPU). Supports `<script type="module">` ESM bundles in-memory.
* `--engine chrome`: Uses headless Chromium when full GPU pixel rendering or obscure browser APIs are required.
* `--engine auto`: Automatically evaluates target page complexity and routes accordingly.

```bash
# Run MCP server with Chrome fallback engine
npx memora-browser --mcp --engine chrome
```

---

## 🤝 robots.txt Support (`--obey-robots`)

Opt in and Memora Browser behaves like a well-mannered crawler (RFC 9309):

```bash
npx memora-browser --obey-robots                       # CDP server
npx memora-browser fetch https://example.com --obey-robots
npx memora-browser --mcp --obey-robots                 # MCP server
```

- `robots.txt` is fetched **once per origin per session** and cached (24h max); concurrent requests to the same origin wait on a single fetch.
- **Every request is checked** — navigations, each redirect hop, and page `fetch()`/XHR.
- Supports `User-agent` groups (case-insensitive), `Allow`/`Disallow`, `*` wildcards and the `$` end anchor; the longest match wins and `Allow` wins ties.
- `robots.txt` 4xx → everything allowed; 5xx or unreachable → everything blocked.
- Blocked requests fail with `RobotsBlockedError` (`ERR_BLOCKED_BY_ROBOTS`); over CDP, `Page.navigate` returns `errorText: "net::ERR_BLOCKED_BY_CLIENT"`, like Chrome.
- Rules are matched against the product token `MemoraBrowser`; change it with `--robots-agent <token>`.

Run the tests with `npm run test:robots`.

---

## 🤖 Playwright Drop-In Integration

Connect existing Playwright scripts to Memora Browser with **zero code changes**:

```typescript
import { chromium } from 'playwright';

// Connect over CDP directly to Memora Browser
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

await page.goto('https://example.com');
console.log('Page Title:', await page.title());

await browser.close();
```

---

## 🧪 Selenium / W3C WebDriver

Memora speaks **W3C WebDriver Classic** natively, so Selenium, WebdriverIO and Nightwatch suites run with no chromedriver. You only change how the driver is created (same approach as `lightpanda serve --protocol webdriver`):

```bash
npx memora-browser serve --protocol webdriver --port 9222
```

```python
# conftest.py
import pytest
from selenium import webdriver

@pytest.fixture
def driver():
    d = webdriver.Remote("http://127.0.0.1:9222", options=webdriver.ChromeOptions())
    yield d
    d.quit()
```

```typescript
// selenium-webdriver (Node)
const driver = await new Builder().forBrowser(Browser.CHROME).usingServer('http://127.0.0.1:9222').build();
```

A runnable pytest example lives in [`examples/selenium-python`](examples/selenium-python).

| Capability | Status |
| :--- | :--- |
| Sessions (parallel, isolated cookies), `--max-sessions` (default 16) | ✅ |
| Navigation: get, back, forward, refresh, title, url, page source | ✅ |
| Locators: CSS, ID, name, class, tag, link text, partial link text, **XPath 1.0** | ✅ |
| Click (follows links, submits forms, toggles checkboxes/radios, selects options), send keys (Enter submits, Backspace), clear | ✅ |
| `is_displayed`, `is_enabled`, `is_selected`, `get_attribute`, `get_property`, `text`, inline `value_of_css_property` | ✅ (no layout: stylesheet rules are not applied) |
| `execute_script` / `execute_async_script` with element args and results | ✅ |
| Explicit **and implicit** waits | ✅ |
| Cookies, new tabs/windows, Actions API (pointer click, keyboard) | ✅ |
| W3C `proxy` capability per session (`options.proxy = Proxy(...)`) | ✅ |
| Frames, alerts, Shadow DOM, WebDriver BiDi | ❌ not yet |
| Screenshots | ⚠️ placeholder 1×1 PNG |
| Pages that need external `<script src>` bundles, `document.write` or jQuery | ❌ native engine limitation |

---

## 🌐 Proxy & Network Options

All commands (`serve`, `fetch`, `--eval`, `--mcp`, WebDriver sessions) accept the same network flags. Every request goes through the proxy, including `fetch()` calls made by page scripts.

```bash
# HTTP/HTTPS proxy, basic auth in the URL
npx memora-browser serve --http-proxy 'http://user:pass@proxy.example.com:3128'

# Bearer-token proxy auth (Proxy-Authorization: Bearer ...)
npx memora-browser serve --http-proxy http://proxy:3128 --proxy-bearer-token MY-TOKEN

# SOCKS5 with credentials, skip the proxy for internal hosts
npx memora-browser fetch https://example.com --http-proxy socks5://user:pass@127.0.0.1:1080 --proxy-bypass localhost,.internal.corp

# Pick up HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY from the environment
npx memora-browser serve --use-env-proxy
```

| Flag | Description |
| :--- | :--- |
| `--http-proxy <url>` | `http://`, `https://` or `socks5://` proxy; `user:pass@` for basic auth |
| `--proxy-bearer-token <token>` | Sends `Proxy-Authorization: Bearer <token>` (HTTP proxies) |
| `--proxy-bypass <hosts>` | Comma-separated hosts that skip the proxy (`localhost`, `.corp`, `*.example.com`, `host:port`) |
| `--use-env-proxy` | Use the standard proxy environment variables when `--http-proxy` is not set |
| `--http-header "Name: Value"` | Extra header on every request (repeatable) |
| `--user-agent <ua>` | Override the User-Agent |
| `--http-timeout <ms>` | Navigation request timeout |
| `--insecure-disable-tls-host-verification` | Accept self-signed / MITM-proxy certificates |

Programmatic use: `new MemoraBrowser({ network: { proxy: 'http://user:pass@host:3128', noProxy: ['localhost'] } })`.

> The Chrome-backed MCP mode supports `http(s)://` and `socks5://` proxies with basic auth, but not `--proxy-bearer-token` (Chrome can't send it on HTTPS tunnels).

---

## 🧠 Autonomous AI Agent Loop (`MemoraAgent` & `@actionId` Primitives)

AI agents can interact directly with concise action IDs (`@1`, `@2`) or use the high-level **1-line `MemoraAgent` controller**:

```typescript
import { MemoraAgent } from 'memora-browser';

// 1-line launcher with anti-detect stealth and instant CDP server
const agent = await MemoraAgent.launch({ stealth: true });

// Navigate and get compact LLM-ready representation (<1000 tokens)
const snapshot = await agent.goto('https://app.example.com/checkout');
console.log(snapshot.actionMapText);
/*
=== INTERACTIVE ACTION MAP ===
[@1] [input:text] "First Name" (selector: #fname)
[@2] [input:email] "Email Address" (selector: #email)
[@3] [select] "Country" (selector: #country)
[@4] [input:checkbox] "Subscribe to newsletter" (selector: #newsletter)
[@5] [button] "Proceed to Payment" (selector: #btn-next)
*/

// 1. Single-turn Form Filling (all standard input types)
await agent.fillForm({
  '@1': 'Jane Doe',
  '@2': 'jane@enterprise.com',
  '@3': 'United States',
  '@4': 'true' // checkboxes, radios, dates, textareas, and contenteditable
}, /* submit: */ true);

// 2. Observe what changed on the page with State Diffing
const diff = agent.diff();
console.log(diff.summary);
// "+ Added: [@6] [input] Card Number, [@7] [button] Pay Now"

// 3. Multi-Step Form Wizards (Atomic execution)
await agent.page.fillForm({
  steps: [
    { fields: { '#fname': 'Jane', '#email': 'jane@enterprise.com' }, submitActionId: '#btn-next' },
    { fields: { '#card': '424242424242', '#cvv': '123' }, submitActionId: '#btn-pay' }
  ]
});

// 4. Save and restore sessions (Cookies, localStorage, sessionStorage)
agent.saveSession('./sessions/checkout.json');

// 5. Speculative Forking (Explore alternatives in parallel without network penalty!)
const speculativeBranch = agent.fork();
speculativeBranch.act('@5'); // tests alternate checkout path on a lightweight clone

await agent.close();
```

---

## 🧩 Framework Adapters (Browser-Use, Stagehand, LangChain)

### 1. Browser-Use (TypeScript & Python)
Memora is a drop-in high-speed engine for [Browser-Use](https://github.com/browser-use/browser-use):

```typescript
// TypeScript
import { MemoraAgent, getBrowserUseConfig } from 'memora-browser';

const agent = await MemoraAgent.launch({ cdpPort: 9222 });
const config = getBrowserUseConfig(agent);
// Pass config.cdpUrl ('http://127.0.0.1:9222') into Browser-Use Controller
```

```python
# Python
from memora import MemoraAgent

agent = MemoraAgent.connect("http://127.0.0.1:9222")
snap = agent.goto("https://news.ycombinator.com")
print(snap.action_map_text)

# Direct form fill & diff
agent.act("@1")
diff = agent.diff()
```

### 2. Stagehand
```typescript
import { MemoraAgent, getStagehandConfig } from 'memora-browser';
import { Stagehand } from '@browserbasehq/stagehand';

const agent = await MemoraAgent.launch({ cdpPort: 9222 });
const stagehand = new Stagehand(getStagehandConfig(agent));
await stagehand.init();
```

### 3. LangChain
```typescript
import { MemoraAgent, createMemoraLangChainTools } from 'memora-browser';

const agent = await MemoraAgent.launch();
const tools = createMemoraLangChainTools(agent);
// tools = [memora_navigate, memora_snapshot, memora_act, memora_diff, memora_fill_form]
```

---

## 🛠️ Proprietary CDP Extensions (`Memora.*` Domain)

In addition to standard CDP domains (`Page`, `Runtime`, `DOM`, `Network`, `Target`, `Input`), Memora Browser provides custom agent acceleration methods:

- `Memora.getSemanticSnapshot`: Returns `{ actionMapText, actions, markdown, tokenEstimate, interactiveCount }`. Supports `focusSelector` and `excludeSelectors`.
- `Memora.diff`: Compares current page state against previous state, returning `{ diff: PageDiffResult, currentSnapshot }`.
- `Memora.fillForm`: Population of fields across input types and multi-step forms: `{ fields: {...}, submit: true }`.
- `Memora.saveSession`: Serializes cookies, localStorage, and sessionStorage to file: `{ filePath: "session.json" }`.
- `Memora.loadSession`: Deserializes and restores complete storage: `{ filePath: "session.json" }`.
- `Memora.act`: Executes an action directly by actionId: `{ actionId: "@1", type: "type", text: "..." }`.
- `Memora.getMarkdown`: Returns clean, distilled Markdown for the current page.

### REST API Endpoints:
- `GET /memora/snapshot?focus={sel}&exclude={sel}&format=markdown`: Returns distilled JSON or Markdown snapshot over HTTP.
- `GET /memora/diff` & `POST /memora/diff`: State comparison endpoint.
- `POST /memora/fill-form`: Multi-field form submission.
- `POST /memora/act`: Direct action by actionId (`@1`, `@2`) or selector.
- `GET /memora/session` & `POST /memora/session`: Export, save, or restore session state.
- `GET /memora/goto?url={url}`: Navigates and returns distilled result in a single HTTP round-trip.

---

## 🏗️ Architecture Overview

```
                                 [ AI Agent / Playwright / Puppeteer ]
                                                 │
                                                 │ CDP (WebSocket JSON-RPC) / HTTP
                                                 ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 MEMORA BROWSER ENGINE                                  │
│                                                                                        │
│  ┌─────────────────────────────────┐   ┌────────────────────────────────────────────┐  │
│  │ CDP Server & Dispatcher (:9222) │   │ REST Agent Endpoints (/memora/snapshot)    │  │
│  └────────────────┬────────────────┘   └─────────────────────┬──────────────────────┘  │
│                   │                                          │                         │
│                   ▼                                          ▼                         │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                  MemoraPage                                      │  │
│  │                                                                                  │  │
│  │  ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────┐  │  │
│  │  │ Spec-Compliant DOM     │  │ V8 Sandbox Runtime     │  │ Stealth Fetcher    │  │  │
│  │  │ - MemoraDocument       │  │ - node:vm Context      │  │ - Chrome 130 TLS   │  │  │
│  │  │ - MemoraElement        │  │ - DOM Globals Inject   │  │ - Cookie Jar       │  │  │
│  │  │ - CSS-Select Adapter   │  │ - Dynamic SPA Scripts  │  │ - UA / ClientHints │  │  │
│  │  └───────────┬────────────┘  └───────────┬────────────┘  └─────────┬──────────┘  │  │
│  │              │                           │                         │             │  │
│  │              ▼                           ▼                         ▼             │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │               Agentic AXTree & Markdown Distiller                          │  │  │
│  │  │  - Maps interactables to [@1], [@2] action IDs                             │  │  │
│  │  │  - Strips ads, scripts, tracking pixels                                    │  │  │
│  │  │  - Generates token-condensed Markdown & Action Maps (<2ms)                 │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                                  │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │          Speculative Forking Engine (page.fork() < 1ms)                    │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 📜 License
Apache-2.0 © 2026 Memora ([memora.company](https://memora.company)). All rights reserved.

