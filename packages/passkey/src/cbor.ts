/**
 * The little CBOR (RFC 8949) WebAuthn needs: unsigned and negative integers, byte strings, text strings, arrays and
 * maps. Maps are written in the order given (a Map keeps insertion order), so callers put keys in CTAP2's canonical
 * order themselves: COSE keys as 1, 3, -1, -2, -3; the attestation object as "fmt", "attStmt", "authData".
 *
 * The decoder is for reading those back (tests, and a relying party's side of the checks).
 */

export type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  throw new Error('cbor: integer too large');
}

export function encode(v: Cbor): Uint8Array {
  const out: number[] = [];
  const put = (x: Cbor) => {
    if (typeof x === 'number') {
      if (!Number.isInteger(x)) throw new Error('cbor: only integers');
      out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length));
      for (const c of b) out.push(c);
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length));
      for (const c of x) out.push(c);
    } else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      for (const e of x) put(e);
    } else if (x instanceof Map) {
      out.push(...head(5, x.size));
      for (const [k, e] of x) {
        put(k);
        put(e);
      }
    } else throw new Error('cbor: unsupported value');
  };
  put(v);
  return Uint8Array.from(out);
}

/** One item from the start of `b`, and where it ended. */
export function decodeFirst(b: Uint8Array, at = 0): { value: Cbor; end: number } {
  const byte = b[at];
  if (byte === undefined) throw new Error('cbor: truncated');
  const major = byte >> 5;
  const info = byte & 0x1f;
  let p = at + 1;
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) n = b[p++]!;
  else if (info === 25) (n = (b[p]! << 8) | b[p + 1]!), (p += 2);
  else if (info === 26) (n = ((b[p]! << 24) >>> 0) + (b[p + 1]! << 16) + (b[p + 2]! << 8) + b[p + 3]!), (p += 4);
  else throw new Error('cbor: unsupported length');
  switch (major) {
    case 0:
      return { value: n, end: p };
    case 1:
      return { value: -1 - n, end: p };
    case 2:
      if (p + n > b.length) throw new Error('cbor: truncated');
      return { value: b.slice(p, p + n), end: p + n };
    case 3:
      if (p + n > b.length) throw new Error('cbor: truncated');
      return { value: new TextDecoder().decode(b.slice(p, p + n)), end: p + n };
    case 4: {
      const arr: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const r = decodeFirst(b, p);
        arr.push(r.value);
        p = r.end;
      }
      return { value: arr, end: p };
    }
    case 5: {
      const map = new Map<number | string, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = decodeFirst(b, p);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new Error('cbor: map key must be an integer or text');
        const e = decodeFirst(b, k.end);
        map.set(k.value, e.value);
        p = e.end;
      }
      return { value: map, end: p };
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

export function decode(b: Uint8Array): Cbor {
  const r = decodeFirst(b);
  if (r.end !== b.length) throw new Error('cbor: trailing bytes');
  return r.value;
}
