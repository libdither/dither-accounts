/**
 * Tracing (packages/manager/src/trace.ts, extractors/discord/src/trace.ts): an app's call with a traceparent is a
 * manager span under the app's; the extractor gets the call's own traceparent, while extractors on the shared link never
 * see it as input; an extractor's span sent up as a `trace` log is written beside the manager's, not into its log;
 * a hold of the manager's event loop is recorded with the spans open in it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { parseTraceparent, setTraceSink, Span, spanRecordOf, StallWatch, type SpanRecord, type StallRecord } from '../packages/manager/src/trace.ts';
import { annotate, hookPhases, phase, sinceStart, traced } from '../extractors/discord/src/trace.ts';

const APP_TRACE = '0af7651916cd43dd8448eb211c80319c';
const APP_SPAN = 'b7ad6b7169203331';
const TRACEPARENT = `00-${APP_TRACE}-${APP_SPAN}-01`;

describe('spans', () => {
  test('a span with an outside parent is its child; it is written once, when it ends', () => {
    const got: SpanRecord[] = [];
    setTraceSink((r) => got.push(r));
    const s = new Span('call echo', { op: 'echo' }, parseTraceparent(TRACEPARENT));
    s.event('to the extractor').set({ outcome: 'ok' });
    expect(s.traceparent).toBe(`00-${APP_TRACE}-${s.spanId}-01`);
    s.end();
    s.end();
    const failed = new Span('call nope');
    failed.fail(new Error('no such op'));
    failed.end();
    setTraceSink(null);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ name: 'call echo', traceId: APP_TRACE, parentSpanId: APP_SPAN, attrs: { op: 'echo', outcome: 'ok' }, status: 'ok' });
    expect(got[0]!.events!.map((e) => e.name)).toEqual(['to the extractor']);
    expect(got[1]).toMatchObject({ name: 'call nope', status: 'error', error: 'no such op' });
    expect(got[1]!.parentSpanId).toBeUndefined();
    expect(got[1]!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('only well-formed records from an extractor are kept', () => {
    const ok = { name: 'discord createGroup', traceId: APP_TRACE, spanId: APP_SPAN, startMs: 1, durationMs: 2, attrs: {}, status: 'ok' };
    expect(spanRecordOf(ok)).toEqual(ok as SpanRecord);
    for (const bad of [null, 'x', [], { ...ok, traceId: 'nope' }, { ...ok, status: 'maybe' }, { ...ok, parentSpanId: 'x' }, { ...ok, name: 'x'.repeat(201) }, { ...ok, attrs: { big: 'x'.repeat(9000) } }])
      expect(spanRecordOf(bad)).toBeUndefined();
    for (const bad of [undefined, 5, 'junk', `00-${'0'.repeat(32)}-${APP_SPAN}-01`]) expect(parseTraceparent(bad)).toBeUndefined();
  });

  test('a hold of the event loop is recorded with the spans open in it and what the process did', () => {
    setTraceSink(() => {});
    const recs: StallRecord[] = [];
    let t = 0;
    let u = { userCPUTime: 0, systemCPUTime: 0, minorPageFault: 0, majorPageFault: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 };
    const w = new StallWatch({ record: (r) => recs.push(r), now: () => t, wallNow: () => 5, usage: () => u }).from(0);
    t = 100;
    w.check(t);
    const open = new Span('call slow');
    t = 1200;
    u = { ...u, userCPUTime: 50_000, majorPageFault: 7 };
    w.check(t);
    open.end();
    setTraceSink(null);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ heldMs: 1000, cpuUserMs: 50, majorFaults: 7, work: 'manager' });
    expect(recs[0]!.spans.map((s) => s.name)).toEqual(['call slow']);
  });
});

describe("the Discord extractor's span", () => {
  test('a command with a traceparent sends one span under it, with the pace wait and the hook phases as events', async () => {
    const sent: any[] = [];
    const r = await traced('createGroup', TRACEPARENT, (x) => sent.push(x), async () => {
      annotate({ people: 2 });
      phase('paced', { waitMs: 3 });
      const at = sinceStart();
      hookPhases([{ name: 'group made', ms: 236 }, { name: 'named', ms: 402 }, { bad: true }], at);
      return 'done';
    });
    expect(r).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'discord createGroup', traceId: APP_TRACE, parentSpanId: APP_SPAN, attrs: { op: 'createGroup', people: 2 }, status: 'ok' });
    expect(spanRecordOf(sent[0])).toBeDefined();
    expect(sent[0].events.map((e: any) => e.name)).toEqual(['paced', 'hook: group made', 'hook: named']);
    expect(sent[0].events[2].atMs - sent[0].events[1].atMs).toBeCloseTo(166, 0);
  });

  test('a failure is the span’s; without a traceparent nothing is sent and phases go nowhere', async () => {
    const sent: any[] = [];
    await expect(traced('createGroup', TRACEPARENT, (x) => sent.push(x), async () => Promise.reject(new Error('Discord asked for a captcha')))).rejects.toThrow('captcha');
    expect(sent[0]).toMatchObject({ status: 'error', error: 'Discord asked for a captcha' });
    phase('outside any span');
    expect(await traced('send', undefined, (x) => sent.push(x), async () => 7)).toBe(7);
    expect(sent).toHaveLength(1);
  });
});

describe('through the manager', () => {
  let m: Manager | undefined;
  let dir = '';
  const clients: AccountsClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.close();
    await m?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const until = async (f: () => boolean, what: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (f()) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  test("an app's traceparent is the parent of the manager's span; an extractor's span is written beside it", async () => {
    dir = mkdtempSync(join(tmpdir(), 'dacc-trace-'));
    m = await createManager({ openPage: true, dataDir: dir, port: 0, trace: true });
    const app = await register(m.url, { name: 'traced-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'manage' }] });
    for (const r of app.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    const c = new AccountsClient({ url: m.url, app: app.app, token: app.token });
    clients.push(c);
    await until(() => c.connected && c.accounts !== undefined, 'connect');
    const made = await c.admin({ do: 'create', kind: 'fake', label: 'Fake traced' });
    await until(() => c.accounts.some((a) => a.id === made.id && a.online), 'the extractor online');

    // The extractor on the shared link gets its input as sent: `trace` is not part of it.
    expect(await c.callRaw(made.id, 'echo', { text: 'hi' }, 30_000, { trace: TRACEPARENT })).toEqual({ text: 'hi' });
    expect(await c.call(testEcho, made.id, 'echo', { text: 'untraced' })).toEqual({ text: 'untraced' });
    // A refusal with an upstream status: its span says the status (bugwatch tells expected refusals by it).
    expect(await c.call(testEcho, made.id, 'fail', { status: 410 }).catch((e) => e.code)).toBe('failed');

    // An extractor's finished span, as the Discord extractor sends it.
    const fromExtractor = { name: 'discord createGroup', traceId: APP_TRACE, spanId: 'c'.repeat(16), parentSpanId: APP_SPAN, startMs: 1, durationMs: 9, attrs: { op: 'createGroup' }, status: 'ok' };
    m.sup.receive({ data: { accountId: made.id } } as never, JSON.stringify({ t: 'log', level: 'info', msg: 'trace', data: fromExtractor }));
    m.sup.receive({ data: { accountId: made.id } } as never, JSON.stringify({ t: 'log', level: 'info', msg: 'trace', data: { name: 'junk' } }));

    await m.stop();
    m = undefined;
    const file = join(dir, 'traces/manager.trace.ndjson');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(dir, 'traces/event-loop-stalls.ndjson'))).toBe(false);
    const spans = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SpanRecord);
    const calls = spans.filter((s) => s.name === 'call echo');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ traceId: APP_TRACE, parentSpanId: APP_SPAN, attrs: { app: app.app, account: made.id, op: 'echo' }, status: 'ok' });
    expect(calls[0]!.events!.map((e) => e.name)).toEqual(['to the extractor', 'the extractor answered']);
    expect(calls[1]!.parentSpanId).toBeUndefined();
    expect(spans.find((s) => s.name === 'call fail')).toMatchObject({ status: 'error', error: 'failed with 410', attrs: { outcome: 'failed', status: 410 } });
    expect(spans.filter((s) => s.name === 'discord createGroup')).toEqual([{ ...fromExtractor, attrs: { op: 'createGroup', account: made.id } } as SpanRecord]);
    expect(spans.some((s) => s.name === 'junk')).toBe(false);
    // Not in the account's log.
    const log = readFileSync(join(dir, 'accounts', made.id, 'adapter.log'), 'utf8');
    expect(log).not.toContain('discord createGroup');
  }, 30_000);
});
