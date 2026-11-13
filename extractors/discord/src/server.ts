/**
 * The adapter's own little WebSocket server. The extension's service worker
 * connects to ws://127.0.0.1:<port>/?token=... from inside the sandbox; this is
 * the only thing that may talk to the hook. Bound to loopback, token-gated.
 *
 * It also correlates request/reply ids so the adapter can await a hook command,
 * and carries a human-pacing queue so outgoing Discord actions are spaced out.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { BridgeDown, BridgeUp, HookCommand } from './discord-types.ts';
import { phase } from './trace.ts';

type SocketData = { authed: boolean };

export interface BridgeServerOpts {
  port: number;
  token: string;
  onMessage: (msg: BridgeUp) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeServer {
  private server?: Server<SocketData>;
  private sock: ServerWebSocket<SocketData> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private opts: BridgeServerOpts) {}

  get connected(): boolean {
    return !!this.sock;
  }
  get port(): number {
    return this.server?.port ?? this.opts.port;
  }

  start() {
    const self = this;
    this.server = Bun.serve<SocketData, never>({
      port: this.opts.port,
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
          self.sock = ws;
          self.opts.log('info', 'extension connected');
          self.opts.onConnect?.();
        },
        message(ws, raw) {
          let msg: BridgeUp;
          try {
            msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          } catch {
            return;
          }
          if (msg.t === 'reply') {
            const p = self.pending.get(msg.id);
            if (p) {
              self.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.ok) p.resolve(msg.result);
              else p.reject(Object.assign(new Error(msg.error), { retry_after: msg.retryAfter }));
            }
            return;
          }
          self.opts.onMessage(msg);
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

  private sendDown(payload: BridgeDown) {
    if (!this.sock) throw new Error('extension not connected');
    this.sock.send(JSON.stringify(payload));
  }

  /** Run a command in the page and await its reply. */
  request<T = unknown>(cmd: HookCommand, timeoutMs = 30_000): Promise<T> {
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      if (!this.sock) return reject(new Error('extension not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hook timed out on ${cmd.kind}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.sendDown({ t: 'cmd', id, cmd });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  ping() {
    if (this.sock) this.sock.send(JSON.stringify({ t: 'ping' } satisfies BridgeDown));
  }

  stop() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('adapter shutting down'));
    }
    this.pending.clear();
    this.server?.stop(true);
  }
}

/**
 * Serializes outgoing Discord actions with a human-ish gap + jitter, so a burst of
 * hub commands never fires faster than a person could. Sends and history share the
 * queue; history additionally backs off hard on a 429.
 */
export class PaceQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private penaltyUntil = 0;

  constructor(private opts: { minGapMs: number; jitterMs: number; log: (m: string, d?: unknown) => void }) {}

  run<T>(label: string, fn: () => Promise<T>, extraDelayMs = 0): Promise<T> {
    const queued = Date.now();
    const task = this.chain.then(async () => {
      const now = Date.now();
      const base = this.opts.minGapMs + Math.random() * this.opts.jitterMs + extraDelayMs;
      const waitForGap = Math.max(0, this.last + base - now);
      const waitForPenalty = Math.max(0, this.penaltyUntil - now);
      const wait = Math.max(waitForGap, waitForPenalty);
      if (wait > 0) await Bun.sleep(wait);
      // On the command's span, if it has one (trace.ts): how long it waited its turn.
      phase('paced', { label, waitMs: Math.round(Date.now() - queued) });
      this.last = Date.now();
      try {
        return await fn();
      } catch (e: any) {
        // Discord REST surfaces 429s with retry_after (seconds).
        const retry = e?.retry_after ?? e?.body?.retry_after ?? e?.retryAfter;
        if (retry) {
          this.penaltyUntil = Date.now() + Number(retry) * 1000 + 500;
          this.opts.log(`429 on ${label}; backing off`, { retryAfterMs: Number(retry) * 1000 });
        }
        throw e;
      }
    });
    // keep the chain from rejecting and stalling later tasks
    this.chain = task.catch(() => undefined);
    return task as Promise<T>;
  }
}
