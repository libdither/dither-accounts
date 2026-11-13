/**
 * A fake Telegram for tests (TELEGRAM_FAKE=1): the TgBackend the adapter uses, answering the MTProto methods it calls
 * with TL objects shaped as Telegram's, over a small world of its own (fake-telegram.json in the account directory,
 * so a restart finds the same chats and the same session). Nothing here reaches the network.
 *
 * Driven from outside through a control socket, <account dir>/fake-telegram.sock, one JSON object per line, each
 * answered with { ok, result } or { ok: false, error }:
 *
 *   { op: 'scan' }                                  the phone scans the QR code shown now
 *   { op: 'setPassword', password, hint? }          the account has a two-step password (null: none)
 *   { op: 'incoming', peer, from, text, topic?, replyTo?, entities? }   someone writes (peer: user:<id> | chat:<id> | channel:<id>)
 *   { op: 'edit', peer, id, text } | { op: 'delete', peer, ids } | { op: 'react', peer, id, from, key | null }
 *   { op: 'typing', peer, from, topic?, stop? } | { op: 'readOutbox', peer, maxId } | { op: 'pin', peer, id, pinned }
 *   { op: 'rename', peer, title }                   a chat's title changes (updateChannel / a service message)
 *   { op: 'flood', method, seconds }                the next call of `method` gets FLOOD_WAIT_<seconds>
 *   { op: 'fail', method, error }                   the next call of `method` fails with Telegram's `error`
 *   { op: 'revoke' }                                the session is ended from another device
 *   { op: 'authorizeKey', fingerprint }             Telegram Desktop signed in with this key (tdata.ts keyFingerprint):
 *                                                   its session is fake-key:<fingerprint>
 *   { op: 'endKey', fingerprint }                   that session ends (Telegram Desktop signed out)
 *   { op: 'refuseAccept', error | null }            auth.acceptLoginToken from a Desktop key fails with this error
 *   { op: 'loginToken', device?, platform?, app?, appVersion?, country?, region?, ttlMs? }
 *                                                   another device shows a QR code to sign in to this account:
 *                                                   { link: 'tg://login?token=…' }, for approveLogin (30 s; ttlMs: 0
 *                                                   makes one that has already expired)
 *   { op: 'ageSession', hours? }                    the signed-in session was made `hours` (25) ago: under a day, it
 *                                                   may not end other sessions (FRESH_RESET_AUTHORISATION_FORBIDDEN)
 *   { op: 'loginCode', code? }                      Telegram (user 777000) sends a login code, as it does when
 *                                                   someone signs in on another device by phone
 *   { op: 'joinRequest', chat, user, withdraw? }    someone asks to join a chat (withdraw: the request goes, as when
 *                                                   they take it back or another admin answers it); admins get
 *                                                   updatePendingJoinRequests
 *   { op: 'invite', hash, chat, requestNeeded?, expired?, peek?, webview? }   an invite link to a chat
 *   { op: 'block', user, blocked?, silent? }        the account blocks (blocked: false, unblocks) someone on another
 *                                                   device: updatePeerBlocked, unless silent
 *   { op: 'contact', user, contact?, silent? }      a contact added (contact: false, removed) on another device:
 *                                                   updatePeerSettings with them, unless silent (then only reading
 *                                                   the list again, or their user's contact flag, shows it)
 *   { op: 'privacy', user, add }                    whom someone lets add them to groups: 'everyone' (the default),
 *                                                   'nobody', or 'premium' (Telegram Premium users only); the others
 *                                                   come back as missingInvitees
 *   { op: 'calls', since?, method?, full? }         the methods called so far, with when (full: and what was sent)
 *   { op: 'world' }                                 a summary (sessions, chats, the last messages)
 *
 * Sign-in: the QR flow makes a tg://login?token=… code every TELEGRAM_FAKE_QR_MS (30 s); sendCode accepts any
 * number and expects 12345, or, for Telegram's test numbers 99966XYYYY, X five times, as the test DCs do.
 *
 * Adding (docs/telegram.md): chats the account is not in (a group to join by invite, one that asks first, a public
 * channel, a public group that asks first, one whose bot checks new members, one to peek into), invite links to them
 * (FAKE_INVITES; one expired), people it has no contact with (Dave, by name and by number; Erin; Frank), and join
 * requests waiting in the chats it admins (Erin to dither devs, Frank to the forum).
 *
 * Contacts and blocks: Alice and Bob are contacts; Grace is blocked, and so is a group (blocked chats are not people).
 * contacts.getContacts answers contactsNotModified to the hash of the list as it is.
 *
 * Adding people to groups: messages.addChatUser and channels.inviteToChannel add anyone whose privacy settings let
 * them be added (op privacy) to a chat whose members may add people (any member, unless the chat's `inviteBanned`;
 * admins always), with a service message ("added …") in a group. Basic groups hold 200. messages.createChat makes a
 * basic group with everyone whose privacy settings let them in; the rest come back as missingInvitees.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Long } from '@mtcute/bun';
import { contactsHash, outputEntity } from './adapter.ts';
import { type BackendInfo, type ConnState, type DeskClient, type DesktopKey, FakeRpcError, type QrHandlers, type SentCode, type TgBackend, type tl, type UpdateInfo, type UploadSpec } from './backend.ts';

interface WUser {
  id: number;
  hash: string;
  first: string;
  last?: string;
  username?: string;
  phone?: string;
  contact?: boolean;
  bot?: boolean;
  verified?: boolean;
  photo?: string;
  about?: string;
  /** Whom they let add them to groups (absent: everyone): the others are their missingInvitees. */
  addPrivacy?: 'nobody' | 'premium';
}
/** One of the account's other sessions (Settings → Devices). Hashes are signed 64-bit numbers, as Telegram's. */
interface WAuth {
  hash: string;
  device: string;
  platform: string;
  system: string;
  app: string;
  appVersion: string;
  apiId: number;
  country: string;
  region: string;
  ip: string;
  /** seconds */
  created: number;
  active: number;
}
interface WChat {
  id: number;
  kind: 'chat' | 'channel';
  hash?: string;
  title: string;
  username?: string;
  broadcast?: boolean;
  forum?: boolean;
  noforwards?: boolean;
  about?: string;
  members: number[];
  admins: number[];
  creator: number;
  slowmode?: number;
  joinRequest?: boolean;
  invite?: string | null;
  /** A picture: its photo id (the bytes in `files`). */
  photo?: string;
  topics?: { id: number; title: string }[];
  nextId?: number;
  reactions?: 'all' | 'none' | string[];
  /** Its members may not add people (the default banned rights); admins still may. */
  inviteBanned?: boolean;
}
interface WMedia {
  kind: 'photo' | 'document';
  id: string;
  mime: string;
  size: number;
  name?: string;
  w?: number;
  h?: number;
  sticker?: string;
  video?: boolean;
}
interface WMsg {
  id: number;
  from: number;
  date: number;
  text: string;
  entities?: tl.TypeMessageEntity[];
  replyTo?: number;
  topic?: number;
  edit?: number;
  media?: WMedia;
  reactions?: Record<string, number[]>;
  counts?: Record<string, number>;
  service?: { kind: 'chatCreate' | 'topicCreate' | 'topicEdit' | 'editTitle' | 'pin' | 'addUser'; title?: string; users?: number[] };
  fwd?: { fromName?: string; from?: number; date: number; channel?: number; post?: number };
  grouped?: string;
  pinned?: boolean;
  views?: number;
}
/** An invite link (t.me/+<hash>) to a chat. */
interface WInvite {
  hash: string;
  chat: number;
  /** The admins approve who joins by it (INVITE_REQUEST_SENT). */
  requestNeeded?: boolean;
  expired?: boolean;
  /** Not a member: Telegram lets you look in for this many seconds (chatInvitePeek). */
  peek?: number;
  /** Joining by it wants the group's bot to check you first (messages.chatInviteJoinResultWebView). */
  webview?: boolean;
}
/** Someone asks to join a chat. */
interface WJoinRequest {
  chat: number;
  user: number;
  date: number;
}
interface World {
  v: 1;
  self: number;
  password: string | null;
  hint: string | null;
  sessions: string[];
  users: WUser[];
  chats: WChat[];
  msgs: Record<string, WMsg[]>;
  nextPrivate: number;
  pts: number;
  read: Record<string, { inbox: number; outbox: number }>;
  muted: Record<string, number>;
  archived: string[];
  files: Record<string, string>;
  /** The account's other sessions (older worlds have none until first asked). */
  authorizations?: WAuth[];
  /** When each of this backend's sessions was made (seconds); a session not here is older than a day. */
  sessionAt?: Record<string, number>;
  /** Invite links, join requests waiting in chats, and the chats this account asked to join (older worlds: none). */
  invites?: WInvite[];
  joinRequests?: WJoinRequest[];
  asked?: number[];
  /** The account's blocklist: people (user:<id>) and chats, with when (seconds). Older worlds: none. */
  blocked?: { peer: string; date: number }[];
}

const T0 = () => Math.floor(Date.now() / 1000) - 86_400;
const DC = 2;
const b64url = (n = 16) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
const hashOf = () => Long.fromBits((Math.random() * 2 ** 32) | 0, (Math.random() * 2 ** 31) | 0).toString();
/** A 1×1 PNG, for photos and avatars. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export const FAKE_IDS = {
  self: 5000001,
  alice: 5000002,
  bob: 5000003,
  carol: 5000004,
  bot: 5000005,
  dave: 5000006,
  erin: 5000007,
  frank: 5000008,
  grace: 5000009,
  group: 400001,
  devs: 1700000001,
  forum: 1700000002,
  news: 1700000003,
  // Chats this account is not in.
  film: 1700000004,
  climb: 1700000005,
  open: 1700000006,
  askFirst: 1700000007,
  checked: 1700000008,
  peek: 1700000009,
  telegram: 777000,
} as const;

/** Invite hashes (t.me/+<hash>) in the seeded world, and what each leads to. */
export const FAKE_INVITES = { film: 'FilmSwap2026x', devs: 'DevsInvite2026', climb: 'ClimbAsk2026x', expired: 'OldParty2025x', checked: 'BotCheck2026x', peek: 'PeekGroup2026' } as const;

/** Telegram's service account, which sends login codes and notices (not in the world until it writes). */
const SERVICE_USER: WUser = { id: FAKE_IDS.telegram, hash: '6155380425338120001', first: 'Telegram', phone: '42777', verified: true };

/** The sessions the account has besides this one: a phone, and Telegram Desktop elsewhere. */
function seedAuthorizations(): WAuth[] {
  const t = Math.floor(Date.now() / 1000);
  return [
    { hash: '-4783920175539012345', device: 'iPhone 15', platform: 'iOS', system: 'iOS 18.1', app: 'Telegram iOS', appVersion: '11.3', apiId: 8, country: 'Netherlands', region: 'North Holland', ip: '203.0.113.7', created: t - 200 * 86_400, active: t - 600 },
    { hash: '1290348756102938475', device: 'Desktop', platform: 'Linux', system: 'Linux X11 glibc 2.40', app: 'Telegram Desktop', appVersion: '5.8.3', apiId: 2040, country: 'Germany', region: '', ip: '198.51.100.20', created: t - 40 * 86_400, active: t - 3 * 86_400 },
  ];
}

/** How this backend's own session shows in the list (Telegram gives it hash 0). */
const CURRENT_AUTH = { device: 'dither-accounts', platform: 'Linux', system: 'Linux', app: 'Telegram Desktop', appVersion: '7.2.9', apiId: 611335, country: 'Netherlands', region: 'North Holland', ip: '192.0.2.10' } as const;

function seed(): World {
  const t = T0();
  const { self, alice, bob, carol, bot, dave, erin, frank, grace, group, devs, forum, news, film, climb, open, askFirst, checked, peek } = FAKE_IDS;
  const w: World = {
    v: 1,
    self,
    password: null,
    hint: null,
    sessions: [],
    users: [
      { id: self, hash: hashOf(), first: 'Test', last: 'User', username: 'testuser', phone: '9996621234', photo: '9100' },
      { id: alice, hash: hashOf(), first: 'Alice', last: 'Liddell', username: 'alice', phone: '9996620001', contact: true, photo: '9101', about: 'Down the rabbit hole' },
      { id: bob, hash: hashOf(), first: 'Bob', username: 'bob', contact: true },
      { id: carol, hash: hashOf(), first: 'Carol', username: 'carol_c' },
      { id: bot, hash: hashOf(), first: 'Helper', username: 'helperbot', bot: true },
      { id: dave, hash: hashOf(), first: 'Dave', last: 'Doe', username: 'dave_d', phone: '9996620006', photo: '9106' },
      { id: erin, hash: hashOf(), first: 'Erin', username: 'erin_e' },
      { id: frank, hash: hashOf(), first: 'Frank', phone: '9996620008' },
      { id: grace, hash: hashOf(), first: 'Grace', username: 'grace_g' },
    ],
    chats: [
      { id: group, kind: 'chat', title: 'Weekend plans', members: [self, alice, bob], admins: [], creator: alice, invite: null },
      { id: devs, kind: 'channel', hash: hashOf(), title: 'dither devs', username: 'ditherdevs', about: 'Talk about dither', members: [self, alice, bob, carol], admins: [self], creator: alice, slowmode: 0, invite: null, nextId: 4, reactions: 'all' },
      { id: forum, kind: 'channel', hash: hashOf(), title: 'Forum', forum: true, members: [self, alice, bob], admins: [], creator: self, topics: [{ id: 1, title: 'General' }, { id: 2, title: 'Releases' }, { id: 4, title: 'Bugs' }], nextId: 6, invite: null },
      { id: news, kind: 'channel', hash: hashOf(), title: 'Announcements', username: 'ditherNews', broadcast: true, noforwards: true, members: [self], admins: [], creator: carol, nextId: 3 },
      // Not in these.
      { id: film, kind: 'channel', hash: hashOf(), title: 'Film Photo Swap', about: 'Swap rolls, share scans', members: [alice, carol, dave], admins: [], creator: alice, photo: '9201', nextId: 2 },
      { id: climb, kind: 'channel', hash: hashOf(), title: 'Climbers', about: 'Bouldering on weekends', members: [bob, dave], admins: [], creator: bob, joinRequest: true, nextId: 1 },
      { id: open, kind: 'channel', hash: hashOf(), title: 'Open Notes', username: 'opennotes', about: 'Notes in the open', broadcast: true, members: [carol], admins: [], creator: carol, photo: '9202', nextId: 2 },
      { id: askFirst, kind: 'channel', hash: hashOf(), title: 'Ask First', username: 'askfirst', members: [carol, dave], admins: [], creator: carol, joinRequest: true, nextId: 1 },
      { id: checked, kind: 'channel', hash: hashOf(), title: 'Checked Group', members: [carol], admins: [], creator: carol, nextId: 1 },
      { id: peek, kind: 'channel', hash: hashOf(), title: 'Peek Group', members: [carol], admins: [], creator: carol, nextId: 1 },
    ],
    msgs: {
      [`user:${alice}`]: [
        { id: 1, from: alice, date: t + 60, text: 'Hi! Are we still on for Saturday?' },
        { id: 2, from: self, date: t + 120, text: 'Yes, 10am at the park', entities: [{ _: 'messageEntityBold', offset: 5, length: 4 }] },
        { id: 3, from: alice, date: t + 180, text: 'Great, see you there', replyTo: 2, reactions: { '❤': [self] } },
      ],
      [`user:${bob}`]: [{ id: 4, from: bob, date: t + 240, text: 'Check out this photo', media: { kind: 'photo', id: '8001', mime: 'image/jpeg', size: PIXEL.length, w: 1, h: 1 } }],
      [`user:${self}`]: [{ id: 5, from: self, date: t + 300, text: 'note to self: buy milk' }],
      [`chat:${group}`]: [
        { id: 6, from: alice, date: t + 360, text: '', service: { kind: 'chatCreate', title: 'Weekend plans' } },
        { id: 7, from: alice, date: t + 420, text: 'Who brings snacks?' },
        { id: 8, from: bob, date: t + 480, text: 'Test can you?', entities: [{ _: 'messageEntityMentionName', offset: 0, length: 4, userId: self }] },
      ],
      [`channel:${devs}`]: [
        { id: 1, from: carol, date: t + 540, text: 'Welcome everyone' },
        { id: 2, from: alice, date: t + 600, text: 'Release notes are up', entities: [{ _: 'messageEntityTextUrl', offset: 0, length: 13, url: 'https://example.com/notes' }], pinned: true },
        { id: 3, from: bob, date: t + 660, text: 'Thanks!', replyTo: 2 },
      ],
      [`channel:${forum}`]: [
        { id: 1, from: alice, date: t + 700, text: 'hello forum', topic: 1 },
        { id: 2, from: self, date: t + 710, text: '', topic: 2, service: { kind: 'topicCreate', title: 'Releases' } },
        { id: 3, from: self, date: t + 720, text: 'v0.1 is out', topic: 2 },
        { id: 4, from: alice, date: t + 730, text: '', topic: 4, service: { kind: 'topicCreate', title: 'Bugs' } },
        { id: 5, from: bob, date: t + 740, text: 'found a crash', topic: 4 },
      ],
      [`channel:${news}`]: [
        { id: 1, from: carol, date: t + 800, text: 'Welcome to the channel', views: 120 },
        { id: 2, from: carol, date: t + 860, text: 'Big news', views: 80, counts: { '🔥': 5 } },
      ],
      [`channel:${film}`]: [{ id: 1, from: alice, date: t + 900, text: 'Swap table on Saturday' }],
      [`channel:${open}`]: [{ id: 1, from: carol, date: t + 910, text: 'First note', views: 12 }],
    },
    nextPrivate: 9,
    pts: 100,
    read: { [`user:${alice}`]: { inbox: 1, outbox: 2 } },
    muted: { [`channel:${news}`]: 2_147_483_647 },
    archived: [],
    files: { '8001': PIXEL.toString('base64'), '9201': PIXEL.toString('base64') },
    invites: [
      { hash: FAKE_INVITES.film, chat: film },
      { hash: FAKE_INVITES.devs, chat: devs },
      { hash: FAKE_INVITES.climb, chat: climb, requestNeeded: true },
      { hash: FAKE_INVITES.expired, chat: film, expired: true },
      { hash: FAKE_INVITES.checked, chat: checked, webview: true },
      { hash: FAKE_INVITES.peek, chat: peek, peek: 3600 },
    ],
    joinRequests: [
      { chat: devs, user: erin, date: t + 950 },
      { chat: forum, user: frank, date: t + 960 },
    ],
    blocked: [
      { peer: `user:${grace}`, date: t + 970 },
      { peer: `channel:${checked}`, date: t + 980 },
    ],
  };
  for (const [k, list] of Object.entries(w.msgs)) {
    const last = list[list.length - 1];
    w.read[k] ??= { inbox: last.id, outbox: last.id };
  }
  return w;
}

type Peer = `${'user' | 'chat' | 'channel'}:${number}`;

export interface FakeOptions {
  dir: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** How long each QR code lasts. */
  qrMs?: number;
  /** Listen on the control socket. */
  control?: boolean;
}

export class FakeTelegram implements TgBackend {
  world: World;
  private path: string;
  private session: string | null = null;
  private signedIn = false;
  private revoked = false;
  private onUpdate: ((u: UpdateInfo) => void) | null = null;
  private queue: UpdateInfo[] = [];
  private scanWaiter: ((v: boolean) => void) | null = null;
  private pendingCode: { phone: string; hash: string; code: string } | null = null;
  private needPassword = false;
  private floods = new Map<string, number>();
  private fails = new Map<string, string>();
  readonly calls: { method: string; at: number; req: unknown }[] = [];
  private server: ReturnType<typeof Bun.listen> | null = null;
  private saveTimer?: Timer;
  private uploads = new Map<string, { name: string; bytes: Buffer }>();
  qrUrl: string | null = null;
  private refuseAccept: string | null = null;
  /** QR codes other devices show to sign in (base64url token → who, until when, whether used). */
  private loginTokens = new Map<string, { expires: number; accepted: boolean; who: Omit<WAuth, 'hash' | 'ip' | 'created' | 'active'> }>();

  constructor(private o: FakeOptions) {
    this.path = join(o.dir, 'fake-telegram.json');
    this.world = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as World) : seed();
    this.save(true);
    if (o.control) this.listen();
  }

  // ---------------------------------------------------------------- persistence, control

  private save(now = false) {
    const write = () => {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.world), { mode: 0o600 });
      renameSync(tmp, this.path);
    };
    if (now) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      return write();
    }
    if (!this.saveTimer)
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        write();
      }, 100);
  }

  private listen() {
    const sock = fakeSocketPath(this.o.dir);
    if (existsSync(sock)) rmSync(sock);
    let buf = '';
    this.server = Bun.listen({
      unix: sock,
      socket: {
        data: (s, data) => {
          buf += Buffer.from(data).toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            Promise.resolve()
              .then(() => this.control(JSON.parse(line)))
              .then(
                (result) => s.write(JSON.stringify({ ok: true, result: result ?? null }) + '\n'),
                (e) => s.write(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }) + '\n'),
              );
          }
        },
      },
    });
  }

  /** One control command (the socket's, or a test's in-process). */
  async control(c: any): Promise<unknown> {
    switch (c.op) {
      case 'scan':
        if (!this.scanWaiter) throw new Error('no QR code is waiting');
        this.scanWaiter(true);
        return { scanned: true };
      case 'setPassword':
        this.world.password = c.password ?? null;
        this.world.hint = c.hint ?? null;
        this.save();
        return {};
      case 'incoming':
        return this.incoming(c.peer, c.from, c.text, { topic: c.topic, replyTo: c.replyTo, entities: c.entities });
      case 'edit': {
        const m = this.msg(c.peer, c.id);
        m.text = c.text;
        m.edit = now();
        this.push(this.isChannel(c.peer) ? { _: 'updateEditChannelMessage', message: this.tlMessage(c.peer, m), pts: ++this.world.pts, ptsCount: 1 } : { _: 'updateEditMessage', message: this.tlMessage(c.peer, m), pts: ++this.world.pts, ptsCount: 1 });
        return {};
      }
      case 'delete': {
        const list = this.list(c.peer);
        this.world.msgs[c.peer] = list.filter((m) => !c.ids.includes(m.id));
        this.push(this.isChannel(c.peer) ? { _: 'updateDeleteChannelMessages', channelId: idOf(c.peer), messages: c.ids, pts: ++this.world.pts, ptsCount: c.ids.length } : { _: 'updateDeleteMessages', messages: c.ids, pts: ++this.world.pts, ptsCount: c.ids.length });
        return {};
      }
      case 'react': {
        const m = this.msg(c.peer, c.id);
        this.setReaction(m, c.from, c.key ? [c.key] : []);
        this.push({ _: 'updateMessageReactions', peer: this.tlPeer(c.peer), msgId: m.id, reactions: this.tlReactions(c.peer, m)! });
        return {};
      }
      case 'typing': {
        const action: tl.TypeSendMessageAction = { _: c.stop ? 'sendMessageCancelAction' : 'sendMessageTypingAction' };
        if (c.peer.startsWith('user:')) this.push({ _: 'updateUserTyping', userId: c.from, action });
        else if (c.peer.startsWith('chat:')) this.push({ _: 'updateChatUserTyping', chatId: idOf(c.peer), fromId: { _: 'peerUser', userId: c.from }, action });
        else this.push({ _: 'updateChannelUserTyping', channelId: idOf(c.peer), fromId: { _: 'peerUser', userId: c.from }, action, ...(c.topic ? { topMsgId: c.topic } : {}) });
        return {};
      }
      case 'readOutbox': {
        const r = (this.world.read[c.peer] ??= { inbox: 0, outbox: 0 });
        r.outbox = c.maxId;
        this.save();
        this.push(this.isChannel(c.peer) ? { _: 'updateReadChannelOutbox', channelId: idOf(c.peer), maxId: c.maxId } : { _: 'updateReadHistoryOutbox', peer: this.tlPeer(c.peer), maxId: c.maxId, pts: ++this.world.pts, ptsCount: 1 });
        return {};
      }
      case 'pin': {
        const m = this.msg(c.peer, c.id);
        m.pinned = !!c.pinned;
        this.save();
        this.push(this.isChannel(c.peer) ? { _: 'updatePinnedChannelMessages', channelId: idOf(c.peer), messages: [m.id], pinned: !!c.pinned, pts: ++this.world.pts, ptsCount: 1 } : { _: 'updatePinnedMessages', peer: this.tlPeer(c.peer), messages: [m.id], pinned: !!c.pinned, pts: ++this.world.pts, ptsCount: 1 });
        return {};
      }
      case 'rename': {
        const ch = this.chat(idOf(c.peer));
        ch.title = c.title;
        this.save();
        this.push(ch.kind === 'channel' ? { _: 'updateChannel', channelId: ch.id } : { _: 'updateChat', chatId: ch.id }, [ch.id]);
        return {};
      }
      case 'flood':
        this.floods.set(c.method, c.seconds);
        return {};
      case 'fail':
        this.fails.set(c.method, String(c.error));
        return {};
      case 'revoke':
        this.world.sessions = this.world.sessions.filter((s) => s !== this.session);
        this.revoked = true;
        this.save();
        return {};
      case 'authorizeKey': {
        const session = `fake-key:${c.fingerprint}`;
        if (!this.world.sessions.includes(session)) {
          this.world.sessions.push(session);
          (this.world.sessionAt ??= {})[session] = now();
        }
        this.save(true);
        return { session };
      }
      case 'endKey': {
        const session = `fake-key:${c.fingerprint}`;
        this.world.sessions = this.world.sessions.filter((x) => x !== session);
        if (this.session === session) this.revoked = true;
        this.save(true);
        return {};
      }
      case 'refuseAccept':
        this.refuseAccept = c.error ?? null;
        return {};
      case 'loginToken': {
        const token = b64url(32);
        const ttl = typeof c.ttlMs === 'number' ? c.ttlMs : 30_000;
        const who = { device: c.device ?? 'Chrome 131, Linux', platform: c.platform ?? 'Web', system: c.system ?? 'Linux x86_64', app: c.app ?? 'Telegram Web', appVersion: c.appVersion ?? '2.2 K', apiId: 2496, country: c.country ?? 'Netherlands', region: c.region ?? 'Utrecht' };
        this.loginTokens.set(token, { expires: ttl > 0 ? Date.now() + ttl : Date.now() - 1, accepted: false, who });
        return { link: `tg://login?token=${token}`, token };
      }
      case 'ageSession': {
        if (!this.session) throw new Error('not signed in');
        (this.world.sessionAt ??= {})[this.session] = now() - Math.round((c.hours ?? 25) * 3600);
        this.save(true);
        return {};
      }
      case 'loginCode': {
        if (!this.world.users.some((u) => u.id === SERVICE_USER.id)) this.world.users.push({ ...SERVICE_USER });
        const code = String(c.code ?? '12345');
        const text = `Login code: ${code}. Do not give this code to anyone, even if they say they are from Telegram!\n\nThis code can be used to log in to your Telegram account. We never ask it for anything else.\n\nIf you didn't request this code by trying to log in on another device, simply ignore this message.`;
        return this.incoming(`user:${SERVICE_USER.id}`, SERVICE_USER.id, text, { entities: [{ _: 'messageEntityBold', offset: 'Login code: '.length, length: code.length }] });
      }
      case 'joinRequest': {
        const chat = this.chat(Number(c.chat));
        const user = this.user(Number(c.user));
        const list = (this.world.joinRequests ??= []);
        const i = list.findIndex((r) => r.chat === chat.id && r.user === user.id);
        if (c.withdraw) {
          if (i >= 0) list.splice(i, 1);
        } else if (i < 0) list.push({ chat: chat.id, user: user.id, date: now() });
        this.save();
        this.push(this.pendingUpdate(chat), [chat.id], [user.id]);
        return { pending: this.requestsOf(chat.id).length };
      }
      case 'invite': {
        const list = (this.world.invites ??= []);
        const inv: WInvite = { hash: String(c.hash), chat: this.chat(Number(c.chat)).id, ...(c.requestNeeded ? { requestNeeded: true } : {}), ...(c.expired ? { expired: true } : {}), ...(c.peek ? { peek: Number(c.peek) } : {}), ...(c.webview ? { webview: true } : {}) };
        this.world.invites = [...list.filter((x) => x.hash !== inv.hash), inv];
        this.save();
        return { link: `https://t.me/+${inv.hash}` };
      }
      case 'block': {
        const u = this.user(Number(c.user));
        const blocked = c.blocked !== false;
        const list = (this.world.blocked ??= []).filter((b) => b.peer !== `user:${u.id}`);
        if (blocked) list.push({ peer: `user:${u.id}`, date: now() });
        this.world.blocked = list;
        this.save();
        if (!c.silent) this.push({ _: 'updatePeerBlocked', peerId: { _: 'peerUser', userId: u.id }, ...(blocked ? { blocked: true } : {}) }, [], [u.id]);
        return {};
      }
      case 'contact': {
        const u = this.user(Number(c.user));
        u.contact = c.contact !== false;
        this.save();
        if (!c.silent) this.push({ _: 'updatePeerSettings', peer: { _: 'peerUser', userId: u.id }, settings: { _: 'peerSettings' } }, [], [u.id]);
        return {};
      }
      case 'privacy': {
        const u = this.user(Number(c.user));
        if (c.add === 'nobody' || c.add === 'premium') u.addPrivacy = c.add;
        else delete u.addPrivacy;
        this.save();
        return {};
      }
      case 'calls':
        return this.calls
          .filter((x) => (!c.since || x.at >= c.since) && (!c.method || x.method === c.method))
          .map((x) => ({ method: x.method, at: x.at, ...(c.full ? { req: plain(x.req) } : {}) }));
      case 'world':
        return { sessions: this.world.sessions.length, signedIn: this.signedIn, qr: this.qrUrl, otherSessions: this.authorizations().length, chats: this.memberChats().map((x) => x.title), last: Object.fromEntries(Object.entries(this.world.msgs).map(([k, v]) => [k, v[v.length - 1]?.text])) };
      default:
        throw new Error(`unknown op ${c.op}`);
    }
  }

  // ---------------------------------------------------------------- the world

  private user(id: number): WUser {
    const u = this.world.users.find((x) => x.id === id);
    if (!u) throw new FakeRpcError(400, 'USER_ID_INVALID');
    return u;
  }
  private chat(id: number): WChat {
    const c = this.world.chats.find((x) => x.id === id);
    if (!c) throw new FakeRpcError(400, 'CHANNEL_INVALID');
    return c;
  }
  private isChannel(p: string) {
    return p.startsWith('channel:');
  }
  private invite(hash: unknown): WInvite {
    const inv = (this.world.invites ?? []).find((x) => x.hash === String(hash));
    if (!inv) throw new FakeRpcError(400, 'INVITE_HASH_INVALID');
    if (inv.expired) throw new FakeRpcError(400, 'INVITE_HASH_EXPIRED');
    return inv;
  }
  private isBlocked(peer: string): boolean {
    return (this.world.blocked ?? []).some((b) => b.peer === peer);
  }
  private requestsOf(chat: number): WJoinRequest[] {
    return (this.world.joinRequests ?? []).filter((r) => r.chat === chat);
  }
  private admins(c: WChat) {
    return c.creator === this.world.self || c.admins.includes(this.world.self);
  }
  /** What admins of a chat are told when its join requests change. */
  private pendingUpdate(c: WChat): tl.TypeUpdate {
    const list = this.requestsOf(c.id).sort((a, b) => b.date - a.date);
    return { _: 'updatePendingJoinRequests', peer: this.tlPeer(`${c.kind}:${c.id}`), requestsPending: list.length, recentRequesters: list.slice(0, 3).map((r) => r.user) };
  }
  /** Asked to join: the admins decide (Telegram answers the join with INVITE_REQUEST_SENT). */
  private askToJoin(c: WChat): never {
    const asked = (this.world.asked ??= []);
    if (!asked.includes(c.id)) asked.push(c.id);
    this.save();
    throw new FakeRpcError(400, 'INVITE_REQUEST_SENT');
  }
  /** Joined: a member now; Telegram answers with updates that carry the chat. */
  private joinChat(c: WChat): tl.messages.RawChatInviteJoinResultOk {
    if (!c.members.includes(this.world.self)) c.members.push(this.world.self);
    this.save();
    const update: tl.TypeUpdate = c.kind === 'channel' ? { _: 'updateChannel', channelId: c.id } : { _: 'updateChat', chatId: c.id };
    return { _: 'messages.chatInviteJoinResultOk', updates: { _: 'updates', updates: [update], users: [this.tlUser(this.user(this.world.self))], chats: [this.tlChat(c)], date: now(), seq: 0 } };
  }
  /** This account may add people to the chat: an admin, or any member where the default rights allow it. */
  private mayInvite(c: WChat): boolean {
    return this.admins(c) || (!c.broadcast && !c.inviteBanned);
  }
  /**
   * People added to a chat, as Telegram answers it (messages.invitedUsers): whom their privacy settings keep out are
   * the missingInvitees; the rest are members now, with a service message from this account in a group.
   */
  private addedTo(c: WChat, users: WUser[]): tl.messages.RawInvitedUsers {
    const missingInvitees: tl.TypeMissingInvitee[] = users.filter((u) => u.addPrivacy).map((u) => ({ _: 'missingInvitee', userId: u.id, ...(u.addPrivacy === 'premium' ? { premiumWouldAllowInvite: true } : {}) }));
    const ins = users.filter((u) => !u.addPrivacy && !c.members.includes(u.id));
    const updates: tl.TypeUpdate[] = [];
    if (ins.length) {
      c.members.push(...ins.map((u) => u.id));
      if (!c.broadcast) {
        const p = `${c.kind}:${c.id}`;
        const m: WMsg = { id: this.nextId(p), from: this.world.self, date: now(), text: '', service: { kind: 'addUser', users: ins.map((u) => u.id) }, ...(c.forum ? { topic: 1 } : {}) };
        this.list(p).push(m);
        updates.push(this.newMessageUpdate(p, m));
      }
    }
    this.save();
    return { _: 'messages.invitedUsers', updates: this.updatesResult(updates), missingInvitees };
  }
  private tlInvite(inv: WInvite, c: WChat): tl.RawChatInvite {
    const photo: tl.TypePhoto = c.photo
      ? { _: 'photo', id: Long.fromString(c.photo), accessHash: Long.fromNumber(7), fileReference: new Uint8Array([1, 2, 3]), date: T0(), sizes: [{ _: 'photoSize', type: 'c', w: 640, h: 640, size: PIXEL.length }], dcId: DC }
      : { _: 'photoEmpty', id: Long.ZERO };
    return {
      _: 'chatInvite',
      ...(c.kind === 'channel' ? { channel: true, ...(c.broadcast ? { broadcast: true } : { megagroup: true }) } : {}),
      ...(c.username ? { public: true } : {}),
      ...(inv.requestNeeded ? { requestNeeded: true } : {}),
      title: c.title,
      ...(c.about ? { about: c.about } : {}),
      photo,
      participantsCount: c.members.length,
      participants: c.members.map((u) => this.user(u)).filter((u) => u.contact).map((u) => this.tlUser(u)),
      color: 0,
    };
  }
  private list(p: string): WMsg[] {
    return (this.world.msgs[p] ??= []);
  }
  private msg(p: string, id: number): WMsg {
    const m = this.list(p).find((x) => x.id === id);
    if (!m) throw new FakeRpcError(400, 'MESSAGE_ID_INVALID');
    return m;
  }
  private nextId(p: string): number {
    if (this.isChannel(p)) {
      const c = this.chat(idOf(p));
      c.nextId = (c.nextId ?? 1) + 0;
      return c.nextId++;
    }
    return this.world.nextPrivate++;
  }

  /** The world's peer for an InputPeer the adapter sent. Checks access hashes, as Telegram does. */
  private peerOf(p: tl.TypeInputPeer): Peer {
    switch (p._) {
      case 'inputPeerSelf':
        return `user:${this.world.self}`;
      case 'inputPeerUser': {
        const u = this.user(Number(p.userId));
        if (u.hash !== p.accessHash.toString()) throw new FakeRpcError(400, 'PEER_ID_INVALID');
        return `user:${u.id}`;
      }
      case 'inputPeerChat':
        this.chat(Number(p.chatId));
        return `chat:${p.chatId}`;
      case 'inputPeerChannel': {
        const c = this.chat(Number(p.channelId));
        if (c.hash !== p.accessHash.toString()) throw new FakeRpcError(400, 'CHANNEL_INVALID');
        return `channel:${c.id}`;
      }
      default:
        throw new FakeRpcError(400, 'PEER_ID_INVALID');
    }
  }
  private channelOf(c: tl.TypeInputChannel): Peer {
    if (c._ !== 'inputChannel') throw new FakeRpcError(400, 'CHANNEL_INVALID');
    return this.peerOf({ _: 'inputPeerChannel', channelId: c.channelId, accessHash: c.accessHash });
  }
  private userOf(u: tl.TypeInputUser): WUser {
    if (u._ === 'inputUserSelf') return this.user(this.world.self);
    if (u._ !== 'inputUser') throw new FakeRpcError(400, 'USER_ID_INVALID');
    const w = this.user(Number(u.userId));
    if (w.hash !== u.accessHash.toString()) throw new FakeRpcError(400, 'USER_ID_INVALID');
    return w;
  }

  private setReaction(m: WMsg, who: number, keys: string[]) {
    const r = (m.reactions ??= {});
    for (const k of Object.keys(r)) {
      r[k] = r[k].filter((x) => x !== who);
      if (!r[k].length) delete r[k];
    }
    for (const k of keys) (r[k] ??= []).push(who);
    this.save();
  }

  /** Someone writes. The bot answers what it is sent. */
  incoming(peer: Peer, from: number, text: string, o: { topic?: number; replyTo?: number; entities?: tl.TypeMessageEntity[] } = {}): { id: number } {
    const m: WMsg = { id: this.nextId(peer), from, date: now(), text, ...(o.topic ? { topic: o.topic } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(o.entities ? { entities: o.entities } : {}) };
    this.list(peer).push(m);
    this.save();
    this.push(this.newMessageUpdate(peer, m), undefined, [from]);
    return { id: m.id };
  }

  private newMessageUpdate(peer: string, m: WMsg): tl.TypeUpdate {
    const message = this.tlMessage(peer, m);
    return this.isChannel(peer) ? { _: 'updateNewChannelMessage', message, pts: ++this.world.pts, ptsCount: 1 } : { _: 'updateNewMessage', message, pts: ++this.world.pts, ptsCount: 1 };
  }

  private push(update: tl.TypeUpdate, chatIds?: number[], userIds?: number[]) {
    const users = [...new Set([...(userIds ?? []), ...this.world.users.map((u) => u.id)])].map((id) => this.tlUser(this.user(id)));
    const chats = (chatIds ?? this.memberChats().map((c) => c.id)).map((id) => this.tlChat(this.chat(id)));
    const u: UpdateInfo = { update, users, chats };
    if (!this.signedIn) return;
    if (this.onUpdate) {
      const cb = this.onUpdate;
      setTimeout(() => cb(u), 0);
    } else this.queue.push(u);
  }

  // ---------------------------------------------------------------- TL

  private tlPeer(p: string): tl.TypePeer {
    const id = idOf(p);
    if (p.startsWith('user:')) return { _: 'peerUser', userId: id };
    if (p.startsWith('chat:')) return { _: 'peerChat', chatId: id };
    return { _: 'peerChannel', channelId: id };
  }

  tlUser(u: WUser): tl.RawUser {
    return {
      _: 'user',
      id: u.id,
      accessHash: Long.fromString(u.hash),
      firstName: u.first,
      ...(u.last ? { lastName: u.last } : {}),
      ...(u.username ? { username: u.username } : {}),
      ...(u.phone && (u.id === this.world.self || u.contact) ? { phone: u.phone } : {}),
      ...(u.id === this.world.self ? { self: true } : {}),
      ...(u.contact ? { contact: true, mutualContact: true } : {}),
      ...(u.bot ? { bot: true, botInfoVersion: 1 } : {}),
      ...(u.verified ? { verified: true } : {}),
      ...(u.photo ? { photo: { _: 'userProfilePhoto', photoId: Long.fromString(u.photo), dcId: DC } } : {}),
    } as tl.RawUser;
  }

  /** A chat as Telegram shows it. One this account is not in: a public channel (or one it may peek into) with left, else forbidden. */
  tlChat(c: WChat, visible = false): tl.TypeChat {
    const self = this.world.self;
    const member = c.members.includes(self);
    const isAdmin = member && (c.admins.includes(self) || c.creator === self);
    const rights: tl.RawChatAdminRights = { _: 'chatAdminRights', changeInfo: true, inviteUsers: true, pinMessages: true, banUsers: true, deleteMessages: true, manageTopics: true, postMessages: true, editMessages: true };
    const banned: tl.RawChatBannedRights = { _: 'chatBannedRights', untilDate: 0, changeInfo: true, pinMessages: true, inviteUsers: !!c.inviteBanned };
    if (!member && !(c.kind === 'channel' && (c.username || visible))) {
      return c.kind === 'chat' ? { _: 'chatForbidden', id: c.id, title: c.title } : ({ _: 'channelForbidden', id: c.id, accessHash: Long.fromString(c.hash!), title: c.title, ...(c.broadcast ? { broadcast: true } : { megagroup: true }) } as tl.TypeChat);
    }
    const photo: tl.TypeChatPhoto = c.photo ? { _: 'chatPhoto', photoId: Long.fromString(c.photo), dcId: DC } : { _: 'chatPhotoEmpty' };
    if (c.kind === 'chat') {
      return {
        _: 'chat',
        id: c.id,
        title: c.title,
        photo,
        participantsCount: c.members.length,
        date: T0(),
        version: 1,
        ...(c.creator === self ? { creator: true } : {}),
        ...(isAdmin ? { adminRights: rights } : {}),
        defaultBannedRights: banned,
      } as tl.TypeChat;
    }
    return {
      _: 'channel',
      id: c.id,
      accessHash: Long.fromString(c.hash!),
      title: c.title,
      ...(c.username ? { username: c.username } : {}),
      photo,
      date: T0(),
      ...(member ? {} : { left: true }),
      ...(c.broadcast ? { broadcast: true } : { megagroup: true }),
      ...(c.forum ? { forum: true } : {}),
      ...(c.noforwards ? { noforwards: true } : {}),
      ...(c.creator === self ? { creator: true } : {}),
      ...(isAdmin ? { adminRights: rights } : {}),
      ...(c.broadcast ? {} : { defaultBannedRights: banned }),
      ...(c.joinRequest ? { joinRequest: true } : {}),
      ...(c.slowmode ? { slowmodeEnabled: true } : {}),
      participantsCount: c.members.length,
    } as tl.TypeChat;
  }

  private tlMedia(media: WMedia, date: number): tl.TypeMessageMedia {
    const ref = new Uint8Array([1, 2, 3]);
    if (media.kind === 'photo')
      return { _: 'messageMediaPhoto', photo: { _: 'photo', id: Long.fromString(media.id), accessHash: Long.fromNumber(7), fileReference: ref, date, sizes: [{ _: 'photoSize', type: 'y', w: media.w ?? 1, h: media.h ?? 1, size: media.size }], dcId: DC } };
    const attributes: tl.TypeDocumentAttribute[] = [];
    if (media.name) attributes.push({ _: 'documentAttributeFilename', fileName: media.name });
    if (media.video) attributes.push({ _: 'documentAttributeVideo', duration: 1, w: media.w ?? 1, h: media.h ?? 1 });
    if (media.sticker) attributes.push({ _: 'documentAttributeSticker', alt: media.sticker, stickerset: { _: 'inputStickerSetEmpty' } });
    return { _: 'messageMediaDocument', document: { _: 'document', id: Long.fromString(media.id), accessHash: Long.fromNumber(7), fileReference: ref, date, mimeType: media.mime, size: media.size, dcId: DC, attributes } };
  }

  private tlReactions(peer: string, m: WMsg): tl.TypeMessageReactions | undefined {
    const named = m.reactions ?? {};
    const counts = { ...(m.counts ?? {}) };
    for (const [k, who] of Object.entries(named)) counts[k] = Math.max(counts[k] ?? 0, who.length);
    const keys = Object.keys(counts);
    if (!keys.length) return undefined;
    const broadcast = this.isChannel(peer) && !!this.chat(idOf(peer)).broadcast;
    return {
      _: 'messageReactions',
      ...(broadcast ? {} : { canSeeList: true }),
      results: keys.map((k) => ({ _: 'reactionCount', reaction: { _: 'reactionEmoji', emoticon: k }, count: counts[k], ...(named[k]?.includes(this.world.self) ? { chosenOrder: 0 } : {}) })),
      ...(broadcast ? {} : { recentReactions: Object.entries(named).flatMap(([k, who]) => who.map((u) => ({ _: 'messagePeerReaction', peerId: { _: 'peerUser', userId: u }, date: m.date, reaction: { _: 'reactionEmoji', emoticon: k } }))) }),
    } as tl.TypeMessageReactions;
  }

  tlMessage(peer: string, m: WMsg): tl.TypeMessage {
    const self = this.world.self;
    const isChan = this.isChannel(peer);
    const chat = isChan || peer.startsWith('chat:') ? this.chat(idOf(peer)) : null;
    const forum = !!chat?.forum;
    const broadcast = !!chat?.broadcast;
    const peerId = this.tlPeer(peer);
    const fromId: tl.TypePeer | undefined = broadcast ? undefined : { _: 'peerUser', userId: m.from };
    let replyTo: tl.TypeMessageReplyHeader | undefined;
    if (forum && m.topic && m.topic !== 1) replyTo = { _: 'messageReplyHeader', forumTopic: true, replyToMsgId: m.replyTo ?? m.topic, ...(m.replyTo ? { replyToTopId: m.topic } : {}) };
    else if (m.replyTo) replyTo = { _: 'messageReplyHeader', replyToMsgId: m.replyTo };
    const base = { id: m.id, peerId, ...(fromId ? { fromId } : {}), date: m.date, ...(m.from === self ? { out: true } : {}), ...(replyTo ? { replyTo } : {}) };
    if (m.service) {
      const action: tl.TypeMessageAction =
        m.service.kind === 'chatCreate'
          ? { _: 'messageActionChatCreate', title: m.service.title ?? '', users: chat?.members ?? [] }
          : m.service.kind === 'topicCreate'
            ? { _: 'messageActionTopicCreate', title: m.service.title ?? '', iconColor: 0 }
            : m.service.kind === 'topicEdit'
              ? { _: 'messageActionTopicEdit', title: m.service.title }
              : m.service.kind === 'editTitle'
                ? { _: 'messageActionChatEditTitle', title: m.service.title ?? '' }
                : m.service.kind === 'addUser'
                  ? { _: 'messageActionChatAddUser', users: m.service.users ?? [] }
                  : { _: 'messageActionPinMessage' };
      return { _: 'messageService', ...base, action } as tl.TypeMessage;
    }
    const mentioned = (m.entities ?? []).some((e) => e._ === 'messageEntityMentionName' && Number(e.userId) === self) || (m.replyTo !== undefined && this.list(peer).find((x) => x.id === m.replyTo)?.from === self);
    const reactions = this.tlReactions(peer, m);
    return {
      _: 'message',
      ...base,
      message: m.text,
      ...(m.entities?.length ? { entities: m.entities } : {}),
      ...(m.media ? { media: this.tlMedia(m.media, m.date) } : {}),
      ...(m.edit ? { editDate: m.edit } : {}),
      ...(reactions ? { reactions } : {}),
      ...(m.fwd ? { fwdFrom: { _: 'messageFwdHeader', date: m.fwd.date, ...(m.fwd.fromName ? { fromName: m.fwd.fromName } : {}), ...(m.fwd.from ? { fromId: { _: 'peerUser', userId: m.fwd.from } } : {}), ...(m.fwd.channel ? { fromId: { _: 'peerChannel', channelId: m.fwd.channel }, channelPost: m.fwd.post } : {}) } } : {}),
      ...(m.grouped ? { groupedId: Long.fromString(m.grouped) } : {}),
      ...(m.pinned ? { pinned: true } : {}),
      ...(m.views !== undefined ? { views: m.views } : {}),
      ...(broadcast ? { post: true } : {}),
      ...(chat?.noforwards ? { noforwards: true } : {}),
      ...(mentioned && m.from !== self ? { mentioned: true } : {}),
    } as tl.TypeMessage;
  }

  /** Everyone and every chat the account is in (Telegram sends no chat it is not in with its lists). */
  private everyone() {
    return { users: this.world.users.map((u) => this.tlUser(u)), chats: this.memberChats().map((c) => this.tlChat(c)) };
  }
  private memberChats() {
    return this.world.chats.filter((c) => c.members.includes(this.world.self));
  }

  private dialogPeers(): Peer[] {
    const out: Peer[] = [];
    for (const k of Object.keys(this.world.msgs) as Peer[]) {
      if (!this.list(k).length) continue;
      if (!k.startsWith('user:') && !this.chat(idOf(k)).members.includes(this.world.self)) continue;
      out.push(k);
    }
    for (const c of this.world.chats) {
      const k = `${c.kind}:${c.id}` as Peer;
      if (c.members.includes(this.world.self) && !out.includes(k)) out.push(k);
    }
    return out;
  }

  private tlDialog(p: Peer): { dialog: tl.RawDialog; top: tl.TypeMessage | null; date: number } {
    const list = this.list(p);
    const last = list[list.length - 1];
    const r = this.world.read[p] ?? { inbox: last?.id ?? 0, outbox: last?.id ?? 0 };
    const unread = list.filter((m) => m.id > r.inbox && m.from !== this.world.self && !m.service).length;
    return {
      dialog: {
        _: 'dialog',
        peer: this.tlPeer(p),
        topMessage: last?.id ?? 0,
        readInboxMaxId: r.inbox,
        readOutboxMaxId: r.outbox,
        unreadCount: unread,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        unreadPollVotesCount: 0,
        notifySettings: { _: 'peerNotifySettings', ...(this.world.muted[p] ? { muteUntil: this.world.muted[p] } : {}) },
        ...(this.world.archived.includes(p) ? { folderId: 1 } : {}),
        ...(this.isChannel(p) ? { pts: this.world.pts } : {}),
      },
      top: last ? this.tlMessage(p, last) : null,
      date: last?.date ?? 0,
    };
  }

  private messagesResult(p: string | null, msgs: { peer: string; m: WMsg }[]) {
    const messages = msgs.map(({ peer, m }) => this.tlMessage(peer, m));
    const { users, chats } = this.everyone();
    if (p && this.isChannel(p)) return { _: 'messages.channelMessages', pts: this.world.pts, count: messages.length, messages, topics: [], chats, users };
    return { _: 'messages.messages', messages, chats, users, topics: [] };
  }

  private updatesResult(updates: tl.TypeUpdate[]): tl.RawUpdates {
    const { users, chats } = this.everyone();
    return { _: 'updates', updates, users, chats, date: now(), seq: 0 };
  }

  /** messages.search and searchGlobal: the words in the text, the filter, the author, the dates; newest first. */
  private found(peers: string[], req: any): { peer: string; m: WMsg }[] {
    const words = String(req.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const from = req.fromId ? this.peerOf(req.fromId) : null;
    const kind = req.filter?._ ?? 'inputMessagesFilterEmpty';
    const fits = (m: WMsg) => {
      switch (kind) {
        case 'inputMessagesFilterEmpty':
          return true;
        case 'inputMessagesFilterPinned':
          return !!m.pinned;
        case 'inputMessagesFilterPhotos':
          return m.media?.kind === 'photo';
        case 'inputMessagesFilterDocument':
          return m.media?.kind === 'document';
        case 'inputMessagesFilterUrl':
          return /https?:\/\//.test(m.text);
        default:
          return false;
      }
    };
    const out: { peer: string; m: WMsg }[] = [];
    for (const peer of peers) {
      for (const m of this.list(peer)) {
        if (m.service || !fits(m) || !words.every((w) => m.text.toLowerCase().includes(w))) continue;
        if (from && from !== `user:${m.from}`) continue;
        if (req.minDate && m.date < req.minDate) continue;
        if (req.maxDate && m.date > req.maxDate) continue;
        if (req.topMsgId && (m.topic ?? 1) !== req.topMsgId) continue;
        out.push({ peer, m });
      }
    }
    return out.sort((a, b) => b.m.date - a.m.date || b.m.id - a.m.id).slice(0, req.limit || 100);
  }

  private page(list: WMsg[], o: { offsetId: number; offsetDate: number; limit: number; minId?: number; maxId?: number; addOffset?: number }) {
    let l = [...list].sort((a, b) => b.id - a.id);
    if (o.offsetId) l = l.filter((m) => m.id < o.offsetId);
    if (o.offsetDate) l = l.filter((m) => m.date < o.offsetDate);
    if (o.minId) l = l.filter((m) => m.id > o.minId!);
    if (o.maxId) l = l.filter((m) => m.id < o.maxId!);
    return l.slice(0, o.limit);
  }

  private fileOf(f: tl.TypeInputFile): { name: string; bytes: Buffer; id: string } {
    const id = f.id.toString();
    const up = this.uploads.get(id);
    if (!up) throw new FakeRpcError(400, 'FILE_PARTS_INVALID');
    return { ...up, id };
  }

  private mediaFrom(media: tl.TypeInputMedia): WMedia {
    if (media._ === 'inputMediaUploadedPhoto') {
      const f = this.fileOf(media.file);
      this.world.files[f.id] = f.bytes.toString('base64');
      return { kind: 'photo', id: f.id, mime: 'image/jpeg', size: f.bytes.length, w: 1, h: 1 };
    }
    if (media._ === 'inputMediaUploadedDocument') {
      const f = this.fileOf(media.file);
      this.world.files[f.id] = f.bytes.toString('base64');
      const name = media.attributes.find((a): a is tl.RawDocumentAttributeFilename => a._ === 'documentAttributeFilename')?.fileName ?? f.name;
      return { kind: 'document', id: f.id, mime: media.mimeType, size: f.bytes.length, name, ...(media.attributes.some((a) => a._ === 'documentAttributeVideo') ? { video: true } : {}) };
    }
    if (media._ === 'inputMediaPhoto' && media.id._ === 'inputPhoto') {
      const id = media.id.id.toString();
      return { kind: 'photo', id, mime: 'image/jpeg', size: Buffer.from(this.world.files[id] ?? '', 'base64').length, w: 1, h: 1 };
    }
    if (media._ === 'inputMediaDocument' && media.id._ === 'inputDocument') {
      const id = media.id.id.toString();
      return { kind: 'document', id, mime: 'application/octet-stream', size: Buffer.from(this.world.files[id] ?? '', 'base64').length };
    }
    throw new FakeRpcError(400, 'MEDIA_INVALID');
  }

  private topicOf(peer: string, reply?: tl.TypeInputReplyTo, topMsgId?: number): { topic?: number; replyTo?: number } {
    const chat = this.isChannel(peer) ? this.chat(idOf(peer)) : null;
    if (reply?._ !== 'inputReplyToMessage') return chat?.forum ? { topic: topMsgId ?? 1 } : {};
    if (!chat?.forum) return { replyTo: reply.replyToMsgId };
    const topic = reply.topMsgId ?? (chat.topics?.some((t) => t.id === reply.replyToMsgId) ? reply.replyToMsgId : (this.list(peer).find((m) => m.id === reply.replyToMsgId)?.topic ?? 1));
    return { topic, ...(reply.replyToMsgId !== topic ? { replyTo: reply.replyToMsgId } : {}) };
  }

  /** Adds an outgoing message, and what Telegram answers a send with. */
  private sent(peer: Peer, m: Omit<WMsg, 'id' | 'from' | 'date'>, randomId: Long, short: boolean): tl.TypeUpdates {
    const msg: WMsg = { id: this.nextId(peer), from: this.world.self, date: now(), ...m };
    this.list(peer).push(msg);
    this.save();
    if (short && peer.startsWith('user:') && !msg.media) {
      this.botReply(peer, msg);
      return { _: 'updateShortSentMessage', out: true, id: msg.id, pts: ++this.world.pts, ptsCount: 1, date: msg.date, ...(msg.entities?.length ? { entities: msg.entities } : {}) };
    }
    this.botReply(peer, msg);
    return this.updatesResult([{ _: 'updateMessageID', id: msg.id, randomId }, this.newMessageUpdate(peer, msg)]);
  }

  private botReply(peer: Peer, m: WMsg) {
    if (!peer.startsWith('user:')) return;
    const u = this.user(idOf(peer));
    if (!u.bot) return;
    setTimeout(() => this.incoming(peer, u.id, `You said: ${m.text || '(a file)'}`, { replyTo: m.id }), 50);
  }

  // ---------------------------------------------------------------- TgBackend

  async start(session: string | null): Promise<tl.RawUser | null> {
    this.revoked = false;
    if (!session) return null;
    if (!this.world.sessions.includes(session)) throw new FakeRpcError(401, 'AUTH_KEY_UNREGISTERED');
    this.session = session;
    this.signedIn = true;
    return this.tlUser(this.user(this.world.self));
  }

  private waitScan(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.scanWaiter = null;
        resolve(false);
      }, ms);
      this.scanWaiter = (v) => {
        clearTimeout(t);
        this.scanWaiter = null;
        resolve(v);
      };
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        this.scanWaiter = null;
        reject(new Error('aborted'));
      });
    });
  }

  private newSession(): tl.RawUser {
    this.session = `fake:${b64url(24)}`;
    this.world.sessions.push(this.session);
    (this.world.sessionAt ??= {})[this.session] = now();
    this.signedIn = true;
    this.revoked = false;
    this.save(true);
    return this.tlUser(this.user(this.world.self));
  }

  async qrLogin(h: QrHandlers): Promise<tl.RawUser> {
    const ttl = this.o.qrMs ?? (Number(process.env.TELEGRAM_FAKE_QR_MS) || 30_000);
    for (;;) {
      if (h.signal.aborted) throw new Error('aborted');
      this.record('auth.exportLoginToken', {});
      const exp = Date.now() + ttl;
      this.qrUrl = `tg://login?token=${b64url(32)}`;
      h.onUrl(this.qrUrl, exp);
      const scanned = await this.waitScan(ttl, h.signal);
      if (!scanned) continue;
      this.qrUrl = null;
      h.onScanned();
      if (this.world.password) {
        let wrong = false;
        for (;;) {
          const p = await h.password(this.world.hint, wrong);
          this.record('auth.checkPassword', {});
          if (p === this.world.password) break;
          wrong = true;
        }
      }
      return this.newSession();
    }
  }

  /** A client on Telegram Desktop's key, as the desktop path makes one: it accepts the QR code this backend shows. */
  desktopClient(key: DesktopKey): DeskClient {
    const session = FakeTelegram.keySession(key);
    return {
      acceptLoginToken: async (token: Uint8Array) => {
        // A round trip, as on the network: the code is shown (and waited on) before it can be accepted.
        await Bun.sleep(5);
        this.record('auth.acceptLoginToken', { session });
        if (!this.world.sessions.includes(session)) throw new FakeRpcError(401, 'AUTH_KEY_UNREGISTERED');
        if (this.refuseAccept) throw new FakeRpcError(400, this.refuseAccept);
        const shown = this.qrUrl ? Buffer.from(this.qrUrl.slice('tg://login?token='.length), 'base64url') : null;
        if (!shown || !this.scanWaiter || !shown.equals(Buffer.from(token))) throw new FakeRpcError(400, 'AUTH_TOKEN_INVALID');
        this.scanWaiter(true);
      },
      close: async () => {},
    };
  }

  /** The fake's session for Telegram Desktop's key (the shared fallback starts with it). */
  static keySession(key: DesktopKey) {
    return `fake-key:${key.fingerprint}`;
  }

  async sendCode(phone: string): Promise<SentCode> {
    this.record('auth.sendCode', {});
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{7,15}$/.test(digits)) throw new FakeRpcError(400, 'PHONE_NUMBER_INVALID');
    const test = digits.match(/^99966(\d)\d{4}$/);
    const code = test ? test[1].repeat(5) : '12345';
    this.pendingCode = { phone: digits, hash: b64url(8), code };
    return { phoneCodeHash: this.pendingCode.hash, type: 'app', length: 5, nextType: 'sms', timeout: 60 };
  }

  async resendCode(phone: string, hash: string): Promise<SentCode> {
    if (!this.pendingCode || this.pendingCode.hash !== hash) throw new FakeRpcError(400, 'PHONE_CODE_HASH_EMPTY');
    return { phoneCodeHash: hash, type: 'sms', length: 5 };
  }

  async signIn(phone: string, hash: string, code: string): Promise<tl.RawUser> {
    this.record('auth.signIn', {});
    const p = this.pendingCode;
    if (!p || p.hash !== hash || p.phone !== phone.replace(/\D/g, '')) throw new FakeRpcError(400, 'PHONE_CODE_EXPIRED');
    if (code !== p.code) throw new FakeRpcError(400, 'PHONE_CODE_INVALID');
    this.pendingCode = null;
    if (this.world.password) {
      this.needPassword = true;
      throw new FakeRpcError(401, 'SESSION_PASSWORD_NEEDED');
    }
    return this.newSession();
  }

  async checkPassword(password: string): Promise<tl.RawUser> {
    this.record('auth.checkPassword', {});
    if (!this.needPassword) throw new FakeRpcError(400, 'PASSWORD_HASH_INVALID');
    if (password !== this.world.password) throw new FakeRpcError(400, 'PASSWORD_HASH_INVALID');
    this.needPassword = false;
    return this.newSession();
  }

  async passwordHint(): Promise<string | null> {
    return this.world.hint;
  }

  async exportSession(): Promise<string> {
    if (!this.session) throw new Error('not signed in');
    return this.session;
  }

  async startUpdates(onUpdate: (u: UpdateInfo) => void, onState: (s: ConnState) => void): Promise<void> {
    this.onUpdate = onUpdate;
    onState('connected');
    for (const u of this.queue.splice(0)) setTimeout(() => onUpdate(u), 0);
  }

  async uploadFile(f: UploadSpec): Promise<tl.TypeInputFile> {
    this.record('upload.saveFilePart', { name: f.name });
    const bytes = Buffer.from(await Bun.file(f.path).arrayBuffer());
    const id = Long.fromBits((Math.random() * 2 ** 32) | 0, (Math.random() * 2 ** 31) | 0).toString();
    this.uploads.set(id, { name: f.name, bytes });
    return { _: 'inputFile', id: Long.fromString(id), parts: 1, name: f.name, md5Checksum: '' };
  }

  async download(location: tl.TypeInputFileLocation): Promise<Uint8Array> {
    this.record('upload.getFile', {});
    if (this.revoked) throw new FakeRpcError(401, 'AUTH_KEY_UNREGISTERED');
    if (location._ === 'inputPeerPhotoFileLocation') return PIXEL;
    if (location._ === 'inputPhotoFileLocation' || location._ === 'inputDocumentFileLocation') {
      const b = this.world.files[location.id.toString()];
      if (!b) throw new FakeRpcError(400, 'FILE_REFERENCE_EXPIRED');
      return Buffer.from(b, 'base64');
    }
    throw new FakeRpcError(400, 'LOCATION_INVALID');
  }

  async logOut(): Promise<void> {
    this.record('auth.logOut', {});
    this.world.sessions = this.world.sessions.filter((s) => s !== this.session);
    this.signedIn = false;
    this.save(true);
  }

  async wipe(): Promise<void> {
    this.session = null;
    this.signedIn = false;
    this.onUpdate = null;
    this.queue = [];
  }

  async close(): Promise<void> {
    this.save(true);
    this.server?.stop(true);
    this.server = null;
  }

  info(): BackendInfo {
    return { library: 'fake Telegram', layer: 232, testMode: false, dc: DC };
  }

  private record(method: string, req: unknown) {
    this.calls.push({ method, at: Date.now(), req });
    if (this.calls.length > 2000) this.calls.splice(0, 500);
  }

  async call(req: any): Promise<any> {
    const method = req._ as string;
    this.record(method, req);
    if (this.revoked) throw new FakeRpcError(401, 'AUTH_KEY_UNREGISTERED');
    if (!this.signedIn) throw new FakeRpcError(401, 'AUTH_KEY_UNREGISTERED');
    const flood = this.floods.get(method);
    if (flood !== undefined) {
      this.floods.delete(method);
      throw new FakeRpcError(420, `FLOOD_WAIT_${flood}`);
    }
    const fail = this.fails.get(method);
    if (fail !== undefined) {
      this.fails.delete(method);
      throw new FakeRpcError(400, fail);
    }
    const self = this.world.self;
    switch (method) {
      case 'updates.getState':
        return { _: 'updates.state', pts: this.world.pts, qts: 0, date: now(), seq: 0, unreadCount: 0 };
      case 'users.getUsers':
        return (req.id as tl.TypeInputUser[]).map((u) => this.tlUser(this.userOf(u)));
      case 'users.getFullUser': {
        const u = this.userOf(req.id);
        const common = this.world.chats.filter((c) => c.members.includes(u.id) && c.members.includes(self)).length;
        return { _: 'users.userFull', fullUser: { _: 'userFull', id: u.id, ...(u.about ? { about: u.about } : {}), ...(this.isBlocked(`user:${u.id}`) ? { blocked: true } : {}), settings: { _: 'peerSettings' }, notifySettings: { _: 'peerNotifySettings' }, commonChatsCount: common }, chats: [], users: [this.tlUser(u)] };
      }
      case 'contacts.getContacts': {
        const contacts = this.world.users.filter((u) => u.contact);
        // The hash of the list as it is: nothing changed since the caller read it.
        const hash = (req.hash as Long | undefined)?.toString() ?? '0';
        if (hash !== '0' && hash === contactsHash(0, contacts.map((u) => u.id)).toString()) return { _: 'contacts.contactsNotModified' };
        return { _: 'contacts.contacts', contacts: contacts.map((u) => ({ _: 'contact', userId: u.id, mutual: true })), savedCount: 0, users: contacts.map((u) => this.tlUser(u)) };
      }
      case 'contacts.getBlocked': {
        const all = [...(this.world.blocked ?? [])].sort((a, b) => b.date - a.date);
        const page = all.slice(req.offset ?? 0, (req.offset ?? 0) + req.limit);
        const users = page.filter((b) => b.peer.startsWith('user:')).map((b) => this.tlUser(this.user(idOf(b.peer))));
        const chats = page.filter((b) => !b.peer.startsWith('user:')).map((b) => this.tlChat(this.chat(idOf(b.peer))));
        const blocked = page.map((b) => ({ _: 'peerBlocked', peerId: this.tlPeer(b.peer), date: b.date }));
        return all.length > req.limit ? { _: 'contacts.blockedSlice', count: all.length, blocked, chats, users } : { _: 'contacts.blocked', blocked, chats, users };
      }
      case 'contacts.deleteContacts': {
        const gone = (req.id as tl.TypeInputUser[]).map((x) => this.userOf(x));
        for (const u of gone) u.contact = false;
        this.save();
        return { _: 'updates', updates: gone.map((u) => ({ _: 'updatePeerSettings', peer: { _: 'peerUser', userId: u.id }, settings: { _: 'peerSettings' } })), users: gone.map((u) => this.tlUser(u)), chats: [], date: now(), seq: 0 };
      }
      case 'contacts.unblock': {
        const peer = this.peerOf(req.id);
        this.world.blocked = (this.world.blocked ?? []).filter((b) => b.peer !== peer);
        this.save();
        return true;
      }
      case 'contacts.resolveUsername': {
        const name = String(req.username).toLowerCase();
        const u = this.world.users.find((x) => x.username?.toLowerCase() === name);
        if (u) return { _: 'contacts.resolvedPeer', peer: { _: 'peerUser', userId: u.id }, chats: [], users: [this.tlUser(u)] };
        const c = this.world.chats.find((x) => x.username?.toLowerCase() === name);
        if (c) return { _: 'contacts.resolvedPeer', peer: { _: 'peerChannel', channelId: c.id }, chats: [this.tlChat(c)], users: [] };
        throw new FakeRpcError(400, 'USERNAME_NOT_OCCUPIED');
      }
      case 'contacts.resolvePhone': {
        const u = this.world.users.find((x) => x.phone === String(req.phone).replace(/\D/g, ''));
        if (!u) throw new FakeRpcError(400, 'PHONE_NOT_OCCUPIED');
        return { _: 'contacts.resolvedPeer', peer: { _: 'peerUser', userId: u.id }, chats: [], users: [this.tlUser(u)] };
      }
      case 'messages.getDialogs': {
        const folder = req.folderId ?? 0;
        const all = this.dialogPeers()
          .filter((p) => (folder === 1) === this.world.archived.includes(p))
          .map((p) => this.tlDialog(p))
          .sort((a, b) => b.date - a.date || b.dialog.topMessage - a.dialog.topMessage);
        let list = all;
        if (req.offsetDate) list = all.filter((d) => d.date < req.offsetDate || (d.date === req.offsetDate && d.dialog.topMessage < req.offsetId));
        const page = list.slice(0, req.limit);
        const { users, chats } = this.everyone();
        const body = { dialogs: page.map((d) => d.dialog), messages: page.map((d) => d.top).filter(Boolean), chats, users };
        return all.length > page.length ? { _: 'messages.dialogsSlice', count: all.length, ...body } : { _: 'messages.dialogs', ...body };
      }
      case 'messages.getPeerDialogs': {
        const peers = (req.peers as tl.TypeInputDialogPeer[]).map((d) => (d._ === 'inputDialogPeer' ? this.peerOf(d.peer) : null)).filter(Boolean) as Peer[];
        const ds = peers.filter((p) => this.dialogPeers().includes(p)).map((p) => this.tlDialog(p));
        const { users, chats } = this.everyone();
        return { _: 'messages.peerDialogs', dialogs: ds.map((d) => d.dialog), messages: ds.map((d) => d.top).filter(Boolean), chats, users, state: { _: 'updates.state', pts: this.world.pts, qts: 0, date: now(), seq: 0, unreadCount: 0 } };
      }
      case 'messages.getForumTopics': {
        const p = this.peerOf(req.peer);
        const c = this.chat(idOf(p));
        if (!c.forum) throw new FakeRpcError(400, 'CHANNEL_FORUM_MISSING');
        const list = this.list(p);
        const r = this.world.read[p] ?? { inbox: 0, outbox: 0 };
        const topics = (c.topics ?? []).map((t) => {
          const msgs = list.filter((m) => (m.topic ?? 1) === t.id);
          const top = msgs[msgs.length - 1];
          return { _: 'forumTopic', id: t.id, date: T0(), peer: this.tlPeer(p), title: t.title, iconColor: 0, topMessage: top?.id ?? t.id, readInboxMaxId: r.inbox, readOutboxMaxId: r.outbox, unreadCount: msgs.filter((m) => m.id > r.inbox && m.from !== self && !m.service).length, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, fromId: { _: 'peerUser', userId: c.creator }, notifySettings: { _: 'peerNotifySettings' } };
        });
        const tops = topics.map((t) => list.find((m) => m.id === t.topMessage)).filter(Boolean) as WMsg[];
        const { users, chats } = this.everyone();
        return { _: 'messages.forumTopics', count: topics.length, topics, messages: tops.map((m) => this.tlMessage(p, m)), chats, users, pts: this.world.pts };
      }
      case 'messages.getHistory': {
        const p = this.peerOf(req.peer);
        return this.messagesResult(p, this.page(this.list(p), req).map((m) => ({ peer: p, m })));
      }
      case 'messages.getReplies': {
        const p = this.peerOf(req.peer);
        const topic = req.msgId as number;
        const list = this.list(p).filter((m) => (m.topic ?? 1) === topic || m.replyTo === topic);
        return this.messagesResult(p, this.page(list, req).map((m) => ({ peer: p, m })));
      }
      case 'messages.search': {
        // inputPeerEmpty: every private chat and basic group, as Telegram does.
        const p = req.peer._ === 'inputPeerEmpty' ? null : this.peerOf(req.peer);
        const peers = p ? [p] : Object.keys(this.world.msgs).filter((k) => !this.isChannel(k));
        return this.messagesResult(p, this.found(peers, req));
      }
      case 'messages.searchGlobal': {
        if (!(req.q ?? '').trim() && (req.filter?._ ?? 'inputMessagesFilterEmpty') === 'inputMessagesFilterEmpty') throw new FakeRpcError(400, 'SEARCH_QUERY_EMPTY');
        return this.messagesResult(null, this.found(Object.keys(this.world.msgs), req));
      }
      case 'messages.getMessages': {
        const ids = (req.id as tl.TypeInputMessage[]).map((x) => (x._ === 'inputMessageID' ? x.id : 0));
        const found: { peer: string; m: WMsg }[] = [];
        for (const [peer, list] of Object.entries(this.world.msgs)) {
          if (this.isChannel(peer)) continue;
          for (const m of list) if (ids.includes(m.id)) found.push({ peer, m });
        }
        return this.messagesResult(null, found);
      }
      case 'channels.getMessages': {
        const p = this.channelOf(req.channel);
        const ids = (req.id as tl.TypeInputMessage[]).map((x) => (x._ === 'inputMessageID' ? x.id : 0));
        return this.messagesResult(p, this.list(p).filter((m) => ids.includes(m.id)).map((m) => ({ peer: p, m })));
      }
      case 'messages.sendMessage': {
        const p = this.peerOf(req.peer);
        this.mayWrite(p);
        return this.sent(p, { text: req.message, ...(req.entities?.length ? { entities: this.entities(req.entities) } : {}), ...this.topicOf(p, req.replyTo) }, req.randomId, true);
      }
      case 'messages.sendMedia': {
        const p = this.peerOf(req.peer);
        this.mayWrite(p);
        return this.sent(p, { text: req.message ?? '', media: this.mediaFrom(req.media), ...(req.entities?.length ? { entities: this.entities(req.entities) } : {}), ...this.topicOf(p, req.replyTo) }, req.randomId, false);
      }
      case 'messages.uploadMedia': {
        const m = this.mediaFrom(req.media);
        return this.tlMedia(m, now());
      }
      case 'messages.sendMultiMedia': {
        const p = this.peerOf(req.peer);
        this.mayWrite(p);
        const grouped = String(Date.now());
        const ups: tl.TypeUpdate[] = [];
        for (const sm of req.multiMedia as tl.RawInputSingleMedia[]) {
          const msg: WMsg = { id: this.nextId(p), from: self, date: now(), text: sm.message, media: this.mediaFrom(sm.media), grouped, ...(sm.entities?.length ? { entities: this.entities(sm.entities) } : {}), ...this.topicOf(p, req.replyTo) };
          this.list(p).push(msg);
          ups.push({ _: 'updateMessageID', id: msg.id, randomId: sm.randomId }, this.newMessageUpdate(p, msg));
        }
        this.save();
        return this.updatesResult(ups);
      }
      case 'messages.editMessage': {
        const p = this.peerOf(req.peer);
        const m = this.msg(p, req.id);
        if (m.from !== self) throw new FakeRpcError(403, 'MESSAGE_AUTHOR_REQUIRED');
        m.text = req.message ?? m.text;
        m.entities = req.entities ? this.entities(req.entities) : undefined;
        m.edit = now();
        this.save();
        const message = this.tlMessage(p, m);
        return this.updatesResult([this.isChannel(p) ? { _: 'updateEditChannelMessage', message, pts: ++this.world.pts, ptsCount: 1 } : { _: 'updateEditMessage', message, pts: ++this.world.pts, ptsCount: 1 }]);
      }
      case 'messages.deleteMessages': {
        for (const [peer, list] of Object.entries(this.world.msgs)) if (!this.isChannel(peer)) this.world.msgs[peer] = list.filter((m) => !req.id.includes(m.id));
        this.save();
        return { _: 'messages.affectedMessages', pts: (this.world.pts += req.id.length), ptsCount: req.id.length };
      }
      case 'channels.deleteMessages': {
        const p = this.channelOf(req.channel);
        this.world.msgs[p] = this.list(p).filter((m) => !req.id.includes(m.id));
        this.save();
        return { _: 'messages.affectedMessages', pts: (this.world.pts += req.id.length), ptsCount: req.id.length };
      }
      case 'messages.sendReaction': {
        const p = this.peerOf(req.peer);
        const m = this.msg(p, req.msgId);
        const keys = (req.reaction ?? []).map((r: tl.TypeReaction) => (r._ === 'reactionEmoji' ? r.emoticon : r._ === 'reactionCustomEmoji' ? `custom:${r.documentId}` : '')).filter(Boolean);
        if (keys.length > 1) throw new FakeRpcError(400, 'REACTIONS_TOO_MANY');
        this.setReaction(m, self, keys);
        return this.updatesResult([{ _: 'updateMessageReactions', peer: this.tlPeer(p), msgId: m.id, reactions: this.tlReactions(p, m) ?? { _: 'messageReactions', results: [] } }]);
      }
      case 'messages.getMessageReactionsList': {
        const p = this.peerOf(req.peer);
        if (this.isChannel(p) && this.chat(idOf(p)).broadcast) throw new FakeRpcError(403, 'BROADCAST_FORBIDDEN');
        const m = this.msg(p, req.id);
        const key = req.reaction?._ === 'reactionEmoji' ? req.reaction.emoticon : null;
        const who = Object.entries(m.reactions ?? {}).flatMap(([k, us]) => (!key || k === key ? us.map((u) => ({ k, u })) : []));
        return { _: 'messages.messageReactionsList', count: who.length, reactions: who.map(({ k, u }) => ({ _: 'messagePeerReaction', peerId: { _: 'peerUser', userId: u }, date: m.date, reaction: { _: 'reactionEmoji', emoticon: k } })), chats: [], users: who.map(({ u }) => this.tlUser(this.user(u))) };
      }
      case 'messages.readHistory': {
        const p = this.peerOf(req.peer);
        (this.world.read[p] ??= { inbox: 0, outbox: 0 }).inbox = req.maxId;
        this.save();
        return { _: 'messages.affectedMessages', pts: ++this.world.pts, ptsCount: 1 };
      }
      case 'channels.readHistory': {
        const p = this.channelOf(req.channel);
        (this.world.read[p] ??= { inbox: 0, outbox: 0 }).inbox = req.maxId;
        this.save();
        return true;
      }
      case 'messages.readDiscussion':
        this.peerOf(req.peer);
        return true;
      case 'messages.setTyping':
        this.peerOf(req.peer);
        return true;
      case 'messages.forwardMessages': {
        const from = this.peerOf(req.fromPeer);
        const to = this.peerOf(req.toPeer);
        if (this.isChannel(from) && this.chat(idOf(from)).noforwards) throw new FakeRpcError(400, 'CHAT_FORWARDS_RESTRICTED');
        const ups: tl.TypeUpdate[] = [];
        (req.id as number[]).forEach((id, i) => {
          const src = this.msg(from, id);
          const isBroadcast = this.isChannel(from) && this.chat(idOf(from)).broadcast;
          const fwd = isBroadcast ? { date: src.date, channel: idOf(from), post: src.id } : { date: src.date, from: src.from };
          const msg: WMsg = { id: this.nextId(to), from: self, date: now(), text: src.text, ...(src.entities ? { entities: src.entities } : {}), ...(src.media ? { media: src.media } : {}), fwd, ...(req.topMsgId ? { topic: req.topMsgId } : this.isChannel(to) && this.chat(idOf(to)).forum ? { topic: 1 } : {}) };
          this.list(to).push(msg);
          ups.push({ _: 'updateMessageID', id: msg.id, randomId: req.randomId[i] }, this.newMessageUpdate(to, msg));
        });
        this.save();
        return this.updatesResult(ups);
      }
      case 'messages.getFullChat': {
        const c = this.chat(req.chatId);
        const participants = c.members.map((u) => (u === c.creator ? { _: 'chatParticipantCreator', userId: u } : c.admins.includes(u) ? { _: 'chatParticipantAdmin', userId: u, inviterId: c.creator, date: T0() } : { _: 'chatParticipant', userId: u, inviterId: c.creator, date: T0() }));
        const { users } = this.everyone();
        return {
          _: 'messages.chatFull',
          fullChat: { _: 'chatFull', id: c.id, about: c.about ?? '', participants: { _: 'chatParticipants', chatId: c.id, participants, version: 1 }, notifySettings: { _: 'peerNotifySettings' }, ...(c.invite ? { exportedInvite: invite(c.invite) } : {}), availableReactions: { _: 'chatReactionsAll' } },
          chats: [this.tlChat(c)],
          users,
        };
      }
      case 'channels.getFullChannel': {
        const p = this.channelOf(req.channel);
        const c = this.chat(idOf(p));
        const { users } = this.everyone();
        const reactions = c.reactions === 'none' ? { _: 'chatReactionsNone' } : Array.isArray(c.reactions) ? { _: 'chatReactionsSome', reactions: c.reactions.map((e) => ({ _: 'reactionEmoji', emoticon: e })) } : { _: 'chatReactionsAll' };
        return {
          _: 'messages.chatFull',
          fullChat: {
            _: 'channelFull',
            id: c.id,
            about: c.about ?? '',
            participantsCount: c.members.length,
            readInboxMaxId: 0,
            readOutboxMaxId: 0,
            unreadCount: 0,
            chatPhoto: { _: 'photoEmpty', id: Long.ZERO },
            notifySettings: { _: 'peerNotifySettings' },
            botInfo: [],
            pts: this.world.pts,
            ...(c.invite ? { exportedInvite: invite(c.invite) } : {}),
            ...(c.slowmode ? { slowmodeSeconds: c.slowmode } : {}),
            ...(c.broadcast ? {} : { canViewParticipants: true }),
            availableReactions: reactions,
          },
          chats: [this.tlChat(c)],
          users,
        };
      }
      case 'channels.getParticipants': {
        const p = this.channelOf(req.channel);
        const c = this.chat(idOf(p));
        if (c.broadcast && !c.admins.includes(self) && c.creator !== self) throw new FakeRpcError(400, 'CHAT_ADMIN_REQUIRED');
        const admins = req.filter?._ === 'channelParticipantsAdmins';
        const who = c.members.filter((u) => !admins || u === c.creator || c.admins.includes(u));
        const participants = who.map((u) => (u === c.creator ? { _: 'channelParticipantCreator', userId: u, adminRights: { _: 'chatAdminRights' } } : c.admins.includes(u) ? { _: 'channelParticipantAdmin', userId: u, promotedBy: c.creator, date: T0(), adminRights: { _: 'chatAdminRights' } } : { _: 'channelParticipant', userId: u, date: T0() }));
        return { _: 'channels.channelParticipants', count: participants.length, participants, chats: [], users: who.map((u) => this.tlUser(this.user(u))) };
      }
      case 'messages.editChatTitle': {
        const c = this.chat(req.chatId);
        c.title = req.title;
        const m: WMsg = { id: this.nextId(`chat:${c.id}`), from: self, date: now(), text: '', service: { kind: 'editTitle', title: req.title } };
        this.list(`chat:${c.id}`).push(m);
        this.save();
        return this.updatesResult([this.newMessageUpdate(`chat:${c.id}`, m)]);
      }
      case 'channels.editTitle': {
        const p = this.channelOf(req.channel);
        const c = this.chat(idOf(p));
        c.title = req.title;
        const m: WMsg = { id: this.nextId(p), from: self, date: now(), text: '', service: { kind: 'editTitle', title: req.title }, ...(c.forum ? { topic: 1 } : {}) };
        this.list(p).push(m);
        this.save();
        return this.updatesResult([this.newMessageUpdate(p, m)]);
      }
      case 'messages.editForumTopic': {
        const p = this.peerOf(req.peer);
        const c = this.chat(idOf(p));
        const t = c.topics?.find((x) => x.id === req.topicId);
        if (!t) throw new FakeRpcError(400, 'TOPIC_ID_INVALID');
        if (req.title) t.title = req.title;
        const m: WMsg = { id: this.nextId(p), from: self, date: now(), text: '', topic: t.id, service: { kind: 'topicEdit', title: req.title } };
        this.list(p).push(m);
        this.save();
        return this.updatesResult([this.newMessageUpdate(p, m)]);
      }
      case 'messages.editChatAbout': {
        const p = this.peerOf(req.peer);
        this.chat(idOf(p)).about = req.about;
        this.save();
        return true;
      }
      case 'channels.toggleSlowMode': {
        const c = this.chat(idOf(this.channelOf(req.channel)));
        c.slowmode = req.seconds;
        this.save();
        return this.updatesResult([]);
      }
      case 'channels.toggleJoinRequest': {
        const c = this.chat(idOf(this.channelOf(req.channel)));
        if (!c.username) throw new FakeRpcError(400, 'CHAT_PUBLIC_REQUIRED');
        c.joinRequest = !!req.enabled;
        this.save();
        return this.updatesResult([]);
      }
      case 'messages.exportChatInvite': {
        const c = this.chat(idOf(this.peerOf(req.peer)));
        c.invite = `https://t.me/+${b64url(12)}`;
        this.save();
        return invite(c.invite);
      }
      case 'messages.editExportedChatInvite': {
        const c = this.chat(idOf(this.peerOf(req.peer)));
        if (c.invite !== req.link) throw new FakeRpcError(400, 'INVITE_HASH_EXPIRED');
        if (req.revoked) c.invite = null;
        this.save();
        return { _: 'messages.exportedChatInvite', invite: { ...invite(req.link), revoked: true }, users: [] };
      }
      case 'messages.updatePinnedMessage': {
        const p = this.peerOf(req.peer);
        const m = this.msg(p, req.id);
        m.pinned = !req.unpin;
        this.save();
        return this.updatesResult([this.isChannel(p) ? { _: 'updatePinnedChannelMessages', channelId: idOf(p), messages: [m.id], pinned: m.pinned, pts: ++this.world.pts, ptsCount: 1 } : { _: 'updatePinnedMessages', peer: this.tlPeer(p), messages: [m.id], pinned: m.pinned, pts: ++this.world.pts, ptsCount: 1 }]);
      }
      case 'messages.getCustomEmojiDocuments':
        return [];
      case 'messages.checkChatInvite': {
        const inv = this.invite(req.hash);
        const c = this.chat(inv.chat);
        if (c.members.includes(self)) return { _: 'chatInviteAlready', chat: this.tlChat(c) };
        if (inv.peek) return { _: 'chatInvitePeek', chat: this.tlChat(c, true), expires: now() + inv.peek };
        return this.tlInvite(inv, c);
      }
      case 'messages.importChatInvite': {
        const inv = this.invite(req.hash);
        const c = this.chat(inv.chat);
        if (c.members.includes(self)) throw new FakeRpcError(400, 'USER_ALREADY_PARTICIPANT');
        if (inv.requestNeeded || c.joinRequest) this.askToJoin(c);
        if (inv.webview) {
          const bot = this.user(FAKE_IDS.bot);
          return { _: 'messages.chatInviteJoinResultWebView', botId: bot.id, queryId: Long.fromNumber(42), users: [this.tlUser(bot)] };
        }
        return this.joinChat(c);
      }
      case 'channels.joinChannel': {
        const c = this.chat(idOf(this.channelOf(req.channel)));
        if (c.members.includes(self)) throw new FakeRpcError(400, 'USER_ALREADY_PARTICIPANT');
        // A private chat is joined only by its invite link.
        if (!c.username) throw new FakeRpcError(400, 'CHANNEL_PRIVATE');
        if (c.joinRequest) this.askToJoin(c);
        return this.joinChat(c);
      }
      case 'contacts.addContact': {
        const u = this.userOf(req.id);
        if (u.id === self || u.bot) throw new FakeRpcError(400, 'CONTACT_ID_INVALID');
        if (!req.firstName) throw new FakeRpcError(400, 'CONTACT_NAME_EMPTY');
        u.contact = true;
        if (req.phone && !u.phone) u.phone = String(req.phone);
        this.save();
        return { _: 'updates', updates: [{ _: 'updatePeerSettings', peer: { _: 'peerUser', userId: u.id }, settings: { _: 'peerSettings' } }], users: [this.tlUser(u)], chats: [], date: now(), seq: 0 };
      }
      case 'messages.createChat': {
        // As Telegram: a basic group with you as its creator, everyone their privacy settings let in, and the rest
        // back as missingInvitees; its updates carry the new chat alone, and its "created the group" message.
        const users = (req.users as tl.TypeInputUser[]).map((x) => this.userOf(x));
        if (!req.title?.trim()) throw new FakeRpcError(400, 'CHAT_TITLE_EMPTY');
        if (!users.length) throw new FakeRpcError(400, 'USERS_TOO_FEW');
        const id = Math.max(0, ...this.world.chats.filter((c) => c.kind === 'chat').map((c) => c.id)) + 1;
        const c: WChat = { id, kind: 'chat', title: req.title, members: [self], admins: [], creator: self, invite: null };
        this.world.chats.push(c);
        const missingInvitees: tl.TypeMissingInvitee[] = users.filter((u) => u.addPrivacy).map((u) => ({ _: 'missingInvitee', userId: u.id, ...(u.addPrivacy === 'premium' ? { premiumWouldAllowInvite: true } : {}) }));
        c.members.push(...users.filter((u) => !u.addPrivacy).map((u) => u.id));
        const m: WMsg = { id: this.nextId(`chat:${id}`), from: self, date: now(), text: '', service: { kind: 'chatCreate', title: req.title } };
        this.list(`chat:${id}`).push(m);
        this.save();
        const updates: tl.RawUpdates = { _: 'updates', updates: [this.newMessageUpdate(`chat:${id}`, m)], users: c.members.map((u) => this.tlUser(this.user(u))), chats: [this.tlChat(c)], date: now(), seq: 0 };
        return { _: 'messages.invitedUsers', updates, missingInvitees };
      }
      case 'messages.addChatUser': {
        const c = this.chat(req.chatId);
        if (c.kind !== 'chat') throw new FakeRpcError(400, 'CHAT_ID_INVALID');
        if (!c.members.includes(self)) throw new FakeRpcError(403, 'CHAT_WRITE_FORBIDDEN');
        if (!this.mayInvite(c)) throw new FakeRpcError(400, 'CHAT_ADMIN_REQUIRED');
        const u = this.userOf(req.userId);
        if (c.members.includes(u.id)) throw new FakeRpcError(400, 'USER_ALREADY_PARTICIPANT');
        if (c.members.length >= 200) throw new FakeRpcError(400, 'USERS_TOO_MUCH');
        return this.addedTo(c, [u]);
      }
      case 'channels.inviteToChannel': {
        const c = this.chat(idOf(this.channelOf(req.channel)));
        if (!c.members.includes(self)) throw new FakeRpcError(400, 'CHANNEL_PRIVATE');
        if (!this.mayInvite(c)) throw new FakeRpcError(400, 'CHAT_ADMIN_REQUIRED');
        const users = (req.users as tl.TypeInputUser[]).map((x) => this.userOf(x));
        if (users.length === 1 && c.members.includes(users[0].id)) throw new FakeRpcError(400, 'USER_ALREADY_PARTICIPANT');
        if (c.broadcast && users.some((u) => u.bot)) throw new FakeRpcError(400, 'USER_BOT');
        return this.addedTo(c, users);
      }
      case 'messages.getChatInviteImporters': {
        const c = this.chat(idOf(this.peerOf(req.peer)));
        if (!this.admins(c)) throw new FakeRpcError(400, 'CHAT_ADMIN_REQUIRED');
        // The fake keeps who asked, not who joined by a link.
        let list = req.requested ? this.requestsOf(c.id).sort((a, b) => b.date - a.date || b.user - a.user) : [];
        if (req.offsetDate) {
          const after = req.offsetUser?._ === 'inputUser' ? Number(req.offsetUser.userId) : 0;
          list = list.filter((r) => r.date < req.offsetDate || (r.date === req.offsetDate && r.user < after));
        }
        const page = list.slice(0, req.limit);
        return { _: 'messages.chatInviteImporters', count: this.requestsOf(c.id).length, importers: page.map((r) => ({ _: 'chatInviteImporter', requested: true, userId: r.user, date: r.date })), users: page.map((r) => this.tlUser(this.user(r.user))) };
      }
      case 'messages.hideChatJoinRequest': {
        const c = this.chat(idOf(this.peerOf(req.peer)));
        if (!this.admins(c)) throw new FakeRpcError(400, 'CHAT_ADMIN_REQUIRED');
        const u = this.userOf(req.userId);
        const list = (this.world.joinRequests ??= []);
        const i = list.findIndex((r) => r.chat === c.id && r.user === u.id);
        if (i < 0) throw new FakeRpcError(400, 'HIDE_REQUESTER_MISSING');
        list.splice(i, 1);
        if (req.approved && !c.members.includes(u.id)) c.members.push(u.id);
        this.save();
        return this.updatesResult([this.pendingUpdate(c)]);
      }
      case 'auth.acceptLoginToken': {
        const key = Buffer.from(req.token as Uint8Array).toString('base64url');
        const t = this.loginTokens.get(key);
        if (!t) throw new FakeRpcError(400, 'AUTH_TOKEN_INVALID');
        if (t.accepted) throw new FakeRpcError(400, 'AUTH_TOKEN_ALREADY_ACCEPTED');
        if (Date.now() > t.expires) throw new FakeRpcError(400, 'AUTH_TOKEN_EXPIRED');
        t.accepted = true;
        const a: WAuth = { ...t.who, hash: hashOf(), ip: '203.0.113.99', created: now(), active: now() };
        this.authorizations().push(a);
        this.save();
        return this.tlAuthorization(a, false);
      }
      case 'account.getAuthorizations': {
        const created = this.sessionCreated();
        const current: WAuth = { ...CURRENT_AUTH, hash: '0', created, active: now() };
        return { _: 'account.authorizations', authorizationTtlDays: 180, authorizations: [this.tlAuthorization(current, true), ...this.authorizations().map((a) => this.tlAuthorization(a, false))] };
      }
      case 'account.resetAuthorization': {
        const hash = (req.hash as Long).toString();
        if (hash === '0') throw new FakeRpcError(400, 'HASH_INVALID');
        // Telegram: a session less than a day old may not end other sessions.
        if (now() - this.sessionCreated() < 86_400) throw new FakeRpcError(406, 'FRESH_RESET_AUTHORISATION_FORBIDDEN');
        const list = this.authorizations();
        const i = list.findIndex((a) => a.hash === hash);
        if (i < 0) throw new FakeRpcError(400, 'HASH_INVALID');
        list.splice(i, 1);
        this.save();
        return true;
      }
      default:
        throw new FakeRpcError(400, `METHOD_NOT_IN_FAKE (${method})`);
    }
  }

  private authorizations(): WAuth[] {
    return (this.world.authorizations ??= seedAuthorizations());
  }

  /** When the signed-in session was made (seconds); one the world has no time for is two days old. */
  private sessionCreated(): number {
    return (this.session && this.world.sessionAt?.[this.session]) || now() - 2 * 86_400;
  }

  private tlAuthorization(a: WAuth, current: boolean): tl.RawAuthorization {
    return {
      _: 'authorization',
      ...(current ? { current: true } : {}),
      ...(a.apiId === 8 || a.apiId === 2040 || a.apiId === 2496 ? { officialApp: true } : {}),
      hash: Long.fromString(a.hash),
      deviceModel: a.device,
      platform: a.platform,
      systemVersion: a.system,
      apiId: a.apiId,
      appName: a.app,
      appVersion: a.appVersion,
      dateCreated: a.created,
      dateActive: a.active,
      ip: a.ip,
      country: a.country,
      region: a.region,
    };
  }

  /** Entities as Telegram stores them: a mention's InputUser checked and turned into a user id. */
  private entities(list: tl.TypeMessageEntity[]): tl.TypeMessageEntity[] {
    return list.map((e) => {
      if (e._ === 'inputMessageEntityMentionName') this.userOf(e.userId);
      return outputEntity(e);
    });
  }

  private mayWrite(p: Peer) {
    if (!this.isChannel(p)) return;
    const c = this.chat(idOf(p));
    if (c.broadcast && c.creator !== this.world.self && !c.admins.includes(this.world.self)) throw new FakeRpcError(403, 'CHAT_WRITE_FORBIDDEN');
  }
}

/** The control socket of the fake in this account directory (a short one under /tmp when the directory's path is too long for a socket). */
export function fakeSocketPath(dir: string): string {
  const p = join(dir, 'fake-telegram.sock');
  return p.length < 100 ? p : `/tmp/tgfake-${new Bun.CryptoHasher('sha1').update(dir).digest('hex').slice(0, 16)}.sock`;
}

/** One control command to the fake of an account directory, over its socket (tests, scripts/verify-telegram.ts). */
export function fakeControl(dir: string, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no answer to ${cmd.op}`)), timeoutMs);
    const done = (f: () => void) => {
      clearTimeout(timer);
      f();
    };
    Bun.connect({
      unix: fakeSocketPath(dir),
      socket: {
        open: (s) => void s.write(JSON.stringify(cmd) + '\n'),
        data: (s, d) => {
          buf += Buffer.from(d).toString();
          if (!buf.includes('\n')) return;
          s.end();
          const r = JSON.parse(buf.slice(0, buf.indexOf('\n')));
          done(() => (r.ok ? resolve(r.result) : reject(new Error(r.error))));
        },
        error: (_s, e) => done(() => reject(e)),
        connectError: (_s, e) => done(() => reject(e)),
      },
    }).catch((e) => done(() => reject(e)));
  });
}

const now = () => Math.floor(Date.now() / 1000);
const idOf = (p: string) => Number(p.split(':')[1]);
/** A request as JSON can carry it: 64-bit numbers as decimal strings, bytes as base64. */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v) => (v instanceof Long ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v)));
const invite = (link: string) => ({ _: 'chatInviteExported', link, adminId: FAKE_IDS.self, date: T0(), permanent: true });
