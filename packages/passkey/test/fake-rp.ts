/**
 * A relying party's side of WebAuthn, written independently of the authenticator (node:crypto, not WebCrypto; its own
 * parsing of authenticator data): registers a credential from an attestation and checks assertions against it, as a
 * server like Privacy's would. Tests only. `topOrigin`: the relying party's page is a frame on that top page, so the
 * client data must say crossOrigin and name it (as Chromium writes it for a cross-origin frame); without it, the
 * client data must say crossOrigin false.
 */
import { createHash, createPublicKey, type KeyObject, randomBytes, verify } from 'node:crypto';
import { decode } from '../src/cbor.ts';

export interface Registered {
  id: string;
  key: KeyObject;
  alg: number;
  counter: number;
  userHandle: string;
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

function parseAuthData(a: Uint8Array) {
  if (a.length < 37) throw new Error('authData too short');
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const out: { rpIdHash: Uint8Array; flags: number; counter: number; credId?: Uint8Array; cose?: Map<number | string, unknown>; aaguid?: Uint8Array } = {
    rpIdHash: a.slice(0, 32),
    flags: a[32]!,
    counter: view.getUint32(33),
  };
  if (out.flags & 0x40) {
    out.aaguid = a.slice(37, 53);
    const len = view.getUint16(53);
    out.credId = a.slice(55, 55 + len);
    out.cose = decode(a.slice(55 + len)) as Map<number | string, unknown>;
  }
  return out;
}

function keyFromCose(cose: Map<number | string, unknown>): { key: KeyObject; alg: number } {
  const alg = cose.get(3) as number;
  const x = cose.get(-2) as Uint8Array;
  if (cose.get(1) === 2 && alg === -7 && cose.get(-1) === 1) {
    const y = cose.get(-3) as Uint8Array;
    return { alg, key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' }) };
  }
  if (cose.get(1) === 1 && alg === -8 && cose.get(-1) === 6) return { alg, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(x) }, format: 'jwk' }) };
  throw new Error('unsupported COSE key');
}

export class FakeRp {
  creds = new Map<string, Registered>();
  constructor(
    readonly rpId: string,
    readonly origin: string,
    readonly topOrigin?: string,
  ) {}

  private where(cd: { origin?: unknown; crossOrigin?: unknown; topOrigin?: unknown }) {
    if (cd.origin !== this.origin) throw new Error(`wrong origin ${cd.origin}`);
    if (cd.crossOrigin !== !!this.topOrigin) throw new Error(`crossOrigin ${cd.crossOrigin}, expected ${!!this.topOrigin}`);
    if ((cd.topOrigin ?? undefined) !== this.topOrigin) throw new Error(`wrong topOrigin ${cd.topOrigin}`);
  }

  challenge(): string {
    return b64u(randomBytes(32));
  }

  register(challenge: string, r: { id: string; clientDataJSON: string; attestationObject: string; publicKey: string; publicKeyAlgorithm: number }, userHandle: string): Registered {
    const cd = JSON.parse(Buffer.from(r.clientDataJSON, 'base64url').toString('utf8'));
    if (cd.type !== 'webauthn.create') throw new Error('wrong clientData type');
    if (cd.challenge !== challenge) throw new Error('wrong challenge');
    this.where(cd);
    const att = decode(unb64u(r.attestationObject)) as Map<string, unknown>;
    if (att.get('fmt') !== 'none') throw new Error('not none attestation');
    if (!(att.get('attStmt') instanceof Map) || (att.get('attStmt') as Map<string, unknown>).size) throw new Error('none attestation must have an empty statement');
    const ad = parseAuthData(att.get('authData') as Uint8Array);
    if (Buffer.compare(ad.rpIdHash, createHash('sha256').update(this.rpId).digest())) throw new Error('rpIdHash mismatch');
    if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error('UP and UV must be set');
    if (b64u(ad.credId!) !== r.id) throw new Error('credential id mismatch');
    if (ad.aaguid!.some((b) => b !== 0)) throw new Error('none attestation should carry a zero AAGUID');
    const { key, alg } = keyFromCose(ad.cose!);
    if (alg !== r.publicKeyAlgorithm) throw new Error('algorithm mismatch');
    // getPublicKey() must be the same key as the COSE one.
    const spki = createPublicKey({ key: Buffer.from(r.publicKey, 'base64url'), format: 'der', type: 'spki' });
    if (!spki.equals(key)) throw new Error('getPublicKey differs from the attested key');
    const reg = { id: r.id, key, alg, counter: ad.counter, userHandle };
    this.creds.set(r.id, reg);
    return reg;
  }

  /** Checks an assertion; returns the new counter. */
  authenticate(challenge: string, r: { id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null }): number {
    const reg = this.creds.get(r.id);
    if (!reg) throw new Error('unknown credential');
    const cdBytes = unb64u(r.clientDataJSON);
    const cd = JSON.parse(Buffer.from(cdBytes).toString('utf8'));
    if (cd.type !== 'webauthn.get') throw new Error('wrong clientData type');
    if (cd.challenge !== challenge) throw new Error('wrong challenge');
    this.where(cd);
    const adBytes = unb64u(r.authenticatorData);
    const ad = parseAuthData(adBytes);
    if (Buffer.compare(ad.rpIdHash, createHash('sha256').update(this.rpId).digest())) throw new Error('rpIdHash mismatch');
    if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error('UP and UV must be set');
    if (r.userHandle !== reg.userHandle) throw new Error('userHandle mismatch');
    const data = Buffer.concat([adBytes, createHash('sha256').update(cdBytes).digest()]);
    const ok = reg.alg === -7 ? verify('sha256', data, reg.key, unb64u(r.signature)) : verify(null, data, reg.key, unb64u(r.signature));
    if (!ok) throw new Error('bad signature');
    if ((ad.counter || reg.counter) && ad.counter <= reg.counter) throw new Error(`counter went from ${reg.counter} to ${ad.counter}: cloned authenticator`);
    reg.counter = ad.counter;
    return ad.counter;
  }
}
