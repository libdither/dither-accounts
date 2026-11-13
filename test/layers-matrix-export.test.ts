/**
 * An account's dependency chain (status.layers) as the page gets it, the Apps page's grant matrix, what apps get of a
 * status's live view (its size, never its VNC socket), and handing a chat account the manager made back to dither-chat's
 * hub (cli.ts export-to-dither-chat), against a manager on a temp dir and port with the fake extractors.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import type { AccountDetail, GrantMatrix, ManagerState } from '../packages/manager/src/api-types.ts';
import { lastDays, layersOf } from '../packages/manager/src/http.ts';
import { forApps } from '../packages/manager/src/router.ts';
import { newToken, Store } from '../packages/manager/src/db.ts';
import { CLI_HEADER, CLI_TOKEN_FILE } from '../packages/manager/src/auth.ts';
import { accountProcesses } from '../packages/manager/src/supervisor.ts';

const CLI = resolve(import.meta.dir, '../packages/manager/src/cli.ts');
/** Nothing listens here: the CLI then works on the registry directly (and never finds the live manager on 8486). */
const NO_MANAGER = 'http://127.0.0.1:1';
/** A live view's socket that nothing listens on (only reported, never opened). */
const VIEW_SOCKET = '/nonexistent/dither-accounts-test/vnc.sock';

let m: Manager;
let dir: string;
const clients: AccountsClient[] = [];
const events: Record<string, { t: string; [k: string]: unknown }[]> = {};
const lateEvents: Record<string, { t: string; [k: string]: unknown }[]> = {};

const until = async (f: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const get = async <T>(path: string): Promise<T> => (await (await fetch(m.url + path)).json()) as T;
const info = async (id: string) => (await get<ManagerState>('/api/state')).accounts.find((a) => a.id === id)!;
/** The CLI in a child process (not spawnSync: the manager answering it runs in this process's event loop). */
async function cli(...args: string[]) {
  // This manager's data dir, so the tool sends its token (never the machine's own manager's).
  if (!args.includes('--data')) args.push('--data', join(dir, 'mgr'));
  const p = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { exitCode: await p.exited, out, err };
}

let admin: { app: string; token: string };
let reader: { app: string; token: string };
let c: AccountsClient;
let plain: string;
let failing: string;
let silent: string;
let withView: string;
let chatAcc: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-layers-'));
  mkdirSync(join(dir, 'mgr'));
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0 });
  admin = await register(m.url, {
    name: 'runner',
    requests: [
      { interface: 'accounts', level: 'manage', kinds: ['fake', 'chat-fake'] },
      { interface: 'test.echo', level: 'manage' },
      { interface: 'chat', level: 'write' },
    ],
  });
  reader = await register(m.url, { name: 'reader', requests: [{ interface: 'test.echo', level: 'write' }] });
  const st = await get<ManagerState>('/api/state');
  for (const app of st.apps) for (const r of app.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: JSON.stringify(app.id === reader.app ? { dryRun: true } : {}) });
  c = new AccountsClient({ url: m.url, app: admin.app, token: admin.token, onEvents: (a, evs) => (events[a] ??= []).push(...(evs as any)) });
  clients.push(c);
  await until(() => c.connected, 4000, 'connected');
  plain = (await c.admin({ do: 'create', kind: 'fake', label: 'Plain' })).id;
  failing = (await c.admin({ do: 'create', kind: 'fake', label: 'Failing', config: { failLayer: 'session', failNote: 'the session ran out' } })).id;
  silent = (await c.admin({ do: 'create', kind: 'fake', label: 'Silent', config: { noLayers: true } })).id;
  // Nothing listens on this socket: the live view is only reported, never opened here.
  withView = (await c.admin({ do: 'create', kind: 'fake', label: 'With a view', config: { vncSocket: VIEW_SOCKET } })).id;
  chatAcc = (await c.admin({ do: 'create', kind: 'chat-fake', label: 'Chat' })).id;
  await until(() => [plain, failing, silent, withView, chatAcc].every((id) => c.accounts.find((a) => a.id === id)?.online), 15_000, 'every account online');
  await until(() => [plain, failing, silent, withView, chatAcc].every((id) => m.router.lastEvent(id, 'status')), 5000, 'their statuses');
}, 30_000);
afterAll(async () => {
  for (const x of clients) x.close();
  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- layers

test('layers: the chain an extractor sends reaches the page whole, in order', async () => {
  const a = await info(plain);
  expect(a.layers).toEqual([
    { name: 'process', state: 'ok', note: expect.stringMatching(/^pid \d+$/) },
    { name: 'session', state: 'ok', note: 'always signed in' },
    { name: 'echo', state: 'ok', note: 'answers at once' },
  ]);
  const d = await get<AccountDetail>(`/api/accounts/${plain}`);
  expect(d.layers).toEqual(a.layers);
  expect(d.account.layers).toEqual(a.layers);
});

test('layers: a failing one says why, and the ones after it wait', async () => {
  expect((await info(failing)).layers).toEqual([
    { name: 'process', state: 'ok', note: expect.any(String) },
    { name: 'session', state: 'failed', note: 'the session ran out' },
    { name: 'echo', state: 'waiting', note: 'waits for session' },
  ]);
  // A chat extractor through dither-chat's adapter client says the same.
  expect((await info(chatAcc)).layers?.map((l) => `${l.name}:${l.state}`)).toEqual(['network:ok', 'signed in:ok', 'snapshot:ok']);
});

test('layers: none sent, none shown', async () => {
  expect((await info(silent)).layers).toBeNull();
  expect((await get<AccountDetail>(`/api/accounts/${silent}`)).layers).toBeNull();
});

test('layers: only well-formed ones are kept', () => {
  expect(layersOf(undefined)).toBeNull();
  expect(layersOf('ok')).toBeNull();
  expect(layersOf([])).toBeNull();
  expect(layersOf([{ name: 'a', state: 'ok' }, { name: 'b', state: 'broken' }, { state: 'ok' }, null, { name: ' c ', state: 'off', note: '  ' }, { name: 'd', state: 'waiting', note: 'x'.repeat(500) }])).toEqual([
    { name: 'a', state: 'ok' },
    { name: 'c', state: 'off' },
    { name: 'd', state: 'waiting', note: 'x'.repeat(400) },
  ]);
});

// ---------------------------------------------------------------- the live view's socket stays here

test('apps get a live view without its VNC socket; the manager keeps the socket', async () => {
  await until(() => !!events[withView]?.some((e) => e.t === 'status'), 5000, 'the status at the app');
  const st = events[withView].filter((e) => e.t === 'status').at(-1)!;
  expect(st.liveView).toEqual({ width: 800, height: 600 });
  expect(JSON.stringify(events[withView])).not.toContain('vncSocket');
  expect(JSON.stringify(events[withView])).not.toContain(VIEW_SOCKET);
  expect(c.accounts.find((a) => a.id === withView)!.liveView).toBe(true);
  // The manager's own page and live view still have it.
  expect((m.router.lastEvent(withView, 'status')!.liveView as any).vncSocket).toBe(VIEW_SOCKET);
  expect(m.router.liveView(withView)).toEqual({ vncSocket: VIEW_SOCKET, width: 800, height: 600 });
  expect(((await get<AccountDetail>(`/api/accounts/${withView}`)).status!.liveView as any).vncSocket).toBe(VIEW_SOCKET);
  expect((await info(withView)).liveView).toBe(true);
});

test('an app that connects later, or was away, gets the state without the socket too', async () => {
  // Later: the account's last status, sent as it connects.
  const late = new AccountsClient({ url: m.url, app: admin.app, token: admin.token, onEvents: (a, evs) => (lateEvents[a] ??= []).push(...(evs as any)) });
  clients.push(late);
  await until(() => !!lateEvents[withView]?.some((e) => e.t === 'status'), 5000, 'the state at the late app');
  expect(lateEvents[withView].find((e) => e.t === 'status')!.liveView).toEqual({ width: 800, height: 600 });
  // Away: what waited for it.
  late.close();
  c.close();
  await until(() => !m.router.connected(admin.app), 3000, 'the app away');
  await m.sup.restart(withView);
  await until(() => m.sup.state(withView).online && !!m.router.lastEvent(withView, 'status'), 10_000, 'back online');
  await Bun.sleep(200);
  const back: { t: string; [k: string]: unknown }[] = [];
  c = new AccountsClient({ url: m.url, app: admin.app, token: admin.token, onEvents: (a, evs) => a === withView && back.push(...(evs as any)) });
  clients.push(c);
  await until(() => back.some((e) => e.t === 'status'), 5000, 'the held status');
  expect(JSON.stringify(back)).not.toContain('vncSocket');
  expect(back.find((e) => e.t === 'status')!.liveView).toEqual({ width: 800, height: 600 });
}, 30_000);

test('forApps leaves everything else as it is', () => {
  const ev: { t: string; [k: string]: unknown } = { t: 'status', status: 'online', liveView: { vncSocket: '/x/vnc.sock', width: 1, height: 2 }, layers: [] };
  expect(forApps(ev)).toEqual({ t: 'status', status: 'online', liveView: { width: 1, height: 2 }, layers: [] });
  expect((ev.liveView as { vncSocket: string }).vncSocket).toBe('/x/vnc.sock');
  // Only the size passes, whatever else an extractor puts there (an older one's port).
  expect(forApps<{ t: string; [k: string]: unknown }>({ t: 'status', liveView: { vncPort: 5999, path: '/x', width: 1, height: 2 } })).toEqual({ t: 'status', liveView: { width: 1, height: 2 } });
  expect(forApps({ t: 'status', status: 'online', liveView: null })).toEqual({ t: 'status', status: 'online', liveView: null });
  const msg = { t: 'message', liveView: { vncPort: 1 } };
  expect(forApps(msg)).toBe(msg);
});

// ---------------------------------------------------------------- the grant matrix

test('the matrix: levels per interface, running, dry run, and calls per day with the failed ones', async () => {
  await until(() => c.connected, 4000, 'connected');
  const r = new AccountsClient({ url: m.url, app: reader.app, token: reader.token });
  clients.push(r);
  await until(() => r.connected && r.accounts.some((a) => a.id === plain), 4000, 'the reader');
  for (let i = 0; i < 3; i++) await c.call(testEcho, plain, 'echo', { text: 'x' });
  await c.call(testEcho, plain, 'fail', { status: 500 }).catch(() => {});
  await r.call(testEcho, plain, 'shout', { text: 'dry' });
  // The reader holds no chat grant: its call to the chat account is denied, and counted.
  await r.callRaw(chatAcc, 'send', { conversation: 'dm:me:alice', body: 'no' }).catch(() => {});

  const mx = await get<GrantMatrix>('/api/matrix');
  expect(mx.days).toEqual(lastDays(7));
  expect(mx.days.at(-1)).toBe(new Date().toISOString().slice(0, 10));
  const cell = (app: string, acc: string) => mx.cells.find((x) => x.app === app && x.account === acc);

  const mine = cell(admin.app, plain)!;
  expect(mine).toMatchObject({ grants: { 'test.echo': 'manage' }, manages: true, dryRun: false });
  expect(mine.calls).toHaveLength(7);
  expect(mine.calls.at(-1)).toEqual({ n: 4, bad: 1 });
  expect(mine.calls.slice(0, 6).every((d) => d.n === 0 && d.bad === 0)).toBe(true);

  expect(cell(admin.app, chatAcc)).toMatchObject({ grants: { chat: 'write' }, manages: true, dryRun: false });
  const theirs = cell(reader.app, plain)!;
  expect(theirs).toMatchObject({ grants: { 'test.echo': 'write' }, manages: false, dryRun: true });
  expect(theirs.calls.at(-1)).toEqual({ n: 1, bad: 0 });
  // The reader holds nothing on the chat account, but its refused call shows there.
  const refused = cell(reader.app, chatAcc)!;
  expect(refused.grants).toEqual({});
  expect(refused.calls.at(-1)).toEqual({ n: 1, bad: 1 });
  expect((await get<GrantMatrix>('/api/matrix?days=30')).days).toHaveLength(30);
});

// ---------------------------------------------------------------- export-to-dither-chat

/** A dither-chat data dir with the hub's account table. */
function hubData(name: string, ids: string[]): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  const db = new Database(join(d, 'hub.sqlite'), { create: true });
  db.exec('CREATE TABLE account (id TEXT PRIMARY KEY, adapter TEXT)');
  for (const id of ids) db.query('INSERT INTO account VALUES (?, ?)').run(id, 'chat-fake');
  db.close();
  return d;
}
/** A session's worth of files in an account's directory: nested, a secret, a link. */
function seed(accDir: string) {
  mkdirSync(join(accDir, 'store', 'deep'), { recursive: true });
  writeFileSync(join(accDir, 'store', 'deep', 'blob.bin'), crypto.getRandomValues(new Uint8Array(200_000)));
  writeFileSync(join(accDir, 'state.json'), '{"since":"s1"}');
  writeFileSync(join(accDir, 'secret.json'), '{"token":"t"}', { mode: 0o600 });
  symlinkSync('store/deep/blob.bin', join(accDir, 'latest'));
}

test('export-to-dither-chat: refuses an account that is not a chat kind, and a target that exists', async () => {
  const hub = hubData('hub-refuse', [chatAcc]);
  const notChat = await cli('export-to-dither-chat', plain, '--hub-data', hub, '--url', m.url);
  expect(notChat.exitCode).toBe(1);
  expect(notChat.err).toContain('not a chat one');
  mkdirSync(join(hub, 'accounts', chatAcc), { recursive: true });
  const taken = await cli('export-to-dither-chat', chatAcc, '--hub-data', hub, '--url', m.url);
  expect(taken.exitCode).toBe(1);
  expect(taken.err).toContain('already exists');
  // Neither touched the account.
  expect(m.store.account(plain)!.enabled).toBe(1);
  expect(m.store.account(chatAcc)!.enabled).toBe(1);
  expect(m.sup.state(chatAcc).online).toBe(true);
}, 20_000);

test('export-to-dither-chat: stops it, copies its directory (not the lock), checks it, forgets it and keeps the original', async () => {
  const acc = m.store.account(chatAcc)!;
  expect(acc.dir).toBe(join(dir, 'mgr', 'accounts', chatAcc));
  expect(existsSync(join(acc.dir, 'extractor.lock'))).toBe(true);
  seed(acc.dir);
  const hub = hubData('hub-ok', [chatAcc]);
  const r = await cli('export-to-dither-chat', chatAcc, '--hub-data', hub, '--url', m.url);
  expect(r.err).toBe('');
  expect(r.exitCode).toBe(0);
  expect(r.out).toContain('checked');
  expect(r.out).not.toContain('note:');

  const to = join(hub, 'accounts', chatAcc);
  expect(readFileSync(join(to, 'store', 'deep', 'blob.bin'))).toEqual(readFileSync(join(acc.dir, 'store', 'deep', 'blob.bin')));
  expect(readFileSync(join(to, 'state.json'), 'utf8')).toBe('{"since":"s1"}');
  expect(statSync(join(to, 'secret.json')).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(to, 'latest')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(to, 'latest'))).toBe('store/deep/blob.bin');
  expect(existsSync(join(to, 'adapter.log'))).toBe(true);
  expect(existsSync(join(to, 'extractor.lock'))).toBe(false);
  expect(existsSync(join(hub, 'accounts', `.${chatAcc}.export`))).toBe(false);

  // Gone from the manager, stopped, its directory kept.
  expect(m.store.account(chatAcc)).toBeNull();
  expect(m.sup.state(chatAcc).running).toBe(false);
  expect(accountProcesses(chatAcc)).toEqual([]);
  expect(existsSync(join(acc.dir, 'state.json'))).toBe(true);
  await until(() => !c.accounts.some((a) => a.id === chatAcc), 3000, 'gone from the app');
}, 30_000);

test('export-to-dither-chat: refuses an account imported in place', async () => {
  const hubDir = join(dir, 'hub-imported', 'accounts', 'acc_importedChat1');
  mkdirSync(hubDir, { recursive: true });
  const res = await fetch(`${m.url}/api/accounts/import`, { method: 'POST', headers: { [CLI_HEADER]: readFileSync(join(dir, 'mgr', CLI_TOKEN_FILE), 'utf8').trim() }, body: JSON.stringify({ accounts: [{ id: 'acc_importedChat1', kind: 'chat-fake', label: 'Imported', enabled: false, dir: hubDir }] }) });
  expect(res.status).toBe(200);
  const r = await cli('export-to-dither-chat', 'acc_importedChat1', '--hub-data', hubData('hub-other', []), '--url', m.url);
  expect(r.exitCode).toBe(1);
  expect(r.err).toContain('imported in place');
  expect(m.store.account('acc_importedChat1')).not.toBeNull();
}, 20_000);

test('export-to-dither-chat with no manager running: the registry directly; a stale lock is left behind', async () => {
  const data = join(dir, 'offline');
  mkdirSync(join(data, 'accounts'), { recursive: true });
  const s = new Store(join(data, 'accounts.sqlite'));
  const id = 'acc_offlineChat1';
  const accDir = join(data, 'accounts', id);
  mkdirSync(accDir);
  seed(accDir);
  writeFileSync(join(accDir, 'extractor.lock'), JSON.stringify({ pid: 999_999_999, owner: 'dither-accounts' }));
  const now = Date.now();
  s.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)', id, 'chat-fake', 'Offline', '{}', newToken(), accDir, now, now);
  s.db.close();
  const hub = hubData('hub-offline', []);
  const r = await cli('export-to-dither-chat', id, '--hub-data', hub, '--url', NO_MANAGER, '--data', data);
  expect(r.exitCode).toBe(0);
  expect(r.out).toContain(`note: the hub's database has no account ${id}`);
  expect(existsSync(join(hub, 'accounts', id, 'store', 'deep', 'blob.bin'))).toBe(true);
  expect(existsSync(join(hub, 'accounts', id, 'extractor.lock'))).toBe(false);
  const again = new Store(join(data, 'accounts.sqlite'));
  expect(again.account(id)).toBeNull();
  again.db.close();
  expect(existsSync(join(accDir, 'secret.json'))).toBe(true);
}, 20_000);
