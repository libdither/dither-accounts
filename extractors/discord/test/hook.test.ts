/**
 * hook.js against a replica of Discord's bundle layout: several rspack runtimes
 * sharing window.webpackChunkdiscord_app, each wrapping the push before it, and
 * chunk scripts that re-assign the global before every push. The runtime tail
 * below has the same shape as Discord's minified code (rspack 1.7).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { configurePlan, mapAbout, UNSURE } from '../src/about.ts';
import { addCapabilities, answerOutcome, friendOutcome, invitePreview, joinOutcome, relationshipEvents, removeOutcome, snapshotRelationships, snapshotRequests, SPAM_WARNING, STRANGER_WARNING } from '../src/add.ts';
import { addedFacts, newState, translateDispatch } from '../src/ingest.ts';
import { mapProfile } from '../src/profile.ts';

/** The hook as the sandbox copies it: what every hook shares put in, its placeholders made into names under a key. */
const KEY = 'discord-hook-test-marker-key';
/** The channel's event types (packages/browser/src/page): the hook says `up`, content.js says `down`. */
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

function page(pathname = '/app') {
  const posted: any[] = [];
  const timers: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const store = new Map<string, string>();
  // The page's window, as far as the hook's channel goes; content.js's end answers its hello and keeps what it says.
  const events = new EventTarget();
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => events.addEventListener(type, fn),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
    /** What comes down from the extension to the hook (it handles it in a microtask). */
    down: (payload: any) => events.dispatchEvent(new CustomEvent(DOWN, { detail: payload })),
  };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: `https://discord.com${pathname}`, pathname, reload() {} };
  const session = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const runHook = () =>
    new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(
      win,
      doc,
      loc,
      { webdriver: false },
      session,
      (fn: () => void) => timers.push(fn),
      (fn: () => void) => intervals.push(fn),
    );
  /** Run the timers queued so far (not the ones they queue). */
  const tick = () => timers.splice(0).forEach((fn) => fn());
  /** The page-state poll, as setInterval would run it. */
  const poll = () => intervals.forEach((fn) => fn());
  return { win, doc, posted, runHook, tick, poll };
}

/** One rspack runtime: the jsonp callback and push install, as in Discord's bundles. */
function runtime(self: any, entryChunk: string) {
  const modules: Record<string, (m: any, e: any, r: any) => void> = {};
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => {
    if (cache[id]) return cache[id].exports;
    const m = (cache[id] = { exports: {} });
    modules[id](m, m.exports, T);
    return m.exports;
  };
  T.m = modules;
  T.c = cache;
  T.o = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
  T.O = (result: unknown) => result;
  const A: Record<PropertyKey, any> = { [entryChunk]: 0 };
  const h = (e: any, t: any) => {
    let n: string;
    let i: PropertyKey;
    let o: unknown;
    let l = 0;
    const [r, a, s] = t;
    if (r.some((x: PropertyKey) => A[x] !== 0)) {
      for (n in a) if (T.o(a, n)) T.m[n] = a[n];
      if (s) o = s(T);
    }
    for (e && e(t); l < r.length; l++) {
      i = r[l];
      if (T.o(A, i) && A[i]) A[i][0]();
      A[i] = 0;
    }
    return T.O(o);
  };
  (function (this: any) {
    let f: any;
    (f = this.webpackChunkdiscord_app = this.webpackChunkdiscord_app || []).forEach(h.bind(null, 0)), (f.push = h.bind(null, f.push.bind(f)));
  }).call(self);
  /** Simulates __webpack_require__.e: the chunk is pending until its script pushes it. */
  const ensure = (id: string) => new Promise<void>((resolve, reject) => (A[id] = [resolve, reject]));
  return { T, A, ensure };
}

/** A chunk script: `(this.webpackChunkdiscord_app=this.webpackChunkdiscord_app||[]).push([[id],{...}])`. */
function chunk(self: any, id: string, mods: Record<string, (m: any, e: any, r: any) => void>) {
  (function (this: any) {
    (this.webpackChunkdiscord_app = this.webpackChunkdiscord_app || []).push([[id], mods]);
  }).call(self);
}

function store(name: string, extra: Record<string, unknown> = {}) {
  return { getName: () => name, emitChange() {}, ...extra };
}

const handlers = new Map<string, ((action: any) => void)[]>();
const dispatcher = {
  dispatch() {},
  subscribe: (ev: string, fn: (action: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
  unsubscribe() {},
  isDispatching: () => false,
  _subscriptions: {},
};
const emit = (ev: string, action: any = {}) => (handlers.get(ev) ?? []).forEach((fn) => fn(action));

let me: { id: string; username: string } | null = null;
const guildRecords = new Map<string, any>();
const channelStore: any = store('ChannelStore', { getChannel: () => null });
const userStoreGetUser: { value: (id: string) => unknown } = { value: () => null };
const userStoreUsers: { value: () => Record<string, unknown> } = { value: () => ({}) };
const rest: Record<string, any> = { get() {}, post() {}, put() {}, patch() {}, del() {} };
const messageActions = { sendMessage() {}, editMessage() {} };
const privateChannels: any = { opened: 0, openPrivateChannel() { this.opened++; } };
const typingCalls: string[] = [];
const typingModule: { value: any } = { value: { startTyping: (c: string) => typingCalls.push(`start ${c}`), stopTyping: (c: string) => typingCalls.push(`stop ${c}`) } };

// rspack mangles export names: the stores sit under short keys, not `default`.
const storeModule = (_m: any, e: any) => {
  Object.defineProperty(e, 'A', { enumerable: true, get: () => dispatcher });
  Object.defineProperty(e, 'Ay', { enumerable: true, get: () => store('UserStore', { getCurrentUser: () => me, getUser: (id: string) => userStoreGetUser.value(id), getUsers: () => userStoreUsers.value() }) });
  e.Bk = channelStore;
  // With guild records set (the about tests), only those exist, as in the real store.
  e.Cx = store('GuildStore', { getGuilds: () => ({}), getGuild: (id: string) => (guildRecords.size ? guildRecords.get(id) : { id, name: `Guild ${id}` }) });
  e.Bo = rest;
  e.Dm = messageActions;
  e.Pc = privateChannels;
  Object.defineProperty(e, 'Ty', { enumerable: true, get: () => typingModule.value });
};

// An i18n message bundle in the real client: answers every key with a function.
const intlBundle = (_m: any, e: any) => {
  const lookups: unknown[] = [];
  e.default = new Proxy({}, { get: (_t, key) => (arg: unknown) => void lookups.push([key, arg]) });
};

describe('hook.js with several rspack runtimes', () => {
  test('lazy chunks still reach every runtime', async () => {
    const p = page();
    p.runHook();
    chunk(p.win, '533077', { m533077: () => {} }); // a deferred chunk that runs before any runtime
    const libdiscore = runtime(p.win, 'libdiscore');
    chunk(p.win, '935812', { m935812: () => {} });
    const fastConnect = runtime(p.win, 'fast-connect');
    const sentry = runtime(p.win, 'sentry');
    const web = runtime(p.win, 'web');

    const pending = web.ensure('240406');
    chunk(p.win, '240406', { m240406: () => {} });
    await pending; // never settles when the push chain is broken

    for (const rt of [libdiscore, fastConnect, sentry, web]) {
      expect(rt.A['240406']).toBe(0);
      expect(rt.T.m.m240406).toBeDefined();
      expect(rt.T.m.m533077).toBeDefined();
    }
  });

  describe('typing', () => {
    const typingPage = () => {
      handlers.clear();
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', { stores: storeModule });
      web.T('stores');
      p.tick();
      return p;
    };
    const cmd = async (p: ReturnType<typeof page>, id: string, c: unknown) => {
      p.win.down({ t: 'cmd', id, cmd: c });
      await Bun.sleep(0);
      return p.posted.find((m) => m.t === 'reply' && m.id === id);
    };

    test("goes through the client's own typing action, never a request of ours", async () => {
      const p = typingPage();
      typingCalls.length = 0;
      const requests: string[] = [];
      for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = (...a: any[]) => void requests.push(k + JSON.stringify(a));
      expect(await cmd(p, 't1', { kind: 'typing', channelId: '42' })).toMatchObject({ ok: true, result: { via: 'actions' } });
      expect(await cmd(p, 't2', { kind: 'typing', channelId: '42', stop: true })).toMatchObject({ ok: true });
      expect(typingCalls).toEqual(['start 42', 'stop 42']);
      expect(requests).toEqual([]);
    });

    test('without that module, the action it would dispatch', async () => {
      const saved = typingModule.value;
      typingModule.value = null;
      const dispatched: any[] = [];
      const before = dispatcher.dispatch;
      dispatcher.dispatch = ((a: any) => void dispatched.push(a)) as any;
      try {
        const p = typingPage();
        expect(await cmd(p, 't3', { kind: 'typing', channelId: '42' })).toMatchObject({ ok: true, result: { via: 'dispatch' } });
        await cmd(p, 't4', { kind: 'typing', channelId: '42', stop: true });
        expect(dispatched).toEqual([{ type: 'TYPING_START_LOCAL', channelId: '42' }, { type: 'TYPING_STOP_LOCAL', channelId: '42' }]);
      } finally {
        typingModule.value = saved;
        dispatcher.dispatch = before;
      }
    });

    test('someone typing comes with a name to show', () => {
      const p = typingPage();
      userStoreGetUser.value = (id: string) => ({ id, username: `user${id}`, globalName: 'Five' });
      emit('TYPING_START', { channelId: 'c', userId: '5' });
      const d = p.posted.find((x) => x.t === 'dispatch' && x.event === 'TYPING_START');
      expect(d.data).toEqual({ channelId: 'c', userId: '5', user: expect.objectContaining({ id: '5', username: 'user5', global_name: 'Five' }), nick: null });
    });
  });

  test('finds the stores under mangled export names and subscribes', () => {
    const p = page();
    p.runHook();
    runtime(p.win, 'libdiscore');
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores'); // the app's own code runs the module
    p.tick(); // resolveTick
    const report = p.posted.find((m) => m.t === 'finders');
    expect(report?.results).toMatchObject({ Dispatcher: true, UserStore: true, ChannelStore: true, GuildStore: true });
    expect(report.detail).toContain('runtimes=2');
    expect(handlers.has('MESSAGE_CREATE')).toBe(true);
  });

  test('is not fooled by a Proxy that answers every key', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { i18n: intlBundle, stores: storeModule });
    web.T('i18n'); // ahead of the real modules, as in the real client
    web.T('stores');
    p.tick();
    expect(handlers.has('MESSAGE_CREATE')).toBe(true);
    // Commands reach the real REST and message modules, not the bundle.
    const calls: string[] = [];
    rest.get = () => {
      calls.push('rest');
      return { body: [] } as any;
    };
    const sent = p.posted.length;
    p.win.down({ t: 'cmd', id: 'x', cmd: { kind: 'history', channelId: '1' } });
    await Bun.sleep(0);
    expect(calls).toEqual(['rest']);
    expect(p.posted.slice(sent).find((m) => m.t === 'reply')).toMatchObject({ id: 'x', ok: true, result: { messages: [] } });
  });

  test('reports a REST rejection with its message and retry_after', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    rest.get = () => Promise.reject({ status: 429, body: { message: 'You are being rate limited.', retry_after: 2.5 } }) as any;
    p.win.down({ t: 'cmd', id: 'y', cmd: { kind: 'history', channelId: '1' } });
    await Bun.sleep(0);
    expect(p.posted.find((m) => m.t === 'reply')).toMatchObject({ ok: false, error: 'You are being rate limited. (429)', retryAfter: 2.5 });
  });

  test('sends without waiting for the channel to load, with a raw reply reference', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    const calls: any[][] = [];
    messageActions.sendMessage = ((...args: any[]) => {
      calls.push(args);
      return Promise.resolve({ body: { id: '77' } });
    }) as any;
    p.win.down({ t: 'cmd', id: 's', cmd: { kind: 'send', channelId: '5', content: 'hi', replyTo: '4', nonce: 'n1' } });
    await Bun.sleep(0);
    expect(calls[0][2]).toBe(false); // true or undefined hangs until the channel is on screen
    expect(calls[0][3]).toEqual({ nonce: 'n1', messageReference: { channel_id: '5', message_id: '4' } });
    expect(p.posted.find((m) => m.t === 'reply')).toMatchObject({ id: 's', ok: true, result: { nativeId: '77' } });
  });

  describe('opening a DM', () => {
    const open = async (userId = '42') => {
      handlers.clear();
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', { stores: storeModule });
      web.T('stores');
      p.tick();
      p.win.down({ t: 'cmd', id: 'o', cmd: { kind: 'openDirect', userId } });
      await Bun.sleep(0);
      return p.posted.find((m) => m.t === 'reply');
    };
    afterEach(() => {
      delete channelStore.getDMFromUserId;
      delete privateChannels.ensurePrivateChannel;
      channelStore.getChannel = () => null;
      rest.post = () => {};
    });

    test('one the client already has costs no request', async () => {
      let posted = 0;
      rest.post = (() => void posted++) as any;
      channelStore.getDMFromUserId = () => '9';
      channelStore.getChannel = (id: string) => ({ id, type: 1, recipients: [{ id: '42', username: 'ann' }] });
      expect(await open()).toMatchObject({ ok: true, result: { channelId: '9', existed: true, channel: { id: '9', recipients: [{ id: '42' }] } } });
      expect(posted).toBe(0);
    });

    test("goes through the client's own action, and never its navigating one", async () => {
      const seen: string[] = [];
      privateChannels.ensurePrivateChannel = async (u: string) => (seen.push(u), '10');
      channelStore.getChannel = (id: string) => ({ id, type: 1, recipients: [] });
      expect(await open()).toMatchObject({ ok: true, result: { channelId: '10', existed: false } });
      expect(seen).toEqual(['42']);
      expect(privateChannels.opened).toBe(0);
    });

    test('falls back to the REST client, and passes a refusal on', async () => {
      const bodies: any[] = [];
      rest.post = ((o: any) => (bodies.push(o), Promise.resolve({ body: { id: '11', type: 1, recipients: [{ id: '42', username: 'ann' }] } }))) as any;
      expect(await open()).toMatchObject({ ok: true, result: { channelId: '11', existed: false, channel: { recipients: [{ username: 'ann' }] } } });
      expect(bodies[0]).toMatchObject({ url: '/users/@me/channels', body: { recipients: ['42'] } });
      rest.post = (() => Promise.reject({ status: 400, body: { message: 'Cannot send messages to this user' } })) as any;
      expect(await open()).toMatchObject({ ok: false, error: 'Cannot send messages to this user (400)' });
    });
  });

  test('sends files the way the client does: upload URLs, PUT, then a message naming them', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    const posts: any[] = [];
    const realPost = rest.post;
    rest.post = async (req: any) => {
      posts.push(req);
      if (req.url.endsWith('/attachments')) return { body: { attachments: [{ id: '0', upload_url: 'https://storage.example/u', upload_filename: 'up/a.png' }] } };
      return { body: { id: '88' } };
    };
    const puts: { url: string; body: Uint8Array; type: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      puts.push({ url, body: init.body, type: init.headers['content-type'] });
      return { ok: true, status: 200 };
    }) as any;
    try {
      p.win.down({ t: 'cmd', id: 'f', cmd: { kind: 'send', channelId: '5', content: 'look', replyTo: '4', nonce: 'n2', files: [{ name: 'a.png', mime: 'image/png', size: 3, base64: btoa('abc') }] } });
      await Bun.sleep(5);
    } finally {
      rest.post = realPost;
      globalThis.fetch = realFetch;
    }
    expect(posts[0]).toMatchObject({ url: '/channels/5/attachments', body: { files: [{ id: '0', filename: 'a.png', file_size: 3 }] } });
    expect(puts[0].url).toBe('https://storage.example/u');
    expect(new TextDecoder().decode(puts[0].body)).toBe('abc');
    expect(puts[0].type).toBe('image/png');
    expect(posts[1]).toMatchObject({
      url: '/channels/5/messages',
      body: { content: 'look', attachments: [{ id: '0', filename: 'a.png', uploaded_filename: 'up/a.png' }], message_reference: { channel_id: '5', message_id: '4' } },
    });
    expect(p.posted.find((m) => m.t === 'reply' && m.id === 'f')).toMatchObject({ ok: true, result: { nativeId: '88' } });
  });

  describe('stickers and voice messages', () => {
    const here = { id: '101', name: 'wave', format_type: 1, tags: '👋', guild_id: 'g1', available: true };
    const elsewhere = { id: '102', name: 'party', format_type: 3, tags: 'tada', guild_id: 'g2', available: true };
    const locked = { id: '103', name: 'boost', format_type: 1, guild_id: 'g1', available: false };
    const standard = { id: '201', name: 'hello', format_type: 1, tags: '😺', pack_id: 'p1' };
    const SENDABLE = 0;
    const PREMIUM = 1;
    // A stand-in for the client's own sendability rule: the same arguments, and the names its source carries.
    function rule(st: any, user: any, channel: any) {
      const nitro = { canUseCustomStickersEverywhere: (u: any) => !!u?.premiumType };
      const members = { getSelfMember: (g: string) => (g === 'g1' || g === 'g2' ? {} : null) };
      if (st.pack_id) return SENDABLE;
      if (!members.getSelfMember(st.guild_id)) return 2;
      if (!st.available) return 3;
      if (channel?.guild_id === st.guild_id) return SENDABLE;
      return nitro.canUseCustomStickersEverywhere(user) ? SENDABLE : PREMIUM;
    }
    const stickerPage = (withRule = true) => {
      handlers.clear();
      me = { id: '1', username: 'someone', premiumType: 0 } as any;
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        stickers: (_m: any, e: any) => {
          e.A = store('StickersStore', { getAllGuildStickers: () => new Map([['g2', [elsewhere]], ['g1', [here, locked]]]), getPremiumPacks: () => [{ id: 'p1', name: 'Wumpus', cover_sticker_id: '201', stickers: [standard] }] });
        },
        ...(withRule ? { rules: (_m: any, e: any) => ((e.Ux = { SENDABLE: 0 }), (e.W$ = rule)) } : {}),
      });
      web.T('stores');
      web.T('stickers');
      if (withRule) web.T('rules');
      p.tick();
      channelStore.getChannel = (id: string) => ({ id, guild_id: 'g1', type: 0 });
      return p;
    };
    const run = async (p: ReturnType<typeof page>, id: string, c: unknown) => {
      p.win.down({ t: 'cmd', id, cmd: c });
      await Bun.sleep(1);
      return p.posted.find((m) => m.t === 'reply' && m.id === id);
    };
    afterEach(() => {
      channelStore.getChannel = () => null;
      me = null;
    });

    test("lists what the client's own rule lets this account send: this server first, standard packs, nothing that needs Nitro", async () => {
      const p = stickerPage();
      const r = await run(p, 'st1', { kind: 'stickers', channelId: '5', offset: 0, limit: 8 });
      expect(r).toMatchObject({ ok: true });
      expect(r.result.packs).toEqual([
        { id: 'g1', name: 'Guild g1', source: 'server', stickers: [{ id: '101', name: 'wave', format_type: 1, tags: '👋' }] },
        { id: 'p1', name: 'Wumpus', source: 'standard', cover: '201', stickers: [{ id: '201', name: 'hello', format_type: 1, tags: '😺' }] },
      ]);
      expect(r.result).toMatchObject({ next: null, note: 'Stickers from other servers need Nitro.' });
      const one = await run(p, 'st2', { kind: 'stickers', channelId: '5', offset: 0, limit: 1 });
      expect(one.result.next).toBe(1);
      expect((await run(p, 'st3', { kind: 'stickers', channelId: '5', offset: 1, limit: 1 })).result.packs.map((x: any) => x.id)).toEqual(['p1']);
    });

    test("without the client's rule, only this server's own and the standard packs", async () => {
      const p = stickerPage(false);
      const r = await run(p, 'st4', { kind: 'stickers', channelId: '5', offset: 0, limit: 8 });
      expect(r.result.packs.map((x: any) => [x.id, x.stickers.map((y: any) => y.id)])).toEqual([
        ['g1', ['101']],
        ['p1', ['201']],
      ]);
    });

    test("a sticker goes through the client's own sendStickers", async () => {
      const p = stickerPage();
      const calls: any[][] = [];
      (messageActions as any).sendStickers = (...args: any[]) => (calls.push(args), Promise.resolve({ body: { id: '90' } }));
      try {
        const r = await run(p, 'st5', { kind: 'send', channelId: '5', content: '', nonce: 'n9', stickerIds: ['101'], replyTo: '4' });
        expect(r).toMatchObject({ ok: true, result: { nativeId: '90' } });
        expect(calls).toEqual([['5', ['101'], '', { nonce: 'n9', messageReference: { channel_id: '5', message_id: '4' } }]]);
      } finally {
        delete (messageActions as any).sendStickers;
      }
    });

    test('a voice message: the flag, no text, and its length and waveform on the uploaded file', async () => {
      const p = stickerPage();
      const posts: any[] = [];
      const realPost = rest.post;
      rest.post = async (req: any) => {
        posts.push(req);
        if (req.url.endsWith('/attachments')) return { body: { attachments: [{ id: '0', upload_url: 'https://storage.example/v', upload_filename: 'up/voice-message.ogg' }] } };
        return { body: { id: '91' } };
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({ ok: true, status: 200 })) as any;
      try {
        await run(p, 'v1', { kind: 'send', channelId: '5', content: 'ignored', nonce: 'n10', files: [{ name: 'voice-message.ogg', mime: 'audio/ogg', size: 3, base64: btoa('ogg') }], voice: { duration_secs: 2.5, waveform: 'AAEC' } });
        await Bun.sleep(5);
      } finally {
        rest.post = realPost;
        globalThis.fetch = realFetch;
      }
      expect(posts[1]).toMatchObject({ url: '/channels/5/messages', body: { content: '', flags: 8192, attachments: [{ id: '0', filename: 'voice-message.ogg', uploaded_filename: 'up/voice-message.ogg', duration_secs: 2.5, waveform: 'AAEC' }] } });
    });
  });

  describe('reacting', () => {
    const emojiA = { id: '1', name: 'here', animated: false, available: true, guildId: 'g1' };
    const emojiB = { id: '2', name: 'there', animated: true, available: true, guildId: 'g2' };
    const canPerm = { allow: true };
    const allowAll = { allow: true };

    /** A page with the emoji and permission modules loaded, and the client's own rule for usable emoji. */
    function reactingPage() {
      handlers.clear();
      me = { id: '1', username: 'someone', premiumType: 0 } as any;
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        emoji: (_m: any, e: any) => {
          e.a = store('EmojiStore', { getGuilds: () => ({ g2: {}, g1: {} }), getGuildEmoji: (g: string) => (g === 'g1' ? [emojiA] : [emojiB]) });
          e.b = store('PermissionStore', { can: (bit: bigint) => (bit === 1n << 6n ? canPerm.allow : allowAll.allow) });
          e.c = { getEmojiUnavailableReason: ({ emoji, channel }: any) => (emoji.guildId === channel?.guild_id ? null : 3) };
        },
      });
      web.T('stores');
      web.T('emoji');
      p.tick();
      return p;
    }
    const down = (p: ReturnType<typeof page>, cmd: any, id = 'r') => p.win.down({ t: 'cmd', id, cmd });
    const reply = (p: ReturnType<typeof page>, id = 'r') => p.posted.find((m) => m.t === 'reply' && m.id === id);

    test('a normal reaction and a super one take different routes', async () => {
      const p = reactingPage();
      const calls: any[] = [];
      for (const verb of ['put', 'del']) rest[verb] = (a: any) => (calls.push([verb, a.url, a.query]), Promise.resolve({ body: null, headers: () => {} }));
      down(p, { kind: 'react', channelId: 'c', messageId: 'm', emoji: 'party:7' }, 'a');
      down(p, { kind: 'react', channelId: 'c', messageId: 'm', emoji: '🎉', burst: true }, 'b');
      down(p, { kind: 'react', channelId: 'c', messageId: 'm', emoji: '🎉', burst: true, remove: true }, 'c');
      await Bun.sleep(0);
      expect(calls).toEqual([
        ['put', '/channels/c/messages/m/reactions/party%3A7/@me', { location: 'Message', type: 0 }],
        ['put', `/channels/c/messages/m/reactions/${encodeURIComponent('🎉')}/@me`, { location: 'Message', type: 1 }],
        ['del', `/channels/c/messages/m/reactions/${encodeURIComponent('🎉')}/1/@me`, { location: 'Message', burst: true }],
      ]);
      // Nothing that can't be posted across the window boundary comes back.
      expect(reply(p, 'a')).toMatchObject({ ok: true, result: { ok: true } });
    });

    test('names the people behind a total', async () => {
      const p = reactingPage();
      const seen: any[] = [];
      rest.get = (a: any) => (seen.push(a), Promise.resolve({ body: [{ id: '9', username: 'nine', email: 'never@forward.this' }] })) as any;
      down(p, { kind: 'reactors', channelId: 'c', messageId: 'm', emoji: '🎉', burst: true });
      await Bun.sleep(0);
      expect(seen[0].query).toEqual({ limit: 100, type: 1 });
      expect(reply(p).result.users[0]).toEqual({ id: '9', username: 'nine', global_name: null, discriminator: undefined, avatar: undefined, bot: false });
    });

    const channelIn = (guild: string | null) => ({ guild_id: guild, id: 'c' });

    test('offers what the client itself says is usable, this server first', async () => {
      const p = reactingPage();
      channelStore.getChannel = () => channelIn('g1');
      down(p, { kind: 'reactionContext', channelId: 'c' });
      await Bun.sleep(0);
      const ctx = reply(p).result;
      expect(ctx).toMatchObject({ canReact: true, existingOnly: false, nitro: false });
      expect(ctx.custom.map((g: any) => g.emoji.map((e: any) => e.name))).toEqual([['here']]);
    });

    test('Nitro, and a channel without Add Reactions', async () => {
      const p = reactingPage();
      me = { id: '1', username: 'someone', premiumType: 2 } as any;
      canPerm.allow = false;
      channelStore.getChannel = () => channelIn('g1');
      down(p, { kind: 'reactionContext', channelId: 'c' });
      await Bun.sleep(0);
      expect(reply(p).result).toMatchObject({ canReact: true, existingOnly: true, nitro: true });
      canPerm.allow = true;
    });

    test('direct messages have no permissions to check', async () => {
      const p = reactingPage();
      canPerm.allow = false;
      channelStore.getChannel = () => channelIn(null);
      down(p, { kind: 'reactionContext', channelId: 'c' });
      await Bun.sleep(0);
      expect(reply(p).result).toMatchObject({ canReact: true, existingOnly: false });
      canPerm.allow = true;
    });

    test('a gateway reaction carries its style, colours and who did it', () => {
      const p = reactingPage();
      userStoreGetUser.value = (id: string) => ({ id, username: `user${id}` });
      emit('MESSAGE_REACTION_ADD', { channelId: 'c', messageId: 'm', userId: '5', emoji: { id: '7', name: 'party', animated: true }, reactionType: 1, colors: ['#f00'] });
      const d = p.posted.find((x) => x.t === 'dispatch' && x.event === 'MESSAGE_REACTION_ADD');
      expect(d.data).toMatchObject({ reactionType: 1, colors: ['#f00'], emoji: { id: '7', name: 'party', animated: true }, user: { id: '5', username: 'user5' } });
    });
  });

  describe('about and settings', () => {
    const MANAGE_CHANNELS = 1n << 4n;
    const MANAGE_GUILD = 1n << 5n;
    const SEND = 1n << 11n;
    const guild = { id: '100', name: 'Test server', ownerId: '2', verificationLevel: 1, nsfwLevel: 0, features: new Set(['COMMUNITY']), description: 'About it', icon: null };
    // Unsorted, and in both colour forms the client has used.
    const roles = {
      '100': { id: '100', name: '@everyone', position: 0, color: 0 },
      '201': { id: '201', name: 'Helper', position: 1, color: 0x5c7cfa, hoist: false },
      '202': { id: '202', name: 'Mod', position: 2, colorString: '#e86a92', hoist: true },
    };
    const members = [
      { userId: '3', roles: ['201'], colorString: null, nick: 'never sent' },
      { userId: '2', roles: ['202'], colorString: '#e86a92' },
      { userId: '9', roles: [] }, // not in the user store: dropped
      { userId: '1', roles: [] },
    ];
    const channels: Record<string, any> = {
      '300': { id: '300', type: 0, guild_id: '100', parent_id: '400', name: 'general', topic: 'hello', nsfw: false, rateLimitPerUser: 10, permissionOverwrites: { '100': { id: '100', type: 0, allow: 0n, deny: SEND } } },
      '301': { id: '301', type: 0, guild_id: '100', parent_id: '400', name: 'open', topic: null, nsfw: true, rateLimitPerUser: 0, permissionOverwrites: {} },
      '400': { id: '400', type: 4, guild_id: '100', name: 'Text' },
      '500': { id: '500', type: 11, guild_id: '100', parent_id: '300', name: 'a thread', ownerId: '1', rateLimitPerUser: 0 },
      '600': { id: '600', type: 3, recipients: ['2', '3'], ownerId: '2', name: null },
      '700': { id: '700', type: 1, recipients: ['2'] },
    };
    /** Grants by subject id; 'absent' leaves the PermissionStore out, 'throws' makes its check throw. */
    let grants: Record<string, bigint[]> | 'absent' | 'throws' = {};

    function aboutPage() {
      handlers.clear();
      me = { id: '1', username: 'someone' };
      userStoreGetUser.value = (id: string) => (id === '9' ? undefined : { id, username: `user${id}`, email: 'never@forward.this' });
      guildRecords.clear();
      guildRecords.set('100', guild);
      channelStore.getChannel = (id: string) => channels[id];
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        about: (_m: any, e: any) => {
          e.r = store('GuildRoleStore', { getRoles: () => roles });
          e.m = store('GuildMemberStore', { getMembers: () => members, getNick: () => null });
          e.n = store('GuildMemberCountStore', { getMemberCount: () => 1200 });
          if (grants !== 'absent')
            e.p = store('PermissionStore', {
              can: (bit: bigint, subject: any) => {
                if (grants === 'throws') throw new Error('not ready');
                return ((grants as Record<string, bigint[]>)[subject.id] ?? []).includes(bit);
              },
            });
        },
      });
      web.T('stores');
      web.T('about');
      p.tick();
      return p;
    }
    let n = 0;
    async function ask(p: ReturnType<typeof page>, c: unknown) {
      const id = `a${n++}`;
      p.win.down({ t: 'cmd', id, cmd: c });
      await Bun.sleep(0);
      const r = p.posted.find((m) => m.t === 'reply' && m.id === id);
      // It crosses the window and a WebSocket: no BigInt, no Set, nothing that does not survive JSON.
      if (r?.ok) expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
      return r;
    }
    const aboutOf = async (target: 'conversation' | 'space', id: string) => {
      const r = await ask(aboutPage(), { kind: 'about', target, id });
      expect(r.ok).toBe(true);
      return { raw: r.result, about: mapAbout(r.result) };
    };
    afterEach(() => {
      grants = {};
      guildRecords.clear();
      channelStore.getChannel = () => null;
      userStoreGetUser.value = () => null;
      me = null;
    });

    test('a channel, with Manage Channels', async () => {
      grants = { '300': [MANAGE_CHANNELS, SEND] };
      const { raw, about } = await aboutOf('conversation', '300');
      expect(raw.channel).toMatchObject({ rate_limit_per_user: 10, nsfw: false, everyone_denies_send: true });
      expect(JSON.stringify(raw)).not.toContain('never');
      expect(about.noun).toBe('Channel');
      expect(about.fields).toMatchObject({
        name: { value: 'general', canEdit: true },
        topic: { value: 'hello', canEdit: true },
        slowMode: { value: 10, canEdit: true },
        nsfw: { value: false, canEdit: true },
        announceOnly: { value: true, canEdit: false, reason: "Change who can send in the channel's permissions, in Discord." },
      });
      expect(about.fields.avatar).toBeUndefined();
      expect(about.rules).toContainEqual({ what: 'Change the server', who: 'Manage Server', you: false });
      expect(about.rules).toContainEqual({ what: 'Send messages', who: 'Send Messages', you: true });
    });

    test('roles by position, members with their top role and colour, this account kept', async () => {
      const { about } = await aboutOf('conversation', '301');
      expect(about.roles).toEqual([
        { id: '202', name: 'Mod', rank: 2, color: '#e86a92' },
        { id: '201', name: 'Helper', rank: 1, color: '#5c7cfa' },
        { id: '100', name: '@everyone', rank: 0 },
      ]);
      expect(about.members).toEqual({
        list: [
          { id: '2', role: 'Mod', rank: 2, color: '#e86a92' },
          { id: '3', role: 'Helper', rank: 1, color: '#5c7cfa' },
          { id: '1', rank: 0 },
        ],
        total: 1200,
        complete: false,
      });
      expect(about.you).toEqual({ role: 'Member', rank: 0 });
      expect(about.fields.announceOnly).toMatchObject({ value: false });
    });

    test('fails closed: a refusal, no store, or a check that throws', async () => {
      grants = {};
      expect((await aboutOf('conversation', '300')).about.fields.name).toEqual({ value: 'general', canEdit: false, reason: 'You need the Manage Channels permission.' });
      grants = 'absent';
      const absent = (await aboutOf('conversation', '300')).about;
      expect(absent.fields.name).toEqual({ value: 'general', canEdit: false, reason: UNSURE });
      expect(absent.fields.announceOnly).toMatchObject({ canEdit: false, reason: UNSURE });
      expect(absent.rules!.every((r) => !r.you)).toBe(true);
      grants = 'throws';
      expect((await aboutOf('conversation', '300')).about.fields.slowMode).toEqual({ value: 10, canEdit: false, reason: UNSURE });
    });

    test('a thread its owner may rename, sending by its parent', async () => {
      const { about } = await aboutOf('conversation', '500');
      expect(about.noun).toBe('Thread');
      expect(about.fields.name).toEqual({ value: 'a thread', canEdit: true });
      expect(about.fields.topic).toBeUndefined();
      expect(about.fields.nsfw).toBeUndefined();
      expect(about.fields.announceOnly).toMatchObject({ value: true, canEdit: false });
    });

    test('a group DM: anyone renames, the owner removes', async () => {
      grants = 'absent';
      const { about } = await aboutOf('conversation', '600');
      expect(about.noun).toBe('Group');
      expect(about.fields.name).toEqual({ value: 'user2, user3', canEdit: true });
      expect(about.fields.avatar).toEqual({ value: null, canEdit: false, reason: 'Changing the picture is not supported yet.' });
      expect(about.members).toEqual({ list: [{ id: '1', rank: 0 }, { id: '2', role: 'Group owner', rank: 100 }, { id: '3', rank: 0 }], complete: true });
      expect(about.rules).toEqual([
        { what: 'Rename, change the icon, add people', who: 'Everyone in the group', you: true },
        { what: 'Remove people', who: 'The group owner', you: false },
      ]);
      expect(about.facts).toContainEqual({ label: 'Owner', value: 'user2' });
      expect(about.adding).toEqual({ can: true, reason: 'Only your friends, up to 10 people in all.', who: 'friends', mode: 'add', room: 7 });
    });

    test('a DM has nothing to change', async () => {
      grants = { '700': [MANAGE_CHANNELS] };
      const { about } = await aboutOf('conversation', '700');
      expect(about.noun).toBe('Direct message');
      expect(about.fields).toEqual({});
      expect(about.members).toEqual({ list: [{ id: '1', rank: 0 }, { id: '2', rank: 0 }], complete: true });
    });

    test('a server and a category', async () => {
      grants = { '100': [MANAGE_GUILD] };
      const server = (await aboutOf('space', '100')).about;
      expect(server.noun).toBe('Server');
      expect(server.fields).toMatchObject({
        name: { value: 'Test server', canEdit: true },
        // A Community server's description and its icon, with Manage Server.
        topic: { value: 'About it', canEdit: true },
        avatar: { value: null, canEdit: true },
        nsfw: { value: false, canEdit: false },
      });
      expect(server.facts).toEqual([
        { label: 'Verification level', value: 'Low: a verified email' },
        { label: 'Owner', value: 'user2' },
        { label: 'Created', value: '2015-01-01' },
      ]);
      const category = (await aboutOf('space', '400')).about;
      expect(category.noun).toBe('Category');
      expect(category.fields).toEqual({ name: { value: 'Text', canEdit: false, reason: 'You need the Manage Channels permission.' } });
      expect((await ask(aboutPage(), { kind: 'about', target: 'space', id: '300' })).ok).toBe(false);
    });

    test("configure sends one PATCH through the client's REST module, with only settings fields", async () => {
      const p = aboutPage();
      const calls: any[] = [];
      const realPatch = rest.patch;
      rest.patch = (req: any) => (calls.push(req), Promise.resolve({ body: req.url.startsWith('/guilds') ? { id: '100', name: req.body.name, owner_id: '2' } : { id: '300', type: 0, name: 'renamed', guild_id: '100', permission_overwrites: [] } }));
      try {
        const ch = await ask(p, { kind: 'configure', channelId: '300', patch: { name: 'renamed', rate_limit_per_user: 30, permission_overwrites: [], type: 5 } });
        expect(ch).toMatchObject({ ok: true, result: { channel: { id: '300', name: 'renamed', guild_id: '100' } } });
        const g = await ask(p, { kind: 'configure', guildId: '100', patch: { name: 'New name', description: 'Now offered', banner: 'not offered' } });
        expect(g).toMatchObject({ ok: true, result: { guild: { id: '100', name: 'New name' } } });
        expect((await ask(p, { kind: 'configure', channelId: '../users/@me', patch: { name: 'x' } })).ok).toBe(false);
        expect((await ask(p, { kind: 'configure', channelId: '300', patch: { icon: 'data:' } })).ok).toBe(false);
      } finally {
        rest.patch = realPatch;
      }
      expect(calls).toEqual([
        { url: '/channels/300', query: undefined, body: { name: 'renamed', rate_limit_per_user: 30 } },
        { url: '/guilds/100', query: undefined, body: { name: 'New name', description: 'Now offered' } },
      ]);
    });

    test('the adapter plans that PATCH from the same read', async () => {
      grants = { '300': [MANAGE_CHANNELS] };
      const { raw } = await aboutOf('conversation', '300');
      expect(configurePlan(raw, { key: 'slowMode', value: 30 })).toEqual({ channelId: '300', patch: { rate_limit_per_user: 30 } });
      grants = {};
      const locked = (await aboutOf('conversation', '300')).raw;
      expect(() => configurePlan(locked, { key: 'name', value: 'x' })).toThrow('You need the Manage Channels permission.');
    });
  });

  describe('profiles', () => {
    const WHO = '42';
    const calls: string[] = [];
    let fetchFails: unknown = null;
    // The body the server answers a profile with (snake_case), as the client's fetch receives it.
    const body = (id: string) => ({
      user: { id, username: 'ann', global_name: 'Ann', avatar: 'aa', banner: null },
      user_profile: { bio: 'hi there', pronouns: 'they/them', banner: 'bb', accent_color: 255 },
      connected_accounts: [
        { type: 'github', id: '1', name: 'ann-gh', verified: true, access_token: 'never forward this' },
        { type: 'contacts', id: '2', name: 'hidden by the client' },
      ],
      mutual_guilds: [{ id: '100', nick: 'Annie' }],
      mutual_friends: [{ id: '7', username: 'bo', global_name: null, email: 'never@forward.this' }],
      mutual_friends_count: 1,
      legacy_username: 'ann#0001',
    });
    // The client's profile store, filled by its fetch the way USER_PROFILE_FETCH_SUCCESS fills it.
    const profiles = new Map<string, any>();
    const supported = (t: string) => t !== 'contacts';
    const land = (b: ReturnType<typeof body>) =>
      profiles.set(b.user.id, {
        bio: b.user_profile.bio,
        pronouns: b.user_profile.pronouns,
        banner: b.user_profile.banner,
        accentColor: b.user_profile.accent_color,
        connectedAccounts: b.connected_accounts.filter((a) => supported(a.type)),
        legacyUsername: b.legacy_username,
        guilds: b.mutual_guilds.map((g) => ({ guild: guildRecords.get(g.id), nick: g.nick })),
        friends: b.mutual_friends.map((u) => ({ key: u.id, user: { ...u, globalName: u.global_name }, status: 'online' })),
      });
    const profileStore: any = store('UserProfileStore', {
      isFetchingProfile: () => false,
      getUserProfile: (id: string) => profiles.get(id),
      getMutualGuilds: (id: string) => profiles.get(id)?.guilds,
      getMutualFriends: (id: string) => profiles.get(id)?.friends,
      getMutualFriendsCount: (id: string) => profiles.get(id)?.friends?.length,
    });
    const dispatchLocal = (_a: unknown) => {};
    // As in the client: the fetch shares its module with the terms-of-service call, under mangled names.
    const fetchModule: any = {
      Q9() {
        calls.push('ACCEPTED THE TERMS');
      },
      async eO(id: string, o: any = {}, onBody?: (b: unknown) => void) {
        calls.push(`fetch ${id} ${JSON.stringify(o)}`);
        dispatchLocal({ type: "USER_PROFILE_FETCH_START", userId: id });
        if (fetchFails) throw fetchFails;
        const query = { type: o.type, with_mutual_guilds: o.withMutualGuilds, with_mutual_friends: o.withMutualFriends };
        void query;
        const b = body(id);
        onBody?.(b);
        land(b);
      },
    };
    // A click on someone runs this: it skips a profile fetched in the last minute, else it runs the fetch.
    function maybeFetchProfile(id: string, avatar: unknown, o: any = {}) {
      const { waitForRefetch = true, ...rest } = o;
      void waitForRefetch;
      if (profileStore.isFetchingProfile(id)) return Promise.resolve();
      calls.push(`open ${id} ${avatar}`);
      return fetchModule.eO(id, rest);
    }
    const platforms = {
      github: { name: 'GitHub', getPlatformUserUrl: (a: { name: string }) => `https://github.com/${a.name}` },
    };

    function profilePage(has: { open?: boolean; store?: boolean; fetch?: boolean; platforms?: boolean }, late = false) {
      handlers.clear();
      calls.length = 0;
      profiles.clear();
      me = { id: '1', username: 'someone' };
      const users: Record<string, any> = {
        [WHO]: { id: WHO, username: 'ann', globalName: 'Ann', avatar: 'aa', email: 'never@forward.this' },
        '7': { id: '7', username: 'bo' },
        '8': { id: '8', username: 'cy' },
      };
      userStoreGetUser.value = (id: string) => users[id];
      guildRecords.clear();
      guildRecords.set('100', { id: '100', name: 'Test server' });
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        people: (_m: any, e: any) => {
          e.r = store('RelationshipStore', {
            getRelationshipType: (id: string) => (id === WHO || id === '7' || id === '8' ? 1 : 0),
            getSince: (id: string) => (id === WHO ? '2020-02-02T00:00:00.000Z' : undefined),
            getFriendIDs: () => [WHO, '7', '8'],
          });
          e.s = store('PresenceStore', { getActivities: (id: string) => (id === WHO ? [{ type: 0, name: 'A game' }, { type: 4, name: 'Custom Status', state: 'busy', emoji: { name: '🔧' } }] : []) });
          e.m = store('GuildMemberStore', {
            getMember: (g: string, u: string) => (g === '100' && u === WHO ? { userId: WHO, nick: 'Annie', roles: ['201', '202'], joinedAt: '2023-04-05T06:07:08.000Z' } : null),
            getNick: () => null,
          });
          e.g = store('GuildRoleStore', {
            getRoles: () => ({
              '100': { id: '100', name: '@everyone', position: 0, color: 0 },
              '202': { id: '202', name: 'Mod', position: 2, colorString: '#e86a92' },
              '201': { id: '201', name: 'Helper', position: 1, color: 0x5c7cfa },
            }),
          });
        },
      });
      const profileChunk = () =>
        chunk(p.win, '701', {
          profile: (_m: any, e: any) => {
            if (has.store) e.p = profileStore;
            if (has.platforms) e.t = { get: (t: string) => (platforms as any)[t] ?? null, getByUrl() {}, isSupported: supported, map() {}, filter() {}, find() {} };
          },
          fetch: (_m: any, e: any) => {
            if (has.fetch) Object.assign(e, fetchModule);
          },
          open: (_m: any, e: any) => {
            if (has.open) e.A = maybeFetchProfile;
          },
        });
      web.T('stores');
      web.T('people');
      const load = () => {
        profileChunk();
        web.T('profile');
        web.T('fetch');
        web.T('open');
      };
      if (!late) load();
      p.tick();
      if (late) load(); // after the finders have looked
      return p;
    }
    let n = 0;
    async function ask(p: ReturnType<typeof page>, c: unknown) {
      const id = `p${n++}`;
      p.win.down({ t: 'cmd', id, cmd: c });
      for (let i = 0; i < 5; i++) await Bun.sleep(0);
      const r = p.posted.find((m) => m.t === 'reply' && m.id === id);
      if (r?.ok) expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
      return r;
    }
    afterEach(() => {
      fetchFails = null;
      guildRecords.clear();
      userStoreGetUser.value = () => null;
      rest.get = () => {};
      me = null;
    });

    test("opens it as a click does, then reads the client's stores", async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true, platforms: true }), { kind: 'profile', userId: WHO });
      expect(r.ok).toBe(true);
      expect(calls).toEqual(['open 42 undefined', 'fetch 42 {"type":"popout","withMutualGuilds":true,"withMutualFriends":true}']);
      expect(r.result).toMatchObject({
        selfId: '1',
        user: { id: WHO, username: 'ann', global_name: 'Ann', avatar: 'aa' },
        bio: 'hi there',
        pronouns: 'they/them',
        banner: 'bb',
        accent_color: 255,
        legacy_username: 'ann#0001',
        relationship: 1,
        friend_since: '2020-02-02T00:00:00.000Z',
        custom_status: { text: 'busy', emoji: { id: null, name: '🔧', animated: false } },
        mutual_friends_count: 1,
      });
      expect(r.result.connected_accounts).toEqual([{ type: 'github', id: '1', name: 'ann-gh', verified: true, label: 'GitHub', url: 'https://github.com/ann-gh' }]);
      expect(r.result.mutual_guilds).toEqual([
        {
          id: '100',
          name: 'Test server',
          nick: 'Annie',
          joined_at: '2023-04-05T06:07:08.000Z',
          roles: [
            { id: '201', name: 'Helper', color: '#5c7cfa', position: 1, hoist: false },
            { id: '202', name: 'Mod', color: '#e86a92', position: 2, hoist: false },
          ],
        },
      ]);
      expect(r.result.mutual_friends).toEqual([expect.objectContaining({ id: '7', username: 'bo', global_name: null })]);
      expect(r.result.friends).toBeUndefined();
      expect(r.result.error).toBeUndefined();
      expect(JSON.stringify(r.result)).not.toContain('never');

      const about = mapProfile(r.result, WHO);
      expect(about).toMatchObject({ displayName: 'Ann', banner: 'https://cdn.discordapp.com/banners/42/bb.webp?size=600', relationship: 'friend', status: { text: 'busy', emoji: '🔧' } });
      expect(about.mutualSpaces).toEqual([{ id: '100', nick: 'Annie', roles: [{ name: 'Mod', color: '#e86a92' }, { name: 'Helper', color: '#5c7cfa' }], joinedAt: Date.UTC(2023, 3, 5, 6, 7, 8) }]);
    });

    test('without the open, the fetch itself, never its neighbour; its body when there is no store', async () => {
      const r = await ask(profilePage({ fetch: true }), { kind: 'profile', userId: WHO });
      expect(r.ok).toBe(true);
      expect(calls).toEqual(['fetch 42 {"type":"popout","withMutualGuilds":true,"withMutualFriends":true}']);
      expect(r.result).toMatchObject({ bio: 'hi there', banner: 'bb', accent_color: 255, mutual_friends_count: 1 });
      expect(r.result.mutual_guilds).toMatchObject([{ id: '100', name: 'Test server', nick: 'Annie', roles: [{ name: 'Helper' }, { name: 'Mod' }] }]);
      // No table to ask: the platform's name and link come from the adapter, and nothing marks them as the client's.
      expect(r.result.connected_accounts).toEqual([
        { type: 'github', id: '1', name: 'ann-gh', verified: true },
        { type: 'contacts', id: '2', name: 'hidden by the client', verified: false },
      ]);
      expect(mapProfile(r.result, WHO).links).toEqual([{ label: 'GitHub', value: 'ann-gh', url: 'https://github.com/ann-gh', verified: true }]);
      expect(JSON.stringify(r.result)).not.toContain('never');
    });

    test("without either, the same request through the client's REST module", async () => {
      const seen: any[] = [];
      rest.get = (req: any) => (seen.push(req), Promise.resolve({ body: body(WHO) }));
      const r = await ask(profilePage({}), { kind: 'profile', userId: WHO });
      // Then your note on them, as the client's profile asks for it (self.test.ts).
      expect(seen).toEqual([{ url: '/users/42/profile', query: { type: 'popout', with_mutual_guilds: true, with_mutual_friends: true }, body: undefined }, { url: '/users/@me/notes/42', query: undefined, body: undefined }]);
      expect(r.result).toMatchObject({ bio: 'hi there', mutual_guilds: [{ id: '100', nick: 'Annie' }], mutual_friends: [{ id: '7' }] });
    });

    test("your own bio: one PATCH of your profile with only the bio, then your profile with the bio Discord answered", async () => {
      const seen: any[] = [];
      const realPatch = rest.patch;
      rest.patch = (req: any) => (seen.push(req), Promise.resolve({ body: { bio: req.body.bio, pronouns: 'they/them' } }));
      try {
        const p = profilePage({ open: true, store: true, fetch: true });
        const r = await ask(p, { kind: 'setProfile', bio: 'new bio 🧪' });
        expect(r.ok).toBe(true);
        expect(seen).toEqual([{ url: '/users/@me/profile', query: undefined, body: { bio: 'new bio 🧪' } }]);
        // The store still had the old one; the answer wins.
        expect(r.result).toMatchObject({ selfId: '1', bio: 'new bio 🧪' });
        expect(mapProfile(r.result, '1').bio).toBe('new bio 🧪');
        expect((await ask(p, { kind: 'setProfile' })).ok).toBe(false);
        expect(seen.length).toBe(1);
      } finally {
        rest.patch = realPatch;
      }
    });

    test('modules that load after the finders looked are still found', async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true }, true), { kind: 'profile', userId: WHO });
      expect(calls[0]).toBe('open 42 undefined');
      expect(r.result.bio).toBe('hi there');
    });

    test('a refused fetch answers with what the client has; a rate limit is passed on', async () => {
      fetchFails = { status: 403, body: { message: 'Missing Access', code: 50001 } };
      const r = await ask(profilePage({ fetch: true, store: true }), { kind: 'profile', userId: WHO });
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({ error: 'Missing Access (403)', user: { id: WHO, username: 'ann' }, relationship: 1, mutual_guilds: null, mutual_friends: null });
      expect(mapProfile(r.result, WHO)).toMatchObject({ displayName: 'Ann', relationship: 'friend' });

      fetchFails = { status: 429, body: { message: 'You are being rate limited.', retry_after: 3 } };
      expect(await ask(profilePage({ fetch: true, store: true }), { kind: 'profile', userId: WHO })).toMatchObject({ ok: false, error: 'You are being rate limited. (429)', retryAfter: 3 });
    });

    test('your own: no mutuals asked for, your friends listed', async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true }), { kind: 'profile', userId: '1' });
      expect(calls).toEqual(['open 1 undefined', 'fetch 1 {"type":"popout","withMutualGuilds":false,"withMutualFriends":false}']);
      expect(r.result.friends.map((u: any) => u.id)).toEqual([WHO, '7', '8']);
      expect(mapProfile(r.result, '1').friends).toEqual([WHO, '7', '8']);
    });

    test('asks for nothing without a user id', async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true }), { kind: 'profile', userId: '../users/@me' });
      expect(r).toMatchObject({ ok: false, error: 'whose profile?' });
      expect(calls).toEqual([]);
    });
  });

  test('reports why a sign-in failed, without tickets or tokens', () => {
    handlers.clear();
    me = null;
    const logLines = [
      '2026-10-31T00:36:13.662Z -> Network -> Completed POST to https://discord.com/api/v9/auth/location-metadata with status: 200',
      '2026-10-31T00:36:13.700Z -> Network -> Completed POST to https://discord.com/api/v9/users/@me/remote-auth/login with status: 400 and body: {"captcha_key":["captcha-required"],"captcha_sitekey":"abc","captcha_rqdata":"secretish"}',
      '2026-10-31T00:36:33.938Z -> Network -> Completed POST to https://discord.com/api/v9/users/@me/remote-auth/login with status: 400 and body: {"captcha_key":["invalid-response"]}',
      '2026-10-31T00:36:53.531Z -> Network -> Completed POST to https://discord.com/api/v9/users/@me/remote-auth/login with status: 404 and body: {"message":"Invalid remote authentication ticket","code":20042}',
      '2026-10-31T00:36:54.000Z -> Network -> Completed GET to https://discord.com/api/v9/channels/1/messages with status: 403 and body: {"message":"Missing Access"}',
    ];
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      log: (_m: any, e: any) => {
        e.z8 = function (category: string) {
          return category;
        };
        e.As = function (filter: string[]) {
          const r = { toArray: () => logLines.map((message) => ({ message })) };
          return r.toArray().filter(() => filter.includes('Network')).map((x) => x.message).join('\n');
        };
      },
    });
    web.T('stores');
    web.T('log');
    p.tick();
    p.poll();
    p.poll(); // no repeats
    const issues = p.posted.filter((m) => m.t === 'loginIssue');
    expect(issues).toEqual([
      { t: 'loginIssue', route: 'users/@me/remote-auth/login', status: 400, captcha: 'captcha-required', message: undefined, code: undefined },
      { t: 'loginIssue', route: 'users/@me/remote-auth/login', status: 400, captcha: 'invalid-response', message: undefined, code: undefined },
      { t: 'loginIssue', route: 'users/@me/remote-auth/login', status: 404, captcha: undefined, message: 'Invalid remote authentication ticket', code: 20042 },
    ]);
    expect(JSON.stringify(issues)).not.toContain('secretish');
  });

  test('sends the snapshot when the login finishes', () => {
    handlers.clear();
    me = null;
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    p.poll();
    expect(p.posted.some((m) => m.t === 'snapshot')).toBe(false); // the login form is up

    me = { id: '1', username: 'someone' };
    emit('CONNECTION_OPEN');
    expect(p.posted.filter((m) => m.t === 'snapshot')[0].data.self.id).toBe('1');
    p.poll(); // no second copy from the poll...
    expect(p.posted.filter((m) => m.t === 'snapshot')).toHaveLength(1);
    emit('CONNECTION_OPEN'); // ...but a reconnect refreshes it
    expect(p.posted.filter((m) => m.t === 'snapshot')).toHaveLength(2);
    me = null;
  });

  test('the snapshot lists friends from a client without getRelationships', () => {
    handlers.clear();
    me = { id: '1', username: 'someone' };
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      rel: (_m: any, e: any) => {
        // Current clients: a Map of records, no getRelationships().
        e.r = store('RelationshipStore', { getMutableRelationships: () => new Map([['7', { type: 1 }], ['8', { type: 2 }]]), getFriendIDs: () => ['7'] });
      },
    });
    web.T('stores');
    web.T('rel');
    p.tick();
    p.poll();
    const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1);
    // Friends and blocks with when they began and who (the user store knows nobody here).
    expect(snap.data.relationships).toEqual([
      { id: '7', type: 1, since: null, user: null },
      { id: '8', type: 2, since: null, user: null },
    ]);
    me = null;
  });

  test("a group DM without an icon carries the client's default one, as an absolute URL", () => {
    handlers.clear();
    me = { id: '1', username: 'someone' };
    const asked: any[] = [];
    channelStore.getSortedPrivateChannels = () => [
      { id: '30', type: 3, icon: null, recipients: [] },
      { id: '31', type: 3, icon: 'abc', recipients: [] },
      { id: '32', type: 1, recipients: [] },
    ];
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      icons: (_m: any, e: any) => {
        e.Ay = { getGuildIconURL: () => null, getChannelIconURL: (a: any) => (asked.push(a), `/assets/default-${a.id}.png`) };
      },
    });
    web.T('stores');
    web.T('icons');
    p.tick();
    p.poll();
    const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1);
    expect(snap.data.privateChannels.map((c: any) => c.default_icon)).toEqual(['https://discord.com/assets/default-30.png', undefined, undefined]);
    expect(asked).toEqual([{ id: '30', icon: null, applicationId: undefined, size: 128 }]);
    delete channelStore.getSortedPrivateChannels;
    me = null;
  });

  test('sends the snapshot when CONNECTION_OPEN fired before the hook subscribed', () => {
    handlers.clear();
    me = { id: '1', username: 'someone' };
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    p.poll();
    expect(p.posted.filter((m) => m.t === 'snapshot')).toHaveLength(1);
    me = null;
  });

  test('keeps looking until the stores exist', () => {
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    p.tick(); // nothing has run yet
    expect(p.posted.some((m) => m.t === 'finders')).toBe(false);
    web.T('stores');
    p.tick();
    expect(p.posted.find((m) => m.t === 'finders')?.results.Dispatcher).toBe(true);
  });

  test('injected after the runtimes still gets their requires', () => {
    const p = page();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.runHook();
    p.tick();
    expect(p.posted.find((m) => m.t === 'finders')?.results.UserStore).toBe(true);
    const pending = web.ensure('9');
    chunk(p.win, '9', { m9: () => {} });
    return pending;
  });
});

describe('pins, roles and custom statuses', () => {
  // Discord's dispatcher runs interceptors, then the stores' handlers, then subscribers.
  let interceptors: ((action: any) => boolean)[] = [];
  const dispatch = (type: string, action: any, apply: () => void = () => {}) => {
    const a = { type, ...action };
    if (interceptors.some((fn) => fn(a))) return;
    apply();
    emit(type, a);
  };
  const members = new Map<string, { userId: string; roles: string[] }>();
  const messages = new Map<string, { id: string; pinned: boolean }>();
  const presences = new Map<string, { status: string; activities: any[]; clientStatus?: Record<string, string> }>();

  function changesPage(opts: { interceptors?: boolean } = {}) {
    handlers.clear();
    interceptors = [];
    if (opts.interceptors !== false) (dispatcher as any).addInterceptor = (fn: (a: any) => boolean) => interceptors.push(fn);
    me = { id: '1', username: 'someone' };
    userStoreGetUser.value = (id: string) => ({ id, username: `user${id}` });
    guildRecords.clear();
    guildRecords.set('100', { id: '100', name: 'Test server' });
    channelStore.getDMFromUserId = (id: string) => (id === '20' ? '620' : undefined);
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      changes: (_m: any, e: any) => {
        e.m = store('GuildMemberStore', { getMember: (g: string, u: string) => (g === '100' ? members.get(u) ?? null : null), getNick: () => null });
        e.g = store('GuildRoleStore', {
          getRoles: () => ({
            '100': { id: '100', name: '@everyone', position: 0, color: 0 },
            '201': { id: '201', name: 'Helper', position: 1, color: 0x5c7cfa },
            '202': { id: '202', name: 'Mod', position: 2, colorString: '#e86a92' },
            '203': { id: '203', name: 'Unrelated', position: 3 },
          }),
        });
        e.s = store('MessageStore', { getMessage: (_c: string, id: string) => messages.get(id) });
        e.r = store('RelationshipStore', { getRelationshipType: (id: string) => (id === '7' || id === '8' ? 1 : id === '9' ? 2 : 0), getFriendIDs: () => ['7', '8'] });
        e.p = store('PresenceStore', {
          getStatus: (id: string) => presences.get(id)?.status ?? 'offline',
          getActivities: (id: string) => presences.get(id)?.activities ?? [],
          getClientStatus: (id: string) => presences.get(id)?.clientStatus ?? {},
        });
      },
    });
    web.T('stores');
    web.T('changes');
    p.tick();
    const sent = (event: string) => p.posted.filter((x) => x.t === 'dispatch' && x.event === event).map((x) => x.data);
    return { p, sent };
  }
  afterEach(() => {
    delete (dispatcher as any).addInterceptor;
    delete channelStore.getDMFromUserId;
    members.clear();
    messages.clear();
    presences.clear();
    guildRecords.clear();
    userStoreGetUser.value = () => null;
    me = null;
  });

  test("a role change is read against the member as the client had them, before the store takes it in", () => {
    const { sent } = changesPage();
    members.set('5', { userId: '5', roles: ['201'] });
    const update = { guildId: '100', user: { id: '5', username: 'user5' }, roles: ['201', '202'], nick: 'new nick' };
    dispatch('GUILD_MEMBER_UPDATE', update, () => members.set('5', { userId: '5', roles: update.roles }));
    expect(sent('GUILD_MEMBER_UPDATE')).toEqual([
      {
        guildId: '100',
        user: expect.objectContaining({ id: '5', username: 'user5' }),
        roles: ['201', '202'],
        before: ['201'],
        named: [
          { id: '201', name: 'Helper', color: '#5c7cfa' },
          { id: '202', name: 'Mod', color: '#e86a92' },
        ],
      },
    ]);
    expect(JSON.stringify(sent('GUILD_MEMBER_UPDATE'))).not.toContain('new nick');
  });

  test('a nickname change, or a member the client had not loaded, sends nothing', () => {
    const { sent } = changesPage();
    members.set('5', { userId: '5', roles: ['201'] });
    dispatch('GUILD_MEMBER_UPDATE', { guildId: '100', user: { id: '5' }, roles: ['201'], nick: 'x' });
    dispatch('GUILD_MEMBER_UPDATE', { guildId: '100', user: { id: '6' }, roles: ['202'] });
    expect(sent('GUILD_MEMBER_UPDATE')).toEqual([]);
  });

  test('without interceptors, a member update goes to the adapter to compare with what it heard before', () => {
    const { sent } = changesPage({ interceptors: false });
    members.set('5', { userId: '5', roles: ['201'] });
    dispatch('GUILD_MEMBER_UPDATE', { guildId: '100', user: { id: '5' }, roles: ['202'] });
    const [d] = sent('GUILD_MEMBER_UPDATE');
    expect(d.before).toBeUndefined();
    expect(d.roles).toEqual(['202']);
  });

  test('MESSAGE_UPDATE says whether the client had the message pinned; CHANNEL_PINS_UPDATE is passed on', () => {
    const { sent } = changesPage();
    messages.set('41', { id: '41', pinned: false });
    const msg = (id: string) => ({ id, channel_id: '300', author: { id: '5', username: 'user5' }, content: 'never forwarded twice', timestamp: '2024-06-01T12:00:00.000Z', pinned: true });
    dispatch('MESSAGE_UPDATE', { message: msg('41') }, () => messages.set('41', { id: '41', pinned: true }));
    dispatch('MESSAGE_UPDATE', { message: msg('42') });
    dispatch('CHANNEL_PINS_UPDATE', { channelId: '300', lastPinTimestamp: '2024-06-02T00:00:00.000Z' });
    const [known, unknown] = sent('MESSAGE_UPDATE');
    expect(known).toMatchObject({ message: { id: '41', pinned: true }, wasPinned: false });
    expect(unknown.message.pinned).toBe(true);
    expect('wasPinned' in unknown).toBe(false);
    expect(sent('CHANNEL_PINS_UPDATE')).toEqual([{ channelId: '300', lastPinTimestamp: '2024-06-02T00:00:00.000Z' }]);
  });

  test('custom statuses of friends and DM peers only, on change only, and offline is not cleared', () => {
    const { sent } = changesPage();
    const custom = (state: string | null, emoji?: any) => ({ type: 4, name: 'Custom Status', state, emoji });
    const song = (track: string) => ({ type: 2, name: 'Spotify', details: track });
    dispatch('PRESENCE_UPDATES', {
      updates: [
        { user: { id: '7' }, status: 'online', activities: [custom('coding', { id: '99', name: 'ferris', animated: false })] },
        { user: { id: '30' }, guildId: '100', status: 'online', activities: [custom('a stranger in a big server')] },
        { user: { id: '9' }, status: 'online', activities: [custom('blocked')] },
        { user: { id: '20' }, status: 'idle', activities: [] },
        { user: { id: '1' }, status: 'online', activities: [custom('me')] },
      ],
    });
    // The same again, a song moving on, going offline and back: nothing to say.
    dispatch('PRESENCE_UPDATES', { updates: [{ user: { id: '7' }, status: 'online', activities: [song('one'), custom('coding', { id: '99', name: 'ferris' })] }] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'offline', activities: [] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'dnd', activities: [custom('coding', { id: '99', name: 'ferris' }), song('two')] });
    // Cleared.
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'online', activities: [song('three')] });
    expect([...sent('PRESENCE_UPDATES'), ...sent('PRESENCE_UPDATE')].filter((x) => x.statuses).map((x) => ({ statuses: x.statuses }))).toEqual([
      {
        statuses: [
          { user: expect.objectContaining({ id: '7' }), text: 'coding', emoji: { id: '99', name: 'ferris', animated: false } },
          { user: expect.objectContaining({ id: '20' }), text: null, emoji: null },
        ],
      },
      { statuses: [{ user: expect.objectContaining({ id: '7' }), text: null, emoji: null }] },
    ]);
  });

  test("the snapshot and CONNECTION_OPEN_SUPPLEMENTAL carry online friends' custom statuses", () => {
    const { p, sent } = changesPage();
    p.poll();
    expect(p.posted.find((m) => m.t === 'snapshot').data.customStatuses).toEqual([]); // presences come later
    presences.set('7', { status: 'online', activities: [{ type: 4, state: 'on holiday', emoji: { name: '🌴' } }] });
    presences.set('8', { status: 'offline', activities: [] });
    dispatch('CONNECTION_OPEN_SUPPLEMENTAL', { presences: [] });
    expect(sent('CONNECTION_OPEN_SUPPLEMENTAL')).toEqual([
      {
        statuses: [{ user: expect.objectContaining({ id: '7' }), text: 'on holiday', emoji: { id: null, name: '🌴', animated: false } }],
        presences: [
          { user: expect.objectContaining({ id: '7' }), state: 'online', devices: [] },
          { user: expect.objectContaining({ id: '8' }), state: 'offline', devices: [] },
        ],
      },
    ]);
    // What it said is the last said: the same presence again sends nothing.
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'online', activities: [{ type: 4, state: 'on holiday', emoji: { name: '🌴' } }] });
    expect(sent('PRESENCE_UPDATE')).toEqual([]);
    emit('CONNECTION_OPEN');
    expect(p.posted.filter((m) => m.t === 'snapshot').at(-1).data.customStatuses).toEqual([{ user: expect.objectContaining({ id: '7' }), text: 'on holiday', emoji: { id: null, name: '🌴', animated: false } }]);
    expect(p.posted.filter((m) => m.t === 'snapshot').at(-1).data.presences.map((x: any) => [x.user.id, x.state])).toEqual([['7', 'online'], ['8', 'offline']]);
  });

  test('presence of friends and DM peers only, with devices, on change only; invisible is offline', () => {
    const { sent } = changesPage();
    dispatch('PRESENCE_UPDATES', {
      updates: [
        { user: { id: '7' }, status: 'online', clientStatus: { desktop: 'online', mobile: 'idle', embedded: 'online' }, activities: [] },
        { user: { id: '30' }, guildId: '100', status: 'online', clientStatus: { web: 'online' }, activities: [] },
        { user: { id: '9' }, status: 'idle', activities: [] },
        { user: { id: '1' }, status: 'online', activities: [] },
      ],
    });
    // The same again, a song changing: nothing. Then idle, do not disturb, invisible.
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'online', clientStatus: { desktop: 'online', mobile: 'idle' }, activities: [{ type: 2, name: 'Spotify' }] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'idle', clientStatus: { desktop: 'idle' }, activities: [] });
    dispatch('PRESENCE_UPDATE', { user: { id: '20' }, status: 'dnd', client_status: { mobile: 'dnd' }, activities: [] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'invisible', clientStatus: {}, activities: [] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'offline', activities: [] });
    const told = [...sent('PRESENCE_UPDATES'), ...sent('PRESENCE_UPDATE')].flatMap((x) => x.presences ?? []).map((x: any) => [x.user.id, x.state, x.devices.join()]);
    expect(told).toEqual([
      ['7', 'online', 'desktop,mobile'],
      ['7', 'idle', 'desktop'],
      ['20', 'dnd', 'mobile'],
      ['7', 'offline', ''],
    ]);
  });

  describe('members the client loaded anyway (passive)', () => {
    test("a message's member object goes along with it, role names and not ids, @everyone left out", () => {
      const { sent } = changesPage();
      const requests: string[] = [];
      for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = (...a: any[]) => void requests.push(k + JSON.stringify(a));
      const message = { id: '900', channel_id: '300', guild_id: '100', author: { id: '5', username: 'user5' }, content: 'hi', timestamp: '2026-01-01T00:00:00.000Z', member: { nick: 'five', roles: ['100', '202', '999'], joined_at: '2025-06-01T00:00:00.000Z' } };
      dispatch('MESSAGE_CREATE', { channelId: '300', guildId: '100', message });
      expect(sent('MESSAGE_CREATE')[0].message.member).toEqual({ nick: 'five', roles: ['Mod'], joined_at: '2025-06-01T00:00:00.000Z' });
      // A DM has none.
      dispatch('MESSAGE_CREATE', { channelId: '620', message: { ...message, id: '901', guild_id: null, member: undefined } });
      expect(sent('MESSAGE_CREATE')[1].message.member).toBeUndefined();
      expect(requests).toEqual([]);
    });

    test('the member list in view and chunks the client asked for are passed on as they came, with counts', () => {
      const { sent } = changesPage();
      const sentOps: unknown[] = [];
      const savedDispatch = dispatcher.dispatch;
      dispatcher.dispatch = ((a: any) => void sentOps.push(a)) as any;
      try {
        dispatch('GUILD_MEMBER_LIST_UPDATE', {
          guildId: '100',
          memberCount: 1200,
          onlineCount: 80,
          ops: [
            { op: 'SYNC', range: [0, 99], items: [{ group: { id: 'online', count: 80 } }, { member: { user: { id: '5', username: 'user5' }, roles: ['201'], nick: null, joined_at: '2025-01-01T00:00:00.000Z', presence: { status: 'online' } } }] },
            { op: 'UPDATE', index: 3, item: { member: { user: { id: '6', username: 'user6' }, roles: [] } } },
          ],
        });
        dispatch('GUILD_MEMBERS_CHUNK', { guildId: '100', members: [{ user: { id: '7', username: 'user7' }, roles: ['202'], nick: 'seven' }] });
        // Nothing in it and no counts: nothing sent.
        dispatch('GUILD_MEMBER_LIST_UPDATE', { guildId: '100', ops: [{ op: 'DELETE', index: 4 }] });
      } finally {
        dispatcher.dispatch = savedDispatch;
      }
      expect(sent('GUILD_MEMBER_LIST_UPDATE')).toEqual([
        {
          guildId: '100',
          members: [
            { user: expect.objectContaining({ id: '5' }), nick: null, roles: ['Helper'], joined_at: '2025-01-01T00:00:00.000Z' },
            { user: expect.objectContaining({ id: '6' }), nick: null, roles: [], joined_at: null },
          ],
          memberCount: 1200,
          onlineCount: 80,
        },
      ]);
      expect(JSON.stringify(sent('GUILD_MEMBER_LIST_UPDATE'))).not.toContain('presence');
      expect(sent('GUILD_MEMBERS_CHUNK')).toEqual([{ guildId: '100', members: [{ user: expect.objectContaining({ id: '7' }), nick: 'seven', roles: ['Mod'], joined_at: null }], memberCount: null, onlineCount: null }]);
      // It only listens: no gateway op, no action of its own.
      expect(sentOps).toEqual([]);
    });
  });
});

describe('adding: invites, friends and friend requests', () => {
  const SELF = '100000000000000001';
  const ANN = '400000000000000001';
  const BO = '400000000000000002';
  const CY = '400000000000000003';
  const DEE = '400000000000000004';
  const EVE = '400000000000000005';
  const GUILD = '200000000000000001';
  const ELSEWHERE = '200000000000000099';
  const CAT = '300000000000000100';
  const GENERAL = '300000000000000200';
  const GROUP = '600000000000000002';
  const users: Record<string, any> = {
    [SELF]: { id: SELF, username: 'someone' },
    [ANN]: { id: ANN, username: 'ann', globalName: 'Ann', avatar: 'aa', discriminator: '0', email: 'never@forward.this' },
    [BO]: { id: BO, username: 'bo', discriminator: '0' },
    [CY]: { id: CY, username: 'cy', discriminator: '0' },
    [DEE]: { id: DEE, username: 'dee', discriminator: '0' },
  };
  /**
   * RelationshipStore: type, when, and a nickname the hook must never pass on. spam: what isSpam says (absent: it says
   * nothing); record: more on the record, as the client maps the gateway's (isSpamRequest, isStrangerRequest);
   * mustConfirm: Discord refuses an accept without confirm_stranger_request (80013).
   */
  const rels = new Map<string, { type: number; since?: string; nickname?: string; spam?: boolean; record?: Record<string, unknown>; mustConfirm?: boolean }>();
  /** The store's stranger status, as UPDATE_STRANGER_STATUS left it (isStranger: undefined when it does not know). */
  const strangers = new Map<string, boolean>();
  const MUST_CONFIRM = { status: 400, body: { code: 80013, message: 'You must confirm the friend request to add this user.' } };
  /** InviteStore: what the client looked up before. */
  const looked = new Map<string, any>();
  const calls: unknown[][] = [];
  const pending = { value: false };
  let resolveWith: (code: string) => Promise<any> = async () => ({ invite: null });
  let acceptWith: (code: string) => Promise<any> = async () => ({});
  let friendFails: unknown = null;
  const restCalls: string[] = [];

  /** The invite as Discord's API answers it, with more in it than the hook may pass on. */
  const apiInvite = (over: Record<string, unknown> = {}) => ({
    code: 'pixelclub',
    type: 0,
    expires_at: '2030-01-02T03:04:05.000Z',
    guild: { id: GUILD, name: 'Pixel Club', icon: 'ic', description: 'Weekly challenges', features: ['COMMUNITY'], verification_level: 1, splash: 'never-splash', vanity_url_code: null },
    channel: { id: GENERAL, type: 0, name: 'general' },
    inviter: { id: ANN, username: 'ann', global_name: 'Ann', avatar: 'aa', public_flags: 0, email: 'never@forward.this' },
    approximate_member_count: 5321,
    approximate_presence_count: 802,
    ...over,
  });

  // The client's modules: current builds take one object, older ones plain arguments.
  const inviteActions = {
    resolveInvite: (code: string, location: string) => (calls.push(['resolveInvite', code, location]), resolveWith(code)),
    acceptInvite: (o: { inviteKey: string; context: unknown; callback?: () => void }) => (calls.push(['acceptInvite', o.inviteKey, o.context, typeof o.callback]), acceptWith(o.inviteKey)),
  };
  const inviteActionsOld = {
    resolveInvite: inviteActions.resolveInvite,
    acceptInvite: (code: string, context: unknown, cb: unknown) => (calls.push(['acceptInvite(old)', code, context, typeof cb]), acceptWith(code)),
  };
  const relate = (id: string, type: number) => (type ? rels.set(id, { type }) : rels.delete(id));
  const friendAction = (fn: () => void) => (friendFails ? Promise.reject(friendFails) : (fn(), Promise.resolve({ ok: true })));
  const relationshipActions = {
    sendRequest: (o: { discordTag: string; context: unknown }) => (calls.push(['sendRequest', o.discordTag, o.context]), friendAction(() => relate(Object.values(users).find((u) => u.username === o.discordTag)!.id, 4))),
    // As the live client has it (2026-11-09): one object, yet two parameters declared (an optional second), so its
    // arity says nothing about how it wants to be called. An accept Discord wants confirmed is refused without
    // confirmStrangerRequest (80013); the confirm is recorded only when it was passed at all.
    addRelationship(e: { userId: string; context: unknown; type?: number; confirmStrangerRequest?: boolean }, t?: unknown) {
      const { userId, context, type, confirmStrangerRequest } = e;
      void t;
      calls.push(['addRelationship', userId, context, type, ...('confirmStrangerRequest' in e ? [confirmStrangerRequest] : [])]);
      const r = rels.get(userId);
      if (r?.type === 3 && type === undefined && r.mustConfirm && !confirmStrangerRequest && !friendFails) return Promise.reject(MUST_CONFIRM);
      return friendAction(() => relate(userId, type ?? (r?.type === 3 ? 1 : 4)));
    },
    // Positional, three parameters, as the live client's.
    removeRelationship: (userId: string, context: unknown, done?: () => void) => (calls.push(['removeRelationship', userId, context]), friendAction(() => (relate(userId, 0), done?.()))),
  };
  const relationshipActionsOld = {
    sendRequest: (tag: string, context: unknown) => (calls.push(['sendRequest(old)', tag, context]), friendAction(() => relate(BO, 4))),
    addRelationship: (userId: string, context: unknown, type?: number) => (calls.push(['addRelationship(old)', userId, context, type]), friendAction(() => relate(userId, type ?? 4))),
    removeRelationship: relationshipActions.removeRelationship,
  };

  function addingPage(opts: { modules?: boolean; old?: boolean } = {}) {
    handlers.clear();
    calls.length = 0;
    restCalls.length = 0;
    me = { id: SELF, username: 'someone' };
    userStoreGetUser.value = (id: string) => users[id];
    userStoreUsers.value = () => users;
    guildRecords.clear();
    guildRecords.set(ELSEWHERE, { id: ELSEWHERE, name: 'Elsewhere' });
    for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = (...a: any[]) => void restCalls.push(k + JSON.stringify(a));
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      adding: (_m: any, e: any) => {
        e.r = store('RelationshipStore', {
          getRelationshipType: (id: string) => rels.get(id)?.type ?? 0,
          getMutableRelationships: () => new Map([...rels].map(([id, r]) => [id, { type: r.type, nickname: r.nickname, ...r.record }])),
          getSince: (id: string) => rels.get(id)?.since,
          getFriendIDs: () => [...rels].filter(([, r]) => r.type === 1).map(([id]) => id),
          isSpam: (id: string) => rels.get(id)?.spam,
          isStranger: (id: string) => strangers.get(id),
          isIgnored: () => false,
        });
        e.c = store('GuildChannelStore', {
          getChannels: (gid: string) => (gid === GUILD ? { SELECTABLE: [{ channel: { id: GENERAL, type: 0, guild_id: GUILD, parent_id: CAT, name: 'general', position: 1 } }], 4: [{ channel: { id: CAT, type: 4, guild_id: GUILD, name: 'Start here', position: 0 } }] } : {}),
        });
        e.m = store('GuildMemberStore', { getMember: (g: string, u: string) => (g === GUILD && u === SELF && guildRecords.has(GUILD) ? { userId: SELF, roles: [], isPending: pending.value } : null), getNick: () => null });
        if (opts.modules !== false) {
          e.i = opts.old ? inviteActionsOld : inviteActions;
          e.s = store('InviteStore', { getInvite: (code: string) => looked.get(code) });
          e.a = opts.old ? relationshipActionsOld : relationshipActions;
        }
      },
    });
    web.T('stores');
    web.T('adding');
    p.tick();
    return p;
  }
  let n = 0;
  async function ask(p: ReturnType<typeof page>, c: unknown) {
    const id = `add${n++}`;
    p.win.down({ t: 'cmd', id, cmd: c });
    for (let i = 0; i < 10; i++) await Bun.sleep(0);
    const r = p.posted.find((m) => m.t === 'reply' && m.id === id);
    if (r?.ok) {
      expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
      expect(JSON.stringify(r.result)).not.toContain('never');
    }
    return r;
  }
  const state = () => Object.assign(newState(), { selfId: SELF });
  afterEach(() => {
    rels.clear();
    strangers.clear();
    looked.clear();
    pending.value = false;
    friendFails = null;
    resolveWith = async () => ({ invite: null });
    acceptWith = async () => ({});
    guildRecords.clear();
    userStoreGetUser.value = () => null;
    userStoreUsers.value = () => ({});
    channelStore.getChannel = () => null;
    me = null;
  });

  test('finds the invite and friends modules by their shape; capabilities only for what it found', () => {
    const found = addingPage().posted.filter((m) => m.t === 'finders').at(-1).results;
    expect(found).toMatchObject({ InviteActions: true, InviteStore: true, RelationshipActions: true, RelationshipStore: true });
    expect(addCapabilities(found)).toEqual(['resolve', 'join', 'connect', 'requests', 'relationships', 'disconnect', 'addMembers']);
    const without = addingPage({ modules: false }).posted.filter((m) => m.t === 'finders').at(-1).results;
    expect(without).toMatchObject({ InviteActions: false, InviteStore: false, RelationshipActions: false, RelationshipStore: true });
    // The store lists relationships; nothing ends one without the friends module. Adding to a group needs only the
    // store, which says who is a friend, and the REST module.
    expect(addCapabilities(without)).toEqual(['relationships', 'addMembers']);
  });

  test('without the modules a command says so, and throws nothing on load', async () => {
    const p = addingPage({ modules: false });
    expect(await ask(p, { kind: 'inviteResolve', code: 'pixelclub' })).toMatchObject({ ok: false, error: expect.stringContaining("Discord's own invite module was not found") });
    expect(await ask(p, { kind: 'friendAdd', username: 'bo' })).toMatchObject({ ok: false, error: expect.stringContaining("Discord's own friends module was not found") });
    expect(p.posted.some((m) => m.t === 'log' && m.level === 'error')).toBe(false);
  });

  describe('resolve', () => {
    test("the client's own lookup, whitelisted: server, counts, expiry, inviter", async () => {
      resolveWith = async (code) => ({ invite: apiInvite({ code }), code });
      const r = await ask(addingPage(), { kind: 'inviteResolve', code: 'pixelclub' });
      expect(calls).toEqual([['resolveInvite', 'pixelclub', 'Join Guild']]);
      expect(restCalls).toEqual([]);
      expect(r.result).toEqual({
        code: 'pixelclub',
        type: 0,
        guild: { id: GUILD, name: 'Pixel Club', icon: 'ic', description: 'Weekly challenges', verification_level: 1, screening: false },
        channel: { id: GENERAL, type: 0, name: 'general', icon: null },
        inviter: { id: ANN, username: 'ann', global_name: 'Ann', discriminator: undefined, avatar: 'aa', bot: false },
        expires_at: '2030-01-02T03:04:05.000Z',
        members: 5321,
        online: 802,
        joined: null,
        relationship: null,
      });
      const { events, preview } = invitePreview(r.result, state());
      expect(events).toEqual([{ t: 'identity', identity: expect.objectContaining({ nativeId: ANN, handle: 'ann' }) }]);
      expect(preview).toMatchObject({ what: 'space', name: 'Pixel Club', nativeId: GUILD, members: 5321, online: 802, inviter: ANN, actions: ['join'], expires: Date.UTC(2030, 0, 2, 3, 4, 5) });
    });

    test('a server you are in already, and one with screening', async () => {
      resolveWith = async (code) => ({ invite: apiInvite({ code, guild: { ...apiInvite().guild, features: ['MEMBER_VERIFICATION_GATE_ENABLED'] } }), code });
      const p = addingPage();
      expect((await ask(p, { kind: 'inviteResolve', code: 'pixelclub' })).result).toMatchObject({ joined: null, guild: { screening: true } });
      guildRecords.set(GUILD, { id: GUILD, name: 'Pixel Club' });
      const r = await ask(p, { kind: 'inviteResolve', code: 'pixelclub' });
      expect(invitePreview(r.result, state()).preview).toMatchObject({ joined: { space: GUILD }, actions: [], notes: ['You are in this server already'] });
    });

    test('a group DM invite', async () => {
      resolveWith = async (code) => ({ invite: { code, type: 1, channel: { id: GROUP, type: 3, name: 'weekend raid', icon: null, recipients: [{ username: 'ann' }, { username: 'bo' }] }, inviter: apiInvite().inviter, approximate_member_count: 3 } });
      const r = await ask(addingPage(), { kind: 'inviteResolve', code: 'raidgroup' });
      expect(r.result).toMatchObject({ type: 1, channel: { id: GROUP, type: 3, recipients: ['ann', 'bo'] }, members: 3, joined: null });
      expect(invitePreview(r.result, state()).preview).toMatchObject({ what: 'group', name: 'weekend raid', actions: ['join'] });
    });

    test('expired, revoked or banned: the sentence, not a preview', async () => {
      const p = addingPage();
      resolveWith = async () => ({ invite: null });
      looked.set('oldparty', { code: 'oldparty', state: 'EXPIRED' });
      expect(await ask(p, { kind: 'inviteResolve', code: 'oldparty' })).toMatchObject({ ok: false, error: 'This invite has expired or was revoked' });
      resolveWith = () => Promise.reject({ status: 404, body: { code: 10006, message: 'Unknown Invite' } });
      expect(await ask(p, { kind: 'inviteResolve', code: 'oldparty' })).toMatchObject({ ok: false, error: 'This invite has expired or was revoked' });
      resolveWith = async () => ({ invite: null });
      looked.set('banned', { code: 'banned', state: 'BANNED' });
      expect(await ask(p, { kind: 'inviteResolve', code: 'banned' })).toMatchObject({ ok: false, error: 'You are banned from this server' });
      expect(await ask(p, { kind: 'inviteResolve', code: '../users/@me' })).toMatchObject({ ok: false, error: 'That is not a Discord invite code' });
    });

    test('a rate limit says when it frees up', async () => {
      resolveWith = () => Promise.reject({ status: 429, body: { message: 'You are being rate limited.', retry_after: 11.2 } });
      expect(await ask(addingPage(), { kind: 'inviteResolve', code: 'pixelclub' })).toMatchObject({ ok: false, error: 'Discord is limiting how often this account can look up invites: try again in 12 seconds', retryAfter: 11.2 });
    });

    test('a person, from the stores alone: by id, by username, or nobody it has seen', async () => {
      const p = addingPage();
      rels.set(ANN, { type: 3, nickname: 'never this nickname' });
      const byId = await ask(p, { kind: 'person', handle: ANN });
      expect(byId.result).toEqual({ selfId: SELF, user: expect.objectContaining({ id: ANN, username: 'ann', global_name: 'Ann' }), relationship: 3, direct: false });
      const byName = await ask(p, { kind: 'person', handle: 'bo' });
      expect(byName.result).toMatchObject({ user: { id: BO, username: 'bo' }, relationship: 0 });
      expect((await ask(p, { kind: 'person', handle: 'mara' })).result).toEqual({ selfId: SELF, user: null });
      expect((await ask(p, { kind: 'person', handle: '400000000000000009' })).result).toEqual({ selfId: SELF, user: null });
      expect(await ask(p, { kind: 'person', handle: 'Not A Name!' })).toMatchObject({ ok: false });
      // It looked, and did nothing anyone sees.
      expect(calls).toEqual([]);
      expect(restCalls).toEqual([]);
    });
  });

  describe('join', () => {
    /** The gateway's GUILD_CREATE landing in the client's stores as the accept answers. */
    const joins = (body: Record<string, unknown> = {}) => async (code: string) => {
      guildRecords.set(GUILD, { id: GUILD, name: 'Pixel Club', icon: 'ic', description: 'Weekly challenges', rulesChannelId: null });
      return { body: { code, new_member: true, guild: { id: GUILD, name: 'Pixel Club' }, ...body } };
    };

    test("accepts as the client's Join button does, then the server as it landed", async () => {
      looked.set('pixelclub', { ...apiInvite(), state: 'RESOLVED' });
      acceptWith = joins();
      const r = await ask(addingPage(), { kind: 'inviteAccept', code: 'pixelclub' });
      // Its own copy from the lookup: no second lookup.
      expect(calls).toEqual([['acceptInvite', 'pixelclub', { location: 'Join Guild' }, 'function']]);
      expect(restCalls).toEqual([]);
      expect(r.result).toMatchObject({ guild: { id: GUILD, name: 'Pixel Club' }, channelId: GENERAL, rules: false, phone: false });
      expect(r.result.channels.map((c: any) => c.id).sort()).toEqual([CAT, GENERAL]);
      const st = state();
      const { events, result } = joinOutcome(r.result, st);
      expect(events.map((e) => e.t)).toEqual(['space', 'space', 'conversation']);
      expect(result).toEqual({ space: GUILD, conversation: GENERAL });
    });

    test('looks it up first when the client has not, and in older builds passes plain arguments', async () => {
      resolveWith = async (code) => ({ invite: apiInvite({ code }) });
      acceptWith = joins();
      const r = await ask(addingPage({ old: true }), { kind: 'inviteAccept', code: 'pixelclub' });
      expect(calls).toEqual([['resolveInvite', 'pixelclub', 'Join Guild'], ['acceptInvite(old)', 'pixelclub', { location: 'Join Guild' }, 'function']]);
      expect(r.result.guild.id).toBe(GUILD);
    });

    test('a captcha in the refusal: a check, nothing joined, none of its keys passed on', async () => {
      looked.set('speedrun', { ...apiInvite({ code: 'speedrun' }), state: 'RESOLVED' });
      acceptWith = () => Promise.reject({ status: 400, body: { captcha_key: ['captcha-required'], captcha_sitekey: 'sitekey-not-passed', captcha_service: 'hcaptcha', captcha_rqdata: 'rqdata-not-passed' } });
      const r = await ask(addingPage(), { kind: 'inviteAccept', code: 'speedrun' });
      expect(r).toMatchObject({ ok: true, result: { check: 'captcha' } });
      expect(JSON.stringify(r)).not.toContain('not-passed');
      expect(guildRecords.has(GUILD)).toBe(false);
      expect(joinOutcome(r.result, state())).toEqual({ events: [], result: { check: 'captcha' } });
    });

    test('a captcha the client put on screen while it waited: a check at once, left there for the owner', async () => {
      looked.set('speedrun', { ...apiInvite({ code: 'speedrun' }), state: 'RESOLVED' });
      acceptWith = () => new Promise(() => {}); // the client waits for the captcha's answer
      const p = addingPage();
      p.win.down({ t: 'cmd', id: 'cap', cmd: { kind: 'inviteAccept', code: 'speedrun' } });
      for (let i = 0; i < 10; i++) await Bun.sleep(0);
      expect(p.posted.find((m) => m.t === 'reply' && m.id === 'cap')).toBeUndefined();
      p.doc.querySelector = (q: string) => (q.includes('captcha') ? { src: 'https://hcaptcha.example.org/frame' } : null);
      p.poll();
      await Bun.sleep(0);
      expect(p.posted.find((m) => m.t === 'reply' && m.id === 'cap')).toMatchObject({ ok: true, result: { check: 'captcha' } });
    });

    test("membership screening: joined, and the rules left for the owner", async () => {
      looked.set('pixelclub', { ...apiInvite(), state: 'RESOLVED' });
      acceptWith = joins({ show_verification_form: true });
      const r = await ask(addingPage(), { kind: 'inviteAccept', code: 'pixelclub' });
      expect(r.result.rules).toBe(true);
      expect(joinOutcome(r.result, state()).result).toMatchObject({ space: GUILD, check: 'rules' });
      // Or the client holds the member as pending.
      pending.value = true;
      acceptWith = joins();
      guildRecords.delete(GUILD);
      expect((await ask(addingPage(), { kind: 'inviteAccept', code: 'pixelclub' })).result.rules).toBe(true);
    });

    test('a verification Discord wants first: a check, nothing joined', async () => {
      looked.set('pixelclub', { ...apiInvite(), state: 'RESOLVED' });
      acceptWith = () => Promise.reject({ status: 403, body: { code: 40002, message: 'You need to verify your account in order to perform this action.' } });
      expect((await ask(addingPage(), { kind: 'inviteAccept', code: 'pixelclub' })).result).toEqual({ invite: expect.anything(), check: 'verify' });
      acceptWith = () => Promise.reject({ status: 403, body: { code: 40002, message: 'You need to verify your phone number in order to perform this action.' } });
      expect((await ask(addingPage(), { kind: 'inviteAccept', code: 'pixelclub' })).result).toMatchObject({ check: 'phone' });
    });

    test('a refusal is its sentence; in it already sends nothing; a friend invite only through Add friend', async () => {
      looked.set('pixelclub', { ...apiInvite(), state: 'RESOLVED' });
      acceptWith = () => Promise.reject({ status: 400, body: { code: 30001, message: 'Maximum number of guilds reached (100)' } });
      const p = addingPage();
      expect(await ask(p, { kind: 'inviteAccept', code: 'pixelclub' })).toMatchObject({ ok: false, error: 'Maximum number of guilds reached (100)' });
      guildRecords.set(GUILD, { id: GUILD, name: 'Pixel Club' });
      calls.length = 0;
      expect((await ask(p, { kind: 'inviteAccept', code: 'pixelclub' })).result).toMatchObject({ already: true, invite: { joined: { space: GUILD } } });
      expect(calls).toEqual([]);
      looked.set('frnd', { code: 'frnd', type: 2, inviter: apiInvite().inviter, state: 'RESOLVED' });
      expect(await ask(p, { kind: 'inviteAccept', code: 'frnd' })).toMatchObject({ ok: false, error: 'This is a friend invite: Add friend accepts it' });
      acceptWith = async () => (relate(ANN, 1), {});
      const f = await ask(p, { kind: 'inviteAccept', code: 'frnd', friend: true });
      expect(f.result).toMatchObject({ friend: { id: ANN }, relationship: 1 });
      expect(joinOutcome(f.result, state()).result).toEqual({ identity: ANN, relationship: 'friend' });
    });
  });

  describe('friends', () => {
    test("by username: the client's own Add Friend request; who it was once Discord says", async () => {
      const r = await ask(addingPage(), { kind: 'friendAdd', username: 'bo' });
      expect(calls).toEqual([['sendRequest', 'bo', { location: 'Add Friend' }]]);
      expect(restCalls).toEqual([]);
      expect(r.result).toEqual({ user: expect.objectContaining({ id: BO, username: 'bo' }), relationship: 4 });
      expect(friendOutcome(r.result, state()).result).toEqual({ identity: BO, relationship: 'requested', pending: true });
    });

    test('by user id; a captcha is a check; a refusal is its sentence; never yourself', async () => {
      const p = addingPage();
      expect((await ask(p, { kind: 'friendAdd', userId: ANN })).result).toMatchObject({ user: { id: ANN }, relationship: 4 });
      expect(calls).toEqual([['addRelationship', ANN, { location: 'Add Friend' }, undefined]]);
      friendFails = { status: 400, body: { captcha_key: ['captcha-required'], captcha_sitekey: 'sitekey-not-passed' } };
      const cap = await ask(p, { kind: 'friendAdd', username: 'bo' });
      expect(cap.result).toEqual({ check: 'captcha' });
      expect(friendOutcome(cap.result, state()).result).toEqual({ check: 'captcha' });
      friendFails = { status: 400, body: { code: 80000, message: 'Incoming friend requests disabled.' } };
      expect(await ask(p, { kind: 'friendAdd', username: 'bo' })).toMatchObject({ ok: false, error: 'Incoming friend requests disabled.' });
      friendFails = null;
      expect(await ask(p, { kind: 'friendAdd', username: 'someone' })).toMatchObject({ ok: false, error: 'That is this account' });
      expect(await ask(p, { kind: 'friendAdd', userId: SELF })).toMatchObject({ ok: false, error: 'That is this account' });
    });

    test('older builds take plain arguments', async () => {
      const p = addingPage({ old: true });
      await ask(p, { kind: 'friendAdd', username: 'bo' });
      await ask(p, { kind: 'friendAdd', userId: ANN });
      expect(calls).toEqual([
        ['sendRequest(old)', 'bo', { location: 'Add Friend' }],
        ['addRelationship(old)', ANN, { location: 'Add Friend' }, undefined],
      ]);
    });
  });

  describe('requests', () => {
    test('the snapshot lists them with when they came, and says when the list is whole', () => {
      rels.set(ANN, { type: 3, since: '2026-11-01T10:00:00.000Z', nickname: 'never this nickname' });
      rels.set(BO, { type: 1, since: '2020-01-01T00:00:00.000Z' });
      const p = addingPage();
      emit('CONNECTION_OPEN');
      const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1).data;
      // The asker comes with their user record, so the request has a name.
      expect(snap.relationships).toEqual([
        { id: ANN, type: 3, since: '2026-11-01T10:00:00.000Z', user: expect.objectContaining({ id: ANN }), spam: false, stranger: null },
        { id: BO, type: 1, since: '2020-01-01T00:00:00.000Z', user: expect.objectContaining({ id: BO }) },
      ]);
      expect(snap.requestsKnown).toBe(true);
      expect(JSON.stringify(snap)).not.toContain('never');
      const st = state();
      expect(snapshotRequests(snap, st)).toEqual([
        { t: 'identity', identity: expect.objectContaining({ nativeId: ANN }) },
        { t: 'requests', requests: [{ nativeId: `friend:${ANN}`, kind: 'friend', from: ANN, ts: Date.UTC(2026, 10, 1, 10), answers: ['accept', 'decline', 'block'] }] },
      ]);
    });

    test('before the gateway is in, an empty list is not the whole list', () => {
      const p = addingPage();
      p.poll(); // signed in, but no CONNECTION_OPEN heard and no relationships yet
      const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1).data;
      expect(snap.relationships).toEqual([]);
      expect(snap.requestsKnown).toBe(false);
      expect(snapshotRequests(snap, state())).toEqual([]);
    });

    test('one coming and one going are forwarded without the nickname, and become request and requestGone', () => {
      const p = addingPage();
      const st = state();
      snapshotRequests({ relationships: [], requestsKnown: true }, st);
      emit('RELATIONSHIP_ADD', { relationship: { id: ANN, type: 3, since: '2026-11-02T00:00:00.000Z', nickname: 'never this nickname', user: { id: ANN, username: 'ann', global_name: 'Ann', email: 'never@forward.this' } } });
      emit('RELATIONSHIP_REMOVE', { relationship: { id: ANN, type: 3, nickname: 'never this nickname' } });
      const sent = p.posted.filter((m) => m.t === 'dispatch' && m.event.startsWith('RELATIONSHIP_'));
      expect(sent.map((m) => m.data)).toEqual([
        { id: ANN, type: 3, user: expect.objectContaining({ id: ANN, username: 'ann' }), since: '2026-11-02T00:00:00.000Z', spam: false, stranger: null },
        { id: ANN, type: 3, user: null, since: null },
      ]);
      expect(JSON.stringify(sent)).not.toContain('never');
      expect(sent.flatMap((m) => relationshipEvents(m.event, m.data, st)).map((e) => e.t)).toEqual(['identity', 'request', 'requestGone']);
    });

    test("each answer through the client's own friends list actions", async () => {
      const want = { accept: 1, decline: 0, block: 2 } as const;
      for (const answer of ['accept', 'decline', 'block'] as const) {
        rels.set(ANN, { type: 3 });
        const p = addingPage();
        const r = await ask(p, { kind: 'friendAnswer', userId: ANN, answer });
        expect(r.result).toEqual({ user: expect.objectContaining({ id: ANN }), relationship: want[answer] });
        expect(calls).toEqual([
          answer === 'decline' ? ['removeRelationship', ANN, { location: 'Friends' }] : ['addRelationship', ANN, { location: 'Friends' }, answer === 'block' ? 2 : undefined],
        ]);
        expect(restCalls).toEqual([]);
        const st = state();
        snapshotRequests({ relationships: [{ id: ANN, type: 3 }], requestsKnown: true }, st);
        const { events, result } = answerOutcome(r.result, ANN, st);
        expect(events.at(-1)).toEqual({ t: 'requestGone', nativeId: `friend:${ANN}` });
        expect(result).toEqual({ identity: ANN, relationship: ({ accept: 'friend', decline: 'stranger', block: 'blocked' } as const)[answer] });
      }
    });

    test('one not waiting any more is not answered', async () => {
      const p = addingPage();
      expect(await ask(p, { kind: 'friendAnswer', userId: ANN, answer: 'accept' })).toMatchObject({ ok: false, error: 'That request is not waiting any more' });
      rels.set(ANN, { type: 3 });
      expect(await ask(p, { kind: 'friendAnswer', userId: ANN, answer: 'maybe' })).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
    });
  });

  describe('people links: warnings, the confirm step, relationships, remove', () => {
    const dispatched = (p: ReturnType<typeof page>, from = 0) => p.posted.slice(from).filter((m) => m.t === 'dispatch' && (m.event.includes('RELATIONSHIP') || m.event === 'UPDATE_STRANGER_STATUS'));
    const knownState = (requests: { id: string; type: number }[] = []) => {
      const st = state();
      snapshotRequests({ relationships: requests, requestsKnown: true }, st);
      return st;
    };

    test("a request's flags from the store, else its record, in the snapshot; never the nickname", () => {
      rels.set(ANN, { type: 3, since: '2026-11-01T10:00:00.000Z', nickname: 'never this nickname', spam: true });
      rels.set(BO, { type: 3, nickname: 'never this nickname', record: { isStrangerRequest: true, isSpamRequest: false } });
      rels.set(CY, { type: 3, record: { userIgnored: true } });
      const p = addingPage();
      emit('CONNECTION_OPEN');
      const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1).data;
      expect(snap.relationships).toEqual([
        { id: ANN, type: 3, since: '2026-11-01T10:00:00.000Z', user: expect.objectContaining({ id: ANN }), spam: true, stranger: null },
        { id: BO, type: 3, since: null, user: expect.objectContaining({ id: BO }), spam: false, stranger: true },
        { id: CY, type: 3, since: null, user: expect.objectContaining({ id: CY }), spam: false, stranger: null },
      ]);
      expect(JSON.stringify(snap)).not.toContain('never');
      expect(JSON.stringify(snap)).not.toContain('Ignored');
      const out = snapshotRequests(snap, state());
      const list = (out.at(-1) as Extract<(typeof out)[number], { t: 'requests' }>).requests;
      expect(list.map((r) => [r.from, r.warning])).toEqual([
        [ANN, SPAM_WARNING],
        [BO, STRANGER_WARNING],
        [CY, undefined],
      ]);
    });

    test('live: flags with a new request, and a request again when they change; nothing for anyone else', () => {
      const p = addingPage();
      const st = knownState();
      // The gateway's record (snake_case) as the action carries it, before the store answers anything about it.
      rels.set(CY, { type: 3 });
      emit('RELATIONSHIP_ADD', { relationship: { id: CY, type: 3, is_spam_request: true, nickname: 'never this nickname', user: { id: CY, username: 'cy' } } });
      // Discord files it as spam after all; then the client learns they are a stranger.
      rels.set(ANN, { type: 3, spam: false });
      emit('RELATIONSHIP_ADD', { relationship: { id: ANN, type: 3, user: { id: ANN, username: 'ann' } } });
      rels.set(ANN, { type: 3, spam: true });
      emit('RELATIONSHIP_UPDATE', { relationship: { id: ANN, type: 3, isSpamRequest: true, user: { id: ANN, username: 'ann' } } });
      strangers.set(ANN, true);
      emit('UPDATE_STRANGER_STATUS', { userId: ANN, isStranger: true });
      // Someone with no request waiting: nothing to say.
      emit('UPDATE_STRANGER_STATUS', { userId: BO, isStranger: true });
      const sent = dispatched(p);
      expect(sent.map((m) => [m.event, m.data.id, m.data.spam, m.data.stranger])).toEqual([
        ['RELATIONSHIP_ADD', CY, true, null],
        ['RELATIONSHIP_ADD', ANN, false, null],
        ['RELATIONSHIP_UPDATE', ANN, true, null],
        ['UPDATE_STRANGER_STATUS', ANN, true, true],
      ]);
      expect(JSON.stringify(sent)).not.toContain('never');
      const events = sent.flatMap((m) => relationshipEvents(m.event, m.data, st));
      expect(events.filter((e) => e.t === 'request').map((e) => (e.t === 'request' ? [e.request.from, e.request.warning] : null))).toEqual([
        [CY, SPAM_WARNING],
        [ANN, undefined],
        [ANN, SPAM_WARNING],
        [ANN, `${SPAM_WARNING}. ${STRANGER_WARNING}`],
      ]);
      // The same flags again change nothing.
      expect(relationshipEvents(sent[3].event, sent[3].data, st)).toEqual([]);
    });

    test("accept without the owner's confirm: Discord's sentence back, nothing done, no second call", async () => {
      rels.set(ANN, { type: 3, mustConfirm: true });
      const p = addingPage();
      const r = await ask(p, { kind: 'friendAnswer', userId: ANN, answer: 'accept' });
      expect(r).toMatchObject({ ok: true, result: { confirm: 'You must confirm the friend request to add this user.' } });
      expect(calls).toEqual([['addRelationship', ANN, { location: 'Friends' }, undefined]]);
      expect(rels.get(ANN)?.type).toBe(3);
      // The adapter: the request stays, now warned, and the reply asks the owner.
      const st = knownState([{ id: ANN, type: 3 }]);
      const out = answerOutcome(r.result, ANN, st);
      expect(out).toEqual({
        events: [{ t: 'request', request: expect.objectContaining({ nativeId: `friend:${ANN}`, warning: STRANGER_WARNING }) }],
        result: { confirm: 'You must confirm the friend request to add this user.' },
      });
      expect(st.requests.has(ANN)).toBe(true);
      // "Accept anyway": the same command with the owner's confirm carries it, once.
      calls.length = 0;
      const again = await ask(p, { kind: 'friendAnswer', userId: ANN, answer: 'accept', confirm: true });
      expect(calls).toEqual([['addRelationship', ANN, { location: 'Friends' }, undefined, true]]);
      expect(again.result).toEqual({ user: expect.objectContaining({ id: ANN }), relationship: 1 });
      expect(answerOutcome(again.result, ANN, st).result).toEqual({ identity: ANN, relationship: 'friend' });
      expect(restCalls).toEqual([]);
    });

    test('a refusal even with the confirm is a refusal, never tried again', async () => {
      rels.set(ANN, { type: 3 });
      friendFails = MUST_CONFIRM;
      const p = addingPage();
      expect(await ask(p, { kind: 'friendAnswer', userId: ANN, answer: 'accept', confirm: true })).toMatchObject({ ok: false, error: 'You must confirm the friend request to add this user.' });
      expect(calls).toEqual([['addRelationship', ANN, { location: 'Friends' }, undefined, true]]);
    });

    test('Add friend by user id the same; by username never a confirm', async () => {
      rels.set(ANN, { type: 3, mustConfirm: true });
      const p = addingPage();
      const r = await ask(p, { kind: 'friendAdd', userId: ANN });
      expect(r.result).toEqual({ confirm: 'You must confirm the friend request to add this user.' });
      expect(calls).toEqual([['addRelationship', ANN, { location: 'Add Friend' }, undefined]]);
      const st = knownState([{ id: ANN, type: 3 }]);
      expect(friendOutcome(r.result, st, ANN)).toEqual({ events: [{ t: 'request', request: expect.objectContaining({ warning: STRANGER_WARNING }) }], result: { confirm: 'You must confirm the friend request to add this user.' } });
      calls.length = 0;
      expect((await ask(p, { kind: 'friendAdd', userId: ANN, confirm: true })).result).toMatchObject({ user: { id: ANN }, relationship: 1 });
      expect(calls).toEqual([['addRelationship', ANN, { location: 'Add Friend' }, undefined, true]]);
      calls.length = 0;
      await ask(p, { kind: 'friendAdd', username: 'bo', confirm: true });
      expect(calls).toEqual([['sendRequest', 'bo', { location: 'Add Friend' }]]);
    });

    test('decline and block never carry a confirm', async () => {
      for (const answer of ['decline', 'block'] as const) {
        rels.set(ANN, { type: 3, mustConfirm: true });
        const p = addingPage();
        const r = await ask(p, { kind: 'friendAnswer', userId: ANN, answer, confirm: true });
        expect(r.result).toMatchObject({ relationship: answer === 'block' ? 2 : 0 });
        expect(calls).toEqual([answer === 'decline' ? ['removeRelationship', ANN, { location: 'Friends' }] : ['addRelationship', ANN, { location: 'Friends' }, 2]]);
      }
    });

    test('a build that takes plain arguments has no place for a confirm: refused, nothing sent', async () => {
      rels.set(ANN, { type: 3 });
      const p = addingPage({ old: true });
      expect(await ask(p, { kind: 'friendAnswer', userId: ANN, answer: 'accept', confirm: true })).toMatchObject({ ok: false, error: expect.stringContaining('accept it in the live view') });
      expect(calls).toEqual([]);
    });

    test('the relationships after load: identities first, friends, blocks and requests sent; not incoming or implicit', () => {
      rels.set(ANN, { type: 3, since: '2026-11-01T10:00:00.000Z' });
      rels.set(BO, { type: 1, since: '2020-01-01T00:00:00.000Z', nickname: 'never this nickname' });
      rels.set(CY, { type: 2, since: '2025-05-05T00:00:00.000Z' });
      rels.set(DEE, { type: 4, since: '2026-11-08T00:00:00.000Z' });
      rels.set(EVE, { type: 5 });
      const p = addingPage();
      emit('CONNECTION_OPEN');
      const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1).data;
      expect(JSON.stringify(snap)).not.toContain('never');
      expect(snap.relationships.find((r: any) => r.id === EVE)).toEqual({ id: EVE, type: 5 });
      const st = state();
      expect(snapshotRelationships(snap, st)).toEqual([
        { t: 'identity', identity: expect.objectContaining({ nativeId: BO }) },
        { t: 'identity', identity: expect.objectContaining({ nativeId: CY }) },
        { t: 'identity', identity: expect.objectContaining({ nativeId: DEE }) },
        {
          t: 'relationships',
          list: [
            { identity: BO, relationship: 'friend', since: Date.UTC(2020, 0, 1) },
            { identity: CY, relationship: 'blocked', since: Date.UTC(2025, 4, 5) },
            { identity: DEE, relationship: 'requested', since: Date.UTC(2026, 10, 8) },
          ],
        },
      ]);
      // The client loading them again is the whole list again.
      const from = p.posted.length;
      emit('LOAD_RELATIONSHIPS_SUCCESS', { relationships: [] });
      const reload = dispatched(p, from)[0];
      expect(relationshipEvents(reload.event, reload.data, st).filter((e) => e.t === 'relationships' || e.t === 'requests').map((e) => e.t)).toEqual(['requests', 'relationships']);
    });

    test('relationship events: a request sent, a request accepted, an unfriend, a block', () => {
      rels.set(ANN, { type: 3 });
      rels.set(BO, { type: 1, since: '2020-01-01T00:00:00.000Z' });
      const p = addingPage();
      const st = knownState([{ id: ANN, type: 3 }]);
      snapshotRelationships({ relationships: [{ id: BO, type: 1, since: '2020-01-01T00:00:00.000Z' }], requestsKnown: true }, st);
      rels.set(DEE, { type: 4, since: '2026-11-09T00:00:00.000Z' });
      emit('RELATIONSHIP_ADD', { relationship: { id: DEE, type: 4, nickname: 'never this nickname', user: { id: DEE, username: 'dee' } } });
      rels.set(ANN, { type: 1, since: '2026-11-09T01:00:00.000Z' });
      emit('RELATIONSHIP_UPDATE', { relationship: { id: ANN, type: 1, user: { id: ANN, username: 'ann' } } });
      rels.delete(BO);
      emit('RELATIONSHIP_REMOVE', { relationship: { id: BO, type: 1, nickname: 'never this nickname' } });
      rels.set(CY, { type: 2, since: '2026-11-09T02:00:00.000Z' });
      emit('RELATIONSHIP_ADD', { relationship: { id: CY, type: 2, user: { id: CY, username: 'cy' } } });
      const sent = dispatched(p);
      expect(sent.map((m) => m.data.since)).toEqual(['2026-11-09T00:00:00.000Z', '2026-11-09T01:00:00.000Z', null, '2026-11-09T02:00:00.000Z']);
      expect(JSON.stringify(sent)).not.toContain('never');
      const events = sent.flatMap((m) => relationshipEvents(m.event, m.data, st));
      expect(events.map((e) => (e.t === 'relationship' ? `${e.fact.identity} ${e.fact.relationship}` : e.t === 'identity' ? `identity ${e.identity.nativeId}` : e.t))).toEqual([
        `identity ${DEE}`,
        `${DEE} requested`,
        `identity ${ANN}`,
        'requestGone',
        `${ANN} friend`,
        `${BO} stranger`,
        `identity ${CY}`,
        `${CY} blocked`,
      ]);
      expect(events.find((e) => e.t === 'relationship' && e.fact.identity === ANN)).toEqual({ t: 'relationship', fact: { identity: ANN, relationship: 'friend', since: Date.UTC(2026, 10, 9, 1) } });
    });

    test("remove: unfriend, cancel, unblock through the client's removeRelationship, once the store shows it gone", async () => {
      for (const [who, type] of [[BO, 1], [DEE, 4], [CY, 2]] as const) {
        rels.set(who, { type });
        const p = addingPage();
        const r = await ask(p, { kind: 'friendRemove', userId: who, type });
        expect(calls).toEqual([['removeRelationship', who, { location: 'Friends' }]]);
        expect(restCalls).toEqual([]);
        expect(r.result).toEqual({ user: expect.objectContaining({ id: who }), relationship: 0 });
        expect(rels.has(who)).toBe(false);
        const st = state();
        st.friends.add(who);
        expect(removeOutcome(r.result, who, st).result).toEqual({ identity: who, relationship: 'stranger' });
        expect(st.friends.has(who)).toBe(false);
      }
    });

    test('remove: refused, with nothing sent, when it changed, or is not one to remove', async () => {
      rels.set(BO, { type: 1 });
      rels.set(ANN, { type: 3 });
      const p = addingPage();
      expect(await ask(p, { kind: 'friendRemove', userId: BO, type: 4 })).toMatchObject({ ok: false, error: 'That changed; look again' });
      expect(await ask(p, { kind: 'friendRemove', userId: CY, type: 2 })).toMatchObject({ ok: false, error: 'That changed; look again' });
      expect(await ask(p, { kind: 'friendRemove', userId: ANN, type: 3 })).toMatchObject({ ok: false, error: expect.stringContaining('Only a friend') });
      expect(await ask(p, { kind: 'friendRemove', userId: SELF, type: 1 })).toMatchObject({ ok: false, error: 'That is this account' });
      expect(await ask(p, { kind: 'friendRemove', userId: '../x', type: 1 })).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
      expect(await ask(addingPage({ modules: false }), { kind: 'friendRemove', userId: BO, type: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("Discord's own friends module was not found") });
    });
  });
  describe('adding people to a group DM', () => {
    /** The group as the client's ChannelStore keeps it: recipients by user id. A PUT that goes through adds them, as the gateway's CHANNEL_RECIPIENT_ADD would. */
    let group: { id: string; type: number; name: null; ownerId: string; recipients: string[] };
    const DM = '600000000000000001';
    const puts: string[] = [];
    let putAnswer: (userId: string) => Promise<unknown> = async () => ({ status: 204, body: null });
    function groupPage(recipients: string[] = [ANN]) {
      group = { id: GROUP, type: 3, name: null, ownerId: SELF, recipients: [...recipients] };
      channelStore.getChannel = (id: string) => (id === GROUP ? group : id === DM ? { id: DM, type: 1, recipients: [ANN] } : null);
      const p = addingPage();
      puts.length = 0;
      rest.put = (req: any) => {
        puts.push(req.url);
        const id = req.url.split('/').pop();
        return putAnswer(id).then((res) => ((group.recipients = [...group.recipients, id]), res));
      };
      return p;
    }
    afterEach(() => {
      putAnswer = async () => ({ status: 204, body: null });
    });

    test("a friend goes in with one PUT through the client's REST module; the reply names them and the group after", async () => {
      rels.set(BO, { type: 1 });
      const opened = privateChannels.opened;
      const r = await ask(groupPage(), { kind: 'addRecipients', channelId: GROUP, userIds: [BO] });
      expect(puts).toEqual([`/channels/${GROUP}/recipients/${BO}`]);
      expect(restCalls).toEqual([]);
      expect(calls).toEqual([]);
      expect(privateChannels.opened).toBe(opened);
      expect(r.result).toEqual({
        added: [BO],
        failed: [],
        users: [expect.objectContaining({ id: BO, username: 'bo' })],
        channel: expect.objectContaining({ id: GROUP, type: 3, recipients: [expect.objectContaining({ id: ANN }), expect.objectContaining({ id: BO })] }),
      });
      // The adapter's facts: who, then the group with them in it.
      const facts = addedFacts(GROUP, r.result, state());
      expect(facts.map((e) => e.t)).toEqual(['identity', 'conversation']);
      expect(facts[1]).toMatchObject({ conversation: { nativeId: GROUP, shape: 'group', participants: [SELF, ANN, BO], name: 'Ann, bo' } });
    });

    test('someone not a friend is refused with no request, and the rest still go', async () => {
      rels.set(BO, { type: 1 });
      rels.set(CY, { type: 4 }); // a request sent is not a friend yet
      const r = await ask(groupPage(), { kind: 'addRecipients', channelId: GROUP, userIds: [CY, DEE, BO] });
      expect(puts).toEqual([`/channels/${GROUP}/recipients/${BO}`]);
      expect(r.result.added).toEqual([BO]);
      expect(r.result.failed).toEqual([
        { id: CY, reason: 'Discord adds only your friends to a group.' },
        { id: DEE, reason: 'Discord adds only your friends to a group.' },
      ]);
    });

    test("a PUT Discord refuses is that person's, in Discord's words; the next one still goes", async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      putAnswer = (id) => (id === BO ? Promise.reject({ status: 400, body: { code: 50013, message: 'Missing Permissions' } }) : Promise.resolve({ status: 204, body: null }));
      const r = await ask(groupPage(), { kind: 'addRecipients', channelId: GROUP, userIds: [BO, DEE] });
      expect(puts).toEqual([`/channels/${GROUP}/recipients/${BO}`, `/channels/${GROUP}/recipients/${DEE}`]);
      expect(r.result.added).toEqual([DEE]);
      expect(r.result.failed).toEqual([{ id: BO, reason: 'Missing Permissions.' }]);
      expect(r.result.users.map((u: any) => u.id)).toEqual([DEE]);
    });

    test('a rate limit stops the rest: each would meet it too', async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      putAnswer = () => Promise.reject({ status: 429, body: { message: 'You are being rate limited.', retry_after: 30 } });
      const r = await ask(groupPage(), { kind: 'addRecipients', channelId: GROUP, userIds: [BO, DEE] });
      expect(puts).toEqual([`/channels/${GROUP}/recipients/${BO}`]);
      const limited = 'Discord is limiting how often this account can add people to groups: try again in 30 seconds';
      expect(r.result).toMatchObject({ added: [], failed: [{ id: BO, reason: `${limited}.` }, { id: DEE, reason: `${limited}.` }] });
    });

    test('someone already in counts as in, with no request', async () => {
      rels.set(ANN, { type: 1 });
      const r = await ask(groupPage(), { kind: 'addRecipients', channelId: GROUP, userIds: [ANN] });
      expect(puts).toEqual([]);
      expect(r.result).toMatchObject({ added: [ANN], failed: [] });
    });

    test('only a group DM: a 1:1 DM (where a PUT makes a new group) or a server channel is refused before any request', async () => {
      rels.set(BO, { type: 1 });
      const opened = privateChannels.opened;
      const p = groupPage();
      expect(await ask(p, { kind: 'addRecipients', channelId: DM, userIds: [BO] })).toMatchObject({ ok: false, error: 'Discord adds people only to group DMs' });
      expect(await ask(p, { kind: 'addRecipients', channelId: '300000000000000200', userIds: [BO] })).toMatchObject({ ok: false, error: 'Discord adds people only to group DMs' });
      expect(await ask(p, { kind: 'addRecipients', channelId: '../users/@me', userIds: [BO] })).toMatchObject({ ok: false });
      expect(await ask(p, { kind: 'addRecipients', channelId: GROUP, userIds: [] })).toMatchObject({ ok: false });
      expect(puts).toEqual([]);
      expect(privateChannels.opened).toBe(opened);
    });

    test('CHANNEL_RECIPIENT_ADD and _REMOVE are forwarded with the group as the store has it, and become its participants', () => {
      const p = groupPage([ANN, BO]);
      const from = p.posted.length;
      emit('CHANNEL_RECIPIENT_ADD', { channelId: GROUP, user: { id: DEE, username: 'dee', email: 'never@forward.this' } });
      const add = p.posted.slice(from).find((m) => m.t === 'dispatch' && m.event === 'CHANNEL_RECIPIENT_ADD');
      expect(add.data).toEqual({ channelId: GROUP, user: expect.objectContaining({ id: DEE, username: 'dee' }), channel: expect.objectContaining({ id: GROUP, type: 3 }) });
      expect(JSON.stringify(add.data)).not.toContain('never');
      // The store had not taken them in here; the fact has them anyway.
      const st = state();
      expect(translateDispatch('CHANNEL_RECIPIENT_ADD', add.data, st).at(-1)).toMatchObject({ t: 'conversation', conversation: { nativeId: GROUP, participants: [SELF, ANN, BO, DEE] } });
      group.recipients = [ANN];
      emit('CHANNEL_RECIPIENT_REMOVE', { channelId: GROUP, user: { id: BO, username: 'bo' } });
      const gone = p.posted.slice(from).find((m) => m.t === 'dispatch' && m.event === 'CHANNEL_RECIPIENT_REMOVE');
      expect(translateDispatch('CHANNEL_RECIPIENT_REMOVE', gone.data, st)).toEqual([{ t: 'conversation', conversation: expect.objectContaining({ nativeId: GROUP, participants: [SELF, ANN] }) }]);
    });
  });

  describe('making a group DM', () => {
    const NEW = '600000000000000077';
    const OLD = '600000000000000066';
    let made: any = null;
    let others: Record<string, any> = {};
    const ensured: unknown[] = [];
    const posts: any[] = [];
    const patches: any[] = [];
    // Discord's answer to the POST: the new group, recipients as user objects.
    const groupBody = (ids: string[], over: Record<string, unknown> = {}) => ({ id: NEW, type: 3, name: null, owner_id: SELF, recipients: ids.map((id) => ({ id, username: users[id]?.username })), ...over });
    let postAnswer: (req: any) => Promise<any> = async (req) => ({ status: 200, body: groupBody(req.body.recipients) });
    let patchAnswer: (req: any) => Promise<unknown> = async (req) => ({ status: 200, body: { id: NEW, type: 3, name: req.body.name, recipients: [] } });
    /**
     * PrivateChannelActions as the client has it (build 670026, read from its bundle 2026-11-11): _getRecipients keeps a
     * list as it is and wraps one id; ensurePrivateChannel POSTs /users/@me/channels { recipients } through the REST
     * client (oldFormErrors, rejectWithError, no retries), makes a channel record of the answer, dispatches CHANNEL_CREATE
     * with it (so the store has it before the call resolves), and resolves to its id. Nothing moves the page.
     */
    function clientActions(ensure?: (e: unknown) => Promise<unknown>) {
      privateChannels._getRecipients = (e: unknown) => (e != null ? (Array.isArray(e) ? e : [e]) : []);
      privateChannels.ensurePrivateChannel =
        ensure ??
        async function (this: any, e: unknown) {
          ensured.push(e);
          const t = this._getRecipients(e);
          const n = await rest.post({ url: '/users/@me/channels', body: { recipients: t }, oldFormErrors: true, rejectWithError: true });
          const a = { id: n.body.id, type: n.body.type, name: n.body.name, ownerId: n.body.owner_id, recipients: n.body.recipients.map((r: any) => r.id) };
          made = a;
          emit('CHANNEL_CREATE', { type: 'CHANNEL_CREATE', channel: a });
          return a.id;
        };
    }
    function makingPage(ensure?: (e: unknown) => Promise<unknown>) {
      made = null;
      others = {};
      ensured.length = 0;
      posts.length = 0;
      patches.length = 0;
      clientActions(ensure);
      channelStore.getChannel = (id: string) => (made && id === made.id ? made : (others[id] ?? null));
      channelStore.getMutablePrivateChannels = () => ({ ...others, ...(made ? { [made.id]: made } : {}) });
      const p = addingPage();
      rest.post = (req: any) => (posts.push(req), postAnswer(req));
      rest.patch = (req: any) => {
        patches.push(req);
        return patchAnswer(req).then((r: any) => ((made.name = req.body.name), r));
      };
      return p;
    }
    const finders = (p: any) => p.posted.filter((m: any) => m.t === 'finders').at(-1).results;
    afterEach(() => {
      delete privateChannels.ensurePrivateChannel;
      delete privateChannels._getRecipients;
      delete channelStore.getMutablePrivateChannels;
      postAnswer = async (req) => ({ status: 200, body: groupBody(req.body.recipients) });
      patchAnswer = async (req) => ({ status: 200, body: { id: NEW, type: 3, name: req.body.name, recipients: [] } });
    });

    test("found only where ensurePrivateChannel has the client's shape (a list kept as a list, one POST of recipients, no retries, its own CHANNEL_CREATE); createGroup only then", () => {
      const without = finders(addingPage());
      expect(without.GroupDMCreate).toBe(false);
      expect(addCapabilities(without)).not.toContain('createGroup');
      const found = finders(makingPage());
      expect(found).toMatchObject({ PrivateChannelActions: true, GroupDMCreate: true, RelationshipStore: true, Rest: true });
      expect(addCapabilities(found)).toEqual(['resolve', 'join', 'connect', 'requests', 'relationships', 'disconnect', 'addMembers', 'createGroup']);
      // Shapes it must not take: one that would send a second try, one that waits for the gateway without saying
      // which channel, one whose _getRecipients takes the first of a list.
      const shapes = [
        async function (this: any, e: unknown) {
          const t = this._getRecipients(e);
          const n = await rest.post({ url: '/users/@me/channels', body: { recipients: t }, retries: 3 });
          emit('CHANNEL_CREATE', { channel: n.body });
          return n.body.id;
        },
        async function (this: any, e: unknown) {
          const t = this._getRecipients(e);
          return rest.post({ url: '/users/@me/channels', body: { recipients: t } });
        },
      ];
      for (const s of shapes) expect(finders(makingPage(s)).GroupDMCreate).toBe(false);
      makingPage();
      privateChannels._getRecipients = (e: unknown) => [Array.isArray(e) ? e[0] : e];
      expect(finders(addingPage()).GroupDMCreate).toBe(false);
    });

    test("friends go in with one call of the client's own ensurePrivateChannel (one POST, never its navigating openPrivateChannel); the name after, as the group's settings rename it", async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      rels.set(CY, { type: 4 }); // a request sent is not a friend yet
      const opened = privateChannels.opened;
      const r = await ask(makingPage(), { kind: 'createGroupDM', userIds: [BO, CY, DEE, BO, SELF], name: '  Crag rats ' });
      expect(ensured).toEqual([[BO, DEE]]);
      expect(posts).toEqual([{ url: '/users/@me/channels', body: { recipients: [BO, DEE] }, oldFormErrors: true, rejectWithError: true }]);
      expect(privateChannels.opened).toBe(opened);
      expect(patches).toEqual([{ url: `/channels/${NEW}`, query: undefined, body: { name: 'Crag rats' } }]);
      expect(restCalls).toEqual([]); // nothing else through the REST client
      expect(r.result).toEqual({
        channelId: NEW,
        added: [BO, DEE],
        failed: [{ id: CY, reason: 'Discord adds only your friends to a group.' }],
        users: [expect.objectContaining({ id: BO, username: 'bo' }), expect.objectContaining({ id: DEE, username: 'dee' })],
        channel: expect.objectContaining({ id: NEW, type: 3, name: 'Crag rats', recipients: [expect.objectContaining({ id: BO }), expect.objectContaining({ id: DEE })] }),
        notes: [],
        phases: [
          { name: 'friends checked', ms: expect.any(Number) },
          { name: 'group made', ms: expect.any(Number) },
          { name: 'group in the store', ms: expect.any(Number) },
          { name: 'named', ms: expect.any(Number) },
        ],
      });
      // The adapter's facts: who, then the group with them in it.
      const facts = addedFacts(NEW, r.result, state());
      expect(facts.map((e) => e.t)).toEqual(['identity', 'identity', 'conversation']);
      expect(facts[2]).toMatchObject({ conversation: { nativeId: NEW, shape: 'group', name: 'Crag rats', participants: [SELF, BO, DEE] } });
    });

    test('no name: no PATCH, and the client names it after its people', async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      const r = await ask(makingPage(), { kind: 'createGroupDM', userIds: [BO, DEE], name: '   ' });
      expect(ensured).toEqual([[BO, DEE]]);
      expect(patches).toEqual([]);
      expect(r.result).toMatchObject({ channelId: NEW, added: [BO, DEE], failed: [], notes: [] });
      expect(addedFacts(NEW, r.result, state()).at(-1)).toMatchObject({ conversation: { nativeId: NEW, shape: 'group', name: 'bo, dee' } });
    });

    test('a group with exactly these people already there: a new one is made, as the client does after asking, and the reply says so; one Discord gave back is said too', async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      let p = makingPage();
      others[OLD] = { id: OLD, type: 3, name: 'Old crag rats', recipients: [DEE, BO] };
      others['600000000000000055'] = { id: '600000000000000055', type: 3, recipients: [BO, DEE, CY] }; // not the same people
      let r = await ask(p, { kind: 'createGroupDM', userIds: [BO, DEE] });
      expect(posts.length).toBe(1);
      expect(r.result).toMatchObject({ channelId: NEW, notes: ['You already had a group DM with exactly these people; Discord made a new one, as its own New Group DM does once you confirm.'] });
      p = makingPage();
      others[OLD] = { id: OLD, type: 3, name: 'Old crag rats', recipients: [DEE, BO] };
      postAnswer = async (req) => ({ status: 200, body: groupBody(req.body.recipients, { id: OLD, name: 'Old crag rats' }) });
      r = await ask(p, { kind: 'createGroupDM', userIds: [BO, DEE] });
      expect(r.result).toMatchObject({ channelId: OLD, added: [BO, DEE], notes: ['Discord gave back the group DM you already had with exactly these people: no new group was made.'] });
    });

    test('refused before anything is sent: fewer than 2 friends, more than 9, a name past 100, no module', async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      const p = makingPage();
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO] })).toMatchObject({ ok: false, error: 'A Discord group DM starts with at least 2 friends' });
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO, CY] })).toMatchObject({ ok: false, error: 'Discord adds only your friends to a group. A Discord group DM starts with at least 2 friends' });
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO, SELF] })).toMatchObject({ ok: false });
      const ten = Array.from({ length: 10 }, (_, i) => `4000000000000001${String(i).padStart(2, '0')}`);
      for (const id of ten) rels.set(id, { type: 1 });
      expect(await ask(p, { kind: 'createGroupDM', userIds: ten })).toMatchObject({ ok: false, error: expect.stringContaining('at most 9') });
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO, DEE], name: 'x'.repeat(101) })).toMatchObject({ ok: false, error: expect.stringContaining('at most 100 characters') });
      expect(ensured).toEqual([]);
      expect(posts).toEqual([]);
      delete privateChannels.ensurePrivateChannel;
      expect(await ask(addingPage(), { kind: 'createGroupDM', userIds: [BO, DEE] })).toMatchObject({ ok: false, error: expect.stringContaining("Discord's own action for a new group DM was not found") });
    });

    test("Discord refusing it is said in its words (a form error as the client's REST module flattens it too), a rate limit with when; sent once, nothing renamed", async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      postAnswer = () => Promise.reject({ status: 429, body: { message: 'You are being rate limited.', retry_after: 30 } });
      let p = makingPage();
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO, DEE], name: 'Crag rats' })).toMatchObject({ ok: false, error: 'Discord is limiting how often this account can make group DMs: try again in 30 seconds' });
      expect(posts.length).toBe(1);
      postAnswer = () => Promise.reject({ status: 400, body: { code: 30004, message: 'Maximum number of recipients reached (10)' } });
      p = makingPage();
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO, DEE], name: 'Crag rats' })).toMatchObject({ ok: false, error: 'Maximum number of recipients reached (10)' });
      expect(posts.length).toBe(1);
      // oldFormErrors: Discord's 50035 comes on as { field: [sentence] }, its code and message gone.
      postAnswer = () => Promise.reject({ status: 400, body: { recipients: ['Some of these people cannot be added.'] } });
      p = makingPage();
      expect(await ask(p, { kind: 'createGroupDM', userIds: [BO, DEE], name: 'Crag rats' })).toMatchObject({ ok: false, error: 'Some of these people cannot be added.' });
      expect(posts.length).toBe(1);
      expect(patches).toEqual([]);
      expect(made).toBe(null);
    });

    test('a name Discord refuses leaves the group made, with a note; a DM where a group was asked for is an error', async () => {
      rels.set(BO, { type: 1 });
      rels.set(DEE, { type: 1 });
      patchAnswer = () => Promise.reject({ status: 400, body: { code: 50035, message: 'Invalid Form Body' } });
      const r = await ask(makingPage(), { kind: 'createGroupDM', userIds: [BO, DEE], name: 'Crag rats' });
      expect(r.result).toMatchObject({ channelId: NEW, added: [BO, DEE], failed: [], notes: ['Discord made the group DM but did not take its name: Invalid Form Body.'] });
      expect(r.result.channel).toMatchObject({ id: NEW, type: 3, name: null });
      // A Discord that answered with a 1:1 DM with the first of them.
      postAnswer = async () => ({ status: 200, body: { id: '600000000000000088', type: 1, name: null, recipients: [{ id: BO }] } });
      expect(await ask(makingPage(), { kind: 'createGroupDM', userIds: [BO, DEE] })).toMatchObject({ ok: false, error: expect.stringContaining('opened a DM, not a group') });
      expect(patches).toEqual([]);
    });
  });
});

describe('network search and member walks', () => {
  const SELF = '100000000000000001';
  const G = '200000000000000001';
  const CH = '300000000000000001';
  const THREAD = '300000000000000099';
  const DM = '600000000000000001';
  const ALICE = '400000000000000001';
  const BOB = '400000000000000002';
  const channels: Record<string, any> = {
    [CH]: { id: CH, type: 0, guild_id: G, name: 'general' },
    [DM]: { id: DM, type: 1, recipients: [] },
  };
  const requested: unknown[][] = [];
  const dispatched: any[] = [];
  let restCalls: any[] = [];
  let answer: (req: any) => Promise<any> = async () => ({ status: 200, body: { total_results: 0, messages: [] } });

  function searchPage(opts: { actions?: boolean } = {}) {
    handlers.clear();
    me = { id: SELF, username: 'me' };
    guildRecords.clear();
    guildRecords.set(G, { id: G, name: 'Big server' });
    channelStore.getChannel = (id: string) => channels[id] ?? null;
    requested.length = 0;
    dispatched.length = 0;
    restCalls = [];
    rest.get = (req: any) => (restCalls.push(req), answer(req));
    dispatcher.dispatch = ((a: any) => void dispatched.push(a)) as any;
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      members: (_m: any, e: any) => {
        e.n = store('GuildMemberCountStore', { getMemberCount: () => 1200 });
        e.g = store('GuildRoleStore', { getRoles: () => ({ [G]: { id: G, name: '@everyone', position: 0 }, '201': { id: '201', name: 'Helper', position: 1 } }) });
        if (opts.actions) e.q = { requestMembers: (...a: unknown[]) => void requested.push(a), requestMembersById() {}, searchRecentMembers: (...a: unknown[]) => void requested.push(['recent', ...a]) };
      },
    });
    web.T('stores');
    web.T('members');
    p.tick();
    return p;
  }
  afterEach(() => {
    dispatcher.dispatch = () => {};
    channelStore.getChannel = () => null;
    guildRecords.clear();
    answer = async () => ({ status: 200, body: { total_results: 0, messages: [] } });
    me = null;
  });
  const reply = (p: ReturnType<typeof page>, id: string) => p.posted.find((m) => m.t === 'reply' && m.id === id);
  async function ask(p: ReturnType<typeof page>, id: string, c: unknown) {
    p.win.down({ t: 'cmd', id, cmd: c });
    await Bun.sleep(0);
    await Bun.sleep(0);
    return reply(p, id);
  }
  const raw = (id: string, channel = CH, extra: Record<string, unknown> = {}) => ({ id, channel_id: channel, author: { id: ALICE, username: 'alice' }, content: `hit ${id}`, timestamp: '2026-01-01T00:00:00.000Z', ...extra });

  test("a server's search: one GET through the client's REST module, the hit out of each group, its thread and people", async () => {
    answer = async () => ({
      status: 200,
      body: {
        total_results: 31,
        messages: [[raw('901', CH, { hit: true })], [raw('899', THREAD), raw('902', THREAD, { hit: true })]],
        threads: [{ id: THREAD, type: 11, guild_id: G, parent_id: CH, name: 'a thread', thread_metadata: { archived: true, locked: false } }],
        // As discord.py-self reads it: your memberships of the hits' threads, not people.
        members: [{ id: THREAD, user_id: BOB, join_timestamp: '2026-01-01T00:00:00.000Z', flags: 1 }],
      },
    });
    const p = searchPage();
    const params = { content: 'borrow checker', author_id: [ALICE], sort_by: 'timestamp', sort_order: 'desc', include_nsfw: true };
    const r = await ask(p, 's1', { kind: 'search', guildId: G, params });
    expect(restCalls).toEqual([{ url: `/guilds/${G}/messages/search`, query: params, body: undefined }]);
    expect(r).toMatchObject({ ok: true });
    expect(r.result.total).toBe(31);
    expect(r.result.messages.map((m: any) => m.id)).toEqual(['901', '902']);
    expect(r.result.messages[0]).toMatchObject({ guild_id: G, channel_id: CH, content: 'hit 901' });
    expect(r.result.channels).toEqual([expect.objectContaining({ id: THREAD, type: 11, parent_id: CH }), expect.objectContaining({ id: CH, guild_id: G })]);
    // Thread memberships are not people: the authors come with the hits.
    expect(r.result.users).toEqual([]);
  });

  test("a channel's threads: DiscordChatExporter's user route, active or archived, at an offset", async () => {
    answer = async () => ({ status: 200, body: { threads: [{ id: THREAD, type: 11, guild_id: G, parent_id: CH, name: 'a thread', thread_metadata: { archived: true } }], has_more: true } });
    const p = searchPage();
    const r = await ask(p, 't1', { kind: 'threads', channelId: CH, archived: true, offset: 25 });
    expect(restCalls).toEqual([{ url: `/channels/${CH}/threads/search`, query: { archived: true, sort_by: 'last_message_time', sort_order: 'desc', offset: 25 }, body: undefined }]);
    expect(r.result).toEqual({ threads: [expect.objectContaining({ id: THREAD, parent_id: CH })], more: true, messages: [] });
    // The list is Discord's search index: a 202 (resolved, as the live client does) is a wait, not "no threads".
    answer = async () => ({ status: 202, body: { message: 'Index not yet available. Try again later', code: 110000, documents_indexed: 0, retry_after: 3 } });
    expect((await ask(p, 't2', { kind: 'threads', channelId: CH, archived: false, offset: 0 })).result).toEqual({ indexing: 3, threads: [], more: false });
  });

  test("a server channel is searched as its server's, narrowed to it; a DM by its own search", async () => {
    const p = searchPage();
    await ask(p, 's2', { kind: 'search', channelId: CH, params: { content: 'x' } });
    await ask(p, 's3', { kind: 'search', channelId: DM, params: { content: 'x' } });
    expect(restCalls.map((c) => [c.url, c.query])).toEqual([
      [`/guilds/${G}/messages/search`, { content: 'x', channel_id: [CH] }],
      [`/channels/${DM}/messages/search`, { content: 'x' }],
    ]);
  });

  test('202 is a wait, with its retry_after, whether the REST client resolves or rejects it', async () => {
    answer = async () => ({ status: 202, body: { message: 'Index not yet available. Try again later', code: 110000, documents_indexed: 0, retry_after: 2 } });
    const p = searchPage();
    expect((await ask(p, 'w1', { kind: 'search', guildId: G, params: {} })).result).toEqual({ indexing: 2 });
    answer = () => Promise.reject({ status: 202, body: { documents_indexed: 0 } });
    expect((await ask(p, 'w2', { kind: 'search', guildId: G, params: {} })).result).toEqual({ indexing: null });
    answer = () => Promise.reject({ status: 429, body: { message: 'You are being rate limited.', retry_after: 7 } });
    expect(await ask(p, 'w3', { kind: 'search', guildId: G, params: {} })).toMatchObject({ ok: false, retryAfter: 7 });
  });

  test("a walk asks once through the client's requestMembers, and answers with that server's chunk", async () => {
    const p = searchPage({ actions: true });
    p.win.down({ t: 'cmd', id: 'm1', cmd: { kind: 'walkMembers', guildId: G, query: 'al', limit: 500 } });
    await Bun.sleep(0);
    expect(requested).toEqual([[G, 'al', 100, false]]);
    expect(dispatched).toEqual([]);
    expect(reply(p, 'm1')).toBeUndefined();
    // Another server's chunk is not this walk's.
    emit('GUILD_MEMBERS_CHUNK', { guildId: '200000000000000002', members: [{ user: { id: BOB, username: 'bob' } }], chunkIndex: 0, chunkCount: 1 });
    emit('GUILD_MEMBERS_CHUNK', { guildId: G, members: [{ user: { id: ALICE, username: 'alice' }, roles: ['201', G], nick: 'Al', joined_at: '2025-01-01T00:00:00.000Z' }], chunkIndex: 0, chunkCount: 1 });
    await Bun.sleep(0);
    expect(reply(p, 'm1')).toMatchObject({
      ok: true,
      result: { guildId: G, total: 1200, members: [{ user: expect.objectContaining({ id: ALICE }), nick: 'Al', roles: ['Helper'], joined_at: '2025-01-01T00:00:00.000Z' }] },
    });
    // The walk's chunk went to the walk, not the passive path; the other server's went the passive way.
    const passive = p.posted.filter((m) => m.t === 'dispatch' && m.event === 'GUILD_MEMBERS_CHUNK').map((m) => m.data.guildId);
    expect(passive).toEqual(['200000000000000002']);
  });

  test('without that module, the GUILD_MEMBERS_REQUEST action its gateway store sends; a batch is the whole answer, a lone chunk waits a little', async () => {
    const p = searchPage();
    p.win.down({ t: 'cmd', id: 'm2', cmd: { kind: 'walkMembers', guildId: G, query: 'a', limit: 100 } });
    await Bun.sleep(0);
    expect(dispatched).toEqual([{ type: 'GUILD_MEMBERS_REQUEST', guildIds: [G], query: 'a', limit: 100, presences: false }]);
    // Someone else's by-id request (it carries a nonce) is not this walk's; the live client batches chunks without
    // chunk_index or chunk_count.
    emit('GUILD_MEMBERS_CHUNK_BATCH', { chunks: [{ guildId: G, nonce: 'theirs', members: [{ user: { id: BOB, username: 'bob' } }] }] });
    await Bun.sleep(0);
    expect(reply(p, 'm2')).toBeUndefined();
    emit('GUILD_MEMBERS_CHUNK_BATCH', { chunks: [{ guildId: G, members: [{ user: { id: ALICE, username: 'alice' } }, { user: { id: BOB, username: 'bob' } }], notFound: [], nonce: null }] });
    await Bun.sleep(0);
    expect(reply(p, 'm2')?.result.members.map((m: any) => m.user.id)).toEqual([ALICE, BOB]);
    p.win.down({ t: 'cmd', id: 'm2b', cmd: { kind: 'walkMembers', guildId: G, query: 'b', limit: 100 } });
    await Bun.sleep(0);
    emit('GUILD_MEMBERS_CHUNK', { guildId: G, members: [{ user: { id: BOB, username: 'bob' } }] });
    await Bun.sleep(0);
    expect(reply(p, 'm2b')).toBeUndefined();
    p.tick(); // the wait after a chunk that does not say it is the last
    await Bun.sleep(0);
    expect(reply(p, 'm2b')?.result.members.map((m: any) => m.user.id)).toEqual([BOB]);
    // After the walk, chunks are passive again: this one, and the by-id answer the walk left alone.
    emit('GUILD_MEMBERS_CHUNK', { guildId: G, members: [{ user: { id: BOB, username: 'bob' } }] });
    expect(p.posted.filter((m) => m.t === 'dispatch' && m.event === 'GUILD_MEMBERS_CHUNK').map((m) => m.data.members[0].user.id)).toEqual([BOB, BOB]);
  });

  test("the client's own batched chunks go the passive way, chunk by chunk; a walk's never do, whichever hears them first", async () => {
    const p = searchPage({ actions: true });
    const passive = () => p.posted.filter((m) => m.t === 'dispatch' && m.event === 'GUILD_MEMBERS_CHUNK').map((m) => m.data.members.map((x: any) => x.user.id));
    // No walk: every chunk of the batch, as a GUILD_MEMBERS_CHUNK; an empty one says nothing.
    emit('GUILD_MEMBERS_CHUNK_BATCH', {
      chunks: [
        { guildId: G, members: [{ user: { id: ALICE, username: 'alice' }, roles: ['201'] }], notFound: [], nonce: 'by-id' },
        { guildId: '200000000000000002', members: [{ user: { id: BOB, username: 'bob' } }], notFound: [] },
        { guildId: G, members: [], notFound: [ALICE] },
      ],
    });
    expect(passive()).toEqual([[ALICE], [BOB]]);
    expect(p.posted.find((m) => m.t === 'dispatch' && m.event === 'GUILD_MEMBERS_CHUNK')?.data).toMatchObject({ guildId: G, members: [{ nick: null, roles: ['Helper'] }] });
    expect(p.posted.some((m) => m.t === 'dispatch' && m.event === 'GUILD_MEMBERS_CHUNK_BATCH')).toBe(false);
    // A walk waits on G: its answer is the walk's; someone else's by-id answer for G in the same batch is not.
    p.win.down({ t: 'cmd', id: 'pw1', cmd: { kind: 'walkMembers', guildId: G, query: 'a', limit: 100 } });
    await Bun.sleep(0);
    const before = passive().length;
    emit('GUILD_MEMBERS_CHUNK_BATCH', {
      chunks: [
        { guildId: G, members: [{ user: { id: ALICE, username: 'alice' } }], notFound: [], nonce: null },
        { guildId: G, members: [{ user: { id: BOB, username: 'bob' } }], notFound: [], nonce: 'by-id' },
      ],
    });
    await Bun.sleep(0);
    expect(reply(p, 'pw1')?.result.members.map((m: any) => m.user.id)).toEqual([ALICE]);
    expect(passive().slice(before)).toEqual([[BOB]]);
    // The walk's subscriber first this time: it is over before the passive path hears its chunk, which stays the walk's.
    p.win.down({ t: 'cmd', id: 'pw2', cmd: { kind: 'walkMembers', guildId: G, query: 'b', limit: 100 } });
    await Bun.sleep(0);
    handlers.get('GUILD_MEMBERS_CHUNK_BATCH')!.reverse();
    const n = passive().length;
    emit('GUILD_MEMBERS_CHUNK_BATCH', { chunks: [{ guildId: G, members: [{ user: { id: BOB, username: 'bob' } }], notFound: [], nonce: null }] });
    await Bun.sleep(0);
    expect(reply(p, 'pw2')?.result.members.map((m: any) => m.user.id)).toEqual([BOB]);
    expect(passive().length).toBe(n);
  });

  test('nothing back in time is an empty walk; a server not joined is refused before any request', async () => {
    const p = searchPage({ actions: true });
    p.win.down({ t: 'cmd', id: 'm3', cmd: { kind: 'walkMembers', guildId: G, query: 'zz', limit: 100 } });
    await Bun.sleep(0);
    p.tick();
    await Bun.sleep(0);
    expect(reply(p, 'm3')).toMatchObject({ ok: true, result: { guildId: G, members: [], total: 1200 } });
    requested.length = 0;
    expect(await ask(p, 'm4', { kind: 'walkMembers', guildId: '299999999999999999', query: 'a', limit: 100 })).toMatchObject({ ok: false, error: 'this account is not in that server' });
    // Never an empty query by name: a user account may not ask for everyone.
    expect(await ask(p, 'm5', { kind: 'walkMembers', guildId: G, query: '', limit: 100 })).toMatchObject({ ok: false, error: expect.stringContaining('needs a query') });
    expect(requested).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  test("a recent page through searchRecentMembers from the last page's earliest member; a full page has a next, a short one ends", async () => {
    const p = searchPage({ actions: true });
    p.win.down({ t: 'cmd', id: 'r1', cmd: { kind: 'walkMembers', guildId: G, query: '', limit: 100, recent: true, after: BOB } });
    await Bun.sleep(0);
    expect(requested).toEqual([['recent', G, { query: '', continuationToken: BOB }]]);
    // 1,000 in joining order, the earliest first: a full page.
    const full = Array.from({ length: 1000 }, (_, i) => ({ user: { id: String(500000000000000000n + BigInt(i)), username: `u${i}` }, joined_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString() }));
    emit('GUILD_MEMBERS_CHUNK_BATCH', { chunks: [{ guildId: G, members: full, notFound: [], nonce: null }] });
    await Bun.sleep(0);
    expect(reply(p, 'r1')).toMatchObject({ ok: true, result: { total: 1200, next: '500000000000000000' } });
    expect(reply(p, 'r1')?.result.members).toHaveLength(1000);
    p.win.down({ t: 'cmd', id: 'r2', cmd: { kind: 'walkMembers', guildId: G, query: '', limit: 100, recent: true, after: '500000000000000000' } });
    await Bun.sleep(0);
    emit('GUILD_MEMBERS_CHUNK_BATCH', { chunks: [{ guildId: G, members: full.slice(0, 200) }] });
    await Bun.sleep(0);
    expect(reply(p, 'r2')).toMatchObject({ ok: true, result: { next: null } });
    // Without the guild actions, the action the gateway store sends on.
    const q = searchPage();
    q.win.down({ t: 'cmd', id: 'r3', cmd: { kind: 'walkMembers', guildId: G, query: '', limit: 100, recent: true } });
    await Bun.sleep(0);
    expect(dispatched).toEqual([{ type: 'GUILD_SEARCH_RECENT_MEMBERS', guildId: G, query: '', continuationToken: undefined }]);
  });
});

describe('calls ringing you and voice channels (passive)', () => {
  const voiceStates = new Map<string, Record<string, any>>();
  const callCalls: string[] = [];
  const callActions = {
    call() {},
    ring: (c: string) => void callCalls.push(`ring ${c}`),
    stopRinging: async (c: string, r?: string[]) => void callCalls.push(`stop ${c}${r ? ` ${r}` : ''}`),
  };
  const voiceActions = { selectVoiceChannel: (c: string) => void callCalls.push(`select ${c}`), disconnect() {} };
  const channels: Record<string, any> = { dm: { id: 'dm', type: 1 }, vc: { id: 'vc', type: 2, guild_id: '100' } };

  function callsPage() {
    handlers.clear();
    callCalls.length = 0;
    voiceStates.clear();
    me = { id: '1', username: 'someone' };
    userStoreGetUser.value = (id: string) => ({ id, username: `user${id}` });
    channelStore.getChannel = (id: string) => channels[id] ?? null;
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      voice: (_m: any, e: any) => {
        e.v = store('VoiceStateStore', {
          getVoiceStatesForChannel: (c: string) => voiceStates.get(c) ?? {},
          getAllVoiceStates: () => ({ '100': voiceStates.get('vc') ?? {} }),
          addChangeListener() {},
          removeChangeListener() {},
        });
        e.c = callActions;
        e.a = voiceActions;
        e.u = store('AuthenticationStore', { getSessionId: () => 'session' });
      },
    });
    web.T('stores');
    web.T('voice');
    p.tick();
    const sent = (event: string) => p.posted.filter((x) => x.t === 'dispatch' && x.event === event).map((x) => x.data);
    return { p, sent };
  }
  afterEach(() => {
    channelStore.getChannel = () => null;
    userStoreGetUser.value = () => null;
    me = null;
  });
  const cmd = async (p: ReturnType<typeof page>, id: string, c: unknown) => {
    p.win.down({ t: 'cmd', id, cmd: c });
    await Bun.sleep(0);
    return p.posted.find((m) => m.t === 'reply' && m.id === id);
  };

  test('a call that rings you: who rings whom and who is in it, from what the gateway told the client', () => {
    const { p, sent } = callsPage();
    expect(p.posted.find((m) => m.t === 'finders').results.CallActions).toBe(true);
    voiceStates.set('dm', { '2': { userId: '2', channelId: 'dm' } });
    emit('CALL_CREATE', { channelId: 'dm', messageId: '900', ongoingRings: { '1': '2' } });
    voiceStates.set('dm', { '2': { userId: '2', channelId: 'dm' }, '1': { userId: '1', channelId: 'dm', selfMute: true } });
    emit('CALL_UPDATE', { channelId: 'dm', messageId: '900', ongoingRings: {} });
    emit('CALL_DELETE', { channelId: 'dm' });
    expect(sent('CALL_STATE')).toEqual([
      { channelId: 'dm', messageId: '900', ringing: ['1'], rungBy: { '1': '2' }, voice: ['2'], video: false, deleted: false },
      { channelId: 'dm', messageId: '900', ringing: [], rungBy: {}, voice: ['1', '2'], video: false, deleted: false },
      { channelId: 'dm', messageId: '900', ringing: [], rungBy: {}, voice: [], video: false, deleted: true },
    ]);
  });

  test("voice channels' people, at most once a second, with their status line", () => {
    const { p, sent } = callsPage();
    p.tick(); // the snapshot after connecting: nobody yet
    voiceStates.set('vc', { '5': { userId: '5', channelId: 'vc', selfVideo: true } });
    emit('VOICE_STATE_UPDATES', { voiceStates: [{ userId: '5', channelId: 'vc', oldChannelId: null }] });
    emit('VOICE_STATE_UPDATES', { voiceStates: [{ userId: '5', channelId: 'vc', oldChannelId: null }] });
    expect(sent('VOICE_PEOPLE')).toEqual([]);
    p.tick();
    expect(sent('VOICE_PEOPLE')).toEqual([{ channels: [{ channelId: 'vc', guildId: '100', members: [{ id: '5', muted: false, deafened: false, video: true, streaming: false }] }] }]);
    emit('VOICE_CHANNEL_STATUS_UPDATE', { id: 'vc', guildId: '100', status: 'playing chess' });
    expect(sent('VOICE_STATUS')).toEqual([{ channels: [{ channelId: 'vc', status: 'playing chess' }] }]);
  });

  test("Decline is the client's own stopRinging; joining a DM with ring rings the others after selecting it", async () => {
    const { p, sent } = callsPage();
    emit('CALL_CREATE', { channelId: 'dm', messageId: '900', ongoingRings: { '1': '2' } });
    expect(await cmd(p, 'd1', { kind: 'declineCall', channelId: 'dm' })).toMatchObject({ ok: true });
    expect(callCalls).toEqual(['stop dm']);
    expect(sent('CALL_STATE').at(-1)).toMatchObject({ ringing: [] });
    callCalls.length = 0;
    // A direct join (it waits for a voice server that never comes here): the ring follows the client's own join.
    (dispatcher as any).addInterceptor = () => {};
    try {
      p.win.down({ t: 'cmd', id: 'j1', cmd: { kind: 'call', call: 'x', op: 'join', channelId: 'dm', mode: 'direct', ring: true } });
      await Bun.sleep(0);
      expect(p.posted.find((m) => m.t === 'reply' && m.id === 'j1')).toBeUndefined();
      expect(callCalls).toEqual(['select dm', 'ring dm']);
    } finally {
      delete (dispatcher as any).addInterceptor;
    }
  });
});

describe('rich messages (src/rich.ts)', () => {
  /** Let the hook's command chain (a few promise steps) run, without waiting on a clock. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const members = new Map<string, { roles: string[] }>();
  function richPage() {
    handlers.clear();
    me = { id: '1', username: 'someone' };
    guildRecords.clear();
    guildRecords.set('100', { id: '100', name: 'Test server' });
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      rich: (_m: any, e: any) => {
        e.m = store('GuildMemberStore', { getMember: (g: string, u: string) => (g === '100' ? (members.get(u) ?? null) : null), getNick: () => null });
        e.g = store('GuildRoleStore', { getRoles: () => ({ '100': { id: '100', name: '@everyone', position: 0 }, '201': { id: '201', name: 'Helpers', position: 1, colorString: '#5c7cfa' } }) });
      },
    });
    web.T('stores');
    web.T('rich');
    p.tick();
    const sent = (event: string) => p.posted.filter((x) => x.t === 'dispatch' && x.event === event).map((x) => x.data);
    return { p, sent };
  }
  afterEach(() => {
    members.clear();
    guildRecords.clear();
    me = null;
  });

  test("a message's flags, components (the client's record shape), role names and command go along, whitelisted", () => {
    const { sent } = richPage();
    const message = {
      id: '900',
      channelId: '300',
      guildId: '100',
      author: { id: '5', username: 'bot', bot: true },
      content: 'ping <@&201>',
      timestamp: '2026-11-01T00:00:00.000Z',
      flags: 4096 | 32768,
      applicationId: '5',
      mentionRoles: ['201'],
      interactionMetadata: { type: 2, name: 'deploy', user: { id: '7', username: 'ann', secret: 'x' } },
      components: [
        { type: 1, id: '0', components: [{ type: 2, id: '0,0', customId: 'go', style: 1, label: 'Go', emoji: { id: '9', name: 'rocket', animated: false, extra: 1 } }] },
        { type: 12, id: '1', items: [{ media: { url: 'https://media.discordapp.net/a.png', proxyUrl: 'https://media.discordapp.net/a.png?p', contentType: 'image/png', width: 10, height: 10, loadingState: 2 }, description: 'alt', spoiler: false }] },
      ],
      attachments: [{ id: '1', filename: 'v.ogg', content_type: 'audio/ogg', url: 'https://cdn.discordapp.com/a/v.ogg', duration_secs: 3.5, waveform: 'AAA=', description: 'a voice note', flags: 8 }],
      embeds: [{ type: 'rich', rawTitle: 't', color: 0xff0000, footer: { text: 'f', iconProxyURL: 'https://images-ext-1.discordapp.net/f.png' }, timestamp: { toISOString: () => '2026-11-01T00:00:00.000Z' }, video: { url: 'https://www.youtube.com/embed/x', width: 1, height: 1 } }],
    };
    emit('MESSAGE_CREATE', { channelId: '300', message });
    const m = sent('MESSAGE_CREATE')[0].message;
    expect(m.flags).toBe(4096 | 32768);
    expect(m.application_id).toBe('5');
    expect(m.mention_roles).toEqual(['201']);
    expect(m.mention_role_names).toEqual([{ id: '201', name: 'Helpers', color: '#5c7cfa' }]);
    expect(m.interaction_metadata).toEqual({ type: 2, name: 'deploy', user: expect.objectContaining({ id: '7', username: 'ann' }) });
    expect(JSON.stringify(m)).not.toContain('secret');
    expect(m.components[0].components[0]).toMatchObject({ type: 2, custom_id: 'go', style: 1, label: 'Go', emoji: { id: '9', name: 'rocket', animated: false } });
    expect(m.components[1].items[0]).toEqual({ media: { url: 'https://media.discordapp.net/a.png', proxy_url: 'https://media.discordapp.net/a.png?p', content_type: 'image/png', width: 10, height: 10, attachment_id: undefined }, description: 'alt', spoiler: false });
    expect(JSON.stringify(m)).not.toContain('loadingState');
    expect(m.attachments[0]).toMatchObject({ duration_secs: 3.5, waveform: 'AAA=', description: 'a voice note', flags: 8 });
    expect(m.embeds[0]).toMatchObject({ color: 0xff0000, footer: { text: 'f', icon_url: 'https://images-ext-1.discordapp.net/f.png' }, timestamp: '2026-11-01T00:00:00.000Z', video: { url: 'https://www.youtube.com/embed/x', width: 1, height: 1 } });
  });

  test('your own roles go with the snapshot, and with a server joined; no one else is looked up', () => {
    members.set('1', { roles: ['201'] });
    members.set('5', { roles: ['201'] });
    const { p, sent } = richPage();
    emit('CONNECTION_OPEN');
    const snap = p.posted.find((x) => x.t === 'snapshot');
    expect(snap.data.selfRoles).toBeDefined();
    emit('GUILD_CREATE', { guild: { id: '100', name: 'Test server' } });
    expect(sent('GUILD_CREATE')[0].self_roles).toEqual(['201']);
  });

  test("a purge and a batch of reactions are forwarded", () => {
    const { sent } = richPage();
    emit('MESSAGE_DELETE_BULK', { ids: ['1', '2', 3], channelId: '300', guildId: '100' });
    expect(sent('MESSAGE_DELETE_BULK')).toEqual([{ ids: ['1', '2'], channelId: '300', guildId: '100' }]);
    emit('MESSAGE_REACTION_ADD_MANY', { channelId: '300', messageId: '900', reactions: [{ emoji: { id: null, name: '🔥' }, users: ['7'], reactionType: 0 }] });
    expect(sent('MESSAGE_REACTION_ADD_MANY')[0]).toMatchObject({ channelId: '300', messageId: '900', reactions: [{ emoji: { id: null, name: '🔥' }, reactionType: 0, users: [{ id: '7' }] }] });
  });

  test("a send AutoMod blocked comes back as an error that says so", async () => {
    const { p } = richPage();
    messageActions.sendMessage = (() => Promise.reject({ hasErr: false, status: 400, body: { code: 200000, message: 'Message was blocked by AutoMod' } })) as any;
    p.win.down({ t: 'cmd', id: 'am', cmd: { kind: 'send', channelId: '300', content: 'bad words', nonce: 'n9' } });
    await settle();
    expect(p.posted.find((m) => m.t === 'reply' && m.id === 'am')).toMatchObject({ ok: false, error: "This server's AutoMod blocked it: Message was blocked by AutoMod" });
  });
});
