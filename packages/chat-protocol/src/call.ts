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
  video?: boolean;
}

export interface CallState {
  conversation: string;
  participants: CallParticipant[];
}

/** Device -> hub, on /api/call. One socket is one call; closing it leaves. */
export type CallClientMessage =
  | { op: 'join'; account: string; conversation: string; mode: CallMode; muted?: boolean; deafened?: boolean }
  | { op: 'leave' }
  | { op: 'mute'; muted: boolean; deafened: boolean }
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
  | { t: 'ended'; reason: string }
  | { t: 'error'; message: string };
