/**
 * extractors/x end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc) with its
 * extension, against the fake x.com (fake-x.ts): an ES-module page with two real React copies, the chat embed in a
 * shadow root and a Kotlin-shaped core. Skipped when Xvfb, chromium or x11vnc cannot be found. Every process it starts
 * is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { markerName, resolveBins } from '../packages/browser/src/index.ts';
import { inetSockets, rfbBanner, x11vncs } from '../packages/browser/test/inet.ts';
import { pageMarkerKey } from '../packages/manager/src/supervisor.ts';
import { ALICE, BOB, CAROL, DAVE, DIRECT, ERIN, type FakeX, GROUP, LEGACY, PIXEL, REQUEST, SELF, startFakeX } from './fake-x.ts';
import { CARA, DEV, EMI, FINN } from './fake-x-feed.ts';

const ROOT = join(import.meta.dir, '..');
let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`x-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeX;
/** The feed's first read soon after online, then every few seconds (in a real account: 30-60 s, then 4-8 minutes). */
const FEED_SOON = { feedFirstMs: 1500, feedEveryMs: 4000 };
const others: FakeX[] = [];
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let acc = '';
const made: string[] = [];
const events: Record<string, any[]> = {};

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
const helloOf = (a: string) => evs(a).filter((e) => e.t === 'hello').at(-1);
const messagesOf = (a: string) => evs(a).filter((e) => e.t === 'message');
const lastMessage = (a: string, id: string) => messagesOf(a).filter((e) => e.message.nativeId === id).at(-1);
const call = (op: string, input: any, account = acc) => app.call(chat, account, op as any, input) as Promise<any>;
const logOf = (a: string) => {
  const f = join(dir, 'accounts', a, 'adapter.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

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
  const id = ((await app.admin({ do: 'create', kind: 'x', label, config } as any)) as { id: string }).id;
  made.push(id);
  return id;
}
async function stopAccount(id: string) {
  await app.admin({ do: 'stop', account: id } as any).catch(() => {});
}

beforeAll(async () => {
  if (!bins) return;
  fake = await startFakeX({});
  dir = mkdtempSync(join(tmpdir(), 'dacc-x-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  // The kind is extractors/x's own manifest, whichever name it has while it is being built.
  const mf = existsSync(join(ROOT, 'extractors/x/manifest.ts')) ? 'manifest.ts' : 'manifest.wip.ts';
  m.kinds.set('x', kindOf((await import(join(ROOT, 'extractors/x', mf))).default, join(ROOT, 'extractors/x')));
  const reg = await register(m.url, { name: 'x-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['x'] }, { interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => (events[a] ??= []).push(...list) });
  await until(() => app.connected, 5000, 'the app connected');
}, 60_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  await m?.stop();
  const left = processesOf(made);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  for (const f of others) f.stop();
  rmSync(dir, { recursive: true, force: true });
  expect(left).toEqual([]);
}, 30_000);

it(
  'signed in: online, every layer ok, the self-test found every hook and says how, and who it is',
  async () => {
    acc = await account('X (test)', { testOrigin: fake.url, ...FEED_SOON });
    await until(() => statusOf(acc)?.status === 'online' && statusOf(acc)?.layers?.every((l: any) => l.state === 'ok'), 60_000, 'online');
    const st = statusOf(acc);
    expect(st.attention).toBeNull();
    expect(st.layers.map((l: any) => l.name)).toEqual(['display', 'browser', 'extension', 'signed in', 'hooks', 'XChat keys', 'inbox', 'sending', 'feed']);
    // The handle comes with the first message of its own it reads; until then, the user id.
    expect(st.layers.find((l: any) => l.name === 'signed in').note).toMatch(new RegExp(`^as (@${SELF.screenName}|user ${SELF.id})$`));
    await until(() => statusOf(acc)?.layers?.find((l: any) => l.name === 'signed in')?.note === `as @${SELF.screenName}`, 60_000, 'the handle');
    expect(st.layers.find((l: any) => l.name === 'inbox').note).toBe('3 conversations: 2 XChat, 1 legacy DM; 1 groups');
    expect(statusOf(acc).self).toMatchObject({ nativeId: SELF.id, handle: SELF.screenName, isSelf: true });
    expect(st.details).toMatchObject({
      pageState: 'chat',
      extensionAttached: true,
      hookVersion: 1,
      self: `${SELF.id} (graph)`,
      conversations: 3,
      xchat: 2,
      legacy: 1,
      groups: 1,
      reactRenderers: 2,
      'hook.react': 'found (devtools)',
      'hook.graph': 'found (name)',
      'hook.classes': 'found (module)',
      'hook.inbox': 'found (name)',
      'hook.open': 'found (event:module)',
      'hook.history': 'found (event)',
      'hook.read': 'found (event)',
      'hook.send': 'found (event)',
      'hook.reply': 'found (composer)',
      'hook.edit': 'found (composer)',
      'hook.unsend': 'found (event)',
      'hook.reactions': 'found (event)',
      'hook.self': 'found (graph)',
      'hook.webpack': 'found (chunk)',
      'hook.store': 'found (provider)',
      'hook.endpoints': 'found (thunk.api)',
      'hook.notifications': 'found (loader)',
      'hook.profiles': 'found (module)',
      'hook.posts': 'found (module)',
      'hook.actions': 'found (module)',
      'hook.reactors': 'pending',
      'hook.requests': 'found (graph)',
      'hook.answer': 'found (list:module)',
      'hook.openDirect': 'found (search)',
      'hook.createGroup': 'found (newDm)',
      'hook.addMembers': 'found (container)',
      'hook.groupInfo': 'found (container)',
      'hook.typing': 'found (composer)',
      'hook.forward': 'found (action)',
    });
    expect(helloOf(acc)).toMatchObject({ network: 'x', capabilities: ['liveView', 'media', 'history', 'markRead', 'send', 'sendMedia', 'edit', 'redact', 'react', 'typing', 'forward', 'openDirect', 'requests', 'about', 'configure', 'addMembers', 'createGroup', 'profile', 'posts', 'postActions', 'publish', 'postReactors'] });
    const lv = m!.router.liveView(acc)!;
    expect(lv).toEqual({ vncSocket: join(m!.store.account(acc)!.dir, 'vnc.sock'), width: 1280, height: 800 });
    expect(await rfbBanner(lv.vncSocket)).toMatch(/^RFB \d{3}\.\d{3}/);
    const vnc = x11vncs(processesOf([acc]));
    expect(vnc.length).toBe(1);
    expect(inetSockets(vnc[0]!)).toEqual([]);
  },
  90_000,
);

it("the extension in the account's directory: this install's and account's names, nothing that names us", () => {
  // The hook found its way to the extractor above, so both ends of the channel agreed; here, on what name.
  const ext = join(m!.store.account(acc)!.dir, 'extension');
  const key = pageMarkerKey(m!.store, acc);
  for (const f of ['hook.js', 'content.js']) {
    const text = readFileSync(join(ext, f), 'utf8');
    expect(text).toContain(`const UP = '${markerName(key, 'up')}';`);
    expect(text).toContain(`const DOWN = '${markerName(key, 'down')}';`);
  }
  for (const f of readdirSync(ext)) expect({ f, left: readFileSync(join(ext, f), 'utf8').match(/__MARK\w*|dither/i)?.[0] ?? null }).toEqual({ f, left: null });
});

it('the inbox: one-to-one and group conversations, legacy and XChat, and the people in them', async () => {
  const conv = (id: string) => evs(acc).filter((e) => e.t === 'conversation' && e.conversation.nativeId === id).at(-1)?.conversation;
  expect(conv(LEGACY)).toMatchObject({ nativeId: LEGACY, shape: 'direct', encrypted: false, participants: [SELF.id, ALICE.id] });
  expect(conv(GROUP)).toMatchObject({ nativeId: GROUP, shape: 'group', name: 'Weekend plans', encrypted: true });
  expect([...conv(GROUP).participants].sort()).toEqual([SELF.id, ALICE.id, BOB.id].sort());
  expect(conv(DIRECT)).toMatchObject({ nativeId: DIRECT, shape: 'direct', encrypted: true, participants: [SELF.id, BOB.id] });
  const who = (id: string) => evs(acc).filter((e) => e.t === 'identity' && e.identity.nativeId === id).at(-1)?.identity;
  expect(who(ALICE.id)).toEqual({ nativeId: ALICE.id, handle: ALICE.screenName, displayName: ALICE.displayName, avatarUrl: ALICE.avatarUrl });
  expect(who(BOB.id)).toMatchObject({ nativeId: BOB.id, handle: BOB.screenName });
  // Read state as the inbox has it: the legacy DM read to its end, the group not.
  expect(evs(acc).filter((e) => e.t === 'read' && e.conversation === LEGACY).at(-1)).toMatchObject({ unread: 0 });
  expect(evs(acc).filter((e) => e.t === 'read' && e.conversation === GROUP).at(-1)).toBeUndefined();
});

it(
  'catching up opens conversations quietly: messages as backfill, nothing marked read on X',
  async () => {
    await until(() => lastMessage(acc, 'm30') && lastMessage(acc, 'm33') && lastMessage(acc, 'm35'), 60_000, 'the three conversations read');
    expect(messagesOf(acc).every((e) => e.live === false)).toBe(true);
    // The UI reported what was on screen as read; the hook held it back.
    expect(fake.calls.filter((c) => c.op === 'read')).toEqual([]);
    await until(() => (statusOf(acc)?.details?.readsHeld ?? 0) > 0, 10_000, 'held reads counted');
    expect(lastMessage(acc, 'm31').message).toMatchObject({ conversation: GROUP, author: ALICE.id, body: 'who is in for saturday', extra: { encrypted: true } });
    expect(lastMessage(acc, 'm32').message).toMatchObject({ conversation: GROUP, author: BOB.id, kind: 'encrypted', body: '' });
    expect(lastMessage(acc, 'm33').message).toMatchObject({ author: SELF.id, body: 'count me in' });
    const pic = lastMessage(acc, 'm28').message;
    expect(pic).toMatchObject({ conversation: LEGACY, author: ALICE.id, body: 'legacy line 28', extra: { encrypted: false, seq: '28' } });
    expect(pic.attachments).toEqual([{ nativeId: 'att1', kind: 'image', mime: 'image/png', name: 'pixel.png', size: PIXEL.length, width: 1, height: 1, url: `x-media://${encodeURIComponent(LEGACY)}/m28/0` }]);
    expect(lastMessage(acc, 'm29').message.replyTo).toBe('m28');
    expect(lastMessage(acc, 'm30').message.reactions).toEqual([{ key: '👍', authors: [SELF.id] }]);
    // Only the newest twenty of the legacy DM: older ones wait for history.
    expect(lastMessage(acc, 'm10')).toBeUndefined();
  },
  90_000,
);

it(
  'the notifications: one read-only conversation, a message per person, their profiles; read as the tab reads them, nothing marked seen on X',
  async () => {
    const feedMsgs = () => messagesOf(acc).filter((e) => String(e.message.conversation).startsWith('feed:'));
    const first = fake.feed.posts.first.rest_id;
    const long = fake.feed.posts.long.rest_id;
    const want = [`like:${first}:${CARA.id}`, `like:${first}:${DEV.id}`, `like:${first}:${EMI.id}`, 'reply:1856000000000000101', 'mention:1856000000000000102', 'quote:1856000000000000103', `repost:${first}:${FINN.id}`, `follow:${DEV.id}`, 'other:AAAAAgF4:-', `like:${long}:${FINN.id}`];
    await until(() => want.every((id) => feedMsgs().some((e) => e.message.nativeId === id)), 60_000, 'the feed');
    expect(evs(acc).filter((e) => e.t === 'conversation' && String(e.conversation.nativeId).startsWith('feed:')).at(-1).conversation).toEqual({ nativeId: expect.stringMatching(/^feed:\d+$/), shape: 'channel', variant: 'feed', name: 'Notifications' });
    // The first read is backfill, two pages at most: nothing from the third.
    expect(feedMsgs().every((e) => e.live === false)).toBe(true);
    expect(feedMsgs().some((e) => e.message.nativeId === `follow:${EMI.id}`)).toBe(false);
    const byId = (id: string) => feedMsgs().filter((e) => e.message.nativeId === id).at(-1).message;
    expect(byId(`like:${first}:${DEV.id}`)).toMatchObject({ author: DEV.id, kind: 'system', body: 'liked your post', extra: { feed: { type: 'like', post: { id: first, author: SELF.id, text: 'tomatoes are finally red' }, url: `https://x.com/${SELF.screenName}/status/${first}` } } });
    expect(byId('reply:1856000000000000101')).toMatchObject({ author: CARA.id, kind: 'text', body: 'love this & want some', mentionsSelf: true, extra: { feed: { type: 'reply', theirs: { id: '1856000000000000101', replyTo: { id: first, author: SELF.id } } } } });
    expect(byId('mention:1856000000000000102').body).toBe(`hey @${SELF.screenName} look https://emi.example/garden`);
    expect(byId('quote:1856000000000000103')).toMatchObject({ author: FINN.id, body: 'this, exactly', extra: { feed: { type: 'quote', post: { id: long, text: expect.stringMatching(/^A long one about soil\. (compost ){60}that is all$/) } } } });
    expect(byId(`follow:${DEV.id}`)).toMatchObject({ kind: 'system', body: 'followed you' });
    expect(byId('other:AAAAAgF4:-')).toMatchObject({ author: 'x', kind: 'system', body: 'Your post was seen 1,000 times' });
    // Who did it is known before what they did, and their profiles came with them.
    const at = (f: (e: any) => boolean) => evs(acc).findIndex(f);
    for (const p of [CARA, DEV, EMI, FINN]) {
      expect(at((e) => e.t === 'identity' && e.identity.nativeId === p.id)).toBeLessThan(at((e) => e.t === 'message' && String(e.message.conversation).startsWith('feed:') && e.message.author === p.id));
      expect(evs(acc).filter((e) => e.t === 'personAbout' && e.who === p.id).length).toBe(1);
    }
    expect(evs(acc).find((e) => e.t === 'identity' && e.identity.nativeId === CARA.id).identity).toEqual({ nativeId: CARA.id, handle: CARA.handle, displayName: CARA.name, avatarUrl: `https://pbs.twimg.com/profile_images/${CARA.id}/${CARA.handle}_normal.jpg` });
    expect(evs(acc).find((e) => e.t === 'personAbout' && e.who === CARA.id)).toMatchObject({ about: { handle: CARA.handle, bio: 'Gardens, mostly. https://cara.example/garden', relationship: 'following', followsYou: true, counts: { followers: 120, following: 80, posts: 900 }, facts: [{ label: 'Location', value: 'Lisbon' }] }, ts: expect.any(Number) });
    expect(evs(acc).find((e) => e.t === 'personAbout' && e.who === EMI.id).about.relationship).toBeUndefined();
    expect(evs(acc).find((e) => e.t === 'personAbout' && e.who === DEV.id).about).toMatchObject({ followsYou: true, createdAt: DEV.createdAt });
    // As the tab asks: the All timeline, its chunk loaded once by the route's loader, then pages by cursor.
    const reads = fake.calls.filter((c) => c.op === 'graphql' && c.name === 'NotificationsTimeline');
    expect(reads[0]!.variables).toEqual({ timeline_type: 'All', count: 40 });
    expect(atob(String(reads[1]!.variables!.cursor))).toMatch(/^bottom:/);
    expect(fake.calls.filter((c) => c.op === 'chunk' && c.name === 'bundle.Notifications').length).toBe(1);
    expect(fake.calls.filter((c) => c.op === 'notifications.seen')).toEqual([]);
    await until(() => statusOf(acc)?.layers?.find((l: any) => l.name === 'feed')?.state === 'ok', 20_000, 'the feed layer');
    expect(statusOf(acc).details).toMatchObject({ 'feed.items': expect.any(Number), 'feed.people': 4, 'feed.lastFetch': expect.any(String) });

    // Someone new likes your post: the next look (only what is newer than the Top cursor) has it, live.
    fake.feed.like(FINN);
    const id = `like:${first}:${FINN.id}`;
    await until(() => feedMsgs().some((e) => e.message.nativeId === id), 30_000, 'the new like');
    expect(feedMsgs().filter((e) => e.message.nativeId === id).at(-1)).toMatchObject({ live: true, message: { author: FINN.id, body: 'liked your post' } });
    const later = fake.calls.filter((c) => c.op === 'graphql' && c.name === 'NotificationsTimeline').slice(2);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((c) => atob(String(c.variables!.cursor)).startsWith('top:'))).toBe(true);
    // Finn's profile was announced already today: not again.
    expect(evs(acc).filter((e) => e.t === 'personAbout' && e.who === FINN.id).length).toBe(1);
    expect(fake.calls.filter((c) => c.op === 'notifications.seen')).toEqual([]);
  },
  120_000,
);

it(
  'a profile on request: who they are and their recent posts, the pinned one first, reposts, quotes and pictures',
  async () => {
    const about = await call('profile', { who: CARA.id });
    expect(about).toMatchObject({ displayName: CARA.name, handle: CARA.handle, bio: 'Gardens, mostly. https://cara.example/garden', relationship: 'following', followsYou: true, counts: { followers: 120, following: 80, posts: 900 }, links: [{ label: 'X', value: `@${CARA.handle}`, url: `https://x.com/${CARA.handle}` }, { label: 'Website', value: 'cara.example', url: 'https://cara.example' }] });
    expect(about.posts.map((p: any) => [p.id, !!p.pinned])).toEqual([
      ['1856000000000000500', true],
      ['1856000000000000503', false],
      ['1856000000000000502', false],
      ['1856000000000000501', false],
    ]);
    expect(about.posts[0]).toMatchObject({ author: CARA.id, text: 'Pinned: my garden diary https://cara.example/diary', url: `https://x.com/${CARA.handle}/status/1856000000000000500` });
    expect(about.posts[1]).toMatchObject({ text: '', repostOf: { id: '1856000000000000499', author: DEV.id, text: 'worth it' } });
    expect(about.posts[2]).toMatchObject({ text: 'quoting a friend', quoteOf: { id: fake.feed.posts.first.rest_id, author: SELF.id } });
    expect(about.posts[3]).toMatchObject({ text: 'first ripe one', media: [{ kind: 'image', url: 'https://pbs.twimg.com/media/Fk7Tomato.jpg', width: 1200, height: 900, alt: 'a red tomato' }], counts: { likes: 12, views: 340 } });
    const asked = fake.calls.filter((c) => c.op === 'graphql' && (c.name === 'UserByRestId' || c.name === 'UserTweets'));
    expect(asked.map((c) => [c.name, c.variables!.userId])).toEqual([
      ['UserByRestId', CARA.id],
      ['UserTweets', CARA.id],
    ]);
    expect(asked[1]!.variables).toMatchObject({ count: 20, includePromotedContent: true });
    await expect(call('profile', { who: '9999' })).rejects.toThrow();
    expect(fake.calls.filter((c) => c.op === 'notifications.seen')).toEqual([]);
  },
  60_000,
);

it(
  "a post's thread on request: what it answers, the post, reply chains; then more replies, page by page; nothing marked",
  async () => {
    const g = fake.feed.thread;
    const ids = (ps: any[]) => ps.map((p: any) => p.id);
    const one = await call('post', { post: g.focal.rest_id });
    expect(one.focal).toMatchObject({ id: g.focal.rest_id, author: CARA.id, root: g.root.rest_id, text: 'San Marzano, mostly https://cara.example/san-marzano', replyTo: { id: g.answer.rest_id, author: FINN.id } });
    expect(ids(one.ancestors)).toEqual([g.root.rest_id, g.answer.rest_id]);
    expect(one.replies.map(ids)).toEqual([[g.self1.rest_id, g.self2.rest_id], [g.emi1.rest_id, g.emi2.rest_id], [g.dev1.tweet.rest_id]]);
    expect(one.more).toBe(g.cursors.page2);
    // Everyone who wrote them is known to the hub (announced now, or already with the notifications).
    const named = new Set(evs(acc).filter((e) => e.t === 'identity').map((e) => e.identity.nativeId));
    for (const p of [one.focal, ...one.ancestors, ...one.replies.flat()]) expect(named.has(p.author)).toBe(true);
    const two = await call('post', { post: g.focal.rest_id, cursor: one.more });
    expect(two.focal).toBeUndefined();
    expect(two.replies.map(ids)).toEqual([[g.finn1.rest_id], [g.emi3.rest_id, g.emi4.rest_id]]);
    expect(two.more).toBe(g.cursors.page3);
    const three = await call('post', { post: g.focal.rest_id, cursor: two.more });
    expect(three).toMatchObject({ ancestors: [], replies: [[{ id: g.dev2.rest_id, author: DEV.id }]], more: null });
    // Asked as opening the post asks: the page's own TweetDetail call, ranked by relevance, ads included as X asks.
    const asked = fake.calls.filter((c) => c.op === 'graphql' && c.name === 'TweetDetail');
    expect(asked.map((c) => c.variables!.cursor ?? null)).toEqual([null, g.cursors.page2, g.cursors.page3]);
    expect(asked[0]!.variables).toMatchObject({ focalTweetId: g.focal.rest_id, referrer: 'tweet', rankingMode: 'Relevance', includePromotedContent: true });
    await expect(call('post', { post: '1856000000000009999' })).rejects.toThrow('X did not give this post');
    await expect(call('post', { post: 'not-an-id' })).rejects.toThrow('not an X post id');
    expect(fake.calls.filter((c) => c.op === 'notifications.seen')).toEqual([]);
  },
  60_000,
);

it(
  'answering on X: like and repost and back, as the buttons do, once each; what you did shows on the post',
  async () => {
    const g = fake.feed.thread;
    const focal = g.focal.rest_id;
    const writes = () => fake.calls.filter((c) => c.op === 'graphql' && c.method === 'POST');
    const before = writes().length;
    expect(await call('postAct', { post: focal, act: 'like' })).toEqual({ liked: true });
    expect(await call('postAct', { post: focal, act: 'repost' })).toEqual({ reposted: true });
    // Each the one mutation the button sends, POSTed, with the post's id as X names it.
    expect(writes().slice(before).map((c) => [c.name, c.variables])).toEqual([
      ['FavoriteTweet', { tweet_id: focal }],
      ['CreateRetweet', { tweet_id: focal }],
    ]);
    // The post read again says so.
    const read = await call('post', { post: focal });
    expect(read.focal.viewer).toEqual({ liked: true, reposted: true });
    expect(read.focal.counts.likes).toBe(5);
    expect(read.ancestors[0].viewer).toEqual({ liked: false, reposted: false });
    // Already liked: X says so (139), and the post stands as asked.
    expect(await call('postAct', { post: focal, act: 'like' })).toEqual({ liked: true });
    expect(await call('postAct', { post: focal, act: 'unlike' })).toEqual({ liked: false });
    expect(await call('postAct', { post: focal, act: 'unrepost' })).toEqual({ reposted: false });
    expect(writes().slice(before).map((c) => c.name)).toEqual(['FavoriteTweet', 'CreateRetweet', 'FavoriteTweet', 'UnfavoriteTweet', 'DeleteRetweet']);
    expect(writes().at(-1)!.variables).toEqual({ source_tweet_id: focal });
    expect((await call('post', { post: focal })).focal.viewer).toEqual({ liked: false, reposted: false });
    // A failure is X's plain words, sent once.
    await expect(call('postAct', { post: '1856000000000009999', act: 'like' })).rejects.toThrow('No status found with that ID.');
    expect(writes().filter((c) => c.variables!.tweet_id === '1856000000000009999').length).toBe(1);
    await expect(call('postAct', { post: focal, act: 'bookmark' })).rejects.toThrow('not a post action');
    await expect(call('postAct', { post: 'nope', act: 'like' })).rejects.toThrow('not an X post id');
  },
  90_000,
);

it(
  'answering on X: a post, a reply and a quote through the composer, each the post X made; a duplicate fails once',
  async () => {
    const g = fake.feed.thread;
    const first = fake.feed.posts.first.rest_id;
    const creates = () => fake.calls.filter((c) => c.op === 'graphql' && c.name === 'CreateTweet');
    const n0 = creates().length;
    const own = await call('publish', { text: 'first frost tonight' });
    expect(own).toMatchObject({ author: SELF.id, text: 'first frost tonight', url: `https://x.com/${SELF.screenName}/status/${own.id}`, viewer: { liked: false, reposted: false } });
    expect(fake.feed.made.has(own.id)).toBe(true);
    expect(own.replyTo).toBeUndefined();
    // A reply: to the post, its author named.
    const reply = await call('publish', { text: 'Black Krim are worth it', replyTo: g.focal.rest_id });
    expect(reply).toMatchObject({ author: SELF.id, text: 'Black Krim are worth it', replyTo: { id: g.focal.rest_id, author: CARA.id }, root: g.root.rest_id });
    // A quote: the quoted post's link, with its author's handle, as the composer attaches it.
    const quote = await call('publish', { text: 'still true', quote: first });
    expect(quote).toMatchObject({ text: 'still true', quoteOf: { id: first, author: SELF.id } });
    const sent = creates().slice(n0);
    expect(sent.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
    expect(sent[0]!.variables).toMatchObject({ tweet_text: 'first frost tonight', media: { media_entities: [] } });
    expect(sent[0]!.variables!.reply).toBeUndefined();
    expect(sent[1]!.variables).toMatchObject({ tweet_text: 'Black Krim are worth it', reply: { in_reply_to_tweet_id: g.focal.rest_id, exclude_reply_user_ids: [] } });
    expect(sent[2]!.variables).toMatchObject({ tweet_text: 'still true', attachment_url: `https://x.com/${SELF.screenName}/status/${first}` });
    // Each read back alone after it was made; the quoted one read before.
    const reads = fake.calls.filter((c) => c.op === 'graphql' && c.name === 'TweetResultByRestId').map((c) => c.variables!.tweetId);
    expect(reads).toEqual(expect.arrayContaining([own.id, reply.id, first, quote.id]));
    // The people in them are known to the hub.
    const named = new Set(evs(acc).filter((e) => e.t === 'identity').map((e) => e.identity.nativeId));
    expect(named.has(SELF.id)).toBe(true);
    // A duplicate: X's words, and one CreateTweet only (never retried).
    await expect(call('publish', { text: 'first frost tonight' })).rejects.toThrow('Status is a duplicate.');
    expect(creates().length).toBe(n0 + 4);
    // Too long for X, or nothing: refused before the page is asked.
    await expect(call('publish', { text: 'a'.repeat(281) })).rejects.toThrow('too long for X: 281 of 280');
    await expect(call('publish', { text: '   ' })).rejects.toThrow('nothing to post');
    await expect(call('publish', { text: 'hi', replyTo: 'x' })).rejects.toThrow('not an X post id to reply to');
    expect(creates().length).toBe(n0 + 4);
    expect(fake.calls.filter((c) => c.op === 'notifications.seen')).toEqual([]);
  },
  90_000,
);

it(
  "answering on X: who liked or reposted your post, ranked, page by page, from the activity route's chunk; nobody on someone else's",
  async () => {
    const first = fake.feed.posts.first.rest_id;
    const chunks = () => fake.calls.filter((c) => c.op === 'chunk' && /Activity/.test(c.name!)).map((c) => c.name);
    expect(chunks()).toEqual([]);
    const one = await call('postReactors', { post: first, kind: 'like' });
    expect(one).toEqual({
      who: [
        { id: CARA.id, followers: 120, following: true, followsYou: true },
        { id: DEV.id, followers: 3400, following: false, followsYou: true, verified: true },
      ],
      more: 'DAAHlikes-2',
    });
    // Loaded as opening the likes would: the route's chunks, once.
    expect(chunks().sort()).toEqual(['bundle.TweetActivity', 'shared~bundle.QuoteTweetActivity~bundle.TweetActivity']);
    await until(() => statusOf(acc)?.details?.['hook.reactors'] === 'found (loader)', 20_000, 'the reactors hook');
    const named = new Set(evs(acc).filter((e) => e.t === 'identity').map((e) => e.identity.nativeId));
    for (const p of one.who) expect(named.has(p.id)).toBe(true);
    const two = await call('postReactors', { post: first, kind: 'like', cursor: one.more });
    expect(two).toEqual({ who: [{ id: EMI.id, followers: 12, following: false, followsYou: false }], more: 'DAAHlikes-3' });
    // The last page: nobody, though X still gives a cursor.
    expect(await call('postReactors', { post: first, kind: 'like', cursor: two.more })).toEqual({ who: [], more: null });
    expect(await call('postReactors', { post: first, kind: 'repost' })).toEqual({ who: [{ id: FINN.id, followers: 800, following: true, followsYou: false, verified: true }], more: 'DAAHreposts-2' });
    // Someone else's post: X shows its likes only to its author. An empty page, not an error.
    expect(await call('postReactors', { post: fake.feed.thread.focal.rest_id, kind: 'like' })).toEqual({ who: [], more: null });
    const asked = fake.calls.filter((c) => c.op === 'graphql' && (c.name === 'Favoriters' || c.name === 'Retweeters'));
    expect(asked.map((c) => [c.name, c.variables!.cursor ?? null])).toEqual([
      ['Favoriters', null],
      ['Favoriters', 'DAAHlikes-2'],
      ['Favoriters', 'DAAHlikes-3'],
      ['Retweeters', null],
      ['Favoriters', null],
    ]);
    expect(asked[0]!.variables).toMatchObject({ tweetId: first, count: 20, enableRanking: true });
    expect(chunks().length).toBe(2);
    await expect(call('postReactors', { post: first, kind: 'quote' })).rejects.toThrow('not likes or reposts');
  },
  90_000,
);

it(
  'a message arriving is live, with its sender; someone typing is relayed',
  async () => {
    fake.typing(GROUP, BOB.id);
    await until(() => evs(acc).find((e) => e.t === 'typing' && e.conversation === GROUP && e.author === BOB.id && !e.stop), 20_000, 'typing');
    fake.typing(GROUP, BOB.id, true);
    const sent = fake.deliver(GROUP, ALICE.id, 'pizza at seven');
    const ev = await until(() => lastMessage(acc, sent.id), 60_000, 'the new message');
    expect(ev).toMatchObject({ live: true, message: { conversation: GROUP, author: ALICE.id, body: 'pizza at seven' } });
    await until(() => evs(acc).find((e) => e.t === 'typing' && e.conversation === GROUP && e.author === BOB.id && e.stop), 20_000, 'typing stopped');
    expect(fake.calls.filter((c) => c.op === 'read')).toEqual([]);
  },
  90_000,
);

it(
  "writes go through the client's own events: send, reply, edit, react, unsend, mark read",
  async () => {
    const r = await call('send', { conversation: DIRECT, body: 'hello from **dither**' });
    expect(fake.calls.filter((c) => c.op === 'send').at(-1)).toMatchObject({ conv: DIRECT, text: 'hello from dither', replyToSeq: null });
    const mine = fake.msgs.filter((x) => x.conv === DIRECT && x.from === SELF.id).at(-1)!;
    expect(r.nativeId).toBe(mine.id);
    await until(() => lastMessage(acc, mine.id), 20_000, 'the echo');
    expect(lastMessage(acc, mine.id).message).toMatchObject({ author: SELF.id, body: 'hello from dither' });

    await call('send', { conversation: LEGACY, body: 'replying', replyTo: 'm29' });
    expect(fake.calls.filter((c) => c.op === 'send').at(-1)).toMatchObject({ conv: LEGACY, text: 'replying', replyToSeq: 29 });

    await call('edit', { conversation: DIRECT, message: mine.id, body: 'hello, edited' });
    expect(fake.calls.filter((c) => c.op === 'edit').at(-1)).toMatchObject({ conv: DIRECT, id: mine.id, text: 'hello, edited' });
    await until(() => lastMessage(acc, mine.id)?.message.body === 'hello, edited', 20_000, 'the edit');
    expect(lastMessage(acc, mine.id).message.editedTs).toEqual(expect.any(Number));

    const hey = fake.msgs.find((x) => x.conv === DIRECT && x.text === 'hey pat')!;
    await call('react', { conversation: DIRECT, message: hey.id, key: '❤️' });
    expect(fake.calls.filter((c) => c.op === 'react').at(-1)).toMatchObject({ id: hey.id, emoji: '❤️', remove: false });
    await until(() => evs(acc).find((e) => e.t === 'reaction' && e.message === hey.id && e.key === '❤️' && e.author === SELF.id && !e.remove), 20_000, 'the reaction');
    await call('react', { conversation: DIRECT, message: hey.id, key: '❤️', remove: true });
    expect(fake.calls.filter((c) => c.op === 'react').at(-1)).toMatchObject({ id: hey.id, emoji: '❤️', remove: true });
    await until(() => evs(acc).find((e) => e.t === 'reaction' && e.message === hey.id && e.key === '❤️' && e.remove), 20_000, 'the reaction removed');
    // Someone else's reaction, seen in an open conversation (it arrives while the conversation is still open).
    await expect(call('redact', { conversation: DIRECT, message: hey.id })).rejects.toThrow(/does not offer to delete/);

    await call('redact', { conversation: DIRECT, message: mine.id });
    expect(fake.calls.filter((c) => c.op === 'unsend').at(-1)).toMatchObject({ conv: DIRECT, id: mine.id });
    await until(() => evs(acc).find((e) => e.t === 'delete' && e.nativeId === mine.id), 20_000, 'the delete');

    expect(fake.calls.filter((c) => c.op === 'read')).toEqual([]);
    await call('markRead', { conversation: GROUP, upTo: fake.msgs.filter((x) => x.conv === GROUP).at(-1)!.id });
    const read = fake.calls.filter((c) => c.op === 'read');
    expect(read).toEqual([{ op: 'read', conv: GROUP, seq: fake.msgs.filter((x) => x.conv === GROUP).at(-1)!.seq }]);
  },
  180_000,
);

it(
  'history of the feed or the posts the hub logs is no chat: answered at once, the page never asked',
  async () => {
    const before = fake.calls.length;
    for (const conversation of ['feed:1', 'posts:1', 'posts']) expect(await call('history', { conversation, limit: 40 })).toEqual({ count: 0, done: true });
    expect(fake.calls.length).toBe(before);
  },
  60_000,
);

it(
  'history scrolls up the way the page does, as backfill',
  async () => {
    const r = await call('history', { conversation: LEGACY, limit: 40 });
    expect(r.done).toBe(true);
    expect(r.count).toBeGreaterThanOrEqual(31);
    await until(() => lastMessage(acc, 'm1'), 10_000, 'the oldest message');
    expect(lastMessage(acc, 'm1')).toMatchObject({ live: false, message: { body: 'legacy line 1', author: ALICE.id } });
    expect(fake.calls.filter((c) => c.op === 'read').length).toBe(1);
  },
  120_000,
);

it(
  'media both ways: a picture fetched through the page, a picture sent through the composer',
  async () => {
    const got = await call('fetchMedia', { url: `x-media://${encodeURIComponent(LEGACY)}/m28/0` });
    expect(got.mime).toBe('image/png');
    expect(Buffer.from(got.base64, 'base64').equals(Buffer.from(PIXEL))).toBe(true);
    await expect(call('fetchMedia', { url: 'https://example.com/x.png' })).rejects.toThrow(/not an X media reference/);

    const path = join(dir, 'outgoing.png');
    writeFileSync(path, PIXEL);
    await call('send', { conversation: DIRECT, body: '', attachments: [{ path, name: 'outgoing.png', mime: 'image/png', size: PIXEL.length, kind: 'image' }] });
    const up = fake.calls.filter((c) => c.op === 'upload').at(-1)!;
    expect(fake.media.get(up.id!)!.data).toEqual(PIXEL);
    expect(fake.calls.filter((c) => c.op === 'send').at(-1)).toMatchObject({ conv: DIRECT, media: [up.id] });
    const sent = fake.msgs.filter((x) => x.conv === DIRECT).at(-1)!;
    await until(() => lastMessage(acc, sent.id), 20_000, 'the picture echo');
    expect(lastMessage(acc, sent.id).message).toMatchObject({ author: SELF.id, kind: 'media', attachments: [{ kind: 'image', mime: 'image/png' }] });
  },
  120_000,
);

it(
  'diagnostics: shapes, Kotlin class names and counts, and never a message, a name or a cookie',
  async () => {
    const d = await call('action', { action: 'diagnose' });
    expect(d.page).toMatchObject({
      page: { state: 'chat' },
      graph: { via: 'name', class: 'WebDmObjectGraph' },
      modules: { core: 'dm-core-Bq9FaKe1.js', coreVia: 'resources' },
      classes: { DmEvent: { via: 'module' }, ChatComposerEvent: { via: 'module' }, ConversationListEvent: { via: 'module' }, KtList: { via: 'module' }, ReactionPickerItem: { via: 'module' } },
      inbox: { via: 'name', previews: 3, preview: { class: 'ConversationPreviewWithMetadata' } },
    });
    expect(d.page.react.renderers).toEqual([
      { version: '19.3.1', pkg: 'react-dom' },
      { version: '19.3.1', pkg: 'react-dom' },
    ]);
    expect(d.page.classes.DmEvent.used).toMatchObject({ ScrolledToTop: 'class(1)', VisibleReadableItemsChanged: 'class(2)', ReactionPickerItemClick: 'class(3)', DeleteMessageForAll: 'class(1)', BackButtonClicked: 'object' });
    expect(d.page.classes.ChatComposerEvent.used).toMatchObject({ UserChangedText: 'class(2)', RightButtonClicked: 'class(1)', StartReplyingToMessage: 'class(2)' });
    expect(d.page.classes.ConversationListEvent.subclasses).toEqual(['RowClicked', 'ScrolledToBottomOfConversations']);
    expect(d.page.inbox.preview.keys.isLegacy).toBe('boolean');
    expect(d.page.inbox.preview.keys.preview.keys.lastReadSequenceNumber).toBe('bigint');
    const file = join(dir, 'accounts', acc, 'diagnostics.json');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    for (const secret of ['legacy line', 'saturday', 'pizza', 'hello', 'Weekend plans', ALICE.displayName, ALICE.screenName, BOB.screenName, 'fake-session', SELF.displayName, CARA.name, CARA.handle, FINN.handle, 'tomatoes', 'love this', 'garden', 'Lisbon']) expect(text).not.toContain(secret);
    // The feed's part: what was found and the shapes of what X answered.
    expect(d.page.feed).toMatchObject({ hooks: { webpack: { ok: true }, store: { ok: true }, endpoints: { ok: true }, notifications: { ok: true }, profiles: { ok: true }, posts: { ok: true }, actions: { ok: true }, reactors: { ok: true, via: 'loader' } }, endpoints: { via: 'thunk.api' }, notifications: { chunk: 'bundle.Notifications' }, reactors: { chunk: 'shared~bundle.QuoteTweetActivity~bundle.TweetActivity' } });
    expect(d.page.feed.actions.keys).toEqual(expect.arrayContaining(['like', 'unlike', 'retweet', 'unretweet', 'sendTweet']));
    expect(d.page.feed.responses.created).toMatchObject({ entities: { tweets: { '<id>': { full_text: 'string' } } }, result: 'string' });
    // The last reactors read was of someone else's post: a timeline with nothing in it.
    expect(d.page.feed.responses.reactors).toEqual({ instructions: { array: 0, first: null } });
    expect(d.page.feed.store.state).toContain('notifications');
    expect(d.page.feed.responses.notifications.instructions.array).toBeGreaterThan(0);
    expect(d.page.feed.responses.user).toMatchObject({ entities: { users: { '<id>': { screen_name: 'string' } } }, result: 'string' });
  },
  60_000,
);

it('the log and the status hold ids, counts and names of hooks: no message, no other person, no cookie', () => {
  const text = logOf(acc) + JSON.stringify(evs(acc).filter((e) => e.t === 'status'));
  expect(text.length).toBeGreaterThan(1000);
  for (const secret of ['legacy line', 'saturday', 'pizza', 'hello from', 'Weekend plans', ALICE.displayName, ALICE.screenName, BOB.displayName, BOB.screenName, 'fake-session', CARA.name, CARA.handle, DEV.handle, EMI.handle, FINN.handle, 'tomatoes', 'love this', 'garden', 'liked your post', 'Lisbon']) expect(text).not.toContain(secret);
});

// ----------------------------------------------------------------- requests, new chats, groups, typing, forwarding

const reqEvents = (a: string) => evs(a).filter((e) => e.t === 'requests' || e.t === 'request' || e.t === 'requestGone');
const FRANK = { id: '8007', screenName: 'frank_f', displayName: 'Frank F' };

it(
  "message requests: listed from X's Requests page, read quietly (nothing read on X), answered with its own buttons",
  async () => {
    // The whole list first: Carol's message request, from her, with what X lets you answer.
    const list = await until(() => evs(acc).find((e) => e.t === 'requests' && e.requests.some((r: any) => r.nativeId === REQUEST)), 60_000, 'the requests');
    expect(list.requests).toEqual([{ nativeId: REQUEST, kind: 'message', from: CAROL.id, target: { kind: 'conversation', nativeId: REQUEST }, ts: expect.any(Number), answers: ['accept', 'decline', 'block'] }]);
    expect(evs(acc).filter((e) => e.t === 'identity' && e.identity.nativeId === CAROL.id).at(-1)?.identity).toMatchObject({ handle: CAROL.screenName });
    expect(evs(acc).filter((e) => e.t === 'conversation' && e.conversation.nativeId === REQUEST).at(-1)?.conversation).toMatchObject({ shape: 'direct', encrypted: true, participants: [SELF.id, CAROL.id] });
    // Its messages read like any conversation's, through its /requests address, and nothing marked read on X.
    const hers = fake.msgs.filter((m) => m.conv === REQUEST);
    await until(() => hers.every((m) => lastMessage(acc, m.id)), 60_000, "Carol's messages");
    expect(lastMessage(acc, hers[0]!.id)).toMatchObject({ live: false, message: { conversation: REQUEST, author: CAROL.id, body: 'hello, we met at the conference' } });
    expect(fake.calls.filter((c) => c.op === 'read')).toEqual([{ op: 'read', conv: GROUP, seq: expect.any(Number) }]);
    // Looking at the Requests page (and opening a request from it) is what X marks seen, for this account only.
    expect(fake.calls.filter((c) => c.op === 'requestsSeen').length).toBeGreaterThanOrEqual(1);

    // A new one, live: a request event; declined with Delete and its confirmation, it goes, conversation and all.
    fake.request(FRANK, 'quick question about your post');
    const frank = await until(() => evs(acc).find((e) => e.t === 'request' && e.request.from === FRANK.id), 30_000, "Frank's request");
    expect(await call('answer', { request: frank.request.nativeId, answer: 'decline' })).toEqual({});
    expect(fake.calls.filter((c) => c.op === 'deleteRequest').at(-1)).toMatchObject({ conv: frank.request.nativeId });
    await until(() => evs(acc).some((e) => e.t === 'requestGone' && e.nativeId === frank.request.nativeId), 10_000, 'its requestGone');
    await until(() => evs(acc).some((e) => e.t === 'leave' && e.nativeId === frank.request.nativeId), 10_000, 'its leave');
    await expect(call('answer', { request: frank.request.nativeId, answer: 'accept' })).rejects.toThrow(/not waiting any more/);

    // Erin's, blocked with Block and its confirmation.
    fake.request(ERIN, 'hi');
    const erin = await until(() => evs(acc).find((e) => e.t === 'request' && e.request.from === ERIN.id), 30_000, "Erin's request");
    expect(await call('answer', { request: erin.request.nativeId, answer: 'block' })).toMatchObject({ identity: ERIN.id, relationship: 'blocked' });
    expect(fake.convs.get(erin.request.nativeId)).toMatchObject({ blocked: true, gone: true });

    // A group someone put you in: an invitation, answered only with Accept, from the conversation's own bar.
    fake.request(ALICE, 'join us', { id: 'g8800', title: 'Climbing', members: [ALICE.id, BOB.id] });
    const invite = await until(() => evs(acc).find((e) => e.t === 'request' && e.request.nativeId === 'g8800'), 30_000, 'the group invitation');
    expect(invite.request).toMatchObject({ kind: 'invite', target: { kind: 'conversation', nativeId: 'g8800', name: 'Climbing', members: 3 }, answers: ['accept'] });
    await expect(call('answer', { request: 'g8800', answer: 'decline' })).rejects.toThrow(/only with Accept/);
    expect(await call('answer', { request: 'g8800', answer: 'accept' })).toEqual({ conversation: 'g8800' });
    expect(fake.calls.filter((c) => c.op === 'acceptRequest').at(-1)).toEqual({ op: 'acceptRequest', conv: 'g8800' });

    // Carol's accepted from the list: hers now, in the inbox.
    expect(await call('answer', { request: REQUEST, answer: 'accept' })).toEqual({ conversation: REQUEST, identity: CAROL.id });
    expect(fake.convs.get(REQUEST)!.request).toBe(false);
    await until(() => evs(acc).some((e) => e.t === 'requestGone' && e.nativeId === REQUEST), 10_000, "Carol's requestGone");
    // Still nothing read on X but the one mark asked for.
    expect(fake.calls.filter((c) => c.op === 'read').length).toBe(1);
    expect(reqEvents(acc).length).toBeGreaterThan(4);
  },
  240_000,
);

it(
  "openDirect: one there already is found; a new one through New message's search, made by its first message; X's refusal said",
  async () => {
    expect(await call('openDirect', { peer: BOB.id })).toEqual({ conversation: DIRECT, existed: true });
    const r = await call('openDirect', { peer: DAVE.screenName });
    expect(r).toEqual({ conversation: `${SELF.id}:${DAVE.id}`, existed: false, startsAtFirstSend: true });
    expect(fake.calls.filter((c) => c.op === 'search').at(-1)).toEqual({ op: 'search', q: DAVE.screenName });
    const fact = await until(() => evs(acc).filter((e) => e.t === 'conversation' && e.conversation.nativeId === r.conversation).at(-1), 10_000, 'its fact');
    expect(fact.conversation).toMatchObject({ shape: 'direct', participants: [SELF.id, DAVE.id] });
    // Nothing on X until the first message, which its own address opens.
    expect(fake.convs.has(r.conversation)).toBe(false);
    await call('send', { conversation: r.conversation, body: 'hi dave' });
    expect(fake.calls.filter((c) => c.op === 'send').at(-1)).toMatchObject({ conv: r.conversation, text: 'hi dave' });
    expect(fake.convs.get(r.conversation)?.members).toEqual([SELF.id, DAVE.id]);
    await expect(call('openDirect', { peer: ERIN.screenName })).rejects.toThrow(/does not let you message/);
    await expect(call('openDirect', { peer: 'no one here!' })).rejects.toThrow(/not an X user id or handle/);
  },
  120_000,
);

it(
  'groups: made with Create a group and named on Edit Group; people added with Add people; About says who may change what',
  async () => {
    const made = await call('createGroup', { name: 'Hike club', people: [ALICE.id, CAROL.id, ERIN.id] });
    // (Copied first: bun's toMatchObject leaves its matchers in what it was given.)
    const madeConv = String(made.conversation);
    expect(madeConv).toMatch(/^g\d+$/);
    expect(made.added).toEqual([ALICE.id, CAROL.id]);
    expect(made.failed).toEqual([{ id: ERIN.id, reason: expect.stringMatching(/does not let you add them/) }]);
    expect(fake.calls.filter((c) => c.op === 'createGroup').at(-1)).toEqual({ op: 'createGroup', members: [ALICE.id, CAROL.id], title: null });
    expect(fake.calls.filter((c) => c.op === 'editGroup').at(-1)).toEqual({ op: 'editGroup', conv: madeConv, title: 'Hike club' });
    const named = await until(() => evs(acc).find((e) => e.t === 'conversation' && e.conversation.nativeId === madeConv && e.conversation.name === 'Hike club'), 20_000, 'its fact');
    expect(named.conversation).toMatchObject({ shape: 'group', encrypted: true });
    expect([...named.conversation.participants].sort()).toEqual([SELF.id, ALICE.id, CAROL.id].sort());
    await expect(call('createGroup', { people: [] })).rejects.toThrow(/at least 1/);
    await expect(call('createGroup', { name: 'x'.repeat(33), people: [ALICE.id] })).rejects.toThrow(/at most 32/);

    // About: yours, so you may change it; then Bob added, and a description.
    await until(async () => (await call('about', { target: { kind: 'conversation', nativeId: madeConv } })).fields.name.value === 'Hike club', 20_000, 'the name in its About');
    const a = await call('about', { target: { kind: 'conversation', nativeId: madeConv } });
    expect(a).toMatchObject({ noun: 'Group', fields: { name: { value: 'Hike club', canEdit: true }, topic: { value: '', canEdit: true }, avatar: { canEdit: false } }, adding: { can: true }, you: { role: 'Admin' } });
    const added = await call('addMembers', { target: { kind: 'conversation', nativeId: madeConv }, people: [BOB.id, ALICE.id] });
    expect(added.added.sort()).toEqual([ALICE.id, BOB.id].sort());
    expect(fake.calls.filter((c) => c.op === 'addMembers').at(-1)).toEqual({ op: 'addMembers', conv: madeConv, members: [BOB.id] });
    expect(added.about.members.list.map((m: any) => m.id)).toContain(BOB.id);
    const described = await call('configure', { target: { kind: 'conversation', nativeId: madeConv }, change: { key: 'topic', value: 'Sundays, early' } });
    expect(described.fields.topic).toEqual({ value: 'Sundays, early', canEdit: true });
    expect(fake.calls.filter((c) => c.op === 'editGroup').at(-1)).toEqual({ op: 'editGroup', conv: madeConv, description: 'Sundays, early' });
    await until(() => evs(acc).some((e) => e.t === 'conversation' && e.conversation.nativeId === madeConv && e.conversation.topic === 'Sundays, early'), 20_000, 'the topic in its fact');
    await expect(call('configure', { target: { kind: 'conversation', nativeId: madeConv }, change: { key: 'avatar', value: 'https://pbs.twimg.com/a.png' } })).rejects.toThrow(/picture from here is not built yet/);

    // Alice's group, where only admins edit: said, and refused before anything is asked of X.
    fake.convs.get(GROUP)!.adminOnlyEditGroupInfo = true;
    fake.typing(GROUP, BOB.id);
    fake.typing(GROUP, BOB.id, true);
    fake.deliver(GROUP, ALICE.id, 'rules changed');
    await until(async () => (await call('about', { target: { kind: 'conversation', nativeId: GROUP } })).fields.name.canEdit === false, 30_000, 'admin-only');
    const g = await call('about', { target: { kind: 'conversation', nativeId: GROUP } });
    expect(g).toMatchObject({ fields: { name: { value: 'Weekend plans', canEdit: false, reason: 'Only admins can edit this group’s name and description.' }, topic: { value: 'Saturday, somewhere warm' } }, you: { role: 'Member' } });
    expect(g.members.list).toContainEqual({ id: ALICE.id, role: 'Admin', rank: 100 });
    const edits = fake.calls.filter((c) => c.op === 'editGroup').length;
    await expect(call('configure', { target: { kind: 'conversation', nativeId: GROUP }, change: { key: 'name', value: 'Mine now' } })).rejects.toThrow(/Only admins/);
    expect(fake.calls.filter((c) => c.op === 'editGroup').length).toBe(edits);
    await expect(call('addMembers', { target: { kind: 'conversation', nativeId: DIRECT }, people: [ALICE.id] })).rejects.toThrow(/groups only/);
    // A one-to-one's About: the two of you.
    expect(await call('about', { target: { kind: 'conversation', nativeId: DIRECT } })).toMatchObject({ noun: 'Chat', fields: {}, members: { list: [{ id: SELF.id }, { id: BOB.id }] } });
  },
  240_000,
);

it(
  "typing as the composer reports it; a message forwarded with its Forward action and X's dialog, with a note",
  async () => {
    const before = fake.calls.filter((c) => c.op === 'typing').length;
    await Bun.sleep(3500); // past the core's own typing throttle, from the sends before
    await call('typing', { conversation: DIRECT });
    await until(() => fake.calls.filter((c) => c.op === 'typing').length > before, 30_000, 'the typing call');
    expect(fake.calls.filter((c) => c.op === 'typing').at(-1)).toEqual({ op: 'typing', conv: DIRECT });
    await Bun.sleep(500);
    const typed = fake.calls.filter((c) => c.op === 'typing').length;
    // A stop is nothing on X, and another start so soon is not sent again.
    await call('typing', { conversation: DIRECT, stop: true });
    await call('typing', { conversation: DIRECT });
    await Bun.sleep(1500);
    expect(fake.calls.filter((c) => c.op === 'typing').length).toBe(typed);
    // Nothing was left in the composer: the next message is just itself.
    await call('send', { conversation: DIRECT, body: 'after typing' });
    expect(fake.calls.filter((c) => c.op === 'send').at(-1)).toMatchObject({ conv: DIRECT, text: 'after typing' });

    const r = await call('forward', { conversation: GROUP, source: { conversation: LEGACY, message: 'm29' }, note: 'look at **this**' });
    expect(r).toEqual({});
    expect(fake.calls.filter((c) => c.op === 'forward').at(-1)).toEqual({ op: 'forward', conv: LEGACY, id: 'm29', to: [GROUP], note: 'look at this' });
    const fwd = fake.msgs.filter((m) => m.conv === GROUP && m.forwarded).at(-1)!;
    await until(() => lastMessage(acc, fwd.id), 30_000, 'the forward in the group');
    expect(lastMessage(acc, fwd.id).message).toMatchObject({ author: SELF.id, body: 'legacy line 29', forward: {} });
    // Somewhere X's dialog does not offer: the hub sends it itself.
    const nowhere = await call('forward', { conversation: 'g4242', source: { conversation: LEGACY, message: 'm29' } });
    expect(nowhere.fallback).toMatch(/does not offer/);
  },
  180_000,
);

it('after all that: nothing personal in the log or the status, and the diagnostics hold the new screens by shape', async () => {
  const text = logOf(acc) + JSON.stringify(evs(acc).filter((e) => e.t === 'status'));
  for (const secret of ['conference', 'quick question', 'Climbing', 'Hike club', 'Sundays', 'look at', 'hi dave', CAROL.screenName, CAROL.displayName, DAVE.screenName, ERIN.screenName, FRANK.screenName]) expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
  const d = await call('action', { action: 'diagnose' });
  expect(d.page.classes.MessageRequestsEvent.used).toMatchObject({ AcceptRequestClicked: 'class(1)', ConfirmDelete: 'object' });
  expect(d.page.classes.NewDmEvent.used).toMatchObject({ QueryChanged: 'class(1)', CreateButtonClicked: 'object' });
  expect(d.page.graphFactories).toEqual(['messageRequestsComponent', 'newDmComponent', 'convComponentContainer']);
  expect(d.page.requests).toMatchObject({ via: 'graph', signal: true });
  const file = readFileSync(join(dir, 'accounts', acc, 'diagnostics.json'), 'utf8');
  for (const secret of ['conference', 'Hike club', CAROL.screenName]) expect(file).not.toContain(secret);
});

it(
  'XChat PIN asked on this browser: attention with the live view, online once it is entered there',
  async () => {
    const pinned = await startFakeX({ pin: true });
    others.push(pinned);
    const id = await account('X (pin)', { testOrigin: pinned.url });
    await until(() => statusOf(id)?.attention?.kind === 'verify', 60_000, 'the PIN attention');
    const st = statusOf(id);
    expect(st).toMatchObject({ status: 'attention', attention: { kind: 'verify', liveView: true } });
    expect(st.attention.message).toMatch(/XChat PIN/);
    expect(st.layers.find((l: any) => l.name === 'XChat keys')).toMatchObject({ state: 'waiting', note: 'enter your XChat PIN in the live view (verify)' });
    expect(st.details).toMatchObject({ pageState: 'pin', pinMode: 'verify' });
    pinned.unlock();
    await until(() => statusOf(id)?.status === 'online', 60_000, 'online after the PIN');
    await stopAccount(id);
  },
  150_000,
);

it(
  "signed out: X's sign-in page is the attention, with the live view",
  async () => {
    const out = await startFakeX({ signedIn: false });
    others.push(out);
    const id = await account('X (signed out)', { testOrigin: out.url });
    await until(() => statusOf(id)?.attention?.kind === 'login', 60_000, 'the login attention');
    expect(statusOf(id)).toMatchObject({ status: 'attention', attention: { kind: 'login', liveView: true, message: 'Sign in to X in the live view' } });
    expect(statusOf(id).layers.find((l: any) => l.name === 'signed in')).toMatchObject({ state: 'waiting', note: 'sign in to X in the live view' });
    await stopAccount(id);
  },
  120_000,
);

it(
  'fallbacks: the core under another name is found from a stack; without the composer class it only reads',
  async () => {
    const odd = await startFakeX({ coreName: 'chunk-Zq81Lm.js', hideComposer: true });
    others.push(odd);
    const id = await account('X (read-only)', { testOrigin: odd.url, hookGraceMs: 3000 });
    await until(() => statusOf(id)?.attention?.kind === 'selector_broken', 60_000, 'read-only');
    const st = statusOf(id);
    expect(st.attention.message).toMatch(/only reads/);
    expect(st.layers.find((l: any) => l.name === 'sending')).toMatchObject({ state: 'failed', note: 'read-only: the composer events were not found' });
    expect(st.details).toMatchObject({ 'hook.send': 'missing', 'hook.edit': 'missing', 'hook.history': 'found (event)', 'hook.classes': 'found (module)' });
    expect(helloOf(id).capabilities).toEqual(['liveView', 'media', 'history', 'markRead', 'redact', 'react', 'forward', 'openDirect', 'requests', 'about', 'configure', 'addMembers', 'createGroup', 'profile', 'posts', 'postActions', 'publish', 'postReactors']);
    // It still reads.
    await until(() => evs(id).some((e) => e.t === 'message' && e.message.conversation === GROUP), 60_000, 'messages while read-only');
    const d = await call('action', { action: 'diagnose' }, id);
    expect(d.page.modules).toMatchObject({ core: 'chunk-Zq81Lm.js', coreVia: 'stack' });
    expect(d.page.classes.ChatComposerEvent).toBeNull();
    await expect(call('send', { conversation: DIRECT, body: 'no' }, id)).rejects.toThrow(/X changed/);
    await stopAccount(id);
  },
  150_000,
);

it(
  'fallbacks: Kotlin classes renamed are found by their shapes; what has no shape to go by is missing, and only that',
  async () => {
    const renamed = await startFakeX({ renameClasses: true });
    others.push(renamed);
    const id = await account('X (renamed)', { testOrigin: renamed.url, hookGraceMs: 3000 });
    await until(() => statusOf(id)?.status === 'online' && statusOf(id)?.details?.['hook.send'] !== 'missing', 60_000, 'online');
    const st = statusOf(id);
    expect(st.details).toMatchObject({
      'hook.graph': 'found (shape)',
      'hook.inbox': 'found (shape)',
      'hook.classes': 'found (module+shape)',
      'hook.open': 'found (event:module+shape)',
      'hook.send': 'found (event)',
      'hook.read': 'found (event)',
      'hook.reactions': 'missing',
    });
    expect(st.layers.find((l: any) => l.name === 'sending')).toEqual({ name: 'sending', state: 'ok', note: 'can send; not reactions' });
    expect(helloOf(id).capabilities).not.toContain('react');
    const r = await call('send', { conversation: DIRECT, body: 'shapes work' }, id);
    expect(renamed.calls.filter((c) => c.op === 'send').at(-1)).toMatchObject({ text: 'shapes work' });
    expect(r.nativeId).toEqual(expect.any(String));
    await stopAccount(id);
  },
  150_000,
);

it(
  "fallbacks: the graph's Requests factory under another name: X's Requests page itself is opened, read and answered on",
  async () => {
    const paged = await startFakeX({ renameRequestsFactory: true });
    others.push(paged);
    const id = await account('X (requests page)', { testOrigin: paged.url, hookGraceMs: 3000 });
    await until(() => statusOf(id)?.status === 'online' && statusOf(id)?.details?.['hook.requests'] === 'found (page)', 60_000, 'online, requests by the page');
    const list = await until(() => evs(id).find((e) => e.t === 'requests' && e.requests.length), 60_000, 'the requests from the page');
    expect(list.requests.map((r: any) => r.nativeId)).toEqual([REQUEST]);
    expect(await call('answer', { request: REQUEST, answer: 'accept' }, id)).toEqual({ conversation: REQUEST, identity: CAROL.id });
    expect(paged.calls.filter((c) => c.op === 'acceptRequest')).toEqual([{ op: 'acceptRequest', conv: REQUEST }]);
    expect(paged.calls.filter((c) => c.op === 'read')).toEqual([]);
    await stopAccount(id);
  },
  150_000,
);
