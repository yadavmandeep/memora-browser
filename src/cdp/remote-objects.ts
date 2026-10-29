import { MemoraElement, MemoraNode, MemoraTextNode } from '../dom/node.js';

// CDP Runtime.RemoteObject handles: clients (Playwright, Puppeteer) evaluate a helper
// script once, keep its objectId, then call functions on it with handle arguments.

export interface CallArgument {
  value?: any;
  unserializableValue?: string;
  objectId?: string;
}

export class RemoteObjectRegistry {
  private objects: Map<string, any> = new Map();
  private ids: WeakMap<object, string> = new WeakMap();
  private counter = 0;

  constructor(private readonly scope: string) {}

  public get(objectId: string): any {
    if (!this.objects.has(objectId)) {
      throw new Error(`Could not find object with given id: ${objectId}`);
    }
    return this.objects.get(objectId);
  }

  public release(objectId: string): void {
    const obj = this.objects.get(objectId);
    if (obj && typeof obj === 'object') this.ids.delete(obj);
    this.objects.delete(objectId);
  }

  public releaseGroup(): void {
    this.objects.clear();
    this.ids = new WeakMap();
  }

  private idFor(obj: object): string {
    let id = this.ids.get(obj);
    if (!id || !this.objects.has(id)) {
      id = `${this.scope}.${++this.counter}`;
      this.ids.set(obj, id);
      this.objects.set(id, obj);
    }
    return id;
  }

  public resolveArgument(arg: CallArgument | undefined): any {
    if (!arg) return undefined;
    if (arg.objectId !== undefined) return this.get(arg.objectId);
    if (arg.unserializableValue !== undefined) return parseUnserializable(arg.unserializableValue);
    return arg.value;
  }

  public toRemoteObject(value: any, returnByValue: boolean): Record<string, any> {
    const t = typeof value;
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'object', subtype: 'null', value: null };
    if (t === 'number') {
      if (Number.isNaN(value) || !Number.isFinite(value) || Object.is(value, -0)) {
        const u = Object.is(value, -0) ? '-0' : String(value);
        return { type: 'number', unserializableValue: u, description: u };
      }
      return { type: 'number', value, description: String(value) };
    }
    if (t === 'bigint') return { type: 'bigint', unserializableValue: `${value}n`, description: `${value}n` };
    if (t === 'string' || t === 'boolean') return { type: t, value };
    if (t === 'symbol') return { type: 'symbol', description: String(value), objectId: this.idFor(Object(value)) };

    if (returnByValue) {
      return { type: t === 'function' ? 'function' : 'object', value: jsonSafe(value) };
    }

    if (t === 'function') {
      return { type: 'function', className: 'Function', description: String(value).slice(0, 200), objectId: this.idFor(value) };
    }
    const base = { type: 'object', objectId: this.idFor(value) };
    if (value instanceof MemoraNode) {
      const name = value instanceof MemoraElement ? value.tagName : value instanceof MemoraTextNode ? '#text' : '#node';
      return { ...base, subtype: 'node', className: 'HTMLElement', description: name };
    }
    if (Array.isArray(value)) return { ...base, subtype: 'array', className: 'Array', description: `Array(${value.length})` };
    if (isError(value)) return { ...base, subtype: 'error', className: value.name || 'Error', description: value.stack || String(value) };
    if (isPromise(value)) return { ...base, subtype: 'promise', className: 'Promise', description: 'Promise' };
    const className = value?.constructor?.name || 'Object';
    return { ...base, className, description: className };
  }
}

export function exceptionDetails(err: any, registry: RemoteObjectRegistry): Record<string, any> {
  const message = err?.message ?? String(err);
  const exception = err && typeof err === 'object'
    ? registry.toRemoteObject(err, false)
    : registry.toRemoteObject(err, true);
  if (exception.subtype === 'error' || (err && typeof err === 'object')) {
    exception.subtype = 'error';
    exception.description = err?.stack || `${err?.name || 'Error'}: ${message}`;
  }
  return {
    exceptionId: 1,
    text: 'Uncaught',
    lineNumber: 0,
    columnNumber: 0,
    exception,
  };
}

function parseUnserializable(v: string): any {
  switch (v) {
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    case '-Infinity': return -Infinity;
    case '-0': return -0;
    default:
      if (/^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
      throw new Error(`Unsupported unserializableValue: ${v}`);
  }
}

// Cross-realm safe checks (values come from the vm sandbox)
function isError(v: any): boolean {
  return Object.prototype.toString.call(v) === '[object Error]';
}
function isPromise(v: any): boolean {
  return v && typeof v.then === 'function' && Object.prototype.toString.call(v) === '[object Promise]';
}

function jsonSafe(value: any): any {
  try {
    const json = JSON.stringify(value, (_k, v) => (v instanceof MemoraNode ? undefined : v));
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}
