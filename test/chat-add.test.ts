/**
 * Chat accounts added on the manager's page reach the apps that read chat (dither-chat's hub), over the real wire:
 * a fake chat account's facts and a send; a Signal account through its real extractor on a fake signal-cli, from its
 * link QR to a new code (the page's "New code") to linked and online; a WhatsApp account through its real extractor
 * on a fake bridge, from its QR to a pairing code for a phone number. Nothing reaches a network.
 */
import type { UnixSocketListener } from 'bun';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import type { PageCallResult } from '../packages/manager/src/api-types.ts';

const ROOT = resolve(import.meta.dir, '..');
let m: Manager;
let dir: string;
let hub: AccountsClient;
let waCtl: UnixSocketListener<{ buf: string }>;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const page = async <T = any>(path: string, body?: unknown): Promise<T> => (await fetch(m.url + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;
const addOnPage = async (kind: string, label: string) => (await page<{ id: string }>('/api/accounts', { kind, label })).id;
const lastStatus = (id: string) => (events.get(id) ?? []).filter((e) => e.t === 'status').at(-1);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-chatadd-'));
  waCtl = Bun.listen<{ buf: string }>({
    unix: join(dir, 'wa.sock'),
    socket: {
      // The fake bridge's answer to a pairing request.
      open: (s) => void s.write(JSON.stringify({ result: { op: 'pairPhone', value: { code: 'ABCD1234' } } }) + '\n'),
      data: () => {},
    },
  });
  mkdirSync(join(dir, 'mgr'));
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0 });
  m.kinds.get('chat-fake')!.add = { blurb: 'for tests' };
  m.kinds.get('signal')!.env = { SIGNAL_CLI_BIN: `${process.execPath} ${join(ROOT, 'extractors/signal/test/fake-signal-cli.ts')}`, FAKE_LINK_TIMEOUT_MS: '30000' };
  m.kinds.get('whatsapp')!.env = { WHATSAPP_BRIDGE_BIN: `${process.execPath} ${join(ROOT, 'extractors/whatsapp/test/fake-bridge.ts')}`, FAKE_WA_SOCK: join(dir, 'wa.sock'), FAKE_WA_LOGGED_IN: '0' };
  // The hub's own requests (dither-chat's remote.ts), approved as they are.
  const reg = await register(m.url, {
    name: 'dither-chat',
    requests: [
      { interface: 'chat', level: 'manage', accounts: '*' },
      { interface: 'accounts', level: 'manage', kinds: ['discord', 'signal', 'matrix', 'whatsapp'] },
    ],
  });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  hub = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => (events.get(a) ?? events.set(a, []).get(a)!).push(...evs) });
  await until(() => hub.connected, 4000, 'the hub connected');
});
afterAll(async () => {
  hub?.close();
  await m.stop();
  waCtl.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("a chat account added on the page: the hub sees it, its facts arrive, the hub's send goes out", async () => {
  const id = await addOnPage('chat-fake', 'Fake on the page');
  const view = await until(() => hub.accounts.find((a) => a.id === id && a.online), 10_000, 'the hub sees it online');
  // The hub reads and writes it, but it does not run it: chat-fake is not one of its kinds.
  expect(view).toMatchObject({ origin: 'page', kind: 'chat-fake', interfaces: ['chat'], grants: { chat: 'manage' }, manages: false });
  await until(() => events.get(id)?.some((e) => e.t === 'message' && e.message.body === 'an old message'), 5000, 'the snapshot');
  expect(events.get(id)!.find((e) => e.t === 'hello')).toMatchObject({ capabilities: ['send', 'history', 'createGroup'] });
  const sent = await hub.call(chat, id, 'send', { conversation: 'dm:me:alice', body: 'hi from the hub' });
  expect(sent?.nativeId).toBeTruthy();
  await until(() => events.get(id)!.some((e) => e.t === 'message' && e.message.body === 'hi from the hub'), 5000, 'the echo');
});

test("making a group: the hub's createGroup reaches the account with its name and people, and its answer comes back", async () => {
  const id = await addOnPage('chat-fake', 'Fake that makes groups');
  await until(() => hub.accounts.find((a) => a.id === id && a.online), 10_000, 'the hub sees it online');
  // The capability is in the account's hello, which is how the hub knows to offer it.
  await until(() => events.get(id)?.some((e) => e.t === 'hello' && e.capabilities.includes('createGroup')), 5000, 'createGroup in its hello');
  const r = await hub.call(chat, id, 'createGroup', { name: ' Crag rats ', people: ['alice', 'bob', 'me'] });
  expect(r).toEqual({ conversation: 'group:Crag rats', added: [], invited: ['alice', 'bob'] });
  await until(() => events.get(id)!.some((e) => e.t === 'conversation' && e.conversation.nativeId === 'group:Crag rats'), 5000, 'the group fact');
  expect(events.get(id)!.find((e) => e.t === 'conversation' && e.conversation.nativeId === 'group:Crag rats')!.conversation).toMatchObject({ shape: 'group', participants: ['me', 'alice', 'bob'] });
  // Refused by the account: its sentence, not the manager's.
  await expect(hub.call(chat, id, 'createGroup', { people: ['alice'] })).rejects.toThrow('Give the room a name');
});

test('Signal added on the page: its link code, a new one from the page, then linked', async () => {
  const id = await addOnPage('signal', 'Signal on the page');
  const first = await until(() => (lastStatus(id)?.attention?.qr as string | undefined), 20_000, 'a link code');
  expect(lastStatus(id)).toMatchObject({ status: 'attention', attention: { kind: 'link_device' } });
  expect(first).toMatch(/^sgnl:\/\/linkdevice\?uuid=FAKE\d+&pub_key=KEY\d+$/);
  // The page's state carries the same attention, which is what it draws the code from.
  const st = await page('/api/state');
  expect(st.accounts.find((a: any) => a.id === id).status.attention.qr).toBe(first);
  // "New code" on the page: the account's own action, run as the page.
  const r = await page<PageCallResult>(`/api/accounts/${id}/call`, { op: 'action', input: { action: 'refreshLink' } });
  expect(r.ok).toBe(true);
  await until(() => lastStatus(id)?.attention?.qr && lastStatus(id)!.attention.qr !== first, 20_000, 'a new code');
  // The phone scans it.
  writeFileSync(join(m.store.account(id)!.dir, 'signal-cli', 'fake-scan'), 'ok');
  await until(() => lastStatus(id)?.status === 'online', 30_000, 'linked and online');
  expect(lastStatus(id)!.attention ?? null).toBeNull();
  // The hub could run it too: Signal is one of its kinds.
  expect(hub.accounts.find((a) => a.id === id)).toMatchObject({ origin: 'page', manages: true });
  await hub.admin({ do: 'delete', account: id, purge: true });
}, 90_000);

test('WhatsApp added on the page: its QR, then a pairing code for a phone number', async () => {
  const id = await addOnPage('whatsapp', 'WhatsApp on the page');
  await until(() => lastStatus(id)?.attention?.qr === '2@fake-qr', 20_000, 'the QR');
  const r = await page<PageCallResult>(`/api/accounts/${id}/call`, { op: 'action', input: { action: 'pairPhone', args: { phone: '+15551234567' } } });
  expect(r).toMatchObject({ ok: true, result: { code: 'ABCD-1234' } });
  await until(() => lastStatus(id)?.attention?.detail?.pairCode === 'ABCD-1234', 5000, 'the pairing code in its status');
  await hub.admin({ do: 'delete', account: id, purge: true });
}, 60_000);
