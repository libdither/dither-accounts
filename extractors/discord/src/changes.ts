/**
 * Changes the hub keeps in its history (docs/history.md) that Discord only says in passing: a message pinned or
 * unpinned, a role given or taken, a custom status set or cleared. Each is told once, when it changes; what was
 * there before is remembered here (or read by the hook from the client's stores just before an update).
 *
 * Discord has no read receipts, so there are none to tell.
 */

import type * as P from '@dither-chat/protocol';
import type { RawCustomStatus, RawMemberUpdate, RawMessage, RawPresence } from './discord-types.ts';
import { isoToMs, snowflakeToMs } from './map.ts';
import { statusEmoji } from './profile.ts';

/** A Map that forgets its oldest entries past `cap`. */
export class Recent<K, V> extends Map<K, V> {
  constructor(private readonly cap: number) {
    super();
  }
  override set(k: K, v: V): this {
    super.delete(k);
    super.set(k, v);
    if (this.size > this.cap) this.delete(this.keys().next().value as K);
    return this;
  }
}

type PinEvent = Extract<P.AdapterEvent, { t: 'pin' }>;

/** A pin heard without who did it waits this long for the system message that says. */
export const PIN_HOLD_MS = 3000;
/** A CHANNEL_PINS_UPDATE and a MESSAGE_UPDATE this close together in one channel are the same pin. */
const PAIR_MS = 5000;
/** The same pin told again within this is one of its other signals. */
const TOLD_MS = 60_000;
/** An update to a message this new, or edited this recently, is an edit or an embed, not a pin. */
const FRESH_MS = 30_000;

export interface Changes {
  /** message id -> pinned, as last seen in any message the adapter handled */
  pinned: Recent<string, boolean>;
  /** pins told to the hub lately, by message */
  told: Recent<string, { pinned: boolean; at: number }>;
  /** pins heard without who did it, by message, held for the system message that says */
  held: Map<string, { event: PinEvent; due: number }>;
  /** channel -> updates whose earlier pinned state was not known, waiting for a CHANNEL_PINS_UPDATE */
  unsure: Map<string, { message: string; pinned: boolean; at: number }[]>;
  /** channel -> a CHANNEL_PINS_UPDATE no update has explained yet, and the pin time it gave */
  signal: Map<string, { at: number; last: number }>;
  /** channel -> when a pin there was last told, so its own CHANNEL_PINS_UPDATE is not taken for another */
  explained: Map<string, number>;
  /** "guild:user" -> their role ids, as last heard */
  roles: Recent<string, string[]>;
  /** role id -> its name and colour */
  roleNames: Recent<string, { name: string; color?: string }>;
  /** user id -> their custom status, as last told */
  statuses: Map<string, string>;
  /** user id -> their presence, as last told */
  presences: Map<string, string>;
}

export function newChanges(): Changes {
  return {
    pinned: new Recent(20_000),
    told: new Recent(1000),
    held: new Map(),
    unsure: new Map(),
    signal: new Map(),
    explained: new Map(),
    roles: new Recent(5000),
    roleNames: new Recent(5000),
    statuses: new Map(),
    presences: new Map(),
  };
}

// ---------------------------------------------------------------------- pins

/** A message as fetched or created: its pinned state is the starting point, not a change. */
export function sawMessage(m: RawMessage, ch: Changes, live: boolean): void {
  // A message just posted is not pinned, whatever the payload leaves out.
  if (typeof m.pinned === 'boolean' || live) ch.pinned.set(m.id, m.pinned ?? false);
}

/**
 * MESSAGE_UPDATE says `pinned`, but so does an edit. A change only counts against what was known before: this
 * adapter's own copy, else the client's (`wasPinned`, read by the hook just before the update). Unknown, a
 * CHANNEL_PINS_UPDATE close by in the same channel says this was the one.
 */
export function pinUpdate(m: RawMessage, wasPinned: boolean | undefined, ch: Changes, now: number): P.AdapterEvent[] {
  if (typeof m.pinned !== 'boolean') return [];
  const before = ch.pinned.get(m.id) ?? wasPinned;
  ch.pinned.set(m.id, m.pinned);
  if (before === m.pinned) return [];
  if (before !== undefined) return pinChanged(m.channel_id, m.id, m.pinned, ch, now);
  if (snowflakeToMs(m.id) > now - FRESH_MS || isoToMs(m.edited_timestamp) > now - FRESH_MS) return [];
  const sig = ch.signal.get(m.channel_id);
  if (sig && now - sig.at < PAIR_MS) {
    ch.signal.delete(m.channel_id);
    return pinChanged(m.channel_id, m.id, m.pinned, ch, now, m.pinned ? sig.last : 0);
  }
  const waiting = (ch.unsure.get(m.channel_id) ?? []).filter((u) => now - u.at < PAIR_MS && u.message !== m.id);
  ch.unsure.set(m.channel_id, [...waiting, { message: m.id, pinned: m.pinned, at: now }]);
  return [];
}

/** CHANNEL_PINS_UPDATE: pins changed in this channel, without saying which. */
export function pinsChanged(channelId: string, lastPinTimestamp: string | null | undefined, ch: Changes, now: number): P.AdapterEvent[] {
  const last = isoToMs(lastPinTimestamp);
  const waiting = (ch.unsure.get(channelId) ?? []).filter((u) => now - u.at < PAIR_MS);
  ch.unsure.delete(channelId);
  // The echo of a pin already told here.
  if (now - (ch.explained.get(channelId) ?? -Infinity) < PAIR_MS) return [];
  // One update waiting is the one; several, and which is not knowable.
  if (waiting.length === 1) return pinChanged(channelId, waiting[0].message, waiting[0].pinned, ch, now, waiting[0].pinned ? last : 0);
  if (!waiting.length) ch.signal.set(channelId, { at: now, last });
  return [];
}

/** The "pinned a message" system message (type 6), live: who pinned which, and when. */
export function pinSystemMessage(m: RawMessage, ch: Changes, now: number): P.AdapterEvent[] {
  const target = m.message_reference?.message_id;
  if (m.type !== 6 || !target) return [];
  const conversation = m.message_reference?.channel_id ?? m.channel_id;
  ch.pinned.set(target, true);
  const held = ch.held.get(target);
  ch.held.delete(target);
  const told = ch.told.get(target);
  // Already told without who did it (the hold ran out): telling it again would be a second pin.
  if (!held && told?.pinned && now - told.at < TOLD_MS) return [];
  ch.told.set(target, { pinned: true, at: now });
  ch.explained.set(conversation, now);
  ch.signal.delete(conversation);
  const ts = isoToMs(m.timestamp) || snowflakeToMs(m.id);
  return [{ t: 'pin', conversation, message: target, pinned: true, ...(m.author?.id ? { by: m.author.id } : {}), ...(ts ? { ts } : {}) }];
}

function pinChanged(conversation: string, message: string, pinned: boolean, ch: Changes, now: number, ts = 0): P.AdapterEvent[] {
  const told = ch.told.get(message);
  if (told && told.pinned === pinned && now - told.at < TOLD_MS) return [];
  ch.told.set(message, { pinned, at: now });
  ch.explained.set(conversation, now);
  ch.signal.delete(conversation);
  const event: PinEvent = { t: 'pin', conversation, message, pinned, ...(ts ? { ts } : {}) };
  // Discord posts who pinned it as a message of its own, which may come just after: wait for it.
  if (pinned) {
    ch.held.set(message, { event, due: now + PIN_HOLD_MS });
    return [];
  }
  // No message says who unpinned. A pin of the same message still held goes first.
  const held = ch.held.get(message);
  ch.held.delete(message);
  return held ? [held.event, event] : [event];
}

/** Held pins whose wait is over, told without who did it. */
export function duePins(ch: Changes, now: number): P.AdapterEvent[] {
  const out: P.AdapterEvent[] = [];
  for (const [message, h] of ch.held) {
    if (h.due > now) continue;
    ch.held.delete(message);
    out.push(h.event);
  }
  return out;
}

// --------------------------------------------------------------------- roles

/**
 * Roles given and taken, one event each. Compared with the member as the client had them just before; when the
 * hook could not look, with what this adapter last heard. A member neither had loaded is no change: @everyone never is.
 */
export function roleChanges(a: RawMemberUpdate, ch: Changes): P.AdapterEvent[] {
  const member = a.user?.id;
  if (!a.guildId || !member || !Array.isArray(a.roles)) return [];
  for (const r of a.named ?? []) if (r?.id && typeof r.name === 'string') ch.roleNames.set(r.id, { name: r.name, ...(r.color ? { color: r.color } : {}) });
  const key = `${a.guildId}:${member}`;
  const remembered = ch.roles.get(key);
  ch.roles.set(key, a.roles);
  const before = a.before === undefined ? remembered : a.before;
  if (!before) return [];
  const events: P.AdapterEvent[] = [];
  const tell = (id: string, given: boolean) => {
    const role = ch.roleNames.get(id);
    if (id === a.guildId || !role) return;
    events.push({ t: 'role', target: { kind: 'space', nativeId: a.guildId }, member, role: role.name, given, ...(role.color ? { color: role.color } : {}) });
  };
  const now = new Set(a.roles);
  const was = new Set(before);
  for (const id of now) if (!was.has(id)) tell(id, true);
  for (const id of was) if (!now.has(id)) tell(id, false);
  return events;
}

// ------------------------------------------------------------ custom statuses

const STATES = new Set(['online', 'idle', 'dnd', 'offline']);
const DEVICES = new Set(['desktop', 'mobile', 'web']);

/** Presences that differ from the last told. Offline is on no device. */
export function presenceChanges(list: RawPresence[], ch: Changes, selfId: string): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  for (const p of list) {
    const who = p?.user?.id;
    if (!who || who === selfId || !STATES.has(p.state)) continue;
    const devices = p.state === 'offline' ? [] : [...new Set((p.devices ?? []).filter((d) => DEVICES.has(d)))].sort();
    const key = `${p.state}:${devices.join(',')}`;
    if (ch.presences.get(who) === key) continue;
    ch.presences.set(who, key);
    events.push({ t: 'presence', who, state: p.state, ...(devices.length ? { devices } : {}) });
  }
  return events;
}

/** Custom statuses that differ from the last told; one with no text and no emoji is cleared. */
export function statusChanges(list: RawCustomStatus[], ch: Changes, selfId: string): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  for (const s of list) {
    const who = s?.user?.id;
    if (!who || who === selfId) continue;
    const text = s.text?.trim() || undefined;
    const emoji = statusEmoji(s.emoji);
    const key = JSON.stringify([text ?? null, emoji ?? null]);
    if (ch.statuses.get(who) === key) continue;
    ch.statuses.set(who, key);
    events.push({ t: 'customStatus', who, ...(text ? { text } : {}), ...(emoji ? { emoji } : {}) });
  }
  return events;
}
