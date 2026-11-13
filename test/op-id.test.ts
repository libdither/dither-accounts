/**
 * An op input named `id` (mail.get, cal.delete, notify.mute…) reaches the extractor as the app sent it, and an op
 * whose `id` is optional (cal.put: none means create) gets none when the app sent none. The call's own id travels as
 * `rid`; chat adapters still answer by `id`, which the manager sends too when the input has none.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';

let m: Manager;
let dir: string;
let c: AccountsClient;
let account: string;

const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-opid-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  const app = await register(m.url, { name: 'ids', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'read' }] });
  for (const r of app.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  c = new AccountsClient({ url: m.url, app: app.app, token: app.token });
  await until(() => c.connected, 4000, 'connect');
  account = (await c.admin({ do: 'create', kind: 'fake', label: 'ids' })).id;
  await until(() => c.accounts.some((a) => a.id === account && a.online), 10_000, 'the extractor online');
}, 20_000);

afterAll(async () => {
  c?.close();
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('an input named id reaches the extractor', async () => {
  expect(await c.call(testEcho, account, 'echoId', { id: 'msg-42' })).toEqual({ id: 'msg-42' });
});

test("an optional id left out stays out: the extractor is not handed the call's own id", async () => {
  expect(await c.call(testEcho, account, 'echoId', {})).toEqual({ id: null });
  expect(await c.call(testEcho, account, 'echo', { text: 'hi' })).toEqual({ text: 'hi' });
});

test("a stopped extractor's last status is not kept as if it still held", async () => {
  expect(m.router.lastStatus(account)).not.toBeNull();
  await m.sup.stop(account);
  await until(() => !m.sup.state(account).running, 5000, 'stopped');
  expect(m.router.lastStatus(account)).toBeNull();
  m.sup.start(account);
  await until(() => m.router.lastStatus(account) !== null, 10_000, 'a new status');
});
