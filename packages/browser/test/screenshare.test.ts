/**
 * Screen sharing per sandbox (src/screenshare.ts). A page in the sandbox's Chromium shares the screen
 * (getDisplayMedia) and sends it over WebRTC to a second page, which decodes an animated pattern of counters
 * (share-page.ts): every decoded frame must be one the page drew, at the screen's size, above a frame-rate floor and
 * under a latency ceiling; sharing stops and starts again. The same for an Electron stand-in, and on x11.
 *
 * Safety: the test runs with DBUS_SESSION_BUS_ADDRESS pointing at a stand-in for the machine's session bus, with a
 * stand-in portal on it, and a dbus-monitor listening there. No sandbox process may connect to it, and nothing may
 * call a ScreenCast on it. Two wayland sandboxes run at once, and each one's capture shows its own screen only.
 *
 * Skipped without the wayland backend's programs, Chromium, PipeWire, WirePlumber and the portals (and Electron for
 * its part). Chromium's own picker is answered by --use-fake-ui-for-media-stream (wayland, Electron needs none) and
 * --auto-select-desktop-capture-source (x11): the portal's chooser is xdg-desktop-portal-wlr's chooser_type=none.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { cleanEnv, DISPLAY_BINS, resolveBin, tryBin } from '../src/bins.ts';
import { pickFreeDisplay } from '../src/display.ts';
import { makeScreen } from '../src/screen.ts';
import { busConf, ScreenShare, SHARE_BINS, wireplumberConf, wlrConfig } from '../src/screenshare.ts';
import { resolveChromium, Sandbox } from '../src/sandbox.ts';
import { SwayIpc, views } from '../src/swayipc.ts';
import { WaylandScreen } from '../src/wayland.ts';
import { DBusConnection } from '../../sandbox/src/dbus.ts';
import { sandbox as sandboxOk, wayland, why } from '../../../test/needs.ts';
import { type ShareStats, sharePage, decode, encode } from './share-page.ts';

process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-share-'));

test('the pattern: every counter round-trips, a flipped block is caught by its check, and no two counters share one', () => {
  for (const n of [0, 1, 255, 256, 4097, 65535]) expect(decode(encode(n))).toBe(n);
  // One-to-one: a frame torn between two counters, row by row, cannot pass as a third.
  const checks = new Set<string>();
  for (let n = 0; n < 65536; n++) checks.add(encode(n).slice(16).join(''));
  expect(checks.size).toBe(65536);
  for (let bit = 0; bit < 32; bit++) {
    const b = encode(1234);
    b[bit] ^= 1;
    expect(decode(b)).not.toBe(1234);
  }
});

test("the stack's configuration: the one output and no chooser, no device of the machine's, the bus on its path only", () => {
  expect(wlrConfig()).toContain('chooser_type=none');
  expect(wlrConfig()).toContain('output_name=HEADLESS-1');
  for (const m of ['monitor.alsa', 'monitor.bluez', 'monitor.v4l2', 'monitor.libcamera']) expect(wireplumberConf()).toContain(`${m} = disabled`);
  const conf = busConf('/x/share');
  expect(conf.match(/<listen>/g)).toHaveLength(1);
  expect(conf).toContain('<listen>unix:path=/x/share/bus</listen>');
  expect(conf).not.toMatch(/tcp:|abstract=|<standard_session_servicedirs/);
});

const has = (() => {
  if (!wayland || !sandboxOk) return false;
  try {
    for (const b of Object.values(SHARE_BINS)) resolveBin(b, () => {});
    resolveChromium(() => {});
    return true;
  } catch {
    return false;
  }
})();
const ok = why('screen sharing (sway, wayvnc, grim, Chromium, PipeWire, WirePlumber, xdg-desktop-portal, xdg-desktop-portal-wlr)', has);

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-share-${p}-`));
  dirs.push(d);
  return d;
};

// ------------------------------------------------------------- the stand-in for the machine's session bus

let hostBus: Subprocess | null = null;
let monitor: Subprocess | null = null;
let hostPortal: DBusConnection | null = null;
const monitored: string[] = [];
let ownNames = new Set<string>();
let hostAddress = '';

beforeAll(async () => {
  if (!ok) return;
  const d = tmp('hostbus');
  const daemon = resolveBin(SHARE_BINS.dbusDaemon, () => {});
  writeFileSync(join(d, 'bus.conf'), busConf(d));
  mkdirSync(join(d, 'services'));
  hostBus = Bun.spawn([daemon, `--config-file=${join(d, 'bus.conf')}`, '--nofork', '--nopidfile', '--nosyslog'], { stdout: 'ignore', stderr: 'ignore' });
  hostAddress = `unix:path=${join(d, 'bus')}`;
  for (let i = 0; i < 200 && !readdirSync(d).includes('bus'); i++) await Bun.sleep(25);
  // A portal there, as the owner's would be.
  hostPortal = await DBusConnection.connect({ address: join(d, 'bus') });
  await hostPortal.requestName('org.freedesktop.portal.Desktop');
  ownNames.add(hostPortal.uniqueName);
  monitor = Bun.spawn([join(dirname(daemon), 'dbus-monitor'), `--address`, hostAddress], { stdout: 'pipe', stderr: 'ignore' });
  void (async () => {
    const dec = new TextDecoder();
    for await (const c of monitor!.stdout as ReadableStream<Uint8Array>) monitored.push(dec.decode(c));
  })();
  await until('the monitor listening', () => monitored.join('').includes('NameAcquired'), 10_000);
  // Every process started from here on gets this as "the machine's" session bus, and a runtime directory whose bus is
  // it too, so a client that falls back to $XDG_RUNTIME_DIR/bus is caught as well.
  process.env.DBUS_SESSION_BUS_ADDRESS = hostAddress;
  const run = tmp('run');
  symlinkSync(join(d, 'bus'), join(run, 'bus'));
  process.env.XDG_RUNTIME_DIR = run;
}, 60_000);

afterAll(async () => {
  hostPortal?.close();
  for (const p of [monitor, hostBus]) p?.kill('SIGKILL');
  await Promise.all([monitor?.exited, hostBus?.exited]);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Who is on the stand-in bus now: unique name → its process's command line (to say who it was when one is there). */
async function whoIsOnHostBus(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of strangersOnHostBus()) {
    try {
      const [pid] = (await hostPortal!.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', [n], 2000)) as number[];
      out[n] = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').slice(0, 160);
    } catch {
      out[n] = 'gone';
    }
  }
  return out;
}

/** Unique names that connected to the stand-in bus, other than our own portal and the monitor. */
function strangersOnHostBus(): string[] {
  const text = monitored.join('');
  const names = new Set<string>();
  for (const m of text.matchAll(/member=NameOwnerChanged\s+string "(:[0-9.]+)"\s+string ""\s+string "(:[0-9.]+)"/g)) names.add(m[2]!);
  const monitorName = /member=NameAcquired\s+string "(:[0-9.]+)"/.exec(text)?.[1];
  return [...names].filter((n) => !ownNames.has(n) && n !== monitorName);
}

async function until(what: string, ok: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`no ${what} within ${ms} ms`);
    await Bun.sleep(50);
  }
}

/**
 * A connection of our own to the stand-in bus, seen by the monitor: everything that happened there before it has been
 * read by then. Its name counts as ours.
 */
async function flushHostBus() {
  const send = join(dirname(resolveBin(SHARE_BINS.dbusDaemon, () => {})), 'dbus-send');
  const p = Bun.spawn([send, `--bus=${hostAddress}`, '--print-reply=literal', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetId'], { stdout: 'pipe' });
  const id = (await new Response(p.stdout).text()).trim();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  await until('the flush seen', () => (monitored.join('').match(/member=GetId/g)?.length ?? 0) > flushes, 5000);
  flushes++;
  // The flushing connection: the newest stranger.
  const s = strangersOnHostBus();
  ownNames.add(s[s.length - 1]!);
}
let flushes = 0;

test.skipIf(!ok)('the stand-in bus watch works: a client that connects there is seen', async () => {
  const before = strangersOnHostBus().length;
  await flushHostBus();
  expect(strangersOnHostBus().length).toBe(before);
  expect(ownNames.size).toBeGreaterThan(1);
});

// ------------------------------------------------------------- a sandbox with the page on it

interface Probe {
  sb: Sandbox;
  /** What the sandbox's processes said (the portal's, PipeWire's, Chromium's), for a failure's message. */
  logs: string[];
  reports: any[];
  server: ReturnType<typeof Bun.serve>;
  page: () => any;
}

async function probe(name: string, display: Awaited<ReturnType<typeof pickFreeDisplay>>, flags: string[], html = sharePage(), w = 1024, h = 700): Promise<Probe> {
  const reports: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname === '/report') {
        reports.push(await req.json());
        return new Response('ok');
      }
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  const acc = tmp(name);
  const src = join(acc, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0' }));
  const logs: string[] = [];
  // DITHER_SHARE_DEBUG=1: what Chromium's capturer does, in the log a failure prints (the portal's too: screenshare.ts).
  if (process.env.DITHER_SHARE_DEBUG === '1') flags = [...flags, '--enable-logging=stderr', '--vmodule=*pipewire*=4,*screencast*=4,*desktop_capture*=4,*capturer*=4,*egl_dmabuf*=4,*xdg_desktop_portal*=4,*shared_x_display*=4'];
  const sb = new Sandbox({ accountDir: acc, display, width: w, height: h, extensionSrc: src, config: {}, startUrl: `http://127.0.0.1:${server.port}/`, screenShare: true, flags, log: (_l, m) => logs.push(m) });
  await sb.start();
  await until(`${name}'s page`, () => reports.some((r) => r.ev === 'page'));
  return { sb, logs, reports, server, page: () => reports.find((r) => r.ev === 'page') };
}

/**
 * For a click that went nowhere: the screen's windows (on X), and its picture saved under DITHER_TEST_SHOTS when set
 * (the nix job keeps that directory when it fails).
 */
async function whatIsOnScreen(p: Probe): Promise<string> {
  const screen = p.sb.screen!;
  let out = '';
  if (screen.display !== null) {
    const xdotool = resolveBin(DISPLAY_BINS.xdotool, () => {});
    const r = Bun.spawnSync([xdotool, 'search', '--onlyvisible', '--name', '.*', 'getwindowname', '%@', 'getwindowgeometry', '--shell', '%@'], { env: cleanEnv({ ...process.env, DISPLAY: `:${screen.display}` }) });
    out += `\nvisible X windows: ${r.stdout.toString().replace(/\n/g, ' ')}`;
  }
  const dir = process.env.DITHER_TEST_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `share-${screen.backend}-${Date.now()}.png`);
    writeFileSync(file, await screen.screenshot());
    out += `\nthe screen: ${file}`;
  }
  return out;
}

/** Click the page (a user gesture) and wait for that session's numbers. */
async function share(p: Probe, session: number): Promise<ShareStats> {
  const pg = p.page();
  const clicks = p.reports.filter((r) => r.ev === 'click').length;
  // A page can load before its window is on the screen (Electron's does): click once sway shows it, filling the screen.
  const screen = p.sb.screen!;
  if (screen instanceof WaylandScreen) {
    const ipc = await SwayIpc.connect(screen.ipcSocket);
    try {
      const end = Date.now() + 30_000;
      while (!views(await ipc.tree()).some((v) => v.rect.width === pg.sw && v.rect.height === pg.sh && (v as { visible?: boolean }).visible !== false)) {
        if (Date.now() > end) throw new Error('the window never filled the screen');
        await Bun.sleep(50);
      }
    } finally {
      ipc.close();
    }
  } else if (screen.display !== null) {
    // On X the same: a page can load before Chromium's window is mapped. xdotool lists only mapped windows (--onlyvisible).
    const xdotool = resolveBin(DISPLAY_BINS.xdotool, () => {});
    const end = Date.now() + 30_000;
    for (;;) {
      const r = Bun.spawnSync([xdotool, 'search', '--onlyvisible', '--class', 'chromium', 'getwindowgeometry', '--shell', '%@'], { env: cleanEnv({ ...process.env, DISPLAY: `:${screen.display}` }) });
      const out = r.stdout.toString();
      // A pixel short of the screen on X, as in every Chromium window there (docs/browser.md, the fingerprint).
      if (Number(/WIDTH=(\d+)/.exec(out)?.[1]) >= pg.sw - 1 && Number(/HEIGHT=(\d+)/.exec(out)?.[1]) >= pg.sh - 1) break;
      if (Date.now() > end) throw new Error(`Chromium's window never filled the X screen: ${out.replace(/\n/g, ' ').trim() || 'no mapped window'} ${r.stderr.toString().trim()}`);
      await Bun.sleep(50);
    }
  }
  // Low on the screen, left of the receiving frame (bottom right): inside the page whatever its size was when it first
  // reported. That report can come before the window took its final size (on a slow machine, from a smaller or larger
  // first window), so its innerHeight is not where the page ends up.
  await screen.click(200, pg.sh - 200);
  try {
    await until(`the click for session ${session}`, () => p.reports.filter((r) => r.ev === 'click').length > clicks, 10_000);
  } catch (e) {
    throw new Error(`${(e as Error).message} (the page's reports: ${JSON.stringify(p.reports.filter((r) => r.ev === 'page' || r.ev === 'resize'))})${await whatIsOnScreen(p)}`);
  }
  await until(`getDisplayMedia answered for session ${session}`, () => p.reports.some((r) => (r.ev === 'shared' && r.session === session) || r.ev === 'error'), 30_000);
  await until(`session ${session}'s numbers`, () => p.reports.some((r) => (r.ev === 'stats' && r.session === session) || r.ev === 'error'), 60_000);
  const err = p.reports.find((r) => r.ev === 'error');
  if (err) throw new Error(`getDisplayMedia: ${err.name}: ${err.message}\n${p.logs.filter((l) => /portal|pipewire|wireplumber|screencast|capture|pw[._]|xdpw|x_display|dmabuf|egl/i.test(l)).slice(process.env.DITHER_SHARE_DEBUG === '1' ? -200 : -60).join('\n')}`);
  await until(`session ${session} stopped`, () => p.reports.some((r) => r.ev === 'stopped' && r.session === session));
  const s = p.reports.find((r) => r.ev === 'stats' && r.session === session) as ShareStats;
  if (process.env.SHARE_VERBOSE) console.log(`share ${session}: ${s.width}x${s.height} ${s.fps.toFixed(1)} fps, ${s.distinct} frames (${s.bad} unreadable), latency p50 ${s.latency.p50.toFixed(0)} p95 ${s.latency.p95.toFixed(0)} ms, first frame ${s.firstFrameMs} ms`);
  return s;
}

function expectGood(s: ShareStats, w: number, h: number) {
  // Every decoded frame is one the page drew, in order: a picture of anything else fails its check.
  // A frame caught mid-change can blur a block past reading (its check then fails): a few, never many.
  expect(s.bad / s.frames).toBeLessThan(0.05);
  expect(s.unknown).toBe(0);
  expect(s.increasing).toBe(true);
  expect([s.width, s.height]).toEqual([w, h]);
  expect(s.distinct).toBeGreaterThan(20);
  // Floors and ceilings with room for a loaded machine; the benchmark (scripts/bench-display.ts) has the real numbers.
  expect(s.fps).toBeGreaterThan(8);
  expect(s.latency.p50).toBeLessThan(500);
  expect(s.latency.p95).toBeLessThan(1500);
}

/** The processes under this one whose command line has `needle`. */
function procsWith(needle: string): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(needle)) out.push(Number(d));
    } catch {}
  }
  return out;
}
const envOf = (pid: number) => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

/** PipeWire's video sources on a sandbox's own PipeWire (xdg-desktop-portal-wlr makes one per screen cast). */
async function videoSources(shareDir: string): Promise<number> {
  const pwDump = join(dirname(resolveBin(SHARE_BINS.pipewire, () => {})), 'pw-dump');
  const p = Bun.spawn([pwDump], { env: cleanEnv({ PATH: process.env.PATH, XDG_RUNTIME_DIR: shareDir, PIPEWIRE_RUNTIME_DIR: shareDir }), stdout: 'pipe', stderr: 'ignore' });
  const objs = JSON.parse((await new Response(p.stdout).text()) || '[]') as { type: string; info?: { props?: Record<string, unknown> } }[];
  return objs.filter((o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['media.class'] === 'Video/Source').length;
}

describe.skipIf(!ok)('Chromium on wayland', () => {
  let a: Probe;
  let b: Probe;
  beforeAll(async () => {
    if (!ok) return;
    // Two sandboxes at once: b shows a page of plain red, never a frame of a's counters.
    [a, b] = await Promise.all([
      probe('a', { backend: 'wayland', display: null }, ['--use-fake-ui-for-media-stream']),
      probe('b', { backend: 'wayland', display: null }, ['--use-fake-ui-for-media-stream'], '<html><body style="margin:0;background:#f00"><script>fetch("/report",{method:"POST",body:JSON.stringify({ev:"page",w:innerWidth,h:innerHeight,sw:screen.width,sh:screen.height})})</script></body></html>', 800, 600),
    ]);
  }, 120_000);
  afterAll(async () => {
    for (const p of [a, b]) {
      await p?.sb.stop();
      p?.server.stop(true);
    }
  }, 30_000);

  test(
    "shares its own screen: every frame one the page drew, at the screen's size; stops, and shares again",
    async () => {
      const shareDir = join((a.sb.screen as WaylandScreen).dir, 'share');
      const s1 = await share(a, 1);
      expectGood(s1, 1024, 700);
      expect(s1.settings).toMatchObject({ displaySurface: 'monitor', width: 1024, height: 700 });
      expect(a.reports.find((r) => r.ev === 'stopped' && r.session === 1)?.ended).toBe('ended');
      // Stopped for real: the portal's screen cast is gone from the sandbox's PipeWire.
      for (let i = 0; i < 200 && (await videoSources(shareDir)) > 0; i++) await Bun.sleep(50);
      expect(await videoSources(shareDir)).toBe(0);
      const s2 = await share(a, 2);
      expectGood(s2, 1024, 700);
    },
    180_000,
  );

  test("nothing in either sandbox reached the machine's session bus (nor its runtime directory's); each portal is on its sandbox's bus and sway", async () => {
    // Chromium writes over its own environ (its process titles), so what it was given is proved by where it went:
    // it looks up the portal's settings at start, and on a bus the monitor watches nothing came.
    for (const p of [a, b]) {
      const share = join((p.sb.screen as WaylandScreen).dir, 'share');
      const own = `unix:path=${join(share, 'bus')}`;
      const portals = procsWith('xdg-desktop-portal').filter((pid) => envOf(pid).XDG_RUNTIME_DIR === share);
      // xdg-desktop-portal, its wlr backend, and the permission store the bus started for it.
      expect(portals.length).toBeGreaterThanOrEqual(2);
      for (const pid of portals) {
        const e = envOf(pid);
        expect(e.DBUS_SESSION_BUS_ADDRESS?.split(',')[0]).toBe(own);
        expect(e.XDG_RUNTIME_DIR).toBe(share);
        if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('permission-store')) expect(e.WAYLAND_DISPLAY).toBe(p.sb.screen!.socket);
      }
    }
    expect(await whoIsOnHostBus()).toEqual({});
    expect(monitored.join('')).not.toContain('org.freedesktop.portal.ScreenCast');
  });

  test("the watch would have seen it: a Chromium given the machine's bus, as before, goes there at start", async () => {
    const before = strangersOnHostBus().length;
    const prof = tmp('control');
    const screen = a.sb.screen!;
    const c = Bun.spawn([resolveChromium(() => {}), `--user-data-dir=${prof}`, '--no-first-run', '--ozone-platform=wayland', '--password-store=basic', 'about:blank'], { env: cleanEnv({ ...process.env, ...screen.clientEnv() }), stdout: 'ignore', stderr: 'ignore' });
    try {
      await until('the control Chromium on the stand-in bus', () => strangersOnHostBus().length > before, 30_000);
    } finally {
      c.kill('SIGKILL');
      await c.exited;
    }
    // Every connection it made is seen by now; they were the control's.
    await flushHostBus();
    ownNames = new Set([...ownNames, ...strangersOnHostBus()]);
  }, 60_000);
});

// Every X backend shares the same way: Chromium's X capturer reads the X server's screen, whichever server it is
// (Xvfb, or an Xvnc that is the live view too).
const X_SHARE = (['x11', 'tigervnc', 'kasmvnc', 'turbovnc'] as const).filter((b) => b === 'x11' || (ok && why(`${b}'s Xvnc`, !!tryBin(DISPLAY_BINS[b], () => {}))));

describe.skipIf(!ok)('x11 parity', () => {
  for (const backend of X_SHARE)
    test(
      `Chromium on ${backend} shares its X server's screen (Chromium's picker answered by its Entire screen), and calls no portal`,
      async () => {
        const p = await probe(backend, await pickFreeDisplay(undefined, [], backend), ['--auto-select-desktop-capture-source=Entire screen']);
        try {
          expectGood(await share(p, 1), 1024, 700);
          expect(monitored.join('')).not.toContain('org.freedesktop.portal.ScreenCast');
        } finally {
          await p.sb.stop();
          p.server.stop(true);
          // An X sandbox's Chromium still has the machine's session bus (unchanged here: docs/browser.md), so it was
          // there; its capture is X's own and asked no portal. Its connections are counted as known from here on, pass
          // or fail, so the Electron test below sees only its own.
          await flushHostBus();
          ownNames = new Set([...ownNames, ...strangersOnHostBus()]);
        }
      },
      180_000,
    );
});

// ------------------------------------------------------------- Electron

const ELECTRON = { name: 'electron', env: 'ELECTRON_BIN', nix: 'electron' };
const electron = ok && why('Electron', !!tryBin(ELECTRON, () => {})) ? resolveBin(ELECTRON, () => {}) : null;

/** An Electron app as Signal Desktop or Discord's would be: getDisplayMedia answered by desktopCapturer's first screen. */
const ELECTRON_MAIN = `
const { app, BrowserWindow, desktopCapturer, session } = require('electron');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const screens = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: screens[0] });
  });
  const w = new BrowserWindow({ width: 1024, height: 700, frame: false });
  w.loadURL(process.env.PROBE_URL);
});
`;

describe.skipIf(!electron)('an Electron app on wayland', () => {
  test(
    'shares its own screen through the same portal, stops, and shares again; nothing reached the machine’s bus',
    async () => {
      const d = tmp('electron');
      const procs: Subprocess[] = [];
      const logs: string[] = [];
      const spawn = (name: string, cmd: string[], o: { env?: Record<string, string | undefined> }) => {
        const p = Bun.spawn(cmd, { env: cleanEnv({ ...process.env, ...o.env }), stdout: 'ignore', stderr: 'pipe' });
        void (async () => {
          for await (const c of p.stderr as ReadableStream<Uint8Array>) logs.push(`[${name}] ${new TextDecoder().decode(c).trim().slice(0, 400)}`);
        })();
        procs.push(p);
        return p;
      };
      const screen = makeScreen({ display: { backend: 'wayland', display: null }, dir: d, width: 1024, height: 700, spawn, log: () => {} }) as WaylandScreen;
      const reports: any[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          if (new URL(req.url).pathname === '/report') {
            reports.push(await req.json());
            return new Response('ok');
          }
          return new Response(sharePage(), { headers: { 'content-type': 'text/html' } });
        },
      });
      try {
        await screen.start();
        const sh = new ScreenShare({ dir: screen.dir, waylandSocket: screen.socket, spawn, log: () => {} });
        await sh.start();
        mkdirSync(join(d, 'app'));
        writeFileSync(join(d, 'app', 'main.js'), ELECTRON_MAIN);
        writeFileSync(join(d, 'app', 'package.json'), JSON.stringify({ name: 'share-probe', main: 'main.js' }));
        spawn('electron', [electron!, '--no-sandbox', '--ozone-platform=wayland', join(d, 'app')], {
          env: { ...screen.clientEnv(), ...sh.clientEnv(), PROBE_URL: `http://127.0.0.1:${server.port}/`, HOME: join(d, 'home'), XDG_CONFIG_HOME: join(d, 'config'), ELECTRON_ENABLE_LOGGING: undefined },
        });
        await until('the page', () => reports.some((r) => r.ev === 'page'));
        const p: Probe = { sb: { screen } as unknown as Sandbox, logs, reports, server, page: () => reports.find((r) => r.ev === 'page') };
        expectGood(await share(p, 1), 1024, 700);
        for (let i = 0; i < 200 && (await videoSources(join(screen.dir, 'share'))) > 0; i++) await Bun.sleep(50);
        expect(await videoSources(join(screen.dir, 'share'))).toBe(0);
        expectGood(await share(p, 2), 1024, 700);
        expect(await whoIsOnHostBus()).toEqual({});
      } finally {
        for (const p of procs.reverse()) p.kill('SIGTERM');
        const t = setTimeout(() => procs.forEach((p) => p.kill('SIGKILL')), 4000);
        await Promise.all(procs.map((p) => p.exited));
        clearTimeout(t);
        await screen.stop();
        server.stop(true);
      }
    },
    180_000,
  );
});

