# Orbis by Memora — Complete CLI Commands & Features Reference

> **Applies to:** Orbis Engine v0.5.0 (`@memoracompany/memora-orbis` on npm, `memora-orbis` on PyPI)  
> **Target Audience:** AI Agent Developers, LLM Engineers, QA Automation Teams, and Scraping Architects.  
> **Architecture Focus:** 100% Local-First Developer Experience (Zero cloud BaaS dependency required).

---

## Table of Contents

1. [Architectural Overview](#1-architectural-overview)
2. [CLI Commands Reference](#2-cli-commands-reference)
   - [`orbis` (Root Daemon & Engine)](#orbis-root-daemon--engine)
   - [`orbis replay` (Agent Flight Recorder)](#orbis-replay-agent-flight-recorder)
   - [`orbis import-cookies` (Zero-Login Cookie Importer)](#orbis-import-cookies-zero-login-cookie-importer)
   - [`orbis fetch` / `read` / `links` / `scrape`](#orbis-fetch--read--links--scrape)
   - [`orbis firewall`](#orbis-firewall-scan--verify--policy)
   - [`orbis cdp` & `webdriver`](#orbis-cdp--webdriver)
3. [CLI Flags Reference](#3-cli-flags-reference)
   - [RAM & Resource Optimization Flags](#ram--resource-optimization-flags)
   - [Agent Observability & Privacy Flags](#agent-observability--privacy-flags)
   - [Network, Proxy & Stealth Flags](#network-proxy--stealth-flags)
   - [Firewall & Security Flags](#firewall--security-flags)
4. [Management & Health HTTP Endpoints](#4-management--health-http-endpoints)
5. [Model Context Protocol (MCP) Tools Reference](#5-model-context-protocol-mcp-tools-reference)
6. [Core Engine Features & Deep Dives](#6-core-engine-features--deep-dives)
   - [4-Tier Autonomous Self-Healing Locators](#4-tier-autonomous-self-healing-locators)
   - [Two-Way PII Masking Firewall](#two-way-pii-masking-firewall)
   - [Agent Flight Recorder & Offline Replay Scrubber](#agent-flight-recorder--offline-replay-scrubber)
   - [AES-256-GCM Encrypted Session Vault](#aes-256-gcm-encrypted-session-vault)
   - [Cross-Tab Shared Blackboard](#cross-tab-shared-blackboard)
   - [Smart-Wait Framework Hydration Settle](#smart-wait-framework-hydration-settle)
   - [Vision Annotator with Numbered Badges (`@v1`, `@v2`)](#vision-annotator-with-numbered-badges-v1-v2)
7. [TypeScript & Python SDK Code Recipes](#7-typescript--python-sdk-code-recipes)

---

## 1. Architectural Overview

Orbis by Memora is an **agentic browser engine** built from the ground up for autonomous AI workflows. Unlike traditional consumer browsers that prioritize rendering pixels for human vision, Orbis prioritizes **semantic token distillation**, **ultra-low memory footprint**, **deterministic locator execution**, and **local data privacy**.

### Core Performance Characteristics:
- **11x Less RAM:** Operates comfortably in 20MB–80MB RAM per tab compared to Chromium's 350MB–1.2GB.
- **33–40% Fewer LLM Tokens:** Distills complex HTML DOM trees into clean Markdown + an interactive numbered Action Map (`[@1]`, `[@2]`, `[@3]`).
- **Zero-Login Friction:** Directly imports cookies from local desktop browsers into AES-256-GCM encrypted vaults.
- **Resilient Automation:** Recovers automatically from broken selectors using 4-tier DOM fallback algorithms.
- **Client-Side Privacy:** Masks credit cards, API keys, passwords, emails, and SSNs before sending snapshots to LLM context windows.

---

## 2. CLI Commands Reference

### Binary Names
The `@memoracompany/memora-orbis` package exposes three executable aliases:
- `orbis` (**Recommended** primary binary)
- `memora-orbis` (Standard alias)
- `memora-browser` (Legacy alias, will be deprecated in v2.0)

```bash
# Verify installation
npx orbis --version
# Output: 0.5.0
```

---

### `orbis` (Root Daemon & Engine)

Runs the default Chrome DevTools Protocol (CDP) server, one-shot distillation, or MCP server.

```bash
# 1. Start default CDP server on port 9222 (Playwright / Puppeteer ready)
orbis

# 2. Start CDP server on a custom port
orbis --port 9333

# 3. Start in ultra-low RAM Eco Mode (~20MB RAM, strips CSS, blocks media)
orbis --eco --port 9222

# 4. Bind to local Unix Domain Socket or Windows Named Pipe (Zero TCP port allocation)
orbis --unix-socket /tmp/orbis.sock
# On Windows:
orbis --unix-socket \\.\pipe\orbis-cdp

# 5. One-shot evaluation: Fetch URL, distill action map + markdown, and exit
orbis --eval https://news.ycombinator.com

# 6. Start as Model Context Protocol (MCP) stdio server for Cursor / Claude
orbis --mcp
```

---

### `orbis replay [traceFile]` (Agent Flight Recorder)

Launches the offline, zero-dependency interactive HTML replay scrubber for an AI agent browsing session.

```bash
# Auto-discover and open the most recent session trace from .orbis/traces/
orbis replay

# Replay a specific agent flight trace
orbis replay .orbis/traces/trace_1710928374829_checkout.html
```

#### What `orbis replay` provides:
1. **Interactive Scrubber Bar:** Step forwards and backwards through every turn the AI agent performed.
2. **Action Badges:** Visual breakdown of `CLICK`, `FILL`, `NAVIGATE`, `SUBMIT`, and `SMART_WAIT` operations.
3. **Live DOM Snapshot View:** See exactly what Markdown and Action Map the agent viewed at that exact second.
4. **DOM Diff Viewer:** View added/removed elements (`+ Added: [@5] [button] Pay Now`) between steps.
5. **Console & Error Inspection:** Full log output and stack traces for any self-healing fallback or network error.

---

### `orbis import-cookies <filePath>` (Zero-Login Cookie Importer)

Imports cookies exported from your desktop browser (via Chrome/Firefox extensions like "Get cookies.txt LOCALLY" or DevTools JSON) directly into Orbis.

```bash
# 1. Import Netscape cookies.txt for a specific target URL
orbis import-cookies ~/Downloads/cookies.txt --url https://github.com

# 2. Import JSON cookies and save directly into an encrypted Vault profile
orbis import-cookies ./exports/cookies.json --url https://aws.amazon.com --profile work-aws

# 3. Import session into a custom profile for multi-account testing
orbis import-cookies ./staging-session.json --profile staging-admin
```

#### Options:
- `--url <targetUrl>`: The base URL used for domain scoping (default: `https://example.com`).
- `--profile <name>`: Persists the cookies into an AES-256-GCM encrypted vault profile under `~/.orbis/vault/profiles/<name>.enc`.

---

### `orbis fetch` / `read` / `links` / `scrape`

Quick command-line utilities for shell scripts, cron jobs, and terminal debugging:

```bash
# Fetch and print distilled Markdown
orbis fetch https://example.com --dump markdown

# Fetch raw HTML or action map
orbis fetch https://example.com --dump html
orbis fetch https://example.com --dump actions

# Extract a specific subtree by CSS selector
orbis fetch https://example.com --dump-selector "article.main-content"

# Print terminal-friendly readable article text
orbis read https://en.wikipedia.org/wiki/Artificial_intelligence

# Extract all hyperlinks on a page
orbis links https://github.com/trending

# Scrape dynamic pages with waiting
orbis scrape https://app.example.com --wait 2000
```

---

### `orbis firewall` (Scan / Verify / Policy)

Autonomous prompt-injection firewall commands to inspect untrusted web content and audit agent decisions:

```bash
# 1. Scan a live website for prompt injection traps and malicious instruction strings
orbis firewall scan https://untrusted-site.com/profile

# 2. Verify tamper-resistance of cryptographic audit log
orbis firewall verify ./audit.jsonl

# 3. View effective security policy generated by active CLI flags
orbis firewall policy --firewall strict --block-sensitive-domains
```

---

### `orbis cdp` & `webdriver`

Explicit subcommands to launch specific protocol drivers:

```bash
# Start CDP server explicitly
orbis cdp --port 9222 --host 127.0.0.1

# Start W3C WebDriver server for Selenium
orbis webdriver --port 9515 --max-sessions 8 --session-idle-timeout 300
```

---

## 3. CLI Flags Reference

### RAM & Resource Optimization Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--eco` | boolean | **Ultra-Low RAM Preset (~20MB):** Enables `--low-memory`, `--block-media`, `--block-images`, and sets `--strip-mode invisible`. Recycles automatically after 30 actions. |
| `--agent` | boolean | **Smart Agent Preset:** Enables low-memory V8 optimizations with adaptive native/Chrome engine selection. |
| `--low-memory` | boolean | Caps V8 heap size to 256MB (`--js-flags="--max-old-space-size=256"`), disables background audio/video codecs, throttles timers, and drops unused GPU surfaces. |
| `--block-media` | boolean | Intercepts and aborts video streams, audio elements, web font downloads (`.woff2`, `.ttf`), reducing memory consumption by up to 60%. |
| `--block-images` | boolean | Aborts image downloads (`.png`, `.jpg`, `.webp`, `.svg`) and suppresses texture decoding caches. |
| `--strip-mode <mode>` | `none` \| `invisible` \| `all` | Strips non-semantic elements before processing. `invisible` removes hidden CSS stylesheets, SVGs, and display:none nodes. `all` removes all layout-only markup. |
| `--recycle-after <N>` | number | Automatically destroys browser context, cleans caches, and triggers V8 engine garbage collection after every `N` actions (default: 0 = disabled). |
| `--max-pages <N>` | number | Caps maximum concurrent tabs/pages in memory (default: 100). |
| `--unix-socket <path>` | string | Binds CDP / WebDriver to a local Unix domain socket (or Windows named pipe `\\.\pipe\...`) bypassing TCP networking. |

---

### Agent Observability & Privacy Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--record` | boolean | Activates the **Agent Flight Recorder**. Automatically saves structured session traces and interactive replay HTML files to `.orbis/traces/`. |
| `--mask-pii` | boolean | Activates the **Two-Way Client-Side PII Masker**. Replaces credit cards, API keys, passwords, emails, and SSNs with tokens before passing to LLM context. Auto-unmasks on submission. |

---

### Network, Proxy & Stealth Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--no-stealth` | boolean | Disables anti-bot fingerprint masking (by default stealth is ACTIVE, hiding `navigator.webdriver` and spoofing Chrome 130 fingerprints). |
| `--obey-robots` | boolean | Strictly enforces RFC 9309 `robots.txt` compliance across navigations, redirect hops, and background fetch requests. |
| `--robots-agent <token>`| string | Custom user-agent token checked against robots.txt rules (default: `MemoraBrowser`). |
| `--user-agent <ua>` | string | Custom User-Agent header and `navigator.userAgent` override. |
| `--http-proxy <url>` | URL | Routes all browser traffic through an HTTP, HTTPS, or SOCKS5 proxy. |
| `--proxy-bypass <hosts>`| string | Comma-separated list of bypass hosts (e.g. `localhost,127.0.0.1,.internal.net`). |
| `--on-challenge <mode>` | `report` \| `stop` | Behavior when CAPTCHA/bot challenge or 429 is detected. `report` (default) loads the page and alerts; `stop` aborts navigation immediately. |
| `--challenge-cooldown <s>`| number | Seconds to pause outgoing requests to a specific host after receiving a challenge or 429 (default: 60s). |

---

### Firewall & Security Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--firewall <preset>` | `off` \| `standard` \| `strict` | Activates prompt injection firewall. `standard` requires confirmation for destructive actions; `strict` locks down file/storage/eval capabilities. |
| `--allow-domain <glob>`| string | Whitelist domains allowed for navigation (repeatable, e.g. `*.github.com`, `api.stripe.com`). |
| `--block-domain <glob>`| string | Blacklist domains completely blocked from network requests (repeatable). |
| `--block-sensitive-domains`| boolean | Blocks navigation to webmail, banking, cloud consoles (AWS/GCP/Azure), and cloud metadata (`169.254.169.254`). |
| `--audit-log <path>` | string | Path to write hash-chained cryptographic audit log of all agent actions. |

---

## 4. Management & Health HTTP Endpoints

When running in daemon mode (`orbis --port 9222`), Orbis exposes lightweight JSON endpoints for local agent monitoring:

### 1. Memory Health Check
`GET http://localhost:9222/orbis/memory` (or `/memora/memory`)

```json
{
  "rssMb": 64.2,
  "heapUsedMb": 38.1,
  "heapTotalMb": 52.4,
  "externalMb": 4.8,
  "activePages": 3,
  "uptimeSec": 412
}
```

### 2. On-Demand Garbage Collection
`POST http://localhost:9222/orbis/gc` (or `/memora/gc`)

Forces immediate V8 garbage collection and cache purging across all inactive tabs:
```json
{
  "freedMb": 18.4,
  "currentRssMb": 45.8,
  "success": true
}
```

### 3. Agent Semantic Snapshot
`GET http://localhost:9222/orbis/snapshot` (or `/memora/snapshot`)

Returns the distilled Action Map, interactive element count, and clean Markdown of the active tab.

---

## 5. Model Context Protocol (MCP) Tools Reference

Orbis exposes **23 native MCP tools** over stdio. Configure them in Cursor, Claude Desktop, Windsurf, or Google Antigravity:

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

### Complete MCP Tools Catalog

| Category | Tool Name | Description | Key Parameters |
| :--- | :--- | :--- | :--- |
| **Navigation & DOM** | `memora_browse` | Loads URL and returns Markdown + Action Map (`[@1]`, `[@2]`) | `url`, `timeout`, `focus`, `exclude` |
| | `memora_act` | Executes click, type, keypress, or hover on element | `target` (`@1`, `@v1`, `#id`), `value`, `action` |
| | `memora_fill_form` | Fills multiple input fields and optionally submits | `fields` (map of selectors to values), `submit` |
| | `memora_diff` | Summarizes DOM mutations since last turn | `none` |
| | `memora_inspect` | Returns current URL, title, and action map | `none` |
| | `memora_reload` | Reloads current page | `ignoreCache` |
| **Extraction** | `memora_extract` | Scrapes structured elements by CSS selector | `selector`, `attributes` |
| | `memora_extract_schema`| Extracts AI-guided structured entities (products, prices, reviews) | `schema` (`Product`, `Article`, etc.) |
| | `memora_html` | Retrieves outerHTML of full document or selector | `selector` |
| | `memora_metadata` | Returns OpenGraph, Twitter cards, meta tags, JSON-LD | `none` |
| | `memora_smart_search` | Parallel search query aggregator without token bloat | `queries` (array of strings), `limit` |
| **State & Storage** | `memora_cookies` | Get, set, or clear browser cookies | `action` (`get`, `set`, `clear`), `cookies` |
| | `memora_storage` | Reads/writes localStorage and sessionStorage | `type` (`local`, `session`), `key`, `value` |
| | `memora_session` | Saves/restores raw session authentication files | `action` (`save`, `load`), `path` |
| | `memora_vault` | **AES-256-GCM Encrypted Profile Vault** | `action` (`save`, `load`, `list`, `delete`), `profile` |
| **Vision & SPAs** | `memora_smart_wait` | **Waits for SPA framework hydration & network quiet** | `networkIdleMs`, `mutationQuietMs`, `checkHydration` |
| | `memora_screenshot` | **Viewport capture with numbered visual badges (`@v1`, `@v2`)** | `withBoundingBoxes: true`, `format`, `quality` |
| **Memory & Context** | `memora_blackboard` | **Cross-tab shared working memory & fact tracker** | `action` (`summary`, `record_fact`, `set_var`, `get_var`, `clear`) |
| **Safety & Control** | `memora_fork` | Clones current page into new tab in 5ms | `none` |
| | `memora_eval` | Executes JavaScript inside page context | `script` |
| | `memora_console` | Inspects browser console errors/warnings | `clear` |
| | `memora_handoff` | Local visible browser handoff for human CAPTCHA/2FA | `timeoutSec` |
| | `memora_firewall` | Queries prompt-injection firewall policies & audit | `none` |

---

## 6. Core Engine Features & Deep Dives

### 4-Tier Autonomous Self-Healing Locators

Web applications frequently undergo UI updates, redesigns, and dynamic class/ID regeneration. Traditional automation scripts break immediately when a selector changes.

Orbis incorporates an **autonomous 4-tier self-healing fallback algorithm**:

```
Primary Selector Failed / Timed Out (2.5s)
                    │
                    ▼
     [Tier 1: Text & Content Match]
      ↳ Matches exact, trimmed, or partial text
                    │ (If not found)
                    ▼
    [Tier 2: ARIA & Accessibility Match]
      ↳ Matches aria-label, aria-description, title
                    │ (If not found)
                    ▼
   [Tier 3: Form Placeholders & Attributes]
      ↳ Matches placeholder, name, data-testid
                    │ (If not found)
                    ▼
      [Tier 4: Semantic Role Hierarchy]
      ↳ Resolves closest matching role="button", input[type="submit"]
```

When self-healing recovers an element, Orbis executes the action transparently and logs the healed locator for developer review.

---

### Two-Way PII Masking Firewall

When AI agents browse live forms (e.g. personal shopping, account billing, customer support), passing real user data to cloud LLM providers presents major compliance and privacy risks.

The **Two-Way PII Masker** runs strictly on your local machine:
1. **Inbound Masking:** Scans page contents, input fields, and summaries. Replaces real values with cryptographic deterministic tokens:
   - Credit Cards (Luhn algorithm validated) → `{{CARD_1}}`
   - API Keys (`sk-...`, `ghp_...`, Bearer tokens) → `{{API_KEY_1}}`
   - Passwords & Secrets → `{{PASSWORD_1}}`
   - Email Addresses → `{{EMAIL_1}}`
   - Phone Numbers → `{{PHONE_1}}`
   - Social Security Numbers → `{{SSN_1}}`
2. **Outbound Unmasking:** When your LLM agent outputs an action referencing the placeholder:
   ```typescript
   await agent.act('@card_number', '{{CARD_1}}');
   ```
   Orbis intercepts the command locally, retrieves the original secret from secure local memory, and types the real value directly into the DOM input field without ever exposing it over the network to the model.

---

### Agent Flight Recorder & Offline Replay Scrubber

Autonomous workflows can make tens or hundreds of decisions. When an agent fails or produces unexpected behavior, debugging raw text logs is painful.

Enabling `--record` creates a complete, self-contained single-file HTML replay under `.orbis/traces/`:
- **Zero Dependencies:** Pure HTML, CSS, and vanilla JS. Double-click to open in any web browser without running a server.
- **Scrubber Timeline:** Slide through step 1 to step N with real-time timestamp deltas.
- **Visual Action Tags:** Instantly see where the agent clicked, typed, or navigated.
- **DOM Diff Highlights:** Visual green/red highlights showing additions and deletions caused by each step.

Run `orbis replay` anytime to launch the latest recording.

---

### AES-256-GCM Encrypted Session Vault

Storing plaintext cookies and bearer tokens in `.json` files is insecure. The Orbis `SessionVault`:
- Derives strong keys using **PBKDF2** with 100,000 SHA-256 iterations and unique per-vault salt.
- Encrypts session payloads with authenticated **AES-256-GCM** (preventing tampering).
- Validates cookie `expires` timestamps automatically and strips stale cookies on load.
- Supports multi-profile switching in ~5 milliseconds:
  ```typescript
  await agent.loadVaultProfile('staging-admin');
  ```

---

### Cross-Tab Shared Blackboard

When agents operate across multiple tabs (e.g. reading documentation in Tab 1, copying API keys from Tab 2, and submitting a webhook in Tab 3), sharing context is critical.

The `Blackboard` acts as a shared scratchpad:
- **Fact Ledger:** Record categorized insights (`agent.blackboard.recordFact('Found Stripe secret in settings', 'auth')`).
- **Shared Variables:** Store key-value pairs accessible to any tab (`agent.blackboard.setVar('checkout_total', '$49.00')`).
- **Compact Summary:** Generates a ~100-token Markdown digest of all open tabs and facts that can be appended directly to LLM system prompts without token bloat.

---

### Smart-Wait Framework Hydration Settle

Modern web apps built with Next.js, React, Vue, or Nuxt often load HTML immediately, but event listeners are only attached after JavaScript hydration completes. Clicking an element before hydration results in **"dead clicks"** where nothing happens.

`smartWait` settles the page deterministically:
1. Verifies framework hydration flags (e.g. React Fiber root attachment, Next.js page router readiness).
2. Monitors in-flight `fetch()` and `XMLHttpRequest` network calls until network requests remain at 0 for `networkIdleMs` (default 300ms).
3. Monitors DOM mutations via `MutationObserver` until DOM changes cease for `mutationQuietMs` (default 200ms).

---

### Vision Annotator with Numbered Badges (`@v1`, `@v2`)

For multimodal vision models (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro):
- `screenshot({ withBoundingBoxes: true })` injects high-contrast neon badge overlays directly over every clickable and interactive element on the viewport.
- Badges are numbered `@v1`, `@v2`, `@v3`...
- Returns an exact visual bounding box map.
- The `act()` method accepts visual tags directly:
  ```typescript
  await agent.act('@v3'); // Clicks the exact coordinate of visual badge @v3
  ```

---

## 7. TypeScript & Python SDK Code Recipes

### TypeScript / Node.js Recipe: Full Agentic Loop

```typescript
import { OrbisAgent } from '@memoracompany/memora-orbis';

async function main() {
  // 1. Launch local agent with eco mode, PII masking, and flight recording
  const agent = await OrbisAgent.launch({
    eco: true,
    maskPII: true,
    record: true,
    selfHealing: true
  });

  // 2. Load authenticated session from encrypted vault
  await agent.loadVaultProfile('my-production-profile');

  // 3. Navigate and wait for SPA hydration
  const snapshot = await agent.goto('https://app.example.com/billing');
  await agent.smartWait();

  console.log(`Distilled Action Map:\n${snapshot.actionMapText}`);

  // 4. Fill form with masked PII tokens (Orbis unmasks them securely locally)
  await agent.fillForm({
    '#name': 'Alex Developer',
    '#card': '{{CARD_1}}',      // Automatically unmasked upon typing
    '#email': '{{EMAIL_1}}'
  }, /* submit: */ 'text=Update Payment Method');

  // 5. Store result on cross-tab blackboard
  agent.blackboard.recordFact('Payment method updated successfully', 'billing');
  console.log(agent.blackboard.generateSummary());

  await agent.close();
}

main();
```

---

### Python Recipe: Browser-Use / LangChain Integration

```python
import asyncio
from orbis import OrbisAgent

async def main():
    # Connect to local Orbis engine
    agent = await OrbisAgent.launch(cdp_port=9222, eco=True)
    
    # Navigate
    snapshot = await agent.goto("https://news.ycombinator.com")
    print(f"Page title: {snapshot.title}")
    print(f"Interactive items: {snapshot.interactive_count}")
    
    # Act via Action ID
    await agent.act("@1")
    
    # Print Blackboard context summary
    summary = agent.blackboard.get_summary()
    print(summary)
    
    await agent.close()

if __name__ == "__main__":
    asyncio.run(main())
```
