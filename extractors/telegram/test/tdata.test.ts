/**
 * Telegram Desktop's tdata, against fixtures from our own encoder (tdata.ts writeTdata) and hand-made files: the file
 * names, the TDF$ wrapper and its checksum, local encryption, the passcode, several accounts, the old 32-bit ids and
 * the old 0/1 file names. scripts/verify-telegram-desktop.ts --real reads what the real Telegram Desktop writes.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataName, decryptLocal, encryptLocal, filePart, keyFingerprint, localKey, parseMtpAuthorization, readTdata, readTdfFile, serializeMtpAuthorization, signedInAccount, TDESKTOP_VERSION, TdataError, writeTdata, writeTdfFile } from '../src/tdata.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-tdata-'));
  dirs.push(d);
  return d;
};
const key = (seed: number) => new Uint8Array(256).map((_, i) => (i * 31 + seed) & 0xff);

test('file names: "data" is D877F783D5D3EF8C, as every tdata has it; account i is data#<i+1>', () => {
  expect(filePart('data')).toBe('D877F783D5D3EF8C');
  expect(dataName(0)).toBe('data');
  expect(dataName(1)).toBe('data#2');
  // The same rule by hand: MD5's first 8 bytes, little-endian, low nibble first.
  const md5 = createHash('md5').update('data#2').digest();
  const nibbles = [...md5.subarray(0, 8)].flatMap((b) => [b & 0xf, b >> 4]);
  expect(filePart('data#2')).toBe(nibbles.map((n) => n.toString(16).toUpperCase()).join(''));
});

test('the TDF$ wrapper: magic, version, body, MD5 of body, its length, version and magic; a bad checksum is no file', () => {
  const dir = tmp();
  const body = Buffer.from('some body');
  writeTdfFile(join(dir, 'x'), body, 7_002_009);
  const raw = readFileSync(join(dir, 'xs'));
  expect(raw.subarray(0, 4).toString()).toBe('TDF$');
  expect(raw.readInt32LE(4)).toBe(7_002_009);
  expect(raw.subarray(8, 8 + body.length)).toEqual(body);
  const tail = Buffer.alloc(8);
  tail.writeInt32LE(body.length, 0);
  tail.writeInt32LE(7_002_009, 4);
  expect(raw.subarray(-16)).toEqual(createHash('md5').update(body).update(tail).update('TDF$').digest());
  expect(readTdfFile(join(dir, 'x'))).toEqual({ version: 7_002_009, body });
  raw[9] ^= 1;
  writeFileSync(join(dir, 'xs'), raw);
  expect(readTdfFile(join(dir, 'x'))).toBeNull();
});

test('old file names: of x0 and x1 the newer one is read, and a damaged one is passed over', () => {
  const dir = tmp();
  writeTdfFile(join(dir, 'old'), Buffer.from('first'));
  renameSync(join(dir, 'olds'), join(dir, 'old0'));
  writeTdfFile(join(dir, 'old'), Buffer.from('second'));
  renameSync(join(dir, 'olds'), join(dir, 'old1'));
  utimesSync(join(dir, 'old0'), new Date(1000_000), new Date(1000_000));
  expect(readTdfFile(join(dir, 'old'))!.body.toString()).toBe('second');
  utimesSync(join(dir, 'old0'), new Date(), new Date(Date.now() + 5000));
  expect(readTdfFile(join(dir, 'old'))!.body.toString()).toBe('first');
  const broken = readFileSync(join(dir, 'old0'));
  broken[10] ^= 0xff;
  writeFileSync(join(dir, 'old0'), broken);
  expect(readTdfFile(join(dir, 'old'))!.body.toString()).toBe('second');
});

test('local encryption: the length prefix and padding, msg_key = SHA1 of the plaintext, a wrong key or a flipped bit fails', () => {
  const k = randomBytes(256);
  for (const n of [0, 1, 11, 12, 13, 28, 100]) {
    const data = randomBytes(n);
    const enc = encryptLocal(data, k);
    expect(enc.length % 16).toBe(0);
    expect(enc.length).toBe(16 + Math.ceil((4 + n) / 16) * 16);
    expect(decryptLocal(enc, k)).toEqual(data);
    expect(decryptLocal(enc, randomBytes(256))).toBeNull();
    const flipped = Buffer.from(enc);
    flipped[enc.length - 1] ^= 1;
    expect(decryptLocal(flipped, k)).toBeNull();
  }
  expect(decryptLocal(Buffer.alloc(15), k)).toBeNull();
});

test('the passcode key: one PBKDF2-SHA512 round without a passcode, 100000 with one, from SHA512(salt ‖ passcode ‖ salt)', () => {
  const salt = Buffer.alloc(32, 7);
  const hash = (p: string) => createHash('sha512').update(salt).update(p).update(salt).digest();
  const { pbkdf2Sync } = require('node:crypto');
  expect(localKey('', salt)).toEqual(pbkdf2Sync(hash(''), salt, 1, 256, 'sha512'));
  expect(localKey('1234', salt)).toEqual(pbkdf2Sync(hash('1234'), salt, 100_000, 256, 'sha512'));
});

test("a signed-in session round-trips: who, the DC, each DC's key, and which account is shown", () => {
  const dir = tmp();
  const big = 7_123_456_789n; // past 32 bits, as new user ids are
  writeTdata(dir, {
    accounts: [
      { index: 0, userId: 0n, mainDcId: 2, keys: [{ dcId: 2, key: key(1) }], keysToDestroy: [] },
      { index: 2, userId: big, mainDcId: 4, keys: [{ dcId: 2, key: key(2) }, { dcId: 4, key: key(3) }], keysToDestroy: [{ dcId: 1, key: key(4) }] },
    ],
    active: 2,
  });
  expect(readdirSync(dir).sort()).toEqual([filePart('data'), filePart('data#3'), 'key_data'].map((n) => `${n}s`).sort());
  const t = readTdata(dir);
  expect(t.version).toBe(TDESKTOP_VERSION);
  expect(t.active).toBe(2);
  expect(t.passcode).toBe(false);
  expect(t.accounts.map((a) => [a.index, a.userId, a.mainDcId, a.keys.map((k) => k.dcId), a.keysToDestroy.length])).toEqual([
    [0, 0n, 2, [2], 0],
    [2, big, 4, [2, 4], 1],
  ]);
  const s = signedInAccount(t)!;
  expect(s.index).toBe(2);
  expect(Buffer.from(s.authKey)).toEqual(Buffer.from(key(3)));
  expect(keyFingerprint(s.authKey)).toMatch(/^[0-9a-f]{16}$/);
  // Signed out (user 0 everywhere): nothing to import.
  writeTdata(dir, { accounts: [{ index: 0, userId: 0n, mainDcId: 2, keys: [{ dcId: 2, key: key(5) }], keysToDestroy: [] }] });
  expect(signedInAccount(readTdata(dir))).toBeNull();
});

test('a local passcode: without it, or a wrong one, it says so; with it, the session reads', () => {
  const dir = tmp();
  writeTdata(dir, { accounts: [{ index: 0, userId: 42n, mainDcId: 2, keys: [{ dcId: 2, key: key(9) }], keysToDestroy: [] }], passcode: 'hunter2' });
  const fails = (p: string) => {
    try {
      readTdata(dir, p);
      return null;
    } catch (e) {
      return e instanceof TdataError ? [e.code, e.message] : String(e);
    }
  };
  expect(fails('')).toEqual(['passcode', 'Telegram Desktop has a local passcode']);
  expect(fails('nope')).toEqual(['passcode', 'that is not Telegram Desktop’s local passcode']);
  const t = readTdata(dir, 'hunter2');
  expect(t.passcode).toBe(true);
  expect(signedInAccount(t)!.userId).toBe(42n);
});

test('missing and damaged files say which', () => {
  const dir = tmp();
  expect(() => readTdata(dir)).toThrow(TdataError);
  try {
    readTdata(dir);
  } catch (e) {
    expect((e as TdataError).code).toBe('missing');
  }
  writeTdata(dir, { accounts: [{ index: 0, userId: 1n, mainDcId: 2, keys: [{ dcId: 2, key: key(1) }], keysToDestroy: [] }] });
  // The account file encrypted with some other key: its checksum holds, its contents do not open.
  const other = encryptLocal(Buffer.from([0, 0, 0, 0x4b]), randomBytes(256));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(other.length);
  writeTdfFile(join(dir, filePart('data')), Buffer.concat([len, other]));
  try {
    readTdata(dir);
    throw new Error('read');
  } catch (e) {
    expect(e).toBeInstanceOf(TdataError);
    expect((e as TdataError).code).toBe('corrupt');
  }
});

test('the MTP authorization: wide ids as written today, and the old int32 user id and DC', () => {
  const a = { userId: 5_000_000_001n, mainDcId: 5, keys: [{ dcId: 5, key: key(7) }], keysToDestroy: [] };
  const wide = serializeMtpAuthorization(a);
  expect(wide.subarray(0, 8)).toEqual(Buffer.alloc(8, 0xff));
  expect(parseMtpAuthorization(wide)).toEqual(a);
  const old = Buffer.alloc(8 + 4 + 4 + 256 + 4);
  old.writeInt32BE(123456, 0);
  old.writeInt32BE(3, 4);
  old.writeInt32BE(1, 8);
  old.writeInt32BE(3, 12);
  Buffer.from(key(8)).copy(old, 16);
  old.writeInt32BE(0, 16 + 256);
  expect(parseMtpAuthorization(old)).toEqual({ userId: 123456n, mainDcId: 3, keys: [{ dcId: 3, key: key(8) }], keysToDestroy: [] });
});
