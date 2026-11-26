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
 *   sway     WLR_BACKENDS=headless and no input devices (WLR_LIBINPUT_NO_DEVICES). Its renderer (swayRenderer): gles2
 *            on the machine's render node for a browser sandbox (Chromium's GPU buffers need it: under pixman its
 *            WebGL loses its context or hangs); pixman, drawing in software, for a native app (ScreenOptions.gpu
 *            false), which has no render node inside its sandbox and so draws in software anyway, and for a machine
 *            without one. The GPU driver is what a GPU-backed sway costs: about 30 MB more and 75 ms longer to
 *            start than pixman (docs/native-sandbox.md). Config written here: one output at the sandbox's size, no
 *            borders or title bars, no Xwayland, no swaybg or swaynag. The app's main window is tiled, so it fills the
 *            output (what the x11 backend's fit loop does by hand); one that opens beside it floats at its own size,
 *            centered, as a dialog does.
 *   wayvnc   on the same socket path x11vnc used (vnc.ts), so the manager's live view carries it unchanged. Its flags,
 *            checked with `ss -lxp` and `ss -ltnup` in a fresh network namespace (wayvnc 0.10.2):
 *              -f 60         up to 60 frames a second (its default is 30), as a desktop's screen shows them
 *              -u <path>     listen on that Unix socket, not on TCP (without -u the address is a host:port)
 *              -C <empty>    a config file of its own, so no user's ~/.config/wayvnc is read (none: no password, no TLS)
 *              -R            viewers cannot resize the output
 *              -S <path>     its control socket in the same private directory, not $XDG_RUNTIME_DIR/wayvncctl
 *              -k us-altgr-intl  the keymap input is typed in (WAYVNC_KEYMAP)
 *            It listens on nothing else: no TCP or UDP port, v4 or v6, and no abstract socket. Many viewers at once.
 *   input    wayvnc makes a virtual pointer and keyboard (wlr-virtual-pointer, virtual-keyboard) for its viewers, which
 *            the app gets as its seat's own input: trusted events, like xdotool's. The sandbox keeps one RFB client of
 *            its own connected (rfb.ts) and sends its clicks and keys through it; while it is connected the seat has a
 *            pointer and a keyboard, so pages see a fine pointer, hover and focus as on any desktop. Text no US key
 *            makes goes in through an input method (ime.ts), as a person with an IME types it.
 *   pictures grim on the compositor's socket (wlr-screencopy).
 */
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Subprocess } from 'bun';
import { DISPLAY_BINS, resolveBin, run, withoutDisplays } from './bins.ts';
import type { WaylandDisplay } from './display.ts';
import { InputMethod } from './ime.ts';
import { parseChord, textRuns } from './keysyms.ts';
import { RfbClient } from './rfb.ts';
import { displayNote, type Screen, type ScreenHealth, type ScreenOptions } from './screen.ts';
import { EVENT_WINDOW, IPC, SwayIpc, type SwayNode, views } from './swayipc.ts';
import { KeptServer, prepareVncSocket, SOCKET_PATH_MAX, vncSocketPath, waitForVncSocket } from './vnc.ts';

/** The compositor's directory in the sandbox's: its sockets, its config. */
export const WAYLAND_DIR = 'wl';

/**
 * The longest name sway makes in its runtime directory: its IPC socket's default name, `sway-ipc.<uid>.<pid>.sock`
 * (pids up to 4194304), which it works out even when SWAYSOCK names another, and exits when it does not fit.
 */
const longestName = () => `sway-ipc.${process.getuid?.() ?? 4294967295}.4194304.sock`;

/**
 * Where a sandbox's compositor keeps its sockets: `wl` in its directory, or, when a socket there would be too long a
 * path, a directory named for it in this user's runtime directory, or without one in /tmp (all 0700). `root` is the
 * directory the levels below are this user's own (privateDir checks each of them).
 */
export function waylandPlace(dir: string, env: Record<string, string | undefined> = process.env, tmp = tmpdir()): { dir: string; root: string } {
  const own = join(resolve(dir), WAYLAND_DIR);
  if (Buffer.byteLength(join(own, longestName())) <= SOCKET_PATH_MAX) return { dir: own, root: resolve(dir) };
  const runtime = env.XDG_RUNTIME_DIR;
  const hash = createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 16);
  if (runtime && existsSync(runtime)) return { dir: join(runtime, 'dither-wl', hash), root: runtime };
  return { dir: join(tmp, `dither-wl-${process.getuid?.() ?? 'user'}`, hash), root: tmp };
}

export const waylandDir = (dir: string) => waylandPlace(dir).dir;

/**
 * Make `dir` and every directory between `root` and it this user's own, closed to everyone else, before anything is
 * put there: each made 0700 if it is not there, and refused when it is a symlink, not a directory, or someone else's
 * (an existing one of ours open to others is closed, as the live view's is: vnc.ts). In /tmp anyone could have made a
 * level first, to see the compositor's sockets or to point them elsewhere. `fresh`: `dir` itself emptied first.
 */
export function privateDir(dir: string, root: string, o: { fresh?: boolean } = {}) {
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..')) throw new Error(`${dir} is not under ${root}`);
  const uid = process.getuid?.();
  let at = root;
  const parts = rel.split(sep);
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    if (o.fresh && i === parts.length - 1) {
      const st = lstatOrNull(at);
      // Only our own directory is emptied: what someone else left there is refused below, never followed.
      if (st?.isDirectory() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid)) rmSync(at, { recursive: true, force: true });
    }
    try {
      mkdirSync(at, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const st = lstatSync(at);
    if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error(`the compositor's directory ${at} is not this user's own (a symlink, not a directory, or someone else's)`);
    if (st.mode & 0o077) chmodSync(at, 0o700);
  }
}

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
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

/**
 * Where render nodes are looked for: /dev/dri, or DITHER_DEV_DRI (a path with none in it tries a machine without a
 * GPU, as CI's runners are).
 */
export const devDri = () => process.env.DITHER_DEV_DRI || '/dev/dri';

/** The first render node this process may open for reading and writing (as a GPU driver does), or null. */
export function renderNode(devDri_ = devDri()): string | null {
  let names: string[];
  try {
    names = readdirSync(devDri_).filter((n) => n.startsWith('renderD')).sort();
  } catch {
    return null;
  }
  for (const n of names) {
    try {
      accessSync(join(devDri_, n), constants.R_OK | constants.W_OK);
      return join(devDri_, n);
    } catch {
      // there, but not ours to open (no access to the render group, a container without the device)
    }
  }
  return null;
}

/**
 * gles2 when the sandbox's app renders on the GPU (Chromium: its GPU buffers need it) and the machine has a render node
 * this process can open, else pixman (a native app, which has no render node inside its sandbox: see the header). A
 * gles2 sway that still fails to start is started once more on pixman (start()).
 */
export function swayRenderer(gpu = true, devDri_ = devDri()): 'gles2' | 'pixman' {
  if (!gpu) return 'pixman';
  return renderNode(devDri_) ? 'gles2' : 'pixman';
}

/** The live view's frame rate (wayvnc's own default is 30). */
export const WAYVNC_MAX_FPS = 60;

/**
 * The keymap wayvnc types in: US with AltGr levels for the rest of Latin (us(altgr-intl)), not plain US. wayvnc turns a
 * viewer's keysym into a key of its keymap, pressing AltGr where the keysym is on that level, and drops a keysym the
 * keymap lacks: with `us`, é, ß, £, ñ, ü or € typed by a person in the live view never arrived. US's own keys stay
 * where they are, with no dead keys (us(intl) has them), so everything the sandbox types as keys is as before. What is
 * on no key (CJK, emoji) a viewer still cannot type: docs/browser.md "Display backends".
 */
export const WAYVNC_KEYMAP = 'us-altgr-intl';

/** wayvnc on its Unix socket only (see above). */
export function wayvncArgs(wayvnc: string, socket: string, dir: string): string[] {
  return [wayvnc, '-C', join(dir, 'wayvnc.conf'), '-u', '-R', '-f', String(WAYVNC_MAX_FPS), '-k', WAYVNC_KEYMAP, '-S', join(dir, 'wayvnc.sock'), socket];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WaylandScreen implements Screen {
  readonly backend: WaylandDisplay['backend'];
  readonly protocol = 'wayland' as const;
  readonly display = null;
  readonly vncSocket: string;
  readonly procNames = ['wayvnc', 'sway'] as const;
  readonly needsOwnBus = true;
  /** The compositor's directory: its Wayland socket, its IPC socket, its config. */
  readonly dir: string;
  /** Where privateDir starts checking (the account's directory, the runtime directory or /tmp). */
  private root: string;
  private waylandSocket = '';
  private ipc: SwayIpc | null = null;
  private windowEvents: SwayIpc | null = null;
  private rfb: RfbClient | null = null;
  private connecting: Promise<RfbClient> | null = null;
  private vnc: KeptServer | null = null;
  private stopped = false;
  /** Windows placed so far (placeNew), by con_id; placing one waits for the one before. */
  private placed = new Set<number>();
  private placing: Promise<void> = Promise.resolve();
  /** The renderer sway runs with (after a fallback to pixman, that one). */
  renderer: 'gles2' | 'pixman' = 'pixman';

  constructor(
    private o: ScreenOptions,
    readonly free: WaylandDisplay,
  ) {
    this.backend = free.backend;
    this.vncSocket = o.vncSocket ?? vncSocketPath(o.dir);
    const place = waylandPlace(o.dir);
    this.dir = place.dir;
    this.root = place.root;
  }

  get socket() {
    return this.waylandSocket;
  }

  get ipcSocket() {
    return join(this.dir, 'ipc.sock');
  }

  get runtimeDir() {
    return this.dir;
  }

  describe() {
    return displayNote(this.free);
  }

  /** The Wayland platform (not XWayland, which isn't there) and the text-input protocol ime.ts types through. */
  chromiumFlags(): string[] {
    return ['--ozone-platform=wayland', '--enable-wayland-ime', '--wayland-text-input-version=3'];
  }

  /**
   * The system's title bar. Chromium's own (custom_chrome_frame) draws client-side shadows around the window and counts
   * them in its size even when sway tiles it: outerWidth was the screen's plus 20 px, more than any real desktop gives,
   * and the first page after a start saw the window's floating size. With the system's (sway draws none:
   * default_border none) the window is the screen's size from the first frame.
   */
  adjustPrefs(prefs: Record<string, any>) {
    prefs.browser = { ...prefs.browser, custom_chrome_frame: false };
  }

  health(): ScreenHealth {
    return this.vnc?.health() ?? { ok: true };
  }

  /** The compositor's directory, fresh: made 0700 at every level it makes, refused unless each is this user's own. */
  private prepareDir() {
    privateDir(this.dir, this.root, { fresh: true });
    writeFileSync(join(this.dir, 'sway.conf'), swayConfig(this.o.width, this.o.height), { mode: 0o600 });
    writeFileSync(join(this.dir, 'wayvnc.conf'), '', { mode: 0o600 });
  }

  async start() {
    const sway = resolveBin(DISPLAY_BINS.sway, this.o.log);
    const wayvnc = resolveBin(DISPLAY_BINS.wayvnc, this.o.log);
    this.prepareDir();
    const wanted = swayRenderer(this.o.gpu ?? true);
    try {
      this.ipc = await this.startSway(sway, wanted);
    } catch (e) {
      if (wanted !== 'gles2' || this.stopped) throw e;
      // The render node opened, but the GPU driver did not start (a driver the machine lacks, a GPU in another
      // container's hands): drawing in software works anywhere.
      this.o.log('warn', `sway did not start on the GPU (${(e as Error).message}): starting it again in software (pixman)`);
      this.prepareDir();
      this.ipc = await this.startSway(sway, 'pixman');
    }
    this.waylandSocket = this.findSocket();
    this.watchWindows();

    this.vnc = new KeptServer({
      name: 'wayvnc',
      start: async () => {
        prepareVncSocket(this.vncSocket);
        const vnc = this.o.spawn('wayvnc', wayvncArgs(wayvnc, this.vncSocket, this.dir), {
          match: this.vncSocket,
          env: { DISPLAY: undefined, WAYLAND_SOCKET: undefined, WAYLAND_DISPLAY: this.waylandSocket, XDG_RUNTIME_DIR: this.dir },
        });
        await waitForVncSocket(this.vncSocket, vnc, 10_000, 'wayvnc');
        return vnc;
      },
      // A new wayvnc has no client: the seat has no pointer or keyboard until ours connects again.
      after: async () => {
        this.rfb?.close();
        this.rfb = null;
        await this.connect();
        await this.waitForSeat(5000);
      },
      log: this.o.log,
      onHealth: this.o.onHealth,
    });
    await this.vnc.start();
    await this.connect();
    await this.waitForSeat(5000);
    this.o.log('debug', `compositor up: sway (${this.renderer}) on ${this.waylandSocket}`);
  }

  private async startSway(sway: string, renderer: 'gles2' | 'pixman'): Promise<SwayIpc> {
    const conf = join(this.dir, 'sway.conf');
    this.renderer = renderer;
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
    try {
      return await this.waitForSway(proc, 10_000);
    } catch (e) {
      // Not left to run on beside the next try: its owner stops what is left at the end, this one goes now.
      try {
        proc.kill('SIGKILL');
      } catch {}
      await proc.exited.catch(() => {});
      throw e;
    }
  }

  /** sway answers on its IPC socket with its output at the sandbox's size; fail at once if it exited. */
  private async waitForSway(proc: Subprocess, ms: number): Promise<SwayIpc> {
    const deadline = Date.now() + ms;
    let ipc: SwayIpc | null = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode) throw new Error(`sway exited (${proc.signalCode ?? proc.exitCode}) before its output came up`);
      try {
        const left = () => Math.max(1, deadline - Date.now());
        ipc ??= existsSync(this.ipcSocket) ? await SwayIpc.connect(this.ipcSocket, left()) : null;
        if (ipc) {
          const outs = await ipc.request<{ active: boolean; current_mode?: { width: number; height: number } }[]>(IPC.GET_OUTPUTS, '', left());
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
      if (!this.ipc) throw new Error('the compositor is stopped');
      const seats = await this.ipc.request<{ capabilities: number }[]>(IPC.GET_SEATS, '', Math.max(1, deadline - Date.now()));
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
   *
   * The subscription is its own connection: when it ends while the screen runs (sway restarting its IPC, a stuck
   * reply), it is said and made again, 0.25 s later, then twice as long after each failure, up to 10 s.
   */
  private watchWindows() {
    void (async () => {
      let wait = 250;
      let said = false;
      while (!this.stopped) {
        let sub: SwayIpc | null = null;
        try {
          sub = await SwayIpc.connect(this.ipcSocket);
          if (this.stopped) return sub.close();
          this.windowEvents = sub;
          sub.onEvent = (type, ev) => {
            const id = ev?.container?.id;
            if (type !== EVENT_WINDOW || ev?.change !== 'new' || typeof id !== 'number') return;
            this.place(() => this.placeNew(id));
          };
          await sub.request(IPC.SUBSCRIBE, JSON.stringify(['window']));
          // Windows that opened while there was no subscription are placed as they are.
          this.place(async () => {
            if (this.ipc) for (const v of views(await this.ipc.tree())) this.placed.add(v.id);
          });
          wait = 250;
          said = false;
          const why = await sub.closed;
          if (this.stopped) return;
          this.o.log('warn', `sway's window events ended (${why.message}): subscribing again`);
        } catch (e) {
          sub?.close();
          if (this.stopped) return;
          this.o.log(said ? 'debug' : 'warn', `sway's window events: ${(e as Error).message}; trying again in ${wait} ms`);
          said = true;
        }
        await sleep(wait);
        wait = Math.min(wait * 2, 10_000);
      }
    })();
  }

  /** The windows placed so far, once every placement asked for has run (for tests). */
  async placedWindows(): Promise<number[]> {
    await this.placing;
    return [...this.placed];
  }

  /** One placement at a time, in the order sway said the windows opened. */
  private place(f: () => Promise<void>) {
    this.placing = this.placing.then(f).catch((e) => this.o.log('debug', `sway: ${(e as Error).message}`));
  }

  /**
   * A new window floats when a window placed before it is still tiled; the first stays tiled. Only windows already
   * placed count, so two that open together see one another in one order: the first tiled, the second a dialog.
   */
  private async placeNew(id: number) {
    if (!this.ipc) return;
    const all = views(await this.ipc.tree());
    const present = new Set(all.map((v) => v.id));
    for (const p of this.placed) if (!present.has(p)) this.placed.delete(p);
    const tiled = all.some((v) => v.id !== id && v.type === 'con' && this.placed.has(v.id));
    this.placed.add(id);
    if (tiled) await this.ipc.command(`[con_id=${id}] floating enable`);
  }

  clientEnv() {
    return { WAYLAND_DISPLAY: this.waylandSocket, DISPLAY: undefined, WAYLAND_SOCKET: undefined, XDG_SESSION_TYPE: 'wayland' };
  }

  /** Our own RFB client on the live view's socket, connected again if it went away. */
  private connect(): Promise<RfbClient> {
    if (this.rfb?.open) return Promise.resolve(this.rfb);
    this.connecting ??= RfbClient.connect(this.vncSocket, 10_000)
      .then((c) => (this.rfb = c))
      .finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** The client input goes through: once wayvnc serves (it may be starting again: KeptServer) and ours is connected. */
  private async input(): Promise<RfbClient> {
    await this.vnc?.ready();
    if (this.stopped) throw new Error('input failed: the screen is stopped');
    return this.connect();
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
    for (const v of found) await this.ipc?.command(`[con_id=${v.id}] kill`);
    return found.length > 0;
  }

  /** Its connections closed and its directory gone; the processes are its owner's to stop. */
  async stop() {
    this.stopped = true;
    this.vnc?.stop();
    this.rfb?.close();
    this.windowEvents?.close();
    this.ipc?.close();
    this.ipc = null;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
