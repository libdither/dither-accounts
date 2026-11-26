/**
 * The Xvnc display backends (tigervnc, kasmvnc: src/screen.ts, src/vnc.ts xvncArgs), each beside x11 where they must
 * behave alike: one process that is both X server and live view, on the account's Unix socket (0600) and no inet socket
 * at all (nor, for KasmVNC, any query to the internet), no SysV shared memory, many viewers at once speaking standard
 * RFB as the manager's live view (noVNC) does, the clipboard both ways through the live view, pictures by import, a
 * display left by a killed server taken over, and Chromium on it driven by xdotool as the `browser` interface drives it
 * and through the live view. Each backend skips when its Xvnc cannot be had (DITHER_TESTS_NEED_ALL=1 fails instead).
 * Every process it starts is gone at the end.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { hasBackend, TEST_BINS, why } from '../../../test/needs.ts';
import { cleanEnv, DISPLAY_BINS, resolveBin, tryBin } from '../src/bins.ts';
import { displayTaken, parseBackend, pickFreeDisplay, type XBackend } from '../src/display.ts';
import { RfbClient } from '../src/rfb.ts';
import { resolveChromium, Sandbox } from '../src/sandbox.ts';
import { displayName, displayNote, makeScreen, type Screen } from '../src/screen.ts';
import { xvncArgs } from '../src/vnc.ts';
import { inetSockets, rfbBanner, unixSockets } from './inet.ts';
import { decodePng } from './png.ts';
import { ENC, Viewer } from './rfb-viewer.ts';

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

/** A screen's spawn as the sandboxes do it, every process kept for the end, and what each said (for a failure's message). */
const said = new Map<Subprocess, string[]>();
const spawn = (_name: string, cmd: string[], o: { env?: Record<string, string | undefined> }) => {
  // KasmVNC's own log, every line (it keeps it in a buffer: it reaches stderr at the latest when the server exits).
  if (cmd[0]?.endsWith('Xkasmvnc')) cmd = [...cmd, '-Log', '*:stderr:100'];
  const p = Bun.spawn(cmd, { env: cleanEnv({ ...process.env, ...o.env }), stdout: 'ignore', stderr: 'pipe' });
  procs.push(p);
  const lines: string[] = [];
  said.set(p, lines);
  void (async () => {
    for await (const c of p.stderr as ReadableStream<Uint8Array>) lines.push(new TextDecoder().decode(c));
  })();
  return p;
};
/** What the processes started since `start` said, the end of it, once they have been stopped (so it is all out). */
const saidSince = async (start: number) => {
  const mine = procs.slice(start);
  for (const p of mine) p.kill('SIGTERM');
  await Promise.race([Promise.all(mine.map((p) => p.exited)), Bun.sleep(3000)]);
  await Bun.sleep(100);
  return mine.map((p) => (said.get(p) ?? []).join('').slice(-6000)).join('\n---\n');
};

test('the backends by name, and how a status shows their displays', () => {
  for (const b of ['tigervnc', ' KasmVNC ']) expect(parseBackend(b)).toBe(b.trim().toLowerCase() as XBackend);
  expect(parseBackend('turbovnc')).toBeNull();
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
  // Else a connection with no user in ~/.kasmpasswd (any on the socket) gets no picture and no input.
  expect(kasm).toContain('-DisableBasicAuth');
  expect(kasm).not.toContain('-websocketPort');
  expect(xvncArgs('tigervnc', '/bin/Xvnc', ':81', '/a/vnc.sock', { ...o, pathSocketOnly: true }).join(' ')).toContain('-nolisten tcp -nolisten local');
});

// ------------------------------------------------------------------------------------------------ real servers

const BACKENDS = (['tigervnc', 'kasmvnc'] as const).filter((b) => why(`${b}'s Xvnc`, hasBackend(b)));
const importer = why('ImageMagick\'s import', !!tryBin(DISPLAY_BINS.import, () => {}));
const xtools = why('xdotool, import and xclip', !!(tryBin(DISPLAY_BINS.xdotool, () => {}) && tryBin(DISPLAY_BINS.import, () => {}) && tryBin(TEST_BINS.xclip, () => {})));
/** A viewer as the manager's live view is one: standard RFB, asking for every frame, raw only, its picture kept. */
const viewer = (socket: string) => Viewer.open(socket, { encodings: [ENC.raw, ENC.desktopSize], keepPicture: true });

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
      'one process; RFB on its socket (0600) and no inet socket; no shared memory; viewers share it',
      async () => {
        const dir = tmp(`${backend}-screen`);
        const start = procs.length;
        const free = await pickFreeDisplay(undefined, [], backend);
        expect(free).toEqual({ backend, display: free.display! });
        const screen = makeScreen({ display: free, dir, width: 1024, height: 700, spawn, log: () => {} });
        try {
          const t0 = performance.now();
          await screen.start().catch(async (e) => {
            throw new Error(`${(e as Error).message} (${((performance.now() - t0) / 1000).toFixed(1)} s after the start)\nit said:\n${await saidSince(start)}`);
          });
          const mine = procs.slice(start);
          expect(mine.length).toBe(1);
          expect(screen.procNames).toEqual(['Xvnc']);
          const pid = mine[0]!.pid;
          expect(screen.vncSocket).toBe(join(dir, 'vnc.sock'));
          // Only this user reaches it (vnc.ts): the socket 0600, its directory 0700.
          expect(lstatSync(screen.vncSocket).mode & 0o777).toBe(0o600);
          expect(lstatSync(dir).mode & 0o077).toBe(0);
          expect(await rfbBanner(screen.vncSocket)).toMatch(/^RFB 003\.00\d\n/);
          expect(inetSockets(pid)).toEqual([]);
          // Its sockets: the live view's, and X's path socket and abstract one, nothing else.
          expect(unixSockets(pid).sort()).toEqual([screen.vncSocket, `/tmp/.X11-unix/X${free.display}`, `@/tmp/.X11-unix/X${free.display}`].sort());
          expect(shmOf(pid)).toBe(0);
          expect(displayTaken(free.display!)).toBe(true);
          // Two viewers at once (the manager's live view and the page's are both connections): the first stays, and
          // after the second has come and gone it still asks for the screen and gets it.
          const a = await viewer(screen.vncSocket);
          const b = await RfbClient.connect(screen.vncSocket, 5000);
          expect([a.width, a.height, b.width, b.height]).toEqual([1024, 700, 1024, 700]);
          b.close();
          await a.refresh();
          expect(a.open).toBe(true);
          a.close();
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

    test.skipIf(!importer)(
      'import takes the picture',
      async () => {
        const dir = tmp(`${backend}-shot`);
        const start = procs.length;
        const screen = makeScreen({ display: await pickFreeDisplay(undefined, [], backend), dir, width: 1024, height: 700, spawn, log: () => {} });
        try {
          await screen.start();
          // A black screen comes as a 1-bit PNG, which decodePng does not read: its size from the header.
          const png = await screen.screenshot();
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 700]);
        } finally {
          for (const p of procs.slice(start)) p.kill();
          await Promise.all(procs.slice(start).map((p) => p.exited));
          await screen.stop();
        }
      },
      30_000,
    );

    // KasmVNC's own RFB has a clipboard only in its message 180; our fork speaks RFB's to a standard client
    // (nix/kasmvnc.nix), so the live view has it on both.
    test.skipIf(!xtools)(
      "the clipboard both ways through the live view: a viewer's text is X's CLIPBOARD, an X client's copy reaches the viewer",
      async () => {
        const dir = tmp(`${backend}-clip`);
        const start = procs.length;
        const screen = makeScreen({ display: await pickFreeDisplay(undefined, [], backend), dir, width: 640, height: 480, spawn, log: () => {} });
        const xclip = resolveBin(TEST_BINS.xclip, () => {});
        try {
          await screen.start();
          const env = screen.clientEnv();
          const v = await viewer(screen.vncSocket);
          v.cutText('from the viewer');
          // The server has read the text once it has answered what was sent after it.
          await v.refresh();
          let got = '';
          // Taking X's selection is X's own round trip, so it is read until it has it.
          for (let end = Date.now() + 10_000; got !== 'from the viewer' && Date.now() < end; await Bun.sleep(100)) got = await run([xclip, '-o', '-selection', 'clipboard'], env);
          expect(got).toBe('from the viewer');
          // xclip keeps the selection until another client takes it; it is ours to stop.
          const owner = Bun.spawn([xclip, '-i', '-selection', 'clipboard', '-loops', '0'], { env: cleanEnv({ ...process.env, ...env }), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
          procs.push(owner);
          owner.stdin.write('from an app');
          owner.stdin.end();
          await v.until("the app's copy as ServerCutText", () => v.cut.includes('from an app'));
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
      'standard RFB, as noVNC speaks it: a second viewer brings the first no message it does not know, and a 6-byte pointer event is read as one',
      async () => {
        // KasmVNC's own RFB has an 11-byte pointer event and messages 253 and 254; our fork speaks standard RFB to a
        // client that does not announce KasmVNC's own extensions (nix/kasmvnc.nix), which the live view needs.
        const dir = tmp(`${backend}-rfb`);
        const start = procs.length;
        const screen = makeScreen({ display: await pickFreeDisplay(undefined, [], backend), dir, width: 640, height: 480, spawn, log: () => {} });
        try {
          await screen.start();
          const a = await viewer(screen.vncSocket);
          const b = await viewer(screen.vncSocket);
          // Each server message is read in order; one the viewer does not know fails it (a.error).
          await a.refresh();
          b.close();
          await a.refresh();
          // RFB's 6 bytes, then an update request: read as 11, the request would be swallowed and no update would come.
          a.pointer(10, 10, 0);
          await a.refresh();
          expect(a.error).toBeNull();
          a.close();
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
      "xdotool's and the live view's clicks and keys arrive as trusted input; the live view and import both show the page",
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
              `<html><body style="margin:0;background:#00ff00"><p style="position:absolute;left:10px;top:0;margin:0">probe</p><input id="f" style="position:absolute;left:100px;top:100px;width:300px;height:40px"><script>
                const f = document.getElementById('f');
                const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
                f.addEventListener('mousedown', (e) => say({ ev: 'mousedown', trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
                addEventListener('mousedown', (e) => e.target === document.body && say({ ev: 'bodydown', trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
                f.addEventListener('keydown', (e) => e.key === 'q' && say({ ev: 'q', trusted: e.isTrusted }));
                f.addEventListener('keyup', (e) => { if (e.code === 'Enter') say({ ev: 'done', value: f.value }); });
                // Ready once the page has been painted and two frames have passed (as share-page.ts): this script runs
                // before Chromium has shown its window (outerWidth 0 then) and a click that comes before the first frame
                // can be lost.
                new PerformanceObserver((list, obs) => {
                  if (!list.getEntries().some((e) => e.name === 'first-contentful-paint')) return;
                  obs.disconnect();
                  requestAnimationFrame(() => requestAnimationFrame(() => say({ ev: 'page', w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight, sw: screen.width, sh: screen.height })));
                }).observe({ type: 'paint', buffered: true });
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
          // é and € were put on keys of their own and stay there (screen.ts bindCharacters), so xdotool did not bind
          // and unbind them around each press, which Chromium can miss.
          const keymap = await run([resolveBin(DISPLAY_BINS.xmodmap, () => {}), '-pke'], screen.clientEnv());
          expect(keymap).toMatch(/= (eacute|U00E9) /);
          expect(keymap).toMatch(/= (EuroSign|U20AC) /);
          // The page's green, in import's picture and in the live view's (raw, read by the test's own viewer).
          const shot = decodePng(await screen.screenshot());
          const at = (4 * (shot.width * (top + 400) + 600)) as number;
          expect([...shot.data.subarray(at, at + 3)]).toEqual([0, 255, 0]);
          // The live view (what the manager's page shows and sends): its own picture of the page, and a click and a key
          // through it. A server that answers RFB but grants the connection nothing sends neither (KasmVNC without
          // -DisableBasicAuth).
          const live = await viewer(sb.vncSocket);
          try {
            await live.refresh();
            expect(live.pixel(600, top + 400)).toEqual([0, 255, 0]);
            // The pointer there first, read before the press (the server has answered the request sent after it), as
            // a hand moves before it clicks.
            live.pointer(700, top + 500, 0);
            await live.refresh();
            live.pointer(700, top + 500, 1);
            live.pointer(700, top + 500, 0);
            await until('the live view\'s click', () => reports.some((r) => r.ev === 'bodydown'));
            expect(reports.find((r) => r.ev === 'bodydown')).toMatchObject({ trusted: true, x: 700, y: 500 });
            await screen.click(250, top + 120);
            live.key(0x71, true);
            live.key(0x71, false);
            await until('the live view\'s key', () => reports.some((r) => r.ev === 'q'));
            expect(reports.find((r) => r.ev === 'q')).toMatchObject({ trusted: true });
          } finally {
            live.close();
          }
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
