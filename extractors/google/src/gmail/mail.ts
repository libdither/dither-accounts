/**
 * The `mail` interface (read-only) over Gmail's own web protocol, through the Gmail tab: thread lists and searches
 * (bv), thread fetches (fd), the sync call from a history point (s), and the original message from Gmail's own
 * download route. protocol.ts builds the bodies and reads the answers by their anchors; this class pages, pairs
 * messages with mailboxes, keeps what it learned (label names, a message's labels for a while), paces the calls, and
 * keeps each endpoint's fingerprint result, which the 'Gmail protocol' layer shows. docs/google.md, "Gmail mail".
 *
 * Two lanes share the one Gmail tab, a call at a time: the foreground (the owner's clicks, the app's normal sync, the
 * watch) and the background (`background: true`: an app's archive), which never goes ahead of the foreground and is
 * paced, budgeted, backed off and stopped on its own (BACKGROUND; the 'Gmail background' layer). And the unread guard:
 * if reading an unread message is ever seen to mark it read in Gmail, unread messages are refused from then on.
 *
 * Ids, opaque to apps but Gmail's own:
 *
 *   message   Gmail's message id as a decimal (the number after `msg-f:`), the same in every mailbox; `emailId` too.
 *   thread    Gmail's thread id as a decimal (after `thread-f:`).
 *   mailbox   Gmail's label id: ^i Inbox, ^t Starred, ^t_z Snoozed, ^io_im Important, ^f Sent, ^scheduled
 *             Scheduled, ^r Drafts, ^s Spam, ^k Trash, `all` (ours: All Mail), or one of your labels' ids.
 *   attachment  the part's IMAP-style number in the original (`2`, `1.3`).
 *   cursor    `c1.<date ms>.<message id>`: the last message a page gave; the next is everything older. No server
 *             state behind it, so it stays good for as long as the mail does.
 *   state     `g1.<history id>.<ms>`: Gmail's sync point, and when it was handed out. One for the whole account. A
 *             trailing `.b`: the sync point was taken from a list answer (bv's json[18][0]), not from Gmail's sync.
 *
 * Nothing here writes: no label is changed, nothing is sent.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MailChanges, MailFlags, MailMessage, MailSummary, Mailbox } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import { shape } from '../gmail-learn.js';
import { parseMessage } from './mime.ts';
import {
  type BvAnswer,
  type BvLayout,
  bvRequest,
  categoryOf,
  type Count,
  DECIMAL_ID,
  ENDPOINT_NAMES,
  ENDPOINTS,
  type Endpoint,
  type FdAnswer,
  fdThreadsRequest,
  flagsOf,
  type GMessage,
  hexOf,
  homeOf,
  inAllMail,
  isUserLabel,
  L,
  type LabelDef,
  LayoutError,
  labelQuery,
  labelsOf,
  newer,
  notAMessage,
  operatorsOnly,
  parseBv,
  parseFd,
  parseS,
  type SAnswer,
  SYSTEM,
  sRequest,
  type ThreadRow,
} from './protocol.ts';

export const ATTACHMENT_CAP = 25 * 1024 * 1024;
export const RAW_CAP = 50 * 1024 * 1024;
/** Threads per bv call, as the page asks. */
export const PAGE = 50;
/** bv calls one list or search page may make at most. */
const WINDOWS = 40;
/** A message dated up to this long before a state was handed out still counts as new after it (clocks differ). */
const SKEW = 5 * 60_000;
/** Label names are asked for again after this long. */
const NAMES_TTL = 10 * 60_000;
/** A message's labels, as last seen, are trusted this long by mail.get; older, they are fetched again. */
const FRESH = 2 * 60_000;
const CACHE_MAX = 20_000;
/** mail.arrived at most this many at a time (as the imap and proton kinds). */
export const CATCH_UP = 20;
/** The cursor's stand-in id when it only says "before this time". */
const ALL_AT = '99999999999999999999';
/** The one cheap list call (labels, counts and a sync point without Gmail's sync): the inbox's first 10 threads. */
const CHEAP = { query: 'in:inbox', pageSize: 10 };
/** A sync point from a list answer that Gmail's sync answers with one this much newer was no sync point (a million changes). */
const BV_POINT_GAP = 1_000_000n;
/** Label names that could not be had are not asked for again (unless a call needs them) for this long. */
const NAMES_RETRY = 60_000;

/** Which lane a call goes in: the foreground (default) or the background (`background: true`). */
export type LaneName = 'fg' | 'bg';
type Kind = 'list' | 'message';
/** Why the background lane stopped: Gmail showed a challenge, the page is signed out, or the day's budget is spent. */
export type StopCause = 'challenge' | 'signedOut' | 'quota';
/** The background lane's rules (docs/google.md, "The background lane"); tests pass smaller ones. */
export interface BackgroundRules {
  /** At most one list, search, fetch or sync call per this many ms. */
  listMs: number;
  /** At most one message download (get, attachment, raw) per this many ms. */
  messageMs: number;
  /** At most this many bytes of messages downloaded (both lanes count) per rolling window. */
  budgetBytes: number;
  windowMs: number;
  /** After a slow answer, a 429 or a 5xx: wait this long, doubling to backoffMaxMs; back to none after goodToReset good answers. */
  backoffMinMs: number;
  backoffMaxMs: number;
  slowMs: number;
  goodToReset: number;
  /** A background call that cannot start within this long answers 503 'backoff' (so the caller hears it under its op's timeout). */
  waitMs: number;
  /** The lane counts as running this long after its last call. */
  idleMs: number;
}
export const BACKGROUND: BackgroundRules = {
  listMs: 3000,
  messageMs: 2000,
  budgetBytes: 2e9,
  windowMs: 24 * 3600_000,
  backoffMinMs: 2000,
  backoffMaxMs: 300_000,
  slowMs: 10_000,
  goodToReset: 5,
  waitMs: 20_000,
  idleMs: 30_000,
};
const STOP_SENTENCE: Record<StopCause, string> = {
  challenge: 'Gmail answered with a sign-in or verification page (or refused the page); it resumes once the Gmail page is signed in and answers a call again',
  signedOut: 'the Gmail page is signed out; it resumes once the page is signed in and answers a call again',
  quota: "the day's download budget is spent",
};
const hms = (at: number) => `${new Date(at).toISOString().slice(11, 19)} UTC`;

export interface SyncInfo {
  /** The page made a sync call of its own: its headers and query are known. */
  sync: boolean;
  headers: number;
  ik: boolean;
  history: string | null;
}
/** What a non-mail answer read as in the page (gmail-learn.js pageKind): a sign-in or verification page. */
export type PageKind = 'signin' | 'challenge';
export interface SyncAnswer {
  status: number;
  json?: unknown;
  error?: string;
  page?: PageKind | null;
}
export interface RawAnswer {
  status: number;
  bytes?: Buffer;
  tooBig?: number;
  type?: string | null;
  error?: string;
  page?: PageKind | null;
}
type Answer = { status: number; json?: unknown; bytes?: Buffer; page?: PageKind | null; error?: string; type?: string | null };
interface Job {
  lane: LaneName;
  kind: Kind;
  deadline: number;
  go: () => void;
  fail: (e: Error) => void;
}
/** The Gmail tab, as this class needs it (main.ts: through the hook; the tests: straight to the fake). */
export interface Transport {
  info(): Promise<SyncInfo>;
  sync(endpoint: 'bv' | 'fd' | 's', body: unknown): Promise<SyncAnswer>;
  raw(hex: string, max: number): Promise<RawAnswer>;
}

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
type Msg = GMessage & { id: string };
type Item = { m: Msg; row: ThreadRow };
type Cursor = { date: number; id: string };
interface Box {
  id: string;
  query: string;
  member: (m: GMessage) => boolean;
}
interface Known {
  thread: string | null;
  labels: string[];
  date: number;
  from: GMessage['from'];
  subject: string;
  snippet: string | null;
  at: number;
}
export interface Fingerprint {
  calls: number;
  ok: number;
  failed: number;
  /** The last call's result: true passed, false failed, null none yet. */
  last: boolean | null;
  /** Why the last call failed: where and what kind of thing, never a value. */
  note: string | null;
  /** The first failure's reason, kept. */
  first: string | null;
  /** The first failed answer's shape (gmail-learn.js: type tags and Gmail's own anchors, never a value), for fixing the layout. */
  firstShape?: unknown;
  at: number;
}

export const cursorOf = (c: Cursor) => `c1.${c.date}.${c.id}`;
export function parseCursor(v: unknown): Cursor {
  const m = typeof v === 'string' ? /^c1\.(\d{13})\.(\d{1,20})$/.exec(v) : null;
  if (!m) throw new StatusError('not a cursor this account gave', 400);
  return { date: Number(m[1]), id: m[2]! };
}
export const stateOf = (history: string, at: number, guess = false) => `g1.${history}.${at}${guess ? '.b' : ''}`;
export function parseState(v: unknown): { history: string; at: number; guess: boolean } {
  const m = typeof v === 'string' ? /^g1\.(\d{1,15})\.(\d{13})(\.b)?$/.exec(v) : null;
  if (!m) throw new StatusError('not a state this account gave', 400);
  return { history: m[1]!, at: Number(m[2]), guess: !!m[3] };
}
const laneOf = (v: unknown): LaneName => (v === true ? 'bg' : 'fg');
const before = (m: { date: number; id: string }, c: Cursor) => newer(m, c) > 0;
const clamp = (v: unknown, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d));
function checkId(id: unknown): string {
  if (typeof id !== 'string' || !DECIMAL_ID.test(id)) throw new StatusError('no such message', 404);
  return id;
}
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

// ------------------------------------------------------------------ what a search's operators say of one message
const IN: Record<string, (l: string[]) => boolean> = {
  inbox: (l) => l.includes(L.INBOX),
  sent: (l) => l.includes(L.SENT),
  drafts: (l) => l.includes(L.DRAFTS),
  draft: (l) => l.includes(L.DRAFTS),
  spam: (l) => l.includes(L.SPAM),
  trash: (l) => l.includes(L.TRASH),
  snoozed: (l) => l.includes('^t_z'),
  scheduled: (l) => l.includes('^scheduled'),
  starred: (l) => l.includes(L.STARRED),
  important: (l) => l.includes(L.IMPORTANT),
  anywhere: () => true,
};
const IS: Record<string, (l: string[]) => boolean> = {
  unread: (l) => l.includes(L.UNREAD),
  read: (l) => !l.includes(L.UNREAD),
  starred: (l) => l.includes(L.STARRED),
  important: (l) => l.includes(L.IMPORTANT),
  snoozed: (l) => l.includes('^t_z'),
};
const CATEGORY_WORDS: Record<string, string | null> = { primary: null, social: 'Category/Social', promotions: 'Category/Promotions', updates: 'Category/Updates', forums: 'Category/Forums' };
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '-');
function dateOf(v: string): number | null {
  if (/^\d{9,11}$/.test(v)) return Number(v) * 1000;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}
function ageOf(v: string): number | null {
  const m = /^(\d{1,5})([dmy])$/.exec(v);
  return m ? Number(m[1]) * { d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 }[m[2] as 'd' | 'm' | 'y'] : null;
}

/**
 * What the operators of a Gmail search say of one message, where a message's labels, date and attachments can say
 * it: in:, is:, label: (by name), category:, has:attachment, after:, before:, newer_than:, older_than:, each maybe
 * negated. Gmail answers a search with whole threads; this keeps out the messages of a matched thread that the
 * operators would not match on their own. Free text, and operators it cannot judge (larger:, from:, …), keep all.
 */
export function messageFilter(query: string, names: ReadonlyMap<string, string>, now: number): (m: GMessage) => boolean {
  const preds: ((m: GMessage) => boolean)[] = [];
  for (const t of query.trim().split(/\s+/)) {
    const mm = /^(-?)([a-z_]+):(.+)$/.exec(t);
    if (!mm) continue;
    const [, neg, op, raw] = mm;
    const v = raw!.replace(/^"|"$/g, '').toLowerCase();
    let p: ((m: GMessage) => boolean) | null = null;
    if (op === 'in' && IN[v]) p = (m) => IN[v]!(m.labels);
    else if (op === 'is' && IS[v]) p = (m) => IS[v]!(m.labels);
    else if (op === 'label') {
      const ids = [...names].filter(([, n]) => norm(n) === norm(v)).map(([id]) => id);
      if (ids.length) p = (m) => ids.some((id) => m.labels.includes(id));
    } else if (op === 'category' && v in CATEGORY_WORDS) p = (m) => categoryOf(m.labels) === CATEGORY_WORDS[v];
    else if (op === 'has' && v === 'attachment') p = (m) => m.attachments > 0;
    else if (op === 'after' || op === 'before') {
      const at = dateOf(v);
      if (at !== null) p = op === 'after' ? (m) => m.date >= at : (m) => m.date < at;
    } else if (op === 'newer_than' || op === 'older_than') {
      const age = ageOf(v);
      if (age !== null) p = op === 'newer_than' ? (m) => m.date > now - age : (m) => m.date < now - age;
    }
    if (p) preds.push(neg ? ((q) => (m: GMessage) => !q(m))(p) : p);
  }
  return (m) => preds.every((p) => p(m));
}

// ------------------------------------------------------------------ the class
export class GmailMail {
  /** Each endpoint's fingerprint results (the 'Gmail protocol' layer, the self-check). */
  /** The first msg-a message record's shape (type tags and anchors, no values), to learn where its Gmail id is. */
  notYetGmailShape: unknown = undefined;
  readonly fp: Record<Endpoint, Fingerprint> = Object.fromEntries(ENDPOINTS.map((e) => [e, { calls: 0, ok: 0, failed: 0, last: null, note: null, first: null, at: 0 }])) as Record<Endpoint, Fingerprint>;
  /** Your labels: id → name, from the label list (s's, or bv's in its own layout). */
  readonly userLabels = new Map<string, string>();
  /** Counts that settle guesses, for the self-check: numbers, booleans and words only. */
  readonly evidence = {
    rowsAfterCutoff: 0,
    pagingFallbacks: 0,
    notYetGmail: 0,
    lastEstimate: null as number | null,
    lastBvTrailer: null as number | null,
    lastSTrailer: null as number | null,
    lastHistory: null as string | null,
    /** The layout of the last bv answer, and how many of each were seen. */
    bvLayout: null as BvLayout | null,
    bvLayouts: { own: 0, page: 0 },
    /** Pairs of bv answers in a row, and how many of those had a smaller json[18][0] than the one before. */
    bvTrailerPairs: 0,
    bvTrailerDecreased: 0,
    /** Where the last sync point handed out came from: our own sync, the page's own, or a list answer's json[18][0]. */
    pointFrom: null as 'ours' | 'page' | 'bv' | null,
    /** A sync call made from a list answer's number: 'ok' (it took it and answered no older one), 'refused', or none yet. */
    sFromBvPoint: null as 'ok' | 'refused' | null,
    /** Why the list answers' number stopped being taken as a sync point (this extractor's sentence), or null. */
    bvPointRefused: null as string | null,
    /** Where the last mail.mailboxes got its labels and counts, and where lastCounts came from. */
    mailboxesFrom: null as 's' | 'bv' | null,
    countsFrom: null as 's' | 'bv' | null,
  };
  /** The latest sync point this class got from Gmail's sync. */
  history: string | null = null;
  /** The last counts Gmail gave (s's json[2][0], or bv's json[6][0]): [unread, total] as read, for the self-check. */
  lastCounts: Map<string, Count> | null = null;
  /** The last bv answer's json[18][0], as a sync point; refused once Gmail's sync did not take it (or it went down). */
  private bvPoint: string | null = null;
  private bvRefused: string | null = null;
  /** The largest sync point Gmail's own sync (or the page) gave: a list answer's number below it is no sync point. */
  private maxPoint: bigint | null = null;
  private namesAt = 0;
  private namesFailedAt = 0;
  private known = new Map<string, Known>();
  private announced = new Set<string>();
  private gapMs: number;
  private now: () => number;
  private rules: BackgroundRules;
  // The lanes: a call at a time, the foreground's first.
  private fgQ: Job[] = [];
  private bgQ: Job[] = [];
  private busy = false;
  private lastCall = 0;
  private wakeTimer: Timer | null = null;
  private bgNext: Record<Kind, number> = { list: 0, message: 0 };
  private bgLast = 0;
  private bgInFlight = false;
  private backoff = { ms: 0, until: 0, good: 0 };
  private blocked: Exclude<StopCause, 'quota'> | null = null;
  private signedIn: boolean | null = null;
  private quotaWas = false;
  private refresh = new Map<string, Timer>();
  // What is kept in the account's directory: the bytes downloaded (per minute, the last window), and the unread guard.
  private fetched: [number, number][] = [];
  private guard: { tripped: boolean; at: number | null } = { tripped: false, at: null };

  constructor(
    private t: Transport,
    private o: { log: Log; onChange?: () => void; gapMs?: number; now?: () => number; background?: Partial<BackgroundRules>; stateFile?: string },
  ) {
    this.gapMs = o.gapMs ?? 300;
    this.now = o.now ?? Date.now;
    this.rules = { ...BACKGROUND, ...o.background };
    this.load();
  }

  // ------------------------------------------------------------- kept state
  private load() {
    const f = this.o.stateFile;
    if (!f || !existsSync(f)) return;
    try {
      const v = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(v?.fetched)) this.fetched = v.fetched.filter((e: unknown) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]) && e[1] >= 0).map((e: number[]) => [e[0]!, e[1]!]);
      if (v?.unreadGuard === 'tripped') this.guard = { tripped: true, at: Number.isFinite(v.unreadGuardAt) ? v.unreadGuardAt : null };
    } catch (e) {
      this.o.log('warn', 'gmail: the kept lane state could not be read; starting from none', String((e as Error).message ?? e).slice(0, 120));
    }
  }

  private save() {
    const f = this.o.stateFile;
    if (!f) return;
    try {
      const v = { fetched: this.fetched, ...(this.guard.tripped ? { unreadGuard: 'tripped', unreadGuardAt: this.guard.at } : {}) };
      writeFileSync(`${f}.tmp`, JSON.stringify(v), { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch (e) {
      this.o.log('warn', 'gmail: the lane state could not be kept', String((e as Error).message ?? e).slice(0, 120));
    }
  }

  // ------------------------------------------------------------- the lanes
  /**
   * One Gmail call, in its lane: one at a time, each at least gapMs after the last one ended. The foreground's go first;
   * a background call goes only when no foreground call waits, at its kind's pace, after any back-off, and not at all
   * while the background is stopped (then it answers 503 'paused') or when it could not start in waitMs (503 'backoff').
   */
  private paced<T extends Answer>(lane: LaneName, kind: Kind, f: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const deadline = Date.now() + this.rules.waitMs;
      if (lane === 'bg') {
        const no = this.bgRefusal(Date.now(), deadline);
        if (no) return reject(no);
      }
      const job: Job = {
        lane,
        kind,
        deadline,
        fail: reject,
        go: () => {
          const t0 = Date.now();
          const note = (r: Answer | null) => {
            try {
              this.answered(lane, r, Date.now() - t0);
            } catch (e) {
              this.o.log('warn', 'gmail: an answer could not be noted', String((e as Error).message ?? e).slice(0, 120));
            }
          };
          Promise.resolve()
            .then(f)
            .then(
              (r) => {
                note(r);
                resolve(r);
              },
              (e) => {
                note(null);
                reject(e);
              },
            )
            .finally(() => {
              this.lastCall = Date.now();
              this.busy = false;
              if (lane === 'bg') {
                this.bgInFlight = false;
                this.bgLast = Date.now();
                this.tick('idle', this.bgLast + this.rules.idleMs + 10);
              }
              this.pump();
            });
        },
      };
      (lane === 'fg' ? this.fgQ : this.bgQ).push(job);
      this.pump();
    });
  }

  private pump() {
    if (this.busy) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const now = Date.now();
    const gapAt = this.lastCall + this.gapMs;
    let job: Job;
    if (this.fgQ.length) {
      if (gapAt > now) return this.wake(gapAt);
      job = this.fgQ.shift()!;
    } else {
      this.shed(now);
      const head = this.bgQ[0];
      if (!head) return;
      const at = Math.max(gapAt, this.bgNext[head.kind], this.backoff.until);
      if (at > now) return this.wake(at);
      job = this.bgQ.shift()!;
      this.bgNext[job.kind] = now + (job.kind === 'list' ? this.rules.listMs : this.rules.messageMs);
      const was = this.bgRunning();
      this.bgInFlight = true;
      if (!was) this.o.onChange?.();
    }
    this.busy = true;
    job.go();
  }

  private wake(at: number) {
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.pump();
      },
      Math.max(1, at - Date.now()),
    );
  }

  /** Background calls that may not go: all of them while the lane is stopped, and those that could not start in time. */
  private shed(now: number) {
    if (!this.bgQ.length) return;
    const stop = this.stopped();
    if (stop) {
      for (const j of this.bgQ.splice(0)) j.fail(this.paused(stop));
      return;
    }
    const start = Math.max(now, this.backoff.until);
    const late = this.bgQ.filter((j) => start > j.deadline);
    if (!late.length) return;
    this.bgQ = this.bgQ.filter((j) => start <= j.deadline);
    for (const j of late) j.fail(this.late());
  }

  private bgRefusal(now: number, deadline: number): StatusError | null {
    const stop = this.stopped();
    if (stop) return this.paused(stop);
    if (this.backoff.until > deadline) return this.late();
    return null;
  }

  private paused(cause: StopCause): StatusError {
    const why = cause === 'quota' ? `${STOP_SENTENCE.quota}; it resumes at ${hms(this.quotaFreeAt() ?? this.now())}` : STOP_SENTENCE[cause];
    return new StatusError(`Gmail background reading is paused: ${why}`, 503, 'paused');
  }

  private late(): StatusError {
    const until = this.backoff.until > Date.now() ? ` (backed off until ${hms(this.backoff.until)} after a slow or refused answer)` : '';
    return new StatusError(`Gmail background reading could not take this call within ${Math.round(this.rules.waitMs / 1000)} s${until}; try again later`, 503, 'backoff');
  }

  /** What an answer says of Gmail: a block stops the background; a slow, 429 or 5xx one backs it off; good ones undo both. */
  private answered(lane: LaneName, r: Answer | null, ms: number) {
    if (r?.page) this.block('challenge', `Gmail answered with a ${r.page === 'signin' ? 'sign-in' : 'verification'} page`);
    // Not what was asked for, with a 200: no JSON from a sync endpoint, an HTML page from the download route. Gmail does
    // not answer so; whatever it is, it may be a block.
    else if (r?.status === 200 && ((r.error === 'not-json' && r.json === undefined) || (!r.bytes && /^text\/html\b/i.test(r.type ?? '')))) this.block('challenge', 'Gmail answered a page that is not what was asked for');
    else if (r?.status === 401) this.block('signedOut', 'Gmail answered 401');
    else if (r?.status === 403) this.block('challenge', 'Gmail answered 403');
    const bad = !r || ms > this.rules.slowMs || r.status === 429 || r.status >= 500;
    if (bad) {
      const next = this.backoff.ms ? Math.min(this.backoff.ms * 2, this.rules.backoffMaxMs) : this.rules.backoffMinMs;
      this.backoff = { ms: next, until: Date.now() + next, good: 0 };
      this.o.log('info', `gmail background: backing off ${next / 1000} s after ${!r ? 'no answer' : ms > this.rules.slowMs ? `a slow answer (${Math.round(ms / 1000)} s)` : `a ${r.status}`}`);
      this.tick('backoff', this.backoff.until + 10);
      this.o.onChange?.();
      return;
    }
    if (r.status !== 200 || r.page || (r.json === undefined && !r.bytes)) return;
    if (lane === 'bg' && this.backoff.ms && ++this.backoff.good >= this.rules.goodToReset) {
      this.backoff = { ms: 0, until: 0, good: 0 };
      this.o.onChange?.();
    }
    if (this.blocked && this.signedIn !== false) {
      this.o.log('info', `gmail background: Gmail answers again; resumed (it had stopped: ${this.blocked})`);
      this.blocked = null;
      this.o.onChange?.();
    }
  }

  private block(cause: Exclude<StopCause, 'quota'>, why: string) {
    if (this.blocked) return;
    this.blocked = cause;
    this.o.log('warn', `gmail background: stopped (${cause}): ${why}; background calls answer 503 paused until it clears`);
    this.o.onChange?.();
  }

  /** What the Gmail tab says of its sign-in (main.ts): signed out stops the background until it is in and answering again. */
  notePage(signedIn: boolean | null) {
    this.signedIn = signedIn;
    if (signedIn === false) this.block('signedOut', 'the Gmail page is not signed in');
  }

  /** Bytes downloaded in the window, after dropping what fell out of it. */
  private used(): number {
    const from = this.now() - this.rules.windowMs;
    if (this.fetched.length && this.fetched[0]![0] <= from) this.fetched = this.fetched.filter((e) => e[0] > from);
    return this.fetched.reduce((n, e) => n + e[1], 0);
  }

  /** When the window will hold less than the budget again; null when it does now. */
  private quotaFreeAt(): number | null {
    let over = this.used() - this.rules.budgetBytes;
    if (over < 0) return null;
    for (const [at, n] of this.fetched) {
      over -= n;
      if (over < 0) return at + this.rules.windowMs;
    }
    return this.now();
  }

  /** Downloaded bytes, both lanes: per minute (an entry's time is its last download's, so it leaves the window late, not early). */
  private count(bytes: number) {
    const now = this.now();
    const last = this.fetched.at(-1);
    if (last && now - last[0] < 60_000 && now >= last[0]) {
      last[0] = now;
      last[1] += bytes;
    } else this.fetched.push([now, bytes]);
    this.save();
    this.stopped();
  }

  /** Why the background is stopped, if it is (the budget looked at afresh). */
  private stopped(): StopCause | null {
    const full = this.used() >= this.rules.budgetBytes;
    if (full !== this.quotaWas) {
      this.quotaWas = full;
      if (full) {
        const at = this.quotaFreeAt() ?? this.now();
        this.o.log('warn', `gmail background: stopped (quota): ${(this.rules.budgetBytes / 1e9).toFixed(1)} GB downloaded in ${this.rules.windowMs / 3600_000} h; resumes at ${hms(at)}`);
        this.tick('quota', Date.now() + Math.max(0, at - this.now()) + 10);
      } else this.o.log('info', 'gmail background: the download budget has room again; resumed');
      this.o.onChange?.();
    }
    return this.blocked ?? (full ? 'quota' : null);
  }

  /** A background call refused before it starts while the lane is stopped (main.ts asks before the page's own checks). */
  admit(background: unknown) {
    if (laneOf(background) !== 'bg') return;
    const stop = this.stopped();
    if (stop) throw this.paused(stop);
  }

  private bgRunning() {
    return this.bgInFlight || this.bgQ.length > 0 || (this.bgLast > 0 && Date.now() - this.bgLast < this.rules.idleMs);
  }

  /** A status refresh at `at` (one per reason): the lane's state changes with time too. */
  private tick(name: string, at: number) {
    if (!this.o.onChange) return;
    const old = this.refresh.get(name);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.refresh.delete(name);
      this.stopped();
      this.o.onChange?.();
    }, Math.max(1, at - Date.now()));
    (t as { unref?: () => void }).unref?.();
    this.refresh.set(name, t);
  }

  /** The background lane's state, for the status (details.backgroundStopped, the 'Gmail background' layer). */
  background(): { stopped: StopCause | null; backedOffUntil: number | null; backoffMs: number; running: boolean } {
    return { stopped: this.stopped(), backedOffUntil: this.backoff.until > Date.now() ? this.backoff.until : null, backoffMs: this.backoff.ms, running: this.bgRunning() };
  }

  /** The 'Gmail background' layer: ok idle or running, waiting while backed off, failed while stopped (with why). */
  backgroundLayer(): { name: string; state: 'ok' | 'waiting' | 'failed'; note: string } {
    const name = 'Gmail background';
    const b = this.background();
    if (b.stopped) return { name, state: 'failed', note: `stopped (${b.stopped}): ${b.stopped === 'quota' ? `${STOP_SENTENCE.quota}; resumes at ${hms(Date.now() + Math.max(0, (this.quotaFreeAt() ?? this.now()) - this.now()))}` : STOP_SENTENCE[b.stopped]}` };
    if (b.backedOffUntil) return { name, state: 'waiting', note: `backed off until ${hms(b.backedOffUntil)} after a slow or refused answer` };
    return { name, state: 'ok', note: b.running ? 'running' : 'idle' };
  }

  // ------------------------------------------------------------- calls
  private note(ep: Endpoint, ok: boolean, why: string | null = null) {
    const f = this.fp[ep];
    const was = `${f.last}|${f.note}`;
    f.calls++;
    f.at = this.now();
    if (ok) f.ok++;
    else {
      f.failed++;
      f.first ??= why;
    }
    f.last = ok;
    f.note = ok ? null : why;
    if (`${f.last}|${f.note}` !== was) this.o.onChange?.();
  }

  /** A background call whose answer stopped the lane answers 'paused', as every one after it. */
  private stopFor(lane: LaneName): StatusError | null {
    const stop = lane === 'bg' ? this.stopped() : null;
    return stop ? this.paused(stop) : null;
  }

  private async call<T>(ep: 'bv' | 'fd' | 's', body: unknown, parse: (json: unknown) => T, lane: LaneName): Promise<T> {
    const r = await this.paced(lane, 'list', () => this.t.sync(ep, body));
    if (r.status === 0) throw new StatusError(r.error === 'no-sync-yet' ? 'the Gmail page has not made a sync call of its own yet, so the headers it sends are not known; try again in a moment' : `the Gmail page could not make the call (${String(r.error ?? 'no reason').slice(0, 80)})`, 503);
    if (r.page) {
      const what = r.page === 'signin' ? 'a sign-in page' : 'a verification page';
      this.note(ep, false, `the answer is ${what}`);
      this.o.log('warn', `gmail ${ep}: answered with ${what}`);
      throw this.stopFor(lane) ?? new StatusError(`Gmail answered the page's ${ENDPOINT_NAMES[ep]} call with ${what}, not mail; open the live view`, 502);
    }
    if (r.status !== 200) {
      this.note(ep, false, `answered ${r.status}`);
      this.o.log('warn', `gmail ${ep}: answered ${r.status}`);
      throw this.stopFor(lane) ?? new StatusError(`Gmail answered ${r.status} to the page's ${ENDPOINT_NAMES[ep]} call`, 502);
    }
    if (r.json === undefined) {
      this.note(ep, false, 'the answer is not JSON after its prefix');
      throw this.stopFor(lane) ?? new StatusError(`Gmail's ${ENDPOINT_NAMES[ep]} answer is not JSON; nothing was returned rather than possibly wrong mail`, 502);
    }
    try {
      const out = parse(r.json);
      this.note(ep, true);
      return out;
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      this.note(ep, false, e.message);
      this.fp[ep].firstShape ??= shape(r.json);
      this.o.log('warn', `gmail ${ep}: not laid out as known, ${e.message}`);
      throw new StatusError(`Gmail's ${ENDPOINT_NAMES[ep]} answer is not laid out as this extractor knows it (${e.message}); nothing was returned rather than possibly wrong mail`, 502);
    }
  }

  private async bv(query: string, lane: LaneName, pageSize = PAGE): Promise<BvAnswer> {
    const now = this.now();
    const r = await this.call('bv', bvRequest({ query, pageSize, now, requestId: 1e8 + Math.floor(Math.random() * 8e8), history: this.history }), parseBv, lane);
    this.evidence.lastEstimate = r.estimate;
    if (r.layout) {
      this.evidence.bvLayout = r.layout;
      this.evidence.bvLayouts[r.layout]++;
    }
    if (r.trailer !== null) this.noteTrailer(r.trailer);
    if (r.labels) this.learnLabels(r.labels);
    if (r.counts) {
      this.lastCounts = r.counts;
      this.evidence.countsFrom = 'bv';
    }
    return r;
  }

  /** A list answer's json[18][0], kept as the sync point to fall back on, unless it went down or is below one Gmail's sync gave. */
  private noteTrailer(n: number) {
    const prev = this.evidence.lastBvTrailer;
    this.evidence.lastBvTrailer = n;
    if (!Number.isInteger(n) || n < 0 || String(n).length > 15) return this.refuseBvPoint('it is not a whole number of at most 15 digits');
    if (prev !== null) {
      this.evidence.bvTrailerPairs++;
      if (n < prev) {
        this.evidence.bvTrailerDecreased++;
        this.refuseBvPoint('it went down from one list answer to the next');
      }
    }
    if (this.maxPoint !== null && BigInt(n) < this.maxPoint) this.refuseBvPoint('it is below a sync point Gmail gave');
    this.bvPoint = String(n);
  }

  private refuseBvPoint(why: string) {
    if (this.bvRefused) return;
    this.bvRefused = why;
    this.evidence.bvPointRefused = why;
    this.o.log('warn', `gmail: the number a list answer ends with is not taken as a sync point from now on: ${why}`);
  }

  private notePoint(history: string) {
    const h = BigInt(history);
    if (this.maxPoint === null || h > this.maxPoint) this.maxPoint = h;
  }

  private async fd(threads: string[], lane: LaneName): Promise<FdAnswer> {
    const r = await this.call('fd', fdThreadsRequest(threads), parseFd, lane);
    const now = this.now();
    for (const t of r.threads)
      for (const m of t.messages) {
        if (!m.id) continue;
        const k = this.known.get(m.id);
        this.keep(m.id, { thread: t.thread, labels: m.labels, date: m.date, from: m.from ?? k?.from ?? null, subject: k?.subject ?? '', snippet: m.snippet ?? k?.snippet ?? null, at: now });
      }
    return r;
  }

  /**
   * s from a sync point: what changed since, the label list (names kept) and the counts. From a point a list answer
   * gave (`from: 'bv'`), Gmail's sync must take it and answer no older one; else the list answers' number is not a
   * sync point, is not used again, and this answers the honest 503.
   */
  private async s(history: string, lane: LaneName, from: 'ours' | 'page' | 'bv' = 'ours'): Promise<SAnswer> {
    let r: SAnswer;
    try {
      r = await this.call('s', sRequest(history, this.now()), parseS, lane);
    } catch (e) {
      if (from === 'bv' && (e as StatusError).status === 502) {
        this.evidence.sFromBvPoint = 'refused';
        this.refuseBvPoint("Gmail's sync did not take it");
        throw this.noPoint();
      }
      throw e;
    }
    if (from === 'bv') {
      const gap = BigInt(r.history) - BigInt(history);
      if (gap < 0n || gap > BV_POINT_GAP) {
        this.evidence.sFromBvPoint = 'refused';
        this.refuseBvPoint(gap < 0n ? "Gmail's sync answered an older sync point than it" : "it is far below the sync point Gmail's sync answered");
        throw this.noPoint();
      }
      this.evidence.sFromBvPoint = 'ok';
    }
    if (r.labels) this.learnLabels(r.labels);
    this.history = r.history;
    this.notePoint(r.history);
    this.lastCounts = r.counts;
    this.evidence.countsFrom = 's';
    this.evidence.lastHistory = r.history;
    this.evidence.lastSTrailer = r.trailer;
    return r;
  }

  private learnLabels(labels: LabelDef[]) {
    this.userLabels.clear();
    for (const l of labels) if (isUserLabel(l)) this.userLabels.set(l.id, l.name);
    this.namesAt = this.now();
  }

  private noPoint(): StatusError {
    return new StatusError(`Gmail's sync point is not known yet: the Gmail page has not synced since it loaded${this.bvRefused ? ", and the number Gmail's list answers end with is not one" : ''}; try again in a minute`, 503);
  }

  /** A sync point Gmail's sync gave: ours, else the one the page itself last synced from; null when neither is known. */
  private async realPoint(): Promise<{ history: string; from: 'ours' | 'page' } | null> {
    if (this.history) return { history: this.history, from: 'ours' };
    const h = (await this.t.info()).history;
    if (!h) return null;
    this.notePoint(h);
    return { history: h, from: 'page' };
  }

  /**
   * The newest sync point known: ours, else the page's own, else the last list answer's json[18][0] (one cheap list
   * call made for it when none was seen yet), unless that number was found not to be one (then 503). `guess`: from a
   * list answer.
   */
  async pointInfo(): Promise<{ history: string; guess: boolean }> {
    const real = await this.realPoint();
    if (real) {
      this.evidence.pointFrom = real.from;
      return { history: real.history, guess: false };
    }
    if (!this.bvRefused && this.bvPoint === null) await this.bv(CHEAP.query, 'fg', CHEAP.pageSize);
    if (this.bvRefused || this.bvPoint === null) throw this.noPoint();
    this.evidence.pointFrom = 'bv';
    return { history: this.bvPoint, guess: true };
  }

  async point(): Promise<string> {
    return (await this.pointInfo()).history;
  }

  /** Whether the list answers' number was found not to be a sync point. */
  get bvPointRefused(): boolean {
    return !!this.bvRefused;
  }

  /** Label names, fresh: from Gmail's sync when a sync point is known, else from one cheap list call (its label list). */
  private async ensureNames(required: boolean, lane: LaneName) {
    if (!required && this.namesAt && this.now() - this.namesAt < NAMES_TTL) return;
    if (!required && this.namesFailedAt && this.now() - this.namesFailedAt < NAMES_RETRY) return;
    try {
      const p = await this.realPoint();
      if (p) await this.s(p.history, lane, p.from);
      else {
        const r = await this.bv(CHEAP.query, lane, CHEAP.pageSize);
        if (!r.labels) throw new StatusError("Gmail's label list is not known yet: the Gmail page has not synced since it loaded, and Gmail's list answer carries none; try again in a minute", 503);
      }
    } catch (e) {
      if (required || ['paused', 'backoff'].includes(String((e as StatusError).callCode))) throw e;
      this.namesFailedAt = this.now();
      this.o.log('debug', 'gmail: label names not refreshed', String((e as Error).message ?? e).slice(0, 160));
    }
  }

  private keep(id: string, k: Known) {
    this.known.delete(id);
    this.known.set(id, k);
    if (this.known.size > CACHE_MAX) this.known.delete(this.known.keys().next().value!);
  }
  private remember(m: Msg, row: ThreadRow) {
    this.keep(m.id, { thread: row.thread, labels: m.labels, date: m.date, from: m.from, subject: row.subject, snippet: m.snippet, at: this.now() });
  }

  // ------------------------------------------------------------- mailboxes
  private async box(id: unknown, lane: LaneName): Promise<Box> {
    const sys = SYSTEM.find((b) => b.id === id);
    if (sys) return { id: sys.id, query: sys.query, member: sys.label ? (m) => m.labels.includes(sys.label!) : (m) => inAllMail(m.labels) };
    if (typeof id === 'string' && /^\^[\w-]{1,80}$/.test(id)) {
      if (!this.userLabels.has(id)) await this.ensureNames(true, lane);
      const name = this.userLabels.get(id);
      if (name !== undefined) return { id, query: labelQuery(name), member: (m) => m.labels.includes(id) };
    }
    throw new StatusError('no such mailbox', 404);
  }

  /**
   * The system mailboxes, then your labels, with counts: from Gmail's sync when a sync point is known (ours or the
   * page's), else from one cheap list call, whose answer (bv's own layout) carries the label list and the counts.
   */
  async mailboxes(): Promise<{ mailboxes: Mailbox[] }> {
    const p = await this.realPoint();
    let counts: Map<string, Count>;
    if (p) {
      counts = (await this.s(p.history, 'fg', p.from)).counts;
      this.evidence.mailboxesFrom = 's';
    } else {
      const r = await this.bv(CHEAP.query, 'fg', CHEAP.pageSize);
      if (!r.labels) throw new StatusError("Gmail's label list is not known yet: the Gmail page has not synced since it loaded, and Gmail's list answer carries none; try again in a minute", 503);
      counts = r.counts ?? new Map();
      this.evidence.mailboxesFrom = 'bv';
    }
    const n = (id: string) => count(counts.get(id));
    const out: Mailbox[] = SYSTEM.map((b) => ({ id: b.id, name: b.name, path: b.name, parentId: null, role: b.role, ...n(b.label ?? L.ALL) }));
    const byName = new Map([...this.userLabels].map(([id, name]) => [name, id]));
    for (const [id, path] of [...this.userLabels].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))) {
      const cut = path.lastIndexOf('/');
      out.push({ id, name: cut >= 0 ? path.slice(cut + 1) : path, path, parentId: cut > 0 ? (byName.get(path.slice(0, cut)) ?? null) : null, role: null, ...n(id) });
    }
    return { mailboxes: out };
  }

  // ------------------------------------------------------------- lists
  private summary(x: Item, mailboxId: string): MailSummary {
    const { m, row } = x;
    return {
      id: m.id,
      emailId: m.id,
      mailboxId,
      messageId: null,
      threadId: row.thread,
      from: m.from ? [m.from] : [],
      to: m.to,
      cc: m.cc,
      subject: row.subject,
      date: m.date,
      receivedAt: m.date,
      flags: flagsOf(m.labels),
      labels: labelsOf(m.labels, this.userLabels),
      size: 0,
      preview: m.snippet,
      hasAttachments: m.attachments > 0,
      inReplyTo: null,
      references: [],
    };
  }

  /**
   * Messages of a search, newest first, from `cursor` on: bv a window at a time (the search, and `before:` the cursor's
   * second once there is one), each thread's messages that are in the mailbox and older than the cursor. A full
   * window (PAGE threads) gives only the messages newer than its last thread's date: a message no newer than that may
   * be in a thread the next window has. A window that is not full is the end.
   */
  private async collect(o: { query: string; member: (m: GMessage) => boolean; limit: number; cursor: Cursor | null; since: number | null; lane: LaneName }): Promise<{ items: Item[]; next: Cursor | null; estimate: number | null }> {
    const items: Item[] = [];
    let cur = o.cursor;
    let estimate: number | null = null;
    for (let w = 0; w < WINDOWS; w++) {
      const cut = cur ? Math.floor(cur.date / 1000) + 1 : null;
      const q = [o.query, cut ? `before:${cut}` : '', o.since !== null ? `after:${Math.max(0, Math.floor(o.since / 1000) - 1)}` : ''].filter(Boolean).join(' ');
      const page = await this.bv(q, o.lane);
      if (w === 0) estimate = page.estimate;
      if (cut) this.evidence.rowsAfterCutoff += page.rows.filter((r) => r.date >= cut * 1000).length;
      const all: Item[] = [];
      const seen = new Set<string>();
      for (const row of page.rows)
        for (const g of row.messages) {
          if (!g.id) {
            this.evidence.notYetGmail++;
            if (g.record !== undefined && this.notYetGmailShape === undefined) this.notYetGmailShape = { head: shape(g.record), tail: Array.isArray(g.record) ? shape(g.record.slice(40)) : null };
            continue;
          }
          const m = g as Msg;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          this.remember(m, row);
          if (!o.member(m) || (cur && !before(m, cur)) || (o.since !== null && m.date < o.since)) continue;
          all.push({ m, row });
        }
      all.sort((a, b) => newer(a.m, b.m));
      const full = page.rows.length >= PAGE;
      const bound = full ? Math.min(...page.rows.map((r) => r.date)) : null;
      let take = bound === null ? all : all.filter((x) => x.m.date > bound);
      if (!take.length && all.length) {
        // A full window whose messages are all at its last date or older: Gmail dates rows otherwise than by the
        // messages it matched. Go on with them rather than stop (counted: the self-check says how often).
        take = all;
        this.evidence.pagingFallbacks++;
      }
      for (const x of take) {
        items.push(x);
        if (items.length >= o.limit) return { items, next: { date: x.m.date, id: x.m.id }, estimate };
      }
      if (bound === null || (o.since !== null && bound < o.since)) return { items, next: null, estimate };
      const last = take.at(-1);
      let next: Cursor = last ? { date: last.m.date, id: last.m.id } : { date: bound, id: ALL_AT };
      if (cur && !last && next.date >= cur.date) next = { date: cur.date - 1, id: ALL_AT };
      cur = next;
    }
    return { items, next: cur, estimate };
  }

  async list(input: { mailboxId: unknown; limit?: unknown; before?: unknown; since?: unknown; background?: unknown }): Promise<{ messages: MailSummary[]; next: string | null }> {
    const lane = laneOf(input.background);
    this.admit(input.background);
    const box = await this.box(input.mailboxId, lane);
    const limit = clamp(input.limit, 50, 1, 500);
    const cursor = input.before !== undefined && input.before !== null ? parseCursor(input.before) : null;
    const since = typeof input.since === 'number' && Number.isFinite(input.since) ? input.since : null;
    const r = await this.collect({ query: box.query, member: box.member, limit, cursor, since, lane });
    // The names the summaries use: as the list answers just gave them (their own layout carries the label list), else fetched.
    await this.ensureNames(false, lane);
    return { messages: r.items.map((x) => this.summary(x, box.id)), next: r.next ? cursorOf(r.next) : null };
  }

  /**
   * Gmail's own search syntax, through bv, newest first. Without a mailbox, Spam and Trash are left out (as Gmail
   * does) unless the query names them. With `idsOnly`, operators only (operatorsOnly), and ids with Gmail's estimate.
   */
  async search(input: { query?: unknown; mailboxId?: unknown; limit?: unknown; idsOnly?: unknown; cursor?: unknown; background?: unknown }): Promise<{ messages: MailSummary[]; next: string | null } | { ids: string[]; next: string | null; estimate: number | null }> {
    const lane = laneOf(input.background);
    const q = String(input.query ?? '').trim();
    if (!q) throw new StatusError('search for what?', 400);
    if (q.length > 1000) throw new StatusError('the search is too long', 400);
    const idsOnly = input.idsOnly === true;
    if (idsOnly) {
      const why = operatorsOnly(q);
      if (why) throw new StatusError(why, 400);
    }
    this.admit(input.background);
    const box = input.mailboxId !== undefined && input.mailboxId !== null ? await this.box(input.mailboxId, lane) : null;
    const limit = idsOnly ? clamp(input.limit, 500, 1, 500) : clamp(input.limit, 50, 1, 200);
    const cursor = input.cursor !== undefined && input.cursor !== null ? parseCursor(input.cursor) : null;
    await this.ensureNames(false, lane);
    const ops = messageFilter(q, this.userLabels, this.now());
    const bins = /(^|\s)in:(trash|spam|anywhere)\b/i.test(q);
    const member = (m: GMessage) => (box ? box.member(m) : bins || inAllMail(m.labels)) && ops(m);
    const r = await this.collect({ query: box ? `${q} ${box.query}` : q, member, limit, cursor, since: null, lane });
    const next = r.next ? cursorOf(r.next) : null;
    if (idsOnly) return { ids: r.items.map((x) => x.m.id), next, estimate: r.estimate };
    return { messages: r.items.map((x) => this.summary(x, box?.id ?? homeOf(x.m.labels))), next };
  }

  // ------------------------------------------------------------- one message
  /** The original from Gmail's download route (the same bytes "Show original" downloads); its bytes count against the budget. */
  private async fetchRaw(id: string, lane: LaneName): Promise<Buffer> {
    const r = await this.paced(lane, 'message', () => this.t.raw(hexOf(id), RAW_CAP));
    if (r.status === 0) throw new StatusError(r.error === 'no-ik' ? 'the Gmail page has not shown its account key yet; try again in a moment' : `the Gmail page could not download the message (${String(r.error ?? 'no reason').slice(0, 80)})`, 503);
    if (r.page) {
      const what = r.page === 'signin' ? 'a sign-in page' : 'a verification page';
      this.note('raw', false, `the download is ${what}`);
      this.o.log('warn', `gmail raw: the download is ${what}`);
      throw this.stopFor(lane) ?? new StatusError(`Gmail answered the message download with ${what}, not the message; open the live view`, 502);
    }
    if (r.tooBig) throw new StatusError(`the message is ${mb(r.tooBig)} MB; at most 50 MB come through here`, 413);
    if (r.status === 404 || r.status === 400) throw new StatusError('no such message', 404);
    if (r.status !== 200 || !r.bytes) {
      const why = r.type && /^text\/html\b/i.test(r.type) ? 'the download is an HTML page, not a message' : `answered ${r.status}`;
      this.note('raw', false, why);
      throw this.stopFor(lane) ?? new StatusError(r.type && /^text\/html\b/i.test(r.type) ? "Gmail's message download answered an HTML page, not a message; nothing was returned rather than possibly wrong mail" : `Gmail answered ${r.status} to the message download`, 502);
    }
    this.count(r.bytes.length);
    let bad = notAMessage(r.bytes, r.type);
    // A blank line first is a message with no headers when Gmail's own listing has it with no sender: then it is taken.
    if (bad && notAMessage(r.bytes, r.type, { headerless: true }) === null && (await this.listedWithoutSender(id, lane))) bad = null;
    if (bad) {
      this.note('raw', false, `the download is ${bad}`);
      this.o.log('warn', `gmail raw: the download is ${bad}`);
      throw new StatusError(`Gmail's message download answered ${bad}; nothing was returned rather than possibly wrong mail`, 502);
    }
    this.note('raw', true);
    return r.bytes;
  }

  /**
   * Whether Gmail's own listing has this message with no sender (a message with no headers): as last seen, else its
   * thread fetched again (fd). Not seen in a listing since this started: false (refused, as before).
   */
  private async listedWithoutSender(id: string, lane: LaneName): Promise<boolean> {
    const k = await this.locate(id, null, lane).catch(() => null);
    return !!k && !k.from;
  }

  /** A message's labels and thread: as last seen (2 minutes), else its thread fetched again (fd), else a search for its Message-ID. */
  private async locate(id: string, messageId: string | null, lane: LaneName): Promise<Known | null> {
    const k = this.known.get(id);
    if (k && this.now() - k.at < FRESH) return k;
    if (k?.thread) {
      await this.fd([k.thread], lane);
      const again = this.known.get(id);
      if (again && again !== k) return again;
    }
    if (messageId && messageId.length <= 300) {
      const started = this.now();
      await this.collect({ query: `rfc822msgid:${messageId.slice(1, -1)}`, member: () => false, limit: 1, cursor: null, since: null, lane });
      const hit = this.known.get(id);
      if (hit && hit.at >= started) return hit;
    }
    return k ?? null;
  }

  // ------------------------------------------------------------- the unread guard
  /** Whether reading an unread message was seen to mark it read in Gmail (kept in the account's directory). */
  get readsMarkRead(): boolean {
    return this.guard.tripped;
  }

  private knownUnread(id: string): boolean {
    return this.known.get(id)?.labels.includes(L.UNREAD) ?? false;
  }

  /** Once tripped: a message known to be unread is not downloaded at all (409 'unread'). */
  private guardRefuse(id: string) {
    if (this.guard.tripped && this.knownUnread(id)) throw new StatusError('this message is unread, and reading one here was seen to mark it read in Gmail; it is not read here while it is unread (open it in Gmail)', 409, 'unread');
  }

  /**
   * After an unread message was downloaded: its thread fetched again (fd, the page's prefetch form) to see whether it is
   * still unread. If not, reading marks mail read: the guard trips, for good (until its line in the kept file is removed).
   */
  private async guardCheck(id: string, lane: LaneName) {
    const k = this.known.get(id);
    if (!k?.thread || this.guard.tripped) return;
    try {
      await this.fd([k.thread], lane);
    } catch (e) {
      this.o.log('warn', 'gmail: could not look again at an unread message after reading it', String((e as Error).message ?? e).slice(0, 160));
      return;
    }
    const again = this.known.get(id);
    if (!again || again === k || again.labels.includes(L.UNREAD)) return;
    this.guard = { tripped: true, at: this.now() };
    this.save();
    this.o.log('warn', 'gmail: an unread message was read here and Gmail now has it as read; unread messages are refused from now on (409 unread, details.readsMarkRead)');
    this.o.onChange?.();
  }

  async get(input: { id: unknown; background?: unknown }): Promise<MailMessage> {
    const lane = laneOf(input.background);
    const id = checkId(input.id);
    this.admit(input.background);
    this.guardRefuse(id);
    const unread = this.knownUnread(id);
    const raw = await this.fetchRaw(id, lane);
    if (unread) await this.guardCheck(id, lane);
    const p = await parseMessage(raw);
    const k = await this.locate(id, p.messageId, lane);
    await this.ensureNames(false, lane);
    const labels = k?.labels ?? [];
    const flags: MailFlags = k ? flagsOf(labels) : { seen: true, flagged: false, answered: false, draft: false };
    return {
      id,
      emailId: id,
      mailboxId: homeOf(labels),
      messageId: p.messageId,
      threadId: k?.thread ?? null,
      from: p.from.length ? p.from : k?.from ? [k.from] : [],
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      replyTo: p.replyTo,
      subject: p.subject ?? k?.subject ?? '',
      date: p.date ?? k?.date ?? 0,
      receivedAt: k?.date ?? p.date ?? 0,
      flags,
      labels: labelsOf(labels, this.userLabels),
      size: raw.length,
      preview: k?.snippet ?? null,
      hasAttachments: p.attachments.some((a) => !(a.inline && a.contentId)),
      inReplyTo: p.inReplyTo,
      references: p.references,
      ...(p.bulk ? { bulk: p.bulk } : {}),
      text: p.text,
      html: p.html,
      attachments: p.attachments,
    };
  }

  /** A thread fetched whole (fd), its messages' labels kept: how many messages it has. */
  async threadMessages(thread: string): Promise<number> {
    if (!DECIMAL_ID.test(thread)) throw new StatusError('no such thread', 404);
    const r = await this.fd([thread], 'fg');
    return r.threads.reduce((n, t) => n + t.messages.length, 0);
  }

  async attachment(input: { id: unknown; attachmentId: unknown; background?: unknown }): Promise<{ filename: string | null; mime: string; base64: string }> {
    const lane = laneOf(input.background);
    const id = checkId(input.id);
    const part = String(input.attachmentId ?? '');
    if (!/^\d{1,4}(\.\d{1,4}){0,10}$/.test(part)) throw new StatusError('no such attachment', 404);
    this.admit(input.background);
    this.guardRefuse(id);
    const p = await parseMessage(await this.fetchRaw(id, lane));
    const a = p.attachments.find((x) => x.id === part);
    const data = a ? p.parts.get(a.id) : undefined;
    if (!a || !data) throw new StatusError('no such attachment', 404);
    if (data.length > ATTACHMENT_CAP) throw new StatusError(`the attachment is ${mb(data.length)} MB; at most 25 MB come through here`, 413);
    return { filename: a.filename, mime: a.mime, base64: data.toString('base64') };
  }

  async raw(input: { id: unknown; background?: unknown }): Promise<{ filename: null; mime: 'message/rfc822'; base64: string; size: number }> {
    const lane = laneOf(input.background);
    const id = checkId(input.id);
    this.admit(input.background);
    this.guardRefuse(id);
    const unread = this.knownUnread(id);
    const bytes = await this.fetchRaw(id, lane);
    if (unread) await this.guardCheck(id, lane);
    return { filename: null, mime: 'message/rfc822', base64: bytes.toString('base64'), size: bytes.length };
  }

  // ------------------------------------------------------------- keeping up
  /**
   * What changed since a state: Gmail's sync call (s) from the state's sync point gives every thread changed since,
   * as it is now. A message of those in the mailbox is `added` when it is dated after the state was handed out (less
   * SKEW), else `changed`; one not in it is `removed` (it may never have been there: ignore ids you do not know).
   * Without a state: the current sync point, as a starting point. One answer is one batch: `more` is false.
   */
  async changes(input: { mailboxId: unknown; state?: unknown }): Promise<MailChanges> {
    const box = await this.box(input.mailboxId, 'fg');
    if (input.state === undefined || input.state === null || input.state === '') {
      const p = await this.pointInfo();
      return { state: stateOf(p.history, this.now(), p.guess), added: [], changed: [], removed: [], more: false };
    }
    const st = parseState(input.state);
    const r = await this.s(st.history, 'fg', st.guess ? 'bv' : 'ours');
    const added: MailSummary[] = [];
    const changed: MailChanges['changed'] = [];
    const removed: string[] = [];
    for (const x of this.items(r.rows)) {
      if (!box.member(x.m)) removed.push(x.m.id);
      else if (x.m.date > st.at - SKEW) added.push(this.summary(x, box.id));
      else changed.push({ id: x.m.id, flags: flagsOf(x.m.labels), labels: labelsOf(x.m.labels, this.userLabels) });
    }
    added.sort((a, b) => a.receivedAt - b.receivedAt);
    return { state: stateOf(r.history, this.now()), added, changed, removed, more: false };
  }

  private items(rows: ThreadRow[]): Item[] {
    const out: Item[] = [];
    const seen = new Set<string>();
    for (const row of rows)
      for (const g of row.messages) {
        if (!g.id || seen.has(g.id)) continue;
        seen.add(g.id);
        this.remember(g as Msg, row);
        out.push({ m: g as Msg, row });
      }
    return out;
  }

  /**
   * One look for the watch (main.ts, every gmailPollSeconds): s from the watch's sync point. The mailboxes the changed
   * threads' messages are in (and Inbox and All Mail when the sync point moved with no thread to show for it), and
   * new mail in the inbox: dated after the last look (less SKEW), not sent by you, not announced before.
   */
  async poll(watch: { history: string; at: number; guess?: boolean }): Promise<{ history: string; at: number; mailboxes: string[]; arrived: MailSummary[] }> {
    const r = await this.s(watch.history, 'fg', watch.guess ? 'bv' : 'ours');
    const at = this.now();
    const boxes = new Set<string>();
    const arrived: MailSummary[] = [];
    const items = this.items(r.rows);
    for (const x of items) {
      for (const b of SYSTEM) if (b.label ? x.m.labels.includes(b.label) : inAllMail(x.m.labels)) boxes.add(b.id);
      for (const l of x.m.labels) if (this.userLabels.has(l)) boxes.add(l);
      if (x.m.labels.includes(L.INBOX) && !x.m.labels.includes(L.SENT) && x.m.date > watch.at - SKEW && !this.announced.has(x.m.id)) arrived.push(this.summary(x, L.INBOX));
    }
    if (!items.length && r.history !== watch.history) for (const b of [L.INBOX, 'all']) boxes.add(b);
    arrived.sort((a, b) => a.receivedAt - b.receivedAt);
    const out = arrived.slice(-CATCH_UP);
    for (const m of out) this.announced.add(m.id);
    if (this.announced.size > 2000) this.announced = new Set([...this.announced].slice(-1000));
    return { history: r.history, at, mailboxes: [...boxes], arrived: out };
  }

  // ------------------------------------------------------------- status
  /** The 'Gmail protocol' layer: failed while an endpoint's last call failed its fingerprint (or answered an error). */
  layer(): { name: string; state: 'ok' | 'waiting' | 'failed'; note: string } {
    const name = 'Gmail protocol';
    const failed = ENDPOINTS.filter((e) => this.fp[e].last === false);
    if (failed.length) return { name, state: 'failed', note: failed.map((e) => `${e}: ${this.fp[e].note}`).join('; ') };
    const ok = ENDPOINTS.filter((e) => this.fp[e].last === true);
    if (ok.length) return { name, state: 'ok', note: `${ok.join(', ')} answered as expected${this.evidence.bvLayout ? ` (bv in its ${this.evidence.bvLayout} layout)` : ''}` };
    return { name, state: 'waiting', note: 'no mail call yet; each answer is checked against the layout Gmail was seen to use' };
  }
}

function count(c: Count | undefined): { unread: number | null; total: number | null } {
  const unread = c?.unread ?? null;
  const total = c && c.total !== null && (unread === null || c.total >= unread) ? c.total : null;
  return { unread, total };
}
