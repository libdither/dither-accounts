/**
 * The Gmail self-check: the mail ops run once on the live page, and a report of counts, booleans and types only
 * (docs/google.md, "The Gmail self-check"). Never a subject, an address, a name, a body, a label's name or an id: each
 * step keeps numbers it counted and yes/no answers, and errors keep only this extractor's own sentences, which name no
 * value. It reads one message whole, and only one that is already read and more than 30 days old, found by a search for
 * exactly those (is:read older_than:30d) and checked again here: unread mail is never opened.
 */
import type { MailSummary } from '@dither-accounts/interfaces';
import type { GmailMail, SyncInfo } from './mail.ts';
import { parseMessage } from './mime.ts';
import { ENDPOINTS } from './protocol.ts';
import { hex55, localIdKinds } from './protocol.ts';

const DAY = 86_400_000;
const Y2K = Date.UTC(2000, 0, 1);

/** A count beside what was listed: 'equal', 'more' or 'fewer'; never either number. */
const rel = (a: number | null | undefined, b: number): 'equal' | 'more' | 'fewer' | null => (a === null || a === undefined ? null : a === b ? 'equal' : a > b ? 'more' : 'fewer');

/** An error as the report keeps it: the status and this extractor's sentence, anything like an address or a long number out. */
const why = (e: unknown) =>
  `${(e as { status?: number })?.status ?? 'error'}: ${String((e as Error)?.message ?? e)
    .replace(/[^\s()<>"',;:]+@[^\s()<>"',;:]+/g, '<address>')
    .replace(/\d{6,}/g, '<n>')
    .slice(0, 240)}`;

async function step<T>(f: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try {
    const value = await f();
    return { ms: Date.now() - t0, value };
  } catch (e) {
    return { ms: Date.now() - t0, error: why(e) };
  }
}

/** How many summaries have each field filled, and whether ids, dates and order are as they should be. */
export function fill(list: MailSummary[], mailboxId: string | null, now: number) {
  const n = (f: (m: MailSummary) => boolean) => list.filter(f).length;
  return {
    listed: list.length,
    subject: n((m) => !!m.subject),
    from: n((m) => m.from.length > 0),
    to: n((m) => m.to.length > 0),
    cc: n((m) => m.cc.length > 0),
    preview: n((m) => !!m.preview),
    threadId: n((m) => !!m.threadId),
    emailIdIsId: n((m) => m.emailId === m.id),
    messageIdNull: n((m) => m.messageId === null),
    labels: n((m) => m.labels.length > 0),
    category: n((m) => m.labels.some((l) => l.startsWith('Category/'))),
    hasAttachments: n((m) => m.hasAttachments),
    seen: n((m) => m.flags.seen),
    flagged: n((m) => m.flags.flagged),
    draft: n((m) => m.flags.draft),
    idsDecimal: list.every((m) => /^\d{1,20}$/.test(m.id) && (!m.threadId || /^\d{1,20}$/.test(m.threadId))),
    datesInRange: list.every((m) => m.date >= Y2K && m.date <= now + DAY),
    newestFirst: list.every((m, i) => i === 0 || list[i - 1]!.date >= m.date),
    mailboxIdAsAsked: mailboxId === null ? null : list.every((m) => m.mailboxId === mailboxId),
  };
}

export async function selfCheck(mail: GmailMail, info: () => Promise<SyncInfo>, now: () => number = Date.now) {
  const t0 = Date.now();
  const page = await step(info);
  const pageOut = page.value ? { syncSeen: page.value.sync, syncHeaders: page.value.headers, accountKey: page.value.ik, syncPoint: !!page.value.history, ms: page.ms } : { error: page.error, ms: page.ms };

  const boxes = await step(() => mail.mailboxes());
  const mbs = boxes.value?.mailboxes ?? [];
  const mailboxes = boxes.value
    ? {
        count: mbs.length,
        roles: [...new Set(mbs.map((b) => b.role).filter((r): r is NonNullable<typeof r> => !!r))].sort(),
        system: mbs.filter((b) => b.id === 'all' || /^\^(?!x_)/.test(b.id)).length,
        user: mbs.filter((b) => /^\^x_/.test(b.id)).length,
        nested: mbs.filter((b) => b.parentId !== null).length,
        withUnread: mbs.filter((b) => b.unread !== null).length,
        withTotal: mbs.filter((b) => b.total !== null).length,
        unreadButNoTotal: mbs.filter((b) => b.unread !== null && b.total === null).length,
        // Gmail's sync, or (no sync point known) one list answer's label list and counts.
        source: mail.evidence.mailboxesFrom,
        ms: boxes.ms,
      }
    : { error: boxes.error, ms: boxes.ms };

  let inboxList: MailSummary[] | null = null;
  let inboxComplete = false;
  const listOf = async (mailboxId: string) => {
    const r = await step(() => mail.list({ mailboxId, limit: 50 }));
    if (mailboxId === '^i' && r.value) {
      inboxList = r.value.messages;
      inboxComplete = r.value.next === null;
    }
    return r.value ? { ...fill(r.value.messages, mailboxId, now()), next: r.value.next !== null, ms: r.ms } : { error: r.error, ms: r.ms };
  };
  const inbox = await listOf('^i');
  // The inbox's two counts (as Gmail gave them with the list: which is unread and which total is a guess) beside the
  // list itself, as relations only: unread messages and threads listed, messages and threads listed.
  const c = mail.lastCounts?.get('^i') ?? null;
  const listed = (inboxList ?? []) as MailSummary[];
  const unreadListed = listed.filter((m) => !m.flags.seen);
  const inboxCounts = inboxList
    ? {
        from: mail.evidence.countsFrom,
        present: !!c,
        listComplete: inboxComplete,
        firstVsUnreadMessages: rel(c?.unread, unreadListed.length),
        firstVsUnreadThreads: rel(c?.unread, new Set(unreadListed.map((m) => m.threadId)).size),
        secondVsListedMessages: rel(c?.total, listed.length),
        secondVsListedThreads: rel(c?.total, new Set(listed.map((m) => m.threadId)).size),
        firstAtMostSecond: c && c.unread !== null && c.total !== null ? c.unread <= c.total : null,
      }
    : null;
  const allMail = await listOf('all');

  const ids = await step(() => mail.search({ query: 'in:inbox newer_than:30d', idsOnly: true, limit: 500 }) as Promise<{ ids: string[]; next: string | null; estimate: number | null }>);
  const searchIds = ids.value
    ? {
        operators: ['in', 'newer_than'],
        ids: ids.value.ids.length,
        unique: new Set(ids.value.ids).size === ids.value.ids.length,
        idsDecimal: ids.value.ids.every((x) => /^\d{1,20}$/.test(x)),
        next: ids.value.next !== null,
        estimate: ids.value.estimate === null ? 'null' : typeof ids.value.estimate,
        // Beside the ids found (a count of conversations may be fewer than of messages), and how many digits it has
        // (a history id has many more than a count of last month's inbox).
        estimateVsIds: ids.value.estimate === null ? null : ids.value.estimate < ids.value.ids.length ? 'fewer' : ids.value.estimate === ids.value.ids.length ? 'equal' : 'more',
        estimateDigits: ids.value.estimate === null ? null : String(ids.value.estimate).length,
        ms: ids.ms,
      }
    : { error: ids.error, ms: ids.ms };

  // One message: already read and older than 30 days, from a search for exactly those, checked again here.
  const message: Record<string, unknown> = { chosenFrom: 'is:read older_than:30d' };
  const pool = await step(() => mail.search({ query: 'is:read older_than:30d', limit: 20 }) as Promise<{ messages: MailSummary[] }>);
  message.searchMs = pool.ms;
  if (pool.error) message.error = pool.error;
  const pick = pool.value?.messages.find((m) => m.flags.seen && m.date < now() - 30 * DAY && m.date >= Y2K);
  message.found = !!pick;
  message.candidates = pool.value?.messages.length ?? 0;
  if (pick) {
    const raw = await step(() => mail.raw({ id: pick.id }));
    if (raw.value) {
      const bytes = Buffer.from(raw.value.base64, 'base64');
      const parsed = await step(() => parseMessage(bytes));
      message.raw = {
        bytes: bytes.length,
        sizeMatches: raw.value.size === bytes.length,
        mime: raw.value.mime,
        parsed: !!parsed.value,
        messageIdHeader: !!parsed.value?.messageId,
        fromHeader: !!parsed.value?.from.length,
        dateHeader: parsed.value?.date !== null && parsed.value?.date !== undefined,
        ms: raw.ms,
      };
    } else message.raw = { error: raw.error, ms: raw.ms };
    const got = await step(() => mail.get({ id: pick.id }));
    const g = got.value;
    message.get = g
      ? {
          sameId: g.id === pick.id && g.emailId === pick.id,
          sameThread: g.threadId === pick.threadId,
          messageId: !!g.messageId,
          text: !!g.text,
          html: !!g.html,
          attachments: g.attachments.length,
          inReplyTo: !!g.inReplyTo,
          references: g.references.length,
          bulk: !!g.bulk,
          labels: g.labels.length,
          stillSeen: g.flags.seen,
          from: g.from.length,
          to: g.to.length,
          bytes: g.size,
          ms: got.ms,
        }
      : { error: got.error, ms: got.ms };
    if (pick.threadId) {
      const t = await step(() => mail.threadMessages(pick.threadId!));
      message.thread = t.value !== undefined ? { messages: t.value, ms: t.ms } : { error: t.error, ms: t.ms };
    }
  }

  const ev = mail.evidence;
  const h = ev.lastHistory === null ? null : Number(ev.lastHistory);
  // The page's own sync point now (it may have synced meanwhile), beside the last list answer's json[18][0].
  const pageNow = await step(info);
  const pp = pageNow.value?.history ? Number(pageNow.value.history) : null;
  const evidence = {
    // json[4] of bv, read as the estimate: a history id would equal the sync point.
    estimateEqualsSyncPoint: h === null || ev.lastEstimate === null ? null : ev.lastEstimate === h,
    bvTrailerEqualsSyncPoint: h === null || ev.lastBvTrailer === null ? null : ev.lastBvTrailer === h,
    sTrailerEqualsSyncPoint: h === null || ev.lastSTrailer === null ? null : ev.lastSTrailer === h,
    // bv's json[18][0] as a sync point: beside the page's own (a sync point taken earlier is at most the current one),
    // and whether it ever went down from one list answer to the next (null: fewer than two answers).
    bvTrailerEqualsPagePoint: pp === null || ev.lastBvTrailer === null ? null : ev.lastBvTrailer === pp,
    bvTrailerVsPagePoint: pp === null ? null : rel(ev.lastBvTrailer, pp),
    bvTrailerMonotonic: ev.bvTrailerPairs ? ev.bvTrailerDecreased === 0 : null,
    bvTrailerPairs: ev.bvTrailerPairs,
    pointFrom: ev.pointFrom,
    sFromBvPoint: ev.sFromBvPoint,
    bvPointRefused: ev.bvPointRefused,
    // Which of bv's two known layouts answered: the last one, and how many of each.
    bvLayout: ev.bvLayout,
    bvLayouts: ev.bvLayouts,
    // Rows dated after a page's before: cutoff: Gmail dates a row by its newest message, not the newest it matched.
    rowsAfterCutoff: ev.rowsAfterCutoff,
    pagingFallbacks: ev.pagingFallbacks,
    // Messages the page has not got from Gmail yet (msg-a ids), left out.
    notYetGmail: ev.notYetGmail,
    hex55: { ...hex55 },
    localIdKinds: { ...localIdKinds },
  };
  const fingerprints = Object.fromEntries(ENDPOINTS.map((e) => [e, { calls: mail.fp[e].calls, ok: mail.fp[e].ok, failed: mail.fp[e].failed, firstMismatch: mail.fp[e].first }]));
  const errors = [page.error, boxes.error, (inbox as { error?: string }).error, (allMail as { error?: string }).error, ids.error, pool.error].filter(Boolean).length;
  return {
    at: new Date().toISOString(),
    ok: errors === 0 && !!pick && !(message.raw as { error?: string })?.error && !(message.get as { error?: string })?.error,
    page: pageOut,
    mailboxes,
    inbox,
    allMail,
    searchIds,
    message,
    inboxCounts,
    evidence,
    lane: { backgroundStopped: mail.background().stopped, readsMarkRead: mail.readsMarkRead },
    fingerprints,
    ms: Date.now() - t0,
  };
}
