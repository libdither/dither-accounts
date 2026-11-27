/**
 * The shared way parsers read a list of records (packages/link records.ts): one record off is left out, named and
 * counted; most of them off is a changed layout and refuses the answer; any other error is a bug and goes up.
 */
import { describe, expect, test } from 'bun:test';
import { replyError } from '@dither-accounts/link';
import { LayoutChanged, looksChanged, readEach, RecordError, Skips, SYSTEMIC } from '@dither-accounts/link/records';

/** A record is `{ id, n }` with n a number. */
const readN = (raw: unknown, i: number): number => {
  const r = raw as { n?: unknown } | null;
  if (!r || typeof r !== 'object') throw new RecordError(`[${i}]`, 'a record', raw === null ? 'null' : typeof raw);
  if (typeof r.n !== 'number') throw new RecordError(`[${i}].n`, 'a number', typeof r.n);
  return r.n;
};
const idOf = (raw: unknown) => (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null);

describe('readEach', () => {
  test('a record off is left out, named by its id when it has one, and the rest are read', () => {
    const r = readEach([{ id: 'acct-1', n: 1 }, { id: 'acct-2', n: 'two' }, { id: 'acct-3', n: 3 }], readN, { what: 'test.list', idOf });
    expect(r.items).toEqual([1, 3]);
    expect(r.skipped).toEqual([{ id: 'acct-2', where: '[1].n', expected: 'a number', got: 'string' }]);
    expect([r.complete, r.anonymous]).toEqual([false, false]);
  });

  test('a skip with no id makes the answer anonymous: nothing may be worked out from what it lacks', () => {
    const r = readEach([{ n: 1 }, null, { n: 3 }], readN, { what: 'test.list', idOf });
    expect(r.items).toEqual([1, 3]);
    expect([r.complete, r.anonymous]).toEqual([false, true]);
    const whole = readEach([{ n: 1 }], readN, { what: 'test.list', idOf });
    expect([whole.complete, whole.anonymous]).toEqual([true, false]);
  });

  test('undefined is left out on purpose: not a skip, and it counts as read', () => {
    const r = readEach([{ n: 1 }, { n: -1 }, { n: 2 }], (raw, i) => (readN(raw, i) < 0 ? undefined : readN(raw, i)), { what: 'test.list' });
    expect(r.items).toEqual([1, 2]);
    expect(r.complete).toBe(true);
  });

  test(`at least ${SYSTEMIC} off and more than were read is a changed layout: the whole answer is refused, 502, a bug`, () => {
    expect([looksChanged(0, 1), looksChanged(0, 2), looksChanged(3, 3), looksChanged(2, 3), looksChanged(0, 3)]).toEqual([false, false, false, true, true]);
    const bad = [{ n: 'a' }, { n: 'b' }, { n: 'c' }, { n: 4 }];
    const skips = new Skips();
    let e: unknown = null;
    try {
      readEach(bad, readN, { what: 'test.list', skips });
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(LayoutChanged);
    expect((e as LayoutChanged).message).toBe('test.list: the answer is not laid out as this extractor knows it (at [0].n: expected a number, got string, and 3 of 4 records failed); nothing was returned rather than possibly misread records');
    // What the extractor's reply says of it: the manager and the app see a 502 bug.
    expect(replyError(e)).toMatchObject({ status: 502, kind: 'bug' });
    // A refused answer's records are not counted as skips: the refusal is the error.
    expect(skips.total).toBe(0);
    // One or two odd records of a small answer are records, not a layout.
    expect(readEach([{ n: 'a' }, { n: 'b' }], readN, { what: 'test.list' }).items).toEqual([]);
  });

  test('any other error from a reader is a bug in our code and goes up', () => {
    expect(() =>
      readEach([{ n: 1 }], () => {
        throw new TypeError('x is undefined');
      }, { what: 'test.list' }),
    ).toThrow(TypeError);
  });
});

describe('Skips', () => {
  test('counted by what and what was expected; one log line per kind, again at most once an hour with the count', () => {
    let now = 1_000_000;
    const lines: string[] = [];
    const skips = new Skips({ log: (_l, m) => lines.push(m), now: () => now });
    for (let i = 0; i < 5; i++) readEach([{ n: 1 }, { n: 'x' }], readN, { what: 'test.list', skips });
    readEach([{ n: 1 }, null], readN, { what: 'test.list', skips });
    expect(skips.summary()).toBe('test.list: a number 5, test.list: a record 1');
    expect(skips.total).toBe(6);
    expect(lines).toEqual(['records left out: test.list, expected a number, got string (at [1].n); 1 so far', 'records left out: test.list, expected a record, got null (at [1]); 1 so far']);
    now += 3_600_000;
    readEach([{ n: 'x' }], readN, { what: 'test.list', skips });
    expect(lines.at(-1)).toBe('records left out: test.list, expected a number, got string (at [0].n); 6 so far, 5 since the last line');
    expect(new Skips().summary()).toBeNull();
  });
});
