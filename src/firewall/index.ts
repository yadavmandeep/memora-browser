export { PromptFirewall, describeAction } from './firewall.js';
export type { ActionRequest, Decision, ConfirmHandler, ContentResult, ContentOptions } from './firewall.js';
export { resolvePolicy, loadPolicyFile, isPreset, CAPABILITIES } from './policy.js';
export type {
  Capability, Verdict, FirewallPreset, FirewallMode, SanitizeMode,
  DomainRules, ContentRules, AuditRules, FirewallPolicyInput, FirewallPolicy,
} from './policy.js';
export { DomainGuard, SENSITIVE_DOMAINS } from './domains.js';
export type { DomainPolicy, DomainDecision } from './domains.js';
export { scanText, scanHiddenHtml, stripInvisible, summarizeFindings } from './scanner.js';
export type { Finding, Severity } from './scanner.js';
export { AuditLog, verifyAuditLog } from './audit.js';
export type { AuditEvent, AuditEntry, AuditVerifyResult } from './audit.js';
export { FirewallBlockedError } from './errors.js';
