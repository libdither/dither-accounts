/**
 * The sandboxes' programs, prepared at the manager's start (packages/manager/src/prepare.ts) with a stand-in
 * nix-build: an extractor of a kind with a screen starts only once they are ready and is given their directory
 * (DITHER_BINS) and its display backend; one of a kind with no screen starts at once, with neither. A failed build keeps
 * the last good out-link, and is tried again until one succeeds; with no earlier one, kinds with a screen wait for it,
 * and the page says so.
 */
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { newToken } from '../packages/manager/src/db.ts';
import { prepareBins } from '../packages/manager/src/prepare.ts';
import fakeManifest from '../extractors/fake/manifest.ts';

setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, '..');
const RUN = process.pid.toString(36);
const dirs: string[] = [];
const managers: Manager[] = [];
afterAll(async () => {
  for (const m of managers) await m.stop().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-prepare-${p}-`));
  dirs.push(d);
  return d;
};

/**
 * A nix-build that waits for `<dir>/go`, then makes `-o`'s link to `<dir>/store` (or, with `<dir>/fail`, fails), and
 * writes the arguments it was given to `<dir>/args`. The forks' build (-A dither-bins-forks) links `<dir>/store-forks`
 * instead, fails with `<dir>/fail-forks`, and writes `<dir>/args-forks`.
 */
function fakeNixBuild(dir: string): string {
  mkdirSync(join(dir, 'store'), { recursive: true });
  mkdirSync(join(dir, 'store-forks'), { recursive: true });
  const script = join(dir, 'nix-build');
  writeFileSync(
    script,
    `#!/bin/sh
case " $* " in *" dither-bins-forks "*) sfx=-forks ;; *) sfx= ;; esac
printf '%s\\n' "$@" > '${dir}/args'"$sfx"
while [ ! -e '${dir}/go' ]; do sleep 0.02; done
if [ -e '${dir}/fail'"$sfx" ]; then echo "error: the build failed" >&2; exit 1; fi
out=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
ln -sfn '${dir}/store'"$sfx" "$out"
echo '${dir}/store'"$sfx"
`,
    { mode: 0o755 },
  );
  return script;
}

function addAccount(m: Manager, dir: string, id: string, kind: string) {
  const accDir = join(dir, 'accounts', id);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  m.store.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)', id, kind, 'Fake', '{}', newToken(), accDir, now, now);
}

const until = async (what: string, f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const envOf = (pid: number) => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

test('a kind with a screen starts once the programs are prepared, with their directory; one without starts at once, with neither', async () => {
  const dir = tmp('manager');
  const nix = tmp('nix');
  const fake = kindOf(fakeManifest, join(ROOT, 'extractors/fake'));
  const plain = kindOf({ ...fakeManifest, kind: 'plain', screen: undefined }, join(ROOT, 'extractors/fake'));
  const m = await createManager({ dataDir: dir, port: 0, kinds: new Map([['fake', fake], ['plain', plain]]), launch: 'child', displayBackend: 'wayland', prepareBins: { nixBuild: fakeNixBuild(nix) } });
  managers.push(m);
  const screenId = `acc-prep-screen-${RUN}`;
  const plainId = `acc-prep-plain-${RUN}`;
  addAccount(m, dir, screenId, 'fake');
  addAccount(m, dir, plainId, 'plain');
  m.sup.start(screenId);
  m.sup.start(plainId);
  await until('the kind without a screen running', () => !!m.sup.details(plainId).pid);
  // The other waits for the build, which waits for `go`.
  await until('the build started', () => existsSync(join(nix, 'args')));
  expect(m.sup.details(screenId).pid).toBeFalsy();
  expect(readFileSync(join(nix, 'args'), 'utf8').trim().split('\n')).toEqual([join(ROOT, 'nix'), '-A', 'dither-bins', '-o', join(dir, 'bins')]);
  const plainEnv = envOf(m.sup.details(plainId).pid!);
  expect(plainEnv.DITHER_BINS).toBeUndefined();
  expect(plainEnv.DITHER_DISPLAY_BACKEND).toBeUndefined();
  expect(m.sup.details(plainId).displayBackend).toBeNull();

  writeFileSync(join(nix, 'go'), '');
  await m.bins!.ready;
  expect(m.bins!.state).toMatchObject({ state: 'ready', dir: join(dir, 'bins'), tries: 1 });
  expect(readlinkSync(join(dir, 'bins'))).toBe(join(nix, 'store'));
  await until('the kind with a screen running', () => !!m.sup.details(screenId).pid);
  const env = envOf(m.sup.details(screenId).pid!);
  expect(env.DITHER_BINS).toBe(join(dir, 'bins'));
  expect(env.DITHER_DISPLAY_BACKEND).toBe('wayland');
  expect(m.sup.details(screenId).displayBackend).toBe('wayland');
});

test('a failed build keeps the last good programs; no nix-build at all leaves them to PATH', async () => {
  const dir = tmp('fails');
  const nix = tmp('nix-fails');
  const script = fakeNixBuild(nix);
  writeFileSync(join(nix, 'go'), '');
  expect(await prepareBins({ repoRoot: ROOT, dataDir: dir, nixBuild: script })).toMatchObject({ dir: join(dir, 'bins') });
  writeFileSync(join(nix, 'fail'), '');
  const logs: string[] = [];
  const r = await prepareBins({ repoRoot: ROOT, dataDir: dir, nixBuild: script, log: (l, msg) => logs.push(`${l} ${msg}`) });
  expect(r.dir).toBe(join(dir, 'bins'));
  expect(r.why).toMatch(/nix-build exited 1: error: the build failed/);
  expect(logs.some((l) => l.startsWith('warn') && l.includes('the last ones stay'))).toBe(true);
  expect(readlinkSync(join(dir, 'bins'))).toBe(join(nix, 'store'));
  const none = tmp('none');
  const was = process.env.PATH;
  try {
    process.env.PATH = none;
    expect(await prepareBins({ repoRoot: ROOT, dataDir: none })).toMatchObject({ dir: null, why: 'no nix-build' });
  } finally {
    process.env.PATH = was;
  }
});

test('a first build that fails is tried again: kinds with a screen wait, the page says so, and they start once one succeeds', async () => {
  const dir = tmp('retry');
  const nix = tmp('nix-retry');
  const script = fakeNixBuild(nix);
  writeFileSync(join(nix, 'fail'), '');
  writeFileSync(join(nix, 'go'), '');
  const fake = kindOf(fakeManifest, join(ROOT, 'extractors/fake'));
  const m = await createManager({ dataDir: dir, port: 0, kinds: new Map([['fake', fake]]), launch: 'child', openPage: true, prepareBins: { nixBuild: script, firstRetryMs: 50 } });
  managers.push(m);
  const id = `acc-prep-retry-${RUN}`;
  addAccount(m, dir, id, 'fake');
  m.sup.start(id);
  // Two failed builds, so it is surely trying again, not stopped at the first.
  await until('a second failed build', () => m.bins!.state.state === 'failing' && m.bins!.state.tries >= 2);
  expect(m.bins!.state).toMatchObject({ dir: null, why: expect.stringMatching(/nix-build exited 1: error: the build failed/) });
  expect(m.bins!.state.retryAt).toBeGreaterThan(0);
  expect(existsSync(join(dir, 'bins'))).toBe(false);
  expect(m.sup.details(id).pid).toBeFalsy();
  // The page's state says so (Overview shows it as a banner).
  const state = (await (await fetch(`${m.url}/api/state`)).json()) as { bins: { state: string; dir: string | null } };
  expect(state.bins).toMatchObject({ state: 'failing', dir: null });

  rmSync(join(nix, 'fail'));
  await m.bins!.ready;
  expect(m.bins!.state).toMatchObject({ state: 'ready', dir: join(dir, 'bins'), why: null, retryAt: null });
  await until('the kind with a screen running', () => !!m.sup.details(id).pid);
  expect(envOf(m.sup.details(id).pid!).DITHER_BINS).toBe(join(dir, 'bins'));
});

test("the forks' servers are a build of their own: asked for only when one is picked, after the rest; failing, it leaves x11 as it was", async () => {
  const dir = tmp('forks');
  const nix = tmp('nix-forks');
  const script = fakeNixBuild(nix);
  // The x11 backend's programs in the first build; the forks' build fails until told otherwise.
  for (const [attr, bin] of [['xvfb', 'Xvfb'], ['x11vnc', 'x11vnc']]) {
    mkdirSync(join(nix, 'store', attr, 'bin'), { recursive: true });
    writeFileSync(join(nix, 'store', attr, 'bin', bin), '#!/bin/sh\n', { mode: 0o755 });
  }
  writeFileSync(join(nix, 'fail-forks'), '');
  writeFileSync(join(nix, 'go'), '');
  const fake = kindOf(fakeManifest, join(ROOT, 'extractors/fake'));
  const m = await createManager({ dataDir: dir, port: 0, kinds: new Map([['fake', fake]]), launch: 'child', openPage: true, displayBackend: 'x11', restartPauseMs: 50, prepareBins: { nixBuild: script, firstRetryMs: 100 } });
  managers.push(m);
  const api = (path: string, method = 'GET', body?: unknown) => fetch(m.url + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const backends = async () => Object.fromEntries(((await (await api('/api/state')).json()) as any).display.backends.map((b: any) => [b.name, b.availability]));
  const id = `acc-prep-x11-${RUN}`;
  addAccount(m, dir, id, 'fake');
  m.sup.start(id);
  await until('the x11 account running', () => !!m.sup.details(id).pid);
  const pid = m.sup.details(id).pid!;
  // Only the first build ran: nothing uses a fork's backend yet.
  expect(envOf(pid).DITHER_BINS).toBe(join(dir, 'bins'));
  expect(m.forkBins!.state.state).toBe('idle');
  expect(existsSync(join(nix, 'args-forks'))).toBe(false);
  expect(await backends()).toMatchObject({ x11: 'ready', kasmvnc: 'unbuilt', 'wayland-tigervnc': 'unbuilt' });

  // Picking one starts the forks' build and is refused meanwhile; the build fails.
  const first = await api('/api/display', 'PUT', { default: 'kasmvnc' });
  expect(first.status).toBe(409);
  expect(((await first.json()) as any).error).toMatch(/being built now/);
  await m.forkBins!.tried;
  expect(readFileSync(join(nix, 'args-forks'), 'utf8').trim().split('\n')).toEqual([join(ROOT, 'nix'), '-A', 'dither-bins-forks', '-o', join(dir, 'bins-forks')]);
  expect(m.forkBins!.state).toMatchObject({ state: 'failing', dir: null });
  const state = (await (await api('/api/state')).json()) as any;
  expect(state.bins).toMatchObject({ state: 'ready' });
  expect(state.forkBins).toMatchObject({ state: 'failing', dir: null });
  expect(await backends()).toMatchObject({ x11: 'ready', kasmvnc: 'missing', 'wayland-tigervnc': 'missing' });
  const again = await api('/api/display', 'PUT', { default: 'kasmvnc' });
  expect(again.status).toBe(409);
  expect(((await again.json()) as any).error).toMatch(/cannot run here now: its servers, built from a fork, could not be built/);
  expect((await api(`/api/accounts/${id}`, 'PATCH', { settings: { displayBackend: 'wayland-tigervnc' } })).status).toBe(409);
  // x11 as it was: the same process, on x11, with the first build only, and the default untouched.
  expect(m.sup.details(id)).toMatchObject({ pid, displayBackend: 'x11' });
  expect(m.sup.defaultBackend()).toBe('x11');

  // An account already on one (its config names it) waits for the forks' build, and starts once a try succeeds,
  // with both directories; then the backend can be picked, and moves the x11 one.
  const forkId = `acc-prep-kasm-${RUN}`;
  addAccount(m, dir, forkId, 'fake');
  m.store.run('UPDATE account SET config = ? WHERE id = ?', JSON.stringify({ displayBackend: 'kasmvnc' }), forkId);
  m.sup.start(forkId);
  // Not started across another failed try of the forks' build (the x11 one never waited for it).
  const tries = m.forkBins!.state.tries;
  await until("another failed try of the forks' build", () => m.forkBins!.state.tries > tries);
  expect(m.sup.details(forkId).pid).toBeFalsy();
  expect(m.sup.details(id)).toMatchObject({ pid, displayBackend: 'x11' });
  mkdirSync(join(nix, 'store-forks', 'kasmvnc', 'bin'), { recursive: true });
  writeFileSync(join(nix, 'store-forks', 'kasmvnc', 'bin', 'Xkasmvnc'), '#!/bin/sh\n', { mode: 0o755 });
  rmSync(join(nix, 'fail-forks'));
  await m.forkBins!.ready;
  await until('the kasmvnc account running', () => !!m.sup.details(forkId).pid);
  expect(envOf(m.sup.details(forkId).pid!)).toMatchObject({ DITHER_BINS: `${join(dir, 'bins')}:${join(dir, 'bins-forks')}`, DITHER_DISPLAY_BACKEND: 'kasmvnc' });
  expect(await backends()).toMatchObject({ x11: 'ready', kasmvnc: 'ready' });
  expect((await api('/api/display', 'PUT', { default: 'kasmvnc' })).status).toBe(200);
  await until('the x11 account moved', () => m.sup.details(id).displayBackend === 'kasmvnc' && !!m.sup.details(id).pid);
  expect(envOf(m.sup.details(id).pid!).DITHER_BINS).toBe(`${join(dir, 'bins')}:${join(dir, 'bins-forks')}`);
});
