/**
 * The manager's error file (packages/manager/src/errors.ts): records in the errors-ndjson format, the same error within
 * 10 s as one record with a count, the write cap, error lines and frames found in a log (Bun's crash format, with its
 * source excerpt left out), the process handlers, and an extractor that crashes recorded with its kind and account.
 */
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import { errorBlocks, errorFields, ErrorLog, type ErrorRecord, onProcessError, relFrame } from '../packages/manager/src/errors.ts';
import fakeManifest from '../extractors/fake/manifest.ts';
import { newToken } from '../packages/manager/src/db.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BUN_CRASH = [
  '--- 2026-11-13T10:00:00.000Z dither-accounts starting fake extractor',
  '[info] fake extractor up',
  '205 |   const token = secret.token;',
  '206 |   throw new TypeError("cannot read the token of acc_7f3a9c2b1e");',
  '            ^',
  'TypeError: cannot read the token of acc_7f3a9c2b1e',
  '      at crashWith (/srv/checkout/extractors/fake/src/main.ts:206:9)',
  '      at <anonymous> (/srv/checkout/extractors/fake/src/main.ts:40:5)',
  '      at processTimers (native:7:39)',
  '',
  'Bun v1.4.2 (Linux x64)',
];

test('errorBlocks: the error line and its frames, never the source excerpt; Bun\'s trailer makes it a crash', () => {
  const b = errorBlocks(BUN_CRASH, '/srv/checkout');
  expect(b).toHaveLength(1);
  expect(b[0]).toMatchObject({ name: 'TypeError', message: 'cannot read the token of acc_7f3a9c2b1e', source: 'uncaught', line: 5 });
  expect(b[0]!.frames).toEqual(['at crashWith (extractors/fake/src/main.ts:206:9)', 'at <anonymous> (extractors/fake/src/main.ts:40:5)', 'at processTimers (native:7:39)']);
  expect(JSON.stringify(b)).not.toContain('secret.token');
  expect(JSON.stringify(b)).not.toContain(' | ');

  // Bun's own crash line for a syntax error, uncaught and unhandled lines, a logged error that is not a crash.
  const more = errorBlocks([
    '227 |     const x = a..b;',
    'error: Unexpected . at /srv/checkout/packages/hub/src/x.ts:208',
    '    at /srv/checkout/packages/hub/src/x.ts:208:12',
    'some other line',
    '2026-11-13T10:01:00Z [hub] unhandled rejection: Error: boom',
    '    at run (/srv/checkout/packages/hub/src/jobs.ts:12:3)',
    'Uncaught exception in the socket',
    'TypeError: not a crash, only logged',
    '    at handle (/srv/checkout/node_modules/ws/lib/x.js:1:1)',
    'next',
  ], '/srv/checkout');
  expect(more.map((x) => [x.name, x.message, x.source, x.frames.length])).toEqual([
    ['error', 'Unexpected . at /srv/checkout/packages/hub/src/x.ts:208', 'uncaught', 1],
    ['Error', 'boom', 'rejection', 1],
    ['Uncaught', 'in the socket', 'uncaught', 0],
    ['TypeError', 'not a crash, only logged', 'job', 1],
  ]);
  expect(more[3]!.frames).toEqual(['at handle (node_modules/ws/lib/x.js:1:1)']);
});

test('errorFields and relFrame: one line, short, frames relative to the repository', () => {
  const e = new RangeError('line one\nline two');
  const f = errorFields(e, ROOT);
  expect(f.name).toBe('RangeError');
  expect(f.message).toBe('line one line two');
  expect(f.stack.length).toBeGreaterThan(0);
  expect(f.stack.every((s) => !s.includes(ROOT))).toBe(true);
  expect(errorFields('x'.repeat(500)).message.length).toBe(300);
  expect(errorFields({ code: 7 })).toMatchObject({ name: 'NonError', message: '{"code":7}' });
  expect(relFrame('    at f (/a/b/node_modules/pkg/i.js:3:4)', '/a/b')).toBe('at f (node_modules/pkg/i.js:3:4)');
});

test('the same error within 10 s is one record with a count; at most so many a minute, the rest counted', () => {
  let now = 1_800_000_000_000;
  const got: ErrorRecord[] = [];
  const log = new ErrorLog((r) => got.push(r), { dedupMs: 50, perMinute: 3, now: () => now });
  for (let i = 0; i < 4; i++) log.record({ source: 'job', where: 'upkeep', error: new Error('database is locked') });
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ v: 1, app: 'manager', source: 'job', where: 'upkeep', name: 'Error', message: 'database is locked' });
  expect(got[0]!.count).toBeUndefined();
  log.flush();
  expect(got).toHaveLength(2);
  expect(got[1]).toMatchObject({ message: 'database is locked', count: 3 });
  // The cap: 3 a minute. The third goes; the next two are dropped and counted on the first of the next minute.
  log.record({ source: 'job', where: 'a', name: 'Error', message: 'one' });
  log.record({ source: 'job', where: 'b', name: 'Error', message: 'two' });
  log.record({ source: 'job', where: 'c', name: 'Error', message: 'three' });
  expect(got).toHaveLength(3);
  now += 60_000;
  log.record({ source: 'job', where: 'd', name: 'Error', message: 'four' });
  expect(got.at(-1)).toMatchObject({ where: 'd', extra: { dropped: 2 } });
  log.close();
});

test('the process handlers record, write at once, and still end the process', () => {
  const got: ErrorRecord[] = [];
  const log = new ErrorLog((r) => got.push(r));
  const exits: number[] = [];
  const err = console.error;
  console.error = () => {};
  try {
    onProcessError(log, 'uncaught', (c) => exits.push(c))(new TypeError('x is not a function'));
    onProcessError(log, 'rejection', (c) => exits.push(c))('a plain string');
  } finally {
    console.error = err;
  }
  expect(exits).toEqual([1, 1]);
  expect(got.map((r) => [r.source, r.where, r.name, r.message])).toEqual([
    ['uncaught', 'process', 'TypeError', 'x is not a function'],
    ['rejection', 'process', 'NonError', 'a plain string'],
  ]);
  log.close();
});

test('an extractor that crashes: its last error from stderr, with its kind and account, in <data>/traces/errors.ndjson', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dacc-errors-'));
  dirs.push(dir);
  let m: Manager | undefined;
  try {
    m = await createManager({ openPage: true, dataDir: dir, port: 0, errors: true, kinds: new Map([['fake', kindOf(fakeManifest, join(ROOT, 'extractors/fake'))]]) });
    const id = 'acc-crashy-1';
    const accDir = join(dir, 'crashy');
    mkdirSync(accDir);
    const now = Date.now();
    m.store.run(
      'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
      id,
      'fake',
      'Crashy',
      JSON.stringify({ throw: 'the fake gave up' }),
      newToken(),
      accDir,
      now,
      now,
    );
    m.sup.start(id);
    const file = join(dir, 'traces/errors.ndjson');
    const end = Date.now() + 15_000;
    let recs: ErrorRecord[] = [];
    while (Date.now() < end) {
      m.errors!.flush();
      recs = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      if (recs.length) break;
      await Bun.sleep(100);
    }
    expect(recs[0]).toMatchObject({ v: 1, app: 'manager', source: 'uncaught', where: 'extractor fake', name: 'TypeError', message: 'the fake gave up', extra: { kind: 'fake', account: id, code: 1 } });
    expect(recs[0]!.stack[0]).toMatch(/^at crashWith \(extractors\/fake\/src\/main\.ts:\d+:\d+\)$/);
    expect(JSON.stringify(recs)).not.toContain(ROOT);
  } finally {
    await m?.stop();
  }
});
