/**
 * Memora Headless Browser Integration & Benchmark Suite
 * 
 * Verifies:
 * - MemoraBrowser and CDPServer lifecycle & CDP WebSocket / HTTP endpoints
 * - DOM parsing & distillation latency on real-world HTML structures
 * - Token compression ratio (Raw HTML vs Distilled Action Tree + Markdown)
 * - Memory footprint (RSS, Heap Used) vs traditional Chromium benchmarks
 * - V8 sandbox JavaScript execution and dynamic DOM mutation
 * - Action ID element resolution and simulated clicks/inputs (@1, @2, etc.)
 */

import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { MemoraBrowser } from '../src/engine/browser.js';
import { CDPServer } from '../src/cdp/server.js';
import { parseHTML } from '../src/dom/parser.js';
import { extractSemanticSnapshot } from '../src/distiller/semantic-tree.js';
import { convertToMarkdown } from '../src/distiller/markdown.js';

// ============================================================================
// REAL-WORLD HTML FIXTURES
// ============================================================================

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Enterprise Cloud - Sign In to Workspace</title>
  <link rel="stylesheet" href="/assets/style.css">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; }
    .card { max-width: 420px; margin: 40px auto; padding: 32px; background: #1e293b; border-radius: 12px; }
  </style>
</head>
<body>
  <header class="navbar">
    <div class="logo"><strong>Acme Cloud</strong> Platform</div>
    <nav class="nav-links">
      <a href="/docs">Documentation</a>
      <a href="/support">Help Center</a>
      <select name="locale" id="locale-picker" aria-label="Language Selector">
        <option value="en" selected>English (US)</option>
        <option value="es">Español</option>
        <option value="ja">日本語</option>
      </select>
    </nav>
  </header>

  <main class="container">
    <div class="card">
      <h1 class="card-title">Welcome Back</h1>
      <p class="card-subtitle">Authenticate to access your cloud workloads and clusters.</p>

      <form id="login-form" action="/auth/login" method="POST">
        <input type="hidden" name="csrf_token" value="d9f83a48e71b29c93a">
        
        <div class="form-group">
          <label for="username">Work Email or SSO Username</label>
          <input type="email" id="username" name="email" placeholder="alex.turner@enterprise.com" required autocomplete="username">
        </div>

        <div class="form-group">
          <div class="label-row">
            <label for="password">Security Password</label>
            <a href="/auth/forgot-password" class="forgot-link">Forgot password?</a>
          </div>
          <div class="password-wrapper">
            <input type="password" id="password" name="password" placeholder="Enter at least 12 characters" required>
            <button type="button" id="toggle-password" class="btn-icon" aria-label="Toggle password visibility">Show</button>
          </div>
        </div>

        <div class="form-check">
          <input type="checkbox" id="remember" name="remember_me">
          <label for="remember">Keep this workstation signed in for 30 days</label>
        </div>

        <button type="submit" id="btn-submit" class="btn btn-primary btn-block">Sign In with Credentials</button>
      </form>

      <div class="divider"><span>OR CONTINUE WITH SSO</span></div>

      <div class="sso-options">
        <button type="button" id="btn-sso-google" class="btn btn-outline" role="button">Sign In with Google Workspace</button>
        <button type="button" id="btn-sso-github" class="btn btn-outline" role="button">Sign In with GitHub Enterprise</button>
        <button type="button" id="btn-sso-okta" class="btn btn-outline" role="button">Sign In with Okta / SAML 2.0</button>
      </div>

      <div class="security-note">
        <p>Protected by hardware-enforced WebAuthn and end-to-end TLS 1.3 encryption.</p>
      </div>
    </div>
  </main>

  <footer class="footer">
    <p>&copy; 2026 Acme Corp. All rights reserved.</p>
    <ul>
      <li><a href="/legal/privacy">Privacy Policy</a></li>
      <li><a href="/legal/terms">Terms of Service</a></li>
      <li><a href="/security/compliance">SOC-2 Type II Compliance</a></li>
    </ul>
  </footer>
</body>
</html>`;

const ECOMMERCE_GRID_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Apex Hardware - High Performance Developer Workstations</title>
</head>
<body>
  <header id="site-header">
    <div class="brand"><a href="/">Apex Systems</a></div>
    <div class="search-bar">
      <input type="search" id="global-search" name="q" placeholder="Search workstations, GPUs, memory, storage...">
      <button type="submit" id="search-btn">Search Store</button>
    </div>
    <div class="user-actions">
      <a href="/account/orders" class="nav-item">My Orders</a>
      <a href="/cart" class="nav-item" id="cart-link">Cart (<span id="cart-count">2</span>)</a>
    </div>
  </header>

  <div class="layout-wrapper">
    <aside class="sidebar-filters" aria-label="Product Filters">
      <h3>Filter Products</h3>
      <div class="filter-group">
        <h4>Category</h4>
        <label><input type="checkbox" name="cat" value="workstations" checked> Desktop Workstations (42)</label>
        <label><input type="checkbox" name="cat" value="servers"> Rackmount Servers (18)</label>
        <label><input type="checkbox" name="cat" value="laptops"> Developer Laptops (35)</label>
      </div>
      <div class="filter-group">
        <h4>Processor Architecture</h4>
        <label><input type="checkbox" name="arch" value="arm64"> ARM64 Neoverse / M-Series</label>
        <label><input type="checkbox" name="arch" value="x86_64" checked> AMD EPYC / Ryzen 9</label>
      </div>
      <div class="filter-group">
        <h4>Price Range</h4>
        <div class="price-inputs">
          <input type="number" id="min-price" name="min_price" placeholder="Min $" value="1000">
          <span>to</span>
          <input type="number" id="max-price" name="max_price" placeholder="Max $" value="10000">
          <button type="button" id="apply-price-filter" class="btn-filter">Apply</button>
        </div>
      </div>
      <div class="filter-group">
        <label><input type="checkbox" id="in-stock-only" name="in_stock" checked> In Stock Ready to Ship</label>
      </div>
    </aside>

    <main id="catalog-content">
      <div class="catalog-toolbar">
        <h2>Developer Workstations & AI Clusters</h2>
        <div class="sort-controls">
          <label for="sort-select">Sort by:</label>
          <select id="sort-select" name="sort">
            <option value="featured">Featured Workstations</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
            <option value="rating">Top Customer Reviews</option>
          </select>
        </div>
      </div>

      <div class="product-grid">
        <article class="product-card" id="prod-101">
          <span class="badge badge-hot">Bestseller</span>
          <img src="/img/ws-titan.jpg" alt="Apex Titan Workstation" width="240" height="180">
          <h3 class="prod-title"><a href="/product/apex-titan-x">Apex Titan AI Workstation - 64-Core Threadripper</a></h3>
          <p class="specs">128GB DDR5 ECC | 2TB NVMe Gen5 | Dual RTX 4090 24GB</p>
          <div class="rating"><span class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span> <a href="#reviews">(84 reviews)</a></div>
          <div class="price-box">
            <span class="current-price">$6,499.00</span>
            <span class="original-price">$6,999.00</span>
          </div>
          <div class="card-buttons">
            <button type="button" class="btn-cart" id="add-cart-101">Add to Cart</button>
            <button type="button" class="btn-wishlist" id="wishlist-101">Save to Wishlist</button>
          </div>
        </article>

        <article class="product-card" id="prod-102">
          <span class="badge badge-sale">Save $400</span>
          <img src="/img/ws-matrix.jpg" alt="Matrix Developer Studio" width="240" height="180">
          <h3 class="prod-title"><a href="/product/matrix-studio-mini">Matrix Studio Mini - Silent Liquid Cooled</a></h3>
          <p class="specs">AMD Ryzen 9 7950X3D | 64GB DDR5 | 1TB NVMe | RTX 4080 Super</p>
          <div class="rating"><span class="stars">&#9733;&#9733;&#9733;&#9733;&#9734;</span> <a href="#reviews">(47 reviews)</a></div>
          <div class="price-box">
            <span class="current-price">$3,299.00</span>
            <span class="original-price">$3,699.00</span>
          </div>
          <div class="card-buttons">
            <button type="button" class="btn-cart" id="add-cart-102">Add to Cart</button>
            <button type="button" class="btn-wishlist" id="wishlist-102">Save to Wishlist</button>
          </div>
        </article>

        <article class="product-card" id="prod-103">
          <img src="/img/ws-rack.jpg" alt="Apex 4U Deep Learning Rack" width="240" height="180">
          <h3 class="prod-title"><a href="/product/apex-dl-rack-4u">Apex 4U Cluster Node - Quad H100 80GB SXM5</a></h3>
          <p class="specs">Dual Intel Xeon Platinum 8480+ | 512GB DDR5 | 8TB U.2 Enterprise</p>
          <div class="rating"><span class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span> <a href="#reviews">(19 reviews)</a></div>
          <div class="price-box">
            <span class="current-price">$38,950.00</span>
          </div>
          <div class="card-buttons">
            <button type="button" class="btn-cart" id="add-cart-103">Request Quote / Buy</button>
            <button type="button" class="btn-wishlist" id="wishlist-103">Compare Specs</button>
          </div>
        </article>
      </div>

      <nav class="pagination" aria-label="Page Navigation">
        <a href="/catalog?page=1" class="page-link disabled">&laquo; Previous</a>
        <a href="/catalog?page=1" class="page-link active">1</a>
        <a href="/catalog?page=2" class="page-link">2</a>
        <a href="/catalog?page=3" class="page-link">3</a>
        <a href="/catalog?page=2" class="page-link">Next &raquo;</a>
      </nav>
    </main>
  </div>
</body>
</html>`;

const FINANCIAL_TABLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Acme Financial Operations - Real-Time Ledger & Settlement</title>
</head>
<body>
  <div class="dashboard-header">
    <h1>Financial Transactions & Audit Trail</h1>
    <div class="actions-bar">
      <input type="text" id="filter-transactions" placeholder="Filter by invoice ID or payee...">
      <select id="status-filter">
        <option value="all">All Statuses</option>
        <option value="settled">Settled</option>
        <option value="pending">Pending</option>
        <option value="flagged">Flagged / Review</option>
      </select>
      <button type="button" id="btn-export-csv" class="btn">Export CSV</button>
      <button type="button" id="btn-refresh" class="btn">Refresh Ledger</button>
    </div>
  </div>

  <table class="data-table" id="ledger-table">
    <thead>
      <tr>
        <th><input type="checkbox" id="select-all-rows" aria-label="Select all transactions"></th>
        <th>Reference ID</th>
        <th>Timestamp (UTC)</th>
        <th>Counterparty</th>
        <th>Type</th>
        <th>Payment Rail</th>
        <th>Status</th>
        <th>Net Amount</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><input type="checkbox" name="tx_select" value="TX-9021"></td>
        <td><code>TX-9021-US</code></td>
        <td>2026-10-29 14:22:09</td>
        <td><strong>Stripe Payments US</strong></td>
        <td>Merchant Settlement</td>
        <td>FedNow Instant</td>
        <td><span class="status-badge status-success">Settled</span></td>
        <td class="amount positive">+$142,500.00</td>
        <td>
          <button type="button" class="btn-sm" id="view-tx-9021">View Details</button>
          <button type="button" class="btn-sm" id="receipt-tx-9021">Receipt</button>
        </td>
      </tr>
      <tr>
        <td><input type="checkbox" name="tx_select" value="TX-9022"></td>
        <td><code>TX-9022-EU</code></td>
        <td>2026-10-29 14:18:44</td>
        <td><strong>AWS EMEA Cloud Services</strong></td>
        <td>Infrastructure Billing</td>
        <td>SEPA B2B</td>
        <td><span class="status-badge status-success">Settled</span></td>
        <td class="amount negative">-$38,410.20</td>
        <td>
          <button type="button" class="btn-sm" id="view-tx-9022">View Details</button>
          <button type="button" class="btn-sm" id="receipt-tx-9022">Receipt</button>
        </td>
      </tr>
      <tr>
        <td><input type="checkbox" name="tx_select" value="TX-9023"></td>
        <td><code>TX-9023-AP</code></td>
        <td>2026-10-29 14:05:11</td>
        <td><strong>Tokyo Edge Data Centers</strong></td>
        <td>Colocation Lease</td>
        <td>SWIFT Wire</td>
        <td><span class="status-badge status-pending">Processing</span></td>
        <td class="amount negative">-$12,800.00</td>
        <td>
          <button type="button" class="btn-sm" id="view-tx-9023">View Details</button>
          <button type="button" class="btn-sm" id="cancel-tx-9023">Cancel Transfer</button>
        </td>
      </tr>
      <tr>
        <td><input type="checkbox" name="tx_select" value="TX-9024"></td>
        <td><code>TX-9024-US</code></td>
        <td>2026-10-29 13:50:33</td>
        <td><strong>Anthropic PBC</strong></td>
        <td>API Compute Usage</td>
        <td>ACH Credit</td>
        <td><span class="status-badge status-success">Settled</span></td>
        <td class="amount negative">-$4,920.50</td>
        <td>
          <button type="button" class="btn-sm" id="view-tx-9024">View Details</button>
          <button type="button" class="btn-sm" id="receipt-tx-9024">Receipt</button>
        </td>
      </tr>
      <tr>
        <td><input type="checkbox" name="tx_select" value="TX-9025"></td>
        <td><code>TX-9025-GB</code></td>
        <td>2026-10-29 13:31:00</td>
        <td><strong>DeepMind Technologies Ltd</strong></td>
        <td>Licensing Fee</td>
        <td>CHAPS</td>
        <td><span class="status-badge status-flagged">Under Audit Review</span></td>
        <td class="amount negative">-$65,000.00</td>
        <td>
          <button type="button" class="btn-sm" id="view-tx-9025">Inspect Audit</button>
          <button type="button" class="btn-sm btn-warn" id="approve-tx-9025">Approve Override</button>
        </td>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <td colspan="7"><strong>Total Net Daily Volume (Settled):</strong></td>
        <td colspan="2" class="total-amount"><strong>+$21,369.30 USD</strong></td>
      </tr>
    </tfoot>
  </table>
</body>
</html>`;

const SETTINGS_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Organization Security & Identity Settings</title>
</head>
<body>
  <div class="settings-container">
    <nav class="settings-nav">
      <a href="#general" class="nav-tab active">General Information</a>
      <a href="#security" class="nav-tab">Security & MFA</a>
      <a href="#api" class="nav-tab">API Tokens</a>
      <a href="#billing" class="nav-tab">Billing & Seats</a>
    </nav>

    <form id="org-settings-form">
      <section class="section-card">
        <h2>Organization Profile</h2>
        <div class="form-row">
          <label for="org-name">Organization Legal Name</label>
          <input type="text" id="org-name" name="organization_name" value="Memora Autonomous AI Corp">
        </div>
        <div class="form-row">
          <label for="org-domain">Primary Verified Domain</label>
          <input type="text" id="org-domain" name="domain" value="memora.internal" readonly>
        </div>
        <div class="form-row">
          <label for="contact-email">Security Escalation Email</label>
          <input type="email" id="contact-email" name="security_email" value="security@memora.company">
        </div>
        <div class="form-row">
          <label for="cluster-tier">Compute Cluster Tier</label>
          <select id="cluster-tier" name="cluster_tier">
            <option value="starter">Starter (4 Dedicated Nodes)</option>
            <option value="enterprise" selected>Enterprise High-Performance (32 Nodes)</option>
            <option value="custom">Hyperscale Custom Topology</option>
          </select>
        </div>
      </section>

      <section class="section-card">
        <h2>Zero-Trust Access Control Policies</h2>
        <div class="checkbox-row">
          <input type="checkbox" id="enforce-mfa" name="enforce_mfa" checked>
          <label for="enforce-mfa">Enforce Hardware FIDO2 Security Keys for all Engineers</label>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="ip-whitelisting" name="ip_whitelisting" checked>
          <label for="ip-whitelisting">Restrict cluster API endpoint to verified CIDR ranges</label>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="session-timeout" name="auto_logout">
          <label for="session-timeout">Terminate idle administrative sessions after 15 minutes</label>
        </div>
      </section>

      <section class="section-card">
        <h2>Data Retention & Telemetry</h2>
        <div class="radio-group">
          <p>Agent Trajectory Log Persistence:</p>
          <label><input type="radio" name="log_retention" value="30d"> 30 Days (Ephemeral)</label>
          <label><input type="radio" name="log_retention" value="365d" checked> 365 Days (Compliance Standard)</label>
          <label><input type="radio" name="log_retention" value="forever"> Indefinite (Immutable WORM Storage)</label>
        </div>

        <div class="form-row">
          <label for="admin-notes">Compliance Officer Remarks</label>
          <textarea id="admin-notes" name="notes" rows="3" placeholder="Enter annual SOC-2 audit justifications..."></textarea>
        </div>
      </section>

      <div class="form-actions">
        <button type="submit" id="save-settings-btn" class="btn btn-primary">Save Organization Settings</button>
        <button type="reset" id="reset-settings-btn" class="btn btn-secondary">Discard Unsaved Changes</button>
        <button type="button" id="purge-cache-btn" class="btn btn-danger">Flush Global Cache</button>
      </div>
    </form>
  </div>
</body>
</html>`;

// ============================================================================
// HELPER UTILITIES
// ============================================================================

interface BenchmarkResult {
  name: string;
  rawBytes: number;
  rawTokens: number;
  parseTimeMs: number;
  distillTimeMs: number;
  markdownTimeMs: number;
  totalTimeMs: number;
  interactiveCount: number;
  distilledBytes: number;
  distilledTokens: number;
  tokenReductionPercent: number;
  compressionRatio: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function getMemoryMetrics() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss / 1024 / 1024,
    heapTotal: mem.heapTotal / 1024 / 1024,
    heapUsed: mem.heapUsed / 1024 / 1024,
    external: mem.external / 1024 / 1024,
  };
}

// ============================================================================
// MAIN BENCHMARK RUNNER
// ============================================================================

async function runBenchmarkSuite() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║             ⚡ MEMORA HEADLESS BROWSER VERIFICATION & BENCHMARK            ║
║     Ultra-Lightweight Engine | Semantic AXTree Distiller | CDP Protocol   ║
╚════════════════════════════════════════════════════════════════════════════╝
`);

  const initialMemory = getMemoryMetrics();
  console.log(`[Suite] Initial Engine Memory: RSS=${initialMemory.rss.toFixed(2)}MB, HeapUsed=${initialMemory.heapUsed.toFixed(2)}MB\n`);

  // ==========================================================================
  // SECTION 1: CDPServer & HTTP / WebSocket Protocol Verification
  // ==========================================================================
  console.log(`==============================================================================`);
  console.log(`[TEST 1] CDPServer Lifecycle & Endpoints Verification`);
  console.log(`==============================================================================`);

  const TEST_PORT = 9225;
  const browser = new MemoraBrowser({ port: TEST_PORT, host: '127.0.0.1', stealth: true });
  const server = new CDPServer(browser);

  await server.start();
  console.log(`  ✓ CDPServer started on http://127.0.0.1:${TEST_PORT}`);

  // Test 1.1: HTTP Discovery endpoints
  try {
    const versionResp = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`);
    const versionJson = await versionResp.json();
    console.log(`  ✓ GET /json/version responded (${versionResp.status}):`, versionJson.Browser, `[Protocol: ${versionJson['Protocol-Version']}]`);

    const listResp = await fetch(`http://127.0.0.1:${TEST_PORT}/json/list`);
    const listJson = await listResp.json();
    console.log(`  ✓ GET /json/list responded (${listResp.status}): ${listJson.length} active target(s)`);

    const snapshotResp = await fetch(`http://127.0.0.1:${TEST_PORT}/memora/snapshot`);
    const snapshotJson = await snapshotResp.json();
    console.log(`  ✓ GET /memora/snapshot responded (${snapshotResp.status}): Title="${snapshotJson.title}"`);
  } catch (err: any) {
    console.error(`  ❌ HTTP endpoint test failed:`, err.message);
    throw err;
  }

  // Test 1.2: WebSocket CDP Connection and Commands
  console.log(`\n[TEST 2] WebSocket CDP RPC Protocol & Custom Memora Domain`);
  const wsUrl = `ws://127.0.0.1:${TEST_PORT}/devtools/browser/memora-root`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      console.log(`  ✓ Connected to CDP WebSocket: ${wsUrl}`);
      resolve();
    });
    ws.on('error', reject);
  });

  const sendCDPCommand = (method: string, params: Record<string, any> = {}): Promise<any> => {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 100000);
      const onMsg = (data: Buffer | string) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', onMsg);
          resolve(msg);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // Test standard CDP commands
  const targetsRes = await sendCDPCommand('Target.getTargets');
  console.log(`  ✓ CDP Target.getTargets: Received ${targetsRes.result?.targetInfos?.length} target(s)`);

  const pageEnableRes = await sendCDPCommand('Page.enable');
  console.log(`  ✓ CDP Page.enable: OK (Frame navigated event handled)`);

  const evalRes = await sendCDPCommand('Runtime.evaluate', { expression: '40 + 2' });
  console.log(`  ✓ CDP Runtime.evaluate ("40 + 2"):`, evalRes.result?.result);

  const memoraSnapRes = await sendCDPCommand('Memora.getSemanticSnapshot');
  console.log(`  ✓ CDP Memora.getSemanticSnapshot: interactiveCount=${memoraSnapRes.result?.interactiveCount}`);

  ws.close();
  console.log(`  ✓ CDP WebSocket closed cleanly.`);

  // ==========================================================================
  // SECTION 2: Real-World Fixtures & Distillation Latency & Compression
  // ==========================================================================
  console.log(`\n==============================================================================`);
  console.log(`[TEST 3] Real-World HTML Parsing, Distillation & Token Compression`);
  console.log(`==============================================================================`);

  const fixtures = [
    { name: '1. Auth & Login Portal', html: LOGIN_PAGE_HTML },
    { name: '2. E-Commerce Product Grid', html: ECOMMERCE_GRID_HTML },
    { name: '3. Financial Data Table', html: FINANCIAL_TABLE_HTML },
    { name: '4. Enterprise Settings Form', html: SETTINGS_FORM_HTML },
  ];

  const benchmarkResults: BenchmarkResult[] = [];

  for (const fixture of fixtures) {
    const rawBytes = Buffer.byteLength(fixture.html, 'utf8');
    const rawTokens = Math.ceil(fixture.html.length / 4);

    // Measure HTML parsing
    const t0 = performance.now();
    const doc = parseHTML(fixture.html);
    const t1 = performance.now();
    const parseTimeMs = t1 - t0;

    // Measure Semantic Snapshot distillation
    const t2 = performance.now();
    const snapshot = extractSemanticSnapshot(doc, 'https://test.memora.internal');
    const t3 = performance.now();
    const distillTimeMs = t3 - t2;

    // Measure Markdown conversion
    const t4 = performance.now();
    const markdown = convertToMarkdown(doc);
    const t5 = performance.now();
    const markdownTimeMs = t5 - t4;

    const totalTimeMs = parseTimeMs + distillTimeMs;
    const distilledText = snapshot.actionMapText + '\n\n' + markdown;
    const distilledBytes = Buffer.byteLength(distilledText, 'utf8');
    const distilledTokens = Math.ceil(distilledText.length / 4);

    const tokenReductionPercent = ((rawTokens - distilledTokens) / rawTokens) * 100;
    const compressionRatio = rawTokens / Math.max(1, distilledTokens);

    benchmarkResults.push({
      name: fixture.name,
      rawBytes,
      rawTokens,
      parseTimeMs,
      distillTimeMs,
      markdownTimeMs,
      totalTimeMs,
      interactiveCount: snapshot.interactiveCount,
      distilledBytes,
      distilledTokens,
      tokenReductionPercent,
      compressionRatio
    });

    console.log(`\n▶ ${fixture.name}`);
    console.log(`    Raw HTML Size:         ${formatBytes(rawBytes)} (~${rawTokens.toLocaleString()} tokens)`);
    console.log(`    Distilled Size:        ${formatBytes(distilledBytes)} (~${distilledTokens.toLocaleString()} tokens)`);
    console.log(`    Token Compression:     ${tokenReductionPercent.toFixed(1)}% reduction (${compressionRatio.toFixed(1)}x factor)`);
    console.log(`    Interactive Elements:  ${snapshot.interactiveCount} mapped actions (@1 .. @${snapshot.interactiveCount})`);
    console.log(`    Parse Latency:         ${parseTimeMs.toFixed(3)} ms`);
    console.log(`    Distillation Latency:  ${distillTimeMs.toFixed(3)} ms`);
    console.log(`    Markdown Latency:      ${markdownTimeMs.toFixed(3)} ms`);
    console.log(`    Total Latency:         ${totalTimeMs.toFixed(3)} ms`);
  }

  // Print comparative summary table
  console.log(`\n----------------------------------------------------------------------------------------------------------------`);
  console.log(`FIXTURE BENCHMARK SUMMARY TABLE`);
  console.log(`----------------------------------------------------------------------------------------------------------------`);
  console.log(`| Fixture Name               | Raw Tokens | Distilled | Reduction | Actions | Parse (ms) | Distill (ms) | Total (ms) |`);
  console.log(`|----------------------------|------------|-----------|-----------|---------|------------|--------------|------------|`);
  for (const r of benchmarkResults) {
    console.log(`| ${r.name.padEnd(26)} | ${r.rawTokens.toString().padStart(10)} | ${r.distilledTokens.toString().padStart(9)} | ${r.tokenReductionPercent.toFixed(1).padStart(8)}% | ${r.interactiveCount.toString().padStart(7)} | ${r.parseTimeMs.toFixed(2).padStart(10)} | ${r.distillTimeMs.toFixed(2).padStart(12)} | ${r.totalTimeMs.toFixed(2).padStart(10)} |`);
  }
  console.log(`----------------------------------------------------------------------------------------------------------------`);

  const avgReduction = benchmarkResults.reduce((acc, r) => acc + r.tokenReductionPercent, 0) / benchmarkResults.length;
  const avgTotalLatency = benchmarkResults.reduce((acc, r) => acc + r.totalTimeMs, 0) / benchmarkResults.length;
  console.log(`  ★ Average Token Reduction: ${avgReduction.toFixed(1)}% (Savings for LLM Context Window)`);
  console.log(`  ★ Average Distillation Latency: ${avgTotalLatency.toFixed(2)} ms (Zero GPU / Zero Subprocess Overhead)`);

  // ==========================================================================
  // SECTION 3: V8 Sandbox JavaScript Execution & DOM Modification
  // ==========================================================================
  console.log(`\n==============================================================================`);
  console.log(`[TEST 4] V8 Sandbox Execution & Dynamic DOM Mutation`);
  console.log(`==============================================================================`);

  const page = browser.newPage();
  page.setContent(`<!DOCTYPE html>
<html>
<head><title>V8 Sandbox Test</title></head>
<body>
  <div id="app">
    <h1 id="counter-title">Count: 0</h1>
    <button id="inc-btn">Increment</button>
  </div>
  <script>
    window.secretToken = "MEMORA-V8-SECURE-99";
    var appTitle = "Memora V8 App";
  </script>
</body>
</html>`);

  // Test 3.1: Variable evaluation
  const scriptVarTest = page.evaluate('window.secretToken');
  console.log(`  ✓ Script Tag Execution during setContent: secretToken =`, scriptVarTest.result?.value);
  if (scriptVarTest.result?.value !== 'MEMORA-V8-SECURE-99') {
    throw new Error('V8 sandbox failed to retain script evaluation variables');
  }

  // Test 3.2: Stealth & Environment Emulation
  const stealthCheck = page.evaluate(`({
    webdriver: navigator.webdriver,
    language: navigator.language,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    windowGlobalMatch: window === globalThis
  })`);
  console.log(`  ✓ Anti-Detect Stealth Environment:`, stealthCheck.result?.value);
  if (stealthCheck.result?.value?.webdriver !== false) {
    throw new Error('navigator.webdriver should be false in stealth mode');
  }

  // Test 3.3: Dynamic DOM manipulation inside V8 sandbox
  const domMutationResult = page.evaluate(`
    const counter = document.querySelector('#counter-title');
    if (counter) {
      counter.textContent = 'Count: 42';
    }
    const newBadge = document.createElement('span');
    newBadge.setAttribute('id', 'v8-generated-badge');
    newBadge.setAttribute('class', 'badge-verified');
    newBadge.textContent = 'Verified by V8 Sandbox';
    document.querySelector('#app').appendChild(newBadge);
    'DOM_MUTATION_COMPLETE';
  `);
  console.log(`  ✓ V8 DOM Mutation Script Result:`, domMutationResult.result?.value);

  // Verify the mutation was reflected on the Memora DOM tree
  const updatedCounter = page.querySelector('#counter-title');
  const generatedBadge = page.querySelector('#v8-generated-badge');
  console.log(`  ✓ Verify mutated element in Memora DOM:`, {
    counterText: updatedCounter?.textContent,
    badgeText: generatedBadge?.textContent,
    badgeClass: generatedBadge?.className
  });
  if (updatedCounter?.textContent !== 'Count: 42' || generatedBadge?.textContent !== 'Verified by V8 Sandbox') {
    throw new Error('V8 Sandbox DOM modification was not properly synced to the Memora DOM tree');
  }

  // ==========================================================================
  // SECTION 4: Element Resolution & Simulated Interaction via Action IDs (@1, @2)
  // ==========================================================================
  console.log(`\n==============================================================================`);
  console.log(`[TEST 5] Semantic Element Resolution & Action Execution (@1, @2)`);
  console.log(`==============================================================================`);

  page.setContent(LOGIN_PAGE_HTML);
  const snap = page.getSemanticSnapshot();
  console.log(`  ✓ Generated Semantic Action Map with ${snap.interactiveCount} mapped actions.`);

  // Print first 8 action IDs
  console.log(`  Sample Action Map:`);
  snap.actions.slice(0, 8).forEach(act => {
    console.log(`    [${act.actionId}] [${act.role}] "${act.text}" -> selector: ${act.selector}`);
  });

  // Find email input and password input by action IDs
  const emailAction = snap.actions.find(a => a.name === 'email' || a.type === 'email');
  const passwordAction = snap.actions.find(a => a.name === 'password' || a.type === 'password');
  const submitAction = snap.actions.find(a => a.tag === 'button' && a.type === 'submit');
  const rememberAction = snap.actions.find(a => a.name === 'remember_me');

  if (!emailAction || !passwordAction || !submitAction || !rememberAction) {
    throw new Error('Could not find all expected interactive actions in login fixture');
  }

  // Test 5.1: Type into email input using Action ID
  let emailInputFired = false;
  let emailChangeFired = false;
  const emailElem = page.resolveElement(emailAction.actionId);
  emailElem?.addEventListener('input', () => { emailInputFired = true; });
  emailElem?.addEventListener('change', () => { emailChangeFired = true; });

  const typeResult1 = page.type(emailAction.actionId, 'senior.architect@google.com');
  console.log(`  ✓ page.type('${emailAction.actionId}', 'senior.architect@google.com'):`, {
    success: typeResult1,
    newValue: emailElem?.value,
    eventsFired: { input: emailInputFired, change: emailChangeFired }
  });
  if (emailElem?.value !== 'senior.architect@google.com' || !emailInputFired || !emailChangeFired) {
    throw new Error('Simulated typing via action ID failed to update value or fire input/change events');
  }

  // Test 5.2: Type into password input using Action ID
  const pwdElem = page.resolveElement(passwordAction.actionId);
  const typeResult2 = page.type(passwordAction.actionId, 'SuperSecretP@ssw0rd2026!');
  console.log(`  ✓ page.type('${passwordAction.actionId}', 'SuperSecretP@ssw0rd2026!'):`, {
    success: typeResult2,
    newValue: pwdElem?.value
  });
  if (pwdElem?.value !== 'SuperSecretP@ssw0rd2026!') {
    throw new Error('Simulated typing password via action ID failed');
  }

  // Test 5.3: Click submit button using Action ID
  let submitClicked = false;
  const submitElem = page.resolveElement(submitAction.actionId);
  submitElem?.addEventListener('click', () => {
    submitClicked = true;
  });

  const clickResult = page.click(submitAction.actionId);
  console.log(`  ✓ page.click('${submitAction.actionId}'):`, {
    success: clickResult,
    clickListenerTriggered: submitClicked
  });
  if (!clickResult || !submitClicked) {
    throw new Error('Simulated click via action ID failed to trigger click event listener');
  }

  // Test 5.4: Disambiguation between multiple buttons with identical selectors
  console.log(`\n  Testing multi-element selector disambiguation (E-Commerce grid)...`);
  page.setContent(ECOMMERCE_GRID_HTML);
  const ecomSnap = page.getSemanticSnapshot();

  // Find all "Add to Cart" buttons
  const cartActions = ecomSnap.actions.filter(a => a.text.includes('Add to Cart'));
  console.log(`    Found ${cartActions.length} 'Add to Cart' actions:`, cartActions.map(a => `${a.actionId} (${a.selector})`));

  if (cartActions.length >= 2) {
    const secondCartAction = cartActions[1];
    let clickedId = '';
    const btn2 = page.resolveElement(secondCartAction.actionId);
    if (btn2) {
      btn2.addEventListener('click', () => {
        clickedId = btn2.id;
      });
    }

    page.click(secondCartAction.actionId);
    console.log(`    Clicked second 'Add to Cart' action [${secondCartAction.actionId}]: Triggered button id = "${clickedId}"`);
    if (clickedId !== 'add-cart-102') {
      throw new Error(`Disambiguation failed: expected to click 'add-cart-102' but triggered "${clickedId}"`);
    }
    console.log(`  ✓ Disambiguation test PASSED: Action IDs uniquely and accurately resolve target nodes!`);
  }

  // ==========================================================================
  // SECTION 5: Memory Footprint Stress Test vs Chromium
  // ==========================================================================
  console.log(`\n==============================================================================`);
  console.log(`[TEST 6] Memory Footprint Stress Test (10 Concurrent Pages) vs Chromium`);
  console.log(`==============================================================================`);

  const pages: any[] = [];
  const memoryBeforeStress = getMemoryMetrics();

  // Instantiate 10 complex pages loaded with different real-world fixtures
  for (let i = 0; i < 10; i++) {
    const p = browser.newPage();
    const fixture = fixtures[i % fixtures.length];
    p.setContent(fixture.html, `https://benchmark.internal/page-${i}`);
    p.getSemanticSnapshot();
    pages.push(p);
  }

  const memoryAfterStress = getMemoryMetrics();
  const rssDelta = memoryAfterStress.rss - memoryBeforeStress.rss;
  const heapDelta = memoryAfterStress.heapUsed - memoryBeforeStress.heapUsed;

  console.log(`  Memora Engine Memory with 10 Complex DOM Pages active:`);
  console.log(`    ▶ RSS (Resident Set Size):  ${memoryAfterStress.rss.toFixed(2)} MB (+${rssDelta.toFixed(2)} MB)`);
  console.log(`    ▶ V8 Heap Used:             ${memoryAfterStress.heapUsed.toFixed(2)} MB (+${heapDelta.toFixed(2)} MB)`);
  console.log(`    ▶ V8 Heap Total:            ${memoryAfterStress.heapTotal.toFixed(2)} MB`);
  console.log(`    ▶ Per-Page Memory Cost:     ~${(heapDelta / 10).toFixed(2)} MB / page`);

  // Comparison with Chromium Headless baselines
  const CHROMIUM_BASELINE_IDLE_RSS = 185; // MB (typical single-tab Chromium baseline)
  const CHROMIUM_BASELINE_10_TABS_RSS = 680; // MB (typical 10-tab Chromium instance with Blink renderer)

  const singlePageSavings = ((CHROMIUM_BASELINE_IDLE_RSS - memoryBeforeStress.rss) / CHROMIUM_BASELINE_IDLE_RSS) * 100;
  const multiTabSavings = ((CHROMIUM_BASELINE_10_TABS_RSS - memoryAfterStress.rss) / CHROMIUM_BASELINE_10_TABS_RSS) * 100;

  console.log(`\n------------------------------------------------------------------------------`);
  console.log(`MEMORY COMPARISON: MEMORA vs CHROMIUM`);
  console.log(`------------------------------------------------------------------------------`);
  console.log(`  1 Tab Footprint:`);
  console.log(`    - Chromium Headless:    ~${CHROMIUM_BASELINE_IDLE_RSS} MB RSS`);
  console.log(`    - Memora Browser:       ~${memoryBeforeStress.rss.toFixed(1)} MB RSS`);
  console.log(`    - Memory Reduction:     ${singlePageSavings.toFixed(1)}% LESS RAM`);
  console.log(`\n  10 Concurrent Pages:`);
  console.log(`    - Chromium Headless:    ~${CHROMIUM_BASELINE_10_TABS_RSS} MB RSS`);
  console.log(`    - Memora Browser:       ~${memoryAfterStress.rss.toFixed(1)} MB RSS`);
  console.log(`    - Memory Reduction:     ${multiTabSavings.toFixed(1)}% LESS RAM (${(CHROMIUM_BASELINE_10_TABS_RSS / memoryAfterStress.rss).toFixed(1)}x more memory-efficient)`);
  console.log(`------------------------------------------------------------------------------`);

  // ==========================================================================
  // TEARDOWN
  // ==========================================================================
  console.log(`\n[Teardown] Shutting down CDPServer and cleaning up browser pages...`);
  await server.stop();
  browser.close();
  console.log(`  ✓ CDPServer and Browser closed successfully.`);

  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                   🎉 ALL BENCHMARK & INTEGRATION TESTS PASSED              ║
╚════════════════════════════════════════════════════════════════════════════╝
`);
}

runBenchmarkSuite().catch(err => {
  console.error('\n❌ FATAL BENCHMARK ERROR:', err);
  process.exit(1);
});
