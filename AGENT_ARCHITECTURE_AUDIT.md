# ⚡ Memora Browser: Agent-Native Architecture Audit & Strategic Roadmap

> **Document Type:** Technical Architecture Review, Reality Check & Agent Feature Roadmap  
> **Target:** `memora-browser` (Agentic Headless Browser Engine)  
> **Status:** Active Reference / Engineering RFC  
> **Date:** October 2026  

---

## 📑 Table of Contents
1. [Executive Summary & Core Value Proposition](#1-executive-summary--core-value-proposition)
2. [Deep-Dive Technical Audit & Current Realities](#2-deep-dive-technical-audit--current-realities)
   - [2.1 Dual-Engine Duality (MCP vs Native Engine)](#21-dual-engine-duality-mcp-vs-native-engine)
   - [2.2 Modern JavaScript Limitations (ES Modules Skipped)](#22-modern-javascript-limitations-es-modules-skipped)
   - [2.3 `page.fork()` Implementation vs Claim](#23-pagefork-implementation-vs-claim)
   - [2.4 Synthetic Layout Grid Hack](#24-synthetic-layout-grid-hack)
   - [2.5 Action Map Selector Collision Vulnerability](#25-action-map-selector-collision-vulnerability)
   - [2.6 Distiller Deficiencies](#26-distiller-deficiencies)
3. [Must-Have Features for AI Agents (The Agentic Gap)](#3-must-have-features-for-ai-agents-the-agentic-gap)
   - [3.1 Page State Diffing (`memora_diff`)](#31-page-state-diffing-memora_diff)
   - [3.2 True Accessibility Tree & Visibility Filtering](#32-true-accessibility-tree--visibility-filtering)
   - [3.3 Deterministic & Resilient Selectors](#33-deterministic--resilient-selectors)
   - [3.4 Batch Action Primitives (`memora_fill_form`)](#34-batch-action-primitives-memora_fill_form)
   - [3.5 Robust Async Settle & Wait Primitives](#35-robust-async-settle--wait-primitives)
   - [3.6 Session Vault (State Export & Import)](#36-session-vault-state-export--import)
   - [3.7 Scoped / Goal-Oriented Distillation](#37-scoped--goal-oriented-distillation)
4. [Anti-Features: What NOT to Build (Avoid the Trap)](#4-anti-features-what-not-to-build-avoid-the-trap)
5. [Target Architecture: Intelligent Dual-Tier Engine](#5-target-architecture-intelligent-dual-tier-engine)
6. [Phased Implementation Roadmap](#6-phased-implementation-roadmap)

---

## 1. Executive Summary & Core Value Proposition

`memora-browser` addresses one of the most critical bottlenecks in the agentic AI landscape: **traditional headless browsers (Chromium, WebKit) were designed for human eyeballs, not LLMs**.

* **The Problem:** When an AI agent browses the web, standard Chromium burns **350MB–600MB RAM per tab** and sends **30k–80k raw HTML/CSS tokens** or 4K pixel screenshots to LLMs, causing high latency, token exhaustion, and context window pollution.
* **Memora's Core Hypothesis:** By stripping graphical rasterization, font layout, and rendering pipelines, a browser can run in **< 25MB RAM**, cold start in **< 15ms**, and distill pages directly into indexed **Action Maps (`[@1]`, `[@2]`)** and clean Markdown, slashing LLM prompt tokens by up to **95%**.

While the foundation is exceptionally promising, the codebase currently suffers from architectural divergences between advertised capabilities and actual implementations. This document details those gaps and lays out a blueprint to make Memora the gold standard for agentic browsing.

---

## 2. Deep-Dive Technical Audit & Current Realities

### 2.1 Dual-Engine Duality (MCP vs Native Engine)
* **Finding:** There is an architectural split in the codebase.
  * In `src/engine/page.ts` and `src/runtime/v8-sandbox.ts`, Memora implements a custom zero-graphics DOM engine (`parse5` + `node:vm`).
  * In `src/mcp/server.ts`, the Model Context Protocol server **completely bypasses the native engine** and instantiates `ChromeEngine` (`src/engine/chrome-engine.ts`), which spawns an actual Google Chrome or Microsoft Edge binary via `playwright-core`.
* **Impact:** MCP clients (Cursor, Claude, Antigravity) do not receive the advertised "18MB / 15ms zero-graphics engine"—they run full Chromium. This fallback was added because the native engine breaks on real-world SPAs.
* **Recommendation:** Formalize this into an explicit, transparent **Dual-Tier Architecture** with configurable engine modes (`--engine auto|native|chrome`).

### 2.2 Modern JavaScript Limitations (ES Modules Skipped)
* **Finding:** In `src/engine/page.ts` (lines 104–107):
  ```typescript
  if (kind === 'module') {
    warnings.push(`Module script skipped (type="module" is not supported): ${element.getAttribute('src') || 'inline'}`);
    continue;
  }
  ```
* **Impact:** In modern web development, over 85% of client-side frameworks (Vite, Next.js, Nuxt, Vue 3, React 18+ ESM builds) rely on `<script type="module">`. In the native engine, none of these scripts run, causing modern SPAs to fail hydration.

### 2.3 `page.fork()` Implementation vs Claim
* **Finding:** 
  * The README states: *"Instant Copy-on-Write page branching in < 1ms... without making extra network requests."*
  * **Native Engine (`page.ts`):** `fork()` dumps `document.outerHTML` and re-parses it (`loadDocument(html)`). It restores cookies and storage, but **destroys all in-memory V8 state**, active closures, event listeners attached via `addEventListener`, and framework runtime states (React fibers, Vue reactivity).
  * **Chrome Engine (`chrome-engine.ts`):** `fork()` simply executes `context.newPage()` followed by `newPage.goto(page.url())`, initiating a new network request and re-downloading the entire page.
* **Recommendation:** Frame this transparently as **"State-Snapshot Forking (DOM + Storage + Cookies)"** rather than OS-level/V8 copy-on-write memory branching.

### 2.4 Synthetic Layout Grid Hack
* **Finding:** In `src/cdp/dom-compat.ts` (lines 19–49):
  ```typescript
  const CELL_W = 80;
  const CELL_H = 24;
  const COLS = Math.floor(VIEWPORT.width / CELL_W);
  const ROWS = Math.floor(VIEWPORT.height / CELL_H);
  const SLOTS = COLS * ROWS; // 480 slots
  slot = this.next++ % SLOTS;
  ```
* **Impact:** Elements are assigned artificial 80x24 pixel grid cells to satisfy Playwright's CDP hit-testing. If a page has more than 480 queried elements, slot eviction occurs. Spatial awareness (e.g., "is element A above element B?", "is element inside viewport?") is completely synthetic and unreliable for vision-aided or spatial reasoning agents.

### 2.5 Action Map Selector Collision Vulnerability
* **Finding:** In `src/distiller/semantic-tree.ts` (lines 44–48):
  ```typescript
  } else if (node.className) {
    const firstCls = node.className.split(/\s+/)[0];
    selector = firstCls ? `${tag}.${firstCls}` : tag;
  } else {
    selector = tag;
  }
  ```
* **Impact:** On modern sites using utility CSS (Tailwind, Bootstrap), multiple buttons frequently share identical initial classes (e.g. `button.p-2` or `button.btn`). When an agent targets `[@3]` expecting the "Delete" button, `memora_act` executes `page.click('button.btn')`, which clicks the **first matching element** ("Edit"), leading to catastrophic agent mis-actions.

### 2.6 Distiller Deficiencies
* **Finding:** In `src/distiller/markdown.ts` (lines 34–40):
  ```typescript
  if (tag === 'p') {
    const pText = node.textContent.trim().replace(/\s+/g, ' ');
    if (pText) lines.push(`\n${pText}\n`);
    return;
  }
  ```
* **Impact:** When a paragraph contains inline elements like links (`<p>Click <a href="/login">here</a></p>`) or formatting, the distiller takes `node.textContent` and immediately returns. The markdown link formatting `[here](/login)` is stripped entirely.
* **Finding:** `semantic-tree.ts` lacks visibility checking; hidden inputs, off-screen drawers, and elements with `display: none` or `aria-hidden="true"` get indexed into the action map, polluting agent token budgets.

---

## 3. Must-Have Features for AI Agents (The Agentic Gap)

To make Memora Browser an indispensable runtime for autonomous agents (Browser-Use, Stagehand, AutoGPT, Claude Computer Use), the following features must be prioritized:

### 3.1 Page State Diffing (`memora_diff`) 🚀
* **The Problem:** In an agentic loop, after clicking a button or typing into a field, the agent receives the full 1,000–2,000 token Action Map and Markdown again. In a 15-step task, 25,000+ tokens are wasted on repeated boilerplate.
* **The Solution:** A dedicated diffing mechanism returning only the delta between state $T$ and $T+1$:
  ```json
  {
    "urlChanged": false,
    "title": "Dashboard",
    "added": [
      { "actionId": "@52", "role": "menuitem", "text": "Profile Settings" },
      { "actionId": "@53", "role": "menuitem", "text": "Log Out" }
    ],
    "removed": ["@14"],
    "mutated": [
      { "actionId": "@12", "text": "Options", "state": { "expanded": true } }
    ],
    "status": "DOM settled in 42ms"
  }
  ```
* **Benefit:** 80% token savings across multi-turn agent sessions.

### 3.2 True Accessibility Tree & Visibility Filtering
* Filter out non-actionable elements before the LLM ever sees them:
  - Prune elements with `aria-hidden="true"`, `hidden` attribute, or `display: none` / `visibility: hidden`.
  - Exclude zero-dimension elements.
  - Collapse redundant nesting (e.g. `<a><button>Click</button></a>` should produce a single action item, not two).
  - Extract computed accessible state: `checked`, `disabled`, `expanded`, `selected`, `level`.

### 3.3 Deterministic & Resilient Selectors
* Replace naive class-slicing with guaranteed uniqueness:
  1. **Tier 1:** `[data-testid]`, `[data-qa]`, unique `#id`.
  2. **Tier 2:** Semantic Role + Accessible Name (`role=button[name="Submit"]`).
  3. **Tier 3:** Hierarchical Unique Selector (`form#login > div:nth-child(2) > button`).
  4. **Direct Reference:** When acting via CDP or internal DOM, reference nodes directly by their internal `nodeId` rather than re-querying by CSS string.

### 3.4 Batch Action Primitives (`memora_fill_form`)
* **The Problem:** Filling a registration form takes 4–6 agent round-trips (`type`, wait, `type`, wait, `click`).
* **The Solution:** Allow compound agent instructions in a single turn:
  ```json
  {
    "tool": "memora_fill_form",
    "arguments": {
      "inputs": {
        "@1": "alice@company.com",
        "@2": "SecurePass123!",
        "@3": "Engineering"
      },
      "submitActionId": "@4"
    }
  }
  ```

### 3.5 Robust Async Settle & Wait Primitives
* Most agent execution failures stem from **race conditions** (clicking before React hydrates, or reading snapshot while a fetch spinner is active).
* **Additions:**
  - `page.waitForSelector(selector, { state: 'visible' | 'attached', timeoutMs })`
  - `page.waitForNetworkIdle({ idleMs: 500, timeoutMs: 10000 })`
  - `page.settleOnDOMMutation({ quietPeriodMs: 250 })`: Resolves when DOM modifications cease for a quiet window.

### 3.6 Session Vault (State Export & Import)
* Web agents should not solve logins and CAPTCHAs repeatedly across script invocations.
* **Additions:**
  ```bash
  # CLI / MCP session snapshotting
  memora session export --out ./sessions/github-auth.json
  memora session import --in ./sessions/github-auth.json
  ```
  Exports a sealed bundle of `cookies`, `localStorage`, `sessionStorage`, and `originPermissions`.

### 3.7 Scoped / Goal-Oriented Distillation
* Allow agents to define attention boundaries to eliminate noisy navigation headers, footers, and cookie banners:
  ```typescript
  page.getSemanticSnapshot({
    focusSelector: 'main, article, #app-content',
    excludeSelectors: ['nav', 'footer', '.cookie-consent', '.advertisement']
  });
  ```

---

## 4. Anti-Features: What NOT to Build (Avoid the Trap)

To maintain focus, high velocity, and ultra-low resource usage, **explicitly reject** the following features:

| Anti-Feature | Why Reject It? |
| :--- | :--- |
| **Custom CSS Box Reflow / Painting Engine** | Writing a spec-compliant CSS layout engine (Blink/WebKit clone) in pure TypeScript is a multi-million-dollar trap. Use layout heuristics or delegate to Tier-2 Chromium when visual geometry is required. |
| **Pixel Rasterization / Audio / Video / WebGL** | Headless AI agents only process structured tokens and layout semantics. Decoding H.264 video or rasterizing WebGL shaders burns hundreds of MBs of RAM with zero agent value. |
| **Full JSDOM Integration** | JSDOM is notoriously memory-heavy, slow, and prone to leaks under continuous navigation. Retain the lean `parse5` + custom `MemoraNode` design. |
| **Pure Vision / Screenshot-Only Agent Loop** | Multimodal screenshot loops cost ~\$0.03–\$0.08 per step and suffer high latency. Memora’s competitive advantage is **Semantic Text/Action-Map Distillation**. Double down on text-first representation. |

---

## 5. Target Architecture: Intelligent Dual-Tier Engine

The optimal architecture balances raw speed for simple sites with 100% compatibility for complex SPAs:

```
                            ┌────────────────────────────────────────┐
                            │      AI Agent / MCP / CDP Client       │
                            └───────────────────┬────────────────────┘
                                                │
                                                ▼
                            ┌────────────────────────────────────────┐
                            │       Memora Intelligent Router        │
                            │   - Inspects target page & headers     │
                            │   - Evaluates script requirements      │
                            └───────┬────────────────────────┬───────┘
                                    │                        │
               [Static / SSR / Lightweight]             [Complex SPA / Heavy JS]
                                    │                        │
                                    ▼                        ▼
     ┌─────────────────────────────────────────┐  ┌───────────────────────────────────┐
     │      Tier 1: Native Ultra-Light Engine   │  │   Tier 2: Chrome Headless-Shell   │
     │  - < 15ms Startup, ~18MB RAM            │  │  - Full ES Modules, React 18, Vite│
     │  - Custom DOM + node:vm Sandbox         │  │  - Headless-Shell (no GPU window) │
     │  - Zero GPU rasterization               │  │  - Transparent failover           │
     └────────────────────┬────────────────────┘  └─────────────────┬─────────────────┘
                          │                                         │
                          └────────────────────┬────────────────────┘
                                               │
                                               ▼
     ┌─────────────────────────────────────────────────────────────────────────────────┐
     │                     Unified Semantic Distillation Layer                         │
     │  - Real Accessibility (AXTree) Calculation & Visibility Pruning                 │
     │  - Collision-Free Action IDs ([@1], [@2]) with Stable References                │
     │  - State Diffing Engine (memora_diff)                                           │
     │  - Token-Optimized Markdown Serializer                                          │
     └─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Phased Implementation Roadmap

### Phase 1: High-Impact Quick Wins (Implemented ✅)
- [x] **Fix Paragraph Markdown Distillation:** Updated `src/distiller/markdown.ts` so `tag === 'p'` traverses child nodes, preserving inline `[links](url)`, `**bold**`, `*italic*`, and `<code>`.
- [x] **Resolve Selector Collisions:** Updated `src/distiller/semantic-tree.ts` to generate unambiguous, unique selectors using IDs, names, test-ids, aria attributes, or indexed nth-of-type matching with verified single-element match.
- [x] **Transparent MCP Engine Flag:** Added an `--engine` option (`native` vs `chrome` vs `auto`) in `src/mcp/server.ts` and CLI, with `NativeEngineAdapter` backed by pure TS zero-graphics engine.
- [x] **Basic Visibility Filter:** Prunes elements marked with `aria-hidden="true"`, `hidden`, `type="hidden"`, or inline `display: none` / `visibility: hidden` (and hidden ancestors) in `semantic-tree.ts`.

### Phase 2: Agent Interaction Core (Implemented ✅)
- [x] **State Diffing (`memora_diff`):** Implemented snapshot comparison in `src/distiller/diff.ts` returning added, removed, and mutated interactive elements between sequential steps with LLM-condensed summaries.
- [x] **Compound Form Filling:** Introduced `memora_fill_form` tool in MCP, CDP, and `MemoraPage` / `ChromeEngine` for atomic multi-field form population and submission.
- [x] **Session Vault:** Implemented `saveSession()` and `loadSession()` in `src/engine/session.ts` with JSON schema validation across both native and Chrome engines.
- [x] **Scoped Distillation:** Added `focusSelector` and `excludeSelectors` parameters to `getSemanticSnapshot` and `convertToMarkdown`.

### Phase 3: Engine Hardening & Modern Standards (Implemented ✅)
- [x] **Native ES Module Support (`<script type="module">`):** Implemented in-memory `esbuild` virtual bundler pipeline (`src/runtime/esm-bundler.ts`). Bundles both inline and external module dependency graphs, resolves relative/absolute URLs and `<script type="importmap">`, and executes safely inside `node:vm` async IIFEs without requiring `--experimental-vm-modules` process flags or worker IPC hacks.
- [x] **Full CDP WebSocket & REST Methods (`Memora.*`):** Wired `Memora.diff`, `Memora.fillForm`, `Memora.saveSession`, `Memora.loadSession` over WebSocket CDP and added `/memora/diff`, `/memora/fill-form`, `/memora/session` REST endpoints for non-MCP Playwright/Python clients.
- [x] **Official Agent Framework Adapters:** Provided first-class 1-line connection helpers for **Browser-Use**, **Stagehand**, and **LangChain** in both TypeScript (`MemoraAgent`, `createMemoraLangChainTools`) and Python (`python/memora`).
- [x] **Multi-Step & Multi-Type Form Filling:** Extended `fillForm` to support multi-step wizards atomically via `steps: [...]` as well as sequential turn-based execution, supporting checkboxes, radios, select dropdowns, textareas, and rich contenteditable fields.

---

*Authored for the Memora Engineering Repository. For questions or discussions, submit an issue or open an RFC on the project tracker.*

