/**
 * Server members the client loaded anyway, to passive `members` events (ingest.ts seenMembers, about.ts
 * aboutSeenMembers): each member told once and again only when changed, counts only when they change, identities
 * first, at most 500 a event. No request is ever made for them.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { aboutSeenMembers } from '../src/about.ts';
import { messageEvents, newState, seenMembers, translateDispatch } from '../src/ingest.ts';
import type { RawAbout, RawMessage } from '../src/discord-types.ts';

const SELF = '100000000000000001';
const GUILD = '200000000000000001';
const CH = '300000000000000001';
const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const alice = { id: ALICE, username: 'alice.chen', global_name: 'Alice' };
const bob = { id: BOB, username: 'bob' };
const members = (events: P.AdapterEvent[]) => events.filter((e): e is Extract<P.AdapterEvent, { t: 'members' }> => e.t === 'members');
const state = () => {
  const st = newState();
  st.selfId = SELF;
  return st;
};
const msg = (id: string, extra: Partial<RawMessage> = {}): RawMessage => ({ id, channel_id: CH, guild_id: GUILD, author: alice, content: 'hi', timestamp: '2026-01-01T00:00:00.000Z', ...extra });

describe("a message author's member object", () => {
  test('a members event, after the identity and before the message; the same again says nothing', () => {
    const st = state();
    const events = messageEvents(msg('1', { member: { nick: 'al', roles: ['Mod'], joined_at: '2025-06-01T00:00:00.000Z' } }), st, true);
    expect(events.map((e) => e.t)).toEqual(['identity', 'members', 'message']);
    expect(members(events)).toEqual([{ t: 'members', space: GUILD, source: 'seen', members: [{ who: ALICE, nick: 'al', roles: ['Mod'], joinedAt: Date.parse('2025-06-01T00:00:00.000Z') }] }]);
    expect(members(messageEvents(msg('2', { member: { nick: 'al', roles: ['Mod'], joined_at: '2025-06-01T00:00:00.000Z' } }), st, true))).toEqual([]);
    // A new nick is news.
    expect(members(messageEvents(msg('3', { member: { nick: 'alice!', roles: ['Mod'], joined_at: '2025-06-01T00:00:00.000Z' } }), st, true))[0].members).toEqual([
      { who: ALICE, nick: 'alice!', roles: ['Mod'], joinedAt: Date.parse('2025-06-01T00:00:00.000Z') },
    ]);
  });

  test('none without a member object, or outside a server', () => {
    const st = state();
    expect(members(messageEvents(msg('1'), st, true))).toEqual([]);
    expect(members(messageEvents(msg('2', { guild_id: null, member: { nick: 'x' } }), st, true))).toEqual([]);
  });

  test('through a forwarded MESSAGE_CREATE too', () => {
    const st = state();
    const events = translateDispatch('MESSAGE_CREATE', { message: msg('1', { author: bob, member: { nick: null, roles: [] } }) }, st);
    expect(members(events)).toEqual([{ t: 'members', space: GUILD, source: 'seen', members: [{ who: BOB, roles: [] }] }]);
  });
});

describe('the member list in view and chunks', () => {
  test("members with the list's counts; the same again nothing; counts alone when only they change", () => {
    const st = state();
    const list = { guildId: GUILD, members: [{ user: alice, nick: null, roles: ['Helper'], joined_at: null }, { user: bob, nick: 'b', joined_at: '2024-01-01T00:00:00.000Z' }], memberCount: 1200, onlineCount: 80 };
    const first = translateDispatch('GUILD_MEMBER_LIST_UPDATE', list, st);
    expect(first.filter((e) => e.t === 'identity')).toHaveLength(2);
    expect(members(first)).toEqual([
      { t: 'members', space: GUILD, source: 'seen', members: [{ who: ALICE, roles: ['Helper'] }, { who: BOB, nick: 'b', joinedAt: Date.parse('2024-01-01T00:00:00.000Z') }], total: 1200, online: 80 },
    ]);
    expect(translateDispatch('GUILD_MEMBER_LIST_UPDATE', list, st)).toEqual([]);
    expect(translateDispatch('GUILD_MEMBER_LIST_UPDATE', { ...list, onlineCount: 81 }, st)).toEqual([{ t: 'members', space: GUILD, source: 'seen', members: [], total: 1200, online: 81 }]);
  });

  test('what a source leaves out is not a change: the About knows no nick, a message did', () => {
    const st = state();
    seenMembers(GUILD, [{ user: alice, nick: 'al', roles: ['Mod'] }], st);
    expect(seenMembers(GUILD, [{ user: alice, roles: ['Mod'] }], st)).toEqual([]);
  });

  test('a chunk', () => {
    const st = state();
    expect(members(translateDispatch('GUILD_MEMBERS_CHUNK', { guildId: GUILD, members: [{ user: bob, nick: 'b', roles: [] }] }, st))).toEqual([
      { t: 'members', space: GUILD, source: 'seen', members: [{ who: BOB, nick: 'b', roles: [] }] },
    ]);
  });

  test('at most 500 a event', () => {
    const st = state();
    const many = Array.from({ length: 1200 }, (_, i) => ({ user: { id: String(500000000000000000n + BigInt(i)), username: `u${i}` } }));
    const ev = members(seenMembers(GUILD, many, st, { total: 5000 }));
    expect(ev.map((e) => e.members.length)).toEqual([500, 500, 200]);
    expect(ev.map((e) => e.total)).toEqual([5000, undefined, undefined]);
  });
});

describe("the About's loaded members", () => {
  const raw: RawAbout = {
    selfId: SELF,
    guild: { id: GUILD, name: 'Guild' } as RawAbout['guild'],
    roles: [
      { id: GUILD, name: '@everyone', position: 0 },
      { id: '1', name: 'Mod', position: 2 },
    ],
    members: [
      { user: alice, roles: ['1', GUILD] },
      { user: bob, roles: [] },
    ],
    memberCount: 340,
    can: {},
  };

  test('role names, @everyone left out, and the member count', () => {
    expect(aboutSeenMembers(raw)).toEqual({ guildId: GUILD, members: [{ user: alice, roles: ['Mod'] }, { user: bob, roles: [] }], total: 340 });
    const st = state();
    const s = aboutSeenMembers(raw)!;
    expect(members(seenMembers(s.guildId, s.members, st, { total: s.total }))).toEqual([
      { t: 'members', space: GUILD, source: 'seen', members: [{ who: ALICE, roles: ['Mod'] }, { who: BOB, roles: [] }], total: 340 },
    ]);
  });

  test('not a server: nothing', () => {
    expect(aboutSeenMembers({ selfId: SELF, can: {} })).toBeNull();
  });
});
