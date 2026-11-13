/**
 * hook.js's @ list (mentionables) against a small replica of the client: a DM's and a group's recipients; who wrote in
 * a server channel lately; for letters typed, the loaded members and the client's own member search (op 8, at most 10,
 * its chunks never passed on as seen members); only people the roles and the channel's overwrites let in; the roles
 * that may be pinged, all of them with Mention Everyone; and nothing for a channel the client does not have.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { mentionCapabilities } from '../src/mentionables.ts';

const KEY = 'discord-hook-mentionables-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const ME = '100000000000000001';
const G = '200000000000000001';
const CH = '300000000000000001';
const STAFF = '300000000000000002';
const THREAD = '300000000000000003';
const DM = '600000000000000001';
const GDM = '600000000000000002';
const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const CAROL = '400000000000000003';
const DAVE = '400000000000000004';
const EVE = '400000000000000005';
const FRANK = '400000000000000006';
const MOD = '201';
const QUIET = '202';
const ADMIN = '203';
const VIEW = 1n << 10n;
const MENTION_EVERYONE = 1n << 17n;

const users: Record<string, any> = {
  [ME]: { id: ME, username: 'me' },
  [ALICE]: { id: ALICE, username: 'alice', globalName: 'Alice' },
  [BOB]: { id: BOB, username: 'bob' },
  [CAROL]: { id: CAROL, username: 'carol' },
  [DAVE]: { id: DAVE, username: 'dave' },
  [EVE]: { id: EVE, username: 'eve' },
  [FRANK]: { id: FRANK, username: 'danny' },
};
const channels: Record<string, any> = {
  [DM]: { id: DM, type: 1, recipients: [ALICE] },
  [GDM]: { id: GDM, type: 3, recipients: [ALICE, BOB] },
  [CH]: { id: CH, type: 0, guild_id: G, name: 'general', permissionOverwrites: {} },
  // Hidden from @everyone; the mods, and Dave by name, may see it.
  [STAFF]: {
    id: STAFF,
    type: 0,
    guild_id: G,
    name: 'staff',
    permissionOverwrites: { [G]: { id: G, type: 0, allow: 0n, deny: VIEW }, [MOD]: { id: MOD, type: 0, allow: VIEW, deny: 0n }, [DAVE]: { id: DAVE, type: 1, allow: VIEW.toString(), deny: '0' } },
  },
  [THREAD]: { id: THREAD, type: 11, guild_id: G, parent_id: STAFF, name: 'a thread' },
};
const roles: Record<string, any> = {
  [G]: { id: G, name: '@everyone', position: 0, permissions: VIEW },
  [MOD]: { id: MOD, name: 'Mods', position: 2, mentionable: true, color: 0xe67e22, permissions: 0n },
  [QUIET]: { id: QUIET, name: 'Quiet', position: 1, mentionable: false, permissions: 0n },
  [ADMIN]: { id: ADMIN, name: 'Admins', position: 3, mentionable: false, permissions: 1n << 3n },
};
const members: Record<string, any> = {
  [ALICE]: { userId: ALICE, roles: [MOD], nick: 'Al' },
  [BOB]: { userId: BOB, roles: [] },
  [CAROL]: { userId: CAROL, roles: [ADMIN] },
  [DAVE]: { userId: DAVE, roles: [], nick: 'Dave' },
};
/** Messages the client holds, oldest first, by author. */
const held: Record<string, string[]> = {
  [CH]: [BOB, ALICE, ME, EVE],
  [STAFF]: [BOB, ALICE, CAROL],
};
const snowflakeAt = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();

function client(opts: { everyone?: boolean } = {}) {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const requested: unknown[][] = [];
  const dispatcher = {
    dispatch() {},
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, (handlers.get(ev) ?? []).filter((f) => f !== fn)),
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => users[ME], getUser: (id: string) => users[id] ?? null });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null });
    e.D = store('GuildStore', { getGuilds: () => ({ [G]: { id: G } }), getGuild: (id: string) => (id === G ? { id: G, name: 'Club', ownerId: '999' } : null) });
    e.E = store('GuildMemberStore', { getMember: (g: string, u: string) => (g === G ? (members[u] ?? null) : null), getMembers: () => Object.values(members), getNick: (g: string, u: string) => (g === G ? (members[u]?.nick ?? null) : null) });
    e.F = store('GuildRoleStore', { getRoles: () => roles });
    e.H = store('PermissionStore', { can: (bit: bigint) => (bit === MENTION_EVERYONE ? !!opts.everyone : true) });
    e.I = store('MessageStore', {
      getMessages: (c: string) => {
        const list = (held[c] ?? []).map((author, i) => ({ id: snowflakeAt(1_700_000_000_000 + i * 60_000), author: users[author] }));
        return { toArray: () => list };
      },
    });
    e.J = { requestMembers: (...a: unknown[]) => void requested.push(a), requestMembersById() {} };
  };
  return { handlers, requested, mods: { client: modules }, emit: (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a)) };
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
  (win.webpackChunkdiscord_app = win.webpackChunkdiscord_app || []).push = function (chunkData: any) {
    const [, mods, run] = chunkData;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, T);
    }
    if (run) run(T);
  };
  win.webpackChunkdiscord_app.push([['700'], c.mods]);
  timers.splice(0).forEach((fn) => fn());
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Bun.sleep(0);
  };
  const reply = (id: string) => posted.find((m) => m.t === 'reply' && m.id === id);
  const cmd = async (id: string, command: unknown) => {
    win.down({ t: 'cmd', id, cmd: command });
    await settle();
    return reply(id);
  };
  /** Run the timers queued so far: the member search's wait. */
  const tick = () => timers.splice(0).forEach((fn) => fn());
  return { posted, cmd, reply, settle, tick, win };
}

const ask = (channelId: string, query = '') => ({ kind: 'mentionables', channelId, query, limit: 20 });
const ids = (r: any) => r.result.people.map((p: any) => p.user.id);

describe("hook.js's @ list", () => {
  test('the modules it needs are found, so the account says it can answer', () => {
    const p = page(client());
    const report = p.posted.filter((m) => m.t === 'finders').pop();
    expect(mentionCapabilities(report.results)).toEqual(['mentionables']);
  });

  test("a DM's and a group's recipients, never you, and no @everyone", async () => {
    const c = client({ everyone: true });
    const p = page(c);
    expect((await p.cmd('d', ask(DM))).result).toEqual({ people: [{ user: expect.objectContaining({ id: ALICE, global_name: 'Alice' }), nick: null }], roles: [], everyone: false });
    expect(ids(await p.cmd('g', ask(GDM)))).toEqual([ALICE, BOB]);
    expect(ids(await p.cmd('g2', ask(GDM, 'bo')))).toEqual([BOB]);
    expect(c.requested).toEqual([]);
  });

  test('a server channel, nothing typed: who wrote there, newest first, when they wrote, no member search', async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('c', ask(CH));
    expect(ids(r)).toEqual([EVE, ALICE, BOB]);
    expect(r.result.people[1]).toEqual({ user: expect.objectContaining({ id: ALICE }), nick: 'Al', lastSpoke: 1_700_000_060_000 });
    // Eve is no member the client holds: kept, she wrote here.
    expect(r.result.people[0].nick).toBeNull();
    // Mentionable roles only, without Mention Everyone.
    expect(r.result.roles).toEqual([{ id: MOD, name: 'Mods', color: '#e67e22' }]);
    expect(r.result.everyone).toBe(false);
    expect(c.requested).toEqual([]);
  });

  test("only those the channel's overwrites let in: a role allowed, an admin, someone allowed by name; a thread goes by its parent", async () => {
    const p = page(client());
    expect(ids(await p.cmd('s', ask(STAFF)))).toEqual([CAROL, ALICE]);
    expect(ids(await p.cmd('t', ask(THREAD, 'da')).then(async (r) => (r ?? (p.tick(), await p.settle(), p.reply('t')))))).toEqual([DAVE]);
  });

  test("letters typed: the loaded members that match, then the client's own member search, whose chunk is the search's alone", async () => {
    const c = client();
    const p = page(c);
    p.win.down({ t: 'cmd', id: 'q', cmd: ask(CH, 'Da') });
    await p.settle();
    expect(c.requested).toEqual([[G, 'da', 10, false]]);
    expect(p.reply('q')).toBeUndefined();
    c.emit('GUILD_MEMBERS_CHUNK_BATCH', { chunks: [{ guildId: G, members: [{ user: users[FRANK], roles: [], nick: null }, { user: users[DAVE], roles: [], nick: 'Dave' }], notFound: [], nonce: null }] });
    await p.settle();
    expect(ids(p.reply('q'))).toEqual([DAVE, FRANK]);
    expect(p.posted.some((m) => m.t === 'dispatch' && /GUILD_MEMBERS_CHUNK/.test(m.event))).toBe(false);
  });

  test('a member search that does not answer in time: the answer goes without it', async () => {
    const c = client();
    const p = page(c);
    p.win.down({ t: 'cmd', id: 'slow', cmd: ask(CH, 'al') });
    await p.settle();
    expect(p.reply('slow')).toBeUndefined();
    p.tick();
    await p.settle();
    expect(ids(p.reply('slow'))).toEqual([ALICE]);
  });

  test('with Mention Everyone: @everyone, and every role but @everyone itself, highest first', async () => {
    const p = page(client({ everyone: true }));
    const r = await p.cmd('e', ask(CH));
    expect(r.result.everyone).toBe(true);
    expect(r.result.roles.map((x: any) => x.name)).toEqual(['Admins', 'Mods', 'Quiet']);
  });

  test('a channel the client does not have is refused', async () => {
    const p = page(client());
    expect(await p.cmd('x', ask('300000000000000999'))).toMatchObject({ ok: false, error: 'this account cannot see that channel' });
  });
});
