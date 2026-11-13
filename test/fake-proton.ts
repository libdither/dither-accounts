/**
 * A fake of the parts of Proton Mail the proton extractor reaches (docs/proton.md): a stand-in Mail page and the API
 * subset, on 127.0.0.1, with real OpenPGP keys made at start.
 *
 * The page, at /u/<localID>/inbox, keeps what the real app keeps (localStorage `ps-<localID>`: UID, UserID, the key
 * password sealed with the session's ClientKey) and sets the session cookies (AUTH-<UID> on /api, REFRESH-<UID> on
 * /api/auth/refresh). Then it behaves as the app: it calls the API itself with the app's headers (accept,
 * x-pm-appversion, x-pm-uid, x-pm-locale, and a marker `x-fake-caller: page` so the fake can tell its calls from the
 * hook's), polls the event loop, and on a 401 refreshes the session itself. Signed out (`signedIn: false`), `/` sends
 * the browser to a stand-in sign-in page with no session.
 *
 * The API checks what Proton would: the AUTH cookie for the x-pm-uid, the app version, the accept header. Its data is
 * a mailbox: messages with bodies encrypted to the address key (HTML, plain text, or PGP/MIME), attachments split into
 * key packets and a data packet, labels and folders, counts, and an event loop (core/v4/events/latest,
 * core/v5/events/<id>) with More, Refresh and forgotten ids. Helpers stand in for someone using Proton's own app.
 * As Proton's, only a whole message (GET mail/v4/messages/<id>) carries `ParsedHeaders` (Message-Id and whatever
 * `deliver` was given: In-Reply-To, References, List-Id, …); lists and events carry the metadata alone.
 *
 * The page runs a stand-in of the web app's code (fake-proton-app.js, fake-proton-main.js): a webpack runtime and chunks
 * shaped like the live bundle's, with the CryptoProxy, the thunk argument holding the app's API caller, a store on a
 * React-shaped root, and the address keys by usage (`withhold` hides one of them, as a build that moved it would), and
 * a main chunk that exports only its component, as live. Sending goes through the API as Proton's does: a draft (POST
 * mail/v4/messages), its attachments (POST mail/v4/attachments, a form), and the send (POST mail/v4/messages/<id>, a
 * form of packages). The send is **checked as a server that holds every recipient's key would**: each Proton
 * recipient's body key packet opens with their key and the body it opens is the draft's text, signed by the sender's
 * address key; the clear body key opens the same; each attachment's key packets and clear keys open the file that was
 * uploaded; each address's Type and Signature flag, the package's Type and Flags. A send that fails a check is refused
 * (422) and the reason kept in `rejected`; one that passes is kept in `sent` (with its packages, for tests to open).
 * Recipients come from a table (`recipient()`): how GET core/v4/keys/all answers for them. Contacts (`contact()`) are
 * answered at contacts/v4/contacts/emails and contacts/v4/contacts/<id>, mail settings at mail/v4/settings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openpgp } from '../extractors/proton/src/pgp.ts';
import { sealSessionBlob } from '../extractors/proton/src/session.ts';

export const APP_VERSION = 'web-mail@5.0.140.12';
export const ACCEPT = 'application/vnd.protonmail.v1+json';

type Recipient = { Name: string; Address: string };
export interface FakeAttachment {
  name: string;
  mime: string;
  data: Uint8Array;
  inline?: boolean;
  contentId?: string;
}
export interface Deliver {
  subject: string;
  from?: Recipient;
  to?: Recipient[];
  cc?: Recipient[];
  html?: string;
  text?: string;
  /** A whole MIME message as the body (PGP/MIME): MIMEType multipart/mixed. */
  mime?: string;
  attachments?: FakeAttachment[];
  labelIds?: string[];
  /** Proton's category (CategoryID), and a newsletter subscription (NewsletterSubscriptionID). */
  categoryId?: string;
  newsletterId?: string;
  time?: number;
  unread?: boolean;
  externalId?: string;
  /** More of ParsedHeaders: a list where a header is there more than once, as Proton gives it. */
  headers?: Record<string, string | string[]>;
  /** Encrypt to the second address instead of the primary one. */
  toAlias?: boolean;
  flags?: number;
}
interface Msg {
  meta: Record<string, any>;
  body: string;
  mime: string;
  parsed: Record<string, string | string[]>;
  atts: { meta: Record<string, any>; data: Uint8Array }[];
  order: number;
}
interface Ev {
  id: string;
  Messages: { ID: string; Action: number; Message?: any }[];
  labels?: boolean;
  addresses?: boolean;
  refresh?: number;
}

const rid = (n = 64) => `${Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url')}==`;
const FOLDERS = new Set(['0', '3', '4', '6', '7', '8', '12']);

export interface FakeProtonOpts {
  signedIn?: boolean;
  payloadVersion?: 1 | 2 | 3;
  /** How often the page polls events itself, ms. */
  pagePollMs?: number;
  /** Events per page of core/v5/events. */
  eventsPerPage?: number;
  /** An address key with no token (a legacy account's): opened with the key password itself. */
  legacyAlias?: boolean;
  persistent?: boolean;
  /** Modules the page hides from the hook's finders (one level down), as a build that moved them would. */
  withhold?: ('CryptoProxy' | 'AddressKeysByUsage')[];
  /** The saved-session way in is closed: the ClientKey call is refused, or the blob is not what it was. */
  brokenSession?: 'clientKey' | 'blob';
  /** Three more addresses (no keys): one disabled, one that only receives, one more to send from. */
  moreAddresses?: boolean;
}

/**
 * How GET core/v4/keys/all answers for a recipient:
 *   internal            a Proton address: its key in Address.Keys (RecipientType 1)
 *   internal-two        the same with a second, non-primary key listed first (the primary is the one to encrypt to)
 *   internal-noencrypt  a Proton address whose only key says EMAIL_NO_ENCRYPT (flag 4)
 *   internal-obsolete   a Proton address whose only key is obsolete (no NOT_OBSOLETE flag)
 *   internal-nokeys     RecipientType 1 with no key at all
 *   clear               an outside address with no key anywhere (RecipientType 2): the default
 *   wkd                 an outside address with a published (WKD) key, in Unverified (Source 1)
 *   external-keys       an outside address (RecipientType 2) with a key in Address.Keys
 *   unverified          a Proton-sourced key in Unverified only
 *   internal-unverified a Proton address with its key in Address.Keys and another in Unverified (Address.Keys decide)
 *   catchall            a catch-all key (CatchAll.Keys)
 *   warn                Proton's Warnings about the address
 *   error               the lookup refused (422, Proton's code 33102)
 */
export type RecipientKind = 'internal' | 'internal-two' | 'internal-noencrypt' | 'internal-obsolete' | 'internal-nokeys' | 'clear' | 'wkd' | 'external-keys' | 'unverified' | 'internal-unverified' | 'catchall' | 'warn' | 'error';
/** A contact in the owner's Proton contacts: its cards (a signed one, and an encrypted one this never reads). */
export interface FakeContact {
  /** Encryption properties to put in its card: KEY, X-PM-ENCRYPT, X-PM-SIGN, X-PM-SCHEME, X-PM-MIMETYPE. */
  props?: string[];
  /** ContactEmail.Defaults (1: no settings of its own, the default). */
  defaults?: number;
  /** The card holding the properties: signed (2, the default) or clear (0). */
  cardType?: 0 | 2;
  /** contacts/v4/contacts/<id> fails. */
  unreadable?: boolean;
}
/** One package as it was sent: its body (encrypted), its clear keys, each recipient's entry. */
export interface SentPackage {
  MIMEType?: string;
  Type: number;
  Body: Uint8Array;
  BodyKey?: { Key: string; Algorithm: string };
  AttachmentKeys?: Record<string, { Key: string; Algorithm: string }>;
  Addresses: Record<string, { Type: number; BodyKeyPacket?: string; AttachmentKeyPackets?: Record<string, string>; Signature?: number }>;
}
export interface Sent {
  id: string;
  packages: Record<string, SentPackage>;
  /** What the fake checked and found right: recipients whose body (and files) opened with their key or the clear key. */
  verified: { encrypted: number; clear: number; attachments: number };
  autoSaveContacts: number | null;
  delaySeconds: number | null;
  parentId: string | null;
  action: number | null;
}

const APP_JS = readFileSync(join(import.meta.dir, 'fake-proton-app.js'), 'utf8');
const MAIN_JS = readFileSync(join(import.meta.dir, 'fake-proton-main.js'), 'utf8');
const OPENPGP_JS = readFileSync(join(import.meta.dir, '../extractors/proton/node_modules/openpgp/dist/openpgp.min.js'), 'utf8');

export async function startFakeProton(opts: FakeProtonOpts = {}) {
  const signedIn = opts.signedIn ?? true;
  const pagePollMs = opts.pagePollMs ?? 1000;
  const perPage = opts.eventsPerPage ?? 50;
  const email = 'pat@proton.test';
  const alias = 'pat.alias@proton.test';
  const keyPassword = `kp-${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url')}`;
  const clientKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const UID = `uid${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}`;
  const UserID = rid();
  let access = `at-${rid(24)}`;
  let refresh = `rt-${rid(24)}`;
  let sessionValid = true;

  // ---- keys: a user key locked with the key password; address keys locked with tokens encrypted to it and signed
  const user = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: 'not_for_email_use@domain.tld' }], passphrase: keyPassword, format: 'object' });
  const userPriv = await openpgp.decryptKey({ privateKey: user.privateKey, passphrase: keyPassword });
  async function addressKey(addrEmail: string, legacy: boolean) {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const pass = legacy ? keyPassword : token;
    const k = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: addrEmail }], passphrase: pass, format: 'object' });
    const tokenMessage = legacy ? null : await openpgp.encrypt({ message: await openpgp.createMessage({ text: token }), encryptionKeys: userPriv.toPublic() });
    const signature = legacy ? null : await openpgp.sign({ message: await openpgp.createMessage({ text: token }), signingKeys: userPriv, detached: true });
    return { armored: k.privateKey.armor(), pub: k.publicKey, priv: await openpgp.decryptKey({ privateKey: k.privateKey, passphrase: pass }), token: tokenMessage as string | null, signature: signature as string | null, token_plain: token };
  }
  const primary = await addressKey(email, false);
  const second = await addressKey(alias, !!opts.legacyAlias);
  const addresses = [
    { ID: rid(), Email: email, DisplayName: 'Pat Proton', Status: 1, Receive: 1, Send: 1, Order: 1, Type: 1, Keys: [{ ID: rid(), Primary: 1, Active: 1, Flags: 3, Fingerprint: primary.pub.getFingerprint(), PrivateKey: primary.armored, Token: primary.token, Signature: primary.signature }] },
    { ID: rid(), Email: alias, DisplayName: '', Status: 1, Receive: 1, Send: 1, Order: 2, Type: 2, Keys: [{ ID: rid(), Primary: 1, Active: 1, Flags: 3, Fingerprint: second.pub.getFingerprint(), PrivateKey: second.armored, ...(opts.legacyAlias ? {} : { Token: second.token, Signature: second.signature }) }] },
  ] as { ID: string; Email: string; DisplayName: string; Status: number; Receive: number; Send: number; Order: number; Type: number; Keys: Record<string, unknown>[] }[];
  if (opts.moreAddresses)
    addresses.splice(
      1,
      0,
      // Out of Proton's order on purpose: Order says where each goes.
      { ID: rid(), Email: 'pat.work@proton.test', DisplayName: 'Pat at Work', Status: 1, Receive: 1, Send: 1, Order: 5, Type: 2, Keys: [] },
      { ID: rid(), Email: 'pat.old@proton.test', DisplayName: 'Old Pat', Status: 0, Receive: 0, Send: 1, Order: 3, Type: 2, Keys: [] },
      { ID: rid(), Email: 'pat.inbound@proton.test', DisplayName: '', Status: 1, Receive: 1, Send: 0, Order: 4, Type: 2, Keys: [] },
    );
  const blob = opts.brokenSession === 'blob' ? Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64') : await sealSessionBlob({ keyPassword }, clientKey, opts.payloadVersion ?? 3);
  const ps = { UserID, UID, blob, payloadVersion: opts.payloadVersion ?? 3, persistent: opts.persistent ?? true, trusted: false, accessTypeMask: 0, source: 0, persistedAt: Date.now() };

  // ---- the mailbox
  const folders = [
    { ID: rid(), Name: 'Work', Path: 'Work', Type: 3, Color: '#8080FF', Order: 1, Notify: 1, Expanded: 1 },
  ];
  folders.push({ ID: rid(), Name: 'Clients', Path: 'Work/Clients', Type: 3, Color: '#8080FF', Order: 2, Notify: 1, Expanded: 1, ParentID: folders[0].ID } as any);
  const labels = [{ ID: rid(), Name: 'Receipts', Path: 'Receipts', Type: 1, Color: '#FF8080', Order: 1 }];
  const messages = new Map<string, Msg>();
  let order = 0;
  const events: Ev[] = [{ id: rid(), Messages: [] }];
  /** Event ids before this index are forgotten (400, as an id the server no longer knows). */
  let forgottenBefore = 0;
  let refreshNext = 0;
  const calls: { by: 'page' | 'hook'; method: string; path: string; search: string; headers: Record<string, string> }[] = [];
  const recipients = new Map<string, { kind: RecipientKind; key?: openpgp.PrivateKey; extra?: openpgp.PrivateKey }>();
  const contacts = new Map<string, { ID: string; email: string; defaults: number; unreadable: boolean; cards: { Type: number; Data: string; Signature: string | null }[] }>();
  let mailSettings: Record<string, unknown> = { AutoSaveContacts: 1, DelaySendSeconds: 0, Sign: 0, PGPScheme: 16, DraftMIMEType: 'text/html', AttachPublicKey: 0 };
  const sent: Sent[] = [];
  /** Sends the fake refused because a package was wrong: why. */
  const rejected: string[] = [];
  let draftsMade = 0;
  const uploads: { id: string; draft: string; name: string; data: Uint8Array; keyPackets: string; signature: string | null }[] = [];
  const failures: { status: number; count: number; match?: string; code?: number }[] = [];

  const isFolder = (id: string) => FOLDERS.has(id) || folders.some((f) => f.ID === id);
  const isLabel = (id: string) => id === '10' || labels.some((l) => l.ID === id);
  const allLabels = (m: Msg) => m.meta.LabelIDs as string[];
  function withDerived(ids: string[]): string[] {
    const set = new Set(ids.filter((l) => l !== '5' && l !== '15'));
    set.add('5');
    if (!set.has('3') && !set.has('4')) set.add('15');
    return [...set];
  }
  function counts(ids?: Iterable<string>) {
    const want = ids ? new Set(ids) : null;
    const all = new Set<string>(['0', '3', '4', '5', '6', '7', '8', '10', '12', '15', ...folders.map((f) => f.ID), ...labels.map((l) => l.ID)]);
    return [...all]
      .filter((id) => !want || want.has(id))
      .map((LabelID) => {
        const ms = [...messages.values()].filter((m) => allLabels(m).includes(LabelID));
        return { LabelID, Total: ms.length, Unread: ms.filter((m) => m.meta.Unread).length };
      });
  }
  function emit(Messages: Ev['Messages'], extra: Partial<Ev> = {}) {
    events.push({ id: rid(), Messages, ...extra });
  }
  const metaOf = (m: Msg) => ({ ...m.meta });

  async function encryptBody(text: string, toAlias = false) {
    return (await openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys: (toAlias ? second : primary).pub })) as string;
  }
  async function encryptAttachment(data: Uint8Array) {
    const sk = await openpgp.generateSessionKey({ encryptionKeys: primary.pub });
    const keyPackets = await openpgp.encryptSessionKey({ ...sk, encryptionKeys: primary.pub, format: 'binary' });
    const dataPacket = await openpgp.encrypt({ message: await openpgp.createMessage({ binary: data }), sessionKey: sk, format: 'binary' });
    return { keyPackets: Buffer.from(keyPackets).toString('base64'), data: dataPacket as Uint8Array };
  }

  async function deliver(d: Deliver): Promise<string> {
    const ID = rid();
    const atts: Msg['atts'] = [];
    for (const a of d.attachments ?? []) {
      const e = await encryptAttachment(a.data);
      atts.push({
        meta: { ID: rid(), Name: a.name, Size: a.data.length, MIMEType: a.mime, Disposition: a.inline ? 'inline' : 'attachment', Headers: { 'content-disposition': a.inline ? 'inline' : 'attachment', ...(a.contentId ? { 'content-id': `<${a.contentId}>` } : {}) }, KeyPackets: e.keyPackets, Signature: null },
        data: e.data,
      });
    }
    const mime = d.mime ? 'multipart/mixed' : d.html !== undefined ? 'text/html' : 'text/plain';
    const body = await encryptBody(d.mime ?? d.html ?? d.text ?? '', d.toAlias);
    const time = d.time ?? Math.floor(Date.now() / 1000);
    const m: Msg = {
      meta: {
        ID,
        Order: ++order,
        ConversationID: rid(),
        AddressID: (d.toAlias ? addresses.find((a) => a.Email === alias)! : addresses[0]).ID,
        LabelIDs: withDerived(d.labelIds ?? ['0']),
        ExternalID: d.externalId ?? `${ID.slice(0, 12)}@mail.example`,
        Subject: d.subject,
        Sender: d.from ?? { Name: 'Sam Sender', Address: 'sam@example.org' },
        ToList: d.to ?? [{ Name: 'Pat Proton', Address: email }],
        CCList: d.cc ?? [],
        BCCList: [],
        ReplyTos: [d.from ?? { Name: 'Sam Sender', Address: 'sam@example.org' }],
        Time: time,
        Size: (d.html ?? d.text ?? d.mime ?? '').length + (d.attachments ?? []).reduce((n, a) => n + a.data.length, 0),
        Unread: d.unread === false ? 0 : 1,
        IsReplied: 0,
        IsRepliedAll: 0,
        IsForwarded: 0,
        Flags: d.flags ?? 1 | 8,
        NumAttachments: atts.length,
        ExpirationTime: 0,
        CategoryID: d.categoryId ?? null,
        NewsletterSubscriptionID: d.newsletterId ?? null,
      },
      body,
      mime,
      parsed: { 'Message-Id': `<${d.externalId ?? `${ID.slice(0, 12)}@mail.example`}>`, ...d.headers },
      atts,
      order,
    };
    messages.set(ID, m);
    emit([{ ID, Action: 1, Message: metaOf(m) }]);
    return ID;
  }

  /** Change labels as Proton does: a folder replaces the message's folder; anything else is added or taken away. */
  function relabel(m: Msg, add: string[], remove: string[]) {
    const before = new Set(allLabels(m));
    let next = [...before];
    for (const l of add) {
      if (isFolder(l)) next = next.filter((x) => !isFolder(x));
      next.push(l);
    }
    next = next.filter((x) => !remove.includes(x));
    const after = withDerived([...new Set(next)]);
    m.meta.LabelIDs = after;
    const LabelIDsAdded = after.filter((x) => !before.has(x));
    const LabelIDsRemoved = [...before].filter((x) => !after.includes(x));
    emit([{ ID: m.meta.ID, Action: 3, Message: { ...metaOf(m), LabelIDsAdded, LabelIDsRemoved } }]);
  }

  // ---- responses
  const err = (status: number, Code: number, Error: string) => Response.json({ Code, Error }, { status });
  const ok = (body: Record<string, unknown>) => Response.json({ Code: 1000, ...body });
  const cookie = (req: Request, name: string) => (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] ?? null;

  /** core/v4/keys/all for an address, as the recipient table says (RecipientKind). */
  function keysAll(address: string): Response {
    const r = recipients.get(address.toLowerCase()) ?? { kind: 'clear' as RecipientKind };
    const apiKey = (k: openpgp.PrivateKey, Flags = 3, Source = 0, Primary = 1) => ({ PublicKey: k.toPublic().armor(), Flags, Source, Primary });
    const answer = (o: { address?: unknown[]; unverified?: unknown[] | null; catchAll?: unknown[]; type: number; warnings?: string[] }) =>
      ok({ Address: { Keys: o.address ?? [], SignedKeyList: null }, ...(o.catchAll ? { CatchAll: { Keys: o.catchAll, SignedKeyList: null } } : {}), Unverified: o.unverified === null ? null : { Keys: o.unverified ?? [] }, ProtonMX: o.type === 1, Warnings: o.warnings ?? [], RecipientType: o.type });
    switch (r.kind) {
      case 'internal':
        return answer({ address: [apiKey(r.key!)], unverified: null, type: 1 });
      case 'internal-two':
        return answer({ address: [apiKey(r.extra!, 3, 0, 0), apiKey(r.key!)], unverified: null, type: 1 });
      case 'internal-noencrypt':
        return answer({ address: [apiKey(r.key!, 3 | 4)], unverified: null, type: 1 });
      case 'internal-obsolete':
        return answer({ address: [apiKey(r.key!, 1)], unverified: null, type: 1 });
      case 'internal-nokeys':
        return answer({ type: 1 });
      case 'wkd':
        return answer({ unverified: [apiKey(r.key!, 3, 1)], type: 2 });
      case 'external-keys':
        return answer({ address: [apiKey(r.key!)], type: 2 });
      case 'unverified':
        return answer({ unverified: [apiKey(r.key!)], type: 1 });
      case 'internal-unverified':
        return answer({ address: [apiKey(r.key!)], unverified: [apiKey(r.extra!)], type: 1 });
      case 'catchall':
        return answer({ catchAll: [apiKey(r.key!)], type: 1 });
      case 'warn':
        return answer({ type: 2, warnings: ['The domain has no MX record'] });
      case 'error':
        return err(422, 33102, 'The address does not exist');
      default:
        return answer({ type: 2 });
    }
  }

  /** The address keys of one of the account's own addresses (primary or alias), or null. */
  const ownKeys = (address: string) => (address.toLowerCase() === email ? primary : address.toLowerCase() === alias ? second : null);

  /**
   * The send checked as a server that held every recipient's key would: see the header. Throws why it is wrong.
   */
  async function verifySend(draft: Msg, packages: Record<string, any>): Promise<Sent['verified']> {
    const sender = addresses.find((a) => a.ID === draft.meta.AddressID);
    const senderKeys = sender ? ownKeys(sender.Email) : null;
    if (!senderKeys) throw new Error('the draft has no sender this fake holds keys for');
    const text = (await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: draft.body }), decryptionKeys: senderKeys.priv, verificationKeys: senderKeys.pub, expectSigned: true })).data as string;
    // Each file as uploaded: its bytes (opened with your key) and its detached signature (your address key's).
    const files: { id: string; data: Uint8Array; signed: boolean }[] = [];
    for (const a of draft.atts) {
      const [sk] = await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(a.meta.KeyPackets, 'base64') }), decryptionKeys: senderKeys.priv });
      const data = (await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: a.data }), sessionKeys: sk as any, format: 'binary' })).data as Uint8Array;
      if (a.meta.Signature) await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature: await openpgp.readSignature({ binarySignature: Buffer.from(a.meta.Signature, 'base64') }), verificationKeys: senderKeys.pub, expectSigned: true });
      files.push({ id: a.meta.ID, data, signed: !!a.meta.Signature });
    }
    const allSigned = files.every((f) => f.signed);
    const wanted = [...new Set([...draft.meta.ToList, ...draft.meta.CCList, ...draft.meta.BCCList].map((r: Recipient) => r.Address))];
    const seen = new Set<string>();
    const out = { encrypted: 0, clear: 0, attachments: 0 };
    const sk = (o: { Key: string; Algorithm: string }) => ({ data: Uint8Array.from(Buffer.from(o.Key, 'base64')), algorithm: o.Algorithm });
    const openBody = async (body: Uint8Array, sessionKey: unknown) => (await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: body }), sessionKeys: sessionKey as any, verificationKeys: senderKeys.pub, expectSigned: true })).data as string;
    const openFile = async (id: string, sessionKey: unknown) => {
      const f = files.find((x) => x.id === id);
      if (!f) throw new Error('a key for an attachment the draft does not have');
      const got = (await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: draft.atts.find((a) => a.meta.ID === id)!.data }), sessionKeys: sessionKey as any, format: 'binary' })).data as Uint8Array;
      if (Buffer.compare(Buffer.from(got), Buffer.from(f.data)) !== 0) throw new Error('an attachment key opens other bytes');
      out.attachments++;
    };
    for (const [mime, pkg] of Object.entries(packages)) {
      if (mime !== draft.mime || pkg.MIMEType !== mime) throw new Error(`a ${mime} package for a ${draft.mime} draft`);
      if (!(pkg.Body instanceof Uint8Array) || typeof pkg.Type !== 'number' || !(Number(pkg.Flags) & 1)) throw new Error('the package is not as expected');
      let type = 0;
      for (const [address, entry] of Object.entries(pkg.Addresses ?? {}) as [string, any][]) {
        if (!wanted.includes(address) || seen.has(address)) throw new Error('a package names someone the draft does not, or twice');
        seen.add(address);
        type |= entry.Type;
        const own = ownKeys(address);
        const r = recipients.get(address.toLowerCase()) ?? { kind: 'clear' as RecipientKind };
        const key = own ? own.priv : r.kind === 'internal' || r.kind === 'internal-two' || r.kind === 'internal-unverified' ? r.key! : null;
        if (key) {
          if (entry.Type !== 1 || entry.Signature !== (allSigned ? 1 : 0)) throw new Error(`a Proton recipient has Type ${entry.Type}, Signature ${entry.Signature}`);
          const [s] = await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(String(entry.BodyKeyPacket ?? ''), 'base64') }), decryptionKeys: key });
          if ((await openBody(pkg.Body, s)) !== text) throw new Error("a Proton recipient's body is not the draft's");
          const akp = entry.AttachmentKeyPackets ?? {};
          if (Object.keys(akp).length !== files.length) throw new Error('a Proton recipient lacks attachment key packets');
          for (const [id, packet] of Object.entries(akp)) {
            const [a] = await openpgp.decryptSessionKeys({ message: await openpgp.readMessage({ binaryMessage: Buffer.from(String(packet), 'base64') }), decryptionKeys: key });
            await openFile(id, a);
          }
          out.encrypted++;
        } else if (r.kind === 'clear') {
          if (entry.Type !== 4 || entry.Signature !== 0 || entry.BodyKeyPacket !== undefined || entry.AttachmentKeyPackets !== undefined) throw new Error(`a clear recipient has Type ${entry.Type}, Signature ${entry.Signature}, or a key packet`);
          out.clear++;
        } else throw new Error(`a recipient of kind ${r.kind} was sent to`);
      }
      if (type !== pkg.Type) throw new Error("the package's Type is not its recipients'");
      if (pkg.Type & 4) {
        if (!pkg.BodyKey || (await openBody(pkg.Body, sk(pkg.BodyKey))) !== text) throw new Error('the clear body key does not open the body');
        const ak = pkg.AttachmentKeys ?? {};
        if (Object.keys(ak).length !== files.length) throw new Error('the clear attachment keys are missing');
        for (const [id, k] of Object.entries(ak)) await openFile(id, sk(k as any));
      } else if (pkg.BodyKey || pkg.AttachmentKeys) throw new Error('a package with nobody in the clear carries clear keys');
    }
    if (wanted.some((w) => !seen.has(w))) throw new Error('a recipient is in no package');
    return out;
  }

  function listMessages(url: URL) {
    const p = url.searchParams;
    const labelIds = [...p.getAll('LabelID'), ...p.getAll('LabelID[]')];
    const keyword = (p.get('Keyword') ?? '').toLowerCase();
    const begin = p.get('Begin') ? Number(p.get('Begin')) : null;
    const end = p.get('End') ? Number(p.get('End')) : null;
    let all = [...messages.values()].filter((m) => (!labelIds.length || labelIds.every((l) => allLabels(m).includes(l))) && (begin === null || m.meta.Time >= begin) && (end === null || m.meta.Time <= end));
    if (keyword) {
      const hay = (m: Msg) => [m.meta.Subject, m.meta.Sender?.Name, m.meta.Sender?.Address, ...m.meta.ToList.flatMap((r: Recipient) => [r.Name, r.Address]), ...m.meta.CCList.flatMap((r: Recipient) => [r.Name, r.Address])].join(' ').toLowerCase();
      all = all.filter((m) => keyword.split(/\s+/).every((w) => hay(m).includes(w)));
    }
    const desc = p.get('Desc') !== '0';
    all.sort((a, b) => (desc ? b.meta.Time - a.meta.Time || b.order - a.order : a.meta.Time - b.meta.Time || a.order - b.order));
    const total = all.length;
    let start = 0;
    const anchorId = p.get('AnchorID');
    if (anchorId) {
      const i = all.findIndex((m) => m.meta.ID === anchorId);
      start = i >= 0 ? i + 1 : all.findIndex((m) => m.meta.Time < Number(p.get('Anchor')));
      if (start < 0) start = all.length;
    } else start = Number(p.get('Page') ?? 0) * Number(p.get('PageSize') ?? 50);
    const size = Number(p.get('Limit') ?? p.get('PageSize') ?? 50);
    return ok({ Total: total, Limit: size, Messages: all.slice(start, start + size).map(metaOf), Stale: 0 });
  }

  function eventsFrom(id: string) {
    const i = events.findIndex((e) => e.id === id);
    if (i < 0 || i < forgottenBefore) return err(400, 2061, 'Invalid event ID');
    if (refreshNext) {
      const flag = refreshNext;
      refreshNext = 0;
      return ok({ EventID: events.at(-1)!.id, More: 0, Refresh: flag, Messages: [] });
    }
    const page = events.slice(i + 1, i + 1 + perPage);
    if (!page.length) return ok({ EventID: id, More: 0, Refresh: 0 });
    const msgs = page.flatMap((e) => e.Messages);
    const touched = new Set<string>();
    for (const e of msgs) for (const l of [...(e.Message?.LabelIDs ?? []), ...(e.Message?.LabelIDsRemoved ?? [])]) touched.add(l);
    return ok({
      EventID: page.at(-1)!.id,
      More: i + 1 + perPage < events.length ? 1 : 0,
      Refresh: 0,
      ...(msgs.length ? { Messages: msgs, MessageCounts: counts(touched) } : {}),
      ...(page.some((e) => e.labels) ? { Labels: [{ ID: 'x', Action: 2 }] } : {}),
      ...(page.some((e) => e.addresses) ? { Addresses: [{ ID: addresses[0].ID, Action: 2 }] } : {}),
    });
  }

  function batch(ids: string[], f: (m: Msg) => number) {
    return Response.json({ Code: 1001, Responses: ids.map((ID) => ({ ID, Response: { Code: messages.has(ID) ? f(messages.get(ID)!) : 2501 } })), UndoToken: { Token: 'undo', ValidUntil: 0 } });
  }

  async function apiCall(req: Request, url: URL, path: string): Promise<Response> {
    const by = req.headers.get('x-fake-caller') === 'page' ? 'page' : 'hook';
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    calls.push({ by, method: req.method, path, search: url.search, headers });
    if (req.headers.get('accept') !== ACCEPT) return err(400, 2001, 'fake proton: expected the app accept header');
    if (req.headers.get('x-pm-appversion') !== APP_VERSION) return err(400, 5003, 'This version of the app is no longer supported');
    if (path === 'auth/refresh' && req.method === 'POST') {
      if (!sessionValid || req.headers.get('x-pm-uid') !== UID || cookie(req, `REFRESH-${UID}`) !== refresh) return err(422, 10013, 'Invalid refresh token');
      access = `at-${rid(24)}`;
      refresh = `rt-${rid(24)}`;
      const h = new Headers({ 'content-type': 'application/json' });
      h.append('set-cookie', `AUTH-${UID}=${access}; Path=/api; HttpOnly; SameSite=Lax`);
      h.append('set-cookie', `REFRESH-${UID}=${refresh}; Path=/api/auth/refresh; HttpOnly; SameSite=Lax`);
      return new Response(JSON.stringify({ Code: 1000, UID, ExpiresIn: 86400 }), { headers: h });
    }
    if (!sessionValid || req.headers.get('x-pm-uid') !== UID || cookie(req, `AUTH-${UID}`) !== access) return err(401, 401, 'Invalid access token');
    const fail = failures.find((f) => !f.match || `${req.method} ${path}`.includes(f.match));
    if (fail && by === 'hook') {
      if (--fail.count <= 0) failures.splice(failures.indexOf(fail), 1);
      return err(fail.status, fail.code ?? fail.status, 'fake failure');
    }
    let m: RegExpMatchArray | null;
    const isForm = (req.headers.get('content-type') ?? '').startsWith('multipart/form-data');
    const form = isForm ? await req.formData() : null;
    const body = !isForm && (req.method === 'PUT' || req.method === 'POST') ? ((await req.json().catch(() => ({}))) as any) : null;
    if (path === 'auth/v4/sessions/local/key' && req.method === 'GET') return opts.brokenSession === 'clientKey' ? err(404, 404, 'Not found') : ok({ ClientKey: clientKey });
    if (path === 'core/v4/keys/all' && req.method === 'GET') return keysAll(url.searchParams.get('Email') ?? '');
    if (path === 'mail/v4/settings' && req.method === 'GET') return ok({ MailSettings: mailSettings });
    if (path === 'contacts/v4/contacts/emails' && req.method === 'GET') {
      const want = (url.searchParams.get('Email') ?? '').toLowerCase();
      const ContactEmails = [...contacts.values()].filter((c) => c.email.toLowerCase() === want).map((c) => ({ ID: rid(), Email: c.email, Name: c.email.split('@')[0], Type: [], Defaults: c.defaults, Order: 1, ContactID: c.ID, LabelIDs: [], LastUsedTime: 0 }));
      return ok({ ContactEmails, Total: ContactEmails.length });
    }
    if ((m = path.match(/^contacts\/v4\/contacts\/([A-Za-z0-9_=-]+)$/)) && req.method === 'GET') {
      const c = [...contacts.values()].find((x) => x.ID === m![1]);
      if (!c) return err(422, 2501, 'Contact does not exist');
      if (c.unreadable) return err(500, 500, 'fake failure reading the contact');
      return ok({ Contact: { ID: c.ID, Name: c.email.split('@')[0], Cards: c.cards } });
    }
    if (path === 'mail/v4/messages' && req.method === 'POST') {
      const M = body?.Message ?? {};
      const ID = rid();
      const addr = addresses.find((a) => a.ID === M.AddressID);
      if (!addr || typeof M.Body !== 'string' || !M.Body.includes('BEGIN PGP MESSAGE')) return err(422, 2001, 'Invalid draft');
      draftsMade++;
      const m: Msg = {
        meta: { ID, Order: ++order, ConversationID: rid(), AddressID: M.AddressID, LabelIDs: withDerived(['1', '8']), ExternalID: null, Subject: String(M.Subject ?? ''), Sender: M.Sender, ToList: M.ToList ?? [], CCList: M.CCList ?? [], BCCList: M.BCCList ?? [], ReplyTos: [], Time: Math.floor(Date.now() / 1000), Size: M.Body.length, Unread: 0, IsReplied: 0, IsRepliedAll: 0, IsForwarded: 0, Flags: 0, NumAttachments: 0, ExpirationTime: 0, ParentID: body.ParentID ?? null, Action: body.Action ?? null },
        body: M.Body,
        mime: M.MIMEType === 'text/plain' ? 'text/plain' : 'text/html',
        parsed: {},
        atts: [],
        order,
      };
      messages.set(ID, m);
      emit([{ ID, Action: 1, Message: metaOf(m) }]);
      return ok({ Message: { ...metaOf(m), Body: m.body, MIMEType: m.mime, Attachments: [] } });
    }
    if (path === 'mail/v4/attachments' && req.method === 'POST' && form) {
      const draft = messages.get(String(form.get('MessageID')));
      const kp = form.get('KeyPackets');
      const dp = form.get('DataPacket');
      const sig = form.get('Signature');
      if (!draft || !(kp instanceof Blob) || !(dp instanceof Blob)) return err(422, 2001, 'Invalid attachment');
      const data = new Uint8Array(await dp.arrayBuffer());
      const meta = { ID: rid(), Name: String(form.get('Filename')), Size: data.length, MIMEType: String(form.get('MIMEType')), Disposition: 'attachment', Headers: { 'content-disposition': 'attachment' }, KeyPackets: Buffer.from(await kp.arrayBuffer()).toString('base64'), Signature: sig instanceof Blob ? Buffer.from(await sig.arrayBuffer()).toString('base64') : null };
      draft.atts.push({ meta, data });
      draft.meta.NumAttachments = draft.atts.length;
      uploads.push({ id: meta.ID, draft: draft.meta.ID, name: meta.Name, data, keyPackets: meta.KeyPackets, signature: meta.Signature });
      return ok({ Attachment: meta });
    }
    if ((m = path.match(/^mail\/v4\/messages\/([A-Za-z0-9_=-]+)$/)) && req.method === 'POST' && form) {
      const draft = messages.get(m[1]);
      if (!draft || !draft.meta.LabelIDs.includes('8')) return err(422, 15052, 'Message has already been sent');
      const packages: Record<string, any> = {};
      let autoSave: number | null = null;
      let delay: number | null = null;
      for (const [k, v] of form.entries()) {
        if (k === 'AutoSaveContacts') autoSave = Number(v);
        else if (k === 'DelaySeconds') delay = Number(v);
        if (!k.startsWith('Packages[')) continue;
        const keys = [...k.slice('Packages'.length).matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]);
        let at = packages;
        for (const key of keys.slice(0, -1)) at = at[key] ??= {};
        const last = keys.at(-1)!;
        const val = v as unknown;
        at[last] = val instanceof Blob ? new Uint8Array(await val.arrayBuffer()) : /^(Type|Signature|Flags)$/.test(last) ? Number(v) : v;
      }
      let verified: Sent['verified'];
      try {
        verified = await verifySend(draft, packages);
      } catch (e) {
        rejected.push(String((e as Error).message ?? e));
        return err(422, 2001, `fake proton: ${String((e as Error).message ?? e)}`);
      }
      sent.push({ id: draft.meta.ID, packages, verified, autoSaveContacts: autoSave, delaySeconds: delay, parentId: draft.meta.ParentID ?? null, action: draft.meta.Action ?? null });
      const before = new Set(draft.meta.LabelIDs as string[]);
      draft.meta.LabelIDs = withDerived(['2', '7']);
      draft.meta.Flags = 2;
      draft.meta.ExternalID = `${rid(12).replace(/[^A-Za-z0-9]/g, '')}@proton.test`;
      draft.meta.Time = Math.floor(Date.now() / 1000);
      if (draft.meta.ParentID && messages.has(draft.meta.ParentID)) messages.get(draft.meta.ParentID)!.meta.IsReplied = 1;
      emit([{ ID: draft.meta.ID, Action: 2, Message: { ...metaOf(draft), LabelIDsAdded: draft.meta.LabelIDs.filter((l: string) => !before.has(l)), LabelIDsRemoved: [...before].filter((l) => !draft.meta.LabelIDs.includes(l)) } }]);
      return ok({ Sent: metaOf(draft), DeliveryTime: draft.meta.Time });
    }
    if (path === 'core/v4/users') return ok({ User: { ID: UserID, Name: 'pat', DisplayName: 'Pat Proton', Email: email, Keys: [{ ID: rid(), Primary: 1, Active: 1, Version: 3, PrivateKey: user.privateKey.armor() }] } });
    if (path === 'core/v4/addresses') return ok({ Addresses: addresses, Total: addresses.length });
    if (path === 'core/v4/labels') {
      const t = Number(url.searchParams.get('Type'));
      return ok({ Labels: t === 3 ? folders : t === 1 ? labels : [] });
    }
    if (path === 'mail/v4/messages/count') return ok({ Counts: counts() });
    if (path === 'mail/v4/messages' && req.method === 'GET') return listMessages(url);
    if ((m = path.match(/^mail\/v4\/messages\/([A-Za-z0-9_=-]+)$/)) && req.method === 'GET') {
      const msg = messages.get(m[1]);
      if (!msg) return err(422, 2501, 'Message does not exist');
      return ok({ Message: { ...metaOf(msg), Body: msg.body, MIMEType: msg.mime, Header: '', ParsedHeaders: msg.parsed, Attachments: msg.atts.map((a) => a.meta) } });
    }
    if ((m = path.match(/^mail\/v4\/attachments\/([A-Za-z0-9_=-]+)$/)) && req.method === 'GET') {
      for (const msg of messages.values()) {
        const a = msg.atts.find((x) => x.meta.ID === m![1]);
        if (a) return new Response(Buffer.from(a.data), { headers: { 'content-type': 'application/octet-stream' } });
      }
      return err(422, 2501, 'Attachment does not exist');
    }
    if (path === 'mail/v4/messages/read' || path === 'mail/v4/messages/unread') {
      const unread = path.endsWith('unread') ? 1 : 0;
      return batch(body.IDs ?? [], (msg) => {
        msg.meta.Unread = unread;
        emit([{ ID: msg.meta.ID, Action: 3, Message: metaOf(msg) }]);
        return 1000;
      });
    }
    if (path === 'mail/v4/messages/label' || path === 'mail/v4/messages/unlabel') {
      const LabelID = String(body.LabelID);
      if (!isFolder(LabelID) && !isLabel(LabelID)) return err(422, 2501, 'Label does not exist');
      return batch(body.IDs ?? [], (msg) => {
        if (path.endsWith('unlabel')) {
          if (isFolder(LabelID)) return 2011;
          relabel(msg, [], [LabelID]);
          return 1000;
        }
        // Only drafts go to Drafts, only sent mail to Sent.
        if ((LabelID === '8' && msg.meta.Flags & 3) || (LabelID === '7' && !(msg.meta.Flags & 2))) return 2011;
        relabel(msg, [LabelID], []);
        return 1000;
      });
    }
    if (path === 'mail/v4/messages/delete') {
      return batch(body.IDs ?? [], (msg) => {
        messages.delete(msg.meta.ID);
        emit([{ ID: msg.meta.ID, Action: 0 }]);
        return 1000;
      });
    }
    if (path === 'core/v4/events/latest') return ok({ EventID: events.at(-1)!.id });
    if ((m = path.match(/^core\/v5\/events\/([A-Za-z0-9_=-]+)$/))) return eventsFrom(m[1]);
    return err(404, 404, `fake proton: no ${req.method} ${path}`);
  }

  // ---- the page
  function mailPage(localID: number) {
    const mine = signedIn && localID === 0 && sessionValid;
    const config = { UID, localID, keyPassword, appVersion: APP_VERSION, accept: ACCEPT, pagePollMs, withhold: opts.withhold ?? [] };
    const html = `<!doctype html><html><head><title>Inbox | Proton Mail</title></head><body><div class="app-root">${mine ? 'Inbox' : 'No session'}</div>
<script>
(() => {
  if (!${mine}) { localStorage.removeItem('ps-${localID}'); return; }
  localStorage.setItem('ps-${localID}', ${JSON.stringify(JSON.stringify(ps))});
  window.__fakeProton = ${JSON.stringify(config)};
})();
</script>${mine ? '<script src="/assets/static/openpgp.js"></script><script src="/assets/static/index.js"></script>' : ''}</body></html>`;
    const h = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    if (mine) {
      h.append('set-cookie', `AUTH-${UID}=${access}; Path=/api; HttpOnly; SameSite=Lax`);
      h.append('set-cookie', `REFRESH-${UID}=${refresh}; Path=/api/auth/refresh; HttpOnly; SameSite=Lax`);
    }
    return new Response(html, { headers: h });
  }
  const js = (code: string) => new Response(code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path.startsWith('/api/')) return apiCall(req, url, decodeURIComponent(path.slice(5)));
      let m: RegExpMatchArray | null;
      if (path === '/') return Response.redirect(`${base}${signedIn && sessionValid ? '/u/0/inbox' : '/login'}`, 302);
      if ((m = path.match(/^\/u\/(\d+)(?:\/.*)?$/))) return mailPage(Number(m[1]));
      if (path === '/assets/static/index.js') return js(APP_JS);
      if (path === '/assets/static/main.js') return js(MAIN_JS);
      if (path === '/assets/static/openpgp.js') return js(OPENPGP_JS);
      if (path === '/login') return new Response('<!doctype html><title>Sign in | Proton</title><body>Sign in</body>', { headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    },
  });
  const base: string = `http://127.0.0.1:${server.port}`;

  return {
    url: base,
    email,
    alias,
    /** Every address, as core/v4/addresses gives it (without keys). */
    addresses: addresses.map(({ Keys: _k, ...a }) => a),
    /** Secrets the extractor must never write down or let out. */
    secrets: { keyPassword, clientKey, UID, get access() {
      return access;
    }, get refresh() {
      return refresh;
    }, blob, userKey: user.privateKey.armor(), addressKey: primary.armored, token: primary.token_plain },
    folders,
    labels,
    calls,
    stop: () => server.stop(true),
    deliver,
    message: (id: string) => (messages.has(id) ? structuredClone(messages.get(id)!.meta) : undefined),
    messages: () => [...messages.values()].map((m) => structuredClone(m.meta)),
    /** As if done in Proton's own app. */
    setUnread(id: string, unread: boolean) {
      const m = messages.get(id)!;
      m.meta.Unread = unread ? 1 : 0;
      emit([{ ID: id, Action: 3, Message: metaOf(m) }]);
    },
    label(id: string, add: string[], remove: string[] = []) {
      relabel(messages.get(id)!, add, remove);
    },
    remove(id: string) {
      messages.delete(id);
      emit([{ ID: id, Action: 0 }]);
    },
    /** Say the message's first attachment is bigger than it is (for the 25 MB cap). */
    inflate(id: string, size: number) {
      messages.get(id)!.atts[0].meta.Size = size;
    },
    /** An update event that does not say where the message is (no LabelIDs): the extractor must ask. */
    bareUpdate(id: string) {
      const m = messages.get(id)!;
      emit([{ ID: id, Action: 3, Message: { ID: id, Unread: m.meta.Unread } }]);
    },
    addFolder(name: string) {
      const f = { ID: rid(), Name: name, Path: name, Type: 3, Color: '#80FF80', Order: folders.length + 1, Notify: 1, Expanded: 1 };
      folders.push(f);
      emit([], { labels: true });
      return f.ID;
    },
    /** The next events page says "refresh mail". */
    refreshEvents(flag = 255) {
      refreshNext = flag;
    },
    /** Every event id so far is forgotten: asking from one is a 400. */
    forgetEvents() {
      emit([]);
      forgottenBefore = events.length - 1;
    },
    latestEvent: () => events.at(-1)!.id,
    /** The access token runs out: the next calls get 401 until someone refreshes. */
    expireAccess() {
      access = `at-${rid(24)}`;
    },
    /** The session is revoked: refreshing fails too. */
    signOut() {
      sessionValid = false;
    },
    failNext(status: number, count = 1, match?: string, code?: number) {
      failures.push({ status, count, match, code });
    },
    /** The hook's calls, for header checks. */
    hookCalls: () => calls.filter((c) => c.by === 'hook'),
    /** How core/v4/keys/all answers for an address; keyed kinds get a fresh key pair, whose private half is returned. */
    async recipient(address: string, kind: RecipientKind) {
      const make = async () => (await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: address }], format: 'object' })).privateKey;
      const key = ['clear', 'internal-nokeys', 'warn', 'error'].includes(kind) ? undefined : await make();
      const extra = kind === 'internal-two' || kind === 'internal-unverified' ? await make() : undefined;
      recipients.set(address.toLowerCase(), { kind, key, extra });
      return key;
    },
    /** A contact in the owner's Proton contacts, for this address. */
    contact(address: string, c: FakeContact = {}) {
      const group = 'ITEM1';
      const props = (c.props ?? []).map((p) => (p === 'KEY' ? `${group}.KEY;PREF=1:data:application/pgp-keys;base64,AAAA` : p === 'X-PM-MIMETYPE' ? `${group}.X-PM-MIMETYPE:text/plain` : p === 'X-PM-SCHEME' ? `${group}.X-PM-SCHEME:pgp-inline` : `${group}.${p}:true`));
      const card = (extra: string[]) => ['BEGIN:VCARD', 'VERSION:4.0', `FN;PREF=1:${address.split('@')[0]}`, `UID:proton-web-${rid(8)}`, `${group}.EMAIL;PREF=1:${address}`, ...extra, 'END:VCARD'].join('\r\n');
      const cardType = c.cardType ?? 2;
      const cards = [
        { Type: 2, Data: card(cardType === 2 ? props : []), Signature: '-----BEGIN PGP SIGNATURE-----\n(fake)\n-----END PGP SIGNATURE-----' },
        ...(cardType === 0 ? [{ Type: 0, Data: card(props), Signature: null }] : []),
        // The encrypted card (phone, notes): Proton never reads encryption settings from it, nor does the hook.
        { Type: 3, Data: '-----BEGIN PGP MESSAGE-----\n(fake)\n-----END PGP MESSAGE-----', Signature: '(fake)' },
      ];
      contacts.set(address.toLowerCase(), { ID: rid(), email: address, defaults: c.defaults ?? 1, unreadable: !!c.unreadable, cards });
    },
    /** Change the account's mail settings (as the server has them; the page's store keeps what it loaded). */
    setMailSettings(patch: Record<string, unknown>) {
      mailSettings = { ...mailSettings, ...patch };
    },
    /** What was sent, as the server got it (each one checked: see `verified`). */
    sent,
    /** Sends refused because a package was wrong: the reason. */
    rejected,
    get draftsMade() {
      return draftsMade;
    },
    uploads,
    addressKeys: { primary: primary.priv, alias: second.priv },
  };
}

export type FakeProton = Awaited<ReturnType<typeof startFakeProton>>;
