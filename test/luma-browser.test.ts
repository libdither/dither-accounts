/**
 * extractors/luma end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc) with
 * its extension, against the fake Luma (fake-luma.ts). Skipped when Xvfb, chromium or x11vnc cannot be found. Every
 * process it starts is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { resolveBins } from '../packages/browser/src/index.ts';
import { ANN, BEN, CAL, CHAT_DM, CHAT_EVENT, DEE, ME, SECRET } from '../extractors/luma/test/fixtures.ts';
import { type FakeLuma, startFakeLuma } from './fake-luma.ts';

const ROOT = join(import.meta.dir, '..');
let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`luma-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeLuma;
let signedOut: FakeLuma;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let writer: AccountsClient;
let acc = '';
let out = '';
const made: string[] = [];
const events: Record<string, any[]> = {};
/** The loops' first reads soon after online, then every few seconds; a 429 holds reads 60 ms, not a minute. */
const SOON = { feedFirstMs: 1000, feedEveryMs: 3000, chatEveryMs: 1500, eventsEveryMs: 3000, backoffScale: 0.001 };

const until = async <T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const evs = (a: string) => events[a] ?? [];
const statusOf = (a: string) => evs(a).filter((e) => e.t === 'status').at(-1);
const call = (op: string, input: any, account = acc, c = app) => c.call(chat, account, op as any, input) as Promise<any>;
const msg = (a: string, id: string) => evs(a).find((e) => e.t === 'message' && e.message.nativeId === id);
const conv = (a: string, id: string) => evs(a).find((e) => e.t === 'conversation' && e.conversation.nativeId === id);
const callsOf = (f: FakeLuma, path: string) => f.calls.filter((c) => c.path === path);

function processesOf(ids: string[]): number[] {
  const needles = ids.map((id) => `DITHER_ACCOUNT_ID=${id}`);
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
async function account(label: string, config: Record<string, unknown>): Promise<string> {
  const id = ((await app.admin({ do: 'create', kind: 'luma', label, config } as any)) as { id: string }).id;
  made.push(id);
  return id;
}
async function client(name: string, level: 'write' | 'manage'): Promise<AccountsClient> {
  const reg = await register(m!.url, { name, requests: [...(level === 'manage' ? [{ interface: 'accounts', level: 'manage' as const, kinds: ['luma'] }] : []), { interface: 'chat', level, accounts: '*' }] });
  for (const r of reg.requests) expect((await fetch(`${m!.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  const c = new AccountsClient({ url: m!.url, app: reg.app, token: reg.token, onEvents: level === 'manage' ? (a, list) => (events[a] ??= []).push(...list) : undefined });
  await until(() => c.connected, 5000, `${name} connected`);
  return c;
}

beforeAll(async () => {
  if (!bins) return;
  fake = startFakeLuma();
  signedOut = startFakeLuma({ signedIn: false });
  dir = mkdtempSync(join(tmpdir(), 'dacc-luma-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.set('luma', kindOf((await import(join(ROOT, 'extractors/luma/manifest.ts'))).default, join(ROOT, 'extractors/luma')));
  app = await client('luma-app', 'manage');
  writer = await client('luma-writer', 'write');
}, 60_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  writer?.close();
  await m?.stop();
  const left = processesOf(made);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  signedOut?.stop();
  rmSync(dir, { recursive: true, force: true });
  expect(left).toEqual([]);
}, 30_000);

it(
  'signed out: it asks for a sign-in, and Explore already pages through the city with no session',
  async () => {
    out = await account('Luma (signed out)', { testOrigin: signedOut.url, city: 'Exampletown', ...SOON });
    await until(() => statusOf(out)?.status === 'attention', 60_000, 'the sign-in attention');
    expect(statusOf(out).attention).toMatchObject({ kind: 'login', liveView: true });
    const p1 = await call('home', { feed: 'explore' }, out);
    expect(p1.items.map((i: any) => i.post.id)).toEqual(['evt-Open000000000001', 'evt-Hidden0000000001']);
    expect(p1.items[0].reason).toEqual({ text: 'Featured in Exampletown', kind: 'topic' });
    expect(p1.more).toBe('page-2');
    const p2 = await call('home', { feed: 'explore', cursor: p1.more }, out);
    expect(p2.items.map((i: any) => i.post.id)).toEqual(['evt-Paid00000000001', 'evt-Online000000001']);
    expect(p2.more).toBeNull();
    // Hosts and shown guests came first as people; the hidden list's guests never.
    const ids = () => evs(out).filter((e) => e.t === 'identity').map((e) => e.identity.nativeId as string);
    await until(() => [ANN, BEN, CAL, DEE].every((u) => ids().includes(u.api_id)), 10_000, 'the hosts and shown guests');
    expect(ids()).not.toContain(SECRET.api_id);
    // The city by its page, then its listing, as the web app asks: its client type, its paging.
    expect(callsOf(signedOut, '/url')[0]).toMatchObject({ method: 'GET', query: { url: 'exampletown' }, clientType: 'luma-web', session: false });
    expect(callsOf(signedOut, '/discover/get-paginated-events').map((c) => c.query)).toEqual([
      { discover_place_api_id: 'discplace-Exampletown0001', pagination_limit: '25' },
      { discover_place_api_id: 'discplace-Exampletown0001', pagination_cursor: 'page-2', pagination_limit: '25' },
    ]);
    await expect(call('home', { feed: 'following' }, out)).rejects.toThrow('not signed in');
    await expect(call('home', { feed: 'foryou' }, out)).rejects.toThrow('no For you');
    signedOut.signIn();
    await until(() => statusOf(out)?.status === 'online', 30_000, 'online after signing in');
    expect(statusOf(out).self).toMatchObject({ nativeId: ME.api_id, isSelf: true });
  },
  120_000,
);

it(
  "signed in with no city: online, the hello, and Explore is Luma's own pick",
  async () => {
    acc = await account('Luma (test)', { testOrigin: fake.url, ...SOON });
    await until(() => statusOf(acc)?.status === 'online', 60_000, 'online');
    const st = statusOf(acc);
    expect(st.layers.find((l: any) => l.name === 'signed in').note).toBe('as @quinnpark');
    expect(evs(acc).find((e) => e.t === 'hello')).toMatchObject({ network: 'luma', capabilities: ['liveView', 'media', 'profile', 'posts', 'home', 'history', 'send', 'react', 'markRead'] });
    const pg = await call('home', { feed: 'explore' });
    expect(pg.items.map((i: any) => i.post.id)).toEqual(['evt-Online000000001']);
    expect(callsOf(fake, '/discover/bootstrap-page')).toHaveLength(1);
  },
  90_000,
);

it(
  'Your events: upcoming, then past; each one you are in has its conversation',
  async () => {
    const up = await call('home', { feed: 'following' });
    expect(up.items.map((i: any) => [i.post.id, i.post.event.rsvp])).toEqual([
      ['evt-Mine00000000001', 'going'],
      ['evt-MineHidden00001', 'going'],
    ]);
    expect(up.more).toBe('p:');
    const past = await call('home', { feed: 'following', cursor: up.more });
    expect(past.items.map((i: any) => i.post.id)).toEqual(['evt-Past00000000001']);
    expect(past.more).toBeNull();
    expect(conv(acc, 'event:evt-Mine00000000001')).toMatchObject({ conversation: { shape: 'group', name: 'Garden Picnic' } });
  },
  60_000,
);

it(
  "an event's page: the guest list a going guest is shown, its .ics; a hidden list is never asked for",
  async () => {
    const t = await call('post', { post: 'evt-Mine00000000001' });
    expect(t.focal.event).toMatchObject({ guests: [BEN.api_id, CAL.api_id, DEE.api_id], guestsShown: 'all', rsvp: 'going', ics: 'https://api.luma.com/ics/get?entity=event&id=evt-Mine00000000001', conversation: 'event:evt-Mine00000000001' });
    expect(t.focal.text).toBe('Come along.\nBring a friend.');
    expect(t.replies).toEqual([]);
    expect(callsOf(fake, '/event/get-guest-list')[0]).toMatchObject({ query: { event_api_id: 'evt-Mine00000000001', ticket_key: 'tk-example', pagination_limit: '100' }, session: true });
    const hidden = await call('post', { post: 'evt-MineHidden00001' });
    expect(hidden.focal.event.guestsShown).toBe('hidden');
    expect(hidden.focal.event.guests).toBeUndefined();
    const open = await call('post', { post: 'evt-Open000000000001' });
    expect(open.focal.event).toMatchObject({ guests: [BEN.api_id, CAL.api_id], guestsShown: 'all' });
    // Asked once only, for the one you are going to whose host shows the list.
    expect(callsOf(fake, '/event/get-guest-list').map((c) => c.query.event_api_id)).toEqual(['evt-Mine00000000001']);
  },
  60_000,
);

it(
  'a profile: their socials as links, the events they host',
  async () => {
    const p = await call('profile', { who: ANN.api_id });
    expect(p).toMatchObject({ displayName: 'Ann Lee', handle: 'annlee', bio: 'Runs ACME Supper Club' });
    expect(p.links.map((l: any) => l.label)).toEqual(['Luma', 'X', 'Instagram', 'LinkedIn', 'Website']);
    expect(p.posts.map((x: any) => x.id)).toEqual(['evt-Open000000000001']);
    await expect(call('profile', { who: 'ann' })).rejects.toThrow('not a Luma user id');
  },
  60_000,
);

it(
  "conversations: notifications as a read-only feed, an event's blasts, the chats with their reactions",
  async () => {
    await until(() => msg(acc, `other:notif-Example00001:${ANN.api_id}`) && msg(acc, 'blast:blast-Example0001') && msg(acc, 'chatmsg-BenHello0001'), 30_000, 'the feed, blasts and chats');
    expect(conv(acc, 'feed')).toMatchObject({ conversation: { variant: 'feed' } });
    expect(msg(acc, `other:notif-Example00001:${ANN.api_id}`).message).toMatchObject({ conversation: 'feed', author: ANN.api_id, kind: 'system', body: 'Ann Lee invited you to Garden Picnic\nSee you there!' });
    expect(msg(acc, 'blast:blast-Example0001').message).toMatchObject({ conversation: 'event:evt-Mine00000000001', author: ANN.api_id, extra: { blast: true, event: 'evt-Mine00000000001' } });
    expect(conv(acc, CHAT_DM)).toMatchObject({ conversation: { shape: 'direct', name: 'Ben Ortiz' } });
    expect(msg(acc, 'chatmsg-BenHello0001').message).toMatchObject({ conversation: CHAT_DM, author: BEN.api_id, reactions: [{ key: '👍', authors: [ME.api_id] }] });
    expect(msg(acc, 'chatmsg-AnnPicnic001').message).toMatchObject({ conversation: CHAT_EVENT, extra: { event: 'evt-Mine00000000001' } });
    expect(evs(acc).find((e) => e.t === 'delete' && e.nativeId === 'chatmsg-Gone00000001')).toBeTruthy();
    // The first read is history: nothing notifies. A message sent since comes live, by the next sync.
    expect(msg(acc, 'chatmsg-BenHello0001').live).toBe(false);
    const id = fake.incoming('See you there');
    await until(() => msg(acc, id), 20_000, 'the new chat message');
    expect(msg(acc, id)).toMatchObject({ live: true, message: { body: 'See you there' } });
    expect(callsOf(fake, '/chat/messages/sync')[0]!.query).toEqual({ pagination_limit: '250' });
    // Nothing marked seen, ever.
    expect(fake.calls.filter((c) => /mark-as-read/.test(c.path) && c.path.startsWith('/notifications'))).toEqual([]);
  },
  60_000,
);

it(
  "chat history pages back as the chat's own scroll does; an event's history is its blasts",
  async () => {
    const h1 = await call('history', { conversation: CHAT_DM, limit: 50 });
    expect(h1).toMatchObject({ count: 1, done: false, next: 'older-1' });
    const h2 = await call('history', { conversation: CHAT_DM, limit: 50, cursor: h1.next });
    expect(h2).toMatchObject({ count: 1, done: true });
    expect((await until(() => msg(acc, 'chatmsg-BenOlder0001'), 10_000, 'the older message')).message.body).toBe('Hi again');
    expect(await call('history', { conversation: 'event:evt-Mine00000000001', limit: 50 })).toMatchObject({ count: 1, done: true });
    expect(await call('history', { conversation: 'feed', limit: 50 })).toEqual({ count: 0, done: true });
  },
  60_000,
);

it(
  'writes in a chat: send, react, mark read, as the chat page sends them; an event and the feed refuse',
  async () => {
    const from = fake.calls.length;
    const sent = await call('send', { conversation: CHAT_DM, body: 'Yes, see you', replyTo: 'chatmsg-BenHello0001' });
    expect(sent.nativeId).toMatch(/^chatmsg-[A-Za-z0-9]{12}$/);
    await call('react', { conversation: CHAT_DM, message: 'chatmsg-BenHello0001', key: '🎉' });
    await call('react', { conversation: CHAT_DM, message: 'chatmsg-BenHello0001', key: '🎉', remove: true });
    await call('markRead', { conversation: CHAT_DM, upTo: 'chatmsg-BenHello0001' });
    await call('markRead', { conversation: 'feed', upTo: 'x' });
    const writes = fake.calls.slice(from).filter((c) => c.method === 'POST');
    expect(writes.map((c) => [c.path, c.body])).toEqual([
      ['/chat/conversation/send', { chat_conversation_api_id: CHAT_DM, replying_to_message_api_id: 'chatmsg-BenHello0001', message_api_id: sent.nativeId, message: 'Yes, see you' }],
      ['/chat/conversation/add-reaction', { chat_message_api_id: 'chatmsg-BenHello0001', reaction_type: '🎉' }],
      ['/chat/conversation/remove-reaction', { chat_message_api_id: 'chatmsg-BenHello0001' }],
      ['/chat/conversation/mark-as-read', { chat_conversation_api_id: CHAT_DM }],
    ]);
    expect(writes.every((c) => c.session)).toBe(true);
    await expect(call('send', { conversation: 'event:evt-Mine00000000001', body: 'hi' })).rejects.toThrow('Luma has no comments');
    await expect(call('send', { conversation: 'feed', body: 'hi' })).rejects.toThrow('read-only');
    await expect(call('react', { conversation: 'event:evt-Mine00000000001', message: 'blast:blast-Example0001', key: '👍' })).rejects.toThrow('Luma has no comments');
  },
  60_000,
);

it(
  'RSVP: refused below manage; at manage, the one-click Register; Maybe refused; Not going with a note',
  async () => {
    const e = (await call('action', { action: 'rsvp', args: { eventId: 'evt-Open000000000001', status: 'going' } }, acc, writer).catch((x: any) => x)) as any;
    expect(e.code).toBe('denied');
    expect(callsOf(fake, '/event/register')).toEqual([]);
    const after = await call('action', { action: 'rsvp', args: { eventId: 'evt-Open000000000001', status: 'going' } });
    expect(after.event).toMatchObject({ rsvp: 'going', conversation: 'event:evt-Open000000000001' });
    const reg = callsOf(fake, '/event/register');
    expect(reg).toHaveLength(1);
    expect(reg[0]!.body).toMatchObject({ event_api_id: 'evt-Open000000000001', ticket_type_to_selection: { 'ttype-Open000000000001': { count: 1, amount: 0 } }, expected_amount_cents: 0, for_waitlist: false, registration_answers: [], name: 'Quinn Park', email: 'quinn@example.com' });
    await expect(call('action', { action: 'rsvp', args: { eventId: 'evt-Open000000000001', status: 'maybe' } })).rejects.toThrow('no Maybe or Interested');
    await expect(call('action', { action: 'rsvp', args: { eventId: 'evt-Paid00000000001', status: 'going' } })).rejects.toThrow('registration form');
    const no = await call('action', { action: 'rsvp', args: { eventId: 'evt-Open000000000001', status: 'declined', note: 'Sorry, away' } });
    expect(no.event.rsvp).toBe('declined');
    expect(callsOf(fake, '/event/decline-my-registration')[0]!.body).toEqual({ event_api_id: 'evt-Open000000000001', decline_message: 'Sorry, away' });
    expect(callsOf(fake, '/event/register')).toHaveLength(1);
  },
  60_000,
);

it(
  'a 429 holds reads back (nothing sent meanwhile), then they go again',
  async () => {
    fake.rateLimit(1);
    await expect(call('home', { feed: 'following' })).rejects.toThrow('429');
    await until(async () => (await call('home', { feed: 'following' }).catch(() => null))?.items?.length === 2, 10_000, 'reads going again');
  },
  60_000,
);

it(
  'its state file keeps no words or names',
  async () => {
    const f = join(dir, 'accounts', acc, 'luma-state.json');
    await until(() => existsSync(f), 10_000, 'the state file');
    const s = readFileSync(f, 'utf8');
    expect(s).not.toContain('Ann Lee');
    expect(s).not.toContain('blanket');
    expect(s).not.toContain('Saturday');
  },
  30_000,
);
