/**
 * A sandbox's screen: where its windows show, the live view of it, and real input and pictures of it. One per
 * backend (the list is packages/spec display.ts), chosen per sandbox (docs/browser.md, "Display backends"):
 *
 *   x11      Xvfb on a numbered display from the shared pool (display.ts), x11vnc as the live view (vnc.ts), xdotool
 *            for input, ImageMagick's import for pictures. The default.
 *   wayland  a headless sway of the sandbox's own, its socket in the account's directory and no number at all, wayvnc as
 *            the live view on the same socket path, input through that live view (rfb.ts) and, for what no key types,
 *            an input method (ime.ts), pictures by grim (wayland.ts).
 *
 * The browser sandbox (sandbox.ts), Discord's and the native-app sandbox (packages/sandbox) each start one; the
 * `browser` interface (statements-common/browser-ops.ts) drives it. Nothing outside asks which backend it is: what
 * differs is the Screen's to say (protocol, chromiumFlags, adjustPrefs, needsOwnBus, describe, health). A new backend
 * is a class here and a line in SCREENS.
 */
import type { Subprocess } from 'bun';
import { DISPLAY_BINS, type Log, resolveBin, run, withoutDisplays } from './bins.ts';
import { BACKENDS, type DisplayBackend, displayIsOurs, type FreeDisplay, type WaylandBackend, type WaylandDisplay, type XBackend, type XDisplay } from './display.ts';
import { KeptServer, prepareVncSocket, vncSocketPath, waitForVncSocket, x11vncArgs } from './vnc.ts';
import { renderNode, WaylandScreen } from './wayland.ts';
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
   * A client must get a session bus of its own here (screenshare.ts), never the machine's: on Wayland the machine's has
   * the owner's portal, which could share the owner's real screen. On X Chromium captures its X server itself.
   */
  readonly needsOwnBus: boolean;
  /** The screen's own private directory, short enough for sockets (the compositor's), where that bus goes; null: none. */
  readonly runtimeDir: string | null;
  /** What runs it, for logs and notes: "Xvfb :80", "sway (Wayland)" (displayNote). */
  describe(): string;
  /** Whether its live view's server runs (it is started again when it dies). */
  health(): ScreenHealth;
}

/** Each backend's screen: the type checker says when a backend in packages/spec has none. */
const SCREENS: { [K in DisplayBackend]: (o: ScreenOptions, free: K extends XBackend ? XDisplay : K extends WaylandBackend ? WaylandDisplay : never) => Screen } = {
  x11: (o, free) => new XScreen(o, free),
  wayland: (o, free) => new WaylandScreen(o, free),
};

export function makeScreen(o: ScreenOptions): Screen {
  const free: FreeDisplay = typeof o.display === 'number' ? { backend: 'x11', display: o.display } : o.display;
  return (SCREENS[free.backend] as (o: ScreenOptions, free: FreeDisplay) => Screen)(o, free);
}

/** Xvfb, x11vnc, xdotool and import: the backend the sandboxes always had. */
class XScreen implements Screen {
  readonly backend: XBackend;
  readonly protocol = 'x11' as const;
  readonly display: number;
  readonly vncSocket: string;
  readonly procNames = ['x11vnc', 'Xvfb'] as const;
  readonly needsOwnBus = false;
  readonly runtimeDir = null;
  private xdotool: string | null = null;
  private importBin: string | null = null;
  private vnc: KeptServer | null = null;

  constructor(
    private o: ScreenOptions,
    readonly free: XDisplay,
  ) {
    this.backend = free.backend;
    this.display = free.display;
    this.vncSocket = o.vncSocket ?? vncSocketPath(o.dir);
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
    return this.vnc?.health() ?? { ok: true };
  }

  async start() {
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
   * Our Xvfb's display is up: its socket there and its lock naming it. Two sandboxes starting together can pick the
   * same free display: the socket is then the other one's, and ours is about to exit with "already active".
   */
  private async waitForDisplay(xvfb: Subprocess, ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (xvfb.exitCode !== null) throw new Error(`Xvfb on :${this.display} exited (${xvfb.exitCode}); is the display taken?`);
      if (displayIsOurs(this.display, xvfb.pid)) return;
      await Bun.sleep(50);
    }
    throw new Error(`Xvfb display :${this.display} did not come up within ${ms} ms`);
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
    if (text) await this.xdo(['type', '--delay', String(delayMs), '--', text]);
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
  }

  /** Nothing of its own: the live view's socket is its owner's (Sandbox.stop), Xvfb's are Xvfb's. */
  async removeFiles() {}
}
