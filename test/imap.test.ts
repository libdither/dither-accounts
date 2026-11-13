/**
 * The imap extractor against a real Dovecot (QRESYNC and CONDSTORE on) and an SMTP sink, through a throwaway manager
 * and an app on its wire: every mail op, IDLE events, UIDVALIDITY → 410, a bad password, the server going away and
 * coming back, a restart that keeps its state, and a certificate change refused under pinning.
 *
 * Ports 18550 (IMAP, STARTTLS), 18551 (IMAPS), 18552 (SMTP), 18560 (an SMTP server that starts late). Dovecot comes
 * from nix (or DOVECOT_BIN).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Harness, simpleParser, until } from '../extractors/imap/test/harness.ts';
import { Dovecot, rfc822, SmtpSink, type User } from '../extractors/imap/test/servers.ts';
import { dovecot, why } from './needs.ts';

const ok = why('Dovecot (from nixpkgs, or DOVECOT_BIN)', dovecot);
const it = test.skipIf(!ok);

const alice: User = { email: 'alice@example.test', password: 'alice-pw-1' };
const bob: User = { email: 'bob@example.test', password: 'bob-pw-2' };
const IMAP = 18550;
const IMAPS = 18551;
const SMTP = 18552;
const LATE_SMTP = 18560;

let dv: Dovecot;
let sink: SmtpSink;
const h = new Harness();
let acc: string;
let mbox: Record<string, string> = {};

const config = (over: Record<string, unknown> = {}) => ({
  email: alice.email,
  provider: 'custom',
  name: 'Alice Test',
  imapHost: '127.0.0.1',
  imapPort: String(IMAP),
  imapSecurity: 'starttls',
  smtpHost: '127.0.0.1',
  smtpPort: String(SMTP),
  smtpSecurity: 'starttls',
  certificate: 'pin',
  sentCopy: 'detect',
  ...over,
});

/** Another mail program's view of alice's mailbox. */
async function other<T>(f: (c: Awaited<ReturnType<Dovecot['client']>>) => Promise<T>, user = alice): Promise<T> {
  const c = await dv.client(user);
  try {
    return await f(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
}

beforeAll(async () => {
  if (!ok) return;
  dv = new Dovecot({ imapPort: IMAP, imapsPort: IMAPS, users: [alice, bob] });
  await dv.start();
  sink = new SmtpSink(SMTP, [alice, bob], dv, dv.cert);
  await sink.start();
  // Sixty messages, oldest first, and a few with parts worth reading.
  await other(async (c) => {
    for (let i = 1; i <= 60; i++) await c.append('INBOX', rfc822({ subject: `Note ${i}`, text: `body of note ${i}`, date: new Date(Date.UTC(2026, 0, 1, 0, i)) }), [], new Date(Date.UTC(2026, 0, 1, 0, i)));
    await c.append('INBOX', rfc822({ subject: 'Quarterly report', text: 'See the attached figures, zebra.', html: '<p>See the <b>attached</b> figures, zebra.</p>', attachment: { filename: 'figures.bin', mime: 'application/octet-stream', data: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)) }, messageId: '<report@example.test>', references: '<earlier@example.test>' }));
    await c.append('INBOX', rfc822({ subject: 'Only HTML', html: '<html><body><h1>Hello</h1><p>an html-only letter</p></body></html>' }));
    await c.append('INBOX', rfc822({ subject: 'Latin-1', text: 'caf\xe9 cr\xe8me', charset: 'iso-8859-1' }));
  });
  await h.start();
}, 300_000);

afterAll(async () => {
  if (!ok) return;
  await h.stop();
  await sink?.stop();
  await dv?.cleanup();
});

describe('adding and signing in', () => {
  it('added as the page does: online, its layers, self, details, and the certificate pinned on first connect', async () => {
    acc = await h.add(config(), alice.password, 'Alice');
    await h.waitOnline(acc);
    await until(async () => (await h.layer(acc, 'SMTP'))?.state === 'ok', 15_000, 'SMTP signed in');
    const d = await h.detail(acc);
    expect(d.layers.map((l: any) => l.name)).toEqual(['server', 'TLS', 'signed in', 'inbox', 'IDLE', 'SMTP']);
    expect(d.layers.every((l: any) => l.state === 'ok')).toBe(true);
    expect(d.account.self).toMatchObject({ name: 'Alice Test', detail: alice.email });
    expect(d.status.details).toMatchObject({ email: alice.email, sync: 'QRESYNC', certificate: `pinned SHA-256 ${dv.cert.fingerprint}` });
    // What an app needs to send: whether it can, and as whom.
    await until(async () => (await h.detail(acc)).status.details.canSend === true, 5000, 'canSend');
    expect((await h.detail(acc)).status.details.sendNote).toBeNull();
    expect(d.status.self).toEqual({ email: alice.email, displayName: 'Alice Test', addresses: [{ email: alice.email, name: 'Alice Test' }] });
    expect(d.hello).toMatchObject({ network: 'imap', interfaces: ['mail'] });
    const pins = JSON.parse(readFileSync(join(h.accountDir(acc), 'tls-pins.json'), 'utf8'));
    expect(pins[`imap 127.0.0.1:${IMAP}`].fingerprint).toBe(dv.cert.fingerprint);
    expect(pins[`smtp 127.0.0.1:${SMTP}`].fingerprint).toBe(dv.cert.fingerprint);
    // The password stays in secret.json, never in the config or the page.
    expect(JSON.stringify(d.config)).not.toContain(alice.password);
    expect(d.secret).toEqual({ present: true, keys: ['password'] });
  }, 60_000);

  it('mail.mailboxes: SPECIAL-USE roles and counts', async () => {
    const { mailboxes } = await h.call(acc, 'mail.mailboxes', {});
    const byRole = Object.fromEntries(mailboxes.filter((b: any) => b.role).map((b: any) => [b.role, b]));
    expect(Object.keys(byRole).sort()).toEqual(['archive', 'drafts', 'inbox', 'junk', 'sent', 'trash']);
    expect(byRole.inbox).toMatchObject({ path: 'INBOX', name: 'INBOX', parentId: null, total: 63, unread: 63 });
    for (const b of mailboxes) mbox[b.role ?? b.path] = b.id;
  });
});

describe('reading', () => {
  let report: any;

  it('mail.list: newest first, a page at a time, to the end', async () => {
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const r = await h.call(acc, 'mail.list', { mailboxId: mbox.inbox, limit: 25, ...(before ? { before } : {}) });
      pages++;
      seen.push(...r.messages.map((m: any) => m.subject));
      if (!r.next) break;
      before = r.next;
    }
    expect(pages).toBe(3);
    expect(seen.length).toBe(63);
    expect(seen.slice(0, 4)).toEqual(['Latin-1', 'Only HTML', 'Quarterly report', 'Note 60']);
    expect(seen.at(-1)).toBe('Note 1');
    expect(new Set(seen).size).toBe(63);
    const first = (await h.call(acc, 'mail.list', { mailboxId: mbox.inbox, limit: 3 })).messages;
    report = first.find((m: any) => m.subject === 'Quarterly report');
    expect(report).toMatchObject({
      mailboxId: mbox.inbox,
      messageId: '<report@example.test>',
      threadId: null,
      from: [{ name: 'Carol Sender', email: 'carol@example.test' }],
      to: [{ name: 'Alice', email: 'alice@example.test' }],
      cc: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      hasAttachments: true,
      preview: null,
      inReplyTo: null,
      references: ['<earlier@example.test>'],
    });
    expect(report.bulk).toBeUndefined();
    expect(report.size).toBeGreaterThan(5000);
    expect(first.find((m: any) => m.subject === 'Only HTML').hasAttachments).toBe(false);
  });

  it('mail.list since a time', async () => {
    const r = await h.call(acc, 'mail.list', { mailboxId: mbox.inbox, since: Date.UTC(2026, 0, 1, 0, 55) });
    // Notes 55..60 by their arrival time, and the three appended now.
    expect(r.messages.map((m: any) => m.subject)).toEqual(['Latin-1', 'Only HTML', 'Quarterly report', 'Note 60', 'Note 59', 'Note 58', 'Note 57', 'Note 56', 'Note 55']);
  });

  it('mail.get: text, HTML, threading headers, attachments; text from HTML; a charset', async () => {
    const m = await h.call(acc, 'mail.get', { id: report.id });
    expect(m.text.trim()).toBe('See the attached figures, zebra.');
    expect(m.html).toContain('<b>attached</b>');
    expect(m.references).toEqual(['<earlier@example.test>']);
    expect(m.inReplyTo).toBeNull();
    expect(m.attachments).toEqual([{ id: '2', filename: 'figures.bin', mime: 'application/octet-stream', size: expect.any(Number), inline: false, contentId: null }]);
    expect(Math.abs(m.attachments[0].size - 5000)).toBeLessThan(100);
    const list = (await h.call(acc, 'mail.list', { mailboxId: mbox.inbox, limit: 3 })).messages;
    const html = await h.call(acc, 'mail.get', { id: list.find((x: any) => x.subject === 'Only HTML').id });
    expect(html.html).toContain('<h1>Hello</h1>');
    expect(html.text).toContain('an html-only letter');
    const latin = await h.call(acc, 'mail.get', { id: list.find((x: any) => x.subject === 'Latin-1').id });
    expect(latin.text.trim()).toBe('café crème');
    // Reading it does not mark it read (BODY.PEEK).
    expect((await h.call(acc, 'mail.get', { id: report.id })).flags.seen).toBe(false);
    expect(await h.fails(acc, 'mail.get', { id: report.id.replace(/\.\d+$/, '.99999') })).toMatchObject({ status: 404 });
    // The manager puts its call id in the command's `id`: the plain call says what to do, or works once that is fixed.
    const plain: any = await h.app.callRaw(acc, 'mail.get', { id: report.id }).catch((e) => e);
    if (plain instanceof Error) expect(plain.message).toContain('send the message id as `message` too');
    else expect(plain.subject).toBe('Quarterly report');
  });

  it("mail.raw: the whole message as the server keeps it, without marking it read; the status says raw 'original'", async () => {
    const seenBefore = (await h.call(acc, 'mail.get', { id: report.id })).flags.seen;
    const r = await h.call(acc, 'mail.raw', { id: report.id });
    expect(r).toMatchObject({ filename: null, mime: 'message/rfc822' });
    const buf = Buffer.from(r.base64, 'base64');
    expect(r.size).toBe(buf.length);
    const parsed = await simpleParser(buf);
    expect(parsed.subject).toBe('Quarterly report');
    expect(parsed.messageId).toBe('<report@example.test>');
    expect(parsed.attachments.map((a: any) => a.filename)).toEqual(['figures.bin']);
    const after = (await h.call(acc, 'mail.list', { mailboxId: mbox.inbox, limit: 100 })).messages.find((m: any) => m.id === report.id);
    expect(after.flags.seen).toBe(seenBefore);
    expect((await h.detail(acc)).status.details.raw).toBe('original');
    expect(await h.fails(acc, 'mail.raw', { id: report.id.replace(/\d+$/, '999999') })).toMatchObject({ status: 404 });
  });

  it('mail.attachment: the bytes as base64, and nothing over 25 MB', async () => {
    const a = await h.call(acc, 'mail.attachment', { id: report.id, attachmentId: '2' });
    expect(a).toMatchObject({ filename: 'figures.bin', mime: 'application/octet-stream' });
    expect(Buffer.from(a.base64, 'base64').equals(Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)))).toBe(true);
    expect(await h.fails(acc, 'mail.attachment', { id: report.id, attachmentId: '7' })).toMatchObject({ status: 404 });
    await other((c) => c.append('Archive', rfc822({ subject: 'Huge', text: 'big', attachment: { filename: 'big.bin', mime: 'application/octet-stream', data: Buffer.alloc(26 * 1024 * 1024, 7) } })));
    const huge = (await h.call(acc, 'mail.list', { mailboxId: mbox.archive, limit: 1 })).messages[0];
    expect(huge.subject).toBe('Huge');
    expect(await h.fails(acc, 'mail.attachment', { id: huge.id, attachmentId: '2' })).toMatchObject({ status: 413 });
    await other(async (c) => {
      await c.mailboxOpen('Archive');
      await c.messageDelete('1:*');
    });
  }, 60_000);

  it('mail.search: words in sender, subject or text, server-side, newest first', async () => {
    expect((await h.call(acc, 'mail.search', { query: 'zebra', mailboxId: mbox.inbox })).messages.map((m: any) => m.subject)).toEqual(['Quarterly report']);
    expect((await h.call(acc, 'mail.search', { query: 'quarterly figures' })).messages.map((m: any) => m.subject)).toEqual(['Quarterly report']);
    expect((await h.call(acc, 'mail.search', { query: 'carol', limit: 5 })).messages.map((m: any) => m.subject)).toEqual(['Latin-1', 'Only HTML', 'Quarterly report', 'Note 60', 'Note 59']);
    expect((await h.call(acc, 'mail.search', { query: 'zebra nowhere-at-all' })).messages).toEqual([]);
    expect(await h.fails(acc, 'mail.search', { query: '  ' })).toMatchObject({ status: 400 });
  });

  it('a forwarded message is an attachment of its own; a mailbox that is not there is 404', async () => {
    const inner = rfc822({ subject: 'The inner one', text: 'forwarded body' }).toString();
    const raw = [
      'From: Carol <carol@example.test>', 'To: Alice <alice@example.test>', 'Subject: Fwd: The inner one', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="fw1"', '', '--fw1', 'Content-Type: text/plain', '', 'see below', '--fw1',
      'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="inner.eml"', '', inner, '--fw1--', '',
    ].join('\r\n');
    await other((c) => c.append('Drafts', raw));
    const fw = (await h.call(acc, 'mail.list', { mailboxId: mbox.drafts })).messages[0];
    const m = await h.call(acc, 'mail.get', { id: fw.id });
    expect(m.text.trim()).toBe('see below');
    expect(m.attachments).toMatchObject([{ id: '2', mime: 'message/rfc822', filename: 'inner.eml', inline: false }]);
    const a = await h.call(acc, 'mail.attachment', { id: fw.id, attachmentId: '2' });
    expect(Buffer.from(a.base64, 'base64').toString()).toContain('Subject: The inner one');
    await other(async (c) => {
      await c.mailboxOpen('Drafts');
      await c.messageDelete('1:*');
    });
    const gone = Buffer.from('No/Such/Box').toString('base64url');
    expect(await h.fails(acc, 'mail.list', { mailboxId: gone })).toMatchObject({ status: 404 });
    expect(await h.fails(acc, 'mail.list', { mailboxId: 'not base64!' })).toMatchObject({ status: 404 });
  });

  it('summaries carry threading and bulk headers (folded, capped, never marking read); mail.get keeps every reference', async () => {
    const refs = Array.from({ length: 25 }, (_, i) => `<r${i}@thread.example.test>`);
    await other(async (c) => {
      await c.mailboxCreate('Lists');
      // References folded over three lines, as long ones are.
      await c.append('Lists', rfc822({ from: 'Dan <dan@example.test>', subject: 'Re: the long thread', text: 'deep in it', inReplyTo: '<r24@thread.example.test>', references: `${refs.slice(0, 12).join(' ')}\r\n ${refs.slice(12, 20).join(' ')}\r\n\t${refs.slice(20).join(' ')}` }));
      await c.append(
        'Lists',
        rfc822({
          from: 'The List <news@lists.example.test>',
          subject: 'Weekly digest',
          text: 'news',
          headers: { 'List-Id': '"Weekly News" <weekly.lists.example.test>', 'List-Unsubscribe': '<https://lists.example.test/u/1>,\r\n <mailto:leave@lists.example.test>', Precedence: 'list', 'Auto-Submitted': 'y'.repeat(400) },
        }),
      );
      await c.append('Lists', rfc822({ from: 'Robot <robot@example.test>', subject: 'Your build', text: 'done', inReplyTo: 'bare-id@ci.example.test', headers: { 'Auto-Submitted': 'auto-generated' } }));
    });
    const lists = (await h.call(acc, 'mail.mailboxes', {})).mailboxes.find((b: any) => b.path === 'Lists');
    const page = (await h.call(acc, 'mail.list', { mailboxId: lists.id })).messages;
    const by = Object.fromEntries(page.map((m: any) => [m.subject, m]));
    const deep = by['Re: the long thread'];
    expect(deep.inReplyTo).toBe('<r24@thread.example.test>');
    // Twenty of twenty-five: the root and the last nineteen, oldest first.
    expect(deep.references).toEqual([refs[0], ...refs.slice(6)]);
    expect(deep.bulk).toBeUndefined();
    expect(by['Weekly digest']).toMatchObject({ inReplyTo: null, references: [] });
    expect(by['Weekly digest'].bulk).toEqual({ listId: '"Weekly News" <weekly.lists.example.test>', unsubscribe: '<https://lists.example.test/u/1>, <mailto:leave@lists.example.test>', precedence: 'list', autoSubmitted: 'y'.repeat(300) });
    expect(by['Your build']).toMatchObject({ inReplyTo: '<bare-id@ci.example.test>', references: [], bulk: { listId: null, unsubscribe: null, precedence: null, autoSubmitted: 'auto-generated' } });
    const full = await h.call(acc, 'mail.get', { id: deep.id });
    expect([full.inReplyTo, full.references]).toEqual(['<r24@thread.example.test>', refs]);
    expect((await h.call(acc, 'mail.search', { query: 'digest', mailboxId: lists.id })).messages[0].bulk.precedence).toBe('list');
    // The header fetch is a PEEK: nothing became read.
    expect((await h.call(acc, 'mail.list', { mailboxId: lists.id })).messages.map((m: any) => m.flags.seen)).toEqual([false, false, false]);
    await other((c) => c.mailboxDelete('Lists'));
  });
});

describe('keeping up', () => {
  it('mail.changes (QRESYNC): a state, then what was added, changed and removed by another program', async () => {
    const start = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox });
    expect(start).toMatchObject({ added: [], changed: [], removed: [], more: false });
    expect(start.state).toMatch(/^q\./);
    const same = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox, state: start.state });
    expect(same).toMatchObject({ state: start.state, added: [], changed: [], removed: [] });
    const notes = (await h.call(acc, 'mail.list', { mailboxId: mbox.inbox, limit: 63 })).messages.filter((m: any) => /^Note (1|2|3)$/.test(m.subject));
    const n = Object.fromEntries(notes.map((m: any) => [m.subject, m]));
    await other(async (c) => {
      await c.mailboxOpen('INBOX');
      const uid = (id: string) => id.split('.').pop()!;
      await c.messageFlagsAdd(uid(n['Note 1'].id), ['\\Flagged', '$Work'], { uid: true });
      await c.messageDelete(uid(n['Note 2'].id), { uid: true });
      for (let i = 0; i < 5; i++) await c.append('INBOX', rfc822({ subject: `Fresh ${i}`, text: 'new', ...(i === 0 ? { inReplyTo: '<report@example.test>', references: '<earlier@example.test> <report@example.test>', headers: { 'List-Id': '<fresh.example.test>' } } : {}) }));
    });
    const ch = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox, state: start.state, limit: 3 });
    expect(ch.more).toBe(true);
    expect(ch.added.map((m: any) => m.subject)).toEqual(['Fresh 0', 'Fresh 1', 'Fresh 2']);
    expect(ch.added[0]).toMatchObject({ inReplyTo: '<report@example.test>', references: ['<earlier@example.test>', '<report@example.test>'], bulk: { listId: '<fresh.example.test>', unsubscribe: null, precedence: null, autoSubmitted: null } });
    expect(ch.added[1]).toMatchObject({ inReplyTo: null, references: [] });
    expect(ch.added[1].bulk).toBeUndefined();
    expect(ch.changed).toEqual([{ id: n['Note 1'].id, flags: { seen: false, flagged: true, answered: false, draft: false }, labels: ['$Work'] }]);
    expect(ch.removed).toEqual([n['Note 2'].id]);
    const rest = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox, state: ch.state, limit: 3 });
    expect(rest).toMatchObject({ more: false, changed: [], removed: [] });
    expect(rest.added.map((m: any) => m.subject)).toEqual(['Fresh 3', 'Fresh 4']);
    const done = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox, state: rest.state });
    expect(done).toMatchObject({ added: [], changed: [], removed: [], more: false });
    expect(await h.fails(acc, 'mail.changes', { mailboxId: mbox.inbox, state: 'nonsense' })).toMatchObject({ status: 400 });
  });

  it('IDLE: mail.arrived and mail.changed as another program delivers and marks', async () => {
    const from = h.events.length;
    await other((c) => c.append('INBOX', rfc822({ subject: 'Live one', text: 'pushed', messageId: '<live@example.test>', inReplyTo: '<report@example.test>', references: '<report@example.test>', headers: { Precedence: 'bulk' } })));
    const arrived = await h.event((e) => e.t === 'mail.arrived' && e.message.subject === 'Live one', 15_000, from);
    expect(arrived.account).toBe(acc);
    expect(arrived.message).toMatchObject({ mailboxId: mbox.inbox, messageId: '<live@example.test>', flags: { seen: false }, inReplyTo: '<report@example.test>', references: ['<report@example.test>'] });
    expect(arrived.message.bulk).toEqual({ listId: null, unsubscribe: null, precedence: 'bulk', autoSubmitted: null });
    const changed = await h.event((e) => e.t === 'mail.changed' && e.mailboxId === mbox.inbox, 15_000, from);
    expect(changed.state).toMatch(/^q\./);
    const from2 = h.events.length;
    await other(async (c) => {
      await c.mailboxOpen('INBOX');
      await c.messageFlagsAdd(arrived.message.id.split('.').pop(), ['\\Seen'], { uid: true });
    });
    const again = await h.event((e) => e.t === 'mail.changed' && e.mailboxId === mbox.inbox, 15_000, from2);
    const ch = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox, state: changed.state });
    expect(ch.changed.map((x: any) => [x.id, x.flags.seen])).toEqual([[arrived.message.id, true]]);
    expect(again.state).not.toBe(changed.state);
  }, 40_000);

  it('a changed UIDVALIDITY answers 410 for states, cursors and ids', async () => {
    await other(async (c) => {
      await c.mailboxCreate('Work');
      for (let i = 0; i < 4; i++) await c.append('Work', rfc822({ subject: `Work ${i}`, text: 'w' }));
    });
    const work = (await h.call(acc, 'mail.mailboxes', {})).mailboxes.find((b: any) => b.path === 'Work');
    expect(work).toMatchObject({ role: null, total: 4 });
    const st = (await h.call(acc, 'mail.changes', { mailboxId: work.id })).state;
    const page = await h.call(acc, 'mail.list', { mailboxId: work.id, limit: 2 });
    await other(async (c) => {
      await c.mailboxDelete('Work');
      await Bun.sleep(1100);
      await c.mailboxCreate('Work');
      await c.append('Work', rfc822({ subject: 'Work again', text: 'w' }));
    });
    expect(await h.fails(acc, 'mail.changes', { mailboxId: work.id, state: st })).toMatchObject({ status: 410 });
    expect(await h.fails(acc, 'mail.list', { mailboxId: work.id, before: page.next })).toMatchObject({ status: 410 });
    expect(await h.fails(acc, 'mail.get', { id: page.messages[0].id })).toMatchObject({ status: 410 });
    expect((await h.call(acc, 'mail.list', { mailboxId: work.id })).messages.map((m: any) => m.subject)).toEqual(['Work again']);
  });
});

describe('writing', () => {
  let notes: any[];
  const latest = async (box: string, n = 70) => (await h.call(acc, 'mail.list', { mailboxId: box, limit: n })).messages;

  it('mail.flag: read, flagged, answered, and back', async () => {
    notes = (await latest(mbox.inbox)).filter((m: any) => /^Note (10|11|12)$/.test(m.subject));
    const ids = notes.map((m: any) => m.id);
    await h.call(acc, 'mail.flag', { ids, seen: true, flagged: true });
    for (const id of ids) expect((await h.call(acc, 'mail.get', { id })).flags).toEqual({ seen: true, flagged: true, answered: false, draft: false });
    await h.call(acc, 'mail.flag', { ids: [ids[0]], seen: false, answered: true });
    expect((await h.call(acc, 'mail.get', { id: ids[0] })).flags).toEqual({ seen: false, flagged: true, answered: true, draft: false });
    const seenByOther = await other(async (c) => {
      await c.mailboxOpen('INBOX');
      const m = await c.fetchOne(ids[1].split('.').pop(), { flags: true }, { uid: true });
      return m ? [...m.flags!].filter((f) => f.startsWith('\\')).sort() : [];
    });
    expect(seenByOther).toEqual(['\\Flagged', '\\Seen']);
  });

  it('mail.move: their new ids, from COPYUID; the old ones are gone', async () => {
    const ids = notes.map((m: any) => m.id);
    const { ids: moved } = await h.call(acc, 'mail.move', { ids, mailboxId: mbox.archive });
    expect(moved.length).toBe(3);
    for (const [i, id] of moved.entries()) {
      expect(id.startsWith(`${mbox.archive}.`)).toBe(true);
      expect((await h.call(acc, 'mail.get', { id })).subject).toBe(notes[i].subject);
      expect(await h.fails(acc, 'mail.get', { id: ids[i] })).toMatchObject({ status: 404 });
    }
    notes = moved.map((id: string, i: number) => ({ ...notes[i], id }));
  });

  it('mail.trash: to Trash; from Trash, deleted outright', async () => {
    await h.call(acc, 'mail.trash', { ids: [notes[0].id] });
    const inTrash = await latest(mbox.trash);
    expect(inTrash.map((m: any) => m.subject)).toEqual([notes[0].subject]);
    expect((await latest(mbox.archive)).map((m: any) => m.subject).sort()).toEqual([notes[1].subject, notes[2].subject].sort());
    await h.call(acc, 'mail.trash', { ids: [inTrash[0].id] });
    expect(await latest(mbox.trash)).toEqual([]);
  });

  it('mail.send: SMTP with threading headers, Bcc kept out, attachments from base64 and a path; a copy in Sent; the original answered', async () => {
    const original = (await latest(mbox.inbox, 70)).find((m: any) => m.subject === 'Quarterly report');
    const file = join(h.dir, 'notes.txt');
    writeFileSync(file, 'attached from a path\n');
    const from = h.events.length;
    const r = await h.call(acc, 'mail.send', {
      // One of the account's addresses, in any case.
      from: 'Alice@Example.TEST',
      to: [{ name: 'Bob', email: bob.email }],
      cc: [{ name: null, email: 'carol@example.test' }],
      bcc: [{ name: null, email: 'dave@example.test' }],
      subject: 'Re: Quarterly report',
      text: 'Thanks, figures look good.',
      html: '<p>Thanks, figures look <i>good</i>.</p>',
      replyTo: original.id,
      attachments: [
        { filename: 'tiny.bin', mime: 'application/octet-stream', base64: Buffer.from([1, 2, 3, 4]).toString('base64') },
        { filename: 'notes.txt', mime: 'text/plain', path: file },
      ],
    });
    expect(r.messageId).toMatch(/^<[\w-]+@example\.test>$/);
    expect(r.sentId).toMatch(new RegExp(`^${mbox.sent}\\.`));
    const got = sink.received.find((x) => x.raw.toString().includes(r.messageId))!;
    expect(got.user).toBe(alice.email);
    expect(got.from).toBe(alice.email);
    expect(got.to.sort()).toEqual([bob.email, 'carol@example.test', 'dave@example.test'].sort());
    const p = await simpleParser(got.raw);
    expect(p.inReplyTo).toBe('<report@example.test>');
    expect(p.references).toEqual(['<earlier@example.test>', '<report@example.test>']);
    expect(p.headers.has('bcc')).toBe(false);
    expect(p.from?.value[0]).toMatchObject({ name: 'Alice Test', address: alice.email });
    expect(p.attachments.map((a) => [a.filename, a.content.toString('base64')])).toEqual([
      ['tiny.bin', 'AQIDBA=='],
      ['notes.txt', Buffer.from('attached from a path\n').toString('base64')],
    ]);
    // In Sent with its Bcc, and in bob's inbox without.
    const sent = await h.call(acc, 'mail.get', { id: r.sentId });
    expect(sent).toMatchObject({ messageId: r.messageId, subject: 'Re: Quarterly report', inReplyTo: '<report@example.test>', flags: { seen: true } });
    expect(sent.bcc).toEqual([{ name: null, email: 'dave@example.test' }]);
    const bobs = await other(async (c) => {
      await c.mailboxOpen('INBOX');
      return (await c.search({ header: { 'message-id': r.messageId } }, { uid: true })) || [];
    }, bob);
    expect(bobs.length).toBe(1);
    expect((await h.call(acc, 'mail.get', { id: original.id })).flags.answered).toBe(true);
    await h.event((e) => e.t === 'mail.changed' && e.mailboxId === mbox.sent, 10_000, from);
  }, 30_000);

  it("mail.send refuses what it should: another From, no recipients, no body, the account's own files", async () => {
    const before = sink.received.length;
    const refused = await h.fails(acc, 'mail.send', { from: 'mallory@example.test', to: [{ name: null, email: bob.email }], subject: 'x', text: 'y' });
    expect(refused).toMatchObject({ status: 422 });
    expect(refused.message).not.toContain('mallory');
    expect(await h.fails(acc, 'mail.send', { from: 3, to: [{ name: null, email: bob.email }], subject: 'x', text: 'y' })).toMatchObject({ status: 400 });
    expect(sink.received.length).toBe(before);
    expect(await h.fails(acc, 'mail.send', { to: [], subject: 'x', text: 'y' })).toMatchObject({ status: 400 });
    expect(await h.fails(acc, 'mail.send', { to: [{ name: null, email: bob.email }], subject: 'x' })).toMatchObject({ status: 400 });
    const secret = join(h.accountDir(acc), 'secret.json');
    expect(await h.fails(acc, 'mail.send', { to: [{ name: null, email: bob.email }], subject: 'x', text: 'y', attachments: [{ filename: 's', mime: 'text/plain', path: secret }] })).toMatchObject({ status: 403 });
    expect(await h.fails(acc, 'mail.send', { to: [{ name: null, email: bob.email }], subject: 'x', text: 'y', attachments: [{ filename: 's', mime: 'text/plain', path: 'relative.txt' }] })).toMatchObject({ status: 400 });
  });
});

describe('when things go wrong', () => {
  it('a bad password: attention, the signed-in layer failed, calls answer 401, nothing retried', async () => {
    const bad = await h.add(config(), 'wrong-password', 'Bad');
    await until(async () => (await h.detail(bad)).status?.status === 'attention', 20_000, 'attention');
    const d = await h.detail(bad);
    expect(d.status.attention).toMatchObject({ kind: 'login' });
    expect(d.status.attention.message).toContain('refused the password');
    expect(d.layers.find((l: any) => l.name === 'signed in')).toMatchObject({ state: 'failed' });
    expect(d.layers.find((l: any) => l.name === 'server')).toMatchObject({ state: 'ok' });
    expect(await h.fails(bad, 'mail.mailboxes', {})).toMatchObject({ status: 401 });
    // SMTP refused it too: it cannot send, and says why.
    await until(async () => (await h.detail(bad)).status?.details?.canSend === false && /refused the password/.test((await h.detail(bad)).status.details.sendNote ?? ''), 15_000, 'canSend false');
    // A new password (the manager writes secret.json, without a restart): it signs in again by itself.
    writeFileSync(join(h.accountDir(bad), 'secret.json'), JSON.stringify({ password: alice.password }));
    await h.waitOnline(bad, 20_000);
    expect((await h.call(bad, 'mail.mailboxes', {})).mailboxes.length).toBeGreaterThan(5);
    await fetch(`${h.m.url}/api/accounts/${bad}`, { method: 'DELETE' });
  }, 60_000);

  it('canSend: false while the SMTP server does not answer (reading goes on), true by itself once it does', async () => {
    const id = await h.add(config({ smtpPort: String(LATE_SMTP) }), alice.password, 'SMTP later');
    await h.waitOnline(id);
    await until(async () => (await h.layer(id, 'SMTP'))?.state === 'failed' && (await h.detail(id)).status.details.canSend === false, 20_000, 'SMTP failed');
    const d = await h.detail(id);
    expect(d.status.status).toBe('online');
    expect(d.status.details.sendNote).toContain('tries the SMTP server again by itself');
    const late = new SmtpSink(LATE_SMTP, [alice, bob], dv, dv.cert);
    await late.start();
    try {
      await until(async () => (await h.detail(id)).status.details.canSend === true, 30_000, 'canSend again');
      expect((await h.detail(id)).status.details.sendNote).toBeNull();
      expect((await h.layer(id, 'SMTP'))?.state).toBe('ok');
    } finally {
      await fetch(`${h.m.url}/api/accounts/${id}`, { method: 'DELETE' });
      await late.stop();
    }
  }, 60_000);

  it('the server goes away: layers say so, calls answer 503; it comes back and IDLE resumes', async () => {
    await dv.stop();
    await until(async () => (await h.layer(acc, 'server'))?.state === 'failed', 30_000, 'server failed');
    expect((await h.detail(acc)).status.status).toBe('offline');
    expect(await h.fails(acc, 'mail.mailboxes', {})).toMatchObject({ status: 503 });
    await dv.start();
    await h.waitOnline(acc, 90_000);
    const from = h.events.length;
    await other((c) => c.append('INBOX', rfc822({ subject: 'After the outage', text: 'back' })));
    await h.event((e) => e.t === 'mail.arrived' && e.message.subject === 'After the outage', 15_000, from);
    expect((await h.call(acc, 'mail.mailboxes', {})).mailboxes.length).toBeGreaterThan(5);
  }, 150_000);

  it('a restart keeps its state: old states still answer, and what came meanwhile is announced', async () => {
    const st = (await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox })).state;
    await h.enable(acc, false);
    await other((c) => c.append('INBOX', rfc822({ subject: 'While it slept', text: 'zz' })));
    const from = h.events.length;
    const t = Date.now();
    await h.enable(acc, true);
    await h.waitOnline(acc, 30_000, t);
    await h.event((e) => e.t === 'mail.arrived' && e.message.subject === 'While it slept', 15_000, from);
    const ch = await h.call(acc, 'mail.changes', { mailboxId: mbox.inbox, state: st });
    expect(ch.added.map((m: any) => m.subject)).toEqual(['While it slept']);
    expect(existsSync(join(h.accountDir(acc), 'watch.json'))).toBe(true);
  }, 60_000);

  it('pinned: a new certificate is refused (nothing is sent to it), and trusted again only when you say so', async () => {
    const old = dv.cert.fingerprint;
    dv.newCert();
    await dv.restart();
    await until(async () => (await h.detail(acc)).status?.status === 'attention', 60_000, 'attention for the certificate');
    const d = await h.detail(acc);
    expect(d.layers.find((l: any) => l.name === 'TLS')).toMatchObject({ state: 'failed' });
    expect(d.status.attention.message).toContain(dv.cert.fingerprint);
    expect(d.status.attention.detail).toEqual({ offered: dv.cert.fingerprint });
    expect(await h.fails(acc, 'mail.mailboxes', {})).toMatchObject({ status: 495 });
    // No login reached the server with the new certificate.
    const log = readFileSync(join(dv.dir, 'dovecot.log'), 'utf8');
    const since = log.slice(log.lastIndexOf('starting up'));
    expect(since).not.toMatch(/Login: user=<alice/);
    // The pin is still the old one; renewing it is deleting tls-pins.json (no restart needed).
    const pins = join(h.accountDir(acc), 'tls-pins.json');
    expect(JSON.parse(readFileSync(pins, 'utf8'))[`imap 127.0.0.1:${IMAP}`].fingerprint).toBe(old);
    rmSync(pins);
    await h.waitOnline(acc, 30_000);
    expect(JSON.parse(readFileSync(pins, 'utf8'))[`imap 127.0.0.1:${IMAP}`].fingerprint).toBe(dv.cert.fingerprint);
  }, 120_000);

  it('a fingerprint in the config is the pin: a server with another one is refused from the start', async () => {
    const id = await h.add(config({ certificate: 'AA:'.repeat(31) + 'AA' }), alice.password, 'Wrong pin');
    await until(async () => (await h.layer(id, 'TLS'))?.state === 'failed', 20_000, 'TLS failed');
    expect((await h.detail(id)).status.attention.message).toContain('pinned');
    await fetch(`${h.m.url}/api/accounts/${id}`, { method: 'DELETE' });
    const ok = await h.add(config({ certificate: dv.cert.fingerprint.replace(/:/g, '').toLowerCase(), imapPort: String(IMAPS), imapSecurity: 'tls' }), alice.password, 'Right pin, IMAPS');
    await h.waitOnline(ok);
    expect((await h.layer(ok, 'TLS'))?.note).toContain('pinned');
    await fetch(`${h.m.url}/api/accounts/${ok}`, { method: 'DELETE' });
  }, 60_000);

  it('verify (the default): a self-signed server is not trusted, and the fingerprint to pin is shown', async () => {
    const id = await h.add(config({ certificate: undefined }), alice.password, 'Verify');
    await until(async () => (await h.layer(id, 'TLS'))?.state === 'failed', 20_000, 'TLS failed');
    const d = await h.detail(id);
    expect(d.status.attention.message).toContain(dv.cert.fingerprint);
    expect(d.status.attention.message).toContain('pin');
    await fetch(`${h.m.url}/api/accounts/${id}`, { method: 'DELETE' });
  }, 40_000);
});
