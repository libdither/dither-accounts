/**
 * The router: apps' calls go through a stack of handlers to the account's extractor, and the extractor's events go
 * out to the apps whose grants cover them.
 *
 * A call runs `grant → input → limit → audit → dryRun → extractor`. Each is a handler in the effect sense: it may
 * answer the call itself or pass it on, so a dry-run grant answers writes without them reaching the network, and a
 * fake extractor stands in for a real one without the app knowing.
 *
 * The manager routes and keeps nothing it hears. While an app is away (restarting, deploying), its events wait in
 * memory, bounded by count and size and gone when the manager stops; past the bound they are dropped and the app gets
 * a `gap` for that account, so it can ask the account to start over. The last `hello` and `status` of each account
 * are kept, since they are the account's state rather than its data.
 */
import type { ServerWebSocket } from 'bun';
import { isAbsolute } from 'node:path';
import { type AccountView, type AdminAction, type CallError, type ConsumerIn, type ConsumerOut, covers, type Iface, type Level, levelRank } from '@dither-accounts/spec';
import { accountDir, ExtractorError, releaseLock, type Supervisor, writeSecret } from './supervisor.ts';
import { type GrantRow, newId, newToken, type Row, type Store } from './db.ts';
import { logTail, purgeDir } from './files.ts';
import type { Kind } from './kinds.ts';
import { parseTraceparent, Span } from './trace.ts';

export interface ConsumerSocketData {
  kind: 'consumer';
  appId: string;
}

export interface Call {
  app: Row;
  account: Row;
  kind: Kind;
  iface: Iface;
  op: string;
  level: Level;
  input: Record<string, unknown>;
  grant: { level: Level; dryRun: boolean };
  /** The call's span (trace.ts): its traceparent goes to the extractor with the command. */
  span?: Span;
}
export type Next = (c: Call) => Promise<unknown>;
export type Handler = (c: Call, next: Next) => Promise<unknown>;

export class CallFailure extends Error {
  constructor(readonly error: CallError) {
    super(error.message);
  }
}
const fail = (code: CallError['code'], message: string, status?: number): never => {
  throw new CallFailure({ code, message, ...(status !== undefined ? { status } : {}) });
};

/** The manager's own page, as the app its calls are counted under. */
export const PAGE_APP: Row = { id: 'page', name: 'This page' };

/** Token buckets per app, account and level: [per second, burst]. */
export const LIMITS: Record<Level, [number, number]> = { read: [50, 1000], write: [5, 100], manage: [2, 20] };
/** How much of an absent app's events wait for it (tests shrink it). */
export const BUFFER = { events: 100_000, bytes: 64 * 1024 * 1024 };

/**
 * An extractor's event as apps get it: a status's live view keeps only its size, so the app still knows there is one,
 * and never where it listens (a Unix socket on this machine, or a port from an older extractor; an app that runs the
 * account opens the live view through the manager, spec liveViewPath). The manager keeps the whole event for its own
 * page and live view.
 */
export function forApps<E extends { t: string; [k: string]: unknown }>(ev: E): E {
  if (ev.t !== 'status' || !ev.liveView || typeof ev.liveView !== 'object') return ev;
  const { width, height } = ev.liveView as Record<string, unknown>;
  return { ...ev, liveView: { width, height } };
}

/** A Unix socket's path is at most 107 bytes (sun_path, less its NUL). */
const SOCKET_PATH_MAX = 107;

interface Held {
  frames: { account: string; data: string }[];
  bytes: number;
  dropped: Map<string, number>;
}

export class Router {
  private sockets = new Map<string, Set<ServerWebSocket<ConsumerSocketData>>>();
  private buffers = new Map<string, Held>();
  /** Per socket: events waiting for this tick's frame, by account. */
  private outbox = new Map<ServerWebSocket<ConsumerSocketData>, Map<string, { t: string; [k: string]: unknown }[]>>();
  private flushing = false;
  /** Per socket: accounts whose state it has been sent. */
  private introduced = new Map<ServerWebSocket<ConsumerSocketData>, Set<string>>();
  private lastAccountEvents = new Map<string, Map<string, { t: string; [k: string]: unknown }>>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private auditCounts = new Map<string, { n: number; last: number }>();
  private auditTimer: Timer;
  readonly handlers: Handler[];
  /** Accounts the manager answers itself (the built-in `notices`, notices.ts): their ops go here, not to a process. */
  readonly inProcess = new Map<string, (op: string, input: Record<string, unknown>) => Promise<unknown>>();

  constructor(
    private store: Store,
    private kinds: Map<string, Kind>,
    private sup: Supervisor,
    private opts: { dataDir: string; onGap?: (account: string) => void },
  ) {
    this.handlers = [this.checkInput, this.limit, this.audit, this.dryRun];
    for (const a of store.all('SELECT DISTINCT app_id FROM grant_')) this.buffers.set(a.app_id, { frames: [], bytes: 0, dropped: new Map() });
    this.auditTimer = setInterval(() => this.flushAudit(), 10_000);
  }

  stop() {
    clearInterval(this.auditTimer);
    this.flushAudit();
  }

  // ---------------------------------------------------------------- grants

  /** The level (and dry-run) an app has on an account's interface, or null. */
  grantFor(appId: string, account: Row, iface: string, grants = this.store.grants(appId)): { level: Level; dryRun: boolean } | null {
    let best: GrantRow | null = null;
    for (const g of grants) {
      if (g.interface !== iface) continue;
      if (g.accounts !== '*' && !g.accounts.includes(account.id)) continue;
      if (g.kinds && !g.kinds.includes(account.kind)) continue;
      if (!best || levelRank(g.level) > levelRank(best.level)) best = g;
    }
    return best ? { level: best.level, dryRun: best.dry_run } : null;
  }

  /** Kinds an app may create and run accounts of. */
  manages(appId: string, kind: string, grants = this.store.grants(appId)): boolean {
    return grants.some((g) => g.interface === 'accounts' && g.level === 'manage' && (!g.kinds || g.kinds.includes(kind)));
  }

  accountsFor(appId: string): AccountView[] {
    const grants = this.store.grants(appId);
    const out: AccountView[] = [];
    for (const a of this.store.accounts()) {
      const kind = this.kinds.get(a.kind);
      const per: Record<string, Level> = {};
      let dry = false;
      for (const i of kind?.ifaces ?? []) {
        const g = this.grantFor(appId, a, i.name, grants);
        if (g) {
          per[i.name] = g.level;
          dry ||= g.dryRun;
        }
      }
      const manages = !this.inProcess.has(a.id) && this.manages(appId, a.kind, grants);
      if (!Object.keys(per).length && !manages) continue;
      const st = this.sup.state(a.id);
      const origin = a.created_by === appId ? 'self' : a.created_by === 'import' ? 'import' : a.created_by ? 'app' : 'page';
      out.push({
        id: a.id,
        kind: a.kind,
        label: a.label,
        interfaces: kind?.ifaces.map((i) => i.name) ?? [],
        running: st.running,
        online: st.online,
        enabled: !!a.enabled,
        error: st.error,
        grants: per,
        dryRun: dry,
        manages,
        liveView: !!this.liveView(a.id),
        origin,
      });
    }
    return out;
  }

  /** An account, a grant or an app changed: every connected app gets its list again. */
  accountsChanged() {
    for (const [appId, socks] of this.sockets) {
      const views = this.accountsFor(appId);
      const msg = JSON.stringify({ t: 'accounts', accounts: views } satisfies ConsumerOut);
      for (const ws of socks) {
        ws.send(msg);
        this.introduce(ws, views);
      }
    }
  }

  /** Accounts an app can now see that it could not before (a grant approved while it was connected): their state. */
  private introduce(ws: ServerWebSocket<ConsumerSocketData>, views: AccountView[]) {
    const seen = this.introduced.get(ws) ?? this.introduced.set(ws, new Set()).get(ws)!;
    for (const view of views) {
      if (!Object.keys(view.grants).length || seen.has(view.id)) continue;
      seen.add(view.id);
      const last = this.lastAccountEvents.get(view.id);
      if (last?.size) ws.send(JSON.stringify({ t: 'events', account: view.id, events: [...last.values()].map(forApps) } satisfies ConsumerOut));
    }
  }

  /** An app got its first grant: start keeping its events while it is away. */
  watch(appId: string) {
    if (!this.buffers.has(appId)) this.buffers.set(appId, { frames: [], bytes: 0, dropped: new Map() });
  }

  // ---------------------------------------------------------------- calls

  async call(appId: string, accountId: string, op: string, input: Record<string, unknown> = {}, trace?: string): Promise<unknown> {
    // A span for every call from an app (trace.ts), a child of the app's when it sent its traceparent.
    const span = new Span(`call ${op}`, { app: appId, account: accountId, op }, parseTraceparent(trace));
    try {
      return await this.callIn(appId, accountId, op, input, span);
    } catch (e) {
      // The upstream status an extractor gave its refusal (410: a stale sync token), so a reader of the trace (bugwatch)
      // can tell an expected refusal from a failure.
      const status = e instanceof CallFailure ? e.error.status : undefined;
      span.set({ outcome: e instanceof CallFailure ? e.error.code : 'failed', ...(typeof status === 'number' ? { status } : {}) }).fail(e);
      throw e;
    } finally {
      span.end();
    }
  }

  private async callIn(appId: string, accountId: string, op: string, input: Record<string, unknown>, span: Span): Promise<unknown> {
    const app = this.store.app(appId);
    if (!app) return fail('denied', 'unknown app');
    const account = this.store.account(accountId);
    if (!account) return fail('unknown-account', `no account ${accountId}`);
    const kind = this.kinds.get(account.kind);
    const iface = kind?.opIface.get(op);
    if (!kind || !iface) return fail('unknown-op', `${account.kind} has no operation "${op}"`);
    const level = iface.ops[op].level;
    const grant = this.grantFor(appId, account, iface.name);
    if (!grant || !covers(grant.level, level)) {
      this.count(appId, accountId, op, 'denied');
      return fail('denied', `${app.name} may not ${level} ${iface.name} on ${account.label}`);
    }
    return this.run({ app, account, kind, iface, op, level, input: input && typeof input === 'object' ? input : {}, grant, span });
  }

  /**
   * A call from the manager's page (the interface explorer): you own every account, so there is no grant to check, but
   * the input check, rate limit, call counts and dry run apply as they would to an app. Counted as app `page`.
   */
  async callAsPage(accountId: string, op: string, input: Record<string, unknown> = {}, dryRun = false): Promise<unknown> {
    const account = this.store.account(accountId);
    if (!account) return fail('unknown-account', `no account ${accountId}`);
    const kind = this.kinds.get(account.kind);
    const iface = kind?.opIface.get(op);
    if (!kind || !iface) return fail('unknown-op', `${account.kind} has no operation "${op}"`);
    const level = iface.ops[op].level;
    return this.run({ app: PAGE_APP, account, kind, iface, op, level, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}, grant: { level: 'manage', dryRun } });
  }

  private run(c: Call): Promise<unknown> {
    const step = (i: number): Next => (x) => (i < this.handlers.length ? this.handlers[i](x, step(i + 1)) : this.dispatch(x));
    return step(0)(c);
  }

  private checkInput: Handler = async (c, next) => {
    const err = c.iface.ops[c.op].input.check(c.input, 'input');
    if (err) return fail('invalid', err);
    return next(c);
  };

  private limit: Handler = async (c, next) => {
    const [rate, burst] = LIMITS[c.level];
    const key = `${c.app.id}|${c.account.id}|${c.level}`;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) {
      this.count(c.app.id, c.account.id, c.op, 'limited');
      return fail('limited', `too many ${c.level} calls to ${c.account.label}; at most ${rate} a second`);
    }
    b.tokens -= 1;
    return next(c);
  };

  private audit: Handler = async (c, next) => {
    try {
      const r = await next(c);
      this.count(c.app.id, c.account.id, c.op, 'ok');
      return r;
    } catch (e) {
      this.count(c.app.id, c.account.id, c.op, 'error');
      throw e;
    }
  };

  private dryRun: Handler = async (c, next) => {
    if (c.grant.dryRun && c.level !== 'read') {
      this.count(c.app.id, c.account.id, c.op, 'dry');
      return { dryRun: true };
    }
    return next(c);
  };

  private async dispatch(c: Call): Promise<unknown> {
    const own = this.inProcess.get(c.account.id);
    if (own) return own(c.op, c.input);
    try {
      c.span?.event('to the extractor');
      // The extractor's span (one that reads `trace`) is a child of the call's.
      const r = await this.sup.command(c.account.id, { ...c.input, t: c.op, ...(c.span ? { trace: c.span.traceparent } : {}) }, c.iface.ops[c.op].timeoutMs ?? 30_000);
      c.span?.event('the extractor answered');
      return r;
    } catch (e) {
      if (e instanceof ExtractorError) return fail(e.code, e.message, e.status);
      throw e;
    }
  }

  /** One more call (or approver request, app `approver`) in today's counts. */
  count(app: string, account: string, op: string, outcome: string) {
    const day = new Date().toISOString().slice(0, 10);
    const k = `${day}|${app}|${account}|${op}|${outcome}`;
    const c = this.auditCounts.get(k) ?? { n: 0, last: 0 };
    c.n++;
    c.last = Date.now();
    this.auditCounts.set(k, c);
  }
  flushAudit() {
    if (!this.auditCounts.size) return;
    const q = this.store.db.query(
      `INSERT INTO audit (day, app_id, account, op, outcome, n, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, app_id, account, op, outcome) DO UPDATE SET n = n + excluded.n, last_at = excluded.last_at`,
    );
    this.store.db.transaction(() => {
      for (const [k, c] of this.auditCounts) q.run(...k.split('|'), c.n, c.last);
    })();
    this.auditCounts.clear();
    // Counts are kept 90 days.
    this.store.run('DELETE FROM audit WHERE day < ?', new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  }

  // ---------------------------------------------------------------- admin

  async admin(appId: string, a: AdminAction): Promise<unknown> {
    const grants = this.store.grants(appId);
    const target = 'account' in a ? this.store.account(a.account) : null;
    const kind = a.do === 'create' ? a.kind : target?.kind;
    if (!kind) return fail('unknown-account', 'no such account');
    if (target && this.inProcess.has(target.id)) return fail('denied', `${target.label} is part of the manager`);
    if (!this.manages(appId, kind, grants)) return fail('denied', `this app may not manage ${kind} accounts`);
    const now = Date.now();
    switch (a.do) {
      case 'create': {
        if (!this.kinds.has(a.kind) || this.kinds.get(a.kind)!.builtin) return fail('invalid', `no extractor for kind "${a.kind}"`);
        const id = a.id && /^[\w-]{4,64}$/.test(a.id) ? a.id : newId('acc');
        if (this.store.account(id)) return fail('invalid', `account ${id} exists`);
        const dir = accountDir(this.opts.dataDir, id);
        this.store.run(
          'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          a.kind,
          String(a.label ?? a.kind).slice(0, 200),
          JSON.stringify(a.config ?? {}),
          newToken(),
          dir,
          a.enabled === false ? 0 : 1,
          appId,
          now,
          now,
        );
        const acc = this.store.account(id)!;
        if (a.secret !== undefined) writeSecret(acc, a.secret);
        this.sup.start(id);
        this.accountsChanged();
        return { id };
      }
      case 'update': {
        if (a.label !== undefined) this.store.run('UPDATE account SET label = ?, updated_at = ? WHERE id = ?', String(a.label).slice(0, 200), now, a.account);
        if (a.config !== undefined) {
          this.store.run('UPDATE account SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(a.config), now, a.account);
          this.sup.sendConfig(a.account);
        }
        if (a.enabled !== undefined) {
          this.store.run('UPDATE account SET enabled = ?, updated_at = ? WHERE id = ?', a.enabled ? 1 : 0, now, a.account);
          if (a.enabled) this.sup.start(a.account);
          else await this.sup.stop(a.account);
        }
        this.accountsChanged();
        return { ok: true };
      }
      case 'secret':
        writeSecret(target!, a.secret);
        return { ok: true };
      case 'delete':
        return { ok: true, ...(await this.remove(target!, a.purge === true)) };
      case 'start':
        this.sup.start(a.account);
        return { ok: true };
      case 'stop':
        await this.sup.stop(a.account);
        return { ok: true };
      case 'restart':
        await this.sup.restart(a.account);
        return { ok: true };
      case 'log':
        return logTail(target!.dir, a.lines);
    }
    return fail('invalid', 'unknown admin action');
  }

  /**
   * An account goes: its extractor stops and its registry entry goes. Its directory stays unless `purge` and the
   * manager made it; a directory imported in place stays, so the app it came from can run it again.
   */
  async remove(account: Row, purge: boolean): Promise<{ dir: string; purged: boolean; why?: string }> {
    if (this.inProcess.has(account.id)) return fail('denied', `${account.label} is part of the manager`);
    await this.sup.stop(account.id);
    releaseLock(account.dir);
    this.store.run('DELETE FROM account WHERE id = ?', account.id);
    this.lastAccountEvents.delete(account.id);
    this.accountsChanged();
    return { dir: account.dir, ...(purge ? purgeDir(this.opts.dataDir, account.id, account.dir) : { purged: false }) };
  }

  // ---------------------------------------------------------------- events

  /** An extractor's event: to every app whose grant covers it, now or when it is back. */
  event(accountId: string, ev: { t: string; [k: string]: unknown }) {
    const account = this.store.account(accountId);
    const kind = account && this.kinds.get(account.kind);
    if (!account || !kind) return;
    const ifaces = kind.eventIfaces.get(ev.t) ?? [];
    const accountLevel = ifaces.some((i) => i.events[ev.t]?.account);
    const hadLiveView = ev.t === 'status' && !!this.liveView(accountId);
    if (accountLevel) (this.lastAccountEvents.get(accountId) ?? this.lastAccountEvents.set(accountId, new Map()).get(accountId)!).set(ev.t, ev);
    if (ev.t === 'status') this.rememberSelf(account, ev.self);
    // Apps' lists say whether there is a live view: tell them when that changes.
    if (ev.t === 'status' && hadLiveView !== !!this.liveView(accountId)) this.accountsChanged();
    if (!ifaces.length) return;
    const out = forApps(ev);
    const appIds = new Set([...this.buffers.keys(), ...this.sockets.keys()]);
    for (const appId of appIds) {
      const ok = ifaces.some((i) => this.grantFor(appId, account, i.name));
      if (!ok) continue;
      const socks = this.sockets.get(appId);
      if (socks?.size) for (const ws of socks) this.enqueue(ws, accountId, out);
      else this.hold(appId, accountId, out);
    }
  }

  private enqueue(ws: ServerWebSocket<ConsumerSocketData>, account: string, ev: { t: string; [k: string]: unknown }) {
    const box = this.outbox.get(ws) ?? this.outbox.set(ws, new Map()).get(ws)!;
    (box.get(account) ?? box.set(account, []).get(account)!).push(ev);
    if (!this.flushing) {
      this.flushing = true;
      setTimeout(() => this.flushOutbox(), 5);
    }
  }
  /** Sends what waits in the outbox now (a manager about to go). */
  flushNow() {
    this.flushOutbox();
  }

  /**
   * What waits for apps that are away, for the next manager (a restart, docs/supervisor.md "Handing over"): each app's
   * held frames in order, and the accounts it already missed events of.
   */
  heldForHandover(): Record<string, { frames: { account: string; data: string }[]; dropped: Record<string, number> }> {
    const out: Record<string, { frames: { account: string; data: string }[]; dropped: Record<string, number> }> = {};
    for (const [appId, b] of this.buffers) if (b.frames.length || b.dropped.size) out[appId] = { frames: b.frames, dropped: Object.fromEntries(b.dropped) };
    return out;
  }

  /** What an earlier manager handed over, before anything new: for apps that still have a grant. */
  restoreHeld(held: Record<string, { frames?: { account: string; data: string }[]; dropped?: Record<string, number> }>) {
    for (const [appId, h] of Object.entries(held)) {
      const b = this.buffers.get(appId);
      if (!b) continue;
      const frames = (h.frames ?? []).filter((f) => typeof f?.account === 'string' && typeof f?.data === 'string');
      b.frames = [...frames, ...b.frames];
      b.bytes += frames.reduce((n, f) => n + f.data.length, 0);
      for (const [a, n] of Object.entries(h.dropped ?? {})) if (typeof n === 'number') b.dropped.set(a, (b.dropped.get(a) ?? 0) + n);
    }
  }

  /**
   * Events of this account may have been lost (a manager that went without handing over, an extractor that did not
   * say it held its events): every app with a grant on it hears of a gap, now or when it is back, and starts over.
   */
  markGap(accountId: string) {
    const account = this.store.account(accountId);
    const kind = account && this.kinds.get(account.kind);
    if (!account || !kind) return;
    this.opts.onGap?.(accountId);
    for (const appId of new Set([...this.buffers.keys(), ...this.sockets.keys()])) {
      if (!kind.ifaces.some((i) => this.grantFor(appId, account, i.name))) continue;
      const socks = this.sockets.get(appId);
      if (socks?.size) for (const ws of socks) ws.send(JSON.stringify({ t: 'gap', account: accountId, dropped: 1 } satisfies ConsumerOut));
      else {
        const b = this.buffers.get(appId);
        if (b) b.dropped.set(accountId, (b.dropped.get(accountId) ?? 0) + 1);
      }
    }
  }

  private flushOutbox() {
    this.flushing = false;
    for (const [ws, box] of this.outbox) {
      for (const [account, events] of box) ws.send(JSON.stringify({ t: 'events', account, events } as ConsumerOut));
    }
    this.outbox.clear();
  }

  private hold(appId: string, account: string, ev: unknown) {
    const b = this.buffers.get(appId);
    if (!b) return;
    if (b.dropped.has(account)) {
      b.dropped.set(account, b.dropped.get(account)! + 1);
      return;
    }
    const data = JSON.stringify(ev);
    if (b.frames.length >= BUFFER.events || b.bytes + data.length > BUFFER.bytes) {
      // Full: this account's waiting events go, and the app hears there is a gap.
      let n = 0;
      b.frames = b.frames.filter((f) => (f.account === account ? (n++, (b.bytes -= f.data.length), false) : true));
      b.dropped.set(account, n + 1);
      this.opts.onGap?.(account);
      return;
    }
    b.frames.push({ account, data });
    b.bytes += data.length;
  }

  // ---------------------------------------------------------------- consumer sockets

  open(ws: ServerWebSocket<ConsumerSocketData>) {
    const appId = ws.data.appId;
    const app = this.store.app(appId)!;
    this.store.run('UPDATE app SET last_seen = ? WHERE id = ?', Date.now(), appId);
    (this.sockets.get(appId) ?? this.sockets.set(appId, new Set()).get(appId)!).add(ws);
    ws.send(JSON.stringify({ t: 'hello', app: appId, name: app.name, manager: 'dither-accounts' } satisfies ConsumerOut));
    ws.send(JSON.stringify({ t: 'accounts', accounts: this.accountsFor(appId) } satisfies ConsumerOut));
    // What waited while it was away, in order, then each account's state as it is now.
    const b = this.buffers.get(appId);
    if (b) {
      let run = null as { account: string; parts: string[] } | null;
      const send = () => run && ws.send(`{"t":"events","account":${JSON.stringify(run.account)},"events":[${run.parts.join(',')}]}`);
      for (const f of b.frames) {
        if (!run || run.account !== f.account || run.parts.length >= 500) {
          send();
          run = { account: f.account, parts: [] };
        }
        run.parts.push(f.data);
      }
      send();
      for (const [account, dropped] of b.dropped) ws.send(JSON.stringify({ t: 'gap', account, dropped } satisfies ConsumerOut));
      b.frames = [];
      b.bytes = 0;
      b.dropped.clear();
    }
    this.introduce(ws, this.accountsFor(appId));
  }

  close(ws: ServerWebSocket<ConsumerSocketData>) {
    const socks = this.sockets.get(ws.data.appId);
    socks?.delete(ws);
    this.outbox.delete(ws);
    this.introduced.delete(ws);
    if (socks && !socks.size) this.sockets.delete(ws.data.appId);
    this.store.run('UPDATE app SET last_seen = ? WHERE id = ?', Date.now(), ws.data.appId);
  }

  /**
   * Who a status says the account is signed in as, kept in its row (seen_as) when that changes: the page names an
   * account by it, also while it is stopped. Only the names, handle, email and avatar link; nothing else it says.
   */
  private rememberSelf(account: Row, self: unknown) {
    if (!self || typeof self !== 'object') return;
    const o = self as Record<string, unknown>;
    const kept: Record<string, string> = {};
    for (const k of ['displayName', 'name', 'handle', 'email', 'avatarUrl', 'avatar']) if (typeof o[k] === 'string' && (o[k] as string).trim()) kept[k] = (o[k] as string).trim().slice(0, 500);
    if (!Object.keys(kept).length) return;
    const json = JSON.stringify(kept);
    if (json !== account.seen_as) this.store.run('UPDATE account SET seen_as = ? WHERE id = ?', json, account.id);
  }

  /**
   * An account's extractor process ended: its last status (online, a QR to scan, a live view's port) was the old
   * process's, so the page stops showing it until the next one reports. A socket that only reconnects keeps it.
   */
  processGone(accountId: string) {
    this.lastAccountEvents.get(accountId)?.delete('status');
  }

  /** The last status an account's extractor reported, for the manager's page (status and attention, not data). */
  lastStatus(accountId: string): Record<string, unknown> | null {
    const st = this.lastAccountEvents.get(accountId)?.get('status') as Record<string, unknown> | undefined;
    if (!st) return null;
    const { status, attention } = st;
    return { status, ...(attention ? { attention } : {}) };
  }

  /** An account's latest account-level event of a type (`hello`, `status`), whole: the account pane shows it. */
  lastEvent(accountId: string, t: string): Record<string, unknown> | null {
    return (this.lastAccountEvents.get(accountId)?.get(t) as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * Where the account's live view listens (its sandbox's VNC, on a Unix socket on this machine), if its extractor offers
   * one. A TCP port is not taken: a VNC without a password on one is open to every local process and web page.
   */
  liveView(accountId: string): { vncSocket: string; width: number; height: number } | null {
    const lv = this.lastEvent(accountId, 'status')?.liveView as { vncSocket?: unknown; width?: unknown; height?: unknown } | null | undefined;
    const sock = lv?.vncSocket;
    if (typeof sock !== 'string' || !isAbsolute(sock) || sock.includes('\0') || Buffer.byteLength(sock) > SOCKET_PATH_MAX) return null;
    return { vncSocket: sock, width: Number(lv!.width) || 1280, height: Number(lv!.height) || 800 };
  }

  connected(appId: string): boolean {
    return !!this.sockets.get(appId)?.size;
  }

  async message(ws: ServerWebSocket<ConsumerSocketData>, raw: string | Buffer) {
    let m: ConsumerIn;
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' } satisfies ConsumerOut));
    if (m.t !== 'call' && m.t !== 'admin') return;
    let out: ConsumerOut;
    try {
      const result = m.t === 'call' ? await this.call(ws.data.appId, m.account, m.op, m.input, m.trace) : await this.admin(ws.data.appId, m.action);
      out = { t: 'result', id: m.id, ok: true, result };
    } catch (e) {
      const error: CallError = e instanceof CallFailure ? e.error : { code: 'failed', message: String((e as Error)?.message ?? e) };
      out = { t: 'result', id: m.id, ok: false, error };
    }
    try {
      ws.send(JSON.stringify(out));
    } catch {}
  }
}
