import { describe, expect, test } from 'bun:test';
import { aboutUsers, addPlan, configurePlan, GROUP_FULL, mapAbout, NOT_GROUP, UNSURE, withChange, withRecipients } from '../src/about.ts';
import { addedFacts, changedFacts, newState, translateDispatch } from '../src/ingest.ts';
import type { RawAbout, RawAboutChannel, RawAboutGuild } from '../src/discord-types.ts';

const SELF = '100000000000000001';
const guild: RawAboutGuild = { id: '200000000000000001', name: 'Example server', icon: 'abc123', description: null, owner_id: SELF, verification_level: 2, nsfw_level: 3, community: false };
const text: RawAboutChannel = { id: '300000000000000001', type: 0, guild_id: guild.id, name: 'general', topic: null, nsfw: false, rate_limit_per_user: 0, everyone_denies_send: false };
const voice: RawAboutChannel = { ...text, id: '300000000000000002', type: 2, name: 'Lounge' };
const news: RawAboutChannel = { ...text, id: '300000000000000003', type: 5, name: 'news', everyone_denies_send: true };
const group: RawAboutChannel = { id: '300000000000000004', type: 3, name: 'Trip', owner_id: SELF, recipients: [{ id: '400000000000000001', username: 'alice.chen', global_name: 'Alice' }] };
const dm: RawAboutChannel = { id: '300000000000000005', type: 1, recipients: [{ id: '400000000000000001', username: 'alice.chen' }] };

const inGuild = (channel: RawAboutChannel, can: RawAbout['can'] = {}, guildCan: RawAbout['can'] = {}): RawAbout => ({ selfId: SELF, channel, guild, can, guildCan, roles: [], members: [] });

describe('mapAbout', () => {
  test('what the server says, read-only where Discord sets it', () => {
    const a = mapAbout({ selfId: SELF, guild, can: { manageGuild: true }, roles: [], members: [], memberCount: 3 });
    expect(a.fields).toEqual({
      name: { value: 'Example server', canEdit: true },
      topic: { value: '', canEdit: false, reason: 'Only Community servers have a description, set in Discord.' },
      // Manage Server changes the icon (moderation.ts reads the file the hub gives).
      avatar: { value: `https://cdn.discordapp.com/icons/${guild.id}/abc123.webp?size=128`, canEdit: true },
      nsfw: { value: true, canEdit: false, reason: 'Discord sets this for the server.' },
    });
    expect(a.you).toEqual({ role: 'Owner', rank: 1 });
    expect(a.members).toEqual({ list: [], total: 3, complete: false });
    expect(a.facts?.[0]).toEqual({ label: 'Verification level', value: 'Medium: on Discord for 5 minutes' });
  });

  test('a permission nobody answered is a no, with that said', () => {
    const a = mapAbout(inGuild(text, { manageChannels: null }));
    expect(a.fields.name).toEqual({ value: 'general', canEdit: false, reason: UNSURE });
    expect(a.fields.announceOnly).toEqual({ value: false, canEdit: false, reason: UNSURE });
  });

  test('voice has no topic; announcement channels are announce-only', () => {
    expect(mapAbout(inGuild(voice, { manageChannels: true })).fields.topic).toBeUndefined();
    expect(mapAbout(inGuild(news, { manageChannels: false })).fields.announceOnly).toEqual({ value: true, canEdit: false, reason: 'You need the Manage Channels permission.' });
  });

  test('a total that is all there is makes the list complete', () => {
    const a = mapAbout({ ...inGuild(text), members: [{ user: { id: SELF, username: 'me' }, roles: [] }], memberCount: 1 });
    expect(a.members?.complete).toBe(true);
  });

  test('the people named come back for identity facts', () => {
    expect(aboutUsers({ selfId: SELF, channel: group, can: {} }).map((u) => u.id)).toEqual(['400000000000000001']);
  });
});

describe('configurePlan', () => {
  const canChannels = inGuild(text, { manageChannels: true });
  test('one PATCH per setting', () => {
    expect(configurePlan(canChannels, { key: 'name', value: '  renamed ' })).toEqual({ channelId: text.id, patch: { name: 'renamed' } });
    expect(configurePlan(canChannels, { key: 'topic', value: '' })).toEqual({ channelId: text.id, patch: { topic: '' } });
    expect(configurePlan(canChannels, { key: 'slowMode', value: 3600 })).toEqual({ channelId: text.id, patch: { rate_limit_per_user: 3600 } });
    expect(configurePlan(canChannels, { key: 'nsfw', value: true })).toEqual({ channelId: text.id, patch: { nsfw: true } });
    expect(configurePlan({ selfId: SELF, guild, can: { manageGuild: true } }, { key: 'name', value: 'New' })).toEqual({ guildId: guild.id, patch: { name: 'New' } });
    expect(configurePlan({ selfId: SELF, channel: group, can: {} }, { key: 'name', value: 'Trip 2' })).toEqual({ channelId: group.id, patch: { name: 'Trip 2' } });
  });

  test('refuses what Discord or this account cannot do, in words', () => {
    expect(() => configurePlan(canChannels, { key: 'avatar', value: 'x' })).toThrow('Changing the picture is not supported yet.');
    expect(() => configurePlan(canChannels, { key: 'announceOnly', value: true })).toThrow("Change who can send in the channel's permissions, in Discord.");
    expect(() => configurePlan(canChannels, { key: 'invite', op: 'create' })).toThrow('Invite links are not supported on Discord yet.');
    expect(() => configurePlan(canChannels, { key: 'pin', message: '1' })).toThrow('A pin is not a setting');
    expect(() => configurePlan(canChannels, { key: 'disappearing', value: 60 })).toThrow('Disappearing messages is not a Discord setting.');
    expect(() => configurePlan({ selfId: SELF, channel: dm, can: {} }, { key: 'name', value: 'x' })).toThrow('has no such setting');
    expect(() => configurePlan({ selfId: SELF, guild, can: { manageGuild: true } }, { key: 'topic', value: 'x' })).toThrow('Only Community servers');
    expect(() => configurePlan(inGuild(text, {}), { key: 'nsfw', value: true })).toThrow(UNSURE);
  });
});

test('withChange shows the change before the stores catch up', () => {
  const a = mapAbout(inGuild(text, { manageChannels: true }));
  expect(withChange(a, { key: 'name', value: ' renamed ' }).fields.name).toEqual({ value: 'renamed', canEdit: true });
  expect(withChange(a, { key: 'pin', message: '1' })).toBe(a);
});

test('changedFacts re-states what the PATCH answered, mutes kept', () => {
  const st = newState();
  st.guilds.set(guild.id, guild);
  st.guildSettings.set(guild.id, { guild_id: guild.id, muted: true });
  expect(changedFacts({ guild: { id: guild.id, name: 'New' } }, st)).toEqual([{ t: 'space', space: expect.objectContaining({ nativeId: guild.id, name: 'New', mute: { level: 'none', muted: true } }) }]);
  expect(changedFacts({ channel: { id: '500000000000000001', type: 4, guild_id: guild.id, name: 'Cat' } }, st)).toEqual([{ t: 'space', space: expect.objectContaining({ kind: 'section', name: 'Cat' }) }]);
  expect(changedFacts({ channel: { ...text, name: 'renamed' } }, st)).toEqual([{ t: 'conversation', conversation: expect.objectContaining({ nativeId: text.id, name: 'renamed' }) }]);
  expect(changedFacts({}, st)).toEqual([]);
});

describe('adding people to a group DM', () => {
  const ANN = group.recipients![0];
  /** People 400000000000000002 on: as many more as asked. */
  const others = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(400000000000000002n + BigInt(i)), username: `user${i + 2}` }));
  const withPeople = (n: number): RawAbout => ({ selfId: SELF, channel: { ...group, recipients: [ANN, ...others(n - 2)] }, can: {} });

  test('a group says whom and how many more: you and the people in it count toward 10', () => {
    expect(mapAbout({ selfId: SELF, channel: group, can: {} }).adding).toEqual({ can: true, reason: 'Only your friends, up to 10 people in all.', who: 'friends', mode: 'add', room: 8 });
    expect(mapAbout(withPeople(9)).adding).toMatchObject({ can: true, room: 1 });
    expect(mapAbout(withPeople(10)).adding).toEqual({ can: false, reason: GROUP_FULL, who: 'friends', mode: 'add', room: 0 });
  });

  test('a DM, a server channel and a server have none', () => {
    expect(mapAbout({ selfId: SELF, channel: dm, can: {} }).adding).toBeUndefined();
    expect(mapAbout(inGuild(text, { manageChannels: true })).adding).toBeUndefined();
    expect(mapAbout({ selfId: SELF, guild, can: { manageGuild: true } }).adding).toBeUndefined();
  });

  test('the plan: who, in which group, checked against the same read', () => {
    const raw = { selfId: SELF, channel: group, can: {} };
    expect(addPlan(raw, ['400000000000000002', '400000000000000003', '400000000000000002'])).toEqual({ channelId: group.id, userIds: ['400000000000000002', '400000000000000003'] });
    expect(() => addPlan({ selfId: SELF, channel: dm, can: {} }, ['400000000000000002'])).toThrow(NOT_GROUP);
    expect(() => addPlan(inGuild(text), ['400000000000000002'])).toThrow(NOT_GROUP);
    expect(() => addPlan({ selfId: SELF, guild, can: {} }, ['400000000000000002'])).toThrow(NOT_GROUP);
    expect(() => addPlan(withPeople(10), ['400000000000000099'])).toThrow(GROUP_FULL);
    expect(() => addPlan(withPeople(9), others(2).map((u) => `9${u.id}`))).toThrow('Only 1 more fit in this group: Discord holds at most 10 people in one.');
    expect(() => addPlan(raw, [])).toThrow('Whom to add?');
    expect(() => addPlan(raw, others(11).map((u) => u.id))).toThrow('At most 10 people at a time.');
  });

  test('the About after: the people added are in it, whether or not the stores caught up', () => {
    const bo = { id: '400000000000000002', username: 'bo' };
    const raw = withRecipients({ selfId: SELF, channel: group, can: {} }, [bo, ANN]);
    expect(raw.channel?.recipients?.map((r) => r.id)).toEqual([ANN.id, bo.id]);
    const about = mapAbout(raw);
    expect(about.members?.list.map((m) => m.id)).toEqual([SELF, ANN.id, bo.id]);
    expect(about.adding?.room).toBe(7);
    expect(withRecipients(raw, [bo])).toBe(raw);
    const server = inGuild(text);
    expect(withRecipients(server, [bo])).toBe(server);
  });

  test('facts: who was added, then the group with them in it', () => {
    const st = Object.assign(newState(), { selfId: SELF });
    const bo = { id: '400000000000000002', username: 'bo' };
    // The store had not caught up: the reply's channel lacks them.
    const facts = addedFacts(group.id, { added: [bo.id], failed: [], users: [bo], channel: { ...group, recipients: [ANN] } }, st);
    expect(facts).toEqual([
      { t: 'identity', identity: expect.objectContaining({ nativeId: bo.id }) },
      { t: 'conversation', conversation: expect.objectContaining({ nativeId: group.id, shape: 'group', name: 'Trip', participants: [SELF, ANN.id, bo.id] }) },
    ]);
    // Caught up: the same, once each.
    expect(addedFacts(group.id, { added: [bo.id], failed: [], users: [bo], channel: { ...group, recipients: [ANN, bo] } }, st)).toEqual([facts[1]!]);
    // Nobody added, no group record: nothing to say.
    expect(addedFacts(group.id, { added: [], failed: [{ id: bo.id, reason: 'x' }], users: [], channel: null }, st)).toEqual([]);
  });

  test('CHANNEL_RECIPIENT_ADD and _REMOVE: the group with its people now; without its record, only who', () => {
    const st = Object.assign(newState(), { selfId: SELF });
    const bo = { id: '400000000000000002', username: 'bo' };
    const added = translateDispatch('CHANNEL_RECIPIENT_ADD', { channelId: group.id, user: bo, channel: { ...group, recipients: [ANN, bo] } }, st);
    expect(added.map((e) => e.t)).toEqual(['identity', 'conversation']);
    expect(added[1]).toMatchObject({ conversation: { participants: [SELF, ANN.id, bo.id] } });
    expect(translateDispatch('CHANNEL_RECIPIENT_REMOVE', { channelId: group.id, user: bo, channel: { ...group, recipients: [ANN, bo] } }, st)).toEqual([
      { t: 'conversation', conversation: expect.objectContaining({ participants: [SELF, ANN.id] }) },
    ]);
    expect(translateDispatch('CHANNEL_RECIPIENT_ADD', { channelId: group.id, user: { ...bo, global_name: 'Bo' }, channel: null }, st).map((e) => e.t)).toEqual(['identity']);
    // This account leaving: CHANNEL_DELETE says so.
    expect(translateDispatch('CHANNEL_RECIPIENT_REMOVE', { channelId: group.id, user: { id: SELF, username: 'me' }, channel: null }, st)).toEqual([]);
    // Not a group: no conversation fact.
    expect(translateDispatch('CHANNEL_RECIPIENT_ADD', { channelId: text.id, user: bo, channel: text }, st).map((e) => e.t)).not.toContain('conversation');
  });
});
