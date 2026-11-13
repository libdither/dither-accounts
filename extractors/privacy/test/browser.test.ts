/**
 * extractors/privacy end to end in a real Chromium (Xvfb, the extension, x11vnc) against the fake Privacy app
 * (fake-privacy.ts), with a stand-in for the manager's /extractor socket: the three steps the account walks you
 * through (sign in, add a passkey, sign in with it), each seen as the attention it asks for, the passkey checked by an
 * independent relying party, a refused rpId, the page's PublicKeyCredential shape, and nothing secret in the events.
 * Skipped when Xvfb, chromium or x11vnc cannot be found. Every process it starts is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { type FakePrivacy, startFakePrivacy } from './fake-privacy.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`privacy browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakePrivacy;
let hub: Server<undefined>;
let sock: ServerWebSocket<undefined> | null = null;
let proc: Subprocess | null = null;
let dir: string;
const events: any[] = [];
const raw: string[] = [];
const replies = new Map<string, any>();

const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(100);
  }
  const st = lastStatus();
  throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(st && { status: st.status, attention: st.attention, layers: st.layers })}; fake ${JSON.stringify(fake.log)} ${JSON.stringify(fake.errors)}`);
};
const lastStatus = () => events.filter((e) => e.t === 'status').at(-1);
const attentionKind = () => lastStatus()?.attention?.kind ?? null;
const sawAttention = (kind: string) => events.some((e) => e.t === 'status' && e.attention?.kind === kind);
async function call(t: string, input: Record<string, unknown> = {}) {
  const rid = `r${Math.random().toString(36).slice(2)}`;
  sock!.send(JSON.stringify({ t, rid, ...input }));
  await until(() => replies.has(rid), 5000, `a reply to ${t}`);
  return replies.get(rid);
}

beforeAll(async () => {
  if (!bins) return;
  fake = startFakePrivacy();
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
  dir = mkdtempSync(join(tmpdir(), 'dacc-privacy-'));
  proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${hub.port}/extractor`,
      DITHER_ACCOUNT_ID: 'acc_privacytest',
      DITHER_ADAPTER_TOKEN: 'token',
      DITHER_ACCOUNT_DIR: dir,
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ testOrigin: fake.origin }),
      DITHER_ACCOUNT_LABEL: 'Privacy test',
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
  'sign in, add a passkey, sign in with it: each step asked for, then every layer ok',
  async () => {
    await until(() => events.some((e) => e.t === 'hello'), 20_000, 'hello');
    expect(events.find((e) => e.t === 'hello')).toMatchObject({ interfaces: ['privacy.session', 'statements'], capabilities: ['liveView'] });
    // No passkey yet: nothing pulled, and a refresh says why (pull.test.ts has the pull).
    expect((await call('statements.list')).result).toEqual({ files: [], next: 0 });
    const r0 = (await call('statements.refresh')).result;
    expect(r0.started).toBe(false);
    expect(r0.reason).toMatch(/not up yet|no passkey yet/);

    // 1. On /login: sign in.
    await until(() => attentionKind() === 'login', 60_000, 'the sign-in attention');
    expect(lastStatus().liveView).toMatchObject({ width: 1280, height: 800 });
    expect(lastStatus().attention.liveView).toBe(true);

    // 2. Signed in: add a passkey. First a create() for another rpId, refused in the page as SecurityError.
    fake.push('password');
    await until(() => attentionKind() === 'passkey', 30_000, 'the add-a-passkey attention');
    expect(lastStatus().layers.map((l: any) => `${l.name}:${l.state}`)).toEqual(['display:ok', 'browser:ok', 'extension:ok', 'signed in:ok', 'passkey:waiting', 'passkey sign-in:waiting', 'pull:waiting']);
    fake.push('badRp', 'enroll');
    await until(() => fake.log.includes('enroll'), 20_000, 'the passkey enrolled');
    expect(fake.errors).toEqual([]);
    expect(fake.log).toContain('badRp:SecurityError');
    const shape = JSON.parse(fake.log.find((l) => l.startsWith('shape:'))!.slice(6));
    // The fake asks for Ed25519 first, as dither-finance's passkey is.
    expect(shape).toEqual({ isPKC: true, type: 'public-key', attachment: 'platform', idMatches: true, transports: ['internal'], alg: -8, hasKey: true, json: true, ext: { credProps: { rk: true } } });
    await until(() => attentionKind() === 'passkey_check', 20_000, 'the check-the-passkey attention');
    expect(lastStatus().details).toMatchObject({ passkeyEnrolled: true, passkeys: 1, passkeyAlgorithm: 'Ed25519', passkeyRpId: 'localhost', lastRefusal: expect.stringContaining('example.com') });

    // 3. Sign out, sign in with the passkey: online, every layer ok.
    fake.push('logout', 'passkey');
    await until(() => lastStatus()?.status === 'online', 40_000, 'online');
    expect(fake.log).toContain('passkey:1');
    expect(fake.errors).toEqual([]);
    const st = lastStatus();
    expect(st.attention).toBeNull();
    // Every layer ok but the pull's, which has not run yet.
    expect(st.layers.filter((l: any) => l.name !== 'pull').every((l: any) => l.state === 'ok')).toBe(true);
    expect(st.layers.at(-1)).toMatchObject({ name: 'pull', state: 'waiting' });
    expect(sawAttention('login') && sawAttention('passkey') && sawAttention('passkey_check')).toBe(true);

    const r = await call('privacy.session');
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ signedIn: true, passkey: { enrolled: true, count: 1, algorithm: 'Ed25519', rpId: 'localhost' } });
    expect(r.result.passkey.signInCheckedAt).toBeNumber();

    // The key and counter: in secret.json (600), and nowhere in what went to the manager.
    const path = join(dir, 'secret.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const secret = JSON.parse(readFileSync(path, 'utf8'));
    expect(secret.passkeys).toHaveLength(1);
    const c = secret.passkeys[0];
    expect(c.signCount).toBe(1);
    expect(c.verifiedAt).toBeNumber();
    const wire = raw.join('\n');
    for (const s of [c.privateKey, c.id, c.userHandle]) expect(wire).not.toContain(s);
    expect(wire).not.toContain('"signCount"');
  },
  180_000,
);
