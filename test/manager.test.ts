import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { BUFFER, LIMITS } from '../packages/manager/src/router.ts';

let m: Manager;
let dir: string;
const clients: AccountsClient[] = [];

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  fetch(m.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const approve = async (requestId: string, b: Record<string, unknown> = {}) => expect((await api(`/api/requests/${requestId}/approve`, 'POST', b)).status).toBe(200);

function client(app: string, token: string) {
  const got: { account: string; t: string; n?: number }[] = [];
  const gaps: string[] = [];
  const c = new AccountsClient({ url: m.url, app, token, onEvents: (account, evs) => got.push(...evs.map((e) => ({ account, t: e.t, n: e.n as number | undefined }))), onGap: (a) => gaps.push(a) });
  clients.push(c);
  return { c, got, gaps };
}

let admin: { app: string; token: string; requests: { id: string }[] };
let reader: { app: string; token: string; requests: { id: string }[] };
let account: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-test-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  admin = await register(m.url, { name: 'admin-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'manage' }] });
  reader = await register(m.url, { name: 'reader-app', requests: [{ interface: 'test.echo', level: 'write', reason: 'to test' }] });
});
afterAll(async () => {
  for (const c of clients) c.close();
  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('nothing is allowed before you approve', async () => {
  const { c } = client(admin.app, admin.token);
  await until(() => c.connected, 4000, 'connect');
  expect(c.accounts).toEqual([]);
  const e = (await c.admin({ do: 'create', kind: 'fake', label: 'Fake' }).catch((x: any) => x)) as any;
  expect(e).toBeInstanceOf(CallFailed);
  expect(e.code).toBe('denied');
});

test('the state lists requests with their consent lines', async () => {
  const st = (await (await api('/api/state')).json()) as any;
  const r = st.apps.find((a: any) => a.name === 'reader-app');
  expect(r.requests[0].consent).toEqual(['Hear echoes', 'Shout']);
  expect(st.kinds.map((k: any) => k.kind)).toContain('fake');
});

test('an approved admin app makes an account; its extractor runs and reports in', async () => {
  for (const r of admin.requests) await approve(r.id);
  const c = clients[0];
  await until(() => c.accounts !== undefined);
  const made = await c.admin({ do: 'create', kind: 'fake', label: 'Fake one' });
  account = made.id;
  await until(() => c.accounts.some((a) => a.id === account && a.online), 10_000, 'the extractor online');
  expect(await c.call(testEcho, account, 'echo', { text: 'hi' })).toEqual({ text: 'hi' });
});

test('levels: read-only cannot write; approving narrower than asked holds', async () => {
  await approve(reader.requests[0].id, { level: 'read' });
  const { c } = client(reader.app, reader.token);
  await until(() => c.accounts.some((a) => a.id === account), 4000, 'the account visible');
  expect(c.accounts.find((a) => a.id === account)!.grants).toEqual({ 'test.echo': 'read' });
  expect(await c.call(testEcho, account, 'echo', { text: 'x' })).toEqual({ text: 'x' });
  const e = (await c.call(testEcho, account, 'shout', { text: 'x' }).catch((x: any) => x)) as any;
  expect(e.code).toBe('denied');
  const e2 = (await c.callRaw(account, 'emit', { n: 1 }).catch((x: any) => x)) as any;
  expect(e2.code).toBe('denied');
});

test('dry run answers writes without reaching the account', async () => {
  const st = (await (await api('/api/state')).json()) as any;
  const g = st.apps.find((a: any) => a.name === 'reader-app').grants[0];
  await api(`/api/grants/${g.id}`, 'PATCH', { level: 'write', dryRun: true });
  const c = clients[1];
  await until(() => c.accounts.find((a) => a.id === account)?.dryRun === true, 4000, 'dry run visible');
  expect(await c.call(testEcho, account, 'shout', { text: 'x' })).toEqual({ dryRun: true } as any);
  await api(`/api/grants/${g.id}`, 'PATCH', { dryRun: false });
  await until(() => c.accounts.find((a) => a.id === account)?.dryRun === false);
  expect(await c.call(testEcho, account, 'shout', { text: 'x' })).toEqual({ text: 'X' });
});

test('errors: upstream status, bad input, unknown op, timeout', async () => {
  const c = clients[0];
  const e = (await c.call(testEcho, account, 'fail', { status: 410 }).catch((x: any) => x)) as any;
  expect([e.code, e.status]).toEqual(['failed', 410]);
  // The extractor's own word for a refusal reaches the app with its status; never one of the manager's own words.
  const refused = (await c.call(testEcho, account, 'fail', { status: 422, code: 'recipients' }).catch((x: any) => x)) as any;
  expect([refused.code, refused.status, refused.message]).toEqual(['recipients', 422, 'failed with 422']);
  for (const reserved of ['denied', 'limited', 'offline', 'timeout', 'invalid', 'unknown-op', 'unknown-account', 'failed']) {
    const posing = (await c.call(testEcho, account, 'fail', { status: 403, code: reserved }).catch((x: any) => x)) as any;
    expect([posing.code, posing.status]).toEqual(['failed', 403]);
  }
  for (const odd of ['Recipients', 'two words', 'x'.repeat(41), '']) expect(((await c.call(testEcho, account, 'fail', { status: 422, code: odd }).catch((x: any) => x)) as any).code).toBe('failed');
  const bad = (await c.callRaw(account, 'echo', { text: 5 }).catch((x: any) => x)) as any;
  expect(bad.code).toBe('invalid');
  expect(bad.message).toContain('input.text');
  expect(((await c.callRaw(account, 'nope').catch((x: any) => x)) as any).code).toBe('unknown-op');
  expect(((await c.call(testEcho, account, 'slow', { ms: 2000 }).catch((x: any) => x)) as any).code).toBe('timeout');
});

test('rate limits per app, account and level', async () => {
  const before = LIMITS.read;
  LIMITS.read = [0.001, 3];
  try {
    const c = clients[0];
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => c.call(testEcho, account, 'echo', { text: 'r' }).then(() => 'ok', (e) => e.code)));
    expect(outcomes.filter((o) => o === 'limited').length).toBeGreaterThanOrEqual(2);
  } finally {
    LIMITS.read = before;
    // Refill.
    (m.router as any).buckets.clear();
  }
});

test('events reach every app with a grant, in order', async () => {
  const [a, r] = [clients[0], clients[1]];
  const seen = (got: { t: string; n?: number }[]) => got.filter((x) => x.t === 'note').map((x) => x.n);
  const gotA: any[] = [];
  const gotR: any[] = [];
  (a as any).opts.onEvents = (_: string, evs: any[]) => gotA.push(...evs);
  (r as any).opts.onEvents = (_: string, evs: any[]) => gotR.push(...evs);
  await a.callRaw(account, 'emit', { n: 50 });
  await until(() => seen(gotA).length === 50 && seen(gotR).length === 50, 4000, 'notes');
  expect(seen(gotA)).toEqual(Array.from({ length: 50 }, (_, i) => i));
});

test('an app that was away gets what it missed, then the account state; past the bound, a gap', async () => {
  const r = clients[1];
  r.close();
  await until(() => !m.router.connected(reader.app), 4000, 'disconnect');
  await clients[0].callRaw(account, 'emit', { n: 7 });
  await Bun.sleep(200);
  const back = client(reader.app, reader.token);
  await until(() => back.got.filter((x) => x.t === 'note').length === 7, 4000, 'the missed notes');
  expect(back.got.filter((x) => x.t === 'note').map((x) => x.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  await until(() => back.got.some((x) => x.t === 'status'), 4000, 'the account status');

  back.c.close();
  await until(() => !m.router.connected(reader.app));
  const before = BUFFER.events;
  BUFFER.events = 10;
  try {
    await clients[0].callRaw(account, 'emit', { n: 30 });
    await Bun.sleep(200);
    const again = client(reader.app, reader.token);
    await until(() => again.gaps.length === 1, 4000, 'a gap');
    expect(again.gaps).toEqual([account]);
    expect(again.got.filter((x) => x.t === 'note')).toEqual([]);
  } finally {
    BUFFER.events = before;
  }
});

test('calls are counted, never their contents', async () => {
  const rows = ((await (await api('/api/audit')).json()) as any).rows;
  const echo = rows.filter((x: any) => x.op === 'echo' && x.outcome === 'ok');
  expect(echo.reduce((s: number, x: any) => s + x.n, 0)).toBeGreaterThan(2);
  expect(rows.some((x: any) => x.outcome === 'denied')).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('"hi"');
});

test('a locked account directory is not started twice', async () => {
  const c = clients[0];
  const sleeper = Bun.spawn(['sleep', '30']);
  try {
    const made = await c.admin({ do: 'create', kind: 'fake', label: 'Locked', enabled: false });
    const acc = m.store.account(made.id)!;
    writeFileSync(join(acc.dir, 'extractor.lock'), JSON.stringify({ pid: sleeper.pid, owner: 'dither-chat' }));
    await c.admin({ do: 'update', account: made.id, enabled: true });
    await Bun.sleep(300);
    expect(m.sup.state(made.id)).toMatchObject({ running: false, error: `dither-chat (pid ${sleeper.pid}) runs this account` });
  } finally {
    sleeper.kill();
  }
});

test('the browser side: cross-site writes refused, sockets only for good tokens', async () => {
  expect((await api('/api/grants/x', 'DELETE', undefined, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await api('/api/apps/register', 'POST', { name: 'x' }, { origin: m.url })).status).toBe(403);
  const r = await fetch(m.url.replace('http', 'http') + '/consumer?token=nope', { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
  expect(r.status).toBe(401);
});
