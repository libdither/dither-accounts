/**
 * Gmail's own web protocol, as the Gmail page speaks it to mail.google.com (docs/google.md, "Gmail mail"): the bodies
 * of the calls the extractor makes through the Gmail tab's hook (POST /sync/u/<n>/i/bv, fd and s), and the reading of
 * their answers. Pure: no I/O here.
 *
 * What is known comes from the shapes recorded on the live page (type tags and anchors, never values): the answers
 * are positional arrays. So nothing here trusts a position alone. Thread rows are found by their anchors (a list whose
 * element 3 is a thread id, `thread-f:<n>`, and element 2 a 13-digit date in ms) wherever they are, and messages by
 * theirs (element 0 a message id, `msg-f:<n>`, and a list of label ids starting with ^); then each endpoint's
 * fingerprint checks that what was found is where the recorded shapes had it, and of the right type. Anything else
 * throws a LayoutError (where, what was expected, what kind of thing was there: never a value), and the caller
 * refuses the call rather than answer with mail it may have misread.
 *
 * Read-only: no body built here changes anything. The sync call (s) carries label changes when the page writes; the
 * one built here never does, and the hook refuses any that would.
 */
import type { MailAddress, MailboxRole, MailFlags } from '@dither-accounts/interfaces';

export type Endpoint = 'bv' | 'fd' | 's' | 'raw';
export const ENDPOINTS: Endpoint[] = ['bv', 'fd', 's', 'raw'];
/** What each call is, for sentences. */
export const ENDPOINT_NAMES: Record<Endpoint, string> = { bv: 'list and search (bv)', fd: 'thread fetch (fd)', s: 'sync (s)', raw: 'message download' };

/** A Gmail answer not laid out as this module knows it: where, what was expected there, and what kind of thing was there instead. */
export class LayoutError extends Error {
  constructor(
    readonly endpoint: Endpoint,
    readonly where: string,
    readonly expected: string,
    readonly got: string,
  ) {
    super(`at ${where}: expected ${expected}, got ${got}`);
  }
}

/** What a value is, never what it says. */
export function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return `a list of ${v.length}`;
  if (typeof v === 'number') return !Number.isInteger(v) ? 'a fraction' : isMs(v) ? 'a 13-digit number' : 'a number';
  if (typeof v === 'string') return v.startsWith('^') ? 'a label id' : /^(?:thread|msg)-[a-z]:/.test(v) ? 'an id' : 'a string';
  if (typeof v === 'boolean') return 'a boolean';
  return typeof v === 'object' ? 'an object' : typeof v;
}

// ------------------------------------------------------------------ anchors
const THREAD = /^thread-[fa]:[A-Za-z0-9_-]{1,64}$/;
const MSG = /^msg-[fa]:[A-Za-z0-9_-]{1,64}$/;
/** Any message id Gmail's web app uses: msg-f (Gmail's), msg-a (the page's own) in either of its forms, and kinds not seen yet. */
const MSG_ANY = /^msg-[a-z]:\S{1,100}$/;
export const isAnyMsgId = (v: unknown): v is string => typeof v === 'string' && MSG_ANY.test(v);
/** Message ids that are not msg-f, by their kind (the letter, and whether the rest is plain), for the self-check. */
export const localIdKinds: Record<string, number> = {};
export const isThreadId = (v: unknown): v is string => typeof v === 'string' && THREAD.test(v);
export const isMsgId = (v: unknown): v is string => typeof v === 'string' && MSG.test(v);
/** A date in ms since the epoch: 13 digits, as Gmail's are. */
export const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1e12 && v < 1e13;
/** A message's labels: strings, at least one of them a label id (^…). */
export const isLabelList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') && v.some((x) => x.startsWith('^'));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The decimal number of a `thread-f:` or `msg-f:` id; null for the page's own `-a` ids (not Gmail's yet). */
export function fDecimal(v: string): string | null {
  const m = /^(?:thread|msg)-f:(\d{1,20})$/.exec(v);
  return m ? m[1]! : null;
}
/** Our message and thread ids: Gmail's, as decimals (the number after `msg-f:` / `thread-f:`). */
export const DECIMAL_ID = /^\d{1,20}$/;
/** The hex form Gmail's older routes take (the download route's `th`): the same number. */
export const hexOf = (dec: string) => BigInt(dec).toString(16);
export const decimalOfHex = (hex: unknown): string | null => (typeof hex === 'string' && /^[0-9a-f]{1,16}$/.test(hex) ? BigInt(`0x${hex}`).toString() : null);
/** Newest first: by date, then by id (as numbers). */
export function newer(a: { date: number; id: string }, b: { date: number; id: string }): number {
  if (a.date !== b.date) return b.date - a.date;
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x === y ? 0 : x > y ? -1 : 1;
}

// ------------------------------------------------------------------ labels
/**
 * Gmail's system mailboxes. The label ids are Gmail's own; the s answer's label list holds exactly these eleven
 * system labels (type 5: ^i, ^t, ^t_z, ^io_im, ^f, ^scheduled, ^r, ^all, ^s, ^k and ^b, chats, left out here), the
 * set of Gmail's system folders. Which id is which folder is Gmail's convention, not something the shapes can show:
 * docs/google.md says which ones the shapes back and which the live self-check must confirm. All Mail is ours, by a
 * query (Gmail's own All Mail view is every message but Spam and Trash).
 */
export interface SystemBox {
  id: string;
  name: string;
  role: MailboxRole | null;
  /** The Gmail search that lists it. */
  query: string;
  /** The label a message in it has; null for All Mail (every message but Spam and Trash). */
  label: string | null;
}
export const SYSTEM: SystemBox[] = [
  { id: '^i', name: 'Inbox', role: 'inbox', query: 'in:inbox', label: '^i' },
  { id: '^t', name: 'Starred', role: 'flagged', query: 'is:starred', label: '^t' },
  { id: '^t_z', name: 'Snoozed', role: null, query: 'in:snoozed', label: '^t_z' },
  { id: '^io_im', name: 'Important', role: 'important', query: 'is:important', label: '^io_im' },
  { id: '^f', name: 'Sent', role: 'sent', query: 'in:sent', label: '^f' },
  { id: '^scheduled', name: 'Scheduled', role: null, query: 'in:scheduled', label: '^scheduled' },
  { id: '^r', name: 'Drafts', role: 'drafts', query: 'in:drafts', label: '^r' },
  { id: 'all', name: 'All Mail', role: 'all', query: 'in:anywhere -in:trash -in:spam', label: null },
  { id: '^s', name: 'Spam', role: 'junk', query: 'in:spam', label: '^s' },
  { id: '^k', name: 'Trash', role: 'trash', query: 'in:trash', label: '^k' },
];
export const L = { INBOX: '^i', ALL: '^all', UNREAD: '^u', STARRED: '^t', SENT: '^f', DRAFTS: '^r', SPAM: '^s', TRASH: '^k', IMPORTANT: '^io_im' } as const;
/** System labels a summary names, readably. Every other ^ id (^all, ^u, ^o, ^io_lr, ^smartlabel_*, …) is Gmail's own bookkeeping. */
const READABLE: Record<string, string> = Object.fromEntries(SYSTEM.filter((b) => b.label).map((b) => [b.label!, b.name]));

/**
 * Gmail's categories as labels, spelled as Proton's (`Category/Promotions`), so a reader of either knows them. At most
 * one per message: the first tier that holds any of the message's labels decides, in the order of its entries; null
 * there means no category (Primary). The tiers: a receipt always; else the inbox tab Gmail put it in (^sq_ig_i_*);
 * else Gmail's classifier (^smartlabel_*); else a pure notification. ^smartlabel_finance, ^smartlabel_travel,
 * ^assistive_* and ^cob_sm_* give none (yet).
 */
export const CATEGORY_TIERS: Record<string, string | null>[] = [
  { '^smartlabel_receipt': 'Category/Transactions' },
  { '^sq_ig_i_personal': null, '^sq_ig_i_social': 'Category/Social', '^sq_ig_i_promo': 'Category/Promotions', '^sq_ig_i_notification': 'Category/Updates', '^sq_ig_i_group': 'Category/Forums' },
  { '^smartlabel_social': 'Category/Social', '^smartlabel_promo': 'Category/Promotions', '^smartlabel_notification': 'Category/Updates', '^smartlabel_group': 'Category/Forums', '^smartlabel_personal': null },
  { '^smartlabel_pure_notif': 'Category/Updates' },
];
export function categoryOf(labels: string[]): string | null {
  for (const tier of CATEGORY_TIERS) for (const [id, cat] of Object.entries(tier)) if (labels.includes(id)) return cat;
  return null;
}

/** A summary's labels: system folders by name (Inbox, Starred, …), your labels by name (by id until the names are known), the category. */
export function labelsOf(labels: string[], names: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const l of labels) {
    if (READABLE[l]) out.add(READABLE[l]);
    else if (names.has(l)) out.add(names.get(l)!);
    else if (/^\^x_\w{1,64}$/.test(l)) out.add(l);
    else if (!l.startsWith('^') && l.trim()) out.add(l);
  }
  const cat = categoryOf(labels);
  if (cat) out.add(cat);
  return [...out].sort();
}

/**
 * Gmail's own labels that are no mailbox a person files into, whatever their type says: categories and inbox tabs, its
 * classifiers' smart and assistive labels, and its bookkeeping (^io_*, ^p_*, ^cob_*, …).
 */
const NOT_A_MAILBOX = /^\^(?:smartlabel_|sq_ig_|assistive_|cob_|io_|iim|p_|pr_|wc_|oc_|sub_|unsub|cr$|afw$|fnas$|ndpp$|us$|u$|o$|b$|all$)/;

/** One of your labels, a mailbox: type 2 in the label list (or, its type not given, an ^x_ id), and none of Gmail's own. */
export function isUserLabel(l: { id: string; type: number | null }): boolean {
  if (NOT_A_MAILBOX.test(l.id) || SYSTEM.some((b) => b.label === l.id)) return false;
  return l.type === 2 || (l.type === null && /^\^x_\w{1,64}$/.test(l.id));
}

/** seen: no ^u (unread); flagged: ^t (starred); draft: ^r. Gmail keeps no answered mark among a message's labels: false. */
export const flagsOf = (labels: string[]): MailFlags => ({ seen: !labels.includes(L.UNREAD), flagged: labels.includes(L.STARRED), answered: false, draft: labels.includes(L.DRAFTS) });

/** The mailbox a message found by a search is in: Trash, Spam, Drafts, Inbox, Sent, else All Mail. */
export function homeOf(labels: string[]): string {
  for (const id of [L.TRASH, L.SPAM, L.DRAFTS, L.INBOX, L.SENT]) if (labels.includes(id)) return id;
  return 'all';
}
/** Whether a message is in All Mail: not in Trash or Spam. */
export const inAllMail = (labels: string[]) => !labels.includes(L.TRASH) && !labels.includes(L.SPAM);

// ------------------------------------------------------------------ queries
/** The operators an ids-only search takes, as the learn run's searches: the ones that say nothing about what a message says. */
export const ID_SEARCH_OPS = ['in', 'is', 'label', 'has', 'after', 'before', 'older_than', 'newer_than', 'category', 'larger', 'smaller'];

/** null when the query is operators only (op:value, op one of ID_SEARCH_OPS, at most 8); else why not, without repeating it. */
export function operatorsOnly(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 'the search is empty';
  if (tokens.length > 8) return 'an ids-only search holds at most 8 operators';
  for (const [i, t] of tokens.entries()) {
    const m = /^([a-z_]+):([A-Za-z0-9_./-]{1,64})$/.exec(t);
    if (!m || !ID_SEARCH_OPS.includes(m[1]!)) return `search word ${i + 1} is not an operator: an ids-only search takes op:value words only, op one of ${ID_SEARCH_OPS.join(', ')} (no free text, quotes or negation)`;
  }
  return null;
}

/** A label name as Gmail's search takes it. */
export const labelQuery = (name: string) => `label:"${name.replace(/["\\]/g, ' ').trim()}"`;

// ------------------------------------------------------------------ requests
/**
 * bv: a thread list for a Gmail search, `pageSize` threads, newest first, as the page asks for one. Laid out as the
 * recorded request: [ [reqId, pageSize, null, query, [... now, tz ...], query, 1, history, …, [[[2, pageSize]]], …,
 * [now, null, null, 18]], null, [0, 5, null, null, 1, 1, 1] ]. Positions the shapes cannot explain are filled as the
 * page filled them: element 0 a request id (a number), element 7 a number (here the sync point when known; a guess),
 * the time zone's offset in ms beside the time (a guess), the query at 3 and again at 5 (both strings in every
 * sample).
 */
export function bvRequest(p: { query: string; pageSize: number; now: number; requestId: number; history?: string | null; tzOffsetMs?: number }): unknown[] {
  const tz = p.tzOffsetMs ?? -new Date(p.now).getTimezoneOffset() * 60_000;
  const view = [null, null, null, null, 0, null, null, null, null, null, null, p.now, tz, null, null, null, null, null, null, null, null, null, null, 0, 0, 0, 0];
  const opts = [1, 0, 0, null, null, 0, 1, null, null, 1, null, null, 1, null, 1, null, null, null, null, null, 0];
  const h = p.history && /^\d{1,15}$/.test(p.history) ? Number(p.history) : p.requestId;
  const head = [p.requestId, p.pageSize, null, p.query, view, p.query, 1, h, null, 0, null, null, null, 1, null, opts, null, null, 1, null, null, 0, 1, 0, [[[2, p.pageSize]]], 0, 0, null, null, null, null, null, [p.now, null, null, 18]];
  return [head, null, [0, 5, null, null, 1, 1, 1]];
}

/** fd: whole threads, with every message's labels (the form the page uses when it opens a list). */
export const fdThreadsRequest = (threads: string[]): unknown[] => [threads.map((t) => [`thread-f:${t}`, 1, null, null, 1]), 2];

/**
 * s: what changed since a sync point (Gmail's history id), as the page's own first sync after it loads asks:
 * [[1, null, null, 0], null, [1, null, null, null, [null, 25], null, 1], [null, 1, now, 0, history], 2]. Element 1 is
 * where the page puts label changes (its writes); here it is always null.
 */
export function sRequest(history: string, now: number): unknown[] {
  if (!/^\d{1,15}$/.test(history)) throw new Error('not a sync point');
  return [[1, null, null, 0], null, [1, null, null, null, [null, 25], null, 1], [null, 1, now, 0, Number(history)], 2];
}

/** Whether an s body only reads: nothing at element 1 (the page's label changes) and no list inside element 0. */
export function readOnlySync(body: unknown): boolean {
  if (!Array.isArray(body) || (body[1] !== null && body[1] !== undefined)) return false;
  const head = body[0];
  return head === null || head === undefined || (Array.isArray(head) && head.every((x) => x === null || typeof x !== 'object'));
}

// ------------------------------------------------------------------ answers
export interface GMessage {
  /** Gmail's message id, decimal; null for a message the page has not got from Gmail yet (msg-a). */
  id: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  date: number;
  labels: string[];
  snippet: string | null;
  attachments: number;
  /** For a message with no Gmail id yet (msg-a): its record as Gmail sent it, for learning where its id is (shaped, never kept). */
  record?: unknown;
  /** A msg-a message's [55] in decimal, taken as its id once a whole answer has been read (resolveLocalIds). */
  hex55?: string;
}
export interface ThreadRow {
  /** Gmail's thread id, decimal (from `thread-f:`, else from the row's hex id); null when neither is there. */
  thread: string | null;
  subject: string;
  /** The row's own date: no message in it is newer. */
  date: number;
  messages: GMessage[];
}
export interface LabelDef {
  id: string;
  name: string;
  /** Gmail's kind of label: 2 for yours, 5 system, 1 a category, … (element 17 of its entry). */
  type: number | null;
}
export interface Count {
  unread: number | null;
  total: number | null;
}
/**
 * Which of bv's two layouts an answer had: 'own', what the extractor's own calls get (rows at json[2], the label list
 * at json[1], counts at json[6]); 'page', what the Gmail page's own list calls got when the shapes were recorded (rows
 * at json[19][0][1]). null: an empty answer that shows neither.
 */
export type BvLayout = 'own' | 'page';
export interface BvAnswer {
  rows: ThreadRow[];
  layout: BvLayout | null;
  /** Gmail's result estimate: not found in the answers yet (json[4] is something else), so always null for now. */
  estimate: number | null;
  /** json[4]: a 6 to 7 digit number of unknown meaning, kept as evidence. */
  json4: number | null;
  /** The number every answer ends with (json[18][0]): read as Gmail's current sync point (a guess the self-check tests). */
  trailer: number | null;
  /** The own layout's label list (json[1]), as s's; null when the answer has none. */
  labels: LabelDef[] | null;
  /** The own layout's counts (json[6][0], `[id, unread, total]` as s's); null when the answer has none. */
  counts: Map<string, Count> | null;
}
export interface FdAnswer {
  threads: { thread: string | null; messages: GMessage[] }[];
  trailer: number | null;
}
export interface SAnswer {
  history: string;
  labels: LabelDef[] | null;
  rows: ThreadRow[];
  counts: Map<string, Count>;
  trailer: number | null;
}

type Found = { path: string; rec: unknown[] };
const isRow = (a: unknown): a is unknown[] => Array.isArray(a) && isThreadId(a[3]) && isMs(a[2]) && Array.isArray(a[4]);

/** Every thread row in a value, found by its anchors, with where it is (a row is not looked into further). */
export function findRows(v: unknown, root = 'json'): Found[] {
  const out: Found[] = [];
  const walk = (x: unknown, path: string, depth: number) => {
    if (!Array.isArray(x) || depth > 30) return;
    if (isRow(x)) {
      out.push({ path, rec: x });
      return;
    }
    for (let i = 0; i < x.length; i++) walk(x[i], `${path}[${i}]`, depth + 1);
  };
  walk(v, root, 0);
  return out;
}

/** Why a value is not a thread row, by its first anchor that fails. */
function rowError(ep: Endpoint, r: unknown, where: string): LayoutError {
  if (!Array.isArray(r)) return new LayoutError(ep, where, 'a thread row (a list)', kindOf(r));
  if (!isMs(r[2])) return new LayoutError(ep, `${where}[2]`, "the row's date in ms (13 digits)", kindOf(r[2]));
  if (!isThreadId(r[3])) return new LayoutError(ep, `${where}[3]`, 'a thread id (thread-f:…)', kindOf(r[3]));
  return new LayoutError(ep, `${where}[4]`, "the row's messages (a list)", kindOf(r[4]));
}

function address(v: unknown): MailAddress | null {
  if (!Array.isArray(v) || typeof v[1] !== 'string' || !v[1].includes('@')) return null;
  const name = typeof v[2] === 'string' && v[2].trim() && v[2] !== v[1] ? v[2].trim() : null;
  return { name, email: v[1] };
}
const addresses = (v: unknown): MailAddress[] => (Array.isArray(v) ? v.map(address).filter((a): a is MailAddress => !!a) : []);

/**
 * A message in a thread row (bv and s): [0] its id, [1] [1, address, name] the sender, [2] and [5] lists of those
 * (to and cc: in s's rows; bv's have none), [6] its date in ms, [9] the snippet, [10] its labels, [11] its attachments.
 */
/**
 * A message's own Gmail id in hex sits at [55] (seen on a msg-a message, 2026-11-13). It is used for a msg-a message
 * only while every msg-f message seen agrees: its [55] in decimal equals its msg-f number (at least 5 seen, none
 * against). The counts go to the self-check.
 */
export const hex55 = { agree: 0, disagree: 0, absent: 0, used: 0 };
const hex55Trusted = () => hex55.agree >= 5 && hex55.disagree === 0;

/** After a whole answer is read (its msg-f messages counted first): msg-a messages take their [55] id when it is trusted. */
export function resolveLocalIds(rows: { messages: GMessage[] }[]): void {
  if (!hex55Trusted()) return;
  for (const r of rows)
    for (const g of r.messages)
      if (g.id === null && g.hex55) {
        g.id = g.hex55;
        delete g.record;
        delete g.hex55;
        hex55.used++;
      }
}

function message(ep: Endpoint, m: unknown, where: string): GMessage {
  if (!Array.isArray(m)) throw new LayoutError(ep, where, 'a message (a list)', kindOf(m));
  if (!isAnyMsgId(m[0])) throw new LayoutError(ep, `${where}[0]`, 'a message id (msg-…:…)', kindOf(m[0]));
  if (!isMsgId(m[0]) || !m[0].startsWith('msg-f:')) {
    const k = `${m[0].slice(0, 5)}${MSG.test(m[0]) ? '' : '*'}`;
    localIdKinds[k] = (localIdKinds[k] ?? 0) + 1;
  }
  if (!isMs(m[6])) throw new LayoutError(ep, `${where}[6]`, "the message's date in ms (13 digits)", kindOf(m[6]));
  if (!isLabelList(m[10])) throw new LayoutError(ep, `${where}[10]`, "the message's labels (^…)", kindOf(m[10]));
  let id = fDecimal(m[0]);
  const h = decimalOfHex(m[55]);
  if (id !== null) {
    if (h === null) hex55.absent++;
    else if (h === id) hex55.agree++;
    else hex55.disagree++;
  }
  return {
    id,
    from: address(m[1]),
    to: addresses(m[2]),
    cc: addresses(m[5]),
    date: m[6],
    labels: m[10],
    snippet: typeof m[9] === 'string' ? m[9] : null,
    attachments: Array.isArray(m[11]) ? m[11].length : 0,
    ...(id === null ? { record: m, ...(h !== null ? { hex55: h } : {}) } : {}),
  };
}

/** A thread row: [0] subject, [1] snippet, [2] date, [3] thread id, [4] its messages, [19] its id in hex. */
function row(ep: Endpoint, r: unknown[], where: string): ThreadRow {
  const msgs = r[4] as unknown[];
  return {
    thread: fDecimal(r[3] as string) ?? decimalOfHex(r[19]),
    subject: typeof r[0] === 'string' ? r[0] : '',
    date: r[2] as number,
    messages: msgs.map((m, i) => message(ep, m, `${where}[4][${i}]`)),
  };
}

const trailerOf = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null);

/**
 * A label list (s's json[1][2], bv's json[1] in the own layout): entries [[id, name, …, (17) type, …], n]. The id is
 * the anchor (a label id, ^…); `strictName`: the name must be a string (s), else the id stands in for it (bv).
 */
function labelList(ep: Endpoint, list: unknown, where: string, strictName: boolean): LabelDef[] {
  if (!Array.isArray(list)) throw new LayoutError(ep, where, 'the label list', kindOf(list));
  return list.map((e, i) => {
    const d = Array.isArray(e) ? e[0] : undefined;
    if (!Array.isArray(d) || typeof d[0] !== 'string' || !d[0].startsWith('^')) throw new LayoutError(ep, `${where}[${i}][0][0]`, 'a label id (^…)', kindOf(Array.isArray(d) ? d[0] : d));
    if (strictName && typeof d[1] !== 'string') throw new LayoutError(ep, `${where}[${i}][0][1]`, "the label's name", kindOf(d[1]));
    return { id: d[0], name: typeof d[1] === 'string' && d[1].trim() ? d[1] : d[0], type: typeof d[17] === 'number' ? d[17] : null };
  });
}

/** Counts (s's json[2][0], bv's json[6][0]): entries [id, unread, total, …]; an entry with only its id has neither. */
function countList(ep: Endpoint, list: unknown, where: string): Map<string, Count> {
  if (!Array.isArray(list)) throw new LayoutError(ep, where, 'the label counts (a list)', kindOf(list));
  const counts = new Map<string, Count>();
  for (const e of list) if (Array.isArray(e) && typeof e[0] === 'string' && e[0].startsWith('^')) counts.set(e[0], { unread: isCount(e[1]) ? e[1] : null, total: isCount(e[2]) ? e[2] : null });
  return counts;
}

const OWN_ROW = /^json\[2\]\[\d+\]\[0\]$/;
const PAGE_ROW = /^json\[19\]\[0\]\[1\]\[\d+\]\[0\]$/;
const BOTH_PLACES = 'thread rows only at json[2][n][0] or json[19][0][1][n][0]';

/**
 * bv's answer, in either of its two known layouts. Both: [0, …, json[4] a number, …, json[18] [a number], …], each
 * row [threadRow, n].
 *
 *   own   (the extractor's own calls, live): json[1] the label list, json[2] the rows, json[6] [[counts]], json[11]
 *         [1, n], json[18] [n].
 *   page  (the page's own list calls, recorded): json[11] [1, 50], json[18] [n], json[19] [[2, rows, 1, …]].
 *
 * Fingerprint: json[0] is 0 and json[18] holds a number (so an empty answer is told from another kind of answer);
 * thread rows (found by their anchors anywhere) only at json[2][n][0] or json[19][0][1][n][0], all of them in one of
 * the two, and every entry there a row; each row's messages pass message()'s anchors. In the own layout, json[1] (when
 * there) is a label list whose entries' ids are label ids, and json[6] (when there) holds the counts' list.
 */
export function parseBv(json: unknown): BvAnswer {
  const ep = 'bv';
  if (!Array.isArray(json)) throw new LayoutError(ep, 'json', 'a list', kindOf(json));
  if (json[0] !== 0) throw new LayoutError(ep, 'json[0]', '0', kindOf(json[0]));
  if (trailerOf(json[18]) === null) throw new LayoutError(ep, 'json[18]', 'a list holding a number', kindOf(json[18]));
  const found = findRows(json);
  for (const f of found) if (!OWN_ROW.test(f.path) && !PAGE_ROW.test(f.path)) throw new LayoutError(ep, f.path, BOTH_PLACES, 'a thread row');
  const own = found.filter((f) => OWN_ROW.test(f.path));
  if (own.length && own.length < found.length) {
    const odd = found.find((f) => !OWN_ROW.test(f.path))!;
    throw new LayoutError(ep, odd.path, 'thread rows in one place only (json[2][n][0] or json[19][0][1][n][0])', 'a thread row in the other place too');
  }
  const pageBox = Array.isArray(json[19]) && Array.isArray(json[19][0]) ? json[19][0][1] : undefined;
  // Where the rows are: where they were found; with none found, the page layout if json[19] has its box, else the own
  // layout if json[2] is a list (whose entries must then be rows), else an empty answer of the own layout if it has a
  // label list, else of neither.
  const layout: BvLayout | null = found.length ? (own.length ? 'own' : 'page') : pageBox !== undefined ? 'page' : Array.isArray(json[2]) || Array.isArray(json[1]) ? 'own' : null;
  const rows: ThreadRow[] = [];
  const box = layout === 'page' ? pageBox : layout === 'own' ? json[2] : undefined;
  const at = layout === 'page' ? 'json[19][0][1]' : 'json[2]';
  if (box !== undefined && box !== null && !Array.isArray(box)) throw new LayoutError(ep, at, 'the list of thread rows', kindOf(box));
  for (const [i, e] of ((box as unknown[] | null | undefined) ?? []).entries()) {
    const where = `${at}[${i}][0]`;
    const r = Array.isArray(e) ? e[0] : e;
    if (!isRow(r)) throw rowError(ep, r, where);
    rows.push(row(ep, r, where));
  }
  let labels: LabelDef[] | null = null;
  let counts: Map<string, Count> | null = null;
  if (layout === 'own') {
    if (json[1] !== null && json[1] !== undefined) labels = labelList(ep, json[1], 'json[1]', false);
    if (json[6] !== null && json[6] !== undefined) counts = countList(ep, Array.isArray(json[6]) ? json[6][0] : json[6], 'json[6][0]');
  }
  // json[4] is not the result estimate: live answers carry a 6 to 7 digit number there for searches with a few dozen
  // results (self-check, 2026-11-13). Kept as evidence, never reported as an estimate.
  resolveLocalIds(rows);
  return { rows, layout, estimate: null, json4: isCount(json[4]) ? json[4] : null, trailer: trailerOf(json[18]), labels, counts };
}

/**
 * fd's answer to a thread fetch. Recorded: [0, [[thread-f, [meta, summaries], fulls, null, n], …], null, null, [n]],
 * meta [thread-f, subject, snippet, date, …], each summary [msg-f, [1, address, name], date, labels, …]. Fingerprint:
 * json[0] is 0, json[1] a list of entries whose [0] is a thread id; a summary's [0] a message id, [2] a date, [3]
 * its labels.
 */
export function parseFd(json: unknown): FdAnswer {
  const ep = 'fd';
  if (!Array.isArray(json)) throw new LayoutError(ep, 'json', 'a list', kindOf(json));
  if (json[0] !== 0) throw new LayoutError(ep, 'json[0]', '0', kindOf(json[0]));
  if (!Array.isArray(json[1])) throw new LayoutError(ep, 'json[1]', 'the list of threads', kindOf(json[1]));
  const threads: FdAnswer['threads'] = [];
  for (const [i, e] of json[1].entries()) {
    const w = `json[1][${i}]`;
    if (!Array.isArray(e) || !isThreadId(e[0])) throw new LayoutError(ep, `${w}[0]`, 'a thread id (thread-f:…)', kindOf(Array.isArray(e) ? e[0] : e));
    const messages: GMessage[] = [];
    if (e[1] !== null && e[1] !== undefined) {
      if (!Array.isArray(e[1]) || !Array.isArray(e[1][1])) throw new LayoutError(ep, `${w}[1][1]`, "the thread's message summaries", kindOf(Array.isArray(e[1]) ? e[1][1] : e[1]));
      for (const [j, m] of (e[1][1] as unknown[]).entries()) {
        const mw = `${w}[1][1][${j}]`;
        if (!Array.isArray(m) || !isMsgId(m[0])) throw new LayoutError(ep, `${mw}[0]`, 'a message id (msg-f:…)', kindOf(Array.isArray(m) ? m[0] : m));
        if (!isMs(m[2])) throw new LayoutError(ep, `${mw}[2]`, "the message's date in ms (13 digits)", kindOf(m[2]));
        if (!isLabelList(m[3])) throw new LayoutError(ep, `${mw}[3]`, "the message's labels (^…)", kindOf(m[3]));
        messages.push({ id: fDecimal(m[0]), from: address(m[1]), to: [], cc: [], date: m[2], labels: m[3], snippet: typeof m[10] === 'string' ? m[10] : null, attachments: 0 });
      }
    }
    threads.push({ thread: fDecimal(e[0]), messages });
  }
  return { threads, trailer: trailerOf(json[4]) };
}

/**
 * s's answer. Recorded: [writes|null, [0, null, labels|null, null, [d, d], updates|null, 1, history, null, null, d],
 * [[counts]], [n]]: labels [[id, name, …, (17) type, …], n], each update [thread-f, null, [null ×6, threadRow, …]],
 * counts [id, unread, total]. Fingerprint: json[1][0] is 0 and json[1][7] the new sync point (a number); thread rows
 * only at json[1][5][n][0][2][6][0]; label entries an id (^…) and a name; json[2][0] the counts.
 */
export function parseS(json: unknown): SAnswer {
  const ep = 's';
  if (!Array.isArray(json)) throw new LayoutError(ep, 'json', 'a list', kindOf(json));
  const block = json[1];
  if (!Array.isArray(block) || block[0] !== 0) throw new LayoutError(ep, 'json[1][0]', '0 (the sync block)', kindOf(Array.isArray(block) ? block[0] : block));
  if (!isCount(block[7])) throw new LayoutError(ep, 'json[1][7]', 'the new sync point (a number)', kindOf(block[7]));
  for (const f of findRows(json)) if (!/^json\[1\]\[5\]\[\d+\]\[0\]\[2\]\[6\]\[0\]$/.test(f.path)) throw new LayoutError(ep, f.path, 'thread rows only at json[1][5][n][0][2][6][0]', 'a thread row');
  const labels = block[2] !== null && block[2] !== undefined ? labelList(ep, block[2], 'json[1][2]', true) : null;
  const rows: ThreadRow[] = [];
  if (block[5] !== null && block[5] !== undefined) {
    if (!Array.isArray(block[5])) throw new LayoutError(ep, 'json[1][5]', 'the list of changed threads', kindOf(block[5]));
    for (const f of findRows(block[5], 'json[1][5]')) rows.push(row(ep, f.rec, f.path));
  }
  const counts = countList(ep, Array.isArray(json[2]) ? json[2][0] : undefined, 'json[2][0]');
  resolveLocalIds(rows);
  return { history: String(block[7]), labels, rows, counts, trailer: trailerOf(json[3]) };
}

// ------------------------------------------------------------------ the download route
/**
 * The download route's answer is a message when it starts with a header block (a field name and a colon on its
 * first line, a blank line after the block) holding at least one of the headers every message has, and is not an
 * HTML page (what a wrong key or a sign-in page would be). The reason when it is not, without its content.
 */
export function notAMessage(bytes: Uint8Array, type: string | null | undefined, opts: { headerless?: boolean } = {}): string | null {
  if (type && /^text\/html\b/i.test(type)) return 'an HTML page, not a message';
  const head = Buffer.from(bytes.subarray(0, 256 * 1024)).toString('latin1');
  // A message with no headers at all: an empty header block, so a blank line first, then its body. Taken only when
  // the caller knows the message is headerless (Gmail lists it with no sender), and never when markup follows.
  if (opts.headerless && /^\r?\n/.test(head) && !/^\s*</.test(head)) return null;
  const end = head.search(/\r?\n\r?\n/);
  if (!/^[\x21-\x39\x3b-\x7e]{1,76}:/.test(head)) return `no header line at the start (${startOf(bytes.length, head)})`;
  if (end < 0) return 'no end to the header block';
  if (!/^(?:from|date|message-id|received|mime-version|subject|return-path|delivered-to):/im.test(head.slice(0, end))) return 'no message header in the header block';
  return null;
}

/** What a download with no header line starts with, as a shape only (never its text): what tells a fix which case it is. */
function startOf(size: number, head: string): string {
  if (size === 0) return 'the download is empty';
  if (/^\xef\xbb\xbf/.test(head)) return 'a byte-order mark first';
  if (/^\r?\n/.test(head)) return 'a blank line first';
  if (/^[ \t]/.test(head)) return 'a space first';
  if (/^From /.test(head)) return 'an mbox "From " line first';
  if (/^\s*</.test(head)) return 'markup first';
  if (/^[\x21-\x39\x3b-\x7e]{77,}:/.test(head)) return 'a field name over 76 characters first';
  return `a first line with no field name and colon, ${size} bytes`;
}
