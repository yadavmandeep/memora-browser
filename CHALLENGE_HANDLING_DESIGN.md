# Challenge Detection & Human Handoff — Design

Status: Phases 1–3 implemented (detector, report output, per-host cooldown, `--challenge-cooldown`, `--on-challenge report|stop`, `ChallengeDetectedError`, CDP error mapping, `memora_handoff` + `HumanHandoff` + `--handoff-timeout`; tests in `tests/test-challenge.ts`). Docs (Phase 4) pending.

Deviations from the original proposal, as built:
- There is no `--on-challenge handoff` value. MCP challenge output (and stop-mode errors) always end with a hint to call `memora_handoff`; a separate mode added nothing.
- The input lock is structural: the handoff window is not reachable by agent tools until the check is cleared and `take()` hands it over, so there is no `HandoffInProgressError`.
- `OrbisAgent.requestHandoff()` is not built: `OrbisAgent` drives the native page, which cannot adopt a Chrome window. SDK users get the exported `HumanHandoff` class instead.
- The handoff window does not pin the Chrome 130 UA that headless mode uses; it keeps the installed Chrome's own UA (156 on the dev machine), because a mismatched UA makes checks fail for the person. Scope: `memora-browser` (Orbis) 0.1.x.

## 1. Goal and non-goals

**Goal.** When a site answers with a CAPTCHA, a bot-management interstitial, a WAF block or a rate limit, Orbis should:

1. recognise it and say so in a structured way, instead of returning the challenge page as if it were content;
2. stop, back off, or hand the session to a human who solves it in a real Chrome window, then let the agent continue in that same window.

**Non-goals (deliberately out of scope).**

- Automated solving of any kind: solver-farm APIs, token injection, audio-to-text, vision-model clicking, synthetic mouse paths.
- Evasion: rotating proxies or identities after a challenge, spoofing fingerprints to avoid one, replaying clearance cookies in a different client.

This matches the existing published stance in `orbis/docs/stealth.md` ("treat it as a no") and keeps website claims truthful.

## 2. Current state (verified in code)

| Area | Fact | Impact on this design |
|---|---|---|
| Native navigation | `MemoraPage.goto` (`src/engine/page.ts:287`) keeps `lastStatus` only; response headers are discarded. | Must keep headers of the final response (`lastHeaders`). |
| Native script runtime | Challenge pages need APIs the sandbox lacks (`orbis/docs/stealth.md:112`). They run until the navigation timeout and never complete. | Detect on the raw response **before** running page scripts and skip script execution for blocking interstitials. |
| Native cookie jar | `NetworkFetcher.cookies` is a flat `name → value` map, no domain/path/expiry (`src/network/fetcher.ts:27`). | Cookies cannot be faithfully moved between engines. After a handoff the session stays in Chrome. |
| Chrome engine | Always `headless: true` (`src/engine/chrome-engine.ts:61`). | Add a `headless` option so a visible window can be opened for the human. |
| MCP server | Engine is fixed at construction (`src/mcp/server.ts:34`). Tool errors are returned as text. | Allow swapping the active engine to the handoff Chrome instance; add structured challenge output. |

## 3. Detector

### 3.1 Module

`src/challenge/detector.ts` — a pure function with no I/O, so both engines and tests share it.

```ts
export type ChallengeKind =
  | 'interstitial'   // whole page is a challenge (e.g. "Just a moment...")
  | 'captcha'        // interactive widget the user must solve to proceed
  | 'passive'        // score-only / invisible script present; page is usable
  | 'blocked'        // WAF/bot-manager denial with no challenge offered
  | 'rate_limited';  // 429 or vendor rate-limit page

export type ChallengeVendor =
  | 'cloudflare' | 'turnstile' | 'recaptcha' | 'hcaptcha' | 'aws-waf'
  | 'datadome' | 'perimeterx' | 'akamai' | 'imperva' | 'arkose' | 'geetest'
  | 'unknown';

export interface ChallengeSignal {
  kind: ChallengeKind;
  vendor: ChallengeVendor;
  blocking: boolean;          // true => page content is not the real page
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];         // e.g. ['header cf-mitigated=challenge', 'title "Just a moment..."']
  retryAfterSec?: number;     // from Retry-After when present
}

export interface DetectInput {
  url: string;
  status: number;
  headers: Record<string, string>; // lower-cased keys
  html: string;                    // raw body (native) or page.content() (chrome)
}

export function detectChallenge(input: DetectInput): ChallengeSignal | null;
```

### 3.2 Signals

The detector combines three signal classes, strongest first: response headers, then HTTP status, then markup (script `src` hosts, container classes, `<title>`). One weak markup hit alone never produces `blocking: true`.

| Vendor | Header / status signals | Markup signals | Default kind |
|---|---|---|---|
| Cloudflare challenge | `cf-mitigated: challenge`; `server: cloudflare` with 403/503 | `_cf_chl_opt`, `/cdn-cgi/challenge-platform/`, title "Just a moment..." | interstitial |
| Turnstile | — | script from `challenges.cloudflare.com/turnstile`, `.cf-turnstile` | captcha (embedded) |
| reCAPTCHA v2 | — | `recaptcha/api.js` (google.com or recaptcha.net), `.g-recaptcha` with `data-sitekey` | captcha (embedded) |
| reCAPTCHA v3 | — | `recaptcha/api.js?render=<key>`, no `.g-recaptcha` | passive |
| hCaptcha | — | `js.hcaptcha.com`, `.h-captcha` | captcha (embedded) |
| AWS WAF | `x-amzn-waf-action: captcha \| challenge`; 405 (captcha) / 202 (challenge) | `awswaf` challenge script | interstitial |
| DataDome | `x-datadome` / `x-dd-b` headers; 403 | `geo.captcha-delivery.com` | interstitial |
| HUMAN / PerimeterX | 403 | `#px-captcha`, `captcha.px-cdn.net`, `_pxAppId` | interstitial |
| Imperva | — | `_Incapsula_Resource`, "Incapsula incident ID" | blocked / interstitial |
| Akamai | 403 | "Access Denied" + "Reference #" | blocked |
| Arkose | — | `client-api.arkoselabs.com`, `funcaptcha` | captcha |
| GeeTest | — | `static.geetest.com`, `gt.js` | captcha |
| Any | 429, `Retry-After` | — | rate_limited |

Every row has to be confirmed against a saved fixture before it ships (see §6). The table records my current knowledge and has not been measured. Vendors change markup, so signatures live in one data table (`src/challenge/signatures.ts`) and are not spread through the code.

### 3.3 Embedded vs blocking

The important distinction for agents:

- **Blocking** (`interstitial`, `blocked`, `rate_limited`): the page content is not the real page. The snapshot or markdown must not be shown to the agent as content.
- **Embedded** (`captcha` inside a login/signup/contact form): the page is real and readable. Only the protected *submit* will fail. Report it on browse, and warn again on `fill_form` / `act` that targets that form.
- **Passive** (reCAPTCHA v3, invisible Turnstile): informational only. Many sites load v3 on every page, so treating it as an error would cause constant false positives.

### 3.4 Engine integration

- **Native.** `page.ts` stores `lastHeaders`. `goto` calls `detectChallenge` on the raw response **before** `loadDocumentWithScripts`. If the result is blocking, the page skips script execution, parses the HTML for display only, and records `page.lastChallenge`. This saves the full navigation timeout that the sandbox currently spends on scripts that cannot finish.
- **Chrome.** After `page.goto`, `detectChallenge({ status, headers: await resp.allHeaders(), html: await page.content() })`.
- Both adapters expose `getChallenge(): ChallengeSignal | null`. This becomes an optional method on `IMemoraEngine`.

### 3.5 Policy: `--on-challenge`

New `NetworkOptions.onChallenge: 'report' | 'stop' | 'handoff'` (CLI `--on-challenge`, default `report`).

| Mode | Behaviour |
|---|---|
| `report` (default) | Return normally and attach the challenge signal. MCP output starts with a `CHALLENGE` block (below). No retries. |
| `stop` | Throw `ChallengeDetectedError` (carries the signal) on blocking challenges. Intended for scripts and CI. |
| `handoff` | Same as `report`, and the agent is told it may call `memora_handoff`. |

In every mode, after a blocking challenge or a 429 on a host, the host goes into a **cooldown** (default 60s, or `Retry-After`). During cooldown, navigations to that host fail fast with the stored signal instead of sending new requests. Nothing rotates proxies or identities.

MCP `memora_browse` output when blocked:

```
# CHALLENGE DETECTED — page content not available
Vendor: cloudflare | Kind: interstitial | Confidence: high
Evidence: header cf-mitigated=challenge; title "Just a moment..."
URL: https://example.com/ [HTTP 403]
Next steps: stop, try again after cooldown (60s), or call memora_handoff so a human can complete it.
```

## 4. Human handoff

### 4.1 Flow

```
agent: memora_browse(url)  ──► CHALLENGE (blocking)
agent: memora_handoff({ action: 'start' })
        │  launch Chrome with headless:false (separate ChromeEngine instance)
        │  goto the challenged URL
        │  print to stderr + return: "A Chrome window is open. Complete the check there."
        ▼
agent: memora_handoff({ action: 'status' })   (poll, non-blocking)
        │  re-run detectChallenge on the visible page
        │  pending  → { state: 'waiting', elapsedSec }
        │  cleared  → { state: 'resolved' }  and the MCP server switches its active engine to this Chrome instance
        │  timeout  → { state: 'expired' }   window closed, original engine kept
        ▼
agent continues with memora_browse / act / extract in the same (visible) Chrome session
```

### 4.2 Design decisions

- **Non-blocking (`start` / `status` / `cancel`)**, not a single tool call that waits minutes. MCP clients apply per-call timeouts. A long call would also stop the agent from telling its user what is happening.
- **The session stays in Chrome after resolution.** Clearance cookies from these vendors are tied to the client that earned them (IP, UA, TLS fingerprint). Copying them into the native engine would usually fail. If it worked, it would be replaying a clearance in a client that never passed the check, which is the evasion this design excludes. The flat native cookie jar also cannot represent them correctly.
- **The human does the check, and only the human.** While a handoff is `waiting`, the handoff engine rejects `act`, `fill_form`, `eval` and any input from the agent (`HandoffInProgressError`). This makes it impossible to use the handoff path for scripted clicking.
- **Single handoff at a time**, default timeout 300s, configurable with `--handoff-timeout`.
- **Requires a display.** In Docker or headless servers, `start` returns `{ state: 'unavailable', reason: 'no display' }`. A remote-view option (CDP screencast to a local page) is a possible later step, not part of this design.
- **Same network settings.** The handoff Chrome uses the same proxy and `--obey-robots` routing as the existing `ChromeEngine`, so the human solves from the same egress the agent will continue on.

### 4.3 Code changes

| File | Change |
|---|---|
| `src/challenge/detector.ts`, `signatures.ts` (new) | Detector and signature table. |
| `src/challenge/errors.ts` (new) | `ChallengeDetectedError`, `HandoffInProgressError`. |
| `src/challenge/cooldown.ts` (new) | Per-host cooldown store, shared by both engines. |
| `src/engine/page.ts` | Keep `lastHeaders`; detect before running scripts; `lastChallenge`. |
| `src/engine/native-adapter.ts` | `getChallenge()`. |
| `src/engine/chrome-engine.ts` | `headless` constructor option; detection after `goto`; `getChallenge()`; input lock while handoff is waiting. |
| `src/mcp/server.ts` | `CHALLENGE` output block; `memora_handoff` tool; engine swap on `resolved`; `--on-challenge` wiring. |
| `src/types/index.ts`, `src/cli/index.ts` | `onChallenge`, `handoffTimeoutSec` options and flags. |
| `src/adapters/agent.ts` | `OrbisAgent` surfaces `challenge` on results and exposes `requestHandoff()`. |
| `orbis/docs/stealth.md`, `limitations.md`, `mcp.md` | Document detection, cooldown and handoff. Existing "doesn't solve CAPTCHAs" wording stays true. |

## 5. SDK surface

```ts
const page = browser.newPage();
const res = await page.goto(url);
const ch = page.challenge();            // ChallengeSignal | null
if (ch?.blocking) { /* stop, back off, or hand off */ }

// strict mode
const browser = new OrbisBrowser({ network: { onChallenge: 'stop' } });
try { await page.goto(url); }
catch (e) { if (e instanceof ChallengeDetectedError) console.log(e.signal); }
```

## 6. Testing

- **Fixtures, not live sites.** `tests/fixtures/challenges/*.json` contains `{ status, headers, html }` per vendor and kind, captured once by hand with a normal browser and trimmed to the signal-bearing parts. CI never sends traffic to third-party protected sites.
- **Negative fixtures matter as much.** Pages that load reCAPTCHA v3 on every route, blog posts that *mention* Cloudflare, and normal 403s from an app's own auth must not produce `blocking: true`.
- **Embedded widgets end-to-end** on a local test server, using the vendors' published test site keys (reCAPTCHA's always-pass test key, hCaptcha's `10000000-ffff-…` test key, Turnstile's `1x00000000000000000000AA` test keys). This also gives customers a documented way to test their own CAPTCHA-protected flows.
- **Handoff** test with a local page that shows a "challenge" until a button is clicked by hand. The automated part covers the state machine (`waiting → resolved / expired / cancelled`) and the input lock.
- **Measure before claiming.** Before any website or docs claim, record a precision/recall number for the detector on the fixture set (per `orbis-website-source-of-truth`).

## 7. Rollout

1. Detector + `report` mode + cooldown (native and Chrome). Lowest risk, and fixes agents silently scraping challenge pages.
2. `stop` mode + SDK errors.
3. `memora_handoff` + headed Chrome + engine swap.
4. Docs and website update with measured detector numbers.

## 8. Open questions

- Default `--on-challenge` for the MCP server: `report` (proposed) or `handoff` when a display is available?
- Should cooldown persist across process restarts (file next to session JSON), or stay in memory only (proposed)?
- Later: Web Bot Auth / signed-agent identity so that site owners can allow Orbis explicitly. That is a separate design.
