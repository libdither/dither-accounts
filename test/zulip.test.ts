/**
 * The zulip kind over the real wire: a manager with it, an account added through the page's API, the extractor on a
 * fake Zulip (extractors/zulip/test/fake-zulip.ts, an invented organization), and an app with the hub's chat grant:
 * the add form, a password swapped for the API key and never kept or shown, the organization's structure and
 * messages reaching the app, and sending, reacting and history through the chat interface.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import manifest from '../extractors/zulip/manifest.ts';
import { fakeZulip } from '../extractors/zulip/test/fake-zulip.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
let fake: ReturnType<typeof fakeZulip>;
let m: Manager;
let dir: string;
let hub: AccountsClient;
let id: string;
let host: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false, ms = 10_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const evs = (acc: string, t: string) => (events.get(acc) ?? []).filter((e) => e.t === t);
const call = (op: string, input: unknown) => hub.call(chat, id, op as any, input as any) as Promise<any>;

beforeAll(async () => {
  fake = fakeZulip();
  host = new URL(fake.url).host;
  dir = mkdtempSync(join(tmpdir(), 'dacc-zulip-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['zulip', kindOf(manifest, join(ROOT, 'extractors/zulip'))]]) });
  const reg = await register(m.url, { name: 'dither-chat', requests: [{ interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  hub = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, e) => (events.get(a) ?? events.set(a, []).get(a)!).push(...e) });
  await until(() => hub.connected, 4000, 'the hub connected');
});
afterAll(async () => {
  hub?.close();
  await m?.stop();
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('adding one with a password: the key kept in its place, the password nowhere', async () => {
  const kinds = ((await (await fetch(`${m.url}/api/state`, { headers: { origin: m.url } })).json()) as any).kinds;
  expect(kinds.find((k: any) => k.kind === 'zulip').add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['server', false, false],
    ['email', false, false],
    ['apiKey', true, true],
    ['password', true, true],
  ]);
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { origin: m.url }, body: JSON.stringify({ kind: 'zulip', label: 'Zulip', config: { server: fake.url, email: 'quinn@example.com' }, secret: { password: 'pw' } }) });
  expect(r.status).toBe(200);
  id = ((await r.json()) as { id: string }).id;
  const online = await until(() => evs(id, 'status').at(-1)?.status === 'online' && evs(id, 'status').at(-1), 10_000, 'online');
  expect(online.attention).toBeNull();
  expect(evs(id, 'hello')[0]).toMatchObject({ network: 'zulip' });
  expect(evs(id, 'hello')[0].capabilities).toEqual(expect.arrayContaining(['send', 'history', 'react', 'threads', 'polls', 'search']));
  const accDir = m.store.account(id)!.dir;
  const secret = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8'));
  expect(secret).toEqual({ apiKey: fake.key, email: 'quinn@example.com' });
  const detail = await (await fetch(`${m.url}/api/accounts/${id}`, { headers: { origin: m.url } })).json();
  const elsewhere = JSON.stringify(detail) + JSON.stringify(events.get(id)) + readFileSync(join(accDir, 'adapter.log'), 'utf8');
  for (const s of [fake.key, 'quinn@example.com:']) expect(elsewhere).not.toContain(s);
});

test('the organization, its channels and topics, and its messages reach the app', async () => {
  await until(() => evs(id, 'message').some((e) => e.message.nativeId === `${host}/m/102`), 10_000, 'the DM');
  expect(evs(id, 'space').map((e) => e.space.name)).toEqual(['Example Org', 'Work']);
  const conv = (n: string) => evs(id, 'conversation').find((e) => e.conversation.nativeId === n)?.conversation;
  expect(conv(`${host}/s/3`)).toMatchObject({ variant: 'forum', name: 'general' });
  expect(conv(`${host}/s/3/t/plans`)).toMatchObject({ shape: 'thread', parentConversation: `${host}/s/3` });
});

test('sending, reacting and history through the chat interface', async () => {
  expect(await call('send', { conversation: `${host}/s/3/t/plans`, body: 'from the app' })).toEqual({ nativeId: `${host}/m/200` });
  expect(fake.calls.findLast((c) => c.path === '/messages' && c.method === 'POST')!.params).toMatchObject({ type: 'stream', to: 3, topic: 'plans', content: 'from the app' });
  await call('react', { conversation: `${host}/s/3/t/plans`, message: `${host}/m/100`, key: '😄' });
  expect(fake.calls.findLast((c) => c.path === '/messages/100/reactions')!.params).toMatchObject({ emoji_name: 'smile' });
  expect(await call('history', { conversation: `${host}/s/3/t/plans`, limit: 10 })).toMatchObject({ count: 2, done: true });
});
