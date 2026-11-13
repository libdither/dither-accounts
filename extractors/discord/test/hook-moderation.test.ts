/**
 * hook.js's moderation section against a small replica of the client: one rspack runtime with the stores and the
 * moderation and server action modules it looks for, under mangled export names. Every action is checked again in
 * the page against the client's own permission and hierarchy checks, then goes through the client's own action, or
 * its REST helper with the same request when the module is not there. The harness is hook-attention.test.ts's.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-moderation-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const ME = '100000000000000001';
const ANA = '100000000000000004';
const BOSS = '100000000000000005';
const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const VOICE = '300000000000000201';
const DM = '600000000000000005';
const KICK = 1n << 1n;
const BAN = 1n << 2n;
const MANAGE_MESSAGES = 1n << 13n;
const MANAGE_ROLES = 1n << 28n;
const TIMEOUT = 1n << 40n;

function client(opts: { grants?: bigint[]; mods?: boolean; outranked?: string[] } = {}) {
  const grants = opts.grants ?? [KICK, BAN, MANAGE_MESSAGES, MANAGE_ROLES, TIMEOUT];
  const outranked = new Set(opts.outranked ?? [BOSS]);
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  const guild = { id: GUILD, name: 'Test', ownerId: BOSS, premiumTier: 2 };
  const channels: Record<string, any> = {
    [CHAN]: { id: CHAN, type: 0, guild_id: GUILD, name: 'general', defaultAutoArchiveDuration: 1440 },
    [VOICE]: { id: VOICE, type: 2, guild_id: GUILD, name: 'Voice', userLimit: 5, bitrate: 64000 },
    [DM]: { id: DM, type: 1, recipients: [ANA] },
  };
  const roles = {
    [GUILD]: { id: GUILD, name: '@everyone', position: 0 },
    r1: { id: 'r1', name: 'Helper', position: 1 },
    r2: { id: 'r2', name: 'Booster', position: 2, managed: true },
    r3: { id: 'r3', name: 'Mod', position: 3 },
  };
  const members: Record<string, any> = {
    [ME]: { userId: ME, roles: ['r3'] },
    [ANA]: { userId: ANA, roles: ['r1'], communicationDisabledUntil: '2099-01-01T00:00:00.000Z' },
    [BOSS]: { userId: BOSS, roles: [] },
  };
  const dispatcher = { dispatch() {}, subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]), unsubscribe() {}, isDispatching: () => false, _subscriptions: {} };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = async (o: any) => (calls.push(['rest', k, o.url, o.body ?? o.query]), { body: k === 'get' ? [{ user: { id: ANA, username: 'ana' }, reason: 'spam' }] : {} });
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: ME, username: 'me' }), getUser: (id: string) => ({ id, username: `u${id.slice(-1)}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: guild }), getGuild: (id: string) => (id === GUILD ? guild : null) });
    e.E = store('GuildRoleStore', { getRoles: () => roles });
    e.F = store('GuildMemberStore', { getMembers: () => Object.values(members), getMember: (_g: string, id: string) => members[id] ?? null });
    e.G = store('PermissionStore', {
      can: (bit: bigint, subject: any) => !!subject && subject.id !== DM && grants.includes(bit),
      canManageUser: (bit: bigint, userId: string) => grants.includes(bit) && !outranked.has(userId),
      getHighestRole: () => roles.r3,
    });
    e.H = rest;
    e.I = { deleteMessage: (c: string, m: string) => void calls.push(['deleteMessage', c, m]), sendMessage() {}, editMessage() {} };
    if (opts.mods !== false) {
      e.J = {
        kickUser: (g: string, u: string, reason: string) => (calls.push(['kickUser', g, u, reason]), Promise.resolve()),
        banUser: (g: string, u: string, s: number, reason: string) => (calls.push(['banUser', g, u, s, reason]), Promise.resolve()),
        unbanUser: (g: string, u: string) => (calls.push(['unbanUser', g, u]), Promise.resolve()),
        setCommunicationDisabledUntil: (o: any) => (calls.push(['timeout', o]), Promise.resolve()),
      };
      e.K = { leaveGuild() {}, updateMemberRoles: (g: string, u: string, next: string[], add: string[], rm: string[]) => (calls.push(['roles', g, u, next, add, rm]), Promise.resolve()) };
    }
  };
  return { calls, members, modules };
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
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, { webdriver: false }, { getItem: () => null, setItem() {} }, (fn: () => void) => timers.push(fn), () => {});
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
  win.webpackChunkdiscord_app.push([['700'], { client: c.modules }]);
  timers.splice(0).forEach((fn) => fn());
  let n = 0;
  const cmd = async (command: unknown) => {
    const id = `c${n++}`;
    win.down({ t: 'cmd', id, cmd: command });
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const r = posted.find((m) => m.t === 'reply' && m.id === id);
    if (r?.ok) expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
    return r;
  };
  return { posted, cmd };
}

describe("hook.js's moderation section", () => {
  test('finds the moderation module; the about says who you may act on, timeouts, your top role, plain settings', async () => {
    const c = client();
    const p = page(c);
    expect(p.posted.filter((m) => m.t === 'finders').pop()?.results).toMatchObject({ ModActions: true });
    const r = await p.cmd({ kind: 'about', target: 'space', id: GUILD });
    expect(r.ok).toBe(true);
    expect(r.result.can).toMatchObject({ kickMembers: true, banMembers: true, moderateMembers: true });
    expect(r.result.top_position).toBe(3);
    expect(r.result.premium_tier).toBe(2);
    const ana = r.result.members.find((m: any) => m.user.id === ANA);
    expect(ana).toMatchObject({ manage: { kickMembers: true, banMembers: true, moderateMembers: true, manageRoles: true }, timeout_until: '2099-01-01T00:00:00.000Z' });
    expect(r.result.members.find((m: any) => m.user.id === BOSS).manage.kickMembers).toBe(false);
    expect(r.result.roles.find((x: any) => x.id === 'r2').managed).toBe(true);
    const v = await p.cmd({ kind: 'about', target: 'conversation', id: VOICE });
    expect(v.result.channel).toMatchObject({ user_limit: 5, bitrate: 64000 });
    expect((await p.cmd({ kind: 'about', target: 'conversation', id: CHAN })).result.channel.default_auto_archive_duration).toBe(1440);
  });

  test("kick, ban, unban and timeout go through the client's own actions", async () => {
    const c = client();
    const p = page(c);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'kick' })).ok).toBe(true);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'ban', deleteSeconds: 3600 })).ok).toBe(true);
    // Not one of the dialog's choices: nothing of theirs deleted.
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'ban', deleteSeconds: 5 })).ok).toBe(true);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'unban' })).ok).toBe(true);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'timeout', seconds: 600 })).ok).toBe(true);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'timeout', seconds: 0 })).ok).toBe(true);
    expect(c.calls.filter((x) => x[0] !== 'rest').map((x) => x.slice(0, 5))).toEqual([
      ['kickUser', GUILD, ANA, ''],
      ['banUser', GUILD, ANA, 3600, ''],
      ['banUser', GUILD, ANA, 0, ''],
      ['unbanUser', GUILD, ANA],
      ['timeout', expect.objectContaining({ guildId: GUILD, userId: ANA, duration: 600, communicationDisabledUntilTimestamp: expect.stringMatching(/^\d{4}-/) })],
      ['timeout', expect.objectContaining({ communicationDisabledUntilTimestamp: null })],
    ]);
    expect(c.calls.filter((x) => x[0] === 'rest')).toEqual([]);
  });

  test('a role given or taken: the whole list, as the member menu sends it; never one at or above yours, or managed', async () => {
    const c = client();
    const p = page(c);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'role', roleId: 'r1', remove: true })).ok).toBe(true);
    expect(c.calls.at(-1)).toEqual(['roles', GUILD, ANA, [], [], ['r1']]);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'role', roleId: 'r3' })).error).toMatch(/below your own top role/);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'role', roleId: 'r2' })).error).toMatch(/managed by an integration/);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'role', roleId: GUILD })).error).toMatch(/No such role/);
  });

  test('refused in the page: someone above you, yourself, a permission you lack', async () => {
    const c = client({ grants: [MANAGE_MESSAGES] });
    const p = page(c);
    expect((await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'kick' })).error).toMatch(/Kick Members/);
    expect((await p.cmd({ kind: 'bans', guildId: GUILD })).error).toMatch(/Ban Members/);
    const q = page(client());
    expect((await q.cmd({ kind: 'moderate', guildId: GUILD, userId: BOSS, op: 'kick' })).error).toMatch(/as high as yours/);
    expect((await q.cmd({ kind: 'moderate', guildId: GUILD, userId: ME, op: 'kick' })).error).toMatch(/That is you/);
    expect(c.calls).toEqual([]);
  });

  test("without the moderation module: the REST helper, with the client's own requests", async () => {
    const c = client({ mods: false });
    const p = page(c);
    await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'ban', deleteSeconds: 86400 });
    await p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op: 'role', roleId: 'r1', remove: true });
    expect(c.calls).toEqual([
      ['rest', 'put', `/guilds/${GUILD}/bans/${ANA}`, { delete_message_seconds: 86400 }],
      ['rest', 'patch', `/guilds/${GUILD}/members/${ANA}`, { roles: [] }],
    ]);
  });

  test('the Bans list; reactions and others’ messages with Manage Messages only', async () => {
    const c = client();
    const p = page(c);
    expect((await p.cmd({ kind: 'bans', guildId: GUILD })).result).toEqual({ bans: [{ user: expect.objectContaining({ id: ANA }), reason: 'spam' }], more: false });
    await p.cmd({ kind: 'clearReactions', channelId: CHAN, messageId: '9' });
    await p.cmd({ kind: 'clearReactions', channelId: CHAN, messageId: '9', emoji: 'blob:77' });
    await p.cmd({ kind: 'clearReactions', channelId: CHAN, messageId: '9', emoji: '👍', userId: ANA });
    expect(c.calls.filter((x) => x[1] === 'del').map((x) => x[2])).toEqual([
      `/channels/${CHAN}/messages/9/reactions`,
      `/channels/${CHAN}/messages/9/reactions/blob%3A77`,
      `/channels/${CHAN}/messages/9/reactions/${encodeURIComponent('👍')}/0/${ANA}`,
    ]);
    expect((await p.cmd({ kind: 'modRedact', channelId: CHAN, messageId: '9' })).ok).toBe(true);
    expect(c.calls.at(-1)).toEqual(['deleteMessage', CHAN, '9']);
    expect((await p.cmd({ kind: 'reactionContext', channelId: CHAN })).result.manageMessages).toBe(true);
    // A DM has no moderators.
    expect((await p.cmd({ kind: 'reactionContext', channelId: DM })).result.manageMessages).toBe(false);
    expect((await p.cmd({ kind: 'modRedact', channelId: DM, messageId: '9' })).error).toMatch(/Manage Messages/);
    const q = page(client({ grants: [] }));
    expect((await q.cmd({ kind: 'clearReactions', channelId: CHAN, messageId: '9' })).error).toMatch(/Manage Messages/);
  });
});
