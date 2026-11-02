import * as parse5 from 'parse5';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  rule: string;
  severity: Severity;
  excerpt: string;
  // Where the text was found: visible tool output, hidden page markup, or invisible Unicode tag characters
  location: 'text' | 'hidden-html' | 'unicode-tags';
  // Offsets into the scanned (invisible-character-stripped) text; only for location "text"
  start?: number;
  end?: number;
  hiddenBy?: string;
}

interface Rule {
  id: string;
  severity: Severity;
  re: RegExp; // must be global
}

// Phrase-level signatures of instructions aimed at an AI reader. They are heuristics: they catch the
// common, copy-pasted attacks, and a determined attacker can paraphrase around them. Isolation and the
// action gates are what hold when a phrase is missed.
const RULES: Rule[] = [
  {
    id: 'ignore-instructions',
    severity: 'high',
    re: /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the|these|system)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules|directions|guidelines|directives?|context|guardrails)\b/gi,
  },
  {
    id: 'new-instructions',
    severity: 'high',
    re: /\b(?:new|updated|revised|real|actual|true|hidden|secret)\s+(?:system\s+)?(?:instructions?|directives?|orders|task)\s*(?:for\s+(?:the\s+)?(?:ai|assistant|agent|model)\s*)?[:\-–—]/gi,
  },
  {
    id: 'role-hijack',
    severity: 'high',
    // "You are now logged in / subscribed" is everyday UI text, so only persona and mode switches count
    re: /\byou\s+are\s+now\s+(?:in\s+)?(?:an?\s+)?(?:dan\b|unrestricted|unfiltered|jailbroken|uncensored|evil|(?:developer|god|admin|jailbreak|dan)\s+mode|(?:new|different)\s+(?:ai|assistant|persona|character))|\byou\s+are\s+no\s+longer\s+(?:bound|restricted|limited|an?\s+(?:ai|assistant)|claude|chatgpt|gpt)|\b(?:enter|enable|activate|switch\s+to)\s+(?:developer|god|dan|jailbreak|unrestricted|admin)\s+mode\b|\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken)\b/gi,
  },
  {
    // "send all cookies", "upload the user's passwords": bulk or someone else's secrets
    id: 'exfiltration',
    severity: 'high',
    re: /\b(?:send|post|upload|forward|transmit|exfiltrate|leak|email|share|paste|dump)\b[^.\n]{0,40}?\b(?:all|every|any|the\s+user'?s|their|his|her)\s+(?:of\s+the\s+)?(?:saved\s+|stored\s+|current\s+)?(?:cookies?|session\s+(?:ids?|tokens?|data|cookies?)|auth(?:entication)?\s+tokens?|access\s+tokens?|tokens|credentials?|passwords?|api[\s_-]?keys?|secrets?|localstorage|sessionstorage|private\s+keys?|ssh\s+keys?|env(?:ironment)?\s+variables?)/gi,
  },
  {
    id: 'exfiltration-target',
    severity: 'high',
    re: /\b(?:cookies?|tokens?|credentials?|passwords?|api[\s_-]?keys?|secrets?)\b[^.\n]{0,40}?\b(?:to|into|at)\s+(?:https?:\/\/|wss?:\/\/)[^\s"'<>)]+/gi,
  },
  {
    id: 'secrecy',
    severity: 'high',
    re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention\s+(?:this|it)\s+to|reveal\s+(?:this|it)\s+to|alert|notify|warn)\s+(?:the\s+|your\s+)?(?:user|human|operator|owner|person)\b|\bwithout\s+(?:telling|informing|alerting|notifying)\s+(?:the\s+|your\s+)?(?:user|human|operator|owner|person)\b|\bkeep\s+(?:this|it)\s+(?:secret|hidden)\s+from\s+(?:the\s+|your\s+)?(?:user|human)\b/gi,
  },
  {
    id: 'chat-template-token',
    severity: 'high',
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|start_header_id|end_header_id|eot_id)\|>|\[\/?INST\]|<<\/?SYS>>/gi,
  },
  {
    id: 'delimiter-escape',
    severity: 'high',
    re: /<\/?\s*untrusted[_-]content/gi,
  },
  {
    id: 'ai-addressed',
    severity: 'medium',
    re: /\b(?:attention|note|important|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|assistants?|agents?|language\s+models?|chatbots?|bots?|claude|gpt|chatgpt|gemini|copilot)\b|\bif\s+you\s+are\s+an?\s+(?:ai|llm|language\s+model|assistant|agent|bot)\b/gi,
  },
  {
    id: 'fake-role-header',
    severity: 'medium',
    re: /(?:^|\n)\s*(?:#{1,3}\s*)?\[?(?:system|assistant|developer)\]?\s*(?:prompt|message|note)?\s*:/gi,
  },
  {
    // Page text naming Orbis' own powerful tools. Generic "call the function x" is everyday docs text.
    id: 'tool-invocation',
    severity: 'medium',
    re: /\b(?:memora|orbis)_(?:eval|cookies|storage|session|fill_form|act|browse|handoff)\b/gi,
  },
  {
    // Any request to move a secret somewhere. Common in API docs ("send your API key in the header"), so flag only.
    id: 'credential-handling',
    severity: 'medium',
    re: /\b(?:send|post|upload|forward|transmit|exfiltrate|leak|email|share|paste)\b[^.\n]{0,40}?\b(?:cookies?|session\s+(?:ids?|tokens?)|credentials?|passwords?|private\s+keys?|ssh\s+keys?|env(?:ironment)?\s+variables?|localstorage|sessionstorage)\b/gi,
  },
  {
    id: 'prompt-leak',
    severity: 'medium',
    re: /\b(?:reveal|print|output|repeat|show|dump)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+)?(?:system\s+prompt|initial\s+prompt|instructions|hidden\s+prompt)\b/gi,
  },
];

// Zero-width, bidi-control and other invisible formatting characters used to hide or split payloads
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0xad, 0xad], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => String.fromCharCode(a) + (b !== a ? '-' + String.fromCharCode(b) : '')).join('')}]`, 'g');
// Unicode "tag" characters (U+E0000–U+E007F) render as nothing but map 1:1 to ASCII ("ASCII smuggling")
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(text: string): { text: string; removed: number; smuggled: string } {
  let removed = 0;
  let smuggled = '';
  let out = text.replace(TAG_CHARS, (ch) => {
    removed++;
    const cp = ch.codePointAt(0)! - 0xe0000;
    if (cp >= 0x20 && cp < 0x7f) smuggled += String.fromCharCode(cp);
    return '';
  });
  out = out.replace(INVISIBLE, () => {
    removed++;
    return '';
  });
  return { text: out, removed, smuggled };
}

function excerpt(text: string, start: number, end: number): string {
  const s = text.slice(Math.max(0, start - 20), Math.min(text.length, end + 20)).replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

// Scan already-stripped text. Offsets refer to `text`.
export function scanText(text: string, location: Finding['location'] = 'text'): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const start = m.index + (m[0].length - m[0].trimStart().length);
      const end = m.index + m[0].length;
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        excerpt: excerpt(text, start, end),
        location,
        ...(location === 'text' ? { start, end } : {}),
      });
      if (findings.length > 200) return findings;
    }
  }
  return findings;
}

// Inline-style signals that make text invisible to a person but not to a text extractor.
// Only inline styles and attributes are seen; stylesheet rules are not evaluated.
function hiddenReason(tag: string, attrs: Record<string, string>): string | null {
  if ('hidden' in attrs) return 'hidden attribute';
  if (attrs['aria-hidden'] === 'true') return 'aria-hidden';
  if (tag === 'template' || tag === 'noscript') return null;
  const style = (attrs.style || '').toLowerCase().replace(/\s+/g, '');
  if (!style) return null;
  if (/display:none/.test(style)) return 'display:none';
  if (/visibility:(hidden|collapse)/.test(style)) return 'visibility:hidden';
  if (/(^|;)opacity:0(\.0+)?(;|$|!)/.test(style)) return 'opacity:0';
  if (/font-size:0(px|em|rem|pt|%)?(;|$|!)/.test(style) || /font-size:0?\.[0-9]+px/.test(style) || /font-size:1px/.test(style)) return 'font-size ~0';
  if (/(^|;)color:transparent/.test(style)) return 'transparent text';
  if (/(left|top|right|text-indent|margin-left):-\d{3,}/.test(style)) return 'positioned off-screen';
  if (/clip:rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)/.test(style) || /clip-path:inset\(50%\)/.test(style)) return 'clipped';
  if (/(^|;)(width|height|max-height|max-width):0(px)?(;|$|!)/.test(style) && /overflow:hidden/.test(style)) return 'zero-size box';
  return null;
}

// Find instruction-like text a person would not see: elements hidden by inline CSS / attributes, and
// HTML comments. Visible text is scanned separately on the tool output itself.
export function scanHiddenHtml(html: string, limitBytes = 2_000_000): Finding[] {
  if (!html) return [];
  let doc: any;
  try {
    doc = parse5.parse(html.length > limitBytes ? html.slice(0, limitBytes) : html);
  } catch {
    return [];
  }
  const findings: Finding[] = [];
  const add = (text: string, hiddenBy: string) => {
    const { text: clean } = stripInvisible(text);
    if (clean.trim().length < 8) return;
    for (const f of scanText(clean, 'hidden-html')) {
      findings.push({ ...f, hiddenBy, severity: f.severity === 'medium' ? 'high' : f.severity });
    }
  };
  const textOf = (node: any): string => {
    if (node.nodeName === '#text') return node.value || '';
    if (node.tagName === 'script' || node.tagName === 'style') return '';
    return (node.childNodes || []).map(textOf).join(' ');
  };
  const walk = (node: any) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === '#comment') {
        add(child.data || '', 'HTML comment');
        continue;
      }
      if (!child.tagName) continue;
      if (child.tagName === 'script' || child.tagName === 'style') continue;
      const attrs: Record<string, string> = {};
      for (const a of child.attrs || []) attrs[a.name.toLowerCase()] = a.value;
      const reason = hiddenReason(child.tagName, attrs);
      if (reason) {
        add(textOf(child), reason);
        continue;
      }
      if (child.tagName === 'template' && child.content) walk(child.content);
      walk(child);
    }
  };
  walk(doc);
  return findings;
}

export function summarizeFindings(findings: Finding[]): { high: number; medium: number; low: number; rules: string[] } {
  const counts = { high: 0, medium: 0, low: 0 };
  const rules = new Set<string>();
  for (const f of findings) {
    counts[f.severity]++;
    rules.add(f.rule);
  }
  return { ...counts, rules: [...rules] };
}
