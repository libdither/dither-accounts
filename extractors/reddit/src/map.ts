/**
 * Reddit's JSON, as old.reddit.com's own endpoints give it to the signed-in page (docs/reddit.md "What the page asks
 * Reddit"), checked here and mapped to chat facts (packages/chat-protocol feed.ts). Pure: no I/O.
 *
 * What it reads (`raw_json=1`, so text and URLs come unescaped):
 *   - Listings `{ kind: 'Listing', data: { after, before, children: [{ kind, data }] } }` of `t3` (posts), `t1`
 *     (comments), `t4` (private messages) and `more` (comments not sent yet: `children` ids and `count`; a `more` with
 *     no children and `id` '_' is "continue this thread");
 *   - a post's page (`/comments/<id>.json`): `[listing of the post, listing of its comment tree]`, each comment's
 *     `replies` a listing again or '';
 *   - `/api/morechildren` (`api_type=json`): `{ json: { errors, data: { things } } }`, the comments flat, each with its
 *     `parent_id`;
 *   - the inbox (`/message/inbox.json`): `t1` items with `type` (comment_reply, post_reply, username_mention) or
 *     `subject`, `context` and `link_title`, and `t4` messages (`subject`, `body`, `author`, `subreddit` for a
 *     subreddit's message);
 *   - a user (`/user/<name>/about.json`, `t2`): karma, cake day, picture, profile description;
 *   - write answers (`/api/comment`, `/api/submit`, `api_type=json`): `json.errors` as `[code, words, field]`.
 *
 * Ids are Reddit's fullnames (`t3_abc`, `t1_def`, `t4_ghi`), so a post and a comment never share one. People are their
 * usernames (Reddit never renames an account); '[deleted]' is nobody.
 */
import type * as P from '@dither-chat/protocol';

export class Drops {
  readonly counts = new Map<string, number>();
  add(kind: string, reason: string) {
    const k = `${kind}.${reason}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
  get total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
  /** "post.no-time 3, comment.bad-id 1": names and counts only. */
  summary(max = 6): string | null {
    if (!this.counts.size) return null;
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  }
}

/** Where posts and people open: Reddit's own site, whichever page the sandbox reads. */
export const SITE = 'https://www.reddit.com';
/** The feed conversation's native id (one per account; the hub keys it by account). */
export const FEED_CONV = 'feed';
/** The author of what no person sent (Reddit's own notices). */
export const REDDIT_ACTOR = 'reddit:system';
/** A profile shows at most this many recent posts and comments. */
export const PROFILE_POSTS = 20;
/** A thread brings at most this many comments. */
export const THREAD_POSTS = 500;
/** A home page: this many posts unless asked, at most HOME_COUNT_MAX. */
export const HOME_COUNT = 25;
export const HOME_COUNT_MAX = 100;

// ------------------------------------------------------------------ helpers
type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 100_000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** A fullname of one kind: t1_, t3_, t4_, t5_ and base-36 digits. */
export const FULLNAME = /^t[1-6]_[a-z0-9]{1,13}$/;
const ID36 = /^[a-z0-9]{1,13}$/;
/** A Reddit username (3-20 of letters, digits, _ and -; older ones can be shorter). */
export const USERNAME = /^[A-Za-z0-9_-]{1,32}$/;
/** A subreddit's name. */
export const SUBREDDIT = /^[A-Za-z0-9_]{2,32}$/;
export const fullname = (v: unknown, kind?: string): string | null => (typeof v === 'string' && FULLNAME.test(v) && (!kind || v.startsWith(`${kind}_`)) ? v : null);
const id36 = (v: unknown): string | null => (typeof v === 'string' && ID36.test(v) ? v : null);
/** A username, or null for nobody ('[deleted]', '[removed]', missing). */
export const username = (v: unknown): string | null => (typeof v === 'string' && USERNAME.test(v) ? v : null);

/** created_utc (seconds, a float) as ms, between 2005 and a day from now. */
export function redditTime(v: unknown): number | null {
  const s = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(s)) return null;
  const ms = Math.round(s * 1000);
  return ms > 1_104_537_600_000 && ms < Date.now() + 86_400_000 ? ms : null;
}

/** A Reddit path ('/r/x/comments/…') as a link on Reddit's site; a full https link to reddit as is; else null. */
export function siteUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  if (/^\/[^/\\]/.test(v)) return SITE + v;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && /(^|\.)reddit\.com$/.test(u.hostname)) return `${SITE}${u.pathname}${u.search}`;
  } catch {}
  return null;
}

/** A link a post carries (any https or http page), or null. */
function outLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 4000) return null;
  if (v.startsWith('/')) return siteUrl(v);
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Reddit's picture hosts: a picture from anywhere else is left out. */
const MEDIA_HOST = /(^|\.)(redd\.it|redditmedia\.com|redditstatic\.com|reddit\.com)$/;
export function mediaUrl(v: unknown, testOrigin?: string | null): string | null {
  if (typeof v !== 'string' || v.length > 4096) return null;
  const s = v.replace(/&amp;/g, '&');
  if (testOrigin && s.startsWith(`${testOrigin}/`)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' && MEDIA_HOST.test(u.hostname)) return s;
  } catch {}
  return null;
}

export interface Ctx {
  drops: Drops;
  testOrigin?: string | null;
  /** Everyone named (authors), so identity facts come first. */
  people: Set<string>;
}
export const ctxOf = (drops: Drops, testOrigin?: string | null): Ctx => ({ drops, testOrigin, people: new Set() });

function placeOf(d: Obj): P.PostFact['place'] | undefined {
  const name = str(d.subreddit, 40);
  if (!name || !SUBREDDIT.test(name)) return undefined;
  // A user's own profile posts are in their "u_name" subreddit: not a place apart from them.
  if (name.startsWith('u_')) return undefined;
  const id = fullname(d.subreddit_id, 't5') ?? `r/${name.toLowerCase()}`;
  return { id, name: `r/${name}`, url: `${SITE}/r/${name}/` };
}

function warningOf(d: Obj): string | undefined {
  const w = [d.over_18 === true ? 'NSFW' : null, d.spoiler === true ? 'Spoiler' : null].filter(Boolean);
  return w.length ? w.join(', ') : undefined;
}

/** What you did to it: `likes` is true (upvoted), false (downvoted) or null. */
const viewerOf = (d: Obj): P.PostViewer | undefined => (typeof d.likes === 'boolean' || d.likes === null ? { liked: d.likes === true } : undefined);

function mediaOf(d: Obj, ctx: Ctx): P.PostMedia[] {
  const out: P.PostMedia[] = [];
  // A gallery: media_metadata in gallery_data's order.
  if (isObj(d.media_metadata) && isObj(d.gallery_data)) {
    for (const it of arr(d.gallery_data.items).slice(0, 20)) {
      if (!isObj(it)) continue;
      const m = d.media_metadata[String(it.media_id)];
      if (!isObj(m) || (m.status && m.status !== 'valid') || !isObj(m.s)) continue;
      const anim = m.e === 'AnimatedImage';
      const url = mediaUrl(anim ? (m.s.gif ?? m.s.u) : m.s.u, ctx.testOrigin);
      if (!url) {
        ctx.drops.add('media', 'host');
        continue;
      }
      out.push({ kind: anim ? 'gif' : 'image', url, ...(int(m.s.x) ? { width: int(m.s.x)! } : {}), ...(int(m.s.y) ? { height: int(m.s.y)! } : {}), ...(str(it.caption, 500) ? { alt: str(it.caption, 500)! } : {}) });
    }
    if (out.length) return out;
  }
  // A picture or a video: the preview's full picture (for a video, its poster frame).
  const img = isObj(d.preview) ? arr(d.preview.images)[0] : null;
  if (isObj(img) && isObj(img.source)) {
    const url = mediaUrl(img.source.url, ctx.testOrigin);
    if (url) {
      const kind: P.PostMedia['kind'] = d.is_video === true ? 'video' : isObj(img.variants) && isObj(img.variants.gif) ? 'gif' : 'image';
      out.push({ kind, url, ...(int(img.source.width) ? { width: int(img.source.width)! } : {}), ...(int(img.source.height) ? { height: int(img.source.height)! } : {}) });
    } else ctx.drops.add('media', 'host');
  }
  return out;
}

/** A post (t3 data), or null (counted). `depth` stops a crosspost of a crosspost going on. */
export function parsePost(d: unknown, ctx: Ctx, depth = 0): P.PostFact | null {
  if (!isObj(d)) return ctx.drops.add('post', 'not-object'), null;
  const id = fullname(d.name, 't3') ?? (id36(d.id) ? `t3_${d.id}` : null);
  if (!id) return ctx.drops.add('post', 'bad-id'), null;
  const ts = redditTime(d.created_utc);
  if (ts === null) return ctx.drops.add('post', 'no-time'), null;
  const url = siteUrl(d.permalink) ?? `${SITE}/comments/${id.slice(3)}/`;
  const author = username(d.author);
  if (author) ctx.people.add(author);
  const link = d.is_self === true ? null : outLink(d.url_overridden_by_dest ?? d.url);
  // A link post's words are its link; a text post's, its text.
  const text = d.is_self === true ? (str(d.selftext) ?? '') : link && link !== url ? link : (str(d.selftext) ?? '');
  const media = mediaOf(d, ctx);
  const score = int(d.score);
  const comments = int(d.num_comments);
  const counts = { ...(score !== null && d.hide_score !== true ? { likes: score } : {}), ...(comments !== null ? { replies: comments } : {}) };
  const viewer = viewerOf(d);
  const place = placeOf(d);
  const warning = warningOf(d);
  const title = str(d.title, 400);
  const parent = depth === 0 ? arr(d.crosspost_parent_list)[0] : undefined;
  const quoteOf = parent ? parsePost(parent, ctx, depth + 1) : null;
  return {
    id,
    url,
    ts,
    ...(author ? { author } : {}),
    text,
    ...(title ? { title } : {}),
    ...(place ? { place } : {}),
    ...(warning ? { warning } : {}),
    ...(media.length ? { media } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(viewer ? { viewer } : {}),
    ...(d.pinned === true ? { pinned: true } : {}),
    ...(quoteOf ? { quoteOf } : {}),
    root: id,
  };
}

/** A comment (t1 data), or null (counted). Its replies are not read here. */
export function parseComment(d: unknown, ctx: Ctx): P.PostFact | null {
  if (!isObj(d)) return ctx.drops.add('comment', 'not-object'), null;
  const id = fullname(d.name, 't1') ?? (id36(d.id) ? `t1_${d.id}` : null);
  if (!id) return ctx.drops.add('comment', 'bad-id'), null;
  const ts = redditTime(d.created_utc);
  if (ts === null) return ctx.drops.add('comment', 'no-time'), null;
  const author = username(d.author);
  if (author) ctx.people.add(author);
  const parent = fullname(d.parent_id);
  const link = fullname(d.link_id, 't3');
  const url = siteUrl(d.permalink) ?? (link ? `${SITE}/comments/${link.slice(3)}/_/${id.slice(3)}/` : SITE);
  const score = int(d.score);
  const viewer = viewerOf(d);
  const place = placeOf(d);
  return {
    id,
    url,
    ts,
    ...(author ? { author } : {}),
    text: str(d.body) ?? '',
    ...(parent ? { replyTo: { id: parent } } : {}),
    ...(place ? { place } : {}),
    ...(score !== null && d.score_hidden !== true ? { counts: { likes: score } } : {}),
    ...(viewer ? { viewer } : {}),
    ...(d.stickied === true ? { pinned: true } : {}),
    ...(link ? { root: link } : {}),
  };
}

/** A listing's children, or [] (counted when it is not a listing). */
export function childrenOf(listing: unknown, ctx: Ctx, what: string): { kind: string; data: Obj }[] {
  if (!isObj(listing) || listing.kind !== 'Listing' || !isObj(listing.data)) {
    if (listing !== '' && listing != null) ctx.drops.add(what, 'not-listing');
    return [];
  }
  const out: { kind: string; data: Obj }[] = [];
  for (const c of arr(listing.data.children)) if (isObj(c) && typeof c.kind === 'string' && isObj(c.data)) out.push({ kind: c.kind, data: c.data });
  return out;
}
const afterOf = (listing: unknown): string | null => {
  const a = isObj(listing) && isObj(listing.data) ? listing.data.after : null;
  return typeof a === 'string' && FULLNAME.test(a) ? a : null;
};

// ---------------------------------------------------------------- home
/** A front page (`/new.json`, `/best.json`): its posts, and `after` for more. */
export function parseHome(listing: unknown, ctx: Ctx): P.HomePage {
  const items: P.HomeItem[] = [];
  for (const c of childrenOf(listing, ctx, 'home')) {
    if (c.kind !== 't3') {
      ctx.drops.add('home', `kind-${c.kind.replace(/\W/g, '').slice(0, 8)}`);
      continue;
    }
    // Ads are never in the listing; a post Reddit says was promoted is left out all the same.
    if (c.data.promoted === true) continue;
    const post = parsePost(c.data, ctx);
    if (post) items.push({ post });
  }
  return { items, more: afterOf(listing), top: null };
}

// ---------------------------------------------------------------- threads
interface Node {
  post: P.PostFact;
  /** The comment's direct children, as given. */
  kids: Node[];
  /** Children not sent: `more` objects under it. */
  more: More[];
}
/** A `more` object: comments under `parent` not sent yet (`children`), or "continue this thread" (none, id '_'). */
export interface More {
  id: string;
  parent: string;
  children: string[];
  count: number;
}

function parseMore(d: Obj, ctx: Ctx): More | null {
  const parent = fullname(d.parent_id);
  if (!parent) return ctx.drops.add('more', 'no-parent'), null;
  const children = arr(d.children).filter((c): c is string => typeof c === 'string' && ID36.test(c));
  const id = typeof d.id === 'string' && /^([a-z0-9]{1,13}|_)$/.test(d.id) ? d.id : null;
  if (!id) return ctx.drops.add('more', 'bad-id'), null;
  return { id, parent, children, count: Math.max(int(d.count) ?? 0, children.length) };
}

/** A comment tree (listing of t1 with replies nested, and `more`s) as nodes; top-level `more`s apart. */
function treeOf(listing: unknown, ctx: Ctx, budget: { n: number }): { nodes: Node[]; more: More[] } {
  const nodes: Node[] = [];
  const more: More[] = [];
  for (const c of childrenOf(listing, ctx, 'comments')) {
    if (c.kind === 'more') {
      const m = parseMore(c.data, ctx);
      if (m) more.push(m);
      continue;
    }
    if (c.kind !== 't1') {
      ctx.drops.add('comments', 'kind');
      continue;
    }
    if (budget.n <= 0) {
      ctx.drops.add('comments', 'too-many');
      continue;
    }
    const post = parseComment(c.data, ctx);
    if (!post) continue;
    budget.n--;
    const sub = treeOf(c.data.replies, ctx, budget);
    nodes.push({ post, kids: sub.nodes, more: sub.more });
  }
  return { nodes, more };
}

/** Flat comments (morechildren's things) as a tree: each under its parent when that came too, else a root. */
function treeOfFlat(things: { kind: string; data: Obj }[], ctx: Ctx, budget: { n: number }): { nodes: Node[]; more: More[] } {
  const byId = new Map<string, Node>();
  const order: Node[] = [];
  const mores: More[] = [];
  for (const t of things) {
    if (t.kind === 'more') {
      const m = parseMore(t.data, ctx);
      if (m) mores.push(m);
    } else if (t.kind === 't1') {
      if (budget.n <= 0) {
        ctx.drops.add('comments', 'too-many');
        continue;
      }
      const post = parseComment(t.data, ctx);
      if (!post) continue;
      budget.n--;
      const n: Node = { post, kids: [], more: [] };
      byId.set(post.id, n);
      order.push(n);
    } else ctx.drops.add('comments', 'kind');
  }
  const nodes: Node[] = [];
  for (const n of order) {
    const p = n.post.replyTo ? byId.get(n.post.replyTo.id) : undefined;
    if (p) p.kids.push(n);
    else nodes.push(n);
  }
  const more: More[] = [];
  for (const m of mores) {
    const p = byId.get(m.parent);
    if (p) p.more.push(m);
    else more.push(m);
  }
  return { nodes, more };
}

/**
 * A node's subtree as one chain, the comment first, then each answer under it in Reddit's order (depth first): the
 * hub puts each under the one it answers (replyTo), so the tree comes back whole. Each comment's `replies` count is
 * its answers, those sent and those not (a `more` under it), so the hub can offer "N more replies" where some are
 * missing; "continue this thread" counts one.
 */
function chainOf(n: Node, out: P.PostFact[] = []): P.PostFact[] {
  const notSent = n.more.reduce((k, m) => k + (m.count || 1), 0);
  const replies = n.kids.length + notSent;
  out.push(replies ? { ...n.post, counts: { ...n.post.counts, replies } } : n.post);
  for (const k of n.kids) chainOf(k, out);
  return out;
}

/** Where to ask for the rest: a `more` under `parent` in the thread of `link` (t3 id36), from `offset` in its list. */
export interface MoreCursor {
  link: string;
  more: string;
  offset: number;
}
export const MORECHILDREN_MAX = 100;
export function moreCursor(c: MoreCursor): string {
  return `${c.link}.${c.more}.${c.offset}`;
}
export function parseMoreCursor(s: unknown): MoreCursor | null {
  if (typeof s !== 'string' || s.length > 60) return null;
  const m = /^([a-z0-9]{1,13})\.([a-z0-9]{1,13})\.(\d{1,6})$/.exec(s);
  return m ? { link: m[1]!, more: m[2]!, offset: Number(m[3]) } : null;
}

export interface ParsedThread {
  thread: P.PostThread;
  /** The `more` objects seen, by their id (cursors name them); kept so a page of more needs no second read. */
  mores: Map<string, More>;
}

/**
 * A post's page (`/comments/<id>.json`, the post and its comments) or a comment's (`/comments/<id>/_/<comment>.json`
 * with `context`: the comment, the comments above it, its answers). `focal` is the post or comment asked for.
 */
export function parseThread(resp: unknown, focal: string, ctx: Ctx): ParsedThread | null {
  const [postListing, commentListing] = Array.isArray(resp) ? resp : [];
  const t3 = childrenOf(postListing, ctx, 'thread').find((c) => c.kind === 't3');
  const post = t3 ? parsePost(t3.data, ctx) : null;
  if (!post) {
    ctx.drops.add('thread', 'no-post');
    return null;
  }
  const link = post.id.slice(3);
  const budget = { n: THREAD_POSTS };
  const tree = treeOf(commentListing, ctx, budget);
  const mores = new Map<string, More>();
  const keep = (ms: More[]) => {
    for (const m of ms) if (m.id !== '_') mores.set(m.id, m);
  };
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      keep(n.more);
      walk(n.kids);
    }
  };
  walk(tree.nodes);
  keep(tree.more);
  const cursorAt = (ms: More[]): string | null => {
    const m = ms.find((x) => x.id !== '_' && x.children.length);
    return m ? moreCursor({ link, more: m.id, offset: 0 }) : null;
  };

  if (focal === post.id) {
    const replies = tree.nodes.map((n) => chainOf(n));
    return { thread: { focal: { ...post, counts: { ...post.counts } }, ancestors: [], replies, more: cursorAt(tree.more) }, mores };
  }
  // A comment's page: find the path down to it; what is above it is its context.
  const path = pathTo(tree.nodes, focal);
  if (!path) {
    ctx.drops.add('thread', 'no-focal');
    return null;
  }
  const node = path[path.length - 1]!;
  const ancestors = [post, ...path.slice(0, -1).map((n) => n.post)];
  const replies = node.kids.map((n) => chainOf(n));
  const notSent = node.more.reduce((k, m) => k + (m.count || 1), 0);
  const total = node.kids.length + notSent;
  return { thread: { focal: total ? { ...node.post, counts: { ...node.post.counts, replies: total } } : node.post, ancestors, replies, more: cursorAt(node.more) }, mores };
}

function pathTo(nodes: Node[], id: string): Node[] | null {
  for (const n of nodes) {
    if (n.post.id === id) return [n];
    const p = pathTo(n.kids, id);
    if (p) return [n, ...p];
  }
  return null;
}

/**
 * A page of more comments (`/api/morechildren`, api_type=json): chains as a thread's, under the `more`'s parent.
 * `rest`: the cursor for the children of that `more` not asked for yet (more than MORECHILDREN_MAX), else any new
 * top-level `more` that came back.
 */
export function parseMoreChildren(resp: unknown, cursor: MoreCursor, restAfter: number | null, ctx: Ctx): P.PostThread {
  const errors = writeErrors(resp);
  if (errors) throw new Error(`Reddit said: ${errors}`);
  const things = isObj(resp) && isObj(resp.json) && isObj(resp.json.data) ? arr(resp.json.data.things).filter((t): t is { kind: string; data: Obj } => isObj(t) && typeof t.kind === 'string' && isObj(t.data)) : [];
  const tree = treeOfFlat(things, ctx, { n: THREAD_POSTS });
  const replies = tree.nodes.map((n) => chainOf(n));
  if (restAfter !== null) return { ancestors: [], replies, more: moreCursor({ ...cursor, offset: restAfter }) };
  const next = tree.more.find((m) => m.id !== '_' && m.children.length);
  return { ancestors: [], replies, more: next ? moreCursor({ link: cursor.link, more: next.id, offset: 0 }) : null };
}
/** The `more`s that came with a morechildren page (so their cursors work without reading the thread again). */
export function moresOfChildren(resp: unknown, ctx: Ctx): More[] {
  const things = isObj(resp) && isObj(resp.json) && isObj(resp.json.data) ? arr(resp.json.data.things) : [];
  const out: More[] = [];
  for (const t of things) if (isObj(t) && t.kind === 'more' && isObj(t.data)) {
    const m = parseMore(t.data, ctx);
    if (m && m.id !== '_') out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- inbox
export interface FeedEntry {
  nativeId: string;
  type: P.FeedItemType;
  /** A username, a subreddit (`r/name`) for a subreddit's message, or REDDIT_ACTOR. */
  actor: string;
  ts: number;
  kind: 'system' | 'text';
  body: string;
  item: P.FeedItem;
}
export interface InboxPage {
  entries: FeedEntry[];
  after: string | null;
}

const TYPE_OF: Record<string, P.FeedItemType> = { comment_reply: 'reply', post_reply: 'reply', username_mention: 'mention' };
const SUBJECT_TYPE: Record<string, P.FeedItemType> = { 'comment reply': 'reply', 'post reply': 'reply', 'username mention': 'mention' };

/**
 * The inbox (`/message/inbox.json?mark=false`): replies to your comments and posts as `reply`, mentions of your
 * username as `mention`, everything else (messages to you, a subreddit's messages) as `other` with Reddit's subject as
 * its words. Reddit names no voters, so there is never a `like`.
 */
export function parseInbox(listing: unknown, ctx: Ctx): InboxPage {
  const entries: FeedEntry[] = [];
  for (const c of childrenOf(listing, ctx, 'inbox')) {
    const d = c.data;
    if (c.kind === 't1') {
      const theirs = parseComment(d, ctx);
      if (!theirs) continue;
      const type = TYPE_OF[String(d.type)] ?? SUBJECT_TYPE[String(d.subject ?? '').toLowerCase()] ?? 'reply';
      // The inbox's comment has no permalink; its context link opens it in its thread.
      const url = siteUrl(String(d.context ?? '').replace(/\?.*$/, '')) ?? theirs.url;
      const t = { ...theirs, url };
      const title = str(d.link_title, 400);
      const parent = fullname(d.parent_id);
      // Your post a reply answers: only its title and id are known here.
      const post: P.PostFact | undefined = type === 'reply' && parent?.startsWith('t3_') && title ? { id: parent, url: `${SITE}/comments/${parent.slice(3)}/`, ts: 0, text: '', title, ...(t.place ? { place: t.place } : {}) } : undefined;
      entries.push({
        nativeId: `${type}:${t.id}`,
        type,
        actor: t.author ?? REDDIT_ACTOR,
        ts: t.ts,
        kind: 'text',
        body: t.text,
        item: { type, theirs: t, ...(post ? { post } : {}), url, ...(title ? { text: title } : {}) },
      });
    } else if (c.kind === 't4') {
      const id = fullname(d.name, 't4') ?? (id36(d.id) ? `t4_${d.id}` : null);
      if (!id) {
        ctx.drops.add('inbox', 'bad-id');
        continue;
      }
      const ts = redditTime(d.created_utc);
      if (ts === null) {
        ctx.drops.add('inbox', 'no-time');
        continue;
      }
      const author = username(d.author);
      const sub = typeof d.subreddit === 'string' && SUBREDDIT.test(d.subreddit) ? `r/${d.subreddit}` : null;
      const actor = author ?? sub ?? REDDIT_ACTOR;
      if (author) ctx.people.add(author);
      const subject = str(d.subject, 300) ?? '';
      const url = `${SITE}/message/messages/${id.slice(3)}`;
      const theirs: P.PostFact = { id, url, ts, ...(author ? { author } : {}), text: str(d.body) ?? '', ...(subject ? { title: subject } : {}) };
      entries.push({
        nativeId: `other:${id}:${author ?? '-'}`,
        type: 'other',
        actor,
        ts,
        kind: 'system',
        body: subject || 'a message',
        item: { type: 'other', theirs, url, text: subject || 'a message' },
      });
    } else ctx.drops.add('inbox', 'kind');
  }
  return { entries, after: afterOf(listing) };
}

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
export const feedConversation = (): P.ConversationFact => ({ nativeId: FEED_CONV, shape: 'channel', variant: 'feed', name: 'Notifications' });

/** Someone as an identity: their username (u/name on Reddit). The actor that is not a person gets a name of its own. */
export function identityOf(name: string, self: string | null, avatar?: string | null): P.IdentityFact {
  if (name === REDDIT_ACTOR) return { nativeId: name, displayName: 'Reddit' };
  if (name.startsWith('r/')) return { nativeId: name, displayName: name };
  return { nativeId: name, handle: name, displayName: `u/${name}`, ...(avatar ? { avatarUrl: avatar } : {}), ...(self && name === self ? { isSelf: true } : {}) };
}

// ---------------------------------------------------------------- people
export interface RedditUser {
  name: string;
  createdAt: number | null;
  postKarma: number | null;
  commentKarma: number | null;
  totalKarma: number | null;
  avatar: string | null;
  title: string | null;
  bio: string | null;
  friend: boolean;
}

export function parseUser(resp: unknown, ctx: Ctx): RedditUser | null {
  if (!isObj(resp) || resp.kind !== 't2' || !isObj(resp.data)) return ctx.drops.add('user', 'not-user'), null;
  const d = resp.data;
  const name = username(d.name);
  if (!name) return ctx.drops.add('user', 'bad-name'), null;
  const sub = isObj(d.subreddit) ? d.subreddit : {};
  const avatar = mediaUrl(d.snoovatar_img || d.icon_img || sub.icon_img, ctx.testOrigin);
  const title = str(sub.title, 200);
  return {
    name,
    createdAt: redditTime(d.created_utc),
    postKarma: int(d.link_karma),
    commentKarma: int(d.comment_karma),
    totalKarma: int(d.total_karma),
    avatar,
    title: title && title !== name ? title : null,
    bio: str(sub.public_description, 2000) || null,
    friend: d.is_friend === true,
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');
/** The cake day as Reddit shows it: "March 3, 2019". */
const cakeDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** What Reddit shows of someone: karma, cake day, picture, profile words; their recent posts and comments when read. */
export function personAbout(u: RedditUser, posts?: P.PostFact[]): P.PersonAbout {
  const facts: { label: string; value: string }[] = [];
  const karma = u.totalKarma ?? (u.postKarma !== null || u.commentKarma !== null ? (u.postKarma ?? 0) + (u.commentKarma ?? 0) : null);
  if (karma !== null) facts.push({ label: 'Karma', value: fmt(karma) });
  if (u.postKarma !== null) facts.push({ label: 'Post karma', value: fmt(u.postKarma) });
  if (u.commentKarma !== null) facts.push({ label: 'Comment karma', value: fmt(u.commentKarma) });
  if (u.createdAt) facts.push({ label: 'Cake day', value: cakeDay(u.createdAt) });
  return {
    displayName: u.title ?? `u/${u.name}`,
    handle: u.name,
    ...(u.avatar ? { avatar: u.avatar } : {}),
    ...(u.bio ? { bio: u.bio } : {}),
    ...(u.createdAt ? { createdAt: u.createdAt } : {}),
    ...(u.friend ? { relationship: 'friend' as P.PersonRelationship } : {}),
    links: [{ label: 'Reddit', value: `u/${u.name}`, url: `${SITE}/user/${u.name}/` }],
    ...(facts.length ? { facts } : {}),
    ...(posts?.length ? { posts } : {}),
  };
}

/** A user's overview (`/user/<name>/overview.json`): their posts and comments, newest first, at most PROFILE_POSTS. */
export function parseOverview(listing: unknown, ctx: Ctx): P.PostFact[] {
  const out: P.PostFact[] = [];
  for (const c of childrenOf(listing, ctx, 'overview')) {
    const p = c.kind === 't3' ? parsePost(c.data, ctx) : c.kind === 't1' ? parseComment(c.data, ctx) : (ctx.drops.add('overview', 'kind'), null);
    if (!p) continue;
    // A comment in a profile says which post it is on.
    const title = c.kind === 't1' ? str(c.data.link_title, 400) : null;
    out.push(title ? { ...p, title } : p);
    if (out.length >= PROFILE_POSTS) break;
  }
  return out;
}

/** `/api/info.json?id=<fullname>`: the one thing asked for, or null. */
export function infoThing(listing: unknown, id: string, ctx: Ctx): { kind: string; data: Obj } | null {
  return childrenOf(listing, ctx, 'info').find((c) => c.data.name === id || `${c.kind}_${c.data.id}` === id) ?? null;
}

// ---------------------------------------------------------------- writes
/** A write's errors (`json.errors`, each `[code, words, field]`) as Reddit's words, or null. */
export function writeErrors(resp: unknown): string | null {
  const errs = isObj(resp) && isObj(resp.json) ? arr(resp.json.errors) : [];
  const words = errs.map((e) => (Array.isArray(e) ? String(e[1] ?? e[0] ?? '') : String(e))).filter(Boolean);
  return words.length ? words.join('; ').slice(0, 300) : null;
}

/** `/api/comment`'s answer: the comment made. */
export function parseCommented(resp: unknown, ctx: Ctx): P.PostFact | null {
  const errors = writeErrors(resp);
  if (errors) throw new Error(`Reddit said: ${errors}`);
  const things = isObj(resp) && isObj(resp.json) && isObj(resp.json.data) ? arr(resp.json.data.things) : [];
  const t = things.find((x) => isObj(x) && x.kind === 't1');
  return isObj(t) ? parseComment(t.data, ctx) : null;
}

/** `/api/submit`'s answer: the new post's name and link. */
export function parseSubmitted(resp: unknown): { id: string; url: string } | null {
  const errors = writeErrors(resp);
  if (errors) throw new Error(`Reddit said: ${errors}`);
  const d = isObj(resp) && isObj(resp.json) && isObj(resp.json.data) ? resp.json.data : null;
  const id = d ? (fullname(d.name, 't3') ?? (id36(d.id) ? `t3_${d.id}` : null)) : null;
  if (!id) return null;
  return { id, url: siteUrl(d!.url) ?? `${SITE}/comments/${id.slice(3)}/` };
}

/** A subreddit as `publish` names it: 'rust', 'r/rust' or '/r/rust/'. */
export function subredditOf(place: unknown): string | null {
  if (typeof place !== 'string') return null;
  const m = /^\/?(?:r\/)?([A-Za-z0-9_]{2,32})\/?$/.exec(place.trim());
  return m ? m[1]! : null;
}

/**
 * The picture someone set for themselves, or null: Reddit gives everyone without one a default snoo from
 * redditstatic.com's `avatars/defaults/`, which is no picture of theirs.
 */
export function ownPicture(u: RedditUser): string | null {
  if (!u.avatar) return null;
  try {
    const url = new URL(u.avatar);
    if (/(^|\.)redditstatic\.com$/.test(url.hostname) && url.pathname.startsWith('/avatars/defaults/')) return null;
  } catch {}
  return u.avatar;
}

// ---------------------------------------------------------------- Following from the subscriptions
// When the front page's New (/new.json) is refused, Following is built from the subscriptions as old reddit's own
// multireddit pages do it: `/subreddits/mine/subscriber.json` for the names, then `/r/a+b+c/new.json` for each group
// of them, merged newest first. The cursor carries where each group is up to, so it pages without anything kept.

/** Names in one `/r/a+b+c/new.json`. */
export const SUBS_CHUNK = 100;
/** At most this many subscriptions are read (pages of 100). */
export const SUBS_MAX = 1000;
/** A subscription's name: a subreddit, or a followed person's `u_name`. */
export const SUB_NAME = /^(?:[A-Za-z0-9_]{2,32}|u_[A-Za-z0-9_-]{1,32})$/;
/** A subscriptions cursor: `subs~` and each group's place, `0` (from the top), a `t3_` (after that post) or `x` (done). */
export const SUBS_CURSOR = /^subs~(?:0|x|t3_[a-z0-9]{1,13})(?:\.(?:0|x|t3_[a-z0-9]{1,13})){0,19}$/;

/** One page of `/subreddits/mine/subscriber.json`: the names, and `after` for more. */
export function parseSubscriptions(listing: unknown, ctx: Ctx): { names: string[]; after: string | null } {
  const names: string[] = [];
  for (const c of childrenOf(listing, ctx, 'subs')) {
    const name = c.kind === 't5' ? str(c.data.display_name, 40) : null;
    if (name && SUB_NAME.test(name)) names.push(name);
    else ctx.drops.add('subs', 'bad-name');
  }
  return { names, after: afterOf(listing) };
}

/** The subscriptions in groups for `/r/a+b+c/new.json`, in an order that does not change between pages. */
export function subsChunks(names: string[], size = SUBS_CHUNK): string[][] {
  const sorted = [...new Set(names)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const out: string[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

export const subsCursor = (places: string[]) => `subs~${places.join('.')}`;
/** A cursor's places, or null when it is not one or has not `groups` of them. */
export function parseSubsCursor(v: string, groups: number): string[] | null {
  if (!SUBS_CURSOR.test(v)) return null;
  const places = v.slice(5).split('.');
  return places.length === groups ? places : null;
}

/**
 * Each group's page (null for a group already done) merged newest first: the `n` newest, and the cursor for what
 * comes after them (null when every group is done). A group none of whose posts were taken is asked from the same
 * place again; one with all taken and no `after` is done.
 */
export function mergeNewest(pages: ({ items: P.HomeItem[]; more: string | null } | null)[], places: string[], n: number): P.HomePage {
  const all: { item: P.HomeItem; group: number }[] = [];
  const seen = new Set<string>();
  pages.forEach((p, group) => {
    for (const item of p?.items ?? []) {
      if (seen.has(item.post.id)) continue;
      seen.add(item.post.id);
      all.push({ item, group });
    }
  });
  all.sort((a, b) => b.item.post.ts - a.item.post.ts);
  const taken = all.slice(0, n);
  const next = places.map((place, group) => {
    const p = pages[group];
    if (!p) return 'x';
    const mine = taken.filter((t) => t.group === group);
    const given = all.filter((t) => t.group === group).length;
    if (!given) return p.more ?? 'x';
    if (!mine.length) return place;
    if (mine.length === given && !p.more) return 'x';
    return mine.at(-1)!.item.post.id;
  });
  return { items: taken.map((t) => t.item), more: next.every((s) => s === 'x') ? null : subsCursor(next), top: null };
}
