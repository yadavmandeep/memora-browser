# 🪐 ORBIS BY MEMORA
### *The Web, Working for You.*
> **An Agentic Browser. Built for Autonomous Intelligence.**  
> *Explore. Understand. Execute.*

---

## 🏛️ 1. Brand Hierarchy & Product Naming Structure

The product ecosystem is organized into a clean, enterprise-grade brand hierarchy:

```
                            ┌────────────────────────────────────────┐
                            │           MEMORA (Parent)              │
                            │      Foundational AI Organization      │
                            │         (https://memora.company)       │
                            └───────────────────┬────────────────────┘
                                                │
                                                ▼
                            ┌────────────────────────────────────────┐
                            │               MEMORA AI                │
                            │      Unified Agentic AI Platform       │
                            └───────────────────┬────────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
    ┌─────────────────────────────────┐                   ┌──────────────────────────────────┐
    │       ORBIS (The Browser)       │                   │    ORBIS AGENT (Autonomous)     │
    │  Next-Gen Agentic Web Interface │                   │ Built-in Autonomous Task Runner  │
    │    (orbis.memora.company)       │                   │      (explore, act, diff)        │
    └────────────────┬────────────────┘                   └──────────────────────────────────┘
                     │
                     ▼
    ┌────────────────────────────────────────────────────────────────────────┐
    │                     MEMORA BROWSER ENGINE (MBE)                        │
    │         Ultra-Lightweight, Zero-GPU, <15ms Native Execution Core       │
    │         Semantic AXTree Distiller • V8 Sandbox • Anti-Detect TLS       │
    └────────────────────────────────────────────────────────────────────────┘
```

### Brand Entity Definitions

| Entity | Public Name | Purpose & Positioning |
| :--- | :--- | :--- |
| **Parent Company** | **Memora** | The company, corporate umbrella, and legal owner (`https://memora.company`). |
| **AI Platform** | **Memora AI** | The central ecosystem hosting models, embeddings, session vaults, and APIs. |
| **The Browser** | **Orbis** | The consumer- and agent-facing browser (`https://orbis.memora.company`). Distinctive, Latin root for *The Sphere / The World*. |
| **The Core Engine** | **Memora Browser Engine (MBE)** | The underlying high-performance, zero-graphics execution engine (analogous to *WebKit* or *Blink*). Packaged as `memora-browser`. |
| **The Autonomous Agent**| **Orbis Agent** | The intelligent agent built into the browser that explores, understands, and executes tasks. |

---

## 🛡️ 2. Closed-Source Code Protection Strategy

To preserve company intellectual property and prevent unauthorized cloning or forking:

### A. Private Repository Model
* The core source repository remains **100% Private** (`memora-company/memora-browser`).
* Source TypeScript (`src/**/*.ts`), parser internals, stealth evasions, and architectural algorithms are never published publicly.

### B. Minified & Obfuscated Distribution (NPM / Artifacts)
* Public releases do not contain readable code:
  1. **Tree-Shaken & Minified Bundle:** Code is bundled via `esbuild` with aggressive mangling and variable compression.
  2. **Bytecode / Native Packaging:** Packaged into standalone platform binaries using Node.js SEA (Single Executable Applications) or `pkg`:
     - `orbis-win-x64.exe` / `memora-win-x64.exe`
     - `orbis-macos-arm64` / `memora-macos-arm64`
     - `orbis-linux-x64` / `memora-linux-x64`
  3. End users interact with the compiled CLI or binary without ever having access to original source files.

---

## 🔑 3. Cloud-Metered Local Execution (Quota & Kill-Switch)

Even when Orbis runs locally on a user’s laptop or private server (consuming $0 server infrastructure cost), **execution is gated through the central Memora License Server**.

```mermaid
sequenceDiagram
    autonumber
    actor User as User / AI Agent
    participant LocalOrbis as Orbis Local Engine
    participant Gate as License & Quota Gate
    participant CloudAuth as Memora Cloud Auth (api.memora.company)
    participant CloudDB as License DB (Supabase / Postgres)

    User->>LocalOrbis: Launch Orbis (`--key orb_live_...`)
    LocalOrbis->>Gate: Initialize Engine
    Gate->>CloudAuth: POST /v1/license/verify { apiKey, clientVersion, hardwareId }
    CloudAuth->>CloudDB: Query account status, tier, & remaining actions
    
    alt Status: Active & Quota Available (e.g. 850/1000 actions left)
        CloudDB-->>CloudAuth: Approved (Plan: Pro, Remaining: 850)
        CloudAuth-->>Gate: 200 OK + Signed JWT Token
        Gate-->>LocalOrbis: Unlock Navigation & CDP
        LocalOrbis-->>User: 🪐 Orbis Ready (850 actions remaining)
    else Status: Suspended / Revoked (Remote Kill-Switch)
        CloudDB-->>CloudAuth: Banned / Terminated
        CloudAuth-->>Gate: 403 Forbidden
        Gate-->>LocalOrbis: Halt Engine Execution
        LocalOrbis-->>User: ❌ Error: Account suspended. Contact support@memora.company
    else Status: Quota Exhausted (0/1000 actions left)
        CloudDB-->>CloudAuth: Quota Expired
        CloudAuth-->>Gate: 402 Payment Required
        Gate-->>LocalOrbis: Lock Navigations
        LocalOrbis-->>User: ❌ Monthly Quota Exceeded. Upgrade at memora.company/pricing
    else Status: Deprecated Client Version (Force Update)
        CloudAuth-->>Gate: 426 Upgrade Required
        Gate-->>LocalOrbis: Halt Engine
        LocalOrbis-->>User: ⚠️ Orbis v1.0 is deprecated. Run 'orbis update' to install v1.2
    end
```

### Key Advantages of This Model:
1. **Zero Cloud Infrastructure Cost:** The heavy computing (DOM parsing, JavaScript V8 execution, network fetching) runs on the user's local hardware. Your cloud server only validates a tiny ~1KB authentication payload.
2. **Instant Kill-Switch:** If a user cancels subscription, abuses scraping policies, or breaches terms of service, revoking their API key from your admin dashboard disables their local engine within seconds.
3. **Usage-Based Monetization:** Allows offering tiered pricing:
   - **Free Developer:** 100 actions / month (Evaluation & hobbyists).
   - **Pro Agent:** 10,000 actions / month ($29/mo).
   - **Enterprise Scale:** Custom quotas, high concurrency, dedicated support.

---

## ☁️ 4. Local vs. Cloud Tier Feature Matrix

| Feature | Orbis Local (Free / Metered) | Orbis Cloud (Managed Enterprise) |
| :--- | :---: | :---: |
| **Runtime Environment** | User's Local Machine / Server | Zero-Install Cloud Fleet (`wss://cloud.memora.company`) |
| **Engine Startup** | < 15ms Native Core | Instant WebSocket Tunnel |
| **API Key & Quota Gate** | ✅ Enforced via Heartbeat | ✅ Managed Cloud Billing |
| **Semantic AXTree Distiller** | ✅ Standard Action Map (`@1`, `@2`) | ✅ Standard + Vision Multimodal |
| **Proxy Infrastructure** | User provides own proxies | ✅ **Built-in Residential Proxies** (No IP bans) |
| **CAPTCHA / Cloudflare Bypasser**| Basic stealth profiles | ✅ **Automated Turnstile / hCaptcha Solver** |
| **Session Persistence** | Local JSON file vaults | ✅ **Global Cloud Vault** (Sync across servers) |
| **Live Visual Inspector** | Local CDP DevTools inspector | ✅ **Shareable Web URL** (Watch live agent stream) |
| **Concurrency Scaling** | Limited by local RAM / CPU | ✅ **1,000+ Concurrent Tabs** (Auto-scaled) |

---

## 🔎 5. Pre-Launch Due Diligence Checklist

Before announcing publicly or registering official assets, complete the following brand and legal verifications:

### 1. Domain Targets
- [ ] **Primary Domains:**
  - `orbis.memora.company` (Primary Web & Product Portal)
  - `memora.company` (Main Organization & Platform Home)
  - `cloud.memora.company` (Managed Cloud Fleet & Vault)
  - `api.memora.company` (License & Agent Coordination API)

### 2. Package Registry Namespaces
- [ ] **NPM Registry:**
  - Search for `orbis-browser`, `@memora/orbis`, `memora-browser`.
  - Claim organization scope: `@memora` on npmjs.com.
- [ ] **PyPI (Python Package Index):**
  - Search for `orbis-browser`, `memora-browser`.
- [ ] **Docker Hub / GHCR:**
  - Claim `ghcr.io/memora-company/memora-browser` or `ghcr.io/memora/orbis`.

### 3. Trademark & Brand Protection
- [ ] **USPTO & WIPO Trademark Search:**
  - Nice Classification **Class 9** (Downloadable computer software, web browsers) and **Class 42** (SaaS, cloud computing services).
  - Search terms: *"Orbis Browser"*, *"Orbis Agent"*, *"Orbis by Memora"*.
  - *Note:* "Orbis by Memora" provides exceptional distinctiveness and defensibility.
- [ ] **GitHub Namespace:**
  - Repository remains `memora-company/memora-browser`.

---

## 📋 6. Summary: The Orbis Vision

```
      "Orbis is not just another browser for humans to click links.
       Orbis is the browser built from the ground up for AI agents.
       It does not render pixels—it distills meaning.
       It does not wait for humans—it executes for intelligence."
```

*Status: Approved for Architecture & Product Realization.*
