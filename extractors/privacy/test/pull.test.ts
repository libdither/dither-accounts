/**
 * The privacy statements pull end to end in a real Chromium (Xvfb, the extension, x11vnc) against the fake Privacy
 * (fake-privacy.ts), with a stand-in for the manager's /extractor socket. The account starts with a checked passkey
 * (as after you enrolled it) and a seed from pcom.py's file (test/fixtures):
 *
 *   - at start, signed out: no sign-in (no pull follows it), still online, nothing asked;
 *   - a refresh signs in with the passkey (the sign-in page's button, the authenticator), loads /transactions, pages
 *     the app's own request from the page and spools pcom.py's file byte for byte, request for request;
 *   - the session expires: still online, nothing asked;
 *   - Privacy asks for an emailed code after the passkey: the pull stops, the account holds with the attention, later
 *     pulls are refused, nothing is typed; once the live view shows Privacy signed in, the hold lifts;
 *   - the counter only went up, and no key, credential id, user handle or bearer token went to the manager.
 *
 * Skipped when Xvfb, chromium or x11vnc cannot be found. Every process it starts is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { seedFromRaw } from '../src/pcom.ts';
import { CODE_MESSAGE, SIGNS_ITSELF_IN } from '../src/status.ts';
import { type FakePrivacy, startFakePrivacy } from './fake-privacy.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`privacy pull: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

const FIX = join(import.meta.dir, 'fixtures');
const meta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8'));
const fixture = readFileSync(join(FIX, 'privacy.json'), 'utf8');

let fake: FakePrivacy;
let hub: Server<undefined>;
let sock: ServerWebSocket<undefined> | null = null;
let proc: Subprocess | null = null;
let dir: string;
const events: any[] = [];
const raw: string[] = [];
const replies = new Map<string, any>();
const cred = { id: '', privateKey: '', userHandle: '' };

const lastStatus = () => events.filter((e) => e.t === 'status').at(-1);
const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(100);
  }
  const st = lastStatus();
  throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(st && { status: st.status, attention: st.attention, layers: st.layers, auto: st.details?.autoSignIn })}; fake ${JSON.stringify(fake.log)} ${JSON.stringify(fake.errors)}; log ${JSON.stringify(events.filter((e) => e.t === 'log').slice(-25).map((e) => `${e.msg} ${e.data ? JSON.stringify(e.data) : ''}`))}`);
};
async function call(t: string, input: Record<string, unknown> = {}) {
  const rid = `r${Math.random().toString(36).slice(2)}`;
  sock!.send(JSON.stringify({ t, rid, ...input }));
  await until(() => replies.has(rid), 10_000, `a reply to ${t}`);
  return replies.get(rid);
}
const pulled = () => events.filter((e) => e.t === 'statements.pulled');
const signIns = () => fake.log.filter((l) => l.startsWith('passkey:'));

beforeAll(async () => {
  if (!bins) return;
  fake = startFakePrivacy();
  // A passkey enrolled and checked earlier (as on the real account), known to the fake's relying party.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  cred.id = randomBytes(32).toString('base64url');
  cred.privateKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  cred.userHandle = Buffer.from('fake-user-1').toString('base64url');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  fake.addCredential({ id: cred.id, publicKeySpki: spki, alg: -8, userHandle: cred.userHandle });
  dir = mkdtempSync(join(tmpdir(), 'dacc-privacy-pull-'));
  const now = Date.now();
  writeFileSync(join(dir, 'secret.json'), JSON.stringify({ passkeys: [{ id: cred.id, rpId: 'localhost', alg: -8, privateKey: cred.privateKey, publicKey: spki, userHandle: cred.userHandle, signCount: 0, createdAt: now - 3600_000, lastUsedAt: now - 3000_000, verifiedAt: now - 3000_000 }] }), { mode: 0o600 });
  // The seed, from pcom.py's file for the same fake (seed.ts does this from dither-finance's raw tree).
  const rawDir = mkdtempSync(join(tmpdir(), 'dacc-privacy-raw-'));
  writeFileSync(join(rawDir, 'privacy-20261109T000000.json'), fixture);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ seed: seedFromRaw(rawDir) }));
  rmSync(rawDir, { recursive: true, force: true });

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
        else events.push(e);
      },
    },
  });
  proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${hub.port}/extractor`,
      DITHER_ACCOUNT_ID: 'acc_privacypull',
      DITHER_ADAPTER_TOKEN: 'token',
      DITHER_ACCOUNT_DIR: dir,
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ testOrigin: fake.origin, paceScale: 0.05, schedule: false }),
      DITHER_ACCOUNT_LABEL: 'Privacy pull test',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
}, 30_000);

afterAll(async () => {
  if (!bins) return;
  try {
    sock?.send(JSON.stringify({ t: 'shutdown' }));
  } catch {}
  const exited = proc ? await Promise.race([proc.exited, Bun.sleep(8000).then(() => null)]) : 0;
  if (exited === null) proc?.kill('SIGKILL');
  hub?.stop(true);
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

it(
  'signs itself in for a pull (not at start), pulls pcom.py’s file, and stops at a code it may not answer',
  async () => {
    // 1. At start Privacy is signed out, and no pull follows: no sign-in (its sessions end within minutes), still
    //    online, nothing asked of you.
    await until(() => events.some((e) => e.t === 'hello'), 20_000, 'hello');
    await until(() => events.some((e) => e.t === 'log' && /no sign-in at start/.test(e.msg)), 60_000, 'the start that signs nothing');
    expect(signIns()).toEqual([]);
    expect(fake.errors).toEqual([]);
    expect(lastStatus()).toMatchObject({ status: 'online', attention: null });
    expect(lastStatus().layers.find((l: any) => l.name === 'signed in')).toEqual({ name: 'signed in', state: 'ok', note: SIGNS_ITSELF_IN });
    expect(lastStatus().details).toMatchObject({ signedIn: false, autoSignInsThisRun: 0, seedFile: 'privacy-20261109T000000.json', seedCheck: 'pending: the first pull' });

    // 2. A pull: signs in with the passkey by itself, then pcom.py's requests and file.
    fake.resetTxns();
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulled().length === 1, 120_000, 'the pull');
    expect(pulled()[0]).toMatchObject({ ok: true, saved: 1 });
    expect(signIns()).toEqual(['passkey:1']);
    expect(lastStatus().details).toMatchObject({ autoSignInsThisRun: 1 });
    expect(lastStatus().details.lastAutoSignIn).toBeString();
    expect(fake.txnRequests.map((r) => [r.query, r.ok])).toEqual(meta.requests);
    const list = (await call('statements.list')).result;
    expect(list.files).toHaveLength(1);
    const f = list.files[0];
    expect(f).toMatchObject({ seq: 1, dir: '', mime: 'application/json' });
    expect(f.name).toMatch(/^privacy-\d{8}T\d{6}\.json$/);
    const got = Buffer.from((await call('statements.fetch', { id: f.id })).result.base64, 'base64').toString('utf8');
    const pulledAt = /"pulled_at": (\d+)/.exec(got)![1];
    expect(f.name).toBe(`privacy-${new Date(Number(pulledAt) * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`);
    expect(got === fixture.replace(`"pulled_at": ${meta.pulledAt}`, `"pulled_at": ${pulledAt}`)).toBe(true);
    await until(() => /^231 same, 0 changed, 0 new, 0 gone/.test(lastStatus()?.details?.seedCheck ?? ''), 5000, 'the seed check');
    expect(lastStatus().details).toMatchObject({ lastPullOk: true, lastPullSaved: 1, lastPullTransactions: 231 });
    expect(lastStatus().layers.at(-1)).toMatchObject({ name: 'pull', state: 'ok' });

    // 3. The session ends (Privacy's are short): still online, nothing asked of you.
    fake.expire();
    await until(() => lastStatus()?.details?.signedIn === false, 15_000, 'signed out');
    await Bun.sleep(1500);
    expect(lastStatus()).toMatchObject({ status: 'online', attention: null });
    expect(lastStatus().layers.find((l: any) => l.name === 'signed in')).toEqual({ name: 'signed in', state: 'ok', note: SIGNS_ITSELF_IN });

    // 4. Privacy wants an emailed code after the passkey: stop, hold, ask you; never answer it.
    fake.tfa = true;
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulled().length === 2, 90_000, 'the stopped pull');
    expect(pulled()[1]).toMatchObject({ ok: false, saved: 0, needs: CODE_MESSAGE });
    expect(fake.log).toContain('tfa-asked');
    expect(signIns()).toEqual(['passkey:1', 'passkey:2']);
    await until(() => lastStatus()?.attention?.message === CODE_MESSAGE, 5000, 'the hold attention');
    expect(lastStatus()).toMatchObject({ status: 'attention', attention: { kind: 'login', liveView: true } });
    expect(lastStatus().details.autoSignIn).toMatch(/^held \(code\)/);
    expect((await call('statements.refresh')).result).toEqual({ started: false, reason: `Privacy is waiting for you in the live view: ${CODE_MESSAGE}` });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).hold).toMatchObject({ what: 'code' });
    // Nothing tried again by itself, and no code was typed (the fake would only take the test's approval anyway).
    await Bun.sleep(3000);
    expect(signIns()).toHaveLength(2);
    expect(fake.log).not.toContain('tfa');

    // 5. You enter the code in the live view: signed in, the hold lifts, online.
    fake.tfa = false;
    fake.approveTfa();
    await until(() => lastStatus()?.status === 'online' && lastStatus()?.details?.signedIn === true, 30_000, 'online after the code');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).hold).toBeNull();
    expect(fake.errors).toEqual([]);

    // The counter went up with every sign-in, and nothing secret went to the manager.
    const secret = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8'));
    expect(secret.passkeys[0].signCount).toBe(2);
    expect(fake.rp.creds.get(cred.id)!.counter).toBe(2);
    const wire = raw.join('\n');
    for (const s of [cred.privateKey, cred.id, cred.userHandle, ...fake.tokens]) expect(wire).not.toContain(s);
    expect(wire).not.toContain('Bearer');
    expect(wire).not.toContain('"signCount"');
  },
  360_000,
);
