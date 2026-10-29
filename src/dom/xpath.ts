import { MemoraNode, MemoraElement, MemoraTextNode, MemoraCommentNode } from './node.js';

// Compact XPath 1.0 evaluator covering what test suites actually write:
// location paths with all common axes, predicates, positions, unions, and the
// core string/boolean/number functions. Attribute results are not returned as nodes.

type Attr = { attr: true; name: string; value: string; owner: MemoraElement };
type XNode = MemoraNode | Attr;
type Value = XNode[] | string | number | boolean;

type Test = { kind: 'name'; name: string } | { kind: 'any' } | { kind: 'text' } | { kind: 'node' } | { kind: 'comment' };
type Step = { axis: string; test: Test; preds: Expr[] };
type Expr =
  | { t: 'path'; absolute: boolean; steps: Step[]; filter?: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'neg'; e: Expr }
  | { t: 'lit'; v: string }
  | { t: 'num'; v: number }
  | { t: 'fn'; name: string; args: Expr[] }
  | { t: 'union'; parts: Expr[] }
  | { t: 'filter'; e: Expr; preds: Expr[] };

export class XPathError extends Error {}

const AXES = new Set([
  'child', 'descendant', 'descendant-or-self', 'parent', 'ancestor', 'ancestor-or-self',
  'following-sibling', 'preceding-sibling', 'following', 'preceding', 'self', 'attribute',
]);

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  const re = /\s*(\/\/|\/|\[|\]|\(|\)|@|,|\||!=|<=|>=|=|<|>|::|\.\.|\.(?!\d)|\*|\+|-(?![\w])|"[^"]*"|'[^']*'|\d+(?:\.\d+)?|\.\d+|[A-Za-z_][\w.-]*(?::[A-Za-z_*][\w.-]*)?|\$[\w-]+)\s*/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s+$/.test(src.slice(pos))) break;
      throw new XPathError(`Unexpected character at ${pos} in "${src}"`);
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

class Parser {
  private i = 0;
  constructor(private tokens: string[]) {}

  private peek(offset = 0): string | undefined { return this.tokens[this.i + offset]; }
  private next(): string { return this.tokens[this.i++]; }
  private expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new XPathError(`Expected "${tok}" but found "${got ?? 'end'}"`);
  }

  parse(): Expr {
    const e = this.orExpr();
    if (this.i < this.tokens.length) throw new XPathError(`Unexpected token "${this.peek()}"`);
    return e;
  }

  private orExpr(): Expr {
    let l = this.andExpr();
    while (this.peek() === 'or') { this.next(); l = { t: 'bin', op: 'or', l, r: this.andExpr() }; }
    return l;
  }
  private andExpr(): Expr {
    let l = this.eqExpr();
    while (this.peek() === 'and') { this.next(); l = { t: 'bin', op: 'and', l, r: this.eqExpr() }; }
    return l;
  }
  private eqExpr(): Expr {
    let l = this.relExpr();
    while (this.peek() === '=' || this.peek() === '!=') { const op = this.next(); l = { t: 'bin', op, l, r: this.relExpr() }; }
    return l;
  }
  private relExpr(): Expr {
    let l = this.addExpr();
    while (['<', '>', '<=', '>='].includes(this.peek() || '')) { const op = this.next(); l = { t: 'bin', op, l, r: this.addExpr() }; }
    return l;
  }
  private addExpr(): Expr {
    let l = this.unaryExpr();
    while (this.peek() === '+' || this.peek() === '-') { const op = this.next(); l = { t: 'bin', op, l, r: this.unaryExpr() }; }
    return l;
  }
  private unaryExpr(): Expr {
    if (this.peek() === '-') { this.next(); return { t: 'neg', e: this.unaryExpr() }; }
    return this.unionExpr();
  }
  private unionExpr(): Expr {
    const first = this.pathExpr();
    if (this.peek() !== '|') return first;
    const parts = [first];
    while (this.peek() === '|') { this.next(); parts.push(this.pathExpr()); }
    return { t: 'union', parts };
  }

  private isPrimaryStart(): boolean {
    const tok = this.peek();
    if (!tok) return false;
    if (tok === '(' || tok.startsWith('"') || tok.startsWith("'") || /^\.?\d/.test(tok)) return true;
    return /^[A-Za-z_]/.test(tok) && this.peek(1) === '(' && !['text', 'node', 'comment', 'processing-instruction'].includes(tok);
  }

  private pathExpr(): Expr {
    if (this.isPrimaryStart()) {
      const primary = this.primary();
      const preds: Expr[] = [];
      while (this.peek() === '[') preds.push(this.predicate());
      let filter: Expr = primary;
      if (preds.length) filter = { t: 'filter', e: primary, preds };
      if (this.peek() === '/' || this.peek() === '//') {
        const steps = this.relativeSteps(true);
        return { t: 'path', absolute: false, steps, filter };
      }
      return filter;
    }
    if (this.peek() === '/' || this.peek() === '//') {
      if (this.peek() === '/' && !this.stepStarts(1)) { this.next(); return { t: 'path', absolute: true, steps: [] }; }
      return { t: 'path', absolute: true, steps: this.relativeSteps(true) };
    }
    return { t: 'path', absolute: false, steps: this.relativeSteps(false) };
  }

  private stepStarts(offset: number): boolean {
    const tok = this.peek(offset);
    return !!tok && (tok === '.' || tok === '..' || tok === '@' || tok === '*' || /^[A-Za-z_]/.test(tok));
  }

  private relativeSteps(leadingSep: boolean): Step[] {
    const steps: Step[] = [];
    if (!leadingSep) steps.push(this.step());
    while (this.peek() === '/' || this.peek() === '//') {
      if (this.next() === '//') steps.push({ axis: 'descendant-or-self', test: { kind: 'node' }, preds: [] });
      steps.push(this.step());
    }
    return steps;
  }

  private step(): Step {
    const tok = this.peek();
    if (tok === '.') { this.next(); return { axis: 'self', test: { kind: 'node' }, preds: [] }; }
    if (tok === '..') { this.next(); return { axis: 'parent', test: { kind: 'node' }, preds: [] }; }
    let axis = 'child';
    if (tok === '@') { this.next(); axis = 'attribute'; }
    else if (tok && AXES.has(tok) && this.peek(1) === '::') { axis = this.next(); this.next(); }
    const test = this.nodeTest();
    const preds: Expr[] = [];
    while (this.peek() === '[') preds.push(this.predicate());
    return { axis, test, preds };
  }

  private nodeTest(): Test {
    const tok = this.next();
    if (!tok) throw new XPathError('Unexpected end of expression');
    if (tok === '*') return { kind: 'any' };
    if (this.peek() === '(' && ['text', 'node', 'comment'].includes(tok)) {
      this.next(); this.expect(')');
      return tok === 'text' ? { kind: 'text' } : tok === 'comment' ? { kind: 'comment' } : { kind: 'node' };
    }
    if (!/^[A-Za-z_]/.test(tok)) throw new XPathError(`Invalid node test "${tok}"`);
    return { kind: 'name', name: tok.includes(':') ? tok.split(':')[1].toLowerCase() : tok.toLowerCase() };
  }

  private predicate(): Expr {
    this.expect('[');
    const e = this.orExpr();
    this.expect(']');
    return e;
  }

  private primary(): Expr {
    const tok = this.next();
    if (tok === '(') { const e = this.orExpr(); this.expect(')'); return e; }
    if (tok.startsWith('"') || tok.startsWith("'")) return { t: 'lit', v: tok.slice(1, -1) };
    if (/^\.?\d/.test(tok)) return { t: 'num', v: parseFloat(tok) };
    this.expect('(');
    const args: Expr[] = [];
    if (this.peek() !== ')') {
      args.push(this.orExpr());
      while (this.peek() === ',') { this.next(); args.push(this.orExpr()); }
    }
    this.expect(')');
    return { t: 'fn', name: tok, args };
  }
}

function isAttr(n: XNode): n is Attr { return (n as Attr).attr === true; }
function isRealElement(n: MemoraNode): n is MemoraElement {
  return n instanceof MemoraElement && !n.tagName.startsWith('#');
}

function stringValue(n: XNode): string {
  if (isAttr(n)) return n.value;
  return n.textContent;
}

function toStr(v: Value): string {
  if (Array.isArray(v)) return v.length ? stringValue(v[0]) : '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}
function toNum(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = toStr(v).trim();
  return s === '' ? NaN : Number(s);
}
function toBool(v: Value): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v !== 0 && !isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return v;
}

function children(n: XNode): MemoraNode[] {
  return isAttr(n) ? [] : n.childNodes;
}
function parentOf(n: XNode): MemoraNode | null {
  return isAttr(n) ? n.owner : n.parentNode;
}
function descendants(n: XNode, out: MemoraNode[]): void {
  for (const c of children(n)) { out.push(c); descendants(c, out); }
}

function axisNodes(n: XNode, axis: string): XNode[] {
  switch (axis) {
    case 'child': return children(n);
    case 'self': return [n];
    case 'parent': { const p = parentOf(n); return p ? [p] : []; }
    case 'descendant': { const out: MemoraNode[] = []; descendants(n, out); return out; }
    case 'descendant-or-self': { const out: XNode[] = [n]; descendants(n, out as MemoraNode[]); return out; }
    case 'ancestor':
    case 'ancestor-or-self': {
      const out: XNode[] = axis === 'ancestor-or-self' ? [n] : [];
      let p = parentOf(n);
      while (p) { out.push(p); p = p.parentNode; }
      return out;
    }
    case 'following-sibling':
    case 'preceding-sibling': {
      if (isAttr(n) || !n.parentNode) return [];
      const sibs = n.parentNode.childNodes;
      const idx = sibs.indexOf(n);
      return axis === 'following-sibling' ? sibs.slice(idx + 1) : sibs.slice(0, idx).reverse();
    }
    case 'following': {
      const out: MemoraNode[] = [];
      let cur: XNode | null = n;
      while (cur && !isAttr(cur) && cur.parentNode) {
        const sibs: MemoraNode[] = cur.parentNode.childNodes;
        for (const s of sibs.slice(sibs.indexOf(cur) + 1)) { out.push(s); descendants(s, out); }
        cur = cur.parentNode;
      }
      return out;
    }
    case 'preceding': {
      const out: MemoraNode[] = [];
      let cur: XNode | null = n;
      while (cur && !isAttr(cur) && cur.parentNode) {
        const sibs: MemoraNode[] = cur.parentNode.childNodes;
        for (const s of sibs.slice(0, sibs.indexOf(cur)).reverse()) {
          const sub: MemoraNode[] = []; descendants(s, sub);
          out.push(...sub.reverse(), s);
        }
        cur = cur.parentNode;
      }
      return out;
    }
    case 'attribute': {
      if (isAttr(n) || !(n instanceof MemoraElement)) return [];
      return Array.from(n.attributes.entries()).map(([name, value]) => ({ attr: true as const, name, value, owner: n }));
    }
    default:
      throw new XPathError(`Unsupported axis "${axis}"`);
  }
}

function matchesTest(n: XNode, test: Test, axis: string): boolean {
  if (axis === 'attribute') {
    if (!isAttr(n)) return false;
    return test.kind === 'any' || test.kind === 'node' || (test.kind === 'name' && n.name === test.name);
  }
  if (isAttr(n)) return false;
  switch (test.kind) {
    case 'node': return true;
    case 'any': return isRealElement(n);
    case 'text': return n instanceof MemoraTextNode;
    case 'comment': return n instanceof MemoraCommentNode;
    case 'name': return isRealElement(n) && n.tagName === test.name;
  }
}

const REVERSE_AXES = new Set(['ancestor', 'ancestor-or-self', 'preceding', 'preceding-sibling']);

class Evaluator {
  private order: Map<MemoraNode, number> | null = null;

  constructor(private root: MemoraNode) {}

  private docOrder(nodes: XNode[]): XNode[] {
    if (nodes.length < 2) return nodes;
    if (!this.order) {
      this.order = new Map();
      let i = 0;
      const walk = (n: MemoraNode) => { this.order!.set(n, i++); n.childNodes.forEach(walk); };
      walk(this.root);
    }
    const key = (n: XNode) => isAttr(n) ? (this.order!.get(n.owner) ?? 0) + 0.5 : (this.order!.get(n) ?? 0);
    const unique = Array.from(new Set(nodes));
    return unique.sort((a, b) => key(a) - key(b));
  }

  eval(e: Expr, ctx: XNode, pos: number, size: number): Value {
    switch (e.t) {
      case 'lit': return e.v;
      case 'num': return e.v;
      case 'neg': return -toNum(this.eval(e.e, ctx, pos, size));
      case 'union': {
        const all: XNode[] = [];
        for (const p of e.parts) {
          const v = this.eval(p, ctx, pos, size);
          if (!Array.isArray(v)) throw new XPathError('Union operands must be node-sets');
          all.push(...v);
        }
        return this.docOrder(all);
      }
      case 'path': {
        let nodes: XNode[];
        if (e.filter) {
          const v = this.eval(e.filter, ctx, pos, size);
          if (!Array.isArray(v)) {
            if (e.steps.length) throw new XPathError('Path step applied to a non-node-set');
            return v;
          }
          nodes = v;
        } else {
          nodes = [e.absolute ? this.root : ctx];
        }
        for (const step of e.steps) {
          const out: XNode[] = [];
          for (const n of nodes) {
            const candidates = axisNodes(n, step.axis).filter(c => matchesTest(c, step.test, step.axis));
            out.push(...this.applyPreds(candidates, step.preds));
          }
          nodes = (e.steps.length > 1 || REVERSE_AXES.has(step.axis) || nodes.length > 1) ? this.docOrder(out) : out;
        }
        return nodes;
      }
      case 'bin': {
        if (e.op === 'or') return toBool(this.eval(e.l, ctx, pos, size)) || toBool(this.eval(e.r, ctx, pos, size));
        if (e.op === 'and') return toBool(this.eval(e.l, ctx, pos, size)) && toBool(this.eval(e.r, ctx, pos, size));
        const l = this.eval(e.l, ctx, pos, size);
        const r = this.eval(e.r, ctx, pos, size);
        if (e.op === '+') return toNum(l) + toNum(r);
        if (e.op === '-') return toNum(l) - toNum(r);
        return compare(e.op, l, r);
      }
      case 'filter': {
        const v = this.eval(e.e, ctx, pos, size);
        if (!Array.isArray(v)) throw new XPathError('Predicates can only filter node-sets');
        return this.applyPreds(v, e.preds);
      }
      case 'fn': return this.call(e.name, e.args, ctx, pos, size);
    }
  }

  private applyPreds(nodes: XNode[], preds: Expr[]): XNode[] {
    for (const pred of preds) {
      const total = nodes.length;
      nodes = nodes.filter((c, i) => {
        const v = this.eval(pred, c, i + 1, total);
        return typeof v === 'number' ? v === i + 1 : toBool(v);
      });
    }
    return nodes;
  }

  private call(name: string, args: Expr[], ctx: XNode, pos: number, size: number): Value {
    const arg = (i: number) => this.eval(args[i], ctx, pos, size);
    const strArg = (i: number) => (args.length > i ? toStr(arg(i)) : stringValue(ctx));
    switch (name) {
      case 'position': return pos;
      case 'last': return size;
      case 'count': { const v = arg(0); return Array.isArray(v) ? v.length : 0; }
      case 'not': return !toBool(arg(0));
      case 'true': return true;
      case 'false': return false;
      case 'boolean': return toBool(arg(0));
      case 'number': return args.length ? toNum(arg(0)) : toNum(stringValue(ctx));
      case 'string': return strArg(0);
      case 'contains': return toStr(arg(0)).includes(toStr(arg(1)));
      case 'starts-with': return toStr(arg(0)).startsWith(toStr(arg(1)));
      case 'ends-with': return toStr(arg(0)).endsWith(toStr(arg(1)));
      case 'normalize-space': return strArg(0).replace(/\s+/g, ' ').trim();
      case 'string-length': return strArg(0).length;
      case 'concat': return args.map((_, i) => toStr(arg(i))).join('');
      case 'substring-before': { const s = toStr(arg(0)); const i = s.indexOf(toStr(arg(1))); return i < 0 ? '' : s.slice(0, i); }
      case 'substring-after': { const s = toStr(arg(0)); const t = toStr(arg(1)); const i = s.indexOf(t); return i < 0 ? '' : s.slice(i + t.length); }
      case 'substring': {
        const s = toStr(arg(0));
        const start = Math.round(toNum(arg(1)));
        const len = args.length > 2 ? Math.round(toNum(arg(2))) : Infinity;
        return s.slice(Math.max(0, start - 1), len === Infinity ? undefined : Math.max(0, start - 1 + len));
      }
      case 'translate': {
        const s = toStr(arg(0)); const from = toStr(arg(1)); const to = toStr(arg(2));
        return Array.from(s).map(ch => { const i = from.indexOf(ch); return i < 0 ? ch : (to[i] ?? ''); }).join('');
      }
      case 'lower-case': return toStr(arg(0)).toLowerCase();
      case 'upper-case': return toStr(arg(0)).toUpperCase();
      case 'name':
      case 'local-name': {
        const v = args.length ? arg(0) : [ctx];
        const n = Array.isArray(v) ? v[0] : undefined;
        if (!n) return '';
        return isAttr(n) ? n.name : isRealElement(n) ? n.tagName : '';
      }
      case 'floor': return Math.floor(toNum(arg(0)));
      case 'ceiling': return Math.ceil(toNum(arg(0)));
      case 'round': return Math.round(toNum(arg(0)));
      case 'sum': { const v = arg(0); return Array.isArray(v) ? v.reduce((a, n) => a + toNum(stringValue(n)), 0) : NaN; }
      default:
        throw new XPathError(`Unsupported XPath function "${name}()"`);
    }
  }
}

function compare(op: string, l: Value, r: Value): boolean {
  const cmp = (a: string | number | boolean, b: string | number | boolean): boolean => {
    if (op === '=' || op === '!=') {
      let eq: boolean;
      if (typeof a === 'boolean' || typeof b === 'boolean') eq = toBool(a) === toBool(b);
      else if (typeof a === 'number' || typeof b === 'number') eq = toNum(a) === toNum(b);
      else eq = a === b;
      return op === '=' ? eq : !eq;
    }
    const x = toNum(a), y = toNum(b);
    return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
  };
  const atoms = (v: Value): Array<string | number | boolean> => Array.isArray(v) ? v.map(stringValue) : [v];
  if (Array.isArray(l) || Array.isArray(r)) {
    if (typeof l === 'boolean' || typeof r === 'boolean') return cmp(toBool(l), toBool(r));
    const la = atoms(l), ra = atoms(r);
    return la.some(a => ra.some(b => cmp(typeof r === 'number' ? toNum(a) : a, typeof l === 'number' ? toNum(b) : b)));
  }
  return cmp(l, r);
}

// Evaluates an XPath and returns the matching elements in document order
export function evaluateXPath(expression: string, context: MemoraNode, documentRoot: MemoraNode): MemoraElement[] {
  const ast = new Parser(tokenize(expression)).parse();
  const result = new Evaluator(documentRoot).eval(ast, context, 1, 1);
  if (!Array.isArray(result)) {
    throw new XPathError(`XPath "${expression}" does not select elements`);
  }
  return result.filter((n): n is MemoraElement => !isAttr(n) && isRealElement(n));
}
