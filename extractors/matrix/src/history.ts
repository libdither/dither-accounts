/**
 * History the hub keeps (docs/history.md), read off what /sync already brings:
 *
 *   m.room.pinned_events, against the one before it   -> pin, per message pinned or unpinned
 *   m.room.power_levels, against the one before it    -> role, per member moved into or out of a named level
 *   m.receipt, other people's m.read                  -> receipt (read up to the event named)
 *   m.presence from people you have a direct chat with -> customStatus, when the status message changes
 *                                                        -> presence, when online, unavailable or offline changes
 */

import type * as P from '@dither-chat/protocol';
import { roleName } from './about.ts';
import type { MxEvent } from './rooms.ts';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const when = (ev: MxEvent) => ({ by: ev.sender, ...(typeof ev.origin_server_ts === 'number' ? { ts: ev.origin_server_ts } : {}) });

/** A new pinned list against the one before it: one event per message added to it or taken off. */
export function pinChanges(before: MxEvent, after: MxEvent, conversationOf: (message: string) => string): P.AdapterEvent[] {
  const was = new Set(strings(before.content?.pinned));
  const now = new Set(strings(after.content?.pinned));
  const out: P.AdapterEvent[] = [];
  for (const m of now) if (!was.has(m)) out.push({ t: 'pin', conversation: conversationOf(m), message: m, pinned: true, ...when(after) });
  for (const m of was) if (!now.has(m)) out.push({ t: 'pin', conversation: conversationOf(m), message: m, pinned: false, ...when(after) });
  return out;
}

const level = (v: unknown, d: number): number => {
  const n = Number(v);
  return v === undefined || v === null || !Number.isFinite(n) ? d : Math.trunc(n);
};

/**
 * New power levels against the ones before: for each member either lists, the role they lost and the one they got
 * when their level crosses from one named level to another (Admin 100, Moderator 50, "Level N"; the room's default is
 * Member, no role). A change to the default alone moves no one. `skip`: members whose level means nothing (v12 creators).
 */
export function roleChanges(target: P.AboutTarget, before: MxEvent, after: MxEvent, skip: (user: string) => boolean = () => false): P.AdapterEvent[] {
  const users = (c: any): Record<string, unknown> => (c?.users && typeof c.users === 'object' ? c.users : {});
  const [b, a] = [users(before.content), users(after.content)];
  const [bDefault, aDefault] = [level(before.content?.users_default, 0), level(after.content?.users_default, 0)];
  const out: P.AdapterEvent[] = [];
  for (const member of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (skip(member)) continue;
    const was = roleName(level(b[member], bDefault), bDefault);
    const now = roleName(level(a[member], aDefault), aDefault);
    if (was === now) continue;
    if (was !== 'Member') out.push({ t: 'role', target, member, role: was, given: false, ...when(after) });
    if (now !== 'Member') out.push({ t: 'role', target, member, role: now, given: true, ...when(after) });
  }
  return out;
}

/**
 * Other people's m.read receipts in one m.receipt event, each read up to the event it names (the hub fills in
 * "up to"). m.read.private is only ever yours. `conversationOf` gets the receipt's thread, if it names one.
 */
export function receiptEvents(content: unknown, self: string, conversationOf: (message: string, thread?: string) => string): P.AdapterEvent[] {
  const out: P.AdapterEvent[] = [];
  if (!content || typeof content !== 'object') return out;
  for (const [message, byType] of Object.entries<any>(content)) {
    const reads = byType?.['m.read'];
    if (!reads || typeof reads !== 'object') continue;
    for (const [who, r] of Object.entries<any>(reads)) {
      if (who === self || !who.startsWith('@')) continue;
      const thread = typeof r?.thread_id === 'string' && r.thread_id !== 'main' ? r.thread_id : undefined;
      out.push({ t: 'receipt', conversation: conversationOf(message, thread), messages: [message], who, state: 'read', ts: typeof r?.ts === 'number' ? r.ts : Date.now() });
    }
  }
  return out;
}

/**
 * The presence an m.presence content says: unavailable is idle, and MSC3026's busy is do not disturb. null for
 * anything else.
 */
export function presenceOf(content: any): Extract<P.AdapterEvent, { t: 'presence' }>['state'] | null {
  switch (content?.presence) {
    case 'online':
      return 'online';
    case 'unavailable':
      return 'idle';
    case 'offline':
      return 'offline';
    case 'busy':
    case 'org.matrix.msc3026.busy':
      return 'dnd';
    default:
      return null;
  }
}

/** The status message an m.presence content carries: '' for none (servers leave the field out then). */
export function statusOf(content: any): string {
  const s = content?.status_msg;
  return typeof s === 'string' && s.trim() ? s : '';
}
