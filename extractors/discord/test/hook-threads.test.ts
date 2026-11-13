/**
 * hook.js's threads section (following threads and their notifications, starting threads and forum posts, archiving
 * and locking, publishing, group DMs) against a small replica of the client: one rspack runtime with the stores and
 * action modules it looks for, under mangled export names. The harness is hook-attention.test.ts's.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-threads-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const ME = '100000000000000001';
const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const NEWS = '300000000000000300';
const FORUM = '300000000000000400';
const THREAD = '500000000000000001';
const POST = '500000000000000002';
const GROUP = '600000000000000007';
const DM = '600000000000000005';

function client() {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  const joined: Record<string, { flags: number; muted: boolean; muteConfig: { end_time?: string } | null }> = { [THREAD]: { flags: 1, muted: false, muteConfig: null } };
  const channels: Record<string, any> = {
    [CHAN]: { id: CHAN, type: 0, guild_id: GUILD, name: 'general', defaultAutoArchiveDuration: 1440 },
    [NEWS]: { id: NEWS, type: 5, guild_id: GUILD, name: 'news' },
    [FORUM]: { id: FORUM, type: 15, guild_id: GUILD, name: 'help', availableTags: [{ id: '900', name: 'Solved', emojiName: '✅', moderated: true }, { id: '901', name: 'Bug' }], defaultSortOrder: 1, defaultForumLayout: 2, flags_: 16 },
    [THREAD]: { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHAN, name: 'a thread', ownerId: ME, threadMetadata: { archived: false, locked: false, createTimestamp: '2026-11-12T08:00:00.000Z' }, messageCount: 4 },
    [POST]: { id: POST, type: 11, guild_id: GUILD, parent_id: FORUM, name: 'a post', ownerId: ALICE, appliedTags: ['901'], flags_: 2, threadMetadata: { archived: false, locked: false } },
    [GROUP]: { id: GROUP, type: 3, name: 'friends', ownerId: ME, recipients: [ALICE, BOB] },
    [DM]: { id: DM, type: 1, recipients: [ALICE] },
  };
  const dispatcher = {
    dispatch: (a: any) => void calls.push(['dispatch', a]),
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const answers: Record<string, any> = {};
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del'])
    rest[k] = async (o: any) => {
      calls.push([k, o.url, o.body, o.query]);
      if (k === 'post' && o.url === `/channels/${POST}/thread-members/@me`) joined[POST] = { flags: 1, muted: false, muteConfig: null };
      if (k === 'patch' && o.url === `/channels/${GROUP}` && o.body.owner) channels[GROUP].ownerId = o.body.owner;
      return { body: answers[`${k} ${o.url}`] ?? {} };
    };
  const threadActions = {
    joinThread: () => void calls.push(['joinThread']),
    leaveThread: (c: any, loc: string) => {
      calls.push(['leaveThread', c.id, loc]);
      delete joined[c.id];
      return Promise.resolve({});
    },
    archiveThread: (c: any, lock: boolean) => (calls.push(['archiveThread', c.id, lock]), (channels[c.id].threadMetadata.archived = true), Promise.resolve({})),
    unarchiveThread: (c: any) => (calls.push(['unarchiveThread', c.id]), (channels[c.id].threadMetadata.archived = false), Promise.resolve({})),
    lockThread: (c: any) => (calls.push(['lockThread', c.id]), (channels[c.id].threadMetadata.locked = true), Promise.resolve({})),
    unlockThread: (c: any) => (calls.push(['unlockThread', c.id]), Promise.resolve({})),
    setNotificationSettings: (c: any, body: any) => {
      calls.push(['setNotificationSettings', c.id, body]);
      joined[c.id] = { ...(joined[c.id] ?? { flags: 0, muted: false, muteConfig: null }), ...(body.flags !== undefined ? { flags: body.flags } : {}), ...(body.muted !== undefined ? { muted: body.muted, muteConfig: body.mute_config } : {}) };
      return Promise.resolve({ body: {} });
    },
  };
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: ME, username: 'me' }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null, getMutablePrivateChannels: () => ({ [GROUP]: channels[GROUP], [DM]: channels[DM] }) });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: { id: GUILD, name: 'Rust' } }), getGuild: (id: string) => (id === GUILD ? { id: GUILD, name: 'Rust' } : null) });
    e.F = store('GuildChannelStore', { getChannels: () => ({ SELECTABLE: [{ channel: channels[CHAN] }, { channel: channels[NEWS] }, { channel: channels[FORUM] }] }) });
    e.G = store('JoinedThreadsStore', {
      hasJoined: (id: string) => id in joined,
      flags: (id: string) => joined[id]?.flags,
      isMuted: (id: string) => !!joined[id]?.muted,
      getMuteConfig: (id: string) => joined[id]?.muteConfig,
      getInitialOverlayState: () => Object.keys(joined).map((threadId) => ({ threadId, guildId: GUILD })),
    });
    e.H = rest;
    e.I = threadActions;
    e.J = {
      openPrivateChannel() {},
      removeRecipient: (c: string, u: string) => {
        calls.push(['removeRecipient', c, u]);
        channels[c].recipients = channels[c].recipients.filter((x: string) => x !== u);
        return Promise.resolve({});
      },
      setDMOwner: (c: string, u: string) => {
        calls.push(['setDMOwner', c, u]);
        channels[c].ownerId = u;
        return Promise.resolve({});
      },
    };
  };
  return { handlers, calls, joined, channels, answers, modules, emit: (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a)) };
}

function page(c: ReturnType<typeof client>) {
  const posted: any[] = [];
  const timers: (() => void)[] = [];
  const events = new EventTarget();
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => events.addEventListener(type, fn),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
    down: (payload: any) => events.dispatchEvent(new CustomEvent(DOWN, { detail: payload })),
  };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: 'https://discord.com/app', pathname: '/app', reload() {} };
  const session = { getItem: () => null, setItem() {} };
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', 'clearInterval', HOOK)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => timers.push(fn), () => 0, () => {});
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => cache[id]!.exports;
  T.c = cache;
  (win.webpackChunkdiscord_app = win.webpackChunkdiscord_app || []).push = function (this: any, chunkData: any) {
    const [, mods, run] = chunkData;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, T);
    }
    if (run) run(T);
  };
  win.webpackChunkdiscord_app.push([['700'], { client: c.modules }]);
  timers.splice(0).forEach((fn) => fn());
  const cmd = async (id: string, command: unknown) => {
    win.down({ t: 'cmd', id, cmd: command });
    for (let i = 0; i < 10; i++) await Bun.sleep(0);
    return posted.find((m) => m.t === 'reply' && m.id === id);
  };
  const dispatched = (event: string) => posted.filter((m) => m.t === 'dispatch' && m.event === event).map((m) => m.data);
  return { posted, cmd, dispatched };
}

describe("hook.js's threads section", () => {
  test('finds the thread modules and subscribes to this account\'s membership and loaded posts', () => {
    const c = client();
    const p = page(c);
    const report = p.posted.filter((m) => m.t === 'finders').pop();
    expect(report?.results).toMatchObject({ JoinedThreadsStore: true, ThreadActions: true });
    for (const ev of ['THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE', 'LOAD_FORUM_POSTS', 'LOAD_ARCHIVED_THREADS_SUCCESS']) expect(c.handlers.has(ev)).toBe(true);
  });

  test('a thread says whether this account is in it; a forum says its tags; joined threads come with the snapshot', async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('a', { kind: 'about', target: 'conversation', id: THREAD });
    expect(r.result.channel).toMatchObject({ id: THREAD, member: { flags: 1, muted: false, mute_end: null }, create_timestamp: '2026-11-12T08:00:00.000Z', message_count: 4 });
    const post = await p.cmd('b', { kind: 'about', target: 'conversation', id: POST });
    expect(post.result.channel).toMatchObject({ member: null, applied_tags: ['901'], flags: 2 });
    c.emit('CONNECTION_OPEN', {});
    const snap = p.posted.find((m) => m.t === 'snapshot').data;
    expect(snap.threads.map((t: any) => t.id)).toEqual([THREAD]);
    const forum = snap.channels.find((x: any) => x.id === FORUM);
    expect(forum).toMatchObject({ available_tags: [{ id: '900', name: 'Solved', emoji_name: '✅', moderated: true }, { id: '901', name: 'Bug', moderated: false }], default_sort_order: 1, default_forum_layout: 2, flags: 16 });
  });

  test("following asks Join Thread's request; unfollowing runs the client's own Leave", async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('f', { kind: 'followThread', channelId: POST, follow: true });
    expect(c.calls.find((x) => x[0] === 'post')).toEqual(['post', `/channels/${POST}/thread-members/@me`, undefined, { location: 'Thread Browser' }]);
    expect(r).toMatchObject({ ok: true, result: { channel: { id: POST, member: { flags: 1 } } } });
    const l = await p.cmd('l', { kind: 'followThread', channelId: THREAD, follow: false });
    expect(c.calls.find((x) => x[0] === 'leaveThread')).toEqual(['leaveThread', THREAD, 'Thread Browser']);
    expect(l.result.channel.member).toBeNull();
  });

  test('notifications: the bell menu\'s flags (keeping "has interacted") and a mute with its end', async () => {
    const c = client();
    const p = page(c);
    await p.cmd('n', { kind: 'threadNotify', channelId: THREAD, notify: 'mentions' });
    expect(c.calls.find((x) => x[0] === 'setNotificationSettings')).toEqual(['setNotificationSettings', THREAD, { flags: 1 | 4 }]);
    const until = Date.parse('2026-11-13T08:00:00.000Z');
    const r = await p.cmd('m', { kind: 'threadNotify', channelId: THREAD, muted: true, until });
    expect(c.calls.filter((x) => x[0] === 'setNotificationSettings')[1][2]).toEqual({ muted: true, mute_config: { end_time: '2026-11-13T08:00:00.000Z' } });
    expect(r.result.channel.member).toMatchObject({ muted: true, mute_end: '2026-11-13T08:00:00.000Z' });
  });

  test("archive, unarchive, lock: the client's own thread actions", async () => {
    const c = client();
    const p = page(c);
    await p.cmd('s', { kind: 'threadState', channelId: THREAD, locked: true, archived: true });
    expect(c.calls.filter((x) => ['lockThread', 'archiveThread'].includes(x[0]))).toEqual([['lockThread', THREAD], ['archiveThread', THREAD, false]]);
    const r = await p.cmd('u', { kind: 'threadState', channelId: THREAD, archived: false });
    expect(c.calls.find((x) => x[0] === 'unarchiveThread')).toEqual(['unarchiveThread', THREAD]);
    expect(r.result.channel.thread_metadata).toEqual({ archived: false, locked: true });
  });

  test('a thread from a message, in a channel, and a private one: the body its thread form posts', async () => {
    const c = client();
    c.answers[`post /channels/${CHAN}/messages/700/threads`] = { id: '510', type: 11, parent_id: CHAN, guild_id: GUILD, name: 'From it' };
    c.answers[`post /channels/${NEWS}/threads`] = { id: '511', type: 10, parent_id: NEWS, guild_id: GUILD, name: 'News talk' };
    const p = page(c);
    const r = await p.cmd('t', { kind: 'createThread', channelId: CHAN, messageId: '700', name: 'From it', nonce: '1' });
    expect(c.calls.find((x) => x[1] === `/channels/${CHAN}/messages/700/threads`)).toEqual(['post', `/channels/${CHAN}/messages/700/threads`, { name: 'From it', type: 11, auto_archive_duration: 1440 }, undefined]);
    expect(r.result.channel).toMatchObject({ id: '510', parent_id: CHAN });
    await p.cmd('n', { kind: 'createThread', channelId: NEWS, name: 'News talk', nonce: '2' });
    expect(c.calls.find((x) => x[1] === `/channels/${NEWS}/threads`)[2]).toEqual({ name: 'News talk', type: 10, auto_archive_duration: 4320 });
    // Discord's answer here names no thread, which is an error rather than a guess.
    const priv = await p.cmd('p', { kind: 'createThread', channelId: CHAN, name: 'Secret', private: true, nonce: '3' });
    expect(c.calls.filter((x) => x[1] === `/channels/${CHAN}/threads`).pop()[2].type).toBe(12);
    expect(priv.error).toMatch(/did not say which thread/);
  });

  test('a forum post: name, tags and first message in one request, as its New Post form sends it', async () => {
    const c = client();
    c.answers[`post /channels/${FORUM}/threads`] = { id: '520', type: 11, parent_id: FORUM, guild_id: GUILD, name: 'Help', applied_tags: ['901'], message: { id: '520', channel_id: '520', author: { id: ME, username: 'me' }, content: 'it broke', timestamp: '2026-11-12T09:00:00.000Z', type: 0 } };
    const p = page(c);
    const r = await p.cmd('p', { kind: 'createPost', channelId: FORUM, name: 'Help', content: 'it broke', tags: ['901'] });
    expect(c.calls.find((x) => x[1] === `/channels/${FORUM}/threads`)).toEqual(['post', `/channels/${FORUM}/threads`, { name: 'Help', auto_archive_duration: 4320, applied_tags: ['901'], message: { content: 'it broke', sticker_ids: [] } }, { use_nested_fields: true }]);
    expect(r.result).toMatchObject({ channel: { id: '520', applied_tags: ['901'] }, message: { id: '520', content: 'it broke' } });
    expect((await p.cmd('x', { kind: 'createPost', channelId: CHAN, name: 'no', content: 'x', tags: [] })).error).toMatch(/not a forum/);
  });

  test('publishing: the request the Publish button makes', async () => {
    const c = client();
    const p = page(c);
    await p.cmd('c', { kind: 'crosspost', channelId: NEWS, messageId: '800' });
    expect(c.calls.find((x) => x[0] === 'post')).toEqual(['post', `/channels/${NEWS}/messages/800/crosspost`, undefined, undefined]);
  });

  test('group DMs: leave silently, close a DM, remove someone, hand it over, change its picture', async () => {
    const c = client();
    const p = page(c);
    await p.cmd('l', { kind: 'leaveGroupDM', channelId: GROUP, silent: true });
    expect(c.calls.find((x) => x[0] === 'del')).toEqual(['del', `/channels/${GROUP}`, undefined, { silent: true }]);
    await p.cmd('d', { kind: 'leaveGroupDM', channelId: DM });
    expect(c.calls.filter((x) => x[0] === 'del')[1]).toEqual(['del', `/channels/${DM}`, undefined, undefined]);
    const rm = await p.cmd('r', { kind: 'groupMember', channelId: GROUP, userId: BOB, op: 'remove' });
    expect(c.calls.find((x) => x[0] === 'removeRecipient')).toEqual(['removeRecipient', GROUP, BOB]);
    expect(rm.ok).toBe(true);
    await p.cmd('o', { kind: 'groupMember', channelId: GROUP, userId: ALICE, op: 'owner' });
    expect(c.calls.find((x) => x[0] === 'setDMOwner')).toEqual(['setDMOwner', GROUP, ALICE]);
    await p.cmd('i', { kind: 'groupIcon', channelId: GROUP, dataUrl: 'data:image/png;base64,AAAA' });
    expect(c.calls.find((x) => x[0] === 'patch')).toEqual(['patch', `/channels/${GROUP}`, { icon: 'data:image/png;base64,AAAA' }, undefined]);
    expect((await p.cmd('j', { kind: 'groupIcon', channelId: GROUP, dataUrl: 'javascript:1' })).error).toMatch(/PNG/);
    expect((await p.cmd('k', { kind: 'groupMember', channelId: DM, userId: ALICE, op: 'remove' })).error).toMatch(/group DM/);
  });

  test("a channel's private archived threads: the thread browser's Private tab, paged by archive time", async () => {
    const c = client();
    c.answers[`get /channels/${CHAN}/users/@me/threads/archived/private`] = { threads: [{ id: '530', type: 12, parent_id: CHAN, guild_id: GUILD, name: 'old', thread_metadata: { archived: true, archive_timestamp: '2026-10-01T00:00:00.000Z' } }], has_more: true };
    const p = page(c);
    const r = await p.cmd('m', { kind: 'threads', channelId: CHAN, archived: true, offset: 0, mine: true });
    expect(r.result).toMatchObject({ threads: [{ id: '530' }], more: true });
    await p.cmd('n', { kind: 'threads', channelId: CHAN, archived: true, offset: 1, mine: true });
    expect(c.calls.filter((x) => x[0] === 'get').pop()[3]).toEqual({ limit: 50, before: '2026-10-01T00:00:00.000Z' });
  });

  test("a page of threads brings each one's first message, as the forum view shows it", async () => {
    const c = client();
    c.answers[`get /channels/${FORUM}/threads/search`] = { threads: [{ id: POST, type: 11, parent_id: FORUM }], has_more: false, first_messages: [{ id: POST, channel_id: POST, author: { id: ALICE, username: 'alice' }, content: 'first!', timestamp: '2026-11-12T09:00:00.000Z', type: 0 }] };
    const p = page(c);
    const r = await p.cmd('s', { kind: 'threads', channelId: FORUM, archived: false, offset: 0 });
    expect(r.result.messages).toMatchObject([{ id: POST, content: 'first!' }]);
  });

  test("only this account's own membership is relayed, never other people's", () => {
    const c = client();
    const p = page(c);
    c.emit('THREAD_MEMBERS_UPDATE', { id: THREAD, guildId: GUILD, addedMembers: [{ userId: ALICE }], removedMemberIds: [BOB] });
    expect(p.dispatched('THREAD_MEMBERS_UPDATE')).toEqual([]);
    c.emit('THREAD_MEMBERS_UPDATE', { id: THREAD, guildId: GUILD, addedMembers: [{ userId: ME }] });
    expect(p.dispatched('THREAD_MEMBERS_UPDATE')[0].channels[0]).toMatchObject({ id: THREAD, member: { flags: 1 } });
    c.emit('THREAD_MEMBER_UPDATE', { id: THREAD, guildId: GUILD, userId: ALICE });
    c.emit('THREAD_MEMBER_UPDATE', { id: THREAD, guildId: GUILD, userId: ME });
    expect(p.dispatched('THREAD_MEMBER_UPDATE')).toHaveLength(1);
    c.emit('LOAD_FORUM_POSTS', { guildId: GUILD, threads: { [POST]: { first_message: { id: POST, channel_id: POST, author: { id: ALICE, username: 'alice' }, content: 'hello', timestamp: '2026-11-12T09:00:00.000Z', type: 0 } } } });
    expect(p.dispatched('LOAD_FORUM_POSTS')[0]).toMatchObject({ messages: [{ id: POST, content: 'hello' }] });
  });
});
