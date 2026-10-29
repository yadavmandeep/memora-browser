// Loads only the parts of undici a direct (non-proxied) session needs.
//
// `import ... from 'undici'` evaluates the whole package index (mock agents, cache stores,
// WebSocket, EventSource, interceptors, ...): ~15 MB RSS and ~150 ms of startup. fetch() plus
// Agent is about half of that. Proxy agents are loaded through the full package on first use.
// If undici's internal layout ever changes, every export falls back to the full package.
import { createRequire } from 'node:module';
import type * as Undici from 'undici';

const require = createRequire(import.meta.url);

let full: typeof Undici | undefined;

export function undiciFull(): typeof Undici {
  return (full ??= require('undici') as typeof Undici);
}

function lite<T>(path: string, pick: (mod: any) => T, fallback: (u: typeof Undici) => T): T {
  try {
    const value = pick(require(path));
    if (typeof value === 'function') return value;
  } catch {
    // layout changed: use the public entry point
  }
  return fallback(undiciFull());
}

export const fetch: typeof Undici.fetch = lite('undici/lib/web/fetch/index.js', m => m.fetch, u => u.fetch);
export const Agent: typeof Undici.Agent = lite('undici/lib/dispatcher/agent.js', m => m, u => u.Agent);
export type Dispatcher = Undici.Dispatcher;
