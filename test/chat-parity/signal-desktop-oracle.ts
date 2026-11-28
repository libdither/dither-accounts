/**
 * Signal Desktop as an oracle for Signal's composition parity (docs/signal.md "Live parity testing"): a Desktop linked
 * to the account under test keeps its own copy of every conversation, written by Signal's own code from what the
 * network sent it. Read independently of the extractor, it says what Signal holds after a chain of sends, edits,
 * reactions, replies, deletes and pins, as a NormalizedConversationState (harness.ts) to diff against the extractor's.
 *
 * The profile, as Signal Desktop 8.x lays it out (field names checked against its own migrations and against
 * dither-chat's Desktop importer, packages/hub/src/imports/signal-desktop.ts):
 *
 *   config.json             the database key: `key` (64 hex digits), or `encryptedKey` wrapped by Electron's
 *                           safeStorage ("v10": the basic_text store, which the extractor's sandbox uses)
 *   sql/db.sqlite (-wal)    SQLCipher 4 under that key
 *   conversations           id, type ('private' | 'group'), serviceId (an ACI), groupId, json
 *   messages                id, conversationId, type ('incoming' | 'outgoing' | notices), sent_at, sourceServiceId,
 *                           body, isErased, json: body, bodyRanges, quote {id, authorAci, text}, reactions
 *                           [{emoji, fromId (the reactor's conversation id), targetTimestamp, timestamp}],
 *                           editHistory [{timestamp, body, ...}, newest first, the original last],
 *                           editMessageTimestamp, deletedForEveryone, attachments (before message_attachments)
 *   edited_messages         messageId, sentAt: each edit's own timestamp, pointing at the message it edits
 *   message_attachments     messageId, editHistoryIndex (-1: the message as it is now), attachmentType, contentType
 *   pinnedMessages          conversationId, messageId, pinnedAt, expiresAt
 *
 * An edited message stays one row: `sent_at` is its first send (T0), `body` and `editMessageTimestamp` the newest
 * version's. Signal names the message by its newest version from then on, so a quote or reaction naming T1 or T2 is
 * resolved here to the message (`<author>:<T0>`, the extractor's id). A Desktop row that is itself a version of
 * another (should one ever appear) is folded into it, never counted as a message.
 *
 * Reading never touches the profile: sql/db.sqlite and its -wal are copied (opened read-only) into a work folder of
 * the caller's, and the copy is decrypted there. A copy taken while Desktop was writing does not authenticate; the
 * last good one is kept and the next change tried again.
 */
import { Database } from 'bun:sqlite';
import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fromSignal } from '../../extractors/signal/src/markdown.ts';
import { msgId } from '../../extractors/signal/src/mapping.ts';
import { type Handle, type NormalizedConversationState, normalize, type ParityDriver, type RawMessage } from './harness.ts';

type Row = Record<string, any>;

// ---------------------------------------------------------------- the key

/** A raw key as Signal Desktop keeps it: 64 hex digits, alone or as x'…'. */
export function parseRawKey(s: string): Buffer | null {
  const m = s.trim().match(/^(?:x')?([0-9a-fA-F]{64})'?$/);
  return m ? Buffer.from(m[1]!, 'hex') : null;
}

/** Chromium's OSCrypt on Linux: "v10" is AES-128-CBC under PBKDF2("peanuts"); "v11" needs a keyring, tried empty. */
function unwrapSafeStorage(hex: string): string | null {
  const b = Buffer.from(hex, 'hex');
  const prefix = b.subarray(0, 3).toString('latin1');
  const passwords = prefix === 'v10' ? ['peanuts'] : prefix === 'v11' ? [''] : [];
  for (const pw of passwords) {
    try {
      const key = pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1');
      const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
      const s = Buffer.concat([d.update(b.subarray(3)), d.final()]).toString('latin1');
      if (parseRawKey(s)) return s;
    } catch {}
  }
  return null;
}

/** The database key from a profile's config.json, or why there is none. */
export function desktopKey(profile: string): { key: Buffer } | { missing: 'keyring' | 'config' } {
  let cfg: Row;
  try {
    cfg = JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8'));
  } catch {
    return { missing: 'config' };
  }
  const plain = typeof cfg.key === 'string' ? parseRawKey(cfg.key) : null;
  if (plain) return { key: plain };
  if (typeof cfg.encryptedKey === 'string' && /^[0-9a-f]+$/i.test(cfg.encryptedKey)) {
    const s = unwrapSafeStorage(cfg.encryptedKey);
    return s ? { key: parseRawKey(s)! } : { missing: 'keyring' };
  }
  return { missing: 'config' };
}

// ---------------------------------------------------------------- SQLCipher 4, without SQLCipher

/*
 * After dither-chat's packages/hub/src/imports/sqlcipher.ts. Each page: ciphertext ‖ IV (16) ‖ HMAC-SHA512 (64);
 * page 1 starts with the 16-byte salt. AES-256-CBC under the raw key; the HMAC covers ciphertext ‖ IV ‖ page number
 * (4 bytes LE) under PBKDF2-HMAC-SHA512(key, salt ^ 0x3a, 2 rounds). Committed WAL frames are applied over the file.
 */

export class WrongKey extends Error {
  constructor() {
    super('That key does not open this database.');
  }
}
/** A copy taken while Desktop was writing: a page does not authenticate. Taking it again later works. */
export class TornCopy extends Error {}

const SALT = 16;
const IV = 16;
const MAC = 64;
export const SQLCIPHER_RESERVE = IV + MAC;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const PAGE_SIZES = [4096, 1024, 2048, 8192, 16384, 32768, 65536];

interface Keys {
  key: Buffer;
  macKey: Buffer;
  pageSize: number;
}

export const sqlcipherMacKey = (key: Buffer, salt: Buffer) => pbkdf2Sync(key, Buffer.from(salt.map((b) => b ^ 0x3a)), 2, 32, 'sha512');

export function sqlcipherPageMac(macKey: Buffer, page: Buffer, pgno: number, pageSize: number): Buffer {
  const n = Buffer.alloc(4);
  n.writeUInt32LE(pgno, 0);
  return createHmac('sha512', macKey).update(page.subarray(pgno === 1 ? SALT : 0, pageSize - MAC)).update(n).digest();
}

function decryptPage(k: Keys, page: Buffer, pgno: number): Buffer {
  const start = pgno === 1 ? SALT : 0;
  const end = k.pageSize - SQLCIPHER_RESERVE;
  if (!timingSafeEqual(sqlcipherPageMac(k.macKey, page, pgno, k.pageSize), page.subarray(k.pageSize - MAC))) {
    if (pgno === 1) throw new WrongKey();
    throw new TornCopy(`page ${pgno} does not authenticate: the copy was taken while Signal Desktop was writing`);
  }
  const d = createDecipheriv('aes-256-cbc', k.key, page.subarray(end, end + IV));
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(page.subarray(start, end)), d.final()]);
  const out = Buffer.alloc(k.pageSize);
  if (pgno === 1) SQLITE_HEADER.copy(out, 0);
  plain.copy(out, start);
  if (pgno === 1) {
    // A rollback-journal database: the copy opens without -wal or -shm.
    out[18] = 1;
    out[19] = 1;
  }
  return out;
}

function readAt(fd: number, n: number, pos: number): Buffer {
  const b = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const r = readSync(fd, b, got, n - got, pos + got);
    if (r === 0) break;
    got += r;
  }
  return got === n ? b : b.subarray(0, got);
}

function keysFor(fd: number, key: Buffer): Keys {
  if (key.length !== 32) throw new Error('a database key is 32 bytes (64 hex digits)');
  const head = readAt(fd, 65536, 0);
  if (head.length < 1024) throw new TornCopy('this database is too short to be one');
  if (head.subarray(0, 16).equals(SQLITE_HEADER)) throw new Error('this database is not encrypted');
  const macKey = sqlcipherMacKey(key, head.subarray(0, SALT));
  for (const pageSize of PAGE_SIZES) {
    if (head.length < pageSize) continue;
    const k = { key, macKey, pageSize };
    if (timingSafeEqual(sqlcipherPageMac(macKey, head, 1, pageSize), head.subarray(pageSize - MAC, pageSize))) return k;
  }
  throw new WrongKey();
}

function walFrames(walPath: string, k: Keys): { frames: Map<number, number>; pages: number | null; fd: number | null } {
  const frames = new Map<number, number>();
  if (!existsSync(walPath)) return { frames, pages: null, fd: null };
  const fd = openSync(walPath, 'r');
  const size = fstatSync(fd).size;
  const head = readAt(fd, 32, 0);
  const magic = head.length === 32 ? head.readUInt32BE(0) : 0;
  if ((magic & 0xfffffffe) !== 0x377f0682 || head.readUInt32BE(8) !== k.pageSize) return (closeSync(fd), { frames, pages: null, fd: null });
  const big = (magic & 1) === 1;
  const word = (b: Buffer, i: number) => (big ? b.readUInt32BE(i) : b.readUInt32LE(i));
  const sum = (b: Buffer, s: [number, number]): [number, number] => {
    let [s0, s1] = s;
    for (let i = 0; i < b.length; i += 8) {
      s0 = (s0 + word(b, i) + s1) >>> 0;
      s1 = (s1 + word(b, i + 4) + s0) >>> 0;
    }
    return [s0, s1];
  };
  let s = sum(head.subarray(0, 24), [0, 0]);
  if (s[0] !== head.readUInt32BE(24) || s[1] !== head.readUInt32BE(28)) return (closeSync(fd), { frames, pages: null, fd: null });
  const salt1 = head.readUInt32BE(16);
  const salt2 = head.readUInt32BE(20);
  const frameSize = 24 + k.pageSize;
  let pending = new Map<number, number>();
  let pages: number | null = null;
  for (let off = 32; off + frameSize <= size; off += frameSize) {
    const f = readAt(fd, frameSize, off);
    if (f.readUInt32BE(8) !== salt1 || f.readUInt32BE(12) !== salt2) break;
    s = sum(f.subarray(24), sum(f.subarray(0, 8), s));
    if (s[0] !== f.readUInt32BE(16) || s[1] !== f.readUInt32BE(20)) break;
    pending.set(f.readUInt32BE(0), off + 24);
    const commit = f.readUInt32BE(4);
    if (commit) {
      for (const [p, at] of pending) frames.set(p, at);
      pending = new Map();
      pages = commit;
    }
  }
  return { frames, pages, fd };
}

/** Decrypt `dbPath` (and its -wal) into `outPath` (0600), put in place only when whole. */
export function decryptSqlcipher(dbPath: string, key: Buffer, outPath: string): { pageSize: number; pages: number } {
  const fd = openSync(dbPath, 'r');
  const tmp = outPath + '.tmp';
  let out: number | null = null;
  let wal: ReturnType<typeof walFrames> | null = null;
  try {
    const k = keysFor(fd, key);
    wal = walFrames(dbPath + '-wal', k);
    const pages = wal.pages ?? Math.floor(fstatSync(fd).size / k.pageSize);
    rmSync(tmp, { force: true });
    out = openSync(tmp, 'w', 0o600);
    for (let pgno = 1; pgno <= pages; pgno++) {
      const at = wal.frames.get(pgno);
      const page = at !== undefined ? readAt(wal.fd!, k.pageSize, at) : readAt(fd, k.pageSize, (pgno - 1) * k.pageSize);
      if (page.length < k.pageSize) throw new TornCopy(`page ${pgno} is missing: the copy is cut short`);
      const plain = decryptPage(k, page, pgno);
      for (let off = 0; off < plain.length; ) off += writeSync(out, plain, off, plain.length - off, (pgno - 1) * k.pageSize + off);
    }
    closeSync(out);
    out = null;
    renameSync(tmp, outPath);
    return { pageSize: k.pageSize, pages };
  } catch (e) {
    if (out !== null) closeSync(out);
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    closeSync(fd);
    if (wal?.fd != null) closeSync(wal.fd);
  }
}

// ---------------------------------------------------------------- the state

const ACI_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const aciText = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s) return null;
  const v = s.replace(/^ACI:/i, '').toLowerCase();
  return ACI_RE.test(v) ? v : null;
};
const json = (s: unknown): Row => {
  try {
    const v = JSON.parse(typeof s === 'string' ? s : '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** BodyRange.Style as Desktop stores it (the protobuf's numbers), as signal-cli names them. */
const STYLES: Record<number, string> = { 1: 'BOLD', 2: 'ITALIC', 3: 'SPOILER', 4: 'STRIKETHROUGH', 5: 'MONOSPACE' };

const kindOf = (mime: unknown) => {
  const m = String(mime ?? '').toLowerCase();
  return m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'file';
};

export interface DesktopStateOptions {
  /** The conversation: a person's ACI (the account's own for Note to Self), or a group's id (base64). */
  conversation: { peer: string } | { group: string };
  /** The two actors' ACIs, as the driver names them (`A` and `B` in the state). */
  actors: Pick<ParityDriver, 'actorA' | 'actorB'>;
  /** The ACI this Desktop is linked as. Default: its own record (items.uuid_id); one of the two is needed. */
  self?: string;
  /** Only messages first sent in [since, until] (sent_at), for a conversation that holds more than a test run. */
  since?: number;
  until?: number;
  /** For pins that run out (pinnedMessages.expiresAt). Default: now. */
  now?: number;
}

/** Why a conversation could not be read: no such table, chat or linked account. */
export class NotSignalDesktop extends Error {}

/**
 * One conversation of a plain (decrypted) Signal Desktop database, as Signal holds it: each message by its first
 * send's id, with its newest words, edited or not, the message it quotes (resolved through edits), each person's
 * reaction, pinned or not and its files; the deleted ones apart.
 */
export function readSignalDesktopState(dbPath: string, o: DesktopStateOptions): NormalizedConversationState {
  const db = new Database(dbPath, { readonly: true });
  try {
    const has = (t: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (!has('messages') || !has('conversations')) throw new NotSignalDesktop('this database has no messages or conversations: it is not Signal Desktop’s');
    const linked = has('items') ? aciText(String(json((db.query(`SELECT json FROM items WHERE id = 'uuid_id'`).get() as Row | null)?.json).value ?? '').replace(/\.\d+$/, '')) : null;
    // A Desktop linked to some other account (a real one) is not read any further: no conversation, no message.
    if (linked && o.self && aciText(o.self) !== linked) throw new NotSignalDesktop('this Signal Desktop is linked to another account than the one under test');
    const self = aciText(o.self) ?? linked;
    if (!self) throw new NotSignalDesktop('this Signal Desktop is not linked (no items.uuid_id), and no self ACI was given');

    // People by their conversation row (reactions name the reactor by it), and the conversation asked for.
    const aciOfConv = new Map<string, string>();
    let convId: string | null = null;
    for (const c of db.query('SELECT id, type, serviceId, groupId, json FROM conversations').all() as Row[]) {
      const j = json(c.json);
      if (c.type === 'private') {
        const aci = aciText(c.serviceId ?? j.serviceId);
        if (!aci) continue;
        aciOfConv.set(c.id, aci);
        if ('peer' in o.conversation && aci === o.conversation.peer.toLowerCase()) convId = c.id;
      } else if (c.type === 'group' && 'group' in o.conversation && (c.groupId ?? j.groupId) === o.conversation.group) convId = c.id;
    }
    if (!convId) throw new NotSignalDesktop(`this Signal Desktop has no such conversation (${'peer' in o.conversation ? 'a person' : 'a group'} it never heard from?)`);

    const rows = (db.query('SELECT * FROM messages WHERE conversationId = ? ORDER BY sent_at, id').all(convId) as Row[]).filter((r) => {
      const ts = Number(r.sent_at ?? 0);
      return (o.since === undefined || ts >= o.since) && (o.until === undefined || ts <= o.until);
    });

    type Msg = { row: Row; j: Row; id: Handle; author: string; ts: number };
    const msgs: Msg[] = [];
    for (const row of rows) {
      if (row.type !== 'incoming' && row.type !== 'outgoing') continue;
      const j = json(row.json);
      // Newer Desktops keep some fields (body, isErased, …) in their own columns only.
      for (const [k, v] of Object.entries(row)) if (k !== 'json' && j[k] === undefined && v !== null) j[k] = v;
      if (j.storyId && !j.storyReplyContext) continue;
      const author = row.type === 'outgoing' ? self : aciText(row.sourceServiceId ?? j.sourceServiceId);
      const ts = Number(row.sent_at ?? j.sent_at ?? 0);
      if (!author || !ts) continue;
      msgs.push({ row, j, id: msgId(author, ts), author, ts });
    }

    // Every version's timestamp, to the message it is a version of: its edit history, its newest edit, and
    // edited_messages (each edit's own sentAt, by the message's row id).
    const baseOf = new Map<Handle, Handle>();
    const byRow = new Map(msgs.map((m) => [m.row.id as string, m]));
    for (const m of msgs) {
      const versions = [Number(m.j.editMessageTimestamp ?? 0), ...(Array.isArray(m.j.editHistory) ? m.j.editHistory : []).map((e: Row) => Number(e?.timestamp ?? 0))];
      for (const v of versions) if (v && v !== m.ts) baseOf.set(msgId(m.author, v), m.id);
    }
    if (has('edited_messages'))
      for (const e of db.query('SELECT messageId, sentAt FROM edited_messages').all() as Row[]) {
        const m = byRow.get(e.messageId);
        if (m && Number(e.sentAt) && Number(e.sentAt) !== m.ts) baseOf.set(msgId(m.author, Number(e.sentAt)), m.id);
      }
    const resolve = (id: Handle) => baseOf.get(id) ?? id;

    const pinnedRows = new Set<string>();
    if (has('pinnedMessages')) {
      const now = o.now ?? Date.now();
      for (const p of db.query('SELECT messageId, expiresAt FROM pinnedMessages WHERE conversationId = ?').all(convId) as Row[])
        if (p.expiresAt == null || Number(p.expiresAt) > now) pinnedRows.add(p.messageId);
    }
    const attTable = has('message_attachments')
      ? db.query(`SELECT contentType FROM message_attachments WHERE messageId = ? AND attachmentType = 'attachment' AND (editHistoryIndex IS NULL OR editHistoryIndex = -1) ORDER BY orderInMessage`)
      : null;

    const live: RawMessage[] = [];
    const deleted: Handle[] = [];
    const seen = new Set<Handle>();
    for (const m of msgs) {
      // A version of another message kept as a row of its own is that message, not one more.
      if (baseOf.has(m.id) || seen.has(m.id)) continue;
      seen.add(m.id);
      const j = m.j;
      if (j.deletedForEveryone || j.isErased) {
        deleted.push(m.id);
        continue;
      }
      const styles: { style: string; start: number; length: number }[] = [];
      const mentions: { uuid: string; start: number; length: number }[] = [];
      for (const r of Array.isArray(j.bodyRanges) ? (j.bodyRanges as Row[]) : []) {
        const aci = aciText(r?.mentionAci ?? r?.mentionUuid);
        if (aci) mentions.push({ uuid: aci, start: Number(r.start ?? 0), length: Number(r.length ?? 0) });
        else if (STYLES[r?.style]) styles.push({ style: STYLES[r.style]!, start: Number(r.start ?? 0), length: Number(r.length ?? 0) });
      }
      const editedTs = Number(j.editMessageTimestamp ?? 0);
      const q = j.quote;
      const qa = aciText(q?.authorAci ?? q?.authorUuid);
      const qts = Number(q?.id ?? 0);
      const reactions: { author: string; key: string }[] = [];
      for (const r of Array.isArray(j.reactions) ? (j.reactions as Row[]) : []) {
        const who = aciOfConv.get(r?.fromId) ?? aciText(r?.fromId);
        if (r?.emoji && who) reactions.push({ author: who, key: String(r.emoji) });
      }
      const files = attTable ? (attTable.all(m.row.id) as Row[]) : Array.isArray(j.attachments) ? (j.attachments as Row[]) : [];
      live.push({
        id: m.id,
        author: m.author,
        body: fromSignal(typeof j.body === 'string' ? j.body : '', styles, mentions),
        edited: (!!editedTs && editedTs !== m.ts) || (Array.isArray(j.editHistory) && j.editHistory.length > 1),
        replyTo: qa && qts ? resolve(msgId(qa, qts)) : null,
        reactions,
        pinned: pinnedRows.has(m.row.id),
        attachments: files.map((a) => ({ kind: kindOf(a.contentType) })),
      });
    }
    return normalize(o.actors, live, deleted);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- a live profile, read without touching it

/**
 * The profile folder: `root` itself when it holds sql/db.sqlite, else Signal's folder in a home under it. A Desktop
 * the extractor runs keeps it in the account's sandbox (docs/signal.md "Calls through Signal Desktop"), so the
 * account's directory, its `desktop` folder and the sandbox's home all lead to it.
 */
export function findDesktopProfile(root: string): string | null {
  for (const sub of ['', '.config/Signal', 'home/.config/Signal', 'desktop/home/.config/Signal', 'Signal']) if (existsSync(join(root, sub, 'sql', 'db.sqlite'))) return join(root, sub);
  return null;
}

const stamp = (p: string) => {
  try {
    const s = statSync(p);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
};

/**
 * A linked Signal Desktop's profile, read as an oracle while Desktop runs. Each read copies sql/db.sqlite and its
 * -wal (read-only opens; no lock taken, nothing written) into `workDir`, decrypts the copy there and reads it; a
 * profile that has not changed since is not copied again.
 */
export class DesktopProfileReader {
  readonly profile: string;
  private readonly key: Buffer;
  private readonly plain: string;
  private lastStamp = '';
  private good = false;

  constructor(o: { profile: string; workDir: string; key?: Buffer }) {
    const profile = findDesktopProfile(o.profile);
    if (!profile) throw new NotSignalDesktop('no sql/db.sqlite there: give the Signal Desktop profile folder (the one holding config.json and sql/)');
    this.profile = profile;
    if (o.key) this.key = o.key;
    else {
      const k = desktopKey(profile);
      if ('missing' in k) throw new NotSignalDesktop(k.missing === 'keyring' ? 'its database key is wrapped by a desktop keyring this cannot open' : 'its config.json has no database key');
      this.key = k.key;
    }
    mkdirSync(o.workDir, { recursive: true, mode: 0o700 });
    this.plain = join(o.workDir, 'desktop-oracle.sqlite');
  }

  private get db() {
    return join(this.profile, 'sql', 'db.sqlite');
  }

  /** What the files look like now: changes whenever Desktop writes. */
  stamp(): string {
    return `${stamp(this.db)}|${stamp(this.db + '-wal')}`;
  }

  /** The plain copy, taken again if the profile changed. A torn copy keeps the last good one (or throws, with none). */
  snapshot(): string {
    const now = this.stamp();
    if (now === this.lastStamp && this.good) return this.plain;
    const dir = join(this.plain + '.src');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const copy = join(dir, 'db.sqlite');
    rmSync(copy + '-wal', { force: true });
    copyFileSync(this.db, copy);
    if (existsSync(this.db + '-wal')) copyFileSync(this.db + '-wal', copy + '-wal');
    try {
      decryptSqlcipher(copy, this.key, this.plain);
      this.good = true;
      this.lastStamp = now;
    } catch (e) {
      if (!(e instanceof TornCopy) || !this.good) throw e;
    }
    return this.plain;
  }

  state(o: DesktopStateOptions): NormalizedConversationState {
    return readSignalDesktopState(this.snapshot(), o);
  }

  /** Resolves when the profile's database or its log next changes (its files looked at every `everyMs`). */
  changed(everyMs = 250): { promise: Promise<void>; cancel(): void } {
    const from = this.stamp();
    let timer: Timer | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setInterval(() => {
        if (this.stamp() !== from) {
          clearInterval(timer);
          resolve();
        }
      }, everyMs);
    });
    return { promise, cancel: () => clearInterval(timer) };
  }
}
