/**
 * ForumMagnum's GraphQL objects (Post, Comment, User, Notification, UltraFeed entries) as chat facts (docs/lesswrong.md
 * "Facts and ids").
 *
 * Ids: a post is `p-<_id>` and a comment `c-<_id>` (ForumMagnum's 17-character ids; a post and a comment never share a
 * prefix). A person is their user `_id`, their handle the profile's slug. The site itself (a notification about no
 * post or comment) is `lesswrong`. The feed's messages are FeedItems with ids `reply:<their comment>`,
 * `mention:<their post or comment>` and `other:<notification id>:<who or ->`.
 */
import type * as P from '@dither-chat/protocol';
import { htmlPreview, htmlToMarkdown } from '@dither-chat/protocol/article';

export interface Ctx {
  /** The site's address (https://www.lesswrong.com), for links that open there. */
  site: string;
  /** Your user _id, once known. */
  self: string | null;
}

/** Who a notification is from when it is about no post or comment of anyone's. */
export const SITE_ID = 'lesswrong';
/** A comment's words as plain text: whole, up to this many characters. */
export const COMMENT_MAX = 20_000;
/** A card's preview of a post. */
export const PREVIEW_MAX = 600;

const ID = /^[A-Za-z0-9]{1,40}$/;
export const postKey = (id: string) => `p-${id}`;
export const commentKey = (id: string) => `c-${id}`;

/** A post or comment id as its kind and ForumMagnum id, or null when it is not one. */
export function parseKey(key: string): { kind: 'post' | 'comment'; id: string } | null {
  const m = key.match(/^([pc])-(.+)$/);
  if (!m || !ID.test(m[2]!)) return null;
  return { kind: m[1] === 'p' ? 'post' : 'comment', id: m[2]! };
}

export const timeOf = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const https = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);

/** An upvote of either strength is a like; a downvote or none is not. */
export const isLike = (vote: unknown) => vote === 'smallUpvote' || vote === 'bigUpvote';

/** The site's name, as a notification from it says. */
export function siteName(site: string): string {
  const host = (() => {
    try {
      return new URL(site).host;
    } catch {
      return site;
    }
  })();
  if (/(^|\.)lesswrong\.com$/.test(host)) return 'LessWrong';
  if (/(^|\.)alignmentforum\.org$/.test(host)) return 'AI Alignment Forum';
  if (/(^|\.)effectivealtruism\.org$/.test(host)) return 'EA Forum';
  return host;
}

// ---------------------------------------------------------------- people

export function identityOf(u: any, ctx: Ctx): P.IdentityFact {
  const id = String(u._id);
  return {
    nativeId: id,
    ...(typeof u.slug === 'string' && u.slug ? { handle: u.slug } : {}),
    ...(typeof u.displayName === 'string' && u.displayName.trim() ? { displayName: u.displayName.trim() } : {}),
    ...(ctx.self && id === ctx.self ? { isSelf: true } : {}),
  };
}
export const siteIdentity = (ctx: Ctx): P.IdentityFact => ({ nativeId: SITE_ID, displayName: siteName(ctx.site), isBot: true });

/** The author's id, with their identity fact kept; undefined for a hidden or deleted author. */
function authorOf(u: any, ctx: Ctx, people: Map<string, P.IdentityFact>): string | undefined {
  if (!u || typeof u._id !== 'string' || !u._id) return undefined;
  const i = identityOf(u, ctx);
  people.set(i.nativeId, i);
  return i.nativeId;
}

export const profileUrl = (u: any, ctx: Ctx) => `${ctx.site}/users/${encodeURIComponent(String(u?.slug ?? u?._id ?? ''))}`;

export function personAbout(u: any, ctx: Ctx): P.PersonAbout {
  const created = timeOf(u.createdAt);
  const bio = htmlPreview(u.htmlBio, 2000);
  return {
    ...(u.displayName ? { displayName: String(u.displayName) } : {}),
    ...(u.slug ? { handle: String(u.slug) } : {}),
    ...(bio ? { bio } : {}),
    ...(created ? { createdAt: created } : {}),
    counts: { posts: num(u.postCount) },
    links: [{ label: siteName(ctx.site), value: String(u.slug ?? u._id), url: profileUrl(u, ctx) }],
    facts: [
      ...(num(u.karma) !== undefined ? [{ label: 'Karma', value: String(u.karma) }] : []),
      ...(num(u.commentCount) !== undefined ? [{ label: 'Comments', value: String(u.commentCount) }] : []),
      ...(u.deleted ? [{ label: 'Account', value: 'Deleted' }] : []),
    ],
  };
}

// ---------------------------------------------------------------- posts and comments

const postUrl = (p: any, ctx: Ctx) => (https(p.pageUrl) ? p.pageUrl : `${ctx.site}/posts/${p._id}/${p.slug ?? ''}`);
/** Footnotes' back links (the ^ at each note) say nothing in Markdown. */
const drop = (el: { attrs: Record<string, string> }) => /\bfootnote-back-link\b/.test(el.attrs.class ?? '');

export interface PostOpts {
  /** The whole body as Markdown in `article` (a post's thread only). */
  article?: boolean;
}

/**
 * A Post as a PostFact: its title apart, the start of its body as plain words (a link post's link first), karma as
 * likes, comments as replies, your upvote as liked. The whole body, as Markdown, only when asked (its thread).
 */
export function postOf(p: any, ctx: Ctx, people: Map<string, P.IdentityFact>, o: PostOpts = {}): P.PostFact {
  const id = postKey(String(p._id));
  const author = authorOf(p.user, ctx, people);
  const url = postUrl(p, ctx);
  const html = p.contents?.html ?? p.contents?.htmlHighlight ?? '';
  const preview = htmlPreview(html, PREVIEW_MAX, { drop });
  const link = https(p.url) ? p.url : null;
  const article = o.article ? htmlToMarkdown(p.contents?.html, { base: url, drop }) : '';
  return {
    id,
    url,
    ts: timeOf(p.postedAt),
    ...(author ? { author } : {}),
    text: [link, preview].filter(Boolean).join('\n\n'),
    title: String(p.title ?? ''),
    counts: { likes: num(p.baseScore), replies: num(p.commentCount) },
    root: id,
    ...(p.currentUserVote !== undefined ? { viewer: { liked: isLike(p.currentUserVote) } } : {}),
    ...(article ? { article } : {}),
  };
}

/** Is this comment a quick take (shortform): a top-level comment on its author's shortform post. */
export const isQuickTake = (c: any) => !!c.shortform && !c.parentCommentId;

/**
 * A Comment as a PostFact answering its parent comment, or the post when it is a top-level comment. A quick take
 * answers nothing (its post is only its author's shortform page) and is its own thread's root, as its replies' is.
 */
export function commentOf(c: any, ctx: Ctx, people: Map<string, P.IdentityFact>): P.PostFact {
  const author = authorOf(c.user, ctx, people);
  const postId = String(c.postId ?? c.post?._id ?? '');
  const quick = isQuickTake(c);
  const top = c.topLevelCommentId ? String(c.topLevelCommentId) : null;
  const inQuickTake = !!c.shortform || !!c.post?.shortform;
  const root = quick ? commentKey(String(c._id)) : inQuickTake && top ? commentKey(top) : postKey(postId);
  const replyTo = c.parentCommentId ? commentKey(String(c.parentCommentId)) : quick ? null : postKey(postId);
  return {
    id: commentKey(String(c._id)),
    url: https(c.pageUrl) ? c.pageUrl : `${ctx.site}/posts/${postId}?commentId=${c._id}`,
    ts: timeOf(c.postedAt),
    ...(author ? { author } : {}),
    text: c.deleted ? '[deleted]' : htmlPreview(c.contents?.html, COMMENT_MAX, { drop }),
    ...(replyTo ? { replyTo: { id: replyTo } } : {}),
    root,
    counts: { likes: num(c.baseScore), replies: num(c.directChildrenCount) },
    ...(c.currentUserVote !== undefined ? { viewer: { liked: isLike(c.currentUserVote) } } : {}),
    ...(c.retracted ? { warning: 'Retracted by its author' } : {}),
  };
}

/**
 * Comments (in the site's order) as reply chains under `under` (a post: its top-level comments; a comment's id: its
 * direct replies): one chain per direct reply, the whole branch under it depth first. A comment whose parent is not in
 * the list (a later page of a post's comments) starts a chain of its own.
 */
export function chainsOf(list: any[], under: { kind: 'post' } | { kind: 'comment'; id: string }, toPost: (c: any) => P.PostFact): P.PostFact[][] {
  const ids = new Set(list.map((c) => String(c._id)));
  const kids = new Map<string, any[]>();
  const tops: any[] = [];
  for (const c of list) {
    const self = String(c._id);
    const parent = c.parentCommentId ? String(c.parentCommentId) : null;
    if (under.kind === 'comment' && self === under.id) continue;
    const head = under.kind === 'post' ? parent === null || !ids.has(parent) : parent === under.id;
    if (head) tops.push(c);
    else if (parent !== null) {
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent)!.push(c);
    }
  }
  const walk = (c: any, into: P.PostFact[], depth: number) => {
    into.push(toPost(c));
    if (depth > 200) return;
    for (const k of kids.get(String(c._id)) ?? []) walk(k, into, depth + 1);
  };
  return tops.map((t) => {
    const chain: P.PostFact[] = [];
    walk(t, chain, 0);
    return chain;
  });
}

/** The comments above one, from the thread's top-level comment down to its parent, found in a thread's list. */
export function ancestorsIn(list: any[], c: any): any[] {
  const byId = new Map(list.map((x) => [String(x._id), x]));
  const out: any[] = [];
  let parent = c.parentCommentId ? String(c.parentCommentId) : null;
  while (parent && out.length < 200) {
    const p = byId.get(parent);
    if (!p) break;
    out.unshift(p);
    parent = p.parentCommentId ? String(p.parentCommentId) : null;
  }
  return out;
}

// ---------------------------------------------------------------- home

/** One UltraFeed entry as a home item: a post; a comment thread as its last comment with the ones above it. */
export function homeItemOf(e: any, ctx: Ctx, people: Map<string, P.IdentityFact>): P.HomeItem | null {
  if (e?.type === 'feedPost' && e.feedPost?.post?._id) return { post: postOf(e.feedPost.post, ctx, people) };
  if (e?.type === 'feedSpotlight' && e.feedSpotlight?.post?._id) return { post: postOf(e.feedSpotlight.post, ctx, people), reason: { text: 'Spotlight', kind: 'pinned' } };
  if (e?.type === 'feedCommentThread') {
    const comments: any[] = (Array.isArray(e.feedCommentThread?.comments) ? e.feedCommentThread.comments : []).filter((c: any) => c?._id);
    if (!comments.length) return null;
    const posts = comments.map((c) => commentOf(c, ctx, people));
    const thread = e.feedCommentThread.post ?? comments[0].post;
    const quick = !!thread?.shortform || comments.some(isQuickTake);
    const reason: P.HomeReason = quick ? { text: 'Quick take', kind: 'other' } : { text: thread?.title ? `On “${thread.title}”` : 'Comments', kind: 'reply' };
    return { post: posts[posts.length - 1]!, reason, ...(posts.length > 1 ? { above: posts.slice(0, -1) } : {}) };
  }
  return null;
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

/** The posts and comments notifications are about, by their _id. */
export interface Docs {
  posts: Map<string, any>;
  comments: Map<string, any>;
}

/**
 * A Notification as a feed message. A reply to you (newReplyToYou) is a `reply` with their comment, and your post when
 * it answers your post; a mention (newMention) a `mention`; anything else an `other` in the site's own words, with the
 * post or comment it is about as `theirs` (a new post or comment by someone you subscribe to, a comment on a post you
 * follow), from its author, or from the site when it is about neither.
 */
export function feedEntryOf(n: any, docs: Docs, ctx: Ctx): FeedEntry | null {
  if (!n?._id || n.deleted) return null;
  const people = new Map<string, P.IdentityFact>();
  const id = String(n.documentId ?? '');
  const type = String(n.documentType ?? '');
  const c = type === 'comment' ? docs.comments.get(id) : undefined;
  const p = type === 'post' ? docs.posts.get(id) : undefined;
  const theirs = c ? commentOf(c, ctx, people) : p ? postOf(p, ctx, people) : undefined;
  const words = typeof n.message === 'string' && n.message.trim() ? n.message.trim() : 'notified you';
  const link = typeof n.link === 'string' && n.link ? (https(n.link) ? n.link : `${ctx.site}${n.link.startsWith('/') ? '' : '/'}${n.link}`) : undefined;
  let item: P.FeedItem;
  let nativeId: string;
  let kind: P.MessageKind = 'system';
  let body = words;
  if (theirs && c && n.type === 'newReplyToYou') {
    // Their comment answers your post (a top-level comment) or your comment.
    const yours = !c.parentCommentId && c.post && ctx.self && c.post.userId === ctx.self ? postOf({ ...c.post, user: { _id: ctx.self } }, ctx, new Map()) : undefined;
    item = { type: 'reply', theirs, ...(yours ? { post: { ...yours, counts: undefined, viewer: undefined } } : {}), url: theirs.url };
    nativeId = `reply:${theirs.id}`;
    kind = 'text';
    body = theirs.text;
  } else if (theirs && n.type === 'newMention') {
    item = { type: 'mention', theirs, url: theirs.url };
    nativeId = `mention:${theirs.id}`;
    kind = 'text';
    body = theirs.text;
  } else {
    item = { type: 'other', text: words, ...(theirs ? { theirs, url: theirs.url } : link ? { url: link } : {}) };
    nativeId = `other:${n._id}:${theirs?.author ?? '-'}`;
  }
  const author = theirs?.author ?? SITE_ID;
  if (author === SITE_ID) people.set(SITE_ID, siteIdentity(ctx));
  const message: P.MessageFact = {
    nativeId,
    conversation: feedConvId(ctx.self),
    author,
    ts: timeOf(n.createdAt) || theirs?.ts || 0,
    kind,
    body,
    ...(item.type === 'reply' || item.type === 'mention' ? { mentionsSelf: true } : {}),
    extra: { feed: item },
  };
  return { message, people: [...people.values()] };
}

/** The posts and comments a page of notifications needs, by kind. */
export function docsToFetch(list: any[]): { postIds: string[]; commentIds: string[] } {
  const postIds = new Set<string>();
  const commentIds = new Set<string>();
  for (const n of list) {
    if (!n?.documentId || n.deleted) continue;
    if (n.documentType === 'post') postIds.add(String(n.documentId));
    else if (n.documentType === 'comment') commentIds.add(String(n.documentId));
  }
  return { postIds: [...postIds], commentIds: [...commentIds] };
}
