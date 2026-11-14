/**
 * A network's notifications about your posts, and posts themselves (docs/feed.md). X's notifications (who liked,
 * reposted, replied to or quoted your posts, mentioned or followed you) arrive as messages in one read-only
 * conversation per account, variant 'feed'; a person's recent posts arrive in their profile (PersonAbout.posts).
 */

import type { MediaUrl } from './adapter.ts';

/** What happened, one actor at a time. `other`: anything else X notifies about, in X's own words (`text`). */
export type FeedItemType = 'like' | 'repost' | 'reply' | 'mention' | 'quote' | 'follow' | 'other';
export const FEED_ITEM_TYPES: readonly FeedItemType[] = ['like', 'repost', 'reply', 'mention', 'quote', 'follow', 'other'];

/** A picture or video in a post. `url` is the full picture (for a video, its poster frame). */
export interface PostMedia {
  kind: 'image' | 'video' | 'gif';
  url: MediaUrl;
  width?: number;
  height?: number;
  alt?: string;
}

/**
 * One post as the network shows it. `author` is a native identity id (an identity fact for it comes first). A
 * repost is the reposter's post with `repostOf` the original and `text` empty; a quote has `quoteOf`.
 */
export interface PostFact {
  /** The network's id for the post (X: the tweet's rest id). */
  id: string;
  /** Where it opens on the network: https://x.com/<handle>/status/<id>. */
  url: string;
  /** ms epoch. */
  ts: number;
  author?: string;
  /** Plain text with links expanded, as the network shows it (X: a long post's whole text). */
  text: string;
  /** It answers this post (its id, and its author's native id where known). */
  replyTo?: { id: string; author?: string };
  repostOf?: PostFact;
  quoteOf?: PostFact;
  counts?: { replies?: number; reposts?: number; likes?: number; quotes?: number; views?: number };
  media?: PostMedia[];
  /** Pinned at the top of its author's profile. */
  pinned?: boolean;
  /** The thread it belongs to: the id of the thread's first post (X: conversation_id_str). */
  root?: string;
  /** What the account that read it has done to it (X: legacy.favorited, legacy.retweeted). */
  viewer?: PostViewer;
  /** The language it is written in, as the network says (X: legacy.lang; 'und' when it cannot tell). */
  lang?: string;
}

/** What you have done to a post. */
export interface PostViewer {
  liked?: boolean;
  reposted?: boolean;
}

/** Done to a post (capability 'postActions', the `postAct` command). */
export type PostAct = 'like' | 'unlike' | 'repost' | 'unrepost';
export const POST_ACTS: readonly PostAct[] = ['like', 'unlike', 'repost', 'unrepost'];

/**
 * Who liked or reposted a post, a page (capability 'postReactors', the `postReactors` command): native identity ids, in the
 * network's order (X ranks them when asked: `enableRanking`), with what it said of each. Identity facts come first.
 */
export interface ReactorsPage {
  who: { id: string; followers?: number; following?: boolean; followsYou?: boolean; verified?: boolean }[];
  /** Ask again with this cursor for more, or null. */
  more: string | null;
}

/**
 * A feed message's meaning, in its MessageFact's `extra.feed`. One message per actor: three people liking a post
 * are three messages (nativeId `like:<post id>:<user id>`), each authored by the one who did it, so each person's
 * profile and history hold what they did.
 *
 * Message ids by type: `like:<post>:<user>`, `repost:<post>:<user>`, `follow:<user>`, `reply:<their post>`,
 * `mention:<their post>`, `quote:<their post>`, `other:<the network's notification id>:<user or '-'>`.
 * like, repost, follow and other are kind 'system' with a short body ("liked your post"); reply, mention and quote
 * are kind 'text' with their post's text as the body.
 */
export interface FeedItem {
  type: FeedItemType;
  /** Your post it is about (like, repost, reply, quote; a mention that answers one of yours). */
  post?: PostFact;
  /** Their post (reply, mention, quote). */
  theirs?: PostFact;
  /** Where X opens it. */
  url?: string;
  /** X's own sentence, for `other` ("Your post was seen 1,000 times"). */
  text?: string;
}

/**
 * One post's thread, as the network's page for the post shows it (capability 'posts', the `post` command, docs/feed.md
 * "Threads"): what it answers, the post, and the replies under it. Identity facts for every author come first.
 */
export interface PostThread {
  /** The post asked for. Absent on a page of more replies (`cursor` given) when the network leaves it out. */
  focal?: PostFact;
  /** What it answers, the thread's first post first, up to the one it replies to. */
  ancestors: PostFact[];
  /**
   * The replies, in the network's order. Each is a short chain: a reply, then the answers under it the network shows
   * with it (X: a conversation module, often its author continuing). The focal post's author continuing their own
   * thread comes first, as on X.
   */
  replies: PostFact[][];
  /** Ask again with this `cursor` for more replies (X's "Show more replies"), or null when there are no more. */
  more: string | null;
}

/** A post's message id in its network: posts and the DMs of one network never share an id. */
export const postNativeId = (postId: string) => `post:${postId}`;
/** The post id in a post's message native id, or null when it is not one. */
export const postIdOf = (nativeId: string) => (nativeId.startsWith('post:') ? nativeId.slice(5) : null);
