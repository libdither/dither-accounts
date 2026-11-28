/**
 * Telegram's test DC as a network for the composition parity suite (docs/telegram.md, "Test DC parity testing").
 *
 * Telegram keeps a separate set of servers for testing, with its own accounts. A phone number +99966<dc><4 digits> is
 * a test account on DC <dc>, and its login code is always that digit five times: no SIM, no SMS, just an api_id and
 * api_hash. Two such accounts face each other:
 *
 * - actorA is the extractor under test, extractors/telegram in process, on the test DC (`testDc`) with a fresh
 *   account directory, driven by the same commands the manager sends it.
 * - actorB is a bare mtcute client: the other person, and the oracle. What the network holds is read back through it
 *   (channels.getMessages / messages.getMessages, messages.getMessageReactionsList) and mapped by
 *   normalizeTelegramHistory below, which shares nothing with the extractor's own mapping.ts.
 *
 * The numbers, the codes and the normalizer are pure and tested offline (telegram-testdc.test.ts); the live driver
 * runs only from scripts/parity-telegram-testdc.ts.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import type { tl } from '../../extractors/telegram/src/backend.ts';
import { type Actor, type Cap, EventFolder, type Handle, normalize, type NormalizedConversationState, type ParityDriver, type RawMessage, type SendOptions, scoped } from './harness.ts';

// ---------------------------------------------------------------- numbers and codes

export const DEFAULT_TEST_DC = 2;
export const TEST_DCS = [1, 2, 3] as const;

/** The test account number <n> (0-9999) on test DC <dc>: +99966<dc><nnnn>. */
export function testDcPhone(dc: number, n: number): string {
  if (!(TEST_DCS as readonly number[]).includes(dc)) throw new Error(`there is no test DC ${dc} (1, 2 or 3)`);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error(`a test number is 0-9999, not ${n}`);
  return `+99966${dc}${String(n).padStart(4, '0')}`;
}

/** A test DC number's DC and number, or null for any other phone number. */
export function parseTestDcPhone(phone: string): { dc: number; n: number } | null {
  const m = phone.replace(/[\s().+-]/g, '').match(/^99966([1-3])(\d{4})$/);
  return m ? { dc: Number(m[1]), n: Number(m[2]) } : null;
}

/** The login code of a test number (or of any number on that DC): the DC's digit, `length` times (Telegram says 5). */
export function testDcCode(phoneOrDc: string | number, length = 5): string {
  const dc = typeof phoneOrDc === 'number' ? phoneOrDc : parseTestDcPhone(phoneOrDc)?.dc;
  if (!dc || !(TEST_DCS as readonly number[]).includes(dc)) throw new Error(`not a test DC number: ${typeof phoneOrDc === 'number' ? `DC ${phoneOrDc}` : 'that phone'}`);
  return String(dc).repeat(length);
}

/**
 * Test numbers to try, in order, the same for the same seed and all different: the test DC's accounts are shared by
 * everyone who uses it, so one may already have a password someone set (SESSION_PASSWORD_NEEDED), and the next is
 * tried. A step coprime to 10 000 walks every number once.
 */
export function testDcNumbers(seed: string, dc = DEFAULT_TEST_DC, count = 16): string[] {
  let h = 0x811c9dc5;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const start = h % 10_000;
  let step = ((h >>> 13) % 9_999) | 1;
  if (step % 5 === 0) step += 2;
  return Array.from({ length: Math.min(count, 10_000) }, (_, i) => testDcPhone(dc, (start + i * step) % 10_000));
}

// ---------------------------------------------------------------- the network's state, normalized

/** One person's reaction, as messages.getMessageReactionsList (or a message's recentReactions) names it. */
export interface PeerReaction {
  userId: number;
  key: string;
}

export interface TelegramHistory {
  /** What the oracle read: messages.getHistory, messages.getMessages or channels.getMessages (messageEmpty for gone). */
  messages: tl.TypeMessage[];
  /** The ids the run made, so one no longer there is known to be deleted. */
  made?: Iterable<number>;
  /** Ids pinned, besides each message's own `pinned` flag (messages.search with inputMessagesFilterPinned). */
  pinned?: Iterable<number>;
  /** Who reacted with what, per message id (messages.getMessageReactionsList); a message left out uses its recentReactions. */
  reactionLists?: Map<number, PeerReaction[]>;
  /** The reading account's own user id: its outgoing messages, and its own chosen reaction. */
  self: number;
  /** The harness's handle for a message id; null leaves the message out (not the scenario's). */
  handle(id: number): Handle | null;
  actorA: string;
  actorB: string;
}

/** A reaction's canonical key, read from the TL itself (custom emoji as custom:<documentId>, as the protocol keys them). */
function keyOf(r: tl.TypeReaction): string | null {
  if (r._ === 'reactionEmoji') return r.emoticon;
  if (r._ === 'reactionCustomEmoji') return `custom:${r.documentId.toString()}`;
  return null;
}

function peerUser(p: tl.TypePeer | undefined): string | null {
  if (!p) return null;
  if (p._ === 'peerUser') return String(p.userId);
  if (p._ === 'peerChannel') return `channel:${p.channelId}`;
  return null;
}

/** A file's kind from the TL: a photo is an image; a document a video, audio, or file by its attributes. */
function attachmentKinds(media: tl.TypeMessageMedia | undefined): { kind: string }[] {
  if (!media) return [];
  if (media._ === 'messageMediaPhoto') return media.photo ? [{ kind: 'image' }] : [];
  if (media._ === 'messageMediaDocument') {
    const d = media.document;
    if (d?._ !== 'document') return [];
    const attrs = d.attributes.map((a) => a._);
    if (attrs.includes('documentAttributeVideo') || attrs.includes('documentAttributeAnimated')) return [{ kind: 'video' }];
    if (attrs.includes('documentAttributeAudio')) return [{ kind: 'audio' }];
    return [{ kind: 'file' }];
  }
  return [];
}

/**
 * The conversation as Telegram itself holds it, from raw MTProto messages: the ground truth the extractor's events
 * are compared with. Service messages (joins, "pinned a message") are not the suite's: they are left out, and the
 * live driver leaves them out of the extractor's side too.
 */
export function normalizeTelegramHistory(h: TelegramHistory): NormalizedConversationState {
  const pinned = new Set(h.pinned ?? []);
  const live: RawMessage[] = [];
  const there = new Set<number>();
  for (const m of h.messages) {
    if (m._ !== 'message') continue;
    const id = h.handle(m.id);
    if (!id) continue;
    there.add(m.id);
    // A private chat's incoming message may name no sender: it is the other person's (peerId), an outgoing one ours.
    const author = peerUser(m.fromId) ?? (m.out ? String(h.self) : peerUser(m.peerId) ?? '?');
    const header = m.replyTo?._ === 'messageReplyHeader' ? m.replyTo : undefined;
    const replyTo = header?.replyToMsgId !== undefined && !(header.forumTopic && header.replyToTopId === undefined) ? (h.handle(header.replyToMsgId) ?? `tg:${header.replyToMsgId}`) : null;
    let reactions: { author: string; key: string }[];
    const listed = h.reactionLists?.get(m.id);
    if (listed) reactions = listed.map((r) => ({ author: String(r.userId), key: r.key }));
    else {
      reactions = [];
      const r = m.reactions;
      for (const pr of r?.recentReactions ?? []) {
        const key = keyOf(pr.reaction);
        const who = peerUser(pr.peerId);
        if (key && who) reactions.push({ author: who, key });
      }
      // Our own reaction is marked by chosenOrder even where recentReactions leaves it out.
      for (const rc of r?.results ?? []) {
        const key = keyOf(rc.reaction);
        if (key && rc.chosenOrder !== undefined && !reactions.some((x) => x.author === String(h.self) && x.key === key)) reactions.push({ author: String(h.self), key });
      }
    }
    live.push({
      id,
      author,
      body: m.message,
      edited: m.editDate !== undefined && !m.editHide,
      replyTo,
      reactions,
      pinned: !!m.pinned || pinned.has(m.id),
      attachments: attachmentKinds(m.media),
    });
  }
  const deleted: Handle[] = [];
  for (const id of h.made ?? []) {
    if (there.has(id)) continue;
    // Gone, or a service message in its place: either way not a message of the scenario's any more.
    if (h.messages.some((m) => m.id === id && m._ === 'messageService')) continue;
    const handle = h.handle(id);
    if (handle) deleted.push(handle);
  }
  return normalize(h, live, deleted);
}

// ---------------------------------------------------------------- credentials

export interface TestDcCreds {
  apiId: number;
  apiHash: string;
}

/**
 * TELEGRAM_API_ID and TELEGRAM_API_HASH, from the environment or a file of either JSON ({ apiId, apiHash }) or
 * KEY=value lines. Never logged; the file stays wherever its owner keeps it.
 */
export function readCreds(o: { env?: Record<string, string | undefined>; file?: string } = {}): TestDcCreds {
  const env = o.env ?? process.env;
  let id = env.TELEGRAM_API_ID;
  let hash = env.TELEGRAM_API_HASH;
  if (o.file) {
    const text = readFileSync(o.file, 'utf8');
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      id = String(j.apiId ?? j.api_id ?? j.TELEGRAM_API_ID ?? id ?? '');
      hash = String(j.apiHash ?? j.api_hash ?? j.TELEGRAM_API_HASH ?? hash ?? '');
    } catch {
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?(TELEGRAM_API_ID|TELEGRAM_API_HASH)\s*=\s*["']?([^"'\s]+)["']?\s*$/);
        if (m?.[1] === 'TELEGRAM_API_ID') id = m[2];
        if (m?.[1] === 'TELEGRAM_API_HASH') hash = m[2];
      }
    }
  }
  if (!id || !/^\d+$/.test(id)) throw new Error('TELEGRAM_API_ID is missing or not a number (from https://my.telegram.org, "API development tools")');
  if (!hash || !/^[0-9a-f]{32}$/i.test(hash)) throw new Error('TELEGRAM_API_HASH is missing or not 32 hex digits');
  return { apiId: Number(id), apiHash: hash };
}

// ---------------------------------------------------------------- the live side: clients and sign-in

type Client = import('../../extractors/telegram/src/mtcute.ts').TelegramClient;
type Log = (line: string) => void;

const text = (e: unknown) => {
  const any = e as { text?: string; message?: string } | null;
  return any?.text ?? any?.message ?? String(e);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bare mtcute client on the test DC (mtcute.ts bareClient: testMode, in memory unless given a path). */
export async function createTestDcClient(creds: TestDcCreds, o: { storagePath?: string; logLevel?: number } = {}): Promise<Client> {
  const { bareClient } = await import('../../extractors/telegram/src/mtcute.ts');
  return bareClient({ ...creds, testMode: true, ...o });
}

/**
 * Signs a bare client in to the first of `phones` that takes it: an account without one is made (auth.signUp, which
 * the test DC still allows), one with a password someone set is passed over, and a short FLOOD_TEST_PHONE_WAIT is
 * waited out. Returns the number used.
 */
export async function signInTestAccount(client: Client, phones: string[], o: { firstName: string; log?: Log }): Promise<{ phone: string; user: tl.RawUser }> {
  const log = o.log ?? (() => {});
  await client.connect();
  for (const phone of phones) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sent = await client.sendCode({ phone });
        if (!('phoneCodeHash' in sent)) throw new Error('signed in without a code');
        const phoneNumber = phone.replace(/\D/g, '');
        const code = testDcCode(phone, sent.length || 5);
        let auth = (await client.call({ _: 'auth.signIn', phoneNumber, phoneCodeHash: sent.phoneCodeHash, phoneCode: code })) as tl.auth.TypeAuthorization;
        if (auth._ === 'auth.authorizationSignUpRequired') {
          log(`test number ${redactTestPhone(phone)} has no account yet: signing up`);
          auth = (await client.call({ _: 'auth.signUp', phoneNumber, phoneCodeHash: sent.phoneCodeHash, firstName: o.firstName, lastName: '' })) as tl.auth.TypeAuthorization;
        }
        const user = await client.notifyLoggedIn(auth);
        return { phone, user };
      } catch (e) {
        const t = text(e);
        const wait = t.match(/^FLOOD_TEST_PHONE_WAIT_(\d+)$/) ?? (/FLOOD_TEST_PHONE_WAIT/.test(t) ? [t, String((e as { seconds?: number }).seconds ?? 60)] : null);
        if (wait && Number(wait[1]) <= 30) {
          log(`test DC asks to wait ${wait[1]} s for ${redactTestPhone(phone)}`);
          await sleep(Number(wait[1]) * 1000 + 500);
          continue;
        }
        log(`test number ${redactTestPhone(phone)} passed over: ${t.replace(/\d{5,}/g, '…')}`);
        // A half-finished sign-in leaves nothing to undo; the next number starts afresh.
        break;
      }
    }
  }
  throw new Error(`none of ${phones.length} test numbers signed in (all had passwords, refused sign-up or asked to wait)`);
}

/** A test number as logs show it: its DC and last two digits. */
export function redactTestPhone(phone: string): string {
  const p = parseTestDcPhone(phone);
  return p ? `+99966${p.dc}··${String(p.n).padStart(4, '0').slice(2)}` : 'a phone number';
}

// ---------------------------------------------------------------- the live driver

export type ChatMode = 'group' | 'dm';
export const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];

export interface TestDcDriverOptions {
  creds: TestDcCreds;
  dc?: number;
  /** A supergroup B makes for the run (message ids shared by both), or the two people's private chat (each has its own). */
  chat?: ChatMode;
  /** Sessions kept between runs (0700, files 0600), so the numbers sign in once. */
  stateDir?: string;
  /** Keep the extractor's account directory and B's supergroup afterwards. */
  keep?: boolean;
  log?: Log;
}

export interface TestDcDriver extends ParityDriver {
  /** The extractor's account directory (a fresh temp one). */
  readonly dir: string;
  /** Every command sent to the extractor and event it emitted, in order (for --capture). */
  readonly trace: { seq: number; dir: 'command' | 'event'; at: number; msg: unknown }[];
  stop(): Promise<void>;
}

interface Cached {
  A?: { phone: string; session?: string; userId?: string };
  B?: { phone: string; session?: string };
}

function readCache(stateDir: string | undefined): Cached {
  if (!stateDir || !existsSync(join(stateDir, 'sessions.json'))) return {};
  try {
    return JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')) as Cached;
  } catch {
    return {};
  }
}

function writeCache(stateDir: string | undefined, c: Cached) {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = join(stateDir, 'sessions.json');
  writeFileSync(path, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

const randomLong = async () => {
  const { Long } = await import('../../extractors/telegram/src/mtcute.ts');
  const b = crypto.getRandomValues(new Int32Array(2));
  return Long.fromBits(b[0]!, b[1]!);
};

/** The id of the message a send made, from the Updates it answered with. */
export function sentMessageId(res: unknown): number {
  const r = res as { _: string; id?: number; updates?: { _: string; id?: number; message?: { id: number } }[] };
  if (r._ === 'updateShortSentMessage' && r.id) return r.id;
  for (const u of r.updates ?? []) if ((u._ === 'updateNewMessage' || u._ === 'updateNewChannelMessage') && u.message) return u.message.id;
  for (const u of r.updates ?? []) if (u._ === 'updateMessageID' && u.id) return u.id;
  throw new Error(`no message id in ${r._}`);
}

/**
 * Two test accounts and the conversation between them, as a ParityDriver: the extractor (A) and a bare client (B),
 * both signed in, the conversation made and known to the extractor before it resolves.
 */
export async function createTestDcDriver(o: TestDcDriverOptions): Promise<TestDcDriver> {
  const log = o.log ?? (() => {});
  const dc = o.dc ?? DEFAULT_TEST_DC;
  const mode: ChatMode = o.chat ?? 'group';
  const cache = readCache(o.stateDir);
  const { TelegramAdapter } = await import('../../extractors/telegram/src/adapter.ts');
  const { Long, MtcuteBackend } = await import('../../extractors/telegram/src/mtcute.ts');
  const { clientProfile } = await import('../../extractors/telegram/src/profile.ts');
  const seed = o.stateDir ?? `run-${Date.now()}`;
  const numbers = testDcNumbers(seed, dc, 24);

  // B: a bare client, from its cached session or signed in afresh.
  const b = await createTestDcClient(o.creds);
  let bUser: tl.RawUser | null = null;
  if (cache.B?.session) {
    try {
      await b.importSession(cache.B.session, true);
      await b.connect();
      const [self] = await b.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] });
      if (self?._ === 'user') bUser = await b.notifyLoggedIn(self);
    } catch (e) {
      log(`B's cached session no longer works (${text(e)}): signing in again`);
    }
  }
  if (!bUser) {
    const r = await signInTestAccount(b, numbers.filter((p) => p !== cache.A?.phone), { firstName: 'Parity B', log });
    bUser = r.user;
    cache.B = { phone: r.phone, session: await b.exportSession() };
    writeCache(o.stateDir, cache);
  }
  const bId = Number(bUser.id);

  // A's number: one that signs in with no password (made once with a bare client, which then signs out).
  if (!cache.A?.phone) {
    const boot = await createTestDcClient(o.creds);
    try {
      const r = await signInTestAccount(boot, numbers.filter((p) => p !== cache.B!.phone), { firstName: 'Parity A', log });
      cache.A = { phone: r.phone };
      await boot.logOut().catch(() => {});
    } finally {
      await boot.destroy().catch(() => {});
    }
    writeCache(o.stateDir, cache);
  }

  // A: the extractor, on a fresh account directory.
  const dir = mkdtempSync(join(tmpdir(), 'parity-tg-testdc-'));
  chmodSync(dir, 0o700);
  writeSecretFile(join(dir, 'secret.json'), { apiHash: o.creds.apiHash, ...(cache.A?.session ? { session: cache.A.session, userId: cache.A.userId } : {}) });
  const folder = new EventFolder('telegram');
  const trace: TestDcDriver['trace'] = [];
  const ticks = new Set<() => void>();
  const tick = () => {
    for (const f of [...ticks]) f();
  };
  const system = new Set<string>();
  let status: Extract<P.AdapterEvent, { t: 'status' }> | undefined;
  const adapter = new TelegramAdapter(
    {
      emit: (e) => {
        trace.push({ seq: trace.length, dir: 'event', at: Date.now(), msg: e });
        if (e.t === 'status') status = e;
        if (e.t === 'message' && e.message.kind === 'system') system.add(e.message.nativeId);
        folder.apply(e);
        tick();
      },
      log: (level, msg) => {
        if (level === 'warn' || level === 'error') log(`extractor ${level}: ${msg}`);
      },
      accountDir: dir,
      config: { apiId: String(o.creds.apiId), testDc: 'yes', deviceName: 'dither-parity' },
      secret: () => readSecretFile(join(dir, 'secret.json')),
      saveSecret: (v) => writeSecretFile(join(dir, 'secret.json'), v),
    },
    { backend: (c) => new MtcuteBackend({ ...c, dir, testMode: true, initConnection: clientProfile(c.apiId, { deviceName: 'dither-parity' }), log: () => {} }) },
  );
  const cmd = async (c: Record<string, unknown>) => {
    trace.push({ seq: trace.length, dir: 'command', at: Date.now(), msg: c });
    return adapter.command({ id: 'parity', ...c } as P.AdapterCommand);
  };
  const until = async (what: string, f: () => unknown, ms = 60_000) => {
    const end = Date.now() + ms;
    while (!f()) {
      if (Date.now() > end) throw new Error(`the extractor did not get to: ${what} (status ${status?.status ?? 'none'}: ${status?.attention?.message ?? ''})`);
      await new Promise<void>((r) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          ticks.delete(done);
          r();
        }
        ticks.add(done);
      });
    }
  };
  await adapter.start();
  await until('online or asking to sign in', () => status?.status === 'online' || status?.status === 'attention');
  if (status?.status !== 'online') {
    const phone = cache.A!.phone;
    log(`A signs in to the extractor as ${redactTestPhone(phone)}`);
    const sent = (await cmd({ t: 'action', action: 'sendCode', args: { phone } })) as { length?: number };
    const r = (await cmd({ t: 'action', action: 'code', args: { code: testDcCode(phone, sent.length || 5) } })) as { password?: boolean };
    if (r.password) throw new Error("A's test number has a password now (someone else's): delete the state dir's sessions.json to pick others");
    await until('online', () => status?.status === 'online');
    const s = readSecretFile(join(dir, 'secret.json')) as { session?: string; userId?: string };
    cache.A = { phone, session: s.session, userId: s.userId };
    writeCache(o.stateDir, cache);
  }
  const aId = Number((readSecretFile(join(dir, 'secret.json')) as { userId?: string }).userId);
  if (!aId) throw new Error('the extractor signed in without saying who it is');

  // B finds A (by phone, as a contact), and the conversation is made.
  const imported = (await b.call({ _: 'contacts.importContacts', contacts: [{ _: 'inputPhoneContact', clientId: await randomLong(), phone: cache.A!.phone.replace(/\D/g, ''), firstName: 'Parity A', lastName: '' }] })) as tl.contacts.RawImportedContacts;
  const aUser = imported.users.find((u) => u._ === 'user' && Number(u.id) === aId) as tl.RawUser | undefined;
  if (!aUser?.accessHash) throw new Error("B could not find A by phone (A's privacy settings on the test DC?)");
  const aInputUser: tl.TypeInputUser = { _: 'inputUser', userId: aId, accessHash: aUser.accessHash };
  const aInputPeer: tl.TypeInputPeer = { _: 'inputPeerUser', userId: aId, accessHash: aUser.accessHash };

  let conv: string;
  let bPeer: tl.TypeInputPeer;
  let channel: tl.TypeInputChannel | null = null;
  const tag = Math.random().toString(36).slice(2, 8);
  if (mode === 'group') {
    const made = (await b.call({ _: 'channels.createChannel', megagroup: true, title: `parity ${tag}`, about: 'dither-accounts parity run (test DC)' })) as tl.TypeUpdates;
    const chat = ('chats' in made ? made.chats : []).find((c) => c._ === 'channel') as tl.RawChannel | undefined;
    if (!chat?.accessHash) throw new Error('channels.createChannel made no supergroup');
    channel = { _: 'inputChannel', channelId: chat.id, accessHash: chat.accessHash };
    bPeer = { _: 'inputPeerChannel', channelId: chat.id, accessHash: chat.accessHash };
    await b.call({ _: 'messages.setChatAvailableReactions', peer: bPeer, availableReactions: { _: 'chatReactionsAll' } } as never).catch((e) => log(`available reactions: ${text(e)}`));
    await b.call({ _: 'channels.inviteToChannel', channel, users: [aInputUser] });
    await b.call({ _: 'channels.editAdmin', channel, userId: aInputUser, adminRights: { _: 'chatAdminRights', pinMessages: true }, rank: '' });
    conv = `channel:${chat.id}`;
  } else {
    bPeer = aInputPeer;
    conv = `dm:${aId}:${bId}`;
    // A message from B first, so the extractor has B (and B's access hash) before it writes.
    await b.call({ _: 'messages.sendMessage', peer: bPeer, message: `parity run ${tag} starts`, randomId: await randomLong() });
  }
  await until(`the conversation ${mode === 'group' ? 'B made' : 'with B'}`, () => folder.events.some((e) => e.t === 'conversation' && e.conversation.nativeId === conv));

  // Ids: shared in a supergroup; in a private chat each side has its own, matched once by a mark in the text.
  const shared = mode === 'group';
  const bIdOf = new Map<Handle, number>();
  const handleOf = new Map<number, Handle>();
  const made = new Set<number>();
  let marks = 0;
  const link = (h: Handle, id: number) => {
    bIdOf.set(h, id);
    handleOf.set(id, h);
    made.add(id);
  };
  const bMsg = (h: Handle) => {
    const id = shared ? Number(h.slice(h.lastIndexOf('#') + 1)) : bIdOf.get(h);
    if (id === undefined) throw new Error(`B never saw ${h}`);
    return id;
  };
  const handle = (id: number): Handle | null => (shared ? `${conv}#${id}` : (handleOf.get(id) ?? null));

  /** In a private chat: B's id for a message A sent, by its mark, from B's own history. */
  const findOnB = async (mark: string): Promise<number | null> => {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const res = (await b.call({ _: 'messages.getHistory', peer: bPeer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 30, maxId: 0, minId: 0, hash: Long.ZERO })) as tl.messages.TypeMessages;
      const m = 'messages' in res ? res.messages.find((x) => x._ === 'message' && x.message.includes(mark)) : undefined;
      if (m) return m.id;
      await sleep(300);
    }
    return null;
  };

  const spool = mkdtempSync(join(tmpdir(), 'parity-tg-testdc-spool-'));
  b.onRawUpdate.add(() => tick());

  const send = async (actor: Actor, body: string, so: SendOptions = {}): Promise<Handle> => {
    const mark = shared ? '' : ` ·${tag}${++marks}`;
    const words = body + mark;
    if (actor === 'A') {
      const attachments = so.attachment
        ? [(() => {
            const path = join(spool, so.attachment.name);
            writeFileSync(path, so.attachment.bytes);
            return { path, name: so.attachment.name, mime: so.attachment.mime, size: so.attachment.bytes.length, kind: 'image' as const };
          })()]
        : undefined;
      const h = ((await cmd({ t: 'send', conversation: conv, body: words, ...(so.replyTo ? { replyTo: so.replyTo } : {}), ...(attachments ? { attachments } : {}) })) as { nativeId: string }).nativeId;
      const id = shared ? bMsg(h) : await findOnB(mark);
      if (id === null) {
        // B never got it: the oracle cannot say what it holds, so the run fails here, naming it.
        throw new Error(`B never received A's message ${h}`);
      }
      link(h, id);
      return h;
    }
    const replyTo = so.replyTo ? { replyTo: { _: 'inputReplyToMessage', replyToMsgId: bMsg(so.replyTo) } as tl.TypeInputReplyTo } : {};
    let res: unknown;
    if (so.attachment) {
      const up = await b.uploadFile({ file: so.attachment.bytes, fileName: so.attachment.name, fileMime: so.attachment.mime, fileSize: so.attachment.bytes.length });
      res = await b.call({ _: 'messages.sendMedia', peer: bPeer, media: { _: 'inputMediaUploadedPhoto', file: up.inputFile }, message: words, randomId: await randomLong(), ...replyTo });
    } else res = await b.call({ _: 'messages.sendMessage', peer: bPeer, message: words, randomId: await randomLong(), ...replyTo });
    const id = sentMessageId(res);
    if (shared) {
      link(`${conv}#${id}`, id);
      return `${conv}#${id}`;
    }
    // A's id for it: the extractor's message with the mark. One that never comes stays B's own, which the diff names.
    const at = folder.events.length;
    const got = await Promise.race([folder.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.conversation === conv && e.message.body.includes(mark), Math.max(0, at - 50)), sleep(20_000).then(() => null)]);
    const h = got ? got.message.nativeId : `unmatched:${id}`;
    link(h, id);
    return h;
  };

  const d: TestDcDriver = {
    name: `telegram (test DC ${dc}, ${mode === 'group' ? 'supergroup' : 'private chat'})`,
    network: 'telegram',
    capabilities: CAPS,
    actorA: String(aId),
    actorB: String(bId),
    dir,
    trace,
    send,
    reply: (actor, h, body) => send(actor, body, { replyTo: h }),
    async edit(actor, h, body) {
      if (actor === 'A') await cmd({ t: 'edit', conversation: conv, message: h, body });
      else await b.call({ _: 'messages.editMessage', peer: bPeer, id: bMsg(h), message: body });
    },
    async react(actor, h, key, remove) {
      if (actor === 'A') await cmd({ t: 'react', conversation: conv, message: h, key, ...(remove ? { remove: true } : {}) });
      else await b.call({ _: 'messages.sendReaction', peer: bPeer, msgId: bMsg(h), reaction: remove ? [] : [{ _: 'reactionEmoji', emoticon: key }] });
    },
    async delete(actor, h) {
      if (actor === 'A') await cmd({ t: 'redact', conversation: conv, message: h });
      else if (channel) await b.call({ _: 'channels.deleteMessages', channel, id: [bMsg(h)] });
      else await b.call({ _: 'messages.deleteMessages', id: [bMsg(h)], revoke: true });
    },
    async pin(actor, h, pinned) {
      if (actor === 'A') await cmd({ t: 'configure', target: { kind: 'conversation', nativeId: conv }, change: { key: 'pin', message: h, ...(pinned ? {} : { remove: true }) } });
      else await b.call({ _: 'messages.updatePinnedMessage', peer: bPeer, id: bMsg(h), silent: true, ...(pinned ? {} : { unpin: true }) });
    },
    extractorState: () => scoped(folder.state(d, conv), (id) => !system.has(id)),
    async oracleState() {
      const ids = [...made];
      const messages: tl.TypeMessage[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const id = ids.slice(i, i + 100).map((n) => ({ _: 'inputMessageID' as const, id: n }));
        const res = (channel ? await b.call({ _: 'channels.getMessages', channel, id }) : await b.call({ _: 'messages.getMessages', id })) as tl.messages.TypeMessages;
        if ('messages' in res) messages.push(...res.messages);
      }
      const reactionLists = new Map<number, PeerReaction[]>();
      for (const m of messages) {
        if (m._ !== 'message' || !m.reactions?.results.length) continue;
        try {
          const list = (await b.call({ _: 'messages.getMessageReactionsList', peer: bPeer, id: m.id, limit: 100 })) as tl.messages.RawMessageReactionsList;
          reactionLists.set(
            m.id,
            list.reactions.flatMap((r) => {
              const key = keyOf(r.reaction);
              return key && r.peerId._ === 'peerUser' ? [{ userId: Number(r.peerId.userId), key }] : [];
            }),
          );
        } catch {
          // A private chat may not list them: the message's own recentReactions then.
        }
      }
      return normalizeTelegramHistory({ messages, made, reactionLists, self: bId, handle, actorA: d.actorA, actorB: d.actorB });
    },
    changed: () =>
      new Promise<void>((r) => {
        // An event from the extractor, an update reaching B, or a second gone by (the network moves on its own too).
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          ticks.delete(done);
          r();
        }
        ticks.add(done);
      }),
    mark: () => folder.events.length,
    dropped: (since) => folder.dropped.filter((x) => x.at >= since),
    async stop() {
      if (channel && !o.keep) await b.call({ _: 'channels.deleteChannel', channel }).catch((e) => log(`deleting the supergroup: ${text(e)}`));
      await adapter.shutdown();
      const s = readSecretFile(join(dir, 'secret.json')) as { session?: string; userId?: string };
      if (s.session && cache.A) {
        cache.A = { ...cache.A, session: s.session, userId: s.userId };
        writeCache(o.stateDir, cache);
      }
      await b.destroy().catch(() => {});
      rmSync(spool, { recursive: true, force: true });
      if (!o.keep) rmSync(dir, { recursive: true, force: true });
    },
  };
  return d;
}
