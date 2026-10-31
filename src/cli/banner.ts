/**
 * Orbis by Memora — Terminal Brand Banner & Badge Renderer
 * 
 * Sleek, high-definition minimalist developer badge inspired by
 * Next.js, Vite, Bun, and Supabase. Features Memora's official
 * ⬡ faceted mark and brand color palette (Teal & Gold).
 * 
 * Zero font distortion, zero pixel blur, 100% sharp across all terminals.
 * https://orbis.memora.company
 */

export interface BannerDetails {
  host?: string;
  port?: number | string;
  stealth?: boolean;
  memUsage?: string;
  maxSessions?: number | string;
  proxy?: string;
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR || process.argv.includes('--no-color')) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY || process.env.CI);
}

/**
 * Renders the sleek Orbis brand banner for terminal startup, help, and status screens.
 */
export function renderOrbisBanner(
  mode: 'cdp' | 'webdriver' | 'help' = 'cdp',
  details: BannerDetails = {}
): string {
  const useColor = supportsColor();

  const reset   = useColor ? '\x1b[0m' : '';
  const bold    = useColor ? '\x1b[1m' : '';
  const gold    = useColor ? '\x1b[1;38;2;254;202;4m' : '';
  const teal    = useColor ? '\x1b[1;38;2;2;155;133m' : '';
  const cyan    = useColor ? '\x1b[38;2;0;203;180m' : '';
  const green   = useColor ? '\x1b[38;2;122;219;75m' : '';
  const dim     = useColor ? '\x1b[38;2;130;130;130m' : '';
  const subtle  = useColor ? '\x1b[38;2;75;75;75m' : '';
  const white   = useColor ? '\x1b[38;2;230;230;230m' : '';

  const divider = `  ${subtle}──────────────────────────────────────────────────────────────────${reset}`;

  let badge = '';
  let tagline = '';

  if (mode === 'webdriver') {
    badge = `  ${teal}⬡${reset}  ${gold}ORBIS${reset} ${dim}BY${reset} ${teal}MEMORA${reset} ${dim}—${reset} ${cyan}${bold}WEBDRIVER MODE${reset}  ${dim}•${reset}  ${dim}v0.1.1${reset}`;
    tagline = `  ${white}W3C WebDriver for Selenium, WebdriverIO, & Agents${reset} ${dim}•${reset} ${cyan}orbis.memora.company${reset}`;
  } else if (mode === 'help') {
    badge = `  ${teal}⬡${reset}  ${gold}ORBIS${reset} ${dim}BY${reset} ${teal}MEMORA${reset}  ${dim}•${reset}  ${cyan}v0.1.1${reset}  ${dim}(Agentic Browser Engine)${reset}`;
    tagline = `  ${white}The Web, Working for You. Built for Autonomous AI${reset} ${dim}•${reset} ${cyan}orbis.memora.company${reset}`;
    return `\n${badge}\n${tagline}\n`;
  } else {
    badge = `  ${teal}⬡${reset}  ${gold}ORBIS${reset} ${dim}BY${reset} ${teal}MEMORA${reset}  ${dim}•${reset}  ${cyan}v0.1.1${reset}  ${dim}(Agentic Browser Engine)${reset}`;
    tagline = `  ${white}An Agentic Browser • Built for Autonomous AI${reset} ${dim}•${reset} ${cyan}orbis.memora.company${reset}`;
  }

  let body = '';
  if (mode === 'webdriver') {
    body = [
      `  ${cyan}▶${reset} ${dim}Core Engine:${reset}        Memora Browser Engine (MBE)`,
      `  ${cyan}▶${reset} ${dim}Website & Docs:${reset}     https://orbis.memora.company`,
      `  ${cyan}▶${reset} ${dim}WebDriver URL:${reset}      http://${details.host || 'localhost'}:${details.port || 9222}`,
      `  ${cyan}▶${reset} ${dim}Status Endpoint:${reset}    http://${details.host || 'localhost'}:${details.port || 9222}/status`,
      `  ${cyan}▶${reset} ${dim}Max Sessions:${reset}       ${details.maxSessions || 16}`,
      `  ${cyan}▶${reset} ${dim}Proxy:${reset}              ${details.proxy || 'None (Direct Connection)'}`,
      `  ${cyan}▶${reset} ${dim}Stealth Mode:${reset}       ${details.stealth ? `${green}🛡️  ACTIVE (Anti-Detect On)${reset}` : 'OFF'}`,
      `  ${cyan}▶${reset} ${dim}Selenium (Python):${reset}  webdriver.Remote("http://${details.host || 'localhost'}:${details.port || 9222}", options=webdriver.ChromeOptions())`
    ].join('\n');
  } else {
    body = [
      `  ${cyan}▶${reset} ${dim}Core Engine:${reset}        Memora Browser Engine (MBE)`,
      `  ${cyan}▶${reset} ${dim}Website & Docs:${reset}     https://orbis.memora.company`,
      `  ${cyan}▶${reset} ${dim}CDP WebSocket:${reset}      ws://${details.host || 'localhost'}:${details.port || 9222}/devtools/browser/memora-root`,
      `  ${cyan}▶${reset} ${dim}Discovery Endpoint:${reset} http://${details.host || 'localhost'}:${details.port || 9222}/json/version`,
      `  ${cyan}▶${reset} ${dim}Agent Snapshot:${reset}     http://${details.host || 'localhost'}:${details.port || 9222}/orbis/snapshot (or /memora/snapshot)`,
      `  ${cyan}▶${reset} ${dim}Memory Footprint:${reset}   ~${details.memUsage || '83.4'} MB (Chromium uses ~350MB+)`,
      `  ${cyan}▶${reset} ${dim}Proxy:${reset}              ${details.proxy || 'None (Direct Connection)'}`,
      `  ${cyan}▶${reset} ${dim}Stealth Mode:${reset}       ${details.stealth ? `${green}🛡️  ACTIVE (Anti-Detect On)${reset}` : 'OFF'}`,
      `  ${cyan}▶${reset} ${dim}License / Tier:${reset}     ⚡ COMMUNITY EVALUATION (Free For Devs)`,
      `  ${cyan}▶${reset} ${dim}Status:${reset}             ${green}READY FOR PLAYWRIGHT / PUPPETEER / AGENTS${reset}`
    ].join('\n');
  }

  return `\n${badge}\n${tagline}\n${divider}\n${body}\n${divider}\n`;
}
