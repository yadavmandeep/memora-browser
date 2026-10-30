import { MemoraAgent } from './agent.js';

export interface StagehandConfig {
  env: 'LOCAL' | 'BROWSERBASE';
  localBrowserUrl: string;
  enableCaching?: boolean;
}

/**
 * Adapter for Stagehand (Browser automation SDK by Playwright + LLMs).
 * Returns Stagehand constructor options configured to use Memora Browser.
 */
export function getStagehandConfig(agentOrPort: MemoraAgent | number = 9222): StagehandConfig {
  const port = typeof agentOrPort === 'number' ? agentOrPort : (agentOrPort.browser.options.port || 9222);
  const host = typeof agentOrPort === 'number' ? '127.0.0.1' : (agentOrPort.browser.options.host || '127.0.0.1');

  return {
    env: 'LOCAL',
    localBrowserUrl: `http://${host}:${port}`,
    enableCaching: false
  };
}

export const getOrbisStagehandConfig = getStagehandConfig;
