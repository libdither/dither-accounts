/**
 * What bugwatch keeps in the account directory's state.json: where it is in each file, every fingerprint it saw in
 * the last 30 days (counts in 10-minute buckets for 8 days, first and last seen, up to 5 sample records, its notice,
 * its thread and what its threads concluded), the threads it started and the queue. Written whole (a temporary file renamed over the old one).
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ErrorSource } from '@dither-accounts/manager/errors';
import type { FileState } from './readers.ts';

export interface Sample {
  at: number;
  /** The error line as the record had it: `Name: message`. Never sent anywhere but a thread's brief. */
  line: string;
  frames: string[];
  trace?: string;
  status?: number;
  /**
   * Where to look around it: the plain logs that have warn or error lines in the minutes around it, and how many, for
   * an occurrence after the first (a fingerprint is armed when first seen). Paths and counts only: the thread reads
   * the lines itself.
   */
  around?: Around;
}

export interface Around {
  from: number;
  to: number;
  files: { path: string; lines: number }[];
}

export type Reason = 'new' | 'spike' | 'always';

export interface Thread {
  title: string;
  at: number;
  /** The thread's id, as the command printed it. */
  id?: string;
  /** The start failed: how (an exit code, a timeout), never its output. */
  failed?: string;
  /** What it cost, from threads.show, read now and then until it is done. */
  record?: ThreadRecord;
}

export interface ThreadRecord {
  checkedAt: number;
  status?: string;
  runs?: number;
  /** Items in the thread (messages, tool calls): its rough size. */
  items?: number;
  /** Pull requests it opened or linked. */
  prs?: number;
  /** From its start to its last change. */
  minutes?: number;
  /** No more checks: settled, archived, or old enough. */
  done?: boolean;
  /** threads.show failed: how. */
  error?: string;
  /** From the thread's latest reply (threads.show with its messages): its `Verdict:`, `Class:` and `Design cause:` lines. */
  verdict?: string;
  class?: string;
  cause?: string;
}

/** What a thread concluded, kept with its bug past a clear, so the next thread on it or a related bug starts from it. */
export interface Verdict {
  /** The thread's id. */
  thread: string;
  at: number;
  verdict?: string;
  class?: string;
  cause?: string;
}

export interface Bug {
  id: string;
  /** The fingerprint's text (normalize.ts). */
  text: string;
  sourceName: string;
  source: ErrorSource;
  where: string;
  name: string;
  /** Normalized. */
  message: string;
  frame: string;
  first: number;
  last: number;
  count: number;
  /** 10-minute bucket (ms / 600 000) → count. */
  buckets: Record<string, number>;
  samples: Sample[];
  /** A process crash (an uncaught error) was among its records. */
  crash: boolean;
  notice?: { at: number; reason: Reason; unread: boolean; catchUp?: boolean };
  thread?: Thread;
  /** Waits for a thread since. */
  queued?: number;
  /** Triage holds its thread until it is seen again threads.recurMinutes after it was first seen. */
  held?: boolean;
  /** Was left out of a full queue (bugs with more occurrences waited). */
  dropped?: boolean;
  /** Muted (notify.mute): no notices and no threads until cleared. */
  muted?: boolean;
  /** Gets no thread of its own: it shares a trace with this bug, whose thread covers both (until cleared). */
  joined?: string;
  /** What its threads concluded, the latest last (at most 5). */
  verdicts?: Verdict[];
  lastSpikeAt?: number;
  lastAlwaysAt?: number;
}

export interface State {
  version: 1;
  /** When the first scan ran (null: not yet, so the next one reads the last 24 h as a catch-up). */
  startedAt: number | null;
  files: Record<string, FileState>;
  bugs: Record<string, Bug>;
  /** When threads were started (the last 24 h). */
  threadStarts: number[];
  /** When a thread was last tried, started or not. */
  lastThreadTry: number;
  /** The sources (by name) read before: one not among them is read as a catch-up. */
  sources: string[];
}

export const fresh = (): State => ({ version: 1, startedAt: null, files: {}, bugs: {}, threadStarts: [], lastThreadTry: 0, sources: [] });

export function loadState(path: string, log?: (m: string) => void): State {
  if (!existsSync(path)) return fresh();
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as State;
    if (s?.version !== 1 || typeof s.bugs !== 'object' || s.bugs === null) throw new Error('not a version 1 state');
    return { ...fresh(), ...s };
  } catch (e) {
    log?.(`${path} does not read (${(e as Error).message}); starting over`);
    return fresh();
  }
}

export function saveState(path: string, s: State) {
  const tmp = join(dirname(path), `.state.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(s));
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

export const BUCKET_MS = 600_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Occurrences in [from, to). */
export function countBetween(b: Bug, from: number, to: number): number {
  let n = 0;
  const lo = Math.floor(from / BUCKET_MS);
  const hi = Math.floor(to / BUCKET_MS);
  for (const [k, v] of Object.entries(b.buckets)) {
    const i = Number(k);
    if (i >= lo && i < hi) n += v;
  }
  return n;
}

/** Forget buckets older than 8 days, and fingerprints not seen for 30 days (unless a thread or an unread notice holds them). */
export function prune(s: State, now: number) {
  const oldest = Math.floor((now - 8 * DAY) / BUCKET_MS);
  for (const b of Object.values(s.bugs)) for (const k of Object.keys(b.buckets)) if (Number(k) < oldest) delete b.buckets[k];
  for (const [id, b] of Object.entries(s.bugs)) if (b.last < now - 30 * DAY && !b.notice?.unread && b.queued === undefined) delete s.bugs[id];
  s.threadStarts = s.threadStarts.filter((t) => t > now - DAY);
}
