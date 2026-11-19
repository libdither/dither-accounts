/**
 * extractors/reddit end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc) with
 * its extension, against the fake old.reddit.com (fake-reddit.ts). Skipped when Xvfb, chromium or x11vnc cannot be
 * found. Every process it starts is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { resolveBins } from '../packages/browser/src/index.ts';
import { ANN, BEN, CARA } from '../extractors/reddit/test/fixtures.ts';
import { type FakeReddit, ME, MODHASH, startFakeReddit } from './fake-reddit.ts';

const ROOT = join(import.meta.dir, '..');
let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`reddit-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeReddit;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let acc = '';
const made: string[] = [];
const events: Record<string, any[]> = {};

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
const helloOf = (a: string) => evs(a).filter((e) => e.t === 'hello').at(-1);
const call = (op: string, input: any, account = acc) => app.call(chat, account, op as any, input) as Promise<any>;
/** The fake's calls to one path, from the n-th call on. */
const callsTo = (path: string, from = 0) => fake.calls.slice(from).filter((c) => c.path === path);

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

beforeAll(async () => {
  if (!bins) return;
  fake = startFakeReddit();
  dir = mkdtempSync(join(tmpdir(), 'dacc-reddit-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.set('reddit', kindOf((await import(join(ROOT, 'extractors/reddit/manifest.ts'))).default, join(ROOT, 'extractors/reddit')));
  const reg = await register(m.url, { name: 'reddit-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['reddit'] }, { interface: 'chat', level: 'manage', accounts: '*' }] });
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
  rmSync(dir, { recursive: true, force: true });
  expect(left).toEqual([]);
}, 30_000);

it(
  'signed out: it asks you to sign in in the live view, offers only the live view, and reads nothing',
  async () => {
    const id = ((await app.admin({ do: 'create', kind: 'reddit', label: 'Reddit (test)', config: { testOrigin: fake.url, feedFirstMs: 500, feedEveryMs: 60_000, paceMs: 50 } } as any)) as { id: string }).id;
    made.push(id);
    acc = id;
    const st = await until(() => (statusOf(acc)?.attention?.kind === 'login' ? statusOf(acc) : null), 60_000, 'the sign-in attention');
    expect(st.status).toBe('attention');
    expect(st.attention).toMatchObject({ kind: 'login', message: 'Sign in to Reddit in the live view', liveView: true });
    expect(st.liveView).toMatchObject({ width: 1280, height: 800 });
    expect(helloOf(acc)).toMatchObject({ network: 'reddit', capabilities: ['liveView'] });
    expect(fake.calls.filter((c) => c.path.endsWith('.json') || c.path.startsWith('/api/'))).toEqual([]);
  },
  90_000,
);

it(
  'signed in (in the live view): online as you, every capability, and the inbox as the feed, never marked read',
  async () => {
    fake.signIn();
    await until(() => statusOf(acc)?.status === 'online', 60_000, 'online');
    const st = statusOf(acc);
    expect(st.self).toMatchObject({ nativeId: ME, handle: ME, isSelf: true });
    expect(st.layers.find((l: any) => l.name === 'signed in').note).toBe(`as u/${ME}`);
    expect(st.layers.find((l: any) => l.name === 'page')).toMatchObject({ state: 'ok', note: 'old.reddit.com, reads and writes' });
    expect(helloOf(acc).capabilities).toEqual(['liveView', 'home', 'posts', 'profile', 'postActions', 'publish', 'unpublish']);

    const msg = (nid: string) => evs(acc).find((e) => e.t === 'message' && e.message.nativeId === nid);
    await until(() => msg('reply:t1_r1'), 30_000, 'the inbox read');
    expect(evs(acc).find((e) => e.t === 'conversation')?.conversation).toEqual({ nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications' });
    expect(msg('reply:t1_r1').message).toMatchObject({ conversation: 'feed', author: ANN, kind: 'text', mentionsSelf: true, extra: { feed: { type: 'reply', post: { id: 't3_g1', title: 'Tomatoes, finally' } } } });
    expect(msg('mention:t1_r3').message.extra.feed.type).toBe('mention');
    await until(() => msg('other:t4_m2:-'), 5000, 'the last message');
    expect(msg(`other:t4_m1:${CARA}`).message).toMatchObject({ kind: 'system', body: 'seeds?' });
    // A fresh account's first read is backfill: nothing notifies.
    expect(evs(acc).filter((e) => e.t === 'message').every((e) => e.live === false)).toBe(true);
    expect(evs(acc).find((e) => e.t === 'identity' && e.identity.nativeId === ANN)?.identity).toEqual({ nativeId: ANN, handle: ANN, displayName: `u/${ANN}` });
    const reads = callsTo('/message/inbox.json');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.query).toMatchObject({ mark: 'false', raw_json: '1' });
    // Reading the inbox wrote nothing.
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
  },
  90_000,
);

it(
  'home: Following is the front page sorted New, For you is Best, with Reddit after as the cursor',
  async () => {
    const from = fake.calls.length;
    const following = await call('home', { feed: 'following' });
    expect(following.items.map((i: any) => i.post.id)).toEqual(['t3_n1', 't3_n2']);
    expect(following.items[1].post.text).toBe('https://example.com/b');
    expect(following.more).toBe('t3_n2');
    const older = await call('home', { feed: 'following', cursor: following.more, count: 10 });
    expect(older.items[0].post.id).toBe('t3_n3');
    const foryou = await call('home', { feed: 'foryou' });
    expect(foryou.items[0].post).toMatchObject({ id: 't3_b1', title: 'Best one', counts: { likes: 900 }, media: [{ kind: 'image', url: `${fake.url}/pic.jpg` }] });
    expect(callsTo('/new.json', from).map((c) => c.query)).toEqual([
      { raw_json: '1', limit: '25' },
      { raw_json: '1', limit: '10', after: 't3_n2' },
    ]);
    expect(callsTo('/best.json', from)).toHaveLength(1);
    await expect(call('home', { feed: 'following', cursor: 'not a cursor' })).rejects.toThrow('not a Reddit cursor');
  },
  60_000,
);

it(
  'threads: a post with its comment tree, more comments through the cursor, a comment with what is above it',
  async () => {
    const from = fake.calls.length;
    const t = await call('post', { post: 't3_g1' });
    expect(t.focal).toMatchObject({ id: 't3_g1', title: 'Tomatoes, finally' });
    expect(t.replies.map((ch: any[]) => ch.map((p) => p.id))).toEqual([['t1_c1', 't1_c2', 't1_c3'], ['t1_c4'], ['t1_c5']]);
    expect(t.more).toBe('g1.c6.0');
    const more = await call('post', { post: 't3_g1', cursor: t.more });
    expect(more.replies.map((ch: any[]) => ch.map((p) => p.id))).toEqual([['t1_c6'], ['t1_c7', 't1_c8']]);
    expect(more.more).toBeNull();
    const mc = callsTo('/api/morechildren', from);
    expect(mc).toHaveLength(1);
    expect(mc[0]!.form).toEqual({ api_type: 'json', link_id: 't3_g1', children: 'c6,c7,c8', sort: 'confidence', limit_children: 'false', uh: MODHASH });
    // A comment seen in the thread: its page straight away, no lookup.
    const c = await call('post', { post: 't1_c2' });
    expect(c.ancestors.map((p: any) => p.id)).toEqual(['t3_g1', 't1_c1']);
    expect(c.focal.id).toBe('t1_c2');
    expect(callsTo('/api/info.json', from)).toEqual([]);
    expect(callsTo('/comments/g1/_/c2.json', from)[0]!.query).toMatchObject({ context: '8', raw_json: '1' });
    expect(evs(acc).some((e) => e.t === 'identity' && e.identity.nativeId === BEN)).toBe(true);
  },
  60_000,
);

it(
  "voting, commenting, posting and deleting: each the page's own call, once, with its modhash",
  async () => {
    const from = fake.calls.length;
    expect(await call('postAct', { post: 't3_g1', act: 'like' })).toEqual({ liked: true });
    expect(await call('postAct', { post: 't1_c3', act: 'unlike' })).toEqual({ liked: false });
    await expect(call('postAct', { post: 't3_g1', act: 'repost' })).rejects.toThrow('Reddit has no reposts');
    expect(callsTo('/api/vote', from).map((c) => c.form)).toEqual([
      { id: 't3_g1', dir: '1', uh: MODHASH },
      { id: 't1_c3', dir: '0', uh: MODHASH },
    ]);

    const reply = await call('publish', { text: 'Thanks, *Ann*', replyTo: 't1_c1' });
    expect(reply).toMatchObject({ author: ME, text: 'Thanks, *Ann*', replyTo: { id: 't1_c1' }, root: 't3_g1' });
    expect(callsTo('/api/comment', from).map((c) => c.form)).toEqual([{ api_type: 'json', thing_id: 't1_c1', text: 'Thanks, *Ann*', uh: MODHASH }]);

    await expect(call('publish', { text: 'no title' })).rejects.toThrow('a new Reddit post needs a title');
    await expect(call('publish', { text: 'no place', title: 'A title' })).rejects.toThrow('needs a subreddit');
    const p = await call('publish', { text: 'Tall ones.', title: 'My beans', place: 'r/gardening' });
    expect(p).toMatchObject({ author: ME, title: 'My beans', text: 'Tall ones.', place: { name: 'r/gardening' } });
    expect(callsTo('/api/submit', from).map((c) => c.form)).toEqual([{ api_type: 'json', kind: 'self', sr: 'gardening', title: 'My beans', text: 'Tall ones.', sendreplies: 'true', uh: MODHASH }]);

    expect(await call('unpublish', { post: reply.id })).toEqual({ deleted: true });
    expect(callsTo('/api/del', from).map((c) => c.form)).toEqual([{ id: reply.id, uh: MODHASH }]);
    // Nothing else was written.
    expect(fake.calls.slice(from).filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/vote', '/api/vote', '/api/comment', '/api/submit', '/api/del']);
  },
  60_000,
);

it(
  'profile: karma, cake day and their recent posts and comments',
  async () => {
    const about = await call('profile', { who: ANN });
    expect(about).toMatchObject({ displayName: 'Ann Lee', handle: ANN, bio: 'Gardens, mostly.' });
    expect(about.facts.map((f: any) => f.label)).toEqual(['Karma', 'Post karma', 'Comment karma', 'Cake day']);
    expect(about.posts.map((p: any) => p.id)).toEqual(['t1_o1', 't3_o2']);
    await expect(call('profile', { who: 'not a name' })).rejects.toThrow('not a Reddit username');
    // The state file keeps ids and times only.
    const kept = join(dir, 'accounts', acc, 'reddit-state.json');
    await until(() => existsSync(kept), 10_000, 'the state file');
    expect(Object.keys(JSON.parse(readFileSync(kept, 'utf8')).feed).sort()).toEqual(['ids', 'newestMs']);
  },
  60_000,
);
