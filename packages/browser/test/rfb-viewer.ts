/**
 * A full RFB viewer of our own, for the tests and the display benchmarks (scripts/bench-lib.ts re-exports it): the
 * handshake (RFB 3.8, security None, shared), a pixel format of its own, the encodings asked for, every update read
 * (raw kept as a picture; Tight, ZRLE, JPEG, H.264 and the rest read past and counted), the server's clipboard, and
 * pointer, key and clipboard events. It asks as noVNC does (`novnc`) or for every frame at once (`eager`).
 *
 * The sandbox's own client is packages/browser/src/rfb.ts: input only, never the picture.
 */
import { connect, type Socket } from 'node:net';

export const ENC = {
  raw: 0,
  copyRect: 1,
  rre: 2,
  hextile: 5,
  zlib: 6,
  tight: 7,
  zrle: 16,
  jpeg: 21,
  h264: 50,
  tightPng: -260,
  desktopSize: -223,
  lastRect: -224,
  cursor: -239,
  qemuKey: -258,
  qemuLed: -261,
  desktopName: -307,
  extDesktopSize: -308,
  xvp: -309,
  fence: -312,
  continuousUpdates: -313,
  extMouseButtons: -316,
  vmwareCursor: 0x574d5664,
  extClipboard: 0xc0a1e5ce | 0,
  /** KasmVNC's: Tight rectangles as WebP (Tight subtype 0x0b) for a client that asks, as its own web client does. */
  kasmWebp: -1024,
  /** KasmVNC's lossless QOI (Tight subtype 0x0c), which its client asks for only when told to. */
  kasmQoi: -1886,
  /** Quality level n is qualityLevel0 + n; compress level n is compressLevel0 + n. */
  qualityLevel0: -32,
  compressLevel0: -256,
} as const;
const TIGHT_KIND: Record<number, string> = { 8: 'fill', 9: 'jpeg', 10: 'png', 11: 'webp', 12: 'qoi', 13: 'kasm-0x0d' };
export const ENC_NAME: Record<number, string> = { 0: 'raw', 1: 'copyrect', 5: 'hextile', 6: 'zlib', 7: 'tight', 16: 'zrle', 50: 'open-h264', [-260]: 'tightpng', [-223]: 'desktop-size', [-224]: 'last-rect', [-239]: 'cursor', [ENC.vmwareCursor]: 'vmware-cursor', [-307]: 'desktop-name', [-308]: 'ext-desktop-size', [-261]: 'led' };

/**
 * What the manager's live view asks for: noVNC 1.7's list in its order (core/rfb.js, _sendEncodings) at 24-bit depth,
 * with its default quality 6 and compression 2. noVNC puts Open H.264 after CopyRect when the browser decodes H.264
 * with WebCodecs (Chromium and Firefox do), so `h264` adds it as the manager's page would.
 */
export function novncEncodings(h264 = true): number[] {
  return [
    ENC.copyRect,
    ...(h264 ? [ENC.h264] : []),
    ENC.tight,
    ENC.tightPng,
    ENC.zrle,
    ENC.jpeg,
    ENC.hextile,
    ENC.rre,
    ENC.zlib,
    ENC.raw,
    ENC.qualityLevel0 + 6,
    ENC.compressLevel0 + 2,
    ENC.desktopSize,
    ENC.lastRect,
    ENC.qemuKey,
    ENC.qemuLed,
    ENC.extDesktopSize,
    ENC.xvp,
    ENC.fence,
    ENC.continuousUpdates,
    ENC.desktopName,
    ENC.extClipboard,
    ENC.extMouseButtons,
    ENC.vmwareCursor,
    ENC.cursor,
  ];
}

export interface ViewerOptions {
  encodings: number[];
  /** Keep the picture (only raw rectangles are drawn into it). */
  keepPicture?: boolean;
  /**
   * When to ask for the next update. `novnc`: once the whole update has arrived, and continuous updates and fences as
   * noVNC answers them (what the manager's live view does). `eager`: as soon as an update's header arrives.
   */
  mode?: 'novnc' | 'eager';
}

/** A viewer: asks for every frame (incremental), counts them and their bytes, and keeps the picture when raw. */
export class Viewer {
  private sock: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private wait: (() => void) | null = null;
  private closed = false;
  private mode: 'novnc' | 'eager' = 'eager';
  private continuous = false;
  width = 0;
  height = 0;
  /** FramebufferUpdate messages, empty ones too: a server with continuous updates sends many small ones. */
  updates = 0;
  /**
   * Frames as a 60 Hz screen would show them: the 1/60 s slots in which pixels arrived. A server that splits one frame
   * over several updates (TigerVNC with continuous updates) counts once per slot, so this is what to compare;
   * `updates` is not.
   */
  frames = 0;
  private slot = -1;
  bytes = 0;
  encodings: Record<string, number> = {};
  /** Tight rectangles by their kind: fill, jpeg, png, webp, qoi, basic (zlib) — what the bytes went to. */
  tightKinds: Record<string, number> = {};
  /** Server messages beyond updates (continuous-updates, fence, clipboard...): how many of each. */
  messages: Record<string, number> = {};
  /** The server's clipboard texts (ServerCutText, latin-1), in order. */
  cut: string[] = [];
  /** Waiters for the next whole update or message (changed()). */
  private changes: (() => void)[] = [];
  fb: Uint8Array | null = null;
  /** performance.now() at: the socket connected, the server's init arrived, the first whole update arrived. */
  t = { open: 0, connected: 0, init: 0, firstFrame: 0 };
  error: string | null = null;
  /** Called after each whole update. */
  onUpdate: (() => void) | null = null;
  /** Called for each rectangle of pixels as soon as it has arrived. */
  onRect: ((x: number, y: number, w: number, h: number, enc: number) => void) | null = null;

  private constructor(path: string) {
    this.t.open = performance.now();
    this.sock = connect(path);
    this.sock.on('connect', () => (this.t.connected = performance.now()));
    this.sock.on('data', (d: Buffer) => {
      this.bytes += d.length;
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      const w = this.wait;
      this.wait = null;
      w?.();
    });
    this.sock.on('close', () => {
      this.closed = true;
      this.wait?.();
    });
    this.sock.on('error', () => {});
  }

  private async need(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.closed) throw new Error('the server closed the connection');
      await new Promise<void>((r) => (this.wait = r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  static async open(path: string, encodings: number[] | ViewerOptions, keepPicture = false): Promise<Viewer> {
    const o: ViewerOptions = Array.isArray(encodings) ? { encodings, keepPicture } : encodings;
    const v = new Viewer(path);
    v.mode = o.mode ?? 'eager';
    await v.need(12);
    v.sock.write('RFB 003.008\n');
    const n = (await v.need(1))[0]!;
    await v.need(n);
    v.sock.write(Buffer.from([1]));
    await v.need(4);
    v.sock.write(Buffer.from([1]));
    const init = await v.need(24);
    v.width = init.readUInt16BE(0);
    v.height = init.readUInt16BE(2);
    await v.need(init.readUInt32BE(20));
    v.t.init = performance.now();
    // 32 bpp, depth 24, little endian, true colour, 255 each, R at 16, G at 8, B at 0.
    const pf = Buffer.alloc(20);
    pf[0] = 0;
    pf[4] = 32;
    pf[5] = 24;
    pf[6] = 0;
    pf[7] = 1;
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf[14] = 16;
    pf[15] = 8;
    pf[16] = 0;
    v.sock.write(pf);
    const se = Buffer.alloc(4 + 4 * o.encodings.length);
    se[0] = 2;
    se.writeUInt16BE(o.encodings.length, 2);
    o.encodings.forEach((e, i) => se.writeInt32BE(e | 0, 4 + 4 * i));
    v.sock.write(se);
    if (o.keepPicture) v.fb = new Uint8Array(v.width * v.height * 4);
    v.bytes = 0;
    void v.loop();
    return v;
  }

  private request(incremental: boolean) {
    const r = Buffer.alloc(10);
    r[0] = 3;
    r[1] = incremental ? 1 : 0;
    r.writeUInt16BE(this.width, 6);
    r.writeUInt16BE(this.height, 8);
    this.sock.write(r);
  }

  /** Tight's compact length: 1 to 3 bytes, 7 bits each. */
  private async compactLength(): Promise<number> {
    let len = 0;
    for (let i = 0; i < 3; i++) {
      const b = (await this.need(1))[0]!;
      len |= (i === 2 ? b : b & 0x7f) << (7 * i);
      if (!(b & 0x80) || i === 2) break;
    }
    return len;
  }

  /** A Tight (or TightPNG) rectangle's bytes, read past without decoding (pixels are 3 bytes at depth 24). */
  private async tight(w: number, h: number) {
    const ctl = (await this.need(1))[0]!;
    const kind = ctl >> 4;
    const name = TIGHT_KIND[kind] ?? (kind < 8 ? 'basic' : `kind${kind}`);
    this.tightKinds[name] = (this.tightKinds[name] ?? 0) + 1;
    if (kind === 8) return void (await this.need(3));
    // JPEG, PNG (TightPNG), and KasmVNC's WebP, QOI and 0x0d: a compact length, then that many bytes.
    if (kind >= 9 && kind <= 13) return void (await this.need(await this.compactLength()));
    if (kind > 13) throw new Error(`Tight subtype ${kind}, which this viewer does not read`);
    let size = w * h * 3;
    if (kind & 4) {
      const filter = (await this.need(1))[0]!;
      if (filter === 1) {
        const colours = (await this.need(1))[0]! + 1;
        await this.need(colours * 3);
        size = colours === 2 ? ((w + 7) >> 3) * h : w * h;
      }
    }
    if (size < 12) await this.need(size);
    else await this.need(await this.compactLength());
  }

  /**
   * The JPEG encoding (21, TigerVNC's for noVNC): a bare JPEG with no length before it, read as noVNC does, marker by
   * marker to the end-of-image, the entropy-coded data after SOS scanned in the buffer (not byte by byte).
   */
  private async jpeg() {
    await this.need(2); // SOI
    for (;;) {
      const m = await this.need(2);
      if (m[0] !== 0xff) throw new Error('JPEG: a marker expected');
      const t = m[1]!;
      if (t === 0xd9) return; // EOI
      if ((t >= 0xd0 && t <= 0xd7) || t === 0x01) continue;
      await this.need((await this.need(2)).readUInt16BE(0) - 2);
      if (t !== 0xda) continue;
      // After the scan header: data up to the next marker (0xff not followed by 0x00 or a restart marker).
      for (let from = 0; ; ) {
        const i = this.buf.indexOf(0xff, from);
        if (i >= 0 && i + 1 < this.buf.length) {
          const n = this.buf[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            from = i + 2;
            continue;
          }
          await this.need(i);
          break;
        }
        from = i >= 0 ? i : this.buf.length;
        if (this.closed) throw new Error('the server closed the connection');
        await new Promise<void>((r) => (this.wait = r));
      }
    }
  }

  private count(name: string) {
    this.messages[name] = (this.messages[name] ?? 0) + 1;
  }

  private async loop() {
    this.request(false);
    try {
      for (;;) {
        const type = (await this.need(1))[0];
        if (type === 0) {
          const h = await this.need(3);
          let rects = h.readUInt16BE(1);
          let pixels = false;
          if (this.mode === 'eager') this.request(true);
          while (rects-- > 0) {
            const r = await this.need(12);
            const [x, y, w, hh, enc] = [r.readUInt16BE(0), r.readUInt16BE(2), r.readUInt16BE(4), r.readUInt16BE(6), r.readInt32BE(8)];
            const name = ENC_NAME[enc] ?? String(enc);
            this.encodings[name] = (this.encodings[name] ?? 0) + 1;
            if (enc === ENC.raw) {
              const px = await this.need(w * hh * 4);
              if (this.fb) for (let row = 0; row < hh; row++) this.fb.set(px.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
            } else if (enc === ENC.copyRect) await this.need(4);
            else if (enc === ENC.zrle || enc === ENC.zlib) await this.need((await this.need(4)).readUInt32BE(0));
            else if (enc === ENC.tight || enc === ENC.tightPng) await this.tight(w, hh);
            else if (enc === ENC.jpeg) await this.jpeg();
            else if (enc === ENC.h264) {
              const l = (await this.need(8)).readUInt32BE(0);
              await this.need(l);
            } else if (enc === ENC.desktopSize) {
              this.width = w;
              this.height = hh;
            } else if (enc === ENC.extDesktopSize) {
              const screens = (await this.need(4))[0]!;
              await this.need(16 * screens);
              this.width = w;
              this.height = hh;
            } else if (enc === ENC.cursor) await this.need(w * hh * 4 + ((w + 7) >> 3) * hh);
            else if (enc === ENC.vmwareCursor) {
              const kind = (await this.need(2))[0];
              await this.need(kind === 0 ? 2 * w * hh * 4 : w * hh * 4);
            } else if (enc === ENC.desktopName) await this.need((await this.need(4)).readUInt32BE(0));
            else if (enc === ENC.qemuLed) await this.need(1);
            else if (enc === ENC.lastRect) break;
            else if (enc >= 0) throw new Error(`the server used encoding ${enc}, which this viewer does not read`);
            // Other pseudo-encodings (an acknowledgement that the server has the extension) carry nothing.
            if (enc >= 0) {
              pixels = true;
              this.onRect?.(x, y, w, hh, enc);
            }
          }
          this.updates++;
          if (pixels) {
            const slot = Math.floor(performance.now() / (1000 / 60));
            if (slot !== this.slot) [this.slot, this.frames] = [slot, this.frames + 1];
          }
          if (!this.t.firstFrame) this.t.firstFrame = performance.now();
          if (this.mode === 'novnc' && !this.continuous) this.request(true);
          this.onUpdate?.();
          for (const w of this.changes.splice(0)) w();
        } else if (type === 1) {
          const h = await this.need(5);
          await this.need(h.readUInt16BE(3) * 6);
        } else if (type === 2) {
          // bell
        } else if (type === 3) {
          await this.need(3);
          const len = (await this.need(4)).readInt32BE(0);
          const text = await this.need(Math.abs(len));
          // A negative length is the extended clipboard (caps or a notify), not text.
          if (len >= 0) this.cut.push(text.toString('latin1'));
          this.count('cut-text');
        } else if (type === 150) {
          // EndOfContinuousUpdates: the server has them. noVNC turns them on at once, over the whole screen.
          this.count('end-of-continuous-updates');
          if (this.mode === 'novnc' && !this.continuous) {
            this.continuous = true;
            const m = Buffer.alloc(10);
            m[0] = 150;
            m[1] = 1;
            m.writeUInt16BE(this.width, 6);
            m.writeUInt16BE(this.height, 8);
            this.sock.write(m);
          }
        } else if (type === 248) {
          // A fence from the server: answered with its flags (block before / after only) and payload, as noVNC does.
          const h = await this.need(8);
          const flags = h.readUInt32BE(3);
          const payload = Buffer.from(await this.need(h[7]!));
          this.count('fence');
          const m = Buffer.alloc(9 + payload.length);
          m[0] = 248;
          m.writeUInt32BE((flags & 3) >>> 0, 4);
          m[8] = payload.length;
          payload.copy(m, 9);
          this.sock.write(m);
        } else if (type === 250) {
          await this.need(3);
          this.count('xvp');
        } else throw new Error(`server message ${type}`);
        for (const w of this.changes.splice(0)) w();
      }
    } catch (e) {
      if (!this.closed) this.error = (e as Error).message;
      for (const w of this.changes.splice(0)) w();
    }
  }

  /**
   * Resolves once `ok()` holds, checked after each whole update and each other server message; rejects when the
   * connection fails first or `ms` pass (a deadline for a failure's message, not a wait for quiet).
   */
  async until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (this.error || this.closed) throw new Error(`no ${what}: ${this.error ?? 'the connection closed'}`);
      const left = end - Date.now();
      if (left <= 0) throw new Error(`no ${what} within ${ms} ms`);
      let t: Timer | undefined;
      await new Promise<void>((r) => {
        this.changes.push(r);
        t = setTimeout(r, left);
      });
      clearTimeout(t);
    }
  }

  /** Asks for the whole screen now and waits for an update after the ask: the server read the ask and answered it. */
  async refresh(ms = 10_000): Promise<void> {
    const n = this.updates;
    this.request(false);
    await this.until('framebuffer update', () => this.updates > n, ms);
  }

  /** The pixel's RGB from the kept picture. */
  pixel(x: number, y: number): [number, number, number] {
    const o = (y * this.width + x) * 4;
    return [this.fb![o + 2]!, this.fb![o + 1]!, this.fb![o]!];
  }

  /** RFB's pointer event: buttons down (bit 0 left), at (x, y). */
  pointer(x: number, y: number, mask: number) {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this.sock.write(b);
  }

  /** A key down or up, by X keysym. */
  key(keysym: number, down: boolean) {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.sock.write(b);
  }

  /** ClientCutText: the viewer's clipboard, latin-1. */
  cutText(text: string) {
    const b = Buffer.alloc(8 + text.length);
    b[0] = 6;
    b.writeUInt32BE(text.length, 4);
    b.write(text, 8, 'latin1');
    this.sock.write(b);
  }

  /** Whether the connection is still up. */
  get open() {
    return !this.closed && !this.error;
  }

  close() {
    this.closed = true;
    this.sock.destroy();
  }
}
