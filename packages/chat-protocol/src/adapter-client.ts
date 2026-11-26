/**
 * Adapter-side link to the hub. Every out-of-process adapter uses this:
 *
 *   const hub = linkHub({
 *     onConnect: () => { hub.emit({ t: 'hello', ... }); resendSnapshot(); },
 *     onCommand: async (cmd) => { ...; return result },   // auto-replied if cmd has an id
 *   });
 *
 * Events emitted while disconnected are queued (bounded) and flushed on reconnect. Under dither-accounts the adapter
 * outlives a manager that restarts (its docs/supervisor.md): this reconnects within seconds and onConnect says hello
 * again; without a manager for DITHER_MANAGER_GONE_EXIT_S it shuts down.
 * Throwing from onCommand sends { ok: false, error }, with the error's numeric `status` when it has one (a
 * RefusalError): a 4xx tells the manager's trace, and bugwatch, that the call was answered "no", not that it broke.
 */

import { join } from 'node:path';
import { PROTOCOL_VERSION, type AdapterCommand, type AdapterEvent } from './adapter.ts';
import { exitWhenManagerGone, managerHandshake, reconnectDelay, recordExitCode } from './outlive.ts';
import { readSecretFile, writeSecretFile } from './secret-file.ts';

export interface HubLink {
  readonly accountId: string;
  readonly accountDir: string;
  readonly config: Record<string, any>;
  readonly label: string;
  emit(ev: AdapterEvent): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  /** Contents of $DITHER_ACCOUNT_DIR/secret.json ({} if absent). */
  secret<T = Record<string, any>>(): T;
  saveSecret(value: unknown): void;
  readonly connected: boolean;
  /**
   * A question to the accounts manager itself, answered for this account (dither-accounts' link has the same):
   * `signin.choices` and `signin.relay` (its docs/signin-relay.md). Fails after `timeoutMs` with no answer.
   */
  ask(what: string, input?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/**
 * Throw one of these from onCommand to refuse with a status: 404 for something the network does not have (a contact
 * with no profile picture), 4xx for another expected "no". Plain errors stay failures.
 */
export class RefusalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface LinkOptions {
  onCommand: (cmd: AdapterCommand) => unknown | Promise<unknown>;
  /** Called on every (re)connect, after queued events are flushed. Re-send hello and status here. */
  onConnect?: () => void;
  onShutdown?: () => void | Promise<void>;
}

const MAX_QUEUE = 100_000;

export function linkHub(opts: LinkOptions): HubLink {
  const env = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing ${k}; adapters are started by the hub`);
    return v;
  };
  const url = `${env('DITHER_HUB_URL')}?account=${encodeURIComponent(env('DITHER_ACCOUNT_ID'))}&token=${encodeURIComponent(env('DITHER_ADAPTER_TOKEN'))}`;
  const accountDir = env('DITHER_ACCOUNT_DIR');
  const config = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}');
  const queue: string[] = [];
  const asked = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }>();
  let ws: WebSocket | null = null;
  let open = false;
  /** A manager's restart: events held for the next one (outlive.ts). */
  const handshake = managerHandshake();
  let closed = false;
  let attempt = 0;

  const send = (s: string) => {
    // After the manager said it is going, everything waits for the next one.
    if (open && ws && !handshake.holding) ws.send(s);
    else {
      queue.push(s);
      if (queue.length > MAX_QUEUE) {
        queue.splice(0, queue.length - MAX_QUEUE);
        handshake.dropped();
      }
    }
  };

  const gone = exitWhenManagerGone(() => open, () => void stop());
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
      opts.onConnect?.();
    };
    ws.onmessage = async (e) => {
      let cmd: AdapterCommand;
      try {
        cmd = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (handshake.message(cmd as { t: string }, ws)) return;
      // The manager's answer to an `ask` (it carries the ask's `aid`): not a command. A hub's `answer` (to a join
      // request) has none and goes on to the adapter.
      const a = cmd as unknown as { t: string; aid?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      if (a.t === 'answer' && typeof a.aid === 'string') {
        const p = asked.get(a.aid);
        if (!p) return;
        asked.delete(a.aid);
        clearTimeout(p.timer);
        if (a.ok === true) p.resolve(a.result);
        else p.reject(new Error(String(a.error ?? 'the manager refused')));
        return;
      }
      if (cmd.t === 'shutdown') {
        await opts.onShutdown?.();
        process.exit(0);
      }
      try {
        const result = await opts.onCommand(cmd);
        if ('id' in cmd) send(JSON.stringify({ t: 'reply', id: cmd.id, ok: true, result } satisfies AdapterEvent));
      } catch (err: any) {
        if ('id' in cmd) send(JSON.stringify({ t: 'reply', id: cmd.id, ok: false, error: String(err?.message ?? err), ...(typeof err?.status === 'number' ? { status: err.status } : {}) } satisfies AdapterEvent));
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

  const link: HubLink = {
    accountId: env('DITHER_ACCOUNT_ID'),
    accountDir,
    config,
    label: process.env.DITHER_ACCOUNT_LABEL ?? '',
    // Every hello says which protocol this side speaks (adapter.ts PROTOCOL_VERSION).
    emit: (ev) => send(JSON.stringify(ev.t === 'hello' && ev.protocol === undefined ? { ...ev, protocol: PROTOCOL_VERSION } : ev)),
    log: (level, msg, data) => {
      send(JSON.stringify({ t: 'log', level, msg, data } satisfies AdapterEvent));
      // When connected, the hub already persists this via the log event; only
      // echo to stdout when standalone (else every line lands in adapter.log twice).
      if (level !== 'debug' && !open) console.log(`[${level}] ${msg}`, data ?? '');
    },
    // Written whole or not at all, with the last good copy kept (secret-file.ts).
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
    close: () => {
      closed = true;
      ws?.close();
    },
  };

  async function stop() {
    await opts.onShutdown?.();
    process.exit(0);
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return link;
}
