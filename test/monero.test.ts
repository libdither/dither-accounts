/**
 * The monero extractor through a real manager, against stand-ins for monero-wallet-rpc and monero-wallet-cli
 * (extractors/monero/test/fake-bin) and a fake node: key images through monero.view (checked, stored 600), a first
 * pull that makes the wallet, scans, imports the key images and writes exactly the bytes dither-finance's
 * connectors/monero.py wrote for the same wallet answers (test/fixtures/monero.json, made by make-fixtures.ts from
 * the real monero.py; only pulled_at differs, and the name follows it), a second pull that reopens the wallet and does
 * not import again, the grant's limits (statements read cannot give key images), key images from the account's page
 * (the Monero form's call, no app grant), and no key on the wire.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { moneroView, statements } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager, type Manifest } from '@dither-accounts/manager';
import { ADDRESS, fakeNode, KEY_IMAGES, VIEW_KEY } from '../extractors/monero/test/fake-node.ts';

setDefaultTimeout(60_000);
const ROOT = resolve(import.meta.dir, '..');
const KIND = join(ROOT, 'extractors/monero');
const FIX = join(KIND, 'test/fixtures/monero.json');

let node: ReturnType<typeof fakeNode>;
let m: Manager;
let dir: string;
let app: AccountsClient;
let reader: AccountsClient;
let acc: string;
let accDir: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const evs = (id: string, t: string) => (events.get(id) ?? []).filter((e) => e.t === t);
const lastStatus = (id: string) => evs(id, 'status').at(-1);
const until = async <T>(f: () => T | undefined | null | false, ms = 20_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await Bun.sleep(30);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const call = (op: string, input: any) => app.call(statements, acc, op as any, input) as Promise<any>;
const pulled = (n: number) => until(() => evs(acc, 'statements.pulled')[n - 1], 30_000, `pull ${n}`);
const grantAll = async () => {
  const st = (await (await fetch(`${m.url}/api/state`)).json()) as any;
  for (const a of st.apps) for (const r of a.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
};

beforeAll(async () => {
  node = fakeNode();
  dir = mkdtempSync(join(tmpdir(), 'dacc-xmr-'));
  const manifest = (await import(join(KIND, 'manifest.ts'))).default as Manifest;
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['monero', kindOf(manifest, KIND)]]) });
  const reg = await register(m.url, {
    name: 'finance-test',
    requests: [
      { interface: 'statements', level: 'read', kinds: ['monero'] },
      { interface: 'monero.view', level: 'manage', kinds: ['monero'] },
    ],
  });
  const reg2 = await register(m.url, { name: 'reader', requests: [{ interface: 'statements', level: 'read' }] });
  await grantAll();
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => events.set(a, [...(events.get(a) ?? []), ...list]) });
  reader = new AccountsClient({ url: m.url, app: reg2.app, token: reg2.token });
  await until(() => app.connected && reader.connected, 5000, 'connected');
  const r = await fetch(`${m.url}/api/accounts`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'monero', label: 'Cold', config: { binDir: join(KIND, 'test/fake-bin'), node: `127.0.0.1:${node.port}`, restoreHeight: '3300000', schedule: false }, secret: { address: ADDRESS, viewKey: VIEW_KEY } }),
  });
  const b = (await r.json()) as any;
  if (!r.ok) throw new Error(b.error);
  acc = b.id;
  accDir = join(dir, 'accounts', acc);
  await until(() => lastStatus(acc)?.status === 'online' && app.accounts.find((a) => a.id === acc)?.online, 20_000, 'online');
});
afterAll(async () => {
  app?.close();
  reader?.close();
  await m?.stop();
  node?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('key images: checked, stored 600, and only with monero.view at manage', async () => {
  const ki = (base64: string, c = app) => c.call(moneroView, acc, 'monero.keyImages', { base64 }) as Promise<any>;
  await expect(ki('')).rejects.toThrow(/no key images/);
  await expect(ki(Buffer.from('not key images').toString('base64'))).rejects.toThrow(/not a Monero key image export/);
  expect(await ki(KEY_IMAGES.toString('base64'))).toEqual({ saved: true, size: KEY_IMAGES.length });
  expect(readFileSync(join(accDir, 'key_images')).equals(KEY_IMAGES)).toBe(true);
  expect(statSync(join(accDir, 'key_images')).mode & 0o777).toBe(0o600);
  const e = await ki(KEY_IMAGES.toString('base64'), reader).catch((x) => x);
  expect(e).toBeInstanceOf(CallFailed);
  expect(e.code).toBe('denied');
  await until(() => lastStatus(acc)?.details?.keyImagesWaiting === true, 5000, 'waiting');
});

test("key images from the account's page (its Monero form): the page's own call, with no app's grant", async () => {
  const give = async (base64: string) =>
    (await (await fetch(`${m.url}/api/accounts/${acc}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'monero.keyImages', input: { base64 } }) })).json()) as any;
  expect(await give(KEY_IMAGES.toString('base64'))).toMatchObject({ ok: true, result: { saved: true, size: KEY_IMAGES.length } });
  expect(readFileSync(join(accDir, 'key_images')).equals(KEY_IMAGES)).toBe(true);
  const bad = await give(Buffer.from('not key images').toString('base64'));
  expect(bad.ok).toBe(false);
  expect(bad.error.message).toMatch(/not a Monero key image export/);
});

test("the first pull writes monero.py's bytes", async () => {
  expect(await call('statements.refresh', {})).toEqual({ started: true });
  expect(await pulled(1)).toMatchObject({ ok: true, saved: 1 });
  const { files } = await call('statements.list', {});
  expect(files.length).toBe(1);
  const f = files[0];
  expect(f).toMatchObject({ seq: 1, dir: '', mime: 'application/json' });
  const got = Buffer.from((await call('statements.fetch', { id: f.id })).base64, 'base64').toString('utf8');
  const at = got.match(/"pulled_at": "([^"]+)"/)![1];
  expect(f.name).toBe(`monero-${at.replace(/[:-]/g, '')}.json`);
  expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(30_000);
  const want = readFileSync(FIX, 'utf8').replace(/"pulled_at": "[^"]+"/, `"pulled_at": "${at}"`);
  expect(got).toBe(want);
  expect(f.sha256).toBe(new Bun.CryptoHasher('sha256').update(want).digest('hex'));
  // The wallet: made here, 700, its password 600; the key images imported (marker), and logged by the fakes.
  for (const x of ['view', 'view.keys', 'password', 'ki-imported', 'rpc.log']) expect(existsSync(join(accDir, 'wallet', x))).toBe(true);
  expect(statSync(join(accDir, 'wallet')).mode & 0o777).toBe(0o700);
  expect(statSync(join(accDir, 'wallet/password')).mode & 0o777).toBe(0o600);
  const rpcLog = readFileSync(join(accDir, 'wallet/rpc.log'), 'utf8');
  expect(rpcLog).toContain('generate_from_keys');
  await until(() => lastStatus(acc)?.details?.keyImagesImported === true && lastStatus(acc)?.details?.transfers === 4, 5000, 'status');
});

test('a second pull reopens the wallet and does not import the key images again', async () => {
  const marker = statSync(join(accDir, 'wallet/ki-imported')).mtimeMs;
  await call('statements.refresh', {});
  expect(await pulled(2)).toMatchObject({ ok: true, saved: 1 });
  expect(statSync(join(accDir, 'wallet/ki-imported')).mtimeMs).toBe(marker);
  const log = readFileSync(join(accDir, 'wallet/rpc.log'), 'utf8');
  expect(log.match(/generate_from_keys/g)!.length).toBe(1);
  expect(log.match(/open_wallet/g)!.length).toBe(3);
  expect(lastStatus(acc)!.details.lastScanBlocks).toBe(0);
  expect((await call('statements.list', { after: 1 })).files.length).toBe(1);
});

test('statements.accounts names the wallet; nothing secret on the wire', async () => {
  expect(await call('statements.accounts', {})).toEqual({ accounts: [{ id: ADDRESS.slice(0, 8), name: 'Cold', institution: 'Monero (view-only)', currency: 'XMR', kind: 'wallet' }] });
  const wire = JSON.stringify([...events.values()]);
  expect(wire).not.toContain(VIEW_KEY);
  expect(wire).not.toContain(ADDRESS);
  expect(wire).not.toContain(readFileSync(join(accDir, 'wallet/password'), 'utf8'));
  expect(JSON.stringify(lastStatus(acc))).not.toMatch(/balance/i);
});
