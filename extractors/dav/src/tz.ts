/**
 * Time zones for the calendar code: wall-clock times in an IANA zone to instants and back (from the runtime's own
 * tz database, through Intl), with RFC 5545's rules for the hour a change of offset skips (read with the offset
 * before it) or repeats (the first of the two). A TZID that is not an IANA name is looked for in its VTIMEZONE
 * (X-LIC-LOCATION, a trailing "Region/City", a Windows name); one that names nothing known is converted with the
 * VTIMEZONE itself (ical.js). VTIMEZONE blocks to write come from timezones-ical-library (IANA data, Apache-2.0).
 */
import ICAL from 'ical.js';
import { tzlib_get_ical_block } from 'timezones-ical-library';

export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** How a time is anchored: an IANA zone, UTC, floating (no zone), or a VTIMEZONE no IANA name was found for. */
export type Zone = { kind: 'iana'; name: string } | { kind: 'utc' } | { kind: 'floating' } | { kind: 'vtz'; tzid: string; tz: InstanceType<typeof ICAL.Timezone> };

export const UTC: Zone = { kind: 'utc' };
export const FLOATING: Zone = { kind: 'floating' };

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string): Intl.DateTimeFormat {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
    fmts.set(zone, f);
  }
  return f;
}

const ianaOk = new Map<string, string | null>();
/** The zone's canonical spelling when Intl knows it, else null. */
export function ianaName(z: string): string | null {
  if (ianaOk.has(z)) return ianaOk.get(z)!;
  let out: string | null = null;
  try {
    // Only names, never offsets ("+05:00"), which Intl takes as well.
    if (/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(z)) out = new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone;
  } catch {}
  ianaOk.set(z, out);
  return out;
}

/** The wall-clock time in an IANA zone at an instant. */
export function wallIn(zone: string, ms: number): Wall {
  const parts = fmt(zone).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let y = get('year');
  if (parts.find((p) => p.type === 'era')?.value === 'BC') y = 1 - y;
  return { y, mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

export const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
export const wallOfMs = (ms: number): Wall => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
};
const sameWall = (a: Wall, b: Wall) => wallMs(a) === wallMs(b);

/** An IANA zone's offset from UTC at an instant, in ms (east positive). */
export function ianaOffset(zone: string, ms: number): number {
  const t = Math.floor(ms / 1000) * 1000;
  return wallMs(wallIn(zone, t)) - t;
}

/** A wall-clock time in an IANA zone as an instant: in a gap with the offset before it, when repeated the first. */
function ianaInstant(zone: string, w: Wall): number {
  const local = wallMs(w);
  const offsets = new Set([ianaOffset(zone, local - 86_400_000), ianaOffset(zone, local), ianaOffset(zone, local + 86_400_000)]);
  const fits = [...offsets].map((o) => local - o).filter((t) => sameWall(wallIn(zone, t), w));
  if (fits.length) return Math.min(...fits);
  return local - ianaOffset(zone, local - 86_400_000);
}

/** The instant of a wall-clock time in a zone; a floating time is read in `floatingAs` (UTC unless given). */
export function toInstant(zone: Zone, w: Wall, floatingAs: Zone = UTC): number {
  switch (zone.kind) {
    case 'utc':
      return wallMs(w);
    case 'iana':
      return ianaInstant(zone.name, w);
    case 'floating':
      return floatingAs.kind === 'floating' ? wallMs(w) : toInstant(floatingAs, w);
    case 'vtz': {
      const t = ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false }, zone.tz as any);
      return t.toUnixTime() * 1000;
    }
  }
}

/** The wall-clock time in a zone at an instant (floating and UTC alike read it as UTC). */
export function wallAt(zone: Zone, ms: number): Wall {
  switch (zone.kind) {
    case 'iana':
      return wallIn(zone.name, ms);
    case 'vtz': {
      const t = ICAL.Time.fromData({ year: 1970, month: 1, day: 1, isDate: false });
      t.fromUnixTime(Math.floor(ms / 1000));
      const z = t.convertToZone(zone.tz as any);
      return { y: z.year, mo: z.month, d: z.day, h: z.hour, mi: z.minute, s: z.second };
    }
    default:
      return wallOfMs(ms);
  }
}

export function offsetIn(zone: Zone, ms: number): number {
  if (zone.kind === 'iana') return ianaOffset(zone.name, ms);
  if (zone.kind === 'vtz') return wallMs(wallAt(zone, ms)) - Math.floor(ms / 1000) * 1000;
  return 0;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const p4 = (n: number) => String(n).padStart(4, '0');
export const dateStr = (w: Pick<Wall, 'y' | 'mo' | 'd'>) => `${p4(w.y)}-${p2(w.mo)}-${p2(w.d)}`;
export const wallStr = (w: Wall) => `${dateStr(w)}T${p2(w.h)}:${p2(w.mi)}:${p2(w.s)}`;
/** 2026-03-08T09:00:00-07:00, or …Z for UTC, or no offset for floating. */
export function rfc3339(zone: Zone, w: Wall): string {
  if (zone.kind === 'utc') return `${wallStr(w)}Z`;
  if (zone.kind === 'floating') return wallStr(w);
  // A wall time a change of offset skips is written as the time it really is (02:30 → 03:30 daylight time).
  const ms = toInstant(zone, w);
  w = wallAt(zone, ms);
  const off = Math.round(offsetIn(zone, ms) / 60_000);
  const a = Math.abs(off);
  return `${wallStr(w)}${off < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}
/** 20260308T170000Z: an instant in iCalendar's basic UTC form. */
export function basicUtc(ms: number): string {
  const w = wallOfMs(ms);
  return `${p4(w.y)}${p2(w.mo)}${p2(w.d)}T${p2(w.h)}${p2(w.mi)}${p2(w.s)}Z`;
}

/** Windows zone names (Outlook, Exchange) to IANA, the common ones (CLDR windowsZones, territory 001). */
const WINDOWS: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Pacific SA Standard Time': 'America/Santiago',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** The IANA zone a TZID (and its VTIMEZONE, if there is one) means, or null. */
export function ianaFor(tzid: string, vtimezone?: InstanceType<typeof ICAL.Component> | null): string | null {
  const id = tzid.replace(/^"|"$/g, '').trim();
  const direct = ianaName(id);
  if (direct) return direct;
  const loc = vtimezone?.getFirstPropertyValue('x-lic-location');
  if (typeof loc === 'string' && ianaName(loc)) return ianaName(loc);
  // /mozilla.org/20050126_1/America/New_York, /softwarestudio.org/Olson_20011030_5/America/Argentina/Buenos_Aires
  const segs = id.split('/').filter(Boolean);
  for (const n of [3, 2]) if (segs.length > n) {
    const tail = ianaName(segs.slice(-n).join('/'));
    if (tail && tail.includes('/')) return tail;
  }
  const win = WINDOWS[id] ?? WINDOWS[id.replace(/^\(UTC[^)]*\)\s*/, '')];
  return win ? ianaName(win) : null;
}

/** The zone a TZID names, given the VTIMEZONEs of its calendar; null when it names nothing (read it as floating). */
export function zoneFor(tzid: string, vtimezones: Map<string, InstanceType<typeof ICAL.Component>>): Zone | null {
  const vtz = vtimezones.get(tzid) ?? null;
  const iana = ianaFor(tzid, vtz);
  if (iana) return iana === 'UTC' || iana === 'Etc/UTC' ? UTC : { kind: 'iana', name: iana };
  if (vtz) {
    try {
      return { kind: 'vtz', tzid, tz: new ICAL.Timezone({ component: vtz, tzid }) };
    } catch {}
  }
  return null;
}

const blocks = new Map<string, string | null>();
/** A VTIMEZONE for an IANA zone, as iCalendar text (null when the library does not have it). */
export function vtimezoneText(zone: string): string | null {
  if (blocks.has(zone)) return blocks.get(zone)!;
  let out: string | null = null;
  try {
    const b = tzlib_get_ical_block(zone);
    const text = Array.isArray(b) ? b[0] : null;
    if (text && text.startsWith('BEGIN:VTIMEZONE')) out = text;
  } catch {}
  blocks.set(zone, out);
  return out;
}

/** "2026-03-08" plus days, as a date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return dateStr(wallOfMs(Date.UTC(y, m - 1, d + days)));
}
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}
