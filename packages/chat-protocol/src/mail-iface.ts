/**
 * A copy of dither-accounts' `mail` interface types (packages/interfaces/src/mail.ts there), so the hub depends on the
 * interface and not on dither-accounts' code. `bun scripts/accounts-sync.ts --check` reports when the two differ.
 *
 * Copied from there unchanged, from its first type (MailAddress) to the op table, which stays theirs (the spec's
 * builders). Their file's header says what each field means on the wire.
 */

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
