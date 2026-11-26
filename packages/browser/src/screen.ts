/**
 * A sandbox's screen: where its windows show, the live view of it, and real input and pictures of it. One per
 * backend (the list is packages/spec display.ts), chosen per sandbox (docs/browser.md, "Display backends"):
 *
 *   x11      Xvfb on a numbered display from the shared pool (display.ts), x11vnc as the live view (vnc.ts), xdotool
 *            for input, ImageMagick's import for pictures. The default.
 *   tigervnc, kasmvnc
 *            the same, but the X server is an Xvnc that serves the live view itself (vnc.ts xvncArgs): TigerVNC's,
 *            or KasmVNC's from the owner's fork. One process instead of two, and no shared memory segments.
 *   wayland  a headless sway of the sandbox's own, its socket in the account's directory and no number at all, wayvnc as
 *            the live view on the same socket path, input through that live view (rfb.ts) and, for what no key types,
 *            an input method (ime.ts), pictures by grim (wayland.ts).
 *   wayland-tigervnc
 *            the same, with TigerVNC's Wayland server (w0vncserver, from the owner's fork) as the live view.
 *
 * The browser sandbox (sandbox.ts), Discord's and the native-app sandbox (packages/sandbox) each start one; the
 * `browser` interface (statements-common/browser-ops.ts) drives it. Nothing outside asks which backend it is: what
 * differs is the Screen's to say (protocol, chromiumFlags, adjustPrefs, needsOwnBus, describe, health). A new backend
 * is a class here and a line in SCREENS.
 */
import type { Subprocess } from 'bun';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DISPLAY_BINS, type Log, resolveBin, run, tryBin, withoutDisplays } from './bins.ts';
import { BACKENDS, type DisplayBackend, displayIsOurs, type FreeDisplay, type WaylandBackend, type WaylandDisplay, type XBackend, type XDisplay } from './display.ts';
import { KeptServer, prepareVncSocket, vncSocketPath, waitForRfbBanner, waitForVncSocket, x11vncArgs, xvncArgs, type XvncBackend } from './vnc.ts';
import { privateDir, renderNode, SESSION_LONGEST, socketPlace, WaylandScreen } from './wayland.ts';
import { gpuFlags } from './flags.ts';
import { closeWindow } from './x11.ts';

export { DISPLAY_BACKEND_ENV, DISPLAY_BACKENDS, type DisplayBackend, displayBackend, parseBackend } from './display.ts';

/** A display as a status shows it: ":80" for an X display (a number is one), its backend's name for a compositor. */
export function displayName(d: FreeDisplay | number | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  if (typeof d === 'number') return `:${d}`;
  return d.display === null ? d.backend : `:${d.display}`;
}

/** What runs it, for a status layer's note and the logs: "Xvfb :80", "sway (Wayland)". */
export function displayNote(d: FreeDisplay | number | null | undefined): string {
  if (d === null || d === undefined) return 'no display';
  if (typeof d === 'number') return `${BACKENDS.x11.label} :${d}`;
  return d.display === null ? BACKENDS[d.backend].label : `${BACKENDS[d.backend].label} :${d.display}`;
}

/** Whether the screen's live view's server runs (on Wayland all input goes through it too), and why not. */
export type ScreenHealth = { ok: true } | { ok: false; note: string };

/**
 * A status's display layer: "<what runs it>, live view ready", or failed while the live view's server is down (the
 * screen starts it again: KeptServer in vnc.ts).
 */
export function displayState(d: FreeDisplay | number | null | undefined, health?: ScreenHealth): { state: 'ok' | 'failed'; note: string } {
  if (health && !health.ok) return { state: 'failed', note: `${displayNote(d)}: ${health.note}` };
  return { state: 'ok', note: `${displayNote(d)}, live view ready` };
}

/** Spawns one of the screen's processes in its owner's list, so the owner stops it and can find it after a crash. */
export type ScreenSpawn = (name: string, cmd: string[], o: { env?: Record<string, string | undefined>; match: string }) => Subprocess;

export interface ScreenOptions {
  /** Which display: an X display number (x11), or a FreeDisplay from pickFreeDisplay. */
  display: number | FreeDisplay;
  /** The directory the live view's socket is in (vnc.sock, or vncSocketPath's fallback), and on Wayland the compositor's. */
  dir: string;
  /** Where the live view listens; default vncSocketPath(dir). */
  vncSocket?: string;
  width: number;
  height: number;
  /**
   * wayland: whether the app renders on the GPU, so the compositor should too (gles2 on the render node; default true,
   * as for Chromium). False for an app that draws in software (a native app, which has no render node inside its
   * sandbox): the compositor draws in software too (pixman), without loading the GPU driver (wayland.ts).
   */
  gpu?: boolean;
  /** wayland: how long one request to sway waits for its answer (5 s; tests make it short). */
  ipcRequestMs?: number;
  /** x11: no abstract X socket either (-nolisten local), for a sandbox that is shown only the path socket. */
  pathSocketOnly?: boolean;
  spawn: ScreenSpawn;
  log: Log;
  /** The live view's server went down or came back (health()). */
  onHealth?: (h: ScreenHealth) => void;
}

/** Real input and pictures, the same on both backends (the `browser` interface's: docs/browser.md). */
export interface ScreenInput {
  /** Move the pointer there, wait a moment as a hand would, and click (1 left, 2 middle, 3 right). */
  click(x: number, y: number, button?: 1 | 2 | 3): Promise<void>;
  /** The wheel, `clicks` notches up or down, with the pointer at (x, y). */
  scroll(x: number, y: number, direction: 'up' | 'down', clicks: number): Promise<void>;
  /** Text as key presses, any characters (non-ASCII too). */
  type(text: string, delayMs?: number): Promise<void>;
  /** Keys by X keysym name with modifiers (xdotool's: Return, Tab, ctrl+a, shift+Tab, Page_Down), one after another. */
  keys(keys: string[], delayMs?: number): Promise<void>;
  /** A PNG of the whole screen, as the live view shows it. */
  screenshot(): Promise<Buffer>;
}

export interface Screen extends ScreenInput {
  readonly backend: DisplayBackend;
  /** What its apps speak: X (DISPLAY, an X socket) or Wayland (WAYLAND_DISPLAY, the compositor's socket). */
  readonly protocol: 'x11' | 'wayland';
  /** The X display number; null on Wayland. */
  readonly display: number | null;
  readonly free: FreeDisplay;
  /** The live view's socket. */
  readonly vncSocket: string;
  /** The socket clients connect to: /tmp/.X11-unix/X<n>, or the compositor's wayland-<n>. Valid after start(). */
  readonly socket: string;
  /** Its processes' names, in the order to stop them (the live view before the display). */
  readonly procNames: readonly string[];
  start(): Promise<void>;
  /** For a client run on this machine: DISPLAY or WAYLAND_DISPLAY (an absolute path), the other one removed (undefined). */
  clientEnv(): Record<string, string | undefined>;
  /** Keep the biggest window whose name matches the size of the screen (x11 has no window manager; sway tiles it). */
  fit(windowName: string): Promise<void>;
  /** Ask the windows whose name matches to close, as a window manager's close button does; false when none was found. */
  closeWindows(windowName: string): Promise<boolean>;
  /**
   * Stopping, first half: nothing is started again (its live view's server), and its own connections are closed.
   * Never throws. The processes are then its owner's to stop (procNames), and its files go after them (removeFiles).
   */
  stop(): Promise<void>;
  /** Stopping, second half, once its processes are gone: its files (on Wayland the compositor's directory). */
  removeFiles(): Promise<void>;
  /**
   * Chromium's flags for this screen: its GPU flags, from what the screen really renders with (flags.ts gpuFlags), and
   * on Wayland its ozone platform and the text-input protocol ime.ts types through. Valid after start().
   */
  chromiumFlags(): string[];
  /** Set what a Chromium profile's preferences need on this screen, and undo what another screen's needed. */
  adjustPrefs(prefs: Record<string, any>): void;
  /**
   * A client must get a session of its own here (screenshare.ts: a session bus, an audio server and a runtime directory),
   * never the machine's: the machine's session bus has the owner's portal (which could share the owner's real screen),
   * notifications and desktop, and its audio server the owner's speakers and microphone. True on every backend.
   */
  readonly needsOwnBus: boolean;
  /**
   * The screen's own private directory (0700, made fresh at start, gone with removeFiles), short enough for sockets:
   * where that session goes. On Wayland the compositor's; on X one of its own (X_RUNTIME_DIR). null: none.
   */
  readonly runtimeDir: string | null;
  /** What runs it, for logs and notes: "Xvfb :80", "sway (Wayland)" (displayNote). */
  describe(): string;
  /** Whether its live view's server runs (it is started again when it dies). */
  health(): ScreenHealth;
}

/** Each backend's screen: the type checker says when a backend in packages/spec has none. */
const SCREENS: { [K in DisplayBackend]: (o: ScreenOptions, free: K extends XBackend ? XDisplay : K extends WaylandBackend ? WaylandDisplay : never) => Screen } = {
  x11: (o, free) => new XScreen(o, free),
  tigervnc: (o, free) => new XScreen(o, free),
  kasmvnc: (o, free) => new XScreen(o, free),
  wayland: (o, free) => new WaylandScreen(o, free),
  'wayland-tigervnc': (o, free) => new WaylandScreen(o, free),
};

/**
 * What differs between the X backends: what serves the live view, and so how the screen starts. x11's is x11vnc beside
 * Xvfb, kept running on its own (KeptServer); an Xvnc's is the X server itself, so it lives and dies with the display.
 */
const X_SERVERS: Record<XBackend, { procNames: readonly string[]; start: (s: XScreen) => Promise<void> }> = {
  x11: { procNames: ['x11vnc', 'Xvfb'], start: (s) => s.startXvfb() },
  tigervnc: { procNames: ['Xvnc'], start: (s) => s.startXvnc('tigervnc') },
  kasmvnc: { procNames: ['Xvnc'], start: (s) => s.startXvnc('kasmvnc') },
};

export function makeScreen(o: ScreenOptions): Screen {
  const free: FreeDisplay = typeof o.display === 'number' ? { backend: 'x11', display: o.display } : o.display;
  return (SCREENS[free.backend] as (o: ScreenOptions, free: FreeDisplay) => Screen)(o, free);
}

/** An X screen's own runtime directory in the sandbox's (socketPlace: elsewhere when a socket there is too long). */
export const X_RUNTIME_DIR = 'xrt';

/**
 * An X server on a numbered display, with xdotool and import: Xvfb and x11vnc (x11, the backend the sandboxes always
 * had), or one Xvnc that is both (tigervnc, kasmvnc). The X server and its socket are the machine's shared /tmp/.X11-unix;
 * the sandbox's own session (runtimeDir) is in a directory of its own, as on Wayland.
 */
class XScreen implements Screen {
  readonly backend: XBackend;
  readonly protocol = 'x11' as const;
  readonly display: number;
  readonly vncSocket: string;
  readonly procNames: readonly string[];
  readonly needsOwnBus = true;
  readonly runtimeDir: string;
  /** Where privateDir starts checking runtimeDir (the account's directory, the runtime directory or /tmp). */
  private root: string;
  private xdotool: string | null = null;
  private importBin: string | null = null;
  private vnc: KeptServer | null = null;
  /** An Xvnc's process, and why it is gone once it is (health()). */
  private xvnc: Subprocess | null = null;
  private xvncGone: string | null = null;
  private server: (typeof X_SERVERS)[XBackend];

  constructor(
    private o: ScreenOptions,
    readonly free: XDisplay,
  ) {
    this.backend = free.backend;
    this.display = free.display;
    this.vncSocket = o.vncSocket ?? vncSocketPath(o.dir);
    this.server = X_SERVERS[free.backend];
    this.procNames = this.server.procNames;
    const place = socketPlace(o.dir, X_RUNTIME_DIR, 'dither-x', [SESSION_LONGEST]);
    this.runtimeDir = place.dir;
    this.root = place.root;
  }

  get socket() {
    return `/tmp/.X11-unix/X${this.display}`;
  }

  describe() {
    return displayNote(this.free);
  }

  /** On the machine's GPU when it has a render node this process can open (Xvfb has no GL: flags.ts gpuFlags). */
  chromiumFlags(): string[] {
    return gpuFlags(renderNode() !== null);
  }

  /** Chromium's own default title bar: what a profile moved back from Wayland had set is taken away (WaylandScreen). */
  adjustPrefs(prefs: Record<string, any>) {
    if (prefs.browser?.custom_chrome_frame === false) delete prefs.browser.custom_chrome_frame;
  }

  health(): ScreenHealth {
    if (this.xvncGone) return { ok: false, note: this.xvncGone };
    return this.vnc?.health() ?? { ok: true };
  }

  start() {
    // Fresh and this user's own at every level, before anything (the X server's environment names it) is started.
    privateDir(this.runtimeDir, this.root, { fresh: true });
    return this.server.start(this);
  }

  /** Xvfb, then x11vnc beside it (X_SERVERS: x11). */
  async startXvfb() {
    const d = `:${this.display}`;
    const xvfbBin = resolveBin(DISPLAY_BINS.xvfb, this.o.log);
    const x11vncBin = resolveBin(DISPLAY_BINS.x11vnc, this.o.log);
    // -dpi 96: Xvfb defaults to 100, and Chromium scales itself to match, which makes its window wider and taller than
    // the display and the page cut off at the edges.
    const args = [xvfbBin, d, '-screen', '0', `${this.o.width}x${this.o.height}x24`, '-nolisten', 'tcp', ...(this.o.pathSocketOnly ? ['-nolisten', 'local'] : []), '-nocursor', '-dpi', '96'];
    const xvfb = this.o.spawn('Xvfb', args, { match: d });
    await this.waitForDisplay(xvfb, 8000);
    // The live view: on the account's own Unix socket and no TCP port, no password (the manager carries it, behind its
    // login). -forever so it survives viewers leaving; -shared for several viewers. Started again if it dies.
    this.vnc = new KeptServer({
      name: 'x11vnc',
      start: async () => {
        prepareVncSocket(this.vncSocket);
        const vnc = this.o.spawn('x11vnc', x11vncArgs(x11vncBin, d, this.vncSocket), { match: `-unixsock ${this.vncSocket}`, env: { DISPLAY: d } });
        await waitForVncSocket(this.vncSocket, vnc, 10_000, 'x11vnc');
        return vnc;
      },
      log: this.o.log,
      onHealth: this.o.onHealth,
    });
    await this.vnc.start();
  }

  /**
   * One Xvnc: the X server and, on the account's own Unix socket and no TCP port, the live view (vnc.ts xvncArgs). Its
   * display's lock and its socket both come up before its live view's socket, which it makes once its VNC extension
   * runs, and it answers there once it has finished starting: all three are waited for. Not started again when it
   * dies, as Xvfb is not: the display and every window on it go with it, and the sandbox's own watch sees that.
   * (X_SERVERS: tigervnc, kasmvnc.)
   */
  async startXvnc(xvnc: XvncBackend) {
    const bin = resolveBin(DISPLAY_BINS[xvnc], this.o.log);
    prepareVncSocket(this.vncSocket);
    const d = `:${this.display}`;
    // HOME: KasmVNC reads ~/.kasmpasswd and writes ~/.vnc. A directory of the account's own.
    const home = join(this.o.dir, 'xvnc-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const p = this.o.spawn('Xvnc', xvncArgs(xvnc, bin, d, this.vncSocket, this.o), { match: d, env: { HOME: home, DISPLAY: undefined, WAYLAND_DISPLAY: undefined } });
    await this.waitForDisplay(p, 8000, 'Xvnc');
    await waitForVncSocket(this.vncSocket, p, 10_000, 'Xvnc');
    await waitForRfbBanner(this.vncSocket, p, 10_000, 'Xvnc');
    this.xvnc = p;
    void p.exited.then(() => {
      if (this.xvnc !== p) return;
      this.xvncGone = `Xvnc exited (${p.signalCode ?? p.exitCode})`;
      this.o.onHealth?.(this.health());
    });
  }

  /**
   * Our X server's display is up: its socket there and its lock naming it. Two sandboxes starting together can pick the
   * same free display: the socket is then the other one's, and ours is about to exit with "already active".
   */
  private async waitForDisplay(server: Subprocess, ms: number, name = 'Xvfb') {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`${name} on :${this.display} exited (${server.exitCode}); is the display taken?`);
      if (displayIsOurs(this.display, server.pid)) return;
      await Bun.sleep(50);
    }
    throw new Error(`${name} display :${this.display} did not come up within ${ms} ms`);
  }

  clientEnv() {
    return { DISPLAY: `:${this.display}`, WAYLAND_DISPLAY: undefined, WAYLAND_SOCKET: undefined };
  }

  private async xdo(args: string[], what = 'input'): Promise<string> {
    this.xdotool ??= resolveBin(DISPLAY_BINS.xdotool, this.o.log);
    const out = await run([this.xdotool, ...args], { ...withoutDisplays(process.env), DISPLAY: `:${this.display}` }, what);
    return out.toString('utf8');
  }

  async click(x: number, y: number, button: 1 | 2 | 3 = 1) {
    await this.xdo(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y)), 'sleep', '0.15', 'click', String(button)]);
  }

  async scroll(x: number, y: number, direction: 'up' | 'down', clicks: number) {
    await this.xdo(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', String(clicks), '--delay', '40', direction === 'up' ? '4' : '5']);
  }

  async type(text: string, delayMs = 35) {
    if (!text) return;
    await this.bindCharacters(text).catch((e) => this.o.log('info', `characters not bound to keys, xdotool binds them itself: ${(e as Error).message}`));
    await this.xdo(['type', '--delay', String(delayMs), '--', text]);
  }

  /** Characters this screen's keyboard map has been given by bindCharacters, and the keycodes still free for it. */
  private boundChars = new Set<string>();
  private spareKeycodes: number[] | null = null;
  private xmodmap: string | null | undefined;

  /**
   * Puts every character of `text` that a US keyboard lacks (é, €, an emoji) on a key of its own, for as long as the
   * screen runs. Left to xdotool, each such character is bound to a spare key, pressed and unbound at once, and an app
   * reads the new keyboard map only when it gets to the notice of the change: if the unbinding came first, it reads the
   * old map and the character is lost (Chromium on X, now and then). Bound here and kept, xdotool finds the character
   * in the map and presses its key, as for any other. The keys taken are those with no symbol at all or only XF86
   * media symbols, which nothing in a sandbox presses. A character counts as bound only once xmodmap has done it;
   * without xmodmap, with no key left, or when xmodmap fails (the caller logs it), xdotool binds the rest its own way,
   * as before.
   */
  private async bindCharacters(text: string) {
    const need = [...new Set([...text].filter((c) => c.codePointAt(0)! > 0x7e && !this.boundChars.has(c)))];
    if (!need.length) return;
    if (this.xmodmap === undefined) this.xmodmap = tryBin(DISPLAY_BINS.xmodmap, this.o.log);
    const xmodmap = this.xmodmap;
    if (!xmodmap) return;
    const env = { ...withoutDisplays(process.env), DISPLAY: `:${this.display}` };
    if (!this.spareKeycodes) {
      const map = (await run([xmodmap, '-pke'], env, 'reading the keyboard map')).toString('utf8');
      this.spareKeycodes = map
        .split('\n')
        .map((l) => /^keycode\s+(\d+)\s*=\s*(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m && m[2]!.trim().split(/\s+/).filter(Boolean).every((k) => k.startsWith('XF86') || k === 'NoSymbol'))
        .map((m) => Number(m[1]));
    }
    const take: { c: string; code: number }[] = [];
    for (const c of need) {
      const code = this.spareKeycodes.at(-(take.length + 1));
      if (code === undefined) break;
      take.push({ c, code });
    }
    if (!take.length) return;
    const lines = take.flatMap(({ c, code }) => {
      const sym = `U${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
      return ['-e', `keycode ${code} = ${sym} ${sym}`];
    });
    await run([xmodmap, ...lines], env, 'binding characters to keys');
    // Bound: only now are the keys used and the characters known.
    this.spareKeycodes.splice(this.spareKeycodes.length - take.length);
    for (const { c } of take) this.boundChars.add(c);
  }

  async keys(keys: string[], delayMs = 60) {
    if (keys.length) await this.xdo(['key', '--delay', String(delayMs), '--', ...keys]);
  }

  async screenshot() {
    this.importBin ??= resolveBin(DISPLAY_BINS.import, this.o.log);
    return run([this.importBin, '-window', 'root', 'png:-'], { ...withoutDisplays(process.env), DISPLAY: `:${this.display}` }, 'screenshot');
  }

  async fit(windowName: string) {
    const ids = (await this.xdo(['search', '--onlyvisible', '--name', windowName], 'finding the window').catch(() => '')).split('\n').filter(Boolean);
    let best: { id: string; x: number; y: number; w: number; h: number } | null = null;
    for (const id of ids) {
      const g = Object.fromEntries((await this.xdo(['getwindowgeometry', '--shell', id])).split('\n').filter(Boolean).map((l) => l.split('=')));
      const w = Number(g.WIDTH);
      const h = Number(g.HEIGHT);
      if (w < 200 || h < 200) continue;
      if (!best || w * h > best.w * best.h) best = { id, x: Number(g.X), y: Number(g.Y), w, h };
    }
    if (!best || (best.x === 0 && best.y === 0 && best.w === this.o.width && best.h === this.o.height)) return;
    await this.xdo(['windowmove', best.id, '0', '0', 'windowsize', best.id, String(this.o.width), String(this.o.height)]);
  }

  async closeWindows(windowName: string) {
    this.xdotool ??= resolveBin(DISPLAY_BINS.xdotool, this.o.log);
    // xdotool search exits 1 when nothing matches.
    const ids = (await this.xdo(['search', '--onlyvisible', '--name', windowName], 'finding the window').catch(() => ''))
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
    for (const id of ids) closeWindow(this.display, id, this.xdotool);
    return ids.length > 0;
  }

  async stop() {
    this.vnc?.stop();
    this.xvnc = null;
  }

  /** Its runtime directory; the live view's socket is its owner's (Sandbox.stop), Xvfb's are Xvfb's. */
  async removeFiles() {
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }
}
