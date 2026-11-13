/**
 * The hub's network search and member walks (dither-chat's jobs.ts and netsearch.ts), in Discord's terms: a NetworkQuery
 * to the query Discord's own search bar sends, the hook's answer to facts and a NetworkSearchResult, and a walk's
 * members to a `members` event with source 'walk'. Pure functions, tested in test/search.test.ts; the hook runs the
 * requests through the client's own REST module and gateway store (hook.js search, walkMembers).
 */

import type * as P from '@dither-chat/protocol';
import type { HookCommand, RawChannel, RawMessage, RawSeenMember, RawUser } from './discord-types.ts';
import { messageEvents, routeChannel, userFacts, type AdapterState } from './ingest.ts';
import { DISCORD_EPOCH, isoToMs, snowflakeToMs } from './map.ts';

/** Discord answers 25 hits a page and will not page past this offset. */
export const SEARCH_PAGE = 25;
export const SEARCH_MAX_OFFSET = 9975;
/** What a 202 ("this place is still being indexed") without a retry_after waits. */
const INDEXING_WAIT_MS = 5000;
/** Discord answers a member query with at most 100. */
export const WALK_MAX = 100;
/** Discord lists at most this many recently joined members (op 35). */
export const RECENT_MAX = 10_000;
const MEMBERS_PER_EVENT = 500;

/** Our `has:` words to Discord's; 'reaction' it cannot search. */
const HAS: Record<string, string> = { attachment: 'file', file: 'file', audio: 'sound', image: 'image', video: 'video', link: 'link', embed: 'embed', sticker: 'sticker' };

export type SearchCommand = Extract<P.AdapterCommand, { t: 'search' }>;
export type WalkCommand = Extract<P.AdapterCommand, { t: 'walkMembers' }>;
export type SearchParams = Record<string, string | number | boolean | string[]>;

/** A snowflake at this time: the smallest id a message sent in that millisecond can have. */
function snowflakeAt(ms: number): bigint {
  const v = (BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n;
  return v < 0n ? 0n : v;
}

/** The query string Discord's own search sends for this query (repeated keys as arrays), at this offset. */
export function searchParams(q: P.NetworkQuery, offset = 0): SearchParams {
  const p: SearchParams = {};
  const text = q.text?.trim();
  if (text) p.content = text;
  if (q.authors?.length) p.author_id = [...q.authors];
  if (q.mentions?.length) p.mentions = [...q.mentions];
  const has = [...new Set((q.has ?? []).map((h) => HAS[h]).filter((h): h is string => !!h))];
  if (has.length) p.has = has;
  if (q.in?.length) p.channel_id = [...q.in];
  // min_id and max_id are exclusive: after is inclusive, before exclusive (search.ts).
  if (typeof q.after === 'number') {
    const at = snowflakeAt(q.after);
    p.min_id = (at > 0n ? at - 1n : 0n).toString();
  }
  if (typeof q.before === 'number') p.max_id = snowflakeAt(q.before).toString();
  if (q.sort === 'relevance') {
    p.sort_by = 'relevance';
    p.sort_order = 'desc';
  } else {
    p.sort_by = 'timestamp';
    p.sort_order = q.sort === 'oldest' ? 'asc' : 'desc';
  }
  if (offset > 0) p.offset = offset;
  p.include_nsfw = true;
  return p;
}

/** The hook command for a search, or why Discord cannot run it. */
export function searchCommand(cmd: SearchCommand): Extract<HookCommand, { kind: 'search' }> {
  if (cmd.scope.kind === 'all') throw new Error('Discord searches one server or one DM at a time, not everything at once');
  const offset = Math.max(0, Math.floor(cmd.offset ?? 0));
  if (offset > SEARCH_MAX_OFFSET) throw new Error(`Discord does not page past ${SEARCH_MAX_OFFSET + SEARCH_PAGE} hits`);
  const params = searchParams(cmd.query, offset);
  return cmd.scope.kind === 'space' ? { kind: 'search', guildId: cmd.scope.id, params } : { kind: 'search', channelId: cmd.scope.id, params };
}

/** The hook's answer to a search. */
export interface RawSearch {
  /** Discord answered 202: the place is still being indexed. Seconds, as its body says, or null when it did not. */
  indexing?: number | null;
  total?: number | null;
  /** The hits, in Discord's order. */
  messages?: RawMessage[];
  /** The channels and threads the hits are in, as the answer or the client's stores have them. */
  channels?: RawChannel[];
  /** Authors and people named, from the answer's `members` and the hits. */
  users?: RawUser[];
}

/**
 * A search's answer as facts and the reply: the channels and threads the hub may not know first, then each hit as a
 * message fact (live=false) after its people, then the result. A 202 is only a wait.
 */
export function searchOutcome(raw: RawSearch, cmd: SearchCommand, st: AdapterState): { events: P.AdapterEvent[]; result: P.NetworkSearchResult } {
  if (raw.indexing !== undefined) {
    const s = Number(raw.indexing);
    return { events: [], result: { hits: [], total: null, next: null, retryAfterMs: s > 0 ? Math.ceil(s * 1000) : INDEXING_WAIT_MS } };
  }
  const offset = Math.max(0, Math.floor(cmd.offset ?? 0));
  const want = Math.min(SEARCH_PAGE, Math.max(1, Math.floor(cmd.limit ?? SEARCH_PAGE)));
  const messages = (raw.messages ?? []).filter((m) => m?.id && m.channel_id && m.author?.id).slice(0, want);
  const events: P.AdapterEvent[] = [];
  const places = new Set(messages.map((m) => m.channel_id));
  for (const c of raw.channels ?? []) {
    if (!c?.id || !places.has(c.id) || st.known.has(c.id)) continue;
    events.push(...routeChannel(c, st));
  }
  events.push(...userFacts(raw.users ?? [], st));
  for (const m of messages) events.push(...messageEvents(m, st, false));
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0 ? raw.total : null;
  const upTo = offset + messages.length;
  // Without a total, a full page means there may be more.
  const more = total !== null ? upTo < total : (raw.messages?.length ?? 0) >= SEARCH_PAGE;
  const next = messages.length && more && upTo <= SEARCH_MAX_OFFSET ? upTo : null;
  return { events, result: { hits: messages.map((m) => m.id), total, next } };
}

/**
 * The hook command for a walk: one member query of the gateway, at most WALK_MAX, or (`recent`) one page of the
 * recently joined from `after`. A query by name is never empty: a user account may not ask the gateway for everyone.
 */
export function walkCommand(cmd: WalkCommand): Extract<HookCommand, { kind: 'walkMembers' }> {
  const limit = Math.min(WALK_MAX, Math.max(1, Math.floor(cmd.limit || WALK_MAX)));
  if (cmd.recent) return { kind: 'walkMembers', guildId: cmd.space, query: '', limit, recent: true, ...(cmd.after ? { after: String(cmd.after) } : {}) };
  const query = typeof cmd.query === 'string' ? cmd.query : '';
  if (!query) throw new Error('a member walk by name needs a query: Discord does not list everyone to a user account');
  return { kind: 'walkMembers', guildId: cmd.space, query, limit };
}

/** The hook's answer to a walk: the members the gateway's chunks carried, and the server's count when the client has it. */
export interface RawWalk {
  guildId: string;
  members: RawSeenMember[];
  total?: number | null;
  /** A recent page: the next page's start, or null at the end. */
  next?: string | null;
}

/**
 * A walk's members as a `members` event with source 'walk' after their identities, every one of them (a walk says
 * who it found, not only what changed), and the reply. They count as told for the passive path after.
 */
export function walkOutcome(raw: RawWalk, cmd: WalkCommand, st: AdapterState): { events: P.AdapterEvent[]; result: P.WalkResult } {
  const guildId = cmd.space;
  const byId = new Map<string, RawSeenMember>();
  for (const m of raw.members ?? []) if (m?.user?.id && !byId.has(m.user.id)) byId.set(m.user.id, m);
  const list = [...byId.values()];
  const members: P.MemberFact[] = list.map((m) => {
    const joined = m.joined_at ? Date.parse(m.joined_at) : NaN;
    // The passive path tells this member again only when something changes.
    st.members.set(`${guildId}:${m.user.id}`, JSON.stringify([m.nick ?? null, m.roles ?? null, m.joined_at ?? null]));
    return { who: m.user.id, ...(m.nick ? { nick: m.nick } : {}), ...(m.roles ? { roles: m.roles } : {}), ...(Number.isFinite(joined) ? { joinedAt: joined } : {}) };
  });
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0 ? raw.total : undefined;
  // A recent walk at its end, having started at the newest: everyone the network will list (up to its 10,000) came back.
  const next = cmd.recent ? (typeof raw.next === 'string' && raw.next ? raw.next : null) : undefined;
  const complete = !!cmd.recent && next === null && total !== undefined && total <= RECENT_MAX;
  const events: P.AdapterEvent[] = userFacts(
    list.map((m) => m.user),
    st,
  );
  for (let i = 0; i < Math.max(1, members.length); i += MEMBERS_PER_EVENT)
    events.push({
      t: 'members',
      space: guildId,
      source: 'walk',
      members: members.slice(i, i + MEMBERS_PER_EVENT),
      ...(i === 0 && total !== undefined ? { total } : {}),
      ...(i === 0 && complete ? { complete: true } : {}),
    });
  return { events, result: { count: members.length, ...(total !== undefined ? { total } : {}), ...(next !== undefined ? { next } : {}) } };
}

/** The ts of a history page's oldest message, when it had one. */
export function oldestOf(messages: RawMessage[]): number | undefined {
  let oldest: number | undefined;
  for (const m of messages) {
    const ts = isoToMs(m?.timestamp) || (m?.id ? snowflakeToMs(m.id) : 0);
    if (ts > 0 && (oldest === undefined || ts < oldest)) oldest = ts;
  }
  return oldest;
}
