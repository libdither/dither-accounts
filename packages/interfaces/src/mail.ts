/**
 * `mail`: a mailbox, the same to an app whether IMAP (with SMTP to send), JMAP or a provider's own API is behind it.
 *
 * - Ids (`id`, `mailboxId`, attachment ids) are the extractor's own: opaque, stable while the message stays in its
 *   mailbox, and new after a move (IMAP gives it a new UID there). `messageId` is the RFC 5322 Message-ID, the one id
 *   that is the same everywhere; threads and replies go by it.
 * - Times are milliseconds since the epoch.
 * - Keeping up: call `mail.changes` with the `state` the last call gave; a `mail.changed` event says when to. Without
 *   a state it answers the current one and nothing else, as a starting point. A failed call with CallError.status 410
 *   means the state is too old (the mailbox was rebuilt): list it again.
 * - Attachments come back as base64, at most 25 MB, like chat's fetchMedia; outgoing ones may name a local file.
 * - Message-IDs (`messageId`, `inReplyTo`, `references`) are written one way everywhere: with their angle brackets,
 *   `<abc@example.com>`, so one can be looked up by another as it stands.
 * - Threading and bulk headers on a summary (`inReplyTo`, `references`, `bulk`) are optional: an extractor that
 *   cannot see a message's headers without fetching its body gives `null`, `[]` and no `bulk` there (Proton's lists;
 *   its `threadId` is the thread), and `mail.get` has them all.
 *
 * The `status` event, besides what every extractor's has (`layers`, `details`, `self`, see the README), says (all
 * optional, so an extractor that predates them stays valid):
 *
 * - `self.addresses: MailAccountAddress[]`: the addresses this account sends as, the one it uses when `from` is not
 *   given first. `OutgoingMail.from` must be one of them.
 * - `details.canSend: boolean`: whether `mail.send` can send now (IMAP: SMTP is set up and its last sign-in or send
 *   worked; Proton: signed in, and the Mail page's API caller, store, crypto proxy and address keys were found).
 *   Reading, flags, moves and trash do not depend on it, and false is not "read-only". True does not promise that
 *   every message goes: Proton's mail.send refuses some recipients and settings (below, `mail.send`).
 * - `details.sendNote: string | null`: when it cannot, why, in a sentence to show a person; null when it can.
 * - `details.summaryHeaders: boolean`: whether the summaries of `mail.list`, `mail.search` and `mail.changes` carry
 *   `inReplyTo`, `references` and `bulk` (IMAP: true, fetched with them; Proton: false, only `mail.get` has its headers,
 *   so its summaries carry Proton's categories as labels, `Category/Promotions` and the like, instead). Absent: unknown.
 * - `details.idPerMessage: boolean`: true when a message has one id in every mailbox it is in (Proton: its message id;
 *   Gmail through the google kind: Gmail's message id), so a move or a label keeps its id and All Mail holds the same
 *   ids as the other mailboxes. False or absent: ids are per mailbox (IMAP: mailbox, UIDVALIDITY and UID).
 * - `details.raw: 'original' | 'rebuilt'`: `mail.raw` answers (absent: it does not). original: the message byte for
 *   byte as the server keeps it (IMAP: BODY.PEEK[], so \Seen stays); rebuilt: put together from what the server keeps
 *   (the answer then says `rebuilt: true`). At most 50 MB; larger is 413.
 * - `details.searchIds: boolean`: `mail.search` takes `idsOnly` (below): ids only, paged by `cursor`, with the
 *   server's estimate of how many match (the google kind: Gmail's own search, operators only). Absent: it does not.
 * - `details.sendCap: number`: the most bytes of attachments one message may carry (Proton: 25 MB); larger is 413.
 * - `details.maxRecipients: number`: the most recipients (to, cc and bcc together) one message may have (Proton: 100).
 * - `details.backgroundLane: boolean`: `mail.list`, `mail.search`, `mail.get`, `mail.attachment` and `mail.raw` take
 *   an extra input, `background?: true` (not in their schemas, which let unknown keys through), for reading in the
 *   background (an archive): such a call waits behind every other call of the account and is paced and budgeted on
 *   its own (the google kind: one list or search page per 3 s, one message per 2 s, 2 GB a day, backing off after a
 *   slow, 429 or 5xx answer). Send it only where this is true. Absent: there is no background lane.
 * - `details.backgroundStopped: string | null`: why background calls are refused now (the google kind: 'challenge',
 *   'signedOut' or 'quota'), until the cause clears; null when they are not.
 * - `details.readsMarkRead: boolean`: reading a message was seen to mark it read on the server, so unread messages are
 *   refused (409 'unread', below). Absent or false: reading leaves a message as it was.
 * - `details.writes: MailWriteKind[]`: the writes this account makes now: `seen` and `flagged` (`mail.flag`), `move`
 *   (`mail.move` to archive, to Inbox, or into a label or folder), `trash` (`mail.move` into Trash, and `mail.trash`)
 *   and `junk` (`mail.move` into Spam or Junk). A write of a kind not listed answers 501 without reaching the server.
 *   Absent: not said; try, and a 501 says the account does not make that write.
 *
 * Writes (`mail.flag`, `mail.move`, `mail.trash`) take `ids` and, optionally, `threadIds` beside them in the same order:
 * each message's `threadId` as its summary gave it (null where unknown). An extractor that needs a message's thread
 * to change it (the google kind) uses its own record first and these where it has none. Each write is all or part:
 *
 * - All of it applied: `mail.flag` and `mail.trash` answer `{}`, `mail.move` its new ids.
 * - Part of it: a 200 that names what did not change. `refused`: ids whose change the server turned down; `unknown`:
 *   ids the extractor could not find on the server (gone, or no thread to change them in). Every other id changed. In
 *   `mail.move`'s `ids`, each of these is null: null and listed means it did not move (undo it); null and not listed
 *   means it moved and the server would not say its new id (find it with `mail.changes`).
 * - None of it: an error, as below.
 *
 * Codes a write may fail with (CallError.code, with its status), besides `failed`:
 *
 * - 422 `refused`: the server turned down every change; nothing changed.
 * - 404: none of the ids is a message the server knows.
 * - 400: input the extractor never sends to the server, such as a move it does not make (the google kind: into Sent,
 *   Drafts, Scheduled or Chats, or All Mail as a label; All Mail as the destination is archive).
 * - 501: the account does not make this write (`details.writes`).
 * - 503 `unavailable`: the account cannot write now (the google kind: its Gmail page is closed, reloading, signed out,
 *   at a challenge, or has not synced yet); nothing was sent. Try again later.
 * - 502 or 504: the outcome is unclear (an answer the extractor could not read, or no answer in time); part or all of
 *   it may have changed. Where the writes are label or flag changes (the google kind), sending the same write again is
 *   harmless. A write sent in several calls to the server answers the first such error for the whole write.
 *
 * Codes a read may fail with (CallError.code, with its status), besides `failed`:
 *
 * - 503 `paused`: a `background: true` call while the background lane is stopped (`details.backgroundStopped`); the
 *   same call without `background` may still be answered. Try again once the status says it is no longer stopped.
 * - 503 `backoff`: a `background: true` call that could not start in time (the lane is backed off, or busy); try later.
 * - 409 `unread`: `mail.get`, `mail.raw` or `mail.attachment` on a message known to be unread where reading marks mail
 *   read (`details.readsMarkRead`); read it on the server's own app.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface MailAddress {
  name: string | null;
  email: string;
}

export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | 'important';

export interface Mailbox {
  id: string;
  /** Its own name, the last part of the path. */
  name: string;
  /** The full path as the server shows it, `Work/Clients`. */
  path: string;
  parentId: string | null;
  /** What it is for, when the server says (IMAP SPECIAL-USE, JMAP role), or the extractor is sure. */
  role: MailboxRole | null;
  unread: number | null;
  total: number | null;
}

export interface MailFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
}

export interface MailSummary {
  id: string;
  mailboxId: string;
  messageId: string | null;
  /** The server's thread, when it has threads (Gmail, JMAP); otherwise null. */
  threadId: string | null;
  /**
   * The server's own id for this message, the same in every mailbox it is in: Gmail's X-GM-MSGID, or RFC 8474's
   * EMAILID (OBJECTID servers such as Dovecot). Absent when the server has none. A message with no Message-ID header is
   * one message across mailboxes by this.
   */
  emailId?: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** The Date header. */
  date: number;
  /** When the server got it. */
  receivedAt: number;
  flags: MailFlags;
  /** Keywords or labels beyond the flags (Gmail labels, IMAP keywords). */
  labels: string[];
  size: number;
  /** The start of the text, when the server gives one cheaply. */
  preview: string | null;
  hasAttachments: boolean;
  /** The In-Reply-To header's Message-ID; null when there is none or the extractor cannot see it here. */
  inReplyTo?: string | null;
  /** The References header's Message-IDs, oldest first: at most 20 (the first, the thread's root, and the last 19). */
  references?: string[];
  /** Headers that say the message came from a list or a machine; present only when at least one of them is there. */
  bulk?: MailBulk;
}

/** Raw header values for an app to decide what is bulk: unfolded, trimmed, 300 characters at most; null when absent. */
export interface MailBulk {
  /** List-Id, as `"Name" <list.example.com>` or just `<list.example.com>`. */
  listId: string | null;
  /** List-Unsubscribe, `<https://…>, <mailto:…>`. */
  unsubscribe: string | null;
  /** Precedence: `bulk`, `list`, `junk`, … */
  precedence: string | null;
  /** Auto-Submitted: `auto-generated`, `auto-replied`, … (`no` means a person sent it). */
  autoSubmitted: string | null;
}

/** One address an account sends as: `status.self.addresses`. */
export interface MailAccountAddress {
  email: string;
  /** The name it puts in From, when it has one. */
  name: string | null;
}

export interface MailAttachment {
  id: string;
  filename: string | null;
  mime: string;
  size: number;
  inline: boolean;
  /** For inline parts that the HTML refers to as cid:… */
  contentId: string | null;
}

export interface MailMessage extends MailSummary {
  bcc: MailAddress[];
  replyTo: MailAddress[];
  /** The In-Reply-To header's Message-ID, or null. */
  inReplyTo: string | null;
  /** Every Message-ID in the References header, oldest first. */
  references: string[];
  /** The plain text part, or text made from the HTML when there is none. */
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
}

export interface MailChanges {
  /** Pass it to the next mail.changes. */
  state: string;
  added: MailSummary[];
  changed: { id: string; flags: MailFlags; labels: string[] }[];
  removed: string[];
  /** More changes wait: call again with the new state. */
  more: boolean;
}

export interface OutgoingFile {
  filename: string;
  mime: string;
  /** A file on this machine, or the bytes. One of the two. */
  path?: string;
  base64?: string;
}

export interface OutgoingMail {
  /**
   * The address to send as: one of the account's own (`status.self.addresses`), any other is refused (422). Without it,
   * the first of them (Proton: a reply goes from the address the original came to).
   */
  from?: string;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  /** At least one of text and html. */
  text?: string;
  html?: string;
  /** A reply to this message (its id): sets In-Reply-To and References, and marks the original answered. */
  replyTo?: string;
  attachments?: OutgoingFile[];
}

/** A kind of write an account makes (`details.writes`). */
export type MailWriteKind = 'seen' | 'flagged' | 'move' | 'trash' | 'junk';

/** `mail.flag` and `mail.trash`: `{}` when every change applied, else the ids that did not change (header). */
export interface MailWriteAnswer {
  refused?: string[];
  unknown?: string[];
}

/** `mail.move`: new ids in the order asked, null where it did not move (listed) or the server would not say (not). */
export interface MailMoveAnswer extends MailWriteAnswer {
  ids: (string | null)[];
}

const ids = s.array(s.string, 1000);
/** Beside `ids`, in the same order: each message's thread as its summary gave it (header, "Writes"). */
const threadIds = s.optional(s.array(s.nullable(s.string), 1000));

export const mail = iface({
  name: 'mail',
  version: 1,
  describe: 'Email: your mailboxes, their messages, and sending as you.',
  levels: {
    read: 'Read your email and its attachments',
    write: 'Send email as you, and mark, move and delete your messages',
  },
  ops: {
    'mail.mailboxes': op('read', 'Your mailboxes (folders), with counts', s.object({}), s.typed<{ mailboxes: Mailbox[] }>()),
    'mail.list': op(
      'read',
      "A mailbox's messages, newest first, a page at a time",
      s.object({ mailboxId: s.string, limit: s.optional(s.integer), before: s.optional(s.string), since: s.optional(s.number) }),
      s.typed<{ messages: MailSummary[]; next: string | null }>(),
      60_000,
    ),
    'mail.get': op('read', 'One message, with its text, HTML and the list of its attachments', s.object({ id: s.string }), s.typed<MailMessage>(), 60_000),
    'mail.attachment': op(
      'read',
      "One attachment's bytes (at most 25 MB)",
      s.object({ id: s.string, attachmentId: s.string }),
      s.typed<{ filename: string | null; mime: string; base64: string }>(),
      120_000,
    ),
    'mail.raw': op(
      'read',
      'The whole message as one RFC 822 file: the original as the server keeps it, or rebuilt where it keeps none (details.raw)',
      s.object({ id: s.string }),
      s.typed<{ filename: null; mime: 'message/rfc822'; base64: string; size: number; rebuilt?: true }>(),
      120_000,
    ),
    /**
     * Where `details.searchIds` is true: `idsOnly` answers `{ ids, next, estimate }` instead (up to 500 a page, the
     * next from `cursor: next`; `estimate` the server's count of matches, or null), and `next` may come with
     * `messages` too. The google kind takes Gmail's search syntax; with `idsOnly`, operators only (`in:inbox
     * newer_than:30d`), anything else is 400.
     */
    'mail.search': op(
      'read',
      'Messages with these words in the sender, recipients, subject or text, newest first',
      s.object({ query: s.string, mailboxId: s.optional(s.string), limit: s.optional(s.integer), idsOnly: s.optional(s.boolean), cursor: s.optional(s.string) }),
      s.typed<{ messages: MailSummary[]; next?: string | null } | { ids: string[]; next: string | null; estimate: number | null }>(),
      120_000,
    ),
    'mail.changes': op('read', 'What changed in a mailbox since a state', s.object({ mailboxId: s.string, state: s.optional(s.string), limit: s.optional(s.integer) }), s.typed<MailChanges>(), 120_000),
    'mail.flag': op(
      'write',
      'Mark messages read or unread, flagged, answered',
      s.object({ ids, threadIds, seen: s.optional(s.boolean), flagged: s.optional(s.boolean), answered: s.optional(s.boolean) }),
      s.typed<MailWriteAnswer>(),
    ),
    'mail.move': op(
      'write',
      'Move messages to another mailbox; answers their new ids in the same order (null where it did not move, listed in refused or unknown, or where the server would not say: find it with mail.changes)',
      s.object({ ids, threadIds, mailboxId: s.string }),
      s.typed<MailMoveAnswer>(),
    ),
    'mail.trash': op('write', 'Move messages to the trash (deleted outright where there is none)', s.object({ ids, threadIds }), s.typed<MailWriteAnswer>()),
    /**
     * Fails with status 422 and one of these codes (CallError.code) when it refuses the message as it stands; nothing
     * was made or sent, and the message is a sentence to show a person (recipients named by number, 1 being the first
     * of to, then cc, then bcc, each address once):
     *
     * - `from`: `from` is not one of the account's addresses that can send (`status.self.addresses`).
     * - `recipients` (Proton): a recipient this cannot be sure how Proton would send to: one with encryption settings
     *   or a pinned key in your Proton contacts, an outside address that publishes a key, one Proton warns about or
     *   whose lookup failed, a Proton address with no key it can encrypt to. Send that message from Proton itself.
     * - `settings` (Proton): your Proton settings sign mail to outside addresses or attach your public key (or sign with
     *   PGP/Inline, which turns an HTML message into plain text), and the message has someone it would go to in the
     *   clear. Send it from Proton, or change the setting.
     *
     * Any other refusal has code `failed` and its status (400 bad input, 413 too big, 501 the account cannot send at
     * all: `details.canSend` is false).
     */
    'mail.send': op('write', 'Send a message as you; a copy goes to Sent where the server keeps one', s.typed<OutgoingMail>('an outgoing message'), s.typed<{ messageId: string; sentId: string | null }>(), 120_000),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'mail.arrived': ev('A new message in a watched mailbox (at least the inbox)', s.typed<{ message: MailSummary }>()),
    'mail.changed': ev('Something changed in a mailbox: call mail.changes from your last state', s.typed<{ mailboxId: string; state: string }>()),
  },
});
