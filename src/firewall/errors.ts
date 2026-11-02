import type { Capability } from './policy.js';

// Thrown when the firewall refuses a navigation (domain rules) or an agent action (action gates).
// `rule` names what matched, e.g. "domain:block", "domain:sensitive:email", "action:deny".
export class FirewallBlockedError extends Error {
  public readonly code = 'ERR_FIREWALL_BLOCKED';
  constructor(
    message: string,
    public readonly rule: string,
    public readonly details: { url?: string; capability?: Capability; tool?: string } = {}
  ) {
    super(message);
    this.name = 'FirewallBlockedError';
  }
}
