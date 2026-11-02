#!/usr/bin/env node
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
    .option('--block-sensitive-domains', 'Firewall: refuse navigation to email, banking/payments, identity, cloud consoles, admin paths and cloud metadata endpoints');
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

  if (protocol !== 'cdp') fail(`Unknown --protocol "${protocol}". Use "cdp" or "webdriver".`);

  const browser = new OrbisBrowser({ port, host, stealth, network });

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
    port,
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
    .option('--protocol <protocol>', 'Automation protocol to serve: cdp (Playwright/Puppeteer) or webdriver (Selenium)', 'cdp')
    .option('--engine <engine>', 'Engine backend: native (ultra-fast zero-graphics), chrome (system Chromium), or auto', 'auto')
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

// Fetch CLI command: `orbis fetch <url> --dump markdown`
addNetworkOptions(program
  .command('fetch <url>')
  .description('Fetch and dump webpage in LLM-ready formats (markdown, action_map, structured_data)')
  .option('-d, --dump <format>', 'Dump format: markdown, html, structured_data, semantic_tree, action_map', 'markdown')
  .option('--dump-selector <selector>', 'Restrict output to elements matching CSS selector')
  .option('--dump-max-bytes <bytes>', 'Limit output byte length')
  .option('--wait-ms <ms>', 'Wait milliseconds after loading')
  .option('--no-stealth', 'Disable anti-bot stealth emulation'))
  .action(async (url: string, opts: any) => {
    const stealth = opts.stealth !== false;
    let network: NetworkOptions;
    try {
      network = parseNetworkOptions(opts);
    } catch (e: any) {
      fail(e.message);
    }
    const browser = new OrbisBrowser({ stealth, network });
    const page = browser.newPage();
    try {
      await page.goto(url);
      const challenge = page.challenge();
      if (challenge?.blocking) process.stderr.write(formatChallenge(challenge, page.lastChallengeCooldownSec) + '\n');
      if (opts.waitMs) {
        await new Promise(r => setTimeout(r, parseInt(opts.waitMs, 10)));
      }

      let output = '';
      const dumpFormat = (opts.dump || 'markdown').toLowerCase();

      switch (dumpFormat) {
        case 'markdown':
        case 'md': {
          output = page.getMarkdown();
          break;
        }
        case 'html': {
          output = page.content();
          break;
        }
        case 'structured_data':
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
        default: {
          output = page.getMarkdown();
        }
      }

      if (opts.dumpSelector) {
        const el = page.querySelector(opts.dumpSelector);
        if (el) {
          output = dumpFormat === 'html' ? el.outerHTML : el.textContent.trim();
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
      // The page is printed either way; an HTTP error status is still a failure for scripts and CI
      if (page.lastStatus >= 400) {
        process.stderr.write(`HTTP ${page.lastStatus} from ${page.url}\n`);
        process.exitCode = 1;
      }
    } catch (err: any) {
      console.error(`Fetch error: ${err.message || err}`);
      process.exit(1);
    } finally {
      browser.close();
      process.exit(process.exitCode ?? 0);
    }
  });

program.parse(process.argv);
