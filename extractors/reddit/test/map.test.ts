import { describe, expect, test } from 'bun:test';
import { FeedTracker, LIVE_MS } from '../src/feed.ts';
import {
  ctxOf,
  Drops,
  FEED_CONV,
  feedMessage,
  identityOf,
  mediaUrl,
  mergeNewest,
  ownPicture,
  moreCursor,
  parseCommented,
  parseHome,
  parseInbox,
  parseMoreChildren,
  parseMoreCursor,
  parseOverview,
  parsePost,
  parseSubmitted,
  parseSubscriptions,
  parseSubsCursor,
  parseThread,
  parseUser,
  personAbout,
  REDDIT_ACTOR,
  redditTime,
  siteUrl,
  subredditOf,
  subsChunks,
} from '../src/map.ts';
import { ANN, BEN, CARA, commentPage, gardenThread, inbox, listing, ME, moreChildren, overview, post, SUB, SUB2, t1, t3, user } from './fixtures.ts';

const ctx = () => ctxOf(new Drops());

describe('posts', () => {
  test('a text post: title, subreddit as its place, text, score as likes, comments as replies, your upvote', () => {
    const c = ctx();
    const p = parsePost(post({ id: 'p1', by: ANN, title: 'Tomatoes', text: 'Red **at last**', score: 40, comments: 7, likes: true }), c)!;
    expect(p).toMatchObject({
      id: 't3_p1',
      url: `https://www.reddit.com/r/${SUB.name}/comments/p1/a_title/`,
      author: ANN,
      text: 'Red **at last**',
      title: 'Tomatoes',
      place: { id: SUB.id, name: `r/${SUB.name}`, url: `https://www.reddit.com/r/${SUB.name}/` },
      counts: { likes: 40, replies: 7 },
      viewer: { liked: true },
      root: 't3_p1',
    });
    expect(p.warning).toBeUndefined();
    expect([...c.people]).toEqual([ANN]);
  });
  test('a link post: its words are the link; NSFW and spoiler as the warning; the preview picture', () => {
    const p = parsePost(post({ id: 'p2', link: 'https://example.com/a', nsfw: true, spoiler: true, image: 'https://preview.redd.it/abc.jpg?width=640&amp;s=x' }), ctx())!;
    expect(p.text).toBe('https://example.com/a');
    expect(p.warning).toBe('NSFW, Spoiler');
    expect(p.media).toEqual([{ kind: 'image', url: 'https://preview.redd.it/abc.jpg?width=640&s=x', width: 640, height: 480 }]);
  });
  test('a gallery in its order, with captions; a video as its poster frame', () => {
    const g = parsePost(post({ id: 'p3', gallery: ['https://i.redd.it/a.jpg', 'https://i.redd.it/b.jpg'] }), ctx())!;
    expect(g.media).toEqual([
      { kind: 'image', url: 'https://i.redd.it/a.jpg', width: 800, height: 600, alt: 'the first one' },
      { kind: 'image', url: 'https://i.redd.it/b.jpg', width: 800, height: 600 },
    ]);
    const v = parsePost(post({ id: 'p4', link: 'https://v.redd.it/xyz', video: true, image: 'https://external-preview.redd.it/v.jpg' }), ctx())!;
    expect(v.media?.[0]).toMatchObject({ kind: 'video', url: 'https://external-preview.redd.it/v.jpg' });
  });
  test('a picture from elsewhere is left out and counted; a crosspost quotes its original', () => {
    const c = ctx();
    const p = parsePost(post({ id: 'p5', image: 'https://evil.example/a.jpg', crosspost: post({ id: 'p0', by: CARA, title: 'Original', sub: SUB2 }) }), c)!;
    expect(p.media).toBeUndefined();
    expect(c.drops.summary()).toBe('media.host 1');
    expect(p.quoteOf).toMatchObject({ id: 't3_p0', author: CARA, title: 'Original', place: { name: `r/${SUB2.name}` } });
  });
  test('nobody for [deleted]; dropped without an id or a time', () => {
    const c = ctx();
    expect(parsePost({ ...post({ id: 'p6' }), author: '[deleted]' }, c)!.author).toBeUndefined();
    expect(parsePost({ ...post({ id: 'p7' }), name: 'x', id: 'NOT!' }, c)).toBeNull();
    expect(parsePost({ ...post({ id: 'p8' }), created_utc: 'soon' }, c)).toBeNull();
    expect(Object.fromEntries(c.drops.counts)).toEqual({ 'post.bad-id': 1, 'post.no-time': 1 });
  });
  test('times, links, subreddits and pictures are checked', () => {
    expect(redditTime(1_700_000_000.5)).toBe(1_700_000_000_500);
    expect(redditTime(10)).toBeNull();
    expect(siteUrl('/r/x/comments/a/')).toBe('https://www.reddit.com/r/x/comments/a/');
    expect(siteUrl('https://old.reddit.com/r/x/?a=1')).toBe('https://www.reddit.com/r/x/?a=1');
    expect(siteUrl('https://evil.example/r/x')).toBeNull();
    expect(siteUrl('//evil.example/')).toBeNull();
    expect(mediaUrl('http://i.redd.it/a.jpg')).toBeNull();
    expect(subredditOf('r/rustlang')).toBe('rustlang');
    expect(subredditOf('/r/rustlang/')).toBe('rustlang');
    expect(subredditOf('rust lang')).toBeNull();
  });
});

describe('home', () => {
  test("a front page's posts, with Reddit's after as the cursor; promoted ones left out", () => {
    const c = ctx();
    const page = parseHome(listing([t3({ id: 'a1' }), { kind: 't3', data: { ...post({ id: 'a2' }), promoted: true } }, t3({ id: 'a3', by: BEN })], 't3_a3'), c);
    expect(page.items.map((i) => i.post.id)).toEqual(['t3_a1', 't3_a3']);
    expect(page.more).toBe('t3_a3');
    expect(page.top).toBeNull();
    expect([...c.people].sort()).toEqual([ANN, BEN]);
    expect(parseHome(listing([]), ctx())).toEqual({ items: [], more: null, top: null });
  });
});

describe('threads', () => {
  test("a post's page: each top-level comment a chain with its answers under it, replies counted with the ones not sent", () => {
    const c = ctx();
    const t = parseThread(gardenThread(), 't3_g1', c)!;
    expect(t.thread.focal).toMatchObject({ id: 't3_g1', title: 'Tomatoes, finally', counts: { likes: 40, replies: 9 }, viewer: { liked: true } });
    expect(t.thread.ancestors).toEqual([]);
    expect(t.thread.replies.map((ch) => ch.map((p) => p.id))).toEqual([['t1_c1', 't1_c2', 't1_c3'], ['t1_c4'], ['t1_c5']]);
    const [c1, c2, c3] = t.thread.replies[0]!;
    expect(c1).toMatchObject({ author: ANN, text: 'Which kind are they?', replyTo: { id: 't3_g1' }, root: 't3_g1', counts: { likes: 8, replies: 3 } });
    expect(c2).toMatchObject({ author: ME, replyTo: { id: 't1_c1' }, counts: { replies: 1 } });
    expect(c3!.counts).toEqual({ likes: 3 });
    // "Continue this thread" counts as one more.
    expect(t.thread.replies[2]![0]!.counts).toEqual({ likes: 3, replies: 1 });
    expect(t.thread.more).toBe(moreCursor({ link: 'g1', more: 'c6', offset: 0 }));
    expect([...t.mores.keys()].sort()).toEqual(['c6', 'c9']);
    expect([...c.people].sort()).toEqual([ANN, BEN, CARA, ME].sort());
  });
  test("a comment's page: the post and the comments above it as ancestors, the comment, its answers", () => {
    const t = parseThread(commentPage(), 't1_c2', ctx())!;
    expect(t.thread.ancestors.map((p) => p.id)).toEqual(['t3_g1', 't1_c1']);
    expect(t.thread.focal).toMatchObject({ id: 't1_c2', counts: { replies: 1 } });
    expect(t.thread.replies.map((ch) => ch.map((p) => p.id))).toEqual([['t1_c3']]);
    expect(t.thread.more).toBeNull();
    expect(parseThread(commentPage(), 't1_zz', ctx())).toBeNull();
  });
  test('more comments: flat things put back under their parents, the rest of a long list as the next cursor', () => {
    const cur = { link: 'g1', more: 'c6', offset: 0 };
    const t = parseMoreChildren(moreChildren(), cur, null, ctx());
    expect(t.replies.map((ch) => ch.map((p) => p.id))).toEqual([['t1_c6'], ['t1_c7', 't1_c8']]);
    expect(t.more).toBeNull();
    expect(parseMoreChildren(moreChildren(), cur, 100, ctx()).more).toBe('g1.c6.100');
    expect(() => parseMoreChildren({ json: { errors: [['RATELIMIT', 'you are doing that too much', 'ratelimit']] } }, cur, null, ctx())).toThrow('Reddit said: you are doing that too much');
    expect(parseMoreCursor('g1.c6.100')).toEqual({ link: 'g1', more: 'c6', offset: 100 });
    expect(parseMoreCursor('g1.c6')).toBeNull();
  });
});

describe('the inbox', () => {
  test('post and comment replies as reply, mentions as mention, messages as other with their subject', () => {
    const c = ctx();
    const page = parseInbox(inbox(), c);
    expect(page.entries.map((e) => [e.nativeId, e.type, e.actor, e.kind])).toEqual([
      ['reply:t1_r1', 'reply', ANN, 'text'],
      ['reply:t1_r2', 'reply', BEN, 'text'],
      ['mention:t1_r3', 'mention', CARA, 'text'],
      ['other:t4_m1:' + CARA, 'other', CARA, 'system'],
      ['other:t4_m2:-', 'other', `r/${SUB.name}`, 'system'],
    ]);
    const [r1, r2, r3, m1, m2] = page.entries;
    expect(r1!.item).toMatchObject({ type: 'reply', url: 'https://www.reddit.com/r/gardening/comments/g1/a_title/r1/', text: 'Tomatoes, finally', theirs: { id: 't1_r1', replyTo: { id: 't3_g1' } }, post: { id: 't3_g1', title: 'Tomatoes, finally' } });
    expect(r2!.item.post).toBeUndefined();
    expect(r3!.item.theirs).toMatchObject({ place: { name: `r/${SUB2.name}` } });
    expect(m1).toMatchObject({ body: 'seeds?', item: { type: 'other', text: 'seeds?', theirs: { id: 't4_m1', text: 'Do you have spare seeds?', title: 'seeds?' } } });
    expect(m2!.body).toBe(`Welcome to r/${SUB.name}`);
    expect(feedMessage(r1!)).toMatchObject({ nativeId: 'reply:t1_r1', conversation: FEED_CONV, author: ANN, kind: 'text', body: 'Which kind are they?', mentionsSelf: true });
    expect(feedMessage(m1!).mentionsSelf).toBeUndefined();
    // Never a like: Reddit names no voters.
    expect(page.entries.some((e) => e.type === 'like')).toBe(false);
  });
  test('identities: a person by username, a subreddit by its name, Reddit itself', () => {
    expect(identityOf(ANN, ME)).toEqual({ nativeId: ANN, handle: ANN, displayName: `u/${ANN}` });
    expect(identityOf(ME, ME).isSelf).toBe(true);
    expect(identityOf('r/gardening', ME)).toEqual({ nativeId: 'r/gardening', displayName: 'r/gardening' });
    expect(identityOf(REDDIT_ACTOR, ME)).toEqual({ nativeId: REDDIT_ACTOR, displayName: 'Reddit' });
  });
  test('the tracker: the conversation first, each message once, live only when new and fresh', () => {
    const tr = new FeedTracker();
    const now = Date.now();
    const page = parseInbox(inbox(), ctx());
    const first = tr.page(page.entries, { self: ME, now, backfill: true });
    expect(first[0]).toEqual({ t: 'conversation', conversation: { nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications' } });
    const msgs = first.filter((e) => e.t === 'message') as Extract<(typeof first)[number], { t: 'message' }>[];
    expect(msgs.map((m) => m.message.nativeId)).toEqual(['other:t4_m2:-', 'other:t4_m1:' + CARA, 'mention:t1_r3', 'reply:t1_r2', 'reply:t1_r1']);
    expect(msgs.every((m) => !m.live)).toBe(true);
    expect(tr.page(page.entries, { self: ME, now, backfill: false }).filter((e) => e.t === 'message')).toEqual([]);
    const fresh = { ...page.entries[0]!, nativeId: 'reply:t1_r9', ts: now - 60_000 };
    const old = { ...page.entries[0]!, nativeId: 'reply:t1_r8', ts: now - LIVE_MS - 60_000 };
    const next = tr.page([fresh, old], { self: ME, now, backfill: false }).filter((e) => e.t === 'message') as any[];
    expect(next.map((m) => [m.message.nativeId, m.live])).toEqual([
      ['reply:t1_r8', false],
      ['reply:t1_r9', true],
    ]);
    const again = new FeedTracker(tr.kept());
    expect(again.fresh).toBe(false);
    expect(again.page([fresh], { self: ME, now, backfill: false }).filter((e) => e.t === 'message')).toEqual([]);
  });
});

describe('people', () => {
  test('a profile: karma, cake day, picture, words, and their recent posts and comments', () => {
    const c = ctx();
    const u = parseUser(user(), c)!;
    const posts = parseOverview(overview(), c);
    expect(posts.map((p) => [p.id, p.title])).toEqual([
      ['t1_o1', undefined],
      ['t3_o2', 'My beans'],
    ]);
    expect(personAbout(u, posts)).toEqual({
      displayName: 'Ann Lee',
      handle: ANN,
      avatar: 'https://styles.redditmedia.com/t5_x/styles/profileIcon_a.png?width=256&s=1',
      bio: 'Gardens, mostly.',
      createdAt: Date.UTC(2019, 2, 3, 12),
      links: [{ label: 'Reddit', value: `u/${ANN}`, url: `https://www.reddit.com/user/${ANN}/` }],
      facts: [
        { label: 'Karma', value: '4,600' },
        { label: 'Post karma', value: '1,200' },
        { label: 'Comment karma', value: '3,400' },
        { label: 'Cake day', value: 'March 3, 2019' },
      ],
      posts,
    });
    expect(parseUser({ kind: 't5', data: {} }, c)).toBeNull();
  });
});

describe('writes', () => {
  test("a comment made comes back as Reddit made it; Reddit's refusal in its words", () => {
    const made = parseCommented({ json: { errors: [], data: { things: [t1({ id: 'n1', link: 'g1', parent: 't1_c1', by: ME, body: 'thanks' })] } } }, ctx());
    expect(made).toMatchObject({ id: 't1_n1', author: ME, text: 'thanks', replyTo: { id: 't1_c1' }, root: 't3_g1' });
    expect(() => parseCommented({ json: { errors: [['THREAD_LOCKED', 'that thread is locked', 'parent']] } }, ctx())).toThrow('Reddit said: that thread is locked');
    expect(parseCommented({ json: { errors: [], data: { things: [] } } }, ctx())).toBeNull();
  });
  test("a post submitted: its id and link from Reddit's answer", () => {
    expect(parseSubmitted({ json: { errors: [], data: { url: 'https://www.reddit.com/r/gardening/comments/n2/my_beans/', id: 'n2', name: 't3_n2' } } })).toEqual({ id: 't3_n2', url: 'https://www.reddit.com/r/gardening/comments/n2/my_beans/' });
    expect(() => parseSubmitted({ json: { errors: [['SUBREDDIT_NOEXIST', "that subreddit doesn't exist", 'sr']] } })).toThrow("that subreddit doesn't exist");
  });
});

describe('Following from the subscriptions', () => {
  test('the subscriptions: subreddits and followed people by name, odd ones counted; groups in name order', () => {
    const c = ctx();
    const got = parseSubscriptions(
      listing([
        { kind: 't5', data: { display_name: 'rustlang' } },
        { kind: 't5', data: { display_name: 'u_ann-lee' } },
        { kind: 't5', data: { display_name: 'Gardening' } },
        { kind: 't5', data: { display_name: 'bad name!' } },
      ], 't5_abc'),
      c,
    );
    expect(got).toEqual({ names: ['rustlang', 'u_ann-lee', 'Gardening'], after: 't5_abc' });
    expect(c.drops.summary()).toBe('subs.bad-name 1');
    expect(subsChunks([...got.names, 'rustlang'], 2)).toEqual([['Gardening', 'rustlang'], ['u_ann-lee']]);
  });

  test('pages merged newest first; each group keeps its place, and is done when it has given all', () => {
    const page = (ids: [string, number][], more: string | null) => ({ items: ids.map(([id, agoS]) => parseHome(listing([t3({ id, agoS })]), ctx()).items[0]!), more });
    const first = mergeNewest([page([['a1', 10], ['a2', 40]], 't3_a2'), page([['b1', 20]], null), page([], null)], ['0', '0', '0'], 2);
    expect(first.items.map((i) => i.post.id)).toEqual(['t3_a1', 't3_b1']);
    expect(first.more).toBe('subs~t3_a1.x.x');
    // A group none of whose posts were taken is asked from the same place; an empty page with `after` moves on.
    const second = mergeNewest([page([['a2', 40]], null), null, page([], 't3_c9')], ['t3_a1', 'x', '0'], 0);
    expect(second.more).toBe('subs~t3_a1.x.t3_c9');
    const last = mergeNewest([page([['a2', 40]], null), null, null], ['t3_a1', 'x', 'x'], 5);
    expect(last.items.map((i) => i.post.id)).toEqual(['t3_a2']);
    expect(last.more).toBeNull();
    // A post in two groups is given once.
    expect(mergeNewest([page([['a1', 10]], null), page([['a1', 10]], null)], ['0', '0'], 5).items).toHaveLength(1);
  });

  test("a cursor's places: only for the same number of groups", () => {
    expect(parseSubsCursor('subs~t3_a1.x.0', 3)).toEqual(['t3_a1', 'x', '0']);
    expect(parseSubsCursor('subs~t3_a1.x.0', 2)).toBeNull();
    expect(parseSubsCursor('subs~t1_a1', 1)).toBeNull();
    expect(parseSubsCursor('t3_a1', 1)).toBeNull();
  });
});

describe('your picture', () => {
  test("the picture you set, unescaped; Reddit's default snoo is none", () => {
    const u = parseUser(user(ME), ctx())!;
    expect(ownPicture(u)).toBe('https://styles.redditmedia.com/t5_x/styles/profileIcon_a.png?width=256&s=1');
    const plain = user(ME);
    plain.data.icon_img = 'https://www.redditstatic.com/avatars/defaults/v2/avatar_default_3.png';
    expect(ownPicture(parseUser(plain, ctx())!)).toBeNull();
    expect(ownPicture({ ...u, avatar: null })).toBeNull();
  });
});
