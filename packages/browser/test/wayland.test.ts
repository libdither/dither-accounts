/**
 * The wayland display backends (src/wayland.ts and the parts it is made of): the unit parts on their own, then a real
 * headless sway with each live view, wayvnc (wayland) and w0vncserver (wayland-tigervnc), skipped without sway, grim and
 * that server, then Chromium on each, driven through the screen's input as the `browser` interface drives it (skipped
 * without Chromium too). Every process it starts is gone at the end.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { w0vnc, wayland, why } from '../../../test/needs.ts';
import { cleanEnv } from '../src/bins.ts';
import { DISPLAY_BACKENDS as MANAGER_BACKENDS, REFUSED_BACKENDS } from '../../manager/src/display-backend.ts';
import { DISPLAY_BACKENDS, displayBackend, parseBackend, pickFreeDisplay, type WaylandBackend } from '../src/display.ts';
import { message, readString } from '../src/ime.ts';
import { KEYSYM, parseChord, textRuns } from '../src/keysyms.ts';
import { RfbClient } from '../src/rfb.ts';
import { resolveChromium, Sandbox, screenFlags, screenPrefs } from '../src/sandbox.ts';
import { displayName, displayNote, makeScreen } from '../src/screen.ts';
import { IPC, ipcMessage, SwayIpc, views, type SwayNode } from '../src/swayipc.ts';
import { SOCKET_PATH_MAX } from '../src/vnc.ts';
import { swayConfig, swayRenderer, w0vncserverArgs, w0vncserverEnv, waylandDir, WaylandScreen, wayvncArgs } from '../src/wayland.ts';
import { inetSockets, unixSockets } from './inet.ts';

process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-wl-'));
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-wl-${p}-`));
  dirs.push(d);
  return d;
};
const procs: Subprocess[] = [];
afterAll(async () => {
  for (const p of procs) p.kill('SIGKILL');
  await Promise.all(procs.map((p) => p.exited));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('the backend: DITHER_DISPLAY_BACKEND, x11 when unset or empty, an error for anything else', async () => {
  expect(displayBackend({})).toBe('x11');
  expect(displayBackend({ DITHER_DISPLAY_BACKEND: '' })).toBe('x11');
  expect(displayBackend({ DITHER_DISPLAY_BACKEND: ' Wayland ' })).toBe('wayland');
  expect(displayBackend({ DITHER_DISPLAY_BACKEND: 'Wayland-TigerVNC' })).toBe('wayland-tigervnc');
  expect(() => displayBackend({ DITHER_DISPLAY_BACKEND: 'xorg' })).toThrow(/must be one of x11, tigervnc, kasmvnc, turbovnc, wayland, wayland-tigervnc/);
  expect(parseBackend('x11')).toBe('x11');
  expect(parseBackend(1)).toBeNull();
  // No display number to pick, claim or leave behind.
  expect(await pickFreeDisplay(undefined, [], 'wayland')).toEqual({ backend: 'wayland', display: null });
  expect(await pickFreeDisplay(undefined, [], 'wayland-tigervnc')).toEqual({ backend: 'wayland-tigervnc', display: null });
  expect(displayName({ backend: 'wayland-tigervnc', display: null })).toBe('wayland');
  expect(displayNote({ backend: 'wayland-tigervnc', display: null })).toBe('sway (Wayland, TigerVNC)');
  expect(displayName({ backend: 'wayland', display: null })).toBe('wayland');
  expect(displayName({ backend: 'x11', display: 82 })).toBe(':82');
  expect(displayName(83)).toBe(':83');
  expect(displayNote({ backend: 'wayland', display: null })).toBe('sway (Wayland)');
  expect(displayNote(84)).toBe('Xvfb :84');
  // The manager's own list (it does not depend on this package) is this one but for what it refuses.
  expect([...MANAGER_BACKENDS, ...Object.keys(REFUSED_BACKENDS)].sort()).toEqual([...DISPLAY_BACKENDS].sort());
});

test("keys: xdotool's names and chords, text as key runs (Shift where US needs it) and input-method runs", () => {
  expect(parseChord('Return')).toEqual({ mods: [], key: KEYSYM.Return! });
  expect(parseChord('ctrl+shift+Tab')).toEqual({ mods: [KEYSYM.Control_L!, KEYSYM.Shift_L!], key: KEYSYM.Tab! });
  expect(parseChord('ctrl++')).toEqual({ mods: [KEYSYM.Control_L!], key: '+'.charCodeAt(0) });
  expect(parseChord('a').key).toBe(0x61);
  expect(() => parseChord('NoSuchKey')).toThrow(/no key "NoSuchKey"/);
  expect(() => parseChord('hyperz+a')).toThrow(/no modifier "hyperz"/);
  expect(textRuns('aB\n')).toEqual([{ keys: [{ mods: [], key: 0x61 }, { mods: [KEYSYM.Shift_L!], key: 0x42 }, { mods: [], key: KEYSYM.Return! }] }]);
  expect(textRuns('hé€😀!')).toEqual([{ keys: [{ mods: [], key: 0x68 }] }, { text: 'é€😀' }, { keys: [{ mods: [KEYSYM.Shift_L!], key: 0x21 }] }]);
});

test('the Wayland wire: a message is id, size << 16 | opcode, arguments; strings counted with their NUL and padded', () => {
  const m = message(5, 3, [7, 'ab']);
  expect(m.length).toBe(8 + 4 + 8);
  expect(m.readUInt32LE(0)).toBe(5);
  expect(m.readUInt32LE(4)).toBe((20 << 16) | 3);
  expect(m.readUInt32LE(8)).toBe(7);
  expect(readString(m.subarray(8), 4)).toEqual({ value: 'ab', next: 12 });
  // Text with characters outside the BMP: its UTF-8 bytes, as committed.
  const e = message(9, 0, ['é😀']);
  expect(readString(e.subarray(8), 0).value).toBe('é😀');
  expect(e.length % 4).toBe(0);
});

test("sway's IPC: the i3-ipc header, and windows found under a tree", () => {
  const m = ipcMessage(IPC.RUN_COMMAND, 'kill');
  expect(m.subarray(0, 6).toString()).toBe('i3-ipc');
  expect(m.readUInt32LE(6)).toBe(4);
  expect(m.readUInt32LE(10)).toBe(0);
  const node = (id: number, type: SwayNode['type'], kids: SwayNode[] = [], pid?: number): SwayNode => ({ id, type, name: `n${id}`, pid, rect: { x: 0, y: 0, width: 1, height: 1 }, nodes: kids, floating_nodes: [] });
  const ws = node(3, 'workspace', [node(4, 'con', [], 100)]);
  ws.floating_nodes.push(node(5, 'floating_con', [], 101));
  expect(views(node(1, 'root', [node(2, 'output', [ws])])).map((v) => v.id)).toEqual([4, 5]);
});

test("sway's config: one output at the size, no Xwayland, nothing drawn around windows; wayvnc on its socket only", () => {
  const c = swayConfig(1280, 900);
  expect(c).toContain('xwayland disable');
  expect(c).toContain('output * mode --custom 1280x900 position 0 0 scale 1');
  expect(c).toContain('default_border none');
  expect(c).not.toMatch(/^exec/m);
  const a = wayvncArgs('/bin/wayvnc', '/a/vnc.sock', '/a/wl');
  expect(a).toEqual(['/bin/wayvnc', '-C', '/a/wl/wayvnc.conf', '-u', '-R', '-f', '60', '-k', 'us', '-S', '/a/wl/wayvnc.sock', '/a/vnc.sock']);
});

test("w0vncserver: its socket and no TCP port, no password, the US keymap, and no session bus (the machine's has the owner's portal)", () => {
  expect(w0vncserverArgs('/bin/w0vncserver', '/a/vnc.sock')).toEqual(['/bin/w0vncserver', '-rfbunixpath', '/a/vnc.sock', '-rfbport', '-1', '-SecurityTypes', 'None', '-AlwaysShared', '-desktop', 'sandbox', '-FrameRate', '60']);
  const env = w0vncserverEnv('/a/wl/wayland-1', '/a/wl');
  expect(env).toMatchObject({ WAYLAND_DISPLAY: '/a/wl/wayland-1', XDG_RUNTIME_DIR: '/a/wl', HOME: '/a/wl', XKB_DEFAULT_LAYOUT: 'us', DISPLAY: undefined });
  // Both buses are a path in its own directory that nothing makes: whatever the manager's environment had is replaced.
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/a/wl/no-bus');
  expect(env.DBUS_SYSTEM_BUS_ADDRESS).toBe('unix:path=/a/wl/no-bus');
  for (const k of ['XKB_DEFAULT_RULES', 'XKB_DEFAULT_MODEL', 'XKB_DEFAULT_VARIANT', 'XKB_DEFAULT_OPTIONS']) expect(k in env && env[k] === undefined).toBe(true);
});

test("sway's renderer: gles2 for an app on the GPU where there is a render node; pixman for one drawing in software, or without one", () => {
  const withNode = tmp('dri');
  writeFileSync(join(withNode, 'card0'), '');
  writeFileSync(join(withNode, 'renderD128'), '');
  const cardOnly = tmp('dri-card');
  writeFileSync(join(cardOnly, 'card0'), '');
  expect(swayRenderer(true, withNode)).toBe('gles2');
  expect(swayRenderer(false, withNode)).toBe('pixman');
  expect(swayRenderer(true, cardOnly)).toBe('pixman');
  expect(swayRenderer(true, join(cardOnly, 'missing'))).toBe('pixman');
});

test("the compositor's directory: wl in the account's, or one named for it in the runtime directory when too long", () => {
  expect(waylandDir('/home/u/.local/share/dither-accounts/accounts/acc_x')).toBe('/home/u/.local/share/dither-accounts/accounts/acc_x/wl');
  // sway works out its IPC socket's default name (sway-ipc.<uid>.<pid>.sock) in the directory and exits if that does
  // not fit, so an account directory that leaves room for wayland-1 but not that name goes to the runtime directory.
  const ipcName = `sway-ipc.${process.getuid!()}.4194304.sock`;
  const tight = `/${'t'.repeat(SOCKET_PATH_MAX - 1 - '/wl/'.length - ipcName.length)}`;
  expect(waylandDir(tight)).toBe(`${tight}/wl`);
  expect(waylandDir(`${tight}x`)).not.toBe(`${tight}x/wl`);
  expect(Buffer.byteLength(join(`${tight}x/wl`, 'wayland-99'))).toBeLessThanOrEqual(107);
  const deep = `/home/u/${'d'.repeat(120)}/acc_x`;
  const d = waylandDir(deep);
  expect(Buffer.byteLength(join(d, 'wayland-99'))).toBeLessThanOrEqual(107);
  expect(d).toMatch(/dither-wl(-\w+)?\/[0-9a-f]{16}$/);
  expect(waylandDir(deep)).toBe(d);
  expect(waylandDir(`${deep}2`)).not.toBe(d);
});

test("Chromium on wayland: its ozone and input-method flags, and the system's title bar in the profile (x11's default back on x11)", () => {
  const w = { backend: 'wayland', display: null } as const;
  expect(screenFlags({ backend: 'wayland' } as any)).toEqual(['--ozone-platform=wayland', '--enable-wayland-ime', '--wayland-text-input-version=3']);
  expect(screenFlags({ backend: 'x11' } as any)).toEqual([]);
  const prefs: Record<string, any> = { browser: { show_home_button: true }, profile: { x: 1 } };
  screenPrefs(prefs, w);
  expect(prefs).toEqual({ browser: { show_home_button: true, custom_chrome_frame: false }, profile: { x: 1 } });
  screenPrefs(prefs, 80);
  expect(prefs).toEqual({ browser: { show_home_button: true }, profile: { x: 1 } });
  const untouched: Record<string, any> = {};
  screenPrefs(untouched, { backend: 'x11', display: 81 });
  expect(untouched).toEqual({});
});

test('the RFB client: the 3.8 handshake with no authentication as a shared client, then pointer and key events', async () => {
  const dir = tmp('rfb');
  const path = join(dir, 'fake.sock');
  const got: Buffer[] = [];
  let shared = -1;
  const server: Server = createServer((s) => {
    let step = 0;
    let buf = Buffer.alloc(0);
    s.write('RFB 003.008\n');
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 12) {
        expect(buf.subarray(0, 12).toString()).toBe('RFB 003.008\n');
        buf = buf.subarray(12);
        step = 1;
        s.write(Buffer.from([2, 2, 1])); // VNC auth or None
      }
      if (step === 1 && buf.length >= 1) {
        expect(buf[0]).toBe(1);
        buf = buf.subarray(1);
        step = 2;
        s.write(Buffer.from([0, 0, 0, 0]));
      }
      if (step === 2 && buf.length >= 1) {
        shared = buf[0]!;
        buf = buf.subarray(1);
        step = 3;
        const init = Buffer.alloc(24);
        init.writeUInt16BE(640, 0);
        init.writeUInt16BE(480, 2);
        init.writeUInt32BE(4, 20);
        s.write(Buffer.concat([init, Buffer.from('fake')]));
      }
      if (step === 3 && buf.length) {
        got.push(Buffer.from(buf));
        buf = Buffer.alloc(0);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const c = await RfbClient.connect(path, 5000);
    expect([c.width, c.height, c.name, shared]).toEqual([640, 480, 'fake', 1]);
    c.pointer(700, -5, 1);
    c.key(KEYSYM.Return!, true);
    await c.flushed();
    const deadline = Date.now() + 5000;
    while (Buffer.concat(got).length < 14 && Date.now() < deadline) await Bun.sleep(10);
    const all = Buffer.concat(got);
    // Clamped to the screen: x 639, y 0.
    expect([...all.subarray(0, 6)]).toEqual([5, 1, 639 >> 8, 639 & 0xff, 0, 0]);
    expect(all[6]).toBe(4);
    expect(all[7]).toBe(1);
    expect(all.readUInt32BE(10)).toBe(KEYSYM.Return!);
    c.close();
    expect(c.open).toBe(false);
  } finally {
    server.close();
  }
});

const envs = new Map<Subprocess, Record<string, string | undefined>>();
const spawn = (_name: string, cmd: string[], o: { env?: Record<string, string | undefined> }) => {
  const p = Bun.spawn(cmd, { env: cleanEnv({ ...process.env, ...(o.env ?? {}) }), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  procs.push(p);
  envs.set(p, o.env ?? {});
  return p;
};
const pngSize = (b: Buffer) => (b.subarray(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);

/** The wayland backends this machine can run: wayvnc's with sway and grim, w0vncserver's too when it can be built. */
const BACKENDS: { backend: WaylandBackend; server: string; ok: () => boolean }[] = [
  { backend: 'wayland', server: 'wayvnc', ok: () => why('sway, wayvnc and grim', wayland) },
  { backend: 'wayland-tigervnc', server: 'w0vncserver', ok: () => why('sway, wayvnc and grim', wayland) && why('w0vncserver (nix/w0vncserver.nix)', w0vnc) },
];

describe.each(BACKENDS)('a real headless sway and its live view: $server', ({ backend, server, ok }) => {
  test.skipIf(!ok())(
    'the live view answers RFB on its socket alone (no TCP, no abstract socket), the seat has a pointer and keyboard, grim takes the picture',
    async () => {
      const dir = tmp('screen');
      const start = procs.length;
      const screen = makeScreen({ display: { backend, display: null }, dir, width: 1024, height: 700, spawn, log: () => {} });
      expect(screen).toBeInstanceOf(WaylandScreen);
      try {
        await screen.start();
        const [sway, vnc] = procs.slice(start);
        // A browser's screen (gpu by default): on the GPU where the machine has a render node.
        expect(envs.get(sway!)?.WLR_RENDERER).toBe(swayRenderer(true));
        expect(screen.vncSocket).toBe(join(dir, 'vnc.sock'));
        expect(statSync(join(dir, 'wl')).mode & 0o777).toBe(0o700);
        expect(screen.socket).toMatch(new RegExp(`^${join(dir, 'wl')}/wayland-\\d+$`));
        expect(screen.clientEnv()).toEqual({ WAYLAND_DISPLAY: screen.socket, DISPLAY: undefined, WAYLAND_SOCKET: undefined, XDG_SESSION_TYPE: 'wayland' });
        for (const p of [sway!, vnc!]) {
          expect(inetSockets(p.pid)).toEqual([]);
          expect(unixSockets(p.pid).filter((s) => s.startsWith('@'))).toEqual([]);
          for (const s of unixSockets(p.pid)) expect(s.startsWith(dir)).toBe(true);
        }
        expect(unixSockets(vnc!.pid)).toContain(screen.vncSocket);
        expect(screen.procNames[0]).toBe(server);
        if (backend === 'wayland-tigervnc') {
          // No session bus: the address it was given is a path in the compositor's directory that is not there.
          const bus = envs.get(vnc!)?.DBUS_SESSION_BUS_ADDRESS;
          expect(bus).toBe(`unix:path=${join(dir, 'wl', 'no-bus')}`);
          expect(existsSync(join(dir, 'wl', 'no-bus'))).toBe(false);
        }
        // A second viewer, as the manager's live view is: both servers let many share it.
        const viewer = await RfbClient.connect(screen.vncSocket, 5000);
        expect([viewer.width, viewer.height]).toEqual([1024, 700]);
        viewer.close();
        const ipc = await SwayIpc.connect(join(dir, 'wl', 'ipc.sock'));
        const seats = await ipc.request<{ capabilities: number }[]>(IPC.GET_SEATS);
        ipc.close();
        expect(seats.some((s) => (s.capabilities & 3) === 3)).toBe(true);
        expect(pngSize(await screen.screenshot())).toEqual([1024, 700]);
      } finally {
        for (const p of procs.slice(start)) p.kill();
        await Promise.all(procs.slice(start).map((p) => p.exited));
        await screen.stop();
      }
    },
    30_000,
  );
});

let chromium: string | null = null;
if (wayland) {
  try {
    chromium = resolveChromium(() => {});
  } catch (e) {
    console.warn(`wayland: the Chromium part skipped, ${(e as Error).message}`);
  }
}

describe.each(BACKENDS)('Chromium on a wayland backend: $server', ({ backend, ok }) => {
  test.skipIf(!chromium || !ok())(
    'clicks, keys and text (é, €, emoji) arrive as trusted input in the page, which has a fine pointer, hover and the focus',
    async () => {
      const reports: Record<string, unknown>[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === '/report') {
            reports.push(await req.json());
            return new Response('ok');
          }
          return new Response(
            `<html><body style="margin:0"><p style="position:absolute;left:10px;top:0;margin:0">probe</p><input id="f" style="position:absolute;left:100px;top:100px;width:300px;height:40px"><script>
              const f = document.getElementById('f');
              const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
              let keys = [];
              f.addEventListener('mousedown', (e) => say({ ev: 'mousedown', trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
              f.addEventListener('keydown', (e) => keys.push((e.isTrusted ? '' : '!') + e.code));
              f.addEventListener('keyup', (e) => { if (e.code === 'Enter') say({ ev: 'done', value: f.value, keys }); });
              const page = () => say({ ev: 'page', fine: matchMedia('(pointer: fine)').matches, hover: matchMedia('(hover: hover)').matches, w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight });
              // First once the page has been painted and two frames have passed (as share-page.ts): this script runs
              // before Chromium has shown its window (outerWidth 0 then), and a click before the first frame can be lost.
              new PerformanceObserver((list, obs) => {
                if (!list.getEntries().some((e) => e.name === 'first-contentful-paint')) return;
                obs.disconnect();
                requestAnimationFrame(() => requestAnimationFrame(page));
              }).observe({ type: 'paint', buffered: true });
              addEventListener('resize', page);
              // A title that keeps changing, as a chat's unread count does: sway runs window rules again on each change.
              let n = 0;
              setInterval(() => (document.title = 'probe ' + n++), 200);
            </script></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        },
      });
      const origin = `http://127.0.0.1:${server.port}`;
      const acc = tmp('chromium');
      const src = join(acc, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0' }));
      const sb = new Sandbox({ accountDir: acc, display: { backend, display: null }, width: 1024, height: 700, extensionSrc: src, config: {}, startUrl: `${origin}/`, log: () => {} });
      const until = async (what: string, ok: () => boolean, ms = 20_000) => {
        const end = Date.now() + ms;
        while (!ok()) {
          if (Date.now() > end) throw new Error(`no ${what} (reports: ${JSON.stringify(reports)})`);
          await Bun.sleep(100);
        }
      };
      try {
        await sb.start();
        // The window is the screen's size from the page's first frame on: no client-side shadows counted in it
        // (screenPrefs: the system's title bar), so never an outerWidth wider than the screen.
        await until('page', () => reports.some((r) => r.ev === 'page'));
        const full = () => reports.find((r) => r.ev === 'page');
        expect(full()).toMatchObject({ w: 1024, ow: 1024, oh: 700 });
        // Fine pointer and hover only while the seat has the pointer the live view makes for the sandbox's own client.
        expect(full()).toMatchObject({ fine: true, hover: true });
        const screen = sb.screen!;
        // The page is the bottom innerHeight of the screen, below Chromium's own bar.
        const top = 700 - (full()!.h as number);
        // A page's script can run before its window is on the screen (a slow machine without a GPU draws its first
        // frame late): click once sway shows the window.
        const mapped = await SwayIpc.connect(join(waylandDir(acc), 'ipc.sock'));
        for (let end = Date.now() + 30_000; !views(await mapped.tree()).some((v) => v.rect.width === 1024 && v.rect.height === 700); ) {
          if (Date.now() > end) throw new Error('the window never filled the screen');
          await Bun.sleep(50);
        }
        mapped.close();
        await screen.click(250, top + 120);
        await until('mousedown', () => reports.some((r) => r.ev === 'mousedown'));
        expect(reports.find((r) => r.ev === 'mousedown')).toMatchObject({ trusted: true, x: 250, y: 120 });
        await screen.type('aB é€😀 Z');
        await screen.keys(['Return']);
        await until('done', () => reports.some((r) => r.ev === 'done'));
        const done = reports.find((r) => r.ev === 'done') as { value: string; keys: string[] };
        expect(done.value).toBe('aB é€😀 Z');
        // Real keys with their codes, Shift held for the capitals; the input method's text comes with no key at all.
        expect(done.keys).toEqual(['KeyA', 'ShiftLeft', 'KeyB', 'Space', 'Space', 'ShiftLeft', 'KeyZ', 'Enter']);
        expect(pngSize(await screen.screenshot())).toEqual([1024, 700]);
        // Still the tiled window filling the screen after many title changes, not floated as a dialog would be.
        const ipc = await SwayIpc.connect(join(waylandDir(acc), 'ipc.sock'));
        const wins = views(await ipc.tree());
        ipc.close();
        expect(wins.map((w) => [w.type, w.rect.width, w.rect.height])).toEqual([['con', 1024, 700]]);
      } finally {
        await sb.stop();
        server.stop(true);
      }
    },
    90_000,
  );
});
