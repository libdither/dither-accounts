/**
 * Voice calls. Two ways to carry one, so they can be compared:
 *
 * - bridge: the account's own client (Discord's, in its sandbox) joins the call and handles its
 *   media and encryption. Its audio is forwarded to the device over WebRTC, and the device's
 *   microphone is handed back to it as the microphone.
 * - direct: the sandbox only asks the network for a voice server and hands the device a token
 *   scoped to that one call. The device speaks the voice protocol itself; the hub forwards its
 *   socket and relays its media (TURN), so the network still sees the hub's address.
 */

export type CallMode = 'bridge' | 'direct';

/** Everything a direct-mode device needs to reach the voice server. The account's own login token never leaves the sandbox. */
export interface DirectVoiceSession {
  network: 'discord';
  /** host[:port] of the voice server, from the network. */
  endpoint: string;
  /** A token for this one voice connection. */
  token: string;
  /** Guild id, or the channel id for a direct or group call. */
  serverId: string;
  channelId: string;
  userId: string;
  sessionId: string;
}

export interface CallParticipant {
  /** Native user id. */
  id: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  /** Camera on. */
  video?: boolean;
  /** Sharing their screen (Go Live). */
  streaming?: boolean;
  /** Muted or deafened by a moderator (a server mute), rather than by themselves. */
  serverMuted?: boolean;
  serverDeafened?: boolean;
  /** How loud they are for this account only, percent: 100 as they are, 0 to VOLUME_MAX (the network's per-person volume). Absent: 100. */
  volume?: number;
  /** Muted for this account only. */
  localMute?: boolean;
  /** On a stage: what they are there (StageRole). Absent outside a stage. */
  stage?: StageRole;
}

/**
 * On a stage channel: speaking; listening; listening with a hand up (asking to speak); or invited to speak by a
 * moderator and not yet answered.
 */
export type StageRole = 'speaker' | 'audience' | 'hand' | 'invited';

/** A stage call's own facts (CallState.stage). */
export interface CallStage {
  /** What the stage is about, when someone started it with a topic. */
  topic: string | null;
  /** This account may invite people to speak and move speakers back to the audience (Discord: Mute Members there). */
  moderator: boolean;
}

export interface CallState {
  conversation: string;
  participants: CallParticipant[];
  /** Present when the call is a stage. */
  stage?: CallStage;
}

/** A person's volume goes up to twice as loud, as Discord's own slider does. */
export const VOLUME_MAX = 200;

/**
 * How this device's microphone is handled (Settings → Calls, kept per device). In bridge mode the account's client is
 * what sends, so it gets the same choices for its own processing; in direct mode the device applies them itself.
 */
export interface CallInput {
  /** The browser's noise suppression on the microphone (and the account client's own, in bridge mode). */
  noiseSuppression: boolean;
  /** When the microphone counts as speaking: 'auto' (the network's or the device's own judgement), or a level in dB from -100 (everything) to 0. */
  sensitivity: 'auto' | number;
}

export const CALL_INPUT_DEFAULT: CallInput = { noiseSuppression: true, sensitivity: 'auto' };

/** A CallInput as it may go to the account: anything out of range becomes the default. */
export function callInput(x: unknown): CallInput {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const s = o.sensitivity;
  return {
    noiseSuppression: typeof o.noiseSuppression === 'boolean' ? o.noiseSuppression : CALL_INPUT_DEFAULT.noiseSuppression,
    sensitivity: typeof s === 'number' && Number.isFinite(s) && s >= -100 && s <= 0 ? Math.round(s) : 'auto',
  };
}

/**
 * What a stage asks of you or a moderator: put your own hand up or down; speak (taking a moderator's invitation, or
 * as a moderator yourself); go back to listening; and, as a moderator, invite `user` to speak or move them to the
 * audience.
 */
export type StageAction = 'raiseHand' | 'lowerHand' | 'speak' | 'listen' | 'invite' | 'audience';
export const STAGE_ACTIONS: readonly StageAction[] = ['raiseHand', 'lowerHand', 'speak', 'listen', 'invite', 'audience'];

/** A sound someone played or an emoji they sent in the call you are in (Discord's soundboard and voice effects). */
export interface CallEffect {
  /** Who: a native user id from the adapter, a hub identity id from the hub. */
  who: string;
  /** A Unicode emoji, or a custom emoji's name. */
  emoji?: string;
  /** A custom emoji's picture. */
  emojiUrl?: string;
  sound?: { id: string; name: string };
}

/** A soundboard sound this account may play in the call (the `sounds` call op). */
export interface CallSound {
  id: string;
  name: string;
  /** The server it belongs to; '0' for the network's own defaults. */
  guild: string;
  emoji?: string;
  emojiUrl?: string;
}

/** Device -> hub, on /api/call. One socket is one call; closing it leaves. */
export type CallClientMessage =
  /** `ring`: in a direct or group conversation, ring the others (the account's adapter has 'ringCalls'). */
  | { op: 'join'; account: string; conversation: string; mode: CallMode; muted?: boolean; deafened?: boolean; ring?: boolean; input?: CallInput }
  | { op: 'leave' }
  | { op: 'mute'; muted: boolean; deafened: boolean }
  /** One person's volume or mute, for this account only (capability 'callVolume'). `user`: a hub identity id. */
  | { op: 'local'; user: string; volume?: number; muted?: boolean }
  /** The microphone's handling changed (capability 'callInput'). */
  | { op: 'input'; input: CallInput }
  /** A stage action (capability 'stage'); `user` (a hub identity id) for a moderator's invite or move to the audience. */
  | { op: 'stage'; action: StageAction; user?: string }
  /** The sounds this account may play here (capability 'soundboard'): answered with `sounds`. */
  | { op: 'sounds' }
  /** Play one of them. */
  | { op: 'sound'; sound: string; guild: string }
  /** Bridge mode's WebRTC offer, answer and candidates. The hub passes it through. */
  | { op: 'signal'; data: unknown }
  /** Direct mode: speaking state and similar news the sandbox's view of the call should reflect. */
  | { op: 'note'; data: unknown };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Hub -> device, on /api/call. */
export type CallServerMessage =
  | { t: 'joined'; call: string; mode: CallMode; iceServers: IceServer[]; direct?: { session: DirectVoiceSession; socket: string; relayOnly: boolean } }
  | { t: 'state'; state: CallState }
  | { t: 'signal'; data: unknown }
  /** Someone played a sound or sent an emoji in the call (`who` a hub identity id). */
  | { t: 'effect'; effect: CallEffect }
  /** The answer to `sounds`: what this account may play, or why nothing. */
  | { t: 'sounds'; sounds: CallSound[]; reason?: string }
  | { t: 'ended'; reason: string }
  | { t: 'error'; message: string };

// ------------------------------------------------------------------ calls you are not in (docs/calls.md "Ringing")

/**
 * How a call ended for you:
 * - answered: you were in it, on some device.
 * - elsewhere: answered on another of your devices (Signal's linked devices hear only that, never how long).
 * - missed: it rang you and nobody answered, or it stopped ringing without you (Discord says the same for a decline on another device).
 * - declined: you declined it (here, or Signal's "declined on another device").
 * - busy: you were busy (Signal's "busy on another device").
 * - cancelled: you called and nobody answered.
 */
export type CallOutcome = 'answered' | 'elsewhere' | 'missed' | 'declined' | 'busy' | 'cancelled';

/**
 * A call as the network says it stands: ringing, going on, or over (the adapter's `callState` event). Idempotent: the
 * adapter sends the whole fact again on each change, and the hub keeps the newest. Native ids throughout.
 */
export interface CallFact {
  /** The call's own id on the network: Discord the id of its call message, Signal the call id. */
  nativeId: string;
  conversation: string;
  /** Who started it, when known. */
  caller?: string;
  /** ms epoch: when it started, the network's own time. A call that rang long ago never alerts (call.ts RING). */
  startedAt: number;
  state: 'ringing' | 'ongoing' | 'ended';
  /** It is ringing this account now. */
  ringsSelf?: boolean;
  /** This account started it. */
  outgoing?: boolean;
  video?: boolean;
  /** Native identity ids of everyone who was in it, as far as the network says. */
  participants?: string[];
  /** With state 'ended'. */
  outcome?: CallOutcome;
  /** ms epoch it ended, when known; with startedAt it gives the duration. */
  endedAt?: number;
  /** ms epoch someone answered, when known (a duration counts from here when it is). */
  answeredAt?: number;
  /** Native id of its line in the timeline (Discord's call message, Signal's offer). */
  message?: string;
}

/** Someone in a voice channel (the adapter's `voice` event). */
export interface VoiceMember {
  /** Native identity id. */
  who: string;
  muted?: boolean;
  deafened?: boolean;
  video?: boolean;
  /** Sharing their screen (Go Live). */
  streaming?: boolean;
}

/** The hub's rules for ringing (packages/hub/src/callstate.ts). */
export const RING = {
  /** A call that started longer ago than this when the hub hears it ring is old news: it never alerts. */
  freshMs: 90_000,
  /** Ringing with no word from the network for this long: it has stopped, and was missed. */
  maxMs: 3 * 60_000,
};

/** Seconds, as a call line says them: "under a minute", "12 min", "1 h 5 min". */
export function callLength(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** How long the call lasted in seconds, when the fact says. */
export function callSeconds(c: Pick<CallFact, 'startedAt' | 'answeredAt' | 'endedAt' | 'outcome'>): number | null {
  if (c.endedAt === undefined || (c.outcome !== undefined && c.outcome !== 'answered')) return null;
  return Math.max(0, Math.round((c.endedAt - (c.answeredAt ?? c.startedAt)) / 1000));
}

/**
 * A call's line in the timeline, worded the same on every network (adapters put it in the message body, the web shows
 * it). `others`: who else was in it, as mentions or names, left out when there is nobody to name.
 */
export function callLine(c: Pick<CallFact, 'state' | 'outcome' | 'video' | 'outgoing' | 'startedAt' | 'answeredAt' | 'endedAt'>, others: string[] = []): string {
  const kind = c.video ? 'video call' : 'call';
  const Kind = c.video ? 'Video call' : 'Call';
  const with_ = others.length ? ` with ${others.length > 3 ? `${others.slice(0, 3).join(', ')} and ${others.length - 3} more` : others.join(', ')}` : '';
  if (c.state === 'ringing') return c.outgoing ? `📞 Calling…` : `📞 Incoming ${kind}`;
  if (c.state === 'ongoing') return `📞 ${Kind} going on${with_}`;
  const secs = callSeconds(c);
  switch (c.outcome) {
    case 'missed':
      return `📞 Missed ${kind}`;
    case 'declined':
      return `📞 Declined ${kind}`;
    case 'busy':
      return `📞 Missed ${kind} (busy on another device)`;
    case 'elsewhere':
      return `📞 ${Kind}, answered on another device`;
    case 'cancelled':
      return `📞 ${Kind}, no answer`;
    default:
      return `📞 ${Kind}${secs !== null ? `, ${callLength(secs)}` : ''}${with_}`;
  }
}

/** A call as the hub keeps it (GET /api/calls/ringing, the `calls` client event). Hub ids. */
export interface CallView {
  id: string;
  accountId: string;
  network: import('./ontology.ts').Network;
  conversationId: string;
  callerId: string | null;
  startedAt: number;
  state: CallFact['state'];
  /** It rings you now: the ring card shows, with Answer and (where the account can) Decline. */
  ringing: boolean;
  outgoing: boolean;
  video: boolean;
  /** Identity ids. */
  participants: string[];
  outcome: CallOutcome | null;
  endedAt: number | null;
  /** Seconds, when known. */
  duration: number | null;
  /** Its line in the timeline. */
  messageId: string | null;
  /** The account can stop it ringing (capability 'declineCall'). */
  canDecline: boolean;
  /** The account can answer it from here (capability 'calls'); else it is answered in the network's own app. */
  canAnswer: boolean;
}

/** Who is in one voice channel, as last heard (GET /api/voice, the `voice` client event). Hub ids. */
export interface VoiceChannelView {
  conversationId: string;
  /** Empty while the adversarial `voice` setting is off: only the status line is kept then. */
  members: (Omit<VoiceMember, 'who'> & { identityId: string })[];
  /** ms epoch the list was last heard. */
  at: number;
  /** The channel's status line ("playing chess"). */
  status: string | null;
}
