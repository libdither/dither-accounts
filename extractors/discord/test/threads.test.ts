/**
 * threads.ts: a thread's facts and its membership as a mute, a forum's tags, the About's thread and group parts, the
 * channel types after 16, and ThreadOps refusing before any request what a fresh About says this account may not do.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mapChannel, mapThread } from '../src/map.ts';
import { mapAbout } from '../src/about.ts';
import { forumFact, ThreadOps, threadCapabilities, threadDispatch, threadFact, threadMute, withThreads } from '../src/threads.ts';
import type { RawAbout, RawChannel } from '../src/discord-types.ts';

const ME = '100000000000000001';
const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const thread = (extra: Partial<RawChannel> = {}): RawChannel => ({ id: '500', type: 11, guild_id: '200', parent_id: '300', name: 't', owner_id: ALICE, thread_metadata: { archived: false, locked: false }, ...extra });
const ALL: P.Capability[] = threadCapabilities({ Rest: true, JoinedThreadsStore: true, ThreadActions: true });

describe('thread facts', () => {
  test('membership: not in it notifies on mentions only; in it as its own setting, else as its channel', () => {
    expect(threadMute(thread({ member: null }))).toEqual({ level: 'mentions' });
    expect(threadMute(thread({ member: { flags: 1, muted: false, mute_end: null } }))).toEqual({});
    expect(threadMute(thread({ member: { flags: 1 | 2, muted: false, mute_end: null } }))).toEqual({ level: 'all' });
    expect(threadMute(thread({ member: { flags: 8, muted: true, mute_end: '2026-11-13T08:00:00.000Z' } }))).toEqual({ level: 'none', muted: true, until: Date.parse('2026-11-13T08:00:00.000Z') });
    // The hook could not say: the hub keeps what it had.
    expect(threadMute(thread())).toBeUndefined();
  });

  test('a thread fact says only what the hook said', () => {
    expect(threadFact(thread())).toEqual({ owner: ALICE });
    expect(threadFact(thread({ type: 12, member: { flags: 4, muted: false, mute_end: null }, applied_tags: ['1'], flags: 2, message_count: 3, create_timestamp: '2026-11-12T08:00:00.000Z', thread_metadata: { locked: true } }))).toEqual({
      joined: true,
      notify: 'mentions',
      locked: true,
      tags: ['1'],
      pinned: true,
      private: true,
      owner: ALICE,
      createdAt: Date.parse('2026-11-12T08:00:00.000Z'),
      messageCount: 3,
    });
    expect(threadFact({ id: '1', type: 0 })).toBeUndefined();
  });

  test("a thread's conversation fact carries them, and a channel override's mute wins over the membership", () => {
    const f = mapThread(thread({ member: null }));
    expect(f).toMatchObject({ shape: 'thread', thread: { joined: false }, mute: { level: 'mentions' } });
    expect(mapThread(thread({ member: null }), { muted: true }).mute).toEqual({ muted: true });
  });

  test("a forum's tags, order and layout; a media channel lays out as a gallery unless it says list", () => {
    const forum: RawChannel = { id: '300', type: 15, guild_id: '200', available_tags: [{ id: '9', name: 'Solved', emoji_name: '✅', moderated: true }, { id: '8', name: '' }], default_sort_order: 1, flags: 16 };
    expect(forumFact(forum)).toEqual({ tags: [{ id: '9', name: 'Solved', emoji: '✅', moderated: true }], sort: 'created', layout: 'list', tagRequired: true });
    expect(forumFact({ id: '301', type: 16, guild_id: '200' })).toEqual({ tags: [], sort: 'activity', layout: 'gallery' });
    expect(forumFact({ id: '302', type: 16, guild_id: '200', default_forum_layout: 1 })?.layout).toBe('list');
    expect(mapChannel(forum, { selfId: ME })).toMatchObject({ variant: 'forum', forum: { tags: [{ id: '9' }] } });
  });

  test('channel types after 16 do not vanish: a media post is a thread, a game DM a DM, a lobby a group, the rest channels', () => {
    expect(mapChannel({ id: '1', type: 19, guild_id: '200', parent_id: '301', name: 'pic' }, { selfId: ME })).toMatchObject({ shape: 'thread', parentConversation: '301' });
    expect(mapChannel({ id: '2', type: 18, recipients: [{ id: ALICE, username: 'alice' }] }, { selfId: ME })).toMatchObject({ shape: 'direct', participants: [ME, ALICE] });
    expect(mapChannel({ id: '3', type: 17, name: 'Lobby', recipients: [] }, { selfId: ME })).toMatchObject({ shape: 'group', name: 'Lobby' });
    expect(mapChannel({ id: '4', type: 20, guild_id: '200', name: 'space' }, { selfId: ME })).toMatchObject({ shape: 'channel' });
    expect(mapChannel({ id: '5', type: 21, guild_id: '200', name: 'app' }, { selfId: ME })).toMatchObject({ shape: 'channel' });
  });
});

const raw = (channel: RawChannel, can: RawAbout['can'] = {}): RawAbout => ({ selfId: ME, channel: channel as RawAbout['channel'], can });

describe('the About', () => {
  test('a thread: who started it may archive it while it is open; only Manage Threads locks or reopens a locked one', () => {
    const mine = withThreads(mapAbout(raw(thread({ owner_id: ME, member: { flags: 1, muted: false, mute_end: null } }))), raw(thread({ owner_id: ME, member: { flags: 1, muted: false, mute_end: null } })), ALL);
    expect(mine.thread).toMatchObject({ archived: false, locked: false, canArchive: true, canLock: false, joined: true });
    const locked = thread({ owner_id: ME, thread_metadata: { archived: true, locked: true } });
    expect(withThreads(mapAbout(raw(locked)), raw(locked), ALL).thread).toMatchObject({ canArchive: false, reason: expect.stringMatching(/locked/) });
    const mod = withThreads(mapAbout(raw(thread(), { manageThreads: true })), raw(thread(), { manageThreads: true }), ALL);
    expect(mod.thread).toMatchObject({ canArchive: true, canLock: true, joined: false });
    // Without the module the client's own actions live in, nothing is offered.
    expect(withThreads(mapAbout(raw(thread(), { manageThreads: true })), raw(thread(), { manageThreads: true }), ['createThreads']).thread).toMatchObject({ canArchive: false, canLock: false });
  });

  test("a group DM: its owner may remove people and hand it over; anyone may change its picture and leave, silently", () => {
    const group: RawChannel = { id: '600', type: 3, owner_id: ME, recipients: [{ id: ALICE, username: 'alice' }, { id: BOB, username: 'bob' }] };
    const a = withThreads(mapAbout(raw(group)), raw(group), ALL);
    expect(a.ownership).toEqual({ owner: ME, youOwn: true, canRemove: true, canTransfer: true });
    expect(a.fields.avatar?.canEdit).toBe(true);
    expect(a.leaving).toMatchObject({ can: true, silent: true, warning: expect.stringMatching(/someone else/) });
    const theirs = { ...group, owner_id: ALICE };
    expect(withThreads(mapAbout(raw(theirs)), raw(theirs), ALL).ownership).toMatchObject({ youOwn: false, canRemove: false, canTransfer: false, reason: expect.any(String) });
  });

  test('a DM may be closed; channels are left alone', () => {
    const dm: RawChannel = { id: '601', type: 1, recipients: [{ id: ALICE, username: 'alice' }] };
    expect(withThreads(mapAbout(raw(dm)), raw(dm), ALL).leaving).toMatchObject({ can: true, warning: expect.stringMatching(/comes back/) });
    const chan: RawChannel = { id: '301', type: 0, guild_id: '200', name: 'general' };
    expect(withThreads(mapAbout(raw(chan)), raw(chan), ALL)).toEqual(mapAbout(raw(chan)));
  });
});

/** ThreadOps over a fake bridge: what it asked the hook, and what it told the hub. */
function ops(about: RawAbout, answers: Record<string, unknown> = {}) {
  const asked: any[] = [];
  const told: P.AdapterEvent[] = [];
  const o = new ThreadOps({
    bridge: { request: async (cmd: any) => (asked.push(cmd), (answers[cmd.kind] ?? {}) as any) },
    pace: { run: (_l, fn) => fn() },
    emit: (ev) => told.push(ev),
    channel: (c) => [{ t: 'conversation', conversation: mapChannel(c, { selfId: ME })! }],
    message: () => [],
    users: () => {},
    caps: () => ALL,
    about: async () => withThreads(mapAbout(about), about, ALL),
    rawAbout: async () => about,
    nonce: () => 'n1',
    log: () => {},
  });
  return { o, asked, told };
}

describe('ThreadOps', () => {
  test('archiving and locking: refused before any request where the About says no; a no-op asks nothing', async () => {
    const { o, asked } = ops(raw(thread()));
    await expect(o.state({ t: 'threadState', id: '1', conversation: '500', archived: true })).rejects.toThrow(/Manage Threads/);
    await expect(o.state({ t: 'threadState', id: '1', conversation: '500', archived: false })).resolves.toMatchObject({ thread: { archived: false } });
    expect(asked).toEqual([]);
    const own = ops(raw(thread({ owner_id: ME })), { threadState: { channel: thread({ owner_id: ME, thread_metadata: { archived: true } }) } });
    await own.o.state({ t: 'threadState', id: '1', conversation: '500', archived: true, locked: true }).catch(() => {});
    expect(own.asked).toEqual([]);
    await own.o.state({ t: 'threadState', id: '1', conversation: '500', archived: true });
    expect(own.asked).toEqual([{ kind: 'threadState', channelId: '500', archived: true }]);
  });

  test('following tells the thread with its new membership', async () => {
    const { o, told } = ops(raw(thread()), { followThread: { channel: thread({ member: { flags: 1, muted: false, mute_end: null } }) } });
    expect(await o.follow({ t: 'followThread', id: '1', conversation: '500', follow: true })).toMatchObject({ joined: true });
    expect(told[0]).toMatchObject({ t: 'conversation', conversation: { nativeId: '500', thread: { joined: true } } });
  });

  test('a thread or post with a bad name, or a post missing a tag its forum requires, is refused before any request', async () => {
    const { o, asked } = ops(raw(thread()));
    await expect(o.createThread({ t: 'createThread', id: '1', conversation: '300', name: '  ' })).rejects.toThrow(/name/);
    const forum: P.ForumFact = { tags: [{ id: '9', name: 'Solved' }], tagRequired: true };
    await expect(o.createPost({ t: 'createPost', id: '1', conversation: '300', name: 'Help', body: 'x', tags: [] }, forum)).rejects.toThrow(/at least one tag/);
    await expect(o.createPost({ t: 'createPost', id: '1', conversation: '300', name: 'Help', body: 'x', tags: ['7'] }, forum)).rejects.toThrow(/not one this forum has/);
    await expect(o.createPost({ t: 'createPost', id: '1', conversation: '300', name: 'Help', body: '', tags: ['9'] }, forum)).rejects.toThrow(/write something/);
    expect(asked).toEqual([]);
  });

  test('a post goes with its tags and files, and its thread is told', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'threads-test-'));
    writeFileSync(join(dir, 'a.png'), 'png');
    const { o, asked, told } = ops(raw(thread()), { createPost: { channel: { id: '520', type: 11, guild_id: '200', parent_id: '300', name: 'Help', applied_tags: ['9'] } } });
    const r = await o.createPost({ t: 'createPost', id: '1', conversation: '300', name: ' Help ', body: 'it broke', tags: ['9', '9'], attachments: [{ path: join(dir, 'a.png'), name: 'a.png', mime: 'image/png', size: 3, kind: 'image' }] }, { tags: [{ id: '9', name: 'Solved' }] });
    expect(r).toEqual({ conversation: '520' });
    expect(asked[0]).toMatchObject({ kind: 'createPost', channelId: '300', name: 'Help', content: 'it broke', tags: ['9'], files: [{ name: 'a.png', base64: Buffer.from('png').toString('base64') }] });
    expect(told[0]).toMatchObject({ conversation: { nativeId: '520', thread: { tags: ['9'] } } });
  });

  test('group DMs: only the owner removes people or hands it over, and only to someone in it; leaving says the leave', async () => {
    const group: RawChannel = { id: '600', type: 3, owner_id: ALICE, recipients: [{ id: ALICE, username: 'alice' }, { id: BOB, username: 'bob' }] };
    const theirs = ops(raw(group));
    await expect(theirs.o.member({ t: 'removeMember', id: '1', target: { kind: 'conversation', nativeId: '600' }, who: BOB })).rejects.toThrow(/owner/);
    expect(theirs.asked).toEqual([]);
    const mine = ops(raw({ ...group, owner_id: ME }), { groupMember: { channel: { ...group, owner_id: ME } } });
    await expect(mine.o.member({ t: 'setOwner', id: '1', target: { kind: 'conversation', nativeId: '600' }, who: '999' })).rejects.toThrow(/someone else in the group/);
    await mine.o.member({ t: 'removeMember', id: '1', target: { kind: 'conversation', nativeId: '600' }, who: BOB });
    expect(mine.asked).toEqual([{ kind: 'groupMember', channelId: '600', userId: BOB, op: 'remove' }]);
    expect(await mine.o.leaveConversation({ t: 'leave', id: '2', target: { kind: 'conversation', nativeId: '600' }, silent: true })).toEqual({ left: true });
    expect(mine.asked[1]).toEqual({ kind: 'leaveGroupDM', channelId: '600', silent: true });
    expect(mine.told.pop()).toEqual({ t: 'leave', kind: 'conversation', nativeId: '600' });
  });

  test('closing a DM keeps it (only hidden in Discord); a channel cannot be left', async () => {
    const dm = ops(raw({ id: '601', type: 1, recipients: [{ id: ALICE, username: 'alice' }] }));
    await dm.o.leaveConversation({ t: 'leave', id: '1', target: { kind: 'conversation', nativeId: '601' } });
    expect(dm.asked).toEqual([{ kind: 'leaveGroupDM', channelId: '601' }]);
    expect(dm.told.filter((e) => e.t === 'leave')).toEqual([]);
    const chan = ops(raw({ id: '301', type: 0, guild_id: '200' }));
    await expect(chan.o.leaveConversation({ t: 'leave', id: '1', target: { kind: 'conversation', nativeId: '301' } })).rejects.toThrow(/leave its server/);
  });

  test("a group's picture is a PNG, JPEG, GIF or WebP from the spool, or none", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'threads-test-'));
    writeFileSync(join(dir, 'p.png'), 'png');
    const group: RawChannel = { id: '600', type: 3, owner_id: ALICE, recipients: [{ id: ALICE, username: 'alice' }] };
    const { o, asked } = ops(raw(group), { groupIcon: { channel: group } });
    await expect(o.picture({ t: 'setPicture', id: '1', target: { kind: 'conversation', nativeId: '600' }, picture: { path: join(dir, 'p.png'), name: 'p.svg', mime: 'image/svg+xml', size: 3, kind: 'image' } })).rejects.toThrow(/PNG/);
    await o.picture({ t: 'setPicture', id: '1', target: { kind: 'conversation', nativeId: '600' }, picture: { path: join(dir, 'p.png'), name: 'p.png', mime: 'image/png', size: 3, kind: 'image' } });
    await o.picture({ t: 'setPicture', id: '2', target: { kind: 'conversation', nativeId: '600' }, picture: null });
    expect(asked).toEqual([
      { kind: 'groupIcon', channelId: '600', dataUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}` },
      { kind: 'groupIcon', channelId: '600', dataUrl: null },
    ]);
  });
});

test('dispatches: channels and loaded messages to facts', () => {
  const evs = threadDispatch('THREAD_MEMBERS_UPDATE', { channels: [thread({ member: null })] }, { channel: (c) => [{ t: 'conversation', conversation: mapChannel(c, { selfId: ME })! }], message: () => [] });
  expect(evs).toMatchObject([{ t: 'conversation', conversation: { nativeId: '500', mute: { level: 'mentions' } } }]);
  expect(threadDispatch('OTHER', {}, { channel: () => [], message: () => [] })).toEqual([]);
});

test('capabilities follow the modules found', () => {
  expect(threadCapabilities({})).toEqual([]);
  expect(threadCapabilities({ Rest: true })).not.toContain('followThreads');
  expect(ALL).toEqual(expect.arrayContaining(['followThreads', 'threadState', 'createThreads', 'forumPosts', 'myThreads', 'crosspost', 'removeMembers', 'transferOwner', 'groupPicture', 'leave']));
});
