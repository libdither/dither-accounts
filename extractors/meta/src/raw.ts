/**
 * What the page's hook forwards (src/extension/hook.js), and the checks every object passes here before it is mapped:
 * the fields each mapping needs, with their types. What fails is dropped and counted by type (`Drops`), never mapped
 * half-made. The hook checks the same fields before it forwards; this is the second line, for a hook and an
 * extractor that drift apart.
 */

// ---------------------------------------------------------------- LightSpeed (Messenger)
export interface LSThread {
  threadKey: string;
  threadType: number;
  threadName?: string;
  threadPictureUrl?: string;
  lastActivityTimestampMs?: number;
  lastReadWatermarkTimestampMs?: number;
  muteExpireTimeMs?: number;
  folderName?: string;
  parentThreadKey?: string;
  unreadMessageCount?: number;
  isHidden?: boolean;
  threadDescription?: string;
}
export interface LSContact {
  id: string;
  name?: string;
  firstName?: string;
  username?: string;
  profilePictureUrl?: string;
  contactType?: number;
}
export interface LSParticipant {
  threadKey: string;
  contactId: string;
  readWatermarkTimestampMs?: number;
  deliveredWatermarkTimestampMs?: number;
  nickname?: string;
  isAdmin?: boolean;
}
export interface LSMessage {
  threadKey: string;
  messageId: string;
  timestampMs: number;
  senderId: string;
  text?: string;
  offlineThreadingId?: string;
  isAdminMessage?: boolean;
  stickerId?: string;
  isUnsent?: boolean;
  replySourceId?: string;
  mentionOffsets?: string[];
  mentionLengths?: string[];
  mentionIds?: string[];
  isForwarded?: boolean;
  editCount?: number;
  sendStatusV2?: number;
}
export interface LSReaction {
  threadKey: string;
  messageId: string;
  actorId: string;
  reaction: string;
  timestampMs?: number;
}
export interface LSAttachment {
  threadKey: string;
  messageId: string;
  attachmentFbid: string;
  attachmentType?: number;
  filename?: string;
  filesize?: number;
  previewUrl?: string;
  previewUrlMimeType?: string;
  playableUrl?: string;
  playableUrlMimeType?: string;
  previewWidth?: number;
  previewHeight?: number;
  playableDurationMs?: number;
  hasXma?: boolean;
  titleText?: string;
}
export interface LSTyping {
  threadKey: string;
  senderId: string;
  expirationTimestampMs?: number;
}
export interface LSSnapshot {
  threads: LSThread[];
  contacts: LSContact[];
  participants: LSParticipant[];
  messages: LSMessage[];
  reactions: LSReaction[];
  attachments: LSAttachment[];
}
export type LSTable = 'threads' | 'contacts' | 'participants' | 'messages' | 'reactions' | 'attachments' | 'typing_indicator';
export interface LSChange {
  table: LSTable;
  op: 'add' | 'put' | 'delete';
  row: Record<string, unknown>;
  prev?: Record<string, unknown>;
}

// ---------------------------------------------------------------- Slide (Instagram)
export interface SUser {
  fbid?: string;
  igid?: string;
  username?: string;
  name?: string;
  pic?: string;
}
export interface SReceipt {
  fbid: string;
  ts: number;
}
export interface SThread {
  threadFbid: string;
  threadId?: string;
  nodeId?: string;
  title?: string;
  isGroup?: boolean;
  imageUrl?: string;
  lastActivityMs?: number;
  markedUnread?: boolean;
  muted?: boolean;
  users: SUser[];
  receipts: SReceipt[];
}
export interface SAttachment {
  id: string;
  type?: string;
  contentType?: string;
  url?: string;
  preview?: string;
  width?: number;
  height?: number;
  mime?: string;
  name?: string;
}
export interface SReaction {
  emoji: string;
  senderFbid: string;
  ts?: number | null;
}
export interface SMessage {
  messageId: string;
  threadFbid: string;
  senderFbid: string;
  timestampMs: number;
  text?: string;
  otid?: string;
  replyTo?: string;
  sendStatus?: string;
  forwarded?: boolean;
  contentType?: string;
  xmaText?: string;
  attachments?: SAttachment[];
  reactions?: SReaction[];
  edits?: number;
  editedTs?: number;
}
export interface SSnapshot {
  threads: SThread[];
  users: SUser[];
  messages: SMessage[];
}
export interface SRecords {
  messages: SMessage[];
  threads: SThread[];
  users: SUser[];
  deleted: { thread: string; message: string }[];
}

export interface SelfIds {
  /** The id messages and participants name this account by. */
  id: string;
  fb?: string;
  ig?: string;
  eimu?: string;
}

// ---------------------------------------------------------------- checks
export type Drops = Record<string, number>;
type Kind = 'string' | 'number' | 'boolean' | 'strings' | 'array' | 'object';
interface Spec {
  req: Record<string, Kind>;
  opt?: Record<string, Kind>;
}

function is(v: unknown, k: Kind): boolean {
  switch (k) {
    case 'string':
      return typeof v === 'string' && v.length > 0;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'strings':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'array':
      return Array.isArray(v);
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v);
  }
}

/** The object if every required field has its type and every optional one present has its type; else null, counted. */
export function check<T>(type: string, v: unknown, spec: Spec, drops: Drops): T | null {
  if (!v || typeof v !== 'object') return count(type, drops);
  const o = v as Record<string, unknown>;
  for (const [k, kind] of Object.entries(spec.req)) if (!is(o[k], kind)) return count(type, drops);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(spec.req)) out[k] = o[k];
  for (const [k, kind] of Object.entries(spec.opt ?? {})) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!is(o[k], kind) && !(kind === 'string' && o[k] === '')) return count(type, drops);
    out[k] = o[k];
  }
  return out as T;
}
function count(type: string, drops: Drops): null {
  drops[type] = (drops[type] ?? 0) + 1;
  return null;
}

export const SPECS = {
  'ls.thread': {
    req: { threadKey: 'string', threadType: 'number' },
    opt: { threadName: 'string', threadPictureUrl: 'string', lastActivityTimestampMs: 'number', lastReadWatermarkTimestampMs: 'number', muteExpireTimeMs: 'number', folderName: 'string', parentThreadKey: 'string', unreadMessageCount: 'number', isHidden: 'boolean', threadDescription: 'string' },
  },
  'ls.contact': { req: { id: 'string' }, opt: { name: 'string', firstName: 'string', username: 'string', profilePictureUrl: 'string', contactType: 'number' } },
  'ls.participant': { req: { threadKey: 'string', contactId: 'string' }, opt: { readWatermarkTimestampMs: 'number', deliveredWatermarkTimestampMs: 'number', nickname: 'string', isAdmin: 'boolean' } },
  'ls.message': {
    req: { threadKey: 'string', messageId: 'string', timestampMs: 'number', senderId: 'string' },
    opt: { text: 'string', offlineThreadingId: 'string', isAdminMessage: 'boolean', stickerId: 'string', isUnsent: 'boolean', replySourceId: 'string', mentionOffsets: 'strings', mentionLengths: 'strings', mentionIds: 'strings', isForwarded: 'boolean', editCount: 'number', sendStatusV2: 'number' },
  },
  'ls.reaction': { req: { threadKey: 'string', messageId: 'string', actorId: 'string', reaction: 'string' }, opt: { timestampMs: 'number' } },
  'ls.attachment': {
    req: { threadKey: 'string', messageId: 'string', attachmentFbid: 'string' },
    opt: { attachmentType: 'number', filename: 'string', filesize: 'number', previewUrl: 'string', previewUrlMimeType: 'string', playableUrl: 'string', playableUrlMimeType: 'string', previewWidth: 'number', previewHeight: 'number', playableDurationMs: 'number', hasXma: 'boolean', titleText: 'string' },
  },
  'ls.typing': { req: { threadKey: 'string', senderId: 'string' }, opt: { expirationTimestampMs: 'number' } },
  'slide.user': { req: {}, opt: { fbid: 'string', igid: 'string', username: 'string', name: 'string', pic: 'string' } },
  'slide.thread': {
    req: { threadFbid: 'string', users: 'array', receipts: 'array' },
    opt: { threadId: 'string', nodeId: 'string', title: 'string', isGroup: 'boolean', imageUrl: 'string', lastActivityMs: 'number', markedUnread: 'boolean', muted: 'boolean' },
  },
  'slide.message': {
    req: { messageId: 'string', threadFbid: 'string', senderFbid: 'string', timestampMs: 'number' },
    opt: { text: 'string', otid: 'string', replyTo: 'string', sendStatus: 'string', forwarded: 'boolean', contentType: 'string', xmaText: 'string', attachments: 'array', reactions: 'array', edits: 'number', editedTs: 'number' },
  },
  'slide.attachment': { req: { id: 'string' }, opt: { type: 'string', contentType: 'string', url: 'string', preview: 'string', width: 'number', height: 'number', mime: 'string', name: 'string' } },
  'slide.reaction': { req: { emoji: 'string', senderFbid: 'string' }, opt: { ts: 'number' } },
  'slide.receipt': { req: { fbid: 'string', ts: 'number' } },
} satisfies Record<string, Spec>;

const LS_SPEC: Record<LSTable, keyof typeof SPECS> = {
  threads: 'ls.thread',
  contacts: 'ls.contact',
  participants: 'ls.participant',
  messages: 'ls.message',
  reactions: 'ls.reaction',
  attachments: 'ls.attachment',
  typing_indicator: 'ls.typing',
};
export const lsSpecOf = (t: LSTable) => LS_SPEC[t];

export function checkAll<T>(type: keyof typeof SPECS, list: unknown, drops: Drops): T[] {
  if (!Array.isArray(list)) return [];
  const out: T[] = [];
  for (const v of list) {
    const ok = check<T>(type, v, SPECS[type], drops);
    if (ok) out.push(ok);
  }
  return out;
}

export function checkUser(v: unknown, drops: Drops): SUser | null {
  const u = check<SUser>('slide.user', v, SPECS['slide.user'], drops);
  if (u && !u.fbid && !u.igid) return count('slide.user', drops);
  return u;
}
export function checkSlideThread(v: unknown, drops: Drops): SThread | null {
  const t = check<SThread>('slide.thread', v, SPECS['slide.thread'], drops);
  if (!t) return null;
  t.users = (t.users as unknown[]).map((u) => checkUser(u, drops)).filter((u): u is SUser => !!u);
  t.receipts = checkAll<SReceipt>('slide.receipt', t.receipts, drops);
  return t;
}
export function checkSlideMessage(v: unknown, drops: Drops): SMessage | null {
  const m = check<SMessage>('slide.message', v, SPECS['slide.message'], drops);
  if (!m) return null;
  if (m.attachments) m.attachments = checkAll<SAttachment>('slide.attachment', m.attachments, drops);
  if (m.reactions) m.reactions = checkAll<SReaction>('slide.reaction', m.reactions, drops);
  return m;
}
