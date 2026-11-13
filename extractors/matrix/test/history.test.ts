/**
 * Pins, roles, receipts and status messages (src/history.ts): the diffs on their own, then the adapter against a fake
 * homeserver that hands out one sync at a time.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { MatrixAdapter, syncFilter } from '../src/adapter.ts';
import { pinChanges, presenceOf, receiptEvents, roleChanges, statusOf } from '../src/history.ts';
import type { MxEvent } from '../src/rooms.ts';

const ME = '@me:x.test';
const ALICE = '@alice:x.test';
const BOB = '@bob:x.test';
const CAROL = '@carol:x.test';
const GROUP = '!group:x.test';
const DM = '!dm:x.test';
const DM2 = '!dm2:x.test';
const PUBLIC = '!public:x.test';
const NEW = '!new:x.test';
const SPACE = '!space:x.test';

let n = 0;
const ev = (type: string, content: Record<string, any>, sender = ME, stateKey: string | undefined = '', ts = ++n): MxEvent => ({
  type,
  content,
  sender,
  event_id: `$e${++n}`,
  origin_server_ts: ts,
  ...(stateKey !== undefined ? { state_key: stateKey } : {}),
});
const msg = (id: string, sender: string, ts: number) => ({ type: 'm.room.message', event_id: id, sender, origin_server_ts: ts, content: { msgtype: 'm.text', body: 'hi' } });

describe('the diffs', () => {
  test('pins: one event per message added or taken off, by whoever changed the list', () => {
    const before = ev('m.room.pinned_events', { pinned: ['$a', '$b'] });
    const after = ev('m.room.pinned_events', { pinned: ['$b', '$c', 7] }, ALICE, '', 500);
    expect(pinChanges(before, after, (m) => (m === '$c' ? `${GROUP}|$root` : GROUP))).toEqual([
      { t: 'pin', conversation: `${GROUP}|$root`, message: '$c', pinned: true, by: ALICE, ts: 500 },
      { t: 'pin', conversation: GROUP, message: '$a', pinned: false, by: ALICE, ts: 500 },
    ]);
    expect(pinChanges(before, ev('m.room.pinned_events', { pinned: ['$b', '$a'] }), () => GROUP)).toEqual([]);
    expect(pinChanges(before, ev('m.room.pinned_events', {}), () => GROUP).map((e: any) => [e.message, e.pinned])).toEqual([
      ['$a', false],
      ['$b', false],
    ]);
  });

  test('roles: crossing between named levels takes the old one and gives the new; the default is no role', () => {
    const target: P.AboutTarget = { kind: 'conversation', nativeId: GROUP };
    const before = ev('m.room.power_levels', { users: { [ME]: 100, [ALICE]: 50, [BOB]: 50, [CAROL]: 20 }, users_default: 0 });
    const after = ev('m.room.power_levels', { users: { [ME]: 100, [ALICE]: 100, [CAROL]: 25, '@dave:x.test': 50, '@erin:x.test': 0 }, users_default: 0 }, ME, '', 900);
    const by = { by: ME, ts: 900 };
    expect(roleChanges(target, before, after)).toEqual([
      { t: 'role', target, member: ALICE, role: 'Moderator', given: false, ...by },
      { t: 'role', target, member: ALICE, role: 'Admin', given: true, ...by },
      { t: 'role', target, member: BOB, role: 'Moderator', given: false, ...by },
      { t: 'role', target, member: CAROL, role: 'Level 20', given: false, ...by },
      { t: 'role', target, member: CAROL, role: 'Level 25', given: true, ...by },
      { t: 'role', target, member: '@dave:x.test', role: 'Moderator', given: true, ...by },
    ]);
  });

  test('roles: a new default moves no one by itself, and skipped members (v12 creators) say nothing', () => {
    const target: P.AboutTarget = { kind: 'space', nativeId: SPACE };
    const before = ev('m.room.power_levels', { users: { [ME]: 100, [ALICE]: 10 }, users_default: 0 });
    // Alice's 10 is now the default: a member like anyone else, so her Level 10 is gone.
    expect(roleChanges(target, before, ev('m.room.power_levels', { users: { [ME]: 100, [ALICE]: 10 }, users_default: 10 }))).toMatchObject([{ member: ALICE, role: 'Level 10', given: false }]);
    expect(roleChanges(target, before, ev('m.room.power_levels', { users: { [ALICE]: 10 }, users_default: 0 }), (u) => u === ME)).toEqual([]);
    expect(roleChanges(target, before, ev('m.room.power_levels', { users: 'junk' }))).toMatchObject([{ member: ME, role: 'Admin', given: false }, { member: ALICE, role: 'Level 10', given: false }]);
  });

  test('receipts: other people’s public read receipts only, in the conversation the event or thread is in', () => {
    const content = {
      $m1: { 'm.read': { [ALICE]: { ts: 10 }, [ME]: { ts: 11 } }, 'm.read.private': { [BOB]: { ts: 12 } } },
      $t1: { 'm.read': { [BOB]: { ts: 13, thread_id: '$root' }, [CAROL]: { thread_id: 'main' } } },
      $junk: { 'm.read': 'no' },
    };
    const seen: [string, string | undefined][] = [];
    const out = receiptEvents(content, ME, (m, thread) => {
      seen.push([m, thread]);
      return thread ? `${GROUP}|${thread}` : GROUP;
    });
    expect(out.slice(0, 2)).toEqual([
      { t: 'receipt', conversation: GROUP, messages: ['$m1'], who: ALICE, state: 'read', ts: 10 },
      { t: 'receipt', conversation: `${GROUP}|$root`, messages: ['$t1'], who: BOB, state: 'read', ts: 13 },
    ]);
    expect(out[2]).toMatchObject({ conversation: GROUP, messages: ['$t1'], who: CAROL });
    expect(typeof (out[2] as any).ts).toBe('number');
    expect(out.length).toBe(3);
    expect(seen).toEqual([
      ['$m1', undefined],
      ['$t1', '$root'],
      ['$t1', undefined],
    ]);
    expect(receiptEvents(null, ME, () => GROUP)).toEqual([]);
  });

  test('presence: unavailable is idle, busy is do not disturb, anything else is nothing', () => {
    expect([{ presence: 'online' }, { presence: 'unavailable' }, { presence: 'offline' }, { presence: 'org.matrix.msc3026.busy' }, { presence: 'away' }, null].map(presenceOf)).toEqual(['online', 'idle', 'offline', 'dnd', null, null]);
  });

  test('status messages: a missing or blank one is none', () => {
    expect(statusOf({ presence: 'online', status_msg: 'On a train' })).toBe('On a train');
    expect(statusOf({ presence: 'online' })).toBe('');
    expect(statusOf({ status_msg: '  ' })).toBe('');
    expect(statusOf(null)).toBe('');
  });

  test('the filter lets presence through from the people named, and from no one when there are none', () => {
    expect(syncFilter([]).presence).toEqual({ not_types: ['*'] });
    expect(syncFilter([ALICE, BOB]).presence).toEqual({ types: ['m.presence'], senders: [ALICE, BOB] });
  });
});

// ------------------------------------------------------------------ the adapter against a fake homeserver

function fakeHomeserver() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const filters: any[] = [];
  const presenceAsked: string[] = [];
  const presence: Record<string, unknown> = {};
  const writes: { path: string; body: any }[] = [];
  let syncRequests = 0;
  let batch = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/account/whoami')) return json({ user_id: ME, device_id: 'TESTDEV' });
      if (p.includes('/profile/')) return json({});
      if (p.endsWith('/filter')) {
        filters.push(await req.json());
        return json({ filter_id: String(filters.length) });
      }
      if (p.endsWith('/sync')) {
        syncRequests++;
        if (!queue.length) await Promise.race([new Promise<void>((r) => (wake = r)), Bun.sleep(1000)]);
        wake = null;
        return json({ next_batch: `s${++batch}`, ...(queue.shift() as object) });
      }
      const status = p.match(/\/presence\/(.+)\/status$/);
      if (status) {
        presenceAsked.push(status[1]);
        return json(presence[status[1]] ?? { presence: 'offline' });
      }
      if (p.endsWith('/joined_members')) return json({ joined: { [ME]: {}, [ALICE]: {}, [BOB]: {} } });
      if (p.endsWith('/threads')) return json({ chunk: [] });
      if (p.includes('/state/')) {
        writes.push({ path: p, body: await req.json() });
        return json({ event_id: `$written${writes.length}` });
      }
      return json({ errcode: 'M_UNRECOGNIZED', error: p }, 404);
    },
  });
  return {
    server,
    filters,
    presence,
    presenceAsked,
    writes,
    get syncRequests() {
      return syncRequests;
    },
    /** Hand out one sync response. */
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
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-history-'));
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
  /** Hand out a sync and wait for the adapter to have read it (it asks for the next one). */
  const step = async (res: unknown) => {
    await until(() => hs.syncRequests > 0, 'the first sync request');
    const asked = hs.syncRequests;
    hs.sync(res);
    await until(() => hs.syncRequests > asked, 'the sync to be processed');
  };
  const news = () => events.filter((e) => ['pin', 'role', 'receipt', 'customStatus'].includes(e.t));
  return { adapter, hs, events, step, news };
}

const state = (type: string, content: Record<string, any>, key = '', sender = ME) => ev(type, content, sender, key);
const members = (...users: string[]) => users.map((u) => state('m.room.member', { membership: 'join' }, u, u));
const receipt = (eventId: string, who: string, ts: number, extra: Record<string, unknown> = {}) => ({ type: 'm.receipt', content: { [eventId]: { 'm.read': { [who]: { ts, ...extra } } } } });

/** Where the account starts: a group with pins and moderators, a DM with Alice, a public room and a space. */
const initialSync = () => ({
  account_data: { events: [{ type: 'm.direct', content: { [ALICE]: [DM] } }] },
  rooms: {
    join: {
      [GROUP]: {
        state: {
          events: [
            state('m.room.create', { room_version: '10' }),
            ...members(ME, ALICE, BOB),
            state('m.room.power_levels', { users: { [ME]: 100, [BOB]: 50 } }),
            state('m.room.pinned_events', { pinned: ['$g1'] }),
          ],
        },
        timeline: { events: [msg('$g1', ALICE, 100), msg('$g2', BOB, 200)] },
        ephemeral: { events: [{ type: 'm.receipt', content: { $g2: { 'm.read': { [ALICE]: { ts: 1000 }, [ME]: { ts: 900 } }, 'm.read.private': { [BOB]: { ts: 950 } } } } }] },
      },
      [DM]: {
        state: { events: [state('m.room.create', { room_version: '10' }), ...members(ME, ALICE)] },
        timeline: { events: [msg('$d1', ALICE, 300)] },
        ephemeral: { events: [receipt('$d1', ALICE, 1100)] },
      },
      [PUBLIC]: {
        state: { events: [state('m.room.create', { room_version: '10' }), state('m.room.join_rules', { join_rule: 'public' }), ...members(ME, CAROL)] },
        timeline: { events: [msg('$p1', CAROL, 400)] },
        ephemeral: { events: [receipt('$p1', CAROL, 1200)] },
      },
      [SPACE]: {
        state: { events: [state('m.room.create', { room_version: '10', type: 'm.space' }), ...members(ME), state('m.room.power_levels', { users: { [ME]: 100 } })] },
        timeline: { events: [] },
      },
    },
  },
});

describe('the adapter', () => {
  test('a first sync is how things are: no pins or roles, receipts only where few read, statuses asked for once', async () => {
    const { hs, step, news } = await startAdapter();
    hs.presence[ALICE] = { presence: 'online', status_msg: 'On a train' };
    await step(initialSync());
    await until(() => news().some((e) => e.t === 'customStatus'), 'Alice’s status');
    expect(news()).toEqual([
      { t: 'receipt', conversation: GROUP, messages: ['$g2'], who: ALICE, state: 'read', ts: 1000 },
      { t: 'receipt', conversation: DM, messages: ['$d1'], who: ALICE, state: 'read', ts: 1100 },
      { t: 'customStatus', who: ALICE, text: 'On a train' },
    ]);
    // The filter before m.direct was known let no presence through; the one after, Alice's.
    expect(hs.filters.map((f) => f.presence)).toEqual([{ not_types: ['*'] }, { types: ['m.presence'], senders: [ALICE] }]);
    expect(hs.presenceAsked).toEqual([ALICE]);
  });

  test('later syncs: pins, roles (rooms and spaces), receipts everywhere, status changes only; nothing from a room just joined', async () => {
    const { hs, step, news, events } = await startAdapter();
    hs.presence[ALICE] = { presence: 'online', status_msg: 'On a train' };
    await step(initialSync());
    await until(() => news().some((e) => e.t === 'customStatus'), 'Alice’s status');
    const from = events.length;
    const later = () => events.slice(from).filter((e) => ['pin', 'role', 'receipt', 'customStatus'].includes(e.t));

    await step({
      presence: {
        events: [
          { type: 'm.presence', sender: ALICE, content: { presence: 'offline', status_msg: 'On a train' } }, // only a flip
          { type: 'm.presence', sender: CAROL, content: { presence: 'online', status_msg: 'not a contact' } },
        ],
      },
      rooms: {
        join: {
          [GROUP]: {
            timeline: {
              events: [
                ev('m.room.power_levels', { users: { [ME]: 100, [ALICE]: 50 } }, ME, '', 2000),
                msg('$g3', ALICE, 2001),
                ev('m.room.pinned_events', { pinned: ['$g3'] }, ALICE, '', 2002),
              ],
            },
            ephemeral: { events: [receipt('$g3', BOB, 2100, { thread_id: 'main' })] },
          },
          // Never pinned in before: no pinned events at all is no pins. $g1 is the group's, but pinned here it is here.
          [DM]: { timeline: { events: [ev('m.room.pinned_events', { pinned: ['$d1', '$g1'] }, ALICE, '', 2150)] } },
          [PUBLIC]: { timeline: { events: [] }, ephemeral: { events: [receipt('$p1', ALICE, 2200)] } },
          [SPACE]: { timeline: { events: [ev('m.room.power_levels', { users: { [ME]: 100, [BOB]: 100 } }, ME, '', 2300)] } },
          // Just joined: its state is how it is, even what changed in its timeline.
          [NEW]: {
            state: { events: [state('m.room.create', { room_version: '10' }), ...members(ME, ALICE, BOB), state('m.room.power_levels', { users: { [ALICE]: 100 } }, '', ALICE)] },
            timeline: { events: [ev('m.room.pinned_events', { pinned: ['$n1'] }, ALICE, '', 2400), ev('m.room.power_levels', { users: { [ALICE]: 100, [BOB]: 50 } }, ALICE, '', 2401)] },
          },
        },
      },
    });
    expect(later()).toEqual([
      { t: 'role', target: { kind: 'conversation', nativeId: GROUP }, member: BOB, role: 'Moderator', given: false, by: ME, ts: 2000 },
      { t: 'role', target: { kind: 'conversation', nativeId: GROUP }, member: ALICE, role: 'Moderator', given: true, by: ME, ts: 2000 },
      { t: 'pin', conversation: GROUP, message: '$g3', pinned: true, by: ALICE, ts: 2002 },
      { t: 'pin', conversation: GROUP, message: '$g1', pinned: false, by: ALICE, ts: 2002 },
      { t: 'pin', conversation: DM, message: '$d1', pinned: true, by: ALICE, ts: 2150 },
      { t: 'pin', conversation: DM, message: '$g1', pinned: true, by: ALICE, ts: 2150 },
      { t: 'role', target: { kind: 'space', nativeId: SPACE }, member: BOB, role: 'Admin', given: true, by: ME, ts: 2300 },
      { t: 'receipt', conversation: GROUP, messages: ['$g3'], who: BOB, state: 'read', ts: 2100 },
      { t: 'receipt', conversation: PUBLIC, messages: ['$p1'], who: ALICE, state: 'read', ts: 2200 },
    ]);

    // Alice clears her status; Bob becomes a contact and has his asked for.
    const mid = events.length;
    hs.presence[BOB] = { presence: 'unavailable', status_msg: 'Lunch' };
    await step({
      account_data: { events: [{ type: 'm.direct', content: { [ALICE]: [DM], [BOB]: [DM2] } }] },
      presence: { events: [{ type: 'm.presence', sender: ALICE, content: { presence: 'online' } }] },
    });
    await step({});
    await until(() => events.slice(mid).some((e) => e.t === 'customStatus' && e.who === BOB), 'Bob’s status');
    expect(events.slice(mid).filter((e) => e.t === 'customStatus')).toEqual([
      { t: 'customStatus', who: ALICE },
      { t: 'customStatus', who: BOB, text: 'Lunch' },
    ]);
    expect(hs.filters.at(-1).presence).toEqual({ types: ['m.presence'], senders: [ALICE, BOB] });
    expect(hs.presenceAsked).toEqual([ALICE, BOB]);
    // Presence: asked for once, then each change; a stranger's is not told.
    expect(events.filter((e) => e.t === 'presence')).toEqual([
      { t: 'presence', who: ALICE, state: 'online' },
      { t: 'presence', who: ALICE, state: 'offline' },
      { t: 'presence', who: ALICE, state: 'online' },
      { t: 'presence', who: BOB, state: 'idle' },
    ]);
  });

  test('a resync is a first sync too: the stored state is not compared with', async () => {
    const { adapter, hs, step, events } = await startAdapter();
    await step(initialSync());
    const before = hs.syncRequests;
    const resync = adapter.command({ t: 'action', id: '1', action: 'resync' } as any);
    await until(() => hs.syncRequests > before, 'the resync request');
    const from = events.length;
    const again = initialSync();
    again.rooms.join[GROUP].state.events = [state('m.room.create', { room_version: '10' }), ...members(ME, ALICE, BOB), state('m.room.power_levels', { users: { [ME]: 100, [ALICE]: 100 } }), state('m.room.pinned_events', { pinned: [] })];
    await step(again);
    expect(await resync).toMatchObject({ ok: true });
    expect(events.slice(from).filter((e) => e.t === 'pin' || e.t === 'role')).toEqual([]);
  });

  test('a pin made from here is news once, not again when sync brings it back', async () => {
    const { adapter, hs, step, events } = await startAdapter();
    await step(initialSync());
    const from = events.length;
    await adapter.command({ t: 'configure', id: '1', target: { kind: 'conversation', nativeId: GROUP }, change: { key: 'pin', message: '$g2' } } as any);
    expect(hs.writes).toEqual([{ path: `/_matrix/client/v3/rooms/${GROUP}/state/m.room.pinned_events/`, body: { pinned: ['$g1', '$g2'] } }]);
    const pins = () => events.slice(from).filter((e) => e.t === 'pin');
    expect(pins()).toMatchObject([{ conversation: GROUP, message: '$g2', pinned: true, by: ME }]);
    await step({ rooms: { join: { [GROUP]: { timeline: { events: [{ type: 'm.room.pinned_events', state_key: '', event_id: '$written1', sender: ME, origin_server_ts: 5000, content: { pinned: ['$g1', '$g2'] } }] } } } } });
    expect(pins().length).toBe(1);
  });
});
