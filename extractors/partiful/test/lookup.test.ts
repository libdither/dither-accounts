import { expect, test } from 'bun:test';
import { LOOKUP_AGAIN_MS, LookedUp, lookUp } from '../src/lookup.ts';
import * as M from '../src/map.ts';

const NOW = Date.parse('2030-05-01T12:00:00Z');
const H = 3600_000;
/** Two people Partiful answers for without a name (as a deleted account comes back), one it names. */
const GHOST_1 = 'uGhost000001';
const GHOST_2 = 'uGhost000002';
const ANN = 'uAnnLee00001';

/** A getUsers that answers each id from `names` (no name for the rest) and counts what it was asked. */
function site(names: Record<string, string | null>) {
  const asked: string[][] = [];
  const ask = async (batch: string[]) => {
    asked.push(batch);
    return batch.map((id) => ({ id, ...(names[id] ? { name: names[id] } : {}) }));
  };
  return { asked, ask };
}
const fresh = () => {
  const ctx = M.newCtx();
  ctx.selfId = 'uSelf0000001';
  return ctx;
};

test('people Partiful gives no name are asked once, not again on the next read', async () => {
  const ctx = fresh();
  const memo = new LookedUp();
  const s = site({ [ANN]: 'Ann Lee' });
  const ids = [GHOST_1, GHOST_2, ANN, ctx.selfId!, M.PARTIFUL_ACTOR, 'stream:strm-1'];
  expect(await lookUp(ids, ctx, memo, s.ask, { now: NOW })).toEqual({ asked: 3, named: 1 });
  expect(s.asked).toEqual([[GHOST_1, GHOST_2, ANN]]);
  // The next read, minutes later: nobody asked, and nobody counted as looked up.
  expect(await lookUp(ids, ctx, memo, s.ask, { now: NOW + 7 * 60_000 })).toEqual({ asked: 0, named: 0 });
  expect(s.asked.length).toBe(1);
});

test('what was asked is kept across a restart, and asked again a day later', async () => {
  const s = site({});
  const memo = new LookedUp();
  await lookUp([GHOST_1, GHOST_2], fresh(), memo, s.ask, { now: NOW });
  // The state file round trip, then a new process with a new ctx.
  const kept = JSON.parse(JSON.stringify(memo.toJSON(NOW + H)));
  const again = new LookedUp(kept);
  expect(await lookUp([GHOST_1, GHOST_2], fresh(), again, s.ask, { now: NOW + H })).toEqual({ asked: 0, named: 0 });
  expect(s.asked.length).toBe(1);
  // A day on, they are asked again, and a name Partiful gives now is picked up.
  const named = site({ [GHOST_2]: 'Ben Ortiz' });
  const ctx = fresh();
  expect(await lookUp([GHOST_1, GHOST_2], ctx, again, named.ask, { now: NOW + LOOKUP_AGAIN_MS + 1 })).toEqual({ asked: 2, named: 1 });
  expect(ctx.users.get(GHOST_2)?.name).toBe('Ben Ortiz');
  // Asks older than a day are not kept: they are due anyway.
  expect(Object.keys(again.toJSON(NOW + 3 * LOOKUP_AGAIN_MS))).toEqual([]);
});

test('a lookup that was never sent is tried again at once; one that failed waits a day', async () => {
  const memo = new LookedUp();
  class Unsent extends Error {}
  const unsent = (e: unknown) => e instanceof Unsent;
  await expect(
    lookUp([GHOST_1], fresh(), memo, async () => {
      throw new Unsent('slowed');
    }, { now: NOW, unsent }),
  ).rejects.toThrow('slowed');
  expect(memo.due(GHOST_1, NOW + 1)).toBe(true);
  await expect(
    lookUp([GHOST_1], fresh(), memo, async () => {
      throw new Error('Partiful answered 500: INTERNAL');
    }, { now: NOW, unsent }),
  ).rejects.toThrow('INTERNAL');
  expect(memo.due(GHOST_1, NOW + H)).toBe(false);
});

test('a kept state with junk in it is read safely', () => {
  const memo = new LookedUp({ [GHOST_1]: NOW, 'not an id!': NOW, [GHOST_2]: 'soon' });
  expect(memo.due(GHOST_1, NOW + H)).toBe(false);
  expect(memo.due(GHOST_2, NOW + H)).toBe(true);
  expect(Object.keys(new LookedUp([1, 2]).toJSON(NOW))).toEqual([]);
});
