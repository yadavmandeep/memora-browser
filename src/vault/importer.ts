import fs from 'node:fs';
import { SessionData } from '../types/index.js';
import { StoredCookie } from '../network/cookie-jar.js';
import { validateSessionData } from '../engine/session.js';

/**
 * Imports cookies and session data from standard formats:
 *  1. Netscape HTTP Cookie File (standard export from browser extensions like "Get cookies.txt")
 *  2. JSON Cookie array export (EditThisCookie / Cookie-Editor extensions)
 */
export class SessionImporter {
  /**
   * Imports cookies from Netscape format or JSON format and converts into Orbis SessionData.
   */
  public static importFromFile(filePath: string, targetUrl: string = 'https://example.com'): SessionData {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Cookie file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8').trim();

    // Check if JSON format
    if (content.startsWith('[') || content.startsWith('{')) {
      return this.importFromJson(content, targetUrl);
    }

    // Otherwise parse as Netscape format
    return this.importFromNetscape(content, targetUrl);
  }

  public static importFromJson(jsonString: string, targetUrl: string): SessionData {
    const parsed = JSON.parse(jsonString);

    // If it's already a full Orbis SessionData
    if (parsed.version === 1 && parsed.cookies && parsed.localStorage) {
      validateSessionData(parsed);
      return parsed;
    }

    const cookiesRecord: Record<string, string> = {};
    const cookieList: StoredCookie[] = [];

    const cookieArray: any[] = Array.isArray(parsed) ? parsed : (parsed.cookies || []);

    for (const c of cookieArray) {
      if (c && c.name && c.value !== undefined) {
        cookiesRecord[c.name] = String(c.value);
        cookieList.push({
          name: c.name,
          value: String(c.value),
          domain: c.domain || new URL(targetUrl).hostname,
          path: c.path || '/',
          expires: c.expirationDate ? Math.floor(c.expirationDate) : (c.expires ? Math.floor(c.expires) : undefined),
          hostOnly: !String(c.domain || '').startsWith('.'),
          httpOnly: !!c.httpOnly,
          secure: !!c.secure
        });
      }
    }

    const session: SessionData = {
      version: 1,
      createdAt: new Date().toISOString(),
      url: targetUrl,
      cookies: cookiesRecord,
      cookieList,
      localStorage: parsed.localStorage || {},
      sessionStorage: parsed.sessionStorage || {}
    };

    validateSessionData(session);
    return session;
  }

  public static importFromNetscape(netscapeText: string, targetUrl: string): SessionData {
    const lines = netscapeText.split('\n');
    const cookiesRecord: Record<string, string> = {};
    const cookieList: StoredCookie[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Netscape tab-separated fields:
      // domain, flag, path, secure, expiration, name, value
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const domain = parts[0].replace(/^#HttpOnly_/, '');
        const path = parts[2];
        const secure = parts[3].toUpperCase() === 'TRUE';
        const expires = parseInt(parts[4], 10);
        const name = parts[5];
        const value = parts[6];

        if (name && value !== undefined) {
          cookiesRecord[name] = value;
          cookieList.push({
            name,
            value,
            domain,
            path,
            secure,
            expires: isNaN(expires) || expires <= 0 ? undefined : expires,
            hostOnly: !parts[0].startsWith('.'),
            httpOnly: parts[0].startsWith('#HttpOnly_')
          });
        }
      }
    }

    const session: SessionData = {
      version: 1,
      createdAt: new Date().toISOString(),
      url: targetUrl,
      cookies: cookiesRecord,
      cookieList,
      localStorage: {},
      sessionStorage: {}
    };

    validateSessionData(session);
    return session;
  }
}
