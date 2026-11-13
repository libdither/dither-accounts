/**
 * The Matrix adapter: one Client-Server API session per hub account.
 *
 *   login (password -> access token, saved to secret.json) or whoami
 *   /sync loop with a lazy-loading filter, resuming from the stored since token
 *   joined-room state -> SpaceFact / ConversationFact / IdentityFact
 *   timeline events -> MessageFact, reaction, delete, read, typing
 *   hub commands -> send, openDirect, history, markRead, react, edit, redact, fetchMedia, about, configure, addMembers, createGroup, actions
 *   adding (add.ts) -> resolve, add (join, knock), answer; invites and knocks as requests
 *
 * Initial sync emits facts with live=false (backfill, no notifications);
 * incremental syncs emit live=true.
 *
 * End-to-end encryption is opt-in per account (see e2ee.ts). Whatever its state, an encrypted
 * room gets encrypted writes or none: every event goes out through sendEvent, every upload
 * through uploadFile, and both refuse when the crypto layer is not running.
 */

import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey } from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { addMembers, configureAbout, createGroup, readAbout, type AboutHost, type GroupHost } from './about.ts';
import { add, answer, answersKnocks, Requests, resolve, type AddHost } from './add.ts';
import { AdapterDb, type ThreadRow, type UtdRow } from './db.ts';
import type { E2ee, VerificationState } from './e2ee.ts';
import { markdownToMatrix, snippet } from './format.ts';
import { listAsDirect, openDirect, type DirectHost } from './direct.ts';
import { pinChanges, presenceOf, receiptEvents, roleChanges, statusOf } from './history.ts';
import { enc, MatrixClient, MatrixError } from './http.ts';
import { encryptedFileOf, FORWARD_KEY, forwardableContent, forwardOf, isRedacted, mentionsUser, MESSAGE_TYPES, plainTextOf, relationOf, renderContent, replyTarget, type Relation } from './messages.ts';
import { Directory, Room, STRUCTURAL, type MxEvent } from './rooms.ts';
import { searchBody, searchKey, SearchPages, type SearchCommand } from './search.ts';

export const VERSION = '0.1.0';
// Adding (add.ts): resolve, join (and knock), requests. Not 'connect': Matrix has no friends, follows or contacts to add.
// addMembers (about.ts): invites to a room. createGroup (about.ts): a new room, then those invites.
const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'threads', 'media', 'sendMedia', 'openDirect', 'forward', 'about', 'configure', 'profile', 'resolve', 'join', 'requests', 'addMembers', 'createGroup', 'search'];

const SYNC_TIMEOUT = 30_000;
/**
 * While a device verification runs: the library cancels its emoji step when nothing arrives for 60 s,
 * checked at each sync before the sync's messages are read. A connection that died without a reset
 * would hold a 30 s long poll for a minute, so poll briefly and give up on a silent one sooner.
 */
const VERIFY_SYNC_TIMEOUT = 5_000;
const VERIFY_SYNC_GIVE_UP = 20_000;
const TIMELINE_LIMIT = 50;
const GAP_PAGES = 4;
const MAX_MEDIA = 24 * 1024 * 1024;
const KEEP_EVENTS = 200_000;
const BACKOFF = [1, 2, 5, 10, 30, 60];

/** The sync filter. Presence only from the people m.direct names (their status messages), never everyone in a big room. */
export function syncFilter(contacts: string[]) {
  return {
    room: {
      state: { lazy_load_members: true },
      timeline: { limit: TIMELINE_LIMIT, lazy_load_members: true, unread_thread_notifications: true },
      ephemeral: { types: ['m.receipt', 'm.typing'] },
      account_data: { types: ['m.fully_read'] },
    },
    presence: contacts.length ? { types: ['m.presence'], senders: contacts } : { not_types: ['*'] },
    account_data: { types: ['m.direct', 'm.push_rules'] },
  };
}
/** Describe a custom emoji reaction: its key is the image's mxc: URI. */
function packEmoji(url: string, shortcode?: unknown): P.CustomEmojiFact {
  const name = typeof shortcode === 'string' ? shortcode.replace(/^:|:$/g, '') : '';
  return { key: url, name: name || 'custom emoji', url };
}

/** An MSC2545 image pack, keeping the images usable as emoji (no `usage`, or one that lists emoticon). */
function imagePack(id: string, fallbackName: string, content: any): P.ReactionContext['custom'][number] | null {
  const packUsage: unknown = content?.pack?.usage;
  const usableAs = (u: unknown) => !Array.isArray(u) || u.includes('emoticon');
  if (!content?.images || !usableAs(packUsage)) return null;
  const emoji: P.CustomEmojiFact[] = [];
  for (const [name, img] of Object.entries<any>(content.images)) {
    if (typeof img?.url === 'string' && img.url.startsWith('mxc://') && usableAs(img.usage)) emoji.push({ key: img.url, name, url: img.url });
  }
  const icon = content.pack?.avatar_url;
  return { id, name: typeof content.pack?.display_name === 'string' ? content.pack.display_name : fallbackName, ...(typeof icon === 'string' ? { icon } : {}), emoji };
}

const LAZY = JSON.stringify({ lazy_load_members: true });

/**
 * A sync without a since token, for its rooms.invite only: what an account that synced before invites were followed
 * needs once, since incremental syncs name each invite only when it arrives. As little else as the filter allows: no
 * state, one timeline event a room (with none, Synapse keeps loading events looking for one that passes).
 */
export const INVITES_ONLY = {
  room: { state: { types: [], lazy_load_members: true }, timeline: { limit: 1 }, ephemeral: { types: [] }, account_data: { types: [] } },
  presence: { types: [] },
  account_data: { types: [] },
};
const SNAPSHOT_RETRY_MS = 10 * 60_000;

interface Config {
  homeserver?: string;
  userId?: string;
}

interface Secret {
  password?: string;
  accessToken?: string;
  deviceId?: string;
  userId?: string;
  /** Set by the setupEncryption action only: creating the crypto store publishes a new device's keys. */
  e2ee?: {
    on: boolean;
    /** 32 random bytes, base64. Encrypts the values in crypto.sqlite. */
    storeKey: string;
    recoveryKey?: string;
  };
}

type Mode = 'sync' | 'gap' | 'history' | 'fetch';
interface Ctx {
  live: boolean;
  mode: Mode;
  /** Message facts emitted (history replies with this). */
  count: number;
  /** The ts of the oldest of them (history's `oldest`). */
  oldest?: number;
  /** Their native ids, in the order emitted (search's hits). */
  hits?: string[];
}

class NeedsLogin extends Error {}
class Restart extends Error {}
class DeviceMismatch extends Error {}

const describe = (e: unknown) => (e instanceof MatrixError ? `${e.errcode}: ${e.error}` : String((e as any)?.message ?? e));
const threadId = (roomId: string, root: string) => `${roomId}|${root}`;

/** How long a start we send lasts on the server without another (ours come every 8 s while you type). */
export const MATRIX_TYPING_TIMEOUT = 15_000;
/** A typer the server keeps listing: Element refreshes its 30 s timeout while its user types. */
export const MATRIX_TYPING_TTL = 30_000;

/** One m.typing list against the one before it: starts for everyone on it, stops for everyone who left it. */
export function typingEvents(room: string, before: Set<string> | undefined, userIds: unknown[], self: string, name: (u: string) => string | undefined): { events: P.AdapterEvent[]; now: Set<string> } {
  const now = new Set(userIds.filter((u): u is string => typeof u === 'string' && u !== self));
  const events: P.AdapterEvent[] = [];
  for (const u of now) {
    const n = name(u);
    events.push({ t: 'typing', conversation: room, author: u, ttl: MATRIX_TYPING_TTL, ...(n ? { name: n } : {}) });
  }
  for (const u of before ?? []) if (!now.has(u)) events.push({ t: 'typing', conversation: room, author: u, stop: true });
  return { events, now };
}

export function splitConversation(id: string): { roomId: string; root?: string } {
  const i = id.indexOf('|');
  return i < 0 ? { roomId: id } : { roomId: id.slice(0, i), root: id.slice(i + 1) };
}

export class MatrixAdapter {
  private hub!: HubLink;
  private db!: AdapterDb;
  private config: Config = {};
  private dir = new Directory('');
  private client: MatrixClient | null = null;
  private selfId = '';
  private deviceId = '';
  private self: P.IdentityFact | null = null;
  private status: P.AccountStatus = 'connecting';
  private attention: Omit<P.Attention, 'since'> | null = null;
  /** Last JSON emitted per fact key, so unchanged structure isn't re-sent every sync. */
  private emitted = new Map<string, string>();
  /** The next_batch tokens of searches the hub is paging through. */
  private searchPages = new SearchPages();
  private pendingIdentities = new Map<string, P.IdentityFact>();
  private recentTs = new Map<string, number>();
  /** Invites and knocks waiting on this account (add.ts). */
  private requests!: Requests;
  /** Knocks on rooms this account admits are fetched once per process, after its first sync. */
  private knocksLoaded = false;
  /** When to try listing invites again after the snapshot failed. */
  private snapshotAfter = 0;
  private syncAbort: AbortController | null = null;
  private restartSession = false;
  private wakeUp: (() => void) | null = null;
  private resyncWaiters: ((rooms: number) => void)[] = [];
  private online = false;
  private stopped = false;
  private e2ee: E2ee | null = null;
  /** Encryption is switched on for this account but the crypto layer could not start. */
  private e2eeError: string | null = null;
  private verification: VerificationState | null = null;
  private recoveryError: string | null = null;
  /** What the last recovery key that opened something did, and what it could not. */
  private recovery: { backup: boolean; crossSigned: boolean; problems: string[] } | null = null;
  /** Sessions whose key just arrived, waiting for their events to be retried. */
  private keysArrived = new Set<string>();
  private retrying = false;
  /** Who a room's key goes to, per room. Dropped when a membership changes. */
  private encryptionMembers = new Map<string, string[]>();
  /** Who each room's last m.typing listed, and a timer saying so again while the list stands (the server only sends changes). */
  private typers = new Map<string, { users: Set<string>; at: number }>();
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  /** For status.layers: the homeserver this session uses, why the last session did not start, why sync fails. */
  private homeserverUrl: string | null = null;
  private sessionFailure: { message: string; failures: number } | null = null;
  private syncFailure: { message: string; failures: number } | null = null;
  private sentLayers = '';

  // ================================================================ lifecycle

  start(hub: HubLink) {
    this.hub = hub;
    this.config = hub.config as Config;
    this.db = new AdapterDb(join(hub.accountDir, 'matrix.sqlite'));
    for (const r of this.db.loadRooms()) this.dir.rooms.set(r.id, r);
    this.dir.setDirect(JSON.parse(this.db.get('m.direct') ?? '{}'));
    this.dir.pushRules = JSON.parse(this.db.get('m.push_rules') ?? 'null');
    this.requests = new Requests({
      dir: this.dir,
      kv: { get: (k) => this.db.get(k), set: (k, v) => this.db.set(k, v) },
      emit: (ev) => this.hub.emit(ev),
      identity: (f) => this.emitIdentity(f, true),
    });
    this.requests.load();
    const pruned = this.db.prune(KEEP_EVENTS);
    if (pruned) this.log('info', `pruned ${pruned} old events from the local index`);
    this.run().catch((e) => this.log('error', `adapter loop crashed: ${describe(e)}`));
  }

  /** Every (re)connect to the hub: hello, status, and a snapshot of the structure. */
  onConnect() {
    this.emitHello();
    this.emitStatus();
    if (!this.selfId) return;
    this.emitted.clear();
    this.emitStructure();
    this.emitThreads();
    this.requests.reconnected();
  }

  async shutdown() {
    this.stopped = true;
    clearInterval(this.typingTimer);
    this.syncAbort?.abort();
    this.wakeUp?.();
    try {
      this.e2ee?.close();
      this.e2ee = null;
    } catch {}
    try {
      this.db?.close();
    } catch {}
  }

  private emitHello() {
    this.hub.emit({ t: 'hello', network: 'matrix', version: VERSION, capabilities: this.e2ee ? [...CAPABILITIES, 'e2ee'] : CAPABILITIES });
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) {
    // The hub appends these to adapter.log; only fall back to stdout (also captured there) while disconnected.
    if (this.hub.connected) this.hub.emit({ t: 'log', level, msg, ...(data !== undefined ? { data } : {}) });
    else if (level !== 'debug') console.log(`[${level}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);
  }

  private emitStatus() {
    const layers = this.layers();
    this.sentLayers = JSON.stringify(layers);
    this.hub.emit({ t: 'status', status: this.status, attention: this.attention, ...(this.self ? { self: this.self } : {}), layers });
  }

  private setStatus(status: P.AccountStatus, attention: Omit<P.Attention, 'since'> | null) {
    const same = status === this.status && JSON.stringify(attention) === JSON.stringify(this.attention);
    this.status = status;
    this.attention = attention;
    if (same && JSON.stringify(this.layers()) === this.sentLayers) return;
    this.emitStatus();
  }

  /**
   * What the account rests on (status.layers): the homeserver, the sign-in, sync, and encryption as a layer of its
   * own ('off' when it is not set up). Only what the adapter already knows; the first layer not ok is where it stops.
   */
  private layers(): P.StatusLayer[] {
    const login = this.status === 'attention' && this.attention?.kind === 'login' ? this.attention.message : null;
    const sf = this.sessionFailure;
    const yf = this.syncFailure;
    const homeserver: P.StatusLayer = sf
      ? { name: 'homeserver', state: sf.failures >= 3 ? 'failed' : 'waiting', note: `cannot start a session: ${sf.message}` }
      : this.homeserverUrl
        ? { name: 'homeserver', state: 'ok', note: this.homeserverUrl }
        : login
          ? { name: 'homeserver', state: 'failed', note: login }
          : { name: 'homeserver', state: 'waiting', note: 'finding it' };
    const signedIn: P.StatusLayer =
      login && this.homeserverUrl
        ? { name: 'signed in', state: 'failed', note: login }
        : this.selfId && !sf
          ? { name: 'signed in', state: 'ok', note: `${this.selfId}${this.deviceId ? `, device ${this.deviceId}` : ''}` }
          : { name: 'signed in', state: 'waiting', note: 'waits for the homeserver' };
    const sync: P.StatusLayer = yf
      ? { name: 'sync', state: yf.failures >= 4 ? 'failed' : 'waiting', note: `failing: ${yf.message}` }
      : this.online && this.status !== 'error'
        ? { name: 'sync', state: 'ok', note: `${this.dir.joined().filter((r) => !r.isSpace).length} rooms` }
        : this.selfId && !sf && !login
          ? { name: 'sync', state: 'waiting', note: 'the first sync' }
          : { name: 'sync', state: 'waiting', note: 'waits for the sign-in' };
    let on = false;
    try {
      on = !!this.hub.secret<Secret>().e2ee?.on;
    } catch {}
    const encryption: P.StatusLayer = !on
      ? { name: 'encryption', state: 'off', note: 'not set up' }
      : this.e2ee
        ? { name: 'encryption', state: 'ok', note: `device ${this.deviceId}` }
        : this.e2eeError
          ? { name: 'encryption', state: 'failed', note: this.e2eeError }
          : { name: 'encryption', state: 'waiting', note: 'starting' };
    return [homeserver, signedIn, sync, encryption];
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      this.wakeUp = () => {
        clearTimeout(t);
        r();
      };
    }).finally(() => (this.wakeUp = null));
  }

  private async run() {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.session();
        failures = 0;
        await this.syncLoop();
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof Restart) continue;
        if (e instanceof NeedsLogin) {
          this.online = false;
          this.sessionFailure = this.syncFailure = null;
          this.log('warn', `needs login: ${e.message}`);
          this.setStatus('attention', { kind: 'login', message: e.message });
          await this.waitForCredentials();
          continue;
        }
        failures++;
        this.sessionFailure = { message: describe(e), failures };
        const delay = BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)];
        this.log('warn', `homeserver session failed (${describe(e)}); retrying in ${delay}s`);
        if (failures >= 3) this.setStatus('error', { kind: 'unknown', message: `Cannot reach the homeserver: ${describe(e)}` });
        else this.setStatus('connecting', null);
        await this.sleep(delay * 1000);
      }
    }
  }

  /** In attention: wait for the relogin action or an edited secret.json. */
  private async waitForCredentials() {
    const before = JSON.stringify(this.hub.secret());
    while (!this.stopped) {
      await this.sleep(15_000);
      if (this.restartSession) {
        this.restartSession = false;
        return;
      }
      if (JSON.stringify(this.hub.secret()) !== before) return;
    }
  }

  // ================================================================ session

  private async homeserver(userHint?: string): Promise<string> {
    const cfg = typeof this.config.homeserver === 'string' ? this.config.homeserver.trim().replace(/\/+$/, '') : '';
    if (cfg) return /^https?:\/\//.test(cfg) ? cfg : `https://${cfg}`;
    const server = userHint?.split(':').slice(1).join(':');
    if (!server) throw new NeedsLogin('Set "homeserver" (and "userId") in the account config.');
    try {
      const res = await fetch(`https://${server}/.well-known/matrix/client`, { signal: AbortSignal.timeout(10_000) });
      const base = res.ok ? ((await res.json()) as any)?.['m.homeserver']?.base_url : null;
      if (typeof base === 'string' && /^https?:\/\//.test(base)) return base.replace(/\/+$/, '');
    } catch {}
    return `https://${server}`;
  }

  private async session() {
    this.restartSession = false;
    const secret = this.hub.secret<Secret>();
    const userHint = secret.userId ?? this.config.userId;
    const client = new MatrixClient(await this.homeserver(userHint));
    this.homeserverUrl = client.baseUrl;
    if (secret.accessToken) {
      client.accessToken = secret.accessToken;
      try {
        const who = await client.request('GET', '/_matrix/client/v3/account/whoami');
        this.adopt(client, who.user_id, who.device_id ?? secret.deviceId ?? '');
      } catch (e) {
        if (!(e instanceof MatrixError && e.isAuth)) throw e;
        if (!secret.password) {
          throw new NeedsLogin(`The homeserver rejected the access token (${e.errcode}). Run the "relogin" action with {"password": "..."}.`);
        }
        this.log('info', 'access token rejected; logging in with the stored password');
        await this.login(client, secret, userHint);
      }
    } else if (secret.password) {
      await this.login(client, secret, userHint);
    } else {
      throw new NeedsLogin('No password or access token in secret.json.');
    }

    let profile: { displayname?: string; avatar_url?: string } = {};
    try {
      profile = await client.request('GET', `/_matrix/client/v3/profile/${enc(this.selfId)}`, { retries: 1 });
    } catch (e) {
      this.log('debug', `profile lookup failed: ${describe(e)}`);
    }
    this.self = { nativeId: this.selfId, handle: this.selfId, isSelf: true };
    if (profile.displayname) this.self.displayName = profile.displayname;
    if (typeof profile.avatar_url === 'string' && profile.avatar_url.startsWith('mxc://')) this.self.avatarUrl = profile.avatar_url;
    this.sessionFailure = null;
    this.attention = this.e2eeAttention();
    this.status = this.online ? 'online' : 'connecting';
    this.emitStatus();
    this.log('info', `session ready: ${this.selfId} device ${this.deviceId} on ${client.baseUrl}`);
    if (this.hub.secret<Secret>().e2ee?.on) await this.startE2ee();
  }

  private async login(client: MatrixClient, secret: Secret, user: string | undefined) {
    if (!user) throw new NeedsLogin('Set "userId" in the account config or secret to log in with a password.');
    let res: any;
    try {
      res = await client.request('POST', '/_matrix/client/v3/login', {
        auth: false,
        retries: 2,
        body: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: secret.password,
          initial_device_display_name: 'dither-chat',
          ...(secret.deviceId ? { device_id: secret.deviceId } : {}),
        },
      });
    } catch (e) {
      if (e instanceof MatrixError && (e.status === 403 || e.errcode === 'M_FORBIDDEN' || e.errcode === 'M_USER_DEACTIVATED' || e.errcode === 'M_INVALID_USERNAME')) {
        throw new NeedsLogin(`Login failed: ${e.error}`);
      }
      throw e;
    }
    client.accessToken = res.access_token;
    const { password: _dropped, ...rest } = secret;
    this.hub.saveSecret({ ...rest, userId: res.user_id, accessToken: res.access_token, deviceId: res.device_id });
    this.log('info', `logged in as ${res.user_id} (device ${res.device_id}); password removed from secret.json`);
    this.adopt(client, res.user_id, res.device_id);
  }

  private adopt(client: MatrixClient, userId: string, deviceId: string) {
    const prev = this.db.get('user');
    if (prev && prev !== userId) {
      this.log('warn', `account changed from ${prev} to ${userId}; dropping local sync state`);
      this.db.tx(() => {
        for (const t of ['kv', 'room', 'state', 'event', 'edit', 'reaction', 'thread', 'utd']) this.db.db.query(`DELETE FROM ${t}`).run();
      });
      this.dir.rooms.clear();
      this.dir.setDirect({});
      this.dir.pushRules = null;
      this.statusCache = null;
      this.requests.reset();
    }
    this.db.set('user', userId);
    this.client = client;
    this.selfId = userId;
    this.deviceId = deviceId;
    this.dir.selfId = userId;
    if (this.config.userId && this.config.userId !== userId) this.log('warn', `config userId ${this.config.userId} differs from the logged-in ${userId}`);
  }

  private api(): MatrixClient {
    if (!this.client || !this.selfId) throw new Error('not logged in to the homeserver yet');
    return this.client;
  }

  // ================================================================ sync loop

  /**
   * The filter for the people m.direct names now, uploaded when they change. Someone new to it gets their status
   * asked for once: an incremental sync only brings presence that changes after.
   */
  private async filterId(): Promise<string> {
    const contacts = this.dir.contacts();
    const filter = syncFilter(contacts);
    const hash = Bun.hash(JSON.stringify(filter)).toString(36);
    const saved: { hash: string | null; id: string; contacts: string[] } | null = JSON.parse(this.db.get('filter') ?? 'null');
    if (saved?.hash === hash) return saved.id;
    const res = await this.api().request('POST', `/_matrix/client/v3/user/${enc(this.selfId)}/filter`, { body: filter });
    this.db.set('filter', JSON.stringify({ hash, id: res.filter_id, contacts }));
    const known = new Set(saved?.contacts ?? []);
    const fresh = contacts.filter((u) => !known.has(u));
    if (fresh.length && this.db.get('since')) this.fetchStatuses(fresh).catch((e) => this.log('debug', `status lookup failed: ${describe(e)}`));
    return res.filter_id;
  }

  private async hubReady() {
    while (!this.hub.connected && !this.stopped) await Bun.sleep(250);
  }

  private async syncLoop() {
    let failures = 0;
    while (!this.stopped) {
      await this.hubReady();
      if (this.restartSession) throw new Restart();
      // Between two syncs, so what it lists and what the next sync changes line up; after the first, so the account is online meanwhile.
      if (this.online && this.db.get('since') && !this.requests.tracked && Date.now() >= this.snapshotAfter) {
        await this.snapshotInvites();
        if (this.stopped) return;
      }
      const since = this.db.get('since');
      const initial = !since;
      const ac = new AbortController();
      this.syncAbort = ac;
      let res: any;
      const t0 = Date.now();
      const verifying = !initial && !!this.e2ee?.verifying;
      try {
        const filter = await this.filterId();
        res = await this.api().request('GET', '/_matrix/client/v3/sync', {
          // The first sync of a session returns at once, so the account shows online without waiting out a long poll.
          query: { filter, since: since ?? undefined, timeout: initial || !this.online ? 0 : verifying ? VERIFY_SYNC_TIMEOUT : SYNC_TIMEOUT, set_presence: 'offline' },
          timeoutMs: initial ? 300_000 : verifying ? VERIFY_SYNC_GIVE_UP : SYNC_TIMEOUT + 30_000,
          signal: ac.signal,
          retries: 0,
        });
      } catch (e) {
        if (this.stopped) return;
        if (this.restartSession) throw new Restart();
        if (ac.signal.aborted) continue; // resync requested
        if (e instanceof MatrixError) {
          if (e.isAuth) throw new NeedsLogin(`The homeserver ended the session (${e.errcode}: ${e.error}). Run the "relogin" action with {"password": "..."}.`);
          if (e.isRateLimit) {
            await this.sleep(Math.min(e.retryAfterMs ?? 5000, 120_000));
            continue;
          }
          // A filter the server forgot: upload it again at once. Refused again, it waits like any other failure.
          if (/filter/i.test(e.error) && e.status === 400 && failures === 0) {
            const saved = JSON.parse(this.db.get('filter') ?? 'null');
            this.db.set('filter', saved ? JSON.stringify({ ...saved, hash: null }) : null);
            failures++;
            continue;
          }
        }
        failures++;
        this.syncFailure = { message: describe(e), failures };
        // A verification in progress cannot wait out a long backoff; see VERIFY_SYNC_TIMEOUT.
        const delay = Math.min(BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)], this.e2ee?.verifying ? 2 : Infinity);
        this.log('warn', `sync failed (${describe(e)}); retrying in ${delay}s`);
        if (failures >= 4) this.setStatus('error', { kind: 'unknown', message: `Sync keeps failing: ${describe(e)}` });
        else if (!this.online) this.setStatus('connecting', null);
        await this.sleep(delay * 1000);
        continue;
      } finally {
        if (this.syncAbort === ac) this.syncAbort = null;
      }
      failures = 0;
      this.syncFailure = null;
      const fetched = Date.now() - t0;
      await this.processSync(res, initial);
      this.db.set('since', res.next_batch);
      if (initial) {
        const rooms = this.dir.joined().length;
        this.log('info', `initial sync: ${rooms} joined rooms (fetched in ${fetched}ms, processed in ${Date.now() - t0 - fetched}ms)`);
        for (const w of this.resyncWaiters.splice(0)) w(rooms);
      }
      if (!this.online || this.status !== 'online') {
        this.online = true;
        this.setStatus('online', this.e2eeAttention());
      }
    }
  }

  // ================================================================ sync processing

  private async processSync(res: any, initial: boolean) {
    // First, so a room key that arrives with its message decrypts it. If this throws, the since token
    // stays where it was and the same to-device messages come again: they are not on the server after that.
    await this.e2ee?.receiveSync(res);
    const ctx: Ctx = { live: !initial, mode: 'sync', count: 0 };
    let structural = initial;

    for (const ev of res.account_data?.events ?? []) {
      if (ev?.type === 'm.direct') {
        this.dir.setDirect(ev.content ?? {});
        this.db.set('m.direct', JSON.stringify(ev.content ?? {}));
        structural = true;
      } else if (ev?.type === 'm.push_rules') {
        this.dir.pushRules = ev.content ?? null;
        this.db.set('m.push_rules', JSON.stringify(ev.content ?? null));
        structural = true;
      }
    }

    const joins = Object.entries<any>(res.rooms?.join ?? {});
    const newRooms = new Set(joins.map(([id]) => id).filter((id) => !this.dir.rooms.has(id)));
    const touched: Room[] = [];
    // Pins and roles that changed. A first sync, or a room just joined, has nothing to compare with: what it brings is how things are.
    const news: P.AdapterEvent[] = [];
    this.db.tx(() => {
      for (const [id, jr] of joins) {
        const room = this.dir.room(id);
        if (room.membership !== 'join') {
          room.membership = 'join';
          structural = true;
        }
        if (jr.summary && typeof jr.summary === 'object') {
          const s = { ...room.summary };
          if (Array.isArray(jr.summary['m.heroes'])) s.heroes = jr.summary['m.heroes'];
          if (typeof jr.summary['m.joined_member_count'] === 'number') s.joined = jr.summary['m.joined_member_count'];
          if (typeof jr.summary['m.invited_member_count'] === 'number') s.invited = jr.summary['m.invited_member_count'];
          if (JSON.stringify(s) !== JSON.stringify(room.summary)) {
            room.summary = s;
            structural = true;
          }
        }
        const compare = initial || newRooms.has(id) ? undefined : news;
        for (const ev of jr.state?.events ?? []) if (this.applyState(room, ev, compare)) structural = true;
        for (const ev of jr.timeline?.events ?? []) if (ev?.state_key !== undefined && this.applyState(room, ev, compare)) structural = true;
        if (room.backToken === null && typeof jr.timeline?.prev_batch === 'string') room.backToken = jr.timeline.prev_batch;
        touched.push(room);
      }
    });

    for (const [id] of Object.entries<any>(res.rooms?.leave ?? {})) {
      const room = this.dir.rooms.get(id);
      if (!room) continue;
      this.leaveRoom(room);
      structural = true;
    }
    this.requests.sync(res.rooms, initial);

    if (structural) {
      await this.loadMembers();
      this.emitStructure();
    } else this.flushIdentities();
    for (const e of news) this.hub.emit(e);
    // Requests after the rooms they name. Knocks older than what this sync brought are asked for once per process.
    if (!this.knocksLoaded) {
      this.knocksLoaded = true;
      await this.loadKnocks();
    }
    this.requests.ready();
    this.requests.flush();
    for (const ev of res.presence?.events ?? []) {
      if (ev?.type !== 'm.presence' || typeof ev.sender !== 'string') continue;
      this.noteStatus(ev.sender, ev.content);
      this.notePresence(ev.sender, ev.content);
    }

    for (const [id, jr] of joins) {
      const room = this.dir.room(id);
      const before = room.latestEvent;
      const events: MxEvent[] = jr.timeline?.events ?? [];
      if (!initial && newRooms.has(id)) {
        // A room that just appeared: what happened before we joined is history, not news.
        let joinedAt = -1;
        events.forEach((e, i) => {
          if (e?.type === 'm.room.member' && e.state_key === this.selfId && e.content?.membership === 'join') joinedAt = i;
        });
        await this.processTimeline(room, events.slice(0, joinedAt + 1 || events.length), { ...ctx, live: false });
        if (joinedAt >= 0) await this.processTimeline(room, events.slice(joinedAt + 1), ctx);
      } else {
        await this.processTimeline(room, events, ctx);
      }
      if (events.length) room.latestEvent = events[events.length - 1].event_id;
      if (!initial && before && jr.timeline?.limited && typeof jr.timeline.prev_batch === 'string') await this.fillGap(room, jr.timeline.prev_batch, before);
    }
    for (const [id, jr] of joins) {
      const room = this.dir.rooms.get(id);
      if (!room) continue;
      this.readState(room, jr);
      this.receipts(room, jr, initial);
      if (!initial) this.typing(room, jr);
    }
    if (initial) this.emitThreads();
    this.db.tx(() => {
      for (const room of touched) if (this.dir.rooms.has(room.id)) this.db.saveRoom(room);
    });
    // Threads whose activity is older than the sync window would otherwise only appear on scrollback.
    const discover = initial ? this.dir.joined() : [...newRooms].map((id) => this.dir.rooms.get(id)).filter((r): r is Room => !!r);
    if (discover.length) await this.discoverThreads(discover);
  }

  /** Recent threads per room (GET /threads): thread conversations plus their roots. */
  private async discoverThreads(rooms: Room[]) {
    const queue = rooms.filter((r) => !r.isSpace && r.membership === 'join');
    let unsupported = false;
    const worker = async () => {
      for (let room = queue.shift(); room && !unsupported; room = queue.shift()) {
        try {
          const res: any = await this.api().request('GET', `/_matrix/client/v1/rooms/${enc(room.id)}/threads`, { query: { limit: 10, include: 'all' }, retries: 1 });
          for (const root of res.chunk ?? []) {
            if (!root?.event_id || typeof root.type !== 'string' || this.db.thread(threadId(room.id, root.event_id))) continue;
            const ctx: Ctx = { live: false, mode: 'fetch', count: 0 };
            const clear = await this.decrypted(room, root);
            await this.ensureThread(room, root.event_id, ctx, clear);
            await this.processEvent(room, clear, ctx);
          }
        } catch (e) {
          // An unknown endpoint (old server) turns discovery off; other errors only skip the room.
          if (e instanceof MatrixError && (e.errcode === 'M_UNRECOGNIZED' || (e.status === 404 && e.errcode === 'HTTP_404'))) unsupported = true;
          else this.log('debug', `thread discovery in ${room.id} failed: ${describe(e)}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /**
   * Apply one state event. Returns true if it changes how rooms are presented. With `news` (a room whose state is
   * known), the pins and roles it changes go there.
   */
  private applyState(room: Room, ev: MxEvent, news?: P.AdapterEvent[]): boolean {
    if (!ev || typeof ev.type !== 'string' || typeof ev.state_key !== 'string' || !ev.event_id) return false;
    const before = room.get(ev.type, ev.state_key);
    if (!room.setState(ev)) return false;
    // The same event again (redacted, say) is no new change.
    if (news && before?.event_id !== ev.event_id) news.push(...this.stateNews(room, before, ev));
    this.db.saveState(room.id, ev);
    if (ev.type === 'm.room.member') this.encryptionMembers.delete(room.id);
    if (ev.type === 'm.room.member' && ev.state_key !== this.selfId) {
      const m = ev.content?.membership;
      if (m === 'join' || m === 'invite') this.pendingIdentities.set(ev.state_key, this.dir.identity(room, ev.state_key));
    }
    return STRUCTURAL.has(ev.type);
  }

  /**
   * Pins and roles one state event changes, against the one it replaces. A room never pinned in has no pinned
   * events at all, which is no pins; with no power levels before there is nothing to compare with.
   */
  private stateNews(room: Room, before: MxEvent | undefined, after: MxEvent): P.AdapterEvent[] {
    if (after.state_key !== '') return [];
    if (after.type === 'm.room.pinned_events' && !room.isSpace) return pinChanges(before ?? { ...after, content: {} }, after, (m) => this.conversationIn(room, m) ?? room.id);
    if (after.type === 'm.room.power_levels' && before) return roleChanges({ kind: room.isSpace ? 'space' : 'conversation', nativeId: room.id }, before, after, (u) => room.isPrivilegedCreator(u));
    return [];
  }

  /** The conversation an event of this room is in (a thread, or the room), as far as the index knows. */
  private conversationIn(room: Room, eventId: string): string | undefined {
    const row = this.db.event(eventId);
    return row?.room === room.id ? row.conv : undefined;
  }

  /**
   * Knocks on rooms this account may let people into, whatever sync's window held: a knock from before it (lazy
   * loading sends only the members who speak) or one that came while the adapter was down.
   */
  private async loadKnocks() {
    for (const room of this.dir.joined().filter((r) => answersKnocks(r, this.selfId))) {
      try {
        const res: any = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/members`, { query: { membership: 'knock' }, retries: 1 });
        this.db.tx(() => {
          for (const ev of res.chunk ?? []) if (ev?.type === 'm.room.member' && ev.content?.membership === 'knock') this.applyState(room, ev);
        });
      } catch (e) {
        this.log('debug', `could not list knocks on ${room.id}: ${describe(e)}`);
      }
    }
  }

  /** Every pending invite, once, for a store that synced before invites were followed (INVITES_ONLY). */
  private async snapshotInvites() {
    const ac = new AbortController();
    this.syncAbort = ac;
    try {
      const res: any = await this.api().request('GET', '/_matrix/client/v3/sync', {
        query: { filter: JSON.stringify(INVITES_ONLY), timeout: 0, set_presence: 'offline' },
        timeoutMs: 300_000,
        signal: ac.signal,
        retries: 0,
      });
      this.requests.snapshot(res?.rooms?.invite ?? {});
      this.log('info', `listed pending invites: ${Object.keys(res?.rooms?.invite ?? {}).length}`);
      this.requests.ready();
      this.requests.flush();
    } catch (e) {
      if (this.stopped) return;
      this.snapshotAfter = Date.now() + SNAPSHOT_RETRY_MS;
      this.log('warn', `could not list pending invites (${describe(e)}); trying again in ${SNAPSHOT_RETRY_MS / 60_000} minutes`);
    } finally {
      if (this.syncAbort === ac) this.syncAbort = null;
    }
  }

  /** Lazy loading only sends members who speak; small rooms get their full member list once. */
  private async loadMembers() {
    const need = this.dir.joined().filter((r) => {
      if (r.membersLoaded || r.isSpace) return false;
      const p = this.dir.place(r);
      return p.kind === 'conversation' && (p.shape === 'direct' || p.shape === 'group' || p.shape === 'self');
    });
    for (let i = 0; i < need.length; i += 8) {
      await Promise.all(
        need.slice(i, i + 8).map(async (room) => {
          try {
            const res = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/joined_members`);
            this.db.tx(() => {
              for (const [user, info] of Object.entries<any>(res.joined ?? {})) {
                const ev: MxEvent = {
                  type: 'm.room.member',
                  state_key: user,
                  event_id: `~joined:${user}`,
                  sender: user,
                  origin_server_ts: 0,
                  content: {
                    membership: 'join',
                    ...(typeof info?.display_name === 'string' ? { displayname: info.display_name } : {}),
                    ...(typeof info?.avatar_url === 'string' ? { avatar_url: info.avatar_url } : {}),
                  },
                };
                this.applyState(room, ev);
              }
              room.membersLoaded = true;
              this.db.saveRoom(room);
            });
          } catch (e) {
            this.log('warn', `could not load members of ${room.id}: ${describe(e)}`);
          }
        }),
      );
    }
  }

  // ================================================================ structure facts

  private emitOnce(key: string, value: unknown, ev: () => P.AdapterEvent): boolean {
    const json = JSON.stringify(value);
    if (this.emitted.get(key) === json) return false;
    this.emitted.set(key, json);
    this.hub.emit(ev());
    return true;
  }

  private emitIdentity(f: P.IdentityFact, onlyIfNew = false) {
    if (f.nativeId === this.selfId) return;
    if (onlyIfNew && this.emitted.has(`idn:${f.nativeId}`)) return;
    this.emitOnce(`idn:${f.nativeId}`, f, () => ({ t: 'identity', identity: f }));
  }

  private flushIdentities() {
    for (const f of this.pendingIdentities.values()) this.emitIdentity(f);
    this.pendingIdentities.clear();
  }

  private emitConversation(f: P.ConversationFact): boolean {
    return this.emitOnce(`cnv:${f.nativeId}`, f, () => ({ t: 'conversation', conversation: f }));
  }

  /** Spaces, then rooms (with their participants' identities). Only changed facts are sent. */
  private emitStructure() {
    this.flushIdentities();
    const rooms = this.dir.joined();
    for (const room of rooms) {
      if (!room.isSpace) continue;
      const f = this.dir.spaceFact(room);
      this.emitOnce(`spc:${room.id}`, f, () => ({ t: 'space', space: f }));
    }
    for (const room of rooms) {
      const place = this.dir.place(room);
      if (place.kind !== 'conversation') continue;
      const f = this.dir.conversationFact(room, place.shape);
      for (const u of f.participants ?? []) this.emitIdentity(this.dir.identity(room, u), true);
      if (place.shape === 'direct') this.emitIdentity(this.dir.identity(room, this.dir.peerOf(room)!));
      if (this.emitConversation(f) && f.mute) {
        room.lastMute = JSON.stringify(f.mute);
        this.db.saveRoom(room);
      }
    }
  }

  private emitThreadFact(t: ThreadRow) {
    const f: P.ConversationFact = { nativeId: t.id, shape: 'thread', variant: 'text', name: t.name || 'Thread', parentConversation: t.room };
    if (this.dir.rooms.get(t.room)?.encrypted) f.encrypted = true;
    this.emitConversation(f);
  }

  private emitThreads() {
    for (const t of this.db.threads()) if (this.dir.rooms.get(t.room)?.membership === 'join') this.emitThreadFact(t);
  }

  private leaveRoom(room: Room) {
    this.hub.emit({ t: 'leave', kind: room.isSpace ? 'space' : 'conversation', nativeId: room.id });
    for (const t of this.db.threadsOf(room.id)) {
      this.hub.emit({ t: 'leave', kind: 'conversation', nativeId: t.id });
      this.emitted.delete(`cnv:${t.id}`);
    }
    this.emitted.delete(`${room.isSpace ? 'spc' : 'cnv'}:${room.id}`);
    this.dir.rooms.delete(room.id);
    this.db.deleteRoom(room.id);
    this.log('info', `left ${room.isSpace ? 'space' : 'room'} ${room.id}`);
  }

  // ================================================================ timeline -> facts

  private noteTs(ev: MxEvent) {
    this.recentTs.set(ev.event_id, ev.origin_server_ts);
    if (this.recentTs.size > 20_000) {
      const drop = [...this.recentTs.keys()].slice(0, 5_000);
      for (const k of drop) this.recentTs.delete(k);
    }
  }

  private eventTs(id: string): number | null {
    return this.recentTs.get(id) ?? this.db.event(id)?.ts ?? null;
  }

  private async processTimeline(room: Room, events: MxEvent[], ctx: Ctx) {
    for (const ev of events) {
      try {
        await this.processEvent(room, ev, ctx);
      } catch (e) {
        this.log('warn', `could not process ${ev?.type} ${ev?.event_id} in ${room.id}: ${describe(e)}`);
      }
    }
  }

  private async processEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    if (!ev?.event_id || typeof ev.type !== 'string' || typeof ev.sender !== 'string') return;
    ev.content ??= {};
    this.noteTs(ev);
    if (ev.state_key !== undefined) {
      this.db.putEvent(ev, room.id, room.id, false);
      return;
    }
    if (isRedacted(ev)) return this.redactedEvent(room, ev, ctx);
    ev = await this.decrypted(room, ev);
    switch (ev.type) {
      case 'm.reaction':
        return this.reactionEvent(room, ev);
      case 'm.room.redaction':
        return this.redactionEvent(room, ev, ctx);
      default:
        if (MESSAGE_TYPES.has(ev.type)) return this.messageEvent(room, ev, ctx);
        this.db.putEvent(ev, room.id, room.id, false);
    }
  }

  /** The conversation a message-like event lives in: the room, or its thread. */
  private async conversationOf(room: Room, ev: MxEvent, rel: Relation, ctx: Ctx): Promise<string> {
    if (rel.relType === 'm.thread' && rel.eventId && rel.eventId !== ev.event_id) return this.ensureThread(room, rel.eventId, ctx);
    return room.id;
  }

  private async messageEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    const rel = relationOf(ev.content);
    if (rel.relType === 'm.replace' && rel.eventId) {
      if (ev.type === 'm.room.encrypted') this.db.putEvent(ev, room.id, room.id, true);
      else await this.editEvent(room, ev, rel, ctx);
      return;
    }
    // An encrypted reaction we cannot read yet is no message, so it gets no "encrypted message" bubble.
    if (ev.type === 'm.room.encrypted' && rel.relType === 'm.annotation') {
      this.db.putEvent(ev, room.id, room.id, true);
      return;
    }
    const conv = await this.conversationOf(room, ev, rel, ctx);
    // A thread root: the server bundles a thread summary into it.
    if (conv === room.id && ev.unsigned?.['m.relations']?.['m.thread']) await this.ensureThread(room, ev.event_id, ctx, ev);
    this.db.putEvent(ev, room.id, conv, true);
    const f = this.buildMessage(room, ev, conv, ctx);
    if (f) {
      this.hub.emit({ t: 'message', message: f, live: ctx.live });
      ctx.count++;
      if (ctx.oldest === undefined || f.ts < ctx.oldest) ctx.oldest = f.ts;
      ctx.hits?.push(f.nativeId);
    }
    if (conv !== room.id) this.bumpThread(conv, ev);
  }

  /** The latest valid replacement of a message, from our index or bundled by the server. */
  private latestEdit(ev: MxEvent): { content: any; ts: number } | null {
    const row = this.db.edit(ev.event_id);
    let best = row && row.sender === ev.sender ? { content: JSON.parse(row.content), ts: row.ts, id: row.id } : null;
    const bundled = ev.unsigned?.['m.relations']?.['m.replace'];
    const nc = bundled?.content?.['m.new_content'];
    const plainOverEncrypted = (ev.e2ee || ev.type === 'm.room.encrypted') && !bundled?.e2ee;
    if (bundled && !plainOverEncrypted && bundled.sender === ev.sender && nc && typeof nc === 'object' && typeof bundled.event_id === 'string') {
      const ts = Number(bundled.origin_server_ts) || 0;
      if (!best || ts > best.ts) {
        best = { content: nc, ts, id: bundled.event_id };
        this.db.putEdit({ target: ev.event_id, id: bundled.event_id, sender: bundled.sender, ts, content: JSON.stringify(nc) });
      }
    }
    return best;
  }

  private reactionSnapshot(target: string): P.ReactionFact[] {
    const by = new Map<string, Set<string>>();
    for (const r of this.db.reactionsFor(target)) {
      const key = canonicalReactionKey(r.key);
      (by.get(key) ?? by.set(key, new Set()).get(key)!).add(r.sender);
    }
    return [...by].map(([key, authors]) => ({ key, authors: [...authors], ...(key.startsWith('mxc://') ? { emoji: packEmoji(key) } : {}) }));
  }

  private buildMessage(room: Room, ev: MxEvent, conv: string, ctx: Ctx): P.MessageFact | null {
    const rel = relationOf(ev.content);
    const edit = this.latestEdit(ev);
    // An edit can decrypt before the message it edits does, and then it is all we can show.
    const type = edit && ev.type === 'm.room.encrypted' ? 'm.room.message' : ev.type;
    const rendered = renderContent(type, edit ? edit.content : ev.content, edit ? false : !!rel.inReplyTo, ev.event_id);
    if (!rendered) return null;
    const f: P.MessageFact = { nativeId: ev.event_id, conversation: conv, author: ev.sender, ts: ev.origin_server_ts, kind: rendered.kind, body: rendered.body };
    if (edit) f.editedTs = edit.ts;
    const reply = replyTarget(rel);
    if (reply) f.replyTo = reply;
    if (rendered.attachments?.length) f.attachments = rendered.attachments;
    if (rendered.extra) f.extra = rendered.extra;
    const forwarded = forwardOf(ev.content);
    if (forwarded) f.forward = forwarded;
    // A server can write plaintext events in anyone's name, so in an encrypted room they do not pass as normal.
    if (room.encrypted && ev.type === 'm.room.message' && !ev.e2ee) f.extra = { ...f.extra, encryptionWarning: 'Not encrypted, in an encrypted room. The server could have written this.' };
    if (ev.sender !== this.selfId && (mentionsUser(ev.content, this.selfId) || (edit && mentionsUser(edit.content, this.selfId)))) f.mentionsSelf = true;
    const thread = threadId(room.id, ev.event_id);
    if (conv === room.id && this.db.thread(thread)) f.threadRoot = thread;
    // Backfill: reactions seen earlier (in newer events) would otherwise have been dropped by the hub.
    if (ctx.mode !== 'sync') {
      const reactions = this.reactionSnapshot(ev.event_id);
      if (reactions.length) f.reactions = reactions;
    }
    return f;
  }

  private threadName(room: Room, root: MxEvent | null): string {
    if (!root) return 'Thread';
    const edit = this.latestEdit(root);
    const text = edit && typeof edit.content.body === 'string' ? edit.content.body : plainTextOf(root);
    return snippet(text, 60, (u) => room.memberName(u) ?? u) || 'Thread';
  }

  /** Make sure a thread conversation exists (its fact is emitted before its messages). */
  private async ensureThread(room: Room, rootId: string, ctx: Ctx, rootEv?: MxEvent): Promise<string> {
    const id = threadId(room.id, rootId);
    const existing = this.db.thread(id);
    if (existing) {
      if (!this.emitted.has(`cnv:${id}`)) this.emitThreadFact(existing);
      return id;
    }
    let root = rootEv ?? this.db.eventJson(rootId);
    if (!root) root = await this.fetchEvent(room.id, rootId);
    const t: ThreadRow = { id, room: room.id, root: rootId, name: this.threadName(room, root), latest: null, latest_ts: 0, back_token: null, done: 0 };
    this.db.putThread(t);
    this.emitThreadFact(t);
    // The root lives in the parent room; (re-)emit it so it points at its thread.
    if (!rootEv && root && !isRedacted(root)) {
      this.db.putEvent(root, room.id, room.id, true);
      const f = this.buildMessage(room, root, room.id, { ...ctx, mode: 'fetch' });
      if (f) this.hub.emit({ t: 'message', message: f, live: false });
    }
    return id;
  }

  private bumpThread(id: string, ev: MxEvent) {
    const t = this.db.thread(id);
    if (t && ev.origin_server_ts >= t.latest_ts) this.db.putThread({ ...t, latest: ev.event_id, latest_ts: ev.origin_server_ts });
  }

  private async fetchEvent(roomId: string, eventId: string): Promise<MxEvent | null> {
    try {
      const ev = await this.api().request<MxEvent>('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/event/${enc(eventId)}`, { retries: 1 });
      if (!ev?.event_id) return null;
      this.noteTs(ev);
      const room = this.dir.rooms.get(roomId);
      return room ? this.decrypted(room, ev) : ev;
    } catch (e) {
      this.log('debug', `could not fetch ${eventId} in ${roomId}: ${describe(e)}`);
      return null;
    }
  }

  private async editEvent(room: Room, ev: MxEvent, rel: Relation, ctx: Ctx) {
    this.db.putEvent(ev, room.id, room.id, false);
    const target = rel.eventId!;
    const nc = ev.content['m.new_content'];
    if (!nc || typeof nc !== 'object') return;
    const row = this.db.event(target);
    if (row && row.sender !== ev.sender) return; // only the author can edit
    // A server can write plaintext events in anyone's name, but it cannot rewrite what someone encrypted.
    const before = row?.json ? (JSON.parse(row.json) as MxEvent) : null;
    if (before && (before.e2ee || before.type === 'm.room.encrypted') && !ev.e2ee) return;
    if (!this.db.putEdit({ target, id: ev.event_id, sender: ev.sender, ts: ev.origin_server_ts, content: JSON.stringify(nc) })) return;
    if (row?.redacted) return;
    if (row?.json) {
      const original = JSON.parse(row.json) as MxEvent;
      const f = this.buildMessage(room, original, row.conv, ctx);
      if (f) this.hub.emit({ t: 'message', message: f, live: ctx.live });
      return;
    }
    // Older than anything we have: when backfilling it will be paged in (and pick the edit up); otherwise fetch it.
    if (ctx.mode === 'history') return;
    const original = await this.fetchEvent(room.id, target);
    if (original && original.sender === ev.sender && !isRedacted(original)) await this.messageEvent(room, original, { live: false, mode: 'fetch', count: 0 });
  }

  private reactionEvent(room: Room, ev: MxEvent) {
    this.db.putEvent(ev, room.id, room.id, false);
    const rel = relationOf(ev.content);
    if (rel.relType !== 'm.annotation' || !rel.eventId || !rel.key) return;
    this.db.putReaction({ id: ev.event_id, room: room.id, target: rel.eventId, key: rel.key, sender: ev.sender, ts: ev.origin_server_ts });
    const conv = this.db.event(rel.eventId)?.conv ?? room.id;
    const shortcode = ev.content?.['com.beeper.reaction.shortcode'] ?? ev.content?.shortcode;
    this.hub.emit({ t: 'reaction', conversation: conv, message: rel.eventId, author: ev.sender, key: rel.key, ...(rel.key.startsWith('mxc://') ? { emoji: packEmoji(rel.key, shortcode) } : {}) });
  }

  private async redactionEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    this.db.putEvent(ev, room.id, room.id, false);
    const target = typeof ev.redacts === 'string' ? ev.redacts : ev.content?.redacts;
    if (typeof target === 'string') await this.applyRedaction(room, target);
  }

  private async applyRedaction(room: Room, target: string) {
    const rx = this.db.reaction(target);
    if (rx) {
      this.db.deleteReaction(target);
      if (!this.db.reactionsBy(rx.target, rx.sender, rx.key).length) {
        const conv = this.db.event(rx.target)?.conv ?? rx.room;
        this.hub.emit({ t: 'reaction', conversation: conv, message: rx.target, author: rx.sender, key: rx.key, remove: true });
      }
      return;
    }
    const edited = this.db.dropEdit(target);
    if (edited) {
      // An edit was redacted: show the previous version again (the server bundles the latest remaining edit).
      const row = this.db.event(edited);
      const original = await this.fetchEvent(room.id, edited);
      if (original && !row?.redacted) await this.messageEvent(room, original, { live: false, mode: 'fetch', count: 0 });
      return;
    }
    const row = this.db.event(target);
    if (row?.redacted) return;
    if (row && !MESSAGE_TYPES.has(row.type)) return;
    this.db.markRedacted(target);
    this.hub.emit({ t: 'delete', conversation: row?.conv ?? room.id, nativeId: target });
  }

  /** A message we see only in its redacted form: a tombstone, so the timeline shows "deleted". */
  private async redactedEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    if (ev.type === 'm.reaction') {
      if (this.db.reaction(ev.event_id)) await this.applyRedaction(room, ev.event_id);
      this.db.putEvent(ev, room.id, room.id, false);
      return;
    }
    if (!MESSAGE_TYPES.has(ev.type)) {
      this.db.putEvent(ev, room.id, room.id, false);
      return;
    }
    const known = this.db.event(ev.event_id);
    if (known?.redacted) return;
    const conv = known?.conv ?? room.id;
    if (!known?.json) {
      this.hub.emit({ t: 'message', live: false, message: { nativeId: ev.event_id, conversation: conv, author: ev.sender, ts: ev.origin_server_ts, kind: 'text', body: '' } });
    }
    this.db.putEvent(ev, room.id, conv, false);
    this.db.markRedacted(ev.event_id);
    this.hub.emit({ t: 'delete', conversation: conv, nativeId: ev.event_id });
  }

  /** After a limited incremental sync: page back until we reach what we already had. */
  private async fillGap(room: Room, from: string, stopAt: string | null) {
    if (!stopAt) return;
    const stopTs = this.eventTs(stopAt);
    const collected: MxEvent[] = [];
    let token: string | undefined = from;
    try {
      for (let page = 0; page < GAP_PAGES && token; page++) {
        const res: any = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/messages`, {
          query: { from: token, dir: 'b', limit: 100, filter: LAZY },
        });
        this.historyMembers(room, res.state);
        let reached = false;
        for (const ev of res.chunk ?? []) {
          if (ev.event_id === stopAt || (stopTs !== null && ev.origin_server_ts < stopTs)) {
            reached = true;
            break;
          }
          collected.push(ev);
        }
        token = reached || !(res.chunk?.length) ? undefined : res.end;
      }
    } catch (e) {
      this.log('warn', `gap fill in ${room.id} failed: ${describe(e)}`);
    }
    if (token) {
      room.backToken = token;
      this.log('info', `gap in ${room.id} not closed after ${GAP_PAGES} pages; history will continue from there`);
    }
    collected.reverse();
    if (collected.length) this.log('debug', `filled a gap of ${collected.length} events in ${room.id}`);
    await this.processTimeline(room, collected, { live: false, mode: 'gap', count: 0 });
  }

  /** Member events that come with /messages pages: identities only (they may be historical). */
  private historyMembers(room: Room, state: MxEvent[] | undefined) {
    for (const ev of state ?? []) {
      if (ev?.type !== 'm.room.member' || typeof ev.state_key !== 'string' || ev.state_key === this.selfId) continue;
      const f: P.IdentityFact = { nativeId: ev.state_key, handle: ev.state_key };
      if (typeof ev.content?.displayname === 'string' && ev.content.displayname) f.displayName = ev.content.displayname;
      if (typeof ev.content?.avatar_url === 'string' && ev.content.avatar_url.startsWith('mxc://')) f.avatarUrl = ev.content.avatar_url;
      if (this.dir.isContact(ev.state_key)) f.contact = true;
      this.emitIdentity(room.memberName(ev.state_key) ? this.dir.identity(room, ev.state_key) : f, true);
    }
  }

  // ================================================================ read state, typing

  private readState(room: Room, jr: any) {
    if (room.isSpace) return; // spaces are not conversations: no read state to report
    let best: number | null = null;
    const consider = (eventId: unknown) => {
      if (typeof eventId !== 'string') return;
      const ts = this.eventTs(eventId);
      if (ts !== null && (best === null || ts > best)) best = ts;
    };
    const threadReads = new Map<string, number>();
    for (const ev of jr.ephemeral?.events ?? []) {
      if (ev?.type !== 'm.receipt') continue;
      for (const [eventId, byType] of Object.entries<any>(ev.content ?? {})) {
        for (const rt of ['m.read', 'm.read.private']) {
          const r = byType?.[rt]?.[this.selfId];
          if (!r) continue;
          if (typeof r.thread_id === 'string' && r.thread_id !== 'main') {
            const ts = this.eventTs(eventId);
            if (ts !== null) threadReads.set(r.thread_id, Math.max(threadReads.get(r.thread_id) ?? 0, ts));
          } else consider(eventId);
        }
      }
    }
    for (const ev of jr.account_data?.events ?? []) if (ev?.type === 'm.fully_read') consider(ev.content?.event_id);

    const n = jr.unread_notifications;
    const counts = typeof n?.notification_count === 'number';
    if (counts || best !== null) {
      this.hub.emit({
        t: 'read',
        conversation: room.id,
        upToTs: best ?? 0,
        ...(counts ? { unread: n.notification_count, mentions: typeof n.highlight_count === 'number' ? n.highlight_count : 0 } : {}),
      });
    }
    for (const [root, ts] of threadReads) {
      const id = threadId(room.id, root);
      if (this.db.thread(id)) this.hub.emit({ t: 'read', conversation: id, upToTs: ts });
    }
    for (const [root, c] of Object.entries<any>(jr.unread_thread_notifications ?? {})) {
      const id = threadId(room.id, root);
      if (this.db.thread(id) && typeof c?.notification_count === 'number') {
        this.hub.emit({ t: 'read', conversation: id, upToTs: 0, unread: c.notification_count, mentions: c.highlight_count ?? 0 });
      }
    }
  }

  /**
   * Other people's read receipts, each up to the event it names. A first sync brings every receipt there is, so then
   * only those in direct chats and groups: a big room has thousands of readers.
   */
  private receipts(room: Room, jr: any, initial: boolean) {
    if (room.isSpace) return;
    if (initial) {
      const place = this.dir.place(room);
      if (place.kind === 'conversation' && place.shape === 'channel') return;
    }
    const conversationOf = (message: string, thread?: string) => {
      const known = this.conversationIn(room, message);
      if (known) return known;
      return thread && this.db.thread(threadId(room.id, thread)) ? threadId(room.id, thread) : room.id;
    };
    for (const ev of jr.ephemeral?.events ?? []) {
      if (ev?.type !== 'm.receipt') continue;
      for (const e of receiptEvents(ev.content, this.selfId, conversationOf)) this.hub.emit(e);
    }
  }

  /** The status message each person with a direct chat last had ('' for none), kept across restarts. */
  private statusCache: Map<string, string> | null = null;
  private statuses(): Map<string, string> {
    return (this.statusCache ??= new Map(Object.entries(JSON.parse(this.db.get('statuses') ?? '{}'))));
  }

  /** An m.presence content from someone: their status message, when it changed. Online and offline: notePresence. */
  private noteStatus(who: string, content: unknown) {
    if (who === this.selfId || !this.dir.isContact(who)) return;
    const statuses = this.statuses();
    const text = statusOf(content);
    const was = statuses.get(who);
    if (was === text) return;
    statuses.set(who, text);
    this.db.set('statuses', JSON.stringify(Object.fromEntries(statuses)));
    if (was === undefined && !text) return; // first heard of, with none: nothing to say
    this.hub.emit({ t: 'customStatus', who, ...(text ? { text } : {}) });
  }

  /** The presence last told for each person with a direct chat, this run; the hub knows what it told before. */
  private presences = new Map<string, string>();

  /** An m.presence content from someone: online, idle, busy or offline, when that changed (not the status message). */
  private notePresence(who: string, content: unknown) {
    if (who === this.selfId || !this.dir.isContact(who)) return;
    const state = presenceOf(content);
    if (!state || this.presences.get(who) === state) return;
    this.presences.set(who, state);
    this.hub.emit({ t: 'presence', who, state });
  }

  /** Ask for these people's presence once, one at a time. A server with presence off says so to the first. */
  private async fetchStatuses(users: string[]) {
    for (const u of users) {
      if (this.stopped) return;
      try {
        const before = this.statuses().get(u);
        const res = await this.api().request('GET', `/_matrix/client/v3/presence/${enc(u)}/status`, { retries: 1 });
        // Presence that came through sync meanwhile is newer.
        if (this.statuses().get(u) === before) this.noteStatus(u, res);
        if (!this.presences.has(u)) this.notePresence(u, res);
      } catch (e) {
        if (e instanceof MatrixError && (e.status === 403 || e.errcode === 'M_UNRECOGNIZED')) return;
      }
    }
  }

  /** m.typing carries the room's whole list each time it changes: who is new or still there typed, who left it stopped. */
  private typing(room: Room, jr: any) {
    for (const ev of jr.ephemeral?.events ?? []) {
      if (ev?.type !== 'm.typing' || !Array.isArray(ev.content?.user_ids)) continue;
      const { events, now } = typingEvents(room.id, this.typers.get(room.id)?.users, ev.content.user_ids, this.selfId, (u) => room.memberName(u));
      if (now.size) this.typers.set(room.id, { users: now, at: Date.now() });
      else this.typers.delete(room.id);
      for (const e of events) this.hub.emit(e);
    }
    if (this.typers.size && !this.typingTimer) {
      this.typingTimer = setInterval(() => {
        for (const [roomId, { users, at }] of this.typers) {
          // A list unchanged for two minutes is more likely a sync that stopped than someone still typing.
          if (Date.now() - at > 120_000) {
            this.typers.delete(roomId);
            continue;
          }
          const r = this.dir.rooms.get(roomId);
          for (const e of typingEvents(roomId, undefined, [...users], this.selfId, (u) => r?.memberName(u)).events) this.hub.emit(e);
        }
      }, MATRIX_TYPING_TTL - 10_000);
      this.typingTimer.unref?.();
    } else if (!this.typers.size && this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    }
  }

  /** PUT /typing, with a timeout so a lost stop lapses on its own. The typing notice is never encrypted, in any room. */
  private async sendTyping(conversation: string, stop: boolean) {
    const { roomId } = splitConversation(conversation);
    this.joinedRoom(roomId);
    await this.api().request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/typing/${enc(this.selfId)}`, { body: stop ? { typing: false } : { typing: true, timeout: MATRIX_TYPING_TIMEOUT } });
    return { ok: true };
  }

  // ================================================================ commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send':
        return cmd.attachments?.length ? this.sendFiles(cmd.conversation, cmd.body, cmd.attachments, cmd.replyTo) : this.send(cmd.conversation, cmd.body, cmd.replyTo);
      case 'forward':
        return this.forward(cmd.conversation, cmd.source, cmd.note);
      case 'openDirect':
        return openDirect(this.directHost(), cmd.peer);
      case 'history':
        return this.history(cmd.conversation, cmd.limit);
      case 'search':
        return this.search(cmd);
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'typing':
        return this.sendTyping(cmd.conversation, !!cmd.stop);
      case 'react':
        return this.react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove, cmd.emoji);
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors':
        return { authors: [] }; // reaction events name their senders
      case 'about':
        return readAbout(this.aboutHost(), cmd.target);
      case 'configure':
        return configureAbout(this.aboutHost(), cmd.target, cmd.change);
      case 'addMembers':
        return addMembers(this.aboutHost(), cmd.target, cmd.people);
      case 'createGroup':
        return createGroup(this.groupHost(), cmd.name, cmd.people);
      case 'profile':
        return this.profile(cmd.who);
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'redact':
        return this.redact(cmd.conversation, cmd.message);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'resolve':
        return resolve(this.addHost(), cmd.ref);
      case 'add':
        return add(this.addHost(), cmd.ref, cmd.action);
      case 'answer':
        return answer(this.addHost(), cmd.request, cmd.answer);
      case 'shutdown':
        return undefined;
    }
  }

  private addHost(): AddHost {
    return {
      api: this.api(),
      dir: this.dir,
      e2ee: !!this.e2ee,
      requests: this.requests,
      identity: (f) => this.emitIdentity(f),
      synced: (roomId, waitMs) => this.joinedAndSent(roomId, waitMs),
      markDirect: async (peer, roomId) => {
        this.dir.addDirect(peer, roomId);
        await listAsDirect(this.directHost(), peer, roomId);
      },
      log: (msg) => this.log('info', msg),
    };
  }

  /** Wait for sync to bring a room as joined, then send its facts (again), so they reach the hub before a reply. */
  /** Wait for sync to have the room as joined (and, while waitMs lasts, `ready`), then send its fact again. */
  private async joinedAndSent(roomId: string, waitMs: number, ready?: (room: Room) => boolean): Promise<boolean> {
    const end = Date.now() + waitMs;
    for (;;) {
      const room = this.dir.rooms.get(roomId);
      if (room?.membership === 'join' && (!ready || ready(room))) break;
      if (Date.now() > end || this.stopped) {
        if (room?.membership !== 'join') return false;
        break;
      }
      await Bun.sleep(50);
    }
    this.announce(roomId);
    return true;
  }

  /** The room's fact again, as the directory has it now. */
  private announce(roomId: string) {
    const room = this.dir.rooms.get(roomId);
    if (!room) return;
    this.emitted.delete(`${room.isSpace ? 'spc' : 'cnv'}:${roomId}`);
    this.emitStructure();
  }

  private directHost(): DirectHost {
    return {
      api: this.api(),
      dir: this.dir,
      encrypted: !!this.e2ee,
      saveDirect: (content) => this.db.set('m.direct', JSON.stringify(content)),
      identity: (f) => this.emitIdentity(f),
      announce: (roomId) => {
        this.emitted.delete(`cnv:${roomId}`);
        this.emitStructure();
      },
    };
  }

  private groupHost(): GroupHost {
    return { ...this.aboutHost(), synced: (roomId, waitMs, ready) => this.joinedAndSent(roomId, waitMs, ready), announce: (roomId) => this.announce(roomId) };
  }

  private aboutHost(): AboutHost {
    return {
      api: this.api(),
      dir: this.dir,
      e2ee: !!this.e2ee,
      identity: (f) => this.emitIdentity(f, true),
      applied: (room, ev) => {
        // The same as the event coming back through sync: stored, and the hub told of a new name, topic or shape, or a pin.
        const news: P.AdapterEvent[] = [];
        if (this.applyState(room, ev, news)) {
          this.emitStructure();
          this.emitThreads();
        }
        for (const e of news) this.hub.emit(e);
      },
      log: (msg) => this.log('info', msg),
    };
  }

  private names(roomId: string) {
    const room = this.dir.rooms.get(roomId);
    return {
      user: (id: string) => room?.memberName(id) ?? this.namesAnywhere(id),
      room: (id: string) => {
        const r = this.dir.rooms.get(id);
        return r ? this.dir.displayName(r) : undefined;
      },
    };
  }

  private namesAnywhere(user: string): string | undefined {
    for (const r of this.dir.rooms.values()) {
      const n = r.memberName(user);
      if (n) return n;
    }
    return undefined;
  }

  private joinedRoom(roomId: string): Room {
    const room = this.dir.rooms.get(roomId);
    if (!room || room.membership !== 'join') throw new Error(`not joined to ${roomId}`);
    return room;
  }

  /** Without a running crypto layer, anything written to an encrypted room would be readable by the server. Never fall back to that. */
  private writableRoom(roomId: string): Room {
    const room = this.joinedRoom(roomId);
    if (room.encrypted && !this.e2ee) {
      throw new Error(this.e2eeError ? `this room is end-to-end encrypted and encryption is not working: ${this.e2eeError}` : 'this room is end-to-end encrypted. Set up encryption on the account page to write here');
    }
    return room;
  }

  /** Everyone whose devices get the room key: members, and invitees if the room lets them read from their invite on. */
  private async membersFor(room: Room): Promise<string[]> {
    const known = this.encryptionMembers.get(room.id);
    if (known) return known;
    const res = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/members`, { query: { not_membership: 'leave' } });
    const invitedToo = room.get('m.room.history_visibility')?.content?.history_visibility !== 'joined';
    const members: string[] = [];
    for (const ev of res.chunk ?? []) {
      const m = ev?.content?.membership;
      if (typeof ev?.state_key === 'string' && (m === 'join' || (m === 'invite' && invitedToo))) members.push(ev.state_key);
    }
    this.encryptionMembers.set(room.id, members);
    return members;
  }

  /** Every event this adapter writes goes through here. */
  private async sendEvent(roomId: string, type: string, content: unknown): Promise<string> {
    const room = this.writableRoom(roomId);
    let wireType = type;
    let wire = content;
    if (room.encrypted) {
      const e2ee = this.e2ee!;
      const members = await this.membersFor(room);
      wire = await e2ee.encrypt(roomId, members, { settings: room.get('m.room.encryption')?.content ?? {}, historyVisibility: room.get('m.room.history_visibility')?.content?.history_visibility }, type, content);
      wireType = 'm.room.encrypted';
    }
    const res = await this.api().request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/${enc(wireType)}/${enc(this.api().txnId())}`, { body: wire });
    return res.event_id;
  }

  /** Every file this adapter uploads goes through here. In an encrypted room the server gets ciphertext, without a name or type. */
  private async uploadFile(room: Room, f: P.OutgoingAttachment): Promise<Record<string, unknown>> {
    this.writableRoom(room.id);
    const upload = (query: Record<string, string> | undefined, body: unknown, contentType: string) => this.api().request<{ content_uri: string }>('POST', '/_matrix/media/v3/upload', { query, body, contentType, timeoutMs: 120_000 });
    if (!room.encrypted) return { url: (await upload({ filename: f.name }, Bun.file(f.path), f.mime)).content_uri };
    const { data, file } = this.e2ee!.encryptAttachment(new Uint8Array(await Bun.file(f.path).arrayBuffer()));
    return { file: { ...file, url: (await upload(undefined, data, 'application/octet-stream')).content_uri } };
  }

  private async send(conversation: string, body: string, replyTo?: string) {
    const { roomId, root } = splitConversation(conversation);
    this.writableRoom(roomId);
    const out = markdownToMatrix(body, this.names(roomId));
    const content: Record<string, any> = { msgtype: 'm.text', body: out.body };
    if (out.formatted) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = out.formatted;
    }
    const mentions = new Set(out.mentions);
    if (replyTo) {
      const target = this.db.event(replyTo);
      if (target && target.sender !== this.selfId) mentions.add(target.sender);
    }
    content['m.mentions'] = mentions.size ? { user_ids: [...mentions] } : {};
    if (root) {
      const latest = this.db.thread(threadId(roomId, root))?.latest ?? root;
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: root, is_falling_back: !replyTo, 'm.in_reply_to': { event_id: replyTo ?? latest } };
    } else if (replyTo) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } };
    }
    return { nativeId: await this.sendEvent(roomId, 'm.room.message', content) };
  }

  /**
   * Forward the way Matrix clients do: the original's content again, as it is, files by their existing mxc: URI
   * so nothing is uploaded twice, plus where it came from (FORWARD_KEY). A file encrypted for one room is not
   * handed to an unencrypted one, nor the other way round: the hub then sends it again through sendFiles.
   */
  private async forward(conversation: string, source: { conversation: string; message: string }, note?: string) {
    const { roomId, root } = splitConversation(conversation);
    const room = this.writableRoom(roomId);
    const srcRoom = splitConversation(source.conversation).roomId;
    let ev = this.db.eventJson(source.message);
    if (!ev || ev.type === 'm.room.encrypted') ev = await this.fetchEvent(srcRoom, source.message);
    if (!ev || (ev.type !== 'm.room.message' && ev.type !== 'm.sticker') || isRedacted(ev)) return { fallback: 'the original cannot be read here' };
    const content = forwardableContent(this.latestEdit(ev)?.content ?? ev.content);
    const encryptedFile = !!content.file;
    const plainFile = typeof content.url === 'string';
    if ((encryptedFile && !room.encrypted) || (plainFile && room.encrypted)) return { fallback: 'the file is encrypted for one room and not the other' };
    content[FORWARD_KEY] = { room_id: srcRoom, event_id: ev.event_id, sender: ev.sender, origin_server_ts: ev.origin_server_ts };
    if (root) {
      const latest = this.db.thread(threadId(roomId, root))?.latest ?? root;
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: latest } };
    }
    const nativeId = await this.sendEvent(roomId, ev.type, content);
    if (note?.trim()) await this.send(conversation, note);
    return { nativeId };
  }

  /** Matrix has one file per event, and clients vary on captions, so any text goes first as its own message. */
  private async sendFiles(conversation: string, body: string, files: P.OutgoingAttachment[], replyTo?: string) {
    const { roomId, root } = splitConversation(conversation);
    const room = this.writableRoom(roomId);
    let first: string | undefined;
    let reply = replyTo;
    if (body.trim()) {
      first = (await this.send(conversation, body, reply)).nativeId;
      reply = undefined;
    }
    for (const f of files) {
      const where = await this.uploadFile(room, f);
      const content: Record<string, any> = { msgtype: `m.${f.kind}`, body: f.name, filename: f.name, ...where, info: { mimetype: f.mime, size: f.size } };
      if (root) {
        const latest = this.db.thread(threadId(roomId, root))?.latest ?? root;
        content['m.relates_to'] = { rel_type: 'm.thread', event_id: root, is_falling_back: !reply, 'm.in_reply_to': { event_id: reply ?? latest } };
      } else if (reply) {
        content['m.relates_to'] = { 'm.in_reply_to': { event_id: reply } };
      }
      const id = await this.sendEvent(roomId, 'm.room.message', content);
      first ??= id;
      reply = undefined;
    }
    return { nativeId: first };
  }

  private async edit(conversation: string, message: string, body: string) {
    const { roomId } = splitConversation(conversation);
    this.writableRoom(roomId);
    const orig = this.db.event(message);
    if (orig && orig.sender !== this.selfId) throw new Error('only your own messages can be edited');
    const out = markdownToMatrix(body, this.names(roomId));
    const newContent: Record<string, any> = { msgtype: 'm.text', body: out.body, 'm.mentions': out.mentions.length ? { user_ids: out.mentions } : {} };
    if (out.formatted) {
      newContent.format = 'org.matrix.custom.html';
      newContent.formatted_body = out.formatted;
    }
    // Only mentions that are new in this edit notify again.
    const before = new Set<string>(orig?.json ? (JSON.parse(orig.json).content?.['m.mentions']?.user_ids ?? []) : []);
    const fresh = out.mentions.filter((u) => !before.has(u));
    const content: Record<string, any> = {
      msgtype: 'm.text',
      body: `* ${out.body}`,
      'm.new_content': newContent,
      'm.mentions': fresh.length ? { user_ids: fresh } : {},
      'm.relates_to': { rel_type: 'm.replace', event_id: message },
    };
    if (out.formatted) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = `* ${out.formatted}`;
    }
    return { nativeId: await this.sendEvent(roomId, 'm.room.message', content) };
  }

  /**
   * A Matrix profile (docs/profile.md): display name and avatar, plus pronouns and time zone where the server keeps
   * extended fields (MSC4133). Someone with a direct chat counts as a contact; for you, those are your friends.
   */
  private async profile(who: string): Promise<P.PersonAbout> {
    const p = await this.api()
      .request<Record<string, unknown>>('GET', `/_matrix/client/v3/profile/${encodeURIComponent(who)}`, { retries: 1 })
      .catch((): Record<string, unknown> => ({}));
    const direct = JSON.parse(this.db.get('m.direct') ?? '{}') as Record<string, string[]>;
    const out: P.PersonAbout = { links: [{ label: 'Matrix', value: who, url: `https://matrix.to/#/${encodeURIComponent(who)}` }] };
    if (typeof p.displayname === 'string') out.displayName = p.displayname;
    if (typeof p.avatar_url === 'string') out.avatar = p.avatar_url;
    const pronouns = (p['m.pronouns'] ?? p['io.fsky.nyx.pronouns']) as { summary?: string }[] | undefined;
    if (Array.isArray(pronouns) && pronouns[0]?.summary) out.pronouns = String(pronouns[0].summary);
    const tz = p['m.tz'] ?? p['us.cloke.msc4175.tz'];
    if (typeof tz === 'string') out.facts = [{ label: 'Time zone', value: tz }];
    if (who === this.selfId) out.friends = Object.keys(direct).filter((u) => u !== who);
    else out.relationship = direct[who]?.length ? 'contact' : 'stranger';
    return out;
  }

  private async redact(conversation: string, message: string, reason?: string) {
    const { roomId } = splitConversation(conversation);
    const res = await this.api().request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/redact/${enc(message)}/${enc(this.api().txnId())}`, {
      body: reason ? { reason } : {},
    });
    return { nativeId: res.event_id };
  }

  /** Our reactions on a message with this key, however a client spelled the emoji. */
  private myReactions(message: string, key: string) {
    const want = canonicalReactionKey(key);
    return this.db.reactionsFor(message).filter((r) => r.sender === this.selfId && canonicalReactionKey(r.key) === want);
  }

  private async react(conversation: string, message: string, key: string, remove: boolean, emoji?: P.CustomEmojiFact) {
    const { roomId } = splitConversation(conversation);
    // Taking one back is a redaction, which carries nothing that would need encrypting.
    const room = remove ? this.joinedRoom(roomId) : this.writableRoom(roomId);
    let mine = this.myReactions(message, key);
    if (!remove) {
      if (mine.length) return { nativeId: mine[0].id };
      const content: Record<string, unknown> = { 'm.relates_to': { rel_type: 'm.annotation', event_id: message, key } };
      // Custom emoji react with the image's mxc: URI. Clients read the name from one of these two.
      if (emoji) content['com.beeper.reaction.shortcode'] = content.shortcode = `:${emoji.name}:`;
      const id = await this.sendEvent(roomId, 'm.reaction', content);
      this.db.putReaction({ id, room: roomId, target: message, key, sender: this.selfId, ts: Date.now() });
      return { nativeId: id };
    }
    if (!mine.length) {
      // Reacted before our window (or from another client): ask the server.
      try {
        // In an encrypted room the server knows a reaction only as m.room.encrypted.
        const res = await this.api().request('GET', `/_matrix/client/v1/rooms/${enc(roomId)}/relations/${enc(message)}/m.annotation${room.encrypted ? '' : '/m.reaction'}`, { query: { limit: 100 } });
        for (const raw of res.chunk ?? []) {
          const ev = await this.decrypted(room, raw);
          const rel = relationOf(ev.content);
          if (ev.sender === this.selfId && rel.key && canonicalReactionKey(rel.key) === canonicalReactionKey(key)) this.db.putReaction({ id: ev.event_id, room: roomId, target: message, key: rel.key, sender: this.selfId, ts: ev.origin_server_ts });
        }
      } catch (e) {
        this.log('debug', `relations lookup failed: ${describe(e)}`);
      }
      mine = this.myReactions(message, key);
    }
    for (const r of mine) await this.redact(roomId, r.id);
    return { removed: mine.length };
  }

  /** Power levels decide whether you can react at all; image packs (MSC2545) are the custom emoji. */
  private async reactionContext(conversation: string): Promise<P.ReactionContext> {
    const { roomId } = splitConversation(conversation);
    const room = this.joinedRoom(roomId);
    if (room.encrypted && !this.e2ee) return { canReact: false, reason: 'Set up encryption on the account page to react in encrypted rooms.', custom: [] };
    const canReact = room.powerLevel(this.selfId) >= room.requiredLevel('m.reaction', false);
    return { canReact, ...(canReact ? {} : { reason: 'This room does not let you react.' }), custom: canReact ? await this.imagePacks(roomId) : [] };
  }

  /** Forgotten on the `resync` action, like everything else read from the server. */
  private packCache = new Map<string, { at: number; pack: P.ReactionContext['custom'][number] | null }>();

  /** The room's own pack, then your personal pack, then packs you enabled everywhere. Cached briefly: each is a request. */
  private async imagePacks(roomId: string): Promise<P.ReactionContext['custom']> {
    const c = this.api();
    const fetchPack = async (cacheKey: string, name: string, path: string) => {
      const hit = this.packCache.get(cacheKey);
      if (hit && Date.now() - hit.at < 300_000) return hit.pack;
      const content = await c.request('GET', path).catch(() => null);
      const pack = content ? imagePack(cacheKey, name, content) : null;
      this.packCache.set(cacheKey, { at: Date.now(), pack });
      return pack;
    };
    const roomName = this.dir.rooms.get(roomId);
    const packs = [
      await fetchPack(`room:${roomId}`, (roomName && this.dir.displayName(roomName)) || 'This room', `/_matrix/client/v3/rooms/${enc(roomId)}/state/im.ponies.room_emotes/`),
      await fetchPack('user', 'Your emoji', `/_matrix/client/v3/user/${enc(this.selfId)}/account_data/im.ponies.user_emotes`),
    ];
    const enabled = await c.request('GET', `/_matrix/client/v3/user/${enc(this.selfId)}/account_data/im.ponies.emote_rooms`).catch(() => null);
    for (const [rid, keys] of Object.entries<any>(enabled?.rooms ?? {})) {
      for (const stateKey of Object.keys(keys ?? {})) {
        if (rid === roomId && !stateKey) continue;
        const from = this.dir.rooms.get(rid);
        packs.push(await fetchPack(`room:${rid}|${stateKey}`, (from && this.dir.displayName(from)) || 'Emoji pack', `/_matrix/client/v3/rooms/${enc(rid)}/state/im.ponies.room_emotes/${enc(stateKey)}`));
      }
    }
    return packs.filter((p): p is NonNullable<typeof p> => !!p && p.emoji.length > 0);
  }

  private async markRead(conversation: string, upTo: string) {
    const { roomId, root } = splitConversation(conversation);
    this.joinedRoom(roomId);
    const c = this.api();
    await c.request('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/receipt/m.read/${enc(upTo)}`, { body: root ? { thread_id: root } : {} });
    if (!root) await c.request('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/read_markers`, { body: { 'm.fully_read': upTo } });
    return { ok: true };
  }

  private async history(conversation: string, limit: number): Promise<P.HistoryResult> {
    const { roomId, root } = splitConversation(conversation);
    const room = this.joinedRoom(roomId);
    const want = Math.max(1, Math.min(limit || 50, 200));
    const ctx: Ctx = { live: false, mode: 'history', count: 0 };
    if (root) return this.threadHistory(room, root, want, ctx);
    for (let page = 0; page < 6 && ctx.count < want && room.backToken; page++) {
      const res: any = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/messages`, {
        query: { from: room.backToken, dir: 'b', limit: Math.min(100, want - ctx.count + 10), filter: LAZY },
      });
      this.historyMembers(room, res.state);
      await this.processTimeline(room, [...(res.chunk ?? [])].reverse(), ctx);
      room.backToken = typeof res.end === 'string' && res.end && res.chunk?.length ? res.end : '';
      this.db.saveRoom(room);
    }
    return { count: ctx.count, done: !room.backToken, ...(ctx.oldest !== undefined ? { oldest: ctx.oldest } : {}) };
  }

  private async threadHistory(room: Room, root: string, want: number, ctx: Ctx): Promise<P.HistoryResult> {
    const id = await this.ensureThread(room, root, ctx);
    let t = this.db.thread(id)!;
    for (let page = 0; page < 6 && ctx.count < want && !t.done; page++) {
      const res: any = await this.api().request('GET', `/_matrix/client/v1/rooms/${enc(room.id)}/relations/${enc(root)}/m.thread`, {
        query: { dir: 'b', limit: Math.min(100, want - ctx.count + 10), from: t.back_token ?? undefined },
      });
      await this.processTimeline(room, [...(res.chunk ?? [])].reverse(), ctx);
      t = { ...this.db.thread(id)!, back_token: res.next_batch ?? null, done: res.next_batch ? 0 : 1 };
      this.db.putThread(t);
    }
    if (!this.db.event(root)?.json) {
      const ev = await this.fetchEvent(room.id, root);
      if (ev) await this.processEvent(room, ev, { live: false, mode: 'fetch', count: 0 });
    }
    return { count: ctx.count, done: !!t.done, ...(ctx.oldest !== undefined ? { oldest: ctx.oldest } : {}) };
  }

  /**
   * The server's own search (POST /search, room_events on content.body): every room the account is in, a space's
   * rooms, or one conversation. Each hit is processed as history is (its thread first when it is in one), then the
   * reply names the messages; an edit that matched names the message it edits. The hub's offsets page through the
   * server's next_batch tokens (search.ts). Encrypted rooms are not searched by the server.
   */
  private async search(cmd: SearchCommand): Promise<P.NetworkSearchResult> {
    const q = cmd.query;
    if (!q.text?.trim()) throw new Error('Matrix searches by words: give some');
    let rooms: string[] | null = null;
    if (cmd.scope.kind === 'conversation') rooms = [this.joinedRoom(splitConversation(cmd.scope.id).roomId).id];
    else if (cmd.scope.kind === 'space') {
      const spaceId = cmd.scope.id;
      rooms = this.dir.joined().filter((r) => !r.isSpace && this.dir.parentsOf(r).some((s) => s.nativeId === spaceId)).map((r) => r.id);
    }
    if (q.in?.length) {
      const wanted = [...new Set(q.in.map((c) => splitConversation(c).roomId))];
      rooms = rooms ? rooms.filter((r) => wanted.includes(r)) : wanted;
    }
    const offset = Math.max(0, Math.floor(cmd.offset ?? 0));
    if (rooms && !rooms.length) return { hits: [], total: 0, next: null };
    const key = searchKey(cmd);
    const token = this.searchPages.token(key, offset);
    if (token === null) throw new Error('that page of the search is no longer known: search again');
    const res: any = await this.api().request('POST', '/_matrix/client/v3/search', {
      query: token ? { next_batch: token } : undefined,
      body: searchBody(q, rooms, cmd.limit ?? 25),
    });
    const found = res?.search_categories?.room_events ?? {};
    const results: any[] = Array.isArray(found.results) ? found.results : [];
    const ctx: Ctx = { live: false, mode: 'fetch', count: 0, hits: [] };
    const hits: string[] = [];
    for (const r of results) {
      const ev: MxEvent | undefined = r?.result;
      const room = ev?.room_id ? this.dir.rooms.get(ev.room_id) : undefined;
      if (!ev?.event_id || !room || room.membership !== 'join') continue;
      // search.ts's after and before: Matrix's search has no dates of its own.
      if ((q.after !== undefined && ev.origin_server_ts < q.after) || (q.before !== undefined && ev.origin_server_ts >= q.before)) continue;
      const from = ctx.hits!.length;
      await this.processTimeline(room, [ev], ctx);
      const rel = relationOf(ev.content ?? {});
      const emitted = ctx.hits!.slice(from);
      // A thread's root may come out first; the hit is the event itself, or the message an edit replaces.
      const hit = emitted.includes(ev.event_id) ? ev.event_id : rel.relType === 'm.replace' && rel.eventId && this.db.event(rel.eventId) ? rel.eventId : null;
      if (hit && !hits.includes(hit)) hits.push(hit);
    }
    const next = this.searchPages.keep(key, offset, results.length, found.next_batch);
    return { hits, total: typeof found.count === 'number' ? found.count : null, next };
  }

  /** The key to an encrypted attachment lives in the decrypted event that the attachment URL names. Only that event can say how to read it. */
  private async encryptedAttachment(eventId: string, mxc: string): Promise<{ file: Record<string, unknown>; mime: unknown } | null> {
    let ev = this.db.eventJson(eventId);
    if (!ev || ev.type === 'm.room.encrypted') {
      const room = this.db.event(eventId)?.room;
      if (room) ev = await this.fetchEvent(room, eventId);
    }
    const edited = this.db.edit(eventId);
    for (const content of [edited ? JSON.parse(edited.content) : null, ev?.content]) {
      const found = encryptedFileOf(content);
      if (found?.url === mxc) return { file: found, mime: content.info?.mimetype };
    }
    return null;
  }

  private async fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
    const m = url.match(/^mxc:\/\/([^/]+)\/([^/?#]+)/);
    if (!m) throw new Error(`not an mxc:// URL: ${url}`);
    const fragment = url.indexOf('#');
    let encrypted: Awaited<ReturnType<typeof this.encryptedAttachment>> = null;
    if (fragment >= 0) {
      if (!this.e2ee) throw new Error('this file is end-to-end encrypted and encryption is not set up');
      encrypted = await this.encryptedAttachment(url.slice(fragment + 1), url.slice(0, fragment));
      if (!encrypted) throw new Error('no key for this encrypted file');
    }
    const c = this.api();
    const path = `${enc(m[1])}/${enc(m[2])}`;
    let res = await c.raw('GET', `/_matrix/client/v1/media/download/${path}`, { timeoutMs: 60_000 });
    if (!res.ok && [400, 403, 404, 405].includes(res.status)) {
      const legacy = await c.raw('GET', `/_matrix/media/v3/download/${path}`, { timeoutMs: 60_000 });
      if (legacy.ok) res = legacy;
    }
    if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_MEDIA) throw new Error('media too large to proxy');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_MEDIA) throw new Error('media too large to proxy');
    if (encrypted) {
      const clear = this.e2ee!.decryptAttachment(bytes, encrypted.file);
      return { mime: this.e2ee!.safeMediaType(encrypted.mime), base64: Buffer.from(clear).toString('base64') };
    }
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    return { mime, base64: Buffer.from(bytes).toString('base64') };
  }

  private async action(action: string, args: unknown) {
    switch (action) {
      case 'resync':
        this.packCache.clear();
        return this.resync();
      case 'relogin':
        return this.relogin(args);
      case 'setupEncryption':
        return this.setupEncryption(args);
      case 'encryptionStatus':
        return this.encryptionStatus();
      case 'addRecoveryKey':
        return this.addRecoveryKey(args);
      case 'verifyDevice':
        return this.verifyDevice(args);
      case 'status':
        return {
          userId: this.selfId || null,
          deviceId: this.deviceId || null,
          homeserver: this.client?.baseUrl ?? null,
          status: this.status,
          since: this.db.get('since'),
          rooms: this.dir.joined().filter((r) => !r.isSpace).length,
          spaces: this.dir.joined().filter((r) => r.isSpace).length,
          threads: this.db.threads().length,
        };
      default:
        throw new Error(`unknown action "${action}" (matrix supports resync, relogin, status, setupEncryption, encryptionStatus, addRecoveryKey, verifyDevice)`);
    }
  }

  /** Forget the since token and run a full initial sync (facts re-sent with live=false). */
  private async resync() {
    this.api();
    this.db.set('since', null);
    this.emitted.clear();
    const done = new Promise<number>((r) => this.resyncWaiters.push(r));
    this.syncAbort?.abort();
    const rooms = await Promise.race([done, Bun.sleep(50_000).then(() => -1)]);
    return rooms < 0 ? { started: true, note: 'initial sync still running' } : { ok: true, rooms };
  }

  private async relogin(args: unknown) {
    const secret = this.hub.secret<Secret>();
    const password = typeof (args as any)?.password === 'string' ? (args as any).password : secret.password;
    if (!password) throw new Error('relogin needs args {"password": "..."} (or a password in secret.json)');
    const { accessToken: _old, ...rest } = secret;
    this.hub.saveSecret({ ...rest, password, ...(typeof (args as any)?.userId === 'string' ? { userId: (args as any).userId } : {}) });
    this.restartSession = true;
    this.syncAbort?.abort();
    this.wakeUp?.();
    return { ok: true };
  }

  // ================================================================ end-to-end encryption

  private e2eeAttention(): Omit<P.Attention, 'since'> | null {
    if (this.e2eeError) return { kind: 'unknown', message: `Encryption is not working: ${this.e2eeError}` };
    const v = this.verification;
    if (!v) return null;
    const device = v.otherDeviceName ? `${v.otherDeviceName} (${v.otherDevice})` : v.otherDevice ? `Device ${v.otherDevice}` : 'Another device';
    const message =
      v.phase === 'requested'
        ? `${device} asks to verify this one.`
        : v.phase === 'ready'
          ? `Waiting for ${device} to show the emoji.`
          : v.phase === 'compare'
            ? `Compare these emoji with ${device}.`
            : v.phase === 'confirmed'
              ? `Waiting for ${device} to confirm.`
              : v.phase === 'ended'
                ? `Verification ${v.outcome === 'timeout' ? 'timed out' : v.outcome === 'mismatch' ? 'stopped: the emoji did not match' : 'was cancelled'}: ${v.reason ?? ''}`.trim()
                : v.otherDevice
                  ? `Verifying with ${device}…`
                  : 'Asked your other devices to verify this one…';
    return { kind: 'verify', message, detail: { verification: v } };
  }

  private refreshAttention() {
    if (this.status !== 'attention') this.setStatus(this.status, this.e2eeAttention());
  }

  /**
   * Start the crypto layer if this account has it on. A failure that is about the crypto state
   * (a store that does not match the published device) leaves the account running without it:
   * encrypted rooms stay unreadable and refuse writes, everything else works.
   */
  private async startE2ee(): Promise<void> {
    const secret = this.hub.secret<Secret>();
    const opts = secret.e2ee;
    if (!opts?.on || this.e2ee?.deviceId === this.deviceId) return;
    if (!this.deviceId) throw new Error('the homeserver did not say which device this is');
    // A login that came back as another device: that one has a store of its own.
    this.e2ee?.close();
    this.e2ee = null;
    const notWorking = (message: string) => {
      this.e2eeError = message;
      this.log('error', `encryption is off: ${message}`);
      this.refreshAttention();
    };
    let e2ee: E2ee;
    try {
      const { E2ee } = await import('./e2ee.ts');
      e2ee = await E2ee.open({
        dir: this.hub.accountDir,
        userId: this.selfId,
        deviceId: this.deviceId,
        storeKey: opts.storeKey,
        client: () => this.api(),
        log: (level, msg) => this.log(level, msg),
        onRoomKeys: (keys) => {
          for (const k of keys) this.keysArrived.add(k.sessionId);
          this.retryArrived().catch((e) => this.log('warn', `retrying events failed: ${describe(e)}`));
        },
        onVerification: (v) => {
          const was = !!this.verification && this.verification.phase !== 'ended';
          this.verification = v;
          // A flow just began: end the long poll now, so the next sync already runs the short way.
          if (!was && v && v.phase !== 'ended') this.syncAbort?.abort();
          this.refreshAttention();
        },
      });
    } catch (e) {
      return notWorking(`the crypto store did not open (${describe(e)})`);
    }
    try {
      await this.checkPublishedDevice(e2ee);
    } catch (e) {
      e2ee.close();
      if (e instanceof DeviceMismatch) return notWorking(e.message);
      throw e; // the homeserver is unreachable: the session retries, this included
    }
    this.e2ee = e2ee;
    this.e2eeError = null;
    this.emitHello();
    this.refreshAttention();
    this.log('info', `encryption is on: device ${this.deviceId}`);
    await e2ee.flush().catch((e) => this.log('warn', `could not reach the homeserver for crypto requests: ${describe(e)}`));
    await e2ee.resumeBackup().catch((e) => this.log('warn', `could not check the room key backup: ${describe(e)}`));
    if (opts.recoveryKey) {
      const st = await e2ee.status();
      if (!st.backup || !st.verified) await this.applyRecoveryKey(opts.recoveryKey);
    }
    this.retryEverything();
  }

  /** The server's copy of this device must be the one in our store. Otherwise other people's keys go to a device that is not us, and nothing decrypts. */
  private async checkPublishedDevice(e2ee: E2ee) {
    const res = await this.api().request('POST', '/_matrix/client/v3/keys/query', { body: { device_keys: { [this.selfId]: [this.deviceId] } } });
    const published = res.device_keys?.[this.selfId]?.[this.deviceId]?.keys?.[`ed25519:${this.deviceId}`];
    if (typeof published === 'string' && published.replace(/=+$/, '') !== e2ee.identity.ed25519.replace(/=+$/, '')) {
      throw new DeviceMismatch(`device ${this.deviceId} already has other keys on the homeserver, so crypto.sqlite does not belong to it. Log this account in again as a new device`);
    }
  }

  private async setupEncryption(args: unknown) {
    this.api();
    const recoveryKey = typeof (args as any)?.recoveryKey === 'string' ? (args as any).recoveryKey.trim() : '';
    const before = this.hub.secret<Secret>();
    const storeKey = before.e2ee?.storeKey ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    this.hub.saveSecret({ ...before, e2ee: { ...before.e2ee, on: true, storeKey } });
    this.e2eeError = null;
    try {
      await this.startE2ee();
      if (!this.e2ee) throw new Error(this.e2eeError ?? 'encryption did not start');
      await this.e2ee.flush(); // the keys are published, or this fails
    } catch (e) {
      // Keep the store key: the store may hold a device identity by now, and a second try has to reuse it.
      this.hub.saveSecret({ ...this.hub.secret<Secret>(), e2ee: { on: false, storeKey } });
      this.e2ee?.close();
      this.e2ee = null;
      this.e2eeError = null;
      this.emitHello();
      this.refreshAttention();
      throw e;
    }
    if (recoveryKey) await this.addRecoveryKey({ recoveryKey }).catch(() => {}); // reported through encryptionStatus
    return this.encryptionStatus();
  }

  private async encryptionStatus() {
    const secret = this.hub.secret<Secret>();
    const base = { on: !!secret.e2ee?.on, error: this.e2eeError, recoveryKeySaved: !!secret.e2ee?.recoveryKey, recoveryError: this.recoveryError, recovery: this.recovery, undecrypted: this.db.utdCount() };
    return this.e2ee ? { ...base, ...(await this.e2ee.status()) } : { ...base, active: false, deviceId: this.deviceId || null };
  }

  /** Saved only once it has proved to open something, so a typo is not kept as a secret. */
  private async addRecoveryKey(args: unknown) {
    if (!this.e2ee) throw new Error('set up encryption first');
    const key = typeof (args as any)?.recoveryKey === 'string' ? (args as any).recoveryKey.trim() : '';
    if (!key) throw new Error('addRecoveryKey needs args {"recoveryKey": "..."}');
    if (!(await this.applyRecoveryKey(key))) throw new Error(this.recoveryError ?? 'that key opened nothing');
    const secret = this.hub.secret<Secret>();
    this.hub.saveSecret({ ...secret, e2ee: { ...secret.e2ee!, recoveryKey: key } });
    return this.encryptionStatus();
  }

  private async applyRecoveryKey(key: string): Promise<boolean> {
    try {
      const got = await this.e2ee!.applyRecoveryKey(key);
      const worked = got.backup || got.crossSigned;
      this.recovery = { backup: got.backup, crossSigned: got.crossSigned, problems: got.problems };
      this.recoveryError = worked ? null : `the key is right, but ${got.problems.join('; ') || 'it unlocks nothing this device can use'}`;
      this.log(worked ? 'info' : 'warn', `recovery key ${worked ? 'accepted' : 'opened nothing usable'} (room key backup: ${got.backup}, device signed: ${got.crossSigned})${got.problems.length ? `: ${got.problems.join('; ')}` : ''}`);
      this.retryEverything();
      return worked;
    } catch (e) {
      this.recoveryError = describe(e);
      this.log('warn', `recovery key not accepted: ${this.recoveryError}`);
      return false;
    }
  }

  private async verifyDevice(args: unknown) {
    if (!this.e2ee) throw new Error('set up encryption first');
    await this.e2ee.verifyAction(String((args as any)?.step ?? ''));
    return this.encryptionStatus();
  }

  /**
   * The cleartext form of an encrypted event, or the event as it came if there is no key for it yet
   * (it is then kept for a retry). Plain events pass through, with any encrypted edit bundled in them decrypted.
   */
  private async decrypted(room: Room, ev: MxEvent): Promise<MxEvent> {
    const e2ee = this.e2ee;
    if (!e2ee || isRedacted(ev)) return ev;
    const bundled = ev.unsigned?.['m.relations']?.['m.replace'];
    if (bundled?.type === 'm.room.encrypted') {
      const d = await e2ee.decrypt(bundled, room.id);
      ev = { ...ev, unsigned: { ...ev.unsigned, 'm.relations': { ...ev.unsigned!['m.relations'], 'm.replace': d ? { ...bundled, type: d.type, content: d.content, e2ee: true } : undefined } } };
    }
    if (ev.type !== 'm.room.encrypted') return ev;
    // Seen and decrypted before: the same answer, whatever has happened to the keys since.
    const known = this.db.eventJson(ev.event_id);
    if (known && known.type !== 'm.room.encrypted') return { ...ev, type: known.type, content: known.content, e2ee: true };
    const d = await e2ee.decrypt(ev, room.id);
    const session = ev.content?.session_id;
    if (!d) {
      if (typeof session === 'string') {
        this.db.putUtd({ id: ev.event_id, room: room.id, session });
        e2ee.wantSession(room.id, session);
      }
      return ev;
    }
    this.db.dropUtd(ev.event_id);
    return { ...ev, type: d.type, content: d.content, e2ee: true };
  }

  /** Keys arrived: decrypt what was waiting for them, and update what the hub shows. */
  private async retryArrived() {
    if (this.retrying) return;
    this.retrying = true;
    try {
      while (this.keysArrived.size && !this.stopped) {
        const sessions = [...this.keysArrived];
        this.keysArrived.clear();
        for (const session of sessions) for (const row of this.db.utdOfSession(session)) await this.retryOne(row);
      }
    } finally {
      this.retrying = false;
    }
  }

  private async retryOne(row: UtdRow) {
    const room = this.dir.rooms.get(row.room);
    const stored = this.db.event(row.id);
    const ev = this.db.eventJson(row.id);
    if (!room || !this.e2ee || !ev || !stored || stored.redacted) {
      this.db.dropUtd(row.id);
      return;
    }
    try {
      const clear = await this.decrypted(room, ev);
      if (clear.type === 'm.room.encrypted') return;
      const ctx: Ctx = { live: false, mode: 'fetch', count: 0 };
      await this.processEvent(room, clear, ctx);
      // It turned out to be no message (a reaction, an edit, a call event). Take back the "encrypted message" bubble, if it ever had one.
      if (!ctx.count && !this.isEditOf(clear)) this.hub.emit({ t: 'delete', conversation: stored.conv, nativeId: row.id });
      const t = this.db.thread(threadId(room.id, row.id));
      if (t) {
        const name = this.threadName(room, clear);
        if (name !== t.name) {
          this.db.putThread({ ...t, name });
          this.emitThreadFact({ ...t, name });
        }
      }
    } catch (e) {
      this.log('warn', `could not retry ${row.id}: ${describe(e)}`);
    }
  }

  private isEditOf(ev: MxEvent): boolean {
    return relationOf(ev.content).relType === 'm.replace';
  }

  /**
   * Everything the adapter holds without a key: on startup, after a recovery key, and
   * once after setup for what was stored while encryption was off.
   */
  private retryEverything() {
    this.retryWaiting().catch((e) => this.log('warn', `retrying events failed: ${describe(e)}`));
  }

  private async retryWaiting() {
    if (!this.e2ee) return;
    // Encrypted edits used to be stored without their content.
    for (const id of this.db.encryptedWithoutJson()) {
      if (this.stopped || !this.e2ee) return;
      const row = this.db.event(id);
      const ev = row && (await this.fetchEvent(row.room, id));
      const room = row && this.dir.rooms.get(row.room);
      if (ev && row && room) {
        this.db.putEvent(ev, row.room, row.conv, true);
        if (ev.type !== 'm.room.encrypted') await this.processEvent(room, ev, { live: false, mode: 'fetch', count: 0 });
      }
    }
    this.db.utdFromEvents();
    for (const row of this.db.utdAll()) {
      if (this.stopped || !this.e2ee) return;
      await this.retryOne(row);
    }
  }
}
