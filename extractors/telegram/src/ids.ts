/**
 * Native ids for Telegram facts (protocol adapter.ts: every reference is a native id on the account's network).
 *
 * Telegram numbers users, basic groups and channels separately, and message ids are per account in private chats and
 * basic groups but per channel in channels and supergroups. So what two accounts see the same way gets the same id,
 * and what each sees its own way is scoped by the account's own user id:
 *
 *   identity          "<userId>"                  a user, the same for every account
 *                     "channel:<channelId>"       a channel or supergroup posting as itself
 *   conversation      "dm:<self>:<userId>"        a private chat (Saved Messages: dm:<self>:<self>)
 *                     "group:<self>:<chatId>"     a basic group (its message ids are this account's)
 *                     "channel:<channelId>"       a supergroup or a broadcast channel
 *                     "channel:<channelId>/<topicId>"  a forum topic (General is topic 1)
 *   message           "<base conversation>#<msgId>"  in a topic too: ids belong to the channel, not the topic
 *   media             "tg://media/<base conversation>/<msgId>"   fetched again (file references expire)
 *   avatar            "tg://avatar/<peer>/<photoId>?dc=<dc>"   peer "u<id>" | "c<id>" (basic group) | "ch<id>"
 *                     "tg://invite/<hash>/<photoId>?dc=<dc>"   the picture of a chat an invite link leads to, before
 *                                                               joining (no peer to ask for it by: the link is looked up again)
 *   custom emoji      "tg://emoji/<documentId>"
 *   join request      "join:<conversation>:<userId>"   someone asks to join a group or channel you admin
 */

export type PeerKind = 'user' | 'chat' | 'channel';
export interface PeerRef {
  kind: PeerKind;
  /** Decimal, as Telegram's ids no longer fit in 32 bits but do fit in a double. */
  id: number;
}

export interface ConvRef {
  peer: PeerRef;
  /** A forum topic of a channel. */
  topic?: number;
}

export const userId = (id: number | string) => String(id);
export const channelIdentity = (id: number | string) => `channel:${id}`;

export function convId(self: number | string, peer: PeerRef, topic?: number): string {
  if (peer.kind === 'user') return `dm:${self}:${peer.id}`;
  if (peer.kind === 'chat') return `group:${self}:${peer.id}`;
  return topic ? `channel:${peer.id}/${topic}` : `channel:${peer.id}`;
}

/** The conversation a message's id belongs to: the channel for a topic. */
export const baseConv = (conv: string) => conv.replace(/\/\d+$/, '');

export function parseConv(conv: string): ConvRef | null {
  let m = conv.match(/^dm:(\d+):(\d+)$/);
  if (m) return { peer: { kind: 'user', id: Number(m[2]) } };
  m = conv.match(/^group:(\d+):(\d+)$/);
  if (m) return { peer: { kind: 'chat', id: Number(m[2]) } };
  m = conv.match(/^channel:(\d+)(?:\/(\d+))?$/);
  if (m) return { peer: { kind: 'channel', id: Number(m[1]) }, ...(m[2] ? { topic: Number(m[2]) } : {}) };
  return null;
}

/** The account a scoped conversation belongs to (dm:/group:), or null for a channel. */
export function convOwner(conv: string): number | null {
  const m = conv.match(/^(?:dm|group):(\d+):/);
  return m ? Number(m[1]) : null;
}

export const msgId = (conv: string, id: number) => `${baseConv(conv)}#${id}`;

export function parseMsg(native: string): { conv: string; ref: ConvRef; id: number } | null {
  const m = native.match(/^(.+)#(\d+)$/);
  if (!m) return null;
  const ref = parseConv(m[1]);
  return ref ? { conv: m[1], ref, id: Number(m[2]) } : null;
}

export const mediaUrl = (conv: string, id: number) => `tg://media/${baseConv(conv)}/${id}`;
export function parseMediaUrl(url: string): { conv: string; id: number } | null {
  const m = url.match(/^tg:\/\/media\/(.+)\/(\d+)$/);
  return m && parseConv(m[1]) ? { conv: m[1], id: Number(m[2]) } : null;
}

const PEER_LETTER: Record<PeerKind, string> = { user: 'u', chat: 'c', channel: 'ch' };
export const avatarUrl = (peer: PeerRef, photoId: { toString(): string }, dc?: number) => `tg://avatar/${PEER_LETTER[peer.kind]}${peer.id}/${photoId.toString()}${dc ? `?dc=${dc}` : ''}`;
export function parseAvatarUrl(url: string): { peer: PeerRef; photoId: string; dc?: number } | null {
  const m = url.match(/^tg:\/\/avatar\/(u|c|ch)(\d+)\/(-?\d+)(?:\?dc=(\d+))?$/);
  if (!m) return null;
  const kind: PeerKind = m[1] === 'u' ? 'user' : m[1] === 'c' ? 'chat' : 'channel';
  return { peer: { kind, id: Number(m[2]) }, photoId: m[3], ...(m[4] ? { dc: Number(m[4]) } : {}) };
}

export const inviteAvatarUrl = (hash: string, photoId: { toString(): string }, dc?: number) => `tg://invite/${hash}/${photoId.toString()}${dc ? `?dc=${dc}` : ''}`;
export function parseInviteAvatarUrl(url: string): { hash: string; photoId: string } | null {
  const m = url.match(/^tg:\/\/invite\/([A-Za-z0-9_-]{1,64})\/(-?\d+)(?:\?dc=\d+)?$/);
  return m ? { hash: m[1], photoId: m[2] } : null;
}

/** A join request: who asks to join which of your groups or channels. */
export const joinRequestId = (conv: string, user: number | string) => `join:${conv}:${user}`;
export function parseJoinRequestId(id: string): { conv: string; ref: ConvRef; user: number } | null {
  const m = id.match(/^join:(.+):(\d+)$/);
  const ref = m ? parseConv(m[1]) : null;
  return m && ref && !ref.topic && ref.peer.kind !== 'user' ? { conv: m[1], ref, user: Number(m[2]) } : null;
}

export const emojiUrl = (documentId: { toString(): string }) => `tg://emoji/${documentId.toString()}`;
export const parseEmojiUrl = (url: string) => url.match(/^tg:\/\/emoji\/(-?\d+)$/)?.[1] ?? null;

/** A custom emoji reaction's key. */
export const customKey = (documentId: { toString(): string }) => `custom:${documentId.toString()}`;
export const parseCustomKey = (key: string) => key.match(/^custom:(-?\d+)$/)?.[1] ?? null;

/** Telegram's own marked id (Bot API style), for a fact the pane lists: users as is, basic groups -id, channels -100id. */
export function markedId(peer: PeerRef): string {
  return peer.kind === 'user' ? String(peer.id) : peer.kind === 'chat' ? `-${peer.id}` : `-100${peer.id}`;
}
