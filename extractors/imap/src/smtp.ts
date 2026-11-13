/**
 * Sending: the message is built here (nodemailer's MailComposer, with file and URL access off: files are read here,
 * after the checks below) and handed to the SMTP server with nodemailer's SMTPConnection, whose TLS is held to the
 * same rules as IMAP's (verified, or a pin checked before AUTH). A copy goes to Sent unless the server keeps one.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import type { MailAccountAddress, MailAddress, OutgoingFile, OutgoingMail } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { type Settings, where } from './config.ts';
import { ATTACHMENT_CAP, type Imap, sleep } from './imap.ts';
import { messageId } from './ids.ts';
import { CertError, checkSocket, isCertFailure, short, type Trust, trustFor } from './tls.ts';

const TOTAL_CAP = 35 * 1024 * 1024;
const MAX_RECIPIENTS = 500;
/** After a failed check or send (not a refused password or certificate), signed in again after this long, then longer. */
const RECHECK_S = [10, 30, 60, 120, 300, 600];

/** The addresses this account sends as (status.self.addresses): the configured one; aliases when the config has them. */
export function sendingAddresses(s: Settings): MailAccountAddress[] {
  return [{ email: s.email, name: s.name }];
}

export class Smtp {
  problem: { kind: 'login' | 'certificate'; message: string } | null = null;
  /** The SMTP layer's state, as this last set it. */
  state: 'ok' | 'waiting' | 'failed' = 'waiting';
  note = 'not signed in yet';
  private lastTry = 0;
  private failures = 0;

  constructor(
    private s: Settings,
    private pass: () => string,
    private imap: Imap,
  ) {}

  private layer(state: 'ok' | 'waiting' | 'failed', note: string) {
    this.state = state;
    this.note = note;
    this.failures = state === 'failed' ? this.failures + 1 : 0;
    this.imap.layer('SMTP', state, note);
  }

  /** Whether mail.send can send now, and why not in a sentence for a person (status.details.canSend, sendNote). */
  canSend(): { canSend: boolean; sendNote: string | null } {
    if (this.state === 'ok') return { canSend: true, sendNote: null };
    if (this.problem?.kind === 'login') return { canSend: false, sendNote: 'Mail cannot be sent: the SMTP server refused the password. Replace it on the accounts page.' };
    const bare = (t: string) => t.replace(/[.\s]+$/, '');
    if (this.problem) return { canSend: false, sendNote: `Mail cannot be sent: ${bare(this.problem.message)}.` };
    if (this.state === 'waiting') return { canSend: false, sendNote: 'Sending is not checked yet: it is signing in to the SMTP server.' };
    return { canSend: false, sendNote: `Mail cannot be sent now (SMTP ${bare(this.note)}). It tries the SMTP server again by itself.` };
  }

  /** A failed check or send that a retry may mend: sign in again once its wait is over (main.ts asks every 2 s). */
  recheckDue(): boolean {
    if (this.state !== 'failed' || this.problem || this.busy) return false;
    return Date.now() - this.lastTry >= RECHECK_S[Math.min(Math.max(this.failures - 1, 0), RECHECK_S.length - 1)] * 1000;
  }
  private busy = false;

  /** Connect, check the certificate, sign in, run f, quit. */
  private async session<T>(f: (conn: SMTPConnection) => Promise<T>): Promise<T> {
    if (this.problem) throw new StatusError(this.problem.message, this.problem.kind === 'login' ? 401 : 495);
    this.lastTry = Date.now();
    this.busy = true;
    try {
      return await this.sessionInner(f);
    } finally {
      this.busy = false;
    }
  }
  private async sessionInner<T>(f: (conn: SMTPConnection) => Promise<T>): Promise<T> {
    const e = this.s.smtp;
    const at = where(e);
    let trust: Trust;
    try {
      trust = await trustFor(this.imap.pins, 'smtp', e, this.s.cert);
    } catch (err: any) {
      this.layer('failed', `${at}: ${err?.message ?? err}`);
      throw new StatusError(`the SMTP server at ${at} is not reachable: ${err?.message ?? err}`, 503);
    }
    const conn = new SMTPConnection({
      host: e.host,
      port: e.port,
      secure: e.security === 'tls',
      requireTLS: e.security === 'starttls',
      ignoreTLS: e.security === 'none',
      // Only for a pinned server, whose certificate is checked right after the handshake instead (before AUTH).
      tls: { rejectUnauthorized: trust.mode !== 'pin' },
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    conn.on('error', () => {});
    try {
      await new Promise<void>((res, rej) => {
        conn.once('error', rej);
        conn.connect((err?: Error | null) => (err ? rej(err) : res()));
      });
      if (e.security !== 'none') checkSocket((conn as any)._socket, trust, `SMTP ${at}`);
      await new Promise<void>((res, rej) => conn.login({ user: this.s.smtpUser, pass: this.pass() }, (err?: Error | null) => (err ? rej(err) : res())));
      const out = await f(conn);
      this.layer('ok', `${at}, signed in${trust.mode === 'pin' ? `, pinned ${short(trust.fingerprint!)}` : ''}`);
      return out;
    } catch (err: any) {
      throw this.failed(err, at, trust);
    } finally {
      try {
        conn.quit();
      } catch {}
      setTimeout(() => conn.close(), 2000).unref?.();
    }
  }

  private failed(err: any, at: string, trust: Trust): Error {
    if (err instanceof StatusError) return err;
    const text = String(err?.response ?? err?.message ?? err).slice(0, 300);
    if (err?.code === 'EAUTH') {
      const message = `SMTP ${at} refused the password for ${this.s.smtpUser}: replace it on the accounts page`;
      this.problem = { kind: 'login', message };
      this.layer('failed', 'the server refused the password');
      return new StatusError(message, 401);
    }
    if (err instanceof CertError || isCertFailure(err)) {
      const offered = err instanceof CertError ? err.offered : null;
      const message =
        trust.mode === 'pin'
          ? `SMTP ${at} now offers a certificate other than the one pinned (pinned ${short(trust.fingerprint!)}, offered ${offered ? offered.fingerprint : 'unknown'})`
          : `SMTP ${at}'s certificate does not verify (${text})`;
      this.problem = { kind: 'certificate', message };
      this.layer('failed', trust.mode === 'pin' ? 'certificate changed' : 'certificate not trusted');
      return new StatusError(message, 495);
    }
    if (err?.code === 'EENVELOPE') {
      this.layer('ok', at);
      return new StatusError(`the SMTP server refused a recipient: ${text}`, 400);
    }
    if (err?.code === 'EMESSAGE') {
      this.layer('ok', at);
      return new StatusError(`the SMTP server refused the message: ${text}`, 502);
    }
    this.layer('failed', `${at}: ${text}`);
    return new StatusError(`the SMTP server at ${at} is not reachable: ${text}`, 503);
  }

  /** Sign in once (on start), for the SMTP layer. */
  async verify() {
    try {
      await this.session(async () => {});
    } catch {}
  }

  /** The From of a message: the account's first address, or `from` when it is one of them (else 422). */
  private sender(from: string | undefined): { name: string; address: string } {
    const all = sendingAddresses(this.s);
    const a = from === undefined ? all[0] : all.find((x) => x.email.toLowerCase() === from.trim().toLowerCase());
    // The refused address is not repeated: errors may be logged.
    if (!a) throw new StatusError("from is not one of this account's addresses (its status's self.addresses)", 422, 'from');
    return { name: a.name ?? '', address: a.email };
  }

  async send(mail: OutgoingMail, accountDir: string): Promise<{ messageId: string; sentId: string | null }> {
    const msg = checkOutgoing(mail);
    const from = this.sender(msg.from);
    const files = (msg.attachments ?? []).map((a, i) => outgoingFile(a, i, accountDir));
    if (files.reduce((n, f) => n + f.content.length, 0) > TOTAL_CAP) throw new StatusError('the attachments are over 35 MB together', 413);

    let original: Awaited<ReturnType<Imap['threading']>> | null = null;
    if (msg.replyTo) original = await this.imap.threading(msg.replyTo);
    const domain = from.address.split('@')[1] || 'localhost';
    const mid = `<${randomUUID()}@${domain}>`;
    const date = new Date();
    const compose = (keepBcc: boolean) => {
      const node = new MailComposer({
        from,
        to: msg.to.map(addr),
        cc: (msg.cc ?? []).map(addr),
        bcc: (msg.bcc ?? []).map(addr),
        subject: msg.subject,
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        ...(msg.html !== undefined ? { html: msg.html } : {}),
        messageId: mid,
        date,
        ...(original?.messageId ? { inReplyTo: original.messageId, references: [...original.references, original.messageId].join(' ') } : {}),
        attachments: files.map((f) => ({ filename: f.filename, contentType: f.mime, content: f.content })),
        disableFileAccess: true,
        disableUrlAccess: true,
      }).compile();
      node.keepBcc = keepBcc;
      return new Promise<Buffer>((res, rej) => node.build((err: Error | null, b: Buffer) => (err ? rej(err) : res(b))));
    };
    const raw = await compose(false);
    const rcpt = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])].map((a) => a.email);
    await this.session(
      (conn) =>
        new Promise<void>((res, rej) =>
          conn.send({ from: from.address, to: rcpt }, raw, (err: Error | null, info: any) => {
            if (err) return rej(err);
            if (info?.rejected?.length && !info?.accepted?.length) return rej(Object.assign(new Error(`every recipient was refused: ${info.rejected.join(', ')}`), { code: 'EENVELOPE' }));
            res();
          }),
        ),
    );

    let sentId: string | null = null;
    try {
      const sent = await this.imap.pathOfRole('sent');
      if (sent) {
        const append = async () => {
          const r = await this.imap.appendTo(sent, await compose(true), ['\\Seen']);
          if (r.uid && r.uidValidity) return messageId(sent, r.uidValidity, r.uid);
          return this.imap.findByMessageId(sent, mid);
        };
        if (this.s.sentCopy === 'append') sentId = await append();
        else if (this.s.sentCopy === 'detect') {
          // A server that keeps the copy itself has it by now; otherwise it is ours to keep.
          await sleep(1500);
          sentId = (await this.imap.findByMessageId(sent, mid)) ?? (await append());
        } else
          for (const wait of [500, 1000, 1500]) {
            await sleep(wait);
            sentId = await this.imap.findByMessageId(sent, mid);
            if (sentId) break;
          }
      }
    } catch (err) {
      // Sent: the copy is a convenience; the message went.
      sentId = null;
    }
    if (original) await this.imap.markAnswered(original.path, original.uid).catch(() => {});
    return { messageId: mid, sentId };
  }
}

const addr = (a: MailAddress) => ({ name: a.name ?? '', address: a.email });

function checkOutgoing(m: OutgoingMail): OutgoingMail {
  const bad = (msg: string) => new StatusError(msg, 400);
  if (!m || typeof m !== 'object') throw bad('a message, please');
  const list = (l: unknown, what: string, need: boolean): MailAddress[] => {
    if (l === undefined && !need) return [];
    if (!Array.isArray(l)) throw bad(`${what} is a list of { name, email }`);
    for (const a of l) if (!a || typeof a !== 'object' || typeof a.email !== 'string' || !/^[^@\s<>,;]+@[^@\s<>,;]+$/.test(a.email) || (a.name != null && typeof a.name !== 'string')) throw bad(`${what}: ${JSON.stringify(a)?.slice(0, 80)} is not an address`);
    return l as MailAddress[];
  };
  const to = list(m.to, 'to', true);
  const cc = list(m.cc, 'cc', false);
  const bcc = list(m.bcc, 'bcc', false);
  if (!to.length && !cc.length && !bcc.length) throw bad('to whom?');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw bad(`at most ${MAX_RECIPIENTS} recipients`);
  if (typeof m.subject !== 'string') throw bad('subject is a string');
  if (m.text !== undefined && typeof m.text !== 'string') throw bad('text is a string');
  if (m.html !== undefined && typeof m.html !== 'string') throw bad('html is a string');
  if (m.text === undefined && m.html === undefined) throw bad('text or html, or both');
  if (m.replyTo !== undefined && typeof m.replyTo !== 'string') throw bad('replyTo is a message id');
  if (m.attachments !== undefined && !Array.isArray(m.attachments)) throw bad('attachments is a list');
  if (m.from != null && typeof m.from !== 'string') throw bad('from is one of the account\'s addresses, as a string');
  const { from, ...rest } = m;
  return { ...rest, ...(typeof from === 'string' ? { from } : {}), to, cc, bcc };
}

/**
 * An outgoing file's bytes. A path must be absolute, a regular file of at most 25 MB, and not the account's own
 * files (its secret.json above all): an app that may send as you may attach your files, not the account's keys.
 */
function outgoingFile(a: OutgoingFile, i: number, accountDir: string) {
  const bad = (msg: string, status = 400) => new StatusError(`attachment ${i + 1}: ${msg}`, status);
  if (!a || typeof a !== 'object' || typeof a.filename !== 'string' || !a.filename || typeof a.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime)) throw bad('needs filename and mime');
  let content: Buffer;
  if (typeof a.base64 === 'string' && a.path === undefined) {
    if (a.base64.length > Math.ceil((ATTACHMENT_CAP * 4) / 3) + 4) throw bad('over 25 MB', 413);
    content = Buffer.from(a.base64, 'base64');
  } else if (typeof a.path === 'string' && a.base64 === undefined) {
    if (!isAbsolute(a.path)) throw bad('the path must be absolute');
    let real: string;
    try {
      real = realpathSync(a.path);
    } catch {
      throw bad('no such file', 404);
    }
    const acct = realpathSync(accountDir);
    const rel = relative(acct, real);
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw bad("that is one of the account's own files", 403);
    if (/^secret\.json/.test(basename(real))) throw bad('that file is a secret', 403);
    const st = statSync(real);
    if (!st.isFile()) throw bad('not a regular file');
    if (st.size > ATTACHMENT_CAP) throw bad('over 25 MB', 413);
    content = readFileSync(real);
  } else throw bad('one of path and base64');
  if (content.length > ATTACHMENT_CAP) throw bad('over 25 MB', 413);
  return { filename: a.filename, mime: a.mime, content };
}
