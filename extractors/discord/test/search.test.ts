/**
 * The hub's network search and member walks in Discord's terms (search.ts): a NetworkQuery to the query Discord's
 * search bar sends, the hook's answer to facts and a NetworkSearchResult (202: a wait), a walk's members to a `members`
 * event with source 'walk', and a history page's oldest message.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { newState, seenMembers } from '../src/ingest.ts';
import { oldestOf, searchCommand, searchOutcome, searchParams, walkCommand, walkOutcome } from '../src/search.ts';
import type { RawMessage } from '../src/discord-types.ts';

const SELF = '100000000000000001';
const GUILD = '200000000000000001';
const CH = '300000000000000001';
const THREAD = '300000000000000099';
const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const alice = { id: ALICE, username: 'alice', global_name: 'Alice' };
const bob = { id: BOB, username: 'bob' };
const state = () => Object.assign(newState(), { selfId: SELF });
const search = (query: Partial<P.NetworkQuery> = {}, extra: Partial<Extract<P.AdapterCommand, { t: 'search' }>> = {}): Extract<P.AdapterCommand, { t: 'search' }> => ({
  t: 'search',
  id: 'q',
  scope: { kind: 'space', id: GUILD },
  query: { text: 'borrow checker', ...query },
  ...extra,
});
const msg = (id: string, extra: Partial<RawMessage> = {}): RawMessage => ({ id, channel_id: CH, guild_id: GUILD, author: alice, content: `hit ${id}`, timestamp: '2026-01-02T00:00:00.000Z', ...extra });

describe('a NetworkQuery as Discord asks it', () => {
  test('every field, in the names and shapes Discord’s search bar sends', () => {
    const after = Date.parse('2026-01-01T00:00:00.000Z');
    const before = Date.parse('2026-02-01T00:00:00.000Z');
    const p = searchParams({ text: ' "borrow checker" rust ', authors: [ALICE, BOB], mentions: [SELF], in: [CH], has: ['audio', 'attachment', 'reaction', 'image', 'file'], after, before, sort: 'oldest' }, 50);
    expect(p).toEqual({
      content: '"borrow checker" rust',
      author_id: [ALICE, BOB],
      mentions: [SELF],
      has: ['sound', 'file', 'image'],
      channel_id: [CH],
      min_id: (((BigInt(after) - 1420070400000n) << 22n) - 1n).toString(),
      max_id: ((BigInt(before) - 1420070400000n) << 22n).toString(),
      sort_by: 'timestamp',
      sort_order: 'asc',
      offset: 50,
      include_nsfw: true,
    });
    // An id made in the `after` millisecond is past min_id; one made in the `before` millisecond is not under max_id.
    expect(BigInt(p.min_id as string) < (BigInt(after) - 1420070400000n) << 22n).toBe(true);
  });

  test('newest by default, relevance when asked; no text, no content; offset 0 left out', () => {
    expect(searchParams({ text: '' })).toEqual({ sort_by: 'timestamp', sort_order: 'desc', include_nsfw: true });
    expect(searchParams({ text: 'x', sort: 'relevance' })).toMatchObject({ content: 'x', sort_by: 'relevance', sort_order: 'desc' });
  });

  test("a server, a conversation, and not everything at once", () => {
    expect(searchCommand(search({}, { offset: 25 }))).toEqual({ kind: 'search', guildId: GUILD, params: expect.objectContaining({ content: 'borrow checker', offset: 25 }) });
    expect(searchCommand(search({}, { scope: { kind: 'conversation', id: CH } }))).toMatchObject({ kind: 'search', channelId: CH });
    expect(() => searchCommand(search({}, { scope: { kind: 'all' } }))).toThrow(/one server or one DM at a time/);
    expect(() => searchCommand(search({}, { offset: 10_000 }))).toThrow();
  });
});

describe("a search's answer", () => {
  test('the thread the hub never heard of first, then each hit after its people; hits in order, the next offset', () => {
    const st = state();
    st.known.add(CH);
    const raw = {
      total: 31,
      messages: [msg('901'), msg('902', { channel_id: THREAD, author: bob, mentions: [alice] })],
      channels: [
        { id: THREAD, type: 11, guild_id: GUILD, parent_id: CH, name: 'a thread', thread_metadata: { archived: true } },
        { id: CH, type: 0, guild_id: GUILD, name: 'general' },
        { id: '300000000000000500', type: 0, guild_id: GUILD, name: 'no hits here' },
      ],
    };
    const { events, result } = searchOutcome(raw, search({}, { offset: 25 }), st);
    expect(events.map((e) => e.t)).toEqual(['conversation', 'identity', 'message', 'identity', 'message']);
    expect(events[0]).toEqual({ t: 'conversation', conversation: expect.objectContaining({ nativeId: THREAD, shape: 'thread', parentConversation: CH, archived: true }) });
    expect(events.filter((e) => e.t === 'message')).toEqual([
      { t: 'message', live: false, message: expect.objectContaining({ nativeId: '901', conversation: CH, author: ALICE, body: 'hit 901' }) },
      { t: 'message', live: false, message: expect.objectContaining({ nativeId: '902', conversation: THREAD, author: BOB }) },
    ]);
    expect(result).toEqual({ hits: ['901', '902'], total: 31, next: 27 });
    expect(st.known.has(THREAD)).toBe(true);
  });

  test('the last page has no next; without a total, a full page may have more', () => {
    expect(searchOutcome({ total: 2, messages: [msg('1'), msg('2')] }, search(), state()).result).toEqual({ hits: ['1', '2'], total: 2, next: null });
    const page = Array.from({ length: 25 }, (_, i) => msg(String(1000 + i)));
    expect(searchOutcome({ messages: page }, search(), state()).result).toMatchObject({ total: null, next: 25 });
    expect(searchOutcome({ total: 0, messages: [] }, search(), state()).result).toEqual({ hits: [], total: 0, next: null });
    // A smaller limit: that many, and the next page from there.
    expect(searchOutcome({ total: 30, messages: page }, search({}, { limit: 10 }), state()).result).toMatchObject({ next: 10 });
  });

  test('202 (still indexing) is a wait and nothing else', () => {
    expect(searchOutcome({ indexing: 2.5 }, search(), state())).toEqual({ events: [], result: { hits: [], total: null, next: null, retryAfterMs: 2500 } });
    expect(searchOutcome({ indexing: null }, search(), state()).result.retryAfterMs).toBe(5000);
  });
});

describe('a member walk', () => {
  test('at most 100 by a prefix, never an empty one; a recent page from where the last one ended', () => {
    expect(walkCommand({ t: 'walkMembers', id: 'w', space: GUILD, query: 'al', limit: 1000 })).toEqual({ kind: 'walkMembers', guildId: GUILD, query: 'al', limit: 100 });
    expect(() => walkCommand({ t: 'walkMembers', id: 'w', space: GUILD, query: '', limit: 100 })).toThrow(/needs a query/);
    expect(walkCommand({ t: 'walkMembers', id: 'w', space: GUILD, query: '', limit: 1000, recent: true })).toEqual({ kind: 'walkMembers', guildId: GUILD, query: '', limit: 100, recent: true });
    expect(walkCommand({ t: 'walkMembers', id: 'w', space: GUILD, query: 'x', limit: 1000, recent: true, after: BOB })).toEqual({ kind: 'walkMembers', guildId: GUILD, query: '', limit: 100, recent: true, after: BOB });
  });

  test("everyone found, after their identities, as source 'walk' with the server's count; the passive path does not tell them again", () => {
    const st = state();
    seenMembers(GUILD, [{ user: alice, nick: 'Al', roles: ['Helper'], joined_at: null }], st);
    const cmd = { t: 'walkMembers' as const, id: 'w', space: GUILD, query: 'a', limit: 100 };
    const { events, result } = walkOutcome({ guildId: GUILD, members: [{ user: alice, nick: 'Al', roles: ['Helper'], joined_at: null }, { user: bob, nick: null, roles: [], joined_at: '2025-01-01T00:00:00.000Z' }], total: 1200 }, cmd, st);
    expect(events.map((e) => e.t)).toEqual(['identity', 'members']);
    expect(events[1]).toEqual({
      t: 'members',
      space: GUILD,
      source: 'walk',
      total: 1200,
      members: [
        { who: ALICE, nick: 'Al', roles: ['Helper'] },
        { who: BOB, roles: [], joinedAt: Date.parse('2025-01-01T00:00:00.000Z') },
      ],
    });
    expect(result).toEqual({ count: 2, total: 1200 });
    expect(seenMembers(GUILD, [{ user: bob, nick: null, roles: [], joined_at: '2025-01-01T00:00:00.000Z' }], st)).toEqual([]);
  });

  test("a recent page says where the next starts; the last one is the server complete; an empty walk still says the count", () => {
    const recent = { t: 'walkMembers' as const, id: 'w', space: GUILD, query: '', limit: 1000, recent: true };
    const page = walkOutcome({ guildId: GUILD, members: [{ user: alice }, { user: bob }], total: 2390, next: BOB }, recent, state());
    expect(page.result).toEqual({ count: 2, total: 2390, next: BOB });
    expect(page.events.at(-1)).not.toHaveProperty('complete');
    const last = walkOutcome({ guildId: GUILD, members: [{ user: alice }], total: 2390, next: null }, { ...recent, after: BOB }, state());
    expect(last.result).toEqual({ count: 1, total: 2390, next: null });
    expect(last.events.at(-1)).toMatchObject({ t: 'members', source: 'walk', total: 2390, complete: true });
    // Past 10,000 the list does not reach everyone.
    expect(walkOutcome({ guildId: GUILD, members: [], total: 50_000, next: null }, recent, state()).events.at(-1)).not.toHaveProperty('complete');
    const none = walkOutcome({ guildId: GUILD, members: [], total: null }, { t: 'walkMembers', id: 'w', space: GUILD, query: 'zz', limit: 100 }, state());
    expect(none).toEqual({ events: [{ t: 'members', space: GUILD, source: 'walk', members: [] }], result: { count: 0 } });
  });
});

describe('a history page', () => {
  test('its oldest message', () => {
    expect(oldestOf([msg('3', { timestamp: '2026-01-03T00:00:00.000Z' }), msg('1', { timestamp: '2026-01-01T00:00:00.000Z' }), msg('2')])).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(oldestOf([])).toBeUndefined();
  });
});
