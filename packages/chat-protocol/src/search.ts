/**
 * The search box's little language, shared by hub and PWA:
 *   rust "borrow checker" -async from:alice in:dev network:discord has:image mentions:me after:2026-01-01 before:2026-02-01 sort:relevance
 * Anything that is not a known operator is text, so "from:" alone or "http://x" still search as typed.
 *
 * Mail (docs/mail.md) reads the same language with its own operators: parseSearch(input, now, 'mail').
 *   invoice from:sam to:jo with:alex subject:lease in:archive label:work has:attachment filename:lease is:unread account:proton after:2026-01
 */
export interface SearchQuery {
  terms: string[];
  phrases: string[];
  not: string[];
  from: string[];
  in: string[];
  network: string[];
  /** Accounts by label or id: what reached the hub through them. */
  account: string[];
  has: string[];
  /** pinned, edited, deleted (kept deleted or disappeared messages, docs/history.md). */
  is: string[];
  mentionsMe: boolean;
  /** People mentioned, by name. */
  mentions: string[];
  after: number | null;
  before: number | null;
  relevance: boolean;
  oldest: boolean;
  /** Mail only: recipients (To or Cc), either side (From, To or Cc), words in the subject, labels. */
  to: string[];
  with: string[];
  subject: string[];
  label: string[];
  /** Mail only: words in an attachment's file name (Gmail's `filename:`). */
  filename: string[];
}

export const SEARCH_HAS = ['attachment', 'image', 'video', 'audio', 'file', 'link', 'embed', 'sticker', 'reaction'] as const;
export const SEARCH_IS = ['pinned', 'edited', 'deleted'] as const;
export const SEARCH_SORT = ['newest', 'oldest', 'relevance'] as const;
/** Discord's names for the same things. */
const HAS_ALIAS: Record<string, string> = { sound: 'audio', voice: 'audio', files: 'file', images: 'image', links: 'link', embeds: 'embed' };

/** The operators, in the order the box suggests them. */
export const SEARCH_OPS: { op: string; hint: string }[] = [
  { op: 'from', hint: 'a person' },
  { op: 'mentions', hint: 'a person, or me' },
  { op: 'in', hint: 'a chat or community' },
  { op: 'has', hint: 'link, image, file, embed…' },
  { op: 'is', hint: 'pinned, edited, deleted' },
  { op: 'network', hint: 'discord, signal, matrix…' },
  { op: 'account', hint: 'one of your accounts' },
  { op: 'before', hint: 'a date' },
  { op: 'during', hint: 'a day or a month' },
  { op: 'after', hint: 'a date' },
  { op: 'sort', hint: 'newest, oldest, relevance' },
];

/** What mail's is: takes (`flagged` is starred). */
export const MAIL_SEARCH_IS = ['unread', 'read', 'starred'] as const;

/** Mail's operators, in the order its box suggests them. */
export const MAIL_SEARCH_OPS: { op: string; hint: string }[] = [
  { op: 'from', hint: 'a sender' },
  { op: 'to', hint: 'a recipient' },
  { op: 'with', hint: 'anyone on it' },
  { op: 'subject', hint: 'words in the subject' },
  { op: 'in', hint: 'inbox, sent, archive, trash, a folder' },
  { op: 'label', hint: 'a label' },
  { op: 'has', hint: 'attachment' },
  { op: 'filename', hint: "an attachment's name" },
  { op: 'is', hint: 'unread, read, starred' },
  { op: 'account', hint: 'one of your mail accounts' },
  { op: 'before', hint: 'a date' },
  { op: 'during', hint: 'a day or a month' },
  { op: 'after', hint: 'a date' },
];

/** A day (2026-01-15), a month (2026-01), today or yesterday: its start, or with `end` the start of the next. */
export function searchDay(s: string, end: boolean, now = new Date()): number | null {
  const rel = { today: 0, yesterday: -1 }[s.toLowerCase()];
  if (rel !== undefined) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + rel + (end ? 1 : 0)).getTime();
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (end) return d ? new Date(y, m - 1, d + 1).getTime() : new Date(y, m, 1).getTime();
  return new Date(y, m - 1, d ?? 1).getTime();
}

export function parseSearch(input: string, now = new Date(), kind: 'chat' | 'mail' = 'chat'): SearchQuery {
  const q: SearchQuery = { terms: [], phrases: [], not: [], from: [], in: [], network: [], account: [], has: [], is: [], mentionsMe: false, mentions: [], after: null, before: null, relevance: false, oldest: false, to: [], with: [], subject: [], label: [], filename: [] };
  const day = (s: string, end: boolean) => searchDay(s, end, now);
  const mail = kind === 'mail';
  for (const m of input.matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    const [whole, neg, op, quoted, bare] = m;
    const val = quoted ?? bare ?? '';
    if (!val) continue;
    const key = op?.toLowerCase();
    const low = val.toLowerCase();
    if (!neg && key && mail && mailOp(q, key, val, low)) continue;
    if (!neg && key && !mail) {
      if (key === 'from') { q.from.push(val); continue; }
      if (key === 'in') { q.in.push(val); continue; }
      if (key === 'network' || key === 'on') { q.network.push(low); continue; }
      if (key === 'account') { q.account.push(val); continue; }
      const has = HAS_ALIAS[low] ?? low;
      if (key === 'has' && (SEARCH_HAS as readonly string[]).includes(has)) { q.has.push(has); continue; }
      if (key === 'is' && (SEARCH_IS as readonly string[]).includes(low)) { q.is.push(low); continue; }
      if (key === 'pinned' && ['true', 'yes'].includes(low)) { q.is.push('pinned'); continue; }
      if (key === 'mentions' && low === 'me') { q.mentionsMe = true; continue; }
      if (key === 'mentions') { q.mentions.push(val); continue; }
    }
    if (!neg && key) {
      if (key === 'sort' && low === 'relevance') { q.relevance = true; continue; }
      if (key === 'sort' && low === 'oldest') { q.oldest = true; continue; }
      if (key === 'sort' && low === 'newest') continue;
      if (key === 'after' && day(val, true) !== null) { q.after = day(val, true); continue; }
      if (key === 'before' && day(val, false) !== null) { q.before = day(val, false); continue; }
      if (key === 'during' && day(val, false) !== null) { q.after = day(val, false); q.before = day(val, true); continue; }
    }
    const text = op ? whole.replace(/^-/, '').replace(/"/g, '') : val;
    if (neg) q.not.push(text);
    else if (quoted !== undefined && !op) q.phrases.push(text);
    else q.terms.push(text);
  }
  return q;
}

/** One of mail's operators into the query; false when it is not one (it is text then). */
function mailOp(q: SearchQuery, key: string, val: string, low: string): boolean {
  switch (key) {
    case 'from':
    case 'in':
    case 'account':
    case 'to':
    case 'with':
    case 'subject':
    case 'label':
    case 'filename':
      q[key].push(val);
      return true;
    case 'cc':
      q.to.push(val);
      return true;
    case 'has':
      if (!['attachment', 'attachments', 'file', 'files'].includes(low)) return false;
      q.has.push('attachment');
      return true;
    case 'is': {
      const is = low === 'flagged' ? 'starred' : low;
      if (!(MAIL_SEARCH_IS as readonly string[]).includes(is)) return false;
      q.is.push(is);
      return true;
    }
  }
  return false;
}

/**
 * Whether a query from the app's search box means something in mail too: not when it names what only chats have
 * (a network, a mention, a chat or community, pinned, edited, deleted, an image). The search page's Mail group runs
 * only then.
 */
export function mailSearchable(input: string): boolean {
  const q = parseSearch(input);
  if (q.network.length && !q.network.includes('email')) return false;
  if (q.mentionsMe || q.mentions.length || q.in.length || q.is.length) return false;
  if (q.has.some((h) => h !== 'attachment' && h !== 'file')) return false;
  return q.terms.length + q.phrases.length + q.from.length + q.has.length > 0 || q.after !== null || q.before !== null;
}

/** The query with one operator set, cleared or toggled, for the filter buttons. */
export function setSearchOp(input: string, op: string, value: string | null): string {
  const re = new RegExp(`(^|\\s)${op}:(?:"[^"]*"|\\S+)`, 'gi');
  const rest = input.replace(re, '').replace(/\s+/g, ' ').trim();
  if (value === null || value === '') return rest;
  return `${rest} ${op}:${searchValue(value)}`.trim();
}

/** A value as an operator takes it: quoted when it has spaces. */
export const searchValue = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

export function searchOp(input: string, op: string): string | null {
  const m = input.match(new RegExp(`(?:^|\\s)${op}:(?:"([^"]*)"|(\\S+))`, 'i'));
  return m ? (m[1] ?? m[2]) : null;
}

/** Every value of one operator, for the ones that may repeat (has:, is:). */
export function searchOps(input: string, op: string): string[] {
  return [...input.matchAll(new RegExp(`(?:^|\\s)${op}:(?:"([^"]*)"|(\\S+))`, 'gi'))].map((m) => (m[1] ?? m[2]).toLowerCase());
}

/** Add or take away one value of an operator that may repeat. */
export function toggleSearchOp(input: string, op: string, value: string): string {
  const re = new RegExp(`(^|\\s)${op}:${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi');
  return re.test(input) ? input.replace(re, '').replace(/\s+/g, ' ').trim() : `${input.trim()} ${op}:${searchValue(value)}`.trim();
}
