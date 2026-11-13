/**
 * Validated hook objects (raw.ts, validate.ts) → chat protocol facts. Native ids are X's own: user ids (digits),
 * conversation ids as the client names them (legacy one-to-one DMs are "<user>-<user>"), message ids as the client's
 * items carry them. Media is fetched through the page, so attachment URLs are `x-media://<conversation>/<message>/<n>`
 * and the hub asks for them with fetchMedia.
 */
import type * as P from '@dither-chat/protocol';
import { attachmentKind, canonicalReactionKey } from '@dither-chat/protocol';
import type { RawAttachment, RawConversation, RawMessage, RawReaction, RawUser } from './raw.ts';

export function identityFact(u: RawUser, selfId: string | null): P.IdentityFact {
  return {
    nativeId: u.id,
    ...(u.screenName ? { handle: u.screenName } : {}),
    ...(u.displayName ? { displayName: u.displayName } : {}),
    ...(u.avatarUrl && /^https:/.test(u.avatarUrl) ? { avatarUrl: u.avatarUrl } : {}),
    ...(selfId && u.id === selfId ? { isSelf: true } : {}),
  };
}

/** The other person in a one-to-one conversation: from the users the row names, else from a legacy id "<a>-<b>". */
export function peerOf(c: RawConversation, selfId: string | null): string | null {
  const others = c.users.map((u) => u.id).filter((id) => id !== selfId);
  if (others.length === 1) return others[0]!;
  const m = /^(\d+)-(\d+)$/.exec(c.id);
  if (m && selfId) return m[1] === selfId ? m[2]! : m[2] === selfId ? m[1]! : null;
  return others[0] ?? null;
}

export function shapeOf(c: RawConversation, selfId: string | null): P.Shape {
  if (c.group === true) return 'group';
  const others = c.users.filter((u) => u.id !== selfId);
  if (c.group === null && others.length > 1) return 'group';
  const peer = peerOf(c, selfId);
  if (selfId && peer === selfId) return 'self';
  const m = /^(\d+)-(\d+)$/.exec(c.id);
  if (m && m[1] === m[2]) return 'self';
  return 'direct';
}

export function conversationFact(c: RawConversation, selfId: string | null, participants?: string[]): P.ConversationFact {
  const shape = shapeOf(c, selfId);
  const people = new Set<string>();
  if (selfId) people.add(selfId);
  if (shape === 'direct') {
    const peer = peerOf(c, selfId);
    if (peer) people.add(peer);
  } else for (const u of c.users) people.add(u.id);
  for (const p of participants ?? []) people.add(p);
  return {
    nativeId: c.id,
    shape,
    ...(shape === 'group' && c.title ? { name: c.title } : {}),
    ...(shape === 'group' && c.description ? { topic: c.description } : {}),
    ...(shape === 'group' && c.avatarUrl && /^https:/.test(c.avatarUrl) ? { avatarUrl: c.avatarUrl } : {}),
    // XChat conversations are end-to-end encrypted; legacy DMs are not.
    ...(c.legacy === false ? { encrypted: true } : c.legacy === true ? { encrypted: false } : {}),
    ...(c.archived ? { archived: true } : {}),
    ...(c.muted ? { mute: { level: 'none' as const } } : {}),
    ...(people.size ? { participants: [...people] } : {}),
    ...(c.lastTs ? { lastMessageAt: c.lastTs } : {}),
  };
}

export const MEDIA_SCHEME = 'x-media://';
export function mediaRef(conv: string, message: string, index: number): string {
  return `${MEDIA_SCHEME}${encodeURIComponent(conv)}/${encodeURIComponent(message)}/${index}`;
}
export function parseMediaRef(url: string): { conv: string; message: string; index: number } | null {
  if (!url.startsWith(MEDIA_SCHEME)) return null;
  const parts = url.slice(MEDIA_SCHEME.length).split('/');
  if (parts.length !== 3 || !/^\d{1,2}$/.test(parts[2]!)) return null;
  try {
    return { conv: decodeURIComponent(parts[0]!), message: decodeURIComponent(parts[1]!), index: Number(parts[2]) };
  } catch {
    return null;
  }
}

const TYPE_KIND: Record<string, P.AttachmentKind> = { image: 'image', photo: 'image', gif: 'image', video: 'video', audio: 'audio', voice: 'audio', file: 'file', document: 'file' };
export function attachmentFact(conv: string, message: string, a: RawAttachment): P.AttachmentFact {
  const byType = a.type ? TYPE_KIND[a.type.toLowerCase().replace(/[^a-z]/g, '')] : undefined;
  const kind = a.mime ? attachmentKind(a.mime) : (byType ?? 'file');
  return {
    ...(a.id ? { nativeId: a.id } : {}),
    kind,
    ...(a.mime ? { mime: a.mime } : {}),
    ...(a.name ? { name: a.name } : {}),
    ...(a.size !== null ? { size: a.size } : {}),
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    url: mediaRef(conv, message, a.index),
  };
}

/** Reactions on the message itself (X also reacts to single attachments; those are counted in extra, not shown). */
export function reactionFacts(list: RawReaction[], selfId: string | null): P.ReactionFact[] {
  const out = new Map<string, Set<string>>();
  for (const r of list) {
    if (r.attachmentId) continue;
    const key = canonicalReactionKey(r.emoji);
    const set = out.get(key) ?? new Set<string>();
    for (const u of r.users) set.add(u);
    if (r.mine && selfId) set.add(selfId);
    out.set(key, set);
  }
  return [...out.entries()].filter(([, s]) => s.size).map(([key, s]) => ({ key, authors: [...s] }));
}

export interface MessageContext {
  selfId: string | null;
  selfHandle?: string | null;
  /** The message id for a sequence number in this conversation, when known (replies name their target by it). */
  idForSeq?: (seq: string) => string | undefined;
}

export function messageFact(m: RawMessage, ctx: MessageContext): P.MessageFact {
  const author = m.sender ?? (m.mine ? ctx.selfId : null) ?? 'unknown';
  const body = m.undecryptable ? '' : (m.text ?? '');
  const attachments = m.undecryptable ? [] : m.attachments.map((a) => attachmentFact(m.conv, m.id, a));
  const kind: P.MessageKind = m.undecryptable ? 'encrypted' : !body && attachments.length ? 'media' : 'text';
  const replyTo = m.replyTo ? (m.replyTo.id ?? (m.replyTo.seq ? ctx.idForSeq?.(m.replyTo.seq) : undefined)) : undefined;
  const reactions = reactionFacts(m.reactions, ctx.selfId);
  const onAttachments = m.reactions.filter((r) => r.attachmentId).length;
  const handle = ctx.selfHandle;
  const mentionsSelf = !!handle && author !== ctx.selfId && new RegExp(`(^|[^\\w@])@${handle.replace(/[^\w]/g, '')}\\b`, 'i').test(body);
  return {
    nativeId: m.id,
    conversation: m.conv,
    author,
    ts: m.ts!,
    ...(kind !== 'text' ? { kind } : {}),
    body,
    ...(replyTo ? { replyTo } : {}),
    ...(mentionsSelf ? { mentionsSelf: true } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(reactions.length ? { reactions } : {}),
    ...(m.forwarded ? { forward: {} } : {}),
    extra: {
      ...(m.seq ? { seq: m.seq } : {}),
      ...(m.encrypted !== null ? { encrypted: m.encrypted } : {}),
      ...(m.edited ? { edited: true } : {}),
      ...(onAttachments ? { attachmentReactions: onAttachments } : {}),
    },
  };
}

/** Code spans and the rest, so nothing inside code changes. */
function splitCode(text: string): { code: boolean; v: string }[] {
  const out: { code: boolean; v: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/```[\s\S]+?```|`[^`\n]+`/g)) {
    if (m.index! > last) out.push({ code: false, v: text.slice(last, m.index) });
    out.push({ code: true, v: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ code: false, v: text.slice(last) });
  return out;
}

/**
 * dither-chat's Markdown → what an X message says. X has no formatting, so markers go, mentions become @handles and
 * links keep their address. Incoming text is kept as it is.
 */
export function toPlain(body: string, handleOf: (id: string) => string | undefined): string {
  return splitCode(body)
    .map(({ code, v }) => {
      if (code) return v.replace(/^```\w*\n?|```$/g, '').replace(/^`|`$/g, '');
      return v
        .replace(/<@([^>\s]+)>/g, (_, id: string) => `@${handleOf(id) ?? id}`)
        .replace(/<#([^>\s]+)>/g, '#$1')
        .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_, t: string, u: string) => (t === u ? u : `${t} (${u})`))
        .replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, '$1')
        .replace(/__(\S(?:[^_\n]*?\S)?)__/g, '$1')
        .replace(/~~(\S(?:[^~\n]*?\S)?)~~/g, '$1')
        .replace(/\|\|(\S(?:[^|\n]*?\S)?)\|\|/g, '$1')
        .replace(/(^|[\s(])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s.,!?)])/g, '$1$2');
    })
    .join('');
}
