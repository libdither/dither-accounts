/**
 * extractors/proton end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc)
 * with its extension, against the fake Proton's stand-in Mail page and API (fake-proton.ts). Skipped when Xvfb,
 * chromium or x11vnc cannot be found. Every process it starts is gone at the end.
 *
 * Four accounts stay: signed in (the saved-session unlock), signed out, and two whose saved-session way in is closed, so
 * their keys open through the page's crypto proxy (one live-like: the ClientKey call refused). All of them send the safe
 * subset (docs/proton.md, "Sending"): the fake checks every package with the recipients' keys. Two more come and go:
 * pages whose CryptoProxy or keys-by-usage thunk the hook cannot find, which must not send.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, type CallFailed, register } from '@dither-accounts/client';
import { mail } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { openpgp } from '../extractors/proton/src/pgp.ts';
import { resolveBins } from '../packages/browser/src/index.ts';
import { inetSockets, rfbBanner, x11vncs } from '../packages/browser/test/inet.ts';
import { ACCEPT, APP_VERSION, type FakeProton, type SentPackage, startFakeProton } from './fake-proton.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`proton-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeProton;
let out: FakeProton;
let viaPage: FakeProton;
let folded: FakeProton;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let signedIn: string;
let signedOut: string;
let pageSends: string;
let pageFolded: string;
let withFile: string;
let pageFile: string;
const events: Record<string, any[]> = {};
const saved = process.env.DITHER_PROTON_BACKOFF_MS;

const until = async (f: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const statusOf = (account: string) => events[account]?.filter((e) => e.t === 'status').at(-1);
const call = (op: keyof typeof mail.ops & string, input: any) => app.call(mail, signedIn, op as any, input) as Promise<any>;

function processesOf(ids: string[]): number[] {
  const needles = ids.map((id) => `DITHER_ACCOUNT_ID=${id}`);
  const found: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (needles.some((n) => env.includes(n))) found.push(Number(d));
    } catch {}
  }
  return found;
}


beforeAll(async () => {
  if (!bins) return;
  process.env.DITHER_PROTON_BACKOFF_MS = '1';
  fake = await startFakeProton({ pagePollMs: 500 });
  out = await startFakeProton({ signedIn: false });
  viaPage = await startFakeProton({ pagePollMs: 500, brokenSession: 'blob' });
  folded = await startFakeProton({ pagePollMs: 500, brokenSession: 'clientKey' });
  pageFile = await viaPage.deliver({ subject: 'Opened in the page', html: "<p>read by the app's own keys</p>", attachments: [{ name: 'page.txt', mime: 'text/plain', data: Buffer.from('page bytes') }] });
  await folded.deliver({ subject: 'Folded inbox', text: 'folded text', toAlias: true });
  withFile = await fake.deliver({ subject: 'Welcome aboard', html: '<p>Your <b>first</b> pelican.</p>', attachments: [{ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('attached words') }] });
  await fake.deliver({ subject: 'Older news', text: 'plain old text', time: Math.floor(Date.now() / 1000) - 3600 });
  dir = mkdtempSync(join(tmpdir(), 'dacc-proton-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  const reg = await register(m.url, { name: 'proton-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['proton'] }, { interface: 'mail', level: 'write' }] });
  for (const r of reg.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => (events[a] ??= []).push(...evs) });
  await until(() => app.connected, 5000, 'the app connected');
}, 60_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  await m?.stop();
  for (const pid of processesOf([signedIn, signedOut, pageSends, pageFolded].filter(Boolean))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  out?.stop();
  viaPage?.stop();
  folded?.stop();
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.DITHER_PROTON_BACKOFF_MS;
  else process.env.DITHER_PROTON_BACKOFF_MS = saved;
}, 30_000);

it(
  'signed in: online with every layer ok, who it is, and the session as facts',
  async () => {
    signedIn = (await app.admin({ do: 'create', kind: 'proton', label: 'Proton (test)', config: { testOrigin: fake.url, pollSeconds: 1 } })).id;
    await until(() => statusOf(signedIn)?.status === 'online' && statusOf(signedIn)?.layers?.every((l: any) => l.state === 'ok'), 60_000, 'online');
    const st = statusOf(signedIn);
    expect(st.attention).toBeNull();
    expect(st.self).toEqual({ email: fake.email, displayName: 'Pat Proton', addresses: [{ email: fake.email, name: 'Pat Proton' }, { email: fake.alias, name: null }] });
    expect(st.liveView).toEqual({ width: 1280, height: 800 });
    const lv = m!.router.liveView(signedIn)!;
    expect(lv).toEqual({ vncSocket: join(m!.store.account(signedIn)!.dir, 'vnc.sock'), width: 1280, height: 800 });
    expect(await rfbBanner(lv.vncSocket)).toMatch(/^RFB \d{3}\.\d{3}/);
    const vnc = x11vncs(processesOf([signedIn]));
    expect(vnc.length).toBe(1);
    expect(inetSockets(vnc[0]!)).toEqual([]);
    expect(st.layers.map((l: any) => l.name)).toEqual(['display', 'browser', 'extension', 'signed in', 'keys unlocked', 'Proton API', 'app modules', 'send path']);
    expect(st.layers.find((l: any) => l.name === 'keys unlocked').note).toBe('2 of 2 address keys on 2 addresses, from the saved session');
    expect(st.layers.find((l: any) => l.name === 'app modules').note).toBe('found CryptoProxy, AppApi, Store, AddressKeysByUsage');
    expect(st.layers.find((l: any) => l.name === 'send path').note).toStartWith("the page's API caller, store, crypto proxy and address keys found; mail.send sends to Proton users and to outside addresses without a key");
    expect(st.details).toMatchObject({
      email: fake.email,
      page: `${fake.url}/u/0/inbox`,
      extensionAttached: true,
      mailPage: true,
      signedIn: true,
      localID: 0,
      keptSignedIn: true,
      sessionPayload: 3,
      sessionsInBrowser: 1,
      appVersion: APP_VERSION,
      uidMatchesPage: true,
      userKeys: '1 of 1',
      addresses: 2,
      addressKeys: '2 of 2',
      unlockPath: 'session',
      sessionUnlockError: null,
      modules: 'CryptoProxy AppApi Store AddressKeysByUsage',
      modulesMissing: null,
      sendPath: 'found',
      canSend: true,
      idPerMessage: true,
      sendCap: 25 * 1024 * 1024,
      maxRecipients: 100,
      sendNote: null,
    });
    // One runtime reached, its modules recorded as they ran (no module cache to read).
    expect(st.details.webpack).toMatch(/^1 runtime, \d+ modules, \d+ ran$/);
    expect(st.details.pageHeaders).toContain('x-pm-appversion');
    expect(events[signedIn].find((e) => e.t === 'hello')).toMatchObject({ network: 'proton', version: '1', capabilities: ['liveView'] });
  },
  90_000,
);

it(
  'mail through the manager: mailboxes, list, get, attachment, search',
  async () => {
    const { mailboxes } = await call('mail.mailboxes', {});
    expect(mailboxes.find((b: any) => b.role === 'inbox')).toMatchObject({ id: '0', total: 2, unread: 2 });
    expect(mailboxes.find((b: any) => b.path === 'Work/Clients')?.parentId).toBe(fake.folders[0].ID);
    const list = await call('mail.list', { mailboxId: '0', limit: 1 });
    expect(list.messages.map((x: any) => x.subject)).toEqual(['Welcome aboard']);
    const rest = await call('mail.list', { mailboxId: '0', limit: 5, before: list.next });
    expect(rest.messages.map((x: any) => x.subject)).toEqual(['Older news']);
    expect(rest.next).toBeNull();
    const got = await call('mail.get', { id: withFile });
    expect([got.subject, got.html, got.text]).toEqual(['Welcome aboard', '<p>Your <b>first</b> pelican.</p>', 'Your first pelican.']);
    expect(got.attachments.map((a: any) => [a.filename, a.mime, a.size])).toEqual([['notes.txt', 'text/plain', 14]]);
    const a = await call('mail.attachment', { id: withFile, attachmentId: got.attachments[0].id });
    expect(Buffer.from(a.base64, 'base64').toString()).toBe('attached words');
    // Reading it did not mark it read (Proton marks read only when asked).
    expect(fake.message(withFile)!.Unread).toBe(1);
    expect((await call('mail.search', { query: 'welcome' })).messages.map((x: any) => x.id)).toEqual([withFile]);
    const e = (await call('mail.get', { id: 'missingmessage' }).catch((x: any) => x)) as CallFailed;
    expect([e.code, e.status]).toEqual(['failed', 404]);
  },
  60_000,
);

it(
  'keeping up: mail.arrived and mail.changed from the event loop; mail.changes; flag, move, trash; 410',
  async () => {
    const start = (await call('mail.changes', { mailboxId: '0' })).state;
    const before = events[signedIn].length;
    const id = await fake.deliver({ subject: 'Fresh off the wire', html: '<p>new</p>' });
    await until(() => events[signedIn].slice(before).some((e) => e.t === 'mail.arrived' && e.message.id === id), 15_000, 'mail.arrived');
    const arrived = events[signedIn].slice(before).find((e) => e.t === 'mail.arrived');
    expect(arrived.message).toMatchObject({ subject: 'Fresh off the wire', mailboxId: '0' });
    const changed = events[signedIn].slice(before).find((e) => e.t === 'mail.changed' && e.mailboxId === '0');
    expect(changed.state).toMatch(/^e\./);
    const c = await call('mail.changes', { mailboxId: '0', state: start });
    expect(c.added.map((x: any) => x.id)).toEqual([id]);

    const mark = events[signedIn].length;
    expect(await call('mail.flag', { ids: [id], seen: true, flagged: true })).toEqual({});
    expect(fake.message(id)).toMatchObject({ Unread: 0 });
    expect(fake.message(id)!.LabelIDs).toContain('10');
    const c2 = await call('mail.changes', { mailboxId: '0', state: c.state });
    expect(c2.changed).toEqual([{ id, flags: { seen: true, flagged: true, answered: false, draft: false }, labels: [] }]);
    expect(await call('mail.move', { ids: [id], mailboxId: '6' })).toEqual({ ids: [id] });
    await until(() => events[signedIn].slice(mark).some((e) => e.t === 'mail.changed' && e.mailboxId === '6'), 10_000, 'mail.changed for the archive');
    const c3 = await call('mail.changes', { mailboxId: '0', state: c2.state });
    expect(c3.removed).toEqual([id]);
    expect(await call('mail.trash', { ids: [id] })).toEqual({});
    expect(fake.message(id)!.LabelIDs).toContain('3');

    const answered = (await call('mail.flag', { ids: [id], answered: true }).catch((x: any) => x)) as CallFailed;
    expect([answered.code, answered.status]).toEqual(['failed', 501]);

    fake.refreshEvents(1);
    const stale = (await call('mail.changes', { mailboxId: '0', state: c3.state }).catch((x: any) => x)) as CallFailed;
    expect([stale.code, stale.status]).toEqual(['failed', 410]);
  },
  60_000,
);

/** The session key a recipient's key packet holds (their key), or the package's clear one (no key). */
async function sessionKeyOf(entry: { BodyKeyPacket?: string }, pkg: SentPackage, key: openpgp.PrivateKey | null) {
  if (key) {
    const [sk] = await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(entry.BodyKeyPacket!, 'base64') }), decryptionKeys: key });
    return sk as { data: Uint8Array; algorithm: string };
  }
  return { data: Uint8Array.from(Buffer.from(pkg.BodyKey!.Key, 'base64')), algorithm: pkg.BodyKey!.Algorithm };
}
async function openWith(data: Uint8Array, sk: { data: Uint8Array; algorithm: string }) {
  const r = await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: data }), sessionKeys: sk as any, format: 'binary' });
  return Buffer.from(r.data as Uint8Array);
}
/** A recipient's package and entry in what went out. */
function entryOf(packages: Record<string, SentPackage>, email: string) {
  for (const [mime, pkg] of Object.entries(packages)) if (pkg.Addresses[email]) return { mime, pkg, entry: pkg.Addresses[email] };
  throw new Error(`${email} is in no package`);
}
/** Each address's [Type, Signature] in a package. */
const entries = (pkg: SentPackage) => Object.fromEntries(Object.entries(pkg.Addresses).map(([k, v]) => [k, [v.Type, v.Signature]]));
/** A send that must be refused before anything is made: the error. */
async function refused(f: FakeProton, input: any, account = signedIn): Promise<CallFailed> {
  const drafts = f.draftsMade;
  const sentBefore = f.sent.length;
  const e = (await app.call(mail, account, 'mail.send', input).catch((x: any) => x)) as CallFailed;
  expect(e).toBeInstanceOf(Error);
  expect([f.draftsMade, f.sent.length]).toEqual([drafts, sentBefore]);
  return e;
}
const SETTINGS = "Your Proton settings sign mail to outside addresses or attach your public key, which dither-chat can't do yet, so send this one from Proton.";

it(
  'mail.send to Proton users only (a contact with no settings, yourself, someone whose primary key is listed second): each encrypted to the key Proton picks, signed by your address key; nothing in the clear',
  async () => {
    const friend = (await fake.recipient('friend@proton.test', 'internal'))!;
    const twoKeys = (await fake.recipient('two-keys@proton.test', 'internal-two'))!;
    fake.contact('friend@proton.test');
    const r = await call('mail.send', { to: [{ name: 'Friend', email: 'friend@proton.test' }], cc: [{ name: null, email: fake.email }], bcc: [{ name: null, email: 'two-keys@proton.test' }], subject: 'Just us', text: 'only for keys' });
    const out = fake.sent.at(-1)!;
    expect(r.sentId).toBe(out.id);
    expect(r.messageId).toBe(`<${fake.message(out.id)!.ExternalID}>`);
    // The fake opened each one's body with their own key, and checked your signature on it.
    expect(out.verified).toEqual({ encrypted: 3, clear: 0, attachments: 0 });
    expect(Object.keys(out.packages)).toEqual(['text/plain']);
    const pkg = out.packages['text/plain']!;
    expect([pkg.Type, pkg.BodyKey, pkg.AttachmentKeys]).toEqual([1, undefined, undefined]);
    expect(entries(pkg)).toEqual({ 'friend@proton.test': [1, 1], [fake.email]: [1, 1], 'two-keys@proton.test': [1, 1] });
    expect((await openWith(pkg.Body, await sessionKeyOf(pkg.Addresses['friend@proton.test']!, pkg, friend))).toString()).toBe('only for keys');
    expect((await openWith(pkg.Body, await sessionKeyOf(pkg.Addresses[fake.email]!, pkg, fake.addressKeys.primary))).toString()).toBe('only for keys');
    expect((await openWith(pkg.Body, await sessionKeyOf(pkg.Addresses['two-keys@proton.test']!, pkg, twoKeys))).toString()).toBe('only for keys');
    await expect(sessionKeyOf(pkg.Addresses['friend@proton.test']!, pkg, twoKeys)).rejects.toThrow();
    expect([out.autoSaveContacts, out.delaySeconds]).toEqual([1, null]);
    expect(Buffer.from(pkg.Body).toString('latin1')).not.toContain('only for keys');
  },
  60_000,
);

it(
  'mail.send to a Proton user who also has unverified keys: Address.Keys decide, as Proton reads it, and the unverified key is not used',
  async () => {
    const key = (await fake.recipient('also-unverified@proton.test', 'internal-unverified'))!;
    await call('mail.send', { to: [{ name: null, email: 'also-unverified@proton.test' }], subject: 'Verified wins', text: 'to the verified key' });
    const out = fake.sent.at(-1)!;
    expect(out.verified).toEqual({ encrypted: 1, clear: 0, attachments: 0 });
    const pkg = out.packages['text/plain']!;
    expect(entries(pkg)).toEqual({ 'also-unverified@proton.test': [1, 1] });
    expect((await openWith(pkg.Body, await sessionKeyOf(pkg.Addresses['also-unverified@proton.test']!, pkg, key))).toString()).toBe('to the verified key');
  },
  60_000,
);

it(
  'mail.send to an outside address with no key: in the clear (type 4), the session key given to Proton, signed by your address key',
  async () => {
    await fake.recipient('plain@example.org', 'clear');
    const r = await call('mail.send', { to: [{ name: null, email: 'plain@example.org' }], subject: 'Out there', html: '<p>Hello <b>pelican</b></p>' });
    const out = fake.sent.at(-1)!;
    expect(r.sentId).toBe(out.id);
    expect(out.verified).toEqual({ encrypted: 0, clear: 1, attachments: 0 });
    const pkg = out.packages['text/html']!;
    expect([Object.keys(out.packages), pkg.Type, pkg.BodyKey?.Algorithm, pkg.AttachmentKeys]).toEqual([['text/html'], 4, 'aes256', undefined]);
    expect(entries(pkg)).toEqual({ 'plain@example.org': [4, 0] });
    expect(pkg.Addresses['plain@example.org']!.BodyKeyPacket).toBeUndefined();
    expect((await openWith(pkg.Body, await sessionKeyOf({}, pkg, null))).toString()).toBe('<p>Hello <b>pelican</b></p>');
  },
  60_000,
);

it(
  'mail.send to both at once, with a file: one package, its type the OR of theirs; each Proton recipient gets the body and the file under their own key, the outside one the keys in the clear',
  async () => {
    const friend = (await fake.recipient('friend@proton.test', 'internal'))!;
    await fake.recipient('plain@example.org', 'clear');
    const file = Buffer.from('attached words for sending');
    const r = await call('mail.send', {
      to: [{ name: 'Friend', email: 'friend@proton.test' }, { name: null, email: 'plain@example.org' }],
      cc: [{ name: null, email: fake.alias }],
      subject: 'Pelicans, encrypted where they can be',
      html: '<p>Hello <b>pelican</b></p>',
      attachments: [{ filename: 'notes.txt', mime: 'text/plain', base64: file.toString('base64') }],
    });
    const out = fake.sent.at(-1)!;
    expect(r.sentId).toBe(out.id);
    expect(out.verified).toEqual({ encrypted: 2, clear: 1, attachments: 3 });
    const att = fake.uploads.find((u) => u.draft === out.id)!;
    expect(att.name).toBe('notes.txt');
    // The draft's copy of the file opens with your own address key: it was encrypted to you.
    const [own] = await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(att.keyPackets, 'base64') }), decryptionKeys: fake.addressKeys.primary });
    expect((await openWith(att.data, own as any)).toString()).toBe('attached words for sending');
    const pkg = out.packages['text/html']!;
    expect([Object.keys(out.packages), pkg.Type]).toEqual([['text/html'], 5]);
    expect(entries(pkg)).toEqual({ 'friend@proton.test': [1, 1], 'plain@example.org': [4, 0], [fake.alias]: [1, 1] });
    // The Proton user: their key opens the body and the file; nobody else's does.
    const f = pkg.Addresses['friend@proton.test']!;
    expect((await openWith(pkg.Body, await sessionKeyOf(f, pkg, friend))).toString()).toBe('<p>Hello <b>pelican</b></p>');
    const [fatt] = await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(f.AttachmentKeyPackets![att.id]!, 'base64') }), decryptionKeys: friend });
    expect((await openWith(att.data, fatt as any)).toString()).toBe('attached words for sending');
    await expect(sessionKeyOf(f, pkg, fake.addressKeys.alias)).rejects.toThrow();
    // Your alias, as a recipient: its own key.
    expect((await openWith(pkg.Body, await sessionKeyOf(pkg.Addresses[fake.alias]!, pkg, fake.addressKeys.alias))).toString()).toBe('<p>Hello <b>pelican</b></p>');
    // The outside address: the session keys in the clear, for Proton to send it on.
    expect((await openWith(pkg.Body, await sessionKeyOf({}, pkg, null))).toString()).toBe('<p>Hello <b>pelican</b></p>');
    const clearAtt = pkg.AttachmentKeys![att.id]!;
    expect((await openWith(att.data, { data: Uint8Array.from(Buffer.from(clearAtt.Key, 'base64')), algorithm: clearAtt.Algorithm })).toString()).toBe('attached words for sending');
    expect(Buffer.from(pkg.Body).toString('latin1')).not.toContain('pelican');
    // The copy in Sent is the sent message.
    expect((await call('mail.list', { mailboxId: '7' })).messages.map((x: any) => x.id)).toContain(r.sentId);
  },
  60_000,
);

it(
  'a reply names its parent with Action 0, so Proton threads it and marks the original answered',
  async () => {
    await fake.recipient('friend@proton.test', 'internal');
    const original = await fake.deliver({ subject: 'Write back', text: 'please answer', from: { Name: 'Friend', Address: 'friend@proton.test' } });
    const r = await call('mail.send', { to: [{ name: null, email: 'friend@proton.test' }], subject: 'Re: Write back', text: 'answered', replyTo: original });
    const out = fake.sent.at(-1)!;
    expect([out.id, out.parentId, out.action, out.verified.encrypted]).toEqual([r.sentId, original, 0, 1]);
    expect(fake.message(original)!.IsReplied).toBe(1);
  },
  60_000,
);

it(
  "mail.send refuses each recipient it cannot be sure of (422 'recipients', one plain sentence, recipients by number), and makes nothing",
  async () => {
    const one = async (address: string, setup: () => unknown) => {
      await setup();
      const e = await refused(fake, { to: [{ name: null, email: address }], subject: 'x', text: 'x' });
      expect([e.code, e.status]).toEqual(['recipients', 422]);
      expect(e.message).not.toContain('@');
      return e.message;
    };
    const confirm = (why: string) => `Proton couldn't confirm how to send to recipient 1 (${why}), so send this one from Proton.`;
    const contacts = 'Recipient 1 has encryption settings or a pinned key in your Proton contacts, so send this one from Proton.';
    const published = 'Recipient 1 publishes an encryption key, so Proton would encrypt to it; send this one from Proton.';
    const nokey = 'Proton gave no key it can encrypt to for recipient 1, so send this one from Proton.';
    // Your contacts: a pinned key or an encryption setting, in the signed card or the clear one; settings Proton marks; a card that will not read.
    expect(await one('pinned@proton.test', async () => (await fake.recipient('pinned@proton.test', 'internal'), fake.contact('pinned@proton.test', { props: ['KEY'] })))).toBe(contacts);
    for (const p of ['X-PM-ENCRYPT', 'X-PM-SIGN', 'X-PM-SCHEME', 'X-PM-MIMETYPE']) expect(await one(`${p.toLowerCase()}@example.org`, () => fake.contact(`${p.toLowerCase()}@example.org`, { props: [p] }))).toBe(contacts);
    expect(await one('clearcard@example.org', () => fake.contact('clearcard@example.org', { props: ['X-PM-ENCRYPT'], cardType: 0 }))).toBe(contacts);
    expect(await one('defaults@example.org', () => fake.contact('defaults@example.org', { defaults: 0 }))).toBe(contacts);
    expect(await one('unreadable@example.org', () => fake.contact('unreadable@example.org', { unreadable: true }))).toBe(confirm('their contact card could not be read'));
    // What Proton's key lookup says.
    expect(await one('wkd@example.org', () => fake.recipient('wkd@example.org', 'wkd'))).toBe(published);
    expect(await one('keyed@example.org', () => fake.recipient('keyed@example.org', 'external-keys'))).toBe(published);
    expect(await one('gone@proton.test', () => fake.recipient('gone@proton.test', 'error'))).toBe(confirm('its key lookup failed: The address does not exist (code 33102)'));
    expect(await one('unverified@proton.test', () => fake.recipient('unverified@proton.test', 'unverified'))).toBe(confirm('Proton has only unverified keys for it'));
    expect(await one('odd@nomx.example.org', () => fake.recipient('odd@nomx.example.org', 'warn'))).toBe(confirm('Proton warns: The domain has no MX record'));
    expect(await one('anyone@catchall.proton.test', () => fake.recipient('anyone@catchall.proton.test', 'catchall'))).toBe(confirm('it is a catch-all address'));
    expect(await one('forwarding@proton.test', () => fake.recipient('forwarding@proton.test', 'internal-noencrypt'))).toBe(nokey);
    expect(await one('obsolete@proton.test', () => fake.recipient('obsolete@proton.test', 'internal-obsolete'))).toBe(nokey);
    expect(await one('keyless@proton.test', () => fake.recipient('keyless@proton.test', 'internal-nokeys'))).toBe(nokey);
    // Several at once: one sentence per kind of problem, in recipient order; the good ones are not named.
    await fake.recipient('friend@proton.test', 'internal');
    await fake.recipient('wkd2@example.org', 'wkd');
    const e = await refused(fake, {
      to: [{ name: null, email: 'friend@proton.test' }, { name: null, email: 'wkd@example.org' }],
      cc: [{ name: null, email: 'pinned@proton.test' }, { name: null, email: 'wkd2@example.org' }],
      bcc: [{ name: null, email: 'gone@proton.test' }, { name: null, email: 'forwarding@proton.test' }, { name: null, email: 'keyless@proton.test' }],
      subject: 'x',
      text: 'x',
    });
    expect([e.code, e.status]).toEqual(['recipients', 422]);
    expect(e.message).toBe(
      'Recipients 2 and 4 publish encryption keys, so Proton would encrypt to them; send this one from Proton. ' +
        'Recipient 3 has encryption settings or a pinned key in your Proton contacts, so send this one from Proton. ' +
        "Proton couldn't confirm how to send to recipient 5 (its key lookup failed: The address does not exist (code 33102)), so send this one from Proton. " +
        'Proton gave no key it can encrypt to for recipients 6 and 7, so send this one from Proton.',
    );
    // Bad input is still 400, with no code of ours.
    const e3 = (await call('mail.send', { to: [], subject: 'x', text: 'x' }).catch((x: any) => x)) as CallFailed;
    expect([e3.code, e3.status]).toEqual(['failed', 400]);
    expect(fake.rejected).toEqual([]);
  },
  120_000,
);

it(
  "your mail settings: signing for outside addresses or attaching your key refuses a send with someone in the clear (422 'settings'); Proton users alone still go",
  async () => {
    await fake.recipient('friend@proton.test', 'internal');
    await fake.recipient('plain@example.org', 'clear');
    const mixed = { to: [{ name: null, email: 'friend@proton.test' }, { name: null, email: 'plain@example.org' }], subject: 'x', text: 'x' };
    try {
      fake.setMailSettings({ Sign: 1 });
      const e1 = await refused(fake, mixed);
      expect([e1.code, e1.status, e1.message]).toEqual(['settings', 422, SETTINGS]);
      // Signing changes nothing for Proton users (their mail is always signed).
      const ok = await call('mail.send', { to: [{ name: null, email: 'friend@proton.test' }], subject: 'Signed anyway', text: 'signed' });
      expect([fake.sent.at(-1)!.id, fake.sent.at(-1)!.verified.encrypted]).toEqual([ok.sentId, 1]);
      // Signing with PGP/Inline: Proton would send plain text, even to Proton users, for an HTML message.
      fake.setMailSettings({ PGPScheme: 8 });
      const e2 = await refused(fake, { to: [{ name: null, email: 'friend@proton.test' }], subject: 'x', html: '<p>x</p>' });
      expect([e2.code, e2.status, e2.message]).toEqual(['settings', 422, SETTINGS]);
      fake.setMailSettings({ Sign: 0, PGPScheme: 16, AttachPublicKey: 1 });
      const e3 = await refused(fake, mixed);
      expect([e3.code, e3.status, e3.message]).toEqual(['settings', 422, SETTINGS]);
      // A recipient problem comes first, as 'recipients'.
      const e4 = await refused(fake, { ...mixed, cc: [{ name: null, email: 'wkd@example.org' }] });
      expect(e4.code).toBe('recipients');
    } finally {
      fake.setMailSettings({ Sign: 0, PGPScheme: 16, AttachPublicKey: 0 });
    }
    const back = await call('mail.send', mixed);
    expect([fake.sent.at(-1)!.id, fake.sent.at(-1)!.verified]).toEqual([back.sentId, { encrypted: 1, clear: 1, attachments: 0 }]);
    // Every send that went out is counted; refusals are not.
    await until(() => statusOf(signedIn).details.sent === 6, 5000, 'six sent');
    expect(fake.rejected).toEqual([]);
  },
  60_000,
);

it(
  "mail.send `from`: one of the account's addresses picks the address the page sends from (and its keys); any other is 422 'from' and makes nothing",
  async () => {
    const friend = (await fake.recipient('friend@proton.test', 'internal'))!;
    const aliasId = fake.addresses.find((a) => a.Email === fake.alias)!.ID;
    const r = await call('mail.send', { from: fake.alias.toUpperCase(), to: [{ name: null, email: 'friend@proton.test' }], subject: 'From the alias', text: 'alias-sent' });
    const sentMsg = fake.message(r.sentId)!;
    expect([sentMsg.AddressID, sentMsg.Sender.Address]).toEqual([aliasId, fake.alias]);
    // The fake checked the signature against the alias's key.
    expect(fake.sent.at(-1)!.verified.encrypted).toBe(1);
    const f = entryOf(fake.sent.at(-1)!.packages, 'friend@proton.test');
    expect((await openWith(f.pkg.Body, await sessionKeyOf(f.entry, f.pkg, friend))).toString()).toBe('alias-sent');
    // A reply from the primary address, sent as the alias because `from` says so.
    const original = await fake.deliver({ subject: 'To the primary', text: 'hi', from: { Name: 'Friend', Address: 'friend@proton.test' } });
    const r2 = await call('mail.send', { from: fake.alias, to: [{ name: null, email: 'friend@proton.test' }], subject: 'Re: To the primary', text: 'from the alias', replyTo: original });
    expect([fake.message(r2.sentId)!.AddressID, fake.sent.at(-1)!.parentId]).toEqual([aliasId, original]);
    const e = await refused(fake, { from: 'mallory@example.org', to: [{ name: null, email: 'friend@proton.test' }], subject: 'x', text: 'x' });
    expect([e.code, e.status]).toEqual(['from', 422]);
    expect(e.message).not.toContain('mallory');
  },
  60_000,
);

it(
  "the saved session will not open: the keys open through the page's crypto proxy, and mail still reads and sends",
  async () => {
    pageSends = (await app.admin({ do: 'create', kind: 'proton', label: 'Proton (page keys)', config: { testOrigin: viaPage.url, pollSeconds: 1, modulesGraceSeconds: 5 } })).id;
    await until(() => statusOf(pageSends)?.status === 'online' && statusOf(pageSends)?.layers?.every((l: any) => l.state === 'ok'), 60_000, 'online through the page');
    const st = statusOf(pageSends);
    expect(st.layers.find((l: any) => l.name === 'keys unlocked').note).toBe("through the page's crypto proxy (2 keys on 2 of 2 addresses); the saved-session unlock failed: the session blob did not open with this ClientKey");
    expect(st.details).toMatchObject({ unlockPath: 'page', sessionUnlockError: 'the session blob did not open with this ClientKey', pageKeys: '2 keys on 2 of 2 addresses', userKeys: null, addressKeys: null, sendPath: 'found' });
    expect(st.self).toEqual({ email: viaPage.email, displayName: 'Pat Proton', addresses: [{ email: viaPage.email, name: 'Pat Proton' }, { email: viaPage.alias, name: null }] });
    expect(st.details).toMatchObject({ canSend: true, sendNote: null });
    const got = (await app.call(mail, pageSends, 'mail.get', { id: pageFile })) as any;
    expect([got.html, got.attachments.map((a: any) => a.filename)]).toEqual(["<p>read by the app's own keys</p>", ['page.txt']]);
    const a = (await app.call(mail, pageSends, 'mail.attachment', { id: pageFile, attachmentId: got.attachments[0].id })) as any;
    expect(Buffer.from(a.base64, 'base64').toString()).toBe('page bytes');
    const friend = (await viaPage.recipient('friend@proton.test', 'internal'))!;
    const r = (await app.call(mail, pageSends, 'mail.send', { to: [{ name: null, email: 'friend@proton.test' }], subject: 'From the page', text: 'page-sent' })) as any;
    const out = viaPage.sent.at(-1)!;
    expect([r.sentId, out.verified]).toEqual([out.id, { encrypted: 1, clear: 0, attachments: 0 }]);
    const f = entryOf(out.packages, 'friend@proton.test');
    expect((await openWith(f.pkg.Body, await sessionKeyOf(f.entry, f.pkg, friend))).toString()).toBe('page-sent');
  },
  90_000,
);

it(
  "as on the live build (Proton's composer functions folded away, the ClientKey call refused): the send path needs none of them, canSend is true, and it sends",
  async () => {
    pageFolded = (await app.admin({ do: 'create', kind: 'proton', label: 'Proton (live-like)', config: { testOrigin: folded.url, pollSeconds: 1, modulesGraceSeconds: 3 } })).id;
    await until(() => statusOf(pageFolded)?.status === 'online' && statusOf(pageFolded)?.layers?.every((l: any) => l.state === 'ok'), 60_000, 'online, every layer ok');
    const st = statusOf(pageFolded);
    expect(st.layers.find((l: any) => l.name === 'keys unlocked').note).toBe("through the page's crypto proxy (2 keys on 2 of 2 addresses); the saved-session unlock failed: Proton refused the ClientKey call (404 code 404)");
    expect(st.layers.find((l: any) => l.name === 'send path').note).toStartWith("the page's API caller, store, crypto proxy and address keys found");
    expect(st.details).toMatchObject({ modules: 'CryptoProxy AppApi Store AddressKeysByUsage', modulesMissing: null, sendPath: 'found', canSend: true, sendNote: null });
    await folded.recipient('friend@proton.test', 'internal');
    const r = (await app.call(mail, pageFolded, 'mail.send', { to: [{ name: null, email: 'friend@proton.test' }], cc: [{ name: null, email: folded.alias }], subject: 'Live-like', text: 'live-like send' })) as any;
    expect([folded.sent.at(-1)!.id, folded.sent.at(-1)!.verified]).toEqual([r.sentId, { encrypted: 2, clear: 0, attachments: 0 }]);
    // A message to the second address opens through the page too.
    const list = (await app.call(mail, pageFolded, 'mail.list', { mailboxId: '0' })) as any;
    const got = (await app.call(mail, pageFolded, 'mail.get', { id: list.messages.find((m: any) => m.subject === 'Folded inbox').id })) as any;
    expect(got.text).toBe('folded text');
  },
  90_000,
);

for (const missing of ['CryptoProxy', 'AddressKeysByUsage'] as const) {
  it(
    `the page's ${missing} not found: the send path layer fails naming it, canSend is false with a note, mail.send is 501 and makes nothing; reading works`,
    async () => {
      const f = await startFakeProton({ pagePollMs: 500, withhold: [missing] });
      let id = '';
      try {
        await f.deliver({ subject: 'Still readable', text: 'readable text' });
        id = (await app.admin({ do: 'create', kind: 'proton', label: `Proton (no ${missing})`, config: { testOrigin: f.url, pollSeconds: 1, modulesGraceSeconds: 3 } })).id;
        await until(() => statusOf(id)?.status === 'online' && statusOf(id)?.layers?.find((l: any) => l.name === 'send path')?.state === 'failed', 60_000, 'online, the send path failed');
        const st = statusOf(id);
        expect(st.layers.find((l: any) => l.name === 'app modules')).toMatchObject({ state: 'failed', note: `not found: ${missing}; sending and the page-side unlock need them` });
        expect(st.layers.find((l: any) => l.name === 'send path')).toMatchObject({ state: 'failed', note: `not found in the page: ${missing}; mail.send refuses (see docs/proton.md, "Sending")` });
        expect(st.details).toMatchObject({ modulesMissing: missing, sendPath: `missing ${missing}`, canSend: false });
        expect(st.details.sendNote).toBe(`Mail cannot be sent from this account: parts of Proton's Mail page that sending uses were not found (${missing}), so sending is refused. Reading, marking, moving and trash still work.`);
        await f.recipient('friend@proton.test', 'internal');
        const e = await refused(f, { to: [{ name: null, email: 'friend@proton.test' }], subject: 'x', text: 'x' }, id);
        expect([e.code, e.status]).toEqual(['failed', 501]);
        expect(e.message).toBe(`the Mail page's ${missing} was not found, so nothing was sent`);
        const list = (await app.call(mail, id, 'mail.list', { mailboxId: '0' })) as any;
        expect(((await app.call(mail, id, 'mail.get', { id: list.messages[0].id })) as any).text).toBe('readable text');
      } finally {
        if (id) await app.admin({ do: 'delete', account: id, purge: true }).catch(() => {});
        f.stop();
      }
      await until(() => processesOf([id]).length === 0, 15_000, 'its processes gone');
    },
    90_000,
  );
}

it(
  'an access token that runs out: the hook waits for the page to refresh it, and never refreshes itself',
  async () => {
    fake.expireAccess();
    const list = await call('mail.list', { mailboxId: '0', limit: 5 });
    expect(list.messages.length).toBeGreaterThan(0);
    const refreshes = fake.calls.filter((c) => c.path === 'auth/refresh');
    expect(refreshes.length).toBeGreaterThan(0);
    expect(refreshes.every((c) => c.by === 'page')).toBe(true);
    // Every call of ours carried the app's own headers, copied, and the session's uid; nothing else of note.
    const ours = fake.hookCalls();
    expect(ours.length).toBeGreaterThan(10);
    for (const c of ours) {
      expect([c.headers.accept, c.headers['x-pm-appversion'], c.headers['x-pm-locale'], c.headers['x-pm-uid']]).toEqual([ACCEPT, APP_VERSION, 'en_US', fake.secrets.UID]);
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers['x-fake-caller']).toBeUndefined();
    }
    expect(statusOf(signedIn).status).toBe('online');
  },
  90_000,
);

it(
  'not signed in: attention, sign in in the live view; calls say so',
  async () => {
    signedOut = (await app.admin({ do: 'create', kind: 'proton', label: 'Proton (signed out)', config: { testOrigin: out.url } })).id;
    await until(() => statusOf(signedOut)?.status === 'attention', 60_000, 'attention');
    const st = statusOf(signedOut);
    expect(st.attention).toEqual({ kind: 'login', message: 'Sign in to Proton in the live view (tick "Keep me signed in")', liveView: true });
    expect(st.details).toMatchObject({ signedIn: false, mailPage: true, page: `${out.url}/login`, canSend: false, sendNote: 'Mail cannot be sent: Proton is not signed in. Sign in in the live view.' });
    expect(st.layers.find((l: any) => l.name === 'signed in')).toEqual({ name: 'signed in', state: 'waiting', note: 'sign in to Proton in the live view' });
    const lv = m!.router.liveView(signedOut)!;
    expect(await rfbBanner(lv.vncSocket)).toMatch(/^RFB /);
    const e = (await app.call(mail, signedOut, 'mail.mailboxes', {}).catch((x: any) => x)) as CallFailed;
    expect([e.code, e.status]).toEqual(['failed', 401]);
  },
  90_000,
);

it(
  'signed out by Proton: the page goes to the sign-in, the account asks for it',
  async () => {
    fake.signOut();
    fake.expireAccess();
    await until(() => statusOf(signedIn)?.status === 'attention' && statusOf(signedIn)?.attention?.kind === 'login', 30_000, 'attention after a sign-out');
    const e = (await call('mail.mailboxes', {}).catch((x: any) => x)) as CallFailed;
    expect([e.code, e.status]).toEqual(['failed', 401]);
  },
  60_000,
);

it('no key, password, token, cookie or message content in the logs or the statuses', () => {
  const said = JSON.stringify(events);
  const logs = [signedIn, signedOut, pageSends, pageFolded].map((id) => readFileSync(join(m!.store.account(id)!.dir, 'adapter.log'), 'utf8')).join('\n');
  const s = fake.secrets;
  const recipients = ['friend@proton.test', 'two-keys@proton.test', 'plain@example.org', 'pinned@proton.test', 'x-pm-encrypt@example.org', 'clearcard@example.org', 'defaults@example.org', 'unreadable@example.org', 'wkd@example.org', 'wkd2@example.org', 'keyed@example.org', 'gone@proton.test', 'unverified@proton.test', 'odd@nomx.example.org', 'anyone@catchall.proton.test', 'forwarding@proton.test', 'obsolete@proton.test', 'keyless@proton.test', 'mallory@example.org'];
  const others = [viaPage.secrets, folded.secrets].flatMap((x) => [x.keyPassword, x.clientKey, x.UID, x.token]);
  for (const secret of [s.keyPassword, s.clientKey, s.UID, s.access, s.refresh, s.blob.slice(0, 40), s.token, 'pelican', 'attached words', 'secret-query', 'secret-hash', 'BEGIN PGP', 'only for keys', 'page-sent', 'page bytes', "app's own keys", 'folded text', 'live-like send', 'alias-sent', ...others]) {
    expect(said).not.toContain(secret);
    expect(logs).not.toContain(secret);
  }
  // Recipients' addresses are never logged, nor said in a status (mail events carry senders, as they must).
  const statuses = JSON.stringify(Object.values(events).flat().filter((e) => e.t === 'status'));
  for (const r of recipients) {
    expect(logs).not.toContain(r);
    expect(statuses).not.toContain(r);
  }
  expect(logs).toContain('keys unlocked');
  // events.json keeps only an event id.
  expect(Object.keys(JSON.parse(readFileSync(join(m!.store.account(signedIn)!.dir, 'events.json'), 'utf8')))).toEqual(['eventId']);
});

it(
  'stopping the manager stops every process it started for them',
  async () => {
    const all = [signedIn, signedOut, pageSends, pageFolded];
    const displays = all.map((id) => Number(String(statusOf(id).details.display).slice(1)));
    expect(processesOf(all).length).toBeGreaterThanOrEqual(16);
    app.close();
    await m!.stop();
    m = null;
    await until(() => processesOf(all).length === 0, 15_000, 'every process gone');
    for (const n of displays) expect(existsSync(`/tmp/.X${n}-lock`)).toBe(false);
  },
  30_000,
);
