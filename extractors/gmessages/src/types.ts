/**
 * What the bridge (bridge/main.go) prints: its JSON lines, mapped there from libgm's protobufs (bridge/mapping.go).
 * Times are milliseconds since the epoch. Ids are Google Messages' own (per phone): the adapter namespaces them.
 */

export interface GmParticipant {
  id: string;
  number?: string;
  formatted?: string;
  /** PHONE, EMAIL, ALPHA_SHORT_NO_COUNTRY, … */
  idType?: string;
  firstName?: string;
  fullName?: string;
  isMe?: boolean;
  visible?: boolean;
  contactId?: string;
  color?: string;
}

export interface GmConversation {
  id: string;
  name?: string;
  group?: boolean;
  /** 'sms' (SMS/MMS), 'rcs', or '' when the phone does not say. */
  type: 'sms' | 'rcs' | '';
  status: 'active' | 'archived' | 'deleted' | 'spam' | 'blocked' | 'other';
  readOnly?: boolean;
  unread?: boolean;
  pinned?: boolean;
  lastTs: number;
  latestId?: string;
  latestText?: string;
  outgoingId?: string;
  sim?: number;
  sendMode?: 'auto' | 'xms';
  avatarUrl?: string;
  color?: string;
  participants: GmParticipant[];
  others?: string[];
}

export interface GmMedia {
  part?: string;
  mediaId?: string;
  key?: string;
  thumbId?: string;
  thumbKey?: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  /** base64 of media the phone sent inside the message. */
  inline?: string;
  /** The phone is still fetching it (MMS). */
  pending?: boolean;
}

export type GmState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received' | 'downloading' | 'system' | 'deleted';

export interface GmMessage {
  id: string;
  conversation: string;
  participant?: string;
  senderNumber?: string;
  senderName?: string;
  fromMe?: boolean;
  ts: number;
  /** The phone's status name: OUTGOING_DELIVERED, INCOMING_AUTO_DOWNLOADING, TOMBSTONE_PARTICIPANT_LEFT, … */
  status: string;
  state: GmState;
  kind?: 'sms' | 'mms' | 'rcs' | '';
  text?: string;
  subject?: string;
  media?: GmMedia[];
  replyTo?: string;
  reactions?: { emoji: string; participants: string[] }[];
  tmpId?: string;
  /** "Read by Alice, Bob" (groups). */
  statusText?: string;
  error?: string;
  ignore?: boolean;
  /** The chat switched to (true) or from (false) end-to-end encrypted RCS here. */
  e2ee?: boolean;
  old?: boolean;
}

export interface GmSim {
  number: number;
  phone?: string;
  formatted?: string;
  carrier?: string;
  participant?: string;
  rcs?: boolean;
}

export interface GmSettings {
  sims: GmSim[];
  rcsEnabled: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
  defaultSmsApp?: boolean;
  version?: string;
}

export type GmAlert =
  | 'browser_active'
  | 'browser_inactive'
  | 'browser_inactive_timeout'
  | 'browser_inactive_inactivity'
  | 'battery_low'
  | 'battery_restored'
  | 'mobile_data'
  | 'wifi'
  | 'db_sync_started'
  | 'db_sync_complete'
  | 'push_throttle_started'
  | 'push_throttle_ended'
  | 'rcs_connection';

/** libgm's AuthData as JSON: the session secret.json keeps. Only the parts the adapter reads are typed. */
export interface GmSession {
  mobile?: { userID?: number; sourceID?: string; network?: string };
  browser?: { sourceID?: string };
  dest_reg_id?: string;
  tachyon_expiry?: string;
  cookies?: Record<string, string>;
  [k: string]: unknown;
}

export type BridgeEvent =
  | { t: 'ready'; version: string }
  | { t: 'fatal'; error: string }
  | { t: 'qr'; url: string; expiresMs: number; attempt: number; of: number }
  | { t: 'qr_expired' }
  | { t: 'emoji'; emoji: string; svg: string }
  | { t: 'pair_error'; via: 'qr' | 'google'; code: string; error: string }
  | { t: 'paired'; via: 'qr' | 'google'; phone: string; session: GmSession }
  | { t: 'connect_error'; error: string }
  | { t: 'connected'; google: boolean; account?: string; sessionId?: string }
  | { t: 'session'; session: GmSession }
  /** The pairing is gone: removed on the phone (revoked), Google dropped it (not_found), signed out of Google. */
  | { t: 'unpaired'; reason: 'revoked' | 'not_found' | 'google_logged_out' | 'logout' | string; error?: string }
  /** The Google sign-in (cookies) stopped working; the pairing itself may live on. */
  | { t: 'logged_out'; reason: 'invalid_credentials' | 'no_email' | string; error?: string }
  | { t: 'listen_error'; fatal: boolean; error: string }
  | { t: 'listen_recovered' }
  | { t: 'phone'; responding: boolean }
  | { t: 'ping_failed'; error: string; count: number }
  | { t: 'conversation'; conversation: GmConversation }
  | { t: 'message'; message: GmMessage }
  | { t: 'typing'; conversation: string; number: string; stop: boolean }
  | { t: 'alert'; alert: GmAlert }
  | { t: 'settings'; settings: GmSettings }
  | { t: 'account_change'; account: string; enabled: boolean; fake: boolean }
  | { t: 'no_data' }
  | { t: 'set_active_may_fail' };

export type BridgeReply = { t: 'reply'; id: string; ok: true; result?: any } | { t: 'reply'; id: string; ok: false; error: string };
