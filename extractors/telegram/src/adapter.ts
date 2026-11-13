/**
 * Telegram adapter: one signed-in Telegram account, as dither-chat's adapter protocol (packages/chat-protocol).
 *
 *   no session   -> QR login (auth.exportLoginToken): status 'attention' (link_device) with tg://login?token=… as the
 *                   QR, a fresh one as each expires, for 10 minutes; then "New code" (action refreshLink).
 *                   Two-step password: attention 'login', answered by the action relogin {password}.
 *                   Or by phone: action sendCode {phone}, then signIn {code}, then relogin {password} if asked.
 *   signed in    -> the session string goes to secret.json (the password never does); a snapshot of the chats
 *                   (paced), then updates as they come. A restart signs in with the session and catches up.
 *   signed out   -> (elsewhere, revoked) the session is dropped and it asks for a new QR scan.
 *
 * Signed in through Telegram Desktop (config signIn: desktop, opts.desktop; docs/telegram.md): there is no QR code of
 * ours. Telegram Desktop runs in the account's sandbox (desktop.ts) and you sign in there, in the live view; once its
 * tdata says it is signed in, the account makes a session of its own (this client's auth.exportLoginToken, accepted
 * by a short-lived client on Telegram Desktop's key), or, if Telegram refuses that, shares Telegram Desktop's key.
 *
 * Adding (dither-chat docs/add.md; docs/telegram.md "Joining, contacts, join requests"): `resolve` says what an
 * invite link, an @name or a +phone is without acting (messages.checkChatInvite, contacts.resolveUsername,
 * contacts.resolvePhone); `add` joins (messages.importChatInvite, channels.joinChannel) or adds a contact
 * (contacts.addContact, never sharing your number); join requests to the groups and channels you admin are listed
 * after connect and kept up to date (messages.getChatInviteImporters on updatePendingJoinRequests) and answered with
 * messages.hideChatJoinRequest. Only a command does any of it: nothing joins, adds or answers by itself.
 *
 * Adding people to groups (the addMembers command; About's `adding` says where this account may): a basic group takes
 * them one at a time (messages.addChatUser), a supergroup or channel all at once (channels.inviteToChannel), in the
 * pacer's careful lane and sent once. Whom their privacy settings keep out comes back in the answer
 * (missingInvitees), each with a sentence; one person refused does not stop the rest, a flood wait or PEER_FLOOD does.
 * Making a group (createGroup) is one messages.createChat with a title and the people, in the same lane, sent once:
 * a basic group, with whom their privacy settings keep out refused the same way.
 *
 * People links (docs/telegram.md "Contacts and blocks"): the contacts and blocked users go out as the `relationships`
 * list after each snapshot (contacts.getContacts, contacts.getBlocked), and each change as a `relationship` event:
 * Telegram's updatePeerBlocked, this account's own add and remove, and what a read of the lists again finds (every
 * 30 minutes, and soon after a user's contact flag disagrees with the list). `remove` deletes a contact
 * (contacts.deleteContacts) or unblocks (contacts.unblock), only when that is still what they are.
 *
 * The hub side is a Host, so tests drive this without one; the Telegram side is a TgBackend (mtcute or the fake).
 */
import type * as P from '@dither-chat/protocol';
import { ADD_MEMBERS_MAX, createGroupProblem } from '@dither-chat/protocol';
import { Long } from '@mtcute/bun';
import { type ConnState, type DeskClient, type DesktopKey, floodSeconds, isAuthGone, isRpc, rpcText, type SentCode, type TgBackend, type tl, type UpdateInfo } from './backend.ts';
import type { DesktopHost } from './desktop.ts';
import { type OutEntity, toTelegram } from './entities.ts';
import { baseConv, convId, convOwner, emojiUrl, inviteAvatarUrl, joinRequestId, markedId, msgId, parseAvatarUrl, parseConv, parseCustomKey, parseEmojiUrl, parseInviteAvatarUrl, parseJoinRequestId, parseMediaUrl, parseMsg, type ConvRef, type PeerRef, userId } from './ids.ts';
import {
  authorOf,
  avatarOfChat,
  conversationOf,
  displayName,
  identityOfChat,
  identityOfUser,
  largestPhotoSize,
  type MapCtx,
  messageFact,
  muteOf,
  namedReactions,
  peerOf,
  reactionsOf,
  placeOf,
  TYPING_TTL,
  topicConversation,
  usernameOf,
} from './mapping.ts';
import { FloodError, Pacer, type PacerOptions } from './pacer.ts';
import { type ApprovedSession, approvedSession, approveRefusal, bySessionOrder, HASH_UNKNOWN, isTooFresh, NOT_ENDED, NOT_SIGNED_IN, parseLoginLink, parseSessionHash, SessionError, type SessionInfo, sessionInfo, tooFreshMessage } from './sessions.ts';
import { inDates, SEARCH_PAGE, SEARCH_REQUESTS, type SearchCommand, searchDates, searchFilter, searchWords } from './search.ts';
import { State } from './state.ts';

export const ADAPTER_VERSION = '0.1.0';
export const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'threads', 'media', 'sendMedia', 'openDirect', 'forward', 'about', 'configure', 'profile', 'resolve', 'join', 'connect', 'requests', 'relationships', 'disconnect', 'addMembers', 'createGroup', 'search'];
export const QR_MESSAGE = 'Scan this QR code in Telegram on your phone: Settings → Devices → Link Desktop Device';

export interface Host {
  emit(ev: P.AdapterEvent): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  accountDir: string;
  config: Record<string, any>;
  secret(): Record<string, any>;
  saveSecret(value: unknown): void;
}

export interface AdapterOptions {
  /** A new client for these credentials (after a sign-out, a fresh one); 'desktop': as Telegram Desktop, for its key. */
  backend: (creds: { apiId: number; apiHash: string }, profile?: 'desktop') => TgBackend;
  /** Signed in through Telegram Desktop in the account's sandbox. */
  desktop?: DesktopOptions;
  /** The backend is the fake (status says so). */
  fake?: boolean;
  pacer?: PacerOptions;
  /** How long a QR login keeps making fresh codes before it waits for "New code". */
  qrForMs?: number;
  /** How often a signed-in session is checked (a revoked session shows on the next call). */
  healthEveryMs?: number;
  /** Dialogs the snapshot reads at most, per folder. */
  maxDialogs?: number;
  reconnectBackoffMs?: number[];
  /**
   * Contacts and blocks read again: every `everyMs` (30 min), and `soonMs` (2 s) after a sign they changed, but not
   * within `gapMs` (60 s) of the last such read.
   */
  relations?: { everyMs?: number; soonMs?: number; gapMs?: number };
}

/**
 * Telegram Desktop's own app, as nixpkgs and Telegram's Linux packages build it (TDESKTOP_API_ID/HASH, published in
 * both). Telegram's terms ask every client for an app of its own, so a QR sign-in uses it only when the account asks
 * (config.app = "desktop"), or when it already signed in with it before that was a choice (a session and no app of
 * its own). The sign-in through Telegram Desktop itself (signIn = "desktop") is that app, so it always does.
 */
export const TELEGRAM_DESKTOP = { apiId: 611335, apiHash: 'd524b414d21f4d37f08684c1df41ac9c' } as const;

export interface DesktopOptions {
  session: DesktopHost;
  /** A client on Telegram Desktop's key that accepts this account's login token. */
  deskClient(key: DesktopKey): DeskClient;
  /** Telegram Desktop's key as a session string, for the shared fallback. */
  sharedSession(key: DesktopKey): Promise<string>;
  /** own (default): a session of its own; shared: Telegram Desktop's key from the start. */
  mode?: 'own' | 'shared';
  /** How often a shared key fetches what it may have missed (default 60 s). */
  catchUpMs?: number;
  /** Before trying an import that failed again (default 30 s, doubling to 10 min). */
  retryMs?: number;
}

type Phase = 'starting' | 'config' | 'connecting' | 'qr' | 'qr-expired' | 'code' | 'password' | 'online' | 'stopped' | 'error' | 'desktop' | 'importing';
type Status = Extract<P.AdapterEvent, { t: 'status' }>;

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
const deferred = <T>() => {
  let p!: Pending<T>;
  const promise = new Promise<T>((resolve, reject) => (p = { resolve, reject }));
  return { ...p, promise };
};

const MEDIA_MAX = 64 * 1024 * 1024;
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const rand = () => Long.fromBits((Math.random() * 2 ** 32) | 0, (Math.random() * 2 ** 31) | 0);
const ZERO = Long.ZERO;

const redactPhone = (p: string | undefined) => (p ? `+${p.replace(/^\+/, '').slice(0, 2)} ••• ${p.slice(-2)}` : null);

export class TelegramAdapter {
  readonly state: State;
  private backend: TgBackend | null = null;
  private phase: Phase = 'starting';
  private lastStatus: Status | null = null;
  private self: tl.RawUser | null = null;
  private conn: ConnState | 'never' = 'never';
  private connError: string | null = null;
  private pacer: Pacer;
  private abort: AbortController | null = null;
  private qrTimer?: Timer;
  private healthTimer?: Timer;
  private reconnectTimer?: Timer;
  private reconnects = 0;
  private snapshotting = false;
  private snapshotAgain = false;
  private snapshotCount = 0;
  private lastUpdateAt = 0;
  private code: { phone: string; hash: string; sent: SentCode } | null = null;
  private passwordWait: Pending<string> | null = null;
  private passwordRound: Pending<unknown> | null = null;
  private passwordHint: string | null = null;
  private signingIn = false;
  /** Desktop path: an import is running; why the last one fell back or failed; when to try again. */
  private importing = false;
  private importNote: string | null = null;
  private importFails = 0;
  private importTimer?: Timer;
  private catchUpTimer?: Timer;
  /** Facts already sent, by id: identities and conversations are sent again only when they change. */
  private sentIdentity = new Map<string, string>();
  private convFacts = new Map<string, P.ConversationFact>();
  private topicTitles = new Map<string, string>();
  /** Topics pinned in their forum: first among its channels. */
  private pinnedTopics = new Set<string>();
  /** Recent message facts, for reaction snapshots and read timestamps. */
  private recent = new Map<string, P.MessageFact>();
  private reactionNames = new Map<string, Set<string>>();
  private typingSent = new Map<string, number>();
  private users = new Map<number, tl.RawUser>();
  private chats = new Map<number, tl.TypeChat>();
  /** Join requests to the groups and channels this account admins, by native id; `listed` once the whole list was sent. */
  private joinRequests = new Map<string, P.RequestFact>();
  private requestsListed = false;
  private requestsChain: Promise<unknown> = Promise.resolve();
  private requestsTimer?: Timer;
  /** The snapshot at connect failed: list the join requests after the next one that works. */
  private requestsAfterSnapshot = false;
  /** Join requests answered here, and when: Telegram may list one again for a moment after. */
  private answeredAt = new Map<string, number>();
  /**
   * Contacts and blocked users (by user id; blocked: since when, ms, where Telegram says), as last read and changed
   * since. `known` once both lists were read; `listed` once the whole list went out; `sent` what the hub was told.
   */
  private contactIds = new Set<number>();
  private blockedIds = new Map<number, number | undefined>();
  private contactsSaved = 0;
  private relationsKnown = false;
  private relationsListed = false;
  private relationsSent = new Map<number, string>();
  /** Changed here or by an update, numbered: a list read that crosses a change keeps the change. */
  private relationsTouched = new Map<number, number>();
  private relationsSeq = 0;
  private relationsChain: Promise<unknown> = Promise.resolve();
  private relationsQueued: Promise<void> | null = null;
  private relationsWhole = false;
  private relationsTimer?: Timer;
  private relationsSoonTimer?: Timer;
  private relationsSoonAt = 0;

  private host: Host;
  /** Forums told to the hub as spaces this run (route). */
  private spacesSent = new Set<string>();

  constructor(
    host: Host,
    private opts: AdapterOptions,
  ) {
    // Every event goes out through route(): a forum is a space to the hub.
    this.host = {
      emit: (e) => {
        for (const x of this.route(e)) host.emit(x);
      },
      log: (level, msg, data) => host.log(level, msg, data),
      get accountDir() {
        return host.accountDir;
      },
      get config() {
        return host.config;
      },
      secret: () => host.secret(),
      saveSecret: (v) => host.saveSecret(v),
    };
    this.state = new State(host.accountDir);
    this.pacer = new Pacer({ ...opts.pacer, onFlood: (m, s) => this.onFlood(m, s) });
  }

  // ---------------------------------------------------------------- lifecycle

  hello() {
    this.host.emit({ t: 'hello', network: 'telegram', version: ADAPTER_VERSION, capabilities: CAPABILITIES });
  }

  onHubConnect() {
    this.hello();
    if (this.lastStatus) this.host.emit(this.lastStatus);
    // The list as it stands (kept up to date from Telegram's updates), once it was known whole.
    if (this.requestsListed) this.host.emit({ t: 'requests', requests: [...this.joinRequests.values()] });
    if (this.relationsListed) this.sendRelationList();
  }

  private get ctx(): MapCtx {
    const self = this.selfId;
    return {
      self,
      isForum: (id) => this.state.forums.has(id),
      nameOf: (p) => (p.kind === 'user' ? (this.state.names.get(p.id) ?? (p.id === self ? 'you' : undefined)) : (() => {
        const c = this.chats.get(p.id);
        return c && 'title' in c ? c.title : undefined;
      })()),
    };
  }

  private get selfId(): number {
    const id = this.self ? Number(this.self.id) : this.state.self?.id;
    if (!id) throw new Error('Telegram is not signed in yet');
    return id;
  }

  /**
   * The account's own app; Telegram Desktop's when it has neither api_id nor api_hash and chose it (or signs in through
   * Telegram Desktop, or signed in with it before it was a choice); null otherwise, or when only one of the two is
   * there or one is malformed.
   */
  private credentials(): { apiId: number; apiHash: string } | null {
    const rawId = this.host.config.apiId ?? this.host.secret().apiId;
    const rawHash = this.host.secret().apiHash ?? this.host.config.apiHash;
    const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
    if (!this.opts.fake && blank(rawId) && blank(rawHash)) {
      const app = String(this.host.config.app ?? '').trim();
      const before = app === '' && !!this.host.secret().session;
      return app === 'desktop' || this.opts.desktop || before ? { ...TELEGRAM_DESKTOP } : null;
    }
    const apiId = Number(rawId);
    const apiHash = String(rawHash ?? '').trim();
    if (!this.opts.fake && (!Number.isInteger(apiId) || apiId <= 0 || !/^[0-9a-f]{32}$/i.test(apiHash))) return null;
    return { apiId: apiId || 1, apiHash: apiHash || '0'.repeat(32) };
  }

  /** Whose app the account signs in with, for the pane. */
  private appNote(): string {
    if (this.opts.fake) return 'not used by the fake';
    const c = this.credentials();
    if (!c) return 'missing';
    return c.apiId === TELEGRAM_DESKTOP.apiId && c.apiHash === TELEGRAM_DESKTOP.apiHash ? `api_id ${c.apiId}, Telegram Desktop's` : `api_id ${c.apiId}, your own app`;
  }

  async start() {
    this.hello();
    this.setStatus('connecting', null);
    if (this.opts.desktop) await this.opts.desktop.session.start();
    const creds = this.credentials();
    if (!creds) {
      this.phase = 'config';
      this.setStatus('error', {
        kind: 'unknown',
        message:
          "This account has no app to sign in with: remove it and add it again with your app's api_id and api_hash (my.telegram.org, API development tools), or with Telegram Desktop's app chosen.",
      });
      return;
    }
    await this.connect(creds);
  }

  private async connect(creds: { apiId: number; apiHash: string }) {
    if (this.phase === 'stopped') return;
    this.phase = 'connecting';
    const d = this.opts.desktop;
    let session = (this.host.secret().session as string | undefined) || null;
    if (d && this.shared) {
      // Telegram Desktop's key, read from its tdata each start: never copied into secret.json.
      const s = d.session.signIn;
      if (s.state !== 'signed-in' || s.key.fingerprint !== this.host.secret().desktopKey) {
        const { userId: _u, sessionMode: _m, ...rest } = this.host.secret();
        this.host.saveSecret(rest);
        this.backend ??= this.opts.backend(creds);
        await this.backend.start(null).catch(() => null);
        return this.awaitDesktop();
      }
      this.backend ??= this.opts.backend({ ...TELEGRAM_DESKTOP }, 'desktop');
      session = await d.sharedSession(s.key);
    }
    this.backend ??= this.opts.backend(creds);
    let user: tl.RawUser | null = null;
    try {
      user = await this.backend.start(session);
      this.conn = 'connected';
      this.connError = null;
      this.reconnects = 0;
    } catch (e) {
      if (isAuthGone(e)) return this.sessionGone(e);
      this.conn = 'offline';
      this.connError = rpcText(e);
      const backoff = this.opts.reconnectBackoffMs ?? [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];
      const delay = backoff[Math.min(this.reconnects++, backoff.length - 1)];
      this.host.log('warn', `cannot reach Telegram: ${this.connError}; again in ${delay / 1000} s`);
      this.setStatus('offline', { kind: 'unknown', message: `Cannot reach Telegram (${this.connError}). Trying again in ${Math.round(delay / 1000)} s.` });
      await this.backend.close().catch(() => {});
      this.backend = null;
      this.reconnectTimer = setTimeout(() => void this.connect(creds), delay);
      return;
    }
    if ((this.phase as Phase) === 'stopped') return;
    if (user) await this.online(user);
    else if (session) await this.sessionGone(new Error('the saved session is not signed in'));
    else if (d) this.awaitDesktop();
    else this.startQr();
  }

  /** Shares Telegram Desktop's key (the fallback), rather than a session of its own. */
  private get shared() {
    return this.host.secret().sessionMode === 'shared';
  }

  async shutdown() {
    this.phase = 'stopped';
    this.abort?.abort();
    clearTimeout(this.qrTimer);
    clearInterval(this.healthTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.importTimer);
    clearInterval(this.catchUpTimer);
    clearTimeout(this.requestsTimer);
    clearInterval(this.relationsTimer);
    clearTimeout(this.relationsSoonTimer);
    await this.saveSession().catch(() => {});
    this.state.flush();
    await this.backend?.close().catch(() => {});
    await this.opts.desktop?.session.stop().catch(() => {});
  }

  // ---------------------------------------------------------------- status

  private setStatus(status: P.AccountStatus, attention?: Status['attention']) {
    const ev: Status = { t: 'status', status };
    if (attention !== undefined) ev.attention = attention;
    const self = this.selfFact();
    if (self) ev.self = self;
    if (this.opts.desktop) ev.liveView = this.opts.desktop.session.liveView();
    ev.details = this.details();
    ev.layers = this.layers(status, attention ?? null);
    this.lastStatus = ev;
    this.host.emit(ev);
  }

  /** The status again, with what changed underneath (counts, waits), keeping its attention. */
  private refreshStatus() {
    if (!this.lastStatus) return;
    this.setStatus(this.lastStatus.status, this.lastStatus.attention);
  }

  private selfFact(): P.IdentityFact | undefined {
    if (this.self) return identityOfUser(this.self, Number(this.self.id)) ?? undefined;
    return undefined;
  }

  private details(): Record<string, string | number | boolean | null> {
    const info = this.backend?.info();
    const held = this.pacer.held();
    const d: Record<string, string | number | boolean | null> = {
      client: this.opts.fake ? 'a fake Telegram (TELEGRAM_FAKE)' : (info?.library ?? 'mtcute'),
      layer: info?.layer ?? null,
      apiId: this.opts.fake ? null : (this.credentials()?.apiId ?? null),
      app: this.appNote(),
      testDc: !!this.host.config.testDc,
      dc: info?.dc ?? null,
      connection: this.conn,
      signIn: this.phase === 'online' ? 'signed in' : this.phase,
      session: this.host.secret().session ? 'in secret.json' : 'none',
    };
    if (this.self) {
      d.userId = String(this.self.id);
      d.username = usernameOf(this.self) ? `@${usernameOf(this.self)}` : null;
      d.phone = redactPhone(this.self.phone);
      if (this.self.premium) d.premium = true;
    }
    if (this.phase === 'online' || this.snapshotCount) {
      d.chats = this.state.dialogs.size;
      d.forums = this.state.forums.size;
      d.snapshots = this.snapshotCount;
      d.joinRequests = this.requestsListed ? this.joinRequests.size : null;
      d.contacts = this.relationsKnown ? this.contactIds.size : null;
      d.blocked = this.relationsKnown ? this.blockedIds.size : null;
    }
    if (this.lastUpdateAt) d.lastUpdate = new Date(this.lastUpdateAt).toISOString();
    const waits = Object.entries(held);
    d.floodWait = waits.length ? waits.map(([m, s]) => `${m} ${s} s`).join(', ') : null;
    if (this.opts.desktop) {
      d.signInVia = 'Telegram Desktop';
      d.session = this.shared ? "Telegram Desktop's (shared, read from its tdata)" : this.host.secret().session ? 'its own, in secret.json' : 'none';
      if (this.shared) d.app = "api_id 611335, Telegram Desktop's (its key)";
      d.importNote = this.importNote;
      Object.assign(d, this.opts.desktop.session.details());
    }
    return d;
  }

  /** What it rests on, outermost first: credentials, the connection, the sign-in, receiving updates. */
  private layers(status: P.AccountStatus, attention: Status['attention'] | null): P.StatusLayer[] {
    const creds: P.StatusLayer = this.phase === 'config' ? { name: 'api_id and api_hash', state: 'failed', note: 'only one of the two, or malformed' } : { name: 'api_id and api_hash', state: 'ok', note: this.appNote() };
    const where = this.opts.fake ? 'the fake Telegram' : this.host.config.testDc ? "Telegram's test DC" : 'Telegram';
    const conn: P.StatusLayer =
      this.phase === 'config'
        ? { name: 'connection', state: 'waiting', note: 'waits for the credentials' }
        : this.conn === 'connected' || this.conn === 'updating'
          ? { name: 'connection', state: 'ok', note: `${where}${this.backend?.info().dc ? `, DC ${this.backend.info().dc}` : ''}` }
          : this.conn === 'offline'
            ? { name: 'connection', state: 'failed', note: this.connError ?? 'offline' }
            : { name: 'connection', state: 'waiting', note: `connecting to ${where}` };
    const signed: P.StatusLayer =
      this.phase === 'online'
        ? { name: 'signed in', state: 'ok', note: `as ${this.self && usernameOf(this.self) ? `@${usernameOf(this.self)}` : (this.selfFact()?.displayName ?? redactPhone(this.self?.phone) ?? 'you')}` }
        : this.phase === 'qr'
          ? { name: 'signed in', state: 'waiting', note: 'scan the QR code with Telegram on your phone' }
          : this.phase === 'qr-expired'
            ? { name: 'signed in', state: 'waiting', note: 'the QR code expired: press New code' }
            : this.phase === 'code'
              ? { name: 'signed in', state: 'waiting', note: 'enter the code Telegram sent' }
              : this.phase === 'password'
                ? { name: 'signed in', state: 'waiting', note: 'enter your two-step verification password' }
                : status === 'error'
                  ? { name: 'signed in', state: 'failed', note: attention?.message ?? 'failed' }
                  : { name: 'signed in', state: 'waiting', note: 'waits for the connection' };
    const held = Object.entries(this.pacer.held());
    const updates: P.StatusLayer =
      this.phase !== 'online'
        ? { name: 'updates', state: 'waiting', note: 'waits for the sign-in' }
        : held.length
          ? { name: 'updates', state: 'waiting', note: `Telegram holds back ${held.map(([m, s]) => `${m} (${s} s)`).join(', ')}` }
          : status === 'online'
            ? { name: 'updates', state: 'ok', note: this.conn === 'updating' ? 'catching up' : `${this.state.dialogs.size} chats` }
            : { name: 'updates', state: 'waiting', note: this.snapshotting ? 'reading your chats' : 'starting' };
    if (this.opts.desktop) return [...this.desktopLayers(status, attention), conn, updates];
    return [creds, conn, signed, updates];
  }

  /** Desktop path: the sandbox, Telegram Desktop, its sign-in, and how this account's session came from it. */
  private desktopLayers(status: P.AccountStatus, attention: Status['attention'] | null): P.StatusLayer[] {
    const d = this.opts.desktop!;
    const own = !this.shared && !!this.host.secret().session;
    const layers = d.session.layers(!own);
    const s = d.session.signIn;
    const selfId = this.self ? String(this.self.id) : (this.host.secret().userId as string | undefined);
    if (own && s.state === 'signed-in' && selfId && String(s.key.userId) !== selfId) layers[2] = { ...layers[2], state: 'off', note: `as another account (user ${s.key.userId}); this account stays user ${selfId}` };
    const ended = s.state === 'signed-in' && this.host.secret().desktopEnded === s.key.fingerprint;
    const imported: P.StatusLayer =
      this.phase === 'online' || (this.phase === 'connecting' && (own || this.shared))
        ? this.shared
          ? { name: 'session imported', state: 'ok', note: `shares Telegram Desktop's session${this.importNote ? ` (${this.importNote})` : ''}` }
          : { name: 'session imported', state: 'ok', note: "its own session (auth.acceptLoginToken); Telegram Desktop's stays its own" }
        : this.phase === 'importing'
          ? { name: 'session imported', state: 'waiting', note: 'making a session of its own (auth.acceptLoginToken)' }
          : this.phase === 'password'
            ? { name: 'session imported', state: 'waiting', note: "enter your two-step verification password for this account's own session" }
            : this.phase === 'config' || status === 'error'
              ? { name: 'session imported', state: 'failed', note: attention?.message ?? this.importNote ?? 'failed' }
              : ended
                ? { name: 'session imported', state: 'waiting', note: "this account's own session was ended: run importDesktop for a new one" }
                : { name: 'session imported', state: 'waiting', note: this.importNote ? `waits to try again (${this.importNote})` : 'waits for the sign-in in Telegram Desktop' };
    return [...layers, imported];
  }

  private onFlood(method: string, seconds: number) {
    this.host.log('warn', `FLOOD_WAIT: Telegram asks to wait ${seconds} s before more ${method}`);
    this.refreshStatus();
  }

  // ---------------------------------------------------------------- sign-in

  private startQr(message?: string) {
    if (!this.backend || this.phase === 'stopped') return;
    this.abort?.abort();
    clearTimeout(this.qrTimer);
    const ac = new AbortController();
    this.abort = ac;
    this.phase = 'qr';
    this.code = null;
    this.setStatus('attention', { kind: 'link_device', message: message ?? 'Getting a QR code from Telegram…' });
    this.qrTimer = setTimeout(() => {
      if (this.phase !== 'qr' || this.abort !== ac) return;
      ac.abort();
      this.phase = 'qr-expired';
      this.setStatus('attention', { kind: 'link_device', message: 'The QR code expired. Press New code for another one, or sign in with your phone number.' });
    }, this.opts.qrForMs ?? 10 * 60_000);
    const backend = this.backend;
    void backend
      .qrLogin({
        onUrl: (url, expiresAt) => {
          if (this.abort !== ac || ac.signal.aborted) return;
          this.phase = 'qr';
          this.setStatus('attention', { kind: 'link_device', message: message ? `${message} ${QR_MESSAGE}.` : QR_MESSAGE, qr: url, qrRefreshAt: expiresAt });
        },
        onScanned: () => {
          if (this.abort !== ac) return;
          clearTimeout(this.qrTimer);
          this.setStatus('connecting', null);
        },
        password: (hint, wrong) => this.askPassword(hint, wrong),
        signal: ac.signal,
      })
      .then((user) => this.signedIn(user))
      .catch((e) => {
        if (ac.signal.aborted || this.abort !== ac) return;
        this.signInFailed(e);
      });
  }

  /** The two-step password, from the relogin action. */
  private askPassword(hint: string | null, wrong: boolean): Promise<string> {
    clearTimeout(this.qrTimer);
    this.phase = 'password';
    this.passwordHint = hint;
    if (wrong && this.passwordRound) {
      this.passwordRound.reject(new Error('That password is not right. Try again.'));
      this.passwordRound = null;
    }
    const h = hint ? ` (hint: “${hint}”)` : '';
    const forOwn = this.opts.desktop ? " for this account's own session (Telegram Desktop has its own)" : '';
    this.setStatus('attention', { kind: 'login', message: wrong ? `That password is not right. Enter your two-step verification password again${h}.` : `Telegram asks for your two-step verification password${forOwn}${h}.` });
    const d = deferred<string>();
    this.passwordWait = d;
    return d.promise;
  }

  private async signedIn(user: tl.RawUser, extra: Record<string, unknown> = {}) {
    this.signingIn = true;
    try {
      const session = await this.backend!.exportSession();
      const { password: _p, code: _c, desktopEnded: _e, ...secret } = this.host.secret();
      this.host.saveSecret({ ...secret, session, userId: String(user.id), ...extra });
      this.host.log('info', `signed in as ${displayName(user)} (${user.id}); session saved in secret.json`);
      this.passwordRound?.resolve({ signedIn: true });
      this.passwordRound = null;
      this.passwordWait = null;
      this.code = null;
      clearTimeout(this.qrTimer);
      await this.online(user);
    } finally {
      this.signingIn = false;
    }
  }

  private signInFailed(e: unknown) {
    const text = rpcText(e);
    this.host.log('warn', `sign-in failed: ${text}`);
    this.passwordRound?.reject(new Error(text));
    this.passwordRound = null;
    if (this.opts.desktop) return this.importFailed(text);
    const flood = floodSeconds(e);
    if (flood !== null) {
      this.phase = 'error';
      this.setStatus('attention', { kind: 'rate_limited', message: `Telegram asks to wait ${flood} s before signing in again. Then press New code.` });
      return;
    }
    this.startQr(`Signing in failed (${text}).`);
  }

  private async saveSession() {
    if (!this.backend || this.phase !== 'online' || this.shared) return;
    const session = await this.backend.exportSession();
    if (session && session !== this.host.secret().session) this.host.saveSecret({ ...this.host.secret(), session });
  }

  /** The session no longer works (signed out on the phone, revoked): drop it and ask for a new scan. */
  private async sessionGone(e: unknown) {
    this.host.log('warn', `Telegram ended this session: ${rpcText(e)}`);
    clearInterval(this.healthTimer);
    clearInterval(this.catchUpTimer);
    const { session: _s, userId: _u, sessionMode: _m, ...rest } = this.host.secret();
    // Desktop path: the key it came from is not imported again by itself (you ended this session, or it was
    // Telegram Desktop's own and is gone); a new sign-in there, or importDesktop, makes another.
    this.host.saveSecret(this.opts.desktop && rest.desktopKey ? { ...rest, desktopEnded: rest.desktopKey } : rest);
    const creds = this.credentials();
    await this.backend?.wipe().catch(() => {});
    this.backend = creds ? this.opts.backend(creds) : null;
    this.self = null;
    this.state.clear();
    this.sentIdentity.clear();
    this.convFacts.clear();
    clearTimeout(this.requestsTimer);
    this.joinRequests.clear();
    this.answeredAt.clear();
    this.requestsListed = false;
    this.requestsAfterSnapshot = false;
    clearInterval(this.relationsTimer);
    clearTimeout(this.relationsSoonTimer);
    this.relationsSoonTimer = undefined;
    this.contactIds = new Set();
    this.blockedIds = new Map();
    this.relationsKnown = false;
    this.relationsListed = false;
    this.relationsSent.clear();
    this.relationsTouched.clear();
    if (!this.backend) return;
    try {
      await this.backend.start(null);
      this.conn = 'connected';
    } catch (err) {
      this.conn = 'offline';
      this.connError = rpcText(err);
    }
    if (this.opts.desktop) return this.awaitDesktop();
    this.startQr('Telegram signed this device out (from another device, or the session was revoked).');
  }

  // ---------------------------------------------------------------- Telegram Desktop

  /** Telegram Desktop's sandbox or sign-in changed. */
  desktopChanged() {
    if (this.phase === 'stopped' || !this.opts.desktop) return;
    if (this.phase === 'desktop') return this.awaitDesktop();
    this.refreshStatus();
  }

  /** Wait for a sign-in in Telegram Desktop, saying what it needs, and import it once it is there. */
  private awaitDesktop() {
    const d = this.opts.desktop!;
    this.phase = 'desktop';
    this.self = null;
    const s = d.session.signIn;
    const ended = s.state === 'signed-in' && this.host.secret().desktopEnded === s.key.fingerprint;
    if (s.state === 'signed-in' && !ended && !this.importing && !this.importTimer) {
      void this.importDesktop(s.key);
      return;
    }
    const sandboxError = d.session.liveView() ? null : (d.session.layers(true)[0].state === 'failed' ? d.session.layers(true)[0].note : null);
    if (sandboxError) return this.setStatus('error', { kind: 'unknown', message: `Telegram Desktop's sandbox did not start: ${sandboxError}` });
    const message =
      s.state === 'passcode'
        ? s.wrong
          ? 'That is not Telegram Desktop’s local passcode. Give it again (action desktopPasscode {"passcode": "…"}), or turn it off in Telegram Desktop.'
          : 'Telegram Desktop is locked with a local passcode: give it once (action desktopPasscode {"passcode": "…"}; it is not kept), or turn it off in Telegram Desktop’s settings.'
        : s.state === 'unreadable'
          ? `Telegram Desktop's session could not be read (${s.error}).`
          : ended
            ? "This account's own session was ended while Telegram Desktop stayed signed in. Run importDesktop for a new one, or sign out and in again in the live view."
            : this.importTimer
              ? `Making this account's session from Telegram Desktop's did not work (${this.importNote}); trying again shortly, or run importDesktop.`
              : 'Sign in to Telegram in the live view: Telegram Desktop shows its QR code (on your phone: Telegram → Settings → Devices → Link Desktop Device), or log in with your phone number there.';
    this.setStatus('attention', { kind: 'login', message, liveView: true });
  }

  /** Make this account's session from Telegram Desktop's: its own if Telegram allows, else Telegram Desktop's key. */
  private async importDesktop(key: DesktopKey, mode = this.host.config.desktopSession === 'shared' ? 'shared' : (this.opts.desktop!.mode ?? 'own')) {
    if (this.importing || this.phase === 'stopped') return;
    this.importing = true;
    this.phase = 'importing';
    this.setStatus('connecting', null);
    try {
      if (mode === 'own') {
        try {
          await this.importOwn(key);
          return;
        } catch (e) {
          if ((this.phase as Phase) === 'stopped') return;
          if (!(e instanceof AcceptRefused)) throw e;
          this.importNote = `auth.acceptLoginToken refused: ${rpcText(e.cause)}`;
          this.host.log('warn', `${this.importNote}; sharing Telegram Desktop's session instead`);
        }
      }
      await this.importShared(key);
    } catch (e) {
      if ((this.phase as Phase) !== 'stopped') this.importFailed(rpcText(e));
    } finally {
      this.importing = false;
    }
  }

  /** This client's login token, accepted by a short-lived client on Telegram Desktop's key. */
  private async importOwn(key: DesktopKey) {
    const d = this.opts.desktop!;
    if (!this.backend) throw new Error('not connected to Telegram yet');
    const backend = this.backend;
    const desk = d.deskClient(key);
    const ac = new AbortController();
    this.abort?.abort();
    this.abort = ac;
    let refused: unknown = null;
    let accepted = false;
    try {
      const user = await backend.qrLogin({
        onUrl: (url) => {
          if (accepted || ac.signal.aborted) return;
          const token = Buffer.from(url.slice(url.indexOf('token=') + 'token='.length), 'base64url');
          desk.acceptLoginToken(token).then(
            () => {
              accepted = true;
              this.host.log('info', "Telegram Desktop's session accepted this account's login token");
            },
            (e) => {
              refused = e;
              ac.abort();
            },
          );
        },
        onScanned: () => {},
        password: (hint, wrong) => this.askPassword(hint, wrong),
        signal: ac.signal,
      });
      this.importNote = null;
      this.importFails = 0;
      await this.signedIn(user, { sessionMode: 'own', desktopKey: key.fingerprint });
    } catch (e) {
      if (refused) throw new AcceptRefused(refused);
      throw e;
    } finally {
      await desk.close().catch(() => {});
    }
  }

  /** Telegram Desktop's key itself, with a session id of its own; catching up on what Telegram sends elsewhere. */
  private async importShared(key: DesktopKey) {
    const d = this.opts.desktop!;
    await this.backend?.close().catch(() => {});
    this.backend = this.opts.backend({ ...TELEGRAM_DESKTOP }, 'desktop');
    const user = await this.backend.start(await d.sharedSession(key));
    if (!user) throw new Error("Telegram Desktop's session is not signed in");
    const { session: _s, desktopEnded: _e, ...rest } = this.host.secret();
    this.host.saveSecret({ ...rest, sessionMode: 'shared', userId: String(user.id), desktopKey: key.fingerprint });
    this.importFails = 0;
    this.host.log('info', `sharing Telegram Desktop's session as user ${user.id}`);
    await this.online(user);
  }

  private importFailed(text: string) {
    this.importNote = text;
    const base = this.opts.desktop!.retryMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.importFails++, 10 * 60_000);
    this.host.log('warn', `making a session from Telegram Desktop's failed (${text}); again in ${Math.round(delay / 1000)} s`);
    clearTimeout(this.importTimer);
    this.importTimer = setTimeout(() => {
      this.importTimer = undefined;
      if (this.phase === 'desktop') this.awaitDesktop();
    }, delay);
    this.awaitDesktop();
  }

  private async action(action: string, args: any): Promise<unknown> {
    switch (action) {
      case 'importDesktop': {
        const d = this.opts.desktop;
        if (!d) throw new Error('This account signs in by QR code, not through Telegram Desktop');
        if (this.phase === 'online') throw new Error('Already signed in. Use logout first.');
        const s = d.session.signIn;
        if (s.state !== 'signed-in') throw new Error('Telegram Desktop is not signed in: sign in in the live view first');
        const { desktopEnded: _e, ...rest } = this.host.secret();
        this.host.saveSecret(rest);
        clearTimeout(this.importTimer);
        this.importTimer = undefined;
        this.importFails = 0;
        const mode = args?.mode === 'shared' ? 'shared' : args?.mode === 'own' ? 'own' : undefined;
        await this.importDesktop(s.key, mode);
        return { phase: this.phase, session: this.shared ? 'shared' : this.host.secret().session ? 'own' : 'none' };
      }
      case 'desktopPasscode': {
        if (!this.opts.desktop) throw new Error('This account has no Telegram Desktop');
        const passcode = typeof args?.passcode === 'string' ? args.passcode : '';
        if (!passcode) throw new Error('Give the passcode: {"passcode": "…"}');
        this.opts.desktop.session.setPasscode(passcode);
        return { signIn: this.opts.desktop.session.signIn.state };
      }
      case 'restartDesktop':
        if (!this.opts.desktop) throw new Error('This account has no Telegram Desktop');
        await this.opts.desktop.session.restartApp();
        return {};
      case 'startLink':
      case 'refreshLink':
      case 'qr':
        if (this.opts.desktop) throw new Error('This account signs in through Telegram Desktop: use the live view');
        if (this.phase === 'online') throw new Error('Already signed in. Use logout first to sign in as someone else.');
        if (!this.backend) throw new Error(this.phase === 'config' ? 'api_id and api_hash do not match up' : 'not connected to Telegram yet');
        this.startQr();
        return { started: true };
      case 'relogin':
      case 'password': {
        const password = typeof args?.password === 'string' ? args.password : '';
        if (!password) throw new Error('Give the password: {"password": "…"}');
        if (this.phase !== 'password' || !this.passwordWait) throw new Error(this.phase === 'online' ? 'Already signed in' : 'Telegram is not asking for a password now');
        const round = deferred<unknown>();
        this.passwordRound = round;
        const wait = this.passwordWait;
        this.passwordWait = null;
        this.setStatus('connecting', { kind: 'login', message: 'Checking the password…' });
        wait.resolve(password);
        return round.promise;
      }
      case 'sendCode':
      case 'pairPhone': {
        if (this.opts.desktop) throw new Error('This account signs in through Telegram Desktop: log in with your phone number there, in the live view');
        if (this.phase === 'online') throw new Error('Already signed in');
        if (!this.backend) throw new Error('not connected to Telegram yet');
        const phone = String(args?.phone ?? '').replace(/[\s().-]/g, '');
        if (!/^\+?\d{7,15}$/.test(phone)) throw new Error('Give the phone number with its country code, like +15551234567');
        this.abort?.abort();
        clearTimeout(this.qrTimer);
        const sent = await this.pacer.run('auth.sendCode', () => this.backend!.sendCode(phone));
        this.code = { phone, hash: sent.phoneCodeHash, sent };
        this.phase = 'code';
        this.setStatus('attention', { kind: 'verify', message: codeMessage(sent, phone), detail: { code: { type: sent.type, ...(sent.length ? { length: sent.length } : {}), ...(sent.nextType ? { next: sent.nextType } : {}) } } });
        return { sent: sent.type, ...(sent.length ? { length: sent.length } : {}), ...(sent.timeout ? { timeout: sent.timeout } : {}) };
      }
      case 'resendCode': {
        if (!this.code || this.phase !== 'code') throw new Error('No code was asked for: use sendCode first');
        const sent = await this.pacer.run('auth.resendCode', () => this.backend!.resendCode(this.code!.phone, this.code!.hash));
        this.code = { ...this.code, hash: sent.phoneCodeHash, sent };
        this.setStatus('attention', { kind: 'verify', message: codeMessage(sent, this.code.phone), detail: { code: { type: sent.type, ...(sent.length ? { length: sent.length } : {}) } } });
        return { sent: sent.type };
      }
      case 'signIn':
      case 'code': {
        const code = String(args?.code ?? '').replace(/\D/g, '');
        if (!code) throw new Error('Give the code: {"code": "12345"}');
        if (!this.code || this.phase !== 'code') throw new Error('No code was asked for: use sendCode first');
        const c = this.code;
        try {
          const user = await this.backend!.signIn(c.phone, c.hash, code);
          await this.signedIn(user);
          return { signedIn: true };
        } catch (e) {
          if (isRpc(e, 'SESSION_PASSWORD_NEEDED')) {
            const hint = await this.backend!.passwordHint().catch(() => null);
            void this.codePassword(hint);
            return { password: true, ...(hint ? { hint } : {}) };
          }
          if (isRpc(e, 'PHONE_CODE_INVALID')) throw new Error('That code is not right');
          if (isRpc(e, 'PHONE_CODE_EXPIRED')) throw new Error('That code expired: ask for a new one (sendCode)');
          throw e;
        }
      }
      case 'logout':
      case 'relink': {
        if (this.phase === 'online') await this.backend?.logOut().catch((e) => this.host.log('warn', `logOut: ${rpcText(e)}`));
        await this.sessionGone(new Error(action));
        return {};
      }
      case 'resync':
        if (this.phase !== 'online') throw new Error('Not signed in');
        // The join requests read again once the chats are.
        this.requestsAfterSnapshot = true;
        await this.snapshot();
        return { chats: this.state.dialogs.size };
      case 'status':
        return {
          phase: this.phase,
          connection: this.conn,
          chats: this.state.dialogs.size,
          held: this.pacer.held(),
          floods: this.pacer.floods,
          ...(this.opts.desktop ? { desktop: this.opts.desktop.session.details(), session: this.shared ? 'shared' : this.host.secret().session ? 'own' : 'none', importNote: this.importNote } : {}),
        };
      case 'approveLogin':
        return this.approveLogin(args?.link);
      case 'endSession':
        return this.endSession(args?.hash);
      case 'sessions':
        return this.sessions();
      default:
        throw new Error(
          this.opts.desktop
            ? `unknown action "${action}" (telegram through Telegram Desktop has importDesktop {mode?}, desktopPasscode {passcode}, restartDesktop, relogin {password}, logout, resync, status, approveLogin {link}, sessions, endSession {hash})`
            : `unknown action "${action}" (telegram has refreshLink, relogin {password}, sendCode {phone}, signIn {code}, resendCode, logout, resync, status, approveLogin {link}, sessions, endSession {hash})`,
        );
    }
  }

  /** The password after a phone sign-in. */
  private async codePassword(hint: string | null) {
    let wrong = false;
    for (;;) {
      const password = await this.askPassword(hint, wrong);
      try {
        const user = await this.backend!.checkPassword(password);
        await this.signedIn(user);
        return;
      } catch (e) {
        if (isRpc(e, 'PASSWORD_HASH_INVALID')) {
          wrong = true;
          continue;
        }
        this.signInFailed(e);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- other sessions
  // For an app that stands in for the phone (sessions.ts, docs/telegram.md). The log says only which action ran and
  // how it ended: never the code, a session's hash, its device or where it is.

  /** Approve a sign-in on another device by the QR code it shows (auth.acceptLoginToken): it becomes a session of this account. */
  private async approveLogin(link: unknown): Promise<{ session: ApprovedSession }> {
    this.mustBeOnline('approveLogin');
    let token: Uint8Array;
    try {
      token = parseLoginLink(link);
    } catch (e) {
      this.host.log('info', 'approveLogin: refused: not a sign-in code');
      throw e;
    }
    try {
      const a = await this.sessionCall({ _: 'auth.acceptLoginToken', token });
      this.host.log('info', 'approveLogin: approved a sign-in on another device');
      return { session: approvedSession(a) };
    } catch (e) {
      throw await this.sessionRefusal('approveLogin', e, approveRefusal(e), 'approve sign-ins', 'Telegram did not approve that sign-in');
    }
  }

  /** End one of the account's other sessions (account.resetAuthorization), by the hash `sessions` or `approveLogin` gave. */
  private async endSession(hashArg: unknown): Promise<Record<string, never>> {
    this.mustBeOnline('endSession');
    let hash: string;
    try {
      hash = parseSessionHash(hashArg);
    } catch (e) {
      this.host.log('info', 'endSession: refused: not the hash of another session');
      throw e;
    }
    let ended: boolean;
    try {
      ended = await this.sessionCall({ _: 'account.resetAuthorization', hash: Long.fromString(hash) });
    } catch (e) {
      throw await this.sessionRefusal('endSession', e, isRpc(e, 'HASH_INVALID') ? HASH_UNKNOWN : null, 'end other sessions', 'Telegram did not end that session');
    }
    if (!ended) {
      this.host.log('info', 'endSession: Telegram answered that it ended nothing');
      throw new SessionError(NOT_ENDED);
    }
    this.host.log('info', 'endSession: ended a session');
    return {};
  }

  /** The account's sessions (Settings → Devices), this one first: never their IPs. */
  private async sessions(): Promise<{ sessions: SessionInfo[] }> {
    this.mustBeOnline('sessions');
    try {
      const res = await this.sessionCall({ _: 'account.getAuthorizations' });
      const sessions = res.authorizations.map(sessionInfo).sort(bySessionOrder);
      this.host.log('info', `sessions: listed ${sessions.length}`);
      return { sessions };
    } catch (e) {
      throw await this.sessionRefusal('sessions', e, null, null, 'Telegram did not list the sessions');
    }
  }

  private mustBeOnline(action: string) {
    if (this.phase === 'online' && this.backend) return;
    this.host.log('info', `${action}: refused: not signed in`);
    throw new SessionError(NOT_SIGNED_IN);
  }

  /** A call for the session actions, through the pacer: Telegram's refusal comes back as it is, to be put in words. */
  private async sessionCall<T extends tl.RpcMethod>(req: T): Promise<tl.RpcCallReturn[T['_']]> {
    const backend = this.backend;
    if (!backend || this.phase !== 'online') throw new SessionError(NOT_SIGNED_IN);
    try {
      return await this.pacer.run(req._, () => backend.call(req));
    } catch (e) {
      if (isAuthGone(e)) void this.sessionGone(e);
      throw e;
    }
  }

  /** A session action's failure, logged by Telegram's error code alone, in words for the app. */
  private async sessionRefusal(action: string, e: unknown, words: string | null, freshWhat: Parameters<typeof tooFreshMessage>[0] | null, otherwise: string): Promise<Error> {
    if (e instanceof SessionError) return e;
    const code = e instanceof FloodError ? `FLOOD_WAIT ${e.seconds} s` : rpcText(e);
    this.host.log('info', `${action}: refused by Telegram (${code})`);
    if (e instanceof FloodError) return e;
    if (words) return new SessionError(words);
    if (isAuthGone(e)) return new SessionError(NOT_SIGNED_IN);
    if (freshWhat && isTooFresh(e)) return new SessionError(tooFreshMessage(freshWhat, await this.currentSession()));
    return new SessionError(`${otherwise} (${code}).`);
  }

  /** This account's own session, to name it in a refusal; null when the list cannot be read. */
  private async currentSession(): Promise<SessionInfo | null> {
    try {
      const res = await this.sessionCall({ _: 'account.getAuthorizations' });
      const a = res.authorizations.find((x) => x.current);
      return a ? sessionInfo(a) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- online

  private async online(user: tl.RawUser) {
    this.phase = 'online';
    this.self = user;
    this.state.self = { id: Number(user.id), name: displayName(user), ...(usernameOf(user) ? { username: usernameOf(user) } : {}), ...(user.phone ? { phone: user.phone } : {}) };
    this.ingest([user], []);
    this.setStatus('connecting', null);
    await this.backend!.startUpdates(
      (u) => this.onUpdate(u),
      (s) => this.onConn(s),
    );
    await this.saveSession().catch(() => {});
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.health(), this.opts.healthEveryMs ?? 5 * 60_000);
    clearInterval(this.catchUpTimer);
    if (this.opts.desktop && this.shared) this.catchUpTimer = setInterval(() => this.backend?.catchUp?.(), this.opts.desktop.catchUpMs ?? 60_000);
    // Contacts added or removed on another device may come with no update of their own: the lists read again.
    clearInterval(this.relationsTimer);
    this.relationsTimer = setInterval(() => void this.refreshRelations(), this.opts.relations?.everyMs ?? 30 * 60_000);
    let read = false;
    try {
      await this.snapshot();
      read = true;
    } catch (e) {
      if (isAuthGone(e)) return this.sessionGone(e);
      this.host.log('warn', `snapshot: ${rpcText(e)}`);
    }
    if (this.phase === 'online') this.setStatus('online', null);
    // Join requests to the chats this account admins: it knows which only now, from the snapshot. Without one it
    // does not know them, and an empty list would say there are none: the next snapshot that works lists them.
    if (this.phase === 'online') {
      if (read) void this.listJoinRequests();
      else this.requestsAfterSnapshot = true;
    }
  }

  private onConn(s: ConnState) {
    if (this.conn === s) return;
    this.conn = s;
    if (this.phase !== 'online' || this.snapshotting) return;
    if (s === 'offline' || s === 'connecting') this.setStatus('connecting', null);
    else this.setStatus('online', null);
  }

  private async health() {
    if (this.phase !== 'online' || !this.backend) return;
    try {
      await this.backend.call({ _: 'updates.getState' });
    } catch (e) {
      if (isAuthGone(e)) await this.sessionGone(e);
    }
  }

  /**
   * A call through the pacer; a dead session found here goes back to sign-in. once: the call acts (a join, a contact,
   * an answer): sent once, never again by itself after a flood wait (pacer.ts).
   */
  private async call<T extends tl.RpcMethod>(req: T, opts: { background?: boolean; chat?: string; once?: boolean; maxWaitMs?: number } = {}): Promise<tl.RpcCallReturn[T['_']]> {
    if (!this.backend || this.phase !== 'online') throw new Error('Telegram is not signed in');
    const backend = this.backend;
    try {
      return await this.pacer.run(req._, () => backend.call(req, opts.once ? { once: true } : undefined), opts);
    } catch (e) {
      if (isAuthGone(e)) void this.sessionGone(e);
      throw e instanceof FloodError ? e : new Error(`${req._}: ${rpcText(e)}`);
    }
  }

  // ---------------------------------------------------------------- peers

  /**
   * Users and chats Telegram sent: remembered (access hashes, names) and sent on as facts where they changed. A full
   * user whose contact flag disagrees with the contacts as known is a sign the list changed (on another device): it
   * is read again soon. quiet: the lists themselves, or a call whose answer is applied to them directly.
   */
  private ingest(users: readonly tl.TypeUser[], chats: readonly tl.TypeChat[], quiet = false) {
    const self = this.self ? Number(this.self.id) : (this.state.self?.id ?? 0);
    let changed = false;
    let relations = false;
    for (const u of users) {
      if (u._ !== 'user') continue;
      const id = Number(u.id);
      if (!quiet && !u.min && this.relationsKnown && !this.snapshotting && id !== self && !!(u.contact || u.mutualContact) !== this.contactIds.has(id)) relations = true;
      if (!u.min && u.accessHash) {
        const h = u.accessHash.toString();
        if (this.state.users.get(id) !== h) {
          this.state.users.set(id, h);
          changed = true;
        }
      }
      const prev = this.users.get(id);
      // A "min" user carries only what the chat shows: keep the full one's details.
      if (!u.min || !prev) this.users.set(id, u);
      const name = displayName(u);
      if (this.state.names.get(id) !== name) {
        this.state.names.set(id, name);
        changed = true;
      }
      const f = identityOfUser(u.min && prev ? prev : u, self);
      if (f) this.sendIdentity(f);
      if (id === self && !u.min) this.self = u;
    }
    for (const c of chats) {
      const id = Number(c.id);
      this.chats.set(id, c);
      if (c._ === 'channel' && !c.min && c.accessHash) {
        const h = c.accessHash.toString();
        if (this.state.channels.get(id) !== h) {
          this.state.channels.set(id, h);
          changed = true;
        }
      }
      if (c._ === 'channel' && !c.min) {
        if (c.forum && !this.state.forums.has(id)) {
          this.state.forums.add(id);
          changed = true;
        } else if (!c.forum && this.state.forums.delete(id)) changed = true;
      }
      const f = identityOfChat(c);
      if (f) this.sendIdentity(f);
      // A chat we have a conversation for: its name or picture may have changed.
      if (self) {
        const peer: PeerRef = { kind: c._ === 'chat' || c._ === 'chatForbidden' || c._ === 'chatEmpty' ? 'chat' : 'channel', id };
        const conv = convId(self, peer);
        const known = this.convFacts.get(conv);
        if (known) {
          const left = c._ === 'chatForbidden' || c._ === 'channelForbidden' || ((c._ === 'channel' || c._ === 'chat') && c.left) || (c._ === 'chat' && c.deactivated);
          if (left) this.leave(conv);
          else {
            const next = conversationOf(this.ctx, peer, { chat: c });
            this.sendConversation({ ...known, ...pick(next, ['name', 'avatarUrl', 'variant']) });
          }
        }
      }
    }
    if (changed) this.state.save();
    if (relations) this.relationsSoon();
  }

  // ---------------------------------------------------------------- forums as spaces

  /** A forum supergroup (Telegram's own conversation id, `channel:<id>`), as the hub knows it: a space. */
  private isForumConv(conv: string): boolean {
    const ref = parseConv(conv);
    return !!ref && ref.peer.kind === 'channel' && !ref.topic && this.state.forums.has(ref.peer.id);
  }

  /**
   * A forum goes to the hub as Discord's servers and Matrix's spaces do (docs/telegram.md, "Forums as spaces"): the
   * forum is a community space with the same native id, each topic a channel in it, and the forum's own conversation
   * (which holds no messages: they all sit in topics) is left. What Telegram says of the forum as a whole goes to the
   * space; its reads are dropped, as they were (the topics carry their own).
   */
  private route(e: P.AdapterEvent): P.AdapterEvent[] {
    switch (e.t) {
      case 'conversation':
        return this.asServer(e.conversation);
      case 'leave':
        if (e.kind === 'conversation' && this.spacesSent.delete(e.nativeId)) return [{ t: 'leave', kind: 'space', nativeId: e.nativeId }];
        return [e];
      case 'read':
        return this.isForumConv(e.conversation) ? [] : [e];
      case 'pin':
      case 'typing':
        // Telegram's General topic holds what names no topic.
        return this.isForumConv(e.conversation) ? [{ ...e, conversation: `${e.conversation}/1` }] : [e];
      case 'role':
        return e.target.kind === 'conversation' && this.isForumConv(e.target.nativeId) ? [{ ...e, target: { kind: 'space', nativeId: e.target.nativeId } }] : [e];
      case 'request':
        return e.request.target?.kind === 'conversation' && this.isForumConv(e.request.target.nativeId) ? [{ ...e, request: { ...e.request, target: { ...e.request.target, kind: 'space' } } }] : [e];
      default:
        return [e];
    }
  }

  private asServer(f: P.ConversationFact): P.AdapterEvent[] {
    const ref = parseConv(f.nativeId);
    if (ref?.peer.kind !== 'channel') return [{ t: 'conversation', conversation: f }];
    if (!ref.topic && f.variant === 'forum') {
      const space: P.SpaceFact = { nativeId: f.nativeId, kind: 'community', name: f.name ?? 'Forum', ...(f.topic ? { topic: f.topic } : {}), ...(f.avatarUrl ? { iconUrl: f.avatarUrl } : {}), ...(f.mute ? { mute: f.mute } : {}) };
      const out: P.AdapterEvent[] = [{ t: 'space', space }];
      // Once a run: the hub drops the forum's old conversation (it never held a message).
      if (!this.spacesSent.has(f.nativeId)) out.push({ t: 'leave', kind: 'conversation', nativeId: f.nativeId });
      this.spacesSent.add(f.nativeId);
      return out;
    }
    if (!ref.topic) {
      // No longer a forum: the space goes, the group comes back.
      if (this.spacesSent.delete(f.nativeId)) return [{ t: 'leave', kind: 'space', nativeId: f.nativeId }, { t: 'conversation', conversation: f }];
      return [{ t: 'conversation', conversation: f }];
    }
    if (f.shape !== 'thread' || !this.state.forums.has(ref.peer.id)) return [{ t: 'conversation', conversation: f }];
    const { parentConversation, ...rest } = f;
    return [{ t: 'conversation', conversation: { ...rest, shape: 'channel', spaces: [{ nativeId: parentConversation ?? baseConv(f.nativeId), position: topicPosition(ref.topic, this.pinnedTopics.has(f.nativeId)) }] } }];
  }

  private sendIdentity(f: P.IdentityFact) {
    const key = JSON.stringify(f);
    if (this.sentIdentity.get(f.nativeId) === key) return;
    this.sentIdentity.set(f.nativeId, key);
    this.host.emit({ t: 'identity', identity: f });
  }

  private sendConversation(f: P.ConversationFact) {
    const prev = this.convFacts.get(f.nativeId);
    if (prev && JSON.stringify(prev) === JSON.stringify(f)) return;
    this.convFacts.set(f.nativeId, f);
    if (!f.nativeId.includes('/')) {
      if (!this.state.dialogs.has(f.nativeId)) {
        this.state.dialogs.add(f.nativeId);
        this.state.save();
      }
    }
    this.host.emit({ t: 'conversation', conversation: f });
  }

  private leave(conv: string) {
    // Its join requests are no longer this account's to answer.
    for (const [id, r] of this.joinRequests) if (r.target?.nativeId === conv) this.dropRequest(id);
    if (!this.convFacts.has(conv) && !this.state.dialogs.has(conv)) return;
    this.convFacts.delete(conv);
    for (const k of [...this.convFacts.keys()]) if (k.startsWith(`${conv}/`)) this.convFacts.delete(k);
    this.state.dialogs.delete(conv);
    this.state.save();
    this.host.emit({ t: 'leave', kind: 'conversation', nativeId: conv });
  }

  private inputPeer(p: PeerRef): tl.TypeInputPeer {
    if (p.kind === 'user') {
      if (p.id === this.selfId) return { _: 'inputPeerSelf' };
      const h = this.state.users.get(p.id);
      if (h === undefined) throw new Error(`Telegram has not shown this account user ${p.id} yet`);
      return { _: 'inputPeerUser', userId: p.id, accessHash: Long.fromString(h) };
    }
    if (p.kind === 'chat') return { _: 'inputPeerChat', chatId: p.id };
    const h = this.state.channels.get(p.id);
    if (h === undefined) throw new Error(`Telegram has not shown this account channel ${p.id} yet`);
    return { _: 'inputPeerChannel', channelId: p.id, accessHash: Long.fromString(h) };
  }

  private inputChannel(id: number): tl.TypeInputChannel {
    const h = this.state.channels.get(id);
    if (h === undefined) throw new Error(`Telegram has not shown this account channel ${id} yet`);
    return { _: 'inputChannel', channelId: id, accessHash: Long.fromString(h) };
  }

  private inputUser(id: number): tl.TypeInputUser {
    if (id === this.selfId) return { _: 'inputUserSelf' };
    const h = this.state.users.get(id);
    if (h === undefined) throw new Error(`Telegram has not shown this account user ${id} yet`);
    return { _: 'inputUser', userId: id, accessHash: Long.fromString(h) };
  }

  /** A conversation of this account, parsed. */
  private conv(conv: string): ConvRef {
    const ref = parseConv(conv);
    if (!ref) throw new Error(`not a Telegram conversation: ${conv}`);
    const owner = convOwner(conv);
    if (owner !== null && owner !== this.selfId) throw new Error('that conversation belongs to another Telegram account');
    return ref;
  }

  private message(native: string): { conv: string; ref: ConvRef; id: number } {
    const m = parseMsg(native);
    if (!m) throw new Error(`not a Telegram message: ${native}`);
    this.conv(m.conv);
    return m;
  }

  // ---------------------------------------------------------------- snapshot

  async snapshot() {
    if (this.snapshotting) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotting = true;
    try {
      do {
        this.snapshotAgain = false;
        await this.snapshotOnce();
      } while (this.snapshotAgain && this.phase === 'online');
      this.snapshotCount++;
    } finally {
      this.snapshotting = false;
    }
    // Contacts and blocks: the whole list after each snapshot that worked (none when a read fails).
    await this.refreshRelations(true);
    if (this.requestsAfterSnapshot && this.phase === 'online') {
      this.requestsAfterSnapshot = false;
      void this.listJoinRequests();
    }
  }

  private async snapshotOnce() {
    const self = this.selfId;
    const forums: number[] = [];
    const max = this.opts.maxDialogs ?? 2000;
    for (const folderId of [0, 1]) {
      let offsetDate = 0;
      let offsetId = 0;
      let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' };
      let seen = 0;
      for (;;) {
        const res = await this.call({ _: 'messages.getDialogs', folderId, offsetDate, offsetId, offsetPeer, limit: 100, hash: ZERO }, { background: true });
        if (res._ === 'messages.dialogsNotModified') break;
        this.ingest(res.users, res.chats);
        const tops = new Map<string, tl.TypeMessage>();
        for (const m of res.messages) if (m._ !== 'messageEmpty') tops.set(`${peerKeyOf(m.peerId)}#${m.id}`, m);
        let last: { date: number; id: number; peer: tl.TypePeer } | null = null;
        for (const d of res.dialogs) {
          if (d._ !== 'dialog') continue;
          const peer = peerOf(d.peer);
          const top = tops.get(`${peerKeyOf(d.peer)}#${d.topMessage}`);
          const info = peer.kind === 'user' ? { user: this.users.get(peer.id) } : { chat: this.chats.get(peer.id) };
          const f = conversationOf(this.ctx, peer, info, d, top && top._ !== 'messageEmpty' ? top.date : undefined);
          this.sendConversation(f);
          if (peer.kind === 'channel' && this.state.forums.has(peer.id)) forums.push(peer.id);
          if (top && top._ !== 'messageEmpty') {
            this.emitMessage(top, false);
            last = { date: top.date, id: top.id, peer: d.peer };
          }
          if (!(peer.kind === 'channel' && this.state.forums.has(peer.id))) this.emitRead(f.nativeId, d.readInboxMaxId, d.unreadCount, d.unreadMentionsCount, top);
          seen++;
        }
        if (res._ === 'messages.dialogs' || res.dialogs.length < 100 || !last || seen >= max) break;
        offsetDate = last.date;
        offsetId = last.id;
        try {
          offsetPeer = this.inputPeer(peerOf(last.peer));
        } catch {
          // A peer Telegram sent without a usable access hash: the date and id alone still page.
          offsetPeer = { _: 'inputPeerEmpty' };
        }
      }
    }
    for (const id of forums) await this.snapshotForum(id).catch((e) => this.host.log('warn', `forum ${id}: ${rpcText(e)}`));
    this.host.log('info', `snapshot: ${this.state.dialogs.size} chats, ${forums.length} forums (self ${self})`);
  }

  private async snapshotForum(channelId: number) {
    const peer = this.inputPeer({ kind: 'channel', id: channelId });
    let offsetDate = 0;
    let offsetId = 0;
    let offsetTopic = 0;
    for (let page = 0; page < 10; page++) {
      const res = await this.call({ _: 'messages.getForumTopics', peer, offsetDate, offsetId, offsetTopic, limit: 100 }, { background: true });
      this.ingest(res.users, res.chats);
      const tops = new Map<number, tl.TypeMessage>();
      for (const m of res.messages) if (m._ !== 'messageEmpty') tops.set(m.id, m);
      let lastTopic: tl.RawForumTopic | null = null;
      for (const t of res.topics) {
        if (t._ !== 'forumTopic') continue;
        const f = topicConversation(this.ctx, channelId, t);
        const top = tops.get(t.topMessage);
        if (top && top._ !== 'messageEmpty') f.lastMessageAt = top.date * 1000;
        this.topicTitles.set(f.nativeId, t.title);
        if (t.pinned) this.pinnedTopics.add(f.nativeId);
        else this.pinnedTopics.delete(f.nativeId);
        this.sendConversation(f);
        if (top) this.emitMessage(top, false);
        this.emitRead(f.nativeId, t.readInboxMaxId, t.unreadCount, t.unreadMentionsCount, top);
        lastTopic = t;
      }
      if (res.topics.length < 100 || !lastTopic) break;
      offsetTopic = lastTopic.id;
      offsetId = lastTopic.topMessage;
      offsetDate = tops.get(lastTopic.topMessage)?._ === 'message' ? (tops.get(lastTopic.topMessage) as tl.RawMessage).date : 0;
    }
  }

  private emitRead(conv: string, readMaxId: number, unread: number, mentions: number, top?: tl.TypeMessage) {
    let upToTs = 0;
    if (top && top._ !== 'messageEmpty' && top.id <= readMaxId) upToTs = top.date * 1000;
    else upToTs = this.recent.get(msgId(conv, readMaxId))?.ts ?? 0;
    if (!upToTs && unread === 0 && top && top._ !== 'messageEmpty') upToTs = top.date * 1000;
    this.host.emit({ t: 'read', conversation: conv, upToTs, unread, mentions });
  }

  // ---------------------------------------------------------------- messages

  /** A message fact out, and what it tells us remembered. Returns the fact. */
  private emitMessage(m: tl.TypeMessage, live: boolean): P.MessageFact | null {
    const f = messageFact(this.ctx, m);
    if (!f || m._ === 'messageEmpty') return null;
    if (live) this.newChat(m);
    this.remember(f, !!m.out);
    this.host.emit({ t: 'message', message: f, live });
    if (m._ === 'messageService') {
      const a = m.action;
      if (a._ === 'messageActionTopicCreate' || (a._ === 'messageActionTopicEdit' && a.title)) {
        const known = this.convFacts.get(f.conversation);
        const title = a.title!;
        this.topicTitles.set(f.conversation, title);
        const peer = peerOf(m.peerId);
        this.sendConversation({ ...(known ?? { nativeId: f.conversation, shape: 'thread', variant: 'text', parentConversation: convId(this.selfId, peer), encrypted: false }), name: title });
      }
      if (a._ === 'messageActionChatMigrateTo') this.snapshotSoon();
    }
    return f;
  }

  /**
   * A live message in a chat the account has not told the hub about (someone new writes; Telegram's login codes after
   * its chat was deleted): the chat's conversation first, as the snapshot would have sent it, so it does not arrive
   * as a conversation of unknown shape.
   */
  private newChat(m: tl.RawMessage | tl.RawMessageService) {
    const peer = peerOf(m.peerId);
    const conv = convId(this.selfId, peer);
    if (this.convFacts.has(conv) || this.state.dialogs.has(conv)) return;
    const chat = peer.kind === 'user' ? undefined : this.chats.get(peer.id);
    if (chat && (chat._ === 'chatForbidden' || chat._ === 'channelForbidden' || ((chat._ === 'chat' || chat._ === 'channel') && chat.left))) return;
    this.sendConversation(conversationOf(this.ctx, peer, peer.kind === 'user' ? { user: this.users.get(peer.id) } : { chat }, undefined, m.date));
  }

  private remember(f: P.MessageFact, own: boolean) {
    const id = parseMsg(f.nativeId)?.id;
    if (id !== undefined) this.state.rememberMessage(id, baseConv(f.nativeId.replace(/#\d+$/, '')), own);
    this.recent.delete(f.nativeId);
    this.recent.set(f.nativeId, f);
    if (this.recent.size > 3000) for (const k of [...this.recent.keys()].slice(0, 500)) this.recent.delete(k);
  }

  private snapshotSoon() {
    setTimeout(() => void this.snapshot().catch((e) => this.host.log('warn', `snapshot: ${rpcText(e)}`)), 2000);
  }

  // ---------------------------------------------------------------- updates

  private onUpdate(u: UpdateInfo) {
    this.lastUpdateAt = Date.now();
    try {
      this.ingest(u.users, u.chats);
      this.handleUpdate(u.update);
    } catch (e) {
      this.host.log('warn', `update ${u.update._}: ${(e as Error)?.stack ?? e}`);
    }
  }

  /** What a call answered with: its updates handled like any other (Telegram does not send them again). */
  private applyResult(res: tl.TypeUpdates, sent?: { peer: PeerRef; text: string; entities?: tl.TypeMessageEntity[]; replyTo?: tl.TypeMessageReplyHeader }): { ids: Map<string, number>; first?: string } {
    const ids = new Map<string, number>();
    let first: string | undefined;
    const take = (upd: tl.TypeUpdate) => {
      if (upd._ === 'updateMessageID') ids.set(upd.randomId.toString(), upd.id);
      const f = this.handleUpdate(upd);
      if (f && !first) first = f.nativeId;
    };
    switch (res._) {
      case 'updates':
      case 'updatesCombined':
        this.ingest(res.users, res.chats);
        for (const upd of res.updates) take(upd);
        break;
      case 'updateShort':
        take(res.update);
        break;
      case 'updateShortMessage':
      case 'updateShortChatMessage': {
        const peerId: tl.TypePeer = res._ === 'updateShortMessage' ? { _: 'peerUser', userId: res.userId } : { _: 'peerChat', chatId: res.chatId };
        const fromId: tl.TypePeer = { _: 'peerUser', userId: res._ === 'updateShortMessage' ? (res.out ? this.selfId : res.userId) : res.fromId };
        const m: tl.RawMessage = { _: 'message', id: res.id, out: res.out, mentioned: res.mentioned, silent: res.silent, peerId, fromId, date: res.date, message: res.message, entities: res.entities, replyTo: res.replyTo, fwdFrom: res.fwdFrom, ttlPeriod: res.ttlPeriod };
        take({ _: 'updateNewMessage', message: m, pts: res.pts, ptsCount: res.ptsCount });
        break;
      }
      case 'updateShortSentMessage': {
        if (!sent) break;
        const m: tl.RawMessage = {
          _: 'message',
          id: res.id,
          out: true,
          peerId: toPeer(sent.peer),
          fromId: { _: 'peerUser', userId: this.selfId },
          date: res.date,
          message: sent.text,
          entities: res.entities ?? sent.entities?.map(outputEntity),
          media: res.media,
          replyTo: sent.replyTo,
          ttlPeriod: res.ttlPeriod,
        };
        take({ _: 'updateNewMessage', message: m, pts: res.pts, ptsCount: res.ptsCount });
        break;
      }
      case 'updatesTooLong':
        break;
    }
    return { ids, first };
  }

  /** One update to events. Returns the message fact it made, if any. */
  private handleUpdate(upd: tl.TypeUpdate): P.MessageFact | null {
    const self = this.selfId;
    switch (upd._) {
      case 'updateNewMessage':
      case 'updateNewChannelMessage':
        return this.emitMessage(upd.message, true);
      case 'updateEditMessage':
      case 'updateEditChannelMessage': {
        const m = upd.message;
        if (m._ !== 'messageEmpty') {
          const f = messageFact(this.ctx, m);
          if (f) {
            this.remember(f, !!m.out);
            this.host.emit({ t: 'message', message: f, live: true });
            this.reactionNames.set(f.nativeId, namedReactions(this.ctx, m.reactions));
          }
          return f;
        }
        return null;
      }
      case 'updateDeleteMessages':
        for (const id of upd.messages) {
          const conv = this.state.msgConv.get(id);
          if (!conv) continue;
          this.state.msgConv.delete(id);
          this.host.emit({ t: 'delete', conversation: this.recent.get(msgId(conv, id))?.conversation ?? conv, nativeId: msgId(conv, id) });
        }
        return null;
      case 'updateDeleteChannelMessages': {
        const conv = convId(self, { kind: 'channel', id: Number(upd.channelId) });
        for (const id of upd.messages) this.host.emit({ t: 'delete', conversation: this.recent.get(msgId(conv, id))?.conversation ?? conv, nativeId: msgId(conv, id) });
        return null;
      }
      case 'updateMessageReactions':
        void this.reactionsChanged(peerOf(upd.peer), upd.msgId, upd.reactions, upd.topMsgId);
        return null;
      case 'updateReadHistoryInbox': {
        const peer = peerOf(upd.peer);
        const conv = convId(self, peer, upd.topMsgId);
        this.host.emit({ t: 'read', conversation: conv, upToTs: this.recent.get(msgId(conv, upd.maxId))?.ts ?? Date.now(), unread: upd.stillUnreadCount });
        return null;
      }
      case 'updateReadChannelInbox': {
        const conv = convId(self, { kind: 'channel', id: Number(upd.channelId) });
        this.host.emit({ t: 'read', conversation: conv, upToTs: this.recent.get(msgId(conv, upd.maxId))?.ts ?? Date.now(), unread: upd.stillUnreadCount });
        return null;
      }
      case 'updateReadChannelDiscussionInbox': {
        const conv = convId(self, { kind: 'channel', id: Number(upd.channelId) }, upd.topMsgId);
        this.host.emit({ t: 'read', conversation: conv, upToTs: this.recent.get(msgId(conv, upd.readMaxId))?.ts ?? Date.now() });
        return null;
      }
      case 'updateReadHistoryOutbox': {
        const peer = peerOf(upd.peer);
        const conv = convId(self, peer);
        const ids = this.state.readOutbox(conv, upd.maxId);
        // Telegram says who only in a private chat; in a group "read" means someone did.
        if (ids.length && peer.kind === 'user' && peer.id !== self) this.host.emit({ t: 'receipt', conversation: conv, messages: ids.map((id) => msgId(conv, id)), who: userId(peer.id), state: 'read', ts: Date.now() });
        return null;
      }
      case 'updateReadChannelOutbox':
        this.state.readOutbox(convId(self, { kind: 'channel', id: Number(upd.channelId) }), upd.maxId);
        return null;
      case 'updateUserTyping':
        this.typing(convId(self, { kind: 'user', id: Number(upd.userId) }, upd.topMsgId), userId(Number(upd.userId)), upd.action);
        return null;
      case 'updateChatUserTyping':
        this.typing(convId(self, { kind: 'chat', id: Number(upd.chatId) }), authorOf(peerOf(upd.fromId)), upd.action);
        return null;
      case 'updateChannelUserTyping': {
        const ch = Number(upd.channelId);
        const topic = this.state.forums.has(ch) ? (upd.topMsgId ?? 1) : undefined;
        this.typing(convId(self, { kind: 'channel', id: ch }, topic), authorOf(peerOf(upd.fromId)), upd.action);
        return null;
      }
      case 'updatePinnedMessages': {
        const conv = convId(self, peerOf(upd.peer));
        for (const id of upd.messages) this.host.emit({ t: 'pin', conversation: this.recent.get(msgId(conv, id))?.conversation ?? conv, message: msgId(conv, id), pinned: !!upd.pinned });
        return null;
      }
      case 'updatePinnedChannelMessages': {
        const conv = convId(self, { kind: 'channel', id: Number(upd.channelId) });
        for (const id of upd.messages) this.host.emit({ t: 'pin', conversation: this.recent.get(msgId(conv, id))?.conversation ?? conv, message: msgId(conv, id), pinned: !!upd.pinned });
        return null;
      }
      case 'updateUserName': {
        const id = Number(upd.userId);
        const prev = this.users.get(id);
        if (prev) this.ingest([{ ...prev, firstName: upd.firstName, lastName: upd.lastName, usernames: upd.usernames, username: upd.usernames.find((x) => x.active)?.username }], []);
        return null;
      }
      case 'updateUser':
        if (this.state.users.has(Number(upd.userId))) void this.refreshUser(Number(upd.userId));
        return null;
      case 'updateChat':
      case 'updateChannel': {
        const peer: PeerRef = upd._ === 'updateChat' ? { kind: 'chat', id: Number(upd.chatId) } : { kind: 'channel', id: Number(upd.channelId) };
        void this.refreshDialog(peer);
        return null;
      }
      case 'updateChannelTooLong':
        void this.catchUpChannel(Number(upd.channelId));
        return null;
      case 'updatePendingJoinRequests':
        void this.chatJoinRequests(peerOf(upd.peer), upd.requestsPending);
        return null;
      case 'updatePeerBlocked':
        // The story blocklist (blockedMyStoriesFrom) is another list; blocked chats and channels are not people.
        if (upd.peerId._ === 'peerUser' && !upd.blockedMyStoriesFrom) this.peerBlocked(Number(upd.peerId.userId), !!upd.blocked);
        return null;
      case 'updateContactsReset':
        this.relationsSoon();
        return null;
      case 'updateNotifySettings': {
        if (upd.peer._ !== 'notifyPeer') return null;
        const conv = convId(self, peerOf(upd.peer.peer));
        const known = this.convFacts.get(conv);
        if (known) this.sendConversation({ ...known, mute: muteOf(upd.notifySettings) });
        return null;
      }
      case 'updateFolderPeers':
        for (const fp of upd.folderPeers) {
          const conv = convId(self, peerOf(fp.peer));
          const known = this.convFacts.get(conv);
          if (known) this.sendConversation({ ...known, archived: fp.folderId === 1 });
        }
        return null;
      case 'updateChatParticipantAdmin':
        this.host.emit({ t: 'role', target: { kind: 'conversation', nativeId: convId(self, { kind: 'chat', id: Number(upd.chatId) }) }, member: userId(Number(upd.userId)), role: 'Admin', given: upd.isAdmin });
        return null;
      case 'updateChannelParticipant': {
        const conv = convId(self, { kind: 'channel', id: Number(upd.channelId) });
        const was = adminRole(upd.prevParticipant);
        const now = adminRole(upd.newParticipant);
        const member = userId(Number(upd.userId));
        if (was !== now) {
          if (was) this.host.emit({ t: 'role', target: { kind: 'conversation', nativeId: conv }, member, role: was, given: false, by: authorOf({ kind: 'user', id: Number(upd.actorId) }), ts: upd.date * 1000 });
          if (now) this.host.emit({ t: 'role', target: { kind: 'conversation', nativeId: conv }, member, role: now, given: true, by: authorOf({ kind: 'user', id: Number(upd.actorId) }), ts: upd.date * 1000 });
        }
        const gone = !upd.newParticipant || upd.newParticipant._ === 'channelParticipantLeft' || upd.newParticipant._ === 'channelParticipantBanned';
        if (Number(upd.userId) === self && gone) this.leave(conv);
        return null;
      }
      default:
        return null;
    }
  }

  private typing(conv: string, author: string, action: tl.TypeSendMessageAction) {
    if (author === userId(this.selfId)) return;
    const stop = action._ === 'sendMessageCancelAction';
    if (!stop && action._ !== 'sendMessageTypingAction' && !action._.startsWith('sendMessageRecord') && !action._.startsWith('sendMessageUpload') && action._ !== 'sendMessageChooseStickerAction') return;
    const id = Number(author);
    const name = Number.isFinite(id) ? this.state.names.get(id) : undefined;
    this.host.emit({ t: 'typing', conversation: conv, author, ...(stop ? { stop: true } : { ttl: TYPING_TTL }), ...(name ? { name } : {}) });
  }

  /**
   * Telegram sends a message's reactions whole. Who changed, as far as it names people, goes out as reaction events
   * (they may notify); the whole snapshot goes out on the message again, without notifying.
   */
  private async reactionsChanged(peer: PeerRef, id: number, reactions: tl.TypeMessageReactions, topMsgId?: number) {
    const base = convId(this.selfId, peer);
    const native = msgId(base, id);
    let fact = this.recent.get(native);
    const conv = fact?.conversation ?? (topMsgId ? convId(this.selfId, peer, topMsgId) : peer.kind === 'channel' && this.state.forums.has(peer.id) ? convId(this.selfId, peer, 1) : base);
    const before = this.reactionNames.get(native);
    const after = namedReactions(this.ctx, reactions);
    this.reactionNames.set(native, after);
    if (before) {
      for (const k of after) if (!before.has(k)) this.reactionEvent(conv, native, k, false);
      for (const k of before) if (!after.has(k)) this.reactionEvent(conv, native, k, true);
    } else if (fact) {
      const had = new Set((fact.reactions ?? []).flatMap((r) => r.authors.map((a) => `${a}\n${r.key}`)));
      for (const k of after) if (!had.has(k)) this.reactionEvent(conv, native, k, false);
      for (const k of had) if (!after.has(k)) this.reactionEvent(conv, native, k, true);
    }
    if (!fact) {
      const got = await this.fetchMessages(peer, [id]).catch(() => []);
      const m = got[0];
      if (!m || m._ === 'messageEmpty') return;
      fact = messageFact(this.ctx, { ...m, reactions } as tl.TypeMessage) ?? undefined;
      if (!fact) return;
      // Nothing to diff against: the people Telegram names now are the change.
      if (!before) for (const k of after) this.reactionEvent(fact.conversation, native, k, false);
    } else {
      const snapshot = reactionsOf(this.ctx, reactions);
      fact = { ...fact, ...(snapshot.length ? { reactions: snapshot } : {}) };
      if (!snapshot.length) delete fact.reactions;
    }
    this.recent.set(native, fact);
    this.host.emit({ t: 'message', message: fact, live: false });
  }

  private reactionEvent(conv: string, message: string, k: string, remove: boolean) {
    const [author, key] = k.split('\n');
    const id = parseCustomKey(key);
    this.host.emit({ t: 'reaction', conversation: conv, message, author, key, ...(remove ? { remove: true } : {}), ...(id ? { emoji: { key, name: 'custom', url: emojiUrl(id) } } : {}) });
  }

  private async refreshUser(id: number) {
    const [u] = await this.call({ _: 'users.getUsers', id: [this.inputUser(id)] }, { background: true });
    if (u) this.ingest([u], []);
  }

  /**
   * A chat's conversation again, from its dialog. joined: the account has just joined it (add): its last message and
   * read state too, as the snapshot sends them, and a dialog Telegram does not list yet is not taken for leaving.
   */
  private async refreshDialog(peer: PeerRef, joined = false) {
    try {
      const res = await this.call({ _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer: this.inputPeer(peer) }] }, { background: !joined });
      this.ingest(res.users, res.chats);
      const d = res.dialogs.find((x): x is tl.RawDialog => x._ === 'dialog');
      const conv = convId(this.selfId, peer);
      if (!d) return joined ? undefined : this.leave(conv);
      const top = res.messages.find((m) => m.id === d.topMessage);
      const f = conversationOf(this.ctx, peer, peer.kind === 'user' ? { user: this.users.get(peer.id) } : { chat: this.chats.get(peer.id) }, d, top && top._ !== 'messageEmpty' ? top.date : undefined);
      this.sendConversation(f);
      const forum = peer.kind === 'channel' && this.state.forums.has(peer.id);
      if (joined && top && top._ !== 'messageEmpty') {
        this.emitMessage(top, false);
        if (!forum) this.emitRead(f.nativeId, d.readInboxMaxId, d.unreadCount, d.unreadMentionsCount, top);
      }
      if (forum) await this.snapshotForum(peer.id);
    } catch (e) {
      const t = rpcText(e);
      if (!joined && /CHANNEL_PRIVATE|CHAT_FORBIDDEN|CHANNEL_INVALID|PEER_ID_INVALID/.test(t)) this.leave(convId(this.selfId, peer));
      else this.host.log('warn', `refresh ${peer.kind} ${peer.id}: ${t}`);
    }
  }

  private async catchUpChannel(channelId: number) {
    const conv = convId(this.selfId, { kind: 'channel', id: channelId });
    const res = await this.call({ _: 'messages.getHistory', peer: this.inputPeer({ kind: 'channel', id: channelId }), offsetId: 0, offsetDate: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: ZERO }, { background: true }).catch(() => null);
    if (!res || res._ === 'messages.messagesNotModified') return;
    this.ingest(res.users, res.chats);
    for (const m of [...res.messages].reverse()) this.emitMessage(m, !this.recent.has(msgId(conv, m.id)));
  }

  private async fetchMessages(peer: PeerRef, ids: number[]): Promise<tl.TypeMessage[]> {
    const id: tl.TypeInputMessage[] = ids.map((x) => ({ _: 'inputMessageID', id: x }));
    const res = peer.kind === 'channel' ? await this.call({ _: 'channels.getMessages', channel: this.inputChannel(peer.id), id }) : await this.call({ _: 'messages.getMessages', id });
    if (res._ === 'messages.messagesNotModified') return [];
    this.ingest(res.users, res.chats);
    return res.messages;
  }

  // ---------------------------------------------------------------- commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    if (cmd.t === 'action') return this.action(cmd.action, cmd.args);
    // What Telegram Desktop hands out (notifications, links, downloads), served whether or not the chat is signed in.
    const t = (cmd as { t: string }).t;
    if (t.startsWith('notify.') || t.startsWith('desktop.')) {
      const routed = this.opts.desktop?.session.command(cmd as unknown as { t: string });
      if (routed) return routed;
      if (t === 'notify.list') return { notifications: [], next: null };
      throw new Error('This account has no Telegram Desktop (it signs in by QR code)');
    }
    if (cmd.t === 'shutdown' || cmd.t === 'lab') return undefined;
    if (this.phase !== 'online') throw new Error(this.phase === 'config' ? 'This account needs both api_id and api_hash, or neither' : 'Telegram is not signed in yet');
    switch (cmd.t) {
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments);
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'redact':
        return this.redact(cmd.message);
      case 'react':
        return this.react(cmd.message, cmd.key, !!cmd.remove, cmd.style === 'super');
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors':
        return this.reactors(cmd.message, cmd.key);
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'typing':
        return this.sendTyping(cmd.conversation, !!cmd.stop);
      case 'history':
        return this.history(cmd.conversation, cmd.beforeTs, cmd.limit);
      case 'search':
        return this.search(cmd);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'openDirect':
        return this.openDirect(cmd.peer);
      case 'forward':
        return this.forward(cmd.conversation, cmd.source, cmd.note);
      case 'about':
        return this.about(cmd.target);
      case 'configure':
        return this.configure(cmd.target, cmd.change);
      case 'profile':
        return this.profile(cmd.who);
      case 'resolve':
        return this.resolve(cmd.ref);
      case 'add':
        return this.add(cmd.ref, cmd.action);
      case 'answer':
        return this.answer(cmd.request, cmd.answer);
      case 'remove':
        return this.remove(cmd.identity, cmd.relationship);
      case 'addMembers':
        return this.addMembers(cmd.target, cmd.people);
      case 'createGroup':
        return this.createGroup(cmd.name, cmd.people);
      case 'call':
        throw new Error('Telegram calls are not supported');
    }
  }

  private entities(out: OutEntity[]): tl.TypeMessageEntity[] {
    const res: tl.TypeMessageEntity[] = [];
    for (const e of out) {
      const at = { offset: e.offset, length: e.length };
      switch (e.type) {
        case 'bold':
          res.push({ _: 'messageEntityBold', ...at });
          break;
        case 'italic':
          res.push({ _: 'messageEntityItalic', ...at });
          break;
        case 'underline':
          res.push({ _: 'messageEntityUnderline', ...at });
          break;
        case 'strike':
          res.push({ _: 'messageEntityStrike', ...at });
          break;
        case 'spoiler':
          res.push({ _: 'messageEntitySpoiler', ...at });
          break;
        case 'code':
          res.push({ _: 'messageEntityCode', ...at });
          break;
        case 'pre':
          res.push({ _: 'messageEntityPre', ...at, language: e.language ?? '' });
          break;
        case 'textUrl':
          res.push({ _: 'messageEntityTextUrl', ...at, url: e.url! });
          break;
        case 'blockquote':
          res.push({ _: 'messageEntityBlockquote', ...at });
          break;
        case 'mentionName':
          try {
            res.push({ _: 'inputMessageEntityMentionName', ...at, userId: this.inputUser(Number(e.userId)) });
          } catch {
            // Someone this account cannot address: their name stays as plain text.
          }
          break;
      }
    }
    return res;
  }

  private text(body: string) {
    const t = toTelegram(body, (id) => this.state.names.get(Number(id)));
    return { text: t.text, entities: this.entities(t.entities) };
  }

  private replyTo(ref: ConvRef, replyTo?: string): tl.TypeInputReplyTo | undefined {
    const topic = ref.topic && ref.topic !== 1 ? ref.topic : undefined;
    if (replyTo) {
      const r = parseMsg(replyTo);
      if (r) {
        const samePeer = baseConv(r.conv) === convId(this.selfId, ref.peer);
        return { _: 'inputReplyToMessage', replyToMsgId: r.id, ...(topic ? { topMsgId: topic } : {}), ...(samePeer ? {} : { replyToPeerId: this.inputPeer(r.ref.peer) }) };
      }
    }
    return topic ? { _: 'inputReplyToMessage', replyToMsgId: topic, topMsgId: topic } : undefined;
  }

  private async send(conversation: string, body: string, replyTo: string | undefined, attachments: P.OutgoingAttachment[] | undefined): Promise<{ nativeId?: string }> {
    const ref = this.conv(conversation);
    if (ref.peer.kind === 'channel' && this.state.forums.has(ref.peer.id) && !ref.topic) throw new Error('Pick a topic of this forum to write in');
    const peer = this.inputPeer(ref.peer);
    const { text, entities } = this.text(body);
    const reply = this.replyTo(ref, replyTo);
    const chat = baseConv(conversation);
    const header: tl.TypeMessageReplyHeader | undefined = reply?._ === 'inputReplyToMessage' ? { _: 'messageReplyHeader', replyToMsgId: reply.replyToMsgId, ...(reply.topMsgId ? { replyToTopId: reply.topMsgId, forumTopic: true } : {}) } : undefined;
    const files = attachments ?? [];
    if (!files.length) {
      if (!text.trim()) throw new Error('Nothing to send');
      const randomId = rand();
      const res = await this.call({ _: 'messages.sendMessage', peer, message: text, randomId, ...(entities.length ? { entities } : {}), ...(reply ? { replyTo: reply } : {}) }, { chat });
      const r = this.applyResult(res, { peer: ref.peer, text, entities, replyTo: header });
      const id = r.ids.get(randomId.toString());
      return { nativeId: id ? msgId(chat, id) : r.first };
    }
    if (files.length === 1) {
      const media = await this.uploadMedia(files[0]);
      const randomId = rand();
      const res = await this.call({ _: 'messages.sendMedia', peer, media, message: text, randomId, ...(entities.length ? { entities } : {}), ...(reply ? { replyTo: reply } : {}) }, { chat });
      const r = this.applyResult(res, { peer: ref.peer, text, entities, replyTo: header });
      const id = r.ids.get(randomId.toString());
      return { nativeId: id ? msgId(chat, id) : r.first };
    }
    // Several files: an album, as Telegram's apps send them (the text goes with the first).
    const multi: tl.TypeInputSingleMedia[] = [];
    for (const [i, f] of files.slice(0, 10).entries()) {
      const uploaded = await this.uploadMedia(f);
      const got = await this.call({ _: 'messages.uploadMedia', peer, media: uploaded }, { chat });
      const media: tl.TypeInputMedia | null =
        got._ === 'messageMediaPhoto' && got.photo?._ === 'photo'
          ? { _: 'inputMediaPhoto', id: { _: 'inputPhoto', id: got.photo.id, accessHash: got.photo.accessHash, fileReference: got.photo.fileReference } }
          : got._ === 'messageMediaDocument' && got.document?._ === 'document'
            ? { _: 'inputMediaDocument', id: { _: 'inputDocument', id: got.document.id, accessHash: got.document.accessHash, fileReference: got.document.fileReference } }
            : null;
      if (!media) throw new Error(`Telegram did not take ${f.name}`);
      multi.push({ _: 'inputSingleMedia', media, randomId: rand(), message: i === 0 ? text : '', ...(i === 0 && entities.length ? { entities } : {}) });
    }
    const res = await this.call({ _: 'messages.sendMultiMedia', peer, multiMedia: multi, ...(reply ? { replyTo: reply } : {}) }, { chat });
    const r = this.applyResult(res);
    const id = r.ids.get(multi[0].randomId.toString());
    return { nativeId: id ? msgId(chat, id) : r.first };
  }

  private async uploadMedia(f: P.OutgoingAttachment): Promise<tl.TypeInputMedia> {
    if (!this.backend) throw new Error('Telegram is not signed in');
    const backend = this.backend;
    const file = await this.pacer.run('upload.saveFilePart', () => backend.uploadFile({ path: f.path, name: f.name, mime: f.mime, size: f.size }));
    if (f.kind === 'image' && PHOTO_MIMES.has(f.mime) && f.size <= 10 * 1024 * 1024) return { _: 'inputMediaUploadedPhoto', file };
    const attributes: tl.TypeDocumentAttribute[] = [{ _: 'documentAttributeFilename', fileName: f.name }];
    if (f.kind === 'video') attributes.push({ _: 'documentAttributeVideo', duration: 0, w: 0, h: 0, supportsStreaming: true });
    if (f.kind === 'audio') attributes.push({ _: 'documentAttributeAudio', duration: 0 });
    return { _: 'inputMediaUploadedDocument', file, mimeType: f.mime || 'application/octet-stream', attributes, ...(f.kind === 'file' ? { forceFile: true } : {}) };
  }

  private async edit(conversation: string, message: string, body: string) {
    const m = this.message(message);
    const { text, entities } = this.text(body);
    const res = await this.call({ _: 'messages.editMessage', peer: this.inputPeer(m.ref.peer), id: m.id, message: text, entities }, { chat: baseConv(conversation) });
    this.applyResult(res);
    return {};
  }

  private async redact(message: string) {
    const m = this.message(message);
    if (m.ref.peer.kind === 'channel') await this.call({ _: 'channels.deleteMessages', channel: this.inputChannel(m.ref.peer.id), id: [m.id] });
    else await this.call({ _: 'messages.deleteMessages', id: [m.id], revoke: true });
    const fact = this.recent.get(message);
    this.host.emit({ t: 'delete', conversation: fact?.conversation ?? m.conv, nativeId: message });
    return {};
  }

  private reaction(key: string): tl.TypeReaction {
    const custom = parseCustomKey(key);
    if (custom) return { _: 'reactionCustomEmoji', documentId: Long.fromString(custom) };
    return { _: 'reactionEmoji', emoticon: key };
  }

  private async react(message: string, key: string, remove: boolean, big: boolean) {
    const m = this.message(message);
    // One reaction each (REACTION_RULES: exclusive): a new one replaces yours, removing it leaves none.
    const mine = (this.recent.get(message)?.reactions ?? []).filter((r) => r.authors.includes(userId(this.selfId))).map((r) => r.key);
    const premium = !!this.self?.premium;
    let keys: string[] = remove ? mine.filter((k) => k !== key) : premium ? [...new Set([...mine, key])].slice(-3) : [key];
    if (!premium && remove) keys = [];
    const res = await this.call({ _: 'messages.sendReaction', peer: this.inputPeer(m.ref.peer), msgId: m.id, reaction: keys.map((k) => this.reaction(k)), ...(big ? { big: true } : {}) });
    this.applyResult(res);
    return {};
  }

  private async reactionContext(conversation: string): Promise<P.ReactionContext> {
    const ref = this.conv(conversation);
    if (ref.peer.kind === 'user') return { canReact: true, custom: [] };
    const full = ref.peer.kind === 'chat' ? await this.call({ _: 'messages.getFullChat', chatId: ref.peer.id }) : await this.call({ _: 'channels.getFullChannel', channel: this.inputChannel(ref.peer.id) });
    this.ingest(full.users, full.chats);
    const ff = full.fullChat;
    const r = ff._ === 'chatFull' || ff._ === 'channelFull' ? ff.availableReactions : undefined;
    if (!r || r._ === 'chatReactionsNone') return { canReact: false, reason: 'Reactions are off in this chat', custom: [] };
    if (r._ === 'chatReactionsSome') {
      const keys = r.reactions.map((x: tl.TypeReaction) => (x._ === 'reactionEmoji' ? x.emoticon : null)).filter(Boolean);
      return { canReact: true, reason: `Only ${keys.join(' ')} here`, custom: [] };
    }
    return { canReact: true, custom: [] };
  }

  private async reactors(message: string, key: string): Promise<{ authors: string[] }> {
    const m = this.message(message);
    try {
      const res = await this.call({ _: 'messages.getMessageReactionsList', peer: this.inputPeer(m.ref.peer), id: m.id, reaction: this.reaction(key), limit: 100 });
      this.ingest(res.users, res.chats);
      return { authors: res.reactions.map((r) => authorOf(peerOf(r.peerId))) };
    } catch (e) {
      // Broadcast channels do not say who reacted.
      const known = this.recent.get(message)?.reactions?.find((r) => r.key === key)?.authors ?? [];
      if (known.length) return { authors: known };
      throw e;
    }
  }

  private async markRead(conversation: string, upTo: string) {
    const ref = this.conv(conversation);
    const m = parseMsg(upTo);
    if (!m) throw new Error(`not a Telegram message: ${upTo}`);
    if (ref.topic) await this.call({ _: 'messages.readDiscussion', peer: this.inputPeer(ref.peer), msgId: ref.topic, readMaxId: m.id });
    else if (ref.peer.kind === 'channel') await this.call({ _: 'channels.readHistory', channel: this.inputChannel(ref.peer.id), maxId: m.id });
    else await this.call({ _: 'messages.readHistory', peer: this.inputPeer(ref.peer), maxId: m.id });
    return {};
  }

  /** Telegram's apps say "typing" again every 5 s while it lasts; once per 4.5 s at most from here. */
  private async sendTyping(conversation: string, stop: boolean) {
    const ref = this.conv(conversation);
    const last = this.typingSent.get(conversation) ?? 0;
    if (!stop && Date.now() - last < 4500) return {};
    if (stop && !last) return {};
    this.typingSent.set(conversation, stop ? 0 : Date.now());
    await this.call({ _: 'messages.setTyping', peer: this.inputPeer(ref.peer), action: { _: stop ? 'sendMessageCancelAction' : 'sendMessageTypingAction' }, ...(ref.topic && ref.topic !== 1 ? { topMsgId: ref.topic } : {}) });
    return {};
  }

  private async history(conversation: string, beforeTs: number | undefined, limit: number): Promise<{ count: number; done: boolean }> {
    const ref = this.conv(conversation);
    const peer = this.inputPeer(ref.peer);
    let offsetDate = beforeTs ? Math.floor(beforeTs / 1000) : 0;
    let offsetId = 0;
    let count = 0;
    let done = false;
    const want = Math.max(1, Math.min(limit || 50, 1000));
    while (count < want) {
      const page = Math.min(100, want - count);
      const res = ref.topic
        ? await this.call({ _: 'messages.getReplies', peer, msgId: ref.topic, offsetId, offsetDate, addOffset: 0, limit: page, maxId: 0, minId: 0, hash: ZERO })
        : await this.call({ _: 'messages.getHistory', peer, offsetId, offsetDate, addOffset: 0, limit: page, maxId: 0, minId: 0, hash: ZERO });
      if (res._ === 'messages.messagesNotModified') break;
      this.ingest(res.users, res.chats);
      const msgs = res.messages.filter((x) => x._ !== 'messageEmpty');
      for (const x of msgs) this.emitMessage(x, false);
      count += msgs.length;
      if (msgs.length < page) {
        done = true;
        break;
      }
      const oldest = msgs[msgs.length - 1];
      offsetId = oldest.id;
      offsetDate = 0;
    }
    return { count, done };
  }

  /** The hub's network search (search.ts): the hits' message facts first (live=false), then their ids. */
  private async search(cmd: SearchCommand): Promise<P.NetworkSearchResult> {
    const q = cmd.query;
    const limit = Math.max(1, Math.min(SEARCH_PAGE, Math.floor(cmd.limit ?? SEARCH_PAGE) || SEARCH_PAGE));
    const self = userId(this.selfId);
    const mentions = q.mentions ?? [];
    if (mentions.some((m) => m !== self)) throw new Error('Telegram searches for mentions of you only');
    const filter = searchFilter(q.has, mentions.length > 0);
    const words = searchWords(q.text);
    const { minDate, maxDate } = searchDates(q);
    const chats = cmd.scope.kind === 'all' ? (q.in?.length ? q.in : null) : [cmd.scope.id];
    // People as Telegram peers; one Telegram has not shown this account cannot be asked for.
    const authors = (q.authors ?? []).map((a): PeerRef => (a.startsWith('channel:') ? { kind: 'channel', id: Number(a.slice(8)) } : { kind: 'user', id: Number(a) }));
    const from = authors.flatMap((a) => {
      try {
        return [this.inputPeer(a)];
      } catch {
        return [];
      }
    });
    if (authors.length && !from.length) throw new Error('Telegram has not shown this account the people named in from:');
    if (!words && filter._ === 'inputMessagesFilterEmpty' && !from.length) throw new Error('Telegram needs words or a filter to search');
    const got: tl.TypeMessage[] = [];
    let total: number | null = 0;
    const take = (res: tl.messages.TypeMessages) => {
      if (res._ === 'messages.messagesNotModified') return;
      this.ingest(res.users, res.chats);
      got.push(...res.messages);
      total = total === null || res._ === 'messages.messages' ? null : total + res.count;
    };
    const asks: (() => Promise<void>)[] = [];
    const inChat = (peer: tl.TypeInputPeer, topic: number | undefined, fromId: tl.TypeInputPeer | undefined) => () =>
      this.call({ _: 'messages.search', peer, q: words, ...(fromId ? { fromId } : {}), ...(topic ? { topMsgId: topic } : {}), filter, minDate, maxDate, offsetId: 0, addOffset: 0, limit, maxId: 0, minId: 0, hash: Long.ZERO }).then(take);
    const global = () => this.call({ _: 'messages.searchGlobal', q: words, filter, minDate, maxDate, offsetRate: 0, offsetPeer: { _: 'inputPeerEmpty' }, offsetId: 0, limit }).then(take);
    const people = from.length ? from : [undefined];
    if (chats) {
      for (const c of chats) {
        // Another account's chat (the hub names this network's): not this one's to search.
        const owner = convOwner(c);
        if (owner !== null && owner !== this.selfId) continue;
        const ref = this.conv(c);
        const peer = this.inputPeer(ref.peer);
        for (const f of people) asks.push(inChat(peer, ref.topic && ref.topic !== 1 ? ref.topic : undefined, f));
      }
    } else if (from.length || filter._ === 'inputMessagesFilterMyMentions') {
      // No chat named: every private chat and basic group at once, and with words, the global search for the rest.
      for (const f of people) asks.push(inChat({ _: 'inputPeerEmpty' }, undefined, f));
      if (words && filter._ !== 'inputMessagesFilterMyMentions') asks.push(global);
    } else {
      asks.push(global);
    }
    if (asks.length > SEARCH_REQUESTS) throw new Error(`Telegram searches at most ${SEARCH_REQUESTS} chats and people at once; name fewer`);
    for (const ask of asks) await ask();
    if (asks.length > 1) total = null;
    const wanted = new Set(q.authors ?? []);
    const seen = new Set<string>();
    const facts: P.MessageFact[] = [];
    for (const m of got) {
      if (m._ === 'messageEmpty') continue;
      const f = this.emitMessage(m, false);
      if (!f || seen.has(f.nativeId) || !inDates(q, f.ts)) continue;
      // The global search knows no author: its hits are held to the people named.
      if (wanted.size && !wanted.has(f.author)) continue;
      seen.add(f.nativeId);
      facts.push(f);
    }
    facts.sort((a, b) => (q.sort === 'oldest' ? a.ts - b.ts : b.ts - a.ts));
    return { hits: facts.slice(0, limit).map((f) => f.nativeId), total, next: null };
  }

  private async fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
    if (!this.backend) throw new Error('Telegram is not signed in');
    const backend = this.backend;
    const media = parseMediaUrl(url);
    if (media) {
      const ref = this.conv(media.conv);
      const [m] = await this.fetchMessages(ref.peer, [media.id]);
      if (!m || m._ !== 'message' || !m.media) throw new Error('That message or its file is gone');
      const loc = locationOf(m.media);
      if (!loc) throw new Error('That message has no file');
      if (loc.size > MEDIA_MAX) throw new Error(`The file is ${Math.round(loc.size / 1048576)} MB; fetchMedia stops at ${MEDIA_MAX / 1048576} MB`);
      const bytes = await this.pacer.run('upload.getFile', () => backend.download(loc.location, { dcId: loc.dcId, size: loc.size }));
      return { mime: loc.mime, base64: Buffer.from(bytes).toString('base64') };
    }
    const av = parseAvatarUrl(url);
    if (av) {
      const location: tl.TypeInputFileLocation = { _: 'inputPeerPhotoFileLocation', peer: this.inputPeer(av.peer), photoId: Long.fromString(av.photoId), big: false };
      const bytes = await this.pacer.run('upload.getFile', () => backend.download(location, { ...(av.dc ? { dcId: av.dc } : {}) }));
      return { mime: 'image/jpeg', base64: Buffer.from(bytes).toString('base64') };
    }
    const invite = parseInviteAvatarUrl(url);
    if (invite) {
      // A chat seen only through its invite link: the link is looked up again (that acts on nothing) for the
      // picture's current file reference; once joined, the chat's own picture.
      const inv = await this.call({ _: 'messages.checkChatInvite', hash: invite.hash }, { maxWaitMs: 10_000 });
      if (inv._ !== 'chatInvite') {
        this.ingest([], [inv.chat]);
        const c = inv.chat;
        if ((c._ !== 'chat' && c._ !== 'channel') || c.photo._ !== 'chatPhoto') throw new Error('That chat has no picture now');
        const location: tl.TypeInputFileLocation = { _: 'inputPeerPhotoFileLocation', peer: this.inputPeer({ kind: c._ === 'chat' ? 'chat' : 'channel', id: Number(c.id) }), photoId: c.photo.photoId, big: false };
        const bytes = await this.pacer.run('upload.getFile', () => backend.download(location, { dcId: (c.photo as tl.RawChatPhoto).dcId }));
        return { mime: 'image/jpeg', base64: Buffer.from(bytes).toString('base64') };
      }
      const photo = inv.photo;
      if (photo._ !== 'photo') throw new Error('That invite has no picture now');
      const size = largestPhotoSize(photo.sizes);
      if (!size) throw new Error('That invite has no picture now');
      const location: tl.TypeInputFileLocation = { _: 'inputPhotoFileLocation', id: photo.id, accessHash: photo.accessHash, fileReference: photo.fileReference, thumbSize: size.type };
      const bytes = await this.pacer.run('upload.getFile', () => backend.download(location, { dcId: photo.dcId, size: size.size }));
      return { mime: 'image/jpeg', base64: Buffer.from(bytes).toString('base64') };
    }
    const emoji = parseEmojiUrl(url);
    if (emoji) {
      const [d] = await this.call({ _: 'messages.getCustomEmojiDocuments', documentId: [Long.fromString(emoji)] });
      if (d?._ !== 'document') throw new Error('No such custom emoji');
      const bytes = await this.pacer.run('upload.getFile', () => backend.download({ _: 'inputDocumentFileLocation', id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, thumbSize: '' }, { dcId: d.dcId, size: Number(d.size) }));
      return { mime: d.mimeType, base64: Buffer.from(bytes).toString('base64') };
    }
    throw new Error(`not a Telegram media URL: ${url}`);
  }

  private async openDirect(input: string): Promise<P.OpenDirectResult> {
    const s = input.trim();
    let user: tl.TypeUser | undefined;
    if (/^\d{1,20}$/.test(s)) {
      if (!this.state.users.has(Number(s)) && Number(s) !== this.selfId) throw new Error('Telegram has not shown this account that user: use their @username or phone number');
      [user] = await this.call({ _: 'users.getUsers', id: [this.inputUser(Number(s))] });
    } else if (/^@?[A-Za-z][\w]{3,31}$/.test(s)) {
      const res = await this.call({ _: 'contacts.resolveUsername', username: s.replace(/^@/, '') }).catch((e) => {
        throw new Error(isRpc(e, 'USERNAME_NOT_OCCUPIED') || /USERNAME_(INVALID|NOT_OCCUPIED)/.test(String(e)) ? `No one on Telegram is ${s}` : String((e as Error).message));
      });
      this.ingest(res.users, res.chats);
      if (res.peer._ !== 'peerUser') {
        // A public group or channel: its conversation, without joining.
        const peer = peerOf(res.peer);
        const conv = convId(this.selfId, peer);
        return { conversation: conv, existed: this.state.dialogs.has(conv) };
      }
      user = res.users.find((u) => Number(u.id) === Number((res.peer as tl.RawPeerUser).userId));
    } else if (/^\+?\d{7,15}$/.test(s.replace(/[\s().-]/g, ''))) {
      const res = await this.call({ _: 'contacts.resolvePhone', phone: s.replace(/[^\d]/g, '') }).catch((e) => {
        throw new Error(/PHONE_NOT_OCCUPIED|PHONE_NUMBER_INVALID/.test(String(e)) ? 'No Telegram account has that number, or its owner does not let others find them by it' : String((e as Error).message));
      });
      this.ingest(res.users, res.chats);
      user = res.users[0];
    } else throw new Error('Give a Telegram @username, a phone number with its country code, or a user id');
    if (!user || user._ !== 'user') throw new Error('Telegram did not find them');
    this.ingest([user], []);
    const peer: PeerRef = { kind: 'user', id: Number(user.id) };
    const conv = convId(this.selfId, peer);
    const existed = this.state.dialogs.has(conv);
    this.sendConversation(this.convFacts.get(conv) ?? conversationOf(this.ctx, peer, { user }));
    return { conversation: conv, existed, ...(existed ? {} : { startsAtFirstSend: true }) };
  }

  private async forward(conversation: string, source: { conversation: string; message: string }, note?: string): Promise<{ nativeId?: string; fallback?: string }> {
    const to = this.conv(conversation);
    const src = this.message(source.message);
    if (note?.trim()) await this.send(conversation, note, undefined, undefined);
    const randomId = rand();
    try {
      const res = await this.call({ _: 'messages.forwardMessages', fromPeer: this.inputPeer(src.ref.peer), id: [src.id], randomId: [randomId], toPeer: this.inputPeer(to.peer), ...(to.topic && to.topic !== 1 ? { topMsgId: to.topic } : {}) }, { chat: baseConv(conversation) });
      const r = this.applyResult(res);
      const id = r.ids.get(randomId.toString());
      return { nativeId: id ? msgId(conversation, id) : r.first };
    } catch (e) {
      if (/CHAT_FORWARDS_RESTRICTED|MESSAGE_ID_INVALID/.test(String((e as Error).message))) return { fallback: 'This chat does not let its messages be forwarded' };
      throw e;
    }
  }

  // ---------------------------------------------------------------- adding: resolve, add, answer, join requests

  /** What an invite link, an @name or a +phone is, acting on nothing. Identity facts first (ingest), then the preview. */
  private async resolve(ref: P.AddRef): Promise<P.AddPreview> {
    if (ref?.network !== 'telegram') throw new Error('That is not a Telegram link, name or number');
    switch (ref.kind) {
      case 'invite':
        return this.previewInvite(ref.code);
      case 'name': {
        const found = await this.lookUpName(ref.name);
        return found.user ? this.previewPerson(found.user) : this.previewPlace(found.chat!);
      }
      case 'person':
        return this.previewPerson(await this.lookUpPhone(ref.handle));
      default:
        throw new Error('Telegram has no addresses like this: paste a t.me link, an @name or a phone number');
    }
  }

  /** Join a group or channel (or ask to), or add a contact. Facts for what now exists first, then the result naming it. */
  private async add(ref: P.AddRef, action: Exclude<P.AddAction, 'message'>): Promise<P.AddResult> {
    if (ref?.network !== 'telegram') throw new Error('That is not a Telegram link, name or number');
    if (action === 'join' || action === 'ask') {
      // Join and ask are one call on Telegram: a group that wants approval answers INVITE_REQUEST_SENT.
      if (ref.kind === 'invite') return this.joinInvite(ref.code);
      if (ref.kind === 'name') {
        const found = await this.lookUpName(ref.name);
        if (found.user) throw new Error(`@${found.name} is a person, not a group or channel: Message or Add contact instead`);
        return this.joinPublic(found.chat!);
      }
      throw new Error('Telegram joins a group or channel by its invite link or its @name');
    }
    if (action === 'contact') {
      if (ref.kind === 'name') {
        const found = await this.lookUpName(ref.name);
        if (!found.user) throw new Error(`@${found.name} is a group or channel, not a person: Join it instead`);
        return this.addContact(found.user);
      }
      if (ref.kind === 'person') return this.addContact(await this.lookUpPhone(ref.handle), ref.handle);
      throw new Error('Telegram adds a contact by @username or phone number');
    }
    throw new Error(action === 'friend' ? 'Telegram has no friend requests: Add contact instead' : action === 'follow' ? 'Telegram has no follows: Add contact, or join their channel' : `Telegram cannot ${String(action)} here`);
  }

  private async lookUpName(raw: string): Promise<{ name: string; user?: tl.RawUser; chat?: tl.TypeChat }> {
    const name = String(raw ?? '').replace(/^@/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new Error(`@${name} is not a Telegram username`);
    let res: tl.contacts.TypeResolvedPeer;
    try {
      res = await this.call({ _: 'contacts.resolveUsername', username: name }, LOOKUP);
    } catch (e) {
      throw addFailure(e, LOOKING, { USERNAME_NOT_OCCUPIED: `Nobody on Telegram is called @${name}`, USERNAME_INVALID: `@${name} is not a Telegram username` });
    }
    this.ingest(res.users, res.chats);
    const peer = peerOf(res.peer);
    if (peer.kind === 'user') {
      const u = this.users.get(peer.id) ?? res.users.find((x) => Number(x.id) === peer.id);
      if (u?._ !== 'user') throw new Error(`Nobody on Telegram is called @${name}`);
      return { name, user: u };
    }
    const chat = res.chats.find((x) => Number(x.id) === peer.id);
    if (!chat) throw new Error(`Nobody on Telegram is called @${name}`);
    return { name, chat };
  }

  /** contacts.resolvePhone: who has this number, when its owner lets others find them by it. Read-only. */
  private async lookUpPhone(handle: string): Promise<tl.RawUser> {
    const digits = String(handle ?? '').replace(/[^\d]/g, '');
    if (!String(handle ?? '').trim().startsWith('+') || !/^\d{7,15}$/.test(digits)) throw new Error('Telegram finds people by @username, or by a phone number with its country code (+ and the digits)');
    let res: tl.contacts.TypeResolvedPeer;
    try {
      res = await this.call({ _: 'contacts.resolvePhone', phone: digits }, LOOKUP);
    } catch (e) {
      throw addFailure(e, LOOKING, { PHONE_NOT_OCCUPIED: NO_PHONE, PHONE_NUMBER_INVALID: NO_PHONE, PHONE_NUMBER_BANNED: NO_PHONE });
    }
    this.ingest(res.users, res.chats);
    const peer = peerOf(res.peer);
    const u = peer.kind === 'user' ? (this.users.get(peer.id) ?? res.users.find((x) => Number(x.id) === peer.id)) : undefined;
    if (u?._ !== 'user') throw new Error(NO_PHONE);
    return u;
  }

  private previewPerson(u: tl.RawUser): P.AddPreview {
    const id = Number(u.id);
    const self = id === this.selfId;
    const contact = !!(u.contact || u.mutualContact);
    const avatar = identityOfUser(u, this.selfId)?.avatarUrl;
    const actions: P.AddAction[] = u.deleted ? [] : ['message'];
    if (!self && !contact && !u.bot && !u.deleted) actions.push('contact');
    const notes: string[] = [];
    if (self) notes.push('This is you: Message opens your Saved Messages');
    if (u.deleted) notes.push('This account was deleted');
    if (u.bot) notes.push('A bot');
    if (u.scam) notes.push('Telegram marks this account as a scam');
    if (u.fake) notes.push('Telegram marks this account as fake: it may pretend to be someone else');
    if (actions.includes('contact')) notes.push("Adding a contact on Telegram doesn't share your number");
    return {
      what: 'person',
      name: displayName(u),
      nativeId: userId(id),
      ...(avatar ? { avatar } : {}),
      ...(self ? {} : { relationship: contact ? 'contact' : 'stranger' }),
      actions,
      ...(notes.length ? { notes } : {}),
    };
  }

  /** A public group or channel by its @name: what it is, and whether this account is in it already. */
  private async previewPlace(c: tl.TypeChat): Promise<P.AddPreview> {
    if (c._ === 'chatForbidden' || c._ === 'channelForbidden') throw new Error(PRIVATE);
    if (c._ !== 'chat' && c._ !== 'channel') throw new Error('Telegram does not know this group or channel any more');
    const peer = chatPeer(c)!;
    const conv = convId(this.selfId, peer);
    const inIt = !c.left && !(c._ === 'chat' && c.deactivated);
    let description: string | undefined;
    let members = typeof c.participantsCount === 'number' ? c.participantsCount : undefined;
    if (c._ === 'channel') {
      // Its description and size, as a Telegram app shows them before joining (this reads; it acts on nothing).
      try {
        const full = await this.call({ _: 'channels.getFullChannel', channel: this.inputChannel(peer.id) }, LOOKUP);
        this.ingest(full.users, full.chats);
        if (full.fullChat._ === 'channelFull') {
          description = full.fullChat.about || undefined;
          members = full.fullChat.participantsCount ?? members;
        }
      } catch (e) {
        this.host.log('info', `resolve: no description for channel ${peer.id} (${e instanceof FloodError ? 'a flood wait' : tgCode(e)})`);
      }
    }
    if (inIt) this.knownConversation(peer, c);
    const broadcast = c._ === 'channel' && !!c.broadcast;
    const asks = c._ === 'channel' && !!c.joinRequest;
    const notes: string[] = [];
    if (inIt) notes.push('You are in it already');
    else if (asks) notes.push('Joining asks the admins first');
    if (broadcast && !inIt) notes.push('A channel: only its admins post');
    if (c._ === 'channel' && c.scam) notes.push('Telegram marks this as a scam');
    if (c._ === 'channel' && c.fake) notes.push('Telegram marks this as fake: it may pretend to be someone else');
    const avatar = avatarOfChat(c);
    return {
      what: broadcast ? 'channel' : 'group',
      name: c.title,
      nativeId: conv,
      ...(avatar ? { avatar } : {}),
      ...(description ? { description } : {}),
      ...(members !== undefined ? { members } : {}),
      ...(inIt ? { joined: { conversation: conv } } : {}),
      actions: inIt ? [] : [asks ? 'ask' : 'join'],
      ...(notes.length ? { notes } : {}),
    };
  }

  /** messages.checkChatInvite: what an invite link leads to, without joining. */
  private async previewInvite(hash: string): Promise<P.AddPreview> {
    let inv: tl.TypeChatInvite;
    try {
      inv = await this.call({ _: 'messages.checkChatInvite', hash }, LOOKUP);
    } catch (e) {
      throw addFailure(e, LOOKING, INVITE_WORDS);
    }
    if (inv._ === 'chatInviteAlready' || inv._ === 'chatInvitePeek') {
      const c = inv.chat;
      this.ingest([], [c]);
      if (c._ !== 'chat' && c._ !== 'channel') throw new Error(PRIVATE);
      const peer = chatPeer(c)!;
      const conv = convId(this.selfId, peer);
      const avatar = avatarOfChat(c);
      const base = {
        what: c._ === 'channel' && c.broadcast ? ('channel' as const) : ('group' as const),
        name: c.title,
        nativeId: conv,
        ...(avatar ? { avatar } : {}),
        ...(typeof c.participantsCount === 'number' ? { members: c.participantsCount } : {}),
        joined: { conversation: conv },
      };
      if (inv._ === 'chatInviteAlready') {
        this.knownConversation(peer, c);
        return { ...base, actions: [], notes: ['You are in it already'] };
      }
      // Telegram lets this account look in for a while without joining: in it for now, not for good.
      const left = inv.expires * 1000 - Date.now();
      return { ...base, actions: [c._ === 'channel' && c.joinRequest ? 'ask' : 'join'], notes: [`You can look in without joining until ${clockUtc(inv.expires * 1000, left > 20 * 3_600_000)}; Join to stay in it`] };
    }
    const paid = !!inv.subscriptionPricing && !inv.canRefulfillSubscription;
    const notes: string[] = [];
    if (inv.requestNeeded) notes.push('Joining asks the admins first');
    if (paid) notes.push('Joining costs Telegram Stars every month: join it from a Telegram app');
    if (inv.broadcast) notes.push('A channel: only its admins post');
    if (inv.scam) notes.push('Telegram marks this as a scam');
    if (inv.fake) notes.push('Telegram marks this as fake: it may pretend to be someone else');
    const known = (inv.participants ?? []).filter((u): u is tl.RawUser => u._ === 'user' && !!(u.contact || u.mutualContact)).map((u) => displayName(u));
    if (known.length) notes.push(`${nameList(known)} ${known.length === 1 ? 'is' : 'are'} in it`);
    return {
      what: inv.broadcast ? 'channel' : 'group',
      name: inv.title,
      ...(inv.about ? { description: inv.about } : {}),
      members: inv.participantsCount,
      ...(inv.photo._ === 'photo' ? { avatar: inviteAvatarUrl(hash, inv.photo.id, inv.photo.dcId) } : {}),
      actions: paid ? [] : [inv.requestNeeded ? 'ask' : 'join'],
      ...(notes.length ? { notes } : {}),
    };
  }

  /** A chat this account is in has its conversation out (one the snapshot did not reach, or just joined). */
  private knownConversation(peer: PeerRef, chat: tl.TypeChat): string {
    const conv = convId(this.selfId, peer);
    if (!this.convFacts.has(conv)) this.sendConversation(conversationOf(this.ctx, peer, { chat }));
    return conv;
  }

  /** messages.importChatInvite: join by an invite link, or ask to where the admins approve. */
  private async joinInvite(hash: string): Promise<P.AddResult> {
    let res: tl.messages.TypeChatInviteJoinResult;
    try {
      res = await this.call({ _: 'messages.importChatInvite', hash }, ACT);
    } catch (e) {
      const code = tgCode(e);
      if (code === 'INVITE_REQUEST_SENT') return asked();
      if (code === 'USER_ALREADY_PARTICIPANT') return this.alreadyIn(hash);
      throw addFailure(e, JOINING, INVITE_WORDS);
    }
    return this.joined(res);
  }

  /** Telegram says this account is in it: which chat, by looking the link up (that acts on nothing). */
  private async alreadyIn(hash: string): Promise<P.AddResult> {
    const inv = await this.call({ _: 'messages.checkChatInvite', hash }, LOOKUP).catch(() => null);
    if (inv?._ === 'chatInviteAlready') {
      this.ingest([], [inv.chat]);
      const peer = chatPeer(inv.chat);
      if (peer) return { conversation: this.knownConversation(peer, inv.chat), notes: ['You are in it already'] };
    }
    return { notes: ['Telegram says you are in it already'] };
  }

  /** channels.joinChannel: join a public group or channel found by its @name, or ask to. */
  private async joinPublic(c: tl.TypeChat): Promise<P.AddResult> {
    if (c._ === 'chatForbidden' || c._ === 'channelForbidden') throw new Error(PRIVATE);
    if (c._ !== 'channel') throw new Error('Telegram joins this group only by an invite link');
    const peer: PeerRef = { kind: 'channel', id: Number(c.id) };
    if (!c.left) return { conversation: this.knownConversation(peer, c), notes: ['You are in it already'] };
    let res: tl.messages.TypeChatInviteJoinResult;
    try {
      res = await this.call({ _: 'channels.joinChannel', channel: this.inputChannel(peer.id) }, ACT);
    } catch (e) {
      const code = tgCode(e);
      if (code === 'INVITE_REQUEST_SENT') return asked();
      if (code === 'USER_ALREADY_PARTICIPANT') return { conversation: this.knownConversation(peer, c), notes: ['You are in it already'] };
      throw addFailure(e, JOINING, PLACE_WORDS);
    }
    return this.joined(res, peer.id);
  }

  /**
   * What a join answered. Joined: its updates as any call's, the chat's conversation out, then its dialog (last
   * message, topics of a forum), then the result naming it. A bot's check (a mini app) is not worked around.
   */
  private async joined(res: tl.messages.TypeChatInviteJoinResult, channelId?: number): Promise<P.AddResult> {
    if (res._ === 'messages.chatInviteJoinResultWebView') {
      const bot = res.users.find((u): u is tl.RawUser => u._ === 'user' && Number(u.id) === Number(res.botId));
      return { check: 'captcha', notes: [`${bot ? displayName(bot) : 'A bot'} checks new members here first, in its mini app: join from a Telegram app to pass it. Nothing was done here`] };
    }
    const ups = res.updates;
    const chats = ups._ === 'updates' || ups._ === 'updatesCombined' ? ups.chats : [];
    const chat = chats.find((c) => (c._ === 'channel' || c._ === 'chat') && (channelId === undefined || Number(c.id) === channelId)) ?? (channelId !== undefined ? this.chats.get(channelId) : undefined);
    const peer = chat ? chatPeer(chat) : null;
    // The dialog is read below, so the chat's own refresh in the updates is left out.
    this.applyResult(peer ? withoutRefresh(ups, peer) : ups);
    if (!chat || !peer) return { notes: ['Joined'] };
    const conv = this.knownConversation(peer, this.chats.get(peer.id) ?? chat);
    await this.refreshDialog(peer, true);
    return { conversation: conv, ...(chat._ === 'channel' && chat.broadcast ? { notes: ['Joined; only its admins post here'] } : {}) };
  }

  /** contacts.addContact, without add_phone_privacy_exception: your number stays hidden from them. */
  private async addContact(u: tl.RawUser, phone?: string): Promise<P.AddResult> {
    const id = Number(u.id);
    if (id === this.selfId) throw new Error('That is you');
    if (u.deleted) throw new Error('This account was deleted');
    if (u.contact || u.mutualContact) {
      // Telegram says so: the list as known says so too.
      this.setRelation(id, true, this.blockedIds.has(id));
      return { identity: userId(id), relationship: 'contact', notes: ['Already in your Telegram contacts'] };
    }
    let res: tl.TypeUpdates;
    try {
      res = await this.call(
        {
          _: 'contacts.addContact',
          addPhonePrivacyException: false,
          id: this.inputUser(id),
          firstName: u.firstName || displayName(u),
          lastName: u.lastName ?? '',
          // Found by their number: it goes with the contact, as a Telegram app saves it. Never yours.
          phone: phone ? phone.replace(/[^\d]/g, '') : '',
        },
        ACT,
      );
    } catch (e) {
      throw addFailure(e, ADDING, CONTACT_WORDS);
    }
    // In the list before the answer's users are read, so they are not taken for a change made elsewhere.
    this.touchRelation(id);
    this.contactIds.add(id);
    this.applyResult(res);
    // The identity as a contact now, whether or not the answer carried them again; then the relationship.
    const now = { ...(this.users.get(id) ?? u), contact: true } as tl.RawUser;
    this.users.set(id, now);
    const f = identityOfUser(now, this.selfId);
    if (f) this.sendIdentity(f);
    this.tellRelation(id, true);
    return { identity: userId(id), relationship: 'contact', notes: ["Added to your Telegram contacts; they don't see your number"] };
  }

  /** messages.hideChatJoinRequest: let them in (accept) or not (decline). */
  private async answer(request: string, answer: P.RequestAnswer): Promise<P.AddResult> {
    const r = parseJoinRequestId(String(request ?? ''));
    if (!r) throw new Error('That is not a Telegram join request');
    this.conv(r.conv);
    if (answer !== 'accept' && answer !== 'decline') throw new Error(`A Telegram join request is answered with accept or decline, not ${String(answer)}`);
    const known = this.joinRequests.get(request);
    let res: tl.TypeUpdates;
    try {
      res = await this.call({ _: 'messages.hideChatJoinRequest', approved: answer === 'accept', peer: this.inputPeer(r.ref.peer), userId: this.inputUser(r.user) }, ACT);
    } catch (e) {
      const code = tgCode(e);
      if (code === 'HIDE_REQUESTER_MISSING' || code === 'USER_ALREADY_PARTICIPANT') {
        this.dropRequest(request, true);
        if (code === 'USER_ALREADY_PARTICIPANT') return { identity: userId(r.user), notes: ['They are in it already'] };
        throw new Error('That request is not waiting any more: it was answered elsewhere, or withdrawn');
      }
      throw addFailure(e, ANSWERING, ANSWER_WORDS);
    }
    // Gone before the answer, and before the update Telegram sends with it is read (it finds nothing more to drop);
    // a list read that crosses this leaves it out by answeredAt. Not through the request chain: a list read at
    // connect may take a while, and the answer does not wait for it.
    const at = Date.now();
    for (const [k, t] of this.answeredAt) if (at - t > 10 * 60_000) this.answeredAt.delete(k);
    this.answeredAt.set(request, at);
    this.dropRequest(request, true);
    this.applyResult(res);
    const chat = this.chats.get(r.ref.peer.id);
    const where = known?.target?.name ?? (chat && 'title' in chat ? chat.title : 'the group');
    const who = this.state.names.get(r.user) ?? 'They';
    return { identity: userId(r.user), notes: [answer === 'accept' ? `${who} can come in to ${where} now` : `Declined; ${who} stays out of ${where}`] };
  }

  /** The chats whose join requests this account may answer: those it owns, or admins with the right to add members. */
  private answersJoinRequests(c: tl.TypeChat | undefined): c is tl.RawChat | tl.RawChannel {
    if (!c || (c._ !== 'chat' && c._ !== 'channel') || c.left) return false;
    if (c._ === 'chat' && c.deactivated) return false;
    return !!c.creator || !!c.adminRights?.inviteUsers;
  }

  /** Request work one at a time, so a list read at connect and the updates after it do not cross. */
  private inRequestsChain(fn: () => Promise<void>): Promise<void> {
    const next = this.requestsChain.then(fn).catch((e) => this.host.log('warn', `join requests: ${rpcText(e)}`));
    this.requestsChain = next;
    return next;
  }

  /**
   * After connect: the join requests waiting in every chat this account may answer them in, then `requests` with the
   * whole list. A chat that could not be read leaves the list unsent (the hub keeps its own): what was found goes out
   * as `request`, and it is read again in two minutes.
   */
  private listJoinRequests(): Promise<void> {
    return this.inRequestsChain(async () => {
      clearTimeout(this.requestsTimer);
      if (this.phase !== 'online') return;
      const self = this.selfId;
      const found = new Map<string, P.RequestFact>();
      let whole = true;
      for (const c of [...this.chats.values()]) {
        if (!this.answersJoinRequests(c)) continue;
        const peer = chatPeer(c)!;
        if (!this.state.dialogs.has(convId(self, peer))) continue;
        try {
          for (const f of await this.fetchJoinRequests(peer, c)) found.set(f.nativeId, f);
        } catch (e) {
          if (this.phase !== 'online' || isAuthGone(e)) return;
          // Not an admin who sees them after all: none to answer there.
          if (/CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE|CHAT_FORBIDDEN/.test(tgCode(e))) continue;
          whole = false;
          this.host.log('warn', `join requests in ${peer.kind} ${peer.id}: ${e instanceof FloodError ? e.message : tgCode(e)}`);
        }
      }
      if (this.phase !== 'online') return;
      // Answered here while the list was being read.
      for (const [id, f] of found) if (f.ts <= (this.answeredAt.get(id) ?? -1)) found.delete(id);
      if (whole) {
        this.joinRequests = found;
        this.requestsListed = true;
        this.host.emit({ t: 'requests', requests: [...found.values()] });
        this.host.log('info', `join requests: ${found.size} waiting`);
      } else {
        for (const f of found.values()) this.putRequest(f);
        this.requestsTimer = setTimeout(() => void this.listJoinRequests(), 120_000);
      }
      this.refreshStatus();
    });
  }

  /** updatePendingJoinRequests: one chat's requests changed (new, answered elsewhere, withdrawn). */
  private chatJoinRequests(peer: PeerRef, pending: number): Promise<void> {
    return this.inRequestsChain(async () => {
      if (this.phase !== 'online') return;
      const c = this.chats.get(peer.id);
      const conv = convId(this.selfId, peer);
      let now: P.RequestFact[] = [];
      if (pending > 0 && this.answersJoinRequests(c)) now = await this.fetchJoinRequests(peer, c);
      const ids = new Set(now.map((r) => r.nativeId));
      for (const r of [...this.joinRequests.values()]) if (r.target?.nativeId === conv && !ids.has(r.nativeId)) this.dropRequest(r.nativeId);
      for (const r of now) this.putRequest(r);
      this.refreshStatus();
    });
  }

  /** messages.getChatInviteImporters (requested): who asks to join, newest first; identity facts first. */
  private async fetchJoinRequests(peer: PeerRef, c: tl.TypeChat): Promise<P.RequestFact[]> {
    const conv = convId(this.selfId, peer);
    const out: P.RequestFact[] = [];
    let offsetDate = 0;
    let offsetUser: tl.TypeInputUser = { _: 'inputUserEmpty' };
    for (let page = 0; page < 10; page++) {
      const res = await this.call({ _: 'messages.getChatInviteImporters', requested: true, peer: this.inputPeer(peer), offsetDate, offsetUser, limit: 100 }, { background: true });
      this.ingest(res.users, []);
      for (const i of res.importers) {
        if (!i.requested) continue;
        const f = requestFact(conv, c, Number(i.userId), i.date);
        // One answered here a moment ago that Telegram still listed: it is gone.
        const answered = this.answeredAt.get(f.nativeId);
        if (answered !== undefined && f.ts <= answered) continue;
        out.push(f);
      }
      const last = res.importers.at(-1);
      if (!last || res.importers.length < 100) break;
      offsetDate = last.date;
      offsetUser = this.inputUser(Number(last.userId));
    }
    return out;
  }

  /** A request new or changed goes out. */
  private putRequest(r: P.RequestFact) {
    const prev = this.joinRequests.get(r.nativeId);
    if (prev && JSON.stringify(prev) === JSON.stringify(r)) return;
    this.joinRequests.set(r.nativeId, r);
    this.host.emit({ t: 'request', request: r });
  }

  /** A request answered, withdrawn or no longer this account's: gone. always: say so even if it was not listed here. */
  private dropRequest(id: string, always = false) {
    if (this.joinRequests.delete(id) || always) this.host.emit({ t: 'requestGone', nativeId: id });
  }

  // ---------------------------------------------------------------- relationships: contacts and blocks

  /** What this account is to someone as the lists say: a block outweighs a contact. */
  private relationOf(id: number): P.RelationshipFact['relationship'] {
    if (this.blockedIds.has(id)) return 'blocked';
    return this.contactIds.has(id) ? 'contact' : 'stranger';
  }

  private relationFact(id: number): P.RelationshipFact {
    const relationship = this.relationOf(id);
    const since = relationship === 'blocked' ? this.blockedIds.get(id) : undefined;
    return { identity: userId(id), relationship, ...(since ? { since } : {}) };
  }

  /** Everyone on either list, once each (a blocked contact is blocked), whose identity went out; never you. */
  private relationList(): P.RelationshipFact[] {
    const self = this.selfId;
    const ids = new Set([...this.contactIds, ...this.blockedIds.keys()]);
    ids.delete(self);
    return [...ids].filter((id) => this.sentIdentity.has(userId(id))).map((id) => this.relationFact(id));
  }

  /** The whole list to the hub: it replaces the hub's. */
  private sendRelationList() {
    const list = this.relationList();
    this.relationsSent = new Map(list.map((f) => [Number(f.identity), JSON.stringify(f)]));
    this.relationsListed = true;
    this.host.emit({ t: 'relationships', list });
  }

  /**
   * One relationship to the hub, when it differs from what the hub was told (gone: 'stranger'), its identity first.
   * always: this account just changed it (add, remove), so it goes out even if the hub never had it.
   */
  private tellRelation(id: number, always = false) {
    if (id === this.selfId) return;
    const f = this.relationFact(id);
    const key = JSON.stringify(f);
    const prev = this.relationsSent.get(id);
    if (!always && (prev === key || (prev === undefined && f.relationship === 'stranger'))) return;
    if (!this.sentIdentity.has(f.identity)) {
      const u = this.users.get(id);
      const idf = u ? identityOfUser(u, this.selfId) : null;
      // Nobody the hub could name: the next read of the lists sends them with their identity.
      if (!idf) return;
      this.sendIdentity(idf);
    }
    if (f.relationship === 'stranger') this.relationsSent.delete(id);
    else this.relationsSent.set(id, key);
    this.host.emit({ t: 'relationship', fact: f });
  }

  /** Changed here or by an update: a list read that started before keeps this. */
  private touchRelation(id: number) {
    this.relationsTouched.set(id, ++this.relationsSeq);
  }

  /** Their identity again with the contact flag the list now has, when Telegram sent no user that says so. */
  private contactFlag(id: number, contact: boolean) {
    const u = this.users.get(id);
    if (!u || !!(u.contact || u.mutualContact) === contact) return;
    const now = { ...u, contact, mutualContact: contact ? u.mutualContact : false } as tl.RawUser;
    this.users.set(id, now);
    const f = identityOfUser(now, this.selfId);
    if (f) this.sendIdentity(f);
  }

  /** What Telegram says they are now (a profile, a re-check, an update): the lists follow, and the hub is told. */
  private setRelation(id: number, contact: boolean, blocked: boolean) {
    if (id === this.selfId || (contact === this.contactIds.has(id) && blocked === this.blockedIds.has(id))) return;
    this.touchRelation(id);
    if (contact) this.contactIds.add(id);
    else this.contactIds.delete(id);
    if (!blocked) this.blockedIds.delete(id);
    else if (!this.blockedIds.has(id)) this.blockedIds.set(id, undefined);
    this.contactFlag(id, contact);
    this.tellRelation(id);
  }

  /** updatePeerBlocked: blocked or unblocked on another device (or this one; then nothing changes). */
  private peerBlocked(id: number, blocked: boolean) {
    if (blocked === this.blockedIds.has(id)) return;
    // Before the lists were read, whether they are a contact is what Telegram last said of them.
    const u = this.users.get(id);
    const contact = this.relationsKnown || !u ? this.contactIds.has(id) : !!(u.contact || u.mutualContact);
    this.setRelation(id, contact, blocked);
  }

  /** A sign the lists changed (a user's contact flag, Telegram's reset): read them again soon, not too often. */
  private relationsSoon() {
    if (this.relationsSoonTimer || this.phase !== 'online') return;
    const o = this.opts.relations ?? {};
    const wait = Math.max(o.soonMs ?? 2000, this.relationsSoonAt + (o.gapMs ?? 60_000) - Date.now());
    this.relationsSoonTimer = setTimeout(() => {
      this.relationsSoonTimer = undefined;
      this.relationsSoonAt = Date.now();
      void this.refreshRelations();
    }, wait);
  }

  /**
   * Read both lists again, one read at a time (one waiting covers every ask made meanwhile). whole: the `relationships`
   * list goes out (after a snapshot); else each difference from what the hub was told goes out as a `relationship`
   * (the whole list if it never went out). A read that fails changes nothing and sends nothing.
   */
  private refreshRelations(whole = false): Promise<void> {
    this.relationsWhole ||= whole;
    if (this.relationsQueued) return this.relationsQueued;
    const run = this.relationsChain
      .then(async () => {
        this.relationsQueued = null;
        const w = this.relationsWhole;
        this.relationsWhole = false;
        await this.readRelations(w);
      })
      .catch((e) => this.host.log('warn', `contacts and blocks: ${(e as Error)?.stack ?? e}`));
    this.relationsQueued = run;
    this.relationsChain = run;
    return run;
  }

  private async readRelations(whole: boolean) {
    if (this.phase !== 'online') return;
    const seq = this.relationsSeq;
    let read: { contacts: Set<number>; blocked: Map<number, number | undefined> };
    try {
      read = await this.fetchRelations();
    } catch (e) {
      this.host.log('warn', `contacts and blocks not read (no list sent): ${e instanceof FloodError ? e.message : rpcText(e)}`);
      return;
    }
    if (this.phase !== 'online') return;
    // Changed while the lists were read (this account's remove, an update): that stands. Older changes are in the read.
    for (const [id, at] of this.relationsTouched) {
      if (at <= seq) {
        this.relationsTouched.delete(id);
        continue;
      }
      if (this.contactIds.has(id)) read.contacts.add(id);
      else read.contacts.delete(id);
      if (this.blockedIds.has(id)) read.blocked.set(id, this.blockedIds.get(id));
      else read.blocked.delete(id);
    }
    const was = this.contactIds;
    this.contactIds = read.contacts;
    this.blockedIds = read.blocked;
    this.relationsKnown = true;
    // A contact added or removed elsewhere: their identity says so too (getContacts sends only those it lists).
    for (const id of new Set([...was, ...read.contacts])) if (was.has(id) !== read.contacts.has(id)) this.contactFlag(id, read.contacts.has(id));
    if (whole || !this.relationsListed) {
      this.sendRelationList();
      this.host.log('info', `contacts and blocks: ${this.contactIds.size} contacts, ${this.blockedIds.size} blocked`);
    } else for (const id of new Set([...this.relationsSent.keys(), ...read.contacts, ...read.blocked.keys()])) this.tellRelation(id);
    this.refreshStatus();
  }

  /**
   * contacts.getContacts (with the hash of the list as known, so an unchanged one is not sent again) and
   * contacts.getBlocked (paged; blocked chats and channels are not people). Identity facts first. Throws if either fails.
   */
  private async fetchRelations(): Promise<{ contacts: Set<number>; blocked: Map<number, number | undefined> }> {
    const hash = this.relationsKnown ? contactsHash(this.contactsSaved, this.contactIds) : ZERO;
    const c = await this.call({ _: 'contacts.getContacts', hash }, { background: true });
    let contacts: Set<number>;
    if (c._ === 'contacts.contactsNotModified') contacts = new Set(this.contactIds);
    else {
      this.ingest(c.users, [], true);
      contacts = new Set(c.contacts.map((x) => Number(x.userId)));
      this.contactsSaved = c.savedCount;
    }
    const blocked = new Map<number, number | undefined>();
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const b = await this.call({ _: 'contacts.getBlocked', offset, limit: 100 }, { background: true });
      this.ingest(b.users, [], true);
      for (const x of b.blocked) if (x.peerId._ === 'peerUser') blocked.set(Number(x.peerId.userId), x.date ? x.date * 1000 : undefined);
      offset += b.blocked.length;
      if (b._ === 'contacts.blocked' || b.blocked.length < 100 || offset >= b.count) break;
    }
    return { contacts, blocked };
  }

  /**
   * End a contact (contacts.deleteContacts) or a block (contacts.unblock), only when that is what they still are:
   * Telegram is asked again first (users.getFullUser), else the lists as known say. Sent once, in the slow lane. The
   * relationship event, then the answer with what they are after.
   */
  private async remove(identity: string, relationship: P.PersonRelationship): Promise<P.AddResult> {
    const raw = String(identity ?? '');
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) throw new Error(raw.startsWith('channel:') ? 'A channel is not a contact on Telegram: leave it instead' : 'That is not a Telegram person');
    if (relationship === 'stranger') throw new Error('They are not in your Telegram contacts and not blocked: there is nothing to remove');
    if (relationship !== 'contact' && relationship !== 'blocked') throw new Error('Telegram has no friends or follows; only contacts and blocks');
    if (id === this.selfId) throw new Error('That is you');
    const input = this.inputUser(id);
    const now = await this.currentRelation(id, input);
    if (now.relationship !== relationship) throw new Error('That changed; look again');
    if (relationship === 'contact') {
      let res: tl.TypeUpdates;
      try {
        res = await this.call({ _: 'contacts.deleteContacts', id: [input] }, ACT);
      } catch (e) {
        throw addFailure(e, REMOVING, REMOVE_WORDS);
      }
      // Off the list before the answer's users are read, so they are not taken for a change made elsewhere.
      this.touchRelation(id);
      this.contactIds.delete(id);
      this.applyResult(res);
      // The identity no longer a contact, whether or not the answer carried them again; then the relationship.
      this.contactFlag(id, false);
      this.tellRelation(id, true);
      return { identity: userId(id), relationship: 'stranger', notes: ['Removed from your Telegram contacts'] };
    }
    try {
      await this.call({ _: 'contacts.unblock', id: this.inputPeer({ kind: 'user', id }) }, ACT);
    } catch (e) {
      throw addFailure(e, UNBLOCKING, REMOVE_WORDS);
    }
    this.touchRelation(id);
    this.blockedIds.delete(id);
    if (now.contact) this.contactIds.add(id);
    this.tellRelation(id, true);
    return now.contact ? { identity: userId(id), relationship: 'contact', notes: ['Unblocked; they are still in your Telegram contacts'] } : { identity: userId(id), relationship: 'stranger', notes: ['Unblocked'] };
  }

  /** What they are to this account now: Telegram asked (a lookup); if it will not say, the lists, once read. */
  private async currentRelation(id: number, input: tl.TypeInputUser): Promise<{ relationship: P.RelationshipFact['relationship']; contact: boolean }> {
    let res: tl.users.TypeUserFull;
    try {
      res = await this.call({ _: 'users.getFullUser', id: input }, LOOKUP);
    } catch (e) {
      if (!this.relationsKnown) throw addFailure(e, LOOKING, { USER_ID_INVALID: 'Telegram does not know this account any more' });
      this.host.log('warn', `remove: Telegram did not say what they are now (${rpcText(e)}); the lists as known say`);
      return { relationship: this.relationOf(id), contact: this.contactIds.has(id) };
    }
    this.ingest(res.users, res.chats, true);
    const u = res.users.find((x) => Number(x.id) === id);
    const contact = u?._ === 'user' && !!(u.contact || u.mutualContact);
    const blocked = !!res.fullUser.blocked;
    // What Telegram says now is what the lists say from here on (the hub hears of a change before the refusal).
    this.setRelation(id, contact, blocked);
    return { relationship: blocked ? 'blocked' : contact ? 'contact' : 'stranger', contact };
  }

  // ---------------------------------------------------------------- about, configure, profile

  private async about(target: P.AboutTarget): Promise<P.About> {
    if (target.kind !== 'conversation' && !this.isForumConv(target.nativeId)) throw new Error('Telegram has no such space: only a forum is one');
    const ref = this.conv(target.nativeId);
    if (ref.peer.kind === 'user') {
      const u = this.users.get(ref.peer.id);
      const pinned = await this.pinnedIds(ref.peer).catch(() => []);
      return {
        noun: ref.peer.id === this.selfId ? 'Saved Messages' : 'Chat',
        fields: { name: { value: ref.peer.id === this.selfId ? 'Saved Messages' : u ? displayName(u) : null, canEdit: false, reason: 'A private chat is named after the person' } },
        members: { list: [...new Set([userId(this.selfId), userId(ref.peer.id)])].map((id) => ({ id })), complete: true },
        pinned: { messages: pinned, canEdit: true },
        facts: [{ label: 'Telegram id', value: String(ref.peer.id) }],
      };
    }
    if (ref.topic) return this.aboutTopic(ref.peer.id, ref.topic);
    return ref.peer.kind === 'chat' ? this.aboutChat(ref.peer.id) : this.aboutChannel(ref.peer.id);
  }

  private async pinnedIds(peer: PeerRef): Promise<string[]> {
    const res = await this.call({ _: 'messages.search', peer: this.inputPeer(peer), q: '', filter: { _: 'inputMessagesFilterPinned' }, minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 50, maxId: 0, minId: 0, hash: ZERO });
    if (res._ === 'messages.messagesNotModified') return [];
    this.ingest(res.users, res.chats);
    const conv = convId(this.selfId, peer);
    return res.messages.filter((m) => m._ !== 'messageEmpty').map((m) => msgId(conv, m.id));
  }

  private async aboutChat(chatId: number): Promise<P.About> {
    const full = await this.call({ _: 'messages.getFullChat', chatId });
    this.ingest(full.users, full.chats);
    const chat = full.chats.find((c) => Number(c.id) === chatId);
    const f = full.fullChat;
    if (f._ !== 'chatFull' || chat?._ !== 'chat') throw new Error('Telegram did not describe this group');
    const creator = !!chat.creator;
    const admin = chat.adminRights;
    const banned = chat.defaultBannedRights;
    const may = (right: 'changeInfo' | 'inviteUsers' | 'pinMessages') => creator || !!admin?.[right] || (!!banned && !banned[right]);
    const list: P.AboutMember[] = [];
    if (f.participants._ === 'chatParticipants') {
      for (const p of f.participants.participants) {
        const role = p._ === 'chatParticipantCreator' ? 'Owner' : p._ === 'chatParticipantAdmin' ? 'Admin' : undefined;
        list.push({ id: userId(Number(p.userId)), ...(role ? { role, rank: 100 } : { rank: 0 }) });
      }
    }
    const invite = f.exportedInvite?._ === 'chatInviteExported' ? f.exportedInvite.link : null;
    const pinned = await this.pinnedIds({ kind: 'chat', id: chatId }).catch(() => []);
    const info = 'Only admins can change this group’s info';
    const room = Math.max(0, BASIC_GROUP_MAX - chat.participantsCount);
    return {
      noun: 'Group',
      fields: {
        name: { value: chat.title, canEdit: may('changeInfo'), ...(may('changeInfo') ? {} : { reason: info }) },
        topic: { value: f.about ?? '', canEdit: may('changeInfo'), ...(may('changeInfo') ? {} : { reason: info }) },
        avatar: { value: null, canEdit: false, reason: 'Changing the picture is not supported yet' },
        slowMode: { value: 0, canEdit: false, reason: 'Slow mode is for supergroups (Telegram makes a group one when it needs to)' },
        joinApproval: { value: false, canEdit: false, reason: 'Join requests are set on invite links in a basic group' },
      },
      members: { list, total: chat.participantsCount, complete: list.length >= chat.participantsCount },
      adding: addingOf(may('inviteUsers') && room > 0, may('inviteUsers') ? BASIC_FULL : ONLY_ADMINS_ADD, room),
      you: { role: creator ? 'Owner' : admin ? 'Admin' : 'Member', rank: creator || admin ? 100 : 0 },
      rules: rulesOf(banned, creator || !!admin),
      invite: { link: invite, canCreate: creator || !!admin?.inviteUsers, canRevoke: !!invite && (creator || !!admin?.inviteUsers), ...(creator || admin?.inviteUsers ? {} : { reason: 'Only admins can make invite links' }) },
      pinned: { messages: pinned, canEdit: may('pinMessages'), ...(may('pinMessages') ? {} : { reason: 'Only admins can pin here' }) },
      facts: [
        { label: 'Type', value: 'Group' },
        { label: 'Members', value: String(chat.participantsCount) },
        { label: 'Telegram id', value: markedId({ kind: 'chat', id: chatId }) },
      ],
    };
  }

  private async aboutChannel(channelId: number): Promise<P.About> {
    const channel = this.inputChannel(channelId);
    const full = await this.call({ _: 'channels.getFullChannel', channel });
    this.ingest(full.users, full.chats);
    const c = full.chats.find((x) => Number(x.id) === channelId);
    const f = full.fullChat;
    if (f._ !== 'channelFull' || c?._ !== 'channel') throw new Error('Telegram did not describe this channel');
    const creator = !!c.creator;
    const admin = c.adminRights;
    const banned = c.defaultBannedRights;
    const broadcast = !!c.broadcast;
    const may = (right: 'changeInfo' | 'inviteUsers' | 'pinMessages') => creator || !!admin?.[right] || (!broadcast && !!banned && !banned[right]);
    // Adding: as the other rights, and not when this account's own restrictions in a supergroup forbid it, or it left.
    const mayAdd = !c.left && may('inviteUsers') && (creator || !!admin?.inviteUsers || !c.bannedRights?.inviteUsers);
    const canBan = creator || !!admin?.banUsers;
    const uname = usernameOf(c);
    const list: P.AboutMember[] = [];
    let complete = false;
    if (!broadcast || f.canViewParticipants) {
      const seen = new Set<string>();
      for (const filter of [{ _: 'channelParticipantsAdmins' }, { _: 'channelParticipantsRecent' }] as tl.TypeChannelParticipantsFilter[]) {
        const res = await this.call({ _: 'channels.getParticipants', channel, filter, offset: 0, limit: 200, hash: ZERO }).catch(() => null);
        if (!res || res._ !== 'channels.channelParticipants') continue;
        this.ingest(res.users, res.chats);
        for (const p of res.participants) {
          if (!('userId' in p)) continue;
          const id = userId(Number(p.userId));
          if (seen.has(id)) continue;
          seen.add(id);
          const role = adminRole(p);
          list.push({ id, ...(role ? { role: 'rank' in p && p.rank ? p.rank : role, rank: role === 'Owner' ? 100 : 50 } : { rank: 0 }) });
        }
      }
      complete = !!f.participantsCount && list.length >= f.participantsCount;
    }
    const invite = f.exportedInvite?._ === 'chatInviteExported' ? f.exportedInvite.link : uname ? `https://t.me/${uname}` : null;
    const pinned = await this.pinnedIds({ kind: 'channel', id: channelId }).catch(() => []);
    const noun = broadcast ? 'Channel' : c.forum ? 'Forum' : 'Group';
    const info = `Only admins can change this ${noun.toLowerCase()}’s info`;
    const fields: P.AboutFields = {
      name: { value: c.title, canEdit: may('changeInfo'), ...(may('changeInfo') ? {} : { reason: info }) },
      topic: { value: f.about ?? '', canEdit: may('changeInfo'), ...(may('changeInfo') ? {} : { reason: info }) },
      avatar: { value: null, canEdit: false, reason: 'Changing the picture is not supported yet' },
    };
    if (!broadcast) {
      fields.slowMode = { value: f.slowmodeSeconds ?? 0, canEdit: canBan, ...(canBan ? {} : { reason: 'Only admins who can ban members set slow mode' }) };
      const canJoinApproval = canBan && !!uname;
      fields.joinApproval = { value: !!c.joinRequest, canEdit: canJoinApproval, ...(canJoinApproval ? {} : { reason: uname ? 'Only admins who can ban members set this' : 'A private group asks for approval per invite link' }) };
    }
    return {
      noun,
      fields,
      ...(list.length ? { members: { list, ...(f.participantsCount ? { total: f.participantsCount } : {}), complete } } : {}),
      adding: addingOf(mayAdd, c.left ? `You are not in this ${noun.toLowerCase()}` : ONLY_ADMINS_ADD),
      you: { role: creator ? 'Owner' : admin ? 'Admin' : broadcast ? 'Subscriber' : 'Member', rank: creator ? 100 : admin ? 50 : 0 },
      ...(broadcast ? {} : { rules: rulesOf(banned, creator || !!admin) }),
      invite: { link: invite, canCreate: creator || !!admin?.inviteUsers, canRevoke: !!f.exportedInvite && (creator || !!admin?.inviteUsers), ...(uname ? { derived: !f.exportedInvite } : {}), ...(creator || admin?.inviteUsers ? {} : { reason: 'Only admins can make invite links' }) },
      pinned: { messages: pinned, canEdit: may('pinMessages'), ...(may('pinMessages') ? {} : { reason: 'Only admins can pin here' }) },
      facts: [
        { label: 'Type', value: broadcast ? 'Channel' : c.forum ? 'Forum (supergroup with topics)' : 'Supergroup' },
        ...(f.participantsCount ? [{ label: broadcast ? 'Subscribers' : 'Members', value: String(f.participantsCount) }] : []),
        ...(uname ? [{ label: 'Public link', value: `t.me/${uname}` }] : []),
        { label: 'Telegram id', value: markedId({ kind: 'channel', id: channelId }) },
      ],
    };
  }

  private async aboutTopic(channelId: number, topic: number): Promise<P.About> {
    const c = this.chats.get(channelId);
    const creator = c?._ === 'channel' && !!c.creator;
    const manage = creator || (c?._ === 'channel' && !!c.adminRights?.manageTopics);
    const title = this.topicTitles.get(convId(this.selfId, { kind: 'channel', id: channelId }, topic)) ?? (topic === 1 ? 'General' : null);
    return {
      noun: 'Topic',
      fields: { name: { value: title, canEdit: manage, ...(manage ? {} : { reason: 'Only admins who manage topics rename them' }) } },
      facts: [{ label: 'Topic id', value: String(topic) }],
    };
  }

  private async configure(target: P.AboutTarget, change: P.AboutChange): Promise<P.About> {
    if (target.kind !== 'conversation' && !this.isForumConv(target.nativeId)) throw new Error('Telegram has no such space: only a forum is one');
    const ref = this.conv(target.nativeId);
    const peer = ref.peer;
    if (peer.kind === 'user' && change.key !== 'pin') throw new Error('A private chat has no settings to change');
    const done = (res: unknown) => {
      if (res && typeof res === 'object' && '_' in res && /^update/.test(String((res as { _: string })._))) this.applyResult(res as tl.TypeUpdates);
    };
    switch (change.key) {
      case 'name':
        if (ref.topic) done(await this.call({ _: 'messages.editForumTopic', peer: this.inputPeer(peer), topicId: ref.topic, title: change.value }));
        else if (peer.kind === 'chat') done(await this.call({ _: 'messages.editChatTitle', chatId: peer.id, title: change.value }));
        else done(await this.call({ _: 'channels.editTitle', channel: this.inputChannel(peer.id), title: change.value }));
        if (ref.topic) {
          this.topicTitles.set(target.nativeId, change.value);
          const known = this.convFacts.get(target.nativeId);
          if (known) this.sendConversation({ ...known, name: change.value });
        }
        break;
      case 'topic':
        await this.call({ _: 'messages.editChatAbout', peer: this.inputPeer(peer), about: change.value });
        {
          const known = this.convFacts.get(target.nativeId);
          if (known) this.sendConversation({ ...known, topic: change.value });
        }
        break;
      case 'slowMode':
        if (peer.kind !== 'channel') throw new Error('Slow mode is for supergroups');
        done(await this.call({ _: 'channels.toggleSlowMode', channel: this.inputChannel(peer.id), seconds: change.value }));
        break;
      case 'joinApproval':
        if (peer.kind !== 'channel') throw new Error('Join requests are set on invite links in a basic group');
        done(await this.call({ _: 'channels.toggleJoinRequest', channel: this.inputChannel(peer.id), enabled: change.value }));
        break;
      case 'invite':
        if (change.op === 'create') await this.call({ _: 'messages.exportChatInvite', peer: this.inputPeer(peer), legacyRevokePermanent: true });
        else {
          const about = await this.about(target);
          if (!about.invite?.link || about.invite.derived) throw new Error('There is no invite link to turn off');
          await this.call({ _: 'messages.editExportedChatInvite', peer: this.inputPeer(peer), link: about.invite.link, revoked: true });
        }
        break;
      case 'pin': {
        const m = this.message(change.message);
        done(await this.call({ _: 'messages.updatePinnedMessage', peer: this.inputPeer(peer), id: m.id, ...(change.remove ? { unpin: true } : {}), silent: true }));
        break;
      }
      default:
        throw new Error(`${change.key} is not a setting on Telegram`);
    }
    return this.about(target);
  }

  /**
   * Add people to a basic group, a supergroup or a channel, where a fresh About says this account may. Someone in it
   * already is added without asking. A basic group takes them one at a time (messages.addChatUser); a supergroup or
   * channel all at once (channels.inviteToChannel), and if Telegram refuses that call for one of them, each again on
   * their own so the rest still go. A flood wait, PEER_FLOOD or a refusal of the group itself stops it: the rest fail
   * with that sentence. Telegram's service message ("added …") comes in the answer's updates and goes out as any
   * other; then the About again.
   */
  private async addMembers(target: P.AboutTarget, people: string[]): Promise<P.AddMembersResult> {
    if (target.kind !== 'conversation' && !this.isForumConv(target.nativeId)) throw new Error('Telegram has no such space: only a forum is one');
    const ref = this.conv(target.nativeId);
    const peer = ref.peer;
    if (peer.kind === 'user') throw new Error('A private chat has nobody to add: make a group instead');
    if (ref.topic) throw new Error('People are added to the whole forum, not to one topic');
    const ids = [...new Set((Array.isArray(people) ? people : []).map(String))];
    if (!ids.length) throw new Error('Name someone to add');
    if (ids.length > ADD_MEMBERS_MAX) throw new Error(`At most ${ADD_MEMBERS_MAX} people at a time`);
    // Read again here, not taken from the hub: whether this account may add now, and who is in it already.
    const before = await this.about(target);
    if (!before.adding) throw new Error('Telegram adds people only to groups and channels');
    if (!before.adding.can) throw new Error(before.adding.reason ?? ONLY_ADMINS_ADD);
    const inAlready = new Set((before.members?.list ?? []).map((m) => m.id));
    const self = this.selfId;
    const added: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const send: { id: string; user: tl.TypeInputUser }[] = [];
    for (const id of ids) {
      const n = /^\d+$/.test(id) ? Number(id) : NaN;
      if (!Number.isSafeInteger(n) || n <= 0) failed.push({ id, reason: 'That is not a Telegram person' });
      else if (n === self) failed.push({ id, reason: 'That is you' });
      else if (inAlready.has(id)) added.push(id);
      else if (!this.state.users.has(n)) failed.push({ id, reason: NOT_SEEN });
      else if (this.users.get(n)?.deleted) failed.push({ id, reason: 'This account was deleted' });
      else send.push({ id, user: this.inputUser(n) });
    }

    let stopped: string | null = null;
    const took = (res: tl.messages.TypeInvitedUsers | tl.TypeUpdates, sent: string[]) => {
      const r = this.tookIn(res, sent);
      added.push(...r.added);
      failed.push(...r.failed);
    };
    const refused = (id: string, e: unknown) => {
      const r = addRefusal(e);
      if (r.in) added.push(id);
      else {
        failed.push({ id, reason: r.reason });
        if (r.stop) stopped = r.reason;
      }
    };
    const oneByOne = async (list: typeof send) => {
      for (const p of list) {
        if (stopped) {
          failed.push({ id: p.id, reason: stopped });
          continue;
        }
        try {
          if (peer.kind === 'chat') took(await this.call({ _: 'messages.addChatUser', chatId: peer.id, userId: p.user, fwdLimit: 100 }, ACT), [p.id]);
          else took(await this.call({ _: 'channels.inviteToChannel', channel: this.inputChannel(peer.id), users: [p.user] }, ACT), [p.id]);
        } catch (e) {
          refused(p.id, e);
        }
      }
    };
    if (peer.kind === 'channel' && send.length > 1) {
      try {
        took(await this.call({ _: 'channels.inviteToChannel', channel: this.inputChannel(peer.id), users: send.map((p) => p.user) }, ACT), send.map((p) => p.id));
      } catch (e) {
        const r = addRefusal(e);
        if (!r.in && r.stop) for (const p of send) failed.push({ id: p.id, reason: r.reason });
        // Refused for one of them (Telegram does not say whom): each on their own.
        else await oneByOne(send);
      }
    } else await oneByOne(send);

    // Everyone in it now is known to the hub before the answer.
    for (const id of added) {
      const u = this.users.get(Number(id));
      const f = u ? identityOfUser(u, self) : null;
      if (f) this.sendIdentity(f);
    }
    this.host.log('info', `addMembers: ${added.length} in, ${failed.length} refused`);
    const about = await this.about(target).catch(() => undefined);
    return { added, ...(failed.length ? { failed } : {}), ...(about ? { about } : {}) };
  }

  /**
   * Make a basic group: one messages.createChat with the title and everyone at once, as Telegram's apps do, sent once
   * (a timeout is an error, never a second group). Whom their privacy settings keep out (missingInvitees) are refused
   * with addMembers' sentence; the group is made with the rest. People this account has not seen are refused before
   * anything is sent. Identities, then the group with its participants, then the answer.
   */
  private async createGroup(name: string | undefined, people: string[]): Promise<P.CreateGroupResult> {
    const self = this.selfId;
    const ids = [...new Set((Array.isArray(people) ? people : []).map(String))].filter((id) => id !== userId(self));
    const title = typeof name === 'string' ? name.trim() : '';
    const problem = createGroupProblem('telegram', title || undefined, ids.length);
    if (problem) throw new Error(problem);
    const failed: { id: string; reason: string }[] = [];
    const send: { id: string; user: tl.TypeInputUser }[] = [];
    for (const id of ids) {
      const n = /^\d+$/.test(id) ? Number(id) : NaN;
      if (!Number.isSafeInteger(n) || n <= 0) failed.push({ id, reason: 'That is not a Telegram person' });
      else if (!this.state.users.has(n)) failed.push({ id, reason: NOT_SEEN });
      else if (this.users.get(n)?.deleted) failed.push({ id, reason: 'This account was deleted' });
      else send.push({ id, user: this.inputUser(n) });
    }
    if (!send.length) throw new Error(failed.length === 1 ? failed[0].reason : 'Nobody here can be put in a Telegram group from this account');
    // Everyone asked for is known to the hub before the group that names them.
    for (const p of send) {
      const u = this.users.get(Number(p.id));
      const f = u ? identityOfUser(u, self) : null;
      if (f) this.sendIdentity(f);
    }
    let res: tl.messages.TypeInvitedUsers;
    try {
      res = await this.call({ _: 'messages.createChat', title, users: send.map((p) => p.user) }, ACT);
    } catch (e) {
      throw addFailure(e, MAKING_GROUPS, CREATE_WORDS);
    }
    const r = this.tookIn(res, send.map((p) => p.id));
    failed.push(...r.failed);
    const chat = createdChat(res.updates);
    if (!chat) throw new Error('Telegram made the group but did not say which: it shows up here with the next sync');
    const peer: PeerRef = { kind: 'chat', id: Number(chat.id) };
    const conversation = convId(self, peer);
    const base = this.convFacts.get(conversation) ?? conversationOf(this.ctx, peer, { chat });
    this.sendConversation(base);
    // Its members once, now: Telegram's facts for groups carry none, and later ones must not carry this list stale.
    this.host.emit({ t: 'conversation', conversation: { ...base, participants: [userId(self), ...r.added] } });
    this.host.log('info', `createGroup: ${r.added.length} in, ${failed.length} refused`);
    const notes = r.added.length ? [] : ['Telegram made the group with nobody else in it'];
    return { conversation, added: r.added, ...(failed.length ? { failed } : {}), ...(notes.length ? { notes } : {}) };
  }

  /**
   * What an add answered: its updates handled like any other call's; whom Telegram kept out (missingInvitees, their
   * privacy settings) refused, the rest in. Older layers answer with the updates alone.
   */
  private tookIn(res: tl.messages.TypeInvitedUsers | tl.TypeUpdates, sent: string[]): { added: string[]; failed: { id: string; reason: string }[] } {
    const invited = res._ === 'messages.invitedUsers' ? res : null;
    this.applyResult(invited ? invited.updates : (res as tl.TypeUpdates));
    const missing = new Map((invited?.missingInvitees ?? []).map((m) => [userId(Number(m.userId)), m]));
    const added: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of sent) {
      const m = missing.get(id);
      if (m) failed.push({ id, reason: m.premiumWouldAllowInvite ? PREMIUM_ONLY : PRIVACY });
      else added.push(id);
    }
    return { added, failed };
  }

  private async profile(who: string): Promise<P.PersonAbout> {
    if (who.startsWith('channel:')) {
      const id = Number(who.slice(8));
      const full = await this.call({ _: 'channels.getFullChannel', channel: this.inputChannel(id) });
      this.ingest(full.users, full.chats);
      const c = full.chats.find((x) => Number(x.id) === id);
      const uname = c && c._ === 'channel' ? usernameOf(c) : undefined;
      return {
        ...(c && 'title' in c ? { displayName: c.title } : {}),
        ...(uname ? { handle: `@${uname}`, links: [{ label: 'Link', value: `t.me/${uname}`, url: `https://t.me/${uname}` }] } : {}),
        ...(full.fullChat.about ? { bio: full.fullChat.about } : {}),
        facts: [{ label: 'Telegram id', value: markedId({ kind: 'channel', id }) }],
      };
    }
    const id = Number(who);
    if (!Number.isFinite(id) || id <= 0) throw new Error(`not a Telegram user: ${who}`);
    const res = await this.call({ _: 'users.getFullUser', id: this.inputUser(id) });
    this.ingest(res.users, res.chats, true);
    const u = res.users.find((x) => Number(x.id) === id);
    const f = res.fullUser;
    if (u?._ !== 'user') throw new Error('Telegram did not describe them');
    // What Telegram says of them now is what the lists say from here on.
    if (id !== this.selfId) this.setRelation(id, !!(u.contact || u.mutualContact), !!f.blocked);
    const uname = usernameOf(u);
    const links: { label: string; value: string; url?: string }[] = [];
    if (uname) links.push({ label: 'Username', value: `@${uname}`, url: `https://t.me/${uname}` });
    if (u.phone) links.push({ label: 'Phone', value: `+${u.phone}` });
    const facts: { label: string; value: string }[] = [];
    if (f.commonChatsCount) facts.push({ label: 'Groups in common', value: String(f.commonChatsCount) });
    if (f.birthday) facts.push({ label: 'Birthday', value: `${f.birthday.year ? `${f.birthday.year}-` : ''}${String(f.birthday.month).padStart(2, '0')}-${String(f.birthday.day).padStart(2, '0')}` });
    if (u.bot) facts.push({ label: 'Bot', value: 'yes' });
    if (u.premium) facts.push({ label: 'Telegram Premium', value: 'yes' });
    facts.push({ label: 'Telegram id', value: String(id) });
    const out: P.PersonAbout = {
      displayName: displayName(u),
      ...(uname ? { handle: `@${uname}` } : u.phone ? { handle: `+${u.phone}` } : {}),
      ...(u.photo?._ === 'userProfilePhoto' ? { avatar: identityOfUser(u, this.selfId)?.avatarUrl } : {}),
      ...(f.about ? { bio: f.about } : {}),
      relationship: f.blocked ? 'blocked' : u.contact || u.mutualContact ? 'contact' : id === this.selfId ? 'contact' : 'stranger',
      ...(links.length ? { links } : {}),
      facts,
    };
    if (id === this.selfId) {
      const contacts = await this.call({ _: 'contacts.getContacts', hash: ZERO });
      if (contacts._ === 'contacts.contacts') {
        this.ingest(contacts.users, []);
        out.friends = contacts.contacts.map((c) => userId(Number(c.userId)));
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- helpers

/** Lookups (resolve) read, so a short flood wait may be waited out; acts are sent once (pacer.ts). */
const LOOKUP = { maxWaitMs: 10_000 } as const;
const ACT = { once: true } as const;
const LOOKING = 'looking up more names and links';
const JOINING = 'joining more groups and channels';
const ADDING = 'adding more contacts';
const ANSWERING = 'answering more join requests';
const REMOVING = 'removing more contacts';
const UNBLOCKING = 'unblocking more people';

const PRIVATE = 'This group or channel is private, or you were removed from it';
const NO_PHONE = 'No Telegram account has this number, or its owner hides it';
const TOO_MANY = 'You are in too many groups and channels: Telegram allows 500 (1000 with Premium), so leave some first';
const INVITE_WORDS: Record<string, string> = {
  INVITE_HASH_EXPIRED: 'This invite link has expired or was revoked',
  INVITE_HASH_INVALID: 'Telegram does not know this invite link: it may be mistyped, or it was revoked',
  INVITE_HASH_EMPTY: 'Telegram does not know this invite link: it may be mistyped, or it was revoked',
  CHANNEL_PRIVATE: PRIVATE,
  CHANNELS_TOO_MUCH: TOO_MANY,
  USERS_TOO_MUCH: 'This group is full',
  STARS_PAYMENT_REQUIRED: 'Joining this costs Telegram Stars: join it from a Telegram app',
  CHAT_INVALID: 'Telegram does not know this group or channel any more',
  CHANNEL_INVALID: 'Telegram does not know this group or channel any more',
};
const PLACE_WORDS: Record<string, string> = { ...INVITE_WORDS, USER_BANNED_IN_CHANNEL: 'You are banned from this group or channel' };
const CONTACT_WORDS: Record<string, string> = {
  CONTACT_ID_INVALID: 'Telegram does not let you add this account as a contact',
  CONTACT_NAME_EMPTY: 'Telegram wants a name for this contact, and this account shows none',
  FIRSTNAME_INVALID: 'Telegram wants a name for this contact, and this account shows none',
};
const ANSWER_WORDS: Record<string, string> = {
  CHAT_ADMIN_REQUIRED: 'Only admins who may add members answer join requests here',
  USER_CHANNELS_TOO_MUCH: 'They are in too many groups and channels to join another',
  CHANNELS_TOO_MUCH: 'They are in too many groups and channels to join another',
  USERS_TOO_MUCH: 'This group is full',
  CHANNEL_PRIVATE: 'This group or channel is no longer one you admin',
};
const REMOVE_WORDS: Record<string, string> = {
  CONTACT_ID_INVALID: 'Telegram does not know this account any more',
  PEER_ID_INVALID: 'Telegram does not know this account any more',
  USER_ID_INVALID: 'Telegram does not know this account any more',
  INPUT_USER_DEACTIVATED: 'This account was deleted',
};
/** For anything that adds: what Telegram says when it limits the account as a whole. */
const LIMIT_WORDS: Record<string, string> = {
  PEER_FLOOD: 'Telegram limits this account for now: it may not reach new people or groups for a while (in a Telegram app, @SpamBot says until when)',
  FROZEN_METHOD_INVALID: 'Telegram has frozen this account: it cannot do this until Telegram lifts the freeze',
};

/** Telegram's error code in what a call threw ("contacts.resolveUsername: USERNAME_NOT_OCCUPIED" gives the code). */
const tgCode = (e: unknown) => rpcText(e).replace(/^[\w.]+: /, '');

/** An add command's failure in plain words: a flood wait says when it frees up; Telegram's codes their sentence. */
function addFailure(e: unknown, doing: string, words: Record<string, string>): Error {
  if (e instanceof FloodError) return new Error(floodSentence(doing, e.seconds));
  const code = tgCode(e);
  const sentence = words[code] ?? LIMIT_WORDS[code] ?? (code.startsWith('FROZEN_') ? LIMIT_WORDS.FROZEN_METHOD_INVALID : undefined);
  return sentence ? new Error(sentence) : e instanceof Error ? e : new Error(String(e));
}

const MAKING_GROUPS = 'making more groups';
/**
 * messages.createChat refused as a whole: nothing was made. The codes mtcute 0.32.7's tl/raw-errors.json lists for it
 * (layer 232), and the privacy and group-count refusals Telegram gives elsewhere for the same people.
 */
const CREATE_WORDS: Record<string, string> = {
  USER_PRIVACY_RESTRICTED: "Their privacy settings don't let you add them",
  USERS_TOO_FEW: 'Telegram wants at least one person it lets you add',
  USERS_TOO_MUCH: 'Telegram took too many people for a new group: make it with fewer and add the rest after',
  CHAT_TITLE_EMPTY: 'Give the group a name',
  CHANNELS_TOO_MUCH: TOO_MANY,
  INPUT_USER_DEACTIVATED: 'This account was deleted',
  USER_RESTRICTED: 'Telegram limits this account for now: it may not make groups for a while',
  CHAT_MEMBER_ADD_FAILED: 'Telegram could not put them in a new group: try with someone else, or add them after',
  CHAT_ID_GENERATE_FAILED: 'Telegram could not make the group just now: nothing was made, try again in a minute',
};

/** The basic group messages.createChat made: the chat its "created the group" message is in, or the one chat it sent. */
export function createdChat(updates: tl.TypeUpdates): tl.RawChat | null {
  if (updates._ !== 'updates' && updates._ !== 'updatesCombined') return null;
  const chats = updates.chats.filter((c): c is tl.RawChat => c._ === 'chat');
  for (const u of updates.updates) {
    if (u._ !== 'updateNewMessage' || u.message._ !== 'messageService' || u.message.action._ !== 'messageActionChatCreate') continue;
    const p = u.message.peerId;
    if (p._ !== 'peerChat') continue;
    const c = chats.find((x) => Number(x.id) === Number(p.chatId));
    if (c) return c;
  }
  return chats.length === 1 ? chats[0] : null;
}

/** A basic group holds this many; Telegram's apps make it a supergroup to grow past it. */
const BASIC_GROUP_MAX = 200;
const ADDING_PEOPLE = 'adding more people to groups';
const ONLY_ADMINS_ADD = 'Only admins can add people here';
const BASIC_FULL = 'This group is full: a basic group holds 200 people';
const NOT_SEEN = 'Telegram needs to have seen them first';
const PRIVACY = "Their privacy settings don't let you add them";
const PREMIUM_ONLY = 'They let only Telegram Premium users add them';
/** Telegram refuses one person: the rest still go. */
const PERSON_WORDS: Record<string, string> = {
  USER_PRIVACY_RESTRICTED: PRIVACY,
  USER_NOT_MUTUAL_CONTACT: 'Telegram adds them here only if you are mutual contacts',
  USER_CHANNELS_TOO_MUCH: 'They are in too many groups and channels to join another',
  USER_KICKED: 'They were removed from here: an admin has to unban them first',
  USER_BOT: 'A bot joins a channel only as an admin',
  BOT_GROUPS_BLOCKED: 'This bot cannot be added to groups',
  INPUT_USER_DEACTIVATED: 'This account was deleted',
  USER_ID_INVALID: 'Telegram does not know this account',
};
/** Telegram refuses the group itself: nobody else is tried. */
const GROUP_WORDS: Record<string, string> = {
  CHAT_ADMIN_REQUIRED: ONLY_ADMINS_ADD,
  CHAT_WRITE_FORBIDDEN: ONLY_ADMINS_ADD,
  USERS_TOO_MUCH: 'Telegram lets no more people be added here',
  CHANNEL_PRIVATE: PRIVATE,
  CHAT_ID_INVALID: 'Telegram does not know this group or channel any more',
  CHANNEL_INVALID: 'Telegram does not know this group or channel any more',
};

/**
 * What a refusal to add someone means: in after all (USER_ALREADY_PARTICIPANT), refused with a sentence, or a stop
 * for everyone not yet tried (a flood wait, PEER_FLOOD, a frozen account, the group itself). Anything else is that
 * person's, in Telegram's words.
 */
function addRefusal(e: unknown): { in: true } | { in: false; reason: string; stop: boolean } {
  if (e instanceof FloodError) return { in: false, reason: floodSentence(ADDING_PEOPLE, e.seconds), stop: true };
  const code = tgCode(e);
  if (code === 'USER_ALREADY_PARTICIPANT') return { in: true };
  if (PERSON_WORDS[code]) return { in: false, reason: PERSON_WORDS[code], stop: false };
  const whole = GROUP_WORDS[code] ?? LIMIT_WORDS[code] ?? (code.startsWith('FROZEN_') ? LIMIT_WORDS.FROZEN_METHOD_INVALID : undefined);
  if (whole) return { in: false, reason: whole, stop: true };
  return { in: false, reason: /^[A-Z0-9_]+$/.test(code) ? `Telegram refused: ${code}` : code, stop: false };
}

/** About's `adding`: Telegram adds anyone this account knows, as far as their privacy settings let it. */
function addingOf(can: boolean, why: string, room?: number): P.AboutAdding {
  return { can, ...(can ? {} : { reason: why }), who: 'known', mode: 'add', ...(room !== undefined ? { room } : {}) };
}

/** "Telegram asks this account to wait before joining more groups and channels: try again in 5 minutes (after 21:37 UTC)". */
export function floodSentence(doing: string, seconds: number, now = Date.now()): string {
  return `Telegram asks this account to wait before ${doing}: try again in ${waitWords(seconds)} (after ${clockUtc(now + seconds * 1000, seconds > 20 * 3600)})`;
}

/** How long, in words: "45 seconds", "5 minutes", "about 3 hours", "about 2 days". */
export function waitWords(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} minutes`;
  const h = Math.round(s / 3600);
  if (h < 48) return `about ${h} hours`;
  return `about ${Math.round(s / 86_400)} days`;
}

function clockUtc(ms: number, withDate: boolean): string {
  const iso = new Date(ms).toISOString();
  return `${withDate ? `${iso.slice(0, 10)} ` : ''}${iso.slice(11, 16)} UTC`;
}

/**
 * contacts.getContacts's hash of the list as known (core.telegram.org/api/offsets#hash-generation): the saved count,
 * then the contacts' user ids in order, folded as Telegram's apps do. A list that is the same comes back as
 * contactsNotModified. (A wrong hash only means the whole list is sent.)
 */
export function contactsHash(savedCount: number, ids: Iterable<number>): Long {
  const MASK = (1n << 64n) - 1n;
  let acc = 0n;
  for (const n of [savedCount, ...[...ids].sort((a, b) => a - b)]) {
    acc ^= acc >> 21n;
    acc ^= (acc << 35n) & MASK;
    acc ^= acc >> 4n;
    acc = (acc + BigInt(n)) & MASK;
  }
  return Long.fromString(BigInt.asIntN(64, acc).toString());
}

function nameList(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

const asked = (): P.AddResult => ({ pending: true, notes: ['Asked; the admins decide'] });

function chatPeer(c: tl.TypeChat): PeerRef | null {
  if (c._ === 'chat' || c._ === 'chatForbidden') return { kind: 'chat', id: Number(c.id) };
  if (c._ === 'channel' || c._ === 'channelForbidden') return { kind: 'channel', id: Number(c.id) };
  return null;
}

/** A join's updates without the joined chat's own updateChannel/updateChat (its dialog is read right after). */
function withoutRefresh(ups: tl.TypeUpdates, peer: PeerRef): tl.TypeUpdates {
  if (ups._ !== 'updates' && ups._ !== 'updatesCombined') return ups;
  const own = (u: tl.TypeUpdate) => (u._ === 'updateChannel' && peer.kind === 'channel' && Number(u.channelId) === peer.id) || (u._ === 'updateChat' && peer.kind === 'chat' && Number(u.chatId) === peer.id);
  return { ...ups, updates: ups.updates.filter((u) => !own(u)) };
}

/** A topic's place among its forum's channels: pinned ones first, then by creation (General, topic 1, leads). */
export function topicPosition(topic: number, pinned: boolean): string {
  return `${pinned ? 0 : 1}:${String(topic).padStart(12, '0')}`;
}

/** A join request as the hub keeps it: from whom, to which chat, answered with accept or decline. */
function requestFact(conv: string, c: tl.TypeChat, user: number, date: number): P.RequestFact {
  const name = 'title' in c ? c.title : undefined;
  const members = (c._ === 'chat' || c._ === 'channel') && typeof c.participantsCount === 'number' ? c.participantsCount : undefined;
  return {
    nativeId: joinRequestId(conv, user),
    kind: 'join',
    from: userId(user),
    target: { kind: 'conversation', nativeId: conv, ...(name ? { name } : {}), ...(members !== undefined ? { members } : {}) },
    ts: date * 1000,
    answers: ['accept', 'decline'],
  };
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** An entity as sent (a mention names an InputUser) as Telegram shows it back (a user id). */
export function outputEntity(e: tl.TypeMessageEntity): tl.TypeMessageEntity {
  if (e._ !== 'inputMessageEntityMentionName') return e;
  const u = e.userId;
  return { _: 'messageEntityMentionName', offset: e.offset, length: e.length, userId: u._ === 'inputUser' ? Number(u.userId) : 0 };
}

function peerKeyOf(p: tl.TypePeer): string {
  const r = peerOf(p);
  return `${r.kind}:${r.id}`;
}

function toPeer(p: PeerRef): tl.TypePeer {
  if (p.kind === 'user') return { _: 'peerUser', userId: p.id };
  if (p.kind === 'chat') return { _: 'peerChat', chatId: p.id };
  return { _: 'peerChannel', channelId: p.id };
}

function adminRole(p: tl.TypeChannelParticipant | undefined): string | null {
  if (!p) return null;
  if (p._ === 'channelParticipantCreator') return 'Owner';
  if (p._ === 'channelParticipantAdmin') return 'Admin';
  return null;
}

function rulesOf(banned: tl.TypeChatBannedRights | undefined, you: boolean): P.AboutRule[] {
  const who = (blocked: boolean | undefined) => (blocked ? 'Admins' : 'Everyone');
  const yes = (blocked: boolean | undefined) => you || !blocked;
  return [
    { what: 'Send messages', who: who(banned?.sendMessages), you: yes(banned?.sendMessages) },
    { what: 'Send media', who: who(banned?.sendMedia), you: yes(banned?.sendMedia) },
    { what: 'Add members', who: who(banned?.inviteUsers), you: yes(banned?.inviteUsers) },
    { what: 'Pin messages', who: who(banned?.pinMessages), you: yes(banned?.pinMessages) },
    { what: 'Change the info', who: who(banned?.changeInfo), you: yes(banned?.changeInfo) },
  ];
}

/** Where a message's file is, to download it. */
export function locationOf(media: tl.TypeMessageMedia): { location: tl.TypeInputFileLocation; dcId: number; size: number; mime: string } | null {
  if (media._ === 'messageMediaPhoto' && media.photo?._ === 'photo') {
    const big = largestPhotoSize(media.photo.sizes);
    if (!big) return null;
    return { location: { _: 'inputPhotoFileLocation', id: media.photo.id, accessHash: media.photo.accessHash, fileReference: media.photo.fileReference, thumbSize: big.type }, dcId: media.photo.dcId, size: big.size, mime: 'image/jpeg' };
  }
  if (media._ === 'messageMediaDocument' && media.document?._ === 'document') {
    const d = media.document;
    return { location: { _: 'inputDocumentFileLocation', id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, thumbSize: '' }, dcId: d.dcId, size: Number(d.size), mime: d.mimeType };
  }
  return null;
}

function codeMessage(sent: SentCode, phone: string): string {
  const where =
    sent.type === 'app'
      ? 'your other Telegram app (look for a message from Telegram)'
      : sent.type === 'sms'
        ? `an SMS to ${redactPhone(phone)}`
        : sent.type === 'call'
          ? `a phone call to ${redactPhone(phone)}`
          : sent.type === 'email'
            ? 'your login email'
            : sent.type === 'fragment'
              ? 'fragment.com'
              : sent.type;
  return `Telegram sent a${sent.length ? ` ${sent.length}-digit` : ''} code to ${where}. Enter it here to sign in.`;
}

/** auth.acceptLoginToken did not work on Telegram Desktop's key: the account shares that key instead. */
class AcceptRefused extends Error {
  constructor(readonly cause: unknown) {
    super(`auth.acceptLoginToken: ${rpcText(cause)}`);
  }
}
