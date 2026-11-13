import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { aboutOf, addMembers, configureAbout, createGroup, CREATOR_RANK, inviteLink, joinRuleOf, readAbout, stateFor, type AboutCtx, type AboutHost, type GroupHost } from '../src/about.ts';
import { MatrixError } from '../src/http.ts';
import { Directory, Room, type MxEvent } from '../src/rooms.ts';

const ME = '@me:x.org';
const ADMIN = '@admin:x.org';
const ROOM = '!r:x.org';
let n = 0;

function state(room: Room, type: string, content: Record<string, any>, stateKey = '', sender = ADMIN) {
  room.setState({ type, state_key: stateKey, content, sender, event_id: `$e${++n}`, origin_server_ts: n });
}

/** A room made by ADMIN, with the power levels most clients create: you at `mine`. */
function makeRoom(opts: { mine?: number; version?: string; pl?: Record<string, any> | null; id?: string } = {}): Room {
  const room = new Room(opts.id ?? ROOM);
  state(room, 'm.room.create', { room_version: opts.version ?? '10' });
  if (opts.pl !== null) {
    state(room, 'm.room.power_levels', opts.pl ?? { users: { [ADMIN]: 100, ...(opts.mine ? { [ME]: opts.mine } : {}) }, events: { 'm.room.name': 50, 'm.room.power_levels': 100, 'm.room.join_rules': 100, 'm.room.history_visibility': 100, 'm.room.encryption': 100 } });
  }
  for (const u of [ADMIN, ME]) state(room, 'm.room.member', { membership: 'join' }, u, u);
  return room;
}

const ctx = (over: Partial<AboutCtx> = {}): AboutCtx => ({ selfId: ME, kind: 'conversation', spaces: [], e2ee: true, ...over });

test('a moderator may rename but not change who can join, and is told why', () => {
  const a = aboutOf(makeRoom({ mine: 50 }), ctx());
  expect(a.fields.name).toEqual({ value: '', canEdit: true });
  expect(a.fields.topic?.canEdit).toBe(true); // state_default 50
  expect(a.fields.joinRule).toEqual({ value: 'invite', canEdit: false, reason: 'Needs power level 100; yours is 50.' });
  expect(a.fields.history?.reason).toBe('Needs power level 100; yours is 50.');
  expect(a.fields.avatar).toEqual({ value: null, canEdit: false, reason: 'Changing the picture is not supported yet.' });
  expect(a.you).toEqual({ role: 'Moderator', rank: 50 });
  expect(() => stateFor(makeRoom({ mine: 50 }), ctx(), { key: 'joinRule', value: 'open' })).toThrow('Needs power level 100; yours is 50.');
  expect(stateFor(makeRoom({ mine: 50 }), ctx(), { key: 'name', value: '  Lounge ' })).toEqual({ type: 'm.room.name', stateKey: '', content: { name: 'Lounge' } });
});

test('a member sees the picture locked by level, and the rules in words', () => {
  const a = aboutOf(makeRoom(), ctx());
  expect(a.fields.avatar?.reason).toBe('Needs power level 50; yours is 0.');
  expect(a.rules).toContainEqual({ what: 'Send messages', who: 'Everyone (0)', you: true });
  expect(a.rules).toContainEqual({ what: 'Change name, topic and picture', who: 'Moderators (50)', you: false });
  expect(a.rules).toContainEqual({ what: 'Change join rules, history and encryption', who: 'Admins (100)', you: false });
  expect(a.rules).toContainEqual({ what: 'Remove or ban people', who: 'Moderators (50)', you: false });
  expect(a.rules).toContainEqual({ what: 'Pin messages', who: 'Moderators (50)', you: false });
  expect(a.pinned).toEqual({ messages: [], canEdit: false, reason: 'Needs power level 50; yours is 0.' });
});

test('without a power levels event the creator has 100, everyone else 0, and state needs 0', () => {
  const room = makeRoom({ pl: null });
  const mine = aboutOf(room, ctx());
  expect(mine.fields.name?.canEdit).toBe(true);
  expect(mine.fields.joinRule?.canEdit).toBe(true);
  expect(mine.you).toEqual({ role: 'Member', rank: 0 });
  expect(mine.fields.announceOnly).toEqual({ value: false, canEdit: false, reason: 'This room has no power levels to change.' });
  expect(mine.rules).toContainEqual({ what: 'Remove or ban people', who: 'Moderators (50)', you: false });
  expect(aboutOf(room, ctx({ selfId: ADMIN })).you).toEqual({ role: 'Admin', rank: 100 });
});

test('only admins can send: read from the levels, written as the whole event with only the send levels moved', () => {
  const pl = { users: { [ADMIN]: 100, '@bob:x.org': 20 }, users_default: 0, events_default: 0, events: { 'm.room.message': 0, 'm.room.power_levels': 100 }, kick: 50, notifications: { room: 50 } };
  const room = makeRoom({ pl: { ...pl, users: { ...pl.users, [ME]: 100 } } });
  expect(aboutOf(room, ctx()).fields.announceOnly).toEqual({ value: false, canEdit: true });
  const w = stateFor(room, ctx(), { key: 'announceOnly', value: true })!;
  expect(w.type).toBe('m.room.power_levels');
  expect(w.content).toEqual({ ...pl, users: { ...pl.users, [ME]: 100 }, events_default: 50, events: { 'm.room.message': 50, 'm.room.power_levels': 100 } });
  expect(room.get('m.room.power_levels')!.content.events_default).toBe(0); // the stored copy is not touched

  // Read back as on; turned off again it goes to 0.
  state(room, 'm.room.power_levels', w.content);
  expect(aboutOf(room, ctx()).fields.announceOnly?.value).toBe(true);
  expect(stateFor(room, ctx(), { key: 'announceOnly', value: false })!.content).toMatchObject({ events_default: 0, events: { 'm.room.message': 0 } });
  // Asking for what already is writes nothing.
  expect(stateFor(room, ctx(), { key: 'announceOnly', value: true })).toBeNull();
});

test('only admins can send needs the old send level within your own, too', () => {
  const room = makeRoom({ pl: { users: { [ADMIN]: 100, [ME]: 60 }, events_default: 100, events: { 'm.room.power_levels': 50 } } });
  expect(aboutOf(room, ctx()).fields.announceOnly).toEqual({ value: true, canEdit: false, reason: 'Needs power level 100; yours is 60.' });
  // Turning it on never sets a level above yours.
  const lower = makeRoom({ pl: { users: { [ADMIN]: 100, [ME]: 30 }, events: { 'm.room.power_levels': 30 } } });
  expect(stateFor(lower, ctx(), { key: 'announceOnly', value: true })!.content.events_default).toBe(30);
});

test('join rules map both ways, and the room version decides what is possible', () => {
  expect(['public', 'invite', 'knock', 'knock_restricted', 'restricted', 'private', undefined].map(joinRuleOf)).toEqual(['open', 'invite', 'ask', 'ask', 'space', 'invite', 'invite']);
  const room = makeRoom({ mine: 100 });
  expect(stateFor(room, ctx(), { key: 'joinRule', value: 'open' })!.content).toEqual({ join_rule: 'public' });
  expect(stateFor(room, ctx(), { key: 'joinRule', value: 'ask' })!.content).toEqual({ join_rule: 'knock' });
  expect(() => stateFor(room, ctx(), { key: 'joinRule', value: 'space' })).toThrow('no space');
  expect(stateFor(room, ctx({ spaces: ['!space:x.org'] }), { key: 'joinRule', value: 'space' })!.content).toEqual({ join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: '!space:x.org' }] });
  const old = makeRoom({ mine: 100, version: '6' });
  expect(() => stateFor(old, ctx(), { key: 'joinRule', value: 'ask' })).toThrow('Asking to join needs room version 7 or newer; this room is version 6.');
  const v7 = makeRoom({ mine: 100, version: '7' });
  expect(() => stateFor(v7, ctx({ spaces: ['!space:x.org'] }), { key: 'joinRule', value: 'space' })).toThrow('room version 8 or newer');
  state(room, 'm.room.join_rules', { join_rule: 'knock_restricted', allow: [{ type: 'm.room_membership', room_id: '!other:x.org' }] });
  expect(aboutOf(room, ctx()).fields.joinRule?.value).toBe('ask');
  // An allow list the room already has is kept.
  expect(stateFor(room, ctx({ spaces: ['!space:x.org'] }), { key: 'joinRule', value: 'space' })!.content.allow).toEqual([{ type: 'm.room_membership', room_id: '!other:x.org' }]);
});

test('history visibility reads and writes as itself, shared when unset', () => {
  const room = makeRoom({ mine: 100 });
  expect(aboutOf(room, ctx()).fields.history?.value).toBe('shared');
  state(room, 'm.room.history_visibility', { history_visibility: 'joined' });
  expect(aboutOf(room, ctx()).fields.history?.value).toBe('joined');
  expect(stateFor(room, ctx(), { key: 'history', value: 'world_readable' })).toEqual({ type: 'm.room.history_visibility', stateKey: '', content: { history_visibility: 'world_readable' } });
});

test('encryption turns on, never off, and not from an account that could not write there after', () => {
  const room = makeRoom({ mine: 100 });
  expect(aboutOf(room, ctx()).fields.encrypted).toEqual({ value: false, canEdit: true });
  expect(stateFor(room, ctx(), { key: 'encrypted', value: true })!.content).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
  expect(aboutOf(room, ctx({ e2ee: false })).fields.encrypted?.canEdit).toBe(false);
  state(room, 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' });
  expect(aboutOf(room, ctx()).fields.encrypted).toEqual({ value: true, canEdit: false, reason: 'Encryption cannot be turned off once on.' });
  expect(() => stateFor(room, ctx(), { key: 'encrypted', value: false as true })).toThrow('Encryption cannot be turned off once on.');
});

test('topic is written in both forms; pins are added at the end and read newest first', () => {
  const room = makeRoom({ mine: 50 });
  expect(stateFor(room, ctx(), { key: 'topic', value: 'hi' })!.content).toEqual({ topic: 'hi', 'm.topic': { 'm.text': [{ body: 'hi' }] } });
  state(room, 'm.room.pinned_events', { pinned: ['$a', '$b'] });
  expect(aboutOf(room, ctx()).pinned?.messages).toEqual(['$b', '$a']);
  expect(stateFor(room, ctx(), { key: 'pin', message: '$c' })!.content).toEqual({ pinned: ['$a', '$b', '$c'] });
  expect(stateFor(room, ctx(), { key: 'pin', message: '$a', remove: true })!.content).toEqual({ pinned: ['$b'] });
  expect(stateFor(room, ctx(), { key: 'pin', message: '$a' })).toBeNull();
  expect(stateFor(room, ctx(), { key: 'pin', message: '$z', remove: true })).toBeNull();
});

test('what Matrix does not have, or cannot do yet, is refused in words', () => {
  const room = makeRoom({ mine: 100 });
  expect(() => stateFor(room, ctx(), { key: 'slowMode', value: 5 })).toThrow('Slow mode is not a setting of a Matrix room.');
  expect(() => stateFor(room, ctx(), { key: 'avatar', value: 'mxc://x/y' })).toThrow('not supported yet');
  expect(() => stateFor(room, ctx(), { key: 'invite', op: 'create' })).toThrow('made from the room’s address');
  expect(() => stateFor(room, ctx({ kind: 'space' }), { key: 'history', value: 'joined' })).toThrow('not a setting of a Matrix space');
  expect(Object.keys(aboutOf(room, ctx({ kind: 'space' })).fields)).toEqual(['name', 'topic', 'avatar', 'joinRule']);
});

test('the link: the address if there is one, else the id with the busiest servers', () => {
  const room = makeRoom();
  expect(inviteLink(room, ['@a:one.org', '@b:two.org', '@c:two.org', '@d:three.org', '@e:four.org', '@f:three.org', '@g:two.org'])).toBe('https://matrix.to/#/!r%3Ax.org?via=two.org&via=three.org&via=four.org');
  expect(inviteLink(room, [])).toBe('https://matrix.to/#/!r%3Ax.org');
  state(room, 'm.room.canonical_alias', { alias: '#lounge:x.org' });
  expect(inviteLink(room, ['@a:one.org'])).toBe('https://matrix.to/#/%23lounge%3Ax.org');
  expect(aboutOf(room, ctx()).invite).toEqual({ link: 'https://matrix.to/#/%23lounge%3Ax.org', canCreate: false, derived: true, reason: 'Matrix links are made from the room’s address, not issued.' });
});

test('v12 creators outrank everyone, and the numbers survive JSON', () => {
  const room = new Room(ROOM);
  room.setState({ type: 'm.room.create', state_key: '', content: { room_version: '12', additional_creators: [ME] }, sender: ADMIN, event_id: '$c', origin_server_ts: 0 });
  state(room, 'm.room.power_levels', { users: { '@mod:x.org': 50 }, events: { 'm.room.power_levels': 150 } });
  const members = new Map([[ADMIN, {}], [ME, {}], ['@mod:x.org', {}], ['@z:y.org', {}]]);
  const a = JSON.parse(JSON.stringify(aboutOf(room, ctx(), members))) as P.About;
  expect(a.you).toEqual({ role: 'Owner', rank: CREATOR_RANK });
  expect(a.fields.joinRule?.canEdit).toBe(true);
  expect(a.members?.list.map((m) => [m.id, m.role])).toEqual([
    [ADMIN, 'Owner'],
    [ME, 'Owner'],
    ['@mod:x.org', 'Moderator'],
    ['@z:y.org', 'Member'],
  ]);
  expect(a.roles?.find((r) => r.name === 'Owner')).toEqual({ id: 'creator', name: 'Owner', rank: CREATOR_RANK, count: 2 });
  // A later numeric version is treated the same.
  room.setState({ type: 'm.room.create', state_key: '', content: { room_version: '13' }, sender: ME, event_id: '$c2', origin_server_ts: 1 });
  expect(room.powerLevel(ME)).toBe(Infinity);
});

test('custom levels are named by number; a long member list is cut and counted', () => {
  const room = makeRoom({ pl: { users: { [ADMIN]: 100, '@helper:x.org': 25 } } });
  const members = new Map<string, {}>([[ADMIN, {}], ['@helper:x.org', {}]]);
  for (let i = 0; i < 600; i++) members.set(`@u${i}:x.org`, {});
  const a = aboutOf(room, ctx(), members);
  expect(a.members?.list.length).toBe(500);
  expect(a.members?.total).toBe(602);
  expect(a.members?.complete).toBe(false);
  expect(a.members?.list.slice(0, 2)).toEqual([
    { id: ADMIN, role: 'Admin', rank: 100 },
    { id: '@helper:x.org', role: 'Level 25', rank: 25 },
  ]);
  expect(a.roles?.map((r) => r.name)).toEqual(['Admin', 'Moderator', 'Level 25', 'Member']);
});

// ---------------------------------------------------------------- through the commands, with a fake server

/** `route` answers a request first (or throws as the server would); undefined falls through to the defaults. */
function host(room: Room, route?: (method: string, path: string, body: any) => unknown) {
  const dir = new Directory(ME);
  dir.rooms.set(room.id, room);
  const calls: { method: string; path: string; body?: any }[] = [];
  const identities: P.IdentityFact[] = [];
  const applied: MxEvent[] = [];
  const logs: string[] = [];
  const h: AboutHost = {
    dir,
    e2ee: true,
    api: {
      request: (async (method: string, path: string, opts?: { body?: any }) => {
        calls.push({ method, path, body: opts?.body });
        const routed = await route?.(method, path, opts?.body);
        if (routed !== undefined) return routed;
        if (path.endsWith('/joined_members')) return { joined: { [ADMIN]: { display_name: 'Ada', avatar_url: 'mxc://x.org/a' }, [ME]: { display_name: 'me' }, '@bob:y.org': {} } };
        if (method === 'PUT') return { event_id: '$written' };
        return {};
      }) as AboutHost['api']['request'],
    },
    identity: (f) => identities.push(f),
    applied: (r, ev) => {
      applied.push(ev);
      r.setState(ev);
    },
    log: (m) => logs.push(m),
  };
  return { h, calls, identities, applied, logs };
}

test('about names the members first, then answers', async () => {
  const room = makeRoom({ mine: 50 });
  const { h, calls, identities } = host(room);
  const a = await readAbout(h, { kind: 'conversation', nativeId: ROOM });
  expect(calls).toEqual([{ method: 'GET', path: '/_matrix/client/v3/rooms/!r%3Ax.org/joined_members', body: undefined }]);
  expect(identities).toEqual([{ nativeId: ADMIN, handle: ADMIN, displayName: 'Ada', avatarUrl: 'mxc://x.org/a' }, { nativeId: '@bob:y.org', handle: '@bob:y.org' }]);
  expect(a.members).toEqual({ list: [{ id: ADMIN, role: 'Admin', rank: 100 }, { id: ME, role: 'Moderator', rank: 50 }, { id: '@bob:y.org', role: 'Member', rank: 0 }], total: 3, complete: true });
  expect(a.facts).toEqual([{ label: 'Room version', value: '10' }]);
  const thread = await readAbout(h, { kind: 'conversation', nativeId: `${ROOM}|$root` });
  expect(thread.noun).toBe('Thread');
});

test('configure writes one state event, and answers with the change in place', async () => {
  const room = makeRoom({ mine: 50 });
  const { h, calls, applied } = host(room);
  const a = await configureAbout(h, { kind: 'conversation', nativeId: ROOM }, { key: 'name', value: 'Lounge' });
  expect(calls[0]).toEqual({ method: 'PUT', path: '/_matrix/client/v3/rooms/!r%3Ax.org/state/m.room.name/', body: { name: 'Lounge' } });
  expect(applied.map((e) => [e.type, e.event_id, e.sender])).toEqual([['m.room.name', '$written', ME]]);
  expect(a.fields.name).toEqual({ value: 'Lounge', canEdit: true });
  // Nothing to change: nothing written.
  calls.length = 0;
  await configureAbout(h, { kind: 'conversation', nativeId: ROOM }, { key: 'name', value: 'Lounge' });
  expect(calls.map((c) => c.method)).toEqual(['GET']);
  await expect(configureAbout(h, { kind: 'conversation', nativeId: ROOM }, { key: 'history', value: 'joined' })).rejects.toThrow('Needs power level 100; yours is 50.');
  await expect(configureAbout(h, { kind: 'conversation', nativeId: `${ROOM}|$root` }, { key: 'name', value: 'x' })).rejects.toThrow('A thread has no settings');
});

// ---------------------------------------------------------------- adding people: invites

const DAN = '@dan:y.org';
const EVE = '@eve:z.org';
const FRED = '@fred:z.org';
const INVITE = '/_matrix/client/v3/rooms/!r%3Ax.org/invite';
const MEMBERS = '/_matrix/client/v3/rooms/!r%3Ax.org/joined_members';
const posts = (calls: { method: string; path: string; body?: any }[]) => calls.filter((c) => c.method === 'POST').map((c) => c.body.user_id);

test('adding: inviting needs the room’s invite level; spaces and direct chats have none', () => {
  const strict = { users: { [ADMIN]: 100 }, invite: 50 };
  expect(aboutOf(makeRoom({ pl: strict }), ctx()).adding).toEqual({ can: false, reason: 'You need power level 50 to invite people.', who: 'known', mode: 'invite' });
  expect(aboutOf(makeRoom({ pl: { ...strict, users: { ...strict.users, [ME]: 50 } } }), ctx()).adding).toEqual({ can: true, who: 'known', mode: 'invite' });
  // Most clients leave invite out, which is 0: anyone in may invite.
  expect(aboutOf(makeRoom(), ctx()).adding).toEqual({ can: true, who: 'known', mode: 'invite' });
  expect(aboutOf(makeRoom(), ctx({ kind: 'space' })).adding).toBeUndefined();
  expect(aboutOf(makeRoom(), ctx({ direct: true })).adding).toBeUndefined();
});

test('addMembers invites each person in turn, keeps each invite at once, then reads the About again', async () => {
  const room = makeRoom();
  // Dan's name is known from another room the account shares with him.
  const other = makeRoom({ id: '!o:x.org' });
  state(other, 'm.room.member', { membership: 'join', displayname: 'Dan', avatar_url: 'mxc://y.org/d' }, DAN, DAN);
  const { h, calls, applied, logs } = host(room);
  h.dir.rooms.set(other.id, other);
  const r = await addMembers(h, { kind: 'conversation', nativeId: ROOM }, [DAN, EVE, DAN]);
  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ['POST', INVITE, { user_id: DAN }],
    ['POST', INVITE, { user_id: EVE }],
    ['GET', MEMBERS, undefined],
  ]);
  expect(applied.map((e) => [e.type, e.state_key, e.event_id, e.sender, e.content])).toEqual([
    ['m.room.member', DAN, `~invited:${DAN}`, ME, { membership: 'invite', displayname: 'Dan', avatar_url: 'mxc://y.org/d' }],
    ['m.room.member', EVE, `~invited:${EVE}`, ME, { membership: 'invite' }],
  ]);
  expect(room.members('invite')).toEqual([DAN, EVE]);
  expect(r.added).toEqual([]);
  expect(r.invited).toEqual([DAN, EVE]);
  expect(r.failed).toBeUndefined();
  expect(r.about?.adding).toEqual({ can: true, who: 'known', mode: 'invite' });
  expect(logs).toEqual([`invited ${DAN} to ${ROOM}`, `invited ${EVE} to ${ROOM}`]);
  // Sync's real invite replaces the stand-in; a stand-in never replaces it.
  state(room, 'm.room.member', { membership: 'invite', displayname: 'Dan' }, DAN, ME);
  expect(room.get('m.room.member', DAN)?.event_id.startsWith('$')).toBe(true);
  expect(room.setState(applied[0])).toBe(false);
});

test('below the invite level, in a space, a thread or a direct chat: refused before any request', async () => {
  const strict = makeRoom({ pl: { users: { [ADMIN]: 100 }, invite: 50 } });
  const a = host(strict);
  await expect(addMembers(a.h, { kind: 'conversation', nativeId: ROOM }, [DAN])).rejects.toThrow('You need power level 50 to invite people.');
  await expect(addMembers(a.h, { kind: 'conversation', nativeId: `${ROOM}|$root` }, [DAN])).rejects.toThrow('A thread has no members of its own');
  expect(a.calls).toEqual([]);

  const space = makeRoom();
  state(space, 'm.room.create', { room_version: '10', type: 'm.space' });
  const b = host(space);
  await expect(addMembers(b.h, { kind: 'space', nativeId: ROOM }, [DAN])).rejects.toThrow('Inviting people to a space is not built here');
  expect(b.calls).toEqual([]);

  const dm = makeRoom();
  const c = host(dm);
  c.h.dir.addDirect(ADMIN, ROOM);
  await expect(addMembers(c.h, { kind: 'conversation', nativeId: ROOM }, [DAN])).rejects.toThrow('Nobody is invited to a direct chat from here');
  expect((await readAbout(c.h, { kind: 'conversation', nativeId: ROOM })).adding).toBeUndefined();
  expect(c.calls.filter((x) => x.method === 'POST')).toEqual([]);

  const { h } = host(makeRoom());
  await expect(addMembers(h, { kind: 'conversation', nativeId: '!gone:x.org' }, [DAN])).rejects.toThrow('not joined to !gone:x.org');
  await expect(addMembers(h, { kind: 'conversation', nativeId: ROOM }, [])).rejects.toThrow('Nobody to invite.');
  await expect(addMembers(h, { kind: 'conversation', nativeId: ROOM }, Array.from({ length: 11 }, (_, i) => `@u${i}:x.org`))).rejects.toThrow('Invite at most 10 people at a time.');
});

test('one refused, in the server’s words, while the rest go on; someone already in is added', async () => {
  const room = makeRoom();
  const { h, calls, applied } = host(room, (method, path, body) => {
    if (path !== INVITE) return undefined;
    if (body.user_id === EVE) throw new MatrixError(403, 'M_FORBIDDEN', `${EVE} is banned from the room`);
    // Bob is in, but lazy loading never showed this account his member event: the server says so, /joined_members agrees.
    if (body.user_id === '@bob:y.org') throw new MatrixError(403, 'M_FORBIDDEN', '@bob:y.org is already in the room.');
    return {};
  });
  const r = await addMembers(h, { kind: 'conversation', nativeId: ROOM }, [EVE, ADMIN, 'bob', '@bob:y.org', DAN]);
  // Admin is in by the stored state: not asked. "bob" is no Matrix ID: not asked.
  expect(posts(calls)).toEqual([EVE, '@bob:y.org', DAN]);
  expect(r.added).toEqual([ADMIN, '@bob:y.org']);
  expect(r.invited).toEqual([DAN]);
  expect(r.failed).toEqual([
    { id: EVE, reason: `${EVE} is banned from the room.` },
    { id: 'bob', reason: 'bob is not a Matrix user ID.' },
  ]);
  expect(applied.map((e) => e.state_key)).toEqual([DAN]);
});

test('a rate limit is waited out while the reply can wait; a longer one leaves the rest untried', async () => {
  let danTries = 0;
  const { h, calls } = host(makeRoom(), (_method, path, body) => {
    if (path !== INVITE) return undefined;
    if (body.user_id === DAN && ++danTries === 1) throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'Too Many Requests', { retry_after_ms: 20 });
    if (body.user_id === EVE) throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'Too Many Requests', { retry_after_ms: 120_000 });
    return {};
  });
  const r = await addMembers(h, { kind: 'conversation', nativeId: ROOM }, [DAN, EVE, FRED]);
  expect(posts(calls)).toEqual([DAN, DAN, EVE]);
  expect(r.invited).toEqual([DAN]);
  const limited = 'The homeserver is limiting how often this account can invite people. Try again in 2 minutes.';
  expect(r.failed).toEqual([
    { id: EVE, reason: limited },
    { id: FRED, reason: limited },
  ]);
});

test('no answer: that invite may have gone through, and the rest are not tried', async () => {
  const { h, calls } = host(makeRoom(), (_method, path, body) => {
    if (path === INVITE && body.user_id === DAN) throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    return undefined;
  });
  const r = await addMembers(h, { kind: 'conversation', nativeId: ROOM }, [DAN, EVE]);
  expect(posts(calls)).toEqual([DAN]);
  expect(r.failed).toEqual([
    { id: DAN, reason: 'The homeserver did not answer in time. It may still invite them: look again in a minute.' },
    { id: EVE, reason: 'Not tried: the homeserver stopped answering.' },
  ]);
  expect(r.about).toBeDefined();
});

// ---------------------------------------------------------------- making a room: createRoom, then invites

const NEW = '!new:x.org';
const CREATE = '/_matrix/client/v3/createRoom';
const NEW_INVITE = '/_matrix/client/v3/rooms/!new%3Ax.org/invite';

/** A host whose homeserver makes NEW, and whose sync brings it (you joined) when asked to wait for it. */
function groupHost(opts: { e2ee?: boolean; syncs?: boolean; withInvites?: boolean; route?: (method: string, path: string, body: any) => unknown } = {}) {
  const other = makeRoom({ id: '!o:x.org' });
  state(other, 'm.room.member', { membership: 'join', displayname: 'Dan', avatar_url: 'mxc://y.org/d' }, DAN, DAN);
  const base = host(other, opts.route);
  const order: string[] = [];
  let made = false;
  const h: GroupHost = {
    ...base.h,
    e2ee: opts.e2ee ?? true,
    api: {
      request: (async (method: string, path: string, o?: any) => {
        const r = await base.h.api.request(method, path, o);
        if (path === CREATE) {
          made = true;
          order.push('createRoom');
          return r && typeof r === 'object' && 'room_id' in r ? r : { room_id: NEW };
        }
        if (path === NEW_INVITE) order.push(`invite ${o.body.user_id}`);
        return r;
      }) as AboutHost['api']['request'],
    },
    identity: (f) => {
      order.push(`identity ${f.nativeId}`);
      base.h.identity(f);
    },
    synced: async (roomId, _waitMs, ready) => {
      if (!made || opts.syncs === false) return false;
      // What sync brings: the room as made, first without its name (sync can bring the join alone), then the rest.
      const room = makeRoom({ id: roomId, pl: { users: { [ME]: 100 } } });
      readyBefore.push(!!ready?.(room));
      const body = creates(base.calls).at(-1)!;
      for (const s of body.initial_state ?? []) state(room, s.type, s.content, s.state_key, ME);
      state(room, 'm.room.name', { name: body.name }, '', ME);
      // A sync that also brought the invites, so nothing is kept in their place.
      if (opts.withInvites) for (const c of base.calls.filter((c) => c.path === NEW_INVITE)) state(room, 'm.room.member', { membership: 'invite' }, c.body.user_id, ME);
      readyAfter.push(!!ready?.(room));
      base.h.dir.rooms.set(roomId, room);
      order.push(`synced ${roomId}`);
      return true;
    },
    announce: (roomId) => {
      const room = base.h.dir.rooms.get(roomId)!;
      order.push(`conversation ${roomId} ${room.members('invite').join(' ')}`.trim());
    },
  };
  const readyBefore: boolean[] = [];
  const readyAfter: boolean[] = [];
  return { ...base, h, order, readyBefore, readyAfter };
}
const creates = (calls: { method: string; path: string; body?: any }[]) => calls.filter((c) => c.path === CREATE).map((c) => c.body);

test('createGroup: one createRoom (private, named, encrypted), then one invite each; identities, the room, then the answer', async () => {
  const { h, calls, identities, applied, order } = groupHost();
  const r = await createGroup(h, '  Crag rats ', [DAN, EVE, DAN, ME]);
  expect(creates(calls)).toEqual([{ preset: 'private_chat', name: 'Crag rats', initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] }]);
  expect(calls.filter((c) => c.method === 'POST' && c.path !== CREATE).map((c) => [c.path, c.body])).toEqual([
    [NEW_INVITE, { user_id: DAN }],
    [NEW_INVITE, { user_id: EVE }],
  ]);
  expect(r).toEqual({ conversation: NEW, added: [], invited: [DAN, EVE] });
  expect(order).toEqual([`identity ${DAN}`, `identity ${EVE}`, 'createRoom', `invite ${DAN}`, `invite ${EVE}`, `synced ${NEW}`, `conversation ${NEW} ${DAN} ${EVE}`]);
  expect(identities).toEqual([{ nativeId: DAN, handle: DAN, displayName: 'Dan', avatarUrl: 'mxc://y.org/d' }, { nativeId: EVE, handle: EVE }]);
  // Each invite kept at once where sync has not brought it, so the room is a group with two invited.
  expect(applied.map((e) => [e.room_id, e.state_key, e.content.membership])).toEqual([
    [NEW, DAN, 'invite'],
    [NEW, EVE, 'invite'],
  ]);
  expect(h.dir.rooms.get(NEW)!.members('invite')).toEqual([DAN, EVE]);
});

test('createGroup: plain where this account cannot encrypt, since an encrypted room could not be written to', async () => {
  const { h, calls } = groupHost({ e2ee: false });
  await createGroup(h, 'Plain', [DAN]);
  expect(creates(calls)).toEqual([{ preset: 'private_chat', name: 'Plain' }]);
});

test('createGroup: one the server refuses is failed in its words, the room still made, the rest invited', async () => {
  const { h, calls } = groupHost({
    route: (_m, path, body) => {
      if (path === NEW_INVITE && body.user_id === EVE) throw new MatrixError(403, 'M_FORBIDDEN', 'eve does not accept invites from strangers');
      return undefined;
    },
  });
  const r = await createGroup(h, 'Crag rats', [EVE, 'dan', DAN]);
  expect(r).toEqual({
    conversation: NEW,
    added: [],
    invited: [DAN],
    failed: [
      { id: EVE, reason: 'eve does not accept invites from strangers.' },
      { id: 'dan', reason: 'dan is not a Matrix user ID.' },
    ],
  });
  expect(calls.filter((c) => c.path === NEW_INVITE).map((c) => c.body.user_id)).toEqual([EVE, DAN]);
  // Everyone refused: the room is made all the same, and the owner is told.
  const alone = groupHost({ route: (_m, path) => (path === NEW_INVITE ? Promise.reject(new MatrixError(403, 'M_FORBIDDEN', 'No')) : undefined) });
  expect(await createGroup(alone.h, 'Alone', [DAN])).toEqual({ conversation: NEW, added: [], failed: [{ id: DAN, reason: 'No.' }], notes: ['Nobody could be invited: the room has only you in it.'] });
});

test('createGroup: refused before any request without a name, with nobody or too many; createRoom refused or timed out is said once, never sent again', async () => {
  const a = groupHost();
  await expect(createGroup(a.h, undefined, [DAN])).rejects.toThrow('Give the room a name');
  await expect(createGroup(a.h, '  ', [DAN])).rejects.toThrow('Give the room a name');
  await expect(createGroup(a.h, 'x'.repeat(256), [DAN])).rejects.toThrow(/at most 255 characters/);
  await expect(createGroup(a.h, 'Nobody', [])).rejects.toThrow(/at least 1/);
  await expect(createGroup(a.h, 'Nobody', [ME])).rejects.toThrow(/at least 1/);
  await expect(createGroup(a.h, 'Crowd', Array.from({ length: 11 }, (_, i) => `@u${i}:x.org`))).rejects.toThrow(/at most 10/);
  await expect(createGroup(a.h, 'Names', ['dan'])).rejects.toThrow('None of them is a Matrix user ID.');
  expect(a.calls).toEqual([]);

  const limited = groupHost({ route: (_m, path) => (path === CREATE ? Promise.reject(new MatrixError(429, 'M_LIMIT_EXCEEDED', 'Too Many Requests', { retry_after_ms: 90_000 })) : undefined) });
  await expect(createGroup(limited.h, 'Crag rats', [DAN])).rejects.toThrow('The homeserver is limiting how often this account can make the room. Try again in');
  expect(creates(limited.calls)).toHaveLength(1);
  expect(limited.calls.filter((c) => c.path === NEW_INVITE)).toEqual([]);

  const slow = groupHost({ route: (_m, path) => (path === CREATE ? Promise.reject(new DOMException('timed out', 'TimeoutError')) : undefined) });
  await expect(createGroup(slow.h, 'Crag rats', [DAN])).rejects.toThrow('The homeserver did not answer in time. It may still make the room: look again in a minute.');
  expect(creates(slow.calls)).toHaveLength(1);

  // Made, invited, but sync never brought it: said so, not made again.
  const unsynced = groupHost({ syncs: false });
  await expect(createGroup(unsynced.h, 'Crag rats', [DAN])).rejects.toThrow('The room was made but has not synced yet. It will appear on its own.');
  expect(creates(unsynced.calls)).toHaveLength(1);
});

// Found on the testbed (continuwuity): a sync that brought the invites while the room's fact went out sent the
// group's fact only after it loaded members, after the reply; the hub had the room as "self" when it read the answer.
test('createGroup: the room is sent again after the invites even when sync already has them, and waits for its name and encryption', async () => {
  const { h, applied, order, readyBefore, readyAfter } = groupHost({ withInvites: true });
  expect(await createGroup(h, 'Crag rats', [DAN, EVE])).toEqual({ conversation: NEW, added: [], invited: [DAN, EVE] });
  expect(applied).toEqual([]);
  expect(order.at(-1)).toBe(`conversation ${NEW} ${DAN} ${EVE}`);
  // The join alone is not enough: the name, and the encryption asked for, have to have come.
  expect([readyBefore, readyAfter]).toEqual([[false], [true]]);
  const plain = groupHost({ e2ee: false });
  await createGroup(plain.h, 'Plain', [DAN]);
  expect([plain.readyBefore, plain.readyAfter]).toEqual([[false], [true]]);
});

// Found on the testbed: the first sync of a new room says 1 joined, 0 invited, and the next summary comes only once
// sync sends one; the invites kept in the meantime counted for nothing and the new room's fact went out as "self".
test('a room whose summary is older than its invites is a group, not notes to self', () => {
  const dir = new Directory(ME);
  const room = new Room(NEW);
  state(room, 'm.room.create', { room_version: '11' }, '', ME);
  state(room, 'm.room.member', { membership: 'join' }, ME, ME);
  state(room, 'm.room.name', { name: 'Crag rats' }, '', ME);
  room.summary = { joined: 1, invited: 0 };
  dir.rooms.set(NEW, room);
  expect(dir.place(room)).toEqual({ kind: 'conversation', shape: 'self' });
  state(room, 'm.room.member', { membership: 'invite' }, DAN, ME);
  expect(dir.place(room)).toEqual({ kind: 'conversation', shape: 'group' });
  expect(dir.conversationFact(room, 'group').participants).toEqual([ME, DAN]);
  // A summary that counts more than the state has (members lazily left out) still counts.
  room.summary = { joined: 30, invited: 0 };
  expect(room.joinedCount).toBe(30);
  expect(dir.place(room)).toEqual({ kind: 'conversation', shape: 'channel' });
});

// Found on the testbed: continuwuity takes an invite for a local name nobody has, so it came back "invited".
test('createGroup: someone the own homeserver has no profile for is failed, not invited; elsewhere the invite decides', async () => {
  const GHOST = '@ghost:x.org';
  const FAR = '@far:w.org';
  const PROFILE = (u: string) => `/_matrix/client/v3/profile/${encodeURIComponent(u)}`;
  const notFound = () => Promise.reject(new MatrixError(404, 'M_NOT_FOUND', "This user's profile could not be fetched."));
  const { h, calls, identities } = groupHost({
    route: (method, path) => {
      if (method === 'GET' && (path === PROFILE(GHOST) || path === PROFILE(FAR))) return notFound();
      if (method === 'GET' && path === PROFILE(ADMIN)) return Promise.reject(new MatrixError(403, 'M_FORBIDDEN', 'You do not share a room'));
      return undefined;
    },
  });
  const r = await createGroup(h, 'Crag rats', [GHOST, ADMIN, FAR]);
  expect(r).toEqual({ conversation: NEW, added: [], invited: [ADMIN, FAR], failed: [{ id: GHOST, reason: '@ghost:x.org has no account on x.org.' }] });
  // Only the people on the account's own server are looked up, each once, before the room is made.
  expect(calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual([PROFILE(GHOST), PROFILE(ADMIN)]);
  expect(calls.filter((c) => c.path === NEW_INVITE).map((c) => c.body.user_id)).toEqual([ADMIN, FAR]);
  expect(identities.map((f) => f.nativeId)).toEqual([ADMIN, FAR]);

  // Nobody left: no room.
  const none = groupHost({ route: (method, path) => (method === 'GET' && path.startsWith('/_matrix/client/v3/profile/') ? notFound() : undefined) });
  await expect(createGroup(none.h, 'Ghosts', [GHOST])).rejects.toThrow('@ghost:x.org has no account on x.org.');
  await expect(createGroup(none.h, 'Ghosts', [GHOST, '@ghost2:x.org'])).rejects.toThrow('None of them has an account on x.org.');
  expect(creates(none.calls)).toEqual([]);
});
