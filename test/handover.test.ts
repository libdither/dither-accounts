/**
 * The building block for replacing a channel (packages/spec/src/handover.ts), on an in-memory far side: a side holds
 * each call a while, then answers it, unless it was cut first (then it never answers, as a closed socket or an
 * unloaded page). The shared cut-mid-call check (cut-mid-call.ts) runs against it in both orders a site can use.
 */
import { expect, test } from 'bun:test';
import { Handover, HandoverError, REPEAT_MAX } from '@dither-accounts/spec/handover';
import { cutMidCall, type CutTransport } from './cut-mid-call.ts';

/** A side: answers each call `holdMs` after it got it, if it is still alive then. Counts runs in the shared map. */
class Side {
  alive = true;
  got = 0;
  constructor(
    readonly name: string,
    private runs: Map<number, number>,
    private holdMs: number,
  ) {}
  handle(i: number, signal?: AbortSignal): Promise<{ i: number; side: string }> {
    this.runs.set(i, (this.runs.get(i) ?? 0) + 1);
    this.got++;
    return new Promise((resolve) => {
      setTimeout(() => {
        if (this.alive && !signal?.aborted) resolve({ i, side: this.name });
      }, this.holdMs);
    });
  }
}

const outcome = (e: unknown) => (e instanceof HandoverError ? e.code : null);

function world(holdMs = 40) {
  const runs = new Map<number, number>();
  const h = new Handover<Side>({ name: 'the test channel' });
  let n = 0;
  const side = () => new Side(`side-${++n}`, runs, holdMs);
  h.open(side());
  return { h, runs, side };
}

test('up: a call runs at once on the current side, with its generation', async () => {
  const { h } = world(1);
  expect(h.state).toBe('up');
  expect(h.generation).toBe(1);
  const r = await h.run((s, a) => s.handle(7).then((v) => ({ ...v, gen: a.generation })), { deadline: Date.now() + 1000 });
  expect(r).toEqual({ i: 7, side: 'side-1', gen: 1 });
});

test('opening: calls wait, then run on the new side in the order they came', async () => {
  const { h, side } = world(1);
  h.opening('replaced by the test');
  const order: number[] = [];
  const calls = [1, 2, 3].map((i) =>
    h.run(
      (s) => {
        order.push(i);
        return s.handle(i);
      },
      { deadline: Date.now() + 1000 },
    ),
  );
  await Bun.sleep(20);
  expect(order).toEqual([]);
  expect(h.queued).toBe(3);
  h.open(side());
  expect((await Promise.all(calls)).map((r) => r.side)).toEqual(['side-2', 'side-2', 'side-2']);
  expect(order).toEqual([1, 2, 3]);
  expect(h.generation).toBe(2);
});

test("a call that waits past its own deadline is refused retry, and the side it would have reached never runs it", async () => {
  const { h, runs } = world();
  h.opening('replaced by the test');
  const e = await h.run((s) => s.handle(1), { deadline: Date.now() + 30 }).catch((x) => x);
  expect(e).toBeInstanceOf(HandoverError);
  expect([e.code, e.status]).toEqual(['retry', 503]);
  expect(e.message).toBe('the test channel was not back within this call\'s time (replaced by the test), so it was not sent');
  expect(runs.get(1)).toBeUndefined();
});

test('an opening past its own time takes the channel down: what waits, and what comes after, is refused retry', async () => {
  const { h } = world();
  h.opening('restarting', { ms: 30 });
  const waiting = h.run((s) => s.handle(1), { deadline: Date.now() + 5000 }).catch((x) => x);
  const e = await waiting;
  expect([e.code, e.message]).toEqual(['retry', 'the test channel went down while this call waited for it (restarting, and it was not back within 0 s), so it was not sent']);
  expect(h.state).toBe('down');
  const later = await h.run((s) => s.handle(2), { deadline: Date.now() + 5000 }).catch((x) => x);
  expect(later.code).toBe('retry');
});

test("an opening's `late` may send the waiting calls to the side as it is instead", async () => {
  const { h } = world(1);
  const old = h.side!;
  h.opening('reloading', { ms: 20, late: () => h.open(old) });
  const r = await h.run((s) => s.handle(1), { deadline: Date.now() + 1000 });
  expect(r.side).toBe('side-1');
  expect(h.generation).toBe(2);
});

test('new side first: the old side keeps the calls it has and answers them; drain waits for them', async () => {
  const { h, side, runs } = world(60);
  const old = h.side!;
  const before = [1, 2].map((i) => h.run((s) => s.handle(i), { deadline: Date.now() + 1000 }));
  h.open(side());
  const after = h.run((s) => s.handle(3), { deadline: Date.now() + 1000 });
  expect(h.inFlight).toBe(3);
  expect(await h.drain(1000)).toBe(true);
  expect((await Promise.all(before)).map((r) => r.side)).toEqual(['side-1', 'side-1']);
  expect((await after).side).toBe('side-2');
  expect([...runs.values()]).toEqual([1, 1, 1]);
  expect(old.got).toBe(2);
});

test('drain gives up at its time and says so', async () => {
  const { h } = world(10_000);
  void h.run((s) => s.handle(1), { deadline: Date.now() + 20_000 }).catch(() => {});
  expect(await h.drain(30)).toBe(false);
  h.cut('test over');
});

test(`a cut: a repeatable call runs again on the next side (at most ${REPEAT_MAX}×), the rest are refused unsure; late answers are dropped`, async () => {
  const runs = new Map<number, number>();
  const h = new Handover<Side>({ name: 'the test channel' });
  // The old side answers after the cut (a reply on its way): it must not settle a call that was already settled.
  const old = new Side('old', runs, 30);
  h.open(old);
  const read = h.run((s, a) => s.handle(1, undefined).then((v) => ({ ...v, repeat: a.repeat })), { deadline: Date.now() + 1000, repeatable: true });
  const write = h.run((s) => s.handle(2, undefined), { deadline: Date.now() + 1000 }).catch((x) => x);
  h.opening('the old side ended');
  expect(h.cut('the old side ended')).toBe(2);
  const e = await write;
  expect([e.code, e.status]).toEqual(['unsure', 504]);
  expect(e.message).toBe('the test channel was lost while it had this call (the old side ended): it may or may not have happened, and it was not sent again');
  h.open(new Side('new', runs, 1));
  expect(await read).toEqual({ i: 1, side: 'new', repeat: 1 });
  await Bun.sleep(50); // the old side's late answers come and go
  expect(runs.get(1)).toBe(2);
  expect(runs.get(2)).toBe(1);
});

test('a repeatable call cut a second time is refused unsure: it may be what ends its side', async () => {
  const { h, side } = world(10_000);
  const read = h.run((s) => s.handle(1), { deadline: Date.now() + 5000, repeatable: true }).catch((x) => x);
  h.opening('cut 1');
  h.cut('cut 1');
  h.open(side());
  h.opening('cut 2');
  h.cut('cut 2');
  expect((await read).code).toBe('unsure');
});

test('down refuses at once, typed', async () => {
  const h = new Handover<Side>({ name: 'the test channel' });
  const e = await h.run((s) => s.handle(1), { deadline: Date.now() + 1000 }).catch((x) => x);
  expect([e.code, e.message]).toEqual(['retry', 'the test channel is down (not open yet), so this was not sent']);
});

/** The shared check, on the block itself: `order` is how the site replaces its side. */
function transport(order: 'new-first' | 'old-first-cut') {
  const { h, runs, side } = world(40);
  const t: CutTransport = {
    call: (i, repeatable) => h.run((s, a) => s.handle(i, a.signal), { deadline: Date.now() + 2000, repeatable }),
    async cut() {
      const old = h.side!;
      if (order === 'new-first') {
        // A socket or a port: the new one opens, the old one finishes what it has, then closes.
        h.open(side());
        await h.drain(1000);
        old.alive = false;
        return;
      }
      // A process or a tab: calls wait from now on, the old side is lost with what it had, a new one starts.
      h.opening('the test restarts the side');
      old.alive = false;
      h.cut('the test restarted the side');
      await Bun.sleep(30);
      h.open(side());
    },
    runs: (i) => runs.get(i) ?? 0,
    outcome,
  };
  return t;
}

for (const order of ['new-first', 'old-first-cut'] as const) {
  test(`cut mid-call (${order}): no call is lost or answered twice`, async () => {
    const r = await cutMidCall(transport(order), { calls: 40, cutAfter: 20, settleMs: 5000 });
    expect(r.problems).toEqual([]);
    if (order === 'new-first') expect(r).toMatchObject({ answered: 40, retry: 0, unsure: 0 });
    // The 10 writes the old side had are unsure; its 10 reads, and the 20 sent during the swap, are answered.
    else expect(r).toMatchObject({ answered: 30, retry: 0, unsure: 10 });
  });
}

test('the check catches a channel that loses calls (the old rule: close, then open)', async () => {
  const runs = new Map<number, number>();
  let cur = new Side('a', runs, 40);
  // No handover: a call on the closed side never answers, and the caller waits out its own timeout.
  const t: CutTransport = {
    call: (i) => Promise.race([cur.handle(i), Bun.sleep(300).then(() => Promise.reject(new Error('timed out')))]),
    async cut() {
      cur.alive = false;
      cur = new Side('b', runs, 40);
    },
    runs: (i) => runs.get(i) ?? 0,
    outcome,
  };
  const r = await cutMidCall(t, { calls: 10, cutAfter: 5, settleMs: 2000 });
  expect(r.problems.filter((p) => p.includes('failed untyped ("timed out") (lost)')).length).toBe(5);
});
