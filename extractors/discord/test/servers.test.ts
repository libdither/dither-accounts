/**
 * Servers beyond their channels (src/servers.ts, hook.js "servers"; dither-chat's docs/servers.md): events mapped with
 * their rule, exceptions, place, count and your answer; gates from the screening form and onboarding; a server's About
 * with leaving, nickname and links; and the hook's commands through fake client modules, which are the client's own
 * actions and never a request of ours, and which never agree to rules for the owner.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { DISCORD_INVITE_OPTIONS } from '@dither-chat/protocol';
import { invitePlan, mapEvent, mapGate, rruleOf, serverCapabilities, serverDispatch, withServer, type RawEvent, type RawServerAbout } from '../src/servers.ts';

const day = (iso: string) => iso;
const raw = (over: Partial<RawEvent> = {}): RawEvent => ({
  id: '1300000000000000001',
  guild_id: '900',
  channel_id: '901',
  creator_id: '42',
  name: 'Office hours',
  description: 'Bring questions',
  scheduled_start_time: day('2026-11-17T17:00:00.000Z'),
  scheduled_end_time: day('2026-11-17T18:00:00.000Z'),
  status: 1,
  entity_type: 2,
  location: null,
  image: 'abc',
  recurrence_rule: null,
  exceptions: [],
  user_count: 12,
  rsvp: null,
  ...over,
});

describe('events', () => {
  test('a voice channel event: place, picture, count, creator; an answer not known yet is left out', () => {
    expect(mapEvent(raw())).toEqual({
      nativeId: '1300000000000000001',
      space: '900',
      name: 'Office hours',
      description: 'Bring questions',
      start: Date.parse('2026-11-17T17:00:00.000Z'),
      end: Date.parse('2026-11-17T18:00:00.000Z'),
      status: 'scheduled',
      place: { kind: 'voice', conversation: '901' },
      imageUrl: 'https://cdn.discordapp.com/guild-events/1300000000000000001/abc.png?size=1024',
      interested: 12,
      creator: '42',
    });
  });

  test('a place outside, a stage, statuses, and your answer either way', () => {
    expect(mapEvent(raw({ entity_type: 3, channel_id: null, location: 'The park' }))?.place).toEqual({ kind: 'external', location: 'The park' });
    expect(mapEvent(raw({ entity_type: 1 }))?.place).toEqual({ kind: 'stage', conversation: '901' });
    expect(mapEvent(raw({ status: 2 }))?.status).toBe('active');
    expect(mapEvent(raw({ status: 4 }))?.status).toBe('cancelled');
    expect(mapEvent(raw({ rsvp: 1 }))?.youInterested).toBe(true);
    expect(mapEvent(raw({ rsvp: 'none' }))?.youInterested).toBe(false);
    expect(mapEvent(raw({ scheduled_start_time: null }))).toBeNull();
  });

  test("Discord's recurrence rules as RRULEs", () => {
    const r = { start: null, end: null, frequency: 2, interval: 1, by_weekday: [1], by_n_weekday: null, by_month: null, by_month_day: null, by_year_day: null, count: null };
    expect(rruleOf(r)).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU');
    expect(rruleOf({ ...r, frequency: 1, by_weekday: null, by_n_weekday: [{ n: 2, day: 4 }] })).toBe('FREQ=MONTHLY;INTERVAL=1;BYDAY=2FR');
    expect(rruleOf({ ...r, interval: 2, by_weekday: [5, 6], end: '2027-01-01T00:00:00.000Z' })).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU;UNTIL=20270101T000000Z');
    expect(rruleOf({ ...r, frequency: 0, by_weekday: null, by_month: [3], by_month_day: [14], count: 5 })).toBe('FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=14;COUNT=5');
    expect(rruleOf({ ...r, frequency: 3, by_weekday: [0, 1, 2, 3, 4] })).toBe('FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR');
    expect(rruleOf(null)).toBeUndefined();
  });

  test('exceptions: the original start from the snowflake, moved or called off, and your answer to one', () => {
    // A snowflake for 2026-11-24T17:00:00Z.
    const ex = ((BigInt(Date.parse('2026-11-24T17:00:00.000Z')) - 1420070400000n) << 22n).toString();
    const e = mapEvent(
      raw({
        recurrence_rule: { start: null, end: null, frequency: 2, interval: 1, by_weekday: [1], by_n_weekday: null, by_month: null, by_month_day: null, by_year_day: null, count: null },
        exceptions: [{ id: ex, is_canceled: true, scheduled_start_time: null, scheduled_end_time: null, rsvp: 0 }],
      }),
    );
    expect(e?.exceptions).toEqual([{ nativeId: ex, original: Date.parse('2026-11-24T17:00:00.000Z'), cancelled: true, youInterested: false }]);
  });

  test('dispatches: an event as it stands, one gone, and an application turned down or let in', () => {
    expect(serverDispatch('GUILD_SCHEDULED_EVENT_UPDATE', { event: raw({ user_count: 13 }) })).toEqual([{ t: 'scheduledEvent', event: expect.objectContaining({ interested: 13 }) }]);
    expect(serverDispatch('GUILD_SCHEDULED_EVENT_DELETE', { gone: { id: '1', guild_id: '900' } })).toEqual([{ t: 'scheduledEventGone', space: '900', nativeId: '1' }]);
    expect(serverDispatch('GUILD_JOIN_REQUEST_UPDATE', { application: { guild_id: '900', status: 'REJECTED', reason: 'Not now' } })).toEqual([{ t: 'gate', space: '900', gate: { space: '900', kind: 'apply', status: 'rejected', reason: 'Not now' } }]);
    expect(serverDispatch('GUILD_JOIN_REQUEST_UPDATE', { application: { guild_id: '900', status: 'APPROVED', reason: null } })).toEqual([{ t: 'gate', space: '900', gate: null }]);
    expect(serverDispatch('MESSAGE_CREATE', { event: raw() })).toEqual([]);
  });
});

describe('gates', () => {
  test('rules alone are a rules gate; questions make it an application', () => {
    const rules = mapGate({ kind: 'screening', guildId: '900', form: { version: 'v1', description: 'Welcome', form_fields: [{ field_type: 'TERMS', label: 'Read', values: ['Be kind', 'No spam'], required: true }] } });
    expect(rules).toEqual({ space: '900', kind: 'rules', description: 'Welcome', rules: ['Be kind', 'No spam'], version: 'v1' });
    const apply = mapGate({
      kind: 'screening',
      guildId: '900',
      form: {
        version: 'v2',
        description: null,
        form_fields: [
          { field_type: 'TERMS', values: ['Be kind'], required: true },
          { field_type: 'PARAGRAPH', label: 'Why join?', required: true },
          { field_type: 'MULTIPLE_CHOICE', label: 'How did you find us?', required: false, choices: ['Friend', 'Search'] },
        ],
      },
    });
    expect(apply).toMatchObject({ kind: 'apply', rules: ['Be kind'], status: 'open', questions: [{ id: '1', kind: 'paragraph', label: 'Why join?', required: true }, { id: '2', kind: 'choice', choices: ['Friend', 'Search'] }] });
    expect(mapGate({ kind: 'apply', guildId: '900', status: 'SUBMITTED', reason: null, form: null })).toEqual({ space: '900', kind: 'apply', status: 'submitted' });
    expect(mapGate({ kind: 'onboarding', guildId: '900', prompts: [{ id: 'p', title: 'Pick', single_select: true, required: false, options: [{ id: 'o', title: 'Art', description: null, emoji: '🎨' }] }] })).toEqual({
      space: '900',
      kind: 'onboarding',
      prompts: [{ id: 'p', title: 'Pick', single: true, required: false, options: [{ id: 'o', title: 'Art', emoji: '🎨' }] }],
    });
    expect(mapGate(null)).toBeNull();
  });
});

describe("a server's About", () => {
  const sa = (over: Partial<RawServerAbout> = {}): RawServerAbout => ({
    guildId: '900',
    selfId: '1',
    ownerId: '2',
    nick: 'qu',
    vanity: null,
    can: { createInvite: true, manageGuild: false, changeNickname: true },
    links: [],
    inviteChannelId: '901',
    modules: { leave: true, nick: true, invites: true },
    ...over,
  });
  const caps = ['leave', 'nick', 'inviteLinks'] as const;

  test('a member may leave, set a nickname and make links with the dialog\'s choices', () => {
    const a = withServer({ noun: 'Server', fields: {} }, sa(), [...caps]);
    expect(a.leaving).toEqual({ can: true });
    expect(a.nick).toEqual({ value: 'qu', canEdit: true, max: 32 });
    expect(a.invite).toMatchObject({ link: null, canCreate: true, canRevoke: false, links: [], options: DISCORD_INVITE_OPTIONS });
  });

  test("the owner is told plainly why they cannot leave; a vanity address shows; another's link is not theirs to turn off", () => {
    const a = withServer({ noun: 'Server', fields: {} }, sa({ ownerId: '1', vanity: 'cool', links: [{ code: 'abc', channel_id: '901', inviter_id: '7', uses: 3, max_uses: 0, max_age: 0, created_at: null, expires_at: null, temporary: false }] }), [...caps]);
    expect(a.leaving).toEqual({ can: false, reason: expect.stringMatching(/^You own this server: /) });
    expect(a.invite?.vanity).toBe('https://discord.gg/cool');
    expect(a.invite?.links?.[0]).toEqual({ code: 'abc', url: 'https://discord.gg/abc', conversation: '901', inviter: '7', uses: 3, maxUses: 0, canRevoke: false });
    expect(a.invite?.link).toBe('https://discord.gg/abc');
  });

  test('without the capability, nothing is added; without the permission, a reason', () => {
    expect(withServer({ fields: {} }, sa(), [])).toEqual({ fields: {} });
    const a = withServer({ fields: {} }, sa({ can: { createInvite: false, changeNickname: false } }), [...caps]);
    expect(a.invite).toMatchObject({ canCreate: false, reason: 'You need the Create Invite permission.' });
    expect(a.nick).toMatchObject({ canEdit: false, reason: 'You need the Change Nickname permission here.' });
  });

  test('invite plans: the defaults, a choice Discord does not offer refused, revoking only what you may', () => {
    expect(invitePlan(sa(), { key: 'invite', op: 'create' })).toEqual({ kind: 'createInvite', guildId: '900', channelId: '901', maxAge: 604800, maxUses: 0, temporary: false });
    expect(() => invitePlan(sa(), { key: 'invite', op: 'create', maxAge: 99 })).toThrow('Not one of the expiry choices Discord offers');
    const mine = { code: 'mine', channel_id: '901', inviter_id: '1', uses: 0, max_uses: 5, max_age: 3600, created_at: null, expires_at: null, temporary: false };
    const theirs = { ...mine, code: 'theirs', inviter_id: '7' };
    expect(invitePlan(sa({ links: [mine, theirs] }), { key: 'invite', op: 'revoke', code: 'mine' })).toEqual({ kind: 'revokeInvite', guildId: '900', code: 'mine', channelId: '901' });
    expect(() => invitePlan(sa({ links: [mine, theirs] }), { key: 'invite', op: 'revoke', code: 'theirs' })).toThrow(/^Only people who may manage the server/);
  });

  test('capabilities only for the modules found', () => {
    expect(serverCapabilities({})).toEqual([]);
    expect(serverCapabilities({ GuildScheduledEventStore: true })).toEqual(['events']);
    expect(serverCapabilities({ GuildScheduledEventStore: true, EventActions: true, GuildActions: true, VerificationActions: true, InviteActions: true, Rest: true, NickActions: true, GuildMemberStore: true })).toEqual(['events', 'rsvp', 'leave', 'gates', 'inviteLinks', 'nick']);
  });
});

// ---------------------------------------------------------------- the hook, against fake client modules

const KEY = 'discord-servers-test-marker-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

function hookPage(mods: Record<string, unknown>) {
  const posted: any[] = [];
  const timers: (() => void)[] = [];
  const events = new EventTarget();
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const win: any = { addEventListener: (t: string, fn: (e: any) => void) => events.addEventListener(t, fn), dispatchEvent: (e: Event) => events.dispatchEvent(e) };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: 'https://discord.com/app', pathname: '/app', reload() {} };
  const session = { getItem: () => null, setItem() {} };
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => timers.push(fn), () => {});
  // One runtime whose cache holds the modules, as the probe chunk finds it.
  const cache: Record<string, { exports: any }> = {};
  for (const [k, v] of Object.entries(mods)) cache[k] = { exports: v };
  const T: any = () => ({});
  T.c = cache;
  T.m = {};
  const chunks: any[] = [];
  chunks.push = (c: any) => {
    c[2]?.(T);
    return 0;
  };
  win.webpackChunkdiscord_app = chunks;
  chunks.push = chunks.push;
  timers.splice(0).forEach((fn) => fn());
  const cmd = async (c: unknown) => {
    const id = crypto.randomUUID();
    events.dispatchEvent(new CustomEvent(DOWN, { detail: { t: 'cmd', id, cmd: c } }));
    for (let i = 0; i < 20; i++) {
      const r = posted.find((m) => m.t === 'reply' && m.id === id);
      if (r) return r;
      await Bun.sleep(0);
    }
    return null;
  };
  return { posted, cmd, win };
}

const named = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });

function world() {
  const calls: string[] = [];
  const handlers = new Map<string, ((a: any) => void)[]>();
  const me = { id: '1', username: 'me' };
  const ev: any = { id: 'e1', guild_id: '900', channel_id: '901', name: 'Office hours', scheduled_start_time: '2026-11-17T17:00:00.000Z', status: 1, entity_type: 2, guild_scheduled_event_exceptions: [] };
  const rsvps = new Map<string, any>();
  let member: any = { userId: '1', roles: [], isPending: true, flags: 0, joinedAt: new Date().toISOString() };
  const guild: any = { id: '900', name: 'Guild', ownerId: '2', features: new Set(['GUILD_ONBOARDING']), rulesChannelId: '901' };
  const prompts = [{ id: 'p1', title: 'Pick', singleSelect: false, required: true, inOnboarding: true, options: [{ id: 'o1', title: 'Art' }] }];
  const mods = {
    dispatcher: { dispatch() {}, subscribe: (e: string, fn: (a: any) => void) => void handlers.set(e, [...(handlers.get(e) ?? []), fn]), unsubscribe() {}, isDispatching: () => false, _subscriptions: {} },
    users: named('UserStore', { getCurrentUser: () => me, getUser: (id: string) => ({ id, username: `u${id}` }) }),
    channels: named('ChannelStore', { getChannel: (id: string) => (id === '901' ? { id: '901', type: 0, guild_id: '900' } : null) }),
    guilds: named('GuildStore', { getGuilds: () => ({ '900': guild }), getGuild: (id: string) => (id === '900' ? guild : null) }),
    members: named('GuildMemberStore', { getMember: () => member }),
    perms: named('PermissionStore', { can: () => true }),
    events: named('GuildScheduledEventStore', {
      getGuildScheduledEvent: (id: string) => (id === 'e1' ? ev : null),
      getGuildScheduledEventsForGuild: (g: string) => (g === '900' ? [ev] : []),
      getRsvp: (e: string, x: string | null) => rsvps.get(`${e}:${x}`) ?? null,
      hasUserCount: () => true,
      getUserCount: () => 7 + rsvps.size,
    }),
    eventActions: {
      createRsvpForGuildEvent: async (e: string, x: string | null, g: string, r: number) => (calls.push(`create ${e} ${x} ${g} ${r}`), rsvps.set(`${e}:${x}`, { response: r })),
      deleteRsvpForGuildEvent: async (e: string, x: string | null, g: string) => (calls.push(`delete ${e} ${x} ${g}`), rsvps.delete(`${e}:${x}`)),
      getGuildEventsForCurrentUser: async (g: string) => void calls.push(`load ${g}`),
    },
    guildActions: { leaveGuild: async (g: string) => void calls.push(`leave ${g}`), updateMemberRoles() {} },
    verification: {
      fetchVerificationForm: async () => ({ version: 'v1', description: null, form_fields: [{ field_type: 'TERMS', label: 'Rules', values: ['Be kind'], required: true }] }),
      submitVerificationForm: async (g: string, form: any) => {
        calls.push(`submit ${g} ${JSON.stringify(form.formFields.map((f: any) => f.response))}`);
        member = { ...member, isPending: false };
        return { application_status: 'APPROVED' };
      },
    },
    onboardingStore: named('GuildOnboardingPromptsStore', { getOnboardingPromptsForOnboarding: () => prompts, getOnboardingPrompts: () => prompts }),
    onboarding: {
      selectOption: (g: string, p: string, o: string, on: boolean) => calls.push(`select ${g} ${p} ${o} ${on}`),
      completeOnboarding: (g: string) => {
        calls.push(`complete ${g}`);
        member = { ...member, flags: 2 };
      },
      finishOnboarding: (g: string) => calls.push(`finish ${g}`),
    },
    nick: { changeNickname: (g: string, c: unknown, u: string, n: string) => (calls.push(`nick ${g} ${c} ${u} ${n}`), Promise.resolve({ body: { nick: n } })) },
    invites: {
      resolveInvite() {},
      acceptInvite() {},
      createInvite: async (c: string, body: any, where: string) => (calls.push(`invite ${c} ${JSON.stringify(body)} ${where}`), { code: 'newcode', channel: { id: c }, max_age: body.max_age, max_uses: body.max_uses, uses: 0, inviter: me }),
      revokeInvite: async (i: any) => void calls.push(`revoke ${i.code} ${i.channel.id}`),
    },
    rest: { get: async () => (calls.push('rest get'), { body: [] }), post() {}, put() {}, patch() {}, del() {} },
    messages: { sendMessage() {}, editMessage() {} },
  };
  const emit = (e: string, a: any) => (handlers.get(e) ?? []).forEach((fn) => fn(a));
  return { mods, calls, emit, rsvps, guild, setMember: (m: any) => (member = m) };
}

describe('the hook', () => {
  test('finds the server modules by their shape', () => {
    const w = world();
    const p = hookPage(w.mods);
    const report = p.posted.filter((m) => m.t === 'finders').at(-1);
    expect(report.results).toMatchObject({ GuildScheduledEventStore: true, EventActions: true, GuildActions: true, VerificationActions: true, OnboardingStore: true, OnboardingActions: true, NickActions: true });
  });

  test("Interested and back through the client's own RSVP calls; one occurrence answered on its own", async () => {
    const w = world();
    const p = hookPage(w.mods);
    const on = await p.cmd({ kind: 'rsvp', guildId: '900', eventId: 'e1', interested: true });
    expect(on.result.event).toMatchObject({ id: 'e1', rsvp: 1, user_count: 8 });
    // Already interested: nothing sent again.
    await p.cmd({ kind: 'rsvp', guildId: '900', eventId: 'e1', interested: true });
    // Not this one: an answer of its own, "not interested".
    await p.cmd({ kind: 'rsvp', guildId: '900', eventId: 'e1', exceptionId: 'x1', interested: false });
    await p.cmd({ kind: 'rsvp', guildId: '900', eventId: 'e1', interested: false });
    expect(w.calls).toEqual(['create e1 null 900 1', 'create e1 x1 900 0', 'delete e1 null 900']);
    expect((await p.cmd({ kind: 'rsvp', guildId: '900', eventId: 'nope', interested: true })).error).toBe('Discord does not know that event here');
  });

  test('opening the events list loads your answers; an update is passed on with the count, never who answered', async () => {
    const w = world();
    const p = hookPage(w.mods);
    const r = await p.cmd({ kind: 'serverEvents', guildId: '900' });
    expect(w.calls).toEqual(['load 900']);
    expect(r.result.events[0]).toMatchObject({ id: 'e1', rsvp: 'none', user_count: 7 });
    w.emit('GUILD_SCHEDULED_EVENT_USER_ADD', { userId: '55', guildEventId: 'e1', guildId: '900' });
    const d = p.posted.filter((m) => m.t === 'dispatch' && m.event === 'GUILD_SCHEDULED_EVENT_USER_ADD').at(-1);
    expect(d.data).toEqual({ event: expect.objectContaining({ id: 'e1', user_count: 7 }) });
    expect(JSON.stringify(d.data)).not.toContain('"55"');
  });

  test('leaving: refused for the owner before anything is called, else the client\'s Leave Server with what goes with it', async () => {
    const w = world();
    const p = hookPage(w.mods);
    w.guild.ownerId = '1';
    expect((await p.cmd({ kind: 'leaveGuild', guildId: '900' })).error).toMatch(/^You own this server/);
    expect(w.calls).toEqual([]);
    w.guild.ownerId = '2';
    expect((await p.cmd({ kind: 'leaveGuild', guildId: '900' })).result).toMatchObject({ left: true, guildId: '900' });
    expect(w.calls).toEqual(['leave 900']);
  });

  test('rules: shown as the form has them, never agreed for the owner, then onboarding through its own actions', async () => {
    const w = world();
    const p = hookPage(w.mods);
    const g = await p.cmd({ kind: 'gate', guildId: '900' });
    expect(g.result).toMatchObject({ kind: 'screening', form: { version: 'v1', form_fields: [{ field_type: 'TERMS', values: ['Be kind'] }] } });
    expect((await p.cmd({ kind: 'answerGate', guildId: '900', answer: { kind: 'rules' } })).error).toBe('Agreeing to the rules is yours to do: tick that you agree');
    expect(w.calls).toEqual([]);
    const r = await p.cmd({ kind: 'answerGate', guildId: '900', answer: { kind: 'rules', agree: true } });
    expect(w.calls).toEqual(['submit 900 [true]']);
    expect(r.result).toMatchObject({ status: 'APPROVED', next: { kind: 'onboarding', prompts: [{ id: 'p1', options: [{ id: 'o1' }] }] } });
    const o = await p.cmd({ kind: 'answerGate', guildId: '900', answer: { kind: 'onboarding', picks: ['o1'] } });
    expect(o.result).toEqual({ status: null, next: null });
    expect(w.calls.slice(1)).toEqual(['select 900 p1 o1 true', 'complete 900', 'finish 900']);
    expect((await p.cmd({ kind: 'gate', guildId: '900' })).result).toBeNull();
  });

  test('a member from before the server had onboarding is not asked to onboard', async () => {
    const w = world();
    w.setMember({ userId: '1', roles: [], isPending: false, flags: 0, joinedAt: '2024-01-01T00:00:00.000Z' });
    const p = hookPage(w.mods);
    expect((await p.cmd({ kind: 'gate', guildId: '900' })).result).toBeNull();
  });

  test('your own application turned down comes through; someone else\'s never does', () => {
    const w = world();
    const p = hookPage(w.mods);
    w.emit('GUILD_JOIN_REQUEST_UPDATE', { guildId: '900', status: 'REJECTED', request: { user_id: '77', rejection_reason: 'x' } });
    w.emit('GUILD_JOIN_REQUEST_UPDATE', { guildId: '900', status: 'REJECTED', request: { user_id: '1', rejection_reason: 'Not now' } });
    const ds = p.posted.filter((m) => m.t === 'dispatch' && m.event === 'GUILD_JOIN_REQUEST_UPDATE');
    expect(ds.map((d) => d.data)).toEqual([{ application: { guild_id: '900', status: 'REJECTED', reason: 'Not now' } }]);
  });

  test("links through the client's Invite People and Invites tab; a nickname through its Change Nickname", async () => {
    const w = world();
    const p = hookPage(w.mods);
    const made = await p.cmd({ kind: 'createInvite', guildId: '900', maxAge: 3600, maxUses: 5, temporary: false });
    expect(made.result.link).toMatchObject({ code: 'newcode', channel_id: '901', max_age: 3600, max_uses: 5 });
    expect((await p.cmd({ kind: 'serverAbout', guildId: '900' })).result).toMatchObject({ ownerId: '2', links: [{ code: 'newcode' }], inviteChannelId: '901', can: { changeNickname: true } });
    await p.cmd({ kind: 'revokeInvite', guildId: '900', code: 'newcode' });
    await p.cmd({ kind: 'setNick', guildId: '900', nick: 'qu' });
    expect(w.calls).toEqual(['invite 901 {"max_age":3600,"max_uses":5,"temporary":false} Guild Header', 'revoke newcode 901', 'nick 900 null @me qu']);
  });
});
