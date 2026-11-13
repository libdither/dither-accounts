/**
 * The imap extractor's other ways of keeping up, against a real Dovecot whose capabilities are switched: without
 * CONDSTORE and QRESYNC (the UID+flags diff), then with CONDSTORE alone (modseq for flags, a UID list for removals).
 * The account uses the Proton Bridge preset with its ports pointed at this Dovecot, so the Bridge layer, the pinned
 * certificate and "the server keeps the Sent copy" are covered too; never the real Bridge's ports.
 *
 * Ports 18553 (IMAP, STARTTLS), 18554 (SMTP); 18559 has nothing on it (Bridge not running).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, until } from '../extractors/imap/test/harness.ts';
import { Dovecot, makeCaSigned, rfc822, SmtpSink, type User } from '../extractors/imap/test/servers.ts';
import { dovecot, why } from './needs.ts';

const ok = why('Dovecot (from nixpkgs, or DOVECOT_BIN)', dovecot);
const it = test.skipIf(!ok);

const alice: User = { email: 'alice@example.test', password: 'alice-pw-1' };
const IMAP = 18553;
const SMTP = 18554;
const NOTHING = 18559;

let dv: Dovecot;
let sink: SmtpSink;
const h = new Harness();
let acc: string;
let inbox: string;

const bridge = (over: Record<string, unknown> = {}) => ({ email: alice.email, provider: 'proton', imapPort: String(IMAP), smtpPort: String(SMTP), ...over });

async function other<T>(f: (c: Awaited<ReturnType<Dovecot['client']>>) => Promise<T>): Promise<T> {
  const c = await dv.client(alice);
  try {
    await c.mailboxOpen('INBOX');
    return await f(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
}
const uidOf = (id: string) => id.split('.').pop()!;

beforeAll(async () => {
  if (!ok) return;
  dv = new Dovecot({ imapPort: IMAP, users: [alice], condstore: false });
  await dv.start();
  sink = new SmtpSink(SMTP, [alice], dv, dv.cert);
  await sink.start();
  await other(async (c) => {
    for (let i = 1; i <= 12; i++) await c.append('INBOX', rfc822({ subject: `Old ${i}`, text: `old ${i}` }));
  });
  await h.start();
}, 300_000);

afterAll(async () => {
  if (!ok) return;
  await h.stop();
  await sink?.stop();
  await dv?.cleanup();
});

describe('Proton Bridge preset, on a server without CONDSTORE', () => {
  it('its layers start with Proton Bridge running; the certificate is pinned; changes go by UID and flags', async () => {
    acc = await h.add(bridge(), alice.password, 'Proton');
    await h.waitOnline(acc);
    const d = await h.detail(acc);
    expect(d.layers.map((l: any) => l.name)).toEqual(['Proton Bridge running', 'server', 'TLS', 'signed in', 'inbox', 'IDLE', 'SMTP']);
    expect(d.layers[0]).toMatchObject({ state: 'ok', note: `answering on 127.0.0.1:${IMAP}` });
    expect(d.layers.find((l: any) => l.name === 'TLS').note).toContain('pinned');
    expect(d.status.details).toMatchObject({ provider: 'Proton Mail (Proton Bridge)', sync: 'UID + flags diff', 'sent copy': 'the server keeps it', certificate: `pinned SHA-256 ${dv.cert.fingerprint}` });
    expect(d.status.details.capabilities).not.toContain('CONDSTORE');
    inbox = (await h.call(acc, 'mail.mailboxes', {})).mailboxes.find((b: any) => b.role === 'inbox').id;
  }, 40_000);

  it('mail.changes (UID+flags): added, changed, removed, a page at a time', async () => {
    const start = await h.call(acc, 'mail.changes', { mailboxId: inbox });
    expect(start.state).toMatch(/^f\./);
    expect((await h.call(acc, 'mail.changes', { mailboxId: inbox, state: start.state })).state).toBe(start.state);
    const list = (await h.call(acc, 'mail.list', { mailboxId: inbox, limit: 20 })).messages;
    const byS = Object.fromEntries(list.map((m: any) => [m.subject, m]));
    await other(async (c) => {
      await c.messageFlagsAdd(uidOf(byS['Old 1'].id), ['\\Seen', 'Important'], { uid: true });
      await c.messageFlagsAdd(uidOf(byS['Old 2'].id), ['\\Answered'], { uid: true });
      await c.messageDelete(uidOf(byS['Old 3'].id), { uid: true });
      for (let i = 0; i < 4; i++) await c.append('INBOX', rfc822({ subject: `New ${i}`, text: 'n' }));
    });
    const a = await h.call(acc, 'mail.changes', { mailboxId: inbox, state: start.state, limit: 3 });
    expect(a.more).toBe(true);
    expect(a.added.map((m: any) => m.subject)).toEqual(['New 0', 'New 1', 'New 2']);
    expect(a.changed).toEqual([
      { id: byS['Old 1'].id, flags: { seen: true, flagged: false, answered: false, draft: false }, labels: ['Important'] },
      { id: byS['Old 2'].id, flags: { seen: false, flagged: false, answered: true, draft: false }, labels: [] },
    ].sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(a.removed).toEqual([byS['Old 3'].id]);
    const b = await h.call(acc, 'mail.changes', { mailboxId: inbox, state: a.state, limit: 3 });
    expect(b).toMatchObject({ more: false, changed: [], removed: [] });
    expect(b.added.map((m: any) => m.subject)).toEqual(['New 3']);
    // The old state still answers the same (its snapshot is kept).
    expect((await h.call(acc, 'mail.changes', { mailboxId: inbox, state: start.state, limit: 3 })).added.map((m: any) => m.subject)).toEqual(['New 0', 'New 1', 'New 2']);
  });

  it("mail.changed's state is one mail.changes takes", async () => {
    const before = (await h.call(acc, 'mail.changes', { mailboxId: inbox })).state;
    const from = h.events.length;
    await other((c) => c.append('INBOX', rfc822({ subject: 'Pushed', text: 'p' })));
    await h.event((e) => e.t === 'mail.arrived' && e.message.subject === 'Pushed', 15_000, from);
    const ev = await h.event((e) => e.t === 'mail.changed' && e.mailboxId === inbox, 15_000, from);
    expect(ev.state).toMatch(/^f\./);
    expect((await h.call(acc, 'mail.changes', { mailboxId: inbox, state: before })).added.map((m: any) => m.subject)).toEqual(['Pushed']);
    expect(await h.call(acc, 'mail.changes', { mailboxId: inbox, state: ev.state })).toMatchObject({ added: [], changed: [], removed: [] });
  }, 40_000);

  it('the snapshots survive a restart; a state whose snapshot is gone answers 410', async () => {
    const st = (await h.call(acc, 'mail.changes', { mailboxId: inbox })).state;
    await h.restart(acc);
    await other((c) => c.append('INBOX', rfc822({ subject: 'After restart', text: 'r' })));
    expect((await h.call(acc, 'mail.changes', { mailboxId: inbox, state: st })).added.map((m: any) => m.subject)).toEqual(['After restart']);
    const sync = join(h.accountDir(acc), 'sync');
    expect(existsSync(sync)).toBe(true);
    rmSync(sync, { recursive: true });
    expect(await h.fails(acc, 'mail.changes', { mailboxId: inbox, state: st })).toMatchObject({ status: 410 });
  }, 60_000);

  it('mail.send with the server keeping Sent: nothing appended, the message went', async () => {
    const r = await h.call(acc, 'mail.send', { to: [{ name: null, email: alice.email }], subject: 'To myself', text: 'hi' });
    expect(r.sentId).toBeNull();
    expect(sink.received.some((x) => x.raw.toString().includes(r.messageId))).toBe(true);
    const sent = (await h.call(acc, 'mail.mailboxes', {})).mailboxes.find((b: any) => b.role === 'sent');
    expect(sent.total).toBe(0);
  }, 30_000);
});

describe('the server gains CONDSTORE (without QRESYNC)', () => {
  let st: string;
  it('a state from before answers 410 (its way of keeping up changed); the new one is CONDSTORE', async () => {
    st = (await h.call(acc, 'mail.changes', { mailboxId: inbox })).state;
    await dv.restart({ condstore: true, qresync: false });
    await h.waitOnline(acc, 90_000);
    expect(await h.fails(acc, 'mail.changes', { mailboxId: inbox, state: st })).toMatchObject({ status: 410 });
    st = (await h.call(acc, 'mail.changes', { mailboxId: inbox })).state;
    expect(st).toMatch(/^c\./);
    await until(async () => (await h.detail(acc)).status.details.sync === 'CONDSTORE (UID list kept)', 10_000, 'sync shown');
  }, 120_000);

  it('mail.changes (CONDSTORE): flags by modseq, removals by the UID list, added a page at a time', async () => {
    const list = (await h.call(acc, 'mail.list', { mailboxId: inbox, limit: 30 })).messages;
    const byS = Object.fromEntries(list.map((m: any) => [m.subject, m]));
    await other(async (c) => {
      await c.messageFlagsAdd(uidOf(byS['Old 4'].id), ['\\Flagged'], { uid: true });
      await c.messageDelete(uidOf(byS['Old 5'].id), { uid: true });
      for (let i = 0; i < 3; i++) await c.append('INBOX', rfc822({ subject: `Cond ${i}`, text: 'c' }));
    });
    const a = await h.call(acc, 'mail.changes', { mailboxId: inbox, state: st, limit: 2 });
    expect(a).toMatchObject({ more: true, removed: [byS['Old 5'].id] });
    expect(a.added.map((m: any) => m.subject)).toEqual(['Cond 0', 'Cond 1']);
    expect(a.changed).toEqual([{ id: byS['Old 4'].id, flags: { seen: false, flagged: true, answered: false, draft: false }, labels: [] }]);
    const b = await h.call(acc, 'mail.changes', { mailboxId: inbox, state: a.state, limit: 2 });
    expect(b).toMatchObject({ more: false, changed: [], removed: [] });
    expect(b.added.map((m: any) => m.subject)).toEqual(['Cond 2']);
  });

  it('a server without IDLE: the IDLE layer says it polls', async () => {
    await dv.restart({ idle: false });
    await until(async () => /no IDLE/.test((await h.layer(acc, 'IDLE'))?.note ?? ''), 90_000, 'the polling note');
  }, 120_000);
});

describe('Proton Bridge not running', () => {
  it('the first layer fails and says what to do; calls answer 503', async () => {
    const id = await h.add(bridge({ imapPort: String(NOTHING), smtpPort: String(NOTHING) }), alice.password, 'No bridge');
    await until(async () => (await h.layer(id, 'Proton Bridge running'))?.state === 'failed', 20_000, 'the Bridge layer failed');
    const d = await h.detail(id);
    expect(d.layers[0].note).toContain('start Proton Bridge');
    expect(d.layers.find((l: any) => l.name === 'server').state).toBe('waiting');
    expect(d.status.status).toBe('offline');
    expect(await h.fails(id, 'mail.mailboxes', {})).toMatchObject({ status: 503 });
    await fetch(`${h.m.url}/api/accounts/${id}`, { method: 'DELETE' });
  }, 40_000);
});

describe('verify (the default) with a certificate a trusted CA signed', () => {
  it('signs in with the host name checked; a name the certificate does not have is refused', async () => {
    const signed = makeCaSigned(dv.dir, 'signed');
    dv.cert = signed;
    await dv.restart({ idle: true });
    await sink.stop();
    sink = new SmtpSink(SMTP, [alice], dv, signed);
    await sink.start();
    // The extractors this manager starts from now on trust the test's CA (as yours trust the public ones).
    process.env.NODE_EXTRA_CA_CERTS = signed.ca;
    const plain = { email: alice.email, provider: 'custom', imapHost: 'localhost', imapPort: String(IMAP), imapSecurity: 'starttls', smtpHost: 'localhost', smtpPort: String(SMTP), smtpSecurity: 'starttls' };
    const id = await h.add(plain, alice.password, 'Verified');
    await h.waitOnline(id, 30_000);
    await until(async () => (await h.layer(id, 'SMTP'))?.state === 'ok', 15_000, 'SMTP verified');
    const d = await h.detail(id);
    expect(d.layers.find((l: any) => l.name === 'TLS').note).toContain('verified (issued by dacc test CA signed)');
    expect(d.status.details.certificate).toContain('verified');
    expect(existsSync(join(h.accountDir(id), 'tls-pins.json'))).toBe(false);
    expect((await h.call(id, 'mail.send', { to: [{ name: null, email: alice.email }], subject: 'Verified send', text: 'v' })).messageId).toBeTruthy();
    // 127.0.0.1 is the same server, but not a name on the certificate.
    const wrong = await h.add({ ...plain, imapHost: '127.0.0.1', smtpHost: '127.0.0.1' }, alice.password, 'Wrong name');
    await until(async () => (await h.layer(wrong, 'TLS'))?.state === 'failed', 20_000, 'TLS failed for the wrong name');
    delete process.env.NODE_EXTRA_CA_CERTS;
    for (const x of [id, wrong]) await fetch(`${h.m.url}/api/accounts/${x}`, { method: 'DELETE' });
  }, 90_000);
});
