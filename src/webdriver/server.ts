import http from 'node:http';
import crypto from 'node:crypto';
import * as CSSselect from 'css-select';
import { MemoraBrowser } from '../engine/browser.js';
import { MemoraPage } from '../engine/page.js';
import { MemoraDocument, MemoraElement, MemoraNode, MemoraTextNode } from '../dom/node.js';
import { memoraAdapter } from '../dom/selector.js';
import { evaluateXPath, XPathError } from '../dom/xpath.js';
import { NetworkOptions } from '../types/index.js';
import { redactProxyUrl } from '../network/proxy.js';

// W3C WebDriver Classic (https://www.w3.org/TR/webdriver2/) on top of the native Memora engine,
// so Selenium / WebdriverIO / Nightwatch suites run without chromedriver.

export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const SHADOW_KEY = 'shadow-6066-11e4-a52e-4f735466cecf';
const BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const WINDOW_RECT = { x: 0, y: 0, width: 1280, height: 800 };

export interface WebDriverServerOptions {
  port?: number;
  host?: string;
  stealth?: boolean;
  network?: NetworkOptions;
  maxSessions?: number;
  // Sessions untouched for this long are closed (a forgotten driver.quit() frees its slot)
  sessionIdleTimeoutMs?: number;
}

class WebDriverError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

const err = {
  invalidArgument: (m: string) => new WebDriverError('invalid argument', m, 400),
  invalidSelector: (m: string) => new WebDriverError('invalid selector', m, 400),
  noSuchElement: (m: string) => new WebDriverError('no such element', m, 404),
  noSuchFrame: (m: string) => new WebDriverError('no such frame', m, 404),
  noSuchWindow: (m: string) => new WebDriverError('no such window', m, 404),
  noSuchAlert: () => new WebDriverError('no such alert', 'No alert is open (alerts are not supported yet)', 404),
  noSuchCookie: (m: string) => new WebDriverError('no such cookie', m, 404),
  noSuchShadowRoot: () => new WebDriverError('no such shadow root', 'Shadow DOM is not supported yet', 404),
  invalidSession: (m: string) => new WebDriverError('invalid session id', m, 404),
  stale: (m: string) => new WebDriverError('stale element reference', m, 404),
  notInteractable: (m: string) => new WebDriverError('element not interactable', m, 400),
  invalidCookieDomain: (m: string) => new WebDriverError('invalid cookie domain', m, 400),
  javascript: (m: string) => new WebDriverError('javascript error', m, 500),
  scriptTimeout: (m: string) => new WebDriverError('script timeout', m, 500),
  timeout: (m: string) => new WebDriverError('timeout', m, 500),
  sessionNotCreated: (m: string) => new WebDriverError('session not created', m, 500),
  unknownCommand: (m: string) => new WebDriverError('unknown command', m, 404),
  unsupported: (m: string) => new WebDriverError('unsupported operation', m, 500),
  unknown: (m: string) => new WebDriverError('unknown error', m, 500),
};

const NON_RENDERED = new Set(['head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link', 'base']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol',
  'p', 'pre', 'section', 'summary', 'table', 'tr', 'ul', 'body', 'html', 'option', 'select', 'tbody', 'thead',
]);
const BOOLEAN_ATTRS = new Set([
  'async', 'autofocus', 'autoplay', 'checked', 'compact', 'complete', 'controls', 'declare', 'defaultchecked',
  'defaultselected', 'defer', 'disabled', 'draggable', 'ended', 'formnovalidate', 'hidden', 'indeterminate',
  'iscontenteditable', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nohref', 'noresize', 'noshade',
  'novalidate', 'nowrap', 'open', 'paused', 'pubdate', 'readonly', 'required', 'reversed', 'scoped', 'seamless',
  'seeking', 'selected', 'truespeed', 'willvalidate',
]);

// Selenium key codepoints (https://www.w3.org/TR/webdriver2/#keyboard-actions)
const KEY = {
  BACKSPACE: '\uE003', TAB: '\uE004', RETURN: '\uE006', ENTER: '\uE007', SPACE: '\uE00D', DELETE: '\uE017',
};

function inlineStyle(el: MemoraElement, prop: string): string | null {
  const style = el.getAttribute('style');
  if (!style) return null;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx > 0 && decl.slice(0, idx).trim().toLowerCase() === prop) {
      return decl.slice(idx + 1).replace(/!important/i, '').trim().toLowerCase();
    }
  }
  return null;
}

function isAttached(el: MemoraElement, doc: MemoraDocument): boolean {
  let cur: MemoraElement | null = el;
  while (cur) {
    if (cur === doc) return true;
    cur = cur.parentNode;
  }
  return false;
}

// Without layout we only know what markup and inline styles say; stylesheet rules are not applied
export function isDisplayed(el: MemoraElement): boolean {
  if (el.tagName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
  let cur: MemoraElement | null = el;
  while (cur && cur.nodeType === 1) {
    if (NON_RENDERED.has(cur.tagName)) return false;
    if (cur.hasAttribute('hidden')) return false;
    if (inlineStyle(cur, 'display') === 'none') return false;
    if (cur === el && ['hidden', 'collapse'].includes(inlineStyle(cur, 'visibility') || '')) return false;
    if (cur === el && inlineStyle(cur, 'opacity') === '0') return false;
    if (cur.tagName === 'details' && cur !== el && !cur.hasAttribute('open')) {
      const summary = el.tagName === 'summary' || closestTag(el, 'summary');
      if (!summary) return false;
    }
    cur = cur.parentNode;
  }
  return true;
}

function closestTag(el: MemoraElement, tag: string): MemoraElement | null {
  let cur: MemoraElement | null = el;
  while (cur && cur.nodeType === 1) {
    if (cur.tagName === tag) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Rendered text roughly as innerText: hidden subtrees skipped, blocks on their own lines
export function visibleText(el: MemoraElement): string {
  if (!isDisplayed(el)) return '';
  const out: string[] = [];
  const walk = (n: MemoraNode) => {
    if (n instanceof MemoraTextNode) {
      out.push(n.data);
      return;
    }
    if (!(n instanceof MemoraElement)) return;
    if (n !== el && !isDisplayed(n)) return;
    if (n.tagName === 'br') { out.push('\n'); return; }
    const block = BLOCK_TAGS.has(n.tagName);
    if (block) out.push('\n');
    if (n.tagName === 'td' || n.tagName === 'th') out.push(' ');
    for (const c of n.childNodes) walk(c);
    if (block) out.push('\n');
  };
  walk(el);
  if (el.tagName === 'pre') return out.join('').replace(/^\n+|\n+$/g, '');
  return out.join('')
    .split('\n')
    .map(line => line.replace(/[ \t\r\fÂ ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function isEnabled(el: MemoraElement): boolean {
  if (el.hasAttribute('disabled')) return false;
  const fieldset = closestTag(el.parentNode || el, 'fieldset');
  if (fieldset && fieldset !== el && fieldset.hasAttribute('disabled')) {
    const legend = fieldset.querySelector('legend');
    if (!legend || !isAttachedUnder(el, legend)) return false;
  }
  if (el.tagName === 'option') {
    const select = closestTag(el, 'select');
    if (select && select.hasAttribute('disabled')) return false;
  }
  return true;
}

function isAttachedUnder(el: MemoraElement, ancestor: MemoraElement): boolean {
  let cur: MemoraElement | null = el;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode;
  }
  return false;
}

function isSelected(el: MemoraElement): boolean {
  if (el.tagName === 'option') return el.hasAttribute('selected');
  if (el.tagName === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return el.hasAttribute('checked');
  }
  return false;
}

function isTextEditable(el: MemoraElement): boolean {
  if (el.tagName === 'textarea') return true;
  if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') return true;
  if (el.tagName !== 'input') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'hidden', 'file'].includes(type);
}

interface Timeouts {
  implicit: number;
  pageLoad: number;
  script: number | null;
}

class Session {
  public readonly id = crypto.randomUUID();
  public readonly browser: MemoraBrowser;
  public current: MemoraPage;
  public timeouts: Timeouts = { implicit: 0, pageLoad: 300000, script: 30000 };
  public activeElement: MemoraElement | null = null;
  public lastUsed = Date.now();
  private elements: Map<string, { el: MemoraElement; page: MemoraPage }> = new Map();
  private ids: WeakMap<MemoraElement, string> = new WeakMap();
  private staleIds: Set<string> = new Set();
  private pointer: { target: MemoraElement | null; downTarget: MemoraElement | null } = { target: null, downTarget: null };

  constructor(public readonly capabilities: Record<string, any>, stealth: boolean, network: NetworkOptions) {
    this.browser = new MemoraBrowser({ stealth, network });
    this.current = this.openWindow();
  }

  public openWindow(): MemoraPage {
    const page = this.browser.newPage();
    page.setContent('<html><head></head><body></body></html>', 'about:blank');
    return page;
  }

  public page(): MemoraPage {
    if (!this.browser.getPage(this.current.id)) throw err.noSuchWindow('The current window has been closed');
    return this.current;
  }

  public ref(el: MemoraElement, page: MemoraPage = this.page()): Record<string, string> {
    let id = this.ids.get(el);
    if (!id || !this.elements.has(id)) {
      id = crypto.randomUUID();
      this.ids.set(el, id);
      this.elements.set(id, { el, page });
    }
    return { [ELEMENT_KEY]: id };
  }

  public element(id: string): MemoraElement {
    const entry = this.elements.get(id);
    if (!entry) {
      if (this.staleIds.has(id)) throw err.stale(`Element ${id} is no longer attached to the DOM`);
      throw err.noSuchElement(`No element with id ${id} is known in this session`);
    }
    const page = this.page();
    if (entry.page !== page) throw err.noSuchElement(`Element ${id} belongs to another window`);
    if (!isAttached(entry.el, page.document)) {
      this.forget(id);
      throw err.stale(`Element ${id} is no longer attached to the DOM`);
    }
    return entry.el;
  }

  private forget(id: string): void {
    this.elements.delete(id);
    this.staleIds.add(id);
  }

  // Drops references into documents that were navigated away from
  public prune(): void {
    for (const [id, { el, page }] of this.elements) {
      if (!this.browser.getPage(page.id) || !isAttached(el, page.document)) this.forget(id);
    }
    if (this.activeElement && !isAttached(this.activeElement, this.current.document)) this.activeElement = null;
  }

  public get pointerState() {
    return this.pointer;
  }

  public close(): void {
    this.browser.close();
    this.elements.clear();
  }
}

type Handler = (session: Session, params: Record<string, string>, body: any) => Promise<any> | any;

export class WebDriverServer {
  private server: http.Server;
  private sessions: Map<string, Session> = new Map();
  private routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler | null; raw?: (body: any) => any }> = [];
  private readonly options: Required<Pick<WebDriverServerOptions, 'port' | 'host' | 'maxSessions' | 'sessionIdleTimeoutMs'>> & WebDriverServerOptions;
  private reaper: NodeJS.Timeout | null = null;

  constructor(options: WebDriverServerOptions = {}) {
    this.options = {
      port: 9222,
      host: 'localhost',
      maxSessions: 16,
      sessionIdleTimeoutMs: 5 * 60 * 1000,
      ...options,
    };
    this.registerRoutes();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(e => this.sendError(res, err.unknown(e?.message || String(e))));
    });
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      const bindHost = (this.options.host === 'localhost' || this.options.host === '127.0.0.1') ? '0.0.0.0' : this.options.host;
      this.server.listen(this.options.port, bindHost, () => resolve());
    });
    if (this.options.sessionIdleTimeoutMs > 0) {
      this.reaper = setInterval(() => {
        const cutoff = Date.now() - this.options.sessionIdleTimeoutMs;
        for (const [id, s] of this.sessions) {
          if (s.lastUsed < cutoff) {
            s.close();
            this.sessions.delete(id);
          }
        }
      }, 5000);
      this.reaper.unref();
    }
  }

  public async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------- HTTP plumbing

  private route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, pattern, keys, handler });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    // Accept the legacy Grid prefix so http://host:port/wd/hub URLs keep working
    const path = url.pathname.replace(/^\/wd\/hub/, '').replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    const raw = await new Promise<string>((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    let body: any = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return this.sendError(res, err.invalidArgument('Request body is not valid JSON'));
      }
    }

    if (process.env.DEBUG_WEBDRIVER) {
      process.stderr.write(`[WebDriver] ${method} ${path} ${raw.slice(0, 200)}\n`);
    }

    try {
      if (method === 'GET' && path === '/status') {
        return this.send(res, {
          ready: this.sessions.size < this.options.maxSessions,
          message: this.sessions.size < this.options.maxSessions ? 'Memora WebDriver is ready' : 'Session limit reached',
          build: { version: '0.1.2', engine: 'memora-native' },
        });
      }
      if (method === 'POST' && path === '/session') {
        return this.send(res, this.newSession(body));
      }

      const sessionMatch = path.match(/^\/session\/([^/]+)(\/.*)?$/);
      if (!sessionMatch) throw err.unknownCommand(`Unknown command: ${method} ${path}`);
      const [, sessionId, rest = ''] = sessionMatch;

      const session = this.sessions.get(sessionId);
      if (!session) throw err.invalidSession(`Session ${sessionId} does not exist or was closed`);
      session.lastUsed = Date.now();

      if (method === 'DELETE' && rest === '') {
        session.close();
        this.sessions.delete(sessionId);
        return this.send(res, null);
      }

      for (const r of this.routes) {
        if (r.method !== method) continue;
        const m = rest.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const value = await r.handler!(session, params, body);
        if (!this.sessions.has(sessionId)) session.close();
        return this.send(res, value === undefined ? null : value);
      }
      throw err.unknownCommand(`Unknown command: ${method} /session/{id}${rest}`);
    } catch (e: any) {
      if (e instanceof WebDriverError) return this.sendError(res, e);
      return this.sendError(res, err.unknown(e?.message || String(e)));
    }
  }

  private send(res: http.ServerResponse, value: any): void {
    const payload = JSON.stringify({ value });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(payload);
  }

  private sendError(res: http.ServerResponse, e: WebDriverError): void {
    if (res.headersSent) return;
    res.writeHead(e.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ value: { error: e.code, message: e.message, stacktrace: '' } }));
  }

  // ---------------------------------------------------------------- Sessions & capabilities

  private newSession(body: any): any {
    if (this.sessions.size >= this.options.maxSessions) {
      throw err.sessionNotCreated(`Maximum number of sessions (${this.options.maxSessions}) reached. Call driver.quit() after each test or raise --max-sessions.`);
    }
    const caps = body?.capabilities || {};
    const always = caps.alwaysMatch || {};
    const first: any[] = Array.isArray(caps.firstMatch) && caps.firstMatch.length ? caps.firstMatch : [{}];
    const merged = { ...always, ...first[0] };

    const network: NetworkOptions = { ...(this.options.network || {}) };
    if (merged.acceptInsecureCerts) network.insecureTls = true;
    const proxyCap = merged.proxy;
    if (proxyCap && typeof proxyCap === 'object') Object.assign(network, proxyFromCapability(proxyCap));

    const timeouts: Timeouts = { implicit: 0, pageLoad: 300000, script: 30000 };
    if (merged.timeouts) applyTimeouts(timeouts, merged.timeouts);

    const session = new Session(merged, this.options.stealth !== false, network);
    session.timeouts = timeouts;
    this.sessions.set(session.id, session);

    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    return {
      sessionId: session.id,
      capabilities: {
        browserName: merged.browserName || 'memora',
        browserVersion: '0.1.2',
        platformName: platform,
        acceptInsecureCerts: !!network.insecureTls,
        pageLoadStrategy: merged.pageLoadStrategy || 'normal',
        proxy: network.proxy ? { proxyType: 'manual', httpProxy: redactProxyUrl(network.proxy) } : {},
        setWindowRect: false,
        strictFileInteractability: false,
        timeouts,
        unhandledPromptBehavior: 'dismiss and notify',
        'memora:engine': 'native',
      },
    };
  }

  // ---------------------------------------------------------------- Element lookup

  private findAll(session: Session, using: string, value: string, root: MemoraElement): MemoraElement[] {
    if (typeof using !== 'string' || typeof value !== 'string') {
      throw err.invalidArgument('Locator needs string "using" and "value"');
    }
    const doc = session.page().document;
    switch (using) {
      case 'css selector':
        try {
          return CSSselect.selectAll(value, root.childNodes, { adapter: memoraAdapter });
        } catch (e: any) {
          throw err.invalidSelector(`Invalid CSS selector "${value}": ${e.message}`);
        }
      case 'tag name':
        return root.querySelectorAll(value.toLowerCase());
      case 'link text':
      case 'partial link text': {
        const links = root.querySelectorAll('a');
        return links.filter(a => {
          const text = visibleText(a);
          return using === 'link text' ? text === value : text.includes(value);
        });
      }
      case 'xpath':
        try {
          return evaluateXPath(value, root, doc);
        } catch (e: any) {
          if (e instanceof XPathError) throw err.invalidSelector(e.message);
          throw e;
        }
      default:
        throw err.invalidArgument(`Unsupported locator strategy "${using}"`);
    }
  }

  // Implicit wait: poll until something matches or the implicit timeout runs out
  private async find(session: Session, body: any, root: MemoraElement | null, multiple: boolean): Promise<any> {
    const deadline = Date.now() + (session.timeouts.implicit || 0);
    for (;;) {
      const scope = root || session.page().document;
      const found = this.findAll(session, body?.using, body?.value, scope);
      if (found.length || Date.now() >= deadline) {
        if (multiple) return found.map(el => session.ref(el));
        if (!found.length) throw err.noSuchElement(`Unable to locate element: {"method":"${body?.using}","selector":"${body?.value}"}`);
        return session.ref(found[0]);
      }
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  }

  // ---------------------------------------------------------------- Interaction

  private async navigate(session: Session, fn: () => Promise<unknown>): Promise<void> {
    const timeout = session.timeouts.pageLoad;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(err.timeout(`Page load timed out after ${timeout}ms`)), timeout); }),
      ]);
    } catch (e: any) {
      if (e instanceof WebDriverError) throw e;
      if (/timeout/i.test(e?.message || '')) throw err.timeout(e.message);
      throw err.unknown(`Navigation failed: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
      session.prune();
    }
  }

  private async click(session: Session, el: MemoraElement): Promise<void> {
    if (!isDisplayed(el)) throw err.notInteractable('Element is not displayed');
    const page = session.page();
    session.activeElement = el;
    el.focus();
    if (!isEnabled(el)) return;
    await this.navigate(session, () => page.activate(el));
  }

  private async typeInto(session: Session, el: MemoraElement, text: string): Promise<void> {
    const page = session.page();
    session.activeElement = el;
    el.focus();

    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'input' && type === 'file') {
      el.setAttribute('value', text.split('\n').map(p => p.split(/[\\/]/).pop()).join(','));
      el.dispatchEvent({ type: 'input', target: el, bubbles: true });
      el.dispatchEvent({ type: 'change', target: el, bubbles: true });
      return;
    }
    if (el.tagName === 'select') {
      const option = el.querySelectorAll('option').find(o => visibleText(o).toLowerCase().startsWith(text.toLowerCase()));
      if (option) page.selectOption(option);
      return;
    }

    const editable = el.getAttribute('contenteditable') !== null && el.tagName !== 'input' && el.tagName !== 'textarea';
    const read = () => editable ? el.textContent : (el.tagName === 'textarea' && !el.hasAttribute('value') ? el.textContent : el.value);
    const write = (v: string) => { if (editable) el.textContent = v; else el.value = v; };
    const keyEvent = (kind: string, key: string) =>
      el.dispatchEvent({ type: kind, key, target: el, bubbles: true, cancelable: true });

    let changed = false;
    for (const ch of Array.from(text)) {
      if (ch === KEY.ENTER || ch === KEY.RETURN) {
        if (el.tagName === 'textarea' || editable) {
          write(read() + '\n');
          changed = true;
          continue;
        }
        if (changed) el.dispatchEvent({ type: 'change', target: el, bubbles: true });
        changed = false;
        if (keyEvent('keydown', 'Enter')) await this.implicitSubmit(session, el);
        return;
      }
      if (ch === KEY.BACKSPACE) {
        write(read().slice(0, -1));
        changed = true;
        el.dispatchEvent({ type: 'input', target: el, bubbles: true });
        continue;
      }
      if (ch === KEY.SPACE) {
        if (!isTextEditable(el) && el.tagName === 'input' && (type === 'checkbox' || type === 'radio')) {
          await page.activate(el);
          continue;
        }
      } else if (ch >= '\uE000' && ch <= '\uF8FF') {
        // Other modifier/navigation keys have no effect without layout
        continue;
      }
      const char = ch === KEY.SPACE ? ' ' : ch;
      if (!keyEvent('keydown', char)) continue;
      if (isTextEditable(el)) {
        const max = parseInt(el.getAttribute('maxlength') || '', 10);
        if (!(max >= 0 && read().length >= max)) {
          write(read() + char);
          changed = true;
          el.dispatchEvent({ type: 'input', target: el, bubbles: true, data: char });
        }
      }
      keyEvent('keyup', char);
    }
    if (changed) el.dispatchEvent({ type: 'change', target: el, bubbles: true });
  }

  // Enter in a text field clicks the form's default button, or submits if there is none
  private async implicitSubmit(session: Session, el: MemoraElement): Promise<void> {
    const page = session.page();
    const form = page.formOwner(el);
    if (!form) return;
    const submit = form.querySelectorAll('button, input').find(b => {
      const t = (b.getAttribute('type') || '').toLowerCase();
      return b.tagName === 'button' ? (t === '' || t === 'submit') : (t === 'submit' || t === 'image');
    });
    if (submit) {
      if (isEnabled(submit)) await this.navigate(session, () => page.activate(submit));
      return;
    }
    await this.navigate(session, () => page.submitForm(form));
  }

  // ---------------------------------------------------------------- Script execution

  private deserialize(session: Session, value: any): any {
    if (Array.isArray(value)) return value.map(v => this.deserialize(session, v));
    if (value && typeof value === 'object') {
      if (typeof value[ELEMENT_KEY] === 'string') return session.element(value[ELEMENT_KEY]);
      if (typeof value.ELEMENT === 'string') return session.element(value.ELEMENT);
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.deserialize(session, v);
      return out;
    }
    return value;
  }

  private serialize(session: Session, value: any, seen: Set<any> = new Set()): any {
    if (value === undefined || value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (t === 'bigint') return Number(value);
    if (t === 'function' || t === 'symbol') return null;
    if (value instanceof MemoraElement) {
      if (value instanceof MemoraDocument) return session.ref(value.documentElement);
      return session.ref(value);
    }
    if (value instanceof MemoraTextNode) return value.data;
    if (seen.has(value)) throw err.javascript('Cyclic object value cannot be serialized');
    seen.add(value);
    try {
      if (typeof value.toJSON === 'function') return this.serialize(session, value.toJSON(), seen);
      if (Array.isArray(value) || (typeof value.length === 'number' && typeof value !== 'string' && typeof value.item === 'function')) {
        return Array.from(value as ArrayLike<any>).map(v => this.serialize(session, v, seen));
      }
      const out: Record<string, any> = {};
      for (const k of Object.keys(value)) out[k] = this.serialize(session, value[k], seen);
      return out;
    } finally {
      seen.delete(value);
    }
  }

  // Selenium clients inline their JS "atoms" (getAttribute, isDisplayed) via execute/sync.
  // Those need layout and full DOM APIs, so they are answered natively instead.
  private atom(session: Session, script: string, args: any[]): { handled: boolean; value?: any } {
    const marker = script.match(/^\s*\/\*\s*(\w+)\s*\*\//);
    if (!marker) return { handled: false };
    const el = args[0];
    if (!(el instanceof MemoraElement)) return { handled: false };
    switch (marker[1]) {
      case 'isDisplayed':
        return { handled: true, value: isDisplayed(el) };
      case 'getAttribute':
        return { handled: true, value: this.atomAttribute(session, el, String(args[1])) };
      default:
        return { handled: false };
    }
  }

  private atomAttribute(session: Session, el: MemoraElement, name: string): string | null {
    const lower = name.toLowerCase();
    if (lower === 'style') return el.getAttribute('style');
    if (lower === 'selected' || lower === 'checked') return isSelected(el) ? 'true' : null;
    if (BOOLEAN_ATTRS.has(lower)) return el.hasAttribute(lower) ? 'true' : null;
    if (lower === 'class' || lower === 'classname') return el.getAttribute('class');
    if (lower === 'value' || lower === 'href' || lower === 'src' || lower === 'innertext' || lower === 'textcontent') {
      const prop = this.property(session, el, lower === 'innertext' ? 'innerText' : lower === 'textcontent' ? 'textContent' : lower);
      return prop === null || prop === undefined ? null : String(prop);
    }
    return el.getAttribute(name);
  }

  private property(session: Session, el: MemoraElement, name: string): any {
    const page = session.page();
    switch (name) {
      case 'value':
        if (el.tagName === 'textarea') return el.hasAttribute('value') ? el.value : el.textContent;
        if (el.tagName === 'select') {
          const sel = el.querySelectorAll('option').find(o => o.hasAttribute('selected')) || el.querySelector('option');
          return sel ? (sel.getAttribute('value') ?? sel.textContent.trim()) : '';
        }
        if (el.tagName === 'option') return el.getAttribute('value') ?? el.textContent.trim();
        if (el.tagName === 'input') {
          const type = (el.getAttribute('type') || '').toLowerCase();
          if ((type === 'checkbox' || type === 'radio') && !el.hasAttribute('value')) return 'on';
          return el.value;
        }
        return el.hasAttribute('value') ? el.value : undefined;
      case 'checked':
      case 'selected':
        return isSelected(el);
      case 'disabled':
        return !isEnabled(el);
      case 'tagName':
      case 'nodeName':
        return el.tagName.toUpperCase();
      case 'localName':
        return el.tagName;
      case 'textContent':
        return el.textContent;
      case 'innerText':
        return visibleText(el);
      case 'innerHTML':
        return el.innerHTML;
      case 'outerHTML':
        return el.outerHTML;
      case 'id':
        return el.id;
      case 'className':
        return el.className;
      case 'href':
      case 'src':
      case 'action': {
        const raw = el.getAttribute(name);
        if (raw === null) return name === 'action' ? page.url : undefined;
        try { return new URL(raw, page.url).toString(); } catch { return raw; }
      }
      case 'type':
        return el.tagName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.getAttribute('type');
      case 'isConnected':
        return isAttached(el, page.document);
      case 'childElementCount':
        return el.childNodes.filter(c => c instanceof MemoraElement).length;
      default: {
        const direct = (el as any)[name];
        if (direct !== undefined && typeof direct !== 'function' && typeof direct !== 'object') return direct;
        const attr = el.getAttribute(name);
        return attr === null ? null : attr;
      }
    }
  }

  private async runScript(session: Session, body: any, async: boolean): Promise<any> {
    if (typeof body?.script !== 'string' || !Array.isArray(body?.args)) {
      throw err.invalidArgument('execute requires "script" (string) and "args" (array)');
    }
    const page = session.page();
    const args = this.deserialize(session, body.args);

    if (!async) {
      const atom = this.atom(session, body.script, args);
      if (atom.handled) return atom.value;
    }

    const scriptTimeout = session.timeouts.script ?? 2147483647;
    let result: any;
    try {
      if (async) {
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(err.scriptTimeout(`Async script did not complete within ${scriptTimeout}ms`)), scriptTimeout);
          const done = (v: any) => { clearTimeout(timer); resolve(v); };
          try {
            page.sandbox.callFunction(body.script, [...args, done], scriptTimeout);
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });
      } else {
        result = page.sandbox.callFunction(body.script, args, scriptTimeout);
        if (result && typeof result.then === 'function') {
          result = await Promise.race([
            result,
            sleep(scriptTimeout).then(() => { throw err.scriptTimeout(`Script promise did not settle within ${scriptTimeout}ms`); }),
          ]);
        }
      }
    } catch (e: any) {
      if (e instanceof WebDriverError) throw e;
      if (/Script execution timed out/i.test(e?.message || '')) throw err.scriptTimeout(e.message);
      throw err.javascript(e?.message || String(e));
    }

    const serialized = this.serialize(session, result);
    // A script that assigned window.location navigates once it returns
    const pending = page.sandbox.takePendingNavigation();
    if (pending) await this.navigate(session, () => page.goto(pending));
    return serialized;
  }

  // ---------------------------------------------------------------- Input actions

  private async performActions(session: Session, body: any): Promise<void> {
    const sources: any[] = body?.actions;
    if (!Array.isArray(sources)) throw err.invalidArgument('"actions" must be an array');
    const ticks = Math.max(0, ...sources.map(s => (Array.isArray(s.actions) ? s.actions.length : 0)));
    const pointer = session.pointerState;

    for (let i = 0; i < ticks; i++) {
      let tickPause = 0;
      for (const source of sources) {
        const action = source.actions?.[i];
        if (!action) continue;
        if (action.type === 'pause') {
          tickPause = Math.max(tickPause, Number(action.duration) || 0);
          continue;
        }
        if (source.type === 'key') {
          if (action.type !== 'keyDown') continue;
          const target = session.activeElement && isAttached(session.activeElement, session.page().document)
            ? session.activeElement
            : session.page().document.body;
          if (target) await this.typeInto(session, target, String(action.value));
        } else if (source.type === 'pointer') {
          if (action.type === 'pointerMove') {
            const origin = action.origin;
            if (origin && typeof origin === 'object' && typeof origin[ELEMENT_KEY] === 'string') {
              pointer.target = session.element(origin[ELEMENT_KEY]);
            } else if (origin !== 'pointer') {
              pointer.target = null;
            }
            tickPause = Math.max(tickPause, Math.min(Number(action.duration) || 0, 250));
          } else if (action.type === 'pointerDown') {
            pointer.downTarget = pointer.target;
            pointer.target?.dispatchEvent({ type: 'mousedown', target: pointer.target, bubbles: true, button: action.button || 0 });
          } else if (action.type === 'pointerUp') {
            const target = pointer.target;
            if (target) {
              target.dispatchEvent({ type: 'mouseup', target, bubbles: true, button: action.button || 0 });
              if (pointer.downTarget === target) {
                if ((action.button || 0) === 2) {
                  target.dispatchEvent({ type: 'contextmenu', target, bubbles: true, cancelable: true, button: 2 });
                } else {
                  await this.click(session, target);
                }
              }
            }
            pointer.downTarget = null;
          }
        }
      }
      if (tickPause > 0) await sleep(tickPause);
    }
  }

  // ---------------------------------------------------------------- Routes

  private registerRoutes(): void {
    const el = (s: Session, p: Record<string, string>) => s.element(p.eid);

    // Timeouts
    this.route('GET', '/timeouts', s => s.timeouts);
    this.route('POST', '/timeouts', (s, _p, b) => { applyTimeouts(s.timeouts, b); return null; });

    // Navigation
    this.route('POST', '/url', async (s, _p, b) => {
      if (typeof b?.url !== 'string') throw err.invalidArgument('"url" must be a string');
      let target: string;
      try { target = new URL(b.url).toString(); } catch { throw err.invalidArgument(`Invalid URL: ${b.url}`); }
      const page = s.page();
      if (target === 'about:blank') {
        page.setContent('<html><head></head><body></body></html>', 'about:blank');
        s.prune();
        return null;
      }
      await this.navigate(s, () => page.goto(target, { timeoutMs: s.timeouts.pageLoad, settleTimeoutMs: 0 }));
      return null;
    });
    this.route('GET', '/url', s => s.page().url);
    this.route('POST', '/back', async s => { const p = s.page(); await this.navigate(s, () => p.back()); return null; });
    this.route('POST', '/forward', async s => { const p = s.page(); await this.navigate(s, () => p.forward()); return null; });
    this.route('POST', '/refresh', async s => {
      const p = s.page();
      if (p.url !== 'about:blank') await this.navigate(s, () => p.reload());
      return null;
    });
    this.route('GET', '/title', s => s.page().document.title.trim());
    this.route('GET', '/source', s => '<!DOCTYPE html>' + s.page().document.documentElement.outerHTML);

    // Windows
    this.route('GET', '/window', s => s.page().id);
    this.route('GET', '/window/handles', s => s.browser.listPages().map(p => p.id));
    this.route('POST', '/window', (s, _p, b) => {
      const page = s.browser.getPage(String(b?.handle));
      if (!page) throw err.noSuchWindow(`No window with handle ${b?.handle}`);
      s.current = page;
      s.activeElement = null;
      return null;
    });
    this.route('DELETE', '/window', s => {
      const page = s.page();
      s.browser.closePage(page.id);
      s.prune();
      const remaining = s.browser.listPages();
      if (remaining.length === 0) {
        this.sessions.delete(s.id);
      }
      return remaining.map(p => p.id);
    });
    this.route('POST', '/window/new', (s, _p, b) => {
      const page = s.openWindow();
      return { handle: page.id, type: b?.type === 'window' ? 'window' : 'tab' };
    });
    this.route('GET', '/window/rect', () => WINDOW_RECT);
    this.route('POST', '/window/rect', () => WINDOW_RECT);
    this.route('POST', '/window/maximize', () => WINDOW_RECT);
    this.route('POST', '/window/minimize', () => WINDOW_RECT);
    this.route('POST', '/window/fullscreen', () => WINDOW_RECT);

    // Frames: only the top-level browsing context exists
    this.route('POST', '/frame', (_s, _p, b) => {
      if (b?.id === null || b?.id === undefined) return null;
      throw err.noSuchFrame('Frames are not supported yet');
    });
    this.route('POST', '/frame/parent', () => null);

    // Elements
    this.route('POST', '/element', (s, _p, b) => this.find(s, b, null, false));
    this.route('POST', '/elements', (s, _p, b) => this.find(s, b, null, true));
    this.route('POST', '/element/:eid/element', (s, p, b) => this.find(s, b, el(s, p), false));
    this.route('POST', '/element/:eid/elements', (s, p, b) => this.find(s, b, el(s, p), true));
    this.route('GET', '/element/active', s => {
      const active = s.activeElement && isAttached(s.activeElement, s.page().document) ? s.activeElement : s.page().document.body;
      if (!active) throw err.noSuchElement('No active element');
      return s.ref(active);
    });
    this.route('GET', '/element/:eid/shadow', () => { throw err.noSuchShadowRoot(); });
    this.route('GET', '/element/:eid/selected', (s, p) => isSelected(el(s, p)));
    this.route('GET', '/element/:eid/attribute/:name', (s, p) => el(s, p).getAttribute(p.name));
    this.route('GET', '/element/:eid/property/:name', (s, p) => {
      const v = this.property(s, el(s, p), p.name);
      return v === undefined ? null : v;
    });
    this.route('GET', '/element/:eid/css/:name', (s, p) => inlineStyle(el(s, p), p.name.toLowerCase()) ?? '');
    this.route('GET', '/element/:eid/text', (s, p) => visibleText(el(s, p)));
    this.route('GET', '/element/:eid/name', (s, p) => el(s, p).tagName);
    this.route('GET', '/element/:eid/rect', (s, p) => {
      const r = el(s, p).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    this.route('GET', '/element/:eid/enabled', (s, p) => isEnabled(el(s, p)));
    this.route('GET', '/element/:eid/displayed', (s, p) => isDisplayed(el(s, p)));
    this.route('GET', '/element/:eid/computedrole', (s, p) => el(s, p).getAttribute('role') || '');
    this.route('GET', '/element/:eid/computedlabel', (s, p) => {
      const e = el(s, p);
      return e.getAttribute('aria-label') || visibleText(e);
    });
    this.route('POST', '/element/:eid/click', async (s, p) => { await this.click(s, el(s, p)); return null; });
    this.route('POST', '/element/:eid/clear', (s, p) => {
      const e = el(s, p);
      if (!isTextEditable(e) && !(e.tagName === 'input' && e.getAttribute('type') === 'file')) {
        throw err.notInteractable('Element is not editable');
      }
      if (!isEnabled(e) || e.hasAttribute('readonly')) throw err.notInteractable('Element is disabled or read-only');
      if (e.getAttribute('contenteditable') !== null && e.tagName !== 'input' && e.tagName !== 'textarea') e.textContent = '';
      else e.value = '';
      e.dispatchEvent({ type: 'input', target: e, bubbles: true });
      e.dispatchEvent({ type: 'change', target: e, bubbles: true });
      return null;
    });
    this.route('POST', '/element/:eid/value', async (s, p, b) => {
      const text = typeof b?.text === 'string' ? b.text : Array.isArray(b?.value) ? b.value.join('') : null;
      if (text === null) throw err.invalidArgument('"text" must be a string');
      const e = el(s, p);
      if (!isDisplayed(e) && !(e.tagName === 'input' && e.getAttribute('type') === 'file')) {
        throw err.notInteractable('Element is not displayed');
      }
      if (!isEnabled(e) || e.hasAttribute('readonly')) throw err.notInteractable('Element is disabled or read-only');
      await this.typeInto(s, e, text);
      return null;
    });
    this.route('GET', '/element/:eid/screenshot', () => BLANK_PNG);

    // Scripts
    this.route('POST', '/execute/sync', (s, _p, b) => this.runScript(s, b, false));
    this.route('POST', '/execute/async', (s, _p, b) => this.runScript(s, b, true));

    // Cookies
    const cookieList = (s: Session) => {
      const page = s.page();
      const domain = page.url.startsWith('http') ? new URL(page.url).hostname : '';
      return Object.entries(page.fetcher.dumpCookies()).map(([name, value]) => ({
        name, value, path: '/', domain, secure: false, httpOnly: false, sameSite: 'Lax',
      }));
    };
    this.route('GET', '/cookie', s => cookieList(s));
    this.route('GET', '/cookie/:name', (s, p) => {
      const c = cookieList(s).find(c => c.name === p.name);
      if (!c) throw err.noSuchCookie(`No cookie named "${p.name}"`);
      return c;
    });
    this.route('POST', '/cookie', (s, _p, b) => {
      const c = b?.cookie;
      if (!c || typeof c.name !== 'string' || c.value === undefined) throw err.invalidArgument('cookie needs "name" and "value"');
      const page = s.page();
      if (!page.url.startsWith('http')) throw err.invalidCookieDomain('Navigate to an http(s) page before adding cookies');
      if (c.domain) {
        const host = new URL(page.url).hostname;
        const d = String(c.domain).replace(/^\./, '');
        if (host !== d && !host.endsWith('.' + d)) throw err.invalidCookieDomain(`Cookie domain "${c.domain}" does not match ${host}`);
      }
      page.fetcher.setCookie(c.name, String(c.value));
      return null;
    });
    this.route('DELETE', '/cookie/:name', (s, p) => { s.page().fetcher.deleteCookie(p.name); return null; });
    this.route('DELETE', '/cookie', s => { s.page().fetcher.clearCookies(); return null; });

    // Actions
    this.route('POST', '/actions', (s, _p, b) => this.performActions(s, b));
    this.route('DELETE', '/actions', s => { s.pointerState.target = null; s.pointerState.downTarget = null; return null; });

    // Alerts / prompts: none are ever open
    this.route('POST', '/alert/dismiss', () => { throw err.noSuchAlert(); });
    this.route('POST', '/alert/accept', () => { throw err.noSuchAlert(); });
    this.route('GET', '/alert/text', () => { throw err.noSuchAlert(); });
    this.route('POST', '/alert/text', () => { throw err.noSuchAlert(); });

    // Visual output: there is no rendering, return a valid placeholder image
    this.route('GET', '/screenshot', () => BLANK_PNG);
    this.route('POST', '/print', () => { throw err.unsupported('Printing to PDF is not supported (no rendering engine)'); });
  }
}

function applyTimeouts(target: Timeouts, value: any): void {
  if (!value || typeof value !== 'object') throw err.invalidArgument('timeouts must be an object');
  for (const key of ['implicit', 'pageLoad', 'script'] as const) {
    if (!(key in value)) continue;
    const v = value[key];
    if (key === 'script' && v === null) { target.script = null; continue; }
    if (typeof v !== 'number' || v < 0 || !Number.isInteger(v)) throw err.invalidArgument(`Invalid ${key} timeout: ${v}`);
    target[key] = v;
  }
}

// W3C "proxy" capability â†’ engine network options
function proxyFromCapability(cap: any): NetworkOptions {
  const type = String(cap.proxyType || '').toLowerCase();
  if (type === 'direct') return { proxy: undefined, useEnvProxy: false };
  if (type === 'system') return { proxy: undefined, useEnvProxy: true };
  if (type === 'pac' || type === 'autodetect') {
    throw err.sessionNotCreated(`proxyType "${type}" is not supported; use "manual" with httpProxy/sslProxy/socksProxy`);
  }
  if (type !== 'manual') return {};

  const withScheme = (hostPort: string, scheme: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostPort) ? hostPort : `${scheme}://${hostPort}`);
  let proxy: string | undefined;
  if (cap.socksProxy) {
    const url = new URL(withScheme(cap.socksProxy, 'socks5'));
    if (cap.socksUsername) url.username = encodeURIComponent(cap.socksUsername);
    if (cap.socksPassword) url.password = encodeURIComponent(cap.socksPassword);
    proxy = url.toString().replace(/\/$/, '');
  } else if (cap.sslProxy || cap.httpProxy) {
    proxy = withScheme(cap.sslProxy || cap.httpProxy, 'http');
  }
  const noProxy = Array.isArray(cap.noProxy) ? cap.noProxy : typeof cap.noProxy === 'string' ? cap.noProxy.split(',') : undefined;
  return { proxy, noProxy, useEnvProxy: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
