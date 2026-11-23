/**
 * The little of RFB (the VNC protocol, RFC 6143) a sandbox needs to be its own viewer: the handshake with no
 * authentication (the live view's socket has none: vnc.ts, wayland.ts) as a shared client, then pointer and key events.
 * It never asks for the picture, so the server sends none.
 *
 * On Wayland this is how real input reaches the compositor: wayvnc turns each event into the compositor's virtual
 * pointer and keyboard (wlr-virtual-pointer, virtual-keyboard), which the app receives as ordinary input from its seat.
 * wayvnc makes those devices only while a client is connected, so the sandbox keeps this one connected for as long as it
 * runs: without it the seat has no pointer and no keyboard at all, and pages see no fine pointer, no hover and no focus.
 */
import { connect, type Socket } from 'node:net';

export class RfbError extends Error {}

/** A connected, shared RFB client on a Unix socket. */
export class RfbClient {
  width = 0;
  height = 0;
  name = '';
  private buf = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private ended: Error | null = null;
  private mask = 0;
  private x = 0;
  private y = 0;
  /** Past the handshake: what the server sends now (a bell, its clipboard) is not read, so it is not kept. */
  private ready = false;

  private constructor(private sock: Socket) {
    sock.on('data', (d: Buffer) => {
      if (this.ready) return;
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    const end = (why: string) => {
      this.ended ??= new RfbError(why);
      this.wake();
    };
    sock.on('error', (e) => end(`the live view's socket failed: ${e.message}`));
    sock.on('close', () => end("the live view's server closed the connection"));
  }

  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  /** True until the server goes away (or close()). */
  get open(): boolean {
    return !this.ended;
  }

  private async need(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.ended) throw this.ended;
      await new Promise<void>((r) => (this.waiting = r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Connect and shake hands (RFB 3.8, security type None, shared), within timeoutMs. */
  static async connect(path: string, timeoutMs = 10_000): Promise<RfbClient> {
    const sock = connect(path);
    const c = new RfbClient(sock);
    const timer = setTimeout(() => {
      c.ended ??= new RfbError(`no RFB handshake on ${path} within ${timeoutMs} ms`);
      sock.destroy();
      c.wake();
    }, timeoutMs);
    try {
      const version = (await c.need(12)).toString('latin1');
      if (!/^RFB 003\.00[78]\n$/.test(version)) throw new RfbError(`not an RFB 3.7/3.8 server: ${JSON.stringify(version)}`);
      sock.write('RFB 003.008\n');
      const n = (await c.need(1))[0]!;
      if (n === 0) throw new RfbError(`the server refused: ${await c.reason()}`);
      const types = [...(await c.need(n))];
      if (!types.includes(1)) throw new RfbError(`the server wants authentication (security types ${types.join(',')})`);
      sock.write(Buffer.from([1]));
      if ((await c.need(4)).readUInt32BE(0) !== 0) throw new RfbError(`the server refused: ${await c.reason()}`);
      sock.write(Buffer.from([1])); // ClientInit: shared, so the live view's viewers stay connected
      const init = await c.need(24);
      c.width = init.readUInt16BE(0);
      c.height = init.readUInt16BE(2);
      c.name = (await c.need(init.readUInt32BE(20))).toString('utf8');
      c.ready = true;
      c.buf = Buffer.alloc(0);
      return c;
    } catch (e) {
      sock.destroy();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async reason(): Promise<string> {
    try {
      return (await this.need((await this.need(4)).readUInt32BE(0))).toString('utf8');
    } catch {
      return 'no reason given';
    }
  }

  private send(b: Buffer) {
    if (this.ended) throw this.ended;
    this.sock.write(b);
  }

  /** The pointer to (x, y) with these buttons down (bit 0 left, 1 middle, 2 right, 3/4 wheel up/down). */
  pointer(x: number, y: number, mask = this.mask) {
    this.x = clampTo(x, this.width);
    this.y = clampTo(y, this.height);
    this.mask = mask;
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(this.x, 2);
    b.writeUInt16BE(this.y, 4);
    this.send(b);
  }

  /** A key down or up, by X keysym. */
  key(keysym: number, down: boolean) {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.send(b);
  }

  /** Written out to the server: what was sent before this is in the socket's buffer no longer. */
  flushed(): Promise<void> {
    return new Promise((r) => (this.sock.writableLength === 0 ? r() : this.sock.once('drain', () => r())));
  }

  close() {
    this.ended ??= new RfbError('closed');
    this.sock.destroy();
    this.wake();
  }
}

const clampTo = (v: number, size: number) => Math.max(0, Math.min(size > 0 ? size - 1 : 65535, Math.round(v)));
