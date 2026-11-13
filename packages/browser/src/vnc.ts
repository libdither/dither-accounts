/**
 * A sandbox's live view: x11vnc on a Unix socket in the account's own directory, and on no TCP port at all.
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

/** Wait until x11vnc listens on the socket, then make the socket 0600; fail at once if x11vnc gave up. */
export async function waitForVncSocket(socket: string, x11vnc: Subprocess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (x11vnc.exitCode !== null) throw new Error(`x11vnc exited (${x11vnc.exitCode}) before its live view socket came up`);
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
  throw new Error(`x11vnc's live view socket did not come up within ${timeoutMs}ms`);
}

