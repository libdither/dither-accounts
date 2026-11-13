/**
 * What a user pastes as a "recovery key", and Secret Storage (m.secret_storage.v1.aes-hmac-sha2).
 *
 * Depending on when the account set things up, the pasted string is one of three things:
 * the key of the room key backup itself; a Secret Storage key, which unlocks an encrypted copy
 * of the backup key and the cross-signing keys in account data; or a passphrase for that key.
 * Pure functions over WebCrypto. The Olm and Megolm parts stay in the library.
 */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PREFIX = [0x8b, 0x01];
const KEY_BYTES = 32;

function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const d = BASE58.indexOf(ch);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** The spec's recovery key format: base58 of 0x8B 0x01, 32 key bytes, and a parity byte. Spaces are for reading. null: not one. */
export function decodeRecoveryKey(input: string): Uint8Array | null {
  const bytes = base58Decode(input.replace(/\s+/g, ''));
  if (!bytes || bytes.length !== PREFIX.length + KEY_BYTES + 1) return null;
  if (bytes[0] !== PREFIX[0] || bytes[1] !== PREFIX[1]) return null;
  if (bytes.reduce((p, b) => p ^ b, 0) !== 0) return null;
  return bytes.slice(PREFIX.length, PREFIX.length + KEY_BYTES);
}

/**
 * Why something that looks like a recovery key is not one (a typo), so the user hears that rather than
 * "wrong key". null: it is a valid key, or it does not look like one at all (a security phrase, say).
 */
export function recoveryKeyProblem(input: string): string | null {
  const compact = input.replace(/\s+/g, '');
  const grouped = /^\S{1,4}(\s+\S{1,4})*$/.test(input.trim());
  if (!/^[0-9A-Za-z]{44,52}$/.test(compact) || !(grouped || !/\s/.test(input.trim()))) return null;
  if (decodeRecoveryKey(compact)) return null;
  const stray = [...new Set(compact.split('').filter((ch) => !BASE58.includes(ch)))];
  if (stray.length) return `that recovery key contains ${stray.map((c) => `"${c}"`).join(', ')}, which never appear in one (it has no 0, O, I or l); check for a mistyped character`;
  if (compact.length !== 48) return `a recovery key has 48 characters; that one has ${compact.length}`;
  return 'that recovery key has a typo: its checksum does not match. Check it character by character';
}

export function encodeRecoveryKey(key: Uint8Array): string {
  const bytes = new Uint8Array(PREFIX.length + KEY_BYTES + 1);
  bytes.set(PREFIX);
  bytes.set(key, PREFIX.length);
  bytes[bytes.length - 1] = bytes.slice(0, -1).reduce((p, b) => p ^ b, 0);
  return (base58Encode(bytes).match(/.{1,4}/g) ?? []).join(' ');
}

const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const b64 = (b: Uint8Array | ArrayBuffer) => Buffer.from(b as Uint8Array).toString('base64').replace(/=+$/, '');

/** The AES-CTR and HMAC-SHA-256 keys for a secret, by its name. */
async function deriveKeys(key: Uint8Array, name: string) {
  const hkdf = await crypto.subtle.importKey('raw', key as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(name) }, hkdf, 512));
  return {
    aes: await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-CTR', false, ['encrypt', 'decrypt']),
    hmac: await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
  };
}

export interface SecretPayload {
  iv: string;
  ciphertext: string;
  mac: string;
}

export interface SecretKeyInfo {
  algorithm?: string;
  iv?: string;
  mac?: string;
  passphrase?: { algorithm?: string; salt?: string; iterations?: number; bits?: number };
}

export async function encryptSecret(key: Uint8Array, name: string, plaintext: string, ivBytes?: Uint8Array): Promise<SecretPayload> {
  const iv = ivBytes ?? crypto.getRandomValues(new Uint8Array(16));
  if (!ivBytes) iv[8] &= 0x7f; // leave room in the counter, as the spec asks
  const { aes, hmac } = await deriveKeys(key, name);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv as BufferSource, length: 64 }, aes, new TextEncoder().encode(plaintext));
  const mac = await crypto.subtle.sign('HMAC', hmac, ciphertext);
  return { iv: b64(iv), ciphertext: b64(ciphertext), mac: b64(mac) };
}

/** Throws if the MAC does not match: the wrong key, or a secret someone changed. */
export async function decryptSecret(key: Uint8Array, name: string, p: SecretPayload): Promise<string> {
  const { aes, hmac } = await deriveKeys(key, name);
  const ciphertext = unb64(p.ciphertext);
  if (!(await crypto.subtle.verify('HMAC', hmac, unb64(p.mac) as BufferSource, ciphertext as BufferSource))) throw new Error(`the key does not unlock ${name}`);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: unb64(p.iv) as BufferSource, length: 64 }, aes, ciphertext as BufferSource);
  return new TextDecoder().decode(plain);
}

/** The check value published with a Secret Storage key: 32 zero bytes, encrypted under the name "". */
export async function secretKeyInfo(key: Uint8Array): Promise<Required<Pick<SecretKeyInfo, 'iv' | 'mac'>>> {
  const { iv, mac } = await encryptSecret(key, '', '\0'.repeat(32));
  return { iv, mac };
}

export async function checkSecretKey(key: Uint8Array, info: SecretKeyInfo): Promise<boolean> {
  if (info.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2' || !info.iv || !info.mac) return false;
  const { mac } = await encryptSecret(key, '', '\0'.repeat(32), unb64(info.iv));
  return mac === info.mac.replace(/=+$/, '');
}

export async function keyFromPassphrase(passphrase: string, info: SecretKeyInfo): Promise<Uint8Array | null> {
  const p = info.passphrase;
  if (p?.algorithm !== 'm.pbkdf2' || !p.salt || !p.iterations) return null;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: new TextEncoder().encode(p.salt), iterations: p.iterations }, base, p.bits ?? 256);
  return new Uint8Array(bits);
}
