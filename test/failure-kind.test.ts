/**
 * A failure's kind (spec FailureKind: expected, transient, bug) at each boundary that is not the wire: how the manager
 * works one out, what an extractor's reply carries, the errors.ndjson record, and how bugwatch reads and counts it.
 * The wire itself (extractor → manager → app, and the call span) is in manager.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replyError, StatusError } from '@dither-accounts/link';
import { type ErrorRecord, ErrorLog } from '@dither-accounts/manager/errors';
import { failureKindOf } from '@dither-accounts/spec';
import type { Config } from '../extractors/bugwatch/src/config.ts';
import { parseErrorsLine, parseSpanLine } from '../extractors/bugwatch/src/readers.ts';
import { fresh } from '../extractors/bugwatch/src/state.ts';
import { Watch } from '../extractors/bugwatch/src/watch.ts';
import { CallFailure } from '../packages/manager/src/router.ts';

const T0 = Date.parse('2026-11-13T12:00:00Z');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('working out a kind', () => {
  test("the maker's kind wins; else the manager's code; else the status; else none", () => {
    expect(failureKindOf({ code: 'failed', status: 404, kind: 'bug' })).toBe('bug');
    expect(failureKindOf({ code: 'offline' })).toBe('expected');
    expect(failureKindOf({ code: 'denied' })).toBe('expected');
    expect(failureKindOf({ code: 'limited' })).toBe('transient');
    expect(failureKindOf({ code: 'timeout' })).toBe('transient');
    expect(failureKindOf({ code: 'unsure', status: 504 })).toBe('transient');
    for (const s of [400, 401, 404, 410, 413, 422, 501]) expect(failureKindOf({ code: 'failed', status: s })).toBe('expected');
    for (const s of [408, 429, 503, 504]) expect(failureKindOf({ code: 'failed', status: s })).toBe('transient');
    // A 500 or 502, or no status: may be anything.
    for (const s of [500, 502, undefined]) expect(failureKindOf({ code: 'failed', status: s })).toBeUndefined();
    expect(failureKindOf({ code: 'failed', status: 500, kind: 'fine' })).toBeUndefined();
  });

  test('a CallFailure fills in its kind, and keeps a whole retryAfterMs', () => {
    expect(new CallFailure({ code: 'offline', message: 'the account is not connected' }).error).toEqual({ code: 'offline', message: 'the account is not connected', kind: 'expected' });
    expect(new CallFailure({ code: 'limited', message: 'too many', retryAfterMs: 1234.2 }).error).toMatchObject({ kind: 'transient', retryAfterMs: 1235 });
    expect(new CallFailure({ code: 'failed', message: 'x', retryAfterMs: -1 }).error).toEqual({ code: 'failed', message: 'x' });
  });
});

describe("an extractor's reply", () => {
  test('a StatusError sends its status, code, kind and wait; another error only its status', () => {
    expect(replyError(new StatusError('Gmail could not be reached', 503, 'unavailable', { kind: 'transient', retryAfterMs: 2000 }))).toEqual({ error: 'Gmail could not be reached', status: 503, code: 'unavailable', kind: 'transient', retryAfterMs: 2000 });
    expect(replyError(new StatusError('no such message', 404))).toEqual({ error: 'no such message', status: 404 });
    // Names that only look like ours, on another error, stay home.
    const other = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', status: 500, kind: 'expected', retryAfterMs: 5 });
    expect(replyError(other)).toEqual({ error: 'ENOENT: no such file', status: 500 });
    expect(replyError('plain')).toEqual({ error: 'plain' });
  });
});

describe('errors.ndjson', () => {
  test('a record says the kind it was given or that its error carries; none otherwise', async () => {
    const recs: ErrorRecord[] = [];
    const log = new ErrorLog((r) => recs.push(r), { now: () => T0 });
    log.record({ source: 'uncaught', where: 'process', error: new Error('boom'), kind: 'bug' });
    log.record({ source: 'job', where: 'sync', error: new StatusError('Gmail is busy', 503, undefined, { kind: 'transient' }) });
    log.record({ source: 'job', where: 'sync', name: 'Error', message: 'plain' });
    log.record({ source: 'job', where: 'sync', name: 'Error', message: 'odd', kind: 'nope' as any });
    expect(recs.map((r) => r.kind)).toEqual(['bug', 'transient', undefined, undefined]);
    log.close();
  });
});

// ------------------------------------------------------------------ bugwatch

const errLine = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, at: T0, app: 'hub', source: 'job', where: 'mail: changes', name: 'MailCallError', message: 'the account is not connected', stack: ['at changes (packages/hub/src/mail/sync.ts:120:7)'], ...o });
const spanLine = (attrs: Record<string, unknown>, error = 'Gmail could not be reached') => JSON.stringify({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'call mail.get', startMs: T0, durationMs: 5, status: 'error', error, attrs: { app: 'app-1', account: 'acct-123', op: 'mail.get', ...attrs } });

describe('bugwatch reads the kind', () => {
  test('errors-ndjson: a known kind is kept; an unknown one, or none (older writers), is not', () => {
    expect(parseErrorsLine(errLine({ kind: 'transient' }))!.kind).toBe('transient');
    expect(parseErrorsLine(errLine({ kind: 'expected' }))!.kind).toBe('expected');
    expect(parseErrorsLine(errLine({ kind: 'whatever' }))!.kind).toBeUndefined();
    const old = parseErrorsLine(errLine())!;
    expect(old.kind).toBeUndefined();
    expect(old.message).toBe('the account is not connected');
  });

  test('trace-ndjson: a span that says its kind is taken at its word; one that does not is judged as before', () => {
    expect(parseSpanLine(spanLine({ outcome: 'failed', status: 503, kind: 'expected' }))).toBeNull();
    expect(parseSpanLine(spanLine({ outcome: 'failed', status: 503, kind: 'transient' }))).toMatchObject({ kind: 'transient', status: 503 });
    // A bug the extractor named is a bug even with a 4xx status or words that sound like a refusal.
    expect(parseSpanLine(spanLine({ outcome: 'failed', status: 422, kind: 'bug' }, 'answered 429'))).toMatchObject({ kind: 'bug', status: 422 });
    // Without one: a 4xx, the manager's refusals and refusal words are left out; a 5xx is a bug.
    expect(parseSpanLine(spanLine({ outcome: 'failed', status: 404 }))).toBeNull();
    expect(parseSpanLine(spanLine({ outcome: 'offline' }))).toBeNull();
    expect(parseSpanLine(spanLine({ outcome: 'failed' }, 'rate limit reached'))).toBeNull();
    expect(parseSpanLine(spanLine({ outcome: 'failed', status: 503 }))).toMatchObject({ status: 503 });
    expect(parseSpanLine(spanLine({ outcome: 'failed', status: 503 }))!.kind).toBeUndefined();
  });
});

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dacc-kind-'));
  dirs.push(dir);
  const file = join(dir, 'errors.ndjson');
  writeFileSync(file, '');
  const cfg: Config = { sources: [{ name: 'hub', kind: 'errors-ndjson', path: file, project: '/srv/app', base: 'origin/main' }], ignore: [], always: [], threads: null, briefs: [], spikeGapHours: 6 };
  const st = fresh();
  const clock = { now: T0 };
  const events: { t: string; [k: string]: any }[] = [];
  const w = new Watch(cfg, st, { now: () => clock.now, run: async () => ({ code: 0, stdout: '', stderr: '' }), log: () => {}, emit: (e) => events.push(e), briefTemplate: readFileSync(resolve(import.meta.dir, '../extractors/bugwatch/brief.md'), 'utf8') });
  const write = (lines: string[]) => appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
  // The next scan after these lines, a minute on.
  const scan = async (lines: string[]) => {
    write(lines);
    clock.now += 60_000;
    return w.scan();
  };
  return { w, st, clock, scan };
}

describe('bugwatch counts by kind', () => {
  test('an expected record is no bug: nothing is kept or raised', async () => {
    const r = rig();
    await r.w.scan();
    const s = await r.scan([errLine({ at: T0 + 1000, kind: 'expected' }), errLine({ at: T0 + 2000, kind: 'expected', count: 60 })]);
    expect(s.raised).toEqual([]);
    expect(Object.keys(r.st.bugs)).toEqual([]);
  });

  test('a transient record is counted but raises nothing alone; a run of them is a spike', async () => {
    const r = rig();
    await r.w.scan();
    const one = await r.scan([errLine({ at: T0 + 1000, kind: 'transient', message: 'the Gmail download failed: the browser could not fetch it' })]);
    expect(one.raised).toEqual([]);
    const b = Object.values(r.st.bugs)[0]!;
    expect([b.count, b.transient, b.notice]).toEqual([1, true, undefined]);
    // 25 in the hour: a spike, the sustained rate being the signal.
    const run = await r.scan(Array.from({ length: 24 }, (_, i) => errLine({ at: T0 + 60_000 + i * 1000, kind: 'transient', message: 'the Gmail download failed: the browser could not fetch it' })));
    expect(run.raised.map((x) => x.reason)).toEqual(['spike']);
    expect(b.count).toBe(25);
  });

  test('a bug that was only transient so far is new when a record of it is not', async () => {
    const r = rig();
    await r.w.scan();
    await r.scan([errLine({ at: T0 + 1000, kind: 'transient' })]);
    const s = await r.scan([errLine({ at: T0 + 2 * 60_000 })]);
    expect(s.raised.map((x) => x.reason)).toEqual(['new']);
    const b = Object.values(r.st.bugs)[0]!;
    expect([b.count, b.transient]).toEqual([2, undefined]);
  });

  test('records with no kind (older writers) are bugs as before', async () => {
    const r = rig();
    await r.w.scan();
    expect((await r.scan([errLine({ at: T0 + 1000 })])).raised.map((x) => x.reason)).toEqual(['new']);
  });
});
