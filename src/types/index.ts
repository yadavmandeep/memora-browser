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
  // Sent as "Proxy-Authorization: Bearer <token>" (Lightpanda --proxy-bearer-token parity)
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
}

export interface BrowserOptions {
  port?: number;
  host?: string;
  stealth?: boolean;
  userAgent?: string;
  viewport?: { width: number; height: number };
  timeout?: number;
  network?: NetworkOptions;
}
