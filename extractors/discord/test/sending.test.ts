/**
 * The adapter's side of sending extras (src/sending.ts): which capabilities the modules found allow, the hook's saved
 * messages and reminders as protocol facts, the commands' hook shapes, and Discord's scheduled messages read back.
 */
import { describe, expect, test } from 'bun:test';
import { newState } from '../src/ingest.ts';
import { nativeScheduledOutcome, savedFact, savedListOutcome, sendingCapabilities, sendingDispatch, sendingHookCommand, sendOptions } from '../src/sending.ts';

const CHAN = '300000000000000200';
const MSG = '500000000000000050';
const raw = (due?: string) => ({
  channel_id: CHAN,
  message_id: MSG,
  saved_at: '2026-11-11T10:00:00.000Z',
  due_at: due ?? null,
  author_summary: 'ann',
  message: { id: MSG, channel_id: CHAN, content: 'saved text', author: { id: '400000000000000001', username: 'ann' }, timestamp: '2026-11-10T10:00:00.000Z', type: 0 } as any,
});

describe('sending extras, adapter side', () => {
  test('capabilities follow the modules found', () => {
    expect(sendingCapabilities({})).toEqual([]);
    expect(sendingCapabilities({ MessageActions: true })).toEqual(['silentSend', 'replyMention', 'suppressEmbeds']);
    expect(sendingCapabilities({ MessageActions: true, Rest: true, SavedMessagesStore: true, SavedMessageActions: true, ScheduledMessageActions: true, ScheduledMessageGate: true })).toEqual([
      'silentSend',
      'replyMention',
      'suppressEmbeds',
      'savedMessages',
      'nativeScheduled',
    ]);
    // Without its gate, Discord's own scheduled messages are never asked for.
    expect(sendingCapabilities({ Rest: true, ScheduledMessageActions: true })).not.toContain('nativeScheduled');
  });

  test("send options as the client's: flags for silent, replied_user false only on a reply", () => {
    expect(sendOptions({})).toEqual({});
    expect(sendOptions({ silent: true })).toEqual({ flags: 4096 });
    expect(sendOptions({ mentionReplied: false })).toEqual({});
    expect(sendOptions({ replyTo: MSG, mentionReplied: false })).toEqual({ allowedMentions: { parse: ['users', 'roles', 'everyone'], replied_user: false } });
    expect(sendOptions({ replyTo: MSG, mentionReplied: true })).toEqual({});
  });

  test('a saved message, with and without its reminder and summary', () => {
    expect(savedFact(raw('2026-11-13T09:00:00.000Z'))).toEqual({ conversation: CHAN, message: MSG, savedAt: Date.parse('2026-11-11T10:00:00.000Z'), dueAt: Date.parse('2026-11-13T09:00:00.000Z'), summary: { author: 'ann' } });
    expect(savedFact({ ...raw(), author_summary: null })).toEqual({ conversation: CHAN, message: MSG, savedAt: Date.parse('2026-11-11T10:00:00.000Z') });
    expect(savedFact(null)).toBeNull();
    expect(savedFact({ channel_id: CHAN } as any)).toBeNull();
  });

  test('what the hook forwards: messages first, then saved, unsaved and due', () => {
    const st = newState();
    const up = sendingDispatch('SAVED_MESSAGES_UPDATE', { saved: [raw('2026-11-13T09:00:00.000Z')] }, st);
    expect(up.map((e) => e.t)).toContain('message');
    expect(up.at(-1)).toMatchObject({ t: 'saved', saved: [{ message: MSG, dueAt: Date.parse('2026-11-13T09:00:00.000Z') }] });
    expect((up.at(-1) as any).complete).toBeUndefined();
    expect(sendingDispatch('SAVED_MESSAGE_DELETE', { channel_id: CHAN, message_id: MSG }, st)).toEqual([{ t: 'unsaved', message: MSG, conversation: CHAN }]);
    expect(sendingDispatch('MESSAGE_REMINDER_DUE', { saved: raw('2026-11-13T09:00:00.000Z') }, st).at(-1)).toMatchObject({ t: 'reminderDue', saved: { message: MSG } });
    expect(sendingDispatch('MESSAGE_REMINDER_DUE', {}, st)).toEqual([]);
  });

  test('commands in the hook terms', () => {
    expect(sendingHookCommand({ t: 'save', id: 'x', conversation: CHAN, message: MSG, dueAt: Date.parse('2026-11-13T09:00:00.000Z') })).toEqual({ kind: 'save', channelId: CHAN, messageId: MSG, dueAt: '2026-11-13T09:00:00.000Z' });
    expect(sendingHookCommand({ t: 'save', id: 'x', conversation: CHAN, message: MSG, remove: true })).toEqual({ kind: 'save', channelId: CHAN, messageId: MSG, remove: true });
    expect(sendingHookCommand({ t: 'savedList', id: 'x', before: 5 })).toEqual({ kind: 'savedList', more: true });
    expect(sendingHookCommand({ t: 'suppressEmbeds', id: 'x', conversation: CHAN, message: MSG })).toEqual({ kind: 'suppressEmbeds', channelId: CHAN, messageId: MSG });
    expect(() => sendingHookCommand({ t: 'cancelScheduled', id: 'x', nativeId: '../x' })).toThrow();
  });

  test('the Saved list newest first, with more when its store says so', () => {
    const st = newState();
    const older = { ...raw(), message_id: '500000000000000040', saved_at: '2026-11-01T10:00:00.000Z', message: null };
    const { events, result } = savedListOutcome({ saved: [older, raw()], more: true }, st);
    expect(result.saved.map((s) => s.message)).toEqual([MSG, '500000000000000040']);
    expect(result.more).toBe(true);
    expect(events.filter((e) => e.t === 'message').length).toBe(1);
  });

  test("Discord's scheduled messages, or none when its gate is off", () => {
    expect(nativeScheduledOutcome({ enabled: false, scheduled: [{ id: '1', channel_id: CHAN, scheduled_timestamp: '2026-11-20T09:00:00.000Z' }] })).toEqual({ enabled: false, scheduled: [] });
    expect(
      nativeScheduledOutcome({
        enabled: true,
        scheduled: [
          { id: '2', channel_id: CHAN, content: 'b', scheduled_timestamp: '2026-11-21T09:00:00.000Z' },
          { id: '1', channel_id: CHAN, content: 'a', scheduled_timestamp: '2026-11-20T09:00:00.000Z', flags: 4096, message_reference: { message_id: MSG } },
          { id: '3', channel_id: CHAN, scheduled_timestamp: 'nonsense' },
        ],
      }),
    ).toEqual({
      enabled: true,
      scheduled: [
        { nativeId: '1', conversation: CHAN, body: 'a', dueAt: Date.parse('2026-11-20T09:00:00.000Z'), silent: true, replyTo: MSG },
        { nativeId: '2', conversation: CHAN, body: 'b', dueAt: Date.parse('2026-11-21T09:00:00.000Z') },
      ],
    });
  });
});
