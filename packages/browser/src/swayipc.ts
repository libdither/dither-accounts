/**
 * sway's IPC (sway-ipc(7)) over its Unix socket, which is in the sandbox's own runtime directory (wayland.ts): requests
 * answered in order, and the events a connection subscribed to. What the Wayland backend asks: whether the output has
 * its size yet, whether the seat has the pointer and keyboard the live view's server makes, the windows, and commands.
 */
import { connect, type Socket } from 'node:net';

const MAGIC = Buffer.from('i3-ipc');
export const IPC = { RUN_COMMAND: 0, SUBSCRIBE: 2, GET_OUTPUTS: 3, GET_TREE: 4, GET_SEATS: 101 } as const;
/** An event's type has the high bit set; window events are 0x80000003. */
export const EVENT_WINDOW = 0x80000003;

/** A node of GET_TREE: outputs, workspaces, containers and the windows (views) in them. */
export interface SwayNode {
  id: number;
  type: 'root' | 'output' | 'workspace' | 'con' | 'floating_con';
  name: string | null;
  app_id?: string | null;
  /** How the window reached sway: xdg_shell (every Wayland app, X apps through xwayland-satellite too) or xwayland. */
  shell?: string;
  pid?: number;
  rect: { x: number; y: number; width: number; height: number };
  focused?: boolean;
  nodes: SwayNode[];
  floating_nodes: SwayNode[];
}

/** Every window (a con or floating_con with an app behind it) under a node. */
export function views(n: SwayNode): SwayNode[] {
  const out: SwayNode[] = [];
  const walk = (x: SwayNode) => {
    if ((x.type === 'con' || x.type === 'floating_con') && x.pid !== undefined && x.nodes.length === 0) out.push(x);
    for (const c of [...x.nodes, ...x.floating_nodes]) walk(c);
  };
  walk(n);
  return out;
}

/** One sway IPC message's bytes. */
export function ipcMessage(type: number, payload = ''): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const head = Buffer.alloc(14);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(body.length, 6);
  head.writeUInt32LE(type >>> 0, 10);
  return Buffer.concat([head, body]);
}

/** How long a request waits for its reply by default: sway answers in milliseconds, or is stuck. */
export const IPC_REQUEST_MS = 5000;

export class SwayIpc {
  private buf = Buffer.alloc(0);
  private replies: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private ended: Error | null = null;
  private endedNow!: (e: Error) => void;
  /** Resolves with why, once the connection is over (sway went away, an unanswered request, close()). */
  readonly closed = new Promise<Error>((r) => (this.endedNow = r));
  /** Events this connection subscribed to, by type. */
  onEvent: ((type: number, body: any) => void) | null = null;

  private constructor(private sock: Socket) {
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 14) {
        if (!this.buf.subarray(0, 6).equals(MAGIC)) return this.end('not sway IPC');
        const len = this.buf.readUInt32LE(6);
        if (this.buf.length < 14 + len) break;
        const type = this.buf.readUInt32LE(10);
        let body: unknown;
        try {
          body = JSON.parse(this.buf.subarray(14, 14 + len).toString('utf8'));
        } catch {
          body = null;
        }
        this.buf = this.buf.subarray(14 + len);
        if (type & 0x80000000) this.onEvent?.(type >>> 0, body);
        else this.replies.shift()?.resolve(body);
      }
    });
    sock.on('error', (e) => this.end(e.message));
    sock.on('close', () => this.end('sway closed its IPC socket'));
  }

  private end(why: string) {
    this.ended ??= new Error(why);
    for (const r of this.replies.splice(0)) r.reject(this.ended);
    this.endedNow(this.ended);
  }

  get open() {
    return !this.ended;
  }

  static connect(path: string, timeoutMs = IPC_REQUEST_MS): Promise<SwayIpc> {
    return new Promise((resolve, reject) => {
      const sock = connect(path);
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`sway's IPC socket did not take the connection within ${timeoutMs} ms`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(t);
        sock.removeListener('error', fail);
        resolve(new SwayIpc(sock));
      });
      const fail = (e: Error) => {
        clearTimeout(t);
        reject(e);
      };
      sock.once('error', fail);
    });
  }

  /**
   * One request and its reply, parsed. A reply that does not come within `timeoutMs` rejects it and ends the
   * connection: replies come in order, so a later one could not be told from the late one.
   */
  request<T = unknown>(type: number, payload = '', timeoutMs = IPC_REQUEST_MS): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.end(`sway did not answer within ${timeoutMs} ms`);
        this.sock.destroy();
      }, timeoutMs);
      const done = (f: () => void) => {
        clearTimeout(t);
        f();
      };
      this.replies.push({ resolve: (v) => done(() => resolve(v as T)), reject: (e) => done(() => reject(e)) });
      this.sock.write(ipcMessage(type, payload));
    });
  }

  /** sway commands (sway(5)); throws with sway's own words when one fails. */
  async command(cmd: string, timeoutMs?: number): Promise<void> {
    const r = await this.request<{ success: boolean; error?: string }[]>(IPC.RUN_COMMAND, cmd, timeoutMs);
    const bad = r.find((x) => !x.success);
    if (bad) throw new Error(`sway: ${bad.error ?? 'the command failed'} (${cmd.slice(0, 120)})`);
  }

  tree(timeoutMs?: number): Promise<SwayNode> {
    return this.request<SwayNode>(IPC.GET_TREE, '', timeoutMs);
  }

  close() {
    this.end('closed');
    this.sock.destroy();
  }
}
