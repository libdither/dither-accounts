/**
 * signal-cli 0.14.x JSON shapes, as written by its Json* records
 * (src/main/java/org/asamk/signal/json/*.java). Everything is optional on our
 * side: fields are null when unknown, and older/newer versions add or drop some.
 */

export interface SigAddressish {
  /** Deprecated legacy identifier: the number if known, else the uuid. */
  source?: string | null;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
}

export interface SigMention {
  name?: string | null; // deprecated legacy identifier
  number?: string | null;
  uuid?: string | null;
  start: number; // UTF-16 code units
  length: number;
}

export type SigStyle = 'BOLD' | 'ITALIC' | 'SPOILER' | 'STRIKETHROUGH' | 'MONOSPACE';

export interface SigTextStyle {
  style: SigStyle | string;
  start: number; // UTF-16 code units
  length: number;
}

export interface SigAttachment {
  contentType?: string | null;
  filename?: string | null;
  /** File name inside <data dir>/attachments/ (remote id + extension). Null for streams. */
  id?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
  uploadTimestamp?: number | null;
  isVoiceNote?: boolean;
}

/** JsonStoryMessage: a story, a picture or video (fileAttachment) or text. Colours are "#AARRGGBB". */
export interface SigStory {
  allowsReplies?: boolean;
  groupId?: string | null;
  fileAttachment?: SigAttachment | null;
  textAttachment?: {
    text?: string | null;
    style?: string | null;
    textForegroundColor?: string | null;
    textBackgroundColor?: string | null;
    preview?: { url?: string | null; title?: string | null } | null;
    backgroundGradient?: { startColor?: string | null; endColor?: string | null; colors?: string[] | null; positions?: number[] | null; angle?: number | null } | null;
    backgroundColor?: string | null;
  } | null;
}

/** JsonSyncStoryMessage: a story you posted on another device. */
export interface SigSyncStory {
  destinationNumber?: string | null;
  destinationUuid?: string | null;
  dataMessage?: SigStory | null;
}

export interface SigQuote {
  id: number; // sent timestamp of the quoted message
  author?: string | null;
  authorNumber?: string | null;
  authorUuid?: string | null;
  text?: string | null;
  mentions?: SigMention[] | null;
  attachments?: { contentType?: string | null; filename?: string | null; thumbnail?: SigAttachment | null }[];
  textStyles?: SigTextStyle[] | null;
}

export interface SigReaction {
  emoji: string;
  targetAuthor?: string | null;
  targetAuthorNumber?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp: number;
  isRemove?: boolean;
}

export interface SigTargeted {
  targetAuthor?: string | null;
  targetAuthorNumber?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp: number;
}

export interface SigGroupInfo {
  groupId: string; // base64
  groupName?: string | null;
  revision?: number;
  type?: 'UPDATE' | 'DELIVER' | string;
}

/** One of a shared contact's phones or emails. `type` is HOME, MOBILE, WORK or CUSTOM (then `label` names it). */
export interface SigContactValue {
  value?: string | null;
  type?: string | null;
  label?: string | null;
}

export interface SigSharedContact {
  name?: { nickname?: string | null; given?: string | null; family?: string | null; prefix?: string | null; suffix?: string | null; middle?: string | null } | null;
  avatar?: { attachment?: SigAttachment | null; isProfile?: boolean } | null;
  phone?: SigContactValue[] | null;
  email?: SigContactValue[] | null;
  address?: { type?: string | null; label?: string | null; street?: string | null; pobox?: string | null; neighborhood?: string | null; city?: string | null; region?: string | null; postcode?: string | null; country?: string | null }[] | null;
  organization?: string | null;
}

export interface SigDataMessage {
  timestamp: number;
  message?: string | null;
  expiresInSeconds?: number | null;
  isExpirationUpdate?: boolean | null;
  viewOnce?: boolean | null;
  groupCallUpdate?: { eraId?: string | null } | null;
  isEndSession?: boolean | null;
  isProfileKeyUpdate?: boolean | null;
  hasProfileKey?: boolean | null;
  reaction?: SigReaction | null;
  quote?: SigQuote | null;
  payment?: { note?: string | null } | null;
  mentions?: SigMention[] | null;
  previews?: { url?: string | null; title?: string | null; description?: string | null; image?: SigAttachment | null }[] | null;
  attachments?: SigAttachment[] | null;
  sticker?: { packId: string; stickerId: number } | null;
  remoteDelete?: { timestamp: number } | null;
  contacts?: SigSharedContact[] | null;
  pollCreate?: { question?: string | null; allowMultiple?: boolean; options?: string[] | null } | null;
  /** The poll's author (author, authorNumber, authorUuid) and its timestamp; the voter is the message's sender. */
  pollVote?: { targetSentTimestamp: number; optionIndexes?: number[]; voteCount?: number; author?: string | null; authorNumber?: string | null; authorUuid?: string | null } | null;
  pollTerminate?: { targetSentTimestamp: number } | null;
  textStyles?: SigTextStyle[] | null;
  groupInfo?: SigGroupInfo | null;
  storyContext?: { authorNumber?: string | null; authorUuid?: string | null; sentTimestamp: number } | null;
  pinMessage?: (SigTargeted & { pinDurationSeconds?: number }) | null;
  unpinMessage?: SigTargeted | null;
  adminDelete?: SigTargeted | null;
}

export interface SigEditMessage {
  targetSentTimestamp: number;
  dataMessage: SigDataMessage;
}

/** syncMessage.sentMessage: a transcript of something you sent from another device. The data message is unwrapped into it. */
export type SigSentMessage = Partial<SigDataMessage> & {
  destination?: string | null;
  destinationNumber?: string | null;
  destinationUuid?: string | null;
  editMessage?: SigEditMessage | null;
};

export interface SigReadMessage {
  sender?: string | null;
  senderNumber?: string | null;
  senderUuid?: string | null;
  timestamp: number;
}

export interface SigSyncMessage {
  sentMessage?: SigSentMessage | null;
  sentStoryMessage?: SigSyncStory | null;
  blockedNumbers?: string[] | null;
  blockedGroupIds?: string[] | null;
  readMessages?: SigReadMessage[] | null;
  type?: 'CONTACTS_SYNC' | 'GROUPS_SYNC' | string | null;
}

export interface SigTypingMessage {
  action: 'STARTED' | 'STOPPED' | string;
  timestamp: number;
  groupId?: string | null;
}

export interface SigReceiptMessage {
  when: number;
  isDelivery: boolean;
  isRead: boolean;
  isViewed: boolean;
  timestamps: number[];
}

export interface SigCallMessage {
  offerMessage?: { id: number | string; type?: 'AUDIO_CALL' | 'VIDEO_CALL' | string; opaque?: string } | null;
  answerMessage?: unknown;
  busyMessage?: unknown;
  hangupMessage?: { id: number | string; type?: string; deviceId?: number } | null;
  iceUpdateMessages?: unknown[];
}

export interface SigEnvelope extends SigAddressish {
  sourceName?: string | null;
  sourceDevice?: number | null;
  timestamp: number;
  serverReceivedTimestamp?: number;
  serverDeliveredTimestamp?: number;
  dataMessage?: SigDataMessage | null;
  editMessage?: SigEditMessage | null;
  storyMessage?: SigStory | null;
  syncMessage?: SigSyncMessage | null;
  callMessage?: SigCallMessage | null;
  receiptMessage?: SigReceiptMessage | null;
  typingMessage?: SigTypingMessage | null;
}

/** One received item: the `receive` notification params (daemon) or one stdout line (`receive -o json`). */
export interface SigReceive {
  account?: string | null;
  envelope?: SigEnvelope | null;
  exception?: { message?: string | null; type?: string | null } | null;
}

/** `listContacts` (always detailed in JSON mode). */
export interface SigContact {
  number?: string | null;
  uuid?: string | null;
  username?: string | null;
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  nickName?: string | null;
  nickGivenName?: string | null;
  nickFamilyName?: string | null;
  note?: string | null;
  color?: string | null;
  isArchived?: boolean;
  isBlocked?: boolean;
  isHidden?: boolean;
  messageExpirationTime?: number;
  profileSharing?: boolean;
  unregistered?: boolean;
  profile?: {
    lastUpdateTimestamp?: number;
    givenName?: string | null;
    familyName?: string | null;
    about?: string | null;
    aboutEmoji?: string | null;
    hasAvatar?: boolean;
    mobileCoinAddress?: string | null;
  } | null;
}

/** `listGroups` (always detailed in JSON mode). */
export interface SigGroup {
  id: string; // base64
  name?: string | null;
  description?: string | null;
  isMember?: boolean;
  isBlocked?: boolean;
  messageExpirationTime?: number;
  /** label, labelEmoji: the member label each set (signal-cli 0.14.8, JsonGroupMember). */
  members?: { number?: string | null; uuid?: string | null; isAdmin?: boolean; label?: string | null; labelEmoji?: string | null }[];
  pendingMembers?: { number?: string | null; uuid?: string | null }[];
  requestingMembers?: { number?: string | null; uuid?: string | null }[];
  admins?: { number?: string | null; uuid?: string | null }[];
  banned?: { number?: string | null; uuid?: string | null }[];
  permissionAddMember?: string;
  permissionEditDetails?: string;
  permissionSendMessage?: string;
  groupInviteLink?: string | null;
  isTerminated?: boolean;
}

/** `send`, `sendReaction`, `remoteDelete`, ... */
export interface SigSendResult {
  timestamp: number;
  results?: { recipientAddress?: { uuid?: string | null; number?: string | null }; groupId?: string; type: string; token?: string; retryAfterSeconds?: number }[];
}

/** `getUserStatus`: one per number (`recipient`) and per username or username link (`username`) asked. */
export interface SigUserStatus {
  recipient?: string | null;
  number?: string | null;
  username?: string | null;
  uuid?: string | null;
  isRegistered?: boolean;
}

/** `joinGroup`: `onlyRequested` when the group's admins approve joins first (you asked; you are not in it yet). */
export interface SigJoinResult extends Partial<SigSendResult> {
  groupId?: string | null;
  onlyRequested?: boolean;
}

/** listStickerPacks (ListStickerPacksCommand.JsonStickerPack). */
export interface SigStickerPack {
  packId: string;
  url?: string | null;
  installed?: boolean;
  title?: string | null;
  author?: string | null;
  cover?: { id: number; emoji?: string | null; contentType?: string | null } | null;
  stickers?: { id: number; emoji?: string | null; contentType?: string | null }[] | null;
}
