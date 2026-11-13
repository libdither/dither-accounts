/**
 * bugwatch's engine, without the manager: a scan reads what is new in every source, groups the records by fingerprint,
 * decides which are bugs (new, a spike, or an `always` match), raises a notice for each and starts a T3 thread for it
 * within the caps. main.ts drives it on a timer and answers `notifications` from it; cli.ts runs it once (--dry).
 *
 * A notice says only bugwatch's own words, the source's name, where, the error's name and its normalized message:
 * never a stack, a sample, a raw log line or anything else of a record (it goes on to phones). The brief, which stays
 * on this machine, carries the samples.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Notification, Urgency } from '@dither-accounts/interfaces';
import type { Config, Source } from './config.ts';
import { clip, fingerprint } from './normalize.ts';
import { expand, parseErrorsLine, parseSpanLine, parseTextLines, type Rec, tail } from './readers.ts';
import { type Bug, BUCKET_MS, countBetween, DAY, HOUR, prune, type Reason, type State } from './state.ts';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface Deps {
  now: () => number;
  /** Runs argv, never through a shell, with `stdin` as its input. */
  run: (argv: string[], stdin: string, timeoutMs: number) => Promise<RunResult>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** notify.new / notify.read. */
  emit: (ev: { t: string; [k: string]: unknown }) => void;
  /** The brief's template (brief.md). */
  briefTemplate: string;
}

/** A fingerprint not seen for this long is new again. */
export const NEW_AFTER = 14 * DAY;
export const SPIKE_MIN = 20;
export const SPIKE_FACTOR = 5;
export const THREAD_TIMEOUT_MS = 120_000;
export const SOURCE = 'bugwatch';
const RANK: Record<Reason, number> = { new: 3, always: 2, spike: 1 };
const KIND_ORDER = { 'errors-ndjson': 0, 'text-log': 1, 'trace-ndjson': 2 } as const;

export const noticeId = (bugId: string) => `bug:${bugId}`;
export const bugIdOf = (id: string) => id.replace(/^bug:/, '');
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface SourceHealth {
  files: number;
  records: number;
  error?: string;
}

export interface ScanResult {
  catchUp: boolean;
  records: number;
  raised: { bug: Bug; reason: Reason }[];
}

export class Watch {
  /** Trace ids an errors-ndjson record named lately: a failed span of the same trace is the same failure. */
  private traces = new Map<string, number>();
  private pumping: Promise<void> | null = null;
  readonly health = new Map<string, SourceHealth>();
  lastScanAt: number | null = null;
  /** How far back the first scan reads (the catch-up). */
  backlogMs = DAY;

  constructor(
    public cfg: Config,
    public st: State,
    private deps: Deps,
  ) {}

  private source(name: string): Source | undefined {
    return this.cfg.sources.find((s) => s.name === name);
  }

  // ---------------------------------------------------------------- scanning

  async scan(): Promise<ScanResult> {
    const now = this.deps.now();
    const catchUp = this.st.startedAt === null;
    const raised = new Map<string, Reason>();
    const touched = new Set<Bug>();
    const seenPaths = new Set<string>();
    let records = 0;
    for (const [t, at] of this.traces) if (at < now - HOUR) this.traces.delete(t);

    // A source new to the state (the first start, or one added to the config since) is read as a catch-up: the last
    // backlogMs of its files, its bugs listed and not announced. A file that appears later in a known source is new.
    const known = new Set(this.st.sources);
    const quiet = new Set<string>();
    const ok: string[] = [];
    let failed = false;
    for (const src of [...this.cfg.sources].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])) {
      const h: SourceHealth = { files: 0, records: 0 };
      const fresh = catchUp || !known.has(src.name);
      if (fresh) quiet.add(src.name);
      try {
        for (const path of expand(src.path)) {
          seenPaths.add(path);
          h.files++;
          for (const rec of this.read(src, path, fresh ? now - this.backlogMs : null, now)) {
            if (fresh && rec.at < now - this.backlogMs) continue;
            h.records++;
            records++;
            this.ingest(src, rec, raised, touched);
          }
        }
        ok.push(src.name);
      } catch (e) {
        failed = true;
        h.error = (e as Error).message;
        this.deps.log('warn', `source ${src.name}: ${h.error}`);
        if (known.has(src.name)) ok.push(src.name);
      }
      this.health.set(src.name, h);
    }
    this.st.sources = ok;
    // Where it is in files no source names now is forgotten, unless a source failed halfway (its files were not all seen).
    if (!failed) for (const p of Object.keys(this.st.files)) if (!seenPaths.has(p)) delete this.st.files[p];

    // Spikes: the last hour against the 7 days before it.
    for (const b of touched) {
      const lastHour = countBetween(b, now - HOUR, now + BUCKET_MS);
      const mean = countBetween(b, now - 7 * DAY - HOUR, now - HOUR) / (7 * 24);
      if (lastHour < Math.max(SPIKE_MIN, SPIKE_FACTOR * mean)) continue;
      if (b.lastSpikeAt && now - b.lastSpikeAt < this.cfg.spikeGapHours * HOUR) continue;
      b.lastSpikeAt = now;
      this.raise(b, 'spike', raised);
    }

    const out: ScanResult['raised'] = [];
    for (const [id, reason] of raised) {
      const b = this.st.bugs[id]!;
      b.notice = { at: now, reason, unread: true, ...(quiet.has(b.sourceName) ? { catchUp: true } : {}) };
      if (this.cfg.threads && !b.thread && b.queued === undefined && this.threadable(b)) {
        b.queued = now;
        b.dropped = false;
      }
      out.push({ bug: b, reason });
    }
    // A thread that may start now starts before its notice goes, so the notice can say so.
    await this.pump();
    for (const { bug } of out) {
      const q = quiet.has(bug.sourceName);
      this.deps.log('info', `bug ${bug.id} (${bug.notice!.reason}${q ? ', catch-up' : ''}): ${bug.count} so far`);
      // A catch-up's notices are listed, not announced: apps find them quietly (dither-chat's catch-up notifies nobody).
      if (!q) this.deps.emit({ t: 'notify.new', notification: this.notification(bug) });
    }
    this.st.startedAt ??= now;
    this.lastScanAt = now;
    prune(this.st, now);
    return { catchUp, records, raised: out };
  }

  /** What is new in one file, as records. */
  private read(src: Source, path: string, backlog: number | null, now: number): Rec[] {
    const was = this.st.files[path];
    const t = tail(path, was, backlog);
    const recs: Rec[] = [];
    if (!t.state) return recs;
    const state = { ...t.state };
    for (const chunk of t.chunks) {
      if (src.kind === 'errors-ndjson') {
        for (const l of chunk.lines) {
          const r = parseErrorsLine(l);
          if (!r) continue;
          if (r.trace) this.traces.set(r.trace, now);
          recs.push(r);
        }
      } else if (src.kind === 'trace-ndjson') {
        for (const l of chunk.lines) {
          const r = parseSpanLine(l);
          if (r && !(r.trace && this.traces.has(r.trace))) recs.push(r);
        }
      } else {
        const fallback = backlog !== null ? Math.min(now, chunk.mtime) : now;
        const p = parseTextLines(chunk.lines, fallback, chunk.current ? state.at : undefined, src.project);
        let got = p.recs;
        state.hold = false;
        if (chunk.current && p.openFrom !== null && !was?.hold && backlog === null) {
          // An error at the very end: its frames may still be coming. Leave it for the next scan, once.
          const k = p.openFrom;
          got = got.filter((_, i) => p.lines[i]! < k);
          state.offset = chunk.start + Buffer.byteLength(chunk.lines.slice(0, k).join('\n')) + (k > 0 ? 1 : 0);
          state.hold = true;
        }
        if (chunk.current) state.at = p.at;
        const where = basename(src.path);
        recs.push(...got.map((r) => ({ ...r, where })));
      }
    }
    this.st.files[path] = state;
    return recs;
  }

  private ignored(r: Rec): boolean {
    const texts = [r.where, r.name, r.message, `${r.name}: ${r.message}`];
    return this.cfg.ignore.some((re) => texts.some((t) => re.test(t)));
  }

  private ingest(src: Source, r: Rec, raised: Map<string, Reason>, touched: Set<Bug>) {
    if (this.ignored(r)) return;
    const fp = fingerprint({ sourceName: src.name, source: r.source, where: r.where, name: r.name, message: r.message, stack: r.stack }, src.project);
    let b = this.st.bugs[fp.id];
    const prevLast = b?.last;
    if (!b) {
      b = this.st.bugs[fp.id] = {
        id: fp.id,
        text: fp.text,
        sourceName: src.name,
        source: r.source,
        where: fp.where,
        name: clip(r.name, 80),
        message: fp.message,
        frame: fp.frame,
        first: r.at,
        last: r.at,
        count: 0,
        buckets: {},
        samples: [],
        crash: false,
      };
    }
    b.count += r.count;
    const k = String(Math.floor(r.at / BUCKET_MS));
    b.buckets[k] = (b.buckets[k] ?? 0) + r.count;
    b.first = Math.min(b.first, r.at);
    b.last = Math.max(b.last, r.at);
    if (r.source === 'uncaught') b.crash = true;
    // The first and the latest four.
    if (b.samples.length >= 5) b.samples.splice(1, 1);
    b.samples.push({ at: r.at, line: clip(`${r.name}: ${r.message}`, 300), frames: r.stack.slice(0, 10), ...(r.trace ? { trace: r.trace } : {}), ...(r.status !== undefined ? { status: r.status } : {}) });
    touched.add(b);

    if (prevLast === undefined || r.at - prevLast > NEW_AFTER) this.raise(b, 'new', raised);
    const rule = this.cfg.always.find((a) => a.match.test(`${r.source}/${r.where}`));
    if (rule && (!b.lastAlwaysAt || r.at - b.lastAlwaysAt >= rule.gapHours * HOUR)) {
      b.lastAlwaysAt = r.at;
      this.raise(b, 'always', raised);
    }
  }

  private raise(b: Bug, reason: Reason, raised: Map<string, Reason>) {
    if (b.muted) return;
    const was = raised.get(b.id);
    if (!was || RANK[reason] > RANK[was]) raised.set(b.id, reason);
  }

  // ---------------------------------------------------------------- threads

  private threadable(b: Bug) {
    const s = this.source(b.sourceName);
    return !!s?.project && !!s.base;
  }

  /** The queue, most frequent first; past queueMax the rest are left out (and say so). */
  queue(): Bug[] {
    return Object.values(this.st.bugs)
      .filter((b) => b.queued !== undefined && !b.muted && !b.thread)
      .sort((a, b) => b.count - a.count || a.queued! - b.queued!);
  }

  private trimQueue() {
    const max = this.cfg.threads?.queueMax ?? 10;
    for (const b of this.queue().slice(max)) {
      b.queued = undefined;
      b.dropped = true;
    }
  }

  /** May a thread start now: none in the last gapMinutes, fewer than dayMax in the last 24 h. */
  canStart(now = this.deps.now()): boolean {
    const t = this.cfg.threads;
    if (!t) return false;
    if (now - this.st.lastThreadTry < t.gapMinutes * 60_000) return false;
    return this.st.threadStarts.filter((s) => s > now - DAY).length < t.dayMax;
  }

  /** Start the queue's first thread if the caps allow (one at a time), then keep the queue to queueMax. */
  async pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const p = (async () => {
      const next = this.queue()[0];
      if (next && this.canStart()) await this.startThread(next);
      this.trimQueue();
    })();
    this.pumping = p;
    try {
      await p;
    } finally {
      if (this.pumping === p) this.pumping = null;
    }
  }

  threadTitle(b: Bug) {
    return clip(`Bug: ${this.title(b)}`, 100);
  }

  /** The thread command's argv for a bug, never through a shell. */
  argv(b: Bug, title = this.threadTitle(b)): string[] {
    const s = this.source(b.sourceName)!;
    return this.cfg.threads!.command.map((a) => a.replaceAll('{title}', title).replaceAll('{project}', s.project ?? '').replaceAll('{base}', s.base ?? ''));
  }

  private async startThread(b: Bug) {
    const now = this.deps.now();
    const src = this.source(b.sourceName);
    b.queued = undefined;
    if (!src?.project || !src.base) return;
    const title = this.threadTitle(b);
    this.st.lastThreadTry = now;
    let r: RunResult;
    try {
      r = await this.deps.run(this.argv(b, title), this.brief(b), THREAD_TIMEOUT_MS);
    } catch (e) {
      r = { code: null, stdout: '', stderr: (e as Error).message };
    }
    const id = r.code === 0 ? parseThreadId(r.stdout) : null;
    if (r.code === 0) {
      b.thread = { title, at: now, ...(id ? { id } : {}) };
      this.st.threadStarts.push(now);
      this.deps.log('info', `thread started for bug ${b.id}: ${id ?? '(its output named no thread id)'}`);
    } else {
      const how = r.timedOut ? 'it timed out' : r.code === null ? 'it could not run' : `exit code ${r.code}`;
      b.thread = { title, at: now, failed: how };
      const said = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
      this.deps.log('error', `starting a thread for bug ${b.id} failed (${how})${said ? `; it said: ${clip(said, 300)}` : ''}`);
    }
  }

  /** The brief a thread gets on stdin: the template filled in, then each `briefs` addendum whose match fits. */
  brief(b: Bug): string {
    const s = this.source(b.sourceName);
    const now = this.deps.now();
    const lastHour = countBetween(b, now - HOUR, now + BUCKET_MS);
    const hourly = countBetween(b, now - 7 * DAY - HOUR, now - HOUR) / (7 * 24);
    const samples = b.samples
      .map((x) => ['```', `${new Date(x.at).toISOString()}  ${x.line}${x.status !== undefined ? `  (status ${x.status})` : ''}${x.trace ? `  trace ${x.trace}` : ''}`, ...x.frames.map((f) => `    ${f}`), '```'].join('\n'))
      .join('\n\n');
    const trace = [...b.samples].reverse().find((x) => x.trace)?.trace;
    const data = s?.data ?? (s ? (s.path.includes('/traces/') ? s.path.slice(0, s.path.lastIndexOf('/traces/')) : dirname(s.path)) : '');
    const how = trace
      ? `The latest record's trace is \`${trace}\`. In a dither-chat checkout, \`bun scripts/trace-summary.ts --data ${data} --since all --trace ${trace}\` shows it as a tree (pass the accounts manager's data directory as \`--accounts-data\` for its spans).`
      : `No trace id came with these records. In a dither-chat checkout, \`bun scripts/trace-summary.ts --data ${data} --since all --failed\` lists the failed spans around them.`;
    const values: Record<string, string> = {
      title: this.title(b),
      id: b.id,
      fingerprint: b.text,
      source: b.sourceName,
      sourceKind: b.source,
      where: b.where,
      file: s?.path ?? '(not in the config any more)',
      reason: b.notice?.reason === 'spike' ? 'a spike' : b.notice?.reason === 'always' ? 'a kind it reports every time' : 'not seen in the 14 days before',
      count: String(b.count),
      first: when(b.first),
      last: when(b.last),
      lastHour: String(lastHour),
      hourly: hourly.toFixed(1),
      project: s?.project ?? '',
      base: s?.base ?? '',
      samples,
      trace: how,
    };
    let out = this.deps.briefTemplate.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
    for (const a of this.cfg.briefs) {
      if (!a.match.test(b.text)) continue;
      try {
        out += `\n\n${readFileSync(a.file, 'utf8').trim()}\n`;
      } catch (e) {
        this.deps.log('warn', `brief addendum ${a.file} does not read: ${(e as Error).message}`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- notices

  title(b: Bug) {
    return clip(`${b.sourceName}: ${b.name}: ${b.message}`, 120);
  }

  private threadLine(b: Bug): string {
    const t = this.cfg.threads;
    if (b.thread?.failed) return `Starting a T3 thread failed (${b.thread.failed}): the bugwatch account's log says more.`;
    if (b.thread) return b.notice && b.notice.at > b.thread.at + 60_000 ? `A T3 thread already looked into it (${b.thread.title}).` : `A T3 thread is looking into it (${b.thread.title}).`;
    if (b.queued !== undefined && t) return `A T3 thread will start when the limits allow (one every ${plural(t.gapMinutes, 'minute')}, ${t.dayMax} a day).`;
    if (!t) return 'No T3 thread: threads are not set up in the config.';
    if (!this.threadable(b)) return 'No T3 thread: its source names no project and base.';
    if (b.dropped) return 'No T3 thread: more bugs were waiting than the queue keeps, each seen more often.';
    return 'No T3 thread.';
  }

  /** A bug as a Notification: bugwatch's words, the source, where, the error's name and normalized message only. */
  notification(b: Bug): Notification {
    const now = this.deps.now();
    const n = b.notice ?? { at: b.last, reason: 'new' as Reason, unread: false };
    let seen = `${b.where}: ${plural(b.count, 'time')} since ${when(b.first)}`;
    if (n.reason === 'spike') {
      const lastHour = countBetween(b, now - HOUR, now + BUCKET_MS);
      const mean = countBetween(b, now - 7 * DAY - HOUR, now - HOUR) / (7 * 24);
      seen += `, ${lastHour} in the last hour against about ${mean.toFixed(1)} an hour over the week before`;
    }
    const urgency: Urgency = b.crash ? 'high' : 'normal';
    return {
      id: noticeId(b.id),
      source: SOURCE,
      title: this.title(b),
      body: clip(`${seen}. ${this.threadLine(b)}`, 600),
      url: null,
      reason: n.reason,
      context: b.sourceName,
      subject: { kind: 'bug', title: clip(`${b.name}: ${b.message}`, 200), url: null, state: b.thread?.failed ? 'thread-failed' : b.thread ? 'thread' : b.queued !== undefined ? 'queued' : 'no-thread' },
      actors: [],
      at: n.at,
      unread: n.unread,
      urgency,
    };
  }

  /** Every bug with a notice (not muted), newest first. */
  notices(): Bug[] {
    return Object.values(this.st.bugs)
      .filter((b) => b.notice && !b.muted)
      .sort((a, b) => b.notice!.at - a.notice!.at || (a.id < b.id ? -1 : 1));
  }

  list(o: { unreadOnly?: boolean; since?: number; limit?: number; pageToken?: string }) {
    const all = this.notices().filter((b) => (!o.unreadOnly || b.notice!.unread) && (o.since === undefined || b.notice!.at >= o.since));
    const from = o.pageToken ? Math.max(0, Number(o.pageToken) || 0) : 0;
    const limit = Math.min(200, Math.max(1, Math.floor(o.limit ?? 50) || 50));
    const page = all.slice(from, from + limit);
    return { notifications: page.map((b) => this.notification(b)), next: from + limit < all.length ? String(from + limit) : null };
  }

  /** Read: acknowledged. A read fingerprint is announced again only on a spike (or an `always` rule's next turn). */
  markRead(ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const b = this.st.bugs[bugIdOf(id)];
      if (b?.notice?.unread) {
        b.notice.unread = false;
        out.push(noticeId(b.id));
      }
    }
    if (out.length) this.deps.emit({ t: 'notify.read', ids: out });
    return out;
  }

  markAllRead(before?: number): string[] {
    return this.markRead(this.notices().filter((b) => b.notice!.unread && (before === undefined || b.notice!.at <= before)).map((b) => noticeId(b.id)));
  }

  /** No more notices or threads for this fingerprint, until cleared. */
  mute(id: string): boolean {
    const b = this.st.bugs[bugIdOf(id)];
    if (!b) return false;
    this.markRead([noticeId(b.id)]);
    b.muted = true;
    b.queued = undefined;
    return true;
  }

  /**
   * The owner clears a fingerprint: it may get a thread again (and unmuted). One whose notice is still unread waits
   * for a thread now.
   */
  clear(id: string): boolean {
    const b = this.st.bugs[bugIdOf(id)];
    if (!b) return false;
    b.thread = undefined;
    b.dropped = false;
    b.muted = false;
    if (b.notice?.unread && this.cfg.threads && this.threadable(b)) b.queued = this.deps.now();
    return true;
  }
}

/** The thread id in the thread command's JSON output (`t3 thread start --json` prints `{ threadId, runId }`). */
export function parseThreadId(stdout: string): string | null {
  const tries = [stdout.trim(), ...stdout.trim().split('\n').reverse()];
  for (const t of tries) {
    try {
      const j = JSON.parse(t) as Record<string, any>;
      const id = j?.threadId ?? j?.thread?.id ?? j?.id;
      if (typeof id === 'string' && /^[\w:.-]{1,200}$/.test(id)) return id;
    } catch {}
  }
  return null;
}
