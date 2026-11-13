/**
 * What a network itself knows about your attention, beyond messages as they come (docs/research/discord-gaps.md,
 * "Mentions, inbox, notifications"): mentions in places its client had not loaded, its own mute and notification
 * settings, read points moved back by hand, and marking many conversations read in one request.
 *
 * All additive: an adapter says it has each with a capability, and the hub offers it only then.
 */
import type { AboutTarget } from './about.ts';
import type { NativeMute } from './adapter.ts';

export type AttentionCapability =
  /**
   * Learns about mentions of you in places its client had not loaded, from the network's own list of them (Discord's
   * recent mentions), at a person's pace. They come as message facts with `late` (adapter.ts).
   */
  | 'mentions'
  /** Mutes or unmutes a conversation or space on the network itself, with a timer (the `mute` command). */
  | 'mute'
  /** Moves the network's read point back, so a conversation is unread from a message on (the `markUnread` command). */
  | 'markUnread'
  /** Marks many conversations read in one request (the `markReadMany` command), as the network's own client does. */
  | 'markReadMany';

/**
 * How long after its own time a message heard `late` is still news: younger, it is triaged like a live one (it may
 * notify); older, it is only unread, as backfill is. A mention found late must not buzz for something old.
 */
export const LATE_NEWS_MS = 10 * 60_000;

/** The timers a native mute offers, in minutes; null: until it is turned off. Discord's own menu. */
export const MUTE_TIMERS: readonly (number | null)[] = [15, 60, 3 * 60, 8 * 60, 24 * 60, null];

/** "15 minutes", "8 hours", "Until I turn it back on". */
export function muteTimerLabel(minutes: number | null): string {
  if (minutes === null) return 'Until I turn it back on';
  if (minutes < 60) return `${minutes} minutes`;
  const h = minutes / 60;
  return h === 1 ? '1 hour' : `${h} hours`;
}

/** Adapter commands for the capabilities above. Each answers once the network took it. */
export type AttentionCommand =
  /**
   * Mute or unmute `target` on the network (capability 'mute'). `until`: ms epoch the mute ends; absent, until it is
   * turned off. The space or conversation fact with its new mute comes first, then reply.result: NativeMute as it
   * now stands (`{}`: nothing set).
   */
  | { t: 'mute'; id: string; target: AboutTarget; muted: boolean; until?: number }
  /** Unread from `from` (a native message id) on (capability 'markUnread'). reply.result: {} */
  | { t: 'markUnread'; id: string; conversation: string; from: string }
  /**
   * Read up to `upTo` in each (capability 'markReadMany'), at most MARK_READ_MANY_MAX in one command. reply.result:
   * { marked: number }.
   */
  | { t: 'markReadMany'; id: string; items: { conversation: string; upTo: string }[] };

/** At most this many conversations in one `markReadMany`. Discord's client sends 100 per request. */
export const MARK_READ_MANY_MAX = 50;

/** A mute in force now: muted outright, or until a time still ahead. */
export function mutedNow(m: NativeMute | null | undefined, now = Date.now()): boolean {
  if (!m) return false;
  if (m.until !== undefined) return m.until > now;
  return m.muted === true || m.level === 'none';
}
