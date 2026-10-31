/**
 * ⬡ Orbis CookieJar — High-performance isolated cookie store for multi-tab concurrency.
 * Supports per-context isolation, RFC cookie header formatting, and cloning for speculatively forked pages.
 */
export class CookieJar {
  private cookies: Map<string, string> = new Map();

  public get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  public set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  public delete(name: string): void {
    this.cookies.delete(name);
  }

  public clear(): void {
    this.cookies.clear();
  }

  public get size(): number {
    return this.cookies.size;
  }

  public has(name: string): boolean {
    return this.cookies.has(name);
  }

  public dump(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.cookies.entries()) {
      out[k] = v;
    }
    return out;
  }

  public restore(cookies: Record<string, string> | Map<string, string>): void {
    this.cookies.clear();
    if (cookies instanceof Map) {
      for (const [k, v] of cookies.entries()) {
        this.cookies.set(k, v);
      }
    } else if (cookies && typeof cookies === 'object') {
      for (const [k, v] of Object.entries(cookies)) {
        this.cookies.set(k, String(v));
      }
    }
  }

  public getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  public storeSetCookies(headers: { getSetCookie?(): string[] } | any): void {
    const lines: string[] = typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : Array.isArray(headers?.['set-cookie'])
      ? headers['set-cookie']
      : headers?.['set-cookie']
      ? [headers['set-cookie']]
      : [];

    for (const line of lines) {
      if (!line) continue;
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0\b/i.test(line) || /expires=[^;]*19[0-7]\d/i.test(line);
      if (expired) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  public clone(): CookieJar {
    const jar = new CookieJar();
    jar.restore(this.dump());
    return jar;
  }
}

