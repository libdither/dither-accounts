/**
 * What the bridge (bridge/main.go) prints. Messages are protojson of whatsmeow's waE2E.Message:
 * camelCase names (with WhatsApp's own capitals: ID, remoteJID, stanzaID, mentionedJID, PTT),
 * enums as their names, 64-bit integers as strings, bytes as base64.
 */

export interface WaInfo {
  id: string;
  chat: string;
  chatAlt?: string;
  sender: string;
  senderAlt?: string;
  recipientAlt?: string;
  fromMe: boolean;
  isGroup: boolean;
  /** ms */
  ts: number;
  pushName?: string;
  type?: string;
  mediaType?: string;
  edit?: string;
  addressing?: string;
  category?: string;
  deviceSentTo?: string;
}

export interface WaKey {
  remoteJID?: string;
  fromMe?: boolean;
  ID?: string;
  participant?: string;
}

export interface WaContextInfo {
  stanzaID?: string;
  participant?: string;
  remoteJID?: string;
  quotedMessage?: WaMessage;
  mentionedJID?: string[];
  isForwarded?: boolean;
  forwardingScore?: number;
  expiration?: number;
  [k: string]: unknown;
}

export interface WaMedia {
  url?: string;
  mimetype?: string;
  caption?: string;
  fileName?: string;
  title?: string;
  fileLength?: string;
  directPath?: string;
  mediaKey?: string;
  fileSHA256?: string;
  fileEncSHA256?: string;
  width?: number;
  height?: number;
  seconds?: number;
  PTT?: boolean;
  gifPlayback?: boolean;
  viewOnce?: boolean;
  isAnimated?: boolean;
  contextInfo?: WaContextInfo;
  [k: string]: unknown;
}

/** waE2E.Message, the parts the adapter reads. */
export interface WaMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string; matchedText?: string; title?: string; contextInfo?: WaContextInfo; [k: string]: unknown };
  imageMessage?: WaMedia;
  videoMessage?: WaMedia;
  ptvMessage?: WaMedia;
  audioMessage?: WaMedia;
  documentMessage?: WaMedia;
  stickerMessage?: WaMedia;
  reactionMessage?: { key?: WaKey; text?: string; senderTimestampMS?: string };
  protocolMessage?: { key?: WaKey; type?: string; editedMessage?: WaMessage; timestampMS?: string; ephemeralExpiration?: number; [k: string]: unknown };
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string; contextInfo?: WaContextInfo };
  liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number; caption?: string; contextInfo?: WaContextInfo };
  contactMessage?: { displayName?: string; vcard?: string; contextInfo?: WaContextInfo };
  contactsArrayMessage?: { displayName?: string; contacts?: { displayName?: string; vcard?: string }[]; contextInfo?: WaContextInfo };
  pollCreationMessage?: WaPoll;
  pollCreationMessageV2?: WaPoll;
  pollCreationMessageV3?: WaPoll;
  pollCreationMessageV5?: WaPoll;
  pollUpdateMessage?: unknown;
  /** An invitation sent in a chat (not a link): inviteExpiration in seconds, as a string (protojson int64). */
  groupInviteMessage?: { groupJID?: string; inviteCode?: string; inviteExpiration?: string; groupName?: string; caption?: string; contextInfo?: WaContextInfo };
  eventMessage?: { name?: string; description?: string; startTime?: string; location?: { name?: string }; contextInfo?: WaContextInfo };
  callLogMesssage?: unknown;
  callLogMessage?: { isVideo?: boolean; callOutcome?: string; durationSecs?: string };
  buttonsMessage?: { contentText?: string; text?: string; contextInfo?: WaContextInfo };
  templateMessage?: { hydratedTemplate?: { hydratedContentText?: string }; contextInfo?: WaContextInfo };
  listMessage?: { title?: string; description?: string; contextInfo?: WaContextInfo };
  interactiveMessage?: { body?: { text?: string }; contextInfo?: WaContextInfo };
  buttonsResponseMessage?: { selectedDisplayText?: string; contextInfo?: WaContextInfo };
  listResponseMessage?: { title?: string; contextInfo?: WaContextInfo };
  /** Pin or unpin a message for everyone. The duration the pinner chose rides in messageContextInfo. */
  pinInChatMessage?: WaPin;
  keepInChatMessage?: unknown;
  senderKeyDistributionMessage?: unknown;
  messageContextInfo?: { messageAddOnDurationInSecs?: number; [k: string]: unknown };
  [k: string]: unknown;
}

export interface WaPin {
  key?: WaKey;
  type?: 'PIN_FOR_ALL' | 'UNPIN_FOR_ALL' | 'UNKNOWN_TYPE' | string;
  senderTimestampMS?: string;
}

export interface WaPoll {
  name?: string;
  options?: { optionName?: string }[];
  contextInfo?: WaContextInfo;
}

/** waWeb.WebMessageInfo minus the message, on history-sync messages. */
export interface WaWebInfo {
  key?: WaKey;
  messageTimestamp?: string;
  status?: string;
  participant?: string;
  messageStubType?: string;
  messageStubParameters?: string[];
  reactions?: { key?: WaKey; text?: string; senderTimestampMS?: string }[];
  /** On a PINNED_MESSAGE_IN_CHAT stub: the pin, with its duration. */
  pinInChat?: WaPin & { serverTimestampMS?: string; messageAddOnContextInfo?: { messageAddOnDurationInSecs?: number } };
  starred?: boolean;
  [k: string]: unknown;
}

/** waHistorySync.Conversation minus messages. */
export interface WaHistoryConversation {
  ID: string;
  name?: string;
  displayName?: string;
  unreadCount?: number;
  unreadMentionCount?: number;
  markedAsUnread?: boolean;
  archived?: boolean;
  readOnly?: boolean;
  pinned?: number;
  muteEndTime?: string;
  lastMsgTimestamp?: string;
  conversationTimestamp?: string;
  ephemeralExpiration?: number;
  pnJID?: string;
  lidJID?: string;
  newJID?: string;
  oldJID?: string;
  isParentGroup?: boolean;
  parentGroupID?: string;
  isDefaultSubgroup?: boolean;
  description?: string;
  [k: string]: unknown;
}

export interface WaGroup {
  jid: string;
  name: string;
  topic?: string;
  isParent?: boolean;
  linkedParent?: string;
  isDefaultSub?: boolean;
  isAnnounce?: boolean;
  isLocked?: boolean;
  ephemeral?: number;
  created?: number;
  addressing?: string;
  count?: number;
  suspended?: boolean;
  participants: { jid: string; pn?: string; lid?: string; admin?: boolean; superAdmin?: boolean; displayName?: string }[];
  ownerJid?: string;
  ownerPn?: string;
  /** Who may add people: 'admin_add' or 'all_member_add'. */
  memberAddMode?: string;
  /** Joining by link needs an admin's approval. */
  joinApproval?: boolean;
  /** The current description's id, which SetGroupTopic wants as the previous one. */
  topicId?: string;
}

export interface WaContact {
  jid: string;
  alt?: string;
  firstName?: string;
  fullName?: string;
  pushName?: string;
  businessName?: string;
}

/** What userInfo answers for one person (whatsmeow GetUserInfo): their About, picture id and business name. */
export interface WaUserInfo {
  status?: string;
  pictureId?: string;
  lid?: string;
  /** The verified name of a business account. */
  businessName?: string;
  /** 'high' for a verified business. */
  verifiedLevel?: string;
}

/** Someone who asked to join a group you admin (joinRequests: whatsmeow GetGroupRequestParticipants). */
export interface WaJoinRequest {
  /** The JID WhatsApp names them by in this group: a LID, or a phone number. */
  jid: string;
  /** Their other address, where the bridge knows it. */
  alt?: string;
  /** ms */
  ts: number;
}

/** What isOnWhatsApp says about one number (whatsmeow IsOnWhatsApp). */
export interface WaOnWhatsApp {
  query: string;
  /** Their account: a LID or a phone-number JID. */
  jid: string;
  isIn: boolean;
  /** Their other address from the store, or "". */
  alt?: string;
  /** The phone-number JID WhatsApp answered with, when jid is a LID. */
  pn?: string;
  /** A business's verified name. */
  businessName?: string;
}

export interface WaSelf {
  loggedIn: boolean;
  jid?: string;
  lid?: string;
  pushName?: string;
  businessName?: string;
}

export type BridgeEvent =
  | ({ t: 'ready'; version: string; loggedIn: boolean })
  | { t: 'fatal'; error: string }
  | { t: 'qr'; code: string; timeoutMs: number }
  | { t: 'qr_done'; result: string; error?: string }
  | { t: 'paired'; jid: string; lid?: string; businessName?: string; platform?: string }
  | { t: 'pair_error'; error: string }
  | ({ t: 'connected' } & WaSelf)
  | { t: 'disconnected' }
  | { t: 'keepalive_timeout'; errors: number }
  | { t: 'keepalive_restored' }
  | { t: 'logged_out'; reason: string; onConnect: boolean }
  | { t: 'stream_replaced' }
  | { t: 'temporary_ban'; code: number; reason: string; expireSec: number; message: string }
  | { t: 'connect_failure'; reason: number; message: string }
  | { t: 'client_outdated' }
  | { t: 'stream_error'; code: string }
  | { t: 'message'; info: WaInfo; message: WaMessage | null; flags?: string[]; history?: boolean; web?: WaWebInfo }
  | { t: 'undecryptable'; info: WaInfo; unavailable: boolean; unavailableType?: string }
  | { t: 'history'; syncType: string; chunkOrder?: number; progress?: number; conversations: WaHistoryConversation[]; pushnames: { jid: string; name: string }[]; lidMappings: { pn: string; lid: string }[] }
  | { t: 'history_done'; syncType: string; chunkOrder?: number; count: number }
  /** type: '' delivered, 'read', 'played' from others; 'read-self', 'read' (fromMe) from your own devices; 'sender', 'retry', … */
  | { t: 'receipt'; chat: string; sender: string; senderAlt?: string; fromMe: boolean; isGroup: boolean; ids: string[]; ts: number; type: string; messageSender?: string }
  | { t: 'chat_presence'; chat: string; sender: string; fromMe: boolean; state: string; media?: string }
  | { t: 'push_name'; jid: string; alt?: string; name: string }
  | { t: 'business_name'; jid: string; name: string }
  | { t: 'contact'; jid: string; alt?: string; fullName?: string; firstName?: string }
  | { t: 'mute'; jid: string; muted: boolean; until?: number }
  | { t: 'archive'; jid: string; archived: boolean }
  | { t: 'pin'; jid: string; pinned: boolean }
  | { t: 'mark_chat_read'; jid: string; read: boolean; ts: number }
  | { t: 'delete_chat'; jid: string }
  | { t: 'clear_chat'; jid: string }
  | { t: 'delete_for_me'; chat: string; sender?: string; fromMe: boolean; id: string }
  | { t: 'picture'; jid: string; id?: string; remove: boolean }
  | { t: 'group'; group: WaGroup }
  /** alts: a member's other address (phone number <-> LID), where the bridge knows it. */
  | { t: 'group_change'; jid: string; join: string[]; leave: string[]; promote?: string[]; demote?: string[]; alts?: Record<string, string>; name?: string; topic?: string; deleted?: boolean; sender?: string; senderPn?: string; ts: number; approvalMode?: boolean }
  /**
   * Someone asked to join a group you admin, or (gone) their request went: they withdrew it or another admin declined
   * it. An approved request comes as a group_change that adds them. user: the requester; by: who did it.
   */
  | { t: 'join_request'; group: string; user: string; alt?: string; ts: number; method?: string; gone?: boolean; by?: string }
  /** A contact's About changed (WhatsApp pushes it; never asked for). */
  | { t: 'user_about'; jid: string; alt?: string; status: string; ts?: number }
  | { t: 'app_state_synced'; name: string }
  | { t: 'offline_sync'; total: number; done: boolean };

export type BridgeReply = { t: 'reply'; id: string; ok: true; result?: any } | { t: 'reply'; id: string; ok: false; error: string };
