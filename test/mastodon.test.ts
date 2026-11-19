/**
 * The mastodon kind over the real wire: a manager with it, accounts added through the page's API, the extractor on a
 * fake Mastodon (extractors/mastodon/test/fake-mastodon.ts, invented data), and an app with the hub's chat grant:
 * signing in by a pasted code (and by a pasted token), the notifications as a feed, polling, home and trends, a
 * thread, favourites and boosts, posting (a reply that names whom it answers, a content warning, a quote, a picture),
 * deleting, who favourited, profiles, and a token the server stops taking.
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
import manifest from '../extractors/mastodon/manifest.ts';
import { type FakeMastodon, startFakeMastodon } from '../extractors/mastodon/test/fake-mastodon.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
let fake: FakeMastodon;
let m: Manager;
let dir: string;
let hub: AccountsClient;
let id: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const ENV = { DITHER_MASTODON_POLL_MS: '200', DITHER_MASTODON_BACKOFF_MS: '200' };
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
const add = async (config: Record<string, unknown>, secret: Record<string, unknown> = {}) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { origin: m.url }, body: JSON.stringify({ kind: 'mastodon', label: 'Mastodon', config, secret }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
};
const H = () => fake.host;
const who = (name: string) => `${name}@${H()}`;
const pid = (n: string) => `${H()}:${n}`;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fake = startFakeMastodon({ self: '1', selfToken: 'pasted-token-0000000000000' });
  fake.addAccount({ id: '1', username: 'quinn', display_name: 'Quinn' });
  fake.addAccount({ id: '2', username: 'alice', display_name: 'Alice Chen', note: '<p>Rust &amp; tea</p>', fields: [{ name: 'Site', value: '<a href="https://alice.example">alice.example</a>', verified_at: '2025-01-01T00:00:00Z' }] });
  fake.addAccount({ id: '3', username: 'bob', display_name: 'Bob' }, 'remote.example');
  fake.addStatus({ id: '10', account: '1', content: '<p>Hello <a href="https://example.com/a/very/long/link" rel="nofollow"><span class="invisible">https://</span><span class="ellipsis">example.com/a/very</span></a></p><p>second line</p>' });
  fake.addStatus({ id: '11', account: '2', in_reply_to_id: '10', content: '<p><span class="h-card"><a href="x" class="u-url mention">@<span>quinn</span></a></span> nice one</p>' });
  fake.addStatus({ id: '12', account: '3', in_reply_to_id: '11', content: '<p>agreed</p>' });
  fake.addStatus({ id: '13', account: '2', content: '<p>food pics</p>', spoiler_text: 'food', media: [{ id: 'm1', type: 'image', url: 'https://files.example/m1.png', description: 'a bowl of soup' }] });
  fake.addStatus({ id: '14', account: '3', content: '', reblog_of: '13' });
  fake.addStatus({ id: '15', account: '2', content: '<p>quote me</p>', quote_approval: { current_user: 'automatic' } });
  fake.favourites.add('10:2');
  fake.reblogs.add('10:3');
  fake.notify({ id: '101', type: 'favourite', account: '2', status: '10', created_at: new Date(Date.now() - 3_600_000).toISOString() });
  fake.notify({ id: '102', type: 'reblog', account: '3', status: '10' });
  fake.notify({ id: '103', type: 'follow', account: '3' });
  fake.notify({ id: '104', type: 'mention', account: '2', status: '11' });
  fake.notify({ id: '105', type: 'poll', account: '2', status: '13' });
  dir = mkdtempSync(join(tmpdir(), 'dacc-mastodon-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['mastodon', kindOf(manifest, join(ROOT, 'extractors/mastodon'))]]) });
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

test('signing in: the app registered, a link to sign in on the server, a wrong code refused, the right one taken', async () => {
  const kinds = ((await (await fetch(`${m.url}/api/state`, { headers: { origin: m.url } })).json()) as any).kinds;
  expect(kinds.find((k: any) => k.kind === 'mastodon').add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['instance', false, false],
    ['token', true, true],
  ]);
  id = await add({ instance: fake.url });
  const st = await until(() => lastStatus(id)?.attention?.detail?.signIn && lastStatus(id), 10_000, 'the sign-in link');
  expect(st.status).toBe('attention');
  expect(st.attention.kind).toBe('login');
  const link = new URL(st.attention.detail.signIn.url);
  expect(link.origin).toBe(fake.url);
  expect(link.pathname).toBe('/oauth/authorize');
  expect(Object.fromEntries(link.searchParams)).toEqual({ client_id: 'client-1', scope: 'read write follow', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', response_type: 'code' });
  expect(st.attention.detail.signIn).toMatchObject({ host: H(), action: 'signIn' });
  expect(fake.calls.find((c) => c.path === '/api/v1/apps')!.body).toEqual({ client_name: 'dither-accounts', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write follow' });

  await expect(call('action', { action: 'signIn', args: { code: 'not-a-code' } })).rejects.toThrow('did not take that code');
  const code = fake.approve('1');
  expect(await call('action', { action: 'signIn', args: { code } })).toEqual({ signedIn: true });
  const online = await until(() => lastStatus(id)?.status === 'online' && lastStatus(id), 10_000, 'online');
  expect(online.self).toMatchObject({ nativeId: who('quinn'), handle: `@${who('quinn')}`, displayName: 'Quinn' });
  expect(online.attention).toBeNull();
  expect(evs(id, 'hello')[0]).toMatchObject({ network: 'mastodon', capabilities: ['history', 'profile', 'posts', 'postActions', 'publish', 'postReactors', 'home', 'unpublish', 'postMedia'] });
  const accDir = m.store.account(id)!.dir;
  const secret = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8'));
  expect(Object.keys(secret).sort()).toEqual(['app', 'token']);
  const token = secret.token as string;
  // The token goes to the server and to secret.json only.
  const detail = await (await fetch(`${m.url}/api/accounts/${id}`, { headers: { origin: m.url } })).json();
  const elsewhere = JSON.stringify(detail) + JSON.stringify(evs(id, 'status')) + readFileSync(join(accDir, 'adapter.log'), 'utf8') + readFileSync(join(accDir, 'state.json'), 'utf8');
  expect(elsewhere).not.toContain(token);
  expect(elsewhere).not.toContain('secret-1');
});

test('the notifications: one feed conversation, each kind a message, read back quietly the first time', async () => {
  const feedId = `feed:${who('quinn')}`;
  await until(() => evs(id, 'conversation').find((e) => e.conversation.nativeId === feedId), 10_000, 'the feed conversation');
  expect(evs(id, 'conversation').find((e) => e.conversation.nativeId === feedId)!.conversation).toEqual({ nativeId: feedId, shape: 'channel', variant: 'feed', name: 'Notifications' });
  await until(() => message(id, 'other:105:' + who('alice')), 10_000, 'the first read');
  const like = message(id, `like:${pid('10')}:${who('alice')}`)!;
  expect(like.live).toBe(false);
  expect(like.message).toMatchObject({ conversation: feedId, author: who('alice'), kind: 'system', body: 'favourited your post' });
  expect(like.message.extra.feed).toMatchObject({ type: 'like', post: { id: pid('10'), author: who('quinn'), text: 'Hello https://example.com/a/very/long/link\n\nsecond line' } });
  expect(message(id, `repost:${pid('10')}:bob@remote.example`)!.message.body).toBe('boosted your post');
  expect(message(id, 'follow:bob@remote.example')!.message.extra.feed.type).toBe('follow');
  const reply = message(id, `reply:${pid('11')}`)!;
  expect(reply.message).toMatchObject({ kind: 'text', body: '@quinn nice one', mentionsSelf: true, author: who('alice') });
  expect(reply.message.extra.feed.theirs.replyTo).toEqual({ id: pid('10'), author: who('quinn') });
  expect(message(id, `other:105:${who('alice')}`)!.message.extra.feed).toMatchObject({ type: 'other', text: 'A poll you voted in or made has ended' });
  expect(evs(id, 'identity').find((e) => e.identity.nativeId === 'bob@remote.example')!.identity).toMatchObject({ handle: '@bob@remote.example', displayName: 'Bob' });
  // Oldest first.
  const order = evs(id, 'message').map((e) => e.message.nativeId);
  expect(order.indexOf(`like:${pid('10')}:${who('alice')}`)).toBeLessThan(order.indexOf(`reply:${pid('11')}`));
  // Nothing marks them read.
  expect(fake.calls.some((c) => c.method !== 'GET' && c.path.includes('notifications'))).toBe(false);
});

test('a new notification comes live with the next poll, asked for after the newest heard', async () => {
  fake.addStatus({ id: '16', account: '3', content: '<p>hey <span class="h-card"><a class="u-url mention">@quinn</a></span></p>' });
  fake.notify({ id: '106', type: 'mention', account: '3', status: '16' });
  const e = await until(() => message(id, `mention:${pid('16')}`), 10_000, 'the live mention');
  expect(e.live).toBe(true);
  expect(e.message.body).toBe('hey @quinn');
  expect(fake.calls.filter((c) => c.path === '/api/v1/notifications').some((c) => c.query.includes('min_id=105'))).toBe(true);
  expect(evs(id, 'message').filter((x) => x.message.nativeId === `mention:${pid('16')}`).length).toBe(1);
});

test('history pages back through the notifications by id', async () => {
  const before = evs(id, 'message').length;
  const r = await call('history', { conversation: `feed:${who('quinn')}`, limit: 3 });
  expect(r).toMatchObject({ count: 3, done: false, next: '104' });
  const r2 = await call('history', { conversation: `feed:${who('quinn')}`, limit: 3, cursor: r.next });
  expect(r2).toMatchObject({ count: 3, done: false, next: '101' });
  expect(evs(id, 'message').slice(before).every((e) => e.live === false)).toBe(true);
  await expect(call('history', { conversation: 'something-else', limit: 3 })).rejects.toThrow('Only the notifications');
});

test('home: Following pages by id, For you is the server\'s trends', async () => {
  const p1 = await call('home', { feed: 'following', count: 3 });
  expect(p1.items.map((i: any) => i.post.id)).toEqual([pid('16'), pid('15'), pid('14')]);
  expect(p1.items.every((i: any) => isPostId(i.post.id) && (!i.post.repostOf || isPostId(i.post.repostOf.id)))).toBe(true);
  expect(p1.more).toBe('max:14');
  expect(p1.top).toBe('min:16');
  const boost = p1.items[2].post;
  expect(boost).toMatchObject({ author: 'bob@remote.example', text: '' });
  expect(boost.repostOf).toMatchObject({ id: pid('13'), warning: 'food', media: [{ kind: 'image', url: 'https://files.example/m1.png', alt: 'a bowl of soup', width: 640, height: 480 }] });
  const p2 = await call('home', { feed: 'following', count: 3, cursor: p1.more });
  expect(p2.items.map((i: any) => i.post.id)).toEqual([pid('13'), pid('12'), pid('11')]);
  const trends = await call('home', { feed: 'foryou', count: 2 });
  expect(trends.items.map((i: any) => i.post.id)).toEqual([pid('10'), pid('13')]);
  expect(trends.items[0].reason).toEqual({ text: `Trending on ${H()}`, kind: 'topic' });
  expect(trends.more).toBe('off:2');
  expect((await call('home', { feed: 'foryou', count: 2, cursor: 'off:2' })).items.map((i: any) => i.post.id)).toEqual([pid('15'), pid('16')]);
});

test('a thread: what it answers, and its replies as chains the tree is drawn from', async () => {
  const t = await call('post', { post: pid('11') });
  expect(t.focal).toMatchObject({ id: pid('11'), replyTo: { id: pid('10'), author: who('quinn') } });
  expect(t.ancestors.map((p: any) => p.id)).toEqual([pid('10')]);
  expect(t.replies.map((c: any[]) => c.map((p) => p.id))).toEqual([[pid('12')]]);
  expect(t.more).toBeNull();
  const top = await call('post', { post: pid('10') });
  expect(top.replies.map((c: any[]) => c.map((p) => p.id))).toEqual([[pid('11'), pid('12')]]);
  expect(top.focal.counts).toMatchObject({ replies: 1, likes: 1, reposts: 1 });
  await expect(call('post', { post: 'other.example:10' })).rejects.toThrow('not one');
  await expect(call('post', { post: pid('999') })).rejects.toThrow('no such post');
});

test('favourite and boost, and taking them back', async () => {
  expect(await call('postAct', { post: pid('13'), act: 'like' })).toEqual({ liked: true, reposted: false });
  expect(fake.favourites.has('13:1')).toBe(true);
  expect(await call('postAct', { post: pid('13'), act: 'repost' })).toEqual({ liked: true, reposted: true });
  expect(await call('postAct', { post: pid('13'), act: 'unrepost' })).toEqual({ liked: true, reposted: false });
  expect(await call('postAct', { post: pid('13'), act: 'unlike' })).toEqual({ liked: false, reposted: false });
  expect(fake.favourites.has('13:1')).toBe(false);
});

test('posting: a reply names whom it answers, a warning, a quote, a link for a server without quotes, a picture', async () => {
  const r = await call('publish', { text: 'thanks!', replyTo: pid('11') });
  const sent = fake.calls.filter((c) => c.path === '/api/v1/statuses' && c.method === 'POST').at(-1)!;
  expect(sent.body).toEqual({ status: `@${who('alice')} thanks!`, in_reply_to_id: '11' });
  expect(sent.idem).toMatch(/^dither-/);
  expect(r).toMatchObject({ author: who('quinn'), replyTo: { id: pid('11'), author: who('alice') } });
  expect(r.text).toBe(`@${who('alice')} thanks!`);

  // Already named: not named twice.
  await call('publish', { text: '@alice again', replyTo: pid('11') });
  expect(fake.calls.filter((c) => c.path === '/api/v1/statuses').at(-1)!.body.status).toBe('@alice again');

  const cw = await call('publish', { text: 'spoilers ahead', warning: 'film ending' });
  expect(cw.warning).toBe('film ending');
  expect(fake.calls.filter((c) => c.path === '/api/v1/statuses').at(-1)!.body).toMatchObject({ spoiler_text: 'film ending', sensitive: true });

  const q = await call('publish', { text: 'this', quote: pid('15') });
  expect(fake.calls.filter((c) => c.path === '/api/v1/statuses').at(-1)!.body).toMatchObject({ status: 'this', quoted_status_id: '15' });
  expect(q.quoteOf).toMatchObject({ id: pid('15'), author: who('alice') });
  await call('publish', { text: 'old style', quote: pid('12') });
  expect(fake.calls.filter((c) => c.path === '/api/v1/statuses').at(-1)!.body.status).toBe(`old style\n\n${fake.url}/@bob@remote.example/12`);

  const file = join(dir, 'pic.png');
  writeFileSync(file, new Uint8Array([137, 80, 78, 71]));
  const pic = await call('publish', { text: 'look', media: [{ path: file, name: 'pic.png', mime: 'image/png', size: 4, kind: 'image' }] });
  expect(pic.media).toHaveLength(1);
  expect(fake.calls.find((c) => c.path === '/api/v2/media')!.body).toEqual({ file: 'pic.png' });

  await expect(call('publish', { text: 'x'.repeat(501) })).rejects.toThrow('takes 500');
  // A link counts as 23.
  await call('publish', { text: `${'y'.repeat(470)} https://example.com/${'z'.repeat(100)}` });
  await expect(call('publish', { text: 'hi', title: 'A title' })).rejects.toThrow('no title');
  await expect(call('publish', { text: 'hi', replies: 'following' })).rejects.toThrow('no limit');
});

test('deleting your own post, and one already gone counts as deleted', async () => {
  const made = await call('publish', { text: 'oops' });
  expect(await call('unpublish', { post: made.id })).toEqual({ deleted: true });
  expect(isPostId(made.id)).toBe(true);
  expect(fake.statuses.has(made.id.split(':').at(-1))).toBe(false);
  expect(await call('unpublish', { post: made.id })).toEqual({ deleted: true });
});

test('who favourited or boosted a post', async () => {
  const likes = await call('postReactors', { post: pid('10'), kind: 'like' });
  expect(likes).toEqual({ who: [{ id: who('alice'), followers: 3 }], more: null });
  const boosts = await call('postReactors', { post: pid('10'), kind: 'repost' });
  expect(boosts.who.map((w: any) => w.id)).toEqual(['bob@remote.example']);
});

test('profiles: a local person with fields and recent posts, a remote one found by address', async () => {
  const a = await call('profile', { who: who('alice') });
  expect(a).toMatchObject({ displayName: 'Alice Chen', handle: `@${who('alice')}`, bio: 'Rust & tea', relationship: 'following', followsYou: true, counts: { followers: 3, following: 4, posts: 5 } });
  expect(a.links).toEqual([{ label: 'Site', value: 'https://alice.example', url: 'https://alice.example', verified: true }]);
  expect(a.banner).toBeUndefined();
  expect(a.posts[0]).toMatchObject({ pinned: true });
  expect(a.posts.map((p: any) => p.id)).toContain(pid('13'));
  const b = await call('profile', { who: 'bob@remote.example' });
  expect(b).toMatchObject({ displayName: 'Bob', handle: '@bob@remote.example' });
  expect(fake.calls.some((c) => c.path === '/api/v2/search' && c.query.includes('resolve=true'))).toBe(true);
  await expect(call('profile', { who: 'nobody@nowhere.example' })).rejects.toThrow('cannot find');
});

test('a pasted access token signs in without the link; a token the server stops taking asks for a sign-in again', async () => {
  const other = await add({ instance: `${fake.url}/` }, { token: 'pasted-token-0000000000000' });
  await until(() => lastStatus(other)?.status === 'online', 10_000, 'online by token');
  // The first account's token revoked on the server.
  const accDir = m.store.account(id)!.dir;
  const token = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8')).token;
  fake.tokens.delete(token);
  const st = await until(() => lastStatus(id)?.attention?.detail?.signIn && lastStatus(id), 10_000, 'asked to sign in again');
  expect(st.attention.message).toContain('no longer takes');
  expect(JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8')).token).toBeUndefined();
  await expect(call('home', { feed: 'following' })).rejects.toThrow('Not signed in');
  // A token pasted where the code goes works too.
  expect(await call('action', { action: 'signIn', args: { code: 'pasted-token-0000000000000' } })).toEqual({ signedIn: true });
  await until(() => lastStatus(id)?.status === 'online', 10_000, 'online again');
});
