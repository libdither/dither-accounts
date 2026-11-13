/**
 * A software WebAuthn authenticator for one relying party's domains (privacy.com, schwab.com), run in an extractor. The
 * account's browser extension answers the page's navigator.credentials.create/get by asking this (over the
 * token-gated loopback bridge, with the caller's origin, and its frame's ancestors, taken from Chromium's port sender,
 * not from the page), so the private key never enters the browser. docs/passkeys.md has the whole design.
 *
 * - Who may ask (callerFor, the kind's FramePolicy): `top`, the tab's top frame only (Privacy); `same-site`, the top
 *   frame or a subframe, as long as the frame and every frame above it are secure origins inside `domains` (Schwab's
 *   sign-in widget is served from sws-gateway*.schwab.com, possibly in a frame on www or client.schwab.com).
 * - create: refuses any rpId outside `domains`, and an rpId that is not the caller's host or a parent of it; picks the
 *   first algorithm in the relying party's list that it has (ES256, Ed25519); generates the key pair with WebCrypto;
 *   answers with "none" attestation (zero AAGUID, no statement); stores the credential before it answers.
 * - get: the stored credential the request allows (or the newest one for that rpId when it allows any); counter + 1,
 *   saved before the assertion is returned, so the counter only ever goes up; null when it has none to offer.
 * - clientDataJSON is what Chromium writes for that frame: `crossOrigin` true, with `topOrigin`, for a frame that is
 *   not same-origin with every frame above it.
 *
 * Flags: UP and UV always (the extension answers only the page's own calls on the kind's domains: that is the
 * presence and the verification); BE/BS never (the key lives in one file on one machine). Everything is serialized:
 * one operation at a time.
 *
 * Secrets (private keys, the counter, the user handle) stay in the store; summary() is what may be shown.
 *
 * Remote credentials (docs/approver.md) have no private key here: the key is on a paired phone. Every check above runs
 * first; then create (when the account keeps new passkeys on a device) and get (for a remote credential) go to the
 * device through the manager and wait, and the answer is checked before it goes to the page. Any refusal from the
 * device, and an answer that does not check out, is the NotAllowedError a cancelled prompt gives; the kind can tell it
 * apart (ApproverRefusal, with the reason) and stops signing in by itself (signin.ts).
 */
import { type Approver, type ApproverAsk, checkAsserted, checkCreated, type CreateAnswer, type GetAnswer, type Refusal } from './approver.ts';
import { type Cbor, encode } from './cbor.ts';

export type WebAuthnErrorName = 'NotAllowedError' | 'SecurityError' | 'InvalidStateError' | 'NotSupportedError' | 'AbortError';
export class WebAuthnError extends Error {
  constructor(
    readonly code: WebAuthnErrorName,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A paired phone said no, or its answer did not check out (docs/approver.md): the page gets the plain NotAllowedError
 * (code and message as any refusal); the kind sees the reason and the device, and stops signing in by itself.
 */
export class ApproverRefusal extends WebAuthnError {
  constructor(
    readonly reason: Refusal,
    /** The device's name as paired, or its id when the manager did not name it. */
    readonly device: string,
    readonly detail?: string,
  ) {
    super('NotAllowedError', `the approver on ${device} answered ${reason}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
}

export const ES256 = -7;
export const EDDSA = -8;
/** What this authenticator can make, by COSE algorithm id. */
export const SUPPORTED = [ES256, EDDSA] as const;
type Alg = (typeof SUPPORTED)[number];
export const ALG_NAMES: Record<number, string> = { [ES256]: 'ES256', [EDDSA]: 'Ed25519' };

export interface LocalCredential {
  /** base64url, as the relying party sees it. */
  id: string;
  rpId: string;
  alg: Alg;
  /** PKCS#8, base64. Secret. */
  privateKey: string;
  /** SPKI, base64. */
  publicKey: string;
  /** user.id from create, base64url. Returned with assertions (discoverable credential). */
  userHandle: string | null;
  signCount: number;
  createdAt: number;
  lastUsedAt: number | null;
  /** When a sign-in that used this credential was seen to succeed. */
  verifiedAt: number | null;
  device?: undefined;
}
/** A credential whose key is on a paired device (docs/approver.md): no private key, and the device keeps the counter. */
export interface RemoteCredential {
  id: string;
  rpId: string;
  alg: typeof ES256;
  /** SPKI, base64. */
  publicKey: string;
  userHandle: string | null;
  /** The approver device's id (`dev_…`). */
  device: string;
  createdAt: number;
  lastUsedAt: number | null;
  verifiedAt: number | null;
  privateKey?: undefined;
  signCount?: undefined;
}
export type StoredCredential = LocalCredential | RemoteCredential;

export interface PasskeyStore {
  load(): StoredCredential[];
  /** Must be durable (or throw) before it returns: an assertion is only handed out once its counter is saved. */
  save(creds: StoredCredential[]): void;
}

export interface Descriptor {
  type?: string;
  id: string;
}
export interface CreateOptions {
  rp: { id?: string; name?: string };
  user: { id: string; name?: string; displayName?: string };
  challenge: string;
  pubKeyCredParams?: { type?: string; alg: number }[];
  excludeCredentials?: Descriptor[];
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
  extensions?: Record<string, unknown>;
}
export interface GetOptions {
  rpId?: string;
  challenge: string;
  allowCredentials?: Descriptor[];
  userVerification?: string;
  extensions?: Record<string, unknown>;
}

/** What the page builds its PublicKeyCredential from (binary fields base64url). */
export interface CreateResult {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
  authenticatorData: string;
  publicKey: string;
  publicKeyAlgorithm: number;
  transports: string[];
  clientExtensionResults: Record<string, unknown>;
}
export interface GetResult {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
  clientExtensionResults: Record<string, unknown>;
}

/** Non-secret facts about the stored passkeys. */
export interface PasskeySummary {
  enrolled: boolean;
  count: number;
  newest: { idPrefix: string; rpId: string; algorithm: string; createdAt: number; lastUsedAt: number | null; verifiedAt: number | null; device?: string } | null;
}

// ---------------------------------------------------------------- encodings

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export function fromB64u(s: unknown, what: string): Uint8Array {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new WebAuthnError('NotAllowedError', `${what} is not base64url`);
  return new Uint8Array(Buffer.from(s, 'base64url'));
}
const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

/** WebAuthn wants ECDSA signatures as ASN.1 DER; WebCrypto gives r ‖ s. */
export function derSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = x.slice(i);
    return v[0]! & 0x80 ? concat(Uint8Array.of(0x02, v.length + 1, 0), v) : concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.slice(0, half)), int(raw.slice(half)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

/** Flags in authenticator data. */
export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

/** An origin as Chromium writes it into clientDataJSON: scheme, host and port. */
function originOf(origin: string): URL {
  try {
    return new URL(origin);
  } catch {
    throw new WebAuthnError('SecurityError', 'the caller has no usable origin');
  }
}

/** https, or http on localhost (and *.localhost), which only tests' `domains` name. */
function secure(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return u.protocol === 'https:' || (u.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost')));
}
const inDomains = (host: string, domains: readonly string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * The rpId a request may use: the one asked for (or the caller's host), which must be the caller's host or a parent
 * domain of it (WebAuthn's rule), and must be one of `domains` or under one. https only (http on localhost, for tests,
 * when `domains` names localhost).
 *
 * WebAuthn's related origin requests (Level 3, Chromium 128+): an rpId that is not the caller's domain is still allowed
 * when the relying party lists the caller's origin in `https://<rpId>/.well-known/webauthn` ({"origins": [...]}).
 * Schwab asks for rpId www.schwab.com on client.schwab.com. `related` is that list, as the caller fetched it; it is
 * only consulted for an rpId inside `domains` and a caller inside `domains` (stricter than WebAuthn, which lets any
 * listed origin in), and the caller's origin must be in it exactly.
 */
export function rpFor(origin: string, requested: unknown, domains: readonly string[], related?: readonly string[] | null): string {
  const u = originOf(origin);
  const host = u.hostname.toLowerCase();
  if (!secure(u)) throw new WebAuthnError('SecurityError', 'passkeys are only for https pages');
  if (requested !== undefined && requested !== null && typeof requested !== 'string') throw new WebAuthnError('SecurityError', 'the rpId is not text');
  const rp = (requested || host).toLowerCase();
  // Chromium's order: a foreign rpId is a SecurityError before anything else (related origins are only fetched, by the
  // kind, for an rpId inside `domains`, so `related` cannot let a foreign rpId past the next check).
  if (host !== rp && !host.endsWith(`.${rp}`) && !(inDomains(host, domains) && (related ?? []).includes(u.origin))) throw new WebAuthnError('SecurityError', `the rpId ${rp} is not this page's domain`);
  if (!inDomains(rp, domains)) throw new WebAuthnError('NotAllowedError', `this authenticator only answers for ${domains.join(', ')}`);
  return rp;
}

/** Whether rpFor would need the rpId's related origins for this caller (a well-formed rpId inside `domains` that is not the caller's domain). */
export function needsRelated(origin: string, requested: unknown, domains: readonly string[]): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (typeof requested !== 'string' || !requested) return null;
  const rp = requested.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(rp) || !inDomains(rp, domains) || !inDomains(host, domains)) return null;
  return host === rp || host.endsWith(`.${rp}`) ? null : rp;
}

/** Fetches `https://<rpId>/.well-known/webauthn` and gives its `origins` (as the browser would, not the page). */
export type RelatedOrigins = (rpId: string) => Promise<readonly string[]>;

/** Which frames of a tab may ask: the top frame only, or any frame whose whole chain is inside `domains`. */
export type FramePolicy = 'top' | 'same-site';

/** Who asks, as Chromium reports it to the extension's service worker (port.sender), never as the page says. */
export interface Caller {
  /** The asking frame's origin (port.sender.origin). */
  origin: string;
  /** It is the tab's top frame (port.sender.frameId 0). */
  top: boolean;
  /** The tab's top frame's origin (port.sender.tab.url). */
  topOrigin?: string | null;
  /** The origins of the frames above it, nearest first, the top last (chrome.webNavigation), when the extension can tell. */
  ancestors?: string[] | null;
}

/** What goes into clientDataJSON besides the type and challenge. */
export interface CallerOrigin {
  origin: string;
  crossOrigin: boolean;
  topOrigin: string | null;
}

/**
 * Whether this caller may ask at all, under `frames`, and how Chromium would describe it in clientDataJSON. A plain
 * string is a top frame's origin. For a subframe under `same-site`, the frame, every ancestor Chromium reported and the
 * top frame must each be a secure origin inside `domains`: a schwab.com frame in another site's page is refused, and so
 * is any frame of another site. Refusals are NotAllowedError (what Chromium's permission checks throw).
 */
export function callerFor(c: string | Caller, domains: readonly string[], frames: FramePolicy): CallerOrigin {
  const caller: Caller = typeof c === 'string' ? { origin: c, top: true } : c;
  const own = originOf(String(caller.origin ?? ''));
  if (caller.top) return { origin: own.origin, crossOrigin: false, topOrigin: null };
  if (frames === 'top') throw new WebAuthnError('NotAllowedError', 'passkeys are answered in the top frame only');
  if (!caller.topOrigin) throw new WebAuthnError('NotAllowedError', "a frame whose page Chromium did not report");
  const chain = [...(caller.ancestors ?? []), caller.topOrigin];
  for (const o of [String(caller.origin ?? ''), ...chain]) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new WebAuthnError('NotAllowedError', 'a frame in a page without a usable origin');
    }
    if (!secure(u)) throw new WebAuthnError('NotAllowedError', 'a frame on or in a page that is not https');
    if (!inDomains(u.hostname.toLowerCase(), domains)) throw new WebAuthnError('NotAllowedError', `a frame on or in ${u.hostname}, outside ${domains.join(', ')}`);
  }
  const top = originOf(caller.topOrigin).origin;
  const crossOrigin = chain.some((o) => originOf(o).origin !== own.origin);
  return { origin: own.origin, crossOrigin, topOrigin: crossOrigin ? top : null };
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, c: CallerOrigin): Uint8Array {
  // The order and form Chromium uses (topOrigin only for a cross-origin frame).
  const d: Record<string, unknown> = { type, challenge, origin: c.origin, crossOrigin: c.crossOrigin };
  if (c.crossOrigin && c.topOrigin) d.topOrigin = c.topOrigin;
  return new TextEncoder().encode(JSON.stringify(d));
}

async function newKey(alg: Alg): Promise<{ pair: CryptoKeyPair; cose: Uint8Array }> {
  if (alg === ES256) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const cose: Cbor = new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, ES256],
      [-1, 1], // crv: P-256
      [-2, fromB64u(jwk.x, 'x')],
      [-3, fromB64u(jwk.y, 'y')],
    ]);
    return { pair, cose: encode(cose) };
  }
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const cose: Cbor = new Map<number, Cbor>([
    [1, 1], // kty: OKP
    [3, EDDSA],
    [-1, 6], // crv: Ed25519
    [-2, raw],
  ]);
  return { pair, cose: encode(cose) };
}

async function sign(c: LocalCredential, data: Uint8Array): Promise<Uint8Array> {
  if (c.alg === ES256) {
    const key = await crypto.subtle.importKey('pkcs8', fromB64(c.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return derSignature(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data as BufferSource)));
  }
  const key = await crypto.subtle.importKey('pkcs8', fromB64(c.privateKey), { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, data as BufferSource));
}

// ---------------------------------------------------------------- the authenticator

export class Authenticator {
  private chain: Promise<unknown> = Promise.resolve();
  /** Highest counter handed out per credential in this process: the counter never goes back even if the file did. */
  private high = new Map<string, number>();

  constructor(
    private store: PasskeyStore,
    readonly domains: readonly string[],
    private now: () => number = Date.now,
    readonly frames: FramePolicy = 'top',
    private related?: RelatedOrigins,
    private approver?: Approver,
  ) {}

  /** The line a paired phone shows for why this account asks (a kind sets it: "Sign in for the daily statements pull"). */
  reasonFor: (op: 'create' | 'get') => string = (op) => (op === 'create' ? 'Add a passkey' : 'Sign in');

  /** One request to a device; its refusals are ApproverRefusal (a NotAllowedError). */
  private async ask(r: ApproverAsk, deviceName: string): Promise<CreateAnswer | GetAnswer> {
    const a = await this.approver!.request(r);
    if (!a.ok) throw new ApproverRefusal(a.reason, a.deviceName ?? deviceName, a.message);
    return a;
  }

  /** The related origins for this request's rpId, when it needs them and the kind can fetch them; [] when it cannot. */
  private async relatedFor(origin: string, requested: unknown): Promise<readonly string[] | null> {
    const rp = this.related ? needsRelated(origin, requested, this.domains) : null;
    if (!rp) return null;
    try {
      return await this.related!(rp);
    } catch {
      return [];
    }
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => {});
    return run;
  }

  private save(creds: StoredCredential[]) {
    try {
      this.store.save(creds);
    } catch (e) {
      throw new WebAuthnError('NotAllowedError', `the passkey could not be saved: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  create(caller: string | Caller, o: CreateOptions): Promise<CreateResult> {
    return this.serial(async () => {
      const who = callerFor(caller, this.domains, this.frames);
      if (!o || typeof o !== 'object' || !o.rp || !o.user) throw new WebAuthnError('NotAllowedError', 'malformed creation options');
      const rpId = rpFor(who.origin, o.rp.id, this.domains, await this.relatedFor(who.origin, o.rp.id));
      const challenge = fromB64u(o.challenge, 'challenge');
      if (!challenge.length) throw new WebAuthnError('NotAllowedError', 'empty challenge');
      const userId = fromB64u(o.user.id, 'user.id');
      if (userId.length < 1 || userId.length > 64) throw new WebAuthnError('NotAllowedError', 'user.id must be 1 to 64 bytes');
      const creds = this.store.load();
      const excluded = new Set((o.excludeCredentials ?? []).map((d) => d?.id));
      if (creds.some((c) => c.rpId === rpId && excluded.has(c.id))) throw new WebAuthnError('InvalidStateError', 'this browser already holds a passkey for this account');
      const params = (o.pubKeyCredParams ?? []).filter((p) => !p.type || p.type === 'public-key');
      // An empty list means ES256 or RS256 (WebAuthn's default); otherwise the relying party's order is its preference.
      const alg = (params.length ? params.map((p) => p.alg).find((a) => (SUPPORTED as readonly number[]).includes(a)) : ES256) as Alg | undefined;
      if (alg === undefined) throw new WebAuthnError('NotSupportedError', `none of the algorithms asked for is supported (${params.map((p) => p.alg).join(', ')}); this authenticator has ES256 and Ed25519`);
      const ext: Record<string, unknown> = {};
      if (o.extensions && typeof o.extensions === 'object' && 'credProps' in o.extensions && o.extensions.credProps) ext.credProps = { rk: true };

      // Kept on a paired phone: it makes the key; this side checks what it made and keeps the public half.
      let device: { id: string; name: string } | null = null;
      if (this.approver) {
        try {
          device = await this.approver.createDevice();
        } catch (e) {
          throw new WebAuthnError('NotAllowedError', `could not ask the manager which device keeps new passkeys: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        }
      }
      if (device) {
        if (params.length && !params.some((p) => p.alg === ES256)) throw new WebAuthnError('NotSupportedError', `the site does not take ES256, the only algorithm ${device.name} makes`);
        const cdj = clientData('webauthn.create', b64u(challenge), who);
        const a = (await this.ask(
          {
            op: 'create',
            device: device.id,
            reason: this.reasonFor('create'),
            rpId,
            origin: who.origin,
            clientDataJSON: b64u(cdj),
            create: { rp: { id: rpId, name: typeof o.rp.name === 'string' ? o.rp.name.slice(0, 200) : rpId }, user: { id: b64u(userId), name: String(o.user.name ?? '').slice(0, 200), displayName: String(o.user.displayName ?? '').slice(0, 200) }, algs: [ES256] },
          },
          device.name,
        )) as CreateAnswer;
        let made: Awaited<ReturnType<typeof checkCreated>>;
        try {
          made = await checkCreated(a, rpId);
        } catch (e) {
          throw new ApproverRefusal('error', device.name, `its new passkey did not check out: ${(e as Error).message}`);
        }
        const now = this.store.load();
        if (now.some((c) => c.id === a.credentialId)) throw new WebAuthnError('NotAllowedError', 'the approver made a credential id this account already has');
        const remote: RemoteCredential = { id: a.credentialId, rpId, alg: ES256, publicKey: b64(made.spki), userHandle: b64u(userId), device: device.id, createdAt: this.now(), lastUsedAt: null, verifiedAt: null };
        this.save([...now, remote]);
        return {
          id: remote.id,
          clientDataJSON: b64u(cdj),
          attestationObject: b64u(made.attestationObject),
          authenticatorData: b64u(made.authData),
          publicKey: b64u(made.spki),
          publicKeyAlgorithm: ES256,
          transports: ['internal'],
          clientExtensionResults: ext,
        };
      }

      const { pair, cose } = await newKey(alg);
      const idBytes = crypto.getRandomValues(new Uint8Array(32));
      const authData = concat(await sha256(new TextEncoder().encode(rpId)), Uint8Array.of(FLAG.UP | FLAG.UV | FLAG.AT), u32(0), new Uint8Array(16), Uint8Array.of(idBytes.length >> 8, idBytes.length & 0xff), idBytes, cose);
      const attestationObject = encode(
        new Map<string, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      const cdj = clientData('webauthn.create', b64u(challenge), who);
      const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
      const cred: LocalCredential = {
        id: b64u(idBytes),
        rpId,
        alg,
        privateKey: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
        publicKey: b64(spki),
        userHandle: b64u(userId),
        signCount: 0,
        createdAt: this.now(),
        lastUsedAt: null,
        verifiedAt: null,
      };
      this.save([...creds, cred]);
      this.high.set(cred.id, 0);
      return {
        id: cred.id,
        clientDataJSON: b64u(cdj),
        attestationObject: b64u(attestationObject),
        authenticatorData: b64u(authData),
        publicKey: b64u(new Uint8Array(spki)),
        publicKeyAlgorithm: alg,
        transports: ['internal'],
        clientExtensionResults: ext,
      };
    });
  }

  /** An assertion, or null when no stored credential fits (the browser may then try its own authenticators). */
  get(caller: string | Caller, o: GetOptions): Promise<GetResult | null> {
    return this.serial(async () => {
      const who = callerFor(caller, this.domains, this.frames);
      if (!o || typeof o !== 'object') throw new WebAuthnError('NotAllowedError', 'malformed request options');
      const rpId = rpFor(who.origin, o.rpId, this.domains, await this.relatedFor(who.origin, o.rpId));
      const challenge = fromB64u(o.challenge, 'challenge');
      if (!challenge.length) throw new WebAuthnError('NotAllowedError', 'empty challenge');
      const creds = this.store.load();
      const allowed = (o.allowCredentials ?? []).map((d) => d?.id).filter((x): x is string => typeof x === 'string');
      const fits = creds.filter((c) => c.rpId === rpId && (!allowed.length || allowed.includes(c.id)));
      if (!fits.length) return null;
      const cred = fits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));

      if (cred.device !== undefined) {
        // On a paired phone: it counts and signs; this side checks the signature against the key it registered.
        if (!this.approver) throw new WebAuthnError('NotAllowedError', 'this passkey is on a paired device, and this account cannot reach the approver');
        const cdj = clientData('webauthn.get', b64u(challenge), who);
        const a = (await this.ask({ op: 'get', device: cred.device, reason: this.reasonFor('get'), rpId, origin: who.origin, clientDataJSON: b64u(cdj), get: { allow: [cred.id] } }, cred.device)) as GetAnswer;
        try {
          await checkAsserted(a, cred, cdj);
        } catch (e) {
          throw new ApproverRefusal('error', cred.device, `its assertion did not check out: ${(e as Error).message}`);
        }
        this.save(this.store.load().map((c) => (c.id === cred.id ? { ...c, lastUsedAt: this.now() } : c)));
        return { id: cred.id, clientDataJSON: b64u(cdj), authenticatorData: a.authenticatorData, signature: a.signature, userHandle: cred.userHandle, clientExtensionResults: {} };
      }

      const count = Math.max(cred.signCount, this.high.get(cred.id) ?? 0) + 1;
      const authData = concat(await sha256(new TextEncoder().encode(rpId)), Uint8Array.of(FLAG.UP | FLAG.UV), u32(count));
      const cdj = clientData('webauthn.get', b64u(challenge), who);
      const signature = await sign(cred, concat(authData, await sha256(cdj)));
      this.high.set(cred.id, count);
      this.save(creds.map((c) => (c.id === cred.id ? { ...(c as LocalCredential), signCount: count, lastUsedAt: this.now() } : c)));
      return {
        id: cred.id,
        clientDataJSON: b64u(cdj),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: cred.userHandle,
        clientExtensionResults: {},
      };
    });
  }

  /** A sign-in that used this credential went through. */
  markVerified(id: string): Promise<void> {
    return this.serial(async () => {
      const creds = this.store.load();
      if (!creds.some((c) => c.id === id)) return;
      this.save(creds.map((c) => (c.id === id ? { ...c, verifiedAt: this.now() } : c)));
    });
  }

  summary(): PasskeySummary {
    return summarize(this.store.load());
  }
}

export function summarize(creds: StoredCredential[]): PasskeySummary {
  if (!creds.length) return { enrolled: false, count: 0, newest: null };
  const n = creds.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return {
    enrolled: true,
    count: creds.length,
    newest: { idPrefix: n.id.slice(0, 8), rpId: n.rpId, algorithm: ALG_NAMES[n.alg] ?? String(n.alg), createdAt: n.createdAt, lastUsedAt: n.lastUsedAt, verifiedAt: n.verifiedAt, ...(n.device ? { device: n.device } : {}) },
  };
}

/** Only what may be stored: drops anything that is not a well-formed credential (a hand-edited secret.json). */
export function validCredentials(v: unknown): StoredCredential[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is StoredCredential => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.rpId !== 'string' || typeof c.createdAt !== 'number') return false;
    // Remote: a device and a public key, never a private key or a counter.
    if (c.device !== undefined) return typeof c.device === 'string' && /^dev_[\w-]{1,64}$/.test(c.device) && c.alg === ES256 && typeof c.publicKey === 'string' && c.privateKey === undefined && c.signCount === undefined;
    return (SUPPORTED as readonly number[]).includes(c.alg) && typeof c.privateKey === 'string' && Number.isInteger(c.signCount) && c.signCount >= 0;
  });
}
