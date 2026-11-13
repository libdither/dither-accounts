/**
 * A stand-in for the manager's two approver routes (docs/approver.md), for checking dither-approver end to end on an
 * emulator: `POST /approver/pair` with a code it prints, and the link at `GET /approver/ws`. Once a device says hello
 * it sends a short scenario of requests with real clientDataJSON and checks each answer with WebCrypto (and again
 * with packages/passkey's independent relying party, fake-rp.ts), printing pass or fail. Nothing here is the manager:
 * no registry file, no accounts, no pages; everything lives in memory and ends with the process.
 *
 *   bun apps/android/tools/fake-manager.ts [--port 9120] [--url http://10.0.2.2:9120] [--no-wake]
 *
 * The scenario, in order (each request waits up to 3 minutes for its answer):
 *   1. refused      a get whose clientDataJSON names another origin: refused without a prompt
 *   2. create       rpId www.schwab.com from client.schwab.com (a related origin): approve it
 *   3. get          that credential: approve it (counter 1)
 *   4. unknown      a get for a credential the phone doesn't hold: unknown-credential without a prompt
 *   5. deny         a get: tap Deny
 *   6. wake         (unless --no-wake) queued until a new link opens after the current one closes: put the app in
 *                   the background, then wake it (a push, or the debug build's adb broadcast); approve (counter 2)
 * The ping every 30 s and the pong are checked along the way, and a {t:"push"} endpoint is printed when it comes.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { decode } from '../../../packages/passkey/src/cbor.ts';
import { FakeRp } from '../../../packages/passkey/test/fake-rp.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt('--port') ?? 9120);
if (!(port >= 9120 && port <= 9129)) throw new Error('--port must be 9120 to 9129');
const publicUrl = (opt('--url') ?? `http://10.0.2.2:${port}`).replace(/\/$/, '');
const wake = !args.includes('--no-wake');

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const concat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p));
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

/** WebAuthn's DER ECDSA signature as WebCrypto's r ‖ s. */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('signature is not a DER SEQUENCE');
  let p = 2;
  const int = () => {
    if (der[p] !== 0x02) throw new Error('signature: expected INTEGER');
    const len = der[p + 1]!;
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error('signature: integer too long');
    return concat(new Uint8Array(32 - v.length), v);
  };
  const r = int();
  const s = int();
  if (p !== der.length) throw new Error('signature: trailing bytes');
  return concat(r, s);
}

async function verifyDer(spki: Uint8Array, data: Uint8Array, der: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(der) as BufferSource, data as BufferSource);
}

// ---------------------------------------------------------------- pairing

const code = b64u(randomBytes(16));
const codeExpires = Date.now() + 10 * 60_000;
let codeUsed = false;
interface Device {
  id: string;
  name: string;
  spki: Uint8Array;
  push: string | null;
}
const devices = new Map<string, Device>();

async function pair(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { code?: unknown; name?: unknown; publicKey?: unknown } | null;
  const given = Buffer.from(String(body?.code ?? ''));
  const want = Buffer.from(code);
  const ok = !codeUsed && Date.now() < codeExpires && given.length === want.length && timingSafeEqual(given, want);
  if (!ok) {
    log('pair: refused (wrong, used or expired code)');
    return Response.json({ error: 'bad code' }, { status: 403 });
  }
  let spki: Uint8Array;
  try {
    spki = unb64(String(body!.publicKey));
    await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return Response.json({ error: 'publicKey is not a P-256 SPKI' }, { status: 400 });
  }
  codeUsed = true;
  const id = 'dev_' + b64u(randomBytes(12));
  devices.set(id, { id, name: String(body!.name ?? '').slice(0, 80), spki, push: null });
  const fp = [...(await sha256(spki)).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  log(`pair: ${id} "${devices.get(id)!.name}", key fingerprint ${fp}`);
  check('pair', true, `fingerprint ${fp} (compare with the app)`);
  return Response.json({ deviceId: id });
}

// ---------------------------------------------------------------- the scenario

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

const rpId = 'www.schwab.com';
const origin = 'https://client.schwab.com';
const rp = new FakeRp(rpId, origin);
const userId = b64u(randomBytes(16));
let credentialId: string | null = null;
let credentialSpki: Uint8Array | null = null;

interface Step {
  name: string;
  /** Only on a link opened after the one that answered the previous step closed. */
  newLink?: boolean;
  build(): Promise<{ request: Record<string, unknown>; challenge: string; cdj: Uint8Array }>;
  check(res: Record<string, unknown>, challenge: string, cdj: Uint8Array): Promise<string | null>;
}

const account = { id: 'schwab-test', label: 'Test brokerage', kind: 'schwab' };

function clientData(type: string, challenge: string, o = origin): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
}

function request(id: string, op: 'create' | 'get', cdj: Uint8Array, extra: Record<string, unknown>, reason: string): Record<string, unknown> {
  return { t: 'request', id, op, account, reason, rpId, origin, clientDataJSON: b64u(cdj), expiresAt: Date.now() + 3 * 60_000, ...extra };
}

const refusal = (want: string) => async (res: Record<string, unknown>) =>
  res.ok === false && res.reason === want ? null : `expected ok:false reason ${want}, got ${JSON.stringify(res)}`;

const getStep = (name: string, reason: string, counter: number, newLink = false): Step => ({
  name,
  newLink,
  async build() {
    const challenge = rp.challenge();
    const cdj = clientData('webauthn.get', challenge);
    return { challenge, cdj, request: request(`req-${name}-${b64u(randomBytes(4))}`, 'get', cdj, { get: { allow: [credentialId] } }, reason) };
  },
  async check(res, challenge, cdj) {
    if (res.ok !== true) return `not ok: ${JSON.stringify(res)}`;
    if (res.credentialId !== credentialId) return 'credentialId differs';
    const ad = unb64u(String(res.authenticatorData));
    if (ad.length !== 37) return `authenticatorData is ${ad.length} bytes, not 37`;
    if (hex(ad.slice(0, 32)) !== hex(await sha256(new TextEncoder().encode(rpId)))) return 'rpIdHash';
    if (ad[32] !== 0x05) return `flags 0x${ad[32]!.toString(16)}, not 0x05`;
    const count = new DataView(ad.buffer, ad.byteOffset).getUint32(33);
    if (count !== counter) return `counter ${count}, expected ${counter}`;
    if (res.userHandle !== userId) return 'userHandle differs';
    if (!(await verifyDer(credentialSpki!, concat(ad, await sha256(cdj)), unb64u(String(res.signature))))) return 'signature does not verify (WebCrypto)';
    try {
      rp.authenticate(challenge, { id: String(res.credentialId), clientDataJSON: b64u(cdj), authenticatorData: String(res.authenticatorData), signature: String(res.signature), userHandle: res.userHandle as string | null });
    } catch (e) {
      return `fake-rp refused: ${(e as Error).message}`;
    }
    return null;
  },
});

const steps: Step[] = [
  {
    name: 'refused',
    async build() {
      const challenge = rp.challenge();
      const cdj = clientData('webauthn.get', challenge, 'https://evil.example');
      return { challenge, cdj, request: request(`req-refused-${b64u(randomBytes(4))}`, 'get', cdj, { get: { allow: [] } }, 'A request whose page is another site') };
    },
    check: refusal('refused'),
  },
  {
    name: 'create',
    async build() {
      const challenge = rp.challenge();
      const cdj = clientData('webauthn.create', challenge);
      const create = { rp: { id: rpId, name: 'Test brokerage' }, user: { id: userId, name: 'tester', displayName: 'Tester' }, algs: [-7] };
      return { challenge, cdj, request: request(`req-create-${b64u(randomBytes(4))}`, 'create', cdj, { create }, 'Add a passkey (emulator check)') };
    },
    async check(res, challenge, cdj) {
      if (res.ok !== true) return `not ok: ${JSON.stringify(res)}`;
      const id = String(res.credentialId);
      if (unb64u(id).length !== 32) return 'credentialId is not 32 bytes';
      const spki = unb64(String(res.publicKey));
      const att = decode(unb64u(String(res.attestationObject))) as Map<string, unknown>;
      if ([...att.keys()].join(',') !== 'fmt,attStmt,authData') return `attestationObject keys ${[...att.keys()]}`;
      if (att.get('fmt') !== 'none' || (att.get('attStmt') as Map<string, unknown>).size !== 0) return 'not none attestation';
      const ad = att.get('authData') as Uint8Array;
      if (b64u(ad) !== res.authenticatorData) return 'authenticatorData differs from the one in the attestation';
      if (hex(ad.slice(0, 32)) !== hex(await sha256(new TextEncoder().encode(rpId)))) return 'rpIdHash';
      if (ad[32] !== 0x45) return `flags 0x${ad[32]!.toString(16)}, not 0x45`;
      if (hex(ad.slice(33, 53)) !== '00'.repeat(20)) return 'counter or AAGUID not zero';
      if (((ad[53]! << 8) | ad[54]!) !== 32 || b64u(ad.slice(55, 87)) !== id) return 'credential id in authData';
      const cose = decode(ad.slice(87)) as Map<number, unknown>;
      if ([...cose.keys()].join(',') !== '1,3,-1,-2,-3' || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) return 'COSE key header';
      const jwk = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']));
      if (jwk.x !== b64u(cose.get(-2) as Uint8Array) || jwk.y !== b64u(cose.get(-3) as Uint8Array)) return 'COSE key is not the SPKI key';
      try {
        rp.register(challenge, { id, clientDataJSON: b64u(cdj), attestationObject: String(res.attestationObject), publicKey: b64u(spki), publicKeyAlgorithm: -7 }, userId);
      } catch (e) {
        return `fake-rp refused: ${(e as Error).message}`;
      }
      credentialId = id;
      credentialSpki = spki;
      return null;
    },
  },
  getStep('get', 'Sign in for the daily statements pull', 1),
  {
    name: 'unknown',
    async build() {
      const challenge = rp.challenge();
      const cdj = clientData('webauthn.get', challenge);
      return { challenge, cdj, request: request(`req-unknown-${b64u(randomBytes(4))}`, 'get', cdj, { get: { allow: [b64u(randomBytes(32))] } }, 'A passkey the phone does not hold') };
    },
    check: refusal('unknown-credential'),
  },
  { ...getStep('deny', 'Tap Deny on this one', 0), check: refusal('denied') },
  ...(wake ? [getStep('wake', 'Sent while the app slept: approve after the wake-up', 2, true)] : []),
];

// ---------------------------------------------------------------- the link

interface Link {
  device: Device | null;
  nonce: string;
  ready: boolean;
  lastFrame: number;
  serial: number;
}
let linkSerial = 0;
let current: ServerWebSocket<Link> | null = null;
let stepIndex = 0;
let outstanding: { step: Step; challenge: string; cdj: Uint8Array; id: string; request: Record<string, unknown>; sentOn: number } | null = null;
/** The link serial that answered the last step: a newLink step waits for a later one. */
let answeredOn = 0;
let pongs = 0;
let pings = 0;

async function next() {
  const ws = current;
  if (!ws || !ws.data.ready || outstanding) return;
  const step = steps[stepIndex];
  if (!step) return finish();
  if (!credentialId && stepIndex > steps.findIndex((s) => s.name === 'create')) {
    check(step.name, false, 'skipped: no credential (create did not pass)');
    stepIndex++;
    return next();
  }
  if (step.newLink && ws.data.serial <= answeredOn) {
    log(`next: "${step.name}" waits for a new link. Put the app in the background (the link closes), then wake it.`);
    return;
  }
  const { request: r, challenge, cdj } = await step.build();
  outstanding = { step, challenge, cdj, id: String(r.id), request: r, sentOn: ws.data.serial };
  log(`-> request ${step.name} (${r.op})`);
  ws.send(JSON.stringify(r));
  const id = String(r.id);
  setTimeout(() => {
    if (outstanding?.id === id) {
      check(step.name, false, 'no answer before it expired');
      outstanding = null;
      stepIndex++;
      void next();
    }
  }, 3 * 60_000 + 5000);
}

function finish() {
  check('ping/pong', pings === 0 || pongs > 0, `${pings} pings, ${pongs} pongs`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${failed.length ? `: ${failed.map((f) => f.name).join(', ')}` : ''}`);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 200);
}

const server = Bun.serve<Link>({
  hostname: '0.0.0.0',
  port,
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/approver/pair' && req.method === 'POST') return pair(req);
    if (u.pathname === '/approver/ws') {
      if (srv.upgrade(req, { data: { device: null, nonce: b64u(randomBytes(32)), ready: false, lastFrame: Date.now(), serial: ++linkSerial } })) return undefined;
      return new Response('expected a WebSocket', { status: 400 });
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      log(`link ${ws.data.serial}: open`);
      ws.send(JSON.stringify({ t: 'challenge', nonce: ws.data.nonce }));
    },
    async message(ws, raw) {
      ws.data.lastFrame = Date.now();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(raw));
      } catch {
        ws.close(1003, 'not JSON');
        return;
      }
      if (!ws.data.ready) {
        if (m.t !== 'hello') {
          ws.close(4401, 'hello first');
          return;
        }
        const dev = devices.get(String(m.deviceId));
        const input = new TextEncoder().encode(`dither-approver-v1\n${m.deviceId}\n${ws.data.nonce}`);
        let ok = false;
        try {
          ok = !!dev && (await verifyDer(dev.spki, input, unb64u(String(m.sig))));
        } catch {}
        check(`hello (link ${ws.data.serial})`, ok, `deviceId ${m.deviceId}, app ${m.app}`);
        if (!ok) {
          ws.close(4401, 'unknown device or bad signature');
          return;
        }
        ws.data.device = dev!;
        ws.data.ready = true;
        current?.close(1000, 'replaced');
        current = ws;
        ws.send(JSON.stringify({ t: 'ready', name: 'fake-manager' }));
        // A request that was out on a link that closed goes again, the same, on this one (the app drops repeats).
        // With under a minute left it is made anew instead (a new id and challenge), so there is time to answer.
        if (outstanding && outstanding.sentOn !== ws.data.serial) {
          if (Number(outstanding.request.expiresAt) - Date.now() > 60_000) {
            log(`-> request ${outstanding.step.name} again on the new link`);
            outstanding.sentOn = ws.data.serial;
            ws.send(JSON.stringify(outstanding.request));
            return;
          }
          log(`-> request ${outstanding.step.name} made anew on the new link (the old one is about to expire)`);
          outstanding = null;
        }
        return next();
      }
      switch (m.t) {
        case 'pong':
          pongs++;
          return;
        case 'ping':
          ws.send(JSON.stringify({ t: 'pong' }));
          return;
        case 'push':
          ws.data.device!.push = (m.endpoint as string | null) ?? null;
          check('push endpoint', m.endpoint === null || /^https?:\/\//.test(String(m.endpoint)), String(m.endpoint));
          return;
        case 'response': {
          const o = outstanding;
          if (!o || m.id !== o.id) return log(`<- a response for ${m.id}, not outstanding: dropped`);
          outstanding = null;
          const why = await o.step.check(m, o.challenge, o.cdj).catch((e) => `threw: ${(e as Error).message}`);
          check(o.step.name, why === null, why ?? (m.ok ? 'ok' : String(m.reason)));
          answeredOn = ws.data.serial;
          stepIndex++;
          return next();
        }
        default:
          log(`<- ${m.t}: ignored`);
      }
    },
    close(ws, code) {
      log(`link ${ws.data.serial}: closed ${code}`);
      if (current === ws) {
        current = null;
        const step = steps[stepIndex];
        if (wake && step?.newLink && !outstanding) {
          const dev = ws.data.device;
          log(`a request waits and the device has no link: would POST {"t":"wake"} to ${dev?.push ?? '(no endpoint)'}`);
          log('  on the debug build: adb shell am broadcast -a org.libdither.approver.DEBUG_PUSH -n org.libdither.approver/.DebugPushReceiver --es wake \'{"t":"wake"}\'');
        }
      }
    },
  },
});

setInterval(() => {
  if (current?.data.ready) {
    pings++;
    current.send(JSON.stringify({ t: 'ping' }));
  }
  if (current && Date.now() - current.data.lastFrame > 90_000) current.close(1001, 'silent for 90 s');
}, 30_000);

console.log(`fake-manager on 0.0.0.0:${server.port}`);
console.log(`pairing link (good 10 minutes, once):\n  dither-approver://pair?url=${encodeURIComponent(publicUrl)}&code=${code}\n`);
