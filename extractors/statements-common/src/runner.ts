/**
 * What every finance extractor shares (docs/statements.md): the `statements` ops over a spool, one pull at a time,
 * and the daily pull. The kind brings `pull` (talk to its institution, add files to the spool) and `accounts`.
 *
 * The daily pull is at `pullAt` (config, "HH:MM" local, default 05:30) plus a jitter of up to `jitterMinutes`
 * (default 20) that is fixed per account and day, so a restart does not move it. Like a systemd timer with
 * Persistent=true, a start that finds the last pull older than the last slot pulls at once; an account that never
 * pulled waits for its first slot or a statements.refresh. A failed daily pull is tried again hourly, three times.
 * `schedule: false` in the config turns the daily pull off (statements.refresh still works).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatementAccount, StatementFile, StatementsPulled } from '@dither-accounts/interfaces';
import { StatusError, type Command, type Link } from '@dither-accounts/link';
import { Spool, writeWhole } from './spool.ts';

export interface RefreshOpts {
  full?: boolean;
  since?: number;
  details?: number;
  days?: number;
}
export interface PullOutcome {
  saved: number;
  skipped?: 'signed-out' | 'unchanged';
}
/** Thrown by a pull for something only you can fix (a revoked access URL): the account shows it as attention. */
export class NeedsYou extends Error {
  constructor(
    message: string,
    readonly kind: string = 'login',
  ) {
    super(message);
  }
}

interface PullState {
  lastPullAt: number | null;
  lastOk: boolean | null;
  lastSaved: number | null;
  lastSkipped: string | null;
  /** The last failure's message (never a secret: pulls throw messages written for this). */
  lastError: string | null;
  needs: { kind: string; message: string } | null;
  retries: number;
}

export interface RunnerOpts {
  link: Link;
  pull: (opts: RefreshOpts, why: Why) => Promise<PullOutcome>;
  accounts: () => StatementAccount[];
  /** Why a pull cannot start now (not signed in, no secret), or null. */
  blocked?: () => string | null;
  /** Something changed that the status shows. */
  onChange?: () => void;
  now?: () => number;
}

const DAY = 24 * 3600_000;
/** What started a pull: the daily slot, statements.refresh, a missed slot, a retry, or the kind itself (Venmo pulls
 * right after you sign in). */
export type Why = 'daily' | 'refresh' | 'catch-up' | 'retry' | 'sign-in';

export class StatementsRunner {
  readonly spool: Spool;
  st: PullState;
  pulling: { since: number; why: string } | null = null;
  nextAt: number | null = null;
  private timer: Timer | null = null;
  private stopped = false;
  private file: string;
  private now: () => number;

  constructor(private o: RunnerOpts) {
    this.now = o.now ?? Date.now;
    this.spool = new Spool(o.link.accountDir, (file: StatementFile) => o.link.emit({ t: 'statements.file', file }), this.now);
    this.file = join(o.link.accountDir, 'pulls.json');
    const empty: PullState = { lastPullAt: null, lastOk: null, lastSaved: null, lastSkipped: null, lastError: null, needs: null, retries: 0 };
    let st = empty;
    try {
      if (existsSync(this.file)) st = { ...empty, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch {}
    this.st = st;
  }

  private save() {
    writeWhole(this.file, JSON.stringify(this.st));
  }
  private changed() {
    this.o.onChange?.();
  }

  get config() {
    const c = this.o.link.config ?? {};
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(c.pullAt ?? '05:30'));
    const h = m ? Math.min(23, Number(m[1])) : 5;
    const min = m ? Math.min(59, Number(m[2])) : 30;
    const jitter = Math.max(0, Math.min(180, Number(c.jitterMinutes ?? 20) || 0));
    return { h, min, jitter, scheduled: c.schedule !== false && c.schedule !== 'false' };
  }

  /** This account's slot on the local day that contains `t`. */
  slotOn(t: number): number {
    const { h, min, jitter } = this.config;
    const d = new Date(t);
    d.setHours(h, min, 0, 0);
    const key = `${this.o.link.accountId}:${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const r = new Bun.CryptoHasher('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
    return d.getTime() + Math.floor(r * jitter * 60_000);
  }
  /** The last slot at or before now, and the first after it. */
  slots(now = this.now()) {
    const today = this.slotOn(now);
    const prev = today <= now ? today : this.slotOn(now - DAY);
    const next = today > now ? today : this.slotOn(now + DAY);
    return { prev, next };
  }

  start() {
    if (!this.config.scheduled) {
      this.nextAt = null;
      return;
    }
    const { prev } = this.slots();
    if (this.st.lastPullAt !== null && this.st.lastPullAt < prev) {
      // Missed a slot while down (Persistent=true): pull shortly after start.
      this.arm(this.now() + 5_000, 'catch-up');
    } else this.arm(this.slots().next, 'daily');
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private arm(at: number, why: 'daily' | 'catch-up' | 'retry') {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = at;
    this.changed();
    const wait = Math.max(0, at - this.now());
    // At most an hour at a time, so a suspended machine or a clock change does not leave the pull far off.
    this.timer = setTimeout(
      () => {
        if (this.now() < at - 1000) return this.arm(at, why);
        void this.run({}, why).then((r) => {
          const failed = !r.ok && !this.st.needs;
          if (failed && why !== 'catch-up' && this.st.retries < 3) {
            this.st.retries++;
            this.save();
            this.arm(this.now() + 3600_000, 'retry');
          } else {
            if (this.st.retries) {
              this.st.retries = 0;
              this.save();
            }
            this.arm(this.slots().next, 'daily');
          }
        });
      },
      Math.min(wait, 3600_000),
    );
  }

  /** Start a pull unless one runs or the account cannot; the result comes through statements.pulled. */
  refresh(opts: RefreshOpts, why: Why = 'refresh'): { started: boolean; reason?: string } {
    if (this.pulling) return { started: false, reason: `a pull is running (since ${new Date(this.pulling.since).toISOString()})` };
    const b = this.o.blocked?.();
    if (b) return { started: false, reason: b };
    void this.run(opts, why);
    return { started: true };
  }

  private async run(opts: RefreshOpts, why: Why): Promise<StatementsPulled> {
    if (this.pulling) return { ok: false, saved: 0, needs: 'a pull is running' };
    const b = this.o.blocked?.();
    if (b) {
      const ev: StatementsPulled = { ok: false, saved: 0, needs: b };
      this.o.link.emit({ t: 'statements.pulled', ...ev });
      return ev;
    }
    this.pulling = { since: this.now(), why };
    this.changed();
    const seq0 = this.spool.seq;
    let ev: StatementsPulled;
    try {
      const r = await this.o.pull(opts, why);
      ev = { ok: true, saved: r.saved, ...(r.skipped ? { skipped: r.skipped } : {}) };
      this.st = { ...this.st, lastPullAt: this.now(), lastOk: true, lastSaved: r.saved, lastSkipped: r.skipped ?? null, lastError: null, needs: null };
    } catch (e) {
      const err = e as Error;
      const needs = err instanceof NeedsYou ? { kind: err.kind, message: err.message } : null;
      ev = { ok: false, saved: this.spool.seq - seq0, needs: err.message };
      this.st = { ...this.st, lastPullAt: this.now(), lastOk: false, lastSaved: this.spool.seq - seq0, lastSkipped: null, lastError: err.message, needs };
      this.o.link.log('warn', `pull failed (${why})`, { error: err.message });
    } finally {
      this.pulling = null;
    }
    this.save();
    this.o.link.emit({ t: 'statements.pulled', ...ev });
    this.changed();
    return ev;
  }

  /** The `statements` ops; undefined for anything else. */
  handle(cmd: Command): unknown | undefined {
    const i = cmd as Record<string, any>;
    switch (cmd.t) {
      case 'statements.list':
        return this.spool.list(Number.isInteger(i.after) ? i.after : 0, Number.isInteger(i.limit) ? i.limit : 100);
      case 'statements.fetch':
        if (typeof i.id !== 'string') throw new StatusError('id is required', 400);
        return this.spool.fetch(i.id);
      case 'statements.ack':
        if (!Number.isInteger(i.through)) throw new StatusError('through is a seq', 400);
        return this.spool.ack(i.through);
      case 'statements.refresh':
        return this.refresh({ full: i.full, since: i.since, details: i.details, days: i.days });
      case 'statements.accounts':
        return { accounts: this.o.accounts() };
    }
    return undefined;
  }

  /** Flat facts for the status's details. */
  details(): Record<string, unknown> {
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    return {
      pulling: this.pulling ? `${this.pulling.why} since ${iso(this.pulling.since)}` : null,
      lastPullAt: iso(this.st.lastPullAt),
      lastPullOk: this.st.lastOk,
      lastPullSaved: this.st.lastSaved,
      lastPullSkipped: this.st.lastSkipped,
      lastPullError: this.st.lastError,
      nextPullAt: this.config.scheduled ? iso(this.nextAt) : 'off (statements.refresh only)',
      spoolSeq: this.spool.seq,
      spoolAcked: this.spool.acked,
      spoolWaiting: this.spool.pending,
    };
  }
  /** The last layer every finance kind ends with: how the last pull went. */
  pullLayer(): { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string } {
    if (this.pulling) return { name: 'pull', state: 'waiting', note: `pulling (${this.pulling.why})` };
    if (this.st.lastOk === null) return { name: 'pull', state: 'waiting', note: this.nextAt ? `first pull ${new Date(this.nextAt).toLocaleString()}` : 'no pull yet' };
    if (!this.st.lastOk) return { name: 'pull', state: 'failed', note: this.st.lastError ?? 'failed' };
    return { name: 'pull', state: 'ok', note: `${this.st.lastSaved} file(s) at ${new Date(this.st.lastPullAt!).toLocaleString()}` };
  }
}
