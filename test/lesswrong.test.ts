/**
 * The lesswrong kind over the real wire: a manager with it, accounts added through the page's API, the extractor on a
 * fake ForumMagnum site (extractors/lesswrong/test/fake-lesswrong.ts, invented data), and an app with the hub's chat
 * grant: signing in with a password (a wrong one, then the right one; only the token kept), a pasted login token,
 * notifications as a feed (quiet the first time, live after), history, posts by people you subscribe to, the
 * frontpage feed in incognito mode, post and comment threads, karma votes that keep the rest of your vote, comments,
 * deleting your own, profiles, a session that ends, and none of the calls that mark anything read.
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
import manifest from '../extractors/lesswrong/manifest.ts';
import { OPERATIONS } from '../extractors/lesswrong/src/queries.ts';
import { type FakeLessWrong, startFakeLessWrong } from '../extractors/lesswrong/test/fake-lesswrong.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
let fake: FakeLessWrong;
let m: Manager;
let dir: string;
let hub: AccountsClient;
let id: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const ENV = { DITHER_LESSWRONG_POLL_MS: '200', DITHER_LESSWRONG_BACKOFF_MS: '200', DITHER_LESSWRONG_PACE_MS: '0' };
const saved: Record<string, string | undefined> = {};

const QUINN = 'qqqqqqqqqqqqqqqqq';
const ANN = 'aaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbb';
const TESS = 'ttttttttttttttttt';
const P1 = 'ppppppppppppppp01';
const P2 = 'ppppppppppppppp02';
const P3 = 'ppppppppppppppp03';
const P4 = 'ppppppppppppppp04';
const SF = 'sssssssssssssss01';
const C = (n: number) => `ccccccccccccccc0${n}`;
/** Everything the site has that marks something read or records a view: the extractor sends none of them. */
const NEVER = ['MarkAllNotificationsAsRead', 'markAsReadOrUnread', 'markPostCommentsRead', 'increasePostViewCount', 'analyticsEvent', 'createLWEvent', 'updateContinueReading', 'createUltraFeedEvent', 'updateUltraFeedEvent', 'karmaChangesChecked', 'updateUser', 'updateNotification', 'UltraFeedSubscriptions', 'markConversationRead'];

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
const calls = (op: string) => fake.calls.filter((c) => c.operationName === op);
const add = async (config: Record<string, unknown>, secret: Record<string, unknown>) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { origin: m.url }, body: JSON.stringify({ kind: 'lesswrong', label: 'LessWrong', config, secret }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
};
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const secretOf = (acc: string) => JSON.parse(readFileSync(join(m.store.account(acc)!.dir, 'secret.json'), 'utf8'));

beforeAll(async () => {
  for (const [key, v] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = v;
  }
  fake = startFakeLessWrong();
  fake.users.set(QUINN, { _id: QUINN, displayName: 'Quinn', slug: 'quinn', username: 'quinn', email: 'quinn@example.com', password: 'pw-quinn', subscribedTo: [ANN], ultraFeedSettings: { resolverSettings: { incognitoMode: false, sourceWeights: { 'recombee-lesswrong-custom': 3 } } } });
  fake.users.set(ANN, { _id: ANN, displayName: 'Ann Lee', slug: 'ann-lee', karma: 1234, htmlBio: '<p>Writes about <b>priors</b>.</p>' });
  fake.users.set(BOB, { _id: BOB, displayName: 'Bob Stone', slug: 'bob-stone' });
  fake.users.set(TESS, { _id: TESS, displayName: 'Tess', slug: 'tess' });
  fake.posts.set(P1, { _id: P1, title: 'Hello world', slug: 'hello-world', userId: QUINN, postedAt: ago(300), baseScore: 10, html: '<p>Let <span class="mjx-chtml"><span class="mjx-math" aria-label="x^2"><span>x2</span></span></span> be small.<span class="footnote-reference" id="fnref1"><sup><a href="#fn1">[1]</a></sup></span></p><ol class="footnotes"><li class="footnote-item" id="fn1"><span class="footnote-back-link"><sup><strong><a href="#fnref1">^</a></strong></sup></span><div class="footnote-content"><p>A note.</p></div></li></ol>' });
  fake.posts.set(P2, { _id: P2, title: 'Notes on priors', slug: 'notes-on-priors', userId: ANN, postedAt: ago(50), baseScore: 25, url: 'https://example.com/priors', html: '<p>Priors <em>matter</em> a lot.</p>' });
  fake.posts.set(P3, { _id: P3, title: 'An older one', slug: 'an-older-one', userId: ANN, postedAt: ago(500), baseScore: 3, html: '<p>Old words.</p>' });
  fake.posts.set(P4, { _id: P4, title: 'Not followed', slug: 'not-followed', userId: BOB, postedAt: ago(20), html: '<p>Bob writes.</p>' });
  fake.posts.set(SF, { _id: SF, title: "Ann Lee's Shortform", slug: 'ann-lee-s-shortform', userId: ANN, postedAt: ago(900), shortform: true, html: '' });
  fake.comments.set(C(1), { _id: C(1), postId: P1, userId: ANN, postedAt: ago(90), html: '<p>Welcome! A <a href="https://example.com/x">link</a>.</p>', baseScore: 5 });
  fake.comments.set(C(2), { _id: C(2), postId: P1, userId: QUINN, postedAt: ago(80), html: '<p>Thanks</p>', parentCommentId: C(1), baseScore: 2 });
  fake.comments.set(C(3), { _id: C(3), postId: P1, userId: BOB, postedAt: ago(70), html: '<p>Same here</p>', parentCommentId: C(2), baseScore: 1 });
  fake.comments.set(C(4), { _id: C(4), postId: P2, userId: BOB, postedAt: ago(60), html: '<p>As Quinn said</p>' });
  fake.comments.set(C(5), { _id: C(5), postId: SF, userId: ANN, postedAt: ago(45), html: '<p>A quick thought.</p>', shortform: true });
  fake.comments.set(C(6), { _id: C(6), postId: SF, userId: BOB, postedAt: ago(44), html: '<p>Agreed.</p>', shortform: true, parentCommentId: C(5) });
  fake.notifications.push(
    { _id: 'nnnnnnnnnnnnnnn01', userId: QUINN, documentId: C(1), documentType: 'comment', createdAt: ago(90), type: 'newReplyToYou', message: 'Ann Lee replied to your post "Hello world"' },
    { _id: 'nnnnnnnnnnnnnnn02', userId: QUINN, documentId: C(3), documentType: 'comment', createdAt: ago(70), type: 'newReplyToYou', message: 'Bob Stone replied to your comment on "Hello world"' },
    { _id: 'nnnnnnnnnnnnnnn03', userId: QUINN, documentId: C(4), documentType: 'comment', createdAt: ago(60), type: 'newMention', message: 'Bob Stone mentioned you' },
    { _id: 'nnnnnnnnnnnnnnn04', userId: QUINN, documentId: P2, documentType: 'post', createdAt: ago(50), type: 'newPost', message: 'Ann Lee has created a new post: Notes on priors' },
    { _id: 'nnnnnnnnnnnnnnn05', userId: QUINN, createdAt: ago(40), type: 'karmaPowersGained', message: 'You can now vote strongly', link: '/faq' },
  );
  fake.ultra = [
    { type: 'feedPost', postId: P4 },
    { type: 'feedCommentThread', commentIds: [C(5), C(6)] },
    { type: 'feedCommentThread', commentIds: [C(1), C(2)] },
  ];
  dir = mkdtempSync(join(tmpdir(), 'dacc-lesswrong-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['lesswrong', kindOf(manifest, join(ROOT, 'extractors/lesswrong'))]]) });
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

test('signing in: a wrong password is forgotten and asked for again; the right one leaves only the token', async () => {
  const kinds = ((await (await fetch(`${m.url}/api/state`, { headers: { origin: m.url } })).json()) as any).kinds;
  expect(kinds.find((x: any) => x.kind === 'lesswrong').add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['username', false, true],
    ['password', true, true],
    ['token', true, true],
    ['site', false, true],
  ]);
  id = await add({ site: `${fake.url}/`, username: 'quinn@example.com' }, { password: 'wrong' });
  const st = await until(() => lastStatus(id)?.status === 'attention' && lastStatus(id), 10_000, 'asked for the password');
  expect(st.attention.kind).toBe('login');
  expect(st.attention.message).toContain('refused the username or password');
  expect(secretOf(id)).toEqual({});
  await expect(call('action', { action: 'relogin', args: { password: 'still-wrong' } })).rejects.toThrow('refused the username or password');
  expect(await call('action', { action: 'relogin', args: { password: 'pw-quinn' } })).toEqual({ signedIn: true });
  const online = await until(() => lastStatus(id)?.status === 'online' && lastStatus(id), 10_000, 'online');
  expect(online.self).toEqual({ nativeId: QUINN, handle: 'quinn', displayName: 'Quinn', isSelf: true });
  expect(evs(id, 'hello')[0]).toMatchObject({ network: 'lesswrong', capabilities: ['history', 'profile', 'posts', 'postActions', 'publish', 'home', 'unpublish'] });
  const secret = secretOf(id);
  expect(Object.keys(secret)).toEqual(['token']);
  // The token went to the site as its header, and nowhere else.
  expect(calls('Me').at(-1)!.token).toBe(secret.token);
  expect(calls('Login').every((c) => c.token === null)).toBe(true);
  const accDir = m.store.account(id)!.dir;
  const detail = await (await fetch(`${m.url}/api/accounts/${id}`, { headers: { origin: m.url } })).json();
  const elsewhere = JSON.stringify(detail) + JSON.stringify(evs(id, 'status')) + readFileSync(join(accDir, 'adapter.log'), 'utf8') + readFileSync(join(accDir, 'state.json'), 'utf8');
  expect(elsewhere).not.toContain(secret.token);
  expect(elsewhere).not.toContain('pw-quinn');
});

test('the feed: replies, a mention, a new post by someone you follow and a notice from the site, quietly the first time', async () => {
  const feedId = `feed:${QUINN}`;
  await until(() => message(id, 'other:nnnnnnnnnnnnnnn05:-'), 10_000, 'the first read');
  expect(evs(id, 'conversation').find((e) => e.conversation.nativeId === feedId)!.conversation).toEqual({ nativeId: feedId, shape: 'channel', variant: 'feed', name: 'Notifications' });
  const toPost = message(id, `reply:c-${C(1)}`)!;
  expect(toPost.live).toBe(false);
  expect(toPost.message).toMatchObject({ conversation: feedId, author: ANN, kind: 'text', body: 'Welcome! A link.', mentionsSelf: true });
  expect(toPost.message.extra.feed).toMatchObject({ type: 'reply', theirs: { id: `c-${C(1)}`, replyTo: { id: `p-${P1}` }, root: `p-${P1}` }, post: { id: `p-${P1}`, title: 'Hello world', author: QUINN } });
  const toComment = message(id, `reply:c-${C(3)}`)!;
  expect(toComment.message.author).toBe(BOB);
  expect(toComment.message.extra.feed.theirs.replyTo).toEqual({ id: `c-${C(2)}` });
  expect(toComment.message.extra.feed.post).toBeUndefined();
  expect(message(id, `mention:c-${C(4)}`)!.message.extra.feed).toMatchObject({ type: 'mention', theirs: { id: `c-${C(4)}`, author: BOB } });
  const newPost = message(id, `other:nnnnnnnnnnnnnnn04:${ANN}`)!;
  expect(newPost.message).toMatchObject({ author: ANN, kind: 'system', body: 'Ann Lee has created a new post: Notes on priors' });
  expect(newPost.message.extra.feed).toMatchObject({ type: 'other', text: 'Ann Lee has created a new post: Notes on priors', theirs: { id: `p-${P2}`, title: 'Notes on priors' } });
  const notice = message(id, 'other:nnnnnnnnnnnnnnn05:-')!;
  expect(notice.message).toMatchObject({ author: 'lesswrong', body: 'You can now vote strongly' });
  expect(notice.message.extra.feed).toEqual({ type: 'other', text: 'You can now vote strongly', url: `${fake.url}/faq` });
  expect(evs(id, 'identity').find((e) => e.identity.nativeId === 'lesswrong')!.identity).toMatchObject({ isBot: true });
  expect(evs(id, 'message').map((e) => e.message.nativeId)).toEqual([`reply:c-${C(1)}`, `reply:c-${C(3)}`, `mention:c-${C(4)}`, `other:nnnnnnnnnnnnnnn04:${ANN}`, 'other:nnnnnnnnnnnnnnn05:-']);
  // One request for the posts and comments of the whole page.
  expect(calls('Docs')[0]!.variables).toMatchObject({ postIds: [P2], commentIds: [C(1), C(3), C(4)] });
});

test('a new reply comes live with the next read, once', async () => {
  fake.comments.set(C(7), { _id: C(7), postId: P1, userId: BOB, postedAt: new Date().toISOString(), html: '<p>One more</p>' });
  fake.notifications.push({ _id: 'nnnnnnnnnnnnnnn07', userId: QUINN, documentId: C(7), documentType: 'comment', createdAt: new Date().toISOString(), type: 'newReplyToYou', message: 'Bob Stone replied to your post' });
  const e = await until(() => message(id, `reply:c-${C(7)}`), 10_000, 'the live reply');
  expect(e.live).toBe(true);
  const reads = calls('Notifications').length;
  await until(() => calls('Notifications').length >= reads + 2, 10_000, 'two more reads');
  expect(evs(id, 'message').filter((x) => x.message.nativeId === `reply:c-${C(7)}`).length).toBe(1);
});

test('history reads the notifications a page at a time', async () => {
  const r = await call('history', { conversation: `feed:${QUINN}`, limit: 4 });
  expect(r).toMatchObject({ count: 4, done: false, next: '4' });
  const r2 = await call('history', { conversation: `feed:${QUINN}`, limit: 4, cursor: r.next });
  expect(r2).toMatchObject({ count: 2, done: true });
});

test('home following: posts by the people you subscribe to, newest first, paged by asking for more', async () => {
  const first = await call('home', { feed: 'following', count: 1 });
  expect(first.items.map((i: any) => i.post.id)).toEqual([`p-${P2}`]);
  expect(first.more).toBe('n:1');
  expect(first.items[0].post).toEqual({
    id: `p-${P2}`,
    url: `${fake.url}/posts/${P2}/notes-on-priors`,
    ts: expect.any(Number),
    author: ANN,
    text: 'https://example.com/priors\n\nPriors matter a lot.',
    title: 'Notes on priors',
    counts: { likes: 25, replies: 1 },
    root: `p-${P2}`,
    viewer: { liked: false },
  });
  const next = await call('home', { feed: 'following', count: 1, cursor: first.more });
  expect(next.items.map((i: any) => i.post.id)).toEqual([`p-${P3}`]);
  expect(calls('Subscribed').at(-1)!.variables).toEqual({ limit: 2 });
  const last = await call('home', { feed: 'following', count: 1, cursor: next.more });
  expect(last).toMatchObject({ items: [], more: null });
  expect(evs(id, 'identity').some((e) => e.identity.nativeId === ANN && e.identity.handle === 'ann-lee' && e.identity.displayName === 'Ann Lee')).toBe(true);
});

test('home foryou: the frontpage feed in incognito mode, your own settings kept; quick takes and comment threads', async () => {
  const page = await call('home', { feed: 'foryou', count: 2 });
  expect(fake.served).toBe(0);
  const asked = calls('UltraFeed').at(-1)!.variables;
  expect(JSON.parse(asked.settings)).toEqual({ incognitoMode: true, sourceWeights: { 'recombee-lesswrong-custom': 3 } });
  expect(page.items.map((i: any) => i.post.id)).toEqual([`p-${P4}`, `c-${C(6)}`]);
  expect(page.items[1]).toMatchObject({ reason: { text: 'Quick take', kind: 'other' }, above: [{ id: `c-${C(5)}`, root: `c-${C(5)}` }], post: { root: `c-${C(5)}`, replyTo: { id: `c-${C(5)}` } } });
  expect(page.items[1].above[0].replyTo).toBeUndefined();
  expect(page.more).toBe(`u:${asked.sessionId}:2`);
  const next = await call('home', { feed: 'foryou', count: 2, cursor: page.more });
  expect(calls('UltraFeed').at(-1)!.variables).toMatchObject({ sessionId: asked.sessionId, offset: 2 });
  expect(next.items[0]).toMatchObject({ post: { id: `c-${C(2)}` }, reason: { text: 'On “Hello world”', kind: 'reply' }, above: [{ id: `c-${C(1)}` }] });
});

test("a post's thread: its whole body as Markdown, its comments as chains; a comment's with what is above it", async () => {
  const t = await call('post', { post: `p-${P1}` });
  expect(t.focal).toMatchObject({ id: `p-${P1}`, title: 'Hello world', author: QUINN, text: 'Let $x^2$ be small.[1]\n\n1. A note.' });
  expect(t.focal.article).toBe(`Let $x^2$ be small.[\\[1\\]](${fake.url}/posts/${P1}/hello-world#fn1)\n\n1. A note.`);
  expect(t.ancestors).toEqual([]);
  expect(t.replies.map((ch: any[]) => ch.map((p) => p.id))).toEqual([[`c-${C(1)}`, `c-${C(2)}`, `c-${C(3)}`], [`c-${C(7)}`]]);
  expect(t.replies.flat().every((p: any) => isPostId(p.id) && isPostId(p.replyTo.id))).toBe(true);
  expect(t.more).toBeNull();
  expect(calls('Post').at(-1)!.variables).toMatchObject({ postId: P1, withPost: true, offset: 0 });
  const c = await call('post', { post: `c-${C(2)}` });
  expect(c.focal).toMatchObject({ id: `c-${C(2)}`, text: 'Thanks', replyTo: { id: `c-${C(1)}` }, root: `p-${P1}` });
  expect(c.ancestors.map((p: any) => p.id)).toEqual([`p-${P1}`, `c-${C(1)}`]);
  expect(c.replies.map((ch: any[]) => ch.map((p) => p.id))).toEqual([[`c-${C(3)}`]]);
  // A quick take has no post above it.
  const q = await call('post', { post: `c-${C(6)}` });
  expect(q.ancestors.map((p: any) => p.id)).toEqual([`c-${C(5)}`]);
  await expect(call('post', { post: 'p-nonexistent00001' })).rejects.toThrow('no such post');
  await expect(call('post', { post: 'x1' })).rejects.toThrow('not a');
});

test('karma votes: a like is a small upvote, unlike takes it back, and your agreement vote stays; no reposts', async () => {
  fake.votes.set(`${QUINN}:${P2}`, { voteType: 'neutral', extendedVote: { agreement: 'smallUpvote' } });
  expect(await call('postAct', { post: `p-${P2}`, act: 'like' })).toEqual({ liked: true });
  expect(calls('VotePost').at(-1)!.variables).toEqual({ documentId: P2, voteType: 'smallUpvote', extendedVote: { agreement: 'smallUpvote' } });
  expect(fake.votes.get(`${QUINN}:${P2}`)).toEqual({ voteType: 'smallUpvote', extendedVote: { agreement: 'smallUpvote' } });
  expect(await call('postAct', { post: `p-${P2}`, act: 'unlike' })).toEqual({ liked: false });
  expect(fake.votes.get(`${QUINN}:${P2}`)).toEqual({ voteType: 'neutral', extendedVote: { agreement: 'smallUpvote' } });
  // A strong upvote is a like already: nothing is sent.
  fake.votes.set(`${QUINN}:${C(1)}`, { voteType: 'bigUpvote', extendedVote: null });
  const writes = calls('VoteComment').length;
  expect(await call('postAct', { post: `c-${C(1)}`, act: 'like' })).toEqual({ liked: true });
  expect(calls('VoteComment').length).toBe(writes);
  expect(await call('postAct', { post: `c-${C(4)}`, act: 'like' })).toEqual({ liked: true });
  expect(calls('VoteComment').at(-1)!.variables).toEqual({ documentId: C(4), voteType: 'smallUpvote', extendedVote: null });
  await expect(call('postAct', { post: `p-${P2}`, act: 'repost' })).rejects.toThrow('no reposts');
});

test('comments on a post and answers to a comment, as Markdown; a new post and the rest refused', async () => {
  const top = await call('publish', { text: 'Nice *post*', replyTo: `p-${P2}` });
  expect(calls('NewComment').at(-1)!.variables).toEqual({ data: { postId: P2, contents: { originalContents: { type: 'markdown', data: 'Nice *post*' } } } });
  expect(top).toMatchObject({ author: QUINN, replyTo: { id: `p-${P2}` }, root: `p-${P2}`, text: 'Nice *post*' });
  expect(isPostId(top.id)).toBe(true);
  const nested = await call('publish', { text: 'Agreed', replyTo: `c-${C(4)}` });
  expect(calls('NewComment').at(-1)!.variables.data).toMatchObject({ postId: P2, parentCommentId: C(4) });
  expect(nested.replyTo).toEqual({ id: `c-${C(4)}` });
  await expect(call('publish', { text: 'A new post', title: 'Title' })).rejects.toThrow('written on the site');
  await expect(call('publish', { text: 'x' })).rejects.toThrow('written on the site');
  await expect(call('publish', { text: 'x', quote: `p-${P1}`, replyTo: `p-${P1}` })).rejects.toThrow('no quote');
  await expect(call('publish', { text: 'x', replyTo: `p-${P1}`, warning: 'cw' })).rejects.toThrow('no content warnings');
  await expect(call('publish', { text: '  ', replyTo: `p-${P1}` })).rejects.toThrow('nothing to post');
});

test('deleting your own comment; one with replies, someone else\'s, and a post are refused', async () => {
  const c = await call('publish', { text: 'oops', replyTo: `p-${P1}` });
  expect(await call('unpublish', { post: c.id })).toEqual({ deleted: true });
  expect(calls('DeleteComment').at(-1)!.variables).toEqual({ commentId: c.id.slice(2) });
  expect(fake.comments.get(c.id.slice(2))!.deleted).toBe(true);
  expect(await call('unpublish', { post: c.id })).toEqual({ deleted: true });
  expect(await call('unpublish', { post: 'c-nonexistent00001' })).toEqual({ deleted: true });
  await expect(call('unpublish', { post: `c-${C(2)}` })).rejects.toThrow('has replies');
  await expect(call('unpublish', { post: `c-${C(1)}` })).rejects.toThrow('not yours');
  await expect(call('unpublish', { post: `p-${P1}` })).rejects.toThrow('deleted on the site');
});

test('profiles by id and by slug: posts and comments newest first, karma and bio', async () => {
  const ann = await call('profile', { who: ANN });
  expect(ann).toMatchObject({ displayName: 'Ann Lee', handle: 'ann-lee', bio: 'Writes about priors.', counts: { posts: 3 } });
  expect(ann.facts).toContainEqual({ label: 'Karma', value: '1234' });
  expect(ann.links).toEqual([{ label: expect.any(String), value: 'ann-lee', url: `${fake.url}/users/ann-lee` }]);
  expect(ann.posts.map((p: any) => p.id)).toEqual([`c-${C(5)}`, `p-${P2}`, `c-${C(1)}`, `p-${P3}`]);
  const bySlug = await call('profile', { who: 'bob-stone' });
  expect(bySlug.displayName).toBe('Bob Stone');
  await expect(call('profile', { who: 'nobody-here' })).rejects.toThrow('nobody called');
});

test('a token the site stops taking: it asks for the password again, and it signs in with it', async () => {
  const seen = evs(id, 'status').length;
  fake.endSessions();
  const st = await until(() => evs(id, 'status').slice(seen).find((e) => e.status === 'attention'), 10_000, 'asked to sign in again');
  expect(st.attention).toMatchObject({ kind: 'login', message: expect.stringContaining('type your password') });
  expect(secretOf(id)).toEqual({});
  await expect(call('home', { feed: 'following' })).rejects.toThrow('Not signed in');
  expect(await call('action', { action: 'relogin', args: { password: 'pw-quinn' } })).toEqual({ signedIn: true });
  expect((await call('home', { feed: 'following' })).items.length).toBeGreaterThan(0);
});

test('an account added with a pasted login token, and a new token pasted into the password box', async () => {
  fake.addSession('tess-token-aaaaaaaaaaaaaaaa', TESS);
  const t = await add({ site: fake.url }, { token: 'tess-token-aaaaaaaaaaaaaaaa' });
  const online = await until(() => lastStatus(t)?.status === 'online' && lastStatus(t), 10_000, 'online with a token');
  expect(online.self).toMatchObject({ nativeId: TESS, handle: 'tess' });
  fake.endSessions();
  const st = await until(() => lastStatus(t)?.status === 'attention' && lastStatus(t), 10_000, 'asked for a new token');
  expect(st.attention.message).toContain('paste a new login token');
  await expect(call('action', { action: 'relogin', args: { password: 'not a token' } }, t)).rejects.toThrow('not a login token');
  fake.addSession('tess-token-bbbbbbbbbbbbbbbb', TESS);
  expect(await call('action', { action: 'relogin', args: { password: 'tess-token-bbbbbbbbbbbbbbbb' } }, t)).toEqual({ signedIn: true });
  expect(secretOf(t)).toEqual({ token: 'tess-token-bbbbbbbbbbbbbbbb' });
});

test('it sends only its own named operations, and none that mark anything read or record a view', () => {
  const ops = new Set(fake.calls.map((c) => c.operationName));
  for (const op of ops) expect(OPERATIONS as readonly string[]).toContain(op);
  for (const c of fake.calls) for (const word of NEVER) expect(c.query).not.toContain(word);
  expect(fake.served).toBe(0);
});
