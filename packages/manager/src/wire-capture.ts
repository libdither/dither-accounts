/**
 * Golden wire traces: what a network or an extractor really sent, made safe to keep.
 *
 * - `anonymizeTrace(records)` walks any JSON and swaps every identifying token for a synthetic one, the same token for
 *   the same input everywhere in the trace (keys included), so ids still point at each other: UUIDs, phone numbers,
 *   emails, Matrix user/room/event ids and aliases, long numeric ids (snowflakes, account numbers), epoch timestamps
 *   (rebased onto a fixed start, deltas and order kept exactly), hostnames, tailnet names, IPs, home paths and
 *   account ids. Values under credential-like keys (SECRET_KEY: tokens, passwords, cookies) are blanked. `scrubText` (on by default) also swaps free text (message bodies, names) for synthetic text, keeping
 *   HTML tags and an edit's "* " prefix.
 * - `assertNoConcreteLeaks(text)` is the repo's leak sweep (AGENTS.md) as a check: it masks the synthetic shapes the
 *   anonymizer writes, then throws if any pattern still hits. Every saved trace goes through it.
 * - `AdapterStreamRecorder` writes the manager ⇄ extractor messages, anonymized, as NDJSON. Off unless
 *   DITHER_WIRE_CAPTURE_DIR names a directory; the supervisor holds `undefined` otherwise and records nothing.
 *
 * Committed golden fixtures come from local testbeds with invented users (scripts/capture-fixtures.ts). A trace from a
 * real account stays on the machine even scrubbed: the repo never holds one (AGENTS.md).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SYNTHETIC_MS_BASE = 1_700_000_000_000;
export const SYNTHETIC_S_BASE = 1_700_000_000;
const MS_RANGE: [number, number] = [1_500_000_000_000, 2_500_000_000_000];
const S_RANGE: [number, number] = [1_500_000_000, 2_500_000_000];
const DAY_MS = 86_400_000;
/**
 * Where a rebased timestamp may land: a year either side of the base (a streamed trace rebases on its first record, so
 * history it carries lands before). A real time from that span (late 2022 to late 2024) would pass the guard too; the
 * anonymizer never leaves one, and anything later is caught.
 */
const SYNTH_MS_WINDOW: [number, number] = [SYNTHETIC_MS_BASE - 366 * DAY_MS, SYNTHETIC_MS_BASE + 366 * DAY_MS];
const SYNTH_S_WINDOW: [number, number] = [SYNTH_MS_WINDOW[0] / 1000, SYNTH_MS_WINDOW[1] / 1000];
const SNOWFLAKE_BASE = 700_000_000_000_000_000n;
/** A JSON number keeps its precision: 7 000 000 000 000 000 + n stays under 2^53. */
const NUMERIC_ID_BASE = 7_000_000_000_000_000;

const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export const TEXT_KEYS = ['body', 'formatted_body', 'text', 'message', 'caption', 'description', 'topic', 'reason', 'title', 'snippet', 'preview', 'subject', 'status_msg', 'bio', 'about'];
/** Keys whose value is a credential: blanked whole, whatever it looks like. */
export const SECRET_KEY = /(token|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|recovery[_-]?key)/i;
export const REDACTED = '<redacted>';

export const NAME_KEYS = ['displayname', 'display_name', 'displayName', 'name', 'firstName', 'lastName', 'givenName', 'familyName', 'profileName', 'nickname', 'nick', 'fullName', 'full_name'];

export interface AnonymizeOptions {
  /** Swap free text under TEXT_KEYS / NAME_KEYS for synthetic text (default true; false for testbed traces, whose text is invented). */
  scrubText?: boolean;
  textKeys?: string[];
  nameKeys?: string[];
  /** Hostnames to replace wherever they appear, besides the servers named in Matrix ids (found by themselves). */
  hosts?: string[];
  /** Exact tokens with a chosen replacement (a testbed's invented user to a fixed name), consulted before the counters. */
  preset?: Record<string, string>;
  /** The real timestamp that becomes SYNTHETIC_MS_BASE; anonymizeTrace uses the earliest in the trace, a stream its first. */
  msOrigin?: number;
  sOrigin?: number;
}

// ------------------------------------------------------------------ token patterns

const HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?::\d{1,5})?`;
const PATTERNS: [string, string][] = [
  ['email', String.raw`[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}`],
  ['mxuser', String.raw`@[A-Za-z0-9._=\/+-]+:${HOST}`],
  ['mxroom', String.raw`![A-Za-z0-9._~=+\/-]+:${HOST}|![A-Za-z0-9_-]{40,}`],
  ['mxalias', String.raw`#[A-Za-z0-9._=\/+-]+:${HOST}`],
  ['mxevent', String.raw`\$[A-Za-z0-9+\/_=.-]{8,}(?::${HOST})?`],
  ['uuid', String.raw`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`],
  ['tailnet', String.raw`\b(?:[A-Za-z0-9-]+\.)+ts\.net\b`],
  ['homepath', String.raw`/home/[^/\s"'<>]+`],
  ['accid', String.raw`\bacc_[A-Za-z0-9_-]{8,}`],
  ['ipv4', String.raw`(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])`],
  ['phone', String.raw`\+\d{7,15}(?!\d)|\+\d{1,3}[\s.-]\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}\b`],
  ['digits', String.raw`(?<!\d)\d{9,}(?!\d)`],
];

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALLOWED_IP = (ip: string) => ip === '0.0.0.0' || ip.startsWith('127.') || /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip);

// ------------------------------------------------------------------ the anonymizer

/** One trace's mapping: the same real token always gets the same synthetic one. Use one per trace. */
export class Anonymizer {
  private maps = new Map<string, Map<string, string>>();
  private hosts = new Map<string, string>();
  private re: RegExp;
  private readonly scrub: boolean;
  private readonly textKeys: Set<string>;
  private readonly nameKeys: Set<string>;
  private readonly preset: Record<string, string>;
  msOrigin?: number;
  sOrigin?: number;

  constructor(opts: AnonymizeOptions = {}) {
    this.scrub = opts.scrubText ?? true;
    this.textKeys = new Set(opts.textKeys ?? TEXT_KEYS);
    this.nameKeys = new Set(opts.nameKeys ?? NAME_KEYS);
    this.preset = opts.preset ?? {};
    this.msOrigin = opts.msOrigin;
    this.sOrigin = opts.sOrigin;
    for (const h of opts.hosts ?? []) this.addHost(h);
    this.re = this.build();
  }

  private build() {
    const hosts = [...this.hosts.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    const parts = PATTERNS.map(([name, src]) => `(?<${name}>${src})`);
    if (hosts.length) parts.push(`(?<host>(?<![A-Za-z0-9.-])(?:${hosts.join('|')})(?![A-Za-z0-9-]))`);
    return new RegExp(parts.join('|'), 'g');
  }

  /** A hostname to replace from now on. Returns its synthetic name. */
  addHost(host: string): string {
    const h = host.toLowerCase().replace(/:\d+$/, '');
    if (isExampleHost(h)) return h;
    let out = this.hosts.get(h);
    if (!out) {
      out = this.hosts.size === 0 ? 'example.test' : `server${this.hosts.size + 1}.example.test`;
      this.hosts.set(h, out);
      this.re = this.build();
    }
    return out;
  }

  private next(kind: string, raw: string, make: (n: number) => string): string {
    if (this.preset[raw] !== undefined) return this.preset[raw];
    let m = this.maps.get(kind);
    if (!m) this.maps.set(kind, (m = new Map()));
    let out = m.get(raw);
    if (out === undefined) {
      out = make(m.size + 1);
      m.set(raw, out);
    }
    return out;
  }

  private server(hostPort: string): string {
    // A port on a server name is the machine's own: dropped with the name.
    return this.addHost(hostPort);
  }

  rebaseMs(t: number): number {
    this.msOrigin ??= t;
    return SYNTHETIC_MS_BASE + (t - this.msOrigin);
  }

  rebaseS(t: number): number {
    this.sOrigin ??= t;
    return SYNTHETIC_S_BASE + (t - this.sOrigin);
  }

  private token(groups: Record<string, string | undefined>, whole: string): string {
    if (groups.email) {
      if (isSyntheticEmail(whole) && !this.hosts.has(whole.slice(whole.lastIndexOf('@') + 1).toLowerCase())) return whole;
      return this.next('email', whole.toLowerCase(), (n) => `user${n}@example.com`);
    }
    if (groups.mxuser) {
      const i = whole.indexOf(':');
      const local = whole.slice(1, i).toLowerCase();
      const host = whole.slice(i + 1).toLowerCase();
      return this.next('mxuser', `@${local}:${host}`, (n) => `@${PEOPLE[n - 1] ?? `user${n}`}:${this.server(host)}`);
    }
    if (groups.mxroom) {
      const i = whole.indexOf(':');
      return this.next('mxroom', whole, (n) => `!room${n}:${i > 0 ? this.server(whole.slice(i + 1)) : 'example.test'}`);
    }
    if (groups.mxalias) {
      const i = whole.indexOf(':');
      return this.next('mxalias', whole, (n) => `#alias${n}:${this.server(whole.slice(i + 1))}`);
    }
    if (groups.mxevent) return this.next('mxevent', whole, (n) => `$ev${n}`);
    if (groups.uuid) return this.next('uuid', whole.toLowerCase(), (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    if (groups.tailnet) return this.next('tailnet', whole.toLowerCase(), (n) => `host${n}.example.test`);
    if (groups.homepath) return '/data/fixture';
    if (groups.accid) return this.next('accid', whole, (n) => `acc_fixture${n}`);
    if (groups.ipv4) return ALLOWED_IP(whole) ? whole : this.next('ipv4', whole, (n) => `192.0.2.${n}`);
    if (groups.phone) return this.next('phone', '+' + whole.replace(/\D/g, ''), (n) => `+1555${String(99 + n).padStart(4, '0')}`);
    if (groups.digits) return this.digits(whole);
    if (groups.host) return this.addHost(whole);
    return whole;
  }

  private digits(run: string): string {
    if (run.length === 13) {
      const t = Number(run);
      if (t >= MS_RANGE[0] && t < MS_RANGE[1]) return String(this.rebaseMs(t));
    }
    if (run.length === 10) {
      const t = Number(run);
      if (t >= S_RANGE[0] && t < S_RANGE[1]) return String(this.rebaseS(t));
    }
    return this.next('digits', run, (n) => String(SNOWFLAKE_BASE + BigInt(n)));
  }

  /** Swap every identifying token in a string. */
  string(s: string): string {
    return s.replace(this.re, (whole: string, ...rest: unknown[]) => this.token(rest.at(-1) as Record<string, string | undefined>, whole));
  }

  number(v: number): number {
    if (!Number.isInteger(v)) return v;
    if (v >= MS_RANGE[0] && v < MS_RANGE[1]) return this.rebaseMs(v);
    if (v >= S_RANGE[0] && v < S_RANGE[1]) return this.rebaseS(v);
    if (Math.abs(v) >= 100_000_000) {
      const out = this.digits(String(Math.abs(v)));
      // A snowflake string is too long for a JSON number: numbers get their own run, under 2^53.
      const n = Number(out.length > 16 ? NUMERIC_ID_BASE + Number(BigInt(out) - SNOWFLAKE_BASE) : out);
      return v < 0 ? -n : n;
    }
    return v;
  }

  private text(s: string, kind: 'text' | 'name'): string {
    if (!s) return s;
    if (kind === 'name') return this.next('name', s, (n) => (PEOPLE[n - 1] ? cap(PEOPLE[n - 1]) : `Person ${n}`));
    // HTML: tags stay (ids in them swapped), each run of text between them is swapped.
    if (/<[a-zA-Z/][^>]*>/.test(s)) return s.split(/(<[^>]*>)/).map((part) => (part.startsWith('<') ? this.string(part) : part.trim() ? this.plain(part) : part)).join('');
    return this.plain(s);
  }

  private plain(s: string): string {
    const edit = s.startsWith('* ') ? '* ' : '';
    const rest = s.slice(edit.length);
    return edit + this.next('text', rest, (n) => `message ${n}`);
  }

  /** Anonymize any JSON value. Object keys go through the same mapping as strings (never scrubbed as text). */
  value(v: unknown, key?: string): unknown {
    if (key !== undefined && SECRET_KEY.test(key) && (typeof v === 'string' || typeof v === 'number')) return REDACTED;
    if (typeof v === 'string') {
      if (this.scrub && key !== undefined && this.nameKeys.has(key)) return this.text(v, 'name');
      if (this.scrub && key !== undefined && this.textKeys.has(key)) return this.text(v, 'text');
      return this.string(v);
    }
    if (typeof v === 'number') return this.number(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[this.string(k)] = this.value(x, k);
      return out;
    }
    return v;
  }
}

/** The earliest epoch timestamps (ms and s) anywhere in a value, and the servers its Matrix ids name. */
function survey(v: unknown, acc: { ms?: number; s?: number; hosts: Set<string> }) {
  const seeTs = (t: number) => {
    if (t >= MS_RANGE[0] && t < MS_RANGE[1]) acc.ms = Math.min(acc.ms ?? t, t);
    else if (t >= S_RANGE[0] && t < S_RANGE[1]) acc.s = Math.min(acc.s ?? t, t);
  };
  const seeString = (s: string) => {
    for (const m of s.matchAll(/(?<!\d)(\d{13}|\d{10})(?!\d)/g)) seeTs(Number(m[1]));
    for (const m of s.matchAll(new RegExp(String.raw`[@!#$][A-Za-z0-9._=\/+~-]+:(${HOST})`, 'g'))) acc.hosts.add(m[1].toLowerCase().replace(/:\d+$/, ''));
  };
  if (typeof v === 'string') seeString(v);
  else if (typeof v === 'number') {
    if (Number.isInteger(v)) seeTs(v);
  } else if (Array.isArray(v)) for (const x of v) survey(x, acc);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      seeString(k);
      survey(x, acc);
    }
}

/**
 * Anonymize a whole trace with one mapping, so ids, hosts and times line up across its records. Timestamps are
 * rebased so the earliest becomes SYNTHETIC_MS_BASE (or SYNTHETIC_S_BASE for epoch seconds). Its keys change too, so the
 * result's type is the caller's to say.
 */
export function anonymizeTrace<T = unknown>(records: unknown, opts: AnonymizeOptions = {}): T {
  const acc: { ms?: number; s?: number; hosts: Set<string> } = { hosts: new Set() };
  survey(records, acc);
  const a = new Anonymizer({ ...opts, msOrigin: opts.msOrigin ?? acc.ms, sOrigin: opts.sOrigin ?? acc.s, hosts: [...(opts.hosts ?? []), ...[...acc.hosts].sort()] });
  return a.value(records) as T;
}

// ------------------------------------------------------------------ the leak guard

/** Already a placeholder: left as it is. Other reserved names (a testbed's `dither.test`) are still mapped. */
const isExampleHost = (h: string) => /(^|\.)example\.(com|org|net|test)$/.test(h) || h === 'localhost';
/** Reserved names (RFC 2606): an email at one is invented. */
const isSyntheticHost = (h: string) => /(^|\.)example\.(com|org|net|test)$/.test(h) || /(^|\.)(test|example|invalid|localhost)$/.test(h) || h === 'localhost';
const isSyntheticEmail = (e: string) => isSyntheticHost(e.slice(e.lastIndexOf('@') + 1).toLowerCase());

/** Shapes the anonymizer writes (and the repo's invented data uses): masked before the sweep runs. */
const SYNTHETIC: RegExp[] = [
  /\b00000000-0000-4000-8000-\d{12}\b/g,
  /(?<!\d)70{12,}\d{0,6}(?!\d)/g,
  /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net|test)|[A-Za-z0-9-]+\.test)\b/gi,
  /\+1555\d{4}(?!\d)/g,
  /\bacc_fixture\d+\b/g,
];

/** The sweep from AGENTS.md (and dither-chat's), plus phones, private and public IPs and account ids. */
const LEAKS: [string, RegExp][] = [
  ['long number', /(?<!\d)\d{9,}(?!\d)/g],
  ['email', /@[a-z0-9-]+\.[a-z]{2,}/gi],
  ['tailnet address', /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}/g],
  ['LAN address', /(?<![\d.])(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}/g],
  ['tailnet name', /\.ts\.net\b/gi],
  ['home path', /\/home\//g],
  ['phone number', /\+\d{7,15}(?!\d)|\+\d{1,3}[\s.-]\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}\b/g],
  ['account id', /\bacc_[A-Za-z0-9_-]{8,}/g],
];

export class LeakError extends Error {
  constructor(readonly hits: { kind: string; index: number; hint: string }[]) {
    super(`concrete data in a trace: ${hits.map((h) => `${h.kind} at ${h.index} (${h.hint})`).join(', ')}`);
  }
}

/** Throws a LeakError naming what hit and where (never the whole value) if anything concrete is left in `text`. */
export function assertNoConcreteLeaks(text: string): void {
  let masked = text;
  // Same-length masks, so a hit's index is its index in `text`.
  const mask = (m: string) => '_'.repeat(m.length);
  for (const re of SYNTHETIC) masked = masked.replace(re, mask);
  // Rebased timestamps: within the synthetic window.
  masked = masked.replace(/(?<!\d)\d{13}(?!\d)/g, (m) => (Number(m) >= SYNTH_MS_WINDOW[0] && Number(m) < SYNTH_MS_WINDOW[1] ? mask(m) : m));
  masked = masked.replace(/(?<!\d)\d{10}(?!\d)/g, (m) => (Number(m) >= SYNTH_S_WINDOW[0] && Number(m) < SYNTH_S_WINDOW[1] ? mask(m) : m));
  const hits: LeakError['hits'] = [];
  for (const [kind, re] of LEAKS) for (const m of masked.matchAll(re)) hits.push({ kind, index: m.index!, hint: `${m[0].slice(0, 3)}… ${m[0].length} chars` });
  for (const m of masked.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
    if (!ALLOWED_IP(m[0]) && !hits.some((h) => h.index === m.index)) hits.push({ kind: 'IP address', index: m.index!, hint: `${m[0].length} chars` });
  }
  if (hits.length) throw new LeakError(hits.sort((a, b) => a.index - b.index));
}

/** Anonymize, then refuse unless the result is clean: the one way a trace becomes a file. */
export function scrubTrace<T = unknown>(records: unknown, opts?: AnonymizeOptions): { value: T; json: string } {
  const value = anonymizeTrace<T>(records, opts);
  const json = JSON.stringify(value, null, 2);
  assertNoConcreteLeaks(json);
  return { value, json };
}

// ------------------------------------------------------------------ manager ⇄ extractor recorder

export const WIRE_CAPTURE_ENV = 'DITHER_WIRE_CAPTURE_DIR';

export interface WireRecord {
  seq: number;
  /** command: manager → extractor; event: extractor → manager. */
  dir: 'command' | 'event';
  at: number;
  msg: unknown;
}

/**
 * Records each stream (one per account) to `<dir>/stream-<n>.ndjson`, anonymized line by line with that stream's
 * own mapping (times rebased on its first). A line the leak guard refuses is left out, and counted in `dropped`.
 */
export class AdapterStreamRecorder {
  private streams = new Map<string, { file: string; anon: Anonymizer; seq: number }>();
  dropped = 0;

  constructor(
    readonly dir: string,
    private opts: AnonymizeOptions & { maxRecords?: number } = {},
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** A recorder when DITHER_WIRE_CAPTURE_DIR is set, else undefined: off costs one optional call per message. */
  static fromEnv(env: Record<string, string | undefined> = process.env): AdapterStreamRecorder | undefined {
    const dir = env[WIRE_CAPTURE_ENV];
    return dir ? new AdapterStreamRecorder(dir) : undefined;
  }

  /** One message on a stream: a JSON line as it came off the socket, or the object about to be sent. */
  record(stream: string, dir: WireRecord['dir'], msg: string | Buffer | object, at = Date.now()): WireRecord | null {
    // A recorder never gets in the way of the messages it watches: a full disk or a removed directory loses the record.
    try {
      return this.write(stream, dir, msg, at);
    } catch {
      this.dropped++;
      return null;
    }
  }

  private write(stream: string, dir: WireRecord['dir'], msg: string | Buffer | object, at: number): WireRecord | null {
    let s = this.streams.get(stream);
    if (!s) {
      s = { file: join(this.dir, `stream-${this.streams.size + 1}.ndjson`), anon: new Anonymizer(this.opts), seq: 0 };
      this.streams.set(stream, s);
    }
    if (this.opts.maxRecords !== undefined && s.seq >= this.opts.maxRecords) return null;
    let parsed: unknown;
    if (typeof msg === 'string' || msg instanceof Buffer) {
      try {
        parsed = JSON.parse(String(msg));
      } catch {
        return null;
      }
    } else parsed = msg;
    const rec: WireRecord = { seq: ++s.seq, dir, at: s.anon.rebaseMs(at), msg: s.anon.value(parsed) };
    const line = JSON.stringify(rec);
    try {
      assertNoConcreteLeaks(line);
    } catch {
      this.dropped++;
      appendFileSync(s.file, JSON.stringify({ seq: rec.seq, dir, dropped: true }) + '\n', { mode: 0o600 });
      return null;
    }
    appendFileSync(s.file, line + '\n', { mode: 0o600 });
    return rec;
  }
}

/** A trace file's records: NDJSON lines when `lines` (an .ndjson file), else one JSON document, else NDJSON. */
export function parseTrace(text: string, opts: { lines?: boolean } = {}): unknown {
  const t = text.trim();
  if (!opts.lines)
    try {
      return JSON.parse(t);
    } catch {}
  return t
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`line ${i + 1} is not JSON`);
      }
    });
}
