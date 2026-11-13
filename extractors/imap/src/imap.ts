/**
 * One IMAP mailbox: a connection for operations (opened on demand, opened again after it drops) and one that keeps
 * the inbox selected in IDLE for mail.arrived and mail.changed (reconnected with backoff). Each knows its dependency
 * chain as layers: [Proton Bridge running →] server → TLS → signed in → inbox → IDLE (→ SMTP, from smtp.ts).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import type { MailAddress, MailAttachment, MailboxRole, MailBulk, MailChanges, MailFlags, MailMessage, MailSummary, Mailbox } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import { convert as htmlToText } from 'html-to-text';
import { type FetchMessageObject, type FetchQueryObject, ImapFlow, type ListResponse, type MailboxObject, type MessageAddressObject, type MessageStructureObject } from 'imapflow';
import { type Endpoint, type Settings, where } from './config.ts';
import { formatState, mailboxId, mailboxPath, messageId, parseCursor, parseMessageId, parseState, type StateMode, toRanges } from './ids.ts';
import { Snapshots } from './snapshots.ts';
import { type CertInfo, CertError, imapTransport, isCertFailure, Pins, probeCert, short, type Trust, trustFor } from './tls.ts';

export type LayerState = 'ok' | 'waiting' | 'failed' | 'off';
export interface Layer {
  name: string;
  state: LayerState;
  note?: string;
}

export interface Hooks {
  /** Something in the status changed (layers, problem, details). */
  changed(): void;
  emit(ev: { t: string; [k: string]: unknown }): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
}

/** Why it stopped trying until it is restarted (a new password, a pin renewed): retrying would not help. */
export interface Problem {
  kind: 'login' | 'certificate';
  message: string;
  layer: string;
  offered?: CertInfo | null;
}

export const ATTACHMENT_CAP = 25 * 1024 * 1024;
/** mail.raw's cap: a whole message, attachments and all. */
export const RAW_CAP = 50 * 1024 * 1024;
/** Text and HTML bodies are cut here: anything longer is not a message to read. */
const BODY_CAP = 5 * 1024 * 1024;
const BACKOFF = [1, 2, 5, 10, 30, 60];
/** Messages that arrived while the extractor was down, announced on start. */
const CATCH_UP = 20;

/**
 * Threading and bulk headers ride along in the same FETCH: BODY.PEEK[HEADER.FIELDS (…)], a few lines per message, and
 * never \Seen. In-Reply-To is in ENVELOPE already.
 */
const HEADER_FIELDS = ['REFERENCES', 'LIST-ID', 'LIST-UNSUBSCRIBE', 'PRECEDENCE', 'AUTO-SUBMITTED'];
const SUMMARY: FetchQueryObject = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, threadId: true, emailId: true, labels: true, headers: HEADER_FIELDS };
const ROLES: Record<string, MailboxRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  '\\Important': 'important',
};
/** Keywords that are bookkeeping, not labels. */
const HIDDEN_KEYWORDS = new Set(['\\Recent', '\\Deleted', '$HasAttachment', '$HasNoAttachment']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONN_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|CONNECT_TIMEOUT|GREETING_TIMEOUT|UPGRADE_TIMEOUT|ETIMEOUT|NoConnection|EConnectionClosed|ClosedAfterConnect\w*)$/;
const isConnFailure = (e: any) => CONN_CODES.test(String(e?.code ?? '')) || /connection (closed|refused|not available)|not connected|socket/i.test(String(e?.message ?? ''));
const isAuthFailure = (e: any) => !!e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED' || /AUTHENTICATIONFAILED|invalid credentials|authentication failed/i.test(String(e?.responseText ?? e?.message ?? ''));
const errText = (e: any) => String(e?.responseText || e?.message || e).slice(0, 300);

export class Imap {
  readonly pins: Pins;
  readonly snaps: Snapshots;
  problem: Problem | null = null;
  capabilities: string[] = [];
  cert: CertInfo | null = null;
  trust: Trust | null = null;
  inbox: { messages: number; unseen: number } | null = null;
  mailboxCount: number | null = null;
  lastError: string | null = null;
  private layerMap = new Map<string, Layer>();
  private ops: ImapFlow | null = null;
  private opsP: Promise<ImapFlow> | null = null;
  private watch: ImapFlow | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private boxes: ListResponse[] | null = null;
  private changeTimers = new Map<string, Timer>();
  private watchQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly s: Settings,
    private pass: () => string,
    private dir: string,
    private hooks: Hooks,
  ) {
    this.pins = new Pins(dir);
    this.snaps = new Snapshots(dir);
    const names = [...(s.bridge ? ['Proton Bridge running'] : []), 'server', 'TLS', 'signed in', 'inbox', 'IDLE', 'SMTP'];
    for (const n of names) this.layerMap.set(n, { name: n, state: 'waiting' });
    if (s.imap.security === 'none') this.layer('TLS', 'off', 'no TLS (this machine only)');
  }

  layers(): Layer[] {
    return [...this.layerMap.values()];
  }
  layer(name: string, state: LayerState, note?: string) {
    const l = this.layerMap.get(name);
    if (!l) return;
    if (l.state === state && l.note === note) return;
    l.state = state;
    l.note = note;
    this.hooks.changed();
  }
  /** Every layer from `name` on is waiting on it. */
  private waitFrom(name: string, note?: string) {
    let on = false;
    for (const l of this.layerMap.values()) {
      if (l.name === name) on = true;
      else if (on && l.name !== 'SMTP' && l.state !== 'off') this.layer(l.name, 'waiting', note);
    }
  }

  get syncMode(): StateMode | null {
    const c = this.ops ?? this.watch;
    return c ? this.modeOf(c) : null;
  }

  // ------------------------------------------------------------------ connections

  start() {
    void this.watchLoop();
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    for (const t of this.changeTimers.values()) clearTimeout(t);
    await Promise.all([this.ops, this.watch].map((c) => c?.logout().catch(() => c.close())));
  }

  /** The operations connection, opened now if it is not open. */
  async client(): Promise<ImapFlow> {
    if (this.ops?.usable) return this.ops;
    this.opsP ??= this.open('ops')
      .then((c) => {
        this.ops = c;
        c.on('close', () => {
          if (this.ops === c) this.ops = null;
        });
        return c;
      })
      .finally(() => {
        this.opsP = null;
      });
    return this.opsP;
  }

  private async open(purpose: 'ops' | 'watch'): Promise<ImapFlow> {
    if (this.problem) throw new StatusError(this.problem.message, this.problem.kind === 'login' ? 401 : 495);
    const e = this.s.imap;
    const at = where(e);
    if (this.s.bridge) {
      const up = await tcpCheck(e);
      if (up !== true) {
        this.layer('Proton Bridge running', 'failed', `nothing answers on ${at} (${up}): start Proton Bridge and sign in there`);
        this.waitFrom('Proton Bridge running', 'waiting for Proton Bridge');
        throw new StatusError(`Proton Bridge is not running (nothing answers on ${at})`, 503);
      }
      this.layer('Proton Bridge running', 'ok', `answering on ${at}`);
    }
    let trust: Trust;
    try {
      trust = await trustFor(this.pins, 'imap', e, this.s.cert);
    } catch (err) {
      // Pinning on first connect needs to see the certificate: the server did not answer.
      this.layer('server', 'failed', `${at}: ${errText(err)}`);
      this.waitFrom('server');
      throw new StatusError(`the mail server at ${at} is not reachable: ${errText(err)}`, 503);
    }
    this.trust = trust;
    const client = new ImapFlow({
      host: e.host,
      port: e.port,
      secure: e.security === 'tls',
      doSTARTTLS: e.security === 'starttls' ? true : e.security === 'none' ? false : undefined,
      auth: { user: this.s.user, pass: this.pass() },
      ...(e.security === 'none' ? {} : { transport: imapTransport(trust, at, (c) => (this.cert = c)) }),
      logger: false,
      qresync: this.s.sync === 'auto',
      disableAutoIdle: purpose === 'ops',
      // Back in IDLE right after each command, or the server's news waits for the next one.
      autoIdleDelay: 250,
      maxIdleTime: 5 * 60_000,
      missingIdleCommand: 'NOOP',
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      clientInfo: { name: 'dither-accounts' },
    });
    // imapflow reports a dropped connection as an error event too; the close handler does the work.
    client.on('error', (err: unknown) => this.hooks.log('debug', `imap ${purpose}: ${errText(err)}`));
    try {
      await client.connect();
    } catch (err: any) {
      client.close();
      throw await this.connectFailed(err, at, trust);
    }
    this.capabilities = [...client.capabilities.keys()];
    this.layer('server', 'ok', at);
    if (e.security !== 'none') {
      const c = this.cert;
      this.layer('TLS', 'ok', trust.mode === 'pin' ? `${trust.fresh ? 'pinned on first connect' : 'pinned'}: SHA-256 ${short(trust.fingerprint!)}` : `verified${c?.issuer ? ` (issued by ${c.issuer})` : ''}`);
    }
    this.layer('signed in', 'ok', `as ${this.s.user}`);
    this.lastError = null;
    return client;
  }

  /** Why a connect failed, in the layers, and as the error for the call. */
  private async connectFailed(err: any, at: string, trust: Trust): Promise<Error> {
    this.lastError = errText(err);
    if (isAuthFailure(err)) {
      const message = `${at} refused the password for ${this.s.user}${this.s.bridge ? ' (use the password Proton Bridge shows for this address)' : ''}: replace it on the accounts page`;
      this.problem = { kind: 'login', message, layer: 'signed in' };
      this.layer('server', 'ok', at);
      if (this.s.imap.security !== 'none') this.layer('TLS', 'ok', trust.mode === 'pin' ? `pinned: SHA-256 ${short(trust.fingerprint!)}` : 'verified');
      this.layer('signed in', 'failed', 'the server refused the password');
      this.waitFrom('signed in', 'not signed in');
      this.hooks.log('warn', `imap: ${at} refused the password`);
      return new StatusError(message, 401);
    }
    if (err instanceof CertError || isCertFailure(err) || err?.tlsFailed) {
      const offered: CertInfo | null = err instanceof CertError ? err.offered : await probeCert(this.s.imap, 'imap').catch(() => null);
      // Pinned: only another certificate stops it (a handshake cut short is retried). Verified: one that does not verify.
      const refused = trust.mode === 'pin' ? !!offered && offered.fingerprint !== trust.fingerprint : isCertFailure(err);
      if (!refused) {
        this.layer('server', 'ok', at);
        this.layer('TLS', 'failed', errText(err));
        this.waitFrom('TLS');
        return new StatusError(`TLS with ${at} failed: ${errText(err)}`, 503);
      }
      const fp = offered ? `SHA-256 ${offered.fingerprint}` : 'unknown';
      const message =
        trust.mode === 'pin'
          ? `${at} now offers a certificate other than the one pinned (pinned ${short(trust.fingerprint!)}, offered ${fp}). If you reinstalled Proton Bridge or replaced the certificate yourself, trust the new one: delete tls-pins.json in the account's directory (it pins the new one within seconds), or set its certificate to that fingerprint.`
          : `${at}'s certificate does not verify (${errText(err)}; it offers ${fp}). For a server with its own certificate, set the account's certificate to pin (or to that fingerprint).`;
      this.problem = { kind: 'certificate', message, layer: 'TLS', offered };
      this.layer('server', 'ok', at);
      this.layer('TLS', 'failed', trust.mode === 'pin' ? `certificate changed: now ${offered ? short(offered.fingerprint) : 'unknown'}` : 'certificate not trusted');
      this.waitFrom('TLS', 'TLS refused');
      this.hooks.log('warn', `imap: ${at} certificate refused`, { offered: offered?.fingerprint ?? null, pinned: trust.fingerprint });
      return new StatusError(message, 495);
    }
    if (isConnFailure(err) || !err?.responseStatus) {
      this.layer('server', 'failed', `${at}: ${errText(err)}`);
      this.waitFrom('server');
      return new StatusError(`the mail server at ${at} is not reachable: ${errText(err)}`, 503);
    }
    this.layer('signed in', 'failed', errText(err));
    this.waitFrom('signed in');
    return new StatusError(`${at}: ${errText(err)}`, 502);
  }

  /** Try again now (after a restart of the server, say): the watcher's backoff is cut short. */
  poke() {
    this.wake?.();
  }

  /**
   * What stopped it is gone (a new password in secret.json, a pin removed): sign in again. The watcher stopped
   * when the problem came, so it starts again here.
   */
  retry() {
    if (!this.problem) return this.poke();
    this.problem = null;
    this.lastError = null;
    this.waitFrom('server', 'trying again');
    this.layer('server', 'waiting', 'trying again');
    if (!this.watching) void this.watchLoop();
  }
  private watching = false;

  private async watchLoop() {
    if (this.watching) return;
    this.watching = true;
    try {
      await this.watchLoopInner();
    } finally {
      this.watching = false;
    }
  }
  private async watchLoopInner() {
    let attempt = 0;
    while (!this.stopped && !this.problem) {
      let ran = false;
      try {
        const c = await this.open('watch');
        this.watch = c;
        ran = true;
        await this.watchInbox(c);
      } catch (err: any) {
        if (!(err instanceof StatusError)) {
          this.lastError = errText(err);
          this.hooks.log('warn', `imap watch: ${errText(err)}`);
        }
      }
      this.watch = null;
      if (this.stopped || this.problem) break;
      if (ran && Date.now() - this.watchSince > 60_000) attempt = 0;
      const delay = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
      this.layer('IDLE', 'waiting', `reconnecting in ${delay} s`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay * 1000);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wake = null;
    }
  }
  private watchSince = 0;

  /** Keep the inbox selected in IDLE until the connection closes. */
  private async watchInbox(c: ImapFlow) {
    const closed = new Promise<void>((r) => c.once('close', () => r()));
    let box: MailboxObject;
    try {
      // Counts from STATUS (SELECT's UNSEEN is the first unseen message's number, not how many).
      const st = await c.status('INBOX', { messages: true, unseen: true });
      if (st) this.inbox = { messages: st.messages ?? 0, unseen: st.unseen ?? 0 };
      box = await c.mailboxOpen('INBOX');
    } catch (err) {
      this.layer('inbox', 'failed', errText(err));
      throw err;
    }
    this.watchSince = Date.now();
    const uv = String(box.uidValidity);
    this.layer('inbox', 'ok', `${box.exists} messages`);
    // Messages that came while nobody watched: announced once (the newest few), then followed from here.
    const saved = this.watchState();
    let next = box.uidNext;
    if (saved && saved.uidValidity === uv && saved.uidNext < box.uidNext) next = saved.uidNext;
    else this.saveWatchState(uv, box.uidNext);
    const arrived = async () => {
      const from = next;
      const got: FetchMessageObject[] = [];
      for await (const m of c.fetch(`${from}:*`, SUMMARY, { uid: true })) if (m.uid >= from) got.push(m);
      got.sort((a, b) => a.uid - b.uid);
      if (got.length) next = got[got.length - 1].uid + 1;
      else next = Math.max(next, (c.mailbox as MailboxObject).uidNext ?? next);
      this.saveWatchState(uv, next);
      for (const m of got.slice(-CATCH_UP)) this.hooks.emit({ t: 'mail.arrived', message: summary(m, 'INBOX', uv) });
      if (got.length) this.changedSoon('INBOX');
    };
    const queue = (f: () => Promise<unknown>) => {
      this.watchQueue = this.watchQueue.then(f).catch((err) => this.hooks.log('warn', `imap watch: ${errText(err)}`));
    };
    if (next < box.uidNext) queue(arrived);
    c.on('exists', () => queue(arrived));
    c.on('expunge', () => this.changedSoon('INBOX'));
    c.on('flags', () => this.changedSoon('INBOX'));
    const idle = c.capabilities.has('IDLE');
    this.layer('IDLE', 'ok', idle ? 'watching INBOX' : 'the server has no IDLE: checking INBOX every few minutes');
    this.hooks.changed();
    await closed;
    this.layer('IDLE', 'waiting', 'the connection closed');
  }

  private watchState(): { uidValidity: string; uidNext: number } | null {
    try {
      const f = join(this.dir, 'watch.json');
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    } catch {
      return null;
    }
  }
  private saveWatchState(uidValidity: string, uidNext: number) {
    const f = join(this.dir, 'watch.json');
    writeFileSync(`${f}.tmp`, JSON.stringify({ uidValidity, uidNext }), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }

  /** A mailbox changed: say so with its new state, once things settle. */
  changedSoon(path: string, ms = 300) {
    clearTimeout(this.changeTimers.get(path));
    this.changeTimers.set(
      path,
      setTimeout(async () => {
        this.changeTimers.delete(path);
        if (this.stopped) return;
        try {
          const state = await this.withBox(path, (c, box) => this.stateNow(c, box, path));
          this.hooks.emit({ t: 'mail.changed', mailboxId: mailboxId(path), state });
          if (path === 'INBOX') {
            const st = await (await this.client()).status('INBOX', { messages: true, unseen: true });
            if (st) this.inbox = { messages: st.messages ?? 0, unseen: st.unseen ?? 0 };
            if (this.inbox) this.layer('inbox', 'ok', `${this.inbox.messages} messages`);
            this.hooks.changed();
          }
        } catch (err) {
          this.hooks.log('warn', `mail.changed for a mailbox: ${errText(err)}`);
        }
      }, ms),
    );
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Run with a mailbox selected (selected again, so its counts and UIDNEXT are fresh). Errors become calls' errors:
   * 404 for a mailbox that is not there, 503 when the connection dropped.
   */
  async withBox<T>(path: string, f: (c: ImapFlow, box: MailboxObject) => Promise<T>): Promise<T> {
    const c = await this.client();
    const was = c.mailbox;
    let lock;
    try {
      lock = await c.getMailboxLock(path);
    } catch (err: any) {
      throw this.callError(err, c, `mailbox ${path}`);
    }
    try {
      // The lock selects it when another was selected (a new mailbox object); otherwise select it again, for fresh
      // counts, UIDNEXT and HIGHESTMODSEQ.
      const box = c.mailbox && c.mailbox !== was ? (c.mailbox as MailboxObject) : await c.mailboxOpen(path);
      return await f(c, box);
    } catch (err: any) {
      throw this.callError(err, c, `mailbox ${path}`);
    } finally {
      lock.release();
    }
  }

  /** A read, tried once more on a fresh connection when the one it ran on had dropped (servers close idle ones). */
  async read<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (err: any) {
      if (!err?.dropped) throw err;
      return f();
    }
  }

  private callError(err: any, c: ImapFlow, what: string): Error {
    if (err instanceof StatusError) return err;
    if (err?.mailboxMissing || /NONEXISTENT|doesn't exist|does not exist|no such mailbox|unknown mailbox/i.test(errText(err))) return new StatusError(`no such ${what}`, 404);
    if (!c.usable || isConnFailure(err)) {
      if (this.ops === c) this.ops = null;
      return Object.assign(new StatusError(`the connection to the mail server dropped: ${errText(err)}`, 503), { dropped: true });
    }
    return new StatusError(`the mail server said: ${errText(err)}`, 502);
  }

  private modeOf(c: ImapFlow, box?: MailboxObject): StateMode {
    if (this.s.sync === 'flags' || box?.noModseq || (box && !box.highestModseq)) return 'f';
    if (this.s.sync === 'auto' && c.enabled.has('QRESYNC')) return 'q';
    if (c.enabled.has('CONDSTORE')) return 'c';
    return 'f';
  }

  async list(): Promise<ListResponse[]> {
    const c = await this.client();
    try {
      this.boxes = await c.list({ statusQuery: { messages: true, unseen: true } });
    } catch (err) {
      throw this.callError(err, c, 'mailbox list');
    }
    this.mailboxCount = this.boxes.length;
    return this.boxes;
  }

  async pathOfRole(role: MailboxRole): Promise<string | null> {
    const find = (l: ListResponse[] | null) => l?.find((b) => roleOf(b) === role)?.path ?? null;
    return find(this.boxes) ?? find(await this.list());
  }

  private checkUv(box: MailboxObject, uidValidity: string) {
    if (String(box.uidValidity) !== uidValidity) throw new StatusError('the mailbox was rebuilt (its UIDVALIDITY changed): list it again', 410);
  }

  async summaries(c: ImapFlow, path: string, uv: string, uids: number[]): Promise<MailSummary[]> {
    if (!uids.length) return [];
    const out: MailSummary[] = [];
    for await (const m of c.fetch(toRanges([...uids].sort((a, b) => a - b)), SUMMARY, { uid: true })) out.push(summary(m, path, uv));
    return out;
  }

  /** The current state of a selected mailbox, for mail.changes (and the snapshot it needs, kept). */
  async stateNow(c: ImapFlow, box: MailboxObject, path: string): Promise<string> {
    const uv = String(box.uidValidity);
    const mode = this.modeOf(c, box);
    if (mode === 'q') return formatState({ mode, uidValidity: uv, modseq: String(box.highestModseq), rest: String(box.uidNext) });
    if (mode === 'c') {
      const uids = await allUids(c, box);
      return formatState({ mode, uidValidity: uv, modseq: String(box.highestModseq), rest: this.snaps.save(path, uv, { uids, flags: null }) });
    }
    const flags = await allFlags(c, box);
    return formatState({ mode, uidValidity: uv, modseq: '0', rest: this.snaps.save(path, uv, { uids: [...flags.keys()].sort((a, b) => a - b), flags }) });
  }

  // ------------------------------------------------------------------ operations

  async mailboxes(): Promise<{ mailboxes: Mailbox[] }> {
    const l = await this.list();
    return {
      mailboxes: l.map((b) => ({
        id: mailboxId(b.path),
        name: b.name,
        path: b.path,
        parentId: b.parentPath ? mailboxId(b.parentPath) : null,
        role: roleOf(b),
        unread: b.status?.unseen ?? null,
        total: b.status?.messages ?? null,
      })),
    };
  }

  async listMessages(input: { mailboxId: string; limit?: number; before?: string; since?: number }): Promise<{ messages: MailSummary[]; next: string | null }> {
    const path = mailboxPath(input.mailboxId);
    const limit = clamp(input.limit, 50, 1, 500);
    return this.withBox(path, async (c, box) => {
      const uv = String(box.uidValidity);
      let before = Infinity;
      if (input.before) {
        const cur = parseCursor(input.before);
        if (cur.uidValidity !== uv) throw new StatusError('the mailbox was rebuilt (its UIDVALIDITY changed): list it again', 410);
        before = cur.uid;
      }
      if (before <= 1 || !box.exists) return { messages: [], next: null };
      let page: FetchMessageObject[] = [];
      let more = false;
      const fetchSeq = async (from: number, to: number) => {
        const out: FetchMessageObject[] = [];
        if (to >= from) for await (const m of c.fetch(`${from}:${to}`, SUMMARY)) out.push(m);
        return out;
      };
      if (input.since !== undefined && !(Number.isFinite(input.since) && Math.abs(input.since) < 8.64e15)) throw new StatusError('since is a time in ms', 400);
      if (input.since !== undefined) {
        // SINCE is by day on the server; the exact time is checked here.
        const q: Record<string, unknown> = { since: new Date(input.since) };
        if (before !== Infinity) q.uid = `1:${before - 1}`;
        const uids = ((await c.search(q, { uid: true })) || []).sort((a, b) => a - b);
        const take = uids.slice(-limit);
        more = uids.length > limit;
        for await (const m of take.length ? c.fetch(toRanges(take), SUMMARY, { uid: true }) : []) page.push(m);
        page = page.filter((m) => toMs(m.internalDate) >= input.since!);
      } else if (before === Infinity) {
        page = await fetchSeq(Math.max(1, box.exists - limit + 1), box.exists);
        more = box.exists > limit;
      } else if (c.capabilities.has('ESEARCH')) {
        // How many are older than the cursor is the sequence number of the newest of them.
        const r = (await c.search({ uid: `1:${before - 1}` }, { returnOptions: ['COUNT'] })) as unknown as { count?: number };
        const n = r?.count ?? 0;
        page = await fetchSeq(Math.max(1, n - limit + 1), n);
        more = n > limit;
      } else {
        const uids = ((await c.search({ uid: `1:${before - 1}` }, { uid: true })) || []).sort((a, b) => a - b);
        const take = uids.slice(-limit);
        more = uids.length > limit;
        for await (const m of take.length ? c.fetch(toRanges(take), SUMMARY, { uid: true }) : []) page.push(m);
      }
      page = page.filter((m) => m.uid < before).sort((a, b) => b.uid - a.uid);
      const messages = page.map((m) => summary(m, path, uv));
      return { messages, next: more && page.length ? `${uv}.${page[page.length - 1].uid}` : null };
    });
  }

  async get(id: string): Promise<MailMessage> {
    const ref = parseMessageId(id);
    return this.withBox(ref.path, async (c, box) => {
      this.checkUv(box, ref.uidValidity);
      const m = await c.fetchOne(String(ref.uid), SUMMARY, { uid: true });
      if (!m) throw new StatusError('no such message (it was moved or deleted)', 404);
      const uv = String(box.uidValidity);
      const parts = walk(m.bodyStructure);
      const read = async (part: string | null) => {
        if (!part) return null;
        const d = await c.download(String(ref.uid), part, { uid: true, maxBytes: BODY_CAP });
        return (await collect(d.content, BODY_CAP)).toString('utf8');
      };
      const html = await read(parts.html);
      let text = await read(parts.text);
      if (text === null && html !== null) text = htmlToText(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] });
      const env = m.envelope ?? {};
      return {
        ...summary(m, ref.path, uv),
        bcc: addrs(env.bcc),
        replyTo: addrs(env.replyTo),
        inReplyTo: firstMessageId(env.inReplyTo),
        // Every reference here; a summary keeps 20.
        references: messageIds(headerMap(m.headers).get('references')?.join(' ')),
        text,
        html,
        attachments: parts.attachments,
      };
    });
  }

  async attachment(id: string, attachmentId: string): Promise<{ filename: string | null; mime: string; base64: string }> {
    const ref = parseMessageId(id);
    if (!/^\d+(\.\d+)*$/.test(attachmentId)) throw new StatusError('no such attachment', 404);
    return this.withBox(ref.path, async (c, box) => {
      this.checkUv(box, ref.uidValidity);
      const m = await c.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true });
      if (!m) throw new StatusError('no such message (it was moved or deleted)', 404);
      const node = findPart(m.bodyStructure, attachmentId);
      if (!node || node.type.toLowerCase().startsWith('multipart/')) throw new StatusError('no such attachment', 404);
      const a = toAttachment(node);
      if (a.size > ATTACHMENT_CAP) throw new StatusError(`the attachment is ${mb(a.size)} MB; at most 25 MB come through here`, 413);
      const d = await c.download(String(ref.uid), attachmentId, { uid: true, maxBytes: ATTACHMENT_CAP + 1, decodeText: false });
      const buf = await collect(d.content, ATTACHMENT_CAP + 1);
      if (buf.length > ATTACHMENT_CAP) throw new StatusError('the attachment is over 25 MB; at most 25 MB come through here', 413);
      return { filename: a.filename, mime: a.mime, base64: buf.toString('base64') };
    });
  }

  /** The whole message as the server keeps it: BODY.PEEK[] (imapflow's `source`), so \Seen stays as it was. */
  async raw(id: string): Promise<{ filename: null; mime: 'message/rfc822'; base64: string; size: number }> {
    const ref = parseMessageId(id);
    return this.withBox(ref.path, async (c, box) => {
      this.checkUv(box, ref.uidValidity);
      const head = await c.fetchOne(String(ref.uid), { uid: true, size: true }, { uid: true });
      if (!head) throw new StatusError('no such message (it was moved or deleted)', 404);
      if ((head.size ?? 0) > RAW_CAP) throw new StatusError(`the message is ${mb(head.size ?? 0)} MB; at most 50 MB come through here`, 413);
      const m = await c.fetchOne(String(ref.uid), { uid: true, source: true }, { uid: true });
      const buf = m && m.source ? Buffer.from(m.source) : null;
      if (!buf) throw new StatusError('no such message (it was moved or deleted)', 404);
      if (buf.length > RAW_CAP) throw new StatusError('the message is over 50 MB; at most 50 MB come through here', 413);
      return { filename: null, mime: 'message/rfc822', base64: buf.toString('base64'), size: buf.length };
    });
  }

  async search(input: { query: string; mailboxId?: string; limit?: number }): Promise<{ messages: MailSummary[] }> {
    const words = String(input.query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (!words.length) throw new StatusError('search for what?', 400);
    const limit = clamp(input.limit, 50, 1, 200);
    let paths: string[];
    if (input.mailboxId) paths = [mailboxPath(input.mailboxId)];
    else {
      const l = this.boxes ?? (await this.list());
      const all = l.find((b) => roleOf(b) === 'all');
      paths = all ? [all.path] : l.filter((b) => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent') && !['trash', 'junk'].includes(roleOf(b) ?? '')).map((b) => b.path);
    }
    const found: MailSummary[] = [];
    for (const path of paths) {
      const got = await this.withBox(path, async (c, box) => {
        if (!box.exists) return [];
        let uids: number[] | null = null;
        if (c.capabilities.has('X-GM-EXT-1')) uids = (await c.search({ gmraw: input.query }, { uid: true })) || [];
        else
          for (const w of words) {
            // Each word in the sender, recipients, subject or text: one SEARCH per word, kept where all agree.
            const hit = new Set((await c.search({ or: [{ from: w }, { to: w }, { cc: w }, { subject: w }, { body: w }] }, { uid: true })) || []);
            uids = uids === null ? [...hit] : uids.filter((u) => hit.has(u));
            if (!uids.length) break;
          }
        const take = (uids ?? []).sort((a, b) => a - b).slice(-limit);
        return this.summaries(c, path, String(box.uidValidity), take);
      });
      found.push(...got);
    }
    const uidOf = (m: MailSummary) => Number(m.id.slice(m.id.lastIndexOf('.') + 1));
    found.sort((a, b) => b.receivedAt - a.receivedAt || uidOf(b) - uidOf(a));
    return { messages: found.slice(0, limit) };
  }

  async changes(input: { mailboxId: string; state?: string; limit?: number }): Promise<MailChanges> {
    const path = mailboxPath(input.mailboxId);
    const limit = clamp(input.limit, 200, 1, 1000);
    return this.withBox(path, async (c, box) => {
      const uv = String(box.uidValidity);
      const mode = this.modeOf(c, box);
      if (!input.state) return { state: await this.stateNow(c, box, path), added: [], changed: [], removed: [], more: false };
      const st = parseState(input.state);
      if (st.uidValidity !== uv) throw new StatusError('the mailbox was rebuilt (its UIDVALIDITY changed): list it again', 410);
      if (st.mode !== mode) throw new StatusError(`the server's way of keeping up changed (${st.mode} → ${mode}): list it again`, 410);
      const id = (u: number) => messageId(path, uv, u);
      const changedOf = (m: FetchMessageObject) => ({ id: id(m.uid), flags: flagsOf(m.flags), labels: labelsOf(m) });
      const modseq = box.highestModseq ?? 0n;

      if (mode === 'q') {
        const oldNext = Number(st.rest);
        const removed: number[] = [];
        const changed: FetchMessageObject[] = [];
        if (oldNext > 1 && modseq > BigInt(st.modseq)) {
          const onGone = (e: { uid?: number; vanished: boolean }) => {
            if (e.vanished && e.uid && e.uid < oldNext) removed.push(e.uid);
          };
          c.on('expunge', onGone);
          try {
            for await (const m of c.fetch(`1:${oldNext - 1}`, { uid: true, flags: true, labels: true }, { uid: true, changedSince: BigInt(st.modseq) })) if (m.uid < oldNext) changed.push(m);
          } finally {
            c.off('expunge', onGone);
          }
        }
        const fresh = box.uidNext > oldNext ? ((await c.search({ uid: `${oldNext}:*` }, { uid: true })) || []).filter((u) => u >= oldNext).sort((a, b) => a - b) : [];
        const page = fresh.slice(0, limit);
        const more = fresh.length > limit;
        const gone = new Set(removed);
        return {
          state: formatState({ mode, uidValidity: uv, modseq: String(modseq), rest: String(more ? page[page.length - 1] + 1 : Math.max(box.uidNext, oldNext)) }),
          added: await this.summaries(c, path, uv, page),
          changed: changed.filter((m) => !gone.has(m.uid)).map(changedOf),
          removed: [...gone].sort((a, b) => a - b).map(id),
          more,
        };
      }

      const snap = this.snaps.load(path, uv, st.rest);
      if (!snap) throw new StatusError('that state is too old (its snapshot is gone): list the mailbox again', 410);
      const known = new Set(snap.uids);
      if (mode === 'c') {
        const now = await allUids(c, box);
        const nowSet = new Set(now);
        const removed = snap.uids.filter((u) => !nowSet.has(u));
        const fresh = now.filter((u) => !known.has(u));
        const page = fresh.slice(0, limit);
        const more = fresh.length > limit;
        const changed: FetchMessageObject[] = [];
        if (modseq > BigInt(st.modseq) && known.size)
          for await (const m of c.fetch('1:*', { uid: true, flags: true, labels: true }, { uid: true, changedSince: BigInt(st.modseq) })) if (known.has(m.uid) && nowSet.has(m.uid)) changed.push(m);
        const inPage = new Set(page);
        const snapId = this.snaps.save(path, uv, { uids: now.filter((u) => known.has(u) || inPage.has(u)), flags: null });
        return {
          state: formatState({ mode, uidValidity: uv, modseq: String(modseq), rest: snapId }),
          added: await this.summaries(c, path, uv, page),
          changed: changed.map(changedOf),
          removed: removed.map(id),
          more,
        };
      }

      // f: every UID with its flags, against the snapshot's.
      const now = await allFlags(c, box);
      const removed = snap.uids.filter((u) => !now.has(u));
      const fresh = [...now.keys()].filter((u) => !known.has(u)).sort((a, b) => a - b);
      const page = fresh.slice(0, limit);
      const more = fresh.length > limit;
      const changed: MailChanges['changed'] = [];
      for (const [u, k] of now) if (known.has(u) && snap.flags!.get(u) !== k) changed.push({ id: id(u), ...decodeCombo(k) });
      const inPage = new Set(page);
      const keep = new Map([...now].filter(([u]) => known.has(u) || inPage.has(u)));
      const snapId = this.snaps.save(path, uv, { uids: [...keep.keys()].sort((a, b) => a - b), flags: keep });
      return {
        state: formatState({ mode, uidValidity: uv, modseq: '0', rest: snapId }),
        added: await this.summaries(c, path, uv, page),
        changed: changed.sort((a, b) => (a.id < b.id ? -1 : 1)),
        removed: removed.map(id),
        more,
      };
    });
  }

  /** Ids grouped by mailbox, each group's UIDVALIDITY checked against the server. */
  private byMailbox(ids: string[]) {
    const groups = new Map<string, { uidValidity: string; uids: number[]; idx: number[] }>();
    ids.forEach((id, i) => {
      const r = parseMessageId(id);
      const g = groups.get(r.path) ?? groups.set(r.path, { uidValidity: r.uidValidity, uids: [], idx: [] }).get(r.path)!;
      if (g.uidValidity !== r.uidValidity) throw new StatusError('the mailbox was rebuilt (its UIDVALIDITY changed): list it again', 410);
      g.uids.push(r.uid);
      g.idx.push(i);
    });
    return groups;
  }

  async flag(input: { ids: string[]; seen?: boolean; flagged?: boolean; answered?: boolean }): Promise<Record<string, never>> {
    const add: string[] = [];
    const remove: string[] = [];
    for (const [k, f] of [['seen', '\\Seen'], ['flagged', '\\Flagged'], ['answered', '\\Answered']] as const) {
      if (input[k] === true) add.push(f);
      if (input[k] === false) remove.push(f);
    }
    for (const [path, g] of this.byMailbox(input.ids)) {
      await this.withBox(path, async (c, box) => {
        this.checkUv(box, g.uidValidity);
        const range = toRanges([...g.uids].sort((a, b) => a - b));
        if (add.length) await c.messageFlagsAdd(range, add, { uid: true });
        if (remove.length) await c.messageFlagsRemove(range, remove, { uid: true });
      });
      this.changedSoon(path);
    }
    return {};
  }

  async move(input: { ids: string[]; mailboxId: string }): Promise<{ ids: (string | null)[] }> {
    const dest = mailboxPath(input.mailboxId);
    const out: (string | null)[] = new Array(input.ids.length).fill(null);
    const roles = new Map((this.boxes ?? (await this.list()) ?? []).map((b) => [b.path, roleOf(b)] as const));
    const destUv = await this.withBox(dest, async (_c, box) => String(box.uidValidity));
    for (const [path, g] of this.byMailbox(input.ids)) {
      if (path === dest) {
        g.idx.forEach((i) => (out[i] = input.ids[i]));
        continue;
      }
      const missing: { i: number; messageId: string | null }[] = [];
      await this.withBox(path, async (c, box) => {
        this.checkUv(box, g.uidValidity);
        const range = toRanges([...g.uids].sort((a, b) => a - b));
        // Their Message-IDs, to find them in the destination when the server does not say where they went.
        const mids = new Map<number, string | null>();
        for await (const m of c.fetch(range, { uid: true, envelope: true }, { uid: true })) mids.set(m.uid, m.envelope?.messageId ?? null);
        const copy = copiesInstead(this.s.provider === 'gmail' || c.capabilities.has('X-GM-EXT-1'), roles.get(path) ?? null, roles.get(dest) ?? null);
        const r = copy ? await c.messageCopy(range, dest, { uid: true }) : await c.messageMove(range, dest, { uid: true });
        const uv = r && r.uidValidity ? String(r.uidValidity) : destUv;
        g.uids.forEach((u, k) => {
          const nu = r && r.uidMap?.get(u);
          if (nu) out[g.idx[k]] = messageId(dest, uv, nu);
          else missing.push({ i: g.idx[k], messageId: mids.get(u) ?? null });
        });
      });
      if (missing.length)
        await this.withBox(dest, async (c, box) => {
          for (const x of missing) {
            if (!x.messageId) continue;
            const hits = (await c.search({ header: { 'message-id': x.messageId } }, { uid: true })) || [];
            if (hits.length) out[x.i] = messageId(dest, String(box.uidValidity), Math.max(...hits));
          }
        });
      this.changedSoon(path);
    }
    this.changedSoon(dest);
    return { ids: out };
  }

  async trash(input: { ids: string[] }): Promise<Record<string, never>> {
    const trash = await this.pathOfRole('trash');
    for (const [path, g] of this.byMailbox(input.ids)) {
      await this.withBox(path, async (c, box) => {
        this.checkUv(box, g.uidValidity);
        const range = toRanges([...g.uids].sort((a, b) => a - b));
        // Already in the trash, or no trash at all: deleted outright.
        if (!trash || path === trash) await c.messageDelete(range, { uid: true });
        else await c.messageMove(range, trash, { uid: true });
      });
      this.changedSoon(path);
    }
    if (trash) this.changedSoon(trash);
    return {};
  }

  /** The original of a reply: its Message-ID and References, for the reply's threading headers. */
  async threading(id: string): Promise<{ path: string; uid: number; messageId: string | null; references: string[] }> {
    const ref = parseMessageId(id);
    return this.withBox(ref.path, async (c, box) => {
      this.checkUv(box, ref.uidValidity);
      const m = await c.fetchOne(String(ref.uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true });
      if (!m) throw new StatusError('the message replied to is gone (moved or deleted)', 404);
      const refs = messageIds(headerMap(m.headers).get('references')?.join(' '));
      return { path: ref.path, uid: ref.uid, messageId: m.envelope?.messageId ?? null, references: refs };
    });
  }

  async markAnswered(path: string, uid: number) {
    await this.withBox(path, (c) => c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }));
    this.changedSoon(path);
  }

  /** The newest message in a mailbox with this Message-ID, as an id. */
  async findByMessageId(path: string, mid: string): Promise<string | null> {
    return this.withBox(path, async (c, box) => {
      const hits = (await c.search({ header: { 'message-id': mid } }, { uid: true })) || [];
      return hits.length ? messageId(path, String(box.uidValidity), Math.max(...hits)) : null;
    });
  }

  async appendTo(path: string, raw: Buffer, flags: string[]): Promise<{ uid: number | null; uidValidity: string | null }> {
    const c = await this.client();
    try {
      const r = await c.append(path, raw, flags, new Date());
      return { uid: r && r.uid ? r.uid : null, uidValidity: r && r.uidValidity ? String(r.uidValidity) : null };
    } catch (err) {
      throw this.callError(err, c, `mailbox ${path}`);
    } finally {
      this.changedSoon(path);
    }
  }
}

// -------------------------------------------------------------------- message shapes

/**
 * A mailbox's role: INBOX, its SPECIAL-USE (RFC 6154), or \Important (RFC 8457, Gmail's [Gmail]/Important), which
 * imapflow's special-use list leaves out but keeps among the flags.
 */
export function roleOf(b: Pick<ListResponse, 'path' | 'specialUse' | 'flags'>): MailboxRole | null {
  if (b.path.toUpperCase() === 'INBOX') return 'inbox';
  return (b.specialUse && ROLES[b.specialUse]) || (b.flags?.has('\\Important') ? 'important' : null);
}

/**
 * Whether a move is a COPY instead: on Gmail, out of All Mail into anything but Trash or Spam. All Mail is every
 * message, not a label, so a MOVE out of it removes the message from All Mail, which on Gmail deletes it; a COPY adds
 * the destination's label (Inbox, or a user label) and leaves it in All Mail, which is what "move to Inbox" means there.
 * Into Trash or Spam a MOVE is what Gmail's own clients do.
 */
export function copiesInstead(gmail: boolean, from: MailboxRole | null, to: MailboxRole | null): boolean {
  return gmail && from === 'all' && to !== 'trash' && to !== 'junk';
}

function addrs(l: MessageAddressObject[] | undefined): MailAddress[] {
  return (l ?? []).filter((a) => a.address).map((a) => ({ name: a.name?.trim() || null, email: a.address! }));
}

const toMs = (d: Date | string | undefined) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};

export function flagsOf(f: Set<string> | undefined): MailFlags {
  const has = (x: string) => !!f?.has(x);
  return { seen: has('\\Seen'), flagged: has('\\Flagged'), answered: has('\\Answered'), draft: has('\\Draft') };
}

function labelsOf(m: FetchMessageObject): string[] {
  const out = new Set<string>();
  for (const k of m.flags ?? []) if (!k.startsWith('\\') && !HIDDEN_KEYWORDS.has(k)) out.add(k);
  for (const l of m.labels ?? []) out.add(l);
  return [...out].sort();
}

/** Flags and labels as one comparable string, for the UID+flags snapshots. */
function combo(m: FetchMessageObject): string {
  const f = flagsOf(m.flags);
  return `${+f.seen}${+f.flagged}${+f.answered}${+f.draft}|${labelsOf(m).join('\u0001')}`;
}
function decodeCombo(k: string): { flags: MailFlags; labels: string[] } {
  const [bits, labels] = [k.slice(0, 4), k.slice(5)];
  return { flags: { seen: bits[0] === '1', flagged: bits[1] === '1', answered: bits[2] === '1', draft: bits[3] === '1' }, labels: labels ? labels.split('\u0001') : [] };
}

async function allUids(c: ImapFlow, box: MailboxObject): Promise<number[]> {
  if (!box.exists) return [];
  return ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b);
}
async function allFlags(c: ImapFlow, box: MailboxObject): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!box.exists) return out;
  for await (const m of c.fetch('1:*', { uid: true, flags: true, labels: true })) out.set(m.uid, combo(m));
  return out;
}

export function summary(m: FetchMessageObject, path: string, uv: string): MailSummary {
  const env = m.envelope ?? {};
  const received = toMs(m.internalDate);
  const h = headerMap(m.headers);
  const bulk = bulkOf((name) => h.get(name)?.[0] ?? null);
  return {
    id: messageId(path, uv, m.uid),
    mailboxId: mailboxId(path),
    messageId: env.messageId?.trim() || null,
    threadId: m.threadId ?? null,
    ...(m.emailId ? { emailId: m.emailId } : {}),
    from: addrs(env.from),
    to: addrs(env.to),
    cc: addrs(env.cc),
    subject: env.subject ?? '',
    date: toMs(env.date) || received,
    receivedAt: received,
    flags: flagsOf(m.flags),
    labels: labelsOf(m),
    size: m.size ?? 0,
    preview: null,
    hasAttachments: walk(m.bodyStructure).attachments.some((a) => !(a.inline && a.contentId)),
    inReplyTo: firstMessageId(env.inReplyTo),
    references: keepReferences(messageIds(h.get('references')?.join(' '))),
    ...(bulk ? { bulk } : {}),
  };
}

// -------------------------------------------------------------------- headers

/** A header block (HEADER.FIELDS) as lower-cased names to their values, unfolded, in order. */
export function headerMap(raw: Buffer | string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw) return out;
  const text = (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/\r?\n(?=[ \t])/g, '');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    (out.get(name) ?? out.set(name, []).get(name)!).push(line.slice(i + 1));
  }
  return out;
}

/** The Message-IDs in a header's value, `<…>` as written, in order, each once (none over 300 characters). */
export function messageIds(v: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const id of v?.match(/<[^<>\s]+>/g) ?? []) if (id.length <= 300) out.add(id);
  return [...out];
}

/** In-Reply-To's Message-ID (the first, when a client wrote more): bracketed as messageId is; null without one. */
export function firstMessageId(v: string | null | undefined): string | null {
  const [id] = messageIds(v);
  if (id) return id;
  const bare = v?.trim();
  return bare && bare.length <= 298 && /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? `<${bare}>` : null;
}

/** A summary's references: all of them up to 20, else the first (the root) and the last 19. */
export function keepReferences(refs: string[]): string[] {
  return refs.length <= 20 ? refs : [refs[0], ...refs.slice(-19)];
}

/** One header's value as kept: control characters and runs of space made one space, trimmed, 300 characters. */
const headerValue = (v: string | null | undefined) => (v ? v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 300) || null : null);

export function bulkOf(get: (name: string) => string | null): MailBulk | null {
  const b: MailBulk = { listId: headerValue(get('list-id')), unsubscribe: headerValue(get('list-unsubscribe')), precedence: headerValue(get('precedence')), autoSubmitted: headerValue(get('auto-submitted')) };
  return b.listId || b.unsubscribe || b.precedence || b.autoSubmitted ? b : null;
}

/** A part's size decoded, about: base64 is 3/4 of what the server counts once the line breaks are off. */
function decodedSize(n: MessageStructureObject): number {
  const size = n.size ?? 0;
  if (n.encoding?.toLowerCase() !== 'base64') return size;
  return Math.max(0, Math.floor(((size - 2 * Math.ceil(size / 78)) * 3) / 4));
}

function toAttachment(n: MessageStructureObject): MailAttachment {
  const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? null;
  return {
    id: n.part ?? '1',
    filename,
    mime: n.type.toLowerCase(),
    size: decodedSize(n),
    inline: n.disposition?.toLowerCase() === 'inline' || (!n.disposition && !!n.id && !filename),
    contentId: n.id ? n.id.replace(/^\s*<|>\s*$/g, '') : null,
  };
}

/** The message's text and HTML parts (the first of each that is not an attachment), and every other leaf part. */
export function walk(root: MessageStructureObject | undefined): { text: string | null; html: string | null; attachments: MailAttachment[] } {
  const out = { text: null as string | null, html: null as string | null, attachments: [] as MailAttachment[] };
  const visit = (n: MessageStructureObject) => {
    const type = n.type.toLowerCase();
    if (type.startsWith('multipart/')) {
      for (const ch of n.childNodes ?? []) visit(ch);
      return;
    }
    const isAttachment = n.disposition?.toLowerCase() === 'attachment' || !!n.dispositionParameters?.filename;
    if (type === 'text/plain' && !isAttachment && !out.text) out.text = n.part ?? '1';
    else if (type === 'text/html' && !isAttachment && !out.html) out.html = n.part ?? '1';
    else out.attachments.push(toAttachment(n));
  };
  if (root) visit(root);
  return out;
}

function findPart(n: MessageStructureObject | undefined, part: string): MessageStructureObject | null {
  if (!n) return null;
  if ((n.part ?? (n.childNodes?.length ? '' : '1')) === part) return n;
  for (const ch of n.childNodes ?? []) {
    const f = findPart(ch, part);
    if (f) return f;
  }
  return null;
}

async function collect(stream: AsyncIterable<Buffer | string> | undefined, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (!stream) return Buffer.alloc(0);
  let n = 0;
  for await (const ch of stream) {
    const b = typeof ch === 'string' ? Buffer.from(ch) : ch;
    chunks.push(b);
    n += b.length;
    if (n > cap) break;
  }
  return Buffer.concat(chunks);
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

function clamp(v: unknown, d: number, lo: number, hi: number) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d;
  return Math.min(hi, Math.max(lo, n));
}

/** true when something accepts TCP connections there, or why not. */
export function tcpCheck(e: Endpoint, ms = 3000): Promise<true | string> {
  return new Promise((res) => {
    const s = net.connect({ host: e.host, port: e.port });
    const t = setTimeout(() => {
      s.destroy();
      res('no answer');
    }, ms);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      res(true);
    });
    s.once('error', (err: any) => {
      clearTimeout(t);
      res(String(err?.code ?? err?.message ?? err));
    });
  });
}

export { sleep };
