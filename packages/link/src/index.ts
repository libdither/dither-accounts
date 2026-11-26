/**
 * The extractor's side of the manager: the same wire as dither-chat's adapter client (packages/chat-protocol
 * adapter-client.ts), so chat adapters and new extractors speak one protocol.
 *
 *   const link = linkManager({
 *     onConnect: () => link.emit({ t: 'hello', ... }),
 *     onCommand: async (cmd) => result,      // replied to automatically; throw to fail (a StatusError keeps its status, code, kind and retryAfterMs)
 *   });
 *
 * The manager starts the process with DITHER_HUB_URL (the manager's /extractor socket), DITHER_ACCOUNT_ID,
 * DITHER_ADAPTER_TOKEN, DITHER_ACCOUNT_DIR, DITHER_ACCOUNT_CONFIG and DITHER_ACCOUNT_LABEL. Events emitted while
 * disconnected are queued (bounded) and sent on reconnect.
 *
 * The extractor outlives a manager that restarts (docs/supervisor.md): the link reconnects within seconds, keeping
 * everything, and onConnect says hello and status again to the new manager. Without one for
 * DITHER_MANAGER_GONE_EXIT_S, it shuts down.
 *
 * The other way round, `ask` puts a question to the manager itself and waits for its answer: `{t:'ask', aid, what,
 * input}` up, `{t:'answer', aid, ok, result | error}` down. The manager answers for this account only (it knows which
 * one the socket is); `approver.request` is the approver's (docs/approver.md).
 *
 * For kinds that hold passkeys, `config` is live: the manager sends `{t:'config', config}` when the socket connects and
 * when the page changes it (Keep new passkeys on), and the object is updated in place.
 *
 * A kind that may sleep (its manifest's `sleep`, docs/supervisor.md "Sleeping") says through `sleep` what a stop would
 * cut and when it next needs to run by itself; until it has said so once, it is never put to sleep.
 */
import { join } from 'node:path';
import { exitWhenManagerGone, managerHandshake, reconnectDelay, recordExitCode } from '@dither-chat/protocol/outlive';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type FailureKind, isFailureKind, retryAfterOf } from '@dither-accounts/spec';

/** An op's input with `t`, its name. The manager's call id comes as `rid` and is taken off before onCommand. */
export type Command = { t: string; [k: string]: unknown };
export type Event = { t: string; [k: string]: unknown };

export interface Link {
  readonly accountId: string;
  readonly accountDir: string;
  readonly config: Record<string, any>;
  readonly label: string;
  emit(ev: Event): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  /** $DITHER_ACCOUNT_DIR/secret.json ({} if absent). */
  secret<T = Record<string, any>>(): T;
  saveSecret(value: unknown): void;
  readonly connected: boolean;
  /** A question to the manager (not to an app): its answer, or an error when it fails or none comes in `timeoutMs`. */
  ask(what: string, input?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /**
   * For a kind that may sleep: what it is doing now that a stop would cut (a pull, a sign-in; null for nothing), and
   * when it next needs to run by itself (ms since the epoch, as Date.now(); null for no time of its own, such as a
   * daily pull's). The manager puts it to sleep only while it is not busy, and starts it again a little before
   * `wakeAt`. Sent when it changes and again on every connect.
   */
  sleep(s: { busy: string | null; wakeAt: number | null }): void;
  close(): void;
}

export interface LinkOptions {
  onCommand: (cmd: Command) => unknown | Promise<unknown>;
  /** Every (re)connect, after queued events went out: send hello and status again here. */
  onConnect?: () => void;
  onShutdown?: () => void | Promise<void>;
}

/**
 * Throw one of these to fail a call with an upstream HTTP status (410: sync token stale). `callCode`, when given, is
 * the refusal's reason in a word of the interface's (mail.send's 'recipients'): the app's call fails with that code and
 * this status (CallError.code; spec's isExtractorCode says which words pass, anything else arrives as 'failed'). It is
 * not called `code` so that an upstream's own codes (ProtonError's numbers) never go out as one.
 *
 * `kind` says whether the refusal is an answer, the world failing, or a bug (spec FailureKind); without one the
 * manager works it out from the status (a 4xx is expected, a 503 or 504 transient, a 500 or 502 not known).
 * `retryAfterMs` says how long to wait before the same call may work (a back-off's end).
 */
export class StatusError extends Error {
  readonly kind?: FailureKind;
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    readonly status: number,
    readonly callCode?: string,
    more: { kind?: FailureKind; retryAfterMs?: number } = {},
  ) {
    super(message);
    if (more.kind) this.kind = more.kind;
    const after = retryAfterOf(more.retryAfterMs);
    if (after !== undefined) this.retryAfterMs = after;
  }
}

/** What a failed reply says of a thrown error besides its message: a StatusError's status, code, kind and retryAfterMs. */
export function replyError(err: any): { error: string; status?: number; code?: string; kind?: FailureKind; retryAfterMs?: number } {
  const out: ReturnType<typeof replyError> = { error: String(err?.message ?? err) };
  // A status goes from any error that has a number for one (as before); the rest only from a StatusError, never from
  // another error that happens to carry the same names (Node's ENOENT code and the like).
  if (typeof err?.status === 'number') out.status = err.status;
  if (err instanceof StatusError) {
    if (typeof err.callCode === 'string') out.code = err.callCode;
    if (isFailureKind(err.kind)) out.kind = err.kind;
    if (err.retryAfterMs !== undefined) out.retryAfterMs = err.retryAfterMs;
  }
  return out;
}

const MAX_QUEUE = 100_000;

export function linkManager(opts: LinkOptions): Link {
  const env = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing ${k}; extractors are started by the manager`);
    return v;
  };
  const url = `${env('DITHER_HUB_URL')}?account=${encodeURIComponent(env('DITHER_ACCOUNT_ID'))}&token=${encodeURIComponent(env('DITHER_ADAPTER_TOKEN'))}`;
  const accountDir = env('DITHER_ACCOUNT_DIR');
  const queue: string[] = [];
  let ws: WebSocket | null = null;
  let open = false;
  /** A manager's restart: events held for the next one (outlive.ts). */
  const handshake = managerHandshake();
  let closed = false;
  let attempt = 0;
  const config: Record<string, any> = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}');
  /** The last `sleep` frame, sent again on every connect (a new manager knows nothing of it). */
  let sleepFrame: string | null = null;
  const asked = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }>();

  const send = (x: string) => {
    // After the manager said it is going, everything waits for the next one.
    if (open && ws && !handshake.holding) ws.send(x);
    else {
      queue.push(x);
      if (queue.length > MAX_QUEUE) {
        queue.splice(0, queue.length - MAX_QUEUE);
        handshake.dropped();
      }
    }
  };
  const shutdown = async () => {
    await opts.onShutdown?.();
    process.exit(0);
  };
  const gone = exitWhenManagerGone(() => open, () => void shutdown());
  recordExitCode(accountDir);

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      open = true;
      attempt = 0;
      gone.up();
      handshake.opened(ws!);
      while (queue.length) ws!.send(queue.shift()!);
      if (sleepFrame) ws!.send(sleepFrame);
      opts.onConnect?.();
    };
    ws.onmessage = async (e) => {
      let cmd: Command;
      try {
        cmd = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (cmd.t === 'shutdown') return shutdown();
      if (handshake.message(cmd, ws)) return;
      if (cmd.t === 'config') {
        if (cmd.config && typeof cmd.config === 'object' && !Array.isArray(cmd.config)) {
          for (const k of Object.keys(config)) if (!(k in cmd.config)) delete config[k];
          Object.assign(config, cmd.config);
        }
        return;
      }
      if (cmd.t === 'answer') {
        const p = typeof cmd.aid === 'string' ? asked.get(cmd.aid) : undefined;
        if (!p) return;
        asked.delete(cmd.aid as string);
        clearTimeout(p.timer);
        if (cmd.ok === true) p.resolve(cmd.result);
        else p.reject(new Error(String(cmd.error ?? 'the manager refused')));
        return;
      }
      // The call id is `rid` (from a manager before it: `id`). The manager also sends it as `id` when the op's input
      // has none, for chat adapters: that `id` is no input, so an optional one (cal.put's) stays absent.
      // `trace` is the manager's traceparent for the call (packages/manager/src/trace.ts), not an input.
      const { rid: r, trace: _trace, ...input } = cmd;
      const rid = typeof r === 'string' ? r : typeof cmd.id === 'string' ? cmd.id : null;
      if (input.id === rid) delete input.id;
      try {
        const result = await opts.onCommand(input as Command);
        if (rid) send(JSON.stringify({ t: 'reply', id: rid, ok: true, result }));
      } catch (err: any) {
        if (rid) send(JSON.stringify({ t: 'reply', id: rid, ok: false, ...replyError(err) }));
      }
    };
    ws.onclose = () => {
      open = false;
      handshake.closed();
      gone.down();
      if (closed) return;
      setTimeout(connect, reconnectDelay(attempt++));
    };
    ws.onerror = () => {};
  };
  connect();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return {
    accountId: env('DITHER_ACCOUNT_ID'),
    accountDir,
    config,
    label: process.env.DITHER_ACCOUNT_LABEL ?? '',
    emit: (e) => send(JSON.stringify(e)),
    log: (level, msg, data) => {
      send(JSON.stringify({ t: 'log', level, msg, data }));
      if (level !== 'debug' && !open) console.log(`[${level}] ${msg}`, data ?? '');
    },
    // Whole or not at all, with the last good copy kept (chat-protocol secret-file.ts).
    secret: <T>() => readSecretFile<T>(join(accountDir, 'secret.json'), (m) => console.error(m)),
    saveSecret: (value) => writeSecretFile(join(accountDir, 'secret.json'), value),
    get connected() {
      return open;
    },
    ask: (what, input = {}, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const aid = crypto.randomUUID();
        const timer = setTimeout(() => {
          asked.delete(aid);
          reject(new Error(`no answer from the manager to ${what} in ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        asked.set(aid, { resolve, reject, timer });
        send(JSON.stringify({ t: 'ask', aid, what, input }));
      }),
    sleep: (st) => {
      const frame = JSON.stringify({ t: 'sleep', busy: st.busy || null, wakeAt: typeof st.wakeAt === 'number' && Number.isFinite(st.wakeAt) ? Math.round(st.wakeAt) : null });
      if (frame === sleepFrame) return;
      sleepFrame = frame;
      // Not queued: only the latest counts, and it goes on every connect. (A queue that overflows loses events.)
      if (open && ws && !handshake.holding) ws.send(frame);
    },
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}
