/**
 * `mail.send` for Gmail: the message is checked here (addresses, the body, the files and their sizes) before anything
 * reaches Gmail, as the proton kind checks its own (extractors/proton/src/send.ts). GmailMail.send then uploads the
 * files, saves a draft and sends it through the Gmail page (write.ts).
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { MailAddress, OutgoingFile, OutgoingMail } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import { DECIMAL_ID } from './protocol.ts';

/** Gmail takes at most 25 MB of attachments on one message (larger files go to Drive, which this does not do). */
export const SEND_CAP = 25 * 1024 * 1024;
/** Recipients on one message (to, cc and bcc together): kept well under Gmail's own limits. */
export const MAX_RECIPIENTS = 100;
const EMAIL = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;

export interface OutgoingChecked {
  from?: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  /** Gmail's id of the message answered (decimal). */
  replyTo?: string;
  files: { filename: string; mime: string; bytes: Buffer }[];
}

/** The message as an app sent it, checked: 400 for anything malformed, 404 for a replyTo that is no message id, 413 for files over the cap. */
export function checkOutgoing(m: OutgoingMail, accountDir: string): OutgoingChecked {
  const bad = (msg: string) => new StatusError(msg, 400);
  if (!m || typeof m !== 'object') throw bad('a message, please');
  const list = (l: unknown, what: string): MailAddress[] => {
    if (l === undefined || l === null) return [];
    if (!Array.isArray(l)) throw bad(`${what} is a list of { name, email }`);
    return l.map((a, i) => {
      if (!a || typeof a !== 'object' || typeof a.email !== 'string' || !EMAIL.test(a.email.trim()) || (a.name != null && typeof a.name !== 'string')) throw bad(`${what}[${i}] is not an address`);
      const name = typeof a.name === 'string' ? a.name.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : '';
      return { name: name || null, email: a.email.trim() };
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
  if (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || !DECIMAL_ID.test(m.replyTo))) throw new StatusError('replyTo is the id of a message in this account', 404);
  if (m.attachments !== undefined && !Array.isArray(m.attachments)) throw bad('attachments is a list');
  if (m.from != null && typeof m.from !== 'string') throw bad("from is one of the account's addresses, as a string");
  const files = (m.attachments ?? []).map((a, i) => outgoingFile(a, i, accountDir));
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > SEND_CAP) throw new StatusError(`the attachments are ${(total / 1024 / 1024).toFixed(1)} MB together; Gmail takes at most 25 MB on one message`, 413);
  return {
    ...(typeof m.from === 'string' ? { from: m.from.trim() } : {}),
    to,
    cc,
    bcc,
    subject: m.subject.replace(/[\r\n]+/g, ' ').slice(0, 998),
    ...(m.text !== undefined ? { text: m.text } : {}),
    ...(m.html !== undefined ? { html: m.html } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    files,
  };
}

/**
 * A file's bytes. A path must be absolute, a regular file of at most 25 MB, and not one of the account's own files
 * (its browser profile, the extension's config with the bridge token): an app that may send as you may attach your
 * files, not the account's.
 */
function outgoingFile(a: OutgoingFile, i: number, accountDir: string) {
  const bad = (msg: string, status = 400) => new StatusError(`attachment ${i + 1}: ${msg}`, status);
  if (!a || typeof a !== 'object' || typeof a.filename !== 'string' || !a.filename.trim() || typeof a.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime)) throw bad('needs filename and mime');
  let bytes: Buffer;
  if (typeof a.base64 === 'string' && a.path === undefined) {
    if (a.base64.length > Math.ceil((SEND_CAP * 4) / 3) + 4) throw bad('over 25 MB', 413);
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(a.base64.replace(/\s+/g, ''))) throw bad('base64 is not base64');
    bytes = Buffer.from(a.base64, 'base64');
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
    if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw bad("that is one of the account's own files", 403);
    if (/^secret\.json/.test(basename(real))) throw bad('that file is a secret', 403);
    const st = statSync(real);
    if (!st.isFile()) throw bad('not a regular file');
    if (st.size > SEND_CAP) throw bad('over 25 MB', 413);
    bytes = readFileSync(real);
  } else throw bad('one of path and base64');
  if (bytes.length > SEND_CAP) throw bad('over 25 MB', 413);
  return { filename: a.filename.trim().replace(/[\r\n"\\/]+/g, ' ').slice(0, 255), mime: a.mime.toLowerCase(), bytes };
}
