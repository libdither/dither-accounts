/**
 * Google Messages adapter: this machine paired with Google Messages on an Android phone, as messages.google.com is,
 * through libgm in bridge/main.go (docs/gmessages.md). Every text goes through the phone: Google's servers only relay
 * between this session and the phone, so the phone has to stay on, online, and allowed to run Google Messages in the
 * background.
 *
 *   not paired   -> a QR code to scan with the phone (Device pairing → QR code scanner), or, with the cookies of a
 *                   Google account signed in at messages.google.com, an emoji to tap on the phone (Google's way now)
 *   paired       -> connected: the conversation list and its latest messages, then live events
 *   unpaired     -> back to pairing (removed under Device pairing on the phone, or Google dropped it); a Google
 *                   account pairing whose cookies still work asks for a new emoji at once
 *   phone silent -> attention: nothing arrives or leaves until it answers again
 *
 * Ids: Google Messages numbers conversations and messages per phone, so they are namespaced by the phone
 * ("<ns>:c<id>", "<ns>:m<id>"). People are their phone number (the same person in two accounts is one identity),
 * an email for RCS by email, or "<ns>:p<participant>" for senders with neither.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { attachmentKind } from '@dither-chat/protocol';
import { Bridge, type Logger } from './bridge.ts';
import { phoneKey, toPlain } from './format.ts';
import { type ConvRow, type MsgRow, State } from './state.ts';
import type { BridgeEvent, GmConversation, GmMedia, GmMessage, GmParticipant, GmSession, GmSettings } from './types.ts';

export const ADAPTER_VERSION = '0.1.0';
/**
 * What Google Messages for web does, and so this: no edits (Google Messages has none), no forwarding of its own, no
 * threads or calls, no group settings it can change. `redact` deletes the message from the phone (and so from every
 * paired device): Google Messages has no unsend.
 */
export const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'redact', 'markRead', 'typing', 'media', 'sendMedia', 'e2ee', 'openDirect', 'about', 'profile'];
/** How long Google Messages shows "typing…" without another typing event (mautrix-gmessages' timeout). */
export const GM_TYPING_TTL = 15_000;

export const QR_MESSAGE =
  'Scan this with Google Messages on your Android phone: your profile picture → Device pairing → QR code scanner. Keep the phone on and online afterwards: every text goes through it.';
export const QR_RETIRED =
  'No "QR code scanner" under Device pairing? Google has moved messages.google.com to pairing with your Google account: run the action pairGoogle with the cookies of messages.google.com signed in (see docs/gmessages.md), or add the account again with them.';
export const PHONE_SILENT =
  'Your phone is not answering. Keep it on and online, with Google Messages allowed to run in the background (no battery restriction). Nothing arrives or leaves until it does.';
export const ELSEWHERE =
  'Google Messages is now open in another browser or computer, so the phone talks to that one. Run the action setActive (or Reconnect) to bring it back here.';

const RECEIPT_RANK: Record<string, number> = { sending: 0, sent: 0, failed: 0, delivered: 1, read: 2 };
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const CONNECT_BACKOFF = [2000, 5000, 15_000, 30_000, 60_000];

export interface Secret {
  /** libgm's AuthData: the pairing, its keys and token, and (Google account pairing) the account's cookies. */
  session?: GmSession;
  /** Cookies given to pair with a Google account, kept until that pairing works. */
  cookies?: string;
  [k: string]: unknown;
}

export interface AdapterHost {
  emit(ev: P.AdapterEvent): void;
  log: Logger;
  accountDir: string;
  config: Record<string, any>;
  secret(): Secret;
  saveSecret(value: Secret): void;
}

export interface AdapterOptions {
  /** argv prefix for the bridge (resolved lazily: may run `nix build`). */
  bridge: () => Promise<string[]>;
  restartBackoffMs?: number[];
  connectBackoffMs?: number[];
  stableAfterMs?: number;
  /** How long a send waits for the phone's copy of it, to answer with its id. */
  echoTimeoutMs?: number;
  /** After connecting, how long to wait for the phone to make this session active before asking it to. */
  activeTimeoutMs?: number;
  /** Conversations listed on connect (default 25, or config.initialChats). */
  initialChats?: number;
  /** Messages fetched for a conversation seen for the first time (default 20, or config.initialMessages). */
  initialMessages?: number;
}

type Phase = 'starting' | 'pairing' | 'connecting' | 'online' | 'stopped' | 'broken';
type Status = Extract<P.AdapterEvent, { t: 'status' }>;
type Attention = NonNullable<Status['attention']>;
type Pairing =
  | { via: 'qr'; attempt: number; of: number; url?: string; refreshAt?: number; expired?: boolean; error?: string }
  | { via: 'google'; emoji?: string; svg?: string; error?: string; code?: string; needCookies?: boolean };

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The key of the phone a session is paired with, which names its namespace: Google pairing's device, else the phone's id. */
export function phoneOf(s: GmSession | undefined): string | null {
  if (!s) return null;
  if (s.dest_reg_id && s.dest_reg_id !== NIL_UUID) return `d:${s.dest_reg_id}`;
  if (s.mobile?.sourceID) return `m:${s.mobile.sourceID}`;
  return null;
}

export function namespaceOf(phone: string): string {
  return new Bun.CryptoHasher('sha256').update(`gmessages\0${phone}`).digest('hex').slice(0, 10);
}

const isPaired = (s: GmSession | undefined) => !!s?.browser && !!s.tachyon_token;
/** Paired by Google account (libgm writes a nil UUID for a QR pairing). */
const isGoogle = (s: GmSession | undefined) => !!s?.dest_reg_id && s.dest_reg_id !== NIL_UUID;

export class GMessagesAdapter {
  readonly state: State;
  private bridge: Bridge | null = null;
  private argv: string[] = [];
  private phase: Phase = 'starting';
  private restarts = 0;
  private connects = 0;
  private bridgeStarted = 0;
  private restartTimer?: Timer;
  private connectTimer?: Timer;
  private activeTimer?: Timer;
  private lastStatus: Status | null = null;
  private lastStatusKey = '';
  private brokenMessage = '';
  private connectError: string | null = null;
  private pairing: Pairing | null = null;
  /** Why it is pairing again, said above the code. */
  private unpairNote = '';
  private google = false;
  private googleAccount: string | null = null;
  private phoneResponding: boolean | null = null;
  private phoneHeardAt = 0;
  private phoneSilentSince = 0;
  /** This session is the one the phone talks to (BROWSER_ACTIVE), or another browser took over. */
  private activeHere: boolean | null = null;
  private listenError: string | null = null;
  private settings: GmSettings | null = null;
  private battery: 'low' | 'ok' | null = null;
  private network: 'mobile data' | 'wifi' | null = null;
  private pushThrottled = false;
  private lastSync = 0;
  private syncing: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private published = new Map<string, string>();
  private echoes = new Map<string, (nativeId: string) => void>();
  private recentEchoes = new Map<string, string>();
  private ns: string | null = null;
  private secretCache: Secret | null = null;
  private closed = false;

  constructor(
    private host: AdapterHost,
    private opts: AdapterOptions,
  ) {
    this.state = new State(join(host.accountDir, 'state.db'));
    this.ns = this.state.get('ns') ?? null;
    const phone = phoneOf(this.secret().session);
    if (phone) this.useNamespace(phone);
    const s = this.state.get('settings');
    if (s) this.settings = JSON.parse(s);
  }

  /** secret.json, read once and then kept in step with every write. */
  private secret(): Secret {
    this.secretCache ??= this.host.secret() ?? {};
    return this.secretCache;
  }

  private saveSecret(value: Secret) {
    this.host.saveSecret(value);
    this.secretCache = value;
  }

  // ---------------------------------------------------------------- lifecycle

  hello() {
    this.host.emit({ t: 'hello', network: 'gmessages', version: ADAPTER_VERSION, capabilities: CAPABILITIES });
  }

  onHubConnect() {
    this.hello();
    if (this.lastStatus) this.host.emit(this.lastStatus);
  }

  async start() {
    this.hello();
    this.refreshStatus();
    try {
      this.argv = await this.opts.bridge();
    } catch (e: any) {
      this.phase = 'broken';
      this.brokenMessage = `The Google Messages bridge is not available: ${e?.message ?? e}`;
      this.host.log('error', String(e?.message ?? e));
      this.refreshStatus();
      return;
    }
    if (this.phase === 'stopped') return;
    this.spawn();
  }

  async shutdown() {
    this.phase = 'stopped';
    clearTimeout(this.restartTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.activeTimer);
    await this.bridge?.stop();
    await this.queue.catch(() => {});
    await this.syncing?.catch(() => {});
    this.closed = true;
    this.state.close();
  }

  private spawn() {
    if (this.phase === 'stopped') return;
    const b = new Bridge({
      argv: [
        ...this.argv,
        '--log',
        this.host.config.debug ? 'DEBUG' : 'INFO',
        ...(this.host.config.proxy ? ['--proxy', String(this.host.config.proxy)] : []),
        ...(Number(this.host.config.pingMinutes) > 0 ? ['--ping-interval', `${Number(this.host.config.pingMinutes)}m`] : []),
        '--device-name',
        String(this.host.config.deviceName ?? 'dither-accounts'),
      ],
      env: process.env,
      log: this.host.log,
      onEvent: (ev) => this.onBridge(ev as BridgeEvent),
      onExit: (code) => this.onBridgeExit(b, code),
    });
    this.bridge = b;
    this.bridgeStarted = Date.now();
    this.host.log('info', `Google Messages bridge started (pid ${b.pid})`);
  }

  private onBridgeExit(b: Bridge, code: number | null) {
    if (this.bridge !== b) return;
    this.bridge = null;
    clearTimeout(this.activeTimer);
    for (const [, w] of this.echoes) w('');
    this.echoes.clear();
    if (this.phase === 'stopped' || this.phase === 'broken') return;
    if (Date.now() - this.bridgeStarted > (this.opts.stableAfterMs ?? 120_000)) this.restarts = 0;
    const backoff = this.opts.restartBackoffMs ?? BACKOFF;
    const delay = backoff[Math.min(this.restarts++, backoff.length - 1)];
    this.host.log('warn', `Google Messages bridge exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`);
    if (this.phase === 'online') this.phase = 'connecting';
    this.activeHere = null;
    this.refreshStatus();
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  private async respawn() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.connectTimer);
    const b = this.bridge;
    this.bridge = null;
    await b?.stop();
    this.restarts = 0;
    this.spawn();
  }

  private get rpc(): Bridge {
    if (!this.bridge?.alive) throw new Error('Google Messages is not connected yet');
    return this.bridge;
  }

  private requirePaired() {
    if (!isPaired(this.secret().session)) throw new Error('Google Messages is not paired yet: pair it on the account page');
    if (this.phase !== 'online') throw new Error('Google Messages is not connected yet');
  }

  private useNamespace(phone: string) {
    const ns = namespaceOf(phone);
    if (ns !== this.ns) {
      if (this.ns) this.host.log('info', `paired with another phone than before: its conversations get new ids (${this.ns} -> ${ns})`);
      this.ns = ns;
      this.state.set('ns', ns);
    }
  }

  private nsOrThrow(): string {
    if (!this.ns) throw new Error('not paired with a phone yet');
    return this.ns;
  }

  convId(gmId: string) {
    return `${this.nsOrThrow()}:c${gmId}`;
  }
  msgId(gmId: string) {
    return `${this.nsOrThrow()}:m${gmId}`;
  }
  selfId() {
    return `${this.ns ?? 'gm'}:me`;
  }

  // ---------------------------------------------------------------- status

  private statusNow(): { status: P.AccountStatus; attention: Attention | null } {
    switch (this.phase) {
      case 'starting':
        return { status: 'connecting', attention: null };
      case 'stopped':
        return { status: 'offline', attention: null };
      case 'broken':
        return { status: 'error', attention: { kind: 'unknown', message: this.brokenMessage } };
      case 'pairing':
        return { status: 'attention', attention: this.pairingAttention() };
      case 'connecting':
        return { status: 'connecting', attention: this.connectError ? { kind: 'unknown', message: this.connectError } : null };
      case 'online':
        if (this.activeHere === false) return { status: 'attention', attention: { kind: 'unknown', message: ELSEWHERE } };
        if (this.phoneResponding === false) return { status: 'attention', attention: { kind: 'unknown', message: PHONE_SILENT } };
        if (this.listenError) return { status: 'connecting', attention: null };
        return { status: 'online', attention: null };
    }
  }

  private pairingAttention(): Attention {
    const p = this.pairing;
    const note = this.unpairNote ? `${this.unpairNote} ` : '';
    if (!p) return { kind: 'link_device', message: `${note}Getting a pairing code…` };
    if (p.via === 'qr') {
      if (p.error) return { kind: 'link_device', message: `${note}Google would not give a QR code (${p.error}). ${QR_RETIRED} Or press New code to try again.` };
      if (p.expired || !p.url) return { kind: 'link_device', message: `${note}The QR code expired without a scan. Press New code for another. ${QR_RETIRED}` };
      return { kind: 'link_device', message: `${note}${QR_MESSAGE} ${QR_RETIRED}`, qr: p.url, qrRefreshAt: p.refreshAt };
    }
    if (p.needCookies)
      return {
        kind: 'login',
        message: `${note}${p.error ? `${p.error} ` : ''}To pair with your Google account, sign in at messages.google.com in your browser and paste its cookies below (Copy as cURL of a request to messages.google.com, a cookie export, or SID=…; HSID=…; SSID=…; APISID=…; SAPISID=…; OSID=…).`,
      };
    if (p.error) return { kind: 'link_device', message: `${note}Pairing with your Google account failed: ${p.error}. Press New code to try again.` };
    if (p.emoji)
      return {
        kind: 'verify',
        message: `${note}On your phone, Google Messages asks to pair: tap ${p.emoji} there. Keep the phone on and online afterwards: every text goes through it.`,
        detail: { emoji: p.emoji, emojiSvg: p.svg },
      };
    return { kind: 'link_device', message: `${note}Asking Google to pair with your phone…` };
  }

  private refreshStatus(force = false) {
    if (this.closed) return;
    const { status, attention } = this.statusNow();
    const ev: Status = { t: 'status', status, attention, details: this.details(), layers: this.layers(status, attention) };
    if (isPaired(this.secret().session)) ev.self = this.selfIdentity();
    const key = JSON.stringify(ev);
    if (key === this.lastStatusKey && !force) return;
    this.lastStatusKey = key;
    this.lastStatus = ev;
    this.host.emit(ev);
  }

  private at(ms: number) {
    return new Date(ms).toISOString().slice(11, 16) + ' UTC';
  }

  /**
   * What the account rests on, outermost first: the bridge process, the phone (where every text actually goes), this
   * machine paired with it, and the connection to Google's relay between the two. The first that is not ok is where
   * it stops.
   */
  private layers(status: P.AccountStatus, attention: Attention | null): P.StatusLayer[] {
    const secret = this.secret();
    const paired = isPaired(secret.session);
    const bridge: P.StatusLayer =
      this.phase === 'broken'
        ? { name: 'bridge', state: 'failed', note: this.brokenMessage }
        : this.bridge?.alive
          ? { name: 'bridge', state: 'ok', note: `libgm, pid ${this.bridge.pid}` }
          : { name: 'bridge', state: 'waiting', note: this.argv.length ? (this.restarts ? `restarting (${this.restarts} so far)` : 'starting') : 'looking for it' };
    const extras = [this.battery === 'low' ? 'battery low' : '', this.network ?? '', this.pushThrottled ? 'Google Messages is throttled on it' : ''].filter(Boolean).join(', ');
    const phone: P.StatusLayer = !paired
      ? { name: 'phone', state: 'waiting', note: this.pairing?.via === 'google' ? 'an Android phone with Google Messages signed in to the same Google account' : 'an Android phone with Google Messages: pair it below' }
      : this.phoneResponding === false
        ? { name: 'phone', state: 'failed', note: `not answering since ${this.at(this.phoneSilentSince)}: keep it on and online, Google Messages not battery-restricted` }
        : this.phoneHeardAt
          ? { name: 'phone', state: 'ok', note: `answered ${this.at(this.phoneHeardAt)}${extras ? `; ${extras}` : ''}; it must stay on and online` }
          : this.phase === 'online'
            ? { name: 'phone', state: 'waiting', note: 'not heard from yet; it must be on and online' }
            : { name: 'phone', state: 'waiting', note: 'waits for the connection' };
    const p = this.pairing;
    const pairedLayer: P.StatusLayer = paired
      ? { name: 'paired', state: 'ok', note: this.google || isGoogle(secret.session) ? `with a Google account${this.googleAccount ? ` (${this.googleAccount})` : ''}` : 'by QR code' }
      : this.phase === 'broken' || !this.bridge?.alive
        ? { name: 'paired', state: 'waiting', note: 'waits for the bridge' }
        : !p
          ? { name: 'paired', state: 'waiting', note: this.unpairNote || 'not yet' }
          : p.via === 'qr'
            ? { name: 'paired', state: 'waiting', note: p.error ? `no QR code: ${p.error}` : p.expired ? 'the QR code expired: press New code' : `scan the QR code (${p.attempt} of ${p.of})` }
            : p.needCookies
              ? { name: 'paired', state: 'waiting', note: 'needs the cookies of messages.google.com signed in' }
              : p.error
                ? { name: 'paired', state: 'failed', note: p.error }
                : p.emoji
                  ? { name: 'paired', state: 'waiting', note: `tap ${p.emoji} on the phone` }
                  : { name: 'paired', state: 'waiting', note: 'asking Google' };
    const connected: P.StatusLayer = !paired
      ? { name: 'connected', state: 'waiting', note: 'waits for pairing' }
      : this.phase === 'online'
        ? this.activeHere === false
          ? { name: 'connected', state: 'failed', note: 'Google Messages is active in another browser: run setActive' }
          : this.listenError
            ? { name: 'connected', state: 'waiting', note: `reconnecting: ${this.listenError}` }
            : this.activeHere
              ? { name: 'connected', state: 'ok', note: "to Google's relay, the phone's active session" }
              : { name: 'connected', state: 'ok', note: "to Google's relay; waiting for the phone to take this session" }
        : status === 'error'
          ? { name: 'connected', state: 'failed', note: attention?.message ?? 'error' }
          : { name: 'connected', state: 'waiting', note: this.connectError ?? 'connecting' };
    return [bridge, phone, pairedLayer, connected];
  }

  private details(): Record<string, string | number | boolean | null> {
    const secret = this.secret();
    const sim = this.settings?.sims[0];
    const expiry = secret.session?.tachyon_expiry ? Date.parse(secret.session.tachyon_expiry) : NaN;
    return {
      pairedVia: isPaired(secret.session) ? (this.google || isGoogle(secret.session) ? 'google' : 'qr') : null,
      googleAccount: this.googleAccount,
      phoneNumber: sim?.phone ?? null,
      carrier: sim?.carrier ?? null,
      sims: this.settings ? this.settings.sims.length : null,
      rcs: this.settings ? this.settings.rcsEnabled : null,
      readReceipts: this.settings ? this.settings.readReceipts : null,
      typingIndicators: this.settings ? this.settings.typingIndicators : null,
      defaultSmsApp: this.settings?.defaultSmsApp ?? null,
      messagesVersion: this.settings?.version ?? null,
      phoneResponding: this.phoneResponding,
      phoneLastHeard: this.phoneHeardAt ? new Date(this.phoneHeardAt).toISOString() : null,
      activeHere: this.activeHere,
      battery: this.battery,
      network: this.network,
      conversations: this.state.countConvs(),
      messages: this.state.countMsgs(),
      lastSync: this.lastSync ? new Date(this.lastSync).toISOString() : null,
      tokenExpires: Number.isFinite(expiry) && expiry > 0 ? new Date(expiry).toISOString() : null,
      namespace: this.ns,
    };
  }

  // ---------------------------------------------------------------- connecting and pairing

  private async connect() {
    clearTimeout(this.connectTimer);
    if (this.phase === 'stopped' || !this.bridge?.alive) return;
    const secret = this.secret();
    if (!isPaired(secret.session)) return this.startPairing();
    this.phase = 'connecting';
    this.refreshStatus();
    let r: { paired: boolean; unpaired?: boolean; loggedOut?: boolean };
    try {
      r = await this.rpc.call('connect', { session: secret.session }, 90_000);
    } catch (e: any) {
      if ((this.phase as Phase) === 'stopped') return;
      const backoff = this.opts.connectBackoffMs ?? CONNECT_BACKOFF;
      const delay = backoff[Math.min(this.connects++, backoff.length - 1)];
      this.connectError = `Could not reach Google Messages (${e?.message ?? e}); trying again in ${Math.round(delay / 1000)} s.`;
      this.host.log('warn', this.connectError);
      this.refreshStatus();
      this.connectTimer = setTimeout(() => this.connect().catch(() => {}), delay);
      return;
    }
    // unpaired / logged_out arrive as events and are handled there; a session that never paired pairs now.
    if (!r.paired && !r.unpaired) await this.startPairing();
  }

  private async startPairing(force?: 'qr' | 'google') {
    if (this.phase === 'stopped') return;
    clearTimeout(this.activeTimer);
    this.phase = 'pairing';
    this.pairing = null;
    this.refreshStatus();
    const secret = this.secret();
    const cookies = secret.cookies || cookieHeader(secret.session?.cookies);
    const via = force ?? (cookies ? 'google' : this.host.config.pairing === 'google' ? 'google' : 'qr');
    if (via === 'google') {
      if (!cookies) {
        this.pairing = { via: 'google', needCookies: true };
        this.refreshStatus();
        return;
      }
      await this.pairGoogle(cookies, false).catch(() => {});
      return;
    }
    try {
      await this.rpc.call('startQr', {}, 60_000);
    } catch (e: any) {
      this.pairing = { via: 'qr', attempt: 0, of: 0, error: String(e?.message ?? e) };
      this.refreshStatus();
    }
  }

  /** Pair with a Google account: its cookies (any form ParseCookies takes), then an emoji on the phone. */
  private async pairGoogle(cookies: string, save: boolean) {
    this.phase = 'pairing';
    this.pairing = { via: 'google' };
    this.refreshStatus();
    try {
      const r = await this.rpc.call<{ emoji: string }>('pairGoogle', { cookies }, 120_000);
      if (save) this.saveSecret({ ...this.secret(), cookies });
      return r;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Cookies that do not parse or that Google refuses: ask for others. Anything else: try again with these.
      const badCookies = /cookies/i.test(msg);
      this.pairing = { via: 'google', error: msg, needCookies: badCookies };
      this.refreshStatus();
      throw e;
    }
  }

  private paired(ev: Extract<BridgeEvent, { t: 'paired' }>) {
    const { cookies: _drop, ...rest } = this.secret();
    this.saveSecret({ ...rest, session: ev.session });
    const phone = phoneOf(ev.session);
    if (phone) this.useNamespace(phone);
    this.google = ev.via === 'google';
    this.pairing = null;
    this.unpairNote = '';
    this.phase = 'connecting';
    this.connectError = null;
    this.host.log('info', `paired with the phone (${ev.via === 'google' ? 'Google account' : 'QR code'})`);
    this.refreshStatus();
  }

  private connected(ev: Extract<BridgeEvent, { t: 'connected' }>) {
    this.phase = 'online';
    this.connects = 0;
    this.restarts = 0;
    this.connectError = null;
    this.listenError = null;
    this.google = ev.google;
    this.googleAccount = ev.account || null;
    this.activeHere = null;
    this.refreshStatus();
    // The phone answers BROWSER_ACTIVE once it takes this session; if it does not say so, ask it to and sync anyway.
    clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => {
      if (this.phase !== 'online' || this.activeHere || !this.bridge?.alive) return;
      this.bridge.call('setActive').catch((e) => this.host.log('warn', `setActive: ${e.message}`));
      this.sync('connected').catch(() => {});
    }, this.opts.activeTimeoutMs ?? 20_000);
  }

  /** The pairing is gone. A Google account pairing whose cookies work pairs again with a new emoji; else a new QR code. */
  private unpaired(reason: string) {
    const secret = this.secret();
    const keepCookies = reason !== 'google_logged_out' && reason !== 'logout';
    const cookies = keepCookies ? secret.cookies || cookieHeader(secret.session?.cookies) : undefined;
    const { session: _gone, cookies: _c, ...rest } = secret;
    this.saveSecret({ ...rest, ...(cookies ? { cookies } : {}) });
    this.host.log('warn', `Google Messages unpaired this machine (${reason})`);
    this.unpairNote =
      reason === 'revoked'
        ? 'This computer was removed under Device pairing on the phone.'
        : reason === 'google_logged_out'
          ? 'The Google account was signed out of Google Messages.'
          : reason === 'logout' || reason === 'relink'
            ? ''
            : 'Google Messages no longer knows this pairing (the phone dropped it, or it lapsed).';
    this.resetSession();
    void this.startPairing();
  }

  /** The Google sign-in stopped working. A Google pairing needs new cookies; a QR pairing is simply gone. */
  private loggedOut(reason: string) {
    const secret = this.secret();
    const google = this.google || isGoogle(secret.session);
    if (!google) return this.unpaired(reason);
    const { session: _s, cookies: _c, ...rest } = secret;
    this.saveSecret(rest);
    this.host.log('warn', `Google refused this session's sign-in (${reason})`);
    this.resetSession();
    this.phase = 'pairing';
    this.pairing = { via: 'google', needCookies: true, error: 'Google signed this session out (its cookies stopped working).' };
    this.refreshStatus();
  }

  private resetSession() {
    clearTimeout(this.activeTimer);
    this.phoneResponding = null;
    this.phoneHeardAt = 0;
    this.activeHere = null;
    this.listenError = null;
    this.googleAccount = null;
  }

  private heardPhone() {
    this.phoneHeardAt = Date.now();
    if (this.phoneResponding !== true) {
      this.phoneResponding = true;
      this.refreshStatus();
    }
  }

  // ---------------------------------------------------------------- bridge events

  private onBridge(ev: BridgeEvent) {
    // After shutdown the bridge's last lines may still come in: the state they would touch is closed.
    if (this.phase === 'stopped') return;
    switch (ev.t) {
      case 'ready':
        void this.connect();
        return;
      case 'fatal':
        this.phase = 'broken';
        this.brokenMessage = ev.error;
        this.refreshStatus();
        return;
      case 'qr':
        this.phase = 'pairing';
        this.pairing = { via: 'qr', attempt: ev.attempt, of: ev.of, url: ev.url, refreshAt: Date.now() + ev.expiresMs };
        this.refreshStatus();
        return;
      case 'qr_expired':
        if (this.pairing?.via === 'qr') this.pairing = { ...this.pairing, expired: true, url: undefined, refreshAt: undefined };
        this.refreshStatus();
        return;
      case 'emoji':
        this.phase = 'pairing';
        this.pairing = { via: 'google', emoji: ev.emoji, svg: ev.svg };
        this.refreshStatus();
        return;
      case 'pair_error':
        this.pairing = ev.via === 'qr' ? { via: 'qr', attempt: 0, of: 0, error: ev.error } : { via: 'google', error: ev.error, code: ev.code };
        this.refreshStatus();
        return;
      case 'paired':
        return this.paired(ev);
      case 'connect_error': {
        const backoff = this.opts.connectBackoffMs ?? CONNECT_BACKOFF;
        const delay = backoff[Math.min(this.connects++, backoff.length - 1)];
        this.phase = 'connecting';
        this.connectError = `Paired, but connecting failed (${ev.error}); trying again in ${Math.round(delay / 1000)} s.`;
        this.refreshStatus();
        this.connectTimer = setTimeout(() => this.connect().catch(() => {}), delay);
        return;
      }
      case 'connected':
        return this.connected(ev);
      case 'session':
        this.saveSecret({ ...this.secret(), session: ev.session });
        this.refreshStatus();
        return;
      case 'unpaired':
        return this.unpaired(ev.reason);
      case 'logged_out':
        return this.loggedOut(ev.reason);
      case 'listen_error':
        this.listenError = ev.error;
        this.host.log(ev.fatal ? 'error' : 'warn', `listening to Google Messages: ${ev.error}`);
        if (ev.fatal && this.phase === 'online') {
          // libgm stops listening after a fatal error: start over with a fresh bridge.
          this.phase = 'connecting';
          this.connectError = `The connection to Google Messages failed (${ev.error}); reconnecting.`;
          void this.respawn();
        }
        this.refreshStatus();
        return;
      case 'listen_recovered':
        this.listenError = null;
        this.refreshStatus();
        return;
      case 'phone':
        if (ev.responding) this.heardPhone();
        else {
          this.phoneResponding = false;
          this.phoneSilentSince = Date.now();
        }
        this.refreshStatus();
        return;
      case 'ping_failed':
        this.host.log(ev.count > 1 ? 'warn' : 'debug', `pinging the phone failed (${ev.count}): ${ev.error}`);
        return;
      case 'conversation':
        this.heardPhone();
        this.enqueue(() => this.applyConversation(ev.conversation));
        return;
      case 'message':
        this.heardPhone();
        {
          // libgm marks what the phone replays on connect as old: news all the same if it is newer than anything seen.
          const m = ev.message;
          const live = !m.old || (!!this.state.get('synced') && m.ts > Number(this.state.get('seen') ?? 0));
          this.enqueue(() => this.applyMessage(m, { live }));
        }
        return;
      case 'typing':
        return this.typingEvent(ev.conversation, ev.number, ev.stop);
      case 'alert':
        return this.alert(ev.alert);
      case 'settings':
        this.heardPhone();
        if (ev.settings.sims.length || !this.settings) this.settings = ev.settings;
        else this.settings = { ...ev.settings, sims: this.settings.sims };
        this.state.set('settings', JSON.stringify(this.settings));
        this.refreshStatus();
        return;
      case 'account_change':
        this.host.log('info', `Google account change: ${ev.enabled ? 'paired by account' : 'paired by QR'}${ev.fake ? ' (startup)' : ''}`);
        return;
      case 'no_data':
        this.host.log('info', 'nothing heard from Google Messages for a while: syncing');
        this.sync('no data').catch(() => {});
        return;
      case 'set_active_may_fail':
        setTimeout(() => {
          if (this.phase === 'online' && !this.activeHere && this.bridge?.alive) this.bridge.call('setActive').catch((e) => this.host.log('warn', `setActive: ${e.message}`));
        }, 7000);
        return;
    }
  }

  private alert(a: Extract<BridgeEvent, { t: 'alert' }>['alert']) {
    switch (a) {
      case 'browser_active': {
        const first = !this.activeHere;
        this.activeHere = true;
        this.heardPhone();
        clearTimeout(this.activeTimer);
        this.refreshStatus();
        if (first) this.sync('active').catch(() => {});
        return;
      }
      case 'browser_inactive':
      case 'browser_inactive_timeout':
      case 'browser_inactive_inactivity':
        this.activeHere = false;
        this.refreshStatus();
        return;
      case 'battery_low':
        this.battery = 'low';
        break;
      case 'battery_restored':
        this.battery = 'ok';
        break;
      case 'mobile_data':
        this.network = 'mobile data';
        break;
      case 'wifi':
        this.network = 'wifi';
        break;
      case 'db_sync_complete':
        this.sync('the phone synced its messages').catch(() => {});
        break;
      case 'push_throttle_started':
        this.pushThrottled = true;
        break;
      case 'push_throttle_ended':
        this.pushThrottled = false;
        break;
    }
    this.heardPhone();
    this.refreshStatus();
  }

  /** Conversation and message facts in the order they arrived; each may ask the phone something first. */
  private enqueue(fn: () => Promise<unknown> | unknown) {
    this.queue = this.queue
      .then(() => (this.phase === 'stopped' ? undefined : fn()))
      .catch((e) => this.host.log('error', `handling an event: ${e?.stack ?? e}`));
  }

  /** Run fn in that order, and have its result. */
  private queued<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      this.enqueue(async () => {
        if (this.phase === 'stopped') return reject(new Error('the extractor is stopping'));
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      }),
    );
  }

  // ---------------------------------------------------------------- people

  private selfIdentity(): P.IdentityFact {
    const sim = this.settings?.sims.find((s) => s.phone) ?? this.settings?.sims[0];
    const f: P.IdentityFact = { nativeId: this.selfId(), displayName: sim?.formatted || sim?.phone || 'Google Messages', isSelf: true };
    if (sim?.phone) f.handle = sim.phone;
    return f;
  }

  private isSelfParticipant(p: GmParticipant | { id?: string; isMe?: boolean }) {
    return !!p.isMe || p.id === '1' || !!this.settings?.sims.some((s) => s.participant && s.participant === p.id);
  }

  /** The identity a participant is published as. */
  identityFor(p: GmParticipant): string {
    if (this.isSelfParticipant(p)) return this.selfId();
    const num = p.number?.trim();
    const phone = phoneKey(num);
    if (phone) return phone;
    if (num && num.includes('@')) return num.toLowerCase();
    if (num) return `sender:${num}`;
    return `${this.nsOrThrow()}:p${p.id}`;
  }

  private personFact(id: string): P.IdentityFact {
    if (id === this.selfId()) return this.selfIdentity();
    const p = this.state.person(id);
    const f: P.IdentityFact = { nativeId: id, displayName: p?.name || p?.firstName || p?.formatted || p?.number || id.replace(/^sender:/, '') };
    const handle = p?.formatted || p?.number;
    if (handle) f.handle = handle;
    if (p?.contact) {
      f.contact = true;
      if (p.participant) f.avatarUrl = `gm-avatar:${p.participant}`;
    }
    return f;
  }

  private publish(id: string, force = false) {
    const f = this.personFact(id);
    const key = JSON.stringify(f);
    if (!force && this.published.get(id) === key) return;
    this.published.set(id, key);
    this.host.emit({ t: 'identity', identity: f });
  }

  private nameOf(id: string): string {
    return this.personFact(id).displayName ?? id;
  }

  private learnParticipant(conversation: string, p: GmParticipant): string {
    const id = this.identityFor(p);
    this.state.mapParticipant(conversation, p.id, id);
    if (id !== this.selfId()) this.state.putPerson({ id, number: p.number, formatted: p.formatted, name: p.fullName, firstName: p.firstName, contact: !!p.contactId || undefined, participant: p.contactId ? p.id : undefined });
    this.publish(id);
    return id;
  }

  // ---------------------------------------------------------------- conversations

  private convFact(c: GmConversation, id: string, participants: string[], e2ee: boolean): P.ConversationFact {
    const f: P.ConversationFact = { nativeId: id, shape: c.group ? 'group' : 'direct', participants };
    if (c.group && c.name) f.name = c.name;
    if (c.lastTs) f.lastMessageAt = c.lastTs;
    if (c.status === 'archived') f.archived = true;
    if (c.avatarUrl?.startsWith('https://')) f.avatarUrl = c.avatarUrl;
    if (e2ee) f.encrypted = true;
    return f;
  }

  private applyConversation(c: GmConversation): ConvRow | undefined {
    const id = this.convId(c.id);
    const prev = this.state.conv(id);
    if (c.status === 'deleted' || c.status === 'spam' || c.status === 'blocked') {
      if (prev) {
        this.state.dropConv(id);
        this.host.emit({ t: 'leave', kind: 'conversation', nativeId: id });
      }
      return undefined;
    }
    const participants = [...new Set(c.participants.map((p) => this.learnParticipant(id, p)))];
    if (!participants.includes(this.selfId())) participants.unshift(this.selfId());
    this.publish(this.selfId());
    const e2ee = prev?.e2ee ?? false;
    const fact = this.convFact(c, id, participants, e2ee);
    const row: ConvRow = { id, gmId: c.id, fact, type: c.type, outgoing: c.outgoingId ?? '', e2ee, unread: !!c.unread, lastTs: c.lastTs, latestId: c.latestId ?? '', group: !!c.group };
    this.state.putConv(row);
    // A new message moves lastMessageAt; the message itself says that, so only other changes publish the fact again.
    const same = (a: P.ConversationFact, b: P.ConversationFact) => JSON.stringify({ ...a, lastMessageAt: 0 }) === JSON.stringify({ ...b, lastMessageAt: 0 });
    if (!prev || !same(prev.fact as P.ConversationFact, fact)) this.host.emit({ t: 'conversation', conversation: fact });
    if (!c.unread && c.lastTs && (!prev || prev.unread)) this.host.emit({ t: 'read', conversation: id, upToTs: c.lastTs, unread: 0, mentions: 0 });
    return this.state.conv(id);
  }

  /** A conversation the adapter has not seen: ask the phone for it. */
  private async ensureConversation(gmId: string): Promise<ConvRow | undefined> {
    const known = this.state.conv(this.convId(gmId));
    if (known) return known;
    try {
      const r = await this.rpc.call<{ conversation: GmConversation }>('conversation', { conversation: gmId }, 60_000);
      return this.applyConversation(r.conversation);
    } catch (e: any) {
      this.host.log('warn', `conversation ${gmId}: ${e.message}`);
      return undefined;
    }
  }

  /** The conversation list, and for each the messages newer than what is known. */
  sync(reason: string): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const count = this.opts.initialChats ?? Number(this.host.config.initialChats ?? 25);
      const r = await this.rpc.call<{ conversations: GmConversation[] }>('conversations', { count, folder: 'inbox' }, 120_000);
      this.heardPhone();
      const first = !this.state.get('synced');
      for (const c of r.conversations) {
        const row = await this.queued(() => this.applyConversation(c));
        if (row && c.latestId && !this.state.msg(this.msgId(c.latestId))) await this.catchUp(row, first);
      }
      this.state.set('synced', '1');
      this.lastSync = Date.now();
      this.host.log('info', `synced ${r.conversations.length} conversations (${reason})`);
      this.refreshStatus();
    })()
      .catch((e) => {
        this.host.log('warn', `sync (${reason}): ${e?.message ?? e}`);
      })
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  /** Messages of a conversation newer than the newest known one. On the first sync they are history, not news. */
  private async catchUp(row: ConvRow, first: boolean) {
    const known = this.state.latest(row.id);
    const count = known ? 25 : (this.opts.initialMessages ?? Number(this.host.config.initialMessages ?? 20));
    const r = await this.rpc.call<{ messages: GmMessage[] }>('messages', { conversation: row.gmId, count }, 120_000);
    const seen = Number(this.state.get('seen') ?? 0);
    const fresh = r.messages.filter((m) => !known || m.ts > known.ts || !this.state.msg(this.msgId(m.id))).sort((a, b) => a.ts - b.ts);
    for (const m of fresh) await this.queued(() => this.applyMessage(m, { live: !first && m.ts > seen && !m.fromMe }));
  }

  // ---------------------------------------------------------------- messages

  private author(conversation: string, m: GmMessage): string {
    if (m.fromMe) return this.selfId();
    const known = m.participant ? this.state.identityOf(conversation, m.participant) : undefined;
    if (known) return known;
    if (m.senderNumber || m.participant) {
      const p: GmParticipant = { id: m.participant ?? '', number: m.senderNumber, fullName: m.senderName };
      return this.learnParticipant(conversation, p);
    }
    return `${this.nsOrThrow()}:p?`;
  }

  private attachments(id: string, media: GmMedia[]): P.AttachmentFact[] {
    const out: P.AttachmentFact[] = [];
    media.forEach((m, i) => {
      if (m.pending) return;
      const mime = m.mime && !m.mime.endsWith('/*') ? m.mime : undefined;
      const a: P.AttachmentFact = { nativeId: m.part || m.mediaId || String(i), kind: attachmentKind(m.mime ?? 'application/octet-stream'), url: `gm-media:${id}/${i}` };
      if (mime) a.mime = mime;
      if (m.name) a.name = m.name;
      if (m.size) a.size = m.size;
      if (m.width) a.width = m.width;
      if (m.height) a.height = m.height;
      out.push(a);
    });
    return out;
  }

  private messageFact(m: GmMessage, id: string, conversation: string, author: string): P.MessageFact {
    const media = m.media ?? [];
    const attachments = this.attachments(id, media);
    const waiting = media.filter((x) => x.pending).map((x) => `(waiting for the attachment${x.name ? ` ${x.name}` : ''})`);
    const body = [m.subject ? `**${m.subject}**` : '', m.text ?? '', ...waiting].filter(Boolean).join('\n');
    const f: P.MessageFact = {
      nativeId: id,
      conversation,
      author,
      ts: m.ts,
      kind: m.state === 'system' ? 'system' : attachments.length && !body ? 'media' : 'text',
      body,
    };
    if (attachments.length) f.attachments = attachments;
    if (m.replyTo) f.replyTo = this.msgId(m.replyTo);
    const extra: Record<string, unknown> = { status: m.state };
    if (m.kind) extra.via = m.kind;
    if (m.error) extra.error = m.error;
    f.extra = extra;
    return f;
  }

  private reactionMap(conversation: string, m: GmMessage): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const r of m.reactions ?? []) {
      const who = r.participants.map((p) => (this.isSelfParticipant({ id: p }) ? this.selfId() : (this.state.identityOf(conversation, p) ?? `${this.nsOrThrow()}:p${p}`)));
      out[r.emoji] = [...new Set([...(out[r.emoji] ?? []), ...who])];
    }
    return out;
  }

  private hashOf(m: GmMessage): string {
    const media = (m.media ?? []).map((x) => `${x.mediaId ?? ''}|${x.thumbId ?? ''}|${x.inline ? 'i' : ''}|${x.pending ? 'p' : ''}`).join(',');
    return new Bun.CryptoHasher('sha256').update(`${m.subject ?? ''}\0${m.text ?? ''}\0${media}\0${m.replyTo ?? ''}\0${m.state === 'failed' ? m.error : ''}`).digest('hex').slice(0, 16);
  }

  private async applyMessage(m: GmMessage, o: { live?: boolean; force?: boolean } = {}) {
    const row = await this.ensureConversation(m.conversation);
    if (!row) return;
    const conversation = row.id;
    const id = this.msgId(m.id);
    const prev = this.state.msg(id);
    if (m.e2ee !== undefined && m.e2ee !== row.e2ee) {
      this.state.setE2EE(conversation, m.e2ee);
      const fact = { ...row.fact, encrypted: m.e2ee || undefined } as P.ConversationFact;
      if (!m.e2ee) delete fact.encrypted;
      this.state.putConv({ ...row, e2ee: m.e2ee, fact });
      this.host.emit({ t: 'conversation', conversation: fact });
    }
    if (m.tmpId) this.resolveEcho(m.tmpId, id);
    if (m.state === 'deleted') {
      if (prev) {
        this.state.dropMsg(id);
        this.host.emit({ t: 'delete', conversation, nativeId: id });
      }
      return;
    }
    if (m.ignore) return;
    // An MMS the phone is downloading by itself arrives again once it has it (mautrix-gmessages waits the same way).
    if (!prev && (m.status === 'INCOMING_AUTO_DOWNLOADING' || m.status === 'INCOMING_RETRYING_AUTO_DOWNLOAD')) return;
    const author = this.author(conversation, m);
    const reactions = this.reactionMap(conversation, m);
    const hash = this.hashOf(m);
    const fact = this.messageFact(m, id, conversation, author);
    const stored: MsgRow = { id, gmId: m.id, conversation, author, fromMe: !!m.fromMe, ts: m.ts, kind: m.kind ?? '', state: m.state, hash, media: m.media ?? [], reactions };
    if (!prev || o.force) {
      for (const who of new Set(Object.values(reactions).flat())) this.publish(who);
      const snapshot: P.ReactionFact[] = Object.entries(reactions).map(([key, authors]) => ({ key, authors }));
      this.state.putMsg(stored);
      this.host.emit({ t: 'message', message: snapshot.length ? { ...fact, reactions: snapshot } : fact, live: !!o.live && !prev });
      if (m.ts > Number(this.state.get('seen') ?? 0)) this.state.set('seen', String(m.ts));
      if (prev) this.reactionDiff(conversation, id, prev.reactions, reactions);
      // Receipts are news: for a message first seen in history or a sync, how far it got is already in the past.
      if (prev || o.live) this.receipts(row, stored, prev?.state ?? 'sending', m);
      return;
    }
    if (prev.hash !== hash) this.host.emit({ t: 'message', message: fact, live: false });
    this.reactionDiff(conversation, id, prev.reactions, reactions);
    this.receipts(row, stored, prev.state, m);
    this.state.putMsg(stored);
  }

  private reactionDiff(conversation: string, message: string, before: Record<string, string[]>, after: Record<string, string[]>) {
    for (const [key, authors] of Object.entries(after)) {
      for (const author of authors) {
        if (before[key]?.includes(author)) continue;
        this.publish(author);
        this.host.emit({ t: 'reaction', conversation, message, author, key });
      }
    }
    for (const [key, authors] of Object.entries(before)) {
      for (const author of authors) if (!after[key]?.includes(author)) this.host.emit({ t: 'reaction', conversation, message, author, key, remove: true });
    }
  }

  /**
   * How far your own message got: delivered and read in a 1:1 chat (the other person), and in a group "Read by
   * Alice, Bob" as the phone words it (matched to members by first name).
   */
  private receipts(row: ConvRow, m: MsgRow, before: string, g: GmMessage) {
    if (!m.fromMe) return;
    const rank = RECEIPT_RANK[m.state] ?? 0;
    const prevRank = RECEIPT_RANK[before] ?? 0;
    const others = (row.fact.participants as string[]).filter((p) => p !== this.selfId());
    if (!row.group) {
      if (rank > prevRank && others.length === 1) {
        this.host.emit({ t: 'receipt', conversation: row.id, messages: [m.id], who: others[0], state: m.state === 'read' ? 'read' : 'delivered', ts: Date.now() });
      }
      return;
    }
    const readBy = /^Read by (.+)$/.exec(g.statusText ?? '')?.[1];
    if (!readBy) return;
    const key = `readby:${m.id}`;
    const already = new Set<string>(JSON.parse(this.state.get(key) ?? '[]'));
    const byName = new Map<string, string[]>();
    for (const p of others) {
      const person = this.state.person(p);
      const n = person?.firstName || person?.formatted || person?.number;
      if (n) byName.set(n, [...(byName.get(n) ?? []), p]);
    }
    for (const name of readBy.split(',').map((s) => s.trim())) {
      const who = byName.get(name)?.shift();
      if (!who || already.has(who)) continue;
      already.add(who);
      this.host.emit({ t: 'receipt', conversation: row.id, messages: [m.id], who, state: 'read', ts: Date.now() });
    }
    this.state.set(key, JSON.stringify([...already]));
  }

  private typingEvent(gmConversation: string, number: string, stop: boolean) {
    if (!this.ns) return;
    const conversation = this.convId(gmConversation);
    const row = this.state.conv(conversation);
    if (!row) return;
    const phone = phoneKey(number);
    const author = phone && (row.fact.participants as string[]).includes(phone) ? phone : (row.fact.participants as string[]).find((p) => p !== this.selfId() && this.state.person(p)?.number === number);
    if (!author || author === this.selfId()) return;
    this.host.emit(stop ? { t: 'typing', conversation, author, stop: true } : { t: 'typing', conversation, author, ttl: GM_TYPING_TTL });
  }

  private resolveEcho(tmpId: string, nativeId: string) {
    const w = this.echoes.get(tmpId);
    if (w) {
      this.echoes.delete(tmpId);
      w(nativeId);
    } else {
      this.recentEchoes.set(tmpId, nativeId);
      if (this.recentEchoes.size > 200) this.recentEchoes.delete(this.recentEchoes.keys().next().value!);
    }
  }

  // ---------------------------------------------------------------- commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments);
      case 'history':
        return this.history(cmd.conversation, cmd.beforeTs, cmd.limit);
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'typing':
        return this.typing(cmd.conversation, !!cmd.stop);
      case 'react':
        return this.react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove);
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors': {
        const m = this.state.msg(cmd.message);
        const authors = m?.reactions[cmd.key] ?? [];
        for (const a of authors) this.publish(a);
        return { authors };
      }
      case 'redact':
        return this.redact(cmd.conversation, cmd.message);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'about':
        return this.about(cmd.target);
      case 'profile':
        return this.profile(cmd.who);
      case 'openDirect':
        return this.openDirect(cmd.peer);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'edit':
        throw new Error('Google Messages cannot edit a message once it is sent');
      case 'forward':
        return { fallback: 'Google Messages for web has no forward of its own' };
      case 'configure':
        throw new Error('Google Messages for web cannot change a conversation’s settings; do it on the phone');
      case 'call':
        throw new Error('Google Messages calls are not supported');
      case 'lab':
      case 'shutdown':
        return undefined;
    }
  }

  private conv(conversation: string): ConvRow {
    const c = this.state.conv(conversation);
    if (!c) throw new Error('That conversation is not in this Google Messages account');
    return c;
  }

  private waitEcho(tmpId: string): Promise<string> {
    const early = this.recentEchoes.get(tmpId);
    if (early) {
      this.recentEchoes.delete(tmpId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.echoes.delete(tmpId);
        resolve('');
      }, this.opts.echoTimeoutMs ?? 15_000);
      this.echoes.set(tmpId, (id) => {
        clearTimeout(t);
        resolve(id);
      });
    });
  }

  private async sendOne(c: ConvRow, args: { text?: string; replyTo?: string; media?: { path: string; name: string; mime: string } }): Promise<string> {
    const tmpId = crypto.randomUUID();
    const echo = this.waitEcho(tmpId);
    try {
      await this.rpc.call('send', { conversation: c.gmId, outgoing: c.outgoing, forceRcs: c.e2ee, tmpId, ...args }, 120_000);
    } catch (e: any) {
      this.echoes.delete(tmpId);
      const msg = String(e?.message ?? e);
      if (msg.startsWith('phone_not_responding')) throw new Error(`Your phone did not answer, so the message may not have been sent; it goes out when the phone is back online if Google kept it. ${PHONE_SILENT}`);
      throw e;
    }
    return echo;
  }

  private async send(conversation: string, body: string, replyTo: string | undefined, attachments: P.OutgoingAttachment[] | undefined): Promise<{ nativeId?: string }> {
    this.requirePaired();
    const c = this.conv(conversation);
    const text = toPlain(body ?? '', (id) => this.nameOf(id), (id) => (this.state.conv(id)?.fact.name as string | undefined) ?? 'chat').trim();
    // Replies are RCS: to an SMS or MMS the phone could not quote, so it goes as a plain message (as mautrix-gmessages does).
    const target = replyTo ? this.state.msg(replyTo) : undefined;
    const reply = target && target.kind !== 'sms' && target.kind !== 'mms' && c.type === 'rcs' ? target.gmId : undefined;
    let first: string | undefined;
    if (attachments?.length) {
      // SMS/MMS carry a caption with the picture; RCS sends the text on its own (Google Messages does not caption RCS).
      const caption = c.type !== 'rcs' ? text : '';
      for (const [i, a] of attachments.entries()) {
        const id = await this.sendOne(c, { media: { path: a.path, name: a.name, mime: a.mime }, ...(i === 0 && caption ? { text: caption } : {}), ...(i === 0 && reply ? { replyTo: reply } : {}) });
        first ??= id;
      }
      if (text && !caption) {
        const id = await this.sendOne(c, { text });
        first ??= id;
      }
      return first ? { nativeId: first } : {};
    }
    if (!text) throw new Error('nothing to send');
    const id = await this.sendOne(c, { text, ...(reply ? { replyTo: reply } : {}) });
    return id ? { nativeId: id } : {};
  }

  private async history(conversation: string, beforeTs: number | undefined, limit: number): Promise<{ count: number; done: boolean }> {
    this.requirePaired();
    const c = this.conv(conversation);
    const anchor = beforeTs !== undefined ? (this.state.latest(conversation, beforeTs - 1) ?? this.state.oldest(conversation)) : this.state.oldest(conversation);
    const cursor = anchor ? { id: anchor.gmId, ts: anchor.ts } : undefined;
    const r = await this.rpc.call<{ messages: GmMessage[] }>('messages', { conversation: c.gmId, count: Math.min(Math.max(limit, 1), 50), ...(cursor ? { cursor } : {}) }, 120_000);
    const older = r.messages.filter((m) => !cursor || m.ts < cursor.ts).sort((a, b) => a.ts - b.ts);
    for (const m of older) await this.queued(() => this.applyMessage(m, { live: false, force: true }));
    return { count: older.length, done: older.length === 0 };
  }

  private async markRead(conversation: string, upTo: string) {
    this.requirePaired();
    const c = this.conv(conversation);
    const target = this.state.msg(upTo) ?? this.state.latest(conversation);
    const gmId = target?.gmId ?? c.latestId;
    if (!gmId) return { marked: 0 };
    await this.rpc.call('markRead', { conversation: c.gmId, message: gmId });
    this.state.setUnread(conversation, false);
    this.host.emit({ t: 'read', conversation, upToTs: target?.ts ?? c.lastTs, unread: 0, mentions: 0 });
    return { marked: 1 };
  }

  /** RCS shows typing; SMS has none, so there is nothing to tell. Google Messages has no "stopped typing" to send. */
  private async typing(conversation: string, stop: boolean) {
    this.requirePaired();
    const c = this.conv(conversation);
    if (stop || c.type !== 'rcs') return {};
    await this.rpc.call('typing', { conversation: c.gmId });
    return {};
  }

  private mine(m: MsgRow): string | undefined {
    return Object.entries(m.reactions).find(([, ids]) => ids.includes(this.selfId()))?.[0];
  }

  private async react(conversation: string, message: string, key: string, remove: boolean) {
    this.requirePaired();
    const c = this.conv(conversation);
    const m = this.state.msg(message);
    if (!m) throw new Error('That message is not in this Google Messages account’s store');
    const prev = this.mine(m);
    if (remove ? prev !== key : prev === key) return {};
    const action = remove ? 'remove' : prev ? 'switch' : 'add';
    await this.rpc.call('react', { conversation: c.gmId, message: m.gmId, emoji: key, action });
    const me = this.selfId();
    const after: Record<string, string[]> = {};
    for (const [k, ids] of Object.entries(m.reactions)) {
      const rest = ids.filter((i) => i !== me);
      if (rest.length) after[k] = rest;
    }
    if (!remove) after[key] = [...(after[key] ?? []), me];
    this.reactionDiff(conversation, message, m.reactions, after);
    this.state.putMsg({ ...m, reactions: after });
    return {};
  }

  private reactionContext(conversation: string): P.ReactionContext {
    const c = this.state.conv(conversation);
    if (!c) return { canReact: false, reason: 'Not in this Google Messages account any more', custom: [] };
    if (c.type === 'rcs') return { canReact: true, reason: 'One reaction per person: a new one replaces yours', custom: [] };
    return { canReact: true, reason: 'SMS and MMS have no reactions: the phone sends yours as a text message (“👍 to …”), as Google Messages does', custom: [] };
  }

  private async redact(conversation: string, message: string) {
    this.requirePaired();
    const m = this.state.msg(message);
    if (!m) throw new Error('That message is not in this Google Messages account’s store');
    await this.rpc.call('delete', { message: m.gmId });
    this.state.dropMsg(message);
    this.host.emit({ t: 'delete', conversation, nativeId: message });
    return {};
  }

  private async download(mediaId: string, key: string, mimeHint?: string): Promise<{ mime: string; base64: string }> {
    const dir = join(this.host.accountDir, 'media');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = join(dir, `${crypto.randomUUID()}.part`);
    try {
      const r = await this.rpc.call<{ size: number; mime: string }>('download', { mediaId, key, dest }, 300_000);
      const data = readFileSync(dest);
      return { mime: mimeHint && !mimeHint.endsWith('/*') ? mimeHint : r.mime || 'application/octet-stream', base64: data.toString('base64') };
    } finally {
      rmSync(dest, { force: true });
    }
  }

  private async fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
    if (url.startsWith('gm-media:')) {
      const rest = url.slice('gm-media:'.length);
      const slash = rest.lastIndexOf('/');
      const m = this.state.msg(rest.slice(0, slash));
      const media = m?.media[Number(rest.slice(slash + 1))];
      if (!m || !media) throw new Error('That attachment is not in this Google Messages account’s store');
      if (media.inline) return { mime: media.mime && !media.mime.endsWith('/*') ? media.mime : 'application/octet-stream', base64: media.inline };
      if (!this.bridge?.alive || this.phase !== 'online') throw new Error('Google Messages is not connected yet');
      if (media.mediaId && media.key) return this.download(media.mediaId, media.key, media.mime);
      if (media.thumbId && media.thumbKey) {
        // Only a preview so far: show it, and ask the phone for the whole picture (it sends the message again with it).
        if (media.part) this.rpc.call('fullMedia', { message: m.gmId, part: media.part }).catch(() => {});
        return this.download(media.thumbId, media.thumbKey, 'image/jpeg');
      }
      throw new Error('The phone has not downloaded this attachment yet');
    }
    if (url.startsWith('gm-avatar:')) {
      if (!this.bridge?.alive || this.phase !== 'online') throw new Error('Google Messages is not connected yet');
      const r = await this.rpc.call<{ thumbnails: { id: string; mime: string; base64: string }[] }>('thumbnails', { ids: [url.slice('gm-avatar:'.length)] }, 60_000);
      const t = r.thumbnails[0];
      if (!t) throw new Error('No picture for this person');
      return { mime: t.mime, base64: t.base64 };
    }
    throw new Error(`Not a Google Messages media URL: ${url}`);
  }

  private about(target: P.AboutTarget): P.About {
    if (target.kind !== 'conversation') throw new Error('Google Messages has no spaces');
    const c = this.conv(target.nativeId);
    const members = c.fact.participants as string[];
    for (const m of members) this.publish(m);
    const sim = this.settings?.sims.find((s) => s.participant === c.outgoing) ?? (this.settings?.sims.length === 1 ? this.settings.sims[0] : undefined);
    const facts: { label: string; value: string }[] = [{ label: 'Type', value: c.type === 'rcs' ? (c.e2ee ? 'RCS, end-to-end encrypted' : 'RCS') : c.group ? 'MMS group' : 'SMS/MMS' }];
    if (sim) facts.push({ label: 'Sends from', value: [sim.formatted || sim.phone, sim.carrier].filter(Boolean).join(', ') || `SIM ${sim.number}` });
    return {
      noun: c.group ? 'Group' : 'Conversation',
      fields: {
        name: c.group
          ? { value: (c.fact.name as string | undefined) ?? null, canEdit: false, reason: 'Rename the group on the phone: Google Messages for web cannot.' }
          : { value: null, canEdit: false, reason: 'A direct conversation is named after the person.' },
      },
      members: { list: members.map((id) => ({ id })), total: members.length, complete: true },
      you: {},
      facts,
    };
  }

  private profile(who: string): P.PersonAbout {
    this.publish(who, true);
    const f = this.personFact(who);
    const p = this.state.person(who);
    const out: P.PersonAbout = { displayName: f.displayName, relationship: who === this.selfId() ? undefined : p?.contact ? 'contact' : 'stranger' };
    if (f.handle) out.handle = f.handle;
    if (f.avatarUrl) out.avatar = f.avatarUrl;
    const number = who === this.selfId() ? this.selfIdentity().handle : p?.number;
    if (number) out.links = [{ label: 'Phone', value: p?.formatted || number, url: `tel:${number}` }];
    return out;
  }

  private async openDirect(peer: string): Promise<P.OpenDirectResult> {
    this.requirePaired();
    const number = phoneKey(peer.replace(/^tel:/, ''));
    if (!number) throw new Error('Give a phone number, with its country code (like +15551234567)');
    const known = this.state.convs().find((c) => !c.group && (c.fact.participants as string[]).includes(number));
    const r = await this.rpc.call<{ conversation: GmConversation }>('getOrCreate', { numbers: [number] }, 60_000);
    const row = await this.queued(() => this.applyConversation(r.conversation));
    if (!row) throw new Error('The phone made no conversation');
    return { conversation: row.id, existed: !!known && known.id === row.id };
  }

  private async action(action: string, args: any): Promise<unknown> {
    const paired = isPaired(this.secret().session);
    switch (action) {
      case 'startLink':
      case 'refreshLink':
      case 'pairQr':
        if (paired) throw new Error('Already paired. Use relink to pair again.');
        if (!this.bridge?.alive) {
          await this.respawn();
          return { started: true };
        }
        await this.rpc.call('cancelPairing').catch(() => {});
        await this.startPairing(action === 'pairQr' ? 'qr' : undefined);
        return { started: true };
      case 'pairGoogle':
      case 'relogin': {
        if (paired) throw new Error('Already paired. Use relink to pair again.');
        const cookies = String(args?.cookies ?? args?.password ?? '').trim();
        if (!cookies) throw new Error('Give the cookies of messages.google.com, signed in (Copy as cURL, a cookie export, or SID=…; HSID=…; …)');
        await this.rpc.call('cancelPairing').catch(() => {});
        return this.pairGoogle(cookies, true);
      }
      case 'relink':
      case 'logout':
        if (this.bridge?.alive && paired) await this.rpc.call('logout').catch((e) => this.host.log('warn', `logout: ${e.message}`));
        this.unpaired(action === 'logout' ? 'logout' : 'relink');
        return {};
      case 'reconnect':
        this.phase = 'connecting';
        this.activeHere = null;
        await this.respawn();
        return {};
      case 'setActive':
        if (!paired || this.phase !== 'online') throw new Error('Google Messages is not connected');
        await this.rpc.call('setActive');
        return {};
      case 'resync':
        this.requirePaired();
        await this.sync('asked');
        return { conversations: this.state.countConvs() };
      case 'typing':
        return this.typing(String(args?.conversation ?? ''), !!args?.stop);
      case 'status': {
        const b = this.bridge?.alive ? await this.rpc.call('status').catch(() => null) : null;
        return { phase: this.phase, bridge: b, conversations: this.state.countConvs(), messages: this.state.countMsgs() };
      }
    }
    throw new Error(`unknown action "${action}" (startLink, refreshLink, pairQr, pairGoogle, relogin, relink, logout, reconnect, setActive, resync, typing, status)`);
  }
}

/** A session's cookies back as a Cookie header, for pairing again with them. */
function cookieHeader(c: Record<string, string> | undefined): string | undefined {
  if (!c || !Object.keys(c).length) return undefined;
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
