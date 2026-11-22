#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { OrbisBrowser } from '../engine/browser.js';
import { NetworkOptions } from '../types/index.js';
import { redactProxyUrl, validateProxyUrl } from '../network/proxy.js';
import { renderOrbisBanner } from './banner.js';
import { formatChallenge } from '../challenge/detector.js';
import { PromptFirewall } from '../firewall/firewall.js';
import { CAPABILITIES, Capability, FirewallPolicyInput, isPreset, loadPolicyFile, resolvePolicy } from '../firewall/policy.js';
import { verifyAuditLog } from '../firewall/audit.js';
import { ORBIS_VERSION } from '../version.js';

// Show deprecation warning when legacy binary name is invoked
if (process.argv[1] && (process.argv[1].endsWith('memora-browser') || process.argv[1].endsWith('memora-browser.js'))) {
  console.warn('⚠️  [DEPRECATION WARNING] The "memora-browser" CLI alias is deprecated and will be removed in v2.0. Please use "orbis" or "memora-orbis".\n');
}

const program = new Command();
// Options after a subcommand belong to it (serve --port 9333 must not hit the root command)
program.enablePositionalOptions();

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

// Network flags shared by every command
function addNetworkOptions(cmd: Command): Command {
  return cmd
    .option('--http-proxy <url>', '[Orbis Cloud — Coming Soon] Managed residential proxy network (https://orbis.memora.company/cloud)')
    .option('--proxy-bearer-token <token>', '[Orbis Cloud — Coming Soon] Proxy bearer authentication')
    .option('--proxy-bypass <hosts>', 'Comma-separated hosts that skip the proxy (e.g. localhost,.internal.corp)')
    .option('--use-env-proxy', 'Use HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY when --http-proxy is not set')
    .option('--http-header <header>', 'Extra "Name: Value" header for every request (repeatable)', collect, [])
    .option('--user-agent <ua>', 'Override the User-Agent header')
    .option('--http-timeout <ms>', 'Navigation request timeout in milliseconds')
    .option('--insecure-disable-tls-host-verification', 'Skip TLS certificate verification (self-signed / MITM proxies)')
    .option('--obey-robots', 'Fetch robots.txt for every origin and block requests it disallows (RFC 9309)')
    .option('--robots-agent <token>', 'Product token matched against robots.txt User-agent lines (default: MemoraBrowser)')
    .option('--on-challenge <mode>', 'On a CAPTCHA/bot challenge or 429: "report" (default, load it and flag it) or "stop" (fail the navigation)')
    .option('--challenge-cooldown <sec>', 'Pause requests to a host for this long after a CAPTCHA/bot challenge or 429 (default: 60, 0 disables; Retry-After wins)')
    .option('--allow-domain <pattern>', 'Firewall: only navigate to hosts matching this pattern (repeatable; "example.com" includes subdomains, "*.example.com" only subdomains, "example.com/app" a path prefix)', collect, [])
    .option('--block-domain <pattern>', 'Firewall: refuse every request to hosts matching this pattern (repeatable)', collect, [])
    .option('--block-sensitive-domains', 'Firewall: refuse navigation to email, banking/payments, identity, cloud consoles, admin paths and cloud metadata endpoints')
    .option('--low-memory', 'Enable aggressive RAM reduction flags (caps V8 heap, disables GPU & background codecs)')
    .option('--block-media', 'Block heavy media, video, and fonts to reduce RAM usage by up to 60%')
    .option('--block-images', 'Block image downloads and image texture decoding')
    .option('--strip-mode <mode>', 'Asset stripping mode: none, invisible (strips stylesheets, SVGs, hidden nodes), or all')
    .option('--eco', 'Preset: Ultra-low RAM mode (~20MB RAM, blocks media/images, strips CSS)')
    .option('--agent', 'Preset: Smart Agent mode (low RAM, adaptive Chrome/Native)')
    .option('--secure', 'Preset: Military-grade security (strict firewall, private IP blocking)');
}

function addFirewallOptions(cmd: Command): Command {
  return cmd
    .option('--firewall <preset>', 'Prompt-injection firewall: off (default), standard or strict')
    .option('--firewall-policy <file>', 'Firewall settings from a JSON file (guide: docs/prompt-injection-firewall.md in the Orbis repo); flags override it')
    .option('--firewall-mode <mode>', 'Firewall: enforce (default) or monitor (log decisions, block nothing)')
    .option('--firewall-allow <capability>', `Firewall: let this capability run without asking (repeatable: ${CAPABILITIES.join(', ')})`, collect, [])
    .option('--firewall-confirm <capability>', 'Firewall: ask the user before this capability runs (repeatable)', collect, [])
    .option('--firewall-deny <capability>', 'Firewall: always refuse this capability (repeatable)', collect, [])
    .option('--audit-log <file>', 'Firewall: append the hash-chained audit log to this JSONL file (sign it by setting ORBIS_AUDIT_KEY)')
    .option('--confirm-timeout <sec>', 'MCP: seconds to wait for the user to answer a firewall confirmation (default: 120)');
}

// Policy from --firewall-policy, --firewall and the per-capability / domain / audit flags, or null when none is set
function buildPolicyInput(opts: any, network: NetworkOptions): FirewallPolicyInput | null {
  const capFlags: Array<[string, 'allow' | 'confirm' | 'deny']> = [['firewallAllow', 'allow'], ['firewallConfirm', 'confirm'], ['firewallDeny', 'deny']];
  const anyFlag = opts.firewall !== undefined || opts.firewallPolicy || opts.firewallMode || opts.auditLog
    || capFlags.some(([k]) => (opts[k] || []).length);
  if (!anyFlag) return null;
  const input: FirewallPolicyInput = opts.firewallPolicy ? loadPolicyFile(opts.firewallPolicy) : {};
  if (opts.firewall !== undefined) {
    if (!isPreset(opts.firewall)) throw new Error(`Invalid --firewall "${opts.firewall}": use off, standard or strict`);
    input.preset = opts.firewall;
  }
  if (opts.firewallMode !== undefined) {
    if (opts.firewallMode !== 'enforce' && opts.firewallMode !== 'monitor') throw new Error(`Invalid --firewall-mode "${opts.firewallMode}": use enforce or monitor`);
    input.mode = opts.firewallMode;
  }
  for (const [key, verdict] of capFlags) {
    for (const cap of opts[key] || []) {
      if (!CAPABILITIES.includes(cap)) throw new Error(`Unknown capability "${cap}": use ${CAPABILITIES.join(', ')}`);
      input.actions = { ...(input.actions || {}), [cap as Capability]: verdict };
    }
  }
  // Domain flags join the policy's own lists so `memora_firewall status` shows the full rule set
  const dp = network.domainPolicy;
  if (dp) {
    input.domains = {
      ...(input.domains || {}),
      allow: [...(input.domains?.allow || []), ...(dp.allow || [])],
      block: [...(input.domains?.block || []), ...(dp.block || [])],
      ...(dp.blockSensitive ? { blockSensitive: true } : {}),
    };
  }
  if (opts.auditLog) input.audit = { ...(input.audit || {}), path: opts.auditLog };
  return input;
}

function buildFirewall(opts: any, network: NetworkOptions): PromptFirewall | null {
  const input = buildPolicyInput(opts, network);
  return input ? new PromptFirewall(input) : null;
}

function parseNetworkOptions(opts: any): NetworkOptions {
  const network: NetworkOptions = {};
  const proxy = opts.httpProxy;
  if (proxy) {
    validateProxyUrl(proxy);
    network.proxy = proxy;
    console.warn('\nℹ️  [ORBIS CLOUD] Managed Residential Proxy Network is an Orbis Cloud feature (Coming Soon).\n    👉 Join the cloud proxy waitlist at: https://orbis.memora.company/cloud\n');
  }
  if (opts.proxyBearerToken) network.proxyBearerToken = opts.proxyBearerToken;
  if (opts.proxyBypass) network.noProxy = opts.proxyBypass.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (opts.useEnvProxy) network.useEnvProxy = true;
  if (opts.userAgent) network.userAgent = opts.userAgent;
  if (opts.httpTimeout) network.timeoutMs = parseInt(opts.httpTimeout, 10);
  if (opts.insecureDisableTlsHostVerification) network.insecureTls = true;
  if (opts.obeyRobots) network.obeyRobots = true;
  if (opts.onChallenge !== undefined) {
    if (opts.onChallenge !== 'report' && opts.onChallenge !== 'stop') throw new Error(`Invalid --on-challenge "${opts.onChallenge}": use "report" or "stop"`);
    network.onChallenge = opts.onChallenge;
  }
  if (opts.challengeCooldown !== undefined) {
    const sec = Number(opts.challengeCooldown);
    if (!Number.isInteger(sec) || sec < 0) throw new Error(`Invalid --challenge-cooldown "${opts.challengeCooldown}": expected a whole number of seconds >= 0`);
    network.challengeCooldownSec = sec;
  }
  if (opts.lowMemory) network.lowMemory = true;
  if (opts.blockMedia) network.blockMedia = true;
  if (opts.blockImages) network.blockImages = true;
  if (opts.eco) {
    network.lowMemory = true;
    network.blockMedia = true;
    network.blockImages = true;
    network.stripMode = 'invisible';
  }
  if (opts.agent) {
    network.lowMemory = true;
  }
  if (opts.secure) {
    network.domainPolicy = network.domainPolicy || { allow: [], block: [], blockSensitive: true };
  }
  if (opts.stripMode) {
    if (opts.stripMode !== 'none' && opts.stripMode !== 'invisible' && opts.stripMode !== 'all') {
      throw new Error(`Invalid --strip-mode "${opts.stripMode}": use "none", "invisible", or "all"`);
    }
    network.stripMode = opts.stripMode;
  }
  const allowDomains: string[] = opts.allowDomain || [];
  const blockDomains: string[] = opts.blockDomain || [];
  if (allowDomains.length || blockDomains.length || opts.blockSensitiveDomains) {
    network.domainPolicy = { allow: allowDomains, block: blockDomains, blockSensitive: !!opts.blockSensitiveDomains };
  }
  if (opts.robotsAgent) {
    if (!/^[A-Za-z_-]+$/.test(opts.robotsAgent)) throw new Error(`Invalid --robots-agent "${opts.robotsAgent}": use letters, "_" and "-" only (RFC 9309)`);
    network.robotsAgent = opts.robotsAgent;
  }
  const headers: string[] = opts.httpHeader || [];
  if (headers.length) {
    network.headers = {};
    for (const h of headers) {
      const idx = h.indexOf(':');
      if (idx <= 0) throw new Error(`Invalid --http-header "${h}", expected "Name: Value"`);
      network.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
  }
  return network;
}

function describeProxy(network: NetworkOptions): string {
  if (network.proxy) {
    return redactProxyUrl(network.proxy) + (network.proxyBearerToken ? ' (bearer auth)' : '');
  }
  return 'Direct • Cloud Proxies: orbis.memora.company/cloud';
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// Asynchronous non-blocking version and advisory check
async function checkOrbisVersion(): Promise<void> {
  if (process.env.ORBIS_NO_TELEMETRY || process.env.NODE_ENV === 'test') return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`https://orbis.memora.company/api/v1/version-check?v=${encodeURIComponent(ORBIS_VERSION)}`, {
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);
    if (res && res.ok) {
      const data: any = await res.json().catch(() => null);
      if (data?.deprecated) {
        console.warn(`\n⚠️  [ORBIS ADVISORY] ${data.message || 'This version is deprecated. Please upgrade to the latest release.'}\n`);
      } else if (data?.latest && data.latest !== ORBIS_VERSION) {
        // stderr: stdout carries the MCP JSON-RPC stream
        console.error(`\n✨ [UPDATE AVAILABLE] Orbis v${data.latest} is available! (Current: v${ORBIS_VERSION}). Run: npm i -g @memoracompany/memora-orbis\n`);
      }
    }
  } catch {
    // Fail silently so execution is never blocked
  }
}

async function runServer(options: any): Promise<void> {
  checkOrbisVersion().catch(() => {});

  let network: NetworkOptions;
  let firewall: PromptFirewall | null;
  try {
    network = parseNetworkOptions(options);
    firewall = buildFirewall(options, network);
  } catch (e: any) {
    fail(e.message);
  }
  if (firewall?.enabled) process.stderr.write(`[Orbis] ${firewall.describe().split('\n')[0]}${firewall.audit.path ? ` | audit log: ${firewall.audit.path}` : ''}\n`);

  // MCP stdio mode for AI Coding Assistants (Cursor, Claude Desktop, Antigravity, Windsurf)
  if (options.mcp) {
    const { MCPServer } = await import('../mcp/server.js');
    let handoffTimeoutSec: number | undefined;
    if (options.handoffTimeout !== undefined) {
      handoffTimeoutSec = Number(options.handoffTimeout);
      if (!Number.isInteger(handoffTimeoutSec) || handoffTimeoutSec < 10) fail(`Invalid --handoff-timeout "${options.handoffTimeout}": expected whole seconds >= 10`);
    }
    let confirmTimeoutSec: number | undefined;
    if (options.confirmTimeout !== undefined) {
      confirmTimeoutSec = Number(options.confirmTimeout);
      if (!Number.isInteger(confirmTimeoutSec) || confirmTimeoutSec < 5) fail(`Invalid --confirm-timeout "${options.confirmTimeout}": expected whole seconds >= 5`);
    }
    const mcp = new MCPServer(network, options.engine || 'auto', { handoffTimeoutSec, confirmTimeoutSec, firewall: firewall ?? undefined });
    mcp.start();
    return;
  }

  // CDP / WebDriver / --eval: the firewall's domain rules apply in the network layer. Action gates and
  // content isolation need an agent-facing layer (MCP server or OrbisAgent SDK).
  if (firewall?.enabled) {
    network = firewall.applyToNetwork({ ...network, domainPolicy: undefined });
    process.stderr.write('[Orbis] Firewall domain rules are enforced for this server; action gates and content isolation apply to MCP (--mcp) and the OrbisAgent SDK only.\n');
  }

  const port = parseInt(options.port, 10);
  const host = options.host;
  const stealth = options.stealth !== false;
  const protocol = String(options.protocol || 'cdp').toLowerCase();

  if (protocol === 'webdriver') {
    const { WebDriverServer } = await import('../webdriver/server.js');
    let sessionIdleTimeoutMs: number | undefined;
    if (options.sessionIdleTimeout !== undefined) {
      const sec = Number(options.sessionIdleTimeout);
      if (!Number.isInteger(sec) || sec < 0) fail(`Invalid --session-idle-timeout "${options.sessionIdleTimeout}": expected a whole number of seconds >= 0`);
      sessionIdleTimeoutMs = sec * 1000;
    }
    const server = new WebDriverServer({
      port,
      host,
      stealth,
      network,
      maxSessions: parseInt(options.maxSessions, 10),
      ...(sessionIdleTimeoutMs !== undefined ? { sessionIdleTimeoutMs } : {}),
      apiKey: process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY || undefined,
    });
    try {
      await server.start();
    } catch (e: any) {
      if (e.code === 'EADDRINUSE') {
        fail(`Port ${port} is already in use by another process.\n   💡 HINT: Specify another port with --port ${port + 1} or stop the conflicting service.`);
      }
      fail(`Could not start WebDriver server on ${host}:${port}: ${e.message}`);
    }
    console.log(renderOrbisBanner('webdriver', {
      host,
      port,
      stealth,
      maxSessions: options.maxSessions,
      proxy: describeProxy(network),
    }));
    const shutdown = async () => {
      await server.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (options.eco) {
    options.lowMemory = true;
    options.blockMedia = true;
    options.blockImages = true;
    options.stripMode = 'invisible';
    options.recycleAfter = options.recycleAfter || 30;
    options.maxPages = options.maxPages || 10;
    options.engine = options.engine || 'native';
  }
  if (options.agent) {
    options.lowMemory = true;
    options.recycleAfter = options.recycleAfter || 50;
    options.engine = options.engine || 'auto';
  }
  if (options.secure) {
    options.firewall = options.firewall || 'strict';
  }

  if (protocol !== 'cdp') fail(`Unknown --protocol "${protocol}". Use "cdp" or "webdriver".`);

  const maxPages = options.maxPages ? parseInt(options.maxPages, 10) : undefined;
  const recycleAfter = options.recycleAfter ? parseInt(options.recycleAfter, 10) : undefined;
  const browser = new OrbisBrowser({
    port,
    host,
    unixSocket: options.unixSocket,
    stealth,
    network,
    maxPages,
    recycleAfter,
    lowMemory: options.lowMemory,
    blockMedia: options.blockMedia,
    blockImages: options.blockImages,
    stripMode: options.stripMode
  });

  // One-shot eval mode
  if (options.eval) {
    console.log(`\n🔍 [Orbis] Fetching & Distilling: ${options.eval} ...`);
    const startTime = performance.now();
    const page = browser.newPage();
    try {
      await page.goto(options.eval);
      const challenge = page.challenge();
      if (challenge?.blocking) console.warn('\n' + formatChallenge(challenge, page.lastChallengeCooldownSec));
      const snapshot = page.getSemanticSnapshot();
      const duration = (performance.now() - startTime).toFixed(1);

      console.log(`\n✨ Successfully distilled in ${duration}ms!`);
      console.log(`📌 Title: ${snapshot.title}`);
      console.log(`🎯 Interactive Elements: ${snapshot.interactiveCount}`);
      console.log(`🧠 Estimated Prompt Tokens: ${snapshot.tokenEstimate}`);
      console.log('\n' + snapshot.actionMapText);
      console.log('\n--- Distilled Content ---');
      console.log(snapshot.markdown.slice(0, 1000) + (snapshot.markdown.length > 1000 ? '\n... [truncated]' : ''));
      if (page.lastStatus >= 400) process.exitCode = 1;
    } catch (err: any) {
      console.error('❌ Error during eval:', err.message || err);
      process.exitCode = 1;
    } finally {
      process.exit(process.exitCode ?? 0);
    }
    return;
  }

  // Server daemon mode (CDP server + ws loaded only here, so fetch/--eval start lighter)
  const { CDPServer } = await import('../cdp/server.js');
  const server = new CDPServer(browser);
  try {
    await server.start();
  } catch (e: any) {
    if (e.code === 'EADDRINUSE') {
      fail(`Port ${port} is already in use by another process.\n   💡 HINT: Specify another port with --port ${port + 1} or stop the conflicting service.`);
    }
    fail(`Could not start Orbis server on ${host}:${port}: ${e.message}`);
  }

  const memUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  console.log(renderOrbisBanner('cdp', {
    host,
    port: options.unixSocket ? `unix:${options.unixSocket}` : port,
    stealth,
    memUsage,
    proxy: describeProxy(network),
  }));

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n[Orbis] Shutting down browser server...');
    await server.stop();
    browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function addServerOptions(cmd: Command): Command {
  return addNetworkOptions(cmd
    .option('-p, --port <number>', 'CDP / WebDriver / HTTP port', '9222')
    .option('-h, --host <string>', 'Host address', 'localhost')
    .option('--unix-socket <path>', 'Serve CDP / WebDriver over a Unix domain socket or Windows named pipe instead of TCP')
    .option('--protocol <protocol>', 'Automation protocol to serve: cdp (Playwright/Puppeteer) or webdriver (Selenium)', 'cdp')
    .option('--engine <engine>', 'Engine backend: native (ultra-fast zero-graphics), chrome (system Chromium), or auto', 'auto')
    .option('--max-pages <number>', 'Maximum concurrent browser tabs/pages (default: 100)')
    .option('--recycle-after <number>', 'Auto-recycle browser context and trigger GC after N operations (0 disables)')
    .option('--max-sessions <number>', 'Maximum concurrent WebDriver sessions', '16')
    .option('--session-idle-timeout <sec>', 'WebDriver: close sessions idle for this many seconds (default: 300, 0 disables)')
    .option('--no-stealth', 'Disable anti-bot stealth emulation'));
}

addFirewallOptions(addServerOptions(program
  .name('orbis')
  .description('Orbis by Memora — The Web, Working for You. Built for Autonomous Intelligence (orbis.memora.company)')
  .version(ORBIS_VERSION))
  .addHelpText('before', () => renderOrbisBanner('help')))
  .option('--eval <url>', 'Fetch a URL, distill semantic snapshot, and output to console')
  .option('--mcp', 'Run as Model Context Protocol (MCP) server over stdio for Cursor, Claude, Antigravity')
  .option('--handoff-timeout <sec>', 'MCP: seconds a person gets to complete a CAPTCHA/bot check in the memora_handoff window (default: 300)')
  .action(runServer);

// Server command: `orbis serve --protocol webdriver`
addFirewallOptions(addServerOptions(program
  .command('serve')
  .description('Start the automation server (same as running without a command)')))
  .action(runServer);

// CDP command: `orbis cdp --port 9222 ...`
const cdpCmd = program
  .command('cdp')
  .description('Start the Chrome DevTools Protocol (CDP) server for Playwright, Puppeteer & Agents');

addFirewallOptions(addServerOptions(cdpCmd))
  .action(async (opts) => {
    opts.protocol = 'cdp';
    await runServer(opts);
  });

// WebDriver command: `orbis webdriver --port 9222 ...`
const webdriverCmd = program
  .command('webdriver')
  .description('Start the W3C WebDriver server for Selenium, Appium & WebdriverIO');

addFirewallOptions(addServerOptions(webdriverCmd))
  .action(async (opts) => {
    opts.protocol = 'webdriver';
    await runServer(opts);
  });

// MCP command: `orbis mcp`
const mcpCmd = program
  .command('mcp')
  .description('Start the Model Context Protocol (MCP) server over stdio for AI assistants')
  .option('--engine <engine>', 'Engine backend: native (ultra-fast), chrome, or auto', 'auto')
  .option('--handoff-timeout <sec>', 'Seconds for human handoff challenge resolution', '300');

addFirewallOptions(addNetworkOptions(mcpCmd))
  .action(async (opts) => {
    opts.mcp = true;
    await runServer(opts);
  });

// Firewall tools: `orbis firewall scan <url>`, `orbis firewall verify <audit.jsonl>`, `orbis firewall policy`
const firewallCmd = program
  .command('firewall')
  .description('Prompt-injection firewall tools: scan a page, verify an audit log, print the effective policy');

addNetworkOptions(firewallCmd
  .command('scan <url>')
  .description('Load a page and report prompt-injection findings (visible text, hidden markup, invisible Unicode). Exit code 2 when a high-severity finding exists.')
  .option('--json', 'Print findings as JSON')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => {
    let network: NetworkOptions;
    try {
      network = parseNetworkOptions(opts);
    } catch (e: any) {
      fail(e.message);
    }
    const browser = new OrbisBrowser({ stealth: opts.stealth !== false, network });
    const page = browser.newPage();
    let code = 0;
    try {
      await page.goto(url);
      const snap = page.getSemanticSnapshot();
      const fw = new PromptFirewall({ preset: 'standard', content: { isolate: false, sanitize: 'flag', scanHidden: true } });
      const text = [snap.title, snap.actionMapText, snap.markdown].join('\n');
      const { findings } = fw.processContent(text, { source: page.url, html: page.content() });
      if (findings.some((f) => f.severity === 'high')) code = 2;
      if (opts.json) {
        process.stdout.write(JSON.stringify({ url: page.url, findings }, null, 2) + '\n');
      } else if (!findings.length) {
        console.log(`No prompt-injection findings on ${page.url}`);
      } else {
        console.log(`${findings.length} finding(s) on ${page.url}:`);
        for (const f of findings) {
          console.log(`  [${f.severity}] ${f.rule} (${f.location}${f.hiddenBy ? `, hidden via ${f.hiddenBy}` : ''}): "${f.excerpt}"`);
        }
      }
    } catch (err: any) {
      console.error(`Scan error: ${err.message || err}`);
      code = 1;
    } finally {
      browser.close();
      process.exit(code);
    }
  });

firewallCmd
  .command('verify <file>')
  .description('Check an audit log\'s hash chain (set ORBIS_AUDIT_KEY if it was HMAC-signed). Exit code 1 when it fails.')
  .action((file: string) => {
    let result;
    try {
      result = verifyAuditLog(file);
    } catch (e: any) {
      fail(`Cannot read audit log "${file}": ${e.message}`);
    }
    if (result.ok) {
      console.log(`OK: ${result.entries} entries, chain intact. Head: ${result.head ?? '(empty)'}`);
      console.log('Record the head hash elsewhere to also detect later truncation.');
      process.exit(0);
    }
    console.error(`FAILED at line ${result.badLine}: ${result.reason} (${result.entries} entries verified before it)`);
    process.exit(1);
  });

addFirewallOptions(firewallCmd
  .command('policy')
  .description('Print the effective firewall policy for the given flags / policy file as JSON')
  .option('--allow-domain <pattern>', 'Allowed navigation host pattern (repeatable)', collect, [])
  .option('--block-domain <pattern>', 'Blocked host pattern (repeatable)', collect, [])
  .option('--block-sensitive-domains', 'Block sensitive categories'))
  .action((opts: any) => {
    try {
      const network = parseNetworkOptions(opts);
      // Resolved without constructing a firewall, so no audit file is created or extended
      const input = buildPolicyInput(opts, network) ?? buildPolicyInput({ ...opts, firewall: 'standard' }, network)!;
      process.stdout.write(JSON.stringify(resolvePolicy(input), null, 2) + '\n');
    } catch (e: any) {
      fail(e.message);
    }
  });

function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const u = new URL(rawUrl, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') {
      href = href.slice(0, -1);
    }
    if (/\.(pdf|zip|tar|gz|exe|dmg|pkg|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|woff2?|ttf|eot|css|js)$/i.test(u.pathname)) {
      return null;
    }
    return href;
  } catch {
    return null;
  }
}

async function runFetchCommand(url: string, opts: any): Promise<void> {
  const stealth = opts.stealth !== false;
  let network: NetworkOptions;
  try {
    network = parseNetworkOptions(opts);
  } catch (e: any) {
    fail(e.message);
  }
  const browser = new OrbisBrowser({
    stealth,
    network,
    engine: opts.engine || (opts.eco ? 'native' : 'auto')
  });
  const page = browser.newPage();

  const isAllPages = Boolean(opts.allPages || opts.allPage || opts.crawl);
  const maxPages = parseInt(opts.maxPages || '10', 10);

  // Format resolution: CLI flags take precedence over --dump
  let format = (opts.dump || '').toLowerCase();
  if (opts.markdown || opts.md) {
    format = 'markdown';
  } else if (opts.links) {
    format = 'links';
  } else if (opts.html) {
    format = 'html';
  } else if (opts.seo || opts.schema) {
    format = 'seo';
  } else if (opts.json) {
    format = 'json';
  }
  if (!format) {
    format = 'content';
  }

  try {
    if (isAllPages) {
      let baseOrigin = '';
      try {
        baseOrigin = new URL(url).origin;
      } catch {}

      const seed = normalizeUrl(url, url) || url;
      const queue: string[] = [seed];
      const visited = new Set<string>();
      const pagesData: any[] = [];
      const allInternalLinks = new Map<string, string>();
      const allExternalLinks = new Map<string, string>();

      while (queue.length > 0 && visited.size < maxPages) {
        const currentUrl = queue.shift()!;
        if (visited.has(currentUrl)) continue;
        visited.add(currentUrl);

        process.stderr.write(`[Orbis Crawl] [${visited.size}/${maxPages}] Scraping: ${currentUrl} ...\n`);

        try {
          await page.goto(currentUrl);
          if (opts.waitMs) {
            await new Promise(r => setTimeout(r, parseInt(opts.waitMs, 10)));
          }

          const linksGraph = (page as any).getLinks ? (page as any).getLinks() : { internal: [], external: [] };

          for (const l of linksGraph.internal) {
            if (!allInternalLinks.has(l.url)) allInternalLinks.set(l.url, l.text);
            const norm = normalizeUrl(l.url, currentUrl);
            if (norm && baseOrigin && norm.startsWith(baseOrigin) && !visited.has(norm) && !queue.includes(norm)) {
              queue.push(norm);
            }
          }
          for (const l of linksGraph.external) {
            if (!allExternalLinks.has(l.url)) allExternalLinks.set(l.url, l.text);
          }

          const pageTitle = page.title() || (page.document?.title || '').trim() || currentUrl;

          switch (format) {
            case 'markdown':
            case 'md': {
              const md = page.getMarkdown({ readerMode: opts.readerMode !== false, includeLinks: false });
              pagesData.push({
                url: currentUrl,
                title: pageTitle,
                markdown: md
              });
              break;
            }
            case 'links':
            case 'link_graph': {
              pagesData.push(linksGraph);
              break;
            }
            case 'html': {
              pagesData.push({
                url: currentUrl,
                title: pageTitle,
                html: page.content()
              });
              break;
            }
            case 'seo':
            case 'schema':
            case 'metadata': {
              pagesData.push(page.getStructuredData());
              break;
            }
            case 'json':
            case 'content':
            case 'scrape':
            case 'structured_data':
            default: {
              const sc = (page as any).getScrapedContent ? (page as any).getScrapedContent() : { title: pageTitle, url: currentUrl };
              pagesData.push(sc);
              break;
            }
          }
        } catch (err: any) {
          process.stderr.write(`[Orbis Crawl] Error fetching ${currentUrl}: ${err.message || err}\n`);
        }
      }

      let output = '';
      if (format === 'markdown' || format === 'md') {
        const markdownPages = pagesData.map((p, idx) => {
          return [
            `## [${idx + 1}/${pagesData.length}] ${p.title}`,
            `* **URL**: [${p.url}](${p.url})`,
            '',
            p.markdown,
            '',
            '---'
          ].join('\n');
        }).join('\n\n');

        output = [
          `# 🌐 Site Crawl Report`,
          `* **Seed URL**: ${url}`,
          `* **Origin**: ${baseOrigin}`,
          `* **Total Pages Scraped**: ${pagesData.length}`,
          `* **Discovered Internal Links**: ${allInternalLinks.size}`,
          `* **Discovered External Links**: ${allExternalLinks.size}`,
          '',
          '---',
          '',
          markdownPages
        ].join('\n');
      } else if (format === 'links' || format === 'link_graph') {
        output = JSON.stringify({
          seedUrl: url,
          origin: baseOrigin,
          totalPagesCrawled: pagesData.length,
          aggregatedSummary: {
            totalInternalUnique: allInternalLinks.size,
            totalExternalUnique: allExternalLinks.size,
            internalLinks: Array.from(allInternalLinks.entries()).map(([u, text]) => ({ text, url: u })),
            externalLinks: Array.from(allExternalLinks.entries()).map(([u, text]) => ({ text, url: u }))
          },
          pageDetails: pagesData
        }, null, 2);
      } else {
        output = JSON.stringify({
          seedUrl: url,
          origin: baseOrigin,
          totalPagesCrawled: pagesData.length,
          discoveredInternalCount: allInternalLinks.size,
          discoveredExternalCount: allExternalLinks.size,
          pages: pagesData
        }, null, 2);
      }

      if (opts.dumpMaxBytes) {
        const max = parseInt(opts.dumpMaxBytes, 10);
        if (output.length > max) {
          output = output.slice(0, max) + '\n... [truncated by --dump-max-bytes]';
        }
      }

      process.stdout.write(output + '\n');
      return;
    }

    // Single-page execution
    await page.goto(url);
    const challenge = page.challenge();
    if (challenge?.blocking) process.stderr.write(formatChallenge(challenge, page.lastChallengeCooldownSec) + '\n');
    if (opts.waitMs) {
      await new Promise(r => setTimeout(r, parseInt(opts.waitMs, 10)));
    }

    let output = '';

    switch (format) {
      case 'markdown':
      case 'md': {
        output = page.getMarkdown({ readerMode: opts.readerMode, includeLinks: opts.includeLinks });
        break;
      }
      case 'html': {
        output = page.content();
        break;
      }
      case 'links':
      case 'link_graph': {
        const links = (page as any).getLinks ? (page as any).getLinks() : { internal: [], external: [] };
        if (opts.internalOnly) {
          output = JSON.stringify({ url: links.url, count: links.internalCount, internal: links.internal }, null, 2);
        } else if (opts.externalOnly) {
          output = JSON.stringify({ url: links.url, count: links.externalCount, external: links.external }, null, 2);
        } else {
          output = JSON.stringify(links, null, 2);
        }
        break;
      }
      case 'seo':
      case 'schema':
      case 'metadata': {
        const sd = page.getStructuredData();
        output = JSON.stringify(sd, null, 2);
        break;
      }
      case 'semantic_tree':
      case 'action_map': {
        const snap = page.getSemanticSnapshot();
        output = [
          `# Title: ${snap.title}`,
          `URL: ${snap.url}`,
          `Tokens: ~${snap.tokenEstimate} | Actions: ${snap.interactiveCount}`,
          '',
          snap.actionMapText
        ].join('\n');
        break;
      }
      case 'json':
      case 'content':
      case 'scrape':
      case 'structured_data':
      default: {
        const sc = (page as any).getScrapedContent ? (page as any).getScrapedContent() : { title: page.title(), url: page.url };
        output = JSON.stringify(sc, null, 2);
        break;
      }
    }

    if (opts.dumpSelector) {
      const el = page.querySelector(opts.dumpSelector);
      if (el) {
        output = format === 'html' ? el.outerHTML : el.textContent.trim();
      } else {
        output = `[Selector "${opts.dumpSelector}" not found]`;
      }
    }

    if (opts.dumpMaxBytes) {
      const max = parseInt(opts.dumpMaxBytes, 10);
      if (output.length > max) {
        output = output.slice(0, max) + '\n... [truncated by --dump-max-bytes]';
      }
    }

    process.stdout.write(output + '\n');
    if (page.lastStatus >= 400) {
      process.stderr.write(`HTTP ${page.lastStatus} from ${page.url}\n`);
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  } finally {
    browser.close();
    process.exit(process.exitCode ?? 0);
  }
}

// 1. Fetch CLI command: `orbis fetch <url>`
addNetworkOptions(program
  .command('fetch <url>')
  .description('Fetch and dump webpage in LLM-ready formats (markdown, json, links, semantic_tree)')
  .option('-m, --markdown', 'Output clean reader markdown')
  .option('--md', 'Alias for --markdown')
  .option('-j, --json', 'Output structured JSON')
  .option('-l, --links', 'Output internal/external link graph')
  .option('--html', 'Output raw HTML content')
  .option('--seo', 'Output SEO and OpenGraph metadata')
  .option('-a, --all-pages', 'Crawl all internal pages on the same domain')
  .option('--all-page', 'Alias for --all-pages')
  .option('--crawl', 'Alias for --all-pages')
  .option('--max-pages <number>', 'Maximum pages to crawl with --all-pages (default: 10)', '10')
  .option('-d, --dump <format>', 'Dump format: markdown, json, links, html, seo, semantic_tree, action_map')
  .option('--dump-selector <selector>', 'Restrict output to elements matching CSS selector')
  .option('--dump-max-bytes <bytes>', 'Limit output byte length')
  .option('--wait-ms <ms>', 'Wait milliseconds after loading')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => runFetchCommand(url, opts));

// 2. Read CLI command: `orbis read <url>` -> Direct Markdown dump with interlinked subpages
addNetworkOptions(program
  .command('read <url>')
  .description('Read webpage and output clean Markdown directly (with interlinked pages appendix)')
  .option('-a, --all-pages', 'Crawl and read all internal pages on the same domain')
  .option('--all-page', 'Alias for --all-pages')
  .option('--crawl', 'Alias for --all-pages')
  .option('--max-pages <number>', 'Maximum pages to crawl with --all-pages (default: 10)', '10')
  .option('--dump-selector <selector>', 'Restrict output to elements matching CSS selector')
  .option('--dump-max-bytes <bytes>', 'Limit output byte length')
  .option('--no-links', 'Omit interlinked pages section at the bottom')
  .option('--wait-ms <ms>', 'Wait milliseconds after loading')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => runFetchCommand(url, { ...opts, markdown: true, readerMode: true, includeLinks: opts.links !== false, eco: true }));

// 3. Links CLI command: `orbis links <url>` -> Interlinked URL graph
addNetworkOptions(program
  .command('links <url>')
  .description('Extract all interlinked internal and external URLs with anchor texts')
  .option('-a, --all-pages', 'Crawl and aggregate links across all internal pages on the domain')
  .option('--all-page', 'Alias for --all-pages')
  .option('--crawl', 'Alias for --all-pages')
  .option('--max-pages <number>', 'Maximum pages to crawl with --all-pages (default: 10)', '10')
  .option('--internal-only', 'Show only internal links within the same origin')
  .option('--external-only', 'Show only external links')
  .option('--dump-max-bytes <bytes>', 'Limit output byte length')
  .option('--wait-ms <ms>', 'Wait milliseconds after loading')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => runFetchCommand(url, { ...opts, links: true, eco: true }));

// 4. Scrape CLI command: `orbis scrape <url>` -> Content, Markdown, JSON, or Site Crawl
addNetworkOptions(program
  .command('scrape <url>')
  .description('Scrape content, links, markdown, or entire site from a webpage')
  .option('-m, --markdown', 'Output clean reader-friendly markdown')
  .option('--md', 'Alias for --markdown')
  .option('-j, --json', 'Output structured JSON (title, headings, sections, summary, links)')
  .option('-l, --links', 'Output internal and external link graph')
  .option('--html', 'Output raw HTML content')
  .option('--seo', 'Output SEO meta tags, OpenGraph, and JSON-LD structured data')
  .option('--schema', 'Alias for --seo')
  .option('-a, --all-pages', 'Crawl and scrape all internal pages on the same domain')
  .option('--all-page', 'Alias for --all-pages')
  .option('--crawl', 'Alias for --all-pages')
  .option('--max-pages <number>', 'Maximum number of pages to crawl with --all-pages (default: 10)', '10')
  .option('-d, --dump <format>', 'Dump format: markdown, json, links, html, seo, semantic_tree')
  .option('--dump-selector <selector>', 'Restrict output to elements matching CSS selector')
  .option('--dump-max-bytes <bytes>', 'Limit output byte length')
  .option('--wait-ms <ms>', 'Wait milliseconds after loading')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => runFetchCommand(url, { ...opts, eco: true }));

// 5. Browse CLI command: `orbis browse <url>` -> Action Map & Semantic Tree
addNetworkOptions(program
  .command('browse <url>')
  .description('Browse webpage and output LLM action map & markdown')
  .option('--dump-selector <selector>', 'Restrict output to elements matching CSS selector')
  .option('--dump-max-bytes <bytes>', 'Limit output byte length')
  .option('--wait-ms <ms>', 'Wait milliseconds after loading')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => runFetchCommand(url, { ...opts, dump: 'semantic_tree' }));

// 5. Start / Run server aliases
addFirewallOptions(addServerOptions(program
  .command('start')
  .description('Start the automation server (alias for serve)')))
  .action(runServer);

addFirewallOptions(addServerOptions(program
  .command('run')
  .description('Start the automation server (alias for serve)')))
  .action(runServer);

// 6. Config command: `orbis config [action] [key] [val]`
program
  .command('config [action] [key] [val]')
  .description('Get or set persistent Orbis user defaults (e.g. `orbis config set preset eco`)')
  .action((action?: string, key?: string, val?: string) => {
    const homedir = os.homedir();
    const dir = path.join(homedir, '.orbis');
    const cfgPath = path.join(dir, 'config.json');
    let cfg: Record<string, any> = {};
    try {
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {}

    if (!action || action === 'list') {
      console.log(JSON.stringify(cfg, null, 2));
      process.exit(0);
    }
    if (action === 'set' && key && val !== undefined) {
      fs.mkdirSync(dir, { recursive: true });
      cfg[key] = val === 'true' ? true : val === 'false' ? false : val;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      console.log(`✓ Set ${key} = ${val} in ~/.orbis/config.json`);
      process.exit(0);
    }
    if (action === 'get' && key) {
      console.log(cfg[key] !== undefined ? cfg[key] : '(not set)');
      process.exit(0);
    }
  });

// 7. Replay command: `orbis replay [traceFile]`
program
  .command('replay [traceFile]')
  .description('Open and replay an agent flight recording (.html) in your local browser')
  .action((traceFile?: string) => {
    let targetHtml = traceFile;
    if (!targetHtml) {
      const traceDir = path.join(process.cwd(), '.orbis', 'traces');
      if (fs.existsSync(traceDir)) {
        const files = fs.readdirSync(traceDir).filter(f => f.endsWith('.html'));
        if (files.length > 0) {
          files.sort((a, b) => {
            return fs.statSync(path.join(traceDir, b)).mtimeMs - fs.statSync(path.join(traceDir, a)).mtimeMs;
          });
          targetHtml = path.join(traceDir, files[0]);
        }
      }
    }

    if (!targetHtml || !fs.existsSync(targetHtml)) {
      console.error('No flight replay (.html) found. Run an agent with --record first or specify a file path.');
      process.exit(1);
    }

    const absPath = path.resolve(targetHtml);
    console.log(`🎬 Opening Orbis Flight Replay in local browser:\n  file://${absPath.replace(/\\/g, '/')}\n`);
    const cmd = process.platform === 'win32'
      ? `start "" "${absPath}"`
      : process.platform === 'darwin'
      ? `open "${absPath}"`
      : `xdg-open "${absPath}"`;
    try {
      const { exec } = require('node:child_process');
      exec(cmd);
    } catch {}
  });

// 8. Import cookies command: `orbis import-cookies <filePath>`
program
  .command('import-cookies <filePath>')
  .option('--url <targetUrl>', 'Target URL for domain cookies', 'https://example.com')
  .option('--profile <name>', 'Save directly to encrypted vault profile name')
  .description('Import Netscape or JSON cookies from host browser into Orbis')
  .action((filePath: string, opts: any) => {
    const { SessionImporter } = require('../vault/importer.js');
    const { SessionVault } = require('../vault/index.js');
    try {
      const session = SessionImporter.importFromFile(filePath, opts.url);
      console.log(`✓ Successfully imported ${session.cookieList?.length || Object.keys(session.cookies).length} cookies for ${session.url}`);
      if (opts.profile) {
        const vault = new SessionVault();
        vault.saveProfile(opts.profile, session);
        console.log(`✓ Saved authenticated session to vault profile "${opts.profile}"`);
      }
    } catch (err: any) {
      console.error(`Failed to import cookies: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
