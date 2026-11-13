/**
 * JSON-RPC 2.0 client for `signal-cli daemon --socket`: one JSON object per
 * line in both directions (signal-cli-jsonrpc(5)). Requests are matched by id
 * and may run concurrently (signal-cli handles each on its own virtual
 * thread); `receive` notifications carry incoming envelopes.
 */

import type { Socket } from 'bun';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

export interface RpcClientOptions {
  /** `receive` and other server-initiated notifications. */
  onNotification: (method: string, params: any) => void;
  /** The connection went away (daemon exited or closed it). */
  onClose?: (err?: Error) => void;
  defaultTimeoutMs?: number;
}

export class RpcClient {
  private sock: Socket<undefined> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = '';
  private decoder = new TextDecoder();
  private outbox: Uint8Array[] = [];
  private closed = false;

  constructor(private opts: RpcClientOptions) {}

  /** Connect to a UNIX socket; resolves once connected. */
  static async connect(path: string, opts: RpcClientOptions): Promise<RpcClient> {
    const c = new RpcClient(opts);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      Bun.connect({
        unix: path,
        socket: {
          open: (s) => {
            c.sock = s;
            settled = true;
            resolve();
          },
          data: (_s, chunk) => c.onData(chunk),
          drain: () => c.flush(),
          close: () => c.onClosed(),
          error: (_s, err) => c.onClosed(err),
          connectError: (_s, err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          },
        },
      }).catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
    return c;
  }

  get open() {
    return !!this.sock && !this.closed;
  }

  call<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.open) return Promise.reject(new Error(`signal-cli is not connected (${method})`));
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && Object.keys(params).length ? { params } : {}) }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signal-cli timed out on ${method}`));
      }, timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.outbox.push(Buffer.from(line));
      this.flush();
    });
  }

  close() {
    if (this.closed) return;
    this.sock?.end();
    this.onClosed();
  }

  private flush() {
    const s = this.sock;
    if (!s || this.closed) return;
    while (this.outbox.length) {
      const bytes = this.outbox[0];
      const n = s.write(bytes);
      if (n < 0) return; // closed underneath us
      if (n < bytes.length) {
        this.outbox[0] = bytes.subarray(n);
        return; // wait for drain
      }
      this.outbox.shift();
    }
  }

  private onData(chunk: Uint8Array) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const handle = (m: any) => {
      if (m && typeof m === 'object' && 'id' in m && m.id !== null && ('result' in m || 'error' in m)) {
        const p = this.pending.get(Number(m.id));
        if (!p) return;
        this.pending.delete(Number(m.id));
        clearTimeout(p.timer);
        if (m.error) p.reject(new RpcError(String(m.error.message ?? 'signal-cli error'), Number(m.error.code ?? 0), m.error.data));
        else p.resolve(m.result);
      } else if (m && typeof m.method === 'string') {
        try {
          this.opts.onNotification(m.method, m.params);
        } catch (e) {
          console.error('[signal] notification handler failed', e);
        }
      }
    };
    if (Array.isArray(msg)) msg.forEach(handle);
    else handle(msg);
  }

  private onClosed(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.sock = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`signal-cli connection closed during ${p.method}`));
    }
    this.pending.clear();
    this.opts.onClose?.(err);
  }
}
