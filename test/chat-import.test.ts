/**
 * Chat accounts moving in from dither-chat: the import endpoint and tool (in place, never twice, never while a process
 * runs the account), forgetting an account (the per-account rollback), and the chat interface's types.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { CLI_HEADER, CLI_TOKEN_FILE } from '../packages/manager/src/auth.ts';
import { accountProcesses } from '../packages/manager/src/supervisor.ts';

let m: Manager;
let dir: string;
const CLI = resolve(import.meta.dir, '../packages/manager/src/cli.ts');
const until = async (f: () => boolean, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** The CLI in a child process. Not spawnSync: the manager answering it runs in this process's event loop. */
async function cli(...args: string[]) {
  // This manager's data dir, so the tool sends its token (never the machine's own manager's).
  if (!args.includes('--data')) args.push('--data', join(dir, 'mgr'));
  const p = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { exitCode: await p.exited, out, err };
}
/** The CLI's token, as cli.ts sends it. */
const asCli = () => ({ [CLI_HEADER]: readFileSync(join(dir, 'mgr', CLI_TOKEN_FILE), 'utf8').trim() });
const post = (path: string, body: unknown, headers: Record<string, string> = asCli()) => fetch(m.url + path, { method: 'POST', body: JSON.stringify(body), headers });

/** A stand-in for dither-chat's hub data dir: its account table and session directories. */
function hubData(): string {
  const d = join(dir, 'hub');
  mkdirSync(join(d, 'accounts'), { recursive: true });
  const db = new Database(join(d, 'hub.sqlite'), { create: true });
  db.exec(`CREATE TABLE account (id TEXT PRIMARY KEY, network TEXT, label TEXT, color TEXT, adapter TEXT, config TEXT, token TEXT, enabled INTEGER, demo INTEGER, position REAL, created_at INTEGER)`);
  const add = (id: string, adapter: string, enabled: number, demo: number) => {
    db.query('INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'matrix', `label ${id}`, '#fff', adapter, '{"x":1}', 'tok', enabled, demo, 0, 0);
    mkdirSync(join(d, 'accounts', id), { recursive: true });
  };
  add('acc_fakeChatA001', 'chat-fake', 1, 0);
  add('acc_fakeChatB002', 'chat-fake', 0, 0);
  add('acc_demoAccnt003', 'demo', 1, 1);
  db.close();
  return d;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-import-'));
  mkdirSync(join(dir, 'mgr'));
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0 });
});
afterAll(async () => {
  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('import-dither-chat: in place, enabled as it was, demo refused, a second time refused', async () => {
  const hub = hubData();
  const run = (...args: string[]) => cli('import-dither-chat', '--hub-data', hub, '--url', m.url, ...args);
  const dry = await run('--all', '--dry-run');
  expect(dry.out).toContain('would import acc_fakeChatA001');
  expect(dry.out).toContain('skip   acc_demoAccnt003  demo label acc_demoAccnt003: a demo account');
  expect(m.store.accounts().filter((a) => a.kind !== 'notices')).toEqual([]);

  const r = await run('--all');
  expect(r.exitCode).toBe(0);
  const a = m.store.account('acc_fakeChatA001')!;
  expect(a).toMatchObject({ kind: 'chat-fake', label: 'label acc_fakeChatA001', config: '{"x":1}', enabled: 1, dir: join(hub, 'accounts', 'acc_fakeChatA001'), created_by: 'import' });
  expect(a.token).not.toBe('tok');
  expect(m.store.account('acc_fakeChatB002')!.enabled).toBe(0);
  expect(m.store.account('acc_demoAccnt003')).toBeNull();
  await until(() => m.sup.state('acc_fakeChatA001').online, 10_000, 'the imported account online');
  // The extractor runs on the hub's directory, and holds its lock there.
  expect(JSON.parse(readFileSync(join(hub, 'accounts', 'acc_fakeChatA001', 'extractor.lock'), 'utf8')).owner).toBe('dither-accounts');

  const again = await run('--accounts', 'acc_fakeChatA001');
  expect(again.exitCode).toBe(1);
  expect(again.out).toContain('already in the manager');
}, 20_000);

test('the scan finds the process running an account; import refuses it', async () => {
  const pids = accountProcesses('acc_fakeChatA001');
  expect(pids.length).toBe(1);
  // Pretend the hub still runs B: a process with its id in the environment, running an adapter's main.ts.
  const fake = join(dir, 'src');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'main.ts'), 'await Bun.sleep(30_000);');
  const p = Bun.spawn(['bun', join(fake, 'main.ts')], { env: { ...process.env, DITHER_ACCOUNT_ID: 'acc_otherHubAcc4' } });
  try {
    await until(() => accountProcesses('acc_otherHubAcc4').length === 1, 5000, 'the stand-in adapter');
    const hub = join(dir, 'hub');
    const db = new Database(join(hub, 'hub.sqlite'));
    db.query('INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('acc_otherHubAcc4', 'matrix', 'other', '#fff', 'chat-fake', '{}', 't', 1, 0, 0, 0);
    db.close();
    mkdirSync(join(hub, 'accounts', 'acc_otherHubAcc4'), { recursive: true });
    const r = await cli('import-dither-chat', '--hub-data', hub, '--url', m.url, '--accounts', 'acc_otherHubAcc4');
    expect(r.out).toContain(`pid ${p.pid} runs it now: stop it in the hub first`);
    expect(m.store.account('acc_otherHubAcc4')).toBeNull();
  } finally {
    p.kill();
  }
}, 15_000);

test('import and forget take the CLI token from this machine, never a browser, and import checks the directory', async () => {
  expect((await post('/api/accounts/import', { accounts: [] }, { ...asCli(), origin: m.url })).status).toBe(403);
  // Any other process here: no token, or a wrong one.
  for (const h of [{}, { [CLI_HEADER]: 'nope' }] as Record<string, string>[]) {
    expect((await post('/api/accounts/import', { accounts: [] }, h)).status).toBe(401);
    expect((await post('/api/accounts/forget', { id: 'acc_fakeChatA001' }, h)).status).toBe(401);
  }
  expect(m.store.account('acc_fakeChatA001')).not.toBeNull();
  expect((await post('/api/accounts/import', { accounts: [] })).status).toBe(200);
  expect((await post('/api/accounts/import', { accounts: [{ id: 'acc_nowhere0001', kind: 'chat-fake', label: 'x', dir: '/nonexistent/x' }] })).status).toBe(400);
  expect((await post('/api/accounts/import', { accounts: [{ id: 'acc_nowhere0001', kind: 'nope', label: 'x', dir: dir }] })).status).toBe(400);
});

test('forget: the extractor stops, the entry goes, the directory stays', async () => {
  const d = m.store.account('acc_fakeChatA001')!.dir;
  const r = await (await post('/api/accounts/forget', { id: 'acc_fakeChatA001' })).json();
  expect(r).toEqual({ forgotten: 'acc_fakeChatA001', dir: d });
  expect(m.store.account('acc_fakeChatA001')).toBeNull();
  expect(m.sup.state('acc_fakeChatA001').running).toBe(false);
  expect(existsSync(d)).toBe(true);
  expect(existsSync(join(d, 'extractor.lock'))).toBe(false);
  await until(() => accountProcesses('acc_fakeChatA001').length === 0, 5000, 'the extractor gone');
});

test('the chat interface types calls from the protocol', () => {
  const c = null as unknown as AccountsClient;
  const typed = () => {
    void c.call(chat, 'acc', 'send', { conversation: 'c', body: 'hi' });
    void c.call(chat, 'acc', 'history', { conversation: 'c', limit: 20 }).then((r) => r.done satisfies boolean);
    // @ts-expect-error: send needs a body
    void c.call(chat, 'acc', 'send', { conversation: 'c' });
    // @ts-expect-error: no such op
    void c.call(chat, 'acc', 'teleport', {});
  };
  expect(typeof typed).toBe('function');
  expect(chat.ops.send.level).toBe('write');
  expect(chat.ops.configure.level).toBe('manage');
  expect(Object.keys(chat.events)).toContain('message');
});
