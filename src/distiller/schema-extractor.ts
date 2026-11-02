import { MemoraDocument, MemoraElement } from '../dom/node.js';

export interface DynamicExtractionSchema {
  // Field name -> description or expected type (e.g., { "rating": "number between 1-5", "reviews": "list of review texts" })
  fields?: Record<string, string>;
  // Optional selector hints or focus areas provided by AI
  hints?: Record<string, string>;
  // Max items for list fields
  maxListItems?: number;
}

export interface UniversalExtractedData {
  url: string;
  title: string;
  // All structured data found natively on the page (Schema.org JSON-LD, Microdata, OpenGraph)
  structuredData: {
    jsonLdTypes: string[];
    primaryEntities: any[];
    meta: Record<string, string>;
  };
  // Dynamically populated fields requested by AI
  extractedFields: Record<string, any>;
  // Key semantic sections (tables, key-value lists, headings, reviews/comments, action links)
  tables: Array<{ headers: string[]; rows: string[][] }>;
  keyValuePairs: Record<string, string>;
  actionLinks: Array<{ label: string; href: string }>;
}

/**
 * Universal schema-guided extractor that works for ANY use case:
 * Restaurants, e-commerce, flights, real estate, docs, jobs, financial data, etc.
 * Driven by the AI's requested schema rather than hardcoded keywords.
 */
export function extractWithSchema(
  doc: MemoraDocument | any,
  url: string,
  schema?: DynamicExtractionSchema
): UniversalExtractedData {
  const title = (doc.title || '').trim();
  const meta: Record<string, string> = {};
  const jsonLdEntities: any[] = [];
  const jsonLdTypes: string[] = [];

  // 1. Ingest all JSON-LD without filtering types (supports Product, Place, JobPosting, Recipe, Event, etc.)
  const scripts = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('script') : [];
  for (const s of scripts) {
    const type = typeof s.getAttribute === 'function' ? s.getAttribute('type') : s.type;
    if (type === 'application/ld+json') {
      const raw = (s.textContent || '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
        for (const item of items) {
          if (item && typeof item === 'object') {
            const itemType = String(item['@type'] || 'Thing');
            jsonLdTypes.push(itemType);
            jsonLdEntities.push(item);
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  // 2. Ingest OpenGraph and Meta tags
  const metaTags = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('meta') : [];
  for (const m of metaTags) {
    const name = (m.getAttribute?.('name') || m.getAttribute?.('property') || '').toLowerCase();
    const content = m.getAttribute?.('content') || m.getAttribute?.('value') || '';
    if (name && content) {
      meta[name] = content;
    }
  }

  // 3. Extract semantic tables from DOM
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const tableElements = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('table') : [];
  for (const tbl of tableElements.slice(0, 5)) {
    const headers: string[] = [];
    const ths = tbl.querySelectorAll?.('th') || [];
    for (const th of ths) {
      headers.push((th.textContent || '').trim());
    }

    const rows: string[][] = [];
    const trs = tbl.querySelectorAll?.('tr') || [];
    for (const tr of trs.slice(0, 20)) {
      const tds = tr.querySelectorAll?.('td') || [];
      if (tds.length) {
        rows.push(tds.map((td: any) => (td.textContent || '').trim()));
      }
    }

    if (headers.length || rows.length) {
      tables.push({ headers, rows });
    }
  }

  // 4. Extract key-value pairs (from <dl>, <dt>/<dd>, or bold spans followed by text)
  const keyValuePairs: Record<string, string> = {};
  const dts = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('dt') : [];
  for (const dt of dts) {
    const key = (dt.textContent || '').trim().replace(/:$/, '');
    const dd = dt.nextElementSibling;
    if (key && dd && dd.tagName === 'dd') {
      keyValuePairs[key] = (dd.textContent || '').trim();
    }
  }

  // 5. Extract interactive action links (e.g. buy, order, apply, download, login)
  const actionLinks: Array<{ label: string; href: string }> = [];
  const links = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('a') : [];
  for (const a of links) {
    const href = a.getAttribute?.('href') || a.href;
    const label = (a.textContent || '').trim();
    if (href && href.startsWith('http') && label.length > 2 && label.length < 50) {
      actionLinks.push({ label, href });
      if (actionLinks.length >= 15) break;
    }
  }

  // 6. Dynamically resolve fields requested by AI
  const extractedFields: Record<string, any> = {};
  if (schema?.fields) {
    for (const [fieldKey, fieldDescription] of Object.entries(schema.fields)) {
      extractedFields[fieldKey] = resolveFieldDynamically(
        fieldKey,
        fieldDescription,
        jsonLdEntities,
        meta,
        keyValuePairs,
        doc
      );
    }
  }

  return {
    url,
    title,
    structuredData: {
      jsonLdTypes,
      primaryEntities: jsonLdEntities.slice(0, 5),
      meta
    },
    extractedFields,
    tables,
    keyValuePairs,
    actionLinks
  };
}

/**
 * Resolves a field dynamically based on JSON-LD schemas, meta tags, and DOM queries
 * without any domain-specific hardcoded keywords.
 */
function resolveFieldDynamically(
  fieldKey: string,
  fieldDesc: string,
  jsonLdEntities: any[],
  meta: Record<string, string>,
  keyValuePairs: Record<string, string>,
  doc: any
): any {
  const normKey = fieldKey.toLowerCase();

  // A. Check JSON-LD entities first (highest fidelity)
  for (const entity of jsonLdEntities) {
    if (entity[fieldKey] !== undefined) return entity[fieldKey];
    if (entity[normKey] !== undefined) return entity[normKey];

    // Check nested common schema patterns
    if (normKey.includes('rating') && entity.aggregateRating) {
      return entity.aggregateRating;
    }
    if (normKey.includes('address') && entity.address) {
      return typeof entity.address === 'object' ? Object.values(entity.address).filter(Boolean).join(', ') : entity.address;
    }
    if (normKey.includes('price') && (entity.price || entity.offers?.price)) {
      return entity.offers?.price || entity.price;
    }
    if ((normKey.includes('review') || normKey.includes('feedback')) && entity.review) {
      return Array.isArray(entity.review)
        ? entity.review.slice(0, 5).map((r: any) => ({
            author: typeof r.author === 'string' ? r.author : r.author?.name,
            rating: r.reviewRating?.ratingValue,
            text: r.reviewBody || r.description
          }))
        : entity.review;
    }
    if (normKey.includes('author') && entity.author) return entity.author;
    if (normKey.includes('date') && (entity.datePublished || entity.dateModified)) {
      return entity.datePublished || entity.dateModified;
    }
    if (normKey.includes('hour') && (entity.openingHours || entity.openingHoursSpecification)) {
      return entity.openingHours || entity.openingHoursSpecification;
    }
  }

  // B. Check Meta tags (OpenGraph, Twitter, standard meta)
  for (const [metaName, metaVal] of Object.entries(meta)) {
    if (metaName.includes(normKey)) return metaVal;
  }

  // C. Check Key-Value pairs extracted from page
  for (const [kvKey, kvVal] of Object.entries(keyValuePairs)) {
    if (kvKey.toLowerCase().includes(normKey) || normKey.includes(kvKey.toLowerCase())) {
      return kvVal;
    }
  }

  // D. Semantic DOM lookup based on class or attribute matching the field key
  if (typeof doc.querySelectorAll === 'function') {
    const candidates = doc.querySelectorAll(`[class*="${normKey}"], [id*="${normKey}"], [data-${normKey}], [itemprop="${normKey}"]`);
    if (candidates.length > 0) {
      const texts = Array.from(candidates).slice(0, 3).map((c: any) => (c.textContent || '').trim()).filter(Boolean);
      if (texts.length === 1) return texts[0];
      if (texts.length > 1) return texts;
    }
  }

  return null;
}

