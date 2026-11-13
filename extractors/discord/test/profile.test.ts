import { describe, expect, test } from 'bun:test';
import { bannerUrl, checkBio, mapProfile, profileUsers } from '../src/profile.ts';
import type { RawProfile } from '../src/discord-types.ts';

// Invented ids. WHO's snowflake says the account was made on 1 May 2019.
const MADE = Date.UTC(2019, 4, 1);
const WHO = String((BigInt(MADE) - 1420070400000n) << 22n);
const SELF = '100000000000000001';
const GUILD = '200000000000000001';
const OTHER_GUILD = '200000000000000002';
const FRIEND_A = { id: '400000000000000002', username: 'bea.k', global_name: 'Bea' };
const FRIEND_B = { id: '400000000000000003', username: 'cy' };

const full: RawProfile = {
  selfId: SELF,
  user: { id: WHO, username: 'alice.chen', global_name: 'Alice', avatar: 'ab12' },
  bio: 'Hello! I like **trains**.',
  pronouns: ' she/her ',
  banner: 'a_cd34',
  accent_color: 0x5c7cfa,
  custom_status: { text: 'on a train', emoji: { id: null, name: '🚆' } },
  relationship: 1,
  friend_since: '2021-03-04T05:06:07.000000+00:00',
  legacy_username: 'alice#1234',
  connected_accounts: [
    { type: 'github', id: '9', name: 'alice-c', verified: true, label: 'GitHub', url: 'https://github.com/alice-c' },
    { type: 'xbox', id: '8', name: 'AliceX', verified: false, label: 'Xbox' },
    { type: 'skype', id: 'live:alice', name: 'alice', label: 'Skype', url: 'skype:live%3Aalice?userinfo' },
  ],
  mutual_guilds: [
    {
      id: GUILD,
      name: 'Example server',
      nick: 'Al',
      joined_at: '2022-01-02T03:04:05.000+00:00',
      roles: [
        { id: GUILD, name: '@everyone', position: 0, color: null },
        { id: '300000000000000001', name: 'Helper', position: 1, color: '#5c7cfa' },
        { id: '300000000000000002', name: 'Mod', position: 2, color: null },
      ],
    },
    { id: OTHER_GUILD, nick: null, joined_at: null },
  ],
  mutual_friends: [FRIEND_A, FRIEND_B],
  mutual_friends_count: 2,
};

describe('mapProfile', () => {
  test('everything the profile shows', () => {
    expect(mapProfile(full, WHO)).toEqual({
      displayName: 'Alice',
      handle: 'alice.chen',
      avatar: `https://cdn.discordapp.com/avatars/${WHO}/ab12.webp?size=128`,
      banner: `https://cdn.discordapp.com/banners/${WHO}/a_cd34.gif?size=600`,
      bio: 'Hello! I like **trains**.',
      pronouns: 'she/her',
      status: { text: 'on a train', emoji: '🚆' },
      createdAt: MADE,
      relationship: 'friend',
      mutualSpaces: [
        { id: GUILD, nick: 'Al', roles: [{ name: 'Mod' }, { name: 'Helper', color: '#5c7cfa' }], joinedAt: Date.UTC(2022, 0, 2, 3, 4, 5) },
        { id: OTHER_GUILD },
      ],
      mutualFriends: [FRIEND_A.id, FRIEND_B.id],
      links: [
        { label: 'GitHub', value: 'alice-c', url: 'https://github.com/alice-c', verified: true },
        { label: 'Xbox', value: 'AliceX' },
        { label: 'Skype', value: 'alice' },
      ],
      facts: [
        { label: 'Friends since', value: '2021-03-04' },
        { label: 'Originally known as', value: 'alice#1234' },
      ],
    });
  });

  test('no banner picture: the accent colour; a server emoji by its name', () => {
    const p = mapProfile({ ...full, banner: null, accent_color: 0x00a0ff, custom_status: { emoji: { id: '500000000000000001', name: 'party_train', animated: true } } }, WHO);
    expect(p.banner).toBeUndefined();
    expect(p.accent).toBe('#00a0ff');
    expect(p.status).toEqual({ emoji: ':party_train:' });
  });

  test('standing, from the relationship type', () => {
    const rel = (relationship: number | null) => mapProfile({ selfId: SELF, user: null, relationship }, WHO).relationship;
    expect([0, 1, 2, 3, 4, 5, 6].map(rel)).toEqual(['stranger', 'friend', 'blocked', 'requesting', 'requested', 'stranger', 'stranger']);
    expect(rel(null)).toBeUndefined();
    // Friends since only for a friend.
    expect(mapProfile({ ...full, relationship: 4 }, WHO).facts).toEqual([{ label: 'Originally known as', value: 'alice#1234' }]);
  });

  test('you: your friends, and no standing with yourself', () => {
    const me = mapProfile({ selfId: WHO, user: { id: WHO, username: 'me' }, relationship: 0, friends: [FRIEND_A, FRIEND_B], mutual_guilds: null, mutual_friends: null }, WHO);
    expect(me.relationship).toBeUndefined();
    expect(me.friends).toEqual([FRIEND_A.id, FRIEND_B.id]);
    expect(me.mutualSpaces).toBeUndefined();
    expect(me.mutualFriends).toBeUndefined();
    // Someone else's friends are never listed as yours.
    expect(mapProfile({ ...full, friends: [FRIEND_A] }, WHO).friends).toBeUndefined();
  });

  test('a fetch that failed: what the client still had, nothing made up', () => {
    const p = mapProfile({ selfId: SELF, user: { id: WHO, username: 'alice.chen' }, bio: '', pronouns: '', banner: null, accent_color: null, custom_status: null, relationship: 0, connected_accounts: [], mutual_guilds: null, mutual_friends: null, mutual_friends_count: null, error: 'Missing Access (403)' }, WHO);
    expect(p).toEqual({ displayName: 'alice.chen', handle: 'alice.chen', createdAt: MADE, relationship: 'stranger' });
  });

  test('a count without the list is a fact; a known empty list is an empty list', () => {
    expect(mapProfile({ selfId: SELF, user: null, mutual_friends: null, mutual_friends_count: 3 }, WHO).facts).toEqual([{ label: 'Mutual friends', value: '3' }]);
    const none = mapProfile({ selfId: SELF, user: null, mutual_guilds: [], mutual_friends: [], mutual_friends_count: 0 }, WHO);
    expect(none.mutualSpaces).toEqual([]);
    expect(none.mutualFriends).toEqual([]);
    expect(none.facts).toBeUndefined();
  });

  test("links: the client's table when the hook reached it, the same rules when it did not, and only what it shows", () => {
    const links = mapProfile(
      {
        selfId: SELF,
        user: null,
        connected_accounts: [
          { type: 'steam', id: '76500000000000001', name: 'alice' },
          { type: 'twitter', name: 'alice_c', verified: true },
          { type: 'bluesky', id: 'did:plc:abc123', name: 'alice.example' },
          { type: 'domain', id: 'alice.example', name: 'alice.example', verified: true },
          { type: 'mastodon', id: 'acct:alice', name: '@alice@social.example' },
          { type: 'playstation', id: '7', name: 'AlicePS' },
          { type: 'contacts', name: 'alice' },
        ],
      },
      WHO,
    ).links;
    expect(links).toEqual([
      { label: 'Steam', value: 'alice', url: 'https://steamcommunity.com/profiles/76500000000000001' },
      { label: 'X', value: 'alice_c', url: 'https://x.com/alice_c', verified: true },
      { label: 'Bluesky', value: 'alice.example', url: 'https://bsky.app/profile/did:plc:abc123' },
      { label: 'Domain', value: 'alice.example', url: 'https://alice.example/', verified: true },
      { label: 'Mastodon', value: '@alice@social.example' },
      { label: 'PlayStation Network', value: 'AlicePS' },
    ]);
  });

  test('a name with only a username, and none at all', () => {
    expect(mapProfile({ selfId: SELF, user: { id: WHO, username: 'cy' } }, WHO)).toMatchObject({ displayName: 'cy', handle: 'cy' });
    const nobody = mapProfile({ selfId: SELF, user: { id: WHO } }, WHO);
    expect(nobody.displayName).toBeUndefined();
    expect(nobody.handle).toBeUndefined();
    expect(nobody.avatar).toBeUndefined();
  });
});

test('profileUsers names the person, mutual friends and your friends, for identity facts first', () => {
  expect(profileUsers(full).map((u) => u.id)).toEqual([WHO, FRIEND_A.id, FRIEND_B.id]);
  expect(profileUsers({ selfId: WHO, user: null, friends: [FRIEND_B] }).map((u) => u.id)).toEqual([FRIEND_B.id]);
});

test('bannerUrl: animated banners as gif, none without a hash', () => {
  expect(bannerUrl('1', 'ff')).toBe('https://cdn.discordapp.com/banners/1/ff.webp?size=600');
  expect(bannerUrl('1', 'a_ff')).toBe('https://cdn.discordapp.com/banners/1/a_ff.gif?size=600');
  expect(bannerUrl('1', null)).toBeUndefined();
});

test("your own bio: Discord's 190 characters, an emoji counting once, checked before any request", () => {
  expect(checkBio('🧗'.repeat(190))).toBe('🧗'.repeat(190));
  expect(checkBio('')).toBe('');
  expect(() => checkBio('x'.repeat(191))).toThrow('a Discord bio takes 190 characters, this one has 191');
  expect(() => checkBio(undefined)).toThrow('nothing to change');
});
