/**
 * Accounts that sleep (docs/supervisor.md "Sleeping"): an idle account of a kind that may sleep has its extractor
 * stopped and says `asleep`, not broken; a call wakes it and is answered; it never sleeps during a call, while its
 * extractor says it is busy or while its live view is open; it wakes by itself for its next run and for a keep-alive;
 * it stays asleep through the manager's restart; an adopted extractor sleeps too; Stop, Start, Restart, disable and
 * Stay awake keep their meaning. Real extractor processes (extractors/fake), launched `detached`, on temp data dirs.
 */
import type { UnixSocketListener } from 'bun';
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager, type SleepOpts } from '@dither-accounts/manager';
import { newToken, Store } from '../packages/manager/src/db.ts';
import { procAlive, procStat } from '../packages/manager/src/procs.ts';
import fakeManifest from '../extractors/fake/manifest.ts';

// Real extractor processes start and stop several times in a test; under load one start can take seconds. A test's
// limit is longer than the waits inside it, so one that hangs fails saying what it waited for.
setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, '..');
// Account ids are machine-wide (acquireLock): this file may run in several checkouts at once.
const RUN = process.pid.toString(36);
const dirs: string[] = [];
const managers: Manager[] = [];
const pids: number[] = [];
const clients: AccountsClient[] = [];
const listeners: UnixSocketListener<undefined>[] = [];

afterAll(async () => {
  for (const c of clients) c.close();
  for (const m of managers) await m.stop().catch(() => {});
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  for (const l of listeners) l.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const until = async (f: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const IDLE = 300;
const fakeDir = join(ROOT, 'extractors/fake');
// `fake` never sleeps; `sleepy` may; `keeper` may, with a keep-alive.
const kinds = () =>
  new Map([
    ['fake', kindOf(fakeManifest, fakeDir)],
    ['sleepy', kindOf({ ...fakeManifest, kind: 'sleepy', sleep: { idleMinutes: 20 } }, fakeDir)],
    ['keeper', kindOf({ ...fakeManifest, kind: 'keeper', sleep: { idleMinutes: 20, keepAliveHours: 6 } }, fakeDir)],
  ]);

/** Sleeping as tests run it: idle after IDLE ms, looked at every 25 ms, no lead before a run, no shortest sleep. */
const fast = (o: SleepOpts = {}): SleepOpts => ({ idleMs: IDLE, checkMs: 25, leadMs: 0, minMs: 0, keepAliveMs: 1500, ...o });

async function manager(dir: string, o: { port?: number; sleep?: SleepOpts } = {}) {
  const m = await createManager({ openPage: true, dataDir: dir, port: o.port ?? 0, kinds: kinds(), launch: 'detached', fingerprint: () => 'v1', sleep: o.sleep ?? fast() });
  managers.push(m);
  return m;
}

function world(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `dacc-sleep-${name}-`));
  dirs.push(dir);
  return dir;
}

function addAccount(m: Manager, dir: string, id: string, kind: string, config: Record<string, unknown> = {}) {
  const accDir = join(dir, 'accounts', id);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  m.store.run(
    'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
    id,
    kind,
    'Sleeper',
    JSON.stringify({ sleepy: true, ...config }),
    newToken(),
    accDir,
    now,
    now,
  );
  return accDir;
}

const st = (m: Manager, id: string) => m.sup.state(id);
const pidOf = async (m: Manager, id: string) => {
  const pid = ((await m.sup.command(id, { t: 'pid' })) as { pid: number }).pid;
  pids.push(pid);
  return pid;
};
/** An account's extractor up, by its pid and start time (a pid the kernel gives another process is not it). */
const proc = (pid: number) => ({ pid, start: procStat(pid)!.start });
const gone = (p: { pid: number; start: string }) => !procAlive(p.pid, p.start);
const log = (accDir: string) => readFileSync(join(accDir, 'adapter.log'), 'utf8');
const api = (m: Manager, path: string, init: RequestInit = {}) => fetch(`${m.url}${path}`, init).then((r) => r.json() as Promise<any>);

async function started(m: Manager, id: string) {
  m.sup.start(id);
  await until(() => st(m, id).online, 15_000, 'the extractor online');
  return proc(await pidOf(m, id));
}
async function asleep(m: Manager, id: string, what = 'it asleep') {
  await until(() => st(m, id).asleep, 15_000, what);
}

test('an idle account of a kind that may sleep falls asleep: its extractor stops, and it says asleep, not broken', async () => {
  const dir = world('idle');
  const m = await manager(dir);
  const id = `acc-idle-${RUN}`;
  const plain = `acc-plain-${RUN}`;
  const accDir = addAccount(m, dir, id, 'sleepy');
  addAccount(m, dir, plain, 'fake');
  const p = await started(m, id);
  const q = await started(m, plain);
  await asleep(m, id);
  await until(() => gone(p), 15_000, 'its extractor to end');
  expect(st(m, id)).toEqual({ running: false, online: false, error: null, asleep: true });
  expect(log(accDir)).toMatch(/idle for \d+ min: asleep until the next call/);
  // Kept in the registry, for the next manager.
  expect(m.store.all('SELECT account, wake_at FROM asleep')).toEqual([{ account: id, wake_at: null }]);
  // What it said of itself stays (it slept only while online and needing nothing), but not its live view.
  expect(m.router.lastStatus(id)?.status).toBe('online');
  // The page: asleep, until a call.
  const a = (await api(m, '/api/state')).accounts.find((x: any) => x.id === id);
  expect(a).toMatchObject({ enabled: true, running: false, online: false, asleep: true, error: null, sleep: { asleep: true, wakeAt: null, idleMinutes: IDLE / 60_000 } });
  // Nothing tells you about it: it is not stopped, nor in trouble.
  expect(m.store.all('SELECT id FROM notice WHERE unread = 1')).toEqual([]);
  // A kind that does not sleep stays as it was, the same process, all along.
  expect(st(m, plain)).toMatchObject({ online: true, asleep: false });
  expect(await pidOf(m, plain)).toBe(q.pid);
  expect((await api(m, '/api/state')).accounts.find((x: any) => x.id === plain).sleep).toBeNull();
});

test("a call to a sleeping account wakes it and is answered; an app's list says asleep meanwhile; idle again, it sleeps again", async () => {
  const dir = world('call');
  const m = await manager(dir);
  const id = `acc-call-${RUN}`;
  const accDir = addAccount(m, dir, id, 'sleepy');
  const reg = await register(m.url, { name: 'echoer', requests: [{ interface: 'test.echo', level: 'read' }] });
  const state = await api(m, '/api/state');
  for (const app of state.apps) for (const r of app.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  const c = new AccountsClient({ url: m.url, app: reg.app, token: reg.token });
  clients.push(c);
  const p = await started(m, id);
  await asleep(m, id);
  await until(() => gone(p), 15_000, 'its extractor to end');
  // The app sees it asleep: not running, not online, no error. Nothing in that says broken.
  await until(() => !!c.accounts?.find((a) => a.id === id)?.asleep, 5000, "asleep in the app's list");
  expect(c.accounts.find((a) => a.id === id)).toMatchObject({ running: false, online: false, asleep: true, error: null });
  // A call wakes it, waits for it and is answered.
  expect(await c.call(testEcho, id, 'echo', { text: 'hi' })).toEqual({ text: 'hi' });
  expect(st(m, id)).toMatchObject({ online: true, asleep: false });
  expect(m.store.all('SELECT account FROM asleep')).toEqual([]);
  expect(log(accDir)).toContain('waking: a call (echo)');
  // Its extractor is told it was woken, and why (a kind skips what only a start needs, such as a sign-in).
  expect(log(accDir)).toContain('fake extractor up {"woke":"a call (echo)"}');
  expect(log(accDir).split('fake extractor up').length - 1).toBe(2);
  const p2 = proc(await pidOf(m, id));
  expect(p2.pid).not.toBe(p.pid);
  // Idle again (its idle time counts from that call's answer): asleep again.
  await asleep(m, id, 'it asleep again');
  await until(() => gone(p2), 15_000, 'its second extractor to end');
});

test('it does not fall asleep during a call, nor while its extractor says it is busy, nor while its live view is open', async () => {
  const dir = world('awake');
  const vncSocket = join(dir, 'vnc.sock');
  listeners.push(Bun.listen({ unix: vncSocket, socket: { open: (s) => void s.write('RFB 003.008\n'), data: () => {} } }));
  const m = await manager(dir);
  const id = `acc-awake-${RUN}`;
  addAccount(m, dir, id, 'sleepy', { vncSocket });
  const p = await started(m, id);
  const info = async () => (await api(m, '/api/state')).accounts.find((x: any) => x.id === id).sleep;
  let slept = false;
  const watch = setInterval(() => (slept ||= st(m, id).asleep), 10);
  try {
    // A call longer than its idle time: answered by the same process, which stays up.
    expect(await m.sup.command(id, { t: 'slow', ms: IDLE * 4 })).toEqual({ slept: IDLE * 4 });
    expect(await pidOf(m, id)).toBe(p.pid);
    // Its extractor says it is busy (a pull): it stays up while it says so.
    await m.sup.command(id, { t: 'busy', busy: 'a pull (daily)' });
    await until(async () => (await info()).awake === 'a pull (daily)', 5000, 'the page to say what keeps it awake');
    await Bun.sleep(IDLE * 4);
    // Its live view open on the page: it stays up while someone watches, busy or not.
    const ws = new WebSocket(`${m.url.replace(/^http/, 'ws')}/api/liveview/${id}`, { headers: { origin: m.url } } as any);
    await new Promise<void>((done, fail) => ((ws.onopen = () => done()), (ws.onerror = () => fail(new Error('the live view refused')))));
    await until(async () => (await info()).awake === 'its live view is open', 5000, 'the live view to hold it');
    await m.sup.command(id, { t: 'busy', busy: null });
    await Bun.sleep(IDLE * 4);
    expect(slept).toBe(false);
    expect(await pidOf(m, id)).toBe(p.pid);
    // Closed: idle from then, and asleep.
    ws.close();
  } finally {
    clearInterval(watch);
  }
  await asleep(m, id);
  await until(() => gone(p), 15_000, 'its extractor to end');
  // Its live view went with it: none is offered while it sleeps.
  expect(m.router.liveView(id)).toBeNull();
});

test('a sleeping account wakes by itself for its next run, and for a keep-alive', async () => {
  const dir = world('wake');
  const m = await manager(dir);
  const run = `acc-run-${RUN}`;
  const keep = `acc-keep-${RUN}`;
  const runDir = addAccount(m, dir, run, 'sleepy', { wakeInMs: 3000 });
  const keepDir = addAccount(m, dir, keep, 'keeper');
  const t0 = Date.now();
  const p = await started(m, run);
  const k = await started(m, keep);
  await asleep(m, run, 'the first asleep');
  await asleep(m, keep, 'the second asleep');
  const byState = (id: string) => api(m, '/api/state').then((s) => s.accounts.find((x: any) => x.id === id).sleep);
  // Until its own next run (its extractor said when: 3 s after it connected)…
  const s1 = await byState(run);
  expect(s1).toMatchObject({ asleep: true, wakeFor: 'its next scheduled run' });
  expect(s1.wakeAt).toBeGreaterThanOrEqual(t0 + 3000);
  expect(s1.wakeAt).toBeLessThanOrEqual(Date.now() + 3000);
  // …and the other until its keep-alive (1.5 s after it fell asleep, here).
  expect(await byState(keep)).toMatchObject({ asleep: true, wakeFor: 'a keep-alive' });
  // Each comes back by itself, no call made: woken, and a new process up.
  await until(() => /waking: its next scheduled run[^]*fake extractor up/.test(log(runDir)), 15_000, 'the first awake for its run');
  expect(Date.now()).toBeGreaterThanOrEqual(s1.wakeAt);
  await until(() => /waking: a keep-alive[^]*fake extractor up/.test(log(keepDir)), 15_000, 'the second awake for its keep-alive');
  expect(gone(p) && gone(k)).toBe(true);
});

test("a sleeping account stays asleep through the manager's restart, its wake-up time too; a call wakes it on the next manager", async () => {
  const dir = world('restart');
  const m1 = await manager(dir);
  const id = `acc-restart-${RUN}`;
  const timed = `acc-timed-${RUN}`;
  const accDir = addAccount(m1, dir, id, 'sleepy');
  const timedDir = addAccount(m1, dir, timed, 'sleepy', { wakeInMs: 8000 });
  const p = await started(m1, id);
  const t = await started(m1, timed);
  await asleep(m1, id);
  await asleep(m1, timed, 'the timed one asleep');
  await until(() => gone(p) && gone(t), 15_000, 'both extractors to end');
  const wakeAt = (m1.store.one<{ wake_at: number }>('SELECT wake_at FROM asleep WHERE account = ?', timed))!.wake_at;
  const port = m1.http.server.port!;
  await m1.stop({ leaveExtractors: true });

  const m2 = await manager(dir, { port });
  // Nothing started: both still asleep, the timed one until the same time. (Read before anything runs on this
  // manager: its first look at who wakes comes after a timer.)
  expect(st(m2, id)).toEqual({ running: false, online: false, error: null, asleep: true });
  expect(m2.sup.details(id).pid).toBeNull();
  expect(m2.store.one<{ wake_at: number }>('SELECT wake_at FROM asleep WHERE account = ?', timed)!.wake_at).toBe(wakeAt);
  const starts = (d: string) => log(d).split('dither-accounts starting').length - 1;
  expect(starts(accDir)).toBe(1);
  // A call wakes the first on this manager.
  expect(await m2.sup.command(id, { t: 'echo', text: 'back' })).toEqual({ text: 'back' });
  expect(starts(accDir)).toBe(2);
  // The second wakes by itself when the manager before would have woken it.
  await until(() => /waking: its next scheduled run[^]*fake extractor up/.test(log(timedDir)), 20_000, 'the timed one awake for its run');
  expect(Date.now()).toBeGreaterThanOrEqual(wakeAt);
});

test('an extractor adopted from the manager before falls asleep when idle, and wakes for a call', async () => {
  const dir = world('adopt');
  // The first manager lets nothing sleep for a minute: it is awake when the manager goes.
  const m1 = await manager(dir, { sleep: fast({ idleMs: 60_000 }) });
  const id = `acc-adopt-${RUN}`;
  addAccount(m1, dir, id, 'sleepy');
  const p = await started(m1, id);
  const port = m1.http.server.port!;
  await m1.stop({ leaveExtractors: true });
  expect(gone(p)).toBe(false);

  const m2 = await manager(dir, { port });
  await until(() => m2.sup.details(id).adopted && st(m2, id).online, 15_000, 'it adopted and back online');
  expect(m2.sup.details(id).pid).toBe(p.pid);
  // Its link said again what it said on the first manager (how it is, and that it may sleep): it sleeps here.
  await asleep(m2, id);
  await until(() => gone(p), 15_000, 'the adopted extractor to end');
  expect(await m2.sup.command(id, { t: 'echo', text: 'up' })).toEqual({ text: 'up' });
  expect(await pidOf(m2, id)).not.toBe(p.pid);
});

test('an extractor still running for an account the registry says is asleep (the manager went while it fell asleep) is adopted, not left', async () => {
  const dir = world('both');
  const m1 = await manager(dir, { sleep: fast({ idleMs: 60_000 }) });
  const id = `acc-both-${RUN}`;
  addAccount(m1, dir, id, 'sleepy');
  const p = await started(m1, id);
  const port = m1.http.server.port!;
  await m1.stop({ leaveExtractors: true });
  // As a manager that went between writing it asleep and stopping its extractor would leave it.
  const s = new Store(join(dir, 'accounts.sqlite'));
  s.run('INSERT INTO asleep (account, since, wake_at, wake_for) VALUES (?, ?, NULL, NULL)', id, Date.now());
  s.db.close();

  const m2 = await manager(dir, { port, sleep: fast({ idleMs: 60_000 }) });
  await until(() => st(m2, id).online, 15_000, 'it adopted and online');
  expect(m2.sup.details(id)).toMatchObject({ pid: p.pid, adopted: true });
  expect(st(m2, id).asleep).toBe(false);
  expect(m2.store.all('SELECT account FROM asleep')).toEqual([]);
});

test('Stop, Start, Restart, Wake, disable and Stay awake keep their meaning for a sleeping account', async () => {
  const dir = world('controls');
  const m = await manager(dir);
  const id = `acc-controls-${RUN}`;
  const plain = `acc-controls-plain-${RUN}`;
  addAccount(m, dir, plain, 'fake');
  await started(m, (addAccount(m, dir, id, 'sleepy'), id));
  await asleep(m, id);
  const post = (path: string) => fetch(`${m.url}/api/accounts/${id}${path}`, { method: 'POST', body: '{}' });
  const patch = (body: unknown) => fetch(`${m.url}/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  // Restart wakes it (it stops nothing: nothing runs), and it sleeps again when idle.
  expect((await post('/restart')).status).toBe(200);
  await until(() => st(m, id).online, 15_000, 'online after Restart');
  await asleep(m, id, 'asleep after Restart');
  // The page's Wake: the same as a call would. Not for one that is not asleep.
  expect((await post('/wake')).status).toBe(200);
  await until(() => st(m, id).online, 15_000, 'online after Wake');
  await asleep(m, id, 'asleep after Wake');
  expect((await fetch(`${m.url}/api/accounts/${plain}/wake`, { method: 'POST', body: '{}' })).status).toBe(409);

  // Stop: stopped, not asleep; a call fails 'offline' and does not start it.
  await m.sup.stop(id);
  expect(st(m, id)).toMatchObject({ running: false, asleep: false });
  expect(m.store.all('SELECT account FROM asleep')).toEqual([]);
  expect(((await m.sup.command(id, { t: 'echo', text: 'x' }).catch((e) => e)) as { code: string }).code).toBe('offline');
  expect(st(m, id).running).toBe(false);
  // Start: awake, and asleep when idle.
  m.sup.start(id);
  await until(() => st(m, id).online, 15_000, 'online after Start');
  await asleep(m, id, 'asleep after Start');

  // Stay awake, set while it sleeps: it wakes, and its extractor is not restarted for it.
  expect((await patch({ settings: { stayAwake: true } })).status).toBe(200);
  await until(() => st(m, id).online, 15_000, 'online after Stay awake');
  const p = proc(await pidOf(m, id));
  await Bun.sleep(IDLE * 4);
  expect(st(m, id)).toMatchObject({ online: true, asleep: false });
  expect(await pidOf(m, id)).toBe(p.pid);
  expect((await api(m, '/api/state')).accounts.find((x: any) => x.id === id).sleep).toBeNull();
  // Off again: the same process, which now sleeps when idle, counted from then.
  const off = Date.now();
  expect((await patch({ settings: { stayAwake: false } })).status).toBe(200);
  await asleep(m, id, 'asleep after Stay awake off');
  expect(Date.now() - off).toBeGreaterThanOrEqual(IDLE);
  expect(gone(p)).toBe(true);

  // Disabled while asleep: disabled, not asleep, and enabling it starts it.
  expect((await patch({ enabled: false })).status).toBe(200);
  expect(st(m, id).asleep).toBe(false);
  expect(m.store.all('SELECT account FROM asleep')).toEqual([]);
  expect((await patch({ enabled: true })).status).toBe(200);
  await until(() => st(m, id).online, 15_000, 'online after enabling');
});
