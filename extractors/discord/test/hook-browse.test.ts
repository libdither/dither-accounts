/**
 * hook.js's reading like a person (browse): a channel opened with the client's own navigation, its newest page as
 * opening it loads it, older pages by the client's scroll-up loader, nothing marked read, and the page given back.
 *
 * The replica client acks like the real one (ReadStateStore's shouldAutomaticallyAck, read 2026-11-14): a channel
 * whose message list registered it for automatic acks (ENABLE_AUTOMATIC_ACK) in a window with focus is acked as soon as
 * it is open with unread messages. So a registration that got past the hook shows up as a moved read state. The
 * dispatcher runs interceptors before anyone sees an action, as Discord's does.
 *
 * Timers run a thousand times faster than asked (minutes in tenths of a second), so the page's going back is seen.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { historyBefore, oldestId, pageDone } from '../src/search.ts';

const KEY = 'discord-hook-browse-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const ME = '100000000000000001';
const ALICE = '400000000000000001';
const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const OTHER = '300000000000000300';
const VOICE = '300000000000000400';
const DM = '600000000000000005';
const WINDOW = 'DISCORD_MAIN';

/** Message ids a channel has, newest last: base + i. */
const ids = (channel: string, n: number) => Array.from({ length: n }, (_, i) => (BigInt(channel) * 1000n + BigInt(i)).toString());
const raw = (channel: string, id: string) => ({ id, channel_id: channel, type: 0, content: `m${id}`, author: { id: ALICE, username: 'alice' }, timestamp: new Date(Date.UTC(2026, 0, 1) + Number(BigInt(id) % 1000n) * 60_000).toISOString() });

function client(opts: { unread?: string[] } = {}) {
  const calls: any[] = [];
  const subs = new Map<string, Set<(a: any) => void>>();
  const interceptors: ((a: any) => boolean)[] = [];
  let selected: string | null = null;
  const loc = { origin: 'https://discord.com', href: 'https://discord.com/channels/@me', pathname: '/channels/@me', reload() {} };
  // Read states: what was acked, and what is unread.
  const acked: Record<string, string | null> = { [CHAN]: '1', [OTHER]: '1', [DM]: '1' };
  const unread = new Set(opts.unread ?? [CHAN, OTHER, DM]);
  const autoAck = new Map<string, Set<string>>();
  const history: Record<string, string[]> = { [CHAN]: ids(CHAN, 180), [OTHER]: ids(OTHER, 30), [DM]: ids(DM, 10) };
  const loaded = new Set<string>();
  const channels: Record<string, any> = {
    [CHAN]: { id: CHAN, type: 0, guild_id: GUILD, name: 'general' },
    [OTHER]: { id: OTHER, type: 0, guild_id: GUILD, name: 'random' },
    [VOICE]: { id: VOICE, type: 2, guild_id: GUILD, name: 'Voice' },
    [DM]: { id: DM, type: 1, recipients: [ALICE] },
  };

  /** The client's own ack on view: registered, focused, open, unread. */
  const maybeAck = (channel: string) => {
    if (selected === channel && autoAck.get(channel)?.size && unread.has(channel)) {
      acked[channel] = history[channel].at(-1)!;
      unread.delete(channel);
      calls.push(['ack', channel]);
    }
  };
  const dispatcher: any = {
    _interceptors: interceptors,
    addInterceptor: (f: (a: any) => boolean) => void interceptors.push(f),
    subscribe: (ev: string, fn: (a: any) => void) => void (subs.get(ev) ?? subs.set(ev, new Set()).get(ev)!).add(fn),
    unsubscribe: (ev: string, fn: (a: any) => void) => void subs.get(ev)?.delete(fn),
    isDispatching: () => false,
    dispatch(a: any) {
      calls.push(['dispatch', a.type, a.channelId ?? null]);
      for (const f of interceptors) if (f(a)) return false;
      // ReadStateStore's handlers.
      if (a.type === 'ENABLE_AUTOMATIC_ACK') {
        (autoAck.get(a.channelId) ?? autoAck.set(a.channelId, new Set()).get(a.channelId)!).add(a.windowId);
        maybeAck(a.channelId);
      }
      if (a.type === 'DISABLE_AUTOMATIC_ACK') autoAck.get(a.channelId)?.delete(a.windowId);
      for (const fn of subs.get(a.type) ?? []) fn(a);
    },
  };
  /** The message list mounting: it registers the channel for automatic acks, as the client's does. */
  const mount = (channel: string) => dispatcher.dispatch({ type: 'ENABLE_AUTOMATIC_ACK', channelId: channel, windowId: WINDOW });
  const loadPage = (channel: string, before?: string) => {
    const all = history[channel];
    const below = before ? all.filter((id) => BigInt(id) < BigInt(before)) : all;
    const page = below.slice(-50);
    calls.push(['GET', `/channels/${channel}/messages`, { before, limit: 50 }]);
    return page.reverse().map((id) => raw(channel, id));
  };
  // transitionTo, under a mangled name, its source carrying the client's own log line.
  function transitionTo(path: string, _o?: unknown) {
    calls.push(['log', `transitionTo - Transitioning to ${path}`]);
    calls.push(['transitionTo', path]);
    loc.pathname = path;
    const m = path.match(/^\/channels\/[^/]+\/(\d+)$/);
    selected = m ? m[1] : null;
    if (!selected) return;
    const channel = selected;
    // Soon after (the hook's own waits run a thousand times faster, so this is soon for it too).
    setTimeout(() => {
      if (!loaded.has(channel)) {
        loaded.add(channel);
        // As MessageManager's initial fetch: a jump with how to scroll, and no message.
        // Fewer than a scroll loads (seen: 10 on the live client), and whether there are more, as the client says.
        const page = loadPage(channel).slice(0, 10);
        dispatcher.dispatch({ type: 'LOAD_MESSAGES_SUCCESS', channelId: channel, messages: page, isBefore: false, isAfter: false, limit: 10, hasMoreBefore: history[channel].length > 10, jump: { jumpType: 'ANIMATED' } });
      }
      mount(channel);
    }, 1);
  }
  const messageActions = {
    sendMessage() {},
    editMessage() {},
    fetchMessages(o: { channelId: string; before?: string; limit: number; truncate?: boolean }) {
      calls.push(['fetchMessages', o]);
      return new Promise((r) =>
        setTimeout(() => {
          const page = loadPage(o.channelId, o.before);
          dispatcher.dispatch({ type: 'LOAD_MESSAGES_SUCCESS', channelId: o.channelId, messages: page, before: o.before, isBefore: o.before != null, isAfter: false, limit: o.limit, hasMoreBefore: page.length === o.limit, truncate: o.truncate });
          r(true);
        }, 1),
      );
    },
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del'])
    rest[k] = async (o: any) => {
      calls.push([k.toUpperCase(), o.url, o.query]);
      return { body: [] };
    };
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: ME, username: 'me' }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null, getMutablePrivateChannels: () => ({ [DM]: channels[DM] }) });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: { id: GUILD, name: 'Rust' } }), getGuild: (id: string) => (id === GUILD ? { id: GUILD, name: 'Rust' } : null) });
    e.E = store('SelectedChannelStore', { getChannelId: () => selected, getVoiceChannelId: () => null });
    e.F = store('MessageStore', { getMessages: (id: string) => ({ ready: loaded.has(id), loadingMore: false }) });
    e.G = store('ReadStateStore', {
      ackMessageId: (id: string) => acked[id] ?? null,
      getChannelIdsForWindowId: (w: string) => [...autoAck].filter(([, ws]) => ws.has(w)).map(([c]) => c),
      getAllReadStates: () => [],
    });
    e.H = store('WindowStore', { getFocusedWindowId: () => WINDOW, isFocused: () => true });
    e.I = rest;
    e.J = messageActions;
    e.K = { EL() {}, JK() {}, MX() {}, PR() {}, xY: transitionTo };
  };
  /** Read on another device: Discord tells this session (MESSAGE_ACK) and its read state moves. */
  const readElsewhere = (channel: string, id: string) => {
    acked[channel] = id;
    dispatcher.dispatch({ type: 'MESSAGE_ACK', channelId: channel, messageId: id });
  };
  return { calls, acked, unread, autoAck, loc, modules, readElsewhere, selected: () => selected, open: (c: string) => transitionTo(`/channels/${GUILD}/${c}`) };
}

function page(c: ReturnType<typeof client>) {
  const posted: any[] = [];
  const events = new EventTarget();
  const listeners: Record<string, ((e: any) => void)[]> = {};
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ??= []).push(fn);
      events.addEventListener(type, fn);
    },
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
    down: (payload: any) => events.dispatchEvent(new CustomEvent(DOWN, { detail: payload })),
  };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const session = { getItem: () => null, setItem() {} };
  // A thousand times faster than asked.
  const fast = (fn: () => void, ms?: number) => setTimeout(fn, Math.max(0, (ms ?? 0) / 1000));
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', HOOK)(win, doc, c.loc, { webdriver: false }, session, fast, () => 0, () => {}, clearTimeout);
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
  let n = 0;
  const cmd = async (command: unknown) => {
    const id = `c${n++}`;
    win.down({ t: 'cmd', id, cmd: command });
    for (let i = 0; i < 400; i++) {
      const r = posted.find((m) => m.t === 'reply' && m.id === id);
      if (r) return r;
      await Bun.sleep(5);
    }
    throw new Error(`no reply to ${JSON.stringify(command)}`);
  };
  /** Someone clicks, types or scrolls in the live view. */
  const input = (type = 'pointerdown') => (listeners[type] ?? []).forEach((fn) => fn({ isTrusted: true, type }));
  return { posted, cmd, input, logs: () => posted.filter((m) => m.t === 'log') };
}

async function ready(p: ReturnType<typeof page>) {
  for (let i = 0; i < 200 && !p.posted.some((m) => m.t === 'finders' && m.results.Router); i++) await Bun.sleep(5);
  return p.posted.filter((m) => m.t === 'finders').pop()?.results;
}

describe("hook.js's reading like a person", () => {
  test('finds the router by its log line and the window store', async () => {
    const p = page(client());
    expect(await ready(p)).toMatchObject({ Router: true, WindowStore: true, MessageActions: true, SelectedChannelStore: true });
  });

  test('opens the channel, takes the page opening it loaded, then older pages by the scroll loader; nothing marked read', async () => {
    const c = client();
    const p = page(c);
    await ready(p);
    const first = await p.cmd({ kind: 'browse', channelId: CHAN });
    expect(first.ok).toBe(true);
    expect(c.calls.filter((x) => x[0] === 'transitionTo')).toEqual([['transitionTo', `/channels/${GUILD}/${CHAN}`]]);
    expect(first.result.opened).toBe(true);
    // Opening it loaded 10, with more before them: not the start of the channel.
    expect(first.result.messages.length).toBe(10);
    expect(first.result.more).toBe(true);
    // The newest page came from opening it: no loader call, one request with no `before`.
    expect(c.calls.filter((x) => x[0] === 'fetchMessages')).toEqual([]);
    expect(c.calls.filter((x) => x[0] === 'GET')).toEqual([['GET', `/channels/${CHAN}/messages`, { before: undefined, limit: 50 }]]);
    // The list registered the channel for automatic acks: held back, so the open, unread channel was not acked.
    expect(c.calls.some((x) => x[0] === 'dispatch' && x[1] === 'ENABLE_AUTOMATIC_ACK')).toBe(true);
    expect(c.autoAck.get(CHAN)?.size ?? 0).toBe(0);
    expect(c.calls.filter((x) => x[0] === 'ack')).toEqual([]);
    expect(c.acked[CHAN]).toBe('1');

    const oldest = oldestId(first.result.messages)!;
    const second = await p.cmd({ kind: 'browse', channelId: CHAN, beforeId: oldest });
    expect(c.calls.filter((x) => x[0] === 'fetchMessages').map((x) => x[1])).toEqual([{ channelId: CHAN, before: oldest, limit: 50, truncate: true }]);
    expect(second.result.messages.length).toBe(50);
    expect(second.result.more).toBe(true);
    expect(second.result.opened).toBe(false);
    expect(BigInt(oldestId(second.result.messages)!) < BigInt(oldest)).toBe(true);
    // Not opened again; still nothing acked.
    expect(c.calls.filter((x) => x[0] === 'transitionTo').length).toBe(1);
    expect(c.acked[CHAN]).toBe('1');
  });

  test('a DM opens under @me; moving to another channel opens it, and a few minutes after the last page the page goes back', async () => {
    const c = client();
    const p = page(c);
    await ready(p);
    await p.cmd({ kind: 'browse', channelId: DM });
    expect(c.calls.filter((x) => x[0] === 'transitionTo').pop()).toEqual(['transitionTo', `/channels/@me/${DM}`]);
    await p.cmd({ kind: 'browse', channelId: OTHER });
    expect(c.calls.filter((x) => x[0] === 'transitionTo').pop()).toEqual(['transitionTo', `/channels/${GUILD}/${OTHER}`]);
    expect(c.acked[DM]).toBe('1');
    expect(c.acked[OTHER]).toBe('1');
    // Two to five minutes later (here, a thousandth of that): back where it was before reading.
    for (let i = 0; i < 100 && c.selected() !== null; i++) await Bun.sleep(5);
    expect(c.calls.filter((x) => x[0] === 'transitionTo').pop()).toEqual(['transitionTo', '/channels/@me']);
  });

  test('input while a channel is open for reading hands the page over: nothing held, no going back', async () => {
    const c = client();
    const p = page(c);
    await ready(p);
    await p.cmd({ kind: 'browse', channelId: CHAN });
    p.input('pointerdown');
    // The list registers again (it does when you scroll it): the client's own acks go through now.
    c.open(CHAN);
    for (let i = 0; i < 50 && !c.calls.some((x) => x[0] === 'ack'); i++) await Bun.sleep(5);
    expect(c.calls.filter((x) => x[0] === 'ack')).toEqual([['ack', CHAN]]);
    await Bun.sleep(400);
    expect(c.calls.filter((x) => x[0] === 'transitionTo').pop()).toEqual(['transitionTo', `/channels/${GUILD}/${CHAN}`]);
  });

  test('a channel registered before it was read is unregistered first', async () => {
    const c = client({ unread: [] });
    const p = page(c);
    await ready(p);
    // The page sits on the channel already, its list registered.
    c.open(CHAN);
    for (let i = 0; i < 50 && !c.autoAck.get(CHAN)?.size; i++) await Bun.sleep(5);
    expect(c.autoAck.get(CHAN)?.size).toBe(1);
    c.unread.add(CHAN);
    const r = await p.cmd({ kind: 'browse', channelId: CHAN, beforeId: ids(CHAN, 180)[100] });
    expect(r.ok).toBe(true);
    expect(c.calls.some((x) => x[0] === 'dispatch' && x[1] === 'DISABLE_AUTOMATIC_ACK' && x[2] === CHAN)).toBe(true);
    expect(c.autoAck.get(CHAN)?.size ?? 0).toBe(0);
    expect(c.acked[CHAN]).toBe('1');
  });

  test('yields to you in the live view; never opens a voice channel', async () => {
    const c = client();
    const p = page(c);
    await ready(p);
    p.input('keydown');
    const r = await p.cmd({ kind: 'browse', channelId: CHAN });
    expect(r.result.defer).toBeGreaterThan(10 * 60_000);
    expect(r.result.why).toMatch(/live view/);
    expect(c.calls.filter((x) => x[0] === 'transitionTo')).toEqual([]);

    const c2 = client();
    const p2 = page(c2);
    await ready(p2);
    const v = await p2.cmd({ kind: 'browse', channelId: VOICE });
    expect(v.result.plain).toMatch(/voice/);
    expect(c2.calls.filter((x) => x[0] === 'transitionTo')).toEqual([]);
  });

  test('a read state that moves anyway turns reading this way off; read on another device, it carries on', async () => {
    const c = client();
    const p = page(c);
    await ready(p);
    await p.cmd({ kind: 'browse', channelId: CHAN });
    // You read it on your phone meanwhile.
    c.readElsewhere(CHAN, '500');
    await Bun.sleep(5);
    const fine = await p.cmd({ kind: 'browse', channelId: CHAN, beforeId: ids(CHAN, 180)[130] });
    expect(fine.result.messages.length).toBe(50);
    expect(p.logs().some((l) => l.level === 'warn')).toBe(false);
    // Something marks it read while it is open.
    c.acked[CHAN] = '999';
    const r = await p.cmd({ kind: 'browse', channelId: CHAN, beforeId: ids(CHAN, 180)[120] });
    expect(r.ok).toBe(true);
    expect(p.logs().some((l) => l.level === 'warn' && /read state moved/.test(l.msg))).toBe(true);
    const after = await p.cmd({ kind: 'browse', channelId: OTHER });
    expect(after.result.plain).toMatch(/marked a channel read/);
  });
});

describe('where a page goes back from', () => {
  const now = Date.UTC(2026, 10, 14);
  test("the hub's cursor when it gave one; none for a read page from the top; else the time as an id", () => {
    expect(historyBefore({ cursor: '300000000000000200123', beforeTs: now - 3_600_000, pace: 'read' }, now)).toBe('300000000000000200123');
    expect(historyBefore({ beforeTs: now + 1, pace: 'read' }, now)).toBeUndefined();
    expect(historyBefore({ cursor: 'not an id', beforeTs: now + 1, pace: 'read' }, now)).toBeUndefined();
    const t = historyBefore({ beforeTs: now - 3_600_000 }, now)!;
    expect((BigInt(t) >> 22n) + 1420070400000n).toBe(BigInt(now - 3_600_000));
    // A plain (not read) page from the top keeps its time.
    expect(historyBefore({ beforeTs: now + 1 }, now)).toBeDefined();
    expect(oldestId([{ id: '300000000000000200150' }, { id: '300000000000000200099' }, { id: 'x' }])).toBe('300000000000000200099');
  });

  test('the start of the channel: as the client says when it said, else a short page', () => {
    // Opening a channel loaded 10 with more before them (seen live): not the start.
    expect(pageDone(10, 50, true)).toBe(false);
    expect(pageDone(10, 50, false)).toBe(true);
    expect(pageDone(0, 50, true)).toBe(true);
    expect(pageDone(10, 50)).toBe(true);
    expect(pageDone(50, 50, null)).toBe(false);
  });
});
