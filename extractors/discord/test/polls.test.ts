/**
 * Polls and pins in the adapter (src/polls.ts): a poll as structured data on its message, votes heard as reactions
 * of the vote kind (counts whole when the client had the poll, else one answer moved; your own echo not counted
 * twice; never a reaction), a poll's result message closing it, and the commands with a fake bridge: voting, ending,
 * making one, pinning, and a channel's pinned list kept a minute.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { newState, translateDispatch } from '../src/ingest.ts';
import { mapMessage } from '../src/map.ts';
import { pollCapabilities, pollFact, PollOps } from '../src/polls.ts';
import type { RawMessage, RawPoll } from '../src/discord-types.ts';

const ME = '100000000000000001';
const ALICE = '400000000000000001';
const CHAN = '300000000000000200';
const MSG = '500000000000000009';

const POLL: RawPoll = {
  question: 'Lunch?',
  answers: [{ id: '1', text: 'Pizza' }, { id: '2', text: 'Tacos', emoji: { id: '77', name: 'taco', animated: false } }],
  expiry: '2026-11-13T10:00:00.000Z',
  allow_multiselect: false,
  finalized: false,
  counts: { '1': 3, '2': 1 },
  mine: ['2'],
};
const msg = (over: Partial<RawMessage> = {}): RawMessage => ({ id: MSG, channel_id: CHAN, author: { id: ALICE, username: 'alice' }, content: '', timestamp: '2026-11-12T10:00:00.000Z', type: 0, ...over }) as RawMessage;
const state = () => Object.assign(newState(), { selfId: ME });

describe('a poll on its message', () => {
  test('structured, with its words in the body for search and previews', () => {
    const m = mapMessage(msg({ poll: POLL }), ME);
    expect(m.body).toBe('**Lunch?**\n- Pizza\n- Tacos');
    expect(m.extra?.poll).toEqual({
      question: 'Lunch?',
      options: [{ id: '1', text: 'Pizza' }, { id: '2', text: 'Tacos', emoji: '<:taco:77>' }],
      expires: Date.parse('2026-11-13T10:00:00.000Z'),
      counts: { '1': 3, '2': 1 },
      mine: ['2'],
    } satisfies P.PollFact);
  });

  test("an older hook's words alone are numbered from 1, as Discord numbers answers", () => {
    expect(pollFact({ question: 'Q', answers: ['a', 'b'] })?.options).toEqual([{ id: '1', text: 'a' }, { id: '2', text: 'b' }]);
    expect(pollFact({ question: 'Q', answers: [] })).toBeUndefined();
  });

  test("a poll's result message closes the poll it points at", () => {
    const st = state();
    const evs = translateDispatch('MESSAGE_CREATE', { message: msg({ id: '9', type: 46, message_reference: { message_id: MSG, channel_id: CHAN } }) }, st);
    expect(evs.filter((e) => e.t === 'pollUpdate')).toEqual([{ t: 'pollUpdate', conversation: CHAN, message: MSG, ended: true }]);
  });
});

describe('votes as they come', () => {
  test('with the poll as the client counts it: the counts whole; never a reaction', () => {
    const evs = translateDispatch('MESSAGE_REACTION_ADD', { channelId: CHAN, messageId: MSG, userId: ALICE, emoji: { id: '1', name: '' }, reactionType: 2, poll: POLL }, state());
    expect(evs).toEqual([{ t: 'pollUpdate', conversation: CHAN, message: MSG, counts: { '1': 3, '2': 1 }, mine: ['2'] }]);
  });

  test("without it, that one answer moved by one; your own echo is not counted again", () => {
    const st = state();
    expect(translateDispatch('MESSAGE_REACTION_REMOVE', { channelId: CHAN, messageId: MSG, userId: ALICE, emoji: { id: '2', name: '' }, reactionType: 2, poll: null }, st)).toEqual([
      { t: 'pollUpdate', conversation: CHAN, message: MSG, add: { '2': -1 } },
    ]);
    expect(translateDispatch('MESSAGE_REACTION_ADD', { channelId: CHAN, messageId: MSG, userId: ME, emoji: { id: '2', name: '' }, reactionType: 2 }, st)).toEqual([]);
  });

  test('many at once: votes by answer, the reactions beside them as reactions', () => {
    const evs = translateDispatch(
      'MESSAGE_REACTION_ADD_MANY',
      {
        channelId: CHAN,
        messageId: MSG,
        reactions: [
          { emoji: { id: '1', name: '' }, reactionType: 2, users: [{ id: ALICE }, { id: ME }, '400000000000000002'] },
          { emoji: { id: null, name: '👍' }, reactionType: 0, users: [{ id: ALICE, username: 'alice' }] },
        ],
      },
      state(),
    );
    expect(evs.filter((e) => e.t === 'pollUpdate')).toEqual([{ t: 'pollUpdate', conversation: CHAN, message: MSG, add: { '1': 2 } }]);
    expect(evs.filter((e) => e.t === 'reaction')).toEqual([expect.objectContaining({ author: ALICE, key: '👍' })]);
  });
});

describe('the commands', () => {
  const ops = (caps: P.Capability[] = pollCapabilities({ Rest: true, MessageActions: true, PollActions: true })) => {
    const sent: any[] = [];
    const emitted: P.AdapterEvent[] = [];
    const told: string[] = [];
    let pinsAsked = 0;
    const o = new PollOps({
      bridge: {
        request: async <T,>(cmd: any): Promise<T> => {
          sent.push(cmd);
          if (cmd.kind === 'pinnedList') {
            pinsAsked++;
            return { pins: [{ pinned_at: '2026-11-11T09:00:00.000Z', message: msg({ id: '7', content: 'read this' }) }], more: false } as T;
          }
          if (cmd.kind === 'pollCreate') return { nativeId: '801' } as T;
          return {} as T;
        },
      },
      pace: { run: (_l, fn) => fn() },
      lookPace: { run: (_l, fn) => fn() },
      emit: (ev) => emitted.push(ev),
      messages: (raw) => told.push(...raw.map((m) => m.id)),
      selfId: () => ME,
      caps: () => caps,
      nonce: () => 'n1',
    });
    return { o, sent, emitted, told, pins: () => pinsAsked };
  };

  test('a vote goes to the hook, and your vote is said for the hub to count', async () => {
    const t = ops();
    await t.o.vote({ t: 'pollVote', id: '1', conversation: CHAN, message: MSG, options: ['1'] });
    expect(t.sent).toEqual([{ kind: 'pollVote', channelId: CHAN, messageId: MSG, answerIds: ['1'] }]);
    expect(t.emitted).toEqual([{ t: 'pollUpdate', conversation: CHAN, message: MSG, mine: ['1'] }]);
  });

  test('ending, and making one with the default duration; a draft Discord would refuse is refused first', async () => {
    const t = ops();
    await t.o.end({ t: 'pollEnd', id: '1', conversation: CHAN, message: MSG });
    expect(t.emitted.at(-1)).toEqual({ t: 'pollUpdate', conversation: CHAN, message: MSG, ended: true });
    expect(await t.o.create({ t: 'pollCreate', id: '2', conversation: CHAN, poll: { question: ' Lunch? ', options: ['Pizza', 'Tacos '], multi: false } })).toEqual({ nativeId: '801' });
    expect(t.sent.at(-1)).toEqual({ kind: 'pollCreate', channelId: CHAN, question: 'Lunch?', answers: ['Pizza', 'Tacos'], multi: false, hours: 24, nonce: 'n1' });
    await expect(t.o.create({ t: 'pollCreate', id: '3', conversation: CHAN, poll: { question: 'Q', options: ['a', 'b'], multi: false, hours: 5 } })).rejects.toThrow('durations');
  });

  test('pinning: refused without the permission, else the request and the pin said', async () => {
    const t = ops();
    const target = { kind: 'conversation' as const, nativeId: CHAN };
    await expect(t.o.pin(target, { key: 'pin', message: '7' }, { messages: [], canEdit: false, reason: 'You need the Pin Messages permission here' })).rejects.toThrow('Pin Messages');
    await expect(t.o.pin(target, { key: 'pin', message: '7', seconds: 3600 }, { messages: [], canEdit: true })).rejects.toThrow('no timer');
    await t.o.pin(target, { key: 'pin', message: '7' }, { messages: [], canEdit: true });
    expect(t.sent.at(-1)).toEqual({ kind: 'pin', channelId: CHAN, messageId: '7', remove: false });
    expect(t.emitted.at(-1)).toMatchObject({ t: 'pin', conversation: CHAN, message: '7', pinned: true, by: ME });
  });

  test('the pinned list: the messages told, a pin each at its time, whole, and not asked again within a minute', async () => {
    const t = ops();
    const p = await t.o.pinned(CHAN, true);
    expect(p).toEqual({ messages: ['7'], canEdit: true, complete: true });
    expect(t.told).toEqual(['7']);
    expect(t.emitted).toEqual([{ t: 'pin', conversation: CHAN, message: '7', pinned: true, ts: Date.parse('2026-11-11T09:00:00.000Z') }]);
    await t.o.pinned(CHAN, true);
    expect(t.pins()).toBe(1);
    expect(await ops(['polls']).o.pinned(CHAN, true)).toBeNull();
  });
});
