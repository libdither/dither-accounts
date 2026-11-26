/**
 * The live view's server kept running (src/vnc.ts KeptServer), with stand-in processes: a try whose `after` step fails
 * ends the process it started before the next try, so there is never more than one; and a server that starts and dies
 * soon after is started again ever more slowly, the wait going back to the first only once one has stayed up.
 */
import { expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { endProcess, KeptServer } from '../src/vnc.ts';

/** A process that exits when told (die) or killed, a moment later as a real one does. */
class FakeProc {
  exitCode: number | null = null;
  signalCode: string | null = null;
  private done!: (code: number) => void;
  readonly exited = new Promise<number>((r) => (this.done = r));
  get alive() {
    return this.exitCode === null && this.signalCode === null;
  }
  kill(sig: string = 'SIGTERM') {
    if (!this.alive) return;
    setTimeout(() => {
      if (!this.alive) return;
      this.signalCode = sig;
      this.done(128);
    }, 5);
  }
  die(code = 1) {
    if (!this.alive) return;
    this.exitCode = code;
    this.done(code);
  }
}

type Health = { ok: true } | { ok: false; note: string };
/** A KeptServer over fake processes, and the next health report a test waits for. */
function kept(o: { after?: (n: number) => Promise<void>; stableMs?: number }) {
  const procs: FakeProc[] = [];
  let mostAlive = 0;
  const waiters: { ok: (h: Health) => boolean; resolve: () => void }[] = [];
  const ks = new KeptServer({
    name: 'fakevnc',
    start: async () => {
      // Never a second one while another runs.
      mostAlive = Math.max(mostAlive, procs.filter((p) => p.alive).length + 1);
      const p = new FakeProc();
      procs.push(p);
      return p as unknown as Subprocess;
    },
    after: o.after ? () => o.after!(procs.length) : undefined,
    log: () => {},
    onHealth: (h) => {
      for (const w of waiters.splice(0)) (w.ok(h) ? w.resolve() : waiters.push(w));
    },
    firstWaitMs: 5,
    maxWaitMs: 1000,
    stableMs: o.stableMs ?? 3_600_000,
  });
  const health = (ok: (h: Health) => boolean) => new Promise<void>((resolve) => waiters.push({ ok, resolve }));
  return { ks, procs, health, mostAlive: () => mostAlive };
}

test("a restart whose `after` fails ends the server it started, and waits for it to go, before the next try", async () => {
  // The first start (the screen's) has no `after`; restarts 1-3 fail it, the 4th passes.
  const k = kept({ after: async (n) => (n <= 4 ? Promise.reject(new Error(`the input client did not connect (${n})`)) : undefined) });
  await k.ks.start();
  const back = k.health((h) => h.ok);
  k.procs[0]!.die();
  await back;
  expect(k.procs.length).toBe(5);
  // Each failed try's server ended; only the last one runs, and there were never two at once.
  expect(k.procs.map((p) => p.alive)).toEqual([false, false, false, false, true]);
  expect(k.procs.slice(1, 4).every((p) => p.signalCode === 'SIGTERM')).toBe(true);
  expect(k.mostAlive()).toBe(1);
  expect(k.ks.health()).toEqual({ ok: true });
  k.ks.stop();
});

test('a server that starts and dies soon after is started again more slowly each time; one that stayed up starts over', async () => {
  const k = kept({});
  await k.ks.start();
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    // The wait its death now would cost: the first, then doubled after each try, never reset by a start alone.
    seen.push(k.ks.nextWaitMs);
    const back = k.health((h) => h.ok);
    k.procs.at(-1)!.die();
    await back;
  }
  expect(seen).toEqual([5, 10, 20, 40, 80]);
  k.ks.stop();

  // Up for longer than stableMs (0 here: any time at all): the wait goes back to the first.
  const s = kept({ stableMs: 0 });
  await s.ks.start();
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    waits.push(s.ks.nextWaitMs);
    const back = s.health((h) => h.ok);
    s.procs.at(-1)!.die();
    await back;
  }
  expect(waits).toEqual([5, 5, 5]);
  s.ks.stop();
});

test('ending a process: SIGTERM, then SIGKILL when it is still there', async () => {
  const stubborn = new FakeProc();
  const sigs: string[] = [];
  stubborn.kill = (sig = 'SIGTERM') => {
    sigs.push(sig);
    if (sig === 'SIGKILL') FakeProc.prototype.kill.call(stubborn, sig);
  };
  await endProcess(stubborn as unknown as Subprocess, 20);
  expect(sigs).toEqual(['SIGTERM', 'SIGKILL']);
  expect(stubborn.signalCode).toBe('SIGKILL');
});
