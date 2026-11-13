/**
 * The proton kind without a browser: the persisted session's blob in each of its versions, the key unlock chain, and
 * every `mail` op against the fake Proton (fake-proton.ts) through a transport that calls it straight, as the page's
 * hook would. test/proton-browser.test.ts runs the same extractor in its real sandbox.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatusError } from '@dither-accounts/link';
import { type ApiRequest, ProtonApi, template, type Transport } from '../extractors/proton/src/api.ts';
import { fold, ProtonMail, type Seen, stateOf } from '../extractors/proton/src/mail.ts';
import { KeyError, localDecryptor, openpgp, type ProtonAddress, type ProtonUser, type Unlocked, unlockKeys } from '../extractors/proton/src/pgp.ts';
import { checkOutgoing, checkPageSend, pickFrom, SEND_CAP, SETTINGS_REFUSAL, send, sendingAddresses } from '../extractors/proton/src/send.ts';
import { openSessionBlob, sealSessionBlob } from '../extractors/proton/src/session.ts';
import { ACCEPT, APP_VERSION, type FakeProton, startFakeProton } from './fake-proton.ts';

process.env.DITHER_PROTON_BACKOFF_MS = '1';

function direct(fake: FakeProton): Transport {
  return async (req: ApiRequest) => {
    const u = new URL(`/api/${req.path}`, fake.url);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(`${k}[]`, String(x));
      else u.searchParams.append(k, String(v));
    }
    const res = await fetch(u, {
      method: req.method,
      headers: {
        accept: ACCEPT,
        'x-pm-appversion': APP_VERSION,
        'x-pm-locale': 'en_US',
        'x-pm-uid': fake.secrets.UID,
        cookie: `AUTH-${fake.secrets.UID}=${fake.secrets.access}`,
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    if (req.binary && res.ok) return { status: res.status, base64: Buffer.from(await res.arrayBuffer()).toString('base64') };
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text), retryAfter: res.headers.get('retry-after') };
    } catch {
      return { status: res.status, text };
    }
  };
}

const logs: string[] = [];
const log = (_l: string, msg: string, data?: unknown) => void logs.push(`${msg} ${data === undefined ? '' : JSON.stringify(data)}`);

/** The extractor's unlock, step for step: ClientKey, blob, user, addresses, keys. */
async function unlockVia(api: ProtonApi, fake: FakeProton): Promise<Unlocked> {
  const { ClientKey } = await api.call({ method: 'GET', path: 'auth/v4/sessions/local/key' });
  const { keyPassword } = await openSessionBlob(fake.secrets.blob, ClientKey, 3);
  const { User } = await api.call<{ User: ProtonUser }>({ method: 'GET', path: 'core/v4/users' });
  const { Addresses } = await api.call<{ Addresses: ProtonAddress[] }>({ method: 'GET', path: 'core/v4/addresses', query: { Page: 0, PageSize: 50 } });
  return unlockKeys(User, Addresses, keyPassword);
}

describe('the persisted session', () => {
  const clientKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  for (const v of [1, 2, 3] as const) {
    test(`payload version ${v} opens with the ClientKey`, async () => {
      const blob = await sealSessionBlob({ keyPassword: 'Ünïcode-kp/+=' }, clientKey, v);
      const iv = v === 3 ? 12 : 16;
      expect(Buffer.from(blob, 'base64').length).toBe(iv + Buffer.byteLength(JSON.stringify({ keyPassword: 'Ünïcode-kp/+=' }), v === 3 ? 'utf8' : 'latin1') + 16);
      expect(await openSessionBlob(blob, clientKey, v)).toEqual({ keyPassword: 'Ünïcode-kp/+=', offline: false });
    });
  }
  test('an offline key password is noticed, not needed', async () => {
    const blob = await sealSessionBlob({ keyPassword: 'kp', offlineKeyPassword: 'okp' }, clientKey, 3);
    expect(await openSessionBlob(blob, clientKey, 3)).toEqual({ keyPassword: 'kp', offline: true });
  });
  test('the wrong key, the wrong version, a damaged blob: refused', async () => {
    const blob = await sealSessionBlob({ keyPassword: 'kp' }, clientKey, 3);
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    await expect(openSessionBlob(blob, other, 3)).rejects.toThrow('did not open');
    await expect(openSessionBlob(blob, clientKey, 2)).rejects.toThrow('did not open');
    await expect(openSessionBlob(blob, clientKey, 7)).rejects.toThrow('unknown session payload version');
    await expect(openSessionBlob(blob.slice(0, 20), clientKey, 3)).rejects.toThrow();
    await expect(openSessionBlob(blob, Buffer.from('short').toString('base64'), 3)).rejects.toThrow('not 32');
  });
});

describe('against the fake Proton', () => {
  let fake: FakeProton;
  let api: ProtonApi;
  let keys: Unlocked;
  let mail: ProtonMail;
  let unlocks = 0;

  beforeAll(async () => {
    fake = await startFakeProton({ legacyAlias: true, eventsPerPage: 3 });
    api = new ProtonApi(direct(fake), log);
    keys = await unlockVia(api, fake);
    mail = new ProtonMail(api, { get: async () => localDecryptor(keys), again: async () => (unlocks++, localDecryptor((keys = await unlockVia(api, fake)))) }, log);
  });
  afterAll(() => fake?.stop());

  test('the key password opens the user key, the tokens open the address keys, the legacy one opens with the key password', async () => {
    expect(keys.counts).toEqual({ userKeys: 1, userOpened: 1, addressKeys: 2, addressOpened: 2, addresses: 2 });
    expect(keys.addresses.map((a) => a.email)).toEqual([fake.email, fake.alias]);
    expect(keys.addresses[0].primary!.getFingerprint()).toBe(fake.addressKeys.primary.getFingerprint());
    const { User } = await api.call<{ User: ProtonUser }>({ method: 'GET', path: 'core/v4/users' });
    const { Addresses } = await api.call<{ Addresses: ProtonAddress[] }>({ method: 'GET', path: 'core/v4/addresses' });
    await expect(unlockKeys(User, Addresses, 'not the key password')).rejects.toBeInstanceOf(KeyError);
    // A token whose signature is not the user key's does not open its address key (the key is skipped).
    const forged = structuredClone(Addresses);
    const other = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: 'x@y.z' }], format: 'object' });
    forged[0].Keys[0].Signature = await openpgp.sign({ message: await openpgp.createMessage({ text: fake.secrets.token }), signingKeys: other.privateKey, detached: true });
    const got = await unlockKeys(User, forged, fake.secrets.keyPassword);
    expect(got.counts.addressOpened).toBe(1);
  });

  test('mail.mailboxes: the system folders with roles, custom folders with their parent, counts', async () => {
    await fake.deliver({ subject: 'Counted', unread: true });
    const { mailboxes } = await mail.mailboxes();
    const role = (r: string) => mailboxes.find((b) => b.role === r)?.id;
    expect([role('inbox'), role('sent'), role('drafts'), role('archive'), role('junk'), role('trash'), role('all'), role('flagged')]).toEqual(['0', '7', '8', '6', '4', '3', '5', '10']);
    const work = mailboxes.find((b) => b.name === 'Work')!;
    const clients = mailboxes.find((b) => b.name === 'Clients')!;
    expect(work).toMatchObject({ path: 'Work', parentId: null, role: null });
    expect(clients).toMatchObject({ path: 'Work/Clients', parentId: work.id });
    expect(mailboxes.find((b) => b.id === '0')).toMatchObject({ name: 'Inbox', total: 1, unread: 1 });
    // Labels are not mailboxes.
    expect(mailboxes.some((b) => b.name === 'Receipts')).toBe(false);
  });

  test('mail.list: newest first, a page at a time with the anchor cursor, since', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    for (let i = 1; i <= 7; i++) await fake.deliver({ subject: `Listed ${i}`, time: t0 + i, labelIds: ['6'] });
    const first = await mail.list({ mailboxId: '6', limit: 3 });
    expect(first.messages.map((m) => m.subject)).toEqual(['Listed 7', 'Listed 6', 'Listed 5']);
    expect(first.next).toMatch(/^\d+\./);
    const second = await mail.list({ mailboxId: '6', limit: 3, before: first.next! });
    expect(second.messages.map((m) => m.subject)).toEqual(['Listed 4', 'Listed 3', 'Listed 2']);
    const third = await mail.list({ mailboxId: '6', limit: 3, before: second.next! });
    expect(third.messages.map((m) => m.subject)).toEqual(['Listed 1']);
    expect(third.next).toBeNull();
    const since = await mail.list({ mailboxId: '6', since: (t0 + 5) * 1000 });
    expect(since.messages.map((m) => m.subject)).toEqual(['Listed 7', 'Listed 6', 'Listed 5']);
    expect(since.next).toBeNull();
    const big = await mail.list({ mailboxId: '6', limit: 500 });
    expect(big.messages.length).toBe(7);
    const s = first.messages[0];
    expect(s).toMatchObject({ mailboxId: '6', threadId: expect.any(String), from: [{ name: 'Sam Sender', email: 'sam@example.org' }], to: [{ name: 'Pat Proton', email: fake.email }], flags: { seen: false, flagged: false, answered: false, draft: false }, preview: null, hasAttachments: false });
    expect(s.messageId).toMatch(/^<.+@mail\.example>$/);
    expect(s.date).toBe((t0 + 7) * 1000);
    await expect(mail.list({ mailboxId: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(mail.list({ mailboxId: '6', before: 'garbage' })).rejects.toMatchObject({ status: 400 });
  });

  test("mail.list: Proton's categories as labels, from LabelIDs, CategoryID or a newsletter subscription; Primary is none", async () => {
    const promo = await fake.deliver({ subject: 'Category promo', labelIds: ['0', '21'] });
    const social = await fake.deliver({ subject: 'Category social', categoryId: '20' });
    const news = await fake.deliver({ subject: 'Category news', newsletterId: 'sub-1' });
    const primary = await fake.deliver({ subject: 'Category primary', labelIds: ['0', '24'], categoryId: '24' });
    const got = new Map((await mail.list({ mailboxId: '0', limit: 500 })).messages.map((m) => [m.id, m.labels]));
    expect(got.get(promo)).toEqual(['Category/Promotions']);
    expect(got.get(social)).toEqual(['Category/Social']);
    expect(got.get(news)).toEqual(['Category/Newsletters']);
    expect(got.get(primary)).toEqual([]);
  });

  test('mail.get: the HTML body decrypted, text made from it, headers, attachments; a plain one; one to the legacy alias', async () => {
    const id = await fake.deliver({
      subject: 'With a file',
      html: '<p>Hello <b>Pat</b>, see the <i>pelican</i>.</p>',
      headers: { 'In-Reply-To': '<parent@mail.example>', References: '<root@mail.example> <parent@mail.example>' },
      attachments: [
        { name: 'data.bin', mime: 'application/octet-stream', data: Buffer.from('0123456789') },
        { name: 'logo.png', mime: 'image/png', data: Buffer.from([137, 80, 78, 71]), inline: true, contentId: 'logo@x' },
      ],
    });
    fake.label(id, ['labelme'].filter(() => false));
    const m = await mail.get(id);
    expect(m.html).toBe('<p>Hello <b>Pat</b>, see the <i>pelican</i>.</p>');
    expect(m.text).toBe('Hello Pat, see the pelican.');
    expect(m.inReplyTo).toBe('<parent@mail.example>');
    expect(m.references).toEqual(['<root@mail.example>', '<parent@mail.example>']);
    expect(m.replyTo).toEqual([{ name: 'Sam Sender', email: 'sam@example.org' }]);
    expect(m.attachments.map((a) => [a.filename, a.mime, a.size, a.inline, a.contentId])).toEqual([
      ['data.bin', 'application/octet-stream', 10, false, null],
      ['logo.png', 'image/png', 4, true, 'logo@x'],
    ]);
    expect(m.hasAttachments).toBe(true);
    const a = await mail.attachment(id, m.attachments[0].id);
    expect([a.filename, a.mime, Buffer.from(a.base64, 'base64').toString()]).toEqual(['data.bin', 'application/octet-stream', '0123456789']);
    await expect(mail.attachment(id, 'nope')).rejects.toMatchObject({ status: 404 });
    fake.inflate(id, 26 * 1024 * 1024);
    await expect(mail.attachment(id, m.attachments[0].id)).rejects.toMatchObject({ status: 413 });

    const plain = await mail.get(await fake.deliver({ subject: 'Plain', text: 'line one\r\nline two' }));
    expect([plain.text, plain.html]).toEqual(['line one\nline two', null]);
    const toAlias = await mail.get(await fake.deliver({ subject: 'To the alias', text: 'for the alias', toAlias: true }));
    expect(toAlias.text).toBe('for the alias');
    await expect(mail.get('doesnotexist')).rejects.toMatchObject({ status: 404 });
  });

  test('PGP/MIME: the body is a MIME message; its text, HTML and parts', async () => {
    const mime = [
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: multipart/alternative; boundary="b2"',
      '',
      '--b2',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain from MIME',
      '--b2',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML from MIME</p>',
      '--b2--',
      '--b1',
      'Content-Type: text/csv; name="table.csv"',
      'Content-Disposition: attachment; filename="table.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('a,b\n1,2\n').toString('base64'),
      '--b1--',
      '',
    ].join('\r\n');
    const id = await fake.deliver({ subject: 'PGP/MIME', mime });
    const m = await mail.get(id);
    expect(m.text?.trim()).toBe('Plain from MIME');
    expect(m.html?.trim()).toBe('<p>HTML from MIME</p>');
    expect(m.attachments).toEqual([{ id: 'mime.0', filename: 'table.csv', mime: 'text/csv', size: 8, inline: false, contentId: null }]);
    const a = await mail.attachment(id, 'mime.0');
    expect(Buffer.from(a.base64, 'base64').toString()).toBe('a,b\n1,2\n');
    await expect(mail.attachment(id, 'mime.5')).rejects.toMatchObject({ status: 404 });
  });

  test('mail.search: Proton’s server search on the subject and the people, not the (encrypted) body', async () => {
    await fake.deliver({ subject: 'Quarterly pelican report', html: '<p>nothing</p>', from: { Name: 'Rita Reports', Address: 'rita@example.org' } });
    await fake.deliver({ subject: 'Unrelated', html: '<p>the word pelican only in the body</p>' });
    expect((await mail.search({ query: 'pelican' })).messages.map((m) => m.subject)).toEqual(['Quarterly pelican report']);
    expect((await mail.search({ query: 'rita@example.org' })).messages.map((m) => m.subject)).toEqual(['Quarterly pelican report']);
    expect((await mail.search({ query: 'Quarterly', mailboxId: '3' })).messages).toEqual([]);
    expect((await mail.search({ query: '   ' })).messages).toEqual([]);
    const q = fake.hookCalls().find((c) => c.path === 'mail/v4/messages' && c.search.includes('Keyword=pelican'))!;
    expect(new URLSearchParams(q.search).get('LabelID')).toBe('15');
  });

  test('mail.changes: added, changed, removed by the event loop; the same state twice is nothing new', async () => {
    const start = await mail.changes({ mailboxId: '0' });
    expect(start).toMatchObject({ added: [], changed: [], removed: [], more: false });
    expect(start.state).toBe(stateOf(fake.latestEvent()));
    const a = await fake.deliver({ subject: 'Change A' });
    const b = await fake.deliver({ subject: 'Change B' });
    const c1 = await mail.changes({ mailboxId: '0', state: start.state });
    expect(c1.added.map((m) => m.subject)).toEqual(['Change A', 'Change B']);
    expect([c1.changed, c1.removed, c1.more]).toEqual([[], [], false]);
    fake.setUnread(a, false);
    fake.label(a, ['10']);
    fake.label(b, ['6']);
    const c2 = await mail.changes({ mailboxId: '0', state: c1.state });
    expect(c2.added).toEqual([]);
    expect(c2.changed).toEqual([{ id: a, flags: { seen: true, flagged: true, answered: false, draft: false }, labels: [] }]);
    expect(c2.removed).toEqual([b]);
    const arch = await mail.changes({ mailboxId: '6', state: c1.state });
    expect(arch.added.map((m) => [m.id, m.mailboxId])).toEqual([[b, '6']]);
    fake.remove(a);
    const c3 = await mail.changes({ mailboxId: '0', state: c2.state });
    expect(c3.removed).toEqual([a]);
    const same = await mail.changes({ mailboxId: '0', state: c3.state });
    expect(same).toEqual({ state: c3.state, added: [], changed: [], removed: [], more: false });
    // An update that does not say where the message is: the extractor asks for the message.
    fake.bareUpdate(b);
    const c4 = await mail.changes({ mailboxId: '6', state: c3.state });
    expect(c4.changed.map((x) => x.id)).toEqual([b]);
    // Labels by name.
    fake.label(b, [fake.labels[0].ID]);
    const c5 = await mail.changes({ mailboxId: '6', state: c4.state });
    expect(c5.changed).toEqual([{ id: b, flags: expect.any(Object), labels: ['Receipts'] }]);
  });

  test('mail.changes: a page at a time past the limit (more), then the rest', async () => {
    const start = (await mail.changes({ mailboxId: '0' })).state;
    for (let i = 0; i < 8; i++) await fake.deliver({ subject: `Burst ${i}` });
    const first = await mail.changes({ mailboxId: '0', state: start, limit: 2 });
    expect(first.more).toBe(true);
    expect(first.added.length).toBe(3); // one events page (3 here) at least
    let all = first.added.map((m) => m.subject);
    let st = first.state;
    for (let i = 0; i < 5; i++) {
      const next = await mail.changes({ mailboxId: '0', state: st, limit: 2 });
      all = all.concat(next.added.map((m) => m.subject));
      st = next.state;
      if (!next.more) break;
    }
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `Burst ${i}`));
  });

  test('mail.changes: 410 when Proton asks for a refresh or forgot the id; 400 for a state it never gave', async () => {
    const st = (await mail.changes({ mailboxId: '0' })).state;
    fake.refreshEvents(1);
    await expect(mail.changes({ mailboxId: '0', state: st })).rejects.toMatchObject({ status: 410 });
    fake.forgetEvents();
    await expect(mail.changes({ mailboxId: '0', state: st })).rejects.toMatchObject({ status: 410 });
    await expect(mail.changes({ mailboxId: '0', state: 'q.1.2.3' })).rejects.toMatchObject({ status: 400 });
  });

  test('mail.flag: read, unread, starred; answered is Proton’s own and refused', async () => {
    const id = await fake.deliver({ subject: 'Flag me' });
    await mail.flag({ ids: [id], seen: true, flagged: true });
    expect(fake.message(id)).toMatchObject({ Unread: 0, LabelIDs: expect.arrayContaining(['0', '10']) });
    await mail.flag({ ids: [id], seen: false, flagged: false });
    expect(fake.message(id)!.Unread).toBe(1);
    expect(fake.message(id)!.LabelIDs).not.toContain('10');
    await expect(mail.flag({ ids: [id], answered: true })).rejects.toMatchObject({ status: 501 });
    await expect(mail.flag({ ids: ['missingmessage'], seen: true })).rejects.toMatchObject({ status: 404 });
  });

  test('mail.move: the same ids back; null where Proton refused; views are not folders', async () => {
    const id = await fake.deliver({ subject: 'Move me' });
    const work = fake.folders[0].ID;
    expect(await mail.move({ ids: [id], mailboxId: work })).toEqual({ ids: [id] });
    expect(fake.message(id)!.LabelIDs).toContain(work);
    expect(fake.message(id)!.LabelIDs).not.toContain('0');
    expect(await mail.move({ ids: [id, 'missingmessage'], mailboxId: '0' })).toEqual({ ids: [id, null] });
    expect(await mail.move({ ids: [id], mailboxId: '7' })).toEqual({ ids: [null] }); // a received message is not Sent mail
    await expect(mail.move({ ids: [id], mailboxId: '5' })).rejects.toMatchObject({ status: 400 });
    await expect(mail.move({ ids: [id], mailboxId: 'nope' })).rejects.toMatchObject({ status: 404 });
    // A folder made since the last look is found.
    const fresh = fake.addFolder('Fresh');
    expect(await mail.move({ ids: [id], mailboxId: fresh })).toEqual({ ids: [id] });
  });

  test('mail.trash: to Trash, and from Trash deleted outright', async () => {
    const id = await fake.deliver({ subject: 'Trash me' });
    await mail.trash({ ids: [id] });
    expect(fake.message(id)!.LabelIDs).toContain('3');
    expect(fake.message(id)!.LabelIDs).not.toContain('0');
    await mail.trash({ ids: [id] });
    expect(fake.message(id)).toBeUndefined();
  });

  test('a message no key opens: unlock again once, then 422', async () => {
    const id = await fake.deliver({ subject: 'Undecryptable', text: 'x' });
    const before = unlocks;
    const saved = keys;
    keys = { ...keys, all: [] };
    // The first try fails with no keys, the second unlocks again and works.
    expect((await mail.get(id)).text).toBe('x');
    expect(unlocks).toBe(before + 1);
    keys = saved;
  });

  test('Proton’s errors: 5xx retried, not found 404, a human check 403, the reason logged', async () => {
    fake.failNext(503, 2, 'mail/v4/messages/count');
    expect((await mail.mailboxes()).mailboxes.length).toBeGreaterThan(5);
    fake.failNext(422, 1, 'mail/v4/messages/count', 9001);
    await expect(mail.mailboxes()).rejects.toMatchObject({ status: 403 });
    expect(logs.some((l) => l.includes('GET mail/v4/messages/count: 422 code 9001 (fake failure)'))).toBe(true);
    expect(template('mail/v4/messages/AbCdEf0123456789xyzAbCdEf0123456789==')).toBe('mail/v4/messages/:id');
    expect(template('core/v5/events/abc')).toBe('core/v5/events/abc');
  });

  test('threading and bulk headers: from ParsedHeaders on a whole message; Proton’s lists and events carry none', async () => {
    const refs = Array.from({ length: 25 }, (_, i) => `<w${i}@weekly.example>`);
    const id = await fake.deliver({
      subject: 'The weekly',
      text: 'this week',
      labelIds: ['6'],
      headers: { 'In-Reply-To': '<w24@weekly.example>', References: refs.join(' '), 'List-Id': ' "The Weekly"\r\n <weekly.list.example> ', 'List-Unsubscribe': ['<https://list.example/u/1>', '<mailto:leave@list.example>'], Precedence: 'bulk' },
    });
    const m = await mail.get(id);
    expect([m.inReplyTo, m.references]).toEqual(['<w24@weekly.example>', refs]);
    // The first List-Unsubscribe of two; folding and spaces made one space.
    expect(m.bulk).toEqual({ listId: '"The Weekly" <weekly.list.example>', unsubscribe: '<https://list.example/u/1>', precedence: 'bulk', autoSubmitted: null });
    const listed = (await mail.list({ mailboxId: '6', limit: 5 })).messages.find((x) => x.id === id)!;
    expect(listed).toMatchObject({ inReplyTo: null, references: [] });
    expect(listed.bulk).toBeUndefined();
    // A summary made from a whole message (as mail.changes makes one when an event does not say where it is): 20 kept.
    const whole = (await api.call<{ Message: any }>({ method: 'GET', path: `mail/v4/messages/${id}` })).Message;
    expect(mail.summary(whole)).toMatchObject({ inReplyTo: '<w24@weekly.example>', references: [refs[0], ...refs.slice(6)], bulk: { precedence: 'bulk' } });
    const plain = await mail.get(await fake.deliver({ subject: 'No headers', text: 'x', labelIds: ['6'] }));
    expect([plain.inReplyTo, plain.references, plain.bulk]).toEqual([null, [], undefined]);
  });

  test('nothing secret or from a message in what it logged', () => {
    const said = logs.join('\n');
    for (const s of [fake.secrets.keyPassword, fake.secrets.clientKey, fake.secrets.UID, fake.secrets.access, fake.secrets.token, 'pelican', 'Hello', 'Plain from MIME', '0123456789', 'weekly.example', 'list.example']) expect(said).not.toContain(s);
  });
});

test('fold: events in order, labels gained and lost, created then deleted', () => {
  const seen = new Map<string, Seen>();
  fold(seen, { EventID: 'e1', Messages: [{ ID: 'm', Action: 1, Message: { ID: 'm', LabelIDs: ['0', '5'], Subject: 's', Time: 1 } }] });
  fold(seen, { EventID: 'e2', Messages: [{ ID: 'm', Action: 3, Message: { ID: 'm', LabelIDsAdded: ['6'], LabelIDsRemoved: ['0'] } }] });
  expect(seen.get('m')).toMatchObject({ created: true, deleted: false, msg: { LabelIDs: ['5', '6'], Subject: 's' } });
  expect([...seen.get('m')!.added]).toEqual(['6']);
  expect([...seen.get('m')!.removed]).toEqual(['0']);
  fold(seen, { EventID: 'e3', Messages: [{ ID: 'm', Action: 0 }] });
  expect(seen.get('m')!.deleted).toBe(true);
  expect(new StatusError('x', 1)).toBeInstanceOf(Error);
});

describe('the addresses it sends as', () => {
  let fake: FakeProton;
  beforeAll(async () => {
    fake = await startFakeProton({ moreAddresses: true });
  });
  afterAll(() => fake?.stop());

  test("enabled ones that may send, in Proton's order; `from` picks one by its address, any other is 422", async () => {
    const api = new ProtonApi(direct(fake), log);
    const { Addresses } = await api.call<{ Addresses: ProtonAddress[] }>({ method: 'GET', path: 'core/v4/addresses', query: { Page: 0, PageSize: 50 } });
    expect(Addresses.length).toBe(5);
    const list = sendingAddresses(Addresses);
    // Not the disabled one, not the one that only receives.
    expect(list.map(({ email, name }) => ({ email, name }))).toEqual([
      { email: fake.email, name: 'Pat Proton' },
      { email: fake.alias, name: null },
      { email: 'pat.work@proton.test', name: 'Pat at Work' },
    ]);
    expect(list.map((a) => a.id)).toEqual([fake.email, fake.alias, 'pat.work@proton.test'].map((e) => fake.addresses.find((a) => a.Email === e)!.ID));
    expect(pickFrom(' PAT.Work@proton.test ', list).id).toBe(list[2].id);
    for (const other of ['pat.old@proton.test', 'pat.inbound@proton.test', 'someone@example.org']) {
      let status = 0;
      try {
        pickFrom(other, list);
      } catch (e) {
        status = (e as StatusError).status;
        expect((e as StatusError).callCode).toBe('from');
        expect((e as Error).message).not.toContain(other);
      }
      expect(status).toBe(422);
    }
  });
});

describe('mail.send: what is checked here, and what the page answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dacc-proton-send-'));
  const outside = mkdtempSync(join(tmpdir(), 'dacc-proton-file-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const ok = { to: [{ name: 'A', email: 'a@example.org' }], subject: 's', text: 't' };

  test('addresses, body, files: malformed is 400, too big 413, the account’s own files 403', () => {
    expect(checkOutgoing(ok as any, dir)).toEqual({ to: [{ name: 'A', email: 'a@example.org' }], cc: [], bcc: [], subject: 's', text: 't', files: [] });
    const bad = (m: unknown) => {
      try {
        checkOutgoing(m as any, dir);
      } catch (e) {
        return (e as StatusError).status;
      }
      return 0;
    };
    expect(bad({ ...ok, to: [] })).toBe(400);
    expect(bad({ ...ok, to: [{ name: null, email: 'not an address' }] })).toBe(400);
    expect(bad({ ...ok, text: undefined })).toBe(400);
    expect(bad({ ...ok, subject: 3 })).toBe(400);
    expect(bad({ ...ok, replyTo: '../x' })).toBe(404);
    expect(bad({ ...ok, from: 7 })).toBe(400);
    expect(checkOutgoing({ ...ok, from: ' me@proton.test ' } as any, dir).from).toBe('me@proton.test');
    expect(bad({ ...ok, to: Array.from({ length: 101 }, (_, i) => ({ name: null, email: `p${i}@example.org` })) })).toBe(400);
    expect(bad({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', path: 'relative' }] })).toBe(400);
    expect(bad({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', path: join(outside, 'missing') }] })).toBe(404);
    writeFileSync(join(dir, 'events.json'), '{}');
    expect(bad({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', path: join(dir, 'events.json') }] })).toBe(403);
    expect(bad({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', base64: 'eA==', path: join(outside, 'x') }] })).toBe(400);
    expect(bad({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', base64: Buffer.alloc(SEND_CAP + 1).toString('base64') }] })).toBe(413);
    const half = Buffer.alloc(SEND_CAP / 2 + 1).toString('base64');
    expect(bad({ ...ok, attachments: [{ filename: 'a', mime: 'text/plain', base64: half }, { filename: 'b', mime: 'text/plain', base64: half }] })).toBe(413);
    writeFileSync(join(outside, 'f.txt'), 'file words');
    const m = checkOutgoing({ ...ok, html: '<p>h</p>', attachments: [{ filename: ' f.txt ', mime: 'Text/Plain', path: join(outside, 'f.txt') }] } as any, dir);
    expect(m.files).toEqual([{ filename: 'f.txt', mime: 'text/plain', base64: Buffer.from('file words').toString('base64'), size: 10 }]);
  });

  test('the page’s answer: refused with its status (and with 422, its reason: from, recipients, settings), or sent; anything else is 502', () => {
    expect(checkPageSend({ refused: { status: 422, message: 'no' } })).toEqual({ refused: { status: 422, message: 'no' } });
    for (const code of ['from', 'recipients'] as const) expect(checkPageSend({ refused: { status: 422, message: 'no', code } })).toEqual({ refused: { status: 422, message: 'no', code } });
    // The page never words 'settings' (it must not name the app); the sentence is put on here.
    expect(checkPageSend({ refused: { status: 422, message: 'no', code: 'settings' } })).toEqual({ refused: { status: 422, message: SETTINGS_REFUSAL, code: 'settings' } });
    // Only those words, only with 422.
    expect(checkPageSend({ refused: { status: 422, message: 'no', code: 'denied' } })).toEqual({ refused: { status: 422, message: 'no' } });
    expect(checkPageSend({ refused: { status: 501, message: 'no', code: 'settings' } })).toEqual({ refused: { status: 501, message: 'no' } });
    expect(checkPageSend({ refused: { status: 'x' } })).toEqual({ refused: { status: 502, message: 'the page refused to send it' } });
    expect(checkPageSend({ sent: { id: 'abc', externalId: 'x@y', recipients: 2, encrypted: 1 } })).toEqual({ sent: { id: 'abc', externalId: 'x@y', recipients: 2, encrypted: 1 } });
    for (const r of [null, {}, { sent: { id: '../x' } }, { sent: 'x' }]) expect(() => checkPageSend(r)).toThrow(StatusError);
  });

  test('send: a reply from the original’s address, the Message-ID Proton gave, refusals and timeouts as statuses', async () => {
    const asked: any[] = [];
    const answers: Record<string, any> = { 'mail/v4/messages/orig': { Message: { ID: 'orig', AddressID: 'addr2' } }, 'mail/v4/messages/s1': { Message: { ExternalID: 'later@proton.test' } } };
    const api = { call: async (req: any) => (asked.push(req.path), answers[req.path] ?? {}) } as unknown as ProtonApi;
    const said: string[] = [];
    let page: (c: any) => Promise<unknown> = async () => ({ sent: { id: 's1', externalId: 'mid@proton.test', recipients: 1, encrypted: 1 } });
    const sentCmds: any[] = [];
    const deps = { api, page: (c: any) => (sentCmds.push(c), page(c)), log: (_l: string, msg: string, data?: unknown) => void said.push(msg + JSON.stringify(data ?? '')) };
    const m = checkOutgoing({ ...ok, replyTo: 'orig', attachments: [{ filename: 'a.txt', mime: 'text/plain', base64: 'eA==' }] } as any, dir);
    expect(await send(m, deps)).toEqual({ messageId: '<mid@proton.test>', sentId: 's1' });
    expect(sentCmds[0]).toMatchObject({ kind: 'send', parentID: 'orig', addressID: 'addr2', text: 't', attachments: [{ filename: 'a.txt', mime: 'text/plain', base64: 'eA==' }] });
    page = async () => ({ sent: { id: 's1', externalId: null, recipients: 1, encrypted: 0 } });
    expect(await send(checkOutgoing(ok as any, dir), deps)).toEqual({ messageId: '<later@proton.test>', sentId: 's1' });
    page = async () => ({ refused: { status: 501, message: "the Mail page's CryptoProxy was not found, so nothing was sent" } });
    await expect(send(checkOutgoing(ok as any, dir), deps)).rejects.toMatchObject({ status: 501, callCode: undefined });
    page = async () => ({ refused: { status: 422, message: 'Recipient 1 publishes an encryption key, so Proton would encrypt to it; send this one from Proton.', code: 'recipients' } });
    await expect(send(checkOutgoing(ok as any, dir), deps)).rejects.toMatchObject({ status: 422, callCode: 'recipients', message: 'Recipient 1 publishes an encryption key, so Proton would encrypt to it; send this one from Proton.' });
    page = async () => {
      throw new Error('hook timed out on send');
    };
    await expect(send(checkOutgoing(ok as any, dir), deps)).rejects.toMatchObject({ status: 504 });
    answers['mail/v4/messages/orig'] = {};
    await expect(send(checkOutgoing({ ...ok, replyTo: 'orig' } as any, dir), deps)).rejects.toMatchObject({ status: 404 });
    expect(said.join('\n')).not.toContain('a@example.org');
  });

  test('send: `from` is held to one of the account’s addresses and goes to the page as its id, over a reply’s', async () => {
    const answers: Record<string, any> = { 'mail/v4/messages/orig': { Message: { ID: 'orig', AddressID: 'addr1' } } };
    const api = { call: async (req: any) => answers[req.path] ?? {} } as unknown as ProtonApi;
    const cmds: any[] = [];
    const said: string[] = [];
    const addresses = async () => [
      { id: 'addr1', email: 'pat@proton.test', name: 'Pat' },
      { id: 'addr2', email: 'pat.alias@proton.test', name: null },
    ];
    const deps = { api, addresses, page: async (c: any) => (cmds.push(c), { sent: { id: 's1', externalId: 'mid@proton.test', recipients: 1, encrypted: 1 } }), log: (_l: string, msg: string, data?: unknown) => void said.push(msg + JSON.stringify(data ?? '')) };
    await send(checkOutgoing({ ...ok, from: 'Pat.Alias@proton.test', replyTo: 'orig' } as any, dir), deps);
    expect(cmds.at(-1)).toMatchObject({ kind: 'send', fromAddressID: 'addr2', parentID: 'orig', addressID: 'addr1' });
    await send(checkOutgoing(ok as any, dir), deps);
    expect(cmds.at(-1).fromAddressID).toBeUndefined();
    const n = cmds.length;
    await expect(send(checkOutgoing({ ...ok, from: 'mallory@example.org' } as any, dir), deps)).rejects.toMatchObject({ status: 422, callCode: 'from' });
    await expect(send(checkOutgoing({ ...ok, from: 'pat@proton.test' } as any, dir), { ...deps, addresses: undefined })).rejects.toMatchObject({ status: 503 });
    expect(cmds.length).toBe(n);
    expect(said.join('\n')).not.toContain('alias');
  });
});
