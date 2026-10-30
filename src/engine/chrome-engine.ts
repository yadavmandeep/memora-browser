import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { parseHTML } from '../dom/parser.js';
import { extractSemanticSnapshot } from '../distiller/semantic-tree.js';
import { convertToMarkdown, MarkdownOptions } from '../distiller/markdown.js';
import { extractStructuredData, StructuredPageData } from '../distiller/structured-data.js';
import { computePageDiff } from '../distiller/diff.js';
import { saveSessionToFile, loadSessionFromFile, validateSessionData } from './session.js';
import { SemanticPageSnapshot, NetworkOptions, SnapshotOptions, PageDiff, FormFillOptions, FormFillResult, SessionData } from '../types/index.js';
import { RobotsStore } from '../network/robots.js';
import { toPlaywrightProxy } from '../network/proxy.js';

export function findSystemChrome(): string | null {
  const candidatePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

export class ChromeEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private logs: Array<{ type: string; text: string; timestamp: number }> = [];
  private actionSelectorMap: Map<string, string> = new Map();
  private lastSnapshot: SemanticPageSnapshot | null = null;
  private chromePath: string;
  private network: NetworkOptions;

  constructor(network: NetworkOptions = {}) {
    const found = findSystemChrome();
    if (!found) {
      throw new Error('No Google Chrome or Microsoft Edge executable found on this machine.');
    }
    this.chromePath = found;
    this.network = network;
    if (network.proxyBearerToken) {
      // Chrome cannot attach Proxy-Authorization to CONNECT tunnels; only basic auth works here
      process.stderr.write('[Memora] --proxy-bearer-token is ignored by the Chrome engine; put user:pass in the proxy URL instead\n');
    }
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        executablePath: this.chromePath,
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-infobars'
        ],
        proxy: toPlaywrightProxy(this.network),
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: this.network.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        extraHTTPHeaders: this.network.headers,
        ignoreHTTPSErrors: this.network.insecureTls,
      });

      if (this.network.obeyRobots) {
        // Same rules as the native engine: every http(s) request, subresources included
        const robots = new RobotsStore({
          agent: this.network.robotsAgent,
          userAgent: this.network.userAgent,
        });
        await this.context.route('**/*', async (route) => {
          const url = route.request().url();
          if (!RobotsStore.robotsUrlFor(url) || await robots.isAllowed(url)) return route.continue();
          this.logs.push({ type: 'warning', text: `[Memora] blocked by robots.txt: ${url}`, timestamp: Date.now() });
          return route.abort('blockedbyclient');
        });
      }

      this.page = await this.context.newPage();

      this.page.on('console', (msg) => {
        this.logs.push({
          type: msg.type(),
          text: msg.text(),
          timestamp: Date.now()
        });
      });

      this.page.on('pageerror', (err) => {
        this.logs.push({
          type: 'error',
          text: `[Page Uncaught Exception]: ${err.message}`,
          timestamp: Date.now()
        });
      });
    }

    return this.page!;
  }

  public async goto(url: string, timeoutMs: number = 20000): Promise<{ status: number; url: string }> {
    const page = await this.ensurePage();
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.network.timeoutMs ?? timeoutMs
    });

    // If an empty SPA root container (#root or #app) exists, wait for React/Vue hydration
    try {
      await page.waitForFunction(() => {
        const root = document.querySelector('#root, #app');
        if (!root) return true; // not an SPA shell, proceed immediately
        return root.children.length > 0; // wait until children mount
      }, { timeout: 2500 });
    } catch {
      // Graceful fallback
    }

    const status = resp ? resp.status() : 200;
    return { status, url: page.url() };
  }

  public async getSemanticSnapshot(options: SnapshotOptions = {}): Promise<SemanticPageSnapshot> {
    const page = await this.ensurePage();
    const html = await page.content();
    const url = page.url();
    const doc = parseHTML(html);
    const snapshot = extractSemanticSnapshot(doc, url, options);

    // Cache actionId -> selector mapping for memora_act
    this.actionSelectorMap.clear();
    for (const act of snapshot.actions) {
      this.actionSelectorMap.set(act.actionId, act.selector);
    }
    this.lastSnapshot = snapshot;

    return snapshot;
  }

  public async getMarkdown(options: MarkdownOptions = {}): Promise<string> {
    const page = await this.ensurePage();
    const html = await page.content();
    const doc = parseHTML(html);
    return convertToMarkdown(doc, options);
  }

  public async diff(previous?: SemanticPageSnapshot, options?: SnapshotOptions): Promise<PageDiff> {
    const prev = previous || this.lastSnapshot;
    const current = await this.getSemanticSnapshot(options);
    return computePageDiff(prev, current);
  }

  public async fillForm(options: FormFillOptions): Promise<FormFillResult> {
    if (options.steps && options.steps.length > 0) {
      const allFilled: string[] = [];
      const allSkipped: string[] = [];
      let anySubmitted = false;
      let lastUrl = '';
      let lastTitle = '';

      for (const step of options.steps) {
        const stepRes = await this.fillForm(step);
        allFilled.push(...stepRes.filled);
        allSkipped.push(...stepRes.skipped);
        if (stepRes.submitted) anySubmitted = true;
        lastUrl = stepRes.url;
        lastTitle = stepRes.title;
        await new Promise(r => setTimeout(r, 50));
      }

      return {
        success: true,
        filled: allFilled,
        skipped: allSkipped,
        fieldsFilled: allFilled.length,
        submitted: anySubmitted,
        url: lastUrl,
        title: lastTitle
      };
    }

    const page = await this.ensurePage();
    const filled: string[] = [];
    const skipped: string[] = [];

    for (const [target, val] of Object.entries(options.fields || {})) {
      let selector = target;
      if (target.startsWith('@')) {
        const mapped = this.actionSelectorMap.get(target);
        if (!mapped) {
          skipped.push(target);
          continue;
        }
        selector = mapped;
      }

      const el = await page.$(selector).catch(() => null);
      if (!el) {
        skipped.push(target);
        continue;
      }

      const tag = await page.$eval(selector, e => e.tagName.toLowerCase()).catch(() => null);
      const inputType = await page.$eval(selector, e => (e.getAttribute('type') || '').toLowerCase()).catch(() => '');

      if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
        const shouldCheck = val === 'true' || val === '1' || val === 'yes' || val === 'checked';
        await page.setChecked(selector, shouldCheck);
      } else if (tag === 'select') {
        await page.selectOption(selector, val);
      } else {
        await page.fill(selector, val);
        await page.dispatchEvent(selector, 'input');
        await page.dispatchEvent(selector, 'change');
      }
      filled.push(target);
    }

    let submitted = false;
    const submitTarget = options.submitActionId ?? options.submit;
    if (submitTarget !== undefined && submitTarget !== false) {
      if (typeof submitTarget === 'string') {
        let submitSelector = submitTarget;
        if (submitTarget.startsWith('@')) {
          submitSelector = this.actionSelectorMap.get(submitTarget) || submitTarget;
        }
        const submitEl = await page.$(submitSelector).catch(() => null);
        if (submitEl) {
          await page.click(submitSelector);
          submitted = true;
          await page.waitForTimeout(200);
        }
      } else if (submitTarget === true && filled.length > 0) {
        const formSubmitBtn = await page.$('button[type="submit"], input[type="submit"]').catch(() => null);
        if (formSubmitBtn) {
          await formSubmitBtn.click();
          submitted = true;
          await page.waitForTimeout(200);
        }
      }
    }

    return {
      success: true,
      filled,
      skipped,
      fieldsFilled: filled.length,
      submitted,
      url: page.url(),
      title: await page.title()
    };
  }

  public async dumpSession(): Promise<SessionData> {
    const page = await this.ensurePage();
    const context = page.context();
    const cList = await context.cookies();
    const cookies: Record<string, string> = {};
    for (const c of cList) cookies[c.name] = c.value;

    const storageDump = await page.evaluate(() => {
      const loc: Record<string, string> = {};
      const sess: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) loc[k] = window.localStorage.getItem(k) || '';
      }
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k) sess[k] = window.sessionStorage.getItem(k) || '';
      }
      return { loc, sess };
    });

    return {
      version: 1,
      createdAt: new Date().toISOString(),
      url: page.url(),
      cookies,
      localStorage: storageDump.loc,
      sessionStorage: storageDump.sess,
    };
  }

  public async restoreSession(session: SessionData): Promise<void> {
    validateSessionData(session);
    const page = await this.ensurePage();
    const context = page.context();

    if (Object.keys(session.cookies).length > 0) {
      const u = new URL(page.url() !== 'about:blank' ? page.url() : session.url);
      const cookieList = Object.entries(session.cookies).map(([name, value]) => ({
        name,
        value,
        domain: u.hostname,
        path: '/'
      }));
      await context.addCookies(cookieList);
    }

    await page.evaluate(({ loc, sess }) => {
      for (const [k, v] of Object.entries(loc)) {
        window.localStorage.setItem(k, v as string);
      }
      for (const [k, v] of Object.entries(sess)) {
        window.sessionStorage.setItem(k, v as string);
      }
    }, { loc: session.localStorage, sess: session.sessionStorage });
  }

  public async saveSession(filePath: string): Promise<void> {
    const data = await this.dumpSession();
    saveSessionToFile(filePath, data);
  }

  public async loadSession(filePath: string): Promise<void> {
    const data = loadSessionFromFile(filePath);
    await this.restoreSession(data);
  }

  public async getStructuredData(): Promise<StructuredPageData> {
    const page = await this.ensurePage();
    const html = await page.content();
    const doc = parseHTML(html);
    return extractStructuredData(doc, page.url());
  }

  public async act(target: string, type: 'click' | 'type', text?: string): Promise<{ success: boolean; url: string; title: string }> {
    const page = await this.ensurePage();
    let selector = target;

    if (target.startsWith('@')) {
      const mapped = this.actionSelectorMap.get(target);
      if (!mapped) {
        throw new Error(`Action ID "${target}" not found in current snapshot. Run memora_inspect to view active action IDs.`);
      }
      selector = mapped;
    }

    if (type === 'type') {
      await page.fill(selector, text || '');
      // Fire change and input events
      await page.dispatchEvent(selector, 'input');
      await page.dispatchEvent(selector, 'change');
    } else {
      await page.click(selector);
    }

    // Give time for any navigation or state transition
    await page.waitForTimeout(600);

    return {
      success: true,
      url: page.url(),
      title: await page.title()
    };
  }

  public async inspect(): Promise<SemanticPageSnapshot> {
    return this.getSemanticSnapshot();
  }

  public async extract(selector: string, attribute?: string, limit: number = 50): Promise<any[]> {
    const page = await this.ensurePage();
    const elements = await page.$$(selector);
    const sliced = elements.slice(0, limit);
    const results: any[] = [];

    for (const el of sliced) {
      if (attribute === 'text' || attribute === 'textContent') {
        const txt = await el.innerText();
        results.push(txt.trim());
      } else if (attribute === 'html' || attribute === 'innerHTML') {
        const h = await el.innerHTML();
        results.push(h);
      } else if (attribute) {
        const attrVal = await el.getAttribute(attribute);
        results.push(attrVal);
      } else {
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        const text = (await el.innerText()).trim();
        results.push({ tag, text });
      }
    }

    return results;
  }

  public async storage(storageType: 'local' | 'session', action: string, key?: string, value?: string): Promise<string> {
    const page = await this.ensurePage();
    return await page.evaluate(({ type, act, k, v }) => {
      const store = type === 'session' ? window.sessionStorage : window.localStorage;
      switch (act) {
        case 'get':
          return store.getItem(k || '') ?? `Key "${k}" not found`;
        case 'set':
          if (!k || v === undefined) throw new Error('Key and value required');
          store.setItem(k, v);
          return `Set ${type}Storage["${k}"] = "${v}"`;
        case 'remove':
          if (!k) throw new Error('Key required');
          store.removeItem(k);
          return `Removed "${k}" from ${type}Storage`;
        case 'clear':
          store.clear();
          return `Cleared ${type}Storage`;
        case 'list': {
          const out: Record<string, string> = {};
          for (let i = 0; i < store.length; i++) {
            const itemKey = store.key(i);
            if (itemKey) out[itemKey] = store.getItem(itemKey) || '';
          }
          return JSON.stringify(out, null, 2);
        }
        default:
          throw new Error(`Unknown action: ${act}`);
      }
    }, { type: storageType, act: action, k: key, v: value });
  }

  public async cookies(action: string, name?: string, value?: string): Promise<string> {
    const page = await this.ensurePage();
    const context = page.context();

    switch (action) {
      case 'list': {
        const cList = await context.cookies();
        const dump: Record<string, string> = {};
        for (const c of cList) dump[c.name] = c.value;
        return JSON.stringify(dump, null, 2);
      }
      case 'set': {
        if (!name || value === undefined) throw new Error('Cookie name and value required');
        const u = new URL(page.url());
        await context.addCookies([{
          name,
          value,
          domain: u.hostname,
          path: '/'
        }]);
        return `Cookie "${name}" set`;
      }
      case 'clear': {
        await context.clearCookies();
        return 'All cookies cleared';
      }
      default:
        throw new Error(`Cookie action "${action}" not supported`);
    }
  }

  public getLogs(clear: boolean = false): Array<{ type: string; text: string; timestamp: number }> {
    const copy = [...this.logs];
    if (clear) {
      this.logs.length = 0;
    }
    return copy;
  }

  public async reload(): Promise<{ status: number; url: string }> {
    const page = await this.ensurePage();
    const resp = await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    return { status: resp ? resp.status() : 200, url: page.url() };
  }

  public async html(selector?: string): Promise<string> {
    const page = await this.ensurePage();
    if (selector) {
      const el = await page.$(selector);
      if (!el) return `Element "${selector}" not found.`;
      return await el.evaluate(e => e.outerHTML);
    }
    return await page.content();
  }

  public async evaluate(code: string): Promise<any> {
    const page = await this.ensurePage();
    try {
      return await page.evaluate(code);
    } catch {
      return await page.evaluate((script) => {
        try {
          return window.eval(script);
        } catch (e: any) {
          return { error: e.message || String(e) };
        }
      }, code);
    }
  }

  public async fork(): Promise<string> {
    const page = await this.ensurePage();
    const context = page.context();
    const newPage = await context.newPage();
    await newPage.goto(page.url(), { waitUntil: 'load' });
    this.page = newPage;
    return `Forked tab created! Switched active context to new tab at ${page.url()}`;
  }

  public async waitForSelector(
    selector: string,
    options: { timeoutMs?: number; state?: 'attached' | 'visible' } = {}
  ): Promise<void> {
    const page = await this.ensurePage();
    let actualSelector = selector;
    if (selector.startsWith('@')) {
      const mapped = this.actionSelectorMap.get(selector);
      if (mapped) actualSelector = mapped;
    }
    await page.waitForSelector(actualSelector, {
      state: options.state || 'visible',
      timeout: options.timeoutMs || 5000
    });
  }

  public async waitForFunction(
    fn: string | (() => boolean),
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<boolean> {
    const page = await this.ensurePage();
    await page.waitForFunction(fn as any, null, {
      timeout: options.timeoutMs || 5000,
      polling: options.pollIntervalMs || 50
    });
    return true;
  }

  public async settleOnDOMMutation(options: { quietPeriodMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
    const page = await this.ensurePage();
    try {
      await page.waitForLoadState('networkidle', { timeout: options.timeoutMs || 2500 });
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
