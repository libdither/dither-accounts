/**
 * A native-app sandbox and the machine's session, on every display backend: nothing it starts, inside bubblewrap or
 * outside it, is given the machine's runtime directory, session bus, system bus or audio server. The app inside never
 * was (bubblewrap clears its environment); the processes outside it (the screen's servers, the sandbox's bus and
 * audio server, pasta and bubblewrap themselves, and the screen's tools: xdotool, import, grim) used to keep the
 * manager's XDG_RUNTIME_DIR, where libdbus and libpulse look for the owner's bus and sound by themselves.
 *
 * The test runs with a stand-in for the machine's session, as packages/browser/test/host-session.test.ts does: a
 * runtime directory with a session bus (`bus`), an audio server (`pulse/native`) and PipeWire (`pipewire-0`) in it,
 * and addresses for the system bus and the audio servers, each a socket that notes who connects and hangs up. Each
 * sandbox's processes are read in /proc/<pid>/environ for any of those, nothing connects to a stand-in, and nothing
 * new is made in the stand-in runtime directory but the sandbox's own run directory. A client given the environment
 * the sandbox's servers had is seen there: the watch works.
 *
 * Skipped without the native-app sandbox's programs and PulseAudio (test/needs.ts); each backend where its programs are.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { cleanEnv, noHostSession, pickFreeDisplay } from '@dither-accounts/browser';
import type { DisplayBackend } from '@dither-accounts/spec/display';
import { hasBackend, sandbox, why } from '../../../test/needs.ts';
import { BINS, resolveBin, tryBin } from '../src/bins.ts';
import { AppSandbox, type AudioDevices } from '../src/sandbox.ts';

process.env.DITHER_DISPLAY_CLAIMS ??= mkdtempSync(join(tmpdir(), 'display-claims-sbx-session-'));

const base = why('the native-app sandbox with PulseAudio', sandbox && !!tryBin(BINS.pulseaudio, () => {}));
const BACKENDS = (['x11', 'tigervnc', 'kasmvnc', 'wayland', 'wayland-tigervnc'] as const satisfies readonly DisplayBackend[]).filter((b) => base && (b === 'x11' || why(`${b}'s server`, hasBackend(b))));

const AUDIO: AudioDevices = { sinks: [{ name: 'speakers', description: 'Speakers' }], sources: [{ name: 'mic', from: 'speakers', description: 'Microphone' }], defaultSink: 'speakers', defaultSource: 'mic' };

const root = mkdtempSync(join(tmpdir(), 'dacc-sbx-session-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ------------------------------------------------------------- the stand-in for the machine's session

/** Each connection to a stand-in, by its name, in the order they came. */
const hits: string[] = [];
const traps: { stop(): void }[] = [];
const host = join(root, 'host');
/** What the stand-in runtime directory holds before any sandbox: the stand-ins' own files. */
let hostEntries: string[] = [];
/** The stand-in addresses, as the environment gives them. */
const HOST_ENV = {
  XDG_RUNTIME_DIR: host,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(host, 'bus')}`,
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(host, 'system_bus_socket')}`,
  PULSE_SERVER: `unix:${join(host, 'pulse-server')}`,
  PIPEWIRE_REMOTE: join(host, 'pipewire-remote'),
};

const trapPaths: Record<string, string> = {};

function trap(name: string, path: string) {
  trapPaths[name] = path;
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
  hostEntries = readdirSync(host).sort();
  // Every process started from here on gets these as the machine's session (the manager's own environment).
  Object.assign(process.env, HOST_ENV);
});

afterAll(() => {
  for (const t of traps) t.stop();
});

/**
 * The stand-ins' connections since `from`, once every one already made has been heard: a connection of our own to
 * each stand-in, after them in its queue, is heard after them, so once all of ours are, so is any earlier one. Ours
 * are left out of what it returns.
 */
async function heardSince(from: number): Promise<string[]> {
  const mark = hits.length;
  marks.push(mark);
  for (const path of Object.values(trapPaths)) await Bun.connect({ unix: path, socket: { data() {} } });
  const ours = Object.keys(trapPaths);
  await until("our own connections to the stand-ins", () => ours.every((n) => hits.slice(mark).includes(n)));
  const seen = hits.slice(from);
  // Ours, from this call and any earlier one since `from`, left out.
  for (const m of marks) if (m >= from) for (const n of ours) seen.splice(seen.lastIndexOf(n), 1);
  return seen;
}
/** Where each heardSince's own connections began. */
const marks: number[] = [];

/** A process's environment, as it was given. */
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

/** The process, or the first of its descendants (breadth first) whose environment can be read, and that environment. */
function outermostReadable(pid: number): [number, Record<string, string>] {
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift()!;
    const e = envOf(p);
    if (Object.keys(e).length) return [p, e];
    try {
      for (const t of readdirSync(`/proc/${p}/task`)) queue.push(...readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {}
  }
  throw new Error(`no process from ${pid} down has an environment that can be read`);
}

/** Which of the stand-in's addresses an environment holds, as "KEY=value". */
function hostValues(e: Record<string, string>): string[] {
  return Object.entries(e)
    .filter(([k, v]) => (Object.values(HOST_ENV) as string[]).includes(v) || (k !== 'XDG_RUNTIME_DIR' && v.includes(host) && !v.includes(join(host, 'dither-sandbox'))))
    .map(([k, v]) => `${k}=${v}`);
}

async function until(what: string, ok: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`no ${what} within ${ms} ms`);
    await Bun.sleep(50);
  }
}

/** What the app inside reports: its environment, and whether a system bus answers it (no sed inside: coreutils only). */
const APP = (dbusSend: string) => `out="$HOME/report.txt"
{
  env | while IFS= read -r l; do echo "env:$l"; done
  ${dbusSend} --system --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1 && echo "system=answered" || echo "system=none"
} > "$out.tmp"
mv "$out.tmp" "$out"
exec sleep 600
`;

describe.skipIf(!base)("a native-app sandbox and the machine's session", () => {
  for (const backend of BACKENDS)
    test(
      `on ${backend}: no process it starts, inside bubblewrap or out, has the machine's runtime directory, buses or audio server`,
      async () => {
        const before = hits.length;
        const dir = join(root, backend, 'desktop');
        const appDir = join(root, `${backend}-app`);
        mkdirSync(appDir, { recursive: true });
        const dbusSend = join(dirname(resolveBin(BINS.dbusDaemon, () => {})), 'dbus-send');
        writeFileSync(join(appDir, 'app.sh'), APP(dbusSend), { mode: 0o755 });
        const logs: string[] = [];
        const sb = new AppSandbox({
          dir,
          display: await pickFreeDisplay(undefined, [], backend),
          width: 640,
          height: 480,
          command: [resolveBin(BINS.sh, () => {}), join(appDir, 'app.sh')],
          roBinds: [appDir],
          audio: AUDIO,
          log: (l, m) => logs.push(`${l} ${m}`),
          onEvent: () => {},
        });
        try {
          await sb.start();
          const report = join(dir, 'home', 'report.txt');
          await until(`${backend}'s app report`, () => existsSync(report));
          const lines = readFileSync(report, 'utf8').trim().split('\n');
          const appEnv = Object.fromEntries(lines.filter((l) => l.startsWith('env:')).map((l) => [l.slice(4, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
          // The app: its own runtime directory and bus, its own audio server, no system bus.
          const run = `/run/user/${process.getuid!()}`;
          expect(appEnv).toMatchObject({ XDG_RUNTIME_DIR: run, DBUS_SESSION_BUS_ADDRESS: `unix:path=${run}/bus`, PULSE_SERVER: `unix:${run}/pulse/native` });
          expect(hostValues(appEnv)).toEqual([]);
          expect(lines).toContain('system=none');

          // The screen's tools, run once each: a picture (import on X, grim on Wayland).
          expect((await sb.screen!.screenshot()).subarray(1, 4).toString()).toBe('PNG');

          // Everything started outside bubblewrap: the sandbox's own runtime directory, none of the stand-in's addresses.
          const procs = (sb as unknown as { procs: { name: string; proc: Subprocess }[] }).procs.filter((p) => p.proc.exitCode === null);
          const names = procs.map((p) => p.name);
          expect(names).toEqual(expect.arrayContaining(['app', 'dbus-daemon', 'pulseaudio', ...sb.screen!.procNames]));
          const own = [sb.run, sb.screen!.runtimeDir!];
          for (const p of procs) {
            // pasta's own environment cannot be read (it makes itself undumpable): the app's is then that of
            // bubblewrap below it, started with it as it was.
            const [pid, e] = outermostReadable(p.proc.pid);
            const name = `${p.name} (${readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]!.split('/').pop()})`;
            expect([name, own.some((d) => e.XDG_RUNTIME_DIR?.startsWith(d))]).toEqual([name, true]);
            expect([name, hostValues(e)]).toEqual([name, []]);
            for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS']) expect([name, k, !!e[k]]).toEqual([name, k, true]);
          }
          // Nothing was made in the machine's runtime directory but the sandbox's own run directory (no wayland-N,
          // no wayvncctl, no pulse or dbus files of a server that looked there).
          expect(readdirSync(host).sort()).toEqual([...hostEntries, 'dither-sandbox'].sort());
          expect(await heardSince(before)).toEqual([]);
        } catch (e) {
          throw new Error(`${(e as Error).message}\n${logs.slice(-30).join('\n')}`);
        } finally {
          await sb.stop();
        }
        // Nothing came while it stopped either.
        expect(await heardSince(before)).toEqual([]);
      },
      90_000,
    );

  test('the watch would have seen it: a client given the environment the screen servers had goes to the stand-in bus and audio server; given noHostSession, to neither', async () => {
    const dbusSend = join(dirname(resolveBin(BINS.dbusDaemon, () => {})), 'dbus-send');
    const pactl = join(dirname(resolveBin(BINS.pulseaudio, () => {})), 'pactl');
    const home = join(root, 'control-home');
    mkdirSync(home, { recursive: true });
    const clean = join(root, 'control-rt');
    mkdirSync(clean, { recursive: true, mode: 0o700 });
    const probe = async (env: Record<string, string | undefined>) => {
      for (const cmd of [
        [dbusSend, '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'],
        [dbusSend, '--system', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'],
        [pactl, 'info'],
      ]) {
        const p = Bun.spawn(cmd, { env: cleanEnv(env), stdout: 'ignore', stderr: 'ignore' });
        await p.exited;
      }
    };
    // What the sandbox's spawn kept of the manager's environment before: PATH, HOME, XDG_RUNTIME_DIR (and the
    // system bus's address, where one is set).
    let from = hits.length;
    await probe({ PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: host, DBUS_SYSTEM_BUS_ADDRESS: HOST_ENV.DBUS_SYSTEM_BUS_ADDRESS });
    expect(await heardSince(from)).toEqual(expect.arrayContaining(['session bus', 'system bus', 'pulse in the runtime directory']));
    // The manager's whole environment, the stand-in's addresses in it, with noHostSession over it: none reached.
    from = hits.length;
    await probe({ ...process.env, HOME: home, ...noHostSession(clean) });
    expect(await heardSince(from)).toEqual([]);
  });
});
