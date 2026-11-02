/**
 * Measures the firewall's phrase scanner on labelled data. Prints recall on attacks and false-positive
 * rates on benign text, per source. Nothing here is used at runtime.
 *
 *   npx tsx scripts/measure-firewall.ts <datasets-dir> [benign-docs-dir ...]
 *
 * <datasets-dir> holds HuggingFace datasets-server "rows" JSON pages (one file per 100 rows):
 *   deepset_prompt-injections_{train,test}_*.json            text + label (1 = injection, 0 = benign)
 *   Lakera_gandalf_ignore_instructions_{train,validation,test}_*.json   all injections
 * [benign-docs-dir] are folders of .md files; every paragraph counts as one benign sample.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanText, stripInvisible, Finding } from '../src/firewall/scanner.js';

interface Sample { text: string; attack: boolean; source: string }

const [dataDir, ...docDirs] = process.argv.slice(2);
if (!dataDir) {
  console.error('usage: tsx scripts/measure-firewall.ts <datasets-dir> [benign-docs-dir ...]');
  process.exit(1);
}

const samples: Sample[] = [];
for (const f of fs.readdirSync(dataDir).filter((n) => n.endsWith('.json')).sort()) {
  const rows = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')).rows || [];
  for (const { row } of rows) {
    if (f.startsWith('deepset_')) samples.push({ text: row.text, attack: row.label === 1, source: 'deepset/prompt-injections' });
    else if (f.startsWith('Lakera_')) samples.push({ text: row.text, attack: true, source: 'Lakera/gandalf_ignore_instructions' });
  }
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}
for (const dir of docDirs) {
  for (const file of walk(dir)) {
    // Paragraphs outside fenced code blocks
    const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const para of text.split(/\n\s*\n/)) {
      if (para.trim().length >= 40) samples.push({ text: para, attack: false, source: `docs:${path.basename(path.dirname(path.resolve(dir)))}/${path.basename(dir)}` });
    }
  }
}

// Rough language split for deepset (it mixes English and German)
const GERMAN = /\b(und|der|die|das|ich|nicht|ist|sie|du|vergiss|alle|ein|eine|mit|wie|was|auf)\b/gi;
const lang = (t: string) => ((t.match(GERMAN) || []).length >= 2 ? 'de' : 'en');

function scan(t: string): Finding[] {
  const s = stripInvisible(t);
  return [...scanText(s.text), ...(s.smuggled ? scanText(s.smuggled, 'unicode-tags') : [])];
}

type Row = { n: number; any: number; high: number; rules: Map<string, number>; examples: string[] };
const groups = new Map<string, Row>();
const add = (key: string, f: Finding[], text: string) => {
  const g = groups.get(key) || { n: 0, any: 0, high: 0, rules: new Map(), examples: [] };
  g.n++;
  if (f.length) g.any++;
  if (f.some((x) => x.severity === 'high')) g.high++;
  for (const r of new Set(f.map((x) => x.rule))) g.rules.set(r, (g.rules.get(r) || 0) + 1);
  if (f.length && g.examples.length < 5) g.examples.push(`${[...new Set(f.map((x) => x.rule))].join(',')} | ${text.replace(/\s+/g, ' ').slice(0, 110)}`);
  groups.set(key, g);
};

for (const s of samples) {
  const f = scan(s.text);
  const base = `${s.attack ? 'ATTACK' : 'BENIGN'} ${s.source}`;
  add(base, f, s.text);
  if (s.source.startsWith('deepset')) add(`${base} [${lang(s.text)}]`, f, s.text);
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
console.log('\nkind/source                                          n    any finding   high (redacted)');
for (const [k, g] of [...groups].sort()) {
  console.log(`${k.padEnd(52)} ${String(g.n).padStart(5)}   ${`${g.any} (${pct(g.any, g.n)})`.padEnd(14)} ${g.high} (${pct(g.high, g.n)})`);
}
console.log('\nAttack rows: "any finding" is recall (flagged), "high" is the share that would be redacted.');
console.log('Benign rows: both columns are false-positive rates.\n');
for (const [k, g] of [...groups].sort()) {
  if (!g.examples.length) continue;
  console.log(`-- ${k}: rules ${[...g.rules].map(([r, c]) => `${r}=${c}`).join(' ')}`);
  for (const e of g.examples) console.log(`   ${e}`);
}
