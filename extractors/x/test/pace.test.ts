import { expect, test } from 'bun:test';
import { Pace } from '../src/pace.ts';

test('one at a time, with a gap after each', async () => {
  const p = new Pace(60, 1);
  const at: number[] = [];
  let running = 0;
  let most = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      p.run(async () => {
        most = Math.max(most, ++running);
        at.push(Date.now());
        await Bun.sleep(5);
        running--;
      }),
    ),
  );
  expect(most).toBe(1);
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(60);
  expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(60);
});

test('a failure does not stop the queue', async () => {
  const p = new Pace(1, 1);
  await expect(p.run(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
  expect(await p.run(async () => 7)).toBe(7);
});
