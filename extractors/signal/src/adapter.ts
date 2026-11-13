/**
 * Signal adapter: a linked device driven through signal-cli.
 *
 *   no account   -> `signal-cli link` (LinkFlow), status 'attention' + QR URI
 *   linked       -> `signal-cli daemon --socket` (Daemon), JSON-RPC for commands,
 *                   `receive` notifications for incoming envelopes
 *   unlinked     -> back to linking (signal-cli keeps contacts/groups and relinks in place)
 *
 * The hub side is abstracted as AdapterHost so tests can drive the adapter
 * without a hub, and the signal-cli binary is injectable so tests can use a fake.
 *
 * Adding (dither-chat docs/add.md, docs/signal.md here): `resolve` looks a group link or a person up without acting,
 * `add` joins by a group link, and `answer` answers the requests the adapter lists: group invitations and message
 * requests. A message request is kept quiet: nothing from this adapter tells the sender their message was seen
 * (no read receipt, no typing, no message, no profile key) until it is accepted.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as P from '@dither-chat/protocol';
import { ADD_MEMBERS_MAX, createGroupProblem, GROUP_RULES, PIN_DURATIONS, pollDraftProblem, signalStickerLink, STICKER_PAGE_PACKS, STORIES_ACTION } from '@dither-chat/protocol';
import { errorText, groupIdOfLink, isMessageRequest, joinError, lookupError, signalError, wantsCaptcha } from './add.ts';
import { answerJoinParams, approvalParams, groupLeaving, groupModeration, isAdmin, joinRequests, labelOf, labelParams, moderateParams, ownLabel, parseJoinRequest, picturePath, quitParams } from './groups.ts';
import { ChildRegistry, type Logger } from './cli.ts';
import { Daemon, type DaemonExit } from './daemon.ts';
import { LinkFlow } from './link.ts';
import {
  adminChanges,
  checkAbout,
  contactIdentity,
  describeGroupChange,
  describeTimer,
  directConversation,
  displayNameOf,
  dmId,
  fileUrl,
  groupConversation,
  groupConvId,
  type MapContext,
  type MapResult,
  mapReceive,
  memberIds,
  msgId,
  noteToSelf,
  parseConversation,
  parseMsgId,
  pendingIds,
  personAbout,
  QUOTE_THUMB_MAX,
  quoteAttachment,
  quoteSource,
  type SeenMessage,
  pollFact,
} from './mapping.ts';
import { fromSignal, toSignal } from './markdown.ts';
import { CAPTCHA_URL, challengeOf, cleanCaptcha, cleanSafetyNumber, cleanUsername, contactChange, devicesDetail, keyChanges, type SigDevice, type SigIdentity, safetyOf, splitName, usernameOf } from './people.ts';
import { RpcError, type RpcClient } from './rpc.ts';
import { AdapterState } from './state.ts';
import type { SigContact, SigGroup, SigJoinResult, SigReceive, SigSendResult, SigStickerPack, SigUserStatus } from './types.ts';
import { CallBook } from './calls.ts';

export const ADAPTER_VERSION = '0.1.0';
/** No 'connect': Signal has no friends, follows or contact requests; people are added by messaging them (openDirect). */
export const CAPABILITIES: P.Capability[] = ['send', 'react', 'edit', 'redact', 'markRead', 'typing', 'media', 'sendMedia', 'openDirect', 'about', 'configure', 'addMembers', 'createGroup', 'profile', 'editProfile', 'resolve', 'join', 'requests', 'viewed', 'resetSession', 'callStates', 'relationships', 'disconnect', 'block', 'safetyNumbers', 'contactNotes', 'leave', 'moderate', 'memberLabels', 'setPicture', 'polls', 'pollVote', 'pollCreate', 'pollEnd', 'pin', 'sendStickers', 'installStickers', 'sendVoice', 'sendViewOnce', 'stories'];

/**
 * The settings your phone syncs to this device (Settings → Privacy, Chats), as signal-cli keeps them: read-only from its
 * account database, since no JSON-RPC method reads them (signal-gaps e6). A setting signal-cli has not been told, or a
 * database it can no longer be read from (another layout in a newer signal-cli), is left out, and each use says what
 * it does without it (docs/signal.md "Your phone's settings").
 */
export interface SignalSettings {
  readReceipts?: boolean;
  typingIndicators?: boolean;
  linkPreviews?: boolean;
}

/** Keys of signal-cli 0.14's key_value table (ConfigurationStore), by what they mean here. */
const SETTING_KEYS: Record<keyof SignalSettings, string> = {
  readReceipts: 'config-read-receipts',
  typingIndicators: 'config-typing-indicators',
  linkPreviews: 'config-link-previews',
};

/** Read the synced settings from signal-cli's account database (<data>/<path>.d/account.db), read-only. Public for tests. */
export function readSignalSettings(dbPath: string): SignalSettings | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const out: SignalSettings = {};
    const q = db.query<{ value: unknown }, [string]>('SELECT value FROM key_value WHERE key = ?');
    for (const [name, key] of Object.entries(SETTING_KEYS) as [keyof SignalSettings, string][]) {
      const v = q.get(key)?.value;
      if (v === 1 || v === 1n || v === true || v === 'true') out[name] = true;
      else if (v === 0 || v === 0n || v === false || v === 'false') out[name] = false;
    }
    return out;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** A sticker id from the picker ("packId:stickerId"), or null. */
export function stickerRef(id: string): { packId: string; stickerId: number } | null {
  const m = /^([0-9a-f]{32}):(\d{1,4})$/i.exec(id);
  return m ? { packId: m[1].toLowerCase(), stickerId: Number(m[2]) } : null;
}

/** A send result's failures in words the hub shows (extra.ts SendFailureFact). */
export function sendFailures(results: SigSendResult['results']): P.SendFailureFact[] {
  const reason = (type: string): P.SendFailureReason =>
    type === 'UNREGISTERED_FAILURE' ? 'unregistered' : type === 'IDENTITY_FAILURE' ? 'identity' : type === 'RATE_LIMIT_FAILURE' ? 'rateLimit' : type === 'NETWORK_FAILURE' ? 'network' : type === 'INVALID_PRE_KEY_FAILURE' ? 'keys' : 'other';
  return (results ?? [])
    .filter((r) => r.type !== 'SUCCESS')
    .map((r) => ({ who: lc(r.recipientAddress?.uuid) ?? null, ...(r.recipientAddress?.number ? { number: r.recipientAddress.number } : {}), reason: reason(r.type) }));
}
const ANSWERS: P.RequestAnswer[] = ['accept', 'decline', 'block'];
/** What a reply, reaction or edit in a message request is refused with: on Signal, writing back accepts it. */
const ACCEPT_FIRST = 'Accept this message request first: writing back on Signal accepts it and shares your profile with them';
export const LINK_MESSAGE = 'Scan this QR code in Signal → Settings → Linked devices';

export interface AdapterHost {
  emit(ev: P.AdapterEvent): void;
  log: Logger;
  accountDir: string;
  config: Record<string, any>;
  secret(): Record<string, any>;
  saveSecret(value: unknown): void;
}

export interface AdapterOptions {
  /** argv prefix for signal-cli (resolved lazily: may run `nix build`). */
  signalCli: () => Promise<string[]>;
  linkRotateMs?: number;
  linkMaxActiveMs?: number;
  restartBackoffMs?: number[];
  /** Re-read contacts and groups at these offsets after the daemon is ready (sync data trickles in after linking)... */
  resnapshotMs?: number[];
  /** ...and then every this often. */
  resnapshotEveryMs?: number;
  expirySweepMs?: number;
  daemonReadyTimeoutMs?: number;
  daemonHealthEveryMs?: number;
  /**
   * After a sync message from your other devices that signal-cli does not show (a message request answered on the
   * phone, a storage update), look at the open message requests again at these offsets.
   */
  requestRecheckMs?: number[];
  /** Read the linked devices again this often (a server call; on start, then at this pace). */
  devicesEveryMs?: number;
  /** A daemon down longer than this asks the phone for contacts, groups and settings again when it is back (sendSyncRequest). */
  syncAfterOutageMs?: number;
}

type Phase = 'starting' | 'linking' | 'daemon' | 'relinking' | 'stopped' | 'broken';
type Status = Extract<P.AdapterEvent, { t: 'status' }>;

interface LinkedAccount {
  number: string;
  aci: string;
  /** signal-cli's name for its files (accounts.json `path`). */
  path?: string;
}

function lc(s: string | null | undefined) {
  return s ? s.toLowerCase() : null;
}
const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SignalAdapter {
  readonly signalDir: string;
  private socketPath: string;
  private children: ChildRegistry;
  private state: AdapterState;
  private argv0: string[] = [];
  private env: Record<string, string | undefined>;
  private phase: Phase = 'starting';
  private account: LinkedAccount | null = null;
  private selfName: string | undefined;
  private link: LinkFlow | null = null;
  private daemon: Daemon | null = null;
  private restarts = 0;
  private restartTimer?: Timer;
  private snapshotTimers: Timer[] = [];
  private snapshotInterval?: Timer;
  private snapshotRunning = false;
  private snapshotAgain = false;
  private debouncedSnapshot?: Timer;
  private expiryTimer?: Timer;
  private lastStatus: Status | null = null;
  private facts = new Map<string, Record<string, unknown>>();
  private names = new Map<string, string>();
  private byNumber = new Map<string, string>();
  private knownGroups = new Set<string>();
  private timers = new Map<string, number>(); // conversation -> disappearing timer (s)
  private groupRefreshing = new Set<string>();
  private pendingGroupUpdates = new Map<string, SeenMessage>();
  private seenKeys = new Set<string>();
  /** 1:1 calls heard, for how each went (calls.ts). */
  private callBook = new CallBook();
  /** conversation -> newest message timestamp we sent (or saw synced) a read receipt for */
  private acked = new Map<string, number>();
  private stickerCache = new Map<string, Map<number, { emoji?: string | null; contentType?: string | null }> | null>();
  /** Every recipient signal-cli listed in the last snapshot (or looked up since), by ACI. */
  private recipients = new Map<string, SigContact>();
  /** Groups you are invited to and have not answered, as signal-cli last listed them. Never a conversation. */
  private invited = new Map<string, SigGroup>();
  /** 1:1 peers whose conversation is a message request: nothing goes to them but what Signal sends anyway. */
  private pendingPeers = new Set<string>();
  /** Peers who wrote first and whom nobody has looked at yet: kept quiet until they are. */
  private unsure = new Set<string>();
  private classifying = new Map<string, Promise<boolean>>();
  /** What the hub was last told of each request (its JSON), so only changes go out. */
  private told = new Map<string, string>();
  /** The whole list went out since signal-cli last came up. */
  private requestsKnown = false;
  /** A snapshot is rebuilding the list: it goes out once, at the end. */
  private batching = false;
  private recheckTimers: Timer[] = [];
  /** Events for a group signal-cli had not listed yet, until a re-read says whether it is yours to show. */
  private heldEvents = new Map<string, P.AdapterEvent[]>();
  /** People's links (contact, blocked) as the hub was last told, and whether it has the whole list. */
  private links = new Map<string, P.RelationshipFact['relationship']>();
  private linksKnown = false;
  /** signal-cli's own version, from its `version`. */
  private cliVersion: string | null = null;
  /** The account's devices as listDevices last said, and when it was asked. */
  private devices: SigDevice[] | null = null;
  private devicesAt = 0;
  /** A rate-limit challenge waiting for the owner's captcha (people.ts challengeOf). */
  private challenge: string | null = null;
  /** Just linked: ask the phone for contacts, groups and settings once the daemon is up. */
  private syncOnReady = false;
  /** People re-read after a profile key update, and when, so a burst of them reads each once. */
  private reread = new Map<string, number>();
  /** On a relink: the device the phone still lists, to name on the link screen. */
  private staleDevice: string | null = null;
  /** The phone's synced settings as last read, and when. */
  private settingsRead: { at: number; value: SignalSettings | null } | null = null;
  /** Messages a viewed receipt went out for (once each). */
  private viewedSent = new Set<string>();
  /** The capabilities the hub was last told. */
  private toldCaps: string | null = null;
  /** The daemon running now was started with stories on (no --ignore-stories). */
  private storiesRunning = false;

  constructor(
    private host: AdapterHost,
    private opts: AdapterOptions,
  ) {
    this.signalDir = resolve(host.accountDir, 'signal-cli');
    this.socketPath = socketPathFor(host.accountDir);
    this.children = new ChildRegistry(join(host.accountDir, 'signal-cli.pids'), this.signalDir, host.log);
    this.state = new AdapterState(join(host.accountDir, 'state.json'));
    for (const [id, g] of this.state.groups) {
      this.knownGroups.add(id);
      if (g.messageExpirationTime) this.timers.set(`group:${id}`, g.messageExpirationTime);
    }
    for (const peer of this.state.heard.keys()) if (!this.state.ours.has(peer)) this.unsure.add(peer);
    // Keep the user's own ~/.config/signal-cli/config.json (account, output, ...) out of our runs.
    const globalCfg = join(host.accountDir, 'signal-cli.global.json');
    if (!existsSync(globalCfg)) writeFileSync(globalCfg, '{}\n', { mode: 0o600 });
    this.env = { ...process.env, SIGNAL_CLI_CONFIG: globalCfg };
  }

  // ---------------------------------------------------------------- lifecycle

  hello() {
    const capabilities = this.capabilities();
    this.toldCaps = capabilities.join(',');
    this.host.emit({ t: 'hello', network: 'signal', version: ADAPTER_VERSION, capabilities });
  }

  /** CAPABILITIES, and link previews while the phone's setting allows them (unknown: not). */
  capabilities(): P.Capability[] {
    return this.settings().linkPreviews === true ? [...CAPABILITIES, 'linkPreviews'] : CAPABILITIES;
  }

  /** The phone's synced settings (SignalSettings), read at most once a minute. Public for tests. */
  settings(fresh = false): SignalSettings {
    const now = Date.now();
    if (fresh || !this.settingsRead || now - this.settingsRead.at > 60_000) {
      const path = this.account?.path;
      this.settingsRead = { at: now, value: path ? readSignalSettings(join(this.signalDir, 'data', `${path}.d`, 'account.db')) : null };
    }
    return this.settingsRead.value ?? {};
  }

  /** Tell the hub again when what it may offer changed (the link-preview setting, synced from the phone). */
  private recheckCapabilities() {
    this.settings(true);
    if (this.capabilities().join(',') !== this.toldCaps) this.hello();
  }

  /** Every (re)connect to the hub: hello, the current status, and the requests when the list is known. */
  onHubConnect() {
    this.hello();
    if (this.lastStatus) this.host.emit(this.lastStatus);
    if (this.requestsKnown) this.sendAllRequests();
    if (this.linksKnown) this.host.emit({ t: 'relationships', list: [...this.links].map(([identity, relationship]) => ({ identity, relationship })) });
  }

  async start() {
    this.hello();
    this.setStatus('connecting', null);
    try {
      this.argv0 = await this.opts.signalCli();
      await this.children.reapOrphans();
    } catch (e: any) {
      this.phase = 'broken';
      this.host.log('error', String(e?.message ?? e));
      this.setStatus('error', { kind: 'unknown', message: `signal-cli is not available: ${e?.message ?? e}` });
      return;
    }
    if (this.phase === 'stopped') return;
    this.account = this.findAccount();
    if (this.account) this.startDaemon();
    else this.startLink();
    this.expiryTimer = setInterval(() => this.sweepExpired(), this.opts.expirySweepMs ?? 30_000);
  }

  async shutdown() {
    this.phase = 'stopped';
    clearTimeout(this.restartTimer);
    clearInterval(this.expiryTimer);
    this.stopSnapshots();
    await Promise.all([this.link?.stop(), this.daemon?.stop()]);
    await this.children.killAll(3000);
    this.state.flush();
  }

  private setStatus(status: P.AccountStatus, attention?: Status['attention'], self?: P.IdentityFact) {
    const ev: Status = { t: 'status', status };
    if (attention !== undefined) ev.attention = attention;
    if (self) ev.self = self;
    ev.layers = this.layers(status, attention ?? null);
    const details = this.details();
    if (details) ev.details = details;
    this.lastStatus = ev;
    this.host.emit(ev);
  }

  /**
   * What the account rests on (status.layers): signal-cli, this linked device, and receiving through signal-cli's
   * daemon. Only what the adapter already knows; the first layer not ok is where it stops.
   */
  private layers(status: P.AccountStatus, attention: Status['attention'] | null): P.StatusLayer[] {
    const message = attention?.message ?? status;
    const cli: P.StatusLayer = this.argv0.length
      ? { name: 'signal-cli', state: 'ok', note: this.cliVersion ? `signal-cli ${this.cliVersion}` : this.argv0[0].split('/').pop() }
      : this.phase === 'broken'
        ? { name: 'signal-cli', state: 'failed', note: message }
        : { name: 'signal-cli', state: 'waiting', note: 'looking for it' };
    const linked: P.StatusLayer = this.account
      ? { name: 'linked', state: 'ok', note: `as ${redactNumber(this.account.number)}` }
      : !this.argv0.length
        ? { name: 'linked', state: 'waiting', note: 'waits for signal-cli' }
        : status === 'error'
          ? { name: 'linked', state: 'failed', note: message }
          : { name: 'linked', state: 'waiting', note: attention?.qr ? 'scan the QR code with Signal on your phone' : attention?.kind === 'link_device' ? message : 'linking' };
    const receiving: P.StatusLayer = !this.account
      ? { name: 'receiving', state: 'waiting', note: 'waits for the link' }
      : status === 'online'
        ? { name: 'receiving', state: 'ok', note: "through signal-cli's daemon" }
        : status === 'error'
          ? { name: 'receiving', state: 'failed', note: message }
          : attention
            ? { name: 'receiving', state: 'waiting', note: message }
            : { name: 'receiving', state: 'waiting', note: this.restarts ? `restarting signal-cli's daemon (${this.restarts} so far)` : "starting signal-cli's daemon" };
    return [cli, linked, receiving];
  }

  private get self(): string {
    if (!this.account) throw new Error('Signal is not linked yet');
    return this.account.aci;
  }

  private get rpc(): RpcClient {
    const r = this.daemon?.rpc;
    if (!r?.open) throw new Error(this.account ? 'signal-cli is not connected yet' : 'Signal is not linked yet');
    return r;
  }

  private base(...rest: string[]) {
    const trust = this.host.config.trustNewIdentities ?? 'always';
    return [...this.argv0, '--config', this.signalDir, '--trust-new-identities', String(trust), ...rest];
  }

  /** signal-cli's own account list (<config>/data/accounts.json). */
  private readAccounts(): { number: string; uuid?: string; path?: string }[] {
    const p = join(this.signalDir, 'data', 'accounts.json');
    if (!existsSync(p)) return [];
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return (j.accounts ?? []).filter((a: any) => a?.number && (!a.environment || a.environment === 'LIVE'));
    } catch {
      return [];
    }
  }

  private findAccount(): LinkedAccount | null {
    const list = this.readAccounts().filter((a) => a.uuid);
    if (!list.length) return null;
    const s = this.host.secret();
    const pick = list.find((a) => lc(a.uuid) === lc(s.aci)) ?? list.find((a) => a.number === s.number) ?? list[0];
    return { number: pick.number, aci: lc(pick.uuid)!, ...(pick.path ? { path: pick.path } : {}) };
  }

  // ---------------------------------------------------------------- linking

  private startLink(reason?: 'unlinked' | 'relink') {
    if (this.phase === 'stopped') return;
    this.phase = 'linking';
    this.host.log('info', `starting device linking${reason ? ` (${reason})` : ''}`);
    const intro = (reason === 'unlinked' ? 'This device was unlinked from your phone. ' : '') + (this.staleDevice ? `Then remove the old ${this.staleDevice} under Linked devices on your phone: signal-cli cannot remove it itself. ` : '');
    this.link = new LinkFlow({
      argv: (name) => this.base('link', '-n', name),
      env: this.env,
      deviceName: String(this.host.config.deviceName ?? 'dither-chat'),
      children: this.children,
      log: this.host.log,
      rotateAfterMs: this.opts.linkRotateMs,
      maxActiveMs: this.opts.linkMaxActiveMs,
      onUri: (qr, note, qrRefreshAt) => this.setStatus('attention', { kind: 'link_device', message: (note ? note + ' ' : '') + intro + LINK_MESSAGE, qr, qrRefreshAt }),
      onScanned: () => this.setStatus('connecting', null),
      onTrouble: (message) => this.setStatus('attention', { kind: 'link_device', message }),
      onPaused: () =>
        this.setStatus('attention', {
          kind: 'link_device',
          message: 'The QR code expired. Press New code for another one.',
        }),
      onLinked: (number) => this.linked(number).catch((e) => this.host.log('error', `after linking: ${e?.stack ?? e}`)),
    });
    this.link.start();
  }

  private async linked(number: string) {
    this.link = null;
    const acc = this.readAccounts().find((a) => a.number === number && a.uuid);
    if (!acc) {
      this.host.log('error', `linked as ${number}, but signal-cli's account list has no ACI for it`);
      this.setStatus('error', { kind: 'unknown', message: 'Linking finished but signal-cli did not record the account; relink.' });
      return;
    }
    this.account = { number, aci: lc(acc.uuid)!, ...(acc.path ? { path: acc.path } : {}) };
    this.staleDevice = null;
    this.host.saveSecret({ ...this.host.secret(), number, aci: this.account.aci, linkedAt: Date.now() });
    this.host.log('info', `linked as ${redactNumber(number)}`);
    this.restarts = 0;
    this.syncOnReady = true;
    this.startDaemon();
  }

  // ---------------------------------------------------------------- daemon

  private startDaemon() {
    if (this.phase === 'stopped' || !this.account) return;
    this.phase = 'daemon';
    if (this.lastStatus?.status !== 'error') this.setStatus('connecting', null);
    // Stories only with the owner's setting on (docs/signal.md "Stories"): read here, so a change waits for this start.
    const stories = this.state.stories;
    this.storiesRunning = stories;
    const d = new Daemon({
      argv: this.base('-a', this.account.aci, 'daemon', '--socket', this.socketPath, '--receive-mode', 'on-connection', '--no-receive-stdout', ...(stories ? [] : ['--ignore-stories'])),
      env: this.env,
      socketPath: this.socketPath,
      children: this.children,
      log: this.host.log,
      readyTimeoutMs: this.opts.daemonReadyTimeoutMs,
      healthEveryMs: this.opts.daemonHealthEveryMs,
      onNotification: (method, params) => {
        if (d === this.daemon && method === 'receive') this.received(params as SigReceive);
      },
      onReady: () => {
        if (d === this.daemon) this.daemonReady().catch((e) => this.host.log('error', `daemon setup failed: ${e?.stack ?? e}`));
      },
      onExit: (info) => {
        if (d === this.daemon) this.daemonExited(info);
      },
    });
    this.daemon = d;
    d.start();
  }

  private async daemonReady() {
    const acc = this.account!;
    // The number may have changed on the phone since we linked.
    const now = this.readAccounts().find((a) => lc(a.uuid) === acc.aci);
    if (now && now.number !== acc.number) {
      acc.number = now.number;
      this.host.saveSecret({ ...this.host.secret(), number: now.number });
    }
    if (now?.path) acc.path = now.path;
    this.recheckCapabilities();
    let me: SigContact | undefined;
    try {
      me = (await this.rpc.call<SigContact[]>('listContacts', { recipient: [acc.aci], allRecipients: true }, 30_000))?.find((c) => lc(c.uuid) === acc.aci);
    } catch (e: any) {
      this.host.log('warn', `could not read your own profile: ${e?.message ?? e}`);
    }
    this.selfName = (me && displayNameOf(me)) || this.selfName;
    const self: P.IdentityFact = { nativeId: acc.aci, handle: acc.number, isSelf: true };
    if (this.selfName) self.displayName = this.selfName;
    const avatar = this.avatarOf(acc.aci, acc.number);
    if (avatar) self.avatarUrl = avatar;
    this.setStatus('online', null, self);
    this.facts.set(`i:${acc.aci}`, { ...self });
    this.emitFact({ t: 'conversation', conversation: noteToSelf(acc.aci) });
    for (const peer of this.state.dms) this.emitFact({ t: 'conversation', conversation: directConversation(acc.aci, peer) });
    this.stopSnapshots();
    for (const at of this.opts.resnapshotMs ?? [0, 30_000, 120_000, 600_000]) this.snapshotTimers.push(setTimeout(() => void this.snapshot(), at));
    this.snapshotInterval = setInterval(() => void this.snapshot(), this.opts.resnapshotEveryMs ?? 1_800_000);
    void this.afterReady().catch((e) => this.host.log('warn', `after the daemon came up: ${e?.message ?? e}`));
  }

  private stopSnapshots() {
    this.snapshotTimers.forEach(clearTimeout);
    this.snapshotTimers = [];
    clearInterval(this.snapshotInterval);
    clearTimeout(this.debouncedSnapshot);
    this.recheckTimers.forEach(clearTimeout);
    this.recheckTimers = [];
  }

  private daemonExited(info: DaemonExit) {
    this.daemon = null;
    this.stopSnapshots();
    this.requestsKnown = false; // the whole list goes again after the next read
    if (this.phase !== 'daemon') return;
    if (info.notRegistered) {
      this.host.log('warn', 'signal-cli says this device is no longer registered; relinking');
      this.startLink('unlinked');
      return;
    }
    if (info.wasReady && info.uptimeMs > 120_000) this.restarts = 0;
    const delays = this.opts.restartBackoffMs ?? [1000, 2000, 5000, 10_000, 30_000, 60_000];
    const delay = delays[Math.min(this.restarts, delays.length - 1)];
    this.restarts++;
    const why = info.lastErr || `exited with code ${info.code}${info.signal ? ` (${info.signal})` : ''}`;
    this.host.log('warn', `signal-cli daemon stopped (${why}); restarting in ${Math.round(delay / 1000)}s`);
    if (this.restarts >= 3) this.setStatus('error', { kind: 'unknown', message: `signal-cli keeps stopping: ${why}` });
    else this.setStatus('connecting', null);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.startDaemon(), delay);
  }

  // ---------------------------------------------------------------- facts

  /** Emit identity/conversation facts only when they add something. */
  private emitFact(ev: Extract<P.AdapterEvent, { t: 'identity' | 'conversation' }>) {
    let fact = (ev.t === 'identity' ? ev.identity : ev.conversation) as unknown as Record<string, unknown>;
    const key = `${ev.t === 'identity' ? 'i' : 'c'}:${fact.nativeId}`;
    const prev = this.facts.get(key);
    // An empty nickname or note says something only to a hub that was told one: it clears it.
    if (ev.t === 'identity' && ((fact.nickname === '' && !prev?.nickname) || (fact.note === '' && !prev?.note))) {
      const { nickname, note, ...rest } = fact;
      fact = { ...rest, ...(nickname || prev?.nickname ? { nickname } : {}), ...(note || prev?.note ? { note } : {}) };
      ev = { t: 'identity', identity: fact as unknown as P.IdentityFact };
    }
    const merged = { ...(prev ?? {}) };
    for (const [k, v] of Object.entries(fact)) if (v !== undefined) merged[k] = v;
    if (prev && stableJson(prev) === stableJson(merged)) return;
    this.facts.set(key, merged);
    this.host.emit(ev);
  }

  private avatarOf(aci: string, number?: string | null): string | undefined {
    const names = [number && `profile-${number}`, `profile-${aci}`, number && `contact-${number}`, `contact-${aci}`].filter(Boolean) as string[];
    for (const n of names) {
      const p = join(this.signalDir, 'avatars', n);
      if (existsSync(p)) return fileUrl(p);
    }
    return undefined;
  }

  private groupAvatar(groupId: string): string | undefined {
    const p = join(this.signalDir, 'avatars', `group-${groupId.replace(/\//g, '_')}`);
    return existsSync(p) ? fileUrl(p) : undefined;
  }

  private nameOf = (aci: string): string => this.names.get(aci) ?? (String(this.facts.get(`i:${aci}`)?.handle ?? '') || 'Someone');

  /** Contacts, everyone relevant, groups, known 1:1s. */
  async snapshot() {
    if (!this.daemon?.rpc?.open || !this.account) return;
    if (this.snapshotRunning) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotRunning = true;
    const self = this.account.aci;
    try {
      const rpc = this.rpc;
      const everyone = (await rpc.call<SigContact[]>('listContacts', { allRecipients: true }, 300_000)) ?? [];
      const contacts = (await rpc.call<SigContact[]>('listContacts', {}, 300_000)) ?? [];
      const groups = (await rpc.call<SigGroup[]>('listGroups', {}, 120_000)) ?? [];
      const contactIds = new Set(contacts.map((c) => lc(c.uuid)).filter((x): x is string => !!x));
      const all = new Map<string, SigContact>();
      for (const c of [...everyone, ...contacts]) {
        const id = lc(c.uuid);
        if (!id) continue;
        all.set(id, c);
        const name = displayNameOf(c);
        if (name) this.names.set(id, name);
        if (c.number) this.byNumber.set(c.number, id);
        if (c.messageExpirationTime !== undefined && id !== self) this.timers.set(`dm:${self}:${id}`, c.messageExpirationTime);
      }
      const relevant = new Set<string>([...contactIds, ...this.state.dms]);
      for (const g of groups) if (g.isMember !== false) for (const m of g.members ?? []) if (m.uuid) relevant.add(lc(m.uuid)!);
      for (const [id, c] of all) {
        if (id === self || !relevant.has(id)) continue;
        const f = contactIdentity(c, { contact: contactIds.has(id) && !c.isHidden, avatarUrl: this.avatarOf(id, c.number) });
        if (f) this.emitFact({ t: 'identity', identity: f });
        this.noteAbout(c, contactIds.has(id));
      }
      const me = all.get(self);
      if (me) {
        const name = displayNameOf(me);
        if (name && name !== this.selfName) {
          this.selfName = name;
          this.emitFact({ t: 'identity', identity: { nativeId: self, handle: this.account.number, displayName: name, isSelf: true } });
        }
      }
      this.recipients = all;
      // Requests are rebuilt from this read and go out once, below: invitations from the groups, message requests
      // from who wrote first and what signal-cli now says about them.
      this.batching = true;
      for (const g of groups) this.applyGroup(g);
      const listed = new Set(groups.map((g) => g.id));
      for (const id of [...this.invited.keys()]) {
        if (listed.has(id)) continue;
        this.invited.delete(id);
        this.state.invites.delete(id);
      }
      for (const peer of this.state.heard.keys()) this.decide(peer, all.get(peer));
      this.emitFact({ t: 'conversation', conversation: noteToSelf(self) });
      // A 1:1 archived on the phone says so (isArchived; groups' archive flag is not in signal-cli's JSON, e4).
      for (const peer of this.state.dms) this.emitFact({ t: 'conversation', conversation: { ...directConversation(self, peer), ...(all.has(peer) ? { archived: !!all.get(peer)!.isArchived } : {}) } });
      this.publishLinks(all, contactIds);
      this.state.seenAt = Date.now();
      this.state.save();
      this.batching = false;
      if (this.requestsKnown) this.publishRequests();
      else this.sendAllRequests();
      this.recheckCapabilities();
      this.host.log('debug', `snapshot: ${contacts.length} contacts, ${all.size} recipients, ${groups.length} groups, ${this.state.dms.size} 1:1s, ${this.told.size} requests`);
      // Safety numbers (local, no server call) at the snapshot's pace; devices (a server call) more slowly.
      await this.readKeys();
      if (Date.now() - this.devicesAt > (this.opts.devicesEveryMs ?? 6 * 3_600_000)) await this.readDevices();
    } catch (e: any) {
      this.host.log('warn', `could not read contacts/groups: ${e?.message ?? e}`);
    } finally {
      this.batching = false;
      this.snapshotRunning = false;
      if (this.snapshotAgain) {
        this.snapshotAgain = false;
        this.scheduleSnapshot(1000);
      }
    }
  }

  private scheduleSnapshot(delay: number) {
    clearTimeout(this.debouncedSnapshot);
    this.debouncedSnapshot = setTimeout(() => void this.snapshot(), delay);
  }

  /**
   * Emit a group's conversation fact. Groups you left or were removed from keep their history (no `leave`).
   * Admins made or unmade since the last read become role events, by whoever's group update `cause` was.
   * A group you are only invited to is a request instead, never a conversation; `cause` names who invited you when
   * it is the update that did.
   */
  private applyGroup(g: SigGroup, cause?: GroupCause) {
    if (this.invitedHere(g)) {
      this.noteInvite(g, cause);
      this.releaseHeld(g.id, false);
      return;
    }
    if (this.invited.delete(g.id)) {
      // Accepted or declined elsewhere, or withdrawn.
      this.state.invites.delete(g.id);
      this.state.save();
      this.publishRequests();
    }
    if (g.isMember === false && !this.knownGroups.has(g.id)) {
      this.releaseHeld(g.id, false); // asked to join and waiting, or left long ago
      return;
    }
    const before = this.state.groups.get(g.id);
    this.emitFact({ t: 'conversation', conversation: groupConversation(g, { avatarUrl: this.groupAvatar(g.id) }) });
    this.knownGroups.add(g.id);
    this.state.groups.set(g.id, g);
    this.timers.set(`group:${g.id}`, g.messageExpirationTime ?? 0);
    this.releaseHeld(g.id, true);
    if (!before) return;
    const target: P.AboutTarget = { kind: 'conversation', nativeId: groupConvId(g.id) };
    const { given, taken } = adminChanges(before, g);
    for (const member of given) this.host.emit({ t: 'role', target, member, role: 'Admin', given: true, ...cause });
    for (const member of taken) this.host.emit({ t: 'role', target, member, role: 'Admin', given: false, ...cause });
  }

  /**
   * Re-read one group from signal-cli, and tell the hub if its name, topic, members or admins changed. `members`:
   * identity facts for its members first, for a group that is new to the hub.
   */
  private async readGroup(groupId: string, cause?: GroupCause, members = false): Promise<SigGroup | undefined> {
    const [g] = (await this.rpc.call<SigGroup[]>('listGroups', { groupId: [groupId] }, 60_000)) ?? [];
    if (!g) return undefined;
    for (const m of g.members ?? []) {
      const id = lc(m.uuid);
      if (id && m.number && !this.byNumber.has(m.number)) this.byNumber.set(m.number, id);
    }
    if (members && g.isMember !== false) this.emitMembers(g);
    this.applyGroup(g, cause);
    this.state.save();
    // Someone asking to join a group you admin is a request (groups.ts); a re-read is when that shows.
    if (this.requestsKnown) this.publishRequests();
    return g;
  }

  private async refreshGroup(groupId: string) {
    if (this.groupRefreshing.has(groupId)) return;
    this.groupRefreshing.add(groupId);
    try {
      const before = this.state.groups.get(groupId);
      const update = this.pendingGroupUpdates.get(groupId);
      const g = await this.readGroup(groupId, update && { by: update.author, ts: update.ts });
      if (!g) {
        this.releaseHeld(groupId, true); // signal-cli cannot say: show it as before
        return;
      }
      const pend = this.pendingGroupUpdates.get(groupId);
      if (pend) {
        this.pendingGroupUpdates.delete(groupId);
        const body = describeGroupChange(before, g, pend.author, this.self, this.nameOf);
        // Not for an invitation: that group is not shown.
        if (body !== pend.text && this.knownGroups.has(groupId)) {
          this.host.emit({ t: 'message', live: true, message: { nativeId: pend.nativeId, conversation: pend.conversation, author: pend.author, ts: pend.ts, kind: 'system', body } });
          this.state.remember(pend.nativeId, pend.conversation, body);
        }
      }
      this.state.save();
    } catch (e: any) {
      this.host.log('debug', `group refresh failed: ${e?.message ?? e}`);
      this.releaseHeld(groupId, true);
    } finally {
      this.groupRefreshing.delete(groupId);
    }
  }

  /** Events held for a group until a read said what it is: shown when it is yours, dropped when it is not. */
  private releaseHeld(groupId: string, show: boolean) {
    const conv = groupConvId(groupId);
    const evs = this.heldEvents.get(conv);
    if (!evs) return;
    this.heldEvents.delete(conv);
    if (!show) {
      this.host.log('debug', `dropped ${evs.length} event(s) for a group you are not in`);
      return;
    }
    // The group's own fact is out by now; the stub the envelope made would only take its place.
    const events = this.facts.has(`c:${conv}`) ? evs.filter((e) => e.t !== 'conversation') : evs;
    this.apply({ events, messages: [], refreshGroups: [], resync: false, pinTimers: [], logs: [] });
  }

  // ---------------------------------------------------------------- incoming

  mapContext(): MapContext {
    return {
      self: this.self,
      selfNumber: this.account?.number,
      signalDir: this.signalDir,
      conversationOf: (id) => this.state.conversationOf(id),
      originalOf: (id) => this.state.originalOf(id),
      aciOfNumber: (n) => this.byNumber.get(n),
      knownGroup: (g) => this.knownGroups.has(g),
      sticker: (packId, stickerId) => this.stickerInfo(packId, stickerId),
      exists: (path) => existsSync(path),
      nameOf: (aci) => this.names.get(aci),
      calls: this.callBook,
      once: (key) => {
        if (this.seenKeys.has(key)) return false;
        this.seenKeys.add(key);
        if (this.seenKeys.size > 2000) this.seenKeys.delete(this.seenKeys.values().next().value!);
        return true;
      },
    };
  }

  private stickerInfo(packId: string, stickerId: number) {
    let pack = this.stickerCache.get(packId);
    if (pack === undefined || pack === null) {
      const p = join(this.signalDir, 'stickers', packId.replace(/[^0-9a-f]/gi, ''), 'manifest.json');
      if (!existsSync(p)) return undefined; // still downloading; don't cache the miss
      try {
        const m = JSON.parse(readFileSync(p, 'utf8'));
        pack = new Map();
        for (const s of [...(m.stickers ?? []), ...(m.cover ? [m.cover] : [])]) pack.set(Number(s.id ?? s.file), { emoji: s.emoji, contentType: s.contentType });
        this.stickerCache.set(packId, pack);
      } catch {
        return undefined;
      }
    }
    return pack.get(stickerId);
  }

  private stickerPath(packId: string, stickerId: number) {
    return resolve(join(this.signalDir, 'stickers', packId.replace(/[^0-9a-f]/gi, ''), String(stickerId)));
  }

  /** A pack as the sticker picker shows it: its stickers from signal-cli's copy (fetchMedia gets one not there yet). */
  private packFact(p: SigStickerPack): P.StickerPackFact {
    const stickers = (p.stickers ?? []).map((x) => ({
      id: `${p.packId}:${x.id}`,
      name: x.emoji ? `${x.emoji}` : `Sticker ${x.id + 1}`,
      ...(x.emoji ? { emoji: x.emoji } : {}),
      url: fileUrl(this.stickerPath(p.packId, x.id)),
      ...(x.contentType ? { mime: x.contentType } : {}),
    }));
    return { id: p.packId, name: p.title || 'Sticker pack', source: 'installed', ...(p.cover ? { cover: fileUrl(this.stickerPath(p.packId, p.cover.id)) } : {}), stickers };
  }

  /** One page of the installed packs (capability 'sendStickers'): signal-cli's listStickerPacks, nothing fetched. */
  private async stickers(cursor?: string): Promise<P.StickerPage> {
    const all = ((await this.call<SigStickerPack[]>('listStickerPacks', {})) ?? []).filter((p) => p.installed !== false && /^[0-9a-f]{32}$/i.test(p.packId) && p.stickers?.length);
    const from = Math.max(0, Number(cursor ?? 0) || 0);
    const page = all.slice(from, from + STICKER_PAGE_PACKS);
    return {
      packs: page.map((p) => this.packFact(p)),
      next: from + STICKER_PAGE_PACKS < all.length ? String(from + STICKER_PAGE_PACKS) : null,
      ...(all.length ? {} : { note: 'No sticker packs installed. Install one on your phone, or paste a signal.art link.' }),
    };
  }

  /** Install a pack from a signal.art link (capability 'installStickers'), then read it back from the list. */
  private async addStickerPack(uri: string): Promise<{ pack: P.StickerPackFact }> {
    const link = signalStickerLink(uri);
    if (!link) throw new Error('That is not a signal.art sticker pack link');
    await this.call('addStickerPack', { uri: [uri.trim()] }, 60_000);
    const pack = ((await this.call<SigStickerPack[]>('listStickerPacks', {})) ?? []).find((p) => p.packId.toLowerCase() === link.packId);
    if (!pack) throw new Error('Signal did not install that pack');
    return { pack: this.packFact(pack) };
  }

  /**
   * You opened someone's story: a viewed receipt, as Signal's apps send for stories, only with read receipts on in your
   * phone's settings (not known: none), never to someone whose message request waits, never your own, once.
   */
  private async storyViewed(story: string): Promise<{ sent: boolean }> {
    const m = this.message(story);
    if (m.author === this.self || this.viewedSent.has(story)) return { sent: false };
    if (await this.quiet(dmId(this.self, m.author))) return { sent: false };
    if (this.settings().readReceipts !== true) return { sent: false };
    await this.call('sendReceipt', { recipient: m.author, targetTimestamp: [m.ts], type: 'viewed' });
    this.viewedSent.add(story);
    return { sent: true };
  }

  /**
   * Reply to a story, or react to it with an emoji: in the author's 1:1, or the group of a group story, as Signal's
   * apps put it. Shown here as the reply line incoming ones get ("Replied to …'s story").
   */
  private async storyReply(story: string, conversation: string | undefined, body?: string, emoji?: string): Promise<{ nativeId: string }> {
    const self = this.self;
    const m = this.message(story);
    if (m.author === self) throw new Error('That is your own story');
    const conv = conversation?.startsWith('group:') ? conversation : dmId(self, m.author);
    await this.refuseQuiet(conv);
    const target = this.target(conv);
    let ts: number;
    let text = '';
    if (emoji) {
      const res = await this.call('sendReaction', { ...target, emoji, targetAuthor: m.author, targetTimestamp: m.ts, story: true });
      ts = res?.timestamp ?? Date.now();
    } else {
      const st = toSignal(body ?? '');
      if (!st.text.trim()) throw new Error('Write something to reply with');
      const res = await this.call('send', { ...target, message: st.text, storyTimestamp: m.ts, storyAuthor: m.author, ...(st.textStyles.length ? { textStyle: st.textStyles } : {}) });
      this.logPartialFailure('story reply', res);
      ts = res.timestamp;
      text = fromSignal(st.text, st.styles, st.mentionRanges);
    }
    const nativeId = msgId(self, ts);
    this.host.emit({ t: 'message', live: true, message: { nativeId, conversation: conv, author: self, ts, kind: 'text', body: text, extra: { storyReply: { author: m.author, ts: m.ts, ...(emoji ? { emoji } : {}) } } } });
    if (text) this.state.remember(nativeId, conv, text);
    return { nativeId };
  }

  /** One `receive` notification. Public for tests. */
  received(rcv: SigReceive) {
    if (!this.account) return;
    let r: MapResult;
    try {
      r = mapReceive(rcv, this.mapContext());
    } catch (e: any) {
      this.host.log('error', `could not map an incoming envelope: ${e?.message ?? e}`, { ts: rcv.envelope?.timestamp });
      return;
    }
    this.apply(r);
    // Signal pushes no profile changes, but a new profile key means theirs may have changed: read them again.
    const pk = rcv.envelope?.dataMessage?.isProfileKeyUpdate ? lc(rcv.envelope.sourceUuid) : null;
    if (pk && pk !== this.account.aci) void this.rereadPerson(pk);
    // A sync message from your other devices that signal-cli shows nothing of (no transcript, read sync, list or
    // blocked list): a message request answered on the phone is one, and the storage update that follows tells
    // signal-cli. signal-cli 0.14.8 does not show which, so look at the open message requests again.
    const env = rcv.envelope;
    const s = env?.syncMessage;
    if (s && lc(env?.sourceUuid) === this.account.aci && !s.sentMessage && !s.sentStoryMessage && !s.readMessages?.length && !s.type && !s.blockedNumbers && !s.blockedGroupIds) this.recheckRequests();
  }

  private apply(r: MapResult) {
    const self = this.self;
    for (const l of r.logs) this.host.log(l.level, l.msg, l.data);
    // A group signal-cli had not listed (an invitation, or a group joined on another device): its events wait for
    // the re-read, which says whether it is yours to show (applyGroup, releaseHeld).
    const hold = new Set(r.refreshGroups.filter((g) => !this.knownGroups.has(g)).map(groupConvId));
    for (const ev of r.events) {
      const conv = ev.t === 'conversation' ? ev.conversation.nativeId : ev.t === 'message' ? ev.message.conversation : (ev as { conversation?: unknown }).conversation;
      if (typeof conv === 'string' && hold.has(conv)) {
        (this.heldEvents.get(conv) ?? this.heldEvents.set(conv, []).get(conv)!).push(ev);
        continue;
      }
      if (ev.t === 'identity') {
        if (ev.identity.displayName) this.names.set(ev.identity.nativeId, ev.identity.displayName);
        if (ev.identity.handle && /^\+\d+$/.test(ev.identity.handle)) this.byNumber.set(ev.identity.handle, ev.identity.nativeId);
        this.emitFact(ev);
      } else if (ev.t === 'conversation') {
        const c = ev.conversation;
        if (c.shape === 'direct') {
          const peer = c.participants?.find((p) => p !== self);
          if (peer && !this.state.dms.has(peer)) {
            this.state.dms.add(peer);
            this.state.save();
          }
        }
        if (c.nativeId.startsWith('group:') && c.participants) this.knownGroups.add(c.nativeId.slice(6));
        this.emitFact(ev);
      } else {
        this.host.emit(ev);
        if (ev.t === 'delete') this.purge(ev.nativeId);
        if (ev.t === 'pin') this.dropPinTimer(ev.message);
        if (ev.t === 'read') {
          this.state.takeUnread(ev.conversation, ev.upToTs);
          this.acked.set(ev.conversation, Math.max(this.acked.get(ev.conversation) ?? 0, ev.upToTs));
          this.startExpiry(ev.conversation, ev.upToTs);
        }
      }
    }
    for (const m of r.messages) {
      this.state.remember(m.nativeId, m.conversation, m.text, m.replyTo, m.files, m.quote);
      if (m.author !== self && !m.editedTs && m.kind !== 'system' && m.kind !== 'call' && m.ts > (this.acked.get(m.conversation) ?? 0)) {
        this.state.addUnread(m.conversation, m.author, m.ts);
      }
      if (m.author === self && m.editedTs) this.state.alias(msgId(self, m.editedTs), m.nativeId, m.conversation);
      const dm = parseConversation(m.conversation, self);
      if (dm?.kind === 'dm') {
        if (m.author === self) this.spoke(dm.peer);
        else if (m.author === dm.peer) this.heardFrom(dm.peer, m.ts);
      }
      if (m.timer !== undefined) this.timers.set(m.conversation, m.timer);
      if (m.expiresInSeconds) this.trackExpiry(m, m.expiresInSeconds, m.author === self ? Date.now() : undefined);
      if (m.groupUpdate) this.pendingGroupUpdates.set(m.groupUpdate, m);
    }
    if (r.pinTimers.length) {
      this.state.pins.push(...r.pinTimers);
      this.state.save();
    }
    for (const g of r.refreshGroups) setTimeout(() => void this.refreshGroup(g), 500);
    if (r.resync) this.scheduleSnapshot(5000);
    // A view-once message's files: signal-cli downloaded them, and they are not kept (docs/signal.md "View-once").
    for (const path of r.discard ?? []) this.dropFile(path);
    if (r.storyFiles?.length) {
      this.state.storyFiles.push(...r.storyFiles);
      this.state.save();
    }
  }

  /** Delete a file signal-cli downloaded, only inside its own directory. */
  private dropFile(path: string) {
    const p = resolve(path);
    if (!p.startsWith(this.signalDir + sep)) return;
    try {
      rmSync(p, { force: true });
    } catch (e: any) {
      this.host.log('warn', `could not delete ${p}: ${e?.message ?? e}`);
    }
  }

  // ---------------------------------------------------------------- disappearing messages

  /** Remember a disappearing message. Its timer starts when it is read (or at once for your own). */
  private trackExpiry(m: { nativeId: string; conversation: string; ts: number; files?: string[] }, ttl: number, started?: number) {
    if (!ttl || this.state.expiring.some((e) => e.id === m.nativeId)) return;
    this.state.expiring.push({ id: m.nativeId, conversation: m.conversation, ts: m.ts, ttl, ...(started ? { started } : {}), ...(m.files?.length ? { files: m.files } : {}) });
    this.state.save();
  }

  private startExpiry(conversation: string, upToTs: number) {
    const now = Date.now();
    let changed = false;
    for (const e of this.state.expiring) {
      if (e.conversation === conversation && e.ts <= upToTs && !e.started) {
        e.started = now;
        changed = true;
      }
    }
    if (changed) this.state.save();
  }

  /** A message is gone (remote delete, expiry, redact): drop its text and downloaded files, as Signal clients do. */
  private purge(id: string, extraFiles: string[] = []) {
    const attachments = join(this.signalDir, 'attachments') + sep;
    for (const f of new Set([...this.state.forget(id), ...extraFiles])) {
      const p = resolve(f);
      if (p.startsWith(attachments)) rmSync(p, { force: true });
    }
  }

  private dropPinTimer(message: string) {
    const left = this.state.pins.filter((p) => p.message !== message);
    if (left.length === this.state.pins.length) return;
    this.state.pins = left;
    this.state.save();
  }

  /**
   * Delete disappearing messages whose timer ran out, including their downloaded files, and unpin pins whose time is
   * up (Signal's clients do so on their own; nobody sends anything). Public for tests.
   */
  sweepExpired(now = Date.now()) {
    // Stories end after a day, and their files go with them.
    const over = this.state.storyFiles.filter(([, until]) => until <= now);
    if (over.length) {
      for (const [path] of over) this.dropFile(path);
      this.state.storyFiles = this.state.storyFiles.filter(([, until]) => until > now);
      this.state.save();
    }
    const ended = this.state.pins.filter((p) => p.until <= now);
    if (ended.length) {
      this.state.pins = this.state.pins.filter((p) => p.until > now);
      for (const p of ended) this.host.emit({ t: 'pin', conversation: p.conversation, message: p.message, pinned: false, ts: p.until });
      this.state.save();
    }
    const keep: typeof this.state.expiring = [];
    for (const e of this.state.expiring) {
      if (e.started && e.started + e.ttl * 1000 <= now) {
        this.host.emit({ t: 'delete', conversation: e.conversation, nativeId: e.id, reason: 'expired' });
        this.purge(e.id, e.files);
      } else keep.push(e);
    }
    if (keep.length !== this.state.expiring.length) {
      this.state.expiring = keep;
      this.state.save();
    }
  }

  // ---------------------------------------------------------------- commands

  private target(conversation: string): Record<string, unknown> {
    const t = parseConversation(conversation, this.self);
    if (!t) throw new Error(`not a Signal conversation of this account: ${conversation}`);
    if (t.kind === 'group') return { groupId: t.groupId };
    if (t.kind === 'self') return { noteToSelf: true };
    return { recipient: [t.peer] };
  }

  private message(id: string) {
    const m = parseMsgId(id);
    if (!m) throw new Error(`not a Signal message id: ${id}`);
    return m;
  }

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'history':
        // Linked devices receive no history from the phone.
        return { count: 0, done: true };
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments, cmd.preview, { sticker: cmd.sticker, viewOnce: cmd.viewOnce });
      case 'stickers':
        return this.stickers(cmd.cursor);
      case 'addStickerPack':
        return this.addStickerPack(cmd.uri);
      case 'storyViewed':
        return this.storyViewed(cmd.story);
      case 'storyReply':
        return this.storyReply(cmd.story, cmd.conversation, cmd.body, cmd.emoji);
      case 'openDirect':
        return this.openDirect(cmd.peer);
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'react': {
        const m = this.message(cmd.message);
        await this.refuseQuiet(cmd.conversation);
        await this.call('sendReaction', { ...this.target(cmd.conversation), emoji: cmd.key, targetAuthor: m.author, targetTimestamp: m.ts, ...(cmd.remove ? { remove: true } : {}) });
        this.host.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: this.self, key: cmd.key, ...(cmd.remove ? { remove: true } : {}) });
        return {};
      }
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors':
        return { authors: [] }; // Signal names every reactor up front
      case 'redact': {
        const m = this.message(cmd.message);
        if (m.author !== this.self && cmd.moderator) return this.adminDelete(cmd.conversation, cmd.message);
        if (m.author !== this.self) throw new Error('Signal only lets you delete your own messages for everyone');
        await this.refuseQuiet(cmd.conversation);
        await this.call('remoteDelete', { ...this.target(cmd.conversation), targetTimestamp: m.ts });
        this.host.emit({ t: 'delete', conversation: cmd.conversation, nativeId: cmd.message });
        this.purge(cmd.message);
        return {};
      }
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'typing':
        return this.sendTyping(cmd.conversation, !!cmd.stop);
      case 'viewed':
        return this.viewed(cmd.conversation, cmd.message);
      case 'resetSession':
        return this.resetSession(cmd.conversation);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'about':
        return this.about(cmd.target);
      case 'configure':
        return this.configure(cmd.target, cmd.change);
      case 'addMembers':
        return this.addMembers(cmd.target, cmd.people);
      case 'createGroup':
        return this.createGroup(cmd.name, cmd.people);
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
      case 'verify':
        return this.verify(cmd.who, cmd.safetyNumber, !!cmd.clear);
      case 'block':
        return this.block(cmd.target, !!cmd.unblock);
      case 'setContact':
        return this.setContact(cmd.who, { nickname: cmd.nickname, note: cmd.note });
      case 'remove':
        return this.remove(cmd.identity, cmd.relationship);
      case 'pollVote':
        return this.pollVote(cmd.conversation, cmd.message, cmd.options, cmd.seq);
      case 'pollCreate':
        return this.pollCreate(cmd.conversation, cmd.poll);
      case 'pollEnd':
        return this.pollEnd(cmd.conversation, cmd.message);
      case 'leave':
        return this.leave(cmd.target, cmd.admins, !!cmd.forget);
      case 'moderate':
        return this.moderate(cmd.target, cmd.action);
      case 'bans':
        return this.bans(cmd.target);
      case 'setLabel':
        return this.setLabel(cmd.conversation, cmd.text, cmd.emoji);
      case 'clearReactions':
        throw new Error('Signal does not let anyone remove others’ reactions.');
      case 'shutdown':
        return undefined;
    }
  }

  // ---------------------------------------------------------------- polls and pins (docs/signal.md "Polls and pins")

  /** Your last vote's number on each poll this run: the next one is higher, as Signal's apps count. */
  private pollSeq = new Map<string, number>();

  /**
   * Vote, or with [] take your vote back: signal-cli's sendPollVote with the options' positions and a number higher than
   * your last on this poll (the hub's, or this run's). Not in a message request, which it would answer.
   */
  private async pollVote(conversation: string, message: string, options: string[], seq?: number) {
    const m = this.message(message);
    await this.refuseQuiet(conversation);
    const indexes = options.map((o) => Number(o));
    if (indexes.some((i) => !Number.isInteger(i) || i < 0)) throw new Error('Not an option of this poll');
    const voteCount = Math.max(seq ?? 0, this.pollSeq.get(message) ?? 0) + 1;
    await this.call('sendPollVote', { ...this.target(conversation), pollAuthor: m.author, pollTimestamp: m.ts, option: indexes, voteCount });
    this.pollSeq.set(message, voteCount);
    this.host.emit({ t: 'pollUpdate', conversation, message, vote: { voter: this.self, options: indexes.map(String), seq: voteCount, ts: Date.now() } });
    return {};
  }

  /** A poll: signal-cli's sendPollCreate. Signal's polls have no timer; they stay open until their author ends them. */
  private async pollCreate(conversation: string, draft: P.PollDraft): Promise<{ nativeId: string }> {
    const problem = pollDraftProblem('signal', draft);
    if (problem) throw new Error(problem);
    await this.refuseQuiet(conversation);
    const question = draft.question.trim();
    const options = draft.options.map((o) => o.trim());
    const res = await this.call('sendPollCreate', { ...this.target(conversation), question, option: options, ...(draft.multi ? {} : { noMulti: true }) });
    this.logPartialFailure('poll', res);
    const self = this.self;
    const ts = res?.timestamp ?? Date.now();
    const nativeId = msgId(self, ts);
    const poll = pollFact({ question, options, allowMultiple: draft.multi });
    const body = [`📊 **${question}**${draft.multi ? ' (multiple choice)' : ''}`, ...options.map((x) => `• ${x}`)].join('\n');
    this.host.emit({ t: 'message', live: true, message: { nativeId, conversation, author: self, ts, kind: 'text', body, extra: { poll } } });
    return { nativeId };
  }

  /** End your own poll: signal-cli's sendPollTerminate. */
  private async pollEnd(conversation: string, message: string) {
    const m = this.message(message);
    if (m.author !== this.self) throw new Error('Only whoever made a poll can end it');
    await this.refuseQuiet(conversation);
    const res = await this.call<Partial<SigSendResult>>('sendPollTerminate', { ...this.target(conversation), pollTimestamp: m.ts });
    const ts = res?.timestamp ?? Date.now();
    this.systemMessage(conversation, ts, 'You ended the poll.');
    this.host.emit({ t: 'pollUpdate', conversation, message, ended: true, ts });
    return {};
  }

  /**
   * Pin or unpin: signal-cli's sendPinMessage (for one of PIN_DURATIONS, -1 for good) and sendUnpinMessage. Not in a
   * message request. A pin that runs out is unpinned here when its time comes, as an incoming one is.
   */
  private async pin(conversation: string, change: Extract<P.AboutChange, { key: 'pin' }>) {
    const m = this.message(change.message);
    await this.refuseQuiet(conversation);
    const self = this.self;
    if (change.remove) {
      const res = await this.call<Partial<SigSendResult>>('sendUnpinMessage', { ...this.target(conversation), targetAuthor: m.author, targetTimestamp: m.ts });
      const ts = res?.timestamp ?? Date.now();
      this.host.emit({ t: 'pin', conversation, message: change.message, pinned: false, by: self, ts });
      this.dropPinTimer(change.message);
      this.systemMessage(conversation, ts, 'You unpinned a message.');
      return;
    }
    const choices = PIN_DURATIONS.signal ?? [];
    const seconds = change.seconds === undefined ? choices[0] : change.seconds;
    if (!choices.includes(seconds ?? null)) throw new Error('Not one of the pin durations Signal offers');
    const res = await this.call<Partial<SigSendResult>>('sendPinMessage', { ...this.target(conversation), targetAuthor: m.author, targetTimestamp: m.ts, pinDuration: seconds ?? -1 });
    const ts = res?.timestamp ?? Date.now();
    this.host.emit({ t: 'pin', conversation, message: change.message, pinned: true, by: self, ts });
    this.dropPinTimer(change.message);
    if (seconds) {
      this.state.pins.push({ conversation, message: change.message, until: ts + seconds * 1000 });
      this.state.save();
    }
    this.systemMessage(conversation, ts, 'You pinned a message.');
  }

  /**
   * signal-cli's sendTyping: STARTED, or STOPPED with `stop`. Not in notes to self, which nobody else sees, nor in a
   * message request, whose sender would learn it was opened.
   */
  private async sendTyping(conversation: string, stop: boolean) {
    const t = parseConversation(conversation, this.self);
    if (!t || t.kind === 'self') return { ok: false };
    if (await this.quiet(conversation)) return { ok: false };
    // signal-cli's sendTyping does not look at the phone's setting (its receive side does): off there, nothing goes.
    // Not known (not synced yet, or not readable): sent, as before, and as Signal's default has it.
    if (this.settings().typingIndicators === false) return { ok: false };
    await this.call('sendTyping', { ...(t.kind === 'group' ? { groupId: t.groupId } : { recipient: [t.peer] }), ...(stop ? { stop: true } : {}) });
    return { ok: true };
  }

  /** Signal has no custom emoji or super reactions. The one thing that stops you is having left the group. */
  private reactionContext(conversation: string): P.ReactionContext {
    const t = parseConversation(conversation, this.self);
    const g = t?.kind === 'group' ? this.state.groups.get(t.groupId) : undefined;
    const left = g?.isMember === false;
    // A group's admins delete others' messages for everyone (sendAdminDelete); nobody removes others' reactions.
    const admin = !!g && !left && !g.isTerminated && isAdmin(g, this.self);
    return { canReact: !left, ...(left ? { reason: 'You are no longer in this group.' } : {}), custom: [], ...(admin ? { moderation: { delete: true } } : {}) };
  }

  private async call<T = SigSendResult>(method: string, params: Record<string, unknown>, timeoutMs = 90_000): Promise<T> {
    try {
      const r = await this.rpc.call<T>(method, params, timeoutMs);
      if (this.lastStatus?.attention?.kind === 'rate_limited') this.setStatus('online', null);
      return r;
    } catch (e) {
      const challenge = challengeOf(e);
      if (challenge) this.wantCaptcha(challenge);
      else if (e instanceof RpcError && e.code === -5) {
        this.setStatus('attention', { kind: 'rate_limited', message: `Signal is rate limiting this device: ${e.message}` });
      }
      throw e;
    }
  }

  /**
   * A quote of a message, the way Signal's clients send one: its text with its mentions and styles, and its files (a
   * small picture as its own thumbnail), when this device has seen it since quotes were kept; else its plain text.
   */
  private quoteParams(replyTo: string): Record<string, unknown> {
    const q = this.message(replyTo);
    const params: Record<string, unknown> = { quoteTimestamp: q.ts, quoteAuthor: q.author };
    const src = this.state.quoteOf(replyTo);
    if (src) {
      if (src.t) params.quoteMessage = src.t;
      if (src.m?.length) params.quoteMention = src.m;
      if (src.s?.length) params.quoteTextStyle = src.s;
      // A thumbnail whose file has gone (expired, deleted) goes without it.
      const a = (src.a ?? []).map((x) => {
        const parts = x.split(':');
        return parts.length > 2 && !existsSync(parts.slice(2).join(':')) ? parts.slice(0, 2).join(':') : x;
      });
      if (a.length) params.quoteAttachment = a;
      return params;
    }
    const text = this.state.textOf(replyTo);
    if (text) params.quoteMessage = text;
    return params;
  }

  /**
   * A link preview for a message (the hub fetched it), sent only while your phone's setting allows link previews (not
   * known: none), and only for a link that is in the text, as signal-cli asks.
   */
  private previewParams(text: string, preview?: P.LinkPreviewOut): Record<string, unknown> {
    if (!preview?.url || !preview.title || !text.includes(preview.url)) return {};
    if (this.settings().linkPreviews !== true) return {};
    return {
      previewUrl: preview.url,
      previewTitle: preview.title,
      ...(preview.description ? { previewDescription: preview.description } : {}),
      ...(preview.image && existsSync(preview.image) ? { previewImage: preview.image } : {}),
    };
  }

  private async send(conversation: string, body: string, replyTo?: string, files: P.OutgoingAttachment[] = [], preview?: P.LinkPreviewOut, o: { sticker?: string; viewOnce?: boolean } = {}) {
    const self = this.self;
    const st = toSignal(body);
    const params: Record<string, unknown> = { ...this.target(conversation), message: st.text };
    // signal-cli's send turns profile sharing on and carries your profile key: that is accepting.
    await this.refuseQuiet(conversation);
    const sticker = o.sticker ? stickerRef(o.sticker) : null;
    if (o.sticker && !sticker) throw new Error('That is not a Signal sticker');
    if (sticker && files.length) throw new Error('A sticker goes on its own, without files');
    if (st.textStyles.length) params.textStyle = st.textStyles;
    if (st.mentions.length) params.mention = st.mentions;
    if (replyTo) Object.assign(params, this.quoteParams(replyTo));
    if (sticker) params.sticker = `${sticker.packId}:${sticker.stickerId}`;
    if (files.length) {
      params.attachment = files.map((f) => f.path);
      // Recorded in the composer: Signal's voice note (one file).
      if (files.length === 1 && files[0].voice) params.voiceNote = true;
      if (o.viewOnce) params.viewOnce = true;
    } else if (!sticker) Object.assign(params, this.previewParams(st.text, preview));
    const res = await this.call('send', params, files.length ? 170_000 : undefined);
    this.logPartialFailure('send', res);
    const ts = res.timestamp;
    const nativeId = msgId(self, ts);
    const t = parseConversation(conversation, self)!;
    if (t.kind === 'dm') {
      this.apply(emptyResult({ t: 'conversation', conversation: directConversation(self, t.peer) }));
      this.spoke(t.peer);
    }
    const fact: P.MessageFact = { nativeId, conversation, author: self, ts, kind: 'text', body: fromSignal(st.text, st.styles, st.mentionRanges) };
    if (replyTo) fact.replyTo = replyTo;
    if (sticker) {
      // Shown as the sticker it is, from signal-cli's copy of the pack (fetchMedia asks for it when it is not on disk).
      const info = this.stickerInfo(sticker.packId, sticker.stickerId);
      fact.kind = 'sticker';
      fact.attachments = [{ nativeId: `sticker:${sticker.packId}:${sticker.stickerId}`, kind: 'image', mime: info?.contentType || 'image/webp', name: 'sticker', url: fileUrl(this.stickerPath(sticker.packId, sticker.stickerId)) }];
      if (!fact.body) fact.body = info?.emoji ?? '';
    }
    // No echo comes back to this device. Keep our own copy, the way a received file is kept, since the hub drops its spool.
    // A view-once file is not kept: Signal's apps do not show you your own either.
    const kept = (o.viewOnce ? [] : files).map((f, i) => {
      const dest = join(this.signalDir, 'attachments', `sent-${ts}-${i}`);
      mkdirSync(join(this.signalDir, 'attachments'), { recursive: true });
      copyFileSync(f.path, dest);
      return { file: dest, fact: { kind: f.kind, mime: f.mime, name: f.name, size: f.size, url: `file://${dest}` } satisfies P.AttachmentFact };
    });
    if (kept.length) {
      fact.attachments = kept.map((k) => k.fact);
      if (!st.text) fact.kind = 'media';
    }
    const extra: P.MessageExtra & Record<string, unknown> = {};
    if (sticker) extra.sticker = sticker;
    if (o.viewOnce && files.length) {
      fact.kind = 'media';
      if (!fact.body) fact.body = '📷 View-once media';
      extra.viewOnce = true;
    }
    if (files.length === 1 && files[0].voice && kept.length) extra.attachmentNotes = [{ voiceNote: true }];
    // Some people in a group did not get it (the others did; when nobody does, signal-cli fails the send).
    const failed = sendFailures(res.results);
    if (failed.length) extra.failed = failed;
    if (params.previewUrl) {
      // Shown here as it went out, with our own copy of the picture (the hub deletes its spool).
      let image: string | undefined;
      if (params.previewImage) {
        image = join(this.signalDir, 'attachments', `sent-${ts}-preview`);
        copyFileSync(String(params.previewImage), image);
      }
      extra.embeds = [{ url: params.previewUrl, title: params.previewTitle, ...(params.previewDescription ? { description: params.previewDescription } : {}), provider: hostOf(String(params.previewUrl)), ...(image ? { image: fileUrl(image) } : {}) }];
    }
    if (Object.keys(extra).length) fact.extra = extra;
    this.host.emit({ t: 'message', live: true, message: fact });
    const quoteFiles = files.map((f, i) => quoteAttachment(f.mime, f.name, f.kind === 'image' && f.size <= QUOTE_THUMB_MAX ? (kept[i]?.file ?? null) : null));
    this.state.remember(nativeId, conversation, st.text, replyTo, kept.map((k) => k.file), quoteSource(st.text, st.mentions, st.textStyles, quoteFiles));
    const timer = this.timers.get(conversation);
    if (timer) this.trackExpiry({ nativeId, conversation, ts }, timer, Date.now());
    return { nativeId };
  }

  /** Signal has no "create": this only names the conversation, and nothing reaches the network until the first send. */
  private async openDirect(peer: string): Promise<P.OpenDirectResult> {
    const self = this.self;
    const aci = peer.startsWith('+') ? await this.aciOfNumber(peer) : peer.toLowerCase();
    if (aci === self) throw new Error('that is this account: use Note to Self');
    const existed = this.state.dms.has(aci);
    const fact = directConversation(self, aci);
    if (peer.startsWith('+')) this.apply(emptyResult({ t: 'identity', identity: { nativeId: aci, handle: peer } }));
    this.apply(emptyResult({ t: 'conversation', conversation: fact }));
    return { conversation: fact.nativeId, existed, startsAtFirstSend: true };
  }

  /** Conversations are keyed by ACI, so a number has to become one or the echo would land in a second conversation. */
  private async aciOfNumber(number: string): Promise<string> {
    const known = this.byNumber.get(number);
    if (known) return known;
    const [status] = await this.call<{ uuid?: string | null; isRegistered?: boolean }[]>('getUserStatus', { recipient: [number] });
    if (!status?.isRegistered || !status.uuid) throw new Error(`${number} is not on Signal`);
    return status.uuid.toLowerCase();
  }

  private async edit(conversation: string, message: string, body: string) {
    const self = this.self;
    const m = this.message(message);
    if (m.author !== self) throw new Error('you can only edit your own messages');
    await this.refuseQuiet(conversation);
    const st = toSignal(body);
    const params: Record<string, unknown> = { ...this.target(conversation), message: st.text, editTimestamp: m.ts };
    if (st.textStyles.length) params.textStyle = st.textStyles;
    if (st.mentions.length) params.mention = st.mentions;
    // Clients rebuild the message from the edit, so a quote has to be sent again.
    const replyTo = this.state.replyOf(message);
    if (replyTo && parseMsgId(replyTo)) Object.assign(params, this.quoteParams(replyTo));
    const res = await this.call('send', params);
    this.logPartialFailure('edit', res);
    this.state.alias(msgId(self, res.timestamp), message, conversation);
    this.host.emit({
      t: 'message',
      live: true,
      message: { nativeId: message, conversation, author: self, ts: m.ts, editedTs: res.timestamp, kind: 'text', body: fromSignal(st.text, st.styles, st.mentionRanges) },
    });
    this.state.remember(message, conversation, st.text, undefined, undefined, quoteSource(st.text, st.mentions, st.textStyles));
    return { nativeId: message };
  }

  /**
   * You played someone's voice note or opened their video: a viewed receipt, as Signal's apps send ("played"). Only
   * where a read receipt would go and only with read receipts on in your phone's settings (not known: none), never in a
   * message request, never for your own, once per message.
   */
  private async viewed(conversation: string, message: string): Promise<{ sent: boolean }> {
    const self = this.self;
    const m = this.message(message);
    if (m.author === self || this.viewedSent.has(message)) return { sent: false };
    const t = parseConversation(conversation, self);
    if (!t || t.kind === 'self') return { sent: false };
    if (await this.quiet(conversation)) {
      this.host.log('debug', 'no viewed receipt: a message request waits for your answer');
      return { sent: false };
    }
    if (this.settings().readReceipts !== true) return { sent: false };
    await this.call('sendReceipt', { recipient: m.author, targetTimestamp: [m.ts], type: 'viewed' });
    this.viewedSent.add(message);
    if (this.viewedSent.size > 2000) this.viewedSent.delete(this.viewedSent.values().next().value!);
    return { sent: true };
  }

  /**
   * Reset the encrypted session with someone (Signal's end session), for messages that will not decrypt. A 1:1 only;
   * it tells them, so not in a message request. A line in the conversation says it was done, as Signal's apps show.
   */
  private async resetSession(conversation: string) {
    const self = this.self;
    const t = parseConversation(conversation, self);
    if (t?.kind !== 'dm') throw new Error('Only a conversation with one person has a secure session to reset');
    await this.refuseQuiet(conversation);
    const res = await this.call('send', { recipient: [t.peer], endSession: true });
    const ts = res?.timestamp ?? Date.now();
    const fact: P.MessageFact = { nativeId: `${msgId(self, ts)}:endsession`, conversation, author: self, ts, kind: 'system', body: 'You reset the secure session.' };
    this.host.emit({ t: 'message', live: true, message: fact });
    return {};
  }

  private async markRead(conversation: string, upTo: string) {
    const self = this.self;
    const m = this.message(upTo);
    // A message request: no read receipt until it is accepted, and what is unread stays so, for the receipts then.
    if (await this.quiet(conversation)) {
      this.host.log('debug', 'no read receipts: a message request waits for your answer');
      return { receipts: 0 };
    }
    const acks = this.state.takeUnread(conversation, m.ts);
    // Nothing tracked (e.g. after a restart): acknowledge the target itself, once.
    if (!acks.length && m.author !== self && m.ts > (this.acked.get(conversation) ?? 0)) acks.push([m.author, m.ts]);
    this.acked.set(conversation, Math.max(this.acked.get(conversation) ?? 0, m.ts));
    this.startExpiry(conversation, m.ts);
    const byAuthor = new Map<string, number[]>();
    for (const [a, ts] of acks) if (a !== self) (byAuthor.get(a) ?? byAuthor.set(a, []).get(a)!).push(ts);
    for (const [author, tss] of byAuthor) {
      // Also tells your other devices (the phone) that these are read.
      await this.call('sendReceipt', { recipient: author, targetTimestamp: tss.sort((a, b) => a - b), type: 'read' });
    }
    return { receipts: [...byAuthor.values()].reduce((n, l) => n + l.length, 0) };
  }

  private logPartialFailure(what: string, res: SigSendResult) {
    const challenge = challengeOf(res);
    if (challenge) this.wantCaptcha(challenge);
    const failed = (res?.results ?? []).filter((r) => r.type !== 'SUCCESS');
    if (failed.length) this.host.log('warn', `${what}: ${failed.length} recipient(s) failed`, failed.map((f) => ({ type: f.type, uuid: f.recipientAddress?.uuid })));
  }

  private async fetchMedia(url: string) {
    if (!url.startsWith('file://')) throw new Error(`Signal media is served from disk; cannot fetch ${url.split(':')[0]} URLs`);
    const p = resolve(fileURLToPath(url));
    if (!p.startsWith(this.signalDir + sep)) throw new Error('no such Signal media file');
    // A sticker of an installed pack signal-cli has not downloaded yet: its getSticker fetches it.
    const sticker = !existsSync(p) && p.startsWith(join(this.signalDir, 'stickers') + sep) ? /\/stickers\/([0-9a-f]{32})\/(\d+)$/i.exec(p) : null;
    if (sticker) {
      const r = await this.call<{ data?: string } | string>('getSticker', { packId: sticker[1], stickerId: Number(sticker[2]) }, 60_000);
      const data = typeof r === 'string' ? r : r?.data;
      if (!data) throw new Error('Signal did not give that sticker');
      const bytes = Buffer.from(data, 'base64');
      return { mime: this.stickerInfo(sticker[1], Number(sticker[2]))?.contentType || sniffMime(bytes, p), base64: data };
    }
    if (!existsSync(p)) throw new Error('no such Signal media file');
    const bytes = readFileSync(p);
    return { mime: sniffMime(bytes, p), base64: bytes.toString('base64') };
  }

  // ---------------------------------------------------------------- requests: invitations and message requests

  /** You are invited to this group and have not answered (not blocked, not ended). By ACI, or by number for an invitation to your phone number. */
  private invitedHere(g: SigGroup): boolean {
    if (g.isMember !== false || g.isBlocked || g.isTerminated || !this.account) return false;
    const me = this.account;
    return (g.pendingMembers ?? []).some((m) => lc(m.uuid) === me.aci || (!!m.number && m.number === me.number));
  }

  /** You asked to join by its link and its admins have not answered. */
  private requestingHere(g: SigGroup): boolean {
    const me = this.account;
    return !!me && g.isMember === false && (g.requestingMembers ?? []).some((m) => lc(m.uuid) === me.aci);
  }

  /** An invitation, seen in a group read. Who sent it is known only when the group update that brought it said. */
  private noteInvite(g: SigGroup, cause?: GroupCause) {
    if (!this.state.invites.has(g.id)) {
      const by = cause?.by && cause.by !== this.account?.aci ? cause.by : undefined;
      this.state.invites.set(g.id, { ...(by ? { by } : {}), ts: cause?.ts ?? Date.now() });
      this.state.save();
    }
    this.invited.set(g.id, g);
    this.publishRequests();
  }

  /** Someone wrote to you in a 1:1. The first time, it may be a message request: look, unless signal-cli already said. */
  private heardFrom(peer: string, ts: number) {
    if (peer === this.account?.aci || this.state.ours.has(peer) || this.state.heard.has(peer)) return;
    this.state.heard.set(peer, ts);
    this.state.save();
    const c = this.recipients.get(peer);
    if (c && !isMessageRequest(c)) {
      this.decide(peer, c);
      return;
    }
    this.unsure.add(peer);
    void this.classify(peer);
  }

  /** You wrote in a 1:1, here or on another device: it is your conversation, and no request. */
  private spoke(peer: string) {
    if (peer === this.account?.aci || this.state.ours.has(peer)) return;
    this.state.ours.add(peer);
    this.state.save();
    this.pendingPeers.delete(peer);
    this.unsure.delete(peer);
    this.publishRequests();
  }

  /** Whether a peer's 1:1 is a message request now, from what signal-cli has for them. */
  private decide(peer: string, c: SigContact | undefined): boolean {
    this.unsure.delete(peer);
    const pending = !!this.account && peer !== this.account.aci && this.state.heard.has(peer) && !this.state.ours.has(peer) && isMessageRequest(c);
    if (pending) this.pendingPeers.add(peer);
    else this.pendingPeers.delete(peer);
    return pending;
  }

  /** Read one peer from signal-cli (listContacts by ACI: no lookup on the server) and decide. A failed read stays quiet. */
  private classify(peer: string): Promise<boolean> {
    const running = this.classifying.get(peer);
    if (running) return running;
    const p = (async () => {
      try {
        const list = (await this.rpc.call<SigContact[]>('listContacts', { recipient: [peer], allRecipients: true }, 30_000)) ?? [];
        const c = list.find((x) => lc(x.uuid) === peer);
        if (c) this.recipients.set(peer, c);
        const pending = this.decide(peer, c);
        this.publishRequests();
        return pending;
      } catch (e: any) {
        this.host.log('debug', `could not read someone who wrote first: ${e?.message ?? e}`);
        return true;
      } finally {
        this.classifying.delete(peer);
      }
    })();
    this.classifying.set(peer, p);
    return p;
  }

  /**
   * The quiet rule: true for a message request's conversation (or a group you are only invited to), where nothing
   * may tell the other side it was seen. Someone not looked at yet is looked at first; if that fails, it is quiet.
   */
  private async quiet(conversation: string): Promise<boolean> {
    const t = this.account ? parseConversation(conversation, this.account.aci) : null;
    if (!t) return false;
    if (t.kind === 'group') return this.invited.has(t.groupId);
    if (t.kind !== 'dm') return false;
    if (this.pendingPeers.has(t.peer)) return true;
    if (this.unsure.has(t.peer)) return this.classify(t.peer);
    return false;
  }

  private async refuseQuiet(conversation: string) {
    if (!(await this.quiet(conversation))) return;
    throw new Error(conversation.startsWith('group:') ? 'Accept the invitation to this group first' : ACCEPT_FIRST);
  }

  /** A sync from your other devices may have answered a message request: read the open ones again, a few times. */
  private recheckRequests() {
    if (!this.pendingPeers.size) return;
    this.recheckTimers.forEach(clearTimeout);
    this.recheckTimers = (this.opts.requestRecheckMs ?? [5_000, 30_000]).map((at) => setTimeout(() => void this.recheckPeers(), at));
  }

  private async recheckPeers() {
    const peers = [...this.pendingPeers];
    if (!peers.length || !this.daemon?.rpc?.open) return;
    try {
      const list = (await this.rpc.call<SigContact[]>('listContacts', { recipient: peers, allRecipients: true }, 60_000)) ?? [];
      for (const c of list) {
        const id = lc(c.uuid);
        if (!id || !peers.includes(id)) continue;
        this.recipients.set(id, c);
        this.decide(id, c);
      }
      this.publishRequests();
    } catch (e: any) {
      this.host.log('debug', `could not read the message requests again: ${e?.message ?? e}`);
    }
  }

  /** Every request waiting now, by its native id: `invite:<groupId>`, `message:<peer ACI>`. */
  private requestFacts(): Map<string, P.RequestFact> {
    const out = new Map<string, P.RequestFact>();
    if (!this.account) return out;
    const self = this.account.aci;
    for (const [id, g] of this.invited) {
      const info = this.state.invites.get(id);
      out.set(`invite:${id}`, {
        nativeId: `invite:${id}`,
        kind: 'invite',
        ...(info?.by ? { from: info.by } : {}),
        target: { kind: 'conversation', nativeId: groupConvId(id), ...(g.name ? { name: g.name } : {}), members: (g.members ?? []).length },
        ts: info?.ts ?? Date.now(),
        answers: ANSWERS,
      });
    }
    // Asking to join a group this account admins (groups.ts).
    for (const f of joinRequests(this.state.groups.values(), self, (id) => this.joinSeen.get(id) ?? this.joinSeen.set(id, Date.now()).get(id)!, groupConvId)) out.set(f.nativeId, f);
    for (const peer of this.pendingPeers) {
      out.set(`message:${peer}`, { nativeId: `message:${peer}`, kind: 'message', from: peer, target: { kind: 'conversation', nativeId: dmId(self, peer) }, ts: this.state.heard.get(peer) ?? Date.now(), answers: ANSWERS });
    }
    return out;
  }

  /** An identity fact for someone a request or preview names, from what signal-cli has; never says contact or not. */
  private emitIdentityOf(aci: string) {
    if (aci === this.account?.aci) return;
    const c = this.recipients.get(aci);
    const name = this.names.get(aci);
    const f = (c && contactIdentity(c, { contact: false, avatarUrl: this.avatarOf(aci, c.number) })) || { nativeId: aci, ...(name ? { displayName: name } : {}) };
    this.emitFact({ t: 'identity', identity: f });
  }

  /** What changed since the hub was last told: `request` for new or changed ones, `requestGone` for the rest. */
  private publishRequests() {
    if (this.batching || !this.account) return;
    const now = this.requestFacts();
    for (const [id, f] of now) {
      const j = JSON.stringify(f);
      if (this.told.get(id) === j) continue;
      if (f.from) this.emitIdentityOf(f.from);
      this.told.set(id, j);
      this.host.emit({ t: 'request', request: f });
    }
    for (const id of [...this.told.keys()]) {
      if (now.has(id)) continue;
      this.told.delete(id);
      this.host.emit({ t: 'requestGone', nativeId: id });
    }
  }

  /** The whole list, once a read of contacts and groups has made it: after connecting, and on every hub reconnect. */
  private sendAllRequests() {
    const now = this.requestFacts();
    for (const f of now.values()) if (f.from) this.emitIdentityOf(f.from);
    this.told = new Map([...now].map(([id, f]) => [id, JSON.stringify(f)]));
    this.requestsKnown = true;
    this.host.emit({ t: 'requests', requests: [...now.values()] });
  }

  /** Answer a request: only from the owner's click (the hub's `answer`), never retried. Facts first, then the result. */
  private async answer(request: string, answer: P.RequestAnswer): Promise<P.AddResult> {
    const f = this.requestFacts().get(request);
    if (!f) {
      this.told.delete(request);
      this.host.emit({ t: 'requestGone', nativeId: request });
      throw new Error('That request is not waiting any more');
    }
    if (!f.answers.includes(answer)) throw new Error(`This request cannot be answered with ${answer}`);
    if (f.kind === 'join') return this.answerJoin(request, answer);
    return f.kind === 'invite' ? this.answerInvite(request.slice('invite:'.length), answer) : this.answerMessage(request.slice('message:'.length), answer);
  }

  /**
   * An invitation: accept is updateGroup with the group id alone (signal-cli accepts a pending invitation before any
   * change, and there is none); decline is quitGroup (for an invitation it revokes it); block is quitGroup, then
   * block the group so its invitations no longer reach you.
   */
  private async answerInvite(groupId: string, answer: P.RequestAnswer): Promise<P.AddResult> {
    const conversation = groupConvId(groupId);
    const g = this.invited.get(groupId)!;
    const done = () => {
      this.invited.delete(groupId);
      this.state.invites.delete(groupId);
      this.state.save();
      this.publishRequests();
    };
    if (answer === 'accept') {
      let res: Partial<SigSendResult> | undefined;
      try {
        res = await this.call<Partial<SigSendResult>>('updateGroup', acceptInviteParams(groupId));
      } catch (e) {
        throw signalError(e, 'change groups');
      }
      done();
      const after = await this.readGroup(groupId, undefined, true).catch((e) => {
        this.host.log('debug', `group read after accepting failed: ${e?.message ?? e}`);
        return undefined;
      });
      if (!after) {
        // signal-cli accepted but cannot list it yet: the group as the invitation showed it, with you in it.
        const self = this.self;
        this.applyGroup({ ...g, isMember: true, members: [...(g.members ?? []), { uuid: self, number: this.account!.number }], pendingMembers: (g.pendingMembers ?? []).filter((m) => lc(m.uuid) !== self) });
      } else if (after.isMember === false) {
        return { pending: true, notes: ['Accepted; Signal does not show you in the group yet'] };
      }
      this.systemMessage(conversation, res?.timestamp ?? Date.now(), 'You accepted the invitation to the group.');
      return { conversation };
    }
    try {
      await this.call('quitGroup', { groupId });
    } catch (e) {
      throw signalError(e, 'change groups');
    }
    done();
    if (answer === 'decline') return {};
    try {
      await this.call('block', { groupId: [groupId] });
    } catch (e) {
      return { notes: [`Declined; Signal did not block the group: ${errorText(e)}`] };
    }
    return { notes: ['Declined and blocked: invitations to this group no longer reach you'] };
  }

  /**
   * A message request: accept and decline are sendMessageRequestResponse (accept, delete), which tells your other
   * devices and sets profile sharing; block is block (which tells your other devices too), then delete. Declined or
   * blocked, the conversation goes (`leave`), as Signal's apps delete it; a new message makes a new request.
   */
  private async answerMessage(peer: string, answer: P.RequestAnswer): Promise<P.AddResult> {
    const self = this.self;
    const conversation = dmId(self, peer);
    if (answer === 'accept') {
      try {
        await this.call('sendMessageRequestResponse', { recipient: [peer], type: 'accept' });
      } catch (e) {
        throw signalError(e, 'answer message requests');
      }
      this.state.ours.add(peer);
      this.state.save();
      this.pendingPeers.delete(peer);
      this.emitIdentityOf(peer);
      this.apply(emptyResult({ t: 'conversation', conversation: directConversation(self, peer) }));
      this.publishRequests();
      return { conversation, identity: peer, relationship: 'stranger' };
    }
    const notes: string[] = [];
    try {
      if (answer === 'block') await this.call('block', { recipient: [peer] });
      else await this.call('sendMessageRequestResponse', { recipient: [peer], type: 'delete' });
    } catch (e) {
      throw signalError(e, 'answer message requests');
    }
    if (answer === 'block') {
      try {
        await this.call('sendMessageRequestResponse', { recipient: [peer], type: 'delete' });
      } catch (e) {
        notes.push(`Blocked; Signal did not delete the chat on your other devices: ${errorText(e)}`);
      }
    }
    this.state.heard.delete(peer);
    this.state.dms.delete(peer);
    this.state.unread.delete(conversation);
    this.state.save();
    this.pendingPeers.delete(peer);
    this.facts.delete(`c:${conversation}`); // a new message brings the conversation back
    this.publishRequests();
    this.host.emit({ t: 'leave', kind: 'conversation', nativeId: conversation });
    return { identity: peer, relationship: answer === 'block' ? 'blocked' : 'stranger', ...(notes.length ? { notes } : {}) };
  }

  // ---------------------------------------------------------------- looking up and joining

  /** What a group link or a person is, without acting: local reads, and getUserStatus for people. */
  private async resolve(ref: P.AddRef): Promise<P.AddPreview> {
    if (ref.network !== 'signal') throw new Error('This is a Signal account');
    if (ref.kind === 'invite') return this.resolveLink(ref.code || ref.url, ref.url);
    if (ref.kind === 'person') return this.resolvePerson(ref.handle);
    throw new Error('Signal has no public names or rooms to look up');
  }

  /** A group signal-cli has (you are in it, invited, asked, or were in it), read locally; undefined when it has none. */
  private async knownGroup(groupId: string): Promise<SigGroup | undefined> {
    try {
      const [g] = (await this.rpc.call<SigGroup[]>('listGroups', { groupId: [groupId] }, 30_000)) ?? [];
      return g?.id === groupId ? g : undefined;
    } catch (e: any) {
      this.host.log('debug', `group read failed: ${e?.message ?? e}`);
      return undefined;
    }
  }

  /**
   * A signal.group link. signal-cli has no preview: joinGroup is its only call that reads the link on the server, and
   * it joins. So the link's own group key (add.ts) finds a group signal-cli has already; anything else is partial.
   */
  private async resolveLink(uri: string, url: string): Promise<P.AddPreview> {
    const groupId = groupIdOfLink(uri);
    if (!groupId) throw new Error('This is not a working Signal group link');
    const g = await this.knownGroup(groupId);
    const nativeId = groupConvId(groupId);
    if (g) {
      const name = g.name || url;
      const members = (g.members ?? []).length;
      if (g.isMember !== false) {
        this.applyGroup(g); // its conversation, if the hub has not had it yet
        return { what: 'group', name, nativeId, members, joined: { conversation: nativeId }, actions: [], notes: ['You are in this group already'] };
      }
      if (this.invitedHere(g)) return { what: 'group', name, nativeId, members, actions: [], notes: ['You are invited to this group already: answer the invitation under Requests'] };
      if (this.requestingHere(g)) return { what: 'group', name, nativeId, actions: [], notes: ['You asked to join already; its admins have not answered'] };
      if (g.isBlocked) return { what: 'group', name, nativeId, actions: [], notes: ['You blocked this group on Signal'] };
      return { what: 'group', name, nativeId, actions: ['join'], notes: ['You were in this group before'] };
    }
    return { what: 'group', name: url, partial: true, actions: ['join'], notes: ['Signal shows the group only after you join'] };
  }

  /**
   * A +number, a username (name.12) or a username link (signal.me/#eu/…): getUserStatus says whether there is a
   * Signal account and its ACI. Then what signal-cli has for them (listContacts by ACI). Nothing reaches them.
   */
  private async resolvePerson(handle: string): Promise<P.AddPreview> {
    const self = this.self;
    const phone = handle.startsWith('+');
    const what = phone ? 'number' : handle.startsWith('https://') ? 'username link' : 'username';
    let st: SigUserStatus | undefined;
    try {
      // Not this.call: a lookup's rate limit is the lookup's, said in its error, not the account's status.
      const list = await this.rpc.call<SigUserStatus[]>('getUserStatus', phone ? { recipient: [handle] } : { username: [handle] }, 30_000);
      st = list?.find((s) => s.recipient === handle || s.number === handle || s.username === handle) ?? list?.[0];
    } catch (e) {
      throw lookupError(e, what);
    }
    const aci = lc(st?.uuid);
    if (!st?.isRegistered || !aci || !ACI.test(aci)) throw new Error(`No Signal account has this ${what}`);
    if (phone) this.byNumber.set(handle, aci);
    if (aci === self) return { what: 'person', name: this.selfName ?? handle, nativeId: aci, actions: [], notes: ['This is this account: write to yourself in Note to Self'] };
    const find = async (params: Record<string, unknown>) => ((await this.rpc.call<SigContact[]>('listContacts', { recipient: [aci], ...params }, 30_000)) ?? []).find((c) => lc(c.uuid) === aci);
    let c: SigContact | undefined;
    let inContacts = false;
    try {
      c = await find({});
      inContacts = !!c && !c.isHidden;
      c ??= await find({ allRecipients: true });
    } catch (e: any) {
      this.host.log('debug', `contact read failed: ${e?.message ?? e}`);
    }
    if (c) this.recipients.set(aci, c);
    const avatar = this.avatarOf(aci, c?.number ?? (phone ? handle : undefined));
    const identity: P.IdentityFact = (c && contactIdentity(c, { contact: inContacts, avatarUrl: avatar })) || { nativeId: aci };
    if (phone) identity.handle = handle;
    else if (!identity.handle && what === 'username') identity.handle = `@${handle}`;
    this.emitFact({ t: 'identity', identity });
    const blocked = !!c?.isBlocked;
    return {
      what: 'person',
      name: identity.displayName ?? (what === 'username link' ? (st.username && !st.username.startsWith('https://') ? st.username : 'Signal user') : handle),
      nativeId: aci,
      ...(avatar ? { avatar } : {}),
      relationship: blocked ? 'blocked' : inContacts ? 'contact' : 'stranger',
      actions: blocked ? [] : ['message'],
      ...(blocked ? { notes: ['You blocked them on Signal'] } : {}),
    };
  }

  /** Join by a group link (joinGroup with the URI), or ask to when its admins approve joins. Nothing else to add on Signal. */
  private async add(ref: P.AddRef, action: Exclude<P.AddAction, 'message'>): Promise<P.AddResult> {
    if (ref.network !== 'signal') throw new Error('This is a Signal account');
    if (ref.kind !== 'invite') throw new Error(ref.kind === 'person' ? 'Signal has no friend requests, follows or contact requests: send them a message instead' : 'Signal has nothing to join by that name');
    if (action !== 'join' && action !== 'ask') throw new Error(`Signal cannot ${action} a group: join it instead`);
    return this.joinLink(ref.code || ref.url);
  }

  private async joinLink(uri: string): Promise<P.AddResult> {
    const known = groupIdOfLink(uri);
    if (!known) throw new Error('This is not a working Signal group link');
    const before = await this.knownGroup(known);
    if (before && before.isMember !== false) {
      this.applyGroup(before);
      return { conversation: groupConvId(known), notes: ['You are in this group already'] };
    }
    if (before && this.invitedHere(before)) throw new Error('You are invited to this group already: answer the invitation under Requests');
    if (before && this.requestingHere(before)) return { pending: true, notes: ['You asked to join already; its admins have not answered'] };
    let res: SigJoinResult | undefined;
    try {
      res = await this.call<SigJoinResult>('joinGroup', { uri }, 90_000);
    } catch (e) {
      // A check is never worked around: nothing was done, and the owner does it.
      if (wantsCaptcha(e)) return { check: 'captcha', notes: ['Signal wants a captcha from this device before it joins; nothing was done'] };
      if (/already requested to join/i.test(errorText(e))) return { pending: true, notes: ['You asked to join already; its admins have not answered'] };
      throw joinError(e);
    }
    if (res) this.logPartialFailure('joinGroup', res as SigSendResult);
    if (res?.onlyRequested) return { pending: true, notes: ["Asked to join: the group's admins decide"] };
    const groupId = res?.groupId || known;
    const conversation = groupConvId(groupId);
    const g = await this.readGroup(groupId, undefined, true).catch((e) => {
      this.host.log('debug', `group read after joining failed: ${e?.message ?? e}`);
      return undefined;
    });
    if (!g) {
      this.apply(emptyResult({ t: 'conversation', conversation: { nativeId: conversation, shape: 'group', encrypted: true, participants: [this.self] } }));
    } else if (g.isMember === false) {
      return { pending: true, notes: ["Asked to join: the group's admins decide"] };
    }
    this.systemMessage(conversation, res?.timestamp ?? Date.now(), 'You joined the group via the group link.');
    return { conversation };
  }

  // ---------------------------------------------------------------- about and settings

  private aboutTarget(target: P.AboutTarget) {
    if (target.kind !== 'conversation') throw new Error('Signal has no spaces');
    const t = parseConversation(target.nativeId, this.self);
    if (!t) throw new Error(`not a Signal conversation of this account: ${target.nativeId}`);
    return t;
  }

  /** A group re-read so permissions are fresh (the cached copy if signal-cli cannot answer), or a 1:1. */
  private async about(target: P.AboutTarget): Promise<P.About> {
    const t = this.aboutTarget(target);
    if (t.kind !== 'group') return this.directAbout(t.kind === 'dm' ? t.peer : null);
    const g =
      (await this.readGroup(t.groupId).catch((e) => {
        this.host.log('debug', `group read failed: ${e?.message ?? e}`);
        return undefined;
      })) ?? this.state.groups.get(t.groupId);
    if (!g) throw new Error('Signal does not know this group');
    this.emitMembers(g);
    return this.groupAbout(g);
  }

  /** Identity facts for a group's members, so the About's member list resolves. */
  private emitMembers(g: SigGroup) {
    for (const m of g.members ?? []) {
      const id = lc(m.uuid);
      if (!id || id === this.self) continue;
      const name = this.names.get(id);
      this.emitFact({ t: 'identity', identity: { nativeId: id, ...(m.number ? { handle: m.number } : {}), ...(name ? { displayName: name } : {}) } });
    }
  }

  /** Why this account can change nothing in a group, or null when it can. */
  private notIn(g: SigGroup): string | null {
    if (g.isTerminated) return 'This group has been ended.';
    if (g.isMember !== false) return null;
    const invited = (g.pendingMembers ?? []).some((m) => lc(m.uuid) === this.self);
    return invited ? 'You are invited to this group but have not joined.' : 'You are no longer in this group.';
  }

  /** A group's About, with the wording of Signal's own group settings. */
  private groupAbout(g: SigGroup): P.About {
    const self = this.self;
    const members = (g.members ?? []).filter((m) => m.uuid);
    const admin = members.some((m) => lc(m.uuid) === self && m.isAdmin);
    const out = this.notIn(g);
    const boss = !out && admin;
    const info = !out && (admin || g.permissionEditDetails === 'EVERY_MEMBER');
    const onlyAdmins = out ?? 'Only admins can change this.';
    const lockedInfo = out ?? 'Only admins can edit this group’s details.';
    const who = (p?: string): P.Who | null => (p === 'ONLY_ADMINS' ? 'admins' : p === 'EVERY_MEMBER' ? 'everyone' : null);
    const whoLabel = (p?: string) => (p === 'EVERY_MEMBER' ? 'All members' : 'Only admins');
    const announce = g.permissionSendMessage ? g.permissionSendMessage === 'ONLY_ADMINS' : null;
    const mayAdd = !out && (admin || g.permissionAddMember === 'EVERY_MEMBER');
    const set = <K extends P.AboutKey>(value: P.AboutValues[K] | null, canEdit: boolean, reason: string): P.AboutSetting<K> => ({ value, canEdit, ...(canEdit ? {} : { reason }) });
    const list: P.AboutMember[] = [];
    const seen = new Set<string>();
    for (const m of members) {
      const id = lc(m.uuid)!;
      if (seen.has(id)) continue;
      seen.add(id);
      const label = labelOf(m);
      list.push({ id, role: m.isAdmin ? 'Admin' : 'Member', rank: m.isAdmin ? 100 : 0, ...(label ? { label } : {}) });
    }
    const link = g.groupInviteLink || null;
    const facts: { label: string; value: string }[] = [];
    if (g.pendingMembers?.length) facts.push({ label: 'Invited, not joined yet', value: String(g.pendingMembers.length) });
    if (g.requestingMembers?.length) facts.push({ label: 'Asking to join', value: String(g.requestingMembers.length) });
    const isMember = seen.has(self) && !out;
    return {
      noun: 'Group',
      fields: {
        name: set<'name'>(g.name ?? '', info, lockedInfo),
        topic: set<'topic'>(g.description ?? '', info, lockedInfo),
        avatar: set<'avatar'>(this.groupAvatar(g.id) ?? null, info, lockedInfo),
        disappearing: set<'disappearing'>(g.messageExpirationTime ?? 0, info, lockedInfo),
        announceOnly: set<'announceOnly'>(announce, boss, onlyAdmins),
        editInfo: set<'editInfo'>(who(g.permissionEditDetails), boss, onlyAdmins),
        addMembers: set<'addMembers'>(who(g.permissionAddMember), boss, onlyAdmins),
        // The link is there whether or not approval is on, and listGroups says nothing else about it: it can be set, not read.
        joinApproval: { value: null, canEdit: boss && !!link, writeOnly: true, reason: boss && !link ? 'Turn the group link on first.' : boss ? 'signal-cli does not say whether approval is on now; setting it works.' : onlyAdmins },
        encrypted: set<'encrypted'>(true, false, 'Always on in Signal.'),
      },
      members: { list, complete: true },
      // Anyone signal-cli can name by ACI; someone whose profile it lacks comes in invited (addMembers).
      adding: { can: mayAdd, ...(mayAdd ? {} : { reason: out ?? 'Only admins can add members.' }), who: 'known', mode: 'add' },
      roles: [
        { id: 'admin', name: 'Admin', rank: 100, count: list.filter((m) => m.rank === 100).length },
        { id: 'member', name: 'Member', rank: 0, count: list.filter((m) => m.rank === 0).length },
      ],
      rules: [
        { what: 'Edit name, description and disappearing messages', who: whoLabel(g.permissionEditDetails), you: info },
        { what: 'Add members', who: whoLabel(g.permissionAddMember), you: mayAdd },
        { what: 'Send messages', who: announce ? 'Only admins' : 'All members', you: !out && (admin || !announce) },
        { what: 'Change these settings and the invite link', who: 'Only admins', you: boss },
      ],
      you: isMember ? { role: admin ? 'Admin' : 'Member', rank: admin ? 100 : 0 } : {},
      invite: { link, canCreate: boss, canRevoke: boss && !!link, ...(boss ? {} : { reason: out ?? 'Only admins can change the invite link.' }) },
      // Signal keeps no list this device can read: the hub adds the pins it saw (docs/signal.md "Polls and pins").
      // Whoever may send here may pin, as Signal's apps offer it.
      pinned: { messages: [], canEdit: !out && (admin || !announce), ...(!out && (admin || !announce) ? {} : { reason: out ?? 'Only admins can send messages here.' }) },
      ...(facts.length ? { facts } : {}),
      blocked: !!g.isBlocked,
      moderation: groupModeration(g, self),
      label: ownLabel(g, self),
      leaving: groupLeaving(g, self),
    };
  }

  // ---------------------------------------------------------------- groups admin (groups.ts, docs/moderation.md)

  /** When each join request was first seen, by request id. */
  private joinSeen = new Map<string, number>();

  /** A group re-read, as the About it gives says; refused when signal-cli does not know it. */
  private async freshGroup(target: P.AboutTarget): Promise<SigGroup> {
    const t = this.aboutTarget(target);
    if (t.kind !== 'group') throw new Error('Only groups have members to manage on Signal.');
    const g = await this.readGroup(t.groupId);
    if (!g) throw new Error('Signal does not know this group');
    return g;
  }

  /** A change went out: a fresh read, the line saying what changed, and the About as it now stands. */
  private async afterChange(g: SigGroup, res: Partial<SigSendResult> | undefined, fallback?: string): Promise<P.About> {
    const after = (await this.readGroup(g.id)) ?? g;
    const line = describeGroupChange(g, after, this.self, this.self, this.nameOf);
    this.systemMessage(groupConvId(g.id), res?.timestamp ?? Date.now(), line === 'You updated the group.' && fallback ? fallback : line);
    this.emitMembers(after);
    this.publishRequests();
    return this.groupAbout(after);
  }

  /** Leave a group (quitGroup), naming who becomes admin when you are its only one, and forgetting it here if asked. */
  private async leave(target: P.AboutTarget, admins: string[] | undefined, forget: boolean): Promise<P.LeaveResult> {
    const g = await this.freshGroup(target);
    const params = quitParams(g, this.self, admins, forget);
    try {
      await this.call('quitGroup', params);
    } catch (e) {
      throw signalError(e, 'leave groups');
    }
    // No leave event: as Signal's apps keep a group you left (read-only), the hub keeps its history, and the re-read
    // says you are out (About: "You are no longer in this group"). Forgotten here, signal-cli lists it no more.
    if (forget) {
      this.state.groups.set(g.id, { ...g, isMember: false, members: (g.members ?? []).filter((m) => m.uuid?.toLowerCase() !== this.self) });
      this.applyGroup(this.state.groups.get(g.id)!);
    } else await this.readGroup(g.id).catch(() => undefined);
    this.state.save();
    this.publishRequests();
    return { left: true };
  }

  /** One moderating action (groups.ts moderateParams): updateGroup with one field, or terminateGroup. */
  private async moderate(target: P.AboutTarget, action: P.ModAction): Promise<P.About> {
    const g = await this.freshGroup(target);
    const plan = moderateParams(g, this.self, action);
    if (!plan) return this.groupAbout(g);
    let res: Partial<SigSendResult> | undefined;
    try {
      res = await this.call<Partial<SigSendResult>>(plan.method, plan.method === 'updateGroup' ? updateGroupParams(g.id, plan.params) : plan.params);
    } catch (e) {
      throw signalError(e, 'change groups');
    }
    const who = action.op === 'end' ? '' : this.nameOf(action.who.toLowerCase());
    return this.afterChange(g, res, action.op === 'end' ? 'You ended the group.' : action.op === 'ban' ? `You banned ${who}.` : action.op === 'unban' ? `You unbanned ${who}.` : undefined);
  }

  /** The banned, as listGroups lists them (no request of its own: the About has them too). */
  private async bans(target: P.AboutTarget): Promise<P.BansResult> {
    const g = await this.freshGroup(target);
    const banned = groupModeration(g, this.self).banned ?? [];
    for (const id of banned) this.emitIdentityOf(id);
    return { banned: banned.map((id) => ({ id })) };
  }

  /** Your own member label (updateGroup's memberLabel, then memberLabelEmoji: one field per call). */
  private async setLabel(conversation: string, text: string, emoji: string | undefined): Promise<P.About> {
    const g = await this.freshGroup({ kind: 'conversation', nativeId: conversation });
    const { memberLabelEmoji, ...label } = labelParams(g, this.self, text, emoji);
    try {
      await this.call('updateGroup', updateGroupParams(g.id, label));
      if (memberLabelEmoji !== undefined) await this.call('updateGroup', updateGroupParams(g.id, { memberLabelEmoji }));
    } catch (e) {
      throw signalError(e, 'change groups');
    }
    const after = (await this.readGroup(g.id)) ?? g;
    this.emitMembers(after);
    return this.groupAbout(after);
  }

  /** Someone else's message deleted for everyone, as a group admin may (sendAdminDelete). */
  private async adminDelete(conversation: string, message: string) {
    const t = parseConversation(conversation, this.self);
    const g = t?.kind === 'group' ? ((await this.readGroup(t.groupId).catch(() => undefined)) ?? this.state.groups.get(t.groupId)) : undefined;
    if (!g || g.isMember === false || g.isTerminated || !isAdmin(g, this.self)) throw new Error('Only group admins can delete others’ messages.');
    const m = this.message(message);
    try {
      await this.call('sendAdminDelete', { groupId: [g.id], targetAuthor: m.author, targetTimestamp: m.ts });
    } catch (e) {
      throw signalError(e, 'delete messages');
    }
    this.host.emit({ t: 'delete', conversation, nativeId: message });
    this.purge(message);
    return {};
  }

  /** Someone asking to join a group you admin: accept adds them, decline turns them away (updateGroup). */
  private async answerJoin(request: string, answer: P.RequestAnswer): Promise<P.AddResult> {
    const r = parseJoinRequest(request)!;
    const g = await this.readGroup(r.groupId);
    if (!g) throw new Error('Signal does not know this group');
    const params = answerJoinParams(g, this.self, r.aci, answer);
    let res: Partial<SigSendResult> | undefined;
    try {
      res = await this.call<Partial<SigSendResult>>('updateGroup', updateGroupParams(g.id, params));
    } catch (e) {
      throw signalError(e, 'change groups');
    }
    this.joinSeen.delete(request);
    await this.afterChange(g, res, answer === 'accept' ? `You approved ${this.nameOf(r.aci)}'s request to join.` : `You turned down ${this.nameOf(r.aci)}'s request to join.`);
    return answer === 'accept' ? { conversation: groupConvId(g.id) } : {};
  }

  /** A 1:1 (peer) or Note to Self (null): only the disappearing timer, which either side may set. */
  private async directAbout(peer: string | null): Promise<P.About> {
    const self = this.self;
    const conversation = dmId(self, peer ?? self);
    let timer = this.timers.get(conversation) ?? 0;
    try {
      const list = (await this.rpc.call<SigContact[]>('listContacts', { recipient: [peer ?? self], allRecipients: true }, 30_000)) ?? [];
      const c = list.find((x) => lc(x.uuid) === (peer ?? self));
      if (c?.messageExpirationTime !== undefined) {
        timer = c.messageExpirationTime;
        this.timers.set(conversation, timer);
      }
      if (c && peer) {
        const f = contactIdentity(c, { contact: false, avatarUrl: this.avatarOf(peer, c.number) });
        if (f) this.emitFact({ t: 'identity', identity: f });
        this.noteAbout(c, false);
      }
    } catch (e: any) {
      this.host.log('debug', `contact read failed: ${e?.message ?? e}`);
    }
    return {
      noun: peer ? 'Chat' : 'Note to Self',
      fields: {
        disappearing: { value: timer, canEdit: true },
        encrypted: { value: true, canEdit: false, reason: 'Always on in Signal.' },
      },
      members: { list: peer ? [{ id: self }, { id: peer }] : [{ id: self }], complete: true },
      rules: [{ what: 'Change disappearing messages', who: peer ? 'Either of you' : 'You', you: true }],
      pinned: { messages: [], canEdit: true },
    };
  }

  /** One change, then a fresh read. Refuses what the About says this account may not do. */
  private async configure(target: P.AboutTarget, change: P.AboutChange): Promise<P.About> {
    const self = this.self;
    const t = this.aboutTarget(target);
    if (change.key === 'pin') {
      if (t.kind === 'group') {
        const g = await this.readGroup(t.groupId);
        if (!g) throw new Error('Signal does not know this group');
        const p = this.groupAbout(g).pinned!;
        if (!p.canEdit) throw new Error(p.reason ?? 'You cannot pin messages here.');
      }
      await this.pin(target.nativeId, change);
      return this.about(target);
    }
    if (t.kind !== 'group') {
      if (change.key !== 'disappearing') throw new Error(`Signal chats have no ${change.key} setting to change`);
      const seconds = timerValue(change.value);
      const peer = t.kind === 'dm' ? t.peer : self;
      await this.refuseQuiet(target.nativeId); // the timer goes to them as a message
      // Note to Self is the contact entry for your own ACI; signal-cli sends the update to your other devices.
      await this.call('updateContact', { recipient: peer, expiration: seconds });
      if (t.kind === 'dm') this.apply(emptyResult({ t: 'conversation', conversation: directConversation(self, peer) }));
      this.timers.set(dmId(self, peer), seconds);
      this.systemMessage(target.nativeId, Date.now(), seconds ? `You set disappearing messages to ${describeTimer(seconds)}.` : 'You turned off disappearing messages.');
      return this.directAbout(t.kind === 'dm' ? peer : null);
    }
    const g = await this.readGroup(t.groupId);
    if (!g) throw new Error('Signal does not know this group');
    // An updateGroup on a group you are only invited to accepts the invitation.
    const out = this.notIn(g);
    if (out) throw new Error(out);
    const params = groupChange(g, this.groupAbout(g), change);
    if (params) {
      const res = await this.call<Partial<SigSendResult>>('updateGroup', updateGroupParams(t.groupId, params));
      const after = (await this.readGroup(t.groupId)) ?? g;
      this.systemMessage(target.nativeId, res?.timestamp ?? Date.now(), describeGroupChange(g, after, self, self, this.nameOf));
      this.emitMembers(after);
      return this.groupAbout(after);
    }
    this.emitMembers(g);
    return this.groupAbout(g);
  }

  /**
   * Add people to a group: one updateGroup with the group id and their ACIs (signal-cli's --member), after a fresh
   * read says this account may. Signal adds someone whose profile key this device lacks as invited: they are in once
   * they accept. One call carries them all, so Signal takes or refuses them together; anyone it left out is failed.
   * People in it already, or invited already, are not sent again.
   */
  private async addMembers(target: P.AboutTarget, people: string[]): Promise<P.AddMembersResult> {
    const self = this.self;
    const t = this.aboutTarget(target);
    if (t.kind !== 'group') throw new Error('Signal adds people to groups only.');
    if (!Array.isArray(people)) throw new Error('Nobody to add.');
    const ids = [...new Set(people.map((p) => String(p).toLowerCase()))];
    if (!ids.length) throw new Error('Nobody to add.');
    if (ids.length > ADD_MEMBERS_MAX) throw new Error(`At most ${ADD_MEMBERS_MAX} people at a time.`);
    const g = await this.readGroup(t.groupId);
    if (!g) throw new Error('Signal does not know this group');
    // An updateGroup on a group you are only invited to accepts the invitation: refused here with the rest.
    const adding = this.groupAbout(g).adding!;
    if (!adding.can) throw new Error(adding.reason ?? 'Only admins can add members.');
    const was = memberIds(g);
    const pending = pendingIds(g);
    const send = ids.filter((id) => ACI.test(id) && !was.has(id) && !pending.has(id));
    let after = g;
    let sentAt: number | undefined;
    if (send.length) {
      let res: Partial<SigSendResult> | undefined;
      try {
        res = await this.call<Partial<SigSendResult>>('updateGroup', updateGroupParams(t.groupId, { member: send }));
      } catch (e) {
        throw signalError(e, 'change groups');
      }
      if (res) this.logPartialFailure('updateGroup', res as SigSendResult);
      sentAt = res?.timestamp ?? Date.now();
      // Members' identities, then the conversation with its new participants.
      const read = await this.readGroup(t.groupId, undefined, true).catch((e) => {
        this.host.log('debug', `group read after adding failed: ${e?.message ?? e}`);
        return undefined;
      });
      if (read) after = read;
      else {
        // signal-cli took the change but cannot list the group yet: the group as it was, with them in it.
        after = { ...g, members: [...(g.members ?? []), ...send.map((uuid) => ({ uuid, isAdmin: false }))] };
        this.emitMembers(after);
        this.applyGroup(after);
        this.state.save();
      }
    } else this.emitMembers(g);
    const inNow = memberIds(after);
    const pendingNow = pendingIds(after);
    if (sentAt !== undefined) {
      for (const id of send) if (pendingNow.has(id) && !inNow.has(id)) this.emitIdentityOf(id);
      if (send.some((id) => inNow.has(id) || pendingNow.has(id))) this.systemMessage(target.nativeId, sentAt, describeGroupChange(g, after, self, self, this.nameOf));
    }
    const added: string[] = [];
    const invited: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (!ACI.test(id)) failed.push({ id, reason: 'This is not a Signal person id.' });
      else if (inNow.has(id)) added.push(id);
      else if (pendingNow.has(id)) invited.push(id);
      else failed.push({ id, reason: 'Signal did not add them.' });
    }
    return { added, ...(invited.length ? { invited } : {}), ...(failed.length ? { failed } : {}), about: this.groupAbout(after) };
  }

  /**
   * Make a new group: one updateGroup with a name and members and no group id, which is how signal-cli makes a group
   * (createGroupParams; changes to a group never go out that way, updateGroupParams). Never sent twice: a timeout is an
   * error, and the group may still have been made.
   *
   * As signal-cli 0.14.8 does it (UpdateGroupCommand, GroupHelper.createGroup, GroupV2Helper.buildNewGroup): members
   * by ACI are never looked up, so nobody is refused for not being on Signal; someone whose profile key credential it
   * has (or can fetch) is a member, anyone else invited (membersPendingProfileKey); the answer carries `groupId`
   * (base64, as listGroups writes it) and `results`, one per person told of the group by a group update message. A
   * failure to make it says nothing of why (Signal's "Failed to create group", reason only in signal-cli's log).
   */
  private async createGroup(name: string | undefined, people: string[]): Promise<P.CreateGroupResult> {
    const self = this.self;
    if (!Array.isArray(people)) throw new Error('Nobody to put in the group.');
    const ids = [...new Set(people.map((p) => String(p).toLowerCase()))].filter((id) => id !== self);
    const title = typeof name === 'string' ? name.trim() : '';
    const problem = createGroupProblem('signal', title || undefined, ids.length);
    if (problem) throw new Error(problem);
    const send = ids.filter((id) => ACI.test(id));
    if (!send.length) throw new Error('None of them is a Signal person id.');
    // Identities first, so the hub knows everyone the new group's fact names.
    for (const id of send) this.emitIdentityOf(id);
    let res: Partial<SigJoinResult> | undefined;
    try {
      res = await this.call<Partial<SigJoinResult>>('updateGroup', createGroupParams(title, send));
    } catch (e) {
      throw createGroupError(e);
    }
    if (res) this.logPartialFailure('updateGroup', res as SigSendResult);
    const groupId = typeof res?.groupId === 'string' && res.groupId ? res.groupId : null;
    if (!groupId) throw new Error('Signal made the group but did not say which it is: it shows up here once Signal syncs it.');
    const conversation = groupConvId(groupId);
    const notes: string[] = [];
    const g = await this.readGroup(groupId, undefined, true).catch((e) => {
      this.host.log('debug', `group read after making it failed: ${e?.message ?? e}`);
      return undefined;
    });
    if (!g) {
      // signal-cli made it but cannot list it yet: the group as asked for, with you in it.
      this.apply(emptyResult({ t: 'conversation', conversation: { nativeId: conversation, shape: 'group', encrypted: true, name: title, participants: [self, ...send] } }));
      notes.push('Signal has not listed the new group yet: who is in it shows once it does');
    }
    this.systemMessage(conversation, res?.timestamp ?? Date.now(), 'You created the group.');
    const inNow = g ? memberIds(g) : new Set(send);
    const pendingNow = g ? pendingIds(g) : new Set<string>();
    const added: string[] = [];
    const invited: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const told = untold(res?.results);
    for (const id of ids) {
      if (!ACI.test(id)) failed.push({ id, reason: 'This is not a Signal person id.' });
      // In the group on Signal's servers, but their account is gone: nobody will ever answer for them.
      else if (told.get(id) === 'UNREGISTERED_FAILURE') failed.push({ id, reason: 'They are not on Signal any more.' });
      else if (inNow.has(id)) added.push(id);
      else if (pendingNow.has(id)) invited.push(id);
      else failed.push({ id, reason: 'Signal did not add them.' });
    }
    notes.push(...untoldNotes(told, this.nameOf));
    return { conversation, added, ...(invited.length ? { invited } : {}), ...(failed.length ? { failed } : {}), ...(notes.length ? { notes } : {}) };
  }

  // ---------------------------------------------------------------- profiles

  /**
   * What signal-cli already knows about someone, read from its own store: listContacts by ACI never looks anyone
   * up (a number or username would), though it does fetch that person's profile again. Contacts first, then everyone
   * it knows, so the second read says "not a contact".
   */
  private async profile(who: string): Promise<P.PersonAbout> {
    if (!ACI.test(who)) throw new Error('not a Signal person id');
    const id = who.toLowerCase();
    if (id === this.self) return this.selfProfile();
    const find = async (params: Record<string, unknown>) => ((await this.rpc.call<SigContact[]>('listContacts', { recipient: [id], ...params }, 30_000)) ?? []).find((c) => lc(c.uuid) === id);
    try {
      let c = await find({});
      const inContacts = !!c;
      c ??= await find({ allRecipients: true });
      if (!c) return {};
      const avatarUrl = this.avatarOf(id, c.number);
      const f = contactIdentity(c, { contact: inContacts, avatarUrl });
      if (f) this.emitFact({ t: 'identity', identity: f });
      this.noteAbout(c, inContacts);
      const p = personAbout(c, { inContacts, avatarUrl });
      const safety = await this.safetyWith(id);
      if (safety) p.safety = safety;
      return p;
    } catch (e: any) {
      this.host.log('debug', `profile read failed: ${e?.message ?? e}`);
      return {};
    }
  }

  /**
   * Your own profile, as signal-cli's updateProfile sets it: only the fields given (`about`, `aboutEmoji`, a name as
   * Signal's given and family names, a picture or none), so the rest stay. A username goes by updateAccount, whose
   * answer is the only place its link shows (e8): it is kept. Then your profile as signal-cli now has it.
   */
  private async setProfile(change: P.ProfileChange): Promise<P.PersonAbout> {
    const params: Record<string, unknown> = {};
    if (!change || !['bio', 'name', 'emoji', 'avatar', 'username'].some((k) => (change as Record<string, unknown>)[k] !== undefined)) throw new Error('nothing to change');
    if (change.bio !== undefined) params.about = checkAbout(change.bio);
    if (change.emoji !== undefined) {
      if (typeof change.emoji !== 'string' || [...change.emoji.trim()].length > 8) throw new Error('One emoji, or none');
      params.aboutEmoji = change.emoji.trim();
    }
    if (change.name !== undefined) {
      if (typeof change.name !== 'string' || !change.name.trim()) throw new Error('Signal needs a name');
      if ([...change.name.trim()].length > 52) throw new Error('A Signal name takes 52 characters at most');
      const self = this.self;
      const me = ((await this.rpc.call<SigContact[]>('listContacts', { recipient: [self], allRecipients: true }, 30_000)) ?? []).find((c) => lc(c.uuid) === self);
      const { given, family } = splitName(change.name, { given: me?.profile?.givenName, family: me?.profile?.familyName });
      params.givenName = given;
      params.familyName = family;
    }
    if (change.avatar === null) params.removeAvatar = true;
    else if (change.avatar !== undefined) {
      if (!change.avatar?.path || !/^image\/(jpeg|png|webp|gif)$/.test(change.avatar.mime)) throw new Error('A picture: JPEG, PNG, WebP or GIF');
      params.avatar = change.avatar.path;
    }
    if (Object.keys(params).length) await this.call('updateProfile', params, 60_000);
    if (change.username !== undefined) await this.setUsername(change.username);
    // The About just set, if signal-cli's read is behind it ('' cleared it).
    const now = await this.selfProfile();
    if (typeof params.about === 'string') {
      const about = params.about.trim();
      if (about) now.bio = about;
      else delete now.bio;
    }
    return now;
  }

  /** Set (updateAccount username: Signal adds the number) or delete your username; its link is kept from the answer. */
  private async setUsername(name: string | null) {
    if (name === null) {
      await this.call('updateAccount', { deleteUsername: true }, 60_000);
      this.state.username = null;
    } else {
      const r = await this.call<{ username?: string | null; usernameLink?: string | null }>('updateAccount', { username: cleanUsername(name) }, 60_000);
      const u = usernameOf(r);
      if (!u) throw new Error('Signal did not say which username it gave you');
      this.state.username = u;
    }
    this.state.save();
  }

  /** Your own profile, and your contacts as `friends`: not blocked, with a name. */
  private async selfProfile(): Promise<P.PersonAbout> {
    const self = this.self;
    const number = this.account!.number;
    const read = async (params: Record<string, unknown>, timeoutMs: number) => {
      try {
        return (await this.rpc.call<SigContact[]>('listContacts', params, timeoutMs)) ?? [];
      } catch (e: any) {
        this.host.log('debug', `profile read failed: ${e?.message ?? e}`);
        return null;
      }
    };
    const me = (await read({ recipient: [self], allRecipients: true }, 30_000))?.find((c) => lc(c.uuid) === self);
    const contacts = await read({}, 120_000);
    const avatarUrl = this.avatarOf(self, number);
    const p: P.PersonAbout = me ? personAbout(me) : {};
    const name = p.displayName ?? this.selfName;
    if (name) p.displayName = this.selfName = name;
    if (avatarUrl) p.avatar = avatarUrl;
    p.handle = number;
    p.links = [{ label: 'Phone', value: number, url: `tel:${number}` }];
    // Your username: signal-cli lists it, but its link only as updateAccount last answered (e8).
    const uname = me?.username || this.state.username?.name;
    if (uname) {
      const link = this.state.username?.name === uname ? this.state.username.link : undefined;
      p.username = { name: uname, ...(link ? { link } : {}) };
      p.links.push({ label: 'Username', value: uname, ...(link ? { url: link } : {}) });
    }
    p.editable = ['bio', 'name', 'emoji', 'avatar', 'username'];
    if (contacts) {
      const friends = new Set<string>();
      for (const c of contacts) {
        const id = lc(c.uuid);
        if (!id || id === self || c.isBlocked || c.isHidden || c.unregistered || !displayNameOf(c)) continue;
        const f = contactIdentity(c, { contact: true, avatarUrl: this.avatarOf(id, c.number) });
        if (f) this.emitFact({ t: 'identity', identity: f });
        this.noteAbout(c, true);
        friends.add(id);
      }
      p.friends = [...friends];
    }
    this.emitFact({ t: 'identity', identity: { nativeId: self, handle: number, ...(name ? { displayName: name } : {}), ...(avatarUrl ? { avatarUrl } : {}), isSelf: true } });
    return p;
  }

  /**
   * Someone's About and its emoji as signal-cli last fetched them, and a customStatus when they differ from what was
   * last seen. Signal pushes no profile changes: signal-cli fetches a profile when listContacts names someone, or lists
   * everyone and theirs is over 6 hours old (or their profile key changed), so this runs wherever the adapter already
   * reads contacts. Only contacts and people with a 1:1, not every group member; never yourself.
   */
  private noteAbout(c: SigContact, inContacts: boolean) {
    const id = lc(c.uuid);
    const p = c.profile;
    // Never fetched (or no profile at all): nothing known, which is not the same as nothing set.
    if (!id || id === this.self || !p?.lastUpdateTimestamp) return;
    if (c.isBlocked || !(inContacts || this.state.dms.has(id))) return;
    const text = p.about?.trim() || undefined;
    const emoji = p.aboutEmoji?.trim() || undefined;
    const prev = this.state.abouts.get(id);
    if (prev && prev.t === text && prev.e === emoji) return;
    this.state.abouts.set(id, { ...(text ? { t: text } : {}), ...(emoji ? { e: emoji } : {}) });
    this.state.save();
    if (!prev && !text && !emoji) return; // first seen, and nothing set
    this.host.emit({ t: 'customStatus', who: id, ...(text ? { text } : {}), ...(emoji ? { emoji } : {}), ts: p.lastUpdateTimestamp });
  }

  // ---------------------------------------------------------------- people and this device (people.ts)

  /**
   * Once the daemon is up: signal-cli's version for the account page, a sync request when this device was just linked
   * or was away long (once, paced), and the linked devices.
   */
  private async afterReady() {
    try {
      const v = await this.rpc.call<{ version?: string }>('version', undefined, 10_000);
      if (typeof v?.version === 'string') this.cliVersion = v.version;
    } catch (e: any) {
      this.host.log('debug', `version: ${e?.message ?? e}`);
    }
    const now = Date.now();
    const away = this.state.seenAt > 0 && now - this.state.seenAt > (this.opts.syncAfterOutageMs ?? 24 * 3_600_000);
    if ((this.syncOnReady || away) && now - this.state.syncedAt > 3_600_000) {
      this.syncOnReady = false;
      this.state.syncedAt = now;
      this.state.save();
      this.host.log('info', `asking your phone for contacts, groups and settings (${away ? 'after a long outage' : 'just linked'})`);
      await this.call('sendSyncRequest', {}).catch((e) => this.host.log('warn', `sendSyncRequest failed: ${e?.message ?? e}`));
      this.scheduleSnapshot(30_000);
    }
    await this.readDevices();
    this.refreshStatus();
  }

  /** The last status again, with fresh layers and details. */
  private refreshStatus() {
    const l = this.lastStatus;
    if (l) this.setStatus(l.status, l.attention ?? null, l.self);
  }

  /** Facts for the account's page (status.details): signal-cli's version, this device, the account's devices. */
  private details(): Record<string, string | number | boolean | null> | undefined {
    const d: Record<string, string | number | boolean | null> = {};
    if (this.cliVersion) d['signal-cli'] = this.cliVersion;
    const id = this.account ? this.thisDeviceId() : null;
    const me = id ? this.devices?.find((x) => x.id === id) : undefined;
    if (this.account) d['this device'] = `${me?.name ?? String(this.host.config.deviceName ?? 'dither-chat')}${id ? ` (#${id})` : ''}`;
    if (this.devices?.length) d['linked devices'] = devicesDetail(this.devices, id);
    if (this.state.username?.name) d.username = this.state.username.name;
    return Object.keys(d).length ? d : undefined;
  }

  /** This device's number on the account, from signal-cli's account file (data/<path>: deviceId). */
  private thisDeviceId(): number | null {
    try {
      const acc = (JSON.parse(readFileSync(join(this.signalDir, 'data', 'accounts.json'), 'utf8')).accounts ?? []).find((a: any) => lc(a?.uuid) === this.account?.aci);
      if (!acc?.path || /[/\\]/.test(String(acc.path))) return null;
      const id = JSON.parse(readFileSync(join(this.signalDir, 'data', String(acc.path)), 'utf8'))?.deviceId;
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
    }
  }

  /** The account's devices (listDevices asks Signal's servers): at most every devicesEveryMs, unless forced. */
  private async readDevices(force = false) {
    if (!this.daemon?.rpc?.open) return;
    if (!force && this.devices && Date.now() - this.devicesAt < 60_000) return;
    this.devicesAt = Date.now();
    try {
      const list = await this.rpc.call<SigDevice[]>('listDevices', {}, 30_000);
      if (Array.isArray(list)) this.devices = list.filter((d) => typeof d?.id === 'number');
      this.refreshStatus();
    } catch (e: any) {
      this.host.log('debug', `listDevices: ${e?.message ?? e}`);
    }
  }

  /** Rename this device as your phone lists it (updateAccount deviceName). */
  private async renameDevice(name: unknown) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A device needs a name');
    if ([...name.trim()].length > 50) throw new Error('A device name takes 50 characters at most');
    await this.call('updateAccount', { deviceName: name.trim() }, 30_000);
    await this.readDevices(true);
    return { ok: true, name: name.trim() };
  }

  /**
   * Everyone's identity keys (listIdentities, local): a key that is not the one last seen means their safety number
   * changed. That is a system line in your 1:1 with them, if you have one, as Signal's apps show it. signal-cli runs
   * with --trust-new-identities always (docs/signal.md), so the new key is trusted, unverified.
   */
  private async readKeys() {
    if (!this.daemon?.rpc?.open || !this.account) return;
    let rows: SigIdentity[];
    try {
      rows = (await this.rpc.call<SigIdentity[]>('listIdentities', {}, 60_000)) ?? [];
    } catch (e: any) {
      this.host.log('debug', `listIdentities: ${e?.message ?? e}`);
      return;
    }
    const self = this.account.aci;
    const { changed, keys } = keyChanges(this.state.keys, rows.filter((r) => lc(r.uuid) !== self));
    this.state.keys = keys;
    this.state.save();
    for (const { aci, at } of changed) {
      this.host.log('info', 'a safety number changed', { aci });
      if (this.state.dms.has(aci)) this.systemMessage(dmId(self, aci), at, `Your safety number with ${this.nameOf(aci)} has changed.`);
    }
  }

  /** Your safety number with someone, as signal-cli has it now; undefined when it has no key for them. */
  private async safetyWith(aci: string): Promise<P.SafetyNumber | undefined> {
    try {
      const rows = (await this.rpc.call<SigIdentity[]>('listIdentities', {}, 30_000)) ?? [];
      const row = rows.find((r) => lc(r.uuid) === aci);
      return row ? safetyOf(row, this.state.keys.get(aci)) : undefined;
    } catch (e: any) {
      this.host.log('debug', `listIdentities: ${e?.message ?? e}`);
      return undefined;
    }
  }

  /**
   * Mark your safety number with someone verified (trust verifiedSafetyNumber), only if it is still the one the
   * owner compared; or clear the mark (trust trustAllKnownKeys: trusted, unverified). Then their profile.
   */
  private async verify(who: string, safetyNumber: string | undefined, clear: boolean): Promise<P.PersonAbout> {
    if (!ACI.test(who)) throw new Error('not a Signal person id');
    const aci = who.toLowerCase();
    if (aci === this.self) throw new Error('That is this account');
    const now = await this.safetyWith(aci);
    if (!now) throw new Error('Signal has no safety number with them yet: write to each other first');
    if (clear) {
      await this.call('trust', { recipient: aci, trustAllKnownKeys: true }, 30_000);
    } else {
      const digits = cleanSafetyNumber(safetyNumber);
      if (digits !== now.digits) throw new Error('Their safety number changed since: look again');
      await this.call('trust', { recipient: aci, verifiedSafetyNumber: digits }, 30_000);
    }
    if (this.state.dms.has(aci)) {
      const name = this.nameOf(aci);
      this.systemMessage(dmId(this.self, aci), Date.now(), clear ? `You cleared the verification of your safety number with ${name}.` : `You marked your safety number with ${name} verified.`);
    }
    return this.profile(aci);
  }

  /**
   * Your contacts and the people you blocked, as the account's list (capability 'relationships'): the whole list once
   * per connection, then what changed. A block on the phone arrives as a sync that makes the next read.
   */
  private publishLinks(all: Map<string, SigContact>, contactIds: Set<string>) {
    const self = this.account?.aci;
    const now = new Map<string, P.RelationshipFact['relationship']>();
    for (const [id, c] of all) {
      if (id === self) continue;
      if (c.isBlocked) now.set(id, 'blocked');
      else if (contactIds.has(id) && !c.isHidden) now.set(id, 'contact');
    }
    for (const id of now.keys()) if (!this.facts.has(`i:${id}`)) this.emitIdentityOf(id);
    if (!this.linksKnown) {
      this.links = now;
      this.linksKnown = true;
      this.host.emit({ t: 'relationships', list: [...now].map(([identity, relationship]) => ({ identity, relationship })) });
      return;
    }
    for (const [id, rel] of now) if (this.links.get(id) !== rel) this.host.emit({ t: 'relationship', fact: { identity: id, relationship: rel } });
    for (const id of this.links.keys()) if (!now.has(id)) this.host.emit({ t: 'relationship', fact: { identity: id, relationship: 'stranger' } });
    this.links = now;
  }

  /** One person read again (listContacts by ACI): their facts, About and how you stand. */
  private async readPerson(aci: string): Promise<SigContact | undefined> {
    const both = async (params: Record<string, unknown>) => ((await this.rpc.call<SigContact[]>('listContacts', { recipient: [aci], ...params }, 30_000)) ?? []).find((c) => lc(c.uuid) === aci);
    const contact = await both({});
    const c = contact ?? (await both({ allRecipients: true }));
    if (!c) return undefined;
    this.recipients.set(aci, c);
    const inContacts = !!contact && !c.isHidden;
    const f = contactIdentity(c, { contact: inContacts, avatarUrl: this.avatarOf(aci, c.number) });
    if (f) this.emitFact({ t: 'identity', identity: f });
    this.noteAbout(c, inContacts);
    const rel: P.RelationshipFact['relationship'] = c.isBlocked ? 'blocked' : inContacts ? 'contact' : 'stranger';
    if (this.linksKnown && (this.links.get(aci) ?? 'stranger') !== rel) {
      if (rel === 'stranger') this.links.delete(aci);
      else this.links.set(aci, rel);
      this.host.emit({ t: 'relationship', fact: { identity: aci, relationship: rel } });
    }
    return c;
  }

  /** After a profile key update: read them again, once in ten minutes at most. Only people you have a 1:1 with or as contacts. */
  private async rereadPerson(aci: string) {
    const at = this.reread.get(aci) ?? 0;
    if (Date.now() - at < 600_000 || !(this.state.dms.has(aci) || this.links.has(aci))) return;
    this.reread.set(aci, Date.now());
    if (this.reread.size > 500) this.reread.delete(this.reread.keys().next().value!);
    await this.readPerson(aci).catch((e) => this.host.log('debug', `re-read after a profile key update failed: ${e?.message ?? e}`));
  }

  /** Block or unblock a person or a group (block / unblock), on the owner's click. Then a fresh read. */
  private async block(target: { kind: 'identity' | 'conversation'; nativeId: string }, unblock: boolean): Promise<{ blocked: boolean }> {
    const method = unblock ? 'unblock' : 'block';
    if (target?.kind === 'identity') {
      if (!ACI.test(target.nativeId)) throw new Error('not a Signal person id');
      const aci = target.nativeId.toLowerCase();
      if (aci === this.self) throw new Error('That is this account');
      try {
        await this.call(method, { recipient: [aci] }, 30_000);
      } catch (e) {
        throw signalError(e, `${method} people`);
      }
      const c = await this.readPerson(aci).catch(() => undefined);
      return { blocked: c ? !!c.isBlocked : !unblock };
    }
    const t = this.aboutTarget(target as P.AboutTarget);
    if (t.kind !== 'group') throw new Error('On Signal you block the person, not the chat');
    try {
      await this.call(method, { groupId: [t.groupId] }, 30_000);
    } catch (e) {
      throw signalError(e, `${method} groups`);
    }
    const g = await this.readGroup(t.groupId).catch(() => undefined);
    return { blocked: g ? !!g.isBlocked : !unblock };
  }

  /**
   * `remove` (capability 'disconnect'): unblock someone you blocked, or take a contact off your contacts (removeContact
   * hide, as Signal's "Remove" does: the chat and its messages stay). Only while it is still so.
   */
  private async remove(identity: string, relationship: P.PersonRelationship): Promise<P.AddResult> {
    if (!ACI.test(identity)) throw new Error('not a Signal person id');
    const aci = identity.toLowerCase();
    const c = await this.readPerson(aci);
    const now = this.links.get(aci) ?? (c?.isBlocked ? 'blocked' : 'stranger');
    if (now !== relationship) throw new Error('That changed; look again');
    try {
      if (relationship === 'blocked') await this.call('unblock', { recipient: [aci] }, 30_000);
      else if (relationship === 'contact') await this.call('removeContact', { recipient: aci, hide: true }, 30_000);
      else throw new Error(`Signal has no ${relationship} to end`);
    } catch (e) {
      throw signalError(e, relationship === 'blocked' ? 'unblock people' : 'remove contacts');
    }
    const after = await this.readPerson(aci).catch(() => undefined);
    const rel = after?.isBlocked ? 'blocked' : (this.links.get(aci) ?? 'stranger');
    return { identity: aci, relationship: rel };
  }

  /**
   * Your nickname or note for someone, kept on Signal too (updateContact: only the fields given; your phone gets them
   * by storage sync). Then their identity fact as Signal now has it.
   */
  private async setContact(who: string, change: { nickname?: string; note?: string }) {
    if (!ACI.test(who)) throw new Error('not a Signal person id');
    const aci = who.toLowerCase();
    if (aci === this.self) throw new Error('That is this account');
    const c = (await this.readPerson(aci)) ?? this.recipients.get(aci);
    if (!c) throw new Error('Signal does not know them yet');
    const params = contactChange(c, change);
    if (!params) return {};
    await this.call('updateContact', { recipient: aci, ...params }, 30_000);
    await this.readPerson(aci).catch(() => undefined);
    return {};
  }

  /**
   * Signal wants a captcha before this device sends more (a rate-limit challenge). A check card: the owner solves it
   * at signalcaptchas.org in their own browser and pastes the link, then submitCaptcha. Nothing solves it here.
   */
  private wantCaptcha(challenge: string) {
    this.challenge = challenge;
    this.setStatus('attention', {
      kind: 'captcha',
      message: 'Signal wants a captcha before this device sends more. Solve it in your browser, then paste the link "Open Signal" points at.',
      detail: { captcha: { url: CAPTCHA_URL, action: 'submitCaptcha' } satisfies P.CaptchaCheck },
    });
  }

  private async submitCaptcha(captcha: unknown) {
    const challenge = this.challenge;
    if (!challenge) throw new Error('Signal is not asking for a captcha now');
    const token = cleanCaptcha(captcha);
    try {
      await this.rpc.call('submitRateLimitChallenge', { challenge, captcha: token }, 60_000);
    } catch (e) {
      throw new Error(/rejected/i.test(errorText(e)) ? 'Signal did not take that captcha: it may be used already or old. Solve a new one.' : `Signal did not take it: ${errorText(e)}`);
    }
    this.challenge = null;
    if (this.lastStatus?.attention?.kind === 'captcha') this.setStatus('online', null);
    return { ok: true };
  }

  /** What Signal's own clients show for a change you made. Nothing comes back to this device for it. */
  private systemMessage(conversation: string, ts: number, body: string) {
    const nativeId = msgId(this.self, ts);
    this.host.emit({ t: 'message', live: true, message: { nativeId, conversation, author: this.self, ts, kind: 'system', body } });
    this.state.remember(nativeId, conversation, body);
  }

  private async action(action: string, args: any): Promise<unknown> {
    switch (action) {
      case 'relink':
        await this.relink();
        return { ok: true };
      case 'startLink':
      case 'refreshLink':
        if (this.phase === 'linking' && this.link) {
          this.link.refresh();
          return { ok: true };
        }
        if (!this.account) {
          this.startLink();
          return { ok: true };
        }
        throw new Error('already linked; use "relink" to link this account again');
      case 'resync':
        if (!this.daemon?.rpc?.open) throw new Error(this.account ? 'signal-cli is not connected yet' : 'Signal is not linked yet');
        // Ask the phone for contacts, groups and settings again, then re-read what signal-cli has.
        await this.call('sendSyncRequest', {}).catch((e) => this.host.log('warn', `sendSyncRequest failed: ${e?.message ?? e}`));
        await this.snapshot();
        this.scheduleSnapshot(30_000);
        return { ok: true };
      case 'typing':
        return this.sendTyping(String(args?.conversation ?? ''), !!args?.stop);
      case 'submitCaptcha':
        return this.submitCaptcha(args?.captcha);
      case 'renameDevice':
        return this.renameDevice(args?.name);
      case STORIES_ACTION: {
        // Off unless the owner turns it on; the daemon reads it when it next starts (docs/signal.md "Stories").
        if (typeof args?.on === 'boolean' && args.on !== this.state.stories) {
          this.state.stories = args.on;
          this.state.flush();
          this.host.log('info', `stories turned ${args.on ? 'on' : 'off'}; signal-cli picks it up when it next starts`);
        }
        return { on: this.state.stories, running: this.storiesRunning && !!this.daemon } satisfies P.StoriesSetting;
      }
      case 'devices':
        await this.readDevices(true);
        return { devices: this.devices ?? [], thisDevice: this.thisDeviceId() };
      case 'status':
        return {
          phase: this.phase,
          linked: !!this.account,
          number: this.account?.number ?? null,
          aci: this.account?.aci ?? null,
          connected: !!this.daemon?.rpc?.open,
          restarts: this.restarts,
          linkUri: this.link?.currentUri ? 'present' : null,
        };
      default:
        throw new Error(`unknown action "${action}" (relink, startLink, resync, typing, submitCaptcha, renameDevice, devices, status, stories)`);
    }
  }

  /**
   * Forget this device's Signal identity entirely and link again. signal-cli 0.14.8 cannot take a linked device off
   * the account (removeDevice is primary-only; unregister on a linked device only marks it unregistered here), so the
   * phone keeps listing this one until removed there or until Signal ages it out. Before wiping, it is renamed (best
   * effort) so the phone's list says which entry is old, and the link screen says to remove it.
   */
  private async relink() {
    if (this.daemon?.rpc?.open && this.account) {
      try {
        const id = this.thisDeviceId();
        const name = `${String(this.host.config.deviceName ?? 'dither-chat')} (old)`.slice(0, 50);
        await this.rpc.call('updateAccount', { deviceName: name }, 20_000);
        this.staleDevice = `“${name}”${id ? ` (#${id})` : ''}`;
      } catch (e: any) {
        this.host.log('debug', `relink: could not rename the old device: ${e?.message ?? e}`);
        const id = this.thisDeviceId();
        this.staleDevice = `“${String(this.host.config.deviceName ?? 'dither-chat')}”${id ? ` (#${id})` : ''}`;
      }
    }
    this.host.log('info', 'relink: wiping signal-cli data');
    this.phase = 'relinking';
    clearTimeout(this.restartTimer);
    this.stopSnapshots();
    await this.link?.stop();
    this.link = null;
    await this.daemon?.stop();
    this.daemon = null;
    await this.children.killAll(3000);
    rmSync(this.signalDir, { recursive: true, force: true });
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {}
    this.state.clear();
    this.facts.clear();
    this.names.clear();
    this.byNumber.clear();
    this.knownGroups.clear();
    this.timers.clear();
    this.pendingGroupUpdates.clear();
    this.recipients.clear();
    this.invited.clear();
    this.pendingPeers.clear();
    this.unsure.clear();
    this.heldEvents.clear();
    this.requestsKnown = false;
    this.links.clear();
    this.linksKnown = false;
    this.devices = null;
    this.devicesAt = 0;
    this.challenge = null;
    const { number: _n, aci: _a, linkedAt: _l, ...rest } = this.host.secret();
    this.host.saveSecret(rest);
    this.account = null;
    this.selfName = undefined;
    this.restarts = 0;
    this.startLink('relink');
  }
}

// ------------------------------------------------------------------ helpers

/** The group update that led to a re-read: who sent it, and when. */
type GroupCause = { by: string; ts: number };

function emptyResult(ev: P.AdapterEvent): MapResult {
  return { events: [ev], messages: [], refreshGroups: [], resync: false, pinTimers: [], logs: [] };
}

/**
 * updateGroup's params for one change. Without a group id signal-cli's updateGroup creates a new group, so that is
 * refused here, as is more than one change: each is its own group change, and they are not applied together.
 */
export function updateGroupParams(groupId: string | null | undefined, change: Record<string, unknown>): Record<string, unknown> {
  if (typeof groupId !== 'string' || !groupId.trim()) throw new Error('refusing updateGroup without a group id: signal-cli would create a new group');
  if (Object.keys(change).length !== 1 || 'groupId' in change) throw new Error('one group change per updateGroup');
  return { ...change, groupId };
}

/**
 * updateGroup's params to make a new group: a name and members, and never a group id (with one it would change that
 * group instead). The only path that sends updateGroup without a group id; changes to groups go by updateGroupParams.
 */
export function createGroupParams(name: string, members: string[]): { name: string; member: string[] } {
  if (typeof name !== 'string' || !name.trim()) throw new Error('a new group needs a name');
  const max = GROUP_RULES.signal!.max;
  if (!Array.isArray(members) || !members.length || members.length > max) throw new Error(`a new group starts with 1 to ${max} people`);
  if (!members.every((m) => typeof m === 'string' && ACI.test(m))) throw new Error('a new group takes Signal person ids');
  return { name: name.trim(), member: [...members] };
}

/**
 * A new group's updateGroup failing, in words. signal-cli 0.14.8 (GroupV2Helper.createGroup) logs why Signal's
 * servers refused and answers only "Failed to send message: Failed to create group (IOException)": a rate limit, a
 * captcha wanted, or this device's own profile not ready all read the same. Nothing anyone can see was made.
 */
export function createGroupError(e: unknown): Error {
  if (/failed to create group/i.test(errorText(e))) {
    return new Error("Signal did not make the group and signal-cli does not say why (Signal may be limiting this device, or this device's profile is not ready). Nothing was made; try again later.");
  }
  return signalError(e, 'make groups');
}

/** Whom the group update message did not reach, by ACI, with signal-cli's result type ("captcha" for a proof required). */
export function untold(results: SigSendResult['results']): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of results ?? []) {
    const id = lc(r.recipientAddress?.uuid);
    if (!id || r.type === 'SUCCESS') continue;
    out.set(id, r.type === 'RATE_LIMIT_FAILURE' && r.token ? 'captcha' : r.type);
  }
  return out;
}

/**
 * What the owner should know about people in the new group whom Signal could not tell: their phones learn of a group
 * from its group update message, so until the group changes or someone writes in it they may not see it.
 */
export function untoldNotes(told: Map<string, string>, nameOf: (aci: string) => string): string[] {
  const why: Record<string, string> = {
    captcha: 'Signal wants a captcha from this device first',
    RATE_LIMIT_FAILURE: 'Signal is limiting this device',
    IDENTITY_FAILURE: 'their safety number changed',
    NETWORK_FAILURE: 'the network failed',
    INVALID_PRE_KEY_FAILURE: "their phone's keys were out of date",
  };
  const by = new Map<string, string[]>();
  for (const [id, type] of told) {
    if (type === 'UNREGISTERED_FAILURE') continue;
    const reason = why[type] ?? `signal-cli said ${type}`;
    by.set(reason, [...(by.get(reason) ?? []), nameOf(id)]);
  }
  return [...by].map(([reason, names]) => `Signal could not tell ${names.join(', ')} about the group (${reason}): they may not see it until someone writes in it`);
}

/**
 * updateGroup's params to accept an invitation: the group id alone. signal-cli's updateGroup accepts a pending
 * invitation before it applies any change, and there is none. Without a group id it would create a new group, so
 * that is refused here.
 */
export function acceptInviteParams(groupId: string | null | undefined): { groupId: string } {
  if (typeof groupId !== 'string' || !groupId.trim()) throw new Error('refusing updateGroup without a group id: signal-cli would create a new group');
  return { groupId };
}

const permission = (who: unknown) => {
  if (who !== 'admins' && who !== 'everyone') throw new Error('everyone or admins');
  return who === 'admins' ? 'only-admins' : 'every-member';
};

function timerValue(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('a timer is a whole number of seconds');
  return v;
}

/** The updateGroup params for a change, null when it is already so. Throws for anything this account may not do. */
function groupChange(g: SigGroup, about: P.About, change: P.AboutChange): Record<string, unknown> | null {
  if (change.key === 'invite') {
    const inv = about.invite!;
    const link = g.groupInviteLink || null;
    if (change.op === 'create') {
      if (!inv.canCreate) throw new Error(inv.reason ?? 'Only admins can change the invite link.');
      return link ? { resetLink: true } : { link: 'enabled' };
    }
    if (change.op !== 'revoke') throw new Error('unknown invite operation');
    if (!link) return null;
    if (!inv.canRevoke) throw new Error(inv.reason ?? 'Only admins can change the invite link.');
    return { link: 'disabled' };
  }
  // Pins go by message (configure, before this), not as a group setting.
  if (change.key === 'pin') throw new Error('A pin is not a group setting');
  const field = (about.fields as Record<string, P.AboutSetting | undefined>)[change.key];
  if (!field) throw new Error(`${String(change.key)} is not a Signal group setting`);
  if (!field.canEdit) throw new Error(field.reason ?? `${change.key} cannot be changed here`);
  if (field.value === change.value && !field.writeOnly) return null;
  const v: unknown = change.value;
  switch (change.key) {
    case 'name': {
      const name = typeof v === 'string' ? v.trim() : '';
      if (!name) throw new Error('a name cannot be empty');
      return name === (g.name ?? '') ? null : { name };
    }
    case 'topic':
      if (typeof v !== 'string') throw new Error('a description is text');
      return { description: v };
    case 'disappearing':
      return { expiration: timerValue(v) };
    case 'announceOnly':
      if (typeof v !== 'boolean') throw new Error('on or off');
      return { setPermissionSendMessages: v ? 'only-admins' : 'every-member' };
    case 'editInfo':
      return { setPermissionEditDetails: permission(v) };
    case 'addMembers':
      return { setPermissionAddMember: permission(v) };
    case 'joinApproval':
      return approvalParams(g, v);
    case 'avatar':
      return { avatar: picturePath(v) };
    default:
      throw new Error(`${change.key} cannot be changed from here`);
  }
}

function stableJson(o: Record<string, unknown>) {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function redactNumber(n: string) {
  return n.length > 5 ? n.slice(0, 3) + '…' + n.slice(-2) : n;
}

/** UNIX socket paths are limited to ~107 bytes; fall back to a private runtime dir. */
export function socketPathFor(accountDir: string): string {
  const p = join(resolve(accountDir), 'signal-cli.sock');
  if (Buffer.byteLength(p) <= 100) return p;
  const base = process.env.XDG_RUNTIME_DIR || '/tmp';
  const h = new Bun.CryptoHasher('sha256').update(resolve(accountDir)).digest('hex').slice(0, 16);
  const dir = join(base, `dither-signal-${h}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'rpc.sock');
}

function sniffMime(b: Uint8Array, path: string): string {
  const head = (n: number) => Buffer.from(b.subarray(0, n)).toString('latin1');
  if (head(4) === '\x89PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (head(4) === 'GIF8') return 'image/gif';
  if (head(4) === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp';
  if (Buffer.from(b.subarray(4, 8)).toString('latin1') === 'ftyp') return 'video/mp4';
  const t = Bun.file(path).type;
  return t && !t.startsWith('application/octet-stream') ? t.split(';')[0] : 'application/octet-stream';
}
