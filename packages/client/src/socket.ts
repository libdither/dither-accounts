/**
 * The client's socket to the manager: a small RFC 6455 WebSocket client over a TCP socket, with the parts of the
 * browser WebSocket the client uses (onopen, onmessage with text, onclose with a code, send, close, readyState).
 *
 * Why not the runtime's WebSocket: Bun's (1.4.2 to at least 1.4.5) now and then fails a socket with 1002 ("unsupported
 * control frame", "control frame is fragmented") on a stream of well-formed frames, in a process that is busy with
 * other sockets. Recorded on the wire, both directions were valid up to the failure. A dropped socket fails every
 * write in flight `unsure`, so the client frames its own messages instead.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A message bigger than this is refused (close 1009): the manager's own limit. */
const MAX_MESSAGE = 64 * 1024 * 1024;

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export class ManagerSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  private sock: Socket;
  private key = randomBytes(16).toString('base64');
  private buf: Buffer = Buffer.alloc(0);
  /** Chunks of a frame still coming in, joined once it is all there (joining on every chunk is quadratic). */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** How many bytes the buffer needs for the frame at its start; 0 when not known. */
  private need = 0;
  private upgraded = false;
  /** A fragmented message's parts so far, and whether it is text. */
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private closeCode = 1006;
  private closeReason = '';
  private ended = false;

  constructor(url: string) {
    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    this.sock = secure ? tlsConnect({ host, port, servername: host }) : connect({ host, port });
    this.sock.setNoDelay(true);
    this.sock.once(secure ? 'secureConnect' : 'connect', () => {
      this.sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    this.sock.on('data', (d: Buffer) => this.take(d));
    this.sock.on('error', (e) => this.onerror?.(e));
    this.sock.on('close', () => this.finish());
  }

  send(text: string) {
    if (this.readyState !== OPEN) throw new Error('the socket is not open');
    this.frame(0x1, Buffer.from(text));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    if (this.readyState === CONNECTING) {
      this.readyState = CLOSING;
      this.closeCode = 1006;
      this.sock.destroy();
      return;
    }
    this.readyState = CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.frame(0x8, p);
    // The server answers with its own close and ends the connection; if it does not, end it here.
    setTimeout(() => this.sock.destroy(), 2000).unref?.();
  }

  private frame(op: number, payload: Buffer) {
    const mask = randomBytes(4);
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(6) : n < 65536 ? Buffer.alloc(8) : Buffer.alloc(14);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = 0x80 | n;
    else if (n < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    mask.copy(head, head.length - 4);
    const body = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([head, body]));
  }

  private take(d: Buffer) {
    if (this.need) {
      this.pending.push(d);
      this.pendingBytes += d.length;
      if (this.buf.length + this.pendingBytes < this.need) return;
      this.buf = Buffer.concat([this.buf, ...this.pending]);
      this.pending = [];
      this.pendingBytes = 0;
      this.need = 0;
    } else this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.upgraded) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buf.length > 16_384) this.fail(1002, 'no handshake');
        return;
      }
      const head = this.buf.subarray(0, end).toString('latin1');
      this.buf = this.buf.subarray(end + 4);
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      const want = createHash('sha1').update(this.key + GUID).digest('base64');
      if (!/^HTTP\/1\.1 101 /.test(head) || accept !== want) return this.fail(1006, `refused: ${head.split('\r\n')[0]}`);
      this.upgraded = true;
      this.readyState = OPEN;
      this.onopen?.();
    }
    while (this.readyState !== CLOSED && this.parse());
  }

  /** One frame from the buffer, if all of it is there. */
  private parse(): boolean {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    if (b[0] & 0x70) return this.fail(1002, 'reserved bits set'), false;
    if (b[1] & 0x80) return this.fail(1002, 'a masked frame from the server'), false;
    let n = b[1] & 0x7f;
    let at = 2;
    if (n === 126) {
      if (b.length < 4) return false;
      n = b.readUInt16BE(2);
      at = 4;
    } else if (n === 127) {
      if (b.length < 10) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) return this.fail(1009, 'message too big'), false;
      n = Number(big);
      at = 10;
    }
    if (b.length < at + n) {
      this.need = at + n;
      return false;
    }
    const payload = b.subarray(at, at + n);
    this.buf = b.subarray(at + n);
    if (op >= 0x8) {
      if (!fin || n > 125) return this.fail(1002, 'bad control frame'), false;
      if (op === 0x8) this.closed(payload);
      else if (op === 0x9 && this.readyState === OPEN) this.frame(0xa, Buffer.from(payload));
      else if (op !== 0xa) return this.fail(1002, `unknown opcode ${op}`), false;
      return true;
    }
    if (op !== 0x0 && op !== 0x1 && op !== 0x2) return this.fail(1002, `unknown opcode ${op}`), false;
    if ((op === 0x0) !== this.parts.length > 0) return this.fail(1002, 'continuation out of place'), false;
    this.partsBytes += n;
    if (this.partsBytes > MAX_MESSAGE) return this.fail(1009, 'message too big'), false;
    this.parts.push(Buffer.from(payload));
    if (fin) {
      const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.parts = [];
      this.partsBytes = 0;
      if (this.readyState === OPEN) this.onmessage?.({ data: whole.toString('utf8') });
    }
    return true;
  }

  /** The server's close: answered with ours (when we did not start it), then the connection ends. */
  private closed(payload: Buffer) {
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
    if (this.readyState === OPEN) {
      this.readyState = CLOSING;
      this.closeCode = code;
      this.closeReason = reason;
      const p = payload.length >= 2 ? Buffer.from(payload.subarray(0, 2)) : Buffer.alloc(0);
      this.frame(0x8, p);
    } else {
      this.closeCode = code;
      this.closeReason = reason;
    }
    this.sock.end();
  }

  private fail(code: number, reason: string) {
    this.closeCode = code;
    this.closeReason = reason;
    this.sock.destroy();
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.readyState = CLOSED;
    this.onclose?.({ code: this.closeCode, reason: this.closeReason });
  }
}
