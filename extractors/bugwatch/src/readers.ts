/**
 * Reading the sources: each file tailed from where the last scan stopped (its inode and offset in state.json), across
 * rotation (the old file, renamed to `<file>.1`, is read to its end first) and truncation, and parsed by its kind into
 * error records. Only an error's fields are kept: for a plain log, its error line and `at` frames, never another line.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ErrorSource, errorBlocks } from '@dither-accounts/manager/errors';

export interface Rec {
  at: number;
  source: ErrorSource;
  where: string;
  name: string;
  /** One line, as the record said it (normalized later, for fingerprints and notices). */
  message: string;
  stack: string[];
  count: number;
  status?: number;
  trace?: string;
  extra?: Record<string, unknown>;
}

export interface FileState {
  ino: number;
  offset: number;
  /** The last time a plain log's lines said (ms), for the errors after it. */
  at?: number;
  /** A plain log's error block reached the end of what was read and was left for the next scan (once), for its frames to come. */
  hold?: boolean;
}

/** At most this much of one file in one scan (the rest the next time). */
export const SCAN_BYTES = 8 * 1024 * 1024;
/** At most this much of a file's end on the first start. */
export const BACKLOG_BYTES = 16 * 1024 * 1024;

// ------------------------------------------------------------------ files

/** The files a path names now: `*` in a segment matches any name there (no `**`). */
export function expand(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const parts = pattern.split('/');
  let bases = [parts[0] === '' ? '/' : parts[0]!];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const next: string[] = [];
    if (part.includes('*')) {
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const b of bases) {
        let names: string[] = [];
        try {
          names = readdirSync(b);
        } catch {}
        for (const n of names.sort()) if (re.test(n) && !n.startsWith('.')) next.push(join(b, n));
      }
    } else for (const b of bases) next.push(join(b, part));
    bases = next;
  }
  return bases.filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function readRange(path: string, from: number, to: number): Buffer {
  if (to <= from) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** Whole lines in [from, to): the lines and the offset after the last newline. `skipFirst` drops a partial first line. */
function linesIn(path: string, from: number, to: number, skipFirst: boolean): { lines: string[]; start: number; end: number } {
  const buf = readRange(path, from, Math.min(to, from + SCAN_BYTES));
  let start = 0;
  if (skipFirst && from > 0) {
    const nl = buf.indexOf(10);
    if (nl < 0) return { lines: [], start: from, end: from };
    start = nl + 1;
  }
  const last = buf.lastIndexOf(10);
  if (last < start) return { lines: [], start: from + start, end: from + start };
  const text = buf.subarray(start, last).toString('utf8');
  return { lines: text ? text.split('\n') : [''], start: from + start, end: from + last + 1 };
}

export interface Tailed {
  /** Lines in order, each chunk from one file. */
  /** `start`: the byte offset of the first line; `current`: the file itself, not its rotated `.1`. */
  chunks: { path: string; lines: string[]; start: number; end: number; mtime: number; current: boolean }[];
  state: FileState | undefined;
}

/**
 * What is new in a file since `was`. Without `was`: the file is new to us; on the first start (`backlog`) its last
 * BACKLOG_BYTES (and its rotated `.1` when that changed since `backlog`), else all of it.
 */
export function tail(path: string, was: FileState | undefined, backlog: number | null): Tailed {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { chunks: [], state: was };
  }
  const chunks: Tailed['chunks'] = [];
  const ino = st.ino;
  let from = 0;
  let skipFirst = false;
  if (!was) {
    if (backlog !== null) {
      const old = `${path}.1`;
      if (existsSync(old)) {
        const o = statSync(old);
        if (o.mtimeMs >= backlog && o.size > 0) {
          const start = Math.max(0, o.size - Math.max(0, BACKLOG_BYTES - st.size));
          if (start < o.size) chunks.push({ path: old, ...linesIn(old, start, o.size, start > 0), mtime: o.mtimeMs, current: false });
        }
      }
      from = Math.max(0, st.size - BACKLOG_BYTES);
      skipFirst = from > 0;
    }
  } else if (was.ino !== ino) {
    // Rotated: the rest of the old file, if it is still beside it.
    const old = `${path}.1`;
    try {
      const o = statSync(old);
      if (o.ino === was.ino && o.size > was.offset) chunks.push({ path: old, ...linesIn(old, was.offset, o.size, false), mtime: o.mtimeMs, current: false });
    } catch {}
  } else if (st.size < was.offset) {
    from = 0; // truncated
  } else from = was.offset;
  const { lines, start: first, end } = linesIn(path, from, st.size, skipFirst);
  from = first;
  chunks.push({ path, lines, start: from, end, mtime: st.mtimeMs, current: true });
  const keep = was && was.ino === ino ? { at: was.at } : {};
  return { chunks, state: { ino, offset: end, ...keep } };
}

// ------------------------------------------------------------------ parsing

const SOURCES: ErrorSource[] = ['uncaught', 'rejection', 'request', 'job', 'attempt', 'client'];
const s1 = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

/** One line of an errors-ndjson file (docs/bugwatch.md), if it is one. */
export function parseErrorsLine(line: string): Rec | null {
  if (!line.trim()) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || j.v !== 1 || typeof j.at !== 'number') return null;
  const source = SOURCES.includes(j.source as ErrorSource) ? (j.source as ErrorSource) : 'job';
  const count = typeof j.count === 'number' && j.count >= 1 ? Math.min(1e6, Math.floor(j.count)) : 1;
  return {
    at: j.at,
    source,
    where: s1(j.where, 200) || '(unknown)',
    name: s1(j.name, 80) || 'Error',
    message: s1(j.message, 300),
    stack: Array.isArray(j.stack) ? j.stack.slice(0, 10).map((f) => s1(f, 300)).filter(Boolean) : [],
    count,
    ...(typeof j.status === 'number' ? { status: j.status } : {}),
    ...(typeof j.trace === 'string' && /^[0-9a-f]{32}$/.test(j.trace) ? { trace: j.trace } : {}),
    ...(j.extra && typeof j.extra === 'object' && !Array.isArray(j.extra) ? { extra: j.extra as Record<string, unknown> } : {}),
  };
}

/** The manager's own refusals (spec MANAGER_CALL_CODES) that are not a bug: no grant, a rate limit, bad input, nobody there. */
const EXPECTED_OUTCOMES = new Set(['denied', 'limited', 'invalid', 'unknown-op', 'unknown-account', 'offline']);
/** A failure whose words say it was refused on purpose: a 4xx, a rate limit, a captcha, terms to accept, an abort. */
const EXPECTED_TEXT = /\b429\b|\b(?:status|http|answered|code|returned)\s*:?\s*4\d\d\b|\brate[ -]?limit|too many requests|captcha|\bterms\b|\babort(?:ed)?\b|AbortError/i;
const ERROR_NAME = /^((?:[A-Z][A-Za-z0-9_$]*)?(?:Error|Exception)):\s*(.*)$/;

/** A failed span of a trace file (dither-chat's hub.trace.ndjson, the manager's), unless it is an expected refusal. */
export function parseSpanLine(line: string): Rec | null {
  if (!line.includes('"error"')) return null;
  let j: Record<string, any>;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || j.status !== 'error' || typeof j.name !== 'string') return null;
  const attrs = (j.attrs && typeof j.attrs === 'object' ? j.attrs : {}) as Record<string, unknown>;
  // The hub's request spans say `http.status`; the manager's call spans `status`, an extractor's refusal's upstream one.
  const status = typeof attrs['http.status'] === 'number' ? (attrs['http.status'] as number) : typeof attrs.status === 'number' ? (attrs.status as number) : undefined;
  if (status !== undefined && status < 500) return null;
  if (typeof attrs.outcome === 'string' && EXPECTED_OUTCOMES.has(attrs.outcome)) return null;
  const error = s1(j.error, 300);
  if (EXPECTED_TEXT.test(error)) return null;
  const m = ERROR_NAME.exec(error);
  const name = s1(j.name, 200);
  const request = typeof attrs['http.route'] === 'string' || /^(GET|POST|PUT|PATCH|DELETE|HEAD) |^(call|command) /.test(name);
  const at = typeof j.startMs === 'number' ? j.startMs + (typeof j.durationMs === 'number' ? j.durationMs : 0) : Date.now();
  return {
    at: Math.round(at),
    source: request ? 'request' : 'job',
    where: name,
    name: m ? m[1]! : 'Error',
    message: m ? m[2]! : error || 'failed',
    stack: [],
    count: 1,
    ...(status !== undefined ? { status } : {}),
    ...(typeof j.traceId === 'string' && /^[0-9a-f]{32}$/.test(j.traceId) ? { trace: j.traceId } : {}),
  };
}

const ISO = /(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)/;

/**
 * Error records in a plain log's lines. Each error's time is the last time a line before it said (an ISO time
 * anywhere in a line, as adapter.log's `--- <time> … starting` lines), else `fallback`. Returns the records, the
 * last time seen, each record's line, and the index of a block that reaches the last line (its frames may still be coming).
 */
export function parseTextLines(lines: string[], fallback: number, lastAt: number | undefined, project?: string): { recs: Rec[]; lines: number[]; at: number | undefined; openFrom: number | null } {
  const times: (number | undefined)[] = [];
  let at = lastAt;
  for (const l of lines) {
    const m = ISO.exec(l);
    if (m) {
      const t = Date.parse(m[1]!.replace(' ', 'T'));
      if (Number.isFinite(t)) at = t;
    }
    times.push(at);
  }
  const blocks = errorBlocks(lines, project);
  const recs: Rec[] = [];
  const idx: number[] = [];
  let openFrom: number | null = null;
  for (const b of blocks) {
    let end = b.line + 1 + b.frames.length;
    while (end < lines.length && /^\s+at\s/.test(lines[end]!)) end++;
    if (end >= lines.length) openFrom = b.line;
    idx.push(b.line);
    recs.push({ at: times[b.line] ?? fallback, source: b.source, where: '', name: b.name, message: b.message, stack: b.frames, count: 1 });
  }
  return { recs, lines: idx, at, openFrom };
}
