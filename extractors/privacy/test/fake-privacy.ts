/**
 * A stand-in for app.privacy.com on http://localhost:<port> (a secure context, so WebAuthn runs): /login and the
 * app's pages are one HTML page whose script asks the server what to do next (/api/next) and does it, as Privacy's
 * own pages would: sign in with a password, enroll a passkey from the settings page, sign out, sign in with the
 * passkey. The server checks every credential with FakeRp. Nothing here clicks: the page acts on its own, the way the
 * live site acts when you click.
 *
 * Steps (pushed by the test), each one action the page performs where it is:
 *   password     on /login: sets the session cookie, goes to /home
 *   badRp        on the app: create() with rp.id example.com; the error's name is recorded
 *   enroll       on the app: create() with the server's options; registered; the page checks the object's shape
 *   logout       on the app: clears the session, goes to /login
 *   passkey      on /login: get() with the server's options; checked; signs in; goes to /home
 *
 * And what the statements pull needs (no steps; these act as Privacy's pages do):
 *   - /login has a "Log in with Passkey" button: a click asks get() (allowCredentials empty: a discoverable
 *     credential), then signs in with a session cookie and a bearer token the app keeps in localStorage; with
 *     `tfa` on, the server wants an emailed code first and the page goes to /login/tfa (a code field), until the test
 *     approves it.
 *   - The app's pages check the session every second and go to /login once it has ended (`expire()`), as Privacy's do.
 *   - /transactions makes the app's own request, GET /api/v2/transactions?limit=25&fullInfo=true&transactionFilter=ALL
 *     with `Authorization: Bearer <token>` (by XMLHttpRequest, as axios does); the API wants the cookie and the token.
 *     Its rows are made from a seed, in Python-specific JSON (1.0, 1e-05, integers past 2^53, escapes, keys out of
 *     order, rows past the KEEP allowlist), newest first; the server counts four rows it never lists (as Privacy's
 *     total does, so the pager makes all four passes), and the second request of a pull sees one new row land on
 *     top (offset paging shifts). `resetTxns()` starts that over, so two pullers see the same answers.
 */
import { createPublicKey, randomBytes } from 'node:crypto';
import { FakeRp } from '../../../packages/passkey/test/fake-rp.ts';

export interface FakePrivacy {
  origin: string;
  rp: FakeRp;
  /** What happened, in order: 'password', 'badRp:SecurityError', 'enroll', 'shape:{...}', 'logout', 'passkey:1'. */
  log: string[];
  errors: string[];
  /** Queue steps; the page performs each where it belongs. */
  push(...steps: string[]): void;
  /** End every session (the app's pages go to /login within a second). */
  expire(): void;
  /** Ask for an emailed code after the passkey (the page goes to /login/tfa), until approveTfa(). */
  tfa: boolean;
  approveTfa(): void;
  /** Transactions API requests since resetTxns(): the query as sent, and whether cookie and token were right. */
  txnRequests: { query: string; ok: boolean }[];
  resetTxns(): void;
  /** Every bearer token handed out (to check none reaches the manager). */
  tokens: string[];
  /** A credential the relying party knows already (dither-finance's passkey, made in a test). */
  addCredential(c: { id: string; publicKeySpki: string; alg: number; userHandle: string }): void;
  stop(): void;
}

// ------------------------------------------------------------------ the transactions, as Privacy's JSON text
export const BASE_TXNS = 230;
const hex = (n: number, len: number) => {
  let x = (Math.imul(n + 1, 2654435761) + 0x9e3779b9) >>> 0;
  let out = '';
  while (out.length < len) {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 12345) >>> 0;
    out += x.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
};
const uuid = (n: number) => { const h = hex(n, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
/** Row i as Privacy might send it: keys in no particular order, values Python's JSON keeps apart from JavaScript's. */
export function txnJson(i: number): string {
  const day = 1 + (i % 28);
  const month = 1 + (Math.floor(i / 28) % 12);
  // Some rows share a time (the order then goes by uuid), some have none (they sort first).
  const date = i % 17 === 0 ? 'null' : `"2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(i % 3).padStart(2, '0')}:00:00Z"`;
  const amount = [`${-(i * 137) % 10000}`, '1.0', '12.5', '1e-05', '100000.0', '-0.0', `${i}.25`][i % 7];
  const memo = i % 5 === 0 ? '"note \\"quoted\\" back\\\\slash\\n tab\\t"' : i % 5 === 1 ? 'null' : `"caf\u00e9 \ud83c\udf55 #${i}"`;
  const refunds = i % 23 === 0 ? `[{"transactionUuid": "${uuid(10_000 + i)}", "amount": 5, "ipAddress": "10.1.2.3", "state": "SETTLED"}, 7, "x"]` : '[]';
  return `{"state": "${i % 11 === 0 ? 'DECLINED' : 'SETTLED'}", "transactionUuid": "${uuid(i)}", "amount": ${amount}, "settledAmount": ${i % 2 ? '12.50' : '12'}, "authorizationAmount": ${i % 4 === 0 ? '1.0' : `${i * 3}`}, "currency": "USD", "currencyRate": 1e-05, "totalFees": 0, "isEstimatedFee": false, "calculatedFees": {"10": 1, "2": 0.5, "fx": null}, "dateAuthorized": ${date}, "dateSettled": "2026-11-0${1 + (i % 9)}", "descriptor": "SHOP \u2615 ${i}", "memo": ${memo}, "mcc": "${5800 + (i % 50)}", "mccCategory": {"name": "Restaurants ${i % 4}", "code": "5812", "risk": 3}, "originalAuth": {"amount": 100, "date": "2026-10-01", "result": "APPROVED", "type": "AUTH", "uuid": "${uuid(20_000 + i)}", "authCode": "123456"}, "refunds": ${refunds}, "cardExpiry": "12/29", "ipAddress": "10.0.0.${i % 250}", "authCode": "999999", "riskScore": 0.73, "threeDS": {"token": "secret-${i}"}, "fundingAccount": {"uuid": "fund-1", "lastFour": "1234", "nickname": "Checking"}, "hasBounced": false, "accepted": ${i % 11 !== 0}, "transactionID": ${12345678901234567890n + BigInt(i)}, "lastFour": "4242", "cardUuid": "${uuid(30_000 + (i % 7))}", "network": "VISA", "city": "Portland", "country": "USA"}`;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Privacy (fake)</title></head>
<body><h1 id="h">Privacy (fake)</h1><pre id="s"></pre><script>
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
let busy = false;
async function step() {
  if (busy) return; busy = true;
  try {
    const next = await fetch('/api/next?path=' + encodeURIComponent(location.pathname)).then(r => r.json());
    document.getElementById('s').textContent = JSON.stringify(next.action);
    if (next.action === 'password') { await post('/api/password', {}); location.href = '/home'; return; }
    if (next.action === 'logout') { await post('/api/logout', {}); location.href = '/login'; return; }
    if (next.action === 'badRp' || next.action === 'enroll') {
      const o = next.options;
      const publicKey = { ...o, challenge: unb(o.challenge), user: { ...o.user, id: unb(o.user.id) }, excludeCredentials: [] };
      try {
        const c = await navigator.credentials.create({ publicKey });
        const shape = {
          isPKC: c instanceof PublicKeyCredential, type: c.type, attachment: c.authenticatorAttachment, idMatches: c.id === b64u(c.rawId),
          transports: c.response.getTransports(), alg: c.response.getPublicKeyAlgorithm(), hasKey: c.response.getPublicKey().byteLength > 0,
          json: JSON.parse(JSON.stringify(c)).response.attestationObject === b64u(c.response.attestationObject),
          ext: c.getClientExtensionResults(),
        };
        await post('/api/register', { step: next.action, shape, cred: { id: c.id, clientDataJSON: b64u(c.response.clientDataJSON), attestationObject: b64u(c.response.attestationObject), publicKey: b64u(c.response.getPublicKey()), publicKeyAlgorithm: c.response.getPublicKeyAlgorithm() } });
        location.href = '/settings/security';
      } catch (e) {
        await post('/api/error', { step: next.action, name: e && e.name, message: String(e && e.message) });
      }
      return;
    }
    if (next.action === 'passkey') {
      const o = next.options;
      try {
        const c = await navigator.credentials.get({ publicKey: { ...o, challenge: unb(o.challenge), allowCredentials: o.allowCredentials.map(d => ({ ...d, id: unb(d.id) })) } });
        const r = await post('/api/authenticate', { id: c.id, clientDataJSON: b64u(c.response.clientDataJSON), authenticatorData: b64u(c.response.authenticatorData), signature: b64u(c.response.signature), userHandle: c.response.userHandle ? b64u(c.response.userHandle) : null });
        if (r.ok) location.href = '/home';
      } catch (e) {
        await post('/api/error', { step: 'passkey', name: e && e.name, message: String(e && e.message) });
      }
      return;
    }
  } catch (e) {} finally { busy = false; }
}
setInterval(step, 400); step();
const path = location.pathname;
if (path === '/login') {
  const b = document.createElement('button');
  b.textContent = 'Log in with Passkey';
  b.onclick = async () => {
    try {
      const o = await fetch('/api/passkey/options').then(r => r.json());
      const c = await navigator.credentials.get({ publicKey: { rpId: o.rpId, challenge: unb(o.challenge), allowCredentials: [], userVerification: 'required' } });
      const r = await post('/api/authenticate', { id: c.id, clientDataJSON: b64u(c.response.clientDataJSON), authenticatorData: b64u(c.response.authenticatorData), signature: b64u(c.response.signature), userHandle: c.response.userHandle ? b64u(c.response.userHandle) : null });
      if (r.tfa) { location.href = '/login/tfa'; return; }
      if (r.ok) { localStorage.setItem('token', r.token); location.href = '/home'; }
    } catch (e) {
      await post('/api/error', { step: 'button', name: e && e.name, message: String(e && e.message) });
    }
  };
  const f = document.createElement('form');
  f.innerHTML = '<input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password">';
  document.body.append(f, b);
} else if (path === '/login/tfa') {
  document.getElementById('h').textContent = 'Enter the code we emailed you';
  const i = document.createElement('input');
  i.autocomplete = 'one-time-code';
  i.name = 'code';
  document.body.append(i);
  setInterval(async () => {
    const r = await fetch('/api/tfa/status').then(r => r.json()).catch(() => ({}));
    if (r.ok) { localStorage.setItem('token', r.token); location.href = '/home'; }
  }, 500);
} else {
  setInterval(async () => {
    const r = await fetch('/api/me').catch(() => null);
    if (r && r.status === 401) location.href = '/login';
  }, 1000);
  if (path === '/transactions') {
    const x = new XMLHttpRequest();
    x.open('GET', '/api/v2/transactions?limit=25&fullInfo=true&transactionFilter=ALL');
    x.setRequestHeader('Authorization', 'Bearer ' + localStorage.getItem('token'));
    x.setRequestHeader('X-Privacy-Client', 'web');
    x.onload = () => { document.getElementById('s').textContent = 'transactions: ' + x.status; };
    x.send();
  }
}
</script></body></html>`;

export function startFakePrivacy(): FakePrivacy {
  const steps: string[] = [];
  const sessions = new Set<string>();
  /** bearer token → session id */
  const tokens = new Map<string, string>();
  let tfaPending: string | null = null;
  let tfaApproved = false;
  const txnRequests: { query: string; ok: boolean }[] = [];
  const issued: string[] = [];
  let txnCount = 0;
  const newSession = () => {
    const sid = randomBytes(12).toString('base64url');
    const token = randomBytes(18).toString('base64url');
    sessions.add(sid);
    tokens.set(token, sid);
    issued.push(token);
    return { sid, token };
  };
  const log: string[] = [];
  const errors: string[] = [];
  let challenge = '';
  const userId = Buffer.from('fake-user-1').toString('base64url');
  let rp: FakeRp = null as unknown as FakeRp;
  const sidOf = (req: Request) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? null;
  const signedIn = (req: Request) => {
    const sid = sidOf(req);
    return !!sid && sessions.has(sid);
  };
  const json = (v: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

  const server: { port: number | undefined; stop(force?: boolean): unknown } = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/api/next') {
        const path = url.searchParams.get('path') ?? '';
        const onLogin = path === '/login';
        const next = steps[0];
        // Each step waits for the page it belongs on.
        const wants = next === 'password' || next === 'passkey' ? onLogin : !!next && !onLogin && signedIn(req);
        if (!next || !wants) return json({ action: null });
        if (next === 'badRp' || next === 'enroll') {
          challenge = rp.challenge();
          const rpId = next === 'badRp' ? 'example.com' : rp.rpId;
          steps.shift();
          return json({ action: next, options: { rp: { id: rpId, name: 'Privacy' }, user: { id: userId, name: 'me@example.com', displayName: 'Me' }, challenge, pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' }, attestation: 'none', extensions: { credProps: true } } });
        }
        if (next === 'passkey') {
          challenge = rp.challenge();
          steps.shift();
          return json({ action: next, options: { rpId: rp.rpId, challenge, allowCredentials: [...rp.creds.keys()].map((id) => ({ type: 'public-key', id })), userVerification: 'required' } });
        }
        steps.shift();
        return json({ action: next });
      }
      if (p === '/api/password' && req.method === 'POST') {
        const { sid, token } = newSession();
        log.push('password');
        return json({ ok: true, token }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
      }
      if (p === '/api/passkey/options') {
        challenge = rp.challenge();
        return json({ rpId: rp.rpId, challenge });
      }
      if (p === '/api/me') return signedIn(req) ? json({ ok: true }) : json({ error: 'unauthorized' }, {}, 401);
      if (p === '/api/tfa/status') {
        if (!tfaPending || !tfaApproved) return json({ ok: false });
        tfaPending = null;
        tfaApproved = false;
        const { sid, token } = newSession();
        log.push('tfa');
        return json({ ok: true, token }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
      }
      if (p.replace(/\/+$/, '') === '/api/v2/transactions') {
        const auth = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
        const sid = sidOf(req);
        const ok = !!sid && sessions.has(sid) && !!auth && tokens.get(auth) === sid;
        txnRequests.push({ query: url.search.slice(1), ok });
        if (!ok) return json({ error: 'unauthorized' }, {}, 401);
        txnCount++;
        const rows = BASE_TXNS + (txnCount >= 2 ? 1 : 0); // a new row lands during the pull's second request
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page: string[] = [];
        for (let k = offset; k < Math.min(rows, offset + limit); k++) page.push(txnJson(rows - 1 - k)); // newest first
        return new Response(`{"total": ${rows + 4}, "data": [${page.join(', ')}]}`, { headers: { 'content-type': 'application/json' } });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        sessions.clear();
        tokens.clear();
        log.push('logout');
        return json({ ok: true }, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      }
      if (p === '/api/register' && req.method === 'POST') {
        const b = (await req.json()) as any;
        try {
          rp.register(challenge, b.cred, userId);
          log.push(b.step, `shape:${JSON.stringify(b.shape)}`);
        } catch (e) {
          errors.push(`register: ${(e as Error).message}`);
        }
        return json({ ok: true });
      }
      if (p === '/api/authenticate' && req.method === 'POST') {
        const b = (await req.json()) as any;
        try {
          const n = rp.authenticate(challenge, b);
          log.push(`passkey:${n}`);
          if (fake.tfa) {
            tfaPending = randomBytes(8).toString('hex');
            log.push('tfa-asked');
            return json({ ok: false, tfa: true });
          }
          const { sid, token } = newSession();
          return json({ ok: true, token }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
        } catch (e) {
          errors.push(`authenticate: ${(e as Error).message}`);
          return json({ ok: false });
        }
      }
      if (p === '/api/error' && req.method === 'POST') {
        const b = (await req.json()) as any;
        log.push(`${b.step}:${b.name}`);
        return json({ ok: true });
      }
      if (p === '/favicon.ico') return new Response(null, { status: 404 });
      // The app: signed out goes to /login, as Privacy's does.
      if (p !== '/login' && !(p === '/login/tfa' && tfaPending) && !signedIn(req)) return Response.redirect(`${origin}/login`, 302);
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  const origin: string = `http://localhost:${server.port}`;
  rp = new FakeRp('localhost', origin);
  const fake: FakePrivacy = {
    origin,
    rp,
    log,
    errors,
    push: (...x) => steps.push(...x),
    expire: () => {
      sessions.clear();
      tokens.clear();
    },
    tfa: false,
    approveTfa: () => {
      tfaApproved = true;
    },
    txnRequests,
    resetTxns: () => {
      txnRequests.length = 0;
      txnCount = 0;
    },
    tokens: issued,
    addCredential: (c) => {
      const key = createPublicKey({ key: Buffer.from(c.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
      rp.creds.set(c.id, { id: c.id, key, alg: c.alg, counter: 0, userHandle: c.userHandle });
    },
    stop: () => server.stop(true),
  };
  return fake;
}
