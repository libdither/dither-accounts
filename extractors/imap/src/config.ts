/**
 * An imap account's settings: the add form's fields (config) over the provider's preset. Every server field is
 * optional: a preset fills what is left empty, and anything given overrides it (Proton Bridge on other ports, say).
 */

export type Security = 'tls' | 'starttls' | 'none';
export interface Endpoint {
  host: string;
  port: number;
  security: Security;
}
export type Provider = 'proton' | 'fastmail' | 'gmail' | 'icloud' | 'custom';
/** Who puts a copy of sent mail in Sent: the server (Gmail, Proton), us, or we look and append when it did not. */
export type SentCopy = 'server' | 'append' | 'detect';
/** How mail.changes keeps up: the best the server has, or a weaker way when its QRESYNC or CONDSTORE misbehave. */
export type SyncMode = 'auto' | 'condstore' | 'flags';

export interface Settings {
  provider: Provider;
  email: string;
  name: string | null;
  /** IMAP and SMTP login. */
  user: string;
  smtpUser: string;
  imap: Endpoint;
  smtp: Endpoint;
  /** verify: the system's CAs and the host name. pin: trust the certificate seen on first connect, and only it. */
  cert: { mode: 'verify' } | { mode: 'pin'; fingerprint: string | null };
  sentCopy: SentCopy;
  sync: SyncMode;
  /** Proton Mail through Proton Bridge: a "Proton Bridge running" layer first. */
  bridge: boolean;
}

interface Preset {
  name: string;
  imap: Endpoint | null;
  smtp: Endpoint | null;
  cert: 'verify' | 'pin';
  sentCopy: SentCopy;
  /** What the password is, for messages. */
  password: string;
}

export const PRESETS: Record<Provider, Preset> = {
  proton: {
    name: 'Proton Mail (Proton Bridge)',
    imap: { host: '127.0.0.1', port: 1143, security: 'starttls' },
    smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
    // Bridge makes its own self-signed certificate: pinned on first connect, refused if it ever changes.
    cert: 'pin',
    sentCopy: 'server',
    password: 'the password Proton Bridge shows for this address (not your Proton password)',
  },
  fastmail: {
    name: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    cert: 'verify',
    sentCopy: 'detect',
    password: 'a Fastmail app password with IMAP and SMTP access',
  },
  gmail: {
    name: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    cert: 'verify',
    sentCopy: 'server',
    password: 'a Google app password (needs 2-Step Verification)',
  },
  icloud: {
    name: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    cert: 'verify',
    sentCopy: 'detect',
    password: 'an app-specific password from your Apple Account',
  },
  custom: { name: 'IMAP', imap: null, smtp: null, cert: 'verify', sentCopy: 'detect', password: 'your password' },
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

/** A SHA-256 fingerprint as Node prints it (AB:CD:…), from any spelling with or without colons. */
export function normFingerprint(v: string): string | null {
  const hex = v.replace(/^sha-?256[:=\s]*/i, '').replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}

function endpoint(c: Record<string, unknown>, p: 'imap' | 'smtp', preset: Endpoint | null): Endpoint | string {
  const host = str(c[`${p}Host`]) ?? preset?.host ?? null;
  if (!host) return `${p.toUpperCase()} server is needed for a custom provider`;
  const sec = str(c[`${p}Security`])?.toLowerCase() ?? null;
  if (sec && !['tls', 'starttls', 'none'].includes(sec)) return `${p.toUpperCase()} security is tls, starttls or none`;
  const portRaw = str(c[`${p}Port`] == null ? null : String(c[`${p}Port`]));
  const port = portRaw ? Number(portRaw) : null;
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) return `${p.toUpperCase()} port is a number`;
  const security = (sec as Security | null) ?? (preset && (!port || port === preset.port) ? preset.security : port === 993 || port === 465 ? 'tls' : 'starttls');
  const dflt = p === 'imap' ? (security === 'tls' ? 993 : 143) : security === 'tls' ? 465 : 587;
  const out = { host, port: port ?? (preset && security === preset.security ? preset.port : dflt), security };
  // A password never crosses a network in the clear: no TLS only to this machine (a local bridge or test server).
  if (security === 'none' && !LOOPBACK.test(host)) return `${p.toUpperCase()} without TLS is only for this machine (127.0.0.1)`;
  return out;
}

export function settingsFrom(config: Record<string, unknown>): Settings | string {
  const provider = (str(config.provider)?.toLowerCase() ?? 'custom') as Provider;
  const preset = PRESETS[provider];
  if (!preset) return `provider is one of ${Object.keys(PRESETS).join(', ')}`;
  const email = str(config.email);
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return 'an email address is needed';
  const imap = endpoint(config, 'imap', preset.imap);
  if (typeof imap === 'string') return imap;
  const smtp = endpoint(config, 'smtp', preset.smtp);
  if (typeof smtp === 'string') return smtp;
  const certRaw = str(config.certificate)?.toLowerCase() ?? preset.cert;
  let cert: Settings['cert'];
  if (certRaw === 'verify') cert = { mode: 'verify' };
  else if (certRaw === 'pin') cert = { mode: 'pin', fingerprint: null };
  else {
    const fp = normFingerprint(certRaw);
    if (!fp) return 'certificate is verify, pin, or a SHA-256 fingerprint';
    cert = { mode: 'pin', fingerprint: fp };
  }
  const sentRaw = str(config.sentCopy)?.toLowerCase() ?? 'auto';
  const sentCopy = (sentRaw === 'auto' ? preset.sentCopy : sentRaw) as SentCopy;
  if (!['server', 'append', 'detect'].includes(sentCopy)) return 'sent copy is auto, append, server or detect';
  const sync = (str(config.sync)?.toLowerCase() ?? 'auto') as SyncMode;
  if (!['auto', 'condstore', 'flags'].includes(sync)) return 'sync is auto, condstore or flags';
  const user = str(config.username) ?? email;
  return {
    provider,
    email,
    name: str(config.name),
    user,
    smtpUser: str(config.smtpUsername) ?? user,
    imap,
    smtp,
    cert,
    sentCopy,
    sync,
    bridge: provider === 'proton',
  };
}

export const where = (e: Endpoint) => `${e.host}:${e.port}`;
