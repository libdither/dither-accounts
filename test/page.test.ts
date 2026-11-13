/** The manager's page API: account details, log, files, live view, running ops from the page, adding and removing. */
import type { UnixSocketListener } from 'bun';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager, type Manager } from '@dither-accounts/manager';
import { CLI_HEADER, CLI_TOKEN_FILE } from '../packages/manager/src/auth.ts';
import type { AccountDetail, DirListing, ManagerState, PageCallResult } from '../packages/manager/src/api-types.ts';

let m: Manager;
let dir: string;
let vnc: UnixSocketListener<undefined>;
let vncSocket: string;
const got: string[] = [];

const until = async (f: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = async <T = any>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
  const r = await fetch(m.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as T };
};

let id: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-page-'));
  // A stand-in VNC server on a Unix socket, as x11vnc's is: says the RFB greeting and records what comes back.
  vncSocket = join(dir, 'vnc.sock');
  vnc = Bun.listen({
    unix: vncSocket,
    socket: {
      open: (s) => void s.write('RFB 003.008\n'),
      data: (_s, d) => void got.push(Buffer.from(d).toString()),
    },
  });
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.get('fake')!.add = { blurb: 'for tests' };
});
afterAll(async () => {
  await m.stop();
  vnc.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('kinds the page may add say so; others are refused', async () => {
  const st = (await api<ManagerState>('/api/state')).body;
  expect(st.kinds.find((k) => k.kind === 'fake')!.add).toEqual({ blurb: 'for tests' });
  // The chat networks are added here too, Matrix with its form; the test kinds and Google's API way are not.
  for (const k of ['discord', 'signal', 'whatsapp']) expect(st.kinds.find((x) => x.kind === k)!.add?.next).toBeTruthy();
  expect(st.kinds.find((k) => k.kind === 'matrix')!.add!.fields!.map((f) => [f.key, !!f.secret])).toEqual([['homeserver', false], ['userId', false], ['password', true]]);
  expect(st.kinds.find((k) => k.kind === 'chat-fake')!.add).toBeNull();
  expect(st.kinds.find((k) => k.kind === 'google-api')!.add).toBeNull();
  expect((await api('/api/accounts', 'POST', { kind: 'chat-fake', label: 'x' })).status).toBe(400);
  const made = await api<{ id: string }>('/api/accounts', 'POST', { kind: 'fake', label: 'Page fake', config: { vncSocket, apiToken: 'hush' } });
  expect(made.status).toBe(200);
  id = made.body.id;
  await until(async () => (await api<ManagerState>('/api/state')).body.accounts.find((a) => a.id === id)?.online === true, 10_000, 'online');
});

test('the state carries who it is signed in as and that it has a live view', async () => {
  await until(async () => (await api<ManagerState>('/api/state')).body.accounts.find((a) => a.id === id)?.liveView === true, 5000, 'live view');
  const a = (await api<ManagerState>('/api/state')).body.accounts.find((x) => x.id === id)!;
  expect(a.self).toEqual({ name: 'Fake', detail: 'fake-one', avatar: null });
  expect(a.interfaces).toEqual(['test.echo']);
});

test('details: process, masked config, secret keys only, hello and status, who has access', async () => {
  writeFileSync(join(m.store.account(id)!.dir, 'secret.json'), JSON.stringify({ password: 'pw', user: 'u' }));
  const d = (await api<AccountDetail>(`/api/accounts/${id}`)).body;
  expect(d.process.pid).toBeGreaterThan(0);
  expect(d.process.starts).toBe(1);
  expect(d.process.lock?.owner).toBe('dither-accounts');
  expect(d.config).toEqual({ vncSocket, apiToken: '••••' });
  expect(d.secret).toEqual({ present: true, keys: ['password', 'user'] });
  expect(JSON.stringify(d)).not.toContain('"pw"');
  expect(d.hello?.t).toBe('hello');
  expect((d.status?.liveView as any).vncSocket).toBe(vncSocket);
  expect(d.access).toEqual([]);
});

test('log tail and files', async () => {
  await until(async () => (await api<{ lines: string[] }>(`/api/accounts/${id}/log?lines=50`)).body.lines.some((l) => l.includes('fake extractor up')), 5000, 'the log line');
  const f = (await api<DirListing>(`/api/accounts/${id}/files`)).body;
  expect(f.exists).toBe(true);
  expect(f.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['adapter.log', 'extractor.lock', 'secret.json']));
  expect(f.size).toBeGreaterThan(0);
});

test('running an op from the page: input checked, counted as the page, dry run, no op', async () => {
  const ok = (await api<PageCallResult>(`/api/accounts/${id}/call`, 'POST', { op: 'echo', input: { text: 'hi' } })).body;
  expect(ok.ok).toBe(true);
  expect(ok.result).toEqual({ text: 'hi' });
  const bad = (await api<PageCallResult>(`/api/accounts/${id}/call`, 'POST', { op: 'echo', input: { text: 1 } })).body;
  expect(bad.error?.code).toBe('invalid');
  const dry = (await api<PageCallResult>(`/api/accounts/${id}/call`, 'POST', { op: 'shout', input: { text: 'x' }, dryRun: true })).body;
  expect(dry.result).toEqual({ dryRun: true });
  const up = (await api<PageCallResult>(`/api/accounts/${id}/call`, 'POST', { op: 'fail', input: { status: 404 } })).body;
  expect(up.error).toEqual({ code: 'failed', message: 'failed with 404', status: 404 });
  expect((await api<PageCallResult>(`/api/accounts/${id}/call`, 'POST', { op: 'nope' })).body.error?.code).toBe('unknown-op');
  const d = (await api<AccountDetail>(`/api/accounts/${id}`)).body;
  expect(d.activity.find((r) => r.op === 'echo' && r.outcome === 'ok')?.app).toBe('page');
  // A cross-site page cannot run ops.
  expect((await api(`/api/accounts/${id}/call`, 'POST', { op: 'echo', input: { text: 'x' } }, { origin: 'https://evil.example' })).status).toBe(403);
});

test('the live view carries a browser socket to the VNC socket, from our origin only', async () => {
  const url = `${m.url.replace('http', 'ws')}/api/liveview/${id}`;
  const ws = new WebSocket(url, ['binary']);
  ws.binaryType = 'arraybuffer';
  const first = await new Promise<string>((res, rej) => {
    ws.onmessage = (e) => res(Buffer.from(e.data as ArrayBuffer).toString());
    ws.onerror = () => rej(new Error('socket failed'));
  });
  expect(first).toBe('RFB 003.008\n');
  ws.send(new TextEncoder().encode('RFB 003.008\n'));
  await until(() => got.join('').includes('RFB 003.008'), 3000, 'the reply at the VNC socket');
  ws.close();
  const r = await fetch(`${m.url}/api/liveview/${id}`, { headers: { origin: 'https://evil.example', upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
  expect(r.status).toBe(403);
});

test('a live view that is not a socket of ours is not connected to', async () => {
  // A path that is a plain file: the socket closes at once with why, and nothing is read from it.
  const notSocket = join(dir, 'not-a-socket');
  writeFileSync(notSocket, 'RFB 003.008\n');
  const other = (await api<{ id: string }>('/api/accounts', 'POST', { kind: 'fake', label: 'No socket', config: { vncSocket: notSocket } })).body.id;
  await until(async () => (await api<ManagerState>('/api/state')).body.accounts.find((a) => a.id === other)?.liveView === true, 10_000, 'its live view');
  const ws = new WebSocket(`${m.url.replace('http', 'ws')}/api/liveview/${other}`, ['binary']);
  const closed = await new Promise<{ code: number; reason: string; data: boolean }>((res) => {
    let data = false;
    ws.onmessage = () => (data = true);
    ws.onclose = (e) => res({ code: e.code, reason: e.reason, data });
  });
  expect(closed).toEqual({ code: 1011, reason: 'the live view is not listening', data: false });
  expect((await api(`/api/accounts/${other}`, 'DELETE')).status).toBe(200);
});

test('an add form: its fields go to the config or to secret.json, checked first', async () => {
  const fake = m.kinds.get('fake')!;
  const was = fake.add;
  fake.add = {
    blurb: 'for tests',
    fields: [
      { key: 'server', label: 'Server', pattern: '^https://', hint: 'an https URL' },
      { key: 'region', label: 'Region', optional: true, default: 'eu' },
      { key: 'password', label: 'Password', secret: true },
    ],
  };
  try {
    const before = m.store.accounts().length;
    expect((await api('/api/accounts', 'POST', { kind: 'fake', config: {}, secret: { password: 'pw' } })).body.error).toBe('Server is needed');
    expect((await api('/api/accounts', 'POST', { kind: 'fake', config: { server: 'http://x' }, secret: { password: 'pw' } })).body.error).toBe('Server: an https URL');
    expect((await api('/api/accounts', 'POST', { kind: 'fake', config: { server: 'https://x' } })).body.error).toBe('Password is needed');
    expect(m.store.accounts().length).toBe(before);
    // A secret sent as config is not kept there.
    const r = await api<{ id: string }>('/api/accounts', 'POST', { kind: 'fake', label: 'Form', config: { server: ' https://x ', password: 'leak' }, secret: { password: 'pw' } });
    expect(r.status).toBe(200);
    const a = m.store.account(r.body.id)!;
    expect(JSON.parse(a.config)).toEqual({ server: 'https://x', region: 'eu' });
    const sec = join(a.dir, 'secret.json');
    expect(JSON.parse(readFileSync(sec, 'utf8'))).toEqual({ password: 'pw' });
    expect(statSync(sec).mode & 0o777).toBe(0o600);
    expect((await api<AccountDetail>(`/api/accounts/${r.body.id}`)).body.secret).toEqual({ present: true, keys: ['password'] });
    await api(`/api/accounts/${r.body.id}?purge=1`, 'DELETE');
  } finally {
    fake.add = was;
  }
  // Matrix checks its form the same way, before anything starts.
  expect((await api('/api/accounts', 'POST', { kind: 'matrix', config: { userId: 'nobody' }, secret: { password: 'pw' } })).body.error).toBe('User ID: a Matrix ID looks like @name:server.org');
});

test('the interface types are served', async () => {
  const t = (await api<{ types: Record<string, any> }>('/api/interfaces')).body.types;
  expect(t['test.echo'].ops.echo.input).toBe('{ text: string }');
});

test('who it was signed in as is kept while it is stopped; an empty nickname names it by its kind again', async () => {
  const st = async () => (await api<ManagerState>('/api/state')).body.accounts.find((a) => a.id === id)!;
  expect((await st()).seenAs).toEqual({ name: 'Fake', detail: 'fake-one', avatar: null });
  expect(JSON.parse(m.store.account(id)!.seen_as)).toEqual({ displayName: 'Fake', handle: 'fake-one' });
  await api(`/api/accounts/${id}`, 'PATCH', { enabled: false });
  await until(async () => !(await st()).running, 5000, 'stopped');
  const off = await st();
  expect(off.self).toBeNull();
  expect(off.seenAs).toEqual({ name: 'Fake', detail: 'fake-one', avatar: null });
  // "Page fake" is a nickname; clearing it leaves the kind's name, as for an account added without one.
  expect(off.label).toBe('Page fake');
  await api(`/api/accounts/${id}`, 'PATCH', { label: '  ' });
  expect((await st()).label).toBe(m.kinds.get('fake')!.name);
  await api(`/api/accounts/${id}`, 'PATCH', { label: 'Page fake', enabled: true });
  await until(async () => (await st()).online, 10_000, 'online again');
});

test('removing an account stops it and keeps its directory', async () => {
  const before = m.store.account(id)!.dir;
  expect((await api<ManagerState>('/api/state')).body.accounts.find((a) => a.id === id)!.ownDir).toBe(true);
  const r = await api<{ dir: string; purged: boolean }>(`/api/accounts/${id}`, 'DELETE');
  expect(r.body).toMatchObject({ dir: before, purged: false });
  expect(m.store.account(id)).toBeNull();
  expect(m.sup.state(id).running).toBe(false);
  expect(Bun.file(join(before, 'adapter.log')).size).toBeGreaterThan(0);
});

test('purging deletes a directory the manager made, never one imported in place', async () => {
  const made = (await api<{ id: string }>('/api/accounts', 'POST', { kind: 'fake', label: 'Doomed' })).body.id;
  const own = m.store.account(made)!.dir;
  await until(() => m.sup.state(made).online, 10_000, 'online');
  const r = await api<{ purged: boolean }>(`/api/accounts/${made}?purge=1`, 'DELETE');
  expect(r.body.purged).toBe(true);
  expect(existsSync(own)).toBe(false);

  const elsewhere = join(dir, 'elsewhere', 'acc_importedPage1');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'session'), 'keep me');
  expect((await api('/api/accounts/import', 'POST', { accounts: [{ id: 'acc_importedPage1', kind: 'fake', label: 'Imported', dir: elsewhere }] }, { [CLI_HEADER]: readFileSync(join(dir, CLI_TOKEN_FILE), 'utf8').trim() })).status).toBe(200);
  expect((await api<ManagerState>('/api/state')).body.accounts.find((a) => a.id === 'acc_importedPage1')!.ownDir).toBe(false);
  const kept = await api<{ purged: boolean; why: string }>('/api/accounts/acc_importedPage1?purge=1', 'DELETE');
  expect(kept.body).toMatchObject({ purged: false, why: expect.stringContaining('imported in place') });
  expect(readFileSync(join(elsewhere, 'session'), 'utf8')).toBe('keep me');
});
