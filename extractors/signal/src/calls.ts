/**
 * 1:1 calls as a linked device hears them (dither-chat docs/calls.md "Ringing"). signal-cli puts each call message
 * in the envelope (`callMessage`); nothing here asks it for anything.
 *
 * - offerMessage from someone: their call rings you (the offer's own line in the timeline is mapping.ts's).
 * - hangupMessage, from the caller to your other devices, says how it went for you: ACCEPTED (answered on another
 *   device), DECLINED, BUSY (busy on another device), NEED_PERMISSION (you had not accepted their message request),
 *   NORMAL (they hung up: missed if nobody answered, else the call is over, and how long it lasted is known).
 * - busyMessage and answerMessage answer an offer this device made, which it never does (signal-cli would need its
 *   media tunnel): they are mapped only for a call it knows to be outgoing.
 *
 * Not used: signal-cli's subscribeCallEvents and rejectCall. signal-cli 0.14.8 tracks a call only while some client is
 * subscribed to call events, and a subscribed signal-cli answers every incoming offer by spawning its media tunnel
 * (signal-call-tunnel), which the nix build does not ship: the spawn fails and signal-cli hangs up on the caller
 * (CallManager.endCall 'tunnel_spawn_error' sends a NORMAL hangup). Subscribing would end every call on your phone.
 */
import type { AdapterEvent, CallFact, CallOutcome, MessageFact } from '@dither-chat/protocol';
import { callLine } from '@dither-chat/protocol';
import type { SigEnvelope } from './types.ts';

interface Call {
  conversation: string;
  caller: string;
  startedAt: number;
  video: boolean;
  outgoing: boolean;
  message: MessageFact;
  answeredAt?: number;
  outcome?: CallOutcome;
  endedAt?: number;
}

/** Calls heard, by call id: the newest 50. */
export class CallBook {
  private calls = new Map<string, Call>();
  get(id: string) {
    return this.calls.get(id);
  }
  set(id: string, c: Call) {
    this.calls.delete(id);
    this.calls.set(id, c);
    if (this.calls.size > 50) this.calls.delete(this.calls.keys().next().value!);
  }
}

const HANGUP: Record<string, CallOutcome> = { ACCEPTED: 'elsewhere', DECLINED: 'declined', BUSY: 'busy', NEED_PERMISSION: 'missed' };

function fact(id: string, c: Call, state: CallFact['state']): CallFact {
  return {
    nativeId: id,
    conversation: c.conversation,
    caller: c.caller,
    startedAt: c.startedAt,
    state,
    ...(state === 'ringing' && !c.outgoing ? { ringsSelf: true } : {}),
    ...(c.outgoing ? { outgoing: true } : {}),
    ...(c.video ? { video: true } : {}),
    ...(c.answeredAt !== undefined ? { answeredAt: c.answeredAt } : {}),
    ...(c.outcome ? { outcome: c.outcome } : {}),
    ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
    message: c.message.nativeId,
  };
}

/** The call over: its fact, and its line worded as it went (a call line is never an edit). */
function ended(id: string, c: Call): AdapterEvent[] {
  const line = callLine({ state: 'ended', outcome: c.outcome, video: c.video, outgoing: c.outgoing, startedAt: c.startedAt, answeredAt: c.answeredAt, endedAt: c.endedAt });
  return [
    { t: 'callState', call: fact(id, c, 'ended') },
    { t: 'message', message: { ...c.message, body: line }, live: true },
  ];
}

/**
 * The events one envelope's call message means. `offer`: the message mapping.ts made of an offer, when it made one.
 */
export function callEvents(env: SigEnvelope, source: string, self: string, book: CallBook, offer: MessageFact | undefined): AdapterEvent[] {
  const cm = env.callMessage;
  if (!cm) return [];
  if (cm.offerMessage && offer) {
    const id = String(cm.offerMessage.id);
    if (book.get(id)) return [];
    const c: Call = { conversation: offer.conversation, caller: source, startedAt: env.timestamp, video: cm.offerMessage.type === 'VIDEO_CALL', outgoing: false, message: offer };
    book.set(id, c);
    return [{ t: 'callState', call: fact(id, c, 'ringing') }];
  }
  const h = cm.hangupMessage;
  if (h && h.id !== undefined && h.id !== null) {
    const id = String(h.id);
    const c = book.get(id);
    // Only from the caller, or from your own devices.
    if (!c || (source !== c.caller && source !== self)) return [];
    const type = String(h.type ?? 'NORMAL').toUpperCase();
    if (type === 'NORMAL') {
      // They hung up: over. Answered on your phone before, it lasted until now; else it was missed.
      if (c.outcome && c.outcome !== 'elsewhere' && c.endedAt !== undefined) return [];
      c.outcome = c.answeredAt !== undefined ? 'answered' : c.outgoing ? 'cancelled' : 'missed';
      c.endedAt = env.timestamp;
      return ended(id, c);
    }
    const outcome = HANGUP[type];
    if (!outcome || c.outcome) return [];
    c.outcome = outcome;
    if (outcome === 'elsewhere') c.answeredAt = env.timestamp;
    else c.endedAt = env.timestamp;
    return ended(id, c);
  }
  const answer = cm.answerMessage as { id?: number | string } | undefined | null;
  if (answer && answer.id !== undefined) {
    const c = book.get(String(answer.id));
    if (!c?.outgoing || c.answeredAt !== undefined) return [];
    c.answeredAt = env.timestamp;
    return [{ t: 'callState', call: fact(String(answer.id), c, 'ongoing') }];
  }
  const busy = cm.busyMessage as { id?: number | string } | undefined | null;
  if (busy && busy.id !== undefined) {
    const c = book.get(String(busy.id));
    if (!c?.outgoing || c.outcome) return [];
    c.outcome = 'cancelled';
    c.endedAt = env.timestamp;
    return ended(String(busy.id), c);
  }
  return [];
}
