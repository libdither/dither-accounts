/**
 * The hub's network search (dither-chat's netsearch.ts) as Matrix's server-side search (POST /search, room_events
 * on content.body), and the numeric offsets the hub pages by kept against the server's next_batch tokens. Encrypted
 * rooms are not searchable on the server, so they never answer.
 */

import type * as P from '@dither-chat/protocol';

/** A page of search results, as the hub asks for (Discord's size, and Synapse's default too). */
export const SEARCH_PAGE = 25;

export type SearchCommand = Extract<P.AdapterCommand, { t: 'search' }>;

/** The /search request body: the words, the rooms (null: every room the account is in), the people, the order. */
export function searchBody(q: P.NetworkQuery, rooms: string[] | null, limit: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { limit: Math.max(1, Math.min(SEARCH_PAGE, Math.floor(limit) || SEARCH_PAGE)) };
  if (rooms) filter.rooms = rooms;
  if (q.authors?.length) filter.senders = [...q.authors];
  return {
    search_categories: {
      room_events: {
        search_term: q.text.trim(),
        keys: ['content.body'],
        filter,
        order_by: q.sort === 'relevance' ? 'rank' : 'recent',
      },
    },
  };
}

/** The same search, whatever page: the key its next_batch tokens are kept under. */
export const searchKey = (cmd: SearchCommand) => JSON.stringify([cmd.scope, cmd.query]);

/**
 * The server's next_batch tokens by the offsets the hub pages with: the reply's `next` is the offset of the page the
 * token fetches. A token is good for one search; the oldest are forgotten past `max`.
 */
export class SearchPages {
  private tokens = new Map<string, string>();
  constructor(private max = 200) {}

  /** The token for this search at this offset; undefined for the first page, null when it was never given or forgotten. */
  token(key: string, offset: number): string | null | undefined {
    if (offset <= 0) return undefined;
    return this.tokens.get(`${offset}:${key}`) ?? null;
  }

  /** Keep a page's next_batch and say the offset that fetches it (null: no more pages). */
  keep(key: string, offset: number, got: number, nextBatch: unknown): number | null {
    if (typeof nextBatch !== 'string' || !nextBatch || got <= 0) return null;
    const next = offset + got;
    this.tokens.set(`${next}:${key}`, nextBatch);
    while (this.tokens.size > this.max) this.tokens.delete(this.tokens.keys().next().value!);
    return next;
  }
}
