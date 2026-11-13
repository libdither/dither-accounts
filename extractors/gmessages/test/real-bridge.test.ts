/**
 * The real bridge (bridge/main.go, built with Go into a temp dir, modules from the local cache only) under the real
 * adapter, with every request it makes sent to a proxy that refuses it (127.0.0.1:1): the two sides agree on the line
 * protocol, and nothing reaches Google. Skipped without a Go toolchain.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { GMessagesAdapter, type Secret } from '../src/adapter.ts';
import { BRIDGE_DIR } from '../src/bridge.ts';

const go = Bun.which('go');
const work = mkdtempSync(join(tmpdir(), 'gm-real-'));
const bin = join(work, 'dither-gm-bridge');
let built = false;
const adapters: GMessagesAdapter[] = [];

beforeAll(() => {
  if (!go) return;
  const r = Bun.spawnSync([go, 'build', '-o', bin, '.'], { cwd: BRIDGE_DIR, env: { ...process.env, CGO_ENABLED: '0', GOFLAGS: '-mod=mod', GOPROXY: 'off' }, stderr: 'pipe' });
  built = r.exitCode === 0;
  if (!built) console.warn(`could not build the bridge: ${r.stderr.toString().slice(-500)}`);
}, 300_000);
afterAll(async () => {
  for (const a of adapters) await a.shutdown().catch(() => {});
  rmSync(work, { recursive: true, force: true });
});

async function run(secret: Secret | null) {
  const dir = mkdtempSync(join(work, 'acc-'));
  const path = join(dir, 'secret.json');
  if (secret) writeSecretFile(path, secret);
  const events: P.AdapterEvent[] = [];
  const logs: string[] = [];
  const a = new GMessagesAdapter(
    { emit: (e) => events.push(e), log: (_l, m) => logs.push(m), accountDir: dir, config: { proxy: 'http://127.0.0.1:1' }, secret: () => readSecretFile<Secret>(path), saveSecret: (v) => writeSecretFile(path, v) },
    { bridge: async () => [bin], connectBackoffMs: [60_000], activeTimeoutMs: 60_000 },
  );
  adapters.push(a);
  await a.start();
  const status = () => [...events].reverse().find((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status')!;
  const until = async <T>(f: () => T, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = f();
      if (v) return v;
      await Bun.sleep(25);
    }
    throw new Error(`timed out: ${f}\nlog:\n${logs.join('\n')}`);
  };
  return { a, events, logs, status, until, path };
}

test.skipIf(!go)('not paired: the real bridge asks Google for a QR code, which the dead proxy refuses, and the status says so', async () => {
  expect(built).toBe(true);
  const r = await run(null);
  await r.until(() => r.status()?.attention?.message.includes('would not give a QR code'));
  expect(r.status().attention!.message).toContain('could not reach Google Messages');
  expect(r.status().layers!.find((l) => l.name === 'bridge')).toMatchObject({ state: 'ok', note: expect.stringMatching(/^libgm, pid \d+$/) });
  expect(await r.a.command({ t: 'action', id: '1', action: 'status' })).toMatchObject({ phase: 'pairing', bridge: { version: '0.1.0', client: false } });
}, 60_000);

test.skipIf(!go)('pairing by Google account: the real bridge parses the cookies, and a network failure is not taken for bad cookies', async () => {
  const r = await run(null);
  await r.until(() => r.status()?.attention);
  await expect(r.a.command({ t: 'action', id: '1', action: 'pairGoogle', args: { cookies: 'SID=1' } })).rejects.toThrow('missing Google cookies APISID, HSID, OSID, SAPISID, SSID');
  expect(r.status().attention!.kind).toBe('login');
  await expect(r.a.command({ t: 'action', id: '2', action: 'pairGoogle', args: { cookies: 'curl https://messages.google.com/web/config -H "cookie: SID=s; HSID=h; SSID=ss; APISID=a; SAPISID=sa; OSID=o"' } })).rejects.toThrow('could not reach Google Messages');
  // Reachability, not the cookies: New code tries again with the same ones.
  expect(r.status().attention!.kind).toBe('link_device');
  expect(r.status().attention!.message).toContain('Press New code');
}, 60_000);

test.skipIf(!go)('a stored session: the real bridge takes it, says connected, and its failing connection shows as reconnecting', async () => {
  // A session shaped as libgm writes one: its AES keys and its P-256 refresh key (as a JWK, base64url).
  const key = (await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair).privateKey)) as JsonWebKey;
  const session = {
    refresh_key: { kty: 'EC', crv: 'P-256', d: key.d, x: key.x, y: key.y },
    request_crypto: { aes_key: Buffer.alloc(32, 1).toString('base64'), hmac_key: Buffer.alloc(32, 2).toString('base64') },
    browser: { userID: 1, sourceID: 'browser-1', network: 'Bugle' },
    mobile: { userID: 1, sourceID: 'phone-1', network: 'Bugle' },
    tachyon_token: Buffer.from('token').toString('base64'),
  };
  const r = await run({ session });
  await r.until(() => r.status()?.status === 'online' || r.status()?.layers?.find((l) => l.name === 'connected')?.note?.startsWith('reconnecting'), 30_000);
  expect(r.status().self?.nativeId).toEndWith(':me');
  expect(r.status().layers!.find((l) => l.name === 'paired')).toMatchObject({ state: 'ok', note: 'by QR code' });
  // Whatever the bridge rewrote of the session went back to secret.json whole.
  expect(readSecretFile<Secret>(r.path).session).toMatchObject({ browser: { sourceID: 'browser-1' }, mobile: { sourceID: 'phone-1' } });
}, 60_000);
