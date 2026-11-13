/**
 * Adding on Matrix (src/add.ts): resolve, join, knock, the 'rules' check, and invites and knocks as requests, against
 * a fake homeserver that hands out one sync at a time and records every other request.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { DECLINE_REASON, inWords } from '../src/add.ts';
import { MatrixAdapter } from '../src/adapter.ts';
import { AdapterDb } from '../src/db.ts';

const ME = '@me:example.org';
const ALICE = '@alice:example.org';
const BOB = '@bob:example.net';
const CAROL = '@carol:example.com';
const SPAM = '@spam:example.com';
const JOINED = '!joined:example.org';
const RUST = '!rust:example.org';
const LAB = '!lab:example.org';
const SPACE = '!space:example.org';
const INVITED = '!invited:example.org';
const INVITED_SPACE = '!invitedspace:example.net';
const DM = '!dm:example.org';
const KNOCKY = '!knocky:example.org';
const QUIET = '!quiet:example.org';

let n = 0;
const state = (type: string, content: Record<string, any>, key = '', sender = ME, ts = 1000 + ++n) => ({ type, state_key: key, content, sender, event_id: `$s${++n}`, origin_server_ts: ts });
const member = (user: string, membership: string, extra: Record<string, any> = {}, ts?: number) => state('m.room.member', { membership, ...extra }, user, user, ts);
const stripped = (type: string, content: Record<string, any>, key = '', sender = ALICE) => ({ type, state_key: key, content, sender });

/** A joined room as sync sends it. */
const room = (opts: { name?: string; alias?: string; space?: boolean; rule?: string; members?: string[]; extra?: unknown[] }) => ({
  state: {
    events: [
      state('m.room.create', { room_version: '10', ...(opts.space ? { type: 'm.space' } : {}) }),
      ...(opts.name ? [state('m.room.name', { name: opts.name })] : []),
      ...(opts.alias ? [state('m.room.canonical_alias', { alias: opts.alias })] : []),
      state('m.room.join_rules', { join_rule: opts.rule ?? 'public' }),
      ...(opts.members ?? [ME]).map((u) => member(u, 'join')),
      ...((opts.extra ?? []) as any[]),
    ],
  },
  timeline: { events: [] },
});

/** An invited room as sync sends it: stripped state, and the invite itself with its timestamp. */
const invite = (opts: { by?: string; byName?: string; name?: string; space?: boolean; direct?: boolean; ts?: number }) => ({
  invite_state: {
    events: [
      stripped('m.room.create', { room_version: '10', ...(opts.space ? { type: 'm.space' } : {}) }),
      ...(opts.name ? [stripped('m.room.name', { name: opts.name })] : []),
      stripped('m.room.join_rules', { join_rule: 'invite' }),
      ...(opts.by && opts.byName ? [stripped('m.room.member', { membership: 'join', displayname: opts.byName }, opts.by, opts.by)] : []),
      { ...stripped('m.room.member', { membership: 'invite', ...(opts.direct ? { is_direct: true } : {}) }, ME, opts.by ?? ALICE), event_id: `$inv${++n}`, origin_server_ts: opts.ts ?? 5000 },
    ],
  },
});

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}
type Handler = (c: Call) => unknown;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeHomeserver() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const calls: Call[] = [];
  const routes: { method: string; path: string | RegExp; handle: Handler }[] = [];
  const accountData: Record<string, unknown> = {};
  let syncRequests = 0;
  let batch = 0;
  let snapshot: Handler | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = decodeURIComponent(url.pathname);
      const text = req.method === 'GET' ? '' : await req.text();
      const call: Call = { method: req.method, path: p, query: url.searchParams, body: text ? JSON.parse(text) : undefined };
      const json = (v: unknown, status = 200) => (v instanceof Response ? v : reply(status, v ?? {}));
      if (p.endsWith('/account/whoami')) return json({ user_id: ME, device_id: 'TESTDEV' });
      if (p.endsWith('/filter')) return json({ filter_id: '1' });
      if (p.endsWith('/sync')) {
        if (!url.searchParams.get('since') && url.searchParams.get('filter')?.startsWith('{')) {
          calls.push(call);
          return json(await (snapshot ?? (() => ({ next_batch: 'snap' })))(call));
        }
        syncRequests++;
        if (!queue.length) await Promise.race([new Promise<void>((r) => (wake = r)), Bun.sleep(1000)]);
        wake = null;
        return json({ next_batch: `s${++batch}`, ...(queue.shift() as object) });
      }
      calls.push(call);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        if (typeof r.path === 'string' ? p === r.path : r.path.test(p)) return json(await r.handle(call));
      }
      const data = p.match(/\/user\/[^/]+\/account_data\/(.+)$/);
      if (data) {
        if (req.method === 'PUT') {
          accountData[data[1]] = call.body;
          return json({});
        }
        return data[1] in accountData ? json(accountData[data[1]]) : json({ errcode: 'M_NOT_FOUND', error: 'Account data not found' }, 404);
      }
      if (p === `/_matrix/client/v3/profile/${ME}`) return json({ displayname: 'Me' });
      if (p.endsWith('/joined_members')) return json({ joined: { [ME]: {} } });
      if (p.endsWith('/threads')) return json({ chunk: [] });
      if (p.endsWith('/members')) return json({ chunk: [] });
      return json({ errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }, 404);
    },
  });
  return {
    server,
    calls,
    accountData,
    get syncRequests() {
      return syncRequests;
    },
    route(method: string, path: string | RegExp, handle: Handler) {
      routes.unshift({ method, path, handle });
    },
    onSnapshot(h: Handler) {
      snapshot = h;
    },
    /** Hand out one sync response. */
    sync(res: unknown) {
      queue.push(res);
      wake?.();
    },
    /** Requests that act: anything but reads, filters and syncs. */
    writes() {
      return calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/publicRooms'));
    },
  };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (what()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Hs = ReturnType<typeof fakeHomeserver>;

/** Both events were sent, the first before the second. */
function sentBefore(events: any[], first: (e: any) => boolean, second: (e: any) => boolean) {
  const a = events.findIndex(first);
  const b = events.findIndex(second);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
}

/** An adapter on a fake homeserver. `dir` and `hs` carry over to a restart. */
async function startAdapter(opts: { hs?: Hs; dir?: string } = {}) {
  const hs = opts.hs ?? fakeHomeserver();
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'dither-matrix-add-'));
  const secretFile = join(dir, 'secret.json');
  if (!opts.dir) writeFileSync(secretFile, JSON.stringify({ accessToken: 'token' }), { mode: 0o600 });
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
  // A restart on the same homeserver: the old adapter's last sync may still be open there.
  const base = hs.syncRequests;
  adapter.start(hub);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await adapter.shutdown();
  };
  cleanup.push(async () => {
    await stop();
    if (!opts.hs) hs.server.stop(true);
    if (!opts.dir) rmSync(dir, { recursive: true, force: true });
  });
  /** Hand out a sync and wait for the adapter to have read it (it asks for the next one). */
  const step = async (res: unknown) => {
    await until(() => hs.syncRequests > base, 'the first sync request');
    const asked = hs.syncRequests;
    hs.sync(res);
    await until(() => hs.syncRequests > asked, 'the sync to be processed');
  };
  const cmd = <T = any>(c: Record<string, unknown>) => adapter.command({ id: 'x', ...c } as P.AdapterCommand) as Promise<T>;
  const of = (t: string) => events.filter((e) => e.t === t);
  return { adapter, hs, dir, events, step, cmd, of, stop };
}

/** Where the account starts: in one room with an address, and in a space. */
const initialSync = (extra: Record<string, unknown> = {}) => ({
  rooms: {
    join: {
      [JOINED]: room({ name: 'Joined Room', alias: '#joined:example.org', members: [ME, ALICE] }),
      [SPACE]: room({ name: 'Home Space', space: true }),
    },
    ...extra,
  },
});

/** The room the server says the account just joined, in the next sync. */
const joinedNow = (id: string, opts: Parameters<typeof room>[0]) => ({ rooms: { join: { [id]: room(opts) } } });

const RUST_SUMMARY = { room_id: RUST, name: 'Rust Gamedev', topic: 'Games in Rust', avatar_url: 'mxc://example.org/rust', num_joined_members: 412, join_rule: 'public', guest_can_join: false, world_readable: true };

describe('the hello', () => {
  test('says resolve, join and requests, and not connect: Matrix has no friends to add', async () => {
    const { adapter, of } = await startAdapter();
    adapter.onConnect();
    const caps: string[] = of('hello')[0].capabilities;
    expect(caps).toEqual(expect.arrayContaining(['resolve', 'join', 'requests', 'openDirect']));
    expect(caps).not.toContain('connect');
  });
});

describe('resolve', () => {
  test('an address: the directory, then the summary with every server to try; nothing the room can see', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('GET', '/_matrix/client/v3/directory/room/#rust:example.org', () => ({ room_id: RUST, servers: ['example.org', 'example.net'] }));
    hs.route('GET', `/_matrix/client/v1/room_summary/${RUST}`, () => RUST_SUMMARY);
    const p = await cmd<P.AddPreview>({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: '#rust:example.org', via: ['via.example.com'] } });
    expect(p).toEqual({ what: 'room', name: 'Rust Gamedev', nativeId: RUST, avatar: 'mxc://example.org/rust', description: 'Games in Rust', members: 412, actions: ['join'] });
    const summary = hs.calls.find((c) => c.path.includes('/room_summary/'))!;
    expect(summary.query.getAll('via')).toEqual(['via.example.com', 'example.org', 'example.net']);
    expect(hs.writes()).toEqual([]);
  });

  test('a space that knocks, an invite-only room, an encrypted room without encryption here', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('GET', `/_matrix/client/v1/room_summary/${LAB}`, () => ({ room_id: LAB, name: 'Lab', num_joined_members: 9, room_type: 'm.space', join_rule: 'knock' }));
    hs.route('GET', `/_matrix/client/v1/room_summary/${RUST}`, () => ({ ...RUST_SUMMARY, join_rule: 'invite' }));
    hs.route('GET', `/_matrix/client/v1/room_summary/${QUIET}`, () => ({ room_id: QUIET, name: 'Quiet', join_rule: 'public', encryption: 'm.megolm.v1.aes-sha2' }));
    const place = (address: string) => cmd<P.AddPreview>({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address } });
    expect(await place(LAB)).toEqual({ what: 'space', name: 'Lab', nativeId: LAB, members: 9, actions: ['ask'], notes: ["Joining asks the space's admins first (a knock)."] });
    expect(await place(RUST)).toMatchObject({ what: 'room', name: 'Rust Gamedev', actions: [], notes: ['This room is invite-only: someone in it has to invite you.'] });
    expect(await place(QUIET)).toMatchObject({ name: 'Quiet', actions: ['join'], notes: [expect.stringContaining('end-to-end encrypted')] });
    expect(hs.writes()).toEqual([]);
  });

  test('restricted: open to members of a space this account is in', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('GET', `/_matrix/client/v1/room_summary/${RUST}`, () => ({ ...RUST_SUMMARY, join_rule: 'restricted', allowed_room_ids: [SPACE] }));
    hs.route('GET', `/_matrix/client/v1/room_summary/${LAB}`, () => ({ room_id: LAB, name: 'Lab', join_rule: 'knock_restricted', allowed_room_ids: ['!elsewhere:example.org'] }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: RUST } })).toMatchObject({ actions: ['join'], notes: ['Open to members of Home Space.'] });
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: LAB } })).toMatchObject({ actions: ['ask'] });
  });

  test('an older server: the unstable summary, then the public room list on the room’s server', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('GET', `/_matrix/client/unstable/im.nheko.summary/rooms/${LAB}/summary`, () => ({ room_id: LAB, name: 'Lab', join_rule: 'knock' }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: LAB } })).toMatchObject({ name: 'Lab', actions: ['ask'] });

    hs.route('GET', '/_matrix/client/v3/directory/room/#rust:example.net', () => ({ room_id: RUST, servers: ['example.net'] }));
    hs.route('POST', '/_matrix/client/v3/publicRooms', (c) => ({ chunk: c.query.get('server') === 'example.net' ? [{ room_id: '!other:example.net', name: 'Other' }, { ...RUST_SUMMARY, join_rule: undefined }] : [] }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: '#rust:example.net' } })).toEqual({ what: 'room', name: 'Rust Gamedev', nativeId: RUST, avatar: 'mxc://example.org/rust', description: 'Games in Rust', members: 412, actions: ['join'] });
    const search = hs.calls.find((c) => c.path.endsWith('/publicRooms'))!;
    expect(search.body).toEqual({ limit: 20, filter: { generic_search_term: '#rust:example.net' } });
    expect(hs.writes()).toEqual([]);
  });

  test('partial when the server cannot say without joining: the input as the name, the actions, and why', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: LAB, via: ['example.org'] } })).toEqual({
      what: 'room',
      name: LAB,
      partial: true,
      nativeId: LAB,
      actions: ['join', 'ask'],
      notes: ['This homeserver cannot show a room before you join it.'],
    });
    // A summary the server keeps to members: invite-only, or gone. Join may still work.
    hs.route('GET', `/_matrix/client/v1/room_summary/${RUST}`, () => reply(404, { errcode: 'M_NOT_FOUND', error: 'Room not found or is not accessible' }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: RUST } })).toMatchObject({ name: RUST, partial: true, actions: ['join'] });
    // A join rule nobody knows.
    hs.route('GET', `/_matrix/client/v1/room_summary/${QUIET}`, () => ({ room_id: QUIET, name: 'Quiet', join_rule: 'org.example.lottery' }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: QUIET } })).toMatchObject({ name: QUIET, partial: true, nativeId: QUIET, actions: ['join', 'ask'] });
    expect(hs.writes()).toEqual([]);
  });

  test('a place this account is in already: its ids, from what sync brought, without asking the server', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: '#joined:example.org' } })).toEqual({
      what: 'room',
      name: 'Joined Room',
      nativeId: JOINED,
      members: 2,
      joined: { conversation: JOINED },
      actions: [],
      notes: ['You are in this room already'],
    });
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: SPACE } })).toMatchObject({ what: 'space', joined: { space: SPACE }, actions: [] });
    expect(hs.calls.filter((c) => c.path.includes('/directory/') || c.path.includes('summary'))).toEqual([]);
    // The server says so too (sync has not caught up).
    hs.route('GET', `/_matrix/client/v1/room_summary/${RUST}`, () => ({ ...RUST_SUMMARY, membership: 'join' }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: RUST } })).toMatchObject({ joined: { conversation: RUST }, actions: [] });
  });

  test('not found, and a rate limit: the server’s sentence, and when it frees up', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('GET', '/_matrix/client/v3/directory/room/#nope:example.org', () => reply(404, { errcode: 'M_NOT_FOUND', error: 'Room alias #nope:example.org not found' }));
    await expect(cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: '#nope:example.org' } })).rejects.toThrow("This room alias doesn't exist on example.org");
    hs.route('GET', '/_matrix/client/v3/directory/room/#busy:example.org', () => reply(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 12_000 }));
    await expect(cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: '#busy:example.org' } })).rejects.toThrow('Try again in 12 seconds.');
    expect(hs.calls.filter((c) => c.path.endsWith('#busy:example.org')).length).toBe(1);
    expect(inWords(150_000)).toBe('3 minutes');
  });

  test('a person: the profile, their identity fact before the reply, Message only', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    await step(initialSync());
    hs.route('GET', `/_matrix/client/v3/profile/${BOB}`, () => ({ displayname: 'Bob B', avatar_url: 'mxc://example.net/bob' }));
    const p = await cmd<P.AddPreview>({ t: 'resolve', ref: { kind: 'person', network: 'matrix', handle: BOB } });
    expect(p).toEqual({ what: 'person', name: 'Bob B', nativeId: BOB, avatar: 'mxc://example.net/bob', relationship: 'stranger', actions: ['message'] });
    expect(events.filter((e) => e.t === 'identity' && e.identity.nativeId === BOB).at(-1).identity).toEqual({ nativeId: BOB, handle: BOB, displayName: 'Bob B', avatarUrl: 'mxc://example.net/bob' });

    hs.route('GET', `/_matrix/client/v3/profile/${CAROL}`, () => reply(404, { errcode: 'M_NOT_FOUND', error: 'Profile was not found' }));
    await expect(cmd({ t: 'resolve', ref: { kind: 'person', network: 'matrix', handle: CAROL } })).rejects.toThrow(`There is no Matrix user ${CAROL}`);

    hs.route('GET', `/_matrix/client/v3/profile/${SPAM}`, () => reply(403, { errcode: 'M_FORBIDDEN', error: 'Profile lookup is restricted' }));
    expect(await cmd({ t: 'resolve', ref: { kind: 'person', network: 'matrix', handle: SPAM } })).toMatchObject({ what: 'person', name: SPAM, partial: true, nativeId: SPAM, actions: ['message'] });
    expect(events.some((e) => e.t === 'identity' && e.identity.nativeId === SPAM)).toBe(true);
    expect(hs.writes()).toEqual([]);
  });
});

describe('add', () => {
  test('join: through the via servers, the room’s facts, then its id', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    await step(initialSync());
    hs.route('POST', '/_matrix/client/v3/join/#rust:example.org', () => {
      hs.sync(joinedNow(RUST, { name: 'Rust Gamedev', alias: '#rust:example.org', members: [ME, ALICE, BOB] }));
      return { room_id: RUST };
    });
    const r = await cmd<P.AddResult>({ t: 'add', ref: { kind: 'place', network: 'matrix', address: '#rust:example.org', via: ['example.org', 'example.net'] }, action: 'join' });
    expect(r).toEqual({ conversation: RUST });
    const joinCall = hs.calls.find((c) => c.path.startsWith('/_matrix/client/v3/join/'))!;
    expect(joinCall.query.getAll('server_name')).toEqual(['example.org', 'example.net']);
    expect(events.filter((e) => e.t === 'conversation' && e.conversation.nativeId === RUST).at(-1).conversation).toMatchObject({ shape: 'channel', name: 'Rust Gamedev' });
    // In it now: joining again does nothing.
    expect(await cmd({ t: 'add', ref: { kind: 'place', network: 'matrix', address: '#rust:example.org' }, action: 'join' })).toEqual({ conversation: RUST, notes: ['You are in this room already'] });
    expect(hs.writes().filter((c) => c.path.includes('/join/')).length).toBe(1);
  });

  test('join a space: its space fact, then its id', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    await step(initialSync());
    hs.route('POST', `/_matrix/client/v3/join/${LAB}`, () => {
      hs.sync(joinedNow(LAB, { name: 'Lab', space: true, members: [ME, BOB] }));
      return { room_id: LAB };
    });
    const r = await cmd<P.AddResult>({ t: 'add', ref: { kind: 'place', network: 'matrix', address: LAB }, action: 'join' });
    expect(r).toMatchObject({ space: LAB });
    expect(events.some((e) => e.t === 'space' && e.space.nativeId === LAB && e.space.name === 'Lab')).toBe(true);
  });

  test('ask: a knock, pending', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('POST', `/_matrix/client/v3/knock/${LAB}`, () => ({ room_id: LAB }));
    expect(await cmd({ t: 'add', ref: { kind: 'place', network: 'matrix', address: LAB, via: ['example.org'] }, action: 'ask' })).toMatchObject({ pending: true });
    const k = hs.writes()[0];
    expect([k.method, k.path, k.query.getAll('server_name')]).toEqual(['POST', `/_matrix/client/v3/knock/${LAB}`, ['example.org']]);
  });

  test('the homeserver’s terms are a rules check, never accepted, and nothing is tried again', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    const consent = () => reply(403, { errcode: 'M_CONSENT_NOT_GIVEN', error: 'You must review and agree to our terms', consent_uri: 'https://example.org/_matrix/consent' });
    hs.route('POST', `/_matrix/client/v3/join/${RUST}`, consent);
    hs.route('POST', `/_matrix/client/v3/knock/${LAB}`, consent);
    const r = await cmd<P.AddResult>({ t: 'add', ref: { kind: 'place', network: 'matrix', address: RUST }, action: 'join' });
    expect(r.check).toBe('rules');
    expect(r.notes?.[0]).toContain('https://example.org/_matrix/consent');
    expect((await cmd<P.AddResult>({ t: 'add', ref: { kind: 'place', network: 'matrix', address: LAB }, action: 'ask' })).check).toBe('rules');
    expect(hs.writes().map((c) => c.path)).toEqual([`/_matrix/client/v3/join/${RUST}`, `/_matrix/client/v3/knock/${LAB}`]);
    expect(hs.calls.some((c) => c.path.includes('consent'))).toBe(false);
  });

  test('a refused or rate-limited join: the sentence, tried once', async () => {
    const { hs, step, cmd } = await startAdapter();
    await step(initialSync());
    hs.route('POST', `/_matrix/client/v3/join/${RUST}`, () => reply(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 120_000 }));
    await expect(cmd({ t: 'add', ref: { kind: 'place', network: 'matrix', address: RUST }, action: 'join' })).rejects.toThrow('Try again in 2 minutes.');
    hs.route('POST', `/_matrix/client/v3/join/${LAB}`, () => reply(403, { errcode: 'M_FORBIDDEN', error: 'You are not invited to this room.' }));
    await expect(cmd({ t: 'add', ref: { kind: 'place', network: 'matrix', address: LAB }, action: 'join' })).rejects.toThrow(`Couldn't join ${LAB}: You are not invited to this room.`);
    expect(hs.writes().length).toBe(2);
  });

  test('people are not joined, and there is nothing to friend', async () => {
    const { step, cmd } = await startAdapter();
    await step(initialSync());
    await expect(cmd({ t: 'add', ref: { kind: 'person', network: 'matrix', handle: BOB }, action: 'contact' })).rejects.toThrow(/Message starts a direct chat/);
    await expect(cmd({ t: 'add', ref: { kind: 'person', network: 'matrix', handle: BOB }, action: 'join' })).rejects.toThrow(/cannot be joined/);
  });
});

describe('requests', () => {
  const invites = () => ({
    invite: {
      [INVITED]: invite({ by: ALICE, byName: 'Alice', name: 'Nix Hackathon', ts: 7000 }),
      [INVITED_SPACE]: invite({ by: BOB, space: true, name: 'Bob’s Space', ts: 8000 }),
    },
  });

  test('invites at connect: the inviter first, then the whole list', async () => {
    const { step, events } = await startAdapter();
    await step(initialSync(invites()));
    const lists = events.filter((e) => e.t === 'requests');
    expect(lists.length).toBe(1);
    expect(lists[0].requests).toEqual([
      { nativeId: INVITED, kind: 'invite', from: ALICE, target: { kind: 'conversation', nativeId: INVITED, name: 'Nix Hackathon' }, ts: 7000, answers: ['accept', 'decline', 'block'] },
      { nativeId: INVITED_SPACE, kind: 'invite', from: BOB, target: { kind: 'space', nativeId: INVITED_SPACE, name: 'Bob’s Space' }, ts: 8000, answers: ['accept', 'decline', 'block'] },
    ]);
    for (const who of [ALICE, BOB]) sentBefore(events, (e) => e.t === 'identity' && e.identity.nativeId === who, (e) => e === lists[0]);
  });

  test('none waiting is an empty list, once known', async () => {
    const { step, of } = await startAdapter();
    await step(initialSync());
    expect(of('requests')).toEqual([{ t: 'requests', requests: [] }]);
  });

  test('changes: a new invite, one taken back, one accepted elsewhere; the whole list again on reconnect', async () => {
    const { adapter, step, events, of } = await startAdapter();
    await step(initialSync(invites()));
    const from = events.length;
    const later = () => events.slice(from).filter((e) => e.t === 'request' || e.t === 'requestGone' || e.t === 'requests');
    await step({ rooms: { invite: { [DM]: invite({ by: CAROL, direct: true, ts: 9000 }) } } });
    expect(later()).toEqual([{ t: 'request', request: { nativeId: DM, kind: 'invite', from: CAROL, target: { kind: 'conversation', nativeId: DM }, ts: 9000, answers: ['accept', 'decline', 'block'] } }]);
    // Alice took hers back (the room leaves for us); Bob's space was accepted in another client.
    await step({ rooms: { leave: { [INVITED]: { timeline: { events: [] } } }, join: { [INVITED_SPACE]: room({ name: 'Bob’s Space', space: true, members: [ME, BOB] }) } } });
    expect(later().slice(1)).toEqual([
      { t: 'requestGone', nativeId: INVITED },
      { t: 'requestGone', nativeId: INVITED_SPACE },
    ]);
    // The space's fact went first.
    sentBefore(events, (e) => e.t === 'space' && e.space.nativeId === INVITED_SPACE, (e) => e.t === 'requestGone' && e.nativeId === INVITED_SPACE);
    adapter.onConnect();
    expect(of('requests').at(-1).requests.map((r: P.RequestFact) => r.nativeId)).toEqual([DM]);
  });

  test('a restart keeps the list: sync names an invite only once', async () => {
    const hs = fakeHomeserver();
    const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-add-'));
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ accessToken: 'token' }), { mode: 0o600 });
    cleanup.push(() => {
      hs.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    });
    const first = await startAdapter({ hs, dir });
    await first.step(initialSync(invites()));
    await first.stop();
    const second = await startAdapter({ hs, dir });
    await second.step({});
    expect(second.of('requests').map((e) => e.requests.map((r: P.RequestFact) => r.nativeId))).toEqual([[INVITED, INVITED_SPACE]]);
  });

  test('a store from before invites were followed lists them once, and says nothing it does not know', async () => {
    const hs = fakeHomeserver();
    const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-add-'));
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ accessToken: 'token' }), { mode: 0o600 });
    const seed = new AdapterDb(join(dir, 'matrix.sqlite'));
    seed.set('user', ME);
    seed.set('since', 's0');
    seed.close();
    cleanup.push(() => {
      hs.server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    });
    // First the snapshot fails: no list at all, but a new invite is still told.
    hs.onSnapshot(() => reply(502, { errcode: 'M_UNKNOWN', error: 'Bad gateway' }));
    const a = await startAdapter({ hs, dir });
    await a.step({ rooms: { invite: { [DM]: invite({ by: CAROL, ts: 9000 }) } } });
    expect(a.of('requests')).toEqual([]);
    expect(a.of('request').map((e) => e.request.nativeId)).toEqual([DM]);
    await a.stop();

    let filter: any = null;
    hs.onSnapshot((c) => {
      filter = JSON.parse(c.query.get('filter')!);
      return { next_batch: 'snap', rooms: { invite: invites().invite, join: { [JOINED]: room({ name: 'ignored' }) } } };
    });
    const b = await startAdapter({ hs, dir });
    await b.step({});
    expect(filter.room.timeline.limit).toBe(1);
    expect(filter.room.state.types).toEqual([]);
    expect(b.of('requests').map((e) => e.requests.map((r: P.RequestFact) => r.nativeId))).toEqual([[INVITED, INVITED_SPACE]]);
  });

  test('accept: join through the inviter’s server; gone, the room’s facts, then its id', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    await step(initialSync(invites()));
    hs.route('POST', `/_matrix/client/v3/join/${INVITED}`, () => {
      hs.sync(joinedNow(INVITED, { name: 'Nix Hackathon', rule: 'invite', members: [ME, ALICE, BOB] }));
      return { room_id: INVITED };
    });
    const from = events.length;
    const r = await cmd<P.AddResult>({ t: 'answer', request: INVITED, answer: 'accept' });
    expect(r).toEqual({ conversation: INVITED });
    expect(hs.calls.find((c) => c.path.includes('/join/'))!.query.getAll('server_name')).toEqual(['example.org']);
    const after = events.slice(from);
    expect(after.filter((e) => e.t === 'requestGone')).toEqual([{ t: 'requestGone', nativeId: INVITED }]);
    expect(after.some((e) => e.t === 'conversation' && e.conversation.nativeId === INVITED && e.conversation.shape === 'group')).toBe(true);
    await expect(cmd({ t: 'answer', request: INVITED, answer: 'accept' })).rejects.toThrow('That request is not waiting any more');
  });

  test('accept a direct invite: listed in m.direct, so it is a direct chat', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    hs.accountData['m.direct'] = { [ALICE]: [JOINED] };
    await step(initialSync({ invite: { [DM]: invite({ by: CAROL, direct: true }) } }));
    hs.route('POST', `/_matrix/client/v3/join/${DM}`, () => {
      hs.sync(joinedNow(DM, { members: [ME, CAROL] }));
      return { room_id: DM };
    });
    expect(await cmd({ t: 'answer', request: DM, answer: 'accept' })).toEqual({ conversation: DM });
    expect(hs.accountData['m.direct']).toEqual({ [ALICE]: [JOINED], [CAROL]: [DM] });
    expect(events.filter((e) => e.t === 'conversation' && e.conversation.nativeId === DM).at(-1).conversation).toMatchObject({ shape: 'direct', participants: [ME, CAROL] });
  });

  test('decline: leave the invited room', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    await step(initialSync(invites()));
    hs.route('POST', `/_matrix/client/v3/rooms/${INVITED_SPACE}/leave`, () => ({}));
    const from = events.length;
    expect(await cmd({ t: 'answer', request: INVITED_SPACE, answer: 'decline' })).toEqual({});
    expect(hs.writes().map((c) => c.path)).toEqual([`/_matrix/client/v3/rooms/${INVITED_SPACE}/leave`]);
    expect(events.slice(from).filter((e) => e.t !== 'log')).toEqual([{ t: 'requestGone', nativeId: INVITED_SPACE }]);
    // Sync says so too: nothing more.
    await step({ rooms: { leave: { [INVITED_SPACE]: { timeline: { events: [] } } } } });
    expect(events.slice(from).filter((e) => e.t.startsWith('request'))).toEqual([{ t: 'requestGone', nativeId: INVITED_SPACE }]);
  });

  test('block: leave, and the inviter added to the ignore list beside who was on it', async () => {
    const { hs, step, cmd } = await startAdapter();
    hs.accountData['m.ignored_user_list'] = { ignored_users: { [SPAM]: {} }, 'org.example.kept': true };
    await step(initialSync(invites()));
    hs.route('POST', `/_matrix/client/v3/rooms/${INVITED}/leave`, () => ({}));
    expect(await cmd({ t: 'answer', request: INVITED, answer: 'block' })).toEqual({ identity: ALICE, relationship: 'blocked' });
    expect(hs.writes().map((c) => `${c.method} ${c.path}`)).toEqual([`POST /_matrix/client/v3/rooms/${INVITED}/leave`, `PUT /_matrix/client/v3/user/${ME}/account_data/m.ignored_user_list`]);
    expect(hs.accountData['m.ignored_user_list']).toEqual({ ignored_users: { [SPAM]: {}, [ALICE]: {} }, 'org.example.kept': true });

    // No list yet: one with just them.
    delete hs.accountData['m.ignored_user_list'];
    hs.route('POST', `/_matrix/client/v3/rooms/${INVITED_SPACE}/leave`, () => ({}));
    await cmd({ t: 'answer', request: INVITED_SPACE, answer: 'block' });
    expect(hs.accountData['m.ignored_user_list']).toEqual({ ignored_users: { [BOB]: {} } });
  });

  test('an answer the server refuses keeps the request; the terms are a check', async () => {
    const { hs, step, cmd, events } = await startAdapter();
    await step(initialSync(invites()));
    hs.route('POST', `/_matrix/client/v3/join/${INVITED}`, () => reply(403, { errcode: 'M_CONSENT_NOT_GIVEN', error: 'Agree first', consent_uri: 'https://example.org/consent' }));
    hs.route('POST', `/_matrix/client/v3/rooms/${INVITED_SPACE}/leave`, () => reply(500, { errcode: 'M_UNKNOWN', error: 'Internal server error' }));
    expect(await cmd<P.AddResult>({ t: 'answer', request: INVITED, answer: 'accept' })).toMatchObject({ check: 'rules' });
    await expect(cmd({ t: 'answer', request: INVITED_SPACE, answer: 'decline' })).rejects.toThrow("Couldn't decline the invite: Internal server error.");
    expect(events.filter((e) => e.t === 'requestGone')).toEqual([]);
    await expect(cmd({ t: 'answer', request: INVITED, answer: 'follow' as P.RequestAnswer })).rejects.toThrow(/can be answered with accept, decline, block/);
  });

  describe('knocks on rooms this account admits', () => {
    const levels = (me: number, extra: Record<string, unknown> = {}) => state('m.room.power_levels', { users: { [ME]: me }, invite: 50, kick: 50, ...extra });
    const knockSync = () => ({
      rooms: {
        join: {
          [KNOCKY]: room({ name: 'Knocky', rule: 'knock', members: [ME, ALICE], extra: [levels(100), member(BOB, 'knock', { displayname: 'Bob', reason: 'hi' }, 6000)] }),
          // Knocks here, but this account may not invite: not its to answer.
          [QUIET]: room({ name: 'Quiet', rule: 'knock', members: [ME, ALICE], extra: [levels(0), member(CAROL, 'knock', {}, 6100)] }),
        },
      },
    });

    test('listed with the ones from before sync’s window; accept invites, decline kicks with a reason', async () => {
      const { hs, step, cmd, events, of } = await startAdapter();
      hs.route('GET', `/_matrix/client/v3/rooms/${KNOCKY}/members`, (c) => ({ chunk: c.query.get('membership') === 'knock' ? [member(CAROL, 'knock', { displayname: 'Carol' }, 5500)] : [] }));
      await step(knockSync());
      // Only the room it may admit people to is asked about.
      expect(hs.calls.filter((c) => c.path.endsWith('/members')).map((c) => c.path)).toEqual([`/_matrix/client/v3/rooms/${KNOCKY}/members`]);
      const list: P.RequestFact[] = of('requests')[0].requests;
      expect(list).toEqual([
        { nativeId: `knock|${KNOCKY}|${BOB}`, kind: 'join', from: BOB, target: { kind: 'conversation', nativeId: KNOCKY, name: 'Knocky', members: 2 }, ts: 6000, answers: ['accept', 'decline'] },
        { nativeId: `knock|${KNOCKY}|${CAROL}`, kind: 'join', from: CAROL, target: { kind: 'conversation', nativeId: KNOCKY, name: 'Knocky', members: 2 }, ts: 5500, answers: ['accept', 'decline'] },
      ]);
      sentBefore(events, (e) => e.t === 'identity' && e.identity.nativeId === BOB && e.identity.displayName === 'Bob', (e) => e === of('requests')[0]);

      hs.route('POST', `/_matrix/client/v3/rooms/${KNOCKY}/invite`, () => ({}));
      hs.route('POST', `/_matrix/client/v3/rooms/${KNOCKY}/kick`, () => ({}));
      const from = events.length;
      expect(await cmd({ t: 'answer', request: `knock|${KNOCKY}|${BOB}`, answer: 'accept' })).toMatchObject({ identity: BOB });
      expect(await cmd({ t: 'answer', request: `knock|${KNOCKY}|${CAROL}`, answer: 'decline' })).toEqual({ identity: CAROL });
      expect(hs.writes().map((c) => [c.path, c.body])).toEqual([
        [`/_matrix/client/v3/rooms/${KNOCKY}/invite`, { user_id: BOB }],
        [`/_matrix/client/v3/rooms/${KNOCKY}/kick`, { user_id: CAROL, reason: DECLINE_REASON }],
      ]);
      const told = () => events.slice(from).filter((e) => e.t.startsWith('request'));
      expect(told()).toEqual([
        { t: 'requestGone', nativeId: `knock|${KNOCKY}|${BOB}` },
        { t: 'requestGone', nativeId: `knock|${KNOCKY}|${CAROL}` },
      ]);
      // Sync brings the new memberships: nothing comes back.
      await step({ rooms: { join: { [KNOCKY]: { timeline: { events: [member(BOB, 'invite'), member(CAROL, 'leave')] } } } } });
      expect(told().length).toBe(2);
      // A new knock later is told as it comes; one withdrawn goes.
      await step({ rooms: { join: { [KNOCKY]: { timeline: { events: [member(SPAM, 'knock', {}, 9100)] } } } } });
      expect(told().at(-1)).toMatchObject({ t: 'request', request: { nativeId: `knock|${KNOCKY}|${SPAM}`, from: SPAM, ts: 9100 } });
      await step({ rooms: { join: { [KNOCKY]: { timeline: { events: [member(SPAM, 'leave')] } } } } });
      expect(told().at(-1)).toEqual({ t: 'requestGone', nativeId: `knock|${KNOCKY}|${SPAM}` });
    });

    test('without the power to kick, only accept is offered', async () => {
      const { step, of } = await startAdapter();
      const s = knockSync();
      s.rooms.join[KNOCKY] = room({ name: 'Knocky', rule: 'knock', members: [ME], extra: [levels(60, { kick: 75 }), member(BOB, 'knock', {}, 6000)] });
      await step(s);
      expect(of('requests')[0].requests.map((r: P.RequestFact) => r.answers)).toEqual([['accept']]);
    });
  });
});

describe('addMembers', () => {
  const GROUP = '!group:example.org';
  const STRICT = '!strict:example.org';
  const inviteTo = (room: string) => `/_matrix/client/v3/rooms/${room}/invite`;

  test('invites in turn; the identity and the room with its new participant go before the reply, and sync’s own invite adds nothing', async () => {
    const { adapter, hs, step, cmd, events, of } = await startAdapter();
    adapter.onConnect();
    expect(of('hello')[0].capabilities).toContain('addMembers');
    await step({
      rooms: {
        join: {
          [GROUP]: room({ name: 'Weekend', rule: 'invite', members: [ME, ALICE] }),
          // Only moderators may invite here, and this account is a member.
          [STRICT]: room({ name: 'Strict', rule: 'invite', members: [ME, ALICE], extra: [state('m.room.power_levels', { users: { [ALICE]: 100 }, invite: 50 }, '', ALICE)] }),
        },
      },
    });
    await until(() => of('conversation').some((e) => e.conversation.nativeId === GROUP), 'the room');
    hs.route('POST', inviteTo(GROUP), (c) => (c.body.user_id === CAROL ? reply(403, { errcode: 'M_FORBIDDEN', error: `${CAROL} is banned from the room` }) : {}));

    const from = events.length;
    const r = await cmd<P.AddMembersResult>({ t: 'addMembers', target: { kind: 'conversation', nativeId: GROUP }, people: [BOB, CAROL] });
    const told = events.slice(from);
    sentBefore(
      told,
      (e) => e.t === 'identity' && e.identity.nativeId === BOB,
      (e) => e.t === 'conversation' && e.conversation.nativeId === GROUP && e.conversation.participants.includes(BOB),
    );
    expect(told.some((e) => e.t === 'identity' && e.identity.nativeId === CAROL)).toBe(false);
    expect(hs.writes().map((c) => [c.path, c.body])).toEqual([
      [inviteTo(GROUP), { user_id: BOB }],
      [inviteTo(GROUP), { user_id: CAROL }],
    ]);
    expect(r).toMatchObject({ added: [], invited: [BOB], failed: [{ id: CAROL, reason: `${CAROL} is banned from the room.` }] });
    expect(r.about?.adding).toEqual({ can: true, who: 'known', mode: 'invite' });

    // Sync brings Bob's invite: it replaces the stand-in, and the room is as the hub has it.
    const rooms = of('conversation').length;
    await step({ rooms: { join: { [GROUP]: { timeline: { events: [state('m.room.member', { membership: 'invite' }, BOB, ME)] } } } } });
    expect(of('conversation').length).toBe(rooms);

    // Below the room's invite level: refused in words, nothing sent.
    await expect(cmd({ t: 'addMembers', target: { kind: 'conversation', nativeId: STRICT }, people: [BOB] })).rejects.toThrow('You need power level 50 to invite people.');
    expect(hs.writes().length).toBe(2);
  });
});
