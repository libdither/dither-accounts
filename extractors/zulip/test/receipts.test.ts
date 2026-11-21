/**
 * The read-receipt watcher (src/receipts.ts) on a clock of its own: when it asks, who it says read, when it stops,
 * and the budget.
 */
import { afterEach, expect, test } from 'bun:test';
import { Receipts } from '../src/receipts.ts';

let now = 1_000_000;
let readers = new Map<number, number[]>();
let asks: number[] = [];
let said: [string, number, number][] = [];
let on = true;
const watchers: Receipts[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
  now = 1_000_000;
  readers = new Map();
  asks = [];
  said = [];
  on = true;
});

function make(opts: { perMinute?: number } = {}) {
  const r = new Receipts(
    {
      enabled: () => on,
      ask: async (id) => {
        asks.push(id);
        return readers.get(id) ?? [];
      },
      read: (conv, id, who) => said.push([conv, id, who]),
      log: () => {},
    },
    { steps: [30_000, 120_000], now: () => now, tickMs: 3_600_000, ...opts },
  );
  watchers.push(r);
  return r;
}

test('your message is asked about at each step after it was sent, and let go once everyone read it', async () => {
  const r = make();
  r.sent('dm/8,9,10', 50, [9, 10], now);
  await r.tick();
  expect(asks).toEqual([]);
  now += 30_000;
  readers.set(50, [9]);
  await r.tick();
  expect(said).toEqual([['dm/8,9,10', 50, 9]]);
  // Not again before the next step, and Ann not said twice.
  now += 1_000;
  await r.tick();
  expect(asks).toEqual([50]);
  now += 90_000;
  readers.set(50, [9, 10, 8]);
  await r.tick();
  expect(said).toEqual([
    ['dm/8,9,10', 50, 9],
    ['dm/8,9,10', 50, 10],
  ]);
  expect(r.size).toBe(0);
});

test('after the last step only someone writing or typing there asks again', async () => {
  const r = make();
  r.sent('dm/8,9', 51, [9], now);
  now += 200_000;
  await r.tick();
  expect(asks).toEqual([51]);
  now += 3_600_000;
  await r.tick();
  expect(asks).toEqual([51]);
  r.nudge('dm/8,9', 9);
  now += 3_000;
  readers.set(51, [9]);
  await r.tick();
  expect(asks).toEqual([51, 51]);
  expect(said).toEqual([['dm/8,9', 51, 9]]);
});

test('a nudge from someone not in the DM, or who already read it, asks nothing; nudges are spaced', async () => {
  const r = make();
  r.sent('dm/8,9,10', 52, [9, 10], now);
  now += 30_000;
  readers.set(52, [9]);
  await r.tick();
  expect(asks).toEqual([52]);
  r.nudge('dm/8,9,10', 9);
  r.nudge('dm/8,9,10', 11);
  now += 5_000;
  await r.tick();
  expect(asks).toEqual([52]);
  r.nudge('dm/8,9,10', 10);
  now += 5_000;
  await r.tick();
  expect(asks).toEqual([52, 52]);
  // A second nudge within 20 s waits for the next step instead.
  r.nudge('dm/8,9,10', 10);
  now += 5_000;
  await r.tick();
  expect(asks).toEqual([52, 52]);
});

test('a newer message of yours in the DM replaces the one watched; an older one does not', async () => {
  const r = make();
  r.sent('dm/8,9', 60, [9], now);
  r.sent('dm/8,9', 59, [9], now);
  r.sent('dm/8,9', 61, [9], now);
  now += 30_000;
  await r.tick();
  expect(asks).toEqual([61]);
  expect(r.size).toBe(1);
  r.forget('dm/8,9', 60);
  expect(r.size).toBe(1);
  r.forget('dm/8,9', 61);
  expect(r.size).toBe(0);
});

test('a message from before start is asked about now, then at the steps still ahead', async () => {
  const r = make();
  r.sent('dm/8,9', 70, [9], now - 60_000, true);
  await r.tick();
  expect(asks).toEqual([70]);
  now += 59_000;
  await r.tick();
  expect(asks).toEqual([70]);
  now += 1_000;
  await r.tick();
  expect(asks).toEqual([70, 70]);
});

test('at most so many asks a minute; the rest wait for the budget', async () => {
  const r = make({ perMinute: 2 });
  for (const id of [80, 81, 82]) r.sent(`dm/8,${id}`, id, [id], now);
  now += 30_000;
  await r.tick();
  expect(asks).toEqual([80, 81]);
  now += 60_000;
  await r.tick();
  expect(asks).toEqual([80, 81, 82]);
});

test('with read receipts off nothing is watched or asked', async () => {
  on = false;
  const r = make();
  r.sent('dm/8,9', 90, [9], now);
  expect(r.size).toBe(0);
  on = true;
  r.sent('dm/8,9', 91, [9], now);
  on = false;
  now += 30_000;
  await r.tick();
  expect(asks).toEqual([]);
});
