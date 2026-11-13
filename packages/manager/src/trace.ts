/**
 * Tracing (dither-chat's docs/tracing.md, which this follows). An app's call can carry a W3C `traceparent` (the `trace`
 * field of a `call` message); the manager's span for the call is then a child of the app's, and the extractor gets
 * the call's own traceparent with the command (`trace`), so its span is a child of the manager's. Extractors send their
 * finished spans up as a `log` event whose msg is `trace` (no protocol change); the manager writes them with its own.
 *
 * Every finished span is one line in `<data>/traces/manager.trace.ndjson`, rotated by size, and every hold of the
 * manager's event loop of 200 ms or more one line in `<data>/traces/event-loop-stalls.ndjson`, with the spans open in
 * it and the process's CPU time and page faults. dither-chat's `scripts/trace-summary.ts` reads both beside the hub's.
 *
 * Attributes are ids, counts, ops and outcomes: never what a call carries.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type Attr = string | number | boolean | null;
export type Attrs = Record<string, Attr>;

export interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Unix ms. */
  startMs: number;
  durationMs: number;
  attrs: Attrs;
  events?: { name: string; atMs: number; attrs?: Attrs }[];
  status: 'ok' | 'error';
  error?: string;
}

const hex = (bytes: number) => {
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(bytes))) s += x.toString(16).padStart(2, '0');
  return s;
};

/** A W3C traceparent's ids, if it is one. */
export function parseTraceparent(h: unknown): { traceId: string; spanId: string } | undefined {
  const m = typeof h === 'string' ? h.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/) : null;
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return { traceId: m[1]!, spanId: m[2]! };
}

/** A span record from an extractor, if it is one (shape and sizes checked: it came over a socket). */
export function spanRecordOf(x: unknown): SpanRecord | undefined {
  const r = x as SpanRecord;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  if (typeof r.name !== 'string' || r.name.length > 200 || !/^[0-9a-f]{32}$/.test(String(r.traceId)) || !/^[0-9a-f]{16}$/.test(String(r.spanId))) return undefined;
  if (r.parentSpanId !== undefined && !/^[0-9a-f]{16}$/.test(String(r.parentSpanId))) return undefined;
  if (typeof r.startMs !== 'number' || typeof r.durationMs !== 'number' || (r.status !== 'ok' && r.status !== 'error')) return undefined;
  if (JSON.stringify(r).length > 8192) return undefined;
  return r;
}

let sink: ((r: SpanRecord) => void) | null = null;
const open = new Set<Span>();
const RECENT = 64;
const recent: Span[] = [];
let recentHead = 0;

/** Where finished spans go; null turns tracing off. */
export function setTraceSink(s: ((r: SpanRecord) => void) | null) {
  sink = s;
  open.clear();
  recent.length = 0;
  recentHead = 0;
}

/** A record that came finished from elsewhere (an extractor's): written as it is. */
export function writeSpan(r: SpanRecord) {
  try {
    sink?.(r);
  } catch {}
}

export class Span {
  readonly spanId = hex(8);
  readonly traceId: string;
  readonly parentSpanId: string | undefined;
  readonly t0 = performance.now();
  t1 = 0;
  readonly startMs = Date.now();
  attrs: Attrs;
  events: { name: string; atMs: number; attrs?: Attrs }[] | undefined;
  failed: string | undefined;
  private done = false;

  constructor(
    readonly name: string,
    attrs: Attrs = {},
    parent?: { traceId: string; spanId: string },
  ) {
    this.traceId = parent?.traceId ?? hex(16);
    this.parentSpanId = parent?.spanId;
    this.attrs = { ...attrs };
    if (sink) open.add(this);
  }

  set(attrs: Attrs) {
    Object.assign(this.attrs, attrs);
    return this;
  }

  event(name: string, attrs?: Attrs) {
    (this.events ??= []).push({ name, atMs: Math.round((performance.now() - this.t0) * 10) / 10, ...(attrs ? { attrs } : {}) });
    return this;
  }

  fail(why: unknown) {
    const s = why instanceof Error ? why.message : String(why);
    this.failed = s.length > 300 ? `${s.slice(0, 300)}…` : s;
    return this;
  }

  /** For a call that leaves this process. */
  get traceparent() {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  end() {
    if (this.done) return;
    this.done = true;
    this.t1 = performance.now();
    open.delete(this);
    if (!sink) return;
    recent[recentHead] = this;
    recentHead = (recentHead + 1) % RECENT;
    writeSpan({
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      startMs: this.startMs,
      durationMs: Math.round((this.t1 - this.t0) * 10) / 10,
      attrs: this.attrs,
      ...(this.events ? { events: this.events } : {}),
      status: this.failed === undefined ? 'ok' : 'error',
      ...(this.failed !== undefined ? { error: this.failed } : {}),
    });
  }
}

/** Spans on the thread between `from` and `to` (performance.now()): still open now, or finished in it. */
export function spansBetween(from: number, to: number, max = 8): { name: string; traceId: string; spanId: string; open?: true }[] {
  const out: { name: string; traceId: string; spanId: string; open?: true }[] = [];
  for (const s of open) if (out.length < max) out.push({ name: s.name, traceId: s.traceId, spanId: s.spanId, open: true });
  for (const s of recent) if (s && s.t1 >= from && s.t0 <= to && out.length < max) out.push({ name: s.name, traceId: s.traceId, spanId: s.spanId });
  return out;
}

// ------------------------------------------------------------------ stalls

/** One hold of the event loop, as event-loop-stalls.ndjson keeps it (the same fields as dither-chat's hub). */
export interface StallRecord {
  atMs: number;
  heldMs: number;
  afterStartMs: number;
  work: string;
  spans: { name: string; traceId: string; spanId: string; open?: true }[];
  cpuUserMs?: number;
  cpuSystemMs?: number;
  minorFaults?: number;
  majorFaults?: number;
  voluntarySwitches?: number;
  involuntarySwitches?: number;
}

type Usage = Pick<NodeJS.ResourceUsage, 'userCPUTime' | 'systemCPUTime' | 'minorPageFault' | 'majorPageFault' | 'voluntaryContextSwitches' | 'involuntaryContextSwitches'>;

/**
 * A timer that should fire every `everyMs` and fires late says how long the loop was held. Each hold of `overMs` or
 * more is recorded with the spans on the thread and what the process did in it (CPU near the hold: work; little: a wait).
 */
export class StallWatch {
  private start = 0;
  private last = 0;
  private lastUsage: Usage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly o: { everyMs: number; overMs: number; record: (r: StallRecord) => void; now: () => number; wallNow: () => number; usage: (() => Usage) | null };

  constructor(o: { record: (r: StallRecord) => void; everyMs?: number; overMs?: number; now?: () => number; wallNow?: () => number; usage?: (() => Usage) | null }) {
    this.o = { everyMs: 100, overMs: 200, now: () => performance.now(), wallNow: () => Date.now(), usage: () => process.resourceUsage(), ...o };
  }

  begin() {
    this.from(this.o.now());
    this.timer = setInterval(() => this.check(), this.o.everyMs);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  from(t: number) {
    this.start = this.last = t;
    this.lastUsage = this.o.usage ? this.o.usage() : null;
    return this;
  }

  check(t = this.o.now()) {
    const held = t - this.last - this.o.everyMs;
    const u = this.o.usage ? this.o.usage() : null;
    if (held >= this.o.overMs) {
      const was = this.lastUsage;
      this.o.record({
        atMs: this.o.wallNow(),
        heldMs: Math.round(held),
        afterStartMs: Math.round(this.last - this.start),
        work: 'manager',
        spans: spansBetween(this.last, t),
        ...(u && was
          ? {
              cpuUserMs: Math.round((u.userCPUTime - was.userCPUTime) / 1000),
              cpuSystemMs: Math.round((u.systemCPUTime - was.systemCPUTime) / 1000),
              minorFaults: u.minorPageFault - was.minorPageFault,
              majorFaults: u.majorPageFault - was.majorPageFault,
              voluntarySwitches: u.voluntaryContextSwitches - was.voluntaryContextSwitches,
              involuntarySwitches: u.involuntaryContextSwitches - was.involuntaryContextSwitches,
            }
          : {}),
      });
    }
    this.lastUsage = u;
    this.last = t;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ------------------------------------------------------------------ files

export interface NdjsonFileOptions {
  /** Rotate when the file reaches this size... */
  maxBytes?: number;
  /** ...keeping this many older files (name.1 the newest). */
  keep?: number;
  /** Write what waits at least this often. */
  flushMs?: number;
  /** And at once when this much waits. */
  bufferBytes?: number;
}

/**
 * Lines appended to a file in batches, rotated by size. A write that fails is reported once and the batch dropped:
 * tracing never takes the hub down.
 */
export class NdjsonFile {
  private buf: string[] = [];
  private bufBytes = 0;
  private size: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private complained = false;
  private readonly o: Required<NdjsonFileOptions>;

  constructor(
    readonly path: string,
    o: NdjsonFileOptions = {},
  ) {
    this.o = { maxBytes: 10 * 1024 * 1024, keep: 10, flushMs: 1000, bufferBytes: 256 * 1024, ...o };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.size = existsSync(path) ? statSync(path).size : 0;
    this.timer = setInterval(() => this.flush(), this.o.flushMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  readonly push = (rec: unknown) => {
    const line = `${JSON.stringify(rec)}\n`;
    this.buf.push(line);
    this.bufBytes += line.length;
    if (this.bufBytes >= this.o.bufferBytes) this.flush();
  };

  flush() {
    if (!this.buf.length) return;
    const text = this.buf.join('');
    this.buf = [];
    this.bufBytes = 0;
    try {
      if (this.size > 0 && this.size + text.length > this.o.maxBytes) this.rotate();
      appendFileSync(this.path, text, { mode: 0o600 });
      this.size += Buffer.byteLength(text);
    } catch (e) {
      if (!this.complained) console.error(`trace: writing ${this.path} failed, dropping what it could not write:`, e);
      this.complained = true;
    }
  }

  private rotate() {
    const last = `${this.path}.${this.o.keep}`;
    if (existsSync(last)) rmSync(last);
    for (let i = this.o.keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
