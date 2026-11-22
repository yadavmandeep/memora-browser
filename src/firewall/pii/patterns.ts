/**
 * Validation heuristics and patterns for Personally Identifiable Information (PII)
 * and sensitive API credentials.
 */

export function validateLuhn(digits: string): boolean {
  const clean = digits.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(clean)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = parseInt(clean.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export interface PIIRule {
  id: string;
  type: 'CREDIT_CARD' | 'API_KEY' | 'EMAIL' | 'PHONE' | 'GOV_ID' | 'BEARER_TOKEN' | 'PRIVATE_KEY';
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

export const PII_RULES: PIIRule[] = [
  // 1. Private Keys
  {
    id: 'private-key',
    type: 'PRIVATE_KEY',
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/gi
  },

  // 2. High-Entropy API Keys (OpenAI, GitHub, AWS, Stripe)
  {
    id: 'openai-key',
    type: 'API_KEY',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g
  },
  {
    id: 'github-token',
    type: 'API_KEY',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g
  },
  {
    id: 'aws-access-key',
    type: 'API_KEY',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    id: 'stripe-secret-key',
    type: 'API_KEY',
    pattern: /\b[rs]k_(?:test|live)_[0-9a-zA-Z]{24,}\b/g
  },

  // 3. Bearer & JWT Tokens
  {
    id: 'bearer-jwt-token',
    type: 'BEARER_TOKEN',
    pattern: /\b(?:Bearer\s+)?eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g
  },

  // 4. Credit Cards with Luhn Checksum
  {
    id: 'credit-card',
    type: 'CREDIT_CARD',
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{4}[-\s]?\d{6}[-\s]?\d{5}\b/g,
    validate: validateLuhn
  },

  // 5. Government IDs (US SSN: 123-45-6789, Indian Aadhaar: 1234 5678 9012)
  {
    id: 'us-ssn',
    type: 'GOV_ID',
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g
  },
  {
    id: 'india-aadhaar',
    type: 'GOV_ID',
    pattern: /\b[2-9]\d{3}\s\d{4}\s\d{4}\b/g
  },

  // 6. Emails
  {
    id: 'email-address',
    type: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },

  // 7. Phone Numbers (international & domestic)
  {
    id: 'phone-number',
    type: 'PHONE',
    pattern: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    validate: (match) => {
      // Avoid matching simple numeric sequences or dates like 2026-11-22
      const digits = match.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15 && !/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(match);
    }
  }
];
