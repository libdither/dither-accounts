/**
 * 1:1 calls as a linked device hears them (src/calls.ts): an offer rings you; the caller's hangup to your other
 * devices says how it went (answered, declined or busy on another device, missed), with how long where it is known;
 * the offer's line is worded again as the call ends; nothing from anyone else touches a call.
 */
import { describe, expect, test } from 'bun:test';
import type { AdapterEvent } from '@dither-chat/protocol';
import { CallBook } from '../src/calls.ts';
import { mapReceive, type MapContext } from '../src/mapping.ts';
import type { SigEnvelope } from '../src/types.ts';

const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ANN = '5f2c7a8e-2222-4aaa-8bbb-000000000002';
const EVE = '5f2c7a8e-3333-4aaa-8bbb-000000000003';
const T0 = 1_762_000_000_000;
const DM = `dm:${SELF}:${ANN}`;

function world() {
  const calls = new CallBook();
  const ctx: MapContext = { self: SELF, signalDir: '/tmp/none', calls };
  const hear = (from: string, ts: number, callMessage: SigEnvelope['callMessage']) =>
    mapReceive({ envelope: { sourceUuid: from, sourceNumber: null, timestamp: ts, callMessage } as SigEnvelope }, ctx).events;
  return { hear, calls };
}
const states = (evs: AdapterEvent[]) => evs.filter((e) => e.t === 'callState').map((e) => (e as Extract<AdapterEvent, { t: 'callState' }>).call);
const lines = (evs: AdapterEvent[]) => evs.filter((e) => e.t === 'message').map((e) => (e as Extract<AdapterEvent, { t: 'message' }>).message.body);

describe('Signal calls', () => {
  test('an offer rings you, from its own time', () => {
    const { hear } = world();
    const evs = hear(ANN, T0, { offerMessage: { id: '77', type: 'AUDIO_CALL' } });
    expect(lines(evs)).toEqual(['📞 Incoming voice call']);
    expect(states(evs)).toEqual([{ nativeId: '77', conversation: DM, caller: ANN, startedAt: T0, state: 'ringing', ringsSelf: true, message: `${ANN}:${T0}` }]);
    // The same offer again (a resend) changes nothing.
    expect(states(hear(ANN, T0, { offerMessage: { id: '77', type: 'AUDIO_CALL' } }))).toEqual([]);
  });

  test('they hang up before anyone answers: missed, and the line says so', () => {
    const { hear } = world();
    hear(ANN, T0, { offerMessage: { id: '78', type: 'VIDEO_CALL' } });
    const evs = hear(ANN, T0 + 30_000, { hangupMessage: { id: '78', type: 'NORMAL', deviceId: 1 } });
    expect(states(evs)).toMatchObject([{ state: 'ended', outcome: 'missed', endedAt: T0 + 30_000, video: true }]);
    expect(lines(evs)).toEqual(['📞 Missed video call']);
  });

  test('answered on your phone, then over: answered elsewhere at once, and how long once they hang up', () => {
    const { hear } = world();
    hear(ANN, T0, { offerMessage: { id: '79' } });
    const accepted = hear(ANN, T0 + 5_000, { hangupMessage: { id: '79', type: 'ACCEPTED', deviceId: 1 } });
    expect(states(accepted)).toMatchObject([{ state: 'ended', outcome: 'elsewhere', answeredAt: T0 + 5_000 }]);
    expect(lines(accepted)).toEqual(['📞 Call, answered on another device']);
    const over = hear(ANN, T0 + 5_000 + 12 * 60_000, { hangupMessage: { id: '79', type: 'NORMAL', deviceId: 1 } });
    expect(states(over)).toMatchObject([{ state: 'ended', outcome: 'answered', answeredAt: T0 + 5_000, endedAt: T0 + 5_000 + 12 * 60_000 }]);
    expect(lines(over)).toEqual(['📞 Call, 12 min']);
  });

  test('answered here, through Signal Desktop: the call goes on, and ends answered with its length when Desktop leaves', () => {
    const { hear, calls } = world();
    let here = false;
    calls.inCallHere = (c) => here && c === DM;
    hear(ANN, T0, { offerMessage: { id: '90' } });
    here = true;
    const accepted = hear(ANN, T0 + 5_000, { hangupMessage: { id: '90', type: 'ACCEPTED', deviceId: 1 } });
    expect(states(accepted)).toMatchObject([{ state: 'ongoing', answeredAt: T0 + 5_000 }]);
    expect(states(accepted)[0].outcome).toBeUndefined();
    expect(lines(accepted)).toEqual([]);
    // A second ACCEPTED (a resend) changes nothing.
    expect(hear(ANN, T0 + 6_000, { hangupMessage: { id: '90', type: 'ACCEPTED', deviceId: 1 } })).toEqual([]);
    here = false;
    const over = calls.endHere(DM, T0 + 5_000 + 3 * 60_000);
    expect(states(over)).toMatchObject([{ state: 'ended', outcome: 'answered', answeredAt: T0 + 5_000, endedAt: T0 + 5_000 + 3 * 60_000 }]);
    expect(lines(over)).toEqual(['📞 Call, 3 min']);
    // Their hangup after it changes nothing, and nor does Desktop leaving again.
    expect(states(hear(ANN, T0 + 4 * 60_000, { hangupMessage: { id: '90', type: 'NORMAL', deviceId: 1 } }))).toEqual([]);
    expect(calls.endHere(DM, T0 + 5 * 60_000)).toEqual([]);
  });

  test('answered here, and they hang up first: answered, until their hangup', () => {
    const { hear, calls } = world();
    calls.inCallHere = (c) => c === DM;
    hear(ANN, T0, { offerMessage: { id: '91' } });
    hear(ANN, T0 + 2_000, { hangupMessage: { id: '91', type: 'ACCEPTED', deviceId: 1 } });
    const over = hear(ANN, T0 + 2_000 + 2 * 60_000, { hangupMessage: { id: '91', type: 'NORMAL', deviceId: 1 } });
    expect(states(over)).toMatchObject([{ state: 'ended', outcome: 'answered', endedAt: T0 + 2_000 + 2 * 60_000 }]);
    expect(lines(over)).toEqual(['📞 Call, 2 min']);
    expect(calls.endHere(DM, T0 + 3 * 60_000)).toEqual([]);
  });

  test('accepted while Desktop is in a call in another chat: still answered elsewhere', () => {
    const { hear, calls } = world();
    calls.inCallHere = (c) => c === `dm:${SELF}:${EVE}`;
    hear(ANN, T0, { offerMessage: { id: '92' } });
    expect(states(hear(ANN, T0 + 1_000, { hangupMessage: { id: '92', type: 'ACCEPTED', deviceId: 1 } }))).toMatchObject([{ state: 'ended', outcome: 'elsewhere' }]);
  });

  test('declined or busy on another device', () => {
    const { hear } = world();
    hear(ANN, T0, { offerMessage: { id: '80' } });
    hear(ANN, T0, { offerMessage: { id: '81' } });
    expect(lines(hear(ANN, T0 + 3_000, { hangupMessage: { id: '80', type: 'DECLINED', deviceId: 1 } }))).toEqual(['📞 Declined call']);
    expect(lines(hear(ANN, T0 + 3_000, { hangupMessage: { id: '81', type: 'BUSY', deviceId: 1 } }))).toEqual(['📞 Missed call (busy on another device)']);
    // Once over, a later word changes nothing.
    expect(hear(ANN, T0 + 4_000, { hangupMessage: { id: '80', type: 'BUSY', deviceId: 1 } })).toEqual([]);
  });

  test("someone else's hangup, or one for a call never heard, touches nothing", () => {
    const { hear } = world();
    hear(ANN, T0, { offerMessage: { id: '82' } });
    expect(hear(EVE, T0 + 1_000, { hangupMessage: { id: '82', type: 'DECLINED', deviceId: 1 } })).toEqual([]);
    expect(hear(ANN, T0 + 1_000, { hangupMessage: { id: '999', type: 'DECLINED', deviceId: 1 } })).toEqual([]);
    // An answer or busy for a call this device did not make (it never makes one) is nothing.
    expect(hear(ANN, T0 + 1_000, { answerMessage: { id: '82' }, busyMessage: null })).toEqual([]);
  });

  test('without a call book (an older adapter), only the offer line, as before', () => {
    const evs = mapReceive({ envelope: { sourceUuid: ANN, timestamp: T0, callMessage: { offerMessage: { id: '1' } } } as SigEnvelope }, { self: SELF, signalDir: '/tmp/none' }).events;
    expect(states(evs)).toEqual([]);
    expect(lines(evs)).toEqual(['📞 Incoming voice call']);
  });
});
