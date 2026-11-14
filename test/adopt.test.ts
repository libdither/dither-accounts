/**
 * Extractors outlive the manager (docs/supervisor.md): a manager that stops with leaveExtractors leaves them running,
 * the next one on the same data directory adopts them, restarts only those whose code changed (one at a time), stops
 * strays of disabled or removed accounts, and still stops an account's extractor when asked. Launched `detached` here
 * (no systemd in tests); the `scope` launch differs only in the systemd-run prefix.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { newToken, Store } from '../packages/manager/src/db.ts';
import { procAlive, procStat } from '../packages/manager/src/procs.ts';
import fakeManifest from '../extractors/fake/manifest.ts';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
const managers: Manager[] = [];
const pids: number[] = [];

afterAll(async () => {
  for (const m of managers) await m.stop().catch(() => {});
  // Anything a test left running (it failed half way): never outlive the tests.
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
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

async function manager(dir: string, opts: { port?: number; code?: string; pause?: number } = {}) {
  const m = await createManager({
    openPage: true,
    dataDir: dir,
    port: opts.port ?? 0,
    kinds: kinds(),
    launch: 'detached',
    fingerprint: () => opts.code ?? 'v1',
    restartPauseMs: opts.pause ?? 50,
  });
  managers.push(m);
  return m;
}

function addAccount(m: Manager, dir: string, id: string, config: Record<string, unknown> = {}) {
  const accDir = join(dir, 'accounts', id);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  m.store.run(
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
const pidOf = async (m: Manager, id: string) => ((await m.sup.command(id, { t: 'pid' })) as { pid: number }).pid;

/** A data directory with one fake account whose extractor runs under a first manager. */
async function world(name: string, opts: { code?: string; config?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `dacc-adopt-${name}-`));
  dirs.push(dir);
  const m1 = await manager(dir, opts);
  const id = `acc-${name}-1`;
  const accDir = addAccount(m1, dir, id, opts.config);
  m1.sup.start(id);
  await until(() => online(m1, id), 15_000, 'the extractor online');
  const pid = await pidOf(m1, id);
  pids.push(pid);
  const port = m1.http.server.port!;
  return { dir, m1, id, accDir, pid, port };
}

test('a manager that stops leaving its extractors keeps them running; the next one adopts them, unchanged', async () => {
  const { dir, m1, id, accDir, pid, port } = await world('keep');
  const start = procStat(pid)!.start;
  await m1.stop({ leaveExtractors: true });
  await Bun.sleep(300);
  expect(procAlive(pid, start)).toBe(true);

  // The next manager, on the same port the extractor reconnects to.
  const m2 = await manager(dir, { port });
  await until(() => online(m2, id), 15_000, 'the adopted extractor to reconnect');
  expect(m2.sup.details(id)).toMatchObject({ pid, adopted: true, starts: 0 });
  expect(await pidOf(m2, id)).toBe(pid);
  // Its hello and status came again, so the page and apps see it as before.
  await until(() => m2.router.lastStatus(id)?.status === 'online', 5000, 'its status');
  expect(m2.router.lastEvent(id, 'hello')).toBeTruthy();
  // Same code: no restart, even after a pause.
  await Bun.sleep(500);
  expect(await pidOf(m2, id)).toBe(pid);
  expect(readFileSync(join(accDir, 'adapter.log'), 'utf8')).toContain(`took over the running fake extractor (pid ${pid})`);

  // A stop still stops it, adopted or not.
  await m2.sup.stop(id);
  expect(procAlive(pid, start)).toBe(false);
  await m2.stop();
});

test('an adopted extractor whose code changed restarts; one at a time', async () => {
  const { dir, m1, id, pid, port } = await world('changed', { code: 'v1' });
  const id2 = 'acc-changed-2';
  addAccount(m1, dir, id2);
  m1.sup.start(id2);
  await until(() => online(m1, id2), 15_000, 'the second extractor online');
  const pid2 = await pidOf(m1, id2);
  pids.push(pid2);
  await m1.stop({ leaveExtractors: true });

  const m2 = await manager(dir, { port, code: 'v2', pause: 400 });
  // Both adopted first, then restarted one after the other: never both down at once.
  await until(() => m2.sup.details(id).adopted && m2.sup.details(id2).adopted, 5000, 'both adopted');
  await until(() => online(m2, id) && online(m2, id2), 15_000, 'both reconnected');
  let bothDown = false;
  const watch = setInterval(() => {
    if (!m2.sup.state(id).online && !m2.sup.state(id2).online) bothDown = true;
  }, 10);
  try {
    await until(async () => online(m2, id) && online(m2, id2) && !m2.sup.details(id).adopted && !m2.sup.details(id2).adopted, 30_000, 'both restarted');
  } finally {
    clearInterval(watch);
  }
  const [n1, n2] = [await pidOf(m2, id), await pidOf(m2, id2)];
  pids.push(n1, n2);
  expect(n1).not.toBe(pid);
  expect(n2).not.toBe(pid2);
  expect(procAlive(pid)).toBe(false);
  expect(procAlive(pid2)).toBe(false);
  expect(bothDown).toBe(false);
  await m2.stop();
  expect(procAlive(n1)).toBe(false);
});

test("strays of an account disabled or removed while no manager ran are stopped; the enabled one's is adopted", async () => {
  const { dir, m1, id, pid, port } = await world('stray');
  const gone = 'acc-stray-2';
  const off = 'acc-stray-3';
  for (const x of [gone, off]) {
    addAccount(m1, dir, x);
    m1.sup.start(x);
  }
  await until(() => online(m1, gone) && online(m1, off), 15_000, 'all online');
  const [pGone, pOff] = [await pidOf(m1, gone), await pidOf(m1, off)];
  pids.push(pGone, pOff);
  await m1.stop({ leaveExtractors: true });

  const s = new Store(join(dir, 'accounts.sqlite'));
  s.run('DELETE FROM account WHERE id = ?', gone);
  s.run('UPDATE account SET enabled = 0 WHERE id = ?', off);
  s.db.close();

  const m2 = await manager(dir, { port });
  await until(() => !procAlive(pGone) && !procAlive(pOff), 15_000, 'the strays stopped');
  await until(() => online(m2, id), 15_000, 'the enabled one adopted');
  expect(await pidOf(m2, id)).toBe(pid);
  expect(m2.sup.state(off).running).toBe(false);
  await m2.stop();
});

test('an adopted extractor that ends is noticed in /proc, its exit code read from its directory, and started again', async () => {
  const { dir, m1, id, accDir, pid, port } = await world('dies');
  await m1.stop({ leaveExtractors: true });
  const m2 = await manager(dir, { port });
  await until(() => online(m2, id), 15_000, 'adopted');
  await m2.sup.command(id, { t: 'exit', code: 3 });
  await until(() => m2.sup.details(id).lastExit?.code === 3, 10_000, 'its exit seen');
  await until(() => online(m2, id), 15_000, 'started again');
  const again = await pidOf(m2, id);
  pids.push(again);
  expect(again).not.toBe(pid);
  expect(m2.sup.details(id).adopted).toBe(false);
  expect(existsSync(join(accDir, 'extractor.exit'))).toBe(true);
  await m2.stop();
});

test("another manager's extractors (another data directory) are never adopted or stopped", async () => {
  const a = await world('mine');
  const b = await world('theirs');
  await a.m1.stop({ leaveExtractors: true });
  const m2 = await manager(a.dir, { port: a.port });
  await until(() => online(m2, a.id), 15_000, 'its own adopted');
  await Bun.sleep(300);
  expect(procAlive(b.pid)).toBe(true);
  expect(online(b.m1, b.id)).toBe(true);
  await m2.stop();
  await b.m1.stop();
  expect(procAlive(b.pid)).toBe(false);
});

test('without leaveExtractors, and with the child launch, a stopping manager stops its extractors', async () => {
  const { m1, pid } = await world('plain');
  await m1.stop();
  expect(procAlive(pid)).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), 'dacc-adopt-child-'));
  dirs.push(dir);
  const m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: kinds() });
  managers.push(m);
  addAccount(m, dir, 'acc-child-1');
  m.sup.start('acc-child-1');
  await until(() => online(m, 'acc-child-1'), 15_000, 'online');
  const p = await pidOf(m, 'acc-child-1');
  pids.push(p);
  await m.stop({ leaveExtractors: true });
  expect(procAlive(p)).toBe(false);
});

/** An app with test.echo on every account, approved, not connected. */
async function app(m: Manager) {
  const r = await register(m.url, { name: 'notes-app', requests: [{ interface: 'test.echo', level: 'manage' }] });
  for (const q of r.requests) expect((await fetch(`${m.url}/api/requests/${q.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  return r;
}
function listen(m: Manager, a: { app: string; token: string }) {
  const got: number[] = [];
  const gaps: string[] = [];
  const c = new AccountsClient({ url: m.url, app: a.app, token: a.token, onEvents: (_acc, evs) => got.push(...evs.filter((e) => e.t === 'note').map((e) => e.n as number)), onGap: (acc) => gaps.push(acc) });
  return { c, got, gaps };
}

test('a restart hands over: events held for an absent app, and those emitted while no manager ran, reach it from the next manager, all in order', async () => {
  // A note every 20 ms, before, during and after the restart.
  const { dir, m1, id, port } = await world('handover', { config: { tick: 20 } });
  const a = await app(m1);
  await Bun.sleep(300);
  await m1.stop({ leaveExtractors: true });
  const h = JSON.parse(readFileSync(join(dir, 'handover.json'), 'utf8'));
  expect(h).toMatchObject({ v: 1, writer: 'dither-accounts', holding: [id] });
  expect(h.held[a.app].frames.length).toBeGreaterThan(5);
  // No manager for a while: the notes wait in the extractor's link.
  await Bun.sleep(500);
  const m2 = await manager(dir, { port });
  expect(existsSync(join(dir, 'handover.json'))).toBe(false);
  await until(() => online(m2, id), 15_000, 'adopted and back');
  await Bun.sleep(300);
  const l = listen(m2, a);
  await until(() => l.got.length > 50, 10_000, 'the notes');
  // Every note from the first on, none missing, none twice, in order.
  expect(l.got).toEqual(l.got.map((_, i) => i));
  expect(l.gaps).toEqual([]);
  l.c.close();
  await m2.stop();
});

test('a handover too old, or a half-written one, is set aside: apps hear of a gap instead', async () => {
  const { dir, m1, id, port } = await world('stale');
  const a = await app(m1);
  await m1.stop({ leaveExtractors: true });
  const file = join(dir, 'handover.json');
  const h = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...h, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  writeFileSync(`${file}.tmp`, '{"half');
  const m2 = await manager(dir, { port });
  expect(existsSync(file)).toBe(false);
  expect(existsSync(`${file}.tmp`)).toBe(false);
  await until(() => online(m2, id), 15_000, 'adopted and back');
  const l = listen(m2, a);
  await until(() => l.gaps.length === 1, 5000, 'a gap');
  l.c.close();
  await m2.stop();
});

test('without a handover (a manager that crashed), apps hear of a gap for each adopted account', async () => {
  const { dir, m1, id, port } = await world('nohandover');
  const a = await app(m1);
  await m1.stop({ leaveExtractors: true });
  rmSync(join(dir, 'handover.json'));
  const m2 = await manager(dir, { port });
  await until(() => online(m2, id), 15_000, 'adopted and back');
  const l = listen(m2, a);
  await until(() => l.gaps.length === 1, 5000, 'a gap');
  expect(l.gaps).toEqual([id]);
  l.c.close();
  await m2.stop();
});
