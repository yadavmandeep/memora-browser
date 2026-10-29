export interface FingerprintProfile {
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
  platform: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
}

export const DEFAULT_CHROME_PROFILE: FingerprintProfile = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  secChUaPlatform: '"Windows"',
  platform: 'Win32',
  languages: ['en-US', 'en'],
  hardwareConcurrency: 8,
  deviceMemory: 8,
  screenWidth: 1920,
  screenHeight: 1080,
  colorDepth: 24,
};

export function getStealthHeaders(profile: FingerprintProfile = DEFAULT_CHROME_PROFILE): Record<string, string> {
  return {
    'User-Agent': profile.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': profile.languages.join(',') + ';q=0.9',
    'Sec-Ch-Ua': profile.secChUa,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': profile.secChUaPlatform,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

export function generateStealthScript(profile: FingerprintProfile = DEFAULT_CHROME_PROFILE): string {
  return `
    (() => {
      // 1. Overwrite navigator.webdriver to false
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true
      });

      // 2. Hardware and system specs
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency} });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.deviceMemory} });
      Object.defineProperty(navigator, 'platform', { get: () => '${profile.platform}' });
      Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(profile.languages)} });

      // 2b. Realistic Chrome Plugins & MimeTypes
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
      ];
      fakePlugins.item = function(i) { return fakePlugins[i] || null; };
      fakePlugins.namedItem = function(name) { return fakePlugins.find(p => p.name === name) || null; };
      fakePlugins.refresh = function() {};

      Object.defineProperty(navigator, 'plugins', {
        get: () => fakePlugins
      });

      const fakeMimes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] }
      ];
      fakeMimes.item = function(i) { return fakeMimes[i] || null; };
      fakeMimes.namedItem = function(type) { return fakeMimes.find(m => m.type === type) || null; };

      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => fakeMimes
      });

      // 2c. Mock mediaDevices
      navigator.mediaDevices = {
        enumerateDevices: async () => [
          { deviceId: 'default', kind: 'audioinput', label: 'Default - Microphone (Realtek)', groupId: 'group1' },
          { deviceId: 'default', kind: 'videoinput', label: 'Integrated Camera', groupId: 'group2' }
        ]
      };

      // 2d. Mock Battery API
      navigator.getBattery = async () => ({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1.0,
        addEventListener: () => {},
        removeEventListener: () => {}
      });

      // 3. Mock window.chrome object
      window.chrome = {
        app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
        runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' } },
        loadTimes: () => ({
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'http/2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true
        }),
        csi: () => ({ onLoad: Date.now(), pageT: 120.5, startE: Date.now() - 120, tran: 15 })
      };

      // 4. Mock Screen geometry
      const screenObj = {
        width: ${profile.screenWidth},
        height: ${profile.screenHeight},
        availWidth: ${profile.screenWidth},
        availHeight: ${profile.screenHeight - 40},
        colorDepth: ${profile.colorDepth},
        pixelDepth: ${profile.colorDepth}
      };
      window.screen = screenObj;
      try { globalThis.screen = screenObj; } catch(_) {}

      // 5. Mock Permissions API
      if (navigator.permissions && navigator.permissions.query) {
        const origQuery = navigator.permissions.query;
        navigator.permissions.query = (param) => {
          if (param && param.name === 'notifications') {
            return Promise.resolve({ state: 'default', onchange: null });
          }
          return origQuery.apply(navigator.permissions, [param]);
        };
      }
    })();
  `;
}
