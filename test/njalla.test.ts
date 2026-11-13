/**
 * Njalla accounts over the real wire: a manager with the njalla kind, an account added through its HTTP API as the
 * page adds it, the extractor talking to the fake Njalla, and an app with a dns grant reading and changing records
 * and hearing dns.changed. Covers the add form, status (self, details, layers), every op, names given in full, the
 * `zones` setting, a token restricted by Njalla to some domains, a revoked token and a new one picked up without a
 * restart, HTTP failures, and that nothing but the record methods is ever sent.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { dns } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import manifest from '../extractors/njalla/manifest.ts';
import { relName } from '../extractors/njalla/src/names.ts';
import { type FakeNjalla, startFakeNjalla } from '../extractors/njalla/test/fake-njalla.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
const TOKEN = 'njallaToken0000000000000000000001';
let fake: FakeNjalla;
let m: Manager;
let dir: string;
let app: AccountsClient;
let account: string;
const saved: Record<string, string | undefined> = {};
type Ev = { account: string; t: string; [k: string]: any };
const events: Ev[] = [];

const until = async (f: () => unknown | Promise<unknown>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, init: RequestInit = {}) => fetch(m.url + path, { ...init, headers: { 'content-type': 'application/json', origin: m.url, ...(init.headers ?? {}) } });
const detail = async (id = account) => (await (await api(`/api/accounts/${id}`)).json()) as any;
const status = async (id = account) => (await detail(id)).status as any;
const add = async (token: string | undefined, config: Record<string, string> = {}, label = 'Njalla') => {
  const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ kind: 'njalla', label, config, secret: token === undefined ? {} : { token } }) });
  return { status: r.status, body: (await r.json()) as any };
};
const call = (op: keyof (typeof dns)['ops'] & string, input: any, id = account) => app.call(dns, id, op as any, input) as Promise<any>;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as CallFailed;
  }
  throw new Error('expected the call to fail');
};
const online = (id = account) => until(async () => (await status(id))?.status === 'online', 10_000, `${id} online`);

beforeAll(async () => {
  fake = startFakeNjalla();
  fake.addToken(TOKEN);
  fake.addDomain('example.com', [
    { name: '@', type: 'A', content: '203.0.113.7', ttl: 3600 },
    { name: 'www', type: 'CNAME', content: 'example.com', ttl: 3600 },
    { name: '@', type: 'MX', content: 'mail.example.com', ttl: 3600, prio: 10 },
  ]);
  fake.addDomain('example.org');
  for (const [k, v] of Object.entries({ DITHER_NJALLA_API_URL: fake.url, DITHER_NJALLA_RECHECK_MS: '500' })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = mkdtempSync(join(tmpdir(), 'dacc-njalla-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['njalla', kindOf(manifest, join(ROOT, 'extractors/njalla'))]]) });
  const reg = await register(m.url, { name: 'dns-tool', requests: [{ interface: 'dns', level: 'write' }] });
  expect((await api(`/api/requests/${reg.requests[0].id}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => events.push(...evs.map((e) => ({ ...e, account: a }) as Ev)) });
  await until(() => app.connected, 4000, 'the app connected');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('names: relative to the zone, @ for the zone itself, a full name cut down', () => {
  expect(relName('@', 'example.com')).toBe('@');
  expect(relName('', 'example.com')).toBe('@');
  expect(relName('example.com.', 'example.com')).toBe('@');
  expect(relName('www.example.com', 'example.com')).toBe('www');
  expect(relName('_acme-challenge.home.example.com.', 'example.com')).toBe('_acme-challenge.home');
  expect(relName('trip', 'example.com')).toBe('trip');
  expect(relName('notexample.com', 'example.com')).toBe('notexample.com');
});

test('the add form: a token kept in secret.json, an optional list of domains', async () => {
  const kinds = ((await (await api('/api/state')).json()) as any).kinds;
  const k = kinds.find((x: any) => x.kind === 'njalla');
  expect(k.interfaces).toEqual(['dns']);
  expect(k.add.fields.map((f: any) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['token', true, false],
    ['zones', false, true],
  ]);
  expect(k.add.blurb).toContain('Settings → API');
  expect((await add(undefined)).status).toBe(400);
  expect((await add('short')).status).toBe(400);
  const ok = await add(TOKEN);
  expect(ok.status).toBe(200);
  account = ok.body.id;
  const acc = m.store.account(account)!;
  const secret = join(acc.dir, 'secret.json');
  expect(statSync(secret).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(secret, 'utf8'))).toEqual({ token: TOKEN });
});

test('online: its domains, details and layers; the token goes only to Njalla', async () => {
  await online();
  const st = await status();
  expect(st.details.zones).toEqual(['example.com', 'example.org']);
  expect(st.details.onlyZones).toBeNull();
  expect(st.layers.map((l: any) => [l.name, l.state])).toEqual([
    ['token', 'ok'],
    ['api', 'ok'],
  ]);
  const d = await detail();
  expect(d.account.self.name).toBe('Njalla');
  expect(d.account.self.detail).toBe('2 domains');
  expect(JSON.stringify(st)).not.toContain(TOKEN);
  expect(fake.calls.every((c) => c.token === TOKEN)).toBe(true);
  expect(JSON.stringify(d)).not.toContain(TOKEN);
});

test('dns.zones and dns.records', async () => {
  const z = await call('dns.zones', {});
  expect(z.zones).toEqual([
    { name: 'example.com', status: 'active', expiry: '2027-08-01T00:00:00Z' },
    { name: 'example.org', status: 'active', expiry: '2027-08-01T00:00:00Z' },
  ]);
  const r = await call('dns.records', { zone: 'Example.COM.' });
  expect(r.records.map((x: any) => [x.name, x.type, x.content, x.ttl, x.prio ?? null])).toEqual([
    ['@', 'A', '203.0.113.7', 3600, null],
    ['www', 'CNAME', 'example.com', 3600, null],
    ['@', 'MX', 'mail.example.com', 3600, 10],
  ]);
  expect(typeof r.records[0].id).toBe('string');
  expect((await fails(call('dns.records', { zone: 'nope' }))).status).toBe(400);
  const missing = await fails(call('dns.records', { zone: 'example.net' }));
  expect(missing.status).toBe(404);
  expect(missing.message).toContain('Domain not found');
});

test('dns.add, dns.edit and dns.remove, each heard as dns.changed', async () => {
  const before = events.filter((e) => e.t === 'dns.changed').length;
  const a = await call('dns.add', { zone: 'example.com', name: 'trip.example.com.', type: 'cname', content: 'vps.example.net' });
  expect(a.record).toMatchObject({ name: 'trip', type: 'CNAME', content: 'vps.example.net', ttl: 300 });
  expect(fake.records('example.com').find((r) => r.name === 'trip')?.content).toBe('vps.example.net');
  const e = await call('dns.edit', { zone: 'example.com', id: a.record.id, ttl: 3600 });
  expect(e.record).toMatchObject({ id: a.record.id, name: 'trip', content: 'vps.example.net', ttl: 3600 });
  // Njalla's edit-record gets the record whole: the content went too, unchanged.
  expect(fake.calls.filter((c) => c.method === 'edit-record').at(-1)!.params).toEqual({ domain: 'example.com', id: a.record.id, content: 'vps.example.net', ttl: 3600 });
  await call('dns.remove', { zone: 'example.com', id: a.record.id });
  expect(fake.records('example.com').some((r) => r.name === 'trip')).toBe(false);
  await until(() => events.filter((x) => x.t === 'dns.changed' && x.zone === 'example.com').length >= before + 3, 3000, 'three dns.changed');
  expect((await fails(call('dns.remove', { zone: 'example.com', id: a.record.id }))).status).toBe(404);
  // Njalla's own refusals come back with its words.
  const bad = await fails(call('dns.add', { zone: 'example.com', name: '@', type: 'CNAME', content: 'x.example.net' }));
  expect(bad.status).toBe(400);
  expect(bad.message).toContain('CNAME not allowed');
  expect((await fails(call('dns.add', { zone: 'example.com', name: 'x', type: 'A', content: '' }))).status).toBe(400);
});

test('dns.set: adds when there is none, leaves an exact one alone, changes one, removes the rest', async () => {
  const first = await call('dns.set', { zone: 'example.com', name: 'trip', type: 'CNAME', content: 'vps.example.net' });
  expect(first.changed).toBe(true);
  expect(first.removed).toEqual([]);
  const writes = () => fake.calls.filter((c) => c.method !== 'list-records' && c.method !== 'list-domains').length;
  const w = writes();
  const again = await call('dns.set', { zone: 'example.com', name: 'trip.example.com', type: 'CNAME', content: 'VPS.example.net.' });
  expect(again).toEqual({ record: first.record, changed: false, removed: [] });
  expect(writes()).toBe(w);
  const moved = await call('dns.set', { zone: 'example.com', name: 'trip', type: 'CNAME', content: 'other.example.net', ttl: 900 });
  expect(moved.changed).toBe(true);
  expect(moved.record).toMatchObject({ id: first.record.id, content: 'other.example.net', ttl: 900 });
  // Two TXT records of one name become the one asked for.
  const t1 = await call('dns.add', { zone: 'example.org', name: '_x', type: 'TXT', content: 'one' });
  const t2 = await call('dns.add', { zone: 'example.org', name: '_x', type: 'TXT', content: 'two' });
  const one = await call('dns.set', { zone: 'example.org', name: '_x', type: 'TXT', content: 'two' });
  expect(one.record.id).toBe(t2.record.id);
  expect(one.removed).toEqual([t1.record.id]);
  expect(fake.records('example.org').filter((r) => r.name === '_x').map((r) => r.content)).toEqual(['two']);
});

test('the zones setting: other domains are neither listed nor touched', async () => {
  const r = await add(TOKEN, { zones: 'example.org' }, 'Njalla (org only)');
  expect(r.status).toBe(200);
  const id = r.body.id;
  await online(id);
  expect((await status(id)).details.onlyZones).toEqual(['example.org']);
  expect((await call('dns.zones', {}, id)).zones.map((z: any) => z.name)).toEqual(['example.org']);
  const n = fake.calls.length;
  const no = await fails(call('dns.set', { zone: 'example.com', name: 'x', type: 'A', content: '203.0.113.9' }, id));
  expect(no.status).toBe(403);
  expect(no.message).toContain('not one of this account');
  expect(fake.calls.length).toBe(n);
  expect((await call('dns.records', { zone: 'example.org' }, id)).records.length).toBeGreaterThan(0);
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
});

test("a token Njalla restricts to some domains: refused the others, still online", async () => {
  const limited = 'njallaToken0000000000000000000002';
  fake.addToken(limited, ['example.org']);
  const r = await add(limited, {}, 'Njalla (limited)');
  const id = r.body.id;
  await online(id);
  expect((await status(id)).details.zones).toEqual(['example.org']);
  const no = await fails(call('dns.records', { zone: 'example.com' }, id));
  expect(no.status).toBe(403);
  await Bun.sleep(300);
  expect((await status(id)).status).toBe('online');
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
});

test('a revoked token asks for attention; a new one in secret.json is picked up without a restart', async () => {
  fake.revoke(TOKEN);
  await until(async () => (await status())?.status === 'attention', 10_000, 'attention');
  const st = await status();
  expect(st.attention.kind).toBe('login');
  expect(st.attention.message).toContain('Permission denied');
  expect(st.layers[0]).toMatchObject({ name: 'token', state: 'failed' });
  expect((await fails(call('dns.zones', {}))).status).toBe(401);
  const fresh = 'njallaToken0000000000000000000003';
  fake.addToken(fresh);
  writeSecretFile(join(m.store.account(account)!.dir, 'secret.json'), { token: fresh });
  await online();
  expect((await call('dns.records', { zone: 'example.org' })).records.length).toBeGreaterThan(0);
  expect(fake.calls.at(-1)!.token).toBe(fresh);
});

test('HTTP failures: 5xx and 429 fail the call with a status an app can act on', async () => {
  fake.failNext(503);
  expect((await fails(call('dns.records', { zone: 'example.com' }))).status).toBe(502);
  fake.failNext(429);
  expect((await fails(call('dns.records', { zone: 'example.com' }))).status).toBe(429);
  expect((await call('dns.records', { zone: 'example.com' })).records.length).toBeGreaterThan(0);
});

test('scripts/dns.ts: registers itself, waits for its grant, then sets and lists records', async () => {
  const credFile = join(dir, 'dns-cli.json');
  // Not spawnSync: the manager runs in this process and has to answer the tool meanwhile.
  const run = async (...args: string[]) => {
    const p = Bun.spawn(['bun', join(ROOT, 'scripts/dns.ts'), ...args, '--url', m.url], { env: { ...process.env, DITHER_DNS_CLI_FILE: credFile }, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };
  const first = await run('zones');
  expect(first.code).toBe(2);
  expect(first.err).toContain('cli.ts approve');
  expect(statSync(credFile).mode & 0o777).toBe(0o600);
  const req = first.err.match(/approve (\S+)/)![1];
  expect((await api(`/api/requests/${req}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
  expect((await run('zones')).out).toContain('example.com');
  const set = await run('set', 'example.com', 'cli.example.com.', 'TXT', 'hello there', '--ttl', '3600');
  expect(set.code).toBe(0);
  expect(set.out).toMatch(/^set: \d+\s+cli\s+TXT\s+3600\s+hello there/);
  expect((await run('set', 'example.com', 'cli', 'TXT', 'hello there', '--ttl', '3600')).out).toMatch(/^already so:/);
  const listed = JSON.parse((await run('records', 'example.com', '--name', 'cli', '--json')).out);
  expect(listed.records.map((r: any) => [r.name, r.type, r.content])).toEqual([['cli', 'TXT', 'hello there']]);
  expect((await run('remove', 'example.com', listed.records[0].id)).out).toContain('removed');
  const bad = await run('records', 'example.net');
  expect(bad.code).toBe(1);
  expect(bad.err).toContain('Domain not found');
});

test('only the five record methods ever went out', () => {
  const sent = new Set(fake.calls.map((c) => c.method));
  for (const mth of sent) expect(['list-domains', 'list-records', 'add-record', 'edit-record', 'remove-record']).toContain(mth);
});
