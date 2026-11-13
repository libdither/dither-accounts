/**
 * @ mentions on Matrix (mentions.ts): who a room can ping (its loaded members; with letters typed and members left
 * out by lazy loading, /joined_members, kept a while), and @room: the level it needs, a body that says it, and an event
 * that does, from a sender who may.
 */
import { expect, test } from 'bun:test';
import { bodyMentionsRoom, contentMentionsRoom, mayMentionRoom, MEMBERS_KEEP, RoomMentions, roomMentionLevel } from '../src/mentions.ts';
import { Room } from '../src/rooms.ts';

const ME = '@me:example.org';
const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';
const CAROL = '@carol:other.example';
let n = 0;
function room(opts: { levels?: Record<string, unknown>; members?: Record<string, string | null>; joined?: number } = {}) {
  const r = new Room('!room:example.org');
  const put = (type: string, stateKey: string, content: Record<string, unknown>) => r.setState({ type, state_key: stateKey, content, sender: ME, event_id: `$e${++n}`, origin_server_ts: n });
  put('m.room.create', '', { room_version: '10', creator: ME });
  if (opts.levels) put('m.room.power_levels', '', opts.levels);
  for (const [user, name] of Object.entries(opts.members ?? { [ME]: 'me', [ALICE]: 'Alice', [BOB]: null })) put('m.room.member', user, { membership: 'join', ...(name ? { displayname: name } : {}) });
  if (opts.joined) r.summary = { joined: opts.joined };
  return r;
}

test('@room needs the room’s notifications.room level, 50 unless it says', () => {
  const r = room({ levels: { users: { [ME]: 50, [ALICE]: 0 } } });
  expect(roomMentionLevel(r)).toBe(50);
  expect(mayMentionRoom(r, ME)).toBe(true);
  expect(mayMentionRoom(r, ALICE)).toBe(false);
  const open = room({ levels: { users: {}, notifications: { room: 0 } } });
  expect(roomMentionLevel(open)).toBe(0);
  expect(mayMentionRoom(open, ALICE)).toBe(true);
});

test('a body says @room as a word, outside code', () => {
  expect(bodyMentionsRoom('@room dinner is ready')).toBe(true);
  expect(bodyMentionsRoom('hey @room.')).toBe(true);
  expect(bodyMentionsRoom('(@room)')).toBe(true);
  expect(bodyMentionsRoom('`@room` is how you ping')).toBe(false);
  expect(bodyMentionsRoom('```\n@room\n```')).toBe(false);
  expect(bodyMentionsRoom('mail me@room.example')).toBe(false);
  expect(bodyMentionsRoom('<@@room:example.org>')).toBe(false);
  expect(bodyMentionsRoom('@roommate')).toBe(false);
});

test('an event mentions the room by m.mentions.room, or (no m.mentions) by its body', () => {
  expect(contentMentionsRoom({ body: 'hi', 'm.mentions': { room: true } })).toBe(true);
  // Intentional mentions say what they mean: a body's "@room" without the flag is not one.
  expect(contentMentionsRoom({ body: '@room hi', 'm.mentions': {} })).toBe(false);
  expect(contentMentionsRoom({ body: '@room hi' })).toBe(true);
  expect(contentMentionsRoom({ body: 'hi' })).toBe(false);
});

test('who a room can ping: its loaded members, never you, best match first; @room as your level allows', async () => {
  let asked = 0;
  const r = room({ levels: { users: { [ME]: 100 } } });
  const m = new RoomMentions({ selfId: () => ME, room: () => r, joinedMembers: async () => (asked++, {}) });
  const all = await m.answer(r.id, '', 20);
  expect(all.people).toEqual([
    { nativeId: ALICE, name: 'Alice', handle: ALICE },
    { nativeId: BOB, name: 'bob', handle: BOB },
  ]);
  expect(all.everyone).toBe(true);
  expect((await m.answer(r.id, '@bo', 20)).people.map((p) => p.nativeId)).toEqual([BOB]);
  // By the server in the id, too.
  expect((await m.answer(r.id, 'example', 20)).people).toHaveLength(2);
  expect(asked).toBe(0);
  const low = room({ levels: { users: { [ME]: 0 } } });
  expect((await new RoomMentions({ selfId: () => ME, room: () => low, joinedMembers: async () => ({}) }).answer(low.id, '', 20)).everyone).toBe(false);
});

test('letters typed where lazy loading left members out: the whole list, asked once and kept a while', async () => {
  let asked = 0;
  let now = 1_000_000;
  const r = room({ joined: 40 });
  const m = new RoomMentions(
    {
      selfId: () => ME,
      room: () => r,
      joinedMembers: async () => (asked++, { [ME]: { display_name: 'me' }, [ALICE]: { display_name: 'Alice' }, [CAROL]: { display_name: 'Carol', avatar_url: 'mxc://other.example/c' } }),
    },
    () => now,
  );
  // Nothing typed: no request.
  expect((await m.answer(r.id, '', 20)).people.map((p) => p.nativeId)).toEqual([ALICE, BOB]);
  expect(asked).toBe(0);
  expect((await m.answer(r.id, 'car', 20)).people).toEqual([{ nativeId: CAROL, name: 'Carol', handle: CAROL, avatar: 'mxc://other.example/c' }]);
  await m.answer(r.id, 'ali', 20);
  expect(asked).toBe(1);
  now += MEMBERS_KEEP + 1;
  await m.answer(r.id, 'ali', 20);
  expect(asked).toBe(2);
  // A failed request: the loaded members still answer.
  const broken = new RoomMentions({ selfId: () => ME, room: () => r, joinedMembers: async () => Promise.reject(new Error('M_FORBIDDEN')) });
  expect((await broken.answer(r.id, 'ali', 20)).people.map((p) => p.nativeId)).toEqual([ALICE]);
});
