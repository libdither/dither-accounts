/**
 * What the extractor has told the hub, so each read gives only what is new: people when they change, conversations
 * when they change, and messages, live (they may notify) only when newer than the newest announced in their stream,
 * under 15 minutes old and not announced before. Kept across restarts in luma-state.json: the newest times, the ids
 * announced lately and the chat's sync cursors; no words or names.
 */
import type * as P from '@dither-chat/protocol';
import { feedConversation, feedMessage, type FeedEntry, identityFact, LUMA_ACTOR, lumaIdentity, type LumaUser } from './map.ts';

export interface Kept {
  /** Newest announced time per stream: 'feed', 'blasts', 'chat'. */
  newest?: Record<string, number>;
  ids?: string[];
  convCursor?: string | null;
  msgCursor?: string | null;
}
const KEEP_IDS = 4000;
export const LIVE_MS = 15 * 60_000;
/** A fresh account's notifications: at most this far back, and this many pages. */
export const FIRST_READ_MS = 14 * 24 * 3600_000;
export const FIRST_READ_PAGES = 2;
export const CATCH_UP_PAGES = 3;

export class Tracker {
  readonly newest: Record<string, number>;
  readonly ids: Set<string>;
  convCursor: string | null;
  msgCursor: string | null;
  private readonly people = new Map<string, string>();
  private readonly convs = new Map<string, string>();
  items = 0;

  constructor(kept: Kept = {}) {
    this.newest = Object.fromEntries(Object.entries(kept.newest ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
    this.ids = new Set((Array.isArray(kept.ids) ? kept.ids : []).filter((x): x is string => typeof x === 'string').slice(-KEEP_IDS));
    this.convCursor = typeof kept.convCursor === 'string' ? kept.convCursor : null;
    this.msgCursor = typeof kept.msgCursor === 'string' ? kept.msgCursor : null;
  }

  fresh(stream: string): boolean {
    return !this.newest[stream];
  }

  /** Everything is announced again (the hub reconnected, or a resync). */
  forget() {
    this.people.clear();
    this.convs.clear();
  }

  identities(users: Iterable<LumaUser>, selfId: string | null): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [];
    for (const u of users) {
      const fact = identityFact(u, selfId);
      const fp = JSON.stringify(fact);
      if (this.people.get(u.id) === fp) continue;
      this.people.set(u.id, fp);
      out.push({ t: 'identity', identity: fact });
    }
    return out;
  }

  /** Identities for authors known only by id, and Luma itself. */
  stubs(ids: Iterable<string>): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [];
    for (const id of ids) {
      if (this.people.has(id)) continue;
      if (id === LUMA_ACTOR) {
        this.people.set(id, 'luma');
        out.push({ t: 'identity', identity: lumaIdentity() });
        continue;
      }
      if (!/^usr-[A-Za-z0-9]{1,40}$/.test(id)) continue;
      this.people.set(id, 'stub');
      out.push({ t: 'identity', identity: { nativeId: id } });
    }
    return out;
  }

  conversation(fact: P.ConversationFact): P.AdapterEvent[] {
    const fp = JSON.stringify(fact);
    if (this.convs.get(fact.nativeId) === fp) return [];
    this.convs.set(fact.nativeId, fp);
    return [{ t: 'conversation', conversation: fact }];
  }
  get conversations(): number {
    return this.convs.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Messages of one stream, oldest first; `backfill` never notifies. Identities and conversations come first. */
  messages(stream: string, list: P.MessageFact[], o: { now: number; backfill: boolean }): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [];
    const before = this.newest[stream] ?? 0;
    for (const m of [...list].sort((a, b) => a.ts - b.ts)) {
      const live = !o.backfill && m.ts > before && o.now - m.ts < LIVE_MS && !this.ids.has(m.nativeId);
      this.ids.delete(m.nativeId);
      this.ids.add(m.nativeId);
      this.items++;
      out.push({ t: 'message', message: m, live });
      if (m.ts > (this.newest[stream] ?? 0)) this.newest[stream] = m.ts;
    }
    while (this.ids.size > KEEP_IDS) this.ids.delete(this.ids.values().next().value!);
    return out;
  }

  /** The notifications' page: the feed conversation once, then its messages. */
  feed(entries: FeedEntry[], o: { now: number; backfill: boolean }): P.AdapterEvent[] {
    return [...this.conversation(feedConversation()), ...this.messages('feed', entries.map(feedMessage), o)];
  }

  kept(): Kept {
    return { newest: this.newest, ids: [...this.ids], convCursor: this.convCursor, msgCursor: this.msgCursor };
  }
}
