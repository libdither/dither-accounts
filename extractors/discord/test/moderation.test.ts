/**
 * Moderating a server (src/moderation.ts) and the channel and server settings a plain PATCH changes (src/about.ts):
 * what the About offers by the client's own checks, failing closed, how this account stands to each member, the
 * plans the hook is asked for, and the refusals before any request.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { BAN_DELETE_CHOICES, TIMEOUT_DURATIONS } from '@dither-chat/protocol';
import { bitrateChoices, configurePlan, mapAbout } from '../src/about.ts';
import type { RawAbout } from '../src/discord-types.ts';
import { bansOutcome, clearPlan, MOD_ELSEWHERE, moderatePlan, withModeration } from '../src/moderation.ts';

const SELF = '100000000000000001';
const OWNER = '100000000000000002';
const MODR = '100000000000000003';
const ANA = '100000000000000004';
const G = '200000000000000001';
const user = (id: string) => ({ id, username: `u${id.slice(-1)}` });
const roles = [
  { id: G, name: '@everyone', position: 0 },
  { id: 'r1', name: 'Helper', position: 1 },
  { id: 'r2', name: 'Booster', position: 2, managed: true },
  { id: 'r3', name: 'Mod', position: 3, hoist: true },
  { id: 'r4', name: 'Admin', position: 4, hoist: true },
];
const manage = (v: boolean) => ({ kickMembers: v, banMembers: v, moderateMembers: v, manageRoles: v });
const raw = (can: RawAbout['can'], extra: Partial<RawAbout> = {}): RawAbout => ({
  selfId: SELF,
  guild: { id: G, name: 'Test', owner_id: OWNER },
  roles,
  members: [
    { user: user(SELF), roles: ['r3'] },
    { user: user(OWNER), roles: ['r4'], manage: manage(false) },
    { user: user(MODR), roles: ['r3'], manage: manage(false) },
    { user: user(ANA), roles: ['r1'], manage: manage(true), timeout_until: new Date(Date.now() + 3600_000).toISOString() },
  ],
  memberCount: 40,
  can,
  top_position: 3,
  ...extra,
});
const about = (r: RawAbout) => withModeration(r, mapAbout(r));
const ALL = { kickMembers: true, banMembers: true, moderateMembers: true, manageRoles: true };

describe('what a moderator may do', () => {
  test('powers by the client’s own checks, with the choices its dialogs offer', () => {
    const a = about(raw(ALL));
    expect(a.moderation).toEqual({
      remove: { can: true },
      ban: { can: true, deleteHistory: BAN_DELETE_CHOICES },
      roles: { can: true, assignable: ['r1'] },
      timeout: { can: true, durations: TIMEOUT_DURATIONS },
      bansOnRequest: true,
      elsewhere: MOD_ELSEWHERE,
    });
  });

  test('someone in voice, from a voice channel: by the permissions there, no rank needed; a text channel offers none', () => {
    const vc = { id: '300000000000000201', type: 2, name: 'Voice', guild_id: G } as RawAbout['channel'];
    const a = about(raw({ muteMembers: true, deafenMembers: false, moveMembers: null }, { channel: vc, guildCan: ALL }));
    expect(a.moderation).toMatchObject({
      voiceMute: { can: true },
      voiceDeafen: { can: false, reason: 'You need the Deafen Members permission.' },
      voiceMove: { can: false, reason: 'You need the Move Members permission.' },
      remove: { can: true },
    });
    const text = about(raw({ muteMembers: true }, { channel: { ...vc!, type: 0 }, guildCan: ALL }));
    expect(text.moderation!.voiceMute).toBeUndefined();
    // The owner is above you for a kick, not for a server mute; the plan names the voice channel to move to.
    const r = raw({ muteMembers: true, moveMembers: true }, { channel: vc, guildCan: ALL });
    expect(moderatePlan(r, about(r), { op: 'voiceMute', who: OWNER, on: true })).toEqual({ kind: 'moderate', guildId: G, userId: OWNER, op: 'voiceMute', on: true });
    expect(moderatePlan(r, about(r), { op: 'move', who: ANA, to: '300000000000000202' })).toEqual({ kind: 'moderate', guildId: G, userId: ANA, op: 'move', channelId: '300000000000000202' });
    expect(moderatePlan(r, about(r), { op: 'disconnect', who: ANA })).toEqual({ kind: 'moderate', guildId: G, userId: ANA, op: 'disconnect' });
    expect(() => moderatePlan(r, about(r), { op: 'voiceDeafen', who: ANA, on: true })).toThrow('You need the Deafen Members permission.');
  });

  test('fails closed: a check nobody answered is a no, each with the permission it needs', () => {
    const a = about(raw({ kickMembers: null, banMembers: false }));
    expect(a.moderation!.remove).toEqual({ can: false, reason: 'You need the Kick Members permission.' });
    expect(a.moderation!.ban).toMatchObject({ can: false, reason: 'You need the Ban Members permission.' });
    expect(a.moderation!.roles).toEqual({ can: false, reason: 'You need the Manage Roles permission.', assignable: [] });
    expect(a.moderation!.timeout).toMatchObject({ can: false, reason: 'You need the Timeout Members permission.' });
  });

  test('each member: you, the owner and anyone as high are above you; roles held and a running timeout', () => {
    const list = about(raw(ALL)).members!.list;
    const by = (id: string) => list.find((m) => m.id === id)!.mod!;
    expect(by(SELF)).toMatchObject({ above: true, reason: 'That is you.' });
    expect(by(OWNER)).toMatchObject({ above: true, reason: 'They own the server.' });
    expect(by(MODR)).toMatchObject({ above: true, reason: expect.stringMatching(/as high as yours/) });
    expect(by(ANA).above).toBeUndefined();
    expect(by(ANA).roles).toEqual(['r1']);
    expect(by(ANA).timedOutUntil).toBeGreaterThan(Date.now());
  });

  test('the owner hands out every role but managed ones and @everyone', () => {
    const a = about(raw(ALL, { selfId: OWNER, top_position: 4 }));
    expect(a.moderation!.roles!.assignable).toEqual(['r1', 'r3', 'r4']);
  });

  test('DMs and group DMs have no moderating here; a server channel moderates its server', () => {
    const dm = raw(ALL, { channel: { id: '5', type: 3, recipients: [] } as never });
    expect(about(dm).moderation).toBeUndefined();
    const ch = raw({}, { channel: { id: '6', type: 0, guild_id: G, name: 'general' } as never, guildCan: ALL });
    expect(about(ch).moderation!.remove).toEqual({ can: true });
  });
});

describe('the hook command for an action', () => {
  const r = raw(ALL);
  const a = about(r);
  test('kick, ban with history, unban, timeout, a role', () => {
    expect(moderatePlan(r, a, { op: 'remove', who: ANA })).toEqual({ kind: 'moderate', guildId: G, userId: ANA, op: 'kick' });
    expect(moderatePlan(r, a, { op: 'ban', who: ANA, deleteSeconds: 3600 })).toMatchObject({ op: 'ban', deleteSeconds: 3600 });
    expect(moderatePlan(r, a, { op: 'unban', who: '100000000000000099' })).toMatchObject({ op: 'unban' });
    expect(moderatePlan(r, a, { op: 'timeout', who: ANA, seconds: 600 })).toMatchObject({ op: 'timeout', seconds: 600 });
    expect(moderatePlan(r, a, { op: 'role', who: ANA, role: 'r1', remove: true })).toMatchObject({ op: 'role', roleId: 'r1', remove: true });
  });

  test('refused in words before any request', () => {
    expect(() => moderatePlan(r, a, { op: 'remove', who: MODR })).toThrow(/as high as yours/);
    expect(() => moderatePlan(r, a, { op: 'role', who: ANA, role: 'r3' })).toThrow(/below your own top role/);
    expect(() => moderatePlan(r, a, { op: 'role', who: ANA, role: 'r1' })).toThrow('They have that role already.');
    expect(() => moderatePlan(r, a, { op: 'timeout', who: ANA, seconds: 7 })).toThrow('not one of the timeout choices');
    expect(() => moderatePlan(r, a, { op: 'admin', who: ANA })).toThrow(/roles, not admins/);
    expect(() => moderatePlan(r, a, { op: 'remove', who: '100000000000000099' })).toThrow('They are not in it now.');
    const no = raw({});
    expect(() => moderatePlan(no, about(no), { op: 'remove', who: ANA })).toThrow('You need the Kick Members permission.');
  });

  test('the Bans list and clearing reactions', () => {
    expect(bansOutcome({ bans: [{ user: user(ANA), reason: 'spam' }, { user: null, reason: null }], more: false })).toEqual({ users: [user(ANA)], result: { banned: [{ id: ANA, reason: 'spam' }] } });
    expect(clearPlan('c', 'm', {})).toEqual({ kind: 'clearReactions', channelId: 'c', messageId: 'm' });
    expect(clearPlan('c', 'm', { key: 'blob:9', who: ANA })).toEqual({ kind: 'clearReactions', channelId: 'c', messageId: 'm', emoji: 'blob:9', userId: ANA });
  });
});

describe('settings a plain PATCH changes', () => {
  const text = (extra: object = {}): RawAbout => ({ selfId: SELF, guild: { id: G, name: 'Test' }, channel: { id: '7', type: 0, guild_id: G, name: 'general', default_auto_archive_duration: 1440, ...extra } as never, can: { manageChannels: true }, guildCan: {} });
  const voice = (tier: number): RawAbout => ({ selfId: SELF, guild: { id: G, name: 'Test' }, channel: { id: '8', type: 2, guild_id: G, name: 'Voice', user_limit: 5, bitrate: 64000 } as never, can: { manageChannels: true }, guildCan: {}, premium_tier: tier });

  test('a text channel hides its threads after a while; a voice channel has a user limit and a bitrate by boosts', () => {
    expect(mapAbout(text()).fields.autoArchive).toEqual({ value: 1440, canEdit: true });
    const v = mapAbout(voice(1)).fields;
    expect(v.userLimit).toEqual({ value: 5, canEdit: true });
    expect(v.bitrate).toMatchObject({ value: 64000, canEdit: true, options: bitrateChoices(1), reason: 'Up to 128 kbps with this server’s boosts.'.replace('’', "'") });
    expect(Math.max(...bitrateChoices(0))).toBe(96000);
    expect(Math.max(...bitrateChoices(3))).toBe(384000);
  });

  test('plans: one field each, the choices Discord offers, the boosts’ ceiling', () => {
    expect(configurePlan(text(), { key: 'autoArchive', value: 10080 })).toEqual({ channelId: '7', patch: { default_auto_archive_duration: 10080 } });
    expect(() => configurePlan(text(), { key: 'autoArchive', value: 5 })).toThrow(/hiding threads/);
    expect(configurePlan(voice(0), { key: 'userLimit', value: 0 })).toEqual({ channelId: '8', patch: { user_limit: 0 } });
    expect(() => configurePlan(voice(0), { key: 'userLimit', value: 100 })).toThrow(/0 \(none\) to 99/);
    expect(configurePlan(voice(2), { key: 'bitrate', value: 256000 })).toEqual({ channelId: '8', patch: { bitrate: 256000 } });
    expect(() => configurePlan(voice(0), { key: 'bitrate', value: 128000 })).toThrow(/Up to 96 kbps/);
    expect(() => configurePlan(text(), { key: 'userLimit', value: 3 })).toThrow(/no such setting/);
  });

  test("a server's description (Community) and icon, with Manage Server", () => {
    const server = (can: RawAbout['can'], community = true): RawAbout => ({ selfId: SELF, guild: { id: G, name: 'Test', description: 'old', community } as never, can });
    expect(configurePlan(server({ manageGuild: true }), { key: 'topic', value: 'new' })).toEqual({ guildId: G, patch: { description: 'new' } });
    expect(() => configurePlan(server({ manageGuild: true }, false), { key: 'topic', value: 'new' })).toThrow(/Only Community servers/);
    expect(configurePlan(server({ manageGuild: true }), { key: 'avatar', value: 'file:///x.png' } as P.AboutChange, 'data:image/png;base64,AA')).toEqual({ guildId: G, patch: { icon: 'data:image/png;base64,AA' } });
    expect(() => configurePlan(server({ manageGuild: false }), { key: 'avatar', value: 'file:///x.png' } as P.AboutChange, 'data:image/png;base64,AA')).toThrow('You need the Manage Server permission.');
    expect(() => configurePlan(server({ manageGuild: true }), { key: 'avatar', value: 'file:///x.png' } as P.AboutChange)).toThrow(/picture/);
  });
});
