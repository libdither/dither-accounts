/**
 * The hook's rows and records as dither-chat facts (packages/chat-protocol adapter.ts), for both backends:
 * LightSpeed tables (Messenger, and Instagram if it runs on them) and the Slide records of Instagram's Relay store.
 *
 * A Mapper remembers what it has said (identities, conversations, the newest messages, reactions), so a change says
 * only what changed: a reaction as a reaction event, an unsent message as a delete, an edit as the message again with
 * editedTs. Pure: no I/O, events come back as arrays, which is what the unit tests read.
 */
import {
  type AdapterEvent,
  type AttachmentFact,
  type AttachmentKind,
  attachmentKind,
  canonicalReactionKey,
  type ConversationFact,
  type IdentityFact,
  type MessageFact,
  type NativeMute,
  type Network,
  type ReactionFact,
} from '@dither-chat/protocol';
import {
  check,
  checkAll,
  checkSlideMessage,
  checkSlideThread,
  checkUser,
  type Drops,
  type LSAttachment,
  type LSChange,
  type LSContact,
  type LSMessage,
  type LSParticipant,
  type LSReaction,
  type LSThread,
  type LSTyping,
  lsSpecOf,
  type SAttachment,
  type SelfIds,
  type SMessage,
  type SRecords,
  type SThread,
  type SUser,
  SPECS,
} from './raw.ts';

export type Ev = AdapterEvent;

/** A message newer than this, and newer than anything known in its chat, is live (notifies); anything else backfill. */
export const LIVE_WINDOW_MS = 10 * 60_000;
const E2EE_TYPES = new Set([15, 16]);
/** LightSpeed thread types: 1 one-to-one, 2 group, 15 and 16 their end-to-end encrypted twins. */
const DIRECT_TYPES = new Set([1, 15]);

// ------------------------------------------------------------------- media
/**
 * Attachment and picture links are opaque to the hub (`meta-media:`), so it always asks the extractor, which asks
 * the page for the current link (Meta's links are signed and expire) and fetches it as the browser would.
 */
export interface MediaLocator {
  /** ls | sl | url */
  k: 'ls' | 'sl' | 'url';
  /** chat, message, attachment */
  t?: string;
  m?: string;
  a?: string;
  /** which link: the full file or its preview */
  f?: 'full' | 'preview';
  /** the link as last seen */
  u?: string;
}
export const MEDIA_SCHEME = 'meta-media:';
export function mediaUrl(loc: MediaLocator): string {
  return MEDIA_SCHEME + Buffer.from(JSON.stringify(loc)).toString('base64url');
}
export function parseMediaUrl(url: string): MediaLocator | null {
  if (!url.startsWith(MEDIA_SCHEME)) return null;
  try {
    const v = JSON.parse(Buffer.from(url.slice(MEDIA_SCHEME.length), 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object' || !['ls', 'sl', 'url'].includes(v.k)) return null;
    for (const k of ['t', 'm', 'a', 'u']) if (v[k] !== undefined && typeof v[k] !== 'string') return null;
    if (v.f !== undefined && v.f !== 'full' && v.f !== 'preview') return null;
    return v as MediaLocator;
  } catch {
    return null;
  }
}
const picture = (u: string | undefined) => (u ? mediaUrl({ k: 'url', u }) : undefined);

// ------------------------------------------------------------------- helpers
function mute(untilMs: number | undefined, now: number): NativeMute | undefined {
  if (untilMs === undefined || untilMs === 0) return undefined;
  if (untilMs < 0) return { level: 'none' };
  return untilMs > now ? { level: 'none', until: untilMs } : undefined;
}
/** Mentions as <@id>, from LightSpeed's offsets and lengths (UTF-16 units, as JS strings count). */
export function withMentions(text: string, offsets?: string[], lengths?: string[], ids?: string[]): string {
  if (!offsets?.length || !lengths?.length || !ids?.length) return text;
  const spans = offsets
    .map((o, i) => ({ at: Number(o), len: Number(lengths[i]), id: ids[i] }))
    .filter((s) => Number.isInteger(s.at) && Number.isInteger(s.len) && s.at >= 0 && s.len > 0 && s.id && s.at + s.len <= text.length)
    .sort((a, b) => b.at - a.at);
  let out = text;
  let last = Infinity;
  for (const s of spans) {
    if (s.at + s.len > last) continue; // overlapping: keep the later one
    out = out.slice(0, s.at) + `<@${s.id}>` + out.slice(s.at + s.len);
    last = s.at;
  }
  return out;
}
/** LightSpeed attachment types (messagix table enums): 1 sticker, 2 image, 3 animated image, 4 video, 5 audio, 6 file. */
const LS_ATTACHMENT_KIND: Record<number, AttachmentKind> = { 1: 'image', 2: 'image', 3: 'image', 4: 'video', 5: 'audio', 6: 'file' };
function lsAttachmentKind(a: LSAttachment): AttachmentKind {
  const mime = a.playableUrlMimeType || a.previewUrlMimeType;
  if (mime) return attachmentKind(mime);
  return LS_ATTACHMENT_KIND[a.attachmentType ?? -1] ?? 'file';
}
function slideKind(a: SAttachment): AttachmentKind {
  if (a.mime) return attachmentKind(a.mime);
  const t = `${a.type ?? ''} ${a.contentType ?? ''}`;
  if (/Video/i.test(t)) return 'video';
  if (/Audio|Voice/i.test(t)) return 'audio';
  if (/Image|Photo|Animated|Sticker|Gif/i.test(t)) return 'image';
  return a.url && !a.preview ? 'file' : 'image';
}
const sig = (v: unknown) => JSON.stringify(v);

interface KnownMessage {
  conversation: string;
  ts: number;
  sig: string;
  fact: MessageFact;
}

export class Mapper {
  readonly drops: Drops = {};
  self: SelfIds = { id: '' };
  private identities = new Map<string, string>();
  private conversations = new Map<string, ConversationFact>();
  private convSig = new Map<string, string>();
  private members = new Map<string, Set<string>>();
  private types = new Map<string, number>();
  private newest = new Map<string, number>();
  /** messageId -> what was said about it. */
  private messages = new Map<string, KnownMessage>();
  /** conversation -> its known messages, oldest first (for receipts). */
  private byConv = new Map<string, { id: string; ts: number }[]>();
  /** LightSpeed rows kept to rebuild a message when its attachments or reactions arrive. */
  private lsRows = new Map<string, LSMessage>();
  private lsAtt = new Map<string, Map<string, LSAttachment>>();
  /** `${conversation}\n${message}` -> actor -> reaction key. */
  private reactions = new Map<string, Map<string, string>>();
  private readTs = new Map<string, number>();
  private receiptTs = new Map<string, number>();
  /** Instagram: an id by which messages name a person, for each id a user record gives. */
  private igToFb = new Map<string, string>();

  constructor(
    readonly network: Network,
    private now: () => number = Date.now,
  ) {}

  get counts() {
    return { identities: this.identities.size, conversations: this.conversations.size, messages: this.messages.size };
  }
  conversation(id: string): ConversationFact | undefined {
    return this.conversations.get(id);
  }
  isEncrypted(id: string): boolean {
    return E2EE_TYPES.has(this.types.get(id) ?? -1);
  }
  isGroup(id: string): boolean {
    return this.conversations.get(id)?.shape === 'group';
  }
  newestIn(conversation: string): { id: string; ts: number } | undefined {
    return this.byConv.get(conversation)?.at(-1);
  }
  oldestIn(conversation: string): { id: string; ts: number } | undefined {
    return this.byConv.get(conversation)?.[0];
  }
  knownMessage(id: string): { conversation: string; ts: number } | undefined {
    const m = this.messages.get(id);
    return m && { conversation: m.conversation, ts: m.ts };
  }

  // ----------------------------------------------------------- shared parts
  /** What is known of a person grows: a record with fewer fields (Instagram sends several) never takes any away. */
  private identity(f: IdentityFact, out: Ev[]) {
    if (f.nativeId === this.self.id) f.isSelf = true;
    const prev = this.people.get(f.nativeId);
    const merged: IdentityFact = { ...prev, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '')) } as IdentityFact;
    const s = sig(merged);
    if (this.identities.get(f.nativeId) === s) return;
    this.identities.set(f.nativeId, s);
    this.people.set(f.nativeId, merged);
    out.push({ t: 'identity', identity: merged });
  }
  private people = new Map<string, IdentityFact>();
  private conv(f: ConversationFact, out: Ev[]) {
    const s = sig(f);
    if (this.convSig.get(f.nativeId) === s) return;
    this.convSig.set(f.nativeId, s);
    this.conversations.set(f.nativeId, f);
    out.push({ t: 'conversation', conversation: f });
  }
  private isLive(conversation: string, ts: number): boolean {
    const newest = this.newest.get(conversation) ?? 0;
    return ts > newest && ts > this.now() - LIVE_WINDOW_MS;
  }
  private index(conversation: string, id: string, ts: number) {
    if (ts > (this.newest.get(conversation) ?? 0)) this.newest.set(conversation, ts);
    const list = this.byConv.get(conversation) ?? [];
    if (!list.some((x) => x.id === id)) {
      list.push({ id, ts });
      list.sort((a, b) => a.ts - b.ts);
      if (list.length > 400) list.splice(0, list.length - 400);
      this.byConv.set(conversation, list);
    }
  }
  /** Say a message, if it differs from what was said; with live set by the window unless given. */
  private message(fact: MessageFact, out: Ev[], live?: boolean) {
    const known = this.messages.get(fact.nativeId);
    const s = sig({ ...fact, reactions: undefined });
    if (known && known.sig === s) return;
    const isLive = known ? false : (live ?? this.isLive(fact.conversation, fact.ts));
    this.messages.set(fact.nativeId, { conversation: fact.conversation, ts: fact.ts, sig: s, fact });
    if (this.messages.size > 20000) this.messages.delete(this.messages.keys().next().value!);
    this.index(fact.conversation, fact.nativeId, fact.ts);
    out.push({ t: 'message', message: fact, live: isLive });
  }
  private deleted(conversation: string, id: string, out: Ev[]) {
    if (!this.messages.has(id)) return;
    this.messages.delete(id);
    this.reactions.delete(`${conversation}\n${id}`);
    const list = this.byConv.get(conversation);
    if (list) this.byConv.set(conversation, list.filter((x) => x.id !== id));
    out.push({ t: 'delete', conversation, nativeId: id });
  }
  /** Reactions as they now stand on one message: events for what changed (one each per person on these networks). */
  private reactionsNow(conversation: string, message: string, now: Map<string, string>, out: Ev[], quiet: boolean) {
    const key = `${conversation}\n${message}`;
    const before = this.reactions.get(key) ?? new Map<string, string>();
    this.reactions.set(key, now);
    if (quiet) return;
    for (const [actor, k] of before) {
      if (now.get(actor) !== k) out.push({ t: 'reaction', conversation, message, author: actor, key: k, remove: true });
    }
    for (const [actor, k] of now) {
      if (before.get(actor) !== k) out.push({ t: 'reaction', conversation, message, author: actor, key: k });
    }
  }
  private reactionFacts(by: Map<string, string>): ReactionFact[] {
    const keys = new Map<string, string[]>();
    for (const [actor, k] of by) keys.set(k, [...(keys.get(k) ?? []), actor]);
    return [...keys].map(([key, authors]) => ({ key, authors }));
  }
  /** Someone else read (or got) messages up to a time: the newest known message at or before it. */
  private receipt(conversation: string, who: string, ts: number, state: 'read' | 'delivered', out: Ev[]) {
    if (!ts || who === this.self.id) return;
    const k = `${conversation}\n${who}\n${state}`;
    if ((this.receiptTs.get(k) ?? 0) >= ts) return;
    this.receiptTs.set(k, ts);
    const upTo = (this.byConv.get(conversation) ?? []).filter((m) => m.ts <= ts).at(-1);
    if (upTo) out.push({ t: 'receipt', conversation, messages: [upTo.id], who, state, ts });
  }
  private read(conversation: string, ts: number | undefined, unread: number | undefined, out: Ev[]) {
    if (!ts) return;
    if ((this.readTs.get(conversation) ?? 0) >= ts) return;
    this.readTs.set(conversation, ts);
    out.push({ t: 'read', conversation, upToTs: ts, ...(unread !== undefined ? { unread } : {}) });
  }

  // =========================================================== LightSpeed
  private lsContact(c: LSContact, out: Ev[]) {
    const f: IdentityFact = { nativeId: c.id };
    if (c.name || c.firstName) f.displayName = c.name || c.firstName;
    if (c.username) f.handle = c.username;
    if (c.profilePictureUrl) f.avatarUrl = picture(c.profilePictureUrl);
    this.identity(f, out);
  }
  private lsThread(t: LSThread, out: Ev[]) {
    this.types.set(t.threadKey, t.threadType);
    const members = [...(this.members.get(t.threadKey) ?? [])];
    let shape: ConversationFact['shape'] = DIRECT_TYPES.has(t.threadType) ? 'direct' : 'group';
    if (members.length === 1 && members[0] === this.self.id) shape = 'self';
    const f: ConversationFact = { nativeId: t.threadKey, shape };
    if (shape === 'group' && t.threadName) f.name = t.threadName;
    if (t.threadDescription) f.topic = t.threadDescription;
    if (shape === 'group' && t.threadPictureUrl) f.avatarUrl = picture(t.threadPictureUrl);
    if (E2EE_TYPES.has(t.threadType)) f.encrypted = true;
    if (t.folderName === 'archived') f.archived = true;
    if (members.length) f.participants = members.sort();
    const m = mute(t.muteExpireTimeMs, this.now());
    if (m) f.mute = m;
    if (t.lastActivityTimestampMs) f.lastMessageAt = t.lastActivityTimestampMs;
    this.conv(f, out);
  }
  private lsFact(m: LSMessage): MessageFact {
    const atts = [...(this.lsAtt.get(m.messageId)?.values() ?? [])].sort((a, b) => a.attachmentFbid.localeCompare(b.attachmentFbid));
    const attachments: AttachmentFact[] = [];
    for (const a of atts) {
      const url = a.playableUrl || a.previewUrl;
      if (!url) continue; // a link preview with nothing to fetch
      const f: AttachmentFact = { nativeId: a.attachmentFbid, kind: lsAttachmentKind(a), url: mediaUrl({ k: 'ls', t: m.threadKey, m: m.messageId, a: a.attachmentFbid, f: 'full', u: url }) };
      const mime = a.playableUrlMimeType || a.previewUrlMimeType;
      if (mime) f.mime = mime;
      if (a.filename) f.name = a.filename;
      if (a.filesize) f.size = a.filesize;
      if (a.previewWidth) f.width = a.previewWidth;
      if (a.previewHeight) f.height = a.previewHeight;
      attachments.push(f);
    }
    const fact: MessageFact = {
      nativeId: m.messageId,
      conversation: m.threadKey,
      author: m.senderId,
      ts: m.timestampMs,
      body: withMentions(m.text ?? '', m.mentionOffsets, m.mentionLengths, m.mentionIds),
    };
    if (m.isAdminMessage) fact.kind = 'system';
    else if (m.stickerId) fact.kind = 'sticker';
    else if (attachments.length && !fact.body) fact.kind = 'media';
    if (m.replySourceId) fact.replyTo = m.replySourceId;
    if (attachments.length) fact.attachments = attachments;
    if (m.isForwarded) fact.forward = {};
    if (m.mentionIds?.includes(this.self.id)) fact.mentionsSelf = true;
    return fact;
  }
  private lsMessage(m: LSMessage, out: Ev[], live?: boolean) {
    if (m.isUnsent) {
      this.lsRows.delete(m.messageId);
      return this.deleted(m.threadKey, m.messageId, out);
    }
    const prev = this.lsRows.get(m.messageId);
    this.lsRows.set(m.messageId, m);
    if (this.lsRows.size > 5000) this.lsRows.delete(this.lsRows.keys().next().value!);
    const fact = this.lsFact(m);
    const known = this.messages.get(m.messageId);
    if (known && prev && ((m.editCount ?? 0) > (prev.editCount ?? 0) || (prev.text ?? '') !== (m.text ?? ''))) fact.editedTs = this.now();
    else if (known?.fact.editedTs) fact.editedTs = known.fact.editedTs;
    this.message(fact, out, live);
  }

  /** Everything the hook read at start: identities, then chats, then messages with their reactions (backfill). */
  lsSnapshot(raw: unknown, self: SelfIds): Ev[] {
    this.self = self;
    const out: Ev[] = [];
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const contacts = checkAll<LSContact>('ls.contact', s.contacts, this.drops);
    const threads = checkAll<LSThread>('ls.thread', s.threads, this.drops);
    const parts = checkAll<LSParticipant>('ls.participant', s.participants, this.drops);
    const messages = checkAll<LSMessage>('ls.message', s.messages, this.drops);
    const reactions = checkAll<LSReaction>('ls.reaction', s.reactions, this.drops);
    const attachments = checkAll<LSAttachment>('ls.attachment', s.attachments, this.drops);
    for (const c of contacts) this.lsContact(c, out);
    for (const p of parts) this.members.set(p.threadKey, new Set([...(this.members.get(p.threadKey) ?? []), p.contactId]));
    for (const t of threads) this.lsThread(t, out);
    for (const a of attachments) {
      const m = this.lsAtt.get(a.messageId) ?? new Map();
      m.set(a.attachmentFbid, a);
      this.lsAtt.set(a.messageId, m);
    }
    const byMsg = new Map<string, Map<string, string>>();
    for (const r of reactions) {
      const m = byMsg.get(r.messageId) ?? new Map<string, string>();
      m.set(r.actorId, canonicalReactionKey(r.reaction));
      byMsg.set(r.messageId, m);
    }
    for (const m of messages.sort((a, b) => a.timestampMs - b.timestampMs)) {
      if (m.isUnsent) continue;
      this.lsRows.set(m.messageId, m);
      if (m.offlineThreadingId) this.otids.set(m.offlineThreadingId, { id: m.messageId, conversation: m.threadKey });
      const fact = this.lsFact(m);
      const rs = byMsg.get(m.messageId);
      if (rs?.size) fact.reactions = this.reactionFacts(rs);
      this.message(fact, out, false);
      if (rs) this.reactionsNow(m.threadKey, m.messageId, rs, out, true);
    }
    for (const t of threads) this.read(t.threadKey, t.lastReadWatermarkTimestampMs, t.unreadMessageCount, out);
    for (const p of parts) {
      if (p.readWatermarkTimestampMs) this.receipt(p.threadKey, p.contactId, p.readWatermarkTimestampMs, 'read', out);
    }
    return out;
  }

  /** History the hook read or fetched: backfill, never live. */
  lsHistory(raw: unknown): { events: Ev[]; count: number } {
    const out: Ev[] = [];
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const messages = checkAll<LSMessage>('ls.message', s.messages, this.drops);
    for (const a of checkAll<LSAttachment>('ls.attachment', s.attachments, this.drops)) {
      const m = this.lsAtt.get(a.messageId) ?? new Map();
      m.set(a.attachmentFbid, a);
      this.lsAtt.set(a.messageId, m);
    }
    const byMsg = new Map<string, Map<string, string>>();
    for (const r of checkAll<LSReaction>('ls.reaction', s.reactions, this.drops)) {
      const m = byMsg.get(r.messageId) ?? new Map<string, string>();
      m.set(r.actorId, canonicalReactionKey(r.reaction));
      byMsg.set(r.messageId, m);
    }
    let count = 0;
    for (const m of messages) {
      if (m.isUnsent) continue;
      count++;
      if (m.offlineThreadingId && !this.otids.has(m.offlineThreadingId)) this.otids.set(m.offlineThreadingId, { id: m.messageId, conversation: m.threadKey });
      const fact = this.lsFact(m);
      const rs = byMsg.get(m.messageId);
      if (rs?.size) fact.reactions = this.reactionFacts(rs);
      this.message(fact, out, false);
      if (rs) this.reactionsNow(m.threadKey, m.messageId, rs, out, true);
    }
    return { events: out, count };
  }

  /** Rows as the client writes them. Repeats (the same row written again) say nothing. */
  lsChanges(changes: unknown): Ev[] {
    const out: Ev[] = [];
    if (!Array.isArray(changes)) return out;
    for (const c of changes as LSChange[]) {
      if (!c || typeof c !== 'object' || !['add', 'put', 'delete'].includes(c.op)) {
        this.drops['ls.change'] = (this.drops['ls.change'] ?? 0) + 1;
        continue;
      }
      const spec = typeof c.table === 'string' ? lsSpecOf(c.table) : undefined;
      if (!spec) continue;
      const row = check<any>(spec, c.row, SPECS[spec], this.drops);
      if (!row) continue;
      this.lsChange(c.table, c.op, row, out);
    }
    return out;
  }
  private lsChange(table: string, op: LSChange['op'], row: any, out: Ev[]) {
    switch (table) {
      case 'contacts':
        if (op !== 'delete') this.lsContact(row as LSContact, out);
        return;
      case 'participants': {
        const p = row as LSParticipant;
        const set = this.members.get(p.threadKey) ?? new Set<string>();
        const had = set.has(p.contactId);
        if (op === 'delete') set.delete(p.contactId);
        else set.add(p.contactId);
        this.members.set(p.threadKey, set);
        const conv = this.conversations.get(p.threadKey);
        if (conv && had !== (op !== 'delete')) {
          const f = { ...conv, participants: [...set].sort() };
          this.conv(f, out);
        }
        if (op !== 'delete') {
          if (p.readWatermarkTimestampMs) this.receipt(p.threadKey, p.contactId, p.readWatermarkTimestampMs, 'read', out);
          if (p.deliveredWatermarkTimestampMs) this.receipt(p.threadKey, p.contactId, p.deliveredWatermarkTimestampMs, 'delivered', out);
        }
        return;
      }
      case 'threads': {
        const t = row as LSThread;
        if (op === 'delete' || t.isHidden) {
          if (this.conversations.has(t.threadKey)) {
            this.conversations.delete(t.threadKey);
            this.convSig.delete(t.threadKey);
            out.push({ t: 'leave', kind: 'conversation', nativeId: t.threadKey });
          }
          return;
        }
        this.lsThread(t, out);
        this.read(t.threadKey, t.lastReadWatermarkTimestampMs, t.unreadMessageCount, out);
        return;
      }
      case 'messages': {
        const m = row as LSMessage;
        if (op === 'delete') {
          // A row the client replaces (its optimistic copy of a message sent here) goes the same way: only a
          // message the hub was told about, and not written again under the same offline id, is gone.
          if (this.messages.has(m.messageId)) this.pendingDelete.set(m.messageId, { conversation: m.threadKey, otid: m.offlineThreadingId, at: this.now() });
          return;
        }
        this.pendingDelete.delete(m.messageId);
        if (m.offlineThreadingId) {
          // The same message under another id (the client's optimistic copy, replaced by the server's): the old
          // one is gone, said once.
          for (const [id, d] of this.pendingDelete) {
            if (d.otid === m.offlineThreadingId && id !== m.messageId) {
              this.pendingDelete.delete(id);
              this.deleted(d.conversation, id, out);
            }
          }
          const was = this.otids.get(m.offlineThreadingId);
          if (was && was.id !== m.messageId && this.messages.has(was.id)) this.deleted(was.conversation, was.id, out);
          this.otids.set(m.offlineThreadingId, { id: m.messageId, conversation: m.threadKey });
          if (this.otids.size > 2000) this.otids.delete(this.otids.keys().next().value!);
          // Our own new message waits a moment, so the server's copy usually replaces the optimistic one first.
          if (m.senderId === this.self.id && !this.messages.has(m.messageId) && !m.isUnsent) {
            this.ownHeld.set(m.offlineThreadingId, { m, at: this.now() });
            return;
          }
        }
        this.lsMessage(m, out);
        return;
      }
      case 'attachments': {
        const a = row as LSAttachment;
        const map = this.lsAtt.get(a.messageId) ?? new Map<string, LSAttachment>();
        if (op === 'delete') map.delete(a.attachmentFbid);
        else map.set(a.attachmentFbid, a);
        this.lsAtt.set(a.messageId, map);
        const m = this.lsRows.get(a.messageId);
        if (m) this.lsMessage(m, out);
        return;
      }
      case 'reactions': {
        const r = row as LSReaction;
        const key = `${r.threadKey}\n${r.messageId}`;
        const now = new Map(this.reactions.get(key) ?? []);
        if (op === 'delete' || !r.reaction) now.delete(r.actorId);
        else now.set(r.actorId, canonicalReactionKey(r.reaction));
        this.reactionsNow(r.threadKey, r.messageId, now, out, false);
        return;
      }
      case 'typing_indicator': {
        const ty = row as LSTyping;
        if (ty.senderId === this.self.id) return;
        out.push({ t: 'typing', conversation: ty.threadKey, author: ty.senderId, ...(op === 'delete' ? { stop: true } : {}) });
        return;
      }
    }
  }
  private pendingDelete = new Map<string, { conversation: string; otid?: string; at: number }>();
  private otids = new Map<string, { id: string; conversation: string }>();
  private ownHeld = new Map<string, { m: LSMessage; at: number }>();
  /** Our own messages as they were finally said: what a send waits for. */
  readonly ownSaid: { conversation: string; id: string; otid?: string; ts: number }[] = [];
  /**
   * Call every second or so: deletions that were not a replacement after all, and our own messages that have
   * waited long enough.
   */
  settle(olderThanMs = 1500): Ev[] {
    const out: Ev[] = [];
    for (const [id, d] of this.pendingDelete) {
      if (this.now() - d.at < olderThanMs) continue;
      this.pendingDelete.delete(id);
      this.deleted(d.conversation, id, out);
    }
    for (const [otid, h] of this.ownHeld) {
      if (this.now() - h.at < olderThanMs) continue;
      this.ownHeld.delete(otid);
      const now = this.otids.get(otid);
      if (now && now.id !== h.m.messageId) continue; // replaced meanwhile; the newer row is held or said
      this.lsMessage(h.m, out);
      this.ownSaid.push({ conversation: h.m.threadKey, id: h.m.messageId, otid, ts: h.m.timestampMs });
      if (this.ownSaid.length > 100) this.ownSaid.shift();
    }
    return out;
  }

  // ================================================================= Slide
  private slId(u: SUser): string | null {
    if (u.fbid) return u.fbid;
    if (u.igid) return this.igToFb.get(u.igid) ?? `ig:${u.igid}`;
    return null;
  }
  private slUser(u: SUser, out: Ev[]) {
    if (u.fbid && u.igid) this.igToFb.set(u.igid, u.fbid);
    const id = this.slId(u);
    if (!id) return;
    const f: IdentityFact = { nativeId: id };
    if (u.name) f.displayName = u.name;
    if (u.username) f.handle = u.username;
    if (u.pic) f.avatarUrl = picture(u.pic);
    this.identity(f, out);
  }
  private slThread(t: SThread, out: Ev[]) {
    for (const u of t.users) this.slUser(u, out);
    const members = new Set(t.users.map((u) => this.slId(u)).filter((x): x is string => !!x));
    if (this.self.id) members.add(this.self.id);
    this.members.set(t.threadFbid, members);
    const group = t.isGroup ?? members.size > 2;
    const f: ConversationFact = { nativeId: t.threadFbid, shape: group ? 'group' : members.size <= 1 ? 'self' : 'direct' };
    if (group && t.title) f.name = t.title;
    if (group && t.imageUrl) f.avatarUrl = picture(t.imageUrl);
    f.participants = [...members].sort();
    if (t.muted) f.mute = { level: 'none' };
    if (t.lastActivityMs) f.lastMessageAt = t.lastActivityMs;
    this.conv(f, out);
  }
  private slFact(m: SMessage): MessageFact {
    const fact: MessageFact = { nativeId: m.messageId, conversation: m.threadFbid, author: m.senderFbid, ts: m.timestampMs, body: m.text ?? m.xmaText ?? '' };
    const atts: AttachmentFact[] = [];
    for (const a of m.attachments ?? []) {
      const url = a.url || a.preview;
      if (!url) continue;
      const f: AttachmentFact = { nativeId: a.id, kind: slideKind(a), url: mediaUrl({ k: 'sl', t: m.threadFbid, m: m.messageId, a: a.id, f: a.url ? 'full' : 'preview', u: url }) };
      if (a.mime) f.mime = a.mime;
      if (a.name) f.name = a.name;
      if (a.width) f.width = a.width;
      if (a.height) f.height = a.height;
      atts.push(f);
    }
    if (atts.length) fact.attachments = atts;
    const ct = m.contentType ?? '';
    if (/Sticker/i.test(ct)) fact.kind = 'sticker';
    else if (/AdminText|Action/i.test(ct)) fact.kind = 'system';
    else if (atts.length && !fact.body) fact.kind = 'media';
    if (m.replyTo) fact.replyTo = m.replyTo;
    if (m.forwarded) fact.forward = {};
    if (m.editedTs) fact.editedTs = m.editedTs;
    return fact;
  }
  private slReactions(m: SMessage): Map<string, string> {
    const by = new Map<string, string>();
    for (const r of m.reactions ?? []) by.set(r.senderFbid, canonicalReactionKey(r.emoji));
    return by;
  }
  private slMessage(m: SMessage, out: Ev[], backfill: boolean) {
    const fact = this.slFact(m);
    const rs = this.slReactions(m);
    const known = this.messages.has(m.messageId);
    if (backfill || !known) {
      if (rs.size) fact.reactions = this.reactionFacts(rs);
      this.message(fact, out, backfill ? false : undefined);
      this.reactionsNow(m.threadFbid, m.messageId, rs, out, true);
      return;
    }
    this.message(fact, out);
    this.reactionsNow(m.threadFbid, m.messageId, rs, out, false);
  }
  private slReceipts(t: SThread, out: Ev[]) {
    for (const r of t.receipts) {
      const who = this.igToFb.get(r.fbid) ?? r.fbid;
      if (who === this.self.id) this.read(t.threadFbid, r.ts, undefined, out);
      else this.receipt(t.threadFbid, who, r.ts, 'read', out);
    }
  }

  slideSnapshot(raw: unknown, self: SelfIds): Ev[] {
    this.self = self;
    const out: Ev[] = [];
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const users = (Array.isArray(s.users) ? s.users : []).map((u) => checkUser(u, this.drops)).filter((u): u is SUser => !!u);
    for (const u of users) if (u.fbid && u.igid) this.igToFb.set(u.igid, u.fbid);
    const threads = (Array.isArray(s.threads) ? s.threads : []).map((t) => checkSlideThread(t, this.drops)).filter((t): t is SThread => !!t);
    const messages = (Array.isArray(s.messages) ? s.messages : []).map((m) => checkSlideMessage(m, this.drops)).filter((m): m is SMessage => !!m);
    for (const u of users) this.slUser(u, out);
    for (const t of threads) this.slThread(t, out);
    for (const m of messages.sort((a, b) => a.timestampMs - b.timestampMs)) this.slMessage(m, out, true);
    for (const t of threads) this.slReceipts(t, out);
    return out;
  }
  slideHistory(raw: unknown): { events: Ev[]; count: number } {
    const out: Ev[] = [];
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const messages = (Array.isArray(s.messages) ? s.messages : []).map((m) => checkSlideMessage(m, this.drops)).filter((m): m is SMessage => !!m);
    for (const m of messages) this.slMessage(m, out, true);
    return { events: out, count: messages.length };
  }
  slideRecords(raw: unknown): Ev[] {
    const out: Ev[] = [];
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SRecords>;
    for (const u of Array.isArray(r.users) ? r.users : []) {
      const ok = checkUser(u, this.drops);
      if (ok) this.slUser(ok, out);
    }
    for (const t of Array.isArray(r.threads) ? r.threads : []) {
      const ok = checkSlideThread(t, this.drops);
      if (!ok) continue;
      this.slThread(ok, out);
      this.slReceipts(ok, out);
    }
    for (const m of Array.isArray(r.messages) ? r.messages : []) {
      const ok = checkSlideMessage(m, this.drops);
      if (ok) this.slMessage(ok, out, false);
    }
    for (const d of Array.isArray(r.deleted) ? r.deleted : []) {
      if (d && typeof d.thread === 'string' && typeof d.message === 'string') this.deleted(d.thread, d.message, out);
      else this.drops['slide.deleted'] = (this.drops['slide.deleted'] ?? 0) + 1;
    }
    return out;
  }
  /** Someone typing on Instagram: its ids are Instagram's (thread igid, user igid) where the page had no other. */
  slideTyping(raw: unknown): Ev[] {
    const t = (raw && typeof raw === 'object' ? raw : null) as { thread?: unknown; sender?: unknown; senderIg?: unknown; on?: unknown; ttl?: unknown } | null;
    if (!t || typeof t.thread !== 'string' || !t.thread) {
      this.drops['slide.typing'] = (this.drops['slide.typing'] ?? 0) + 1;
      return [];
    }
    const author = typeof t.sender === 'string' && t.sender ? t.sender : typeof t.senderIg === 'string' && t.senderIg ? (this.igToFb.get(t.senderIg) ?? `ig:${t.senderIg}`) : null;
    if (!author || author === this.self.id) return [];
    const ttl = typeof t.ttl === 'number' && t.ttl >= 1000 && t.ttl <= 60_000 ? t.ttl : undefined;
    return [{ t: 'typing', conversation: t.thread, author, ...(t.on === false ? { stop: true } : {}), ...(ttl && t.on !== false ? { ttl } : {}) }];
  }
}
