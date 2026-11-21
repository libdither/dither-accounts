/**
 * The bluesky kind over the real wire: a manager with it, accounts added through the page's API, the extractor on a
 * fake Bluesky (extractors/bluesky/test/fake-bluesky.ts, invented DIDs and handles), and an app with the hub's chat
 * grant: signing in with a handle and an app password (the handle resolved to its PDS), the notifications as a feed,
 * polling, history, Following and Discover, a thread, likes and reposts, posting (a reply, links, mentions and tags,
 * a quote, pictures, who may reply), deleting, who liked, profiles, a refreshed session, a rate limit, and the code
 * Bluesky emails for a sign-in.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { isPostId } from '@dither-chat/protocol';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import manifest from '../extractors/bluesky/manifest.ts';
import { type FakeBluesky, startFakeBluesky } from '../extractors/bluesky/test/fake-bluesky.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
const SELF = 'did:plc:quinnaaaaaaaaaaaaaaaaaaa';
const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bobaaaaaaaaaaaaaaaaaaaaa';
const PASSWORD = 'abcd-efgh-ijkl-mnop';
let fake: FakeBluesky;
let m: Manager;
let dir: string;
let hub: AccountsClient;
let id: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const saved: Record<string, string | undefined> = {};

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
const lastStatus = (acc: string) => evs(acc, 'status').at(-1);
const message = (acc: string, nativeId: string) => evs(acc, 'message').find((e) => e.message.nativeId === nativeId);
const call = (op: string, input: unknown, acc = id) => hub.call(chat, acc, op as any, input as any) as Promise<any>;
const add = async (config: Record<string, unknown>, secret: Record<string, unknown>) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { origin: m.url }, body: JSON.stringify({ kind: 'bluesky', label: 'Bluesky', config, secret }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
};
const uriOf = (did: string, rkey: string, collection = 'app.bsky.feed.post') => `at://${did}/${collection}/${rkey}`;
const pid = (did: string, rkey: string) => `${did}~${rkey}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const created = (collection: string) => fake.calls.filter((c) => c.nsid === 'com.atproto.repo.createRecord' && c.body?.collection === collection);

beforeAll(async () => {
  fake = startFakeBluesky({ self: SELF, password: PASSWORD, email: 'quinn@example.com' });
  const ENV = { DITHER_BLUESKY_POLL_MS: '200', DITHER_BLUESKY_BACKOFF_MS: '200', DITHER_BLUESKY_PLC: fake.url };
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fake.addProfile({ did: SELF, handle: 'quinn.example', displayName: 'Quinn' });
  fake.addProfile({ did: ALICE, handle: 'alice.example', displayName: 'Alice Chen', description: 'Rust and tea', following: true, followedBy: true });
  fake.addProfile({ did: BOB, handle: 'bob.example', displayName: 'Bob' });
  const shown = 'Hello example.com/a/very…';
  fake.addPost(SELF, 'p10', { text: `${shown}\n\nsecond line`, facets: [{ index: { byteStart: bytes('Hello '), byteEnd: bytes(shown) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a/very/long/link' }] }], langs: ['en'] }, 50);
  const p10 = { uri: uriOf(SELF, 'p10'), cid: fake.records.get(uriOf(SELF, 'p10'))!.cid };
  fake.addPost(ALICE, 'p11', { text: '@quinn.example nice one', reply: { root: p10, parent: p10 } }, 40);
  const p11 = { uri: uriOf(ALICE, 'p11'), cid: fake.records.get(uriOf(ALICE, 'p11'))!.cid };
  fake.addPost(BOB, 'p12', { text: 'agreed', reply: { root: p10, parent: p11 } }, 30);
  fake.addPost(ALICE, 'p13', { text: 'food pics', embed: { $type: 'app.bsky.embed.images', images: [{ image: { $type: 'blob', ref: { $link: 'bafyimg1' }, mimeType: 'image/png', size: 10 }, alt: 'a bowl of soup', aspectRatio: { width: 640, height: 480 } }] } }, 20);
  fake.addRecord(BOB, 'app.bsky.feed.repost', 'r13', { subject: { uri: uriOf(ALICE, 'p13'), cid: fake.records.get(uriOf(ALICE, 'p13'))!.cid } }, 15);
  fake.addPost(ALICE, 'p15', { text: 'quote me' }, 10);
  fake.addRecord(ALICE, 'app.bsky.feed.like', 'l10', { subject: p10 }, 9);
  fake.addRecord(BOB, 'app.bsky.feed.repost', 'r10', { subject: p10 }, 8);
  fake.addRecord(BOB, 'app.bsky.graph.follow', 'f1', { subject: SELF }, 7);
  fake.notify({ uri: uriOf(ALICE, 'l10', 'app.bsky.feed.like'), author: ALICE, reason: 'like', reasonSubject: p10.uri, minutesAgo: 60 });
  fake.notify({ uri: uriOf(BOB, 'r10', 'app.bsky.feed.repost'), author: BOB, reason: 'repost', reasonSubject: p10.uri, minutesAgo: 59 });
  fake.notify({ uri: uriOf(BOB, 'f1', 'app.bsky.graph.follow'), author: BOB, reason: 'follow', minutesAgo: 58 });
  fake.notify({ uri: p11.uri, author: ALICE, reason: 'reply', minutesAgo: 57 });
  fake.notify({ uri: uriOf(ALICE, 'sp1', 'app.bsky.graph.starterpack'), author: ALICE, reason: 'starterpack-joined', minutesAgo: 56 });
  dir = mkdtempSync(join(tmpdir(), 'dacc-bluesky-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['bluesky', kindOf(manifest, join(ROOT, 'extractors/bluesky'))]]) });
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
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

test('signing in: the handle resolved to its server, an app password, the session kept and never shown', async () => {
  const kinds = ((await (await fetch(`${m.url}/api/state`, { headers: { origin: m.url } })).json()) as any).kinds;
  expect(kinds.find((k: any) => k.kind === 'bluesky').add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['handle', false, false],
    ['password', true, false],
    ['service', false, true],
  ]);
  id = await add({ handle: '@quinn.example', service: fake.url }, { password: PASSWORD });
  const online = await until(() => lastStatus(id)?.status === 'online' && lastStatus(id), 10_000, 'online');
  expect(online.self).toMatchObject({ nativeId: SELF, handle: '@quinn.example', displayName: 'Quinn' });
  expect(online.attention).toBeNull();
  expect(evs(id, 'hello')[0]).toMatchObject({ network: 'bluesky', capabilities: ['history', 'profile', 'posts', 'postActions', 'publish', 'postReactors', 'home', 'unpublish', 'postMedia'] });
  expect(fake.calls.find((c) => c.nsid === 'com.atproto.identity.resolveHandle')!.params.get('handle')).toBe('quinn.example');
  const session = fake.calls.find((c) => c.nsid === 'com.atproto.server.createSession')!;
  expect(session.body).toEqual({ identifier: 'quinn.example', password: PASSWORD });
  expect(session.auth).toBeNull();
  const accDir = m.store.account(id)!.dir;
  const secret = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8'));
  expect(Object.keys(secret).sort()).toEqual(['password', 'session']);
  expect(secret.session).toMatchObject({ did: SELF, handle: 'quinn.example', pds: fake.url });
  // The password and tokens go to the server and to secret.json only.
  const detail = await (await fetch(`${m.url}/api/accounts/${id}`, { headers: { origin: m.url } })).json();
  const elsewhere = JSON.stringify(detail) + JSON.stringify(evs(id, 'status')) + readFileSync(join(accDir, 'adapter.log'), 'utf8') + readFileSync(join(accDir, 'state.json'), 'utf8');
  for (const s of [PASSWORD, secret.session.accessJwt, secret.session.refreshJwt]) expect(elsewhere).not.toContain(s);
});

test('the notifications: one feed conversation, each kind a message, read back quietly the first time', async () => {
  const feedId = `feed:${SELF}`;
  await until(() => evs(id, 'conversation').find((e) => e.conversation.nativeId === feedId), 10_000, 'the feed conversation');
  expect(evs(id, 'conversation').find((e) => e.conversation.nativeId === feedId)!.conversation).toEqual({ nativeId: feedId, shape: 'channel', variant: 'feed', name: 'Notifications' });
  await until(() => message(id, `other:${pid(ALICE, 'sp1')}:${ALICE}`), 10_000, 'the first read');
  const like = message(id, `like:${pid(SELF, 'p10')}:${ALICE}`)!;
  expect(like.live).toBe(false);
  expect(like.message).toMatchObject({ conversation: feedId, author: ALICE, kind: 'system', body: 'liked your post' });
  expect(like.message.extra.feed).toMatchObject({ type: 'like', post: { id: pid(SELF, 'p10'), author: SELF, text: 'Hello https://example.com/a/very/long/link\n\nsecond line', url: 'https://bsky.app/profile/quinn.example/post/p10', lang: 'en' } });
  expect(message(id, `repost:${pid(SELF, 'p10')}:${BOB}`)!.message.body).toBe('reposted your post');
  expect(message(id, `follow:${BOB}`)!.message.extra.feed.type).toBe('follow');
  const reply = message(id, `reply:${pid(ALICE, 'p11')}`)!;
  expect(reply.message).toMatchObject({ kind: 'text', body: '@quinn.example nice one', mentionsSelf: true, author: ALICE });
  expect(reply.message.extra.feed.theirs.replyTo).toEqual({ id: pid(SELF, 'p10'), author: SELF });
  expect(reply.message.extra.feed.post.id).toBe(pid(SELF, 'p10'));
  expect(message(id, `other:${pid(ALICE, 'sp1')}:${ALICE}`)!.message.extra.feed).toMatchObject({ type: 'other', text: 'joined Bluesky through your starter pack' });
  expect(evs(id, 'identity').find((e) => e.identity.nativeId === BOB)!.identity).toMatchObject({ handle: '@bob.example', displayName: 'Bob' });
  // Oldest first.
  const order = evs(id, 'message').map((e) => e.message.nativeId);
  expect(order.indexOf(`like:${pid(SELF, 'p10')}:${ALICE}`)).toBeLessThan(order.indexOf(`reply:${pid(ALICE, 'p11')}`));
  // Nothing marks them seen.
  expect(fake.calls.some((c) => c.nsid === 'app.bsky.notification.updateSeen')).toBe(false);
});

test('a new notification comes live with the next poll, and only once', async () => {
  fake.addPost(BOB, 'p16', { text: 'hey @quinn.example' }, 0);
  fake.notify({ uri: uriOf(BOB, 'p16'), author: BOB, reason: 'mention', minutesAgo: 0 });
  const e = await until(() => message(id, `mention:${pid(BOB, 'p16')}`), 10_000, 'the live mention');
  expect(e.live).toBe(true);
  expect(e.message.body).toBe('hey @quinn.example');
  const polled = fake.calls.filter((c) => c.nsid === 'app.bsky.notification.listNotifications').length;
  await until(() => fake.calls.filter((c) => c.nsid === 'app.bsky.notification.listNotifications').length >= polled + 2, 10_000, 'two more polls');
  expect(evs(id, 'message').filter((x) => x.message.nativeId === `mention:${pid(BOB, 'p16')}`).length).toBe(1);
});

test('history pages back through the notifications by cursor', async () => {
  const before = evs(id, 'message').length;
  const r = await call('history', { conversation: `feed:${SELF}`, limit: 3 });
  expect(r).toMatchObject({ count: 3, done: false, next: '3' });
  const r2 = await call('history', { conversation: `feed:${SELF}`, limit: 3, cursor: r.next });
  expect(r2).toMatchObject({ count: 3, done: true });
  expect(evs(id, 'message').slice(before).every((e) => e.live === false)).toBe(true);
  await expect(call('history', { conversation: 'something-else', limit: 3 })).rejects.toThrow('Only the notifications');
});

test('home: Following pages by cursor with reposts as their reposter\'s, For you is Discover', async () => {
  const p1 = await call('home', { feed: 'following', count: 3 });
  expect(p1.items.map((i: any) => i.post.id)).toEqual([pid(BOB, 'p16'), pid(BOB, 'r10'), pid(ALICE, 'p15')]);
  expect(p1.items.every((i: any) => isPostId(i.post.id) && (!i.post.repostOf || isPostId(i.post.repostOf.id)))).toBe(true);
  expect(p1.more).toBe('3');
  expect(p1.top).toBeNull();
  const p2 = await call('home', { feed: 'following', count: 3, cursor: p1.more });
  expect(p2.items.map((i: any) => i.post.id)).toEqual([pid(BOB, 'r13'), pid(ALICE, 'p13'), pid(BOB, 'p12')]);
  const repost = p2.items[0].post;
  expect(repost).toMatchObject({ author: BOB, text: '' });
  expect(repost.repostOf).toMatchObject({ id: pid(ALICE, 'p13'), author: ALICE, media: [{ kind: 'image', url: `https://cdn.example/full/${ALICE}/bafyimg1`, alt: 'a bowl of soup', width: 640, height: 480 }] });
  expect(p2.items[2].post.replyTo).toEqual({ id: pid(ALICE, 'p11'), author: ALICE });
  const disc = await call('home', { feed: 'foryou', count: 2 });
  expect(disc.items.map((i: any) => i.post.id)).toEqual([pid(SELF, 'p10'), pid(BOB, 'p16')]);
  expect(disc.items[0].reason).toEqual({ text: 'Discover', kind: 'topic' });
  expect(disc.more).toBe('2');
  expect(fake.calls.find((c) => c.nsid === 'app.bsky.feed.getFeed')!.params.get('feed')).toBe('at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot');
});

test('a thread: what it answers, and its replies as chains the tree is drawn from', async () => {
  const t = await call('post', { post: pid(ALICE, 'p11') });
  expect(t.focal).toMatchObject({ id: pid(ALICE, 'p11'), replyTo: { id: pid(SELF, 'p10'), author: SELF }, root: pid(SELF, 'p10') });
  expect(t.ancestors.map((p: any) => p.id)).toEqual([pid(SELF, 'p10')]);
  expect(t.replies.map((c: any[]) => c.map((p) => p.id))).toEqual([[pid(BOB, 'p12')]]);
  expect(t.more).toBeNull();
  const top = await call('post', { post: pid(SELF, 'p10') });
  expect(top.replies.map((c: any[]) => c.map((p) => p.id))).toEqual([[pid(ALICE, 'p11'), pid(BOB, 'p12')]]);
  expect(top.focal.counts).toMatchObject({ replies: 1, likes: 1, reposts: 1 });
  await expect(call('post', { post: 'not-a-post' })).rejects.toThrow('not a Bluesky post id');
  await expect(call('post', { post: pid(ALICE, 'nope') })).rejects.toThrow('no such post');
});

test('like and repost, and taking them back, with the post\'s cid', async () => {
  const cid = fake.records.get(uriOf(ALICE, 'p15'))!.cid;
  expect(await call('postAct', { post: pid(ALICE, 'p15'), act: 'like' })).toEqual({ liked: true, reposted: false });
  expect(created('app.bsky.feed.like').at(-1)!.body.record).toMatchObject({ $type: 'app.bsky.feed.like', subject: { uri: uriOf(ALICE, 'p15'), cid } });
  // Liked already: not liked twice.
  expect(await call('postAct', { post: pid(ALICE, 'p15'), act: 'like' })).toEqual({ liked: true, reposted: false });
  expect(created('app.bsky.feed.like').length).toBe(1);
  expect(await call('postAct', { post: pid(ALICE, 'p15'), act: 'repost' })).toEqual({ liked: true, reposted: true });
  expect(await call('postAct', { post: pid(ALICE, 'p15'), act: 'unrepost' })).toEqual({ liked: true, reposted: false });
  expect(await call('postAct', { post: pid(ALICE, 'p15'), act: 'unlike' })).toEqual({ liked: false, reposted: false });
  expect([...fake.records.values()].filter((r) => r.did === SELF && r.value?.subject?.uri === uriOf(ALICE, 'p15'))).toEqual([]);
});

test('posting: a reply with its root, links, mentions and tags, a quote, pictures, who may reply', async () => {
  const r = await call('publish', { text: 'thanks!', replyTo: pid(BOB, 'p12') });
  const sent = created('app.bsky.feed.post').at(-1)!.body.record;
  expect(sent.reply).toEqual({ root: { uri: uriOf(SELF, 'p10'), cid: fake.records.get(uriOf(SELF, 'p10'))!.cid }, parent: { uri: uriOf(BOB, 'p12'), cid: fake.records.get(uriOf(BOB, 'p12'))!.cid } });
  expect(r).toMatchObject({ author: SELF, text: 'thanks!', replyTo: { id: pid(BOB, 'p12'), author: BOB } });
  expect(isPostId(r.id)).toBe(true);

  const text = 'café: https://example.com/x. cc @alice.example @nobody.example #rust';
  await call('publish', { text });
  const facets = created('app.bsky.feed.post').at(-1)!.body.record.facets;
  const slice = (f: any) => new TextDecoder().decode(new TextEncoder().encode(text).slice(f.index.byteStart, f.index.byteEnd));
  expect(facets.map((f: any) => [slice(f), f.features[0]])).toEqual([
    ['https://example.com/x', { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/x' }],
    ['@alice.example', { $type: 'app.bsky.richtext.facet#mention', did: ALICE }],
    ['#rust', { $type: 'app.bsky.richtext.facet#tag', tag: 'rust' }],
  ]);

  const q = await call('publish', { text: 'this', quote: pid(ALICE, 'p15') });
  expect(created('app.bsky.feed.post').at(-1)!.body.record.embed).toEqual({ $type: 'app.bsky.embed.record', record: { uri: uriOf(ALICE, 'p15'), cid: fake.records.get(uriOf(ALICE, 'p15'))!.cid } });
  expect(q.quoteOf).toMatchObject({ id: pid(ALICE, 'p15'), author: ALICE });

  const file = join(dir, 'pic.png');
  writeFileSync(file, new Uint8Array([137, 80, 78, 71]));
  const pic = await call('publish', { text: 'look', quote: pid(ALICE, 'p15'), media: [{ path: file, name: 'pic.png', mime: 'image/png', size: 4, kind: 'image' }] });
  expect(fake.calls.find((c) => c.nsid === 'com.atproto.repo.uploadBlob')!.body).toEqual({ bytes: 4, type: 'image/png' });
  expect(created('app.bsky.feed.post').at(-1)!.body.record.embed).toMatchObject({ $type: 'app.bsky.embed.recordWithMedia', record: { record: { uri: uriOf(ALICE, 'p15') } }, media: { $type: 'app.bsky.embed.images', images: [{ image: { ref: { $link: 'bafyblob4' } } }] } });
  expect(pic.media).toHaveLength(1);
  expect(pic.quoteOf.id).toBe(pid(ALICE, 'p15'));

  const gated = await call('publish', { text: 'friends only', replies: 'following' });
  const gate = created('app.bsky.feed.threadgate').at(-1)!.body;
  expect(gate.rkey).toBe(gated.id.split('~')[1]);
  expect(gate.record).toMatchObject({ post: uriOf(SELF, gated.id.split('~')[1]), allow: [{ $type: 'app.bsky.feed.threadgate#followingRule' }] });
  expect(gated.replies).toBe('following');

  // 300 graphemes: a family emoji is one.
  await call('publish', { text: '👨‍👩‍👧'.repeat(300) });
  await expect(call('publish', { text: 'x'.repeat(301) })).rejects.toThrow('Bluesky takes 300');
  await expect(call('publish', { text: 'hi', title: 'A title' })).rejects.toThrow('no title');
  await expect(call('publish', { text: 'hi', place: 'somewhere' })).rejects.toThrow('not a place');
  await expect(call('publish', { text: 'hi', warning: 'spoilers' })).rejects.toThrow('content warnings');
  await expect(call('publish', { text: 'hi', replies: 'verified' })).rejects.toThrow('verified');
  await expect(call('publish', { text: 'hi', media: [{ path: file, name: 'v.mp4', mime: 'video/mp4', size: 4, kind: 'video' }] })).rejects.toThrow('no videos');
});

test('deleting your own post, one already gone counts as deleted, someone else\'s is refused', async () => {
  const made = await call('publish', { text: 'oops' });
  expect(await call('unpublish', { post: made.id })).toEqual({ deleted: true });
  expect(fake.records.has(uriOf(SELF, made.id.split('~')[1]))).toBe(false);
  expect(await call('unpublish', { post: made.id })).toEqual({ deleted: true });
  await expect(call('unpublish', { post: pid(ALICE, 'p15') })).rejects.toThrow('not yours');
});

test('who liked or reposted a post', async () => {
  const likes = await call('postReactors', { post: pid(SELF, 'p10'), kind: 'like' });
  expect(likes).toEqual({ who: [{ id: ALICE, following: true, followsYou: true }], more: null });
  const reposts = await call('postReactors', { post: pid(SELF, 'p10'), kind: 'repost' });
  expect(reposts.who.map((w: any) => w.id)).toEqual([BOB]);
});

test('profiles: by handle or DID, with counts, standing and recent posts', async () => {
  const a = await call('profile', { who: '@alice.example' });
  expect(a).toMatchObject({ displayName: 'Alice Chen', handle: '@alice.example', bio: 'Rust and tea', relationship: 'following', followsYou: true, counts: { followers: 3, following: 4, posts: 5 } });
  expect(a.posts.map((p: any) => p.id)).toEqual([pid(ALICE, 'p15'), pid(ALICE, 'p13'), pid(ALICE, 'p11')]);
  const b = await call('profile', { who: BOB });
  expect(b).toMatchObject({ displayName: 'Bob', handle: '@bob.example' });
  await expect(call('profile', { who: 'nobody.example' })).rejects.toThrow('not found');
});

test('an expired session is refreshed, and the command goes through', async () => {
  const refreshes = fake.calls.filter((c) => c.nsid === 'com.atproto.server.refreshSession').length;
  fake.expireAccess();
  const r = await call('home', { feed: 'following', count: 1 });
  expect(r.items).toHaveLength(1);
  expect(fake.calls.filter((c) => c.nsid === 'com.atproto.server.refreshSession').length).toBe(refreshes + 1);
  const secret = JSON.parse(readFileSync(join(m.store.account(id)!.dir, 'secret.json'), 'utf8'));
  expect(fake.access.has(secret.session.accessJwt)).toBe(true);
});

test('a rate limit reaches the app as a 429 it can wait out', async () => {
  fake.limitNext(1);
  const e = await call('home', { feed: 'following', count: 1 }).catch((x) => x);
  expect(String(e?.message ?? e)).toContain('rate limiting');
});

test('a sign-in code by email: asked for, a wrong one refused, the right one signs in; a wrong app password asks for another', async () => {
  fake.needCode = 'ABCDE-12345';
  const other = await add({ handle: 'quinn@example.com', service: fake.url }, { password: PASSWORD });
  const st = await until(() => lastStatus(other)?.attention?.kind === 'verify' && lastStatus(other), 10_000, 'asked for the code');
  expect(st.attention.detail).toEqual({ code: { type: 'text', length: 11 } });
  // An email signs in at the entryway itself, no handle resolved.
  expect(fake.calls.filter((c) => c.nsid === 'com.atproto.server.createSession').at(-1)!.body).toEqual({ identifier: 'quinn@example.com', password: PASSWORD });
  await expect(call('action', { action: 'signIn', args: { code: 'ZZZZZ-99999' } }, other)).rejects.toThrow('did not take that code');
  expect(await call('action', { action: 'signIn', args: { code: 'abcde12345' } }, other)).toEqual({ signedIn: true });
  await until(() => lastStatus(other)?.status === 'online', 10_000, 'online with the code');
  fake.needCode = null;
  await expect(call('action', { action: 'relogin', args: { password: 'wrong-wrong-wrong' } }, other)).rejects.toThrow('refused the handle or app password');
  const again = await until(() => lastStatus(other)?.attention?.kind === 'login' && lastStatus(other), 10_000, 'asked for an app password');
  expect(again.attention.message).toContain('App passwords');
  expect(await call('action', { action: 'relogin', args: { password: PASSWORD } }, other)).toEqual({ signedIn: true, needsCode: false });
});
