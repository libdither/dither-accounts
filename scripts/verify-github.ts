/**
 * The github kind end to end, with a throwaway manager (its own process, as the service runs it) and the fake GitHub
 * (extractors/github/test/fake-github.ts), never the real API:
 *
 *   1. the manager lists the github kind with its add form; a fine-grained token is turned away
 *   2. an account added through POST /api/accounts as the page adds it (API URL = the fake), online with who it is,
 *      its details and its layers
 *   3. an app registers through packages/client, its request is approved through the manager's API, and it hears
 *      notify.new for a new thread (not for what was unread before) and notify.read for one read on the web
 *   4. every op: notify.list (all pages), notify.markRead, notify.mute, notify.markAllRead
 *   5. a rate limit waited out without requests, a 429 to the app meanwhile
 *   6. disabled, a thread arrives, enabled: only that one is announced; a restart announces nothing
 *
 *   bun scripts/verify-github.ts [--keep]
 *
 * Ports 18540 (manager) and 18541 (fake GitHub); data under /tmp, deleted after unless --keep.
 */
import type { Subprocess } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '../packages/client/src/index.ts';
import { notifications, type Notification } from '../packages/interfaces/src/index.ts';
import { startFakeGitHub } from '../extractors/github/test/fake-github.ts';

const ROOT = resolve(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const T = mkdtempSync('/tmp/dacc-verify-github-');
const MGR = 'http://127.0.0.1:18540';
const TOKEN = 'ghp_verify000000000000000000000000000';

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
/** Something outside this kind that does not work yet: reported, not failed. */
const gap = (ok: unknown, what: string, detail: unknown = '') => console.log(`${ok ? 'ok  ' : 'gap '} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
const until = async (f: () => unknown | Promise<unknown>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {}
    await Bun.sleep(100);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const get = async (path: string) => (await fetch(MGR + path)).json() as Promise<any>;
/** As the page sends them: JSON, from its own origin. */
const send = (method: string, path: string, body?: unknown) => fetch(MGR + path, { method, headers: { 'content-type': 'application/json', origin: MGR }, body: body === undefined ? undefined : JSON.stringify(body) });

const fake = startFakeGitHub({ port: 18541, pollInterval: 1 });
fake.addToken(TOKEN, { login: 'octocat', name: 'The Octocat' });
let mgr: Subprocess | null = null;
let app: AccountsClient | null = null;
try {
  console.log(`     workdir ${T}`);
  mgr = Bun.spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'data'), '--port', '18540', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, DITHER_GITHUB_RECONCILE_MS: '2500', DITHER_GITHUB_BACKOFF_MS: '300', DITHER_GITHUB_SECRET_CHECK_MS: '500' },
    stdout: Bun.file(join(T, 'manager.log')),
    stderr: Bun.file(join(T, 'manager.err')),
  });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'a fresh manager on 18540');

  // 1. The kind and its form.
  const kind = (await get('/api/state')).kinds.find((k: any) => k.kind === 'github');
  check(kind?.interfaces?.join() === 'notifications', 'the manager has the github kind, with notifications', kind?.interfaces);
  check(kind?.add?.fields?.map((f: any) => f.key).join() === 'token,apiUrl' && /classic/.test(kind.add.blurb) && /notifications scope/.test(kind.add.blurb), 'its add form: a classic token (secret) and an optional API URL');
  const fg = await send('POST', '/api/accounts', { kind: 'github', label: 'x', config: { apiUrl: fake.url }, secret: { token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAA' } });
  check(fg.status === 400 && /fine-grained/.test((await fg.json()).error), 'a fine-grained token is turned away, saying why');

  // 2. Added as the page adds it.
  fake.addThread({ repo: 'octo/hello', title: 'Unread before it was added' });
  fake.addThread({ repo: 'octo/hello', type: 'PullRequest', title: 'Also unread before' });
  const added = await send('POST', '/api/accounts', { kind: 'github', label: 'GitHub (fake)', config: { apiUrl: fake.url }, secret: { token: TOKEN } });
  const account = ((await added.json()) as any).id as string;
  check(added.status === 200 && !!account, 'an account added through POST /api/accounts', account);
  const detail = () => get(`/api/accounts/${account}`);
  check(await until(async () => (await detail()).status?.status === 'online', 15_000, 'online'), 'it is online');
  const d = await detail();
  check(d.account.self?.name === 'The Octocat' && d.account.self?.detail === 'octocat', 'who it is signed in as', d.account.self);
  check(d.status.layers?.map((l: any) => `${l.name}:${l.state}`).join(' → ') === `127.0.0.1:18541:ok → token valid:ok → scopes:ok → polling:ok`, 'its layers, all ok', d.status.layers?.map((l: any) => `${l.name}:${l.state}`));
  check(d.status.details?.login === 'octocat' && d.status.details?.tokenType === 'classic' && d.status.details?.unread === 2, 'its details', d.status.details);
  check(JSON.stringify(d).indexOf(TOKEN) < 0 && d.secret.keys.join() === 'token', 'the token is in secret.json only');

  // 3. An app.
  const reg = await register(MGR, { name: 'verify-github', describe: 'scripts/verify-github.ts', requests: [{ interface: 'notifications', level: 'write', reason: 'triage' }] });
  const approved = await send('POST', `/api/requests/${reg.requests[0].id}/approve`, {});
  check(approved.ok, 'the app registered; its request approved through the manager');
  const events: { t: string; [k: string]: any }[] = [];
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, evs) => a === account && events.push(...evs) });
  check(await until(() => app!.accounts.some((a) => a.id === account && a.grants.notifications === 'write'), 8000, 'the grant'), 'the app sees the account with notifications at write');
  const news = () => events.filter((e) => e.t === 'notify.new').map((e) => e.notification as Notification);
  const reads = () => events.filter((e) => e.t === 'notify.read').flatMap((e) => e.ids as string[]);
  const call = (op: string, input: any) => app!.call(notifications, account, op as any, input) as Promise<any>;
  await Bun.sleep(2500);
  check(news().length === 0, 'what was unread before is not announced', news().map((n) => n.title));
  const id = fake.addThread({ repo: 'octo/hello', type: 'Issue', title: 'Something broke', reason: 'mention', comment: { author: 'hubot', body: '@octocat look' } });
  check(await until(() => news().some((n) => n.id === id), 10_000, 'notify.new'), 'a new thread: notify.new');
  const n = news().find((x) => x.id === id);
  check(n && n.context === 'octo/hello' && n.subject?.state === 'open' && n.actors[0]?.name === 'hubot' && n.body === '@octocat look' && n.url?.startsWith(`${fake.origin}/octo/hello/issues/${id}#issuecomment-`), 'mapped: repository, state, who, what, the link to the comment', n);
  fake.readOnWeb(id);
  check(await until(() => reads().includes(id), 10_000, 'notify.read'), 'read on the web: notify.read');

  // 4. Every op.
  const listed: Notification[] = [];
  let page = await call('notify.list', { limit: 2 });
  let pages = 1;
  listed.push(...page.notifications);
  while (page.next) {
    page = await call('notify.list', { pageToken: page.next });
    listed.push(...page.notifications);
    pages++;
  }
  check(listed.length === fake.threads.size && pages === Math.ceil(fake.threads.size / 2), 'notify.list: every notification, two a page through Link', { listed: listed.length, pages });
  const a = fake.addThread({ title: 'Mark me' });
  const b = fake.addThread({ title: 'Mute me' });
  await until(() => news().some((x) => x.id === b), 10_000, 'both announced');
  await call('notify.markRead', { ids: [a] });
  check(fake.thread(a)?.unread === false && (await until(() => reads().includes(a), 4000, 'its notify.read')), 'notify.markRead: read on GitHub, notify.read to apps');
  const plain = await call('notify.mute', { id: b }).catch((e) => e);
  gap(!(plain instanceof CallFailed), 'notify.mute with { id } (the manager puts its call id over an input `id`: docs/github.md)', plain instanceof CallFailed ? plain.message : '');
  await app.callRaw(account, 'notify.mute', { id: b, thread: b });
  check(fake.thread(b)?.ignored === true, 'notify.mute: the thread ignored on GitHub');
  await call('notify.markAllRead', {});
  check([...fake.threads.values()].every((t) => !t.unread) && (await until(() => reads().includes(b), 4000, 'notify.read for the rest')), 'notify.markAllRead: everything read, notify.read to apps');

  // 5. A rate limit.
  fake.exhaust(4);
  check(await until(async () => /^rate limited until/.test((await detail()).status.layers[3].note ?? ''), 8000, 'the limit'), 'a rate limit: the polling layer says until when');
  const limited = await call('notify.list', {}).catch((e) => e);
  check(limited instanceof CallFailed && limited.status === 429, 'meanwhile an app hears 429', limited?.message);
  const sent = fake.calls.length;
  await Bun.sleep(1500);
  check(fake.calls.length === sent, 'and nothing is sent to GitHub');
  check(await until(async () => (await detail()).status.layers[3].state === 'ok', 10_000, 'polling again'), 'after the reset it polls again');

  // 6. Its place kept.
  const before = news().length;
  await send('PATCH', `/api/accounts/${account}`, { enabled: false });
  const during = fake.addThread({ title: 'While it was off' });
  await send('PATCH', `/api/accounts/${account}`, { enabled: true });
  await until(() => news().length > before, 10_000, 'the one from meanwhile');
  await Bun.sleep(3000);
  check(news().slice(before).map((x) => x.id).join() === during, 'off and on again: only the thread from meanwhile is announced', news().slice(before).map((x) => x.title));
  const r = await send('POST', `/api/accounts/${account}/restart`);
  await until(async () => (await detail()).status?.status === 'online', 10_000, 'online after the restart');
  await Bun.sleep(3000);
  check(r.ok && news().length === before + 1, 'a restart announces nothing again');
  const unreadOnGitHub = [...fake.threads.values()].filter((t) => t.unread).length;
  check((await detail()).status.details.unread === unreadOnGitHub, 'its unread count matches GitHub', unreadOnGitHub);
  check(fake.calls.every((c) => c.token === TOKEN), 'every request carried the account’s token, to the fake only');
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  app?.close();
  if (mgr && mgr.exitCode === null) {
    mgr.kill('SIGTERM');
    const killer = setTimeout(() => mgr!.kill('SIGKILL'), 15_000);
    await mgr.exited;
    clearTimeout(killer);
  }
  fake.stop();
  if (!keep) rmSync(T, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
