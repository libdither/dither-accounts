/**
 * Network search (src/search.ts, the adapter's search): the /search body, the hub's offsets kept against next_batch
 * tokens, and the adapter against a fake homeserver: hits as message facts (a thread's first), the reply naming them,
 * and history's `oldest`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { MatrixAdapter } from '../src/adapter.ts';
import { searchBody, SearchPages } from '../src/search.ts';

const ME = '@me:x.test';
const ALICE = '@alice:x.test';
const BOB = '@bob:x.test';
const GROUP = '!group:x.test';
const DM = '!dm:x.test';
const SPACE = '!space:x.test';

let n = 0;
const state = (type: string, content: Record<string, any>, key = '', sender = ME) => ({ type, content, sender, event_id: `$s${++n}`, origin_server_ts: ++n, state_key: key });
const members = (...users: string[]) => users.map((u) => state('m.room.member', { membership: 'join' }, u, u));
const msg = (id: string, sender: string, ts: number, body = 'hi', extra: Record<string, any> = {}) => ({ type: 'm.room.message', event_id: id, sender, origin_server_ts: ts, content: { msgtype: 'm.text', body, ...extra } });

describe('the request', () => {
  test('words on content.body; rooms, people and the order as asked', () => {
    expect(searchBody({ text: ' borrow checker ', authors: [ALICE], sort: 'relevance' }, [GROUP], 100)).toEqual({
      search_categories: { room_events: { search_term: 'borrow checker', keys: ['content.body'], filter: { limit: 25, rooms: [GROUP], senders: [ALICE] }, order_by: 'rank' } },
    });
    expect(searchBody({ text: 'x', sort: 'oldest' }, null, 10)).toEqual({ search_categories: { room_events: { search_term: 'x', keys: ['content.body'], filter: { limit: 10 }, order_by: 'recent' } } });
  });

  test('offsets stand for next_batch tokens, one search at a time; the oldest are forgotten', () => {
    const pages = new SearchPages(2);
    expect(pages.token('a', 0)).toBeUndefined();
    expect(pages.keep('a', 0, 25, 'tok1')).toBe(25);
    expect(pages.token('a', 25)).toBe('tok1');
    expect(pages.token('b', 25)).toBeNull();
    expect(pages.keep('a', 25, 25, undefined)).toBeNull();
    expect(pages.keep('a', 25, 0, 'tok')).toBeNull();
    pages.keep('b', 0, 10, 'tokb');
    pages.keep('c', 0, 10, 'tokc');
    expect(pages.token('a', 25)).toBeNull();
    expect(pages.token('c', 10)).toBe('tokc');
  });
});

// ------------------------------------------------------------------ the adapter against a fake homeserver

function fakeHomeserver() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let syncRequests = 0;
  let batch = 0;
  const searches: { query: Record<string, string>; body: any }[] = [];
  const answers: unknown[] = [];
  const messagesAsked: Record<string, string>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = decodeURIComponent(url.pathname);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/account/whoami')) return json({ user_id: ME, device_id: 'TESTDEV' });
      if (p.includes('/profile/')) return json({});
      if (p.endsWith('/filter')) return json({ filter_id: '1' });
      if (p.endsWith('/sync')) {
        syncRequests++;
        if (!queue.length) await Promise.race([new Promise<void>((r) => (wake = r)), Bun.sleep(1000)]);
        wake = null;
        return json({ next_batch: `s${++batch}`, ...(queue.shift() as object) });
      }
      if (p.endsWith('/search')) {
        searches.push({ query: Object.fromEntries(url.searchParams), body: await req.json() });
        return json(answers.shift() ?? { search_categories: { room_events: { results: [], count: 0 } } });
      }
      if (p.endsWith(`/rooms/${GROUP}/messages`)) {
        messagesAsked.push(Object.fromEntries(url.searchParams));
        return json({ chunk: [msg('$old2', BOB, 50), msg('$old1', ALICE, 40)], end: 'p1' });
      }
      if (p.match(/\/presence\/.+\/status$/)) return json({ presence: 'offline' });
      if (p.endsWith('/joined_members')) return json({ joined: { [ME]: {}, [ALICE]: {}, [BOB]: {} } });
      if (p.endsWith('/threads')) return json({ chunk: [] });
      const event = p.match(/\/rooms\/([^/]+)\/event\/(.+)$/);
      if (event && event[2] === '$root') return json({ ...msg('$root', BOB, 500, 'a thread'), room_id: GROUP });
      return json({ errcode: 'M_UNRECOGNIZED', error: p }, 404);
    },
  });
  return {
    server,
    searches,
    answers,
    messagesAsked,
    get syncRequests() {
      return syncRequests;
    },
    sync(res: unknown) {
      queue.push(res);
      wake?.();
    },
  };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startAdapter() {
  const hs = fakeHomeserver();
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-search-'));
  const secretFile = join(dir, 'secret.json');
  writeFileSync(secretFile, JSON.stringify({ accessToken: 'token' }), { mode: 0o600 });
  const events: any[] = [];
  const hub = {
    accountId: 'acc',
    accountDir: dir,
    config: { homeserver: `http://127.0.0.1:${hs.server.port}` },
    label: '',
    emit: (e: any) => events.push(e),
    log: () => {},
    secret: () => JSON.parse(readFileSync(secretFile, 'utf8')),
    saveSecret: (v: unknown) => writeFileSync(secretFile, JSON.stringify(v), { mode: 0o600 }),
    connected: true,
    close: () => {},
  } as unknown as HubLink;
  const adapter = new MatrixAdapter();
  adapter.start(hub);
  cleanup.push(async () => {
    await adapter.shutdown();
    hs.server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => hs.syncRequests > 0, 'the first sync request');
  const asked = hs.syncRequests;
  hs.sync({
    rooms: {
      join: {
        [GROUP]: {
          state: { events: [state('m.room.create', { room_version: '10' }), ...members(ME, ALICE, BOB)] },
          timeline: { events: [msg('$g1', ALICE, 100)], prev_batch: 'p0', limited: true },
        },
        [DM]: { state: { events: [state('m.room.create', { room_version: '10' }), ...members(ME, ALICE)] }, timeline: { events: [] } },
        [SPACE]: {
          state: { events: [state('m.room.create', { room_version: '10', type: 'm.space' }), ...members(ME), state('m.room.power_levels', { users: { [ME]: 100 } }), state('m.space.child', { via: ['x.test'] }, GROUP)] },
          timeline: { events: [] },
        },
      },
    },
  });
  await until(() => hs.syncRequests > asked, 'the sync to be processed');
  const search = (c: Partial<Extract<P.AdapterCommand, { t: 'search' }>>) => adapter.command({ t: 'search', id: 'q', scope: { kind: 'all' }, query: { text: 'borrow' }, ...c } as P.AdapterCommand) as Promise<P.NetworkSearchResult>;
  return { adapter, hs, events, search };
}

const page = (results: unknown[], extra: Record<string, unknown> = {}) => ({ search_categories: { room_events: { results: results.map((result, i) => ({ rank: 1 / (i + 1), result })), ...extra } } });

describe('the adapter', () => {
  test("everything: hits as message facts (a thread's first), the reply naming them, the next page by its token", async () => {
    const { hs, events, search } = await startAdapter();
    hs.answers.push(
      page(
        [
          { ...msg('$h1', ALICE, 1000, 'the borrow checker'), room_id: GROUP },
          { ...msg('$h2', BOB, 900, 'borrow in a thread', { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } }), room_id: GROUP },
          { ...msg('$gone', BOB, 800, 'borrow somewhere left'), room_id: '!left:x.test' },
        ],
        { count: 40, next_batch: 'nb1' },
      ),
    );
    const from = events.length;
    const r = await search({ query: { text: 'borrow', authors: [ALICE, BOB] }, limit: 25 });
    expect(r).toEqual({ hits: ['$h1', '$h2'], total: 40, next: 3 });
    expect(hs.searches[0]).toEqual({
      query: {},
      body: { search_categories: { room_events: { search_term: 'borrow', keys: ['content.body'], filter: { limit: 25, senders: [ALICE, BOB] }, order_by: 'recent' } } },
    });
    const said = events.slice(from).filter((e) => e.t === 'message' || e.t === 'conversation');
    expect(said.find((e) => e.t === 'message' && e.message.nativeId === '$h1')).toMatchObject({ live: false, message: { conversation: GROUP, author: ALICE, body: 'the borrow checker' } });
    const thread = said.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === `${GROUP}|$root`);
    const hit = said.findIndex((e) => e.t === 'message' && e.message.nativeId === '$h2');
    expect(thread).toBeGreaterThanOrEqual(0);
    expect(hit).toBeGreaterThan(thread);
    expect(said[hit].message.conversation).toBe(`${GROUP}|$root`);

    // The next page is the server's token for this search; a page never given is refused.
    hs.answers.push(page([{ ...msg('$h3', ALICE, 700, 'borrow again'), room_id: GROUP }], { count: 40 }));
    expect(await search({ query: { text: 'borrow', authors: [ALICE, BOB] }, offset: 3 })).toEqual({ hits: ['$h3'], total: 40, next: null });
    expect(hs.searches[1].query).toEqual({ next_batch: 'nb1' });
    await expect(search({ query: { text: 'other' }, offset: 3 })).rejects.toThrow(/search again/);
  });

  test('a conversation, a space and in: name their rooms; dates are kept to; no words is refused', async () => {
    const { hs, search } = await startAdapter();
    await search({ scope: { kind: 'conversation', id: `${GROUP}|$root` } });
    await search({ scope: { kind: 'space', id: SPACE } });
    await search({ query: { text: 'borrow', in: [DM, `${GROUP}|$root`] } });
    expect(hs.searches.map((s) => s.body.search_categories.room_events.filter.rooms)).toEqual([[GROUP], [GROUP], [DM, GROUP]]);
    // A space whose rooms in: leaves none: nothing to ask.
    expect(await search({ scope: { kind: 'space', id: SPACE }, query: { text: 'borrow', in: [DM] } })).toEqual({ hits: [], total: 0, next: null });
    expect(hs.searches).toHaveLength(3);
    hs.answers.push(page([{ ...msg('$early', ALICE, 10, 'borrow'), room_id: GROUP }, { ...msg('$in', ALICE, 150, 'borrow'), room_id: GROUP }]));
    expect((await search({ query: { text: 'borrow', after: 100, before: 200 } })).hits).toEqual(['$in']);
    await expect(search({ query: { text: '  ' } })).rejects.toThrow(/words/);
  });

  test("history says its page's oldest message", async () => {
    const { adapter, hs } = await startAdapter();
    const r = await adapter.command({ t: 'history', id: 'h', conversation: GROUP, limit: 2 });
    expect(hs.messagesAsked[0]).toMatchObject({ from: 'p0', dir: 'b' });
    expect(r).toEqual({ count: 2, done: false, oldest: 40 });
  });
});
