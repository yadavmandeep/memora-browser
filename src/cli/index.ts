#!/usr/bin/env node
import { Command } from 'commander';
import { MemoraBrowser } from '../engine/browser.js';
import { NetworkOptions } from '../types/index.js';
import { redactProxyUrl, validateProxyUrl } from '../network/proxy.js';

const program = new Command();
// Options after a subcommand belong to it (serve --port 9333 must not hit the root command)
program.enablePositionalOptions();

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

// Network flags shared by every command (names follow Lightpanda's CLI where one exists)
function addNetworkOptions(cmd: Command): Command {
  return cmd
    .option('--http-proxy <url>', 'Proxy for all requests: http://, https:// or socks5:// (user:pass@ allowed for basic auth)')
    .option('--proxy-bearer-token <token>', 'Send "Proxy-Authorization: Bearer <token>" to the proxy')
    .option('--proxy-bypass <hosts>', 'Comma-separated hosts that skip the proxy (e.g. localhost,.internal.corp)')
    .option('--use-env-proxy', 'Use HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY when --http-proxy is not set')
    .option('--http-header <header>', 'Extra "Name: Value" header for every request (repeatable)', collect, [])
    .option('--user-agent <ua>', 'Override the User-Agent header')
    .option('--http-timeout <ms>', 'Navigation request timeout in milliseconds')
    .option('--insecure-disable-tls-host-verification', 'Skip TLS certificate verification (self-signed / MITM proxies)')
    .option('--obey-robots', 'Fetch robots.txt for every origin and block requests it disallows (RFC 9309)')
    .option('--robots-agent <token>', 'Product token matched against robots.txt User-agent lines (default: MemoraBrowser)');
}

function parseNetworkOptions(opts: any): NetworkOptions {
  const network: NetworkOptions = {};
  const proxy = opts.httpProxy;
  if (proxy) {
    validateProxyUrl(proxy);
    network.proxy = proxy;
  }
  if (opts.proxyBearerToken) network.proxyBearerToken = opts.proxyBearerToken;
  if (opts.proxyBypass) network.noProxy = opts.proxyBypass.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (opts.useEnvProxy) network.useEnvProxy = true;
  if (opts.userAgent) network.userAgent = opts.userAgent;
  if (opts.httpTimeout) network.timeoutMs = parseInt(opts.httpTimeout, 10);
  if (opts.insecureDisableTlsHostVerification) network.insecureTls = true;
  if (opts.obeyRobots) network.obeyRobots = true;
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
  return network.useEnvProxy ? 'from environment' : 'none (direct)';
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function runServer(options: any): Promise<void> {
  let network: NetworkOptions;
  try {
    network = parseNetworkOptions(options);
  } catch (e: any) {
    fail(e.message);
  }

  // MCP stdio mode for AI Coding Assistants (Cursor, Claude Desktop, Antigravity, Windsurf)
  if (options.mcp) {
    const { MCPServer } = await import('../mcp/server.js');
    const mcp = new MCPServer(network, options.engine || 'auto');
    mcp.start();
    return;
  }

  const port = parseInt(options.port, 10);
  const host = options.host;
  const stealth = options.stealth !== false;
  const protocol = String(options.protocol || 'cdp').toLowerCase();

  if (protocol === 'webdriver') {
    const { WebDriverServer } = await import('../webdriver/server.js');
    const server = new WebDriverServer({
      port,
      host,
      stealth,
      network,
      maxSessions: parseInt(options.maxSessions, 10),
    });
    try {
      await server.start();
    } catch (e: any) {
      fail(`Could not start WebDriver server on ${host}:${port}: ${e.message}`);
    }
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                ⚡ MEMORA BROWSER — WEBDRIVER MODE               ║
║          W3C WebDriver for Selenium, WebdriverIO, etc.         ║
╚════════════════════════════════════════════════════════════════╝
  ▶ WebDriver URL:      http://${host}:${port}
  ▶ Status:             http://${host}:${port}/status
  ▶ Max Sessions:       ${options.maxSessions}
  ▶ Proxy:              ${describeProxy(network)}
  ▶ Stealth Mode:       ${stealth ? '🛡️  ACTIVE' : 'OFF'}
  ▶ Selenium (Python):  webdriver.Remote("http://${host}:${port}", options=webdriver.ChromeOptions())
══════════════════════════════════════════════════════════════════
    `);
    const shutdown = async () => {
      await server.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (protocol !== 'cdp') fail(`Unknown --protocol "${protocol}". Use "cdp" or "webdriver".`);

  const browser = new MemoraBrowser({ port, host, stealth, network });

  // One-shot eval mode
  if (options.eval) {
    console.log(`\n🔍 [Memora] Fetching & Distilling: ${options.eval} ...`);
    const startTime = performance.now();
    const page = browser.newPage();
    try {
      await page.goto(options.eval);
      const snapshot = page.getSemanticSnapshot();
      const duration = (performance.now() - startTime).toFixed(1);

      console.log(`\n✨ Successfully distilled in ${duration}ms!`);
      console.log(`📌 Title: ${snapshot.title}`);
      console.log(`🎯 Interactive Elements: ${snapshot.interactiveCount}`);
      console.log(`🧠 Estimated Prompt Tokens: ${snapshot.tokenEstimate}`);
      console.log('\n' + snapshot.actionMapText);
      console.log('\n--- Distilled Content ---');
      console.log(snapshot.markdown.slice(0, 1000) + (snapshot.markdown.length > 1000 ? '\n... [truncated]' : ''));
    } catch (err: any) {
      console.error('❌ Error during eval:', err.message || err);
    } finally {
      process.exit(0);
    }
    return;
  }

  // Server daemon mode (CDP server + ws loaded only here, so fetch/--eval start lighter)
  const { CDPServer } = await import('../cdp/server.js');
  const server = new CDPServer(browser);
  await server.start();

  const memUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                   ⚡ MEMORA AGENTIC BROWSER                    ║
║         Ultra-Fast Headless Engine for AI Agents & LLMs        ║
╚════════════════════════════════════════════════════════════════╝
  ▶ CDP WebSocket:      ws://${host}:${port}/devtools/browser/memora-root
  ▶ Discovery Endpoint: http://${host}:${port}/json/version
  ▶ Agent Snapshot:     http://${host}:${port}/memora/snapshot
  ▶ Memory Footprint:   ~${memUsage} MB (Chromium uses ~350MB+)
  ▶ Proxy:              ${describeProxy(network)}
  ▶ Stealth Mode:       ${stealth ? '🛡️  ACTIVE (Anti-Detect On)' : 'OFF'}
  ▶ Status:             READY FOR PLAYWRIGHT / PUPPETEER / AGENTS
══════════════════════════════════════════════════════════════════
    `);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n[Memora] Shutting down browser server...');
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
    .option('-h, --host <string>', 'Host address', '127.0.0.1')
    .option('--protocol <protocol>', 'Automation protocol to serve: cdp (Playwright/Puppeteer) or webdriver (Selenium)', 'cdp')
    .option('--engine <engine>', 'Engine backend: native (ultra-fast zero-graphics), chrome (system Chromium), or auto', 'auto')
    .option('--max-sessions <number>', 'Maximum concurrent WebDriver sessions', '16')
    .option('--no-stealth', 'Disable anti-bot stealth emulation'));
}

addServerOptions(program
  .name('memora-browser')
  .description('Memora Agentic Headless Browser — Ultra-fast, CDP & WebDriver compatible, AI-Native browser engine')
  .version('1.0.0'))
  .option('--eval <url>', 'Fetch a URL, distill semantic snapshot, and output to console')
  .option('--mcp', 'Run as Model Context Protocol (MCP) server over stdio for Cursor, Claude, Antigravity')
  .action(runServer);

// Lightpanda parity: `memora-browser serve --protocol webdriver`
addServerOptions(program
  .command('serve')
  .description('Start the automation server (same as running without a command)'))
  .action(runServer);

// Lightpanda parity CLI command: `memora-browser fetch <url> --dump markdown`
addNetworkOptions(program
  .command('fetch <url>')
  .description('Fetch and dump webpage in LLM-ready formats (drop-in replacement for lightpanda fetch)')
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
    const browser = new MemoraBrowser({ stealth, network });
    const page = browser.newPage();
    try {
      await page.goto(url);
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
    } catch (err: any) {
      console.error(`Fetch error: ${err.message || err}`);
      process.exit(1);
    } finally {
      browser.close();
      process.exit(0);
    }
  });

program.parse(process.argv);
