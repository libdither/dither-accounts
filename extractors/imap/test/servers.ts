/**
 * Real servers for the imap extractor's tests and scripts/verify-imap.ts, all on 127.0.0.1 in a temp directory:
 *
 *   - Dovecot 2.4 from nix (`nix build nixpkgs#dovecot`, or DOVECOT_BIN), unprivileged, with a passwd-file of users,
 *     a self-signed certificate (CA:FALSE, as Proton Bridge's), IMAP with STARTTLS and IMAPS, SPECIAL-USE mailboxes,
 *     and CONDSTORE/QRESYNC that can be switched off. It restarts on the same mail with another config or certificate.
 *   - An SMTP sink (smtp-server) that wants STARTTLS and a password, records what it got, and delivers it into each
 *     local recipient's Dovecot INBOX by IMAP APPEND.
 *
 * Nothing here reaches beyond this machine, and no real account is involved.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { SMTPServer } from 'smtp-server';

export interface User {
  email: string;
  password: string;
}

let binCache: string | null = null;
/**
 * Dovecot's binary: DOVECOT_BIN, or nixpkgs' through `nix build` (offline first: once the flake registry's nixpkgs is
 * an hour old, an online build fetches it again, which can take minutes). The store path is remembered in tmp.
 */
export function dovecotBin(): string {
  if (process.env.DOVECOT_BIN) return process.env.DOVECOT_BIN;
  if (binCache) return binCache;
  const memo = join(tmpdir(), 'dacc-imap-dovecot-bin');
  try {
    const p = readFileSync(memo, 'utf8').trim();
    if (p && existsSync(p)) return (binCache = p);
  } catch {}
  let err = '';
  for (const extra of [['--offline'], []]) {
    const r = Bun.spawnSync(['nix', 'build', ...extra, '--no-link', '--print-out-paths', 'nixpkgs#dovecot'], { stdout: 'pipe', stderr: 'pipe' });
    const out = r.stdout.toString().trim().split('\n').pop();
    if (r.exitCode === 0 && out && existsSync(join(out, 'bin/dovecot'))) {
      binCache = join(out, 'bin/dovecot');
      writeFileSync(memo, binCache);
      return binCache;
    }
    err = r.stderr.toString().slice(-500);
  }
  throw new Error(`nix build nixpkgs#dovecot failed: ${err}`);
}

function openssl(): string[] {
  const r = Bun.spawnSync(['sh', '-c', 'command -v openssl'], { stdout: 'pipe' });
  return r.exitCode === 0 ? [r.stdout.toString().trim()] : ['nix', 'shell', 'nixpkgs#openssl', '-c', 'openssl'];
}

/** A self-signed certificate for 127.0.0.1 and localhost; its SHA-256 fingerprint as Node prints it. */
export function makeCert(dir: string, name: string): { cert: string; key: string; fingerprint: string } {
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  const r = Bun.spawnSync(
    [
      ...openssl(),
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
      '-keyout', key, '-out', cert, '-subj', `/CN=127.0.0.1/O=dacc-test-${name}`,
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (r.exitCode !== 0) throw new Error(`openssl: ${r.stderr.toString().slice(-400)}`);
  const fp = Bun.spawnSync([...openssl(), 'x509', '-in', cert, '-noout', '-fingerprint', '-sha256'], { stdout: 'pipe' }).stdout.toString();
  return { cert, key, fingerprint: fp.split('=')[1].trim().toUpperCase() };
}

/** A CA of the test's own, and a certificate for localhost (only: not 127.0.0.1) signed by it (for `verify`, with NODE_EXTRA_CA_CERTS). */
export function makeCaSigned(dir: string, name: string): { cert: string; key: string; fingerprint: string; ca: string } {
  const ca = join(dir, `${name}-ca.crt`);
  const caKey = join(dir, `${name}-ca.key`);
  const csr = join(dir, `${name}.csr`);
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  const ext = join(dir, `${name}.ext`);
  writeFileSync(ext, 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
  const run = (args: string[]) => {
    const r = Bun.spawnSync([...openssl(), ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString().slice(-400)}`);
    return r.stdout.toString();
  };
  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-keyout', caKey, '-out', ca, '-subj', `/CN=dacc test CA ${name}`]);
  run(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
  run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '30', '-out', cert, '-extfile', ext]);
  const fp = run(['x509', '-in', cert, '-noout', '-fingerprint', '-sha256']);
  return { cert, key, ca, fingerprint: fp.split('=')[1].trim().toUpperCase() };
}

export interface DovecotOpts {
  imapPort: number;
  imapsPort?: number;
  users: User[];
  /** Advertise CONDSTORE and QRESYNC (default true). */
  condstore?: boolean;
  /** Advertise QRESYNC (default: as condstore). */
  qresync?: boolean;
  /** Advertise IDLE (default true). */
  idle?: boolean;
  /** Gmail's layout: a [Gmail]/All Mail with \\All (not virtual here: it holds what is put in it). */
  gmail?: boolean;
}

export class Dovecot {
  readonly dir: string;
  /** Unix sockets want a short path. */
  readonly run: string;
  proc: Subprocess | null = null;
  cert: { cert: string; key: string; fingerprint: string };
  private certN = 0;

  constructor(
    public opts: DovecotOpts,
    dir?: string,
  ) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), 'dacc-imap-dv-'));
    this.run = mkdtempSync('/tmp/dacc-dv-');
    mkdirSync(join(this.dir, 'mail'), { recursive: true });
    mkdirSync(join(this.dir, 'state'), { recursive: true });
    this.cert = makeCert(this.dir, `cert${this.certN}`);
  }

  /** Give it another certificate (applies on the next start). */
  newCert() {
    this.cert = makeCert(this.dir, `cert${++this.certN}`);
    return this.cert;
  }

  private config(): string {
    const me = userInfo();
    const group = Bun.spawnSync(['id', '-gn'], { stdout: 'pipe' }).stdout.toString().trim() || 'users';
    const o = this.opts;
    const condstore = o.condstore ?? true;
    const qresync = o.qresync ?? condstore;
    const caps = [!condstore && 'CONDSTORE', !qresync && 'QRESYNC', o.idle === false && 'IDLE'].filter(Boolean) as string[];
    writeFileSync(join(this.dir, 'passwd'), o.users.map((u) => `${u.email}:{PLAIN}${u.password}::::::`).join('\n') + '\n', { mode: 0o600 });
    return `dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
base_dir = ${this.run}
state_dir = ${this.dir}/state
log_path = ${this.dir}/dovecot.log
default_internal_user = ${me.username}
default_internal_group = ${group}
default_login_user = ${me.username}
protocols = imap
listen = 127.0.0.1
ssl = yes
ssl_server_cert_file = ${this.cert.cert}
ssl_server_key_file = ${this.cert.key}
auth_allow_cleartext = no
auth_failure_delay = 0
mail_driver = maildir
mail_path = ${this.dir}/mail/%{user}
mail_home = ${this.dir}/mail/%{user}
mail_uid = ${me.username}
mail_gid = ${group}
passdb passwd-file {
  passwd_file_path = ${this.dir}/passwd
}
userdb passwd-file {
  passwd_file_path = ${this.dir}/passwd
}
service imap-login {
  chroot =
  inet_listener imap {
    port = ${o.imapPort}
  }
  inet_listener imaps {
    port = ${o.imapsPort ?? 0}
    ssl = yes
  }
}
service anvil {
  chroot =
}
${caps.length ? `service imap {\n  imap_capability {\n${caps.map((c) => `    ${c} = no`).join('\n')}\n  }\n}\n` : ''}
namespace inbox {
  inbox = yes
  separator = /
  mailbox Sent {
    special_use = \\Sent
    auto = subscribe
  }
  mailbox Trash {
    special_use = \\Trash
    auto = subscribe
  }
  mailbox Drafts {
    special_use = \\Drafts
    auto = subscribe
  }
  mailbox Junk {
    special_use = \\Junk
    auto = subscribe
  }
  mailbox Archive {
    special_use = \\Archive
    auto = subscribe
  }
${this.opts.gmail ? '  mailbox "[Gmail]/All Mail" {\n    special_use = \\All\n    auto = subscribe\n  }\n' : ''}}
`;
  }

  async start() {
    if (this.proc && this.proc.exitCode === null) return;
    await waitPort(this.opts.imapPort, false, 5000, () => `port ${this.opts.imapPort} is already in use`);
    const conf = join(this.dir, 'dovecot.conf');
    writeFileSync(conf, this.config());
    this.proc = Bun.spawn([dovecotBin(), '-F', '-c', conf], { stdout: 'ignore', stderr: Bun.file(join(this.dir, 'dovecot.stderr')) });
    await waitPort(this.opts.imapPort, true, 20_000, () => `dovecot did not start: ${tail(join(this.dir, 'dovecot.log'))} ${tail(join(this.dir, 'dovecot.stderr'))}`);
  }

  async stop() {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    // Its imap processes outlive the master (and keep their clients' sessions): a server that goes away takes them.
    const kids = descendants(p.pid);
    p.kill('SIGTERM');
    const killer = setTimeout(() => p.kill('SIGKILL'), 8000);
    await p.exited;
    clearTimeout(killer);
    for (const k of kids) {
      try {
        process.kill(k, 'SIGKILL');
      } catch {}
    }
    await waitPort(this.opts.imapPort, false, 10_000, () => 'dovecot did not stop');
  }

  async restart(opts: Partial<DovecotOpts> = {}) {
    await this.stop();
    this.opts = { ...this.opts, ...opts };
    await this.start();
  }

  /** A client of the test's own (another mail program), held to this server's certificate. */
  async client(user: User): Promise<ImapFlow> {
    const c = new ImapFlow({
      host: '127.0.0.1',
      port: this.opts.imapPort,
      secure: false,
      doSTARTTLS: true,
      auth: { user: user.email, pass: user.password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    c.on('error', () => {});
    await c.connect();
    return c;
  }

  async cleanup() {
    await this.stop();
    rmSync(this.run, { recursive: true, force: true });
    if (!process.env.KEEP_IMAP_TEST) rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface Received {
  from: string;
  to: string[];
  user: string;
  raw: Buffer;
}

/** The SMTP sink: STARTTLS and a password required; delivers to local users by IMAP APPEND. */
export class SmtpSink {
  received: Received[] = [];
  private server: SMTPServer;
  constructor(
    readonly port: number,
    private users: User[],
    private dovecot: Dovecot,
    cert: { cert: string; key: string },
  ) {
    this.server = new SMTPServer({
      secure: false,
      key: readFileSync(cert.key),
      cert: readFileSync(cert.cert),
      authOptional: false,
      allowInsecureAuth: false,
      authMethods: ['PLAIN', 'LOGIN'],
      size: 60 * 1024 * 1024,
      logger: false,
      onAuth: (auth, _session, cb) => {
        const u = this.users.find((x) => x.email === auth.username && x.password === auth.password);
        u ? cb(null, { user: u.email }) : cb(new Error('Invalid username or password'));
      },
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', async () => {
          const raw = Buffer.concat(chunks);
          const rec: Received = { from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), user: String(session.user), raw };
          this.received.push(rec);
          try {
            for (const to of rec.to) {
              const u = this.users.find((x) => x.email === to);
              if (!u) continue;
              const c = await this.dovecot.client(u);
              await c.append('INBOX', raw);
              await c.logout();
            }
            cb();
          } catch (e) {
            cb(e as Error);
          }
        });
      },
    });
    this.server.on('error', () => {});
  }
  start() {
    return new Promise<void>((res) => this.server.listen(this.port, '127.0.0.1', () => res()));
  }
  stop() {
    return new Promise<void>((res) => this.server.close(() => res()));
  }
}

/** Every process under pid, from /proc. */
function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(Number(d));
    } catch {}
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(pid);
  return out;
}

function tail(f: string) {
  try {
    return existsSync(f) ? readFileSync(f, 'utf8').slice(-600) : '';
  } catch {
    return '';
  }
}

export async function waitPort(port: number, open: boolean, ms: number, why: () => string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const up = await new Promise<boolean>((res) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        res(true);
      });
      s.once('error', () => res(false));
    });
    if (up === open) return;
    await Bun.sleep(100);
  }
  throw new Error(why());
}

/** A message as a mail program would write it. */
export function rfc822(o: {
  from?: string;
  to?: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  date?: Date;
  references?: string;
  inReplyTo?: string;
  attachment?: { filename: string; mime: string; data: Buffer };
  charset?: string;
  /** More header lines as written (a value may hold CRLF + space, folded). */
  headers?: Record<string, string>;
}): Buffer {
  const head = [
    `From: ${o.from ?? 'Carol Sender <carol@example.test>'}`,
    `To: ${o.to ?? 'Alice <alice@example.test>'}`,
    `Subject: ${o.subject}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${o.messageId ?? `<${crypto.randomUUID()}@example.test>`}`,
    ...(o.references ? [`References: ${o.references}`] : []),
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
  ];
  const cs = o.charset ?? 'utf-8';
  const textPart = (t: string) => [`Content-Type: text/plain; charset=${cs}`, 'Content-Transfer-Encoding: 8bit', '', t].join('\r\n');
  const htmlPart = (h: string) => ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', h].join('\r\n');
  let body: string;
  let parts: string[] = [];
  if (o.text !== undefined && o.html !== undefined) parts = [['Content-Type: multipart/alternative; boundary="alt1"', '', '--alt1', textPart(o.text), '--alt1', htmlPart(o.html), '--alt1--'].join('\r\n')];
  else if (o.html !== undefined) parts = [htmlPart(o.html)];
  else parts = [textPart(o.text ?? '')];
  if (o.attachment) {
    const b64 = o.attachment.data.toString('base64').replace(/.{76}/g, '$&\r\n');
    const att = [`Content-Type: ${o.attachment.mime}; name="${o.attachment.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${o.attachment.filename}"`, '', b64].join('\r\n');
    body = ['Content-Type: multipart/mixed; boundary="mix1"', '', '--mix1', parts[0], '--mix1', att, '--mix1--', ''].join('\r\n');
  } else body = parts[0];
  const all = head.join('\r\n') + '\r\n' + body;
  return cs === 'utf-8' ? Buffer.from(all, 'utf8') : Buffer.from(all, 'latin1');
}
