/**
 * What the x11 backend (screen.ts) asks of an X server beyond xdotool: whether a display is our Xvfb's, and closing a
 * window as a window manager would (there is none on a sandbox's display, and xdotool's windowquit needs one).
 */
import { spawnSync } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { existsSync } from 'node:fs';

export { displayIsOurs } from './display.ts';

/** libX11, for closeWindow: the system's, or the one xdotool links. */
function libX11(xdotool: string): string {
  if (process.env.DITHER_LIBX11 && existsSync(process.env.DITHER_LIBX11)) return process.env.DITHER_LIBX11;
  for (const c of ['/run/current-system/sw/lib/libX11.so.6', '/run/current-system/sw/share/nix-ld/lib/libX11.so.6', '/usr/lib/x86_64-linux-gnu/libX11.so.6', '/usr/lib/libX11.so.6']) if (existsSync(c)) return c;
  const m = (spawnSync('ldd', [xdotool], { encoding: 'utf8' }).stdout ?? '').match(/libX11\.so\.6 => (\S+)/);
  if (m) return m[1]!;
  throw new Error('libX11 not found (set DITHER_LIBX11)');
}

/** What a window manager does when you close a window: a WM_PROTOCOLS client message with WM_DELETE_WINDOW. */
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
