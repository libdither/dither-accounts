/**
 * What the inbox feed has told the hub, so each read gives only what is new: the conversation once, identities when
 * they change, and messages not announced before, each live (it may notify) only when newer than the newest
 * announced and under 15 minutes old. Kept in reddit-state.json: the newest time and the ids lately announced. Pure.
 */
import type * as P from '@dither-chat/protocol';
import { type FeedEntry, feedConversation, feedMessage, identityOf } from './map.ts';

export interface FeedKept {
  newestMs?: number;
  ids?: string[];
}
const KEEP_IDS = 2000;
export const LIVE_MS = 15 * 60_000;
/** A fresh account reads back at most this far. */
export const FIRST_READ_MS = 7 * 24 * 3600_000;

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
    return !this.newestMs && !this.ids.size;
  }

  /** Everything is announced again (the hub reconnected, or a resync). */
  forget() {
    this.people.clear();
    this.convSent = false;
  }
  /** And every message too (resync). */
  forgetAll() {
    this.forget();
    this.ids.clear();
  }

  conversation(): P.AdapterEvent[] {
    if (this.convSent) return [];
    this.convSent = true;
    return [{ t: 'conversation', conversation: feedConversation() }];
  }

  /** Identity facts for these people (usernames, `r/name`, the Reddit actor), each once unless it changed. */
  identities(names: Iterable<string>, self: string | null, avatars?: Map<string, string>): P.AdapterEvent[] {
    const out: P.AdapterEvent[] = [];
    for (const n of names) {
      const fact = identityOf(n, self, avatars?.get(n));
      const fp = JSON.stringify(fact);
      if (this.people.get(n) === fp) continue;
      this.people.set(n, fp);
      out.push({ t: 'identity', identity: fact });
    }
    return out;
  }

  /** One read's events: the conversation, people, then the messages not announced before, oldest first. */
  page(entries: FeedEntry[], opts: { self: string | null; now: number; backfill: boolean }): P.AdapterEvent[] {
    const fresh = entries.filter((e) => !this.ids.has(e.nativeId));
    const out: P.AdapterEvent[] = [...this.conversation()];
    if (!fresh.length) return out;
    out.push(...this.identities(new Set(fresh.map((e) => e.actor)), opts.self));
    const before = this.newestMs;
    for (const e of [...fresh].sort((a, b) => a.ts - b.ts)) {
      const live = !opts.backfill && e.ts > before && opts.now - e.ts < LIVE_MS;
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
