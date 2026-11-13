/**
 * The messenger kind end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc)
 * with its extension, against the fake Messenger (fake-messenger.ts, its page fake-messenger-page.js): Haste-style
 * modules and a LightSpeed-shaped database. Online with every layer ok; the snapshot and live changes as chat facts;
 * sending through the client's composer (an end-to-end encrypted chat too), then through the client's own task shapes
 * once it was seen using them; media; the survey; a signed-out browser asking for the sign-in; an app the hook cannot
 * find going to "selector_broken"; nothing secret in logs or statuses; every process gone at the end. Skipped without
 * Xvfb, chromium and x11vnc.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { resolveBins } from '../packages/browser/src/index.ts';
import { ALICE, BOB, type FakeMeta, MS, SELF, startFakeMeta } from './fake-messenger.ts';
import { metaKinds } from './messenger-kinds.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`messenger-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeMeta;
let out: FakeMeta;
let broken: FakeMeta;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let acc = '';
const ids: string[] = [];
const events: Record<string, any[]> = {};
const saved = process.env.DITHER_META_GRACE_MS;

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms: number, what: string): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const evs = (a = acc) => events[a] ?? [];
const statusOf = (a = acc) => evs(a).filter((e) => e.t === 'status').at(-1);
const call = (op: string, input: any) => app.call(chat, acc, op as any, input) as Promise<any>;
const message = (id: string) => evs().filter((e) => e.t === 'message' && e.message.nativeId === id).at(-1);

function processesOf(list: string[]): number[] {
  const needles = list.map((id) => `DITHER_ACCOUNT_ID=${id}`);
  const found: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (needles.some((n) => env.includes(n))) found.push(Number(d));
    } catch {}
  }
  return found;
}

beforeAll(async () => {
  if (!bins) return;
  process.env.DITHER_META_GRACE_MS = '8000';
  fake = await startFakeMeta({ site: 'messenger' });
  out = await startFakeMeta({ site: 'messenger', signedIn: false });
  broken = await startFakeMeta({ site: 'messenger', missing: ['LSDatabaseSingleton', 'LSDatabaseSingletonLazyWrapper'] });
  dir = mkdtempSync(join(tmpdir(), 'dacc-messenger-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: await metaKinds() });
  const reg = await register(m.url, { name: 'chat-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['messenger'] }, { interface: 'chat', level: 'manage' }] });
  for (const r of reg.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => (events[a] ??= []).push(...list) });
  await until(() => app.connected, 5000, 'the app connected');
}, 60_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  await m?.stop();
  for (const pid of processesOf(ids)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  out?.stop();
  broken?.stop();
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.DITHER_META_GRACE_MS;
  else process.env.DITHER_META_GRACE_MS = saved;
}, 30_000);

it(
  'online with every layer ok; who it is; the hooks it found, by name',
  async () => {
    acc = (await app.admin({ do: 'create', kind: 'messenger', label: 'Messenger (test)', config: { testOrigin: fake.url } })).id;
    ids.push(acc);
    await until(() => statusOf()?.status === 'online' && statusOf()?.layers?.every((l: any) => l.state === 'ok'), 90_000, 'online');
    const st = statusOf();
    expect(st.attention).toBeNull();
    expect(st.self).toEqual({ nativeId: SELF.fb, isSelf: true });
    expect(st.layers.map((l: any) => l.name)).toEqual(['display', 'browser', 'extension', 'signed in', 'client modules', 'mailbox', 'live updates', 'first snapshot', 'sending']);
    expect(st.layers.find((l: any) => l.name === 'mailbox').note).toBe('LightSpeed database via LSDatabaseSingleton, read via ReQL');
    expect(st.layers.find((l: any) => l.name === 'live updates').note).toBe('via subscriptionManager');
    expect(st.layers.find((l: any) => l.name === 'sending').note).toMatch(/^send via composer; reply —; react —/);
    expect(st.details).toMatchObject({ backend: 'ls', appPage: true, signedIn: true, 'hook.ls.db': 'LSDatabaseSingleton', 'hook.modules': '__debug.modulesMap', 'hook.ls.react': 'missing', bundleRevision: '1029384756', page: `${fake.url}/` });
    const hello = evs().filter((e) => e.t === 'hello').at(-1);
    expect(hello.network).toBe('messenger');
    expect(hello.capabilities).toEqual(expect.arrayContaining(['send', 'history', 'media', 'e2ee', 'markRead', 'liveView']));
    expect(hello.capabilities).not.toContain('react');
  },
  120_000,
);

it('the snapshot as chat facts: people, chats (the encrypted one too), backfill, read state', async () => {
  const people = evs().filter((e) => e.t === 'identity').map((e) => e.identity);
  expect(people.find((p) => p.nativeId === ALICE.fb)).toMatchObject({ displayName: ALICE.name, handle: ALICE.username });
  const convs = Object.fromEntries(evs().filter((e) => e.t === 'conversation').map((e) => [e.conversation.nativeId, e.conversation]));
  expect(convs[MS.e2ee]).toMatchObject({ shape: 'direct', encrypted: true, participants: [SELF.fb, BOB.fb].sort() });
  expect(convs[MS.group]).toMatchObject({ shape: 'group', name: 'Pelican Club' });
  expect(message('mid.$e1').message.body).toBe('secret plans, decrypted in the page');
  expect(message('mid.$g1').message.body).toBe('hey <@100000000000001>, pelicans');
  expect(message('mid.$a1').live).toBe(false);
  expect(evs().some((e) => e.t === 'read' && e.conversation === MS.direct)).toBe(true);
});

it(
  'live: a message, a reaction, typing, a receipt, an unsend',
  async () => {
    const id = fake.fake.deliver(MS.direct, 'are you there?');
    const got = await until(() => message(id), 15_000, 'the message');
    expect(got.live).toBe(true);
    expect(got.message).toMatchObject({ conversation: MS.direct, author: ALICE.fb, body: 'are you there?' });
    fake.fake.react(id, '👍');
    await until(() => evs().find((e) => e.t === 'reaction' && e.message === id && e.key === '👍'), 15_000, 'the reaction');
    fake.fake.typing(MS.direct, true);
    await until(() => evs().find((e) => e.t === 'typing' && e.conversation === MS.direct && !e.stop), 15_000, 'typing');
    fake.fake.readByAlice(MS.direct);
    await until(() => evs().find((e) => e.t === 'receipt' && e.messages[0] === id && e.who === ALICE.fb), 15_000, 'the receipt');
    fake.fake.unsendByThem(id);
    await until(() => evs().find((e) => e.t === 'delete' && e.nativeId === id), 15_000, 'the delete');
  },
  60_000,
);

it(
  'sending through the composer: a plain chat (the client queues its own task), an encrypted one (its worker)',
  async () => {
    const sent = await call('send', { conversation: MS.direct, body: 'hello from dither' });
    expect(sent.nativeId).toMatch(/^mid\.\$srv/);
    expect(fake.fake.calls.find((c) => c.path === '/ls_req' && c.label === '46')).toBeTruthy();
    // The echo is the server's copy, said once; the client's optimistic one never reaches the app.
    await until(() => message(sent.nativeId), 15_000, 'our message');
    expect(evs().some((e) => e.t === 'message' && /^mid\.\$opt/.test(e.message.nativeId))).toBe(false);
    const e2ee = await call('send', { conversation: MS.e2ee, body: 'for bob only' });
    expect(e2ee.nativeId).toMatch(/^mid\.\$srv/);
    expect(fake.fake.calls.find((c) => c.path === '/maw')?.route).toBe('backend/sendTextMessage');
  },
  90_000,
);

it(
  'what the client does by hand it learns, then does the same way: react, edit, unsend, mark read',
  async () => {
    fake.fake.userAction({ type: 'react', thread: MS.direct, message: 'mid.$a1', emoji: '😮' });
    fake.fake.userAction({ type: 'edit', thread: MS.direct, message: 'mid.$a2', text: 'hi alice!' });
    fake.fake.userAction({ type: 'unsend', thread: MS.group, message: 'mid.$g1' });
    fake.fake.userAction({ type: 'markRead', thread: MS.direct });
    await until(() => statusOf()?.details?.['hook.ls.react'] !== 'missing' && statusOf()?.details?.['hook.ls.unsend'] !== 'missing', 30_000, 'react and unsend learned');
    await until(() => evs().filter((e) => e.t === 'hello').at(-1)?.capabilities.includes('react'), 10_000, 'the react capability');
    const learned = JSON.parse(readFileSync(join(dir, 'accounts', acc, 'learned.json'), 'utf8'));
    // 46 too: the composer send above went out as the client's own task, so its shape is known now.
    expect(Object.keys(learned).sort()).toEqual(['21', '29', '33', '46', '742']);
    expect(statusOf()?.details?.['hook.ls.send']).toBe('task 46 (as the client sent it)');
    expect(JSON.stringify(learned)).not.toMatch(/hi alice|😮/);
    const before = fake.fake.tasks.length;
    await call('react', { conversation: MS.direct, message: 'mid.$a3', key: '🎉' });
    await until(() => evs().find((e) => e.t === 'reaction' && e.message === 'mid.$a3' && e.key === '🎉' && e.author === SELF.fb), 15_000, 'our reaction');
    await call('edit', { conversation: MS.direct, message: 'mid.$a2', body: 'hi alice, edited' });
    await until(() => message('mid.$a2')?.message.body === 'hi alice, edited', 15_000, 'the edit');
    await call('redact', { conversation: MS.direct, message: 'mid.$a2' });
    await until(() => evs().find((e) => e.t === 'delete' && e.nativeId === 'mid.$a2'), 15_000, 'the unsend');
    for (const label of ['29', '742', '33']) {
      const ts = fake.fake.tasks.filter((t) => t.label === label);
      expect(ts.length).toBe(2);
      expect(ts[1]).toEqual(ts[0]);
    }
    expect(fake.fake.tasks.length).toBe(before + 3);
    // Not for an encrypted chat: the client does that through its worker, which is not hooked.
    await expect(call('react', { conversation: MS.e2ee, message: 'mid.$e1', key: '👍' })).rejects.toThrow(/end-to-end encrypted/);
  },
  90_000,
);

it(
  'media from the page, history, the survey (shapes and names only)',
  async () => {
    const pic = message('mid.$a3').message.attachments[0];
    expect(pic.url.startsWith('meta-media:')).toBe(true);
    const media = await call('fetchMedia', { url: pic.url });
    expect(media.mime).toBe('image/png');
    expect(Buffer.from(media.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(await call('history', { conversation: MS.direct, limit: 50 })).toEqual({ count: expect.any(Number), done: true });
    const survey = await call('action', { action: 'survey' });
    expect(survey.backend).toBe('ls');
    expect(survey.hooks['ls.db'].via).toBe('LSDatabaseSingleton');
    expect(survey.trace.some((t: any) => t.kind === 'task' && t.name === 'label 29')).toBe(true);
    const text = JSON.stringify(survey);
    for (const secret of ['hello from alice', 'secret plans', 'Alice Archer', 'Pelican Club', 'hi alice', 'secret snippet']) expect(text).not.toContain(secret);
  },
  60_000,
);

it(
  'signed out: asks for the sign-in, with the live view',
  async () => {
    const id = (await app.admin({ do: 'create', kind: 'messenger', label: 'Messenger (out)', config: { testOrigin: out.url } })).id;
    ids.push(id);
    await until(() => statusOf(id)?.attention?.kind === 'login', 60_000, 'login attention');
    const st = statusOf(id);
    expect(st.attention).toMatchObject({ message: 'Sign in to Messenger in the live view', liveView: true });
    expect(st.layers.find((l: any) => l.name === 'signed in')).toMatchObject({ state: 'waiting', note: 'sign in to Messenger in the live view' });
  },
  90_000,
);

it(
  'an app whose mailbox the hook cannot find: selector_broken, naming the hook',
  async () => {
    const id = (await app.admin({ do: 'create', kind: 'messenger', label: 'Messenger (changed)', config: { testOrigin: broken.url } })).id;
    ids.push(id);
    await until(() => statusOf(id)?.attention?.kind === 'selector_broken', 60_000, 'selector_broken');
    const st = statusOf(id);
    expect(st.attention.message).toMatch(/web app changed: ls\.db not found/);
    expect(st.layers.find((l: any) => l.state === 'failed')?.name).toBe('mailbox');
    expect(st.details['hook.ls.db']).toBe('missing');
  },
  90_000,
);

it(
  'nothing secret in logs or statuses; every process gone when the manager stops',
  async () => {
    const logs = ids.map((id) => readFileSync(join(dir, 'accounts', id, 'adapter.log'), 'utf8')).join('\n');
    const statuses = JSON.stringify(Object.values(events).flat().filter((e) => e.t === 'status'));
    for (const secret of ['hello from alice', 'secret plans', 'are you there', 'hello from dither', 'for bob only', 'hi alice', 'Alice Archer', 'Bob Baker', 'Sam Self', 'Pelican Club', 'secret=query', 'secret-hash', 'secret snippet', '+1 555']) {
      expect(logs).not.toContain(secret);
      expect(statuses).not.toContain(secret);
    }
    expect(logs).toContain('hooks:');
    await m!.stop();
    m = null;
    await until(() => processesOf(ids).length === 0, 15_000, 'every process gone');
  },
  60_000,
);
