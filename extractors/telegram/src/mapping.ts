/**
 * Telegram objects (TL, as mtcute and the fake give them) -> dither-chat facts. Pure: everything it needs to know
 * about the account comes in a MapCtx, so tests feed it synthetic TL objects.
 */
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey } from '@dither-chat/protocol';
import type { tl } from './backend.ts';
import { fromTelegram } from './entities.ts';
import { avatarUrl, channelIdentity, convId, customKey, emojiUrl, mediaUrl, msgId, type PeerRef, userId } from './ids.ts';

export interface MapCtx {
  /** This account's own user id. */
  self: number;
  /** Channels that are forums (their messages belong to topics). */
  isForum(channelId: number): boolean;
  /** What to call a user or chat in a service message. */
  nameOf(peer: PeerRef): string | undefined;
  /** The user with this @username (without the @), when this account knows them: an @username in a message names them. */
  userByName?(username: string): number | undefined;
}

export const TYPING_TTL = 6000;
/** Telegram's "muted forever". */
const FOREVER = 2_147_483_647;

// ---------------------------------------------------------------- peers

export function peerOf(p: tl.TypePeer): PeerRef {
  if (p._ === 'peerUser') return { kind: 'user', id: Number(p.userId) };
  if (p._ === 'peerChat') return { kind: 'chat', id: Number(p.chatId) };
  return { kind: 'channel', id: Number(p.channelId) };
}

export const peerKey = (p: PeerRef) => `${p.kind}:${p.id}`;

/** The identity that wrote as this peer: a user, or a channel posting as itself. */
export function authorOf(p: PeerRef): string {
  return p.kind === 'user' ? userId(p.id) : channelIdentity(p.id);
}

export function displayName(u: { firstName?: string; lastName?: string; username?: string; phone?: string; deleted?: boolean }): string {
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (n) return n;
  if (u.deleted) return 'Deleted Account';
  return u.username ? `@${u.username}` : u.phone ? `+${u.phone}` : 'Telegram user';
}

export function usernameOf(x: { username?: string; usernames?: { username: string; active?: boolean }[] }): string | undefined {
  return x.username ?? x.usernames?.find((u) => u.active)?.username ?? x.usernames?.[0]?.username;
}

export function identityOfUser(u: tl.TypeUser, self: number): P.IdentityFact | null {
  if (u._ !== 'user') return null;
  const id = Number(u.id);
  const uname = usernameOf(u);
  const f: P.IdentityFact = { nativeId: userId(id), displayName: displayName(u) };
  if (uname) f.handle = `@${uname}`;
  else if (u.phone) f.handle = `+${u.phone}`;
  if (u.photo?._ === 'userProfilePhoto') f.avatarUrl = avatarUrl({ kind: 'user', id }, u.photo.photoId, u.photo.dcId);
  if (u.bot) f.isBot = true;
  if (u.self || id === self) f.isSelf = true;
  if (u.contact || u.mutualContact) f.contact = true;
  return f;
}

/** A channel or supergroup as an author (channel posts, anonymous admins, "send as"). */
export function identityOfChat(c: tl.TypeChat): P.IdentityFact | null {
  if (c._ !== 'channel' && c._ !== 'channelForbidden') return null;
  const f: P.IdentityFact = { nativeId: channelIdentity(Number(c.id)), displayName: c.title };
  if (c._ === 'channel') {
    const uname = usernameOf(c);
    if (uname) f.handle = `@${uname}`;
    if (c.photo._ === 'chatPhoto') f.avatarUrl = avatarUrl({ kind: 'channel', id: Number(c.id) }, c.photo.photoId, c.photo.dcId);
  }
  return f;
}

/** A basic group's, supergroup's or channel's picture, as other facts carry it (fetched through fetchMedia). */
export function avatarOfChat(c: tl.TypeChat): string | undefined {
  if ((c._ === 'chat' || c._ === 'channel') && c.photo._ === 'chatPhoto') return avatarUrl({ kind: c._ === 'chat' ? 'chat' : 'channel', id: Number(c.id) }, c.photo.photoId, c.photo.dcId);
  return undefined;
}

export function muteOf(s: tl.TypePeerNotifySettings | undefined, nowSec = Math.floor(Date.now() / 1000)): P.NativeMute {
  const until = s?.muteUntil ?? 0;
  if (until > nowSec) return until >= FOREVER ? { level: 'none' } : { level: 'none', until: until * 1000 };
  return { level: 'all' };
}

// ---------------------------------------------------------------- conversations

export interface ChatInfo {
  user?: tl.TypeUser;
  chat?: tl.TypeChat;
}

/** The conversation for a peer. `chat`/`user` is the object Telegram sent with it. */
export function conversationOf(ctx: MapCtx, peer: PeerRef, info: ChatInfo, dialog?: tl.RawDialog, topDate?: number): P.ConversationFact {
  const f: P.ConversationFact = { nativeId: convId(ctx.self, peer), shape: 'group' };
  if (peer.kind === 'user') {
    if (peer.id === ctx.self) {
      f.shape = 'self';
      f.name = 'Saved Messages';
      f.participants = [userId(ctx.self)];
    } else {
      f.shape = 'direct';
      f.participants = [userId(ctx.self), userId(peer.id)];
    }
    const u = info.user;
    if (u?._ === 'user' && u.photo?._ === 'userProfilePhoto' && peer.id !== ctx.self) f.avatarUrl = avatarUrl(peer, u.photo.photoId, u.photo.dcId);
  } else {
    const c = info.chat;
    if (c && 'title' in c) f.name = c.title;
    if (c?._ === 'chat' || c?._ === 'channel') {
      if (c.photo._ === 'chatPhoto') f.avatarUrl = avatarUrl(peer, c.photo.photoId, c.photo.dcId);
    }
    if (c?._ === 'channel') {
      if (c.forum) f.variant = 'forum';
      else if (c.broadcast) f.variant = 'announcement';
      else f.variant = 'text';
    } else if (c?._ === 'channelForbidden') f.variant = c.broadcast ? 'announcement' : 'text';
    else f.variant = 'text';
  }
  f.encrypted = false;
  if (dialog) {
    f.archived = dialog.folderId === 1;
    f.mute = muteOf(dialog.notifySettings);
  }
  if (topDate) f.lastMessageAt = topDate * 1000;
  return f;
}

export function topicConversation(ctx: MapCtx, channelId: number, t: tl.RawForumTopic): P.ConversationFact {
  const parent = convId(ctx.self, { kind: 'channel', id: channelId });
  const f: P.ConversationFact = {
    nativeId: convId(ctx.self, { kind: 'channel', id: channelId }, t.id),
    shape: 'thread',
    variant: 'text',
    name: t.title,
    parentConversation: parent,
    encrypted: false,
    archived: !!t.hidden,
    mute: muteOf(t.notifySettings),
  };
  return f;
}

// ---------------------------------------------------------------- messages

/** Where a message sits: its conversation (a topic in a forum) and the id it belongs to. */
export function placeOf(ctx: MapCtx, m: { id: number; peerId: tl.TypePeer; replyTo?: tl.TypeMessageReplyHeader; action?: tl.TypeMessageAction }): { conv: string; base: string; topic?: number } {
  const peer = peerOf(m.peerId);
  const base = convId(ctx.self, peer);
  if (peer.kind !== 'channel' || !ctx.isForum(peer.id)) return { conv: base, base };
  let topic = 1;
  const r = m.replyTo;
  if (r?._ === 'messageReplyHeader' && r.forumTopic) topic = r.replyToTopId ?? r.replyToMsgId ?? 1;
  if (m.action?._ === 'messageActionTopicCreate') topic = m.id;
  return { conv: convId(ctx.self, peer, topic), base, topic };
}

/** The message this replies to, as a native id. A message at the top of a forum topic replies to nothing. */
export function replyOf(ctx: MapCtx, base: string, r: tl.TypeMessageReplyHeader | undefined): string | undefined {
  if (r?._ !== 'messageReplyHeader' || !r.replyToMsgId) return undefined;
  if (r.forumTopic && !r.replyToTopId) return undefined;
  const conv = r.replyToPeerId ? convId(ctx.self, peerOf(r.replyToPeerId)) : base;
  return msgId(conv, r.replyToMsgId);
}

function authorOfMessage(ctx: MapCtx, m: { out?: boolean; fromId?: tl.TypePeer; peerId: tl.TypePeer }): string {
  if (m.fromId) return authorOf(peerOf(m.fromId));
  const peer = peerOf(m.peerId);
  if (peer.kind === 'user') return userId(m.out ? ctx.self : peer.id);
  if (m.out) return userId(ctx.self);
  // A channel's post without an author, or a basic group's message from someone we were not told about.
  return peer.kind === 'channel' ? channelIdentity(peer.id) : userId(0);
}

export function reactionKey(r: tl.TypeReaction): string | null {
  if (r._ === 'reactionEmoji') return canonicalReactionKey(r.emoticon);
  if (r._ === 'reactionCustomEmoji') return customKey(r.documentId);
  return null;
}

export function reactionsOf(ctx: MapCtx, r: tl.TypeMessageReactions | undefined): P.ReactionFact[] {
  if (!r || r._ !== 'messageReactions') return [];
  const out: P.ReactionFact[] = [];
  for (const rc of r.results) {
    const key = reactionKey(rc.reaction);
    if (!key) continue;
    const authors = new Set<string>();
    for (const pr of r.recentReactions ?? []) {
      if (reactionKey(pr.reaction) === key) authors.add(authorOf(peerOf(pr.peerId)));
    }
    if (rc.chosenOrder !== undefined) authors.add(userId(ctx.self));
    const f: P.ReactionFact = { key, authors: [...authors] };
    if (authors.size < rc.count) f.count = rc.count;
    if (rc.reaction._ === 'reactionCustomEmoji') f.emoji = { key, name: 'custom', url: emojiUrl(rc.reaction.documentId) };
    out.push(f);
  }
  return out;
}

/** Who reacted with what, as far as Telegram names them (for diffs between snapshots). */
export function namedReactions(ctx: MapCtx, r: tl.TypeMessageReactions | undefined): Set<string> {
  const s = new Set<string>();
  for (const f of reactionsOf(ctx, r)) for (const a of f.authors) s.add(`${a}\n${f.key}`);
  return s;
}

function largestPhotoSize(sizes: tl.TypePhotoSize[]): { type: string; w: number; h: number; size: number } | null {
  let best: { type: string; w: number; h: number; size: number } | null = null;
  for (const s of sizes) {
    let size = 0;
    if (s._ === 'photoSize') size = s.size;
    else if (s._ === 'photoSizeProgressive') size = Math.max(...s.sizes);
    else continue;
    if (!best || s.w * s.h > best.w * best.h) best = { type: s.type, w: s.w, h: s.h, size };
  }
  return best;
}
export { largestPhotoSize };

export function attachmentsOf(base: string, m: tl.RawMessage): { attachments: P.AttachmentFact[]; kind?: P.MessageKind; text?: string } {
  const media = m.media;
  if (!media) return { attachments: [] };
  const url = mediaUrl(base, m.id);
  switch (media._) {
    case 'messageMediaPhoto': {
      if (media.photo?._ !== 'photo') return { attachments: [], text: '[photo expired]' };
      const big = largestPhotoSize(media.photo.sizes);
      const a: P.AttachmentFact = { nativeId: media.photo.id.toString(), kind: 'image', mime: 'image/jpeg', name: `photo_${m.id}.jpg`, url };
      if (big) Object.assign(a, { width: big.w, height: big.h, ...(big.size ? { size: big.size } : {}) });
      return { attachments: [a], kind: 'media' };
    }
    case 'messageMediaDocument': {
      const d = media.document;
      if (d?._ !== 'document') return { attachments: [], text: '[file expired]' };
      const a: P.AttachmentFact = { nativeId: d.id.toString(), kind: 'file', mime: d.mimeType, size: Number(d.size), url };
      let kind: P.MessageKind = 'media';
      let text: string | undefined;
      for (const at of d.attributes) {
        if (at._ === 'documentAttributeFilename') a.name = at.fileName;
        else if (at._ === 'documentAttributeImageSize') Object.assign(a, { width: at.w, height: at.h });
        else if (at._ === 'documentAttributeVideo') Object.assign(a, { kind: 'video', width: at.w, height: at.h });
        else if (at._ === 'documentAttributeAudio') a.kind = 'audio';
        else if (at._ === 'documentAttributeAnimated') a.kind = 'video';
        else if (at._ === 'documentAttributeSticker') {
          kind = 'sticker';
          text = at.alt || undefined;
        }
      }
      if (a.kind === 'file' && /^(image|video|audio)\//.test(d.mimeType) && kind !== 'sticker') a.kind = d.mimeType.split('/')[0] as P.AttachmentKind;
      if (kind === 'sticker') a.kind = 'image';
      return { attachments: [a], kind, ...(text ? { text } : {}) };
    }
    case 'messageMediaGeo':
    case 'messageMediaGeoLive':
    case 'messageMediaVenue': {
      const g = media.geo;
      if (g._ !== 'geoPoint') return { attachments: [] };
      const where = `https://maps.google.com/?q=${g.lat},${g.long}`;
      const what = media._ === 'messageMediaVenue' ? `📍 ${media.title}${media.address ? `, ${media.address}` : ''}` : media._ === 'messageMediaGeoLive' ? '📍 Live location' : '📍 Location';
      return { attachments: [], text: `${what}\n${where}` };
    }
    case 'messageMediaContact':
      return { attachments: [], text: `👤 ${[media.firstName, media.lastName].filter(Boolean).join(' ') || 'Contact'}${media.phoneNumber ? ` (+${media.phoneNumber.replace(/^\+/, '')})` : ''}` };
    case 'messageMediaPoll': {
      const q = media.poll.question.text;
      return { attachments: [], text: `📊 ${q}\n${media.poll.answers.map((x) => `- ${x.text.text}`).join('\n')}` };
    }
    case 'messageMediaDice':
      return { attachments: [], text: `${media.emoticon} ${media.value}` };
    case 'messageMediaWebPage':
    case 'messageMediaEmpty':
      return { attachments: [] };
    case 'messageMediaUnsupported':
      return { attachments: [], text: '[a message this version of Telegram does not show]' };
    default:
      return { attachments: [], text: `[${media._.replace(/^messageMedia/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}]` };
  }
}

export function forwardOf(ctx: MapCtx, f: tl.TypeMessageFwdHeader | undefined): P.ForwardFact | undefined {
  if (!f) return undefined;
  const out: P.ForwardFact = { ts: f.date * 1000 };
  if (f.fromId) {
    const p = peerOf(f.fromId);
    if (p.kind === 'channel') {
      out.conversation = convId(ctx.self, p);
      if (f.channelPost) out.message = msgId(out.conversation, f.channelPost);
      if (f.postAuthor) out.authorName = f.postAuthor;
      else out.author = channelIdentity(p.id);
    } else out.author = authorOf(p);
  }
  if (f.fromName) out.authorName = f.fromName;
  return out;
}

/** A message fact, or null for an empty one. */
export function messageFact(ctx: MapCtx, m: tl.TypeMessage): P.MessageFact | null {
  if (m._ === 'messageEmpty') return null;
  const { conv, base } = placeOf(ctx, m);
  const f: P.MessageFact = { nativeId: msgId(base, m.id), conversation: conv, author: authorOfMessage(ctx, m), ts: m.date * 1000, body: '' };
  const reply = replyOf(ctx, base, m.replyTo);
  if (reply) f.replyTo = reply;
  if (m.mentioned && !m.out) f.mentionsSelf = true;
  const reactions = reactionsOf(ctx, m.reactions);
  if (reactions.length) f.reactions = reactions;
  if (m._ === 'messageService') {
    f.kind = m.action._ === 'messageActionPhoneCall' ? 'call' : 'system';
    f.body = serviceText(ctx, m.action, f.author);
    return f;
  }
  let mentioned = false;
  f.body = fromTelegram(m.message, m.entities, {
    onMention: (id) => (mentioned ||= id === String(ctx.self)),
    userByName: (name) => {
      const id = ctx.userByName?.(name);
      return id === undefined ? null : userId(id);
    },
  });
  if (mentioned && !m.out) f.mentionsSelf = true;
  if (m.editDate && !m.editHide) f.editedTs = m.editDate * 1000;
  const media = attachmentsOf(base, m);
  if (media.attachments.length) f.attachments = media.attachments;
  if (media.kind) f.kind = media.kind;
  if (media.text) f.body = f.body ? `${f.body}\n${media.text}` : media.text;
  const fwd = forwardOf(ctx, m.fwdFrom);
  if (fwd) f.forward = fwd;
  const extra: Record<string, unknown> = {};
  if (m.views !== undefined) extra.views = m.views;
  if (m.groupedId) extra.album = m.groupedId.toString();
  if (m.viaBotId) extra.viaBot = userId(Number(m.viaBotId));
  if (m.postAuthor) extra.signature = m.postAuthor;
  if (m.ttlPeriod) extra.ttl = m.ttlPeriod;
  if (m.noforwards) extra.protected = true;
  if (Object.keys(extra).length) f.extra = extra;
  return f;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function duration(s: number): string {
  if (s < 60) return plural(s, 'second');
  if (s < 3600) return plural(Math.round(s / 60), 'minute');
  if (s < 86400) return plural(Math.round(s / 3600), 'hour');
  if (s < 7 * 86400) return plural(Math.round(s / 86400), 'day');
  return plural(Math.round(s / (7 * 86400)), 'week');
}

/** A service message in words (the author's name is shown beside it). */
export function serviceText(ctx: MapCtx, a: tl.TypeMessageAction, _author: string): string {
  const who = (ids: (number | { toString(): string })[]) => ids.map((id) => ctx.nameOf({ kind: 'user', id: Number(id) }) ?? `user ${id}`).join(', ');
  switch (a._) {
    case 'messageActionChatCreate':
      return `created the group “${a.title}”`;
    case 'messageActionChannelCreate':
      return `created “${a.title}”`;
    case 'messageActionChatEditTitle':
      return `changed the name to “${a.title}”`;
    case 'messageActionChatEditPhoto':
      return 'changed the group photo';
    case 'messageActionChatDeletePhoto':
      return 'removed the group photo';
    case 'messageActionChatAddUser':
      return `added ${who(a.users)}`;
    case 'messageActionChatDeleteUser':
      return `removed ${who([a.userId])}`;
    case 'messageActionChatJoinedByLink':
      return 'joined by invite link';
    case 'messageActionChatJoinedByRequest':
      return 'was let in';
    case 'messageActionChatMigrateTo':
      return 'upgraded this group to a supergroup';
    case 'messageActionChannelMigrateFrom':
      return `this supergroup was upgraded from the group “${a.title}”`;
    case 'messageActionPinMessage':
      return 'pinned a message';
    case 'messageActionHistoryClear':
      return 'cleared the history';
    case 'messageActionPhoneCall': {
      const kind = a.video ? 'Video call' : 'Call';
      if (a.reason?._ === 'phoneCallDiscardReasonMissed') return `📞 Missed ${kind.toLowerCase()}`;
      if (a.reason?._ === 'phoneCallDiscardReasonBusy') return `📞 ${kind} (busy)`;
      return `📞 ${kind}${a.duration ? ` (${duration(a.duration)})` : ''}`;
    }
    case 'messageActionGroupCall':
      return a.duration ? `ended the voice chat (${duration(a.duration)})` : 'started a voice chat';
    case 'messageActionInviteToGroupCall':
      return `invited ${who(a.users)} to the voice chat`;
    case 'messageActionScreenshotTaken':
      return 'took a screenshot';
    case 'messageActionCustomAction':
      return a.message;
    case 'messageActionContactSignUp':
      return 'joined Telegram';
    case 'messageActionSetMessagesTTL':
      return a.period ? `set messages to disappear after ${duration(a.period)}` : 'turned off disappearing messages';
    case 'messageActionTopicCreate':
      return `created the topic “${a.title}”`;
    case 'messageActionTopicEdit':
      if (a.title) return `renamed the topic to “${a.title}”`;
      if (a.closed !== undefined) return a.closed ? 'closed the topic' : 'reopened the topic';
      if (a.hidden !== undefined) return a.hidden ? 'hid the topic' : 'showed the topic';
      return 'changed the topic';
    case 'messageActionSetChatTheme':
      return 'changed the chat theme';
    case 'messageActionEmpty':
      return '';
    default:
      return `[${a._.replace(/^messageAction/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}]`;
  }
}
