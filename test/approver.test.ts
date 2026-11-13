/**
 * The approver (docs/approver.md) against a real manager: pairing, the device link, and passkeys whose key is on a
 * fake phone (packages/passkey/test/fake-device.ts), made and used through a test extractor (passkey-extractor.ts)
 * and checked by an independent relying party (fake-rp.ts). A fake push server stands in for UnifiedPush. Port 0,
 * temp data dirs, no network.
 */
import type { Server } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import type { AccountDetail, ApproverPairing, ApproversState, AuditRow, ManagerState } from '../packages/manager/src/api-types.ts';
import { fingerprint } from '../packages/passkey/src/approver.ts';
import { FakeDevice } from '../packages/passkey/test/fake-device.ts';
import { FakeRp } from '../packages/passkey/test/fake-rp.ts';

const ORIGIN = 'https://app.privacy.com';
const REQUEST_MS = 3000;

let m: Manager;
let dir: string;
let push: Server<undefined>;
const pushes: { body: string; headers: Record<string, string> }[] = [];
const account = 'acc_pktest01';
let a: FakeDevice;
let b: FakeDevice;
const rp = new FakeRp('privacy.com', ORIGIN);
const userId = Buffer.from('user-approver').toString('base64url');

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = async <T = any>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
  const r = await fetch(m.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as T };
};
const pairing = async () => (await api<ApproverPairing>('/api/approvers/pair', 'POST')).body;
/** The page's request, as the extension sends it up, answered by the account's extractor. */
const webauthn = (op: 'create' | 'get', options: unknown) => m.sup.command(account, { t: 'webauthn', op, options, origin: ORIGIN }, 20_000) as Promise<{ ok: boolean; result?: any; error?: string; code?: string }>;
const createOpts = (challenge: string) => ({ rp: { id: 'privacy.com', name: 'Privacy' }, user: { id: userId, name: 'me@example.com', displayName: 'Me' }, challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], extensions: { credProps: true } });
const secret = () => JSON.parse(readFileSync(join(dir, 'accounts', account, 'secret.json'), 'utf8'));
const approvals = async () => (await api<ApproversState>('/api/approvers')).body.approvals;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-approver-'));
  push = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      pushes.push({ body: await req.text(), headers: Object.fromEntries(req.headers) });
      return new Response(null, { status: 201 });
    },
  });
  const kinds = new Map([['pktest', kindOf({ kind: 'pktest', name: 'Passkey test', interfaces: [], entry: 'passkey-extractor.ts', passkeys: true }, import.meta.dir)]]);
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds, approverPushHttp: true, approverRequestMs: REQUEST_MS });
  const now = Date.now();
  m.store.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)', account, 'pktest', 'Privacy (test)', '{}', 'tok-pktest-0123456789', join(dir, 'accounts', account), now, now);
  m.sup.start(account);
  await until(() => m.sup.state(account).online, 15_000, 'the test extractor online');
  a = await FakeDevice.make('Pixel A');
  b = await FakeDevice.make('Pixel B');
});
afterAll(async () => {
  a?.close();
  b?.close();
  await m?.stop();
  push?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('pairing', () => {
  test('a code from the page pairs a phone once', async () => {
    const p = await pairing();
    expect(p.code).toMatch(/^[\w-]{22}$/);
    expect(p.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(FakeDevice.parseLink(p.link)).toEqual({ url: (m.http as any).opts.publicUrl, code: p.code });
    const r = await a.pair(m.url, p.code);
    expect(r.status).toBe(200);
    expect(a.deviceId).toMatch(/^dev_[\w-]{16}$/);
    // Used up.
    expect((await b.pair(m.url, p.code)).status).toBe(403);
    const file = join(dir, 'approvers.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).devices.map((d: any) => [d.id, d.name, d.publicKey])).toEqual([[a.deviceId, 'Pixel A', a.spki]]);
    const st = (await api<ApproversState>('/api/approvers')).body;
    expect(st.devices[0]).toMatchObject({ id: a.deviceId!, name: 'Pixel A', online: false, push: false });
    expect(st.devices[0].fingerprint).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
    expect(st.devices[0].fingerprint).toBe(await fingerprint(a.spki));
  });

  test('a bad body is refused and leaves the code usable; an expired or unknown code is refused', async () => {
    const p = await pairing();
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${m.url}/approver/pair`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    expect((await post({ code: p.code })).status).toBe(400);
    expect((await post({ code: p.code, name: 'x', publicKey: Buffer.from('not a key').toString('base64') })).status).toBe(400);
    expect((await post('{nope')).status).toBe(400);
    // Not from a browser.
    expect((await post({ code: p.code, name: 'x', publicKey: b.spki }, { origin: m.url })).status).toBe(403);
    expect((await post({ code: 'A'.repeat(22), name: 'x', publicKey: b.spki })).status).toBe(403);
    expect((await b.pair(m.url, p.code)).status).toBe(200);
    // An expired one.
    const old = await pairing();
    for (const x of (m.approvers as any).pairings) x.expiresAt = Date.now() - 1;
    const c = await FakeDevice.make('Late');
    expect((await c.pair(m.url, old.code)).status).toBe(403);
  });

  test('pairing and the link are outside the login; the page API is not', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'dacc-approver-login-'));
    const m2 = await createManager({ dataDir: d2, port: 0, kinds: new Map(), startAccounts: false });
    try {
      expect((await fetch(`${m2.url}/api/approvers`)).status).toBe(401);
      expect((await fetch(`${m2.url}/api/approvers/pair`, { method: 'POST' })).status).toBe(401);
      const c = await FakeDevice.make();
      expect((await c.pair(m2.url, 'A'.repeat(22))).status).toBe(403);
      const code = await c.connect(m2.url, { as: 'dev_AAAAAAAAAAAAAAAA' }).catch((e) => e.code);
      expect(code).toBe(4401);
    } finally {
      await m2.stop();
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe('the link', () => {
  test('a paired device proves its key and is online', async () => {
    expect(await a.connect(m.url, { push: `http://127.0.0.1:${push.port}/up/a` })).toBe('Pixel A');
    await until(async () => (await api<ApproversState>('/api/approvers')).body.devices.find((d) => d.id === a.deviceId)?.push === true, 4000, 'its push endpoint');
    expect((await api<ApproversState>('/api/approvers')).body.devices.find((d) => d.id === a.deviceId)!.online).toBe(true);
    a.send({ t: 'ping' });
    await until(() => a.received.some((x) => x.t === 'pong'), 2000, 'a pong');
    expect(await b.connect(m.url)).toBe('Pixel B');
  });

  test('a bad signature, an unknown device and a removed device are closed with 4401', async () => {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const c = await FakeDevice.make('Bad');
    expect(await c.connect(m.url, { as: a.deviceId!, signWith: (other as CryptoKeyPair).privateKey }).catch((e) => e.code)).toBe(4401);
    expect(await c.connect(m.url, { as: 'dev_nobodyhere12345' }).catch((e) => e.code)).toBe(4401);
    // Paired, linked, then removed on the page: its link closes, and it cannot come back.
    const gone = await FakeDevice.make('Gone');
    expect((await gone.pair(m.url, (await pairing()).code)).status).toBe(200);
    await gone.connect(m.url);
    expect((await api(`/api/approvers/${gone.deviceId}`, 'DELETE')).status).toBe(200);
    await until(() => gone.closed !== null, 4000, 'its link closed');
    expect(gone.closed!.code).toBe(4401);
    expect(await gone.connect(m.url).catch((e) => e.code)).toBe(4401);
    expect((await api<ApproversState>('/api/approvers')).body.devices.map((d) => d.id)).not.toContain(gone.deviceId);
  });
});

describe('passkeys on the phone', () => {
  let credId: string;

  test('without a device named, a passkey is made here as before', async () => {
    const ch = rp.challenge();
    const r = await webauthn('create', createOpts(ch));
    expect(r.ok).toBe(true);
    rp.register(ch, r.result, userId);
    const local = secret().passkeys.find((c: any) => c.id === r.result.id);
    expect(typeof local.privateKey).toBe('string');
    expect(local.device).toBeUndefined();
    expect(a.requests).toHaveLength(0);
  });

  test('Keep new passkeys on: only a paired device, only for a kind that holds passkeys', async () => {
    expect((await api(`/api/accounts/${account}`, 'PATCH', { passkeyDevice: 'dev_nobodyhere12345' })).status).toBe(404);
    expect((await api(`/api/accounts/${account}`, 'PATCH', { passkeyDevice: a.deviceId })).status).toBe(200);
    expect((await api<AccountDetail>(`/api/accounts/${account}`)).body.passkeys!.device).toBe(a.deviceId);
  });

  test('create goes to the phone: the site registers it, and secret.json keeps no private key', async () => {
    const ch = rp.challenge();
    const r = await webauthn('create', createOpts(ch));
    expect(r.ok).toBe(true);
    expect(r.result.publicKeyAlgorithm).toBe(-7);
    expect(r.result.clientExtensionResults).toEqual({ credProps: { rk: true } });
    rp.register(ch, r.result, userId);
    credId = r.result.id;
    // What the phone was asked.
    const q = a.requests.at(-1)!;
    expect(q).toMatchObject({ t: 'request', op: 'create', account: { id: account, label: 'Privacy (test)', kind: 'pktest' }, reason: 'Add a passkey in the test', rpId: 'privacy.com', origin: ORIGIN, create: { rp: { id: 'privacy.com', name: 'Privacy' }, user: { id: userId, name: 'me@example.com', displayName: 'Me' }, algs: [-7] } });
    expect(q.id).toMatch(/^apr_/);
    expect(q.expiresAt - Date.now()).toBeLessThanOrEqual(REQUEST_MS);
    expect(JSON.parse(Buffer.from(q.clientDataJSON, 'base64url').toString())).toMatchObject({ type: 'webauthn.create', origin: ORIGIN, crossOrigin: false });
    // Stored as remote: the device and the public key only.
    const s = secret().passkeys.find((c: any) => c.id === credId);
    expect(Object.keys(s).sort()).toEqual(['alg', 'createdAt', 'device', 'id', 'lastUsedAt', 'publicKey', 'rpId', 'userHandle', 'verifiedAt']);
    expect(s).toMatchObject({ device: a.deviceId, alg: -7, rpId: 'privacy.com', userHandle: userId });
    // The page lists both, with where each lives.
    const list = (await api<AccountDetail>(`/api/accounts/${account}`)).body.passkeys!.list;
    expect(list.map((p) => p.device)).toEqual([null, a.deviceId]);
    expect(JSON.stringify(list)).not.toContain('privateKey');
  });

  test('get goes to the phone: the site verifies it, and the counter is the phone’s', async () => {
    for (const n of [1, 2]) {
      const ch = rp.challenge();
      const r = await webauthn('get', { rpId: 'privacy.com', challenge: ch, allowCredentials: [{ type: 'public-key', id: credId }] });
      expect(r.ok).toBe(true);
      expect(rp.authenticate(ch, r.result)).toBe(n);
      expect(r.result.userHandle).toBe(userId);
    }
    expect(a.requests.at(-1)).toMatchObject({ op: 'get', get: { allow: [credId] }, reason: 'Sign in for the test' });
    expect(a.creds.find((c) => c.id === credId)!.counter).toBe(2);
    const s = secret().passkeys.find((c: any) => c.id === credId);
    expect(s.lastUsedAt).toBeNumber();
    expect(s.signCount).toBeUndefined();
  });

  test('denied, refused and expired are the NotAllowedError of a cancelled prompt', async () => {
    const get = () => webauthn('get', { rpId: 'privacy.com', challenge: rp.challenge(), allowCredentials: [{ type: 'public-key', id: credId }] });
    a.decide = () => 'deny';
    let r = await get();
    expect(r).toMatchObject({ ok: false, code: 'NotAllowedError' });
    // The manager names the device in a refusal, so the account can say where it was refused.
    expect(r.error).toContain('the approver on Pixel A answered denied');
    a.decide = () => ({ reason: 'error', message: 'the Keystore said no' });
    r = await get();
    expect(r).toMatchObject({ ok: false, code: 'NotAllowedError' });
    expect(r.error).toContain('the Keystore said no');
    a.decide = () => 'approve';
    r = await get();
    expect(r.ok).toBe(true);
    // Nobody answers: it expires, and meanwhile the account says what it waits for.
    a.decide = () => 'ignore';
    const pending = get();
    await until(async () => (await api<ManagerState>('/api/state')).body.accounts.find((x) => x.id === account)?.status?.attention !== undefined, 4000, 'the attention');
    const st = (await api<ManagerState>('/api/state')).body.accounts.find((x) => x.id === account)!;
    expect(st.status).toMatchObject({ status: 'attention', attention: { kind: 'approval', message: 'Waiting for your approval on Pixel A' } });
    r = await pending;
    expect(r).toMatchObject({ ok: false, code: 'NotAllowedError' });
    expect(r.error).toContain('expired');
    const after = (await api<ManagerState>('/api/state')).body.accounts.find((x) => x.id === account)!;
    expect((after.status?.attention as any)?.kind).not.toBe('approval');
    const outcomes = (await approvals()).map((x) => x.outcome);
    for (const o of ['denied', 'error', 'expired', 'ok']) expect(outcomes).toContain(o);
    a.decide = () => 'approve';
  }, 20_000);

  test('a device that refuses a request it cannot check answers refused', async () => {
    // A request for a credential the phone does not hold: unknown-credential, without asking you.
    const other = secret().passkeys.find((c: any) => c.device === undefined);
    const ch = rp.challenge();
    const prev = (m.approvers as any).request.bind(m.approvers);
    const r = await prev(m.store.account(account), { op: 'get', device: a.deviceId, reason: 'x', rpId: 'privacy.com', origin: ORIGIN, clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ch, origin: ORIGIN, crossOrigin: false })).toString('base64url'), get: { allow: [other.id] } });
    expect(r).toEqual({ ok: false, reason: 'unknown-credential', deviceName: 'Pixel A' });
    // And one whose client data does not match what it says: refused.
    const bad = await prev(m.store.account(account), { op: 'get', device: a.deviceId, reason: 'x', rpId: 'privacy.com', origin: ORIGIN, clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ch, origin: 'https://evil.example', crossOrigin: false })).toString('base64url'), get: { allow: [credId] } });
    expect(bad).toEqual({ ok: false, reason: 'refused', deviceName: 'Pixel A' });
  });

  test('a request for a phone without a link wakes it with exactly {"t":"wake"}', async () => {
    a.close();
    await until(async () => !(await api<ApproversState>('/api/approvers')).body.devices.find((d) => d.id === a.deviceId)!.online, 4000, 'offline');
    const before = pushes.length;
    const ch = rp.challenge();
    const pending = webauthn('get', { rpId: 'privacy.com', challenge: ch, allowCredentials: [{ type: 'public-key', id: credId }] });
    await until(() => pushes.length > before, 4000, 'the wake-up');
    expect(pushes.at(-1)!.body).toBe('{"t":"wake"}');
    // The app wakes, opens the link, and the request that waited is there.
    await a.connect(m.url);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(rp.authenticate(ch, r.result)).toBe(4);
    expect(pushes.length).toBe(before + 1);
  }, 15_000);

  test('a device answers only its own requests; answers to unknown ids are dropped', async () => {
    let held: any = null;
    a.decide = (r) => ((held = r), 'ignore');
    let done = false;
    const ch = rp.challenge();
    const pending = webauthn('get', { rpId: 'privacy.com', challenge: ch, allowCredentials: [{ type: 'public-key', id: credId }] }).then((x) => ((done = true), x));
    await until(() => held !== null, 4000, 'the request on A');
    // B answers A's request, and A answers one that does not exist: both dropped.
    b.send({ t: 'response', id: held.id, ok: false, reason: 'denied' });
    a.send({ t: 'response', id: 'apr_doesnotexist0000', ok: false, reason: 'denied' });
    await Bun.sleep(300);
    expect(done).toBe(false);
    await a.approve(held);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(rp.authenticate(ch, r.result)).toBe(5);
    // A second answer to the same request, now finished: dropped too.
    a.send({ t: 'response', id: held.id, ok: false, reason: 'denied' });
    a.decide = () => 'approve';
  }, 15_000);

  test('a create the account does not name, or a device that is not paired, is refused before it is sent', async () => {
    const req = (m.approvers as any).request.bind(m.approvers);
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'AAAA', origin: ORIGIN, crossOrigin: false })).toString('base64url');
    const create = { rp: { id: 'privacy.com', name: 'P' }, user: { id: userId, name: 'u', displayName: 'U' }, algs: [-7] };
    const sent = b.requests.length;
    expect(await req(m.store.account(account), { op: 'create', device: b.deviceId, reason: 'x', rpId: 'privacy.com', origin: ORIGIN, clientDataJSON: cdj, create, account: { id: 'acc_someoneelse', label: 'Other', kind: 'schwab' } })).toMatchObject({ ok: false, reason: 'refused' });
    expect(await req(m.store.account(account), { op: 'get', device: 'dev_nobodyhere12345', reason: 'x', rpId: 'privacy.com', origin: ORIGIN, clientDataJSON: cdj, get: { allow: [] } })).toMatchObject({ ok: false, reason: 'no-device' });
    expect(b.requests.length).toBe(sent);
  });

  test('the audit log has each request and its outcome, never the client data', async () => {
    const rows = await approvals();
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const ok = rows.find((r) => r.op === 'create' && r.outcome === 'ok')!;
    expect(ok).toMatchObject({ account, rpId: 'privacy.com', device: a.deviceId!, reason: 'Add a passkey in the test' });
    expect(ok.sentAt).toBeNumber();
    expect(ok.decidedAt! >= ok.createdAt).toBe(true);
    const dump = JSON.stringify(m.store.all('SELECT * FROM approval'));
    expect(dump).not.toContain('clientDataJSON');
    expect(dump).not.toContain('webauthn.');
    for (const c of a.creds) expect(dump).not.toContain(c.id);
    const audit = (await api<{ rows: AuditRow[] }>('/api/audit')).body.rows.filter((r) => r.app === 'approver');
    expect(audit.find((r) => r.op === 'passkey.get' && r.outcome === 'ok')!.n).toBeGreaterThanOrEqual(4);
    expect(audit.find((r) => r.op === 'passkey.get' && r.outcome === 'denied')!.n).toBeGreaterThanOrEqual(1);
    expect(audit.find((r) => r.op === 'passkey.create' && r.outcome === 'ok')!.n).toBe(1);
  });

  test('removing the device fails its passkeys here with NotAllowedError', async () => {
    expect((await api(`/api/approvers/${a.deviceId}`, 'DELETE')).status).toBe(200);
    const r = await webauthn('get', { rpId: 'privacy.com', challenge: rp.challenge(), allowCredentials: [{ type: 'public-key', id: credId }] });
    expect(r).toMatchObject({ ok: false, code: 'NotAllowedError' });
    expect(r.error).toContain('no-device');
    // New passkeys are not made here instead while the pane still names it.
    const c = await webauthn('create', createOpts(rp.challenge()));
    expect(c).toMatchObject({ ok: false, code: 'NotAllowedError' });
  });
});
