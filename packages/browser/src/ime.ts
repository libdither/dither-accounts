/**
 * Text no key on the keyboard makes (é, €, emoji, CJK), typed on the wayland backend as a person with an input method
 * types it: a minimal Wayland client that is the seat's input method (input-method-unstable-v2, which sway relays to
 * the focused app's text-input-v3) and commits the text into the focused field. The page gets ordinary trusted input
 * events for it (insertText), not key presses for keys that do not exist.
 *
 * Why not a virtual keyboard with a made-up keymap (wtype's way): Chromium takes such a keymap's keycodes for real
 * keys, so the first character arrives as code "Escape" and is not inserted, and characters outside the BMP not at all.
 *
 * Only what this needs of the wire protocol: wl_display, wl_registry, wl_callback, wl_seat, the input method manager
 * and one input method. Messages are little-endian 32-bit words: object id, then size << 16 | opcode, then arguments
 * (strings are a length with the NUL, the bytes, padded to 4).
 */
import { connect, type Socket } from 'node:net';

const DISPLAY = 1;

export class ImeError extends Error {}

/** One Wayland message's bytes. */
export function message(object: number, opcode: number, args: (number | string)[]): Buffer {
  const parts: Buffer[] = [];
  for (const a of args) {
    if (typeof a === 'number') {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(a >>> 0, 0);
      parts.push(b);
    } else {
      const s = Buffer.from(`${a}\0`, 'utf8');
      const b = Buffer.alloc(4 + Math.ceil(s.length / 4) * 4);
      b.writeUInt32LE(s.length, 0);
      s.copy(b, 4);
      parts.push(b);
    }
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(object, 0);
  head.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([head, body]);
}

/** A string argument at `at` in a message body, and where the next argument starts. */
export function readString(body: Buffer, at: number): { value: string; next: number } {
  const len = body.readUInt32LE(at);
  const value = len ? body.subarray(at + 4, at + 4 + len - 1).toString('utf8') : '';
  return { value, next: at + 4 + Math.ceil(len / 4) * 4 };
}

type Event = { object: number; opcode: number; body: Buffer };

/** The seat's input method on a compositor's socket; commit() types text into whatever has the focus. */
export class InputMethod {
  private nextId = 2;
  private buf = Buffer.alloc(0);
  private events: Event[] = [];
  private waiting: (() => void) | null = null;
  private ended: Error | null = null;
  private im = 0;
  /** done events seen: the serial a commit answers. */
  private serial = 0;
  /** A text input has the focus and is enabled (activate … done). */
  active = false;
  private unavailable = false;

  private constructor(private sock: Socket) {
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 8) {
        const size = this.buf.readUInt32LE(4) >>> 16;
        if (size < 8 || this.buf.length < size) break;
        this.events.push({ object: this.buf.readUInt32LE(0), opcode: this.buf.readUInt32LE(4) & 0xffff, body: this.buf.subarray(8, size) });
        this.buf = this.buf.subarray(size);
      }
      this.wake();
    });
    const end = (why: string) => {
      this.ended ??= new ImeError(why);
      this.wake();
    };
    sock.on('error', (e) => end(`the compositor's socket failed: ${e.message}`));
    sock.on('close', () => end('the compositor closed the connection'));
  }

  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private send(object: number, opcode: number, args: (number | string)[] = []) {
    if (this.ended) throw this.ended;
    this.sock.write(message(object, opcode, args));
  }

  /** The next event that `pick` takes; events it does not take are handled as they come (the input method's state). */
  private async next<T>(pick: (e: Event) => T | undefined, deadline: number): Promise<T> {
    for (;;) {
      while (this.events.length) {
        const e = this.events.shift()!;
        this.handle(e);
        const v = pick(e);
        if (v !== undefined) return v;
      }
      if (this.ended) throw this.ended;
      if (Date.now() > deadline) throw new ImeError('the compositor did not answer in time');
      await new Promise<void>((r) => {
        this.waiting = r;
        setTimeout(() => this.wake(), Math.max(1, deadline - Date.now()));
      });
    }
  }

  private handle(e: Event) {
    if (e.object === DISPLAY && e.opcode === 0) {
      const code = e.body.readUInt32LE(4);
      this.ended ??= new ImeError(`Wayland protocol error ${code}: ${readString(e.body, 8).value}`);
    }
    if (e.object !== this.im || !this.im) return;
    // zwp_input_method_v2 events: 0 activate, 1 deactivate, 5 done, 6 unavailable.
    if (e.opcode === 0) this.pending = true;
    else if (e.opcode === 1) this.pending = false;
    else if (e.opcode === 5) {
      this.serial++;
      this.active = this.pending;
    } else if (e.opcode === 6) this.unavailable = true;
  }
  private pending = false;

  /** Everything sent so far has been handled by the compositor (wl_display.sync). */
  private async roundtrip(deadline: number) {
    const cb = this.nextId++;
    this.send(DISPLAY, 0, [cb]);
    await this.next((e) => (e.object === cb && e.opcode === 0 ? true : undefined), deadline);
  }

  /** Connect to the compositor at `socket` and become its seat's input method. */
  static async connect(socket: string, timeoutMs = 5000): Promise<InputMethod> {
    const deadline = Date.now() + timeoutMs;
    const sock = connect(socket);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    const ime = new InputMethod(sock);
    try {
      const registry = ime.nextId++;
      ime.send(DISPLAY, 1, [registry]);
      const globals: { name: number; iface: string; version: number }[] = [];
      const sync = ime.nextId++;
      ime.send(DISPLAY, 0, [sync]);
      await ime.next((e) => {
        if (e.object === registry && e.opcode === 0) {
          const { value, next } = readString(e.body, 4);
          globals.push({ name: e.body.readUInt32LE(0), iface: value, version: e.body.readUInt32LE(next) });
        }
        return e.object === sync && e.opcode === 0 ? true : undefined;
      }, deadline);
      const seat = globals.find((g) => g.iface === 'wl_seat');
      const manager = globals.find((g) => g.iface === 'zwp_input_method_manager_v2');
      if (!seat || !manager) throw new ImeError(`the compositor has no ${seat ? 'input method manager (input-method-unstable-v2)' : 'seat'}`);
      const seatId = ime.nextId++;
      ime.send(registry, 0, [seat.name, 'wl_seat', 1, seatId]);
      const managerId = ime.nextId++;
      ime.send(registry, 0, [manager.name, 'zwp_input_method_manager_v2', 1, managerId]);
      ime.im = ime.nextId++;
      ime.send(managerId, 0, [seatId, ime.im]);
      await ime.roundtrip(deadline);
      if (ime.unavailable) throw new ImeError('another input method has the seat');
      return ime;
    } catch (e) {
      sock.destroy();
      throw e;
    }
  }

  /** Wait until a text input has the focus (the field the click focused); false if none does within timeoutMs. */
  async waitActive(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    await this.roundtrip(deadline);
    while (!this.active) {
      try {
        await this.next((e) => (e.object === this.im && e.opcode === 5 ? true : undefined), deadline);
      } catch (e) {
        if (e instanceof ImeError && !this.ended) return false;
        throw e;
      }
    }
    return true;
  }

  /** Type `text` into the focused text input, as one commit. */
  async commit(text: string, timeoutMs = 5000) {
    if (!this.active) throw new ImeError('no text field has the focus');
    if (this.unavailable) throw new ImeError('another input method has the seat');
    this.send(this.im, 0, [text]); // commit_string
    this.send(this.im, 3, [this.serial]); // commit
    await this.roundtrip(Date.now() + timeoutMs);
    if (this.ended) throw this.ended;
  }

  close() {
    if (!this.ended && this.im) {
      try {
        this.send(this.im, 6); // destroy
      } catch {}
    }
    this.ended ??= new ImeError('closed');
    this.sock.end();
  }
}
