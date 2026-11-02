import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface AuditEvent {
  type: 'session' | 'tool' | 'navigation' | 'finding' | 'confirmation';
  tool?: string;
  capability?: string;
  decision?: 'allow' | 'deny' | 'confirm-approved' | 'confirm-declined' | 'monitor';
  rule?: string;
  reason?: string;
  url?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  findings?: { high: number; medium: number; low: number; rules: string[] };
  detail?: unknown;
}

export interface AuditEntry extends AuditEvent {
  seq: number;
  ts: string;
  session: string;
  prev: string;
  hash: string;
  alg: 'sha256' | 'hmac-sha256';
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  head: string | null;
  // 1-based line of the first entry that fails, and why
  badLine?: number;
  reason?: string;
}

const GENESIS = '0'.repeat(64);
const MEMORY_TAIL = 500;

// Fields of an entry in a fixed order, so the hash does not depend on key order in the file
function canonical(e: Omit<AuditEntry, 'hash'>): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(e).sort()) ordered[k] = (e as any)[k];
  return JSON.stringify(ordered);
}

function digest(body: string, key?: string): string {
  return key ? createHmac('sha256', key).update(body).digest('hex') : createHash('sha256').update(body).digest('hex');
}

// Append-only, hash-chained JSONL log. Each entry carries the hash of the previous one, so editing,
// deleting or reordering any entry breaks every hash after it. With ORBIS_AUDIT_KEY set the chain is
// an HMAC: without the key nobody can rebuild a valid chain after tampering. Truncating the newest
// entries is only detectable against a head hash recorded elsewhere (see `head`).
export class AuditLog {
  public readonly session = randomBytes(6).toString('hex');
  private seq = 0;
  private prev = GENESIS;
  private readonly tail: AuditEntry[] = [];
  public readonly alg: AuditEntry['alg'];

  constructor(private readonly filePath?: string, private readonly key: string | undefined = process.env.ORBIS_AUDIT_KEY || undefined) {
    this.alg = key ? 'hmac-sha256' : 'sha256';
    if (filePath) {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
      // Continue an existing chain instead of starting a second genesis in the same file
      const last = readLastLine(filePath);
      if (last) {
        try {
          const e = JSON.parse(last) as AuditEntry;
          if (typeof e.seq === 'number' && typeof e.hash === 'string') {
            this.seq = e.seq;
            this.prev = e.hash;
          }
        } catch {
          throw new Error(`Audit log "${filePath}" ends with a line that is not JSON; refusing to extend it`);
        }
      }
    }
  }

  public get head(): string {
    return this.prev;
  }

  public get count(): number {
    return this.seq;
  }

  public get path(): string | undefined {
    return this.filePath;
  }

  public record(event: AuditEvent): AuditEntry {
    const body: Omit<AuditEntry, 'hash'> = {
      ...stripUndefined(event),
      seq: this.seq + 1,
      ts: new Date().toISOString(),
      session: this.session,
      prev: this.prev,
      alg: this.alg,
    } as Omit<AuditEntry, 'hash'>;
    const entry = { ...body, hash: digest(canonical(body), this.key) } as AuditEntry;
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    this.seq = entry.seq;
    this.prev = entry.hash;
    this.tail.push(entry);
    if (this.tail.length > MEMORY_TAIL) this.tail.shift();
    return entry;
  }

  public recent(n = 20): AuditEntry[] {
    return this.tail.slice(-n);
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function readLastLine(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : null;
}

// Re-computes every hash and link in an audit file. Pass the same key the log was written with.
export function verifyAuditLog(filePath: string, key: string | undefined = process.env.ORBIS_AUDIT_KEY || undefined): AuditVerifyResult {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let prev = GENESIS;
  let seq = 0;
  let entries = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const bad = (reason: string): AuditVerifyResult => ({ ok: false, entries, head: entries ? prev : null, badLine: i + 1, reason });
    let e: AuditEntry;
    try {
      e = JSON.parse(line);
    } catch {
      return bad('line is not valid JSON');
    }
    if (e.alg === 'hmac-sha256' && !key) return bad('entry is HMAC-signed; set ORBIS_AUDIT_KEY to verify it');
    if (e.alg === 'sha256' && key) return bad('entry is not HMAC-signed but a key was given (a keyless entry may have been inserted)');
    if (e.seq !== seq + 1) return bad(`expected seq ${seq + 1}, found ${e.seq}`);
    if (e.prev !== prev) return bad('prev hash does not match the previous entry (entry removed, inserted or reordered)');
    const { hash, ...body } = e;
    if (digest(canonical(body), e.alg === 'hmac-sha256' ? key : undefined) !== hash) return bad('hash mismatch (entry was modified)');
    prev = hash;
    seq = e.seq;
    entries++;
  }
  return { ok: true, entries, head: entries ? prev : null };
}
