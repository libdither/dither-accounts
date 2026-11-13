/**
 * Adapter-side link to the hub. Every out-of-process adapter uses this:
 *
 *   const hub = linkHub({
 *     onConnect: () => { hub.emit({ t: 'hello', ... }); resendSnapshot(); },
 *     onCommand: async (cmd) => { ...; return result },   // auto-replied if cmd has an id
 *   });
 *
 * Events emitted while disconnected are queued (bounded) and flushed on reconnect.
 * Throwing from onCommand sends { ok: false, error }.
 */

import { join } from 'node:path';
import { PROTOCOL_VERSION, type AdapterCommand, type AdapterEvent } from './adapter.ts';
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
  close(): void;
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
  let ws: WebSocket | null = null;
  let open = false;
  let closed = false;
  let attempt = 0;

  const send = (s: string) => {
    if (open && ws) ws.send(s);
    else {
      queue.push(s);
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    }
  };

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      open = true;
      attempt = 0;
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
      if (cmd.t === 'shutdown') {
        await opts.onShutdown?.();
        process.exit(0);
      }
      try {
        const result = await opts.onCommand(cmd);
        if ('id' in cmd) send(JSON.stringify({ t: 'reply', id: cmd.id, ok: true, result } satisfies AdapterEvent));
      } catch (err: any) {
        if ('id' in cmd) send(JSON.stringify({ t: 'reply', id: cmd.id, ok: false, error: String(err?.message ?? err) } satisfies AdapterEvent));
      }
    };
    ws.onclose = () => {
      open = false;
      if (closed) return;
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      setTimeout(connect, delay);
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
    close: () => {
      closed = true;
      ws?.close();
    },
  };

  const stop = async () => {
    await opts.onShutdown?.();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return link;
}
