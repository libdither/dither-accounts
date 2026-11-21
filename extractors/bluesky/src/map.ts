/**
 * Bluesky's JSON (app.bsky lexicons) as chat facts (docs/bluesky.md "Facts and ids").
 *
 * Ids: a person is their DID (`did:plc:…`, `did:web:…`), which stays when their handle changes; a post is
 * `<did>~<rkey>` from its `at://<did>/app.bsky.feed.post/<rkey>` (the hub's post ids take no `/` or `@`:
 * feed.ts POST_ID_PATTERN). The feed's messages are FeedItems with ids `like:<post>:<did>`, `repost:<post>:<did>`,
 * `follow:<did>`, `reply:<their post>`, `mention:<their post>`, `quote:<their post>` and `other:<record>:<did>`.
 */
import type * as P from '@dither-chat/protocol';

export interface Ctx {
  /** The account's own DID, once signed in. */
  self: string | null;
  /** Where a post opens: the web app's origin (https://bsky.app). */
  web: string;
}

export const POST = 'app.bsky.feed.post';

// ---------------------------------------------------------------- ids

/** `at://<did>/<collection>/<rkey>` in its parts, or null. */
export function parseUri(uri: unknown): { did: string; collection: string; rkey: string } | null {
  if (typeof uri !== 'string') return null;
  const m = uri.match(/^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._~:-]{1,512})$/);
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

/** A post's id from its at:// URI: `<did>~<rkey>`. */
export function postIdOf(uri: string): string {
  const p = parseUri(uri);
  return p ? `${p.did}~${p.rkey}` : uri;
}

/** The at:// URI a post id names, or null when it names none. */
export function uriOfPost(post: string): string | null {
  const m = post.match(/^(did:[a-z]+:[A-Za-z0-9._:%-]+)~([A-Za-z0-9._:-]{1,64})$/);
  return m ? `at://${m[1]}/${POST}/${m[2]}` : null;
}

export const didOfUri = (uri: unknown): string | undefined => parseUri(uri)?.did;

// ---------------------------------------------------------------- text

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A post's text with its link facets expanded: the composer shortens a long link's words ("example.com/a/ve…") and
 * keeps the whole address in a facet; this puts the address back. Facets count UTF-8 bytes.
 */
export function textOf(record: any): string {
  const text = typeof record?.text === 'string' ? record.text : '';
  const facets: any[] = Array.isArray(record?.facets) ? record.facets : [];
  const links = facets
    .map((f) => ({ start: Number(f?.index?.byteStart), end: Number(f?.index?.byteEnd), uri: (f?.features ?? []).find((x: any) => x?.$type === 'app.bsky.richtext.facet#link')?.uri }))
    .filter((l) => typeof l.uri === 'string' && /^https?:\/\//i.test(l.uri) && Number.isInteger(l.start) && Number.isInteger(l.end) && l.end > l.start)
    .sort((a, b) => a.start - b.start);
  if (!links.length) return text;
  const bytes = enc.encode(text);
  let out = '';
  let at = 0;
  for (const l of links) {
    if (l.start < at || l.end > bytes.length) continue;
    out += dec.decode(bytes.slice(at, l.start)) + l.uri;
    at = l.end;
  }
  return out + dec.decode(bytes.slice(at));
}

/** How long a post is as Bluesky counts it: graphemes (300 at most). */
export function graphemes(text: string): number {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}

export interface FacetSpan {
  start: number;
  end: number;
  kind: 'link' | 'mention' | 'tag';
  /** The link, the handle without @, or the tag without #. */
  value: string;
}

/** Links, @handles and #tags in a post's words, by UTF-8 byte offsets, as the official composer finds them. */
export function findFacets(text: string): FacetSpan[] {
  const spans: FacetSpan[] = [];
  const byteAt = (i: number) => enc.encode(text.slice(0, i)).length;
  const add = (i: number, s: string, kind: FacetSpan['kind'], value: string) => spans.push({ start: byteAt(i), end: byteAt(i + s.length), kind, value });
  for (const m of text.matchAll(/(^|[\s(])(https?:\/\/[^\s<>"]+)/gi)) {
    const url = m[2].replace(/[.,;:!?)\]'"]+$/, '');
    add(m.index! + m[1].length, url, 'link', url);
  }
  for (const m of text.matchAll(/(^|[\s(])(@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)/g)) {
    add(m.index! + m[1].length, m[2], 'mention', m[2].slice(1).toLowerCase());
  }
  for (const m of text.matchAll(/(^|\s)(#[^\d\s#][^\s#]{0,63})/gu)) {
    const tag = m[2].replace(/[.,;:!?)\]'"]+$/, '');
    add(m.index! + m[1].length, tag, 'tag', tag.slice(1));
  }
  return spans.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- people

export function identityOf(a: any, ctx: Ctx): P.IdentityFact {
  const did = String(a?.did ?? '');
  const handle = typeof a?.handle === 'string' && a.handle !== 'handle.invalid' ? a.handle : null;
  const name = typeof a?.displayName === 'string' && a.displayName.trim() ? a.displayName.trim() : undefined;
  return {
    nativeId: did,
    ...(handle ? { handle: `@${handle}` } : {}),
    ...(name ? { displayName: name } : {}),
    ...(typeof a?.avatar === 'string' && /^https?:\/\//.test(a.avatar) ? { avatarUrl: a.avatar } : {}),
    ...(isBot(a) ? { isBot: true } : {}),
    ...(ctx.self && did === ctx.self ? { isSelf: true } : {}),
  };
}

const isBot = (a: any) => Array.isArray(a?.labels) && a.labels.some((l: any) => l?.val === 'bot' && l?.src === a?.did);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A profile (app.bsky.actor.defs#profileViewDetailed) as the profile command answers it, without its posts. */
export function personAbout(a: any): P.PersonAbout {
  const created = Date.parse(a?.createdAt ?? '');
  const v = a?.viewer ?? {};
  const facts: { label: string; value: string }[] = [{ label: 'DID', value: String(a?.did ?? '') }];
  if (isBot(a)) facts.push({ label: 'Account', value: 'Automated (a bot)' });
  if (a?.verification?.verifiedStatus === 'valid') facts.push({ label: 'Verified', value: 'Yes' });
  return {
    ...(a?.displayName ? { displayName: String(a.displayName) } : {}),
    ...(a?.handle ? { handle: `@${a.handle}` } : {}),
    ...(typeof a?.avatar === 'string' ? { avatar: a.avatar } : {}),
    ...(typeof a?.banner === 'string' ? { banner: a.banner } : {}),
    ...(typeof a?.description === 'string' && a.description.trim() ? { bio: a.description.trim() } : {}),
    ...(typeof a?.pronouns === 'string' && a.pronouns ? { pronouns: a.pronouns } : {}),
    ...(Number.isFinite(created) ? { createdAt: created } : {}),
    ...(typeof a?.website === 'string' && /^https?:\/\//.test(a.website) ? { links: [{ label: 'Website', value: a.website, url: a.website }] } : {}),
    counts: { followers: num(a?.followersCount), following: num(a?.followsCount), posts: num(a?.postsCount) },
    relationship: v.blocking ? 'blocked' : v.following ? 'following' : 'stranger',
    followsYou: !!v.followedBy,
    facts,
  } as P.PersonAbout;
}

// ---------------------------------------------------------------- posts

/** Pictures and a video's poster frame from an embed view (images, video, recordWithMedia's media). */
function mediaOf(embed: any): P.PostMedia[] {
  if (!embed || typeof embed !== 'object') return [];
  const t = String(embed.$type ?? '');
  if (t.startsWith('app.bsky.embed.recordWithMedia')) return mediaOf(embed.media);
  const ratio = (r: any) => ({ ...(num(r?.width) ? { width: r.width } : {}), ...(num(r?.height) ? { height: r.height } : {}) });
  if (t.startsWith('app.bsky.embed.images') && Array.isArray(embed.images)) {
    return embed.images
      .filter((i: any) => typeof i?.fullsize === 'string' || typeof i?.thumb === 'string')
      .map((i: any) => ({ kind: 'image' as const, url: i.fullsize ?? i.thumb, ...ratio(i.aspectRatio), ...(i.alt ? { alt: String(i.alt) } : {}) }));
  }
  if (t.startsWith('app.bsky.embed.video') && typeof embed.thumbnail === 'string') {
    return [{ kind: 'video', url: embed.thumbnail, ...ratio(embed.aspectRatio), ...(embed.alt ? { alt: String(embed.alt) } : {}) }];
  }
  return [];
}

/** A link card (app.bsky.embed.external) as a line after the words, unless the words hold the link already. */
function externalOf(embed: any): string | null {
  const t = String(embed?.$type ?? '');
  const ext = t.startsWith('app.bsky.embed.external') ? embed.external : t.startsWith('app.bsky.embed.recordWithMedia') && String(embed.media?.$type ?? '').startsWith('app.bsky.embed.external') ? embed.media.external : null;
  return typeof ext?.uri === 'string' && /^https?:\/\//.test(ext.uri) ? ext.uri : null;
}

/** The post a quote quotes, as a post view (an embed's viewRecord), or null when it is gone, blocked or not a post. */
function quotedOf(embed: any): any | null {
  const t = String(embed?.$type ?? '');
  const rec = t.startsWith('app.bsky.embed.record#') ? embed.record : t.startsWith('app.bsky.embed.recordWithMedia') ? embed.record?.record : null;
  if (!rec || !String(rec.$type ?? '').endsWith('#viewRecord') || parseUri(rec.uri)?.collection !== POST) return null;
  // A viewRecord has the record as `value` and its own embeds as `embeds`: shape it as a post view.
  return { uri: rec.uri, cid: rec.cid, author: rec.author, record: rec.value, embed: rec.embeds?.[0], indexedAt: rec.indexedAt, replyCount: rec.replyCount, repostCount: rec.repostCount, likeCount: rec.likeCount, quoteCount: rec.quoteCount };
}

/** Who may reply, from a post view's threadgate. */
function gateOf(tg: any): P.ReplyGate | undefined {
  const allow = tg?.record?.allow;
  if (!tg || allow === undefined) return undefined;
  const types = (Array.isArray(allow) ? allow : []).map((a: any) => String(a?.$type ?? ''));
  if (types.some((t: string) => t.endsWith('#followingRule'))) return 'following';
  if (types.some((t: string) => t.endsWith('#mentionRule'))) return 'mentioned';
  return undefined;
}

export const postUrl = (handleOrDid: string, rkey: string, ctx: Ctx) => `${ctx.web}/profile/${handleOrDid}/post/${rkey}`;

/** What is known of a post to act on it: its cid, and the records of your like and repost of it. */
export interface Known {
  cid: string;
  like?: string;
  repost?: string;
}

/**
 * A post view (app.bsky.feed.defs#postView) as a PostFact, and every author it names into `people` (identity facts
 * go first). `seen` learns each post's cid and your like and repost, for acting on it later.
 */
export function postOf(v: any, ctx: Ctx, people: Map<string, P.IdentityFact>, seen?: (uri: string, k: Known) => void, depth = 0, parentAuthor?: string): P.PostFact {
  const author = identityOf(v.author, ctx);
  if (author.nativeId) people.set(author.nativeId, author);
  const rec = v.record ?? {};
  const uri = String(v.uri);
  const p = parseUri(uri);
  const ts = Date.parse(rec.createdAt ?? v.indexedAt);
  let text = textOf(rec);
  const ext = externalOf(v.embed);
  if (ext && !text.includes(ext)) text = [text, ext].filter(Boolean).join('\n\n');
  const post: P.PostFact = {
    id: postIdOf(uri),
    url: postUrl(v.author?.handle && v.author.handle !== 'handle.invalid' ? v.author.handle : author.nativeId, p?.rkey ?? '', ctx),
    ts: Number.isFinite(ts) ? ts : 0,
    author: author.nativeId,
    text,
  };
  if (typeof v.cid === 'string' && seen) seen(uri, { cid: v.cid, ...(v.viewer?.like ? { like: v.viewer.like } : {}), ...(v.viewer?.repost ? { repost: v.viewer.repost } : {}) });
  const reply = rec.reply;
  if (reply?.parent?.uri) {
    const to = parentAuthor ?? didOfUri(reply.parent.uri);
    post.replyTo = { id: postIdOf(reply.parent.uri), ...(to ? { author: to } : {}) };
  }
  post.root = reply?.root?.uri ? postIdOf(reply.root.uri) : post.id;
  const quoted = depth < 2 ? quotedOf(v.embed) : null;
  if (quoted) post.quoteOf = postOf(quoted, ctx, people, seen, depth + 1);
  post.counts = { replies: num(v.replyCount), reposts: num(v.repostCount), likes: num(v.likeCount), ...(num(v.quoteCount) !== undefined ? { quotes: v.quoteCount } : {}) };
  const media = mediaOf(v.embed);
  if (media.length) post.media = media;
  if (v.viewer && typeof v.viewer === 'object') post.viewer = { liked: !!v.viewer.like, reposted: !!v.viewer.repost };
  if (Array.isArray(rec.langs) && typeof rec.langs[0] === 'string') post.lang = rec.langs[0];
  const gate = gateOf(v.threadgate);
  if (gate) post.replies = gate;
  return post;
}

/**
 * One item of a timeline (app.bsky.feed.defs#feedViewPost) as a home item: a repost is the reposter's post with
 * `repostOf` the original and no words (its id the repost record's, or `<their did>~r<rkey>` when the server does not
 * name it); a pinned post says so.
 */
export function homeItemOf(item: any, ctx: Ctx, people: Map<string, P.IdentityFact>, seen?: (uri: string, k: Known) => void): P.HomeItem {
  const parentAuthor = item.reply?.parent?.author?.did;
  if (item.reply?.parent?.author) {
    const i = identityOf(item.reply.parent.author, ctx);
    people.set(i.nativeId, i);
  }
  const post = postOf(item.post, ctx, people, seen, 0, parentAuthor);
  const reason = item.reason;
  const rt = String(reason?.$type ?? '');
  if (rt.endsWith('#reasonRepost') && reason.by?.did) {
    const by = identityOf(reason.by, ctx);
    people.set(by.nativeId, by);
    const own = parseUri(reason.uri);
    const ts = Date.parse(reason.indexedAt);
    const rkey = parseUri(item.post.uri)?.rkey ?? '';
    return {
      post: {
        id: own ? `${own.did}~${own.rkey}` : `${by.nativeId}~r${rkey}`,
        url: post.url,
        ts: Number.isFinite(ts) ? ts : post.ts,
        author: by.nativeId,
        text: '',
        repostOf: post,
      },
    };
  }
  if (rt.endsWith('#reasonPin')) return { post: { ...post, pinned: true }, reason: { text: 'Pinned', kind: 'pinned' } };
  return { post };
}

// ---------------------------------------------------------------- the feed

export interface FeedEntry {
  message: P.MessageFact;
  people: P.IdentityFact[];
}

export const feedConvId = (self: string | null) => (self ? `feed:${self}` : 'feed');
export function feedConversation(self: string | null): P.ConversationFact {
  return { nativeId: feedConvId(self), shape: 'channel', variant: 'feed', name: 'Notifications' };
}

const OTHER_WORDS: Record<string, string> = {
  'starterpack-joined': 'joined Bluesky through your starter pack',
  verified: 'Your account was verified',
  unverified: 'Your account is no longer verified',
  'like-via-repost': 'liked a post you reposted',
  'repost-via-repost': 'reposted a post you reposted',
  'subscribed-post': 'posted',
};

/**
 * One notification (app.bsky.notification.listNotifications) as a feed message, or null when it is of nothing the feed
 * shows. `posts` holds post views by URI: your post a like or repost is of (`reasonSubject`), and their post for a
 * reply, mention or quote (the notification's own `uri`).
 */
export function feedEntryOf(n: any, posts: Map<string, any>, ctx: Ctx, seen?: (uri: string, k: Known) => void): FeedEntry | null {
  const people = new Map<string, P.IdentityFact>();
  const actor = identityOf(n?.author, ctx);
  if (!actor.nativeId) return null;
  people.set(actor.nativeId, actor);
  const ts = Date.parse(n?.indexedAt ?? n?.record?.createdAt);
  if (!Number.isFinite(ts)) return null;
  const view = (uri: unknown) => (typeof uri === 'string' && posts.has(uri) ? postOf(posts.get(uri), ctx, people, seen) : undefined);
  const conversation = feedConvId(ctx.self);
  let item: P.FeedItem;
  let nativeId: string;
  let kind: P.MessageKind = 'system';
  let body: string;
  switch (n.reason) {
    case 'like':
    case 'repost': {
      const mine = view(n.reasonSubject);
      if (!mine && !parseUri(n.reasonSubject)) return null;
      const id = mine?.id ?? postIdOf(n.reasonSubject);
      item = { type: n.reason, ...(mine ? { post: mine, url: mine.url } : {}) };
      nativeId = `${n.reason}:${id}:${actor.nativeId}`;
      body = n.reason === 'like' ? 'liked your post' : 'reposted your post';
      break;
    }
    case 'follow':
      item = { type: 'follow', url: `${ctx.web}/profile/${actor.nativeId}` };
      nativeId = `follow:${actor.nativeId}`;
      body = 'followed you';
      break;
    case 'reply':
    case 'mention':
    case 'quote': {
      const theirs = view(n.uri) ?? (n.record ? postOf({ uri: n.uri, cid: n.cid, author: n.author, record: n.record, indexedAt: n.indexedAt }, ctx, people, seen) : undefined);
      if (!theirs) return null;
      // A mention that answers one of yours is a reply, as on Mastodon.
      const type = n.reason === 'quote' ? 'quote' : n.reason === 'reply' || (ctx.self && theirs.replyTo?.author === ctx.self) ? 'reply' : 'mention';
      const mine = type === 'quote' ? theirs.quoteOf : type === 'reply' && theirs.replyTo ? view(uriOfPost(theirs.replyTo.id)) : undefined;
      item = { type, theirs, ...(mine ? { post: mine } : {}), url: theirs.url };
      nativeId = `${type}:${theirs.id}`;
      kind = 'text';
      body = theirs.text;
      break;
    }
    default: {
      const words = OTHER_WORDS[n.reason] ?? `notified you (${String(n.reason)})`;
      const theirs = n.reason === 'subscribed-post' ? view(n.uri) : undefined;
      const about = n.reason === 'like-via-repost' || n.reason === 'repost-via-repost' ? view(n.reasonSubject) : undefined;
      const rec = parseUri(n.uri);
      item = { type: 'other', text: words, ...(theirs ? { theirs, url: theirs.url } : {}), ...(about ? { post: about } : {}) };
      nativeId = `other:${rec ? `${rec.did}~${rec.rkey}` : String(n.uri)}:${actor.nativeId}`;
      body = words;
    }
  }
  const message: P.MessageFact = {
    conversation,
    author: actor.nativeId,
    ts,
    nativeId,
    kind,
    body,
    ...(item.type === 'reply' || item.type === 'mention' ? { mentionsSelf: true } : {}),
    extra: { feed: item },
  };
  return { message, people: [...people.values()] };
}

/** The post views a page of notifications needs, by URI: subjects of likes and reposts, and replies, mentions, quotes. */
export function urisToFetch(list: any[]): string[] {
  const out = new Set<string>();
  for (const n of list) {
    if ((n?.reason === 'like' || n?.reason === 'repost' || n?.reason === 'like-via-repost' || n?.reason === 'repost-via-repost') && parseUri(n.reasonSubject)?.collection === POST) out.add(n.reasonSubject);
    if ((n?.reason === 'reply' || n?.reason === 'mention' || n?.reason === 'quote' || n?.reason === 'subscribed-post') && parseUri(n.uri)?.collection === POST) out.add(n.uri);
    // A reply's parent (yours), so the item carries the post it answers.
    if (n?.reason === 'reply' && parseUri(n.record?.reply?.parent?.uri)) out.add(n.record.reply.parent.uri);
  }
  return [...out];
}

// ---------------------------------------------------------------- threads

/**
 * A thread view (app.bsky.feed.defs#threadViewPost) as the post command answers it: the ancestors oldest first, and
 * one chain per direct reply (that reply's whole branch, depth first, in the server's order), each post saying what it
 * answers. Posts not found or blocked are left out.
 */
export function threadOf(t: any, ctx: Ctx, people: Map<string, P.IdentityFact>, seen?: (uri: string, k: Known) => void): P.PostThread {
  const isPost = (x: any) => String(x?.$type ?? 'app.bsky.feed.defs#threadViewPost').endsWith('#threadViewPost') && x?.post;
  const focal = postOf(t.post, ctx, people, seen, 0, isPost(t.parent) ? t.parent.post.author?.did : undefined);
  const ancestors: P.PostFact[] = [];
  for (let p = t.parent, depth = 0; isPost(p) && depth < 200; p = p.parent, depth++) {
    ancestors.unshift(postOf(p.post, ctx, people, seen, 0, isPost(p.parent) ? p.parent.post.author?.did : undefined));
  }
  const walk = (node: any, parentDid: string | undefined, into: P.PostFact[], depth: number) => {
    into.push(postOf(node.post, ctx, people, seen, 0, parentDid));
    if (depth > 200) return;
    for (const r of Array.isArray(node.replies) ? node.replies : []) if (isPost(r)) walk(r, node.post.author?.did, into, depth + 1);
  };
  const replies: P.PostFact[][] = [];
  for (const r of Array.isArray(t.replies) ? t.replies : []) {
    if (!isPost(r)) continue;
    const chain: P.PostFact[] = [];
    walk(r, t.post.author?.did, chain, 0);
    replies.push(chain);
  }
  return { focal, ancestors, replies, more: null };
}

// ---------------------------------------------------------------- the DID document

/** The PDS a DID document names (`#atproto_pds`), or null. */
export function pdsOf(doc: any): string | null {
  const s = (Array.isArray(doc?.service) ? doc.service : []).find((x: any) => typeof x?.id === 'string' && x.id.endsWith('#atproto_pds') && x.type === 'AtprotoPersonalDataServer');
  return typeof s?.serviceEndpoint === 'string' && /^https?:\/\//.test(s.serviceEndpoint) ? s.serviceEndpoint.replace(/\/+$/, '') : null;
}
