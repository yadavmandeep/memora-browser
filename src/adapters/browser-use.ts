import { MemoraAgent } from './agent.js';

export interface BrowserUseConfig {
  cdpUrl: string;
  disableSecurity?: boolean;
  extraChromiumArgs?: string[];
}

/**
 * Adapter for Browser-Use (Python / TS).
 * Returns configuration parameters for connecting Browser-Use agent to Memora.
 */
export function getBrowserUseConfig(agentOrPort: MemoraAgent | number = 9222): BrowserUseConfig {
  const port = typeof agentOrPort === 'number' ? agentOrPort : (agentOrPort.browser.options.port || 9222);
  const host = typeof agentOrPort === 'number' ? '127.0.0.1' : (agentOrPort.browser.options.host || '127.0.0.1');

  return {
    cdpUrl: `http://${host}:${port}`,
    disableSecurity: true,
    extraChromiumArgs: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox'
    ]
  };
}
