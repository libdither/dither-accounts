/**
 * Threads, forums and group DMs beyond messages (docs/threads.md; docs/research/discord-gaps.md, "Threads, forums,
 * channels"): which threads you follow and how they notify you, starting threads and forum posts, archiving and
 * locking, a forum's tags, publishing in an announcement channel, and running a group DM you own.
 *
 * All additive: an adapter says it has each with a capability (ThreadsCapability), and the hub and web offer it only
 * then. An old adapter sends none of the new fields, and an old hub ignores them.
 */
import type { AboutTarget } from './about.ts';
import type { OutgoingAttachment } from './adapter.ts';
import type { MessagePreview } from './api.ts';

export type ThreadsCapability =
  /**
   * Says which threads this account follows (ConversationFact.thread.joined) and how each notifies it, follows and
   * unfollows one (the `followThread` command), and changes how one notifies it (the `threadNotify` command).
   */
  | 'followThreads'
  /** Starts a thread from a message or in a channel (the `createThread` command). */
  | 'createThreads'
  /** Says a forum's tags and a post's (ConversationFact.forum, thread.tags) and starts posts (the `createPost` command). */
  | 'forumPosts'
  /** Archives, unarchives, locks and unlocks a thread where its About.thread says this account may (`threadState`). */
  | 'threadState'
  /** Lists the private archived threads this account is in (the `threads` command with `mine`). */
  | 'myThreads'
  /** Publishes a message in an announcement channel to the channels that follow it (the `crosspost` command). */
  | 'crosspost'
  /** Takes someone out of a group this account runs (the `removeMember` command), where About.ownership says it may. */
  | 'removeMembers'
  /** Gives a group this account owns to someone else in it (the `setOwner` command). */
  | 'transferOwner'
  /** Changes or removes a group's picture (the `setPicture` command), where About.fields.avatar says it may. */
  | 'groupPicture';

/** How a thread notifies you: every message, mentions only, or nothing. */
export type ThreadNotify = 'all' | 'mentions' | 'none';

export const THREAD_NOTIFY_LABEL: Record<ThreadNotify, string> = { all: 'All messages', mentions: 'Only @mentions', none: 'Nothing' };

/** One tag a forum offers its posts (Discord's forum tags). */
export interface ForumTag {
  id: string;
  name: string;
  /** A unicode emoji, or a custom one's name. */
  emoji?: string;
  /** Only moderators may put it on a post. */
  moderated?: boolean;
}

/** What a forum (or media) channel says of its posts (ConversationFact.forum). */
export interface ForumFact {
  tags: ForumTag[];
  /** The order its own client shows posts in by default: latest activity or newest first. */
  sort?: 'activity' | 'created';
  /** How its own client lays posts out by default. */
  layout?: 'list' | 'gallery';
  /** A new post must carry at least one tag (Discord's REQUIRE_TAG). */
  tagRequired?: boolean;
}

/** What a thread says beyond a conversation (ConversationFact.thread). Each field only when the network said it. */
export interface ThreadFact {
  /** This account is in it (follows it); false: it is not. */
  joined?: boolean;
  /** How it notifies this account when that is set on the thread; absent: as its channel. */
  notify?: ThreadNotify;
  /** Muted for this account; until then (ms epoch) when it runs out. */
  muted?: boolean;
  mutedUntil?: number;
  /** Locked: only moderators may write or unarchive it. */
  locked?: boolean;
  /** A forum post's tags (ForumTag ids). */
  tags?: string[];
  /** Pinned to the top of its forum. */
  pinned?: boolean;
  /** Private: only those added (or moderators) see it. */
  private?: boolean;
  /** Native identity id of who started it. */
  owner?: string;
  /** ms epoch. */
  createdAt?: number;
  /** How many messages it has, as the network counts them. */
  messageCount?: number;
}

/** A thread's own part of its About: archiving, locking and following, and whether this account may. */
export interface AboutThread {
  archived: boolean;
  locked: boolean;
  /** This account may archive and unarchive it (who started it, or a moderator; a locked one only a moderator). */
  canArchive: boolean;
  /** This account may lock and unlock it (a moderator). */
  canLock: boolean;
  /** Why not, in words. */
  reason?: string;
  /** This account follows it. */
  joined: boolean;
  notify?: ThreadNotify;
  muted?: boolean;
  mutedUntil?: number;
}

/** A group someone owns, as this account stands in it (About.ownership): who owns it, and what this account may do. */
export interface AboutOwnership {
  /** Native identity id of the owner, when the network names one (in an AboutView: its hub identity id). */
  owner?: string;
  youOwn: boolean;
  /** This account may take people out of it (removeMember). */
  canRemove: boolean;
  /** This account may give it to someone else in it (setOwner). */
  canTransfer: boolean;
  /** Why not, in words. */
  reason?: string;
}

/** Discord's limits: a thread's or post's name, and a post's first message. */
export const THREAD_NAME_MAX = 100;
export const POST_BODY_MAX = 4000;
/** At most this many tags on one post (Discord). */
export const POST_TAGS_MAX = 5;

/** What is wrong with a thread's or post's name before anything is sent; null when it may go. */
export function threadNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give it a name';
  if ([...name.trim()].length > THREAD_NAME_MAX) return `A name is at most ${THREAD_NAME_MAX} characters`;
  return null;
}

/** What is wrong with a forum post before anything is sent: its name, its first message, its tags. */
export function postProblem(p: { name?: unknown; body?: unknown; tags?: unknown; files?: number }, forum?: ForumFact | null): string | null {
  const n = threadNameProblem(p.name);
  if (n) return n;
  const body = typeof p.body === 'string' ? p.body.trim() : '';
  if (!body && !p.files) return 'A post starts with a message: write something or add a file';
  if ([...body].length > POST_BODY_MAX) return `A post's first message is at most ${POST_BODY_MAX} characters`;
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string'))) return 'Which tags?';
  const tags = (p.tags as string[] | undefined) ?? [];
  if (tags.length > POST_TAGS_MAX) return `At most ${POST_TAGS_MAX} tags on a post`;
  if (forum) {
    const known = new Set(forum.tags.map((t) => t.id));
    if (tags.some((t) => !known.has(t))) return 'That tag is not one this forum has: look again';
    if (forum.tagRequired && !tags.length) return 'This forum wants at least one tag on a post';
  }
  return null;
}

/** Adapter commands for the capabilities above. Each answers once the network took it. */
export type ThreadsCommand =
  /**
   * Follow (join) or unfollow (leave) a thread (capability 'followThreads'). The thread's conversation fact with its
   * new `thread` comes first, then reply.result: ThreadFact as it now stands.
   */
  | { t: 'followThread'; id: string; conversation: string; follow: boolean }
  /**
   * How a thread notifies this account (capability 'followThreads'): `notify` its setting, `muted` (with `until`, ms
   * epoch, or until turned off). Only the fields given change. Following it first where the network needs that.
   * The conversation fact first, then reply.result: ThreadFact.
   */
  | { t: 'threadNotify'; id: string; conversation: string; notify?: ThreadNotify; muted?: boolean; until?: number }
  /**
   * Archive or unarchive, lock or unlock a thread (capability 'threadState'); the hub has checked a fresh
   * About.thread. The conversation fact first, then reply.result: the About as it now stands.
   */
  | { t: 'threadState'; id: string; conversation: string; archived?: boolean; locked?: boolean }
  /**
   * Start a thread (capability 'createThreads'): from `message` (a native message id in `conversation`), or in the
   * channel itself, then `body` and `attachments` as its first message when given. `private`: only those added see it.
   * The thread's conversation fact first, then reply.result: { conversation } (its native id).
   */
  | { t: 'createThread'; id: string; conversation: string; name: string; message?: string; private?: boolean; body?: string; attachments?: OutgoingAttachment[] }
  /**
   * Start a post in a forum or media channel (capability 'forumPosts'), checked against postProblem. The post's
   * conversation fact and its first message first, then reply.result: { conversation }.
   */
  | { t: 'createPost'; id: string; conversation: string; name: string; body: string; tags?: string[]; attachments?: OutgoingAttachment[] }
  /** Publish your message in an announcement channel to every channel that follows it (capability 'crosspost'). reply.result: {} */
  | { t: 'crosspost'; id: string; conversation: string; message: string }
  /**
   * Take someone out of a group (capability 'removeMembers'), checked against a fresh About.ownership. The group's
   * conversation fact first, then reply.result: the About as it now stands.
   */
  | { t: 'removeMember'; id: string; target: AboutTarget; who: string }
  /** Give a group this account owns to someone in it (capability 'transferOwner'). reply.result: the About as it now stands. */
  | { t: 'setOwner'; id: string; target: AboutTarget; who: string }
  /** A group's picture from the hub's spool, or null to remove it (capability 'groupPicture'). reply.result: the About. */
  | { t: 'setPicture'; id: string; target: AboutTarget; picture: OutgoingAttachment | null };

/** What `createThread` and `createPost` answer. */
export interface CreateThreadResult {
  /** The new thread's native conversation id. */
  conversation: string;
}

// ---------------------------------------------------------------- hub views

/** A thread's part of its ConversationView. */
export interface ThreadView {
  /** Your accounts that follow it. */
  following: string[];
  /** Your accounts known not to follow it. */
  notFollowing: string[];
  notify: ThreadNotify | null;
  muted: boolean;
  mutedUntil: number | null;
  locked: boolean;
  tags: string[];
  pinned: boolean;
  private: boolean;
  ownerId: string | null;
  createdAt: number | null;
  messageCount: number | null;
  /** A forum post's first message, when the hub has it. */
  first: MessagePreview | null;
  /** The picture of a post's first message, for a media channel's gallery. */
  cover: string | null;
}

/** A forum's part of its ConversationView. */
export interface ForumView {
  tags: ForumTag[];
  sort: 'activity' | 'created';
  layout: 'list' | 'gallery';
  tagRequired: boolean;
}

/** POST /api/conversations/:id/threads { name, message?, private?, body? } and /posts { name, body, tags? }: the new thread. */
export interface CreatedThreadView {
  conversationId: string;
}

/** GET /api/conversations/:id/threads?archived=1&mine=1&offset=N: a page of a channel's threads, asked of the network. */
export interface ThreadPageView {
  /** The threads on this page, in the network's order (newest activity first). */
  conversationIds: string[];
  more: boolean;
  /** Ask again with this offset for the next page. */
  next: number | null;
  /** Why the page is empty or old, in words (not connected, still indexing). */
  note?: string;
}

/** A thread's tags, named and in the forum's order; unknown ids left out. */
export function namedTags(forum: { tags: ForumTag[] } | null | undefined, ids: readonly string[] | null | undefined): ForumTag[] {
  if (!forum || !ids?.length) return [];
  const want = new Set(ids);
  return forum.tags.filter((t) => want.has(t.id));
}
