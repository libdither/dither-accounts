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


/**
 * An Xvnc for a display (the tigervnc, kasmvnc and turbovnc backends: screen.ts): the X server with its VNC server built
 * in, so one process where x11 has two, and the picture read where it is drawn instead of copied out through MIT-SHM
 * (x11vnc holds about 40 SysV shared memory segments, a machine-wide count with a limit; an Xvnc holds none).
 *
 * Each one's flags, checked with `ss -lntup`, `ss -lxp` and strace (socket, bind, connect, sendto):
 *   common     :<n> -geometry WxH -depth 24, -nolisten tcp (and -nolisten local for a sandbox shown the path socket
 *              only), -dpi 96 as for Xvfb (Chromium sizes its window by it)
 *   tigervnc   -rfbunixpath <path> and -rfbport -1: the socket, and no TCP port (without -rfbport -1 it takes 5900+n).
 *              -SecurityTypes None (the manager carries the socket, behind its login, as with x11vnc), -AlwaysShared
 *              (a viewer asking for the screen alone does not push the others off), -AcceptSetDesktopSize=0 (viewers
 *              cannot resize it, as wayvnc's -R)
 *   kasmvnc    the same (KasmVNC is TigerVNC's fork, its RFB on the Unix socket unchanged), and -publicIP 127.0.0.1:
 *              without it, it asks STUN servers on the internet (stun.l.google.com and others) for the machine's public
 *              address at every start, for a UDP transport only its own web client uses. With no -websocketPort it
 *              opens no websocket or HTTP listener, nor any UDP socket.
 *   turbovnc   -rfbunixpath <path> alone opens no TCP port (TurboVNC listens on TCP only when given no Unix path);
 *              its options are lowercase and its own: -securitytypes none, -alwaysshared, -noreverse, and no
 *              -rfbport -1, which it refuses
 */
export function xvncArgs(backend: 'tigervnc' | 'kasmvnc' | 'turbovnc', bin: string, display: string, socket: string, o: { width: number; height: number; pathSocketOnly?: boolean }): string[] {
  const common = [bin, display, '-geometry', `${o.width}x${o.height}`, '-depth', '24', '-nolisten', 'tcp', ...(o.pathSocketOnly ? ['-nolisten', 'local'] : []), '-dpi', '96', '-desktop', 'sandbox'];
  if (backend === 'turbovnc') return [...common, '-rfbunixpath', socket, '-securitytypes', 'none', '-alwaysshared', '-noreverse'];
  const tiger = [...common, '-rfbunixpath', socket, '-rfbport', '-1', '-SecurityTypes', 'None', '-AlwaysShared', '-AcceptSetDesktopSize=0'];
  return backend === 'kasmvnc' ? [...tiger, '-publicIP', '127.0.0.1'] : tiger;
}
