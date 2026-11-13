/**
 * JSON the way Python's `json` module reads and writes it, byte for byte: what dither-finance's pullers did with
 * `json.load` then `json.dumps(…, indent=N)`. The ported pullers must write the same bytes (docs/statements.md),
 * and JavaScript's JSON differs in three ways that matter here:
 *
 * - numbers: Python keeps integers exact at any size (Monero amounts pass 2^53) and writes floats as `repr` does
 *   (`1.0`, `1e-05`, `1e+16`), so a number keeps whether it was an integer or a float;
 * - key order: Python keeps insertion order, while a JavaScript object moves integer-like keys ("10") to the front;
 * - strings: `ensure_ascii` escapes everything outside space..~ as \uXXXX (lowercase hex, UTF-16 units).
 *
 * So values are a small tree: `PyObj` (ordered entries; a repeated key keeps its first place and its last value, as a
 * Python dict does), arrays, `PyInt` (decimal digits), `PyFloat`, strings, booleans and null.
 */

export class PyInt {
  /** Normalized decimal digits, as Python's int() would print them ("-0" is "0"). */
  readonly digits: string;
  constructor(v: string | number | bigint) {
    this.digits = BigInt(v).toString();
  }
  toNumber() {
    return Number(this.digits);
  }
}
export class PyFloat {
  constructor(readonly value: number) {}
}
export class PyObj {
  private keys: string[] = [];
  private map = new Map<string, PyValue>();
  constructor(entries: [string, PyValue][] = []) {
    for (const [k, v] of entries) this.set(k, v);
  }
  set(k: string, v: PyValue) {
    if (!this.map.has(k)) this.keys.push(k);
    this.map.set(k, v);
    return this;
  }
  get(k: string): PyValue | undefined {
    return this.map.get(k);
  }
  has(k: string) {
    return this.map.has(k);
  }
  entries(): [string, PyValue][] {
    return this.keys.map((k) => [k, this.map.get(k)!]);
  }
  get size() {
    return this.keys.length;
  }
}
export type PyValue = null | boolean | string | PyInt | PyFloat | PyObj | PyValue[];

// ------------------------------------------------------------------ parse (json.loads)
export function parse(text: string): PyValue {
  let i = 0;
  const n = text.length;
  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at char ${i}`);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const str = (): string => {
    // at the opening quote
    i++;
    let out = '';
    let start = i;
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const h = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad \\u escape');
            out += String.fromCharCode(parseInt(h, 16));
            i += 4;
            break;
          }
          default:
            fail('bad escape');
        }
        start = i;
        continue;
      }
      // Python's strict mode refuses raw control characters in strings, as JSON does.
      if (c < 0x20) fail('control character in string');
      i++;
    }
  };
  const NUM = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
  const value = (): PyValue => {
    ws();
    if (i >= n) fail('expected a value');
    const c = text[i];
    if (c === '{') {
      i++;
      const o = new PyObj();
      ws();
      if (text[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const k = str();
        ws();
        if (text[i] !== ':') fail("expected ':'");
        i++;
        o.set(k, value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return o;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      const a: PyValue[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return a;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) return (i += 4), true;
    if (text.startsWith('false', i)) return (i += 5), false;
    if (text.startsWith('null', i)) return (i += 4), null;
    if (text.startsWith('NaN', i)) return (i += 3), new PyFloat(NaN);
    if (text.startsWith('Infinity', i)) return (i += 8), new PyFloat(Infinity);
    if (text.startsWith('-Infinity', i)) return (i += 9), new PyFloat(-Infinity);
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) fail('expected a value');
    i += m![0].length;
    return m![1] || m![2] ? new PyFloat(Number(m![0])) : new PyInt(m![0]);
  };
  // (Bytes from the network are decoded first, a UTF-8 BOM dropped, as json.load does with bytes.)
  const v = value();
  ws();
  if (i !== n) fail('extra data');
  return v;
}

// ------------------------------------------------------------------ dumps (json.dumps, ensure_ascii=True)
/** Python's repr() of a float. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  // toExponential() with no argument gives the shortest digits that round-trip, as Python's repr does.
  const [mant, exp] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const decpt = Number(exp) + 1;
  if (decpt <= -4 || decpt > 16) {
    const e = decpt - 1;
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

const ESC: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
export function strRepr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e && ch !== '"' && ch !== '\\') out += ch;
    else out += ESC[ch] ?? `\\u${c.toString(16).padStart(4, '0')}`;
  }
  return out + '"';
}

/** json.dumps(v, indent=indent) with the defaults (ensure_ascii, separators (',', ': ') when indented). */
export function dumps(v: PyValue, indent?: number): string {
  const nl = indent === undefined ? null : indent;
  const go = (x: PyValue, level: number): string => {
    if (x === null) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (typeof x === 'string') return strRepr(x);
    if (x instanceof PyInt) return x.digits;
    if (x instanceof PyFloat) return floatRepr(x.value);
    if (Array.isArray(x)) {
      if (!x.length) return '[]';
      if (nl === null) return `[${x.map((e) => go(e, level)).join(', ')}]`;
      const pad = '\n' + ' '.repeat(nl * (level + 1));
      return `[${x.map((e) => pad + go(e, level + 1)).join(',')}\n${' '.repeat(nl * level)}]`;
    }
    if (x instanceof PyObj) {
      const es = x.entries();
      if (!es.length) return '{}';
      if (nl === null) return `{${es.map(([k, e]) => `${strRepr(k)}: ${go(e, level)}`).join(', ')}}`;
      const pad = '\n' + ' '.repeat(nl * (level + 1));
      return `{${es.map(([k, e]) => `${pad}${strRepr(k)}: ${go(e, level + 1)}`).join(',')}\n${' '.repeat(nl * level)}}`;
    }
    throw new TypeError(`not a Python JSON value: ${typeof x}`);
  };
  return go(v, 0);
}

// ------------------------------------------------------------------ helpers
/** dict.get(k) on a value that should be an object; undefined when it is not one or lacks the key. */
export const pyGet = (o: PyValue | undefined, k: string): PyValue | undefined => (o instanceof PyObj ? o.get(k) : undefined);
/** Python truthiness, for `if x` and `any(…)`. */
export function truthy(v: PyValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof PyInt) return v.digits !== '0';
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof PyObj) return v.size > 0;
  return true;
}
/** A plain JavaScript value, for reading (numbers past 2^53 lose precision: use the PyInt for those). */
export function toJs(v: PyValue | undefined): unknown {
  if (v === undefined) return undefined;
  if (v instanceof PyInt) return v.toNumber();
  if (v instanceof PyFloat) return v.value;
  if (Array.isArray(v)) return v.map(toJs);
  if (v instanceof PyObj) return Object.fromEntries(v.entries().map(([k, e]) => [k, toJs(e)]));
  return v;
}
