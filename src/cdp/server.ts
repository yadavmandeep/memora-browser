import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MemoraBrowser } from '../engine/browser.js';
import { CDPDispatcher } from './dispatcher.js';
import { CDPRequest, CDPResponse, CDPEvent } from '../types/index.js';
import { ChallengeDetectedError } from '../challenge/errors.js';
import { ChallengeCooldownError } from '../challenge/cooldown.js';

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err: any) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

// Challenge errors get their own status and a machine-readable body instead of a generic 500:
// stop mode → 409, host in cooldown → 429 with Retry-After
function challengeErrorResponse(err: any): { status: number; headers: Record<string, string>; body: any } | null {
  if (err instanceof ChallengeDetectedError) {
    return {
      status: 409,
      headers: {},
      body: { error: err.message, code: err.code, challenge: err.signal, cooldownSec: err.cooldownSec },
    };
  }
  if (err instanceof ChallengeCooldownError) {
    return {
      status: 429,
      headers: { 'Retry-After': String(err.remainingSec) },
      body: { error: err.message, code: err.code, host: err.host, remainingSec: err.remainingSec, challenge: err.signal },
    };
  }
  return null;
}

export class CDPServer {
  private browser: MemoraBrowser;
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private dispatcher: CDPDispatcher;
  private port: number;
  private host: string;
  public readonly apiKey?: string;

  constructor(browser: MemoraBrowser) {
    this.browser = browser;
    this.port = browser.options.port || 9222;
    this.host = browser.options.host || 'localhost';
    this.apiKey = browser.options.apiKey || process.env.ORBIS_API_KEY || process.env.MEMORA_API_KEY;
    this.dispatcher = new CDPDispatcher(browser);

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocket();
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    if (!this.apiKey) return true;

    // 1. Header: x-api-key
    const headerKey = req.headers['x-api-key'];
    if (typeof headerKey === 'string' && headerKey.trim() === this.apiKey) return true;

    // 2. Header: Authorization: Bearer <key>
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && match[1].trim() === this.apiKey) return true;
    }

    // 3. Query params: ?apiKey=<key> or ?token=<key>
    const queryKey = url.searchParams.get('apiKey') || url.searchParams.get('token');
    if (queryKey && queryKey.trim() === this.apiKey) return true;

    return false;
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. /json/version
    if (pathname === '/json/version') {
      const data = {
        Browser: 'Chrome/130.0.0.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        'V8-Version': '12.8.0',
        'WebKit-Version': '537.36',
        product: 'Orbis/0.1.1',
        engine: 'Memora Browser Engine (MBE)',
        website: 'https://orbis.memora.company',
        company: 'https://memora.company',
        webSocketDebuggerUrl: `ws://${this.host}:${this.port}/devtools/browser/memora-root`
      };
      res.writeHead(200);
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    // 2. /json/list or /json
    if (pathname === '/json/list' || pathname === '/json') {
      const pages = this.browser.listPages();
      const list = pages.map(p => ({
        description: '',
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=${this.host}:${this.port}/devtools/page/${p.id}`,
        id: p.id,
        title: p.title(),
        type: 'page',
        url: p.url,
        webSocketDebuggerUrl: `ws://${this.host}:${this.port}/devtools/page/${p.id}`
      }));
      res.writeHead(200);
      res.end(JSON.stringify(list, null, 2));
      return;
    }

    // 3. /json/new
    if (pathname === '/json/new') {
      const page = this.browser.newPage();
      const target = {
        description: '',
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=${this.host}:${this.port}/devtools/page/${page.id}`,
        id: page.id,
        title: page.title(),
        type: 'page',
        url: page.url,
        webSocketDebuggerUrl: `ws://${this.host}:${this.port}/devtools/page/${page.id}`
      };
      res.writeHead(200);
      res.end(JSON.stringify(target, null, 2));
      return;
    }

    // 4. /json/close/{id}
    if (pathname.startsWith('/json/close/')) {
      const targetId = pathname.replace('/json/close/', '');
      const closed = this.browser.closePage(targetId);
      res.writeHead(200);
      res.end(JSON.stringify({ success: closed }));
      return;
    }

    // 5. Agentic Endpoint: /orbis/snapshot & /memora/snapshot (Instant LLM distill view)
    if (pathname === '/orbis/snapshot' || pathname === '/memora/snapshot') {
      const targetId = url.searchParams.get('id');
      const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
      if (!page) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Page not found' }));
        return;
      }
      const focusSelector = url.searchParams.get('focus') || url.searchParams.get('focusSelector') || undefined;
      const excludeRaw = url.searchParams.get('exclude') || url.searchParams.get('excludeSelectors');
      const excludeSelectors = excludeRaw ? excludeRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const format = url.searchParams.get('format');

      if (format === 'markdown') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(page.getMarkdown({ focusSelector, excludeSelectors }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ...page.getSemanticSnapshot({ focusSelector, excludeSelectors }), challenge: page.lastChallenge }, null, 2));
      return;
    }

    // 6. Agentic Endpoint: /orbis/diff & /memora/diff (State comparison)
    if (pathname === '/orbis/diff' || pathname === '/memora/diff') {
      const targetId = url.searchParams.get('id');
      const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
      if (!page) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Page not found' }));
        return;
      }

      if (req.method === 'POST') {
        readJsonBody(req).then(body => {
          const diff = page.diff(body.previousSnapshot, {
            focusSelector: body.focusSelector,
            excludeSelectors: body.excludeSelectors
          });
          res.writeHead(200);
          res.end(JSON.stringify({ diff, currentSnapshot: page.lastSnapshot }, null, 2));
        }).catch(err => {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        });
      } else {
        const focusSelector = url.searchParams.get('focus') || url.searchParams.get('focusSelector') || undefined;
        const excludeRaw = url.searchParams.get('exclude') || url.searchParams.get('excludeSelectors');
        const excludeSelectors = excludeRaw ? excludeRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
        const diff = page.diff(undefined, { focusSelector, excludeSelectors });
        res.writeHead(200);
        res.end(JSON.stringify({ diff, currentSnapshot: page.lastSnapshot }, null, 2));
      }
      return;
    }

    // 7. Agentic Endpoint: /orbis/fill-form & /memora/fill-form (Atomic multi-field form population)
    if ((pathname === '/orbis/fill-form' || pathname === '/memora/fill-form') && req.method === 'POST') {
      readJsonBody(req).then(async body => {
        const targetId = body.id || url.searchParams.get('id');
        const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
        if (!page) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Page not found' }));
          return;
        }
        if (!body.fields || typeof body.fields !== 'object') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing or invalid "fields" object' }));
          return;
        }
        try {
          const fillResult = await page.fillForm({
            fields: body.fields,
            submit: body.submit ?? body.submitActionId ?? true,
            steps: body.steps
          });
          res.writeHead(200);
          res.end(JSON.stringify({ ...fillResult, challenge: page.lastChallenge, snapshot: page.getSemanticSnapshot() }, null, 2));
        } catch (err: any) {
          const ch = challengeErrorResponse(err);
          if (ch) {
            res.writeHead(ch.status, ch.headers);
            res.end(JSON.stringify(ch.body, null, 2));
            return;
          }
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      }).catch(err => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 8. Agentic Endpoint: /orbis/act & /memora/act (Direct action by @actionId or selector)
    if ((pathname === '/orbis/act' || pathname === '/memora/act') && req.method === 'POST') {
      readJsonBody(req).then(body => {
        const targetId = body.id || url.searchParams.get('id');
        const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
        if (!page) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Page not found' }));
          return;
        }
        const actionId = body.actionId || body.target;
        if (!actionId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing actionId or target' }));
          return;
        }
        let success = false;
        if (body.type === 'type' && body.text !== undefined) {
          success = page.type(actionId, body.text);
        } else {
          success = page.click(actionId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success, snapshot: page.getSemanticSnapshot() }, null, 2));
      }).catch(err => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 9. Agentic Endpoint: /orbis/session & /memora/session (Save / load / export session)
    if (pathname === '/orbis/session' || pathname === '/memora/session') {
      const targetId = url.searchParams.get('id');
      const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
      if (!page) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Page not found' }));
        return;
      }

      if (req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(page.dumpSession(), null, 2));
      } else if (req.method === 'POST') {
        readJsonBody(req).then(body => {
          if (body.filePath) {
            page.loadSession(body.filePath);
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, url: page.url }));
          } else if (body.session) {
            page.restoreSession(body.session);
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, url: page.url }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Expected "filePath" or "session" in request body' }));
          }
        }).catch(err => {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        });
      }
      return;
    }

    if ((pathname === '/orbis/session/save' || pathname === '/memora/session/save') && req.method === 'POST') {
      readJsonBody(req).then(body => {
        const targetId = body.id || url.searchParams.get('id');
        const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
        if (!page) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Page not found' }));
          return;
        }
        if (!body.filePath) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing "filePath"' }));
          return;
        }
        page.saveSession(body.filePath);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, filePath: body.filePath }));
      }).catch(err => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 10. Agentic Endpoint: /orbis/goto & /memora/goto?url=...
    if (pathname === '/orbis/goto' || pathname === '/memora/goto') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing url parameter' }));
        return;
      }
      const page = this.browser.defaultPage;
      page.goto(targetUrl).then(result => {
        res.writeHead(200);
        res.end(JSON.stringify({
          ...result,
          challenge: page.lastChallenge,
          challengeCooldownSec: page.lastChallengeCooldownSec,
          snapshot: page.getSemanticSnapshot()
        }, null, 2));
      }).catch(err => {
        const ch = challengeErrorResponse(err);
        if (ch) {
          res.writeHead(ch.status, ch.headers);
          res.end(JSON.stringify(ch.body, null, 2));
          return;
        }
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      });
      return;
    }

    // Fallback 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private setupWebSocket(): void {
    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${this.host}:${this.port}`);
      if (url.pathname.startsWith('/devtools/')) {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
      let targetPage = this.browser.defaultPage;

      // Check if connection is for a specific page id
      const match = url.pathname.match(/\/devtools\/page\/([a-zA-Z0-9-]+)/);
      if (match && match[1]) {
        const found = this.browser.getPage(match[1]);
        if (found) targetPage = found;
      }

      const emitEvent = (event: CDPEvent) => {
        if (ws.readyState === WebSocket.OPEN) {
          if (process.env.DEBUG_CDP) {
            console.log('[CDP EVENT]', event.method, event.sessionId || '');
          }
          ws.send(JSON.stringify(event));
        }
      };

      ws.on('message', async (data: string | Buffer) => {
        try {
          const req = JSON.parse(data.toString()) as CDPRequest;
          if (process.env.DEBUG_CDP) {
            console.log('[CDP IN]', req.id, req.method, req.sessionId || '');
          }
          let sessionPage = targetPage;
          if (req.sessionId) {
            const found = this.browser.getPage(req.sessionId);
            if (!found) {
              // Session of a closed (or never attached) target, as Chrome reports it
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  id: req.id,
                  sessionId: req.sessionId,
                  error: { code: -32001, message: `Session with given id not found: ${req.sessionId}` },
                }));
              }
              return;
            }
            sessionPage = found;
          }

          const sessionEmit = (event: CDPEvent) => {
            if (req.sessionId && !event.sessionId && !event.method.startsWith('Target.')) {
              event.sessionId = req.sessionId;
            }
            emitEvent(event);
          };

          const response = await this.dispatcher.dispatch(req, sessionPage, sessionEmit);
          if (process.env.DEBUG_CDP) {
            console.log('[CDP OUT]', response.id, response.sessionId || '');
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
          }
        } catch (err: any) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              id: -1,
              error: { code: -32700, message: 'Parse error: ' + err.message }
            }));
          }
        }
      });
    });
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.on('error', reject);
      const bindHost = (this.host === 'localhost' || this.host === '127.0.0.1') ? '0.0.0.0' : this.host;
      this.httpServer.listen(this.port, bindHost, () => {
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => {
          resolve();
        });
      });
    });
  }

  public close(): Promise<void> {
    return this.stop();
  }
}
