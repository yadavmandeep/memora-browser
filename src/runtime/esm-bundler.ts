import { build, transformSync, Plugin } from 'esbuild';
import { MemoraDocument } from '../dom/node.js';
import { NetworkFetcher } from '../network/fetcher.js';

export interface ModuleBundleOptions {
  entryCode: string;
  entryUrl: string;
  baseUrl: string;
  fetcher: NetworkFetcher;
  timeoutMs?: number;
  importMap?: Record<string, string>;
}

export function transformInlineModule(code: string): string {
  try {
    const res = transformSync(code, {
      format: 'esm',
      target: 'es2022',
    });
    const stripped = res.code.replace(/export\s*\{[^}]*\};?/g, '');
    return `(async () => {\n${stripped}\n})()`;
  } catch (err: any) {
    throw new Error(`Failed to transform inline module: ${err.message || String(err)}`);
  }
}

export function parseImportMap(doc: MemoraDocument, baseUrl: string): Record<string, string> {
  const map: Record<string, string> = {};
  const scripts = doc.querySelectorAll('script[type="importmap"]');

  for (const script of scripts) {
    const raw = script.textContent.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.imports && typeof parsed.imports === 'object') {
        for (const [key, val] of Object.entries(parsed.imports)) {
          if (typeof val === 'string') {
            try {
              map[key] = new URL(val, baseUrl).toString();
            } catch {
              map[key] = val;
            }
          }
        }
      }
    } catch {
      // Ignore malformed importmap JSON
    }
  }

  return map;
}

export async function bundleModuleScript(options: ModuleBundleOptions): Promise<string> {
  const { entryCode, entryUrl, baseUrl, fetcher, timeoutMs = 10000, importMap = {} } = options;
  const cache = new Map<string, string>();
  cache.set('<entry>', entryCode);

  const memoraResolverPlugin: Plugin = {
    name: 'memora-esm-resolver',
    setup(buildContext) {
      // 1. Resolve module specifiers
      buildContext.onResolve({ filter: /.*/ }, args => {
        if (args.path === '<entry>') {
          return { path: args.path, namespace: 'memora' };
        }

        // Check import map
        if (importMap[args.path]) {
          const mapped = importMap[args.path];
          return { path: mapped, namespace: 'memora', pluginData: { url: mapped } };
        }

        // Relative or absolute path
        const parentUrl = args.pluginData?.url || entryUrl || baseUrl;
        let resolved: string;
        try {
          resolved = new URL(args.path, parentUrl).toString();
        } catch {
          resolved = args.path;
        }

        return { path: resolved, namespace: 'memora', pluginData: { url: resolved } };
      });

      // 2. Load module source code
      buildContext.onLoad({ filter: /.*/, namespace: 'memora' }, async args => {
        if (args.path === '<entry>') {
          return { contents: entryCode, loader: 'js' };
        }

        const cached = cache.get(args.path);
        if (cached !== undefined) {
          return { contents: cached, loader: 'js' };
        }

        if (/^https?:/.test(args.path)) {
          const resp = await fetcher.fetchResource(args.path, {
            timeoutMs,
            referer: entryUrl,
            accept: '*/*'
          });

          if (resp.status >= 200 && resp.status < 300) {
            cache.set(args.path, resp.body);
            return { contents: resp.body, loader: 'js' };
          }
          throw new Error(`Failed to fetch module ${args.path}: HTTP ${resp.status}`);
        }

        throw new Error(`Unsupported module URL: ${args.path}`);
      });
    }
  };

  const result = await build({
    entryPoints: ['<entry>'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    define: {
      'import.meta.url': JSON.stringify(entryUrl)
    },
    plugins: [memoraResolverPlugin]
  });

  const bundledCode = result.outputFiles[0].text;
  return `(async () => {\n${bundledCode}\n})()`;
}
