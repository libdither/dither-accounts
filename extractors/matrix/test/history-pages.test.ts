/**
 * History pages against a fake homeserver with one room's whole timeline: a page before a time starts at the last
 * event before it (timestamp_to_event, then /context), a cursor goes on from the page before, a page of thread replies
 * and reactions counts none of them for the room but still moves `oldest` back, and `done` is the server's own end.
 * A thread pages the same way by its relations. The server hands out at most five events a page, as servers cap them.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { MatrixAdapter } from '../src/adapter.ts';
import type { MxEvent } from '../src/rooms.ts';

const ME = '@me:x.test';
const ALICE = '@alice:x.test';
const BOB = '@bob:x.test';
const GROUP = '!group:x.test';
const THREAD = `${GROUP}|$m10`;
const CAP = 5;

const state = (type: string, content: Record<string, any>, key: string, id: string, ts: number): MxEvent => ({ type, content, sender: ME, event_id: id, origin_server_ts: ts, state_key: key });
const msg = (i: number): MxEvent => ({ type: 'm.room.message', event_id: `$m${i}`, sender: i % 2 ? ALICE : BOB, origin_server_ts: i * 100, content: { msgtype: 'm.text', body: `message ${i}` } });
const reply = (j: number): MxEvent => ({
  type: 'm.room.message',
  event_id: `$t${j}`,
  sender: BOB,
  origin_server_ts: 1020 + j,
  content: { msgtype: 'm.text', body: `reply ${j}`, 'm.relates_to': { rel_type: 'm.thread', event_id: '$m10' } },
});

/**
 * Oldest first: the room's start, m1..m10 (ts 100..1000), a reaction on m10 (1010), 40 replies in m10's thread
 * (1021..1060), then m11..m20 (1100..2000).
 */
const STATE = [state('m.room.create', { room_version: '10' }, '', '$create', 1), state('m.room.member', { membership: 'join' }, ME, '$jme', 2), state('m.room.member', { membership: 'join' }, ALICE, '$jalice', 3), state('m.room.member', { membership: 'join' }, BOB, '$jbob', 4)];
const REPLIES = Array.from({ length: 40 }, (_, j) => reply(j + 1));
const TIMELINE: MxEvent[] = [
  ...STATE,
  ...Array.from({ length: 10 }, (_, i) => msg(i + 1)),
  { type: 'm.reaction', event_id: '$r1', sender: ALICE, origin_server_ts: 1010, content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m10', key: '👍' } } },
  ...REPLIES,
  ...Array.from({ length: 10 }, (_, i) => msg(i + 11)),
];

/** `<prefix><k>` stands for "before the k-th event"; any other token (sync's) for the newest end. */
function pageOf(events: MxEvent[], prefix: string, from: string | null, limit: number) {
  const k = from?.startsWith(prefix) ? Number(from.slice(prefix.length)) : events.length;
  const lo = Math.max(0, k - Math.min(limit, CAP));
  return { chunk: events.slice(lo, k).reverse(), lo };
}

function fakeHomeserver() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let syncRequests = 0;
  let batch = 0;
  const asked: { path: string; query: Record<string, string> }[] = [];
  const hs = {
    asked,
    /** Answer timestamp_to_event as a server without it does. */
    noJump: false,
    get syncRequests() {
      return syncRequests;
    },
    sync(res: unknown) {
      queue.push(res);
      wake?.();
    },
    server: Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const p = decodeURIComponent(url.pathname);
        const q = Object.fromEntries(url.searchParams);
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
        if (p.match(/\/presence\/.+\/status$/)) return json({ presence: 'offline' });
        if (p.endsWith('/joined_members')) return json({ joined: { [ME]: {}, [ALICE]: {}, [BOB]: {} } });
        if (p.endsWith('/threads')) return json({ chunk: [] });
        if (!p.startsWith(`/_matrix/client/`) || !p.includes(`/rooms/${GROUP}/`)) return json({ errcode: 'M_UNRECOGNIZED', error: p }, 404);
        asked.push({ path: p.slice(p.indexOf(`/rooms/${GROUP}/`) + `/rooms/${GROUP}/`.length), query: q });
        if (p.endsWith('/timestamp_to_event')) {
          if (hs.noJump) return json({ errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }, 404);
          if (q.dir !== 'b') return json({ errcode: 'M_INVALID_PARAM', error: 'dir' }, 400);
          const at = TIMELINE.findLast((e) => e.origin_server_ts <= Number(q.ts));
          return at ? json({ event_id: at.event_id, origin_server_ts: at.origin_server_ts }) : json({ errcode: 'M_NOT_FOUND', error: 'none' }, 404);
        }
        const context = p.match(/\/context\/(.+)$/);
        if (context) {
          const i = TIMELINE.findIndex((e) => e.event_id === context[1]);
          if (i < 0) return json({ errcode: 'M_NOT_FOUND', error: 'no event' }, 404);
          return json({ event: TIMELINE[i], events_before: [], events_after: [], start: `t${i}`, end: `t${i + 1}`, state: [] });
        }
        const event = p.match(/\/event\/(.+)$/);
        if (event) {
          const e = TIMELINE.find((x) => x.event_id === event[1]);
          return e ? json(e) : json({ errcode: 'M_NOT_FOUND', error: 'no event' }, 404);
        }
        if (p.endsWith('/messages')) {
          if (q.dir !== 'b') return json({ errcode: 'M_INVALID_PARAM', error: 'dir' }, 400);
          const { chunk, lo } = pageOf(TIMELINE, 't', q.from ?? null, Number(q.limit) || 10);
          return json({ chunk, start: q.from ?? 'now', ...(lo > 0 ? { end: `t${lo}` } : {}) });
        }
        if (p.endsWith('/relations/$m10/m.thread')) {
          const { chunk, lo } = pageOf(REPLIES, 'r', q.from ?? null, Number(q.limit) || 10);
          return json({ chunk, ...(lo > 0 ? { next_batch: `r${lo}` } : {}) });
        }
        return json({ errcode: 'M_UNRECOGNIZED', error: p }, 404);
      },
    }),
  };
  return hs;
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

/** An adapter that has synced the room: its state, no timeline, and a prev_batch at the newest end. */
async function startAdapter() {
  const hs = fakeHomeserver();
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-pages-'));
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
  const before = hs.syncRequests;
  hs.sync({ rooms: { join: { [GROUP]: { state: { events: STATE }, timeline: { events: [], prev_batch: `t${TIMELINE.length}`, limited: true } } } } });
  await until(() => hs.syncRequests > before, 'the sync to be processed');
  /** One history page: its reply, the requests it made and the message facts it sent (`ids`: a conversation's, newest first). */
  const page = async (c: Partial<Extract<P.AdapterCommand, { t: 'history' }>>) => {
    const [from, fromAsked] = [events.length, hs.asked.length];
    const result = (await adapter.command({ t: 'history', id: 'h', conversation: GROUP, limit: 3, ...c } as P.AdapterCommand)) as P.HistoryResult;
    const sent = events.slice(from).filter((e) => e.t === 'message').map((e) => e.message as P.MessageFact);
    return { result, asked: hs.asked.slice(fromAsked), sent, ids: (conv: string) => sent.filter((m) => m.conversation === conv).sort((a, b) => b.ts - a.ts).map((m) => m.nativeId) };
  };
  return { hs, page };
}

describe('room history', () => {
  test('a page before a time starts at the last event before it and says where it stopped', async () => {
    const { page } = await startAdapter();
    const { result, asked, ids, sent } = await page({ beforeTs: 1550 });
    expect(asked[0]).toEqual({ path: 'timestamp_to_event', query: { ts: '1549', dir: 'b' } });
    expect(asked[1]).toMatchObject({ path: 'context/$m15', query: { limit: '0' } });
    expect(asked[2]).toMatchObject({ path: 'messages', query: { from: `t${TIMELINE.findIndex((e) => e.event_id === '$m15')}`, dir: 'b' } });
    expect(ids(GROUP).filter((id) => id !== '$m10')).toEqual(['$m15', '$m14', '$m13', '$m12', '$m11']);
    // Nothing from at or after the time asked; the newest thread reply came with the page, in its thread.
    expect(sent.every((m) => m.ts < 1550)).toBe(true);
    expect(ids(THREAD)).toEqual(['$t40']);
    expect(result).toEqual({ count: 5, done: false, oldest: 1060, next: `t${TIMELINE.findIndex((e) => e.event_id === '$t40')}` });
  });

  test('a cursor goes on from the page before; a page of only thread replies counts none but moves oldest back', async () => {
    const { page } = await startAdapter();
    const first = await page({ beforeTs: 1550 });
    const second = await page({ beforeTs: first.result.oldest, cursor: first.result.next });
    expect(second.asked.map((a) => a.path).filter((p) => p !== 'event/$m10')).toEqual(Array(6).fill('messages'));
    expect(second.asked[0].query).toMatchObject({ from: first.result.next, dir: 'b' });
    expect(second.ids(THREAD)).toEqual(REPLIES.slice(9, 39).reverse().map((e) => e.event_id));
    expect(second.ids(GROUP).filter((id) => id !== '$m10')).toEqual([]);
    expect(second.result).toEqual({ count: 0, done: false, oldest: 1030, next: `t${TIMELINE.findIndex((e) => e.event_id === '$t10')}` });

    // On past the rest of the thread and the reaction to the room's own messages again.
    const third = await page({ beforeTs: second.result.oldest, cursor: second.result.next });
    expect(third.ids(GROUP)).toEqual(['$m10', '$m9', '$m8', '$m7', '$m6']);
    expect(third.result).toMatchObject({ count: 5, done: false, oldest: 600 });
  });

  test('done at the start of the room, and before it', async () => {
    const { page } = await startAdapter();
    const { result, ids } = await page({ beforeTs: 350, limit: 10 });
    expect(ids(GROUP)).toEqual(['$m3', '$m2', '$m1']);
    expect(result).toEqual({ count: 3, done: true, oldest: 1 });
    expect((await page({ beforeTs: 1 })).result).toEqual({ count: 0, done: true });
  });

  test('a server that cannot jump to a time: back from now, skipping what is newer', async () => {
    const { hs, page } = await startAdapter();
    hs.noJump = true;
    const { result, asked, sent, ids } = await page({ beforeTs: 1550 });
    expect(asked.map((a) => a.path)).toEqual(['timestamp_to_event', 'messages', 'messages']);
    expect(asked[1].query.from).toMatch(/^s\d+$/);
    expect(sent.every((m) => m.ts < 1550)).toBe(true);
    expect(ids(GROUP)).toEqual(['$m15', '$m14', '$m13', '$m12', '$m11']);
    expect(result).toEqual({ count: 5, done: false, oldest: 1100, next: `t${TIMELINE.findIndex((e) => e.event_id === '$m11')}` });
  });
});

describe('thread history', () => {
  test('before a time and on by its cursor, to the start of the thread', async () => {
    const { page } = await startAdapter();
    const first = await page({ conversation: THREAD, beforeTs: 1031, limit: 5 });
    expect(first.asked.filter((a) => a.path.startsWith('relations')).map((a) => (a.query.from ?? null) as string | null)).toEqual([null, 'r35', 'r30', 'r25', 'r20', 'r15', 'r10']);
    expect(first.ids(THREAD)).toEqual(['$t10', '$t9', '$t8', '$t7', '$t6']);
    expect(first.result).toEqual({ count: 5, done: false, oldest: 1026, next: 'r5' });
    const second = await page({ conversation: THREAD, beforeTs: first.result.oldest, cursor: first.result.next, limit: 5 });
    expect(second.ids(THREAD)).toEqual(['$t5', '$t4', '$t3', '$t2', '$t1']);
    expect(second.result).toEqual({ count: 5, done: true, oldest: 1021 });
  });
});
