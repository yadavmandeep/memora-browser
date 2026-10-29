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

