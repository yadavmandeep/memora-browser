import { MemoraDocument, MemoraElement } from '../dom/node.js';

export interface StructuredPageData {
  url: string;
  title: string;
  description?: string;
  canonical?: string;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  meta: Record<string, string>;
  jsonLd: any[];
}

export function extractStructuredData(doc: MemoraDocument, url: string): StructuredPageData {
  const result: StructuredPageData = {
    url,
    title: doc.title || '',
    openGraph: {},
    twitter: {},
    meta: {},
    jsonLd: []
  };

  // 1. Process <meta> tags
  const metaTags = doc.querySelectorAll('meta');
  for (const meta of metaTags) {
    const name = meta.getAttribute('name')?.toLowerCase();
    const prop = meta.getAttribute('property')?.toLowerCase();
    const content = meta.getAttribute('content') || meta.getAttribute('value') || '';

    if (!content) continue;

    if (prop && prop.startsWith('og:')) {
      result.openGraph[prop] = content;
      if (prop === 'og:title' && !result.title) result.title = content;
      if (prop === 'og:description' && !result.description) result.description = content;
    } else if (name && (name.startsWith('twitter:') || name.startsWith('og:'))) {
      if (name.startsWith('twitter:')) {
        result.twitter[name] = content;
      } else {
        result.openGraph[name] = content;
      }
    } else if (name) {
      result.meta[name] = content;
      if (name === 'description') result.description = content;
    }
  }

  // 2. Canonical link
  const canonicalEl = doc.querySelector('link[rel="canonical"]');
  if (canonicalEl) {
    result.canonical = canonicalEl.getAttribute('href') || undefined;
  }

  // 3. JSON-LD scripts (<script type="application/ld+json">)
  const scripts = doc.querySelectorAll('script');
  for (const s of scripts) {
    const type = s.getAttribute('type');
    if (type === 'application/ld+json') {
      const txt = s.textContent.trim();
      if (txt) {
        try {
          const parsed = JSON.parse(txt);
          result.jsonLd.push(parsed);
        } catch {
          // Ignore invalid JSON in script tag
        }
      }
    }
  }

  return result;
}


export interface ScrapedLink {
  text: string;
  url: string;
}

export interface LinksGraph {
  url: string;
  total: number;
  internalCount: number;
  externalCount: number;
  internal: ScrapedLink[];
  external: ScrapedLink[];
}

export interface ScrapedPageContent {
  title: string;
  url: string;
  description?: string;
  headings: Array<{ level: number; text: string }>;
  sections: Array<{ heading: string; content: string }>;
  summaryText: string;
  links: LinksGraph;
}

export function extractScrapedContent(doc: MemoraDocument, url: string): ScrapedPageContent {
  const title = doc.title || '';
  const descEl = doc.querySelector('meta[name="description"]') || doc.querySelector('meta[property="og:description"]');
  const description = descEl?.getAttribute('content') || undefined;

  const headings: Array<{ level: number; text: string }> = [];
  const sections: Array<{ heading: string; content: string }> = [];

  const headingEls = doc.querySelectorAll('h1, h2, h3, h4');
  for (const h of headingEls) {
    const text = h.textContent.trim();
    if (text) {
      const level = parseInt(h.tagName.charAt(1), 10);
      headings.push({ level, text });

      let sibling = h.nextSibling;
      const contentParts: string[] = [];
      let count = 0;
      while (sibling && count < 5) {
        if (sibling.nodeType === 1 && /^h[1-4]$/i.test((sibling as any).tagName)) {
          break;
        }
        if (sibling.textContent) {
          const t = sibling.textContent.trim();
          if (t && t.length > 25) {
            contentParts.push(t);
            count++;
          }
        }
        sibling = sibling.nextSibling;
      }
      if (contentParts.length > 0) {
        sections.push({ heading: text, content: contentParts.slice(0, 2).join(' ') });
      }
    }
  }

  const summaryText = sections.length > 0
    ? sections.map(s => s.heading + ': ' + s.content).join('\n\n').slice(0, 3000)
    : (description || title);

  const links = extractLinks(doc, url);

  return {
    title,
    url,
    description,
    headings: headings.slice(0, 15),
    sections: sections.slice(0, 8),
    summaryText,
    links
  };
}

export function extractLinks(doc: MemoraDocument, url: string): LinksGraph {
  let baseOrigin = '';
  try {
    baseOrigin = new URL(url).origin;
  } catch {}

  const seenUrls = new Set<string>();
  const internal: ScrapedLink[] = [];
  const external: ScrapedLink[] = [];

  const anchorEls = doc.querySelectorAll('a[href]');
  for (const a of anchorEls) {
    const rawHref = a.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
      continue;
    }
    let absUrl = rawHref;
    try {
      absUrl = new URL(rawHref, url).href;
    } catch {
      continue;
    }

    if (seenUrls.has(absUrl)) continue;
    seenUrls.add(absUrl);

    const anchorText = (a.textContent || '').replace(/\s+/g, ' ').trim() || absUrl;
    const isInternal = baseOrigin ? absUrl.startsWith(baseOrigin) : false;

    if (isInternal) {
      internal.push({ text: anchorText, url: absUrl });
    } else if (absUrl.startsWith('http')) {
      external.push({ text: anchorText, url: absUrl });
    }
  }

  return {
    url,
    total: internal.length + external.length,
    internalCount: internal.length,
    externalCount: external.length,
    internal,
    external
  };
}
