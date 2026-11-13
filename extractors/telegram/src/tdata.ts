/**
 * Telegram Desktop's session on disk (`<workdir>/tdata`), read and written here from the format alone (tdesktop is
 * GPL; nothing below is its code). What it holds that we use: per account, who is signed in (a user id, 0 while it
 * is not), its main DC, and the 256-byte MTProto auth key for each DC it talks to.
 *
 * The layout, as Telegram Desktop 7.2.9 writes it (docs/telegram.md, "Telegram Desktop's tdata"):
 *
 *   a file          "TDF$", the app version (int32 LE), a body, then MD5(body ‖ int32 LE body length ‖ version ‖
 *                   "TDF$"). Written as <name>s; older versions kept <name>0 and <name>1, the newer one wins.
 *   the body        a Qt data stream: big-endian integers, byte arrays as a uint32 BE length (0xffffffff: null)
 *                   and the bytes.
 *   encrypted part  16 bytes of msg_key, then AES-256-IGE of [uint32 LE length of what follows, counted with
 *                   these 4 bytes][data][random padding to 16]; msg_key = SHA1 of the plaintext (padding included)
 *                   cut to 16; the AES key and IV come from msg_key and a 256-byte key as MTProto 1.0 derived them
 *                   for the client→server direction's opposite (x = 8).
 *   key_datas       byte arrays salt (32), keyEncrypted, infoEncrypted. The passcode key is PBKDF2-HMAC-SHA512
 *                   of SHA512(salt ‖ passcode ‖ salt) with the salt, 1 iteration with no passcode and 100000 with
 *                   one, 256 bytes. keyEncrypted, decrypted with it, is the 256-byte local key; infoEncrypted,
 *                   decrypted with the local key, is int32 count, count × int32 account index, int32 active index.
 *   <part>s         one per account: <part> is the first 8 bytes of MD5("data") (account 0) or of "data#<i+1>",
 *                   as a little-endian number written as 16 hex digits, low nibble first ("data" → D877F783D5D3EF8C).
 *                   Body: one byte array, encrypted with the local key, of blocks: uint32 block id, then its value.
 *                   Block 0x4b (MTP authorization) is a byte array: uint64 0xffff…ff, uint64 user id, int32 main DC
 *                   (old files: int32 user id, int32 main DC), then two key lists (in use, to destroy), each an int32
 *                   count of (int32 DC id, 256 key bytes).
 */
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from('TDF$', 'latin1');
const MTP_AUTHORIZATION = 0x4b;
const SALT_SIZE = 32;
const KEY_SIZE = 256;
const STRONG_ITERATIONS = 100_000;
const MAX_ACCOUNTS = 6;
/** Telegram Desktop 7.2.9 (AppVersion). Files from a newer version than the reader's are skipped by Telegram Desktop. */
export const TDESKTOP_VERSION = 7_002_009;

export interface TdataKey {
  dcId: number;
  key: Uint8Array;
}

export interface TdataAccount {
  /** Telegram Desktop's account slot (0–5). */
  index: number;
  /** Who is signed in; 0n while it is not (the sign-in screen already has keys). */
  userId: bigint;
  mainDcId: number;
  keys: TdataKey[];
  keysToDestroy: TdataKey[];
}

export interface Tdata {
  /** The app version that wrote key_datas. */
  version: number;
  accounts: TdataAccount[];
  /** The account shown when Telegram Desktop starts. */
  active: number;
  passcode: boolean;
}

export class TdataError extends Error {
  constructor(
    message: string,
    readonly code: 'missing' | 'passcode' | 'corrupt',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- crypto

const sha1 = (...parts: Uint8Array[]) => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The AES key and IV for local encryption: MTProto 1.0's derivation from a 256-byte key and a msg_key, x = 8. */
function aesKeyIv(authKey: Uint8Array, msgKey: Uint8Array): { key: Buffer; iv: Buffer } {
  const x = 8;
  const k = (from: number, len: number) => authKey.subarray(from + x, from + x + len);
  const a = sha1(msgKey, k(0, 32));
  const b = sha1(k(32, 16), msgKey, k(48, 16));
  const c = sha1(k(64, 32), msgKey);
  const d = sha1(msgKey, k(96, 32));
  const key = Buffer.concat([a.subarray(0, 8), b.subarray(8, 20), c.subarray(4, 16)]);
  const iv = Buffer.concat([a.subarray(8, 20), b.subarray(0, 8), c.subarray(16, 20), d.subarray(0, 8)]);
  return { key, iv };
}

/** AES-256-IGE over whole 16-byte blocks; the IV is 32 bytes (the previous ciphertext block, then plaintext block). */
function ige(data: Uint8Array, key: Buffer, iv: Buffer, encrypt: boolean): Buffer {
  if (data.length % 16) throw new TdataError('an encrypted part is not whole AES blocks', 'corrupt');
  const out = Buffer.alloc(data.length);
  const cipher = encrypt ? createCipheriv('aes-256-ecb', key, null) : createDecipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  // IGE chains on both sides: for encryption the "previous" pair is (ciphertext, plaintext), for decryption the
  // roles swap, so one loop serves both with prevIn/prevOut.
  let prevOut = Buffer.from(iv.subarray(encrypt ? 0 : 16, encrypt ? 16 : 32));
  let prevIn = Buffer.from(iv.subarray(encrypt ? 16 : 0, encrypt ? 32 : 16));
  const block = Buffer.alloc(16);
  for (let off = 0; off < data.length; off += 16) {
    const input = data.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) block[i] = input[i] ^ prevOut[i];
    const mid = cipher.update(block);
    for (let i = 0; i < 16; i++) out[off + i] = mid[i] ^ prevIn[i];
    prevIn = Buffer.from(input);
    prevOut = out.subarray(off, off + 16);
  }
  return out;
}

export function localKey(passcode: string, salt: Uint8Array): Buffer {
  const pass = Buffer.from(passcode, 'utf8');
  const hash = createHash('sha512').update(salt).update(pass).update(salt).digest();
  return pbkdf2Sync(hash, salt, pass.length ? STRONG_ITERATIONS : 1, KEY_SIZE, 'sha512');
}

/** An encrypted part: null when the key does not open it (a wrong passcode, or a damaged file). */
export function decryptLocal(encrypted: Uint8Array, key: Uint8Array): Buffer | null {
  if (encrypted.length <= 16 || encrypted.length % 16) return null;
  const msgKey = encrypted.subarray(0, 16);
  const { key: aesKey, iv } = aesKeyIv(key, msgKey);
  const plain = ige(encrypted.subarray(16), aesKey, iv, false);
  if (!sha1(plain).subarray(0, 16).equals(Buffer.from(msgKey))) return null;
  const len = plain.readUInt32LE(0);
  if (len > plain.length || len <= plain.length - 16 || len < 4) return null;
  return plain.subarray(4, len);
}

export function encryptLocal(data: Uint8Array, key: Uint8Array): Buffer {
  const size = 4 + data.length;
  const full = size % 16 ? size + 16 - (size % 16) : size;
  const plain = Buffer.alloc(full);
  plain.writeUInt32LE(size, 0);
  Buffer.from(data).copy(plain, 4);
  randomBytes(full - size).copy(plain, size);
  const msgKey = sha1(plain).subarray(0, 16);
  const { key: aesKey, iv } = aesKeyIv(key, msgKey);
  return Buffer.concat([msgKey, ige(plain, aesKey, iv, true)]);
}

// ---------------------------------------------------------------- Qt data stream

class Reader {
  off = 0;
  constructor(readonly buf: Buffer) {}
  get atEnd() {
    return this.off >= this.buf.length;
  }
  private need(n: number) {
    if (this.off + n > this.buf.length) throw new TdataError('a tdata stream ends early', 'corrupt');
  }
  i32() {
    this.need(4);
    const v = this.buf.readInt32BE(this.off);
    this.off += 4;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }
  raw(n: number) {
    this.need(n);
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }
  bytes(): Buffer {
    const len = this.u32();
    if (len === 0xffffffff) return Buffer.alloc(0);
    return this.raw(len);
  }
}

class Writer {
  private parts: Buffer[] = [];
  i32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.parts.push(b);
    return this;
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    this.parts.push(b);
    return this;
  }
  u64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(v);
    this.parts.push(b);
    return this;
  }
  raw(v: Uint8Array) {
    this.parts.push(Buffer.from(v));
    return this;
  }
  bytes(v: Uint8Array) {
    return this.u32(v.length).raw(v);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

// ---------------------------------------------------------------- files

/** The body of a TDF$ file, after its checksum is checked: `<name>s`, or the newer of `<name>0` and `<name>1`. */
export function readTdfFile(path: string): { version: number; body: Buffer } | null {
  const candidates = existsSync(`${path}s`)
    ? [`${path}s`]
    : [`${path}0`, `${path}1`].filter((p) => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of candidates) {
    const all = readFileSync(file);
    if (all.length < 8 + 16 || !all.subarray(0, 4).equals(MAGIC)) continue;
    const version = all.readInt32LE(4);
    const body = all.subarray(8, all.length - 16);
    const tail = Buffer.alloc(8);
    tail.writeInt32LE(body.length, 0);
    tail.writeInt32LE(version, 4);
    const md5 = createHash('md5').update(body).update(tail).update(MAGIC).digest();
    if (!md5.equals(all.subarray(all.length - 16))) continue;
    return { version, body };
  }
  return null;
}

export function writeTdfFile(path: string, body: Uint8Array, version = TDESKTOP_VERSION) {
  const head = Buffer.alloc(8);
  MAGIC.copy(head, 0);
  head.writeInt32LE(version, 4);
  const tail = Buffer.alloc(8);
  tail.writeInt32LE(body.length, 0);
  tail.writeInt32LE(version, 4);
  const md5 = createHash('md5').update(body).update(tail).update(MAGIC).digest();
  const tmp = `${path}s.tmp`;
  writeFileSync(tmp, Buffer.concat([head, body, md5]), { mode: 0o600 });
  renameSync(tmp, `${path}s`);
}

/** Account 0 is "data", account i is "data#<i+1>". */
export const dataName = (index: number) => (index > 0 ? `data#${index + 1}` : 'data');

/** The file name part for a data name: MD5's first 8 bytes as a little-endian number, 16 hex digits low nibble first. */
export function filePart(name: string): string {
  const md5 = createHash('md5').update(Buffer.from(name, 'utf8')).digest();
  let v = md5.readBigUInt64LE(0);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += Number(v & 0xfn).toString(16).toUpperCase();
    v >>= 4n;
  }
  return out;
}

// ---------------------------------------------------------------- the session

const WIDE_IDS_TAG = 0xffff_ffff_ffff_ffffn;

export function parseMtpAuthorization(serialized: Buffer): Omit<TdataAccount, 'index'> {
  const r = new Reader(serialized);
  const legacyUser = r.i32();
  const legacyDc = r.i32();
  let userId: bigint;
  let mainDcId: number;
  // The two int32s, each widened to 64 bits with its sign, the first shifted up and or-ed with the second: the
  // all-ones tag means wide ids follow.
  const wide = ((BigInt.asUintN(64, BigInt(legacyUser)) << 32n) | BigInt.asUintN(64, BigInt(legacyDc))) & WIDE_IDS_TAG;
  if (wide === WIDE_IDS_TAG) {
    userId = r.u64();
    mainDcId = r.i32();
  } else {
    userId = BigInt(legacyUser);
    mainDcId = legacyDc;
  }
  const keys = (): TdataKey[] => {
    const n = r.i32();
    if (n < 0 || n > 64) throw new TdataError(`a tdata key list says ${n} keys`, 'corrupt');
    return Array.from({ length: n }, () => ({ dcId: r.i32(), key: new Uint8Array(r.raw(KEY_SIZE)) }));
  };
  return { userId, mainDcId, keys: keys(), keysToDestroy: keys() };
}

export function serializeMtpAuthorization(a: Omit<TdataAccount, 'index'>): Buffer {
  const w = new Writer().u64(WIDE_IDS_TAG).u64(a.userId).i32(a.mainDcId);
  for (const list of [a.keys, a.keysToDestroy]) {
    w.i32(list.length);
    for (const k of list) w.i32(k.dcId).raw(k.key);
  }
  return w.done();
}

/** Read the session Telegram Desktop keeps in `tdataDir`. Throws TdataError: missing, passcode (wrong or needed), corrupt. */
export function readTdata(tdataDir: string, passcode = ''): Tdata {
  const keyFile = readTdfFile(join(tdataDir, 'key_data'));
  if (!keyFile) throw new TdataError('no key_datas yet (Telegram Desktop has not started here)', 'missing');
  const kr = new Reader(keyFile.body);
  const salt = kr.bytes();
  const keyEncrypted = kr.bytes();
  const infoEncrypted = kr.bytes();
  if (salt.length !== SALT_SIZE) throw new TdataError(`key_datas has a ${salt.length}-byte salt`, 'corrupt');
  const inner = decryptLocal(keyEncrypted, localKey(passcode, salt));
  if (!inner) throw new TdataError(passcode ? 'that is not Telegram Desktop’s local passcode' : 'Telegram Desktop has a local passcode', 'passcode');
  if (inner.length !== KEY_SIZE) throw new TdataError('key_datas holds a local key of the wrong size', 'corrupt');
  const info = decryptLocal(infoEncrypted, inner);
  if (!info) throw new TdataError('key_datas does not open with its own local key', 'corrupt');
  const ir = new Reader(info);
  const count = ir.i32();
  if (count <= 0 || count > MAX_ACCOUNTS) throw new TdataError(`key_datas lists ${count} accounts`, 'corrupt');
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = ir.i32();
    if (idx >= 0 && idx < MAX_ACCOUNTS && !indices.includes(idx)) indices.push(idx);
  }
  const active = ir.atEnd ? (indices[0] ?? 0) : ir.i32();
  const accounts: TdataAccount[] = [];
  for (const index of indices) {
    const mtp = readTdfFile(join(tdataDir, filePart(dataName(index))));
    if (!mtp) continue;
    const enc = new Reader(mtp.body).bytes();
    const plain = decryptLocal(enc, inner);
    if (!plain) throw new TdataError(`account ${index}'s data does not open with the local key`, 'corrupt');
    const br = new Reader(plain);
    while (!br.atEnd) {
      const block = br.u32();
      if (block !== MTP_AUTHORIZATION) throw new TdataError(`account ${index}'s data has block 0x${block.toString(16)}`, 'corrupt');
      accounts.push({ index, ...parseMtpAuthorization(br.bytes()) });
    }
  }
  return { version: keyFile.version, accounts, active, passcode: !!passcode };
}

/**
 * Write a session in Telegram Desktop's format: the fixtures the tests read, and what the fake Telegram Desktop
 * writes once "signed in". Not used against a real Telegram Desktop.
 */
export function writeTdata(tdataDir: string, s: { accounts: TdataAccount[]; active?: number; passcode?: string; version?: number }) {
  mkdirSync(tdataDir, { recursive: true, mode: 0o700 });
  const salt = randomBytes(SALT_SIZE);
  const local = randomBytes(KEY_SIZE);
  const info = new Writer().i32(s.accounts.length);
  for (const a of s.accounts) info.i32(a.index);
  info.i32(s.active ?? s.accounts[0]?.index ?? 0);
  const body = new Writer()
    .bytes(salt)
    .bytes(encryptLocal(local, localKey(s.passcode ?? '', salt)))
    .bytes(encryptLocal(info.done(), local))
    .done();
  writeTdfFile(join(tdataDir, 'key_data'), body, s.version);
  for (const a of s.accounts) {
    const blocks = new Writer().u32(MTP_AUTHORIZATION).bytes(serializeMtpAuthorization(a)).done();
    writeTdfFile(join(tdataDir, filePart(dataName(a.index))), new Writer().bytes(encryptLocal(blocks, local)).done(), s.version);
  }
}

/** Which key, without the key: sha256 of it, 16 hex digits. */
export const keyFingerprint = (key: Uint8Array) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** The account Telegram Desktop shows, signed in, with its main DC's key; null when none is signed in. */
export function signedInAccount(t: Tdata): (TdataAccount & { authKey: Uint8Array }) | null {
  const order = [...t.accounts].sort((a, b) => (a.index === t.active ? -1 : b.index === t.active ? 1 : a.index - b.index));
  for (const a of order) {
    if (!a.userId) continue;
    const k = a.keys.find((x) => x.dcId === a.mainDcId);
    if (k) return { ...a, authKey: k.key };
  }
  return null;
}
