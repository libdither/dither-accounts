/**
 * The luma kind in a real manager, with no browser (so it runs in CI, where luma-browser.test.ts skips): an RSVP is an
 * account action, held at manage, so an app with write on chat is refused before anything reaches the account; and
 * the City is a text setting, kept in the account's config, checked, and cleared by an empty value.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, type CallFailed, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';

const ROOT = join(import.meta.dir, '..');
let m: Manager;
let dir: string;
let acc = '';
const clients: AccountsClient[] = [];

const until = async (f: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, method = 'GET', body?: unknown) => fetch(m.url + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
async function client(name: string, requests: any[]): Promise<AccountsClient> {
  const reg = await register(m.url, { name, requests });
  for (const r of reg.requests) expect((await api(`/api/requests/${r.id}/approve`, 'POST', {})).status).toBe(200);
  const c = new AccountsClient({ url: m.url, app: reg.app, token: reg.token });
  clients.push(c);
  await until(() => c.connected, 5000, `${name} connected`);
  return c;
}
const info = async () => ((await (await api('/api/state')).json()) as any).accounts.find((a: any) => a.id === acc);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-luma-mgr-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.set('luma', kindOf((await import(join(ROOT, 'extractors/luma/manifest.ts'))).default, join(ROOT, 'extractors/luma')));
  const admin = await client('luma-admin', [{ interface: 'accounts', level: 'manage', kinds: ['luma'] }]);
  // Stopped: nothing starts a browser; the refusal and the settings are the manager's alone.
  acc = ((await admin.admin({ do: 'create', kind: 'luma', label: 'Luma (stopped)', enabled: false, config: { city: 'exampletown' } } as any)) as { id: string }).id;
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('an RSVP below manage is refused by the manager, and the account is never asked', async () => {
  const writer = await client('luma-writer', [{ interface: 'chat', level: 'write', accounts: '*' }]);
  await until(() => writer.accounts?.some((a) => a.id === acc) ?? false, 5000, 'the account visible');
  for (const status of ['going', 'declined']) {
    const e = (await writer.call(chat, acc, 'action', { action: 'rsvp', args: { eventId: 'evt-Open000000000001', status } } as any).catch((x) => x)) as CallFailed;
    expect(e.code).toBe('denied');
  }
  // At manage it gets as far as the account, which is stopped.
  const manager = await client('luma-manager', [{ interface: 'chat', level: 'manage', accounts: '*' }]);
  await until(() => manager.accounts?.some((a) => a.id === acc) ?? false, 5000, 'the account visible');
  const off = (await manager.call(chat, acc, 'action', { action: 'rsvp', args: { eventId: 'evt-Open000000000001', status: 'going' } } as any).catch((x) => x)) as CallFailed;
  expect(off.code).toBe('offline');
}, 30_000);

test('the City is a text setting: shown with its value, checked, changed, and cleared by an empty value', async () => {
  expect((await info()).settings).toEqual([{ key: 'city', label: 'City', note: expect.any(String), type: 'text', value: 'exampletown', placeholder: 'nyc' }]);
  expect((await api(`/api/accounts/${acc}`, 'PATCH', { settings: { city: 'not/a city' } })).status).toBe(400);
  expect((await api(`/api/accounts/${acc}`, 'PATCH', { settings: { city: true } })).status).toBe(400);
  expect((await api(`/api/accounts/${acc}`, 'PATCH', { settings: { city: 'x'.repeat(300) } })).status).toBe(400);
  expect((await info()).settings[0].value).toBe('exampletown');
  expect((await api(`/api/accounts/${acc}`, 'PATCH', { settings: { city: '  othertown ' } })).status).toBe(200);
  expect((await info()).settings[0].value).toBe('othertown');
  expect((await api(`/api/accounts/${acc}`, 'PATCH', { settings: { city: '' } })).status).toBe(200);
  expect((await info()).settings[0].value).toBe('');
});
