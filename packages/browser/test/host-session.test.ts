/**
 * A browser sandbox's own session (src/screenshare.ts), on every backend: its Chromium never reaches the machine's
 * session bus, system bus or audio server, and has its own instead. Without them, a page in an X sandbox played into
 * the owner's speakers, could open the owner's microphone, and showed notifications on the owner's desktop.
 *
 * The test runs with a stand-in for the machine's session: a runtime directory with a session bus (`bus`), an audio
 * server (`pulse/native`) and PipeWire (`pipewire-0`) in it, and addresses for the system bus and the audio servers
 * (DBUS_SYSTEM_BUS_ADDRESS, PULSE_SERVER, PIPEWIRE_REMOTE), each a socket that notes who connects and hangs up. A
 * sandbox's page plays a tone and opens the microphone: the tone plays on the sandbox's own audio server, the
 * microphone is its silent one, and nothing connects to any stand-in. A Chromium given the stand-in's environment, as
 * an X sandbox's was, is seen there: the watch works.
 *
 * Skipped without Chromium, dbus-daemon, PulseAudio and a display backend's programs (test/needs.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import type { DisplayBackend } from '@dither-accounts/spec/display';
import { cleanEnv, tryBin } from '../src/bins.ts';
import { pickFreeDisplay } from '../src/display.ts';
import { SHARE_BINS } from '../src/screenshare.ts';
import { CHROMIUM, Sandbox } from '../src/sandbox.ts';
import { hasBackend, why } from '../../../test/needs.ts';

process.env.DITHER_DISPLAY_CLAIMS ??= mkdtempSync(join(tmpdir(), 'display-claims-session-'));

const chromium = tryBin(CHROMIUM, () => {});
const pulseaudio = tryBin(SHARE_BINS.pulseaudio, () => {});
const base = why('a browser sandbox (Xvfb, x11vnc, Chromium, dbus-daemon, PulseAudio)', hasBackend('x11') && !!chromium && !!pulseaudio && !!tryBin(SHARE_BINS.dbusDaemon, () => {}));
/** Every X backend is the same screen class; each is run where its server is there. Wayland too, where sway is. */
const BACKENDS = (['x11', 'tigervnc', 'kasmvnc', 'wayland'] as const satisfies readonly DisplayBackend[]).filter((b) => base && (b === 'x11' || why(`${b}'s server`, hasBackend(b))));

const root = mkdtempSync(join(tmpdir(), 'dacc-session-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ------------------------------------------------------------- the stand-in for the machine's session

/** Each connection to a stand-in, by its name, in the order they came. */
const hits: string[] = [];
const traps: { stop(): void }[] = [];
const host = join(root, 'host');

function trap(name: string, path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  traps.push(
    Bun.listen({
      unix: path,
      socket: {
        open(s) {
          hits.push(name);
          s.end();
        },
        data() {},
      },
    }),
  );
}

beforeAll(() => {
  if (!base) return;
  mkdirSync(host, { mode: 0o700 });
  // Where a client looks by itself, in the runtime directory: the session bus, PulseAudio, PipeWire.
  trap('session bus', join(host, 'bus'));
  trap('pulse in the runtime directory', join(host, 'pulse', 'native'));
  trap('pipewire in the runtime directory', join(host, 'pipewire-0'));
  // And where the environment says they are.
  trap('system bus', join(host, 'system_bus_socket'));
  trap('PULSE_SERVER', join(host, 'pulse-server'));
  trap('PIPEWIRE_REMOTE', join(host, 'pipewire-remote'));
  // Every process started from here on gets these as the machine's session.
  Object.assign(process.env, {
    XDG_RUNTIME_DIR: host,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(host, 'bus')}`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(host, 'system_bus_socket')}`,
    PULSE_SERVER: `unix:${join(host, 'pulse-server')}`,
    PIPEWIRE_REMOTE: join(host, 'pipewire-remote'),
  });
});

afterAll(() => {
  for (const t of traps) t.stop();
});

// ------------------------------------------------------------- a page that plays a tone and opens the microphone

const PAGE = `<!doctype html><title>session</title><script>
(async () => {
  const out = { ev: 'page' };
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
    await ctx.resume();
    // Its clock runs: half a second of it played, within ten of the page's.
    const t0 = ctx.currentTime;
    const end = Date.now() + 10000;
    while (ctx.currentTime - t0 < 0.5 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    out.state = ctx.state;
    out.advanced = ctx.currentTime - t0;
  } catch (e) {
    out.audioError = String(e);
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    out.mic = s.getAudioTracks().length;
    out.devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind + ':' + d.label);
  } catch (e) {
    out.micError = e.name + ': ' + e.message;
  }
  await fetch('/report', { method: 'POST', body: JSON.stringify(out) });
})();
</script>`;

function pageServer() {
  const reports: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname === '/report') {
        reports.push(await req.json());
        return new Response('ok');
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    },
  });
  return { server, reports, url: `http://127.0.0.1:${server.port}/` };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`no ${what} within ${ms} ms`);
    await Bun.sleep(50);
  }
}

/** The streams playing on an audio server (pactl, beside pulseaudio), each line naming its client's application. */
async function playing(socket: string): Promise<string> {
  const pactl = join(dirname(pulseaudio!), 'pactl');
  const home = join(root, 'pactl-home');
  mkdirSync(home, { recursive: true });
  const p = Bun.spawn([pactl, '-s', `unix:${socket}`, 'list', 'sink-inputs'], { env: cleanEnv({ PATH: process.env.PATH, HOME: home, PULSE_COOKIE: join(home, 'cookie') }), stdout: 'pipe', stderr: 'pipe' });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out;
}

/** A process's environment, as it was given (Chromium writes over its own; the screen's servers do not). */
function envOf(pid: number): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } catch {
    return {};
  }
}

function newExtension(name: string) {
  const src = join(root, `${name}-ext`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0' }));
  return src;
}

/** The X display of the last X sandbox, still running, for the control below. */
let controlDisplay: number | null = null;
let controlStop: (() => Promise<void>) | null = null;

describe.skipIf(!base)("a sandbox's Chromium and the machine's session", () => {
  for (const backend of BACKENDS)
    test(
      `on ${backend}: a tone plays on the sandbox's own audio server and its microphone is the sandbox's; nothing reaches the machine's buses or audio`,
      async () => {
        const before = hits.length;
        const page = pageServer();
        const logs: string[] = [];
        const sb = new Sandbox({
          accountDir: join(root, backend),
          display: await pickFreeDisplay(undefined, [], backend),
          width: 800,
          height: 600,
          extensionSrc: newExtension(backend),
          config: {},
          startUrl: page.url,
          // The microphone's permission asked for by the page is answered yes; its devices are what the browser has.
          flags: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
          chromium: chromium!,
          log: (l, m) => logs.push(`${l} ${m}`),
        });
        let kept = false;
        try {
          await sb.start();
          const rt = sb.screen!.runtimeDir!;
          const st = lstatSync(rt);
          expect([st.isDirectory(), st.mode & 0o777]).toEqual([true, 0o700]);
          await until(`${backend}'s page report`, () => page.reports.length > 0, 60_000);
          const r = page.reports[0];
          // Web Audio runs on a clock (a call's graph needs it to), and the microphone opens: the sandbox's own.
          expect(r.audioError).toBeUndefined();
          expect(r.state).toBe('running');
          expect(r.advanced).toBeGreaterThan(0.5);
          expect(r.micError).toBeUndefined();
          expect(r.mic).toBe(1);
          expect(r.devices).toEqual(expect.arrayContaining(['audioinput:Microphone', 'audiooutput:Speakers']));
          // The tone is a stream on the sandbox's audio server.
          const socket = join(rt, 'share', 'pulse', 'native');
          await until("the tone on the sandbox's audio server", async () => /Chrom/i.test(await playing(socket)));
          // The screen's own servers and the session's were given none of the machine's session either.
          const procs = (sb as unknown as { procs: { name: string; proc: Subprocess }[] }).procs.filter((p) => p.name !== 'chromium' && p.proc.exitCode === null);
          expect(procs.length).toBeGreaterThan(0);
          for (const p of procs) {
            const e = envOf(p.proc.pid);
            if (!Object.keys(e).length) continue;
            expect([p.name, e.XDG_RUNTIME_DIR?.startsWith(rt)]).toEqual([p.name, true]);
            for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'PULSE_SERVER', 'PIPEWIRE_REMOTE']) expect([p.name, k, e[k]?.includes(host) ?? false]).toEqual([p.name, k, false]);
          }
          expect(hits.slice(before)).toEqual([]);
          if (backend === 'x11') {
            // Left running for the control below, on its display.
            controlDisplay = sb.screen!.display;
            controlStop = async () => {
              await sb.stop();
              page.server.stop(true);
            };
            kept = true;
          }
        } catch (e) {
          throw new Error(`${(e as Error).message}\n${logs.slice(-30).join('\n')}`);
        } finally {
          if (!kept) {
            await sb.stop();
            page.server.stop(true);
            expect(existsSync(sb.screen!.runtimeDir!)).toBe(false);
          }
        }
        // Nothing came while it stopped either.
        expect(hits.slice(before)).toEqual([]);
      },
      120_000,
    );

  test('the watch would have seen it: a Chromium given the machine\'s session, as an X sandbox\'s was, goes to its bus and its audio server', async () => {
    expect(controlDisplay).not.toBeNull();
    const before = hits.length;
    const page = pageServer();
    const c = Bun.spawn([chromium!, `--user-data-dir=${join(root, 'control-profile')}`, '--no-first-run', '--password-store=basic', '--use-mock-keychain', '--autoplay-policy=no-user-gesture-required', page.url], {
      env: cleanEnv({ ...process.env, DISPLAY: `:${controlDisplay}`, WAYLAND_DISPLAY: undefined }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      await until('the control on the stand-in session bus and audio server', () => {
        const seen = hits.slice(before);
        return seen.includes('session bus') && seen.includes('PULSE_SERVER');
      }, 60_000);
    } finally {
      c.kill('SIGKILL');
      await c.exited;
      page.server.stop(true);
      await controlStop?.();
    }
  }, 120_000);
});
