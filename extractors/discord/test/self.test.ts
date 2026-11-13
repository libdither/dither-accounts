/**
 * The account itself (src/self.ts, hook.js "your own self"; dither-chat's docs/account-self.md): what the hook reads of
 * the client's stores (the required action, standing, settings proto, whom you ignore) and how it is said to the hub,
 * and block, ignore, notes, presence, sessions and the profile beyond the bio through the client's own modules.
 * The hook runs against a small replica of Discord's bundle (as hook.test.ts has it, cut down).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { mapProfile } from '../src/profile.ts';
import { contactNote, EDITABLE, moreThanBio, noteFact, noticesOf, presenceCommand, presenceOf, profileCommand, selfCapabilities, selfEvents, sessionsOf, stateOf, type RawSelfState } from '../src/self.ts';

const KEY = 'discord-self-test-marker-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const SELF = '100000000000000001';
const ANN = '400000000000000001';
const BO = '400000000000000002';
const GUILD_A = '200000000000000001';
const GUILD_B = '200000000000000002';

// ------------------------------------------------------------------ pure parts

const rawState = (over: Partial<RawSelfState> = {}): RawSelfState => ({
  status: 'online',
  statusExpiresAt: null,
  custom: null,
  folders: [{ id: '7', name: 'Games', color: 0x5865f2, guildIds: [GUILD_A, GUILD_B] }, { id: null, name: null, color: null, guildIds: ['200000000000000003'] }],
  privacy: { restrictedGuilds: 2, defaultGuildsRestricted: false, requestRestrictedGuilds: 0, defaultRequestRestricted: true },
  ...over,
});

describe('what the hook reads, said to the hub', () => {
  test('a required action is a notice in plain words, for the live view; an unknown one still shows', () => {
    const [n] = noticesOf({ requiredAction: 'REQUIRE_VERIFIED_PHONE', standing: null, age: null });
    expect(n).toEqual({ key: 'required:REQUIRE_VERIFIED_PHONE', kind: 'verify', title: 'Verify your phone number', message: expect.stringContaining('live view'), liveView: true });
    expect(noticesOf({ requiredAction: 'AGREEMENTS', standing: null, age: null })[0].kind).toBe('agreements');
    expect(noticesOf({ requiredAction: 'REQUIRE_SAFETY_FLOWS', standing: null, age: null })[0].kind).toBe('age');
    expect(noticesOf({ requiredAction: 'REQUIRE_SOMETHING_NEW', standing: null, age: null })[0]).toMatchObject({ kind: 'other', message: expect.stringContaining('REQUIRE_SOMETHING_NEW') });
    expect(noticesOf({ requiredAction: null, standing: 100, age: 1 })).toEqual([]);
  });

  test("the account's standing, when the client read it and it is not all good", () => {
    expect(noticesOf({ requiredAction: null, standing: 200, age: null })[0]).toMatchObject({ key: 'standing', kind: 'standing', title: 'Your account is limited' });
    expect(noticesOf({ requiredAction: null, standing: 500, age: null })[0].title).toBe('Your account is suspended');
    expect(noticesOf({ requiredAction: 'REQUIRE_CAPTCHA', standing: 400, age: null }).map((n) => n.key)).toEqual(['required:REQUIRE_CAPTCHA', 'standing']);
  });

  test('presence, status, folders and privacy as state; a status that ran out is none', () => {
    const now = Date.UTC(2026, 10, 12);
    const s = stateOf(rawState({ status: 'dnd', statusExpiresAt: now + 3_600_000, custom: { text: 'heads down', emojiId: null, emojiName: '🎧', expiresAt: null } }), 3, now);
    expect(s.presence).toEqual({ state: 'dnd', until: now + 3_600_000, status: { text: 'heads down', emoji: '🎧' } });
    expect(s.folders).toEqual([{ id: '7', name: 'Games', color: '#5865f2', spaces: [GUILD_A, GUILD_B] }, { spaces: ['200000000000000003'] }]);
    expect(s.privacy).toEqual([
      { label: 'Direct messages from server members', value: 'Allowed in new servers, off in 2 servers' },
      { label: 'Message requests from server members', value: 'Off for new servers' },
      { label: 'Age check', value: 'Verified (adult)' },
    ]);
    expect(stateOf(rawState({ custom: { text: 'old', emojiId: '9', emojiName: 'blob', expiresAt: now - 1 } }), null, now).presence).toEqual({ state: 'online' });
    expect(stateOf(rawState({ custom: { text: null, emojiId: '9', emojiName: 'blob', expiresAt: null } }), null, now).presence?.status).toEqual({ emoji: ':blob:' });
    expect(stateOf(rawState({ status: 'unknown' }), null, now).presence).toBeUndefined();
  });

  test('each part an event of its own', () => {
    expect(selfEvents({ t: 'self', part: 'ignored', data: [ANN, 7 as never] }, null)).toEqual([{ t: 'ignored', identities: [ANN] }]);
    expect(selfEvents({ t: 'self', part: 'notices', data: { requiredAction: null, standing: null, age: null } }, null)).toEqual([{ t: 'notices', notices: [] }]);
    expect(selfEvents({ t: 'self', part: 'state', data: rawState() }, null)[0].t).toBe('selfState');
  });

  test('capabilities only for the modules found', () => {
    expect(selfCapabilities({ RelationshipActions: true, RelationshipStore: true, Rest: true, SettingsActions: true, UserSettingsProtoStore: true })).toEqual(['block', 'ignore', 'contactNotes', 'sessions', 'setPresence']);
    expect(selfCapabilities({ Rest: true })).toEqual(['contactNotes', 'sessions']);
    expect(selfCapabilities({})).toEqual([]);
  });

  test('commands checked before any request', () => {
    expect(presenceCommand({ state: 'idle' })).toEqual({ kind: 'selfPresence', state: 'idle' });
    expect(presenceCommand({ status: { text: ' reading ', emoji: '📖', expiresAt: 5 } })).toEqual({ kind: 'selfPresence', status: { text: 'reading', emojiName: '📖', expiresAt: 5 } });
    expect(presenceCommand({ status: null })).toEqual({ kind: 'selfPresence', status: null });
    expect(() => presenceCommand({ status: { text: 'x'.repeat(129) } })).toThrow('128 characters');
    expect(() => presenceCommand({ status: { emoji: ':blob:' } })).toThrow("server's own emoji");
    expect(() => presenceCommand({})).toThrow('nothing to change');
    expect(presenceOf(null)).toEqual({ state: 'online' });
    expect(moreThanBio({ bio: 'x' })).toBe(false);
    expect(moreThanBio({ bio: 'x', pronouns: 'they/them' })).toBe(true);
    const pic = { path: '/spool/p', name: 'p.png', mime: 'image/png', size: 10, kind: 'image' as const };
    expect(profileCommand({ name: 'Zed', avatar: pic, accent: '#112233', banner: null }, () => 'QUJD')).toEqual({ kind: 'selfProfile', displayName: 'Zed', avatar: { mime: 'image/png', base64: 'QUJD' }, accent: '#112233', banner: null });
    expect(() => profileCommand({ name: 'x'.repeat(33) }, () => '')).toThrow('32 characters');
    expect(() => profileCommand({ username: 'zed' }, () => '')).toThrow('live view');
    expect(contactNote('fine')).toBe('fine');
    expect(() => contactNote('x'.repeat(257))).toThrow('256 characters');
    expect(() => profileCommand({ avatar: { ...pic, mime: 'image/svg+xml' } }, () => '')).toThrow('PNG, JPEG');
    expect(() => profileCommand({ avatar: { ...pic, size: 11 * 1024 * 1024 } }, () => '')).toThrow('10 MB');
    expect(() => profileCommand({ accent: 'red' }, () => '')).toThrow('colour');
  });

  test('sessions: the current one marked, times as ms, nothing without an id', () => {
    expect(sessionsOf({ sessions: [{ id: 'h1', current: true, os: 'Linux', platform: 'Chrome', location: 'Somewhere', last_used: '2026-11-12T10:00:00.000Z' }, { id: '', current: false, os: null, platform: null, location: null, last_used: null }] })).toEqual({
      sessions: [{ id: 'h1', current: true, client: 'Chrome', os: 'Linux', location: 'Somewhere', lastUsed: Date.UTC(2026, 10, 12, 10) }],
    });
  });

  test("a profile's badges, frame and colours; your note on them as an identity fact, never on yourself; what you may change on your own", () => {
    const base = { selfId: SELF, user: { id: ANN, username: 'ann' } as never };
    const p = mapProfile({ ...base, badges: [{ id: 'early', description: 'Early Supporter', icon: 'abc123' }, { id: 'x', description: null, icon: null }], theme_colors: [0x112233, 0x445566], decoration: 'dec1', note: 'owes me lunch' }, ANN);
    expect(p.badges).toEqual([{ name: 'Early Supporter', icon: 'https://cdn.discordapp.com/badge-icons/abc123.png' }]);
    expect(p.themeColors).toEqual(['#112233', '#445566']);
    expect(p.decoration).toStartWith('https://cdn.discordapp.com/avatar-decoration-presets/dec1.png');
    expect(noteFact({ ...base, note: 'owes me lunch' }, ANN)).toEqual({ t: 'identity', identity: { nativeId: ANN, note: 'owes me lunch' } });
    // None on Discord is '', which the hub reads as none; not asked (or the asking failed) says nothing.
    expect(noteFact({ ...base, note: null }, ANN)).toEqual({ t: 'identity', identity: { nativeId: ANN, note: '' } });
    expect(noteFact(base, ANN)).toBeNull();
    expect(noteFact({ selfId: SELF, user: { id: SELF, username: 'me' } as never, note: 'mine' }, SELF)).toBeNull();
    expect(p.editable).toBeUndefined();
    expect(mapProfile({ selfId: SELF, user: { id: SELF, username: 'me' } as never }, SELF).editable).toEqual(EDITABLE);
  });
});

// ------------------------------------------------------------------ the hook

function page() {
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
  const runHook = () =>
    new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => timers.push(fn), () => {});
  const tick = () => timers.splice(0).forEach((fn) => fn());
  return { win, posted, runHook, tick };
}

function runtime(self: any) {
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
  T.O = (r: unknown) => r;
  const A: Record<PropertyKey, any> = { web: 0 };
  const h = (e: any, t: any) => {
    const [r, a, s] = t;
    let o: unknown;
    if (r.some((x: PropertyKey) => A[x] !== 0)) {
      for (const n in a) if (T.o(a, n)) T.m[n] = a[n];
      if (s) o = s(T);
    }
    e && e(t);
    for (const i of r) A[i] = 0;
    return T.O(o);
  };
  (function (this: any) {
    let f: any;
    (f = this.webpackChunkdiscord_app = this.webpackChunkdiscord_app || []).forEach(h.bind(null, 0)), (f.push = h.bind(null, f.push.bind(f)));
  }).call(self);
  return { T };
}

function chunk(self: any, id: string, mods: Record<string, (m: any, e: any, r: any) => void>) {
  (function (this: any) {
    (this.webpackChunkdiscord_app = this.webpackChunkdiscord_app || []).push([[id], mods]);
  }).call(self);
}

const store = (name: string, extra: Record<string, unknown> = {}) => ({ getName: () => name, emitChange() {}, ...extra });

describe('the hook', () => {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const dispatched: any[] = [];
  const dispatcher = {
    dispatch: (a: any) => void dispatched.push(a),
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
  };
  const emit = (ev: string, a: any = {}) => (handlers.get(ev) ?? []).forEach((fn) => fn(a));
  const users: Record<string, any> = { [SELF]: { id: SELF, username: 'me', ageVerificationStatus: 3 }, [ANN]: { id: ANN, username: 'ann', avatarDecorationData: { asset: 'dec1' } }, [BO]: { id: BO, username: 'bo' } };
  const rels = new Map<string, { type: number; ignored?: boolean }>();
  const calls: unknown[][] = [];
  const restCalls: [string, any][] = [];
  const notes = new Map<string, string>();
  let requiredAction: string | null = null;
  let ignoreTakes = true;
  // The settings proto, as protobuf-ts messages: a type's create() marks what it made.
  const made: string[] = [];
  const type = (name: string, fields: { localName: string; T?: () => any }[] = []) => ({ typeName: name, fields, create: (v: any) => (made.push(name), { ...v }) });
  const StringValue = type('google.protobuf.StringValue');
  const CustomStatus = type('discord_protos.discord_users.v1.CustomStatus');
  const StatusSettings = type('discord_protos.discord_users.v1.StatusSettings', [{ localName: 'status', T: () => StringValue }, { localName: 'customStatus', T: () => CustomStatus }]);
  const Preloaded = type('discord_protos.discord_users.v1.PreloadedUserSettings', [{ localName: 'status', T: () => StatusSettings }]);
  let proto: any;
  const settingsActions = {
    ProtoClass: Preloaded,
    updates: [] as unknown[],
    async updateAsync(part: string, fn: (draft: any) => void, delay: number) {
      const draft = { ...proto[part] };
      fn(draft);
      proto = { ...proto, [part]: draft };
      settingsActions.updates.push([part, delay]);
    },
  };

  function selfPage() {
    handlers.clear();
    calls.length = 0;
    restCalls.length = 0;
    dispatched.length = 0;
    made.length = 0;
    settingsActions.updates = [];
    proto = {
      status: { status: { value: 'online' }, statusExpiresAtMs: '0' },
      privacy: { restrictedGuildIds: [GUILD_A], defaultGuildsRestricted: false, messageRequestRestrictedGuildIds: [], defaultMessageRequestRestricted: { value: false } },
    };
    const p = page();
    p.runHook();
    const web = runtime(p.win);
    const rest = {
      get: async (o: any) => {
        restCalls.push(['get', o]);
        if (o.url === '/auth/sessions') return { body: { user_sessions: [{ id_hash: 'h1', approx_last_used_time: '2026-11-12T10:00:00.000Z', client_info: { os: 'Linux', platform: 'Chrome', location: 'Somewhere' } }, { id_hash: 'h2', client_info: { os: 'Android' } }] } };
        const m = o.url.match(/^\/users\/@me\/notes\/(\d+)$/);
        if (m) return notes.has(m[1]) ? { body: { note_user_id: m[1], note: notes.get(m[1]) } } : Promise.reject({ status: 404, body: { message: 'Unknown User' } });
        return { body: {} };
      },
      post: async () => ({}),
      put: async (o: any) => (restCalls.push(['put', o]), { body: {} }),
      patch: async (o: any) => (restCalls.push(['patch', o]), { body: {} }),
      del: async () => ({}),
    };
    chunk(p.win, '900', {
      core: (_m: any, e: any) => {
        e.A = dispatcher;
        e.u = store('UserStore', { getCurrentUser: () => users[SELF], getUser: (id: string) => users[id] });
        e.c = store('ChannelStore', { getChannel: () => null });
        e.g = store('GuildStore', { getGuilds: () => ({}), getGuild: () => null });
        e.Bo = rest;
      },
      self: (_m: any, e: any) => {
        e.r = store('RelationshipStore', {
          getRelationshipType: (id: string) => rels.get(id)?.type ?? 0,
          getMutableRelationships: () => new Map([...rels].map(([id, r]) => [id, { type: r.type, userIgnored: !!r.ignored }])),
          isIgnored: (id: string) => !!rels.get(id)?.ignored && rels.get(id)?.type !== 2,
          getSince: () => null,
        });
        e.a = {
          sendRequest() {},
          removeRelationship() {},
          addRelationship(o: { userId: string; context: unknown; type?: number }, _t?: unknown) {
            const { userId, context, type } = o;
            calls.push(['addRelationship', userId, context, type]);
            rels.set(userId, { type: type ?? 4 });
            return Promise.resolve();
          },
          // As the live client's: a toast on failure, and nothing else said.
          ignoreUser: (id: string, location: string) => (calls.push(['ignoreUser', id, location]), ignoreTakes && rels.set(id, { type: rels.get(id)?.type ?? 0, ignored: true }), Promise.resolve()),
          unignoreUser: (id: string, location: string) => (calls.push(['unignoreUser', id, location]), rels.set(id, { type: rels.get(id)?.type ?? 0, ignored: false }), Promise.resolve()),
        };
        // A getter, as the real store's: it reads the proto as it is now.
        e.s = Object.defineProperty(store('UserSettingsProtoStore', { getGuildFolders: () => [{ guildIds: [GUILD_A, GUILD_B], folderId: 7, folderName: 'Games', folderColor: 0x5865f2 }] }), 'settings', { get: () => proto });
        e.w = settingsActions;
        e.q = store('UserRequiredActionStore', { getAction: () => requiredAction });
        e.h = store('SafetyHubStore', { isInitialized: () => false, getAccountStanding: () => ({ state: 100 }) });
        e.n = store('NoteStore', { getNote: () => undefined });
        e.p = store('UserProfileStore', { getUserProfile: (id: string) => (id === ANN ? { bio: 'hi', badges: [{ id: 'e', description: 'Early Supporter', icon: 'abc' }], themeColors: [1, 2] } : null) });
        e.t = store('AuthenticationStore', { getAuthSessionIdHash: () => 'h1' });
      },
    });
    web.T('core');
    web.T('self');
    p.tick();
    return p;
  }
  let n = 0;
  async function ask(p: ReturnType<typeof page>, c: unknown) {
    const id = `self${n++}`;
    p.win.down({ t: 'cmd', id, cmd: c });
    for (let i = 0; i < 20; i++) await Bun.sleep(0);
    return p.posted.find((m) => m.t === 'reply' && m.id === id);
  }
  const selfUps = (p: ReturnType<typeof page>) => p.posted.filter((m) => m.t === 'self');
  afterEach(() => {
    rels.clear();
    notes.clear();
    requiredAction = null;
    ignoreTakes = true;
  });

  test('finds the settings, required action, safety and note stores', () => {
    const found = selfPage().posted.filter((m) => m.t === 'finders').at(-1).results;
    expect(found).toMatchObject({ UserSettingsProtoStore: true, SettingsActions: true, UserRequiredActionStore: true, SafetyHubStore: true, NoteStore: true });
  });

  test('says the account itself once subscribed, each part again only when it changed', () => {
    rels.set(ANN, { type: 1, ignored: true });
    const p = selfPage();
    p.tick();
    const first = selfUps(p);
    expect(first.map((m) => m.part).sort()).toEqual(['ignored', 'notices', 'state']);
    expect(first.find((m) => m.part === 'ignored').data).toEqual([ANN]);
    expect(first.find((m) => m.part === 'notices').data).toEqual({ requiredAction: null, standing: null, age: 3 });
    const state = first.find((m) => m.part === 'state').data;
    expect(state).toMatchObject({ status: 'online', custom: null, folders: [{ id: '7', name: 'Games', color: 0x5865f2, guildIds: [GUILD_A, GUILD_B] }] });
    expect(state.privacy).toEqual({ restrictedGuilds: 1, defaultGuildsRestricted: false, requestRestrictedGuilds: 0, defaultRequestRestricted: false });
    // Discord says the account must verify its phone: only the notices go again.
    requiredAction = 'REQUIRE_VERIFIED_PHONE';
    emit('USER_REQUIRED_ACTION_UPDATE', { requiredAction });
    p.tick();
    const next = selfUps(p).slice(first.length);
    expect(next).toEqual([{ t: 'self', part: 'notices', data: { requiredAction: 'REQUIRE_VERIFIED_PHONE', standing: null, age: 3 } }]);
    emit('USER_SETTINGS_PROTO_UPDATE');
    p.tick();
    expect(selfUps(p).length).toBe(first.length + 1);
  });

  test("presence and custom status through the client's settings path, with the proto's own types", async () => {
    const p = selfPage();
    const r = await ask(p, { kind: 'selfPresence', state: 'dnd', status: { text: 'focus', emojiName: '🎧', expiresAt: 1_900_000_000_000 } });
    expect(r.ok).toBe(true);
    expect(settingsActions.updates).toEqual([['status', 0]]);
    expect(made).toEqual(['google.protobuf.StringValue', 'discord_protos.discord_users.v1.CustomStatus']);
    expect(proto.status.status).toEqual({ value: 'dnd' });
    expect(proto.status.customStatus).toMatchObject({ text: 'focus', emojiName: '🎧', expiresAtMs: '1900000000000' });
    expect(r.result).toMatchObject({ status: 'dnd', custom: { text: 'focus', emojiName: '🎧' } });
    await ask(p, { kind: 'selfPresence', status: null });
    expect(proto.status.customStatus).toBeUndefined();
    expect(proto.status.status).toEqual({ value: 'dnd' });
    expect((await ask(p, { kind: 'selfPresence', state: 'away' })).ok).toBe(false);
    expect(restCalls).toEqual([]);
  });

  test("block through the client's addRelationship; ignore and unignore through its own buttons, checked against the store", async () => {
    const p = selfPage();
    const b = await ask(p, { kind: 'selfBlock', userId: BO });
    expect(calls).toEqual([['addRelationship', BO, { location: 'ContextMenu' }, 2]]);
    expect(b.result).toMatchObject({ relationship: 2 });
    expect((await ask(p, { kind: 'selfBlock', userId: SELF })).error).toBe('That is this account');
    calls.length = 0;
    expect((await ask(p, { kind: 'selfIgnore', userId: ANN, ignored: true })).result).toEqual({ ignored: true });
    expect((await ask(p, { kind: 'selfIgnore', userId: ANN, ignored: true })).result).toEqual({ ignored: true });
    expect((await ask(p, { kind: 'selfIgnore', userId: ANN, ignored: false })).result).toEqual({ ignored: false });
    expect(calls).toEqual([['ignoreUser', ANN, 'ContextMenu'], ['unignoreUser', ANN, 'ContextMenu']]);
    expect(restCalls).toEqual([]);
  });

  test('an ignore Discord refused (the client only shows a toast) is an error', async () => {
    ignoreTakes = false;
    const p = selfPage();
    p.win.down({ t: 'cmd', id: 'refused', cmd: { kind: 'selfIgnore', userId: ANN, ignored: true } });
    for (let i = 0; i < 20; i++) await Bun.sleep(0);
    expect(p.posted.find((m) => m.t === 'reply' && m.id === 'refused')).toMatchObject({ ok: false, error: 'Discord did not ignore them' });
  });

  test('notes: read with a profile (the request its profile makes), never for yourself; written with a PUT', async () => {
    notes.set(ANN, 'met at a conference');
    const p = selfPage();
    const prof = await ask(p, { kind: 'profile', userId: ANN });
    expect(prof.result).toMatchObject({ note: 'met at a conference', badges: [{ id: 'e', description: 'Early Supporter', icon: 'abc' }], theme_colors: [1, 2], decoration: 'dec1' });
    expect(dispatched).toContainEqual({ type: 'USER_NOTE_UPDATE', id: ANN, note: 'met at a conference' });
    const none = await ask(p, { kind: 'profile', userId: BO });
    expect(none.result.note).toBeNull();
    restCalls.length = 0;
    await ask(p, { kind: 'profile', userId: SELF });
    expect(restCalls.some(([, o]) => /notes/.test(o.url))).toBe(false);
    const w = await ask(p, { kind: 'selfNote', userId: ANN, note: 'owes me lunch' });
    expect(w.result).toEqual({ note: 'owes me lunch' });
    expect(restCalls.at(-1)).toEqual(['put', { url: `/users/@me/notes/${ANN}`, query: undefined, body: { note: 'owes me lunch' } }]);
  });

  test('sessions as the Devices page lists them, this one marked', async () => {
    const r = await ask(selfPage(), { kind: 'selfSessions' });
    expect(r.result.sessions).toEqual([
      { id: 'h1', current: true, os: 'Linux', platform: 'Chrome', location: 'Somewhere', last_used: '2026-11-12T10:00:00.000Z' },
      { id: 'h2', current: false, os: 'Android', platform: null, location: null, last_used: null },
    ]);
  });

  test('your name and picture on your user, the rest on your profile', async () => {
    const p = selfPage();
    const r = await ask(p, { kind: 'selfProfile', displayName: 'Zed', avatar: { mime: 'image/png', base64: 'QUJD' }, pronouns: 'they/them', accent: '#112233' });
    expect(r.ok).toBe(true);
    const patches = restCalls.filter(([v]) => v === 'patch').map(([, o]) => [o.url, o.body]);
    expect(patches).toEqual([
      ['/users/@me', { global_name: 'Zed', avatar: 'data:image/png;base64,QUJD' }],
      ['/users/@me/profile', { pronouns: 'they/them', accent_color: 0x112233 }],
    ]);
    expect((await ask(p, { kind: 'selfProfile' })).error).toBe('nothing to change');
  });
});
