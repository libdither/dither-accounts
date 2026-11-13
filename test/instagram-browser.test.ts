/**
 * The instagram kind end to end: a real manager runs the extractor in a real Chromium on Xvfb (with x11vnc and its
 * extension) against the fake Instagram (fake-messenger.ts in its instagram mode): the Slide mailbox in a Relay
 * store, the delta router, the typing transformer and the IGDMAPI* message modules. Online with every layer ok; the
 * snapshot and live changes; sending, replying, reacting, editing, typing, marking read and history through
 * Instagram's own modules; media; a page without the send module going read-only (online, "sending" failed, no send
 * capability); a signed-out browser asking for the sign-in; nothing secret said; every process gone. Skipped without
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
import { ALICE, type FakeMeta, IG, SELF, startFakeMeta } from './fake-messenger.ts';
import { metaKinds } from './messenger-kinds.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`instagram-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeMeta;
let out: FakeMeta;
let readOnly: FakeMeta;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let acc = '';
const ids: string[] = [];
const events: Record<string, any[]> = {};

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
const call = (op: string, input: any, a = acc) => app.call(chat, a, op as any, input) as Promise<any>;
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
  fake = await startFakeMeta({ site: 'instagram' });
  out = await startFakeMeta({ site: 'instagram', signedIn: false });
  readOnly = await startFakeMeta({ site: 'instagram', missing: ['IGDMAPISendTextMessage'] });
  dir = mkdtempSync(join(tmpdir(), 'dacc-instagram-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: await metaKinds() });
  const reg = await register(m.url, { name: 'chat-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['instagram'] }, { interface: 'chat', level: 'manage' }] });
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
  readOnly?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

it(
  'online with every layer ok, on the Slide store',
  async () => {
    acc = (await app.admin({ do: 'create', kind: 'instagram', label: 'Instagram (test)', config: { testOrigin: fake.url } })).id;
    ids.push(acc);
    await until(() => statusOf()?.status === 'online' && statusOf()?.layers?.every((l: any) => l.state === 'ok'), 90_000, 'online');
    const st = statusOf();
    expect(st.self).toEqual({ nativeId: SELF.eimu, isSelf: true });
    expect(st.layers.find((l: any) => l.name === 'mailbox').note).toBe('Relay store via PolarisRelayEnvironment');
    expect(st.layers.find((l: any) => l.name === 'live updates').note).toBe('via store.publish');
    expect(st.layers.find((l: any) => l.name === 'sending').note).toBe('send via IGDMAPISendTextMessage; react via IGDMAPISendReaction; edit via IGDMAPIEditMessage; unsend —; mark read via useIGDMarkThreadAsReadMutation; typing via IGDMAPISendTypingIndicator');
    expect(st.details).toMatchObject({ backend: 'slide', page: `${fake.url}/direct/inbox/`, 'hook.slide.unsend': 'missing', 'hook.slide.deltas': 'IGDSlideMutationProcessor' });
    const hello = evs().filter((e) => e.t === 'hello').at(-1);
    expect(hello.network).toBe('instagram');
    expect(hello.capabilities).toEqual(expect.arrayContaining(['send', 'react', 'edit', 'markRead', 'typing', 'history', 'media']));
    expect(hello.capabilities).not.toContain('redact');
    expect(hello.capabilities).not.toContain('e2ee');
  },
  120_000,
);

it('the snapshot as chat facts', async () => {
  const convs = Object.fromEntries(evs().filter((e) => e.t === 'conversation').map((e) => [e.conversation.nativeId, e.conversation]));
  expect(convs[IG.direct]).toMatchObject({ shape: 'direct', participants: [ALICE.eimu, SELF.eimu].sort() });
  expect(convs[IG.group]).toMatchObject({ shape: 'group', name: 'Heron Club' });
  expect(evs().filter((e) => e.t === 'identity').map((e) => e.identity).find((p) => p.nativeId === ALICE.eimu)).toMatchObject({ displayName: ALICE.name, handle: ALICE.username });
  expect(message('mid.$ig2').message.reactions).toEqual([{ key: '😂', authors: [ALICE.eimu] }]);
  expect(message('mid.$ig3').message).toMatchObject({ kind: 'media', attachments: [{ nativeId: '800000000000001', kind: 'image' }] });
  expect(message('mid.$ig4').message.editedTs).toEqual(expect.any(Number));
});

it(
  'live: a message, a reaction, typing, a receipt, an unsend by them',
  async () => {
    const id = fake.fake.deliver(IG.direct, 'are you there?');
    expect((await until(() => message(id), 15_000, 'the message')).live).toBe(true);
    fake.fake.react(id, '🔥');
    await until(() => evs().find((e) => e.t === 'reaction' && e.message === id && e.key === '🔥' && e.author === ALICE.eimu), 15_000, 'the reaction');
    fake.fake.typing(IG.direct, true);
    await until(() => evs().find((e) => e.t === 'typing' && e.conversation === IG.direct && e.author === ALICE.eimu), 15_000, 'typing');
    fake.fake.readByAlice(IG.direct);
    await until(() => evs().find((e) => e.t === 'receipt' && e.messages[0] === id && e.who === ALICE.eimu), 15_000, 'the receipt');
    fake.fake.unsendByThem(id);
    await until(() => evs().find((e) => e.t === 'delete' && e.nativeId === id), 15_000, 'the delete');
  },
  60_000,
);

it(
  'commands through Instagram’s own modules',
  async () => {
    const sent = await call('send', { conversation: IG.direct, body: 'hello from dither', replyTo: 'mid.$ig1' });
    expect(sent.nativeId).toMatch(/^mid\.\$igsrv/);
    const echo = await until(() => message(sent.nativeId), 15_000, 'our message');
    expect(echo.message).toMatchObject({ author: SELF.eimu, body: 'hello from dither' });
    await call('react', { conversation: IG.direct, message: 'mid.$ig1', key: '❤️' });
    await until(() => evs().find((e) => e.t === 'reaction' && e.message === 'mid.$ig1' && e.author === SELF.eimu), 15_000, 'our reaction');
    await call('edit', { conversation: IG.direct, message: sent.nativeId, body: 'hello, edited' });
    await until(() => message(sent.nativeId)?.message.body === 'hello, edited', 15_000, 'the edit');
    await call('typing', { conversation: IG.direct });
    expect(fake.fake.typingOut.at(-1)).toEqual({ thread: IG.directIg, on: true });
    await call('markRead', { conversation: IG.direct, upTo: 'mid.$ig3' });
    expect(fake.fake.reads.at(-1)).toEqual({ thread: IG.direct, message: 'mid.$ig3' });
    const before = message('mid.$ig1').message.ts + 1;
    expect(await call('history', { conversation: IG.direct, beforeTs: before, limit: 3 })).toEqual({ count: 3, done: false });
    expect(message('mid.$old0')?.live).toBe(false);
    await expect(call('redact', { conversation: IG.direct, message: sent.nativeId })).rejects.toThrow(/redact is not available/);
    const media = await call('fetchMedia', { url: message('mid.$ig3').message.attachments[0].url });
    expect(media.mime).toBe('image/png');
    // Every request the page made for us is one of the client's own operations, at a person's pace.
    expect(new Set(fake.fake.calls.map((c) => c.name ?? c.path))).toEqual(new Set(['IGDirectTextSendMutation', 'IGDirectReactionSendMutation', 'IGDirectEditMessageMutation', '/ig_send_message', 'useIGDMarkThreadAsReadMutation', 'IGDMessageListOffMsysQuery']));
    const writes = fake.fake.calls.filter((c) => /Mutation$/.test(c.name ?? ''));
    for (let i = 1; i < writes.length; i++) expect(writes[i].at - writes[i - 1].at).toBeGreaterThanOrEqual(1400);
  },
  120_000,
);

it(
  'no send module in the page: online, read-only, and said so',
  async () => {
    const id = (await app.admin({ do: 'create', kind: 'instagram', label: 'Instagram (read-only)', config: { testOrigin: readOnly.url } })).id;
    ids.push(id);
    await until(() => statusOf(id)?.status === 'online' && statusOf(id)?.layers?.some((l: any) => l.name === 'sending' && l.state === 'failed'), 90_000, 'online, read-only');
    const st = statusOf(id);
    expect(st.attention).toBeNull();
    expect(st.layers.find((l: any) => l.name === 'sending').note).toMatch(/^read-only: no way to send was found\. send —; react via IGDMAPISendReaction/);
    expect(st.details['hook.slide.send']).toBe('missing');
    expect(evs(id).filter((e) => e.t === 'hello').at(-1).capabilities).not.toContain('send');
    await expect(call('send', { conversation: IG.direct, body: 'x' }, id)).rejects.toThrow(/send is not available/);
    expect(readOnly.fake.calls.length).toBe(0);
  },
  120_000,
);

it(
  'signed out: asks for the sign-in',
  async () => {
    const id = (await app.admin({ do: 'create', kind: 'instagram', label: 'Instagram (out)', config: { testOrigin: out.url } })).id;
    ids.push(id);
    await until(() => statusOf(id)?.attention?.kind === 'login', 60_000, 'login attention');
    expect(statusOf(id).attention).toMatchObject({ message: 'Sign in to Instagram in the live view', liveView: true });
    expect(statusOf(id).details.page).toBe(`${out.url}/accounts/login/`);
  },
  90_000,
);

it(
  'nothing secret in logs or statuses; every process gone when the manager stops',
  async () => {
    const logs = ids.map((id) => readFileSync(join(dir, 'accounts', id, 'adapter.log'), 'utf8')).join('\n');
    const statuses = JSON.stringify(Object.values(events).flat().filter((e) => e.t === 'status'));
    for (const secret of ['hello from alice', 'are you there', 'hello from dither', 'herons today', 'Alice Archer', 'Heron Club', 'secret=query', 'secret snippet', 'alice.archer']) {
      expect(logs).not.toContain(secret);
      expect(statuses).not.toContain(secret);
    }
    await m!.stop();
    m = null;
    await until(() => processesOf(ids).length === 0, 15_000, 'every process gone');
  },
  60_000,
);
