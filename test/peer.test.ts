/**
 * A peer account (docs/peer.md): a chat account another manager holds, shown by this one through the other's grants.
 * Two managers in this process on their own ports and temp dirs: "there" holds a fake chat account; "here" adds a
 * peer of it, which registers there and waits for approval. Approved at read, its facts reach an app here, its reads
 * pass through, and its writes are refused: by the peer's own cap, and by the other side's grant when the cap allows
 * more. The other manager going away and coming back on the same port brings the facts again. Nothing leaves.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';

let dir: string;
let there: Manager;
let here: Manager;
let app: AccountsClient;
let fakeId: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const post = async <T = any>(m: Manager, path: string, body: unknown): Promise<T> => (await fetch(m.url + path, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;
const state = async (m: Manager) => (await fetch(`${m.url}/api/state`)).json() as Promise<any>;
const lastStatus = (id: string) => (events.get(id) ?? []).filter((e) => e.t === 'status').at(-1);
const bodies = (id: string) => (events.get(id) ?? []).filter((e) => e.t === 'message').map((e) => e.message.body as string);

/** The pending request a peer made there (its app is named after the peer's label), approved as asked. */
async function approveThere(label: string) {
  const r = await until(async () => (await state(there)).apps.find((a: any) => a.name === `peer ${label}`)?.requests.find((q: any) => q.state === 'pending'), 15_000, `${label}'s request there`);
  await post(there, `/api/requests/${r.id}/approve`, {});
  return r;
}

async function startThere(port = 0) {
  there = await createManager({ openPage: true, dataDir: join(dir, 'there'), port });
  there.kinds.get('chat-fake')!.add = { blurb: 'for tests' };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-peer-'));
  mkdirSync(join(dir, 'there'));
  mkdirSync(join(dir, 'here'));
  await startThere();
  fakeId = (await post<{ id: string }>(there, '/api/accounts', { kind: 'chat-fake', label: 'Fake there' })).id;
  await until(async () => (await state(there)).accounts.find((a: any) => a.id === fakeId)?.online, 10_000, 'the fake online there');

  here = await createManager({ openPage: true, dataDir: join(dir, 'here'), port: 0 });
  // An app here that reads and writes chat on every account, as a hub would.
  const reg = await register(here.url, { name: 'hub here', requests: [{ interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) await post(here, `/api/requests/${r.id}/approve`, {});
  app = new AccountsClient({ url: here.url, app: reg.app, token: reg.token, onEvents: (a, evs) => (events.get(a) ?? events.set(a, []).get(a)!).push(...evs) });
  await until(() => app.connected, 4000, 'the app here connected');
});

afterAll(async () => {
  app?.close();
  await here?.stop();
  await there?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a peer waits for approval there, then its account is seen here: hello, status, the facts, and a read', async () => {
  const id = (await post<{ id: string }>(here, '/api/accounts', { kind: 'peer', label: 'Fake through', config: { url: there.url, account: fakeId } })).id;
  await until(() => lastStatus(id)?.attention?.message?.includes('Approve'), 15_000, 'it asks for approval');
  expect(lastStatus(id)).toMatchObject({ status: 'attention' });

  const req = await approveThere('Fake through');
  // It asked for chat, at read, on that one account only.
  expect(req).toMatchObject({ interface: 'chat', level: 'read', accounts: [fakeId] });

  await until(() => bodies(id).includes('an old message'), 15_000, 'the snapshot through the peer');
  expect(events.get(id)!.find((e) => e.t === 'hello')).toMatchObject({ network: 'matrix', version: 'fake' });
  await until(() => lastStatus(id)?.status === 'online', 5000, 'online here');
  expect(lastStatus(id)!.attention).toBeNull();
  expect(lastStatus(id)!.self).toMatchObject({ displayName: 'Me' });
  // A read passes through and comes back with the other side's answer.
  expect(await app.call(chat, id, 'history', { conversation: 'dm:me:alice' } as any)).toEqual({ count: 0, done: true });
}, 60_000);

test("a write is refused by the peer's cap before it leaves", async () => {
  const id = (await state(here)).accounts.find((a: any) => a.label === 'Fake through').id;
  await expect(app.call(chat, id, 'send', { conversation: 'dm:me:alice', body: 'must not go' })).rejects.toThrow('send needs write, and this account passes on at most read');
  expect(bodies(id)).not.toContain('must not go');
});

test("a peer whose cap allows writes is still held to the other side's grant", async () => {
  const id = (await post<{ id: string }>(here, '/api/accounts', { kind: 'peer', label: 'Fake wide', config: { url: there.url, account: fakeId, level: 'write' } })).id;
  const r = await until(async () => (await state(there)).apps.find((a: any) => a.name === 'peer Fake wide')?.requests.find((q: any) => q.state === 'pending'), 15_000, 'its request there');
  expect(r.level).toBe('write');
  // The owner there grants less than it asked for: read.
  await post(there, `/api/requests/${r.id}/approve`, { level: 'read' });
  await until(() => bodies(id).includes('an old message'), 15_000, 'its facts');
  await expect(app.call(chat, id, 'send', { conversation: 'dm:me:alice', body: 'not this either' })).rejects.toThrow(/said denied/);
  expect(bodies(id)).not.toContain('not this either');
}, 60_000);

test('events there arrive here as they happen', async () => {
  const id = (await state(here)).accounts.find((a: any) => a.label === 'Fake through').id;
  const before = bodies(id).length;
  // The page there makes the fake say something (its emit action), as a new message would arrive.
  await post(there, `/api/accounts/${fakeId}/call`, { op: 'action', input: { action: 'emit', args: { n: 2 } } });
  await until(() => bodies(id).slice(before).includes('hello 1'), 10_000, 'the live messages');
});

test('the other manager going away and coming back: offline here, then the facts again', async () => {
  const id = (await state(here)).accounts.find((a: any) => a.label === 'Fake through').id;
  const port = Number(new URL(there.url).port);
  await there.stop();
  await until(() => lastStatus(id)?.status === 'offline', 15_000, 'offline here');
  const seen = events.get(id)!.length;
  await startThere(port);
  await until(() => events.get(id)!.slice(seen).some((e) => e.t === 'message' && e.message.body === 'an old message'), 30_000, 'the facts again');
  await until(() => lastStatus(id)?.status === 'online', 10_000, 'online again');
}, 60_000);
