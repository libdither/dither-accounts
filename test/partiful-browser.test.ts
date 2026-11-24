/**
 * extractors/partiful end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc)
 * with its extension, against the fake partiful.com (fake-partiful.ts). Skipped when Xvfb, chromium or x11vnc cannot
 * be found. Every process it starts is gone at the end.
 *
 * The account starts signed out (Explore works, the status asks for a sign-in), then signs in as someone would in the
 * live view.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { resolveBins } from '../packages/browser/src/index.ts';
import { ANN, BEN, CAL, ME, ME_STREAM } from '../extractors/partiful/test/fixtures.ts';
import { type FakePartiful, startFakePartiful } from './fake-partiful.ts';

const ROOT = join(import.meta.dir, '..');
let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`partiful-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakePartiful;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let writer: AccountsClient;
let acc = '';
const made: string[] = [];
const events: Record<string, any[]> = {};
/** The periodic read soon after signing in, then every few seconds (on a real account: 30-60 s, then 4-8 minutes). */
const SOON = { feedFirstMs: 1000, feedEveryMs: 3000 };

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
const call = (op: string, input: any, as = app) => as.call(chat, acc, op as any, input) as Promise<any>;
const msg = (id: string) => evs(acc).find((e) => e.t === 'message' && e.message.nativeId === id);
const fnCalls = (name: string, from = 0) => fake.fns.slice(from).filter((c) => c.fn === name);

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
async function approved(name: string, requests: any[]) {
  const reg = await register(m!.url, { name, requests });
  for (const r of reg.requests) expect((await fetch(`${m!.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  return reg;
}

beforeAll(async () => {
  if (!bins) return;
  fake = startFakePartiful({ signedIn: false });
  dir = mkdtempSync(join(tmpdir(), 'dacc-partiful-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.set('partiful', kindOf((await import(join(ROOT, 'extractors/partiful/manifest.ts'))).default, join(ROOT, 'extractors/partiful')));
  const reg = await approved('partiful-app', [
    { interface: 'accounts', level: 'manage', kinds: ['partiful'] },
    { interface: 'chat', level: 'manage', accounts: '*' },
  ]);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => (events[a] ??= []).push(...list) });
  // An app that may write as you, but not manage: no RSVP.
  const w = await approved('partiful-writer', [{ interface: 'chat', level: 'write', accounts: '*' }]);
  writer = new AccountsClient({ url: m.url, app: w.app, token: w.token });
  await until(() => app.connected && writer.connected, 5000, 'the apps connected');
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
  rmSync(dir, { recursive: true, force: true });
  expect(left).toEqual([]);
}, 30_000);

it(
  'signed out: it asks to sign in in the live view, and Explore works meanwhile, from the page’s own data, a page at a time',
  async () => {
    acc = ((await app.admin({ do: 'create', kind: 'partiful', label: 'Partiful (test)', config: { testOrigin: fake.url, city: 'testville', ...SOON } } as any)) as { id: string }).id;
    made.push(acc);
    await until(() => statusOf(acc)?.status === 'attention', 60_000, 'the sign-in attention');
    expect(statusOf(acc).attention).toMatchObject({ kind: 'login', message: 'Sign in to Partiful in the live view (Explore works meanwhile)', liveView: true });
    expect(evs(acc).find((e) => e.t === 'hello')).toMatchObject({ network: 'partiful', capabilities: ['liveView', 'media', 'profile', 'posts', 'home', 'history', 'send', 'react', 'markRead'] });

    const one = await call('home', { feed: 'explore' });
    expect(one.items.length).toBe(20);
    expect(one.items[0]).toMatchObject({ post: { id: fake.world.open.id, title: 'Rooftop Potluck', author: ANN.id, event: { hosts: [ANN.id], guestsShown: 'count', going: 3 } }, reason: { text: 'Trending in Testville', kind: 'topic' } });
    expect(one.more).toBe('o20');
    const two = await call('home', { feed: 'explore', cursor: one.more });
    expect([two.items.length, two.more]).toEqual([6, null]);
    // The listing as the app fetches it between pages, for the account's city; no sign-in went anywhere.
    expect(fake.pages).toEqual(['/_next/data/fake-build-1/explore/testville.json?region=testville']);
    expect(fake.fns.filter((c) => c.token)).toEqual([]);
    // The hosts the page names went out as people too.
    await until(() => evs(acc).some((e) => e.t === 'identity' && e.identity.nativeId === ANN.id), 5000, 'the host as a person');
    await expect(call('home', { feed: 'following' })).rejects.toThrow('not signed in');
    await expect(call('home', { feed: 'foryou' })).rejects.toThrow('Partiful has no For you');
  },
  120_000,
);

it(
  'signing in in the live view: online, who it is, and the first read brings notifications, your events and the chats',
  async () => {
    fake.signIn();
    await until(() => statusOf(acc)?.status === 'online' && statusOf(acc)?.layers?.every((l: any) => l.state === 'ok'), 60_000, 'online with the first read');
    expect(statusOf(acc).self).toMatchObject({ nativeId: ME.id, isSelf: true });
    expect(statusOf(acc).layers.find((l: any) => l.name === 'signed in').note).toBe(`as user ${ME.id}`);
    await until(() => msg('s:smsg-0101'), 30_000, 'the chats read');
    const convs = evs(acc).filter((e) => e.t === 'conversation').map((e) => e.conversation);
    expect(convs.find((c) => c.nativeId === 'feed')).toEqual({ nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications' });
    // Each event you are in (going, hosting, invited, been to) is a group named after it.
    expect(convs.filter((c) => c.nativeId.startsWith('event:')).map((c) => [c.nativeId, c.name])).toEqual([
      [`event:${fake.world.mine.id}`, 'Board Games Night'],
      [`event:${fake.world.open.id}`, 'Rooftop Potluck'],
      [`event:${fake.world.hidden.id}`, 'Quiet Supper'],
      [`event:${fake.world.past.id}`, 'Summer Picnic'],
    ]);
    expect(convs.find((c) => c.nativeId === 'chat:dmAnnQuinn01')).toMatchObject({ shape: 'direct', participants: [ANN.id, `stream:${ME_STREAM}`] });
    expect(convs.find((c) => c.nativeId === 'chat:grpPotluck01')).toMatchObject({ shape: 'group', name: 'Potluck crew' });
    expect(msg(`other:ntf-0002:${ANN.id}`)).toMatchObject({ message: { conversation: 'feed', author: ANN.id, kind: 'system', body: 'Rooftop Potluck: Ann Lee replied: Bring snacks' }, live: false });
    expect(msg('s:smsg-0001')).toMatchObject({ message: { conversation: 'chat:dmAnnQuinn01', author: ANN.id, body: 'Hi! Coming Saturday?', reactions: [{ key: '❤️' }] } });
    // The periodic read also brings an upcoming event's comments.
    await until(() => msg('c:cmt-0001'), 30_000, 'an event’s comments');
    // Each author's identity came before their first message.
    const order = evs(acc).map((e) => (e.t === 'identity' ? `id:${e.identity.nativeId}` : e.t === 'message' ? `m:${e.message.nativeId}` : ''));
    expect(order.indexOf(`id:${ANN.id}`)).toBeLessThan(order.indexOf('m:s:smsg-0001'));
    expect(order.indexOf('id:partiful')).toBeLessThan(order.indexOf('m:other:ntf-0001:-'));
    // Signed in, the calls carry the page's own ID token and user; the chat calls carry the chat token.
    expect(fnCalls('getMyUpcomingEventsForHomePage')[0]).toMatchObject({ token: true, data: { params: {}, userId: ME.id, client: 'web' } });
    expect(fake.stream.find((c) => c.path === '/channels')).toMatchObject({ method: 'POST', token: true, query: { user_id: ME_STREAM, api_key: 'vpkgtsebxkk2' }, body: { filter_conditions: { type: 'messaging', members: { $in: [ME_STREAM] } }, sort: [{ field: 'last_message_at', direction: -1 }], state: true, watch: false, limit: 30 } });
    // Nothing marks notifications read.
    expect(fake.fns.filter((c) => /mark|Read|Seen/.test(c.fn))).toEqual([]);
  },
  120_000,
);

it(
  'following: your events, upcoming soonest first then past, with your RSVP and the event’s conversation',
  async () => {
    const page = await call('home', { feed: 'following' });
    expect(page.items.map((i: any) => [i.post.id, i.post.event.rsvp ?? null, i.post.event.hosting ?? false])).toEqual([
      [fake.world.mine.id, null, true],
      [fake.world.open.id, 'going', false],
      [fake.world.hidden.id, 'invited', false],
      [fake.world.past.id, 'going', false],
    ]);
    expect(page.items[1].post.event).toMatchObject({ conversation: `event:${fake.world.open.id}`, ics: expect.stringMatching(/^https:\/\/storage\.googleapis\.com\/.+event\.ics/) });
    expect(page.more).toBeNull();
  },
  60_000,
);

it(
  'an event with its guest list shown: hosts, the guests the site shows (and your mutuals), the comments as replies; no RSVP notes anywhere',
  async () => {
    const from = fake.fns.length;
    const t = await call('post', { post: fake.world.open.id });
    expect(t.focal).toMatchObject({ id: fake.world.open.id, author: ANN.id, counts: { replies: 3 }, event: { hosts: [ANN.id], guests: [BEN.id, CAL.id, ANN.id], guestsShown: 'all', rsvp: 'going' } });
    expect(t.replies.map((chain: any[]) => chain.map((p) => p.id))).toEqual([['comment:cmt-0001', 'comment:cmt-0002'], ['comment:cmt-0003']]);
    expect(fnCalls('getGuests', from)).toEqual([{ fn: 'getGuests', token: true, data: { params: { eventId: fake.world.open.id, includeInvitedGuests: true }, paging: { maxResults: 500 }, userId: ME.id, client: 'web' } }]);
    expect(fnCalls('getMutualGuests', from).length).toBe(1);
    // The hook took every RSVP note, time and history off the rows before they left the page.
    expect(JSON.stringify(t)).not.toContain('SECRET');
    expect(JSON.stringify(evs(acc))).not.toContain('SECRET');
  },
  60_000,
);

it(
  'an event whose host hid the guest list: the count only, and its guests are never asked for',
  async () => {
    const from = fake.fns.length;
    const t = await call('post', { post: fake.world.hidden.id });
    expect(t.focal.event).toMatchObject({ hosts: [BEN.id], going: 12, guestsShown: 'count', rsvp: 'invited' });
    expect(t.focal.event.guests).toBeUndefined();
    expect(fnCalls('getEventInfo', from).length).toBe(1);
    expect(fnCalls('getGuests', from)).toEqual([]);
    expect(fnCalls('getMutualGuests', from)).toEqual([]);
    expect(fake.fns.some((c) => (c.fn === 'getGuests' || c.fn === 'getMutualGuests') && c.data?.params?.eventId === fake.world.hidden.id)).toBe(false);
    expect(JSON.stringify(evs(acc))).not.toContain('SECRET-NOTE-HIDDEN');
  },
  60_000,
);

it(
  'an event’s conversation: comments, the host’s blast and album photos; writing a comment, answering one, reacting',
  async () => {
    const conv = `event:${fake.world.open.id}`;
    const h = await call('history', { conversation: conv, limit: 50 });
    expect(h).toMatchObject({ count: 5, done: true });
    expect(msg('h:hm-0001')).toMatchObject({ message: { conversation: conv, author: ANN.id, kind: 'text', extra: { event: fake.world.open.id, blast: true } } });
    expect(msg('m:phAlbum0002')).toMatchObject({ message: { author: BEN.id, kind: 'media', attachments: [{ kind: 'image' }] } });
    expect(msg('c:cmt-0003')).toMatchObject({ message: { kind: 'media', attachments: [{ nativeId: 'phAlbum0001' }] } });
    const from = fake.fns.length;
    const sent = await call('send', { conversation: conv, body: 'Count me in' });
    expect(sent.nativeId).toMatch(/^c:[\w-]+$/);
    await call('send', { conversation: conv, body: 'Snacks it is', replyTo: 'c:cmt-0002' });
    await call('react', { conversation: conv, message: 'c:cmt-0001', key: '🎉' });
    await call('react', { conversation: conv, message: 'c:cmt-0001', key: '🎉', remove: true });
    await call('react', { conversation: conv, message: 'h:hm-0001', key: '❤️' });
    const writes = fake.fns.slice(from).filter((c) => /^(create|update)/.test(c.fn));
    expect(writes.map((c) => [c.fn, { ...c.data.params, ...(c.data.params.id ? { id: 'X' } : {}), ...(c.data.params.timezone ? { timezone: 'Z' } : {}) }])).toEqual([
      ['createComment', { id: 'X', eventId: fake.world.open.id, message: 'Count me in', timezone: 'Z', mentions: [] }],
      ['createComment', { id: 'X', eventId: fake.world.open.id, message: 'Snacks it is', replyTo: 'cmt-0002', timezone: 'Z', mentions: [] }],
      ['updateCommentReaction', { eventId: fake.world.open.id, commentId: 'cmt-0001', reaction: { emoji: '🎉', active: true } }],
      ['updateCommentReaction', { eventId: fake.world.open.id, commentId: 'cmt-0001', reaction: { emoji: '🎉', active: false } }],
      ['updateHostMessageReaction', { eventId: fake.world.open.id, hostMessageId: 'hm-0001', reaction: { emoji: '❤️', active: true } }],
    ]);
    expect(writes.every((c) => c.token)).toBe(true);
    await expect(call('send', { conversation: 'feed', body: 'hi' })).rejects.toThrow('read-only');
    await expect(call('react', { conversation: conv, message: 'm:phAlbum0002', key: '🎉' })).rejects.toThrow('only comments and host messages');
  },
  60_000,
);

it(
  'chats: older messages, sending, an answer, reactions and the read mark, through Stream as the app does',
  async () => {
    const from = fake.stream.length;
    const h = await call('history', { conversation: 'chat:dmAnnQuinn01', limit: 50 });
    expect(h).toMatchObject({ count: 2, done: true, next: 'smsg-0001' });
    const sent = await call('send', { conversation: 'chat:dmAnnQuinn01', body: 'See you Saturday', replyTo: 's:smsg-0001' });
    expect(sent.nativeId).toMatch(new RegExp(`^s:${ME_STREAM}-`));
    await call('react', { conversation: 'chat:dmAnnQuinn01', message: 's:smsg-0001', key: '😂' });
    await call('react', { conversation: 'chat:dmAnnQuinn01', message: 's:smsg-0001', key: '❤️', remove: true });
    await call('markRead', { conversation: 'chat:dmAnnQuinn01', upTo: 's:smsg-0001' });
    expect(await call('markRead', { conversation: `event:${fake.world.open.id}`, upTo: 'c:cmt-0001' })).toEqual({});
    const calls = fake.stream.slice(from).map((c) => [c.method, c.path, c.body]);
    expect(calls).toEqual([
      ['POST', '/channels/messaging/dmAnnQuinn01/query', { state: true, watch: false, presence: false, messages: { limit: 50 } }],
      ['POST', '/channels/messaging/dmAnnQuinn01/message', { message: { id: expect.stringMatching(new RegExp(`^${ME_STREAM}-`)), text: 'See you Saturday', quoted_message_id: 'smsg-0001' } }],
      ['POST', '/messages/smsg-0001/reaction', { reaction: { type: 'haha' }, enforce_unique: false }],
      ['DELETE', '/messages/smsg-0001/reaction/love', null],
      ['POST', '/channels/messaging/dmAnnQuinn01/read', {}],
    ]);
    expect(fake.stream.slice(from).every((c) => c.token)).toBe(true);
  },
  60_000,
);

it(
  'RSVP: an app that may manage sends it as the event page does; one that may only write is refused before it reaches Partiful',
  async () => {
    const from = fake.fns.length;
    await expect(call('action', { action: 'rsvp', args: { eventId: fake.world.hidden.id, status: 'going' } }, writer)).rejects.toThrow('may not manage chat');
    expect(fnCalls('addGuest', from)).toEqual([]);
    const post = await call('action', { action: 'rsvp', args: { eventId: fake.world.hidden.id, status: 'maybe', note: 'Running late' } });
    expect(fnCalls('addGuest', from).map((c) => c.data.params)).toEqual([{ eventId: fake.world.hidden.id, rsvp: { status: 'MAYBE', count: 1, message: 'Running late' } }]);
    expect(post).toMatchObject({ id: fake.world.hidden.id, event: { rsvp: 'maybe', conversation: `event:${fake.world.hidden.id}` } });
    expect(post.event.guests).toBeUndefined();
    await expect(call('action', { action: 'rsvp', args: { eventId: fake.world.hidden.id, status: 'waitlist' } })).rejects.toThrow('rsvp status is one of');
  },
  60_000,
);

it(
  'a profile: name, picture, bio, socials as links, parties hosted and attended',
  async () => {
    const about = await call('profile', { who: ANN.id });
    expect(about).toMatchObject({ displayName: ANN.name, bio: ANN.bio, facts: [{ label: 'Hosted', value: '4' }, { label: 'Attended', value: '9' }] });
    expect(about.links.map((l: any) => l.url)).toEqual([`https://partiful.com/u/${ANN.id}`, 'https://instagram.com/ann.lee.example', 'https://x.com/annlee_example', 'https://ann.example.com']);
    // The same profile also goes out as an event, for apps that keep people's pages.
    const ev = await until(() => evs(acc).find((e) => e.t === 'personAbout' && e.who === ANN.id), 5000, 'the profile event');
    expect(ev.about.displayName).toBe(ANN.name);
  },
  60_000,
);

it(
  'a picture the site shows comes through the page; one from elsewhere is refused',
  async () => {
    const got = await call('fetchMedia', { url: `${fake.url}/__fake/media/annLee000001.png` });
    expect(got.mime).toBe('image/png');
    expect(Buffer.from(got.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    await expect(call('fetchMedia', { url: 'https://evil.example/a.png' })).rejects.toThrow('not a Partiful picture');
  },
  60_000,
);

it(
  'a 429 slows every read down and says so in the status; nothing is retried at once',
  async () => {
    const from = fake.fns.length;
    await expect(call('post', { post: 'evRateLimit1' })).rejects.toThrow('answered 429');
    await until(() => statusOf(acc)?.attention?.kind === 'rate_limited', 10_000, 'the slow-down in the status');
    await expect(call('post', { post: fake.world.open.id })).rejects.toThrow('slow down');
    expect(fnCalls('getEventInfo', from).length).toBe(1);
    // After the wait (2 s in tests; 10 minutes, doubling, on a real account) reads go again, and the status clears.
    await Bun.sleep(2100);
    await call('post', { post: fake.world.hidden.id });
    await until(() => statusOf(acc)?.status === 'online', 10_000, 'online again');
  },
  60_000,
);

it(
  'its state file keeps ids and times, no words or names',
  async () => {
    const f = join(dir, 'accounts', acc, 'partiful-state.json');
    await until(() => existsSync(f), 10_000, 'the state file');
    const s = readFileSync(f, 'utf8');
    expect(s).not.toContain(ANN.name);
    expect(s).not.toContain('Bring snacks');
    expect(s).toContain('newestNotice');
  },
  30_000,
);
