/**
 * Calls and voice channels, from what the hook relays (extension/hook.js "calls ringing, voice channels"):
 *
 * - CALL_STATE: a DM or group DM call as the client has it: who it rings (and who rang them), who is in it, or that it
 *   is over. Turned into `callState` facts, one call per call message (its id is the call's).
 * - VOICE_PEOPLE: who is in a guild voice channel now, after it changed: `voice` events (the hub keeps them only with
 *   the adversarial voice setting on).
 * - VOICE_STATUS: a voice channel's status line: `voiceStatus` events.
 * - a call message (type 3) worded as the call went, with protocol's callLine: "📞 Missed call", "📞 Call, 12 min".
 */
import type * as P from '@dither-chat/protocol';
import { callLine } from '@dither-chat/protocol';
import type { RawMessage } from './discord-types.ts';
import { isoToMs, snowflakeToMs } from './map.ts';

export const CALL_EVENTS = new Set(['CALL_STATE', 'VOICE_PEOPLE', 'VOICE_STATUS']);

export interface RawCallState {
  channelId: string;
  messageId: string | null;
  /** Who it rings now. */
  ringing: string[];
  /** Who rang each of them, where the gateway says. */
  rungBy?: Record<string, string | null>;
  /** Who is in it now. */
  voice: string[];
  video?: boolean;
  deleted?: boolean;
}

interface Mem {
  nativeId: string;
  startedAt: number;
  caller?: string;
  participants: Set<string>;
  answeredAt?: number;
  state: P.CallFact['state'];
  last: string;
}

/** What the adapter remembers of calls going on, by channel. */
export type CallMemory = Map<string, Mem>;
export const newCallMemory = (): CallMemory => new Map();

/** One CALL_STATE: the call's fact, or nothing when nothing about it changed. */
export function callFact(raw: RawCallState, mem: CallMemory, selfId: string, now = Date.now()): P.CallFact | null {
  if (!raw?.channelId) return null;
  const prev = mem.get(raw.channelId);
  const nativeId = raw.messageId ?? prev?.nativeId ?? `call:${raw.channelId}`;
  // A new call message in the same channel is a new call.
  const m: Mem = prev && prev.nativeId === nativeId ? prev : { nativeId, startedAt: raw.messageId ? snowflakeToMs(raw.messageId) : now, participants: new Set(), state: 'ringing', last: '' };
  const ringing = (raw.ringing ?? []).filter((x) => typeof x === 'string');
  const voice = [...new Set((raw.voice ?? []).filter((x) => typeof x === 'string'))];
  for (const v of voice) m.participants.add(v);
  const rungBy = raw.rungBy ?? {};
  m.caller ??= rungBy[selfId] ?? Object.values(rungBy).find((x): x is string => typeof x === 'string') ?? (voice.length === 1 ? voice[0] : undefined);
  const outgoing = m.caller === selfId;
  let state: P.CallFact['state'];
  if (raw.deleted) state = 'ended';
  else if (voice.length >= 2) state = 'ongoing';
  else if (ringing.length) state = m.state === 'ongoing' ? 'ongoing' : 'ringing';
  else state = voice.length ? 'ongoing' : m.state;
  if (state === 'ongoing' && voice.length >= 2) m.answeredAt ??= now;
  m.state = state;
  const fact: P.CallFact = {
    nativeId,
    conversation: raw.channelId,
    startedAt: m.startedAt,
    state,
    ...(m.caller ? { caller: m.caller } : {}),
    ...(state !== 'ended' && ringing.includes(selfId) ? { ringsSelf: true } : {}),
    ...(outgoing ? { outgoing: true } : {}),
    ...(raw.video ? { video: true } : {}),
    participants: [...m.participants],
    ...(m.answeredAt ? { answeredAt: m.answeredAt } : {}),
    ...(raw.messageId ? { message: raw.messageId } : {}),
  };
  if (state === 'ended') {
    fact.endedAt = now;
    mem.delete(raw.channelId);
    return fact;
  }
  mem.set(raw.channelId, m);
  // The same again (a voice change that did not change the call): nothing to say.
  const key = JSON.stringify({ ...fact, participants: [...m.participants].sort() });
  if (key === m.last) return null;
  m.last = key;
  return fact;
}

/** The adapter events for one of CALL_EVENTS. */
export function callEvents(event: string, data: any, mem: CallMemory, selfId: string, now = Date.now()): P.AdapterEvent[] {
  if (event === 'CALL_STATE') {
    const f = callFact(data, mem, selfId, now);
    return f ? [{ t: 'callState', call: f }] : [];
  }
  if (event === 'VOICE_PEOPLE') {
    return (Array.isArray(data?.channels) ? data.channels : [])
      .filter((c: any) => typeof c?.channelId === 'string')
      .map((c: any): P.AdapterEvent => ({
        t: 'voice',
        conversation: c.channelId,
        ...(c.guildId ? { space: c.guildId } : {}),
        members: (Array.isArray(c.members) ? c.members : [])
          .filter((x: any) => typeof x?.id === 'string')
          .map((x: any): P.VoiceMember => ({ who: x.id, ...(x.muted ? { muted: true } : {}), ...(x.deafened ? { deafened: true } : {}), ...(x.video ? { video: true } : {}), ...(x.streaming ? { streaming: true } : {}) })),
        ts: now,
      }));
  }
  if (event === 'VOICE_STATUS') {
    return (Array.isArray(data?.channels) ? data.channels : [])
      .filter((c: any) => typeof c?.channelId === 'string')
      .map((c: any): P.AdapterEvent => ({ t: 'voiceStatus', conversation: c.channelId, text: typeof c.status === 'string' && c.status.trim() ? c.status : null }));
  }
  return [];
}

/**
 * A call message (type 3) as its line: missed, how long, who else was in it. Without the call object (an older hook,
 * or a message the client had not filled in) it says who started it, as before.
 */
export function callMessageText(m: RawMessage, selfId: string | undefined, who: string): string {
  const c = m.call;
  if (!c || !selfId) return `${who} started a call.`;
  const startedAt = isoToMs(m.timestamp) || snowflakeToMs(m.id);
  const endedAt = c.ended_timestamp ? isoToMs(c.ended_timestamp) : undefined;
  const outgoing = m.author?.id === selfId;
  const others = c.participants.filter((p) => p !== selfId && p !== m.author?.id);
  const outcome: P.CallOutcome | undefined = !endedAt
    ? undefined
    : outgoing
      ? c.participants.some((p) => p !== selfId)
        ? 'answered'
        : 'cancelled'
      : c.participants.includes(selfId)
        ? 'answered'
        : 'missed';
  // Discord's call message says how long the call lasted, not how long you were in it.
  return callLine({ state: endedAt ? 'ended' : 'ongoing', outcome, outgoing, startedAt, endedAt }, others.map((p) => `<@${p}>`));
}

/**
 * What the account can do with calls beyond joining them, by the client modules the hook found: callStates once the
 * dispatcher is there, voicePresence with the voice state store, declineCall and ringCalls with the call module, and
 * what a call it is in offers: callVolume, callInput, stage and soundboard.
 */
export function callCapabilities(finders: Record<string, boolean>): P.Capability[] {
  const out: P.Capability[] = [];
  if (finders.Dispatcher) out.push('callStates');
  if (finders.Dispatcher && finders.VoiceStateStore) out.push('voicePresence');
  if (finders.CallActions) out.push('declineCall', 'ringCalls');
  // In a call (hook.js "in a call"): the user menu's volume and Mute, the voice settings, stages and the soundboard.
  if (finders.LocalVolume && finders.MediaEngineStore) out.push('callVolume');
  if (finders.InputSettings && finders.MediaEngineStore) out.push('callInput');
  if (finders.Rest && finders.VoiceStateStore) out.push('stage');
  if (finders.Rest && finders.SoundboardStore) out.push('soundboard');
  return out;
}
