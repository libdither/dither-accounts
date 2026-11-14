/**
 * The edges of extractors outliving the manager (docs/supervisor.md): what an extractor started ends with it, an
 * adopted one that never reconnects or is SIGKILLed, a stop during staggered restarts, the self-exit without a manager,
 * the choice of launch, the scope launch (a stand-in for systemd-run, and the real one where this machine has a user
 * systemd), and main.ts on SIGTERM: a restart leaves extractors running, a stop stops them.
 */
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { newToken, Store } from '../packages/manager/src/db.ts';
import { cgroupMembers, cgroupOf, ownService, procAlive, procsWithEnv, restartQueued } from '../packages/manager/src/procs.ts';
import { chooseLaunch } from '../packages/manager/src/supervisor.ts';
import fakeManifest from '../extractors/fake/manifest.ts';

const ROOT = resolve(import.meta.dir, '..');
const MAIN = join(ROOT, 'packages/manager/src/main.ts');
const dirs: string[] = [];
const managers: Manager[] = [];
const units: string[] = [];

/** Every process a test's data directory started, by its environment: none may outlive the tests. */
const ofDir = (dir: string) => procsWithEnv((env) => env.DITHER_MANAGER_DATA?.startsWith(dir) === true);

afterAll(async () => {
  for (const m of managers) await m.stop().catch(() => {});
  for (const u of units) Bun.spawnSync(['systemctl', '--user', 'stop', u], { stdout: 'ignore', stderr: 'ignore' });
  for (const d of dirs) {
    for (const p of ofDir(d)) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {}
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const until = async (f: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const kinds = () => new Map([['fake', kindOf(fakeManifest, join(ROOT, 'extractors/fake'))]]);
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-outlive-${name}-`));
  dirs.push(d);
  return d;
};

type Opts = Partial<Parameters<typeof createManager>[0]>;
async function manager(dir: string, o: Opts = {}) {
  const m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: kinds(), launch: 'detached', fingerprint: () => 'v1', restartPauseMs: 50, ...o });
  managers.push(m);
  return m;
}

function insertAccount(store: Store, dir: string, id: string, config: Record<string, unknown> = {}) {
  const accDir = join(dir, 'accounts', id);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  store.run(
    'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
    id,
    'fake',
    'Fake',
    JSON.stringify(config),
    newToken(),
    accDir,
    now,
    now,
  );
  return accDir;
}

const online = (m: Manager, id: string) => m.sup.state(id).online;
const pidsOf = async (m: Manager, id: string) => (await m.sup.command(id, { t: 'pid' })) as { pid: number; children: number[] };
const allGone = (pids: number[]) => pids.every((p) => !procAlive(p));

async function started(m: Manager, dir: string, id: string, config: Record<string, unknown> = { children: true }) {
  insertAccount(m.store, dir, id, config);
  m.sup.start(id);
  await until(() => online(m, id), 15_000, `${id} online`);
  return pidsOf(m, id);
}

test('a stopped account ends its extractor and everything it started, in its process group or a session of its own', async () => {
  const dir = tempDir('children');
  const m = await manager(dir);
  const p = await started(m, dir, 'acc-children-1');
  expect(p.children).toHaveLength(2);
  expect(p.children.every((c) => procAlive(c))).toBe(true);
  await m.sup.stop('acc-children-1');
  await until(() => allGone([p.pid, ...p.children]), 10_000, 'the extractor and its children gone');
  // A crash: what it started goes before the next one starts.
  const q = await (async () => {
    m.sup.start('acc-children-1');
    await until(() => online(m, 'acc-children-1'), 15_000, 'online again');
    return pidsOf(m, 'acc-children-1');
  })();
  process.kill(q.pid, 'SIGKILL');
  await until(() => allGone(q.children), 15_000, "the crashed one's children gone");
  await until(() => online(m, 'acc-children-1'), 20_000, 'started again');
  await m.stop();
  expect(ofDir(dir)).toEqual([]);
});

test('an adopted extractor that never reconnects is started afresh, and the old one and its children end first', async () => {
  const dir = tempDir('stuck');
  const m1 = await manager(dir);
  const p = await started(m1, dir, 'acc-stuck-1');
  await m1.stop({ leaveExtractors: true });
  // A new port: the old extractor keeps knocking on the old one and never connects.
  const m2 = await manager(dir, { adoptConnectMs: 1500 });
  await until(() => m2.sup.details('acc-stuck-1').adopted, 5000, 'adopted');
  await until(() => allGone([p.pid, ...p.children]), 20_000, 'the stuck one and its children gone');
  await until(() => online(m2, 'acc-stuck-1'), 15_000, 'a fresh one online');
  expect((await pidsOf(m2, 'acc-stuck-1')).pid).not.toBe(p.pid);
  await m2.stop();
});

test('an adopted extractor that is SIGKILLed is a crash ("killed"): recorded, its children ended, started again', async () => {
  const dir = tempDir('killed');
  const m1 = await manager(dir);
  const p = await started(m1, dir, 'acc-killed-1');
  const port = m1.http.server.port!;
  await m1.stop({ leaveExtractors: true });
  const m2 = await manager(dir, { port, errors: true });
  await until(() => online(m2, 'acc-killed-1'), 15_000, 'adopted and back');
  process.kill(p.pid, 'SIGKILL');
  await until(() => m2.sup.details('acc-killed-1').lastExit?.signal === 'killed', 10_000, 'its end seen');
  await until(() => allGone(p.children), 10_000, 'its children gone');
  await until(() => online(m2, 'acc-killed-1'), 20_000, 'started again');
  m2.errors!.flush();
  const recs = readFileSync(join(dir, 'traces/errors.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(recs.some((r) => r.where === 'extractor fake' && r.extra?.signal === 'killed')).toBe(true);
  await m2.stop();
});

test('an account stopped while staggered restarts wait stays stopped; the others restart; the counts say so', async () => {
  const dir = tempDir('stagger');
  const m1 = await manager(dir);
  const a = await started(m1, dir, 'acc-stagger-a', {});
  const b = await started(m1, dir, 'acc-stagger-b', {});
  const port = m1.http.server.port!;
  await m1.stop({ leaveExtractors: true });
  const m2 = await manager(dir, { port, fingerprint: () => 'v2', restartPauseMs: 700 });
  await until(() => online(m2, 'acc-stagger-a') && online(m2, 'acc-stagger-b'), 15_000, 'both adopted and back');
  expect(m2.sup.codeRestarts()).toMatchObject({ queued: 2, restarted: 0 });
  // Stopped on purpose (the page, an app) while it waits its turn.
  await m2.sup.stop('acc-stagger-a');
  expect(procAlive(a.pid)).toBe(false);
  await until(() => online(m2, 'acc-stagger-b') && !m2.sup.details('acc-stagger-b').adopted, 20_000, 'b restarted');
  expect((await pidsOf(m2, 'acc-stagger-b')).pid).not.toBe(b.pid);
  await Bun.sleep(1000);
  expect(m2.sup.state('acc-stagger-a').running).toBe(false);
  expect(m2.sup.codeRestarts()).toEqual({ queued: 0, active: false, restarted: 1, online: 1, crashed: 0 });
  const health = (await (await fetch(`${m2.url}/api/health`)).json()) as any;
  expect(health.codeRestarts).toEqual({ queued: 0, active: false, restarted: 1, online: 1, crashed: 0 });
  await m2.stop();
});

test('an extractor with no manager for DITHER_MANAGER_GONE_EXIT_S ends itself, and says how', async () => {
  const dir = tempDir('gone');
  const accDir = join(dir, 'acc');
  mkdirSync(accDir);
  const free = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = free.port;
  free.stop(true);
  const p = Bun.spawn(['bun', join(ROOT, 'extractors/fake/src/main.ts')], {
    env: { ...process.env, DITHER_HUB_URL: `ws://127.0.0.1:${port}/extractor`, DITHER_ACCOUNT_ID: 'acc-gone-1', DITHER_ADAPTER_TOKEN: 'x', DITHER_ACCOUNT_DIR: accDir, DITHER_MANAGER_GONE_EXIT_S: '1', DITHER_EXTRACTOR_LAUNCH: 'detached', DITHER_MANAGER_DATA: dir },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const code = await Promise.race([p.exited, Bun.sleep(10_000).then(() => 'still running')]);
  if (code === 'still running') p.kill('SIGKILL');
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(join(accDir, 'extractor.exit'), 'utf8'))).toMatchObject({ pid: p.pid, code: 0 });
});

test('launch: a process that only inherited INVOCATION_ID is not a service; scope needs the main process of one', () => {
  const was = process.env.INVOCATION_ID;
  process.env.INVOCATION_ID = 'inherited-from-a-service';
  try {
    expect(chooseLaunch('auto')).toEqual({ launch: 'child', unit: null });
  } finally {
    if (was === undefined) delete process.env.INVOCATION_ID;
    else process.env.INVOCATION_ID = was;
  }
  expect(ownService(process.pid, () => 1)).toBe(null);
  expect(chooseLaunch('auto', { service: () => 'dither-accounts.service', probe: () => true })).toEqual({ launch: 'scope', unit: 'dither-accounts.service' });
  expect(chooseLaunch('auto', { service: () => 'dither-accounts.service', probe: () => false }).launch).toBe('child');
  expect(chooseLaunch('detached', { service: () => null }).launch).toBe('detached');
  // systemd's job for the unit says restart or stop.
  expect(restartQueued('dither-accounts.service', () => '1026808 dither-accounts.service restart running\n')).toBe(true);
  expect(restartQueued('dither-accounts.service', () => '1026833 dither-accounts.service stop running\n')).toBe(false);
  expect(restartQueued('dither-accounts.service', () => '7 other.service restart running\n')).toBe(false);
  expect(restartQueued('dither-accounts.service', () => '')).toBe(false);
});

test('a second manager on a data directory in use refuses to start', async () => {
  const dir = tempDir('second');
  const m = await manager(dir);
  await expect(manager(dir)).rejects.toThrow(/another manager/);
  await m.stop();
  const again = await manager(dir);
  await again.stop();
});

test('the scope launch goes through systemd-run (a stand-in here) and the extractor runs as usual', async () => {
  const dir = tempDir('fakescope');
  const bin = join(dir, 'systemd-run');
  const args = join(dir, 'args');
  // Takes the options as systemd-run does, then runs the command in place.
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(args)}\nwhile [ "$#" -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done\nexec "$@"\n`);
  chmodSync(bin, 0o755);
  const m = await manager(dir, { launch: 'scope', systemdRun: bin });
  const p = await started(m, dir, 'acc-fakescope-1', {});
  const argv = readFileSync(args, 'utf8').split('\n');
  expect(argv.slice(0, 4)).toEqual(['--user', '--scope', '--quiet', '--collect']);
  expect(argv.some((a) => /^--unit=dither-accounts-x-acc-fakescope-1-[a-z0-9]+\.scope$/.test(a))).toBe(true);
  await m.stop();
  expect(procAlive(p.pid)).toBe(false);
});

/** A user systemd this test may make transient units in. */
const systemd = Bun.spawnSync(['systemd-run', '--user', '--scope', '--quiet', '--collect', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

test.skipIf(!systemd)('real systemd: an extractor in its own scope; a stop empties the scope', async () => {
  const dir = tempDir('scope');
  const m = await manager(dir, { launch: 'scope' });
  const p = await started(m, dir, 'acc-scope-1');
  await until(() => !!cgroupOf(p.pid)?.includes('dither-accounts-x-acc-scope-1-'), 5000, 'its own scope');
  const cg = cgroupOf(p.pid)!;
  expect(cgroupMembers(cg).map((r) => r.pid)).toEqual(expect.arrayContaining([p.pid, ...p.children]));
  await m.sup.stop('acc-scope-1');
  expect(allGone([p.pid, ...p.children])).toBe(true);
  expect(cgroupMembers(cg)).toEqual([]);
  await m.stop();
});

test.skipIf(!systemd)('real systemd: main.ts as a service: a restart leaves its extractors to the next one, a stop stops them', async () => {
  const dir = tempDir('svc');
  const s = new Store(join(dir, 'accounts.sqlite'));
  insertAccount(s, dir, 'acc-svc-1', { children: true });
  s.db.close();
  const free = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = free.port;
  free.stop(true);
  const unit = `dacc-test-${process.pid}-${Date.now().toString(36)}.service`;
  units.push(unit);
  const run = Bun.spawnSync(['systemd-run', '--user', '--quiet', `--unit=${unit}`, '--collect', `--setenv=PATH=${process.env.PATH}`, `--working-directory=${ROOT}`, process.execPath, MAIN, '--data', dir, '--port', String(port), '--trace', '0', '--errors', '0'], { stdout: 'pipe', stderr: 'pipe' });
  expect(run.exitCode).toBe(0);
  const health = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  };
  const extractors = () => procsWithEnv((env) => env.DITHER_ACCOUNT_ID === 'acc-svc-1' && env.DITHER_MANAGER_DATA === dir).filter((r) => readFileSync(`/proc/${r.pid}/cmdline`, 'utf8').includes('/src/main.ts'));
  await until(health, 20_000, 'the manager up');
  await until(() => extractors().length === 1, 20_000, 'its extractor');
  const [x] = extractors();
  expect(cgroupOf(x!.pid)).toMatch(/dither-accounts-x-acc-svc-1-/);

  Bun.spawnSync(['systemctl', '--user', 'restart', unit]);
  await until(health, 20_000, 'the manager back');
  await until(() => readFileSync(join(dir, 'accounts/acc-svc-1/adapter.log'), 'utf8').includes(`took over the running fake extractor (pid ${x!.pid})`), 20_000, 'adopted');
  expect(procAlive(x!.pid, x!.start)).toBe(true);
  expect(existsSync(join(dir, 'handover.json'))).toBe(false);

  Bun.spawnSync(['systemctl', '--user', 'stop', unit]);
  await until(() => !procAlive(x!.pid, x!.start), 20_000, 'a stop stops it');
  await until(() => ofDir(dir).length === 0, 10_000, 'and everything it started');
}, 90_000);

test('main.ts without systemd: SIGTERM leaves a detached launch running, and stops a child launch', async () => {
  for (const launch of ['detached', 'child'] as const) {
    const dir = tempDir(`main-${launch}`);
    const s = new Store(join(dir, 'accounts.sqlite'));
    insertAccount(s, dir, `acc-main-${launch}`, {});
    s.db.close();
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DITHER_ACCOUNTS_') && k !== 'INVOCATION_ID'));
    const p = Bun.spawn(['bun', MAIN, '--data', dir, '--port', '0', '--launch', launch, '--trace', '0', '--errors', '0'], { env: clean, stdout: 'ignore', stderr: 'ignore' });
    const extractors = () => ofDir(dir).filter((r) => readFileSync(`/proc/${r.pid}/cmdline`, 'utf8').includes('/src/main.ts'));
    await until(() => extractors().length === 1, 20_000, `${launch}: its extractor`);
    const [x] = extractors();
    // Connected by then, so it can say it holds its events.
    await until(() => readFileSync(join(dir, `accounts/acc-main-${launch}/adapter.log`), 'utf8').includes('fake extractor up'), 15_000, `${launch}: online`);
    p.kill('SIGTERM');
    await p.exited;
    await Bun.sleep(500);
    expect(procAlive(x!.pid, x!.start)).toBe(launch === 'detached');
    if (launch === 'detached') {
      expect(JSON.parse(readFileSync(join(dir, 'handover.json'), 'utf8')).holding).toEqual([`acc-main-${launch}`]);
      process.kill(x!.pid, 'SIGTERM');
    }
  }
}, 60_000);
