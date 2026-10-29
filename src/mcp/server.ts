import readline from 'node:readline';
import { ChromeEngine } from '../engine/chrome-engine.js';
import { NetworkOptions } from '../types/index.js';

export class MCPServer {
  private engine: ChromeEngine;

  constructor(network: NetworkOptions = {}) {
    this.engine = new ChromeEngine(network);
  }

  public start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const message = JSON.parse(trimmed);
        const response = await this.handleMessage(message);
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch (err: any) {
        const errResp = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error: ' + err.message
          }
        };
        process.stdout.write(JSON.stringify(errResp) + '\n');
      }
    });

    // Don't crash on pipe close
    process.on('SIGTERM', async () => {
      await this.engine.close();
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      await this.engine.close();
      process.exit(0);
    });
  }

  private async handleMessage(msg: any): Promise<any | null> {
    const { id, method, params } = msg;

    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: {
              name: 'memora-browser',
              version: '1.0.0'
            },
            capabilities: {
              tools: {}
            }
          }
        };
      }

      case 'notifications/initialized': {
        return null;
      }

      case 'ping': {
        return {
          jsonrpc: '2.0',
          id,
          result: {}
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'memora_browse',
                description: 'Fast, token-condensed headless web browser for AI coding agents. Loads URL with full client-side JS/React/Vite execution, and distills page into clean Markdown and interactive Action Map (@1, @2) with 95% token savings.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'The web URL to browse (e.g. localhost app, docs, dashboard, issue tracker)' },
                    timeout: { type: 'number', description: 'Timeout in milliseconds (default: 20000)' }
                  },
                  required: ['url']
                }
              },
              {
                name: 'memora_act',
                description: 'Interact with an element on the loaded page using action ID (@1, @2) or CSS selector. Simulates human click or text input with full React/Vite event triggering.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    actionId: { type: 'string', description: 'The action ID (e.g. "@1", "@2") or CSS selector' },
                    type: { type: 'string', enum: ['click', 'type'], description: 'Action type' },
                    text: { type: 'string', description: 'Text to input if type is "type"' }
                  },
                  required: ['actionId', 'type']
                }
              },
              {
                name: 'memora_inspect',
                description: 'Inspect current page DOM state, title, and all interactive action items (@1, @2, @3).',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              },
              {
                name: 'memora_extract',
                description: 'Extract structured data from the page matching a CSS selector (e.g. "table tr", "button", "a", ".card"). Can extract text or specific attributes like "href", "src", "value".',
                inputSchema: {
                  type: 'object',
                  properties: {
                    selector: { type: 'string', description: 'CSS selector to match elements' },
                    attribute: { type: 'string', description: 'Optional attribute name to extract (e.g. "href", "src", "text", "html")' },
                    limit: { type: 'number', description: 'Max elements to return (default: 50)' }
                  },
                  required: ['selector']
                }
              },
              {
                name: 'memora_storage',
                description: 'Read, write, list, or clear localStorage and sessionStorage in the browser. Perfect for pre-authenticating by setting JWT tokens or inspecting user session state.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    storage: { type: 'string', enum: ['local', 'session'], description: 'Storage type (default: local)' },
                    action: { type: 'string', enum: ['get', 'set', 'remove', 'clear', 'list'], description: 'Action to perform' },
                    key: { type: 'string', description: 'Key name (required for get, set, remove)' },
                    value: { type: 'string', description: 'Value to set (required for set)' }
                  },
                  required: ['action']
                }
              },
              {
                name: 'memora_cookies',
                description: 'Inspect, set, or clear session and HTTP cookies for authentication testing.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['list', 'set', 'clear'], description: 'Cookie action' },
                    name: { type: 'string', description: 'Cookie name (for set)' },
                    value: { type: 'string', description: 'Cookie value (for set)' }
                  },
                  required: ['action']
                }
              },
              {
                name: 'memora_console',
                description: 'Inspect runtime console logs, warnings, and errors emitted by JavaScript on the page.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    clear: { type: 'boolean', description: 'Whether to clear logs after fetching (default: false)' }
                  }
                }
              },
              {
                name: 'memora_reload',
                description: 'Reload the active page and re-distill content and action items.',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              },
              {
                name: 'memora_html',
                description: 'Get raw HTML of the current page or a specific sub-tree matching a CSS selector.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    selector: { type: 'string', description: 'Optional CSS selector to query a specific element (default: whole document)' }
                  }
                }
              },
              {
                name: 'memora_eval',
                description: 'Execute arbitrary JavaScript code directly inside the live page context.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', description: 'JavaScript code to execute' }
                  },
                  required: ['code']
                }
              },
              {
                name: 'memora_metadata',
                description: 'Extract structured data and metadata from the page, including OpenGraph tags, Twitter cards, meta description, canonical URL, and JSON-LD schemas (Lightpanda parity).',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              },
              {
                name: 'memora_fork',
                description: 'Speculatively fork (clone) the current session into a new tab to test alternative workflows without refetching.',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              }
            ]
          }
        };
      }

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        try {
          const resultText = await this.executeTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: resultText
                }
              ]
            }
          };
        } catch (err: any) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Error executing ${toolName}: ${err.message || String(err)}`
                }
              ]
            }
          };
        }
      }

      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
      }
    }
  }

  private async executeTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'memora_browse': {
        const { url, timeout } = args;
        const t0 = performance.now();
        const resp = await this.engine.goto(url, timeout || 20000);
        const duration = (performance.now() - t0).toFixed(1);

        const snapshot = await this.engine.getSemanticSnapshot();
        const markdown = await this.engine.getMarkdown();

        return [
          `# Page Loaded: ${snapshot.title} (${duration}ms)`,
          `URL: ${snapshot.url} [HTTP ${resp.status}]`,
          `Token Estimate: ~${snapshot.tokenEstimate} tokens | Interactive Elements: ${snapshot.interactiveCount}`,
          '',
          snapshot.actionMapText,
          '',
          '--- Distilled Content ---',
          markdown.slice(0, 4000) + (markdown.length > 4000 ? '\n... [content truncated]' : '')
        ].join('\n');
      }

      case 'memora_act': {
        const { actionId, type, text } = args;
        const res = await this.engine.act(actionId, type, text);
        const snapshot = await this.engine.getSemanticSnapshot();
        return [
          `Successfully performed "${type}" on ${actionId}.`,
          `Current URL: ${res.url}`,
          `Page Title: "${res.title}"`,
          '',
          snapshot.actionMapText
        ].join('\n');
      }

      case 'memora_inspect': {
        const snapshot = await this.engine.inspect();
        return [
          `Page Title: ${snapshot.title}`,
          `URL: ${snapshot.url}`,
          `Interactive Items: ${snapshot.interactiveCount}`,
          '',
          snapshot.actionMapText
        ].join('\n');
      }

      case 'memora_extract': {
        const { selector, attribute, limit } = args;
        const results = await this.engine.extract(selector, attribute, limit || 50);
        return JSON.stringify(results, null, 2);
      }

      case 'memora_storage': {
        const { storage = 'local', action, key, value } = args;
        return await this.engine.storage(storage, action, key, value);
      }

      case 'memora_cookies': {
        const { action, name: cName, value } = args;
        return await this.engine.cookies(action, cName, value);
      }

      case 'memora_console': {
        const { clear } = args;
        const logs = this.engine.getLogs(clear);
        if (logs.length === 0) {
          return 'No console logs recorded.';
        }
        return logs
          .map(l => `[${new Date(l.timestamp).toISOString()}] [${l.type.toUpperCase()}] ${l.text}`)
          .join('\n');
      }

      case 'memora_reload': {
        const t0 = performance.now();
        const resp = await this.engine.reload();
        const duration = (performance.now() - t0).toFixed(1);
        const snapshot = await this.engine.getSemanticSnapshot();
        return `Page reloaded in ${duration}ms (HTTP ${resp.status}). Title: "${snapshot.title}". Active elements: ${snapshot.interactiveCount}\n\n${snapshot.actionMapText}`;
      }

      case 'memora_html': {
        const { selector } = args;
        return await this.engine.html(selector);
      }

      case 'memora_eval': {
        const { code } = args;
        const res = await this.engine.evaluate(code);
        return typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res);
      }

      case 'memora_metadata':
      case 'memora_structured_data': {
        const sd = await this.engine.getStructuredData();
        return JSON.stringify(sd, null, 2);
      }

      case 'memora_fork': {
        return await this.engine.fork();
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
