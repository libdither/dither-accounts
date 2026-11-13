/**
 * Matrix event content -> the parts of a MessageFact. Pure functions, no I/O.
 */

import type { AttachmentFact, AttachmentKind, MessageKind } from '@dither-chat/protocol';
import { escapeMarkdown, htmlToMarkdown, stripReplyFallback } from './format.ts';
import type { MxEvent } from './rooms.ts';

/** Event types that become messages. */
export const MESSAGE_TYPES = new Set(['m.room.message', 'm.sticker', 'm.room.encrypted', 'm.poll.start', 'org.matrix.msc3381.poll.start']);

export interface Relation {
  relType?: string;
  eventId?: string;
  key?: string;
  inReplyTo?: string;
  /** Thread messages: m.in_reply_to is only a fallback for clients without threads. */
  fallingBack?: boolean;
}

export function relationOf(content: any): Relation {
  const r = content?.['m.relates_to'];
  if (!r || typeof r !== 'object') return {};
  const out: Relation = {};
  if (typeof r.rel_type === 'string') out.relType = r.rel_type;
  if (typeof r.event_id === 'string') out.eventId = r.event_id;
  if (typeof r.key === 'string') out.key = r.key;
  if (typeof r['m.in_reply_to']?.event_id === 'string') out.inReplyTo = r['m.in_reply_to'].event_id;
  if (r.is_falling_back === true) out.fallingBack = true;
  return out;
}

/** The event that this message is a genuine reply to (thread fallbacks excluded). */
export function replyTarget(rel: Relation): string | undefined {
  if (!rel.inReplyTo) return undefined;
  if (rel.relType === 'm.thread' && rel.fallingBack) return undefined;
  return rel.inReplyTo;
}

export function isRedacted(ev: MxEvent): boolean {
  if (ev.unsigned?.redacted_because || ev.unsigned?.['org.continuwuity.redacted_by']) return true;
  const c = ev.content ?? {};
  switch (ev.type) {
    case 'm.room.message':
      return c.msgtype === undefined && c.body === undefined;
    case 'm.room.encrypted':
      return c.algorithm === undefined && c.ciphertext === undefined;
    case 'm.reaction':
      return c['m.relates_to'] === undefined;
    case 'm.sticker':
      return c.url === undefined && c.body === undefined;
    default:
      return false;
  }
}

/** mentionsSelf: m.mentions.user_ids, or for older clients a body that contains the user id. */
export function mentionsUser(content: any, userId: string): boolean {
  const m = content?.['m.mentions'];
  if (m && typeof m === 'object') return Array.isArray(m.user_ids) && m.user_ids.includes(userId);
  const hay = `${typeof content?.body === 'string' ? content.body : ''}\n${typeof content?.formatted_body === 'string' ? content.formatted_body : ''}`;
  return hay.includes(userId) || hay.includes(encodeURIComponent(userId));
}

const ATTACHMENT: Record<string, AttachmentKind> = { 'm.image': 'image', 'm.video': 'video', 'm.audio': 'audio', 'm.file': 'file' };

/** The `file` of an event with encrypted media: ciphertext at `url`, and the key to it. */
export function encryptedFileOf(content: any): (Record<string, unknown> & { url: string }) | null {
  return typeof content?.file?.url === 'string' ? content.file : null;
}

/**
 * Encrypted media gets the URL mxc://server/id#<event id>. The fragment tells the adapter's fetchMedia
 * that this needs decrypting and which event holds the key. The key itself does not leave the adapter.
 */
export function attachmentOf(content: any, kind: AttachmentKind, eventId?: string): AttachmentFact | null {
  const file = encryptedFileOf(content);
  const url = typeof content?.url === 'string' ? content.url : file ? `${file.url}#${eventId ?? ''}` : null;
  if (!url) return null;
  const info = content.info ?? {};
  const a: AttachmentFact = { kind, url };
  if (typeof info.mimetype === 'string') a.mime = info.mimetype;
  if (Number.isFinite(info.size)) a.size = info.size;
  if (Number.isFinite(info.w)) a.width = info.w;
  if (Number.isFinite(info.h)) a.height = info.h;
  const name = typeof content.filename === 'string' && content.filename ? content.filename : content.body;
  if (typeof name === 'string' && name) a.name = name;
  return a;
}

/** The text of a text-like message as canonical Markdown. */
export function textOf(content: any, isReply: boolean): string {
  if (content?.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string') {
    const md = htmlToMarkdown(content.formatted_body);
    if (md || typeof content.body !== 'string') return md;
  }
  let body = typeof content?.body === 'string' ? content.body : '';
  if (isReply) body = stripReplyFallback(body);
  return body;
}

function extensibleText(x: any): string {
  if (typeof x === 'string') return x;
  if (!x || typeof x !== 'object') return '';
  for (const k of ['m.text', 'org.matrix.msc1767.text', 'body']) {
    const v = x[k];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const plain = v.find((t: any) => !t?.mimetype || t.mimetype === 'text/plain') ?? v[0];
      if (typeof plain?.body === 'string') return plain.body;
    }
  }
  return '';
}

function pollText(content: any): string {
  const p = content?.['m.poll'] ?? content?.['m.poll.start'] ?? content?.['org.matrix.msc3381.poll.start'] ?? {};
  const q = extensibleText(p.question);
  const answers: string[] = Array.isArray(p.answers) ? p.answers.map(extensibleText).filter(Boolean) : [];
  if (!q) return extensibleText(content) || '📊 Poll';
  return [`📊 **${escapeMarkdown(q)}**`, ...answers.map((a) => `- ${escapeMarkdown(a)}`)].join('\n');
}

export interface Rendered {
  kind: MessageKind;
  body: string;
  attachments?: AttachmentFact[];
  extra?: Record<string, unknown>;
}

/**
 * Where a forwarded event came from. Matrix has no forward of its own: clients send the content again. This
 * adapter adds what MSC2723 proposes for that (the original's room, event, sender and time), under its own key
 * until a stable one exists, and reads it back from anyone who sets it.
 */
export const FORWARD_KEY = 'dev.dither.forwarded';

export function forwardOf(content: any): { conversation?: string; message?: string; author?: string; ts?: number } | undefined {
  const f = content?.[FORWARD_KEY];
  if (!f || typeof f !== 'object') return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const out = { conversation: str(f.room_id), message: str(f.event_id), author: str(f.sender), ts: typeof f.origin_server_ts === 'number' ? f.origin_server_ts : undefined };
  return out.message || out.conversation ? out : undefined;
}

/** A message's content made ready to send again elsewhere: no relations, no reply fallback, nobody mentioned. */
export function forwardableContent(content: any): Record<string, any> {
  const c: Record<string, any> = { ...content };
  const wasReply = !!c['m.relates_to']?.['m.in_reply_to'];
  delete c['m.relates_to'];
  delete c['m.new_content'];
  delete c[FORWARD_KEY];
  if (wasReply) {
    if (typeof c.body === 'string') c.body = c.body.replace(/^(> .*\n)+\n/, '');
    if (typeof c.formatted_body === 'string') c.formatted_body = c.formatted_body.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/, '');
  }
  c['m.mentions'] = {};
  return c;
}

/** Content of a message-like event -> kind, body, attachments. null: not shown (e.g. verification requests). */
export function renderContent(type: string, content: any, isReply: boolean, eventId?: string): Rendered | null {
  switch (type) {
    case 'm.room.encrypted':
      return { kind: 'encrypted', body: '' };
    case 'm.sticker': {
      const att = attachmentOf(content, 'image', eventId);
      return { kind: 'sticker', body: typeof content?.body === 'string' ? content.body : '', attachments: att ? [att] : [] };
    }
    case 'm.poll.start':
    case 'org.matrix.msc3381.poll.start':
      return { kind: 'text', body: pollText(content), extra: { poll: true } };
  }
  const msgtype = typeof content?.msgtype === 'string' ? content.msgtype : 'm.text';
  const attKind = ATTACHMENT[msgtype];
  if (attKind) {
    const att = attachmentOf(content, attKind, eventId);
    const hasCaption = typeof content.filename === 'string' && content.filename && typeof content.body === 'string' && content.body !== content.filename;
    const body = hasCaption ? textOf(content, isReply) : typeof content.body === 'string' ? content.body : '';
    return { kind: 'media', body, attachments: att ? [att] : [] };
  }
  switch (msgtype) {
    case 'm.emote': {
      const t = textOf(content, isReply).trim();
      return { kind: 'text', body: t ? `*${t}*` : '', extra: { msgtype } };
    }
    case 'm.notice':
      return { kind: 'text', body: textOf(content, isReply), extra: { msgtype } };
    case 'm.location': {
      const geo = typeof content.geo_uri === 'string' ? content.geo_uri : '';
      const label = textOf(content, isReply);
      return { kind: 'text', body: geo && !label.includes(geo) ? `📍 ${label} (${geo})`.trim() : `📍 ${label}`, extra: { msgtype, geo } };
    }
    case 'm.key.verification.request':
      return null;
    case 'm.server_notice':
      return { kind: 'system', body: textOf(content, isReply), extra: { msgtype } };
    default:
      return { kind: 'text', body: textOf(content, isReply) };
  }
}

/** Plain text used for thread names: the root's body without the reply fallback. */
export function plainTextOf(ev: MxEvent): string {
  const c = ev.content ?? {};
  if (ev.type === 'm.room.encrypted') return 'Encrypted thread';
  const body = typeof c.body === 'string' ? c.body : '';
  return relationOf(c).inReplyTo ? stripReplyFallback(body) : body;
}
