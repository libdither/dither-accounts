/**
 * A sandbox's live view: x11vnc (or, on the wayland backend, wayvnc: wayland.ts) on a Unix socket in the account's own
 * directory, and on no TCP port at all.
 *
 * It used to listen on 127.0.0.1:5900+display with -nopw, which let anything on this machine in: any local process, and
 * any web page open in a browser here, since libvncserver also takes a WebSocket upgrade on that port from any Origin.
 * A socket in a 0700 directory, itself 0600, reaches only this user; the manager carries it on, behind its login, to the
 * page's live view and to an app that manages the account (liveViewPath). Apps never see its path.
 *
 * x11vnc 0.9.17's flags for that, each checked with `ss -ltnp` in a fresh network namespace:
 *   -unixsock <path>  listen there
 *   -rfbport 0        no IPv4 port. Despite its -help, this alone still leaves libvncserver's IPv6 one: [::]:5900, on
 *                     every interface
 *   -rfbportv6 -1     so: no IPv6 port either
 *   -no6              nor x11vnc's own IPv6 listening mode
 *   (no -localhost)   it would turn the socket's clients away ("localhost does not match 127.0.0.1"); with no port
 *                     there is nothing left for it to guard
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Subprocess } from 'bun';

/** The socket's name in the account's directory. */
export const VNC_SOCKET = 'vnc.sock';
/** A Unix socket's path is at most 107 bytes (sun_path, less its NUL). */
export const SOCKET_PATH_MAX = 107;

/**
 * Where an account's live view listens: `vnc.sock` in its directory, or, when that path is too long for a Unix socket,
 * a socket named for the directory in this user's runtime directory (also 0700).
 */
export function vncSocketPath(dir: string): string {
  const own = join(resolve(dir), VNC_SOCKET);
  if (Buffer.byteLength(own) <= SOCKET_PATH_MAX) return own;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? join(runtime, 'dither-vnc') : join(tmpdir(), `dither-vnc-${process.getuid?.() ?? 'user'}`);
  return join(base, `${createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 16)}.sock`);
}

/** x11vnc for a display, on that socket only (see above), no password, kept up for any number of viewers. */
export function x11vncArgs(x11vnc: string, display: string, socket: string): string[] {
  return [x11vnc, '-display', display, '-unixsock', socket, '-rfbport', '0', '-rfbportv6', '-1', '-no6', '-nopw', '-forever', '-shared', '-noxdamage', '-quiet'];
}

/**
 * Ready the socket's directory before x11vnc binds there: made 0700 if new, and refused unless it is this user's and
 * closed to everyone else (an existing one is closed if it is ours). A socket left from an earlier run is removed, so
 * waiting for the socket waits for this x11vnc.
 */
export function prepareVncSocket(socket: string) {
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`the live view's socket path is too long (${socket})`);
  const dir = dirname(socket);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error(`the live view's directory ${dir} is not this user's own`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  rmSync(socket, { force: true });
}

/** Wait until the VNC server (x11vnc, wayvnc) listens on the socket, then make the socket 0600; fail at once if it gave up. */
export async function waitForVncSocket(socket: string, server: Subprocess, timeoutMs: number, name = 'x11vnc') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode) throw new Error(`${name} exited (${server.signalCode ?? server.exitCode}) before its live view socket came up`);
    try {
      if (lstatSync(socket).isSocket()) {
        chmodSync(socket, 0o600);
        return;
      }
    } catch {
      // not there yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`${name}'s live view socket did not come up within ${timeoutMs}ms`);
}


/** End a process: SIGTERM, then SIGKILL if it is still there after `ms`; resolves once it has exited. */
export async function endProcess(p: Subprocess, ms = 3000) {
  if (p.exitCode !== null || p.signalCode) return;
  try {
    p.kill('SIGTERM');
  } catch {}
  let t: Timer | undefined;
  const late = new Promise<'late'>((r) => (t = setTimeout(() => r('late'), ms)));
  const how = await Promise.race([p.exited.then(() => 'gone' as const, () => 'gone' as const), late]);
  clearTimeout(t);
  if (how === 'late') {
    try {
      p.kill('SIGKILL');
    } catch {}
    await p.exited.catch(() => {});
  }
}

/**
 * A live view's server kept running: started once (a failure then is the screen's start failing), and if it dies
 * afterwards, started again, waiting 0.5 s, then twice as long after each try, up to 30 s. The wait goes back to
 * 0.5 s only once a server has stayed up for a while (stableMs, 30 s): one that starts and dies soon after (wayvnc
 * crashing as each viewer connects, say) is started again ever more slowly, not twice a second for good. A try whose
 * `after` step fails ends the process it started, and waits for it to go, before the next: never two at once. On
 * Wayland every click and key goes through it too (wayland.ts), so while it is down health() says so, a status shows
 * it, and input waits for it (ready) rather than failing on a socket that is gone.
 */
export class KeptServer {
  private proc: Subprocess | null = null;
  private down: string | null = null;
  private stopped = false;
  private back: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  /** The wait before the next try; back to the first once a server has stayed up for stableMs. */
  private wait: number;
  /** When the server that runs now started serving. */
  private upAt = 0;

  constructor(
    private o: {
      name: string;
      /** Spawn it and wait until it serves; resolves to its process. */
      start: () => Promise<Subprocess>;
      /** After a restart, before it counts as up: what the screen needs of it again (its input client). */
      after?: () => Promise<void>;
      log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
      onHealth?: (h: { ok: true } | { ok: false; note: string }) => void;
      /** The first wait before a restart (tests make it short). */
      firstWaitMs?: number;
      /** The longest wait (30 s). */
      maxWaitMs?: number;
      /** How long a server must stay up before the wait starts over from the first (30 s). */
      stableMs?: number;
    },
  ) {
    this.wait = this.firstWait;
  }

  private get firstWait() {
    return this.o.firstWaitMs ?? 500;
  }

  async start() {
    this.watch(await this.o.start());
  }

  health(): { ok: true } | { ok: false; note: string } {
    return this.down ? { ok: false, note: this.down } : { ok: true };
  }

  /** The wait before the next try, were the server to die now (for tests). */
  get nextWaitMs(): number {
    return Date.now() - this.upAt >= (this.o.stableMs ?? 30_000) ? this.firstWait : this.wait;
  }

  /** Resolves once it serves (at once when it does); rejects after `ms` or once stopped. */
  async ready(ms = 15_000): Promise<void> {
    if (!this.back) return;
    let t: Timer | undefined;
    try {
      await Promise.race([this.back, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`the live view's server (${this.o.name}) is down: ${this.down}`)), ms)))]);
    } finally {
      clearTimeout(t);
    }
    if (this.stopped) throw new Error(`the live view's server (${this.o.name}) is stopped`);
  }

  stop() {
    this.stopped = true;
    this.wake?.();
  }

  private watch(p: Subprocess) {
    this.proc = p;
    this.upAt = Date.now();
    void p.exited.then(() => {
      if (this.stopped || this.proc !== p) return;
      this.wait = this.nextWaitMs;
      this.down = `${this.o.name} exited (${p.signalCode ?? p.exitCode}); starting it again`;
      this.o.log('warn', `the live view's server ${this.down}`);
      this.o.onHealth?.(this.health());
      this.back = this.restart().finally(() => (this.back = null));
    });
  }

  private async restart() {
    for (let tries = 1; !this.stopped; tries++) {
      const wait = this.wait;
      this.wait = Math.min(wait * 2, this.o.maxWaitMs ?? 30_000);
      await new Promise<void>((r) => {
        const t = setTimeout(r, wait);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wake = null;
      if (this.stopped) return;
      let p: Subprocess | null = null;
      try {
        p = await this.o.start();
        if (this.stopped) return void (await endProcess(p));
        await this.o.after?.();
        if (this.stopped) return void (await endProcess(p));
        this.down = null;
        this.o.log('info', `the live view's server (${this.o.name}) is back, after ${tries} ${tries === 1 ? 'try' : 'tries'}`);
        this.o.onHealth?.(this.health());
        this.watch(p);
        return;
      } catch (e) {
        // The one it started (its `after` failed) goes before the next try: one server at a time.
        if (p) await endProcess(p);
        this.down = `${this.o.name} did not start again (${(e as Error).message.slice(0, 160)}); trying again`;
        this.o.log('warn', `the live view's server ${this.down}`);
        this.o.onHealth?.(this.health());
      }
    }
  }
}
