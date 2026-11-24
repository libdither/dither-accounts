/**
 * A sandbox's screen: where its windows show, the live view of it, and real input and pictures of it. One of two
 * backends, chosen per sandbox (docs/browser.md, "Display backends"):
 *
 *   x11      Xvfb on a numbered display from the shared pool (display.ts), x11vnc as the live view (vnc.ts), xdotool
 *            for input, ImageMagick's import for pictures. The default.
 *   wayland  a headless sway of the sandbox's own, its socket in the account's directory and no number at all, wayvnc as
 *            the live view on the same socket path, input through that live view (rfb.ts) and wtype, pictures by grim
 *            (wayland.ts).
 *
 * The browser sandbox (sandbox.ts), Discord's and the native-app sandbox (packages/sandbox) each start one; the
 * `browser` interface (statements-common/browser-ops.ts) drives it. Nothing outside knows which backend it is but by
 * `backend`, `name` and `note`, for its status.
 */
import type { Subprocess } from 'bun';
import { DISPLAY_BINS, type Log, resolveBin, run, withoutDisplays } from './bins.ts';
import { type DisplayBackend, displayIsOurs, type FreeDisplay, type XDisplay } from './display.ts';
import { prepareVncSocket, vncSocketPath, waitForVncSocket, x11vncArgs } from './vnc.ts';
import { WaylandScreen } from './wayland.ts';
import { closeWindow } from './x11.ts';

export { DISPLAY_BACKEND_ENV, DISPLAY_BACKENDS, type DisplayBackend, displayBackend, parseBackend } from './display.ts';

/** A display as a status shows it: ":80" for an X display (a number is one), "wayland" for a compositor of its own. */
export function displayName(d: FreeDisplay | number | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  if (typeof d === 'number') return `:${d}`;
  return d.backend === 'wayland' ? 'wayland' : `:${d.display}`;
}

/** What runs it, for a status layer's note: "Xvfb :80", "sway (Wayland)". */
export function displayNote(d: FreeDisplay | number | null | undefined): string {
  if (d === null || d === undefined) return 'no display';
  if (typeof d === 'number') return `Xvfb :${d}`;
  return d.backend === 'wayland' ? 'sway (Wayland)' : `Xvfb :${d.display}`;
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
  /** x11: no abstract X socket either (-nolisten local), for a sandbox that is shown only the path socket. */
  pathSocketOnly?: boolean;
  spawn: ScreenSpawn;
  log: Log;
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
  /** Its own connections closed and its files gone; the processes are its owner's to stop (procNames). */
  stop(): Promise<void>;
}

export function makeScreen(o: ScreenOptions): Screen {
  const free: FreeDisplay = typeof o.display === 'number' ? { backend: 'x11', display: o.display } : o.display;
  if (free.backend === 'wayland') return new WaylandScreen(o, free);
  return new XScreen(o, free);
}

/** Xvfb, x11vnc, xdotool and import: the backend the sandboxes always had. */
class XScreen implements Screen {
  readonly backend = 'x11' as const;
  readonly display: number;
  readonly vncSocket: string;
  readonly procNames = ['x11vnc', 'Xvfb'] as const;
  private xdotool: string | null = null;
  private importBin: string | null = null;

  constructor(
    private o: ScreenOptions,
    readonly free: XDisplay,
  ) {
    this.display = free.display;
    this.vncSocket = o.vncSocket ?? vncSocketPath(o.dir);
  }

  get socket() {
    return `/tmp/.X11-unix/X${this.display}`;
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
    // login). -forever so it survives viewers leaving; -shared for several viewers.
    prepareVncSocket(this.vncSocket);
    const vnc = this.o.spawn('x11vnc', x11vncArgs(x11vncBin, d, this.vncSocket), { match: `-unixsock ${this.vncSocket}`, env: { DISPLAY: d } });
    await waitForVncSocket(this.vncSocket, vnc, 10_000, 'x11vnc');
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

  async stop() {}
}
