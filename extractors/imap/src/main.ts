/**
 * The imap extractor: one mailbox over IMAP (with SMTP to send), answering `mail` (packages/interfaces/src/mail.ts).
 * Its config is the add form's fields (config.ts), its password is secret.json's `password`. It keeps, in the account
 * directory: tls-pins.json (the certificates it trusts for a pinned server), watch.json (the inbox's UIDVALIDITY and
 * UIDNEXT, so a restart announces what came meanwhile) and sync/ (the snapshots that mail.changes compares against on
 * servers without QRESYNC). It logs ids, counts and server answers, never message contents or the password.
 */
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { PRESETS, type Settings, settingsFrom, where } from './config.ts';
import { Imap } from './imap.ts';
import { sendingAddresses, Smtp } from './smtp.ts';

let imap: Imap | null = null;
let smtp: Smtp | null = null;
let settings: Settings | string;
let statusTimer: Timer | null = null;
const STARTED = Date.now();

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'imap', version: '1', interfaces: ['mail'], provider: typeof settings === 'string' ? null : settings.provider, startedAt: STARTED, capabilities: [] });
    sendStatus();
  },
  onCommand: (cmd) => run(cmd),
  onShutdown: async () => {
    await imap?.stop();
  },
});

const password = () => String(link.secret<{ password?: unknown }>().password ?? '');

settings = settingsFrom(link.config);
boot();

function boot() {
  if (imap || typeof settings === 'string' || !password()) return;
  imap = new Imap(settings, password, link.accountDir, {
    changed: () => statusSoon(),
    emit: (ev) => link.emit(ev),
    log: (level, msg, data) => link.log(level, msg, data),
  });
  smtp = new Smtp(settings, password, imap);
  imap.start();
  void smtp.verify().then(() => statusSoon());
  statusSoon();
}

/**
 * The manager writes a new password into secret.json without a restart, and a pin is renewed by deleting it from
 * tls-pins.json: either clears what stopped this account, and it signs in again.
 */
let lastPassword = password();
setInterval(() => {
  const p = password();
  const changed = p !== lastPassword;
  lastPassword = p;
  if (!imap) return boot();
  if (typeof settings === 'string' || !smtp) return;
  const s = settings;
  const pins = imap.pins.all();
  const pinGone = (proto: 'imap' | 'smtp') => s.cert.mode === 'pin' && !s.cert.fingerprint && !pins[`${proto} ${where(proto === 'imap' ? s.imap : s.smtp)}`];
  const clear = (x: { kind: string } | null, proto: 'imap' | 'smtp') => !!x && ((x.kind === 'login' && changed) || (x.kind === 'certificate' && pinGone(proto)));
  if (clear(smtp.problem, 'smtp')) {
    smtp.problem = null;
    void smtp.verify().then(() => statusSoon());
  }
  if (clear(imap.problem, 'imap')) {
    link.log('info', 'trying again: the password or the pinned certificate changed');
    imap.retry();
  }
  // A failed sign-in or send that was not a refusal (the server away, a timeout): check again, so canSend comes back.
  if (smtp.recheckDue()) void smtp.verify().then(() => statusSoon());
  statusSoon();
}, 2000);

function statusSoon() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    sendStatus();
  }, 50);
}

function sendStatus() {
  if (typeof settings === 'string') {
    const details = { canSend: false, sendNote: "Mail cannot be sent: this account's settings are not right." };
    link.emit({ t: 'status', status: 'attention', attention: { kind: 'unknown', message: `This account's settings are not right: ${settings}. Remove it and add it again.` }, details, layers: [{ name: 'settings', state: 'failed', note: settings }] });
    return;
  }
  const s = settings;
  const self = { email: s.email, ...(s.name ? { displayName: s.name } : {}), addresses: sendingAddresses(s) };
  if (!imap || !smtp) {
    const details = { canSend: false, sendNote: 'Mail cannot be sent: the account has no password yet.' };
    link.emit({ t: 'status', status: 'attention', attention: { kind: 'login', message: `No password: add ${PRESETS[s.provider].password}.` }, self, details, layers: [{ name: 'signed in', state: 'failed', note: 'no password' }] });
    return;
  }
  const layers = imap.layers();
  const problem = imap.problem ?? smtp?.problem ?? null;
  const state = (n: string) => layers.find((l) => l.name === n)?.state;
  const status = problem ? 'attention' : state('signed in') === 'ok' && state('inbox') === 'ok' ? 'online' : layers.some((l) => l.state === 'failed') ? 'offline' : 'connecting';
  const trust = imap.trust;
  const pins = imap.pins.all();
  const smtpPin = pins[`smtp ${where(s.smtp)}`];
  const details: Record<string, string | number | boolean | null> = {
    summaryHeaders: true,
    raw: 'original',
    provider: PRESETS[s.provider].name,
    email: s.email,
    username: s.user,
    imap: `${where(s.imap)} (${s.imap.security})`,
    smtp: `${where(s.smtp)} (${s.smtp.security})${s.smtpUser !== s.user ? ` as ${s.smtpUser}` : ''}`,
    certificate: s.imap.security === 'none' ? 'no TLS' : trust?.mode === 'pin' ? `pinned SHA-256 ${trust.fingerprint}` : `verified${imap.cert?.issuer ? ` (issued by ${imap.cert.issuer})` : ''}`,
    ...(smtpPin && smtpPin.fingerprint !== trust?.fingerprint ? { 'SMTP certificate': `pinned SHA-256 ${smtpPin.fingerprint}` } : {}),
    ...(imap.cert?.validTo ? { 'certificate valid to': imap.cert.validTo } : {}),
    sync: { q: 'QRESYNC', c: 'CONDSTORE (UID list kept)', f: 'UID + flags diff' }[imap.syncMode ?? 'f'] + (imap.syncMode ? '' : ' (until connected)'),
    'sent copy': { server: 'the server keeps it', append: 'appended to Sent', detect: 'appended to Sent unless the server kept one' }[s.sentCopy],
    ...(imap.inbox ? { inbox: `${imap.inbox.messages} messages, ${imap.inbox.unseen} unread` } : {}),
    ...(imap.mailboxCount !== null ? { mailboxes: imap.mailboxCount } : {}),
    ...(imap.capabilities.length ? { capabilities: imap.capabilities.filter((c) => /^(IDLE|MOVE|UIDPLUS|CONDSTORE|QRESYNC|SPECIAL-USE|ESEARCH|X-GM-EXT-1|OBJECTID|COMPRESS=DEFLATE|IMAP4rev2)$/.test(c)).join(' ') } : {}),
    ...(imap.lastError ? { 'last error': imap.lastError } : {}),
    ...smtp.canSend(),
  };
  link.emit({
    t: 'status',
    status,
    attention: problem ? { kind: problem.kind === 'login' ? 'login' : 'unknown', message: problem.message, ...(imap.problem?.offered ? { detail: { offered: imap.problem.offered.fingerprint } } : {}) } : null,
    self,
    details,
    layers,
  });
}

/**
 * The message an op names in its input's `id`. The manager puts its own call id in the command's `id` (it sends
 * `{ ...input, t, id }`), so the input's never arrives: until that is fixed, `message` stands in for it. A call id
 * (a UUID) never looks like a message id, so a fixed manager's `id` is taken first.
 */
function messageArg(cmd: Command): string {
  if (typeof cmd.id === 'string' && MESSAGE_ID.test(cmd.id)) return cmd.id;
  if (typeof cmd.message === 'string') return cmd.message;
  throw new StatusError("the message id did not arrive: the manager put its own call id in this op's `id` field; send the message id as `message` too", 400);
}
const MESSAGE_ID = /^[A-Za-z0-9_-]+\.\d+\.\d+$/;

async function run(cmd: Command): Promise<unknown> {
  if (typeof settings === 'string') throw new StatusError(`the account's settings are not right: ${settings}`, 400);
  if (!imap || !smtp) throw new StatusError('no password: add it on the accounts page', 401);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const m = imap;
  switch (cmd.t) {
    case 'mail.mailboxes':
      return m.read(() => m.mailboxes());
    case 'mail.list':
      return m.read(() => m.listMessages(cmd as any));
    case 'mail.get':
      return m.read(() => m.get(messageArg(cmd)));
    case 'mail.attachment':
      return m.read(() => m.attachment(messageArg(cmd), String(cmd.attachmentId)));
    case 'mail.raw':
      return m.read(() => m.raw(messageArg(cmd)));
    case 'mail.search':
      return m.read(() => m.search({ query: String(cmd.query ?? ''), mailboxId: str(cmd.mailboxId), limit: cmd.limit as number | undefined }));
    case 'mail.changes':
      return m.read(() => m.changes({ mailboxId: String(cmd.mailboxId), state: str(cmd.state), limit: cmd.limit as number | undefined }));
    case 'mail.flag':
      return imap.flag(cmd as any);
    case 'mail.move':
      return imap.move(cmd as any);
    case 'mail.trash':
      return imap.trash(cmd as any);
    case 'mail.send': {
      const { t: _t, id: _id, ...mail } = cmd;
      return smtp.send(mail as any, link.accountDir);
    }
    default:
      throw new StatusError(`imap has no operation "${cmd.t}"`, 400);
  }
}
