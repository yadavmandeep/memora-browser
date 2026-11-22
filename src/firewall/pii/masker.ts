import { PII_RULES } from './patterns.js';

export interface MaskResult {
  text: string;
  count: number;
  types: Record<string, number>;
}

/**
 * Local Two-Way PII & Secret Masking Engine.
 * Replaces sensitive values with synthetic deterministic tokens (e.g. [PII:CREDIT_CARD:1])
 * before content leaves the machine to external LLMs, and transparently unmasks them
 * back to real values when the agent fills forms or performs actions.
 */
export class PIIMasker {
  private tokenToOriginal = new Map<string, string>();
  private originalToToken = new Map<string, string>();
  private typeCounts = new Map<string, number>();

  /**
   * Masks sensitive information in raw text into synthetic [PII:TYPE:N] tokens.
   */
  public mask(text: string): MaskResult {
    if (!text || typeof text !== 'string') {
      return { text: text || '', count: 0, types: {} };
    }

    let result = text;
    let totalMasked = 0;
    const typesDetected: Record<string, number> = {};

    for (const rule of PII_RULES) {
      result = result.replace(rule.pattern, (match) => {
        // Run optional validator (e.g. Luhn algorithm for credit cards)
        if (rule.validate && !rule.validate(match)) {
          return match;
        }

        // Return existing token if already mapped
        if (this.originalToToken.has(match)) {
          return this.originalToToken.get(match)!;
        }

        const currentCount = (this.typeCounts.get(rule.type) || 0) + 1;
        this.typeCounts.set(rule.type, currentCount);

        const syntheticToken = `[PII:${rule.type}:${currentCount}]`;
        this.tokenToOriginal.set(syntheticToken, match);
        this.originalToToken.set(match, syntheticToken);

        typesDetected[rule.type] = (typesDetected[rule.type] || 0) + 1;
        totalMasked++;

        return syntheticToken;
      });
    }

    return {
      text: result,
      count: totalMasked,
      types: typesDetected
    };
  }

  /**
   * Restores synthetic tokens back to their original values.
   */
  public unmask(text: string): string {
    if (!text || typeof text !== 'string') return text;
    let restored = text;
    for (const [token, original] of this.tokenToOriginal.entries()) {
      if (restored.includes(token)) {
        restored = restored.split(token).join(original);
      }
    }
    return restored;
  }

  /**
   * Transparently unmasks all values in an object (e.g. form fields).
   */
  public unmaskObject<T extends Record<string, any>>(obj: T): T {
    if (!obj || typeof obj !== 'object') return obj;
    const out: any = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        out[k] = this.unmask(v);
      } else if (v && typeof v === 'object') {
        out[k] = this.unmaskObject(v);
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }

  /**
   * Returns how many distinct secrets are currently tracked in memory.
   */
  public get trackedCount(): number {
    return this.tokenToOriginal.size;
  }

  /**
   * Resets all in-memory token mappings.
   */
  public clear(): void {
    this.tokenToOriginal.clear();
    this.originalToToken.clear();
    this.typeCounts.clear();
  }
}
