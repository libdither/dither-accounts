/** The lesswrong kind's mapping (ids, posts, comments, threads, notifications, the feed) and its GraphQL client, without a manager. Invented data only. */
import { afterAll, expect, test } from 'bun:test';
import { isPostId } from '@dither-chat/protocol';
import { Gql, GqlError } from '../src/gql.ts';
import { chainsOf, commentOf, docsToFetch, feedEntryOf, homeItemOf, parseKey, postOf, siteName } from '../src/map.ts';

const ctx = { site: 'https://forum.example', self: 'qqqqqqqqqqqqqqqqq' };
const ANN = { _id: 'aaaaaaaaaaaaaaaaa', displayName: 'Ann Lee', slug: 'ann-lee' };
const post = (o: Record<string, unknown> = {}) => ({ _id: 'ppppppppppppppp01', title: 'On priors', slug: 'on-priors', postedAt: '2026-01-02T03:04:05.000Z', baseScore: 12, commentCount: 3, currentUserVote: null, user: ANN, contents: { html: '<p>Body.</p>' }, ...o });
const comment = (id: string, o: Record<string, unknown> = {}) => ({ _id: id, postId: 'ppppppppppppppp01', parentCommentId: null, topLevelCommentId: null, postedAt: '2026-01-02T04:00:00.000Z', baseScore: 2, directChildrenCount: 0, deleted: false, user: ANN, contents: { html: '<p>Words.</p>' }, ...o });

test('ids: p-<_id> for posts and c-<_id> for comments, as the hub takes them', () => {
  expect(parseKey('p-ppppppppppppppp01')).toEqual({ kind: 'post', id: 'ppppppppppppppp01' });
  expect(parseKey('c-ccccccccccccccc01')).toEqual({ kind: 'comment', id: 'ccccccccccccccc01' });
  expect(parseKey('ppppppppppppppp01')).toBeNull();
  expect(parseKey('p-has space')).toBeNull();
  expect(parseKey('x-ppppppppppppppp01')).toBeNull();
  const people = new Map();
  expect(isPostId(postOf(post(), ctx, people).id)).toBe(true);
  expect(isPostId(commentOf(comment('ccccccccccccccc01'), ctx, people).id)).toBe(true);
});

test('a post: title, karma as likes, comments as replies, your upvote of either strength as liked, a link first', () => {
  const people = new Map();
  const p = postOf(post({ url: 'https://example.com/a', currentUserVote: 'bigUpvote', pageUrl: 'https://forum.example/posts/ppppppppppppppp01/on-priors' }), ctx, people);
  expect(p).toEqual({ id: 'p-ppppppppppppppp01', url: 'https://forum.example/posts/ppppppppppppppp01/on-priors', ts: Date.parse('2026-01-02T03:04:05.000Z'), author: ANN._id, text: 'https://example.com/a\n\nBody.', title: 'On priors', counts: { likes: 12, replies: 3 }, root: 'p-ppppppppppppppp01', viewer: { liked: true } });
  expect(people.get(ANN._id)).toEqual({ nativeId: ANN._id, handle: 'ann-lee', displayName: 'Ann Lee' });
  expect(postOf(post({ currentUserVote: 'smallDownvote' }), ctx, people).viewer).toEqual({ liked: false });
  // Without pageUrl, the site's own address; a hidden author is none.
  expect(postOf(post({ pageUrl: undefined, user: null }), ctx, people)).toMatchObject({ url: 'https://forum.example/posts/ppppppppppppppp01/on-priors' });
  expect(postOf(post({ user: null }), ctx, people).author).toBeUndefined();
});

test("a post's thread carries its whole body as Markdown: display math, footnotes without their back links, relative links made whole", () => {
  const html =
    '<h2>Setup</h2><p>See <a href="/posts/ppppppppppppppp02/other">this</a>.<sup><a href="#fn1">[1]</a></sup></p><span class="mjpage mjpage__block"><span class="mjx-chtml MJXc-display"><span class="mjx-math" aria-label="\\sum_i p_i = 1"><span aria-hidden="true">∑</span></span></span></span><ol class="footnotes"><li class="footnote-item"><span class="footnote-back-link"><sup><a href="#fnref1">^</a></sup></span><div class="footnote-content"><p>It costs $5.</p></div></li></ol>';
  const p = postOf(post({ contents: { html }, pageUrl: 'https://forum.example/posts/ppppppppppppppp01/on-priors' }), ctx, new Map(), { article: true });
  expect(p.article).toBe('## Setup\n\nSee [this](https://forum.example/posts/ppppppppppppppp02/other).[\\[1\\]](https://forum.example/posts/ppppppppppppppp01/on-priors#fn1)\n\n$$\n\\sum_i p_i = 1\n$$\n\n1. It costs \\$5.');
  expect(p.text).toBe('Setup\n\nSee this.[1]\n\n$$\n\\sum_i p_i = 1\n$$\n\n1. It costs $5.');
  // A card has no article.
  expect(postOf(post({ contents: { html } }), ctx, new Map()).article).toBeUndefined();
});

test('comments answer their parent or the post; a quick take answers nothing and roots its own thread', () => {
  const people = new Map();
  expect(commentOf(comment('ccccccccccccccc01'), ctx, people)).toMatchObject({ replyTo: { id: 'p-ppppppppppppppp01' }, root: 'p-ppppppppppppppp01', counts: { likes: 2, replies: 0 }, text: 'Words.' });
  expect(commentOf(comment('ccccccccccccccc02', { parentCommentId: 'ccccccccccccccc01', topLevelCommentId: 'ccccccccccccccc01' }), ctx, people).replyTo).toEqual({ id: 'c-ccccccccccccccc01' });
  const quick = commentOf(comment('ccccccccccccccc03', { shortform: true }), ctx, people);
  expect(quick.replyTo).toBeUndefined();
  expect(quick.root).toBe('c-ccccccccccccccc03');
  const under = commentOf(comment('ccccccccccccccc04', { shortform: true, parentCommentId: 'ccccccccccccccc03', topLevelCommentId: 'ccccccccccccccc03' }), ctx, people);
  expect(under).toMatchObject({ replyTo: { id: 'c-ccccccccccccccc03' }, root: 'c-ccccccccccccccc03' });
  expect(commentOf(comment('ccccccccccccccc05', { deleted: true }), ctx, people).text).toBe('[deleted]');
  expect(commentOf(comment('ccccccccccccccc06', { retracted: true }), ctx, people).warning).toBe('Retracted by its author');
  // Long comments come whole.
  const long = `<p>${'word '.repeat(3000)}</p>`;
  expect(commentOf(comment('ccccccccccccccc07', { contents: { html: long } }), ctx, people).text.length).toBeGreaterThan(14_000);
});

test('chains: one per top-level comment, depth first in the given order; a comment whose parent is on another page starts its own', () => {
  const list = [comment('ccccccccccccccc01'), comment('ccccccccccccccc05', { parentCommentId: 'ccccccccccccccc09' }), comment('ccccccccccccccc02', { parentCommentId: 'ccccccccccccccc01' }), comment('ccccccccccccccc03'), comment('ccccccccccccccc04', { parentCommentId: 'ccccccccccccccc02' })];
  const ids = (chains: { id: string }[][]) => chains.map((c) => c.map((p) => p.id.slice(-2)));
  expect(ids(chainsOf(list, { kind: 'post' }, (c) => commentOf(c, ctx, new Map())))).toEqual([['01', '02', '04'], ['05'], ['03']]);
  expect(ids(chainsOf(list, { kind: 'comment', id: 'ccccccccccccccc01' }, (c) => commentOf(c, ctx, new Map())))).toEqual([['02', '04']]);
});

test('notifications: a reply to your post carries it, a comment gone is the site\'s words, one request per page of documents', () => {
  const docs = { posts: new Map(), comments: new Map([['ccccccccccccccc01', comment('ccccccccccccccc01', { post: { _id: 'ppppppppppppppp01', title: 'Mine', userId: ctx.self } })]]) };
  const reply = feedEntryOf({ _id: 'nnnnnnnnnnnnnnn01', documentId: 'ccccccccccccccc01', documentType: 'comment', type: 'newReplyToYou', createdAt: '2026-01-02T05:00:00.000Z', message: 'Ann Lee replied' }, docs, ctx)!;
  expect(reply.message).toMatchObject({ nativeId: 'reply:c-ccccccccccccccc01', conversation: `feed:${ctx.self}`, author: ANN._id, kind: 'text', mentionsSelf: true, ts: Date.parse('2026-01-02T05:00:00.000Z') });
  expect(reply.message.extra!.feed).toMatchObject({ type: 'reply', post: { id: 'p-ppppppppppppppp01', title: 'Mine', author: ctx.self } });
  const gone = feedEntryOf({ _id: 'nnnnnnnnnnnnnnn02', documentId: 'ccccccccccccccc09', documentType: 'comment', type: 'newReplyToYou', createdAt: '2026-01-02T05:00:00.000Z', message: 'Bob Stone replied' }, docs, ctx)!;
  expect(gone.message).toMatchObject({ nativeId: 'other:nnnnnnnnnnnnnnn02:-', author: 'lesswrong', kind: 'system', body: 'Bob Stone replied' });
  expect(gone.people).toEqual([{ nativeId: 'lesswrong', displayName: 'forum.example', isBot: true }]);
  expect(feedEntryOf({ _id: 'nnnnnnnnnnnnnnn03', deleted: true }, docs, ctx)).toBeNull();
  expect(docsToFetch([{ documentId: 'x1', documentType: 'post' }, { documentId: 'x1', documentType: 'post' }, { documentId: 'y1', documentType: 'comment' }, { documentId: 'z1', documentType: 'message' }, { documentId: 'w1', documentType: 'comment', deleted: true }])).toEqual({ postIds: ['x1'], commentIds: ['y1'] });
});

test('UltraFeed entries as home items; anything else is left out', () => {
  const people = new Map();
  expect(homeItemOf({ type: 'feedSpotlight', feedSpotlight: { post: post() } }, ctx, people)).toMatchObject({ post: { id: 'p-ppppppppppppppp01' }, reason: { text: 'Spotlight', kind: 'pinned' } });
  const thread = homeItemOf({ type: 'feedCommentThread', feedCommentThread: { post: post(), comments: [comment('ccccccccccccccc01'), comment('ccccccccccccccc02', { parentCommentId: 'ccccccccccccccc01' })] } }, ctx, people)!;
  expect(thread.post.id).toBe('c-ccccccccccccccc02');
  expect(thread.above!.map((p) => p.id)).toEqual(['c-ccccccccccccccc01']);
  expect(thread.reason).toEqual({ text: 'On “On priors”', kind: 'reply' });
  expect(homeItemOf({ type: 'feedSubscriptionSuggestions' }, ctx, people)).toBeNull();
  expect(homeItemOf({ type: 'feedCommentThread', feedCommentThread: { comments: [] } }, ctx, people)).toBeNull();
});

test('site names', () => {
  expect(siteName('https://www.lesswrong.com')).toBe('LessWrong');
  expect(siteName('https://forum.effectivealtruism.org')).toBe('EA Forum');
  expect(siteName('https://www.alignmentforum.org')).toBe('AI Alignment Forum');
  expect(siteName('http://127.0.0.1:9')).toBe('127.0.0.1:9');
});

// ---------------------------------------------------------------- the client

const seen: { headers: Headers; body: any }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const body: any = await req.json();
    seen.push({ headers: req.headers, body });
    const j = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
    switch (body.operationName) {
      case 'Ok':
        return j({ data: { ok: true } });
      case 'Missing':
        return j({ errors: [{ message: 'app.missing_document', extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at secret place'] } }], data: { post: null } });
      case 'SignedOut':
        return j({ errors: [{ message: 'Error casting vote: Not logged in.' }], data: null });
      case 'Refused':
        return j({ errors: [{ message: 'Incorrect password.' }], data: null });
      case 'Busy':
        return j({ errors: [{ message: 'slow down' }] }, 429, { 'retry-after': '30' });
      case 'Moved':
        return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/graphql' } });
      default:
        return new Response('<html>oops</html>', { status: 500 });
    }
  },
});
const pace = process.env.DITHER_LESSWRONG_PACE_MS;
afterAll(() => {
  server.stop(true);
  if (pace === undefined) delete process.env.DITHER_LESSWRONG_PACE_MS;
  else process.env.DITHER_LESSWRONG_PACE_MS = pace;
});

test('the client: named operations with the token as the loginToken header (none when signing in), and failures by kind', async () => {
  process.env.DITHER_LESSWRONG_PACE_MS = '0';
  const api = new Gql(`http://127.0.0.1:${server.port}`, () => 'tok-aaaaaaaaaaaaaaaa');
  expect(await api.request('Ok', 'query Ok { ok }', { a: 1 })).toEqual({ ok: true });
  expect(seen.at(-1)!.body).toEqual({ operationName: 'Ok', query: 'query Ok { ok }', variables: { a: 1 } });
  expect(seen.at(-1)!.headers.get('logintoken')).toBe('tok-aaaaaaaaaaaaaaaa');
  await api.request('Ok', 'query Ok { ok }', {}, { anonymous: true });
  expect(seen.at(-1)!.headers.get('logintoken')).toBeNull();
  const fail = async (op: string) => {
    try {
      await api.request(op, `query ${op} { x }`);
    } catch (e) {
      return e as GqlError;
    }
    throw new Error(`${op} did not fail`);
  };
  expect(await fail('Missing')).toMatchObject({ failure: 'missing', status: 404, message: 'app.missing_document' });
  expect(await fail('SignedOut')).toMatchObject({ failure: 'auth', status: 401 });
  expect(await fail('Refused')).toMatchObject({ failure: 'refused', status: 400, message: 'Incorrect password.' });
  expect(await fail('Moved')).toMatchObject({ failure: 'http', status: 502 });
  expect(await fail('Broken')).toMatchObject({ failure: 'http', status: 500 });
  const busy = await fail('Busy');
  expect(busy).toMatchObject({ failure: 'rate', status: 429 });
  expect(busy.retryAt! - Date.now()).toBeGreaterThan(20_000);
  // Until then it waits instead of asking.
  const count = seen.length;
  expect(await fail('Ok')).toMatchObject({ failure: 'rate' });
  expect(seen.length).toBe(count);
});
