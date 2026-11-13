/**
 * The simplefin extractor through a real manager and an app with a `statements` read grant, against the fake bridge
 * (extractors/simplefin/test/fake-bridge.ts): a pull writes exactly the bytes dither-finance's simplefin/sfin.py wrote
 * for the same responses (test/fixtures, made by make-fixtures.ts from the real sfin.py), under the same names, after
 * asking for the same windows; then the cursor (list, fetch, ack), statements.accounts without balances, one pull at
 * a time, a revoked access URL as attention, the setup token's claim, and no secret on the wire.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { statements } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager, type Manifest } from '@dither-accounts/manager';
import { accessParts, claim, windows } from '../extractors/simplefin/src/bridge.ts';
import { FakeBridge, PASS, USER } from '../extractors/simplefin/test/fake-bridge.ts';

setDefaultTimeout(60_000);
const ROOT = resolve(import.meta.dir, '..');
const KIND = join(ROOT, 'extractors/simplefin');
const FIX = join(KIND, 'test/fixtures');

let bridge: FakeBridge;
let m: Manager;
let dir: string;
let app: AccountsClient;
let acc: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const evs = (id: string, t: string) => (events.get(id) ?? []).filter((e) => e.t === t);
const lastStatus = (id: string) => evs(id, 'status').at(-1);
const until = async <T>(f: () => T | undefined | null | false, ms = 15_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await Bun.sleep(30);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const call = (op: string, input: any, account = acc) => app.call(statements, account, op as any, input) as Promise<any>;
const add = async (label: string, secret: unknown, config: Record<string, unknown> = { schedule: false }) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', body: JSON.stringify({ kind: 'simplefin', label, config, secret }) });
  const b = (await r.json()) as any;
  if (!r.ok) throw new Error(b.error);
  return b.id as string;
};
const pulled = async (id: string, n: number) => until(() => evs(id, 'statements.pulled')[n - 1], 20_000, `pull ${n}`);

beforeAll(async () => {
  bridge = new FakeBridge().start();
  dir = mkdtempSync(join(tmpdir(), 'dacc-sfin-'));
  const manifest = (await import(join(KIND, 'manifest.ts'))).default as Manifest;
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['simplefin', kindOf(manifest, KIND)]]) });
  const reg = await register(m.url, { name: 'finance-test', requests: [{ interface: 'statements', level: 'read', kinds: ['simplefin'] }] });
  const st = (await (await fetch(`${m.url}/api/state`)).json()) as any;
  for (const a of st.apps) for (const r of a.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => events.set(a, [...(events.get(a) ?? []), ...list]) });
  await until(() => app.connected, 5000, 'connected');
  acc = await add('Bridge', { accessUrl: bridge.accessUrl }, { schedule: false, days: 100 });
  await until(() => lastStatus(acc)?.status === 'online' && app.accounts.find((a) => a.id === acc)?.online, 20_000, 'online');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  bridge?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a pull writes sfin.py's bytes, names and windows", async () => {
  const t0 = Date.now();
  expect(await call('statements.refresh', {})).toEqual({ started: true });
  const p = await pulled(acc, 1);
  expect(p).toMatchObject({ ok: true, saved: 3 });
  const fx = JSON.parse(readFileSync(join(FIX, 'windows.json'), 'utf8'));
  // The same requests, relative to each puller's own clock.
  const now = Number(bridge.requests[0].query['end-date']) - 86400;
  expect(Math.abs(now * 1000 - t0)).toBeLessThan(5000);
  expect(bridge.requests.map((r) => ({ keys: Object.keys(r.query), start: Number(r.query['start-date']) - now, end: Number(r.query['end-date']) - now }))).toEqual(fx.windows);
  expect(bridge.requests.every((r) => r.authOk && r.query.version === '2' && r.query.pending === '1')).toBe(true);
  const { files, next } = await call('statements.list', {});
  expect(next).toBe(3);
  expect(files.map((f: any) => f.name.replace(/\d{8}T\d{6}/, 'STAMP'))).toEqual(fx.names);
  expect(new Set(files.map((f: any) => f.name.match(/\d{8}T\d{6}/)[0])).size).toBe(1);
  expect(files.every((f: any) => f.dir === '' && f.mime === 'application/json' && f.coverage.to > f.coverage.from)).toBe(true);
  expect(evs(acc, 'statements.file').map((e) => e.file.seq)).toEqual([1, 2, 3]);
  for (const [i, f] of files.entries()) {
    const want = readFileSync(join(FIX, `sfin-w${i}.json`));
    const got = await call('statements.fetch', { id: f.id });
    expect(Buffer.from(got.base64, 'base64').equals(want)).toBe(true);
    expect(got.sha256).toBe(new Bun.CryptoHasher('sha256').update(want).digest('hex'));
    expect(f.sha256).toBe(got.sha256);
  }
  // The stamp is local time, as time.strftime writes it (asked of date(1): bun test runs this process in UTC).
  const local = (sec: number) => Bun.spawnSync(['date', '-d', `@${sec}`, '+%Y%m%dT%H%M%S']).stdout.toString().trim();
  const sec = Math.floor(t0 / 1000);
  expect([local(sec), local(sec + 1), local(sec + 2)]).toContain(files[0].name.match(/\d{8}T\d{6}/)[0]);
});

test('the cursor: ack, list after it; the accounts by name only', async () => {
  expect(await call('statements.ack', { through: 2 })).toEqual({ acked: 2 });
  expect((await call('statements.list', { after: 2 })).files.map((f: any) => f.seq)).toEqual([3]);
  const { accounts } = await call('statements.accounts', {});
  expect(accounts).toEqual([
    { id: 'ACT-1', name: 'Checking — 💳', institution: 'Example Bank', currency: 'USD', kind: 'unknown' },
    { id: 'ACT-2', name: 'Card', institution: 'Example Bank', currency: 'USD', kind: 'unknown' },
  ]);
  expect(JSON.stringify(accounts)).not.toContain('balance');
});

test('the daily days: one window of 30; one pull at a time', async () => {
  bridge.reset();
  bridge.delayMs = 500;
  expect(await call('statements.refresh', { days: 30 })).toEqual({ started: true });
  const second = await call('statements.refresh', {});
  expect(second.started).toBe(false);
  expect(second.reason).toMatch(/a pull is running/);
  expect(await pulled(acc, 2)).toMatchObject({ ok: true, saved: 1 });
  bridge.delayMs = 0;
  expect(bridge.requests.length).toBe(1);
  const q = bridge.requests[0].query;
  expect(Number(q['end-date']) - Number(q['start-date'])).toBe(31 * 86400);
  expect(windows(1000 * 86400, 30)).toEqual([[970 * 86400, 1001 * 86400]]);
});

test('a revoked access URL is attention, and the next good pull clears it', async () => {
  bridge.failWith = 403;
  await call('statements.refresh', {});
  const p = await pulled(acc, 3);
  expect(p.ok).toBe(false);
  expect(p.needs).toMatch(/403/);
  await until(() => lastStatus(acc)?.status === 'attention', 5000, 'attention');
  expect(lastStatus(acc)!.attention.kind).toBe('login');
  bridge.failWith = null;
  await call('statements.refresh', { days: 30 });
  expect((await pulled(acc, 4)).ok).toBe(true);
  await until(() => lastStatus(acc)?.status === 'online', 5000, 'online again');
});

test('no secret on the wire', () => {
  const wire = JSON.stringify([...events.values()]);
  expect(wire).not.toContain(PASS);
  expect(wire).not.toContain(encodeURIComponent(PASS));
  expect(wire).not.toContain(USER);
});

test('a setup token is claimed once for the access URL', async () => {
  expect(await claim(bridge.setupToken('t2'), { fetch })).toBe(bridge.accessUrl);
  await expect(claim(bridge.setupToken('t2'), { fetch })).rejects.toThrow(/403/);
  await expect(claim(Buffer.from('http://x/claim').toString('base64'))).rejects.toThrow(/https/);
  expect(accessParts('https://u%40x:p%2Fw@bridge.example:8443/simplefin/')).toEqual({ url: 'https://bridge.example:8443/simplefin/accounts', auth: `Basic ${Buffer.from('u@x:p/w').toString('base64')}`, host: 'bridge.example' });
});
