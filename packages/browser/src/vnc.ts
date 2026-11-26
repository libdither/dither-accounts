/**
 * A sandbox's live view: x11vnc (or an Xvnc, its own X server: xvncArgs below; or, on a Wayland backend, wayvnc or
 * w0vncserver: wayland.ts) on a Unix socket in the account's own directory, and on no TCP port at all.
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
import { connect } from 'node:net';
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


/**
 * Wait until the VNC server on the socket says its first words ("RFB 003.008\n"). A server can have its socket's file
 * before it answers there: bind() makes it before listen() (wayvnc on a loaded machine refused a connection then), an
 * Xvnc listens before it has finished starting (its keyboard map), w0vncserver before it has found sway's protocols.
 * The live view works from here, not from when the socket appeared. Fails at once if the server exits.
 */
export async function waitForRfbBanner(socket: string, server: Subprocess, timeoutMs: number, name: string) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode) throw new Error(`${name} exited (${server.signalCode ?? server.exitCode}) before its live view answered`);
    const said = await new Promise<string | null>((resolve) => {
      const sock = connect({ path: socket });
      const done = (v: string | null) => (clearTimeout(t), sock.destroy(), resolve(v));
      const t = setTimeout(() => done(null), Math.max(0, deadline - Date.now()));
      sock.once('data', (b) => done(b.toString('latin1')));
      sock.once('error', (e) => ((last = e.message), done(null)));
      sock.once('close', () => done(null));
    });
    if (said?.startsWith('RFB ')) return;
    if (said !== null) last = `it said ${JSON.stringify(said.slice(0, 20))}`;
    await Bun.sleep(50);
  }
  throw new Error(`${name}'s live view did not answer within ${timeoutMs}ms (${last})`);
}

/** The Xvnc backends (screen.ts): an X server with its VNC server built in. */
export type XvncBackend = 'tigervnc' | 'kasmvnc';

/**
 * What each Xvnc is given beyond TigerVNC's flags (xvncArgs). KasmVNC is TigerVNC's fork, its RFB on the Unix socket
 * the same once our fork speaks standard RFB to a standard client (nix/kasmvnc.nix), and:
 *   -publicIP 127.0.0.1   without it, it asks STUN servers on the internet (stun.l.google.com and others) for the
 *                         machine's public address at every start, for a UDP transport only its own web client uses
 *   -DisableBasicAuth     else it gives a connection the rights its user has in ~/.kasmpasswd, and one with no user
 *                         (any on the Unix socket) gets none: no picture, no input, and nothing said about it
 * With no -websocketPort it opens no websocket or HTTP listener, nor any UDP socket.
 */
export const XVNC_EXTRA: Record<XvncBackend, readonly string[]> = {
  tigervnc: [],
  kasmvnc: ['-publicIP', '127.0.0.1', '-DisableBasicAuth'],
};

/**
 * An Xvnc for a display: the X server with its VNC server built in, so one process where x11 has two, and the picture
 * read where it is drawn instead of copied out through MIT-SHM (x11vnc holds about 40 SysV shared memory segments, a
 * machine-wide count with a limit; an Xvnc holds none). Its flags, checked with `ss -lntup`, `ss -lxp` and strace:
 *   :<n> -geometry WxH -depth 24, -nolisten tcp (and -nolisten local for a sandbox shown the path socket only),
 *   -dpi 96 as for Xvfb (Chromium sizes its window by it), -desktop sandbox (else the viewer is told user@host)
 *   -rfbunixpath <path> -rfbport -1   the socket, and no TCP port (without -rfbport -1 it takes 5900+n)
 *   -SecurityTypes None   the manager carries the socket, behind its login, as with x11vnc
 *   -AlwaysShared         a viewer asking for the screen alone does not push the others off
 *   -AcceptSetDesktopSize=0   viewers cannot resize it, as wayvnc's -R
 * and what XVNC_EXTRA adds for each.
 */
export function xvncArgs(backend: XvncBackend, bin: string, display: string, socket: string, o: { width: number; height: number; pathSocketOnly?: boolean }): string[] {
  return [
    bin,
    display,
    '-geometry',
    `${o.width}x${o.height}`,
    '-depth',
    '24',
    '-nolisten',
    'tcp',
    ...(o.pathSocketOnly ? ['-nolisten', 'local'] : []),
    '-dpi',
    '96',
    '-desktop',
    'sandbox',
    '-rfbunixpath',
    socket,
    '-rfbport',
    '-1',
    '-SecurityTypes',
    'None',
    '-AlwaysShared',
    '-AcceptSetDesktopSize=0',
    ...XVNC_EXTRA[backend],
  ];
}

/**
 * A live view's server kept running: started once (a failure then is the screen's start failing), and if it dies
 * afterwards, started again, waiting 0.5 s, then twice as long after each failed try, up to 30 s. On Wayland every
 * click and key goes through it too (wayland.ts), so while it is down health() says so, a status shows it, and input
 * waits for it (ready) rather than failing on a socket that is gone.
 */
export class KeptServer {
  private proc: Subprocess | null = null;
  private down: string | null = null;
  private stopped = false;
  private back: Promise<void> | null = null;
  private wake: (() => void) | null = null;

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
    },
  ) {}

  async start() {
    this.watch(await this.o.start());
  }

  health(): { ok: true } | { ok: false; note: string } {
    return this.down ? { ok: false, note: this.down } : { ok: true };
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
    void p.exited.then(() => {
      if (this.stopped || this.proc !== p) return;
      this.down = `${this.o.name} exited (${p.signalCode ?? p.exitCode}); starting it again`;
      this.o.log('warn', `the live view's server ${this.down}`);
      this.o.onHealth?.(this.health());
      this.back = this.restart().finally(() => (this.back = null));
    });
  }

  private async restart() {
    let wait = this.o.firstWaitMs ?? 500;
    for (let tries = 1; !this.stopped; tries++) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, wait);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wake = null;
      if (this.stopped) return;
      try {
        const p = await this.o.start();
        if (this.stopped) return;
        await this.o.after?.();
        this.down = null;
        this.o.log('info', `the live view's server (${this.o.name}) is back, after ${tries} ${tries === 1 ? 'try' : 'tries'}`);
        this.o.onHealth?.(this.health());
        this.watch(p);
        return;
      } catch (e) {
        this.down = `${this.o.name} did not start again (${(e as Error).message.slice(0, 160)}); trying again`;
        this.o.log('warn', `the live view's server ${this.down}`);
        wait = Math.min(wait * 2, 30_000);
      }
    }
  }
}
