/**
 * An app's side of the manager.
 *
 *   const reg = await register(url, { name: 'dither-calendar', requests: [{ interface: 'google.calendar', level: 'write' }] });
 *   // keep reg.app and reg.token; the requests wait for you on the manager's page
 *   const acc = new AccountsClient({ url, app: reg.app, token: reg.token, onEvents: (account, events) => ... });
 *   const page = await acc.call(googleCalendar, account, 'calendar.events.list', { calendarId: 'primary' });
 *
 * Calls made while the socket is down wait for it (up to their timeout). The client reconnects with backoff and
 * pings every 25 s, so a dead socket shows within a minute.
 *
 * When the socket drops with calls in flight, reads are sent again on the next socket (the manager answers a repeated
 * id once, and a read run twice is harmless). A write, manage call or admin change already sent is not: it may have
 * gone through (the manager may have restarted while its extractor kept running), so it fails at once with code
 * `unsure` (status 504) and the app decides, for instance by looking in Sent. A call not yet sent waits as before.
 *
 * An app that manages an account (an `accounts` grant at manage for its kind) also runs it: `admin` creates, changes,
 * restarts and removes accounts and reads their logs, and `liveViewUrl` is the socket that carries an account's live
 * view (its sandboxed browser's VNC stream) for the app to hand on to its own page.
 *
 * With `remember`, a read that failed is not sent again until it is due (spec memory.ts, docs/manager.md "A failed
 * read is remembered"): a repeat fails at once with the same error, `remembered` set and `retryAfterMs` the time left.
 * A transient failure backs off (honouring its retryAfterMs), an expected one is kept until the account changes (or 10
 * minutes), a bug backs off longer. A success, a write to the account, the account's state changing, or `forget`
 * clears it. Only failures the manager answered are remembered, never the client's own (a timeout, a dropped socket).
 */
import { type AccountView, type AdminAction, type AdminResult, type CallError, type ConsumerIn, type ConsumerOut, type FailureKind, failureKindOf, type Iface, type InputOf, liveViewPath, type OpName, type OutputOf, retryAfterOf } from '@dither-accounts/spec';
import type { AccessRequest } from '@dither-accounts/manager/api-types';
import { IFACES } from '@dither-accounts/interfaces';
import { FailureMemory, type MemoryOpts, type Remembered } from '@dither-accounts/spec/memory';
import { ManagerSocket, OPEN } from './socket.ts';

/** Each op's level, by name (op names are unique across interfaces): which calls may be sent again. */
const OP_LEVEL = new Map<string, string>();
for (const i of Object.values(IFACES)) for (const [name, spec] of Object.entries(i.ops)) OP_LEVEL.set(name, spec.level);

/**
 * The code a write fails with when its socket dropped after it was sent: it may or may not have gone through, and
 * it is not sent again. Status 504, as an extractor's own "no answer in time".
 */
export const UNSURE = 'unsure';

/**
 * A failed call. `kind` says whether it is an answer (`expected`: not found, offline, not allowed), the world failing
 * for a moment (`transient`: a network drop, a 503, a rate limit; try again after `retryAfterMs` when given) or a bug
 * (spec FailureKind). The manager sends it; when it did not (an older manager), it is worked out here from the code
 * and status the same way. Undefined: nobody knows (an extractor's plain error), so treat it as a bug.
 * `transient` does not make a write safe to send again: `unsure` is transient too.
 */
export class CallFailed extends Error {
  readonly code: CallError['code'];
  readonly status?: number;
  readonly kind?: FailureKind;
  readonly retryAfterMs?: number;
  /**
   * Set when this is a remembered answer (ClientOpts.remember): the call was not sent. When it failed last, how many
   * times in a row, and how many times it was asked again since. An app logs it as a repeat, not as a new failure.
   */
  readonly remembered?: { at: number; failures: number; repeats: number };
  constructor(e: CallError, remembered?: Pick<Remembered, 'at' | 'failures' | 'repeats'>) {
    super(e.message);
    this.code = e.code;
    this.status = e.status;
    this.kind = failureKindOf(e);
    this.retryAfterMs = retryAfterOf(e.retryAfterMs);
    if (remembered) this.remembered = { at: remembered.at, failures: remembered.failures, repeats: remembered.repeats };
  }
}

export interface ClientOpts {
  /** The manager, http://127.0.0.1:8486 */
  url: string;
  app: string;
  token: string;
  onAccounts?: (accounts: AccountView[]) => void;
  /** Events from one account, in order. */
  onEvents?: (account: string, events: { t: string; [k: string]: unknown }[]) => void;
  /** Events for this account were dropped while the app was away. */
  onGap?: (account: string, dropped: number) => void;
  onConnection?: (connected: boolean) => void;
  /** Default call timeout, ms (each op's own is longer when the interface says so). Default 60 s. */
  timeoutMs?: number;
  /** Remember failed reads and answer repeats from memory until they are due (spec memory.ts). Off by default. */
  remember?: boolean | MemoryOpts;
}

/** `read`: safe to send again. `sent`: it went out on a socket. */
type Waiting = { msg: string; read: boolean; sent: boolean; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer; answered?: (error: CallError | null) => void };

export class AccountsClient {
  accounts: AccountView[] = [];
  connected = false;
  private ws: ManagerSocket | null = null;
  private closed = false;
  private attempt = 0;
  private waiting = new Map<string, Waiting>();
  private ping?: Timer;
  /** Failed reads remembered (`remember`), else null. */
  readonly memory: FailureMemory | null;
  /** What each account looked like when last told, as far as it bears on a remembered failure. */
  private seen = new Map<string, string>();

  constructor(private opts: ClientOpts) {
    this.memory = opts.remember ? new FailureMemory(opts.remember === true ? {} : opts.remember) : null;
    this.connect();
  }

  /** Forget remembered failures: an account's (all, or one op's), or all of them; the next call of each is sent. */
  forget(account?: string, op?: string) {
    this.memory?.forget(account, op);
  }

  /** An account whose state changed (online, running, enabled, an error, its grants) has its remembered failures forgotten. */
  private accountsChanged(accounts: AccountView[]) {
    if (!this.memory) return;
    const now = new Map(accounts.map((a) => [a.id, JSON.stringify([a.running, a.online, a.enabled, a.error, a.grants])]));
    for (const [id, was] of this.seen) if (now.get(id) !== was) this.memory.forget(id);
    this.seen = now;
  }

  private connect() {
    if (this.closed) return;
    const u = new URL('/consumer', this.opts.url.replace(/^http/, 'ws'));
    u.searchParams.set('app', this.opts.app);
    u.searchParams.set('token', this.opts.token);
    const ws = new ManagerSocket(u.toString());
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.opts.onConnection?.(true);
      // What is still waiting is a read, or was never sent (writes in flight failed when the last socket closed).
      for (const w of this.waiting.values()) {
        ws.send(w.msg);
        w.sent = true;
      }
      this.ping = setInterval(() => ws.readyState === OPEN && ws.send(JSON.stringify({ t: 'ping' } satisfies ConsumerIn)), 25_000);
    };
    ws.onmessage = (e) => {
      let m: ConsumerOut;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.t === 'accounts') {
        this.accountsChanged(m.accounts);
        this.accounts = m.accounts;
        this.opts.onAccounts?.(m.accounts);
      } else if (m.t === 'events') this.opts.onEvents?.(m.account, m.events);
      else if (m.t === 'gap') this.opts.onGap?.(m.account, m.dropped);
      else if (m.t === 'result') {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        w.answered?.(m.ok ? null : m.error);
        if (m.ok) w.resolve(m.result);
        else w.reject(new CallFailed(m.error));
      }
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      const was = this.connected;
      this.connected = false;
      if (was) this.opts.onConnection?.(false);
      if (this.closed) return;
      for (const [id, w] of this.waiting) {
        if (w.read || !w.sent) continue;
        this.waiting.delete(id);
        clearTimeout(w.timer);
        w.reject(new CallFailed({ code: UNSURE, status: 504, message: 'the connection to the manager dropped while this was under way: it may or may not have gone through, and it was not sent again' }));
      }
      setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** this.attempt++));
    };
    ws.onerror = () => {};
  }

  private send(build: (id: string) => ConsumerIn, timeoutMs: number, read: boolean, answered?: Waiting['answered']): Promise<unknown> {
    const id = crypto.randomUUID();
    const msg = JSON.stringify(build(id));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CallFailed({ code: 'timeout', message: this.connected ? 'the manager did not answer' : 'the manager is not reachable' }));
      }, timeoutMs);
      const w: Waiting = { msg, read, sent: false, resolve, reject, timer, answered };
      this.waiting.set(id, w);
      if (this.connected) {
        this.ws!.send(msg);
        w.sent = true;
      }
    });
  }

  /** A typed call: the interface names the op, its input and its output. */
  call<I extends Iface, K extends OpName<I>>(iface: I, account: string, op: K, input: InputOf<I, K>, timeoutMs?: number): Promise<OutputOf<I, K>> {
    const spec = iface.ops[op];
    return this.callRaw(account, op, input as Record<string, unknown>, timeoutMs ?? Math.max(this.opts.timeoutMs ?? 60_000, (spec?.timeoutMs ?? 30_000) + 5_000)) as Promise<OutputOf<I, K>>;
  }

  /**
   * `o.trace`: this app's W3C traceparent for the call, so the manager's spans join its trace. An op no interface here
   * knows is taken for a write: it is not sent again after a dropped socket.
   */
  callRaw(account: string, op: string, input: Record<string, unknown> = {}, timeoutMs = this.opts.timeoutMs ?? 60_000, o: { trace?: string } = {}): Promise<unknown> {
    const read = OP_LEVEL.get(op) === 'read';
    const mem = this.memory;
    if (!mem) return this.send((id) => ({ t: 'call', id, account, op, input, ...(o.trace ? { trace: o.trace } : {}) }), timeoutMs, read);
    if (!read) {
      // A write may change what the account's reads answer: what was remembered of it is asked again.
      return this.send((id) => ({ t: 'call', id, account, op, input, ...(o.trace ? { trace: o.trace } : {}) }), timeoutMs, read, (error) => {
        if (!error) mem.forget(account);
      });
    }
    const key = mem.key(account, op, input);
    const hit = mem.check(key);
    if (hit) return Promise.reject(new CallFailed({ ...hit.error, retryAfterMs: mem.dueInMs(hit) }, hit));
    const repeats = mem.take(key);
    return this.send((id) => ({ t: 'call', id, account, op, input, ...(o.trace ? { trace: o.trace } : {}), ...(repeats ? { repeats } : {}) }), timeoutMs, read, (error) => {
      if (error) mem.failed(key, account, op, error);
      else mem.succeeded(key);
    });
  }

  /** Create, change, start, stop, remove accounts of the kinds this app manages, or read their logs. */
  admin<A extends AdminAction>(action: A, timeoutMs = 60_000): Promise<AdminResult<A>> {
    return this.send((id) => ({ t: 'admin', id, action }), timeoutMs, action.do === 'kinds' || action.do === 'log') as Promise<AdminResult<A>>;
  }

  /** The last lines of an account's extractor log. */
  log(account: string, lines = 400): Promise<{ lines: string[]; size: number }> {
    return this.admin({ do: 'log', account, lines });
  }

  /**
   * The WebSocket URL of an account's live view: the raw VNC stream (binary frames both ways), for an account this app
   * manages whose AccountView says `liveView`. It carries this app's token, so open it from the app, never a browser.
   */
  liveViewUrl(account: string): string {
    const u = new URL(liveViewPath(account), this.opts.url.replace(/^http/, 'ws'));
    u.searchParams.set('token', this.opts.token);
    return u.toString();
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    this.ws?.close();
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new CallFailed({ code: 'offline', message: 'closed' }));
    }
    this.waiting.clear();
  }
}

/** Introduce an app to the manager. Keep the token: it is shown once. */
export async function register(url: string, req: { name: string; describe?: string; requests: AccessRequest[] }): Promise<{ app: string; token: string; requests: { id: string }[] }> {
  const r = await fetch(new URL('/api/apps/register', url), { method: 'POST', body: JSON.stringify(req), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
  return r.json() as any;
}

/** Ask for more; the requests wait on the manager's page. */
export async function requestAccess(url: string, app: string, token: string, requests: AccessRequest[]): Promise<{ requests: { id: string }[] }> {
  const r = await fetch(new URL(`/api/apps/${app}/requests`, url), { method: 'POST', body: JSON.stringify({ requests }), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`requests: ${r.status} ${await r.text()}`);
  return r.json() as any;
}

/** This app's grants and requests as the manager has them. */
export async function self(url: string, app: string, token: string): Promise<any> {
  const r = await fetch(new URL(`/api/apps/${app}/self`, url), { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`self: ${r.status} ${await r.text()}`);
  return r.json();
}

export type { AccessRequest };
export type { AccountView, AdminAction, AdminResult, CallError, FailureKind } from '@dither-accounts/spec';
export { liveViewPath } from '@dither-accounts/spec';
