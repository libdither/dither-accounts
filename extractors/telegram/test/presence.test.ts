/** Presence for status dots (src/presence.ts): what a Telegram user status says, told once a change, online expiring. */
import { describe, expect, test } from 'bun:test';
import { EXPIRY_GRACE_MS, presenceOfStatus, PresenceTeller } from '../src/presence.ts';

describe('presenceOfStatus', () => {
  test('online until it expires; recently, last week and last month are offline; hidden is unknown', () => {
    const now = 1_000_000_000;
    expect(presenceOfStatus({ _: 'userStatusOnline', expires: now / 1000 + 60 }, now)).toEqual({ state: 'online', until: now + 60_000 });
    expect(presenceOfStatus({ _: 'userStatusOnline', expires: now / 1000 - 1 }, now)).toEqual({ state: 'offline' });
    for (const _ of ['userStatusOffline', 'userStatusRecently', 'userStatusLastWeek', 'userStatusLastMonth'] as const)
      expect(presenceOfStatus({ _, wasOnline: 1 } as never, now)).toEqual({ state: 'offline' });
    expect(presenceOfStatus({ _: 'userStatusEmpty' }, now)).toBeNull();
    expect(presenceOfStatus(undefined, now)).toBeNull();
  });
});

describe('PresenceTeller', () => {
  const make = (follows: (id: number) => boolean = () => true) => {
    let now = 1_000_000_000;
    const told: [number, string][] = [];
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    const t = new PresenceTeller(
      follows,
      (id, state) => told.push([id, state]),
      () => now,
      (f, ms) => {
        const x = { f, ms, live: true };
        timers.push(x);
        return () => void (x.live = false);
      },
    );
    return { t, told, timers, tick: (ms: number) => (now += ms), at: () => now };
  };

  test('each change once; only for people it follows', () => {
    const { t, told, at } = make((id) => id !== 3);
    t.note(1, { _: 'userStatusOffline', wasOnline: 1 });
    t.note(1, { _: 'userStatusRecently' });
    t.note(1, { _: 'userStatusOnline', expires: at() / 1000 + 300 });
    t.note(3, { _: 'userStatusOnline', expires: at() / 1000 + 300 });
    expect(told).toEqual([
      [1, 'offline'],
      [1, 'online'],
    ]);
  });

  test('online with nothing newer turns offline past its expiry; a refresh puts that off', () => {
    const { t, told, timers, at } = make();
    t.note(1, { _: 'userStatusOnline', expires: at() / 1000 + 30 });
    expect(timers.map((x) => x.ms)).toEqual([30_000 + EXPIRY_GRACE_MS]);
    t.note(1, { _: 'userStatusOnline', expires: at() / 1000 + 60 });
    expect(timers[0].live).toBe(false);
    expect(timers[1]).toMatchObject({ ms: 60_000 + EXPIRY_GRACE_MS, live: true });
    timers[1].f();
    expect(told).toEqual([
      [1, 'online'],
      [1, 'offline'],
    ]);
    t.stop();
  });

  test('retell says everything told again; reset forgets it; after stop nothing is told', () => {
    const { t, told, timers, at } = make();
    t.note(1, { _: 'userStatusOnline', expires: at() / 1000 + 30 });
    t.note(2, { _: 'userStatusRecently' });
    t.retell();
    expect(told).toEqual([
      [1, 'online'],
      [2, 'offline'],
      [1, 'online'],
      [2, 'offline'],
    ]);
    t.reset();
    expect(timers[0].live).toBe(false);
    t.note(2, { _: 'userStatusRecently' });
    expect(told.at(-1)).toEqual([2, 'offline']);
    expect(told).toHaveLength(5);
    t.stop();
    t.note(3, { _: 'userStatusRecently' });
    t.retell();
    expect(told).toHaveLength(5);
  });
});
