/**
 * The Haveno desktop app in the account's sandbox (packages/sandbox), on its own display with a live view, on the
 * node's own data directory: the same account, wallet and trades the daemon serves, with Haveno's own screens.
 *
 * The daemon and the app never run at once: both take a flock on <data>/.instance.lock (a
 * `haveno-desktop` launcher and the daemon's unit should both take it). Opening the app stops the daemon through its API (a clean stop);
 * the launcher waits for the lock. When the app quits (Ctrl+Q in it, or closeApp here), the daemon, which systemd
 * restarts after any exit, takes the lock again and comes back by itself.
 *
 * Quitting is Haveno's own: its window's close request asks you (in the live view) when trades or offers are open.
 * There is no window manager, so closeApp sends the window the close request a window manager would. Stopping the sandbox kills the app, like a
 * power cut; the wallet survives that, but it is a last resort (and what a manager restart does to an open app).
 */
import { spawnSync } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppSandbox, type Network, pickFreeDisplay, resolveBin, type SandboxEvent, tryBin, BINS } from '@dither-accounts/sandbox';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

/** Where the data directory shows inside the sandbox (its home is /home/user): the launcher's default. */
const INSIDE = '.local/share/Haveno-reto';
const WINDOW = '^Haveno';

/** libX11, for closeWindow: the system's, or the one xdotool links. */
function libX11(xdotool: string): string {
  if (process.env.DITHER_LIBX11 && existsSync(process.env.DITHER_LIBX11)) return process.env.DITHER_LIBX11;
  for (const c of ['/run/current-system/sw/lib/libX11.so.6', '/run/current-system/sw/share/nix-ld/lib/libX11.so.6', '/usr/lib/x86_64-linux-gnu/libX11.so.6', '/usr/lib/libX11.so.6']) if (existsSync(c)) return c;
  const m = (spawnSync('ldd', [xdotool], { encoding: 'utf8' }).stdout ?? '').match(/libX11\.so\.6 => (\S+)/);
  if (m) return m[1];
  throw new Error('libX11 not found (set DITHER_LIBX11)');
}

/**
 * What a window manager does when you close a window: a WM_PROTOCOLS client message with WM_DELETE_WINDOW. There is
 * no window manager on the sandbox's display, and xdotool's windowquit needs one.
 */
export function closeWindow(display: number, window: number, xdotool: string) {
  const x = dlopen(libX11(xdotool), {
    XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
    XInternAtom: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.u64 },
    XSendEvent: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    XFlush: { args: [FFIType.ptr], returns: FFIType.i32 },
    XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const cstr = (s: string) => ptr(Buffer.from(`${s}\0`));
  try {
    const dpy = x.symbols.XOpenDisplay(cstr(`:${display}`));
    if (!dpy) throw new Error(`cannot open display :${display}`);
    try {
      const protocols = BigInt(x.symbols.XInternAtom(dpy, cstr('WM_PROTOCOLS'), 0));
      const del = BigInt(x.symbols.XInternAtom(dpy, cstr('WM_DELETE_WINDOW'), 0));
      // XClientMessageEvent in the 192-byte XEvent, x86_64: type, serial, send_event, display, window, message_type,
      // format, data.l[5].
      const ev = new ArrayBuffer(192);
      const v = new DataView(ev);
      v.setInt32(0, 33, true); // ClientMessage
      v.setBigUint64(24, BigInt(dpy), true);
      v.setBigUint64(32, BigInt(window), true);
      v.setBigUint64(40, protocols, true);
      v.setInt32(48, 32, true);
      v.setBigUint64(56, del, true);
      v.setBigUint64(64, 0n, true); // CurrentTime
      if (!x.symbols.XSendEvent(dpy, BigInt(window), 0, 0n, ptr(new Uint8Array(ev)))) throw new Error('XSendEvent failed');
      x.symbols.XFlush(dpy);
    } finally {
      x.symbols.XCloseDisplay(dpy);
    }
  } finally {
    x.close();
  }
}

export interface AppOptions {
  accountDir: string;
  /** The node's data directory on the host (default ~/.local/share/Haveno-reto). */
  dataDir: string;
  log: Log;
  /** The app quit (by itself or closeApp); the sandbox is already down. */
  onExit: (code: number | null) => void;
  onChange: () => void;
  width?: number;
  height?: number;
  network?: Network;
  /** A command instead of `haveno-desktop` (tests). */
  command?: string[];
}

export class HavenoApp {
  private sandbox: AppSandbox | null = null;
  private stopping = false;
  error: string | null = null;
  startedAt: number | null = null;

  constructor(private o: AppOptions) {}

  get running(): boolean {
    return !!this.sandbox;
  }

  liveView(): { vncSocket: string; width: number; height: number } | null {
    if (!this.sandbox) return null;
    const i = this.sandbox.info();
    return { vncSocket: i.vncSocket, width: i.width, height: i.height };
  }

  private display: number | null = null;

  async start() {
    if (this.sandbox) return;
    this.stopping = false;
    this.error = null;
    if (!existsSync(this.o.dataDir)) throw new Error(`the node's data directory ${this.o.dataDir} is not there`);
    const command = this.o.command ?? [resolveBin({ name: 'haveno-desktop', env: 'HAVENO_DESKTOP_BIN', nix: 'haveno-desktop' }, this.o.log)];
    mkdirSync(join(this.o.accountDir, 'app'), { recursive: true });
    const tried: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const free = await pickFreeDisplay(undefined, tried);
      tried.push(free.display);
      const sb = new AppSandbox({
        dir: join(this.o.accountDir, 'app'),
        display: free.display,
        width: this.o.width ?? 1400,
        height: this.o.height ?? 900,
        command,
        // nix-ld's shim: the prebuilt tor and monero-wallet-rpc Haveno unpacks run through it.
        roBinds: existsSync('/lib64') ? ['/lib64'] : [],
        binds: [{ src: this.o.dataDir, dest: INSIDE }],
        network: this.o.network ?? 'pasta',
        fitWindow: this.o.command ? undefined : WINDOW,
        log: this.o.log,
        onEvent: (ev) => this.onEvent(ev),
      });
      try {
        await sb.start();
        this.sandbox = sb;
        this.display = free.display;
        this.startedAt = Date.now();
        this.o.log('info', `the desktop app runs on display :${free.display}`);
        this.o.onChange();
        return;
      } catch (e) {
        this.error = String((e as Error).message ?? e).slice(0, 300);
        await sb.stop().catch(() => {});
        if (!/display|Xvfb/i.test(this.error)) break;
      }
    }
    throw new Error(this.error ?? 'the sandbox did not start');
  }

  private onEvent(ev: SandboxEvent) {
    if (ev.t === 'app' && ev.state === 'exited' && !this.stopping) {
      this.o.log('info', `the desktop app quit (code ${ev.code ?? ev.signal})`);
      void this.down(ev.code ?? null);
    }
  }

  private async down(code: number | null) {
    const sb = this.sandbox;
    this.sandbox = null;
    this.display = null;
    this.startedAt = null;
    this.stopping = true;
    await sb?.stop().catch(() => {});
    this.o.onChange();
    this.o.onExit(code);
  }

  /**
   * Ask the app to quit, as closing its window would: WM_DELETE_WINDOW, which Haveno answers on the login screen and
   * after it (asking in the live view first when trades or offers are open). Its Ctrl+Q only works after login.
   */
  quit(): boolean {
    if (!this.sandbox || this.display == null) return false;
    const xdotool = tryBin(BINS.xdotool, this.o.log);
    if (!xdotool) throw new Error("xdotool is not available to find the app's window; quit it in the live view");
    const r = spawnSync(xdotool, ['search', '--onlyvisible', '--name', WINDOW], { env: { DISPLAY: `:${this.display}`, PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 10_000 });
    const ids = (r.stdout ?? '').split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
    if (!ids.length) throw new Error("the app's window is not there (still starting?); quit it in the live view");
    for (const id of ids) closeWindow(this.display, id, xdotool);
    return true;
  }

  /** Down now, without asking the app (a kill). */
  async kill() {
    if (!this.sandbox) return;
    this.o.log('warn', 'stopping the desktop app without asking it');
    await this.down(null);
  }

  layer(): Layer {
    if (this.sandbox) return { name: 'desktop app', state: 'ok', note: `in the live view since ${new Date(this.startedAt ?? Date.now()).toISOString()}` };
    if (this.error) return { name: 'desktop app', state: 'failed', note: this.error };
    return { name: 'desktop app', state: 'off', note: 'openApp shows it in the live view (the node stops meanwhile)' };
  }
}
