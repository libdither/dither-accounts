/**
 * Adapter <-> hub protocol.
 *
 * An adapter is one process per account (a Matrix sync loop, a signal-cli
 * daemon wrapper, a sandboxed Discord web client). It speaks only in
 * *native* IDs and sends idempotent facts; the hub maps them to stable hub
 * IDs, deduplicates objects seen by several accounts, and decides what
 * the user is notified about.
 *
 * Transport: WebSocket to ws://127.0.0.1:<hub>/adapter?account=<id>&token=<token>,
 * one JSON object per text frame. The hub passes these to spawned adapters:
 *
 *   DITHER_HUB_URL         ws://127.0.0.1:8460/adapter
 *   DITHER_ACCOUNT_ID      acc_...
 *   DITHER_ADAPTER_TOKEN   per-account secret for the WebSocket
 *   DITHER_ACCOUNT_DIR     private state dir (0700) for sessions, keys, profiles
 *   DITHER_ACCOUNT_CONFIG  JSON, non-secret account config (homeserver, phone, ...)
 *
 * Secrets the user typed in (passwords, tokens) are in $DITHER_ACCOUNT_DIR/secret.json.
 * Adapters may rewrite that file (e.g. swap a password for an access token).
 *
 * Every reference inside a fact (author, conversation, replyTo, ...) is a
 * native ID on the adapter's own network.
 */

import type { AboutChange, AboutTarget, PersonAbout, PersonRelationship } from './about.ts';
import type { AddAction, AddRef, RelationshipFact, RequestAnswer, RequestFact } from './add.ts';
import type { AttentionCapability, AttentionCommand } from './attention.ts';
import type { InteractCapability, InteractCommand, InteractEvent } from './apps.ts';
import type { PollCapability, PollCommand, PollUpdate } from './poll.ts';
import type { CallEffect, CallFact, CallInput, CallMode, CallState, StageAction, VoiceMember } from './call.ts';
import type { GateAnswer, ScheduledEventFact, SpaceGate } from './servers.ts';
import type { MessageModeration, ModAction, ReactionClear } from './moderation.ts';
import type { LinkPreviewOut } from './extra.ts';
import type { PostAct } from './feed.ts';
import type { AccountStatus, AttachmentKind, Attention, MessageKind, Network, ReactionStyle, Shape, SpaceKind, Variant } from './ontology.ts';
import type { SelfCapability, SelfCommand, SelfEvent } from './self.ts';
import type { VoiceFact } from './rich.ts';
import type { MediaCapability, MediaCommand, MediaEvent, VoiceOut } from './media.ts';
import type { ForumFact, ThreadFact, ThreadsCapability, ThreadsCommand } from './threads.ts';
import type { SendCapability, SendCommand, SendEvent } from './sending.ts';

/** How far a message got with someone: their device has it, they read it, they played it (a voice note, a video). */
export type ReceiptState = 'delivered' | 'read' | 'played';

export type Capability =
  | 'send'
  | 'history'
  | 'react'
  | 'edit'
  | 'redact'
  | 'markRead'
  | 'typing'
  | 'threads'
  | 'media'
  /** Sending files, not just showing them. */
  | 'sendMedia'
  /** Reads and writes end-to-end encrypted conversations. Without it the hub refuses writes to encrypted Matrix rooms. */
  | 'e2ee'
  /** Starting a direct conversation with someone you have none with. */
  | 'openDirect'
  | 'liveView'
  /** Voice calls (see call.ts). */
  | 'calls'
  /** Says when calls ring you, go on and end, in conversations you are not calling in from here (the `callState` event). */
  | 'callStates'
  /** Stops a call ringing for you, the network's own way (the `declineCall` command). */
  | 'declineCall'
  /** A call joined in a direct or group conversation rings the others there (the call join's `ring`). */
  | 'ringCalls'
  /**
   * Says who is in which voice channel when you are not in it (the `voice` event): only what the network's client was
   * sent anyway, no request of its own. Kept only with the adversarial `voice` setting on.
   */
  | 'voicePresence'
  /** In a call: one person's volume and mute for this account only (the call's `local` op), and their values in its state. */
  | 'callVolume'
  /** In a call: the account's own client takes the device's noise suppression and sensitivity (the call's `input` op). */
  | 'callInput'
  /** In a stage call: speakers, audience, raised hands and the topic in its state, and the call's `stage` op. */
  | 'stage'
  /** In a call: the sounds this account may play (the call's `sounds` and `sound` ops), and effects others send (the call event's `effect`). */
  | 'soundboard'
  /** Forwarding a message it can read into another conversation, the network's own way (the `forward` command). */
  | 'forward'
  /** Reads a conversation's or space's settings, members and permissions (the `about` command, about.ts). */
  | 'about'
  /** Changes them (the `configure` command), where the About says this account may. */
  | 'configure'
  /** Reads what the network says about one person: bio, mutual spaces and friends (the `profile` command, about.ts PersonAbout). */
  | 'profile'
  /** Reads a post's thread: what it answers and its replies (the `post` command, feed.ts PostThread). */
  | 'posts'
  /** Likes and reposts a post, and takes it back (the `postAct` command). */
  | 'postActions'
  /** Writes a post: a reply, a quote, a new one (the `publish` command, compose.ts POST_RULES). */
  | 'publish'
  /** Says who liked or reposted a post (the `postReactors` command, feed.ts ReactorsPage). */
  | 'postReactors'
  /** Translates a post of its network, as the network's own "Translate post" does (the `translate` command). */
  | 'translate'
  /** Changes the account's own profile: its bio/About (the `setProfile` command). */
  | 'editProfile'
  /**
   * Says who it sees as a member of a space (the `members` event). Only what the network's own client loaded anyway:
   * no request of its own.
   */
  | 'members'
  /** Says what an invite, address, name or handle is without acting on it (the `resolve` command, add.ts). */
  | 'resolve'
  /** Joins a space, group, channel or room, or asks to (the `add` command with join or ask). */
  | 'join'
  /** Adds someone: a friend request, a follow, a contact (the `add` command with friend, follow or contact). */
  | 'connect'
  /** Lists the requests waiting on you and answers them (the requests events, the `answer` command). */
  | 'requests'
  /** Says who the account is friends with, has asked, blocked, has as a contact or follows (the relationships events). */
  | 'relationships'
  /** Ends one of those: unfriend, cancel a request you sent, unblock, remove a contact, unfollow (the `remove` command). */
  | 'disconnect'
  /** Adds people to a group the account is in (the `addMembers` command), where its About's `adding` says it may. */
  | 'addMembers'
  /** Makes a new group with people the account knows (the `createGroup` command, about.ts GROUP_RULES). */
  | 'createGroup'
  /** Searches messages on the network's own servers, one place at a time (the `search` command, jobs.ts NetworkQuery). */
  | 'search'
  /** Lists a space's members on request, by name prefix (the `walkMembers` command): an active walk, not only what was seen. */
  | 'walkMembers'
  /** `mentionables`: who a conversation can ping, for the @ picker (mentions.ts). */
  | 'mentionables'
  /** Bodies keep `<@person:per_…>` and `<@identity:idn_…>` as written: the hub does not lower them (docs/mentions.md). */
  | 'personRefs'
  /** Lists a channel's threads, archived ones too (the `threads` command), so an index job finds threads nobody opened. */
  | 'listThreads'
  /** Says a space's scheduled events (the scheduledEvent(s) events) and reads them fresh (the `scheduledEvents` command, servers.ts). */
  | 'events'
  /** Says Interested in a scheduled event, or takes it back (the `rsvp` command). */
  | 'rsvp'
  /** Leaves a conversation or space (the `leave` command), where its About's `leaving` says it may. */
  | 'leave'
  /** Reads what a space asks before you are in (rules, an application, onboarding) and answers it (`gate`, `answerGate`). */
  | 'gates'
  /** Lists invite links and makes them with an expiry and a use limit (About.invite.links, options; `configure` invite). */
  | 'inviteLinks'
  /** Sets your own nickname in a space (About.nick, the `setNick` command). */
  | 'nick'
  /**
   * Shows your safety number with each person and whether you verified it (PersonAbout.safety), and marks it verified
   * or clears that (the `verify` command). A change of their key comes as a system line in your 1:1 (Signal).
   */
  | 'safetyNumbers'
  /** Blocks and unblocks people and groups outside a request (the `block` command, About.blocked). */
  | 'block'
  /** Keeps your private nickname and note for someone on the network too (IdentityFact nickname and note, the `setContact` command). */
  | 'contactNotes'
  /** Tells the sender you played a voice note or opened a video of theirs (the `viewed` command; Signal's viewed receipt). */
  | 'viewed'
  /** Sends a link preview with a message (`send`'s `preview`). Advertised only while the account's own setting allows previews. */
  | 'linkPreviews'
  /** Resets the encrypted session with someone in a direct conversation (the `resetSession` command; Signal's end session). */
  | 'resetSession'
  /**
   * Moderates where the account may (moderation.ts): About.moderation and the `moderate` and `bans` commands for
   * members, ReactionContext.moderation, `redact` with `moderator` and `clearReactions` for others' messages.
   */
  | 'moderate'
  /** Shows members' labels in groups (AboutMember.label) and sets your own (About.label, the `setLabel` command; Signal). */
  | 'memberLabels'
  /** Changes a group's or server's picture through `configure` with key 'avatar' (a file:// URL the hub gives it). */
  | 'setPicture'
  /** Mentions found late, native mutes, unread by hand, many read at once (attention.ts). */
  | AttentionCapability
  /** Bots' buttons, selects, slash commands and forms (apps.ts). */
  | InteractCapability
  /** Stickers, voice messages, view-once, stories (media.ts). */
  | MediaCapability
  /** Polls read, voted in, made and ended; pins changed (poll.ts). */
  | PollCapability
  /** Silent sends, replies without a ping, previews taken off, saved messages, the network's scheduled messages (sending.ts). */
  | SendCapability
  /** The account's own self and block, ignore, notes (self.ts, docs/account-self.md). */
  | SelfCapability
  /** Following threads, starting threads and posts, archiving, publishing, running a group (threads.ts). */
  | ThreadsCapability;

// ---------------------------------------------------------------- facts

export interface IdentityFact {
  nativeId: string; //      Discord snowflake | Signal ACI uuid | Matrix @user:server
  handle?: string; //       username | phone number | @user:server
  displayName?: string;
  avatarUrl?: string; //    https://, mxc://, or file:// (see MediaUrl)
  isBot?: boolean;
  isSelf?: boolean;
  /** In the address book / friends list. Contacts get a Person, strangers in big channels do not. */
  contact?: boolean;
  /**
   * Your private nickname for them as the network keeps it (Signal's nickname, capability 'contactNotes'); '' when
   * none. Left out when the adapter did not read it. `displayName` is then their own or address-book name, without it.
   */
  nickname?: string;
  /** Your private note about them as the network keeps it (Signal's contact note, capability 'contactNotes'); '' when none. */
  note?: string;
}

/** Someone seen as a member of a space. The identity fact for `who` is emitted first. */
export interface MemberFact {
  /** Native identity id. */
  who: string;
  /** ms epoch: when they joined the space, where the network says. */
  joinedAt?: number;
  /** Role names in the space. */
  roles?: string[];
  /** Their nickname in the space. */
  nick?: string;
}

export interface SpaceRef {
  nativeId: string;
  /** Sort key within the parent: Discord `position`, Matrix `order`. Compared as strings, so zero-pad numbers. */
  position?: string;
}

/**
 * The network's own notification setting for a place. An empty object says nothing is set there: an adapter sends
 * it to clear a mute it told before (a fact without `mute` leaves the one the hub has).
 */
export interface NativeMute {
  level?: 'all' | 'mentions' | 'none';
  /** ms epoch; muted until then. */
  until?: number;
  /** Muted outright (Discord's Mute), rather than set to notify on nothing. */
  muted?: boolean;
  /** A space's: @everyone and @here do not notify there (Discord's "Suppress @everyone and @here"). */
  suppressEveryone?: boolean;
  /** A space's: role mentions do not notify there. */
  suppressRoles?: boolean;
}

export interface SpaceFact {
  nativeId: string; // Discord guild or category snowflake | Matrix space room id
  kind: SpaceKind;
  name: string;
  topic?: string;
  iconUrl?: string;
  /** Parent spaces. Discord category -> its guild; Matrix subspace -> every space that lists it. */
  parents?: SpaceRef[];
  mute?: NativeMute;
}

export interface ConversationFact {
  /**
   * Discord channel snowflake | Matrix room id | Matrix thread "<roomId>|<rootEventId>" |
   * Signal group "group:<base64 id>" | Signal 1:1 "dm:<selfAci>:<peerAci>"
   */
  nativeId: string;
  shape: Shape;
  variant?: Variant;
  /** Omit for directs: the UI names them after the peer. */
  name?: string;
  topic?: string;
  avatarUrl?: string;
  encrypted?: boolean;
  archived?: boolean;
  /** Threads: the conversation they hang off. */
  parentConversation?: string;
  /** Containing spaces (a graph: a Matrix room may be in several). */
  spaces?: SpaceRef[];
  /** Identity native IDs. Only for direct, group and self; big channels skip this. */
  participants?: string[];
  mute?: NativeMute;
  lastMessageAt?: number;
  /** A thread's own facts: whether you follow it, its tags, who started it (threads.ts). */
  thread?: ThreadFact;
  /** A forum or media channel's tags and default order (threads.ts). */
  forum?: ForumFact;
}

/**
 * Canonical message body: a Discord-flavoured Markdown subset.
 *   **bold** *italic* __underline__ ~~strike~~ `code` ```fenced``` ||spoiler|| > quote
 *   mentions as <@identityNativeId>, rooms as <#conversationNativeId>, links bare or [text](url)
 * Adapters convert from Matrix HTML / Signal body ranges into this.
 */
export interface MessageFact {
  /** Discord snowflake | Matrix event id | Signal "<authorAci>:<sentTimestamp>" */
  nativeId: string;
  conversation: string;
  author: string;
  ts: number;
  editedTs?: number;
  kind?: MessageKind;
  body: string;
  replyTo?: string;
  /** This message is the root of that thread conversation. */
  threadRoot?: string;
  mentionsSelf?: boolean;
  /** With mentionsSelf: the mention was @everyone or @here, not you by name. It notifies, but is not addressed to you. */
  mentionsAll?: boolean;
  attachments?: AttachmentFact[];
  /** Full reaction snapshot (backfill). Live changes use the `reaction` event. */
  reactions?: ReactionFact[];
  /** This message forwards another, as the network marks it. body and attachments are the forwarded content. */
  forward?: ForwardFact;
  /** Its sender sent it silently (Discord's @silent): it may show and count, but it never alerts (docs/rich-messages.md). */
  silent?: boolean;
  /** Embeds as `embeds` (api.ts EmbedView), and the keys of rich.ts RichExtra. */
  extra?: Record<string, unknown>;
}

/**
 * Where a forwarded message came from, as far as the network says. Discord names the channel, message and
 * server but not the author; a Matrix forward from dither-chat names all of it.
 */
export interface ForwardFact {
  conversation?: string;
  message?: string;
  /** The original's community, when the conversation alone does not say (a Discord guild id). */
  space?: string;
  author?: string;
  authorName?: string;
  ts?: number;
}

/** A custom emoji. Reactions refer to it by key; the hub keeps a catalog per network. */
export interface CustomEmojiFact {
  key: string; //     Discord "name:id" | Matrix mxc://
  name: string; //    shortcode, without colons
  url: MediaUrl;
  animated?: boolean;
}

export interface ReactionFact {
  key: string;
  style?: ReactionStyle;
  /** Who reacted, as far as the network says. */
  authors: string[];
  /** The network's total, when it does not name everyone (Discord). Omit when authors is the full list. */
  count?: number;
  /** Super reactions: the colours of the effect, as CSS hex. */
  colors?: string[];
  emoji?: CustomEmojiFact;
}

/** What this account can react with here. Network-wide rules are in REACTION_RULES. */
export interface ReactionContext {
  canReact: boolean;
  /** Why not, or a limit worth knowing. Shown in the picker. */
  reason?: string;
  /** Only reactions already on the message can be added to (Discord without Add Reactions). */
  existingOnly?: boolean;
  /** Custom emoji usable here: this server first, then others, Matrix image packs. */
  custom: { id: string; name: string; icon?: MediaUrl; emoji: CustomEmojiFact[] }[];
  /** Absent: this network has no super reactions. */
  super?: { available: boolean; reason?: string };
  /** What this account may do to others' messages here (capability 'moderate'). Absent: nothing. */
  moderation?: MessageModeration;
}

/**
 * A URL the hub can resolve: https:// is fetched directly, file:// is served
 * if it lives under the account dir, anything else (mxc://, attachment ids)
 * is resolved by sending the adapter a `fetchMedia` command.
 */
export type MediaUrl = string;

export interface AttachmentFact {
  nativeId?: string;
  kind: AttachmentKind;
  mime?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  url: MediaUrl;
  /** Its description (alt text), shown with it and searched (docs/rich-messages.md). */
  alt?: string;
  /** Marked as a spoiler: drawn blurred until clicked. */
  spoiler?: boolean;
  /** The network flagged it as explicit: drawn blurred until clicked, as a spoiler. */
  explicit?: boolean;
  /** A voice message (rich.ts VoiceFact): drawn as a player with its waveform. */
  voice?: VoiceFact;
}

/** A file to send, in the hub's spool. The adapter reads it during the send; the hub deletes it afterwards. */
export interface OutgoingAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** Send it as the network's voice message (capability 'sendVoice', media.ts): the only file of its send. */
  voice?: VoiceOut;
}

/** What the `setProfile` command changes: only the fields given (see it there). */
export interface ProfileChange {
  bio?: string;
  name?: string;
  emoji?: string;
  avatar?: OutgoingAttachment | null;
  username?: string | null;
  /** Your pronouns ('' clears them). */
  pronouns?: string;
  /** The picture across the top of your profile, or null to remove it (Discord: Nitro only). */
  banner?: OutgoingAttachment | null;
  /** The colour across the top when there is no banner picture, CSS hex, or null. */
  accent?: string | null;
}

/** What openDirect answers. The conversation fact has already been emitted when this arrives. */
export interface OpenDirectResult {
  /** Native id of the conversation. */
  conversation: string;
  /** It was there already, and nothing was created. */
  existed: boolean;
  /** Nothing exists on the network until the first message (Signal). */
  startsAtFirstSend?: boolean;
}

// ---------------------------------------------------------------- adapter -> hub

/**
 * The adapter↔hub protocol's version, sent in every hello (adapter-client.ts adds it). Bump it when an event or
 * command changes in a way the other side cannot read; the hub flags an account whose adapter speaks another one.
 * Adapters live in dither-accounts too (docs/accounts.md), so the two sides can be updated at different times.
 */
export const PROTOCOL_VERSION = 1;

/** One link of an account's dependency chain (AdapterEvent status.layers). */
export interface StatusLayer {
  /** Short and stable: 'browser', 'extension', 'signed in', 'API key'. */
  name: string;
  /** ok; waiting (not there yet, expected to come); failed; off (not used here). */
  state: 'ok' | 'waiting' | 'failed' | 'off';
  /** One line: what it is, or why not ("33 of 33 hooks", "no SAPISID cookie"). */
  note?: string;
}

export type AdapterEvent =
  | { t: 'hello'; network: Network; version: string; capabilities: Capability[]; protocol?: number }
  | {
      t: 'status';
      status: AccountStatus;
      /** null clears it. */
      attention?: Omit<Attention, 'since'> | null;
      /** The account's own identity, once known. */
      self?: IdentityFact;
      /**
       * Live view endpoint for the hub (or dither-accounts' manager) to proxy: the sandbox's VNC, on a Unix socket owned
       * by this user and on no TCP port (a VNC without a password on 127.0.0.1 is open to every local process and to
       * any web page in a browser on the machine). Whoever proxies it never passes the path on.
       */
      liveView?: { vncSocket: string; width: number; height: number } | null;
      /** Non-secret facts about the session, for the account's page in dither-accounts (the hub ignores them). */
      details?: Record<string, string | number | boolean | null>;
      /**
       * What the account rests on, outermost first (display, browser, extension, signed in, ...), for the dependency
       * chain on its page in dither-accounts: the first layer that is not `ok` is why it is not working. The hub
       * ignores it. Each status that has it sends the whole chain.
       */
      layers?: StatusLayer[];
    }
  | { t: 'identity'; identity: IdentityFact }
  | { t: 'space'; space: SpaceFact }
  | { t: 'conversation'; conversation: ConversationFact }
  | { t: 'leave'; kind: 'space' | 'conversation'; nativeId: string }
  /**
   * Create or replace (edits re-send the whole message). live=false marks backfill: no notifications. `late` (with
   * live=false): a message that concerns you, heard late from the network's own list (Discord's recent mentions,
   * capability 'mentions'); new to the hub and younger than LATE_NEWS_MS by its own ts, it is triaged as a live one.
   */
  | { t: 'message'; message: MessageFact; live?: boolean; late?: boolean }
  /** A message is gone. `reason: 'expired'`: its disappearing timer ran out, rather than someone deleting it. */
  | { t: 'delete'; conversation: string; nativeId: string; reason?: 'expired' }
  | { t: 'reaction'; conversation: string; message: string; author: string; key: string; remove?: boolean; style?: ReactionStyle; colors?: string[]; emoji?: CustomEmojiFact }
  /** A moderator removed every reaction on a message, or every one with this key. */
  | { t: 'reactionsCleared'; conversation: string; message: string; key?: string }
  /**
   * Read state as the network reports it. Counts override the hub's own tally when given. `manual`: you marked it
   * unread on the network, so the read point moves back to upToTs (otherwise it only moves forward).
   */
  | { t: 'read'; conversation: string; upToTs: number; unread?: number; mentions?: number; manual?: boolean }
  /**
   * History the hub keeps (docs/history.md). `by` is who did it and `ts` when, where the network says; else the hub
   * uses the time it heard.
   *
   * A message pinned or unpinned. */
  | { t: 'pin'; conversation: string; message: string; pinned: boolean; by?: string; ts?: number }
  /** Votes in a poll as they come, or the poll closing (capability 'polls', poll.ts PollUpdate). */
  | ({ t: 'pollUpdate' } & PollUpdate)
  /** Someone given a role or losing one: a Discord role by name, a Matrix power level ("Admin", "Moderator"), admin on Signal or WhatsApp. */
  | { t: 'role'; target: AboutTarget; member: string; role: string; given: boolean; color?: string; by?: string; ts?: number }
  /**
   * Someone's custom status or About as it is now (no text and no emoji: cleared). Only for people the account follows
   * (friends, contacts, people it has a DM with), never everyone in a big server.
   */
  | { t: 'customStatus'; who: string; text?: string; emoji?: string; ts?: number }
  /**
   * Someone's presence as the network reports it now. Only for people the account follows (friends, contacts,
   * people it has a DM with), never everyone in a big server, as for customStatus. `devices`: where they are on.
   */
  | { t: 'presence'; who: string; state: 'online' | 'idle' | 'dnd' | 'offline'; devices?: ('desktop' | 'mobile' | 'web')[]; ts?: number }
  /**
   * People seen as members of a space (a Discord guild's native id).
   * - source 'seen' (passive): members the network's client loaded anyway (the member list in view, message
   *   authors' member objects, chunks it asked for itself). It makes no request of its own.
   * - source 'walk' (active): members from a walk of the member list: an index job's `walkMembers` (hub jobs.ts).
   * `total`: the network's member count, and `online` its online count, when known. `complete`: this walk reached
   * the end of what the network will list. For a big Discord guild that may be only the online members, so complete
   * means "all the network shows", not "everyone".
   * Batches: at most 500 members per event. Kept only with the adversarial `members` setting on (docs/history.md).
   */
  | { t: 'members'; space: string; members: MemberFact[]; source: 'seen' | 'walk'; total?: number; online?: number; complete?: boolean; ts?: number }
  /** Someone else got, read or played (a voice note, a video) these messages. Matrix: read up to the last of them. */
  | { t: 'receipt'; conversation: string; messages: string[]; who: string; state: ReceiptState; ts: number }
  /**
   * Someone is typing, or (`stop`) stopped. Of the moment: the hub relays it and keeps nothing (typing.ts).
   * `ttl`: how long a start lasts without another, in ms (default TYPING_TTL); a network whose clients refresh less
   * often than Discord's says how long its own clients wait. `name`: what to call a typer the hub may never have
   * heard of (a stranger in a big channel), so it need not store an identity for them.
   */
  | { t: 'typing'; conversation: string; author: string; stop?: boolean; ttl?: number; name?: string }
  /** A call this hub started: bridge signalling for the device, the call's state, or its end. */
  | { t: 'call'; call: string; signal?: unknown; state?: CallState; ended?: string; effect?: CallEffect }
  /** A call ringing you, going on, or over (capability 'callStates', call.ts CallFact): the whole fact each time. */
  | { t: 'callState'; call: CallFact }
  /**
   * Everyone in one voice channel now (capability 'voicePresence'), replacing what the hub had for it; [] is nobody.
   * `space`: its guild. Only what the network's client was sent anyway. Kept only with the adversarial `voice` setting.
   */
  | { t: 'voice'; conversation: string; space?: string; members: VoiceMember[]; ts?: number }
  /** A voice channel's status line ("playing chess"), set by whoever is in it; null clears it. Not about anyone: kept like a topic. */
  | { t: 'voiceStatus'; conversation: string; text: string | null }
  /**
   * Requests waiting on you (capability 'requests', add.ts): the account's whole list, sent after connect. It replaces
   * the hub's; until one comes the hub keeps what it had, so a network that knows its list only later loses nothing.
   */
  | { t: 'requests'; requests: RequestFact[] }
  /** One request new or changed. */
  | { t: 'request'; request: RequestFact }
  /** A request answered here or elsewhere, withdrawn, or expired. */
  | { t: 'requestGone'; nativeId: string }
  /**
   * What the network showed about someone without being asked (X: the people in your notifications, whose profile
   * comes with each one). Their identity fact comes first. The hub keeps it as it keeps an answer to `profile`, unless
   * it holds one newer; `ts` is when it was seen. Never with `posts`.
   */
  | { t: 'personAbout'; who: string; about: PersonAbout; ts: number }
  /**
   * The account's friends, requests it sent, blocks, contacts and follows (capability 'relationships', add.ts), sent
   * after connect: the whole list, replacing the hub's. Incoming requests are not in it; they are RequestFacts.
   */
  | { t: 'relationships'; list: RelationshipFact[] }
  /** One changed; relationship 'stranger': it is gone. */
  | { t: 'relationship'; fact: RelationshipFact }
  /** A space's scheduled events, the whole list (capability 'events'), replacing what the hub kept for this account. */
  | { t: 'scheduledEvents'; space: string; events: ScheduledEventFact[] }
  /** One scheduled event new or changed. */
  | { t: 'scheduledEvent'; event: ScheduledEventFact }
  /** One gone (deleted; not merely over or cancelled, which are statuses). */
  | { t: 'scheduledEventGone'; space: string; nativeId: string }
  /** What a space asks of this account now (capability 'gates'); null: nothing (passed, approved, or left). */
  | { t: 'gate'; space: string; gate: SpaceGate | null }
  /** saved, unsaved, reminderDue (sending.ts). */
  | SendEvent
  | { t: 'reply'; id: string; ok: true; result?: unknown }
  | { t: 'reply'; id: string; ok: false; error: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: unknown }
  /** interaction, appModal (apps.ts). */
  | InteractEvent
  /** story, storyGone (media.ts). */
  | MediaEvent
  /** Notices, own presence and settings, whom it ignores (self.ts). */
  | SelfEvent;

// ---------------------------------------------------------------- hub -> adapter

/** The `history` command's reply. */
export interface HistoryResult {
  count: number;
  /** The start of the conversation was reached. */
  done: boolean;
  /** The ts of the page's oldest message, when there was one. */
  oldest?: number;
}

/** The `walkMembers` command's reply. */
export interface WalkResult {
  count: number;
  /** The network's member count, when known. */
  total?: number;
  /** A `recent` page only: where the next page starts, or null at the end. Absent: no such list here. */
  next?: string | null;
}

/** The `threads` command's reply. */
export interface ThreadsResult {
  count: number;
  /** More after these: ask again with offset + count. */
  more: boolean;
  /** The network is still indexing this channel's threads (Discord's 202): ask the same again after this long. */
  retryAfterMs?: number;
  /** The page's threads, native ids in the network's order (threads.ts ThreadPageView); absent from an older adapter. */
  ids?: string[];
}

/** What a network search asks for, from the hub's query language (search.ts) in the network's terms. */
export interface NetworkQuery {
  /** Words and phrases as typed ("quoted" kept), without operators. */
  text: string;
  /** Native identity ids. */
  authors?: string[];
  mentions?: string[];
  /** Native conversation ids, inside a space scope. */
  in?: string[];
  has?: string[];
  /** ms, inclusive and exclusive as search.ts. */
  after?: number;
  before?: number;
  sort?: 'newest' | 'oldest' | 'relevance';
}

/** The `search` command's reply. */
export interface NetworkSearchResult {
  /** Native message ids of the hits, in the network's order. Their message facts came before this reply. */
  hits: string[];
  /** How many the network says match in all, when it says. */
  total: number | null;
  /** Pass as `offset` for the next page; null at the end. */
  next: number | null;
  /** The network is still indexing this place (Discord answers 202): ask again after this long. */
  retryAfterMs?: number;
}

export type AdapterCommand =
  /** Call lab only (scripts/call-lab.ts, DITHER_LAB=1): a command for the lab probe in the sandbox. */
  | { t: 'lab'; id: string; lab: { op: string; [k: string]: unknown }; timeout?: number }
  /** reply.result: { nativeId } of the sent message if known (the echo still arrives as a message fact). */
  | {
      t: 'send';
      id: string;
      conversation: string;
      body: string;
      replyTo?: string;
      attachments?: OutgoingAttachment[];
      /** capability 'linkPreviews' */
      preview?: LinkPreviewOut;
      /** A sticker from the `stickers` reply, by its id (capability 'sendStickers'); body may be empty with it. */
      sticker?: string;
      /** The files open once (capability 'sendViewOnce'). */
      viewOnce?: boolean;
      /** capability 'silentSend': nobody is notified of it (Discord's @silent). Left out by the hub otherwise. */
      silent?: boolean;
      /** capability 'replyMention', with replyTo: false, the reply does not ping its author. Absent: the network's default (it pings). */
      mentionReplied?: boolean;
    }
  /**
   * Forward a message this account can read, the network's own way (capability 'forward'). `note` goes with it,
   * as the network's own client would send one. reply.result: { nativeId } of the forward, or { fallback: reason }
   * when this pair of conversations has no native forward (the hub then sends the content again itself).
   */
  | { t: 'forward'; id: string; conversation: string; source: { conversation: string; message: string }; note?: string }
  /**
   * Open or find the direct conversation with this person, without sending anything.
   * peer: Discord user id | Matrix @user:server | Signal ACI or +phone. reply.result: OpenDirectResult
   */
  | { t: 'openDirect'; id: string; peer: string }
  /**
   * Backfill older messages as message facts with live=false; reply.result: HistoryResult. `oldest`, the ts of the
   * page's oldest message, lets the hub's index jobs (jobs.ts) know exactly what a page covered.
   */
  | { t: 'history'; id: string; conversation: string; beforeTs?: number; limit: number }
  /**
   * Search the network's own servers, one request (capability 'search'): Discord's guild or channel search,
   * Matrix's /search. `scope` is a space (a guild) or a conversation, native ids, or everything the account sees
   * where the network searches that in one request (Matrix). The hits come first as message facts (live=false), with
   * the conversations, threads and authors they need, then reply.result: NetworkSearchResult.
   */
  | { t: 'search'; id: string; scope: { kind: 'space' | 'conversation'; id: string } | { kind: 'all' }; query: NetworkQuery; offset?: number; limit?: number }
  /**
   * Members of a space, one request (capability 'walkMembers'). A members event with source 'walk' first, then
   * reply.result: WalkResult.
   * - By name: those whose name starts with `query`, at most `limit`. Never '': a Discord user account may not ask for
   *   everyone. The hub widens a prefix that came back full (jobs.ts), so the adapter asks once and does not walk.
   * - `recent`: a page of the most recently joined members instead (Discord's op 35, its 10,000 newest; `query` is
   *   ignored), from `after`, the page before's `next`. An adapter without such a list answers without `next`, and
   *   the hub walks by name.
   */
  | { t: 'walkMembers'; id: string; space: string; query: string; limit: number; recent?: boolean; after?: string }
  | { t: 'mentionables'; id: string; conversation: string; query: string; limit: number }
  /**
   * A page of a channel's threads, newest activity first (capability 'listThreads'): the active ones, or with `archived`
   * the archived ones. Discord's user route is DiscordChatExporter's: /channels/{id}/threads/search. Conversation
   * facts for the threads first (each with parentConversation), then reply.result: ThreadsResult.
   */
  | { t: 'threads'; id: string; conversation: string; archived: boolean; offset: number; /** Only private archived threads this account is in (capability 'myThreads'). */ mine?: boolean }
  | { t: 'markRead'; id: string; conversation: string; upTo: string }
  /**
   * You played a voice note or opened a video in someone else's message (capability 'viewed'): tell them, the way the
   * network's own client would. The adapter sends nothing where its rules say not to (a message request, read receipts
   * off). reply.result: { sent: boolean }
   */
  | { t: 'viewed'; id: string; conversation: string; message: string }
  /** Reset the encrypted session in a direct conversation (capability 'resetSession'). reply.result: {} */
  | { t: 'resetSession'; id: string; conversation: string }
  /** You are typing here, or (`stop`) no longer: say so on the network, the way its own client would. Best effort. */
  | { t: 'typing'; id: string; conversation: string; stop?: boolean }
  | { t: 'react'; id: string; conversation: string; message: string; key: string; remove?: boolean; style?: ReactionStyle; emoji?: CustomEmojiFact }
  /** reply.result: ReactionContext */
  | { t: 'reactionContext'; id: string; conversation: string; message?: string }
  /** Name the people behind a total: identity facts first, then reply.result: { authors: string[] } */
  | { t: 'reactors'; id: string; conversation: string; message: string; key: string; style?: ReactionStyle }
  | { t: 'edit'; id: string; conversation: string; message: string; body: string }
  /**
   * Delete a message for everyone. `moderator` (capability 'moderate'): it is someone else's, deleted as an admin or
   * moderator may (Discord's Manage Messages, Signal's admin delete); the adapter checks it may first.
   */
  | { t: 'redact'; id: string; conversation: string; message: string; moderator?: true }
  /**
   * Take reactions off a message as a moderator (capability 'moderate', ReactionContext.moderation.reactions): all of
   * them, one emoji's (`key`), or one person's (`key` and `who`, a native identity id). reply.result: {}
   */
  | ({ t: 'clearReactions'; id: string; conversation: string; message: string } & ReactionClear)
  /**
   * One moderating action on a group's or server's members (capability 'moderate', moderation.ts), checked by the hub
   * against a fresh About.moderation. reply.result: the About as it now stands.
   */
  | { t: 'moderate'; id: string; target: AboutTarget; action: ModAction }
  /** Who is banned from a server, one read as its own Bans list makes it (capability 'moderate'). Identity facts first, then reply.result: BansResult. */
  | { t: 'bans'; id: string; target: AboutTarget }
  /**
   * Your own member label in a group, '' to clear it (capability 'memberLabels', checked against memberLabelProblem).
   * reply.result: the About as it now stands.
   */
  | { t: 'setLabel'; id: string; conversation: string; text: string; emoji?: string }
  /** reply.result: { mime: string, base64: string } */
  | { t: 'fetchMedia'; id: string; url: MediaUrl }
  /** Settings, members and permissions of a conversation or space. Identity facts for members first, then reply.result: About */
  | { t: 'about'; id: string; target: AboutTarget }
  /**
   * Change one setting (capability 'configure'). The hub has checked the change against ABOUT_RULES and a fresh
   * About's canEdit. The adapter emits the conversation or space fact again if its name or topic changed.
   * reply.result: the About as it now stands.
   */
  | { t: 'configure'; id: string; target: AboutTarget; change: AboutChange }
  /**
   * What the network says about one person (capability 'profile'): `who` is their native identity id (not `id`, the
   * request's). Asked only when someone opens their profile. Identity facts for anyone it names first, then
   * reply.result: PersonAbout
   */
  | { t: 'profile'; id: string; who: string }
  /**
   * One post's thread (capability 'posts', docs/feed.md "Threads"): `post` is the network's id for the post. `cursor`,
   * from an earlier answer's `more`, asks for more replies. Asked only when someone opens the post; the network is
   * told nothing else (nothing is liked, viewed or marked). Identity facts for every author first, then
   * reply.result: PostThread
   */
  | { t: 'post'; id: string; post: string; cursor?: string }
  /**
   * Like, repost, or take either back (capability 'postActions'): what the network's own buttons do, nothing else.
   * Sent only when you press one. reply.result: PostViewer, how the post stands after.
   */
  | { t: 'postAct'; id: string; post: string; act: PostAct }
  /**
   * Write a post (capability 'publish'): `replyTo` a post's id for a reply, `quote` a post's id to quote it (X: the
   * post's link as its attachment), neither for a new post. `text` has been checked against POST_RULES on the hub.
   * Sent only when you press Post. Identity facts first, then reply.result: PostFact, the post as the network made it.
   */
  | { t: 'publish'; id: string; text: string; replyTo?: string; quote?: string }
  /**
   * Who liked (`kind` 'like') or reposted ('repost') a post, a page (capability 'postReactors'). X shows who liked a post
   * only to its author. Identity facts first, then reply.result: ReactorsPage.
   */
  | { t: 'postReactors'; id: string; post: string; kind: 'like' | 'repost'; cursor?: string }
  /**
   * A post in another language, translated by the network itself into `to` (capability 'translate'; X: the
   * "Translate post" link's call). `lang`: what the network said the post is in. reply.result: NetworkTranslation.
   */
  | { t: 'translate'; id: string; post: string; to: string; lang?: string }
  /**
   * Change the account's own profile (capability 'editProfile'). Only the fields given change. `bio`: the bio or
   * About text ('' clears it). The adapter checks the network's limit (about.ts BIO_LIMIT) and fails with a plain
   * error past it. reply.result: PersonAbout of the account itself as it now stands.
   *
   * The other fields are offered only where that PersonAbout's `editable` lists them: `name` your profile name,
   * `emoji` the emoji beside your bio (Signal's About emoji, '' clears), `avatar` a picture in the hub's spool (null
   * removes yours), `username` your username (Signal picks its number: name.12; null deletes it), `pronouns`,
   * `banner` (a picture in the spool, or null) and `accent` (a colour across the top of your profile, or null).
   */
  | { t: 'setProfile'; id: string; change: ProfileChange }
  /**
   * reply.result for join: { direct?: DirectVoiceSession }. One call per account at a time. `ring` (capability
   * 'ringCalls'): in a direct or group conversation, ring the others as the network's own call button does.
   */
  | { t: 'call'; id: string; call: string; op: 'join'; conversation: string; mode: CallMode; muted?: boolean; deafened?: boolean; ring?: boolean; input?: CallInput }
  /** Stop a call ringing for you (capability 'declineCall'): `call` is the CallFact's nativeId. reply.result: {} */
  | { t: 'declineCall'; id: string; conversation: string; call: string }
  | { t: 'call'; id: string; call: string; op: 'leave' }
  | { t: 'call'; id: string; call: string; op: 'mute'; muted: boolean; deafened: boolean }
  | { t: 'call'; id: string; call: string; op: 'signal' | 'note'; data: unknown }
  /** One person's volume (0 to VOLUME_MAX) or mute, for this account only (capability 'callVolume'). `user` native. */
  | { t: 'call'; id: string; call: string; op: 'local'; user: string; volume?: number; muted?: boolean }
  /** The microphone's handling for the account's own client (capability 'callInput'). */
  | { t: 'call'; id: string; call: string; op: 'input'; input: CallInput }
  /** A stage action (capability 'stage'); `user` native, for invite and audience. */
  | { t: 'call'; id: string; call: string; op: 'stage'; action: StageAction; user?: string }
  /** reply.result: { sounds: CallSound[]; reason?: string } (capability 'soundboard'). */
  | { t: 'call'; id: string; call: string; op: 'sounds' }
  | { t: 'call'; id: string; call: string; op: 'sound'; sound: string; guild: string }
  /**
   * What an invite, address, name or handle is, without joining, following or telling anyone (capability 'resolve').
   * Identity facts it names first, then reply.result: AddPreview. Not found or expired: an error sentence.
   */
  | { t: 'resolve'; id: string; ref: AddRef }
  /**
   * Act on a reading (capability 'join' for join and ask, 'connect' for friend, follow and contact). Space,
   * conversation and identity facts first, then reply.result: AddResult. 'message' goes through openDirect.
   */
  | { t: 'add'; id: string; ref: AddRef; action: Exclude<AddAction, 'message'>; /** The owner confirmed what the network asked (AddResult.confirm). */ confirm?: true }
  /** Answer a request (capability 'requests'). reply.result: AddResult. */
  | { t: 'answer'; id: string; request: string; answer: RequestAnswer; /** The owner confirmed what the network asked (AddResult.confirm). */ confirm?: true }
  /**
   * End how you stand with someone (capability 'disconnect'): friend → unfriend, requested → cancel the request,
   * blocked → unblock, contact → remove the contact, following → unfollow. `identity` is native; `relationship` is
   * what the owner saw, and the adapter refuses when it is not what the network says now ("That changed; look
   * again"). reply.result: AddResult with the relationship after; a relationship event follows.
   */
  | { t: 'remove'; id: string; identity: string; relationship: PersonRelationship }
  /**
   * Add people to a group (capability 'addMembers'): `people` are native identity ids, at most ADD_MEMBERS_MAX, none in
   * it yet. The hub has checked a fresh About's `adding` and paced it. One person refused does not stop the rest.
   * Identity and conversation facts first (its new participants), then reply.result: AddMembersResult.
   */
  | { t: 'addMembers'; id: string; target: AboutTarget; people: string[] }
  /**
   * Make a new group (capability 'createGroup'): a Discord group DM, a Signal group, a Matrix room, a Telegram group.
   * `people` are native identity ids; the hub has checked them and `name` against GROUP_RULES and paced it. One person
   * refused does not stop the rest, as long as the group is made; when it is not, an error sentence.
   * Identity facts, then the new conversation's fact (shape 'group', its participants), then reply.result: CreateGroupResult.
   */
  | { t: 'createGroup'; id: string; name?: string; people: string[] }
  /**
   * A space's scheduled events as the network has them now (capability 'events'): what opening its events list in the
   * network's own client reads, counts and your answers included. reply.result: ScheduledEventsResult.
   */
  | { t: 'scheduledEvents'; id: string; space: string }
  /**
   * Say Interested in a scheduled event, or take it back (capability 'rsvp'); `occurrence`: one occurrence of a repeating
   * event (EventException.nativeId or its original start as a string), else the series. reply.result: ScheduledEventFact.
   */
  | { t: 'rsvp'; id: string; space: string; event: string; occurrence?: string; interested: boolean }
  /**
   * Leave a conversation or space (capability 'leave'): a Discord server or group DM, a Signal group. The hub has
   * checked a fresh About's `leaving`. `silent`: without telling the others, where the network can. The leave event
   * first, then reply.result: LeaveResult.
   */
  | {
      t: 'leave';
      id: string;
      target: AboutTarget;
      silent?: boolean;
      /** Native identity ids made admin as you leave (AboutLeaving.needsAdmin; Signal's `--admin`). */
      admins?: string[];
      /** Forget the group's data on this device too (AboutLeaving.canForget; Signal's `--delete`). */
      forget?: true;
    }
  /** What a space asks of this account now (capability 'gates'). reply.result: SpaceGate | null. */
  | { t: 'gate'; id: string; space: string }
  /** The owner's answer to it, checked against gateAnswerProblem (capability 'gates'). reply.result: GateResult. */
  | { t: 'answerGate'; id: string; space: string; answer: GateAnswer }
  /** Your own nickname in a space, '' to clear it (capability 'nick', checked against nickProblem). reply.result: the About as it now stands. */
  | { t: 'setNick'; id: string; space: string; nick: string }
  /**
   * Mark your safety number with someone verified (capability 'safetyNumbers'): `safetyNumber` is the one the owner
   * compared, and the adapter refuses when it is not the current one ("It changed; look again"). `clear` takes the
   * mark away. reply.result: PersonAbout of them as it now stands.
   */
  | { t: 'verify'; id: string; who: string; safetyNumber?: string; clear?: true }
  /**
   * Block or (`unblock`) unblock a person (kind 'identity') or a group (kind 'conversation'), on the owner's click
   * (capability 'block'). Nothing from them reaches you while blocked. reply.result: { blocked: boolean }; a
   * relationship event follows for a person.
   */
  | { t: 'block'; id: string; target: { kind: 'identity' | 'conversation'; nativeId: string }; unblock?: true }
  /**
   * Your private nickname or note for someone, kept on the network too (capability 'contactNotes'). Only the fields
   * given change; '' clears one. reply.result: {}; an identity fact with what the network now keeps follows.
   */
  | { t: 'setContact'; id: string; who: string; nickname?: string; note?: string }
  /** Account-specific actions, e.g. 'relogin', 'startLink', 'resync'. */
  | { t: 'action'; id: string; action: string; args?: unknown }
  | { t: 'shutdown' }
  /** mute, markUnread, markReadMany (attention.ts). */
  | AttentionCommand
  /** appCommands, appAutocomplete, interact (apps.ts). */
  | InteractCommand
  /** stickers, addStickerPack, storyViewed, storyReply (media.ts). */
  | MediaCommand
  /** pollVote, pollCreate, pollEnd (poll.ts). */
  | PollCommand
  /** suppressEmbeds, save, savedList, nativeScheduled, cancelScheduled (sending.ts). */
  | SendCommand
  /** Block, ignore, notes, own presence, sessions (self.ts). */
  | SelfCommand
  /** followThread, threadNotify, threadState, createThread, createPost, crosspost, removeMember, setOwner, setPicture (threads.ts). */
  | ThreadsCommand;

export type AdapterCommandType = AdapterCommand['t'];
