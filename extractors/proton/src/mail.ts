/**
 * The `mail` interface over Proton's own API (the one the Mail web app calls), with bodies and attachments opened here
 * (pgp.ts). docs/proton.md says where each call and field comes from.
 *
 * Ids, opaque to apps:
 *
 *   mailbox     Proton's label id: '0' Inbox, '8' Drafts, '7' Sent, '6' Archive, '4' Spam, '3' Trash, '5' All mail,
 *               '10' Starred, …, or a custom folder's id. Proton labels (not folders) are not mailboxes: their names
 *               are in each message's `labels`.
 *   message     Proton's message id. A move keeps it (Proton moves by relabelling), so mail.move answers the same ids.
 *   attachment  Proton's attachment id; `mime.<n>` for the n-th part of a PGP/MIME message's own MIME.
 *   cursor      `<Time>.<message id>`: mail.list's `next`, the anchor of the next page (as the web app pages).
 *   state       `e.<event id>`: Proton's event loop position. One for the whole account: every mailbox's mail.changes
 *               reads the same events. An event id Proton no longer knows, or an event that says "refresh", is 410.
 */
import { StatusError } from '@dither-accounts/link';
import type { MailAddress, MailAttachment, MailboxRole, MailBulk, MailChanges, MailFlags, MailMessage, MailSummary, Mailbox } from '@dither-accounts/interfaces';
import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';
import { CODES, ProtonError, type ProtonApi, type Query } from './api.ts';
import { bodyText, type Decryptor } from './pgp.ts';

export const ATTACHMENT_CAP = 25 * 1024 * 1024;
const PAGE_MAX = 200;
const CHUNK = 150;
/** At most this many event pages per mail.changes call (as Proton's own Go client). */
const EVENT_PAGES = 50;
type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** Proton's system labels (WebClients MAILBOX_LABEL_IDS), as mailboxes. */
export const SYSTEM: { id: string; name: string; role: MailboxRole | null }[] = [
  { id: '0', name: 'Inbox', role: 'inbox' },
  { id: '8', name: 'Drafts', role: 'drafts' },
  { id: '12', name: 'Scheduled', role: null },
  { id: '7', name: 'Sent', role: 'sent' },
  { id: '10', name: 'Starred', role: 'flagged' },
  { id: '6', name: 'Archive', role: 'archive' },
  { id: '4', name: 'Spam', role: 'junk' },
  { id: '3', name: 'Trash', role: 'trash' },
  { id: '5', name: 'All mail', role: 'all' },
  { id: '16', name: 'Snoozed', role: null },
];
const SYSTEM_IDS = new Set(SYSTEM.map((s) => s.id));
/** Where a message is (its one folder), first match wins: the system folders, then a custom folder. */
const SYSTEM_FOLDERS = ['0', '8', '7', '6', '4', '3', '12'];
/** Folders a message can be moved into (moving into Sent or Drafts is Proton's to refuse per message). */
const MOVABLE = new Set(['0', '3', '4', '6', '7', '8']);
const L = { INBOX: '0', ALL_DRAFTS: '1', TRASH: '3', SPAM: '4', ALL_MAIL: '5', DRAFTS: '8', STARRED: '10', ALMOST_ALL_MAIL: '15' };
const EVENT = { DELETE: 0, CREATE: 1, UPDATE: 2, UPDATE_FLAGS: 3 };
const REFRESH_MAIL = 1;
const FLAG = { RECEIVED: 1, SENT: 2, REPLIED: 32, REPLIED_ALL: 64 };
/**
 * Proton's categories, its own sorting of the inbox like Gmail's tabs: system label ids in LabelIDs and CategoryID
 * (WebClients packages/shared/lib/constants.ts, MAILBOX_LABEL_IDS.CATEGORY_*). Given as labels with Gmail's spelling so
 * a reader that knows Gmail's categories knows these; Primary (24) is no category. Unlike List-Id and the other bulk
 * headers, they are in Proton's list metadata, so a summary carries them without fetching the message.
 */
const CATEGORY: Record<string, string> = { '20': 'Category/Social', '21': 'Category/Promotions', '22': 'Category/Updates', '25': 'Category/Newsletters', '26': 'Category/Transactions' };

export interface Recipient {
  Name?: string | null;
  Address?: string | null;
}
export interface ProtonMessage {
  ID: string;
  ConversationID?: string;
  AddressID?: string;
  LabelIDs?: string[];
  LabelIDsAdded?: string[];
  LabelIDsRemoved?: string[];
  ExternalID?: string | null;
  Subject?: string;
  Sender?: Recipient | null;
  ToList?: Recipient[];
  CCList?: Recipient[];
  BCCList?: Recipient[];
  ReplyTos?: Recipient[];
  Time?: number;
  Size?: number;
  Unread?: number;
  IsReplied?: number;
  IsRepliedAll?: number;
  Flags?: number;
  NumAttachments?: number;
  /** Proton's category for the message (one of CATEGORY's ids), where the account has categories. */
  CategoryID?: string | null;
  /** Set when Proton counts the message as from a newsletter you are subscribed to (its Newsletters view). */
  NewsletterSubscriptionID?: string | null;
  // full message only
  Body?: string;
  MIMEType?: string;
  ParsedHeaders?: Record<string, string | string[] | undefined>;
  Attachments?: ProtonAttachment[];
}
export interface ProtonAttachment {
  ID: string;
  Name?: string;
  Size?: number;
  MIMEType?: string;
  Disposition?: string;
  Headers?: Record<string, string | string[]>;
  KeyPackets?: string;
}
interface ProtonLabel {
  ID: string;
  Name: string;
  Path?: string;
  ParentID?: string | number | null;
  Type: number;
  Order?: number;
}
export interface ProtonEvent {
  EventID: string;
  More?: number | boolean;
  Refresh?: number;
  Messages?: { ID: string; Action: number; Message?: ProtonMessage }[];
  MessageCounts?: { LabelID?: string; Total?: number; Unread?: number }[];
  Labels?: unknown[];
  Addresses?: unknown[];
  User?: unknown;
}

export interface Keys {
  /** What opens messages (keys opened here, or the page's crypto proxy), unlocking on first use. */
  get(): Promise<Decryptor>;
  /** Forget it and unlock again (a new address key, a message no key opened). */
  again(): Promise<Decryptor>;
}

const clamp = (v: unknown, d: number, lo: number, hi: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d;
  return Math.max(lo, Math.min(hi, n));
};
const ID_RE = /^[A-Za-z0-9_=+-]{1,200}$/;
function checkId(id: unknown, what = 'message'): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new StatusError(`no such ${what}: ${String(id).slice(0, 80)}`, 404);
  return id;
}
const addr = (r: Recipient | null | undefined): MailAddress | null => (r?.Address ? { name: r.Name || null, email: r.Address } : null);
const addrs = (l: Recipient[] | undefined) => (l ?? []).map(addr).filter((a): a is MailAddress => !!a);
const angle = (s: string | null | undefined) => (s ? (s.startsWith('<') ? s : `<${s}>`) : null);
type Headers = Record<string, string | string[] | undefined>;
function header(h: Headers | undefined, name: string): string | null {
  return headerAll(h, name)[0] ?? null;
}
/** Every value of a header (Proton gives a list when it is there more than once). */
function headerAll(h: Headers | undefined, name: string): string[] {
  if (!h || typeof h !== 'object') return [];
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k ? h[k] : undefined;
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
}

/** The Message-IDs in a header's value, `<…>` as written, in order, each once (none over 300 characters). */
export function messageIds(v: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const id of v?.match(/<[^<>\s]+>/g) ?? []) if (id.length <= 300) out.add(id);
  return [...out];
}
/** In-Reply-To's Message-ID (the first, when a client wrote more), bracketed as messageId is; null without one. */
export function firstMessageId(v: string | null | undefined): string | null {
  const [id] = messageIds(v);
  if (id) return id;
  const bare = v?.trim();
  return bare && bare.length <= 298 && /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? `<${bare}>` : null;
}
/** A summary's references: all of them up to 20, else the first (the root) and the last 19. */
const keepReferences = (refs: string[]) => (refs.length <= 20 ? refs : [refs[0], ...refs.slice(-19)]);
/** One header's value as kept: control characters and runs of space made one space, trimmed, 300 characters. */
const headerValue = (v: string | null) => (v ? v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 300) || null : null);
/** List-Id, List-Unsubscribe, Precedence, Auto-Submitted from ParsedHeaders; null when none is there. */
export function bulkOf(h: Headers | undefined): MailBulk | null {
  const b: MailBulk = { listId: headerValue(header(h, 'List-Id')), unsubscribe: headerValue(header(h, 'List-Unsubscribe')), precedence: headerValue(header(h, 'Precedence')), autoSubmitted: headerValue(header(h, 'Auto-Submitted')) };
  return b.listId || b.unsubscribe || b.precedence || b.autoSubmitted ? b : null;
}
/**
 * Threading and bulk headers, from ParsedHeaders. Only a whole message (GET mail/v4/messages/<id>) has them: Proton's
 * lists and events give its metadata, so a summary made from those has null, [] and no bulk (docs/proton.md).
 */
function headersOf(m: ProtonMessage): { inReplyTo: string | null; references: string[]; bulk: MailBulk | null } {
  const h = m.ParsedHeaders;
  if (!h || typeof h !== 'object') return { inReplyTo: null, references: [], bulk: null };
  return { inReplyTo: firstMessageId(header(h, 'In-Reply-To')), references: messageIds(headerAll(h, 'References').join(' ')), bulk: bulkOf(h) };
}

export function parseCursor(v: string): { time: number; id: string } {
  const m = v.match(/^(\d+)\.([A-Za-z0-9_=+/-]+)$/);
  if (!m) throw new StatusError('not a cursor this account gave', 400);
  return { time: Number(m[1]), id: m[2] };
}
export function parseState(v: string): string {
  const m = v.match(/^e\.([A-Za-z0-9_=+/-]{1,200})$/);
  if (!m) throw new StatusError('not a state this account gave', 400);
  return m[1];
}
export const stateOf = (eventId: string) => `e.${eventId}`;

export class ProtonMail {
  private labels: { folders: Map<string, ProtonLabel>; labels: Map<string, ProtonLabel>; at: number } | null = null;

  constructor(
    private api: ProtonApi,
    private keys: Keys,
    private log: Log,
  ) {}

  // ------------------------------------------------------------- labels
  /** Custom folders (Type 3) and labels (Type 1), kept a minute or until an event says they changed. */
  async labelSets(force = false) {
    if (!force && this.labels && Date.now() - this.labels.at < 60_000) return this.labels;
    const [folders, labels] = await Promise.all([3, 1].map((Type) => this.api.call<{ Labels?: ProtonLabel[] }>({ method: 'GET', path: 'core/v4/labels', query: { Type } })));
    this.labels = { folders: new Map((folders.Labels ?? []).map((l) => [l.ID, l])), labels: new Map((labels.Labels ?? []).map((l) => [l.ID, l])), at: Date.now() };
    return this.labels;
  }
  forgetLabels() {
    this.labels = null;
  }

  private async checkMailbox(id: unknown): Promise<string> {
    if (typeof id === 'string' && SYSTEM_IDS.has(id)) return id;
    const sets = await this.labelSets();
    if (typeof id === 'string' && sets.folders.has(id)) return id;
    // A folder made a moment ago: look once more.
    if (typeof id === 'string' && ID_RE.test(id) && (await this.labelSets(true)).folders.has(id)) return id;
    throw new StatusError('no such mailbox', 404);
  }

  /** The message's one folder: a system folder or a custom one, else All mail. */
  private folderOf(m: ProtonMessage): string {
    const ids = m.LabelIDs ?? [];
    for (const s of SYSTEM_FOLDERS) if (ids.includes(s)) return s;
    const folders = this.labels?.folders;
    for (const id of ids) if (folders?.has(id)) return id;
    return L.ALL_MAIL;
  }

  flagsOf(m: ProtonMessage): MailFlags {
    const ids = m.LabelIDs ?? [];
    const f = m.Flags ?? 0;
    return {
      seen: !m.Unread,
      flagged: ids.includes(L.STARRED),
      answered: !!m.IsReplied || !!m.IsRepliedAll || (f & (FLAG.REPLIED | FLAG.REPLIED_ALL)) !== 0,
      draft: ids.includes(L.DRAFTS) || ids.includes(L.ALL_DRAFTS),
    };
  }
  /** Your labels by name, and Proton's category (CATEGORY); a message from a newsletter you subscribe to is a newsletter. */
  labelsOf(m: ProtonMessage): string[] {
    const named = this.labels?.labels;
    const out = new Set<string>();
    for (const id of m.LabelIDs ?? []) {
      const n = named?.get(id)?.Name ?? CATEGORY[id];
      if (n) out.add(n);
    }
    if (m.CategoryID && CATEGORY[m.CategoryID]) out.add(CATEGORY[m.CategoryID]);
    if (m.NewsletterSubscriptionID) out.add(CATEGORY['25']);
    return [...out].sort();
  }

  summary(m: ProtonMessage, mailboxId?: string): MailSummary {
    const t = (m.Time ?? 0) * 1000;
    const h = headersOf(m);
    return {
      id: m.ID,
      mailboxId: mailboxId ?? this.folderOf(m),
      messageId: angle(m.ExternalID),
      threadId: m.ConversationID ?? null,
      from: addrs(m.Sender ? [m.Sender] : []),
      to: addrs(m.ToList),
      cc: addrs(m.CCList),
      subject: m.Subject ?? '',
      date: t,
      receivedAt: t,
      flags: this.flagsOf(m),
      labels: this.labelsOf(m),
      size: m.Size ?? 0,
      preview: null,
      hasAttachments: (m.NumAttachments ?? m.Attachments?.length ?? 0) > 0,
      inReplyTo: h.inReplyTo,
      references: keepReferences(h.references),
      ...(h.bulk ? { bulk: h.bulk } : {}),
    };
  }

  // ------------------------------------------------------------- read
  async mailboxes(): Promise<{ mailboxes: Mailbox[] }> {
    const [sets, counts] = await Promise.all([this.labelSets(true), this.api.call<{ Counts?: { LabelID: string; Total?: number; Unread?: number }[] }>({ method: 'GET', path: 'mail/v4/messages/count' })]);
    const count = new Map((counts.Counts ?? []).map((c) => [String(c.LabelID), c]));
    const n = (id: string) => ({ unread: count.get(id)?.Unread ?? null, total: count.get(id)?.Total ?? null });
    const out: Mailbox[] = SYSTEM.map((s) => ({ id: s.id, name: s.name, path: s.name, parentId: null, role: s.role, ...n(s.id) }));
    const folders = [...sets.folders.values()].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
    for (const f of folders) {
      const parent = f.ParentID !== undefined && f.ParentID !== null && f.ParentID !== '' && sets.folders.has(String(f.ParentID)) ? String(f.ParentID) : null;
      out.push({ id: f.ID, name: f.Name, path: f.Path || f.Name, parentId: parent, role: null, ...n(f.ID) });
    }
    return { mailboxes: out };
  }

  async list(input: { mailboxId: string; limit?: number; before?: string; since?: number }): Promise<{ messages: MailSummary[]; next: string | null }> {
    const mailboxId = await this.checkMailbox(input.mailboxId);
    const limit = clamp(input.limit, 50, 1, 500);
    const since = typeof input.since === 'number' && Number.isFinite(input.since) ? input.since : null;
    let anchor = input.before ? parseCursor(input.before) : null;
    const out: MailSummary[] = [];
    let more = false;
    let last: ProtonMessage | null = null;
    while (out.length < limit) {
      const n = Math.min(PAGE_MAX, limit - out.length);
      const query: Query = { LabelID: mailboxId, Sort: 'Time', Desc: 1, Limit: n, ...(anchor ? { Anchor: anchor.time, AnchorID: anchor.id } : { Page: 0, PageSize: n }), ...(since !== null ? { Begin: Math.floor(since / 1000) } : {}) };
      const r = await this.api.call<{ Messages?: ProtonMessage[] }>({ method: 'GET', path: 'mail/v4/messages', query });
      const page = r.Messages ?? [];
      let cut = false;
      for (const m of page) {
        if (since !== null && (m.Time ?? 0) * 1000 < since) {
          cut = true;
          break;
        }
        out.push(this.summary(m, mailboxId));
        last = m;
      }
      more = !cut && page.length >= n;
      if (!more || !last) break;
      anchor = { time: last.Time ?? 0, id: last.ID };
    }
    return { messages: out, next: more && last ? `${last.Time ?? 0}.${last.ID}` : null };
  }

  private async fetchMessage(id: string): Promise<ProtonMessage> {
    const r = await this.api.call<{ Message?: ProtonMessage }>({ method: 'GET', path: `mail/v4/messages/${checkId(id)}` });
    if (!r.Message) throw new StatusError('no such message', 404);
    return r.Message;
  }

  /** Open with the keys we have; if none fits (a key added since), unlock once more and try again. */
  private async opened<T>(f: (keys: Decryptor) => Promise<T>, what: string): Promise<T> {
    try {
      return await f(await this.keys.get());
    } catch (first) {
      if (first instanceof StatusError) throw first;
      try {
        return await f(await this.keys.again());
      } catch (e) {
        if (e instanceof StatusError) throw e;
        this.log('warn', `${what} did not open with any key`, String((e as Error)?.message ?? e).slice(0, 160));
        throw new StatusError(`${what} did not open with this account's keys`, 422);
      }
    }
  }

  private async body(m: ProtonMessage): Promise<{ text: string | null; html: string | null; parts: { a: MailAttachment; data: Buffer }[] }> {
    if (!m.Body) return { text: null, html: null, parts: [] };
    const raw = await this.opened((k) => k.body(m.Body!, m.AddressID), 'the message');
    const mime = (m.MIMEType ?? 'text/html').toLowerCase();
    if (mime === 'multipart/mixed') {
      // PGP/MIME: the body is a whole MIME message with its own text, HTML and attachments.
      const parsed = await simpleParser(Buffer.from(raw), { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
      const html = typeof parsed.html === 'string' ? parsed.html : null;
      const text = parsed.text ?? (html ? convert(html, { wordwrap: false }) : null);
      const parts = parsed.attachments.map((p, i) => ({
        a: { id: `mime.${i}`, filename: p.filename ?? null, mime: p.contentType || 'application/octet-stream', size: p.size ?? p.content.length, inline: p.contentDisposition === 'inline' || !!p.related, contentId: p.cid ?? null },
        data: p.content,
      }));
      return { text, html, parts };
    }
    const s = bodyText(raw);
    if (mime === 'text/plain') return { text: s, html: null, parts: [] };
    return { text: convert(s, { wordwrap: false }), html: s, parts: [] };
  }

  private attachmentOf(a: ProtonAttachment): MailAttachment {
    const disposition = (a.Disposition ?? header(a.Headers as any, 'content-disposition') ?? '').toLowerCase();
    const cid = header(a.Headers as any, 'content-id');
    return { id: a.ID, filename: a.Name ?? null, mime: a.MIMEType || 'application/octet-stream', size: a.Size ?? 0, inline: disposition.startsWith('inline'), contentId: cid ? cid.replace(/^<|>$/g, '') : null };
  }

  async get(id: string): Promise<MailMessage> {
    await this.labelSets();
    const m = await this.fetchMessage(id);
    const { text, html, parts } = await this.body(m);
    const h = headersOf(m);
    return {
      ...this.summary(m),
      hasAttachments: (m.Attachments?.length ?? 0) + parts.length > 0,
      bcc: addrs(m.BCCList),
      replyTo: addrs(m.ReplyTos),
      inReplyTo: h.inReplyTo,
      // Every reference here; a summary keeps 20.
      references: h.references,
      text,
      html,
      attachments: [...(m.Attachments ?? []).map((a) => this.attachmentOf(a)), ...parts.map((p) => p.a)],
    };
  }

  async attachment(id: string, attachmentId: string): Promise<{ filename: string | null; mime: string; base64: string }> {
    const m = await this.fetchMessage(id);
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    if (typeof attachmentId === 'string' && /^mime\.\d+$/.test(attachmentId)) {
      const part = (await this.body(m)).parts.find((p) => p.a.id === attachmentId);
      if (!part) throw new StatusError('no such attachment', 404);
      if (part.data.length > ATTACHMENT_CAP) throw new StatusError(`the attachment is ${mb(part.data.length)} MB; at most 25 MB come through here`, 413);
      return { filename: part.a.filename, mime: part.a.mime, base64: part.data.toString('base64') };
    }
    const a = (m.Attachments ?? []).find((x) => x.ID === attachmentId);
    if (!a) throw new StatusError('no such attachment', 404);
    if ((a.Size ?? 0) > ATTACHMENT_CAP) throw new StatusError(`the attachment is ${mb(a.Size ?? 0)} MB; at most 25 MB come through here`, 413);
    if (!a.KeyPackets) throw new StatusError('the attachment has no key packets', 502);
    const data = await this.api.call<{ base64: string }>({ method: 'GET', path: `mail/v4/attachments/${checkId(a.ID, 'attachment')}`, binary: true });
    const bytes = await this.opened((k) => k.attachment(a.KeyPackets!, Buffer.from(data.base64, 'base64'), m.AddressID), 'the attachment');
    if (bytes.length > ATTACHMENT_CAP) throw new StatusError('the attachment is over 25 MB; at most 25 MB come through here', 413);
    return { filename: a.Name ?? null, mime: a.MIMEType || 'application/octet-stream', base64: Buffer.from(bytes).toString('base64') };
  }

  /**
   * Proton's own server search: `Keyword` over what it can read, the subject and the senders' and recipients' names
   * and addresses. Bodies are encrypted on Proton's servers, so they are not searched (Proton's own "search message
   * content" builds an index in the browser; this does not).
   */
  async search(input: { query: string; mailboxId?: string; limit?: number }): Promise<{ messages: MailSummary[] }> {
    const q = String(input.query ?? '').trim();
    if (!q) return { messages: [] };
    const limit = clamp(input.limit, 50, 1, 200);
    const mailboxId = input.mailboxId ? await this.checkMailbox(input.mailboxId) : null;
    await this.labelSets();
    const r = await this.api.call<{ Messages?: ProtonMessage[] }>({
      method: 'GET',
      path: 'mail/v4/messages',
      query: { LabelID: mailboxId ?? L.ALMOST_ALL_MAIL, Keyword: q, Sort: 'Time', Desc: 1, Page: 0, PageSize: limit, Limit: limit },
    });
    return { messages: (r.Messages ?? []).slice(0, limit).map((m) => this.summary(m, mailboxId ?? undefined)) };
  }

  // ------------------------------------------------------------- events
  async latestEvent(): Promise<string> {
    const r = await this.api.call<{ EventID?: string }>({ method: 'GET', path: 'core/v4/events/latest' });
    if (!r.EventID) throw new ProtonError('Proton gave no event id', 502, null);
    return r.EventID;
  }

  /** One page of events from `from`, as the web app asks for them. A refresh, or an id Proton refuses, is 410. */
  async eventPage(from: string, trigger: 'Timer' | 'Code'): Promise<ProtonEvent> {
    let ev: ProtonEvent;
    try {
      ev = await this.api.call<ProtonEvent>({
        method: 'GET',
        path: `core/v5/events/${checkId(from, 'event')}`,
        query: { ConversationCounts: 1, MessageCounts: 1, OnlyInInboxForCategoriesCounts: 0, CalledFrom: 'Background', Trigger: trigger },
      });
    } catch (e) {
      if (e instanceof ProtonError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429 && e.code !== CODES.HUMAN_VERIFICATION) throw new StatusError('the state is too old: list the mailbox again', 410);
      throw e;
    }
    if (((ev.Refresh ?? 0) & REFRESH_MAIL) !== 0) throw new StatusError('Proton asks for a full refresh: list the mailbox again', 410);
    if (!ev.EventID) throw new ProtonError('Proton gave an event without an id', 502, null);
    return ev;
  }

  async changes(input: { mailboxId: string; state?: string; limit?: number }): Promise<MailChanges> {
    const mailboxId = await this.checkMailbox(input.mailboxId);
    const limit = clamp(input.limit, 200, 1, 1000);
    if (!input.state) return { state: stateOf(await this.latestEvent()), added: [], changed: [], removed: [], more: false };
    let id = parseState(input.state);
    await this.labelSets();
    const seen = new Map<string, Seen>();
    let more = false;
    for (let page = 0; ; page++) {
      const ev = await this.eventPage(id, 'Code');
      fold(seen, ev);
      if (ev.Labels?.length) await this.labelSets(true);
      id = ev.EventID;
      const pending = !!ev.More;
      if (!pending) break;
      if (page + 1 >= EVENT_PAGES || [...seen.values()].filter((s) => s.created || s.added.has(mailboxId)).length >= limit) {
        more = true;
        break;
      }
    }
    // Updates that did not say where the message is now: ask for it.
    for (const [mid, s] of seen) {
      if (s.deleted || s.msg?.LabelIDs) continue;
      try {
        s.msg = { ...(await this.fetchMessage(mid)), Body: undefined, Attachments: undefined };
      } catch (e) {
        if (e instanceof StatusError && e.status === 404) s.deleted = true;
        else throw e;
      }
    }
    const added: MailSummary[] = [];
    const changed: MailChanges['changed'] = [];
    const removed: string[] = [];
    for (const [mid, s] of seen) {
      if (s.deleted) {
        removed.push(mid);
        continue;
      }
      const here = !!s.msg?.LabelIDs?.includes(mailboxId);
      if (here && (s.created || s.added.has(mailboxId))) {
        if (!s.msg!.Time) s.msg = { ...s.msg!, ...(await this.fetchMessage(mid)), Body: undefined, Attachments: undefined };
        added.push(this.summary(s.msg!, mailboxId));
      } else if (here) changed.push({ id: mid, flags: this.flagsOf(s.msg!), labels: this.labelsOf(s.msg!) });
      else if (s.removed.has(mailboxId)) removed.push(mid);
    }
    added.sort((a, b) => a.receivedAt - b.receivedAt);
    return { state: stateOf(id), added, changed, removed, more };
  }

  // ------------------------------------------------------------- write
  /** A batch action over ids, 150 at a time; the ids Proton refused, with its codes. */
  private async batch(path: string, ids: string[], extra: Record<string, unknown> = {}): Promise<Map<string, number>> {
    const refused = new Map<string, number>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const IDs = ids.slice(i, i + CHUNK);
      const r = await this.api.call<{ Responses?: { ID: string; Response?: { Code?: number } }[] }>({ method: 'PUT', path, body: { ...extra, IDs } });
      for (const x of r.Responses ?? []) {
        const code = x.Response?.Code ?? CODES.OK;
        if (code !== CODES.OK) refused.set(x.ID, code);
      }
    }
    return refused;
  }

  private refusedError(what: string, refused: Map<string, number>) {
    const codes = [...new Set(refused.values())].join(', ');
    const notFound = [...refused.values()].every((c) => c === CODES.NOT_FOUND || c === CODES.INVALID_ID);
    return new StatusError(`Proton would not ${what} ${refused.size} of them (code ${codes})`, notFound ? 404 : 422);
  }

  async flag(input: { ids: string[]; seen?: boolean; flagged?: boolean; answered?: boolean }): Promise<Record<string, never>> {
    if (input.answered !== undefined) throw new StatusError('Proton marks a message answered itself when you reply to it; mail.flag cannot set or clear that', 501);
    const ids = (input.ids ?? []).map((x) => checkId(x));
    if (!ids.length) return {};
    const refused = new Map<string, number>();
    const add = (m: Map<string, number>) => m.forEach((v, k) => refused.set(k, v));
    if (input.seen !== undefined) add(await this.batch(input.seen ? 'mail/v4/messages/read' : 'mail/v4/messages/unread', ids));
    if (input.flagged !== undefined) add(await this.batch(input.flagged ? 'mail/v4/messages/label' : 'mail/v4/messages/unlabel', ids, { LabelID: L.STARRED }));
    if (refused.size) throw this.refusedError('change', refused);
    return {};
  }

  async move(input: { ids: string[]; mailboxId: string }): Promise<{ ids: (string | null)[] }> {
    const dest = await this.checkMailbox(input.mailboxId);
    if (SYSTEM_IDS.has(dest) && !MOVABLE.has(dest)) throw new StatusError('that mailbox is a view, not a folder: messages cannot be moved into it', 400);
    const ids = (input.ids ?? []).map((x) => checkId(x));
    if (!ids.length) return { ids: [] };
    const refused = await this.batch('mail/v4/messages/label', ids, { LabelID: dest });
    if (refused.size) this.log('info', `move: Proton refused ${refused.size} of ${ids.length}`, [...new Set(refused.values())]);
    return { ids: ids.map((x) => (refused.has(x) ? null : x)) };
  }

  /** To Trash; those already in Trash are deleted outright (as the imap kind does). */
  async trash(input: { ids: string[] }): Promise<Record<string, never>> {
    const ids = (input.ids ?? []).map((x) => checkId(x));
    if (!ids.length) return {};
    const inTrash: string[] = [];
    const rest: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, ids.length) }, async () => {
        while (next < ids.length) {
          const x = ids[next++];
          const m = await this.fetchMessage(x);
          (m.LabelIDs?.includes(L.TRASH) ? inTrash : rest).push(x);
        }
      }),
    );
    const refused = new Map<string, number>();
    if (rest.length) (await this.batch('mail/v4/messages/label', rest, { LabelID: L.TRASH })).forEach((v, k) => refused.set(k, v));
    if (inTrash.length) (await this.batch('mail/v4/messages/delete', inTrash)).forEach((v, k) => refused.set(k, v));
    if (refused.size) throw this.refusedError('trash', refused);
    return {};
  }
}

/** What happened to one message over a run of events. */
export interface Seen {
  created: boolean;
  deleted: boolean;
  added: Set<string>;
  removed: Set<string>;
  msg: ProtonMessage | null;
}

/** Fold an event page's message events into `seen`, in order. */
export function fold(seen: Map<string, Seen>, ev: ProtonEvent) {
  for (const e of ev.Messages ?? []) {
    if (!e?.ID) continue;
    const s = seen.get(e.ID) ?? { created: false, deleted: false, added: new Set<string>(), removed: new Set<string>(), msg: null };
    seen.set(e.ID, s);
    if (e.Action === EVENT.DELETE) {
      s.deleted = true;
      continue;
    }
    s.deleted = false;
    const m = e.Message;
    if (!m) continue;
    if (e.Action === EVENT.CREATE) s.created = true;
    for (const l of m.LabelIDsAdded ?? []) {
      s.added.add(l);
      s.removed.delete(l);
    }
    for (const l of m.LabelIDsRemoved ?? []) {
      s.removed.add(l);
      s.added.delete(l);
    }
    const { LabelIDsAdded, LabelIDsRemoved, ...fields } = m;
    let labels = fields.LabelIDs;
    if (!labels && s.msg?.LabelIDs) labels = [...s.msg.LabelIDs.filter((l) => !(LabelIDsRemoved ?? []).includes(l)), ...(LabelIDsAdded ?? []).filter((l) => !s.msg!.LabelIDs!.includes(l))];
    s.msg = { ...(s.msg ?? {}), ...fields, ID: e.ID, ...(labels ? { LabelIDs: labels } : {}) };
  }
}

/** The mailboxes an event page touches: every label its messages had, gained or lost, and every count it updated. */
export function touched(ev: ProtonEvent): Set<string> {
  const out = new Set<string>();
  for (const e of ev.Messages ?? []) for (const l of [...(e.Message?.LabelIDs ?? []), ...(e.Message?.LabelIDsAdded ?? []), ...(e.Message?.LabelIDsRemoved ?? [])]) out.add(l);
  for (const c of ev.MessageCounts ?? []) if (c.LabelID !== undefined) out.add(String(c.LabelID));
  return out;
}

/** New mail in the inbox: created by this page, in the inbox, not a draft or something you sent. */
export function arrivals(ev: ProtonEvent): ProtonMessage[] {
  return (ev.Messages ?? []).filter((e) => e.Action === EVENT.CREATE && e.Message?.LabelIDs?.includes(L.INBOX) && ((e.Message.Flags ?? FLAG.RECEIVED) & FLAG.RECEIVED) !== 0).map((e) => ({ ...e.Message!, ID: e.ID }));
}
