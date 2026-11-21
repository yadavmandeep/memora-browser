import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptData, decryptData } from './cipher.js';
import { SessionData, VaultProfile, VaultProfileSummary } from '../types/index.js';

export interface SessionVaultConfig {
  vaultPath?: string;
  masterKey?: string;
}

export class SessionVault {
  private vaultPath: string;
  private masterKey: string;

  constructor(config: SessionVaultConfig = {}) {
    const defaultDir = path.join(process.cwd(), '.orbis');
    this.vaultPath = config.vaultPath || path.join(defaultDir, 'vault.enc');
    this.masterKey =
      config.masterKey ||
      process.env.ORBIS_VAULT_KEY ||
      process.env.MEMORA_VAULT_KEY ||
      `orbis_master_${os.hostname()}_${os.userInfo?.()?.username || 'user'}`;
  }

  private loadStore(passphrase?: string): Record<string, VaultProfile> {
    const key = passphrase || this.masterKey;
    if (!fs.existsSync(this.vaultPath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(this.vaultPath, 'utf8').trim();
      if (!raw) return {};
      const decrypted = decryptData(raw, key);
      return JSON.parse(decrypted);
    } catch (err: any) {
      throw new Error(`SessionVault authentication failed: ${err.message}. Check vault passphrase.`);
    }
  }

  private saveStore(store: Record<string, VaultProfile>, passphrase?: string): void {
    const key = passphrase || this.masterKey;
    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(store);
    const encrypted = encryptData(json, key);
    fs.writeFileSync(this.vaultPath, encrypted, 'utf8');
  }

  public isSessionExpired(session: SessionData): boolean {
    if (!session) return true;
    const now = Date.now() / 1000;
    if (session.cookieList && Array.isArray(session.cookieList)) {
      const authCookies = session.cookieList.filter((c) =>
        /session|token|auth|id|jwt|login/i.test(c.name)
      );
      if (authCookies.length > 0) {
        const allAuthExpired = authCookies.every(
          (c) => c.expires !== undefined && c.expires > 0 && c.expires < now
        );
        if (allAuthExpired) return true;
      }
    }
    return false;
  }

  public saveProfile(name: string, session: SessionData, passphrase?: string): VaultProfileSummary {
    const store = this.loadStore(passphrase);
    let domain = 'unknown';
    try {
      if (session.url) domain = new URL(session.url).hostname;
    } catch {}

    let earliestExpiry: number | undefined;
    if (session.cookieList && Array.isArray(session.cookieList)) {
      for (const c of session.cookieList) {
        if (c.expires && c.expires > 0) {
          if (!earliestExpiry || c.expires < earliestExpiry) earliestExpiry = c.expires;
        }
      }
    }

    const profile: VaultProfile = {
      name,
      domain,
      url: session.url,
      createdAt: new Date().toISOString(),
      expiresAt: earliestExpiry,
      session
    };

    store[name] = profile;
    this.saveStore(store, passphrase);

    return {
      name,
      domain,
      url: session.url,
      createdAt: profile.createdAt,
      expiresAt: profile.expiresAt,
      isExpired: this.isSessionExpired(session)
    };
  }

  public loadProfile(name: string, passphrase?: string): SessionData | null {
    const store = this.loadStore(passphrase);
    const profile = store[name];
    if (!profile) return null;
    return profile.session;
  }

  public findSessionForDomain(domain: string, passphrase?: string): { name: string; session: SessionData } | null {
    const store = this.loadStore(passphrase);
    const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    for (const [name, profile] of Object.entries(store)) {
      if (profile.domain === cleanDomain || cleanDomain.endsWith('.' + profile.domain) || profile.domain.endsWith('.' + cleanDomain)) {
        if (!this.isSessionExpired(profile.session)) {
          return { name, session: profile.session };
        }
      }
    }
    return null;
  }

  public listProfiles(passphrase?: string): VaultProfileSummary[] {
    const store = this.loadStore(passphrase);
    return Object.values(store).map((p) => ({
      name: p.name,
      domain: p.domain,
      url: p.url,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      isExpired: this.isSessionExpired(p.session)
    }));
  }

  public deleteProfile(name: string, passphrase?: string): boolean {
    const store = this.loadStore(passphrase);
    if (!store[name]) return false;
    delete store[name];
    this.saveStore(store, passphrase);
    return true;
  }

  public clear(passphrase?: string): void {
    this.saveStore({}, passphrase);
  }
}
