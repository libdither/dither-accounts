/**
 * The manager's own notices (packages/manager/src/notices.ts, docs/notifications.md), end to end on a fresh manager:
 * the built-in `notices` account in an app's list, notify.new when a fake account keeps an attention and notify.read
 * when it goes, a stopped account, crashes, an approval for a device that is not paired, notify.list / markRead /
 * markAllRead / mute, the debounce, grants (an app without `notifications` hears nothing), what the page may not do to
 * it, and the notices kept across a restart.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { type Notification, notifications } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';

let m: Manager;
let dir: string;
const clients: AccountsClient[] = [];
const TIMES = { attentionMs: 400, stoppedMs: 400, debounceMs: 60_000, sweepMs: 50, crashWindowMs: 60_000, crashes: 3 };

const until = async (f: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, method = 'GET', body?: unknown) => fetch(m.url + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const approveAll = async () => {
  const st = (await (await api('/api/state')).json()) as any;
  for (const app of st.apps) for (const r of app.requests) if (r.state === 'pending') await api(`/api/requests/${r.id}/approve`, 'POST', {});
};

type Got = { account: string; ev: { t: string; [k: string]: unknown } };
function client(reg: { app: string; token: string }) {
  const got: Got[] = [];
  const c = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (account, evs) => got.push(...evs.map((ev) => ({ account, ev }))) });
  clients.push(c);
  return { c, got };
}

let app: { c: AccountsClient; got: Got[] };
let appReg: { app: string; token: string };
let other: { c: AccountsClient; got: Got[] };
let admin: { c: AccountsClient; got: Got[] };
const news = () => app.got.filter((g) => g.account === 'notices' && g.ev.t === 'notify.new').map((g) => g.ev.notification as Notification);
const reads = () => app.got.filter((g) => g.account === 'notices' && g.ev.t === 'notify.read').flatMap((g) => g.ev.ids as string[]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-notices-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, publicUrl: 'https://accounts.example.net', noticeTimes: TIMES });
  const a = await register(m.url, { name: 'notices-app', requests: [{ interface: 'notifications', level: 'write', accounts: '*' }] });
  const o = await register(m.url, { name: 'echo-app', requests: [{ interface: 'test.echo', level: 'read' }] });
  const ad = await register(m.url, { name: 'admin-app', requests: [{ interface: 'accounts', level: 'manage' }, { interface: 'test.echo', level: 'read' }] });
  await approveAll();
  appReg = a;
  app = client(a);
  other = client(o);
  admin = client(ad);
  await until(() => app.c.connected && other.c.connected && admin.c.connected, 15_000, 'connected');
}, 30_000);
afterAll(async () => {
  for (const c of clients) c.close();
  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('the built-in account: in an app’s list as online, never started, not managed', async () => {
  await until(() => app.c.accounts?.some((a) => a.id === 'notices'), 4000, 'notices listed');
  expect(app.c.accounts.find((a) => a.id === 'notices')).toMatchObject({ id: 'notices', kind: 'notices', label: 'dither-accounts', interfaces: ['notifications'], running: true, online: true, enabled: true, error: null, grants: { notifications: 'write' }, manages: false, liveView: false });
  // An app with any-kind manage sees no account of it to manage, and cannot touch it.
  expect(admin.c.accounts.some((a) => a.id === 'notices')).toBe(false);
  for (const action of [{ do: 'delete', account: 'notices' }, { do: 'stop', account: 'notices' }, { do: 'update', account: 'notices', enabled: false }] as const) {
    const e = (await admin.c.admin(action as any).catch((x) => x)) as CallFailed;
    expect(e).toBeInstanceOf(CallFailed);
    expect(e.code).toBe('denied');
  }
  expect(((await admin.c.admin({ do: 'create', kind: 'notices', label: 'x' }).catch((x) => x)) as CallFailed).code).toBe('invalid');
  // Nor can the page: no restart, disable or remove.
  expect((await api('/api/accounts/notices', 'DELETE')).status).toBe(409);
  expect((await api('/api/accounts/notices/restart', 'POST')).status).toBe(409);
  expect((await api('/api/accounts/notices', 'PATCH', { enabled: false })).status).toBe(409);
  const st = (await (await api('/api/state')).json()) as any;
  expect(st.accounts.find((a: any) => a.id === 'notices')).toMatchObject({ builtin: true, online: true, running: true, error: null, enabled: true });
  expect(st.kinds.find((k: any) => k.kind === 'notices')).toMatchObject({ name: 'dither-accounts', add: null });
  expect(await app.c.call(notifications, 'notices', 'notify.list', {})).toEqual({ notifications: [], next: null });
});

let fake: string;
test('an attention held 2 minutes (here 400 ms) is a high notice; gone, it is read', async () => {
  fake = (await admin.c.admin({ do: 'create', kind: 'fake', label: 'Fakebook', config: { attention: 'Sign in again in the live view' } })).id;
  await until(() => news().length === 1, 10_000, 'notify.new');
  const n = news()[0];
  expect(n).toEqual({
    id: `attention:${fake}`,
    source: 'dither-accounts',
    title: 'Fakebook needs you',
    // Never the extractor's own words (they may hold a password hint or a code): what its kind means.
    body: 'It needs you to sign in again: open its page on the manager.',
    url: `https://accounts.example.net/#/accounts/${fake}`,
    reason: 'attention',
    context: 'fake',
    subject: { kind: 'account', title: 'Fakebook', url: `https://accounts.example.net/#/accounts/${fake}`, state: 'attention' },
    actors: [],
    at: expect.any(Number),
    unread: true,
    urgency: 'high',
  });
  // Once, though it is still there.
  await Bun.sleep(300);
  expect(news().length).toBe(1);
  expect((await app.c.call(notifications, 'notices', 'notify.list', { unreadOnly: true })).notifications.map((x) => x.id)).toEqual([`attention:${fake}`]);
  // Signed in again: read.
  await admin.c.admin({ do: 'update', account: fake, config: {} });
  await admin.c.admin({ do: 'restart', account: fake });
  await until(() => reads().includes(`attention:${fake}`), 10_000, 'notify.read');
  expect((await app.c.call(notifications, 'notices', 'notify.list', { unreadOnly: true })).notifications).toEqual([]);
  expect((await app.c.call(notifications, 'notices', 'notify.list', {})).notifications[0]).toMatchObject({ id: `attention:${fake}`, unread: false });
});

test('debounced: the same attention back within 30 minutes is not announced again', async () => {
  await admin.c.admin({ do: 'update', account: fake, config: { attention: 'Again' } });
  await admin.c.admin({ do: 'restart', account: fake });
  await until(() => m.router.lastStatus(fake)?.status === 'attention', 10_000, 'the attention back');
  await Bun.sleep(TIMES.attentionMs + 400);
  expect(news().length).toBe(1);
  await admin.c.admin({ do: 'update', account: fake, config: {} });
  await admin.c.admin({ do: 'restart', account: fake });
  await until(() => m.router.lastStatus(fake)?.status === 'online', 10_000, 'online again');
});

test('a device-linking attention is announced without its message (it may hold a pairing code)', async () => {
  const id = (await admin.c.admin({ do: 'create', kind: 'fake', label: 'Linky', config: { attention: 'Enter ABCD-1234 on your phone', attentionKind: 'link_device' } })).id;
  await until(() => news().some((n) => n.id === `attention:${id}`), 10_000, 'the link notice');
  const n = news().find((x) => x.id === `attention:${id}`)!;
  expect(n.body).not.toContain('ABCD');
  expect(n.body).toBe('It waits to be linked with your phone: open its page on the manager.');
  // Disabled: what it said no longer holds.
  await admin.c.admin({ do: 'update', account: id, enabled: false });
  await until(() => reads().includes(`attention:${id}`), 10_000, 'read when disabled');
});

test('an attention beside a passing state (connecting: an outage) is not "needs you"; a label is named on one line', async () => {
  const id = (await admin.c.admin({ do: 'create', kind: 'fake', label: 'Out\nage', config: { attention: 'Cannot reach it. Trying again in 30 s', attentionStatus: 'connecting' } })).id;
  await until(() => m.router.lastStatus(id)?.status === 'connecting', 10_000, 'connecting');
  await Bun.sleep(TIMES.attentionMs + 400);
  expect(news().some((n) => n.id === `attention:${id}`)).toBe(false);
  // Now it waits on you, with a hint in its message: announced, the hint left out, the label on one line.
  await admin.c.admin({ do: 'update', account: id, config: { attention: 'Enter your password (hint: “my dog”)', attentionKind: 'login' } });
  await admin.c.admin({ do: 'restart', account: id });
  await until(() => news().some((n) => n.id === `attention:${id}`), 10_000, 'the notice');
  const n = news().find((x) => x.id === `attention:${id}`)!;
  expect(n.title).toBe('Out age needs you');
  expect(JSON.stringify(n)).not.toContain('my dog');
  await admin.c.admin({ do: 'update', account: id, enabled: false });
  await until(() => reads().includes(`attention:${id}`), 10_000, 'read when disabled');
});

test('an enabled account that cannot run (its directory locked) for 5 minutes (here 400 ms) is a high notice', async () => {
  const sleeper = Bun.spawn(['sleep', '60']);
  try {
    const id = (await admin.c.admin({ do: 'create', kind: 'fake', label: 'Locked', enabled: false })).id;
    const acc = m.store.account(id)!;
    writeFileSync(join(acc.dir, 'extractor.lock'), JSON.stringify({ pid: sleeper.pid, owner: 'another app', at: new Date().toISOString() }));
    await admin.c.admin({ do: 'update', account: id, enabled: true });
    await until(() => news().some((n) => n.id === `stopped:${id}`), 10_000, 'the stopped notice');
    expect(news().find((n) => n.id === `stopped:${id}`)).toMatchObject({ title: 'Locked stopped', body: 'It is not running: its page on the manager says why.', urgency: 'high', reason: 'stopped', context: 'fake' });
    await admin.c.admin({ do: 'update', account: id, enabled: false });
    await until(() => reads().includes(`stopped:${id}`), 10_000, 'read when disabled');
  } finally {
    sleeper.kill();
  }
});

test('an extractor that crashes 3 times in 10 minutes is a normal notice', async () => {
  const id = (await admin.c.admin({ do: 'create', kind: 'fake', label: 'Crashy', config: { crash: true } })).id;
  await until(() => news().some((n) => n.id === `crashing:${id}`), 20_000, 'the crash notice');
  expect(news().find((n) => n.id === `crashing:${id}`)).toMatchObject({ title: 'Crashy keeps restarting', urgency: 'normal', reason: 'crashing' });
  await admin.c.admin({ do: 'update', account: id, enabled: false });
}, 30_000);

test('a passkey approval asked of a device that is not paired is a high notice, at most once per 30 minutes', async () => {
  const acc = m.store.account(fake)!;
  const ask = { op: 'get', rpId: 'example.com', origin: 'https://example.com', clientDataJSON: '{}', device: 'dev_gone' };
  expect(await m.approvers.request(acc, ask)).toMatchObject({ ok: false, reason: 'no-device' });
  await until(() => news().some((n) => n.id === `no-device:${fake}`), 4000, 'the no-device notice');
  expect(news().find((n) => n.id === `no-device:${fake}`)).toMatchObject({ title: 'Fakebook: no device for a passkey approval', body: 'A sign-in for example.com asked for approval on a device that is not paired with this manager.', urgency: 'high', reason: 'no-device' });
  await m.approvers.request(acc, ask);
  await Bun.sleep(200);
  expect(news().filter((n) => n.id === `no-device:${fake}`).length).toBe(1);
});

test('notify.list pages newest first; markRead and markAllRead go out as notify.read; mute keeps an account quiet', async () => {
  const all = await app.c.call(notifications, 'notices', 'notify.list', {});
  expect(all.notifications.length).toBeGreaterThanOrEqual(5);
  const ats = all.notifications.map((n) => n.at);
  expect([...ats].sort((a, b) => b - a)).toEqual(ats);
  const p1 = await app.c.call(notifications, 'notices', 'notify.list', { limit: 2 });
  expect(p1.notifications.map((n) => n.id)).toEqual(all.notifications.slice(0, 2).map((n) => n.id));
  const p2 = await app.c.call(notifications, 'notices', 'notify.list', { limit: 2, pageToken: p1.next! });
  expect(p2.notifications.map((n) => n.id)).toEqual(all.notifications.slice(2, 4).map((n) => n.id));
  expect((await app.c.call(notifications, 'notices', 'notify.list', { since: all.notifications[0].at })).notifications[0].id).toBe(all.notifications[0].id);

  const unread = (await app.c.call(notifications, 'notices', 'notify.list', { unreadOnly: true })).notifications.map((n) => n.id);
  expect(unread).toContain(`no-device:${fake}`);
  await app.c.call(notifications, 'notices', 'notify.markRead', { ids: [`no-device:${fake}`] });
  await until(() => reads().includes(`no-device:${fake}`), 4000, 'read by markRead');
  await app.c.call(notifications, 'notices', 'notify.markAllRead', {});
  expect((await app.c.call(notifications, 'notices', 'notify.list', { unreadOnly: true })).notifications).toEqual([]);

  // Muted: Fakebook's attention, past its debounce, says nothing.
  await app.c.callRaw('notices', 'notify.mute', { id: `attention:${fake}` });
  m.store.run('UPDATE notice SET emitted_at = 0 WHERE subject = ?', fake);
  const before = news().length;
  await admin.c.admin({ do: 'update', account: fake, config: { attention: 'Muted' } });
  await admin.c.admin({ do: 'restart', account: fake });
  await until(() => m.router.lastStatus(fake)?.status === 'attention', 10_000, 'the attention');
  await Bun.sleep(TIMES.attentionMs + 400);
  expect(news().length).toBe(before);
  // Unmuted, the attention still there is announced.
  m.store.run('DELETE FROM notice_mute');
  await until(() => news().length === before + 1, 4000, 'announced once unmuted');
  expect(news().at(-1)).toMatchObject({ id: `attention:${fake}`, title: 'Fakebook needs you' });
  const e = (await app.c.callRaw('notices', 'notify.mute', { id: 'nope' }).catch((x) => x)) as CallFailed;
  expect(e.code).toBe('invalid');
});

test('grants apply: an app without notifications hears nothing of it and may not call it', async () => {
  expect(other.got.some((g) => g.account === 'notices')).toBe(false);
  expect(other.c.accounts.some((a) => a.id === 'notices')).toBe(false);
  expect(admin.got.some((g) => g.account === 'notices')).toBe(false);
  const e = (await other.c.callRaw('notices', 'notify.list', {}).catch((x) => x)) as CallFailed;
  expect(e.code).toBe('denied');
  // And notices hold no secrets: none carries the pairing code given to the linking account.
  expect(JSON.stringify(m.store.all('SELECT notification FROM notice'))).not.toContain('ABCD-1234');
});

test('a service on this machine says something with the CLI token: announced at once, replaced by its id, never swept', async () => {
  const cli = readFileSync(join(dir, 'cli.token'), 'utf8').trim();
  const post = (b: unknown, token: string | null = cli) =>
    fetch(`${m.url}/api/notices/local`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-dither-accounts-cli': token } : {}) }, body: JSON.stringify(b) });
  const say = { id: 'chat', source: 'deployer', title: 'Deployed dither-chat a14daa9', body: '#162, #163', context: 'dither-chat', urgency: 'low' };
  // Not without the CLI token, nor from a page.
  expect((await post(say, null)).status).toBe(401);
  expect((await post(say, 'not-the-token')).status).toBe(401);
  expect((await fetch(`${m.url}/api/notices/local`, { method: 'POST', headers: { origin: m.url, 'x-dither-accounts-cli': cli }, body: '{}' })).status).toBe(403);
  // What it says is checked.
  expect((await post({ ...say, id: 'no spaces' })).status).toBe(400);
  expect((await post({ ...say, url: 'javascript:alert(1)' })).status).toBe(400);
  expect((await post({ ...say, urgency: 'now' })).status).toBe(400);
  const before = news().length;
  const r = await post(say);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { notice: string }).notice).toBe('local:deployer:chat');
  await until(() => news().length > before, 5000, 'the local notice');
  const n = news().at(-1)!;
  expect(n).toMatchObject({ id: 'local:deployer:chat', source: 'deployer', title: 'Deployed dither-chat a14daa9', body: '#162, #163', reason: 'local', context: 'dither-chat', urgency: 'low', unread: true });
  // The same id again replaces it; the sweep (every 50 ms here) leaves it unread.
  await post({ ...say, title: 'Rolled back dither-chat to d8aa3b6', urgency: 'high' });
  await until(() => news().length > before + 1, 5000, 'the replacement');
  await Bun.sleep(300);
  const listed = await app.c.call(notifications, 'notices', 'notify.list', { unreadOnly: true });
  const mine = listed.notifications.filter((x) => x.id === 'local:deployer:chat');
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ title: 'Rolled back dither-chat to d8aa3b6', urgency: 'high', unread: true });
  expect(reads()).not.toContain('local:deployer:chat');
});

test('kept across a restart, not announced again, read or unread; the account is made once', async () => {
  // One you read whose condition still holds, and one you did not read.
  const stuck = (await admin.c.admin({ do: 'create', kind: 'fake', label: 'Stuck', config: { attention: 'x' } })).id;
  await until(() => news().some((n) => n.id === `attention:${stuck}`), 10_000, 'the stuck notice');
  await app.c.call(notifications, 'notices', 'notify.markRead', { ids: [`attention:${stuck}`] });
  for (const c of clients) c.close();
  clients.length = 0;
  await m.stop();
  // No debounce now: only the kept episodes keep them from being announced again.
  m = await createManager({ openPage: true, dataDir: dir, port: 0, noticeTimes: { ...TIMES, debounceMs: 0 } });
  expect(m.store.all('SELECT id FROM account WHERE kind = ?', 'notices').length).toBe(1);
  app = client(appReg);
  await until(() => app.c.connected, 4000, 'connected again');
  await until(() => m.router.lastStatus(stuck)?.status === 'attention', 10_000, 'stuck again');
  await Bun.sleep(TIMES.attentionMs + 400);
  expect(news().map((n) => n.id)).not.toContain(`attention:${stuck}`);
  expect(news().map((n) => n.id)).not.toContain(`attention:${fake}`);
  const list = (await app.c.call(notifications, 'notices', 'notify.list', {})).notifications;
  expect(list.length).toBeGreaterThanOrEqual(5);
  expect(list.find((n) => n.id === `attention:${stuck}`)).toMatchObject({ unread: false });
});
