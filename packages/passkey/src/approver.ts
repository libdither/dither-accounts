/**
 * The approver (docs/approver.md): passkeys whose key lives on a paired phone. What an extractor asks the manager to
 * send to a device, what comes back, and the checks an answer must pass before it goes to the page: the device signs,
 * but this side still checks that what it signed is what was asked (rpId, credential, the key it registered).
 */
import { decode, encode } from './cbor.ts';

export type ApproverOp = 'create' | 'get';

/** What the extractor asks for; the manager adds the request's id, the account and expiresAt, and sends it to `device`. */
export interface ApproverAsk {
  op: ApproverOp;
  device: string;
  /** One line for the phone's prompt: why this account wants it. */
  reason: string;
  rpId: string;
  /** The calling frame's origin, as Chromium reported it. */
  origin: string;
  /** base64url: the exact bytes the relying party checks. */
  clientDataJSON: string;
  create?: { rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; algs: number[] };
  get?: { allow: string[] };
}

/** The device's refusals, and the manager's own (`no-device`: not paired here, or removed). */
export const REFUSALS = ['denied', 'refused', 'expired', 'unknown-credential', 'error', 'no-device'] as const;
export type Refusal = (typeof REFUSALS)[number];

export interface CreateAnswer {
  ok: true;
  credentialId: string;
  /** SPKI, base64. */
  publicKey: string;
  authenticatorData: string;
  attestationObject: string;
}
export interface GetAnswer {
  ok: true;
  credentialId: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}
export interface RefusedAnswer {
  ok: false;
  reason: Refusal;
  message?: string;
  /** The device's name, as paired (the manager adds it, so the account can say where it was refused). */
  deviceName?: string;
}
export type ApproverAnswer = CreateAnswer | GetAnswer | RefusedAnswer;

/** How the authenticator reaches the paired devices (through the manager). */
export interface Approver {
  /** The device this account keeps new passkeys on (its config's passkeyDevice), or null: made here, as before. */
  createDevice(): Promise<{ id: string; name: string } | null>;
  /** Sends one request and waits for its answer (at most until it expires). Never throws: a failure is a refusal. */
  request(r: ApproverAsk): Promise<ApproverAnswer>;
}

/** What of the extractor's link this needs (@dither-accounts/link's Link has both; its config is live). */
export interface Asker {
  readonly config: Record<string, any>;
  ask(what: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** How long the manager keeps a request (docs/approver.md: 3 minutes), and a little for the answer to come back. */
export const REQUEST_MS = 3 * 60_000;

/**
 * The approver, through the extractor's link to the manager: the device new passkeys go to is the account's config's
 * passkeyDevice (the manager keeps the link's config current), and requests are `approver.request` asks.
 */
export function approverVia(link: Asker): Approver {
  return {
    async createDevice() {
      const d = link.config.passkeyDevice;
      return typeof d === 'string' && d ? { id: d, name: d } : null;
    },
    async request(r) {
      try {
        return answerOf((await link.ask('approver.request', { ...r }, REQUEST_MS + 30_000)) as unknown, r.op);
      } catch (e) {
        return { ok: false, reason: 'error', message: String((e as Error)?.message ?? e).slice(0, 200) };
      }
    },
  };
}

const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** An answer as far as it is well formed for `op`; anything else is a refusal (`error`). */
export function answerOf(v: unknown, op: ApproverOp): ApproverAnswer {
  if (!v || typeof v !== 'object') return { ok: false, reason: 'error', message: 'no answer' };
  const a = v as Record<string, unknown>;
  if (a.ok === true) {
    if (op === 'create' && str(a.credentialId, 2048) && str(a.publicKey, 1024) && str(a.authenticatorData, 8192) && str(a.attestationObject, 16384))
      return { ok: true, credentialId: a.credentialId, publicKey: a.publicKey, authenticatorData: a.authenticatorData, attestationObject: a.attestationObject };
    if (op === 'get' && str(a.credentialId, 2048) && str(a.authenticatorData, 8192) && str(a.signature, 512) && (a.userHandle === null || a.userHandle === undefined || str(a.userHandle, 512)))
      return { ok: true, credentialId: a.credentialId, authenticatorData: a.authenticatorData, signature: a.signature, userHandle: (a.userHandle as string | null | undefined) ?? null };
    return { ok: false, reason: 'error', message: `a malformed ${op} answer` };
  }
  const reason = (REFUSALS as readonly string[]).includes(a.reason as string) ? (a.reason as Refusal) : 'error';
  return { ok: false, reason, ...(typeof a.message === 'string' && a.message ? { message: a.message.slice(0, 300) } : {}), ...(str(a.deviceName, 64) ? { deviceName: a.deviceName } : {}) };
}

// ---------------------------------------------------------------- checking an answer

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

/** Authenticator data, split (WebAuthn §6.1). */
export function parseAuthData(a: Uint8Array): { rpIdHash: Uint8Array; flags: number; counter: number; credentialId?: Uint8Array; cose?: Uint8Array } {
  if (a.length < 37) throw new Error('authenticator data too short');
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const out: ReturnType<typeof parseAuthData> = { rpIdHash: a.slice(0, 32), flags: a[32]!, counter: view.getUint32(33) };
  if (out.flags & 0x40) {
    if (a.length < 55) throw new Error('attested data too short');
    const len = view.getUint16(53);
    out.credentialId = a.slice(55, 55 + len);
    out.cose = a.slice(55 + len);
  }
  return out;
}

/** An ECDSA signature as WebAuthn has it (ASN.1 DER) to WebCrypto's r ‖ s, for P-256. */
export function rawSignature(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const fail = () => {
    throw new Error('the signature is not DER');
  };
  if (der[i++] !== 0x30) fail();
  const total = der[i++]!;
  if (total & 0x80 || total + 2 !== der.length) fail();
  const out = new Uint8Array(size * 2);
  for (const half of [0, 1]) {
    if (der[i++] !== 0x02) fail();
    const len = der[i++]!;
    let v = der.slice(i, i + len);
    i += len;
    if (v.length !== len || !len) fail();
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) fail();
    out.set(v, half * size + size - v.length);
  }
  if (i !== der.length) fail();
  return out;
}

/** A P-256 public key from SPKI (base64 or base64url): the key and its point. */
export async function p256Key(spki: string): Promise<{ key: CryptoKey; x: string; y: string }> {
  const bytes = new Uint8Array(Buffer.from(spki, 'base64'));
  if (bytes.length < 80 || bytes.length > 120) throw new Error('not a P-256 public key');
  const key = await crypto.subtle.importKey('spki', bytes as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return { key, x: jwk.x!, y: jwk.y! };
}

/**
 * A device's new credential, checked: the authenticator data is for this rpId, with UP, UV and AT, names this
 * credential id, and carries the same P-256 key as `publicKey` (as an EC2 ES256 COSE key); the attestation object is
 * "none" around that same authenticator data. Throws what is wrong.
 */
export async function checkCreated(a: CreateAnswer, rpId: string): Promise<{ authData: Uint8Array; spki: Uint8Array; attestationObject: Uint8Array }> {
  const authData = unb64u(a.authenticatorData);
  const ad = parseAuthData(authData);
  if (!eq(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) throw new Error('the authenticator data is for another rpId');
  if ((ad.flags & 0x45) !== 0x45) throw new Error('the authenticator data lacks UP, UV or AT');
  const id = unb64u(a.credentialId);
  if (id.length < 16 || id.length > 1023 || !ad.credentialId || !eq(ad.credentialId, id)) throw new Error('the authenticator data names another credential');
  const cose = decode(ad.cose!) as Map<number, unknown>;
  const k = await p256Key(a.publicKey);
  const x = cose instanceof Map ? cose.get(-2) : null;
  const y = cose instanceof Map ? cose.get(-3) : null;
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error('the credential key is not an ES256 P-256 key');
  if (Buffer.from(x).toString('base64url') !== k.x || Buffer.from(y).toString('base64url') !== k.y) throw new Error('the credential key differs from the public key');
  const att = decode(unb64u(a.attestationObject)) as Map<string, unknown>;
  if (!(att instanceof Map) || att.get('fmt') !== 'none' || !(att.get('authData') instanceof Uint8Array) || !eq(att.get('authData') as Uint8Array, authData)) throw new Error('the attestation object is not "none" around this authenticator data');
  return { authData, spki: new Uint8Array(Buffer.from(a.publicKey, 'base64')), attestationObject: encode(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])) };
}

/** A device's assertion, checked against the key it registered: this credential, this rpId, UP and UV, a good signature. */
export async function checkAsserted(a: GetAnswer, cred: { id: string; rpId: string; publicKey: string }, clientDataJSON: Uint8Array): Promise<{ counter: number }> {
  if (a.credentialId !== cred.id) throw new Error('the assertion is for another credential');
  const authData = unb64u(a.authenticatorData);
  const ad = parseAuthData(authData);
  if (!eq(ad.rpIdHash, await sha256(new TextEncoder().encode(cred.rpId)))) throw new Error('the authenticator data is for another rpId');
  if ((ad.flags & 0x05) !== 0x05) throw new Error('the authenticator data lacks UP or UV');
  const { key } = await p256Key(cred.publicKey);
  const data = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSignature(unb64u(a.signature)) as BufferSource, data as BufferSource);
  if (!ok) throw new Error('the signature does not verify');
  return { counter: ad.counter };
}

/** SHA-256 of an SPKI, first 8 bytes as lowercase hex pairs with colons ("3f:a1:…"): what the page and the app show. */
export async function fingerprint(spki: string | Uint8Array): Promise<string> {
  const bytes = typeof spki === 'string' ? new Uint8Array(Buffer.from(spki, 'base64')) : spki;
  return [...(await sha256(bytes)).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(':');
}
