/**
 * The manager's connection to an extractor, replaced under calls (supervisor.ts on packages/spec handover.ts): the
 * shared cut-mid-call check (cut-mid-call.ts) against a real manager and the fake extractor, whose `mark` op counts
 * each run of a call in its account directory (across processes) and answers after a while, so calls are on it when
 * the cut comes. Three cuts: its socket drops while its process runs, the page's Restart, a restart for changed code.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { newToken, type Store } from '../packages/manager/src/db.ts';
import { procsWithEnv } from '../packages/manager/src/procs.ts';
import fakeManifest from '../extractors/fake/manifest.ts';
import { cutMidCall, type CutTransport } from './cut-mid-call.ts';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
const managers: Manager[] = [];

afterAll(async () => {
  for (const m of managers) await m.stop().catch(() => {});
  for (const d of dirs) {
    for (const p of procsWithEnv((env) => env.DITHER_MANAGER_DATA?.startsWith(d) === true)) {
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
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const kinds = () => new Map([['fake', kindOf(fakeManifest, join(ROOT, 'extractors/fake'))]]);

async function manager(dir: string, o: Partial<Parameters<typeof createManager>[0]> = {}) {
  const m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: kinds(), launch: 'detached', fingerprint: () => 'v1', restartPauseMs: 50, ...o });
  managers.push(m);
  return m;
}

function insertAccount(store: Store, dir: string, id: string) {
  const accDir = join(dir, 'accounts', id);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  store.run(
    'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
    id,
    'fake',
    'Fake',
    '{}',
    newToken(),
    accDir,
    now,
    now,
  );
  return accDir;
}

async function world(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `dacc-swap-${name}-`));
  dirs.push(dir);
  const m = await manager(dir);
  const id = `acc-swap-${name}`;
  const accDir = insertAccount(m.store, dir, id);
  m.sup.start(id);
  await until(() => m.sup.state(id).online, 15_000, 'online');
  return { dir, m, id, accDir };
}

/** How long the fake holds each call: long enough that the ones sent before the cut are on it when it comes. */
const HOLD_MS = 500;

function runsIn(accDir: string) {
  const all = () => (existsSync(join(accDir, 'runs.log')) ? readFileSync(join(accDir, 'runs.log'), 'utf8').split('\n').filter(Boolean).map(Number) : []);
  return { all, of: (i: number) => all().filter((x) => x === i).length };
}

/** The manager's words, typed: never sent ('retry'), or sent and lost with its extractor ('offline', "lost while it had"). */
const outcome = (e: unknown) => {
  const x = e as { code?: string; message?: string };
  if (x?.code === 'retry') return 'retry';
  if (x?.code === 'offline' && /was lost while it had this call/.test(String(x.message))) return 'unsure';
  return null;
};

function transport(m: () => Manager, id: string, accDir: string, cut: () => Promise<void>): CutTransport {
  const runs = runsIn(accDir);
  return {
    call: (i, repeatable) => m().sup.command(id, { t: 'mark', i, ms: HOLD_MS }, 30_000, { repeatable }),
    cut,
    runs: runs.of,
    outcome,
  };
}

const pidOf = async (m: Manager, id: string) => ((await m.sup.command(id, { t: 'pid' })) as { pid: number }).pid;

test('its socket drops while its process runs: calls wait for the link to come back, and each is answered once', async () => {
  const { m, id, accDir } = await world('drop');
  const pid = await pidOf(m, id);
  const runs = runsIn(accDir);
  const r = await cutMidCall(
    transport(
      () => m,
      id,
      accDir,
      async () => {
        // The manager's end of the socket closes (as a broken frame would): its link reconnects in 250 ms.
        const ws = (m.sup as any).running.get(id).ws;
        ws.close(1011, 'cut by the test');
        await until(() => !!(m.sup as any).running.get(id).ws && (m.sup as any).running.get(id).ws !== ws, 10_000, 'the link back');
      },
    ),
    { calls: 20, cutAfter: 10, settleMs: 20_000, inFlight: () => until(() => runs.all().length >= 10, 5000, 'ten calls on the extractor') },
  );
  expect(r.problems).toEqual([]);
  // The ten it had answered on the new socket; the ten sent during the drop waited for it.
  expect(r).toMatchObject({ answered: 20, retry: 0, unsure: 0 });
  expect(await pidOf(m, id)).toBe(pid);
}, 40_000);

test("the page's Restart: calls wait for the new process; of those the old one had, reads run again there and writes fail 'offline'", async () => {
  const { m, id, accDir } = await world('restart');
  const pid = await pidOf(m, id);
  const runs = runsIn(accDir);
  const r = await cutMidCall(
    transport(
      () => m,
      id,
      accDir,
      async () => {
        await m.sup.restart(id);
        await until(() => m.sup.state(id).online, 15_000, 'online again');
      },
    ),
    { calls: 20, cutAfter: 10, settleMs: 30_000, inFlight: () => until(() => runs.all().length >= 10, 5000, 'ten calls on the extractor') },
  );
  expect(r.problems).toEqual([]);
  // Calls 0..9 were on the old one: the five reads (even) ran again on the new one, the five writes may have run.
  expect(r).toMatchObject({ answered: 15, retry: 0, unsure: 5 });
  expect(await pidOf(m, id)).not.toBe(pid);
}, 60_000);

test('a restart for changed code: the old extractor answers what it has, calls meanwhile wait for the new one', async () => {
  const { dir, m: m1, id, accDir } = await world('roll');
  const pid = await pidOf(m1, id);
  const port = m1.http.server.port!;
  await m1.stop({ leaveExtractors: true });
  // A long pause before the restart's turn: the test lets it go at the cut.
  const m2 = await manager(dir, { port, fingerprint: () => 'v2', restartPauseMs: 60_000 });
  await until(() => m2.sup.state(id).online, 15_000, 'the adopted extractor back');
  await until(() => ((m2.sup as any).pauses as Set<unknown>).size > 0, 5000, 'the restart waiting its turn');
  const runs = runsIn(accDir);
  const before = runs.all().length;
  let restartMs = 0;
  const r = await cutMidCall(
    transport(
      () => m2,
      id,
      accDir,
      async () => {
        const pauses = (m2.sup as any).pauses as Set<{ timer: Timer; done: () => void }>;
        const t0 = Date.now();
        for (const p of pauses) {
          clearTimeout(p.timer);
          pauses.delete(p);
          p.done();
        }
        await until(async () => m2.sup.state(id).online && !m2.sup.details(id).adopted, 40_000, 'the restart');
        restartMs = Date.now() - t0;
      },
    ),
    // Sent a while apart, so the ones after the cut come during the drain, the stop and the start.
    {
      calls: 20,
      cutAfter: 10,
      spacingMs: 100,
      settleMs: 50_000,
      inFlight: () => until(() => runs.all().length - before >= 10, 5000, 'ten calls on the extractor'),
      // The restart's turn comes a moment after its pause is let go: from then on, calls wait for the new process.
      begun: () => until(() => (m2.sup as any).lines.get(id).state === 'opening', 5000, 'the restart begun'),
    },
  );
  expect(r.problems).toEqual([]);
  expect(r).toMatchObject({ answered: 20, retry: 0, unsure: 0 });
  const next = await pidOf(m2, id);
  expect(next).not.toBe(pid);
  // Those on the old process when the cut came were answered there; every one after it waited for the new one, so
  // the drain was over once the old one's calls were (it did not run to RESTART_DRAIN_MS, kept busy by new calls).
  const by = r.answers.map((a) => (a as { pid: number }).pid);
  expect(by.slice(10)).toEqual(Array(10).fill(next));
  expect(by.slice(0, 10)).toEqual(Array(10).fill(pid));
  expect(restartMs).toBeLessThan(15_000);
  await m2.stop();
}, 60_000);
