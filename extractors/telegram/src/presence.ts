/**
 * Who is online, for the hub's status dots (dither-chat docs/profile.md "Status dots"), from what Telegram sends every
 * client anyway: the `status` on the users it hands over, and `updateUserStatus` when a contact's changes. Nothing is
 * asked for. Only for people the account follows (contacts, people with a DM), as the protocol says, never everyone
 * in a big group.
 *
 * Telegram says online "until" a time (`expires`) and sends offline when they leave, but an app that loses them sends
 * nothing: past the time with nothing newer, they are offline, as Telegram's own apps show it. Recently, last week
 * and last month are offline too; a hidden status (`userStatusEmpty`) is unknown and says nothing.
 */
import type { tl } from './backend.ts';

export type TgPresence = { state: 'online' | 'offline'; until?: number };

/** What a user status says, at `now` (ms). Null: nothing known. */
export function presenceOfStatus(s: tl.TypeUserStatus | undefined, now: number): TgPresence | null {
  switch (s?._) {
    case 'userStatusOnline': {
      const until = s.expires * 1000;
      return until > now ? { state: 'online', until } : { state: 'offline' };
    }
    case 'userStatusOffline':
    case 'userStatusRecently':
    case 'userStatusLastWeek':
    case 'userStatusLastMonth':
      return { state: 'offline' };
    default:
      return null;
  }
}

/** A little past `expires` before online turns offline by itself: a refresh is on its way. */
export const EXPIRY_GRACE_MS = 5_000;

/**
 * Tells each change once. `follows` says whom it is for; `emit` sends a presence event. Timers only for the online
 * ones' expiry, one each.
 */
export class PresenceTeller {
  private told = new Map<number, 'online' | 'offline'>();
  private timers = new Map<number, () => void>();
  private stopped = false;

  constructor(
    private follows: (userId: number) => boolean,
    private emit: (userId: number, state: 'online' | 'offline', ts: number) => void,
    private now: () => number = Date.now,
    /** Runs `f` in `ms`; returns how to cancel it. */
    private later: (f: () => void, ms: number) => () => void = (f, ms) => {
      const t = setTimeout(f, ms);
      (t as { unref?: () => void }).unref?.();
      return () => clearTimeout(t);
    },
  ) {}

  note(userId: number, status: tl.TypeUserStatus | undefined) {
    if (this.stopped) return;
    const now = this.now();
    const p = presenceOfStatus(status, now);
    if (!p || !this.follows(userId)) return;
    this.timers.get(userId)?.();
    this.timers.delete(userId);
    if (p.until !== undefined)
      this.timers.set(
        userId,
        this.later(() => {
          this.timers.delete(userId);
          this.tell(userId, 'offline');
        }, p.until - now + EXPIRY_GRACE_MS),
      );
    this.tell(userId, p.state);
  }

  private tell(userId: number, state: 'online' | 'offline') {
    if (this.told.get(userId) === state) return;
    this.told.set(userId, state);
    this.emit(userId, state, this.now());
  }

  /** Everything told, again: for a hub that started over and has not heard it. */
  retell() {
    if (this.stopped) return;
    const ts = this.now();
    for (const [id, state] of this.told) this.emit(id, state, ts);
  }

  /** Signed out: nothing told stands, and no timer runs. */
  reset() {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.told.clear();
  }

  stop() {
    this.reset();
    this.stopped = true;
  }
}
