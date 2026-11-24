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
 *
 * On the account's display backend. Haveno is a JavaFX app, which draws only through X: on the wayland backend it gets
 * an Xwayland of its own inside its sandbox (xwayland-satellite, AppSandboxOptions.x11App), each of its windows a
 * window of the sandbox's sway; on x11, or where that cannot be had, an Xvfb as before.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppSandbox, type Network, pickFreeDisplay, resolveBin, type SandboxEvent } from '@dither-accounts/sandbox';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

/** Where the data directory shows inside the sandbox (its home is /home/user): the launcher's default. */
const INSIDE = '.local/share/Haveno-reto';
const WINDOW = '^Haveno';

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
      if (free.display !== null) tried.push(free.display);
      const sb = new AppSandbox({
        dir: join(this.o.accountDir, 'app'),
        display: free,
        width: this.o.width ?? 1400,
        height: this.o.height ?? 900,
        command,
        // nix-ld's shim: the prebuilt tor and monero-wallet-rpc Haveno unpacks run through it.
        roBinds: existsSync('/lib64') ? ['/lib64'] : [],
        binds: [{ src: this.o.dataDir, dest: INSIDE }],
        network: this.o.network ?? 'pasta',
        fitWindow: this.o.command ? undefined : WINDOW,
        x11App: true,
        log: this.o.log,
        onEvent: (ev) => this.onEvent(ev),
      });
      try {
        await sb.start();
        this.sandbox = sb;
        this.startedAt = Date.now();
        this.o.log('info', `the desktop app runs on ${sb.info().backend === 'wayland' ? 'Wayland (through xwayland-satellite)' : `display :${sb.info().display}`}`);
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
  async quit(): Promise<boolean> {
    const screen = this.sandbox?.screen;
    if (!screen) return false;
    let found: boolean;
    try {
      found = await screen.closeWindows(WINDOW);
    } catch (e) {
      throw new Error(`the app's window could not be asked to close (${(e as Error).message}); quit it in the live view`);
    }
    if (!found) throw new Error("the app's window is not there (still starting?); quit it in the live view");
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
