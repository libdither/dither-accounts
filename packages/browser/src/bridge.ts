/**
 * The extractor's own little WebSocket server (extractors/discord's, generalized). The sandbox extension's service
 * worker connects to ws://127.0.0.1:<port>/?token=…; nothing else may talk to the page's hook. Bound to loopback,
 * token-gated, port 0 by default (any free one).
 *
 * Up from the extension: `{ t: 'reply', id, ok, result | error }` for commands, anything else to onMessage.
 * Down to it: `{ t: 'cmd', id, cmd }` (request) and `{ t: 'ping' }`.
 */
import type { Server, ServerWebSocket } from 'bun';
import type { Log } from './sandbox.ts';

type SocketData = { authed: boolean };

export type BridgeReply = { t: 'reply'; id: string; ok: true; result?: unknown } | { t: 'reply'; id: string; ok: false; error: string; retryAfter?: number };

export interface BridgeServerOpts<Up> {
  /** 0 (the default): any free loopback port; read `port` after start(). */
  port?: number;
  token: string;
  onMessage: (msg: Up) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  log: Log;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeServer<Up extends { t: string } = { t: string; [k: string]: unknown }, Cmd extends { kind: string } = { kind: string; [k: string]: unknown }> {
  private server?: Server<SocketData>;
  private sock: ServerWebSocket<SocketData> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private opts: BridgeServerOpts<Up>) {}

  get connected(): boolean {
    return !!this.sock;
  }
  get port(): number {
    return this.server?.port ?? this.opts.port ?? 0;
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
          if (msg.t === 'reply') {
            const r = msg as BridgeReply;
            const p = self.pending.get(r.id);
            if (p) {
              self.pending.delete(r.id);
              clearTimeout(p.timer);
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

  /** Run a command in the page and await its reply. */
  request<T = unknown>(cmd: Cmd, timeoutMs = 30_000): Promise<T> {
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

  /** Traffic that keeps the extension's service worker awake. */
  ping() {
    if (this.sock) this.sendDown({ t: 'ping' });
  }

  stop() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('extractor shutting down'));
    }
    this.pending.clear();
    this.server?.stop(true);
  }
}
