/**
 * The Xvnc display backends (tigervnc, kasmvnc, turbovnc: src/screen.ts, src/vnc.ts xvncArgs), each beside x11 where
 * they must behave alike: one process that is both X server and live view, on the account's Unix socket and no inet
 * socket at all (nor, for KasmVNC, any query to the internet), no SysV shared memory, many viewers at once, the
 * clipboard both ways through the live view, pictures by import, a display left by a killed server taken over, and
 * Chromium on it driven by xdotool as the `browser` interface drives it. Each backend skips when its Xvnc cannot be
 * had (DITHER_TESTS_NEED_ALL=1 fails instead). Every process it starts is gone at the end.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { why } from '../../../test/needs.ts';
import { cleanEnv, DISPLAY_BINS, resolveBin, tryBin } from '../src/bins.ts';
import { displayTaken, parseBackend, pickFreeDisplay, type XBackend } from '../src/display.ts';
import { RfbClient } from '../src/rfb.ts';
import { resolveChromium, Sandbox } from '../src/sandbox.ts';
import { displayName, displayNote, makeScreen, type Screen } from '../src/screen.ts';
import { xvncArgs } from '../src/vnc.ts';
import { inetSockets, rfbBanner, unixSockets } from './inet.ts';
import { decodePng } from './png.ts';

process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-xvnc-'));
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-xvnc-${p}-`));
  dirs.push(d);
  return d;
};
const procs: Subprocess[] = [];
afterAll(async () => {
  for (const p of procs) p.kill('SIGKILL');
  await Promise.all(procs.map((p) => p.exited));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(process.env.DITHER_DISPLAY_CLAIMS!, { recursive: true, force: true });
});

/** A screen's spawn as the sandboxes do it, every process kept for the end. */
const spawn = (_name: string, cmd: string[], o: { env?: Record<string, string | undefined> }) => {
  const p = Bun.spawn(cmd, { env: cleanEnv({ ...process.env, ...o.env }), stdout: 'ignore', stderr: 'ignore' });
  procs.push(p);
  return p;
};

test('the backends by name, and how a status shows their displays', () => {
  for (const b of ['tigervnc', 'KasmVNC', ' turbovnc ']) expect(parseBackend(b)).toBe(b.trim().toLowerCase() as XBackend);
  expect(parseBackend('xvnc')).toBeNull();
  expect(displayName({ backend: 'tigervnc', display: 83 })).toBe(':83');
  expect(displayNote({ backend: 'tigervnc', display: 83 })).toBe('Xvnc (TigerVNC) :83');
  expect(displayNote({ backend: 'kasmvnc', display: 84 })).toBe('Xvnc (KasmVNC) :84');
});

test("each Xvnc's flags: its socket and no TCP port, no password, shared; KasmVNC told its address so it asks no STUN server", () => {
  const o = { width: 800, height: 600 };
  const tiger = xvncArgs('tigervnc', '/bin/Xvnc', ':81', '/a/vnc.sock', o);
  expect(tiger.slice(0, 4)).toEqual(['/bin/Xvnc', ':81', '-geometry', '800x600']);
  for (const [k, v] of [['-rfbunixpath', '/a/vnc.sock'], ['-rfbport', '-1'], ['-SecurityTypes', 'None'], ['-nolisten', 'tcp']]) expect(tiger[tiger.indexOf(k!) + 1]).toBe(v!);
  expect(tiger).toContain('-AlwaysShared');
  expect(tiger).not.toContain('-publicIP');
  const kasm = xvncArgs('kasmvnc', '/bin/Xkasmvnc', ':81', '/a/vnc.sock', o);
  expect(kasm[kasm.indexOf('-publicIP') + 1]).toBe('127.0.0.1');
  expect(kasm).not.toContain('-websocketPort');
  const turbo = xvncArgs('turbovnc', '/bin/Xvnc', ':81', '/a/vnc.sock', o);
  expect(turbo[turbo.indexOf('-rfbunixpath') + 1]).toBe('/a/vnc.sock');
  expect(turbo).not.toContain('-rfbport');
  expect(turbo[turbo.indexOf('-securitytypes') + 1]).toBe('none');
  expect(xvncArgs('tigervnc', '/bin/Xvnc', ':81', '/a/vnc.sock', { ...o, pathSocketOnly: true }).join(' ')).toContain('-nolisten tcp -nolisten local');
});

// ------------------------------------------------------------------------------------------------ real servers

const XCLIP = { name: 'xclip', env: 'XCLIP_BIN', nix: 'xclip' };
const BACKENDS = (['tigervnc', 'kasmvnc', 'turbovnc'] as const).filter((b) => why(`${b}'s Xvnc`, !!tryBin(DISPLAY_BINS[b], () => {})));
const xtools = why('xdotool, import and xclip', !!(tryBin(DISPLAY_BINS.xdotool, () => {}) && tryBin(DISPLAY_BINS.import, () => {}) && tryBin(XCLIP, () => {})));

/** SysV shared memory segments a process made or last attached (/proc/sysvipc/shm: cpid and lpid). */
function shmOf(pid: number): number {
  const lines = readFileSync('/proc/sysvipc/shm', 'utf8').trim().split('\n');
  const head = lines[0]!.trim().split(/\s+/);
  const [c, l] = [head.indexOf('cpid'), head.indexOf('lpid')];
  return lines.slice(1).filter((x) => {
    const f = x.trim().split(/\s+/);
    return Number(f[c]) === pid || Number(f[l]) === pid;
  }).length;
}

/** A plain RFB 3.8 viewer with no authentication, shared, that can send and receive clipboard text (latin-1). */
async function viewer(path: string) {
  const sock: Socket = connect(path);
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    wake?.();
  });
  sock.on('error', () => {});
  const need = async (n: number) => {
    const end = Date.now() + 10_000;
    while (buf.length < n) {
      if (Date.now() > end) throw new Error('the server sent too little');
      await new Promise<void>((r) => ((wake = r), setTimeout(r, 200)));
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  await need(12);
  sock.write('RFB 003.008\n');
  const types = await need((await need(1))[0]!);
  if (!types.includes(1)) throw new Error(`no None security type: ${[...types]}`);
  sock.write(Buffer.from([1]));
  if ((await need(4)).readUInt32BE(0) !== 0) throw new Error('security failed');
  sock.write(Buffer.from([1])); // shared
  const init = await need(24);
  await need(init.readUInt32BE(20));
  const cut: string[] = [];
  return {
    width: init.readUInt16BE(0),
    height: init.readUInt16BE(2),
    socket: sock,
    /** Read server messages until a ServerCutText holding `text` arrives (updates asked for are skipped, none are). */
    async waitCut(text: string) {
      const end = Date.now() + 10_000;
      while (!cut.includes(text)) {
        if (Date.now() > end) throw new Error(`no ServerCutText "${text}" (got ${JSON.stringify(cut)})`);
        const t = (await need(1))[0];
        if (t === 3) {
          await need(3);
          const len = (await need(4)).readInt32BE(0);
          if (len >= 0) cut.push((await need(len)).toString('latin1'));
          else await need(-len); // extended clipboard: caps or a notify, not text
        } else if (t === 2) continue;
        else throw new Error(`server message ${t}`);
      }
    },
    cutText(text: string) {
      const b = Buffer.alloc(8 + text.length);
      b[0] = 6;
      b.writeUInt32BE(text.length, 4);
      b.write(text, 8, 'latin1');
      sock.write(b);
    },
    close: () => sock.destroy(),
  };
}

const run = async (cmd: string[], env: Record<string, string | undefined>, input?: string) => {
  const p = Bun.spawn(cmd, { env: cleanEnv({ ...process.env, ...env }), stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' });
  if (input !== undefined) {
    (p.stdin as import('bun').FileSink).write(input);
    (p.stdin as import('bun').FileSink).end();
  }
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out;
};

for (const backend of BACKENDS) {
  describe(`a real ${backend} Xvnc`, () => {
    test(
      'one process; RFB on its socket (0600) and no inet socket; no shared memory; viewers share it; import takes the picture',
      async () => {
        const dir = tmp(`${backend}-screen`);
        const start = procs.length;
        const free = await pickFreeDisplay(undefined, [], backend);
        expect(free).toEqual({ backend, display: free.display! });
        const screen = makeScreen({ display: free, dir, width: 1024, height: 700, spawn, log: () => {} });
        try {
          await screen.start();
          const mine = procs.slice(start);
          expect(mine.length).toBe(1);
          expect(screen.procNames).toEqual(['Xvnc']);
          const pid = mine[0]!.pid;
          expect(screen.vncSocket).toBe(join(dir, 'vnc.sock'));
          expect(await rfbBanner(screen.vncSocket)).toMatch(/^RFB 003\.00\d\n/);
          expect(inetSockets(pid)).toEqual([]);
          // Its sockets: the live view's, and X's path socket and abstract one, nothing else.
          expect(unixSockets(pid).sort()).toEqual([screen.vncSocket, `/tmp/.X11-unix/X${free.display}`, `@/tmp/.X11-unix/X${free.display}`].sort());
          expect(shmOf(pid)).toBe(0);
          expect(displayTaken(free.display!)).toBe(true);
          // Two viewers at once (the manager's live view and the page's are both connections): the first stays.
          const a = await viewer(screen.vncSocket);
          const b = await RfbClient.connect(screen.vncSocket, 5000);
          expect([a.width, a.height, b.width, b.height]).toEqual([1024, 700, 1024, 700]);
          b.close();
          await Bun.sleep(200);
          expect(a.socket.destroyed).toBe(false);
          a.close();
          if (xtools) {
            // A black screen comes as a 1-bit PNG, which decodePng does not read: its size from the header.
            const png = await screen.screenshot();
            expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 700]);
          }
        } finally {
          for (const p of procs.slice(start)) p.kill();
          await Promise.all(procs.slice(start).map((p) => p.exited));
          await screen.stop();
        }
        // Stopped, its display is free again for the next sandbox.
        expect(displayTaken(free.display!)).toBe(false);
      },
      30_000,
    );

    // KasmVNC drops both of RFB's clipboard messages (the classic one and the extended one noVNC sends: "Client sent
    // old cuttext msg, ignoring") and takes text only in a message of its own (type 180, its web client's binary
    // clipboard); docs/browser.md "Display backends". So no clipboard through the manager's live view there.
    test.skipIf(!xtools || backend === 'kasmvnc')(
      "the clipboard both ways through the live view: a viewer's text is X's CLIPBOARD, an X client's copy reaches the viewer",
      async () => {
        const dir = tmp(`${backend}-clip`);
        const start = procs.length;
        const screen = makeScreen({ display: await pickFreeDisplay(undefined, [], backend), dir, width: 640, height: 480, spawn, log: () => {} });
        const xclip = resolveBin(XCLIP, () => {});
        try {
          await screen.start();
          const env = screen.clientEnv();
          const v = await viewer(screen.vncSocket);
          v.cutText('from the viewer');
          let got = '';
          for (let end = Date.now() + 10_000; got !== 'from the viewer' && Date.now() < end; await Bun.sleep(100)) got = await run([xclip, '-o', '-selection', 'clipboard'], env);
          expect(got).toBe('from the viewer');
          // xclip keeps the selection until another client takes it; it is ours to stop.
          const owner = Bun.spawn([xclip, '-i', '-selection', 'clipboard', '-loops', '0'], { env: cleanEnv({ ...process.env, ...env }), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
          procs.push(owner);
          owner.stdin.write('from an app');
          owner.stdin.end();
          await v.waitCut('from an app');
          v.close();
        } finally {
          for (const p of procs.slice(start)) p.kill();
          await Promise.all(procs.slice(start).map((p) => p.exited));
          await screen.stop();
        }
      },
      30_000,
    );

    test(
      'a server killed with SIGKILL leaves its lock and socket; the display is free, and the next Xvnc takes it over',
      async () => {
        const dir = tmp(`${backend}-kill`);
        const start = procs.length;
        const free = await pickFreeDisplay(undefined, [], backend);
        const first = makeScreen({ display: free, dir, width: 640, height: 480, spawn, log: () => {} });
        await first.start();
        const killed = procs[start]!;
        killed.kill('SIGKILL');
        await killed.exited;
        // Its lock names a dead process: free (display.ts), though the lock and the socket are still there.
        expect(displayTaken(free.display!)).toBe(false);
        const second: Screen = makeScreen({ display: free, dir, width: 640, height: 480, spawn, log: () => {} });
        try {
          await second.start();
          expect(await rfbBanner(second.vncSocket)).toMatch(/^RFB/);
        } finally {
          for (const p of procs.slice(start)) p.kill();
          await Promise.all(procs.slice(start).map((p) => p.exited));
          await second.stop();
        }
      },
      30_000,
    );
  });
}

// ------------------------------------------------------------------------------------------------ Chromium

let chromium: string | null = null;
if (BACKENDS.length && xtools) {
  try {
    chromium = resolveChromium(() => {});
  } catch (e) {
    console.warn(`xvnc: the Chromium part skipped, ${(e as Error).message}`);
  }
}

for (const backend of chromium ? (['x11', ...BACKENDS] as const) : []) {
  describe(`Chromium on ${backend}`, () => {
    test(
      "xdotool's clicks and text arrive as trusted input; the window fills the screen; the live view and import show the page",
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
              `<html><body style="margin:0;background:#00ff00"><input id="f" style="position:absolute;left:100px;top:100px;width:300px;height:40px"><script>
                const f = document.getElementById('f');
                const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
                f.addEventListener('mousedown', (e) => say({ ev: 'mousedown', trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
                f.addEventListener('keyup', (e) => { if (e.code === 'Enter') say({ ev: 'done', value: f.value }); });
                say({ ev: 'page', w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight, sw: screen.width, sh: screen.height });
              </script></body></html>`,
              { headers: { 'content-type': 'text/html' } },
            );
          },
        });
        const acc = tmp(`${backend}-chromium`);
        const src = join(acc, 'src');
        mkdirSync(src, { recursive: true });
        writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0' }));
        const sb = new Sandbox({ accountDir: acc, display: await pickFreeDisplay(undefined, [], backend), width: 1024, height: 700, extensionSrc: src, config: {}, startUrl: `http://127.0.0.1:${server.port}/`, log: () => {} });
        const until = async (what: string, ok: () => boolean, ms = 30_000) => {
          const end = Date.now() + ms;
          while (!ok()) {
            if (Date.now() > end) throw new Error(`no ${what} (reports: ${JSON.stringify(reports)})`);
            await Bun.sleep(100);
          }
        };
        try {
          await sb.start();
          const screen = sb.screen!;
          expect(screen.backend).toBe(backend);
          await until('page', () => reports.some((r) => r.ev === 'page'));
          const page = reports.find((r) => r.ev === 'page')!;
                    // The screen's size; Chromium's window on X without a window manager is a pixel short of it each way (on
          // every X backend alike, Xvfb's included), at 0,0: the page starts below Chromium's bar at oh - h.
          expect(page).toMatchObject({ sw: 1024, sh: 700, ow: 1023, oh: 699 });
          const top = (page.oh as number) - (page.h as number);
          await screen.click(250, top + 120);
          await until('mousedown', () => reports.some((r) => r.ev === 'mousedown'));
          expect(reports.find((r) => r.ev === 'mousedown')).toMatchObject({ trusted: true, x: 250, y: 120 });
          await screen.type('aB é€ Z');
          await screen.keys(['Return']);
          await until('done', () => reports.some((r) => r.ev === 'done'));
          expect(reports.find((r) => r.ev === 'done')).toMatchObject({ value: 'aB é€ Z' });
          // The page's green, in import's picture and in the live view's (raw, read by the test's own viewer).
          const shot = decodePng(await screen.screenshot());
          const at = (4 * (shot.width * (top + 400) + 600)) as number;
          expect([...shot.data.subarray(at, at + 3)]).toEqual([0, 255, 0]);
          const rfb = await RfbClient.connect(sb.vncSocket, 5000);
          expect([rfb.width, rfb.height]).toEqual([1024, 700]);
          rfb.close();
          expect(await screen.closeWindows('.')).toBe(true);
        } finally {
          await sb.stop();
          server.stop(true);
        }
      },
      90_000,
    );
  });
}
