/**
 * The @ list's answer in Discord's terms (mentionables.ts): the command the hook gets, the capability from the modules
 * found, and the hook's answer ranked and mapped: best match first, then who wrote last, nicknames before names,
 * avatars as the CDN serves them, roles with their colours, nothing malformed passed on.
 */
import { describe, expect, test } from 'bun:test';
import { mapMentionables, mentionablesCommand, mentionCapabilities, type RawMentionables } from '../src/mentionables.ts';

const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const CAROL = '400000000000000003';
const alice = { id: ALICE, username: 'alice.chen', global_name: 'Alice', avatar: 'abc' };
const bob = { id: BOB, username: 'bobby', global_name: null };
const carol = { id: CAROL, username: 'carol', global_name: 'Caroline', bot: true };

describe('the command and the capability', () => {
  test('the hook is asked for the channel, the letters typed without their @, and a sane limit', () => {
    expect(mentionablesCommand({ t: 'mentionables', id: 'x', conversation: '300000000000000001', query: '@al ', limit: 20 })).toEqual({ kind: 'mentionables', channelId: '300000000000000001', query: 'al', limit: 20 });
    expect(mentionablesCommand({ t: 'mentionables', id: 'x', conversation: '1', query: '', limit: 999 })).toMatchObject({ limit: 50 });
  });

  test('offered only where the client has the channel, its people, its members and its permissions', () => {
    const all = { ChannelStore: true, UserStore: true, GuildMemberStore: true, PermissionStore: true };
    expect(mentionCapabilities(all)).toEqual(['mentionables']);
    for (const k of Object.keys(all)) expect(mentionCapabilities({ ...all, [k]: false })).toEqual([]);
  });
});

describe("the hook's answer", () => {
  const raw: RawMentionables = {
    people: [
      { user: bob, nick: null, lastSpoke: 100 },
      { user: alice, nick: 'Al', lastSpoke: 300 },
      { user: carol, lastSpoke: 200 },
    ],
    roles: [
      { id: '201', name: 'Mods', color: '#E67E22' },
      { id: '202', name: 'Quiet', color: null },
      { id: 'not-an-id', name: 'Broken' },
    ],
    everyone: true,
  };

  test('nothing typed: who wrote last first, by their nickname in the server, else their display name', () => {
    const m = mapMentionables(raw, '', 20);
    expect(m.people.map((p) => p.name)).toEqual(['Al', 'Caroline', 'bobby']);
    expect(m.people[0]).toEqual({ nativeId: ALICE, name: 'Al', handle: 'alice.chen', avatar: `https://cdn.discordapp.com/avatars/${ALICE}/abc.webp?size=128`, lastSpoke: 300 });
    expect(m.people[1]).toMatchObject({ isBot: true, handle: 'carol' });
    expect(m.roles).toEqual([{ id: '201', name: 'Mods', color: '#e67e22' }, { id: '202', name: 'Quiet' }]);
    expect(m.everyone).toBe(true);
  });

  test('letters typed: the whole name, then its start, then a word, then anywhere; any of the three names counts', () => {
    expect(mapMentionables(raw, 'al', 20).people.map((p) => p.name)).toEqual(['Al']);
    expect(mapMentionables(raw, 'chen', 20).people.map((p) => p.name)).toEqual(['Al']);
    // Both only somewhere in a name: who wrote last first.
    expect(mapMentionables(raw, 'o', 20).people.map((p) => p.name)).toEqual(['Caroline', 'bobby']);
    expect(mapMentionables(raw, 'bob', 20).people.map((p) => p.name)).toEqual(['bobby']);
  });

  test('at most the limit; the same person once; nothing from a broken or missing answer', () => {
    expect(mapMentionables(raw, '', 1).people).toHaveLength(1);
    expect(mapMentionables({ people: [{ user: bob }, { user: bob }, { user: { id: 'x', username: 'x' } as any }] }, '', 20).people.map((p) => p.nativeId)).toEqual([BOB]);
    expect(mapMentionables(null, '', 20)).toEqual({ people: [], everyone: false });
    expect(mapMentionables({ people: 'nope' as any, roles: {} as any }, '', 20)).toEqual({ people: [], everyone: false });
  });
});
