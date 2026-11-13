/**
 * How much you use each place, and the orderings built on it (docs/organize.md). Only ids, seconds and
 * times: never what was said. Shared by the hub, which keeps the decayed totals, and the web app, which
 * measures them and sorts by them.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Time spent and visits lose half their weight each week, so the order follows current habits. */
export const USAGE_HALF_LIFE = 7 * DAY;

/** What usage is kept for: a community, a conversation outside one, or a person (their DMs merged). */
export type UsageKind = 'space' | 'conversation' | 'person';
export const USAGE_KINDS: readonly UsageKind[] = ['space', 'conversation', 'person'];

export interface UsageView {
  kind: UsageKind;
  id: string;
  /** Seconds in the place, decayed to `at`. */
  score: number;
  /** Visits, decayed to `at`. */
  visitScore: number;
  at: number;
  /** All time, not decayed: for showing, not for sorting. */
  seconds: number;
  visits: number;
  lastVisit: number | null;
}

/** One device's measurement since its last batch. */
export interface UsageDelta {
  kind: UsageKind;
  id: string;
  seconds: number;
  visits: number;
  /** When the measurement ended; it decays from then. */
  at: number;
  lastVisit?: number | null;
}

export type SortMode = 'manual' | 'smart' | 'recent' | 'az';
/** The rail (and the phone's Spaces list, which is the same arrangement), and the People list. The inbox has its own order (docs/inbox.md). */
export type SortScope = 'rail' | 'people';

export interface ArrangeSettings {
  sort: Record<SortScope, SortMode>;
  /** Folder suggestions you dismissed: category id -> the places it suggested then. New places bring it back. */
  dismissed: Record<string, string[]>;
}
export const DEFAULT_ARRANGE: ArrangeSettings = { sort: { rail: 'manual', people: 'recent' }, dismissed: {} };

export interface UsageState {
  now: number;
  halfLife: number;
  places: UsageView[];
  arrange: ArrangeSettings;
}

/** `value` as measured at `from`, seen from `to`. */
export function decayed(value: number, from: number, to: number, halfLife = USAGE_HALF_LIFE): number {
  return value * 2 ** (-(to - from) / halfLife);
}

export type Decayed = Pick<UsageView, 'score' | 'visitScore' | 'at'>;

/**
 * Add a measurement to a decayed total. The total stays at the later of the two times, so batches that
 * arrive late or out of order give the same result as in order.
 */
export function addDecayed(acc: Decayed | null, d: { seconds: number; visits: number; at: number }, halfLife = USAGE_HALF_LIFE): Decayed {
  if (!acc) return { score: d.seconds, visitScore: d.visits, at: d.at };
  if (d.at <= acc.at) return { score: acc.score + decayed(d.seconds, d.at, acc.at, halfLife), visitScore: acc.visitScore + decayed(d.visits, d.at, acc.at, halfLife), at: acc.at };
  return { score: decayed(acc.score, acc.at, d.at, halfLife) + d.seconds, visitScore: decayed(acc.visitScore, acc.at, d.at, halfLife) + d.visits, at: d.at };
}

/** Weights of the smart order, in minutes of reading. */
export const SMART = {
  /** A visit is worth a minute: a place you check often but briefly still counts. */
  visit: 1,
  /** A visit just now is worth this much, halving every `recentHalfLife`. */
  recent: 20,
  recentHalfLife: DAY,
  /** Each unread mention, up to `mentionCap` of them. */
  mention: 10,
  mentionCap: 3,
};

/**
 * Smart score: time + visits (both decayed, half-life a week) + how recently you were there + a nudge for
 * unread mentions. In minutes, so a place you read for half an hour a day settles near 320, one you check
 * ten times a day for a few seconds near 140, and a mention adds 10 at most 30: enough to lift a place
 * among its peers, not enough to beat a habit.
 */
export function smartScore(u: Pick<UsageView, 'score' | 'visitScore' | 'at' | 'lastVisit'> | null | undefined, now: number, mentions = 0): number {
  const nudge = SMART.mention * Math.min(Math.max(0, mentions), SMART.mentionCap);
  if (!u) return nudge;
  const time = decayed(u.score, u.at, now) / 60;
  const visits = decayed(u.visitScore, u.at, now) * SMART.visit;
  const recent = u.lastVisit ? SMART.recent * 2 ** (-Math.max(0, now - u.lastVisit) / SMART.recentHalfLife) : 0;
  return time + visits + recent + nudge;
}

/** Hub-side sanity for one delta from a device: a batch covers a minute or so, never more than an hour. */
export function cleanDelta(d: Partial<UsageDelta>, now: number): UsageDelta | null {
  if (!d || !USAGE_KINDS.includes(d.kind as UsageKind) || typeof d.id !== 'string' || !d.id || d.id.length > 200) return null;
  const seconds = Math.min(Math.max(Number(d.seconds) || 0, 0), 3600);
  const visits = Math.min(Math.max(Math.floor(Number(d.visits) || 0), 0), 100);
  if (!seconds && !visits) return null;
  // A device whose clock is off, or a batch kept offline for weeks, still lands somewhere sensible.
  const at = Math.min(Math.max(Number(d.at) || now, now - 30 * DAY), now);
  const lastVisit = d.lastVisit ? Math.min(Math.max(Number(d.lastVisit), now - 30 * DAY), now) : null;
  return { kind: d.kind as UsageKind, id: d.id, seconds, visits, at, lastVisit };
}

// ------------------------------------------------------------------ button counts (docs/button-counts.md)

/**
 * Which buttons you press, counted per day while a device has it switched on. Keys are fixed strings from the
 * app's code ("inbox: row (DM, unread)"), pages are the app's views: never names, text, ids or addresses.
 */
export type ClickDevice = 'phone' | 'desktop';
export const CLICK_DEVICES: readonly ClickDevice[] = ['phone', 'desktop'];
export const CLICK_KEY_MAX = 80;
export const CLICK_PAGE_MAX = 32;
/** Entries in one batch, and the most one entry may add. */
export const CLICK_BATCH_MAX = 500;
export const CLICK_N_MAX = 10_000;
/** The body of one POST, in bytes. */
export const CLICK_BODY_MAX = 64 * 1024;

/** One device kind's presses of one control on one page, on one day (the device's own date, YYYY-MM-DD). */
export interface ClickCount {
  day: string;
  key: string;
  page: string;
  device: ClickDevice;
  n: number;
}

/** A key's total over the days asked for; `phone` and `desktop` with `by=device`, `page` with `by=page`. */
export interface ClickTotal {
  key: string;
  n: number;
  phone?: number;
  desktop?: number;
  page?: string;
}

export interface ClicksView {
  days: number;
  /** The first day counted. */
  since: string;
  total: number;
  keys: ClickTotal[];
}

/** A date as YYYY-MM-DD in the local zone. */
export function localDay(t: number | Date = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Printable ASCII only, trimmed, and not too long: what a key written in code looks like. */
const cleanLabel = (s: unknown, max: number): string | null => (typeof s === 'string' && s.length <= max && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(s) ? s : null);

/** Hub-side sanity for one entry: a day near today, a key and page in bounds, a count of at least one. */
export function cleanClick(c: Partial<ClickCount>, now = Date.now()): ClickCount | null {
  if (!c || typeof c !== 'object') return null;
  const key = cleanLabel(c.key, CLICK_KEY_MAX);
  const page = cleanLabel(c.page, CLICK_PAGE_MAX);
  if (!key || !page || !CLICK_DEVICES.includes(c.device as ClickDevice)) return null;
  // A device's date may be a day either side of the hub's.
  if (typeof c.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.day) || c.day > localDay(now + 2 * DAY) || c.day < localDay(now - 400 * DAY)) return null;
  const n = Math.min(Math.floor(Number(c.n) || 0), CLICK_N_MAX);
  if (n < 1) return null;
  return { day: c.day, key, page, device: c.device as ClickDevice, n };
}
