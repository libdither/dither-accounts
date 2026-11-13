/**
 * A Telegram account through a throwaway manager, over the real wire, its extractor a real process on the fake
 * Telegram (TELEGRAM_FAKE=1): added as the page adds it (POST /api/accounts with api_id and api_hash), its QR code in
 * the status, scanned, online with who it is, the details and the dependency chain on the page; an app reads and
 * writes it through packages/client and gets its events; a two-step password through the page's call; a restart
 * keeps the session. Adding (dither-chat docs/add.md): looking up invite links, @names and numbers without acting,
 * joining and asking to join, adding a contact, flood waits in words, and the join requests waiting in the chats it
 * admins, listed at connect, kept up to date and answered. People links: the contacts and blocks listed at connect, a
 * contact removed, someone unblocked. Nothing reaches Telegram.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import manifest from '../extractors/telegram/manifest.ts';
import { SPACING } from '../extractors/telegram/src/pacer.ts';
import { FAKE_IDS, FAKE_INVITES, fakeControl } from '../extractors/telegram/src/fake.ts';
import type { AddPreview, AddRef, AddResult, PersonRelationship, RelationshipFact, RequestFact } from '../packages/chat-protocol/src/index.ts';
import type { AccountInfo, PageCallResult } from '../packages/manager/src/api-types.ts';

setDefaultTimeout(60_000);
const ROOT = resolve(import.meta.dir, '..');
const HASH = '0123456789abcdef0123456789abcdef';
const S = FAKE_IDS.self;
let m: Manager;
let dir: string;
let app: AccountsClient;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = (await Promise.resolve().then(f).catch(() => null)) as T | null;
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = async <T = any>(path: string, body?: unknown): Promise<T> => (await fetch(m.url + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;
const account = async (id: string) => (await api<{ accounts: AccountInfo[] }>('/api/state')).accounts.find((a) => a.id === id);
const accDir = (id: string) => join(dir, 'mgr', 'accounts', id);
const evs = (id: string) => events.get(id) ?? [];
const lastStatus = (id: string) => evs(id).filter((e) => e.t === 'status').at(-1);
const add = async (label: string) => {
  const r = await api<{ id?: string; error?: string }>('/api/accounts', { kind: 'telegram', label, config: { apiId: '12345' }, secret: { apiHash: HASH } });
  if (!r.id) throw new Error(r.error);
  return r.id;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-tgm-'));
  mkdirSync(join(dir, 'mgr'));
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0 });
  // loadKinds finds it in extractors/telegram; by hand only if it did not load.
  if (!m.kinds.has('telegram')) m.kinds.set('telegram', kindOf(manifest, join(ROOT, 'extractors/telegram')));
  m.kinds.get('telegram')!.env = { TELEGRAM_FAKE: '1', TELEGRAM_FAKE_QR_MS: '1500' };
  const reg = await register(m.url, { name: 'telegram-test-app', requests: [{ interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, e) => (events.get(a) ?? events.set(a, []).get(a)!).push(...e) });
  await until(() => app.connected, 4000, 'the app connected');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the add form: the page offers Telegram with your app's api_id and api_hash (or Telegram Desktop's, chosen), and checks them", async () => {
  const kinds = (await api<{ kinds: { kind: string; add: any }[] }>('/api/state')).kinds;
  const tg = kinds.find((k) => k.kind === 'telegram')!;
  expect(tg.add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['app', false, true],
    ['apiId', false, true],
    ['apiHash', true, true],
    ['testDc', false, true],
  ]);
  expect(tg.add.next).toContain('Link Desktop Device');
  const bad = await api<{ error: string }>('/api/accounts', { kind: 'telegram', label: 'x', config: { apiId: '12345' }, secret: { apiHash: 'nope' } });
  expect(bad.error).toBe('api_hash: the 32 letters and digits my.telegram.org shows as App api_hash');
});

let id: string;

test('added: a QR code to scan; scanned: online as you, with the details and the chain on the page', async () => {
  id = await add('Telegram (fake)');
  const st = await until(() => lastStatus(id)?.attention?.qr && lastStatus(id), 20_000, 'the QR code');
  expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', qr: expect.stringMatching(/^tg:\/\/login\?token=/), qrRefreshAt: expect.any(Number) } });
  // The page has it too (its attention block draws the QR from this).
  expect((await account(id))!.status).toMatchObject({ attention: { qr: st.attention.qr } });
  // The api_hash is a secret: in secret.json, not in the config.
  const secret = JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8'));
  expect(secret).toEqual({ apiHash: HASH });
  expect(JSON.stringify((await api(`/api/accounts/${id}`)).config ?? {})).not.toContain(HASH);
  // "New code" on the page is the action refreshLink, through the same call as an app's.
  const r = await api<PageCallResult>(`/api/accounts/${id}/call`, { op: 'action', input: { action: 'refreshLink' } });
  expect(r).toMatchObject({ ok: true, result: { started: true } });
  await until(() => lastStatus(id)?.attention?.qr && lastStatus(id)!.attention.qr !== st.attention.qr, 10_000, 'a new code');
  await fakeControl(accDir(id), { op: 'scan' });
  const online = await until(async () => {
    const a = await account(id);
    return a?.status?.status === 'online' && a;
  }, 20_000, 'online');
  // The page shows only https avatars; Telegram's come through fetchMedia (tg://avatar/…), which it does not ask yet.
  expect(online.self).toEqual({ name: 'Test User', detail: '@testuser', avatar: null });
  expect(lastStatus(id)!.self.avatarUrl).toBe(`tg://avatar/u${S}/9100?dc=2`);
  expect(online.layers!.map((l) => [l.name, l.state])).toEqual([
    ['api_id and api_hash', 'ok'],
    ['connection', 'ok'],
    ['signed in', 'ok'],
    ['updates', 'ok'],
  ]);
  // The account's pane: the session facts, and secret.json by its keys only.
  const pane = await api(`/api/accounts/${id}`);
  expect(pane.status.details).toMatchObject({ client: 'a fake Telegram (TELEGRAM_FAKE)', signIn: 'signed in', session: 'in secret.json', userId: String(S), chats: 7 });
  expect(pane.secret).toEqual({ present: true, keys: ['apiHash', 'session', 'userId'] });
  expect(pane.config).toEqual({ apiId: '12345' });
  const saved = JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8'));
  expect(Object.keys(saved).sort()).toEqual(['apiHash', 'session', 'userId']);
  expect(evs(id).find((e) => e.t === 'hello')).toMatchObject({ network: 'telegram', protocol: 1 });
});

test('an app reads and writes it: the snapshot, a send and its echo, an incoming message, history, about', async () => {
  await until(() => evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === `channel:${FAKE_IDS.forum}/4`), 10_000, 'the snapshot');
  const dm = `dm:${S}:${FAKE_IDS.alice}`;
  const sent = await app.call(chat, id, 'send', { conversation: dm, body: 'hello from **the app**' });
  expect(sent?.nativeId).toMatch(new RegExp(`^${dm}#\\d+$`));
  await until(() => evs(id).some((e) => e.t === 'message' && e.message.nativeId === sent!.nativeId && e.message.body === 'hello from **the app**'), 5000, 'the echo');
  await fakeControl(accDir(id), { op: 'incoming', peer: `user:${FAKE_IDS.alice}`, from: FAKE_IDS.alice, text: 'got it' });
  const got = await until(() => evs(id).find((e) => e.t === 'message' && e.message.body === 'got it'), 5000, 'the incoming message');
  expect(got).toMatchObject({ live: true, message: { conversation: dm, author: String(FAKE_IDS.alice) } });
  expect(await app.call(chat, id, 'history', { conversation: `channel:${FAKE_IDS.devs}`, limit: 10 })).toEqual({ count: 3, done: true });
  const about = await app.call(chat, id, 'about', { target: { kind: 'conversation', nativeId: `channel:${FAKE_IDS.devs}` } });
  expect(about).toMatchObject({ noun: 'Group', fields: { name: { value: 'dither devs', canEdit: true } } });
  await fakeControl(accDir(id), { op: 'typing', peer: `user:${FAKE_IDS.alice}`, from: FAKE_IDS.alice });
  await until(() => evs(id).some((e) => e.t === 'typing' && e.conversation === dm), 5000, 'typing');
});

test('errors reach the app in words', async () => {
  const e = await app.call(chat, id, 'send', { conversation: `channel:${FAKE_IDS.news}`, body: 'x' }).catch((x) => x);
  expect(String(e.message)).toContain('CHAT_WRITE_FORBIDDEN');
  await fakeControl(accDir(id), { op: 'flood', method: 'messages.getHistory', seconds: 300 });
  const f = await app.call(chat, id, 'history', { conversation: `channel:${FAKE_IDS.devs}`, limit: 5 }).catch((x) => x);
  expect(f.message).toBe('Telegram asks this account to wait 300 s before more messages.getHistory');
});

// ---------------------------------------------------------------- adding

const DEVS = `channel:${FAKE_IDS.devs}`;
const FORUM = `channel:${FAKE_IDS.forum}`;
const invite = (code: string): AddRef => ({ kind: 'invite', network: 'telegram', code, url: `https://t.me/+${code}` });
const name = (n: string): AddRef => ({ kind: 'name', network: 'telegram', name: n });
const phone = (p: string): AddRef => ({ kind: 'person', network: 'telegram', handle: p });
const lookUp = (ref: AddRef) => app.call(chat, id, 'resolve', { ref }) as Promise<AddPreview>;
const addIt = (ref: AddRef, action: 'join' | 'ask' | 'contact') => app.call(chat, id, 'add', { ref, action }) as Promise<AddResult>;
const answer = (request: string, a: 'accept' | 'decline' | 'block') => app.call(chat, id, 'answer', { request, answer: a }) as Promise<AddResult>;
const failure = (p: Promise<unknown>) => p.then(() => 'no error', (e) => String(e.message));
const calls = (o: Record<string, unknown> = {}) => fakeControl(accDir(id), { op: 'calls', ...o }) as Promise<{ method: string; at: number; req?: any }[]>;
const ACTS = ['messages.importChatInvite', 'channels.joinChannel', 'contacts.addContact', 'messages.hideChatJoinRequest', 'contacts.deleteContacts', 'contacts.unblock'];
const byId = (a: RequestFact, b: RequestFact) => a.nativeId.localeCompare(b.nativeId);
const byIdentity = (a: RelationshipFact, b: RelationshipFact) => a.identity.localeCompare(b.identity);
const removeIt = (identity: number, relationship: PersonRelationship) => app.call(chat, id, 'remove', { identity: String(identity), relationship }) as Promise<AddResult>;
const relationship = (n: number, who: number, r: string) => evs(id).slice(n).find((e) => e.t === 'relationship' && e.fact.identity === String(who) && e.fact.relationship === r);

test('hello: it can look up, join, add contacts, answer requests, list contacts and blocks, and remove them', () => {
  const hello = evs(id).filter((e) => e.t === 'hello').at(-1)!;
  expect(hello.capabilities).toEqual(expect.arrayContaining(['resolve', 'join', 'connect', 'requests', 'openDirect', 'relationships', 'disconnect']));
});

test('contacts and blocks at connect: the whole list, each person once, their identities first; a blocked group is not in it', async () => {
  const ev = await until(() => evs(id).find((e) => e.t === 'relationships'), 15_000, 'the relationships list');
  expect([...ev.list].sort(byIdentity)).toEqual([
    { identity: String(FAKE_IDS.alice), relationship: 'contact' },
    { identity: String(FAKE_IDS.bob), relationship: 'contact' },
    { identity: String(FAKE_IDS.grace), relationship: 'blocked', since: expect.any(Number) },
  ]);
  const at = evs(id).indexOf(ev);
  for (const who of [FAKE_IDS.alice, FAKE_IDS.bob, FAKE_IDS.grace]) expect(evs(id).findIndex((e) => e.t === 'identity' && e.identity.nativeId === String(who))).toBeLessThan(at);
  expect((await api(`/api/accounts/${id}`)).status.details).toMatchObject({ contacts: 2, blocked: 1 });
});

test('join requests at connect: the whole list from the chats it admins, each answered with accept or decline', async () => {
  const ev = await until(() => evs(id).find((e) => e.t === 'requests'), 15_000, 'the requests list');
  expect([...ev.requests].sort(byId)).toEqual([
    { nativeId: `join:${DEVS}:${FAKE_IDS.erin}`, kind: 'join', from: String(FAKE_IDS.erin), target: { kind: 'conversation', nativeId: DEVS, name: 'dither devs', members: 4 }, ts: expect.any(Number), answers: ['accept', 'decline'] },
    { nativeId: `join:${FORUM}:${FAKE_IDS.frank}`, kind: 'join', from: String(FAKE_IDS.frank), target: { kind: 'conversation', nativeId: FORUM, name: 'Forum', members: 3 }, ts: expect.any(Number), answers: ['accept', 'decline'] },
  ]);
  // Who asks is known first.
  const at = evs(id).indexOf(ev);
  for (const who of [FAKE_IDS.erin, FAKE_IDS.frank]) expect(evs(id).findIndex((e) => e.t === 'identity' && e.identity.nativeId === String(who))).toBeLessThan(at);
  // Only chats it admins were asked (dither devs, the forum), never the ones it is a member of.
  const asked = (await calls({ method: 'messages.getChatInviteImporters', full: true })).map((c) => c.req.peer.channelId ?? c.req.peer.chatId);
  expect(asked.map(Number).sort()).toEqual([FAKE_IDS.devs, FAKE_IDS.forum]);
});

test('resolve an invite link: what it leads to, already in, asks first, a peek, expired and unknown; nothing done', async () => {
  const t0 = Date.now();
  const film = await lookUp(invite(FAKE_INVITES.film));
  expect(film).toEqual({ what: 'group', name: 'Film Photo Swap', description: 'Swap rolls, share scans', members: 3, avatar: `tg://invite/${FAKE_INVITES.film}/9201?dc=2`, actions: ['join'], notes: ['Alice Liddell is in it'] });
  // Its picture, before joining, through fetchMedia.
  expect(await app.call(chat, id, 'fetchMedia', { url: film.avatar! })).toMatchObject({ mime: 'image/jpeg', base64: expect.any(String) });
  expect(await lookUp(invite(FAKE_INVITES.devs))).toMatchObject({ what: 'group', name: 'dither devs', nativeId: DEVS, joined: { conversation: DEVS }, actions: [], notes: ['You are in it already'] });
  expect(await lookUp(invite(FAKE_INVITES.climb))).toEqual({ what: 'group', name: 'Climbers', description: 'Bouldering on weekends', members: 2, actions: ['ask'], notes: ['Joining asks the admins first', 'Bob is in it'] });
  const peek = await lookUp(invite(FAKE_INVITES.peek));
  expect(peek).toMatchObject({ what: 'group', name: 'Peek Group', nativeId: `channel:${FAKE_IDS.peek}`, joined: { conversation: `channel:${FAKE_IDS.peek}` }, actions: ['join'] });
  expect(peek.notes![0]).toMatch(/^You can look in without joining until \d\d:\d\d UTC; Join to stay in it$/);
  expect(await failure(lookUp(invite(FAKE_INVITES.expired)))).toBe('This invite link has expired or was revoked');
  expect(await failure(lookUp(invite('NoSuchInvite99')))).toBe('Telegram does not know this invite link: it may be mistyped, or it was revoked');
  const made = (await calls({ since: t0 })).map((c) => c.method);
  expect(made).toContain('messages.checkChatInvite');
  expect(made.filter((m) => ACTS.includes(m))).toEqual([]);
  // A peek is not a chat of this account's: no conversation for it.
  expect(evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === `channel:${FAKE_IDS.peek}`)).toBe(false);
});

test('resolve an @name: a person, a channel, a public group that asks first, nobody', async () => {
  const t0 = Date.now();
  expect(await lookUp(name('dave_d'))).toEqual({
    what: 'person',
    name: 'Dave Doe',
    nativeId: String(FAKE_IDS.dave),
    avatar: `tg://avatar/u${FAKE_IDS.dave}/9106?dc=2`,
    relationship: 'stranger',
    actions: ['message', 'contact'],
    notes: ["Adding a contact on Telegram doesn't share your number"],
  });
  expect(await lookUp(name('alice'))).toMatchObject({ what: 'person', name: 'Alice Liddell', relationship: 'contact', actions: ['message'] });
  expect(await lookUp(name('opennotes'))).toEqual({
    what: 'channel',
    name: 'Open Notes',
    nativeId: `channel:${FAKE_IDS.open}`,
    avatar: `tg://avatar/ch${FAKE_IDS.open}/9202?dc=2`,
    description: 'Notes in the open',
    members: 1,
    actions: ['join'],
    notes: ['A channel: only its admins post'],
  });
  // Its identity (a channel posts as itself) came before the answer.
  expect(evs(id).some((e) => e.t === 'identity' && e.identity.nativeId === `channel:${FAKE_IDS.open}`)).toBe(true);
  expect(await lookUp(name('askfirst'))).toMatchObject({ what: 'group', name: 'Ask First', actions: ['ask'], notes: ['Joining asks the admins first'] });
  expect(await lookUp(name('ditherdevs'))).toMatchObject({ what: 'group', joined: { conversation: DEVS }, actions: [], notes: ['You are in it already'] });
  expect(await failure(lookUp(name('nobody_here')))).toBe('Nobody on Telegram is called @nobody_here');
  expect((await calls({ since: t0 })).filter((c) => ACTS.includes(c.method))).toEqual([]);
});

test('resolve a +phone: found (read-only), and not', async () => {
  // By count, not by the clock: the test before ends on a lookup that can share this millisecond.
  const before = (await calls()).length;
  expect(await lookUp(phone('+9996620006'))).toMatchObject({ what: 'person', name: 'Dave Doe', nativeId: String(FAKE_IDS.dave), actions: ['message', 'contact'] });
  expect(await failure(lookUp(phone('+9996629999')))).toBe('No Telegram account has this number, or its owner hides it');
  expect((await calls()).slice(before).map((c) => c.method)).toEqual(['contacts.resolvePhone', 'contacts.resolvePhone']);
});

test('join by invite: the conversation and its last message first, then the answer naming it', async () => {
  const conv = `channel:${FAKE_IDS.film}`;
  const r = await addIt(invite(FAKE_INVITES.film), 'join');
  expect(r).toEqual({ conversation: conv });
  await until(() => evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === conv), 5000, 'its conversation');
  expect(evs(id).find((e) => e.t === 'conversation' && e.conversation.nativeId === conv)!.conversation).toMatchObject({ shape: 'group', variant: 'text', name: 'Film Photo Swap', avatarUrl: `tg://avatar/ch${FAKE_IDS.film}/9201?dc=2` });
  await until(() => evs(id).some((e) => e.t === 'message' && e.message.nativeId === `${conv}#1` && e.live === false), 5000, 'its last message');
  // Looked up again: in it now.
  expect(await lookUp(invite(FAKE_INVITES.film))).toMatchObject({ joined: { conversation: conv }, actions: [] });
  // Joining again is no error: it is the same conversation.
  expect(await addIt(invite(FAKE_INVITES.film), 'join')).toEqual({ conversation: conv, notes: ['You are in it already'] });
});

test('ask by invite (the admins approve): pending; a bot that checks members first: a check, nothing done', async () => {
  expect(await addIt(invite(FAKE_INVITES.climb), 'ask')).toEqual({ pending: true, notes: ['Asked; the admins decide'] });
  const check = await addIt(invite(FAKE_INVITES.checked), 'join');
  expect(check).toEqual({ check: 'captcha', notes: ['Helper checks new members here first, in its mini app: join from a Telegram app to pass it. Nothing was done here'] });
  expect(evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === `channel:${FAKE_IDS.checked}`)).toBe(false);
  expect(await failure(addIt(invite(FAKE_INVITES.expired), 'join'))).toBe('This invite link has expired or was revoked');
});

test('join a public channel by @name, ask to join a public group', async () => {
  const conv = `channel:${FAKE_IDS.open}`;
  expect(await addIt(name('opennotes'), 'join')).toEqual({ conversation: conv, notes: ['Joined; only its admins post here'] });
  await until(() => evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === conv && e.conversation.variant === 'announcement'), 5000, 'its conversation');
  expect(await addIt(name('askfirst'), 'ask')).toEqual({ pending: true, notes: ['Asked; the admins decide'] });
  expect(await failure(addIt(name('dave_d'), 'join'))).toBe('@dave_d is a person, not a group or channel: Message or Add contact instead');
});

test('add a contact by @name and by number: your number is not shared; the identity is a contact first', async () => {
  const t0 = Date.now();
  expect(await addIt(name('dave_d'), 'contact')).toEqual({ identity: String(FAKE_IDS.dave), relationship: 'contact', notes: ["Added to your Telegram contacts; they don't see your number"] });
  await until(() => evs(id).some((e) => e.t === 'identity' && e.identity.nativeId === String(FAKE_IDS.dave) && e.identity.contact === true), 5000, 'Dave as a contact');
  expect(await addIt(phone('+9996620008'), 'contact')).toMatchObject({ identity: String(FAKE_IDS.frank), relationship: 'contact' });
  const added = await calls({ method: 'contacts.addContact', since: t0, full: true });
  expect(added.map((c) => [c.req.addPhonePrivacyException, c.req.firstName, c.req.phone])).toEqual([
    [false, 'Dave', ''],
    [false, 'Frank', '9996620008'],
  ]);
  // A contact already: said so, nothing sent.
  expect(await addIt(name('dave_d'), 'contact')).toEqual({ identity: String(FAKE_IDS.dave), relationship: 'contact', notes: ['Already in your Telegram contacts'] });
  expect(await lookUp(name('dave_d'))).toMatchObject({ relationship: 'contact', actions: ['message'] });
  expect((await calls({ method: 'contacts.addContact', since: t0 })).length).toBe(2);
  expect(await failure(addIt(name('opennotes'), 'contact'))).toBe('@opennotes is a group or channel, not a person: Join it instead');
});

test('remove: a contact removed, someone unblocked, each a relationship event; what changed since, and what Telegram has not, refused', async () => {
  // The contacts just added went out as relationships too.
  expect(relationship(0, FAKE_IDS.dave, 'contact')).toBeTruthy();
  expect(relationship(0, FAKE_IDS.frank, 'contact')).toBeTruthy();
  const t0 = Date.now();
  const n = evs(id).length;
  expect(await removeIt(FAKE_IDS.dave, 'contact')).toEqual({ identity: String(FAKE_IDS.dave), relationship: 'stranger', notes: ['Removed from your Telegram contacts'] });
  await until(() => relationship(n, FAKE_IDS.dave, 'stranger'), 5000, 'Dave gone');
  expect(await removeIt(FAKE_IDS.grace, 'blocked')).toEqual({ identity: String(FAKE_IDS.grace), relationship: 'stranger', notes: ['Unblocked'] });
  await until(() => relationship(n, FAKE_IDS.grace, 'stranger'), 5000, 'Grace unblocked');
  // Looked at again: Dave is no contact now.
  expect(await lookUp(name('dave_d'))).toMatchObject({ relationship: 'stranger', actions: ['message', 'contact'] });
  expect(await failure(removeIt(FAKE_IDS.dave, 'contact'))).toBe('That changed; look again');
  expect(await failure(removeIt(FAKE_IDS.bob, 'friend'))).toBe('Telegram has no friends or follows; only contacts and blocks');
  // Each act sent once.
  expect((await calls({ since: t0 })).filter((c) => ACTS.includes(c.method)).map((c) => c.method)).toEqual(['contacts.deleteContacts', 'contacts.unblock']);
});

test('joins, contact adds and removes, and unblocks take the slow lane: a few seconds apart', async () => {
  expect(SPACING.join).toBeGreaterThanOrEqual(2000);
  const acts = (await calls()).filter((c) => ['messages.importChatInvite', 'channels.joinChannel', 'contacts.addContact', 'contacts.deleteContacts', 'contacts.unblock'].includes(c.method));
  expect(acts.length).toBeGreaterThanOrEqual(8);
  expect(acts.map((c) => c.method)).toEqual(expect.arrayContaining(['contacts.deleteContacts', 'contacts.unblock']));
  for (let i = 1; i < acts.length; i++) expect(acts[i].at - acts[i - 1].at).toBeGreaterThanOrEqual(SPACING.join - 50);
});

test('join requests as they come: request when someone asks, requestGone when withdrawn', async () => {
  const n = evs(id).length;
  const daveAsks = `join:${DEVS}:${FAKE_IDS.dave}`;
  await fakeControl(accDir(id), { op: 'joinRequest', chat: FAKE_IDS.devs, user: FAKE_IDS.dave });
  const ev = await until(() => evs(id).slice(n).find((e) => e.t === 'request'), 10_000, 'the request');
  expect(ev.request).toEqual({ nativeId: daveAsks, kind: 'join', from: String(FAKE_IDS.dave), target: { kind: 'conversation', nativeId: DEVS, name: 'dither devs', members: 4 }, ts: expect.any(Number), answers: ['accept', 'decline'] });
  await fakeControl(accDir(id), { op: 'joinRequest', chat: FAKE_IDS.devs, user: FAKE_IDS.dave, withdraw: true });
  await until(() => evs(id).slice(n).some((e) => e.t === 'requestGone' && e.nativeId === daveAsks), 10_000, 'the request gone');
  // Erin's is untouched by it.
  expect(evs(id).slice(n).some((e) => e.t === 'requestGone' && e.nativeId !== daveAsks)).toBe(false);
});

test('answering: accept lets them in, decline does not; each request goes; an answered one is not waiting any more', async () => {
  const n = evs(id).length;
  const erin = `join:${DEVS}:${FAKE_IDS.erin}`;
  const frank = `join:${FORUM}:${FAKE_IDS.frank}`;
  expect(await answer(erin, 'accept')).toEqual({ identity: String(FAKE_IDS.erin), notes: ['Erin can come in to dither devs now'] });
  await until(() => evs(id).slice(n).some((e) => e.t === 'requestGone' && e.nativeId === erin), 5000, "Erin's request gone");
  const about = await app.call(chat, id, 'about', { target: { kind: 'conversation', nativeId: DEVS } });
  expect(about.members!.list.some((m) => m.id === String(FAKE_IDS.erin))).toBe(true);
  expect(await answer(frank, 'decline')).toEqual({ identity: String(FAKE_IDS.frank), notes: ['Declined; Frank stays out of Forum'] });
  await until(() => evs(id).slice(n).some((e) => e.t === 'requestGone' && e.nativeId === frank), 5000, "Frank's request gone");
  const hidden = await calls({ method: 'messages.hideChatJoinRequest', full: true });
  expect(hidden.map((c) => !!c.req.approved)).toEqual([true, false]);
  expect(await failure(answer(erin, 'accept'))).toBe('That request is not waiting any more: it was answered elsewhere, or withdrawn');
  expect(await failure(answer(frank, 'block'))).toBe('A Telegram join request is answered with accept or decline, not block');
  expect(await failure(answer('friend:someone', 'accept'))).toBe('That is not a Telegram join request');
});

test('FLOOD_WAIT: an act fails at once with when it frees up, and is not sent again; a lookup says when too', async () => {
  await fakeControl(accDir(id), { op: 'flood', method: 'messages.importChatInvite', seconds: 300 });
  const t0 = Date.now();
  const e = await failure(addIt(invite(FAKE_INVITES.peek), 'join'));
  expect(e).toMatch(/^Telegram asks this account to wait before joining more groups and channels: try again in 5 minutes \(after \d\d:\d\d UTC\)$/);
  // Held now: the next one fails without asking Telegram.
  expect(await failure(addIt(invite(FAKE_INVITES.peek), 'join'))).toMatch(/^Telegram asks this account to wait before joining more groups and channels: try again in 5 minutes/);
  expect((await calls({ method: 'messages.importChatInvite', since: t0 })).length).toBe(1);
  await fakeControl(accDir(id), { op: 'flood', method: 'contacts.resolveUsername', seconds: 120 });
  expect(await failure(lookUp(name('erin_e')))).toMatch(/^Telegram asks this account to wait before looking up more names and links: try again in 2 minutes \(after \d\d:\d\d UTC\)$/);
  // A remove too: at once, sent once.
  await fakeControl(accDir(id), { op: 'flood', method: 'contacts.deleteContacts', seconds: 300 });
  const t1 = Date.now();
  expect(await failure(removeIt(FAKE_IDS.frank, 'contact'))).toMatch(/^Telegram asks this account to wait before removing more contacts: try again in 5 minutes \(after \d\d:\d\d UTC\)$/);
  expect(await failure(removeIt(FAKE_IDS.frank, 'contact'))).toMatch(/^Telegram asks this account to wait before removing more contacts/);
  expect((await calls({ method: 'contacts.deleteContacts', since: t1 })).length).toBe(1);
});

test('a restart keeps the session: online again with no code to scan', async () => {
  const session = JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8')).session;
  const before = evs(id).length;
  await api(`/api/accounts/${id}/restart`, {});
  await until(async () => (await account(id))?.online && evs(id).slice(before).some((e) => e.t === 'status' && e.status === 'online'), 20_000, 'online after the restart');
  expect(evs(id).slice(before).some((e) => e.t === 'status' && e.attention?.qr)).toBe(false);
  expect(JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8')).session).toBe(session);
  expect(existsSync(join(accDir(id), 'state.json'))).toBe(true);
  // The join requests listed again once known: none wait now (answered and withdrawn above).
  const list = await until(() => evs(id).slice(before).find((e) => e.t === 'requests'), 15_000, 'the requests list again');
  expect(list.requests).toEqual([]);
  // And the contacts and blocks as they are now: Dave removed, Grace unblocked, Frank kept (the flood wait).
  const rels = await until(() => evs(id).slice(before).find((e) => e.t === 'relationships'), 15_000, 'the relationships list again');
  expect([...rels.list].sort(byIdentity)).toEqual([String(FAKE_IDS.alice), String(FAKE_IDS.bob), String(FAKE_IDS.frank)].map((who) => ({ identity: who, relationship: 'contact' })));
});

test('a two-step password through the page, and the account removed with its directory', async () => {
  const other = await add('Telegram with a password');
  await until(() => lastStatus(other)?.attention?.qr, 20_000, 'the QR code');
  await fakeControl(accDir(other), { op: 'setPassword', password: 'correct horse', hint: 'xkcd' });
  await fakeControl(accDir(other), { op: 'scan' });
  await until(() => lastStatus(other)?.attention?.kind === 'login', 10_000, 'the password asked for');
  // The page's attention block shows a password form for kind 'login' without a live view: the action relogin.
  const wrong = await api<PageCallResult>(`/api/accounts/${other}/call`, { op: 'action', input: { action: 'relogin', args: { password: 'nope' } } });
  expect(wrong).toMatchObject({ ok: false, error: { message: 'That password is not right. Try again.' } });
  const right = await api<PageCallResult>(`/api/accounts/${other}/call`, { op: 'action', input: { action: 'relogin', args: { password: 'correct horse' } } });
  expect(right).toMatchObject({ ok: true, result: { signedIn: true } });
  await until(async () => (await account(other))?.status?.status === 'online', 20_000, 'online');
  for (const f of ['secret.json', 'secret.json.bak', 'state.json', 'adapter.log']) if (existsSync(join(accDir(other), f))) expect(readFileSync(join(accDir(other), f), 'utf8')).not.toContain('correct horse');
  const r = await fetch(`${m.url}/api/accounts/${other}?purge=1`, { method: 'DELETE' });
  expect(r.ok).toBe(true);
  await until(() => !existsSync(accDir(other)), 10_000, 'the directory gone');
});
