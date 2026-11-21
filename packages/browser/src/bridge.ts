/**
 * The extractor's own little WebSocket server (extractors/discord's, generalized). The sandbox extension's service
 * worker connects to ws://127.0.0.1:<port>/?token=…; nothing else may talk to the page's hook. Bound to loopback,
 * token-gated, port 0 by default (any free one).
 *
 * Up from the extension: `{ t: 'reply', id, ok, result | error }` for commands; `{ t: 'got', id, at }` where a command
 * has got to (the service worker handed it to the page's port: 'worker'; the page has it: 'page'), so one never
 * answered says how far it got (the timeout's `reached`); anything else to onMessage.
 * Down to it: `{ t: 'cmd', id, cmd }` (request) and `{ t: 'ping' }`.
 *
 * With `silence` set, every request that times out is told apart in the log at once (silence.ts): the worker is asked
 * for the tab's state and the hook for its own, and one line says how far the request got. Without it, a kind calls
 * diagnoseSilence itself where it wants (Google's, before it reloads a tab).
 *
 * A command's id is `<boot>.c<n>`: `boot` is random per BridgeServer, so a page that outlives its extractor (Chromium
 * left running across an extractor restart) never takes a new command for one it has already seen. The content
 * script passes each id to its hook once (page/isolated-world.js), and a recycled `c1` would be dropped there.
 *
 * With `resend` set, a command the page has not said it has (its `got` at 'page') within RESEND_MS is sent again, the
 * same id, up to RESEND_MAX times: the content script passes an id on once, so a copy that already arrived is
 * dropped, and one lost on the way (a port being replaced, a worker put to sleep) costs seconds, not the whole
 * timeout. Only the kinds the extractor lists (`resend.kinds`): reads, and writes that are the same done twice (a
 * mark read, a label). The id check holds within one page only: a copy that reached a page whose `got` was lost, and
 * whose resend lands in a reloaded page or a new tab, runs twice. So nothing that sends or posts what other people
 * see (a message, a post, a reply, a reaction, an edit, a delete) is ever listed, nor a command the service worker
 * runs itself (it has no such check); `tab.*` never is, whatever the list says.
 */
import type { Server, ServerWebSocket } from 'bun';
import type { Log } from './sandbox.ts';
import { diagnoseSilence } from './silence.ts';

type SocketData = { authed: boolean };

/** `from: 'worker'`: the service worker answered (a tab command, or no page to run it in), not the page. */
export type BridgeReply = ({ t: 'reply'; id: string; ok: true; result?: unknown } | { t: 'reply'; id: string; ok: false; error: string; retryAfter?: number }) & { from?: 'worker' };

export interface BridgeServerOpts<Up, Cmd = { kind: string }> {
  /** 0 (the default): any free loopback port; read `port` after start(). */
  port?: number;
  token: string;
  onMessage: (msg: Up) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** Every frame that came up but a `got`, replies included, before it is routed (a page watch hears the page through it). */
  onFrame?: (msg: Up | BridgeReply) => void;
  /** A command the extension did not answer in time, by its kind. */
  onTimeout?: (kind: string) => void;
  log: Log;
  /** Diagnose each timed-out request by itself (silence.ts). Off by default. */
  silence?: BridgeSilence;
  /** Send a command again while its page has not said it has it (see the header). Off by default. */
  resend?: BridgeResend<Cmd>;
}

/** Which commands are sent again while their page is silent about them, and how often. */
export interface BridgeResend<Cmd = { kind: string }> {
  /** The only kinds sent again: reads, and writes that are the same done twice (see the header). */
  kinds: readonly string[];
  /** Of those, the commands that may be sent again (a GET of a kind that also writes); default all. */
  when?: (cmd: Cmd) => boolean;
  /** Default RESEND_MS. */
  afterMs?: number;
  /** Default RESEND_MAX. */
  max?: number;
}

/** A command the page has not said it has within this is sent again. */
export const RESEND_MS = 3_000;
/** At most this many times. */
export const RESEND_MAX = 3;

/** How a bridge diagnoses its own timeouts: what the page is called, and what its extension can answer. */
export interface BridgeSilence {
  /** "the <name> page's silence". */
  name: string;
  /** The worker answers `tab.state` (page/worker-watch.js). A command's own numeric `tabId` goes with it. */
  tab?: boolean;
  /** The hook answers `page.state` (page/command-watch.js). */
  page?: boolean;
  /** The worker runs commands itself rather than handing them to a page (statements-common's driver). */
  workerRuns?: boolean;
}

/** How far a command got before its timeout: nowhere we heard of, the service worker, or the page itself. */
export type Reached = 'none' | 'worker' | 'page';
const REACHED_RANK: Record<Reached, number> = { none: 0, worker: 1, page: 2 };

interface Pending {
  reached: Reached;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The resend timer, while the page has not said it has the command. */
  again?: ReturnType<typeof setTimeout>;
  /** How many times it was sent again. */
  resent: number;
}

export class BridgeServer<Up extends { t: string } = { t: string; [k: string]: unknown }, Cmd extends { kind: string } = { kind: string; [k: string]: unknown }> {
  /** This server's own part of every command id (see the header). */
  readonly boot = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('base64url');
  private server?: Server<SocketData>;
  private sock: ServerWebSocket<SocketData> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private diagnosing = false;
  private answeredAt: number | null = null;

  constructor(private opts: BridgeServerOpts<Up, Cmd>) {}

  get connected(): boolean {
    return !!this.sock;
  }
  get port(): number {
    return this.server?.port ?? this.opts.port ?? 0;
  }
  /** When the extension last answered a request (any reply), or null. */
  get lastAnswerAt(): number | null {
    return this.answeredAt;
  }
  /** What the extension's config.json needs. */
  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/`;
  }

  start() {
    const self = this;
    this.server = Bun.serve<SocketData, never>({
      port: this.opts.port ?? 0,
      hostname: '127.0.0.1',
      idleTimeout: 120,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.searchParams.get('token') !== self.opts.token) return new Response('forbidden', { status: 403 });
        if (server.upgrade(req, { data: { authed: true } })) return undefined;
        return new Response('expected websocket', { status: 400 });
      },
      websocket: {
        maxPayloadLength: 64 * 1024 * 1024,
        open(ws) {
          // One service worker per sandbox; a newer socket replaces an older one.
          if (self.sock && self.sock !== ws) self.sock.close(4000, 'replaced');
          self.sock = ws;
          self.opts.log('info', 'extension connected');
          self.opts.onConnect?.();
        },
        message(_ws, raw) {
          let msg: Up | BridgeReply;
          try {
            msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          } catch {
            return;
          }
          if (msg.t === 'got') {
            const g = msg as unknown as { id?: unknown; at?: unknown };
            const p = typeof g.id === 'string' ? self.pending.get(g.id) : undefined;
            if (p && (g.at === 'worker' || g.at === 'page') && REACHED_RANK[g.at] > REACHED_RANK[p.reached]) p.reached = g.at;
            if (p?.reached === 'page' && p.again) {
              clearTimeout(p.again);
              p.again = undefined;
            }
            return;
          }
          self.opts.onFrame?.(msg);
          if (msg.t === 'reply') {
            const r = msg as BridgeReply;
            const p = self.pending.get(r.id);
            self.answeredAt = Date.now();
            if (p) {
              self.pending.delete(r.id);
              clearTimeout(p.timer);
              clearTimeout(p.again);
              if (r.ok) p.resolve(r.result);
              else p.reject(Object.assign(new Error(r.error), { retry_after: r.retryAfter }));
            }
            return;
          }
          self.opts.onMessage(msg as Up);
        },
        close(ws) {
          if (self.sock === ws) {
            self.sock = null;
            self.opts.log('info', 'extension disconnected');
            self.opts.onDisconnect?.();
          }
        },
      },
    });
    this.opts.log('info', `bridge server on ws://127.0.0.1:${this.server.port}`);
    return this.server;
  }

  private sendDown(payload: { t: 'cmd'; id: string; cmd: Cmd } | { t: 'ping' }) {
    if (!this.sock) throw new Error('extension not connected');
    this.sock.send(JSON.stringify(payload));
  }

  /**
   * Run a command in the page and await its reply. A timeout's error carries `reached`: how far the command got. With
   * the `silence` option, a timeout is also diagnosed in the log, unless `diagnose` is false (the probes themselves).
   */
  request<T = unknown>(cmd: Cmd, timeoutMs = 30_000, opts: { diagnose?: boolean } = {}): Promise<T> {
    const id = `${this.boot}.c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      if (!this.sock) return reject(new Error('extension not connected'));
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        const reached = p?.reached ?? 'none';
        clearTimeout(p?.again);
        this.pending.delete(id);
        reject(Object.assign(new Error(`hook timed out on ${cmd.kind}`), { reached, resent: p?.resent ?? 0 }));
        this.opts.onTimeout?.(cmd.kind);
        if (opts.diagnose !== false) this.diagnose(cmd, reached);
      }, timeoutMs);
      const pending: Pending = { reached: 'none', resolve: resolve as (v: unknown) => void, reject, timer, resent: 0 };
      this.pending.set(id, pending);
      try {
        this.sendDown({ t: 'cmd', id, cmd });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        return reject(e as Error);
      }
      if (this.resends(cmd)) this.resendLater(id, cmd, pending);
    });
  }

  /** Whether `cmd` may be sent again (the `resend` option). */
  private resends(cmd: Cmd): boolean {
    const r = this.opts.resend;
    if (!r || cmd.kind.startsWith('tab.') || !r.kinds.includes(cmd.kind)) return false;
    return r.when ? r.when(cmd) : true;
  }

  /** Send it again, the same id, if the page has not said it has it by then; again after that, up to the cap. */
  private resendLater(id: string, cmd: Cmd, p: Pending) {
    const r = this.opts.resend!;
    if (p.resent >= (r.max ?? RESEND_MAX)) return;
    p.again = setTimeout(() => {
      p.again = undefined;
      if (this.pending.get(id) !== p || p.reached === 'page' || !this.sock) return;
      p.resent++;
      this.opts.log('debug', `${cmd.kind}: no word from the page in ${(r.afterMs ?? RESEND_MS) / 1000} s (${p.reached === 'worker' ? 'the worker handed it on' : 'the worker never said it had it'}); sent again (${p.resent})`);
      try {
        this.sendDown({ t: 'cmd', id, cmd });
      } catch {
        return;
      }
      this.resendLater(id, cmd, p);
    }, r.afterMs ?? RESEND_MS);
  }

  /** One diagnosis at a time: requests that time out together are one silence. */
  private diagnose(cmd: Cmd, reached: Reached) {
    const s = this.opts.silence;
    if (!s || this.diagnosing || !this.sock) return;
    this.diagnosing = true;
    const tabId = (cmd as { tabId?: unknown }).tabId;
    void diagnoseSilence(this, {
      name: s.name,
      request: cmd.kind,
      reached,
      log: this.opts.log,
      tab: s.tab ? { kind: 'tab.state', ...(typeof tabId === 'number' ? { tabId } : {}) } : null,
      page: s.page ? { kind: 'page.state' } : null,
      workerRuns: s.workerRuns,
    }).finally(() => {
      this.diagnosing = false;
    });
  }

  /** Traffic that keeps the extension's service worker awake. */
  ping() {
    if (this.sock) this.sendDown({ t: 'ping' });
  }

  stop() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      clearTimeout(p.again);
      p.reject(new Error('extractor shutting down'));
    }
    this.pending.clear();
    this.server?.stop(true);
  }
}
