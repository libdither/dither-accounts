/**
 * A fake dither-approver (docs/approver.md), the phone's side of the protocol in TypeScript with WebCrypto keys, for
 * tests against a real manager: pairing, the link (challenge, signed hello, push, ping), and requests checked the way
 * the app checks them before it shows them, then answered by `decide` (approve, deny, refuse, or hold on to it). Keys
 * stay in memory; nothing is saved. Tests only.
 */
import { b64u, derSignature } from '../src/authenticator.ts';
import { type Cbor, encode } from '../src/cbor.ts';

type Json = Record<string, any>;
export type Decision = 'approve' | 'deny' | 'ignore' | { reason: string; message?: string };

export interface HeldCredential {
  id: string;
  rpId: string;
  key: CryptoKeyPair;
  counter: number;
  userHandle: string;
  manager: string;
  deviceId: string;
  label: string;
}

const enc = new TextEncoder();
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const p256 = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
const sign = async (key: CryptoKey, data: Uint8Array) => derSignature(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data as BufferSource)));
/** The doc's registrable-domain rule, roughly: the last two labels (the app uses the public suffix list). */
const site = (host: string) => host.split('.').slice(-2).join('.');

export class FakeDevice {
  deviceId: string | null = null;
  manager = '';
  creds: HeldCredential[] = [];
  /** Every request that reached it, and every message it got. */
  requests: Json[] = [];
  received: Json[] = [];
  /** Why it refused one without asking (the app's line about it). */
  refusals: string[] = [];
  /** What "you" answer when a request passes the checks. */
  decide: (r: Json) => Decision = () => 'approve';
  /** Take http://localhost origins too, for the browser tests' fake sites (the app wants https). */
  httpLocalhost = false;
  ws: WebSocket | null = null;
  closed: { code: number; reason: string } | null = null;
  ready = false;

  private constructor(
    readonly name: string,
    readonly identity: CryptoKeyPair,
    readonly spki: string,
  ) {}

  static async make(name = 'Fake phone'): Promise<FakeDevice> {
    const identity = await p256();
    return new FakeDevice(name, identity, Buffer.from(await crypto.subtle.exportKey('spki', identity.publicKey)).toString('base64'));
  }

  /** What the app reads from the QR: dither-approver://pair?url=…&code=… */
  static parseLink(link: string): { url: string; code: string } {
    const u = new URL(link);
    if (u.protocol !== 'dither-approver:' || u.host !== 'pair') throw new Error(`not a pairing link: ${link}`);
    return { url: u.searchParams.get('url')!, code: u.searchParams.get('code')! };
  }

  /** POST <url>/approver/pair. `base` is where the test reaches the manager (the link's url is its public one). */
  async pair(base: string, code: string, name = this.name): Promise<Response> {
    const r = await fetch(`${base}/approver/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, publicKey: this.spki }) });
    if (r.ok) {
      this.deviceId = ((await r.clone().json()) as { deviceId: string }).deviceId;
      this.manager = base;
    }
    return r;
  }

  /**
   * Opens the link and says hello; resolves with `ready`'s name, or rejects with the close code. `signWith` signs the
   * hello with another key (a bad signature); `as` claims another device id.
   */
  connect(base = this.manager, o: { signWith?: CryptoKey; as?: string; push?: string | null } = {}): Promise<string> {
    this.ready = false;
    this.closed = null;
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/approver/ws`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onmessage = async (e) => {
        const m = JSON.parse(String(e.data)) as Json;
        this.received.push(m);
        if (m.t === 'challenge') {
          const id = o.as ?? this.deviceId!;
          const sig = await sign(o.signWith ?? this.identity.privateKey, enc.encode(`dither-approver-v1\n${id}\n${m.nonce}`));
          ws.send(JSON.stringify({ t: 'hello', deviceId: id, sig: b64u(sig), app: 'fake-device/1' }));
        } else if (m.t === 'ready') {
          this.ready = true;
          if (o.push !== undefined) ws.send(JSON.stringify({ t: 'push', endpoint: o.push }));
          resolve(m.name);
        } else if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
        else if (m.t === 'request') void this.onRequest(m);
      };
      ws.onclose = (e) => {
        this.ready = false;
        this.closed = { code: e.code, reason: e.reason };
        reject(Object.assign(new Error(`closed ${e.code} ${e.reason}`), { code: e.code }));
      };
      ws.onerror = () => {};
    });
  }

  send(m: Json) {
    this.ws!.send(JSON.stringify(m));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  private refused(r: Json, why: string): Json {
    this.refusals.push(why);
    return { t: 'response', id: r.id, ok: false, reason: 'refused' };
  }

  /** The app's checks, then you; the answer goes back on the link (none while `decide` holds on to it). */
  private async onRequest(r: Json) {
    const a = await this.answer(r);
    if (a) this.send(a);
  }

  /**
   * One request, checked as the app checks it, then decided: the response the app would send, or null when `decide`
   * holds on to it. Tests that stand in for the manager call this directly (test/approver-signin.test.ts).
   */
  async answer(r: Json): Promise<Json | null> {
    this.requests.push(r);
    let cd: Json;
    try {
      cd = JSON.parse(Buffer.from(String(r.clientDataJSON), 'base64url').toString('utf8'));
    } catch {
      return this.refused(r, 'clientDataJSON does not parse');
    }
    if (cd.type !== `webauthn.${r.op}`) return this.refused(r, 'clientDataJSON type');
    if (cd.origin !== r.origin) return this.refused(r, 'clientDataJSON origin');
    let host: string;
    try {
      const u = new URL(r.origin);
      if (u.protocol !== 'https:' && !(this.httpLocalhost && u.protocol === 'http:' && u.hostname === 'localhost')) return this.refused(r, 'not https');
      host = u.hostname;
    } catch {
      return this.refused(r, 'origin');
    }
    if (host !== r.rpId && !host.endsWith(`.${r.rpId}`) && site(host) !== site(r.rpId)) return this.refused(r, 'rpId');
    if (typeof r.expiresAt !== 'number' || r.expiresAt < Date.now()) return { t: 'response', id: r.id, ok: false, reason: 'expired' };
    let cred: HeldCredential | undefined;
    if (r.op === 'get') {
      const allow: string[] = r.get?.allow ?? [];
      cred = this.creds.find((c) => c.rpId === r.rpId && c.deviceId === this.deviceId && c.manager === this.manager && (!allow.length || allow.includes(c.id)));
      if (!cred) return { t: 'response', id: r.id, ok: false, reason: 'unknown-credential' };
    }
    const d = this.decide(r);
    if (d === 'ignore') return null;
    if (d === 'deny') return { t: 'response', id: r.id, ok: false, reason: 'denied' };
    if (typeof d === 'object') return { t: 'response', id: r.id, ok: false, ...d };
    return r.op === 'create' ? this.create(r) : this.get(r, cred!);
  }

  /** You said yes (also later, to a request `decide` held on to). */
  async approve(r: Json) {
    if (r.op === 'create') return this.send(await this.create(r));
    const allow: string[] = r.get?.allow ?? [];
    const cred = this.creds.find((c) => c.rpId === r.rpId && (!allow.length || allow.includes(c.id)));
    this.send(await this.get(r, cred!));
  }

  private async create(r: Json): Promise<Json> {
    const key = await p256();
    const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const cose = encode(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
      ]),
    );
    const authData = concat(await sha256(enc.encode(r.rpId)), Uint8Array.of(0x45), u32(0), new Uint8Array(16), Uint8Array.of(id.length >> 8, id.length & 0xff), id, cose);
    const att = encode(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    this.creds.push({ id: b64u(id), rpId: r.rpId, key, counter: 0, userHandle: r.create.user.id, manager: this.manager, deviceId: this.deviceId!, label: r.account.label });
    return { t: 'response', id: r.id, ok: true, credentialId: b64u(id), publicKey: Buffer.from(await crypto.subtle.exportKey('spki', key.publicKey)).toString('base64'), authenticatorData: b64u(authData), attestationObject: b64u(att) };
  }

  private async get(r: Json, c: HeldCredential): Promise<Json> {
    c.counter += 1;
    const authData = concat(await sha256(enc.encode(r.rpId)), Uint8Array.of(0x05), u32(c.counter));
    const cdj = new Uint8Array(Buffer.from(r.clientDataJSON, 'base64url'));
    const signature = await sign(c.key.privateKey, concat(authData, await sha256(cdj)));
    return { t: 'response', id: r.id, ok: true, credentialId: c.id, authenticatorData: b64u(authData), signature: b64u(signature), userHandle: c.userHandle };
  }
}
