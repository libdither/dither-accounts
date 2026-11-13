/**
 * X's notifications and posts, from the GraphQL answers the page's own endpoints give (hook.js "the feed"), checked
 * here and mapped to chat facts (packages/chat-protocol feed.ts, docs/x.md "Notifications and profiles"). Pure: no I/O.
 *
 * What it reads (X's URT timelines, 2025-2026):
 *   - the notifications timeline: `instructions[]` (TimelineAddEntries, TimelineReplaceEntry, TimelinePinEntry), entries
 *     whose item is a `TimelineNotification` (id, timestamp_ms, notification_icon, rich_message.text, notification_url,
 *     template.from_users[] and template.target_objects[]) or a `TimelineTweet` (replies, mentions and quotes), and
 *     `TimelineTimelineCursor` entries (Top, Bottom);
 *   - users in both layouts: 2025's (`core.name/screen_name/created_at`, `avatar.image_url`, `location.location`,
 *     `relationship_perspectives`) and the older one (all of it in `legacy`), and the flat one the page's user lookup
 *     normalizes to (`id_str`, `screen_name`, `profile_image_url_https`, `following`, `followed_by`);
 *   - posts (`Tweet`, or `TweetWithVisibilityResults` around one in `tweet`): `legacy.full_text` with its links expanded,
 *     a long post's `note_tweet`, reposts, quotes, replies, counts, media;
 *   - a profile's Posts tab (UserTweets): its pinned post (TimelinePinEntry) and posts, threads (modules) included.
 *
 * Anything without what the mapping needs is dropped and counted by kind and reason (`feed.no-time 2`), as the DMs are.
 */
import type * as P from '@dither-chat/protocol';
import { identityFact } from './map.ts';
import { type Drops, mediaUrl } from './validate.ts';

/** The feed conversation's native id: one per X account, so two accounts' feeds never meet on the hub. */
export const feedConvId = (selfId: string | null) => (selfId ? `feed:${selfId}` : 'feed');
/** The author of a notification no person sent (X's own: "Your post was seen 1,000 times"). */
export const X_ACTOR = 'x';
/** A person's profile is announced (personAbout) at most this often. */
export const ABOUT_EVERY_MS = 24 * 3600_000;
/** A fresh account reads back at most this far, and this many pages. */
export const FIRST_READ_MS = 7 * 24 * 3600_000;
export const FIRST_READ_PAGES = 2;
/** At most this many posts in a profile. */
export const PROFILE_POSTS = 20;

export interface XUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  bio: string | null;
  location: string | null;
  website: { url: string; display: string } | null;
  createdAt: number | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  /** They follow you. */
  followsYou: boolean | null;
  /** You follow them. */
  followedByMe: boolean | null;
}

/** One message of the feed conversation: what one person did. */
export interface FeedEntry {
  nativeId: string;
  type: P.FeedItemType;
  /** A user id, or X_ACTOR. */
  actor: string;
  ts: number;
  kind: 'system' | 'text';
  body: string;
  item: P.FeedItem;
}

export interface FeedPage {
  entries: FeedEntry[];
  /** Everyone named: actors and every post's author. */
  users: Map<string, XUser>;
  top: string | null;
  bottom: string | null;
  /** The oldest entry's time (paging back stops at FIRST_READ_MS). */
  oldest: number | null;
}

// ------------------------------------------------------------------ helpers
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 50_000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** X's ids are digits. */
const XID = /^\d{1,25}$/;
const xid = (v: unknown): string | null => (typeof v === 'string' && XID.test(v) ? v : null);
const HANDLE = /^\w{1,50}$/;
/** A notification's id: letters, digits, '-' and '_'. */
const NID = /^[\w-]{1,120}$/;
/** Times between 2006 and a day from now. */
const okTime = (ms: number | null): number | null => (ms !== null && ms > 1_136_073_600_000 && ms < Date.now() + 86_400_000 ? ms : null);
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** X's dates: "Wed Oct 10 20:19:24 +0000 2018" (or an ISO string, or ms). */
export function xDate(v: unknown): number | null {
  if (typeof v === 'number') return okTime(Math.round(v));
  if (typeof v !== 'string') return null;
  if (/^\d{12,14}$/.test(v)) return okTime(Number(v));
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(v);
  if (m) {
    const mon = MONTHS[m[1]!];
    if (mon === undefined) return null;
    const off = (m[6] === '-' ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60_000;
    return okTime(Date.UTC(Number(m[9]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - off);
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? okTime(t) : null;
}
const reason = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 40) || 'unknown';
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** A link we may hand on: http(s) only. */
const link = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : null;
  } catch {
    return null;
  }
};
/** A place on X: an x.com or twitter.com https URL, or a path on x.com. */
function xUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  if (/^\/[^/]/.test(v)) return `https://x.com${v}`;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && /(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) ? v : null;
  } catch {
    return null;
  }
}
/** Text with X's t.co links put back as what they stand for. */
function expand(text: string, urls: unknown): string {
  let out = text;
  for (const u of arr(urls)) {
    if (!isObj(u) || typeof u.url !== 'string' || !u.url) continue;
    const to = link(u.expanded_url) ?? u.url;
    out = out.split(u.url).join(to);
  }
  return out;
}

// -------------------------------------------------------------------- users
/** A user in any of X's layouts (see the top), or null (counted). */
export function parseUser(v: unknown, drops: Drops, testOrigin?: string | null): XUser | null {
  if (!isObj(v)) return drops.add('user', 'not-object'), null;
  if (typeof v.__typename === 'string' && v.__typename !== 'User') return drops.add('user', reason(v.__typename)), null;
  const core = isObj(v.core) ? v.core : {};
  const legacy = isObj(v.legacy) ? v.legacy : {};
  const id = xid(v.rest_id) ?? xid(v.id_str) ?? xid(legacy.id_str);
  if (!id) return drops.add('user', 'bad-id'), null;
  const handleRaw = str(core.screen_name) ?? str(legacy.screen_name) ?? str(v.screen_name);
  if (handleRaw !== null && !HANDLE.test(handleRaw)) return drops.add('user', 'bad-handle'), null;
  const ents = isObj(legacy.entities) ? legacy.entities : isObj(v.entities) ? v.entities : {};
  const bioRaw = str(legacy.description, 2000) ?? str(v.description, 2000) ?? (isObj(v.profile_bio) ? str(v.profile_bio.description, 2000) : null);
  const site = arr(isObj(ents.url) ? ents.url.urls : null).find((u) => isObj(u) && link(u.expanded_url)) as Record<string, any> | undefined;
  const loc = isObj(v.location) ? str(v.location.location, 200) : (str(legacy.location, 200) ?? str(v.location, 200));
  const rp = isObj(v.relationship_perspectives) ? v.relationship_perspectives : {};
  return {
    id,
    handle: handleRaw,
    name: str(core.name, 200) ?? str(legacy.name, 200) ?? str(v.name, 200),
    avatar: mediaUrl(isObj(v.avatar) ? v.avatar.image_url : (legacy.profile_image_url_https ?? v.profile_image_url_https), testOrigin),
    bio: bioRaw ? unescape(expand(bioRaw, isObj(ents.description) ? ents.description.urls : null)) : null,
    location: loc || null,
    website: site ? { url: site.expanded_url, display: str(site.display_url, 200) ?? site.expanded_url } : null,
    createdAt: xDate(core.created_at ?? legacy.created_at ?? v.created_at),
    followers: num(legacy.followers_count ?? v.followers_count),
    following: num(legacy.friends_count ?? v.friends_count),
    posts: num(legacy.statuses_count ?? v.statuses_count),
    followsYou: bool(rp.followed_by) ?? bool(legacy.followed_by) ?? bool(v.followed_by),
    followedByMe: bool(rp.following) ?? bool(legacy.following) ?? bool(v.following),
  };
}

/** The user a profile lookup gave: the page's normalized `{entities: {users}, result}`, `{user: {result}}`, or one user. */
export function parseProfileUser(v: unknown, drops: Drops, testOrigin?: string | null): XUser | null {
  if (!isObj(v)) return drops.add('profile', 'not-object'), null;
  if (isObj(v.entities) && isObj(v.entities.users) && typeof v.result === 'string') return parseUser(v.entities.users[v.result], drops, testOrigin);
  if (isObj(v.user) && isObj(v.user.result)) return parseUser(v.user.result, drops, testOrigin);
  if (isObj(v.data)) return parseProfileUser(v.data, drops, testOrigin);
  if (isObj(v.result)) return parseUser(v.result, drops, testOrigin);
  return parseUser(v, drops, testOrigin);
}

export function userIdentity(u: XUser, selfId: string | null): P.IdentityFact {
  return identityFact({ id: u.id, screenName: u.handle, displayName: u.name, avatarUrl: u.avatar }, selfId);
}

/** What X shows of someone: bio, counts, follows, links, location. Never posts here (those only answer `profile`). */
export function personAbout(u: XUser): P.PersonAbout {
  const links: NonNullable<P.PersonAbout['links']> = [];
  if (u.handle) links.push({ label: 'X', value: `@${u.handle}`, url: `https://x.com/${u.handle}` });
  if (u.website) links.push({ label: 'Website', value: u.website.display, url: u.website.url });
  const counts: NonNullable<P.PersonAbout['counts']> = {
    ...(u.followers !== null ? { followers: u.followers } : {}),
    ...(u.following !== null ? { following: u.following } : {}),
    ...(u.posts !== null ? { posts: u.posts } : {}),
  };
  return {
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.handle ? { handle: u.handle } : {}),
    ...(u.avatar && /^https:/.test(u.avatar) ? { avatar: u.avatar } : {}),
    ...(u.bio ? { bio: u.bio } : {}),
    ...(u.createdAt ? { createdAt: u.createdAt } : {}),
    ...(u.followedByMe ? { relationship: 'following' as const } : {}),
    ...(u.followsYou !== null ? { followsYou: u.followsYou } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(links.length ? { links } : {}),
    ...(u.location ? { facts: [{ label: 'Location', value: u.location }] } : {}),
  };
}

// -------------------------------------------------------------------- posts
const MEDIA_KIND: Record<string, P.PostMedia['kind']> = { photo: 'image', video: 'video', animated_gif: 'gif' };

interface PostCtx {
  users: Map<string, XUser>;
  drops: Drops;
  testOrigin?: string | null;
}

/** A post (Tweet, or TweetWithVisibilityResults around one), with its author noted in ctx.users; or null (counted). */
export function parsePost(v: unknown, ctx: PostCtx, depth = 0): P.PostFact | null {
  if (!isObj(v)) return ctx.drops.add('post', 'not-object'), null;
  if (v.__typename === 'TweetWithVisibilityResults' && isObj(v.tweet)) return parsePost({ __typename: 'Tweet', ...v.tweet }, ctx, depth);
  if (typeof v.__typename === 'string' && v.__typename !== 'Tweet') return ctx.drops.add('post', reason(v.__typename)), null;
  const legacy = isObj(v.legacy) ? v.legacy : null;
  if (!legacy) return ctx.drops.add('post', 'no-legacy'), null;
  const id = xid(v.rest_id) ?? xid(legacy.id_str);
  if (!id) return ctx.drops.add('post', 'bad-id'), null;
  const ts = xDate(legacy.created_at);
  if (ts === null) return ctx.drops.add('post', 'no-time'), null;
  const authorUser = isObj(v.core) && isObj(v.core.user_results) && v.core.user_results.result ? parseUser(v.core.user_results.result, ctx.drops, ctx.testOrigin) : null;
  if (authorUser) ctx.users.set(authorUser.id, { ...ctx.users.get(authorUser.id), ...authorUser });
  const author = authorUser?.id ?? xid(legacy.user_id_str);
  const handle = authorUser?.handle ?? null;

  const media: P.PostMedia[] = [];
  const mediaList = arr(isObj(legacy.extended_entities) ? legacy.extended_entities.media : isObj(legacy.entities) ? legacy.entities.media : null);
  for (const m of mediaList.slice(0, 10)) {
    if (!isObj(m)) continue;
    const url = mediaUrl(m.media_url_https, ctx.testOrigin);
    if (!url || !/^https:/.test(url)) {
      ctx.drops.add('media', 'bad-url');
      continue;
    }
    const info = isObj(m.original_info) ? m.original_info : {};
    const alt = str(m.ext_alt_text, 2000);
    media.push({ kind: MEDIA_KIND[String(m.type)] ?? 'image', url, ...(num(info.width) ? { width: num(info.width)! } : {}), ...(num(info.height) ? { height: num(info.height)! } : {}), ...(alt ? { alt } : {}) });
  }

  const repostRaw = isObj(legacy.retweeted_status_result) ? legacy.retweeted_status_result.result : null;
  const repostOf = repostRaw && depth < 2 ? parsePost(repostRaw, ctx, depth + 1) : null;
  const quoteRaw = isObj(v.quoted_status_result) ? v.quoted_status_result.result : null;
  const quoteOf = quoteRaw && depth < 2 ? parsePost(quoteRaw, ctx, depth + 1) : null;

  let text = '';
  if (!repostOf) {
    const note = isObj(v.note_tweet) && isObj(v.note_tweet.note_tweet_results) ? v.note_tweet.note_tweet_results.result : null;
    if (isObj(note) && typeof note.text === 'string') text = expand(note.text, isObj(note.entity_set) ? note.entity_set.urls : null);
    else {
      let full = str(legacy.full_text) ?? str(legacy.text) ?? '';
      // A reply's leading @names are not shown (display_text_range starts after them).
      const range = arr(legacy.display_text_range);
      const start = num(range[0]);
      if (start && start > 0) full = Array.from(full).slice(start).join('');
      full = expand(full, isObj(legacy.entities) ? legacy.entities.urls : null);
      // The link X appends for media is the media itself.
      for (const m of mediaList) if (isObj(m) && typeof m.url === 'string' && m.url) full = full.split(m.url).join('');
      // So is the link to a quoted post.
      if (quoteOf && isObj(legacy.quoted_status_permalink) && typeof legacy.quoted_status_permalink.url === 'string') full = full.split(legacy.quoted_status_permalink.url).join('');
      text = full;
    }
    text = unescape(text).trim();
  }

  const replyId = xid(legacy.in_reply_to_status_id_str);
  const replyAuthor = xid(legacy.in_reply_to_user_id_str);
  const views = isObj(v.views) ? num(v.views.count) : null;
  const counts: NonNullable<P.PostFact['counts']> = {
    ...(num(legacy.reply_count) !== null ? { replies: num(legacy.reply_count)! } : {}),
    ...(num(legacy.retweet_count) !== null ? { reposts: num(legacy.retweet_count)! } : {}),
    ...(num(legacy.favorite_count) !== null ? { likes: num(legacy.favorite_count)! } : {}),
    ...(num(legacy.quote_count) !== null ? { quotes: num(legacy.quote_count)! } : {}),
    ...(views !== null ? { views } : {}),
  };
  return {
    id,
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`,
    ts,
    ...(author ? { author } : {}),
    text,
    ...(replyId ? { replyTo: { id: replyId, ...(replyAuthor ? { author: replyAuthor } : {}) } } : {}),
    ...(repostOf ? { repostOf } : {}),
    ...(quoteOf ? { quoteOf } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(media.length ? { media } : {}),
  };
}

// ---------------------------------------------------------------- timelines
interface Entry {
  entryId: string;
  content: Record<string, any>;
  /** The entry's sort index (on the notifications timeline, its time in ms). */
  sortIndex?: string;
}
/** The entries of a URT timeline, in order, from the instructions that add them; and its cursors. */
function entriesOf(timeline: unknown, drops: Drops, kind: string): { entries: Entry[]; pinned: Entry[]; top: string | null; bottom: string | null } {
  const out = { entries: [] as Entry[], pinned: [] as Entry[], top: null as string | null, bottom: null as string | null };
  const t = isObj(timeline) && isObj(timeline.timeline) && !Array.isArray(timeline.instructions) ? timeline.timeline : timeline;
  if (!isObj(t) || !Array.isArray(t.instructions)) {
    drops.add(kind, 'no-instructions');
    return out;
  }
  const take = (e: unknown, into: Entry[]) => {
    if (!isObj(e) || !isObj(e.content)) return drops.add(kind, 'bad-entry');
    const content = e.content;
    const type = content.entryType ?? content.__typename;
    if (type === 'TimelineTimelineCursor' || (isObj(content.itemContent) && content.itemContent.__typename === 'TimelineTimelineCursor')) {
      const c = content.entryType === 'TimelineTimelineCursor' || content.__typename === 'TimelineTimelineCursor' ? content : content.itemContent;
      const value = typeof c.value === 'string' && c.value.length <= 2000 ? c.value : null;
      if (value && c.cursorType === 'Top') out.top = value;
      if (value && c.cursorType === 'Bottom') out.bottom = value;
      return;
    }
    into.push({ entryId: typeof e.entryId === 'string' ? e.entryId : '', content, ...(typeof e.sortIndex === 'string' && e.sortIndex.length <= 40 ? { sortIndex: e.sortIndex } : {}) });
  };
  for (const ins of t.instructions.slice(0, 50)) {
    if (!isObj(ins)) continue;
    if (ins.type === 'TimelineAddEntries' || Array.isArray(ins.entries)) for (const e of arr(ins.entries).slice(0, 500)) take(e, out.entries);
    else if (ins.type === 'TimelinePinEntry') take(ins.entry, out.pinned);
    else if (ins.type === 'TimelineReplaceEntry') take(ins.entry, out.entries);
  }
  return out;
}
/** The item contents of an entry: one for an item, each of a module's. */
function itemsOf(e: Entry): { item: Record<string, any>; element: string }[] {
  const c = e.content;
  const element = isObj(c.clientEventInfo) && typeof c.clientEventInfo.element === 'string' ? c.clientEventInfo.element : '';
  if (isObj(c.itemContent)) return [{ item: c.itemContent, element }];
  const out: { item: Record<string, any>; element: string }[] = [];
  for (const it of arr(c.items).slice(0, 50)) {
    const inner = isObj(it) && isObj(it.item) ? it.item : null;
    if (inner && isObj(inner.itemContent)) out.push({ item: inner.itemContent, element: isObj(inner.clientEventInfo) && typeof inner.clientEventInfo.element === 'string' ? inner.clientEventInfo.element : element });
  }
  return out;
}

const SHORT: Partial<Record<P.FeedItemType, [mine: string, other: string]>> = {
  like: ['liked your post', 'liked a post you were mentioned in'],
  repost: ['reposted your post', 'reposted a post you were mentioned in'],
};
const ICON_TYPE: Record<string, P.FeedItemType> = { heart_icon: 'like', retweet_icon: 'repost', person_icon: 'follow' };

/**
 * One page of the notifications timeline as feed messages, one per actor (feed.ts): likes and reposts per post and
 * person, follows per person, replies, mentions and quotes per post, anything else in X's words per person (or X).
 */
export function parseNotifications(timeline: unknown, selfId: string | null, drops: Drops, testOrigin?: string | null): FeedPage {
  const users = new Map<string, XUser>();
  const ctx: PostCtx = { users, drops, testOrigin };
  const { entries, pinned, top, bottom } = entriesOf(timeline, drops, 'feed');
  const out: FeedEntry[] = [];
  const seen = new Set<string>();
  const add = (e: FeedEntry) => {
    if (seen.has(e.nativeId)) return;
    seen.add(e.nativeId);
    out.push(e);
  };
  for (const entry of [...pinned, ...entries]) {
    for (const { item, element } of itemsOf(entry)) {
      if (item.__typename === 'TimelineNotification' || item.itemType === 'TimelineNotification') notification(item, selfId, ctx, add, entry.sortIndex);
      else if (item.__typename === 'TimelineTweet' || item.itemType === 'TimelineTweet') tweetItem(item, element, selfId, ctx, add);
      else drops.add('feed', `item-${reason(String(item.__typename ?? item.itemType ?? 'none'))}`);
    }
  }
  const times = out.map((e) => e.ts);
  return { entries: out, users, top, bottom, oldest: times.length ? Math.min(...times) : null };
}

/**
 * A notification's time: `timestamp_ms` as a number, a string of digits or a date string, else its entry's sort index
 * when that reads as a time in ms (as it does on X's notifications timeline).
 */
export function notificationTime(v: unknown, sortIndex?: string): number | null {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d{9,17}$/.test(v) ? Number(v) : null;
  // Milliseconds as X documents it; seconds or microseconds read as the same moment.
  const ms = n === null ? null : n < 1e11 ? n * 1000 : n >= 1e14 ? Math.floor(n / 1000) : Math.floor(n);
  const direct = okTime(ms) ?? (typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\d/.test(v) ? okTime(Date.parse(v)) : null);
  if (direct !== null) return direct;
  return sortIndex && /^\d{13}$/.test(sortIndex) ? okTime(Number(sortIndex)) : null;
}
/** What a timestamp was like, for the drop counts: its type and form, never its value. */
const timeForm = (v: unknown): string =>
  v === undefined ? 'missing' : v === null ? 'null' : typeof v === 'string' ? (/^\d+$/.test(v) ? `digits${v.length}` : `string${Math.min(v.length, 40)}`) : typeof v === 'number' ? (Number.isFinite(v) ? `number${String(Math.trunc(Math.abs(v))).length}` : 'number-nan') : typeof v;

function notification(n: Record<string, any>, selfId: string | null, ctx: PostCtx, add: (e: FeedEntry) => void, sortIndex?: string) {
  const { drops } = ctx;
  const nid = typeof n.id === 'string' && NID.test(n.id) ? n.id : null;
  if (!nid) return drops.add('notification', 'bad-id');
  const ts = notificationTime(n.timestamp_ms, sortIndex);
  if (ts === null) return drops.add('notification', `no-time-${timeForm(n.timestamp_ms)}`);
  const tpl = isObj(n.template) ? n.template : {};
  const actors: XUser[] = [];
  for (const ref of arr(tpl.from_users).slice(0, 100)) {
    const r = isObj(ref) && isObj(ref.user_results) ? ref.user_results.result : null;
    const u = r ? parseUser(r, drops, ctx.testOrigin) : (drops.add('notification', 'bad-user'), null);
    if (!u) continue;
    ctx.users.set(u.id, { ...ctx.users.get(u.id), ...u });
    actors.push(u);
  }
  const posts: P.PostFact[] = [];
  for (const ref of arr(tpl.target_objects).slice(0, 20)) {
    const r = isObj(ref) && isObj(ref.tweet_results) ? ref.tweet_results.result : null;
    if (!r) continue; // a user or list target: nothing to show of it
    const p = parsePost(r, ctx);
    if (p) posts.push(p);
  }
  const text = isObj(n.rich_message) ? str(n.rich_message.text, 1000) : null;
  const url = isObj(n.notification_url) ? (xUrl(n.notification_url.url) ?? undefined) : undefined;
  let type: P.FeedItemType = ICON_TYPE[String(n.notification_icon)] ?? 'other';
  if ((type === 'like' || type === 'repost') && (!posts.length || !actors.length)) type = 'other';
  if (type === 'follow' && !actors.length) type = 'other';

  if (type === 'like' || type === 'repost') {
    for (const post of posts)
      for (const u of actors) {
        const [mine, other] = SHORT[type]!;
        add({ nativeId: `${type}:${post.id}:${u.id}`, type, actor: u.id, ts, kind: 'system', body: !post.author || post.author === selfId ? mine : other, item: { type, post, url: url ?? post.url } });
      }
    return;
  }
  if (type === 'follow') {
    for (const u of actors) add({ nativeId: `follow:${u.id}`, type, actor: u.id, ts, kind: 'system', body: 'followed you', item: { type, url: u.handle ? `https://x.com/${u.handle}` : (url ?? undefined) } });
    return;
  }
  if (!text) return drops.add('notification', 'no-text');
  const item: P.FeedItem = { type: 'other', text, ...(posts[0] ? { post: posts[0] } : {}), ...(url ? { url } : {}) };
  if (!actors.length) add({ nativeId: `other:${nid}:-`, type: 'other', actor: X_ACTOR, ts, kind: 'system', body: text, item });
  for (const u of actors) add({ nativeId: `other:${nid}:${u.id}`, type: 'other', actor: u.id, ts, kind: 'system', body: text, item });
}

function tweetItem(item: Record<string, any>, element: string, selfId: string | null, ctx: PostCtx, add: (e: FeedEntry) => void) {
  const r = isObj(item.tweet_results) ? item.tweet_results.result : null;
  if (!r) return ctx.drops.add('feed', 'no-tweet');
  if (isObj(item.promotedMetadata)) return ctx.drops.add('feed', 'promoted');
  const theirs = parsePost(r, ctx);
  if (!theirs) return;
  if (!theirs.author) return ctx.drops.add('feed', 'no-author');
  // X names the kind in the entry's client event (user_replied_to_your_tweet, user_quoted_your_tweet, user_mentioned_you);
  // else the post says it.
  let type: P.FeedItemType;
  if (/quote/i.test(element)) type = 'quote';
  else if (/repl/i.test(element)) type = 'reply';
  else if (/mention/i.test(element)) type = 'mention';
  else if (theirs.quoteOf && (!selfId || theirs.quoteOf.author === selfId)) type = 'quote';
  else if (theirs.replyTo && selfId && theirs.replyTo.author === selfId) type = 'reply';
  else type = 'mention';
  const post = type === 'quote' ? theirs.quoteOf : undefined;
  add({
    nativeId: `${type}:${theirs.id}`,
    type,
    actor: theirs.author,
    ts: theirs.ts,
    kind: 'text',
    body: theirs.text,
    item: { type, theirs, ...(post ? { post } : {}), url: theirs.url },
  });
}

/** The feed messages as chat facts. */
export function feedMessage(e: FeedEntry, selfId: string | null): P.MessageFact {
  return {
    nativeId: e.nativeId,
    conversation: feedConvId(selfId),
    author: e.actor,
    ts: e.ts,
    kind: e.kind,
    body: e.body,
    ...(e.type === 'reply' || e.type === 'mention' ? { mentionsSelf: true } : {}),
    extra: { feed: e.item },
  };
}

export function feedConversation(selfId: string | null): P.ConversationFact {
  return { nativeId: feedConvId(selfId), shape: 'channel', variant: 'feed', name: 'Notifications' };
}

export function xActorIdentity(): P.IdentityFact {
  return { nativeId: X_ACTOR, displayName: 'X' };
}

// ----------------------------------------------------------------- profiles
/** A profile's Posts tab: the pinned post first (`pinned`), then the posts newest first, at most PROFILE_POSTS. */
export function parseUserTweets(timeline: unknown, drops: Drops, testOrigin?: string | null): { posts: P.PostFact[]; users: Map<string, XUser> } {
  const users = new Map<string, XUser>();
  const ctx: PostCtx = { users, drops, testOrigin };
  let t = timeline;
  // The page's own call gives the timeline; a raw answer has it under data.user.result.timeline(_v2).timeline.
  if (isObj(t) && isObj(t.data)) t = t.data;
  if (isObj(t) && isObj(t.user) && isObj(t.user.result)) {
    const res = t.user.result;
    t = isObj(res.timeline) ? res.timeline.timeline : isObj(res.timeline_v2) ? res.timeline_v2.timeline : null;
  }
  const { entries, pinned } = entriesOf(t, drops, 'posts');
  const out: P.PostFact[] = [];
  const ids = new Set<string>();
  const take = (e: Entry, isPinned: boolean) => {
    if (/^promoted-/.test(e.entryId)) return;
    for (const { item } of itemsOf(e)) {
      if (item.__typename !== 'TimelineTweet' && item.itemType !== 'TimelineTweet') continue;
      if (isObj(item.promotedMetadata)) continue;
      const r = isObj(item.tweet_results) ? item.tweet_results.result : null;
      const p = r ? parsePost(r, ctx) : (drops.add('posts', 'no-tweet'), null);
      if (!p || ids.has(p.id)) continue;
      ids.add(p.id);
      out.push(isPinned ? { ...p, pinned: true } : p);
    }
  };
  for (const e of pinned) take(e, true);
  const rest: P.PostFact[] = [];
  const before = out.length;
  for (const e of entries) take(e, false);
  rest.push(...out.splice(before));
  rest.sort((a, b) => b.ts - a.ts);
  return { posts: [...out, ...rest].slice(0, PROFILE_POSTS), users };
}

// ------------------------------------------------------------ what was said
/** What x-state.json keeps of the feed: cursors and ids only. */
export interface FeedKept {
  /** The newest page's Top cursor: the next read asks only for what is newer. */
  top?: string;
  /** The newest notification time announced (ms). */
  newestMs?: number;
  /** Message ids announced lately (an aggregated like comes again with each new liker). */
  ids?: string[];
}
const KEEP_IDS = 2000;
/** A message is live (it may notify) only when newer than what was announced and this fresh. */
export const LIVE_MS = 15 * 60_000;

/**
 * What the feed has told the hub, so each page gives only what is new: the conversation once, identities when they
 * change, a person's profile at most once a day (kept in memory only), and messages, live only when newer than the
 * newest announced, under 15 minutes old and not announced before.
 */
export class FeedTracker {
  top: string | null;
  newestMs: number;
  readonly ids: Set<string>;
  private readonly people = new Map<string, string>();
  private readonly aboutAt = new Map<string, number>();
  private convSent = false;
  /** Counts for the status: messages and profiles announced since the start. */
  items = 0;
  abouts = 0;

  constructor(kept: FeedKept = {}) {
    this.top = typeof kept.top === 'string' && kept.top ? kept.top : null;
    this.newestMs = typeof kept.newestMs === 'number' && Number.isFinite(kept.newestMs) ? kept.newestMs : 0;
    this.ids = new Set((Array.isArray(kept.ids) ? kept.ids : []).filter((x): x is string => typeof x === 'string').slice(-KEEP_IDS));
  }

  /** A fresh account: nothing read yet. */
  get fresh(): boolean {
    return !this.top && !this.newestMs;
  }

  /** Everything is announced again (resync, or the hub reconnected). */
  forget() {
    this.people.clear();
    this.aboutAt.clear();
    this.convSent = false;
  }

  conversation(selfId: string | null): P.AdapterEvent[] {
    if (this.convSent) return [];
    this.convSent = true;
    return [{ t: 'conversation', conversation: feedConversation(selfId) }];
  }

  identities(users: Iterable<XUser>, selfId: string | null): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [];
    for (const u of users) {
      const fact = userIdentity(u, selfId);
      const fp = JSON.stringify(fact);
      if (this.people.get(u.id) === fp) continue;
      this.people.set(u.id, fp);
      out.push({ t: 'identity', identity: fact });
    }
    return out;
  }

  /** One page's events, in the order the hub needs them: the conversation, people, profiles, then messages oldest first. */
  page(p: FeedPage, opts: { selfId: string | null; now: number; backfill: boolean; /** A page further back: its Top cursor is not the newest. */ older?: boolean }): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [...this.conversation(opts.selfId), ...this.identities(p.users.values(), opts.selfId)];
    if (p.entries.some((e) => e.actor === X_ACTOR) && !this.people.has(X_ACTOR)) {
      this.people.set(X_ACTOR, 'x');
      out.push({ t: 'identity', identity: xActorIdentity() });
    }
    const actors = new Set(p.entries.map((e) => e.actor));
    for (const id of actors) {
      const u = p.users.get(id);
      if (!u || id === opts.selfId) continue;
      if (opts.now - (this.aboutAt.get(id) ?? 0) < ABOUT_EVERY_MS) continue;
      this.aboutAt.set(id, opts.now);
      this.abouts++;
      out.push({ t: 'personAbout', who: id, about: personAbout(u), ts: opts.now });
    }
    const before = this.newestMs;
    for (const e of [...p.entries].sort((a, b) => a.ts - b.ts)) {
      const live = !opts.backfill && e.ts > before && opts.now - e.ts < LIVE_MS && !this.ids.has(e.nativeId);
      this.ids.delete(e.nativeId);
      this.ids.add(e.nativeId);
      this.items++;
      out.push({ t: 'message', message: feedMessage(e, opts.selfId), live });
      if (e.ts > this.newestMs) this.newestMs = e.ts;
    }
    while (this.ids.size > KEEP_IDS) this.ids.delete(this.ids.values().next().value!);
    if (p.top && !opts.older) this.top = p.top;
    return out;
  }

  kept(): FeedKept {
    return { ...(this.top ? { top: this.top } : {}), ...(this.newestMs ? { newestMs: this.newestMs } : {}), ids: [...this.ids] };
  }
}
