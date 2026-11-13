/**
 * GitHub accounts over the real wire: a manager with the github kind, accounts added through its HTTP API as the page
 * adds them, the extractor polling the fake GitHub, and an app with a notifications grant reading and clearing them and
 * hearing notify.new / notify.read. Covers the add form, status (self, details, layers), polling as GitHub asks
 * (X-Poll-Interval, If-Modified-Since and free 304s), reads elsewhere, paging, every op, rate limits, 5xx, a restart
 * that keeps its place, a revoked token and a new one picked up without a restart, missing scopes, fine-grained tokens
 * and an API that does not answer.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { notifications, type Notification } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import manifest from '../extractors/github/manifest.ts';
import { type FakeGitHub, startFakeGitHub } from '../extractors/github/test/fake-github.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
const ENV = {
  DITHER_GITHUB_RECONCILE_MS: '2500',
  DITHER_GITHUB_SECRET_CHECK_MS: '300',
  DITHER_GITHUB_RECHECK_MS: '1000',
  DITHER_GITHUB_BACKOFF_MS: '300',
  DITHER_GITHUB_SECONDARY_MS: '1000',
};
let fake: FakeGitHub;
let m: Manager;
let dir: string;
let app: AccountsClient;
let account: string;
const saved: Record<string, string | undefined> = {};
type Ev = { account: string; t: string; [k: string]: any };
const events: Ev[] = [];

const until = async (f: () => unknown | Promise<unknown>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, init: RequestInit = {}) => fetch(m.url + path, { ...init, headers: { 'content-type': 'application/json', origin: m.url, ...(init.headers ?? {}) } });
const detail = async (id = account) => (await (await api(`/api/accounts/${id}`)).json()) as any;
const status = async (id = account) => (await detail(id)).status as any;
const add = async (token: string | undefined, apiUrl: string | undefined = fake.url, label = 'GitHub') => {
  const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ kind: 'github', label, config: apiUrl ? { apiUrl } : {}, secret: token === undefined ? {} : { token } }) });
  return { status: r.status, body: (await r.json()) as any };
};
const news = (id = account) => events.filter((e) => e.account === id && e.t === 'notify.new').map((e) => e.notification as Notification);
const reads = (id = account) => events.filter((e) => e.account === id && e.t === 'notify.read').flatMap((e) => e.ids as string[]);
const notifCalls = () => fake.callsTo(/^\/notifications$/, 'GET');
const polled = async (n: number) => {
  const start = notifCalls().length;
  await until(() => notifCalls().length >= start + n, 15_000, `${n} more polls`);
};
const call = <K extends keyof (typeof notifications)['ops'] & string>(op: K, input: any, id = account) => app.call(notifications, id, op as any, input) as Promise<any>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fake = startFakeGitHub({ pollInterval: 1 });
  fake.addToken('ghp_main0000000000000000000000000000', { login: 'octocat', name: 'The Octocat' });
  dir = mkdtempSync(join(tmpdir(), 'dacc-github-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['github', kindOf(manifest, join(ROOT, 'extractors/github'))]]) });
  const reg = await register(m.url, { name: 'triage', requests: [{ interface: 'notifications', level: 'write' }] });
  expect((await api(`/api/requests/${reg.requests[0].id}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => events.push(...evs.map((e) => ({ ...e, account: a }) as Ev)) });
  await until(() => app.connected, 4000, 'the app connected');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('the add form: a classic token, kept in secret.json; fine-grained ones are turned away with why', async () => {
  const kinds = ((await (await api('/api/state')).json()) as any).kinds;
  const k = kinds.find((x: any) => x.kind === 'github');
  expect(k.add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['token', true, false],
    ['apiUrl', false, true],
  ]);
  expect(k.add.blurb).toContain('notifications scope');
  expect(k.add.blurb).toContain('repo');
  expect(k.add.blurb).toContain('Fine-grained tokens cannot');
  const fg = await add('github_pat_11ABCDEFGHIJKLMNOPQRSTUV');
  expect(fg.status).toBe(400);
  expect(fg.body.error).toContain('fine-grained');
  expect((await add(undefined)).body.error).toBe('Classic token is needed');
  expect((await add('ghp_main0000000000000000000000000000', 'ftp://x')).status).toBe(400);

  // What was unread before it was added is not announced.
  fake.addThread({ repo: 'octo/hello', title: 'Old one' });
  fake.addThread({ repo: 'octo/hello', type: 'PullRequest', title: 'Old PR' });
  const ok = await add('ghp_main0000000000000000000000000000');
  expect(ok.status).toBe(200);
  account = ok.body.id;
  const acc = m.store.account(account)!;
  expect(JSON.parse(acc.config)).toEqual({ apiUrl: fake.url });
  const secret = join(acc.dir, 'secret.json');
  expect(statSync(secret).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(secret, 'utf8'))).toEqual({ token: 'ghp_main0000000000000000000000000000' });
});

test('online: who it is, its details and its layers; the token is nowhere else', async () => {
  await until(async () => (await status())?.status === 'online' && (await status())?.details?.polls > 0, 10_000, 'online and polled');
  const d = await detail();
  expect(d.account.self).toEqual({ name: 'The Octocat', detail: 'octocat', avatar: expect.stringMatching(/^https:\/\/avatars\.example\//) });
  expect(d.status.self).toMatchObject({ handle: 'octocat', displayName: 'The Octocat' });
  expect(d.status.attention).toBeNull();
  expect(d.status.layers.map((l: any) => [l.name, l.state])).toEqual([
    [new URL(fake.url).host, 'ok'],
    ['token valid', 'ok'],
    ['scopes', 'ok'],
    ['polling', 'ok'],
  ]);
  expect(d.status.layers[2].note).toBe('notifications, repo, read:user');
  expect(d.status.details).toMatchObject({ login: 'octocat', api: fake.url, tokenType: 'classic', scopes: 'notifications, repo, read:user', privateSubjects: true, pollIntervalS: 1, unread: 2 });
  expect(d.hello).toMatchObject({ network: 'github' });
  expect(d.secret).toEqual({ present: true, keys: ['token'] });
  const everything = JSON.stringify(await (await api('/api/state')).json()) + JSON.stringify(d) + readFileSync(join(d.account.dir, 'adapter.log'), 'utf8');
  expect(everything).not.toContain('ghp_main');
  expect(news()).toEqual([]);
});

test('polls as GitHub asks: no sooner than X-Poll-Interval, with If-Modified-Since, and 304s cost nothing', async () => {
  await polled(3);
  const recent = notifCalls().slice(-4);
  for (let i = 1; i < recent.length; i++) expect(recent[i].at - recent[i - 1].at).toBeGreaterThanOrEqual(900);
  expect(recent.filter((c) => c.ims && c.status === 304).length).toBeGreaterThan(0);
  const all = notifCalls();
  expect(all.filter((c) => c.status === 304).every((c) => !c.spent)).toBe(true);
  expect(all.filter((c) => c.status === 200).every((c) => c.spent)).toBe(true);
  fake.setPollInterval(2);
  await polled(3);
  const slow = notifCalls().slice(-3);
  expect(slow[2].at - slow[1].at).toBeGreaterThanOrEqual(1900);
  fake.setPollInterval(1);
  await polled(2);
});

test('a new thread is announced, with its link, repository, state, who and what', async () => {
  const id = fake.addThread({ repo: 'octo/hello', type: 'Issue', title: 'It broke', reason: 'mention', author: 'mona', comment: { author: 'hubot', body: '@octocat it broke again' } });
  await until(() => news().some((n) => n.id === id), 8000, 'notify.new');
  const n = news().find((x) => x.id === id)!;
  expect(n).toMatchObject({
    source: 'github',
    title: 'It broke',
    body: '@octocat it broke again',
    reason: 'mention',
    context: 'octo/hello',
    subject: { kind: 'issue', title: 'It broke', url: `${fake.origin}/octo/hello/issues/${id}`, state: 'open' },
    actors: [{ name: 'hubot', url: `${fake.origin}/hubot` }],
    unread: true,
    urgency: 'normal',
  });
  expect(n.url).toMatch(new RegExp(`^${fake.origin}/octo/hello/issues/${id}#issuecomment-\\d+$`));
  expect(n.at).toBe(fake.thread(id)!.updatedAt);
  // Once.
  await polled(2);
  expect(news().filter((x) => x.id === id).length).toBe(1);
  // New activity on it announces it again; so does a merge, with who merged it.
  fake.comment(id, { author: 'mona', body: 'fixed?' });
  await until(() => news().filter((x) => x.id === id).length === 2, 8000, 'the comment');
  expect(news().filter((x) => x.id === id)[1]).toMatchObject({ body: 'fixed?', actors: [{ name: 'mona' }] });
  const pr = fake.addThread({ repo: 'octo/hello', type: 'PullRequest', title: 'Fix it', reason: 'review_requested', author: 'mona' });
  await until(() => news().some((x) => x.id === pr), 8000, 'the PR');
  expect(news().find((x) => x.id === pr)).toMatchObject({ reason: 'review_requested', url: `${fake.origin}/octo/hello/pull/${pr}`, subject: { kind: 'pull_request', state: 'open' }, actors: [{ name: 'mona' }], body: `The description of ${pr}` });
  fake.changeState(pr, 'merged', 'hubot');
  await until(() => news().filter((x) => x.id === pr).length === 2, 8000, 'the merge');
  expect(news().filter((x) => x.id === pr)[1]).toMatchObject({ reason: 'state_change', subject: { state: 'merged' }, actors: [{ name: 'hubot' }], urgency: 'low' });
});

test('read elsewhere: notify.read, though a 304 cannot say it; unread again: notify.new', async () => {
  const id = fake.addThread({ title: 'Read me on the web' });
  await until(() => news().some((x) => x.id === id), 8000, 'announced');
  fake.readOnWeb(id);
  await until(() => reads().includes(id), 10_000, 'notify.read');
  const before = news().filter((x) => x.id === id).length;
  fake.unreadOnWeb(id);
  await until(() => news().filter((x) => x.id === id).length === before + 1, 10_000, 'notify.new again');
});

test('notify.list: newest first, a page at a time with Link, unread only, since', async () => {
  const all = [...fake.threads.values()].filter((t) => !t.done).sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id));
  const got: Notification[] = [];
  let page = await call('notify.list', { limit: 2 });
  let pages = 1;
  got.push(...page.notifications);
  while (page.next) {
    page = await call('notify.list', { pageToken: page.next });
    got.push(...page.notifications);
    pages++;
  }
  expect(pages).toBe(Math.ceil(all.length / 2));
  expect(got.map((n) => n.id)).toEqual(all.map((t) => t.id));
  expect(got.every((n) => n.source === 'github' && n.context === 'octo/hello')).toBe(true);
  const unread = await call('notify.list', { unreadOnly: true });
  expect(unread.notifications.map((n: Notification) => n.id).sort()).toEqual(all.filter((t) => t.unread).map((t) => t.id).sort());
  expect(unread.notifications.every((n: Notification) => n.unread)).toBe(true);
  const newest = all[0].updatedAt;
  expect((await call('notify.list', { since: newest - 1 })).notifications.map((n: Notification) => n.id)).toEqual([all[0].id]);
  const bad = (await call('notify.list', { pageToken: 'bm9wZQ' }).catch((e) => e)) as CallFailed;
  expect([bad.code, bad.status]).toEqual(['failed', 400]);
});

test('markRead, markAllRead and mute reach GitHub, and other apps hear notify.read', async () => {
  const a = fake.addThread({ title: 'A' });
  const b = fake.addThread({ title: 'B' });
  await until(() => news().some((x) => x.id === b), 8000, 'both announced');
  expect(await call('notify.markRead', { ids: [a] })).toEqual({});
  expect(fake.thread(a)!.unread).toBe(false);
  expect(fake.callsTo(new RegExp(`^/notifications/threads/${a}$`), 'PATCH').map((c) => c.status)).toEqual([205]);
  await until(() => reads().includes(a), 4000, 'notify.read for it');
  const bad = (await call('notify.markRead', { ids: ['../user'] }).catch((e) => e)) as CallFailed;
  expect([bad.code, bad.status]).toEqual(['failed', 400]);
  const missing = (await call('notify.markRead', { ids: ['999999'] }).catch((e) => e)) as CallFailed;
  expect(missing.status).toBe(404);

  // The manager overwrites an input `id` with its call id (docs/github.md): `thread` stands in for it.
  const plain = await call('notify.mute', { id: b }).catch((e) => e);
  if (plain instanceof CallFailed) expect(plain.message).toContain('send the thread id as `thread` too');
  else expect(plain).toEqual({});
  expect(await app.callRaw(account, 'notify.mute', { id: b, thread: b })).toEqual({});
  expect(fake.thread(b)!.ignored).toBe(true);
  expect(fake.callsTo(new RegExp(`^/notifications/threads/${b}/subscription$`), 'PUT')[0].body).toEqual({ ignored: true });

  const unread = [...fake.threads.values()].filter((t) => t.unread).map((t) => t.id);
  expect(unread.length).toBeGreaterThan(0);
  expect(await call('notify.markAllRead', {})).toEqual({});
  expect(fake.callsTo(/^\/notifications$/, 'PUT').at(-1)!.body).toEqual({ read: true });
  expect([...fake.threads.values()].filter((t) => t.unread)).toEqual([]);
  await until(() => unread.every((id) => reads().includes(id)), 4000, 'notify.read for all');
  // Not announced again by the polls after.
  const n = news().length;
  await polled(3);
  expect(news().length).toBe(n);
  expect((await status()).details.unread).toBe(0);

  const c = fake.addThread({ title: 'C' });
  await until(() => news().some((x) => x.id === c), 8000, 'C');
  const at = fake.thread(c)!.updatedAt;
  await call('notify.markAllRead', { before: at - 1000 });
  expect(fake.callsTo(/^\/notifications$/, 'PUT').at(-1)!.body).toEqual({ last_read_at: new Date(at - 1000).toISOString().replace('.000Z', 'Z'), read: true });
  expect(fake.thread(c)!.unread).toBe(true);
});

test('rate limits: a primary one is waited out without asking, apps hear 429, then it goes on', async () => {
  fake.exhaust(3);
  await until(async () => (await status()).layers[3].note?.startsWith('rate limited until'), 8000, 'the polling layer says so');
  const st = await status();
  expect(st.layers[3].state).toBe('waiting');
  expect(st.status).toBe('online');
  expect(st.attention).toBeNull();
  const t0 = Date.now();
  const e = (await call('notify.list', {}).catch((x) => x)) as CallFailed;
  expect([e.code, e.status]).toEqual(['failed', 429]);
  expect(Date.now() - t0).toBeLessThan(1000);
  const sent = fake.calls.length;
  await Bun.sleep(1000);
  expect(fake.calls.length).toBe(sent);
  await until(async () => (await status()).layers[3].state === 'ok', 10_000, 'polling again');
  expect(fake.calls.length).toBeGreaterThan(sent);

  // A secondary one: as long as Retry-After says.
  fake.failNext({ status: 429, retryAfter: 2, match: /GET \/notifications$/ });
  await until(async () => (await status()).layers[3].note?.startsWith('rate limited'), 8000, 'the secondary limit');
  await until(async () => (await status()).layers[3].state === 'ok', 10_000, 'polling after it');
}, 30_000);

test('a 5xx: tried again with growing waits, and said in the polling layer meanwhile', async () => {
  fake.failNext({ status: 502, count: 2, match: /GET \/notifications$/ });
  await until(async () => /Server Error; trying again/.test((await status()).layers[3].note ?? ''), 8000, 'the failure in the layer');
  await until(async () => (await status()).layers[3].state === 'ok', 10_000, 'back');
});

test('a restart keeps its place: only what came meanwhile is announced', async () => {
  const before = news().length;
  const readsBefore = reads().length;
  const acc = m.store.account(account)!;
  await m.sup.stop(account);
  const during = fake.addThread({ title: 'While it was down' });
  m.sup.start(account);
  await until(() => m.sup.state(account).online, 10_000, 'online again');
  await until(() => news().length > before, 10_000, 'the one from meanwhile');
  await polled(3);
  expect(news().slice(before).map((n) => n.id)).toEqual([during]);
  expect(reads().length).toBe(readsBefore);
  // Its place on disk is ids and times, never what notifications say.
  const text = readFileSync(join(acc.dir, 'state.json'), 'utf8');
  expect(JSON.parse(text).seen[during]).toEqual([fake.thread(during)!.updatedAt, 1]);
  for (const t of fake.threads.values()) if (t.title.length > 4) expect(text).not.toContain(t.title);
});

test('a revoked token: attention and refused calls; a new token in secret.json is picked up without a restart', async () => {
  const pid = m.sup.details(account).pid;
  fake.revoke('ghp_main0000000000000000000000000000');
  await until(async () => (await status()).status === 'attention', 10_000, 'attention');
  const st = await status();
  expect(st.attention.kind).toBe('login');
  expect(st.attention.message).toContain('GitHub refused the token (Bad credentials)');
  expect(st.attention.message).toContain('classic token');
  expect(st.layers[1]).toMatchObject({ name: 'token valid', state: 'failed' });
  expect(st.layers[3].state).toBe('waiting');
  const e = (await call('notify.list', {}).catch((x) => x)) as CallFailed;
  expect(e.status).toBe(401);
  // No further requests with the dead token.
  const sent = fake.calls.length;
  await Bun.sleep(1200);
  expect(fake.calls.length).toBe(sent);

  fake.addToken('ghp_next0000000000000000000000000000', { login: 'octocat', name: 'The Octocat' });
  writeSecretFile(join(m.store.account(account)!.dir, 'secret.json'), { token: 'ghp_next0000000000000000000000000000' });
  await until(async () => (await status()).status === 'online', 10_000, 'online with the new token');
  expect(m.sup.details(account).pid).toBe(pid);
  expect((await call('notify.list', { limit: 1 })).notifications.length).toBe(1);
});

test('scopes: what is missing is said, and a scope added on GitHub is noticed', async () => {
  fake.addToken('ghp_scopeless000000000000000000000000', { login: 'octocat', scopes: ['read:user'] });
  const { body } = await add('ghp_scopeless000000000000000000000000', fake.url, 'No scopes');
  const id = body.id;
  await until(async () => (await status(id))?.status === 'attention', 10_000, 'attention');
  const st = await status(id);
  expect(st.attention.message).toContain('The token has only read:user, not notifications');
  expect(st.layers.map((l: any) => l.state)).toEqual(['ok', 'ok', 'failed', 'waiting']);
  expect(st.layers[2].note).toBe('has only read:user; needs notifications');
  expect(fake.callsTo(/^\/notifications$/).filter((c) => c.token === 'ghp_scopeless000000000000000000000000').length).toBe(0);
  expect(((await call('notify.list', {}, id).catch((x) => x)) as CallFailed).status).toBe(403);

  fake.setScopes('ghp_scopeless000000000000000000000000', ['notifications']);
  await until(async () => (await status(id))?.status === 'online', 10_000, 'online once the scope is there');
  const ok = await status(id);
  expect(ok.layers[2]).toEqual({ name: 'scopes', state: 'ok', note: "notifications; no repo scope, so private repositories' subjects are not resolved" });
  expect(ok.details.privateSubjects).toBe(false);

  // A private repository's issue is linked, not fetched.
  const priv = fake.addThread({ repo: 'octo/secret', private: true, title: 'Private' });
  await until(() => news(id).some((n) => n.id === priv), 8000, 'the private one');
  expect(news(id).find((n) => n.id === priv)).toMatchObject({ url: `${fake.origin}/octo/secret/issues/${priv}`, subject: { state: null }, context: 'octo/secret' });
  expect(fake.callsTo(/^\/repos\/octo\/secret\//).filter((c) => c.token === 'ghp_scopeless000000000000000000000000').length).toBe(0);
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
});

test('a fine-grained token (past the form) says to use a classic one; a bad one says GitHub refused it', async () => {
  fake.addToken('github_pat_11fine', { login: 'octocat', scopes: null });
  const { body } = await add('ghp_wrong00000000000000000000000000000', fake.url, 'Wrong');
  const id = body.id;
  await until(async () => (await status(id))?.status === 'attention', 10_000, 'attention');
  expect((await status(id)).attention.message).toContain('GitHub refused the token (Bad credentials)');
  writeSecretFile(join(m.store.account(id)!.dir, 'secret.json'), { token: 'github_pat_11fine' });
  await until(async () => /fine-grained/.test((await status(id))?.attention?.message ?? ''), 10_000, 'the fine-grained message');
  const st = await status(id);
  expect(st.attention.message).toContain("GitHub's notifications API only takes classic ones");
  expect(st.layers[2]).toMatchObject({ state: 'failed', note: 'a fine-grained token: it cannot read notifications' });
  expect(st.details.tokenType).toBe('fine-grained');
});

test('an API that does not answer: offline, its layer says why, and it keeps trying', async () => {
  const gone = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const url = `http://127.0.0.1:${gone.port}/api/v3`;
  gone.stop(true);
  const { body } = await add('ghp_main0000000000000000000000000000', url, 'Nowhere');
  await until(async () => (await status(body.id))?.status === 'offline', 10_000, 'offline');
  const st = await status(body.id);
  expect(st.layers[0]).toMatchObject({ name: `127.0.0.1:${new URL(url).port}`, state: 'failed' });
  expect(st.layers[1].state).toBe('waiting');
  const e = (await call('notify.list', {}, body.id).catch((x) => x)) as CallFailed;
  expect(e.status).toBe(503);
});

test('GitHub’s own API URL by default (no request made here)', () => {
  expect(existsSync(join(ROOT, 'extractors/github/src/main.ts'))).toBe(true);
  expect(readFileSync(join(ROOT, 'extractors/github/src/main.ts'), 'utf8')).toContain("'https://api.github.com'");
});
