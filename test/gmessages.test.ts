/**
 * A Google Messages account through the manager, over the real wire: added as the page adds it, its extractor (the
 * real one, on the fake bridge) shows the pairing QR in its status, a scan pairs it and the session lands in its
 * secret.json, an app reads its facts and sends through it, a restart keeps the pairing, and unpairing on the phone
 * brings the QR back. Nothing reaches Google or a phone.
 */
import type { UnixSocketListener } from 'bun';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSecretFile } from '@dither-chat/protocol/secret-file';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import manifest from '../extractors/gmessages/manifest.ts';

const ROOT = resolve(import.meta.dir, '..');
const SESSION = { browser: { sourceID: 'browser-1' }, mobile: { sourceID: 'phone-1' }, tachyon_token: 'dG9rZW4=', request_crypto: { aes_key: 'a', hmac_key: 'b' }, refresh_key: {} };
const SETTINGS = { sims: [{ number: 1, phone: '+15550000001', formatted: '(555) 000-0001', carrier: 'Example Mobile', participant: '1', rcs: true }], rcsEnabled: true, readReceipts: true, typingIndicators: true };
const CONV = {
  id: '10',
  type: 'rcs',
  status: 'active',
  lastTs: 1_770_000_000_000,
  latestId: '100',
  outgoingId: '1',
  participants: [
    { id: '1', number: '+15550000001', isMe: true, visible: true },
    { id: '2', number: '+15550000002', fullName: 'Alice Example', visible: true },
  ],
};

let m: Manager;
let dir: string;
let app: AccountsClient;
let ctl: UnixSocketListener<{ buf: string }>;
let bridges: any[] = [];
const cmds: any[] = [];
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
const lastStatus = (id: string) => (events.get(id) ?? []).filter((e) => e.t === 'status').at(-1);
/** To the newest fake bridge: an event for it to print, or an answer to give. */
const toBridge = async (msg: unknown) => {
  await until(() => bridges.length > 0, 10_000, 'a bridge');
  bridges[bridges.length - 1].write(JSON.stringify(msg) + '\n');
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-gm-'));
  ctl = Bun.listen<{ buf: string }>({
    unix: join(dir, 'gm.sock'),
    socket: {
      open: (s) => {
        s.data = { buf: '' };
        bridges.push(s);
      },
      data: (s, d) => {
        s.data.buf += d.toString();
        let nl: number;
        while ((nl = s.data.buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(s.data.buf.slice(0, nl));
          s.data.buf = s.data.buf.slice(nl + 1);
          if (msg.cmd) cmds.push(msg.cmd);
        }
      },
      close: (s) => {
        bridges = bridges.filter((b) => b !== s);
      },
    },
  });
  mkdirSync(join(dir, 'mgr'));
  const kind = kindOf(manifest, join(ROOT, 'extractors/gmessages'));
  kind.env = { GMESSAGES_BRIDGE_BIN: `${process.execPath} ${join(ROOT, 'extractors/gmessages/test/fake-bridge.ts')}`, FAKE_GM_SOCK: join(dir, 'gm.sock'), FAKE_GM_QUIET: '1' };
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0, kinds: new Map([[kind.kind, kind]]) });
  const reg = await register(m.url, { name: 'texts', requests: [{ interface: 'chat', level: 'write', accounts: '*' }] });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => (events.get(a) ?? events.set(a, []).get(a)!).push(...evs) });
  await until(() => app.connected, 4000, 'the app connected');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  ctl?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

let id = '';

test('the kind can be added on the page: its form and what happens next', async () => {
  const st = await page('/api/state');
  const k = st.kinds.find((x: any) => x.kind === 'gmessages');
  expect(k).toMatchObject({ name: 'Google Messages', interfaces: ['chat'], add: { blurb: expect.stringContaining('stay on and online'), next: expect.stringContaining('Device pairing') } });
  expect(k.add.fields).toEqual([expect.objectContaining({ key: 'cookies', secret: true, optional: true })]);
});

test('added as the page does: a QR code to scan in its status, then a scan pairs it into secret.json and it is online', async () => {
  id = (await page<{ id: string }>('/api/accounts', { kind: 'gmessages', label: 'My phone' })).id;
  expect(id).toBeTruthy();
  const st = await until(() => (lastStatus(id)?.attention?.qr ? lastStatus(id) : undefined), 20_000, 'the QR code');
  expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', qr: expect.stringContaining('support.google.com/messages') } });
  expect(st!.layers.map((l: any) => l.name)).toEqual(['bridge', 'phone', 'paired', 'connected']);
  expect(events.get(id)!.find((e) => e.t === 'hello')).toMatchObject({ network: 'gmessages' });
  // The page sees the same.
  const acc = (await page('/api/state')).accounts.find((a: any) => a.id === id);
  expect(acc.layers.find((l: any) => l.name === 'paired').state).toBe('waiting');

  await toBridge({ result: { op: 'conversations', value: { conversations: [CONV] } } });
  await toBridge({ emit: { t: 'paired', via: 'qr', phone: 'phone-1', session: SESSION } });
  await toBridge({ emit: { t: 'connected', google: false } });
  await toBridge({ emit: { t: 'settings', settings: SETTINGS } });
  await toBridge({ emit: { t: 'alert', alert: 'browser_active' } });
  await until(() => lastStatus(id)?.status === 'online', 10_000, 'online');
  expect(readSecretFile<any>(join(m.store.account(id)!.dir, 'secret.json')).session).toEqual(SESSION);
  expect(lastStatus(id)).toMatchObject({ self: { handle: '+15550000001', isSelf: true }, details: { pairedVia: 'qr', phoneNumber: '+15550000001' } });
  await until(() => app.accounts.find((a) => a.id === id)?.online, 5000, 'the app sees it online');
});

test("an app gets its facts and sends through it", async () => {
  const conv = await until(() => events.get(id)!.find((e) => e.t === 'conversation'), 10_000, 'the conversation');
  expect(conv.conversation).toMatchObject({ shape: 'direct', participants: [expect.stringMatching(/:me$/), '+15550000002'] });
  expect(events.get(id)!.find((e) => e.t === 'identity' && e.identity.nativeId === '+15550000002')!.identity).toMatchObject({ displayName: 'Alice Example' });
  const cid = conv.conversation.nativeId as string;
  await toBridge({ emit: { t: 'message', message: { id: '101', conversation: '10', participant: '2', ts: 1_770_000_001_000, status: 'INCOMING_COMPLETE', state: 'received', kind: 'rcs', text: 'are you there?' } } });
  const incoming = await until(() => events.get(id)!.find((e) => e.t === 'message' && e.message.body === 'are you there?'), 5000, 'the message');
  expect(incoming).toMatchObject({ live: true, message: { conversation: cid, author: '+15550000002' } });

  const sent = await app.call(chat, id, 'send', { conversation: cid, body: 'yes', replyTo: incoming.message.nativeId });
  expect(sent?.nativeId).toEndWith(':m91');
  expect(cmds.find((c) => c.op === 'send')).toMatchObject({ conversation: '10', text: 'yes', replyTo: '101' });
  await until(() => events.get(id)!.some((e) => e.t === 'message' && e.message.nativeId === sent!.nativeId), 5000, 'the phone’s copy');

  await app.call(chat, id, 'markRead', { conversation: cid, upTo: incoming.message.nativeId });
  expect(cmds.find((c) => c.op === 'markRead')).toMatchObject({ conversation: '10', message: '101' });
  await app.call(chat, id, 'react', { conversation: cid, message: incoming.message.nativeId, key: '👍' });
  expect(cmds.find((c) => c.op === 'react')).toMatchObject({ message: '101', emoji: '👍', action: 'add' });
  await until(() => events.get(id)!.some((e) => e.t === 'reaction' && e.key === '👍'), 5000, 'the reaction');
  const about = await app.call(chat, id, 'about', { target: { kind: 'conversation', nativeId: cid } });
  expect(about).toMatchObject({ noun: 'Conversation', members: { total: 2 } });
  // The phone not answering: the app hears it as attention.
  await toBridge({ emit: { t: 'phone', responding: false } });
  await until(() => lastStatus(id)?.status === 'attention', 5000, 'attention');
  expect(lastStatus(id)!.layers.find((l: any) => l.name === 'phone').state).toBe('failed');
  await toBridge({ emit: { t: 'phone', responding: true } });
  await until(() => lastStatus(id)?.status === 'online', 5000, 'online again');
});

test('a restart keeps the pairing: it connects with the session and pairs nothing', async () => {
  const before = cmds.length;
  const seen = (events.get(id) ?? []).length;
  await page(`/api/accounts/${id}/restart`, {});
  await until(() => cmds.slice(before).some((c) => c.op === 'connect'), 20_000, 'connect after the restart');
  expect(cmds.slice(before).find((c) => c.op === 'connect').session).toEqual(SESSION);
  await until(() => (events.get(id) ?? []).slice(seen).some((e) => e.t === 'hello'), 15_000, 'the new extractor’s hello');
  await until(() => (events.get(id) ?? []).slice(seen).some((e) => e.t === 'status' && e.status === 'online'), 15_000, 'online after the restart');
  expect(cmds.slice(before).some((c) => c.op === 'startQr' || c.op === 'pairGoogle')).toBe(false);
});

test('unpaired on the phone: the session is gone from secret.json and a new QR code shows', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  const n = (events.get(id) ?? []).length;
  await toBridge({ emit: { t: 'unpaired', reason: 'revoked' } });
  const st = await until(() => (events.get(id) ?? []).slice(n).filter((e) => e.t === 'status' && e.attention?.qr).at(-1), 10_000, 'a new QR code');
  expect(st!.attention.message).toContain('removed under Device pairing');
  expect(readSecretFile<any>(join(m.store.account(id)!.dir, 'secret.json')).session).toBeUndefined();
});
