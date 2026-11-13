/**
 * The imap kind end to end, as the page and an app use it, against a local Dovecot and SMTP sink:
 *
 *   1. a throwaway manager (`bun packages/manager/src/main.ts --data <tmp> --port 18555`) lists the kind with its form
 *   2. an account added through POST /api/accounts with the form's fields (provider custom, pinned certificate)
 *   3. it comes online: every layer ok, who it is (and the addresses it sends as), its details (canSend)
 *   4. an app registers, its request is approved through the manager's API, and it calls every mail op through
 *      packages/client, and gets mail.arrived and mail.changed as mail comes in and changes
 *   5. the page's "Try it" (POST /api/accounts/:id/call) answers too
 *
 *   bun scripts/verify-imap.ts [--keep]
 *
 * Ports: manager 18555, Dovecot 18556 (STARTTLS) and 18557 (IMAPS), SMTP sink 18558. Everything is under a fresh
 * temp directory, deleted after unless --keep. Nothing reaches a real mail service.
 */
import type { Subprocess } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mail } from '@dither-accounts/interfaces';
import { AccountsClient, register } from '@dither-accounts/client';
import { Dovecot, rfc822, SmtpSink, type User } from '../extractors/imap/test/servers.ts';
import { simpleParser, standIn } from '../extractors/imap/test/harness.ts';

const ROOT = resolve(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const T = mkdtempSync(join(tmpdir(), 'dacc-verify-imap-'));
const PORT = 18555;
const MGR = `http://127.0.0.1:${PORT}`;
const alice: User = { email: 'alice@example.test', password: 'verify-alice-pw' };
const bob: User = { email: 'bob@example.test', password: 'verify-bob-pw' };

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const until = async (f: () => unknown | Promise<unknown>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {}
    await Bun.sleep(200);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const get = async (path: string) => (await fetch(MGR + path)).json() as Promise<any>;
const post = (path: string, body: unknown) => fetch(MGR + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: MGR }, body: JSON.stringify(body) });

const dv = new Dovecot({ imapPort: 18556, imapsPort: 18557, users: [alice, bob] }, join(T, 'dovecot'));
let sink = null as SmtpSink | null;
let mgr = null as Subprocess | null;
let app = null as AccountsClient | null;

async function main() {
  await dv.start();
  sink = new SmtpSink(18558, [alice, bob], dv, dv.cert);
  await sink.start();
  const seed = await dv.client(alice);
  for (let i = 1; i <= 8; i++) await seed.append('INBOX', rfc822({ subject: `Verify ${i}`, text: `message ${i}` }));
  await seed.append('INBOX', rfc822({ subject: 'With a file', text: 'see attached, pelican', messageId: '<verify-file@example.test>', attachment: { filename: 'data.bin', mime: 'application/octet-stream', data: Buffer.from('0123456789') } }));
  await seed.logout();

  // 1. The manager, as the service runs it but on its own data and port.
  const data = join(T, 'data');
  const cmd = ['bun', join(ROOT, 'packages/manager/src/main.ts'), '--data', data, '--port', String(PORT), '--host', '127.0.0.1'];
  mgr = Bun.spawn(cmd, { cwd: ROOT, stdout: Bun.file(join(T, 'manager.out')), stderr: Bun.file(join(T, 'manager.err')) });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'the manager answers', MGR);
  const st = await get('/api/state');
  const kind = st.kinds.find((k: any) => k.kind === 'imap');
  check(kind?.add?.fields?.length, 'the imap kind has an add form', kind?.add?.fields?.map((f: any) => f.key));
  check(kind?.interfaces?.includes('mail'), 'it implements mail');

  // 2. Added as the page does: the form's fields as strings, the secret one apart.
  const form: Record<string, string> = {
    email: alice.email,
    provider: 'custom',
    name: 'Alice Verify',
    imapHost: '127.0.0.1',
    imapPort: '18556',
    imapSecurity: 'starttls',
    smtpHost: '127.0.0.1',
    smtpPort: '18558',
    smtpSecurity: 'starttls',
    certificate: 'pin',
  };
  const bad = await post('/api/accounts', { kind: 'imap', label: 'Nope', config: { ...form, provider: 'aol' }, secret: { password: 'x' } });
  check(bad.status === 400, 'the form refuses an unknown provider', ((await bad.json()) as any).error);
  const r = await post('/api/accounts', { kind: 'imap', label: 'Alice (verify)', config: form, secret: { password: alice.password } });
  const added = (await r.json()) as any;
  check(r.ok && added.id, 'POST /api/accounts added it', added.id ?? added.error);
  const id = added.id as string;

  // 3. Online, with its chain and who it is.
  const online = await until(async () => {
    const d = await get(`/api/accounts/${id}`);
    return d.status?.status === 'online' && d.layers?.every((l: any) => l.state === 'ok');
  }, 30_000, 'online');
  const d = await get(`/api/accounts/${id}`);
  check(online, 'online, every layer ok', d.layers?.map((l: any) => `${l.name}:${l.state}`));
  check(d.account.self?.detail === alice.email, 'self is the address', d.account.self);
  check(d.status?.details?.certificate === `pinned SHA-256 ${dv.cert.fingerprint}`, 'the certificate pinned on first connect', d.status?.details?.certificate);
  check(d.status?.details?.sync === 'QRESYNC', 'it keeps up with QRESYNC', d.status?.details?.sync);
  const sendable = await until(async () => (await get(`/api/accounts/${id}`)).status?.details?.canSend === true, 15_000, 'canSend');
  const ds = (await get(`/api/accounts/${id}`)).status;
  check(sendable && ds?.details?.sendNote === null, 'details.canSend true, sendNote null', { canSend: ds?.details?.canSend, sendNote: ds?.details?.sendNote });
  check(JSON.stringify(ds?.self?.addresses) === JSON.stringify([{ email: alice.email, name: form.name }]), 'self.addresses: the address it sends as', ds?.self?.addresses);
  check(JSON.stringify(d.config).indexOf(alice.password) < 0 && d.secret.keys.includes('password'), 'the password is only in secret.json');

  // 4. An app, approved through the manager's API.
  const reg = await register(MGR, { name: 'verify-imap', describe: 'scripts/verify-imap.ts', requests: [{ interface: 'mail', level: 'write', kinds: ['imap'], reason: 'verify' }] });
  const ok = await post(`/api/requests/${reg.requests[0].id}/approve`, {});
  check(ok.ok, 'its request approved');
  const events: { account: string; t: string; [k: string]: any }[] = [];
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (account, evs) => events.push(...evs.map((e) => ({ ...e, account }))) });
  await until(() => app!.connected && app!.accounts.some((a) => a.id === id), 10_000, 'the app sees the account');
  check(app.accounts.some((a) => a.id === id), 'the app sees the account');
  const call = (op: keyof typeof mail.ops & string, input: any) => app!.call(mail, id, op as any, standIn(op, input)) as Promise<any>;

  const { mailboxes } = await call('mail.mailboxes', {});
  const role = (r: string) => mailboxes.find((b: any) => b.role === r)?.id;
  check(['inbox', 'sent', 'trash', 'archive', 'drafts', 'junk'].every(role), 'mail.mailboxes: the SPECIAL-USE roles', mailboxes.map((b: any) => `${b.path}:${b.role}`));
  const p1 = await call('mail.list', { mailboxId: role('inbox'), limit: 5 });
  const p2 = await call('mail.list', { mailboxId: role('inbox'), limit: 5, before: p1.next });
  check(p1.messages[0].subject === 'With a file' && p1.next && p2.messages.length === 4 && !p2.next, 'mail.list: newest first, two pages', [...p1.messages, ...p2.messages].map((m: any) => m.subject));
  const withFile = p1.messages[0];
  const full = await call('mail.get', { id: withFile.id });
  check(full.text?.includes('pelican') && full.attachments?.[0]?.filename === 'data.bin', 'mail.get: text and the attachments list', full.attachments);
  const att = await call('mail.attachment', { id: withFile.id, attachmentId: full.attachments[0].id });
  check(Buffer.from(att.base64, 'base64').toString() === '0123456789', 'mail.attachment: the bytes');
  const found = await call('mail.search', { query: 'pelican' });
  check(found.messages.length === 1 && found.messages[0].id === withFile.id, 'mail.search: server-side', found.messages.map((m: any) => m.subject));
  const s0 = (await call('mail.changes', { mailboxId: role('inbox') })).state;
  check(typeof s0 === 'string', 'mail.changes: a starting state', s0);

  const from = events.length;
  const other = await dv.client(alice);
  await other.append('INBOX', rfc822({ subject: 'Arrives live', text: 'live', inReplyTo: '<verify-file@example.test>', references: '<verify-file@example.test>', headers: { 'List-Id': '<verify.list.example.test>' } }));
  check(await until(() => events.slice(from).some((e) => e.t === 'mail.arrived' && e.message?.subject === 'Arrives live'), 15_000, 'mail.arrived'), 'mail.arrived as it is delivered (IDLE)');
  const live = events.slice(from).find((e) => e.t === 'mail.arrived' && e.message?.subject === 'Arrives live')?.message;
  check(live?.inReplyTo === '<verify-file@example.test>' && live?.references?.[0] === '<verify-file@example.test>' && live?.bulk?.listId === '<verify.list.example.test>', 'mail.arrived carries inReplyTo, references and bulk', { inReplyTo: live?.inReplyTo, references: live?.references, bulk: live?.bulk });
  check(await until(() => events.slice(from).some((e) => e.t === 'mail.changed' && e.mailboxId === role('inbox')), 15_000, 'mail.changed'), 'mail.changed for the inbox');
  await other.logout();

  const v8 = p2.messages.find((m: any) => m.subject === 'Verify 4');
  await call('mail.flag', { ids: [v8.id], seen: true, flagged: true });
  const ch = await call('mail.changes', { mailboxId: role('inbox'), state: s0 });
  check(ch.added.some((m: any) => m.subject === 'Arrives live') && ch.changed.some((c: any) => c.id === v8.id && c.flags.flagged), 'mail.flag, and mail.changes shows it and the new message', { added: ch.added.length, changed: ch.changed.length });
  const moved = await call('mail.move', { ids: [v8.id], mailboxId: role('archive') });
  check(moved.ids[0]?.startsWith(role('archive')), 'mail.move: the new id', moved.ids);
  check((await call('mail.get', { id: moved.ids[0] })).subject === 'Verify 4', 'the moved message by its new id');
  await call('mail.trash', { ids: moved.ids });
  check((await call('mail.list', { mailboxId: role('trash') })).messages.some((m: any) => m.subject === 'Verify 4'), 'mail.trash: in Trash');
  const sent = await call('mail.send', {
    from: alice.email,
    to: [{ name: 'Bob', email: bob.email }],
    subject: 'Re: With a file',
    text: 'got it',
    replyTo: withFile.id,
    attachments: [{ filename: 'hi.txt', mime: 'text/plain', base64: Buffer.from('hello').toString('base64') }],
  });
  const got = sink!.received.find((x) => x.raw.toString().includes(sent.messageId));
  const parsed = got ? await simpleParser(got.raw) : null;
  check(parsed?.inReplyTo === '<verify-file@example.test>' && parsed?.attachments[0]?.filename === 'hi.txt', 'mail.send: through SMTP, threaded, with its attachment', { messageId: sent.messageId, inReplyTo: parsed?.inReplyTo });
  check(sent.sentId && (await call('mail.get', { id: sent.sentId })).messageId === sent.messageId, 'a copy in Sent', sent.sentId);
  check((await call('mail.get', { id: withFile.id })).flags.answered, 'the original marked answered');
  const refused = await call('mail.send', { from: 'mallory@example.test', to: [{ name: 'Bob', email: bob.email }], subject: 'x', text: 'x' }).catch((e: any) => e);
  check(refused?.status === 422, 'mail.send from an address not its own: 422', { status: refused?.status });

  // 5. The page's "Try it".
  const page = (await (await post(`/api/accounts/${id}/call`, { op: 'mail.mailboxes', input: {} })).json()) as any;
  check(page.ok && page.result.mailboxes.length === mailboxes.length, "the page's Try it runs an op", page.error);
}

try {
  await main();
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  app?.close();
  if (mgr && mgr.exitCode === null) {
    mgr.kill('SIGTERM');
    const k = setTimeout(() => mgr!.kill('SIGKILL'), 15_000);
    await mgr.exited;
    clearTimeout(k);
  }
  await sink?.stop();
  await dv.stop();
  rmSync(dv.run, { recursive: true, force: true });
  if (keep) console.log(`kept ${T}`);
  else rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
