/**
 * Minimal shapes of the raw Discord objects the in-page hook forwards, plus the
 * little "bridge" protocol spoken between the extension's service worker and this
 * adapter process. Only whitelisted fields appear here: the hook must never send
 * anything this file does not name.
 *
 * These mirror the Discord client's own gateway/REST objects closely enough that
 * the fixtures in test/ read like real payloads. Nothing here talks to the hub;
 * map.ts turns these into protocol facts.
 */

import type { CallEffect, CallParticipant, CallStage } from '@dither-chat/protocol';
import type { RawSelfUp, SelfHookCommand } from './self.ts';
import type { AttentionDispatch, AttentionHookCommand } from './attention.ts';
import type { InteractDispatch, InteractHookCommand } from './interact.ts';
import type { RawThreadFields, ThreadDispatch, ThreadHookCommand } from './threads.ts';
import type { SendingHookCommand } from './sending.ts';

// ----------------------------------------------------------------- raw Discord

export interface RawUser {
  id: string;
  username?: string;
  global_name?: string | null;
  /** legacy discriminator; "0" for the new username system */
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

export interface RawGuild {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  rules_channel_id?: string | null;
}

/** A guild channel, category, thread, DM or group DM. Discord uses one object for all. */
export interface RawChannel {
  id: string;
  type: number;
  guild_id?: string | null;
  name?: string | null;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  /** DMs / group DMs */
  recipients?: RawUser[];
  owner_id?: string | null;
  icon?: string | null;
  /** Group DMs without an icon: the client's default picture for it (an absolute URL), from the hook. */
  default_icon?: string;
  /** threads */
  thread_metadata?: { archived?: boolean; locked?: boolean };
  last_message_id?: string | null;
  /** A thread's membership, tags and counts, a forum's tags (threads.ts RawThreadFields). */
  member?: RawThreadFields['member'];
  applied_tags?: string[];
  available_tags?: RawThreadFields['available_tags'];
  default_sort_order?: number | null;
  default_forum_layout?: number | null;
  flags?: number | null;
  message_count?: number | null;
  create_timestamp?: string | null;
}

export interface RawAttachment {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
  url: string;
  proxy_url?: string;
  /** Alt text. */
  description?: string | null;
  /** IS_SPOILER 8, CONTAINS_EXPLICIT_MEDIA 16 (rich.ts). */
  flags?: number;
  /** The client's record says a spoiler itself. */
  spoiler?: boolean;
  /** A voice message's length and waveform (base64, a byte a point). */
  duration_secs?: number;
  waveform?: string;
}

export interface RawEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  provider?: { name?: string };
  author?: { name?: string; icon_url?: string; url?: string };
  fields?: { name: string; value: string }[];
  thumbnail?: { url?: string };
  image?: { url?: string };
  /** An int from the gateway; the hook passes either form (rich.ts embedMore). */
  color?: number | string;
  footer?: { text?: string; icon_url?: string };
  timestamp?: string | number;
  video?: { url?: string; proxy_url?: string; width?: number; height?: number };
}

/** A message component, raw or from the client's record, as the hook whitelists it (rich.ts). */
export interface RawComponent {
  type: number;
  custom_id?: string;
  style?: number;
  label?: string;
  emoji?: { id?: string | null; name?: string | null; animated?: boolean } | null;
  url?: string;
  disabled?: boolean;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  options?: { label?: string; value?: string; description?: string; emoji?: RawComponent['emoji']; default?: boolean }[];
  components?: RawComponent[];
  accessory?: RawComponent;
  content?: string;
  media?: RawComponentMedia;
  file?: RawComponentMedia;
  items?: { media?: RawComponentMedia; description?: string | null; spoiler?: boolean }[];
  description?: string | null;
  spoiler?: boolean;
  divider?: boolean;
  name?: string;
  size?: number;
}
export interface RawComponentMedia {
  url?: string;
  proxy_url?: string;
  content_type?: string;
  width?: number;
  height?: number;
  attachment_id?: string;
}

export interface RawEmoji {
  id?: string | null;
  name: string | null;
  animated?: boolean;
}

/**
 * A poll as the hook picks it (polls.ts): counts by answer id and your own answers, when the client or the gateway
 * said them. An older hook sent `answers` as their words alone.
 */
export interface RawPoll {
  question?: string;
  answers?: ({ id: string; text?: string; emoji?: RawEmoji | null } | string)[];
  expiry?: string | null;
  allow_multiselect?: boolean;
  finalized?: boolean;
  counts?: Record<string, number>;
  mine?: string[];
}

export interface RawReaction {
  emoji: RawEmoji;
  /** Normal plus super, unless count_details is there. */
  count?: number;
  count_details?: { normal?: number; burst?: number };
  burst_count?: number;
  me?: boolean;
  me_burst?: boolean;
  burst_colors?: string[];
}

export interface RawMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
  /** 0 a reply (the default), 1 a forward. */
  type?: number;
}

export interface RawMessage {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  author: RawUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  /** https://discord.com/developers/docs/resources/channel#message-object-message-types */
  type?: number;
  tts?: boolean;
  mention_everyone?: boolean;
  mentions?: RawUser[];
  attachments?: RawAttachment[];
  embeds?: RawEmbed[];
  reactions?: RawReaction[];
  message_reference?: RawMessageReference;
  /** present on the message that started a thread */
  thread?: RawChannel;
  /** a forward: the content lives here, and the message's own fields are empty */
  message_snapshots?: { content?: string; timestamp?: string; attachments?: RawAttachment[]; embeds?: RawEmbed[] }[];
  /** format_type: 1 PNG, 2 APNG, 3 Lottie, 4 GIF. Older hooks sent the name alone. */
  sticker_items?: RawStickerItem[];
  poll?: RawPoll;
  nonce?: string | number;
  /** Absent when the hook did not say (a partial update). */
  pinned?: boolean;
  /** The author's member object the gateway sent with a guild message, as it came (never looked up). */
  member?: Omit<RawSeenMember, 'user'>;
  /** A call message (type 3): who was in the call, and when it ended (null: still going on). */
  call?: { participants: string[]; ended_timestamp: string | null };
  /** MessageFlags (rich.ts MESSAGE_FLAG). */
  flags?: number;
  components?: RawComponent[];
  application_id?: string;
  webhook_id?: string;
  /** Roles pinged, by id. */
  mention_roles?: string[];
  /** The roles the hook found named in it, with names and colours from the client's role store. */
  mention_role_names?: { id: string; name: string; color?: string }[];
  /** The command a bot's message answers: interaction type 2 a command, 3 a component, 5 a modal. */
  interaction_metadata?: { type?: number; name?: string; user?: RawUser };
  interaction?: { type?: number; name?: string; user?: RawUser };
  /** An activity invite: type 1 join, 2 spectate, 3 listen, 5 join request. */
  activity?: { type?: number };
  application?: { name?: string };
}

/** The stickersPage hook command's reply. */
export interface RawStickerPage {
  packs: { id: string; name: string; source: 'server' | 'standard'; cover?: string; stickers: { id: string; name: string; format_type: number; tags?: string }[] }[];
  next: number | null;
  note?: string;
}

/** The least Discord sends to draw a sticker: https://docs.discord.food/resources/sticker#sticker-item-structure */
export interface RawStickerItem {
  id?: string;
  name: string;
  format_type?: number;
}

/** A server member the client loaded on its own, as the hook passes it on: role names, not ids. */
export interface RawSeenMember {
  user: RawUser;
  /** null: none. */
  nick?: string | null;
  /** Role names, @everyone left out. Absent: the client had not the roles' names. */
  roles?: string[];
  joined_at?: string | null;
}

/**
 * Members the client received without our asking: a GUILD_MEMBERS_CHUNK it asked for itself, or the member list in
 * view (GUILD_MEMBER_LIST_UPDATE), with that list's counts. At most 500.
 */
export interface RawMembersSeen {
  guildId: string;
  members: RawSeenMember[];
  memberCount?: number | null;
  onlineCount?: number | null;
}

/** Discord read state (ReadStateStore): one row per channel the user has seen. */
export interface RawReadState {
  id: string; // channel id
  last_message_id?: string | null;
  mention_count?: number;
}

/**
 * Discord's own flags on a friend request waiting on you (RelationshipStore isSpam / isStranger, or the record's
 * isSpamRequest / isStrangerRequest). stranger: no server or friend in common, so Discord wants an accept confirmed;
 * null while the client does not say.
 */
export interface RawRequestFlags {
  spam?: boolean;
  stranger?: boolean | null;
}

/**
 * A single relationship (RelationshipStore): 1 friend, 2 blocked, 3 they asked you (a request), 4 you asked them,
 * 5 implicit. Never the nickname you gave them.
 */
export interface RawRelationship extends RawRequestFlags {
  id: string; // the other user's id
  type: number;
  /** Who (friends, blocks and requests either way). */
  user?: RawUser;
  /** When it began (ISO): friends, blocks and requests either way. */
  since?: string | null;
}

/**
 * RELATIONSHIP_ADD, _UPDATE and _REMOVE as the hook forwards them: whose, and the type it now has (or, for a remove,
 * had), when it began, and for a request waiting on you its flags. UPDATE_STRANGER_STATUS comes in the same shape, for
 * a request waiting on you only. Never the nickname you gave them.
 */
export interface RawRelationshipChange extends RawRequestFlags {
  id: string;
  type: number | null;
  user?: RawUser | null;
  since?: string | null;
}

/** Per-guild notification settings (UserGuildSettingsStore). */
export interface RawChannelOverride {
  channel_id: string;
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
  message_notifications?: number;
}
export interface RawGuildSettings {
  guild_id: string | null; // null = the "private channels" pseudo-guild (DMs)
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
  message_notifications?: number;
  channel_overrides?: RawChannelOverride[];
}

/** Everything the hook gathers once it is logged in and the stores are warm. */
export interface RawSnapshot {
  self?: RawUser;
  guilds?: RawGuild[];
  /** guild channels and categories (types 0,2,4,5,13,15,16) */
  channels?: RawChannel[];
  /** active threads (types 10,11,12) */
  threads?: RawChannel[];
  /** DMs and group DMs (types 1,3) */
  privateChannels?: RawChannel[];
  relationships?: RawRelationship[];
  /** users referenced anywhere above that are not otherwise sent */
  users?: RawUser[];
  readStates?: RawReadState[];
  guildSettings?: RawGuildSettings[];
  /** Friends' custom statuses, for those online (an offline one shows none, which is not the same as having none). */
  customStatuses?: RawCustomStatus[];
  /** Friends' presences, offline ones too. */
  presences?: RawPresence[];
  /**
   * The relationships are the gateway's whole list (the client took in READY), so the requests among them are all of
   * them. Absent: the list may not be in yet, and no `requests` is sent from it.
   */
  requestsKnown?: boolean;
  /** Your own roles in each server, by id, from the client's member store: never anyone else's (rich.ts). */
  selfRoles?: Record<string, string[]>;
}

/** Someone's presence as the hook forwards it: invisible is offline; devices where they are on. */
export interface RawPresence {
  user: RawUser;
  state: 'online' | 'idle' | 'dnd' | 'offline';
  devices?: ('desktop' | 'mobile' | 'web')[];
}

/** Someone's custom status: Discord's type-4 activity. No text and no emoji: they have none. */
export interface RawCustomStatus {
  user: RawUser;
  text?: string | null;
  emoji?: RawEmoji | null;
}

/** GUILD_MEMBER_UPDATE as the hook forwards it: only when the roles changed, or it could not tell. */
export interface RawMemberUpdate {
  guildId: string;
  user: RawUser;
  roles: string[];
  /**
   * Their roles in the client's member store just before: null, it had not loaded them (no change is knowable);
   * absent, the hook could not look (the adapter's own memory stands in).
   */
  before?: string[] | null;
  /** Names and colours of the roles on either side. */
  named?: Pick<RawRole, 'id' | 'name' | 'color'>[];
}

// --------------------------------------------------------------- bridge protocol
// service worker  <->  adapter process, over ws://127.0.0.1:<port>/?token=...

/** The auth/page/gateway state the hook reports. Drives adapter status. */
export type PageState = 'loading' | 'login' | 'app' | 'captcha' | 'verify' | 'crashed';

/** service worker -> adapter */
export type BridgeUp =
  | { t: 'ready' }
  | { t: 'finders'; results: Record<string, boolean>; detail?: string }
  | { t: 'page'; state: PageState; url?: string }
  | { t: 'connection'; open: boolean }
  | { t: 'snapshot'; data: RawSnapshot }
  | { t: 'identities'; users: RawUser[] }
  | { t: 'dispatch'; event: DispatchName; data: any }
  /** A sign-in request Discord refused, from the client's own log. */
  | { t: 'loginIssue'; route: string; status: number; captcha?: string; message?: string; code?: number }
  /** A call's bridge signalling, its participants (with their users, so they have names), or its end. */
  | { t: 'call'; call: string; signal?: unknown; state?: { channelId: string; participants: CallParticipant[]; stage?: CallStage }; users?: RawUser[]; ended?: string; effect?: CallEffect }
  | { t: 'reply'; id: string; ok: true; result?: unknown }
  | { t: 'reply'; id: string; ok: false; error: string; retryAfter?: number }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: unknown }
  /** The account itself: notices, settings, whom you ignore (self.ts). */
  | RawSelfUp;

/** Flux actions the hook forwards. Keep this list in sync with hook.js. */
export type DispatchName =
  /** Mentions, the notification center, notification settings, message requests (attention.ts). */
  | AttentionDispatch
  /** An interaction's outcome and a form a bot opened, the hook's own (interact.ts). */
  | InteractDispatch
  /** This account's thread membership, forum posts loaded (threads.ts). */
  | ThreadDispatch
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_REACTION_ADD'
  | 'MESSAGE_REACTION_REMOVE'
  | 'MESSAGE_REACTION_REMOVE_ALL'
  | 'MESSAGE_REACTION_REMOVE_EMOJI'
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATES'
  | 'CHANNEL_DELETE'
  | 'GUILD_CREATE'
  | 'GUILD_UPDATE'
  | 'GUILD_DELETE'
  | 'THREAD_CREATE'
  | 'THREAD_UPDATE'
  | 'THREAD_DELETE'
  | 'THREAD_LIST_SYNC'
  | 'MESSAGE_ACK'
  | 'TYPING_START'
  | 'CHANNEL_PINS_UPDATE'
  | 'GUILD_MEMBER_UPDATE'
  | 'PRESENCE_UPDATE'
  | 'PRESENCE_UPDATES'
  | 'CONNECTION_OPEN_SUPPLEMENTAL'
  | 'GUILD_MEMBERS_CHUNK'
  | 'GUILD_MEMBER_LIST_UPDATE'
  | 'RELATIONSHIP_ADD'
  | 'RELATIONSHIP_UPDATE'
  | 'RELATIONSHIP_REMOVE'
  /** The client loaded its relationships again: { relationships } as the store now has them, the whole list. */
  | 'LOAD_RELATIONSHIPS_SUCCESS'
  /** The client learned whether someone who asked is a stranger: a RawRelationshipChange of that request. */
  | 'UPDATE_STRANGER_STATUS'
  /** Someone added to a group DM, or gone from it: a RawRecipientChange. */
  | 'CHANNEL_RECIPIENT_ADD'
  | 'CHANNEL_RECIPIENT_REMOVE'
  /** A moderator's purge: { ids, channelId, guildId }. */
  | 'MESSAGE_DELETE_BULK'
  /** Reactions in a batch: { channelId, messageId, reactions: { users, emoji, reactionType }[] } (users by id). */
  | 'MESSAGE_REACTION_ADD_MANY';

/** Who was added to a group DM or left it, and the group as the client's store then had it (null: not loaded). */
export interface RawRecipientChange {
  channelId: string;
  user: RawUser;
  channel: RawChannel | null;
}

/** adapter -> service worker: a command for the hook to run through the client's own code. */
export type BridgeDown =
  | { t: 'cmd'; id: string; cmd: HookCommand }
  | { t: 'ping' };

export type HookCommand =
  /** recentMentions, mute, markUnread, markReadMany, messageRequestAnswer (attention.ts). */
  | AttentionHookCommand
  /** ixComponent, ixCommands, ixRun, ixSuggest, ixSubmit: bots and apps (interact.ts). */
  | InteractHookCommand
  /** Threads, forum posts, publishing, group DMs (threads.ts). */
  | ThreadHookCommand
  /** suppressEmbeds, save, savedList, nativeScheduled, cancelScheduled (sending.ts). */
  | SendingHookCommand
  | { kind: 'lab'; op: string; [k: string]: unknown }
  | {
      kind: 'send';
      channelId: string;
      content: string;
      replyTo?: string;
      nonce: string;
      files?: { name: string; mime: string; size: number; base64: string }[];
      /** Send these stickers, as the client's picker does (MessageActions.sendStickers). */
      stickerIds?: string[];
      /** The one file is a voice message: IS_VOICE_MESSAGE, no text, its length and waveform on the file. */
      voice?: { duration_secs: number; waveform: string };
      /** silent and mentionReplied: the client's own send options (sending.ts sendOptions). */
      silent?: boolean;
      mentionReplied?: boolean;
    }
  /** reply RawStickerPage: the stickers the client's own rule lets this account send here, a page of packs from `offset`. */
  | { kind: 'stickers'; channelId: string; offset: number; limit: number }
  /** reply { nativeId } of the forward; the note follows it as its own message, as the client's forward does. */
  | { kind: 'forward'; channelId: string; source: { channelId: string; messageId: string }; note?: string; nonce: string }
  | { kind: 'openDirect'; userId: string }
  | { kind: 'history'; channelId: string; limit: number; beforeId?: string }
  /**
   * reply RawSearch (search.ts): Discord's message search of a server (guildId), or of one channel (channelId: a DM's
   * own search; a server channel's is its server's, narrowed to it), with the query Discord's search bar sends.
   */
  | { kind: 'search'; guildId?: string; channelId?: string; params: Record<string, string | number | boolean | string[]> }
  /** reply RawWalk (search.ts): one member query of the gateway (op 8, as the client's own member search asks it). */
  | { kind: 'walkMembers'; guildId: string; query: string; limit: number; recent?: boolean; after?: string }
  /** reply RawMentionables (mentionables.ts): who a channel can ping, from the client's stores and its own @ list's member search. */
  | { kind: 'mentionables'; channelId: string; query: string; limit: number }
  | { kind: 'threads'; channelId: string; archived: boolean; offset: number; mine?: boolean }
  | { kind: 'markRead'; channelId: string; messageId: string }
  | { kind: 'typing'; channelId: string; stop?: boolean }
  | { kind: 'react'; channelId: string; messageId: string; emoji: string; remove?: boolean; burst?: boolean }
  | { kind: 'reactors'; channelId: string; messageId: string; emoji: string; burst?: boolean }
  | { kind: 'reactionContext'; channelId: string }
  | { kind: 'edit'; channelId: string; messageId: string; content: string }
  | { kind: 'redact'; channelId: string; messageId: string }
  /** Moderating (moderation.ts): one action on a member, the Bans list, someone else's message, reactions. */
  | { kind: 'moderate'; guildId: string; userId: string; op: 'kick' | 'ban' | 'unban' | 'timeout' | 'role' | 'voiceMute' | 'voiceDeafen' | 'move' | 'disconnect'; deleteSeconds?: number; seconds?: number; roleId?: string; remove?: boolean; on?: boolean; channelId?: string }
  | { kind: 'bans'; guildId: string }
  | { kind: 'modRedact'; channelId: string; messageId: string }
  | { kind: 'clearReactions'; channelId: string; messageId: string; emoji?: string; userId?: string }
  | { kind: 'fetchMedia'; url: string }
  /** Sign old attachment links again (POST /attachments/refresh-urls); result { refreshed: { original, refreshed }[] }. */
  | { kind: 'refreshUrls'; urls: string[] }
  /** Your server folders as the client keeps them, from its stores only; reply { folders: { id, name, color, guildIds }[] | null }. */
  | { kind: 'guildFolders' }
  /** reply RawAbout, from the client's stores only. */
  | { kind: 'about'; target: 'conversation' | 'space'; id: string }
  /** PATCH one channel or server; reply { channel } or { guild } as it now stands. */
  | { kind: 'configure'; channelId?: string; guildId?: string; patch: RawAboutPatch }
  /** reply RawProfile: the client's own profile fetch, then its stores. */
  | { kind: 'profile'; userId: string }
  /** Your own bio, as the client's profile settings save it (PATCH /users/@me/profile); reply RawProfile of yourself. */
  | { kind: 'setProfile'; bio: string }
  /** join: reply { direct?: DirectVoiceSession }. */
  | { kind: 'call'; call: string; op: 'join'; channelId: string; mode: 'bridge' | 'direct'; muted?: boolean; deafened?: boolean; ring?: boolean }
  /** Stop a call ringing for you: the client's own Decline (CallActions.stopRinging). */
  | { kind: 'declineCall'; channelId: string }
  | { kind: 'call'; call: string; op: 'leave' }
  | { kind: 'call'; call: string; op: 'mute'; muted: boolean; deafened: boolean }
  | { kind: 'call'; call: string; op: 'signal' | 'note'; data: unknown }
  /** reply RawInvite: the client's own invite lookup (counts and expiry), as its Join a Server dialog runs it. */
  | { kind: 'inviteResolve'; code: string }
  /** reply RawJoin: the client's own accept. friend: the invite is a friend invite and adding them is meant. */
  | { kind: 'inviteAccept'; code: string; friend?: boolean }
  /** reply RawPerson, from the client's stores only: no request. */
  | { kind: 'person'; handle: string }
  /**
   * reply RawFriend: a friend request by username, or by user id (which accepts theirs if they asked first). confirm:
   * the owner confirmed accepting a stranger's request (by user id only).
   */
  | { kind: 'friendAdd'; username?: string; userId?: string; confirm?: true }
  /** reply RawFriend: a friend request waiting on you, answered. confirm: the owner confirmed (accept only). */
  | { kind: 'friendAnswer'; userId: string; answer: 'accept' | 'decline' | 'block'; confirm?: true }
  /** reply RawFriend: unfriend (1), cancel a request you sent (4) or unblock (2), if that is still the relationship. */
  | { kind: 'friendRemove'; userId: string; type: 1 | 2 | 4 }
  /** reply RawAddRecipients: friends added to a group DM, one PUT each through the client's REST module. */
  | { kind: 'addRecipients'; channelId: string; userIds: string[] }
  /** reply RawCreateGroupDM: a new group DM with friends, through the client's ensurePrivateChannel; a name set after. */
  | { kind: 'createGroupDM'; userIds: string[]; name?: string }
  /** Block, ignore, notes, your presence, sessions, your profile beyond the bio (self.ts). */
  | SelfHookCommand;

/** The hook's answer to addRecipients. */
export interface RawAddRecipients {
  /** In the group now. */
  added: string[];
  /** Refused, each with Discord's words or ours. */
  failed: { id: string; reason: string }[];
  /** The users added, for identity facts. */
  users: RawUser[];
  /** The group as the client's store has it after (null: gone from it). */
  channel: RawChannel | null;
}

/** The hook's answer to createGroupDM: as addRecipients answers, for the new group. */
export interface RawCreateGroupDM extends RawAddRecipients {
  channelId: string;
  /** Anything the owner should know (the group made, its name not taken). */
  notes?: string[];
}

// ------------------------------------------------------------ about and settings

/** A server role, from the client's role store. */
export interface RawRole {
  id: string;
  name: string;
  /** CSS colour, or null for none. */
  color?: string | null;
  /** Higher is more senior; @everyone is 0. */
  position: number;
  /** Shown apart in the member list. */
  hoist?: boolean;
  /** Given and taken by an integration or by boosting, never by hand. */
  managed?: boolean;
}

/** A loaded server member: who, and their role ids. */
export interface RawMember {
  user: RawUser;
  roles: string[];
  /** The colour the client shows their name in. */
  color?: string | null;
  /** Whether this account may use each permission on them, by the client's hierarchy check (null: it could not say). */
  manage?: Partial<Record<'kickMembers' | 'banMembers' | 'moderateMembers' | 'manageRoles', boolean | null>>;
  /** ISO time their timeout ends. */
  timeout_until?: string;
}

/** What this account may do where it is, by the client's own check. null: the client did not say. */
export type RawCan = Partial<Record<'createInvite' | 'manageChannels' | 'manageGuild' | 'sendMessages' | 'manageMessages' | 'manageRoles' | 'manageThreads' | 'pinMessages' | 'kickMembers' | 'banMembers' | 'moderateMembers' | 'muteMembers' | 'deafenMembers' | 'moveMembers' | 'useSoundboard', boolean | null>>;

/** The settings fields of a channel the hook adds to RawChannel. */
export interface RawAboutChannel extends RawChannel {
  nsfw?: boolean;
  rate_limit_per_user?: number;
  /** The @everyone overwrite denies Send Messages (here, or on a thread's parent). */
  everyone_denies_send?: boolean;
  /** Minutes before a new thread hides itself. */
  default_auto_archive_duration?: number | null;
  /** Voice: how many at once (0 none), and its bitrate. */
  user_limit?: number | null;
  bitrate?: number | null;
}

export interface RawAboutGuild extends RawGuild {
  owner_id?: string | null;
  owner?: RawUser | null;
  verification_level?: number | null;
  nsfw_level?: number | null;
  community?: boolean;
}

/** The hook's answer to `about`, read from the client's stores alone. */
export interface RawAbout {
  selfId: string | null;
  /** The conversation, or the category when the target is a section space. */
  channel?: RawAboutChannel;
  /** The server the target is, or is in. */
  guild?: RawAboutGuild;
  roles?: RawRole[];
  /** Members the client has loaded, at most 200. */
  members?: RawMember[];
  memberCount?: number | null;
  /** On the target itself (the channel, category or server). */
  can: RawCan;
  /** On the server, when the target is in one. */
  guildCan?: RawCan;
  /** This account's top role's position (null: none, or the client did not say). */
  top_position?: number | null;
  /** The server's boost tier, 0 to 3: how high a voice channel's bitrate may go. */
  premium_tier?: number;
}

/** The only fields `configure` may send. */
export interface RawAboutPatch {
  name?: string;
  topic?: string;
  rate_limit_per_user?: number;
  nsfw?: boolean;
  default_auto_archive_duration?: number;
  user_limit?: number;
  bitrate?: number;
  /** A server's. */
  description?: string;
  /** A server's icon, as a data URI. */
  icon?: string;
}

// ------------------------------------------------------------------- profiles

/** A connected account as the profile lists it. */
export interface RawConnectedAccount {
  /** "github", "steam", "twitter", ... */
  type: string;
  id?: string;
  name: string;
  verified?: boolean;
  /** The platform's name from the client's own table ("GitHub", "X"). Absent: the hook could not ask it. */
  label?: string;
  /** The link the client builds for it, when it builds one. */
  url?: string;
}

/** A server you share with them, and who they are there as far as the client has loaded them. */
export interface RawMutualGuild {
  id: string;
  name?: string;
  nick?: string | null;
  /** Their roles there, when the client has them as a member. */
  roles?: RawRole[];
  joined_at?: string | null;
}

/**
 * The hook's answer to `profile`: what the client's profile shows after its own fetch, from its stores, or from the
 * REST body when it has no such stores. null: the client did not say (not asked, or the fetch failed).
 */
export interface RawProfile {
  selfId: string | null;
  user: RawUser | null;
  bio?: string | null;
  pronouns?: string | null;
  /** Banner image hash. */
  banner?: string | null;
  /** The banner colour, as a number. */
  accent_color?: number | null;
  /** The custom status line. */
  custom_status?: { text?: string | null; emoji?: RawEmoji | null } | null;
  /** RelationshipStore type: 0 none, 1 friend, 2 blocked, 3 they asked you, 4 you asked them. */
  relationship?: number | null;
  /** When you became friends (ISO). */
  friend_since?: string | null;
  /** Their name before the new usernames ("name#1234"). */
  legacy_username?: string | null;
  connected_accounts?: RawConnectedAccount[];
  mutual_guilds?: RawMutualGuild[] | null;
  mutual_friends?: RawUser[] | null;
  mutual_friends_count?: number | null;
  /** When the person is you: your friends. */
  friends?: RawUser[];
  /** Why the profile fetch failed, when it did; the rest is what the stores still had. */
  error?: string;
  /** Badges on their profile: the client's id, words and icon hash. */
  badges?: { id: string | null; description: string | null; icon: string | null }[];
  /** Their profile's colours, as numbers. */
  theme_colors?: number[];
  /** The frame on their picture: its asset hash. */
  decoration?: string;
  /** Your note on them (never asked for yourself). null: none. */
  note?: string | null;
}

// --------------------------------------------------------------------- adding

/** A check Discord wants that only the owner can do, in the live view. The hook never answers one. */
export type RawCheck = 'captcha' | 'verify' | 'phone' | 'rules';

/** An invite as the client looked it up (InviteActions.resolveInvite), whitelisted. */
export interface RawInvite {
  code: string;
  /** 0 a server, 1 a group DM, 2 a friend invite. */
  type: number;
  guild?: {
    id: string;
    name: string;
    icon?: string | null;
    description?: string | null;
    /** 0 none ... 4 a verified phone. */
    verification_level?: number | null;
    /** Membership screening: new members agree to the server's rules before they post. */
    screening?: boolean;
  } | null;
  /** The channel it leads to; for a group DM, the group (recipients: their usernames, as the invite gives them). */
  channel?: { id: string; type: number; name?: string | null; icon?: string | null; recipients?: string[] } | null;
  inviter?: RawUser | null;
  expires_at?: string | null;
  members?: number | null;
  online?: number | null;
  /** Already in it, by the client's own stores: nothing to join. */
  joined?: { space?: string; conversation?: string } | null;
  /** For a friend invite: the inviter's RelationshipStore type. */
  relationship?: number | null;
}

/** The hook's answer to `person`, from the client's stores alone. user null: nobody the client has seen. */
export interface RawPerson {
  selfId: string | null;
  user: RawUser | null;
  /** RelationshipStore type. */
  relationship?: number | null;
  /** A DM with them is open already. */
  direct?: boolean;
}

/** The hook's answer to `inviteAccept`. */
export interface RawJoin {
  /** A check only the owner can do. Nothing was joined. */
  check?: RawCheck;
  invite?: RawInvite;
  /** In it already (or friends already): nothing was sent. */
  already?: boolean;
  /** A server joined, with its channels as the client now has them. */
  guild?: RawGuild | null;
  channels?: RawChannel[];
  /** The channel the invite leads to. */
  channelId?: string | null;
  /** Membership screening is still to do: the server's rules wait for the owner in the live view. */
  rules?: boolean;
  /** The server wants a verified phone before anyone posts, and this account has none. */
  phone?: boolean;
  /** A group DM joined. */
  channel?: RawChannel | null;
  /** A friend invite accepted: who, and the relationship now. */
  friend?: RawUser | null;
  relationship?: number | null;
}

/** The hook's answer to `friendAdd`, `friendAnswer` and `friendRemove`. */
export interface RawFriend {
  check?: RawCheck;
  /** Discord wants the accept confirmed first (code 80013), in its words; nothing was done. */
  confirm?: string;
  /** Who it was, once the client knows (a request by username names them only once Discord answers). */
  user?: RawUser | null;
  /** RelationshipStore type now. */
  relationship?: number | null;
}
