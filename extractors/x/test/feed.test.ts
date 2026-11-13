import { describe, expect, test } from 'bun:test';
import { FeedTracker, feedConvId, LIVE_MS, parseNotifications, parsePost, parseProfileUser, parsePublished, parseReactors, parseTweetDetail, parseUser, parseUserTweets, personAbout, X_ACTOR, xDate } from '../src/feed.ts';
import { Drops } from '../src/validate.ts';
import { CARA, favoritersResponse, normalizedTweet, reactorsTimeline, retweetersResponse, tweetResultResponse, conversationModule, cursorEntry, DEV, detailCursorEntry, detailTweetEntry, EMI, FINN, gardenThread, ME, notificationEntry, notificationsResponse, notificationsTimeline, tweet, tweetDetailResponse, tweetDetailTimeline, tweetEntry, userByRestIdResponse, userFlat, userNew, userOld, userTweetsResponse, userTweetsTimeline, withVisibility, xDateStr } from './feed-fixtures.ts';

const NOW = Date.now();
const MIN = 60_000;
const H = 3600_000;
const myPost = tweet({ id: '1800000000000000001', by: ME, text: 'tomatoes are finally red', ts: NOW - 30 * H, counts: { likes: 3, reposts: 1 } });
const myLong = tweet({ id: '1800000000000000002', by: ME, text: '', note: `A long one. ${'word '.repeat(80)}the end`, ts: NOW - 40 * H });

function page() {
  return notificationsTimeline([
    cursorEntry('Top', 'DAABDAABCgABTop1', NOW),
    notificationEntry({ id: 'AAAAAQ1', icon: 'heart_icon', ts: NOW - 5 * MIN, text: 'Cara C and 2 others liked your post', from: [userNew(CARA), userOld(DEV), userNew(EMI)], targets: [myPost], url: `https://x.com/${ME.handle}/status/${myPost.rest_id}` }),
    tweetEntry(withVisibility(tweet({ id: '1800000000000000101', by: CARA, text: 'love this & want some', ts: NOW - 20 * MIN, replyTo: { id: myPost.rest_id, by: ME } })), 'user_replied_to_your_tweet', NOW - 20 * MIN),
    tweetEntry(tweet({ id: '1800000000000000102', by: EMI, text: `hey @${ME.handle} look https://t.co/gArd3n`, ts: NOW - 50 * MIN, urls: [{ url: 'https://t.co/gArd3n', expanded: 'https://emi.example/garden', display: 'emi.example/garden' }] }), 'user_mentioned_you', NOW - 50 * MIN),
    tweetEntry(tweet({ id: '1800000000000000103', by: FINN, layout: 'old', text: 'this, exactly', ts: NOW - 2 * H, quote: myLong }), 'user_quoted_your_tweet', NOW - 2 * H),
    notificationEntry({ id: 'AAAAAQ2', icon: 'retweet_icon', ts: NOW - 3 * H, text: 'Finn F reposted your post', from: [userOld(FINN)], targets: [myPost], element: 'users_retweeted_your_tweet' }),
    notificationEntry({ id: 'AAAAAQ3', icon: 'person_icon', ts: NOW - 4 * H, text: 'Dev D followed you', from: [userOld(DEV)], element: 'follow_from_recommended_user' }),
    notificationEntry({ id: 'AAAAAQ4', icon: 'milestone_icon', ts: NOW - 5 * H, text: 'Your post was seen 1,000 times', from: [], targets: [myPost], element: 'generic_milestone' }),
    cursorEntry('Bottom', 'DAABDAABCgABBottom1', NOW - 6 * H),
  ]);
}

describe('users', () => {
  test("2025's layout: names in core, the picture in avatar, follows in relationship_perspectives, links expanded", () => {
    const u = parseUser(userNew(CARA), new Drops())!;
    expect(u).toEqual({
      id: CARA.id,
      handle: CARA.handle,
      name: CARA.name,
      avatar: `https://pbs.twimg.com/profile_images/${CARA.id}/${CARA.handle}_normal.jpg`,
      bio: 'Gardens, mostly. https://cara.example/garden',
      location: 'Lisbon',
      website: { url: 'https://cara.example', display: 'cara.example' },
      createdAt: CARA.createdAt!,
      followers: 120,
      following: 80,
      posts: 900,
      followsYou: true,
      followedByMe: true,
    });
  });
  test('the older layout (all in legacy) and the flat one the user lookup normalizes to', () => {
    const old = parseUser(userOld(DEV), new Drops())!;
    expect(old).toMatchObject({ id: DEV.id, handle: DEV.handle, name: DEV.name, bio: 'builds things & breaks them', createdAt: DEV.createdAt!, followers: 3400, followsYou: true, followedByMe: false, location: null });
    expect(old.avatar).toMatch(/^https:\/\/pbs\.twimg\.com\//);
    const flat = parseProfileUser(userFlat(FINN), new Drops())!;
    expect(flat).toMatchObject({ id: FINN.id, handle: FINN.handle, name: FINN.name, location: 'Oslo', followers: 800, followedByMe: true, followsYou: false });
    expect(parseProfileUser(userByRestIdResponse(userNew(EMI)), new Drops())).toMatchObject({ id: EMI.id, handle: EMI.handle });
  });
  test('what is not a user is dropped and counted', () => {
    const d = new Drops();
    expect(parseUser({ __typename: 'UserUnavailable', reason: 'Suspended' }, d)).toBeNull();
    expect(parseUser({ ...userNew(EMI), rest_id: 'abc' }, d)).toBeNull();
    expect(parseUser({ ...userNew(EMI), core: { screen_name: 'not a handle' } }, d)).toBeNull();
    expect(Object.fromEntries(d.counts)).toEqual({ 'user.UserUnavailable': 1, 'user.bad-id': 1, 'user.bad-handle': 1 });
    // A picture somewhere else is left out, not passed on.
    expect(parseUser({ ...userNew(EMI), avatar: { image_url: 'https://evil.example/a.jpg' } }, d)!.avatar).toBeNull();
  });
  test('personAbout: bio, counts, follows, links and location; following only when you follow them', () => {
    expect(personAbout(parseUser(userNew(CARA), new Drops())!)).toEqual({
      displayName: 'Cara C',
      handle: 'cara_c',
      avatar: `https://pbs.twimg.com/profile_images/${CARA.id}/${CARA.handle}_normal.jpg`,
      bio: 'Gardens, mostly. https://cara.example/garden',
      createdAt: CARA.createdAt!,
      relationship: 'following',
      followsYou: true,
      counts: { followers: 120, following: 80, posts: 900 },
      links: [
        { label: 'X', value: '@cara_c', url: 'https://x.com/cara_c' },
        { label: 'Website', value: 'cara.example', url: 'https://cara.example' },
      ],
      facts: [{ label: 'Location', value: 'Lisbon' }],
    });
    const emi = personAbout(parseUser(userNew(EMI), new Drops())!);
    expect(emi.relationship).toBeUndefined();
    expect(emi.followsYou).toBe(false);
    expect(emi.facts).toBeUndefined();
  });
});

describe('posts', () => {
  const ctx = () => ({ users: new Map(), drops: new Drops() });
  test("X's date format", () => {
    expect(xDate('Wed Oct 10 20:19:24 +0000 2018')).toBe(Date.UTC(2018, 9, 10, 20, 19, 24));
    expect(xDate(xDateStr(NOW - 1000))).toBe(Math.floor((NOW - 1000) / 1000) * 1000);
    expect(xDate('nonsense')).toBeNull();
  });
  test('a reply: its leading @name not shown, entities unescaped, replyTo with the author; the author noted', () => {
    const c = ctx();
    const p = parsePost(tweet({ id: '1800000000000000101', by: CARA, text: 'love this & want some', ts: NOW - MIN, replyTo: { id: '1800000000000000001', by: ME }, counts: { likes: 2, views: 40 } }), c)!;
    expect(p).toEqual({ id: '1800000000000000101', url: 'https://x.com/cara_c/status/1800000000000000101', ts: Math.floor((NOW - MIN) / 1000) * 1000, author: CARA.id, text: 'love this & want some', replyTo: { id: '1800000000000000001', author: ME.id }, root: '1800000000000000001', counts: { replies: 0, reposts: 0, likes: 2, quotes: 0, views: 40 }, viewer: { liked: false, reposted: false } });
    expect(c.users.get(CARA.id)).toMatchObject({ handle: 'cara_c' });
  });
  test('TweetWithVisibilityResults is the post inside; a long post is its note text; links and media urls', () => {
    const c = ctx();
    const long = parsePost(withVisibility(myLong), c)!;
    expect(long.text).toBe(`A long one. ${'word '.repeat(80)}the end`);
    const pic = parsePost(tweet({ id: '1800000000000000201', by: DEV, layout: 'old', text: 'see https://t.co/l1nk', ts: NOW - H, urls: [{ url: 'https://t.co/l1nk', expanded: 'https://dev.example/x', display: 'dev.example/x' }], media: [{ url: 'https://t.co/m3d1a', type: 'photo', img: 'https://pbs.twimg.com/media/AbC1.jpg', w: 1200, h: 800, alt: 'a red tomato' }] }), c)!;
    expect(pic.text).toBe('see https://dev.example/x');
    expect(pic.media).toEqual([{ kind: 'image', url: 'https://pbs.twimg.com/media/AbC1.jpg', width: 1200, height: 800, alt: 'a red tomato' }]);
    const vid = parsePost(tweet({ id: '1800000000000000202', by: DEV, text: 'clip', ts: NOW - H, media: [{ url: 'https://t.co/v1d', type: 'video', img: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg', w: 640, h: 360 }] }), c)!;
    expect(vid.media![0]).toMatchObject({ kind: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg' });
  });
  test('a repost has repostOf and no text of its own; a quote has quoteOf and its own text without the link', () => {
    const c = ctx();
    const rt = parsePost(tweet({ id: '1800000000000000301', by: CARA, text: '', ts: NOW - H, repost: tweet({ id: '1800000000000000300', by: DEV, text: 'original thought', ts: NOW - 2 * H }) }), c)!;
    expect(rt).toMatchObject({ id: '1800000000000000301', author: CARA.id, text: '', repostOf: { id: '1800000000000000300', author: DEV.id, text: 'original thought' } });
    const q = parsePost(tweet({ id: '1800000000000000302', by: FINN, layout: 'old', text: 'this, exactly', ts: NOW - H, quote: myPost }), c)!;
    expect(q).toMatchObject({ text: 'this, exactly', quoteOf: { id: myPost.rest_id, author: ME.id, text: 'tomatoes are finally red' } });
    expect([...c.users.keys()].sort()).toEqual([ME.id, CARA.id, DEV.id, FINN.id].sort());
  });
  test('tombstones and posts without an id or a time are dropped and counted', () => {
    const c = ctx();
    expect(parsePost({ __typename: 'TweetTombstone', tombstone: {} }, c)).toBeNull();
    expect(parsePost({ ...myPost, rest_id: 'x', legacy: { ...myPost.legacy, id_str: 'y' } }, c)).toBeNull();
    expect(parsePost({ ...myPost, legacy: { ...myPost.legacy, created_at: 'soon' } }, c)).toBeNull();
    expect(Object.fromEntries(c.drops.counts)).toEqual({ 'post.TweetTombstone': 1, 'post.bad-id': 1, 'post.no-time': 1 });
  });
});

describe('the notifications timeline', () => {
  test('one message per actor: an aggregated like is three; replies, mentions and quotes carry their post; cursors', () => {
    const d = new Drops();
    const p = parseNotifications(page(), ME.id, d);
    expect(d.total).toBe(0);
    expect(p.top).toBe('DAABDAABCgABTop1');
    expect(p.bottom).toBe('DAABDAABCgABBottom1');
    const byId = Object.fromEntries(p.entries.map((e) => [e.nativeId, e]));
    expect(Object.keys(byId)).toEqual([
      `like:${myPost.rest_id}:${CARA.id}`,
      `like:${myPost.rest_id}:${DEV.id}`,
      `like:${myPost.rest_id}:${EMI.id}`,
      'reply:1800000000000000101',
      'mention:1800000000000000102',
      'quote:1800000000000000103',
      `repost:${myPost.rest_id}:${FINN.id}`,
      `follow:${DEV.id}`,
      'other:AAAAAQ4:-',
    ]);
    const like = byId[`like:${myPost.rest_id}:${DEV.id}`]!;
    expect(like).toMatchObject({ type: 'like', actor: DEV.id, ts: NOW - 5 * MIN, kind: 'system', body: 'liked your post', item: { type: 'like', url: `https://x.com/${ME.handle}/status/${myPost.rest_id}`, post: { id: myPost.rest_id, author: ME.id, text: 'tomatoes are finally red' } } });
    expect(byId['reply:1800000000000000101']).toMatchObject({ type: 'reply', actor: CARA.id, kind: 'text', body: 'love this & want some', item: { type: 'reply', theirs: { replyTo: { id: myPost.rest_id, author: ME.id } }, url: 'https://x.com/cara_c/status/1800000000000000101' } });
    expect(byId['reply:1800000000000000101']!.item.post).toBeUndefined();
    expect(byId['mention:1800000000000000102']).toMatchObject({ type: 'mention', actor: EMI.id, body: `hey @${ME.handle} look https://emi.example/garden` });
    expect(byId['quote:1800000000000000103']).toMatchObject({ type: 'quote', actor: FINN.id, body: 'this, exactly', item: { post: { id: myLong.rest_id }, theirs: { quoteOf: { id: myLong.rest_id } } } });
    expect(byId[`repost:${myPost.rest_id}:${FINN.id}`]).toMatchObject({ kind: 'system', body: 'reposted your post' });
    expect(byId[`follow:${DEV.id}`]).toMatchObject({ kind: 'system', body: 'followed you', item: { type: 'follow', url: 'https://x.com/dev_d' } });
    expect(byId['other:AAAAAQ4:-']).toMatchObject({ actor: X_ACTOR, kind: 'system', body: 'Your post was seen 1,000 times', item: { type: 'other', text: 'Your post was seen 1,000 times', post: { id: myPost.rest_id } } });
    expect([...p.users.keys()].sort()).toEqual([ME.id, CARA.id, DEV.id, EMI.id, FINN.id].sort());
    expect(p.oldest).toBe(NOW - 5 * H);
  });
  test('without the client event, the post says what it is; a like of someone else\'s post says so', () => {
    const theirs = tweet({ id: '1800000000000000400', by: DEV, text: `with @${ME.handle}`, ts: NOW - H });
    const tl = notificationsTimeline([
      tweetEntry(tweet({ id: '1800000000000000401', by: CARA, text: 'yes', ts: NOW - MIN, replyTo: { id: myPost.rest_id, by: ME } }), '', NOW),
      tweetEntry(tweet({ id: '1800000000000000402', by: EMI, text: 'hm', ts: NOW - MIN, quote: myPost }), '', NOW),
      notificationEntry({ id: 'AAAAAQ5', icon: 'heart_icon', ts: NOW - MIN, text: 'Emi E liked a post you were mentioned in', from: [userNew(EMI)], targets: [theirs] }),
    ]);
    const p = parseNotifications(tl, ME.id, new Drops());
    expect(p.entries.map((e) => [e.nativeId, e.body])).toEqual([
      ['reply:1800000000000000401', 'yes'],
      ['quote:1800000000000000402', 'hm'],
      [`like:1800000000000000400:${EMI.id}`, 'liked a post you were mentioned in'],
    ]);
  });
  test('what does not fit is dropped and counted by reason; the whole answer or the timeline alone both read', () => {
    const d = new Drops();
    const tl = notificationsTimeline([
      notificationEntry({ id: 'bad id!', icon: 'heart_icon', ts: NOW, text: 'x', from: [userNew(EMI)], targets: [myPost] }),
      { ...notificationEntry({ id: 'AAAAAQ6', icon: 'heart_icon', ts: NOW, text: 'x', from: [userNew(EMI)], targets: [myPost] }), sortIndex: '1', content: { ...notificationEntry({ id: 'AAAAAQ6', icon: 'heart_icon', ts: NOW, text: 'x', from: [], targets: [] }).content, itemContent: { ...notificationEntry({ id: 'AAAAAQ6', icon: 'heart_icon', ts: NOW, text: 'x', from: [], targets: [] }).content.itemContent, timestamp_ms: 'yesterday' } } },
      tweetEntry({ __typename: 'TweetTombstone' }, 'user_mentioned_you', NOW),
      { entryId: 'who-to-follow', sortIndex: '1', content: { entryType: 'TimelineTimelineItem', itemContent: { __typename: 'TimelineUser', user_results: {} } } },
      notificationEntry({ id: 'AAAAAQ7', icon: 'bell_icon', ts: NOW, text: '', from: [], targets: [] }),
    ]);
    expect(parseNotifications(notificationsResponse(tl).data.viewer_v2.user_results.result.notification_timeline, ME.id, d).entries).toEqual([]);
    expect(Object.fromEntries(d.counts)).toEqual({ 'notification.bad-id': 1, 'notification.no-time-string9': 1, 'post.TweetTombstone': 1, 'feed.item-TimelineUser': 1, 'notification.no-text': 1 });
    const none = new Drops();
    expect(parseNotifications({ nothing: true }, ME.id, none).entries).toEqual([]);
    expect(Object.fromEntries(none.counts)).toEqual({ 'feed.no-instructions': 1 });
  });
});

describe('a profile', () => {
  test('pinned first with pinned, then newest first; reposts and quotes; promoted posts left out; at most 20', () => {
    const pinned = tweet({ id: '1800000000000000500', by: CARA, text: 'read this first', ts: NOW - 100 * H });
    const posts = [
      tweet({ id: '1800000000000000501', by: CARA, text: 'older', ts: NOW - 10 * H }),
      tweet({ id: '1800000000000000503', by: CARA, text: '', ts: NOW - H, repost: tweet({ id: '1800000000000000499', by: DEV, text: 'worth it', ts: NOW - 3 * H }) }),
      withVisibility(tweet({ id: '1800000000000000502', by: CARA, text: 'quoting', ts: NOW - 2 * H, quote: myPost })),
      pinned,
    ];
    const tl = userTweetsTimeline(pinned, posts, NOW);
    tl.instructions[2]!.entries!.push({ entryId: 'promoted-tweet-1', sortIndex: '5', content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: tweet({ id: '1800000000000000999', by: EMI, text: 'buy', ts: NOW }) }, promotedMetadata: {} } } } as any);
    const d = new Drops();
    const r = parseUserTweets(userTweetsResponse(tl), d);
    expect(d.total).toBe(0);
    expect(r.posts.map((p) => [p.id, p.pinned ?? false])).toEqual([
      ['1800000000000000500', true],
      ['1800000000000000503', false],
      ['1800000000000000502', false],
      ['1800000000000000501', false],
    ]);
    expect(r.posts[1]).toMatchObject({ text: '', repostOf: { id: '1800000000000000499', author: DEV.id } });
    expect(r.posts[2]).toMatchObject({ text: 'quoting', quoteOf: { id: myPost.rest_id } });
    expect([...r.users.keys()].sort()).toEqual([ME.id, CARA.id, DEV.id].sort());
    const many = userTweetsTimeline(null, Array.from({ length: 30 }, (_, i) => tweet({ id: `18000000000000006${String(i).padStart(2, '0')}`, by: CARA, text: `n${i}`, ts: NOW - i * MIN })), NOW);
    expect(parseUserTweets(many, new Drops()).posts.length).toBe(20);
  });
});

describe("a post's thread", () => {
  const g = gardenThread(NOW);
  const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

  test('what it answers, the post, its replies as chains (its author going on first); ads, Discover more and gone posts left out', () => {
    const d = new Drops();
    const { thread, users } = parseTweetDetail(g.page1, g.focal.rest_id, d);
    expect(thread.focal).toMatchObject({ id: g.focal.rest_id, author: CARA.id, text: 'San Marzano, mostly https://cara.example/san-marzano', root: g.root.rest_id, replyTo: { id: g.answer.rest_id, author: FINN.id }, counts: { likes: 4, replies: 5 }, url: `https://x.com/${CARA.handle}/status/${g.focal.rest_id}` });
    expect(ids(thread.ancestors)).toEqual([g.root.rest_id, g.answer.rest_id]);
    expect(thread.ancestors[0]).toMatchObject({ root: g.root.rest_id, text: 'Planting day: forty tomato seedlings' });
    expect(thread.ancestors[0]!.replyTo).toBeUndefined();
    expect(thread.replies.map(ids)).toEqual([[g.self1.rest_id, g.self2.rest_id], [g.emi1.rest_id, g.emi2.rest_id], [g.dev1.tweet.rest_id]]);
    expect(thread.replies[2]![0]).toMatchObject({ author: DEV.id, text: 'good luck & post pictures', replyTo: { id: g.focal.rest_id, author: CARA.id } });
    // Every post names its thread.
    expect([...thread.ancestors, ...thread.replies.flat()].every((p) => p.root === g.root.rest_id)).toBe(true);
    expect(thread.more).toBe(g.cursors.page2);
    expect([...users.keys()].sort()).toEqual([CARA.id, DEV.id, EMI.id, FINN.id].sort());
    // The gone post is counted; the module's "Show replies" cursor, the ad and Discover more are no drop.
    expect(Object.fromEntries(d.counts)).toEqual({ 'post.TweetTombstone': 1 });
    // A raw answer (data.threaded_conversation_with_injections_v2) reads the same.
    expect(parseTweetDetail(tweetDetailResponse(g.page1), g.focal.rest_id, new Drops()).thread).toEqual(thread);
  });

  test('pages of more replies: new chains, more of a chain shown (TimelineAddToModule), ShowMoreThreads, then the end', () => {
    const two = parseTweetDetail(g.page2, g.focal.rest_id, new Drops(), null, true).thread;
    expect(two.focal).toBeUndefined();
    expect(two.ancestors).toEqual([]);
    expect(two.replies.map(ids)).toEqual([[g.finn1.rest_id], [g.emi3.rest_id, g.emi4.rest_id]]);
    expect(two.more).toBe(g.cursors.page3);
    const three = parseTweetDetail(g.page3, g.focal.rest_id, new Drops(), null, true).thread;
    expect(three).toEqual({ ancestors: [], replies: [[expect.objectContaining({ id: g.dev2.rest_id, author: DEV.id })]], more: null });
  });

  test("the author's own chain first even when X sends it later; a Bottom cursor before ShowMoreThreads; a post with nothing around it", () => {
    const tl = tweetDetailTimeline([detailTweetEntry(g.focal), conversationModule([g.emi1]), detailCursorEntry('ShowMoreThreads', 'later'), conversationModule([g.self1, g.self2]), detailCursorEntry('Bottom', 'first')]);
    const t = parseTweetDetail(tl, g.focal.rest_id, new Drops()).thread;
    expect(t.replies.map(ids)).toEqual([[g.self1.rest_id, g.self2.rest_id], [g.emi1.rest_id]]);
    expect(t.more).toBe('first');
    const prompt = parseTweetDetail(tweetDetailTimeline([detailTweetEntry(g.focal), detailCursorEntry('ShowMoreThreadsPrompt', 'spam')]), g.focal.rest_id, new Drops()).thread;
    expect(prompt).toEqual({ focal: expect.objectContaining({ id: g.focal.rest_id }), ancestors: [], replies: [], more: 'spam' });
    expect(parseTweetDetail(tweetDetailTimeline([detailTweetEntry(g.root)]), g.root.rest_id, new Drops()).thread).toEqual({ focal: expect.objectContaining({ id: g.root.rest_id, root: g.root.rest_id }), ancestors: [], replies: [], more: null });
  });

  test('without the post asked for, or nothing like a timeline: a plain error, unless it is a page of more replies', () => {
    expect(() => parseTweetDetail(g.page1, '1856000000000009999', new Drops())).toThrow('X did not give this post');
    const d = new Drops();
    expect(() => parseTweetDetail({ nothing: true }, g.focal.rest_id, d)).toThrow('X did not give this post');
    expect(Object.fromEntries(d.counts)).toEqual({ 'thread.no-instructions': 1 });
    expect(parseTweetDetail({ instructions: [] }, g.focal.rest_id, new Drops(), null, true).thread).toEqual({ ancestors: [], replies: [], more: null });
    // The focal post itself gone.
    const gone = tweetDetailTimeline([{ ...detailTweetEntry({ __typename: 'TweetTombstone', tombstone: {} }), entryId: `tweet-${g.focal.rest_id}` }]);
    expect(() => parseTweetDetail(gone, g.focal.rest_id, new Drops())).toThrow('X did not give this post');
  });

  test("a profile's posts and a notification's name their thread too", () => {
    const p = parsePost(g.answer, { users: new Map(), drops: new Drops() })!;
    expect(p.root).toBe(g.root.rest_id);
    expect(parsePost(myPost, { users: new Map(), drops: new Drops() })!.root).toBe(myPost.rest_id);
  });
});

describe('answering on X', () => {
  const ctx = () => ({ users: new Map(), drops: new Drops() });
  test('what you did to a post, wherever a post is read: liked and reposted from legacy.favorited and legacy.retweeted', () => {
    const liked = tweet({ id: '1800000000000000201', by: CARA, text: 'yes', ts: NOW - H, viewer: { liked: true } });
    const both = withVisibility(tweet({ id: '1800000000000000202', by: DEV, layout: 'old', text: 'both', ts: NOW - H, viewer: { liked: true, reposted: true }, quote: liked }));
    const c = ctx();
    const p = parsePost(both, c)!;
    expect(p.viewer).toEqual({ liked: true, reposted: true });
    expect(p.quoteOf!.viewer).toEqual({ liked: true, reposted: false });
    // Without the fields (an older answer), nothing is said.
    const bare = tweet({ id: '1800000000000000203', by: CARA, text: 'old', ts: NOW - H });
    delete bare.legacy.favorited;
    delete bare.legacy.retweeted;
    expect(parsePost(bare, ctx())!.viewer).toBeUndefined();
    // In a profile, a thread and the notifications alike.
    expect(parseUserTweets(userTweetsResponse(userTweetsTimeline(null, [liked], NOW)), new Drops()).posts[0]!.viewer).toEqual({ liked: true, reposted: false });
    const g = gardenThread(NOW);
    g.focal.legacy.retweeted = true;
    expect(parseTweetDetail(tweetDetailResponse(g.page1), g.focal.rest_id, new Drops()).thread.focal!.viewer).toEqual({ liked: false, reposted: true });
  });

  test('a made post: read back alone when it could be; else sendTweet\'s normalized post; else the least known', () => {
    const made = tweet({ id: '1800000000000000301', by: ME, text: 'and six Black Krim', ts: NOW - 1000, replyTo: { id: '1800000000000000300', by: CARA }, root: '1800000000000000299' });
    const self = { id: ME.id, handle: ME.handle };
    const back = parsePublished({ id: made.rest_id, created: normalizedTweet(made), tweet: tweetResultResponse(made).data.tweetResult }, 'and six Black Krim', self, new Drops())!;
    expect(back.post).toMatchObject({ id: made.rest_id, url: `https://x.com/${ME.handle}/status/${made.rest_id}`, author: ME.id, text: 'and six Black Krim', replyTo: { id: '1800000000000000300', author: CARA.id }, root: '1800000000000000299', viewer: { liked: false, reposted: false } });
    expect([...back.users.keys()]).toEqual([ME.id]);
    // The read back failed: the normalized post (flat, its author an id), its link made with your handle.
    const drops = new Drops();
    const flat = parsePublished({ id: made.rest_id, created: normalizedTweet(made), tweet: null }, 'and six Black Krim', self, drops)!;
    expect(flat.post).toMatchObject({ id: made.rest_id, url: `https://x.com/${ME.handle}/status/${made.rest_id}`, author: ME.id, text: 'and six Black Krim', replyTo: { id: '1800000000000000300' }, root: '1800000000000000299' });
    expect(flat.post.ts).toBe(Math.floor((NOW - 1000) / 1000) * 1000);
    // Neither: the id, your text, now.
    const bare = parsePublished({ id: made.rest_id, created: {}, tweet: { result: { __typename: 'TweetUnavailable' } } }, 'hello', self, drops)!;
    expect(bare.post).toMatchObject({ id: made.rest_id, url: `https://x.com/${ME.handle}/status/${made.rest_id}`, author: ME.id, text: 'hello' });
    expect(drops.summary()).toMatch(/published\.bare 1/);
    // No id at all: nothing to answer with (main says X did not say which post it made).
    expect(parsePublished({ id: null, created: {} }, 'x', self, new Drops())).toBeNull();
  });

  test('who liked: people in X\'s order with followers, follows and checks; more by the Bottom cursor; an empty page ends it', () => {
    const tl = reactorsTimeline([userNew(CARA), userOld(DEV), userNew({ ...EMI, followsYou: true })], 'DAAHlikes-2');
    const { page: p, users } = parseReactors(favoritersResponse(tl), new Drops());
    expect(p).toEqual({
      who: [
        { id: CARA.id, followers: 120, following: true, followsYou: true },
        { id: DEV.id, followers: 3400, following: false, followsYou: true, verified: true },
        { id: EMI.id, followers: 12, following: false, followsYou: true },
      ],
      more: 'DAAHlikes-2',
    });
    expect([...users.keys()]).toEqual([CARA.id, DEV.id, EMI.id]);
    // The page's own call gives the timeline itself; reposts read the same.
    expect(parseReactors(tl, new Drops()).page.who.length).toBe(3);
    expect(parseReactors(retweetersResponse(reactorsTimeline([userOld(FINN)], 'c')), new Drops()).page).toEqual({ who: [{ id: FINN.id, followers: 800, following: true, followsYou: false, verified: true }], more: 'c' });
    // The last page (a Bottom cursor, nobody), someone else's post (nothing at all): no more.
    expect(parseReactors(reactorsTimeline([], 'DAAHlikes-3'), new Drops()).page).toEqual({ who: [], more: null });
    expect(parseReactors({ instructions: [] }, new Drops()).page).toEqual({ who: [], more: null });
    const drops = new Drops();
    expect(parseReactors(reactorsTimeline([{ __typename: 'UserUnavailable', rest_id: '9' }], 'x'), drops).page.who).toEqual([]);
    expect(drops.summary()).toMatch(/user\.UserUnavailable 1/);
  });
});

describe('what the feed tells the hub', () => {
  test('the conversation, people and profiles first, then messages oldest first; a first read is backfill', () => {
    const t = new FeedTracker();
    expect(t.fresh).toBe(true);
    const evs = t.page(parseNotifications(page(), ME.id, new Drops()), { selfId: ME.id, now: NOW, backfill: true });
    const kinds = evs.map((e) => e.t);
    expect(feedConvId(null)).toBe('feed');
    expect(evs[0]).toEqual({ t: 'conversation', conversation: { nativeId: `feed:${ME.id}`, shape: 'channel', variant: 'feed', name: 'Notifications' } });
    expect(kinds.indexOf('message')).toBeGreaterThan(kinds.lastIndexOf('personAbout'));
    expect(kinds.lastIndexOf('identity')).toBeLessThan(kinds.indexOf('personAbout'));
    expect(evs.filter((e) => e.t === 'identity').map((e: any) => e.identity.nativeId).sort()).toEqual([ME.id, CARA.id, DEV.id, EMI.id, FINN.id, X_ACTOR].sort());
    expect(evs.find((e: any) => e.t === 'identity' && e.identity.nativeId === ME.id)).toMatchObject({ identity: { isSelf: true } });
    expect(evs.filter((e) => e.t === 'personAbout').map((e: any) => e.who).sort()).toEqual([CARA.id, DEV.id, EMI.id, FINN.id].sort());
    const msgs = evs.filter((e) => e.t === 'message') as any[];
    expect(msgs.length).toBe(9);
    expect(msgs.every((m) => m.live === false)).toBe(true);
    expect(msgs.map((m) => m.message.ts)).toEqual([...msgs.map((m) => m.message.ts)].sort((a, b) => a - b));
    const reply = msgs.find((m) => m.message.nativeId === 'reply:1800000000000000101').message;
    expect(reply).toMatchObject({ conversation: `feed:${ME.id}`, author: CARA.id, kind: 'text', body: 'love this & want some', mentionsSelf: true, extra: { feed: { type: 'reply' } } });
    expect(msgs.find((m) => m.message.nativeId.startsWith('like:')).message).toMatchObject({ kind: 'system', body: 'liked your post' });
    expect(t.top).toBe('DAABDAABCgABTop1');
    expect(t.newestMs).toBe(NOW - 5 * MIN);
    expect(t.items).toBe(9);
    expect(t.abouts).toBe(4);
  });
  test('later: newer and fresh is live; profiles at most once a day; a like seen again is not live again; kept state', () => {
    const t = new FeedTracker();
    t.page(parseNotifications(page(), ME.id, new Drops()), { selfId: ME.id, now: NOW, backfill: true });
    const next = notificationsTimeline([
      cursorEntry('Top', 'DAABDAABCgABTop2', NOW + MIN),
      notificationEntry({ id: 'AAAAAQ1', icon: 'heart_icon', ts: NOW + MIN, text: 'Finn F and 3 others liked your post', from: [userOld(FINN), userNew(CARA), userOld(DEV), userNew(EMI)], targets: [myPost] }),
      notificationEntry({ id: 'AAAAAQ8', icon: 'person_icon', ts: NOW - 20 * MIN - LIVE_MS, text: 'Emi E followed you', from: [userNew(EMI)] }),
    ]);
    const evs = t.page(parseNotifications(next, ME.id, new Drops()), { selfId: ME.id, now: NOW + 2 * MIN, backfill: false });
    expect(evs.some((e) => e.t === 'conversation')).toBe(false);
    expect(evs.filter((e) => e.t === 'personAbout')).toEqual([]);
    const live = Object.fromEntries((evs.filter((e) => e.t === 'message') as any[]).map((m) => [m.message.nativeId, m.live]));
    expect(live).toEqual({ [`follow:${EMI.id}`]: false, [`like:${myPost.rest_id}:${FINN.id}`]: true, [`like:${myPost.rest_id}:${CARA.id}`]: false, [`like:${myPost.rest_id}:${DEV.id}`]: false, [`like:${myPost.rest_id}:${EMI.id}`]: false });
    // A day later, the same people are announced again.
    const later = t.page(parseNotifications(next, ME.id, new Drops()), { selfId: ME.id, now: NOW + 25 * H, backfill: false });
    expect(later.filter((e) => e.t === 'personAbout').length).toBe(4);
    const kept = t.kept();
    expect(kept.top).toBe('DAABDAABCgABTop2');
    expect(kept.newestMs).toBe(NOW + MIN);
    expect(kept.ids).toContain(`like:${myPost.rest_id}:${FINN.id}`);
    expect(JSON.stringify(kept)).not.toMatch(/tomatoes|Cara|cara_c/);
    // After a restart, what was announced stays announced.
    const again = new FeedTracker(JSON.parse(JSON.stringify(kept)));
    expect(again.fresh).toBe(false);
    const re = again.page(parseNotifications(next, ME.id, new Drops()), { selfId: ME.id, now: NOW + 2 * MIN, backfill: false });
    expect((re.filter((e) => e.t === 'message') as any[]).every((m) => m.live === false)).toBe(true);
  });
  test('an older page does not move the Top cursor', () => {
    const t = new FeedTracker({ top: 'T1', newestMs: NOW });
    t.page({ entries: [], users: new Map(), top: 'T0', bottom: null, oldest: null }, { selfId: ME.id, now: NOW, backfill: true, older: true });
    expect(t.top).toBe('T1');
  });
});

describe('a notification time in whatever form X sends it', () => {
  test('milliseconds as a number or digits, seconds, microseconds, a date string, else the sort index', async () => {
    const { notificationTime } = await import('../src/feed.ts');
    const ms = Date.UTC(2026, 10, 12, 20, 0, 0);
    expect(notificationTime(ms)).toBe(ms);
    expect(notificationTime(String(ms))).toBe(ms);
    expect(notificationTime(ms / 1000)).toBe(ms);
    expect(notificationTime(String(ms * 1000))).toBe(ms);
    expect(notificationTime(new Date(ms).toISOString())).toBe(ms);
    expect(notificationTime(undefined, String(ms))).toBe(ms);
    expect(notificationTime('soon', '7')).toBe(null);
  });
});
