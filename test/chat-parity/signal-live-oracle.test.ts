/**
 * The Signal Desktop oracle (signal-desktop-oracle.ts) and the live runner's guardrails (scripts/parity-signal.ts),
 * offline: synthetic Signal Desktop databases with Desktop's own tables and columns, plain and sealed with SQLCipher 4
 * as Desktop seals them; the real Signal extractor against the fake signal-cli (extractors/signal/test) for the same
 * world; and bugs planted in the extractor's events, each of which the diff must name. Nothing reaches a network.
 *
 * People: self 5f2c7a8e-…-0001, Alice a11ce000-…-0002 (the fake's), Sam 5a3e0000-…-0003.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { constants, Database } from 'bun:sqlite';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { type AdapterHost, SignalAdapter } from '../../extractors/signal/src/adapter.ts';
import { dmId, msgId } from '../../extractors/signal/src/mapping.ts';
import { checkTargetViews, validateSignalTargetAccounts } from '../../scripts/parity-signal.ts';
import { diffConversationStates, EventFolder, type Mismatch, type NormalizedConversationState } from './harness.ts';
import { DesktopProfileReader, desktopKey, findDesktopProfile, NotSignalDesktop, readSignalDesktopState, SQLCIPHER_RESERVE, sqlcipherMacKey, sqlcipherPageMac, WrongKey } from './signal-desktop-oracle.ts';

const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';
const ACTORS = { actorA: SELF, actorB: ALICE };
const KEY = Buffer.alloc(32, 0x5a);

const dir = mkdtempSync(join(tmpdir(), 'parity-sigdesk-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------- a Signal Desktop database, made up

type Row = Record<string, unknown>;
interface DRow {
  id: string;
  conv: string;
  type: 'incoming' | 'outgoing' | 'pinned-message-notification' | 'keychange';
  at: number;
  from?: string;
  body?: string;
  json?: Row;
  isErased?: 1;
}
interface DSpec {
  rows: DRow[];
  edited?: { messageId: string; sentAt: number }[];
  atts?: { messageId: string; editHistoryIndex: number; contentType: string; order: number }[];
  pins?: { conv: string; messageId: string; pinnedAt: number; expiresAt?: number }[];
  linked?: boolean;
}

/** Desktop 8.x's tables, the columns this reads by their real names (and some it does not, as they are). */
const SCHEMA = [
  'CREATE TABLE items(id STRING PRIMARY KEY ASC, json TEXT)',
  'CREATE TABLE conversations(id STRING PRIMARY KEY ASC, json TEXT, active_at INTEGER, type STRING, members TEXT, name TEXT, profileName TEXT, profileFamilyName TEXT, profileFullName TEXT, e164 TEXT, serviceId TEXT, groupId TEXT, profileLastFetchedAt INTEGER)',
  'CREATE TABLE messages(id STRING PRIMARY KEY ASC, json TEXT, readStatus INTEGER, expires_at INTEGER, sent_at INTEGER, schemaVersion INTEGER, conversationId STRING, received_at INTEGER, source STRING, hasAttachments INTEGER, hasFileAttachments INTEGER, hasVisualMediaAttachments INTEGER, expireTimer INTEGER, expirationStartTimestamp INTEGER, type STRING, body TEXT, isErased INTEGER, isViewOnce INTEGER, sourceServiceId TEXT, serverGuid STRING, sourceDevice INTEGER, storyId STRING, isStory INTEGER, mentionsMe INTEGER NOT NULL DEFAULT 0, seenStatus NUMBER default 0)',
  'CREATE TABLE edited_messages(fromId STRING, messageId STRING REFERENCES messages(id) ON DELETE CASCADE, sentAt INTEGER, readStatus INTEGER, conversationId STRING)',
  'CREATE TABLE message_attachments(messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, editHistoryIndex INTEGER NOT NULL, attachmentType TEXT NOT NULL, orderInMessage INTEGER NOT NULL, conversationId TEXT NOT NULL, sentAt INTEGER NOT NULL, size INTEGER NOT NULL, contentType TEXT NOT NULL, path TEXT, fileName TEXT, PRIMARY KEY (messageId, editHistoryIndex, attachmentType, orderInMessage))',
  'CREATE TABLE pinnedMessages(id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, pinnedAt INTEGER NOT NULL, expiresAt INTEGER, UNIQUE (conversationId, messageId)) STRICT',
];

/** A database at `path`; with `reserve`, every page keeps SQLCipher's 80 bytes free, ready to be sealed. */
function writeDesktopDb(path: string, s: DSpec, reserve = false) {
  rmSync(path, { force: true });
  const db = new Database(path, { create: true });
  if (reserve) db.fileControl(constants.SQLITE_FCNTL_RESERVE_BYTES, SQLCIPHER_RESERVE);
  db.exec('PRAGMA page_size = 4096');
  for (const q of SCHEMA) db.exec(q);
  if (s.linked !== false) db.query('INSERT INTO items VALUES (?, ?)').run('uuid_id', JSON.stringify({ id: 'uuid_id', value: `${SELF}.2` }));
  const conv = db.query('INSERT INTO conversations (id, json, type, serviceId, groupId) VALUES (?, ?, ?, ?, ?)');
  conv.run('c-self', JSON.stringify({ id: 'c-self', type: 'private', serviceId: SELF }), 'private', SELF, null);
  conv.run('c-alice', JSON.stringify({ id: 'c-alice', type: 'private', serviceId: ALICE, profileName: 'Alice' }), 'private', ALICE, null);
  conv.run('c-sam', JSON.stringify({ id: 'c-sam', type: 'private', serviceId: SAM }), 'private', SAM, null);
  const msg = db.query('INSERT INTO messages (id, json, sent_at, received_at, conversationId, type, body, isErased, sourceServiceId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of s.rows) {
    const j = { id: r.id, conversationId: r.conv, type: r.type, sent_at: r.at, timestamp: r.at, ...(r.body !== undefined ? { body: r.body } : {}), ...(r.from ? { sourceServiceId: r.from } : {}), ...r.json };
    msg.run(r.id, JSON.stringify(j), r.at, r.at + 5, r.conv, r.type, r.body ?? null, r.isErased ?? 0, r.type === 'incoming' ? (r.from ?? null) : r.type === 'outgoing' ? null : (r.from ?? null));
  }
  for (const e of s.edited ?? []) db.query('INSERT INTO edited_messages (fromId, messageId, sentAt, readStatus) VALUES (?, ?, ?, 0)').run('c-alice', e.messageId, e.sentAt);
  for (const a of s.atts ?? []) db.query("INSERT INTO message_attachments VALUES (?, ?, 'attachment', ?, 'c-alice', 0, 10, ?, NULL, 'a.png')").run(a.messageId, a.editHistoryIndex, a.order, a.contentType);
  for (const p of s.pins ?? []) db.query('INSERT INTO pinnedMessages (conversationId, messageId, pinnedAt, expiresAt) VALUES (?, ?, ?, ?)').run(p.conv, p.messageId, p.pinnedAt, p.expiresAt ?? null);
  if (reserve) db.exec('VACUUM');
  db.close();
}

/** Seal a plain database (made with `reserve`) as SQLCipher 4 does under a raw key: the inverse of the oracle's reader. */
function sealSqlcipher(plainPath: string, key: Buffer, outPath: string) {
  const plain = readFileSync(plainPath);
  const pageSize = plain.readUInt16BE(16) === 1 ? 65536 : plain.readUInt16BE(16);
  if (plain[20] !== SQLCIPHER_RESERVE) throw new Error('made without the reserved bytes');
  const salt = randomBytes(16);
  const macKey = sqlcipherMacKey(key, salt);
  const out = Buffer.alloc(plain.length);
  for (let pgno = 1; pgno * pageSize <= plain.length; pgno++) {
    const off = (pgno - 1) * pageSize;
    const start = pgno === 1 ? 16 : 0;
    const end = pageSize - SQLCIPHER_RESERVE;
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', key, iv);
    c.setAutoPadding(false);
    const page = Buffer.alloc(pageSize);
    if (pgno === 1) salt.copy(page, 0);
    Buffer.concat([c.update(plain.subarray(off + start, off + end)), c.final()]).copy(page, start);
    iv.copy(page, end);
    sqlcipherPageMac(macKey, page, pgno, pageSize).copy(page, pageSize - 64);
    page.copy(out, off);
  }
  writeFileSync(outPath, out);
}

/** A key as Electron's safeStorage keeps it with --password-store=basic ("v10"). */
function wrapBasicText(text: string): string {
  const key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(text, 'latin1'), c.final()]).toString('hex');
}

// ---------------------------------------------------------------- the reader, on a made-up conversation

const T = 1_760_000_000_000;
const id = (author: string, at: number) => msgId(author, at);

/** One of each: an edit, three edits with reactions on the newest, a reply through an edit, a delete, a pin. */
function worldSpec(): DSpec {
  const versions = (bodies: string[], ats: number[]) => ({ editHistory: bodies.map((body, i) => ({ body, timestamp: ats[i] })).reverse(), editMessageTimestamp: ats.at(-1) });
  return {
    rows: [
      { id: 'r-old', conv: 'c-alice', type: 'incoming', at: T - 10_000, from: ALICE, body: 'before the window' },
      { id: 'r-hello', conv: 'c-alice', type: 'incoming', at: T, from: ALICE, body: 'hello' },
      { id: 'r-once', conv: 'c-alice', type: 'incoming', at: T + 1, from: ALICE, body: 'edited once', json: versions(['first', 'edited once'], [T + 1, T + 2]) },
      {
        id: 'r-thrice',
        conv: 'c-alice',
        type: 'incoming',
        at: T + 3,
        from: ALICE,
        body: 'edited three times',
        json: {
          ...versions(['v0', 'v1', 'v2', 'edited three times'], [T + 3, T + 4, T + 5, T + 6]),
          reactions: [
            { emoji: '👍', fromId: 'c-self', targetAuthorAci: ALICE, targetTimestamp: T + 6, timestamp: T + 7 },
            { emoji: '🎉', fromId: 'c-alice', targetAuthorAci: ALICE, targetTimestamp: T + 6, timestamp: T + 8 },
          ],
        },
      },
      // A version of r-thrice kept as a row of its own: the same message, not one more.
      { id: 'r-stray', conv: 'c-alice', type: 'incoming', at: T + 5, from: ALICE, body: 'v2' },
      // Quoting the edited message by its newest version, as Signal's apps do.
      { id: 'r-reply', conv: 'c-alice', type: 'incoming', at: T + 9, from: ALICE, body: 'about that edit', json: { quote: { id: T + 2, authorAci: ALICE, text: 'edited once' } } },
      { id: 'r-mine', conv: 'c-alice', type: 'outgoing', at: T + 10, body: 'mine, bold', json: { bodyRanges: [{ start: 6, length: 4, style: 1 }], quote: { id: T + 4, authorAci: ALICE, text: 'v1' } } },
      { id: 'r-gone', conv: 'c-alice', type: 'incoming', at: T + 11, from: ALICE, body: '', isErased: 1, json: { deletedForEveryone: true } },
      { id: 'r-pin', conv: 'c-alice', type: 'incoming', at: T + 12, from: ALICE, body: 'pin me' },
      { id: 'r-pinline', conv: 'c-alice', type: 'pinned-message-notification', at: T + 13, from: ALICE, json: { pinMessage: { targetAuthorAci: ALICE, targetSentTimestamp: T + 12 } } },
      { id: 'r-was-pinned', conv: 'c-alice', type: 'incoming', at: T + 14, from: ALICE, body: 'a pin that ran out' },
      { id: 'r-file', conv: 'c-alice', type: 'incoming', at: T + 15, from: ALICE, body: 'a picture' },
      { id: 'r-safety', conv: 'c-alice', type: 'keychange', at: T + 16 },
      { id: 'r-sam', conv: 'c-sam', type: 'incoming', at: T + 17, from: SAM, body: 'another chat' },
    ],
    edited: [
      { messageId: 'r-once', sentAt: T + 2 },
      { messageId: 'r-thrice', sentAt: T + 4 },
      { messageId: 'r-thrice', sentAt: T + 5 },
      { messageId: 'r-thrice', sentAt: T + 6 },
    ],
    atts: [
      { messageId: 'r-file', editHistoryIndex: -1, contentType: 'image/png', order: 0 },
      { messageId: 'r-file', editHistoryIndex: 0, contentType: 'video/mp4', order: 0 },
    ],
    pins: [
      { conv: 'c-alice', messageId: 'r-pin', pinnedAt: T + 13 },
      { conv: 'c-alice', messageId: 'r-was-pinned', pinnedAt: T + 14, expiresAt: T + 20 },
    ],
  };
}

const msg = (m: Partial<NormalizedConversationState['messages'][string]> & { id: string; author: string; body: string }) => ({ edited: false, replyTo: null, reactionsByAuthor: {}, pinned: false, attachments: [], ...m });

const EXPECTED: NormalizedConversationState = {
  messages: {
    [id(ALICE, T)]: msg({ id: id(ALICE, T), author: 'B', body: 'hello' }),
    [id(ALICE, T + 1)]: msg({ id: id(ALICE, T + 1), author: 'B', body: 'edited once', edited: true }),
    [id(ALICE, T + 3)]: msg({ id: id(ALICE, T + 3), author: 'B', body: 'edited three times', edited: true, reactionsByAuthor: { A: ['👍'], B: ['🎉'] } }),
    [id(ALICE, T + 9)]: msg({ id: id(ALICE, T + 9), author: 'B', body: 'about that edit', replyTo: id(ALICE, T + 1) }),
    [id(SELF, T + 10)]: msg({ id: id(SELF, T + 10), author: 'A', body: 'mine, **bold**', replyTo: id(ALICE, T + 3) }),
    [id(ALICE, T + 12)]: msg({ id: id(ALICE, T + 12), author: 'B', body: 'pin me', pinned: true }),
    [id(ALICE, T + 14)]: msg({ id: id(ALICE, T + 14), author: 'B', body: 'a pin that ran out' }),
    [id(ALICE, T + 15)]: msg({ id: id(ALICE, T + 15), author: 'B', body: 'a picture', attachments: ['image'] }),
  },
  deleted: [id(ALICE, T + 11)],
};

describe('Signal Desktop oracle: reading a database', () => {
  const plain = join(dir, 'world.sqlite');
  beforeAll(() => writeDesktopDb(plain, worldSpec()));

  test('edits, reactions on the newest version, replies through edits, a delete and pins come out as Signal holds them', () => {
    expect(readSignalDesktopState(plain, { conversation: { peer: ALICE }, actors: ACTORS, since: T, now: T + 100 })).toEqual(EXPECTED);
  });

  test('the window, the conversation and the linked account are honoured', () => {
    const all = readSignalDesktopState(plain, { conversation: { peer: ALICE }, actors: ACTORS, now: T + 100 });
    expect(Object.keys(all.messages)).toContain(id(ALICE, T - 10_000));
    const late = readSignalDesktopState(plain, { conversation: { peer: ALICE }, actors: ACTORS, since: T + 9, until: T + 10, now: T + 100 });
    expect(Object.keys(late.messages).sort()).toEqual([id(ALICE, T + 9), id(SELF, T + 10)].sort());
    expect(Object.keys(readSignalDesktopState(plain, { conversation: { peer: SAM }, actors: ACTORS }).messages)).toEqual([id(SAM, T + 17)]);
    expect(() => readSignalDesktopState(plain, { conversation: { peer: '00000000-0000-4000-8000-000000000009' }, actors: ACTORS })).toThrow(NotSignalDesktop);
    expect(() => readSignalDesktopState(plain, { conversation: { peer: ALICE }, actors: ACTORS, self: SAM })).toThrow(/linked to another account/);
    const unlinked = join(dir, 'unlinked.sqlite');
    writeDesktopDb(unlinked, { ...worldSpec(), linked: false });
    expect(() => readSignalDesktopState(unlinked, { conversation: { peer: ALICE }, actors: ACTORS })).toThrow(/not linked/);
    expect(readSignalDesktopState(unlinked, { conversation: { peer: ALICE }, actors: ACTORS, self: SELF, since: T, now: T + 100 })).toEqual(EXPECTED);
  });

  test('without edited_messages, quotes still resolve through editHistory', () => {
    const p = join(dir, 'no-edited-table.sqlite');
    writeDesktopDb(p, { ...worldSpec(), edited: [] });
    expect(readSignalDesktopState(p, { conversation: { peer: ALICE }, actors: ACTORS, since: T, now: T + 100 })).toEqual(EXPECTED);
  });
});

describe('Signal Desktop oracle: a sealed profile, read without touching it', () => {
  const profile = join(dir, 'profile');
  const db = join(profile, 'sql', 'db.sqlite');
  beforeAll(() => {
    mkdirSync(join(profile, 'sql'), { recursive: true });
    const plain = join(dir, 'to-seal.sqlite');
    writeDesktopDb(plain, worldSpec(), true);
    sealSqlcipher(plain, KEY, db);
    writeFileSync(join(profile, 'config.json'), JSON.stringify({ encryptedKey: wrapBasicText(KEY.toString('hex')), safeStorageBackend: 'basic_text' }));
  });

  test('the key from config.json (plain or basic_text), and a keyring-wrapped one told apart', () => {
    expect(desktopKey(profile)).toEqual({ key: KEY });
    const other = join(dir, 'keys');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'config.json'), JSON.stringify({ key: KEY.toString('hex') }));
    expect(desktopKey(other)).toEqual({ key: KEY });
    writeFileSync(join(other, 'config.json'), JSON.stringify({ encryptedKey: '763131' + 'ab'.repeat(80) }));
    expect(desktopKey(other)).toEqual({ missing: 'keyring' });
  });

  test('decrypts a copy and reads the same state; the profile is left exactly as it was', () => {
    const before = { bytes: readFileSync(db), mtime: statSync(db).mtimeMs, files: readFileSync(join(profile, 'config.json')) };
    const r = new DesktopProfileReader({ profile, workDir: join(dir, 'work') });
    expect(r.state({ conversation: { peer: ALICE }, actors: ACTORS, since: T, now: T + 100 })).toEqual(EXPECTED);
    expect(readFileSync(db).equals(before.bytes)).toBe(true);
    expect(statSync(db).mtimeMs).toBe(before.mtime);
    expect(readFileSync(join(profile, 'config.json')).equals(before.files)).toBe(true);
  });

  test("the profile is found from the account's directory, its sandbox's home, or itself", () => {
    const acct = join(dir, 'acct');
    const inSandbox = join(acct, 'desktop', 'home', '.config', 'Signal');
    mkdirSync(join(inSandbox, 'sql'), { recursive: true });
    writeFileSync(join(inSandbox, 'sql', 'db.sqlite'), '');
    expect(findDesktopProfile(acct)).toBe(inSandbox);
    expect(findDesktopProfile(join(acct, 'desktop', 'home'))).toBe(inSandbox);
    expect(findDesktopProfile(inSandbox)).toBe(inSandbox);
    expect(findDesktopProfile(join(dir, 'nowhere'))).toBeNull();
    expect(() => new DesktopProfileReader({ profile: join(dir, 'nowhere'), workDir: join(dir, 'w') })).toThrow(NotSignalDesktop);
  });

  test('a wrong key is told apart', () => {
    const r = new DesktopProfileReader({ profile, workDir: join(dir, 'work-wrong'), key: Buffer.alloc(32, 1) });
    expect(() => r.snapshot()).toThrow(WrongKey);
  });

  test('changed() resolves once Desktop writes, and the next read sees what it wrote', async () => {
    const r = new DesktopProfileReader({ profile, workDir: join(dir, 'work-change') });
    expect(Object.keys(r.state({ conversation: { peer: ALICE }, actors: ACTORS, since: T }).messages)).not.toContain(id(ALICE, T + 30));
    const w = r.changed(10);
    const plain = join(dir, 'to-seal-2.sqlite');
    const spec = worldSpec();
    spec.rows.push({ id: 'r-new', conv: 'c-alice', type: 'incoming', at: T + 30, from: ALICE, body: 'written while reading' });
    writeDesktopDb(plain, spec, true);
    sealSqlcipher(plain, KEY, db + '.next');
    writeFileSync(db, readFileSync(db + '.next'));
    rmSync(db + '.next');
    await w.promise;
    expect(r.state({ conversation: { peer: ALICE }, actors: ACTORS, since: T }).messages[id(ALICE, T + 30)]?.body).toBe('written while reading');
  });
});

// ---------------------------------------------------------------- against the real extractor

const FAKE = join(import.meta.dir, '../../extractors/signal/test/fake-signal-cli.ts');
const SELF_NUMBER = '+15550100';
const ALICE_NUMBER = '+15550137';
const DM = dmId(SELF, ALICE);

/** The Signal extractor in process against the fake signal-cli, Alice's phone pushing envelopes to it. */
async function startExtractor() {
  const root = mkdtempSync(join(dir, 'ext-'));
  const signalDir = join(root, 'signal-cli');
  mkdirSync(join(signalDir, 'data'), { recursive: true });
  writeFileSync(join(signalDir, 'data', 'accounts.json'), JSON.stringify({ accounts: [{ path: '123456', environment: 'LIVE', number: SELF_NUMBER, uuid: SELF }], version: 2 }));
  writeFileSync(join(signalDir, 'data', '123456'), JSON.stringify({ version: 9, deviceId: 2 }));
  const folder = new EventFolder('signal');
  const notices = new Set<string>();
  let online = false;
  let secret: Record<string, unknown> = {};
  const host: AdapterHost = {
    emit: (e) => {
      if (e.t === 'status' && e.status === 'online') online = true;
      if (e.t === 'message' && e.message.kind === 'system') notices.add(e.message.nativeId);
      folder.apply(e);
    },
    log: () => {},
    accountDir: root,
    config: {},
    secret: () => secret,
    saveSecret: (v) => void (secret = v as Record<string, unknown>),
  };
  const adapter = new SignalAdapter(host, {
    signalCli: async () => [process.execPath, FAKE],
    restartBackoffMs: [100, 200],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    daemonHealthEveryMs: 3_600_000,
    devicesEveryMs: 3_600_000,
  });
  await adapter.start();
  while (!online) await folder.changed();
  let pushes = 0;
  const pushDir = join(signalDir, 'fake-push');
  const fromAlice = (ts: number, content: Record<string, unknown>) => {
    mkdirSync(pushDir, { recursive: true });
    const tmp = join(root, `push-${pushes}.json`);
    writeFileSync(tmp, JSON.stringify({ account: SELF_NUMBER, envelope: { source: ALICE_NUMBER, sourceNumber: ALICE_NUMBER, sourceUuid: ALICE, sourceName: 'Alice Chen', sourceDevice: 1, timestamp: ts, serverReceivedTimestamp: ts + 1, serverDeliveredTimestamp: ts + 2, ...content } }));
    // Whole, or not at all: the fake picks up any file it sees there.
    renameSync(tmp, join(pushDir, `${String(pushes++).padStart(5, '0')}.json`));
  };
  const cmd = (c: Record<string, unknown>) => adapter.command({ id: 'x', ...c } as P.AdapterCommand);
  return {
    folder,
    notices,
    fromAlice,
    cmd,
    stop: async () => {
      await adapter.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const data = (ts: number, rest: Record<string, unknown>) => ({ timestamp: ts, message: null, expiresInSeconds: 0, isExpirationUpdate: false, viewOnce: false, isEndSession: false, isProfileKeyUpdate: false, hasProfileKey: true, ...rest });
const target = (author: string, ts: number) => ({ targetAuthor: author === ALICE ? ALICE_NUMBER : SELF_NUMBER, targetAuthorNumber: author === ALICE ? ALICE_NUMBER : SELF_NUMBER, targetAuthorUuid: author, targetSentTimestamp: ts });

describe('Signal Desktop oracle: the extractor agrees with it, and every planted bug is named', () => {
  let ex: Awaited<ReturnType<typeof startExtractor>>;
  let desktop: NormalizedConversationState;
  let t0 = 0;
  let mine = 0;
  let myReply = 0;

  const extractorState = (f: EventFolder) => {
    const s = f.state(ACTORS, DM);
    for (const n of ex.notices) delete s.messages[n];
    return s;
  };
  /** The extractor's events again, through a change, as a hub would have folded them. */
  const refold = (change: (e: P.AdapterEvent) => P.AdapterEvent[]) => {
    const f = new EventFolder('signal');
    for (const e of ex.folder.events) for (const x of change(e)) f.apply(x);
    return extractorState(f);
  };
  const kinds = (m: Mismatch[]) => m.map((x) => `${x.kind} ${x.id}`).sort();

  beforeAll(async () => {
    ex = await startExtractor();
    const f = ex.folder;
    const at = (n: number) => t0 + n;
    t0 = Date.now() - 60_000;
    const nextMessage = (nativeId: string, body?: string) => f.next((e) => e.t === 'message' && e.message.nativeId === nativeId && (body === undefined || e.message.body === body));
    const alice = async (n: number, content: Record<string, unknown>, wait: (e: P.AdapterEvent) => boolean) => {
      const from = f.events.length;
      ex.fromAlice(at(n), content);
      await f.next(wait, from);
    };
    const isMsg = (nativeId: string, body: string) => (e: P.AdapterEvent) => e.t === 'message' && e.message.nativeId === nativeId && e.message.body === body;

    await alice(0, { dataMessage: data(at(0), { message: 'hello' }) }, isMsg(id(ALICE, at(0)), 'hello'));
    // Edited once.
    await alice(1, { dataMessage: data(at(1), { message: 'first' }) }, isMsg(id(ALICE, at(1)), 'first'));
    await alice(2, { editMessage: { targetSentTimestamp: at(1), dataMessage: data(at(2), { message: 'edited once' }) } }, isMsg(id(ALICE, at(1)), 'edited once'));
    // Edited three times, each edit naming the one before; then a reaction from each side on the newest version.
    await alice(3, { dataMessage: data(at(3), { message: 'v0' }) }, isMsg(id(ALICE, at(3)), 'v0'));
    for (const [n, body] of [[4, 'v1'], [5, 'v2'], [6, 'edited three times']] as const)
      await alice(n, { editMessage: { targetSentTimestamp: at(n - 1), dataMessage: data(at(n), { message: body }) } }, isMsg(id(ALICE, at(3)), body));
    await ex.cmd({ t: 'react', conversation: DM, message: id(ALICE, at(3)), key: '👍' });
    await alice(8, { dataMessage: data(at(8), { reaction: { emoji: '🎉', ...target(ALICE, at(6)), isRemove: false } }) }, (e) => e.t === 'reaction' && e.author === ALICE);
    // Alice answers the message edited once, quoting its newest version; you answer the one edited three times.
    await alice(9, { dataMessage: data(at(9), { message: 'about that edit', quote: { id: at(2), author: ALICE_NUMBER, authorNumber: ALICE_NUMBER, authorUuid: ALICE, text: 'edited once', attachments: [] } }) }, isMsg(id(ALICE, at(9)), 'about that edit'));
    myReply = Number(((await ex.cmd({ t: 'send', conversation: DM, body: 'mine', replyTo: id(ALICE, at(3)) })) as { nativeId: string }).nativeId.split(':').pop());
    // Deleted for everyone.
    await alice(11, { dataMessage: data(at(11), { message: 'soon gone' }) }, isMsg(id(ALICE, at(11)), 'soon gone'));
    await alice(12, { dataMessage: data(at(12), { remoteDelete: { timestamp: at(11) } }) }, (e) => e.t === 'delete');
    // Pinned.
    await alice(13, { dataMessage: data(at(13), { message: 'pin me' }) }, isMsg(id(ALICE, at(13)), 'pin me'));
    await alice(14, { dataMessage: data(at(14), { pinMessage: { ...target(ALICE, at(13)), pinDurationSeconds: -1 } }) }, (e) => e.t === 'pin');
    // Yours, with Alice's reaction.
    mine = Number(((await ex.cmd({ t: 'send', conversation: DM, body: 'from me' })) as { nativeId: string }).nativeId.split(':').pop());
    await alice(16, { dataMessage: data(at(16), { reaction: { emoji: '❤️', ...target(SELF, mine), isRemove: false } }) }, (e) => e.t === 'reaction' && e.author === ALICE && e.message === id(SELF, mine));
    await nextMessage(id(SELF, mine));

    // The same world as Desktop, linked to the same account, holds it.
    const versions = (bodies: string[], ns: number[]) => ({ editHistory: bodies.map((body, i) => ({ body, timestamp: at(ns[i]!) })).reverse(), editMessageTimestamp: at(ns.at(-1)!) });
    const plain = join(dir, 'extractor-world.sqlite');
    writeDesktopDb(plain, {
      rows: [
        { id: 'w0', conv: 'c-alice', type: 'incoming', at: at(0), from: ALICE, body: 'hello' },
        { id: 'w1', conv: 'c-alice', type: 'incoming', at: at(1), from: ALICE, body: 'edited once', json: versions(['first', 'edited once'], [1, 2]) },
        {
          id: 'w3',
          conv: 'c-alice',
          type: 'incoming',
          at: at(3),
          from: ALICE,
          body: 'edited three times',
          json: { ...versions(['v0', 'v1', 'v2', 'edited three times'], [3, 4, 5, 6]), reactions: [{ emoji: '👍', fromId: 'c-self', targetAuthorAci: ALICE, targetTimestamp: at(6) }, { emoji: '🎉', fromId: 'c-alice', targetAuthorAci: ALICE, targetTimestamp: at(6) }] },
        },
        { id: 'w9', conv: 'c-alice', type: 'incoming', at: at(9), from: ALICE, body: 'about that edit', json: { quote: { id: at(2), authorAci: ALICE, text: 'edited once' } } },
        { id: 'wr', conv: 'c-alice', type: 'outgoing', at: myReply, body: 'mine', json: { quote: { id: at(6), authorAci: ALICE, text: 'edited three times' } } },
        { id: 'w11', conv: 'c-alice', type: 'incoming', at: at(11), from: ALICE, body: '', isErased: 1, json: { deletedForEveryone: true } },
        { id: 'w13', conv: 'c-alice', type: 'incoming', at: at(13), from: ALICE, body: 'pin me' },
        { id: 'w14', conv: 'c-alice', type: 'pinned-message-notification', at: at(14), from: ALICE },
        { id: 'wm', conv: 'c-alice', type: 'outgoing', at: mine, body: 'from me', json: { reactions: [{ emoji: '❤️', fromId: 'c-alice', targetAuthorAci: SELF, targetTimestamp: mine }] } },
      ],
      edited: [2, 4, 5, 6].map((n) => ({ messageId: n === 2 ? 'w1' : 'w3', sentAt: at(n) })),
      pins: [{ conv: 'c-alice', messageId: 'w13', pinnedAt: at(14) }],
    });
    desktop = readSignalDesktopState(plain, { conversation: { peer: ALICE }, actors: ACTORS, since: t0 });
  }, 60_000);
  afterAll(async () => {
    await ex?.stop();
  });

  test('no difference', () => {
    expect(Object.keys(desktop.messages)).toHaveLength(7);
    expect(diffConversationStates(extractorState(ex.folder), desktop)).toEqual([]);
  });

  test('an edit arriving as a message of its own', () => {
    const edit = id(ALICE, t0 + 2);
    const s = refold((e) => (e.t === 'message' && e.message.nativeId === id(ALICE, t0 + 1) && e.message.body === 'edited once' ? [e, { ...e, message: { ...e.message, nativeId: edit, ts: t0 + 2, editedTs: undefined } }] : [e]));
    const d = diffConversationStates(s, desktop);
    expect(kinds(d)).toEqual([`extra message ${edit}`]);
    expect(d[0]!.detail).toContain(`a duplicate of ${id(ALICE, t0 + 1)}`);
  });

  test('a reaction dropped', () => {
    const s = refold((e) => (e.t === 'reaction' && e.author === ALICE && e.key === '🎉' ? [] : [e]));
    expect(kinds(diffConversationStates(s, desktop))).toEqual([`missing reaction ${id(ALICE, t0 + 3)}`]);
  });

  test("a reply whose parent never reached the hub, and one pointing at the parent's edit", () => {
    const parent = id(ALICE, t0 + 1);
    const reply = id(ALICE, t0 + 9);
    const dangling = refold((e) => (e.t === 'message' && e.message.nativeId === parent ? [] : [e]));
    expect(kinds(diffConversationStates(dangling, desktop))).toEqual([`dangling replyTo ${reply}`, `missing message ${parent}`]);
    const drifted = refold((e) => (e.t === 'message' && e.message.nativeId === reply ? [{ ...e, message: { ...e.message, replyTo: id(ALICE, t0 + 2) } }] : [e]));
    expect(kinds(diffConversationStates(drifted, desktop))).toEqual([`replyTo ${reply}`]);
  });

  test('a delete and a pin that never landed', () => {
    expect(kinds(diffConversationStates(refold((e) => (e.t === 'delete' ? [] : [e])), desktop))).toEqual([`missed delete ${id(ALICE, t0 + 11)}`]);
    expect(kinds(diffConversationStates(refold((e) => (e.t === 'pin' ? [] : [e])), desktop))).toEqual([`pinned ${id(ALICE, t0 + 13)}`]);
  });
});

// ---------------------------------------------------------------- the live runner's guardrails

describe('scripts/parity-signal.ts guardrails', () => {
  const ok = { account: 'acc_throwaway01', confirmThrowaway: true };

  test('an account is always named, and confirmed as a throwaway', () => {
    expect(validateSignalTargetAccounts({ desktopDir: '/x', confirmThrowaway: true })).toMatchObject({ ok: false, errors: [expect.stringContaining('--account is required')] });
    expect(validateSignalTargetAccounts({ account: 'acc_throwaway01', desktopDir: '/x' })).toMatchObject({ ok: false, errors: [expect.stringContaining('--confirm-throwaway')] });
    expect(validateSignalTargetAccounts({ account: 'acc with spaces', desktopDir: '/x', confirmThrowaway: true }).ok).toBe(false);
  });

  test('two-party mode needs two different accounts', () => {
    expect(validateSignalTargetAccounts({ ...ok, peerAccount: 'acc_throwaway01' })).toMatchObject({ ok: false, errors: [expect.stringContaining('the same account')] });
    expect(validateSignalTargetAccounts({ ...ok, peerAccount: '' }).ok).toBe(false);
    expect(validateSignalTargetAccounts({ ...ok, peerAccount: 'acc_throwaway02' })).toEqual({ ok: true, mode: 'two-party', account: 'acc_throwaway01', peerAccount: 'acc_throwaway02' });
    expect(validateSignalTargetAccounts({ ...ok, peerAccount: 'acc_throwaway02', desktopDir: '/d' })).toMatchObject({ ok: true, mode: 'two-party', desktopDir: '/d' });
  });

  test('Note to Self needs the linked Desktop, and says how to give it', () => {
    const r = validateSignalTargetAccounts(ok);
    expect(r).toMatchObject({ ok: false, guide: expect.stringContaining('--desktop-dir') });
    expect(validateSignalTargetAccounts({ ...ok, desktopDir: '/d' })).toEqual({ ok: true, mode: 'note-to-self', account: 'acc_throwaway01', desktopDir: '/d' });
  });

  test('an allowlist, when set, refuses any other account', () => {
    expect(validateSignalTargetAccounts({ ...ok, desktopDir: '/d', allowlist: ['acc_throwaway01'] }).ok).toBe(true);
    expect(validateSignalTargetAccounts({ ...ok, peerAccount: 'acc_throwaway02', allowlist: ['acc_throwaway01'] })).toMatchObject({ ok: false, errors: [expect.stringContaining('acc_throwaway02 is not in')] });
  });

  test('the accounts must be signal, granted at manage, and not a dry run', () => {
    const v = (x: Partial<{ id: string; kind: string; dryRun: boolean; grants: Record<string, 'read' | 'write' | 'manage'> }>) => ({ id: 'acc_throwaway01', kind: 'signal', dryRun: false, grants: { chat: 'manage' as const }, ...x });
    expect(checkTargetViews([v({})], ['acc_throwaway01'])).toEqual([]);
    expect(checkTargetViews([], ['acc_throwaway01'])[0]).toContain('no such account');
    expect(checkTargetViews([v({ kind: 'discord' })], ['acc_throwaway01'])[0]).toContain('not signal');
    expect(checkTargetViews([v({ dryRun: true })], ['acc_throwaway01'])[0]).toContain('dry run');
    expect(checkTargetViews([v({ grants: { chat: 'write' } })], ['acc_throwaway01'])[0]).toContain('manage');
  });
});
