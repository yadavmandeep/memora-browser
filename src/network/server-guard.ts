import path from 'node:path';
import type http from 'node:http';

// Address to listen on. "localhost" means this machine only: 127.0.0.1, never every interface.
// Use --host 0.0.0.0 explicitly to accept connections from other machines (containers).
export function bindAddress(host: string): string {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' ? '127.0.0.1' : h;
}

// Host as it must appear inside a URL: IPv6 literals need brackets ("[::1]")
export function urlHost(host: string): string {
  const h = host.replace(/^\[|\]$/g, '');
  return h.includes(':') ? `[${h}]` : h;
}

// A web page the user has open in their own browser must not be able to drive the daemon
// (drive-by requests to localhost). Browsers mark those requests; non-browser clients
// (Playwright, Puppeteer, Selenium, curl, the SDKs) do not send these headers.
export function isCrossSiteBrowserRequest(req: http.IncomingMessage): boolean {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return !!origin;
  try {
    const o = new URL(origin);
    const reqHost = String(req.headers.host || '');
    return o.host !== reqHost;
  } catch {
    return true;
  }
}

// Folder that session files may be read from or written to over the network or by the model:
// ORBIS_SESSION_DIR, or the folder the server was started in.
export function sessionRoot(): string {
  return path.resolve(process.env.ORBIS_SESSION_DIR || process.cwd());
}

export class SessionPathError extends Error {
  public readonly code = 'ERR_SESSION_PATH';
  constructor(message: string) {
    super(message);
    this.name = 'SessionPathError';
  }
}

// Resolves a session file path and refuses anything outside sessionRoot() or not ending in .json
export function resolveSessionPath(filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new SessionPathError('Missing session file path');
  const root = sessionRoot();
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SessionPathError(`Session files must be inside ${root} (set ORBIS_SESSION_DIR to change it): ${filePath}`);
  }
  if (path.extname(resolved).toLowerCase() !== '.json') {
    throw new SessionPathError(`Session files must end in .json: ${filePath}`);
  }
  return resolved;
}
