/**
 * The manager's error file, `<data>/traces/errors.ndjson`: one JSON object per line in the errors-ndjson format that
 * dither-chat's hub writes too (docs/bugwatch.md), so the `bugwatch` extractor reads both the same way:
 *
 *   { v: 1, at, app: 'manager', source: 'uncaught' | 'rejection' | 'request' | 'job' | 'attempt' | 'client', where,
 *     name, message (one line, ≤ 300 chars), stack (≤ 10 frames, repo-relative), status?, trace?, version?, extra?,
 *     count? }
 *
 * What goes in it: the manager's own uncaught exceptions and unhandled rejections (installProcessHandlers, which keeps
 * the crash a crash), and an extractor whose process ends on its own with a failure (its last error and frames from
 * its stderr, with its kind and account in `extra`). Failed calls are not repeated here: they are failed spans in
 * manager.trace.ndjson, which bugwatch reads as well.
 *
 * The same error (source, where, name, message) within 10 s is one record with `count`; at most 30 records a minute
 * are written, and what a full minute drops is counted in the next record's `extra.dropped`.
 *
 * Also here, because the manager needs it for an extractor's stderr and bugwatch for plain logs: errorBlocks, which
 * finds error lines and their `at` frames in a log, and never keeps anything else (Bun's source excerpts, other lines).
 */
import { NdjsonFile } from './trace.ts';

export type ErrorSource = 'uncaught' | 'rejection' | 'request' | 'job' | 'attempt' | 'client';
export interface ErrorRecord {
  v: 1;
  at: number;
  app: string;
  source: ErrorSource;
  where: string;
  name: string;
  message: string;
  stack: string[];
  status?: number;
  trace?: string;
  version?: string;
  extra?: Record<string, string | number | boolean | null>;
  count?: number;
}

export const MAX_MESSAGE = 300;
export const MAX_FRAMES = 10;

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A frame with its path made relative to `root` (and to node_modules/ for a dependency's). */
export function relFrame(frame: string, root?: string): string {
  let f = oneLine(frame).replace(/^at\s+/, '');
  if (root) {
    const r = root.endsWith('/') ? root : `${root}/`;
    f = f.split(r).join('');
  }
  f = f.replace(/(?:\/[^\s()/]+)*\/node_modules\//g, 'node_modules/');
  return clip(`at ${f}`, 300);
}

/** An error's name, one-line message and frames, from whatever was thrown. */
export function errorFields(e: unknown, root?: string): { name: string; message: string; stack: string[] } {
  if (e instanceof Error) {
    const frames = (e.stack ?? '')
      .split('\n')
      .filter((l) => /^\s+at\s/.test(l))
      .slice(0, MAX_FRAMES)
      .map((l) => relFrame(l, root));
    return { name: clip(oneLine(e.name || 'Error'), 80), message: clip(oneLine(e.message), MAX_MESSAGE), stack: frames };
  }
  return { name: 'NonError', message: clip(oneLine(typeof e === 'string' ? e : (() => { try { return JSON.stringify(e) ?? String(e); } catch { return String(e); } })()), MAX_MESSAGE), stack: [] };
}

// ------------------------------------------------------------------ finding errors in a log

export interface ErrorBlock {
  name: string;
  message: string;
  frames: string[];
  /** `uncaught` for a crash (Bun's crash format, or a line that says uncaught), `rejection`, else `job`. */
  source: ErrorSource;
  /** The block's first line's index in the lines given. */
  line: number;
}

const FRAME = /^\s+at\s+\S/;
const NAMED = /^([A-Z][A-Za-z0-9_$]*(?:Error|Exception)|Error):\s*(.*)$/;
const BUN_ERROR = /^error:\s*(.*)$/;
const UNCAUGHT = /^(uncaught|unhandled)\b[\s:]*(.*)$/i;
/** Bun's line after a crash: "Bun v1.4.2 (Linux x64)". */
const BUN_TRAILER = /^Bun v\d/;
/** Prefixes a log line may carry before the error: an ISO time, a [tag] or two. */
const PREFIX = /^(?:\d{4}-\d\d-\d\d[T ][\d:.]+Z?\s+)?(?:\[[^\]]{1,40}\]\s*){0,3}/;

/**
 * Error lines in a log, each with the `at` frames right after it: `SomeError: …`, Bun's `error: …`, `uncaught …`,
 * `unhandled …`. Bun's source-excerpt lines (`227 |   const x = …`, the `^` under them) and every other line are
 * never kept. A block followed by Bun's version line is a crash (`uncaught`).
 */
export function errorBlocks(lines: string[], root?: string): ErrorBlock[] {
  const out: ErrorBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (FRAME.test(raw)) continue;
    const line = raw.replace(PREFIX, '').trim();
    let name: string | null = null;
    let message = '';
    let source: ErrorSource = 'job';
    let m: RegExpExecArray | null;
    if ((m = UNCAUGHT.exec(line))) {
      source = m[1]!.toLowerCase() === 'uncaught' ? 'uncaught' : 'rejection';
      const rest = (m[2] ?? '').replace(/^(exception|rejection|error)\b[\s:]*/i, '');
      const n = NAMED.exec(rest);
      if (n) [name, message] = [n[1]!, n[2]!];
      else [name, message] = [source === 'uncaught' ? 'Uncaught' : 'Unhandled', rest];
    } else if ((m = NAMED.exec(line))) [name, message] = [m[1]!, m[2]!];
    else if ((m = BUN_ERROR.exec(line))) [name, message] = ['error', m[1]!];
    if (name === null) continue;
    const frames: string[] = [];
    let j = i + 1;
    while (j < lines.length && FRAME.test(lines[j]!)) {
      if (frames.length < MAX_FRAMES) frames.push(relFrame(lines[j]!, root));
      j++;
    }
    for (let k = j; k < Math.min(lines.length, j + 2); k++) if (BUN_TRAILER.test(lines[k]!.trim())) source = 'uncaught';
    if (name === 'error' && source === 'job' && frames.length) source = 'uncaught';
    out.push({ name: clip(oneLine(name), 80), message: clip(oneLine(message), MAX_MESSAGE), frames, source, line: i });
    i = j - 1;
  }
  return out;
}

// ------------------------------------------------------------------ the file

export interface ErrorLogOptions {
  app?: string;
  /** Paths in frames are made relative to this (the repository). */
  root?: string;
  version?: string;
  dedupMs?: number;
  perMinute?: number;
  now?: () => number;
}

interface Pending {
  rec: ErrorRecord;
  /** Repeats since the record that was written. */
  more: number;
  timer: ReturnType<typeof setTimeout>;
}

export class ErrorLog {
  private file: NdjsonFile | null;
  private sink: ((r: ErrorRecord) => void) | null;
  private pending = new Map<string, Pending>();
  private minute = 0;
  private written = 0;
  private dropped = 0;
  private readonly o: Required<Omit<ErrorLogOptions, 'version' | 'root'>> & Pick<ErrorLogOptions, 'version' | 'root'>;

  /** `target`: the file's path, or a function that takes each record (tests). */
  constructor(target: string | ((r: ErrorRecord) => void), o: ErrorLogOptions = {}) {
    this.o = { app: 'manager', dedupMs: 10_000, perMinute: 30, now: Date.now, ...o };
    this.file = typeof target === 'string' ? new NdjsonFile(target, { maxBytes: 2 * 1024 * 1024, keep: 3 }) : null;
    this.sink = typeof target === 'function' ? target : null;
  }

  /** One error. Never throws: recording an error must not make another. */
  record(x: { source: ErrorSource; where: string; error: unknown; extra?: ErrorRecord['extra']; status?: number; trace?: string } | { source: ErrorSource; where: string; name: string; message: string; stack?: string[]; extra?: ErrorRecord['extra']; status?: number; trace?: string }) {
    try {
      const f = 'error' in x ? errorFields(x.error, this.o.root) : { name: clip(oneLine(x.name), 80), message: clip(oneLine(x.message), MAX_MESSAGE), stack: (x.stack ?? []).slice(0, MAX_FRAMES).map((s) => relFrame(s, this.o.root)) };
      const rec: ErrorRecord = {
        v: 1,
        at: this.o.now(),
        app: this.o.app,
        source: x.source,
        where: clip(oneLine(x.where), 200),
        ...f,
        ...(typeof x.status === 'number' ? { status: x.status } : {}),
        ...(x.trace ? { trace: x.trace } : {}),
        ...(this.o.version ? { version: this.o.version } : {}),
        ...(x.extra ? { extra: x.extra } : {}),
      };
      const key = `${rec.source}\u0000${rec.where}\u0000${rec.name}\u0000${rec.message}`;
      const p = this.pending.get(key);
      if (p) {
        p.more++;
        return;
      }
      const timer = setTimeout(() => this.settle(key), this.o.dedupMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(key, { rec, more: 0, timer });
      this.write(rec);
    } catch {}
  }

  /** The window of a written record ended: its repeats, if any, as one record with their count. */
  private settle(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    if (p.more > 0) this.write({ ...p.rec, at: this.o.now(), count: p.more });
  }

  private write(rec: ErrorRecord) {
    const minute = Math.floor(this.o.now() / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.written = 0;
    }
    if (this.written >= this.o.perMinute) {
      this.dropped += rec.count ?? 1;
      return;
    }
    this.written++;
    if (this.dropped) {
      rec = { ...rec, extra: { ...rec.extra, dropped: this.dropped } };
      this.dropped = 0;
    }
    if (this.sink) this.sink(rec);
    else this.file!.push(rec);
  }

  /** Everything waiting, written now (repeats included): before a crash ends the process. */
  flush() {
    for (const key of [...this.pending.keys()]) this.settle(key);
    this.file?.flush();
  }

  close() {
    this.flush();
    this.file?.close();
  }
}

/**
 * The manager's uncaught exceptions and unhandled rejections into the error file. A handler would keep the process
 * alive, so after recording it ends the process as the crash would have (exit 1): the service manager restarts it.
 */
export function installProcessHandlers(log: ErrorLog) {
  process.on('uncaughtException', onProcessError(log, 'uncaught'));
  process.on('unhandledRejection', onProcessError(log, 'rejection'));
}

/** One of those handlers: record, write it out now, say it on stderr as the crash would have, and end. */
export function onProcessError(log: ErrorLog, source: 'uncaught' | 'rejection', exit: (code: number) => void = (c) => process.exit(c)) {
  return (e: unknown) => {
    log.record({ source, where: 'process', error: e });
    log.flush();
    console.error(source === 'uncaught' ? 'uncaught exception:' : 'unhandled rejection:', e);
    exit(1);
  };
}
