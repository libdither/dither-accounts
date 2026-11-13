/**
 * The manager's own notices (docs/notifications.md): a built-in account, kind `notices`, that says when your accounts
 * need you, through the same `notifications` interface GitHub and Telegram Desktop speak. It is never a process: the
 * router answers its operations here, and its events go out through Router.event like any extractor's, so grants,
 * buffering and gaps apply unchanged.
 *
 * What it says, each under an id stable per account and condition (`attention:<account>`), so a repeat replaces:
 * - an account whose status keeps an `attention` for 2 minutes (`high`), read again when the attention goes;
 * - an enabled account that is not running, with an error, for 5 minutes (`high`), read again when it runs;
 * - a passkey approval asked of a device that is not paired here (`high`);
 * - an extractor that crashed 3 times in 10 minutes (`normal`), read again after 10 quiet minutes.
 * One id is announced at most once per 30 minutes (a flapping account), and not while its account is muted (24 h).
 *
 * Only the manager's own words and the account's label and kind: never an extractor's text (an attention's message can
 * carry a password hint, a code or a raw error), so a body says what the attention's kind means. Never secrets or
 * account data.
 * The last 200 are kept in the registry (table `notice`).
 */
import { type Notification, notifications, type Urgency } from '@dither-accounts/interfaces';
import { accountDir, type Supervisor } from './supervisor.ts';
import { newToken, type Row, type Store } from './db.ts';
import { type Kind, kindOf } from './kinds.ts';
import { CallFailure, type Router } from './router.ts';

export const NOTICES_ID = 'notices';
export const NOTICES_KIND = 'notices';
export const NOTICES_LABEL = 'dither-accounts';
/** How many notices are kept. */
export const KEEP = 200;

export interface NoticeTimes {
  /** An attention held this long is announced. */
  attentionMs: number;
  /** An enabled account not running with an error this long is announced. */
  stoppedMs: number;
  /** One id is announced at most once in this long. */
  debounceMs: number;
  /** notify.mute keeps an account quiet this long. */
  muteMs: number;
  /** Crashes counted in this window… */
  crashWindowMs: number;
  /** …this many announce it. */
  crashes: number;
  /** How often conditions are looked at. */
  sweepMs: number;
}
export const NOTICE_TIMES: NoticeTimes = {
  attentionMs: 2 * 60_000,
  stoppedMs: 5 * 60_000,
  debounceMs: 30 * 60_000,
  muteMs: 24 * 3_600_000,
  crashWindowMs: 10 * 60_000,
  crashes: 3,
  sweepMs: 15_000,
};

/** The built-in kind: no directory, no entry, never started. */
export function noticesKind(): Kind {
  return { ...kindOf({ kind: NOTICES_KIND, name: NOTICES_LABEL, interfaces: [notifications.name], entry: '' }, ''), builtin: true };
}

type Cond = 'attention' | 'stopped' | 'crashing' | 'no-device';

interface Episode {
  since: number;
  /** Announced (or found unread from before) in this episode. */
  emitted: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '');
/** An account's label as a notice names it: one line, short (an app that manages accounts sets labels). */
const named = (a: Row) => clip(oneLine(a.label), 80) || String(a.kind);

/**
 * What a notice says of an account that needs you, by its attention's kind. Never the extractor's own message: it can
 * carry a password hint (Telegram's two-step), a pairing or login code, a phone number, or a raw error, and a notice
 * goes to apps and on to phones.
 */
const NEEDS: Record<string, string> = {
  login: 'It needs you to sign in again: open its page on the manager.',
  verify: 'It asks you to confirm a sign-in: open its page on the manager.',
  link_device: 'It waits to be linked with your phone: open its page on the manager.',
};
/** Statuses that mean the account waits on you; others with an attention (connecting, offline) are passing. */
const NEEDS_YOU = new Set(['attention', 'error']);

export class Notices {
  private times: NoticeTimes;
  private episodes = new Map<string, Episode>();
  private crashes = new Map<string, number[]>();
  private timer?: Timer;
  private poked = false;
  private on = false;

  constructor(
    private store: Store,
    private router: Router,
    private sup: Supervisor,
    private opts: { dataDir: string; publicUrl: string | null; times?: Partial<NoticeTimes> },
  ) {
    this.times = { ...NOTICE_TIMES, ...opts.times };
  }

  /** Makes the account if it is missing, answers its operations, says it is online, and starts looking. */
  start() {
    const had = this.store.account(NOTICES_ID);
    if (had && had.kind !== NOTICES_KIND) {
      console.error(`[notices] account "${NOTICES_ID}" is a ${had.kind} account: the manager's notices are off`);
      return;
    }
    if (!had) {
      const now = Date.now();
      this.store.run(
        'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
        NOTICES_ID,
        NOTICES_KIND,
        NOTICES_LABEL,
        '{}',
        newToken(),
        accountDir(this.opts.dataDir, NOTICES_ID),
        now,
        now,
      );
    } else if (!had.enabled) this.store.run('UPDATE account SET enabled = 1 WHERE id = ?', NOTICES_ID);
    this.on = true;
    this.sup.inProcess.add(NOTICES_ID);
    this.router.inProcess.set(NOTICES_ID, (op, input) => this.handle(op, input));
    this.router.event(NOTICES_ID, { t: 'hello', version: '1', label: NOTICES_LABEL, builtin: true });
    this.router.event(NOTICES_ID, { t: 'status', status: 'online' });
    // A notice from before a restart, unread or read, is this episode's: it is not announced again while its
    // condition holds (a condition gone ends the episode, and a new one is announced).
    for (const r of this.store.all<{ id: string; at: number }>("SELECT id, at FROM notice WHERE reason != 'no-device'")) this.episodes.set(r.id, { since: r.at, emitted: true });
    this.timer = setInterval(() => this.check(), this.times.sweepMs);
  }

  stop() {
    clearInterval(this.timer);
    this.on = false;
  }

  /** Something changed (a status, a process): look soon rather than at the next sweep. */
  poke() {
    if (!this.on || this.poked) return;
    this.poked = true;
    setTimeout(() => {
      this.poked = false;
      this.check();
    }, 0);
  }

  /** An extractor's process ended and is being started again. */
  crashed(accountId: string) {
    if (!this.on || accountId === NOTICES_ID) return;
    const now = Date.now();
    const list = (this.crashes.get(accountId) ?? []).filter((t) => now - t < this.times.crashWindowMs);
    list.push(now);
    this.crashes.set(accountId, list);
    this.poke();
  }

  /** A passkey approval was asked of a device that is not paired here (approvers.ts, outcome no-device). */
  noDevice(accountId: string, rpId: string, op: 'create' | 'get') {
    if (!this.on) return;
    const a = this.store.account(accountId);
    if (!a) return;
    const id = `no-device:${a.id}`;
    if (this.muted(a.id) || !this.due(id, Date.now())) return;
    const what = op === 'create' ? 'A new passkey' : 'A sign-in';
    this.emit(id, a, 'no-device', 'high', `${named(a)}: no device for a passkey approval`, `${what} for ${clip(oneLine(rpId), 100)} asked for approval on a device that is not paired with this manager.`);
  }

  // ---------------------------------------------------------------- conditions

  /** Each account's conditions as they are now: announced once held long enough, read again once gone. */
  check() {
    if (!this.on) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const a of this.store.accounts()) {
      if (a.id === NOTICES_ID) continue;
      for (const cond of ['attention', 'stopped', 'crashing'] as const) {
        const id = `${cond}:${a.id}`;
        seen.add(id);
        const v = this.condition(cond, a, now);
        if (v === null) continue;
        if (v === false) {
          this.clear(id);
          continue;
        }
        const ep = this.episodes.get(id) ?? this.episodes.set(id, { since: now, emitted: false }).get(id)!;
        if (ep.emitted || now - ep.since < v.holdMs || this.muted(a.id) || !this.due(id, now)) continue;
        ep.emitted = true;
        this.emit(id, a, cond, v.urgency, v.title, v.body);
      }
    }
    // An account that is gone: what it had said no longer holds.
    for (const r of this.store.all<{ id: string; reason: string }>('SELECT id, reason FROM notice WHERE unread = 1')) if (!seen.has(r.id) && r.reason !== 'no-device') this.clear(r.id);
    for (const id of [...this.episodes.keys()]) if (!seen.has(id)) this.episodes.delete(id);
    for (const [id, list] of this.crashes) if (!list.some((t) => now - t < this.times.crashWindowMs)) this.crashes.delete(id);
  }

  /**
   * Whether a condition holds for an account: what to announce when it does, false when it surely does not, null when
   * it cannot be told (an account's status is unknown while its extractor is not connected).
   */
  private condition(cond: Exclude<Cond, 'no-device'>, a: Row, now: number): { holdMs: number; urgency: Urgency; title: string; body: string } | false | null {
    if (!a.enabled) return false;
    const st = this.sup.state(a.id);
    if (cond === 'attention') {
      const status = this.router.lastStatus(a.id);
      const at = status?.attention as { kind?: unknown } | undefined;
      // An attention beside a passing state (connecting, offline: "trying again in 30 s") is an outage, not you.
      if (at && typeof at === 'object' && NEEDS_YOU.has(String(status?.status))) {
        const body = NEEDS[String(at.kind)] ?? (status?.status === 'error' ? 'It reports an error: open its page on the manager.' : 'It needs you: open its page on the manager.');
        return { holdMs: this.times.attentionMs, urgency: 'high', title: `${named(a)} needs you`, body };
      }
      if (at && typeof at === 'object') return false;
      return st.online && status ? false : null;
    }
    if (cond === 'stopped') {
      if (!st.running && st.error) return { holdMs: this.times.stoppedMs, urgency: 'high', title: `${named(a)} stopped`, body: 'It is not running: its page on the manager says why.' };
      return st.running ? false : null;
    }
    const n = (this.crashes.get(a.id) ?? []).filter((t) => now - t < this.times.crashWindowMs).length;
    if (n >= this.times.crashes) return { holdMs: 0, urgency: 'normal', title: `${named(a)} keeps restarting`, body: `Its extractor ended and was started again ${n} times in ${Math.round(this.times.crashWindowMs / 60_000)} minutes; its log on the manager says why.` };
    return false;
  }

  private muted(accountId: string): boolean {
    return !!this.store.one('SELECT 1 FROM notice_mute WHERE subject = ? AND until > ?', accountId, Date.now());
  }

  /** Not announced within the debounce window. */
  private due(id: string, now: number): boolean {
    const r = this.store.one<{ emitted_at: number }>('SELECT emitted_at FROM notice WHERE id = ?', id);
    return !r || now - r.emitted_at >= this.times.debounceMs;
  }

  private emit(id: string, a: Row, cond: Cond, urgency: Urgency, title: string, body: string) {
    const now = Date.now();
    const url = this.opts.publicUrl ? `${this.opts.publicUrl}/#/accounts/${encodeURIComponent(a.id)}` : null;
    const n: Notification = {
      id,
      source: NOTICES_LABEL,
      title: clip(title, 200),
      body,
      url,
      reason: cond,
      context: a.kind,
      subject: { kind: 'account', title: named(a), url, state: cond },
      actors: [],
      at: now,
      unread: true,
      urgency,
    };
    this.store.run(
      `INSERT INTO notice (id, subject, reason, notification, at, unread, emitted_at) VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, reason = excluded.reason, notification = excluded.notification, at = excluded.at, unread = 1, emitted_at = excluded.emitted_at`,
      id,
      a.id,
      cond,
      JSON.stringify(n),
      now,
      now,
    );
    this.store.run('DELETE FROM notice WHERE id NOT IN (SELECT id FROM notice ORDER BY at DESC LIMIT ?)', KEEP);
    this.router.event(NOTICES_ID, { t: 'notify.new', notification: n });
  }

  /** The condition is gone: its episode ends, and an unread notice about it is read. */
  private clear(id: string) {
    this.episodes.delete(id);
    this.read([id]);
  }

  /** Marks these read; those that were unread go out as notify.read. */
  private read(ids: string[]) {
    const was = ids.filter((id) => this.store.one('SELECT 1 FROM notice WHERE id = ? AND unread = 1', id));
    if (!was.length) return;
    for (const id of was) this.store.run('UPDATE notice SET unread = 0 WHERE id = ?', id);
    this.router.event(NOTICES_ID, { t: 'notify.read', ids: was });
  }

  // ---------------------------------------------------------------- operations

  /** The `notifications` operations, answered here (the router's last handler, instead of an extractor). */
  async handle(op: string, input: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'notify.list': {
        const limit = Math.min(KEEP, Math.max(1, Number(input.limit) || 50));
        const token = typeof input.pageToken === 'string' ? input.pageToken : null;
        if (token !== null && !/^\d{1,4}$/.test(token)) throw new CallFailure({ code: 'invalid', message: 'that pageToken is not one notify.list gave' });
        const offset = token ? Number(token) : 0;
        const where: string[] = [];
        const params: unknown[] = [];
        if (input.unreadOnly === true) where.push('unread = 1');
        if (typeof input.since === 'number') {
          where.push('at >= ?');
          params.push(input.since);
        }
        const rows = this.store.all<{ notification: string; unread: number }>(`SELECT notification, unread FROM notice ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id LIMIT ? OFFSET ?`, ...params, limit + 1, offset);
        const list = rows.slice(0, limit).map((r) => ({ ...(JSON.parse(r.notification) as Notification), unread: !!r.unread }));
        return { notifications: list, next: rows.length > limit ? String(offset + limit) : null };
      }
      case 'notify.markRead':
        this.read((input.ids as string[]).filter((x) => typeof x === 'string'));
        return {};
      case 'notify.markAllRead': {
        const before = typeof input.before === 'number' ? input.before : Date.now();
        this.read(this.store.all<{ id: string }>('SELECT id FROM notice WHERE unread = 1 AND at <= ?', before).map((r) => r.id));
        return {};
      }
      case 'notify.mute': {
        const r = this.store.one<{ subject: string }>('SELECT subject FROM notice WHERE id = ?', String(input.id));
        if (!r) throw new CallFailure({ code: 'invalid', message: `no notice ${String(input.id).slice(0, 100)}`, status: 404 });
        this.store.run('INSERT INTO notice_mute (subject, until) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET until = excluded.until', r.subject, Date.now() + this.times.muteMs);
        this.store.run('DELETE FROM notice_mute WHERE until <= ?', Date.now());
        return {};
      }
    }
    throw new CallFailure({ code: 'unknown-op', message: `the manager's notices have no operation "${op}"` });
  }
}
