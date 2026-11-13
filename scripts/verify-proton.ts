/**
 * The proton kind end to end, as the page and an app use it, against the fake Proton (test/fake-proton.ts) in a real
 * sandboxed Chromium:
 *
 *   1. a throwaway manager (`bun packages/manager/src/main.ts --data <tmp> --port 18565`) lists the kind, addable
 *   2. an account added through POST /api/accounts (config testOrigin and pollSeconds point it at the fake)
 *   3. it comes online: every layer ok, who it is (and the addresses it sends as), its details (canSend), a live view
 *      that answers VNC
 *   4. an app registers, its request is approved through the manager's API, and it calls every mail op through
 *      packages/client, and gets mail.arrived and mail.changed as mail comes in and changes
 *   5. mail.send, the safe subset (docs/proton.md, "Sending"): a Proton user and someone with no key, with a file; the
 *      fake checks every package with the recipients' real keys, and so does this; an outside address with a published
 *      key refuses it all (422, code 'recipients'), signing settings refuse a clear send (422, 'settings'), each making
 *      nothing; `from` picks the alias, and an address not its own is 422 'from'
 *   6. an access token that runs out is refreshed by the page, never by us; the page's "Try it" answers too
 *   7. a second account whose saved session will not open, as the live build's might not: its keys open through the
 *      page's crypto proxy, it reads, its send path layer is ok without Proton's composer functions (the live build
 *      folds them away), canSend is true, and it sends to a Proton user
 *   8. nothing secret in its log or status; every process gone when the manager stops
 *
 *   bun scripts/verify-proton.ts [--keep]
 *
 * Ports: manager 18565, the fake on any free port. Everything is under a fresh temp directory, deleted after unless
 * --keep. Nothing reaches Proton.
 */
import type { Subprocess } from 'bun';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { mail } from '@dither-accounts/interfaces';
import { openpgp } from '../extractors/proton/src/pgp.ts';
import { APP_VERSION, type SentPackage, startFakeProton } from '../test/fake-proton.ts';

const ROOT = resolve(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const T = mkdtempSync(join(tmpdir(), 'dacc-verify-proton-'));
const PORT = 18565;
const MGR = `http://127.0.0.1:${PORT}`;

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
/** What the live view's VNC says first, over its Unix socket. */
const rfb = (path: string) =>
  new Promise<string>((res, rej) => {
    const s = connect({ path }, () => {});
    s.once('data', (b) => (res(b.toString('latin1')), s.destroy()));
    s.once('error', rej);
    setTimeout(() => (s.destroy(), rej(new Error('no banner'))), 5000);
  });
function processesOf(id: string): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(`DITHER_ACCOUNT_ID=${id}`)) out.push(Number(d));
    } catch {}
  }
  return out;
}

const fake = await startFakeProton({ pagePollMs: 1000 });
const liveLike = await startFakeProton({ pagePollMs: 1000, brokenSession: 'clientKey' });
let mgr = null as Subprocess | null;
let app = null as AccountsClient | null;
let id = '';
let id2 = '';

/** The session key a recipient's key packet holds, or the package's clear one; then the body or file opened with it. */
async function opened(pkg: SentPackage, packet: string | undefined, key: openpgp.PrivateKey | null, data = pkg.Body) {
  const sk = key
    ? ((await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(packet!, 'base64') }), decryptionKeys: key }))[0] as any)
    : { data: Uint8Array.from(Buffer.from(pkg.BodyKey!.Key, 'base64')), algorithm: pkg.BodyKey!.Algorithm };
  return Buffer.from((await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: data }), sessionKeys: sk, format: 'binary' })).data as Uint8Array).toString();
}

async function main() {
  const withFile = await fake.deliver({ subject: 'With a file', html: '<p>see attached, pelican</p>', attachments: [{ name: 'data.bin', mime: 'application/octet-stream', data: Buffer.from('0123456789') }] });
  const t0 = Math.floor(Date.now() / 1000) - 600;
  for (let i = 1; i <= 6; i++) await fake.deliver({ subject: `Verify ${i}`, text: `message ${i}`, time: t0 + i });
  const listMail = await fake.deliver({ subject: 'A list', text: 'list news', labelIds: ['6'], headers: { 'In-Reply-To': '<verify-root@list.example>', References: '<verify-root@list.example>', 'List-Id': '<verify.list.example>', Precedence: 'list' } });

  // 1. The manager, as the service runs it but on its own data and port.
  const cmd = ['bun', join(ROOT, 'packages/manager/src/main.ts'), '--data', join(T, 'data'), '--port', String(PORT), '--host', '127.0.0.1'];
  mgr = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, DITHER_PROTON_BACKOFF_MS: '1' }, stdout: Bun.file(join(T, 'manager.out')), stderr: Bun.file(join(T, 'manager.err')) });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'the manager answers', MGR);
  const st = await get('/api/state');
  const kind = st.kinds.find((k: any) => k.kind === 'proton');
  check(kind?.add && kind.interfaces.includes('mail'), 'the proton kind is listed, addable, with mail', kind?.add?.blurb);

  // 2. Added as the page does (no form fields; the test config points it at the fake).
  const r = await post('/api/accounts', { kind: 'proton', label: 'Proton (verify)', config: { testOrigin: fake.url, pollSeconds: 1 } });
  const added = (await r.json()) as any;
  check(r.ok && added.id, 'POST /api/accounts added it', added.id ?? added.error);
  id = added.id;

  // 3. Online, with its chain and who it is.
  const online = await until(async () => {
    const d = await get(`/api/accounts/${id}`);
    return d.status?.status === 'online' && d.layers?.every((l: any) => l.state === 'ok');
  }, 60_000, 'online');
  const d = await get(`/api/accounts/${id}`);
  check(online, 'online, every layer ok', d.layers?.map((l: any) => `${l.name}:${l.state}`));
  check(d.account.self?.detail === fake.email || d.status?.self?.email === fake.email, 'self is the primary address', d.status?.self);
  check(d.status?.details?.appVersion === APP_VERSION, "the page's own app version, seen on its calls", d.status?.details?.appVersion);
  check(d.status?.details?.addressKeys === '2 of 2' && d.status?.details?.keptSignedIn === true, 'the keys unlocked, the session kept', { keys: d.status?.details?.addressKeys, kept: d.status?.details?.keptSignedIn });
  const sendable = await until(async () => (await get(`/api/accounts/${id}`)).status?.details?.canSend === true, 15_000, 'canSend');
  const ds = (await get(`/api/accounts/${id}`)).status;
  check(sendable && ds?.details?.sendNote === null, 'details.canSend true, sendNote null', { canSend: ds?.details?.canSend, sendNote: ds?.details?.sendNote });
  check(JSON.stringify(ds?.self?.addresses) === JSON.stringify([{ email: fake.email, name: 'Pat Proton' }, { email: fake.alias, name: null }]), 'self.addresses: the enabled addresses that send', ds?.self?.addresses);
  const lv = d.status?.liveView;
  check(lv?.vncSocket && (await rfb(lv.vncSocket)).startsWith('RFB '), 'the live view answers VNC on its socket', lv);

  // 4. An app, approved through the manager's API.
  const reg = await register(MGR, { name: 'verify-proton', describe: 'scripts/verify-proton.ts', requests: [{ interface: 'mail', level: 'write', kinds: ['proton'], reason: 'verify' }] });
  check((await post(`/api/requests/${reg.requests[0].id}/approve`, {})).ok, 'its request approved');
  const events: { t: string; [k: string]: any }[] = [];
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (_a, evs) => events.push(...evs) });
  await until(() => app!.connected && app!.accounts.some((a) => a.id === id), 10_000, 'the app sees the account');
  const call = (op: keyof typeof mail.ops & string, input: any) => app!.call(mail, id, op as any, input) as Promise<any>;

  const { mailboxes } = await call('mail.mailboxes', {});
  const role = (x: string) => mailboxes.find((b: any) => b.role === x)?.id;
  check(['inbox', 'sent', 'trash', 'archive', 'drafts', 'junk', 'all', 'flagged'].every(role) && mailboxes.some((b: any) => b.path === 'Work/Clients'), "mail.mailboxes: Proton's system folders with roles, custom folders", mailboxes.map((b: any) => `${b.path}:${b.role ?? '-'}`));
  const p1 = await call('mail.list', { mailboxId: '0', limit: 4 });
  const p2 = await call('mail.list', { mailboxId: '0', limit: 4, before: p1.next });
  check(p1.messages[0].subject === 'With a file' && p1.next && p2.messages.length === 3 && !p2.next, 'mail.list: newest first, two pages', [...p1.messages, ...p2.messages].map((m: any) => m.subject));
  const full = await call('mail.get', { id: withFile });
  check(full.html === '<p>see attached, pelican</p>' && full.text === 'see attached, pelican' && full.attachments[0]?.filename === 'data.bin', 'mail.get: the body decrypted, text from its HTML, the attachments list', full.attachments);
  const att = await call('mail.attachment', { id: withFile, attachmentId: full.attachments[0].id });
  check(Buffer.from(att.base64, 'base64').toString() === '0123456789', 'mail.attachment: key packets and data packet decrypted');
  const found = await call('mail.search', { query: 'with a file' });
  check(found.messages.length === 1 && found.messages[0].id === withFile, 'mail.search: on the server, by subject', found.messages.map((m: any) => m.subject));
  const lm = await call('mail.get', { id: listMail });
  check(lm.inReplyTo === '<verify-root@list.example>' && lm.references?.[0] === '<verify-root@list.example>' && lm.bulk?.listId === '<verify.list.example>' && lm.bulk?.precedence === 'list', 'mail.get: inReplyTo, references and bulk from ParsedHeaders', { inReplyTo: lm.inReplyTo, bulk: lm.bulk });
  const ls = (await call('mail.list', { mailboxId: '6' })).messages.find((m: any) => m.id === listMail);
  check(ls && ls.inReplyTo === null && ls.references?.length === 0 && ls.bulk === undefined, "mail.list: Proton's list carries no headers, so none here", { inReplyTo: ls?.inReplyTo, bulk: ls?.bulk });
  const s0 = (await call('mail.changes', { mailboxId: '0' })).state;
  check(/^e\./.test(s0), 'mail.changes: a starting state (an event id)', s0.slice(0, 8));

  const from = events.length;
  const live = await fake.deliver({ subject: 'Arrives live', text: 'live' });
  check(await until(() => events.slice(from).some((e) => e.t === 'mail.arrived' && e.message?.id === live), 15_000, 'mail.arrived'), 'mail.arrived from the event loop');
  check(await until(() => events.slice(from).some((e) => e.t === 'mail.changed' && e.mailboxId === '0'), 15_000, 'mail.changed'), 'mail.changed for the inbox');

  const v4 = p2.messages.find((m: any) => m.subject === 'Verify 3') ?? p1.messages.at(-1);
  await call('mail.flag', { ids: [v4.id], seen: true, flagged: true });
  const ch = await call('mail.changes', { mailboxId: '0', state: s0 });
  check(ch.added.some((m: any) => m.id === live) && ch.changed.some((c: any) => c.id === v4.id && c.flags.flagged && c.flags.seen), 'mail.flag, and mail.changes shows it and the new message', { added: ch.added.length, changed: ch.changed.length });
  const moved = await call('mail.move', { ids: [v4.id], mailboxId: role('archive') });
  check(moved.ids[0] === v4.id && (await call('mail.list', { mailboxId: role('archive') })).messages.some((m: any) => m.id === v4.id), 'mail.move: in Archive, the same id', moved.ids);
  await call('mail.trash', { ids: [v4.id] });
  check((await call('mail.list', { mailboxId: role('trash') })).messages.some((m: any) => m.id === v4.id), 'mail.trash: in Trash');
  await call('mail.trash', { ids: [v4.id] });
  check(!fake.message(v4.id), 'mail.trash again: deleted outright');
  // 5. Sending: the safe subset (a Proton user, someone with no key); everything else refused before anything is made.
  check(d.layers?.find((l: any) => l.name === 'send path')?.state === 'ok', "the send path layer: what sending needs found in the page", d.layers?.find((l: any) => l.name === 'send path')?.note);
  const friend = (await fake.recipient('friend@proton.test', 'internal'))!;
  await fake.recipient('pgp@outside.test', 'wkd');
  await fake.recipient('nokey@outside.test', 'clear');
  const sent = await call('mail.send', {
    to: [{ name: 'Friend', email: 'friend@proton.test' }],
    cc: [{ name: null, email: 'nokey@outside.test' }],
    subject: 'Verify send',
    html: '<p>sent pelican</p>',
    attachments: [{ filename: 'v.txt', mime: 'text/plain', base64: Buffer.from('verify file').toString('base64') }],
  });
  const out = fake.sent.at(-1)!;
  check(sent.sentId === out?.id && /^<.+@proton\.test>$/.test(sent.messageId), 'mail.send: sent, the Message-ID Proton gave, the sent message as the copy in Sent', sent);
  check(JSON.stringify(out?.verified) === JSON.stringify({ encrypted: 1, clear: 1, attachments: 2 }), "the fake checked every package with the recipients' keys", out?.verified);
  const pkg = out.packages['text/html']!;
  check(pkg.Type === 5 && pkg.Addresses['friend@proton.test'].Type === 1 && (await opened(pkg, pkg.Addresses['friend@proton.test'].BodyKeyPacket, friend)) === '<p>sent pelican</p>', 'a Proton user: encrypted to their key, which opens it');
  check(pkg.Addresses['nokey@outside.test'].Type === 4 && !pkg.Addresses['nokey@outside.test'].BodyKeyPacket && (await opened(pkg, undefined, null)) === '<p>sent pelican</p>', 'someone with no key: in the clear, the session key given to the server');
  check((await call('mail.list', { mailboxId: '7' })).messages.some((m: any) => m.id === sent.sentId), 'the sent message is in Sent');
  const drafts = fake.draftsMade;
  const refused = await call('mail.send', { to: [{ name: null, email: 'friend@proton.test' }, { name: null, email: 'pgp@outside.test' }], subject: 'x', text: 'x' }).catch((e: any) => e);
  check(refused?.status === 422 && refused?.code === 'recipients' && refused?.message === 'Recipient 2 publishes an encryption key, so Proton would encrypt to it; send this one from Proton.' && fake.draftsMade === drafts, "an outside address with a published key: refused (422 'recipients'), nothing made", refused?.message);
  fake.setMailSettings({ Sign: 1 });
  const signing = await call('mail.send', { to: [{ name: null, email: 'nokey@outside.test' }], subject: 'x', text: 'x' }).catch((e: any) => e);
  fake.setMailSettings({ Sign: 0 });
  check(signing?.status === 422 && signing?.code === 'settings' && fake.draftsMade === drafts, "settings that sign mail to outside addresses: refused (422 'settings'), nothing made", signing?.message);
  const asAlias = await call('mail.send', { from: fake.alias, to: [{ name: null, email: 'friend@proton.test' }], subject: 'From the alias', text: 'alias' });
  const aliasId = fake.addresses.find((a) => a.Email === fake.alias)!.ID;
  check(fake.message(asAlias.sentId)?.AddressID === aliasId && fake.message(asAlias.sentId)?.Sender?.Address === fake.alias, 'mail.send from: sent from the alias, with its keys', { sentId: asAlias.sentId });
  const drafts2 = fake.draftsMade;
  const notOurs = await call('mail.send', { from: 'stranger@outside.test', to: [{ name: null, email: 'friend@proton.test' }], subject: 'x', text: 'x' }).catch((e: any) => e);
  check(notOurs?.status === 422 && notOurs?.code === 'from' && fake.draftsMade === drafts2, "mail.send from an address not its own: 422 'from', nothing made", notOurs?.message);

  // 6. A token that runs out, and the page's "Try it".
  fake.expireAccess();
  const after = await call('mail.list', { mailboxId: '0', limit: 2 });
  const refreshes = fake.calls.filter((c) => c.path === 'auth/refresh');
  check(after.messages.length === 2 && refreshes.length > 0 && refreshes.every((c) => c.by === 'page'), 'an expired access token: the page refreshed it, the call went through', { refreshes: refreshes.length });
  const page = (await (await post(`/api/accounts/${id}/call`, { op: 'mail.mailboxes', input: {} })).json()) as any;
  check(page.ok && page.result.mailboxes.length === mailboxes.length, "the page's Try it runs an op", page.error);

  // 7. Keys through the page's crypto proxy; Proton's composer functions folded away, as live (and not needed).
  await liveLike.deliver({ subject: 'Live-like', text: 'read through the page' });
  const r2 = await post('/api/accounts', { kind: 'proton', label: 'Proton (verify, live-like)', config: { testOrigin: liveLike.url, pollSeconds: 1, modulesGraceSeconds: 3 } });
  id2 = ((await r2.json()) as any).id;
  const online2 = await until(async () => {
    const x = await get(`/api/accounts/${id2}`);
    return x.status?.status === 'online' && x.layers?.find((l: any) => l.name === 'send path')?.state === 'ok';
  }, 60_000, 'online with the send path ok');
  const d2 = await get(`/api/accounts/${id2}`);
  check(online2 && d2.status?.details?.unlockPath === 'page', "the saved session refused: keys through the page's crypto proxy", d2.layers?.find((l: any) => l.name === 'keys unlocked')?.note);
  await until(() => app!.accounts.some((a) => a.id === id2), 10_000, 'the app sees the second account');
  const list2 = (await app!.call(mail, id2, 'mail.list', { mailboxId: '0' })) as any;
  const got2 = (await app!.call(mail, id2, 'mail.get', { id: list2.messages[0]?.id })) as any;
  check(got2?.text === 'read through the page', 'mail.get decrypted by the page');
  const d3 = (await get(`/api/accounts/${id2}`)).status?.details;
  check(d3?.canSend === true && d3?.sendNote === null, 'details.canSend true without Proton\'s composer functions', d3?.sendNote);
  await liveLike.recipient('friend@proton.test', 'internal');
  const yes = (await app!.call(mail, id2, 'mail.send', { to: [{ name: null, email: 'friend@proton.test' }], subject: 'Live-like send', text: 'sent through the page' })) as any;
  check(liveLike.sent.at(-1)?.id === yes?.sentId && liveLike.sent.at(-1)?.verified.encrypted === 1, 'mail.send from it: sent, checked by the fake', yes);

  // 8. What it said.
  const acc = await get(`/api/accounts/${id}`);
  const logText = [id, id2].filter(Boolean).map((x) => readFileSync(join(T, 'data', 'accounts', x, 'adapter.log'), 'utf8')).join('\n');
  const said = JSON.stringify(acc.status) + JSON.stringify(events) + logText;
  const leaks = [fake.secrets.keyPassword, fake.secrets.clientKey, fake.secrets.UID, fake.secrets.access, fake.secrets.refresh, fake.secrets.token, liveLike.secrets.keyPassword, liveLike.secrets.UID, 'pelican', 'BEGIN PGP', '0123456789', 'verify file', 'read through the page'].filter((s) => said.includes(s));
  // Header values reach the app in events, never the log.
  const headerLeaks = ['verify.list.example', 'verify-root@list.example'].filter((s) => logText.includes(s));
  check(!headerLeaks.length, 'no header value in the log', headerLeaks.length ? `${headerLeaks.length} leaked` : '');
  const addressLeaks = ['friend@proton.test', 'pgp@outside.test', 'nokey@outside.test', 'gone@proton.test', 'stranger@outside.test'].filter((s) => logText.includes(s) || JSON.stringify(acc.status).includes(s));
  check(!addressLeaks.length, 'no recipient address in the log or status', addressLeaks.length ? `${addressLeaks.length} leaked` : '');
  check(!leaks.length, 'no key, password, token, cookie or message content in the log, status or events', leaks.length ? `${leaks.length} leaked` : '');
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
  if (id) {
    const gone = await until(() => processesOf(id).length === 0 && (!id2 || processesOf(id2).length === 0), 15_000, 'its processes to go');
    check(gone, 'the manager stopped: every process it started for the account is gone');
  }
  fake.stop();
  liveLike.stop();
  if (keep) console.log(`kept ${T}`);
  else rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
