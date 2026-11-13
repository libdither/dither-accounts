/**
 * Calls from what the hook relays (src/calls.ts): one fact per call message, ringing you until it stops, going on
 * once two are in it, over when the gateway deletes it; nothing said twice; voice channels and status lines; the call
 * message worded as the call went.
 */
import { describe, expect, test } from 'bun:test';
import { callCapabilities, callEvents, callFact, callMessageText, newCallMemory, type RawCallState } from '../src/calls.ts';
import { mapMessage } from '../src/map.ts';

const SELF = '1';
// A snowflake whose time is known: (ms - Discord's epoch) << 22.
const at = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);
const MSG = at(T0);
const raw = (x: Partial<RawCallState>): RawCallState => ({ channelId: 'dm', messageId: MSG, ringing: [], voice: [], ...x });

describe('call facts', () => {
  test('ringing you, answered, over: the call keeps its own start time and who was in it', () => {
    const mem = newCallMemory();
    expect(callFact(raw({ ringing: [SELF], rungBy: { [SELF]: '2' }, voice: ['2'] }), mem, SELF, T0 + 1000)).toEqual({
      nativeId: MSG,
      conversation: 'dm',
      startedAt: T0,
      state: 'ringing',
      caller: '2',
      ringsSelf: true,
      participants: ['2'],
      message: MSG,
    });
    // A voice change that changes nothing about the call says nothing.
    expect(callFact(raw({ ringing: [SELF], rungBy: { [SELF]: '2' }, voice: ['2'] }), mem, SELF, T0 + 2000)).toBeNull();
    expect(callFact(raw({ voice: ['2', SELF] }), mem, SELF, T0 + 5000)).toMatchObject({ state: 'ongoing', participants: ['2', SELF], answeredAt: T0 + 5000 });
    // You left; Two is still there: still the same call, going on, with both of you in it.
    expect(callFact(raw({ voice: ['2'] }), mem, SELF, T0 + 60_000)).toBeNull();
    expect(callFact(raw({ deleted: true }), mem, SELF, T0 + 65_000)).toMatchObject({ state: 'ended', endedAt: T0 + 65_000, answeredAt: T0 + 5000 });
    expect(mem.size).toBe(0);
  });

  test('your own call: outgoing, ringing the others until one joins', () => {
    const mem = newCallMemory();
    expect(callFact(raw({ ringing: ['2'], rungBy: { '2': SELF }, voice: [SELF] }), mem, SELF, T0)).toMatchObject({ state: 'ringing', caller: SELF, outgoing: true });
    expect(callFact(raw({ ringing: ['2'], rungBy: { '2': SELF }, voice: [SELF] }), mem, SELF, T0)?.ringsSelf).toBeUndefined();
  });

  test('voice channels and status lines', () => {
    const mem = newCallMemory();
    expect(callEvents('VOICE_PEOPLE', { channels: [{ channelId: 'vc', guildId: 'g', members: [{ id: '5', muted: true, video: false }] }] }, mem, SELF, 7)).toEqual([
      { t: 'voice', conversation: 'vc', space: 'g', members: [{ who: '5', muted: true }], ts: 7 },
    ]);
    expect(callEvents('VOICE_STATUS', { channels: [{ channelId: 'vc', status: '' }, { channelId: 'v2', status: 'chess' }] }, mem, SELF)).toEqual([
      { t: 'voiceStatus', conversation: 'vc', text: null },
      { t: 'voiceStatus', conversation: 'v2', text: 'chess' },
    ]);
  });

  test('capabilities follow the modules the hook found', () => {
    expect(callCapabilities({ Dispatcher: true })).toEqual(['callStates']);
    expect(callCapabilities({ Dispatcher: true, VoiceStateStore: true, CallActions: true })).toEqual(['callStates', 'voicePresence', 'declineCall', 'ringCalls']);
    expect(callCapabilities({ Dispatcher: true, VoiceStateStore: true, Rest: true, LocalVolume: true, InputSettings: true, MediaEngineStore: true, SoundboardStore: true })).toEqual(['callStates', 'voicePresence', 'callVolume', 'callInput', 'stage', 'soundboard']);
    // The volume slider's module without the store that says each person's volume: not offered.
    expect(callCapabilities({ LocalVolume: true, InputSettings: true })).toEqual([]);
  });
});

describe('the call message (type 3)', () => {
  const msg = (author: string, call?: { participants: string[]; ended_timestamp: string | null }) =>
    ({ id: MSG, channel_id: 'dm', author: { id: author, username: `u${author}` }, content: '', timestamp: new Date(T0).toISOString(), type: 3, ...(call ? { call } : {}) }) as any;
  const ended = (min: number) => new Date(T0 + min * 60_000).toISOString();

  test('worded as the call went', () => {
    expect(callMessageText(msg('2', { participants: ['2'], ended_timestamp: ended(1) }), SELF, 'Two')).toBe('📞 Missed call');
    expect(callMessageText(msg('2', { participants: ['2', SELF], ended_timestamp: ended(12) }), SELF, 'Two')).toBe('📞 Call, 12 min');
    expect(callMessageText(msg(SELF, { participants: [SELF], ended_timestamp: ended(1) }), SELF, 'Me')).toBe('📞 Call, no answer');
    expect(callMessageText(msg('2', { participants: ['2', SELF, '3'], ended_timestamp: ended(65) }), SELF, 'Two')).toBe('📞 Call, 1 h 5 min with <@3>');
    expect(callMessageText(msg('2', { participants: ['2'], ended_timestamp: null }), SELF, 'Two')).toBe('📞 Call going on');
    // An older hook, without the call object: as before.
    expect(callMessageText(msg('2'), SELF, 'Two')).toBe('Two started a call.');
  });

  test('a call message is of kind call', () => {
    expect(mapMessage(msg('2', { participants: ['2'], ended_timestamp: ended(1) }), SELF)).toMatchObject({ kind: 'call', body: '📞 Missed call' });
  });
});
