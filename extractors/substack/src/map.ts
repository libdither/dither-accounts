/**
 * Substack's reader JSON, checked here and mapped to chat facts (packages/chat-protocol feed.ts, docs/substack.md).
 * Pure: no I/O.
 *
 * What it reads (substack.com's reader, 2026):
 *   - users, in four shapes: a profile (`public_profile`: id, name, handle, photo_url, bio, followerCount,
 *     subscriberCountNumber, isFollowing, followsViewer, primaryPublication), a feed context's `users[]`, an activity
 *     answer's `users[]`, and the author fields of a comment (user_id, name, handle, photo_url);
 *   - publications (`pub`, `publication`, `pubs[]`, `publications[]`): id, name, subdomain, custom_domain, author_id;
 *   - posts: id, publication_id, title, subtitle, description, truncated_body_text, canonical_url, post_date, audience
 *     ('everyone', 'only_paid', 'founding'), cover_image, reaction_count, reaction ('❤' when you liked it),
 *     comment_count, restacks, restacked, publishedBylines[], language;
 *   - comments, which are notes too (Substack keeps both in one table; a note has no post_id): id, body, body_json,
 *     user_id, post_id, publication_id, date, ancestor_path ("1.2.3": the comments above it, the thread's first first),
 *     reaction_count, reaction, restacks, restacked, children_count, attachments[] (images; a post or note it quotes);
 *   - feed items (Notes, a profile's feed, a note's page): { type: 'comment' | 'post' | …, comment, post, publication,
 *     parentComments[], context: { type, users[], timestamp } };
 *   - comment branches (a post's or note's replies): { commentBranches: [{ comment, descendantComments: [{ type, comment
 *     }] }], nextCursor };
 *   - the Activity list: { activityItems: [{ type, item_key, updated_at, recent_sender_ids[], publication_id,
 *     target_post_id, comment_id, target_comment_id, mention_id }], pubs, posts, users, comments, mentions, more }.
 *
 * Ids: Substack's own entity keys, `p-<id>` for a post and `c-<id>` for a note or comment, so a post and a note never
 * share one. A person is their user id. Anything without what the mapping needs is dropped and counted.
 */
import type * as P from '@dither-chat/protocol';

export const SITE = 'https://substack.com';
/** The author of an activity item no person sent ("Your post has received a lot of traffic"). */
export const SUBSTACK_ACTOR = 'substack';
export const FEED_CONV = 'feed';
/** At most this many posts in a profile. */
export const PROFILE_POSTS = 20;

export class Drops {
  readonly counts = new Map<string, number>();
  add(kind: string) {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }
  get total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
  summary(max = 5): string | null {
    if (!this.counts.size) return null;
    return [...this.counts].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, v]) => `${k} ${v}`).join(', ');
  }
}

export interface SsUser {
  id: string;
  name: string | null;
  handle: string | null;
  photo: string | null;
  bio: string | null;
}
export interface SsPub {
  id: string;
  name: string;
  url: string | null;
  authorId: string | null;
}
/** Where a note or comment sits, to answer it or like it later: its post and publication (null for a note). */
export interface CommentPlace {
  post: string | null;
  pub: string | null;
}

export interface Ctx {
  drops: Drops;
  testOrigin?: string | null;
  users: Map<string, SsUser>;
  pubs: Map<string, SsPub>;
  /** Posts read, by their id: what a comment on one needs (its link, its publication). */
  posts: Map<string, Record<string, any>>;
  /** Every note and comment met: where it sits. */
  places: Map<string, CommentPlace>;
}
export const newCtx = (drops: Drops, testOrigin?: string | null): Ctx => ({ drops, testOrigin, users: new Map(), pubs: new Map(), posts: new Map(), places: new Map() });

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 50_000): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const ID = /^\d{1,15}$/;
export const sid = (v: unknown): string | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? String(v) : typeof v === 'string' && ID.test(v) ? v : null);
const HANDLE = /^[\w.-]{1,60}$/;
/** Substack's times are ISO strings; between 2017 (Substack) and a day from now, in ms. */
export function ssTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 1_483_228_800_000 && ms < Date.now() + 86_400_000 ? ms : null;
}

export const postKey = (id: string) => `p-${id}`;
export const commentKey = (id: string) => `c-${id}`;
/** A post id as the hub has it (`p-123`, `c-456`), split; null when it is neither. */
export function parseKey(key: unknown): { on: 'post' | 'comment'; id: string } | null {
  if (typeof key !== 'string') return null;
  const m = /^([pc])-(\d{1,15})$/.exec(key);
  return m ? { on: m[1] === 'p' ? 'post' : 'comment', id: m[2]! } : null;
}

/** A picture Substack serves (its CDN, its uploads), or the test origin's. */
export function mediaUrl(v: unknown, testOrigin?: string | null): string | null {
  if (typeof v !== 'string' || v.length > 4096) return null;
  if (testOrigin && v.startsWith(`${testOrigin}/`)) return v;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && (/(^|\.)substackcdn\.com$/.test(u.hostname) || u.hostname === 'substack-post-media.s3.amazonaws.com')) return v;
  } catch {}
  return null;
}
/** A link to open: https only. */
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
};

// -------------------------------------------------------------------- people
/** Any of Substack's user shapes; the comment's own author fields with `fromComment`. */
export function userOf(v: unknown, ctx: Ctx, fromComment = false): SsUser | null {
  if (!isObj(v)) return null;
  const id = sid(fromComment ? v.user_id : v.id);
  if (!id) {
    ctx.drops.add('user.bad-id');
    return null;
  }
  const handle = str(v.handle, 80);
  const u: SsUser = {
    id,
    name: str(v.name, 200),
    handle: handle && HANDLE.test(handle) ? handle : null,
    photo: mediaUrl(v.photo_url, ctx.testOrigin),
    bio: fromComment ? null : str(v.bio, 2000),
  };
  const had = ctx.users.get(id);
  // What is known stays known: a comment's author has no bio, a context's user no handle at times.
  const merged: SsUser = had ? { id, name: u.name ?? had.name, handle: u.handle ?? had.handle, photo: u.photo ?? had.photo, bio: u.bio ?? had.bio } : u;
  ctx.users.set(id, merged);
  return merged;
}

export function identityFact(u: SsUser, selfId: string | null): P.IdentityFact {
  return {
    nativeId: u.id,
    ...(u.handle ? { handle: u.handle } : {}),
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.photo ? { avatarUrl: u.photo } : {}),
    ...(selfId && u.id === selfId ? { isSelf: true } : {}),
  };
}
export const substackIdentity = (): P.IdentityFact => ({ nativeId: SUBSTACK_ACTOR, displayName: 'Substack' });

export function profileUrl(u: { id: string; handle: string | null }): string {
  return u.handle ? `${SITE}/@${u.handle}` : `${SITE}/profile/${u.id}`;
}

// ------------------------------------------------------------- publications
export function pubOf(v: unknown, ctx: Ctx): SsPub | null {
  if (!isObj(v)) return null;
  const id = sid(v.id);
  const name = str(v.name, 300);
  if (!id || !name) {
    ctx.drops.add('pub.incomplete');
    return null;
  }
  const domain = str(v.custom_domain, 200);
  const sub = str(v.subdomain, 100);
  const url = domain && /^[a-z0-9.-]+$/i.test(domain) ? `https://${domain}` : sub && /^[a-z0-9-]+$/i.test(sub) ? `https://${sub}.substack.com` : null;
  const p: SsPub = { id, name, url, authorId: sid(v.author_id) };
  ctx.pubs.set(id, p);
  return p;
}
const placeOf = (p: SsPub): NonNullable<P.PostFact['place']> => ({ id: p.id, name: p.name, ...(p.url ? { url: p.url } : {}) });

// -------------------------------------------------------------------- posts
const WARNING: Record<string, string> = { only_paid: 'Paid subscribers only', founding: 'Founding members only' };

/** A newsletter post: its title, the subtitle and its preview as the words, its publication as the place. */
export function postFact(v: unknown, ctx: Ctx, pubHint?: unknown): P.PostFact | null {
  if (!isObj(v)) return null;
  const id = sid(v.id);
  const ts = ssTime(v.post_date);
  if (!id || ts === null) {
    ctx.drops.add(id ? 'post.no-time' : 'post.bad-id');
    return null;
  }
  ctx.posts.set(id, v);
  const pubId = sid(v.publication_id);
  const pub = (pubHint !== undefined ? pubOf(pubHint, ctx) : null) ?? (pubId ? ctx.pubs.get(pubId) ?? null : null);
  const bylines = arr(v.publishedBylines).map((b) => userOf(b, ctx)).filter((u): u is SsUser => !!u);
  const author = bylines[0]?.id ?? pub?.authorId ?? undefined;
  const title = str(v.title, 500);
  const subtitle = str(v.subtitle, 1000) ?? str(v.description, 1000);
  const preview = str(v.truncated_body_text, 5000) ?? str(v.previewText, 5000);
  const text = [subtitle, preview && preview !== subtitle ? preview : null].filter(Boolean).join('\n\n');
  const cover = mediaUrl(v.cover_image, ctx.testOrigin);
  const counts: NonNullable<P.PostFact['counts']> = {};
  const likes = num(v.reaction_count);
  const replies = num(v.comment_count);
  const reposts = num(v.restacks);
  if (likes !== null) counts.likes = likes;
  if (replies !== null) counts.replies = replies;
  if (reposts !== null) counts.reposts = reposts;
  const viewer: P.PostViewer = {};
  if ('reaction' in v) viewer.liked = !!v.reaction;
  if (typeof v.restacked === 'boolean') viewer.reposted = v.restacked;
  const warning = typeof v.audience === 'string' ? WARNING[v.audience] : undefined;
  return {
    id: postKey(id),
    url: httpsUrl(v.canonical_url) ?? `${SITE}/home/post/p-${id}`,
    ts,
    ...(author ? { author } : {}),
    text,
    ...(title ? { title } : {}),
    ...(warning ? { warning } : {}),
    ...(pub ? { place: placeOf(pub) } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(cover ? { media: [{ kind: 'image' as const, url: cover }] } : {}),
    ...(Object.keys(viewer).length ? { viewer } : {}),
    ...(str(v.language, 20) ? { lang: str(v.language, 20)! } : {}),
  };
}

/** A note's or comment's words: its plain body, else the text of its ProseMirror document. */
export function bodyText(v: Record<string, any>): string {
  const plain = str(v.body, 50_000);
  if (plain) return plain;
  const out: string[] = [];
  const walk = (n: unknown, depth: number) => {
    if (!isObj(n) || depth > 30) return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (n.type === 'hard_break') out.push('\n');
    for (const c of arr(n.content)) walk(c, depth + 1);
    if (n.type === 'paragraph' || n.type === 'heading') out.push('\n\n');
  };
  walk(v.body_json, 0);
  return out.join('').trim().slice(0, 50_000);
}

/** A note, or a comment on a post (`post_id`): who wrote it, what it answers, the thread it is in. */
export function commentFact(v: unknown, ctx: Ctx, depth = 0): P.PostFact | null {
  if (!isObj(v)) return null;
  const id = sid(v.id);
  const ts = ssTime(v.date);
  if (!id || ts === null) {
    ctx.drops.add(id ? 'comment.no-time' : 'comment.bad-id');
    return null;
  }
  if (v.deleted === true) {
    ctx.drops.add('comment.deleted');
    return null;
  }
  const author = userOf(v, ctx, true);
  const postId = sid(v.post_id);
  const pubId = sid(v.publication_id);
  ctx.places.set(id, { post: postId, pub: pubId });
  const ancestors = (typeof v.ancestor_path === 'string' ? v.ancestor_path : '').split('.').filter((x) => ID.test(x));
  const parent = ancestors.at(-1);
  const rawPost = postId ? ctx.posts.get(postId) : undefined;
  const replyTo = parent ? { id: commentKey(parent) } : postId ? { id: postKey(postId), ...(rawPost ? authorOfPost(rawPost, ctx) : {}) } : undefined;
  const root = ancestors[0] ? commentKey(ancestors[0]) : postId ? postKey(postId) : undefined;
  const postUrl = rawPost ? httpsUrl(rawPost.canonical_url) : null;
  const url = postId ? `${postUrl ?? `${SITE}/home/post/p-${postId}`}/comment/${id}` : `${author ? profileUrl(author) : SITE}/note/c-${id}`;
  const media: P.PostMedia[] = [];
  let quoteOf: P.PostFact | undefined;
  for (const a of arr(v.attachments)) {
    if (!isObj(a)) continue;
    if (a.type === 'image') {
      const u = mediaUrl(a.imageUrl, ctx.testOrigin);
      if (u) media.push({ kind: 'image', url: u, ...(num(a.imageWidth) ? { width: num(a.imageWidth)! } : {}), ...(num(a.imageHeight) ? { height: num(a.imageHeight)! } : {}) });
    } else if (a.type === 'post' && !quoteOf && depth < 1) {
      quoteOf = postFact(a.post, ctx, a.publication) ?? undefined;
    } else if (a.type === 'comment' && !quoteOf && depth < 1) {
      quoteOf = commentFact(isObj(a.comment) && isObj(a.comment.comment) ? a.comment.comment : a.comment, ctx, depth + 1) ?? undefined;
    }
  }
  const counts: NonNullable<P.PostFact['counts']> = {};
  const likes = num(v.reaction_count);
  const replies = num(v.children_count);
  const reposts = num(v.restacks);
  if (likes !== null) counts.likes = likes;
  if (replies !== null) counts.replies = replies;
  if (reposts !== null) counts.reposts = reposts;
  const viewer: P.PostViewer = {};
  if ('reaction' in v) viewer.liked = !!v.reaction;
  if (typeof v.restacked === 'boolean') viewer.reposted = v.restacked;
  const pub = pubId ? ctx.pubs.get(pubId) : undefined;
  return {
    id: commentKey(id),
    url,
    ts,
    ...(author ? { author: author.id } : {}),
    text: bodyText(v),
    ...(replyTo ? { replyTo } : {}),
    ...(root ? { root } : {}),
    ...(quoteOf ? { quoteOf } : {}),
    ...(pub ? { place: placeOf(pub) } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(media.length ? { media: media.slice(0, 10) } : {}),
    ...(Object.keys(viewer).length ? { viewer } : {}),
    ...(str(v.language, 20) ? { lang: str(v.language, 20)! } : {}),
  };
}
function authorOfPost(p: Record<string, any>, ctx: Ctx): { author?: string } {
  const b = arr(p.publishedBylines).map((x) => (isObj(x) ? sid(x.id) : null)).find(Boolean);
  const pub = sid(p.publication_id);
  const a = b ?? (pub ? ctx.pubs.get(pub)?.authorId : null);
  return a ? { author: a } : {};
}

// ------------------------------------------------------------ feeds (Notes)
const REASON: Record<string, [kind: NonNullable<P.HomeReason['kind']>, words: string]> = {
  comment_restack: ['other', 'restacked'],
  post_restack: ['other', 'restacked'],
  comment_like: ['like', 'liked'],
  note_reply: ['reply', 'replied'],
  post_comment: ['reply', 'commented'],
};

/** One feed item (Notes, a profile's feed, a note's page) as a home item; null for what is not a post or a note. */
export function feedItem(v: unknown, ctx: Ctx): P.HomeItem | null {
  if (!isObj(v)) return null;
  if (v.publication) pubOf(v.publication, ctx);
  const ctxUsers = isObj(v.context) ? arr(v.context.users).map((u) => userOf(u, ctx)).filter((u): u is SsUser => !!u) : [];
  let post: P.PostFact | null = null;
  const above: P.PostFact[] = [];
  if (v.type === 'comment' && isObj(v.comment)) {
    if (isObj(v.post)) postFact(v.post, ctx, v.publication ?? undefined);
    for (const p of arr(v.parentComments)) {
      const f = commentFact(p, ctx);
      if (f) above.push(f);
    }
    post = commentFact(v.comment, ctx);
  } else if (v.type === 'post' && isObj(v.post)) {
    post = postFact(v.post, ctx, v.publication ?? undefined);
  } else {
    ctx.drops.add(`feed.${typeof v.type === 'string' ? v.type.replace(/[^\w-]/g, '').slice(0, 30) : 'unknown'}`);
    return null;
  }
  if (!post) return null;
  const type = isObj(v.context) && typeof v.context.type === 'string' ? v.context.type : '';
  const r = REASON[type];
  const who = ctxUsers.find((u) => u.id !== post!.author) ?? null;
  const reason: P.HomeReason | undefined = r && who ? { text: `${who.name ?? (who.handle ? `@${who.handle}` : 'Someone')} ${r[1]}`, kind: r[0], who: who.id } : undefined;
  return { post, ...(reason ? { reason } : {}), ...(above.length ? { above } : {}) };
}

export function parseNotes(v: unknown, ctx: Ctx): P.HomePage {
  const items: P.HomeItem[] = [];
  if (!isObj(v)) {
    ctx.drops.add('notes.not-an-answer');
    return { items, more: null, top: null };
  }
  for (const it of arr(v.items)) {
    const h = feedItem(it, ctx);
    if (h) items.push(h);
  }
  return { items, more: str(v.nextCursor, 2000), top: null };
}

/** The Inbox: posts from what you subscribe to, newest first. */
export function parseInbox(v: unknown, ctx: Ctx): P.HomePage {
  const items: P.HomeItem[] = [];
  if (!isObj(v)) {
    ctx.drops.add('inbox.not-an-answer');
    return { items, more: null, top: null };
  }
  for (const p of arr(v.publications)) pubOf(p, ctx);
  for (const p of arr(v.posts)) {
    const f = postFact(p, ctx);
    if (f) items.push({ post: f });
  }
  items.sort((a, b) => b.post.ts - a.post.ts);
  const cursor = str(v.cursor, 2000) ?? str(v.nextCursor, 2000);
  return { items, more: v.more === false ? null : cursor, top: null };
}

// ------------------------------------------------------------------ threads
/** Comment branches as reply chains: each top-level reply, then the replies under it in Substack's order. */
export function parseBranches(v: unknown, ctx: Ctx): { replies: P.PostFact[][]; more: string | null } {
  const replies: P.PostFact[][] = [];
  if (!isObj(v)) {
    ctx.drops.add('replies.not-an-answer');
    return { replies, more: null };
  }
  for (const b of arr(v.commentBranches)) {
    if (!isObj(b)) continue;
    const head = commentFact(b.comment, ctx);
    if (!head) continue;
    const chain = [head];
    for (const d of arr(b.descendantComments)) {
      if (!isObj(d) || (d.type !== undefined && d.type !== 'comment')) continue;
      const f = commentFact(d.comment, ctx);
      if (f) chain.push(f);
    }
    replies.push(chain);
  }
  return { replies, more: str(v.nextCursor, 2000) };
}

/** A note's page (`/reader/comment/<id>`): the note, and what it answers (the post first, when it is a comment on one). */
export function parseNotePage(v: unknown, ctx: Ctx): { focal: P.PostFact | null; ancestors: P.PostFact[] } {
  const item = isObj(v) ? v.item : null;
  if (!isObj(item)) {
    ctx.drops.add('note.not-an-answer');
    return { focal: null, ancestors: [] };
  }
  if (item.publication) pubOf(item.publication, ctx);
  const ancestors: P.PostFact[] = [];
  if (isObj(item.post)) {
    const p = postFact(item.post, ctx, item.publication ?? undefined);
    if (p) ancestors.push(p);
  }
  for (const c of arr(item.parentComments)) {
    const f = commentFact(c, ctx);
    if (f) ancestors.push(f);
  }
  return { focal: commentFact(item.comment, ctx), ancestors };
}

/** A post's page (`/posts/by-id/<id>`): the post with its publication. */
export function parsePostPage(v: unknown, ctx: Ctx): P.PostFact | null {
  if (!isObj(v)) return null;
  return postFact(v.post, ctx, v.publication ?? undefined);
}

/** What the composer's answer says it made: the note or comment (bare, or under `comment`). */
export function parsePublished(v: unknown, ctx: Ctx): P.PostFact | null {
  if (!isObj(v)) return null;
  return commentFact(isObj(v.comment) && sid(v.comment.id) ? v.comment : v, ctx);
}

// ----------------------------------------------------------------- profiles
export interface ProfileUser extends SsUser {
  followers: number | null;
  subscribers: number | null;
  following: boolean | null;
  followsYou: boolean | null;
  writes: SsPub | null;
}
export function parseProfile(v: unknown, ctx: Ctx): ProfileUser | null {
  const u = userOf(v, ctx);
  if (!u || !isObj(v)) return null;
  const writes = v.primaryPublication ? pubOf(v.primaryPublication, ctx) : null;
  return {
    ...u,
    followers: num(v.followerCount),
    subscribers: num(v.subscriberCountNumber),
    following: typeof v.isFollowing === 'boolean' ? v.isFollowing : null,
    followsYou: typeof v.followsViewer === 'boolean' ? v.followsViewer : null,
    writes,
  };
}
export function personAbout(u: ProfileUser, posts: P.PostFact[]): P.PersonAbout {
  const counts: NonNullable<P.PersonAbout['counts']> = {};
  if (u.followers !== null) counts.followers = u.followers;
  const facts: NonNullable<P.PersonAbout['facts']> = [];
  if (u.writes) facts.push({ label: 'Writes', value: u.writes.name });
  if (u.subscribers !== null && u.subscribers > 0) facts.push({ label: 'Subscribers', value: String(u.subscribers) });
  const links: NonNullable<P.PersonAbout['links']> = [{ label: 'Substack', value: u.handle ? `@${u.handle}` : u.name ?? u.id, url: profileUrl(u) }];
  if (u.writes?.url) links.push({ label: u.writes.name, value: u.writes.url.replace(/^https:\/\//, ''), url: u.writes.url });
  return {
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.handle ? { handle: u.handle } : {}),
    ...(u.photo ? { avatar: u.photo } : {}),
    ...(u.bio ? { bio: u.bio } : {}),
    ...(u.following ? { relationship: 'following' as const } : {}),
    ...(u.followsYou !== null ? { followsYou: u.followsYou } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    links,
    ...(facts.length ? { facts } : {}),
    ...(posts.length ? { posts: posts.slice(0, PROFILE_POSTS) } : {}),
  };
}
/** A profile's feed: their notes and posts (restacks of others' left out), newest first. */
export function parseProfileFeed(v: unknown, who: string, ctx: Ctx): P.PostFact[] {
  const out: P.PostFact[] = [];
  for (const it of arr(isObj(v) ? v.items : null)) {
    const h = feedItem(it, ctx);
    if (h && h.post.author === who) out.push(h.post);
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, PROFILE_POSTS);
}

// ----------------------------------------------------------------- activity
/** One message of the feed conversation: what one person did. */
export interface FeedEntry {
  nativeId: string;
  type: P.FeedItemType;
  /** A user id, or SUBSTACK_ACTOR. */
  actor: string;
  ts: number;
  kind: 'system' | 'text';
  body: string;
  item: P.FeedItem;
}
export interface ActivityPage {
  entries: FeedEntry[];
  /** The oldest item's time as Substack wrote it, for the next page back (`after`, less 1 ms), or null. */
  oldest: string | null;
  more: boolean;
}

const SUBSCRIBE: Record<string, string> = {
  free_subscription: 'subscribed to',
  paid_subscription: 'became a paid subscriber to',
  pledged_subscription: 'pledged to',
  referred_free_subscription: 'subscribed, referred by you, to',
  recommended_free_subscription: 'subscribed from a recommendation to',
};
const OTHER: Record<string, string> = {
  viral_post: 'Your post has received a lot of traffic over the last 24 hours',
  total_earnings: 'Your total earnings and payouts are in Creator Stats',
  user_first_note: 'posted their first note',
  new_profile: 'joined Substack',
  leaderboard_update: 'Your publication moved on a leaderboard',
  comment_arr: 'Your note brought paid subscribers',
};
const what = (on: 'post' | 'comment', c: Record<string, any> | undefined) => (on === 'post' ? 'post' : c && !sid(c.post_id) ? 'note' : 'comment');

/**
 * One page of the Activity list as feed messages, one per person (feed.ts FeedItem): likes and restacks per thing and
 * person; replies, comments, mentions and quoting restacks per their note or comment; new followers and subscribers per
 * person; anything else in words of its own, per person or from Substack.
 */
export function parseActivity(v: unknown, selfId: string | null, ctx: Ctx): ActivityPage {
  const entries: FeedEntry[] = [];
  if (!isObj(v)) {
    ctx.drops.add('activity.not-an-answer');
    return { entries, oldest: null, more: false };
  }
  for (const p of arr(v.pubs)) pubOf(p, ctx);
  for (const u of arr(v.users)) userOf(u, ctx);
  const posts = new Map<string, Record<string, any>>();
  for (const p of arr(v.posts).concat(arr(v.drafts))) if (isObj(p) && sid(p.id)) posts.set(sid(p.id)!, p);
  const comments = new Map<string, Record<string, any>>();
  for (const c of arr(v.comments)) if (isObj(c) && sid(c.id)) comments.set(sid(c.id)!, c);
  for (const f of arr(v.feedItemComments)) if (isObj(f) && isObj(f.comment) && sid(f.comment.id) && !comments.has(sid(f.comment.id)!)) comments.set(sid(f.comment.id)!, f.comment);
  const mentions = new Map<string, Record<string, any>>();
  for (const m of arr(v.mentions)) if (isObj(m) && sid(m.id)) mentions.set(sid(m.id)!, m);
  // Posts first, so a comment on one links to it.
  const postFacts = new Map<string, P.PostFact>();
  for (const [id, p] of posts) {
    const f = postFact(p, ctx);
    if (f) postFacts.set(id, f);
  }
  const commentFacts = new Map<string, P.PostFact>();
  const commentOf = (id: string | null) => {
    if (!id) return undefined;
    if (!commentFacts.has(id)) {
      const f = commentFact(comments.get(id), ctx);
      if (f) commentFacts.set(id, f);
    }
    return commentFacts.get(id);
  };
  let oldest: string | null = null;
  let oldestMs = Infinity;
  for (const raw of arr(v.activityItems)) {
    if (!isObj(raw)) continue;
    const type = typeof raw.type === 'string' ? raw.type : '';
    const ts = ssTime(raw.updated_at);
    if (ts === null) {
      ctx.drops.add('activity.no-time');
      continue;
    }
    if (ts < oldestMs) {
      oldestMs = ts;
      oldest = raw.updated_at;
    }
    const key = str(raw.item_key, 200)?.replace(/[^\w.:-]/g, '') || `${type}-${ts}`;
    const senders = arr(raw.recent_sender_ids).map(sid).filter((x): x is string => !!x && x !== selfId);
    const pubId = sid(raw.publication_id);
    const pub = pubId ? ctx.pubs.get(pubId) : undefined;
    const post = sid(raw.target_post_id) ? postFacts.get(sid(raw.target_post_id)!) : undefined;
    const target = commentOf(sid(raw.target_comment_id));
    const targetRaw = sid(raw.target_comment_id) ? comments.get(sid(raw.target_comment_id)!) : undefined;
    const theirs = commentOf(sid(raw.comment_id));
    const mine = target ?? post;
    const add = (e: FeedEntry) => entries.push(e);
    const perSender = (t: 'like' | 'repost', thing: P.PostFact | undefined, words: string) => {
      if (!thing) return void ctx.drops.add(`activity.${type}.no-target`);
      for (const s of senders) add({ nativeId: `${t}:${thing.id}:${s}`, type: t, actor: s, ts, kind: 'system', body: words, item: { type: t, post: thing, url: thing.url } });
    };
    switch (type) {
      case 'post_like':
        perSender('like', post, 'liked your post');
        break;
      case 'note_like':
      case 'comment_like':
        perSender('like', target, `liked your ${what('comment', targetRaw)}`);
        break;
      case 'restack':
      case 'naked_restack_reaction':
        perSender('repost', mine, `restacked your ${target ? what('comment', targetRaw) : 'post'}`);
        break;
      case 'post_reply':
      case 'note_reply':
      case 'comment_reply':
      case 'comment_mention':
      case 'restack_quote': {
        if (!theirs?.author) {
          ctx.drops.add(`activity.${type}.no-comment`);
          break;
        }
        const t: P.FeedItemType = type === 'comment_mention' ? 'mention' : type === 'restack_quote' ? 'quote' : 'reply';
        const about = type === 'comment_mention' ? undefined : mine;
        add({ nativeId: `${t}:${theirs.id}`, type: t, actor: theirs.author, ts: theirs.ts, kind: 'text', body: theirs.text, item: { type: t, theirs, ...(about ? { post: about } : {}), url: theirs.url } });
        break;
      }
      case 'post_mention': {
        if (!post?.author) {
          ctx.drops.add('activity.post_mention.no-post');
          break;
        }
        const m = sid(raw.mention_id) ? mentions.get(sid(raw.mention_id)!) : undefined;
        const body = str(m?.context, 2000) ?? post.title ?? post.text;
        add({ nativeId: `mention:${post.id}`, type: 'mention', actor: post.author, ts: post.ts, kind: 'text', body, item: { type: 'mention', theirs: post, url: post.url } });
        break;
      }
      case 'follow':
        for (const s of senders) add({ nativeId: `follow:${s}`, type: 'follow', actor: s, ts, kind: 'system', body: 'followed you', item: { type: 'follow' } });
        break;
      default:
        if (Object.hasOwn(SUBSCRIBE, type)) {
          const words = `${SUBSCRIBE[type]} ${pub?.name ?? 'your publication'}`;
          for (const s of senders) add({ nativeId: `follow:${s}:${type}:${pubId ?? '-'}`, type: 'follow', actor: s, ts, kind: 'system', body: words, item: { type: 'follow', text: words, ...(pub?.url ? { url: pub.url } : {}) } });
          break;
        }
        if (/^live_stream|^community_|poll|milestone|viral_gift|scheduled_note|post_shareable|post_to_post|recommendation|post_author|publication_author|comment_sibling|comment_ancestor|media_clip/.test(type) && !Object.hasOwn(OTHER, type)) {
          // Lives, chats, polls and the like: no card here for them yet. Counted, so a change shows.
          ctx.drops.add(`activity.${type.replace(/[^\w]/g, '').slice(0, 40) || 'unknown'}`);
          break;
        }
        {
          const words = OTHER[type] ?? type.replace(/_/g, ' ');
          const who = senders.length ? senders : [SUBSTACK_ACTOR];
          for (const s of who) add({ nativeId: `other:${key}:${s === SUBSTACK_ACTOR ? '-' : s}`, type: 'other', actor: s, ts, kind: 'system', body: words, item: { type: 'other', text: words, ...(mine ? { post: mine, url: mine.url } : {}) } });
        }
    }
  }
  return { entries, oldest, more: v.more === true };
}

/** The feed messages as chat facts. */
export function feedMessage(e: FeedEntry): P.MessageFact {
  return {
    nativeId: e.nativeId,
    conversation: FEED_CONV,
    author: e.actor,
    ts: e.ts,
    kind: e.kind,
    body: e.body,
    ...(e.type === 'reply' || e.type === 'mention' ? { mentionsSelf: true } : {}),
    extra: { feed: e.item },
  };
}
export const feedConversation = (): P.ConversationFact => ({ nativeId: FEED_CONV, shape: 'channel', variant: 'feed', name: 'Activity' });
