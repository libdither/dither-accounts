/**
 * The lemmy kind over the real wire: a manager with it, accounts added through the page's API, the extractor on a fake
 * Lemmy (extractors/lemmy/test/fake-lemmy.ts, invented data), and an app with the hub's chat grant: signing in with a
 * password (and a wrong one, then the right one), replies and mentions as a feed, polling, Subscribed and All, posts
 * with titles and communities, comment trees, upvotes, commenting and posting, deleting, profiles, a session that ends,
 * and two-factor codes (typed, and made from the secret).
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { isPostId } from '@dither-chat/protocol';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import manifest from '../extractors/lemmy/manifest.ts';
import { totp, totpSecret } from '../extractors/lemmy/src/map.ts';
import { type FakeLemmy, startFakeLemmy } from '../extractors/lemmy/test/fake-lemmy.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
let fake: FakeLemmy;
let m: Manager;
let dir: string;
let hub: AccountsClient;
let id: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const ENV = { DITHER_LEMMY_POLL_MS: '200', DITHER_LEMMY_BACKOFF_MS: '200' };
const saved: Record<string, string | undefined> = {};
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DP';

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
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { origin: m.url }, body: JSON.stringify({ kind: 'lemmy', label: 'Lemmy', config, secret }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
};
const H = () => fake.host;
const k = (key: string) => `${H()}:${key}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeAll(async () => {
  for (const [key, v] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = v;
  }
  fake = startFakeLemmy();
  fake.persons.set(1, { id: 1, name: 'quinn', display_name: 'Quinn', password: 'pw-quinn' });
  fake.persons.set(2, { id: 2, name: 'ann', display_name: 'Ann Lee' });
  fake.persons.set(3, { id: 3, name: 'bob', home: 'far.example' });
  fake.persons.set(4, { id: 4, name: 'tess', password: 'pw-tess', totpSecret: TOTP });
  fake.communities.set(1, { id: 1, name: 'rust', subscribed: true });
  fake.communities.set(2, { id: 2, name: 'tea', home: 'far.example' });
  fake.posts.set(1, { id: 1, name: 'Hello Rust', body: 'first post', creator: 1, community: 1, published: ago(300) });
  fake.posts.set(2, { id: 2, name: 'My teapot', url: 'https://files.example/teapot.jpg', creator: 2, community: 2, published: ago(200) });
  fake.posts.set(3, { id: 3, name: 'An article', url: 'https://example.com/article', body: 'worth a read', creator: 3, community: 1, published: ago(100) });
  fake.comments.set(10, { id: 10, post: 1, creator: 2, content: 'welcome!', path: '0.10', published: ago(90) });
  fake.comments.set(11, { id: 11, post: 1, creator: 1, content: 'thanks', path: '0.10.11', published: ago(80) });
  fake.comments.set(12, { id: 12, post: 1, creator: 3, content: 'same here', path: '0.10.11.12', published: ago(70) });
  fake.comments.set(13, { id: 13, post: 1, creator: 2, content: 'hey @quinn look', path: '0.13', published: ago(60) });
  fake.replies.push({ id: 1, comment: 10, recipient: 1 }, { id: 2, comment: 12, recipient: 1 });
  fake.mentions.push({ id: 1, comment: 13, recipient: 1 });
  dir = mkdtempSync(join(tmpdir(), 'dacc-lemmy-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['lemmy', kindOf(manifest, join(ROOT, 'extractors/lemmy'))]]) });
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
  for (const [key, v] of Object.entries(saved)) v === undefined ? delete process.env[key] : (process.env[key] = v);
});

test('signing in: a wrong password asks for the right one; then online, the session kept in secret.json only', async () => {
  const kinds = ((await (await fetch(`${m.url}/api/state`, { headers: { origin: m.url } })).json()) as any).kinds;
  expect(kinds.find((x: any) => x.kind === 'lemmy').add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['instance', false, false],
    ['username', false, false],
    ['password', true, false],
    ['totp', true, true],
  ]);
  id = await add({ instance: `${fake.url}/`, username: 'quinn' }, { password: 'wrong' });
  const st = await until(() => lastStatus(id)?.status === 'attention' && lastStatus(id), 10_000, 'asked for the password');
  expect(st.attention).toMatchObject({ kind: 'login', message: `${H()} refused the username or password.` });
  await expect(call('action', { action: 'relogin', args: { password: 'still-wrong' } })).rejects.toThrow('refused the username or password');
  expect(await call('action', { action: 'relogin', args: { password: 'pw-quinn' } })).toEqual({ signedIn: true, needsCode: false });
  const online = await until(() => lastStatus(id)?.status === 'online' && lastStatus(id), 10_000, 'online');
  expect(online.self).toMatchObject({ nativeId: `quinn@${H()}`, handle: `@quinn@${H()}`, displayName: 'Quinn' });
  expect(evs(id, 'hello')[0]).toMatchObject({ network: 'lemmy', capabilities: ['history', 'profile', 'posts', 'postActions', 'publish', 'home', 'unpublish'] });
  const accDir = m.store.account(id)!.dir;
  const secret = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8'));
  expect(Object.keys(secret).sort()).toEqual(['jwt', 'password']);
  const detail = await (await fetch(`${m.url}/api/accounts/${id}`, { headers: { origin: m.url } })).json();
  const elsewhere = JSON.stringify(detail) + JSON.stringify(evs(id, 'status')) + readFileSync(join(accDir, 'adapter.log'), 'utf8') + readFileSync(join(accDir, 'state.json'), 'utf8');
  expect(elsewhere).not.toContain(secret.jwt);
  expect(elsewhere).not.toContain('pw-quinn');
});

test('the feed: replies to your post and your comment, and a mention, read back quietly the first time', async () => {
  const feedId = `feed:quinn@${H()}`;
  await until(() => message(id, `mention:${k('c13')}`), 10_000, 'the first read');
  expect(evs(id, 'conversation').find((e) => e.conversation.nativeId === feedId)!.conversation).toEqual({ nativeId: feedId, shape: 'channel', variant: 'feed', name: 'Notifications' });
  const toPost = message(id, `reply:${k('c10')}`)!;
  expect(toPost.live).toBe(false);
  expect(toPost.message).toMatchObject({ conversation: feedId, author: `ann@${H()}`, kind: 'text', body: 'welcome!', mentionsSelf: true });
  expect(toPost.message.extra.feed).toMatchObject({ type: 'reply', theirs: { id: k('c10'), replyTo: { id: k('p1') } }, post: { id: k('p1'), title: 'Hello Rust', author: `quinn@${H()}` } });
  const toComment = message(id, `reply:${k('c12')}`)!;
  expect(toComment.message.author).toBe('bob@far.example');
  expect(toComment.message.extra.feed.theirs.replyTo).toEqual({ id: k('c11') });
  expect(toComment.message.extra.feed.post).toBeUndefined();
  expect(message(id, `mention:${k('c13')}`)!.message.extra.feed.type).toBe('mention');
  const order = evs(id, 'message').map((e) => e.message.nativeId);
  expect(order).toEqual([`reply:${k('c10')}`, `reply:${k('c12')}`, `mention:${k('c13')}`]);
  expect(fake.calls.some((c) => c.path.includes('mark'))).toBe(false);
});

test('a new reply comes live with the next poll, once', async () => {
  fake.comments.set(14, { id: 14, post: 1, creator: 2, content: 'one more', path: '0.14', published: new Date().toISOString() });
  fake.replies.push({ id: 3, comment: 14, recipient: 1 });
  const e = await until(() => message(id, `reply:${k('c14')}`), 10_000, 'the live reply');
  expect(e.live).toBe(true);
  const polls = fake.calls.filter((c) => c.path === '/api/v3/user/replies').length;
  await until(() => fake.calls.filter((c) => c.path === '/api/v3/user/replies').length >= polls + 2, 10_000, 'two more polls');
  expect(evs(id, 'message').filter((x) => x.message.nativeId === `reply:${k('c14')}`).length).toBe(1);
});

test('history reads the replies and mentions a page at a time', async () => {
  const r = await call('history', { conversation: `feed:quinn@${H()}`, limit: 2 });
  expect(r).toMatchObject({ count: 3, done: false, next: '2' });
  const r2 = await call('history', { conversation: `feed:quinn@${H()}`, limit: 2, cursor: r.next });
  expect(r2).toMatchObject({ count: 1, done: true });
});

test('home: Subscribed by New, All by Hot, paged by cursor; posts carry their title, community and link', async () => {
  const sub = await call('home', { feed: 'following', count: 1 });
  expect(sub.items.map((i: any) => i.post.id)).toEqual([k('p3')]);
  expect(sub.more).toBe('pc:Pa1');
  expect(fake.calls.filter((c) => c.path === '/api/v3/post/list').at(-1)!.query).toContain('type_=Subscribed');
  const next = await call('home', { feed: 'following', count: 1, cursor: sub.more });
  expect(next.items.map((i: any) => i.post.id)).toEqual([k('p1')]);
  const article = sub.items[0].post;
  expect(article).toEqual({
    id: k('p3'),
    url: `${fake.url}/post/3`,
    ts: expect.any(Number),
    author: 'bob@far.example',
    text: 'https://example.com/article\n\nworth a read',
    title: 'An article',
    place: { id: `rust@${H()}`, name: `!rust@${H()}`, url: `${fake.url}/c/rust` },
    counts: { replies: 0, likes: 0 },
    root: k('p3'),
    viewer: { liked: false },
  });
  const all = await call('home', { feed: 'foryou', count: 5 });
  expect(all.items.map((i: any) => i.post.id)).toEqual([k('p1'), k('p2'), k('p3')]);
  expect(fake.calls.filter((c) => c.path === '/api/v3/post/list').at(-1)!.query).toContain('sort=Hot');
  expect(all.items[1].post).toMatchObject({ text: '', media: [{ kind: 'image', url: 'https://files.example/teapot.jpg' }], place: { id: 'tea@far.example', name: '!tea@far.example', url: 'https://far.example/c/tea' } });
  expect(evs(id, 'identity').some((e) => e.identity.nativeId === 'bob@far.example')).toBe(true);
});

test('a post\'s comments as a tree of chains; a comment\'s thread with the post and comments above it', async () => {
  const t = await call('post', { post: k('p1') });
  expect(t.focal).toMatchObject({ id: k('p1'), title: 'Hello Rust', text: 'first post' });
  expect(t.ancestors).toEqual([]);
  expect(t.replies.map((c: any[]) => c.map((p) => p.id))).toEqual([[k('c10'), k('c11'), k('c12')], [k('c13')], [k('c14')]]);
  expect(t.replies[0][2]).toMatchObject({ replyTo: { id: k('c11') }, root: k('p1'), place: { id: `rust@${H()}` } });
  expect(t.replies.flat().every((p: any) => isPostId(p.id) && isPostId(p.replyTo.id))).toBe(true);
  expect(t.more).toBeNull();
  expect(fake.calls.filter((c) => c.path === '/api/v3/comment/list').at(-1)!.query).toContain('max_depth=8');
  const c = await call('post', { post: k('c11') });
  expect(c.focal.id).toBe(k('c11'));
  expect(c.ancestors.map((p: any) => p.id)).toEqual([k('p1'), k('c10')]);
  expect(c.replies.map((ch: any[]) => ch.map((p) => p.id))).toEqual([[k('c12')]]);
  await expect(call('post', { post: 'other.example:p1' })).rejects.toThrow('not a post or comment');
  await expect(call('post', { post: k('p99') })).rejects.toThrow('no such post');
});

test('upvotes on posts and comments, and taking them back; Lemmy has no reposts', async () => {
  expect(await call('postAct', { post: k('p3'), act: 'like' })).toEqual({ liked: true });
  expect(fake.votes.get('1:p3')).toBe(1);
  expect(await call('postAct', { post: k('p3'), act: 'unlike' })).toEqual({ liked: false });
  expect(fake.votes.has('1:p3')).toBe(false);
  expect(await call('postAct', { post: k('c10'), act: 'like' })).toEqual({ liked: true });
  await expect(call('postAct', { post: k('p3'), act: 'repost' })).rejects.toThrow('no reposts');
});

test('commenting on a post and a comment, posting to a community by its address, and what is refused', async () => {
  const top = await call('publish', { text: 'nice article', replyTo: k('p3') });
  expect(fake.calls.filter((c) => c.path === '/api/v3/comment').at(-1)!.body).toEqual({ content: 'nice article', post_id: 3 });
  expect(top).toMatchObject({ author: `quinn@${H()}`, replyTo: { id: k('p3') }, root: k('p3') });
  const nested = await call('publish', { text: 'agreed', replyTo: k('c10') });
  expect(fake.calls.filter((c) => c.path === '/api/v3/comment').at(-1)!.body).toEqual({ content: 'agreed', post_id: 1, parent_id: 10 });
  expect(nested.replyTo).toEqual({ id: k('c10') });
  // The hub sends a community's bare name: `name` here, `name@instance` from elsewhere.
  const post = await call('publish', { text: 'body text', title: 'A question', place: 'rust' });
  expect(fake.calls.filter((c) => c.path === '/api/v3/post' && c.method === 'POST').at(-1)!.body).toEqual({ name: 'A question', community_id: 1, body: 'body text' });
  expect(post).toMatchObject({ title: 'A question', place: { id: `rust@${H()}` } });
  // The place it gives back is taken back.
  await call('publish', { text: '', title: 'Again', place: post.place.id });
  expect(fake.calls.filter((c) => c.path === '/api/v3/post' && c.method === 'POST').at(-1)!.body.community_id).toBe(1);
  await call('publish', { text: '', title: 'Tea?', place: 'tea@far.example' });
  expect(fake.calls.filter((c) => c.path === '/api/v3/community').at(-1)!.query).toBe('?name=tea%40far.example');
  await expect(call('publish', { text: 'no title', place: 'rust' })).rejects.toThrow('needs a title');
  await expect(call('publish', { text: 'x', title: 'No place' })).rejects.toThrow('needs a community');
  await expect(call('publish', { text: 'x', title: 'Where', place: 'nowhere@far.example' })).rejects.toThrow('no such');
  await expect(call('publish', { text: 'x', quote: k('p1') })).rejects.toThrow('no quote');
  await expect(call('publish', { text: 'x', replyTo: k('p1'), warning: 'cw' })).rejects.toThrow('no content warnings');
});

test('deleting your own post and comment', async () => {
  const post = await call('publish', { text: 'oops', title: 'Oops', place: 'rust' });
  expect(await call('unpublish', { post: post.id })).toEqual({ deleted: true });
  expect(fake.posts.get(Number(post.id.split(':').at(-1).slice(1)))!.deleted).toBe(true);
  const c = await call('publish', { text: 'oops', replyTo: k('p1') });
  expect(await call('unpublish', { post: c.id })).toEqual({ deleted: true });
  expect(await call('unpublish', { post: k('p999') })).toEqual({ deleted: true });
  await expect(call('unpublish', { post: k('p2') })).rejects.toThrow('no_post_edit_allowed');
});

test('profiles: posts and comments newest first, what they moderate; someone from another instance', async () => {
  const ann = await call('profile', { who: `ann@${H()}` });
  expect(fake.calls.filter((c) => c.path === '/api/v3/user').at(-1)!.query).toContain('username=ann&');
  expect(ann).toMatchObject({ displayName: 'Ann Lee', handle: `@ann@${H()}`, counts: { posts: 1 } });
  expect(ann.facts).toContainEqual({ label: 'Moderates', value: 'rust' });
  expect(ann.facts).toContainEqual({ label: 'Comments', value: '3' });
  expect(ann.posts.map((p: any) => p.id)).toEqual([k('c14'), k('c13'), k('c10'), k('p2')]);
  const bob = await call('profile', { who: 'bob@far.example' });
  expect(bob.handle).toBe('@bob@far.example');
  await expect(call('profile', { who: 'nobody@far.example' })).rejects.toThrow('no such');
});

test('a session the instance stops taking: signed in again with the password, by itself', async () => {
  const accDir = m.store.account(id)!.dir;
  const before = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8')).jwt;
  fake.endSessions();
  await until(() => {
    const now = JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8')).jwt;
    return now && now !== before;
  }, 10_000, 'a new session');
  await until(() => lastStatus(id)?.status === 'online', 10_000, 'online again');
  expect((await call('home', { feed: 'foryou' })).items.length).toBeGreaterThan(0);
});

test('two-factor: a code asked for when none is kept, a wrong one refused; a kept secret makes its own', async () => {
  const t = await add({ instance: fake.url, username: 'tess' }, { password: 'pw-tess' });
  const st = await until(() => lastStatus(t)?.attention?.kind === 'verify' && lastStatus(t), 10_000, 'asked for a code');
  expect(st.attention).toMatchObject({ message: `${H()} wants a two-factor code: type the code from your authenticator app.`, detail: { code: { length: 6 } } });
  await expect(call('action', { action: 'signIn', args: { code: '000000' } }, t)).rejects.toThrow('did not take the two-factor code');
  fake.validCodes.add('123456');
  expect(await call('action', { action: 'signIn', args: { code: '123 456' } }, t)).toEqual({ signedIn: true });
  await until(() => lastStatus(t)?.status === 'online', 10_000, 'online with a code');

  const secret = totpSecret(TOTP)!;
  for (const dt of [-30_000, 0, 30_000]) fake.validCodes.add(totp(secret, Date.now() + dt));
  const t2 = await add({ instance: fake.url, username: 'tess' }, { password: 'pw-tess', totp: `otpauth://totp/Fake:tess?secret=${TOTP}&issuer=Fake` });
  await until(() => lastStatus(t2)?.status === 'online', 10_000, 'online with a kept secret');
});

test('TOTP as RFC 6238 makes it', () => {
  // RFC 6238's SHA-1 test key, at 59 s: 94287082 → its last six digits.
  const key = new TextEncoder().encode('12345678901234567890');
  expect(totp(key, 59_000)).toBe('287082');
  expect(totp(key, 1111111109_000)).toBe('081804');
  expect(totpSecret('not base32!')).toBeNull();
  expect(totpSecret('jbsw y3dp ehpk 3pxp')).toEqual(totpSecret('JBSWY3DPEHPK3PXP'));
});
