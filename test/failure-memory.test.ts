/**
 * A caller's memory of failed reads (packages/spec memory.ts), and the client's use of it (`remember`): a repeat is
 * answered from memory until it is due, not sent; the call sent next carries how many repeats there were, onto its
 * span; a write, the account's state changing or a success clears it. Over the real wire with the fake extractor.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { FailureMemory, inputKey } from '@dither-accounts/spec/memory';
import { setTraceSink } from '../packages/manager/src/trace.ts';

// The waits below are at most 10 s each (an extractor starting or restarting on a loaded machine): the limit covers them.
setDefaultTimeout(30_000);

describe('FailureMemory', () => {
  const mem = (now: { t: number }, max?: number) => new FailureMemory({ now: () => now.t, ...(max ? { max } : {}) });

  test("the input's identity does not depend on the order of its keys", () => {
    expect(inputKey({ a: 1, b: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(inputKey({ b: { c: [3, { e: 5, f: 4 }], d: 2 }, a: 1 }));
    expect(inputKey({ a: 1 })).not.toBe(inputKey({ a: 2 }));
  });

  test('a transient failure backs off, 5 s doubling, never before its retryAfterMs; repeats are counted and handed on once', () => {
    const now = { t: 1_000_000 };
    const m = mem(now);
    const k = m.key('acct-123', 'mail.get', { id: '1' });
    expect(m.check(k)).toBeNull();
    m.failed(k, 'acct-123', 'mail.get', { code: 'failed', status: 503, message: 'busy', kind: 'transient' });
    expect(m.check(k)!.repeats).toBe(1);
    expect(m.check(k)!.repeats).toBe(2);
    now.t += 5_000;
    expect(m.check(k)).toBeNull();
    expect(m.take(k)).toBe(2);
    expect(m.take(k)).toBe(0);
    m.failed(k, 'acct-123', 'mail.get', { code: 'failed', status: 503, message: 'busy', kind: 'transient' });
    expect(m.dueInMs(m.check(k)!)).toBe(10_000);
    now.t += 10_000;
    // A wait longer than the back-off is honoured.
    m.failed(k, 'acct-123', 'mail.get', { code: 'failed', status: 503, message: 'backed off', kind: 'transient', retryAfterMs: 60_000 });
    expect(m.dueInMs(m.check(k)!)).toBe(60_000);
    expect(m.stats()).toEqual({ remembered: 1, repeats: 4, repeatsWaiting: 2 });
    m.succeeded(k);
    expect([m.check(k), m.size]).toEqual([null, 0]);
  });

  test('a bug (or no kind) waits a minute, doubling to 30; an expected answer is kept 10 minutes', () => {
    const now = { t: 0 };
    const m = mem(now);
    const bug = m.key('acct-123', 'mail.get', { id: '2' });
    m.failed(bug, 'acct-123', 'mail.get', { code: 'failed', status: 502, message: 'layout' });
    expect(m.dueInMs(m.check(bug)!)).toBe(60_000);
    for (let i = 0; i < 10; i++) m.failed(bug, 'acct-123', 'mail.get', { code: 'failed', status: 502, message: 'layout' });
    expect(m.dueInMs(m.check(bug)!)).toBe(1_800_000);
    const gone = m.key('acct-123', 'fetchMedia', { id: '3' });
    m.failed(gone, 'acct-123', 'fetchMedia', { code: 'failed', status: 404, message: 'gone' });
    expect(m.check(gone)!.kind).toBe('expected');
    now.t += 599_999;
    expect(m.check(gone)).not.toBeNull();
    now.t += 1;
    expect(m.check(gone)).toBeNull();
  });

  test('forget by account and op; bounded, the oldest failure dropped first', () => {
    const now = { t: 0 };
    const m = mem(now, 3);
    const e = { code: 'failed', status: 404, message: 'no' };
    for (const [a, op, id] of [['acct-1', 'x', 1], ['acct-1', 'y', 2], ['acct-2', 'x', 3]] as const) m.failed(m.key(a, op, { id }), a, op, e);
    m.forget('acct-1', 'x');
    expect(m.size).toBe(2);
    m.forget('acct-1');
    expect(m.size).toBe(1);
    for (let i = 0; i < 5; i++) m.failed(m.key('acct-3', 'x', { i }), 'acct-3', 'x', e);
    expect(m.size).toBe(3);
    expect(m.check(m.key('acct-2', 'x', { id: 3 }))).toBeNull();
    expect(m.check(m.key('acct-3', 'x', { i: 4 }))).not.toBeNull();
  });
});

describe('the client with remember', () => {
  let m: Manager;
  let dir: string;
  let c: AccountsClient;
  let account: string;
  const clock = { t: 5_000_000 };
  const spans: { name: string; attrs: Record<string, unknown> }[] = [];
  const sent = (input: Record<string, unknown>) => spans.filter((s) => s.name === 'call fail' && s.attrs.status === input.status);

  const until = async (f: () => boolean, what: string) => {
    for (let i = 0; i < 2000 && !f(); i++) await Bun.sleep(5);
    if (!f()) throw new Error(`timed out waiting for ${what}`);
  };
  const fail = (input: { status: number; kind?: string; retryAfterMs?: number }) => c.call(testEcho, account, 'fail', input).then(() => null, (e: CallFailed) => e);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dacc-memory-'));
    m = await createManager({ openPage: true, dataDir: dir, port: 0 });
    const app = await register(m.url, { name: 'memory-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'manage' }] });
    for (const r of app.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(200);
    c = new AccountsClient({ url: m.url, app: app.app, token: app.token, remember: { now: () => clock.t } });
    await until(() => c.connected, 'connect');
    account = (await c.admin({ do: 'create', kind: 'fake', label: 'Fake' })).id;
    await until(() => c.accounts.some((a) => a.id === account && a.online), 'the extractor online');
    setTraceSink((r) => spans.push(r as any));
  });
  afterAll(async () => {
    setTraceSink(null);
    c.close();
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a repeat of a transient failure is answered from memory until due, then sent with how many repeats there were', async () => {
    const input = { status: 503, kind: 'transient', retryAfterMs: 8_000 };
    const first = (await fail(input))!;
    expect([first.kind, first.remembered, sent(input).length]).toEqual(['transient', undefined, 1]);
    const again = (await fail(input))!;
    expect(again).toBeInstanceOf(CallFailed);
    expect([again.message, again.kind, again.retryAfterMs, again.remembered?.failures, again.remembered?.repeats]).toEqual([first.message, 'transient', 8_000, 1, 1]);
    await fail(input);
    expect(sent(input).length).toBe(1);
    // Another input is another call: sent at once.
    await fail({ status: 504, kind: 'transient' });
    expect(sent({ status: 504 }).length).toBe(1);
    clock.t += 7_999;
    expect((await fail(input))!.remembered?.repeats).toBe(3);
    clock.t += 1;
    const due = (await fail(input))!;
    expect(due.remembered).toBeUndefined();
    expect(sent(input).map((s) => s.attrs.repeats)).toEqual([undefined, 3]);
    // Failed twice in a row: the back-off (10 s) is longer than the extractor's wait now.
    expect((await fail(input))!.retryAfterMs).toBe(10_000);
  });

  test('an expected answer is kept, and a write to the account clears it', async () => {
    const input = { status: 404 };
    await fail(input);
    expect((await fail(input))!.remembered?.repeats).toBe(1);
    expect(sent(input).length).toBe(1);
    expect(await c.call(testEcho, account, 'shout', { text: 'x' })).toEqual({ text: 'X' });
    expect(c.memory!.size).toBe(0);
    expect((await fail(input))!.remembered).toBeUndefined();
    expect(sent(input).length).toBe(2);
  });

  test("the account's state changing clears what was remembered of it", async () => {
    const input = { status: 410 };
    await fail(input);
    expect((await fail(input))!.remembered).toBeDefined();
    await c.admin({ do: 'restart', account });
    await until(() => c.memory!.size === 0, 'the restart forgetting it');
    await until(() => c.accounts.some((a) => a.id === account && a.online), 'the extractor back online');
    expect((await fail(input))!.remembered).toBeUndefined();
    expect(sent(input).length).toBe(2);
  });

  test('without remember nothing is remembered', () => {
    expect(new AccountsClient({ url: m.url, app: 'none', token: 'none' }).memory).toBeNull();
  });
});
