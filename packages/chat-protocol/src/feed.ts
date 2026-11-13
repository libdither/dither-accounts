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
