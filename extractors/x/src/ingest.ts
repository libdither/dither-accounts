/**
 * What the extractor has told the hub, and the diff of each new snapshot from the page against it. The hook sends
 * whole states (the inbox, an open conversation's loaded messages), never changes, so changes are worked out here:
 * new and changed conversations, read state, new, edited and deleted messages, reactions added and removed, typing.
 * Ids, sequence numbers and fingerprints only; nothing here is written to disk but the last sequence number seen per
 * conversation (`seen`, for catching up after a restart).
 */
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey } from '@dither-chat/protocol';
import { conversationFact, identityFact, messageFact } from './map.ts';
import type { RawConversation, RawInbox, RawMessage, RawMessages, RawUser } from './raw.ts';

interface KnownMessage {
  fp: string;
  text: string | null;
  seq: string | null;
  ts: number;
  /** emoji key → users who reacted with it (message-level reactions only). */
  reactions: Map<string, Set<string>>;
}

export class XState {
  selfId: string | null = null;
  selfUser: RawUser | null = null;
  readonly users = new Map<string, string>();
  readonly convs = new Map<string, { fp: string; raw: RawConversation; participants: string[] }>();
  readonly reads = new Map<string, string>();
  readonly msgs = new Map<string, Map<string, KnownMessage>>();
  readonly seqIds = new Map<string, Map<string, string>>();
  /** The highest sequence number announced per conversation (kept across restarts). */
  readonly seen = new Map<string, string>();
  readonly typing = new Map<string, Set<string>>();
  inboxLoaded = false;

  constructor(seen?: Record<string, string>) {
    for (const [k, v] of Object.entries(seen ?? {})) if (typeof v === 'string') this.seen.set(k, v);
  }

  idForSeq(conv: string, seq: string): string | undefined {
    return this.seqIds.get(conv)?.get(seq);
  }
  handleOf(id: string): string | undefined {
    if (this.selfUser?.id === id) return this.selfUser.screenName ?? undefined;
    for (const c of this.convs.values()) for (const u of c.raw.users) if (u.id === id && u.screenName) return u.screenName;
    return undefined;
  }
  seenObject(): Record<string, string> {
    return Object.fromEntries(this.seen);
  }
  /** Start over (resync): everything is announced again as it is next seen; where each conversation got to is kept. */
  forget() {
    this.users.clear();
    this.convs.clear();
    this.reads.clear();
    this.msgs.clear();
    this.seqIds.clear();
    this.typing.clear();
  }
}

const cmpSeq = (a: string | null | undefined, b: string | null | undefined): number => {
  if (!a || !b) return 0;
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return 0;
  }
};

function userEvents(st: XState, users: RawUser[]): P.AdapterEvent[] {
  const out: P.AdapterEvent[] = [];
  for (const u of users) {
    if (st.selfId && u.id === st.selfId) st.selfUser = { ...st.selfUser, ...u, screenName: u.screenName ?? st.selfUser?.screenName ?? null } as RawUser;
    const fact = identityFact(u, st.selfId);
    const fp = JSON.stringify(fact);
    if (st.users.get(u.id) === fp) continue;
    st.users.set(u.id, fp);
    out.push({ t: 'identity', identity: fact });
  }
  return out;
}

export interface InboxResult {
  events: P.AdapterEvent[];
  /** Conversations whose newest message is newer than what was announced: worth a look. */
  newer: string[];
}

export function ingestInbox(st: XState, inbox: RawInbox, now = Date.now()): InboxResult {
  const events: P.AdapterEvent[] = [];
  const newer: string[] = [];
  for (const c of inbox.conversations) {
    events.push(...userEvents(st, c.users));
    const prev = st.convs.get(c.id);
    const fact = conversationFact(c, st.selfId, prev?.participants);
    const fp = JSON.stringify(fact);
    if (prev?.fp !== fp) events.push({ t: 'conversation', conversation: fact });
    st.convs.set(c.id, { fp, raw: c, participants: prev?.participants ?? [] });
    // Read state, as the inbox has it: the unread count, and up to when (when the message it names is known).
    const readKey = `${c.unread ?? ''}|${c.lastReadSeq ?? ''}`;
    if (c.unread !== null && st.reads.get(c.id) !== readKey) {
      const upToId = c.lastReadSeq ? st.idForSeq(c.id, c.lastReadSeq) : undefined;
      const upTo = upToId ? st.msgs.get(c.id)?.get(upToId)?.ts : c.unread === 0 ? (c.lastTs ?? undefined) : undefined;
      if (upTo !== undefined) {
        st.reads.set(c.id, readKey);
        events.push({ t: 'read', conversation: c.id, upToTs: upTo, unread: c.unread });
      }
    }
    const seen = st.seen.get(c.id);
    if (c.lastSeq && (!seen || cmpSeq(c.lastSeq, seen) > 0)) newer.push(c.id);
    else if (!c.lastSeq && c.lastTs && !seen && (c.unread ?? 0) > 0) newer.push(c.id);
  }
  // Typing: starts for who is typing now, stops for who no longer is.
  const nowTyping = new Map<string, Set<string>>();
  for (const t of inbox.typing) nowTyping.set(t.conv, new Set(t.users.filter((u) => u !== st.selfId)));
  for (const [conv, users] of nowTyping) {
    const was = st.typing.get(conv) ?? new Set();
    for (const u of users) if (!was.has(u)) events.push({ t: 'typing', conversation: conv, author: u, ttl: 8000 });
    for (const u of was) if (!users.has(u)) events.push({ t: 'typing', conversation: conv, author: u, stop: true });
  }
  for (const [conv, was] of st.typing) if (!nowTyping.has(conv)) for (const u of was) events.push({ t: 'typing', conversation: conv, author: u, stop: true });
  st.typing.clear();
  for (const [k, v] of nowTyping) if (v.size) st.typing.set(k, v);
  if (!inbox.loading) st.inboxLoaded = true;
  void now;
  return { events, newer };
}

function reactionMap(m: RawMessage, selfId: string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of m.reactions) {
    if (r.attachmentId) continue;
    const key = canonicalReactionKey(r.emoji);
    const set = out.get(key) ?? new Set<string>();
    for (const u of r.users) set.add(u);
    if (r.mine && selfId) set.add(selfId);
    out.set(key, set);
  }
  return out;
}
const fingerprint = (f: P.MessageFact) => JSON.stringify({ b: f.body, k: f.kind, a: f.attachments?.map((a) => [a.url, a.mime, a.size]), r: f.replyTo, e: f.extra?.edited, f: !!f.forward });

export interface MessagesOpts {
  /** Backfill (history): no notifications, whatever the times. */
  backfill?: boolean;
  now?: number;
}

/**
 * The open conversation's loaded messages. New ones are message facts (live when newer than anything announced in
 * that conversation and recent), changed ones are sent again (an edit), hidden ones and ones missing from inside the
 * loaded range are deletes, and reactions are diffed per message.
 */
export function ingestMessages(st: XState, raw: RawMessages, opts: MessagesOpts = {}): P.AdapterEvent[] {
  const now = opts.now ?? Date.now();
  const events: P.AdapterEvent[] = [];
  const conv = raw.conv;
  const known = st.msgs.get(conv) ?? new Map<string, KnownMessage>();
  st.msgs.set(conv, known);
  const seqIds = st.seqIds.get(conv) ?? new Map<string, string>();
  st.seqIds.set(conv, seqIds);
  for (const m of raw.messages) if (m.seq) seqIds.set(m.seq, m.id);
  // Who is in it, when the page says (groups list their members on the open conversation).
  const c = st.convs.get(conv);
  if (c && raw.participants.length && JSON.stringify(c.participants) !== JSON.stringify(raw.participants)) {
    c.participants = raw.participants;
    const fact = conversationFact(c.raw, st.selfId, raw.participants);
    const fp = JSON.stringify(fact);
    if (fp !== c.fp) {
      c.fp = fp;
      events.push({ t: 'conversation', conversation: fact });
    }
  }
  const seenBefore = st.seen.get(conv);
  let maxSeq = seenBefore ?? null;
  const present = new Set<string>();
  for (const m of raw.messages) {
    if (m.hidden) {
      if (known.has(m.id)) {
        known.delete(m.id);
        events.push({ t: 'delete', conversation: conv, nativeId: m.id });
      }
      continue;
    }
    present.add(m.id);
    if (m.senderUser) events.push(...userEvents(st, [m.senderUser]));
    const fact = messageFact(m, { selfId: st.selfId, selfHandle: st.selfUser?.screenName, idForSeq: (s) => seqIds.get(s) });
    const fp = fingerprint(fact);
    const prev = known.get(m.id);
    const reactions = reactionMap(m, st.selfId);
    if (!prev) {
      const fresh = !opts.backfill && !!seenBefore && cmpSeq(m.seq, seenBefore) > 0 && now - fact.ts < 15 * 60_000;
      events.push({ t: 'message', message: fact, live: fresh });
    } else {
      if (prev.fp !== fp) {
        const edited = prev.text !== fact.body;
        events.push({ t: 'message', message: { ...fact, ...(edited ? { editedTs: now } : {}) }, live: false });
      }
      // Reactions: what was added and what was taken away since the last look.
      for (const [key, users] of reactions) {
        const was = prev.reactions.get(key) ?? new Set();
        for (const u of users) if (!was.has(u)) events.push({ t: 'reaction', conversation: conv, message: m.id, author: u, key });
      }
      for (const [key, was] of prev.reactions) {
        const users = reactions.get(key) ?? new Set();
        for (const u of was) if (!users.has(u)) events.push({ t: 'reaction', conversation: conv, message: m.id, author: u, key, remove: true });
      }
    }
    known.set(m.id, { fp, text: fact.body, seq: m.seq, ts: fact.ts, reactions });
    if (m.seq && (!maxSeq || cmpSeq(m.seq, maxSeq) > 0)) maxSeq = m.seq;
  }
  // Gone from inside the range the page has loaded: deleted (for everyone, or by its disappearing timer).
  const seqs = raw.messages.map((m) => m.seq).filter((s): s is string => !!s);
  if (seqs.length >= 2) {
    const lo = seqs.reduce((a, b) => (cmpSeq(a, b) <= 0 ? a : b));
    const hi = seqs.reduce((a, b) => (cmpSeq(a, b) >= 0 ? a : b));
    for (const [id, k] of known) {
      if (present.has(id) || !k.seq) continue;
      if (cmpSeq(k.seq, lo) > 0 && cmpSeq(k.seq, hi) < 0) {
        known.delete(id);
        events.push({ t: 'delete', conversation: conv, nativeId: id });
      }
    }
  }
  if (maxSeq) st.seen.set(conv, maxSeq);
  return events;
}
