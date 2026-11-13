/**
 * monero-wallet-rpc's JSON-RPC with HTTP digest auth, as connectors/monero.py's Rpc does it: epee ties the nonce to the
 * connection, so the challenge and the answer go over one socket (a raw HTTP/1.1 exchange here; fetch may not keep
 * the connection). Answers are read with Python's JSON (py.parse), so amounts past 2^53 stay exact.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { py } from '@dither-accounts/statements-common';

interface Res {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

/** One keep-alive HTTP/1.1 connection, one request at a time. */
class Conn {
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private ended = false;
  private err: Error | null = null;
  private constructor(private sock: Socket) {
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, typeof d === 'string' ? Buffer.from(d) : d]);
      this.waiter?.();
    });
    sock.on('end', () => {
      this.ended = true;
      this.waiter?.();
    });
    sock.on('error', (e) => {
      this.err = e;
      this.waiter?.();
    });
  }
  static open(port: number, timeoutMs: number): Promise<Conn> {
    return new Promise((res, rej) => {
      const s = connect({ host: '127.0.0.1', port });
      const t = setTimeout(() => (s.destroy(), rej(new Error('connect timed out'))), Math.min(timeoutMs, 10_000));
      s.once('connect', () => (clearTimeout(t), res(new Conn(s))));
      s.once('error', (e) => (clearTimeout(t), rej(e)));
    });
  }
  private async more(deadline: number) {
    if (this.err) throw this.err;
    if (this.ended) throw new Error('connection closed');
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('timed out')), Math.max(0, deadline - Date.now()));
      this.waiter = () => (clearTimeout(t), (this.waiter = null), res());
    });
    if (this.err) throw this.err;
  }
  async request(path: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<Res> {
    const deadline = Date.now() + timeoutMs;
    const b = Buffer.from(body, 'utf8');
    const head = [`POST ${path} HTTP/1.1`, 'Host: 127.0.0.1', `Content-Length: ${b.length}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
    this.sock.write(Buffer.concat([Buffer.from(head, 'latin1'), b]));
    let end: number;
    while ((end = this.buf.indexOf('\r\n\r\n')) < 0) await this.more(deadline);
    const lines = this.buf.subarray(0, end).toString('latin1').split('\r\n');
    this.buf = this.buf.subarray(end + 4);
    const status = Number(lines[0].split(' ')[1]);
    const hs = lines.slice(1).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });
    const h = (k: string) => hs.find(([x]) => x.toLowerCase() === k)?.[1];
    let out: Buffer;
    if (h('transfer-encoding')?.toLowerCase().includes('chunked')) {
      const parts: Buffer[] = [];
      for (;;) {
        let le: number;
        while ((le = this.buf.indexOf('\r\n')) < 0) await this.more(deadline);
        const size = parseInt(this.buf.subarray(0, le).toString('latin1'), 16);
        while (this.buf.length < le + 2 + size + 2) await this.more(deadline);
        parts.push(this.buf.subarray(le + 2, le + 2 + size));
        this.buf = this.buf.subarray(le + 2 + size + 2);
        if (size === 0) break;
      }
      out = Buffer.concat(parts);
    } else {
      const len = Number(h('content-length') ?? 0);
      while (this.buf.length < len) await this.more(deadline);
      out = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
    }
    return { status, headers: hs, body: out };
  }
  close() {
    this.sock.destroy();
  }
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

export class RpcError extends Error {}

export class Rpc {
  private nc = 0;
  constructor(
    readonly port: number,
    private user: string,
    private pw: string,
  ) {}

  private auth(challenge: string): string {
    const f: Record<string, string> = {};
    for (const m of challenge.matchAll(/(\w+)="?([^",]*)"?/g)) f[m[1]] = m[2];
    this.nc++;
    const nc = this.nc.toString(16).padStart(8, '0');
    const cnonce = randomBytes(8).toString('hex');
    const ha1 = md5(`${this.user}:${f.realm}:${this.pw}`);
    const ha2 = md5('POST:/json_rpc');
    const resp = md5(`${ha1}:${f.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    return `Digest username="${this.user}", realm="${f.realm}", nonce="${f.nonce}", uri="/json_rpc", algorithm=MD5, response="${resp}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  }

  /** The call's `result`, as Python's JSON. */
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<py.PyValue> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
    const hdr = { 'Content-Type': 'application/json' };
    const c = await Conn.open(this.port, timeoutMs);
    let r: Res;
    try {
      r = await c.request('/json_rpc', body, hdr, timeoutMs);
      if (r.status === 401) {
        const ch = r.headers.find(([k, v]) => k.toLowerCase() === 'www-authenticate' && v.includes('algorithm=MD5,'))?.[1];
        if (!ch) throw new RpcError(`${method}: no MD5 digest challenge`);
        r = await c.request('/json_rpc', body, { ...hdr, Authorization: this.auth(ch) }, timeoutMs);
      }
      if (r.status !== 200) throw new RpcError(`${method}: HTTP ${r.status}`);
    } finally {
      c.close();
    }
    const d = py.parse(new TextDecoder().decode(r.body));
    const err = py.pyGet(d, 'error');
    if (err !== undefined) throw new RpcError(`${method}: ${String(py.toJs(py.pyGet(err, 'message')) ?? 'error')}`);
    return py.pyGet(d, 'result') ?? null;
  }
}
