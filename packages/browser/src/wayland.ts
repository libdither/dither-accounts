/**
 * The wayland display backend (screen.ts): a headless sway of the sandbox's own, wayvnc as its live view, input through
 * that live view's socket, pictures by grim. No display number and nothing in /tmp: the compositor's sockets are in the
 * account's own directory (<dir>/wl, 0700), so two sandboxes never meet and a crashed one leaves nothing behind that
 * a later one must step around.
 *
 * Why sway and not cage (both wlroots kiosks with a headless backend): cage 0.3 as nixpkgs builds it always starts
 * Xwayland, which takes a global X display number and listens on an abstract socket, the two things this backend is for
 * getting rid of; it has no IPC (closing a window as a window manager would, telling when the output and the seat are
 * ready); its output size needs another tool; and it exits when its one app does, where the native-app sandbox restarts
 * the app on a running display. sway with `xwayland disable` listens only on its socket and its IPC socket, both here.
 *
 *   sway     WLR_BACKENDS=headless and no input devices (WLR_LIBINPUT_NO_DEVICES); renderer gles2 on the machine's
 *            render node (Chromium's GPU buffers need it: under pixman its WebGL loses its context or hangs), pixman
 *            without one. Config written here: one output at the sandbox's size, no borders or title bars, no
 *            Xwayland, no swaybg or swaynag. The app's main window is tiled, so it fills the output (what the x11
 *            backend's fit loop does by hand); one that opens beside it floats at its own size, centered, as a
 *            dialog does.
 *   wayvnc   on the same socket path x11vnc used (vnc.ts), so the manager's live view carries it unchanged. Its flags,
 *            checked with `ss -lxp` and `ss -ltnup` in a fresh network namespace (wayvnc 0.10.2):
 *              -u <path>     listen on that Unix socket, not on TCP (without -u the address is a host:port)
 *              -C <empty>    a config file of its own, so no user's ~/.config/wayvnc is read (none: no password, no TLS)
 *              -R            viewers cannot resize the output
 *              -S <path>     its control socket in the same private directory, not $XDG_RUNTIME_DIR/wayvncctl
 *              -k us         the keymap input is typed in
 *            It listens on nothing else: no TCP or UDP port, v4 or v6, and no abstract socket. Many viewers at once.
 *   input    wayvnc makes a virtual pointer and keyboard (wlr-virtual-pointer, virtual-keyboard) for its viewers, which
 *            the app gets as its seat's own input: trusted events, like xdotool's. The sandbox keeps one RFB client of
 *            its own connected (rfb.ts) and sends its clicks and keys through it; while it is connected the seat has a
 *            pointer and a keyboard, so pages see a fine pointer, hover and focus as on any desktop. Text no US key
 *            makes goes in through an input method (ime.ts), as a person with an IME types it.
 *   pictures grim on the compositor's socket (wlr-screencopy).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Subprocess } from 'bun';
import { DISPLAY_BINS, resolveBin, run, withoutDisplays } from './bins.ts';
import type { FreeDisplay } from './display.ts';
import { InputMethod } from './ime.ts';
import { parseChord, textRuns } from './keysyms.ts';
import { RfbClient } from './rfb.ts';
import type { Screen, ScreenOptions } from './screen.ts';
import { EVENT_WINDOW, IPC, SwayIpc, type SwayNode, views } from './swayipc.ts';
import { prepareVncSocket, SOCKET_PATH_MAX, vncSocketPath, waitForVncSocket } from './vnc.ts';

/** The compositor's directory in the sandbox's: its sockets, its config. */
export const WAYLAND_DIR = 'wl';

/**
 * The longest name sway makes in its runtime directory: its IPC socket's default name, `sway-ipc.<uid>.<pid>.sock`
 * (pids up to 4194304), which it works out even when SWAYSOCK names another, and exits when it does not fit.
 */
const longestName = () => `sway-ipc.${process.getuid?.() ?? 4294967295}.4194304.sock`;

/**
 * Where a sandbox's compositor keeps its sockets: `wl` in its directory, or, when a socket there would be too long a
 * path, a directory named for it in this user's runtime directory (both 0700).
 */
export function waylandDir(dir: string): string {
  const own = join(resolve(dir), WAYLAND_DIR);
  if (Buffer.byteLength(join(own, longestName())) <= SOCKET_PATH_MAX) return own;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? join(runtime, 'dither-wl') : join(tmpdir(), `dither-wl-${process.getuid?.() ?? 'user'}`);
  return join(base, createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 16));
}

/** sway's config for a sandbox: one output at its size, nothing drawn around windows, nothing else started. */
export function swayConfig(width: number, height: number): string {
  return `# A dither-accounts sandbox's compositor (packages/browser/src/wayland.ts): written at every start.
xwayland disable
swaybg_command -
swaynag_command -
output * mode --custom ${width}x${height} position 0 0 scale 1
default_border none
default_floating_border none
titlebar_border_thickness 0
titlebar_padding 1
focus_follows_mouse no
mouse_warping none
focus_on_window_activation focus
`;
}

/** gles2 where the machine has a render node (Chromium's GPU buffers need it), else pixman. */
export function swayRenderer(devDri = '/dev/dri'): 'gles2' | 'pixman' {
  try {
    return readdirSync(devDri).some((n) => n.startsWith('renderD')) ? 'gles2' : 'pixman';
  } catch {
    return 'pixman';
  }
}

/** wayvnc on its Unix socket only (see above). */
export function wayvncArgs(wayvnc: string, socket: string, dir: string): string[] {
  return [wayvnc, '-C', join(dir, 'wayvnc.conf'), '-u', '-R', '-k', 'us', '-S', join(dir, 'wayvnc.sock'), socket];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WaylandScreen implements Screen {
  readonly backend = 'wayland' as const;
  readonly display = null;
  readonly vncSocket: string;
  readonly procNames = ['wayvnc', 'sway'] as const;
  /** The compositor's directory: its Wayland socket, its IPC socket, its config. */
  readonly dir: string;
  private waylandSocket = '';
  private ipc: SwayIpc | null = null;
  private windowEvents: SwayIpc | null = null;
  private rfb: RfbClient | null = null;
  private connecting: Promise<RfbClient> | null = null;
  private stopped = false;

  constructor(
    private o: ScreenOptions,
    readonly free: FreeDisplay,
  ) {
    this.vncSocket = o.vncSocket ?? vncSocketPath(o.dir);
    this.dir = waylandDir(o.dir);
  }

  get socket() {
    return this.waylandSocket;
  }

  get ipcSocket() {
    return join(this.dir, 'ipc.sock');
  }

  /** The compositor's directory, fresh: made 0700, refused unless it is this user's, emptied of an earlier run's sockets. */
  private prepareDir() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.dir);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || st.mode & 0o077) throw new Error(`the compositor's directory ${this.dir} is not this user's own`);
    writeFileSync(join(this.dir, 'sway.conf'), swayConfig(this.o.width, this.o.height), { mode: 0o600 });
    writeFileSync(join(this.dir, 'wayvnc.conf'), '', { mode: 0o600 });
  }

  async start() {
    const sway = resolveBin(DISPLAY_BINS.sway, this.o.log);
    const wayvnc = resolveBin(DISPLAY_BINS.wayvnc, this.o.log);
    this.prepareDir();
    const conf = join(this.dir, 'sway.conf');
    const renderer = swayRenderer();
    const proc = this.o.spawn('sway', [sway, '-c', conf], {
      match: conf,
      env: {
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
        WAYLAND_SOCKET: undefined,
        SWAYSOCK: this.ipcSocket,
        I3SOCK: undefined,
        XDG_RUNTIME_DIR: this.dir,
        WLR_BACKENDS: 'headless',
        WLR_HEADLESS_OUTPUTS: '1',
        WLR_LIBINPUT_NO_DEVICES: '1',
        WLR_RENDERER: renderer,
      },
    });
    this.ipc = await this.waitForSway(proc, 10_000);
    this.waylandSocket = this.findSocket();
    this.watchWindows();

    prepareVncSocket(this.vncSocket);
    const vnc = this.o.spawn('wayvnc', wayvncArgs(wayvnc, this.vncSocket, this.dir), {
      match: this.vncSocket,
      env: { DISPLAY: undefined, WAYLAND_SOCKET: undefined, WAYLAND_DISPLAY: this.waylandSocket, XDG_RUNTIME_DIR: this.dir },
    });
    await waitForVncSocket(this.vncSocket, vnc, 10_000, 'wayvnc');
    await this.input();
    await this.waitForSeat(5000);
    this.o.log('debug', `compositor up: sway (${renderer}) on ${this.waylandSocket}`);
  }

  /** sway answers on its IPC socket with its output at the sandbox's size; fail at once if it exited. */
  private async waitForSway(proc: Subprocess, ms: number): Promise<SwayIpc> {
    const deadline = Date.now() + ms;
    let ipc: SwayIpc | null = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode) throw new Error(`sway exited (${proc.signalCode ?? proc.exitCode}) before its output came up`);
      try {
        ipc ??= existsSync(this.ipcSocket) ? await SwayIpc.connect(this.ipcSocket) : null;
        if (ipc) {
          const outs = await ipc.request<{ active: boolean; current_mode?: { width: number; height: number } }[]>(IPC.GET_OUTPUTS);
          if (outs.some((x) => x.active && x.current_mode?.width === this.o.width && x.current_mode?.height === this.o.height)) return ipc;
        }
      } catch {
        ipc?.close();
        ipc = null;
      }
      await sleep(50);
    }
    ipc?.close();
    throw new Error(`sway's output did not come up within ${ms} ms`);
  }

  /** The Wayland socket sway made in its directory (wayland-1, or the next free name). */
  private findSocket(): string {
    for (const n of readdirSync(this.dir).sort()) {
      if (!/^wayland-\d+$/.test(n)) continue;
      const p = join(this.dir, n);
      if (lstatSync(p).isSocket()) return p;
    }
    throw new Error(`sway made no Wayland socket in ${this.dir}`);
  }

  /** The seat has the pointer and keyboard wayvnc made for our client (wl_seat capabilities 1 and 2). */
  private async waitForSeat(ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const seats = await this.ipc!.request<{ capabilities: number }[]>(IPC.GET_SEATS);
      if (seats.some((s) => (s.capabilities & 3) === 3)) return;
      await sleep(50);
    }
    throw new Error(`the seat got no pointer and keyboard from wayvnc within ${ms} ms`);
  }

  /**
   * The app's main window fills the output (sway tiles it); a window that opens while a tiled one is there floats at
   * its own size, as a dialog does. Decided once per window as it opens, by its con_id: not with a `for_window` rule,
   * which sway runs again whenever a window's title changes (a page's title does all the time), so it would float the
   * main window too.
   */
  private watchWindows() {
    void (async () => {
      const sub = await SwayIpc.connect(this.ipcSocket);
      this.windowEvents = sub;
      sub.onEvent = (type, ev) => {
        const id = ev?.container?.id;
        if (type !== EVENT_WINDOW || ev?.change !== 'new' || typeof id !== 'number') return;
        void this.placeNew(id).catch((e) => this.o.log('debug', `sway: ${(e as Error).message}`));
      };
      await sub.request(IPC.SUBSCRIBE, JSON.stringify(['window']));
    })().catch((e) => {
      if (!this.stopped) this.o.log('warn', `sway's window events: ${(e as Error).message}`);
    });
  }

  private async placeNew(id: number) {
    if (!this.ipc) return;
    const others = views(await this.ipc.tree()).filter((v) => v.id !== id && v.type === 'con');
    if (others.length) await this.ipc.command(`[con_id=${id}] floating enable`);
  }

  clientEnv() {
    return { WAYLAND_DISPLAY: this.waylandSocket, DISPLAY: undefined, WAYLAND_SOCKET: undefined, XDG_SESSION_TYPE: 'wayland' };
  }

  /** Our own RFB client on the live view's socket, connected again if it went away. */
  private input(): Promise<RfbClient> {
    if (this.rfb?.open) return Promise.resolve(this.rfb);
    this.connecting ??= RfbClient.connect(this.vncSocket, 10_000)
      .then((c) => (this.rfb = c))
      .finally(() => (this.connecting = null));
    return this.connecting;
  }

  async click(x: number, y: number, button: 1 | 2 | 3 = 1) {
    const c = await this.input();
    const bit = button === 1 ? 1 : button === 2 ? 2 : 4;
    c.pointer(x, y, 0);
    await sleep(150);
    c.pointer(x, y, bit);
    await sleep(60);
    c.pointer(x, y, 0);
    await c.flushed();
  }

  async scroll(x: number, y: number, direction: 'up' | 'down', clicks: number) {
    const c = await this.input();
    const bit = direction === 'up' ? 8 : 16;
    c.pointer(x, y, 0);
    await sleep(50);
    for (let i = 0; i < clicks; i++) {
      c.pointer(x, y, bit);
      c.pointer(x, y, 0);
      await sleep(40);
    }
    await c.flushed();
  }

  private async chord(c: RfbClient, mods: number[], key: number) {
    for (const m of mods) {
      c.key(m, true);
      await sleep(15);
    }
    c.key(key, true);
    await sleep(25);
    c.key(key, false);
    for (const m of [...mods].reverse()) {
      await sleep(15);
      c.key(m, false);
    }
  }

  async type(text: string, delayMs = 35) {
    for (const r of textRuns(text)) {
      if ('keys' in r) {
        const c = await this.input();
        for (const k of r.keys) {
          await this.chord(c, k.mods, k.key);
          await sleep(delayMs);
        }
        await c.flushed();
        continue;
      }
      // What no US key types: committed by an input method into the focused field.
      const ime = await InputMethod.connect(this.waylandSocket);
      try {
        if (!(await ime.waitActive(3000))) throw new Error('typing failed: no text field has the focus for characters a US keyboard has no key for');
        await ime.commit(r.text);
      } finally {
        ime.close();
      }
      await sleep(delayMs);
    }
  }

  async keys(keys: string[], delayMs = 60) {
    const chords = keys.map(parseChord);
    const c = await this.input();
    for (const k of chords) {
      await this.chord(c, k.mods, k.key);
      await sleep(delayMs);
    }
    await c.flushed();
  }

  async screenshot() {
    const grim = resolveBin(DISPLAY_BINS.grim, this.o.log);
    return run([grim, '-t', 'png', '-'], { ...withoutDisplays(process.env), WAYLAND_DISPLAY: this.waylandSocket, XDG_RUNTIME_DIR: this.dir }, 'screenshot');
  }

  private async windows(name: string): Promise<SwayNode[]> {
    if (!this.ipc) return [];
    const re = new RegExp(name);
    return views(await this.ipc.tree()).filter((v) => re.test(v.name ?? ''));
  }

  /** The biggest window whose title matches fills the output (tiled); any other tiled window floats. */
  async fit(name: string) {
    if (!this.ipc) return;
    const all = views(await this.ipc.tree());
    const re = new RegExp(name);
    const best = all.filter((v) => re.test(v.name ?? '')).sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
    if (!best) return;
    if (best.type === 'floating_con') await this.ipc.command(`[con_id=${best.id}] floating disable`);
    for (const v of all) if (v.id !== best.id && v.type === 'con') await this.ipc.command(`[con_id=${v.id}] floating enable`);
  }

  async closeWindows(name: string) {
    const found = await this.windows(name);
    for (const v of found) await this.ipc!.command(`[con_id=${v.id}] kill`);
    return found.length > 0;
  }

  /** Its connections closed and its directory gone; the processes are its owner's to stop. */
  async stop() {
    this.stopped = true;
    this.rfb?.close();
    this.windowEvents?.close();
    this.ipc?.close();
    this.ipc = null;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
