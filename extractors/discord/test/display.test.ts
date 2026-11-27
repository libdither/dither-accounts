import { describe, expect, test } from 'bun:test';
import { DISCORD_DISPLAYS, hashedDisplay, pickDisplay } from '../src/sandbox.ts';

/** Two invented account ids that hash to the same slot, found by search so the test doesn't depend on a lucky pair. */
function collidingPair(): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; ; i++) {
    const id = `acc_test${i}`;
    const slot = hashedDisplay(id);
    const other = seen.get(slot);
    if (other) return [other, id];
    seen.set(slot, id);
  }
}

describe('pickDisplay', () => {
  test('takes the hashed slot when it is free', async () => {
    const [a] = collidingPair();
    const asked: number[] = [];
    const got = await pickDisplay(a, {}, { free: async (n) => (asked.push(n), true) });
    expect(got.display).toBe(hashedDisplay(a));
    expect(asked).toEqual([hashedDisplay(a)]);
  });

  test('a second account on the same slot gets the next free one, not the taken one', async () => {
    const [a, b] = collidingPair();
    expect(hashedDisplay(a)).toBe(hashedDisplay(b));
    const held = new Set<number>();
    const free = async (n: number) => (held.has(n) ? false : (held.add(n), true));
    const first = await pickDisplay(a, {}, { free });
    const second = await pickDisplay(b, {}, { free });
    expect(second.display).not.toBe(first.display);
    expect(second.display).toBeGreaterThanOrEqual(DISCORD_DISPLAYS.from);
    expect(second.display).toBeLessThanOrEqual(DISCORD_DISPLAYS.to);
  });

  test('asks about the extension port 8700 + display unless the port is set', async () => {
    const ports: (number | null)[] = [];
    await pickDisplay('acc_test0', {}, { free: async (_n, p) => (ports.push(p), true) });
    expect(ports).toEqual([8700 + hashedDisplay('acc_test0')]);
    ports.length = 0;
    await pickDisplay('acc_test0', {}, { portFixed: true, free: async (_n, p) => (ports.push(p), true) });
    expect(ports).toEqual([null]);
  });

  test('wraps past :99 and fails plainly when every slot is held', async () => {
    const asked: number[] = [];
    await expect(pickDisplay('acc_test0', {}, { free: async (n) => (asked.push(n), false) })).rejects.toThrow(
      'no free Discord display',
    );
    expect([...asked].sort((x, y) => x - y)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });

  test('a display in config wins without looking', async () => {
    const got = await pickDisplay('acc_test0', { display: 140 }, { free: async () => { throw new Error('asked'); } });
    expect(got.display).toBe(140);
  });
});

test('on an Xvnc backend the same slots, the display carrying its backend (config or hashed); on wayland none', async () => {
  expect(await pickDisplay('acc_test0', {}, { backend: 'tigervnc', free: async () => true })).toEqual({ backend: 'tigervnc', display: hashedDisplay('acc_test0') });
  expect(await pickDisplay('acc_test0', { display: 140 }, { backend: 'kasmvnc', free: async () => true })).toEqual({ backend: 'kasmvnc', display: 140 });
  expect(await pickDisplay('acc_test0', {}, { backend: 'wayland' })).toEqual({ backend: 'wayland', display: null });
  expect(await pickDisplay('acc_test0', { display: 140 }, { backend: 'wayland-tigervnc' })).toEqual({ backend: 'wayland-tigervnc', display: null });
});
