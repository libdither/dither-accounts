/**
 * Lemmy's JSON (API v3, Lemmy 0.19) as chat facts (docs/lemmy.md "Facts and ids").
 *
 * Ids: a person is `name@host` and a community `!name@host`, the host of their own instance (from `actor_id`), the
 * same from every instance; a post is `<api host>:p<id>` and a comment `<api host>:c<id>`, since Lemmy's numbers
 * mean something only on the instance that gave them, and a post and a comment may share one (and the hub's post ids
 * take no @: feed.ts POST_ID_PATTERN). A community as a post's place is `name@host`, as `publish` takes it back. The feed's messages
 * are FeedItems with ids `reply:<their comment>` and `mention:<their comment>`.
 */
import { createHmac } from 'node:crypto';
import type * as P from '@dither-chat/protocol';

export interface Ctx {
  /** The API's host: post and comment ids are made with it. */
  host: string;
  /** The instance's address, for links that open there. */
  base: string;
  /** The account's own address (`name@host`), once known. */
  self: string | null;
}

/** Lemmy's times: ISO, but before 0.19 without a zone (UTC). */
export function timeOf(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : 0;
}

const hostOf = (actorId: unknown, fallback: string) => {
  try {
    return new URL(String(actorId)).host || fallback;
  } catch {
    return fallback;
  }
};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const https = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);

// ---------------------------------------------------------------- people and places

export const personId = (p: any, ctx: Ctx) => `${p?.name}@${hostOf(p?.actor_id, ctx.host)}`;

export function identityOf(p: any, ctx: Ctx): P.IdentityFact {
  const id = personId(p, ctx);
  return {
    nativeId: id,
    handle: `@${id}`,
    ...(typeof p?.display_name === 'string' && p.display_name.trim() ? { displayName: p.display_name.trim() } : {}),
    ...(https(p?.avatar) ? { avatarUrl: p.avatar } : {}),
    ...(p?.bot_account ? { isBot: true } : {}),
    ...(ctx.self && id === ctx.self ? { isSelf: true } : {}),
  };
}

/** A community's place: its id `name@host`, as `publish` takes it; its name `!name@host`, as Lemmy writes it. */
export function placeOf(c: any, ctx: Ctx): NonNullable<P.PostFact['place']> {
  const id = `${c?.name}@${hostOf(c?.actor_id, ctx.host)}`;
  return { id, name: `!${id}`, ...(https(c?.actor_id) ? { url: c.actor_id } : {}) };
}

export function personAbout(view: any, ctx: Ctx): P.PersonAbout {
  const p = view?.person ?? {};
  const id = personId(p, ctx);
  const created = timeOf(p.published);
  return {
    ...(p.display_name ? { displayName: p.display_name } : {}),
    handle: `@${id}`,
    ...(https(p.avatar) ? { avatar: p.avatar } : {}),
    ...(https(p.banner) ? { banner: p.banner } : {}),
    ...(p.bio ? { bio: String(p.bio) } : {}),
    ...(created ? { createdAt: created } : {}),
    counts: { posts: num(view?.counts?.post_count) },
    facts: [
      ...(num(view?.counts?.comment_count) !== undefined ? [{ label: 'Comments', value: String(view.counts.comment_count) }] : []),
      ...(p.bot_account ? [{ label: 'Account', value: 'Automated (a bot)' }] : []),
      ...(p.banned ? [{ label: 'Banned', value: 'Banned from its instance' }] : []),
    ],
  };
}

// ---------------------------------------------------------------- posts and comments

export const postKey = (id: number | string, ctx: Ctx) => `${ctx.host}:p${id}`;
export const commentKey = (id: number | string, ctx: Ctx) => `${ctx.host}:c${id}`;

/** A post or comment id of this instance as its kind and number, or null when it is another instance's (or not one). */
export function parseKey(key: string, ctx: Ctx): { kind: 'post' | 'comment'; id: number } | null {
  const m = key.match(/^(?:(.+):)?([pc])(\d+)$/);
  if (!m || (m[1] && m[1] !== ctx.host)) return null;
  return { kind: m[2] === 'p' ? 'post' : 'comment', id: Number(m[3]) };
}

const IMAGE = /\.(jpe?g|png|gif|webp|avif)(\?|$)/i;

/** A PostView as a PostFact: its title apart, a link post's link first in its words, the community as its place. */
export function postOf(v: any, ctx: Ctx, people: Map<string, P.IdentityFact>): P.PostFact {
  const p = v.post ?? {};
  let author: string | undefined;
  if (v.creator) {
    const i = identityOf(v.creator, ctx);
    people.set(i.nativeId, i);
    author = i.nativeId;
  }
  const link = https(p.url) ? p.url : null;
  const text = [link && !IMAGE.test(link) ? link : null, typeof p.body === 'string' ? p.body : null].filter(Boolean).join('\n\n');
  const media: P.PostMedia[] = [];
  if (link && IMAGE.test(link)) media.push({ kind: /\.gif(\?|$)/i.test(link) ? 'gif' : 'image', url: link, ...(p.alt_text ? { alt: String(p.alt_text) } : {}) });
  else if (https(p.thumbnail_url)) media.push({ kind: 'image', url: p.thumbnail_url });
  return {
    id: postKey(p.id, ctx),
    url: `${ctx.base}/post/${p.id}`,
    ts: timeOf(p.published),
    ...(author ? { author } : {}),
    text: p.deleted ? '' : p.removed ? '[removed by a moderator]' : text,
    title: String(p.name ?? ''),
    ...(v.community ? { place: placeOf(v.community, ctx) } : {}),
    counts: { replies: num(v.counts?.comments), likes: num(v.counts?.upvotes) },
    ...(media.length ? { media } : {}),
    ...(p.featured_community || p.featured_local ? { pinned: true } : {}),
    root: postKey(p.id, ctx),
    ...(v.my_vote !== undefined ? { viewer: { liked: v.my_vote === 1 } } : {}),
    ...(p.nsfw ? { warning: 'NSFW' } : {}),
  };
}

/** The ids in a comment's path ("0.12.34" → [12, 34]), itself last. */
export const pathIds = (path: unknown) =>
  String(path ?? '')
    .split('.')
    .slice(1)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

/** A CommentView as a PostFact answering its parent comment, or the post when it is a top-level comment. */
export function commentOf(v: any, ctx: Ctx, people: Map<string, P.IdentityFact>): P.PostFact {
  const c = v.comment ?? {};
  let author: string | undefined;
  if (v.creator) {
    const i = identityOf(v.creator, ctx);
    people.set(i.nativeId, i);
    author = i.nativeId;
  }
  const ids = pathIds(c.path);
  const parent = ids.length >= 2 ? commentKey(ids[ids.length - 2], ctx) : postKey(c.post_id, ctx);
  return {
    id: commentKey(c.id, ctx),
    url: `${ctx.base}/comment/${c.id}`,
    ts: timeOf(c.published),
    ...(author ? { author } : {}),
    text: c.deleted ? '[deleted]' : c.removed ? '[removed by a moderator]' : String(c.content ?? ''),
    replyTo: { id: parent },
    root: postKey(c.post_id, ctx),
    ...(v.community ? { place: placeOf(v.community, ctx) } : {}),
    counts: { replies: num(v.counts?.child_count), likes: num(v.counts?.upvotes) },
    ...(v.my_vote !== undefined ? { viewer: { liked: v.my_vote === 1 } } : {}),
  };
}

/**
 * Comments as reply chains under `under` (a post: its top-level comments; a comment's id: its children): one chain
 * per direct reply, the whole branch under it depth first in the server's order.
 */
export function chainsOf(views: any[], under: { kind: 'post' } | { kind: 'comment'; id: number }, toPost: (v: any) => P.PostFact): P.PostFact[][] {
  const kids = new Map<number, any[]>();
  const tops: any[] = [];
  for (const v of views) {
    const ids = pathIds(v?.comment?.path);
    if (!ids.length) continue;
    const self = ids[ids.length - 1];
    if (under.kind === 'comment' && self === under.id) continue;
    const parent = ids.length >= 2 ? ids[ids.length - 2] : null;
    if ((under.kind === 'post' && parent === null) || (under.kind === 'comment' && parent === under.id)) tops.push(v);
    else if (parent !== null) {
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent)!.push(v);
    }
  }
  const walk = (v: any, into: P.PostFact[], depth: number) => {
    into.push(toPost(v));
    if (depth > 200) return;
    for (const k of kids.get(v.comment.id) ?? []) walk(k, into, depth + 1);
  };
  return tops.map((t) => {
    const chain: P.PostFact[] = [];
    walk(t, chain, 0);
    return chain;
  });
}

// ---------------------------------------------------------------- the feed

export const feedConvId = (self: string | null) => (self ? `feed:${self}` : 'feed');
export function feedConversation(self: string | null): P.ConversationFact {
  return { nativeId: feedConvId(self), shape: 'channel', variant: 'feed', name: 'Notifications' };
}

export interface FeedEntry {
  message: P.MessageFact;
  people: P.IdentityFact[];
}

/**
 * A reply (CommentReplyView) or a mention (PersonMentionView) as a feed message. A reply to your post carries the
 * post; a reply to your comment names it only by what it answers.
 */
export function feedEntryOf(v: any, type: 'reply' | 'mention', ctx: Ctx): FeedEntry | null {
  if (!v?.comment) return null;
  const people = new Map<string, P.IdentityFact>();
  const theirs = commentOf(v, ctx, people);
  if (!theirs.author) return null;
  const topLevel = pathIds(v.comment.path).length < 2;
  const post = type === 'reply' && topLevel && v.post ? postOf({ post: v.post, community: v.community }, ctx, people) : undefined;
  if (post && ctx.self) post.author = ctx.self;
  const item: P.FeedItem = { type, theirs, ...(post ? { post } : {}), url: theirs.url };
  return {
    message: {
      nativeId: `${type}:${theirs.id}`,
      conversation: feedConvId(ctx.self),
      author: theirs.author,
      ts: theirs.ts,
      kind: 'text',
      body: theirs.text,
      mentionsSelf: true,
      extra: { feed: item },
    },
    people: [...people.values()],
  };
}

// ---------------------------------------------------------------- two-factor codes

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A TOTP secret as given: base32, with spaces or an otpauth:// URI; null when it is not one. */
export function totpSecret(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (/^otpauth:/i.test(s)) s = new URL(s).searchParams.get('secret') ?? '';
  s = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (s.length < 16 || /[^A-Z2-7]/.test(s)) return null;
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    acc = (acc << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** RFC 6238: six digits, 30-second steps, SHA-1. */
export function totp(secret: Uint8Array, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
