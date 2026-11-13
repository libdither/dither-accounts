import { describe, expect, test } from 'bun:test';
import { base58Encode, checkSecretKey, decodeRecoveryKey, decryptSecret, encodeRecoveryKey, encryptSecret, keyFromPassphrase, recoveryKeyProblem, secretKeyInfo } from '../src/recovery.ts';

describe('recovery key format', () => {
  test('base58 alphabet against a known vector', () => {
    expect(base58Encode(new TextEncoder().encode('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
  });
  test('round trip, with or without spaces', () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const s = encodeRecoveryKey(key);
    expect(s.startsWith('E')).toBe(true); // Every 0x8B01 key starts with E
    expect(s).toContain(' ');
    expect(decodeRecoveryKey(s)).toEqual(key);
    expect(decodeRecoveryKey(s.replace(/ /g, ''))).toEqual(key);
  });
  test('rejects a typo, a wrong length, and text', () => {
    const s = encodeRecoveryKey(new Uint8Array(32).fill(7)).replace(/ /g, '');
    const flipped = s.slice(0, 10) + (s[10] === 'a' ? 'b' : 'a') + s.slice(11);
    expect(decodeRecoveryKey(flipped)).toBeNull();
    expect(decodeRecoveryKey(s.slice(0, -2))).toBeNull();
    expect(decodeRecoveryKey('correct horse battery staple')).toBeNull();
    expect(decodeRecoveryKey('')).toBeNull();
  });
});

describe('what is wrong with a pasted key', () => {
  const good = encodeRecoveryKey(new Uint8Array(32).fill(7));
  test('a good key, or something that is not a key at all, has no problem to report', () => {
    expect(recoveryKeyProblem(good)).toBeNull();
    expect(recoveryKeyProblem(good.replace(/ /g, ''))).toBeNull();
    expect(recoveryKeyProblem('correct horse battery staple')).toBeNull();
    expect(recoveryKeyProblem('')).toBeNull();
  });
  test('a typo is called a typo', () => {
    const compact = good.replace(/ /g, '');
    const flipped = compact.slice(0, 10) + (compact[10] === 'a' ? 'b' : 'a') + compact.slice(11);
    expect(recoveryKeyProblem(flipped)).toMatch(/typo/);
    expect(recoveryKeyProblem(compact.slice(0, 20) + '0' + compact.slice(21))).toMatch(/"0"/);
    expect(recoveryKeyProblem(compact.slice(0, -1))).toMatch(/48 characters/);
  });
});

describe('secret storage', () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  test('the check value tells the right key from a wrong one', async () => {
    const info = { algorithm: 'm.secret_storage.v1.aes-hmac-sha2', ...(await secretKeyInfo(key)) };
    expect(await checkSecretKey(key, info)).toBe(true);
    expect(await checkSecretKey(new Uint8Array(32), info)).toBe(false);
    expect(await checkSecretKey(key, { ...info, algorithm: 'other' })).toBe(false);
  });
  test('secrets round trip, bound to their name and key', async () => {
    const p = await encryptSecret(key, 'm.megolm_backup.v1', 'c2VjcmV0');
    expect(await decryptSecret(key, 'm.megolm_backup.v1', p)).toBe('c2VjcmV0');
    await expect(decryptSecret(key, 'm.cross_signing.master', p)).rejects.toThrow();
    await expect(decryptSecret(new Uint8Array(32), 'm.megolm_backup.v1', p)).rejects.toThrow();
  });
  test('the check value matches one computed independently', async () => {
    // The check value for an all-zero key, computed with Python's hmac and the openssl command.
    const info = { algorithm: 'm.secret_storage.v1.aes-hmac-sha2', iv: 'AAAAAAAAAAAAAAAAAAAAAA', mac: 'HwRM9acFfsmgx1IlMgQI2n1pdsF6jVbAq9RIGTiIosQ' };
    expect(await checkSecretKey(new Uint8Array(32), info)).toBe(true);
  });
  test('passphrases derive with the published parameters', async () => {
    const k = await keyFromPassphrase('pw', { passphrase: { algorithm: 'm.pbkdf2', salt: 'salt', iterations: 10 } });
    expect(k?.length).toBe(32);
    expect(await keyFromPassphrase('pw', { passphrase: { algorithm: 'other' } })).toBeNull();
    expect(await keyFromPassphrase('pw', {})).toBeNull();
  });
});
