/**
 * The Proton web app's persisted session, as it keeps it in mail.proton.me's localStorage (docs/proton.md, "The
 * session"): `ps-<localID>` holds `{ UserID, UID, blob, payloadVersion, persistent, … }`, and `blob` is the key password
 * (`{ keyPassword, offlineKeyPassword? }` as JSON) sealed with AES-256-GCM under a per-session ClientKey that only the
 * API hands out (`GET /api/auth/v4/sessions/local/key` → `{ ClientKey }`, base64 of 32 bytes).
 *
 *   payloadVersion 1: base64( iv[16] ‖ ciphertext+tag ), no additional data, the JSON as a "binary string" (one byte
 *                     per UTF-16 unit: Latin-1)
 *   payloadVersion 2: as 1, with additional data "session" (UTF-8)
 *   payloadVersion 3: base64( iv[12] ‖ ciphertext+tag ), additional data "session", the JSON as UTF-8
 *
 * Written from the format, not from Proton's code. Nothing here is kept: the caller holds the key password in memory.
 */

export interface SessionBlob {
  keyPassword: string;
  /** Only in sessions made with an offline key (a feature of some apps); not needed here. */
  offline: boolean;
}

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

/** Open a `ps-<localID>` blob with the session's ClientKey. Throws on a wrong key, a damaged blob or an unknown version. */
export async function openSessionBlob(blob: string, clientKey: string, payloadVersion: number): Promise<SessionBlob> {
  const version = payloadVersion || 1;
  if (![1, 2, 3].includes(version)) throw new Error(`unknown session payload version ${version}`);
  const raw = b64(clientKey);
  if (raw.length !== 32) throw new Error(`the ClientKey is ${raw.length} bytes, not 32`);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const data = b64(blob);
  const ivLength = version === 3 ? 12 : 16;
  if (data.length <= ivLength + 16) throw new Error('the session blob is too short');
  const params: AesGcmParams = { name: 'AES-GCM', iv: data.slice(0, ivLength) };
  if (version >= 2) params.additionalData = new TextEncoder().encode('session');
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(params, key, data.slice(ivLength)));
  } catch {
    throw new Error('the session blob did not open with this ClientKey');
  }
  const text = version === 3 ? new TextDecoder().decode(plain) : Buffer.from(plain).toString('latin1');
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the session blob is not JSON');
  }
  if (typeof parsed?.keyPassword !== 'string') throw new Error('the session blob has no key password');
  return { keyPassword: parsed.keyPassword, offline: typeof parsed.offlineKeyPassword === 'string' && !!parsed.offlineKeyPassword };
}

/** The other way, for tests and the fake: seal a key password as the web app does for the given version. */
export async function sealSessionBlob(payload: { keyPassword: string; offlineKeyPassword?: string }, clientKey: string, payloadVersion: 1 | 2 | 3): Promise<string> {
  const key = await crypto.subtle.importKey('raw', b64(clientKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(payloadVersion === 3 ? 12 : 16));
  const json = JSON.stringify(payload);
  const data = payloadVersion === 3 ? new TextEncoder().encode(json) : Uint8Array.from(Buffer.from(json, 'latin1'));
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (payloadVersion >= 2) params.additionalData = new TextEncoder().encode('session');
  const sealed = new Uint8Array(await crypto.subtle.encrypt(params, key, data));
  return Buffer.concat([iv, sealed]).toString('base64');
}
