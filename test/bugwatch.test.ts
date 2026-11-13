/**
 * bugwatch over the real wire: a manager with the bugwatch kind, an account added through its HTTP API as the page adds
 * it (its config file's path), the extractor tailing a temp errors-ndjson file and a plain log, and an app with a
 * notifications grant hearing notify.new and notify.read, listing, marking read and muting. The thread command is the
 * fake (extractors/bugwatch/test/fake-t3.ts). Also: the CLI's --dry, which starts nothing.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { type Notification, notifications } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import manifest from '../extractors/bugwatch/manifest.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
const FAKE_T3 = join(ROOT, 'extractors/bugwatch/test/fake-t3.ts');
let m: Manager;
let dir: string;
let app: AccountsClient;
let account: string;
let errors: string;
let log: string;
let calls: string;
let configPath: string;
const saved = process.env.DITHER_BUGWATCH_SCAN_MS;
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
const news = () => events.filter((e) => e.account === account && e.t === 'notify.new').map((e) => e.notification as Notification);
const reads = () => events.filter((e) => e.account === account && e.t === 'notify.read').flatMap((e) => e.ids as string[]);
const call = (op: string, input: any) => app.call(notifications, account, op as any, input) as Promise<any>;
const rec = (o: Record<string, unknown>) => JSON.stringify({ v: 1, at: Date.now(), app: 'hub', source: 'job', where: 'upkeep', name: 'Error', message: 'disk full', stack: ['at upkeep (packages/hub/src/main.ts:10:3)'], ...o });

beforeAll(async () => {
  process.env.DITHER_BUGWATCH_SCAN_MS = '200';
  dir = mkdtempSync(join(tmpdir(), 'dacc-bugwatch-'));
  errors = join(dir, 'hub/traces/errors.ndjson');
  log = join(dir, 'svc/service.log');
  calls = join(dir, 'calls');
  for (const d of ['hub/traces', 'svc', 'calls', 'data']) mkdirSync(join(dir, d), { recursive: true });
  // Yesterday's error, before the account: found by the catch-up, listed, not announced.
  writeFileSync(errors, `${rec({ at: Date.now() - 3_600_000, where: 'nightly', message: 'backup failed' })}\n`);
  writeFileSync(log, '[info] started\n');
  configPath = join(dir, 'bugwatch.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      sources: [
        { name: 'hub', kind: 'errors-ndjson', path: errors, project: '/srv/app', base: 'origin/main' },
        { name: 'svc', kind: 'text-log', path: log },
      ],
      threads: { command: ['bun', FAKE_T3, calls, 'thread', 'start', '--title', '{title}', '--worktree', '{base}', '--json', '{project}', '-'], gapMinutes: 0, dayMax: 5 },
    }),
  );
  m = await createManager({ openPage: true, dataDir: join(dir, 'data'), port: 0, kinds: new Map([['bugwatch', kindOf(manifest, join(ROOT, 'extractors/bugwatch'))]]) });
  const reg = await register(m.url, { name: 'triage', requests: [{ interface: 'notifications', level: 'write' }] });
  expect((await api(`/api/requests/${reg.requests[0].id}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => events.push(...evs.map((e) => ({ ...e, account: a }) as Ev)) });
  await until(() => app.connected, 4000, 'the app connected');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  if (saved === undefined) delete process.env.DITHER_BUGWATCH_SCAN_MS;
  else process.env.DITHER_BUGWATCH_SCAN_MS = saved;
  rmSync(dir, { recursive: true, force: true });
});

test('the add form takes an absolute .json path', async () => {
  const kind = ((await (await api('/api/state')).json()) as any).kinds.find((k: any) => k.kind === 'bugwatch');
  expect(kind.interfaces).toEqual(['notifications']);
  expect(kind.add.fields.map((f: any) => f.key)).toEqual(['config']);
  const bad = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ kind: 'bugwatch', label: 'x', config: { config: 'relative.json' } }) });
  expect(bad.status).toBe(400);
});

test('added: the catch-up is listed without a notification; a new error is announced with its thread', async () => {
  const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ kind: 'bugwatch', label: 'Bug watch', config: { config: configPath } }) });
  expect(r.status).toBeLessThan(300);
  account = ((await r.json()) as any).id;
  // notify.list waits for the first scan; until then the account may not be connected yet.
  await until(async () => ((await call('notify.list', {}).catch(() => ({ notifications: [] }))).notifications as Notification[]).length === 1, 15_000, 'the catch-up listed');
  const listed = (await call('notify.list', {})).notifications as Notification[];
  expect(listed[0]).toMatchObject({ source: 'bugwatch', title: 'hub: Error: backup failed', context: 'hub', unread: true, urgency: 'normal' });
  expect(news()).toEqual([]);
  // Live: a crash in the plain log (Bun's format, the excerpt never kept) and a new error in the file.
  appendFileSync(log, ['12 |   const hint = account.passwordHint;', '         ^', 'TypeError: undefined is not an object (evaluating \'account.passwordHint\')', '      at load (/srv/svc/src/main.ts:12:9)', '', 'Bun v1.4.2 (Linux x64)', ''].join('\n'));
  appendFileSync(errors, `${rec({ where: 'GET /api/x/:id', source: 'request', name: 'SQLiteError', message: 'database is locked', trace: 'a'.repeat(32) })}\n`);
  await until(() => news().length === 2, 15_000, 'two notices');
  const crash = news().find((n) => n.context === 'svc')!;
  expect(crash).toMatchObject({ title: 'svc: TypeError: undefined is not an object (evaluating \'<s>\')', urgency: 'high', reason: 'new' });
  expect(crash.body).toContain('No T3 thread: its source names no project and base.');
  expect(JSON.stringify(crash)).not.toContain('passwordHint');
  const hub = news().find((n) => n.context === 'hub')!;
  expect(hub.body).toMatch(/^GET \/api\/x\/:id: 1 time since .+ UTC\. A T3 thread is looking into it \(Bug: hub: SQLiteError: database is locked\)\.$/);
  // The catch-up's bug and this one each got a thread (gapMinutes 0: one a scan).
  await until(() => readdirSync(calls).filter((f) => f.startsWith('call-')).length === 2, 10_000, 'two threads');
  const briefs = readdirSync(calls).map((f) => JSON.parse(readFileSync(join(calls, f), 'utf8')).stdin as string);
  expect(briefs.some((b) => b.includes(`--trace ${'a'.repeat(32)}`))).toBe(true);
  const status = ((await (await api(`/api/accounts/${account}`)).json()) as any).status;
  expect(status.status).toBe('online');
  expect(status.layers.map((l: any) => [l.name, l.state])).toEqual([
    ['config', 'ok'],
    ['hub', 'ok'],
    ['svc', 'ok'],
    ['threads', 'ok'],
  ]);
});

test('markRead and mute over the wire; state survives a restart without announcing again', async () => {
  const hub = news().find((n) => n.context === 'hub')!;
  await call('notify.markRead', { ids: [hub.id] });
  await until(() => reads().includes(hub.id), 5000, 'notify.read');
  const crash = news().find((n) => n.context === 'svc')!;
  await call('notify.mute', { id: crash.id });
  await until(async () => !((await call('notify.list', {})).notifications as Notification[]).some((n) => n.id === crash.id), 5000, 'muted');
  const before = news().length;
  await api(`/api/accounts/${account}/restart`, { method: 'POST', body: '{}' });
  await Bun.sleep(1500);
  appendFileSync(errors, `${rec({ where: 'GET /api/x/:id', source: 'request', name: 'SQLiteError', message: 'database is locked' })}\n`);
  await Bun.sleep(1000);
  expect(news().length).toBe(before);
  const listed = (await call('notify.list', {})).notifications as Notification[];
  expect(listed.find((n) => n.id === hub.id)?.unread).toBe(false);
  expect(existsSync(join(m.store.account(account)!.dir, 'state.json'))).toBe(true);
});

test('cli --dry: the bugs and threads it would start, starting none', async () => {
  const before = readdirSync(calls).length;
  const p = Bun.spawnSync(['bun', join(ROOT, 'extractors/bugwatch/src/cli.ts'), '--config', configPath, '--dry'], { stdout: 'pipe', stderr: 'pipe' });
  const out = p.stdout.toString();
  expect(p.exitCode).toBe(0);
  expect(out).toContain('[new] hub: SQLiteError: database is locked');
  expect(out).toContain('! [new] svc: TypeError');
  expect(out).toContain('would start now: ["bun"');
  expect(out).toContain('would queue: Bug: hub: ');
  expect(readdirSync(calls).length).toBe(before);
});
