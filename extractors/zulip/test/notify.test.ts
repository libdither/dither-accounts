/**
 * What Zulip would notify you about, as the places' facts say it (adapter.ts channelMute, topicNotify): a channel
 * with notifications on is every message; a followed topic is every message only while the followed-topic
 * notifications are on; a topic unmuted in a muted channel is as the channel's settings say; wildcards off is
 * suppressEveryone. And which mentions were by name, by a group you are in, or by a wildcard.
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

const sub = (stream_id: number, name: string, extra: object = {}) => ({ stream_id, name, description: '', invite_only: false, history_public_to_subscribers: true, is_muted: false, ...extra });

async function online(opts: FakeOptions = {}) {
  const z = fakeZulip(opts);
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { apiKey: z.key });
  const a = new ZulipAdapter();
  a.start(link);
  a.onConnect();
  stops.push(() => z.stop(), () => a.shutdown());
  await link.next((e) => e.t === 'status' && e.status === 'online');
  const host = new URL(z.url).host;
  return { z, link, a, host };
}

/** Each conversation's last fact so far (from `from` on). */
const convs = (link: TestLink, from = 0) => new Map(link.events.slice(from).flatMap((e) => (e.t === 'conversation' ? [[e.conversation.nativeId, e.conversation] as const] : [])));

// general (3) as Zulip's defaults have it; design (4) muted; news (5) set to notify every message, wildcards off; ops (6) muted with wildcards on.
const CHANNELS = {
  subscriptions: [
    sub(3, 'general'),
    sub(4, 'design', { is_muted: true }),
    sub(5, 'news', { desktop_notifications: true, wildcard_mentions_notify: false }),
    sub(6, 'ops', { is_muted: true, wildcard_mentions_notify: true }),
  ],
  user_topics: [
    { stream_id: 3, topic_name: 'plans', visibility_policy: 3 },
    { stream_id: 4, topic_name: 'logo', visibility_policy: 2 },
    { stream_id: 4, topic_name: 'fonts', visibility_policy: 3 },
    { stream_id: 5, topic_name: 'quiet', visibility_policy: 1 },
  ],
};
const topics = () =>
  [
    { id: 110, stream_id: 4, subject: 'logo', display_recipient: 'design' },
    { id: 111, stream_id: 4, subject: 'fonts', display_recipient: 'design' },
    { id: 112, stream_id: 5, subject: 'quiet', display_recipient: 'news' },
    { id: 113, stream_id: 5, subject: 'daily', display_recipient: 'news' },
    { id: 114, stream_id: 3, subject: 'misc', display_recipient: 'general' },
  ].map((m) => ({ ...m, sender_id: 9, sender_full_name: 'Ann Lee', content: 'hi', timestamp: 1_700_000_050, type: 'stream', reactions: [], submessages: [], flags: ['read'] }));

test("the places' levels, as Zulip's defaults and settings have them", async () => {
  const { link, host } = await online({ register: CHANNELS, messages: topics() });
  const c = convs(link);
  // Channels: Zulip's defaults notify mentions only (nothing said), wildcards on; a muted one lets wildcards through only where it says so itself.
  expect(c.get(`${host}/s/3`)?.mute).toEqual({ suppressEveryone: false });
  expect(c.get(`${host}/s/4`)?.mute).toEqual({ muted: true, level: 'mentions', suppressEveryone: true });
  expect(c.get(`${host}/s/5`)?.mute).toEqual({ level: 'all', suppressEveryone: true });
  expect(c.get(`${host}/s/6`)?.mute).toEqual({ muted: true, level: 'mentions', suppressEveryone: false });
  // Followed, with the followed-topic notifications on by default: every message, and wildcards.
  expect(c.get(`${host}/s/3/t/plans`)).toMatchObject({ mute: { level: 'all', suppressEveryone: false }, thread: { joined: true, notify: 'all' } });
  // Left to its channel: nothing said, the channel's level holds.
  expect(c.get(`${host}/s/3/t/misc`)?.mute).toEqual({});
  // Unmuted in a muted channel: as the channel's settings, which notify mentions only; not every message by itself.
  expect(c.get(`${host}/s/4/t/logo`)?.mute).toEqual({ level: 'mentions', suppressEveryone: false });
  // Followed in a muted channel: the followed-topic settings decide.
  expect(c.get(`${host}/s/4/t/fonts`)).toMatchObject({ mute: { level: 'all', suppressEveryone: false }, thread: { joined: true, notify: 'all' } });
  // Muted in a channel that notifies every message: your name only, wildcards neither; said in full, so the
  // channel's level does not show through.
  expect(c.get(`${host}/s/5/t/quiet`)).toMatchObject({ mute: { muted: true, level: 'mentions', suppressEveryone: true }, thread: { joined: false, muted: true } });
  expect(c.get(`${host}/s/5/t/daily`)?.mute).toEqual({});
});

test('followed-topic notifications off: a followed topic is every message only where its channel is', async () => {
  const off = { enable_followed_topic_desktop_notifications: false, enable_followed_topic_push_notifications: false, enable_followed_topic_audible_notifications: true, notification_sound: 'none', enable_followed_topic_wildcard_mentions_notify: false };
  const { link, host } = await online({
    register: { ...CHANNELS, user_topics: [...CHANNELS.user_topics, { stream_id: 5, topic_name: 'daily', visibility_policy: 3 }], user_settings: off },
    messages: topics(),
  });
  const c = convs(link);
  // A sound with the sound set to none is no notification.
  expect(c.get(`${host}/s/3/t/plans`)).toMatchObject({ mute: { suppressEveryone: false }, thread: { joined: true, notify: 'mentions' } });
  expect(c.get(`${host}/s/3/t/plans`)?.mute?.level).toBeUndefined();
  // In a muted channel it must say so, or the channel's mute would hold.
  expect(c.get(`${host}/s/4/t/fonts`)?.mute).toEqual({ level: 'mentions', suppressEveryone: true });
  // Its channel notifies every message: so does it.
  expect(c.get(`${host}/s/5/t/daily`)).toMatchObject({ mute: { level: 'all', suppressEveryone: true }, thread: { notify: 'all' } });
});

test('settings changed in Zulip: the account default and a channel setting say their places again', async () => {
  const { z, link, host } = await online({ register: CHANNELS, messages: topics() });
  let from = link.events.length;
  z.push({ type: 'user_settings', op: 'update', property: 'enable_stream_push_notifications', value: true });
  await link.next((e) => e.t === 'conversation' && e.conversation.nativeId === `${host}/s/3` && e.conversation.mute?.level === 'all', 5_000, from);
  // The unmuted topic in the muted channel now notifies every message, from the channel's settings.
  await link.next((e) => e.t === 'conversation' && e.conversation.nativeId === `${host}/s/4/t/logo` && e.conversation.mute?.level === 'all', 5_000, from);
  // A muted channel stays muted.
  expect(convs(link, from).get(`${host}/s/4`)?.mute).toEqual({ muted: true, level: 'mentions', suppressEveryone: true });

  from = link.events.length;
  z.push({ type: 'subscription', op: 'update', stream_id: 3, property: 'wildcard_mentions_notify', value: false });
  await link.next((e) => e.t === 'conversation' && e.conversation.nativeId === `${host}/s/3` && e.conversation.mute?.suppressEveryone === true, 5_000, from);
  // Its topics' facts stand (a fact that did not change is not sent again): the followed one keeps wildcards (the
  // followed-topic setting), the other inherits the channel's.
  expect(convs(link).get(`${host}/s/3/t/plans`)?.mute).toEqual({ level: 'all', suppressEveryone: false });
  expect(convs(link).get(`${host}/s/3/t/misc`)?.mute).toEqual({});

  from = link.events.length;
  z.push({ type: 'user_settings', op: 'update', property: 'enable_followed_topic_wildcard_mentions_notify', value: false });
  await link.next((e) => e.t === 'conversation' && e.conversation.nativeId === `${host}/s/3/t/plans` && e.conversation.mute?.suppressEveryone === true, 5_000, from);
});

test('a mention by name, by a group you are in, by a wildcard; unread wildcards counted apart', async () => {
  const groups = [
    { id: 30, name: 'design team', members: [9], direct_subgroup_ids: [31] },
    { id: 31, name: 'reviewers', members: [8] },
    { id: 32, name: 'sales', members: [10] },
  ];
  const msg = (id: number, content: string, flags: string[]) => ({ id, sender_id: 9, sender_full_name: 'Ann Lee', content, timestamp: 1_700_000_060, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [], submessages: [], flags });
  const { z, link, host } = await online({
    register: {
      realm_user_groups: groups,
      unread_msgs: { streams: [{ stream_id: 3, topic: 'plans', unread_message_ids: [100, 120] }], pms: [], huddles: [], mentions: [100, 120] },
    },
    messages: [msg(120, 'look @**all**', ['stream_wildcard_mentioned', 'wildcard_mentioned'])],
  });
  // From `/register`: one of the two unread mentions was only a wildcard.
  await link.next((e) => e.t === 'read' && e.conversation === `${host}/s/3/t/plans` && e.mentions === 2 && e.wildcards === 1);
  const from = link.events.length;
  const live = [
    msg(130, 'hi @**Quinn Park|8**', ['mentioned']),
    // Through a subgroup of the group named: you are in it.
    msg(131, 'can @*design team* check', ['mentioned']),
    // Both: by name wins.
    msg(132, '@*reviewers* and @**Quinn Park|8**', ['mentioned']),
    // A silent mention of you and a group you are in: Zulip says mentioned, the group pinged.
    msg(133, '@_**Quinn Park|8** told @*reviewers*', ['mentioned']),
    msg(134, 'hey @**topic**', ['topic_wildcard_mentioned', 'wildcard_mentioned']),
    // A group you are not in, and Zulip says nothing of you.
    msg(135, '@*sales* hello', []),
    // Your name only in a quote (which pings nobody), your group outside it.
    msg(136, '```quote\n@**Quinn Park|8** said so\n```\n@*reviewers* agree?', ['mentioned']),
    msg(137, '> @**Quinn Park|8** said so\n\n@*reviewers* agree?', ['mentioned']),
  ];
  for (const m of live) {
    z.addMessage(m);
    z.push({ type: 'message', message: m, flags: m.flags });
  }
  const got = new Map<string, P.MessageFact>();
  for (const m of live) {
    const e = await link.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === `${host}/m/${m.id}`, 5_000, from);
    got.set(String(m.id), e.message);
  }
  const kinds = (id: number) => {
    const f = got.get(String(id))!;
    return { self: !!f.mentionsSelf, all: !!f.mentionsAll, group: !!f.mentionsGroup };
  };
  expect(kinds(130)).toEqual({ self: true, all: false, group: false });
  expect(kinds(131)).toEqual({ self: true, all: false, group: true });
  expect(kinds(132)).toEqual({ self: true, all: false, group: false });
  expect(kinds(133)).toEqual({ self: true, all: false, group: true });
  expect(kinds(134)).toEqual({ self: true, all: true, group: false });
  expect(kinds(135)).toEqual({ self: false, all: false, group: false });
  expect(kinds(136)).toEqual({ self: true, all: false, group: true });
  expect(kinds(137)).toEqual({ self: true, all: false, group: true });
  // Unread: 100, 130-133, 136 and 137 to you or your groups, 120 and 134 wildcards.
  await link.next((e) => e.t === 'read' && e.conversation === `${host}/s/3/t/plans` && e.unread === 10 && e.mentions === 9 && e.wildcards === 2, 5_000, from);
  // An edit that drops the name and keeps a wildcard: the count moves.
  const f2 = link.events.length;
  z.push({ type: 'update_message', message_id: 130, message_ids: [130], content: 'hi @**all**', edit_timestamp: 1_700_000_200, flags: ['stream_wildcard_mentioned', 'wildcard_mentioned'] });
  await link.next((e) => e.t === 'read' && e.conversation === `${host}/s/3/t/plans` && e.mentions === 9 && e.wildcards === 3, 5_000, f2);
});
