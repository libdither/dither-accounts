/**
 * The t3 kind over the real wire: a manager with it, accounts added through the page's API, the extractor on a fake
 * T3 Code (extractors/t3/test/fake-t3-server.ts, its CLI fake-t3.ts), and an app with the hub's chat grant reading
 * what arrives: projects as spaces, threads as channels with their state, turns as messages (long ones whole, tools
 * left out, subagents not shown), live turns from the shell stream, a request waiting, a send and the agent's answer,
 * paging back, read in T3, and the thread list instead of the stream when the server speaks another protocol.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import manifest from '../extractors/t3/manifest.ts';
import { FakeT3 } from '../extractors/t3/test/fake-t3-server.ts';

setDefaultTimeout(30_000);
const ROOT = resolve(import.meta.dir, '..');
const FAKE_CLI = join(ROOT, 'extractors/t3/test/fake-t3.ts');
let m: Manager;
let dir: string;
let hub: AccountsClient;
let t3: FakeT3;
let t3b: FakeT3;
let id: string;
let idB: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const saved = { gap: process.env.DITHER_T3_READ_GAP_MS, poll: process.env.DITHER_T3_POLL_MS, retry: process.env.DITHER_T3_RETRY_MS };

const until = async <T>(f: () => T | undefined | null | false, ms = 10_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const evs = (acc: string, t: string) => (events.get(acc) ?? []).filter((e) => e.t === t);
const msgs = (acc: string, conv: string) => evs(acc, 'message').filter((e) => e.message.conversation === conv);
const msg = (acc: string, conv: string, f: (body: string) => boolean) => msgs(acc, conv).find((e) => f(e.message.body));
const conv = (acc: string, nativeId: string) => evs(acc, 'conversation').filter((e) => e.conversation.nativeId === nativeId).at(-1)?.conversation;
const lastStatus = (acc: string) => evs(acc, 'status').at(-1);
const add = async (label: string, config: Record<string, unknown>) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { origin: m.url }, body: JSON.stringify({ kind: 't3', label, config }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
};

beforeAll(async () => {
  process.env.DITHER_T3_READ_GAP_MS = '150';
  process.env.DITHER_T3_POLL_MS = '300';
  process.env.DITHER_T3_RETRY_MS = '200';
  dir = mkdtempSync(join(tmpdir(), 'dacc-t3-'));
  for (const d of ['mgr', 'base-a', 'base-b']) mkdirSync(join(dir, d));
  t3 = new FakeT3({ baseDir: join(dir, 'base-a') });
  t3b = new FakeT3({ baseDir: join(dir, 'base-b'), noShell: true });
  const kind = kindOf(manifest, join(ROOT, 'extractors/t3'));
  kind.env = { T3_BIN: `${process.execPath} ${FAKE_CLI}` };
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0, kinds: new Map([['t3', kind]]) });
  const reg = await register(m.url, { name: 'dither-chat', requests: [{ interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  hub = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, e) => (events.get(a) ?? events.set(a, []).get(a)!).push(...e) });
  await until(() => hub.connected, 4000, 'the hub connected');
  id = await add('T3 here', { baseDir: join(dir, 'base-a') });
  idB = await add('T3, one project', { baseDir: join(dir, 'base-b'), projects: 'Side Project' });
});
afterAll(async () => {
  hub?.close();
  await m?.stop();
  t3?.stop();
  t3b?.stop();
  for (const [k, v] of Object.entries({ DITHER_T3_READ_GAP_MS: saved.gap, DITHER_T3_POLL_MS: saved.poll, DITHER_T3_RETRY_MS: saved.retry })) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dir, { recursive: true, force: true });
});

test('threads as chats: projects, state, turns (whole, without tools), no subagents, read-only sessions', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  expect(evs(id, 'hello')[0]).toMatchObject({ network: 't3', capabilities: ['send', 'history', 'markRead'] });
  expect(lastStatus(id)!.layers.map((l: any) => `${l.name}:${l.state}`)).toEqual(['t3 command:ok', 'T3 Code:ok', 'sessions:ok', 'live updates:ok', 'threads:ok']);
  expect(evs(id, 'space').map((e) => [e.space.nativeId, e.space.name])).toEqual([
    ['project:proj-a', 'Acme App'],
    ['project:proj-b', 'Side Project'],
  ]);
  expect(conv(id, 'thread-fix')).toMatchObject({ shape: 'channel', name: 'Fix the login button', topic: 'Finished · model-x', spaces: [{ nativeId: 'project:proj-a' }] });
  expect(conv(id, 'thread-bug')).toMatchObject({ topic: 'Working · model-x', spaces: [{ nativeId: 'project:proj-b' }] });
  expect(conv(id, 'thread-sub')).toBeUndefined();

  const fix = msgs(id, 'thread-fix');
  expect(fix.map((e) => e.message.author)).toEqual(['me', 'agent:claudeAgent']);
  expect(fix[1]!.message.body.startsWith('Found it')).toBe(true);
  expect(fix[1]!.message.body.endsWith('THE END')).toBe(true);
  expect(fix[1]!.message.body.length).toBeGreaterThan(80_000);
  expect(fix.every((e) => e.live === false)).toBe(true);
  // A prompt another agent wrote is not yours; a reply still being written waits.
  expect(msgs(id, 'thread-bug').map((e) => [e.message.author, e.message.body])).toEqual([['agent:other', 'A brief from a script.']]);
  expect(evs(id, 'identity').find((e) => e.identity.nativeId === 'agent:claudeAgent')?.identity).toMatchObject({ displayName: 'Claude', isBot: true });
  // The latest twenty of sixty turns; older ones come with history.
  const long = msgs(id, 'thread-long');
  expect(long.length).toBe(20);
  expect(long.at(-1)!.message.body).toBe('answer 29');

  const sessions = [...t3.sessions.values()];
  expect(sessions.map((s) => s.subject).sort()).toEqual(['cli-issued-session', 'mcp-client']);
  expect(sessions.every((s) => s.scopes.join() === 'orchestration:read')).toBe(true);
});

test('live: a turn finishing, a run waiting for an answer, read in T3 Code', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  const t0 = Date.now();
  const bug = t3.threads.get('thread-bug')!;
  const half = bug.items.at(-1)!;
  half.status = 'completed';
  half.text = 'Half written, now whole';
  bug.status = 'completed';
  t3.push('thread-bug');
  const done = await until(() => msg(id, 'thread-bug', (b) => b === 'Half written, now whole'), 5000, 'the finished turn');
  expect(done.live).toBe(true);
  expect(done.message.author).toBe('agent:claudeAgent');
  expect(Date.now() - t0).toBeLessThan(3000);
  await until(() => conv(id, 'thread-bug')?.topic === 'Finished · model-x', 3000, 'the topic');

  const fix = t3.threads.get('thread-fix')!;
  fix.status = 'waiting';
  fix.pending = { id: 'req-1', kind: 'user_input' };
  t3.push('thread-fix');
  const asked = await until(() => msgs(id, 'thread-fix').find((e) => e.message.nativeId === 'request:req-1'), 5000, 'the request');
  expect(asked.live).toBe(true);
  expect(asked.message.body).toBe('Waiting for your answer to its question. Answer it in T3 Code: https://t3.example/threads/thread-fix');
  await until(() => conv(id, 'thread-fix')?.topic === 'Waiting for your answer · model-x', 3000, 'the waiting topic');
  // Pushed again unchanged: said once.
  t3.push('thread-fix');
  await Bun.sleep(300);
  expect(msgs(id, 'thread-fix').filter((e) => e.message.nativeId === 'request:req-1').length).toBe(1);

  fix.pending = null;
  fix.status = 'completed';
  fix.lastVisitedAt = fix.updatedAt + 5000;
  t3.push('thread-fix');
  const read = await until(() => evs(id, 'read').find((e) => e.conversation === 'thread-fix'), 5000, 'the read');
  expect(read.upToTs).toBe(fix.updatedAt + 5000);
});

test('a thread in a project made since: shown once the project is heard of, its turns live', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  t3.newProjectThread('proj-new', 'New Project', 'thread-new', 'start here');
  const first = await until(() => msg(id, 'thread-new', (b) => b === 'start here'), 5000, 'the new thread');
  expect(first).toMatchObject({ live: true, message: { author: 'me' } });
  expect(conv(id, 'thread-new')).toMatchObject({ topic: 'Working · model-y', spaces: [{ nativeId: 'project:proj-new' }] });
  expect(evs(id, 'space').some((e) => e.space.nativeId === 'project:proj-new')).toBe(true);
  expect(evs(id, 'identity').find((e) => e.identity.nativeId === 'agent:codex')?.identity.displayName).toBe('Codex');
});

test("send: the thread's next turn through the CLI, yours, and the agent's answer", async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  const r = (await hub.call(chat, id, 'send', { conversation: 'thread-long', body: 'hello agent' })) as { nativeId: string };
  expect(r.nativeId).toMatch(/^msg-/);
  const mine = await until(() => msgs(id, 'thread-long').find((e) => e.message.nativeId === r.nativeId), 5000, 'the echo');
  // T3 marks it as a client's turn; it was sent from here, so it is yours.
  expect(mine.message).toMatchObject({ author: 'me', body: 'hello agent' });
  const answer = await until(() => msg(id, 'thread-long', (b) => b === 'You said: hello agent'), 5000, 'the answer');
  expect(answer.live).toBe(true);
  expect(t3.sends).toEqual([{ threadId: 'thread-long', message: 'hello agent' }]);
  const calls = readFileSync(join(dir, 'base-a', 'cli-calls.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  expect(calls.find((c) => c[0] === 'thread')).toEqual(['thread', 'send', '--json', '--base-dir', join(dir, 'base-a'), 'thread-long', '-']);

  await expect(hub.call(chat, id, 'send', { conversation: 'thread-nope', body: 'x' })).rejects.toThrow('Not a thread this account shows');
  await expect(hub.call(chat, id, 'send', { conversation: 'thread-long', body: 'x', attachments: [{ name: 'a.png', mime: 'image/png', path: '/tmp/a.png' }] as any })).rejects.toThrow('words only');
  expect(t3.sends.length).toBe(1);
});

test('history: older turns a page at a time, back to the first', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  const oldest = () => Math.min(...msgs(id, 'thread-long').map((e) => e.message.ts));
  const before = msgs(id, 'thread-long').length;
  const p1 = (await hub.call(chat, id, 'history', { conversation: 'thread-long', beforeTs: oldest(), limit: 20 })) as { count: number; done: boolean };
  expect(p1).toMatchObject({ count: 20, done: false });
  expect((await until(() => msg(id, 'thread-long', (b) => b === 'question 10'), 3000, 'page 1')).live).toBe(false);
  const p2 = (await hub.call(chat, id, 'history', { conversation: 'thread-long', beforeTs: oldest(), limit: 20 })) as { count: number; done: boolean };
  expect(p2).toMatchObject({ count: 20, done: true });
  await until(() => msg(id, 'thread-long', (b) => b === 'question 0'), 3000, 'page 2');
  await until(() => new Set(msgs(id, 'thread-long').map((e) => e.message.nativeId)).size === before + 40, 3000, 'all forty');
  expect(new Set(msgs(id, 'thread-long').map((e) => e.message.nativeId)).size).toBe(before + 40);
});

test('without the shell stream: the thread list now and then; only the projects asked for', async () => {
  await until(() => lastStatus(idB)?.status === 'online', 15_000, 'B online');
  const live = lastStatus(idB)!.layers.find((l: any) => l.name === 'live updates');
  expect(live.state).toBe('ok');
  expect(live.note).toContain('the thread list every');
  expect(evs(idB, 'space').map((e) => e.space.nativeId)).toEqual(['project:proj-b']);
  expect(evs(idB, 'conversation').map((e) => e.conversation.nativeId)).toEqual(['thread-bug']);
  t3b.say('thread-bug', 'heard through the list');
  const heard = await until(() => msg(idB, 'thread-bug', (b) => b === 'heard through the list'), 5000, 'the polled turn');
  expect(heard.live).toBe(true);
  // The run is over: the turn it left unfinished is shown as it is, and holds nothing back.
  expect(msg(idB, 'thread-bug', (b) => b === 'Half writ')).toBeTruthy();

  // A request, known only from a read's pendingRequestCount: said once, and the topic stays until it is answered.
  const bug = t3b.threads.get('thread-bug')!;
  bug.pending = { id: 'req-9', kind: 'user_input' };
  bug.status = 'waiting';
  bug.updatedAt += 1;
  const asked = await until(() => msgs(idB, 'thread-bug').find((e) => e.message.nativeId.startsWith('request:')), 5000, 'the request from a read');
  expect(asked.message.body).toBe('Waiting for your answer. Answer it in T3 Code: https://t3.example/threads/thread-bug');
  await until(() => conv(idB, 'thread-bug')?.topic === 'Waiting for your answer · model-x', 3000, 'waiting topic');
  await Bun.sleep(1000);
  const topics = evs(idB, 'conversation').filter((e) => e.conversation.nativeId === 'thread-bug').map((e) => e.conversation.topic as string);
  expect(topics.slice(topics.findIndex((t) => t.startsWith('Waiting'))).every((t) => t.startsWith('Waiting'))).toBe(true);
  expect(msgs(idB, 'thread-bug').filter((e) => e.message.nativeId.startsWith('request:')).length).toBe(1);
  bug.pending = null;
  bug.status = 'completed';
  bug.updatedAt += 1;
  await until(() => conv(idB, 'thread-bug')?.topic === 'Finished · model-x', 5000, 'answered');
});

test('a session revoked in T3 Code: a new one, and nothing missed', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  const before = [...t3.sessions.values()].filter((s) => s.subject === 'mcp-client').length;
  for (const s of t3.sessions.values()) if (s.subject === 'mcp-client') s.revoked = true;
  t3.say('thread-fix', 'after the revoke');
  await until(() => msg(id, 'thread-fix', (b) => b === 'after the revoke'), 8000, 'the turn after the revoke');
  expect([...t3.sessions.values()].filter((s) => s.subject === 'mcp-client' && !s.revoked).length).toBe(1);
  expect([...t3.sessions.values()].filter((s) => s.subject === 'mcp-client').length).toBe(before + 1);
});

test('the stream dropped: it connects again, and what changed meanwhile arrives', async () => {
  await until(() => lastStatus(id)?.status === 'online', 15_000, 'online');
  t3.dropSockets();
  await Bun.sleep(50);
  // Said while nobody listens: the next snapshot brings it.
  const t = t3.threads.get('thread-long')!;
  t3.addItem('thread-long', t3.item('assistant_message', 'said while away', 'agent'));
  t.updatedAt += 1;
  expect((await until(() => msg(id, 'thread-long', (b) => b === 'said while away'), 15_000, 'the turn said while away')).live).toBe(true);
  await until(() => lastStatus(id)!.layers.find((l: any) => l.name === 'live updates')?.note === 'the shell stream', 5000, 'the stream back');
});
