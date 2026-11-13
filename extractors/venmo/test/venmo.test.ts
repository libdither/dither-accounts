/**
 * The venmo pull's decisions against dither-finance's own puller: test/fixtures were made by make-fixtures.ts running
 * connectors/venmo.py against the fake Venmo. The same pull here, on the day the fixtures were made, must ask for the
 * same ranges in the same order, stop the backfill at the same year, and write the same bytes under the same names
 * (but for the stamp); and `ranges` must answer as venmo.py's `_ranges` for every day and case in ranges.json.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activity, csvRows, fileName, pullStatements, ranges, stampUtc, statementBytes, type VenmoState } from '../src/venmo.ts';
import { csvFor, type FakeVenmo, PROFILE_ID, startFakeVenmo } from './fake-venmo.ts';

const FIX = join(import.meta.dir, 'fixtures');
const meta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8'));
let fake: FakeVenmo;
let cookie = '';

beforeAll(async () => {
  fake = startFakeVenmo();
  const r = await fetch(`${fake.origin}/test-login`, { redirect: 'manual' });
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
});
afterAll(() => fake?.stop());

test("ranges answer as venmo.py's _ranges", () => {
  const cases = JSON.parse(readFileSync(join(FIX, 'ranges.json'), 'utf8'));
  expect(cases.length).toBe(32);
  for (const c of cases) {
    const [y, m, d] = c.day.split('-').map(Number);
    const got = ranges(c.since, c.have, new Date(y, m - 1, d, 12)).map((r) => [r.start, r.end, r.backfill]);
    expect({ day: c.day, have: c.have, since: c.since, ranges: got }).toEqual(c);
  }
});

test("a first pull, then a daily one, write venmo.py's files", async () => {
  const [y, m, d] = meta.today.split('-').map(Number);
  let clock = new Date(y, m - 1, d, 12).getTime();
  const files: { name: string; bytes: Uint8Array }[] = [];
  const deps = {
    fetch: async (r: { start: string; end: string }) => {
      const q = new URLSearchParams({ startDate: r.start, endDate: r.end, csv: 'true', profileId: PROFILE_ID, accountType: 'personal' });
      const res = await fetch(`${fake.origin}/api/statement/download-v2?${q}`, { headers: { cookie } });
      return [res.status, await res.text()] as [number, string];
    },
    save: (name: string, bytes: Uint8Array) => files.push({ name, bytes }),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => new Date((clock += 1000)),
    log: () => {},
  };
  const st: VenmoState = { ranges: {} };
  const r1 = await pullStatements(st, {}, deps);
  expect(fake.requests.splice(0).map((r) => [r.start, r.end, r.ok])).toEqual(meta.req1);
  expect(r1.saved).toBe(meta.run1.length);
  const same = (dir: string, names: string[]) => {
    const got = files.splice(0);
    expect(got.map((f) => f.name.replace(/_\d{8}T\d{6}Z\.csv$/, '_STAMP.csv')).sort()).toEqual([...names].sort());
    for (const f of got) {
      expect(f.name).toMatch(/^venmo_\d{4}-\d\d-\d\d_\d{4}-\d\d-\d\d_\d{8}T\d{6}Z\.csv$/);
      const want = readFileSync(join(FIX, dir, f.name.replace(/_\d{8}T\d{6}Z\.csv$/, '_STAMP.csv')));
      expect(Buffer.from(f.bytes).equals(want)).toBe(true);
    }
  };
  same('run1', meta.run1);
  expect(st.backfilled).toBe(true);
  expect(Object.keys(st.ranges).length).toBe(meta.run1.length);

  // Nothing new: the daily pull asks for last month to today and saves nothing.
  const r0 = await pullStatements(st, {}, deps);
  expect(r0).toEqual({ saved: 0, requests: 1 });
  fake.requests.splice(0);
  // One more row this month: saved again, as venmo.py did.
  fake.bump(meta.bumped);
  await pullStatements(st, {}, deps);
  expect(fake.requests.splice(0).map((r) => [r.start, r.end, r.ok])).toEqual(meta.req2);
  same('run2', meta.run2);
});

test('the bytes are the JSON answer’s jsonData as UTF-8, and errors stop the pull', () => {
  const csv = csvFor('2025-01-01', '2025-12-31');
  const bytes = statementBytes(200, JSON.stringify({ jsonData: csv }), { start: 'a', end: 'b' });
  expect(Buffer.from(bytes).toString('utf8')).toBe(csv);
  expect(() => statementBytes(401, '{}', { start: 'a', end: 'b' })).toThrow('statement a..b: HTTP 401');
  expect(() => statementBytes(200, '{"x":1}', { start: 'a', end: 'b' })).toThrow('no jsonData');
  // 12 months, two rows each; the quoted newline is one field.
  expect(activity(csv)).toBe(24);
  expect(activity(csvFor('2022-01-01', '2022-12-31'))).toBe(0);
  expect(csvRows('a,"b ""c"", d\ne",f\r\n\r\ng')).toEqual([['a', 'b "c", d\ne', 'f'], [], ['g']]);
  expect(stampUtc(new Date(Date.UTC(2026, 10, 9, 6, 7, 8)))).toBe('20261109T060708Z');
  expect(fileName({ start: '2026-10-01', end: '2026-11-09' }, '20261109T060708Z')).toBe('venmo_2026-10-01_2026-11-09_20261109T060708Z.csv');
});

test('status: signed out is fine while a recent pull found you signed in; otherwise sign in', async () => {
  const { state, pageKind } = await import('../src/status.ts');
  const now = Date.now();
  const v = { signedIn: false, lastSignedInPull: null, nagAfterDays: 7, now, page: null, kind: 'none' as const };
  expect(state(v).attention?.kind).toBe('login');
  expect(state({ ...v, lastSignedInPull: now - 3 * 86400_000 })).toEqual({ status: 'online', attention: null });
  expect(state({ ...v, lastSignedInPull: now - 8 * 86400_000 }).attention?.kind).toBe('login');
  expect(state({ ...v, signedIn: true })).toEqual({ status: 'online', attention: null });
  const app = 'https://account.venmo.com';
  expect(['https://account.venmo.com/', 'https://account.venmo.com/statement', 'https://account.venmo.com/account/sign-in', 'https://id.venmo.com/signin', 'https://venmo.com/', 'https://example.com/'].map((u) => pageKind(u, app))).toEqual([
    'app',
    'app',
    'signin',
    'signin',
    'site',
    'other',
  ]);
});

test('the manifest: statements only, no fields (you sign in in the live view)', async () => {
  const m = (await import('../manifest.ts')).default;
  expect(m).toMatchObject({ kind: 'venmo', interfaces: ['statements'], entry: 'src/main.ts' });
  expect((m.add as any).fields).toBeUndefined();
});
