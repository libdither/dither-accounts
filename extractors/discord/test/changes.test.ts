/**
 * Pins, roles and custom statuses from forwarded actions to protocol events (changes.ts through ingest.ts): each
 * change told once, nothing for what was already so.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { duePins, PIN_HOLD_MS } from '../src/changes.ts';
import { messageEvents, newState, translateDispatch, translateSnapshot } from '../src/ingest.ts';
import type { RawMessage } from '../src/discord-types.ts';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const flake = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
const SELF = '100000000000000001';
const GUILD = '200000000000000001';
const CH = '300000000000000001';
const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const alice = { id: ALICE, username: 'alice.chen', global_name: 'Alice' };
const bob = { id: BOB, username: 'bob' };
/** Messages from yesterday, so an update to one is not mistaken for an edit or an embed arriving. */
const OLD = flake(NOW - 86_400_000);
const OLD2 = flake(NOW - 86_000_000);

const msg = (id: string, extra: Partial<RawMessage> = {}): RawMessage => ({ id, channel_id: CH, author: alice, content: 'hello', timestamp: '2025-12-31T12:00:00.000Z', ...extra });
const systemPin = (target: string, at = NOW): RawMessage => ({ ...msg(flake(at), { author: bob, content: '', type: 6, timestamp: new Date(at).toISOString() }), message_reference: { channel_id: CH, message_id: target } });
const pins = (events: P.AdapterEvent[]) => events.filter((e) => e.t === 'pin');

function state() {
  const st = newState();
  st.selfId = SELF;
  return st;
}
/** A message as history or a backfill brings it. */
const fetched = (st: ReturnType<typeof state>, m: RawMessage) => messageEvents(m, st, false);

describe('pins', () => {
  test('told once, with who pinned it, when the update comes before the system message', () => {
    const st = state();
    fetched(st, msg(OLD, { pinned: false }));
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: true }) }, st, NOW))).toEqual([]); // held for who
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH, lastPinTimestamp: new Date(NOW).toISOString() }, st, NOW + 10)).toEqual([]);
    const events = translateDispatch('MESSAGE_CREATE', { message: systemPin(OLD) }, st, NOW + 20);
    expect(pins(events)).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: true, by: BOB, ts: NOW }]);
    // Who pinned it is a name the hub learns with the system message itself.
    expect(events.some((e) => e.t === 'identity' && e.identity.nativeId === BOB)).toBe(true);
    expect(duePins(st.changes, NOW + 60_000)).toEqual([]);
  });

  test('told once when the system message comes first', () => {
    const st = state();
    fetched(st, msg(OLD, { pinned: false }));
    expect(pins(translateDispatch('MESSAGE_CREATE', { message: systemPin(OLD) }, st, NOW))).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: true, by: BOB, ts: NOW }]);
    // The client's copy still says unpinned: it does not read the system message.
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: true }), wasPinned: false }, st, NOW + 10))).toEqual([]);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH }, st, NOW + 20)).toEqual([]);
    expect(duePins(st.changes, NOW + 60_000)).toEqual([]);
  });

  test('without the system message, the held pin is told when the wait is over', () => {
    const st = state();
    fetched(st, msg(OLD, { pinned: false }));
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: true }) }, st, NOW);
    expect(duePins(st.changes, NOW + PIN_HOLD_MS - 1)).toEqual([]);
    expect(duePins(st.changes, NOW + PIN_HOLD_MS)).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: true }]);
    expect(duePins(st.changes, NOW + PIN_HOLD_MS + 1)).toEqual([]);
    // A system message after the hold ran out is the same pin.
    expect(pins(translateDispatch('MESSAGE_CREATE', { message: systemPin(OLD) }, st, NOW + PIN_HOLD_MS + 50))).toEqual([]);
  });

  test('an unpin is told at once; an edit of a pinned message is not a pin', () => {
    const st = state();
    fetched(st, msg(OLD, { pinned: true }));
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: true, content: 'edited', edited_timestamp: new Date(NOW).toISOString() }) }, st, NOW))).toEqual([]);
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, st, NOW + 10))).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: false }]);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH, lastPinTimestamp: null }, st, NOW + 20)).toEqual([]);
  });

  test('a message posted live is unpinned, so its first pin is a change', () => {
    const st = state();
    const fresh = flake(NOW - 1000);
    translateDispatch('MESSAGE_CREATE', { message: msg(fresh) }, st, NOW - 1000);
    translateDispatch('MESSAGE_UPDATE', { message: msg(fresh, { pinned: true }) }, st, NOW);
    expect(duePins(st.changes, NOW + PIN_HOLD_MS)).toEqual([{ t: 'pin', conversation: CH, message: fresh, pinned: true }]);
  });

  test('history: already pinned is not a change, and an old system message is not a new pin', () => {
    const st = state();
    expect(pins(fetched(st, msg(OLD, { pinned: true })))).toEqual([]);
    expect(pins(fetched(st, systemPin(OLD2, NOW - 3_600_000)))).toEqual([]);
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: true }) }, st, NOW))).toEqual([]);
    expect(duePins(st.changes, NOW + 60_000)).toEqual([]);
  });

  test("the client's copy stands in for a message this adapter never saw", () => {
    const st = state();
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }), wasPinned: true }, st, NOW))).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: false }]);
  });

  test('a message neither had: CHANNEL_PINS_UPDATE close by in the same channel says it changed, in either order', () => {
    const st = state();
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, st, NOW))).toEqual([]);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH, lastPinTimestamp: null }, st, NOW + 100)).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: false }]);

    const st2 = state();
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH, lastPinTimestamp: null }, st2, NOW)).toEqual([]);
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, st2, NOW + 100))).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: false }]);
  });

  test('a pin of a message neither had is held for who, and dated by CHANNEL_PINS_UPDATE', () => {
    const st = state();
    const pinnedAt = new Date(NOW).toISOString();
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: true }) }, st, NOW);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH, lastPinTimestamp: pinnedAt }, st, NOW + 5)).toEqual([]);
    expect(duePins(st.changes, NOW + 5 + PIN_HOLD_MS)).toEqual([{ t: 'pin', conversation: CH, message: OLD, pinned: true, ts: NOW }]);
  });

  test("a told pin's own CHANNEL_PINS_UPDATE is not taken for another message's, before or after it", () => {
    // OLD2's update is something else (a thread started from it, say): it says pinned: false, as always.
    const after = state();
    fetched(after, msg(OLD, { pinned: true }));
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, after, NOW);
    translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH }, after, NOW + 10);
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD2, { pinned: false }) }, after, NOW + 20))).toEqual([]);

    const before = state();
    fetched(before, msg(OLD, { pinned: true }));
    translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH }, before, NOW);
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, before, NOW + 10);
    expect(pins(translateDispatch('MESSAGE_UPDATE', { message: msg(OLD2, { pinned: false }) }, before, NOW + 20))).toEqual([]);
  });

  test('not paired: an edit, an update too far apart, another channel, or two updates for one signal', () => {
    const edit = state();
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false, edited_timestamp: new Date(NOW - 1000).toISOString() }) }, edit, NOW);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH }, edit, NOW + 100)).toEqual([]);

    const late = state();
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, late, NOW);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH }, late, NOW + 10_000)).toEqual([]);

    const elsewhere = state();
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, elsewhere, NOW);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: '300000000000000002' }, elsewhere, NOW + 100)).toEqual([]);

    const two = state();
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD, { pinned: false }) }, two, NOW);
    translateDispatch('MESSAGE_UPDATE', { message: msg(OLD2, { pinned: false }) }, two, NOW + 50);
    expect(translateDispatch('CHANNEL_PINS_UPDATE', { channelId: CH }, two, NOW + 100)).toEqual([]);
  });
});

describe('roles', () => {
  const named = [
    { id: GUILD, name: '@everyone', color: null },
    { id: '501', name: 'Helper', color: '#5c7cfa' },
    { id: '502', name: 'Mod', color: null },
  ];
  const update = (roles: string[], before?: string[] | null) => ({ guildId: GUILD, user: alice, roles, ...(before !== undefined ? { before } : {}), named });

  test('each role given or taken once, by name and colour, after who the member is; @everyone never', () => {
    const st = state();
    const events = translateDispatch('GUILD_MEMBER_UPDATE', update(['502', GUILD], ['501']), st);
    expect(events[0]).toMatchObject({ t: 'identity', identity: { nativeId: ALICE } });
    expect(events.slice(1)).toEqual([
      { t: 'role', target: { kind: 'space', nativeId: GUILD }, member: ALICE, role: 'Mod', given: true },
      { t: 'role', target: { kind: 'space', nativeId: GUILD }, member: ALICE, role: 'Helper', given: false, color: '#5c7cfa' },
    ]);
  });

  test('a member the client had not loaded is no change, whatever this adapter heard before', () => {
    const st = state();
    expect(translateDispatch('GUILD_MEMBER_UPDATE', update(['501'], null), st)).toEqual([]);
    expect(translateDispatch('GUILD_MEMBER_UPDATE', update(['501', '502'], null), st)).toEqual([]);
  });

  test("without the client's copy, what this adapter heard last: the first update says nothing", () => {
    const st = state();
    expect(translateDispatch('GUILD_MEMBER_UPDATE', update(['501']), st)).toEqual([]);
    expect(translateDispatch('GUILD_MEMBER_UPDATE', update(['501']), st)).toEqual([]);
    expect(translateDispatch('GUILD_MEMBER_UPDATE', update(['501', '502']), st).filter((e) => e.t === 'role')).toEqual([{ t: 'role', target: { kind: 'space', nativeId: GUILD }, member: ALICE, role: 'Mod', given: true }]);
  });

  test('a role whose name never came is not told', () => {
    expect(translateDispatch('GUILD_MEMBER_UPDATE', { guildId: GUILD, user: alice, roles: ['509'], before: [], named: [] }, state())).toEqual([]);
  });
});

describe('custom statuses', () => {
  const friendsSnapshot = {
    self: { id: SELF, username: 'me' },
    relationships: [{ id: ALICE, type: 1 }],
    users: [alice],
    customStatuses: [{ user: alice, text: 'on holiday', emoji: { id: null, name: '🌴' } }],
  };
  const statuses = (events: P.AdapterEvent[]) => events.filter((e) => e.t === 'customStatus');

  test("on connect, friends' statuses once; a reconnect with the same says nothing", () => {
    const st = state();
    expect(statuses(translateSnapshot(friendsSnapshot, st).events)).toEqual([{ t: 'customStatus', who: ALICE, text: 'on holiday', emoji: '🌴' }]);
    expect(statuses(translateSnapshot(friendsSnapshot, st).events)).toEqual([]);
    // The client's later starting point, the same: nothing either.
    expect(translateDispatch('CONNECTION_OPEN_SUPPLEMENTAL', { statuses: friendsSnapshot.customStatuses }, st)).toEqual([]);
  });

  test('changes and clears; a server emoji by its name', () => {
    const st = state();
    translateSnapshot(friendsSnapshot, st);
    const live = (s: unknown) => translateDispatch('PRESENCE_UPDATES', { statuses: [s] }, st);
    expect(statuses(live({ user: alice, text: '  writing ', emoji: { id: '600000000000000001', name: 'ferris' } }))).toEqual([{ t: 'customStatus', who: ALICE, text: 'writing', emoji: ':ferris:' }]);
    expect(live({ user: alice, text: 'writing', emoji: { id: '600000000000000001', name: 'ferris' } })).toEqual([]);
    expect(statuses(live({ user: alice, text: null, emoji: null }))).toEqual([{ t: 'customStatus', who: ALICE }]);
    expect(live({ user: alice, text: '', emoji: null })).toEqual([]);
  });

  test("someone first heard of live comes with who they are; this account's own is not told", () => {
    const st = state();
    const events = translateDispatch('PRESENCE_UPDATE', { statuses: [{ user: bob, text: 'hi' }, { user: { id: SELF, username: 'me' }, text: 'mine' }] }, st);
    expect(events).toEqual([expect.objectContaining({ t: 'identity', identity: expect.objectContaining({ nativeId: BOB }) }), { t: 'customStatus', who: BOB, text: 'hi' }]);
  });
});

describe('presence', () => {
  const presences = (events: P.AdapterEvent[]) => events.filter((e) => e.t === 'presence');

  test("on connect, friends' presence once, offline too; a reconnect with the same says nothing", () => {
    const st = state();
    const snap = { self: { id: SELF, username: 'me' }, relationships: [{ id: ALICE, type: 1 }, { id: BOB, type: 1 }], users: [alice, bob], presences: [{ user: alice, state: 'online' as const, devices: ['mobile' as const, 'desktop' as const] }, { user: bob, state: 'offline' as const }] };
    expect(presences(translateSnapshot(snap, st).events)).toEqual([
      { t: 'presence', who: ALICE, state: 'online', devices: ['desktop', 'mobile'] },
      { t: 'presence', who: BOB, state: 'offline' },
    ]);
    expect(presences(translateSnapshot(snap, st).events)).toEqual([]);
    expect(translateDispatch('CONNECTION_OPEN_SUPPLEMENTAL', { presences: snap.presences }, st)).toEqual([]);
  });

  test('a change comes after who they are; devices only when on; this account and nonsense are not told', () => {
    const st = state();
    const live = (p: unknown) => translateDispatch('PRESENCE_UPDATE', { presences: [p] }, st);
    expect(live({ user: bob, state: 'idle', devices: ['web', 'web', 'fridge'] })).toEqual([expect.objectContaining({ t: 'identity', identity: expect.objectContaining({ nativeId: BOB }) }), { t: 'presence', who: BOB, state: 'idle', devices: ['web'] }]);
    expect(live({ user: bob, state: 'idle', devices: ['web'] })).toEqual([]);
    expect(presences(live({ user: bob, state: 'offline', devices: ['web'] }))).toEqual([{ t: 'presence', who: BOB, state: 'offline' }]);
    expect(live({ user: { id: SELF, username: 'me' }, state: 'online' })).toEqual([]);
    expect(live({ user: bob, state: 'streaming' })).toEqual([]);
  });

  test('statuses and presence in one update', () => {
    const st = state();
    const events = translateDispatch('PRESENCE_UPDATES', { statuses: [{ user: alice, text: 'hi' }], presences: [{ user: alice, state: 'dnd', devices: ['desktop'] }] }, st);
    expect(events.filter((e) => e.t !== 'identity')).toEqual([{ t: 'customStatus', who: ALICE, text: 'hi' }, { t: 'presence', who: ALICE, state: 'dnd', devices: ['desktop'] }]);
  });
});

test('Discord has no read receipts: reading is read state, never a receipt', () => {
  const st = state();
  st.known.add(CH);
  const events = [
    ...translateDispatch('MESSAGE_ACK', { channelId: CH, messageId: OLD, mentionCount: 0 }, st),
    ...translateDispatch('MESSAGE_CREATE', { message: msg(OLD) }, st),
  ];
  expect(events.some((e) => e.t === 'read')).toBe(true);
  expect(events.some((e) => e.t === 'receipt')).toBe(false);
});
