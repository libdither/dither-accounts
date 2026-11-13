/**
 * Certificates: verified against the system's CAs (the default), or pinned. A pinned server (Proton Bridge, with its
 * own self-signed certificate; a home server) is trusted for the one certificate seen on its first connect, kept in
 * the account directory's tls-pins.json, and refused once it offers another. Nothing here turns verification off for
 * anything but the one connection being checked, and that connection sends no password until the check passed.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import type { ImapTransport } from 'imapflow';
import { type Endpoint, normFingerprint, where } from './config.ts';

export interface CertInfo {
  fingerprint: string;
  subject: string | null;
  issuer: string | null;
  validTo: string | null;
}

export class CertError extends Error {
  constructor(
    message: string,
    /** What the server offers now, when we got to see it. */
    readonly offered: CertInfo | null,
    readonly kind: 'changed' | 'untrusted',
  ) {
    super(message);
  }
}

export function certInfo(c: tls.PeerCertificate | tls.DetailedPeerCertificate | null | undefined): CertInfo | null {
  if (!c || !c.fingerprint256) return null;
  const name = (x: any) => (x && typeof x === 'object' ? (x.CN ?? x.O ?? null) : null);
  return { fingerprint: normFingerprint(c.fingerprint256)!, subject: name(c.subject), issuer: name(c.issuer), validTo: c.valid_to ?? null };
}

/** Errors that mean the certificate did not verify (rather than the server not answering). */
export function isCertFailure(e: any): boolean {
  const code = String(e?.code ?? '');
  return (
    e instanceof CertError ||
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME|HOSTNAME_MISMATCH/.test(code) ||
    /certificate|self[- ]signed/i.test(String(e?.message ?? ''))
  );
}

const readLine = (sock: net.Socket, done: (line: string) => boolean, ms: number) =>
  new Promise<void>((res, rej) => {
    let buf = '';
    const t = setTimeout(() => fin(new Error('no answer')), ms);
    const fin = (e?: Error) => {
      clearTimeout(t);
      sock.off('data', onData);
      sock.off('error', fin);
      sock.off('close', onClose);
      e ? rej(e) : res();
    };
    const onClose = () => fin(new Error('closed'));
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (done(line)) return fin();
      }
    };
    sock.on('data', onData);
    sock.once('error', fin);
    sock.once('close', onClose);
  });

/**
 * The certificate a server offers, without trusting it and without sending anything but STARTTLS: for pinning on
 * first connect, and for saying what changed when a pin no longer matches.
 */
export async function probeCert(e: Endpoint, proto: 'imap' | 'smtp', ms = 10_000): Promise<CertInfo> {
  const servername = net.isIP(e.host) ? undefined : e.host;
  const handshake = (socket?: net.Socket) =>
    new Promise<CertInfo>((res, rej) => {
      const s = tls.connect({ ...(socket ? { socket } : { host: e.host, port: e.port }), servername, rejectUnauthorized: false }, () => {
        const info = certInfo(s.getPeerCertificate());
        s.destroy();
        info ? res(info) : rej(new Error('the server sent no certificate'));
      });
      s.setTimeout(ms, () => s.destroy(new Error('TLS handshake timed out')));
      s.once('error', rej);
    });
  if (e.security === 'tls') return handshake();
  if (e.security === 'none') throw new Error('no TLS here');
  const sock = net.connect({ host: e.host, port: e.port });
  try {
    await new Promise<void>((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
    });
    if (proto === 'imap') {
      await readLine(sock, (l) => l.startsWith('* '), ms);
      sock.write('p1 STARTTLS\r\n');
      let ok = false;
      await readLine(sock, (l) => (l.startsWith('p1 ') ? ((ok = /^p1 OK/i.test(l)), true) : false), ms);
      if (!ok) throw new Error('the server refused STARTTLS');
    } else {
      await readLine(sock, (l) => /^\d{3} /.test(l), ms);
      sock.write('EHLO dither-accounts\r\n');
      await readLine(sock, (l) => /^\d{3} /.test(l), ms);
      sock.write('STARTTLS\r\n');
      let ok = false;
      await readLine(sock, (l) => (/^\d{3} /.test(l) ? ((ok = l.startsWith('220')), true) : false), ms);
      if (!ok) throw new Error('the server refused STARTTLS');
    }
    return await handshake(sock);
  } finally {
    sock.destroy();
  }
}

export interface Pin extends CertInfo {
  pinnedAt: number;
}

/** tls-pins.json: endpoint → the certificate trusted there. Public facts (fingerprints), not secrets. */
export class Pins {
  private file: string;
  constructor(dir: string) {
    this.file = join(dir, 'tls-pins.json');
  }
  all(): Record<string, Pin> {
    try {
      return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    } catch {
      return {};
    }
  }
  get(key: string): Pin | null {
    return this.all()[key] ?? null;
  }
  set(key: string, pin: Pin) {
    const all = { ...this.all(), [key]: pin };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export const pinKey = (proto: 'imap' | 'smtp', e: Endpoint) => `${proto} ${where(e)}`;

export interface Trust {
  mode: 'verify' | 'pin';
  /** The fingerprint required (pin). */
  fingerprint: string | null;
  /** Pinned just now, on this first connect. */
  fresh: boolean;
}

/**
 * What a connection to this endpoint must see. Pinning on first connect: the certificate is fetched and kept, then
 * the real connection is held to it (so a server swapped between the two is still refused).
 */
export async function trustFor(
  pins: Pins,
  proto: 'imap' | 'smtp',
  e: Endpoint,
  cert: { mode: 'verify' } | { mode: 'pin'; fingerprint: string | null },
): Promise<Trust> {
  if (e.security === 'none' || cert.mode === 'verify') return { mode: 'verify', fingerprint: null, fresh: false };
  const key = pinKey(proto, e);
  const have = pins.get(key);
  // A fingerprint in the config is the one to hold to; it replaces an older pin (that is how a pin is renewed).
  if (cert.fingerprint) {
    if (have?.fingerprint !== cert.fingerprint) {
      const seen = await probeCert(e, proto).catch(() => null);
      if (seen?.fingerprint === cert.fingerprint) pins.set(key, { ...seen, pinnedAt: Date.now() });
    }
    return { mode: 'pin', fingerprint: cert.fingerprint, fresh: false };
  }
  if (have) return { mode: 'pin', fingerprint: have.fingerprint, fresh: false };
  const seen = await probeCert(e, proto);
  pins.set(key, { ...seen, pinnedAt: Date.now() });
  return { mode: 'pin', fingerprint: seen.fingerprint, fresh: true };
}

/** Check a finished handshake against a pin; the socket is destroyed with a CertError when it does not match. */
function holdTo(s: tls.TLSSocket, fp: string, label: string, seen: (c: CertInfo | null) => void, go: () => void) {
  const c = certInfo(s.getPeerCertificate());
  seen(c);
  if (!c || c.fingerprint !== fp) {
    s.destroy(new CertError(`${label} offers a different certificate than the one pinned (pinned ${short(fp)}, now ${c ? short(c.fingerprint) : 'none'})`, c, 'changed'));
    return;
  }
  go();
}
export const short = (fp: string) => fp.split(':').slice(0, 6).join(':') + '…';

/**
 * An imapflow transport whose TLS (direct or after STARTTLS) is held to a pinned fingerprint before imapflow sees the
 * socket, so LOGIN never goes to a server with another certificate. Verified connections use it too, only to see the
 * certificate for the account's details.
 */
export function imapTransport(trust: Trust, label: string, seen: (c: CertInfo | null) => void): ImapTransport {
  const opts = (o: { host: string; servername?: string }) => ({
    host: o.host,
    ...(o.servername ? { servername: o.servername } : {}),
    // Only for a pinned server, whose certificate is checked right after the handshake instead.
    rejectUnauthorized: trust.mode !== 'pin',
  });
  const after = (s: tls.TLSSocket, go: () => void) => {
    if (trust.mode === 'pin') return holdTo(s, trust.fingerprint!, label, seen, go);
    seen(certInfo(s.getPeerCertificate()));
    go();
  };
  return {
    connect(o, onConnect) {
      if (!o.secure) return net.connect({ host: o.host, port: o.port }, onConnect);
      const s: tls.TLSSocket = tls.connect({ ...opts(o), port: o.port }, () => after(s, onConnect));
      return s;
    },
    upgrade(socket, o, onSecure) {
      const s: tls.TLSSocket = tls.connect({ ...opts(o), socket: socket as net.Socket }, () => after(s, onSecure));
      return s;
    },
  };
}

/** Hold an SMTP connection's socket (after nodemailer's TLS) to a pin; throws CertError when it does not match. */
export function checkSocket(sock: unknown, trust: Trust, label: string): CertInfo | null {
  const s = sock as tls.TLSSocket | undefined;
  const c = typeof s?.getPeerCertificate === 'function' ? certInfo(s.getPeerCertificate()) : null;
  if (trust.mode === 'pin' && (!c || c.fingerprint !== trust.fingerprint)) {
    throw new CertError(`${label} offers a different certificate than the one pinned (pinned ${short(trust.fingerprint!)}, now ${c ? short(c.fingerprint) : 'none'})`, c, 'changed');
  }
  return c;
}
