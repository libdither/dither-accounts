/**
 * Discord objects -> dither-chat protocol facts. Pure functions only: no I/O, no
 * global state, so test/map.test.ts can drive every branch with hand-written
 * fixtures. The adapter process calls these on the raw objects the hook forwards.
 *
 * Channel types (https://discord.com/developers/docs/resources/channel):
 *   0 text  2 voice  4 category  5 announcement  10/11/12 threads
 *   13 stage  15 forum  16 media  1 DM  3 group DM
 */

import { withThreadFacts } from './threads.ts';
import { discordEmojiUrl } from '@dither-chat/protocol';
import type {
  AttachmentKind,
  AttachmentFact,
  ConversationFact,
  CustomEmojiFact,
  ForwardFact,
  IdentityFact,
  MessageFact,
  MessageKind,
  NativeMute,
  ReactionFact,
  Shape,
  SpaceFact,
  Variant,
} from '@dither-chat/protocol';
import type {
  RawAttachment,
  RawChannel,
  RawEmoji,
  RawGuild,
  RawGuildSettings,
  RawMessage,
  RawReadState,
  RawStickerItem,
  RawUser,
} from './discord-types.ts';
import { callMessageText } from './calls.ts';
import { pollFact } from './polls.ts';
import { attachmentMarks, embedMore, flattenComponents, isCrosspost, moreSystemText, pingsYourRole, richExtra, sentSilently } from './rich.ts';

export const DISCORD_EPOCH = 1420070400000n;

/** A Discord snowflake encodes its creation time; useful for read-state cutoffs. */
export function snowflakeToMs(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

export function isoToMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Positions sort as strings on the hub, so zero-pad. Discord positions are small ints. */
export function pos(n: number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  const neg = n < 0;
  return (neg ? '-' : '') + String(Math.abs(n)).padStart(6, '0');
}

export const CHANNEL_TYPE = {
  TEXT: 0,
  DM: 1,
  VOICE: 2,
  GROUP_DM: 3,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  STAGE: 13,
  DIRECTORY: 14,
  FORUM: 15,
  MEDIA: 16,
  // Newer ones (threads.ts NEW_TYPES): a game lobby, a game's DM, a media channel's post, and two server experiments.
  LOBBY: 17,
  DM_SDK: 18,
  MEDIA_THREAD: 19,
  GUILD_SPACE: 20,
  GUILD_APP: 21,
} as const;

export const THREAD_TYPES = new Set<number>([
  CHANNEL_TYPE.ANNOUNCEMENT_THREAD,
  CHANNEL_TYPE.PUBLIC_THREAD,
  CHANNEL_TYPE.PRIVATE_THREAD,
  CHANNEL_TYPE.MEDIA_THREAD,
]);

/** DMs and group DMs, and the newer private kinds read as them: a game's DM as a DM, a game lobby as a group. */
export function isPrivate(type: number): boolean {
  return type === CHANNEL_TYPE.DM || type === CHANNEL_TYPE.GROUP_DM || type === CHANNEL_TYPE.DM_SDK || type === CHANNEL_TYPE.LOBBY;
}

export function isThread(type: number): boolean {
  return THREAD_TYPES.has(type);
}

// ------------------------------------------------------------------ identities

export function userDisplayName(u: RawUser): string {
  return u.global_name || u.username || u.id;
}

/** cdn avatar url, or undefined if the user has only the default. */
export function avatarUrl(u: RawUser): string | undefined {
  if (!u.avatar) return undefined;
  const ext = u.avatar.startsWith('a_') ? 'gif' : 'webp';
  return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=128`;
}

export function mapUser(u: RawUser, opts: { isSelf?: boolean; contact?: boolean } = {}): IdentityFact {
  return {
    nativeId: u.id,
    handle: u.username,
    displayName: userDisplayName(u),
    avatarUrl: avatarUrl(u),
    isBot: !!u.bot,
    ...(opts.isSelf ? { isSelf: true } : {}),
    ...(opts.contact ? { contact: true } : {}),
  };
}

// ---------------------------------------------------------------------- spaces

export function guildIconUrl(g: RawGuild): string | undefined {
  if (!g.icon) return undefined;
  const ext = g.icon.startsWith('a_') ? 'gif' : 'webp';
  return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${ext}?size=128`;
}

export function mapGuild(g: RawGuild, mute?: NativeMute): SpaceFact {
  return {
    nativeId: g.id,
    kind: 'community',
    name: g.name,
    topic: g.description ?? undefined,
    iconUrl: guildIconUrl(g),
    ...(mute ? { mute } : {}),
  };
}

/** A category (type 4) becomes a section space whose parent is its guild. */
export function mapCategory(c: RawChannel, mute?: NativeMute): SpaceFact {
  return {
    nativeId: c.id,
    kind: 'section',
    name: c.name ?? 'category',
    parents: c.guild_id ? [{ nativeId: c.guild_id, position: pos(c.position) }] : undefined,
    ...(mute ? { mute } : {}),
  };
}

// --------------------------------------------------------------- conversations

export function channelShape(type: number): Shape {
  if (type === CHANNEL_TYPE.DM || type === CHANNEL_TYPE.DM_SDK) return 'direct';
  if (type === CHANNEL_TYPE.GROUP_DM || type === CHANNEL_TYPE.LOBBY) return 'group';
  if (isThread(type)) return 'thread';
  return 'channel';
}

export function channelVariant(c: RawChannel, guild?: RawGuild): Variant | undefined {
  switch (c.type) {
    case CHANNEL_TYPE.ANNOUNCEMENT:
    case CHANNEL_TYPE.ANNOUNCEMENT_THREAD:
      return 'announcement';
    case CHANNEL_TYPE.FORUM:
      return 'forum';
    case CHANNEL_TYPE.MEDIA:
      return 'media';
    case CHANNEL_TYPE.VOICE:
      return 'voice';
    case CHANNEL_TYPE.STAGE:
      return 'stage';
    case CHANNEL_TYPE.TEXT:
      // The guild's designated rules channel reads as a 'rules' variant.
      if (guild?.rules_channel_id && guild.rules_channel_id === c.id) return 'rules';
      return 'text';
    default:
      return undefined;
  }
}

/** Map a guild text/voice/forum/... channel (NOT a category) to a conversation. */
export function mapGuildChannel(c: RawChannel, guild?: RawGuild, mute?: NativeMute): ConversationFact {
  // A channel sits under its category if it has one, else directly under the guild.
  const parentSpace = c.parent_id ?? c.guild_id ?? undefined;
  return withThreadFacts(
    {
      nativeId: c.id,
      shape: 'channel',
      variant: channelVariant(c, guild),
      name: c.name ?? undefined,
      topic: c.topic ?? undefined,
      spaces: parentSpace ? [{ nativeId: parentSpace, position: pos(c.position) }] : undefined,
      ...(mute ? { mute } : {}),
    },
    c,
  );
}

export function mapThread(c: RawChannel, mute?: NativeMute): ConversationFact {
  return withThreadFacts(
    {
      nativeId: c.id,
      shape: 'thread',
      variant: channelVariant(c),
      name: c.name ?? undefined,
      parentConversation: c.parent_id ?? undefined,
      // Said both ways when the client said it, so a thread opened again is shown again.
      archived: c.thread_metadata ? !!c.thread_metadata.archived : undefined,
      ...(mute ? { mute } : {}),
    },
    c,
  );
}

/** A group DM's own picture, else the default one the client shows for it. */
export function groupIconUrl(c: RawChannel): string | undefined {
  return c.icon ? `https://cdn.discordapp.com/channel-icons/${c.id}/${c.icon}.webp?size=128` : (c.default_icon ?? undefined);
}

/** A DM (type 1) or group DM (type 3). selfId is included in participants. */
export function mapPrivateChannel(c: RawChannel, selfId: string, mute?: NativeMute): ConversationFact {
  const recipients = c.recipients ?? [];
  const participants = [selfId, ...recipients.map((r) => r.id)];
  if (c.type === CHANNEL_TYPE.GROUP_DM || c.type === CHANNEL_TYPE.LOBBY) {
    const name = c.name?.trim() || recipients.map(userDisplayName).join(', ') || 'Group';
    return {
      nativeId: c.id,
      shape: 'group',
      name,
      participants,
      avatarUrl: groupIconUrl(c),
      ...(mute ? { mute } : {}),
    };
  }
  // 1:1 DM: no name (the UI names it after the peer).
  return {
    nativeId: c.id,
    shape: 'direct',
    participants,
    ...(mute ? { mute } : {}),
  };
}

/** Dispatch any channel object to the right conversation mapper, or null for a category. */
export function mapChannel(c: RawChannel, ctx: { selfId: string; guild?: RawGuild; mute?: NativeMute }): ConversationFact | null {
  if (c.type === CHANNEL_TYPE.CATEGORY) return null;
  if (isPrivate(c.type)) return mapPrivateChannel(c, ctx.selfId, ctx.mute);
  if (isThread(c.type)) return mapThread(c, ctx.mute);
  return mapGuildChannel(c, ctx.guild, ctx.mute);
}

// -------------------------------------------------------------------- messages

export function attachmentKind(a: RawAttachment): AttachmentKind {
  const ct = (a.content_type ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  // fall back to the extension when Discord omits content_type
  const name = (a.filename ?? a.url ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(name)) return 'image';
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(name)) return 'video';
  if (/\.(mp3|ogg|wav|flac|m4a|opus)$/.test(name)) return 'audio';
  return 'file';
}

export function mapAttachment(a: RawAttachment): AttachmentFact {
  return {
    nativeId: a.id,
    kind: attachmentKind(a),
    mime: a.content_type,
    name: a.filename,
    size: a.size,
    width: a.width,
    height: a.height,
    url: a.url,
    ...attachmentMarks(a),
  };
}

/**
 * Discord message type -> a readable string for system messages, or null if this
 * is an ordinary (user-authored) message whose own content should be used.
 * Reply (19) and the default (0) are ordinary.
 */
export function systemMessageText(m: RawMessage, selfId?: string): string | null {
  switch (m.type) {
    case undefined:
    case 0: // DEFAULT
    case 19: // REPLY
    case 20: // CHAT_INPUT_COMMAND: a bot answering a slash command
    case 23: // CONTEXT_MENU_COMMAND
      return null;
  }
  const who = m.author ? userDisplayName(m.author) : 'Someone';
  const more = moreSystemText(m, who);
  if (more !== undefined) return more;
  switch (m.type) {
    case 1: {
      // RECIPIENT_ADD and RECIPIENT_REMOVE name whom in their mentions.
      const them = m.mentions?.[0];
      return them && them.id !== m.author?.id ? `${who} added ${userDisplayName(them)} to the group.` : `${who} added someone to the group.`;
    }
    case 2: {
      const them = m.mentions?.[0];
      if (them && them.id === m.author?.id) return `${who} left the group.`;
      return them ? `${who} removed ${userDisplayName(them)} from the group.` : `${who} removed someone from the group.`;
    }
    case 3:
      return callMessageText(m, selfId, who);
    case 4:
      return `${who} changed the channel name${m.content ? `: ${m.content}` : '.'}`;
    case 5:
      return `${who} changed the channel icon.`;
    case 6:
      return `${who} pinned a message to this channel.`;
    case 7:
      return `${who} joined the server.`;
    case 8:
    case 9:
    case 10:
    case 11:
      return `${who} boosted the server.`;
    case 12:
      return `${who} followed a channel.`;
    case 15:
    case 16:
    case 17:
      return `${who} updated the channel.`;
    case 18:
      return `${who} started a thread${m.content ? `: ${m.content}` : '.'}`;
    case 21:
      return null; // THREAD_STARTER_MESSAGE: the referenced content is shown instead
    case 24: // AUTO_MODERATION_ACTION
      return 'A message was flagged by AutoMod.';
    case 44: // PURCHASE_NOTIFICATION
      return `${who} made a purchase in the server.`;
    case 46: // POLL_RESULT: the result itself comes as an embed
      return `${who}'s poll has ended.`;
    case 47: // CHANGELOG
    case 49: // CHANNEL_LINKED_TO_LOBBY
    case 68: // MEDIA_MENTION_MESSAGE
      return m.content ? null : `(unsupported message type ${m.type})`;
    case 52: // GUILD_JOIN_REQUEST_ACCEPT_NOTIFICATION: content is the server's name
      return `${who}'s application to ${m.content || 'the server'} was approved.`;
    case 53:
      return `${who}'s application to ${m.content || 'the server'} was rejected.`;
    case 54:
      return `${who}'s application to ${m.content || 'the server'} was withdrawn.`;
    case 55: // HD_STREAMING_UPGRADED
      return `${who} turned on HD streaming.`;
    case 56: // CHAT_WALLPAPER_SET
      return `${who} changed the chat wallpaper.`;
    case 57:
      return `${who} removed the chat wallpaper.`;
    case 58: // REPORT_TO_MOD_*: a moderator acting on a report
      return `${who} deleted the reported message.`;
    case 59:
    case 60:
    case 61: {
      const them = m.mentions?.[0];
      const verb = m.type === 59 ? 'timed out' : m.type === 60 ? 'kicked' : 'banned';
      return `${who} ${verb} ${them ? userDisplayName(them) : 'someone'}.`;
    }
    case 62:
      return `${who} resolved a report.`;
    case 63: // EMOJI_ADDED
      return `${who} added a new emoji${m.content ? `: ${m.content}` : '.'}`;
    case 65: // VOICE_SESSION
      return `${who} started a voice hangout.`;
    case 67: // FRIEND_REQUEST_ACCEPTED: sent into the DM, written from the side of whoever had asked
      return m.author?.id && m.author.id === selfId ? 'You accepted a friend request.' : `${who} accepted your friend request.`;
    default:
      // Unknown system type with no content: say something rather than show blank.
      return m.content ? null : `(unsupported message type ${m.type})`;
  }
}

/** Reaction emoji -> a stable key. Custom emoji use "name:id", unicode use the glyph. */
export function reactionKey(e: RawEmoji): string {
  if (e.id) return `${e.name ?? '_'}:${e.id}`;
  return e.name ?? '';
}

export function customEmoji(e: RawEmoji): CustomEmojiFact | undefined {
  if (!e.id) return undefined;
  return { key: reactionKey(e), name: e.name ?? 'emoji', url: discordEmojiUrl(e.id, e.animated), animated: !!e.animated };
}

/**
 * Discord reports reactions as totals plus "did you", with normal and super counted apart.
 * The people behind a total are only known once someone asks (the `reactors` command).
 */
export function reactionFacts(m: RawMessage, selfId: string): ReactionFact[] {
  const facts: ReactionFact[] = [];
  for (const r of m.reactions ?? []) {
    const key = reactionKey(r.emoji);
    const emoji = customEmoji(r.emoji);
    const burst = r.count_details?.burst ?? r.burst_count ?? 0;
    const normal = r.count_details?.normal ?? r.count ?? 0;
    if (burst > 0) facts.push({ key, style: 'super', count: burst, authors: r.me_burst ? [selfId] : [], ...(r.burst_colors?.length ? { colors: r.burst_colors } : {}), ...(emoji ? { emoji } : {}) });
    if (normal > 0) facts.push({ key, count: normal, authors: r.me ? [selfId] : [], ...(emoji ? { emoji } : {}) });
  }
  return facts;
}

/** Discord uses <@!id> for nickname mentions; the ontology wants <@id>. */
export function normalizeMentions(body: string): string {
  return body.replace(/<@!(\d+)>/g, '<@$1>');
}

export function messageKind(m: RawMessage, system: string | null): MessageKind {
  if (m.type === 3) return 'call';
  if (system !== null) return 'system';
  if (stickerAttachments(m).length && (!m.content || !m.content.trim())) return 'sticker';
  if (m.attachments && m.attachments.length && (!m.content || !m.content.trim())) return 'media';
  return 'text';
}

function allAttachments(m: RawMessage) {
  return [...(m.attachments ?? []), ...(m.message_snapshots?.flatMap((s) => s.attachments ?? []) ?? [])];
}

/** Whitelisted subset of an embed, for MessageFact.extra. */
function embedExtra(m: RawMessage) {
  const raw = [...(m.embeds ?? []), ...(m.message_snapshots?.flatMap((s) => s.embeds ?? []) ?? [])];
  if (!raw.length) return undefined;
  const embeds = raw.slice(0, 6).map((e) => ({
    type: e.type,
    title: e.title,
    description: e.description,
    url: e.url,
    provider: e.provider?.name,
    author: e.author?.name,
    image: e.image?.url ?? e.thumbnail?.url,
    fields: e.fields,
    ...embedMore(e),
  }));
  return { embeds };
}

/** Discord's message_reference.type for a forward. */
export const REFERENCE_FORWARD = 1;
const isForward = (m: RawMessage) => m.message_reference?.type === REFERENCE_FORWARD || (!!m.message_snapshots?.length && !m.content);

/** Where a forward came from. Discord says the channel, message and server, never the author. */
function forwardFact(m: RawMessage): ForwardFact | undefined {
  if (!isForward(m)) return undefined;
  const ref = m.message_reference;
  const ts = m.message_snapshots?.[0]?.timestamp ? isoToMs(m.message_snapshots[0].timestamp!) : undefined;
  return { conversation: ref?.channel_id, message: ref?.message_id, space: ref?.guild_id ?? undefined, ...(ts ? { ts } : {}) };
}

/** Discord's sticker formats (https://docs.discord.food/resources/sticker#sticker-format-type). */
export const STICKER_FORMAT = { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 } as const;

/** Where a sticker's picture is. A Lottie sticker is its animation as JSON, which the web app plays itself. */
export function stickerAsset(s: RawStickerItem): { url: string; mime: string } | null {
  if (!s.id || !/^\d+$/.test(s.id)) return null;
  switch (s.format_type) {
    case STICKER_FORMAT.LOTTIE:
      return { url: `https://cdn.discordapp.com/stickers/${s.id}.json`, mime: LOTTIE_MIME };
    case STICKER_FORMAT.GIF:
      // GIF stickers are not on the CDN, only on the media proxy.
      return { url: `https://media.discordapp.net/stickers/${s.id}.gif`, mime: 'image/gif' };
    default:
      // PNG and APNG alike: the CDN passes an APNG through as it is, so it still moves.
      return { url: `https://cdn.discordapp.com/stickers/${s.id}.png`, mime: 'image/png' };
  }
}

/** The mime a Lottie sticker's attachment carries, so the web app knows to play it rather than show it. */
export const LOTTIE_MIME = 'application/x-lottie+json';
/** Discord draws stickers at 160 by 160. */
const STICKER_SIZE = 160;

/** A message's stickers as attachments of their own. A sticker from an older hook, without an id, has none. */
export function stickerAttachments(m: RawMessage): AttachmentFact[] {
  const out: AttachmentFact[] = [];
  for (const s of m.sticker_items ?? []) {
    const a = stickerAsset(s);
    if (a) out.push({ nativeId: `sticker:${s.id}`, kind: 'image', mime: a.mime, name: s.name, width: STICKER_SIZE, height: STICKER_SIZE, url: a.url });
  }
  return out;
}

/** What a message says when its content is empty: a forward, a sticker or a poll. */
function bodyFallback(m: RawMessage): string {
  const forwarded = m.message_snapshots?.map((s) => s.content).filter(Boolean).join('\n');
  // A forward is shown as a card around this, so it is not quoted here.
  if (forwarded) return isForward(m) ? forwarded : forwarded.replace(/^/gm, '> ');
  // A sticker shows as itself; one without an id (an older hook) can only be named.
  const stickers = m.sticker_items ?? [];
  if (stickers.length && stickers.every((s) => stickerAsset(s))) return '';
  if (stickers.length) return stickers.map((s) => `[sticker: ${s.name}]`).join(' ');
  if (m.poll?.question) return [`**${m.poll.question}**`, ...(m.poll.answers ?? []).map((a) => `- ${typeof a === 'string' ? a : a.text ?? ''}`)].join('\n');
  return '';
}

function attachmentsOf(m: RawMessage): AttachmentFact[] | undefined {
  const all = [...allAttachments(m).map(mapAttachment), ...stickerAttachments(m)];
  return all.length ? all : undefined;
}

/** What mapMessage knows beyond the message: your own roles in its server (rich.ts), for role pings. */
export interface MapContext {
  selfRoles?: readonly string[];
}

export function mapMessage(m: RawMessage, selfId: string, ctx: MapContext = {}): MessageFact {
  const system = systemMessageText(m, selfId);
  // A bot's controls, and a Components V2 message's text and files, which have no content of their own (rich.ts).
  const flat = flattenComponents(m.components, m.attachments);
  const body = system !== null ? system : normalizeMentions(m.content || flat.body || bodyFallback(m));
  // A ping to a role you hold is a mention of you, as Discord counts it.
  const byName = (m.mentions?.some((u) => u.id === selfId) ?? false) || body.includes(`<@${selfId}>`) || pingsYourRole(m, ctx.selfRoles);
  const mentionsSelf = byName || !!m.mention_everyone;
  const rich = richExtra(m, body, flat.rows);
  const embeds = embedExtra(m);
  // A poll as structured data (polls.ts); its words stay in the body too, for search and previews.
  const poll = pollFact(m.poll);
  const extra = embeds || Object.keys(rich).length || poll ? { ...embeds, ...rich, ...(poll ? { poll } : {}) } : undefined;
  const attachments = attachmentsOf(m)?.map((a) => (a.nativeId && flat.ofAttachments.has(a.nativeId) ? { ...a, ...flat.ofAttachments.get(a.nativeId) } : a));
  const all = flat.attachments.length ? [...(attachments ?? []), ...flat.attachments] : attachments;
  const forward = forwardFact(m);
  // A crosspost's reference is the message it was published from, in another server: not a reply.
  const replyTo = m.type !== 21 && !forward && !isCrosspost(m) ? m.message_reference?.message_id : undefined;
  return {
    nativeId: m.id,
    conversation: m.channel_id,
    author: m.author.id,
    ts: isoToMs(m.timestamp) || snowflakeToMs(m.id),
    editedTs: m.edited_timestamp ? isoToMs(m.edited_timestamp) : undefined,
    kind: messageKind(flat.body && !m.content ? { ...m, content: flat.body } : m, system),
    body,
    replyTo,
    // A message carrying a `thread` object is the root of that thread conversation.
    threadRoot: m.thread?.id,
    mentionsSelf: mentionsSelf || undefined,
    mentionsAll: (mentionsSelf && !byName) || undefined,
    attachments: all,
    reactions: m.reactions?.length ? reactionFacts(m, selfId) : undefined,
    ...(forward ? { forward } : {}),
    ...(sentSilently(m) ? { silent: true } : {}),
    extra,
  };
}

// ------------------------------------------------------------------ read state

/** A Discord read state -> the `read` event payload. upToTs comes from the last read snowflake. */
export function mapReadState(rs: RawReadState): { upToTs: number; mentions: number } {
  return {
    upToTs: rs.last_message_id ? snowflakeToMs(rs.last_message_id) : 0,
    mentions: rs.mention_count ?? 0,
  };
}

// ----------------------------------------------------------------------- mutes

/** Discord notification settings -> a NativeMute, or undefined when nothing is muted. */
export function mapMute(s: {
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
  message_notifications?: number;
}): NativeMute | undefined {
  // message_notifications: 0 all, 1 only @mentions, 2 nothing, 3 inherit
  let level: NativeMute['level'] | undefined;
  if (s.muted) level = 'none';
  else if (s.message_notifications === 0) level = 'all';
  else if (s.message_notifications === 1) level = 'mentions';
  else if (s.message_notifications === 2) level = 'none';

  if (level === undefined && !s.muted) return undefined;

  const until = s.muted && s.mute_config?.end_time ? isoToMs(s.mute_config.end_time) : undefined;
  const mute: NativeMute = {};
  if (level) mute.level = level;
  if (until) mute.until = until;
  // Discord's Mute, rather than a level of nothing: what dither's "Muted on Discord" and Unmute are about.
  if (s.muted) mute.muted = true;
  return Object.keys(mute).length ? mute : undefined;
}

/** Pull a channel's effective mute out of a guild-settings object, if present. */
export function channelMute(gs: RawGuildSettings | undefined, channelId: string): NativeMute | undefined {
  const o = gs?.channel_overrides?.find((c) => c.channel_id === channelId);
  if (!o) return undefined;
  return mapMute(o);
}

/** At most this many links in one refresh-urls request, as the client sends them. */
export const REFRESH_BATCH = 50;

/**
 * The links in `urls` Discord can sign again: its own attachment links (cdn.discordapp.com, media.discordapp.net),
 * at most REFRESH_BATCH of them, no repeats. Anything else is left out.
 */
export function refreshable(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const out = new Set<string>();
  for (const u of urls) {
    if (typeof u !== 'string' || u.length > 2048) continue;
    try {
      const x = new URL(u);
      if (x.protocol === 'https:' && /^(cdn\.discordapp\.com|media\.discordapp\.net)$/.test(x.hostname) && x.pathname.startsWith('/attachments/')) out.add(u);
    } catch {}
    if (out.size >= REFRESH_BATCH) break;
  }
  return [...out];
}
