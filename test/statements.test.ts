/**
 * statements-common on its own: Python's JSON (parse and dumps against what CPython writes for the same values), the
 * spool (seq, list, fetch, ack, 30 days kept, a crash's stray file, names refused), the daily slot (fixed per account
 * and day, catch-up like Persistent=true), and the interface's shape: read only, nothing that moves money.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moneroView, statements } from '@dither-accounts/interfaces';
import type { Link } from '@dither-accounts/link';
import { dumps, floatRepr, parse, PyFloat, PyInt, PyObj, strRepr } from '../extractors/statements-common/src/pyjson.ts';
import { KEEP_ACKED_MS, Spool } from '../extractors/statements-common/src/spool.ts';
import { StatementsRunner } from '../extractors/statements-common/src/runner.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-stmt-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("floats are written as Python's repr writes them", () => {
  // What CPython 3 prints for repr(float(x)).
  const cases: [number, string][] = [
    [1, '1.0'],
    [1.1, '1.1'],
    [100000, '100000.0'],
    [1e16, '1e+16'],
    [1234567890123456, '1234567890123456.0'],
    [0.0001, '0.0001'],
    [0.00001, '1e-05'],
    [0.0025, '0.0025'],
    [-0, '-0.0'],
    [1.5e300, '1.5e+300'],
    [-2.5e-7, '-2.5e-07'],
    [0.1 + 0.2, '0.30000000000000004'],
    [123.456, '123.456'],
  ];
  for (const [x, s] of cases) expect(floatRepr(x)).toBe(s);
});

test('strings are escaped as ensure_ascii does', () => {
  expect(strRepr('a"b\\c/d\n\t\u0001\u007f é ☃ 💳')).toBe('"a\\"b\\\\c/d\\n\\t\\u0001\\u007f \\u00e9 \\u2603 \\ud83d\\udcb3"');
});

test('parse keeps integers exact, floats as floats, and key order (integer-like keys too)', () => {
  const v = parse('{"b":1,"10":[1.10,1E5,-0,18446744073709551615,{}],"2":"x","b":2}') as PyObj;
  expect(v.entries().map(([k]) => k)).toEqual(['b', '10', '2']);
  expect((v.get('b') as PyInt).digits).toBe('2');
  const a = v.get('10') as any[];
  expect(a[0]).toBeInstanceOf(PyFloat);
  expect(a[3]).toBeInstanceOf(PyInt);
  expect(dumps(v)).toBe('{"b": 2, "10": [1.1, 100000.0, 0, 18446744073709551615, {}], "2": "x"}');
  expect(dumps(v, 2)).toBe('{\n  "b": 2,\n  "10": [\n    1.1,\n    100000.0,\n    0,\n    18446744073709551615,\n    {}\n  ],\n  "2": "x"\n}');
  expect(dumps(new PyObj(), 1)).toBe('{}');
  expect(dumps([], 1)).toBe('[]');
  expect(() => parse('{"a":1} x')).toThrow();
  expect(() => parse('"a\u0001"')).toThrow();
});

const link = (dir: string, config: Record<string, unknown> = {}, id = 'acc_test'): Link & { events: any[] } => {
  const events: any[] = [];
  return { accountId: id, accountDir: dir, config, label: 'Test', emit: (e: unknown) => events.push(e), log: () => {}, secret: () => ({}) as any, saveSecret: () => {}, connected: true, close: () => {}, events } as any;
};

test('the spool: seq, list after a cursor, fetch by id, ack keeps 30 days, then drops', () => {
  const dir = tmp();
  let now = 1_000_000;
  const seen: number[] = [];
  const sp = new Spool(dir, (f) => seen.push(f.seq), () => now);
  const a = sp.add('simplefin-20261109T061317-w0.json', '', '{"a": 1}', { coverage: { from: 1, to: 2 } });
  const b = sp.add('venmo_2026-01-01_2026-01-31_20260201T000000Z.csv', 'venmo', 'x,y\n');
  expect([a.seq, b.seq]).toEqual([1, 2]);
  expect(seen).toEqual([1, 2]);
  expect(a.mime).toBe('application/json');
  expect(b.mime).toBe('text/csv');
  expect(a.sha256).toBe(new Bun.CryptoHasher('sha256').update('{"a": 1}').digest('hex'));
  expect(statSync(join(dir, 'spool')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'spool', a.id)).mode & 0o777).toBe(0o600);
  expect(sp.list().files.map((f) => f.seq)).toEqual([1, 2]);
  expect(sp.list(1)).toEqual({ files: [b], next: 2 });
  expect(sp.list(2)).toEqual({ files: [], next: 2 });
  expect(sp.list(0, 1).next).toBe(1);
  const f = sp.fetch(b.id);
  expect(Buffer.from(f.base64, 'base64').toString()).toBe('x,y\n');
  expect(f).toMatchObject({ name: b.name, dir: 'venmo', size: 4, sha256: b.sha256 });
  expect(() => sp.fetch('nope')).toThrow(/no such file/);
  expect(sp.ack(1)).toEqual({ acked: 1 });
  expect(sp.ack(99)).toEqual({ acked: 2 });
  expect(sp.ack(0)).toEqual({ acked: 2 });
  expect(sp.pending).toBe(0);
  // Kept 30 days after the ack, then gone; seqs never repeat after that, or after a restart.
  now += KEEP_ACKED_MS - 1;
  sp.sweep();
  expect(sp.list().files.length).toBe(2);
  now += 2;
  sp.sweep();
  expect(sp.list().files).toEqual([]);
  const sp2 = new Spool(dir, () => {}, () => now);
  expect(sp2.add('x.json', '', '{}').seq).toBe(3);
  // A crash between a file and the index leaves a stray file: the next start removes it.
  writeFileSync(join(dir, 'spool', '9-deadbeef'), 'torn');
  new Spool(dir, () => {}, () => now);
  expect(readdirSync(join(dir, 'spool')).sort()).toEqual(['3-' + new Bun.CryptoHasher('sha256').update('{}').digest('hex').slice(0, 16), 'index.json'].sort());
  for (const bad of ['../x', '.hidden', 'a/b', '']) expect(() => sp2.add(bad, '', 'x')).toThrow();
  for (const bad of ['..', '/abs', 'a/../b']) expect(() => sp2.add('ok.json', bad, 'x')).toThrow();
});

test('the daily slot is fixed per account and day, and a missed slot pulls at start', async () => {
  const dir = tmp();
  const at = new Date(2026, 10, 9, 12, 0, 0).getTime();
  const pulls: string[] = [];
  const mk = (id: string, now: number) => new StatementsRunner({ link: link(dir, { pullAt: '06:00', jitterMinutes: 30 }, id), pull: async (_o, why) => (pulls.push(why), { saved: 0 }), accounts: () => [], now: () => now });
  const r = mk('acc_a', at);
  const slot = r.slotOn(at);
  const six = new Date(2026, 10, 9, 6, 0, 0).getTime();
  expect(slot).toBeGreaterThanOrEqual(six);
  expect(slot).toBeLessThan(six + 30 * 60_000);
  expect(mk('acc_a', at + 3600_000).slotOn(at)).toBe(slot);
  expect(r.slots(at)).toEqual({ prev: slot, next: r.slotOn(at + 24 * 3600_000) });
  // Never pulled: waits for the next slot.
  r.start();
  expect(r.nextAt).toBe(r.slotOn(at + 24 * 3600_000));
  r.stop();
  // Pulled before the last slot: catches up at once.
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ lastPullAt: slot - 3600_000, lastOk: true }));
  const r2 = mk('acc_a', at);
  r2.start();
  expect(r2.nextAt).toBe(at + 5000);
  r2.stop();
  // schedule: false: no daily pull at all, refresh still works.
  const r3 = new StatementsRunner({ link: link(tmp(), { schedule: false }), pull: async () => ({ saved: 0 }), accounts: () => [] });
  r3.start();
  expect(r3.nextAt).toBeNull();
  expect(r3.refresh({})).toEqual({ started: true });
  expect(r3.refresh({}).started).toBe(false);
  await Bun.sleep(10);
  expect(r3.st.lastOk).toBe(true);
});

test('the interfaces: statements is read only, monero.view has only key images, neither moves money', () => {
  expect(Object.values(statements.ops).every((o) => o.level === 'read')).toBe(true);
  expect(Object.keys(statements.ops).sort()).toEqual(['statements.accounts', 'statements.ack', 'statements.fetch', 'statements.list', 'statements.refresh']);
  expect(Object.keys(moneroView.ops)).toEqual(['monero.keyImages']);
  const words = /send|transfer|pay|withdraw|order|card/i;
  for (const n of [...Object.keys(statements.ops), ...Object.keys(moneroView.ops)]) expect(words.test(n)).toBe(false);
});
