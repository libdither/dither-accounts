/**
 * WhatsApp adapter: this hub as a linked device (like WhatsApp Web), through whatsmeow in
 * bridge/main.go. See docs/whatsapp.md for why this and not the web client in a sandbox.
 *
 *   not linked   -> the bridge shows QR codes; status 'attention' (link_device) with the code.
 *                   Or a pairing code for a phone number (action pairPhone), for when the only
 *                   screen is the phone itself.
 *   linked       -> connected: history sync on the first link, then live events; whatsmeow
 *                   reconnects on its own after network trouble
 *   unlinked     -> back to linking (the phone removed the device, or it went 14 days without
 *                   the phone being online)
 *   temp. banned -> attention, and no reconnect until the ban expires
 *
 * Nothing here talks to WhatsApp except through the bridge. To look like WhatsApp Web, the
 * adapter only does what a person in WhatsApp Web would cause: it never marks itself online
 * (that also keeps the phone getting notifications), never looks up numbers on its own,
 * fetches profile pictures only when one is shown and someone's About only when you open their profile.
 *
 * Adding (docs/whatsapp.md): an invite link pasted is read with the query WhatsApp's own invite sheet makes, a phone
 * number with one IsOnWhatsApp lookup, and joining or answering a join request happens only on the owner's click.
 * Nobody is ever added to a group from here, but you by your own join and someone whose request to join you accept.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL, ABOUT_RULES, createGroupNotBuilt, durationLabel } from '@dither-chat/protocol';
import { Bridge, type Logger } from './bridge.ts';
import { toWhatsApp } from './format.ts';
import { Aliases, avatarUrl, bare, checkAbout, contextOf, ignoredChat, isGroup, isPhoneJid, isUser, Mapper, type MapOut, mediaOf, msgId, phoneOf } from './mapping.ts';
import { State, type StoredMsg } from './state.ts';
import type { BridgeEvent, WaContact, WaGroup, WaJoinRequest, WaMessage, WaOnWhatsApp, WaSelf, WaUserInfo } from './types.ts';

/** How long WhatsApp's own clients show "typing…" without another chat state. */
export const WHATSAPP_TYPING_TTL = 25_000;

export const ADAPTER_VERSION = '0.1.0';
/** No 'connect': WhatsApp has no friend requests or follows, only a chat (openDirect). */
export const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'media', 'sendMedia', 'e2ee', 'openDirect', 'forward', 'about', 'configure', 'profile', 'editProfile', 'resolve', 'join', 'requests'];
export const LINK_MESSAGE = 'Scan this QR code in WhatsApp → Settings → Linked devices → Link a device';
/** WhatsApp lets you edit for 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** A group read this recently (the hub asks `about` just before `configure`) answers for a change. */
const GROUP_FRESH_MS = 60_000;
const ONLY_ADMINS = 'Only admins can change this.';
const LOCKED_INFO = 'Only admins can edit this group’s info.';
const COMMUNITY_INFO = 'Only community admins can change this.';
const NO_PICTURE = 'Changing the picture is not supported yet.';
const ALWAYS_E2EE = 'Always on in WhatsApp.';
const INVITE_ADMINS = 'Only admins can see and change the invite link.';
/** A profile opened again this soon is answered without asking WhatsApp again. */
const PROFILE_FRESH_MS = 5 * 60_000;
/** At most this many profile queries a minute, whatever the hub asks: never anything that looks like a bulk lookup. */
const PROFILE_QUERIES_PER_MINUTE = 10;
/** Receipts from others, by whatsmeow's receipt type ('' is delivered), and how far along each is. */
const RECEIPT_STATE: Record<string, P.ReceiptState> = { '': 'delivered', read: 'read', played: 'played' };
const RECEIPT_RANK: Record<P.ReceiptState, number> = { delivered: 1, read: 2, played: 3 };
/** How many (message, reader) pairs to remember receipts for. A repeat after that is harmless, only wasted. */
const RECEIPTS_KEPT = 20_000;
/** A link read this recently (the preview the owner just saw) answers for the Join that follows it. */
const LINK_FRESH_MS = 10 * 60_000;
const ASK_NOTE = 'The group’s admins approve new members';
const HOUR = 3_600_000;
/**
 * What this account sends WhatsApp for adding, whoever asks: dither-chat's hub paces the same (its ADD_LIMITS), and
 * any app with the chat grant may call resolve. A number lookup is a usync query, which WhatsApp watches.
 */
export const ADD_PACE = {
  number: { max: 20, windowMs: HOUR, did: 'looked up 20 phone numbers in the last hour' },
  link: { max: 60, windowMs: HOUR, did: 'read 60 invite links in the last hour' },
  join: { max: 5, windowMs: 24 * HOUR, did: 'joined or asked to join 5 groups in the last day' },
} as const;

/** A join request to a group you admin: the JID WhatsApp named the requester by, and what the hub is told. */
interface JoinReq {
  group: string;
  jid: string;
  fact: P.RequestFact;
}

export interface AdapterHost {
  emit(ev: P.AdapterEvent): void;
  log: Logger;
  accountDir: string;
  config: Record<string, any>;
}

export interface AdapterOptions {
  /** argv prefix for the bridge (resolved lazily: may run `nix build`). */
  bridge: () => Promise<string[]>;
  /** Seconds between bridge restarts after it dies, last one repeating. */
  restartBackoffMs?: number[];
  /** A bridge that ran this long gets a fresh backoff. */
  stableAfterMs?: number;
  /** How long to wait for the phone to answer a history request. */
  historyTimeoutMs?: number;
  /** Least time between two full snapshots (groups, contacts). */
  snapshotEveryMs?: number;
  expirySweepMs?: number;
  /** fetch, for profile pictures (tests replace it). */
  fetch?: typeof fetch;
}

type Phase = 'starting' | 'linking' | 'connecting' | 'online' | 'banned' | 'replaced' | 'stopped' | 'broken';
type Status = Extract<P.AdapterEvent, { t: 'status' }>;

const BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000];

export class WhatsAppAdapter {
  readonly state: State;
  readonly aliases: Aliases;
  readonly mapper: Mapper;
  private bridge: Bridge | null = null;
  private phase: Phase = 'starting';
  private argv: string[] = [];
  private restarts = 0;
  private bridgeStarted = 0;
  private restartTimer?: Timer;
  private banTimer?: Timer;
  private expiryTimer?: Timer;
  private lastStatus: Status | null = null;
  private self: WaSelf = { loggedIn: false };
  private published = new Map<string, string>();
  private groupFetch = new Map<string, Promise<void>>();
  /** The last read of each group, for the About panel. */
  private groups = new Map<string, { g: WaGroup; at: number }>();
  /** Invite links read for the About panel (admins only). */
  private inviteLinks = new Map<string, string | null>();
  private historyWaiters = new Map<string, (count: number) => void>();
  private historyCounts = new Map<string, number>();
  private pendingReads = new Map<string, { unread: number; lastTs: number }>();
  private lastSnapshot = 0;
  private noAvatar = new Map<string, number>();
  /** The last profile query per person (undefined: it failed or was not made). */
  private userInfo = new Map<string, { u: Promise<WaUserInfo | undefined>; at: number }>();
  private profileQueries: number[] = [];
  /** "<message> <reader>" -> the furthest receipt passed on: each device of each reader sends its own. */
  private receipts = new Map<string, number>();
  /** Invite links read for a preview, by code: what Join goes by. */
  private linkPreviews = new Map<string, { g: WaGroup; at: number }>();
  /** Join requests to groups you admin, by request native id. */
  private joinReqs = new Map<string, JoinReq>();
  /** The whole list was read since start: it can be sent as one, and a request not in it is gone. */
  private requestsKnown = false;
  /** Requests WhatsApp announced or took back while the list was being read, laid over what the read found. */
  private reqLoad: { added: Map<string, JoinReq>; gone: Set<string> } | null = null;

  constructor(
    private host: AdapterHost,
    private opts: AdapterOptions,
  ) {
    this.state = new State(join(host.accountDir, 'state.db'));
    this.aliases = new Aliases(this.state);
    this.mapper = new Mapper(this.state, this.aliases, () => this.selfIds(), (id) => this.nameOf(id));
    const s = this.state.get('self');
    if (s) this.self = { ...JSON.parse(s), loggedIn: false };
  }

  // ---------------------------------------------------------------- lifecycle

  hello() {
    this.host.emit({ t: 'hello', network: 'whatsapp', version: ADAPTER_VERSION, capabilities: CAPABILITIES });
  }

  /** Every (re)connect to the hub: hello and the current status. */
  onHubConnect() {
    this.hello();
    if (this.lastStatus) this.host.emit(this.lastStatus);
    if (this.requestsKnown) this.sendRequests(true);
  }

  async start() {
    this.hello();
    this.setStatus('connecting', null);
    try {
      this.argv = await this.opts.bridge();
    } catch (e: any) {
      this.phase = 'broken';
      this.host.log('error', String(e?.message ?? e));
      this.setStatus('error', { kind: 'unknown', message: `The WhatsApp bridge is not available: ${e?.message ?? e}` });
      return;
    }
    if (this.phase === 'stopped') return;
    this.spawn();
    this.expiryTimer = setInterval(() => this.sweepExpired(), this.opts.expirySweepMs ?? 60_000);
  }

  async shutdown() {
    this.phase = 'stopped';
    clearTimeout(this.restartTimer);
    clearTimeout(this.banTimer);
    clearInterval(this.expiryTimer);
    await this.bridge?.stop();
    this.state.close();
  }

  private spawn() {
    if (this.phase === 'stopped') return;
    const cfg = this.host.config;
    const args = ['--db', join(this.host.accountDir, 'whatsmeow.db'), '--os-name', String(cfg.deviceName ?? 'dither-chat'), '--platform', String(cfg.platform ?? 'DESKTOP')];
    if (cfg.debug) args.push('--log', 'DEBUG');
    this.bridgeStarted = Date.now();
    const b = new Bridge({
      argv: [...this.argv, ...args],
      env: process.env,
      log: this.host.log,
      onEvent: (ev) => this.onBridge(ev),
      onExit: (code) => this.onBridgeExit(b, code),
    });
    this.bridge = b;
    this.host.log('info', `WhatsApp bridge started (pid ${b.pid})`);
  }

  private onBridgeExit(b: Bridge, code: number | null) {
    if (this.bridge !== b) return;
    this.bridge = null;
    for (const [, w] of this.historyWaiters) w(0);
    this.historyWaiters.clear();
    if (this.phase === 'stopped' || this.phase === 'banned' || this.phase === 'replaced' || this.phase === 'broken') return;
    if (Date.now() - this.bridgeStarted > (this.opts.stableAfterMs ?? 120_000)) this.restarts = 0;
    const backoff = this.opts.restartBackoffMs ?? BACKOFF;
    const delay = backoff[Math.min(this.restarts++, backoff.length - 1)];
    this.host.log('warn', `WhatsApp bridge exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`);
    if (this.phase === 'online') this.setStatus('connecting', null);
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  /** Stop the bridge and start a fresh one (after an unlink, or on request). */
  private async respawn() {
    clearTimeout(this.restartTimer);
    const b = this.bridge;
    this.bridge = null;
    await b?.stop();
    this.restarts = 0;
    this.spawn();
  }

  private setStatus(status: P.AccountStatus, attention?: Status['attention'], self?: P.IdentityFact) {
    const ev: Status = { t: 'status', status };
    if (attention !== undefined) ev.attention = attention;
    if (self) ev.self = self;
    ev.layers = this.layers(status, attention ?? null);
    this.lastStatus = ev;
    this.host.emit(ev);
  }

  /**
   * What the account rests on (status.layers): the whatsmeow bridge, this linked device, and the connection to
   * WhatsApp. Only what the adapter already knows; the first layer not ok is where it stops.
   */
  private layers(status: P.AccountStatus, attention: Status['attention'] | null): P.StatusLayer[] {
    const message = attention?.message ?? status;
    const bridge: P.StatusLayer =
      this.phase === 'broken'
        ? { name: 'bridge', state: 'failed', note: message }
        : this.phase === 'replaced'
          ? { name: 'bridge', state: 'failed', note: 'stopped: another copy of this linked device connected' }
          : this.phase === 'banned'
            ? { name: 'bridge', state: 'waiting', note: 'stopped until the ban ends' }
            : this.bridge?.alive
              ? { name: 'bridge', state: 'ok', note: `whatsmeow, pid ${this.bridge.pid}` }
              : { name: 'bridge', state: 'waiting', note: this.argv.length ? (this.restarts ? `restarting (${this.restarts} so far)` : 'starting') : 'looking for it' };
    const linked: P.StatusLayer = this.self.loggedIn
      ? { name: 'linked', state: 'ok', note: 'a linked device of your phone' }
      : this.phase === 'linking'
        ? { name: 'linked', state: 'waiting', note: attention?.qr ? 'scan the QR code with WhatsApp on your phone' : attention?.kind === 'link_device' ? message : 'linking' }
        : { name: 'linked', state: 'waiting', note: this.self.jid ? 'linked before; waits for the bridge' : 'waits for the bridge' };
    const connected: P.StatusLayer =
      status === 'online'
        ? { name: 'connected', state: 'ok' }
        : !this.self.loggedIn
          ? { name: 'connected', state: 'waiting', note: 'waits for the link' }
          : status === 'error' || this.phase === 'banned'
            ? { name: 'connected', state: 'failed', note: message }
            : { name: 'connected', state: 'waiting', note: attention ? message : this.phase === 'online' ? 'the connection dropped; reconnecting' : 'connecting' };
    return [bridge, linked, connected];
  }

  private get rpc(): Bridge {
    if (!this.bridge?.alive) throw new Error('WhatsApp is not connected yet');
    return this.bridge;
  }

  private requireLinked() {
    if (!this.self.loggedIn || !this.self.jid) throw new Error('WhatsApp is not linked yet: scan the QR code on the account page');
  }

  selfIds() {
    const jids = [this.self.jid, this.self.lid].filter((j): j is string => !!j).map(bare);
    return { id: jids.length ? this.aliases.id(jids[0]) : 'self', jids };
  }

  // ---------------------------------------------------------------- bridge events

  private onBridge(ev: BridgeEvent) {
    switch (ev.t) {
      case 'ready':
        this.self.loggedIn = ev.loggedIn;
        if (!ev.loggedIn) this.phase = 'linking';
        else this.phase = 'connecting';
        this.rpc.call('connect').catch((e) => this.host.log('warn', `connect: ${e.message}`));
        return;
      case 'fatal':
        this.phase = 'broken';
        this.setStatus('error', { kind: 'unknown', message: ev.error });
        return;
      case 'qr':
        this.phase = 'linking';
        this.setStatus('attention', { kind: 'link_device', message: LINK_MESSAGE, qr: ev.code, qrRefreshAt: Date.now() + ev.timeoutMs });
        return;
      case 'qr_done':
        if (ev.result === 'success') this.setStatus('connecting', null);
        else if (ev.result === 'timeout') this.setStatus('attention', { kind: 'link_device', message: 'The QR code expired. Press New code for another one.' });
        else if (ev.result === 'err-client-outdated') this.outdated();
        else if (ev.result === 'err-scanned-without-multidevice') this.setStatus('attention', { kind: 'link_device', message: 'That phone has an old WhatsApp without linked devices. Update WhatsApp, then press New code.' });
        else this.setStatus('attention', { kind: 'link_device', message: `Linking failed (${ev.error ?? ev.result}). Press New code to try again.` });
        return;
      case 'paired':
        this.self = { ...this.self, loggedIn: true, jid: ev.jid, lid: ev.lid, businessName: ev.businessName };
        this.saveSelf();
        this.host.log('info', `linked as ${ev.jid} (${ev.platform ?? 'phone'})`);
        this.setStatus('connecting', null);
        return;
      case 'pair_error':
        this.setStatus('attention', { kind: 'link_device', message: `Linking failed: ${ev.error}. Press New code to try again.` });
        return;
      case 'connected':
        return this.connected(ev);
      case 'disconnected':
        if (this.phase === 'online') {
          this.phase = 'connecting';
          this.setStatus('connecting', null);
        }
        return;
      case 'keepalive_timeout':
        if (ev.errors >= 2 && this.phase === 'online') this.setStatus('connecting', null);
        return;
      case 'keepalive_restored':
        if (this.phase === 'online') this.setStatus('online', null, this.selfIdentity());
        return;
      case 'logged_out':
        return this.unlinked(ev.reason);
      case 'stream_replaced':
        this.phase = 'replaced';
        this.setStatus('error', { kind: 'unknown', message: 'Another copy of this linked device connected, so WhatsApp closed this one. Press Reconnect if that copy is gone.' });
        this.bridge?.stop();
        return;
      case 'temporary_ban':
        return this.banned(ev.message, ev.expireSec);
      case 'client_outdated':
        return this.outdated();
      case 'connect_failure':
        this.host.log('warn', `WhatsApp refused the connection: ${ev.message}`);
        if (this.phase !== 'linking') this.setStatus('error', { kind: 'unknown', message: `WhatsApp refused the connection: ${ev.message}` });
        return;
      case 'stream_error':
        this.host.log('warn', `stream error ${ev.code}`);
        return;
      case 'message':
        return this.apply(this.mapper.message(ev), ev.info.pushName && !ev.info.fromMe ? { jid: ev.info.sender, alt: ev.info.senderAlt, name: ev.info.pushName } : undefined, ev.history);
      case 'undecryptable':
        return this.undecryptable(ev);
      case 'history':
        return this.history(ev);
      case 'history_done':
        return this.historyDone(ev);
      case 'receipt':
        return this.receipt(ev);
      case 'chat_presence': {
        // Rarely arrives: WhatsApp sends it to companions that are online, and this one never says it is (docs/whatsapp.md).
        if (ev.fromMe || (ev.state !== 'composing' && ev.state !== 'paused') || ignoredChat(bare(ev.chat))) return;
        const conversation = this.mapper.convId(ev.chat);
        const author = this.mapper.who(ev.sender);
        this.host.emit(ev.state === 'composing' ? { t: 'typing', conversation, author, ttl: WHATSAPP_TYPING_TTL } : { t: 'typing', conversation, author, stop: true });
        return;
      }
      case 'push_name':
        this.aliases.link(ev.jid, ev.alt);
        return this.personChanged(this.mapper.who(ev.jid), { pushName: ev.name });
      case 'business_name':
        return this.personChanged(this.mapper.who(ev.jid), { businessName: ev.name });
      case 'contact':
        this.aliases.link(ev.jid, ev.alt);
        return this.personChanged(this.mapper.who(ev.jid), { fullName: ev.fullName, firstName: ev.firstName });
      case 'mute':
        return this.patchChat(ev.jid, { mute: ev.muted ? { level: 'none', ...(ev.until && ev.until > 0 && ev.until < 1e14 ? { until: ev.until * 1000 } : {}) } : { level: 'all' } });
      case 'archive':
        return this.patchChat(ev.jid, { archived: ev.archived });
      case 'pin':
        return;
      case 'mark_chat_read': {
        const conv = this.mapper.convId(ev.jid);
        if (!this.state.chat(conv)) return;
        this.host.emit(ev.read ? { t: 'read', conversation: conv, upToTs: ev.ts, unread: 0, mentions: 0 } : { t: 'read', conversation: conv, upToTs: 0, unread: 1 });
        return;
      }
      case 'delete_chat': {
        const conv = this.mapper.convId(ev.jid);
        if (!this.state.chat(conv)) return;
        this.state.dropChat(conv);
        this.host.emit({ t: 'leave', kind: 'conversation', nativeId: conv });
        return;
      }
      case 'clear_chat':
        return;
      case 'delete_for_me': {
        const conv = this.mapper.convId(ev.chat);
        const id = msgId(conv, ev.id);
        this.state.dropMsg(id);
        this.host.emit({ t: 'delete', conversation: conv, nativeId: id });
        return;
      }
      case 'picture':
        return this.picture(ev.jid, ev.remove ? undefined : ev.id);
      case 'group':
        return this.putGroup(ev.group);
      case 'group_change':
        return this.groupChange(ev);
      case 'join_request':
        return this.joinRequest(ev);
      case 'user_about':
        return this.userAbout(ev);
      case 'app_state_synced':
        if (ev.name === 'critical_unblock_low' || ev.name === 'regular_high') this.loadContacts().catch((e) => this.host.log('warn', `contacts: ${e.message}`));
        return;
      case 'offline_sync':
        if (ev.done) this.host.log('info', `caught up on ${ev.total} events received while offline`);
        return;
    }
  }

  private saveSelf() {
    const { loggedIn: _, ...rest } = this.self;
    this.state.set('self', JSON.stringify(rest));
  }

  private connected(ev: WaSelf) {
    this.phase = 'online';
    this.restarts = 0;
    this.self = { ...this.self, ...ev, loggedIn: true };
    if (this.self.jid && this.self.lid) this.aliases.link(this.self.jid, this.self.lid);
    this.saveSelf();
    const me = this.selfIds().id;
    this.personChanged(me, { pushName: ev.pushName, businessName: ev.businessName, phone: phoneOf(bare(ev.jid ?? '')) }, false);
    this.setStatus('online', null, this.selfIdentity());
    this.snapshot(false).catch((e) => this.host.log('warn', `snapshot: ${e?.message ?? e}`));
  }

  private unlinked(reason: string) {
    this.host.log('warn', `WhatsApp logged this device out (${reason})`);
    this.self = { loggedIn: false };
    this.joinReqs.clear();
    this.requestsKnown = false;
    this.linkPreviews.clear();
    this.state.set('self', null);
    this.phase = 'linking';
    this.setStatus('attention', { kind: 'link_device', message: 'WhatsApp unlinked this device (removed on the phone, or the phone was offline for 14 days). Getting a new code…' });
    // whatsmeow has deleted the session; a fresh bridge starts linking.
    this.respawn().catch(() => {});
  }

  private banned(message: string, expireSec: number) {
    this.phase = 'banned';
    const until = expireSec > 0 ? Date.now() + expireSec * 1000 : 0;
    const when = until ? ` It ends ${new Date(until).toISOString().replace('T', ' ').slice(0, 16)} UTC; dither-chat stays disconnected until then.` : ' dither-chat stays disconnected; press Reconnect once the ban is over.';
    this.setStatus('attention', { kind: 'rate_limited', message: `${message}.${when}` });
    this.bridge?.stop();
    if (until) this.banTimer = setTimeout(() => (this.phase = 'connecting', this.spawn()), expireSec * 1000 + 60_000);
  }

  private outdated() {
    this.phase = 'broken';
    this.setStatus('error', { kind: 'selector_broken', message: 'WhatsApp says this client is too old. Update whatsmeow in extractors/whatsapp/bridge (go get go.mau.fi/whatsmeow@latest), then restart the account.' });
    this.bridge?.stop();
  }

  // ---------------------------------------------------------------- people

  private nameOf(id: string): string {
    const p = this.state.person(id);
    const phone = p?.phone ?? this.aliases.jids(id).map(phoneOf).find(Boolean);
    return p?.fullName || p?.pushName || p?.businessName || phone || 'WhatsApp user';
  }

  private identity(id: string): P.IdentityFact {
    const p = this.state.person(id);
    const jids = this.aliases.jids(id);
    const phone = p?.phone ?? jids.map(phoneOf).find(Boolean);
    const isSelf = id === this.selfIds().id;
    const f: P.IdentityFact = { nativeId: id, displayName: this.nameOf(id) };
    if (phone) f.handle = phone;
    if (isSelf) f.isSelf = true;
    if (p?.fullName) f.contact = true;
    // Pictures for people you know or talk to, not for every stranger in a big group.
    if (isSelf || p?.fullName || this.state.chat(id)) f.avatarUrl = p?.avatar ?? avatarUrl(jids[0]);
    return f;
  }

  private selfIdentity(): P.IdentityFact {
    return this.identity(this.selfIds().id);
  }

  /** Emit an identity if it is new to this run or changed, or always with force. */
  private publish(id: string, force = false) {
    if (!id || id === 'self') return;
    const f = this.identity(id);
    const key = JSON.stringify(f);
    if (!force && this.published.get(id) === key) return;
    this.published.set(id, key);
    this.host.emit({ t: 'identity', identity: f });
  }

  private personChanged(id: string, patch: { fullName?: string; firstName?: string; pushName?: string; businessName?: string; phone?: string; avatar?: string }, emit = true) {
    if (!id) return;
    this.state.putPerson({ id, ...patch });
    if (emit || this.published.has(id)) this.publish(id);
  }

  private picture(jid: string, pictureId: string | undefined) {
    const j = bare(jid);
    if (isGroup(j)) {
      const chat = this.state.chat(j);
      if (chat) this.putChat(j, chat.jid, { ...chat.fact, avatarUrl: avatarUrl(j, pictureId) } as P.ConversationFact, 0);
      return;
    }
    const id = this.mapper.who(j);
    this.state.putPerson({ id, avatar: avatarUrl(j, pictureId) });
    this.publish(id);
  }

  private async loadContacts() {
    const list = await this.rpc.call<WaContact[]>('contacts');
    for (const c of list) {
      if (!isUser(bare(c.jid))) continue;
      this.aliases.link(c.jid, c.alt);
      const id = this.mapper.who(c.jid);
      this.state.putPerson({ id, fullName: c.fullName, firstName: c.firstName, pushName: c.pushName, businessName: c.businessName, phone: phoneOf(bare(c.jid)) ?? (c.alt ? phoneOf(bare(c.alt)) : undefined) });
      if (c.fullName) this.publish(id);
    }
  }

  // ---------------------------------------------------------------- conversations

  private putChat(id: string, jid: string, fact: P.ConversationFact, lastTs: number) {
    this.state.putChat({ id, jid, fact, lastTs });
    for (const p of fact.participants ?? []) this.publish(p);
    this.host.emit({ t: 'conversation', conversation: fact });
  }

  private patchChat(jid: string, patch: Partial<P.ConversationFact>) {
    const j = bare(jid);
    if (ignoredChat(j)) return;
    const id = this.mapper.convId(j);
    const cur = this.state.chat(id);
    if (!cur) {
      // Remember it for when the chat shows up.
      this.state.set(`patch:${id}`, JSON.stringify({ ...JSON.parse(this.state.get(`patch:${id}`) ?? '{}'), ...patch }));
      return;
    }
    this.putChat(id, cur.jid, { ...cur.fact, ...patch } as P.ConversationFact, 0);
  }

  /** Make sure the hub knows a conversation before a message lands in it. */
  private ensureChat(id: string, jid: string, ts: number, group: boolean) {
    const cur = this.state.chat(id);
    if (cur) {
      if (ts > cur.lastTs) this.state.putChat({ ...cur, lastTs: ts });
      return;
    }
    const saved = this.state.get(`patch:${id}`);
    const patch = saved ? JSON.parse(saved) : {};
    if (saved) this.state.set(`patch:${id}`, null);
    if (group) {
      this.putChat(id, jid, { nativeId: id, shape: 'group', name: 'WhatsApp group', encrypted: true, avatarUrl: avatarUrl(id), ...patch }, ts);
      this.fetchGroup(jid);
    } else {
      this.putChat(id, jid, this.mapper.direct(jid, patch), ts);
    }
  }

  /** then: after the group is in, with what WhatsApp said. */
  private fetchGroup(jid: string, then?: (g: WaGroup) => void | Promise<void>) {
    if (this.groupFetch.has(jid) || !this.bridge?.alive) return;
    const p = this.rpc
      .call<WaGroup>('group', { jid })
      .then(async (g) => {
        this.putGroup(g);
        await then?.(g);
      })
      .catch((e) => this.host.log('warn', `group ${jid}: ${e.message}`))
      .finally(() => setTimeout(() => this.groupFetch.delete(jid), 30_000));
    this.groupFetch.set(jid, p);
  }

  private putGroup(g: WaGroup) {
    this.groups.set(g.jid, { g, at: Date.now() });
    if (g.addressing) this.state.set(`addr:${g.jid}`, g.addressing);
    if (g.ephemeral) this.state.set(`timer:${g.jid}`, String(g.ephemeral));
    else this.state.set(`timer:${g.jid}`, null);
    const { conversation, space } = this.mapper.group(g);
    if (space) this.host.emit({ t: 'space', space });
    if (conversation) {
      const cur = this.state.chat(g.jid);
      const keep: Partial<P.ConversationFact> = {};
      if (cur?.fact.mute) keep.mute = cur.fact.mute;
      if (cur?.fact.archived !== undefined) keep.archived = cur.fact.archived;
      if (cur?.fact.avatarUrl) keep.avatarUrl = cur.fact.avatarUrl;
      const saved = this.state.get(`patch:${g.jid}`);
      if (saved) this.state.set(`patch:${g.jid}`, null);
      this.putChat(g.jid, g.jid, { ...conversation, ...keep, ...(saved ? JSON.parse(saved) : {}) }, cur?.lastTs ?? 0);
    }
  }

  private groupChange(ev: Extract<BridgeEvent, { t: 'group_change' }>) {
    const jid = bare(ev.jid);
    for (const [j, a] of Object.entries(ev.alts ?? {})) this.aliases.link(j, a);
    this.aliases.link(ev.sender, ev.senderPn);
    // In: whoever asked is answered, here or elsewhere.
    for (const j of ev.join) this.joinRequestsGone(jid, j);
    if (ev.deleted || ev.leave.some((j) => this.mapper.isSelf(j))) {
      this.joinRequestsGone(jid);
      this.groups.delete(jid);
      this.state.dropChat(jid);
      this.host.emit({ t: 'leave', kind: 'conversation', nativeId: jid });
      return;
    }
    const actor = ev.sender ? this.mapper.who(ev.sender) : '';
    const who = actor === this.selfIds().id ? 'You' : actor ? this.nameOf(actor) : 'Someone';
    const names = (js: string[]) => js.map((j) => (this.mapper.isSelf(j) ? 'you' : this.nameOf(this.mapper.who(j)))).join(', ');
    const lines: string[] = [];
    if (ev.name !== undefined) lines.push(`${who} renamed the group to “${ev.name}”.`);
    if (ev.topic !== undefined) lines.push(`${who} changed the group description.`);
    if (ev.join.length) lines.push(ev.join.length === 1 && this.mapper.who(ev.join[0]) === actor ? `${who} joined.` : `${who} added ${names(ev.join)}.`);
    if (ev.leave.length) lines.push(ev.leave.length === 1 && this.mapper.who(ev.leave[0]) === actor ? `${who} left.` : `${who} removed ${names(ev.leave)}.`);
    const promote = ev.promote ?? [];
    const demote = ev.demote ?? [];
    if (promote.length) lines.push(`${who} made ${names(promote)} ${promote.length > 1 ? 'admins' : 'an admin'}.`);
    if (demote.length) lines.push(`${who} removed ${names(demote)} as admin.`);
    if (lines.length && this.state.chat(jid)) {
      this.host.emit({ t: 'message', message: { nativeId: msgId(jid, `gc-${ev.ts}`), conversation: jid, author: actor || this.selfIds().id, ts: ev.ts, kind: 'system', body: lines.join(' ') }, live: true });
    }
    // Admins made and unmade: in a community's own parent group that is the community's admin.
    const community = !!this.groups.get(jid)?.g.isParent;
    if (community || this.state.chat(jid)) {
      const target: P.AboutTarget = { kind: community ? 'space' : 'conversation', nativeId: jid };
      for (const [js, given] of [[promote, true], [demote, false]] as const) {
        for (const j of js) {
          const member = this.mapper.who(j);
          this.publish(member);
          this.host.emit({ t: 'role', target, member, role: 'Admin', given, ...(actor ? { by: actor } : {}), ...(ev.ts > 0 ? { ts: ev.ts } : {}) });
        }
      }
    }
    // Made or unmade an admin, or join approval switched: what waits on you here is read again (one query).
    const recheck = !!ev.approvalMode || [...promote, ...demote].some((j) => this.mapper.isSelf(j));
    this.groupFetch.delete(jid);
    this.fetchGroup(jid, recheck ? (g) => this.recheckJoinRequests(g) : undefined);
  }

  /** Groups and contacts, at most every few minutes. force: on request. */
  private async snapshot(force: boolean) {
    if (!force && Date.now() - this.lastSnapshot < (this.opts.snapshotEveryMs ?? 10 * 60_000)) return;
    this.lastSnapshot = Date.now();
    this.publish(this.selfIds().id);
    await this.loadContacts().catch((e) => this.host.log('warn', `contacts: ${e.message}`));
    const groups = await this.rpc.call<WaGroup[]>('groups');
    const seen = new Set<string>();
    // Communities first, so their groups land in a known space.
    for (const g of [...groups].sort((a, b) => Number(!!b.isParent) - Number(!!a.isParent))) {
      seen.add(g.jid);
      this.putGroup(g);
    }
    if (force) {
      for (const c of this.state.chats()) {
        if (isGroup(c.id) && !seen.has(c.id)) {
          this.groups.delete(c.id);
          this.joinRequestsGone(c.id);
          this.state.dropChat(c.id);
          this.host.emit({ t: 'leave', kind: 'conversation', nativeId: c.id });
        }
      }
    }
    await this.loadJoinRequests(groups);
    for (const c of this.state.chats()) if (!isGroup(c.id)) this.publish(c.id);
    this.host.log('info', `snapshot: ${groups.length} groups, ${this.state.chats().length} chats`);
  }

  // ---------------------------------------------------------------- messages

  private apply(out: MapOut, pushName?: { jid: string; alt?: string; name: string }, history?: boolean) {
    if (pushName) {
      this.aliases.link(pushName.jid, pushName.alt);
      const id = this.mapper.who(pushName.jid);
      this.state.putPerson({ id, pushName: pushName.name });
    }
    for (const t of out.touched) this.ensureChat(t.id, t.jid, t.ts, t.group);
    for (const m of out.remember) this.state.putMsg(m);
    for (const id of out.forget) this.state.dropMsg(id);
    for (const ev of out.events) {
      if (ev.t === 'message') {
        this.publish(ev.message.author);
        for (const r of ev.message.reactions ?? []) for (const a of r.authors) this.publish(a);
        const exp = contextOf(this.state.msg(ev.message.nativeId)?.content)?.expiration;
        if (exp) this.state.set(`timer:${ev.message.conversation}`, String(exp));
      } else if (ev.t === 'reaction') this.publish(ev.author);
      this.host.emit(ev);
    }
    if (history) for (const t of out.touched) this.historyCounts.set(t.id, (this.historyCounts.get(t.id) ?? 0) + out.events.length);
  }

  private undecryptable(ev: Extract<BridgeEvent, { t: 'undecryptable' }>) {
    if (ev.unavailableType === 'view_once') return;
    const info = ev.info;
    const out = this.mapper.message({ info, message: { conversation: 'x' } });
    const fact = out.events.find((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message');
    if (!fact) return;
    fact.message.kind = 'encrypted';
    fact.message.body = 'Waiting for this message. Opening WhatsApp on your phone can help.';
    out.remember = [];
    this.apply(out);
  }

  private history(ev: Extract<BridgeEvent, { t: 'history' }>) {
    for (const m of ev.lidMappings) this.aliases.link(m.pn, m.lid);
    for (const p of ev.pushnames) {
      if (!isUser(bare(p.jid))) continue;
      this.state.putPerson({ id: this.mapper.who(p.jid), pushName: p.name });
    }
    for (const c of ev.conversations) {
      const h = this.mapper.historyConversation(c);
      if (!h) continue;
      const id = this.mapper.convId(h.chat);
      if (c.ephemeralExpiration) this.state.set(`timer:${id}`, String(c.ephemeralExpiration));
      const cur = this.state.chat(id);
      const base: P.ConversationFact = cur?.fact
        ? (cur.fact as P.ConversationFact)
        : isGroup(h.chat)
          ? { nativeId: id, shape: 'group', name: h.patch.name ?? 'WhatsApp group', encrypted: true, avatarUrl: avatarUrl(id) }
          : this.mapper.direct(h.chat);
      this.putChat(id, cur?.jid ?? h.chat, { ...base, ...h.patch }, h.lastTs ?? 0);
      if (isGroup(h.chat) && !cur) this.fetchGroup(h.chat);
      if (h.unread !== undefined && ev.syncType !== 'ON_DEMAND') this.pendingReads.set(id, { unread: h.unread, lastTs: h.lastTs ?? 0 });
    }
    this.host.log('info', `history sync ${ev.syncType} #${ev.chunkOrder ?? 0}: ${ev.conversations.length} chats${ev.progress ? `, ${ev.progress}%` : ''}`);
  }

  private historyDone(ev: Extract<BridgeEvent, { t: 'history_done' }>) {
    // Read state after the messages, so the counts land on conversations that have them.
    for (const [conv, r] of this.pendingReads) {
      const upTo = r.unread ? (this.state.db.query('SELECT ts FROM msg WHERE conversation = ? ORDER BY ts DESC LIMIT 1 OFFSET ?').get(conv, r.unread) as { ts: number } | null)?.ts ?? 0 : Math.max(r.lastTs, Date.now() - 1000);
      this.host.emit({ t: 'read', conversation: conv, upToTs: upTo, unread: r.unread, mentions: 0 });
    }
    this.pendingReads.clear();
    if (ev.syncType === 'ON_DEMAND') {
      for (const [conv, w] of this.historyWaiters) {
        const n = this.historyCounts.get(conv);
        if (n !== undefined) {
          this.historyWaiters.delete(conv);
          w(n);
        }
      }
    }
    this.historyCounts.clear();
  }

  private receipt(ev: Extract<BridgeEvent, { t: 'receipt' }>) {
    const chat = bare(ev.chat);
    if (ignoredChat(chat)) return;
    if (!ev.fromMe) return this.othersReceipt(ev, chat);
    // Your phone (or another linked device) read these: that is read state.
    if (ev.type !== 'read-self' && ev.type !== 'read') return;
    const conv = this.mapper.convId(chat);
    if (!this.state.chat(conv)) return;
    let upTo = 0;
    for (const id of ev.ids) upTo = Math.max(upTo, this.state.msg(msgId(conv, id))?.ts ?? 0);
    if (!upTo) upTo = ev.ts;
    const acked = Number(this.state.get(`acked:${conv}`) ?? 0);
    if (upTo > acked) this.state.set(`acked:${conv}`, String(upTo));
    this.host.emit({ t: 'read', conversation: conv, upToTs: upTo });
  }

  /**
   * Someone else got, read or played messages you sent. Each of their devices says so, and in groups each member:
   * one receipt per reader and message for each step further, for messages this account knows it sent.
   */
  private othersReceipt(ev: Extract<BridgeEvent, { t: 'receipt' }>, chat: string) {
    const state = RECEIPT_STATE[ev.type];
    if (!state) return;
    this.aliases.link(ev.sender, ev.senderAlt);
    // A DM is the reader's; one never seen is no chat of yours.
    const conv = isGroup(chat) ? chat : this.aliases.peek(chat);
    if (!conv || !this.state.chat(conv)) return;
    const who = this.mapper.who(ev.sender);
    if (!who || who === this.selfIds().id) return;
    const rank = RECEIPT_RANK[state];
    const messages: string[] = [];
    for (const wid of ev.ids) {
      const id = msgId(conv, wid);
      if (!this.state.msg(id)?.fromMe) continue;
      const k = `${id} ${who}`;
      if ((this.receipts.get(k) ?? 0) >= rank) continue;
      this.receipts.delete(k);
      this.receipts.set(k, rank);
      messages.push(id);
    }
    for (const k of this.receipts.keys()) {
      if (this.receipts.size <= RECEIPTS_KEPT) break;
      this.receipts.delete(k);
    }
    if (!messages.length) return;
    this.publish(who);
    this.host.emit({ t: 'receipt', conversation: conv, messages, who, state, ts: ev.ts > 0 ? ev.ts : Date.now() });
  }

  /**
   * Someone's About changed. WhatsApp pushes this for your contacts; it is passed on only for people you know (in your
   * contacts, or with a chat), never asked for.
   */
  private userAbout(ev: Extract<BridgeEvent, { t: 'user_about' }>) {
    const self = this.mapper.isSelf(ev.jid) || (!!ev.alt && this.mapper.isSelf(ev.alt));
    if (!self && !this.aliases.peek(ev.jid) && !(ev.alt && this.aliases.peek(ev.alt))) return;
    this.aliases.link(ev.jid, ev.alt);
    const who = self ? this.selfIds().id : this.mapper.who(ev.jid);
    if (!self && !this.state.person(who)?.fullName && !this.state.chat(who)) return;
    // A profile asked about recently shows the new About without asking again.
    const asked = this.userInfo.get(who);
    if (asked) this.userInfo.set(who, { at: asked.at, u: asked.u.then((u) => u && { ...u, status: ev.status }) });
    this.publish(who);
    this.host.emit({ t: 'customStatus', who, ...(ev.status ? { text: ev.status } : {}), ...(ev.ts && ev.ts > 0 ? { ts: ev.ts } : {}) });
  }

  private sweepExpired() {
    const now = Date.now();
    for (const m of this.state.expired(now)) {
      this.state.dropMsg(m.id);
      this.host.emit({ t: 'delete', conversation: m.conversation, nativeId: m.id, reason: 'expired' });
    }
    // Pins lapse after the time the pinner chose; WhatsApp sends nothing then.
    for (const p of this.state.lapsedPins(now)) this.host.emit({ t: 'pin', conversation: p.conversation, message: p.msg, pinned: false, ts: p.expires });
  }

  // ---------------------------------------------------------------- commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments);
      case 'forward':
        return this.forward(cmd.conversation, cmd.source, cmd.note);
      case 'openDirect':
        return this.openDirect(cmd.peer);
      case 'history':
        return this.fetchHistory(cmd.conversation, cmd.beforeTs, cmd.limit);
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'typing':
        return this.sendTyping(cmd.conversation, !!cmd.stop);
      case 'react':
        return this.react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove);
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors': {
        const rows = this.state.db.query('SELECT author FROM react WHERE msg = ? AND key = ?').all(cmd.message, cmd.key) as { author: string }[];
        for (const r of rows) this.publish(r.author);
        return { authors: rows.map((r) => r.author) };
      }
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'redact':
        return this.redact(cmd.conversation, cmd.message);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'about':
        return this.about(cmd.target);
      case 'configure':
        return this.configure(cmd.target, cmd.change);
      case 'profile':
        return this.profile(cmd.who);
      case 'setProfile':
        return this.setProfile(cmd.change);
      case 'resolve':
        return this.resolve(cmd.ref);
      case 'add':
        return this.add(cmd.ref, cmd.action);
      case 'answer':
        return this.answer(cmd.request, cmd.answer);
      case 'call':
        throw new Error('WhatsApp calls are not supported');
      case 'createGroup':
        // Left out on purpose (no capability; the bridge has no way to): said, never sent.
        throw new Error(createGroupNotBuilt('whatsapp'));
      case 'lab':
      case 'shutdown':
        return undefined;
    }
  }

  /**
   * A chat state ("composing", then "paused"), as mautrix-whatsapp sends by default. It is not a presence: the device
   * stays unavailable, so the phone keeps its notifications. Never `presence available` from here.
   */
  private async sendTyping(conversation: string, stop: boolean) {
    if (!this.self.loggedIn) throw new Error('WhatsApp is not linked');
    await this.rpc.call('chatPresence', { chat: this.chatJid(conversation), state: stop ? 'paused' : 'composing' });
    return {};
  }

  /** JID to send to for a conversation. */
  private chatJid(conversation: string): string {
    const c = this.state.chat(conversation);
    if (c) return c.jid;
    if (isGroup(conversation)) return conversation;
    return this.aliases.jids(conversation)[0];
  }

  private ownJid(): string {
    return bare(this.self.jid ?? '');
  }

  /** The JID to mention someone by, in the addressing mode this chat uses. */
  private mentionJid(chat: string, id: string): string | null {
    const jids = this.aliases.jids(id).filter(isUser);
    if (!jids.length) return null;
    const lid = this.state.get(`addr:${chat}`) === 'lid';
    return (lid ? jids.find((j) => !isPhoneJid(j)) : jids.find(isPhoneJid)) ?? jids[0];
  }

  /** contextInfo for a reply: the quoted message's key and content. */
  private replyContext(chat: string, replyTo: string | undefined): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    const timer = Number(this.state.get(`timer:${this.mapper.convId(chat)}`) ?? 0);
    if (timer) ctx.expiration = timer;
    if (!replyTo) return ctx;
    const q = this.state.msg(replyTo);
    if (!q) return ctx;
    ctx.stanzaID = q.wid;
    ctx.participant = q.fromMe ? this.ownJid() : q.sender || q.chat;
    if (q.content) ctx.quotedMessage = quotable(q.content);
    return ctx;
  }

  private async send(conversation: string, body: string, replyTo: string | undefined, attachments: P.OutgoingAttachment[] | undefined): Promise<{ nativeId: string }> {
    this.requireLinked();
    const chat = this.chatJid(conversation);
    const wa = toWhatsApp(body, (id) => this.mentionJid(chat, id), (id) => this.nameOf(id));
    const base = this.replyContext(chat, replyTo);
    const ctx = { ...base, ...(wa.mentions.length ? { mentionedJID: wa.mentions } : {}) };
    const hasCtx = Object.keys(ctx).length > 0;
    let first: string | undefined;
    const textMessage = (): WaMessage => (hasCtx ? { extendedTextMessage: { text: wa.text, contextInfo: ctx } } : { conversation: wa.text });
    if (attachments?.length) {
      // WhatsApp audio has no caption field, so the text of a leading audio goes out as its own message first.
      const textFirst = attachments[0].kind === 'audio' && !!wa.text.trim();
      const plain = base.expiration ? { expiration: base.expiration } : {};
      for (const [i, a] of attachments.entries()) {
        const lead = i === 0 && !textFirst;
        const m = await this.mediaMessage(a, lead ? wa.text : '', lead ? ctx : plain);
        if (i === 0 && textFirst) first = await this.sendRaw(chat, textMessage());
        const id = await this.sendRaw(chat, m);
        first ??= id;
      }
      return { nativeId: first! };
    }
    if (!wa.text.trim()) throw new Error('nothing to send');
    return { nativeId: await this.sendRaw(chat, textMessage()) };
  }

  /** Send a message and publish it (WhatsApp does not echo what this device sends). */
  private async sendRaw(chat: string, message: WaMessage): Promise<string> {
    const r = await this.rpc.call<{ id: string; ts: number }>('send', { chat, message }, 120_000);
    const out = this.mapper.message({ info: { id: r.id, chat, sender: this.ownJid(), fromMe: true, isGroup: isGroup(chat), ts: r.ts || Date.now() }, message });
    this.apply(out);
    return msgId(this.mapper.convId(chat), r.id);
  }

  private async mediaMessage(a: P.OutgoingAttachment, caption: string, ctx: Record<string, unknown>): Promise<WaMessage> {
    const kind = a.kind === 'image' && a.mime !== 'image/gif' ? 'image' : a.kind === 'video' ? 'video' : a.kind === 'audio' ? 'audio' : 'document';
    const up = await this.rpc.call<{ url: string; directPath: string; mediaKey: string; fileEncSHA256: string; fileSHA256: string; fileLength: number; thumbnail?: string; width?: number; height?: number }>('upload', { path: a.path, kind }, 300_000);
    const media: Record<string, unknown> = {
      url: up.url,
      directPath: up.directPath,
      mediaKey: up.mediaKey,
      fileEncSHA256: up.fileEncSHA256,
      fileSHA256: up.fileSHA256,
      fileLength: String(up.fileLength),
      mimetype: a.mime,
    };
    if (Object.keys(ctx).length) media.contextInfo = ctx;
    if (caption && kind !== 'audio') media.caption = caption;
    if (kind === 'image') {
      if (up.thumbnail) media.JPEGThumbnail = up.thumbnail;
      if (up.width) media.width = up.width;
      if (up.height) media.height = up.height;
      return { imageMessage: media };
    }
    if (kind === 'video') return { videoMessage: media };
    if (kind === 'audio') return { audioMessage: media };
    media.fileName = a.name;
    media.title = a.name;
    return { documentMessage: media };
  }

  private async forward(conversation: string, source: { conversation: string; message: string }, note?: string): Promise<{ nativeId?: string; fallback?: string }> {
    this.requireLinked();
    const src = this.state.msg(source.message);
    if (!src?.content) return { fallback: 'the original is not in this WhatsApp account’s store' };
    const fwd = forwardable(src.content);
    if (!fwd) return { fallback: 'WhatsApp cannot forward this kind of message' };
    const chat = this.chatJid(conversation);
    const timer = Number(this.state.get(`timer:${this.mapper.convId(chat)}`) ?? 0);
    if (timer) {
      const inner = Object.values(fwd)[0] as Record<string, any>;
      inner.contextInfo = { ...inner.contextInfo, expiration: timer };
    }
    const nativeId = await this.sendRaw(chat, fwd);
    if (note?.trim()) await this.send(conversation, note, undefined, undefined);
    return { nativeId };
  }

  private async openDirect(peer: string): Promise<P.OpenDirectResult> {
    this.requireLinked();
    let jid = peer.includes('@') ? bare(peer) : '';
    if (!jid) {
      const phone = peer.replace(/[^\d+]/g, '');
      const [r] = await this.rpc.call<{ query: string; jid: string; isIn: boolean; alt?: string }[]>('isOnWhatsApp', { phones: [phone.startsWith('+') ? phone : `+${phone}`] });
      if (!r?.isIn) throw new Error(`${peer} is not on WhatsApp`);
      jid = bare(r.jid);
      this.aliases.link(jid, r.alt);
    }
    const id = this.mapper.convId(jid);
    const existed = !!this.state.chat(id);
    if (!existed) this.ensureChat(id, jid, 0, false);
    return { conversation: id, existed, startsAtFirstSend: !existed };
  }

  private async fetchHistory(conversation: string, beforeTs: number | undefined, limit: number): Promise<{ count: number; done: boolean }> {
    this.requireLinked();
    const oldest = this.state.oldest(conversation);
    if (!oldest || (beforeTs !== undefined && oldest.ts > beforeTs + 60_000)) return { count: 0, done: true };
    const prev = this.historyWaiters.get(conversation);
    if (prev) prev(0);
    const got = new Promise<number>((resolve) => {
      this.historyWaiters.set(conversation, resolve);
      setTimeout(() => {
        if (this.historyWaiters.get(conversation) === resolve) this.historyWaiters.delete(conversation);
        resolve(0);
      }, this.opts.historyTimeoutMs ?? 40_000);
    });
    await this.rpc.call('historyRequest', { chat: oldest.chat, msgId: oldest.wid, fromMe: oldest.fromMe, ts: oldest.ts, sender: oldest.sender, count: Math.min(Math.max(limit, 1), 50) });
    const count = await got;
    return { count, done: count === 0 };
  }

  private async markRead(conversation: string, upTo: string) {
    this.requireLinked();
    const target = this.state.msg(upTo);
    const upToTs = target?.ts ?? Date.now();
    const acked = Number(this.state.get(`acked:${conversation}`) ?? 0);
    const msgs = this.state.incomingUpTo(conversation, upToTs, acked);
    if (msgs.length) {
      const chat = this.chatJid(conversation);
      const bySender = new Map<string, StoredMsg[]>();
      for (const m of msgs) (bySender.get(m.sender) ?? bySender.set(m.sender, []).get(m.sender)!).push(m);
      for (const [sender, list] of bySender) {
        await this.rpc.call('markRead', { chat, sender: isGroup(chat) ? sender : '', ids: list.map((m) => m.wid), ts: Date.now() });
      }
    }
    if (upToTs > acked) this.state.set(`acked:${conversation}`, String(upToTs));
    this.host.emit({ t: 'read', conversation, upToTs });
    return { marked: msgs.length };
  }

  private messageKey(m: StoredMsg) {
    const key: Record<string, unknown> = { remoteJID: m.chat, fromMe: m.fromMe, ID: m.wid };
    if (!m.fromMe && isGroup(m.chat) && m.sender) key.participant = m.sender;
    return key;
  }

  private async react(conversation: string, message: string, key: string, remove: boolean) {
    this.requireLinked();
    const m = this.state.msg(message);
    if (!m) throw new Error('That message is not in this WhatsApp account’s store');
    const me = this.selfIds().id;
    const prev = this.state.reaction(message, me);
    if (remove && prev !== key) return {};
    await this.rpc.call('send', { chat: m.chat, message: { reactionMessage: { key: this.messageKey(m), text: remove ? '' : key, senderTimestampMS: String(Date.now()) } } });
    if (prev && prev !== key) this.host.emit({ t: 'reaction', conversation, message, author: me, key: prev, remove: true });
    this.host.emit({ t: 'reaction', conversation, message, author: me, key, ...(remove ? { remove: true } : {}) });
    this.state.setReaction(message, me, remove ? null : key);
    return {};
  }

  private reactionContext(conversation: string): P.ReactionContext {
    const c = this.state.chat(conversation);
    if (!c) return { canReact: false, reason: 'Not in this chat any more', custom: [] };
    return { canReact: true, reason: 'One reaction per person: a new one replaces yours', custom: [] };
  }

  private async edit(conversation: string, message: string, body: string) {
    this.requireLinked();
    const m = this.state.msg(message);
    if (!m?.fromMe) throw new Error('You can only edit your own messages');
    if (Date.now() - m.ts > EDIT_WINDOW_MS) throw new Error('WhatsApp only allows edits in the first 15 minutes');
    const wa = toWhatsApp(body, (id) => this.mentionJid(m.chat, id), (id) => this.nameOf(id));
    const edited: WaMessage = wa.mentions.length ? { extendedTextMessage: { text: wa.text, contextInfo: { mentionedJID: wa.mentions } } } : { conversation: wa.text };
    const pm = { key: { remoteJID: m.chat, fromMe: true, ID: m.wid }, type: 'MESSAGE_EDIT', editedMessage: edited, timestampMS: String(Date.now()) };
    const r = await this.rpc.call<{ id: string; ts: number }>('send', { chat: m.chat, message: { editedMessage: { message: { protocolMessage: pm } } } });
    this.apply(this.mapper.message({ info: { id: r.id, chat: m.chat, sender: this.ownJid(), fromMe: true, isGroup: isGroup(m.chat), ts: r.ts || Date.now() }, message: { protocolMessage: pm }, flags: ['edit'] }));
    return {};
  }

  private async redact(conversation: string, message: string) {
    this.requireLinked();
    const m = this.state.msg(message);
    if (!m) throw new Error('That message is not in this WhatsApp account’s store');
    await this.rpc.call('send', { chat: m.chat, message: { protocolMessage: { key: this.messageKey(m), type: 'REVOKE' } } });
    this.state.dropMsg(message);
    this.host.emit({ t: 'delete', conversation, nativeId: message });
    return {};
  }

  private async fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
    if (url.startsWith('wa-media:')) {
      const id = url.slice('wa-media:'.length);
      const m = this.state.msg(id);
      const media = mediaOf(m?.content);
      if (!m || !media) throw new Error('unknown WhatsApp media');
      const dir = join(this.host.accountDir, 'tmp');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dest = join(dir, crypto.randomUUID());
      try {
        const r = await this.rpc.call<{ path: string; directPath?: string }>('download', { message: { [media.key]: media.media }, dest, info: { id: m.wid, chat: m.chat, sender: m.sender, fromMe: m.fromMe } }, 120_000);
        if (r.directPath) this.state.updateContent(id, { ...m.content, [media.key]: { ...media.media, directPath: r.directPath } });
        const mime = (media.media.mimetype || 'application/octet-stream').split(';')[0].trim();
        return { mime, base64: readFileSync(dest).toString('base64') };
      } finally {
        if (existsSync(dest)) rmSync(dest);
      }
    }
    if (url.startsWith('wa-avatar:')) {
      const jid = url.slice('wa-avatar:'.length).split('?')[0];
      const miss = this.noAvatar.get(jid);
      if (miss && Date.now() - miss < 6 * 3600_000) throw new Error('no profile picture');
      const chat = this.state.chat(jid);
      const community = isGroup(jid) && !chat; // a community's parent group is a space, not a chat
      const p = await this.rpc.call<{ url: string; id: string } | null>('avatar', { jid, community });
      if (!p?.url) {
        this.noAvatar.set(jid, Date.now());
        throw new Error('no profile picture');
      }
      const res = await (this.opts.fetch ?? fetch)(p.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`profile picture: HTTP ${res.status}`);
      return { mime: res.headers.get('content-type') ?? 'image/jpeg', base64: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }
    throw new Error(`WhatsApp cannot fetch ${url.split(':')[0]} URLs`);
  }

  // ---------------------------------------------------------------- about and settings (docs/group-settings.md)

  /** A group or community as WhatsApp has it now, or as read in the last minute when fresh is false. */
  private async loadGroup(jid: string, fresh: boolean): Promise<WaGroup> {
    const c = this.groups.get(jid);
    if (!fresh && c && Date.now() - c.at < GROUP_FRESH_MS) return c.g;
    const g = await this.rpc.call<WaGroup>('group', { jid });
    this.putGroup(g);
    return g;
  }

  /**
   * Where you stand in a group. Your own entry may be under your LID or your phone number. A community and its
   * announcement group only let admins edit, locked or not; other groups let everyone unless locked.
   */
  private standing(g: WaGroup) {
    const me = g.participants.find((p) => [p.jid, p.pn, p.lid].some((j) => this.mapper.isSelf(j)));
    const announcements = !!(g.linkedParent && g.isDefaultSub);
    const admin = !!(me?.admin || me?.superAdmin);
    return { admin, owner: !!me?.superAdmin, announcements, info: admin || (!g.isLocked && !g.isParent && !announcements) };
  }

  private async about(target: P.AboutTarget): Promise<P.About> {
    this.requireLinked();
    if (target.kind === 'conversation' && !isGroup(target.nativeId)) return this.aboutDirect(target.nativeId);
    return this.aboutGroup(target.kind, await this.loadGroup(target.nativeId, true), true);
  }

  /** readLink: ask WhatsApp for the invite link (admins only), else use the one read last. */
  private async aboutGroup(kind: P.AboutTarget['kind'], g: WaGroup, readLink: boolean): Promise<P.About> {
    const space = kind === 'space';
    const { admin, owner, announcements, info } = this.standing(g);
    const noun = space ? 'Community' : 'Group';
    const lockedInfo = space ? COMMUNITY_INFO : LOCKED_INFO;
    const fields: P.AboutFields = {};
    const set = <K extends P.AboutKey>(k: K, value: P.AboutValues[K] | null, canEdit: boolean, reason?: string) => {
      if (ABOUT_RULES.whatsapp[kind].includes(k)) (fields as Record<string, P.AboutSetting>)[k] = { value, canEdit, ...(reason && !canEdit ? { reason } : {}) };
    };
    const addMode = g.memberAddMode === 'all_member_add' ? 'everyone' : g.memberAddMode === 'admin_add' ? 'admins' : null;
    set('name', g.name, info, lockedInfo);
    set('topic', g.topic ?? '', info, lockedInfo);
    set('avatar', (this.state.chat(g.jid)?.fact.avatarUrl as string | undefined) ?? avatarUrl(g.jid), false, info ? NO_PICTURE : lockedInfo);
    set('disappearing', g.ephemeral ?? 0, info, lockedInfo);
    set('announceOnly', !!g.isAnnounce, admin && !announcements, announcements ? 'A community’s announcement group is always admins only.' : ONLY_ADMINS);
    set('editInfo', g.isLocked ? 'admins' : 'everyone', admin, ONLY_ADMINS);
    set('addMembers', addMode, admin, space ? COMMUNITY_INFO : ONLY_ADMINS);
    set('joinApproval', !!g.joinApproval, admin, space ? COMMUNITY_INFO : ONLY_ADMINS);
    set('encrypted', true, false, ALWAYS_E2EE);

    const ownerRole = `${noun} owner`;
    const list: P.AboutMember[] = [];
    for (const p of g.participants) {
      const id = this.mapper.who(p.jid);
      this.publish(id);
      const top = !!p.superAdmin || (!!p.admin && [p.jid, p.pn, p.lid].some((j) => !!j && (j === g.ownerJid || j === g.ownerPn)));
      list.push(top ? { id, role: ownerRole, rank: 110 } : p.admin ? { id, role: 'Admin', rank: 100 } : { id, role: 'Member', rank: 0 });
    }
    const count = (rank: number) => list.filter((m) => m.rank === rank).length;
    const admins = space ? 'Community admins' : 'Only admins';
    const who = (everyone: boolean) => (everyone ? 'All members' : admins);
    const rules: P.AboutRule[] = space
      ? [
          { what: 'Edit name and description', who: admins, you: info },
          { what: 'Add members', who: addMode ? who(addMode === 'everyone') : admins, you: admin || addMode === 'everyone' },
          { what: 'Change these settings and the invite link', who: admins, you: admin },
        ]
      : [
          { what: 'Edit name, description and disappearing messages', who: who(!g.isLocked && !announcements), you: info },
          { what: 'Add members', who: addMode ? who(addMode === 'everyone') : admins, you: admin || addMode === 'everyone' },
          { what: 'Send messages', who: who(!g.isAnnounce), you: admin || !g.isAnnounce },
          { what: 'Change these settings and the invite link', who: admins, you: admin },
        ];

    let invite: P.AboutInvite = { link: null, canCreate: false, reason: INVITE_ADMINS };
    if (admin) {
      // WhatsApp has no "turn the link off", only a new link in place of the old one: no canRevoke.
      invite = { link: this.inviteLinks.get(g.jid) ?? null, canCreate: true };
      if (readLink || !this.inviteLinks.has(g.jid)) {
        try {
          invite.link = (await this.rpc.call<{ link: string } | null>('groupInviteLink', { jid: g.jid, reset: false }))?.link ?? null;
          this.inviteLinks.set(g.jid, invite.link);
        } catch (e: any) {
          invite.reason = `Could not read the link: ${e?.message ?? e}`;
        }
      }
    }
    const total = Math.max(g.count ?? 0, list.length);
    return {
      noun,
      fields,
      members: { list, total, complete: list.length >= total },
      roles: [
        { id: 'superadmin', name: ownerRole, rank: 110, count: count(110) },
        { id: 'admin', name: 'Admin', rank: 100, count: count(100) },
        { id: 'member', name: 'Member', rank: 0, count: count(0) },
      ],
      rules,
      you: owner ? { role: ownerRole, rank: 110 } : admin ? { role: 'Admin', rank: 100 } : { role: 'Member', rank: 0 },
      invite,
      ...(g.created ? { facts: [{ label: 'Created', value: new Date(g.created).toISOString().slice(0, 10) }] } : {}),
    };
  }

  /** A 1:1 chat: its disappearing timer (either of you may set it) and its two people. */
  private aboutDirect(id: string): P.About {
    if (!this.state.chat(id)) throw new Error('This chat is not in this WhatsApp account');
    const me = this.selfIds().id;
    const self = id === me;
    this.publish(me);
    this.publish(id);
    return {
      noun: 'Chat',
      fields: {
        disappearing: { value: Number(this.state.get(`timer:${id}`) ?? 0), canEdit: true },
        encrypted: { value: true, canEdit: false, reason: ALWAYS_E2EE },
      },
      members: { list: self ? [{ id: me }] : [{ id: me }, { id }], complete: true },
      rules: [{ what: 'Change disappearing messages', who: self ? 'You' : 'Either of you', you: true }],
    };
  }

  /**
   * One change, one bridge call, then the group read again so the hub hears the new name or topic. Settings only:
   * nothing here adds or removes people.
   */
  private async configure(target: P.AboutTarget, change: P.AboutChange): Promise<P.About> {
    this.requireLinked();
    if (change.key === 'pin') throw new Error('WhatsApp keeps no list of pinned messages to read, so pins are not offered here');
    if (change.key === 'avatar') throw new Error(NO_PICTURE);
    if (change.key !== 'invite' && !ABOUT_RULES.whatsapp[target.kind].includes(change.key)) throw new Error(`${ABOUT_LABEL[change.key] ?? change.key} is not a WhatsApp setting here`);
    if (change.key === 'disappearing' && !ABOUT_RULES.whatsapp.disappearing!.includes(change.value)) throw new Error(`WhatsApp offers disappearing messages of 24 hours, 7 days or 90 days, not ${durationLabel(change.value)}`);
    if (target.kind === 'conversation' && !isGroup(target.nativeId)) return this.configureDirect(target.nativeId, change);

    const jid = target.nativeId;
    const g = await this.loadGroup(jid, false);
    const { admin, announcements, info } = this.standing(g);
    const lockedInfo = target.kind === 'space' ? COMMUNITY_INFO : LOCKED_INFO;
    const need = (ok: boolean, why: string) => {
      if (!ok) throw new Error(why);
    };
    // What was written, laid over the next read in case that read lags behind the write.
    let patch: Partial<WaGroup> = {};
    let readLink = false;
    switch (change.key) {
      case 'name': {
        need(info, lockedInfo);
        const name = change.value.trim();
        await this.rpc.call('setGroupName', { jid, name });
        patch = { name };
        break;
      }
      case 'topic':
        need(info, lockedInfo);
        await this.rpc.call('setGroupTopic', { jid, previousId: g.topicId ?? '', topic: change.value });
        patch = { topic: change.value };
        break;
      case 'disappearing':
        need(info, lockedInfo);
        await this.rpc.call('setDisappearing', { jid, seconds: change.value });
        patch = { ephemeral: change.value };
        break;
      case 'announceOnly':
        need(!announcements, 'A community’s announcement group is always admins only.');
        need(admin, ONLY_ADMINS);
        await this.rpc.call('setGroupAnnounce', { jid, on: change.value });
        patch = { isAnnounce: change.value };
        break;
      case 'editInfo':
        need(admin, ONLY_ADMINS);
        await this.rpc.call('setGroupLocked', { jid, on: change.value === 'admins' });
        patch = { isLocked: change.value === 'admins' };
        break;
      case 'addMembers': {
        need(admin, ONLY_ADMINS);
        const mode = change.value === 'everyone' ? 'all_member_add' : 'admin_add';
        await this.rpc.call('setGroupMemberAddMode', { jid, mode });
        patch = { memberAddMode: mode };
        break;
      }
      case 'joinApproval':
        need(admin, ONLY_ADMINS);
        await this.rpc.call('setGroupJoinApproval', { jid, on: change.value });
        patch = { joinApproval: change.value };
        break;
      case 'invite': {
        if (change.op !== 'create') throw new Error('WhatsApp cannot turn an invite link off, only replace it with a new one');
        need(admin, INVITE_ADMINS);
        const r = await this.rpc.call<{ link: string }>('groupInviteLink', { jid, reset: true });
        this.inviteLinks.set(jid, r?.link ?? null);
        if (!r?.link) readLink = true;
        break;
      }
      default:
        throw new Error(`${ABOUT_LABEL[change.key] ?? change.key} cannot be changed on WhatsApp from here`);
    }
    const fresh = await this.rpc.call<WaGroup>('group', { jid }).catch((e) => {
      this.host.log('warn', `group ${jid} after a settings change: ${e.message}`);
      return g;
    });
    const next = { ...fresh, ...patch };
    this.putGroup(next);
    return this.aboutGroup(target.kind, next, readLink);
  }

  private async configureDirect(id: string, change: P.AboutChange): Promise<P.About> {
    if (change.key !== 'disappearing') throw new Error(`${change.key === 'invite' || change.key === 'pin' ? 'That' : ABOUT_LABEL[change.key]} is not a setting of a 1:1 chat`);
    const chat = this.state.chat(id);
    if (!chat) throw new Error('This chat is not in this WhatsApp account');
    await this.rpc.call('setDisappearing', { jid: chat.jid, seconds: change.value });
    // WhatsApp does not echo what this device sends: the line the phone would show, and the timer for what is sent next.
    const now = Date.now();
    this.apply(this.mapper.message({ info: { id: `timer-${now}`, chat: chat.jid, sender: this.ownJid(), fromMe: true, isGroup: false, ts: now }, message: { protocolMessage: { type: 'EPHEMERAL_SETTING', ephemeralExpiration: change.value } } }));
    return this.aboutDirect(id);
  }

  // ---------------------------------------------------------------- profiles

  /**
   * What WhatsApp shows when you open someone's info. Names, number and whether they are in your address book come
   * from the local store. Their About, picture and business name come from one usync query for this person, the one
   * the app makes then; whether you blocked them from the blocklist as last read. Nothing about anyone else, no
   * number lookups, and nothing at all while not online.
   */
  private async profile(who: string): Promise<P.PersonAbout> {
    this.requireLinked();
    const jid = bare(who);
    if (!isUser(jid)) throw new Error(`${who} is not a WhatsApp user`);
    const self = this.mapper.isSelf(jid);
    const id = self ? this.selfIds().id : (this.aliases.peek(jid) ?? jid);
    const jids = self ? this.selfIds().jids : this.aliases.jids(id).filter(isUser);
    const u = await this.lookUp(id, jids[0]);
    if (u?.lid) this.aliases.link(jids[0], u.lid);
    if (u?.businessName || u?.pictureId) this.state.putPerson({ id, businessName: u.businessName, avatar: u.pictureId ? avatarUrl(jids[0], u.pictureId) : undefined });
    const friends = self ? await this.friends() : undefined;
    const blocked = !self && (await this.blocked([...new Set([...jids, bare(u?.lid)].filter(Boolean))]));
    this.publish(id, true);

    const p = this.state.person(id);
    const phone = p?.phone ?? jids.map(phoneOf).find(Boolean);
    const out: P.PersonAbout = { displayName: this.nameOf(id) };
    if (phone) out.handle = phone;
    // Asked and no picture id: none, or hidden from you. Not asked: the one last seen, fetched only when shown.
    const avatar = u ? (u.pictureId ? avatarUrl(jids[0], u.pictureId) : undefined) : (p?.avatar ?? avatarUrl(jids[0]));
    if (avatar) out.avatar = avatar;
    if (u?.status) out.bio = u.status;
    const business = u?.businessName || p?.businessName;
    if (business) out.facts = [{ label: u?.verifiedLevel === 'high' ? 'Verified business' : 'Business account', value: business }];
    if (phone) out.links = [{ label: 'Phone', value: phone, url: `https://wa.me/${phone.replace(/\D/g, '')}` }];
    if (friends) out.friends = friends;
    else out.relationship = blocked ? 'blocked' : p?.fullName ? 'contact' : 'stranger';
    return out;
  }

  /**
   * Your About, through the bridge's setAbout (whatsmeow's SetStatusMessage, the text status WhatsApp's apps set).
   * Then your profile with the About just set, kept for the next open too, without asking WhatsApp again for it.
   */
  private async setProfile(change: { bio?: string }): Promise<P.PersonAbout> {
    this.requireLinked();
    const about = checkAbout(change.bio);
    if (this.phase !== 'online' || !this.bridge?.alive) throw new Error('WhatsApp is not connected');
    await this.rpc.call('setAbout', { about });
    const { id, jids } = this.selfIds();
    const c = this.userInfo.get(id);
    if (c) c.u = c.u.then((u) => u && { ...u, status: about });
    const { bio: _old, ...p } = await this.profile(jids[0] ?? id);
    return { ...p, ...(about ? { bio: about } : {}) };
  }

  /** One usync query for one person: at most every few minutes each, a few a minute in all, and only while online. */
  private lookUp(id: string, jid: string): Promise<WaUserInfo | undefined> {
    const c = this.userInfo.get(id);
    if (c && Date.now() - c.at < PROFILE_FRESH_MS) return c.u;
    if (this.phase !== 'online' || !this.bridge?.alive) return Promise.resolve(undefined);
    const now = Date.now();
    this.profileQueries = this.profileQueries.filter((t) => now - t < 60_000);
    if (this.profileQueries.length >= PROFILE_QUERIES_PER_MINUTE) {
      this.host.log('warn', 'many profiles opened this minute: answering from what is known, without asking WhatsApp');
      return Promise.resolve(undefined);
    }
    this.profileQueries.push(now);
    const u = this.rpc.call<WaUserInfo | null>('userInfo', { jid }).then(
      (r) => r ?? {},
      (e) => {
        this.host.log('warn', `profile ${jid}: ${e?.message ?? e}`);
        this.userInfo.delete(id);
        return undefined;
      },
    );
    this.userInfo.set(id, { u, at: now });
    return u;
  }

  /** Whether you blocked them, from the bridge's copy of the blocklist (read once per connection, when first needed). */
  private async blocked(jids: string[]): Promise<boolean> {
    if (!jids.length || this.phase !== 'online' || !this.bridge?.alive) return false;
    try {
      return !!(await this.rpc.call<{ blocked: boolean } | null>('blocked', { jids }))?.blocked;
    } catch (e: any) {
      this.host.log('warn', `blocklist: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Your address-book contacts on WhatsApp, from the local store, their identities published first. */
  private async friends(): Promise<string[]> {
    if (this.bridge?.alive) await this.loadContacts().catch((e) => this.host.log('warn', `contacts: ${e.message}`));
    const me = this.selfIds().id;
    const ids = this.state
      .people()
      .filter((p) => p.fullName && p.id !== me && isUser(p.id))
      .map((p) => p.id)
      .sort((a, b) => this.nameOf(a).localeCompare(this.nameOf(b)));
    for (const f of ids) this.publish(f);
    return ids;
  }

  // ---------------------------------------------------------------- adding (docs/whatsapp.md)

  private requireOnline() {
    if (this.phase !== 'online' || !this.bridge?.alive) throw new Error('WhatsApp is not connected');
  }

  /** One more of these, or a sentence saying when the next frees up. Kept in the store: a restart does not reset it. */
  private pace(kind: keyof typeof ADD_PACE) {
    const { max, windowMs, did } = ADD_PACE[kind];
    const now = Date.now();
    const key = `pace:${kind}`;
    let at: number[] = [];
    try {
      at = (JSON.parse(this.state.get(key) ?? '[]') as unknown[]).filter((t): t is number => typeof t === 'number' && now - t < windowMs);
    } catch {}
    if (at.length >= max) throw new Error(`This WhatsApp account has ${did}, the most dither-accounts sends WhatsApp. The next frees up in ${inWords(at[at.length - max] + windowMs - now)}.`);
    at.push(now);
    this.state.set(key, JSON.stringify(at));
  }

  /**
   * What a pasted invite link or phone number is, acting on nothing. A link: whatsmeow GetGroupInfoFromLink, the read
   * WhatsApp's own invite sheet makes. A number: one IsOnWhatsApp lookup, none when this account knows the number.
   * WhatsApp says all there is without acting, so no preview here is partial.
   */
  private async resolve(ref: P.AddRef): Promise<P.AddPreview> {
    this.requireLinked();
    if (ref.kind !== 'invite' && ref.kind !== 'person') throw new Error('WhatsApp has only group invite links and phone numbers to look up');
    this.requireOnline();
    return ref.kind === 'invite' ? this.previewOf(await this.readLink(ref.code)) : this.resolvePhone(ref.handle);
  }

  /** An invite link as WhatsApp describes it now, kept for the Join that may follow. */
  private async readLink(code: string): Promise<WaGroup> {
    if (!/^[A-Za-z0-9]{10,40}$/.test(code)) throw new Error('This group invite link is invalid');
    this.pace('link');
    const g = await this.rpc.call<WaGroup>('groupFromLink', { code }, 30_000);
    const now = Date.now();
    for (const [c, p] of this.linkPreviews) if (now - p.at > LINK_FRESH_MS) this.linkPreviews.delete(c);
    this.linkPreviews.set(code, { g, at: now });
    return g;
  }

  /** You are in this group or community: its chat or its read is here, or WhatsApp listed you in it. */
  private isMember(g: WaGroup): boolean {
    return !!this.state.chat(g.jid) || this.groups.has(g.jid) || g.participants.some((p) => [p.jid, p.pn, p.lid].some((j) => this.mapper.isSelf(j)));
  }

  private previewOf(g: WaGroup): P.AddPreview {
    const space = !!g.isParent;
    const p: P.AddPreview = { what: space ? 'space' : 'group', name: g.name || (space ? 'WhatsApp community' : 'WhatsApp group'), nativeId: g.jid, actions: [] };
    if (g.topic) p.description = g.topic;
    if (g.count) p.members = g.count;
    if (this.isMember(g)) {
      p.joined = space ? { space: g.jid } : { conversation: g.jid };
      p.avatar = (this.state.chat(g.jid)?.fact.avatarUrl as string | undefined) ?? avatarUrl(g.jid);
      p.notes = [`You are in this ${space ? 'community' : 'group'} already`];
    } else if (g.joinApproval) {
      p.actions = ['ask'];
      p.notes = [askNote(space)];
    } else p.actions = ['join'];
    return p;
  }

  /**
   * A phone number: one IsOnWhatsApp lookup for it, none when this account already knows the number, and the person's
   * identity before the reply. WhatsApp has no friends or follows to add someone as, only a chat: Message.
   */
  private async resolvePhone(handle: string): Promise<P.AddPreview> {
    const phone = `+${handle.replace(/\D/g, '')}`;
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error('A phone number needs its country code, like +15551234567');
    const pn = `${phone.slice(1)}@s.whatsapp.net`;
    let id = this.mapper.isSelf(pn) ? this.selfIds().id : this.aliases.peek(pn);
    if (!id) {
      this.pace('number');
      const [r] = await this.rpc.call<WaOnWhatsApp[]>('isOnWhatsApp', { phones: [phone] }, 30_000);
      if (!r?.isIn || !r.jid) throw new Error(`${phone} is not on WhatsApp`);
      const jid = bare(r.jid);
      this.aliases.link(jid, r.pn || r.alt || (isPhoneJid(jid) ? undefined : pn));
      id = this.mapper.who(jid);
      if (r.businessName) this.state.putPerson({ id, businessName: r.businessName });
    }
    this.publish(id);
    const f = this.identity(id);
    const p: P.AddPreview = { what: 'person', name: f.displayName ?? phone, nativeId: id, actions: ['message'] };
    if (f.avatarUrl) p.avatar = f.avatarUrl;
    if (f.isSelf) p.notes = ['This is you: Message opens your chat with yourself'];
    else p.relationship = f.contact ? 'contact' : 'stranger';
    return p;
  }

  /**
   * Join yourself by a link the owner pasted and clicked Join or Ask to join on: whatsmeow JoinGroupWithLink, once,
   * never retried. Where the admins approve new members it is a request: pending. In: the group read as the existing
   * group path reads it, its conversation (a community: its space) before the reply.
   */
  private async add(ref: P.AddRef, action: Exclude<P.AddAction, 'message'>): Promise<P.AddResult> {
    this.requireLinked();
    if (ref.kind !== 'invite') throw new Error('WhatsApp has no friend requests, follows or contacts: Message them instead');
    if (action !== 'join' && action !== 'ask') throw new Error(`A WhatsApp invite link is for joining, not ${action}`);
    this.requireOnline();
    const seen = this.linkPreviews.get(ref.code);
    const g = seen && Date.now() - seen.at < LINK_FRESH_MS ? seen.g : await this.readLink(ref.code);
    const space = !!g.isParent;
    const there = (jid: string): P.AddResult => (space ? { space: jid } : { conversation: jid });
    if (this.isMember(g)) return { ...there(g.jid), notes: [`You are in this ${space ? 'community' : 'group'} already`] };
    this.pace('join');
    let r: { jid: string } | null;
    try {
      r = await this.rpc.call<{ jid: string } | null>('joinLink', { code: ref.code }, 80_000);
    } catch (e: any) {
      if (/did not answer/.test(String(e?.message))) throw new Error('WhatsApp did not answer in time. It may still have gone through: look again in a minute.');
      throw e;
    }
    this.linkPreviews.delete(ref.code);
    const jid = bare(r?.jid) || g.jid;
    this.host.log('info', `${g.joinApproval ? 'asked to join' : 'joined'} ${jid} by its invite link`);
    if (g.joinApproval) return { pending: true, notes: [askNote(space)] };
    try {
      this.putGroup(await this.rpc.call<WaGroup>('group', { jid }));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Join approval was switched on since the link was read: the join was a request after all.
      if (/participating|forbidden|not-authorized/i.test(msg)) return { pending: true, notes: [askNote(space)] };
      // In, but not read yet: what the link said, until the read the existing path makes again.
      this.host.log('warn', `group ${jid} after joining: ${msg}`);
      const { conversation, space: sp } = this.mapper.group({ ...g, jid, participants: [] });
      if (sp) this.host.emit({ t: 'space', space: sp });
      if (conversation) {
        delete conversation.participants;
        this.putChat(jid, jid, conversation, 0);
      }
      this.fetchGroup(jid);
    }
    return there(jid);
  }

  /**
   * Answer a request to join a group you admin, as the owner clicked: whatsmeow UpdateGroupRequestParticipants,
   * approve or reject, for that one person. WhatsApp has no blocking from a join request.
   */
  private async answer(request: string, answer: P.RequestAnswer): Promise<P.AddResult> {
    this.requireLinked();
    const r = this.joinReqs.get(request);
    if (!r) {
      if (this.requestsKnown) this.host.emit({ t: 'requestGone', nativeId: request });
      throw new Error('That request is not waiting any more');
    }
    if (answer !== 'accept' && answer !== 'decline') throw new Error('A WhatsApp join request is accepted or declined');
    this.requireOnline();
    try {
      await this.rpc.call('answerJoinRequest', { jid: r.group, user: r.jid, approve: answer === 'accept' });
    } catch (e: any) {
      if (/not waiting any more/.test(String(e?.message))) this.dropJoinReq(request);
      throw e;
    }
    this.host.log('info', `${answer === 'accept' ? 'approved' : 'declined'} ${r.jid}'s request to join ${r.group}`);
    this.dropJoinReq(request);
    const from = r.fact.from!;
    if (answer === 'decline') return { identity: from };
    return { identity: from, ...(r.fact.target?.kind === 'space' ? { space: r.group } : { conversation: r.group }) };
  }

  private joinEntry(group: string, user: string, alt: string | undefined, ts: number): JoinReq {
    this.aliases.link(user, alt);
    const from = this.mapper.who(user);
    const g = this.groups.get(group)?.g;
    const target: NonNullable<P.RequestFact['target']> = { kind: g?.isParent ? 'space' : 'conversation', nativeId: group };
    if (g?.name) target.name = g.name;
    if (g?.count) target.members = g.count;
    return { group, jid: bare(user), fact: { nativeId: joinReqId(group, from), kind: 'join', from, target, ts: ts > 0 ? ts : Date.now(), answers: ['accept', 'decline'] } };
  }

  /** The whole list, its people first. */
  private sendRequests(force = false) {
    const list = [...this.joinReqs.values()];
    for (const r of list) this.publish(r.fact.from!, force);
    this.host.emit({ t: 'requests', requests: list.map((r) => r.fact) });
  }

  private dropJoinReq(id: string) {
    this.joinReqs.delete(id);
    this.reqLoad?.added.delete(id);
    this.reqLoad?.gone.add(id);
    this.host.emit({ t: 'requestGone', nativeId: id });
  }

  /** Requests to join this group that went: one person's (they are in now, withdrew, or were declined), or all of them. */
  private joinRequestsGone(group: string, user?: string) {
    const j = bare(user);
    const who = j ? (this.mapper.isSelf(j) ? this.selfIds().id : this.aliases.peek(j)) : undefined;
    if (who) this.reqLoad?.gone.add(joinReqId(group, who));
    for (const [id, r] of [...this.joinReqs]) if (r.group === group && (!j || r.jid === j || r.fact.from === who)) this.dropJoinReq(id);
  }

  /** WhatsApp says someone asked to join a group you admin, or that a request went. */
  private joinRequest(ev: Extract<BridgeEvent, { t: 'join_request' }>) {
    const group = bare(ev.group);
    if (this.mapper.isSelf(ev.user)) return;
    this.aliases.link(ev.user, ev.alt);
    if (ev.gone) return this.joinRequestsGone(group, ev.user);
    const r = this.joinEntry(group, ev.user, ev.alt, ev.ts);
    const id = r.fact.nativeId;
    this.joinReqs.set(id, r);
    this.reqLoad?.added.set(id, r);
    this.reqLoad?.gone.delete(id);
    this.publish(r.fact.from!);
    this.host.emit({ t: 'request', request: r.fact });
  }

  /**
   * At connect, with the groups just read: who asked to join each group you admin that has join approval on, one
   * whatsmeow GetGroupRequestParticipants each, then the whole list. If a read failed the list is not whole: what was
   * found goes one by one, and the hub keeps the rest of what it had.
   */
  private async loadJoinRequests(groups: WaGroup[]) {
    const load = { added: new Map<string, JoinReq>(), gone: new Set<string>() };
    this.reqLoad = load;
    const found = new Map<string, JoinReq>();
    let whole = true;
    try {
      for (const g of groups) {
        if (!g.joinApproval || !this.standing(g).admin) continue;
        try {
          for (const r of await this.rpc.call<WaJoinRequest[]>('joinRequests', { jid: g.jid })) {
            const e = this.joinEntry(g.jid, r.jid, r.alt, r.ts);
            found.set(e.fact.nativeId, e);
          }
        } catch (e: any) {
          whole = false;
          this.host.log('warn', `join requests of ${g.jid}: ${e?.message ?? e}`);
        }
      }
    } finally {
      if (this.reqLoad === load) this.reqLoad = null;
    }
    for (const id of load.gone) found.delete(id);
    for (const [id, r] of load.added) found.set(id, r);
    if (whole) {
      this.joinReqs = found;
      this.requestsKnown = true;
      return this.sendRequests();
    }
    for (const [id, r] of found) {
      this.joinReqs.set(id, r);
      this.publish(r.fact.from!);
      this.host.emit({ t: 'request', request: r.fact });
    }
  }

  /** Made or unmade an admin, or join approval switched: read this group's requests again, or drop them. */
  private async recheckJoinRequests(g: WaGroup) {
    if (!this.standing(g).admin) return this.joinRequestsGone(g.jid);
    if (!g.joinApproval && ![...this.joinReqs.values()].some((r) => r.group === g.jid)) return;
    let list: WaJoinRequest[];
    try {
      list = await this.rpc.call<WaJoinRequest[]>('joinRequests', { jid: g.jid });
    } catch (e: any) {
      this.host.log('warn', `join requests of ${g.jid}: ${e?.message ?? e}`);
      return;
    }
    const now = new Map(list.map((x) => this.joinEntry(g.jid, x.jid, x.alt, x.ts)).map((r) => [r.fact.nativeId, r]));
    for (const [id, r] of [...this.joinReqs]) if (r.group === g.jid && !now.has(id)) this.dropJoinReq(id);
    for (const [id, r] of now) {
      if (this.joinReqs.has(id)) continue;
      this.joinReqs.set(id, r);
      this.publish(r.fact.from!);
      this.host.emit({ t: 'request', request: r.fact });
    }
  }

  private async action(action: string, args: any): Promise<unknown> {
    switch (action) {
      case 'startLink':
      case 'refreshLink':
        if (this.self.loggedIn) throw new Error('Already linked. Use relink to link another phone.');
        if (!this.bridge?.alive) {
          await this.respawn();
          return { started: true };
        }
        await this.rpc.call('link');
        return { started: true };
      case 'pairPhone': {
        if (this.self.loggedIn) throw new Error('Already linked');
        const phone = String(args?.phone ?? '').trim();
        if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) throw new Error('Give the phone number with its country code, like +15551234567');
        const r = await this.rpc.call<{ code: string }>('pairPhone', { phone }, 60_000);
        const code = r.code.length === 8 ? `${r.code.slice(0, 4)}-${r.code.slice(4)}` : r.code;
        this.setStatus('attention', { kind: 'link_device', message: `On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then enter ${code}`, detail: { pairCode: code } });
        return { code };
      }
      case 'relink':
      case 'logout':
        if (this.bridge?.alive && this.self.loggedIn) await this.rpc.call('logout').catch((e) => this.host.log('warn', `logout: ${e.message}`));
        this.unlinked(action);
        return {};
      case 'reconnect':
        clearTimeout(this.banTimer);
        this.phase = 'connecting';
        await this.respawn();
        return {};
      case 'resync':
        await this.snapshot(true);
        return { chats: this.state.chats().length };
      case 'typing':
        return this.sendTyping(String(args?.conversation ?? ''), !!args?.stop);
      case 'status': {
        const b = this.bridge?.alive ? await this.rpc.call('status').catch(() => null) : null;
        return { phase: this.phase, bridge: b, chats: this.state.chats().length, messages: this.state.countMsgs() };
      }
    }
    throw new Error(`unknown action "${action}" (startLink, refreshLink, pairPhone, relink, logout, reconnect, resync, typing, status)`);
  }
}

/** A request to join a group, by who asked: one per person and group. */
export const joinReqId = (group: string, who: string) => `${group}/join/${who}`;

const askNote = (space: boolean) => (space ? 'The community’s admins approve new members' : ASK_NOTE);

/** "12 minutes", "3 hours". */
function inWords(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** A message as a quote: no quote of its own, no mentions to re-ping. */
export function quotable(m: WaMessage): WaMessage {
  const out: WaMessage = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'messageContextInfo' || k === 'senderKeyDistributionMessage') continue;
    if (v && typeof v === 'object' && 'contextInfo' in (v as object)) {
      const { contextInfo: _, ...rest } = v as Record<string, unknown>;
      (out as any)[k] = rest;
    } else (out as any)[k] = v;
  }
  return out;
}

/** The message to send to forward this one, WhatsApp's way, or null if it cannot be forwarded. */
export function forwardable(m: WaMessage): WaMessage | null {
  if (m.reactionMessage || m.protocolMessage || m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3 || m.pollCreationMessageV5) return null;
  const media = mediaOf(m);
  if (media?.media.viewOnce) return null;
  const q = quotable(m);
  let key = Object.keys(q).find((k) => k !== 'messageContextInfo');
  if (!key) return null;
  let inner = q[key] as Record<string, unknown> | string;
  const prevScore = Number(contextOf(m)?.forwardingScore ?? 0);
  if (key === 'conversation') {
    key = 'extendedTextMessage';
    inner = { text: inner as string };
  }
  if (typeof inner !== 'object' || inner === null) return null;
  return { [key]: { ...inner, contextInfo: { isForwarded: true, forwardingScore: prevScore + 1 } } } as WaMessage;
}
