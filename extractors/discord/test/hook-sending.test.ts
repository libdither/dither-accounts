/**
 * hook.js's sending extras (silent and no-ping sends, previews off, saved messages and reminders, Discord's own
 * scheduled messages, the emoji picker's order) against a small replica of the client: one rspack runtime with the
 * stores and action modules it looks for, under mangled export names. The functions it finds by their code are made
 * with the minified text the real ones have (Bun would reformat a function written here). The harness is
 * hook-attention.test.ts's.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-sending-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const MSG = '500000000000000050';

/** A function with exactly this minified text, closed over `env`. */
const minified = (params: string, body: string, env: Record<string, unknown>) => new Function(...Object.keys(env), `return function(${params}){${body}}`)(...Object.values(env));

function client(opts: { gate?: boolean; held?: boolean } = {}) {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  const saved: any[] = [];
  let fetchState = 'LOADED_HAS_MORE';
  const dispatcher = {
    dispatch: (a: any) => void calls.push(['dispatch', a]),
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del'])
    rest[k] = async (o: any) => {
      calls.push([k, o.url, o.body ?? o.query]);
      if (k === 'get' && o.url === '/users/@me/scheduled-messages')
        return { body: [{ id: '900000000000000001', channel_id: CHAN, content: 'later!', scheduled_timestamp: '2026-11-20T09:00:00.000Z', flags: 4096, message_reference: { message_id: MSG } }] };
      if (k === 'get') return { body: [{ id: MSG, flags: 4096 }] };
      return { body: {} };
    };
  const record = (channelId: string, messageId: string, dueAt?: string) => ({
    message: { id: messageId, channel_id: channelId, content: 'saved text', author: { id: '400000000000000001', username: 'ann' }, timestamp: '2026-11-10T10:00:00.000Z', type: 0 },
    saveData: { channelId, messageId, savedAt: new Date('2026-11-11T10:00:00.000Z'), ...(dueAt ? { dueAt: new Date(dueAt) } : {}), notes: null, authorSummary: 'ann' },
  });
  const env = {
    calls,
    saved,
    record,
    setState: (s: string) => (fetchState = s),
    R: { getConfig: () => ({ enabled: !!opts.gate }) },
    E: { can: () => true },
    T: { xBc: { SEND_MESSAGES: 2048 } },
  };
  // The client's save, remove and Saved-list fetch module (four exports), as in build 2026-11-12.
  const savedActions = {
    oN: minified('e', 'calls.push(["put",e]);let t={url:"PUT_SAVED_MESSAGE",body:{due_at:e.dueAt,source:e.source}};const r=record(e.channelId,e.messageId,e.dueAt);saved.push(r);return Promise.resolve(r)', env),
    cf: minified('e', 'calls.push(["del",e]);let u="DELETE_SAVED_MESSAGE";return Promise.resolve(!0)', env),
    AX: minified('', 'return Promise.resolve()', env),
    GY: minified('e', 'calls.push(["bookmarks",e]);let u="GET_BOOKMARKS",d="BOOKMARKS_FETCH_SUCCESS";setState("LOADED_FINISHED");return Promise.resolve()', env),
  };
  const scheduledActions = {
    Eg: minified('e', 'return Promise.resolve()', env),
    fK: minified('e', 'return Promise.resolve()', env),
    mk: minified('e', 'calls.push(["cancel",e]);let a="SCHEDULED_MESSAGES_DELETE_START";return Promise.resolve()', env),
    pr: minified('e', 'return Promise.resolve()', env),
    sy: minified('', 'return Promise.resolve()', env),
  };
  const gateModule = {
    Sc: minified('', 'return useConfig({location:"useCanUseScheduledMessages"}).enabled', env),
    kJ: minified('e,t', 'return!!R.getConfig({location:t}).enabled&&(!!e.isPrivate()||E.can(T.xBc.SEND_MESSAGES,e))', env),
    ZG: minified('e', 'return 1', env),
  };
  const messages = new Map<string, any>(opts.held === false ? [] : [[MSG, { id: MSG, flags: 4096 }]]);
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: '100000000000000001', username: 'me', premiumType: 2 }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => (id === CHAN ? { id: CHAN, type: 0, guild_id: GUILD } : null), getMutablePrivateChannels: () => ({}) });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: { id: GUILD, name: 'Rust' } }), getGuild: (id: string) => (id === GUILD ? { id: GUILD, name: 'Rust' } : null) });
    e.E = rest;
    e.F = {
      sendMessage: (...a: any[]) => (calls.push(['sendMessage', ...a]), Promise.resolve({ body: { id: '77' } })),
      editMessage() {},
    };
    e.G = store('MessageStore', { getMessage: (_c: string, id: string) => messages.get(id) ?? null });
    e.H = store('SavedMessagesStore', { getSavedMessages: () => saved, getBookmarksFetchState: () => fetchState });
    e.I = savedActions;
    e.J = scheduledActions;
    e.K = gateModule;
    e.L = store('TopEmojiStore', { getTopEmojiIdsByGuildId: (g: string) => (g === GUILD ? ['3', '1'] : undefined) });
    e.M = store('EmojiStore', {
      getGuilds: () => ({ [GUILD]: {} }),
      getGuildEmoji: () => [
        { id: '1', name: 'one', guildId: GUILD },
        { id: '2', name: 'two', guildId: GUILD },
        { id: '3', name: 'three', guildId: GUILD },
      ],
    });
  };
  return { handlers, calls, saved, modules, emit: (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a)), record };
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

describe("hook.js's sending extras", () => {
  test('finds its modules by their code and subscribes to what it forwards', () => {
    const c = client();
    const p = page(c);
    const report = p.posted.filter((m) => m.t === 'finders').pop();
    expect(report?.results).toMatchObject({ SavedMessagesStore: true, SavedMessageActions: true, ScheduledMessageActions: true, ScheduledMessageGate: true, TopEmojiStore: true });
    for (const ev of ['SAVED_MESSAGES_UPDATE', 'SAVED_MESSAGE_CREATE', 'SAVED_MESSAGE_DELETE', 'MESSAGE_REMINDER_DUE']) expect(c.handlers.has(ev)).toBe(true);
  });

  test("silent and no-ping are the client's own send options; a plain send has neither", async () => {
    const c = client();
    const p = page(c);
    await p.cmd('s1', { kind: 'send', channelId: CHAN, content: 'shh', replyTo: MSG, nonce: 'n1', silent: true, mentionReplied: false });
    const sent = c.calls.filter((x) => x[0] === 'sendMessage');
    expect(sent[0][4]).toEqual({ nonce: 'n1', messageReference: { channel_id: CHAN, message_id: MSG }, flags: 4096, allowedMentions: { parse: ['users', 'roles', 'everyone'], replied_user: false } });
    await p.cmd('s2', { kind: 'send', channelId: CHAN, content: 'loud', replyTo: MSG, nonce: 'n2', mentionReplied: true });
    expect(c.calls.filter((x) => x[0] === 'sendMessage')[1][4]).toEqual({ nonce: 'n2', messageReference: { channel_id: CHAN, message_id: MSG } });
    // No-ping without a reply means nothing.
    await p.cmd('s3', { kind: 'send', channelId: CHAN, content: 'x', nonce: 'n3', mentionReplied: false });
    expect(c.calls.filter((x) => x[0] === 'sendMessage')[2][4]).toEqual({ nonce: 'n3' });
  });

  test('previews off: the patch its Remove embeds sends, keeping the flags the message has', async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('e', { kind: 'suppressEmbeds', channelId: CHAN, messageId: MSG })).toMatchObject({ ok: true });
    expect(c.calls.filter((x) => x[0] !== 'dispatch')).toEqual([['patch', `/channels/${CHAN}/messages/${MSG}`, { flags: 4096 | 4 }]]);
  });

  test('previews off a message the client has not loaded: read it as a jump does, then the same patch', async () => {
    const c = client({ held: false });
    const p = page(c);
    expect(await p.cmd('e', { kind: 'suppressEmbeds', channelId: CHAN, messageId: MSG })).toMatchObject({ ok: true });
    expect(c.calls.filter((x) => x[0] !== 'dispatch')).toEqual([
      ['get', `/channels/${CHAN}/messages`, { around: MSG, limit: 1 }],
      ['patch', `/channels/${CHAN}/messages/${MSG}`, { flags: 4096 | 4 }],
    ]);
  });

  test("save with a reminder and remove go through the client's own functions", async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('sv', { kind: 'save', channelId: CHAN, messageId: MSG, dueAt: '2026-11-13T09:00:00.000Z' });
    expect(c.calls.find((x) => x[0] === 'put')?.[1]).toEqual({ channelId: CHAN, messageId: MSG, dueAt: '2026-11-13T09:00:00.000Z' });
    expect(r.result).toMatchObject({ channel_id: CHAN, message_id: MSG, saved_at: '2026-11-11T10:00:00.000Z', due_at: '2026-11-13T09:00:00.000Z', author_summary: 'ann', message: { id: MSG } });
    expect(await p.cmd('rm', { kind: 'save', channelId: CHAN, messageId: MSG, remove: true })).toMatchObject({ ok: true, result: {} });
    expect(c.calls.find((x) => x[0] === 'del')?.[1]).toEqual({ channelId: CHAN, messageId: MSG });
    // Never a request of its own.
    expect(c.calls.filter((x) => ['get', 'put', 'post', 'patch', 'del'].includes(x[0]) && typeof x[1] === 'string')).toEqual([]);
  });

  test("the Saved list: its own fetch (the next page when asked), then what its store holds", async () => {
    const c = client();
    const p = page(c);
    c.saved.push(c.record(CHAN, MSG));
    const r = await p.cmd('l', { kind: 'savedList', more: true });
    expect(c.calls.find((x) => x[0] === 'bookmarks')?.[1]).toEqual({ loadMore: true });
    expect(r.result.more).toBe(false);
    expect(r.result.saved).toEqual([expect.objectContaining({ channel_id: CHAN, message_id: MSG, due_at: null })]);
  });

  test('saved messages and reminders as the client hears them are forwarded shrunk', () => {
    const c = client();
    const p = page(c);
    c.emit('SAVED_MESSAGES_UPDATE', { reminders: [c.record(CHAN, MSG, '2026-11-13T09:00:00.000Z')], bookmarkIds: ['1'], messages: [] });
    c.emit('SAVED_MESSAGE_DELETE', { savedMessageData: { channelId: CHAN, messageId: MSG } });
    c.emit('MESSAGE_REMINDER_DUE', { savedMessage: c.record(CHAN, MSG, '2026-11-13T09:00:00.000Z') });
    const d = (ev: string) => p.posted.find((m) => m.t === 'dispatch' && m.event === ev)?.data;
    expect(d('SAVED_MESSAGES_UPDATE').saved).toEqual([expect.objectContaining({ message_id: MSG, due_at: '2026-11-13T09:00:00.000Z' })]);
    expect(d('SAVED_MESSAGE_DELETE')).toEqual({ channel_id: CHAN, message_id: MSG });
    expect(d('MESSAGE_REMINDER_DUE').saved).toMatchObject({ message_id: MSG, message: { id: MSG } });
  });

  test("Discord's own scheduled messages: nothing asked while its gate is off", async () => {
    const c = client({ gate: false });
    const p = page(c);
    expect((await p.cmd('n', { kind: 'nativeScheduled' })).result).toEqual({ enabled: false, scheduled: [] });
    expect(c.calls.filter((x) => x[0] === 'get')).toEqual([]);
  });

  test('with it on: the request its Scheduled list makes, and its own cancel', async () => {
    const c = client({ gate: true });
    const p = page(c);
    const r = await p.cmd('n', { kind: 'nativeScheduled' });
    expect(r.result).toEqual({ enabled: true, scheduled: [{ id: '900000000000000001', channel_id: CHAN, content: 'later!', scheduled_timestamp: '2026-11-20T09:00:00.000Z', flags: 4096, message_reference: { message_id: MSG } }] });
    expect(await p.cmd('x', { kind: 'cancelScheduled', id: '900000000000000001' })).toMatchObject({ ok: true });
    expect(c.calls.find((x) => x[0] === 'cancel')?.[1]).toBe('900000000000000001');
  });

  test("a server's emoji come in its picker's order: most used first, the rest as they were", async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('rc', { kind: 'reactionContext', channelId: CHAN });
    expect(r.result.custom[0].emoji.map((e: any) => e.id)).toEqual(['3', '1', '2']);
  });
});
