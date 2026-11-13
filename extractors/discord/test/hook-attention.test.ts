/**
 * hook.js's attention section (mentions, notification settings, message requests, unread by hand, many read) against
 * a small replica of the client: one rspack runtime with the stores and action modules it looks for, under mangled
 * export names. The harness is hook.test.ts's, cut down to one runtime.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-attention-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const DM = '600000000000000005';
const ALICE = '400000000000000001';

/** The client as far as these tests go: what each module and store holds, and what was asked of them. */
function client() {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  const settings: any[] = [{ guildId: GUILD, muted: false, messageNotifications: 1, suppressEveryone: true, channelOverrides: [] }];
  const channels: Record<string, any> = {
    [CHAN]: { id: CHAN, type: 0, guild_id: GUILD, name: 'beginners' },
    [DM]: { id: DM, type: 1, recipients: [ALICE], isMessageRequest: true, isMessageRequestTimestamp: '2026-11-12T08:00:00.000Z', isSpam: false },
  };
  const dispatcher = {
    dispatch: (a: any) => {
      calls.push(['dispatch', a]);
      if (a.type === 'BULK_ACK') a.onFinished?.();
    },
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = async (o: any) => (calls.push([k, o.url, o.body ?? o.query]), { body: k === 'get' ? [] : {} });
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: '100000000000000001', username: 'me' }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null, getMutablePrivateChannels: () => ({ [DM]: channels[DM] }) });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: { id: GUILD, name: 'Rust' } }), getGuild: (id: string) => (id === GUILD ? { id: GUILD, name: 'Rust' } : null) });
    e.E = store('UserGuildSettingsStore', { getAllSettings: () => ({ userGuildSettings: settings }) });
    e.F = store('GuildChannelStore', { getChannels: () => ({ SELECTABLE: [{ channel: channels[CHAN] }] }) });
    e.G = store('ReadStateStore', { getAllReadStates: () => [] });
    e.H = rest;
    e.I = { fetchRecentMentions: (o: any) => void calls.push(['fetchRecentMentions', o]), deleteRecentMention() {} };
    e.J = {
      updateGuildNotificationSettings: (g: string, s: any) => {
        calls.push(['guildSettings', g, s]);
        settings[0] = { ...settings[0], muted: s.muted };
      },
      updateChannelOverrideSettings: (o: any) => {
        calls.push(['channelSettings', o]);
        settings[0] = { ...settings[0], channelOverrides: [{ channelId: o.channelId, muted: o.settings.muted, muteConfig: o.settings.mute_config ? { endTime: o.settings.mute_config.end_time } : null }] };
      },
    };
  };
  return { handlers, calls, settings, channels, modules, emit: (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a)) };
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
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => timers.push(fn), () => {});
  // One rspack runtime, its chunk carrying the client's modules, run by the app's own code.
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => cache[id]!.exports;
  T.c = cache;
  const self = win;
  (self.webpackChunkdiscord_app = self.webpackChunkdiscord_app || []).push = function (this: any, chunkData: any) {
    const [, mods, run] = chunkData;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, T);
    }
    if (run) run(T);
  };
  self.webpackChunkdiscord_app.push([['700'], { client: c.modules }]);
  timers.splice(0).forEach((fn) => fn());
  const cmd = async (id: string, command: unknown) => {
    win.down({ t: 'cmd', id, cmd: command });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    return posted.find((m) => m.t === 'reply' && m.id === id);
  };
  return { posted, cmd };
}

describe("hook.js's attention section", () => {
  test('finds the action modules and subscribes to what it forwards', () => {
    const c = client();
    const p = page(c);
    const report = p.posted.filter((m) => m.t === 'finders').pop();
    expect(report?.results).toMatchObject({ RecentMentionsActions: true, NotificationSettingsActions: true });
    for (const ev of ['LOAD_RECENT_MENTIONS_SUCCESS', 'NOTIFICATION_CENTER_ITEM_CREATE', 'USER_GUILD_SETTINGS_CHANNEL_UPDATE', 'CHANNEL_MUTE_EXPIRED', 'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC']) expect(c.handlers.has(ev)).toBe(true);
  });

  test("recent mentions go through the client's own action, and its answer is forwarded with the channels", async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('m', { kind: 'recentMentions', limit: 25 })).toMatchObject({ ok: true, result: { via: 'actions' } });
    expect(c.calls.find((x) => x[0] === 'fetchRecentMentions')?.[1]).toEqual({ limit: 25, roles: true, everyone: true, guildId: null });
    expect(c.calls.filter((x) => x[0] === 'get')).toEqual([]);
    c.emit('LOAD_RECENT_MENTIONS_SUCCESS', { messages: [{ id: '9', channel_id: CHAN, author: { id: ALICE, username: 'alice' }, content: 'hi', timestamp: '2026-11-12T10:00:00.000Z' }] });
    const d = p.posted.find((m) => m.t === 'dispatch' && m.event === 'LOAD_RECENT_MENTIONS_SUCCESS');
    expect(d.data.messages[0]).toMatchObject({ id: '9', channel_id: CHAN });
    expect(d.data.channels).toEqual([expect.objectContaining({ id: CHAN, guild_id: GUILD })]);
  });

  test('a DM carries its request and spam flags', () => {
    const c = client();
    const p = page(c);
    c.emit('CHANNEL_CREATE', { channel: c.channels[DM] });
    const d = p.posted.find((m) => m.t === 'dispatch' && m.event === 'CHANNEL_CREATE');
    expect(d.data.channel).toMatchObject({ id: DM, is_message_request: true, is_message_request_timestamp: '2026-11-12T08:00:00.000Z', is_spam: false });
  });

  test("a settings change sends the server's settings as the store has them, what it suppresses, and its channels", () => {
    const c = client();
    const p = page(c);
    c.emit('USER_GUILD_SETTINGS_CHANNEL_UPDATE', { guildId: GUILD, channelId: CHAN });
    const d = p.posted.find((m) => m.t === 'dispatch' && m.event === 'USER_GUILD_SETTINGS_CHANNEL_UPDATE');
    expect(d.data.changes[0]).toMatchObject({ guildId: GUILD, settings: { guild_id: GUILD, message_notifications: 1, suppress_everyone: true }, channels: [expect.objectContaining({ id: CHAN })], guild: { id: GUILD } });
  });

  test("mute goes through the client's notification settings action, with its timer, and answers the settings after", async () => {
    const c = client();
    const p = page(c);
    const until = Date.now() + 60 * 60_000;
    const r = await p.cmd('u', { kind: 'mute', target: 'conversation', id: CHAN, muted: true, until });
    expect(r).toMatchObject({ ok: true, result: { guildId: GUILD, settings: { channel_overrides: [{ channel_id: CHAN, muted: true }] } } });
    const call = c.calls.find((x) => x[0] === 'channelSettings')[1];
    expect(call).toMatchObject({ guildId: GUILD, channelId: CHAN, settings: { muted: true, mute_config: { end_time: new Date(until).toISOString() } } });
    expect(call.settings.mute_config.selected_time_window).toBeGreaterThan(3500);
    expect(c.calls.filter((x) => x[0] === 'patch')).toEqual([]);
  });

  test('a message request answered: accepted through the REST helper while its lazy module is not loaded', async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('a', { kind: 'messageRequestAnswer', channelId: DM, answer: 'accept' })).toMatchObject({ ok: true });
    expect(c.calls.find((x) => x[0] === 'put')).toEqual(['put', `/channels/${DM}/recipients/@me`, { consent_status: 2 }]);
    expect(c.calls.find((x) => x[0] === 'dispatch' && x[1].type === 'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC')).toBeTruthy();
    expect(await p.cmd('b', { kind: 'messageRequestAnswer', channelId: DM, answer: 'decline' })).toMatchObject({ ok: true });
    expect(c.calls.filter((x) => x[0] === 'put').pop()).toEqual(['put', '/channels/recipients/@me/batch-reject', { channel_ids: [DM] }]);
    expect(await p.cmd('c', { kind: 'messageRequestAnswer', channelId: CHAN, answer: 'accept' })).toMatchObject({ ok: false, error: 'That request is not waiting any more' });
  });

  test("unread by hand is the client's manual ack; many read its BULK_ACK", async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('x', { kind: 'markUnread', channelId: CHAN, messageId: '700000000000000009' })).toMatchObject({ ok: true });
    expect(c.calls.find((x) => x[0] === 'post')).toEqual(['post', `/channels/${CHAN}/messages/700000000000000009/ack`, { manual: true, mention_count: 0 }]);
    expect(await p.cmd('y', { kind: 'markReadMany', items: [{ channelId: CHAN, messageId: '700000000000000010' }] })).toMatchObject({ ok: true, result: { marked: 1 } });
    expect(c.calls.find((x) => x[0] === 'dispatch' && x[1].type === 'BULK_ACK')[1]).toMatchObject({ channels: [{ channelId: CHAN, messageId: '700000000000000010', readStateType: 0 }], context: 'APP' });
  });

  test('the gateway saying a channel was marked unread passes manual on', () => {
    const c = client();
    const p = page(c);
    c.emit('MESSAGE_ACK', { channelId: CHAN, messageId: '5', manual: true, newMentionCount: 2 });
    expect(p.posted.find((m) => m.t === 'dispatch' && m.event === 'MESSAGE_ACK').data).toEqual({ channelId: CHAN, messageId: '5', mentionCount: 2, manual: true });
  });
});
