import { describe, expect, test } from 'bun:test';
import * as M from '../src/map.ts';
import { compute, type Facts } from '../src/status.ts';
import { FeedTracker, LIVE_MS } from '../src/tracker.ts';
import { activity, ANN, ANN_PUB, BEN, branch, CAL, ME, MY_PUB, noteItem, postItem, publicProfile, world } from './fixtures.ts';

const NOW = Date.now();
const fresh = () => M.newCtx(new M.Drops());
const SELF = String(ME.id);

describe('posts and notes', () => {
  test('a newsletter post: title, subtitle and preview as the words, its publication as the place, counts, cover, what you did', () => {
    const w = world(NOW);
    const ctx = fresh();
    M.pubOf(MY_PUB, ctx);
    expect(M.postFact(w.myPost, ctx)).toEqual({
      id: 'p-9001',
      url: 'https://acmenotes.substack.com/p/why-soil-matters',
      ts: Date.parse(w.myPost.post_date),
      author: SELF,
      text: 'A short one\n\nSoil is alive.',
      title: 'Why soil matters',
      place: { id: '5001', name: 'ACME Notes', url: 'https://acmenotes.substack.com' },
      counts: { likes: 5, replies: 2, reposts: 1 },
      viewer: { liked: false, reposted: false },
      lang: 'en',
    });
  });
  test('a paywalled post carries a warning and keeps its free preview; a custom domain is its publication link', () => {
    const w = world(NOW);
    const f = M.postFact(w.annPost, fresh(), ANN_PUB)!;
    expect(f.warning).toBe('Paid subscribers only');
    expect(f.text).toBe('For paid readers\n\nThe first part is free.');
    expect(f.place).toEqual({ id: '5002', name: 'Garden Weekly', url: 'https://garden.example.com' });
    expect(f.media).toEqual([{ kind: 'image', url: 'https://substackcdn.com/image/fetch/cover.jpg' }]);
  });
  test('a note: no title, its author, pictures; a reply names its parent and thread; a comment on a post answers the post', () => {
    const w = world(NOW);
    const ctx = fresh();
    M.postFact(w.myPost, ctx, MY_PUB);
    const note = M.commentFact(w.annNote, ctx)!;
    expect(note).toMatchObject({ id: 'c-7005', author: String(ANN.id), text: 'Look at these beans', url: 'https://substack.com/@annlee/note/c-7005', counts: { likes: 30, replies: 2, reposts: 0 } });
    expect(note.title).toBeUndefined();
    expect(note.replyTo).toBeUndefined();
    expect(note.media).toEqual([{ kind: 'image', url: 'https://substack-post-media.s3.amazonaws.com/public/images/beans.jpg', width: 800, height: 600 }]);
    expect(M.commentFact(w.annOnBen, ctx)).toMatchObject({ id: 'c-7008', replyTo: { id: 'c-7007' }, root: 'c-7005' });
    const onPost = M.commentFact(w.benComment, ctx)!;
    expect(onPost).toMatchObject({ id: 'c-7003', replyTo: { id: 'p-9001', author: SELF }, root: 'p-9001', url: 'https://acmenotes.substack.com/p/why-soil-matters/comment/7003', place: { id: '5001', name: 'ACME Notes' } });
    expect(ctx.places.get('7003')).toEqual({ post: '9001', pub: '5001' });
    expect(ctx.places.get('7005')).toEqual({ post: null, pub: null });
  });
  test('a note that restacks a post with words quotes it', () => {
    const f = M.commentFact(world(NOW).calQuote, fresh())!;
    expect(f.quoteOf).toMatchObject({ id: 'p-9001', title: 'Why soil matters' });
    // Cal has no handle in this answer's comment? He does; his note links to his profile.
    expect(f.url).toBe('https://substack.com/@calmoe/note/c-7006');
  });
  test('posts, notes and comments never share an id; keys parse back', () => {
    expect(M.parseKey('p-9001')).toEqual({ on: 'post', id: '9001' });
    expect(M.parseKey('c-7001')).toEqual({ on: 'comment', id: '7001' });
    for (const bad of ['9001', 'x-1', 'p-', 'p-1a', 'c-1/../2', 42]) expect(M.parseKey(bad)).toBeNull();
  });
  test('what is not one is dropped and counted; pictures from elsewhere are left out', () => {
    const ctx = fresh();
    expect(M.commentFact({ id: 'x', date: 'now' }, ctx)).toBeNull();
    expect(M.postFact({ id: 1 }, ctx)).toBeNull();
    expect(M.commentFact({ ...world(NOW).annNote, deleted: true }, ctx)).toBeNull();
    expect(Object.fromEntries(ctx.drops.counts)).toEqual({ 'comment.bad-id': 1, 'post.no-time': 1, 'comment.deleted': 1 });
    expect(M.mediaUrl('https://evil.example/a.png')).toBeNull();
    expect(M.mediaUrl('http://substackcdn.com/a.png')).toBeNull();
    const u = M.userOf({ id: 5, name: 'Zed', photo_url: 'https://evil.example/z.png' }, ctx)!;
    expect(u.photo).toBeNull();
  });
  test('a body only in ProseMirror is read from it', () => {
    expect(M.bodyText({ body_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] } })).toBe('one\n\ntwo');
  });
});

describe('a post in full', () => {
  test("its page brings the whole body as Markdown, the reader's furniture left out; a card never has it", () => {
    const w = world(NOW);
    const ctx = fresh();
    const body =
      '<p>Soil is <strong>alive</strong>, see <a href="/p/worms">worms</a>.</p>' +
      '<h2 class="header-anchor-post">Roots<div class="header-anchor-parent"><button>#</button></div></h2>' +
      '<div class="captioned-image-container"><figure><a class="image-link" href="https://substackcdn.com/image/full.png"><picture><img src="https://substackcdn.com/image/root.png" alt="a root"></picture><div class="image-link-expand"><button>Expand</button></div></a><figcaption class="image-caption">A root</figcaption></figure></div>' +
      '<div class="subscription-widget-wrap"><p>Subscribe to ACME Notes</p><form><input type="email"></form></div>' +
      '<blockquote><p>Dig gently.</p></blockquote><ul><li><p>water</p></li><li><p>wait</p></li></ul>';
    const page = M.parsePostPage({ post: { ...w.myPost, body_html: body }, publication: MY_PUB }, ctx)!;
    expect(page.article).toBe(
      [
        'Soil is **alive**, see [worms](https://acmenotes.substack.com/p/worms).',
        '## Roots',
        '[![a root](https://substackcdn.com/image/root.png)](https://substackcdn.com/image/full.png)',
        '_A root_',
        '> Dig gently.',
        '- water\n- wait',
      ].join('\n\n'),
    );
    expect(page.text).toBe('A short one\n\nSoil is alive.');
    expect(M.postFact({ ...w.myPost, body_html: body }, ctx)!.article).toBeUndefined();
    expect(M.parsePostPage({ post: { ...w.myPost, body_html: '' }, publication: MY_PUB }, ctx)!.article).toBeUndefined();
  });
});

describe('home timelines', () => {
  test('the Inbox: newest posts first, with their publications; more only while Substack says there is', () => {
    const w = world(NOW);
    const ctx = fresh();
    const page = M.parseInbox({ posts: [w.myPost, w.annPost], publications: [MY_PUB, ANN_PUB], inboxItems: [], cursor: 'CUR1', more: true }, ctx);
    expect(page.items.map((i) => i.post.id)).toEqual(['p-9002', 'p-9001']);
    expect(page.items[0]!.post.place?.name).toBe('Garden Weekly');
    expect(page.more).toBe('CUR1');
    expect(M.parseInbox({ posts: [], publications: [], cursor: 'CUR2', more: false }, ctx).more).toBeNull();
  });
  test('Notes: notes and posts, a restack and a like as reasons, the notes above a reply, everything else left out', () => {
    const w = world(NOW);
    const ctx = fresh();
    const page = M.parseNotes(
      {
        items: [
          noteItem(w.annNote),
          noteItem(w.annNote, { context: 'comment_restack', by: BEN }),
          noteItem(w.annOnBen, { context: 'note_reply', parents: [w.annNote, w.benOnAnn] }),
          postItem(w.annPost, ANN_PUB, { context: 'comment_like', by: CAL }),
          { type: 'user_suggestions', users: [] },
        ],
        nextCursor: 'N2',
      },
      ctx,
    );
    expect(page.items.map((i) => i.post.id)).toEqual(['c-7005', 'c-7005', 'c-7008', 'p-9002']);
    expect(page.items[0]!.reason).toBeUndefined();
    expect(page.items[1]!.reason).toEqual({ text: 'Ben Ode restacked', kind: 'other', who: String(BEN.id) });
    expect(page.items[2]!.above?.map((p) => p.id)).toEqual(['c-7005', 'c-7007']);
    expect(page.items[3]!.reason).toEqual({ text: 'Cal Moe liked', kind: 'like', who: String(CAL.id) });
    expect(page.more).toBe('N2');
    expect(ctx.drops.counts.get('feed.user_suggestions')).toBe(1);
  });
});

describe('threads and profiles', () => {
  test('comment branches are reply chains; the cursor comes back as more', () => {
    const w = world(NOW);
    const got = M.parseBranches({ commentBranches: [branch(w.benOnAnn, w.annOnBen)], nextCursor: 'R2', moreBranches: 3 }, fresh());
    expect(got.replies.map((c) => c.map((p) => p.id))).toEqual([['c-7007', 'c-7008']]);
    expect(got.more).toBe('R2');
  });
  test("a note's page: the post it is on first, then the comments above it, then the note", () => {
    const w = world(NOW);
    const got = M.parseNotePage({ item: { ...noteItem(w.myReplyToBen, { parents: [w.benComment] }), post: w.myPost, publication: MY_PUB } }, fresh());
    expect(got.ancestors.map((p) => p.id)).toEqual(['p-9001', 'c-7003']);
    expect(got.focal?.id).toBe('c-7004');
  });
  test('a profile: name, bio, follows, what they write, and their own notes and posts newest first', () => {
    const w = world(NOW);
    const ctx = fresh();
    const u = M.parseProfile(publicProfile(ANN, { pub: ANN_PUB, following: true, followsYou: false }), ctx)!;
    const posts = M.parseProfileFeed({ items: [noteItem(w.annNote), postItem(w.annPost, ANN_PUB), noteItem(w.benOnAnn)] }, String(ANN.id), ctx);
    expect(M.personAbout(u, posts)).toEqual({
      displayName: 'Ann Lee',
      handle: 'annlee',
      avatar: ANN.photo_url!,
      bio: 'Gardens, mostly.',
      relationship: 'following',
      followsYou: false,
      counts: { followers: 42 },
      links: [
        { label: 'Substack', value: '@annlee', url: 'https://substack.com/@annlee' },
        { label: 'Garden Weekly', value: 'garden.example.com', url: 'https://garden.example.com' },
      ],
      facts: [
        { label: 'Writes', value: 'Garden Weekly' },
        { label: 'Subscribers', value: '7' },
      ],
      posts: [expect.objectContaining({ id: 'p-9002' }), expect.objectContaining({ id: 'c-7005' })],
    });
  });
});

describe('activity', () => {
  test('one message per person: likes, restacks, replies, comments, quotes, subscribers, follows, Substack’s own; lives left out', () => {
    const w = world(NOW);
    const ctx = fresh();
    const page = M.parseActivity(activity(w, NOW, { more: true }), SELF, ctx);
    const byId = Object.fromEntries(page.entries.map((e) => [e.nativeId, e]));
    expect(page.entries.map((e) => e.nativeId)).toEqual([
      'reply:c-7002',
      `like:p-9001:${ANN.id}`,
      `like:p-9001:${BEN.id}`,
      `like:c-7001:${BEN.id}`,
      'reply:c-7003',
      `repost:c-7001:${CAL.id}`,
      'quote:c-7006',
      `follow:${CAL.id}:free_subscription:5001`,
      `follow:${ANN.id}`,
      'other:viral_post-' + (NOW - 9 * 3600_000) + ':-',
    ]);
    expect(byId['reply:c-7002']).toMatchObject({ type: 'reply', actor: String(ANN.id), kind: 'text', body: 'So true, and cheap too.', item: { type: 'reply', theirs: { id: 'c-7002' }, post: { id: 'c-7001' } } });
    expect(byId[`like:c-7001:${BEN.id}`]).toMatchObject({ kind: 'system', body: 'liked your note', item: { type: 'like', post: { id: 'c-7001' } } });
    expect(byId[`like:p-9001:${ANN.id}`]!.body).toBe('liked your post');
    expect(byId['reply:c-7003']).toMatchObject({ item: { theirs: { id: 'c-7003', replyTo: { id: 'p-9001' } }, post: { id: 'p-9001', title: 'Why soil matters' } } });
    expect(byId[`repost:c-7001:${CAL.id}`]!.body).toBe('restacked your note');
    expect(byId['quote:c-7006']).toMatchObject({ type: 'quote', item: { theirs: { quoteOf: { id: 'p-9001' } }, post: { id: 'p-9001' } } });
    expect(byId[`follow:${CAL.id}:free_subscription:5001`]).toMatchObject({ type: 'follow', body: 'subscribed to ACME Notes', item: { url: 'https://acmenotes.substack.com' } });
    expect(page.entries.at(-1)).toMatchObject({ actor: M.SUBSTACK_ACTOR, type: 'other', body: 'Your post has received a lot of traffic over the last 24 hours' });
    expect(ctx.drops.counts.get('activity.live_stream')).toBe(1);
    expect(page.more).toBe(true);
    expect(page.oldest).toBe(new Date(NOW - 10 * 3600_000).toISOString());
  });
  test('as chat facts: the feed conversation, replies and mentions mention you', () => {
    const page = M.parseActivity(activity(world(NOW), NOW), SELF, fresh());
    expect(M.feedConversation()).toEqual({ nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Activity' });
    const reply = M.feedMessage(page.entries[0]!);
    expect(reply).toMatchObject({ nativeId: 'reply:c-7002', conversation: 'feed', author: String(ANN.id), kind: 'text', mentionsSelf: true, extra: { feed: { type: 'reply' } } });
    expect(M.feedMessage(page.entries[1]!).mentionsSelf).toBeUndefined();
  });
  test('the tracker: the conversation once, people when they change, live only what is new and fresh', () => {
    const t = new FeedTracker();
    const ctx = fresh();
    const page = M.parseActivity(activity(world(NOW), NOW), SELF, ctx);
    const first = [...t.identities(ctx.users.values(), SELF), ...t.messages(page.entries, { now: NOW, backfill: true })];
    expect(first.filter((e) => e.t === 'conversation')).toHaveLength(1);
    expect(first.find((e) => e.t === 'identity' && e.identity.nativeId === SELF)).toMatchObject({ identity: { isSelf: true, handle: 'quinn' } });
    expect(first.filter((e) => e.t === 'message').every((e) => e.t === 'message' && !e.live)).toBe(true);
    expect(t.identities(ctx.users.values(), SELF)).toEqual([]);
    // Later, a new reply under 15 minutes old is live; the ones announced are not again.
    const later = NOW + 60_000;
    const newer = { ...page.entries[0]!, nativeId: 'reply:c-7999', ts: later - 1000 };
    const evs = t.messages([newer, page.entries[1]!], { now: later, backfill: false });
    const live = Object.fromEntries(evs.filter((e) => e.t === 'message').map((e) => [e.t === 'message' && e.message.nativeId, e.t === 'message' && e.live]));
    expect(live).toEqual({ 'reply:c-7999': true, [page.entries[1]!.nativeId]: false });
    expect(t.messages([{ ...newer, nativeId: 'reply:c-old', ts: later - LIVE_MS - 1 }], { now: later, backfill: false }).find((e) => e.t === 'message')).toMatchObject({ live: false });
    const kept = new FeedTracker(t.kept());
    expect(kept.has('reply:c-7999')).toBe(true);
    expect(kept.fresh).toBe(false);
    expect(t.stubs([M.SUBSTACK_ACTOR, '555', 'not-an-id'])).toEqual([
      { t: 'identity', identity: { nativeId: 'substack', displayName: 'Substack' } },
      { t: 'identity', identity: { nativeId: '555' } },
    ]);
  });
});

describe('status', () => {
  const base = (over: Partial<Facts> = {}): Facts => ({
    now: NOW,
    sandbox: { started: true, error: null, browserAlive: true, display: 90, liveView: true, startedAt: NOW - 5000 },
    extensionAttached: true,
    tab: 'https://substack.com/settings',
    page: { state: 'ready', path: '/settings', since: NOW - 1000 },
    self: { id: SELF, handle: 'quinn' },
    hookVersion: 1,
    feed: { items: 3, lastFetch: NOW - 1000, lastError: null, nextAt: null, dropped: null },
    lastCommand: null,
    ...over,
  });
  test('signed in: online, every layer ok', () => {
    const c = compute(base());
    expect(c.status).toBe('online');
    expect(c.attention).toBeNull();
    expect(c.layers.map((l) => [l.name, l.state])).toEqual([
      ['display', 'ok'],
      ['browser', 'ok'],
      ['extension', 'ok'],
      ['signed in', 'ok'],
      ['activity', 'ok'],
    ]);
    expect(c.layers.find((l) => l.name === 'signed in')!.note).toBe('as @quinn');
  });
  test('signed out: it asks you to sign in in the live view', () => {
    const c = compute(base({ page: { state: 'login', path: '/sign-in', since: NOW }, self: null }));
    expect(c.status).toBe('attention');
    expect(c.attention).toEqual({ kind: 'login', message: 'Sign in to Substack in the live view', liveView: true });
  });
  test('an extension that never connects is an error after a minute; a failed read is the activity layer’s only', () => {
    expect(compute(base({ extensionAttached: false })).status).toBe('connecting');
    expect(compute(base({ extensionAttached: false, sandbox: { ...base().sandbox, startedAt: NOW - 120_000 } })).status).toBe('error');
    const c = compute(base({ feed: { items: 0, lastFetch: null, lastError: 'Substack answered 500', nextAt: null, dropped: null } }));
    expect(c.status).toBe('online');
    expect(c.layers.at(-1)).toEqual({ name: 'activity', state: 'failed', note: 'last read failed: Substack answered 500' });
  });
});
