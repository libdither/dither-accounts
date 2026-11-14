/**
 * Gmail mail (extractors/google/src/gmail/): the protocol module's bodies against the shapes recorded on the
 * live page, its readers and fingerprints, the category rule, and GmailMail end to end against the fake Gmail's sync
 * endpoints (test/fake-google.ts), reached as the Gmail tab's hook reaches them (the page's cookie, its XSRF header,
 * its account key). The browser side, through the manager and a real Chromium, is in google-browser.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MailSummary } from '@dither-accounts/interfaces';
import { type BackgroundRules, GmailMail, parseState, type Transport } from '../extractors/google/src/gmail/mail.ts';
import { parseMessage } from '../extractors/google/src/gmail/mime.ts';
import { bvRequest, categoryOf, fdThreadsRequest, flagsOf, isUserLabel, LayoutError, labelsOf, notAMessage, operatorsOnly, parseBv, parseFd, parseS, readOnlySync, sRequest } from '../extractors/google/src/gmail/protocol.ts';
import { checkOutgoing } from '../extractors/google/src/gmail/send.ts';
import { selfCheck } from '../extractors/google/src/gmail/selfcheck.ts';
import { EDITS, htmlOfText, intoLabel, labelChange, messageRecord, uploadMeta, writeRequest } from '../extractors/google/src/gmail/write.ts';
import { pageKind, shape } from '../extractors/google/src/gmail-learn.js';
import { type FakeGoogle, type FakeMessage, fakeEml, startFakeGoogle } from './fake-google.ts';

const MARK = 'Mk#5512';
const SAPISID = 'sapisid-for-gmail-mail';
const DAY = 86_400_000;
let fake: FakeGoogle;
let tmp: string;

beforeAll(() => {
  fake = startFakeGoogle({ web: { sapisid: SAPISID, pageKey: `AIza${'P'.repeat(35)}`, htmlKey: `AIza${'H'.repeat(35)}`, email: 'pat@example.com', mailMark: MARK } });
  tmp = mkdtempSync(join(tmpdir(), 'dacc-gmail-'));
});
afterAll(() => {
  fake?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * The Gmail tab's hook, as far as GmailMail sees it: straight to the fake, with the page's cookie, XSRF header and key.
 * As the hook, an answer that is not mail goes up only as what it reads as (pageKind), never its text.
 */
function transport(o: { calls?: { ep: string; at: number; hex?: string }[]; page?: Partial<{ sync: boolean; history: string | null }> } = {}): Transport {
  let c = 100;
  const cookie = `SAPISID=${SAPISID}`;
  return {
    info: async () => ({ sync: o.page?.sync ?? true, headers: 3, ik: true, history: o.page?.history === undefined ? String(fake.gmail.history()) : o.page.history }),
    async sync(ep, body) {
      o.calls?.push({ ep, at: Date.now() });
      const r = await fetch(`${fake.mailUrl}/sync/u/0/i/${ep}?hl=en&c=${++c}&rt=j&pt=ji`, { method: 'POST', headers: { cookie, 'x-framework-xsrf-token': fake.gmail.xsrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await r.text();
      try {
        return { status: r.status, json: JSON.parse(text.replace(/^\)\]\}'[^\n]*\n?/, '')) };
      } catch {
        return { status: r.status, error: 'not-json', page: pageKind(r.status, r.headers.get('content-type'), text, r.url) };
      }
    },
    async raw(hex, max) {
      o.calls?.push({ ep: 'raw', at: Date.now(), hex });
      const r = await fetch(`${fake.mailUrl}/mail/u/0/?ik=${fake.gmail.ik}&view=att&th=${hex}&attid=0&disp=comp&safe=1&zw`, { headers: { cookie } });
      const type = r.headers.get('content-type');
      if (/text\/html/i.test(type ?? '') || r.status === 429) return { status: r.status, type: (type ?? '').split(';')[0] || null, page: pageKind(r.status, type, await r.text(), r.url) };
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > max) return { status: 200, tooBig: bytes.length };
      return { status: r.status, bytes, type: r.headers.get('content-type') };
    },
    async write(body) {
      o.calls?.push({ ep: 'write', at: Date.now() });
      return this.sync('s', body);
    },
    async upload(file, meta) {
      o.calls?.push({ ep: 'upload', at: Date.now() });
      const start = await fetch(`${fake.mailUrl}/_/upload?authuser=0&dcp=asu-n`, { method: 'POST', headers: { cookie, 'x-goog-upload-command': 'start', 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-file-name': file.name, 'x-goog-upload-header-content-type': file.mime }, body: meta });
      const next = start.headers.get('x-goog-upload-url');
      if (start.status !== 200 || !next) return { status: start.status };
      const fin = await fetch(next, { method: 'POST', headers: { cookie, 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0', 'content-type': file.mime }, body: new Uint8Array(file.bytes) });
      return { status: fin.status, token: (await fin.text()).trim() };
    },
  };
}
const quiet = () => {};
const mailOf = (t = transport()) => new GmailMail(t, { log: quiet, gapMs: 0 });
/** A GmailMail with a background lane of small numbers (and a file of its own for what it keeps). */
const laneMail = (o: { t?: Transport; rules?: Partial<BackgroundRules>; now?: () => number; file?: string; onChange?: () => void } = {}) =>
  new GmailMail(o.t ?? transport(), { log: quiet, gapMs: 0, now: o.now, background: { listMs: 0, messageMs: 0, ...o.rules }, stateFile: o.file ?? join(tmp, `reads-${Math.random().toString(36).slice(2)}.json`), onChange: o.onChange });
const codeOf = (e: unknown) => [(e as { status?: number }).status, (e as { callCode?: string }).callCode];

/** What a mailbox should list, newest first: the fake's messages with Gmail ids that pass `f`. */
const expected = (f: (m: FakeMessage) => boolean) =>
  fake.gmail.messages
    .filter((m) => !m.pending && f(m))
    .sort((a, b) => b.date - a.date || (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
    .map((m) => m.id);
async function listAll(mail: GmailMail, mailboxId: string, limit: number): Promise<{ ids: string[]; pages: number; all: MailSummary[] }> {
  const all: MailSummary[] = [];
  let before: string | undefined;
  let pages = 0;
  for (;;) {
    const r = await mail.list({ mailboxId, limit, before });
    pages++;
    all.push(...r.messages);
    if (!r.next) break;
    before = r.next;
    expect(pages).toBeLessThan(200);
  }
  return { ids: all.map((m) => m.id), pages, all };
}

// ------------------------------------------------------------------ the protocol module
/** The shapes recorded on the live page (gmail-shapes-1.json): tags only, no values. */
const RECORDED = {
  bv: [
    ['n', 50, null, 's<100', [null, null, null, null, 0, null, null, null, null, null, null, 'n:ms', 'n', null, null, null, null, null, null, null, null, null, null, 0, 0, 0, 0], 's<100', 1, 'n', null, 0, null, null, null, 1, null, [1, 0, 0, null, null, 0, 1, null, null, 1, null, null, 1, null, 1, null, null, null, null, null, 0], null, null, 1, null, null, 0, 1, 0, [[[2, 50]]], 0, 0, null, null, null, null, null, ['n:ms', null, null, 18]],
    null,
    [0, 5, null, null, 1, 1, 1],
  ],
  fd: [[['id:thread-f', 1, null, null, 1], ['id:thread-f', 1, null, null, 1]], 2],
  s: [[1, null, null, 0], null, [1, null, null, null, [null, 25], null, 1], [null, 1, 'n:ms', 0, 'n'], 2],
};

test('the bodies built are laid out as the page laid out its own (the recorded request shapes)', () => {
  const now = Date.now();
  expect(shape(bvRequest({ query: 'in:inbox is:read newer_than:30d', pageSize: 50, now, requestId: 123456789, history: '4000123', tzOffsetMs: -28_800_000 }))).toEqual(RECORDED.bv as any);
  expect(shape(fdThreadsRequest(['1700000000000000000', '1700000000000000100']))).toEqual(RECORDED.fd as any);
  expect(shape(sRequest('4000123', now))).toEqual(RECORDED.s as any);
  // Read-only: the s built carries no changes, and one that does (the page's writes) is told apart.
  expect(readOnlySync(sRequest('4000123', now))).toBe(true);
  expect(readOnlySync([null, [[[1, ['thread-f:1', [null, null, null, null, null, null, [['^o'], ['^u', '^us'], ['msg-f:1'], now]]]]]], [1, 5, null, null, [null, 0], null, 1], [null, 1, now, 0, 4000123], 2])).toBe(false);
  expect(readOnlySync([[['^u']], null])).toBe(false);
  expect(() => sRequest('not a number', now)).toThrow();
});

test('categories: at most one, receipt first, then the inbox tab, then the classifier, then a pure notification', () => {
  expect(categoryOf(['^smartlabel_receipt'])).toBe('Category/Transactions');
  expect(categoryOf(['^sq_ig_i_personal', '^smartlabel_receipt'])).toBe('Category/Transactions'); // a receipt beats a Primary tab
  expect(categoryOf(['^smartlabel_receipt', '^smartlabel_promo', '^sq_ig_i_promo'])).toBe('Category/Transactions');
  expect(categoryOf(['^sq_ig_i_personal'])).toBeNull();
  expect(categoryOf(['^sq_ig_i_social'])).toBe('Category/Social');
  expect(categoryOf(['^sq_ig_i_promo'])).toBe('Category/Promotions');
  expect(categoryOf(['^sq_ig_i_notification'])).toBe('Category/Updates');
  expect(categoryOf(['^sq_ig_i_group'])).toBe('Category/Forums');
  expect(categoryOf(['^sq_ig_i_personal', '^smartlabel_promo'])).toBeNull(); // the tab overrides the classifier
  expect(categoryOf(['^sq_ig_i_promo', '^smartlabel_social'])).toBe('Category/Promotions');
  expect(categoryOf(['^smartlabel_social'])).toBe('Category/Social');
  expect(categoryOf(['^smartlabel_promo'])).toBe('Category/Promotions');
  expect(categoryOf(['^smartlabel_notification'])).toBe('Category/Updates');
  expect(categoryOf(['^smartlabel_group'])).toBe('Category/Forums');
  expect(categoryOf(['^smartlabel_personal', '^smartlabel_pure_notif'])).toBeNull();
  expect(categoryOf(['^smartlabel_pure_notif'])).toBe('Category/Updates');
  for (const none of ['^smartlabel_finance', '^smartlabel_travel', '^assistive_purchase', '^assistive_travel', '^cob_sm_order', '^cob_sm_trainreservation']) expect(categoryOf(['^all', none])).toBeNull();
  // Labels: system folders by name, yours by name (by id until named), one category; Gmail's bookkeeping left out.
  const names = new Map([['^x_1', 'Work']]);
  expect(labelsOf(['^all', '^i', '^t', '^io_im', '^u', '^o', '^x_1', '^x_9', '^smartlabel_promo', '^sq_ig_i_promo', '^io_lr', '^unsub'], names)).toEqual(['Category/Promotions', 'Important', 'Inbox', 'Starred', 'Work', '^x_9']);
  expect(flagsOf(['^all', '^u', '^t'])).toEqual({ seen: false, flagged: true, answered: false, draft: false });
  expect(flagsOf(['^all', '^io_re'])).toMatchObject({ answered: true });
  expect(flagsOf(['^all', '^r'])).toEqual({ seen: true, flagged: false, answered: false, draft: true });
});

test('ids-only searches take operators only', () => {
  for (const ok of ['in:inbox newer_than:30d', 'is:read older_than:30d', 'label:work category:promotions', 'has:attachment larger:5M', 'after:2024/01/01 before:1700000000']) expect(operatorsOnly(ok)).toBeNull();
  for (const bad of ['dinner plans', 'in:inbox dinner', 'from:someone@example.net', 'subject:x', '"quoted words"', '-in:spam', 'in:inbox OR is:unread', '', 'in:a in:b in:c in:d in:e in:f in:g in:h in:i']) expect(operatorsOnly(bad)).not.toBeNull();
  // The reason names the word's position, never the word.
  expect(operatorsOnly('in:inbox dinner')).not.toContain('dinner');
});

test("answers are read by their anchors; one laid out otherwise is refused, saying where and what kind of thing, not what it held", async () => {
  const mail = mailOf();
  await mail.list({ mailboxId: '^i', limit: 5 });
  // The fake's bv, as the extractor gets it, read; then the same answer with a row's date and id swapped.
  const body = bvRequest({ query: 'in:inbox', pageSize: 50, now: Date.now(), requestId: 123456789 });
  const t = transport();
  const ok = await t.sync('bv', body);
  const page = parseBv(ok.json);
  expect(page.layout).toBe('own');
  expect(page.rows.length).toBe(50);
  expect(page.rows[0]!.messages[0]!.id).toMatch(/^\d{19}$/);
  // json[4] is not the estimate (live answers, 2026-11-13): kept as json4, the estimate stays null.
  expect(page.estimate).toBeNull();
  expect(page.json4).toBeGreaterThan(50);
  expect(page.trailer).toBe(fake.gmail.history());
  expect(page.labels!.map((l) => l.id)).toEqual(fake.gmail.labels.map((l) => l.id));
  expect(page.counts!.get('^i')).toEqual({ unread: expect.any(Number), total: expect.any(Number) });
  expect(page.counts!.get('^afw')).toEqual({ unread: null, total: null }); // an entry with its id alone
  // The page's own layout (rows at json[19][0][1]) reads the same rows, without labels or counts.
  fake.gmail.bvLayout('page');
  try {
    const pg = parseBv((await t.sync('bv', body)).json);
    expect([pg.layout, pg.labels, pg.counts, pg.trailer]).toEqual(['page', null, null, fake.gmail.history()]);
    expect(pg.rows.map((r) => r.thread)).toEqual(page.rows.map((r) => r.thread));
    // A third layout (rows at json[3]) is neither: refused.
    fake.gmail.bvLayout('third');
    const third = (await t.sync('bv', body)).json;
    expect(() => parseBv(third)).toThrow('at json[3][0][0]: expected thread rows only at json[2][n][0] or json[19][0][1][n][0], got a thread row');
  } finally {
    fake.gmail.bvLayout('own');
  }
  // Rows in both places at once: refused too.
  const both = structuredClone(ok.json) as any[];
  both[19] = [[2, both[2], 1]];
  expect(() => parseBv(both)).toThrow('at json[19][0][1][0][0]: expected thread rows in one place only (json[2][n][0] or json[19][0][1][n][0]), got a thread row in the other place too');
  // json[2] holding something else than rows; an empty answer of each layout.
  const odd = structuredClone(ok.json) as any[];
  odd[2] = [[['x'], 1]];
  expect(() => parseBv(odd)).toThrow('at json[2][0][0][2]: expected the row\'s date in ms (13 digits), got nothing');
  const empty = structuredClone(ok.json) as any[];
  empty[2] = [];
  expect(parseBv(empty)).toMatchObject({ layout: 'own', rows: [] });
  expect(parseBv([0, null, null, 1, 0, 1, null, null, null, null, null, [1, 50], null, null, null, null, null, null, [7], [[2, null, 1]]])).toMatchObject({ layout: 'page', rows: [] });
  // A label list entry without a label id is refused, saying where.
  const badLabel = structuredClone(ok.json) as any[];
  badLabel[1][0][0][0] = 'x';
  expect(() => parseBv(badLabel)).toThrow('at json[1][0][0][0]: expected a label id (^…), got a string');
  fake.gmail.layout('swapped');
  try {
    const bad = await t.sync('bv', body);
    let err: unknown;
    try {
      parseBv(bad.json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LayoutError);
    // Found by its anchors elsewhere? No: the swapped row has neither anchor in place, so the expected place reports it.
    expect((err as Error).message).toBe("at json[2][0][0][2]: expected the row's date in ms (13 digits), got an id");
    expect((err as Error).message).not.toContain(MARK);
  } finally {
    fake.gmail.layout('normal');
  }
  // Rows found by their anchors anywhere but where they belong are refused too.
  const moved = structuredClone(ok.json) as any[];
  moved[20] = [[2, moved[2], 1]];
  moved[2] = null;
  expect(() => parseBv(moved)).toThrow('at json[20][0][1][0][0]: expected thread rows only at json[2][n][0] or json[19][0][1][n][0], got a thread row');
  // An answer without the anchors every bv answer had is not taken for an empty list.
  expect(() => parseBv([['er', 1]])).toThrow('at json[0]: expected 0');
  expect(() => parseBv([0, null])).toThrow('at json[18]: expected a list holding a number');
  // A message without its label list.
  const nolabels = structuredClone(ok.json) as any[];
  nolabels[2][1][0][4][0][10] = 'x';
  expect(() => parseBv(nolabels)).toThrow("at json[2][1][0][4][0][10]: expected the message's labels (^…), got a string");
  // fd and s likewise.
  const fd = await t.sync('fd', fdThreadsRequest([fake.gmail.messages[0]!.thread]));
  expect(parseFd(fd.json).threads[0]!.messages.length).toBe(3);
  expect(() => parseFd([0, [['x']]])).toThrow('at json[1][0][0]: expected a thread id (thread-f:…), got a string');
  const s = await t.sync('s', sRequest(String(fake.gmail.history() - 1), Date.now()));
  expect(parseS(s.json).history).toBe(String(fake.gmail.history()));
  expect(() => parseS([null, [0, null, null, null, [], null, 0, 'x'], [[]], [1]])).toThrow('at json[1][7]: expected the new sync point (a number), got a string');
  // The download route: a message, or not (an HTML page, no header block).
  expect(notAMessage(Buffer.from(fakeEml(fake.gmail.messages[0]!)), 'message/rfc822')).toBeNull();
  expect(notAMessage(Buffer.from('<html><body>Sign in</body></html>'), 'text/html')).toBe('an HTML page, not a message');
  expect(notAMessage(Buffer.from('<html><body>x</body></html>'), null)).toBe('no header line at the start (markup first)');
  // Which shape a download with no header line has, never its text.
  expect(notAMessage(Buffer.alloc(0), 'message/rfc822')).toBe('no header line at the start (the download is empty)');
  expect(notAMessage(Buffer.from('\r\nFrom: a@example.com\r\n\r\nx'), null)).toBe('no header line at the start (a blank line first)');
  expect(notAMessage(Buffer.from(' From: a@example.com\r\n\r\nx'), null)).toBe('no header line at the start (a space first)');
  expect(notAMessage(Buffer.from('\xef\xbb\xbfFrom: a@example.com\r\n\r\nx', 'latin1'), null)).toBe('no header line at the start (a byte-order mark first)');
  expect(notAMessage(Buffer.from('From a@example.com Thu Jan  1 00:00:00 2026\nFrom: a@example.com\n\nx'), null)).toBe('no header line at the start (an mbox "From " line first)');
  expect(notAMessage(Buffer.from('just some text\n'), null)).toBe('no header line at the start (a first line with no field name and colon, 15 bytes)');
  expect(notAMessage(Buffer.from('just some text\n'), null)).not.toContain('just');
  // Taken as a message with no headers only when the caller says it is one, and never with markup after the blank line.
  expect(notAMessage(Buffer.from('\r\nbody\r\n'), null, { headerless: true })).toBeNull();
  expect(notAMessage(Buffer.from('\r\n<html>x</html>'), null, { headerless: true })).toBe('no header line at the start (a blank line first)');
  expect(notAMessage(Buffer.from('\r\nbody'), 'text/html', { headerless: true })).toBe('an HTML page, not a message');
  expect(notAMessage(Buffer.from('X-Thing: 1\r\n\r\nbody'), null)).toBe('no message header in the header block');
});

// ------------------------------------------------------------------ GmailMail against the fake
test('mailboxes: the system ones with roles, All Mail by query, your labels by id with their path and parent, counts', async () => {
  const mail = mailOf();
  const { mailboxes } = await mail.mailboxes();
  const by = new Map(mailboxes.map((b) => [b.id, b]));
  expect(mailboxes.slice(0, 10).map((b) => [b.id, b.name, b.role])).toEqual([
    ['^i', 'Inbox', 'inbox'],
    ['^t', 'Starred', 'flagged'],
    ['^t_z', 'Snoozed', null],
    ['^io_im', 'Important', 'important'],
    ['^f', 'Sent', 'sent'],
    ['^scheduled', 'Scheduled', null],
    ['^r', 'Drafts', 'drafts'],
    ['all', 'All Mail', 'all'],
    ['^s', 'Spam', 'junk'],
    ['^k', 'Trash', 'trash'],
  ]);
  expect(mailboxes.slice(10).map((b) => [b.id, b.path, b.name, b.parentId])).toEqual([
    ['^x_3', `Travel ${MARK}`, `Travel ${MARK}`, null],
    ['^x_1', `Work ${MARK}`, `Work ${MARK}`, null],
    ['^x_2', `Work ${MARK}/Clients ${MARK}`, `Clients ${MARK}`, '^x_1'],
  ]);
  const inInbox = fake.gmail.messages.filter((m) => !m.pending && m.labels.includes('^i'));
  expect(by.get('^i')).toMatchObject({ unread: inInbox.filter((m) => m.labels.includes('^u')).length, total: inInbox.length });
  expect(by.get('^r')).toMatchObject({ unread: 0, total: 1 });
  // A count whose total is below its unread (as some of the live ones) gives no total.
  expect(by.get('^x_2')!.total).toBeNull();
  expect(by.get('^x_2')!.unread).not.toBeNull();
});

test('list: newest first, paged by our cursor to the end, every message of the mailbox once; summaries as the app wants them', async () => {
  const mail = mailOf();
  const inbox = await listAll(mail, '^i', 7);
  expect(inbox.ids).toEqual(expected((m) => m.labels.includes('^i')));
  expect(inbox.pages).toBeGreaterThan(5);
  const all = await listAll(mail, 'all', 50);
  expect(all.ids).toEqual(expected((m) => !m.labels.includes('^s') && !m.labels.includes('^k')));
  // More than one bv window: All Mail has more than 50 threads, and replies make threads hold several messages.
  expect(all.ids.length).toBeGreaterThan(100);
  expect(fake.gmail.messages.some((m) => m.pending)).toBe(true);
  // Messages sent from the web app carry the page's own id (msg-a) and Gmail's at [55]: listed under Gmail's id.
  expect(fake.gmail.messages.some((m) => m.localId)).toBe(true);
  expect(all.ids).toEqual(expect.arrayContaining(fake.gmail.messages.filter((m) => m.localId && !m.labels.includes('^s') && !m.labels.includes('^k')).map((m) => m.id)));
  for (const [box, f] of [
    ['^f', (m: FakeMessage) => m.labels.includes('^f')],
    ['^x_1', (m: FakeMessage) => m.labels.includes('^x_1')],
    ['^s', (m: FakeMessage) => m.labels.includes('^s')],
    ['^r', (m: FakeMessage) => m.labels.includes('^r')],
  ] as const)
    expect((await listAll(mail, box, 20)).ids).toEqual(expected(f));
  // The summaries: Gmail's ids, the thread, flags and labels from Gmail's labels; no Message-ID in a list.
  const first = inbox.all.find((m) => m.id === expected((x) => x.labels.includes('^i') && x.labels.includes('^u'))[0])!;
  const src = fake.gmail.messages.find((m) => m.id === first.id)!;
  expect(first).toMatchObject({ id: src.id, emailId: src.id, threadId: src.thread, messageId: null, mailboxId: '^i', subject: fake.gmail.messages.find((m) => m.thread === src.thread)!.subject, date: src.date, receivedAt: src.date, inReplyTo: null, references: [] });
  expect(first.flags.seen).toBe(false);
  expect(first.from).toEqual([{ name: src.from.name!, email: src.from.email }]);
  expect(first.preview).toBe(src.body.slice(0, 60));
  for (const m of [...inbox.all, ...all.all]) {
    expect(m.emailId).toBe(m.id);
    expect(m.threadId).toMatch(/^\d{19}$/);
    expect(m.labels.filter((l) => l.startsWith('Category/')).length).toBeLessThanOrEqual(1);
  }
  const promo = inbox.all.find((m) => fake.gmail.messages.find((x) => x.id === m.id)!.labels.includes('^sq_ig_i_promo'))!;
  expect(promo.labels).toContain('Category/Promotions');
  expect(promo.labels).toContain('Inbox');
  const work = all.all.find((m) => fake.gmail.messages.find((x) => x.id === m.id)!.labels.includes('^x_1'))!;
  expect(work.labels).toContain(`Work ${MARK}`);
  // since: only what is that new, and the end.
  const since = Date.now() - 30 * DAY;
  const recent = await mail.list({ mailboxId: '^i', since, limit: 500 });
  expect(recent.messages.map((m) => m.id)).toEqual(expected((m) => m.labels.includes('^i') && m.date >= since));
  expect(recent.next).toBeNull();
  // Not ours: refused.
  await expect(mail.list({ mailboxId: '^i', before: 'x' })).rejects.toMatchObject({ status: 400 });
  await expect(mail.list({ mailboxId: '^nope' })).rejects.toMatchObject({ status: 404 });
});

test('a cursor stays good across a new arrival: the next page goes on where the last ended; the new one is first from the top', async () => {
  const mail = mailOf();
  const want = expected((m) => m.labels.includes('^i'));
  const p1 = await mail.list({ mailboxId: '^i', limit: 10 });
  expect(p1.messages.map((m) => m.id)).toEqual(want.slice(0, 10));
  const fresh = fake.gmail.arrive({ subject: `Arrived ${MARK}` });
  try {
    const p2 = await mail.list({ mailboxId: '^i', limit: 10, before: p1.next! });
    expect(p2.messages.map((m) => m.id)).toEqual(want.slice(10, 20));
    const top = await mail.list({ mailboxId: '^i', limit: 1 });
    expect(top.messages.map((m) => m.id)).toEqual([fresh.id]);
  } finally {
    fake.gmail.relabel(fresh.id, ['^k'], ['^i', '^all']);
  }
});

test('get, attachment and raw: the original from the download route, parsed as MIME; labels and flags from Gmail', async () => {
  const mail = mailOf();
  const src = fake.gmail.messages.find((m) => m.attachment && m.labels.includes('^i'))!;
  const r = await mail.raw({ id: src.id });
  expect(r).toMatchObject({ filename: null, mime: 'message/rfc822', size: Buffer.byteLength(fakeEml(src)) });
  expect(Buffer.from(r.base64, 'base64').toString()).toBe(fakeEml(src));
  // A fresh class knows nothing of the message: it finds its labels by its Message-ID (bv), then from what it saw.
  const g = await mail.get({ id: src.id });
  expect(g).toMatchObject({ id: src.id, emailId: src.id, threadId: src.thread, mailboxId: '^i', messageId: src.messageId, subject: src.subject, text: src.body, html: `<p>${src.body}</p>`, inReplyTo: null, references: [], hasAttachments: true });
  expect(g.flags).toEqual(flagsOf(src.labels));
  expect(g.labels).toContain('Inbox');
  expect(g.from).toEqual([{ name: src.from.name!, email: src.from.email }]);
  expect(g.to).toEqual(src.to.map((a) => ({ name: a.name ?? null, email: a.email })));
  expect(g.attachments).toEqual([{ id: '2', filename: src.attachment!.name, mime: 'application/pdf', size: src.attachment!.data.length, inline: false, contentId: null }]);
  const a = await mail.attachment({ id: src.id, attachmentId: '2' });
  expect(a).toEqual({ filename: src.attachment!.name, mime: 'application/pdf', base64: src.attachment!.data.toString('base64') });
  await expect(mail.attachment({ id: src.id, attachmentId: '3' })).rejects.toMatchObject({ status: 404 });
  // A reply, and a newsletter: threading and bulk headers from the original.
  const reply = fake.gmail.messages.find((m) => m.inReplyTo && !m.pending)!;
  const gr = await mail.get({ id: reply.id });
  expect([gr.inReplyTo, gr.references, gr.threadId]).toEqual([reply.inReplyTo!, [reply.inReplyTo!], reply.thread]);
  const news = fake.gmail.messages.find((m) => m.listId)!;
  expect((await mail.get({ id: news.id })).bulk).toEqual({ listId: news.listId!, unsubscribe: `<https://news.example.com/u/${news.id}>`, precedence: null, autoSubmitted: null });
  await expect(mail.get({ id: '1700000000099999999' })).rejects.toMatchObject({ status: 404 });
  await expect(mail.get({ id: 'msg-f:1' })).rejects.toMatchObject({ status: 404 });
  // mailparser read the same bytes the same way.
  expect((await parseMessage(Buffer.from(fakeEml(src)))).messageId).toBe(src.messageId);
});

test('search: Gmail syntax, messages; ids only with operators only, paged by cursor, the estimate null until found; free text refused there', async () => {
  const mail = mailOf();
  const k = 42;
  const words = await mail.search({ query: `Plans ${k}` });
  expect('messages' in words && words.messages.map((m) => m.subject)).toEqual(expect.arrayContaining([`Plans ${k} ${MARK}`]));
  // Spam is left out unless asked for.
  expect('messages' in (await mail.search({ query: 'Offer' })) && (await mail.search({ query: 'Offer' }) as any).messages.map((m: any) => m.id)).toEqual(expected((m) => m.subject.startsWith('Offer') && !m.labels.includes('^s') && !m.labels.includes('^k')));
  expect((await mail.search({ query: 'in:spam' }) as any).messages.map((m: any) => m.id)).toEqual(expected((m) => m.labels.includes('^s')));
  // Ids only: every message the operators match, once, paged.
  const want = expected((m) => m.labels.includes('^i') && !m.labels.includes('^u'));
  const ids: string[] = [];
  let cursor: string | undefined;
  let estimate: number | null = null;
  for (let i = 0; i < 20; i++) {
    const r = (await mail.search({ query: 'in:inbox is:read', idsOnly: true, limit: 9, cursor })) as { ids: string[]; next: string | null; estimate: number | null };
    if (i === 0) estimate = r.estimate;
    ids.push(...r.ids);
    if (!r.next) break;
    cursor = r.next;
  }
  expect(ids).toEqual(want);
  expect(estimate).toBeNull();
  // The operators judge each message of a matched thread: a reply of yours in an inbox thread is not in:inbox.
  const sentInInbox = fake.gmail.messages.find((m) => m.labels.includes('^f') && fake.gmail.messages.some((x) => x.thread === m.thread && x.labels.includes('^i')))!;
  expect(ids).not.toContain(sentInInbox.id);
  const recent = (await mail.search({ query: 'in:inbox newer_than:30d', idsOnly: true })) as { ids: string[] };
  expect(recent.ids).toEqual(expected((m) => m.labels.includes('^i') && m.date > Date.now() - 30 * DAY));
  // Within a mailbox.
  const work = (await mail.search({ query: 'Plans', mailboxId: '^x_1', limit: 200 })) as { messages: MailSummary[] };
  expect(work.messages.map((m) => m.id)).toEqual(expected((m) => m.labels.includes('^x_1') && m.subject.includes('Plans')));
  expect(work.messages.every((m) => m.mailboxId === '^x_1')).toBe(true);
  // Free text with idsOnly: 400, and nothing asked of Gmail.
  const before = { ...fake.gmail.calls };
  for (const q of ['dinner plans', 'in:inbox Plans', 'from:someone@example.net']) await expect(mail.search({ query: q, idsOnly: true })).rejects.toMatchObject({ status: 400 });
  expect(fake.gmail.calls).toEqual(before);
});

test('changes from Gmail sync: a state, then what arrived, changed and left the mailbox since; and the watch', async () => {
  const mail = mailOf();
  const start = await mail.changes({ mailboxId: '^i' });
  expect(start.added).toEqual([]);
  const st = parseState(start.state);
  expect(st.history).toBe(String(fake.gmail.history()));
  const old = fake.gmail.messages.find((m) => !m.pending && m.labels.includes('^i') && !m.labels.includes('^t') && m.date < Date.now() - 40 * DAY)!;
  const gone = fake.gmail.messages.find((m) => !m.pending && m.labels.includes('^i') && m.id !== old.id && m.date < Date.now() - 40 * DAY)!;
  const watch = { history: st.history, at: st.at };
  const fresh = fake.gmail.arrive({ subject: `Fresh ${MARK}` });
  fake.gmail.relabel(old.id, ['^t'], []);
  fake.gmail.relabel(gone.id, [], ['^i']);
  try {
    const c = await mail.changes({ mailboxId: '^i', state: start.state });
    expect(c.added.map((m) => m.id)).toEqual([fresh.id]);
    expect(c.added[0]).toMatchObject({ id: fresh.id, emailId: fresh.id, threadId: fresh.thread, mailboxId: '^i', flags: { seen: false } });
    expect(c.changed.find((x) => x.id === old.id)).toMatchObject({ flags: { flagged: true }, labels: expect.arrayContaining(['Starred', 'Inbox']) });
    expect(c.removed).toContain(gone.id);
    expect(c.more).toBe(false);
    expect(parseState(c.state).history).toBe(String(fake.gmail.history()));
    // From the new state: nothing more.
    const again = await mail.changes({ mailboxId: '^i', state: c.state });
    expect([again.added, again.changed, again.removed]).toEqual([[], [], []]);
    // The watch (main.ts polls it): the mailboxes touched, the new inbox mail once.
    const w = await mail.poll(watch);
    expect(w.mailboxes).toEqual(expect.arrayContaining(['^i', 'all', '^t']));
    expect(w.arrived.map((m) => m.id)).toEqual([fresh.id]);
    expect((await mail.poll(watch)).arrived).toEqual([]); // announced once
    await expect(mail.changes({ mailboxId: '^i', state: 'e.123' })).rejects.toMatchObject({ status: 400 });
  } finally {
    fake.gmail.relabel(fresh.id, ['^k'], ['^i', '^all']);
    fake.gmail.relabel(old.id, [], ['^t']);
    fake.gmail.relabel(gone.id, ['^i'], []);
  }
  // Nothing in all of this wrote to Gmail.
  expect(fake.gmail.writes).toBe(0);
});

test('a changed layout: the call is refused with 502 and a plain sentence, nothing returned, the layer failed; back when the layout is', async () => {
  let changed = 0;
  const mail = new GmailMail(transport(), { log: quiet, gapMs: 0, onChange: () => changed++ });
  expect(mail.layer()).toMatchObject({ name: 'Gmail protocol', state: 'waiting' });
  await mail.list({ mailboxId: '^i', limit: 3 });
  expect(mail.layer()).toMatchObject({ state: 'ok' });
  fake.gmail.layout('swapped');
  try {
    let got: unknown = 'nothing';
    const err = await mail.list({ mailboxId: '^i', limit: 3 }).then((r) => ((got = r), null), (e) => e);
    expect(got).toBe('nothing');
    expect(err).toMatchObject({ status: 502 });
    expect(err.message).toBe("Gmail's list and search (bv) answer is not laid out as this extractor knows it (at json[2][0][0][2]: expected the row's date in ms (13 digits), got an id); nothing was returned rather than possibly wrong mail");
    expect(mail.layer()).toEqual({ name: 'Gmail protocol', state: 'failed', note: "bv: at json[2][0][0][2]: expected the row's date in ms (13 digits), got an id" });
    expect(mail.fp.bv).toMatchObject({ failed: 1, last: false, first: "at json[2][0][0][2]: expected the row's date in ms (13 digits), got an id" });
    expect(changed).toBeGreaterThan(0);
  } finally {
    fake.gmail.layout('normal');
  }
  await mail.list({ mailboxId: '^i', limit: 3 });
  expect(mail.layer().state).toBe('ok');
});

test('paced: one Gmail call at a time, at least 300 ms apart', async () => {
  const calls: { ep: string; at: number }[] = [];
  const mail = new GmailMail(transport({ calls }), { log: quiet });
  await Promise.all([mail.list({ mailboxId: '^i', limit: 3 }), mail.list({ mailboxId: 'all', limit: 3 }), mail.raw({ id: fake.gmail.messages[0]!.id })]);
  // Two lists (their answers carry the label list, so no sync call for names) and a download.
  expect(calls.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < calls.length; i++) expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(295);
});

test('what a non-mail answer reads as (pageKind, as the hook says it), and which labels are mailboxes', () => {
  expect(pageKind(200, 'text/html', "<!doctype html><html><body>Verify it's you</body></html>", 'https://mail.example.com/x')).toBe('challenge');
  expect(pageKind(200, 'text/html; charset=utf-8', '<html>We noticed unusual activity</html>', null)).toBe('challenge');
  expect(pageKind(429, 'text/html', '<html>Please solve the CAPTCHA</html>', null)).toBe('challenge');
  expect(pageKind(429, 'application/json', '[["er",429]]', null)).toBeNull(); // a plain 429: a back-off, not a stop
  expect(pageKind(200, 'text/html', '<html><a href="https://accounts.google.com/ServiceLogin">x</a></html>', null)).toBe('signin');
  expect(pageKind(200, null, '<html><body>Sign in</body></html>', null)).toBe('signin');
  expect(pageKind(200, 'text/html', '<html>ok</html>', 'https://accounts.google.com/v3/signin/identifier')).toBe('signin');
  expect(pageKind(200, 'text/plain', 'Sign in', null)).toBeNull();
  expect(pageKind(500, 'text/html', '<html><body>Server error</body></html>', null)).toBeNull();
  // Yours: type 2 (or an ^x_ id with no type); Gmail's own never, whatever their type says.
  expect(isUserLabel({ id: '^x_1', type: 2 })).toBe(true);
  expect(isUserLabel({ id: '^x_9', type: null })).toBe(true);
  expect(isUserLabel({ id: '^x_3', type: 1 })).toBe(false);
  for (const id of ['^i', '^all', '^b', '^io_im', '^smartlabel_social', '^sq_ig_i_promo', '^assistive_bill', '^cob_sm_order', '^io_unim', '^p_cc', '^wc_tb_ready', '^u', '^iim']) expect({ id, user: isUserLabel({ id, type: 2 }) }).toEqual({ id, user: false });
});

test('mailboxes with no sync point known: from one list answer, its label list and counts; categories and the like are no mailbox', async () => {
  const before = { ...fake.gmail.calls };
  const mail = mailOf(transport({ page: { history: null } }));
  const { mailboxes } = await mail.mailboxes();
  expect([fake.gmail.calls.s, fake.gmail.calls.bv]).toEqual([before.s, before.bv + 1]);
  expect(mail.evidence.mailboxesFrom).toBe('bv');
  expect(mailboxes.map((b) => [b.id, b.role])).toEqual([
    ['^i', 'inbox'],
    ['^t', 'flagged'],
    ['^t_z', null],
    ['^io_im', 'important'],
    ['^f', 'sent'],
    ['^scheduled', null],
    ['^r', 'drafts'],
    ['all', 'all'],
    ['^s', 'junk'],
    ['^k', 'trash'],
    ['^x_3', null],
    ['^x_1', null],
    ['^x_2', null],
  ]);
  expect(mailboxes.slice(10).map((b) => [b.path, b.name, b.parentId])).toEqual([
    [`Travel ${MARK}`, `Travel ${MARK}`, null],
    [`Work ${MARK}`, `Work ${MARK}`, null],
    [`Work ${MARK}/Clients ${MARK}`, `Clients ${MARK}`, '^x_1'],
  ]);
  const inInbox = fake.gmail.messages.filter((m) => !m.pending && m.labels.includes('^i'));
  expect(mailboxes[0]).toMatchObject({ unread: inInbox.filter((m) => m.labels.includes('^u')).length, total: inInbox.length });
  expect(mailboxes.find((b) => b.id === '^x_2')!.total).toBeNull();
  // The same mailboxes, counts and all, as from Gmail's sync.
  expect(mailboxes).toEqual((await mailOf().mailboxes()).mailboxes);
  // A list answer in the page's layout carries no label list: with no sync point either, the honest 503.
  fake.gmail.bvLayout('page');
  try {
    await expect(mailOf(transport({ page: { history: null } })).mailboxes()).rejects.toMatchObject({ status: 503 });
  } finally {
    fake.gmail.bvLayout('own');
  }
});

test("a sync point from a list answer when the page has none: changes go from it; a number Gmail's sync does not take is the honest 503", async () => {
  const mail = mailOf(transport({ page: { history: null } }));
  const start = await mail.changes({ mailboxId: '^i' });
  expect(parseState(start.state)).toMatchObject({ history: String(fake.gmail.history()), guess: true });
  expect(start.state).toEndWith('.b');
  expect(mail.evidence.pointFrom).toBe('bv');
  const fresh = fake.gmail.arrive({ subject: `Fresh ${MARK}` });
  try {
    const c = await mail.changes({ mailboxId: '^i', state: start.state });
    expect(c.added.map((m) => m.id)).toEqual([fresh.id]);
    expect(parseState(c.state).guess).toBe(false); // Gmail's sync answered: its own from now on
    expect(mail.evidence.sFromBvPoint).toBe('ok');
    expect(await mail.pointInfo()).toEqual({ history: String(fake.gmail.history()), guess: false });
  } finally {
    fake.gmail.relabel(fresh.id, ['^k'], ['^i', '^all']);
  }
  // A number that is no sync point (above Gmail's): its sync answers an older one, so 503, and it is not used again.
  fake.gmail.bvTrailer(fake.gmail.history() + 5_000_000);
  try {
    const m2 = mailOf(transport({ page: { history: null } }));
    const s2 = await m2.changes({ mailboxId: '^i' });
    expect(parseState(s2.state).guess).toBe(true);
    const e = await m2.changes({ mailboxId: '^i', state: s2.state }).catch((x) => x);
    expect(e.status).toBe(503);
    expect(e.message).toContain("the number Gmail's list answers end with is not one");
    expect([m2.evidence.sFromBvPoint, m2.bvPointRefused]).toEqual(['refused', true]);
    const bv = fake.gmail.calls.bv;
    await expect(m2.changes({ mailboxId: '^i' })).rejects.toMatchObject({ status: 503 });
    expect(fake.gmail.calls.bv).toBe(bv);
  } finally {
    fake.gmail.bvTrailer(null);
  }
  // Nor one that goes down from one list answer to the next.
  const m3 = mailOf(transport({ page: { history: null } }));
  try {
    fake.gmail.bvTrailer(fake.gmail.history() + 10);
    await m3.list({ mailboxId: '^i', limit: 1 });
    fake.gmail.bvTrailer(fake.gmail.history() + 5);
    await m3.list({ mailboxId: '^i', limit: 1 });
    expect(m3.evidence).toMatchObject({ bvTrailerPairs: 1, bvTrailerDecreased: 1 });
    await expect(m3.changes({ mailboxId: '^i' })).rejects.toMatchObject({ status: 503 });
  } finally {
    fake.gmail.bvTrailer(null);
  }
  expect(fake.gmail.writes).toBe(0);
});

/** Read messages of the fake (never an unread one), for the lane's tests. */
const readOnes = () => fake.gmail.messages.filter((m) => !m.pending && !m.labels.includes('^u') && !m.labels.includes('^k'));
const hex = (id: string) => BigInt(id).toString(16);

test('the background lane: its own pace for lists and for downloads, and never ahead of the foreground', async () => {
  const calls: { ep: string; at: number; hex?: string }[] = [];
  const mail = laneMail({ t: transport({ calls }), rules: { listMs: 400, messageMs: 300 } });
  expect(mail.backgroundLayer()).toEqual({ name: 'Gmail background', state: 'ok', note: 'idle' });
  const read = readOnes().slice(0, 5);
  await Promise.all(read.slice(0, 3).map((m) => mail.raw({ id: m.id, background: true })));
  const raws = calls.filter((c) => c.ep === 'raw');
  expect(raws.length).toBe(3);
  for (let i = 1; i < raws.length; i++) expect(raws[i]!.at - raws[i - 1]!.at).toBeGreaterThanOrEqual(295);
  expect(mail.backgroundLayer()).toEqual({ name: 'Gmail background', state: 'ok', note: 'running' });
  calls.length = 0;
  await Promise.all([mail.list({ mailboxId: '^i', limit: 3, background: true }), mail.list({ mailboxId: 'all', limit: 3, background: true })]);
  const bvs = calls.filter((c) => c.ep === 'bv');
  expect(bvs.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < bvs.length; i++) expect(bvs[i]!.at - bvs[i - 1]!.at).toBeGreaterThanOrEqual(395);
  // A backlog of background downloads does not hold up the foreground: at most the one in flight goes before it.
  calls.length = 0;
  const t0 = Date.now();
  const backlog = read.slice(0, 4).map((m) => mail.raw({ id: m.id, background: true }));
  await Bun.sleep(20);
  const fgAt = Date.now();
  await mail.raw({ id: read[4]!.id });
  expect(Date.now() - fgAt).toBeLessThan(250);
  expect(calls.filter((c) => c.ep === 'raw').findIndex((c) => c.hex === hex(read[4]!.id))).toBeLessThanOrEqual(1);
  await Promise.all(backlog);
  expect(calls.filter((c) => c.ep === 'raw').length).toBe(5);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 295);
});

test("the background lane's download budget: past it, background calls answer 503 paused (quota) and the foreground goes on; kept across a restart; back when the window frees", async () => {
  let now = Date.now();
  const file = join(tmp, 'reads-quota.json');
  const read = readOnes();
  const mail = laneMail({ rules: { budgetBytes: 2000 }, now: () => now, file });
  let used = 0;
  let i = 0;
  while (used < 2000) used += (await mail.raw({ id: read[i++]!.id, background: true })).size;
  expect(mail.background().stopped).toBe('quota');
  const calls = { ...fake.gmail.calls };
  const e = await mail.raw({ id: read[i]!.id, background: true }).catch((x) => x);
  expect(codeOf(e)).toEqual([503, 'paused']);
  expect(e.message).toContain("the day's download budget is spent; it resumes at ");
  await expect(mail.list({ mailboxId: '^i', limit: 1, background: true })).rejects.toMatchObject({ status: 503, callCode: 'paused' });
  expect(fake.gmail.calls).toEqual(calls);
  expect(mail.backgroundLayer()).toMatchObject({ name: 'Gmail background', state: 'failed' });
  expect(mail.backgroundLayer().note).toStartWith("stopped (quota): the day's download budget is spent; resumes at ");
  // The foreground goes on (and counts too).
  expect((await mail.raw({ id: read[i]!.id })).size).toBeGreaterThan(0);
  // Kept in the account's directory: a restart does not reset it.
  expect(JSON.parse(readFileSync(file, 'utf8')).fetched.reduce((n: number, x: number[]) => n + x[1]!, 0)).toBeGreaterThan(2000);
  const again = laneMail({ rules: { budgetBytes: 2000 }, now: () => now, file });
  expect(again.background().stopped).toBe('quota');
  await expect(again.raw({ id: read[0]!.id, background: true })).rejects.toMatchObject({ status: 503, callCode: 'paused' });
  // A day later the window has room again.
  now += 24 * 3600_000 + 61_000;
  expect(again.background().stopped).toBeNull();
  expect((await again.raw({ id: read[0]!.id, background: true })).size).toBeGreaterThan(0);
});

test('a challenge stops the background lane: 503 paused (challenge), no more background calls to Gmail, the foreground answered as Gmail answers; back once Gmail answers again', async () => {
  const mail = laneMail({ rules: { backoffMinMs: 20 } });
  const read = readOnes()[0]!;
  await mail.list({ mailboxId: '^i', limit: 1, background: true });
  for (const kind of ['verify', 'captcha429', 'signin'] as const) {
    fake.gmail.challenge(kind);
    try {
      const e = await mail.list({ mailboxId: '^i', limit: 1, background: true }).catch((x) => x);
      expect({ kind, code: codeOf(e) }).toEqual({ kind, code: [503, 'paused'] });
      expect(mail.background().stopped).toBe('challenge');
      expect(mail.backgroundLayer().state).toBe('failed');
      // Never retried into: nothing more reaches Gmail from the background.
      const calls = { ...fake.gmail.calls };
      await expect(mail.raw({ id: read.id, background: true })).rejects.toMatchObject({ status: 503, callCode: 'paused' });
      await expect(mail.search({ query: 'in:inbox', background: true })).rejects.toMatchObject({ status: 503, callCode: 'paused' });
      expect(fake.gmail.calls).toEqual(calls);
      // The foreground is answered as Gmail answers it, saying what the page was, never what it said.
      const f = await mail.list({ mailboxId: '^i', limit: 1 }).catch((x) => x);
      expect(f.status).toBe(502);
      expect(f.message).toContain(kind === 'signin' ? 'with a sign-in page' : 'with a verification page');
      expect(f.message).not.toMatch(/unusual|CAPTCHA|ServiceLogin|Verify it/);
    } finally {
      fake.gmail.challenge(null);
    }
    await Bun.sleep(30);
    await mail.list({ mailboxId: '^i', limit: 1 });
    expect(mail.background().stopped).toBeNull();
    expect((await mail.list({ mailboxId: '^i', limit: 1, background: true })).messages.length).toBe(1);
  }
  // On a download too; and a page that says none of it, in place of JSON or a message, is taken for one as well.
  for (const kind of ['captcha429', 'blank'] as const)
    for (const op of [() => mail.raw({ id: read.id, background: true }), () => mail.list({ mailboxId: '^i', limit: 1, background: true })]) {
      fake.gmail.challenge(kind);
      try {
        expect({ kind, code: codeOf(await op().catch((x) => x)) }).toEqual({ kind, code: [503, 'paused'] });
        expect(mail.background().stopped).toBe('challenge');
      } finally {
        fake.gmail.challenge(null);
      }
      await Bun.sleep(30);
      await mail.raw({ id: read.id });
      expect(mail.background().stopped).toBeNull();
    }
});

test('a signed-out Gmail page stops the background lane (signedOut) until the page is signed in and answers again', async () => {
  const mail = laneMail();
  const read = readOnes()[0]!;
  mail.notePage(false);
  const calls = { ...fake.gmail.calls };
  const e = await mail.raw({ id: read.id, background: true }).catch((x) => x);
  expect(codeOf(e)).toEqual([503, 'paused']);
  expect(e.message).toContain('the Gmail page is signed out');
  expect(mail.background().stopped).toBe('signedOut');
  expect(mail.backgroundLayer().note).toStartWith('stopped (signedOut)');
  expect(fake.gmail.calls).toEqual(calls);
  mail.notePage(true);
  expect(mail.background().stopped).toBe('signedOut'); // signed in, not answering yet
  await mail.list({ mailboxId: '^i', limit: 1 });
  expect(mail.background().stopped).toBeNull();
  expect((await mail.raw({ id: read.id, background: true })).size).toBeGreaterThan(0);
});

test('the background lane backs off after a 5xx, a 429 or a slow answer, doubling up to its most, and back to none after good answers', async () => {
  const calls: { ep: string; at: number; hex?: string }[] = [];
  const mail = laneMail({ t: transport({ calls }), rules: { backoffMinMs: 300, backoffMaxMs: 1000, slowMs: 250, goodToReset: 2 } });
  const read = readOnes().slice(0, 9);
  fake.gmail.failNext(503);
  await expect(mail.raw({ id: read[0]!.id, background: true })).rejects.toMatchObject({ status: 502 });
  const b1 = mail.background();
  expect(b1).toMatchObject({ stopped: null, backoffMs: 300 });
  expect(mail.backgroundLayer()).toMatchObject({ state: 'waiting' });
  expect(mail.backgroundLayer().note).toStartWith('backed off until ');
  // The foreground is not held back by it.
  const f0 = Date.now();
  await mail.raw({ id: read[1]!.id });
  expect(Date.now() - f0).toBeLessThan(200);
  // The next background call waits it out.
  await mail.raw({ id: read[2]!.id, background: true });
  expect(calls.find((c) => c.hex === hex(read[2]!.id))!.at).toBeGreaterThanOrEqual(b1.backedOffUntil! - 2);
  // A 429 doubles it; a slow answer doubles it again, up to the most.
  fake.gmail.failNext(429);
  await expect(mail.raw({ id: read[3]!.id, background: true })).rejects.toMatchObject({ status: 502 });
  expect(mail.background().backoffMs).toBe(600);
  fake.gmail.delayNext(300);
  await mail.raw({ id: read[4]!.id, background: true });
  expect(mail.background().backoffMs).toBe(1000);
  // Good answers (two here) end it: the next trouble starts from the least again.
  await mail.raw({ id: read[5]!.id, background: true });
  await mail.raw({ id: read[6]!.id, background: true });
  expect(mail.background().backoffMs).toBe(0);
  fake.gmail.failNext(500);
  await expect(mail.raw({ id: read[7]!.id, background: true })).rejects.toMatchObject({ status: 502 });
  expect(mail.background().backoffMs).toBe(300);
  // A background call that could not start in time is told so at once (503 'backoff'), not left to time out.
  const quick = laneMail({ rules: { backoffMinMs: 1000, waitMs: 200 } });
  fake.gmail.failNext(503);
  await expect(quick.raw({ id: read[8]!.id, background: true })).rejects.toMatchObject({ status: 502 });
  const t0 = Date.now();
  expect(codeOf(await quick.raw({ id: read[8]!.id, background: true }).catch((x) => x))).toEqual([503, 'backoff']);
  expect(Date.now() - t0).toBeLessThan(100);
  expect((await quick.raw({ id: read[8]!.id })).size).toBeGreaterThan(0);
});

test('the unread guard, not tripped: an unread message read here is looked at again (fd) and is still unread; nothing else changes', async () => {
  const file = join(tmp, 'reads-guard-0.json');
  const mail = laneMail({ file });
  await mail.list({ mailboxId: '^i', limit: 500 });
  const unread = fake.gmail.messages.filter((m) => !m.pending && m.labels.includes('^i') && m.labels.includes('^u'));
  expect(unread.length).toBeGreaterThan(1);
  const fd = fake.gmail.calls.fd;
  await mail.raw({ id: unread[0]!.id });
  expect(fake.gmail.calls.fd).toBe(fd + 1);
  expect(mail.readsMarkRead).toBe(false);
  expect(fake.gmail.messages.find((m) => m.id === unread[0]!.id)!.labels).toContain('^u');
  expect((await mail.get({ id: unread[1]!.id })).flags.seen).toBe(false);
  expect(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).unreadGuard : undefined).toBeUndefined();
});

test('the unread guard, tripped: Gmail took ^u off a message read here, so unread ones are refused from then on (409 unread), kept across a restart', async () => {
  const file = join(tmp, 'reads-guard-1.json');
  let changed = 0;
  const mail = laneMail({ file, onChange: () => changed++ });
  await mail.list({ mailboxId: '^i', limit: 500 });
  const unread = fake.gmail.messages.filter((m) => !m.pending && m.labels.includes('^i') && m.labels.includes('^u'));
  const victim = unread[0]!;
  fake.gmail.readsMarkRead(true);
  try {
    await mail.raw({ id: victim.id });
    expect(mail.readsMarkRead).toBe(true);
    expect(changed).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).unreadGuard).toBe('tripped');
    const fetched = fake.gmail.rawFetched.length;
    const other = unread.find((m) => m.attachment && m.id !== victim.id) ?? unread[1]!;
    for (const op of [() => mail.get({ id: other.id }), () => mail.raw({ id: other.id }), () => mail.attachment({ id: other.id, attachmentId: '2' }), () => mail.raw({ id: other.id, background: true })]) {
      const e = await op().catch((x) => x);
      expect(codeOf(e)).toEqual([409, 'unread']);
    }
    expect(fake.gmail.rawFetched.length).toBe(fetched); // nothing downloaded
    // A read message still reads.
    const readOne = fake.gmail.messages.find((m) => !m.pending && m.labels.includes('^i') && !m.labels.includes('^u') && m.id !== victim.id)!;
    expect((await mail.get({ id: readOne.id })).id).toBe(readOne.id);
    // Kept across a restart.
    const again = laneMail({ file });
    expect(again.readsMarkRead).toBe(true);
    await again.list({ mailboxId: '^i', limit: 500 });
    await expect(again.raw({ id: other.id })).rejects.toMatchObject({ status: 409, callCode: 'unread' });
  } finally {
    fake.gmail.readsMarkRead(false);
    fake.gmail.relabel(victim.id, ['^u'], []);
  }
});

test('the self-check: counts, booleans and types only, nothing the mailbox holds; one read message older than 30 days read whole', async () => {
  const before = fake.gmail.rawFetched.length;
  const r = await selfCheck(mailOf(), () => transport().info());
  expect(r.ok).toBe(true);
  expect(r.page).toMatchObject({ syncSeen: true, accountKey: true, syncPoint: true });
  expect(r.mailboxes).toMatchObject({ count: 13, roles: ['all', 'drafts', 'flagged', 'important', 'inbox', 'junk', 'sent', 'trash'], system: 10, user: 3, nested: 1 });
  expect(r.inbox).toMatchObject({ listed: 50, next: true, emailIdIsId: 50, threadId: 50, messageIdNull: 50, idsDecimal: true, datesInRange: true, newestFirst: true, mailboxIdAsAsked: true, to: 0 });
  expect(r.allMail).toMatchObject({ listed: 50, next: true, idsDecimal: true });
  expect(r.searchIds).toMatchObject({ operators: ['in', 'newer_than'], ids: expected((m) => m.labels.includes('^i') && m.date > Date.now() - 30 * DAY).length, unique: true, idsDecimal: true, estimate: 'null' });
  expect(r.message).toMatchObject({ found: true, raw: { mime: 'message/rfc822', parsed: true, messageIdHeader: true, fromHeader: true, dateHeader: true, sizeMatches: true }, get: { sameId: true, sameThread: true, messageId: true, text: true, stillSeen: true } });
  expect(r.fingerprints.bv).toMatchObject({ failed: 0, firstMismatch: null });
  // The bv layout seen, where the mailboxes came from, the list answers' number beside the page's sync point.
  expect(r.mailboxes).toMatchObject({ source: 's' });
  expect(r.evidence).toMatchObject({ bvLayout: 'own', bvTrailerEqualsPagePoint: true, bvTrailerVsPagePoint: 'equal', bvTrailerMonotonic: true, sFromBvPoint: null, bvPointRefused: null });
  expect(r.evidence.bvLayouts.own).toBeGreaterThan(2);
  expect(r.evidence.bvLayouts.page).toBe(0);
  // The inbox's two counts beside its first 50, as relations: the first is at most its unread ones, the second more than listed.
  expect(r.inboxCounts).toMatchObject({ from: 'bv', present: true, listComplete: false, secondVsListedMessages: 'more', secondVsListedThreads: 'more', firstAtMostSecond: true });
  expect(['equal', 'more']).toContain(r.inboxCounts!.firstVsUnreadMessages!);
  expect(r.lane).toEqual({ backgroundStopped: null, readsMarkRead: false });
  expect(r.fingerprints.raw).toMatchObject({ ok: 2, failed: 0 }); // mail.raw, then mail.get: one download each
  expect(r.fingerprints.fd).toMatchObject({ ok: 1 });
  // It read one message whole (mail.raw and mail.get, a download each), read and more than 30 days old.
  const read = fake.gmail.rawFetched.slice(before);
  expect([read.length, new Set(read).size]).toEqual([2, 1]);
  const m = fake.gmail.messages.find((x) => x.id === read[0])!;
  expect(m.labels).not.toContain('^u');
  expect(m.date).toBeLessThan(Date.now() - 30 * DAY);
  // Nothing of the mailbox in it: no subject, address, name, body, label name or id.
  const text = JSON.stringify(r);
  const secrets = [MARK, 'Mk%235512', 'Plans', 'example.', 'Person', 'Owner', 'Work', 'Travel', '^x_', fake.gmail.xsrf, fake.gmail.ik, String(fake.gmail.history())];
  for (const msg of fake.gmail.messages) secrets.push(msg.id, msg.thread, msg.from.email, msg.messageId);
  for (const s of secrets) expect({ s, found: text.includes(s) }).toEqual({ s, found: false });
  // With no sync point from the page: mailboxes from a list answer, which also gives the sync point.
  const t = transport({ page: { history: null } });
  const r2 = await selfCheck(mailOf(t), () => t.info());
  expect(r2.ok).toBe(true);
  expect(r2.page).toMatchObject({ syncPoint: false });
  expect(r2.mailboxes).toMatchObject({ count: 13, source: 'bv', user: 3 });
  expect(r2.evidence).toMatchObject({ bvTrailerEqualsPagePoint: null, bvTrailerMonotonic: true });
});

test('a message Gmail keeps with no headers: its blank-line-first original is read when Gmail lists it with no sender, refused otherwise', async () => {
  const bare = fake.gmail.arrive({ subject: '', body: `Bare ${MARK}`, headerless: true, from: { email: '' }, labels: ['^all', '^i'] });
  const posing = fake.gmail.arrive({ subject: '', body: `Posing ${MARK}`, headerless: true, labels: ['^all', '^i'] });
  // Not seen in a listing yet: refused, as any download that starts with a blank line.
  await expect(mailOf().get({ id: bare.id })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('(a blank line first)') });
  const mail = mailOf();
  await mail.list({ mailboxId: '^i', limit: 5 });
  const g = await mail.get({ id: bare.id });
  expect(g).toMatchObject({ id: bare.id, from: [], to: [], subject: '', messageId: null, text: `Bare ${MARK}\n`, size: Buffer.byteLength(fakeEml(bare)) });
  expect((await mail.raw({ id: bare.id })).size).toBe(Buffer.byteLength(fakeEml(bare)));
  // Listed with a sender, the same shape is not a message with no headers: refused.
  await expect(mail.get({ id: posing.id })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('(a blank line first)') });
});

// ------------------------------------------------------------------ writing (write.ts, GmailMail's writes and send)
/** The page's own writes, recorded on the live page (2026-11-13): type tags and anchors only. */
const RECORDED_WRITES = {
  // The page's star: ^t and the yellow style on, the other styles off; it adds what it knows of the message at [11].
  star: [null, [[[1, ['id:thread-f', [null, null, null, null, null, null, [['^t', '^ss_sy'], ['^ss_so', '^ss_sr', '^ss_sp', '^ss_sb', '^ss_sg', '^ss_cr', '^ss_co', '^ss_cy', '^ss_cg', '^ss_cb', '^ss_cp'], ['id:msg-f'], null, null, null, null, null, null, null, null, ['^sq_ig_i_personal', ['s0'], ['^smartlabel_personal']]]]]]]], [1, 'n', null, null, [null, 0], null, 1], ['n:ms', 1, 'n:ms', 0, 'n'], 2],
  archive: [['^a'], ['^ri_hl', '^i', '^iim', '^t_p', '^t_rd', '^us', '^k', '^s', '^t_z', '^afw']],
  inbox: [['^i'], ['^a', '^t_z', '^us', '^k', '^s', '^pr_i_u']],
  trash: [['^k'], ['^ri_hl', '^i', '^iim', '^t_p', '^t_rd', '^us', '^s', '^a', '^t_z', '^afw', '^pr_i_u']],
  read: [null, ['^u', '^us']],
  unread: [['^u'], null],
  unstar: [null, ['^t', '^ss_sy', '^ss_so', '^ss_sr', '^ss_sp', '^ss_sb', '^ss_sg', '^ss_cr', '^ss_co', '^ss_cy', '^ss_cg', '^ss_cb', '^ss_cp']],
  moveToLabel: [['^x_1'], ['^ri_hl', '^i', '^iim', '^t_p', '^t_rd', '^us', '^k', '^s']],
};

test("the writes built are the page's own: its label changes, without what it adds of the message (Gmail takes them without)", () => {
  const now = Date.now();
  const body = writeRequest([labelChange(1, '1700000000000000000', ['1700000000000000000'], EDITS.star)], { history: '4000123', now });
  const star = structuredClone(RECORDED_WRITES.star) as any[];
  star[1][0][0][1][1][6][11] = null; // what the page adds of the message
  star[3][4] = 49; // the page's own number there in its writes
  expect(shape(body)).toEqual(star);
  const edit = (e: { add: string[]; remove: string[] }) => [e.add.length ? e.add : null, e.remove.length ? e.remove : null];
  expect(edit(EDITS.archive)).toEqual(RECORDED_WRITES.archive);
  expect(edit(EDITS.inbox)).toEqual(RECORDED_WRITES.inbox);
  expect(edit(EDITS.trash)).toEqual(RECORDED_WRITES.trash);
  expect(edit(EDITS.read)).toEqual(RECORDED_WRITES.read);
  expect(edit(EDITS.unread)).toEqual(RECORDED_WRITES.unread);
  expect(edit(EDITS.unstar)).toEqual(RECORDED_WRITES.unstar);
  expect(edit(intoLabel('^x_1'))).toEqual(RECORDED_WRITES.moveToLabel);
  // A send's head and client part, as the page's.
  const sending = writeRequest([1], { history: '4000123', now, sending: true });
  expect([sending[0], sending[2], (sending[3] as number[])[3]]).toEqual([[null, null, 2], null, 1]);
  // The upload's start, laid out as the page's: 1 the draft's id, 3 and 4 zero, 7 the sender, 8 each recipient, 11 zero.
  const str = (field: number, v: string) => [(field << 3) | 2, v.length, ...Buffer.from(v)];
  const want = [...str(1, 'msg-a:r-700000000000000001'), 0x18, 0, 0x20, 0, ...str(7, 'pat@example.com'), ...str(8, 'ann@example.org'), ...str(8, 'bo@example.org'), 0x58, 0];
  expect([...Buffer.from(uploadMeta('msg-a:r-700000000000000001', 'pat@example.com', ['ann@example.org', 'bo@example.org']), 'base64url')]).toEqual(want);
  expect(htmlOfText('a < b & "c"\nnext')).toBe('<div dir="ltr">a &lt; b &amp; &quot;c&quot;<br>next</div>');
  expect(messageRecord({ msgId: 'msg-a:r-1', from: { email: 'pat@example.com', name: 'Pat' }, to: [{ email: 'a@example.org', name: null }], cc: [], bcc: [{ email: 'b@example.org', name: null }], subject: 's', html: '<div>x</div>', files: [], inReplyTo: '<o@example.org>', session: 's:0|#msg-a:r-1|0' }, now, true)).toHaveLength(78);
});

test('mail.flag: read and unread, starred and not, as Gmail applied them; the labels kept follow', async () => {
  const mail = mailOf();
  await mail.list({ mailboxId: '^i', limit: 50 });
  const m = fake.gmail.messages.find((x) => !x.pending && !x.localId && x.labels.includes('^i') && x.labels.includes('^u'))!;
  const before = fake.gmail.writes;
  expect(await mail.flag({ ids: [m.id], seen: true, flagged: true })).toEqual({});
  expect(m.labels).not.toContain('^u');
  expect(m.labels).toEqual(expect.arrayContaining(['^t', '^ss_sy']));
  expect(fake.gmail.writes).toBe(before + 1); // both changes in one call
  expect((await mail.list({ mailboxId: '^t', limit: 200 })).messages.map((x) => x.id)).toContain(m.id);
  expect(await mail.flag({ ids: [m.id], seen: false, flagged: false })).toEqual({});
  expect(m.labels).toContain('^u');
  expect(m.labels.filter((l) => l === '^t' || l.startsWith('^ss_'))).toEqual([]);
  await expect(mail.flag({ ids: [m.id], answered: true })).rejects.toMatchObject({ status: 400 });
  expect(await mail.flag({ ids: [m.id] })).toEqual({});
});

test("mail.move and mail.trash: archive, back to the inbox, into a label, the trash and out; ids kept; Spam not written, Sent not a destination", async () => {
  const mail = mailOf();
  await mail.list({ mailboxId: '^i', limit: 50 });
  const m = fake.gmail.messages.find((x) => !x.pending && !x.localId && x.labels.includes('^i') && !x.labels.includes('^x_3'))!;
  expect(await mail.move({ ids: [m.id], mailboxId: 'all' })).toEqual({ ids: [m.id] });
  expect(m.labels).not.toContain('^i');
  expect(m.labels).toContain('^a');
  expect(await mail.move({ ids: [m.id], mailboxId: '^i' })).toEqual({ ids: [m.id] });
  expect(m.labels).toContain('^i');
  expect(await mail.move({ ids: [m.id], mailboxId: '^x_3' })).toEqual({ ids: [m.id] });
  expect([m.labels.includes('^x_3'), m.labels.includes('^i')]).toEqual([true, false]);
  expect(await mail.trash({ ids: [m.id] })).toEqual({});
  expect([m.labels.includes('^k'), m.labels.includes('^x_3')]).toEqual([true, true]); // your labels stay, as in Gmail
  expect((await mail.list({ mailboxId: '^k', limit: 200 })).messages.map((x) => x.id)).toContain(m.id);
  expect(await mail.move({ ids: [m.id], mailboxId: '^i' })).toEqual({ ids: [m.id] });
  expect([m.labels.includes('^k'), m.labels.includes('^i')]).toEqual([false, true]);
  fake.gmail.relabel(m.id, [], ['^x_3']);
  const writes = fake.gmail.writes;
  await expect(mail.move({ ids: [m.id], mailboxId: '^s' })).rejects.toMatchObject({ status: 501 });
  for (const to of ['^f', '^r', '^scheduled', '^t', '^b']) await expect(mail.move({ ids: [m.id], mailboxId: to })).rejects.toMatchObject({ status: 400 });
  await expect(mail.move({ ids: [m.id], mailboxId: '^x_999' })).rejects.toMatchObject({ status: 404 });
  expect(fake.gmail.writes).toBe(writes);
});

test("writes in part: ids Gmail refused or whose thread is not known come back named; the caller's threadIds place the rest; none known is 404, all refused 422", async () => {
  const fresh = mailOf(); // nothing listed yet: it knows no thread
  const inbox = fake.gmail.messages.filter((x) => !x.pending && !x.localId && x.labels.includes('^i'));
  const a = inbox[0]!;
  const b = inbox.find((x) => x.thread !== a.thread)!;
  await expect(fresh.flag({ ids: [a.id], flagged: true })).rejects.toMatchObject({ status: 404 });
  // Placed by threadIds (decimal, or thread-f:), one unknown.
  expect(await fresh.flag({ ids: [a.id, b.id, '42'], threadIds: [a.thread, `thread-f:${b.thread}`, null], flagged: true })).toEqual({ unknown: ['42'] });
  expect([a.labels.includes('^t'), b.labels.includes('^t')]).toEqual([true, true]);
  // Gmail refusing one of two threads' changes: that one named, the other applied.
  fake.gmail.refuseNext(1);
  const r = await fresh.move({ ids: [a.id, b.id], threadIds: [a.thread, b.thread], mailboxId: 'all' });
  expect(r.refused).toHaveLength(1);
  const [no, yes] = r.refused![0] === a.id ? [a, b] : [b, a];
  expect(r.ids).toEqual([a, b].map((x) => (x === no ? null : x.id)));
  expect([no.labels.includes('^i'), yes.labels.includes('^i')]).toEqual([true, false]);
  // Every change refused: 422, nothing changed.
  fake.gmail.refuseNext(2);
  await expect(fresh.flag({ ids: [a.id, b.id], threadIds: [a.thread, b.thread], flagged: false })).rejects.toMatchObject({ status: 422, callCode: 'refused' });
  expect([a.labels.includes('^t'), b.labels.includes('^t')]).toEqual([true, true]);
  await fresh.flag({ ids: [a.id, b.id], threadIds: [a.thread, b.thread], flagged: false });
  await fresh.move({ ids: [yes.id], threadIds: [yes.thread], mailboxId: '^i' });
  await expect(fresh.flag({ ids: 'x' as any, seen: true })).rejects.toMatchObject({ status: 400 });
});

test('mail.send: a new message with Cc, Bcc and a file, as the page sends one (upload, draft, send); its Message-ID and Gmail id back', async () => {
  const mail = mailOf();
  const me = { email: fake.gmail.me.email, name: 'Pat Example' };
  const file = { filename: 'notes.txt', mime: 'text/plain', bytes: Buffer.from(`Notes ${MARK}\n`) };
  const n = fake.gmail.sent.length;
  const r = await mail.send({ to: [{ email: 'ann@example.org', name: 'Ann Lee' }], cc: [{ email: 'cy@example.org', name: null }], bcc: [{ email: 'bo@example.org', name: null }], subject: `Hello ${MARK}`, text: `Hi Ann,\nsee the notes & all ${MARK}`, files: [file] }, me);
  const s = fake.gmail.sent[n]!;
  expect(s).toMatchObject({ from: me.email, to: ['ann@example.org'], cc: ['cy@example.org'], bcc: ['bo@example.org'], subject: `Hello ${MARK}`, inReplyTo: null });
  expect(s.html).toBe(`<div dir="ltr">Hi Ann,<br>see the notes &amp; all ${MARK}</div>`);
  expect(s.files.map((f) => [f.name, f.mime, f.data.toString()])).toEqual([['notes.txt', 'text/plain', `Notes ${MARK}\n`]]);
  expect(r).toEqual({ messageId: s.messageId, sentId: s.id });
  const msg = fake.gmail.messages.find((x) => x.id === s.id)!;
  expect(msg.labels).toEqual(['^all', '^f']);
  // From must be the account's own address.
  await expect(mail.send({ from: 'other@example.org', to: [{ email: 'ann@example.org', name: null }], cc: [], bcc: [], subject: 's', text: 't', files: [] }, me)).rejects.toMatchObject({ status: 422, callCode: 'from' });
  // A draft Gmail refuses: 422, nothing sent.
  fake.gmail.refuseNext(1);
  await expect(mail.send({ to: [{ email: 'ann@example.org', name: null }], cc: [], bcc: [], subject: 's', text: 't', files: [] }, me)).rejects.toMatchObject({ status: 422, callCode: 'refused' });
  expect(fake.gmail.sent.length).toBe(n + 1);
});

test("mail.send a reply: in the answered message's thread, In-Reply-To its Message-ID, the original marked replied (answered)", async () => {
  const mail = mailOf();
  const orig = fake.gmail.messages.find((x) => !x.pending && !x.localId && x.labels.includes('^i') && !x.attachment)!;
  const me = { email: fake.gmail.me.email, name: null };
  const r = await mail.send({ to: [{ email: orig.from.email, name: orig.from.name ?? null }], cc: [], bcc: [], subject: `Re: ${orig.subject}`, html: `<div dir="ltr">Yes ${MARK}</div>`, replyTo: orig.id, files: [] }, me);
  const s = fake.gmail.sent.at(-1)!;
  expect([s.thread, s.inReplyTo, s.html, r.sentId]).toEqual([orig.thread, orig.messageId, `<div dir="ltr">Yes ${MARK}</div>`, s.id]);
  expect(orig.labels).toContain('^io_re');
  // Gmail's sync now carries the reply's headers, and the original reads as answered.
  const c = await mail.changes({ mailboxId: 'all', state: `g1.${fake.gmail.history() - 3}.${Date.now() - 60_000}` });
  const reply = [...c.added, ...c.changed].find((x) => x.id === s.id);
  expect(reply).toMatchObject({ messageId: s.messageId, inReplyTo: orig.messageId, references: [orig.messageId], threadId: orig.thread });
  expect([...c.added, ...c.changed].find((x) => x.id === orig.id)?.flags.answered).toBe(true);
  // A reply to a message that is not there: 404 before anything is written.
  const writes = fake.gmail.writes;
  await expect(mail.send({ to: [{ email: orig.from.email, name: null }], cc: [], bcc: [], subject: 'Re', text: 'x', replyTo: '42', files: [] }, me)).rejects.toMatchObject({ status: 404 });
  expect(fake.gmail.writes).toBe(writes);
});

test("checkOutgoing: addresses, body, files and sizes checked before anything reaches Gmail", () => {
  const ok = { to: [{ email: 'ann@example.org', name: null }], subject: 'Hi', text: 'x' };
  expect(checkOutgoing(ok as any, tmp)).toMatchObject({ to: [{ email: 'ann@example.org', name: null }], cc: [], bcc: [], files: [] });
  expect(() => checkOutgoing({ ...ok, to: [{ email: 'not an address' }] } as any, tmp)).toThrow(expect.objectContaining({ status: 400 }));
  expect(() => checkOutgoing({ ...ok, to: [], cc: [] } as any, tmp)).toThrow(expect.objectContaining({ status: 400 }));
  expect(() => checkOutgoing({ ...ok, text: undefined } as any, tmp)).toThrow(expect.objectContaining({ status: 400 }));
  expect(() => checkOutgoing({ ...ok, replyTo: 'not-ours' } as any, tmp)).toThrow(expect.objectContaining({ status: 404 }));
  expect(() => checkOutgoing({ ...ok, attachments: [{ filename: 'a.bin', mime: 'application/octet-stream', base64: Buffer.alloc(26 * 1024 * 1024).toString('base64') }] } as any, tmp)).toThrow(expect.objectContaining({ status: 413 }));
  writeFileSync(join(tmp, 'x.txt'), 'the account\'s own');
  expect(() => checkOutgoing({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', path: join(tmp, 'x.txt') }] } as any, tmp)).toThrow(expect.objectContaining({ status: 403 }));
  expect(checkOutgoing({ ...ok, subject: 'a\r\nBcc: x@example.org' } as any, tmp).subject).toBe('a Bcc: x@example.org');
});
