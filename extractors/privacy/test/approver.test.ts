/**
 * The privacy kind with its passkey on a paired phone (docs/approver.md, "What a refusal does"), end to end in a real
 * Chromium against the fake Privacy, with a stand-in for the manager's /extractor socket that answers the extractor's
 * `approver.request` asks with the fake phone (packages/passkey/test/fake-device.ts, asked directly, the device's name
 * added as the manager adds it; a request nobody answers comes back `expired` at once instead of after 3 minutes):
 *
 *   - at start (signInOnStart), signed out, the phone denies: one request, no second click or try; the attention
 *     `approval`;
 *   - restarted: the denial stands (state.json), so the start asks nothing;
 *   - a pull from the page asks once more (denied: one request); nobody answers: one request, the attention says so;
 *   - approved: signed in, the pull goes through, the refusal is gone, and the relying party has the phone's counter.
 *
 * Every count is of requests that reached the phone, read once the sign-in that made them has ended (no sleeps). The
 * rules across the daily pull, its retries and Schwab's tick are in test/approver-signin.test.ts (CI). Skipped when
 * Xvfb, chromium or x11vnc cannot be found.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { refusalMessage } from '../../../packages/passkey/src/index.ts';
import { FakeDevice } from '../../../packages/passkey/test/fake-device.ts';
import { type FakePrivacy, startFakePrivacy } from './fake-privacy.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`privacy approver: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakePrivacy;
let phone: FakeDevice;
let hub: Server<undefined>;
let sock: ServerWebSocket<undefined> | null = null;
let proc: Subprocess | null = null;
let dir: string;
let events: any[] = [];
const raw: string[] = [];
const replies = new Map<string, any>();
const cred = { id: '', userHandle: Buffer.from('fake-user-1').toString('base64url') };
let asked = 0;

const lastStatus = () => events.filter((e) => e.t === 'status').at(-1);
const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(100);
  }
  const st = lastStatus();
  throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(st && { status: st.status, attention: st.attention, auto: st.details?.autoSignIn, tries: st.details?.autoSignInsThisRun })}; phone ${phone.requests.length}; fake ${JSON.stringify(fake.log)} ${JSON.stringify(fake.errors)}; log ${JSON.stringify(events.filter((e) => e.t === 'log').slice(-20).map((e) => `${e.msg} ${e.data ? JSON.stringify(e.data) : ''}`))}`);
};
async function call(t: string, input: Record<string, unknown> = {}) {
  const rid = `r${Math.random().toString(36).slice(2)}`;
  sock!.send(JSON.stringify({ t, rid, ...input }));
  await until(() => replies.has(rid), 10_000, `a reply to ${t}`);
  return replies.get(rid);
}
const pulled = () => events.filter((e) => e.t === 'statements.pulled');
const logged = (m: string) => events.some((e) => e.t === 'log' && String(e.msg).includes(m));
const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));

/** The manager's side of approver.request, in short: the request as it sends it, and the device's name on a refusal. */
async function answerAsk(aid: string, input: any) {
  asked++;
  const r = { t: 'request', id: `apr_${String(asked).padStart(16, '0')}`, ...input, account: { id: 'acc_privacyapr', label: 'Privacy', kind: 'privacy' }, expiresAt: Date.now() + 180_000 };
  const a = (await phone.answer(r)) ?? { ok: false, reason: 'expired' };
  const { t: _t, id: _id, ...result } = a;
  sock!.send(JSON.stringify({ t: 'answer', aid, ok: true, result: a.ok ? result : { ...result, deviceName: phone.name } }));
}

function spawn() {
  proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${hub.port}/extractor`,
      DITHER_ACCOUNT_ID: 'acc_privacyapr',
      DITHER_ADAPTER_TOKEN: 'token',
      DITHER_ACCOUNT_DIR: dir,
      // signInOnStart: the start's sign-in is where the phone is first asked here (off by default).
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ testOrigin: fake.origin, paceScale: 0.05, schedule: false, signInOnStart: true }),
      DITHER_ACCOUNT_LABEL: 'Privacy approver test',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
}
async function stop() {
  try {
    sock?.send(JSON.stringify({ t: 'shutdown' }));
  } catch {}
  const exited = proc ? await Promise.race([proc.exited, Bun.sleep(8000).then(() => null)]) : 0;
  if (exited === null) proc?.kill('SIGKILL');
  proc = null;
  sock = null;
}

beforeAll(async () => {
  if (!bins) return;
  fake = startFakePrivacy();
  // The passkey, made on the phone earlier (as Keep new passkeys on would) and known to the fake's relying party.
  phone = await FakeDevice.make('Pixel A');
  phone.deviceId = 'dev_privacyphone0001';
  phone.manager = 'test';
  phone.httpLocalhost = true;
  const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'AAAA', origin: fake.origin, crossOrigin: false })).toString('base64url');
  const made = (await phone.answer({ t: 'request', id: 'apr_enroll', op: 'create', rpId: 'localhost', origin: fake.origin, clientDataJSON: cdj, expiresAt: Date.now() + 60_000, account: { label: 'Privacy' }, create: { rp: { id: 'localhost', name: 'Privacy' }, user: { id: cred.userHandle, name: 'me', displayName: 'Me' }, algs: [-7] } }))!;
  expect(made.ok).toBe(true);
  cred.id = made.credentialId;
  phone.requests.length = 0;
  fake.addCredential({ id: cred.id, publicKeySpki: made.publicKey, alg: -7, userHandle: cred.userHandle });
  dir = mkdtempSync(join(tmpdir(), 'dacc-privacy-apr-'));
  const now = Date.now();
  writeFileSync(join(dir, 'secret.json'), JSON.stringify({ passkeys: [{ id: cred.id, rpId: 'localhost', alg: -7, publicKey: made.publicKey, userHandle: cred.userHandle, device: phone.deviceId, createdAt: now - 3600_000, lastUsedAt: now - 3000_000, verifiedAt: now - 3000_000 }] }), { mode: 0o600 });
  writeFileSync(join(dir, 'state.json'), '{}');

  hub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        sock = ws;
      },
      message(_ws, m) {
        const s = String(m);
        raw.push(s);
        const e = JSON.parse(s);
        if (e.t === 'reply') replies.set(e.id, e);
        else if (e.t === 'ask' && e.what === 'approver.request') void answerAsk(e.aid, e.input);
        else events.push(e);
      },
    },
  });
  spawn();
}, 30_000);

afterAll(async () => {
  if (!bins) return;
  await stop();
  hub?.stop(true);
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

it(
  'a denial asks the phone once and stops; a pull from the page asks once more; approved, it signs in',
  async () => {
    const denied = refusalMessage('Privacy', { reason: 'denied', device: 'Pixel A', at: 0 });
    // 1. At start, signed out: the start's sign-in asks the phone, which denies. One request; the sign-in ends there.
    phone.decide = () => 'deny';
    await until(() => events.some((e) => e.t === 'hello'), 20_000, 'hello');
    await until(() => lastStatus()?.attention?.kind === 'approval' && /^stopped: denied on Pixel A/.test(lastStatus()?.details?.autoSignIn ?? ''), 90_000, 'the denial');
    expect(lastStatus().attention).toEqual({ kind: 'approval', message: denied, liveView: true });
    expect(phone.requests).toHaveLength(1);
    expect(phone.requests[0]).toMatchObject({ op: 'get', rpId: 'localhost', reason: 'Sign in by itself as the account starts', get: { allow: [cred.id] } });
    expect(lastStatus().details).toMatchObject({ autoSignInsThisRun: 1, refusedThisRun: 1, signInsThisRun: 0, approval: 'denied on Pixel A; waits for a pull you start' });
    expect(state().approval).toMatchObject({ reason: 'denied', device: 'Pixel A' });
    expect(lastStatus().layers.find((l: any) => l.name === 'signed in')).toMatchObject({ state: 'failed' });

    // 2. Restarted: the denial is kept, and the start asks nothing.
    await stop();
    events = [];
    spawn();
    await until(() => logged('no sign-in at start'), 90_000, 'the start that asks nothing');
    expect(lastStatus()?.attention).toEqual({ kind: 'approval', message: denied, liveView: true });
    expect(phone.requests).toHaveLength(1);

    // 3. A pull from the page asks once more: denied, one request.
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulled().length === 1, 90_000, 'the denied pull');
    expect(pulled()[0]).toMatchObject({ ok: false, saved: 0, needs: denied });
    expect(phone.requests).toHaveLength(2);
    expect(phone.requests[1].reason).toBe('Sign in for the statements pull you started');
    expect(lastStatus().details.autoSignInsThisRun).toBe(1);

    // 4. Nobody answers: one request, and the attention says it was not answered in time.
    phone.decide = () => 'ignore';
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulled().length === 2, 90_000, 'the unanswered pull');
    const expired = refusalMessage('Privacy', { reason: 'expired', device: 'Pixel A', at: 0 });
    expect(pulled()[1]).toMatchObject({ ok: false, needs: expired });
    expect(phone.requests).toHaveLength(3);
    await until(() => lastStatus()?.attention?.message === expired, 5000, 'the expired attention');
    expect(state().approval).toMatchObject({ reason: 'expired' });

    // 5. Approved: signed in by itself, the pull goes through, and nothing stands.
    phone.decide = () => 'approve';
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulled().length === 3, 120_000, 'the approved pull');
    expect(pulled()[2]).toMatchObject({ ok: true, saved: 1 });
    expect(phone.requests).toHaveLength(4);
    await until(() => lastStatus()?.status === 'online' && lastStatus()?.details?.signedIn === true, 30_000, 'online');
    expect(lastStatus().details.approval).toBeNull();
    expect(state().approval).toBeNull();
    expect(fake.rp.creds.get(cred.id)!.counter).toBe(1);
    expect(phone.creds[0]!.counter).toBe(1);
    expect(fake.errors).toEqual([]);
    // Nothing secret on the wire to the manager: no credential id, user handle or token.
    const wire = raw.join('\n');
    for (const s of [cred.id, cred.userHandle, ...fake.tokens]) expect(wire.replace(/"allow":\["[^"]+"\]/g, '')).not.toContain(s);
  },
  480_000,
);
