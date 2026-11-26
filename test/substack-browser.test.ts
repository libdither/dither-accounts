/**
 * extractors/substack end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc)
 * with its extension, against the fake substack.com (fake-substack.ts). Skipped when Xvfb, chromium or x11vnc cannot
 * be found. Every process it starts is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { ANN, BEN, CAL, ME } from '../extractors/substack/test/fixtures.ts';
import { type FakeSubstack, startFakeSubstack } from './fake-substack.ts';
import { browserBins } from './needs.ts';

const ROOT = join(import.meta.dir, '..');
const bins = browserBins('substack-browser');
const it = test.skipIf(!bins);

let fake: FakeSubstack;
let signedOut: FakeSubstack;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let acc = '';
const made: string[] = [];
const events: Record<string, any[]> = {};
/** The first Activity read soon after online, then every few seconds (on a real account: 30-60 s, then 4-8 minutes). */
const SOON = { feedFirstMs: 1000, feedEveryMs: 3000 };

const until = async <T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const evs = (a: string) => events[a] ?? [];
const statusOf = (a: string) => evs(a).filter((e) => e.t === 'status').at(-1);
const call = (op: string, input: any, account = acc) => app.call(chat, account, op as any, input) as Promise<any>;
/** The calls the fake recorded after `from`, as "METHOD path". */
const since = (from: number) => fake.calls.slice(from).map((c) => `${c.method} ${c.path}`);

function processesOf(ids: string[]): number[] {
  const needles = ids.map((id) => `DITHER_ACCOUNT_ID=${id}`);
  const found: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (needles.some((n) => env.includes(n))) found.push(Number(d));
    } catch {}
  }
  return found;
}
async function account(label: string, config: Record<string, unknown>): Promise<string> {
  const id = ((await app.admin({ do: 'create', kind: 'substack', label, config } as any)) as { id: string }).id;
  made.push(id);
  return id;
}

beforeAll(async () => {
  if (!bins) return;
  fake = startFakeSubstack();
  signedOut = startFakeSubstack({ signedIn: false });
  dir = mkdtempSync(join(tmpdir(), 'dacc-substack-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.set('substack', kindOf((await import(join(ROOT, 'extractors/substack/manifest.ts'))).default, join(ROOT, 'extractors/substack')));
  const reg = await register(m.url, { name: 'substack-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['substack'] }, { interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => (events[a] ??= []).push(...list) });
  await until(() => app.connected, 5000, 'the app connected');
}, 60_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  await m?.stop();
  const left = processesOf(made);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  signedOut?.stop();
  rmSync(dir, { recursive: true, force: true });
  expect(left).toEqual([]);
}, 30_000);

it(
  'signed in: online, every layer ok, who it is, and the hello offers the Feed page’s commands',
  async () => {
    acc = await account('Substack (test)', { testOrigin: fake.url, ...SOON });
    await until(() => statusOf(acc)?.status === 'online' && statusOf(acc)?.layers?.every((l: any) => l.state === 'ok'), 60_000, 'online with the activity read');
    const st = statusOf(acc);
    expect(st.attention).toBeNull();
    expect(st.layers.map((l: any) => l.name)).toEqual(['display', 'browser', 'extension', 'signed in', 'activity']);
    expect(st.layers.find((l: any) => l.name === 'signed in').note).toBe(`as @${ME.handle}`);
    expect(st.self).toMatchObject({ nativeId: String(ME.id), handle: ME.handle, isSelf: true });
    expect(evs(acc).find((e) => e.t === 'hello')).toMatchObject({ network: 'substack', capabilities: ['liveView', 'media', 'profile', 'posts', 'postActions', 'publish', 'unpublish', 'home'] });
  },
  90_000,
);

it(
  'the Activity list: one read-only feed conversation, a message per person, people first; nothing marked seen',
  async () => {
    const msg = (id: string) => evs(acc).find((e) => e.t === 'message' && e.message.nativeId === id);
    await until(() => msg('reply:c-7002') && msg(`follow:${ANN.id}`), 30_000, 'the activity messages');
    expect(evs(acc).find((e) => e.t === 'conversation')).toMatchObject({ conversation: { nativeId: 'feed', shape: 'channel', variant: 'feed' } });
    expect(msg('reply:c-7002')).toMatchObject({ message: { conversation: 'feed', author: String(ANN.id), kind: 'text', body: 'So true, and cheap too.', mentionsSelf: true, extra: { feed: { type: 'reply', post: { id: 'c-7001' } } } }, live: false });
    expect(msg(`like:p-9001:${BEN.id}`)).toMatchObject({ message: { kind: 'system', body: 'liked your post' } });
    expect(msg(`repost:c-7001:${CAL.id}`)).toMatchObject({ message: { body: 'restacked your note' } });
    // Each author's identity came before their first message.
    const order = evs(acc).map((e) => (e.t === 'identity' ? `id:${e.identity.nativeId}` : e.t === 'message' ? `m:${e.message.nativeId}` : ''));
    expect(order.indexOf(`id:${ANN.id}`)).toBeLessThan(order.indexOf('m:reply:c-7002'));
    expect(order.indexOf('id:substack')).toBeLessThan(order.findIndex((x) => x.startsWith('m:other:viral_post')));
    // The reader's own call, with the page's session; never the ones that mark seen.
    const read = fake.calls.find((c) => c.path === '/api/v1/activity-feed-web')!;
    expect(read).toMatchObject({ method: 'GET', query: { filter: 'all' } });
    expect(fake.calls.filter((c) => /seen|unread/.test(c.path) || c.method !== 'GET')).toEqual([]);
  },
  60_000,
);

it(
  'home: the Inbox (following) and Notes (for you), each a page with its cursor',
  async () => {
    const from = fake.calls.length;
    const inbox = await call('home', { feed: 'following' });
    expect(inbox.items.map((i: any) => i.post.id)).toEqual(['p-9002', 'p-9001']);
    expect(inbox.items[0].post).toMatchObject({ title: 'Tomatoes in November', warning: 'Paid subscribers only', place: { id: '5002', name: 'Garden Weekly', url: 'https://garden.example.com' }, author: String(ANN.id) });
    expect(inbox.more).toBe('inbox-2');
    const older = await call('home', { feed: 'following', cursor: inbox.more });
    expect(older.items.map((i: any) => i.post.id)).toEqual(['p-9003']);
    expect(older.more).toBeNull();
    const notes = await call('home', { feed: 'foryou' });
    expect(notes.items.map((i: any) => i.post.id)).toEqual(['c-7005', 'c-7001', 'p-9002']);
    expect(notes.items[1].reason).toEqual({ text: 'Ann Lee restacked', kind: 'other', who: String(ANN.id) });
    expect(notes.more).toBe('notes-2');
    expect(fake.calls.slice(from).map((c) => [c.path, c.query])).toEqual([
      ['/api/v1/reader/posts', { inboxType: 'inbox', limit: '20' }],
      ['/api/v1/reader/posts', { inboxType: 'inbox', limit: '20', cursor: 'inbox-2' }],
      ['/api/v1/reader/feed', { tab: 'for-you' }],
    ]);
    await expect(call('home', { feed: 'foryou', cursor: 'bad cursor!' })).rejects.toThrow('not a Substack cursor');
  },
  60_000,
);

it(
  "threads: a note's page and its replies as chains, more by cursor; a post's page and its comments",
  async () => {
    const one = await call('post', { post: 'c-7005' });
    expect(one.focal).toMatchObject({ id: 'c-7005', author: String(ANN.id), text: 'Look at these beans' });
    expect(one.ancestors).toEqual([]);
    expect(one.replies.map((c: any[]) => c.map((p) => p.id))).toEqual([['c-7007', 'c-7008']]);
    expect(one.more).toBe('replies-2');
    const p = await call('post', { post: 'p-9001' });
    expect(p.focal).toMatchObject({ id: 'p-9001', title: 'Why soil matters', place: { name: 'ACME Notes' } });
    // The whole post comes with its page, and only there: the hook keeps body_html on that call alone.
    expect(p.focal.article).toBe('The whole post, kept only on its page.');
    expect(p.replies.map((c: any[]) => c.map((x) => x.id))).toEqual([['c-7003', 'c-7004']]);
    expect(p.replies[0][0]).toMatchObject({ replyTo: { id: 'p-9001' }, url: 'https://acmenotes.substack.com/p/why-soil-matters/comment/7003' });
    const onPost = await call('post', { post: 'c-7004' });
    expect(onPost.ancestors.map((x: any) => x.id)).toEqual(['p-9001', 'c-7003']);
    await expect(call('post', { post: 'p-1' })).rejects.toThrow('Substack answered 404');
    await expect(call('post', { post: '9001' })).rejects.toThrow('not a Substack post id');
    expect(fake.calls.find((c) => c.path === '/api/v1/reader/post/9001/replies')!.query).toEqual({ publication_id: '5001' });
  },
  60_000,
);

it(
  'a profile: name, bio, follows and their own notes and posts',
  async () => {
    const about = await call('profile', { who: String(ANN.id) });
    expect(about).toMatchObject({ displayName: ANN.name, handle: ANN.handle, bio: ANN.bio, relationship: 'following', facts: [{ label: 'Writes', value: 'Garden Weekly' }, { label: 'Subscribers', value: '7' }] });
    expect(about.posts.map((x: any) => x.id)).toEqual(['p-9002', 'c-7005']);
  },
  60_000,
);

it(
  'answering: the heart and Restack on posts and notes, as the reader sends them',
  async () => {
    const from = fake.calls.length;
    expect(await call('postAct', { post: 'p-9002', act: 'like' })).toEqual({ liked: true });
    expect(await call('postAct', { post: 'p-9002', act: 'unlike' })).toEqual({ liked: false });
    expect(await call('postAct', { post: 'c-7005', act: 'like' })).toEqual({ liked: true });
    expect(await call('postAct', { post: 'c-7003', act: 'like' })).toEqual({ liked: true });
    expect(await call('postAct', { post: 'c-7005', act: 'repost' })).toEqual({ reposted: true });
    expect(await call('postAct', { post: 'p-9001', act: 'unrepost' })).toEqual({ reposted: false });
    const writes = fake.calls.slice(from).filter((c) => c.method !== 'GET');
    expect(writes).toEqual([
      { method: 'POST', path: '/api/v1/post/9002/reaction', query: {}, body: { reaction: '❤' } },
      { method: 'DELETE', path: '/api/v1/post/9002/reaction', query: {}, body: {} },
      { method: 'POST', path: '/api/v1/comment/7005/reaction', query: {}, body: { reaction: '❤', publication_id: null } },
      { method: 'POST', path: '/api/v1/comment/7003/reaction', query: {}, body: { reaction: '❤', publication_id: 5001 } },
      { method: 'POST', path: '/api/v1/restack/feed', query: {}, body: { postId: null, commentId: 7005, tabId: 'for-you', surface: 'feed' } },
      { method: 'DELETE', path: '/api/v1/restack/feed', query: {}, body: { postId: 9001, commentId: null, tabId: 'for-you' } },
    ]);
  },
  60_000,
);

it(
  'writing: a note, a reply to a note, a comment on a post and a reply under it; deleting your own',
  async () => {
    const from = fake.calls.length;
    const note = await call('publish', { text: 'First line\nSecond line' });
    expect(note.id).toMatch(/^c-\d+$/);
    expect(note).toMatchObject({ author: String(ME.id), text: 'First line\nSecond line' });
    const reply = await call('publish', { text: 'Lovely', replyTo: 'c-7005' });
    expect(reply.replyTo).toEqual({ id: 'c-7005' });
    const onPost = await call('publish', { text: 'Nice post', replyTo: 'p-9002' });
    expect(onPost).toMatchObject({ replyTo: { id: 'p-9002' }, place: { id: '5002' } });
    const under = await call('publish', { text: 'Agreed', replyTo: 'c-7003' });
    expect(under.replyTo).toEqual({ id: 'c-7003' });
    expect(await call('unpublish', { post: note.id })).toEqual({ deleted: true });
    expect(await call('unpublish', { post: note.id })).toEqual({ deleted: true });
    await expect(call('unpublish', { post: 'p-9001' })).rejects.toThrow('only a note or comment');
    await expect(call('publish', { text: 'x', quote: 'p-9001' })).rejects.toThrow('quoting');
    const doc = (...lines: string[]) => ({ type: 'doc', attrs: { schemaVersion: 'v1', title: null }, content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });
    const writes = fake.calls.slice(from).filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/api/v1/comment/feed', { bodyJson: doc('First line', 'Second line'), tabId: 'for-you', surface: 'feed', replyMinimumRole: 'everyone' }],
      ['POST', '/api/v1/comment/feed', { bodyJson: doc('Lovely'), parent_id: 7005, tabId: 'for-you', surface: 'feed' }],
      ['POST', '/api/v1/post/9002/comment', { bodyJson: doc('Nice post'), publication_id: 5002 }],
      ['POST', '/api/v1/post/9001/comment', { bodyJson: doc('Agreed'), parent_id: 7003, publication_id: 5001 }],
      ['DELETE', `/api/v1/comment/${note.id.slice(2)}`, {}],
      ['DELETE', `/api/v1/comment/${note.id.slice(2)}`, {}],
    ]);
  },
  90_000,
);

it(
  'a picture the reader shows comes through the page; one from elsewhere is refused',
  async () => {
    const got = await call('fetchMedia', { url: `${fake.url}/__fake/media/pixel.png` });
    expect(got.mime).toBe('image/png');
    expect(Buffer.from(got.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    await expect(call('fetchMedia', { url: 'https://evil.example/a.png' })).rejects.toThrow('not a Substack picture');
    // After all of it: still nothing marked seen.
    expect(fake.calls.filter((c) => /seen|unread/.test(c.path))).toEqual([]);
    expect(since(0).every((c) => !c.includes('/inbox/'))).toBe(true);
  },
  60_000,
);

it(
  'signed out: it asks to sign in in the live view, and goes online once you have',
  async () => {
    const out = await account('Substack (signed out)', { testOrigin: signedOut.url, ...SOON });
    await until(() => statusOf(out)?.status === 'attention', 60_000, 'the sign-in attention');
    expect(statusOf(out).attention).toMatchObject({ kind: 'login', message: 'Sign in to Substack in the live view', liveView: true });
    await expect(call('home', { feed: 'foryou' }, out)).rejects.toThrow('not signed in');
    signedOut.signIn();
    await until(() => statusOf(out)?.status === 'online', 30_000, 'online after signing in');
    expect(statusOf(out).self).toMatchObject({ nativeId: String(ME.id) });
  },
  120_000,
);

it(
  'its state file keeps no words or names',
  async () => {
    const f = join(dir, 'accounts', acc, 'substack-state.json');
    await until(() => existsSync(f), 10_000, 'the state file');
    const s = readFileSync(f, 'utf8');
    expect(s).not.toContain(ANN.name);
    expect(s).not.toContain('cheap');
  },
  30_000,
);
