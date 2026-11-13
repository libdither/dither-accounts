/**
 * Account administration for apps, over the real wire: what an app's list says about each account (why it is not
 * running, whether it may run it, its live view, who made it), reading its log, removing it with its directory, and
 * its live view carried to the app on the app's token. Each needs an `accounts` grant at manage for the kind.
 */
import type { UnixSocketListener } from 'bun';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, liveViewPath, register } from '@dither-accounts/client';
import { createManager, type Manager } from '@dither-accounts/manager';

let m: Manager;
let dir: string;
let vnc: UnixSocketListener<undefined>;
const atVnc: string[] = [];
const clients: AccountsClient[] = [];

const until = async (f: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const approveAll = async () => {
  const st = (await (await fetch(`${m.url}/api/state`)).json()) as any;
  for (const app of st.apps) for (const r of app.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
};
const client = (reg: { app: string; token: string }) => {
  const c = new AccountsClient({ url: m.url, app: reg.app, token: reg.token });
  clients.push(c);
  return c;
};
/** Open a WebSocket and wait for its first message, or for it to be refused. */
const firstMessage = (url: string, headers?: Record<string, string>) =>
  new Promise<string>((res, rej) => {
    const ws = new WebSocket(url, { headers } as any);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      res(Buffer.from(e.data as ArrayBuffer).toString());
      ws.send(new TextEncoder().encode('RFB 003.008\n'));
      setTimeout(() => ws.close(), 100);
    };
    ws.onerror = () => rej(new Error('refused'));
  });
const upgradeStatus = async (url: string, headers: Record<string, string> = {}) =>
  (await fetch(url, { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers } })).status;

let runner: { app: string; token: string };
let reader: { app: string; token: string };
let acc: AccountsClient;
let read: AccountsClient;
let made: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-admin-'));
  vnc = Bun.listen({
    unix: join(dir, 'vnc.sock'),
    socket: {
      open: (s) => void s.write('RFB 003.008\n'),
      data: (_s, d) => void atVnc.push(Buffer.from(d).toString()),
    },
  });
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.get('fake')!.add = { blurb: 'for tests' };
  runner = await register(m.url, { name: 'runner', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'read' }] });
  reader = await register(m.url, { name: 'reader', requests: [{ interface: 'test.echo', level: 'manage' }] });
  await approveAll();
  acc = client(runner);
  read = client(reader);
  await until(() => acc.connected && read.connected, 4000, 'connected');
});
afterAll(async () => {
  for (const c of clients) c.close();
  await m.stop();
  vnc.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("an app's list: who made each account, whether it may run it, its live view", async () => {
  made = (await acc.admin({ do: 'create', kind: 'fake', label: 'Mine', config: { vncSocket: join(dir, 'vnc.sock') } })).id;
  const byPage = ((await (await fetch(`${m.url}/api/accounts`, { method: 'POST', body: JSON.stringify({ kind: 'fake', label: 'Page one' }) })).json()) as { id: string }).id;
  await until(() => acc.accounts.some((a) => a.id === made && a.online && a.liveView), 10_000, 'online with a live view');
  await until(() => acc.accounts.some((a) => a.id === byPage && a.online), 10_000, 'the page one online');
  const mine = acc.accounts.find((a) => a.id === made)!;
  expect(mine).toMatchObject({ origin: 'self', manages: true, liveView: true, error: null, grants: { 'test.echo': 'read' } });
  expect(acc.accounts.find((a) => a.id === byPage)).toMatchObject({ origin: 'page', manages: true, liveView: false });
  // The reader sees them through its grant, may not run them, and another app made the first.
  await until(() => read.accounts.length === 2, 4000, "the reader's list");
  expect(read.accounts.find((a) => a.id === made)).toMatchObject({ origin: 'app', manages: false, liveView: true });
});

test('why an account is not running reaches the app', async () => {
  const id = 'acc_lockedByOther';
  const d = join(dir, 'accounts', id);
  mkdirSync(d, { recursive: true });
  const sleeper = Bun.spawn(['sleep', '30']);
  writeFileSync(join(d, 'extractor.lock'), JSON.stringify({ pid: sleeper.pid, owner: 'someone else', at: new Date().toISOString() }));
  try {
    await acc.admin({ do: 'create', kind: 'fake', label: 'Locked', id });
    await until(() => !!acc.accounts.find((a) => a.id === id)?.error, 4000, 'the error in the list');
    expect(acc.accounts.find((a) => a.id === id)!.error).toBe(`someone else (pid ${sleeper.pid}) runs this account`);
  } finally {
    sleeper.kill();
    await acc.admin({ do: 'delete', account: id });
  }
});

test("its log, for an app that runs it and no other", async () => {
  const log = await acc.log(made, 50);
  expect(log.lines.some((l) => l.includes('fake extractor up'))).toBe(true);
  expect(log.size).toBeGreaterThan(0);
  expect((await acc.admin({ do: 'log', account: made, lines: 1 })).lines.length).toBeLessThanOrEqual(10);
  const e = (await read.log(made).catch((x) => x)) as CallFailed;
  expect(e).toBeInstanceOf(CallFailed);
  expect(e.code).toBe('denied');
});

test("its live view, on the app's token, for an app that runs it", async () => {
  expect(acc.liveViewUrl(made)).toContain(liveViewPath(made));
  expect(await firstMessage(acc.liveViewUrl(made))).toBe('RFB 003.008\n');
  await until(() => atVnc.join('').includes('RFB 003.008'), 3000, 'the reply at the VNC socket');
  // Not for an app that only reads it, a bad token, a browser, or an account without one.
  expect(await upgradeStatus(read.liveViewUrl(made).replace(/^ws/, 'http'))).toBe(403);
  expect(await upgradeStatus(acc.liveViewUrl(made).replace(/^ws/, 'http').replace(/token=[^&]+/, 'token=nope'))).toBe(401);
  expect(await upgradeStatus(acc.liveViewUrl(made).replace(/^ws/, 'http'), { origin: m.url })).toBe(403);
  const plain = acc.accounts.find((a) => a.origin === 'page')!.id;
  expect(await upgradeStatus(acc.liveViewUrl(plain).replace(/^ws/, 'http'))).toBe(404);
});

test('removing it: the directory stays unless purged, and only an app that runs it may', async () => {
  const keep = (await acc.admin({ do: 'create', kind: 'fake', label: 'Keep' })).id;
  const gone = (await acc.admin({ do: 'create', kind: 'fake', label: 'Gone' })).id;
  const dirOf = (id: string) => m.store.account(id)!.dir as string;
  const [kd, gd] = [dirOf(keep), dirOf(gone)];
  expect(((await read.admin({ do: 'delete', account: gone, purge: true }).catch((x) => x)) as CallFailed).code).toBe('denied');
  expect(await acc.admin({ do: 'delete', account: keep })).toMatchObject({ ok: true, purged: false, dir: kd });
  expect(existsSync(kd)).toBe(true);
  expect(await acc.admin({ do: 'delete', account: gone, purge: true })).toMatchObject({ ok: true, purged: true });
  expect(existsSync(gd)).toBe(false);
  await until(() => !acc.accounts.some((a) => a.id === keep || a.id === gone), 4000, 'both gone from the list');
});
