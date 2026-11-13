/**
 * A fake of the parts of Google the google provider and google-api extractor call (moved here from dither-calendar,
 * which now reaches Google through dither-accounts): the token and revoke endpoints (with PKCE), calendarList,
 * calendars.insert, and events list/insert/patch/delete with real sync-token semantics and instance ids. Helpers
 * stand in for someone using Google's own app: put/remove an event, invalidate sync tokens, expire or revoke tokens,
 * fail the next calls.
 *
 * With `web`, it is the signed-in browser's Google instead (extractors/google): a stand-in Calendar page at
 * /calendar/u/<n>/r, which sets a SAPISID cookie for authuser 0 only and makes a couple of calls of its own, and the
 * same Calendar API checking an API key and a SAPISIDHASH made from that cookie and the page's origin, not a token.
 * A second server, on its own origin (`mailUrl`), is the Gmail side: a stand-in Gmail page at /mail/u/<n>/ (the same
 * cookie for authuser 0, a key in its HTML) and the Gmail API v1's profile and labels, which want a SAPISIDHASH made
 * with that origin. `stall()` makes a page's API calls hang, as a page that stopped answering looks to the extractor.
 *
 * The signed-in Gmail page also runs a stand-in of Gmail's own app (fake-gmail-page.js): a thread list with Gmail's
 * read and unread row markers, and calls to its own origin's /sync/u/0/i/bv (the list) and /sync/u/0/i/fd (a thread)
 * and a /mail/u/0/x/<id>/ resource, answered with positional JSON after an XSSI prefix full of `mailMark`, as the
 * learn run's recorder sees Gmail's. `mailOpened` lists the threads the page opened (its fd calls).
 *
 * Behind the same endpoints is a fake Gmail mailbox (`gmail`), answered in the layout the live page's traffic was
 * recorded in (extractors/google/src/gmail/protocol.ts says where each thing is): bv lists threads for a Gmail search
 * (in:, is:, label:, before:/after: in epoch seconds or dates, newer_than:/older_than:, category:, has:attachment,
 * rfc822msgid:, free words), each row dated by its newest matching message, 50 at a time; fd fetches whole threads; s
 * answers what changed since a sync point (history id), with the label list and counts, and refuses any body carrying
 * label changes (a write: counted in `gmail.writes`); GET /mail/u/0/?view=att&th=<hex>… is Gmail's "Download message"
 * route, the message's .eml. Each of them wants the page's cookie and the XSRF token the page sends (the download, the
 * page's account key, ik), as the hook replays them. The stand-in app's own calls (its older bodies) keep their canned
 * answers. `gmail.layout('swapped')` answers bv with each row's date and thread id swapped, a layout the extractor
 * must refuse. Its messages are full of `mailMark` too.
 *
 * bv answers in either of its two known layouts (`gmail.bvLayout`): 'own', as the live Gmail answers the extractor's
 * own calls (the label list at json[1], rows at json[2], counts at json[6], the sync point at json[18]; the default),
 * or 'page', as the page's own list calls were recorded (rows at json[19][0][1]); 'third' puts the rows at json[3], a
 * layout to refuse. And as Gmail turning on a reader: `gmail.challenge(…)` answers every call with a verification page
 * (HTML), a 429 naming a captcha, a sign-in page, or a page that says none of those; `gmail.failNext` /
 * `gmail.delayNext` fail or slow the next calls;
 * `gmail.readsMarkRead(true)` makes a download take ^u off the message, as a reader that marks mail read would.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface FakeCalendar {
  id: string;
  summary: string;
  description?: string;
  timeZone: string;
  accessRole: string;
  primary?: boolean;
  selected?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
}

type Ev = Record<string, any> & { id: string; seq: number };

export const CLIENT = { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret' };

export interface WebOpts {
  /** The SAPISID cookie the authuser-0 page sets. */
  sapisid: string;
  /** The key the page's own calls use, and one that is only in its HTML. */
  pageKey: string;
  htmlKey: string;
  /** What the page's account button says. */
  email: string;
  /** Gmail: the key in its page's HTML, the profile's address and the labels' names (none of them may leak). */
  mailKey?: string;
  mailEmail?: string;
  labels?: string[];
  /** Gmail: the content the stand-in Gmail app's list, threads and calls are full of (none of it may leak). */
  mailMark?: string;
}

// ------------------------------------------------------------------ the fake Gmail's mailbox
export interface FakeAddress {
  name?: string;
  email: string;
}
export interface FakeMessage {
  /** Gmail's id (msg-f), decimal; a pending one is the page's own (msg-a), not Gmail's yet. */
  id: string;
  thread: string;
  from: FakeAddress;
  to: FakeAddress[];
  cc: FakeAddress[];
  subject: string;
  body: string;
  date: number;
  labels: string[];
  messageId: string;
  inReplyTo?: string;
  listId?: string;
  attachment?: { name: string; mime: string; data: Buffer };
  pending?: boolean;
  /** Sent from the web app: its record's id is the page's own (msg-a), with Gmail's id in hex at [55], as live Gmail sends it. */
  localId?: boolean;
  /** Kept by Gmail with no headers at all (its original a blank line, then the body); list it with an empty from.email. */
  headerless?: boolean;
  /** The sync point (history id) of its last change. */
  history: number;
}
export interface FakeLabel {
  id: string;
  name: string;
  /** 5 system, 1 category, 2 yours (as the live label list). */
  type: number;
}
const DAY = 86_400_000;
/** Thread ids: the first message's id, as Gmail's are. */
const THREAD_BASE = 1_700_000_000_000_000_000n;
export const FAKE_SYSTEM_LABELS = ['^i', '^t', '^t_z', '^io_im', '^f', '^scheduled', '^r', '^all', '^s', '^k', '^b'];

/**
 * A mailbox to read: 90 threads over 280 days, a third with replies (some of them yours, Sent), categories, your labels
 * (one nested), unread and starred ones, attachments, a newsletter with List-Id, two in Spam, two in Trash, a draft,
 * and a reply the page has not got from Gmail yet (msg-a). Everything a person wrote holds `mark`.
 */
export function fakeMailbox(mark: string, now: number) {
  const me: FakeAddress = { name: `Owner ${mark}`, email: `owner.${mark.replace(/\W/g, '')}@example.com` };
  const labels: FakeLabel[] = [
    ...FAKE_SYSTEM_LABELS.map((id) => ({ id, name: id, type: 5 })),
    ...['^smartlabel_personal', '^smartlabel_social', '^smartlabel_promo', '^smartlabel_notification', '^smartlabel_group', '^smartlabel_receipt', '^io_unim'].map((id) => ({ id, name: id, type: 1 })),
    // Gmail's own that are no mailbox either: assistive labels (8), and one of another kind (10).
    { id: '^assistive_purchase', name: '^assistive_purchase', type: 8 },
    { id: '^wc_tb_ready', name: '^wc_tb_ready', type: 10 },
    { id: '^x_1', name: `Work ${mark}`, type: 2 },
    { id: '^x_2', name: `Work ${mark}/Clients ${mark}`, type: 2 },
    { id: '^x_3', name: `Travel ${mark}`, type: 2 },
  ];
  const messages: FakeMessage[] = [];
  const CATS = [
    ['^smartlabel_personal', '^sq_ig_i_personal'],
    ['^smartlabel_promo', '^sq_ig_i_promo'],
    ['^smartlabel_social', '^sq_ig_i_social'],
    ['^smartlabel_notification', '^sq_ig_i_notification'],
    ['^smartlabel_receipt', '^sq_ig_i_personal'],
    ['^smartlabel_promo', '^sq_ig_i_personal'],
  ];
  for (let k = 0; k < 90; k++) {
    const thread = (THREAD_BASE + BigInt(k) * 100n).toString();
    const base = now - Math.round((k + 0.5) * 3.1 * DAY);
    const n = k % 3 === 0 ? 3 : 1;
    const person: FakeAddress = { name: `Person ${k} ${mark}`, email: `p${k}.${mark.replace(/\W/g, '')}@example.net` };
    const cats = CATS[k % CATS.length]!;
    for (let i = 0; i < n; i++) {
      const mine = i === 1;
      const labels = ['^all'];
      if (!mine && k % 5 !== 4) labels.push('^i');
      if (mine) labels.push('^f');
      if (!mine && i === n - 1 && k % 7 === 1) labels.push('^u');
      if (k % 11 === 0 && i === 0) labels.push('^t');
      if (k % 6 === 0) labels.push('^io_im');
      if (k % 8 === 0) labels.push('^x_1');
      if (k % 13 === 0) labels.push('^x_2');
      if (k % 17 === 3) labels.push('^x_3');
      if (!mine) labels.push(...cats);
      messages.push({
        id: (BigInt(thread) + BigInt(i)).toString(),
        thread,
        from: mine ? me : person,
        to: [mine ? person : me],
        cc: k % 4 === 0 ? [{ email: `cc${k}.${mark.replace(/\W/g, '')}@example.org` }] : [],
        subject: `${i ? 'Re: ' : ''}Plans ${k} ${mark}`,
        body: `Hello ${mark}, this is message ${i} of thread ${k}.`,
        date: base + i * 3_600_000,
        labels,
        messageId: `<m${k}.${i}.${mark.replace(/\W/g, '')}@mail.example.com>`,
        ...(i ? { inReplyTo: `<m${k}.${i - 1}.${mark.replace(/\W/g, '')}@mail.example.com>` } : {}),
        ...(cats[0] === '^smartlabel_promo' ? { listId: `News ${mark} <news.example.com>` } : {}),
        ...(k % 10 === 1 && i === 0 ? { attachment: { name: `plan-${k}.pdf`, mime: 'application/pdf', data: Buffer.from(`%PDF-1.4 ${mark} attachment ${k}`) } } : {}),
        history: 1000,
        // Some sent from the web app: the page's own id in the record, Gmail's at [55].
        ...(mine && k % 3 === 0 ? { localId: true } : {}),
      });
    }
  }
  // Spam, Trash, a draft, and a reply the page holds that Gmail has not taken yet.
  const extra = (k: number, labels: string[], more: Partial<FakeMessage> = {}) => {
    const thread = (THREAD_BASE + BigInt(k) * 100n).toString();
    messages.push({ id: thread, thread, from: { name: `Stranger ${mark}`, email: `s${k}@example.net` }, to: [me], cc: [], subject: `Offer ${k} ${mark}`, body: `Body ${mark} ${k}`, date: now - (k - 899) * 5 * DAY, labels, messageId: `<x${k}.${mark.replace(/\W/g, '')}@mail.example.com>`, history: 1000, ...more });
  };
  extra(900, ['^s']);
  extra(901, ['^s', '^u']);
  extra(902, ['^k']);
  extra(903, ['^k', '^all']);
  extra(904, ['^r', '^all'], { from: me });
  const replied = messages.find((m) => m.thread === (THREAD_BASE + 300n).toString())!;
  messages.push({ ...replied, id: 'r-1234567890', pending: true, labels: ['^all', '^f'], from: me, date: replied.date + 7_200_000, subject: `Re: ${replied.subject}`, messageId: `<pending.${mark.replace(/\W/g, '')}@mail.example.com>` });
  return { me, labels, messages };
}

/** A message as Gmail's "Download message" gives it: RFC 822, multipart/alternative, and mixed when it has an attachment. */
export function fakeEml(m: FakeMessage): string {
  if (m.headerless) return `\r\n${m.body}\r\n`;
  const a = (x: FakeAddress) => (x.name ? `"${x.name}" <${x.email}>` : x.email);
  const head = [
    `From: ${a(m.from)}`,
    `To: ${m.to.map(a).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(a).join(', ')}`] : []),
    `Subject: ${m.subject}`,
    `Date: ${new Date(m.date).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    ...(m.listId ? [`List-Id: ${m.listId}`, `List-Unsubscribe: <https://news.example.com/u/${m.id}>`] : []),
    'MIME-Version: 1.0',
  ];
  const alt = ['--alt-b', 'Content-Type: text/plain; charset=utf-8', '', m.body, '--alt-b', 'Content-Type: text/html; charset=utf-8', '', `<p>${m.body}</p>`, '--alt-b--'];
  if (!m.attachment) return [...head, 'Content-Type: multipart/alternative; boundary="alt-b"', '', ...alt, ''].join('\r\n');
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="mix-b"',
    '',
    '--mix-b',
    'Content-Type: multipart/alternative; boundary="alt-b"',
    '',
    ...alt,
    '--mix-b',
    `Content-Type: ${m.attachment.mime}; name="${m.attachment.name}"`,
    `Content-Disposition: attachment; filename="${m.attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    m.attachment.data.toString('base64'),
    '--mix-b--',
    '',
  ].join('\r\n');
}

/**
 * The fake Gmail behind the sync endpoints: a mailbox, Gmail's search over it, and its answers in the recorded layout.
 * `handle` answers a request to one of the endpoints (null when it is not one of them).
 */
export function fakeGmail(mark: string, opts: { sapisid: string; now?: number } ) {
  const box = fakeMailbox(mark, opts.now ?? Date.now());
  let history = 4_000_000;
  for (const m of box.messages) m.history = history;
  const xsrf = `xsrf-${mark.replace(/\W/g, '')}-token`;
  const ik = '0a1b2c3d4e';
  let layout: 'normal' | 'swapped' = 'normal';
  let bvMode: 'own' | 'page' | 'third' = 'own';
  let block: 'verify' | 'captcha429' | 'signin' | 'blank' | null = null;
  let marksRead = false;
  let trailer: number | null = null;
  const fails: { status: number; count: number }[] = [];
  const delays: { ms: number; count: number }[] = [];
  const calls = { bv: 0, fd: 0, s: 0, raw: 0 };
  const rawFetched: string[] = [];
  let writes = 0;
  const names = () => new Map(box.labels.filter((l) => l.type === 2).map((l) => [l.id, l.name]));
  const visible = () => box.messages;
  const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY';

  // ---- Gmail's search, as far as this fake knows it
  const IN: Record<string, (m: FakeMessage) => boolean> = {
    inbox: (m) => m.labels.includes('^i'),
    sent: (m) => m.labels.includes('^f'),
    drafts: (m) => m.labels.includes('^r'),
    spam: (m) => m.labels.includes('^s'),
    trash: (m) => m.labels.includes('^k'),
    snoozed: (m) => m.labels.includes('^t_z'),
    scheduled: (m) => m.labels.includes('^scheduled'),
    starred: (m) => m.labels.includes('^t'),
    important: (m) => m.labels.includes('^io_im'),
    anywhere: () => true,
  };
  const when = (v: string): number | null => {
    if (/^\d{9,11}$/.test(v)) return Number(v) * 1000;
    const d = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
    return d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime() : null;
  };
  function test(m: FakeMessage, token: string, now: number): boolean {
    const t = /^(-?)([a-z_0-9]+):(.+)$/.exec(token);
    if (!t) {
      const w = token.toLowerCase();
      return [m.subject, m.body, m.from.email, m.from.name ?? ''].some((x) => x.toLowerCase().includes(w));
    }
    const [, neg, op, raw] = t;
    const v = raw!.replace(/^"|"$/g, '');
    let ok = true;
    if (op === 'in') ok = IN[v.toLowerCase()]?.(m) ?? false;
    else if (op === 'is') ok = v === 'unread' ? m.labels.includes('^u') : v === 'read' ? !m.labels.includes('^u') : v === 'starred' ? m.labels.includes('^t') : v === 'important' ? m.labels.includes('^io_im') : false;
    else if (op === 'label') ok = box.labels.some((l) => l.type === 2 && l.name.toLowerCase() === v.toLowerCase() && m.labels.includes(l.id));
    else if (op === 'before' || op === 'after') {
      const at = when(v);
      ok = at === null ? false : op === 'before' ? m.date < at : m.date > at;
    } else if (op === 'newer_than' || op === 'older_than') {
      const d = /^(\d+)d$/.exec(v);
      ok = !!d && (op === 'newer_than' ? m.date > now - Number(d[1]) * DAY : m.date < now - Number(d[1]) * DAY);
    } else if (op === 'category') ok = m.labels.includes({ social: '^smartlabel_social', promotions: '^smartlabel_promo', updates: '^smartlabel_notification', forums: '^smartlabel_group' }[v] ?? '-');
    else if (op === 'has') ok = v === 'attachment' && !!m.attachment;
    else if (op === 'rfc822msgid') ok = m.messageId === `<${v}>`;
    else if (op === 'larger' || op === 'smaller') ok = true;
    else ok = false;
    return neg ? !ok : ok;
  }
  function search(query: string, now: number): { thread: string; date: number }[] {
    const tokens = query.match(/-?[a-z_0-9]+:"[^"]*"|\S+/g) ?? [];
    const bins = tokens.some((t) => /^in:(spam|trash|anywhere)$/.test(t));
    const latest = new Map<string, number>();
    for (const m of visible()) {
      if (!bins && (m.labels.includes('^s') || m.labels.includes('^k'))) continue;
      if (!tokens.every((t) => test(m, t, now))) continue;
      latest.set(m.thread, Math.max(latest.get(m.thread) ?? 0, m.date));
    }
    return [...latest].map(([thread, date]) => ({ thread, date })).sort((a, b) => b.date - a.date);
  }
  const threadOf = (t: string) => visible().filter((m) => m.thread === t).sort((a, b) => a.date - b.date);
  const idOf = (m: FakeMessage) => (m.pending ? `msg-a:${m.id}` : m.localId ? (Number(m.id.slice(-1)) % 2 ? `msg-a:r-${m.id.slice(-9)}` : `msg-a:r${m.id.slice(-9)}.${m.id.slice(-3)}`) : `msg-f:${m.id}`);
  const hex = (dec: string) => BigInt(dec).toString(16).padStart(16, '0');

  // ---- the recorded layout
  /** A message in a thread row: bv's has no recipients; s's has them at 2 (to) and 5 (cc). */
  function msgRec(m: FakeMessage, withRecipients: boolean) {
    const r: unknown[] = Array(31).fill(null);
    r[0] = idOf(m);
    r[1] = [1, m.from.email, m.from.name ?? m.from.email];
    if (withRecipients) {
      r[2] = m.to.map((a) => [1, a.email, a.name ?? a.email]);
      r[5] = m.cc.length ? m.cc.map((a) => [1, a.email, a.name ?? a.email]) : null;
    }
    r[6] = m.date;
    r[9] = m.body.slice(0, 60);
    r[10] = m.labels;
    r[11] = m.attachment ? [[m.attachment.name, m.attachment.mime, m.attachment.data.length, 'pdf', null, `https://mail.example.com/att/${m.id}`, 0, [null, null, B64, null, null, null, null, null, B64], null, null, 1]] : [];
    const details: unknown[] = Array(31).fill(null);
    details[27] = idOf(m);
    r[12] = details;
    r[15] = box.me.email;
    r[17] = m.date;
    r[30] = m.date;
    // Gmail's own id in hex at [55], on every message Gmail has (a pending one has none yet).
    if (!m.pending) r[55] = hex(m.id);
    return r;
  }
  function threadRec(thread: string, date: number, withRecipients: boolean) {
    const ms = threadOf(thread);
    const r: unknown[] = Array(25).fill(null);
    r[0] = ms[0]!.subject;
    r[1] = ms.at(-1)!.body.slice(0, 60);
    r[2] = date;
    r[3] = `thread-f:${thread}`;
    r[4] = ms.map((m) => msgRec(m, withRecipients));
    r[7] = date;
    r[14] = [...new Map(ms.map((m) => [m.from.email, [m.from.name ?? '', m.from.email]])).values()];
    r[16] = 0;
    r[18] = ms.length;
    r[19] = hex(thread);
    r[24] = [[0], 'ab', 'cd'];
    if (layout === 'swapped') [r[2], r[3]] = [r[3], r[2]];
    return r;
  }
  const counts = () => {
    const out: unknown[] = [];
    for (const l of box.labels) {
      const ms = visible().filter((m) => !m.pending && m.labels.includes(l.id));
      const unread = ms.filter((m) => m.labels.includes('^u')).length;
      // As the live counts for your labels: some give no total (0).
      out.push([l.id, unread, l.id === '^x_2' ? 0 : ms.length]);
    }
    return [out];
  };

  /** The label list as s and bv (own layout) carry it: [[id, name, …, (17) type, …, (27) type], n]. */
  const labelEntries = () =>
    box.labels.map((l) => {
      const d: unknown[] = Array(28).fill(null);
      Object.assign(d, { 0: l.id, 1: l.name, 6: 1, 17: l.type, 20: 1, 23: 1, 24: 0, 27: l.type });
      return [d, 54321];
    });
  function bv(body: any, now: number) {
    const query = String(body?.[0]?.[3] ?? '');
    const size = Number(body?.[0]?.[1]) || 50;
    const found = search(query, now);
    const page = found.slice(0, size);
    const rows = page.map((t) => [threadRec(t.thread, t.date, false), 123456789]);
    if (bvMode === 'page') return [0, null, null, 1, found.length, 1, null, null, null, null, null, [1, size], null, [null, [0, 0], null, null, 'view one', null, null, [[2], [7, null, null, [null, null, 1]], [3], [1], [10]], B64, B64], null, null, null, null, [trailer ?? history], [[2, rows, 1, [['x'], page.map((t) => threadOf(t.thread).map(idOf))]]]];
    // As the live Gmail answers the extractor's own calls: labels, rows, counts (one entry with its id alone), the sync point.
    const own: unknown[] = Array(19).fill(null);
    Object.assign(own, { 0: 0, 1: labelEntries(), 2: rows, 3: 1, 4: found.length, 5: 1, 6: [[...(counts()[0] as unknown[]), ['^afw']]], 11: [1, size], 18: [trailer ?? history] });
    if (bvMode === 'third') [own[2], own[3]] = [null, rows];
    return own;
  }
  function fd(body: any) {
    const ids: string[] = (Array.isArray(body?.[0]) ? body[0] : []).map((e: any) => String(e?.[0] ?? '').replace(/^thread-f:/, ''));
    const entries = ids.map((t) => {
      const ms = threadOf(t);
      if (!ms.length) return [`thread-f:${t}`, null, [], null, 0];
      const meta: unknown[] = Array(21).fill(null);
      Object.assign(meta, { 0: `thread-f:${t}`, 1: ms[0]!.subject, 2: ms.at(-1)!.body.slice(0, 60), 3: ms.at(-1)!.date, 9: 77777, 12: 0, 15: hex(t), 20: [[0], 'a', 'b'] });
      const summaries = ms.map((m) => {
        const r: unknown[] = Array(40).fill(null);
        Object.assign(r, { 0: idOf(m), 1: [1, m.from.email, m.from.name ?? m.from.email], 2: m.date, 3: m.labels, 6: m.date, 10: m.body.slice(0, 60), 15: m.date, 27: hex(m.id.replace(/\D/g, '') || '0') });
        return r;
      });
      const fulls = ms.map((m) => [idOf(m), [[[1, m.to[0]!.email]], null, null, [[1, m.from.email, m.from.name ?? '']], m.subject, [null, [[0, null, [null, `<p>${m.body}</p>`], 99]]], m.from.email, m.from.email]]);
      return [`thread-f:${t}`, [meta, summaries], fulls, null, 98765];
    });
    return [0, entries, null, null, [history]];
  }
  function sAnswer(body: any) {
    const from = Number(body?.[3]?.[4]);
    const changed = [...new Set(visible().filter((m) => m.history > from).map((m) => m.thread))];
    const updates = changed.map((t) => {
      const ms = threadOf(t);
      return [[`thread-f:${t}`, null, [null, null, null, null, null, null, [threadRec(t, ms.at(-1)!.date, true), 7777]]]];
    });
    return [null, [0, null, labelEntries(), null, ['1', '2'], updates, 1, history, null, null, '3'], counts(), [history]];
  }

  function authorized(req: Request, needXsrf: boolean): boolean {
    const sapisid = (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)SAPISID=([^;]*)/)?.[1];
    return sapisid === opts.sapisid && (!needXsrf || req.headers.get('x-framework-xsrf-token') === xsrf);
  }
  const xssi = (body: unknown, status = 200) => new Response(`)]}'\n${JSON.stringify(body)}`, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const html = (text: string, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  /** Gmail turning on a reader, as far as this fake guesses it: a verification page, a 429 naming a captcha, a sign-in page. */
  function blocked(): Response | null {
    if (block === 'verify') return html("<!doctype html><html><body><h1>Verify it's you</h1><p>We noticed unusual activity in your account.</p></body></html>");
    if (block === 'captcha429') return new Response('<html><body>Our systems have detected unusual traffic. Please solve the CAPTCHA.</body></html>', { status: 429, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (block === 'signin') return html('<!doctype html><html><body><form action="https://accounts.google.com/ServiceLogin">Sign in to continue to Gmail</form></body></html>');
    if (block === 'blank') return html('<!doctype html><html><body><p>Something else</p></body></html>');
    return null;
  }
  /** The next call fails or waits, if asked to (failNext, delayNext). */
  async function trouble(): Promise<Response | null> {
    const d = delays[0];
    if (d) {
      if (--d.count <= 0) delays.shift();
      await Bun.sleep(d.ms);
    }
    const f = fails[0];
    if (f) {
      if (--f.count <= 0) fails.shift();
      return xssi([['er', f.status]], f.status);
    }
    return null;
  }

  /** The endpoints: bv, fd and s with the recorded layout's bodies (not the stand-in app's older ones), and the download route. */
  async function handle(req: Request, url: URL): Promise<Response | null> {
    const now = Date.now();
    const m = url.pathname.match(/^\/sync\/u\/0\/i\/(bv|fd|s)$/);
    if (req.method === 'POST' && m) {
      const text = await req.clone().text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        return null;
      }
      const ep = m[1] as 'bv' | 'fd' | 's';
      // The stand-in app's own older bodies: [['^i', 50, …], …] and [[thread, subject], 2].
      if (ep === 'bv' && typeof body?.[0]?.[0] !== 'number') return null;
      if (ep === 'fd' && !Array.isArray(body?.[0]?.[0])) return null;
      if (!authorized(req, true)) return xssi([['er', 403]], 403);
      calls[ep]++;
      const no = blocked() ?? (await trouble());
      if (no) return no;
      if (ep === 'bv') return xssi(bv(body, now));
      if (ep === 'fd') return xssi(fd(body));
      if (body?.[1] !== null && body?.[1] !== undefined) {
        writes++;
        return xssi([['er', 400]], 400);
      }
      return xssi(sAnswer(body));
    }
    if (req.method === 'GET' && url.pathname === '/mail/u/0/' && url.searchParams.get('view') === 'att') {
      if (!authorized(req, false) || url.searchParams.get('ik') !== ik) return new Response('<html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      calls.raw++;
      const no = blocked() ?? (await trouble());
      if (no) return no;
      const th = url.searchParams.get('th') ?? '';
      const dec = /^[0-9a-f]{1,16}$/.test(th) ? BigInt(`0x${th}`).toString() : '';
      const msg = visible().find((x) => !x.pending && x.id === dec);
      if (!msg) return new Response('not found', { status: 404 });
      rawFetched.push(msg.id);
      if (marksRead && msg.labels.includes('^u')) {
        msg.labels = msg.labels.filter((l) => l !== '^u');
        bump(msg);
      }
      return new Response(fakeEml(msg), { headers: { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="original_msg.eml"` } });
    }
    if (req.method === 'POST' && url.pathname === '/mail/u/0/') return xssi([[['v', null, '1']], '0123456789abcdef']);
    return null;
  }

  const bump = (m: FakeMessage) => {
    m.history = ++history;
  };
  return {
    handle,
    xsrf,
    ik,
    me: box.me,
    labels: box.labels,
    messages: box.messages,
    names,
    calls,
    rawFetched,
    get writes() {
      return writes;
    },
    history: () => history,
    layout(mode: 'normal' | 'swapped') {
      layout = mode;
    },
    /** Which bv layout it answers in: 'own' (the default, as live), 'page' (as recorded from the page), 'third' (rows elsewhere). */
    bvLayout(mode: 'own' | 'page' | 'third') {
      bvMode = mode;
    },
    /** Every sync call and download answers with a verification page, a captcha 429 or a sign-in page; null: as usual. */
    challenge(mode: 'verify' | 'captcha429' | 'signin' | 'blank' | null) {
      block = mode;
    },
    /** The next `count` sync calls or downloads answer `status`. */
    failNext(status: number, count = 1) {
      fails.push({ status, count });
    },
    /** The next `count` sync calls or downloads answer only after `ms`. */
    delayNext(ms: number, count = 1) {
      delays.push({ ms, count });
    },
    /** bv answers end with this number instead of the sync point (null: the sync point again). */
    bvTrailer(n: number | null) {
      trailer = n;
    },
    /** A download takes ^u off the message (Gmail marking it read), or not. */
    readsMarkRead(on: boolean) {
      marksRead = on;
    },
    /** A new message, as if it arrived (in the inbox, unread, unless given labels). */
    arrive(m: Partial<FakeMessage> & { subject: string }) {
      const id = (BigInt(box.messages.filter((x) => !x.pending).map((x) => BigInt(x.id)).reduce((a, b) => (a > b ? a : b))) + 1000n).toString();
      const msg: FakeMessage = { id, thread: id, from: { name: `Newcomer ${mark}`, email: `new.${mark.replace(/\W/g, '')}@example.net` }, to: [box.me], cc: [], body: `New ${mark}`, date: Date.now(), labels: ['^all', '^i', '^u', '^smartlabel_personal', '^sq_ig_i_personal'], messageId: `<new${id}@mail.example.com>`, history: 0, ...m };
      box.messages.push(msg);
      bump(msg);
      return msg;
    },
    /** Labels added to and taken off a message, as Gmail's own app would. */
    relabel(id: string, add: string[], remove: string[]) {
      const msg = box.messages.find((x) => x.id === id)!;
      msg.labels = [...msg.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !msg.labels.includes(l))];
      bump(msg);
    },
  };
}
export type FakeGmail = ReturnType<typeof fakeGmail>;

/** The stand-in Gmail app's thread list: unread and uncertain rows first, then read ones (fake-gmail-page.js). */
export const GMAIL_ROWS = [
  { t: 'thread-f:1800000000000000001', k: 'FMfcgA1', cls: 'zA zE' }, // unread
  { t: 'thread-f:1800000000000000002', k: 'FMfcgA2', cls: 'zA zE' }, // unread
  { t: 'thread-f:1800000000000000003', k: 'FMfcgA3', cls: 'zA' }, // neither marker: uncertain
  { t: 'thread-f:1800000000000000004', k: 'FMfcgA4', cls: 'zA yO', sender: 'zF' }, // read, but an unread sender: uncertain
  { t: 'thread-f:1800000000000000005', k: 'FMfcgA5', cls: 'zA yO', bold: true }, // read, but drawn bold: uncertain
  { t: 'thread-f:1800000000000000006', k: 'FMfcgA6', cls: 'zA yO' }, // read: the first
  { t: 'thread-f:1800000000000000007', k: 'FMfcgA7', cls: 'zA zE yO' }, // both markers: unread
  { t: 'thread-f:1800000000000000008', k: 'FMfcgA8', cls: 'zA yO' }, // read: the second
];

export type FakePage = 'calendar' | 'gmail';
/** on: API calls hang until stall(page, 'off'); until-reload: until the page (authuser 0) is loaded again. */
export type Stall = 'off' | 'on' | 'until-reload';

export function startFakeGoogle(opts: { web?: WebOpts } = {}) {
  const web = opts.web;
  /** Keys the API takes (web): the page's own, until a test changes it. */
  let keys = web ? [web.pageKey] : [];
  let seq = 1;
  let n = 0;
  const calendars = new Map<string, FakeCalendar>();
  const events = new Map<string, Map<string, Ev>>();
  const validFrom = new Map<string, number>();
  const codes = new Map<string, { challenge: string; redirectUri: string; email: string; scope: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Map<string, number>();
  const calls: string[] = [];
  const failures: { status: number; count: number; retryAfter?: number; match?: string }[] = [];
  let pageSize = 2500;
  let tokenRequests: string[] = [];
  const mailCalls: string[] = [];
  const mailOpened: string[] = [];
  const stalls: Record<FakePage, Stall> = { calendar: 'off', gmail: 'off' };
  const held: Record<FakePage, (() => void)[]> = { calendar: [], gmail: [] };
  const loads = new Map<string, number>();
  const loaded = (page: FakePage, authuser: string) => {
    const k = `${page}:${authuser}`;
    loads.set(k, (loads.get(k) ?? 0) + 1);
    if (authuser === '0' && stalls[page] === 'until-reload') release(page);
  };
  /** A call to a stalled page's API waits here (and then goes on as usual once released). */
  const hold = (page: FakePage) => (stalls[page] === 'off' ? null : new Promise<void>((r) => held[page].push(r)));
  function release(page: FakePage) {
    stalls[page] = 'off';
    for (const r of held[page].splice(0)) r();
  }

  const evs = (cal: string) => events.get(cal) ?? events.set(cal, new Map()).get(cal)!;
  const err = (status: number, message: string, reason?: string) => Response.json({ error: { code: status, message, errors: reason ? [{ reason }] : [] } }, { status });
  const strip = (e: Ev) => {
    const { seq: _s, ...rest } = e;
    return rest;
  };
  const touch = (e: Ev) => {
    e.seq = ++seq;
    e.etag = `"${e.seq}"`;
    e.updated = new Date().toISOString();
    return e;
  };
  const jwt = (payload: unknown) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

  /** Google's instance id suffix back to the original start. */
  function originalFromSuffix(master: Ev, suffix: string) {
    if (master.start?.date) return { date: `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}` };
    const m = suffix.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)!;
    return { dateTime: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString(), timeZone: master.start?.timeZone };
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // Long enough that a stalled call hangs past the extractor's 25 s instead of being cut at Bun's 10 s.
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      calls.push(`${req.method} ${path}${url.search}`);

      if (path === '/token' && req.method === 'POST') {
        const f = new URLSearchParams(await req.text());
        tokenRequests.push(f.get('grant_type') ?? '');
        if (f.get('client_id') !== CLIENT.clientId || f.get('client_secret') !== CLIENT.clientSecret) return Response.json({ error: 'invalid_client' }, { status: 401 });
        const issue = (refresh?: string, email?: string, scope = 'https://www.googleapis.com/auth/calendar openid email') => {
          const access = `at-${++n}`;
          accessTokens.set(access, Date.now() + 3600_000);
          return Response.json({ access_token: access, expires_in: 3600, token_type: 'Bearer', scope, ...(refresh ? { refresh_token: refresh } : {}), ...(email ? { id_token: jwt({ email, sub: `sub-${email}` }) } : {}) });
        };
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '');
          codes.delete(f.get('code') ?? '');
          if (!c || c.redirectUri !== f.get('redirect_uri')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
          if (challenge !== c.challenge) return Response.json({ error: 'invalid_grant', error_description: 'PKCE' }, { status: 400 });
          const refresh = `rt-${++n}`;
          refreshTokens.add(refresh);
          return issue(refresh, c.email, c.scope);
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (!refreshTokens.has(f.get('refresh_token') ?? '')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return issue();
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }
      if (path === '/revoke' && req.method === 'POST') {
        const f = new URLSearchParams(await req.text());
        refreshTokens.delete(f.get('token') ?? '');
        return new Response(null, { status: 200 });
      }

      let m: RegExpMatchArray | null;
      if (web && req.method === 'GET' && (m = path.match(/^\/calendar\/u\/(\d+)\/r$/))) {
        loaded('calendar', m[1]!);
        return calendarPage(m[1] === '0');
      }
      if (web) {
        // A page that stopped answering, as far as the extractor can tell: its API calls do not come back.
        const h = path.startsWith('/calendar/v3/') ? hold('calendar') : null;
        if (h) await h;
        const refused = webAuth(req, url);
        if (refused) return refused;
      } else {
        const auth = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
        const exp = accessTokens.get(auth);
        if (!exp || exp < Date.now()) return err(401, 'Invalid Credentials', 'authError');
      }
      const fail = failures.find((f) => !f.match || `${req.method} ${path}`.includes(f.match));
      if (fail) {
        if (--fail.count <= 0) failures.splice(failures.indexOf(fail), 1);
        const r = err(fail.status, 'Backend Error', fail.status === 429 ? 'rateLimitExceeded' : 'backendError');
        if (fail.retryAfter !== undefined) r.headers.set('retry-after', String(fail.retryAfter));
        return r;
      }
      const body = req.method === 'POST' || req.method === 'PATCH' ? ((await req.json()) as any) : null;

      if (path === '/calendar/v3/users/me/calendarList' && req.method === 'GET') {
        const all = [...calendars.values()];
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        const size = Math.min(Number(url.searchParams.get('maxResults') ?? 100), pageSize);
        const items = all.slice(start, start + size).map((c) => ({ kind: 'calendar#calendarListEntry', ...c }));
        return Response.json({ items, ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
      }
      if ((m = path.match(/^\/calendar\/v3\/users\/me\/calendarList\/([^/]+)$/)) && req.method === 'PATCH') {
        const c = calendars.get(decodeURIComponent(m[1]));
        if (!c) return err(404, 'Not Found', 'notFound');
        Object.assign(c, body);
        return Response.json(c);
      }
      if (path === '/calendar/v3/calendars' && req.method === 'POST') {
        const id = `c${++n}@group.calendar.google.com`;
        calendars.set(id, { id, summary: body.summary, timeZone: body.timeZone ?? 'UTC', accessRole: 'owner', selected: true, backgroundColor: '#9fe1e7' });
        return Response.json({ kind: 'calendar#calendar', id, summary: body.summary, timeZone: body.timeZone ?? 'UTC' });
      }
      if ((m = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/))) {
        const cal = decodeURIComponent(m[1]);
        if (!calendars.has(cal)) return err(404, 'Not Found', 'notFound');
        const id = m[2] ? decodeURIComponent(m[2]) : null;
        const list = evs(cal);
        if (!id && req.method === 'GET') {
          const token = url.searchParams.get('syncToken');
          let items: Ev[];
          if (token) {
            const since = Number(token.split(':')[2]);
            if (!Number.isFinite(since) || since < (validFrom.get(cal) ?? 0)) return err(410, 'Sync token is no longer valid, a full sync is required.', 'fullSyncRequired');
            items = [...list.values()].filter((e) => e.seq > since);
          } else items = [...list.values()].filter((e) => e.status !== 'cancelled' || e.recurringEventId);
          items.sort((a, b) => a.seq - b.seq);
          const start = Number(url.searchParams.get('pageToken') ?? 0);
          const size = Math.min(Number(url.searchParams.get('maxResults') ?? 250), pageSize);
          const page = items.slice(start, start + size).map(strip);
          const more = start + size < items.length;
          return Response.json({ kind: 'calendar#events', items: page, ...(more ? { nextPageToken: String(start + size) } : { nextSyncToken: `t:${cal}:${seq}` }) });
        }
        if (!id && req.method === 'POST') {
          const e = touch({ ...body, id: `e${++n}`, status: body.status ?? 'confirmed', iCalUID: `e${n}@google.com`, htmlLink: `https://calendar.google.com/event?eid=e${n}` } as Ev);
          list.set(e.id, e);
          return Response.json(strip(e));
        }
        if (id && req.method === 'PATCH') {
          let e = list.get(id);
          if (!e) {
            // An instance of a series that has not been changed before.
            const under = id.lastIndexOf('_');
            const master = under > 0 ? list.get(id.slice(0, under)) : undefined;
            if (!master?.recurrence) return err(404, 'Not Found', 'notFound');
            const original = originalFromSuffix(master, id.slice(under + 1));
            e = { id, seq: 0, recurringEventId: master.id, originalStartTime: original, summary: master.summary, start: original, end: master.end, status: 'confirmed', iCalUID: master.iCalUID };
            list.set(id, e);
          }
          if (e.status === 'cancelled' && !e.recurringEventId && body.status !== 'confirmed') return err(410, 'Resource has been deleted', 'deleted');
          for (const [k, v] of Object.entries(body)) {
            if (v === null) delete e[k];
            else if (k === 'extendedProperties') e[k] = { private: { ...(e[k]?.private ?? {}), ...((v as any).private ?? {}) } };
            else e[k] = v;
          }
          touch(e);
          return Response.json(strip(e));
        }
        if (id && req.method === 'DELETE') {
          let e = list.get(id);
          if (!e) {
            const under = id.lastIndexOf('_');
            const master = under > 0 ? list.get(id.slice(0, under)) : undefined;
            if (!master?.recurrence) return err(404, 'Not Found', 'notFound');
            e = { id, seq: 0, recurringEventId: master.id, originalStartTime: originalFromSuffix(master, id.slice(under + 1)), status: 'confirmed' };
            list.set(id, e);
          }
          if (e.status === 'cancelled') return err(410, 'Resource has been deleted', 'deleted');
          e.status = 'cancelled';
          touch(e);
          return new Response(null, { status: 204 });
        }
      }
      return err(404, `fake google: no ${req.method} ${path}`);
    },
  });

  const base = `http://127.0.0.1:${server.port}`;

  const mail = {
    key: web?.mailKey ?? `AIza${'M'.repeat(35)}`,
    email: web?.mailEmail ?? 'mail-owner@example.com',
    labels: web?.labels ?? ['INBOX', 'secret-label-name', 'another-label'],
    mark: web?.mailMark ?? 'Mk#0000',
  };
  /** The Gmail mailbox behind the sync endpoints and the download route. */
  const gmail = web ? fakeGmail(mail.mark, { sapisid: web.sapisid }) : null;

  /** A thread as the stand-in's /sync answers carry it: positional, anchors up front, the marker everywhere else. */
  const syncThread = (t: string, i: number) => {
    const k = mail.mark;
    const msg = [
      `msg-f:18000000000000001${i}`,
      [
        ['Subject', `Re: ${k} plans`],
        ['From', `${k} Person <${k}@example.com>`],
        ['Message-ID', `<${k}.${i}@mail.example.com>`],
        ['X-Gmail-Labels', `^i,${k}`],
      ],
      `Hello ${k}, the snippet of the mail`,
      1731300000000 + i,
    ];
    return [t, [msg, ['^all', '^i', `Label ${k}`, '^smartlabel_personal']], i % 2 === 0, ['0123456789abcdef', '2026-11-11T10:00:00Z', `https://example.com/${k}`, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY']];
  };
  const xssi = (body: unknown) => new Response(`)]}'\n${JSON.stringify(body)}`, { headers: { 'content-type': 'application/json; charset=utf-8' } });

  /** The Gmail side, on an origin of its own (another port): its page and the Gmail API it calls. */
  const mailServer = web
    ? Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 120,
        async fetch(req) {
          const url = new URL(req.url);
          const path = url.pathname;
          mailCalls.push(`${req.method} ${path}${url.search}`);
          let m: RegExpMatchArray | null;
          // The fake Gmail's own endpoints (bv, fd, s in the recorded layout, the download route), before the page.
          const answer = await gmail!.handle(req, url);
          if (answer) return answer;
          if (req.method === 'GET' && (m = path.match(/^\/mail\/u\/(\d+)\/$/))) {
            loaded('gmail', m[1]!);
            return mailPage(m[1] === '0');
          }
          // The stand-in Gmail app and its calls to its own origin.
          if (req.method === 'GET' && path === '/_/fake/gmail.js') return new Response(Bun.file(join(import.meta.dir, 'fake-gmail-page.js')), { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
          if (req.method === 'POST' && path === '/sync/u/0/i/bv') {
            await req.text();
            return xssi([['tl', GMAIL_ROWS.slice(0, 3).map((r, i) => syncThread(r.t, i)), '^i', GMAIL_ROWS.length], 1731300000000, { total: GMAIL_ROWS.length, [`${mail.mark}@example.com`]: 1 }, `${mail.mark} next page`]);
          }
          if (req.method === 'POST' && path === '/sync/u/0/i/fd') {
            const body = await req.json().catch(() => null);
            const t = Array.isArray(body?.[0]) && typeof body[0][0] === 'string' ? body[0][0] : '?';
            mailOpened.push(t);
            return xssi([syncThread(t, 9), 1731300000, `<div dir="ltr">Dear ${mail.mark}, the body of the mail</div>`, 'Tue, 11 Nov 2026 10:00:00 +0000']);
          }
          if (req.method === 'GET' && /^\/mail\/u\/0\/x\/[\w]+\/$/.test(path)) return new Response(`<html><body>${mail.mark}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          if (req.method === 'GET' && (m = path.match(/^\/gmail\/v1\/users\/me\/(profile|labels)$/))) {
            const h = hold('gmail');
            if (h) await h;
            const refused = gmailAuth(req, url);
            if (refused) return refused;
            if (m[1] === 'profile') return Response.json({ emailAddress: mail.email, messagesTotal: 1234, threadsTotal: 987, historyId: '424242' });
            return Response.json({ labels: mail.labels.map((name, i) => ({ id: i ? `Label_${i}` : 'INBOX', name, type: i ? 'user' : 'system' })) });
          }
          return err(404, `fake gmail: no ${req.method} ${path}`);
        },
      })
    : null;
  const mailBase = mailServer ? `http://127.0.0.1:${mailServer.port}` : '';

  /** The stand-in Gmail page: the same cookie as Calendar's for authuser 0, the account button, a key in its HTML. */
  function mailPage(signedIn: boolean) {
    const w = web!;
    const html = `<!doctype html><html><head><title>Gmail</title>
<script>window.__gm = { k: "${mail.key}" };</script></head>
<body><header>${signedIn ? `<a href="#" aria-label="Google Account: Pat Example&#10;(${w.email})">P</a>` : '<a href="#">Sign in</a>'}</header>
<main><div class="subject">secret-subject-line</div></main>${
      signedIn
        ? `<style>tr.zA.zE .yW, tr.zA.zE .y6 { font-weight: bold } body.thread table { display: none }</style>
<div role="main"><table><tbody id="list"></tbody></table></div>
<script>window.__fakeGmail = ${JSON.stringify({ mark: mail.mark, rows: GMAIL_ROWS, xsrf: gmail!.xsrf, ik: gmail!.ik, history: gmail!.history() }).replace(/</g, '\\u003c')};</script>
<script src="/_/fake/gmail.js"></script>`
        : ''
    }</body></html>`;
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    if (signedIn) headers.append('set-cookie', `SAPISID=${w.sapisid}; Path=/; SameSite=Lax`);
    return new Response(html, { headers });
  }

  /**
   * The Gmail API's check of a browser call, as far as this fake guesses it: a key (none is refused, as an
   * unregistered caller), the cookie, and SAPISIDHASH made with the Gmail page's origin; a _u hash is refused.
   */
  function gmailAuth(req: Request, url: URL): Response | null {
    const gerr = (status: number, gstatus: string, reason: string, message: string) => Response.json({ error: { code: status, message, errors: [{ message, domain: 'global', reason }], status: gstatus } }, { status });
    const key = url.searchParams.get('key');
    if (!key) return gerr(403, 'PERMISSION_DENIED', 'forbidden', "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.");
    if (key !== mail.key) return gerr(400, 'INVALID_ARGUMENT', 'badRequest', 'API key not valid. Please pass a valid API key.');
    const sapisid = (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)SAPISID=([^;]*)/)?.[1];
    if (!sapisid) return gerr(401, 'UNAUTHENTICATED', 'required', 'Request is missing required authentication credential.');
    const origin = req.headers.get('origin') ?? (req.headers.get('referer') ? new URL(req.headers.get('referer')!).origin : null);
    const hash = (req.headers.get('authorization') ?? '').match(/^SAPISIDHASH (\d+)_([0-9a-f]{40})(?:\s|$)/);
    const fresh = !!hash && Math.abs(Date.now() / 1000 - Number(hash[1])) < 300;
    const want = hash ? createHash('sha1').update(`${hash[1]} ${sapisid} ${mailBase}`).digest('hex') : '';
    if (origin !== mailBase || !fresh || hash![2] !== want || req.headers.get('x-goog-authuser') !== '0') return gerr(401, 'UNAUTHENTICATED', 'authError', 'Request had invalid authentication credentials.');
    return null;
  }

  /** The stand-in Calendar page. Signed in: the cookie, the account button, and two calls of its own made as the real
   * page's look (a key, a SAPISIDHASH ending in _u, a body), then a query and hash in the address. */
  function calendarPage(signedIn: boolean) {
    const w = web!;
    const auth = 'SAPISIDHASH 1700000000_0123456789abcdef0123456789abcdef01234567_u';
    const html = `<!doctype html><html><head><title>Google Calendar</title>
<script>window.__boot = { apiKey: "${w.htmlKey}", other: "${w.pageKey}" };</script></head>
<body><header>${signedIn ? `<a href="#" aria-label="Google Account: Pat Example&#10;(${w.email})">P</a>` : '<a href="#">Sign in</a>'}</header>
<script>
setTimeout(() => {
  fetch('/calendar/v3/users/me/calendarList?maxResults=1&key=${w.pageKey}', { headers: { Authorization: '${auth}' } }).catch(() => {});
  const x = new XMLHttpRequest();
  x.open('POST', '/calendar/v3/calendars/' + encodeURIComponent('someone@example.com') + '/events?key=${w.pageKey}');
  x.setRequestHeader('Authorization', '${auth}');
  x.setRequestHeader('Content-Type', 'application/json');
  x.send(JSON.stringify({ summary: 'page-own-secret-body' }));
  history.replaceState(null, '', location.pathname + '?tab=secret-query#secret-hash');
}, 200);
</script></body></html>`;
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    if (signedIn) headers.append('set-cookie', `SAPISID=${w.sapisid}; Path=/; SameSite=Lax`);
    return new Response(html, { headers });
  }

  /** The API's check of a browser call: the key, the cookie, and SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> <origin>")>. */
  function webAuth(req: Request, url: URL): Response | null {
    if (!keys.includes(url.searchParams.get('key') ?? '')) return err(403, 'Requests from this referer are blocked.', 'forbidden');
    const sapisid = (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)SAPISID=([^;]*)/)?.[1];
    if (!sapisid) return err(401, 'Request is missing required authentication credential.', 'required');
    // As Google: X-Origin means the call came through its proxy iframe, so the Origin must be the API's own host.
    if (req.headers.get('x-origin') && req.headers.get('origin') !== url.origin) return err(400, "Bad request: Origin doesn't match Host for XD3.", 'badRequest');
    // A cross-site call carries Origin; the tests' page is on the API's own origin, where a GET carries only Referer.
    const origin = req.headers.get('origin') ?? (req.headers.get('referer') ? new URL(req.headers.get('referer')!).origin : null);
    const hash = (req.headers.get('authorization') ?? '').match(/^SAPISIDHASH (\d+)_([0-9a-f]{40})(?:\s|$)/);
    const fresh = !!hash && Math.abs(Date.now() / 1000 - Number(hash[1])) < 300;
    const want = hash ? createHash('sha1').update(`${hash[1]} ${sapisid} ${origin}`).digest('hex') : '';
    if (origin !== base || !fresh || hash![2] !== want || req.headers.get('x-goog-authuser') !== '0') return err(401, 'Request had invalid authentication credentials.', 'authError');
    return null;
  }

  return {
    url: base,
    opts: { apiBase: base, oauthUrl: `${base}/auth`, tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke` },
    /** What the provider and extractor read to reach this fake instead of Google. */
    env: { DITHER_GOOGLE_API: base, DITHER_GOOGLE_OAUTH_URL: `${base}/auth`, DITHER_GOOGLE_TOKEN_URL: `${base}/token`, DITHER_GOOGLE_REVOKE_URL: `${base}/revoke`, DITHER_GOOGLE_BACKOFF_MS: '1' },
    /** Refresh tokens Google still honours. */
    get refreshTokens() {
      return [...refreshTokens];
    },
    calls,
    get tokenRequests() {
      return tokenRequests;
    },
    stop: () => {
      release('calendar');
      release('gmail');
      server.stop(true);
      mailServer?.stop(true);
    },
    /** web: the Gmail side's origin, and the calls made to it. */
    mailUrl: mailBase,
    mailCalls,
    /** The threads the stand-in Gmail app opened (each row click fetches its thread). */
    mailOpened,
    /** web: the fake Gmail mailbox behind the sync endpoints. */
    gmail: gmail!,
    /** A page's API calls hang (on, until-reload) or answer again (off; the held ones go on). */
    stall(page: FakePage, mode: Stall) {
      if (mode === 'off') release(page);
      else stalls[page] = mode;
    },
    /** How many of a page's API calls are hanging now. */
    held: (page: FakePage) => held[page].length,
    /** How many times a page was loaded, for an authuser. */
    pageLoads: (page: FakePage, authuser: number | string) => loads.get(`${page}:${authuser}`) ?? 0,
    addCalendar(c: FakeCalendar) {
      calendars.set(c.id, c);
    },
    removeCalendar(id: string) {
      calendars.delete(id);
    },
    calendar: (id: string) => calendars.get(id),
    /** As if made or changed in Google's own app. */
    put(cal: string, e: Record<string, any> & { id: string }) {
      const list = evs(cal);
      const cur = list.get(e.id);
      const next = touch({ status: 'confirmed', iCalUID: `${e.id}@google.com`, htmlLink: `https://calendar.google.com/event?eid=${e.id}`, ...(cur ?? {}), ...e, seq: 0 } as Ev);
      list.set(e.id, next);
      return strip(next);
    },
    remove(cal: string, id: string) {
      const e = evs(cal).get(id);
      if (e) touch(Object.assign(e, { status: 'cancelled' }));
    },
    event: (cal: string, id: string) => {
      const e = evs(cal).get(id);
      return e ? strip(e) : undefined;
    },
    events: (cal: string) => [...evs(cal).values()].map(strip),
    /** Sync tokens issued so far stop working (410). */
    invalidate(cal: string) {
      validFrom.set(cal, seq + 1);
    },
    expireAccessTokens() {
      for (const k of accessTokens.keys()) accessTokens.set(k, 0);
    },
    revokeAll() {
      refreshTokens.clear();
      for (const k of accessTokens.keys()) accessTokens.set(k, 0);
    },
    /** The next `count` calls (whose "METHOD /path" contains `match`, when given) fail with `status`. */
    failNext(status: number, count = 1, retryAfter?: number, match?: string) {
      failures.push({ status, count, retryAfter, match });
    },
    setPageSize(size: number) {
      pageSize = size;
    },
    /** web: the API keys it takes from now on. */
    setKeys(k: string[]) {
      keys = k;
    },
    /** The consent screen: what Google does when the user says yes. */
    authorize(consentUrl: string, email: string) {
      const p = new URL(consentUrl).searchParams;
      const code = `code-${++n}`;
      codes.set(code, { challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')!, email, scope: p.get('scope') ?? '' });
      return { code, state: p.get('state')! };
    },
  };
}

export type FakeGoogle = ReturnType<typeof startFakeGoogle>;
