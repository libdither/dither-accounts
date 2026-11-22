/**
 * What the adapter says about people beyond their messages, against the fake server: presence at start and as it
 * ages to idle and offline, read receipts on your DMs, roles and user groups changing, and when @all is offered.
 */
import { afterEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { ZulipAdapter } from '../src/adapter.ts';
import { fakeZulip, type FakeOptions } from './fake-zulip.ts';
import { testLink, type TestLink } from './link.ts';

let stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function online(opts: FakeOptions = {}) {
  const z = fakeZulip(opts);
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { apiKey: z.key });
  const a = new ZulipAdapter();
  a.start(link);
  a.onConnect();
  stops.push(() => z.stop(), () => a.shutdown());
  await link.next((e) => e.t === 'status' && e.status === 'online');
  return { z, link, a, host: new URL(z.url).host };
}

const of = <T extends P.AdapterEvent['t']>(link: TestLink, t: T) => link.events.filter((e): e is Extract<P.AdapterEvent, { t: T }> => e.t === t);
const sec = () => Math.floor(Date.now() / 1000);

test('presence at start, offline included, and again as it ages to idle and offline', async () => {
  const now = sec();
  const { z, a, link, host } = await online({
    register: {
      server_presence_offline_threshold_seconds: 200,
      presences: { 8: { active_timestamp: now, idle_timestamp: now }, 9: { active_timestamp: now - 10, idle_timestamp: now - 10 }, 10: { active_timestamp: now - 5000, idle_timestamp: now - 5000 } },
    },
    // Bob writes once, so the hub knows him.
    messages: [{ id: 103, sender_id: 10, sender_full_name: 'Bob Kim', content: 'yo', timestamp: 1_700_000_030, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [], submessages: [], flags: ['read'] }],
  });
  const states = () => Object.fromEntries(of(link, 'presence').map((e) => [e.who, e.state]));
  // Yourself is not said: your own presence is the account's (selfState).
  expect(states()).toEqual({ [`${host}/u/9`]: 'online', [`${host}/u/10`]: 'offline' });
  // Ann's last ping ages past the threshold: idle (she was there), then offline once her idle time ages too.
  (a as any).st.presence.set(9, { active: Date.now() - 250_000, idle: Date.now() - 100_000 });
  (a as any).presenceSweep();
  expect(of(link, 'presence').at(-1)).toMatchObject({ who: `${host}/u/9`, state: 'idle' });
  (a as any).st.presence.set(9, { active: Date.now() - 250_000, idle: Date.now() - 250_000 });
  (a as any).presenceSweep();
  expect(of(link, 'presence').at(-1)).toMatchObject({ who: `${host}/u/9`, state: 'offline' });
  // Nothing changed: nothing said.
  const n = of(link, 'presence').length;
  (a as any).presenceSweep();
  expect(of(link, 'presence')).toHaveLength(n);
  // Back: Zulip's event says it, with the time she was active.
  const back = link.next((e) => e.t === 'presence' && e.who === `${host}/u/9` && e.state === 'online');
  z.push({ type: 'presence', user_id: 9, presences: { 9: { active_timestamp: sec(), idle_timestamp: sec() } } });
  await back;
});

test('someone active for a while stays online: everyone\'s presence is read again each ping interval', async () => {
  const now = sec();
  const { a, link, host } = await online({
    register: { server_presence_offline_threshold_seconds: 140, presences: { 9: { active_timestamp: now, idle_timestamp: now } } },
    realmPresence: { 'user9@chat.example.org': { website: { status: 'active', timestamp: now }, aggregated: { status: 'active', timestamp: now } } },
  });
  // Her event was minutes ago here: the sweep alone would say offline.
  (a as any).st.presence.set(9, { active: Date.now() - 300_000, idle: Date.now() - 300_000 });
  (a as any).presenceSweep();
  expect(of(link, 'presence').at(-1)).toMatchObject({ who: `${host}/u/9`, state: 'offline' });
  // The server says she is active now.
  await (a as any).refreshPresence();
  expect(of(link, 'presence').at(-1)).toMatchObject({ who: `${host}/u/9`, state: 'online' });
});

test('your DM is asked about at start, and whoever read it is said once', async () => {
  const now = sec();
  const dm = (id: number, sender: number, ts: number) => ({ id, sender_id: sender, sender_full_name: sender === 8 ? 'Quinn Park' : 'Bob Kim', content: 'x', timestamp: ts, type: 'private', display_recipient: [{ id: 8, email: 'user8@chat.example.org', full_name: 'Quinn Park' }, { id: 10, email: 'user10@chat.example.org', full_name: 'Bob Kim' }], reactions: [], submessages: [], flags: ['read'] });
  const { z, link, host } = await online({ register: { realm_enable_read_receipts: true }, messages: [dm(104, 8, now - 60)], readers: { 104: [10, 8] } });
  const r = await link.next<Extract<P.AdapterEvent, { t: 'receipt' }>>((e) => e.t === 'receipt');
  expect(r).toMatchObject({ conversation: `${host}/dm/8,10`, messages: [`${host}/m/104`], who: `${host}/u/10`, state: 'read' });
  expect(z.calls.filter((c) => c.path === '/messages/104/read_receipts')).toHaveLength(1);
});

test('with read receipts off in the organization, nothing is asked', async () => {
  const now = sec();
  const { z, a } = await online({ register: { realm_enable_read_receipts: false }, messages: [{ id: 104, sender_id: 8, sender_full_name: 'Quinn Park', content: 'x', timestamp: now - 60, type: 'private', display_recipient: [{ id: 8, email: 'user8@chat.example.org', full_name: 'Quinn Park' }, { id: 10, email: 'user10@chat.example.org', full_name: 'Bob Kim' }], reactions: [], submessages: [], flags: ['read'] }] });
  expect(a.receipts.size).toBe(0);
  await a.receipts.tick();
  expect(z.calls.some((c) => c.path.endsWith('/read_receipts'))).toBe(false);
});

test('a new role in the organization is one role lost and one given; a user group joined or left is a role too', async () => {
  const { z, link, host } = await online({ register: { realm_user_groups: [{ id: 19, name: 'designers', members: [9], is_system_group: false }, { id: 11, name: 'role:administrators', members: [9], is_system_group: true }] } });
  const space = { kind: 'space', nativeId: host };
  z.push({ type: 'realm_user', op: 'update', person: { user_id: 10, role: 200 } });
  await link.next((e) => e.t === 'role' && e.given);
  expect(of(link, 'role')).toEqual([
    { t: 'role', target: space, member: `${host}/u/10`, role: 'Member', given: false, ts: expect.any(Number) },
    { t: 'role', target: space, member: `${host}/u/10`, role: 'Administrator', given: true, ts: expect.any(Number) },
  ] as any);
  // The system group that changes with it says nothing more; a user group does.
  z.push({ type: 'user_group', op: 'add_members', group_id: 11, user_ids: [10] });
  z.push({ type: 'user_group', op: 'add_members', group_id: 19, user_ids: [10, 9] });
  z.push({ type: 'user_group', op: 'remove_members', group_id: 19, user_ids: [9] });
  await link.next((e) => e.t === 'role' && !e.given && e.member === `${host}/u/9`);
  expect(of(link, 'role').slice(2).map((e) => [e.member, e.role, e.given])).toEqual([
    [`${host}/u/10`, 'designers', true],
    [`${host}/u/9`, 'designers', false],
  ]);
  // A new group: the people it is made with are given it.
  z.push({ type: 'user_group', op: 'add', group: { id: 22, name: 'reviewers', members: [10], is_system_group: false } });
  await link.next((e) => e.t === 'role' && e.role === 'reviewers');
  expect(of(link, 'role').slice(4).map((e) => [e.member, e.role, e.given])).toEqual([[`${host}/u/10`, 'reviewers', true]]);
  // Deactivated: lost; back again: given.
  z.push({ type: 'user_group', op: 'update', group_id: 22, data: { deactivated: true } });
  await link.next((e) => e.t === 'role' && e.role === 'reviewers' && !e.given);
  z.push({ type: 'user_group', op: 'update', group_id: 22, data: { deactivated: false } });
  await link.next((e) => e.t === 'role' && e.role === 'reviewers' && e.given && of(link, 'role').filter((x) => x.role === 'reviewers').length === 3);
  // A rename says nothing.
  z.push({ type: 'user_group', op: 'update', group_id: 22, data: { name: 'reviewers-x' } });
  z.push({ type: 'user_group', op: 'add_members', group_id: 22, user_ids: [9] });
  await link.next((e) => e.t === 'role' && e.role === 'reviewers-x');
  expect(of(link, 'role').slice(4).map((e) => [e.member, e.role, e.given])).toEqual([
    [`${host}/u/10`, 'reviewers', true],
    [`${host}/u/10`, 'reviewers', false],
    [`${host}/u/10`, 'reviewers', true],
    [`${host}/u/9`, 'reviewers-x', true],
  ]);
});

test('@all is offered in a small channel, and in a big one only to those Zulip lets use it', async () => {
  const many = Array.from({ length: 20 }, (_, i) => 100 + i);
  const groups = [{ id: 11, name: 'role:administrators', members: [9], is_system_group: true, direct_subgroup_ids: [10] }, { id: 10, name: 'role:owners', members: [], is_system_group: true }];
  const { a, host } = await online({ subscribers: { 4: many }, register: { realm_can_mention_many_users_group: 11, realm_user_groups: groups } });
  const ask = (conv: string) => (a as any).command({ t: 'mentionables', id: 'c', conversation: conv, query: '', limit: 10 }) as Promise<P.Mentionables>;
  expect((await ask(`${host}/s/3/t/plans`)).everyone).toBe(true);
  expect((await ask(`${host}/s/4`)).everyone).toBe(false);
  expect((await ask(`${host}/dm/8,9`)).everyone).toBe(false);
  // Made an owner (role:owners, nested in role:administrators): now it may.
  (a as any).st.groups.get(10).members.push(8);
  expect((await ask(`${host}/s/4`)).everyone).toBe(true);
});

test("a profile names the organization with their role and user groups; people fields and a bot's owner link; dates read; custom links lead somewhere", async () => {
  const groups = [
    { id: 19, name: 'designers', members: [9], is_system_group: false },
    { id: 20, name: 'admins-old', members: [9], is_system_group: false, deactivated: true },
    { id: 21, name: 'backend', members: [9, 10], is_system_group: false },
    { id: 11, name: 'role:administrators', members: [9], is_system_group: true },
  ];
  const fields = [
    { id: 1, name: 'Birthday', type: 4, order: 0 },
    { id: 2, name: 'Manager', type: 6, order: 1 },
    { id: 3, name: 'Forge', type: 7, order: 2, field_data: JSON.stringify({ subtype: 'custom', url_pattern: 'https://forge.example.org/%(username)s' }) },
    { id: 4, name: 'GitHub', type: 7, order: 3, field_data: JSON.stringify({ subtype: 'github' }) },
    { id: 5, name: 'Reviewers', type: 6, order: 4 },
  ];
  const { a, host } = await online({
    profileFields: fields,
    users: {
      9: { date_joined: '2024-01-02T03:04:05+00:00', profile_data: { 1: { value: '1990-03-05' }, 2: { value: '[10]' }, 5: { value: '[10, 77]' }, 3: { value: 'ann lee' }, 4: { value: 'annlee' } } },
      12: { full_name: 'Build Bot', is_bot: true, bot_owner_id: 9, role: 400 },
    },
    register: {
      realm_user_groups: groups,
      realm_emoji: { 42: { id: '42', name: 'party_parrot', source_url: '/user_avatars/2/emoji/images/42.png', deactivated: false } },
      user_status: { 9: { status_text: 'Out today', emoji_name: 'party_parrot', emoji_code: '42', reaction_type: 'realm_emoji' } },
    },
  });
  const profile = (who: string) => (a as any).command({ t: 'profile', id: 'p', who }) as Promise<P.PersonAbout>;
  const ann = await profile(`${host}/u/9`);
  // The organization first with the role, then the groups by name: not a deactivated one, nor a system one.
  expect(ann.mutualSpaces).toEqual([{ id: host, roles: [{ name: 'Administrator' }, { name: 'backend' }, { name: 'designers' }], joinedAt: Date.parse('2024-01-02T03:04:05+00:00') }]);
  expect(ann.facts).toEqual([
    { label: 'Role', value: 'Administrator' },
    { label: 'Birthday', value: 'March 5, 1990' },
    { label: 'Manager', value: 'Bob Kim', people: [`${host}/u/10`] },
    // Someone not known here: named by id, and the names stay text.
    { label: 'Reviewers', value: 'Bob Kim, User 77' },
  ]);
  expect(ann.links).toEqual([
    { label: 'Forge', value: 'ann lee', url: 'https://forge.example.org/ann%20lee' },
    { label: 'GitHub', value: 'annlee', url: 'https://github.com/annlee' },
  ]);
  // The organization's emoji by name, with its picture.
  expect(ann.status).toEqual({ text: 'Out today', emoji: ':party_parrot:', emojiUrl: 'zulip:/user_avatars/2/emoji/images/42.png' });
  const bot = await profile(`${host}/u/12`);
  expect(bot.facts).toContainEqual({ label: 'Owner', value: 'Ann Lee', people: [`${host}/u/9`] });
  expect(bot.mutualSpaces?.[0].roles).toEqual([{ name: 'Member' }]);
});

test('a walk of the members says each one’s role and user groups', async () => {
  const { a, link, host } = await online({ register: { realm_user_groups: [{ id: 19, name: 'designers', members: [9], is_system_group: false }, { id: 11, name: 'role:administrators', members: [9], is_system_group: true }] } });
  await (a as any).command({ t: 'walkMembers', id: 'w', space: host, query: '', limit: 10 });
  const roles = Object.fromEntries(of(link, 'members').flatMap((e) => e.members.map((m) => [m.who, m.roles])));
  expect(roles[`${host}/u/9`]).toEqual(['Administrator', 'designers']);
  expect(roles[`${host}/u/10`]).toEqual(['Member']);
});
