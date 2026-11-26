/**
 * The wayland display backend (src/wayland.ts and the parts it is made of): the unit parts on their own, then a real
 * headless sway and wayvnc (skipped without sway, wayvnc and grim), then Chromium on it, driven through the screen's
 * input as the `browser` interface drives it (skipped without Chromium too). Every process it starts is gone at the end.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { TEST_BINS, wayland, wev, why } from '../../../test/needs.ts';
import { BINS } from '../../sandbox/src/bins.ts';
import { cleanEnv, resolveBin, tryBin } from '../src/bins.ts';
import { ScreenShare, SHARE_BINS } from '../src/screenshare.ts';
import { displayBackend, parseBackend, pickFreeDisplay } from '../src/display.ts';
import { message, readString } from '../src/ime.ts';
import { KEYSYM, parseChord, textRuns } from '../src/keysyms.ts';
import { RfbClient } from '../src/rfb.ts';
import { resolveChromium, Sandbox } from '../src/sandbox.ts';
import { displayName, displayNote, displayState, makeScreen, type Screen, type ScreenHealth } from '../src/screen.ts';
import { IPC, ipcMessage, SwayIpc, views, type SwayNode } from '../src/swayipc.ts';
import { SOCKET_PATH_MAX } from '../src/vnc.ts';
import { privateDir, renderNode, swayConfig, swayRenderer, waylandDir, waylandPlace, WaylandScreen, wayvncArgs } from '../src/wayland.ts';
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
  expect(() => displayBackend({ DITHER_DISPLAY_BACKEND: 'xorg' })).toThrow(/one of x11, wayland/);
  expect(parseBackend('x11')).toBe('x11');
  expect(parseBackend(1)).toBeNull();
  // No display number to pick, claim or leave behind.
  expect(await pickFreeDisplay(undefined, [], 'wayland')).toEqual({ backend: 'wayland', display: null });
  expect(displayName({ backend: 'wayland', display: null })).toBe('wayland');
  expect(displayName({ backend: 'x11', display: 82 })).toBe(':82');
  expect(displayName(83)).toBe(':83');
  expect(displayNote({ backend: 'wayland', display: null })).toBe('sway (Wayland)');
  expect(displayNote(84)).toBe('Xvfb :84');
  expect(displayState({ backend: 'wayland', display: null }, { ok: true })).toEqual({ state: 'ok', note: 'sway (Wayland), live view ready' });
  expect(displayState({ backend: 'wayland', display: null }, { ok: false, note: 'wayvnc exited (SIGKILL); starting it again' })).toEqual({ state: 'failed', note: 'sway (Wayland): wayvnc exited (SIGKILL); starting it again' });
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
  expect(a).toEqual(['/bin/wayvnc', '-C', '/a/wl/wayvnc.conf', '-u', '-R', '-f', '60', '-k', 'us-altgr-intl', '-S', '/a/wl/wayvnc.sock', '/a/vnc.sock']);
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
  // A render node this process cannot open (no access to the render group) is as good as none.
  const shut = tmp('dri-shut');
  writeFileSync(join(shut, 'renderD128'), '');
  chmodSync(join(shut, 'renderD128'), 0o000);
  if (process.getuid?.() !== 0) {
    expect(renderNode(shut)).toBeNull();
    expect(swayRenderer(true, shut)).toBe('pixman');
  }
  writeFileSync(join(shut, 'renderD129'), '');
  expect(renderNode(shut)).toBe(join(shut, 'renderD129'));
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
  // Without a runtime directory: in /tmp, under a directory of this user's.
  const t = tmp('fallback');
  const place = waylandPlace(deep, {}, t);
  expect(place.root).toBe(t);
  expect(place.dir).toMatch(new RegExp(`^${t}/dither-wl-${process.getuid!()}/[0-9a-f]{16}$`));
});

test("the compositor's directory in /tmp: every level made 0700 and this user's own; a symlink or a file planted there is refused", () => {
  const uid = process.getuid!();
  const t = tmp('private');
  const dir = join(t, `dither-wl-${uid}`, 'abc');
  privateDir(dir, t, { fresh: true });
  for (const p of [join(t, `dither-wl-${uid}`), dir]) {
    const st = lstatSync(p);
    expect([st.isDirectory(), st.uid, st.mode & 0o777]).toEqual([true, uid, 0o700]);
  }
  // A level of ours left open to others is closed again.
  chmodSync(join(t, `dither-wl-${uid}`), 0o777);
  privateDir(dir, t, { fresh: true });
  expect(statSync(join(t, `dither-wl-${uid}`)).mode & 0o777).toBe(0o700);

  // Someone made the parent first: a symlink to a directory they can read, or a file.
  const hostile = tmp('hostile');
  const elsewhere = tmp('elsewhere');
  symlinkSync(elsewhere, join(hostile, `dither-wl-${uid}`));
  expect(() => privateDir(join(hostile, `dither-wl-${uid}`, 'abc'), hostile, { fresh: true })).toThrow(/not this user's own/);
  expect(lstatSync(join(hostile, `dither-wl-${uid}`)).isSymbolicLink()).toBe(true);
  expect(() => statSync(join(elsewhere, 'abc'))).toThrow();
  const planted = tmp('planted');
  writeFileSync(join(planted, `dither-wl-${uid}`), '');
  expect(() => privateDir(join(planted, `dither-wl-${uid}`, 'abc'), planted)).toThrow();
  // A symlink as the leaf itself is not followed when it is emptied either.
  const leaf = tmp('leaf');
  mkdirSync(join(leaf, `dither-wl-${uid}`), { mode: 0o700 });
  symlinkSync(elsewhere, join(leaf, `dither-wl-${uid}`, 'abc'));
  writeFileSync(join(elsewhere, 'keep'), 'x');
  expect(() => privateDir(join(leaf, `dither-wl-${uid}`, 'abc'), leaf, { fresh: true })).toThrow(/not this user's own/);
  expect(statSync(join(elsewhere, 'keep')).isFile()).toBe(true);
});

test("sway's IPC: a request with no answer is rejected at its deadline and its connection closed", async () => {
  const dir = tmp('ipc-stuck');
  const path = join(dir, 'stuck.sock');
  const server: Server = createServer(() => {});
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const ipc = await SwayIpc.connect(path);
    const t0 = Date.now();
    await expect(ipc.request(IPC.GET_TREE, '', 200)).rejects.toThrow(/did not answer within 200 ms/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(195);
    expect(ipc.open).toBe(false);
    expect((await ipc.closed).message).toMatch(/did not answer/);
    await expect(ipc.tree()).rejects.toThrow(/did not answer/);
  } finally {
    server.close();
  }
});

test("Chromium on wayland: its ozone and input-method flags, and the system's title bar in the profile (x11's default back on x11)", () => {
  const o = { dir: tmp('flags'), width: 100, height: 100, spawn: (() => {}) as any, log: () => {} };
  const w = makeScreen({ ...o, display: { backend: 'wayland', display: null } });
  const x = makeScreen({ ...o, display: 80 });
  expect([w.protocol, w.needsOwnBus, w.describe()]).toEqual(['wayland', true, 'sway (Wayland)']);
  expect([x.protocol, x.needsOwnBus, x.runtimeDir, x.describe()]).toEqual(['x11', false, null, 'Xvfb :80']);
  expect(w.chromiumFlags()).toEqual(['--ozone-platform=wayland', '--enable-wayland-ime', '--wayland-text-input-version=3']);
  expect(x.chromiumFlags()).toEqual([]);
  const prefs: Record<string, any> = { browser: { show_home_button: true }, profile: { x: 1 } };
  w.adjustPrefs(prefs);
  expect(prefs).toEqual({ browser: { show_home_button: true, custom_chrome_frame: false }, profile: { x: 1 } });
  x.adjustPrefs(prefs);
  expect(prefs).toEqual({ browser: { show_home_button: true }, profile: { x: 1 } });
  const untouched: Record<string, any> = {};
  x.adjustPrefs(untouched);
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
const named = new Map<Subprocess, string>();
const spawn = (name: string, cmd: string[], o: { env?: Record<string, string | undefined> }) => {
  const p = Bun.spawn(cmd, { env: cleanEnv({ ...process.env, ...(o.env ?? {}) }), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  procs.push(p);
  envs.set(p, o.env ?? {});
  named.set(p, name);
  return p;
};

/** A real screen on a fresh directory, with what its live view's server said of itself. */
async function realScreen(what: string, size = { width: 800, height: 600 }) {
  const dir = tmp(what);
  const start = procs.length;
  const healths: ScreenHealth[] = [];
  const waiters: { ok: (h: ScreenHealth) => boolean; resolve: () => void }[] = [];
  const screen = makeScreen({
    display: { backend: 'wayland', display: null },
    dir,
    ...size,
    spawn,
    log: () => {},
    onHealth: (h) => {
      healths.push(h);
      for (const w of waiters.splice(0)) (w.ok(h) ? w.resolve() : waiters.push(w));
    },
  }) as WaylandScreen;
  await screen.start();
  /** The next health report that `ok` takes. */
  const health = (ok: (h: ScreenHealth) => boolean) => new Promise<void>((resolve) => waiters.push({ ok, resolve }));
  const mine = () => procs.slice(start);
  const done = async () => {
    await screen.stop();
    for (const p of mine()) p.kill('SIGKILL');
    await Promise.all(mine().map((p) => p.exited));
  };
  return { dir, screen, healths, health, mine, done };
}

/** wev on the screen, its lines as they come (line-buffered: wev's stdout is a pipe here). */
function wevOn(screen: Screen) {
  const stdbuf = join(dirname(resolveBin(BINS.env, () => {})), 'stdbuf');
  const p = Bun.spawn([stdbuf, '-oL', resolveBin(TEST_BINS.wev, () => {})], { env: cleanEnv({ ...process.env, ...screen.clientEnv() }), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  procs.push(p);
  const o = { text: '', proc: p };
  void (async () => {
    const dec = new TextDecoder();
    for await (const c of p.stdout) o.text += dec.decode(c, { stream: true });
  })();
  return o;
}

/** Until `ok`, looking again every 25 ms; fails with `what` after `ms`. */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`no ${what} within ${ms} ms`);
    await Bun.sleep(25);
  }
}
const pngSize = (b: Buffer) => (b.subarray(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);

describe.skipIf(!why('sway, wayvnc and grim', wayland))('a real headless sway and wayvnc', () => {
  test(
    'the live view answers RFB on its socket alone (no TCP, no abstract socket), the seat has a pointer and keyboard, grim takes the picture',
    async () => {
      const dir = tmp('screen');
      const start = procs.length;
      const screen = makeScreen({ display: { backend: 'wayland', display: null }, dir, width: 1024, height: 700, spawn, log: () => {} });
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
        // A second viewer, as the manager's live view is: wayvnc lets many share it.
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

describe.skipIf(!why('sway, wayvnc, grim and wev', wayland && wev))('windows and input on a real sway', () => {
  test('two windows that open at the same moment: the first stays tiled, the other floats, every time', async () => {
    const r = await realScreen('two-windows');
    try {
      const ipc = await SwayIpc.connect(r.screen.ipcSocket);
      try {
        for (let round = 0; round < 3; round++) {
          const a = wevOn(r.screen);
          const b = wevOn(r.screen);
          await until('both windows', async () => views(await ipc.tree()).length === 2);
          await until('both placed', async () => (await r.screen.placedWindows()).length === 2);
          const wins = views(await ipc.tree());
          expect(wins.map((w) => w.type).sort()).toEqual(['con', 'floating_con']);
          // The tiled one is the first sway said had opened.
          const [first] = await r.screen.placedWindows();
          expect(wins.find((w) => w.type === 'con')!.id).toBe(first!);
          for (const w of [a, b]) w.proc.kill();
          await Promise.all([a.proc.exited, b.proc.exited]);
          await until('the windows gone', async () => views(await ipc.tree()).length === 0);
        }
      } finally {
        ipc.close();
      }
    } finally {
      await r.done();
    }
  }, 60_000);

  test('wayvnc killed: the status says it is down, it is started again, and clicks and keys go through once more', async () => {
    const r = await realScreen('wayvnc-dies');
    try {
      const w = wevOn(r.screen);
      const ipc = await SwayIpc.connect(r.screen.ipcSocket);
      await until('the window', async () => views(await ipc.tree()).length === 1);
      ipc.close();
      await r.screen.keys(['a']);
      await until("wev's a", () => /sym: a\b/.test(w.text));
      const vnc = r.mine().find((p) => named.get(p) === 'wayvnc')!;
      const down = r.health((h) => !h.ok);
      const up = r.health((h) => h.ok);
      vnc.kill('SIGKILL');
      await down;
      expect(r.healths[0]).toEqual({ ok: false, note: 'wayvnc exited (SIGKILL); starting it again' });
      // Input asked for while it is down waits for it instead of failing on a socket that is gone.
      const typed = r.screen.keys(['b']);
      await up;
      await typed;
      expect(r.screen.health()).toEqual({ ok: true });
      expect(r.mine().filter((p) => named.get(p) === 'wayvnc').length).toBe(2);
      await until("wev's b, through the new wayvnc", () => /sym: b\b/.test(w.text));
      await r.screen.click(400, 300);
      await until("wev's click", () => /button: \d+ \(left\), state: 1/.test(w.text));
    } finally {
      await r.done();
    }
  }, 60_000);

  test("a person typing é, ß, £, € and ñ in the live view: each arrives (wayvnc's keymap has them)", async () => {
    const r = await realScreen('viewer-keys');
    try {
      const w = wevOn(r.screen);
      const ipc = await SwayIpc.connect(r.screen.ipcSocket);
      await until('the window', async () => views(await ipc.tree()).length === 1);
      ipc.close();
      // Another client on the live view's socket, as the manager's page is, sending a viewer's keysyms.
      const viewer = await RfbClient.connect(r.screen.vncSocket, 5000);
      try {
        for (const ks of [0xe9, 0xdf, 0xa3, 0x20ac, 0xf1, 0x27]) {
          viewer.key(ks, true);
          viewer.key(ks, false);
        }
        await viewer.flushed();
        await until('every character', () => ["'é'", "'ß'", "'£'", "'€'", "'ñ'", "'''"].every((c) => w.text.includes(`utf8: ${c}`)));
      } finally {
        viewer.close();
      }
    } finally {
      await r.done();
    }
  }, 60_000);
});

describe.skipIf(!why('sway, wayvnc, grim and dbus-daemon', wayland && !!tryBin(SHARE_BINS.dbusDaemon, () => {})))('screen sharing that fails to start', () => {
  test('a capture that fails (PipeWire exits): what it started is ended, and the bus alone runs; Chromium gets no capture flag', async () => {
    const r = await realScreen('share-fails');
    try {
      const fails = join(r.dir, 'pipewire-fails');
      writeFileSync(fails, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
      const logs: string[] = [];
      const share = new ScreenShare({ dir: r.screen.runtimeDir, waylandSocket: r.screen.socket, spawn, log: (l, m) => logs.push(`${l} ${m}`), bins: { pipewire: fails } });
      await share.startOrBusOnly(true);
      expect(share.capturing).toBe(false);
      expect(logs.some((l) => /^warn screen sharing is off for this run: pipewire exited \(3\)/.test(l))).toBe(true);
      const buses = r.mine().filter((p) => named.get(p) === 'dbus-daemon');
      // The capture's bus ended with it; the one started after it runs, and is where the client is pointed.
      expect(buses.map((p) => p.exitCode !== null || !!p.signalCode)).toEqual([true, false]);
      expect(r.mine().filter((p) => named.get(p) === 'pipewire').every((p) => p.exitCode !== null)).toBe(true);
      expect(lstatSync(join(share.dir, 'bus')).isSocket()).toBe(true);
      expect(share.clientEnv()).toEqual({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(share.dir, 'bus')}` });
      await share.stop();
    } finally {
      await r.done();
    }
  }, 60_000);
});

let chromium: string | null = null;
if (wayland) {
  try {
    chromium = resolveChromium(() => {});
  } catch (e) {
    console.warn(`wayland: the Chromium part skipped, ${(e as Error).message}`);
  }
}

describe.skipIf(!chromium)('Chromium on the wayland backend', () => {
  test(
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
            `<html><body style="margin:0"><input id="f" style="position:absolute;left:100px;top:100px;width:300px;height:40px"><script>
              const f = document.getElementById('f');
              const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
              let keys = [];
              f.addEventListener('mousedown', (e) => say({ ev: 'mousedown', trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
              f.addEventListener('keydown', (e) => keys.push((e.isTrusted ? '' : '!') + e.code));
              f.addEventListener('keyup', (e) => { if (e.code === 'Enter') say({ ev: 'done', value: f.value, keys }); });
              const page = () => say({ ev: 'page', fine: matchMedia('(pointer: fine)').matches, hover: matchMedia('(hover: hover)').matches, w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight });
              page();
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
      const sb = new Sandbox({ accountDir: acc, display: { backend: 'wayland', display: null }, width: 1024, height: 700, extensionSrc: src, config: {}, startUrl: `${origin}/`, log: () => {} });
      const until = async (what: string, ok: () => boolean, ms = 20_000) => {
        const end = Date.now() + ms;
        while (!ok()) {
          if (Date.now() > end) throw new Error(`no ${what} (reports: ${JSON.stringify(reports)})`);
          await Bun.sleep(100);
        }
      };
      try {
        await sb.start();
        // The window is the screen's size from the page's first script on: no client-side shadows counted in it
        // (screenPrefs: the system's title bar), so never an outerWidth wider than the screen.
        await until('page', () => reports.some((r) => r.ev === 'page'));
        const full = () => reports.find((r) => r.ev === 'page');
        expect(full()).toMatchObject({ w: 1024, ow: 1024, oh: 700 });
        // Fine pointer and hover only while the seat has the pointer wayvnc makes for the sandbox's own client.
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
