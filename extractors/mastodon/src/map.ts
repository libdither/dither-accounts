/**
 * Mastodon's JSON as chat facts (docs/mastodon.md "Facts and ids").
 *
 * Ids: a person is `user@domain` (their full address, the same from every server, so two accounts' views of one
 * person meet on the hub); a post is `<api host>:<status id>`, since a status id means something only on the server
 * that gave it (and the hub's post ids take no @: feed.ts POST_ID_PATTERN). The feed's messages are FeedItems with ids `like:<post>:<user>`, `repost:<post>:<user>`,
 * `follow:<user>`, `reply:<their post>`, `mention:<their post>`, `quote:<their post>` and
 * `other:<notification id>:<user>`.
 */
import type * as P from '@dither-chat/protocol';

export interface Ctx {
  /** The API's host: post ids are made with it. */
  host: string;
  /** The server's own domain (instance `domain`), which local accounts' addresses end in. Often the same as host. */
  domain: string;
  /** The account's own address, once known. */
  self: string | null;
}

// ---------------------------------------------------------------- text

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A status's HTML as plain text: paragraphs apart by a blank line, <br> a line break, links expanded to where they go
 * (Mastodon shortens what it shows of a long link), mentions and hashtags as their words.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let s = html.replace(/\r?\n/g, '');
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const href = decodeEntities(attrs.match(/href\s*=\s*"([^"]*)"/i)?.[1] ?? '');
    const shown = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    if (/\b(mention|hashtag)\b/.test(attrs) || /^[@#]/.test(shown)) return shown;
    return href && /^https?:\/\//i.test(href) ? href : shown;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  s = s.replace(/<\/?(p|div|blockquote|ul|ol|pre)[^>]*>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- people

/** Someone's full address: `acct` already has the domain for a remote account; a local one gets the server's. */
export function acctOf(a: any, ctx: Ctx): string {
  const acct = String(a?.acct ?? a?.username ?? '');
  return acct.includes('@') ? acct : `${acct}@${ctx.domain}`;
}

export function identityOf(a: any, ctx: Ctx): P.IdentityFact {
  const id = acctOf(a, ctx);
  const name = typeof a?.display_name === 'string' && a.display_name.trim() ? a.display_name.trim() : undefined;
  return {
    nativeId: id,
    handle: `@${id}`,
    ...(name ? { displayName: name } : {}),
    ...(typeof a?.avatar === 'string' && /^https?:\/\//.test(a.avatar) && !/missing\.png$/.test(a.avatar) ? { avatarUrl: a.avatar } : {}),
    ...(a?.bot ? { isBot: true } : {}),
    ...(ctx.self && id === ctx.self ? { isSelf: true } : {}),
  };
}

export function personAbout(a: any, ctx: Ctx, rel?: any): P.PersonAbout {
  const id = acctOf(a, ctx);
  const links = Array.isArray(a?.fields)
    ? a.fields
        .filter((f: any) => typeof f?.name === 'string')
        .map((f: any) => {
          const value = htmlToText(f.value);
          const url = /^https?:\/\/\S+$/.test(value) ? value : undefined;
          return { label: decodeEntities(f.name), value, ...(url ? { url } : {}), ...(f.verified_at ? { verified: true } : {}) };
        })
    : [];
  const created = Date.parse(a?.created_at ?? '');
  return {
    ...(a?.display_name ? { displayName: a.display_name } : {}),
    handle: `@${id}`,
    ...(typeof a?.avatar === 'string' ? { avatar: a.avatar } : {}),
    ...(typeof a?.header === 'string' && !/missing\.png$/.test(a.header) ? { banner: a.header } : {}),
    ...(a?.note ? { bio: htmlToText(a.note) } : {}),
    ...(Number.isFinite(created) ? { createdAt: created } : {}),
    ...(links.length ? { links } : {}),
    counts: { followers: num(a?.followers_count), following: num(a?.following_count), posts: num(a?.statuses_count) },
    ...(rel ? { relationship: rel.following ? 'following' : rel.requested ? 'requested' : rel.blocking ? 'blocked' : 'stranger', followsYou: !!rel.followed_by } : {}),
    ...(a?.bot ? { facts: [{ label: 'Account', value: 'Automated (a bot)' }] } : {}),
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---------------------------------------------------------------- posts

export const postId = (localId: string, ctx: Ctx) => `${ctx.host}:${localId}`;
/** The status id on this server in a post id, or null when the post id is another server's. */
export function localIdOf(post: string, ctx: Ctx): string | null {
  const i = post.lastIndexOf(':');
  if (i < 0) return /^\w+$/.test(post) ? post : null;
  return post.slice(0, i) === ctx.host && /^\w+$/.test(post.slice(i + 1)) ? post.slice(i + 1) : null;
}

function mediaOf(list: any): P.PostMedia[] {
  if (!Array.isArray(list)) return [];
  const out: P.PostMedia[] = [];
  for (const m of list) {
    const kind = m?.type === 'image' ? 'image' : m?.type === 'gifv' ? 'gif' : m?.type === 'video' ? 'video' : null;
    if (!kind) continue;
    const url = kind === 'image' ? (m.url ?? m.remote_url) : (m.preview_url ?? m.url);
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    const meta = m.meta?.original ?? m.meta?.small;
    out.push({ kind, url, ...(num(meta?.width) ? { width: meta.width } : {}), ...(num(meta?.height) ? { height: meta.height } : {}), ...(m.description ? { alt: String(m.description) } : {}) });
  }
  return out;
}

/** The status a quote post quotes: Mastodon 4.5 wraps it (`quote.quoted_status`), some forks give it bare. */
function quotedOf(s: any): any | null {
  const q = s?.quote;
  if (!q || typeof q !== 'object') return null;
  if (q.quoted_status && typeof q.quoted_status === 'object') return q.state && q.state !== 'accepted' ? null : q.quoted_status;
  return q.id && q.account ? q : null;
}

/**
 * A status as a PostFact, and every author it names into `people` (identity facts go first). A boost is the
 * booster's post with `repostOf` the original and no words.
 */
export function postOf(s: any, ctx: Ctx, people: Map<string, P.IdentityFact>, depth = 0): P.PostFact {
  const author = identityOf(s.account, ctx);
  people.set(author.nativeId, author);
  const ts = Date.parse(s.created_at);
  const post: P.PostFact = {
    id: postId(String(s.id), ctx),
    url: String(s.url ?? s.uri ?? ''),
    ts: Number.isFinite(ts) ? ts : 0,
    author: author.nativeId,
    text: s.reblog ? '' : htmlToText(s.content),
  };
  if (s.reblog && depth < 2) {
    post.repostOf = postOf(s.reblog, ctx, people, depth + 1);
    return post;
  }
  if (s.in_reply_to_id) {
    const to = s.in_reply_to_account_id === s.account?.id ? s.account : (s.mentions ?? []).find((m: any) => m?.id === s.in_reply_to_account_id);
    post.replyTo = { id: postId(String(s.in_reply_to_id), ctx), ...(to ? { author: acctOf(to, ctx) } : {}) };
  }
  const quoted = depth < 2 ? quotedOf(s) : null;
  if (quoted) post.quoteOf = postOf(quoted, ctx, people, depth + 1);
  post.counts = { replies: num(s.replies_count), reposts: num(s.reblogs_count), likes: num(s.favourites_count), ...(num(s.quotes_count) !== undefined ? { quotes: s.quotes_count } : {}) };
  const media = mediaOf(s.media_attachments);
  if (media.length) post.media = media;
  if (typeof s.spoiler_text === 'string' && s.spoiler_text.trim()) post.warning = s.spoiler_text.trim();
  if (s.pinned) post.pinned = true;
  if (typeof s.favourited === 'boolean' || typeof s.reblogged === 'boolean') post.viewer = { liked: !!s.favourited, reposted: !!s.reblogged };
  if (typeof s.language === 'string' && s.language) post.lang = s.language;
  if (s.poll && Array.isArray(s.poll.options)) {
    const lines = s.poll.options.map((o: any) => `◯ ${o.title}${typeof o.votes_count === 'number' ? ` (${o.votes_count})` : ''}`);
    post.text = [post.text, lines.join('\n')].filter(Boolean).join('\n\n');
  }
  return post;
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
/** Who a notification no person sent is from (an admin report, a moderation warning): the server itself. */
export const serverActor = (ctx: Ctx): P.IdentityFact => ({ nativeId: ctx.domain, displayName: ctx.domain });

const OTHER_WORDS: Record<string, string> = {
  status: 'posted',
  update: 'edited a post you boosted',
  poll: 'A poll you voted in or made has ended',
  follow_request: 'asked to follow you',
  'admin.sign_up': 'signed up',
  'admin.report': 'filed a report',
  severed_relationships: 'Some of your follows were cut by a moderation action',
  moderation_warning: 'A moderator warned your account',
  quoted_update: 'edited a post you quoted',
  annual_report: 'Your year on Mastodon is ready',
};

/** One notification as a feed message, or null when it is of nothing the feed shows. */
export function feedEntryOf(n: any, ctx: Ctx): FeedEntry | null {
  const peopleMap = new Map<string, P.IdentityFact>();
  const actor = n?.account ? identityOf(n.account, ctx) : serverActor(ctx);
  peopleMap.set(actor.nativeId, actor);
  const ts = Date.parse(n?.created_at);
  if (!Number.isFinite(ts)) return null;
  const status = n.status ? postOf(n.status, ctx, peopleMap) : undefined;
  const conversation = feedConvId(ctx.self);
  const base = { conversation, author: actor.nativeId, ts };
  let item: P.FeedItem;
  let nativeId: string;
  let kind: P.MessageKind = 'system';
  let body: string;
  switch (n.type) {
    case 'favourite':
      if (!status) return null;
      item = { type: 'like', post: status, url: status.url };
      nativeId = `like:${status.id}:${actor.nativeId}`;
      body = 'favourited your post';
      break;
    case 'reblog':
      if (!status) return null;
      item = { type: 'repost', post: status, url: status.url };
      nativeId = `repost:${status.id}:${actor.nativeId}`;
      body = 'boosted your post';
      break;
    case 'follow':
      item = { type: 'follow', url: n.account?.url };
      nativeId = `follow:${actor.nativeId}`;
      body = 'followed you';
      break;
    case 'mention': {
      if (!status) return null;
      const reply = !!(status.replyTo && ctx.self && status.replyTo.author === ctx.self);
      const type = reply ? 'reply' : 'mention';
      item = { type, theirs: status, url: status.url };
      nativeId = `${type}:${status.id}`;
      kind = 'text';
      body = status.text;
      break;
    }
    case 'quote': {
      if (!status) return null;
      item = { type: 'quote', theirs: status, ...(status.quoteOf ? { post: status.quoteOf } : {}), url: status.url };
      nativeId = `quote:${status.id}`;
      kind = 'text';
      body = status.text;
      break;
    }
    default: {
      const words = OTHER_WORDS[n.type] ?? `notified you (${String(n.type)})`;
      item = { type: 'other', text: words, ...(status ? { theirs: status, url: status.url } : {}) };
      nativeId = `other:${n.id}:${n.account ? actor.nativeId : '-'}`;
      body = words;
    }
  }
  const message: P.MessageFact = {
    ...base,
    nativeId,
    kind,
    body,
    ...(item.type === 'reply' || item.type === 'mention' ? { mentionsSelf: true } : {}),
    extra: { feed: item },
  };
  return { message, people: [...peopleMap.values()] };
}

// ---------------------------------------------------------------- threads

/**
 * A focal post's descendants as reply chains: one chain for each direct reply, the whole branch under it in reading
 * order (depth first, oldest first), each post saying what it answers, so the hub draws the tree again.
 */
export function chainsOf(focalLocal: string, descendants: any[], toPost: (s: any) => P.PostFact): P.PostFact[][] {
  const kids = new Map<string, any[]>();
  for (const d of descendants) {
    const parent = String(d?.in_reply_to_id ?? '');
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(d);
  }
  const chains: P.PostFact[][] = [];
  const walk = (s: any, into: P.PostFact[], depth: number) => {
    into.push(toPost(s));
    if (depth > 200) return;
    for (const k of kids.get(String(s.id)) ?? []) walk(k, into, depth + 1);
  };
  for (const top of kids.get(focalLocal) ?? []) {
    const chain: P.PostFact[] = [];
    walk(top, chain, 0);
    chains.push(chain);
  }
  return chains;
}

// ---------------------------------------------------------------- writing

/**
 * How long a status is as Mastodon counts it: characters, every link as `urlLength` (23 by default), a remote
 * mention by its username only.
 */
export function statusLength(text: string, urlLength: number): number {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let t = text.replace(/https?:\/\/\S+/g, 'x'.repeat(urlLength));
  t = t.replace(/(^|\s)@(\w+)@[\w.-]+\w/g, '$1@$2');
  let n = 0;
  for (const _ of seg.segment(t)) n++;
  return n;
}
