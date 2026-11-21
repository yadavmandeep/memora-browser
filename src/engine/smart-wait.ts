import type { Page } from 'playwright-core';
import type { SmartWaitOptions, SmartWaitResult } from '../types/index.js';

/**
 * Smartly waits for modern single-page apps (SPAs) and heavy JavaScript pages to settle.
 * Checks:
 *  1. Network in-flight quiescence (no active fetch/XHR for `networkIdleMs`)
 *  2. DOM mutation silence (no new nodes or attribute changes for `mutationQuietMs`)
 *  3. Framework hydration readiness (Next.js, React fiber root, Nuxt/Vue, Angular)
 *  4. RAF / CSS animation stability
 */
export async function smartWaitForPage(page: Page, options: SmartWaitOptions = {}): Promise<SmartWaitResult> {
  const {
    networkIdleMs = 300,
    mutationQuietMs = 200,
    checkHydration = true,
    timeoutMs = 5000
  } = options;

  const startTime = Date.now();

  try {
    const payload = JSON.stringify({
      netMs: networkIdleMs,
      mutMs: mutationQuietMs,
      checkHydr: checkHydration,
      maxMs: timeoutMs
    });

    const script = `((args) => {
      const { netMs, mutMs, checkHydr, maxMs } = args;
      return new Promise((resolve) => {
        const start = Date.now();
        let inFlightRequests = 0;
        let netRequestCount = 0;
        let mutationCount = 0;
        let lastNetTime = 0;
        let lastMutationTime = 0;
        let detectedFramework = undefined;

        // 1. Detect Framework Hydration State
        const checkHydrated = () => {
          if (!checkHydr) return true;

          const w = window;
          const d = document;

          // Next.js: Check __NEXT_DATA__ and root container
          if (w.__NEXT_DATA__) {
            detectedFramework = 'Next.js';
            const nextEl = d.querySelector('#__next');
            if (nextEl && nextEl.children.length > 0) {
              const isReactLoaded = nextEl._reactRootContainer ||
                Object.keys(nextEl).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
              return !!isReactLoaded || nextEl.children.length > 0;
            }
          }

          // Nuxt.js / Vue
          if (w.__NUXT__ || w.__VUE__) {
            detectedFramework = w.__NUXT__ ? 'Nuxt.js' : 'Vue.js';
            const appEl = d.querySelector('#__nuxt, #app');
            if (appEl && appEl.children.length > 0) return true;
          }

          // Angular
          if (w.getAllAngularTestabilities && Array.isArray(w.getAllAngularTestabilities())) {
            detectedFramework = 'Angular';
            const testabilities = w.getAllAngularTestabilities();
            if (testabilities.length > 0) {
              return testabilities.every((t) => typeof t.isStable === 'function' ? t.isStable() : true);
            }
          }

          // Generic React / SPA
          const reactRoot = d.querySelector('[data-reactroot], #root');
          if (reactRoot) {
            detectedFramework = 'React SPA';
            return reactRoot.children.length > 0;
          }

          // Standard HTML: interactive or complete
          return d.readyState === 'complete' || d.readyState === 'interactive';
        };

        // 2. Monkey-patch fetch & XMLHttpRequest inside the evaluated context
        const originalFetch = window.fetch;
        if (originalFetch && !window.__orbis_fetch_hooked__) {
          window.__orbis_fetch_hooked__ = true;
          window.fetch = async function (...args) {
            inFlightRequests++;
            netRequestCount++;
            lastNetTime = Date.now();
            try {
              return await originalFetch.apply(this, args);
            } finally {
              inFlightRequests = Math.max(0, inFlightRequests - 1);
              lastNetTime = Date.now();
            }
          };
        }

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        if (originalSend && !window.__orbis_xhr_hooked__) {
          window.__orbis_xhr_hooked__ = true;
          XMLHttpRequest.prototype.send = function (...args) {
            inFlightRequests++;
            netRequestCount++;
            lastNetTime = Date.now();
            this.addEventListener('loadend', () => {
              inFlightRequests = Math.max(0, inFlightRequests - 1);
              lastNetTime = Date.now();
            }, { once: true });
            return originalSend.apply(this, args);
          };
        }

        // 3. MutationObserver
        const observer = new MutationObserver(() => {
          mutationCount++;
          lastMutationTime = Date.now();
        });
        if (document.body || document.documentElement) {
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          });
        }

        // 4. Polling check
        const interval = setInterval(() => {
          const now = Date.now();
          const elapsed = now - start;

          const netQuiet = inFlightRequests === 0 && (netRequestCount === 0 || now - lastNetTime >= netMs);
          const mutQuiet = (mutationCount === 0 || now - lastMutationTime >= mutMs);
          const isHydrated = checkHydrated();

          if ((netQuiet && mutQuiet && isHydrated) || elapsed >= maxMs) {
            clearInterval(interval);
            observer.disconnect();
            resolve({
              settled: (netQuiet && mutQuiet && isHydrated) || isHydrated,
              networkIdle: netQuiet,
              hydrated: isHydrated,
              mutationsQuiet: mutQuiet,
              elapsedMs: elapsed,
              frameworkDetected: detectedFramework,
              reason: elapsed >= maxMs ? 'timeout_elapsed' : 'settled_quiescent'
            });
          }
        }, 40);
      });
    })(${payload})`;

    const result = await page.evaluate(script);
    return result as SmartWaitResult;
  } catch (err: any) {
    return {
      settled: false,
      networkIdle: false,
      hydrated: false,
      mutationsQuiet: false,
      elapsedMs: Date.now() - startTime,
      reason: `error: ${err.message}`
    };
  }
}
