/**
 * An X-only app on the wayland backend (AppSandboxOptions.x11App): xwayland-satellite inside the app's own sandbox,
 * so the app's X windows are windows of the sandbox's sway, driven by the same RFB input and pictured by the same
 * grim. xev stands in for the app and writes down every event it gets. What must not happen: an X socket on the
 * machine, at a path in its /tmp/.X11-unix or abstract in its network namespace. Skipped without the native-app
 * sandbox, the wayland backend's programs, pasta, xwayland-satellite or xev.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSandbox } from '../src/sandbox.ts';
import { BINS, resolveBin, tryBin } from '../src/bins.ts';
import { SwayIpc, views } from '../../browser/src/swayipc.ts';
import { decodePng, shareOf } from '../../browser/test/png.ts';
import { satellite, sandbox, wayland, why } from '../../../test/needs.ts';

const pasta = sandbox && !!tryBin(BINS.pasta, () => {});
const ok = why('an X app on wayland (bubblewrap, pasta, sway, wayvnc, grim, xwayland-satellite, xev)', sandbox && wayland && satellite && pasta);
const it = test.skipIf(!ok);

const root = mkdtempSync(join(tmpdir(), 'dacc-sat-'));
const dir = join(root, 'acct', 'app');
let sb: AppSandbox;
let ipc: SwayIpc;
/** What the sandbox said (its programs' output among it), for a timeout's message. */
const said: string[] = [];
const log = () => join(sb.home, 'xev.log');

beforeAll(async () => {
  if (!ok) return;
  const sh = resolveBin(BINS.sh, () => {});
  const xev = resolveBin({ name: 'xev', env: 'XEV_BIN', nix: 'xorg.xev' }, () => {});
  const appDir = join(root, 'bin');
  mkdirSync(appDir);
  // xev, line-buffered into a file; WAYLAND_DISPLAY written down first, to show the app was not given it.
  writeFileSync(join(appDir, 'app.sh'), `echo "wayland=\${WAYLAND_DISPLAY:-none} display=$DISPLAY" > "$HOME/env.txt"\nexec stdbuf -oL ${xev} -name sat-xev -event keyboard -event button > "$HOME/xev.log"\n`);
  sb = new AppSandbox({ dir, display: { backend: 'wayland', display: null }, width: 800, height: 600, command: [sh, join(appDir, 'app.sh')], roBinds: [appDir], x11App: true, log: (l, m) => said.push(`${l} ${m}`), onEvent: () => {} });
  await sb.start();
  ipc = await SwayIpc.connect(join(dir, 'wl', 'ipc.sock'));
}, 120_000);

afterAll(async () => {
  if (!ok) return;
  ipc?.close();
  await sb?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Polls for one specific thing (a window in sway's tree, a line in xev's log) until it is there. */
async function until<T>(get: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`not there within ${ms} ms; the sandbox said:\n${said.slice(-40).join('\n')}`);
    await Bun.sleep(50);
  }
}

const xevWindow = async () => views(await ipc.tree()).find((v) => v.name === 'sat-xev') ?? null;

function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(d)]);
    } catch {}
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(pid);
  return out;
}

const comm = (pid: number) => readFileSync(`/proc/${pid}/comm`, 'utf8').trim();

/** Unix sockets in the network namespace /proc/<pid>/net/unix is of: inode → path ('@…' for abstract). */
function unixTable(pid: number | 'self'): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of readFileSync(`/proc/${pid}/net/unix`, 'utf8').split('\n').slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 7) m.set(f[6], f[7] ?? '');
  }
  return m;
}

const socketInodes = (pid: number) =>
  readdirSync(`/proc/${pid}/fd`)
    .map((fd) => {
      try {
        return /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? null;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => !!x);

it('the X app runs with DISPLAY :0 and no WAYLAND_DISPLAY, and its window is a window of sway', async () => {
  const w = await until(xevWindow);
  // No Xwayland in sway (xwayland disable): the X window comes through satellite as an ordinary Wayland window.
  expect(w.shell).toBe('xdg_shell');
  expect(readFileSync(join(sb.home, 'env.txt'), 'utf8').trim()).toBe('wayland=none display=:0');
  expect(w.rect.width).toBe(800);
  expect(w.rect.height).toBe(600);
}, 60_000);

it('RFB input reaches it: a click is a ButtonPress, typed text is KeyPress events with the keysyms', async () => {
  await until(xevWindow);
  await sb.screen!.click(400, 300);
  await until(() => existsSync(log()) && /ButtonPress event[\s\S]*button 1,/.test(readFileSync(log(), 'utf8')));
  await sb.screen!.type('qZ');
  await until(() => {
    const t = readFileSync(log(), 'utf8');
    return /KeyPress event[\s\S]*\(keysym 0x71, q\)/.test(t) && /KeyPress event[\s\S]*\(keysym 0x5a, Z\)/.test(t);
  });
  await sb.screen!.keys(['Return']);
  await until(() => /KeyPress event[\s\S]*\(keysym 0xff0d, Return\)/.test(readFileSync(log(), 'utf8')));
}, 60_000);

it('grim pictures it: the screen is mostly the X window (white), not the empty output (black)', async () => {
  await until(xevWindow);
  const p = decodePng(await sb.screen!.screenshot());
  expect([p.width, p.height]).toEqual([800, 600]);
  expect(shareOf(p, [255, 255, 255])).toBeGreaterThan(0.8);
}, 60_000);

it("its X sockets are the sandbox's own: none in the machine's /tmp/.X11-unix, none abstract in the machine's network namespace", async () => {
  await until(xevWindow);
  const below = descendants(sb.appPid!);
  const xw = below.find((p) => comm(p) === 'Xwayland');
  const sat = below.find((p) => comm(p).includes('xwayland-sat'));
  expect(xw).toBeDefined();
  expect(sat).toBeDefined();
  // What the listening sockets are, in the sandbox's own network namespace: the path socket and the abstract one.
  const inside = unixTable(xw!);
  const listening = [...new Set([...socketInodes(xw!), ...socketInodes(sat!)])].map((i) => inside.get(i)).filter(Boolean);
  expect(listening).toContain('/tmp/.X11-unix/X0');
  expect(listening).toContain('@/tmp/.X11-unix/X0');
  // None of those sockets is in the machine's namespace: the machine's table does not have their inodes.
  const host = unixTable('self');
  for (const i of [...socketInodes(xw!), ...socketInodes(sat!)]) if (inside.get(i)?.includes('X11-unix')) expect(host.has(i)).toBe(false);
  expect(readlinkSync(`/proc/${xw}/ns/net`)).not.toBe(readlinkSync('/proc/self/ns/net'));
  // The path socket is in the sandbox's /tmp (a tmpfs of its own), not any file in the machine's /tmp/.X11-unix.
  const ours = statSync(`/proc/${xw}/root/tmp/.X11-unix/X0`);
  const hostX = existsSync('/tmp/.X11-unix') ? readdirSync('/tmp/.X11-unix').map((f) => statSync(join('/tmp/.X11-unix', f))) : [];
  for (const s of hostX) expect(s.dev === ours.dev && s.ino === ours.ino).toBe(false);
  expect(statSync('/tmp').dev).not.toBe(ours.dev);
}, 60_000);

it("without a network namespace of its own (network host) an X app is not put on Wayland: it gets an X display", async () => {
  const sh = resolveBin(BINS.sh, () => {});
  const warned: string[] = [];
  const other = new AppSandbox({ dir: join(root, 'acct', 'host-net'), display: { backend: 'wayland', display: null }, width: 320, height: 240, command: [sh, '-c', 'exec sleep 600'], network: 'host', x11App: true, log: (l, m) => l === 'warn' && warned.push(m), onEvent: () => {} });
  try {
    await other.start();
    expect(other.info()).toMatchObject({ backend: 'x11' });
    expect(warned.some((m) => /no network namespace of its own/.test(m))).toBe(true);
  } finally {
    await other.stop();
  }
}, 60_000);
