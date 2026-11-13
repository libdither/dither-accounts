/**
 * `mail.send` for Proton: the message is checked here (addresses, the body, the files and their sizes), and sent by the
 * Mail page's hook (extension/hook.js `send`): the safe subset of what Proton's composer sends. Proton users get it
 * encrypted to their key (package type 1), outside addresses with no key in the clear (type 4), in Proton's own
 * formats; anything else (a contact with encryption settings, an outside address with a key, Proton's warnings, a
 * lookup that fails, settings that sign or attach your key for outside addresses) is refused before anything is made,
 * with a 422 whose code says why: 'recipients', 'settings', or 'from' (docs/proton.md, "Sending").
 *
 * A reply (`replyTo`, a Proton message id) is made from that message's address and names it as the parent, so Proton
 * threads it, sets In-Reply-To and References, and marks the original answered. The copy in Sent is the sent message
 * itself (Proton files the draft there): `sentId` is its id.
 *
 * `from` picks the address (and so its keys, which sign and encrypt the draft): one of the account's enabled addresses
 * that may send (`sendingAddresses`, published as status.self.addresses); any other is 422. The page is held to the
 * same address, or refuses.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import type { MailAccountAddress, MailAddress, OutgoingFile, OutgoingMail } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import type { ProtonApi } from './api.ts';
import type { ProtonAddress } from './pgp.ts';

/** Proton takes at most 25 MB of attachments on one message. */
export const SEND_CAP = 25 * 1024 * 1024;
export const MAX_RECIPIENTS = 100;
const EMAIL = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;
const ID_RE = /^[A-Za-z0-9_=+-]{1,200}$/;

export interface OutgoingChecked {
  /** The address to send as, as the app wrote it (checked against the account's at send). */
  from?: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  files: { filename: string; mime: string; base64: string; size: number }[];
}

/** The message as an app sent it, checked: 400 for anything malformed, 413 for files over the cap. */
export function checkOutgoing(m: OutgoingMail, accountDir: string): OutgoingChecked {
  const bad = (msg: string) => new StatusError(msg, 400);
  if (!m || typeof m !== 'object') throw bad('a message, please');
  const list = (l: unknown, what: string): MailAddress[] => {
    if (l === undefined || l === null) return [];
    if (!Array.isArray(l)) throw bad(`${what} is a list of { name, email }`);
    return l.map((a, i) => {
      if (!a || typeof a !== 'object' || typeof a.email !== 'string' || !EMAIL.test(a.email.trim()) || (a.name != null && typeof a.name !== 'string')) throw bad(`${what}[${i}] is not an address`);
      return { name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 200) : null, email: a.email.trim() };
    });
  };
  const to = list(m.to, 'to');
  const cc = list(m.cc, 'cc');
  const bcc = list(m.bcc, 'bcc');
  if (!to.length && !cc.length && !bcc.length) throw bad('to whom?');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw bad(`at most ${MAX_RECIPIENTS} recipients`);
  if (typeof m.subject !== 'string') throw bad('subject is a string');
  if (m.text !== undefined && typeof m.text !== 'string') throw bad('text is a string');
  if (m.html !== undefined && typeof m.html !== 'string') throw bad('html is a string');
  if (m.text === undefined && m.html === undefined) throw bad('text or html, or both');
  if (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || !ID_RE.test(m.replyTo))) throw new StatusError('replyTo is the id of a message in this account', 404);
  if (m.attachments !== undefined && !Array.isArray(m.attachments)) throw bad('attachments is a list');
  if (m.from != null && typeof m.from !== 'string') throw bad("from is one of the account's addresses, as a string");
  const files = (m.attachments ?? []).map((a, i) => outgoingFile(a, i, accountDir));
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > SEND_CAP) throw new StatusError(`the attachments are ${(total / 1024 / 1024).toFixed(1)} MB together; Proton takes at most 25 MB on one message`, 413);
  return { ...(typeof m.from === 'string' ? { from: m.from.trim() } : {}), to, cc, bcc, subject: m.subject.slice(0, 998), ...(m.text !== undefined ? { text: m.text } : {}), ...(m.html !== undefined ? { html: m.html } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), files };
}

/**
 * A file's bytes. A path must be absolute, a regular file of at most 25 MB, and not one of the account's own files
 * (its profile, the extension's config with the bridge token): an app that may send as you may attach your files, not
 * the account's.
 */
function outgoingFile(a: OutgoingFile, i: number, accountDir: string) {
  const bad = (msg: string, status = 400) => new StatusError(`attachment ${i + 1}: ${msg}`, status);
  if (!a || typeof a !== 'object' || typeof a.filename !== 'string' || !a.filename.trim() || typeof a.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime)) throw bad('needs filename and mime');
  let content: Buffer;
  if (typeof a.base64 === 'string' && a.path === undefined) {
    if (a.base64.length > Math.ceil((SEND_CAP * 4) / 3) + 4) throw bad('over 25 MB', 413);
    content = Buffer.from(a.base64, 'base64');
  } else if (typeof a.path === 'string' && a.base64 === undefined) {
    if (!isAbsolute(a.path)) throw bad('the path must be absolute');
    let real: string;
    try {
      real = realpathSync(a.path);
    } catch {
      throw bad('no such file', 404);
    }
    let acct = accountDir;
    try {
      acct = realpathSync(accountDir);
    } catch {}
    const rel = relative(acct, real);
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw bad("that is one of the account's own files", 403);
    if (/^secret\.json/.test(basename(real))) throw bad('that file is a secret', 403);
    const st = statSync(real);
    if (!st.isFile()) throw bad('not a regular file');
    if (st.size > SEND_CAP) throw bad('over 25 MB', 413);
    content = readFileSync(real);
  } else throw bad('one of path and base64');
  if (content.length > SEND_CAP) throw bad('over 25 MB', 413);
  return { filename: a.filename.trim().slice(0, 255), mime: a.mime.toLowerCase(), base64: content.toString('base64'), size: content.length };
}

/** What the page answers to `send`: refused with a status and a reason, or sent. Checked field by field. */
export type PageSend = { refused: { status: number; message: string; code?: SendRefusal } } | { sent: { id: string; externalId: string | null; recipients: number; encrypted: number } };
/** The words a refused send carries to the app (CallError.code, with 422): mail.ts documents them. */
export const SEND_REFUSALS = ['from', 'recipients', 'settings'] as const;
export type SendRefusal = (typeof SEND_REFUSALS)[number];
/** The 'settings' refusal's sentence, put on here and not in the page (which must not name the app). */
export const SETTINGS_REFUSAL = "Your Proton settings sign mail to outside addresses or attach your public key, which dither-chat can't do yet, so send this one from Proton.";
export function checkPageSend(r: unknown): PageSend {
  const o = r as any;
  if (o && typeof o === 'object' && o.refused && typeof o.refused === 'object') {
    const status = Number.isInteger(o.refused.status) && o.refused.status >= 400 && o.refused.status < 600 ? o.refused.status : 502;
    const code = SEND_REFUSALS.includes(o.refused.code) && status === 422 ? { code: o.refused.code as SendRefusal } : {};
    const said = typeof o.refused.message === 'string' ? o.refused.message.slice(0, 1500) : 'the page refused to send it';
    return { refused: { status, message: code.code === 'settings' ? SETTINGS_REFUSAL : said, ...code } };
  }
  const s = o?.sent;
  if (s && typeof s === 'object' && typeof s.id === 'string' && ID_RE.test(s.id))
    return { sent: { id: s.id, externalId: typeof s.externalId === 'string' && s.externalId ? s.externalId.slice(0, 300) : null, recipients: Number(s.recipients) || 0, encrypted: Number(s.encrypted) || 0 } };
  throw new StatusError('the page answered the send in a shape this does not know; check Sent before trying again', 502);
}

/** An address the account sends as, with its Proton id. */
export interface SendingAddress extends MailAccountAddress {
  id: string;
}

/**
 * The addresses this account sends as, in Proton's order: enabled (Status 1) and allowed to send (Send 1), as the
 * composer offers them. The first is the default.
 */
export function sendingAddresses(addresses: ProtonAddress[]): SendingAddress[] {
  return addresses
    .filter((a) => typeof a?.Email === 'string' && a.Email && typeof a.ID === 'string' && (a.Status ?? 1) === 1 && (a.Send ?? 1) === 1)
    .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
    .map((a) => ({ id: a.ID, email: a.Email, name: a.DisplayName || null }));
}

/** `from` as one of the account's sending addresses, or 422 (the refused address is not repeated: errors may be logged). */
export function pickFrom(from: string, addresses: SendingAddress[]): SendingAddress {
  const want = from.trim().toLowerCase();
  const a = addresses.find((x) => x.email.toLowerCase() === want);
  if (!a) throw new StatusError("from is not one of this account's addresses that can send (its status's self.addresses)", 422, 'from');
  return a;
}

export interface SendDeps {
  api: ProtonApi;
  /** The account's sending addresses (asked only when `from` is given). */
  addresses?: () => Promise<SendingAddress[]>;
  /** One command to the Mail page's hook. */
  page: (cmd: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** Send through the page; the RFC Message-ID Proton gave it, and its id (it is the copy in Sent). */
export async function send(m: OutgoingChecked, deps: SendDeps): Promise<{ messageId: string; sentId: string | null }> {
  let fromAddressID: string | null = null;
  if (m.from !== undefined) {
    if (!deps.addresses) throw new StatusError("this account's addresses are not known yet; try again in a moment", 503);
    fromAddressID = pickFrom(m.from, await deps.addresses()).id;
  }
  let parent: { id: string; addressID: string | null } | null = null;
  if (m.replyTo) {
    // The message you reply to, as the app has it open when you reply: its address sends the reply.
    const r = await deps.api.call<{ Message?: { ID?: string; AddressID?: string } }>({ method: 'GET', path: `mail/v4/messages/${m.replyTo}` });
    if (!r.Message?.ID) throw new StatusError('no such message to reply to', 404);
    parent = { id: r.Message.ID, addressID: typeof r.Message.AddressID === 'string' ? r.Message.AddressID : null };
  }
  let answer: unknown;
  try {
    answer = await deps.page(
      {
        kind: 'send',
        to: m.to,
        cc: m.cc,
        bcc: m.bcc,
        subject: m.subject,
        ...(m.html !== undefined ? { html: m.html } : { text: m.text ?? '' }),
        attachments: m.files.map((f) => ({ filename: f.filename, mime: f.mime, base64: f.base64 })),
        ...(parent ? { parentID: parent.id, addressID: parent.addressID } : {}),
        // Chosen by the app: the page sends from it or refuses, never from another.
        ...(fromAddressID ? { fromAddressID } : {}),
      },
      180_000,
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    if (/timed out/.test(msg)) throw new StatusError('the Mail page did not answer in time: it may or may not have sent it; look in Sent before trying again', 504);
    throw new StatusError(`the Mail page could not send it: ${msg}`, 503);
  }
  const r = checkPageSend(answer);
  if ('refused' in r) {
    deps.log('warn', `send refused: ${r.refused.status}${r.refused.code ? ` (${r.refused.code})` : ''}`, r.refused.message);
    throw new StatusError(r.refused.message, r.refused.status, r.refused.code);
  }
  let external = r.sent.externalId;
  if (!external) {
    // Proton gives the Message-ID with the sent message; if it did not, it has it on the message now.
    try {
      const g = await deps.api.call<{ Message?: { ExternalID?: string | null } }>({ method: 'GET', path: `mail/v4/messages/${r.sent.id}` });
      external = typeof g.Message?.ExternalID === 'string' && g.Message.ExternalID ? g.Message.ExternalID : null;
    } catch {}
  }
  deps.log('info', `sent: ${r.sent.recipients} recipient(s), ${r.sent.encrypted} encrypted, ${m.files.length} attachment(s)${parent ? ', a reply' : ''}${fromAddressID ? ', from a chosen address' : ''}`);
  if (!external) deps.log('warn', 'sent, but Proton gave no Message-ID for it');
  return { messageId: external ? (external.startsWith('<') ? external : `<${external}>`) : '', sentId: r.sent.id };
}
