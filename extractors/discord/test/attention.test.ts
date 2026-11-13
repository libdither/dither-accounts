/**
 * attention.ts: mentions found late, the notification center, message requests and spam, notification settings as
 * they change, and the hook commands for mute, mark unread and mark many read. Fixtures are hand-written in the shapes
 * the hook's attention section forwards.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import {
  attentionCapabilities,
  attentionDispatch,
  attentionSnapshot,
  markReadManyHookCommand,
  markUnreadHookCommand,
  mentionEvents,
  MentionsPacer,
  messageAnswerOutcome,
  messageRequestChannel,
  muteHookCommand,
  muteOutcome,
  newAttention,
  requestChanges,
  settingsEvents,
  SPAM_DM_WARNING,
  withMessageRequests,
  type RawDM,
} from '../src/attention.ts';
import type { RawChannel, RawMessage, RawSnapshot } from '../src/discord-types.ts';
import { newState } from '../src/ingest.ts';

const SELF = '100000000000000001';
const ALICE = '400000000000000001';
const SPAMMER = '400000000000000009';
const GUILD = '200000000000000001';
const CAT = '300000000000000100';
const CHAN = '300000000000000200';
const THREAD = '500000000000000001';
const DM = '600000000000000001';
const REQ_DM = '600000000000000005';
const SPAM_DM = '600000000000000006';

const alice = { id: ALICE, username: 'alice.chen', global_name: 'Alice' };
const iso = (ms: number) => new Date(ms).toISOString();
/** A snowflake made at `ms`. */
const flake = (ms: number, n = 0) => ((BigInt(ms) - 1420070400000n) << 22n | BigInt(n)).toString();

function state() {
  const st = newState();
  st.selfId = SELF;
  st.guilds.set(GUILD, { id: GUILD, name: 'Rust' });
  return st;
}

function mention(over: Partial<RawMessage> = {}): RawMessage {
  const ts = Date.parse('2026-11-12T10:00:00Z');
  return { id: flake(ts), channel_id: CHAN, guild_id: GUILD, author: alice, content: `<@${SELF}> look`, timestamp: iso(ts), mentions: [{ id: SELF, username: 'me' }], ...over } as RawMessage;
}

describe('mentions found late', () => {
  test('each hit is a late message fact, flagged as mentioning you, after who wrote it', () => {
    const st = state();
    st.known.add(CHAN);
    const events = mentionEvents([mention()], [], st, newAttention());
    expect(events.map((e) => e.t)).toEqual(['identity', 'message']);
    const m = events[1] as Extract<P.AdapterEvent, { t: 'message' }>;
    expect(m.live).toBe(false);
    expect(m.late).toBe(true);
    expect(m.message.mentionsSelf).toBe(true);
    expect(m.message.mentionsAll).toBeUndefined();
  });

  test('@everyone or a role is in the list but not you by name: mentionsAll', () => {
    const st = state();
    st.known.add(CHAN);
    const role = mention({ content: 'hey <@&777>', mentions: [] });
    const everyone = mention({ id: flake(Date.parse('2026-11-12T10:01:00Z')), content: '@everyone hi', mentions: [], mention_everyone: true });
    const events = mentionEvents([role, everyone], [], st, newAttention()).filter((e) => e.t === 'message') as Extract<P.AdapterEvent, { t: 'message' }>[];
    expect(events.map((e) => [e.message.mentionsSelf, e.message.mentionsAll])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  test('a thread nobody opened comes first, from the channel the hook attached; each message once', () => {
    const st = state();
    const att = newAttention();
    const thread: RawChannel = { id: THREAD, type: 11, name: 'async closures', guild_id: GUILD, parent_id: CHAN };
    const m = mention({ channel_id: THREAD });
    const first = mentionEvents([m], [thread], st, att);
    expect(first[0]).toMatchObject({ t: 'conversation', conversation: { nativeId: THREAD, shape: 'thread', parentConversation: CHAN } });
    expect(st.known.has(THREAD)).toBe(true);
    expect(mentionEvents([m], [thread], st, att)).toEqual([]);
  });

  test('oldest first, whatever order the list came in', () => {
    const st = state();
    st.known.add(CHAN);
    const a = mention({ id: flake(Date.parse('2026-11-12T09:00:00Z')) });
    const b = mention({ id: flake(Date.parse('2026-11-12T11:00:00Z')) });
    const ids = mentionEvents([b, a], [], st, newAttention())
      .filter((e) => e.t === 'message')
      .map((e) => (e as Extract<P.AdapterEvent, { t: 'message' }>).message.nativeId);
    expect(ids).toEqual([a.id, b.id]);
  });
});

describe('asking for recent mentions at a person pace', () => {
  function pacer(o: { gapMs?: number; settleMs?: number } = {}) {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const runs: string[][] = [];
    const p = new MentionsPacer(async (r) => void runs.push(r), {
      ...o,
      now: () => now,
      setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
    });
    const advance = async (to: number) => {
      now = to;
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= to) t.fn();
        else timers.push(t);
      }
      await Bun.sleep(0);
    };
    return { p, runs, advance, timers };
  }

  test('waits a moment, and one request answers every reason that came meanwhile', async () => {
    const { p, runs, advance } = pacer({ settleMs: 1000, gapMs: 60_000 });
    p.want('snapshot');
    p.want('notification center');
    await advance(999);
    expect(runs).toEqual([]);
    await advance(1000);
    expect(runs).toEqual([['snapshot', 'notification center']]);
  });

  test('never sooner than the gap after the last', async () => {
    const { p, runs, advance, timers } = pacer({ settleMs: 1000, gapMs: 60_000 });
    p.want('snapshot');
    await advance(1000);
    p.want('notification center');
    expect(timers[0]!.at).toBe(61_000);
    await advance(30_000);
    expect(runs).toHaveLength(1);
    await advance(61_000);
    expect(runs).toEqual([['snapshot'], ['notification center']]);
  });
});

describe('the notification center', () => {
  test('a mention item with its message is a late mention at once; one without asks the list', () => {
    const st = state();
    st.known.add(CHAN);
    const want: string[] = [];
    const ev = attentionDispatch('NOTIFICATION_CENTER_ITEM_CREATE', { id: '1', type: 'recent_mention', message: mention() }, st, newAttention(), (w) => want.push(w));
    expect(ev.find((e) => e.t === 'message')).toMatchObject({ late: true });
    expect(want).toEqual([]);
    expect(attentionDispatch('NOTIFICATION_CENTER_ITEM_CREATE', { id: '2', type: 'reply_mention', message: null }, st, newAttention(), (w) => want.push(w))).toEqual([]);
    expect(want).toEqual(['notification center']);
  });

  test('a friend accepted or an event starting tells the hub nothing here', () => {
    const want: string[] = [];
    expect(attentionDispatch('NOTIFICATION_CENTER_ITEM_CREATE', { id: '3', type: 'friend_request_accepted', other_user: alice }, state(), newAttention(), (w) => want.push(w))).toEqual([]);
    expect(attentionDispatch('NOTIFICATION_CENTER_ITEM_CREATE', { id: '4', type: 'scheduled_guild_event_started' }, state(), newAttention(), (w) => want.push(w))).toEqual([]);
    expect(want).toEqual([]);
  });

  test('someone reacting to your message is a reaction on it, after who they are', () => {
    const ev = attentionDispatch('REACTION_NOTIFICATION_SENT', { channelId: CHAN, messageId: '9', userId: ALICE, user: alice, emoji: { id: null, name: '🎉' } }, state(), newAttention(), () => {});
    expect(ev).toEqual([expect.objectContaining({ t: 'identity' }), { t: 'reaction', conversation: CHAN, message: '9', author: ALICE, key: '🎉' }]);
  });
});

describe('message requests and spam', () => {
  const req = (over: Partial<RawDM> = {}): RawDM => ({ id: REQ_DM, type: 1, recipients: [alice], is_message_request: true, is_message_request_timestamp: '2026-11-12T08:00:00.000Z', is_spam: false, ...over });

  test('a DM held as a request is a message request about its conversation, from who sent it', () => {
    const st = state();
    const att = newAttention();
    const ev = requestChanges([req()], st, att);
    expect(ev.map((e) => e.t)).toEqual(['identity', 'request']);
    expect((ev[1] as Extract<P.AdapterEvent, { t: 'request' }>).request).toEqual({
      nativeId: `message:${REQ_DM}`,
      kind: 'message',
      from: ALICE,
      target: { kind: 'conversation', nativeId: REQ_DM },
      ts: Date.parse('2026-11-12T08:00:00.000Z'),
      answers: ['accept', 'decline', 'block'],
    });
    // Told once.
    expect(requestChanges([req()], st, att)).toEqual([]);
  });

  test('spam is marked so, with its warning', () => {
    const ev = requestChanges([req({ id: SPAM_DM, recipients: [{ id: SPAMMER, username: 'free.nitro' }], is_message_request: false, is_spam: true })], state(), newAttention());
    expect((ev.find((e) => e.t === 'request') as Extract<P.AdapterEvent, { t: 'request' }>).request).toMatchObject({ spam: true, warning: SPAM_DM_WARNING, from: SPAMMER });
  });

  test('accepted (here or in another app), or the DM closed: gone, once', () => {
    const st = state();
    const att = newAttention();
    requestChanges([req()], st, att);
    expect(attentionDispatch('CHANNEL_UPDATES', { channels: [req({ is_message_request: false })] }, st, att, () => {})).toEqual([{ t: 'requestGone', nativeId: `message:${REQ_DM}` }]);
    expect(attentionDispatch('MESSAGE_REQUEST_ACCEPT_OPTIMISTIC', { channelId: REQ_DM }, st, att, () => {})).toEqual([]);
    requestChanges([req()], st, att);
    expect(attentionDispatch('CHANNEL_DELETE', { channel: { id: REQ_DM } }, st, att, () => {})).toEqual([{ t: 'requestGone', nativeId: `message:${REQ_DM}` }]);
  });

  test('a DM from an older hook, which says nothing of its flags, changes nothing', () => {
    const st = state();
    const att = newAttention();
    requestChanges([req()], st, att);
    expect(requestChanges([{ id: REQ_DM, type: 1, recipients: [alice] }], st, att)).toEqual([]);
    expect(att.requests.size).toBe(1);
  });

  test("a snapshot is every DM: a request not in it is gone, and an ordinary DM is none", () => {
    const st = state();
    const att = newAttention();
    requestChanges([req({ id: SPAM_DM, is_spam: true })], st, att);
    const snap: RawSnapshot = { privateChannels: [req(), { id: DM, type: 1, recipients: [alice], is_message_request: false, is_spam: false } as RawDM] };
    const ev = attentionSnapshot(snap, st, att);
    expect(ev.filter((e) => e.t === 'request' || e.t === 'requestGone').map((e) => (e.t === 'request' ? e.request.nativeId : (e as { nativeId: string }).nativeId))).toEqual([`message:${REQ_DM}`, `message:${SPAM_DM}`]);
    expect([...att.requests.keys()]).toEqual([REQ_DM]);
  });

  test('the whole requests list carries them beside the friend requests', () => {
    const att = newAttention();
    requestChanges([req()], state(), att);
    const friend: P.RequestFact = { nativeId: `friend:${ALICE}`, kind: 'friend', from: ALICE, ts: 1, answers: ['accept'] };
    const out = withMessageRequests({ t: 'requests', requests: [friend] }, att) as Extract<P.AdapterEvent, { t: 'requests' }>;
    expect(out.requests.map((r) => r.nativeId)).toEqual([`friend:${ALICE}`, `message:${REQ_DM}`]);
    expect(withMessageRequests({ t: 'requestGone', nativeId: 'x' }, att)).toEqual({ t: 'requestGone', nativeId: 'x' });
  });

  test('answering: only message request ids, and an accepted one leads to its conversation', () => {
    expect(messageRequestChannel(`message:${REQ_DM}`)).toBe(REQ_DM);
    expect(messageRequestChannel(`friend:${ALICE}`)).toBeNull();
    expect(messageRequestChannel('message:not-a-snowflake')).toBeNull();
    const att = newAttention();
    requestChanges([req()], state(), att);
    expect(messageAnswerOutcome(REQ_DM, 'accept', att)).toEqual({ events: [{ t: 'requestGone', nativeId: `message:${REQ_DM}` }], result: { conversation: REQ_DM } });
  });
});

describe('notification settings as they change', () => {
  const channels: RawChannel[] = [
    { id: CAT, type: 4, name: 'Help', guild_id: GUILD },
    { id: CHAN, type: 0, name: 'beginners', guild_id: GUILD, parent_id: CAT },
  ];
  const fresh = () => {
    const st = state();
    const att = newAttention();
    attentionSnapshot({ guilds: [{ id: GUILD, name: 'Rust' }], channels, privateChannels: [], guildSettings: [{ guild_id: GUILD, channel_overrides: [] }] }, st, att);
    return { st, att };
  };

  test('a channel muted in Discord (any app): its fact again, with the mute and its end', () => {
    const { st, att } = fresh();
    const end = '2026-11-12T12:00:00.000Z';
    const ev = settingsEvents([{ guildId: GUILD, settings: { guild_id: GUILD, channel_overrides: [{ channel_id: CHAN, muted: true, mute_config: { end_time: end } }] }, channels, guild: null }], st, att);
    expect(ev).toEqual([{ t: 'conversation', conversation: expect.objectContaining({ nativeId: CHAN, mute: { level: 'none', until: Date.parse(end), muted: true } }) }]);
    // The same settings again: nothing new.
    expect(settingsEvents([{ guildId: GUILD, settings: st.guildSettings.get(GUILD)!, channels, guild: null }], st, att)).toEqual([]);
  });

  test('unmuted, or the mute ran out: an empty mute, which clears the one the hub has', () => {
    const { st, att } = fresh();
    settingsEvents([{ guildId: GUILD, settings: { guild_id: GUILD, channel_overrides: [{ channel_id: CHAN, muted: true }] }, channels, guild: null }], st, att);
    const ev = attentionDispatch('CHANNEL_MUTE_EXPIRED', { changes: [{ guildId: GUILD, settings: { guild_id: GUILD, channel_overrides: [{ channel_id: CHAN, muted: false }] }, channels, guild: null }] }, st, att, () => {});
    expect(ev).toEqual([{ t: 'conversation', conversation: expect.objectContaining({ nativeId: CHAN, mute: {} }) }]);
  });

  test('a server set to mentions only, suppressing @everyone: its space with both', () => {
    const { st, att } = fresh();
    const ev = settingsEvents([{ guildId: GUILD, settings: { guild_id: GUILD, message_notifications: 1, suppress_everyone: true, channel_overrides: [] }, channels, guild: { id: GUILD, name: 'Rust' } }], st, att);
    expect(ev).toEqual([{ t: 'space', space: expect.objectContaining({ nativeId: GUILD, name: 'Rust', mute: { level: 'mentions', suppressEveryone: true } }) }]);
  });

  test('a snapshot tells again the servers that suppress something, which its facts did not say', () => {
    const st = state();
    const ev = attentionSnapshot({ guilds: [{ id: GUILD, name: 'Rust' }], channels, guildSettings: [{ guild_id: GUILD, suppress_roles: true } as never] }, st, newAttention());
    expect(ev).toEqual([{ t: 'space', space: expect.objectContaining({ nativeId: GUILD, mute: { suppressRoles: true } }) }]);
  });

  test('a DM muted: its conversation, with the mute', () => {
    const st = state();
    const att = newAttention();
    const dm: RawChannel = { id: DM, type: 1, recipients: [alice] };
    attentionSnapshot({ privateChannels: [dm], guildSettings: [] }, st, att);
    const ev = settingsEvents([{ guildId: null, settings: { guild_id: null, channel_overrides: [{ channel_id: DM, muted: true }] }, channels: [dm], guild: null }], st, att);
    expect(ev).toEqual([{ t: 'conversation', conversation: expect.objectContaining({ nativeId: DM, shape: 'direct', mute: { level: 'none', muted: true } }) }]);
  });

  test("what the hook answered to dither's mute: the fact, and the mute as it now stands", () => {
    const { st, att } = fresh();
    const r = muteOutcome({ guildId: GUILD, settings: { guild_id: GUILD, channel_overrides: [{ channel_id: CHAN, muted: true }] }, channel: channels[1]!, guild: null }, { kind: 'conversation', nativeId: CHAN }, st, att);
    expect(r.mute).toEqual({ level: 'none', muted: true });
    expect(r.events).toHaveLength(1);
    const un = muteOutcome({ guildId: GUILD, settings: { guild_id: GUILD, channel_overrides: [] }, channel: channels[1]!, guild: null }, { kind: 'conversation', nativeId: CHAN }, st, att);
    expect(un.mute).toEqual({});
    expect(un.events).toEqual([{ t: 'conversation', conversation: expect.objectContaining({ mute: {} }) }]);
  });
});

describe('hook commands', () => {
  test('mute: Discord ids only, a timer only with a mute', () => {
    expect(muteHookCommand({ target: { kind: 'space', nativeId: GUILD }, muted: true, until: 5 })).toEqual({ kind: 'mute', target: 'space', id: GUILD, muted: true, until: 5 });
    expect(muteHookCommand({ target: { kind: 'conversation', nativeId: CHAN }, muted: false, until: 5 })).toEqual({ kind: 'mute', target: 'conversation', id: CHAN, muted: false });
    expect(() => muteHookCommand({ target: { kind: 'conversation', nativeId: 'x' }, muted: true })).toThrow('not a Discord id');
  });

  test('mark unread from a message: a manual ack of the one before it', () => {
    expect(markUnreadHookCommand(CHAN, '1000000000000000000')).toEqual({ kind: 'markUnread', channelId: CHAN, messageId: '999999999999999999' });
    expect(() => markUnreadHookCommand(CHAN, 'nope')).toThrow();
  });

  test('mark many read: Discord ids only, at most the batch', () => {
    expect(markReadManyHookCommand([{ conversation: CHAN, upTo: DM }, { conversation: 'x', upTo: DM }])).toEqual({ kind: 'markReadMany', items: [{ channelId: CHAN, messageId: DM }] });
    expect(() => markReadManyHookCommand(Array.from({ length: 3 }, () => ({ conversation: CHAN, upTo: DM })), 2)).toThrow('At most 2');
  });

  test('capabilities follow the modules found', () => {
    expect(attentionCapabilities({ RecentMentionsActions: true, NotificationSettingsActions: true, Rest: true, Dispatcher: true, ReadStateStore: true })).toEqual(['mentions', 'mute', 'markUnread', 'markReadMany']);
    expect(attentionCapabilities({ Dispatcher: true })).toEqual([]);
  });
});
