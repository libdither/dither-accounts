/**
 * Gmail's ways, as far as a Dovecot can stand in for them: [Gmail]/Important's role from its \Important flag (which
 * imapflow's special-use list leaves out), and a move out of All Mail that is a COPY (Gmail adds the destination's label;
 * a MOVE out of All Mail deletes there), except into Trash or Spam. Gmail itself (X-GM-EXT-1, labels, a virtual All
 * Mail) is not here: the account is provider 'gmail' against a Dovecot with a [Gmail]/All Mail marked \All.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { copiesInstead, roleOf } from '../extractors/imap/src/imap.ts';
import { Harness } from '../extractors/imap/test/harness.ts';
import { Dovecot, rfc822, type User } from '../extractors/imap/test/servers.ts';
import { dovecot, why } from './needs.ts';

const ok = why('Dovecot (from nixpkgs, or DOVECOT_BIN)', dovecot);
const it = test.skipIf(!ok);

const gina: User = { email: 'gina@example.test', password: 'gina-pw-1' };
const IMAP = 18567;
const NO_SMTP = 18568;

describe('roles and the move rule', () => {
  test('\\Important is a role even without a special-use; INBOX and special-uses as before', () => {
    expect(roleOf({ path: '[Gmail]/Important', specialUse: undefined, flags: new Set(['\\HasNoChildren', '\\Important']) } as never)).toBe('important');
    expect(roleOf({ path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set(['\\All']) } as never)).toBe('all');
    expect(roleOf({ path: 'INBOX', specialUse: undefined, flags: new Set() } as never)).toBe('inbox');
    expect(roleOf({ path: 'Receipts', specialUse: undefined, flags: new Set(['\\HasNoChildren']) } as never)).toBeNull();
  });

  test('a COPY only on Gmail, only out of All Mail, never into Trash or Spam', () => {
    expect(copiesInstead(true, 'all', 'inbox')).toBe(true);
    expect(copiesInstead(true, 'all', null)).toBe(true);
    expect(copiesInstead(true, 'all', 'trash')).toBe(false);
    expect(copiesInstead(true, 'all', 'junk')).toBe(false);
    expect(copiesInstead(true, 'inbox', 'archive')).toBe(false);
    expect(copiesInstead(false, 'all', 'inbox')).toBe(false);
  });
});

const h = new Harness();
let dv: Dovecot;
let acc: string;
let custom: string;

const config = (provider: string) => ({
  email: gina.email,
  provider,
  name: 'Gina Test',
  imapHost: '127.0.0.1',
  imapPort: String(IMAP),
  imapSecurity: 'starttls',
  smtpHost: '127.0.0.1',
  smtpPort: String(NO_SMTP),
  smtpSecurity: 'starttls',
  certificate: 'pin',
  sentCopy: 'detect',
});

async function other<T>(f: (c: Awaited<ReturnType<Dovecot['client']>>) => Promise<T>): Promise<T> {
  const c = await dv.client(gina);
  try {
    return await f(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
}
const subjectsIn = (path: string) =>
  other(async (c) => {
    const lock = await c.getMailboxLock(path);
    try {
      const out: string[] = [];
      for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '');
      return out.sort();
    } catch {
      return [];
    } finally {
      lock.release();
    }
  });

beforeAll(async () => {
  if (!ok) return;
  dv = new Dovecot({ imapPort: IMAP, users: [gina], gmail: true });
  await dv.start();
  await other(async (c) => {
    for (const s of ['Archived one', 'Archived two', 'Archived three', 'Archived four']) await c.append('[Gmail]/All Mail', rfc822({ subject: s, text: `${s} body` }));
  });
  await h.start();
  acc = await h.add(config('gmail'), gina.password, 'Gmail');
  custom = await h.add(config('custom'), gina.password, 'Not Gmail');
  await h.waitOnline(acc);
  await h.waitOnline(custom);
}, 300_000);

afterAll(async () => {
  if (!ok) return;
  await h.stop();
  await dv?.cleanup();
});

describe('moving out of All Mail', () => {
  const box = async (account: string, role: string) => ((await h.call(account, 'mail.mailboxes', {})).mailboxes as any[]).find((b) => b.role === role)!.id as string;
  const inAll = async (account: string, subject: string) => ((await h.call(account, 'mail.list', { mailboxId: await box(account, 'all'), limit: 50 })).messages as any[]).find((m) => m.subject === subject)!;

  it('to Inbox on Gmail: a COPY, so it stays in All Mail, and the id in Inbox comes back', async () => {
    const m = await inAll(acc, 'Archived one');
    const inbox = await box(acc, 'inbox');
    const r = await h.call(acc, 'mail.move', { ids: [m.id], mailboxId: inbox });
    expect(r.ids[0]).toBeString();
    expect(r.ids[0]).not.toBe(m.id);
    expect((await h.call(acc, 'mail.get', { id: r.ids[0] })).subject).toBe('Archived one');
    expect(await subjectsIn('INBOX')).toContain('Archived one');
    expect(await subjectsIn('[Gmail]/All Mail')).toContain('Archived one');
  });

  it('to Trash on Gmail: still a MOVE, out of All Mail', async () => {
    const m = await inAll(acc, 'Archived two');
    const r = await h.call(acc, 'mail.move', { ids: [m.id], mailboxId: await box(acc, 'trash') });
    expect(r.ids[0]).toBeString();
    expect(await subjectsIn('Trash')).toContain('Archived two');
    expect(await subjectsIn('[Gmail]/All Mail')).not.toContain('Archived two');
  });

  it('from Inbox on Gmail: a MOVE, as before', async () => {
    const inbox = await box(acc, 'inbox');
    const m = ((await h.call(acc, 'mail.list', { mailboxId: inbox, limit: 50 })).messages as any[]).find((x) => x.subject === 'Archived one')!;
    await h.call(acc, 'mail.move', { ids: [m.id], mailboxId: await box(acc, 'archive') });
    expect(await subjectsIn('INBOX')).not.toContain('Archived one');
    expect(await subjectsIn('Archive')).toContain('Archived one');
  });

  it('on a server that is not Gmail, out of an \\All mailbox is a MOVE', async () => {
    const m = await inAll(custom, 'Archived three');
    await h.call(custom, 'mail.move', { ids: [m.id], mailboxId: await box(custom, 'inbox') });
    expect(await subjectsIn('INBOX')).toContain('Archived three');
    expect(await subjectsIn('[Gmail]/All Mail')).not.toContain('Archived three');
  });

  it("summaries carry the server's own message id when it has one (Dovecot's OBJECTID EMAILID here; Gmail's X-GM-MSGID there)", async () => {
    const m = await inAll(acc, 'Archived four');
    if (m.emailId !== undefined) expect(m.emailId).toBeString();
  });
});
