import crypto from 'node:crypto';
import { MemoraBrowser } from '../engine/browser.js';
import { MemoraPage } from '../engine/page.js';
import { MemoraElement, MemoraNode } from '../dom/node.js';
import { CDPRequest, CDPResponse, CDPEvent } from '../types/index.js';
import { RemoteObjectRegistry, exceptionDetails } from './remote-objects.js';
import { RobotsBlockedError } from '../network/robots.js';
import { VIEWPORT, installSandboxCompat, isElementRendered, layoutFor, quadFor } from './dom-compat.js';
import { dispatchKeyEvent, dispatchMouseEvent, insertText } from './input.js';

type Emit = (event: CDPEvent) => void;

// One loaded document of a page: execution contexts and remote objects live and die with it,
// like in Chrome where a navigation destroys every context of the frame.
interface DocState {
  sandbox: unknown;
  loaderId: string;
  url: string;
  status: number;
  registry: RemoteObjectRegistry;
  contexts: Map<number, string>; // contextId -> world name ('' = main world)
  mainContextId: number;
  nodeIds: WeakMap<object, number>;
  nodesById: Map<number, MemoraNode>;
}

interface PageState {
  doc: DocState;
  worldNames: Set<string>;
  initScripts: Map<string, { source: string; worldName?: string }>;
  browserContextId: string;
}

const DEFAULT_CONTEXT = 'default';
const MAIN_WORLD = '';

function newLoaderId(): string {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function splitUrl(url: string): { url: string; urlFragment?: string } {
  const i = url.indexOf('#');
  return i === -1 ? { url } : { url: url.slice(0, i), urlFragment: url.slice(i) };
}

function originOf(url: string): string {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? '://' : o;
  } catch {
    return '://';
  }
}

// Chrome reports failed loads as errorText on Page.navigate, not as protocol errors
function netErrorText(err: any): string {
  const msg = String(err?.message || err) + ' ' + String(err?.cause?.code || err?.code || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'net::ERR_NAME_NOT_RESOLVED';
  if (/ECONNREFUSED/i.test(msg)) return 'net::ERR_CONNECTION_REFUSED';
  if (/ECONNRESET|socket hang up/i.test(msg)) return 'net::ERR_CONNECTION_RESET';
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'net::ERR_TIMED_OUT';
  if (/redirect/i.test(msg)) return 'net::ERR_TOO_MANY_REDIRECTS';
  if (/cert|SSL|TLS/i.test(msg)) return 'net::ERR_CERT_INVALID';
  if (/Invalid URL|ERR_INVALID_URL/i.test(msg)) return 'net::ERR_INVALID_URL';
  if (/abort/i.test(msg)) return 'net::ERR_ABORTED';
  return 'net::ERR_FAILED';
}

export class CDPDispatcher {
  private browser: MemoraBrowser;
  private states: WeakMap<MemoraPage, PageState> = new WeakMap();
  private contextIdCounter = 0;
  private browserContexts: Set<string> = new Set();
  private pageContexts: Map<string, string> = new Map(); // pageId -> browserContextId

  constructor(browser: MemoraBrowser) {
    this.browser = browser;
  }

  // ---------------------------------------------------------------------------------------------
  // Page / document state
  // ---------------------------------------------------------------------------------------------

  private stateFor(page: MemoraPage): PageState {
    let state = this.states.get(page);
    if (!state) {
      state = {
        doc: this.createDoc(page, newLoaderId()),
        worldNames: new Set(),
        initScripts: new Map(),
        browserContextId: this.pageContexts.get(page.id) || DEFAULT_CONTEXT,
      };
      this.states.set(page, state);
    } else if (state.doc.sandbox !== page.sandbox) {
      // The page navigated through another channel (MCP, engine API): adopt the new document
      state.doc = this.createDoc(page, newLoaderId());
      for (const w of state.worldNames) this.allocContext(state.doc, w);
    }
    installSandboxCompat(page);
    return state;
  }

  private createDoc(page: MemoraPage, loaderId: string): DocState {
    const doc: DocState = {
      sandbox: page.sandbox,
      loaderId,
      url: page.url,
      status: page.lastStatus,
      registry: new RemoteObjectRegistry(`${loaderId.slice(0, 8)}`),
      contexts: new Map(),
      mainContextId: 0,
      nodeIds: new WeakMap(),
      nodesById: new Map(),
    };
    doc.mainContextId = this.allocContext(doc, MAIN_WORLD);
    return doc;
  }

  private allocContext(doc: DocState, worldName: string): number {
    const id = ++this.contextIdCounter;
    doc.contexts.set(id, worldName);
    return id;
  }

  private contextPayload(page: MemoraPage, doc: DocState, id: number) {
    const worldName = doc.contexts.get(id) || MAIN_WORLD;
    const isMain = worldName === MAIN_WORLD;
    return {
      context: {
        id,
        origin: originOf(page.url),
        name: worldName,
        uniqueId: `${doc.loaderId}.${id}`,
        auxData: { isDefault: isMain, type: isMain ? 'default' : 'isolated', frameId: page.id },
      },
    };
  }

  private frameInfo(page: MemoraPage, doc: DocState) {
    const { url, urlFragment } = splitUrl(page.url);
    return {
      id: page.id,
      loaderId: doc.loaderId,
      url,
      ...(urlFragment ? { urlFragment } : {}),
      domainAndRegistry: '',
      securityOrigin: originOf(page.url),
      mimeType: 'text/html',
      secureContextType: page.url.startsWith('https:') || page.url.startsWith('http://localhost') || page.url.startsWith('http://127.0.0.1') ? 'Secure' : 'InsecureScheme',
      crossOriginIsolatedContextType: 'NotIsolated',
      gatedAPIFeatures: [],
    };
  }

  private targetInfo(p: MemoraPage) {
    return {
      targetId: p.id,
      type: 'page',
      title: p.title() || p.url,
      url: p.url,
      attached: true,
      canAccessOpener: false,
      browserContextId: this.stateFor(p).browserContextId,
    };
  }

  private lifecycle(page: MemoraPage, doc: DocState, emit: Emit, names: string[]): void {
    const timestamp = Date.now() / 1000;
    for (const name of names) {
      emit({ method: 'Page.lifecycleEvent', params: { frameId: page.id, loaderId: doc.loaderId, name, timestamp } });
      if (name === 'DOMContentLoaded') emit({ method: 'Page.domContentEventFired', params: { timestamp } });
      if (name === 'load') emit({ method: 'Page.loadEventFired', params: { timestamp } });
    }
  }

  // Announce the page's freshly loaded document: network record, new frame commit,
  // fresh execution contexts and the full set of lifecycle events.
  private commitDocument(page: MemoraPage, emit: Emit, loaderId: string, method: string = 'GET'): DocState {
    const state = this.stateFor(page);
    const doc = this.createDoc(page, loaderId);
    for (const w of state.worldNames) this.allocContext(doc, w);
    state.doc = doc;
    installSandboxCompat(page);

    for (const { source } of state.initScripts.values()) {
      try { page.sandbox.evaluateRaw(source); } catch { /* page init script errors are not fatal */ }
    }

    const now = Date.now() / 1000;
    const isNetwork = /^https?:/.test(page.url);
    if (isNetwork) {
      emit({
        method: 'Network.requestWillBeSent',
        params: {
          requestId: loaderId, loaderId, documentURL: page.url, frameId: page.id, type: 'Document',
          timestamp: now, wallTime: now, initiator: { type: 'other' }, redirectHasExtraInfo: false, hasUserGesture: false,
          request: { url: page.url, method, headers: {}, initialPriority: 'VeryHigh', referrerPolicy: 'strict-origin-when-cross-origin', mixedContentType: 'none' },
        },
      });
      emit({
        method: 'Network.responseReceived',
        params: {
          requestId: loaderId, loaderId, frameId: page.id, type: 'Document', timestamp: now, hasExtraInfo: false,
          response: {
            url: page.url, status: page.lastStatus, statusText: '', headers: { 'content-type': 'text/html' },
            mimeType: 'text/html', connectionReused: false, connectionId: 0, encodedDataLength: 0,
            securityState: page.url.startsWith('https:') ? 'secure' : 'neutral', protocol: 'http/1.1',
          },
        },
      });
      emit({ method: 'Network.loadingFinished', params: { requestId: loaderId, timestamp: now, encodedDataLength: 0 } });
    }

    emit({ method: 'Runtime.executionContextsCleared', params: {} });
    emit({ method: 'Page.frameNavigated', params: { frame: this.frameInfo(page, doc), type: 'Navigation' } });
    for (const id of doc.contexts.keys()) {
      emit({ method: 'Runtime.executionContextCreated', params: this.contextPayload(page, doc, id) });
    }
    this.lifecycle(page, doc, emit, ['init', 'commit', 'DOMContentLoaded', 'load']);
    emit({ method: 'Page.frameStoppedLoading', params: { frameId: page.id } });
    this.lifecycle(page, doc, emit, ['networkAlmostIdle', 'networkIdle']);
    return doc;
  }

  // Runs an action that may navigate the page (click on a link, form submission, Enter key...)
  // and reports the navigation to the client the way Chrome does.
  private async withNavigation(page: MemoraPage, emit: Emit, action: () => Promise<unknown> | unknown): Promise<void> {
    const before = page.sandbox;
    try {
      await action();
    } finally {
      if (page.sandbox !== before) {
        emit({ method: 'Page.frameRequestedNavigation', params: { frameId: page.id, reason: 'scriptInitiated', url: page.url, disposition: 'currentTab' } });
        emit({ method: 'Page.frameStartedLoading', params: { frameId: page.id } });
        this.commitDocument(page, emit, newLoaderId());
      }
    }
  }

  // location.href = ... from an evaluated script: navigate after replying, like a renderer would
  private schedulePendingNavigation(page: MemoraPage, emit: Emit): void {
    const pending = page.sandbox.takePendingNavigation();
    if (!pending) return;
    emit({ method: 'Page.frameRequestedNavigation', params: { frameId: page.id, reason: 'scriptInitiated', url: pending, disposition: 'currentTab' } });
    setTimeout(() => {
      this.withNavigation(page, emit, () => page.goto(pending)).catch(() => {
        emit({ method: 'Page.frameStoppedLoading', params: { frameId: page.id } });
      });
    }, 0);
  }

  private async navigate(page: MemoraPage, url: string, emit: Emit): Promise<Record<string, any>> {
    this.stateFor(page);
    const loaderId = newLoaderId();
    emit({ method: 'Page.frameStartedLoading', params: { frameId: page.id } });
    try {
      if (url === 'about:blank') {
        page.setContent('<html><head></head><body></body></html>', 'about:blank');
      } else {
        await page.goto(url);
      }
    } catch (e: any) {
      emit({ method: 'Page.frameStoppedLoading', params: { frameId: page.id } });
      if (e instanceof RobotsBlockedError) {
        return { frameId: page.id, loaderId, errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
      }
      return { frameId: page.id, loaderId, errorText: netErrorText(e) };
    }
    this.commitDocument(page, emit, loaderId);
    return { frameId: page.id, loaderId };
  }

  private nodeId(doc: DocState, node: MemoraNode): number {
    let id = doc.nodeIds.get(node);
    if (!id) {
      id = doc.nodesById.size + 1;
      doc.nodeIds.set(node, id);
      doc.nodesById.set(id, node);
    }
    return id;
  }

  private resolveNodeParam(page: MemoraPage, doc: DocState, params: any): MemoraNode {
    let node: any;
    if (params.objectId) node = doc.registry.get(params.objectId);
    else if (params.backendNodeId !== undefined) node = doc.nodesById.get(params.backendNodeId);
    else if (params.nodeId !== undefined) node = doc.nodesById.get(params.nodeId);
    if (!(node instanceof MemoraNode)) throw new Error('Could not find node with given id');
    if (node !== page.document && !node.isConnected) throw new Error('Node is detached from document');
    return node;
  }

  private describe(page: MemoraPage, doc: DocState, node: MemoraNode) {
    const isDoc = node === page.document;
    const el = node instanceof MemoraElement ? node : null;
    const id = this.nodeId(doc, node);
    const attributes: string[] = [];
    if (el && !isDoc) for (const [k, v] of el.attributes) attributes.push(k, v);
    return {
      nodeId: 0,
      backendNodeId: id,
      nodeType: isDoc ? 9 : node.nodeType,
      nodeName: isDoc ? '#document' : node.nodeName,
      localName: el && !isDoc ? el.localName : '',
      nodeValue: node.nodeType === 3 || node.nodeType === 8 ? node.textContent : '',
      childNodeCount: node.childNodes.length,
      ...(attributes.length ? { attributes } : {}),
      ...(isDoc ? { documentURL: page.url, baseURL: page.url } : {}),
      ...(isDoc || node === page.document.documentElement ? { frameId: page.id } : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------

  public async dispatch(
    req: CDPRequest,
    targetPage: MemoraPage,
    emitEvent: Emit
  ): Promise<CDPResponse> {
    const { id, method, params = {}, sessionId } = req;
    const [domain, action] = method.split('.');

    try {
      const result = await this.handleDomainCall(domain, action, params, targetPage, emitEvent, sessionId);
      return { id, result, sessionId };
    } catch (err: any) {
      return {
        id,
        error: {
          code: -32000,
          message: err.message || String(err),
        },
        sessionId,
      };
    }
  }

  private async handleDomainCall(
    domain: string,
    action: string,
    params: any,
    page: MemoraPage,
    emitEvent: Emit,
    sessionId?: string
  ): Promise<Record<string, any>> {
    switch (domain) {
      // 1. Target Domain
      case 'Target': {
        if (action === 'getTargets') {
          return { targetInfos: this.browser.listPages().map(p => this.targetInfo(p)) };
        }
        if (action === 'createTarget') {
          const newP = this.browser.newPage();
          const contextId = params.browserContextId || DEFAULT_CONTEXT;
          this.pageContexts.set(newP.id, contextId);
          this.stateFor(newP);
          if (params.url && params.url !== 'about:blank') {
            try { await newP.goto(params.url); } catch { /* Chrome still creates the tab */ }
            this.stateFor(newP);
          }
          const targetInfo = this.targetInfo(newP);
          emitEvent({ method: 'Target.targetCreated', params: { targetInfo } });
          emitEvent({
            method: 'Target.attachedToTarget',
            params: { sessionId: newP.id, targetInfo, waitingForDebugger: false }
          });
          return { targetId: newP.id };
        }
        if (action === 'closeTarget') {
          const target = this.browser.getPage(params.targetId);
          const closed = this.browser.closePage(params.targetId);
          this.pageContexts.delete(params.targetId);
          if (target) {
            emitEvent({ method: 'Target.detachedFromTarget', params: { sessionId: params.targetId, targetId: params.targetId } });
            emitEvent({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } });
          }
          return { success: closed };
        }
        if (action === 'attachToTarget') {
          const target = this.browser.getPage(params.targetId);
          if (!target) throw new Error(`No target with given id found`);
          emitEvent({
            method: 'Target.attachedToTarget',
            params: { sessionId: target.id, targetInfo: this.targetInfo(target), waitingForDebugger: false }
          });
          return { sessionId: target.id };
        }
        if (action === 'detachFromTarget') {
          const sid = params.sessionId || params.targetId;
          if (sid) emitEvent({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: sid } });
          return {};
        }
        if (action === 'setAutoAttach') {
          if (sessionId) {
            return {};
          }
          for (const p of this.browser.listPages()) {
            emitEvent({
              method: 'Target.attachedToTarget',
              params: { sessionId: p.id, targetInfo: this.targetInfo(p), waitingForDebugger: false }
            });
          }
          return {};
        }
        if (action === 'setDiscoverTargets') {
          if (params.discover !== false) {
            for (const p of this.browser.listPages()) {
              emitEvent({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo(p) } });
            }
          }
          return {};
        }
        if (action === 'getTargetInfo') {
          if (!params.targetId && !sessionId) {
            return { targetInfo: { targetId: 'memora-root', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
          }
          const target = (params.targetId ? this.browser.getPage(params.targetId) : page) || page;
          return { targetInfo: this.targetInfo(target) };
        }
        if (action === 'createBrowserContext') {
          const browserContextId = crypto.randomBytes(16).toString('hex').toUpperCase();
          this.browserContexts.add(browserContextId);
          return { browserContextId };
        }
        if (action === 'getBrowserContexts') {
          return { browserContextIds: [...this.browserContexts] };
        }
        if (action === 'disposeBrowserContext') {
          for (const [pageId, ctx] of [...this.pageContexts]) {
            if (ctx !== params.browserContextId) continue;
            this.browser.closePage(pageId);
            this.pageContexts.delete(pageId);
            emitEvent({ method: 'Target.detachedFromTarget', params: { sessionId: pageId, targetId: pageId } });
            emitEvent({ method: 'Target.targetDestroyed', params: { targetId: pageId } });
          }
          this.browserContexts.delete(params.browserContextId);
          return {};
        }
        return {};
      }

      // 2. Page Domain
      case 'Page': {
        const state = this.stateFor(page);
        if (action === 'enable') {
          return {};
        }
        if (action === 'getFrameTree') {
          return { frameTree: { frame: this.frameInfo(page, state.doc), childFrames: [] } };
        }
        if (action === 'getResourceTree') {
          return { frameTree: { frame: this.frameInfo(page, state.doc), childFrames: [], resources: [] } };
        }
        if (action === 'addScriptToEvaluateOnNewDocument') {
          const identifier = String(state.initScripts.size + 1) + '-' + crypto.randomBytes(4).toString('hex');
          if (params.worldName) state.worldNames.add(params.worldName);
          if (params.source) {
            state.initScripts.set(identifier, { source: params.source, worldName: params.worldName });
            if (params.runImmediately) {
              try { page.sandbox.evaluateRaw(params.source); } catch { /* ignore */ }
            }
          }
          return { identifier };
        }
        if (action === 'removeScriptToEvaluateOnNewDocument') {
          state.initScripts.delete(params.identifier);
          return {};
        }
        if (action === 'setLifecycleEventsEnabled') {
          if (params.enabled) {
            // Chrome replays the lifecycle of the current document; emit after the response so
            // clients that attach listeners once Page.getFrameTree resolves still see it.
            const doc = state.doc;
            setTimeout(() => {
              if (state.doc === doc) this.lifecycle(page, doc, emitEvent, ['init', 'DOMContentLoaded', 'load', 'networkAlmostIdle', 'networkIdle']);
            }, 0);
          }
          return {};
        }
        if (action === 'createIsolatedWorld') {
          const worldName = params.worldName || '__memora_isolated_world__';
          state.worldNames.add(worldName);
          const contextId = this.allocContext(state.doc, worldName);
          emitEvent({ method: 'Runtime.executionContextCreated', params: this.contextPayload(page, state.doc, contextId) });
          return { executionContextId: contextId };
        }
        if (action === 'navigate') {
          return this.navigate(page, String(params.url), emitEvent);
        }
        if (action === 'reload') {
          await this.navigate(page, page.url, emitEvent);
          return {};
        }
        if (action === 'stopLoading') {
          return {};
        }
        if (action === 'getNavigationHistory') {
          // Memora keeps its history private; expose back/forward as relative entries
          const entries: any[] = [];
          if (page.canGoBack()) entries.push({ id: -1, url: '', userTypedURL: '', title: '', transitionType: 'link' });
          const currentIndex = entries.length;
          entries.push({ id: 0, url: page.url, userTypedURL: page.url, title: page.title(), transitionType: 'typed' });
          if (page.canGoForward()) entries.push({ id: 1, url: '', userTypedURL: '', title: '', transitionType: 'link' });
          return { currentIndex, entries };
        }
        if (action === 'navigateToHistoryEntry') {
          const entryId = Number(params.entryId);
          if (entryId === 0) return {};
          setTimeout(() => {
            this.withNavigation(page, emitEvent, () => (entryId < 0 ? page.back() : page.forward())).catch(() => {});
          }, 0);
          return {};
        }
        if (action === 'getLayoutMetrics') {
          const vp = { pageX: 0, pageY: 0, clientWidth: VIEWPORT.width, clientHeight: VIEWPORT.height };
          const visual = { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: VIEWPORT.width, clientHeight: VIEWPORT.height, scale: 1, zoom: 1 };
          const size = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
          return {
            layoutViewport: vp, visualViewport: visual, contentSize: size,
            cssLayoutViewport: vp, cssVisualViewport: visual, cssContentSize: size,
          };
        }
        if (action === 'captureScreenshot') {
          // Minimal 1x1 transparent base64 PNG so tools expecting image data never throw
          const dummy1x1Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
          return { data: dummy1x1Png };
        }
        return {};
      }

      // 3. Runtime Domain
      case 'Runtime': {
        const state = this.stateFor(page);
        if (action === 'enable') {
          // Emit after the response is flushed: Playwright sends its init commands in parallel and
          // only attaches context listeners once Page.getFrameTree resolves, so an event sent
          // inline can arrive before anyone listens and the main world is never registered.
          const doc = state.doc;
          setTimeout(() => {
            if (state.doc !== doc) return;
            for (const id of doc.contexts.keys()) {
              emitEvent({ method: 'Runtime.executionContextCreated', params: this.contextPayload(page, doc, id) });
            }
          }, 0);
          return {};
        }
        const doc = state.doc;
        const registry = doc.registry;
        const checkContext = (contextId: any, uniqueId: any) => {
          if (uniqueId !== undefined && uniqueId !== null) {
            const [loader, cid] = String(uniqueId).split('.');
            if (loader !== doc.loaderId || !doc.contexts.has(Number(cid))) throw new Error('Cannot find context with specified id');
          } else if (contextId !== undefined && contextId !== null && !doc.contexts.has(Number(contextId))) {
            throw new Error('Cannot find context with specified id');
          }
        };
        if (action === 'evaluate') {
          checkContext(params.contextId, params.uniqueContextId);
          const { expression, returnByValue = false, awaitPromise = false } = params;
          try {
            let value = page.sandbox.evaluateRaw(String(expression));
            if (awaitPromise && value && typeof value.then === 'function') value = await value;
            return { result: registry.toRemoteObject(value, returnByValue) };
          } catch (err: any) {
            return { result: { type: 'undefined' }, exceptionDetails: exceptionDetails(err, registry) };
          } finally {
            this.schedulePendingNavigation(page, emitEvent);
          }
        }
        if (action === 'callFunctionOn') {
          const { functionDeclaration, objectId, returnByValue = false, awaitPromise = false } = params;
          if (!objectId) checkContext(params.executionContextId, params.uniqueContextId);
          // Resolving handles first surfaces stale objects as protocol errors (context destroyed)
          const thisArg = objectId ? registry.get(objectId) : undefined;
          const args = (params.arguments || []).map((a: any) => registry.resolveArgument(a));
          try {
            const fn = page.sandbox.evaluateRaw(`(${functionDeclaration})`);
            if (typeof fn !== 'function') throw new TypeError('functionDeclaration is not a function');
            let value = fn.apply(thisArg, args);
            if (awaitPromise && value && typeof value.then === 'function') value = await value;
            return { result: registry.toRemoteObject(value, returnByValue) };
          } catch (err: any) {
            return { result: { type: 'undefined' }, exceptionDetails: exceptionDetails(err, registry) };
          } finally {
            this.schedulePendingNavigation(page, emitEvent);
          }
        }
        if (action === 'getProperties') {
          const obj = registry.get(params.objectId);
          const result: any[] = [];
          if (obj && (typeof obj === 'object' || typeof obj === 'function')) {
            for (const name of Object.getOwnPropertyNames(obj)) {
              const desc = Object.getOwnPropertyDescriptor(obj, name)!;
              let value: any;
              try { value = 'value' in desc ? desc.value : undefined; } catch { value = undefined; }
              result.push({
                name,
                value: 'value' in desc ? registry.toRemoteObject(value, false) : undefined,
                writable: !!desc.writable,
                configurable: !!desc.configurable,
                enumerable: !!desc.enumerable,
                isOwn: true,
              });
            }
          }
          return { result, internalProperties: [] };
        }
        if (action === 'releaseObject') {
          if (params.objectId) {
            try { registry.release(params.objectId); } catch { /* already gone */ }
          }
          return {};
        }
        if (action === 'releaseObjectGroup') {
          registry.releaseGroup();
          return {};
        }
        if (action === 'runIfWaitingForDebugger') {
          return {};
        }
        return {};
      }

      // 4. DOM Domain
      case 'DOM': {
        const state = this.stateFor(page);
        const doc = state.doc;
        if (action === 'enable' || action === 'disable') return {};
        if (action === 'getDocument') {
          const root = this.describe(page, doc, page.document);
          const html = page.document.documentElement;
          return {
            root: {
              ...root,
              nodeId: root.backendNodeId,
              children: html && html !== page.document ? [{ ...this.describe(page, doc, html), nodeId: this.nodeId(doc, html) }] : [],
            }
          };
        }
        if (action === 'querySelector') {
          const scope = params.nodeId !== undefined ? doc.nodesById.get(params.nodeId) : page.document;
          const elem = scope instanceof MemoraElement ? scope.querySelector(params.selector) : null;
          return { nodeId: elem ? this.nodeId(doc, elem) : 0 };
        }
        if (action === 'querySelectorAll') {
          const scope = params.nodeId !== undefined ? doc.nodesById.get(params.nodeId) : page.document;
          const elems = scope instanceof MemoraElement ? scope.querySelectorAll(params.selector) : [];
          return { nodeIds: elems.map(e => this.nodeId(doc, e)) };
        }
        if (action === 'getOuterHTML') {
          if (params.nodeId === undefined && params.backendNodeId === undefined && params.objectId === undefined) {
            return { outerHTML: page.content() };
          }
          const node = this.resolveNodeParam(page, doc, params);
          return { outerHTML: node === page.document ? page.content() : node instanceof MemoraElement ? node.outerHTML : node.textContent };
        }
        if (action === 'describeNode') {
          const node = this.resolveNodeParam(page, doc, params);
          return { node: this.describe(page, doc, node) };
        }
        if (action === 'resolveNode') {
          if (params.executionContextId !== undefined && !doc.contexts.has(Number(params.executionContextId))) {
            throw new Error('Cannot find context with specified id');
          }
          const node = this.resolveNodeParam(page, doc, params);
          return { object: doc.registry.toRemoteObject(node, false) };
        }
        if (action === 'requestNode') {
          const node = this.resolveNodeParam(page, doc, params);
          return { nodeId: this.nodeId(doc, node) };
        }
        if (action === 'scrollIntoViewIfNeeded') {
          const node = this.resolveNodeParam(page, doc, params);
          const el = node instanceof MemoraElement ? node : node.parentElement;
          if (!el || !isElementRendered(el)) throw new Error('Node does not have a layout object');
          return {};
        }
        if (action === 'getContentQuads' || action === 'getBoxModel') {
          const node = this.resolveNodeParam(page, doc, params);
          const el = node instanceof MemoraElement ? node : node.parentElement;
          if (!el || !isElementRendered(el)) throw new Error('Could not compute content quads.');
          const rect = layoutFor(page.document).rectFor(el);
          const quad = quadFor(rect);
          if (action === 'getContentQuads') return { quads: [quad] };
          return { model: { content: quad, padding: quad, border: quad, margin: quad, width: rect.width, height: rect.height } };
        }
        if (action === 'focus') {
          const node = this.resolveNodeParam(page, doc, params);
          if (node instanceof MemoraElement) node.focus();
          return {};
        }
        if (action === 'setFileInputFiles') {
          throw new Error('File uploads are not supported by Memora');
        }
        return {};
      }

      // 5. Network Domain
      case 'Network': {
        if (action === 'enable') return {};
        if (action === 'setExtraHTTPHeaders') {
          page.fetcher.setExtraHeaders(params.headers || {});
          return {};
        }
        if (action === 'getCookies' || action === 'getAllCookies') {
          return { cookies: [] };
        }
        if (action === 'getResponseBody') {
          const state = this.stateFor(page);
          if (params.requestId !== state.doc.loaderId) throw new Error('No resource with given identifier found');
          return { body: page.content(), base64Encoded: false };
        }
        return {};
      }

      case 'Storage': {
        if (action === 'getCookies') return { cookies: [] };
        return {};
      }

      // 6. Input Domain
      case 'Input': {
        this.stateFor(page);
        if (action === 'dispatchMouseEvent') {
          await this.withNavigation(page, emitEvent, () => dispatchMouseEvent(page, params));
          return {};
        }
        if (action === 'dispatchKeyEvent') {
          await this.withNavigation(page, emitEvent, () => dispatchKeyEvent(page, params));
          return {};
        }
        if (action === 'insertText') {
          insertText(page, String(params.text ?? ''));
          return {};
        }
        return {};
      }

      // 7. Browser Domain
      case 'Browser': {
        if (action === 'getVersion') {
          return {
            protocolVersion: '1.3',
            product: 'MemoraEngine/1.0.0',
            revision: '1.0.0',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
            jsVersion: 'V8-12.x'
          };
        }
        if (action === 'close') {
          this.browser.close();
          return {};
        }
        return {};
      }

      // 8. Emulation Domain
      case 'Emulation': {
        return {};
      }

      // 9. Orbis & Memora Compatibility Domains
      case 'LP':
      case 'Memora':
      case 'Orbis': {
        if (action === 'getSemanticSnapshot' || action === 'getSemanticTree' || action === 'snapshot') {
          return page.getSemanticSnapshot({
            focusSelector: params.focusSelector,
            excludeSelectors: params.excludeSelectors
          });
        }
        if (action === 'getMarkdown') {
          return {
            markdown: page.getMarkdown({
              focusSelector: params.focusSelector,
              excludeSelectors: params.excludeSelectors
            })
          };
        }
        if (action === 'getStructuredData') {
          return { structuredData: page.getStructuredData() };
        }
        if (action === 'diff') {
          const diff = page.diff(params.previousSnapshot, {
            focusSelector: params.focusSelector,
            excludeSelectors: params.excludeSelectors
          });
          return { diff, currentSnapshot: page.lastSnapshot };
        }
        if (action === 'fillForm') {
          const res = await page.fillForm({
            fields: params.fields,
            submit: params.submit ?? params.submitActionId ?? true,
            steps: params.steps
          });
          return { ...res, snapshot: page.getSemanticSnapshot() };
        }
        if (action === 'saveSession') {
          if (params.filePath) {
            page.saveSession(params.filePath);
            return { success: true, filePath: params.filePath };
          }
          return { success: true, session: page.dumpSession() };
        }
        if (action === 'loadSession') {
          if (params.filePath) {
            page.loadSession(params.filePath);
            return { success: true, url: page.url };
          }
          if (params.session) {
            page.restoreSession(params.session);
            return { success: true, url: page.url };
          }
          throw new Error('Orbis.loadSession (or Memora.loadSession) requires filePath or session parameter');
        }
        if (action === 'act') {
          const { actionId, type, text } = params;
          if (type === 'type' && text !== undefined) {
            const ok = page.type(actionId, text);
            return { success: ok };
          }
          const ok = page.click(actionId);
          return { success: ok };
        }
        return {};
      }

      default:
        // Ignore unsupported domains gracefully
        return {};
    }
  }
}
