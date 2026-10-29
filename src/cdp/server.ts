import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MemoraBrowser } from '../engine/browser.js';
import { CDPDispatcher } from './dispatcher.js';
import { CDPRequest, CDPResponse, CDPEvent } from '../types/index.js';

export class CDPServer {
  private browser: MemoraBrowser;
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private dispatcher: CDPDispatcher;
  private port: number;
  private host: string;

  constructor(browser: MemoraBrowser) {
    this.browser = browser;
    this.port = browser.options.port || 9222;
    this.host = browser.options.host || '127.0.0.1';
    this.dispatcher = new CDPDispatcher(browser);

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocket();
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

    // 5. Agentic Endpoint: /memora/snapshot (Instant LLM distill view)
    if (pathname === '/memora/snapshot') {
      const targetId = url.searchParams.get('id');
      const page = targetId ? this.browser.getPage(targetId) : this.browser.defaultPage;
      if (!page) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Page not found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(page.getSemanticSnapshot(), null, 2));
      return;
    }

    // 6. Agentic Endpoint: /memora/goto?url=...
    if (pathname === '/memora/goto') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing url parameter' }));
        return;
      }
      const page = this.browser.defaultPage;
      page.goto(targetUrl).then(result => {
        res.writeHead(200);
        res.end(JSON.stringify({ ...result, snapshot: page.getSemanticSnapshot() }, null, 2));
      }).catch(err => {
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
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, this.host, () => {
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
}
