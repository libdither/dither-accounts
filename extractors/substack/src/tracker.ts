/**
 * What the feed has told the hub, so each read gives only what is new: the conversation once, people when they change,
 * and Activity messages, live (they may notify) only when newer than the newest announced, under 15 minutes old and
 * not announced before. Kept across restarts in substack-state.json: the newest time and the ids announced lately.
 */
import type * as P from '@dither-chat/protocol';
import { type FeedEntry, feedConversation, feedMessage, identityFact, type SsUser, SUBSTACK_ACTOR, substackIdentity } from './map.ts';

export interface FeedKept {
  newestMs?: number;
  ids?: string[];
}
const KEEP_IDS = 2000;
export const LIVE_MS = 15 * 60_000;
/** A fresh account reads back at most this far, and this many pages. */
export const FIRST_READ_MS = 7 * 24 * 3600_000;
export const FIRST_READ_PAGES = 2;
/** Later reads go back at most this many pages to meet what was announced. */
export const CATCH_UP_PAGES = 3;

export class FeedTracker {
  newestMs: number;
  readonly ids: Set<string>;
  private readonly people = new Map<string, string>();
  private convSent = false;
  /** Messages announced since the start. */
  items = 0;

  constructor(kept: FeedKept = {}) {
    this.newestMs = typeof kept.newestMs === 'number' && Number.isFinite(kept.newestMs) ? kept.newestMs : 0;
    this.ids = new Set((Array.isArray(kept.ids) ? kept.ids : []).filter((x): x is string => typeof x === 'string').slice(-KEEP_IDS));
  }

  get fresh(): boolean {
    return !this.newestMs;
  }

  /** Everything is announced again (the hub reconnected, or a resync). */
  forget() {
    this.people.clear();
    this.convSent = false;
  }

  conversation(): P.AdapterEvent[] {
    if (this.convSent) return [];
    this.convSent = true;
    return [{ t: 'conversation', conversation: feedConversation() }];
  }

  identities(users: Iterable<SsUser>, selfId: string | null): P.AdapterEvent[] {
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

  /** Bare identities for people known only by id (an activity item's sender the answer did not describe). */
  stubs(ids: Iterable<string>): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [];
    for (const id of ids) {
      if (this.people.has(id)) continue;
      if (id === SUBSTACK_ACTOR) {
        this.people.set(id, 'substack');
        out.push({ t: 'identity', identity: substackIdentity() });
        continue;
      }
      if (!/^\d{1,15}$/.test(id)) continue;
      this.people.set(id, 'stub');
      out.push({ t: 'identity', identity: { nativeId: id } });
    }
    return out;
  }

  /** Has it announced this message? */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** One page's messages, oldest first. Identities come first, from the caller. */
  messages(entries: FeedEntry[], opts: { now: number; backfill: boolean }): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [...this.conversation()];
    const before = this.newestMs;
    for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
      const live = !opts.backfill && e.ts > before && opts.now - e.ts < LIVE_MS && !this.ids.has(e.nativeId);
      this.ids.delete(e.nativeId);
      this.ids.add(e.nativeId);
      this.items++;
      out.push({ t: 'message', message: feedMessage(e), live });
      if (e.ts > this.newestMs) this.newestMs = e.ts;
    }
    while (this.ids.size > KEEP_IDS) this.ids.delete(this.ids.values().next().value!);
    return out;
  }

  kept(): FeedKept {
    return { ...(this.newestMs ? { newestMs: this.newestMs } : {}), ids: [...this.ids] };
  }
}
