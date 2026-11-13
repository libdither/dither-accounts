/**
 * Email, hub <-> client (docs/mail.md, docs/mail-design.md §5). Mail comes from dither-accounts' `mail` interface
 * (mail-iface.ts) and is kept in the hub's own mail tables; these are the views the page gets of it.
 *
 * Ids are hub ids (ids.ts mailId): `mbx_` mailboxes, `mml_` messages, `mth_` threads, `mob_` outbox items. Mail
 * accounts keep the manager's account id. Times are ms since the epoch.
 *
 * Built in slices (docs/mail-design.md §12). Fields a later slice fills are here already, with the value they have
 * until then: a seam, not a promise. Each says which slice fills it.
 */
import type { IdentityView, TriageView } from './api.ts';
import type { FileInfo } from './files.ts';
import type { MailboxRole, MailWriteKind } from './mail-iface.ts';

export type { MailboxRole, MailWriteKind } from './mail-iface.ts';

/**
 * Whether this hub may read your mail: `off` without DITHER_ACCOUNTS_URL, `unreachable` while the manager does not
 * answer, `pending` until you approve the hub's request on the manager's page, `denied` if you declined it.
 */
export interface MailAccess {
  state: 'off' | 'unreachable' | 'pending' | 'denied' | 'granted';
  /** The manager's page, where you approve the request and add mail accounts (DITHER_ACCOUNTS_PUBLIC_URL). */
  managerUrl: string | null;
}

export interface MailAccountView {
  /** The manager's account id. */
  id: string;
  /** dither-accounts' kind: `imap`, `proton`, `google` (Gmail on the web). */
  kind: string;
  label: string;
  /** The address it receives at, once the account has said. */
  address: string | null;
  name: string | null;
  color: string;
  /** What the hub's grant lets it do; null once access to the account has ended. */
  level: 'read' | 'write' | null;
  /** Writes are answered without reaching the account. */
  dryRun: boolean;
  online: boolean;
  /** Why it cannot work now: the account's attention, else its first layer that is not ok. */
  problem: { layer: string | null; message: string } | null;
  /**
   * Whether sending works: false with why, true after a send, null before anyone knows (slice 5 sends). `refused`: the
   * account answered a send with 501, so it is off until you ask again (POST /api/mail/accounts/:id/sending).
   */
  send: { ok: boolean | null; why: string | null; refused?: boolean };
  sync: { phase: 'first' | 'backfill' | 'idle' | 'relist'; synced: number; oldest: number | null };
  /** The account on the manager's page, when the hub knows the page's address. */
  managedUrl: string | null;
  /** Access ended (it left the manager's list, or the grant went): its mail here is deleted at this time. */
  deleteAt: number | null;
  /** Writes made here (slice 4): how many messages wait for the server, the last that failed, ops it refused (501). */
  ops?: MailOpsView;
  /**
   * The most bytes of files, together, one message from it may carry (a send over it is refused, 413): what its
   * extractor says (`details.sendCap`), else 25 MB on Proton and 35 MB elsewhere.
   */
  sendCap?: number;
  /** The most recipients, To, Cc and Bcc together, on one message: `details.maxRecipients`, else 100 on Proton and 500 elsewhere. */
  maxRecipients?: number;
  /**
   * The writes the account makes now, as its status says (`details.writes`): a kind not listed is refused here
   * without a call, and its buttons are hidden. Null or absent: not said, so every write is tried (a 501 says no).
   */
  writes?: MailWriteKind[] | null;
}

/** An account's writes (slice 4). */
export interface MailOpsView {
  /** Messages with a change the server has not confirmed yet. */
  waiting: number;
  /** The last change that could not be made, undone here. */
  error: { message: string; at: number } | null;
  /**
   * What the account answered 501 to: `flag.seen`, `flag.flagged`, `move`, `trash` or `junk` (a move into the trash
   * or junk; older rows say `move` for those too). Its buttons are hidden.
   */
  unsupported: string[];
}

export interface MailboxView {
  id: string;
  accountId: string;
  name: string;
  path: string;
  parentId: string | null;
  role: MailboxRole | null;
  unread: number | null;
  total: number | null;
  /** The hub keeps this mailbox up to date by itself (Inbox, Sent, All or Archive). */
  followed: boolean;
}

export interface MailAddressView {
  name: string | null;
  email: string;
  /** The person and identity behind the address (slice 6). */
  identityId?: string;
  personId?: string;
}

export interface MailThreadView {
  id: string;
  accountId: string;
  subject: string;
  firstAt: number;
  lastAt: number;
  count: number;
  unread: number;
  flagged: boolean;
  attachments: boolean;
  /** Who wrote in it, latest last; your own messages have `self`. */
  from: (MailAddressView & { self?: boolean })[];
  participants: number;
  preview: string | null;
  mailboxIds: string[];
  roles: MailboxRole[];
  labels: string[];
  /** From a person, bulk, or yours (slice 8; null until then). */
  class: 'personal' | 'bulk' | 'self' | null;
  unknown: boolean;
  personIds: string[];
  lastFromMe: boolean;
  /** When the first message you have not answered came (slice 8). */
  owedSince: number | null;
  muted: boolean;
  /** A change made here the server has not confirmed yet (slice 4). */
  pending?: boolean;
  /** Triage's newest decision on a message in it from someone else (slice 9): the Triage board's mail row. */
  triage?: MailTriageItem;
}

export interface MailMessageView {
  id: string;
  threadId: string;
  accountId: string;
  /** The Message-ID header, `<abc@example.com>`. */
  messageId: string | null;
  from: MailAddressView;
  to: MailAddressView[];
  cc: MailAddressView[];
  subject: string;
  date: number;
  receivedAt: number;
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean };
  /** Read here only (a read grant, or before marking on the server: slice 4). */
  seenHere: boolean;
  /** A change made here the server has not confirmed yet (slice 4). */
  pending: boolean;
  labels: string[];
  mailboxIds: string[];
  hasAttachments: boolean;
  preview: string | null;
  addressed: 'to' | 'cc' | 'hidden' | 'self';
  body: 'cached' | 'none' | 'loading' | 'failed';
  /** Triage's decision on it, and your vote (slice 9); absent when it was not triaged (bulk, yours, older mail). */
  triage?: TriageView;
}

/**
 * A message triage decided on (slice 9, docs/mail.md "Triage and notifications"): the Triage board lists these beside
 * chat's messages, by the same levels. Votes go to POST /api/messages/:id/feedback as chat's do.
 */
export interface MailTriageItem {
  kind: 'mail';
  /** The message (`mml_`). */
  id: string;
  threadId: string;
  accountId: string;
  from: MailAddressView;
  subject: string;
  preview: string | null;
  /** When it reached the server. */
  ts: number;
  unread: boolean;
  triage: TriageView;
}

/** GET /api/mail/triage?since=<ms>: the last week's, newest first. */
export interface MailTriagePage {
  items: MailTriageItem[];
}

export interface MailBodyView {
  messageId: string;
  /** The text part, or text made from the HTML when there is none. */
  text: string | null;
  /** Where quoted text starts in `text` (quoteStart). */
  quoteAt: number | null;
  /**
   * The sanitised HTML (slice 3; null until then). `plain`: it is only text, paragraphs, links, lists, quotes, bold
   * and italic, and the mail has a text part saying as much, so the reader shows `text` in the app's theme rather
   * than this on a white sheet (hub sanitize.ts `plain`, parts.ts `hasTextPart`).
   */
  html: { url: string; remoteImages: number; trackers: number; imagesShown: boolean; plain?: boolean } | null;
  bcc: MailAddressView[];
  replyTo: MailAddressView[];
  /** Slice 3. */
  attachments: MailAttachmentView[];
  /** Display-name spoofing, Reply-To elsewhere, links whose text names another site (slice 3). */
  warnings: string[];
}

export interface MailAttachmentView {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  /** A part shown in place (a picture in a text mail); parts the HTML shows itself are not listed. */
  inline: boolean;
  /** The bytes (fetched from the server the first time). */
  url: string;
  /** What the file is by its bytes (FileInfo), looked at when asked. */
  infoUrl: string;
  /** What it is, once the hub has looked. */
  info?: FileInfo;
}

/** Slice 5. */
export interface MailOutboxView {
  id: string;
  clientId: string;
  accountId: string;
  subject: string;
  state: 'held' | 'queued' | 'sending' | 'sent' | 'failed';
  holdUntil: number | null;
  error: string | null;
  // Slice 5 (sending): the rest.
  kind?: MailComposeKind;
  /** The thread it answers or forwards from. */
  threadId?: string | null;
  to?: MailAddressView[];
  /** The draft it came from: put back there when it is undone or fails. */
  draftKey?: string | null;
  /** It may have gone out (the account did not answer in time): look in Sent before sending it again. */
  unsure?: boolean;
  /** The Message-ID it went out with, once sent; its copy in Sent has it. */
  sentMessageId?: string | null;
  /** Answered by a dry run: nothing reached the account. */
  dryRun?: boolean;
  createdAt?: number;
}

// ------------------------------------------------------------------ sending (slice 5)

export type MailComposeKind = 'new' | 'reply' | 'replyAll' | 'forward';

/** An attachment of the original that a forward carries. */
export interface MailForwardPart {
  messageId: string;
  attachmentId: string;
  name: string | null;
  mime: string;
  size: number;
}

/** A file already on the hub (an upload), as a draft keeps it. */
export interface MailDraftFile {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
}

/** What the composer holds: a draft as the hub keeps it, and what a send carries. */
export interface MailDraft {
  accountId: string;
  kind: MailComposeKind;
  /** The message answered or forwarded (a hub message id, `mml_`). */
  replyTo: string | null;
  /** One of the account's own addresses; null: the account's first. */
  from: string | null;
  to: MailAddressView[];
  cc: MailAddressView[];
  bcc: MailAddressView[];
  subject: string;
  /** What you wrote. The quote or the forwarded message goes after it, made by the hub. */
  text: string;
  /** A reply quotes the original. */
  quote: boolean;
  files: MailDraftFile[];
  forwardParts: MailForwardPart[];
}

/** GET /api/mail/drafts[/:key]. Keys: `t:<thread>` for a reply or forward, `new:<uuid>` for a new message. */
export interface MailDraftView {
  key: string;
  draft: MailDraft;
  updatedAt: number;
}

/** POST /api/mail/send. Sent once per `clientId`. */
export interface MailSendRequest extends MailDraft {
  clientId: string;
  draftKey: string | null;
  /** The page's time zone, for the "On <date>, <name> wrote:" line. */
  tz?: string;
}

/** GET /api/mail/compose: a reply, reply all or forward filled in, or a new message's choices. */
export interface MailComposeStart {
  draft: MailDraft;
  /** Where the draft goes: `t:<thread>` or `new:<uuid>`. */
  draftKey: string;
  /** The addresses it may send as (status.self.addresses), the account's own first. */
  fromChoices: { accountId: string; email: string; name: string | null }[];
  /** "On Tue, Nov 3, 2026 at 10:42 AM, Sam Lee <sam@lee.example> wrote:" and the quoted text, or the forwarded block. */
  quote: { head: string; text: string } | null;
  /** The original could not be fetched to quote: why. */
  quoteError: string | null;
  /** Reply all would reach more people than reply. */
  replyAllDiffers: boolean;
}

/** A recipient the composer offers as you type. */
export interface MailAddressHit extends MailAddressView {
  /** You have written to it. */
  wroteTo: boolean;
  count: number;
}

/** What the bootstrap carries of mail: the live window of threads, at most 300. */
export interface MailBootstrap {
  access: MailAccess;
  accounts: MailAccountView[];
  mailboxes: MailboxView[];
  threads: MailThreadView[];
  /** What the outbox still shows (slice 5). */
  outbox?: MailOutboxView[];
}

/** GET /api/mail/threads: a page of a list, newest first. */
export interface MailThreadPage {
  threads: MailThreadView[];
  /** The cursor for the next page, or null at the end of what the hub holds. */
  next: string | null;
  /** The hub holds the whole list (else older mail is on the server only, for now). */
  complete: boolean;
  /** The page is being fetched from the server; a `mail.threads` event brings it (slice 2). */
  pending: boolean;
}

/** GET /api/mail/threads/:id */
export interface MailThreadDetail {
  thread: MailThreadView;
  messages: MailMessageView[];
  /** The email identities of the people on it (slice 6). */
  identities?: IdentityView[];
}

// ------------------------------------------------------------------ writes (slice 4)

/** Where a move goes: a mailbox id, or one by its role in each thread's own account. */
export type MailMoveTarget = 'archive' | 'inbox' | 'trash' | 'junk' | (string & {});

/** POST /api/mail/flag. Threads: read marks all of them read, unread its latest; star its latest, unstar all. */
export interface MailFlagRequest {
  threadIds?: string[];
  messageIds?: string[];
  seen?: boolean;
  flagged?: boolean;
  /** The page's id for this change: sent again (after the connection dropped), it is made once. */
  clientId?: string;
}

/** POST /api/mail/move. Archive moves only what is in Inbox; the others move the whole thread but what you sent. */
export interface MailMoveRequest {
  threadIds?: string[];
  messageIds?: string[];
  to: MailMoveTarget;
  clientId?: string;
}

/** What a write did here: threads changed, messages that will be told to the server. */
export interface MailOpResult {
  ok: true;
  threads: number;
  messages: number;
}

/** GET/PUT /api/mail/settings. `markRead`: on the server after a second in view, or only when you mark it (§14 Q3). */
export interface MailSettings {
  markRead: 'view' | 'manual';
}

// ------------------------------------------------------------------ search (slice 7)

/** One thread a mail search found. */
export interface MailSearchHit {
  thread: MailThreadView;
  /** Its newest message that matched, and when that came. */
  messageId: string;
  at: number;
  /** Matched text with \u0001 and \u0002 around each match, or the start of the message; null when only its subject or people matched. */
  snippet: string | null;
  /** How many of its messages matched here (1 for a server hit). */
  matches: number;
  /** Only a server found it: the hub did not hold it, or did not hold the text that matched. */
  server?: boolean;
}

/** How one account's server search went. */
export interface MailServerSearch {
  accountId: string;
  /**
   * `skipped`: nothing a server can search for (only filters), or the account cannot be asked now. `local`: not asked
   * (server=auto), because the hub holds all of this account's mail and searched it here ("Keeping all mail").
   */
  state: 'done' | 'failed' | 'offline' | 'skipped' | 'local';
  /** Messages it answered with. */
  found: number;
  error: string | null;
  /** What this server cannot search, e.g. Proton: subjects and addresses only. */
  note: string | null;
}

/** GET /api/mail/search?q=&cursor=&limit=&server=0|1|auto: the hub's own hits, newest first, then the servers'. */
export interface MailSearchPage {
  hits: MailSearchHit[];
  next: string | null;
  /** How the words matched: whole words, inside words (nothing matched as whole words), or no words, only filters. */
  mode: 'fulltext' | 'substring' | 'filters';
  /** Nothing matched as typed: these hits are for this query (misspelt words corrected). */
  corrected?: string;
  /** Asked of the servers (server=1, or server=auto and a first page under 20 hits): threads the hub's own search did not find, newest first. */
  server?: { hits: MailSearchHit[]; accounts: MailServerSearch[] };
}

// ------------------------------------------------------------------ keeping all mail (docs/mail.md "Keeping all mail")

/** Why an account's background reads stopped: what its status said (`details.backgroundStopped`), or a call's 503 `paused`. */
export type MailKeepStop = 'challenge' | 'signedOut' | 'quota' | 'paused' | (string & {});

/** One mailbox of a kept account: what its server counts in it, what the hub holds there, and whether it is listed to its end. */
export interface MailKeepBox {
  id: string;
  name: string;
  role: MailboxRole | null;
  /** The server's count (mail.mailboxes), null when it gives none. */
  total: number | null;
  held: number;
  complete: boolean;
}

/**
 * GET /api/mail/keep: each mail account's copy here measured against its server. Settings → Indexing's Mail section.
 * A kept account's walk lists every mailbox to its end, its bodies are all fetched and never evicted, and its search
 * text is whole (up to 1 MB a message).
 */
export interface MailKeepView {
  accountId: string;
  /** Keep all of its mail (on unless turned off for the account). */
  keep: boolean;
  /** Paused here (Pause/Resume). */
  paused: boolean;
  /**
   * `running`: walking or fetching bodies; `idle`: nothing left to do now; `paused`; `disk`: the disk guard stopped body
   * fetching; `stopped`: the account stopped background reads (`stopped` says why); `waiting`: a Google account whose
   * status has not said it has a background lane keeps only what any account keeps (a year and all of Inbox) until it
   * does; `offline`: the account or the manager cannot be reached; `off`: not kept.
   */
  state: 'running' | 'idle' | 'paused' | 'disk' | 'stopped' | 'waiting' | 'offline' | 'off';
  stopped: MailKeepStop | null;
  /** The account's status says it has a background lane: the archive's reads go in it (`background: true`). */
  backgroundLane: boolean;
  /** Messages held here, and the server's count of them: All mail (else Archive) with Trash and Junk, else every mailbox. */
  messages: { held: number; total: number | null };
  /** Held messages whose body text is here (whole, for a kept account). */
  bodies: number;
  /** Bytes used here for this account: bodies and search text, as stored (an estimate: indexes come on top). */
  bytes: { bodies: number; text: number };
  /** The walk: complete once every mailbox it lists is; else how far back the mailbox it is on has come. */
  walk: { complete: boolean; mailbox: string | null; back: number | null; done: number; mailboxes: number };
  boxes: MailKeepBox[];
  /**
   * Gmail only (its search takes dates): month windows searched on the server and compared with what is held.
   * `estimate`: the server's own count of the account's mail, when its ids-only search gives one.
   */
  audit: { windows: number; matched: number; missed: number; checked: number; caught: number; estimate: number | null } | null;
  /** The last 30 days of server searches (GET /api/mail/search with the servers): their hits, held here before, with body text here, found by the hub's own search. */
  measure: { searches: number; found: number; held: number; bodies: number; local: number };
  /** Searched locally: server=auto asks this account's server no more. `missing`: what still stands in the way. */
  local: { on: boolean; missing: string[] };
  /** What the account's server says it uses (`details.storage`, `storageUsed`, `storageTotal`), when it says. */
  storage: { text: string | null; used: number | null; total: number | null } | null;
}

export interface MailKeepPage {
  accounts: MailKeepView[];
  /** The disk guard: bytes free where the hub keeps its data, and the floor under which body fetching stops. */
  disk: { free: number | null; floor: number };
}

/** PUT /api/mail/keep/:accountId: keep all of it or not, pause or resume. */
export interface MailKeepChange {
  keep?: boolean;
  paused?: boolean;
}

/** A search as a list key, so Mail's route shows it in place of a list: `s:<query>`. */
export const searchList = (q: string): MailListKey => `s:${q}`;
export const searchOfList = (key: string): string | null => (key.startsWith('s:') ? key.slice(2) : null);

// ------------------------------------------------------------------ lists

/** The views a list key can name. `people` and `updates` come with classification (slice 8). */
export type MailView = 'inbox' | 'unread' | 'starred' | 'sent' | 'people' | 'updates';

/**
 * A list of threads: `mb:<mailbox id>`, or `v:<view>:<account id or *>`. The page keeps lists by these keys, and
 * `mail.lists` names them when they are stale (slice 2).
 */
export type MailListKey = string;

export const mailboxList = (mailboxId: string): MailListKey => `mb:${mailboxId}`;
export const viewList = (view: MailView, accountId: string | null = null): MailListKey => `v:${view}:${accountId ?? '*'}`;

/**
 * Every thread with someone, in any mailbox of any account (slice 6): `w:<person id>`, `w:<identity id>` or
 * `w:<address>`. A person's list follows merges: it is all the addresses of the person as it is now.
 */
export const withList = (who: string): MailListKey => `w:${who}`;

/** Who a `withList` key is with; null for any other key. */
export function parseWithList(key: string): string | null {
  const m = key.match(/^w:(\S+)$/);
  return m ? m[1] : null;
}

export function parseMailList(key: string): { mailbox: string } | { view: MailView; accountId: string | null } | null {
  const m = key.match(/^mb:([\w-]+)$/);
  if (m) return { mailbox: m[1] };
  const v = key.match(/^v:(inbox|unread|starred|sent|people|updates):([\w-]+|\*)$/);
  return v ? { view: v[1] as MailView, accountId: v[2] === '*' ? null : v[2] } : null;
}

// ------------------------------------------------------------------ text

const ATTRIBUTION = [
  /^On\b.{4,200}\bwrote:\s*$/i,
  /^Am\b.{4,200}\bschrieb\b.{0,40}:\s*$/i,
  /^Le\b.{4,200}\ba écrit\s*:\s*$/i,
  /^El\b.{4,200}\bescribió:\s*$/i,
  /^.{2,120} <[^<>\s]+@[^<>\s]+> (?:wrote|schrieb|a écrit|escribió):\s*$/i,
];
const FORWARD_HEAD = /^\s*(-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}|_{20,})\s*$/i;

/**
 * Where the quoted part of a plain-text mail starts: the last block of `>` lines that runs to the end (with the
 * "On … wrote:" line before it, even when a client wrapped it over two lines), or an Outlook-style "Original Message"
 * header and everything after it. Null when there is none, or nothing would be left above it to show.
 */
export function quoteStart(text: string): number | null {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  let cut: number | null = null;
  // A forwarded or Outlook-quoted original: from its header line on.
  for (let i = 0; i < lines.length; i++) {
    if (FORWARD_HEAD.test(lines[i]) && lines.slice(i + 1, i + 4).some((l) => /^\s*(From|Von|De):/i.test(l))) {
      cut = i;
      break;
    }
  }
  // The trailing `>` block: blank lines may sit between quoted ones, and after it.
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let first = -1;
  for (let i = end; i >= 0; i--) {
    const l = lines[i];
    if (/^\s*>/.test(l)) first = i;
    else if (!l.trim() && first >= 0) continue;
    else break;
  }
  if (first >= 0) {
    let i = first;
    while (i > 0 && !lines[i - 1].trim()) i--;
    const one = lines[i - 1] ?? '';
    const two = `${lines[i - 2] ?? ''} ${one}`.trim();
    if (ATTRIBUTION.some((r) => r.test(one))) i -= 1;
    else if (i >= 2 && ATTRIBUTION.some((r) => r.test(two))) i -= 2;
    cut = cut === null ? i : Math.min(cut, i);
  }
  if (cut === null) return null;
  // Something must be left to show above it.
  if (!lines.slice(0, cut).some((l) => l.trim())) return null;
  return starts[cut];
}

/** A list row's line from a body: 200 characters, without the quoted part or the signature. */
export function mailPreview(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const q = quoteStart(text);
  let t = q === null ? text : text.slice(0, q);
  const sig = t.search(/^-- ?$/m);
  if (sig > 0) t = t.slice(0, sig);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** A plain address check: something@something.tld, nothing that would split a header. */
export const MAIL_ADDRESS = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;
export const validMailAddress = (e: string) => MAIL_ADDRESS.test(e.trim());

/** `Sam Lee <sam@lee.example>`, `"Lee, Sam" <sam@lee.example>` or `sam@lee.example`; null when it is not an address. */
export function parseMailAddress(raw: string): { name: string | null; email: string } | null {
  const s = raw.trim();
  const m = s.match(/^(.*?)\s*<([^<>\s]+)>$/);
  const email = (m ? m[2] : s).trim();
  if (!validMailAddress(email)) return null;
  const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  return { name: name || null, email };
}

/** `Name <a@b>` or the address alone. */
export function mailAddressText(a: { name: string | null; email: string }): string {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}

// ------------------------------------------------------------------ links

/** Top-level domains a bare name in a link's text is read as a site by ("paypal.com"); others need http or www. */
const COMMON_TLDS = new Set('com org net edu gov mil int io co ai app dev me info biz xyz online site shop store zip mov top link click'.split(' '));

/** The host a link's text names, when its text is a web address or a bare domain ("paypal.com/login"). */
export function shownHost(text: string): string | null {
  const t = text.trim().replace(/[\s\u200b-\u200d]+/g, '');
  if (!t || t.length > 300) return null;
  const m = t.match(/^(https?:\/\/)?((?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?\.)+([a-z\u00a1-\uffff]{2,63}))\.?(?::\d+)?(?:[/?#]\S*)?$/i);
  if (!m) return null;
  const tld = m[3].toLowerCase();
  if (!m[1] && !/^www\./i.test(m[2]) && !(tld.length === 2 || COMMON_TLDS.has(tld))) return null;
  try {
    return new URL(`https://${m[2]}`).hostname;
  } catch {
    return null;
  }
}
const bareHost = (h: string) => h.replace(/^www\./, '').replace(/\.$/, '');
/** The text names another site than the link goes to (subdomains of the named site are the same site). */
export function hostsDiffer(shown: string, goes: string): boolean {
  const a = bareHost(shown);
  const b = bareHost(goes);
  return a !== b && !b.endsWith('.' + a);
}
