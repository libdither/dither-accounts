/**
 * Sending with more than words (docs/sending.md): a reply that does not ping its author, a message sent silently,
 * sending later (the hub's own, on every network, with a network's own scheduled messages read beside them), taking a
 * link preview off your own message, and a network's saved messages and reminders (Discord's).
 *
 * All additive: an adapter says it has each with a capability, and the hub and the app offer it only then. The hub's
 * own Send later needs nothing from an adapter: it sends through the ordinary send path when the time comes.
 */

export type SendCapability =
  /** `send` takes `silent`: the message goes out without notifying anyone (Discord's @silent). */
  | 'silentSend'
  /** `send` takes `mentionReplied`: a reply pings its author or not, as the network's own reply toggle does. */
  | 'replyMention'
  /** Takes the link previews off your own message (the `suppressEmbeds` command; Discord's "Remove embeds"). */
  | 'suppressEmbeds'
  /** Says what you saved on the network and when it reminds you (the saved events), lists them and saves (`savedList`, `save`). */
  | 'savedMessages'
  /** Lists messages scheduled with the network's own Send later and cancels one (`nativeScheduled`, `cancelScheduled`). */
  | 'nativeScheduled';

/** A message saved on the network, as the network keeps it (native ids). */
export interface SavedFact {
  /** The conversation it is in, where the network said (a reminder always does; a bare saved id may not). */
  conversation?: string;
  message: string;
  /** ms epoch. */
  savedAt: number;
  /** ms epoch the network reminds you at (Discord's "Remind me"); absent, only saved. */
  dueAt?: number;
  /** Your note on it, where the network keeps one. */
  note?: string;
  /** What the network shows when the message itself is not loaded: its author, place and text, shortened. */
  summary?: { author?: string; place?: string; text?: string };
}

/** The `savedList` command's reply. Message facts for the saved messages it could load came first. */
export interface SavedListResult {
  saved: SavedFact[];
  /** More saved messages past these: ask again with `before` = the oldest `savedAt` here. */
  more: boolean;
}

/** A message scheduled with the network's own Send later (Discord's scheduled messages), native ids. */
export interface NativeScheduledFact {
  nativeId: string;
  conversation: string;
  body: string;
  /** ms epoch it goes out at. */
  dueAt: number;
  silent?: boolean;
  /** Native message id it replies to. */
  replyTo?: string;
}

/** The `nativeScheduled` command's reply. `enabled`: false when the network does not offer it to this account. */
export interface NativeScheduledResult {
  enabled: boolean;
  scheduled: NativeScheduledFact[];
}

/** Adapter events for the capabilities above. */
export type SendEvent =
  /**
   * Saved messages as the network now has them (capability 'savedMessages'). `complete`: these are every one of this
   * account's, and the hub forgets any it had that is not here. Without it, these are new or changed.
   */
  | { t: 'saved'; saved: SavedFact[]; complete?: boolean }
  /** No longer saved. */
  | { t: 'unsaved'; message: string; conversation?: string }
  /** A reminder you set on the network is due now (Discord's own client says so at its time). */
  | { t: 'reminderDue'; saved: SavedFact };

/** Adapter commands for the capabilities above. Each answers once the network took it. */
export type SendCommand =
  /** Take the link previews off your own message (capability 'suppressEmbeds'). The message fact again follows. reply.result: {} */
  | { t: 'suppressEmbeds'; id: string; conversation: string; message: string }
  /**
   * Save a message on the network, with a reminder at `dueAt` (ms epoch) where given, or (`remove`) stop keeping it
   * (capability 'savedMessages'). reply.result: SavedFact, or {} for a removal; a saved or unsaved event follows.
   */
  | { t: 'save'; id: string; conversation: string; message: string; dueAt?: number; remove?: true }
  /**
   * What you saved on the network, newest first, as the network's own list reads it when opened (capability
   * 'savedMessages'). `before`: the page after one whose oldest savedAt this is. Message facts first, then
   * reply.result: SavedListResult.
   */
  | { t: 'savedList'; id: string; before?: number }
  /** Messages scheduled with the network's own Send later (capability 'nativeScheduled'). reply.result: NativeScheduledResult */
  | { t: 'nativeScheduled'; id: string }
  /** Cancel one of them (capability 'nativeScheduled'). reply.result: {} */
  | { t: 'cancelScheduled'; id: string; nativeId: string };

/** At most this many saved on Discord: reminders and saved messages, its own limits. */
export const SAVED_LIMITS = { reminders: 50, saved: 500 } as const;

// ------------------------------------------------------------------ the hub's Send later

/**
 * Where a message sent later stands (docs/sending.md "Send later"):
 * - waiting: its time has not come, or it has and the account is not connected yet (`note` says which);
 * - sending: going out now;
 * - held: its time passed more than SEND_LATER_LATE_MS ago and it did not go: it waits for you to send it or cancel it;
 * - failed: the network or the hub refused it (`note` says why); edit and try again, or cancel;
 * - sent: it went out (kept a little while, then gone from the list).
 */
export type ScheduledState = 'waiting' | 'sending' | 'held' | 'failed' | 'sent';

/** Never sent more than this late without asking: past it, a message waiting for its account is held. */
export const SEND_LATER_LATE_MS = 30 * 60_000;
/** At least this far ahead, so a time picked by mistake in the past is caught. */
export const SEND_LATER_MIN_MS = 60_000;
/** At most this far ahead. */
export const SEND_LATER_MAX_MS = 366 * 24 * 3_600_000;
/** At most this many waiting at once. */
export const SEND_LATER_MAX = 200;

/** A message to send later, as the app shows it. */
export interface ScheduledSendView {
  id: string;
  /** 'hub': the hub sends it. 'network': scheduled with the network's own Send later (Discord); cancel only. */
  where: 'hub' | 'network';
  conversationId: string;
  accountId: string;
  body: string;
  /** ms epoch. */
  dueAt: number;
  state: ScheduledState;
  /** Why it waits, is held or failed, in words. */
  note: string | null;
  replyTo: string | null;
  /** Files going with it: their names. */
  files: string[];
  silent: boolean;
  /** For a reply: whether it pings the author; null, the network's default. */
  mentionReplied: boolean | null;
  createdAt: number;
  /** The message it became, once sent. */
  messageId: string | null;
  /** For where 'network': the network's own id, to cancel it by. */
  nativeId?: string;
}

/** POST /api/scheduled. Where it goes is said as for a send: `chatId` (and `route`) or `conversationId` (and `accountId`). */
export interface ScheduleBody {
  chatId?: string;
  route?: { conversationId?: string; accountId?: string };
  conversationId?: string;
  accountId?: string;
  body?: string;
  replyTo?: string;
  /** Upload ids (docs/uploads.md): the hub keeps them until it sends. */
  attachments?: string[];
  silent?: boolean;
  mentionReplied?: boolean;
  dueAt: number;
}

/** Why a time cannot be picked, or null. */
export function sendLaterProblem(dueAt: unknown, now = Date.now()): string | null {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) return 'Pick a time';
  if (dueAt < now + SEND_LATER_MIN_MS) return 'Pick a time at least a minute from now';
  if (dueAt > now + SEND_LATER_MAX_MS) return 'Pick a time within a year';
  return null;
}

/** A saved message as the app shows it (GET /api/saved). */
export interface SavedView {
  accountId: string;
  messageId: string;
  conversationId: string | null;
  savedAt: number;
  dueAt: number | null;
  note: string | null;
  summary: SavedFact['summary'] | null;
}

/** GET /api/saved. `messages`: those the hub has, by id, with the identities they name. */
export interface SavedPage {
  saved: SavedView[];
  messages: import('./api.ts').MessageView[];
  identities: import('./api.ts').IdentityView[];
  /** Accounts that could not be asked now, with why. */
  errors: { accountId: string; error: string }[];
  /** Accounts with more saved messages on the network than listed: ask again with `before`. */
  more: string[];
}
