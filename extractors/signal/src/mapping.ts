/**
 * signal-cli JSON -> dither-chat facts. Pure functions: everything stateful
 * (message index, known groups, sticker manifests) comes in through MapContext.
 *
 * Native ids (protocol/adapter.ts):
 *   identity      ACI uuid
 *   group         "group:<base64 groupId>"
 *   1:1           "dm:<selfAci>:<peerAci>"   (Note to Self: "dm:<self>:<self>", shape 'self')
 *   message       "<authorAci>:<sentTimestamp>"
 */

import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdapterEvent, AttachmentFact, AttachmentKind, AttachmentNote, ConversationFact, IdentityFact, MessageExtra, MessageFact, MessageKind, MissingAttachmentFact, PersonAbout, PollFact, ReceiptState, SharedContactFact, StoryFact, StoryTextFact } from '@dither-chat/protocol';
import { fromSignal, plainText } from './markdown.ts';
import { callEvents, type CallBook } from './calls.ts';
import { nicknameOf } from './people.ts';
import type { SigAttachment, SigContact, SigContactValue, SigDataMessage, SigEnvelope, SigGroup, SigReceive, SigSentMessage, SigSharedContact, SigStory } from './types.ts';

/** How long Signal's own clients show a start without another. */
export const SIGNAL_TYPING_TTL = 15_000;

export const LONG_TEXT_MIME = 'text/x-signal-plain';

export const msgId = (author: string, ts: number) => `${author}:${ts}`;
export const dmId = (self: string, peer: string) => `dm:${self}:${peer}`;
export const groupConvId = (groupId: string) => `group:${groupId}`;

export function parseMsgId(id: string): { author: string; ts: number } | null {
  const i = id.lastIndexOf(':');
  if (i <= 0) return null;
  const ts = Number(id.slice(i + 1));
  if (!Number.isSafeInteger(ts) || ts <= 0) return null;
  return { author: id.slice(0, i), ts };
}

export type ConvTarget = { kind: 'group'; groupId: string } | { kind: 'dm'; peer: string } | { kind: 'self' };

export function parseConversation(id: string, self: string): ConvTarget | null {
  if (id.startsWith('group:')) {
    const groupId = id.slice('group:'.length);
    return groupId ? { kind: 'group', groupId } : null;
  }
  const m = id.match(/^dm:([^:]+):([^:]+)$/);
  if (!m) return null;
  if (m[1].toLowerCase() !== self.toLowerCase()) return null; // another account's conversation
  return m[2].toLowerCase() === self.toLowerCase() ? { kind: 'self' } : { kind: 'dm', peer: m[2].toLowerCase() };
}

// ------------------------------------------------------------------ context / result

export interface MapContext {
  /** Our ACI (lowercase). */
  self: string;
  selfNumber?: string | null;
  /** Absolute signal-cli data dir (--config); attachments live in <dir>/attachments. */
  signalDir: string;
  /** Conversation of a message we have seen, for read syncs and receipts (which carry no conversation). */
  conversationOf?: (messageNativeId: string) => string | undefined;
  /** The message an edit's own id stands for: receipts name the newest version by its timestamp. */
  originalOf?: (messageNativeId: string) => string | undefined;
  /** Resolve a phone number to an ACI (sync transcripts to number-only recipients). */
  aciOfNumber?: (number: string) => string | undefined;
  /** Whether a group's conversation fact is already known. Unknown groups get a stub and a refresh. */
  knownGroup?: (groupId: string) => boolean;
  /** Sticker manifest lookup: emoji and content type. */
  sticker?: (packId: string, stickerId: number) => { emoji?: string | null; contentType?: string | null } | undefined;
  /** Display name for system messages ("Alice updated the group."). */
  nameOf?: (aci: string) => string | undefined;
  /** First time this key is seen? Dedupes repeated group-call updates. Defaults to always true. */
  once?: (key: string) => boolean;
  /** 1:1 calls heard so far, for how each went (calls.ts). Without it, only the offer's line. */
  calls?: CallBook;
  /**
   * Whether a downloaded file is there. signal-cli downloads a message's files before it hands the message over, so one
   * that is not there failed or was skipped (its JSON has no download state). Defaults to always there.
   */
  exists?: (path: string) => boolean;
}

/**
 * What a reply to this message sends as its quote, in signal-cli's own syntax (send's quoteMessage, quoteMention,
 * quoteTextStyle, quoteAttachment): the text as Signal has it (a mention is U+FFFC), its ranges, and its files.
 */
export interface QuoteSource {
  t: string;
  m?: string[];
  s?: string[];
  a?: string[];
}

/** The most of a message's text a quote of it carries. */
export const QUOTE_TEXT_MAX = 1000;
/** A picture at most this big goes along as a quote's thumbnail as it is; a bigger one goes without one. */
export const QUOTE_THUMB_MAX = 256 * 1024;

/** signal-cli's quote-attachment syntax: contentType[:filename[:previewFile]]. Colons would split it, so none go in. */
export function quoteAttachment(mime: string | null | undefined, name: string | null | undefined, preview?: string | null): string {
  const clean = (x: string) => x.replace(/:/g, '_');
  const parts = [clean(mime || 'application/octet-stream')];
  if (name || preview) parts.push(clean(name ?? ''));
  if (preview && !preview.includes(':')) parts.push(preview);
  return parts.join(':');
}

/** A message's quote material: its text cut to QUOTE_TEXT_MAX with the ranges that still fit. */
export function quoteSource(text: string, mentions: string[] = [], styles: string[] = [], attachments: string[] = []): QuoteSource {
  const t = text.length > QUOTE_TEXT_MAX ? text.slice(0, QUOTE_TEXT_MAX) : text;
  const fits = (r: string) => {
    const [start, length] = r.split(':').map(Number);
    return Number.isFinite(start) && Number.isFinite(length) && start + length <= t.length;
  };
  const m = mentions.filter(fits);
  const st = styles.filter(fits);
  return { t, ...(m.length ? { m } : {}), ...(st.length ? { s: st } : {}), ...(attachments.length ? { a: attachments } : {}) };
}

export interface SeenMessage {
  nativeId: string;
  conversation: string;
  author: string;
  ts: number;
  kind: MessageKind;
  /** Plain text (mentions as @name), used for quote text when replying. */
  text: string;
  /** The conversation's disappearing-message timer as of this message (seconds, 0 = off). */
  timer?: number;
  expiresInSeconds?: number;
  /** Absolute paths of downloaded attachment files (deleted when a disappearing message expires). */
  files?: string[];
  /** A group update that a refresh can describe better. */
  groupUpdate?: string;
  /** The message it quotes (native id), kept so edits can carry the quote again. */
  replyTo?: string;
  /** This is an edit of an earlier message, sent at this time. */
  editedTs?: number;
  /** What a reply to it quotes. */
  quote?: QuoteSource;
}

/** A pin with a duration: Signal's clients drop it then, and nothing is sent when they do. */
export interface PinTimer {
  conversation: string;
  message: string;
  until: number;
}

export interface MapResult {
  events: AdapterEvent[];
  messages: SeenMessage[];
  /** Group ids whose details should be re-read (updates, unknown groups). */
  refreshGroups: string[];
  /** Contacts/groups/blocked lists changed: re-read everything. */
  resync: boolean;
  /** Pins that end by themselves. */
  pinTimers: PinTimer[];
  logs: { level: 'debug' | 'info' | 'warn'; msg: string; data?: unknown }[];
  /** Files signal-cli downloaded that are not to be kept: a view-once message's (docs/signal.md "View-once"). */
  discard?: string[];
  /** Files of stories, with when each story ends: deleted then. */
  storyFiles?: [path: string, until: number][];
}

const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : null);

// ------------------------------------------------------------------ static facts

export function noteToSelf(self: string): ConversationFact {
  return { nativeId: dmId(self, self), shape: 'self', name: 'Note to Self', participants: [self], encrypted: true };
}

export function directConversation(self: string, peer: string): ConversationFact {
  if (peer === self) return noteToSelf(self);
  return { nativeId: dmId(self, peer), shape: 'direct', participants: [self, peer], encrypted: true };
}

const joinName = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(' ').trim() || undefined;

/** Signal's display order: your nickname, the system contact name, their profile name. */
export function displayNameOf(c: SigContact): string | undefined {
  return (
    joinName(c.nickGivenName, c.nickFamilyName) ??
    joinName(c.nickName) ??
    joinName(c.name) ??
    joinName(c.givenName, c.familyName) ??
    joinName(c.profile?.givenName, c.profile?.familyName) ??
    joinName(c.username)
  );
}

/** Their name without your nickname for them: the system contact name, else their profile name (displayNameOf's order). */
export function ownNameOf(c: SigContact): string | undefined {
  return joinName(c.name) ?? joinName(c.givenName, c.familyName) ?? joinName(c.profile?.givenName, c.profile?.familyName) ?? joinName(c.username);
}

/** Their number, else their username. */
const handleOf = (c: SigContact) => c.number || (c.username ? `@${c.username}` : undefined);

export function contactIdentity(c: SigContact, opts: { contact: boolean; avatarUrl?: string; self?: string }): IdentityFact | null {
  const id = lc(c.uuid);
  if (!id) return null;
  const f: IdentityFact = { nativeId: id };
  const handle = handleOf(c);
  if (handle) f.handle = handle;
  // Your nickname and note go as themselves (capability 'contactNotes'): the hub keeps the nickname as yours.
  const self = !!opts.self && id === opts.self;
  const name = self ? displayNameOf(c) : (ownNameOf(c) ?? displayNameOf(c));
  if (name) f.displayName = name;
  if (opts.avatarUrl) f.avatarUrl = opts.avatarUrl;
  if (self) f.isSelf = true;
  else {
    if (opts.contact) f.contact = true;
    f.nickname = nicknameOf(c);
    f.note = c.note?.trim() ?? '';
  }
  return f;
}

/** The most a Signal About takes, in characters. */
export const ABOUT_MAX = 140;

/** An About Signal would take, or a plain error saying why not. */
export function checkAbout(about: unknown): string {
  if (typeof about !== 'string') throw new Error('nothing to change: only the About can be set');
  const n = [...about].length;
  if (n > ABOUT_MAX) throw new Error(`a Signal About takes ${ABOUT_MAX} characters, this one has ${n}`);
  return about;
}

/**
 * What Signal's own About sheet shows for someone, from their listContacts record. `inContacts`: listed without
 * allRecipients (signal-cli's contacts: not hidden, still registered); leave it out for yourself.
 */
export function personAbout(c: SigContact, opts: { inContacts?: boolean; avatarUrl?: string } = {}): PersonAbout {
  const p: PersonAbout = {};
  const name = displayNameOf(c);
  if (name) p.displayName = name;
  const handle = handleOf(c);
  if (handle) p.handle = handle;
  if (opts.avatarUrl) p.avatar = opts.avatarUrl;
  const bio = c.profile?.about?.trim();
  if (bio) p.bio = bio;
  const emoji = c.profile?.aboutEmoji?.trim();
  if (emoji) p.status = { emoji };
  if (opts.inContacts !== undefined) p.relationship = c.isBlocked ? 'blocked' : opts.inContacts ? 'contact' : 'stranger';
  if (c.number) p.links = [{ label: 'Phone', value: c.number, url: `tel:${c.number}` }];
  const facts: { label: string; value: string }[] = [];
  // The name they gave themselves, when your nickname or address book shows another.
  const own = joinName(c.profile?.givenName, c.profile?.familyName);
  if (own && own !== name) facts.push({ label: 'Profile name', value: own });
  const note = c.note?.trim();
  if (note) facts.push({ label: 'Note', value: note });
  if (c.unregistered) facts.push({ label: 'Account', value: 'No longer on Signal' });
  if (facts.length) p.facts = facts;
  return p;
}

export function groupConversation(g: SigGroup, opts: { avatarUrl?: string } = {}): ConversationFact {
  const f: ConversationFact = { nativeId: groupConvId(g.id), shape: 'group', encrypted: true };
  if (g.name) f.name = g.name;
  if (g.description) f.topic = g.description;
  if (opts.avatarUrl) f.avatarUrl = opts.avatarUrl;
  const members = (g.members ?? []).map((m) => lc(m.uuid)).filter((x): x is string => !!x);
  f.participants = [...new Set(members)];
  if (g.permissionSendMessage === 'ONLY_ADMINS') f.variant = 'announcement';
  return f;
}

export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

export function attachmentKind(mime: string | null | undefined): AttachmentKind {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

export function attachmentFact(a: SigAttachment, signalDir: string): (AttachmentFact & { path: string }) | null {
  if (a.contentType === LONG_TEXT_MIME) return null; // already folded into the body by signal-cli
  if (!a.id) return null;
  const id = basename(a.id);
  const path = resolve(join(signalDir, 'attachments', id));
  const f: AttachmentFact & { path: string } = { nativeId: id, kind: attachmentKind(a.contentType), url: fileUrl(path), path };
  if (a.contentType) f.mime = a.contentType;
  f.name = a.filename || id;
  if (a.size != null) f.size = a.size;
  if (a.width) f.width = a.width;
  if (a.height) f.height = a.height;
  return f;
}

export function describeTimer(seconds: number): string {
  if (!seconds) return 'off';
  const units: [number, string][] = [
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [n, name] of units) {
    if (seconds % n === 0) {
      const k = seconds / n;
      return `${k} ${name}${k === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

/** Human summary of a group change, from the group as it was and as it is now. */
export function describeGroupChange(before: SigGroup | undefined, after: SigGroup, actor: string, self: string, nameOf: (aci: string) => string): string {
  const who = actor === self ? 'You' : nameOf(actor);
  if (!before) return `${who} updated the group.`;
  const parts: string[] = [];
  if ((before.name ?? '') !== (after.name ?? '')) parts.push(after.name ? `renamed the group to “${after.name}”` : 'removed the group name');
  if ((before.description ?? '') !== (after.description ?? '')) parts.push('changed the group description');
  const was = memberIds(before);
  const now = memberIds(after);
  const added = [...now].filter((x) => !was.has(x));
  const removed = [...was].filter((x) => !now.has(x));
  const list = (xs: string[]) => xs.map((x) => (x === self ? 'you' : nameOf(x))).join(', ');
  if (removed.length === 1 && removed[0] === actor && !added.length) return `${who} left the group.`;
  if (added.length === 1 && added[0] === actor && !removed.length) return `${who} joined the group.`;
  // Invited (pending): Signal names them only to whoever invited them, and counts them for everyone else.
  const pendingWas = pendingIds(before);
  const invited = [...pendingIds(after)].filter((x) => !pendingWas.has(x) && !now.has(x) && x !== self);
  if (added.length) parts.push(`added ${list(added)}`);
  if (invited.length) parts.push(actor === self ? `invited ${list(invited)}` : `invited ${invited.length} ${invited.length === 1 ? 'person' : 'people'}`);
  if (removed.length) parts.push(`removed ${list(removed)}`);
  const { given, taken } = adminChanges(before, after);
  if (given.length) parts.push(`made ${list(given)} ${given.length === 1 ? 'an admin' : 'admins'}`);
  if (taken.length) parts.push(taken.length === 1 && taken[0] === self ? 'revoked your admin privileges' : `revoked admin privileges from ${list(taken)}`);
  if ((before.messageExpirationTime ?? 0) !== (after.messageExpirationTime ?? 0)) {
    parts.push(after.messageExpirationTime ? `set disappearing messages to ${describeTimer(after.messageExpirationTime)}` : 'turned off disappearing messages');
  }
  if (before.permissionSendMessage !== after.permissionSendMessage && after.permissionSendMessage) {
    parts.push(after.permissionSendMessage === 'ONLY_ADMINS' ? 'allowed only admins to send messages' : 'allowed all members to send messages');
  }
  const whom = (p: string) => (p === 'ONLY_ADMINS' ? '“Only admins”' : '“All members”');
  if (before.permissionEditDetails !== after.permissionEditDetails && after.permissionEditDetails) parts.push(`changed who can edit group info to ${whom(after.permissionEditDetails)}`);
  if (before.permissionAddMember !== after.permissionAddMember && after.permissionAddMember) parts.push(`changed who can add members to ${whom(after.permissionAddMember)}`);
  const link = (g: SigGroup) => g.groupInviteLink || null;
  if (link(before) !== link(after)) parts.push(!link(after) ? 'turned off the group link' : link(before) ? 'reset the group link' : 'turned on the group link');
  if (!parts.length) return `${who} updated the group.`;
  return `${who} ${parts.join(', ')}.`;
}

const idsOf = (list: { uuid?: string | null }[] | undefined) => new Set((list ?? []).map((m) => lc(m.uuid)).filter((x): x is string => !!x));
/** A group's members, by ACI. */
export const memberIds = (g: SigGroup) => idsOf(g.members);
/** Who is invited to a group and has not joined, by ACI (an invitation to a number alone has none). */
export const pendingIds = (g: SigGroup) => idsOf(g.pendingMembers);

function adminIds(g: SigGroup): Set<string> {
  const members = g.members ?? [];
  // signal-cli 0.14 marks each member; older ones only list the admins.
  const admins = members.some((m) => typeof m.isAdmin === 'boolean') ? members.filter((m) => m.isAdmin) : (g.admins ?? []);
  return new Set(admins.map((m) => lc(m.uuid)).filter((x): x is string => !!x));
}

/** Who a group change made admin and who stopped being one, among the members it kept. */
export function adminChanges(before: SigGroup, after: SigGroup): { given: string[]; taken: string[] } {
  const was = memberIds(before);
  const kept = [...memberIds(after)].filter((x) => was.has(x));
  const a = adminIds(before);
  const b = adminIds(after);
  return { given: kept.filter((x) => !a.has(x) && b.has(x)), taken: kept.filter((x) => a.has(x) && !b.has(x)) };
}

// ------------------------------------------------------------------ envelopes

interface Build {
  ctx: MapContext;
  out: MapResult;
}

export function mapReceive(rcv: SigReceive, ctx: MapContext): MapResult {
  const out: MapResult = { events: [], messages: [], refreshGroups: [], resync: false, pinTimers: [], logs: [] };
  const env = rcv.envelope;
  if (rcv.exception) {
    out.logs.push({
      level: 'warn',
      msg: `signal-cli could not process a message: ${rcv.exception.type ?? 'Error'}: ${rcv.exception.message ?? ''}`.trim(),
      data: env ? { from: env.sourceUuid ?? env.sourceNumber, ts: env.timestamp } : undefined,
    });
  }
  if (!env) return out;
  const source = lc(env.sourceUuid);
  if (!source) {
    if (env.dataMessage || env.syncMessage || env.editMessage) out.logs.push({ level: 'warn', msg: 'dropping an envelope without a sender ACI', data: { number: env.sourceNumber, ts: env.timestamp } });
    return out;
  }
  const b: Build = { ctx, out };
  const fromSelf = source === ctx.self;
  if (rcv.exception && !fromSelf && !envelopeContent(env) && undecryptable(rcv.exception.type)) {
    undecrypted(b, env, source);
    return out;
  }

  if (!fromSelf && (env.sourceName || env.sourceNumber)) {
    const idf: IdentityFact = { nativeId: source };
    if (env.sourceNumber) idf.handle = env.sourceNumber;
    if (env.sourceName) idf.displayName = env.sourceName;
    out.events.push({ t: 'identity', identity: idf });
  }

  if (env.dataMessage) incomingData(b, env, source, env.dataMessage);
  if (env.editMessage?.dataMessage) {
    const dm = env.editMessage.dataMessage;
    const conv = conversationFor(b, dm, fromSelf ? ctx.self : source, fromSelf);
    emitMessage(b, dm, { author: source, conversation: conv, ts: env.editMessage.targetSentTimestamp, editedTs: dm.timestamp });
  }
  if (env.syncMessage) sync(b, env);
  if (env.storyMessage && !fromSelf) story(b, env.storyMessage, source, env.timestamp);
  if (env.receiptMessage && !fromSelf) receipts(b, env, source);
  if (env.typingMessage && !fromSelf && (env.typingMessage.action === 'STARTED' || env.typingMessage.action === 'STOPPED')) {
    const g = env.typingMessage.groupId;
    const conversation = g ? groupConvId(g) : dmId(ctx.self, source);
    // No conversation fact here: someone typing is not yet a conversation. Signal's clients send a start every 10 s
    // while typing and let one lapse after 15 s.
    out.events.push(env.typingMessage.action === 'STARTED' ? { t: 'typing', conversation, author: source, ttl: SIGNAL_TYPING_TTL } : { t: 'typing', conversation, author: source, stop: true });
  }
  if (env.callMessage?.offerMessage && !fromSelf) {
    const video = env.callMessage.offerMessage.type === 'VIDEO_CALL';
    const conversation = ensureDirect(b, source);
    const fact: MessageFact = {
      nativeId: msgId(source, env.timestamp),
      conversation,
      author: source,
      ts: env.timestamp,
      kind: 'call',
      body: video ? '📹 Incoming video call' : '📞 Incoming voice call',
    };
    out.events.push({ t: 'message', message: fact, live: true });
    out.messages.push({ nativeId: fact.nativeId, conversation, author: source, ts: fact.ts, kind: 'call', text: fact.body });
    if (ctx.calls) out.events.push(...callEvents(env, source, ctx.self, ctx.calls, fact));
  } else if (env.callMessage && ctx.calls) out.events.push(...callEvents(env, source, ctx.self, ctx.calls, undefined));
  return out;
}

/** The envelope carries something signal-cli could read. */
const envelopeContent = (env: SigEnvelope) => !!(env.dataMessage || env.editMessage || env.syncMessage || env.receiptMessage || env.typingMessage || env.callMessage || env.storyMessage);

/** A receive error that lost a message: not a duplicate (already shown) and not one of your own sends coming back. */
export const undecryptable = (type: string | null | undefined) => !/Duplicate|SelfSend/i.test(type ?? '');

/**
 * Someone's message that signal-cli could not decrypt: a system line in your 1:1 with them, as Signal's own clients put
 * it, with nothing of its content (there is none). Once per envelope; nothing is asked of anyone, and signal-cli's own
 * retry request, when it makes one, stays its business. The line has an id of its own, so the message coming again
 * decrypted (a retry keeps its timestamp, maybe in a group) does not land on it.
 */
function undecrypted(b: Build, env: SigEnvelope, source: string) {
  if (!(b.ctx.once?.(`undecrypted:${source}:${env.timestamp}`) ?? true)) return;
  const conversation = ensureDirect(b, source);
  const who = b.ctx.nameOf?.(source) || env.sourceName || env.sourceNumber || 'someone';
  const ts = env.timestamp;
  const fact: MessageFact = { nativeId: `${msgId(source, ts)}:undecrypted`, conversation, author: source, ts, kind: 'system', body: `A message from ${who} could not be decrypted.` };
  if (env.sourceDevice) fact.extra = { sourceDevice: env.sourceDevice } satisfies MessageExtra;
  b.out.events.push({ t: 'message', message: fact, live: true });
  b.out.messages.push({ nativeId: fact.nativeId, conversation, author: source, ts, kind: 'system', text: fact.body });
}

/** The conversation a data message belongs to. `peer` is the other side of a 1:1. */
function conversationFor(b: Build, dm: Partial<SigDataMessage>, peer: string, _fromSelf: boolean): string {
  const g = dm.groupInfo?.groupId;
  if (g) {
    const known = b.ctx.knownGroup?.(g) ?? true;
    if (!known) {
      const stub: ConversationFact = { nativeId: groupConvId(g), shape: 'group', encrypted: true };
      if (dm.groupInfo?.groupName) stub.name = dm.groupInfo.groupName;
      b.out.events.push({ t: 'conversation', conversation: stub });
      if (!b.out.refreshGroups.includes(g)) b.out.refreshGroups.push(g);
    }
    return groupConvId(g);
  }
  return ensureDirect(b, peer);
}

function ensureDirect(b: Build, peer: string): string {
  const fact = directConversation(b.ctx.self, peer);
  if (!b.out.events.some((e) => e.t === 'conversation' && e.conversation.nativeId === fact.nativeId)) b.out.events.push({ t: 'conversation', conversation: fact });
  return fact.nativeId;
}

function actorName(b: Build, aci: string, fallback?: string | null) {
  if (aci === b.ctx.self) return 'You';
  return b.ctx.nameOf?.(aci) || fallback || 'Someone';
}

function systemMessage(b: Build, author: string, conversation: string, ts: number, body: string, extra: Partial<MessageFact> = {}, seen: Partial<SeenMessage> = {}) {
  const fact: MessageFact = { nativeId: msgId(author, ts), conversation, author, ts, kind: 'system', body, ...extra };
  b.out.events.push({ t: 'message', message: fact, live: true });
  b.out.messages.push({ nativeId: fact.nativeId, conversation, author, ts, kind: 'system', text: body, ...seen });
}

/** dataMessage from someone (or from one of our own devices without a transcript). */
function incomingData(b: Build, env: SigEnvelope, source: string, dm: SigDataMessage) {
  const fromSelf = source === b.ctx.self;
  const conversation = conversationFor(b, dm, source, fromSelf);
  dataCommon(b, dm, source, conversation, env.sourceName, env);
}

/** Everything a data message can carry, for incoming messages and sync transcripts alike. */
function dataCommon(b: Build, dm: Partial<SigDataMessage>, author: string, conversation: string, authorName?: string | null, env?: SigEnvelope) {
  const { ctx, out } = b;
  const ts = dm.timestamp ?? 0;
  if (dm.reaction && dm.storyContext) {
    // A reaction to a story: shown as a line of its own (the story itself comes only with stories on, as a story event).
    if (!dm.reaction.isRemove && ts) emitMessage(b, { ...dm, reaction: null, message: dm.reaction.emoji }, { author, conversation, ts, env, storyEmoji: dm.reaction.emoji });
    return;
  }
  if (dm.reaction) {
    const target = lc(dm.reaction.targetAuthorUuid);
    if (target) {
      out.events.push({
        t: 'reaction',
        conversation,
        message: msgId(target, dm.reaction.targetSentTimestamp),
        author,
        key: dm.reaction.emoji,
        ...(dm.reaction.isRemove ? { remove: true } : {}),
      });
    }
    return;
  }
  if (dm.remoteDelete) {
    out.events.push({ t: 'delete', conversation, nativeId: msgId(author, dm.remoteDelete.timestamp) });
    return;
  }
  if (dm.adminDelete) {
    const target = lc(dm.adminDelete.targetAuthorUuid);
    if (target) out.events.push({ t: 'delete', conversation, nativeId: msgId(target, dm.adminDelete.targetSentTimestamp) });
    return;
  }
  if (dm.pollVote) {
    // One voter's whole vote; the hub keeps the one with the highest number, as Signal's apps count (docs/signal.md).
    const v = dm.pollVote;
    const pollAuthor = lc(v.authorUuid) ?? (v.authorNumber ? (ctx.aciOfNumber?.(v.authorNumber) ?? null) : null);
    if (pollAuthor && typeof v.targetSentTimestamp === 'number') {
      const options = [...new Set((v.optionIndexes ?? []).filter((i) => Number.isInteger(i) && i >= 0).map(String))];
      out.events.push({ t: 'pollUpdate', conversation, message: msgId(pollAuthor, v.targetSentTimestamp), vote: { voter: author, options, seq: v.voteCount ?? 0, ...(ts ? { ts } : {}) } });
    }
    return;
  }
  const who = actorName(b, author, authorName);
  if (dm.pinMessage || dm.unpinMessage) {
    const p = (dm.pinMessage ?? dm.unpinMessage)!;
    const target = lc(p.targetAuthorUuid) ?? (p.targetAuthorNumber ? (ctx.aciOfNumber?.(p.targetAuthorNumber) ?? null) : null);
    const message = target ? msgId(target, p.targetSentTimestamp) : undefined;
    systemMessage(b, author, conversation, ts, `${who} ${dm.pinMessage ? 'pinned' : 'unpinned'} a message.`, message ? { replyTo: message } : {});
    if (message) {
      out.events.push({ t: 'pin', conversation, message, pinned: !!dm.pinMessage, by: author, ...(ts ? { ts } : {}) });
      // Seconds; -1 is for good.
      const secs = dm.pinMessage?.pinDurationSeconds ?? 0;
      if (secs > 0 && ts) out.pinTimers.push({ conversation, message, until: ts + secs * 1000 });
    }
    return;
  }
  if (dm.pollTerminate) {
    // Only its author ends a poll, so the poll is theirs.
    const poll = msgId(author, dm.pollTerminate.targetSentTimestamp);
    systemMessage(b, author, conversation, ts, `${who} ended the poll.`, { replyTo: poll });
    out.events.push({ t: 'pollUpdate', conversation, message: poll, ended: true, ...(ts ? { ts } : {}) });
    return;
  }
  if (dm.groupCallUpdate) {
    const era = dm.groupCallUpdate.eraId ?? String(ts);
    if (ctx.once?.(`call:${conversation}:${era}`) ?? true) {
      const fact: MessageFact = { nativeId: msgId(author, ts), conversation, author, ts, kind: 'call', body: `📞 ${who} started a group call` };
      out.events.push({ t: 'message', message: fact, live: true });
      out.messages.push({ nativeId: fact.nativeId, conversation, author, ts, kind: 'call', text: fact.body });
    }
    return;
  }
  const isGroupUpdate = dm.groupInfo?.type === 'UPDATE';
  const hasContent = !!(dm.message || dm.attachments?.some((a) => a.contentType !== LONG_TEXT_MIME) || dm.sticker || dm.contacts?.length || dm.pollCreate || dm.payment);
  if (isGroupUpdate && dm.groupInfo) {
    if (!out.refreshGroups.includes(dm.groupInfo.groupId)) out.refreshGroups.push(dm.groupInfo.groupId);
    if (!hasContent) {
      systemMessage(b, author, conversation, ts, `${who} updated the group.`, {}, { groupUpdate: dm.groupInfo.groupId });
      return;
    }
  }
  if (dm.isExpirationUpdate && !hasContent) {
    const secs = dm.expiresInSeconds ?? 0;
    systemMessage(b, author, conversation, ts, secs ? `${who} set disappearing messages to ${describeTimer(secs)}.` : `${who} turned off disappearing messages.`, {}, { timer: secs });
    return;
  }
  if (!hasContent) {
    if (dm.isProfileKeyUpdate || dm.isEndSession || dm.hasProfileKey) return; // housekeeping
    if (dm.storyContext) return; // e.g. a reaction to a story
    out.logs.push({ level: 'debug', msg: 'ignoring a data message without content', data: { conversation, ts, keys: Object.keys(dm) } });
    return;
  }
  emitMessage(b, dm, { author, conversation, ts, env });
}

const labelOf = (v: SigContactValue) => (v.type === 'CUSTOM' ? v.label?.trim() || undefined : v.type ? v.type.charAt(0) + v.type.slice(1).toLowerCase() : undefined);

/** A shared contact as a card, and the one line the body keeps for it (search, previews, older clients). */
export function sharedContact(c: SigSharedContact, signalDir: string, exists?: (path: string) => boolean): SharedContactFact {
  const n = c.name;
  const name = joinName(n?.prefix, n?.given, n?.middle, n?.family, n?.suffix) ?? n?.nickname ?? c.organization ?? 'Contact';
  const values = (list: SigContactValue[] | null | undefined) =>
    (list ?? []).filter((v) => v.value?.trim()).map((v) => ({ value: v.value!.trim(), ...(labelOf(v) ? { label: labelOf(v) } : {}) }));
  const phones = values(c.phone);
  const emails = values(c.email);
  const addresses = (c.address ?? [])
    .map((a) => {
      const text = [a.street, a.pobox && `PO Box ${a.pobox}`, a.neighborhood, a.city, joinName(a.region, a.postcode), a.country].filter((x) => x && x.trim()).join(', ');
      const label = a.type === 'CUSTOM' ? a.label?.trim() : a.type ? a.type.charAt(0) + a.type.slice(1).toLowerCase() : undefined;
      return text ? { text, ...(label ? { label } : {}) } : null;
    })
    .filter((a): a is { text: string; label?: string } => !!a);
  const all = [...phones, ...emails].map((v) => v.value);
  const f: SharedContactFact = { name, line: `👤 ${name}${all.length ? ' · ' + all.join(', ') : ''}` };
  if (phones.length) f.phones = phones;
  if (emails.length) f.emails = emails;
  if (c.organization?.trim() && c.organization.trim() !== name) f.organization = c.organization.trim();
  if (addresses.length) f.addresses = addresses;
  const pic = c.avatar?.attachment ? attachmentFact(c.avatar.attachment, signalDir) : null;
  if (pic && (exists?.(pic.path) ?? true)) f.avatar = pic.url;
  return f;
}

function emitMessage(b: Build, dm: Partial<SigDataMessage>, o: { author: string; conversation: string; ts: number; editedTs?: number; env?: SigEnvelope; storyEmoji?: string }) {
  const { ctx, out } = b;
  let mentionsSelf = false;
  let body = fromSignal(dm.message, dm.textStyles, dm.mentions, { onMention: (aci) => (mentionsSelf ||= aci.toLowerCase() === ctx.self) });
  let kind: MessageKind = 'text';
  let attachments: (AttachmentFact & { path?: string })[] = [];
  const extra: Record<string, unknown> & MessageExtra = {};
  const there = (path: string) => ctx.exists?.(path) ?? true;
  const notes: (AttachmentNote | null)[] = [];
  const missing: MissingAttachmentFact[] = [];

  if (dm.viewOnce) {
    // Respect the sender: view-once media stays on the phone. What signal-cli downloaded for it is deleted.
    kind = 'media';
    body = body || '📷 View-once media (open it on your phone)';
    extra.viewOnce = true;
    for (const a of dm.attachments ?? []) {
      const f = attachmentFact(a, ctx.signalDir);
      if (f) (out.discard ??= []).push(f.path);
    }
  } else {
    for (const a of dm.attachments ?? []) {
      if (a.contentType === LONG_TEXT_MIME) continue;
      const f = attachmentFact(a, ctx.signalDir);
      if (!f || !there(f.path)) {
        missing.push({ ...(a.filename ? { name: a.filename } : {}), ...(a.contentType ? { mime: a.contentType } : {}), ...(a.size != null ? { size: a.size } : {}) });
        continue;
      }
      attachments.push(f);
      const caption = a.caption?.trim();
      notes.push(caption || a.isVoiceNote ? { ...(caption ? { caption } : {}), ...(a.isVoiceNote ? { voiceNote: true as const } : {}) } : null);
    }
    if (attachments.length || missing.length) kind = 'media';
    if (notes.some(Boolean)) extra.attachmentNotes = notes;
    if (missing.length) extra.missingAttachments = missing;
  }
  if (dm.sticker) {
    kind = 'sticker';
    const info = ctx.sticker?.(dm.sticker.packId, dm.sticker.stickerId);
    const path = resolve(join(ctx.signalDir, 'stickers', basename(dm.sticker.packId), String(dm.sticker.stickerId)));
    attachments = [{ nativeId: `sticker:${dm.sticker.packId}:${dm.sticker.stickerId}`, kind: 'image', mime: info?.contentType || 'image/webp', name: 'sticker', url: fileUrl(path) }];
    if (!body) body = info?.emoji ?? '';
    extra.sticker = { packId: dm.sticker.packId, stickerId: dm.sticker.stickerId };
  }
  const extraLines: string[] = [];
  if (dm.pollCreate) {
    const p = dm.pollCreate;
    extraLines.push(`📊 **${p.question ?? 'Poll'}**${p.allowMultiple ? ' (multiple choice)' : ''}`, ...(p.options ?? []).map((x) => `• ${x}`));
    extra.poll = pollFact(p);
  }
  if (dm.contacts?.length) {
    const cards = dm.contacts.map((c) => sharedContact(c, ctx.signalDir, ctx.exists));
    extraLines.push(...cards.map((c) => c.line!));
    extra.contacts = cards;
  }
  if (dm.payment) extraLines.push(`💸 Payment${dm.payment.note ? `: ${dm.payment.note}` : ''}`);
  if (extraLines.length) body = [body, ...extraLines].filter(Boolean).join('\n');

  const fact: MessageFact = { nativeId: msgId(o.author, o.ts), conversation: o.conversation, author: o.author, ts: o.ts, kind, body };
  if (o.editedTs) fact.editedTs = o.editedTs;
  if (mentionsSelf) fact.mentionsSelf = true;
  if (attachments.length) fact.attachments = attachments.map(({ path: _p, ...a }) => a);
  const q = dm.quote;
  if (q) {
    const qa = lc(q.authorUuid) ?? (q.authorNumber ? (ctx.aciOfNumber?.(q.authorNumber) ?? null) : null);
    if (qa) fact.replyTo = msgId(qa, q.id);
    // Linked devices have no history, so the quoted message is often unknown to the hub.
    extra.quote = {
      author: qa ?? q.authorNumber ?? q.author ?? null,
      ts: q.id,
      text: fromSignal(q.text, q.textStyles, q.mentions),
      ...(q.attachments?.length
        ? {
            attachments: q.attachments.map((a) => {
              const thumb = a.thumbnail ? attachmentFact(a.thumbnail, ctx.signalDir) : null;
              return { mime: a.contentType ?? null, name: a.filename ?? null, ...(thumb && there(thumb.path) ? { thumbnail: thumb.url } : {}) };
            }),
          }
        : {}),
    };
  }
  // Link previews, shaped as the embeds the hub already shows (Discord's): the picture only when it downloaded.
  const previews = (dm.previews ?? []).filter((p) => p.url && /^https?:\/\//i.test(p.url));
  if (previews.length) {
    extra.embeds = previews.map((p) => {
      const img = p.image ? attachmentFact(p.image, ctx.signalDir) : null;
      let provider: string | undefined;
      try {
        provider = new URL(p.url!).hostname.replace(/^www\./, '');
      } catch {}
      return {
        url: p.url!,
        ...(p.title?.trim() ? { title: p.title.trim() } : {}),
        ...(p.description?.trim() ? { description: p.description.trim() } : {}),
        ...(provider ? { provider } : {}),
        ...(img && there(img.path) ? { image: img.url } : {}),
      };
    });
  }
  if (dm.storyContext) extra.storyReply = { author: lc(dm.storyContext.authorUuid), ts: dm.storyContext.sentTimestamp, ...(o.storyEmoji ? { emoji: o.storyEmoji } : {}) };
  if (dm.expiresInSeconds) extra.expiresInSeconds = dm.expiresInSeconds;
  if (o.env && !o.editedTs) {
    if (o.env.sourceDevice) extra.sourceDevice = o.env.sourceDevice;
    if (o.env.serverReceivedTimestamp) extra.serverReceivedTs = o.env.serverReceivedTimestamp;
    if (o.env.serverDeliveredTimestamp) extra.serverDeliveredTs = o.env.serverDeliveredTimestamp;
  }
  if (Object.keys(extra).length) fact.extra = extra;

  out.events.push({ t: 'message', message: fact, live: true });
  out.messages.push({
    nativeId: fact.nativeId,
    conversation: o.conversation,
    author: o.author,
    ts: o.ts,
    kind,
    text: plainText(dm.message, dm.mentions, ctx.nameOf) || body,
    ...(fact.replyTo ? { replyTo: fact.replyTo } : {}),
    ...(o.editedTs ? { editedTs: o.editedTs } : {}),
    ...(dm.expiresInSeconds != null && !o.editedTs ? { timer: dm.expiresInSeconds } : {}),
    ...(dm.expiresInSeconds ? { expiresInSeconds: dm.expiresInSeconds } : {}),
    ...(attachments.some((a) => a.path) ? { files: attachments.map((a) => a.path).filter((p): p is string => !!p) } : {}),
    quote: quoteSource(
      dm.message ?? '',
      (dm.mentions ?? []).filter((m) => m.uuid).map((m) => `${m.start}:${m.length}:${lc(m.uuid)}`),
      (dm.textStyles ?? []).map((st) => `${st.start}:${st.length}:${st.style}`),
      attachments.map((a) => quoteAttachment(a.mime, a.name, a.kind === 'image' && a.path && (a.size ?? Infinity) <= QUOTE_THUMB_MAX ? a.path : null)),
    ),
  });
}

/**
 * Someone's delivery, read or viewed receipt for messages you sent, one event per conversation. A receipt names
 * messages by their timestamps only, so it counts for messages this device has seen; group receipts come per person.
 */
function receipts(b: Build, env: SigEnvelope, source: string) {
  const { ctx, out } = b;
  const r = env.receiptMessage!;
  const state: ReceiptState | null = r.isViewed ? 'played' : r.isRead ? 'read' : r.isDelivery ? 'delivered' : null;
  if (!state) return;
  const byConversation = new Map<string, Set<string>>();
  let unknown = 0;
  for (const ts of r.timestamps ?? []) {
    const id = msgId(ctx.self, ts);
    const conversation = ctx.conversationOf?.(id);
    const t = conversation ? parseConversation(conversation, ctx.self) : null;
    // A 1:1's receipts come from its peer; nobody else sends any for Note to Self.
    if (!conversation || !t || t.kind === 'self' || (t.kind === 'dm' && t.peer !== source)) {
      unknown++;
      continue;
    }
    (byConversation.get(conversation) ?? byConversation.set(conversation, new Set()).get(conversation)!).add(ctx.originalOf?.(id) ?? id);
  }
  if (unknown) out.logs.push({ level: 'debug', msg: `${state} receipt for ${unknown} message(s) we have not seen`, data: { from: source } });
  for (const [conversation, ids] of byConversation) out.events.push({ t: 'receipt', conversation, messages: [...ids], who: source, state, ts: r.when || env.timestamp });
}

/** Signal's "#AARRGGBB" as CSS "#RRGGBBAA"; anything else left out. */
export function cssColor(c: string | null | undefined): string | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(c ?? '');
  return m ? `#${m[2]}${m[1]}`.toLowerCase() : undefined;
}

/** Signal keeps a story a day. */
const STORY_MS = 24 * 60 * 60_000;

/**
 * A story (the daemon passes them only with the account's stories setting on): never a message, kept by the hub on its
 * author's or group's page until it ends. Its file is deleted then (storyFiles).
 */
function story(b: Build, st: SigStory, author: string, ts: number) {
  const { ctx, out } = b;
  const fact: StoryFact = { nativeId: msgId(author, ts), author, ts, expiresAt: ts + STORY_MS, allowsReplies: st.allowsReplies !== false };
  if (st.groupId) fact.conversation = groupConvId(st.groupId);
  if (st.fileAttachment) {
    const f = attachmentFact(st.fileAttachment, ctx.signalDir);
    if (!f || !(ctx.exists?.(f.path) ?? true)) return void out.logs.push({ level: 'debug', msg: 'a story whose file signal-cli did not download', data: { ts } });
    const { path, ...a } = f;
    fact.attachment = a;
    (out.storyFiles ??= []).push([path, fact.expiresAt]);
  } else if (st.textAttachment) {
    const t = st.textAttachment;
    const text: StoryTextFact = { text: t.text ?? '' };
    if (t.style) text.style = t.style;
    const color = cssColor(t.textForegroundColor);
    if (color) text.color = color;
    const behind = cssColor(t.textBackgroundColor);
    if (behind) text.textBackground = behind;
    const bg = cssColor(t.backgroundColor);
    if (bg) text.background = bg;
    const g = t.backgroundGradient;
    const colors = (g?.colors?.length ? g.colors : [g?.startColor, g?.endColor]).map(cssColor).filter((x): x is string => !!x);
    if (colors.length) text.gradient = { colors, ...(typeof g?.angle === 'number' ? { angle: g.angle } : {}) };
    if (t.preview?.url && /^https?:\/\//.test(t.preview.url)) text.url = t.preview.url;
    fact.text = text;
  } else return;
  out.events.push({ t: 'story', story: fact });
}

function sync(b: Build, env: SigEnvelope) {
  const { ctx, out } = b;
  const s = env.syncMessage!;
  if (s.sentMessage) sentTranscript(b, s.sentMessage);
  if (s.sentStoryMessage?.dataMessage) story(b, s.sentStoryMessage.dataMessage, ctx.self, env.timestamp);
  if (s.readMessages?.length) {
    const upTo = new Map<string, number>();
    for (const r of s.readMessages) {
      const sender = lc(r.senderUuid) ?? (r.senderNumber ? (ctx.aciOfNumber?.(r.senderNumber) ?? null) : null);
      if (!sender) continue;
      const conv = ctx.conversationOf?.(msgId(sender, r.timestamp));
      if (!conv) {
        out.logs.push({ level: 'debug', msg: 'read sync for a message we have not seen', data: { sender, ts: r.timestamp } });
        continue;
      }
      upTo.set(conv, Math.max(upTo.get(conv) ?? 0, r.timestamp));
    }
    for (const [conversation, ts] of upTo) out.events.push({ t: 'read', conversation, upToTs: ts });
  }
  if (s.type === 'CONTACTS_SYNC' || s.type === 'GROUPS_SYNC' || s.blockedNumbers || s.blockedGroupIds) out.resync = true;
}

/** A message you sent from another device (phone, desktop). */
function sentTranscript(b: Build, sent: SigSentMessage) {
  const { ctx, out } = b;
  const self = ctx.self;
  let peer = lc(sent.destinationUuid);
  if (!peer && sent.destinationNumber) peer = ctx.aciOfNumber?.(sent.destinationNumber) ?? (sent.destinationNumber === ctx.selfNumber ? self : null);
  const groupOf = (dm: Partial<SigDataMessage>) => dm.groupInfo?.groupId;
  if (sent.editMessage?.dataMessage) {
    const dm = sent.editMessage.dataMessage;
    if (!groupOf(dm) && !peer) return void out.logs.push({ level: 'warn', msg: 'edit transcript without a resolvable recipient', data: { number: sent.destinationNumber } });
    const conversation = conversationFor(b, dm, peer ?? self, true);
    emitMessage(b, dm, { author: self, conversation, ts: sent.editMessage.targetSentTimestamp, editedTs: dm.timestamp });
    return;
  }
  if (sent.timestamp == null) return;
  if (!groupOf(sent) && !peer) return void out.logs.push({ level: 'warn', msg: 'sent transcript without a resolvable recipient', data: { number: sent.destinationNumber, ts: sent.timestamp } });
  const conversation = conversationFor(b, sent, peer ?? self, true);
  dataCommon(b, sent, self, conversation);
}

/** A poll as Signal sends it, as protocol poll.ts has it: options by their position, as votes name them. */
export function pollFact(p: { question?: string | null; allowMultiple?: boolean; options?: string[] | null }): PollFact {
  return {
    question: p.question || 'Poll',
    options: (p.options ?? []).map((text, i) => ({ id: String(i), text })),
    ...(p.allowMultiple ? { multi: true } : {}),
  };
}
