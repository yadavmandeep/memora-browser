import fs from 'node:fs';

// What an agent action can do. Every MCP tool and SDK method maps to exactly one.
export type Capability =
  | 'read'      // inspect/extract/html/diff/console/metadata: reads the loaded page only
  | 'navigate'  // browse/reload/handoff: loads a URL (domain rules apply on top)
  | 'interact'  // click / type / select on the page
  | 'submit'    // form submission, or a click on a submit button
  | 'storage'   // localStorage / sessionStorage read or write
  | 'cookies'   // cookie read or write
  | 'script'    // arbitrary JavaScript in the page (memora_eval)
  | 'session'   // save/load session files (credentials on disk)
  | 'download'; // file downloads (Chrome engine only; native never writes downloads)

export const CAPABILITIES: Capability[] = ['read', 'navigate', 'interact', 'submit', 'storage', 'cookies', 'script', 'session', 'download'];

export type Verdict = 'allow' | 'confirm' | 'deny';
export type FirewallPreset = 'off' | 'standard' | 'strict';
export type FirewallMode = 'enforce' | 'monitor';
export type SanitizeMode = 'off' | 'flag' | 'redact';

export interface DomainRules {
  // Navigation must match one of these when the list is non-empty. Subresources are not checked.
  allow?: string[];
  // Any request (navigation, subresource, page fetch) matching one of these is refused
  block?: string[];
  // Refuse navigation to built-in sensitive categories (email, banking/payments, identity, cloud consoles,
  // admin paths, cloud metadata endpoints). An explicit `allow` entry overrides a sensitive match.
  blockSensitive?: boolean;
  // Refuse navigation to localhost and private / link-local IP literals (no DNS resolution is done)
  blockPrivateNetwork?: boolean;
}

export interface ContentRules {
  // Wrap page-derived tool output in per-session delimiters with a "data, not instructions" notice
  isolate?: boolean;
  // off: pass text through; flag: report findings only; redact: also replace high-severity matches
  sanitize?: SanitizeMode;
  // Also parse the page HTML for instruction-like text hidden with inline CSS / aria-hidden / comments
  scanHidden?: boolean;
}

export interface AuditRules {
  // JSONL file the hash-chained audit log is appended to. Without it the log is kept in memory only.
  path?: string;
  // redacted (default): typed text, cookie/storage values and eval code are logged as length + hash
  includeArgs?: 'redacted' | 'full' | 'none';
}

export interface FirewallPolicyInput {
  preset?: FirewallPreset;
  mode?: FirewallMode;
  actions?: Partial<Record<Capability, Verdict>>;
  domains?: DomainRules;
  content?: ContentRules;
  audit?: AuditRules;
}

export interface FirewallPolicy {
  enabled: boolean;
  preset: FirewallPreset;
  mode: FirewallMode;
  actions: Record<Capability, Verdict>;
  domains: Required<Pick<DomainRules, 'blockSensitive' | 'blockPrivateNetwork'>> & { allow: string[]; block: string[] };
  content: Required<ContentRules>;
  audit: { path?: string; includeArgs: 'redacted' | 'full' | 'none' };
}

const PRESETS: Record<Exclude<FirewallPreset, 'off'>, Omit<FirewallPolicy, 'enabled' | 'preset' | 'audit'>> = {
  standard: {
    mode: 'enforce',
    actions: {
      read: 'allow', navigate: 'allow', interact: 'allow', submit: 'confirm',
      storage: 'confirm', cookies: 'confirm', script: 'confirm', session: 'confirm', download: 'deny',
    },
    domains: { allow: [], block: [], blockSensitive: true, blockPrivateNetwork: false },
    content: { isolate: true, sanitize: 'redact', scanHidden: true },
  },
  strict: {
    mode: 'enforce',
    actions: {
      read: 'allow', navigate: 'allow', interact: 'confirm', submit: 'confirm',
      storage: 'deny', cookies: 'deny', script: 'deny', session: 'deny', download: 'deny',
    },
    domains: { allow: [], block: [], blockSensitive: true, blockPrivateNetwork: true },
    content: { isolate: true, sanitize: 'redact', scanHidden: true },
  },
};

export function isPreset(v: unknown): v is FirewallPreset {
  return v === 'off' || v === 'standard' || v === 'strict';
}

// Merge a partial policy over its preset (default "standard"). Throws on unknown keys or values so a
// typo in a policy file never silently weakens it.
export function resolvePolicy(input: FirewallPolicyInput = {}): FirewallPolicy {
  validatePolicyInput(input);
  const preset = input.preset ?? 'standard';
  const audit = { path: input.audit?.path, includeArgs: input.audit?.includeArgs ?? 'redacted' as const };
  if (preset === 'off') {
    return {
      enabled: false,
      preset,
      mode: 'enforce',
      actions: Object.fromEntries(CAPABILITIES.map((c) => [c, 'allow'])) as Record<Capability, Verdict>,
      domains: { allow: [], block: [], blockSensitive: false, blockPrivateNetwork: false },
      content: { isolate: false, sanitize: 'off', scanHidden: false },
      audit,
    };
  }
  const base = PRESETS[preset];
  return {
    enabled: true,
    preset,
    mode: input.mode ?? base.mode,
    actions: { ...base.actions, ...(input.actions || {}) },
    domains: {
      allow: [...(input.domains?.allow || [])],
      block: [...(input.domains?.block || [])],
      blockSensitive: input.domains?.blockSensitive ?? base.domains.blockSensitive,
      blockPrivateNetwork: input.domains?.blockPrivateNetwork ?? base.domains.blockPrivateNetwork,
    },
    content: { ...base.content, ...(input.content || {}) },
    audit,
  };
}

export function loadPolicyFile(filePath: string): FirewallPolicyInput {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e: any) {
    throw new Error(`Cannot read firewall policy "${filePath}": ${e.message}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Firewall policy "${filePath}" is not valid JSON: ${e.message}`);
  }
  validatePolicyInput(parsed, filePath);
  return parsed;
}

function validatePolicyInput(input: any, source = 'firewall policy'): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid ${source}: ${msg}`);
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected a JSON object');
  const known = ['preset', 'mode', 'actions', 'domains', 'content', 'audit', '$schema', 'description'];
  for (const k of Object.keys(input)) if (!known.includes(k)) fail(`unknown key "${k}"`);
  if (input.preset !== undefined && !isPreset(input.preset)) fail(`preset must be "off", "standard" or "strict"`);
  if (input.mode !== undefined && input.mode !== 'enforce' && input.mode !== 'monitor') fail(`mode must be "enforce" or "monitor"`);
  if (input.actions !== undefined) {
    if (typeof input.actions !== 'object') fail('actions must be an object');
    for (const [k, v] of Object.entries(input.actions)) {
      if (!CAPABILITIES.includes(k as Capability)) fail(`unknown capability "${k}" (use ${CAPABILITIES.join(', ')})`);
      if (v !== 'allow' && v !== 'confirm' && v !== 'deny') fail(`actions.${k} must be "allow", "confirm" or "deny"`);
    }
  }
  if (input.domains !== undefined) {
    const d = input.domains;
    for (const k of Object.keys(d)) if (!['allow', 'block', 'blockSensitive', 'blockPrivateNetwork'].includes(k)) fail(`unknown key "domains.${k}"`);
    for (const k of ['allow', 'block']) {
      if (d[k] !== undefined && (!Array.isArray(d[k]) || d[k].some((p: any) => typeof p !== 'string' || !p.trim()))) fail(`domains.${k} must be a list of non-empty strings`);
    }
  }
  if (input.content !== undefined) {
    const c = input.content;
    for (const k of Object.keys(c)) if (!['isolate', 'sanitize', 'scanHidden'].includes(k)) fail(`unknown key "content.${k}"`);
    if (c.sanitize !== undefined && !['off', 'flag', 'redact'].includes(c.sanitize)) fail('content.sanitize must be "off", "flag" or "redact"');
  }
  if (input.audit !== undefined) {
    const a = input.audit;
    for (const k of Object.keys(a)) if (!['path', 'includeArgs'].includes(k)) fail(`unknown key "audit.${k}"${k === 'key' ? ' (the HMAC key is read from ORBIS_AUDIT_KEY only)' : ''}`);
    if (a.includeArgs !== undefined && !['redacted', 'full', 'none'].includes(a.includeArgs)) fail('audit.includeArgs must be "redacted", "full" or "none"');
  }
}
