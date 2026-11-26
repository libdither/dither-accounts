import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import type { DisplayBackend } from '@dither-accounts/spec/display';
import type { BackendCheck } from '../packages/manager/src/http.ts';
import { BUFFER, LIMITS } from '../packages/manager/src/router.ts';
import { setTraceSink } from '../packages/manager/src/trace.ts';

// These tests start real extractor processes, and under load one start can take seconds. A test's limit is longer
// than the waits inside it, so one that hangs fails saying what it waited for, not with bun's bare 5 s timeout.
setDefaultTimeout(30_000);

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
const checks: Partial<Record<DisplayBackend, BackendCheck>> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-test-'));
  // Whether a backend can run here is the machine's (its programs prepared, or on PATH): a test says, so the moves
  // below do not depend on what this machine has. `checks` is changed by the test that needs another answer.
  m = await createManager({ openPage: true, dataDir: dir, port: 0, backendCheck: (b) => checks[b] ?? { availability: 'ready', why: null } });
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

test("a kind's own settings: only its declared keys and values, kept in the config, and the extractor restarted to take them", async () => {
  const info = async () => ((await (await api('/api/state')).json()) as any).accounts.find((a: any) => a.id === account);
  expect((await info()).settings).toEqual([
    { key: 'loud', label: 'Loud', note: 'A setting for tests: it does nothing.', value: false },
    { key: 'motto', label: 'Motto', note: 'A line of text for tests: it does nothing.', value: false, type: 'text', text: '', placeholder: 'a few words' },
  ]);
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { nope: true } })).status).toBe(400);
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { loud: 'yes' } })).status).toBe(400);
  expect((await info()).settings[0].value).toBe(false);
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { loud: true } })).status).toBe(200);
  expect((await info()).settings[0].value).toBe(true);
  await until(async () => (await info()).online, 10_000, 'the extractor back online');
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { loud: false } })).status).toBe(200);
  expect((await info()).settings[0].value).toBe(false);
  await until(async () => (await info()).online, 10_000, 'the extractor back online');
  // A line of text: a string that fits its pattern and length, kept trimmed; '' takes it away.
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { motto: true } })).status).toBe(400);
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { motto: 'NOT LOWER' } })).status).toBe(400);
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { motto: 'much too long for twenty' } })).status).toBe(400);
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { motto: ' be kind ' } })).status).toBe(200);
  expect((await info()).settings[1].text).toBe('be kind');
  await until(async () => (await info()).online, 10_000, 'the extractor back online');
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { motto: '' } })).status).toBe(200);
  expect((await info()).settings[1].text).toBe('');
  await until(async () => (await info()).online, 10_000, 'the extractor back online');
});

test("the display backend: the manager's default (x11), an account's own from its settings, null back to the default", async () => {
  const detail = async () => (await (await api(`/api/accounts/${account}`)).json()) as any;
  const online = async () => !!((await (await api('/api/state')).json()) as any).accounts.find((a: any) => a.id === account)?.online;
  expect((await detail()).process.displayBackend).toBe('x11');
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { displayBackend: 'mir' } })).status).toBe(400);
  // The PATCH answers once the extractor was started again: on the backend it was given.
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { displayBackend: 'Wayland' } })).status).toBe(200);
  expect((await detail()).config.displayBackend).toBe('wayland');
  expect((await detail()).process.displayBackend).toBe('wayland');
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { displayBackend: null } })).status).toBe(200);
  expect('displayBackend' in (await detail()).config).toBe(false);
  expect((await detail()).process.displayBackend).toBe('x11');
  expect(m.sup.backendOf({ kind: 'fake', config: JSON.stringify({ displayBackend: 'wayland' }) } as any)).toBe('wayland');
  expect(m.sup.backendOf({ kind: 'fake', config: '{}' } as any)).toBe('x11');
  expect(m.sup.backendOf({ kind: 'fake', config: 'not json' } as any)).toBe('x11');
  // A kind with no screen has no backend, whatever its config says.
  expect(m.sup.backendOf({ kind: 'chat-fake', config: JSON.stringify({ displayBackend: 'wayland' }) } as any)).toBeNull();
  await until(online, 10_000, 'the extractor back online');
});

test("the default backend: config.toml's until one is chosen on the page, which wins; moving it restarts the running accounts that follow it", async () => {
  const st = async () => (await (await api('/api/state')).json()) as any;
  const detail = async () => (await (await api(`/api/accounts/${account}`)).json()) as any;
  const online = async () => !!(await st()).accounts.find((a: any) => a.id === account)?.online;
  const s0 = await st();
  expect(s0.display).toMatchObject({ default: 'x11', chosen: null, config: 'x11' });
  expect(s0.display.backends.map((b: any) => b.name)).toEqual(['x11', 'tigervnc', 'kasmvnc', 'wayland', 'wayland-tigervnc']);
  // The two built from forks this project keeps say so, with where they come from.
  const forks = s0.display.backends.filter((b: any) => b.experimental === 'fork');
  expect(forks.map((b: any) => b.name)).toEqual(['kasmvnc', 'wayland-tigervnc']);
  for (const b of forks) expect(b.note).toMatch(/fork/);
  expect(s0.accounts.find((a: any) => a.id === account).display).toEqual({ own: null, uses: 'x11' });
  expect((await api('/api/display', 'PUT', { default: 'mir' })).status).toBe(400);
  expect((await api('/api/display', 'PUT', {})).status).toBe(400);
  // The PUT answers at once; the accounts it moved restart after, one at a time per kind, on the backend they were given.
  const uses = async (b: string) => (await detail()).process.displayBackend === b;
  expect((await api('/api/display', 'PUT', { default: ' KasmVNC ' })).status).toBe(200);
  expect((await st()).display).toMatchObject({ default: 'kasmvnc', chosen: 'kasmvnc', config: 'x11' });
  await until(() => uses('kasmvnc'), 10_000, 'the account restarted on kasmvnc');
  expect((await st()).accounts.find((a: any) => a.id === account).display).toEqual({ own: null, uses: 'kasmvnc' });
  // An account's own wins over the default, and a change of the default then leaves it running as it is.
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { displayBackend: 'tigervnc' } })).status).toBe(200);
  expect((await detail()).process.displayBackend).toBe('tigervnc');
  const pid = (await detail()).process.pid;
  expect((await api('/api/display', 'PUT', { default: 'wayland-tigervnc' })).status).toBe(200);
  expect((await detail()).process).toMatchObject({ pid, displayBackend: 'tigervnc' });
  expect((await st()).accounts.find((a: any) => a.id === account).display).toEqual({ own: 'tigervnc', uses: 'tigervnc' });
  expect((await api(`/api/accounts/${account}`, 'PATCH', { settings: { displayBackend: null } })).status).toBe(200);
  await until(() => uses('wayland-tigervnc'), 10_000, 'the account restarted on wayland-tigervnc');
  // null: config.toml's again.
  expect((await api('/api/display', 'PUT', { default: null })).status).toBe(200);
  expect((await st()).display).toMatchObject({ default: 'x11', chosen: null });
  await until(() => uses('x11'), 10_000, 'the account restarted on x11');
  // A kind with no screen has none to show.
  expect((await st()).accounts.filter((a: any) => a.kind === 'chat-fake').every((a: any) => a.display === null)).toBe(true);
  await until(online, 10_000, 'the extractor back online');
});

test('a backend that cannot run here now is offered as such and refused (409), for the default and an account; the running account stays', async () => {
  const st = async () => (await (await api('/api/state')).json()) as any;
  const detail = async () => (await (await api(`/api/accounts/${account}`)).json()) as any;
  checks.kasmvnc = { availability: 'missing', why: 'Xkasmvnc not among the prepared programs' };
  checks['wayland-tigervnc'] = { availability: 'building', why: "its servers, built from a fork, are being built" };
  checks.tigervnc = { availability: 'unbuilt', why: 'built the first time it is picked' };
  try {
    const view = (await st()).display.backends;
    expect(view.map((b: any) => [b.name, b.availability, b.available])).toEqual([
      ['x11', 'ready', true],
      ['tigervnc', 'unbuilt', false],
      ['kasmvnc', 'missing', false],
      ['wayland', 'ready', true],
      ['wayland-tigervnc', 'building', false],
    ]);
    expect(view.find((b: any) => b.name === 'kasmvnc').why).toMatch(/Xkasmvnc/);
    const before = (await detail()).process;
    for (const b of ['kasmvnc', 'wayland-tigervnc', 'tigervnc']) {
      const put = await api('/api/display', 'PUT', { default: b });
      expect({ b, status: put.status }).toEqual({ b, status: 409 });
      expect(((await put.json()) as any).error).toMatch(b === 'kasmvnc' ? /cannot run here now: Xkasmvnc/ : b === 'tigervnc' ? /being built now/ : /being built/);
      const patch = await api(`/api/accounts/${account}`, 'PATCH', { settings: { displayBackend: b } });
      expect({ b, status: patch.status }).toEqual({ b, status: 409 });
    }
    // Nothing was taken: the default, the account's own and its process are as they were.
    expect((await st()).display).toMatchObject({ default: 'x11', chosen: null });
    expect((await st()).accounts.find((a: any) => a.id === account).display).toEqual({ own: null, uses: 'x11' });
    expect((await detail()).process).toMatchObject({ pid: before.pid, displayBackend: 'x11' });
    // Going back to config.toml's is never refused.
    expect((await api('/api/display', 'PUT', { default: null })).status).toBe(200);
  } finally {
    for (const k of Object.keys(checks)) delete checks[k as DisplayBackend];
  }
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

test("errors carry their kind to the app and into the call's span: the extractor's, else the code's or the status's", async () => {
  const c = clients[0];
  const spans: any[] = [];
  setTraceSink((r) => spans.push(r));
  const fail = (input: Record<string, unknown>) => c.call(testEcho, account, 'fail', input as any).then(() => null, (x: CallFailed) => x);
  try {
    // The extractor said it: it reaches the app as said, with its wait.
    const said = (await fail({ status: 502, kind: 'transient', retryAfterMs: 1500 }))!;
    expect([said.kind, said.retryAfterMs, said.status]).toEqual(['transient', 1500, 502]);
    // It did not: the status says it where it can (a 4xx is an answer, a 503 the world), and a 500 is not known.
    expect((await fail({ status: 404 }))!.kind).toBe('expected');
    expect((await fail({ status: 503, code: 'unavailable' }))!.kind).toBe('transient');
    const unknown = (await fail({ status: 500 }))!;
    expect([unknown.kind, unknown.retryAfterMs]).toEqual([undefined, undefined]);
    // Something that is not a kind is dropped on the way, not passed on.
    expect((await fail({ status: 500, kind: 'fine' }))!.kind).toBeUndefined();
    // The manager's own refusals have theirs.
    expect(((await c.callRaw(account, 'echo', { text: 5 }).catch((x: any) => x)) as CallFailed).kind).toBe('expected');
    expect(((await c.callRaw(account, 'nope').catch((x: any) => x)) as CallFailed).kind).toBe('expected');
    expect(((await c.call(testEcho, account, 'slow', { ms: 2000 }).catch((x: any) => x)) as CallFailed).kind).toBe('transient');
    // The span of the first call says what the app was told.
    const span = spans.find((s) => s.name === 'call fail' && s.attrs?.status === 502);
    expect(span).toMatchObject({ status: 'error', attrs: { outcome: 'failed', status: 502, kind: 'transient', retryAfterMs: 1500 } });
    expect(spans.find((s) => s.name === 'call fail' && s.attrs?.status === 500 && s.status === 'error')!.attrs.kind).toBeUndefined();
  } finally {
    setTraceSink(null);
  }
});

test('an account that is not connected is an expected refusal; a rate limit is transient and says when to come back', async () => {
  const c = clients[0];
  const made = await c.admin({ do: 'create', kind: 'fake', label: 'Stopped', enabled: false });
  await until(() => c.accounts.some((a) => a.id === made.id), 4000, 'the stopped account visible');
  const off = (await c.call(testEcho, made.id, 'echo', { text: 'x' }).catch((x: any) => x)) as CallFailed;
  expect([off.code, off.kind]).toEqual(['offline', 'expected']);
  await c.admin({ do: 'delete', account: made.id, purge: true });

  const before = LIMITS.read;
  LIMITS.read = [0.5, 1];
  try {
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => c.call(testEcho, account, 'echo', { text: 'r' }).then(() => null, (e: CallFailed) => e)));
    const limited = outcomes.find((e) => e?.code === 'limited')!;
    expect(limited.kind).toBe('transient');
    // At 0.5 a second, a whole token is at most 2 s away.
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(2000);
  } finally {
    LIMITS.read = before;
    (m.router as any).buckets.clear();
  }
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
