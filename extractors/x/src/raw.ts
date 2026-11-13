/**
 * What the page's hook (src/extension/hook.js) sends up and takes down. Everything up is a whitelisted copy of the
 * client's own objects, as primitives: validate.ts checks it again here before anything is mapped.
 */

export type PageState = 'login' | 'verify' | 'pin' | 'chat' | 'other';

/** The hook points the self-test reports, in the order the status lists them. */
export const HOOK_NAMES = ['react', 'graph', 'classes', 'inbox', 'open', 'history', 'read', 'quietReads', 'send', 'reply', 'edit', 'unsend', 'reactions', 'attach', 'self', 'requests', 'answer', 'openDirect', 'createGroup', 'addMembers', 'groupInfo', 'typing', 'forward'] as const;
export type HookName = (typeof HOOK_NAMES)[number];
export interface HookState {
  ok: boolean;
  /** How it was found: 'devtools' or 'dom', 'name' or 'shape', 'module' or 'events', 'event' or 'navigate', … */
  via: string | null;
}
export interface SelfTest {
  version: number;
  hooks: Record<HookName, HookState>;
  /** The notification feed's and profiles' hooks (FEED_HOOK_NAMES), reported in the same `hooks` object by the page. */
  feed?: Record<FeedHookName, HookState>;
  counts: {
    renderers: number;
    roots: number;
    modules: number;
    modulesScanned: number;
    conversationsOpen: number;
    readsHeld: number;
    dropped: Record<string, number>;
  };
}

export interface RawUser {
  id: string;
  screenName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface RawConversation {
  id: string;
  /** The Kotlin class of the inbox row (ConversationPreviewWithMetadata). */
  kind: string | null;
  /** A legacy DM (the old, unencrypted kind) rather than an XChat conversation. */
  legacy: boolean | null;
  group: boolean | null;
  title: string | null;
  avatarUrl: string | null;
  archived: boolean | null;
  /** A group's description (XChat's customDescription), and whether you muted it. */
  description: string | null;
  muted: boolean | null;
  unread: number | null;
  unreadByMe: boolean | null;
  lastTs: number | null;
  lastReadSeq: string | null;
  lastSeq: string | null;
  users: RawUser[];
}

export interface RawReaction {
  emoji: string;
  users: string[];
  mine: boolean;
  attachmentId: string | null;
}

export interface RawAttachment {
  index: number;
  id: string | null;
  kind: string | null;
  type: string | null;
  mime: string | null;
  name: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  url: string | null;
}

export interface RawMessage {
  id: string;
  conv: string;
  kind: string | null;
  seq: string | null;
  readSeq: string | null;
  ts: number | null;
  sender: string | null;
  senderUser: RawUser | null;
  /** Drawn on your side: sent by this account. */
  mine: boolean | null;
  text: string | null;
  encrypted: boolean | null;
  /** XChat could not decrypt it (no keys on this device for it). */
  undecryptable: boolean | null;
  edited: boolean | null;
  /** Deleted or otherwise hidden, by the client's own name for why. */
  hidden: string | null;
  forwarded: boolean | null;
  replyTo: { seq: string | null; id: string | null } | null;
  reactions: RawReaction[];
  attachments: RawAttachment[];
}

export interface RawInbox {
  conversations: RawConversation[];
  typing: { conv: string; users: string[] }[];
  loading: boolean;
  loadedFromDb: boolean | null;
  keysChecked: boolean | null;
  more: boolean;
  failed: boolean;
}

export interface RawMessages {
  conv: string;
  legacy: boolean | null;
  participants: string[];
  readOnly: boolean;
  older: boolean;
  quiet: boolean;
  messages: RawMessage[];
  /** Items that are not messages (date separators, notices), by Kotlin class: counts only. */
  other: Record<string, number>;
}

/** The Requests page's list: message requests, one-to-one or a group, as conversation rows. */
export interface RawRequests {
  requests: RawConversation[];
  loading: boolean;
  more: boolean;
  failed: boolean;
}

/** What a conversation's inbox row says of its settings and who is in it (the `about` command). */
export interface RawAbout {
  conv: string;
  group: boolean | null;
  legacy: boolean | null;
  request: boolean;
  title: string | null;
  description: string | null;
  avatarUrl: string | null;
  muted: boolean | null;
  adminOnlyEditGroupInfo: boolean | null;
  adminOnlyAddMembers: boolean | null;
  adminOnlySendMessages: boolean | null;
  participants: { id: string; admin: boolean; current: boolean }[];
  /** In it now (null: the page did not say), and an admin there. */
  member: boolean | null;
  selfAdmin: boolean;
  users: RawUser[];
}

/** Someone to find in X's own search (New message, Add people): their id, and the handle typed into it. */
export interface PersonRef {
  id: string;
  handle: string;
}

export type Up =
  | { t: 'ready' }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { t: 'tabs'; tabs: { id: number; url: string; active: boolean; hook: boolean }[] }
  | { t: 'hook'; version: number; path: string }
  | ({ t: 'selftest' } & SelfTest)
  | ({ t: 'inbox' } & RawInbox)
  | ({ t: 'messages' } & RawMessages)
  | ({ t: 'requests' } & RawRequests)
  | { t: 'closed'; conv: string }
  | { t: 'page'; state: PageState; path: string; pinMode: string | null; pinComponent: boolean }
  | { t: 'self'; id: string };

export interface OutFile {
  name: string;
  mime: string;
  base64: string;
}

// ------------------------------------------------------------------ the feed
// x.com's own client (responsive-web: webpack, Redux, redux-thunk) around the chat embed: its notifications timeline
// and profiles, read through the page's own endpoint factories (docs/x.md, "Notifications and profiles"). What comes
// back is a whitelisted copy of X's GraphQL answer; feed.ts checks and maps it.

/**
 * webpack: the runtime's require, from a chunk pushed onto `webpackChunk_twitter_responsive_web`. store: the Redux store
 * (react-redux's context value in the fiber trees, or a value of its shape). endpoints: the thunk's extra argument with
 * `withEndpoint`. notifications: the Notifications tab's timeline module (its lazy chunk loaded as the tab loads it).
 * profiles: the endpoint factories with `fetchOneUser` and `fetchUserTweets`.
 */
export const FEED_HOOK_NAMES = ['webpack', 'store', 'endpoints', 'notifications', 'profiles'] as const;
export type FeedHookName = (typeof FEED_HOOK_NAMES)[number];

/** A feed read's answer: the notifications timeline as X's GraphQL gives it, whitelisted (unknown until feed.ts checks it). */
export interface FeedReply {
  timeline: unknown;
}
/** A profile read's answer: the user lookup's result and the Posts tab's timeline, whitelisted. */
export interface ProfileReply {
  user: unknown;
  tweets: unknown;
}

export type Down =
  | { kind: 'feed'; count: number; cursor?: string }
  | { kind: 'profile'; user: string }
  | { kind: 'selftest' }
  | { kind: 'diagnose' }
  | { kind: 'inbox' }
  | { kind: 'sync'; conv: string }
  | { kind: 'history'; conv: string; beforeTs?: number; limit: number }
  | { kind: 'send'; conv: string; text: string; replyTo?: string; files?: OutFile[] }
  | { kind: 'edit'; conv: string; message: string; text: string }
  | { kind: 'unsend'; conv: string; message: string }
  | { kind: 'react'; conv: string; message: string; emoji: string; remove?: boolean }
  | { kind: 'markRead'; conv: string; message?: string }
  | { kind: 'media'; conv: string; message: string; index: number }
  | { kind: 'requests' }
  | { kind: 'answer'; conv: string; answer: 'accept' | 'decline' | 'block' }
  | { kind: 'openDirect'; peer: string; handle: string | null }
  | { kind: 'createGroup'; people: PersonRef[]; name?: string }
  | { kind: 'addMembers'; conv: string; people: PersonRef[] }
  | { kind: 'about'; conv: string }
  | { kind: 'editGroup'; conv: string; title?: string; description?: string }
  | { kind: 'typing'; conv: string }
  | { kind: 'forward'; conv: string; message: string; to: string; peer?: string; query?: string; note?: string };
