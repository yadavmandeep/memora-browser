export * from '../distiller/structured-data.js';

export interface NodeAttribute {
  name: string;
  value: string;
}

// Standard DOM numeric node types: ELEMENT_NODE, TEXT_NODE, COMMENT_NODE, DOCUMENT_NODE
export type NodeType = 1 | 3 | 8 | 9;

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InteractiveElement {
  actionId: string; // e.g. "@1", "@2"
  tag: string;
  role: string;
  text: string;
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  selector: string;
  isClickable: boolean;
  isInput: boolean;
  disabled: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
}

export interface SnapshotOptions {
  focusSelector?: string;
  excludeSelectors?: string[];
  filterHidden?: boolean;
  maxActions?: number;
  compactSelectors?: boolean;
}

export interface SemanticPageSnapshot {
  url: string;
  title: string;
  tokenEstimate: number;
  interactiveCount: number;
  actions: InteractiveElement[];
  actionMapText: string;
  markdown: string;
}

export interface PageDiff {
  urlChanged: boolean;
  previousUrl: string;
  currentUrl: string;
  titleChanged: boolean;
  previousTitle: string;
  currentTitle: string;
  addedActions: InteractiveElement[];
  removedActions: InteractiveElement[];
  mutatedActions: Array<{
    actionId: string;
    selector: string;
    role: string;
    text: string;
    changes: Record<string, { from: any; to: any }>;
  }>;
  summary: string;
}

export interface FormFillOptions {
  fields?: Record<string, string>; // target (actionId or selector) -> value
  submit?: string | boolean; // selector/actionId of button to click, or boolean to auto-submit form
  submitActionId?: string; // alias for submit (backward compatibility)
  steps?: FormFillOptions[]; // sequence of form steps
}

export type FormStep = FormFillOptions;

export interface FormFillResult {
  success: boolean;
  filled: string[];
  skipped: string[];
  fieldsFilled: number;
  submitted: boolean;
  url: string;
  title: string;
}

export interface SessionData {
  version: 1;
  createdAt: string;
  url: string;
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface PageState {
  url: string;
  html: string;
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, any>;
  sessionId?: string;
}

export interface CDPResponse {
  id: number;
  result?: Record<string, any>;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  sessionId?: string;
}

export interface CDPEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

export interface NetworkOptions {
  // Proxy URL: http://, https://, socks5:// (credentials allowed as user:pass@host)
  proxy?: string;
  // Sent as "Proxy-Authorization: Bearer <token>"
  proxyBearerToken?: string;
  // Hosts that bypass the proxy, e.g. ["localhost", ".internal.corp", "10.0.0.5"]
  noProxy?: string[];
  // Fall back to HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY when no explicit proxy is set
  useEnvProxy?: boolean;
  // Extra headers added to every outgoing request
  headers?: Record<string, string>;
  userAgent?: string;
  timeoutMs?: number;
  // Skip TLS certificate verification (self-signed staging certs, MITM proxies)
  insecureTls?: boolean;
  // Check every request against the target origin's robots.txt (RFC 9309) and block disallowed ones
  obeyRobots?: boolean;
  // Product token matched against robots.txt User-agent lines (default "MemoraBrowser")
  robotsAgent?: string;
  // Seconds to pause requests to a host after a blocking challenge or 429 (default 60, 0 disables).
  // A Retry-After header from the site takes precedence.
  challengeCooldownSec?: number;
  // What navigation does on a blocking challenge (interstitial, block page, 429):
  // 'report' (default) loads it and exposes the signal; 'stop' throws ChallengeDetectedError
  onChallenge?: 'report' | 'stop';
}

export interface BrowserOptions {
  port?: number;
  host?: string;
  stealth?: boolean;
  userAgent?: string;
  viewport?: { width: number; height: number };
  timeout?: number;
  network?: NetworkOptions;
  engine?: 'native' | 'chrome' | 'auto';
  apiKey?: string;
}
