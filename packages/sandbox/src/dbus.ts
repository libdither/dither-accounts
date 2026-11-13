/**
 * Enough of D-Bus to own a sandbox's session bus: the wire format (marshalling every basic and container type), a
 * client connection over a unix socket (SASL EXTERNAL, Hello, RequestName), method calls both ways, signals, and
 * exported objects with Properties, Introspectable and Peer answered for them. No file descriptor passing: a call
 * that carries one is refused by the bus before it reaches us, which is what the services here want (docs/native-sandbox.md).
 *
 * Values: y n q i u h are numbers, x t bigints (numbers accepted), d a number, b a boolean, s o g strings, ay a
 * Buffer, other arrays JS arrays, a{kv} a plain object (or an array of [k, v] pairs when written), structs arrays,
 * and a variant a `Variant` when written (`variant('u', 1)`) and its plain value when read.
 */
import { createConnection, type Socket } from 'node:net';

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface Variant {
  readonly __variant: true;
  sig: string;
  value: unknown;
}
export const variant = (sig: string, value: unknown): Variant => ({ __variant: true, sig, value });
const isVariant = (v: unknown): v is Variant => !!v && typeof v === 'object' && (v as Variant).__variant === true;

export class DBusError extends Error {
  constructor(
    readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- signatures

/** Split a signature into its complete types: 'sa{sv}(ii)' → ['s', 'a{sv}', '(ii)']. */
export function splitSignature(sig: string): string[] {
  const out: string[] = [];
  let i = 0;
  const one = (): string => {
    const start = i;
    const c = sig[i++];
    if (c === 'a') {
      one();
    } else if (c === '(' || c === '{') {
      const close = c === '(' ? ')' : '}';
      while (sig[i] !== close) {
        if (i >= sig.length) throw new Error(`unbalanced signature ${sig}`);
        one();
      }
      i++;
    } else if (!'ybnqiuxtdsogvh'.includes(c ?? '')) {
      throw new Error(`bad signature ${sig}`);
    }
    return sig.slice(start, i);
  };
  while (i < sig.length) out.push(one());
  return out;
}

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1, h: 4 };

/** The member types of a struct or dict entry signature: '(isv)' → ['i', 's', 'v']. */
const inner = (t: string) => splitSignature(t.slice(1, -1));

// ---------------------------------------------------------------- writing

class Out {
  buf = Buffer.alloc(256);
  len = 0;
  constructor(private base = 0) {}
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    const b = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(b, 0, 0, this.len);
    this.buf = b;
  }
  align(n: number) {
    const pad = (n - ((this.base + this.len) % n)) % n;
    this.grow(pad);
    this.buf.fill(0, this.len, this.len + pad);
    this.len += pad;
  }
  u8(v: number) {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v: number, signed = false) {
    this.align(2);
    this.grow(2);
    signed ? this.buf.writeInt16LE(v, this.len) : this.buf.writeUInt16LE(v, this.len);
    this.len += 2;
  }
  u32(v: number, signed = false) {
    this.align(4);
    this.grow(4);
    signed ? this.buf.writeInt32LE(v, this.len) : this.buf.writeUInt32LE(v >>> 0, this.len);
    this.len += 4;
  }
  u64(v: bigint | number, signed = false) {
    this.align(8);
    this.grow(8);
    signed ? this.buf.writeBigInt64LE(BigInt(v), this.len) : this.buf.writeBigUInt64LE(BigInt(v), this.len);
    this.len += 8;
  }
  f64(v: number) {
    this.align(8);
    this.grow(8);
    this.buf.writeDoubleLE(v, this.len);
    this.len += 8;
  }
  raw(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  string(s: string) {
    const b = Buffer.from(s, 'utf8');
    this.u32(b.length);
    this.raw(b);
    this.u8(0);
  }
  sig(s: string) {
    const b = Buffer.from(s, 'latin1');
    this.u8(b.length);
    this.raw(b);
    this.u8(0);
  }
  done() {
    return this.buf.subarray(0, this.len);
  }
}

function write(o: Out, t: string, v: unknown) {
  switch (t[0]) {
    case 'y':
      return o.u8(Number(v));
    case 'b':
      return o.u32(v ? 1 : 0);
    case 'n':
      return o.u16(Number(v), true);
    case 'q':
      return o.u16(Number(v));
    case 'i':
      return o.u32(Number(v), true);
    case 'u':
    case 'h':
      return o.u32(Number(v));
    case 'x':
      return o.u64(v as bigint, true);
    case 't':
      return o.u64(v as bigint);
    case 'd':
      return o.f64(Number(v));
    case 's':
    case 'o':
      return o.string(String(v));
    case 'g':
      return o.sig(String(v));
    case 'v': {
      if (!isVariant(v)) throw new Error('a variant must be written as variant(sig, value)');
      o.sig(v.sig);
      return write(o, v.sig, v.value);
    }
    case '(': {
      o.align(8);
      const members = inner(t);
      const vals = v as unknown[];
      members.forEach((m, i) => write(o, m, vals[i]));
      return;
    }
    case 'a': {
      const el = t.slice(1);
      o.align(4);
      const lenAt = o.len;
      o.u32(0);
      o.align(ALIGN[el[0]]);
      const start = o.len;
      if (el === 'y') o.raw(v instanceof Uint8Array ? v : Buffer.from(v as number[]));
      else if (el[0] === '{') {
        const [kt, vt] = inner(el);
        const entries = Array.isArray(v) ? (v as [unknown, unknown][]) : Object.entries(v as object);
        for (const [k, val] of entries) {
          o.align(8);
          write(o, kt, k);
          write(o, vt, vt === 'v' && !isVariant(val) ? guessVariant(val) : val);
        }
      } else for (const x of v as unknown[]) write(o, el, x);
      o.buf.writeUInt32LE(o.len - start, lenAt);
      return;
    }
  }
  throw new Error(`cannot write type ${t}`);
}

/** A plain value in an a{sv}: strings, booleans, whole numbers (as u, or x when negative), string lists. */
function guessVariant(v: unknown): Variant {
  if (typeof v === 'string') return variant('s', v);
  if (typeof v === 'boolean') return variant('b', v);
  if (typeof v === 'number') return Number.isInteger(v) ? variant(v < 0 ? 'i' : 'u', v) : variant('d', v);
  if (typeof v === 'bigint') return variant('x', v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return variant('as', v);
  if (v instanceof Uint8Array) return variant('ay', v);
  throw new Error('cannot guess a variant type; use variant(sig, value)');
}

export function marshal(sig: string, values: unknown[], base = 0): Buffer {
  const o = new Out(base);
  splitSignature(sig).forEach((t, i) => write(o, t, values[i]));
  return o.done();
}

// ---------------------------------------------------------------- reading

class In {
  off = 0;
  constructor(
    readonly buf: Buffer,
    readonly le: boolean,
    private base = 0,
  ) {}
  align(n: number) {
    this.off += (n - ((this.base + this.off) % n)) % n;
  }
  need(n: number) {
    if (this.off + n > this.buf.length) throw new Error('a D-Bus message ends early');
  }
  u8() {
    this.need(1);
    return this.buf[this.off++];
  }
  u16(signed = false) {
    this.align(2);
    this.need(2);
    const v = signed ? (this.le ? this.buf.readInt16LE(this.off) : this.buf.readInt16BE(this.off)) : this.le ? this.buf.readUInt16LE(this.off) : this.buf.readUInt16BE(this.off);
    this.off += 2;
    return v;
  }
  u32(signed = false) {
    this.align(4);
    this.need(4);
    const v = signed ? (this.le ? this.buf.readInt32LE(this.off) : this.buf.readInt32BE(this.off)) : this.le ? this.buf.readUInt32LE(this.off) : this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  u64(signed = false) {
    this.align(8);
    this.need(8);
    const v = signed ? (this.le ? this.buf.readBigInt64LE(this.off) : this.buf.readBigInt64BE(this.off)) : this.le ? this.buf.readBigUInt64LE(this.off) : this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }
  f64() {
    this.align(8);
    this.need(8);
    const v = this.le ? this.buf.readDoubleLE(this.off) : this.buf.readDoubleBE(this.off);
    this.off += 8;
    return v;
  }
  string() {
    const n = this.u32();
    this.need(n + 1);
    const s = this.buf.toString('utf8', this.off, this.off + n);
    this.off += n + 1;
    return s;
  }
  sig() {
    const n = this.u8();
    this.need(n + 1);
    const s = this.buf.toString('latin1', this.off, this.off + n);
    this.off += n + 1;
    return s;
  }
}

function read(r: In, t: string): unknown {
  switch (t[0]) {
    case 'y':
      return r.u8();
    case 'b':
      return r.u32() !== 0;
    case 'n':
      return r.u16(true);
    case 'q':
      return r.u16();
    case 'i':
      return r.u32(true);
    case 'u':
    case 'h':
      return r.u32();
    case 'x':
      return r.u64(true);
    case 't':
      return r.u64();
    case 'd':
      return r.f64();
    case 's':
    case 'o':
      return r.string();
    case 'g':
      return r.sig();
    case 'v':
      return read(r, r.sig());
    case '(': {
      r.align(8);
      return inner(t).map((m) => read(r, m));
    }
    case 'a': {
      const el = t.slice(1);
      const len = r.u32();
      r.align(ALIGN[el[0]]);
      const end = r.off + len;
      r.need(len);
      if (el === 'y') {
        const b = Buffer.from(r.buf.subarray(r.off, end));
        r.off = end;
        return b;
      }
      if (el[0] === '{') {
        const [kt, vt] = inner(el);
        const obj: Record<string, unknown> = {};
        while (r.off < end) {
          r.align(8);
          const k = read(r, kt);
          obj[String(k)] = read(r, vt);
        }
        return obj;
      }
      const out: unknown[] = [];
      while (r.off < end) out.push(read(r, el));
      return out;
    }
  }
  throw new Error(`cannot read type ${t}`);
}

export function unmarshal(sig: string, buf: Buffer, le = true, base = 0): unknown[] {
  const r = new In(buf, le, base);
  return splitSignature(sig).map((t) => read(r, t));
}

// ---------------------------------------------------------------- messages

export const MsgType = { Call: 1, Return: 2, Error: 3, Signal: 4 } as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];
const NO_REPLY = 0x1;

export interface Message {
  type: MsgType;
  flags: number;
  serial: number;
  path?: string;
  iface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature: string;
  body: unknown[];
}

const FIELD = { path: 1, iface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 } as const;
const FIELD_SIG: Record<number, string> = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g', 9: 'u' };

export function encodeMessage(m: Omit<Message, 'body'> & { body?: unknown[] }): Buffer {
  const body = m.signature ? marshal(m.signature, m.body ?? []) : Buffer.alloc(0);
  const fields: [number, Variant][] = [];
  const add = (code: number, v: unknown) => v !== undefined && fields.push([code, variant(FIELD_SIG[code], v)]);
  add(FIELD.path, m.path);
  add(FIELD.iface, m.iface);
  add(FIELD.member, m.member);
  add(FIELD.errorName, m.errorName);
  add(FIELD.replySerial, m.replySerial);
  add(FIELD.destination, m.destination);
  add(FIELD.sender, m.sender);
  if (m.signature) add(FIELD.signature, m.signature);
  const o = new Out();
  o.u8('l'.charCodeAt(0));
  o.u8(m.type);
  o.u8(m.flags);
  o.u8(1);
  o.u32(body.length);
  o.u32(m.serial);
  write(o, 'a(yv)', fields);
  o.align(8);
  o.raw(body);
  return Buffer.from(o.done());
}

/** One whole message at the start of `buf`, and how many bytes it took; null until all of it has arrived. */
export function decodeMessage(buf: Buffer): { msg: Message; size: number } | null {
  if (buf.length < 16) return null;
  const le = buf[0] === 'l'.charCodeAt(0);
  if (!le && buf[0] !== 'B'.charCodeAt(0)) throw new Error('not a D-Bus message');
  const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLen = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerEnd = 16 + fieldsLen;
  const bodyStart = headerEnd + ((8 - (headerEnd % 8)) % 8);
  const size = bodyStart + bodyLen;
  if (buf.length < size) return null;
  const r = new In(buf.subarray(0, headerEnd), le);
  r.off = 12;
  const fields = read(r, 'a(yv)') as [number, unknown][];
  const msg: Message = { type: buf[1] as MsgType, flags: buf[2], serial: le ? buf.readUInt32LE(8) : buf.readUInt32BE(8), signature: '', body: [] };
  for (const [code, v] of fields) {
    if (code === FIELD.path) msg.path = v as string;
    else if (code === FIELD.iface) msg.iface = v as string;
    else if (code === FIELD.member) msg.member = v as string;
    else if (code === FIELD.errorName) msg.errorName = v as string;
    else if (code === FIELD.replySerial) msg.replySerial = v as number;
    else if (code === FIELD.destination) msg.destination = v as string;
    else if (code === FIELD.sender) msg.sender = v as string;
    else if (code === FIELD.signature) msg.signature = v as string;
  }
  if (msg.signature) msg.body = unmarshal(msg.signature, Buffer.from(buf.subarray(bodyStart, size)), le);
  return { msg, size };
}

// ---------------------------------------------------------------- objects

export interface Method {
  /** Input and output signatures. */
  in: string;
  out: string;
  /** Gets the body as a tuple of the input signature's types. */
  fn: (args: any, msg: Message) => unknown | Promise<unknown>;
}
export interface Property {
  sig: string;
  get: () => unknown;
}
export interface Interface {
  methods?: Record<string, Method>;
  properties?: Record<string, Property>;
  /** Signal names and signatures, for Introspect. */
  signals?: Record<string, string>;
}

const ERR = {
  unknownMethod: 'org.freedesktop.DBus.Error.UnknownMethod',
  unknownObject: 'org.freedesktop.DBus.Error.UnknownObject',
  unknownProperty: 'org.freedesktop.DBus.Error.UnknownProperty',
  invalidArgs: 'org.freedesktop.DBus.Error.InvalidArgs',
  failed: 'org.freedesktop.DBus.Error.Failed',
  notSupported: 'org.freedesktop.DBus.Error.NotSupported',
} as const;
export { ERR as DBUS_ERRORS };

function introspect(path: string, ifaces: Record<string, Interface>, children: string[]): string {
  const arg = (sig: string, dir: string) => splitSignature(sig).map((t) => `<arg type="${t}" direction="${dir}"/>`).join('');
  const body = Object.entries(ifaces)
    .map(
      ([name, i]) =>
        `<interface name="${name}">` +
        Object.entries(i.methods ?? {})
          .map(([m, d]) => `<method name="${m}">${arg(d.in, 'in')}${arg(d.out, 'out')}</method>`)
          .join('') +
        Object.entries(i.properties ?? {})
          .map(([p, d]) => `<property name="${p}" type="${d.sig}" access="read"/>`)
          .join('') +
        Object.entries(i.signals ?? {})
          .map(([s, sig]) => `<signal name="${s}">${splitSignature(sig).map((t) => `<arg type="${t}"/>`).join('')}</signal>`)
          .join('') +
        `</interface>`,
    )
    .join('');
  const kids = children.map((c) => `<node name="${c}"/>`).join('');
  return `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd"><node name="${path}">${body}${kids}</node>`;
}

// ---------------------------------------------------------------- connection

export interface ConnectOptions {
  /** unix:path=… or a socket path. */
  address: string;
  log?: Log;
}

export class DBusConnection {
  uniqueName = '';
  private sock!: Socket;
  private serial = 0;
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: unknown[]) => void; reject: (e: Error) => void }>();
  private objects = new Map<string, Record<string, Interface>>();
  private signalHandlers: ((m: Message) => void)[] = [];
  private closed = false;
  readonly done: Promise<void>;
  private markDone!: () => void;

  private constructor(private o: ConnectOptions) {
    this.done = new Promise((r) => (this.markDone = r));
  }

  static async connect(o: ConnectOptions): Promise<DBusConnection> {
    const c = new DBusConnection(o);
    await c.open();
    return c;
  }

  private open(): Promise<void> {
    const path = this.o.address.startsWith('unix:path=') ? this.o.address.slice('unix:path='.length).split(',')[0] : this.o.address;
    return new Promise((resolve, reject) => {
      const sock = createConnection(path);
      this.sock = sock;
      let authed = false;
      let line = '';
      sock.once('error', reject);
      sock.on('connect', () => {
        const uid = Buffer.from(String(process.getuid?.() ?? 0), 'ascii').toString('hex');
        sock.write(Buffer.from([0]));
        sock.write(`AUTH EXTERNAL ${uid}\r\n`);
      });
      sock.on('data', (chunk: Buffer) => {
        if (!authed) {
          line += chunk.toString('latin1');
          const nl = line.indexOf('\r\n');
          if (nl < 0) return;
          const reply = line.slice(0, nl);
          const rest = Buffer.from(line.slice(nl + 2), 'latin1');
          if (!reply.startsWith('OK ')) return reject(new Error(`D-Bus authentication refused: ${reply}`));
          authed = true;
          sock.write('BEGIN\r\n');
          sock.off('error', reject);
          sock.on('error', (e) => this.o.log?.('debug', `dbus socket: ${e.message}`));
          this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'Hello', '', [])
            .then(([name]) => {
              this.uniqueName = name as string;
              resolve();
            }, reject);
          if (rest.length) this.feed(rest);
          return;
        }
        this.feed(chunk);
      });
      sock.on('close', () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('the D-Bus connection closed'));
        this.pending.clear();
        this.markDone();
      });
    });
  }

  private feed(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      let got: ReturnType<typeof decodeMessage>;
      try {
        got = decodeMessage(this.buf);
      } catch (e) {
        this.o.log?.('warn', `dbus: ${(e as Error).message}; closing`);
        this.sock.destroy();
        return;
      }
      if (!got) return;
      this.buf = this.buf.subarray(got.size);
      try {
        this.dispatch(got.msg);
      } catch (e) {
        this.o.log?.('warn', `dbus dispatch: ${(e as Error).message}`);
      }
    }
  }

  private send(m: Omit<Message, 'serial' | 'body'> & { body?: unknown[] }): number {
    const serial = ++this.serial;
    if (!this.closed) this.sock.write(encodeMessage({ ...m, serial }));
    return serial;
  }

  private dispatch(m: Message) {
    if (m.type === MsgType.Return || m.type === MsgType.Error) {
      const p = m.replySerial !== undefined ? this.pending.get(m.replySerial) : undefined;
      if (!p) return;
      this.pending.delete(m.replySerial!);
      if (m.type === MsgType.Return) p.resolve(m.body);
      else p.reject(new DBusError(m.errorName ?? ERR.failed, String(m.body[0] ?? m.errorName)));
      return;
    }
    if (m.type === MsgType.Signal) {
      for (const h of this.signalHandlers) h(m);
      return;
    }
    if (m.type === MsgType.Call) void this.answer(m);
  }

  private reply(m: Message, out: string, value: unknown) {
    if (m.flags & NO_REPLY) return;
    const parts = splitSignature(out);
    const body = parts.length === 0 ? [] : parts.length === 1 ? [value] : (value as unknown[]);
    this.send({ type: MsgType.Return, flags: NO_REPLY, replySerial: m.serial, destination: m.sender, signature: out, body });
  }

  private error(m: Message, name: string, text: string) {
    if (m.flags & NO_REPLY) return;
    this.send({ type: MsgType.Error, flags: NO_REPLY, replySerial: m.serial, destination: m.sender, errorName: name, signature: 's', body: [text] });
  }

  /** Methods answered here, by interface.member, and how often: what an app asks of the desktop, without what it said. */
  readonly served = new Map<string, number>();

  private async answer(m: Message) {
    const path = m.path ?? '/';
    const key = `${m.iface ?? '?'}.${m.member ?? '?'}`;
    this.served.set(key, (this.served.get(key) ?? 0) + 1);
    const ifaces = this.objects.get(path);
    const member = m.member ?? '';
    if (m.iface === 'org.freedesktop.DBus.Peer') {
      if (member === 'Ping') return this.reply(m, '', null);
      if (member === 'GetMachineId') return this.reply(m, 's', '0'.repeat(32));
    }
    if (m.iface === 'org.freedesktop.DBus.Introspectable' && member === 'Introspect') {
      const prefix = path === '/' ? '/' : `${path}/`;
      const children = [...new Set([...this.objects.keys()].filter((p) => p.startsWith(prefix) && p !== path).map((p) => p.slice(prefix.length).split('/')[0]))];
      return this.reply(m, 's', introspect(path, ifaces ?? {}, children));
    }
    if (!ifaces) return this.error(m, ERR.unknownObject, `no object at ${path}`);
    if (m.iface === 'org.freedesktop.DBus.Properties') {
      const [ifaceName, prop] = m.body as [string, string];
      const props = ifaces[ifaceName]?.properties;
      if (member === 'GetAll') return this.reply(m, 'a{sv}', Object.entries(props ?? {}).map(([k, p]) => [k, variant(p.sig, p.get())]));
      if (member === 'Get') {
        const p = props?.[prop];
        if (!p) return this.error(m, ERR.unknownProperty, `no property ${ifaceName}.${prop}`);
        return this.reply(m, 'v', variant(p.sig, p.get()));
      }
      return this.error(m, ERR.notSupported, 'properties here are read-only');
    }
    const target = m.iface ? ifaces[m.iface]?.methods?.[member] : Object.values(ifaces).find((i) => i.methods?.[member])?.methods?.[member];
    if (!target) return this.error(m, ERR.unknownMethod, `no method ${m.iface ?? '?'}.${member} at ${path}`);
    if ((m.signature ?? '') !== target.in) return this.error(m, ERR.invalidArgs, `${member} takes (${target.in}), not (${m.signature})`);
    try {
      const out = await target.fn(m.body, m);
      this.reply(m, target.out, out);
    } catch (e) {
      const err = e as Error & { name?: string };
      this.error(m, e instanceof DBusError ? e.name : ERR.failed, String(err?.message ?? e));
    }
  }

  /** Answer calls on `path` with these interfaces (replacing what was there). */
  export(path: string, ifaces: Record<string, Interface>) {
    this.objects.set(path, ifaces);
  }

  unexport(path: string) {
    this.objects.delete(path);
  }

  onSignal(h: (m: Message) => void) {
    this.signalHandlers.push(h);
  }

  call(destination: string, path: string, iface: string, member: string, signature: string, body: unknown[], timeoutMs = 25_000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('the D-Bus connection is closed'));
      const serial = this.send({ type: MsgType.Call, flags: 0, destination, path, iface, member, signature, body });
      const t = setTimeout(() => {
        if (this.pending.delete(serial)) reject(new DBusError('org.freedesktop.DBus.Error.NoReply', `${member}: no reply in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(serial, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  signal(path: string, iface: string, member: string, signature: string, body: unknown[], destination?: string) {
    this.send({ type: MsgType.Signal, flags: NO_REPLY, path, iface, member, signature, body, ...(destination ? { destination } : {}) });
  }

  /** Own a well-known name; throws unless it is ours alone (no queueing behind another owner). */
  async requestName(name: string) {
    const [r] = await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', 'su', [name, 4]);
    if (r !== 1 && r !== 4) throw new Error(`could not own ${name} on the sandbox bus (RequestName ${r})`);
  }

  /** Ask the bus to send us signals matching this rule ("type='signal',interface='…'"). */
  async addMatch(rule: string) {
    await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [rule]);
  }

  close() {
    this.closed = true;
    this.sock?.destroy();
  }
}
