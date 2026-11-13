/**
 * iCalendar ↔ the `calendar` interface's shapes, shared by the dav and ics extractors (ical.js parses and writes;
 * times and zones are tz.ts's).
 *
 * - A resource (one CalDAV object, or one UID of a feed) is a series: the master VEVENT and the instances someone
 *   changed (VEVENTs with its UID and a RECURRENCE-ID). The master is the event `<resourceId>`; a changed instance is
 *   `<resourceId>#<key>`, and so is an instance `expand` makes, so changing it (cal.put with that id) writes an override
 *   and deleting it adds an EXDATE.
 * - A key is the instance's original start: 20260308 for a date, 20260308T170000Z for a time with a zone or in UTC,
 *   20260308T090000 for a floating one.
 * - Recurrences are expanded in the master's own wall-clock time (RRULE is wall-clock), each instance then placed in
 *   its zone, so 09:00 stays 09:00 across a change of offset. UNTIL (UTC) is read in that zone first. EXDATE, RDATE
 *   (dates, times and periods) and overrides (also moved into or out of the window) count; a cancelled instance is
 *   left out of an expansion (it is listed, with status cancelled, without one).
 */
import ICAL from 'ical.js';
import type { CalAttendee, CalEvent, CalEventInput, CalPerson, CalTime } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import { addDays, basicUtc, dateStr, daysBetween, FLOATING, ianaName, rfc3339, toInstant, UTC, vtimezoneText, type Wall, wallAt, wallIn, wallMs, wallOfMs, wallStr, type Zone, zoneFor } from './tz.ts';

export type Comp = InstanceType<typeof ICAL.Component>;
export type Prop = InstanceType<typeof ICAL.Property>;
/** A date, or a wall-clock time and the zone it is in. */
export type TimeVal = { date: string } | { wall: Wall; zone: Zone };

const PRODID = '-//dither-accounts//dav//EN';
const MAX_STEPS = 200_000;
const MAX_INSTANCES = 10_000;

export const invalid = (msg: string) => new StatusError(msg, 400);

/** Lines a strict parser chokes on (no name, no colon) dropped, folded lines joined, CRLF everywhere. */
function clean(text: string): string {
  const unfolded = text.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
  return unfolded
    .split('\n')
    .filter((l) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)?[;:]/.test(l) && l.includes(':'))
    .join('\r\n');
}

/** The first top-level component of iCalendar or vCard text. Throws a 400 when it does not parse. */
export function parseComponent(text: string, what = 'iCalendar'): Comp {
  let j: any;
  try {
    j = ICAL.parse(clean(text));
  } catch (e) {
    throw invalid(`that is not ${what}: ${(e as Error).message}`);
  }
  if (Array.isArray(j) && typeof j[0] !== 'string') j = j[0];
  if (!Array.isArray(j) || typeof j[0] !== 'string') throw invalid(`that is not ${what}`);
  return new ICAL.Component(j);
}

/** A parsed VCALENDAR with its zones. `floatingAs` is how dates and floating times are placed for windows. */
export class Cal {
  readonly vtz = new Map<string, Comp>();
  private zones = new Map<string, Zone>();
  constructor(
    readonly comp: Comp,
    readonly floatingAs: Zone = UTC,
  ) {
    for (const v of comp.getAllSubcomponents('vtimezone')) {
      const id = v.getFirstPropertyValue('tzid');
      if (typeof id === 'string') this.vtz.set(id, v);
    }
  }
  static parse(text: string, floatingAs?: Zone) {
    const c = parseComponent(text);
    if (c.name !== 'vcalendar') throw invalid('that is not a VCALENDAR');
    return new Cal(c, floatingAs);
  }

  zone(tzid: string): Zone {
    let z = this.zones.get(tzid);
    if (!z) {
      z = zoneFor(tzid, this.vtz) ?? FLOATING;
      this.zones.set(tzid, z);
    }
    return z;
  }

  /** One raw jCal value as a time. */
  value(type: string, v: unknown, tzid: string | undefined): TimeVal | null {
    if (typeof v !== 'string') return null;
    if (type === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(v)) return /^\d{4}-\d{2}-\d{2}/.test(v) ? { date: v.slice(0, 10) } : null;
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z)?/);
    if (!m) return null;
    const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
    if (m[7]) return { wall, zone: UTC };
    return { wall, zone: tzid ? this.zone(tzid) : FLOATING };
  }

  /** A property's (first) value as a time. */
  time(p: Prop | null | undefined): TimeVal | null {
    if (!p) return null;
    const j = p.jCal as any[];
    return this.value(j[2], j[3], tzidOf(p));
  }

  /** Every value of an RDATE/EXDATE-like property: times, or periods as start and end. */
  times(p: Prop): { start: TimeVal; end?: TimeVal }[] {
    const j = p.jCal as any[];
    const tz = tzidOf(p);
    const out: { start: TimeVal; end?: TimeVal }[] = [];
    for (const v of j.slice(3)) {
      if (Array.isArray(v)) {
        const start = this.value('date-time', v[0], tz);
        if (!start) continue;
        let end: TimeVal | undefined;
        if (typeof v[1] === 'string' && /^[+-]?P/.test(v[1])) end = plus(start, ICAL.Duration.fromString(v[1]), this);
        else end = this.value('date-time', v[1], tz) ?? undefined;
        out.push({ start, end });
      } else {
        const t = this.value(j[2], v, tz);
        if (t) out.push({ start: t });
      }
    }
    return out;
  }

  instant(t: TimeVal): number {
    if ('date' in t) {
      const [y, mo, d] = t.date.split('-').map(Number);
      return toInstant(this.floatingAs, { y, mo, d, h: 0, mi: 0, s: 0 });
    }
    return toInstant(t.zone, t.wall, this.floatingAs);
  }

  /** The instance key of a start (see the header). */
  key(t: TimeVal): string {
    if ('date' in t) return t.date.replace(/-/g, '');
    if (t.zone.kind === 'floating') return wallStr(t.wall).replace(/[-:]/g, '');
    return basicUtc(this.instant(t));
  }
}

const tzidOf = (p: Prop): string | undefined => {
  const t = p.getParameter('tzid');
  return typeof t === 'string' && t ? t : undefined;
};

export function calTime(t: TimeVal): CalTime {
  if ('date' in t) return { date: t.date };
  switch (t.zone.kind) {
    case 'utc':
      return { dateTime: `${wallStr(t.wall)}Z`, timeZone: null };
    case 'floating':
      return { dateTime: wallStr(t.wall), timeZone: null };
    case 'iana':
      return { dateTime: rfc3339(t.zone, t.wall), timeZone: t.zone.name };
    case 'vtz':
      return { dateTime: rfc3339(t.zone, t.wall), timeZone: null };
  }
}

/** A time plus an iCalendar duration: days and weeks on the wall clock, hours and less as elapsed time. */
function plus(t: TimeVal, d: InstanceType<typeof ICAL.Duration>, cal: Cal): TimeVal {
  const sign = d.isNegative ? -1 : 1;
  const days = sign * (d.weeks * 7 + d.days);
  const exact = sign * ((d.hours * 60 + d.minutes) * 60 + d.seconds) * 1000;
  if ('date' in t) return { date: addDays(t.date, days + Math.floor(exact / 86_400_000)) };
  const w = wallOfMs(wallMs(t.wall) + days * 86_400_000);
  if (!exact) return { wall: w, zone: t.zone };
  if (t.zone.kind === 'floating' || t.zone.kind === 'utc') return { wall: wallOfMs(wallMs(w) + exact), zone: t.zone };
  return { wall: wallAt(t.zone, toInstant(t.zone, w, cal.floatingAs) + exact), zone: t.zone };
}

type Dur = { days: number } | { exact: number; endZone: Zone } | { nominal: InstanceType<typeof ICAL.Duration> };

/** How long each instance of a component lasts (DTEND or DURATION; RFC 5545's defaults without either). */
function durationOf(cal: Cal, c: Comp, start: TimeVal): Dur {
  const end = cal.time(c.getFirstProperty('dtend'));
  if (end) {
    if ('date' in start) return { days: Math.max(0, daysBetween(start.date, 'date' in end ? end.date : dateStr(end.wall))) };
    return { exact: Math.max(0, cal.instant(end) - cal.instant(start)), endZone: 'date' in end ? start.zone : end.zone };
  }
  const dur = c.getFirstPropertyValue('duration');
  if (dur instanceof ICAL.Duration) {
    if ('date' in start) return { days: dur.weeks * 7 + dur.days };
    return { nominal: dur };
  }
  return 'date' in start ? { days: 1 } : { exact: 0, endZone: start.zone };
}

function endFor(cal: Cal, start: TimeVal, d: Dur): TimeVal {
  if ('date' in start) return { date: addDays(start.date, 'days' in d ? d.days : 1) };
  if ('nominal' in d) return plus(start, d.nominal, cal);
  if ('days' in d) return { wall: wallOfMs(wallMs(start.wall) + d.days * 86_400_000), zone: start.zone };
  if (start.zone.kind === 'floating' && d.endZone.kind === 'floating') return { wall: wallOfMs(wallMs(start.wall) + d.exact), zone: FLOATING };
  return { wall: wallAt(d.endZone, cal.instant(start) + d.exact), zone: d.endZone };
}

// ------------------------------------------------------------------ series

export interface Series {
  uid: string;
  /** The UID, or for a second master with a UID already taken (feeds have them) the UID and ~2, ~3… */
  key: string;
  master: Comp | null;
  overrides: Comp[];
}

/**
 * The VEVENTs of a calendar by UID, in the order they first appear. A second master with the same UID is its own
 * series (keyed `<uid>~2`) with `split`, else left out (a CalDAV resource has one).
 */
export function seriesOf(cal: Cal, dupes: 'drop' | 'split' = 'drop'): Series[] {
  const by = new Map<string, Series>();
  const out: Series[] = [];
  const masters = new Map<string, number>();
  let n = 0;
  for (const ev of cal.comp.getAllSubcomponents('vevent')) {
    const uidv = ev.getFirstPropertyValue('uid');
    const uid = typeof uidv === 'string' && uidv ? uidv : `no-uid-${n++}`;
    let s = by.get(uid);
    if (!s) {
      s = { uid, key: uid, master: null, overrides: [] };
      by.set(uid, s);
      out.push(s);
    }
    if (ev.hasProperty('recurrence-id')) s.overrides.push(ev);
    else if (!s.master) s.master = ev;
    else if (dupes === 'split') {
      const k = (masters.get(uid) ?? 1) + 1;
      masters.set(uid, k);
      out.push({ uid, key: `${uid}~${k}`, master: ev, overrides: [] });
    }
  }
  return out;
}

const text = (c: Comp, name: string): string | null => {
  const v = c.getFirstPropertyValue(name);
  return typeof v === 'string' && v !== '' ? v : v != null && typeof v !== 'object' ? String(v) : null;
};
const mailto = (v: unknown) => (typeof v === 'string' ? v.replace(/^mailto:/i, '') : '');
const STATUS: Record<string, CalEvent['status']> = { CONFIRMED: 'confirmed', TENTATIVE: 'tentative', CANCELLED: 'cancelled' };
const PARTSTAT: Record<string, CalAttendee['status']> = { 'NEEDS-ACTION': 'needs-action', ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', DELEGATED: 'delegated' };
const ROLE: Record<string, CalAttendee['role']> = { CHAIR: 'chair', 'REQ-PARTICIPANT': 'required', 'OPT-PARTICIPANT': 'optional', 'NON-PARTICIPANT': 'non-participant' };

function utcMs(c: Comp, name: string): number | null {
  const p = c.getFirstProperty(name);
  const v = p ? (p.jCal as any[])[3] : null;
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
}

/** The TZIDs a component's properties name. */
function tzidsOf(c: Comp, into = new Set<string>()): Set<string> {
  for (const p of c.getAllProperties()) {
    const t = tzidOf(p);
    if (t) into.add(t);
  }
  for (const s of c.getAllSubcomponents()) if (s.name !== 'vtimezone') tzidsOf(s, into);
  return into;
}

const cloneComp = (c: Comp) => new ICAL.Component(structuredClone(c.jCal));

/** A VCALENDAR holding one VEVENT and the VTIMEZONEs it names, as text. */
export function eventIcs(cal: Cal, ev: Comp): string {
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.addPropertyWithValue('version', '2.0');
  out.addPropertyWithValue('prodid', text(cal.comp, 'prodid') ?? PRODID);
  for (const t of tzidsOf(ev)) {
    const v = cal.vtz.get(t);
    if (v) out.addSubcomponent(cloneComp(v));
  }
  out.addSubcomponent(cloneComp(ev));
  return out.toString();
}

/** A hash of a VEVENT without DTSTAMP (feeds stamp every copy with the time it was made). */
export function eventHash(cal: Cal, ev: Comp): string {
  const j = structuredClone(ev.jCal) as any[];
  j[1] = (j[1] as any[]).filter((p) => p[0] !== 'dtstamp');
  const zones = [...tzidsOf(ev)].sort().map((t) => cal.vtz.get(t)?.toString() ?? t);
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(j) + zones.join('')).digest('base64url').slice(0, 22);
}

export interface EventCtx {
  calendarId: string;
  /** The series' id: the resource's name in its collection, or a feed's UID. */
  id: string;
  etag: string | null;
  /** Leave the iCalendar text out (feeds that are only listed for their changes still get it). */
  noIcs?: boolean;
}

/** One VEVENT as a CalEvent: the master (recurrence lines and all), an override, or an instance (`at`). */
export function eventFrom(cal: Cal, ev: Comp, ctx: EventCtx, at?: { rid: TimeVal; start: TimeVal; end: TimeVal }): CalEvent {
  const ridProp = ev.getFirstProperty('recurrence-id');
  const rid = at?.rid ?? cal.time(ridProp);
  const start = at?.start ?? cal.time(ev.getFirstProperty('dtstart')) ?? { date: '1970-01-01' };
  const end = at?.end ?? endFor(cal, start, durationOf(cal, ev, start));
  const org = ev.getFirstProperty('organizer');
  const person = (p: Prop): CalPerson => ({ email: mailto(p.getFirstValue()), name: (p.getParameter('cn') as string | undefined) ?? null });
  const isMaster = !ridProp && !at;
  return {
    id: rid ? `${ctx.id}#${cal.key(rid)}` : ctx.id,
    calendarId: ctx.calendarId,
    uid: text(ev, 'uid') ?? '',
    recurrenceId: rid ? calTime(rid) : null,
    title: text(ev, 'summary') ?? '',
    description: text(ev, 'description'),
    location: text(ev, 'location'),
    url: text(ev, 'url'),
    start: calTime(start),
    end: calTime(end),
    status: STATUS[String(text(ev, 'status')).toUpperCase()] ?? null,
    transparency: ({ OPAQUE: 'opaque', TRANSPARENT: 'transparent' } as const)[String(text(ev, 'transp')).toUpperCase() as 'OPAQUE'] ?? null,
    recurrence: isMaster ? ev.getAllProperties().filter((p) => ['rrule', 'rdate', 'exdate', 'exrule'].includes(p.name)).map((p) => p.toICALString()) : [],
    organizer: org ? person(org) : null,
    attendees: ev.getAllProperties('attendee').map((p) => ({
      ...person(p),
      status: PARTSTAT[String(p.getParameter('partstat') ?? '').toUpperCase()] ?? null,
      role: ROLE[String(p.getParameter('role') ?? '').toUpperCase()] ?? null,
    })),
    updated: utcMs(ev, 'last-modified') ?? utcMs(ev, 'dtstamp'),
    etag: ctx.etag,
    ics: ctx.noIcs ? null : eventIcs(cal, ev),
  };
}

/** A series as events: its master, then each changed instance. */
export function seriesEvents(cal: Cal, s: Series, ctx: EventCtx): CalEvent[] {
  return [...(s.master ? [s.master] : []), ...s.overrides].map((ev) => eventFrom(cal, ev, ctx));
}

/** RRULE's own iterator, with UNTIL moved into the master's wall clock. */
function* ruleStarts(cal: Cal, rule: Prop, start: TimeVal, stopMs: number): Generator<TimeVal> {
  const recur = ICAL.Recur.fromString((rule.getFirstValue() as any).toString());
  if (recur.until) {
    const u = recur.until;
    const untilUtc = u.zone === ICAL.Timezone.utcTimezone || (u as any).timezone === 'Z';
    if ('date' in start) {
      if (!u.isDate) {
        const w = untilUtc ? wallAt(cal.floatingAs, u.toUnixTime() * 1000) : { y: u.year, mo: u.month, d: u.day };
        recur.until = ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, isDate: true });
      }
    } else if (u.isDate) {
      recur.until = ICAL.Time.fromData({ year: u.year, month: u.month, day: u.day, hour: 23, minute: 59, second: 59, isDate: false });
    } else if (untilUtc && start.zone.kind !== 'floating') {
      const w = wallAt(start.zone, u.toUnixTime() * 1000);
      recur.until = ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false });
    } else if (untilUtc) {
      const w = wallAt(cal.floatingAs, u.toUnixTime() * 1000);
      recur.until = ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false });
    }
  }
  const dt =
    'date' in start
      ? ICAL.Time.fromDateString(start.date)
      : ICAL.Time.fromData({ year: start.wall.y, month: start.wall.mo, day: start.wall.d, hour: start.wall.h, minute: start.wall.mi, second: start.wall.s, isDate: false });
  const it = recur.iterator(dt);
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const n = it.next();
    if (!n) return;
    const t: TimeVal = 'date' in start ? { date: dateStr({ y: n.year, mo: n.month, d: n.day }) } : { wall: { y: n.year, mo: n.month, d: n.day, h: n.hour, mi: n.minute, s: n.second }, zone: start.zone };
    if (cal.instant(t) >= stopMs) return;
    yield t;
  }
}

/** Every start of a master before `stopMs` (unordered between RRULEs and RDATEs; the caller dedupes). */
function* starts(cal: Cal, m: Comp, start: TimeVal, stopMs: number): Generator<{ start: TimeVal; end?: TimeVal }> {
  for (const p of m.getAllProperties('rdate')) for (const r of cal.times(p)) if (cal.instant(r.start) < stopMs) yield r;
  const rules = m.getAllProperties('rrule');
  if (!rules.length) {
    if (cal.instant(start) < stopMs) yield { start };
    return;
  }
  for (const r of rules) for (const t of ruleStarts(cal, r, start, stopMs)) yield { start: t };
}

export interface Instance {
  comp: Comp;
  rid: TimeVal;
  start: TimeVal;
  end: TimeVal;
}

/** The instances of a series in [from, to): each start that is not excluded, as its override has it if it has one. */
export function instances(cal: Cal, s: Series, from: number, to: number, limit = MAX_INSTANCES): Instance[] {
  const out: Instance[] = [];
  const overlaps = (a: TimeVal, b: TimeVal) => {
    const sa = cal.instant(a);
    const eb = cal.instant(b);
    return sa < to && (eb > from || (eb <= sa && sa >= from));
  };
  const cancelled = (c: Comp) => String(text(c, 'status')).toUpperCase() === 'CANCELLED';
  const overrides = new Map<string, Comp>();
  for (const o of s.overrides) {
    const rid = cal.time(o.getFirstProperty('recurrence-id'));
    if (rid) overrides.set(cal.key(rid), o);
  }
  const used = new Set<string>();
  const own = (c: Comp, rid: TimeVal) => {
    const st = cal.time(c.getFirstProperty('dtstart')) ?? rid;
    return { comp: c, rid, start: st, end: endFor(cal, st, durationOf(cal, c, st)) };
  };
  const m = s.master;
  const start0 = m ? cal.time(m.getFirstProperty('dtstart')) : null;
  if (m && start0) {
    const dur = durationOf(cal, m, start0);
    const exKeys = new Set<string>();
    const exDates = new Set<string>();
    for (const p of m.getAllProperties('exdate'))
      for (const e of cal.times(p)) {
        exKeys.add(cal.key(e.start));
        if ('date' in e.start) exDates.add(e.start.date);
      }
    const seen = new Set<string>();
    // Walked from the first start: one that begins before the window can still reach into it.
    for (const occ of starts(cal, m, start0, to)) {
      const k = cal.key(occ.start);
      if (seen.has(k)) continue;
      seen.add(k);
      const ov = overrides.get(k);
      if (ov) {
        used.add(k);
        const i = own(ov, occ.start);
        if (!cancelled(ov) && overlaps(i.start, i.end)) out.push(i);
        if (out.length >= limit) return out;
        continue;
      }
      if (exKeys.has(k) || ('wall' in occ.start && exDates.has(dateStr(occ.start.wall)))) continue;
      const end = occ.end ?? endFor(cal, occ.start, dur);
      if (overlaps(occ.start, end)) out.push({ comp: m, rid: occ.start, start: occ.start, end });
      if (out.length >= limit) return out;
    }
  }
  // Overrides whose original start is outside what was walked (moved in from after the window, or orphans).
  for (const [k, ov] of overrides) {
    if (used.has(k) || cancelled(ov)) continue;
    const i = own(ov, cal.time(ov.getFirstProperty('recurrence-id'))!);
    if (overlaps(i.start, i.end)) out.push(i);
  }
  return out.sort((a, b) => cal.instant(a.start) - cal.instant(b.start));
}

/** A series' instances in a window, as events. */
export function expandEvents(cal: Cal, s: Series, ctx: EventCtx, from: number, to: number): CalEvent[] {
  return instances(cal, s, from, to).map((i) => eventFrom(cal, i.comp, ctx, i));
}

/** Whether any instance of a series falls in the window. */
export function seriesIn(cal: Cal, s: Series, from: number, to: number): boolean {
  return instances(cal, s, from, to, 1).length > 0;
}

/** An instant from an app's `from`/`to` (RFC 3339, or a date read as UTC midnight). */
export function parseInstant(v: string, what: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  if (!Number.isFinite(ms)) throw invalid(`${what}: not a date or RFC 3339 time: ${v}`);
  return ms;
}

// ------------------------------------------------------------------ writing

const prop = (j: any[]) => new ICAL.Property(j as any);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A CalTime as a DTSTART/DTEND-like property. */
export function timeProp(name: string, t: CalTime): Prop {
  if (!t || typeof t !== 'object') throw invalid(`${name}: expected { date } or { dateTime, timeZone }`);
  if ('date' in t) {
    if (typeof t.date !== 'string' || !DATE_RE.test(t.date)) throw invalid(`${name}: a date is YYYY-MM-DD`);
    return prop([name, {}, 'date', t.date]);
  }
  const m = typeof t.dateTime === 'string' ? t.dateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i) : null;
  if (!m) throw invalid(`${name}: dateTime is RFC 3339, like 2026-03-08T09:00:00-08:00`);
  let wall: Wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
  const off = m[7]?.toUpperCase();
  const offMs = off ? (off === 'Z' ? 0 : (off[0] === '-' ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(-2))) * 60_000) : null;
  if (t.timeZone) {
    const z = ianaName(t.timeZone);
    if (!z) throw invalid(`${name}: unknown time zone "${t.timeZone}"`);
    if (offMs !== null) wall = wallIn(z, wallMs(wall) - offMs);
    if (z === 'UTC' || z === 'Etc/UTC') return prop([name, {}, 'date-time', `${wallStr(wall)}Z`]);
    return prop([name, { tzid: z }, 'date-time', wallStr(wall)]);
  }
  if (offMs !== null) return prop([name, {}, 'date-time', `${wallStr(wallOfMs(wallMs(wall) - offMs))}Z`]);
  return prop([name, {}, 'date-time', wallStr(wall)]);
}

/** A TimeVal written as a property, in the same form it was read in. */
function tvProp(name: string, t: TimeVal): Prop {
  if ('date' in t) return prop([name, {}, 'date', t.date]);
  switch (t.zone.kind) {
    case 'utc':
      return prop([name, {}, 'date-time', `${wallStr(t.wall)}Z`]);
    case 'floating':
      return prop([name, {}, 'date-time', wallStr(t.wall)]);
    case 'iana':
      return prop([name, { tzid: t.zone.name }, 'date-time', wallStr(t.wall)]);
    case 'vtz':
      return prop([name, { tzid: t.zone.tzid }, 'date-time', wallStr(t.wall)]);
  }
}

function setText(c: Comp, name: string, v: string | null | undefined, type = 'text') {
  c.removeAllProperties(name);
  if (v !== null && v !== undefined && v !== '') c.addProperty(prop([name, {}, type, String(v)]));
}
const stamp = (ms: number) => `${wallStr(wallOfMs(ms))}Z`;

/** The input's fields onto a VEVENT. */
function applyFields(cal: Cal, ev: Comp, input: CalEventInput, isInstance: boolean) {
  const has = (k: keyof CalEventInput) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  if (has('title')) setText(ev, 'summary', input.title);
  if (has('description')) setText(ev, 'description', input.description);
  if (has('location')) setText(ev, 'location', input.location);
  if (has('url')) setText(ev, 'url', input.url, 'uri');
  if (has('status')) {
    const s = String(input.status).toUpperCase();
    if (!['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(s)) throw invalid('status is confirmed, tentative or cancelled');
    setText(ev, 'status', s);
  }
  if (has('transparency')) {
    const s = String(input.transparency).toUpperCase();
    if (!['OPAQUE', 'TRANSPARENT'].includes(s)) throw invalid('transparency is opaque or transparent');
    setText(ev, 'transp', s);
  }
  if (has('start')) {
    const old = cal.time(ev.getFirstProperty('dtstart'));
    const dur = old ? durationOf(cal, ev, old) : null;
    const hadEnd = ev.hasProperty('dtend');
    ev.removeAllProperties('dtstart');
    ev.addProperty(timeProp('dtstart', input.start!));
    // Moving the start alone moves the end with it.
    if (!has('end') && old && dur && hadEnd) {
      const ns = cal.time(ev.getFirstProperty('dtstart'))!;
      if ('date' in ns === 'date' in old) {
        ev.removeAllProperties('dtend');
        ev.addProperty(tvProp('dtend', endFor(cal, ns, dur)));
      } else ev.removeAllProperties('dtend');
    }
  }
  if (has('end')) {
    ev.removeAllProperties('dtend');
    ev.removeAllProperties('duration');
    ev.addProperty(timeProp('dtend', input.end!));
  }
  if (has('recurrence')) {
    if (isInstance && input.recurrence!.length) throw invalid('one instance of a series has no recurrence of its own');
    for (const n of ['rrule', 'rdate', 'exdate', 'exrule']) ev.removeAllProperties(n);
    for (const line of input.recurrence!) {
      if (typeof line !== 'string' || !/^(RRULE|RDATE|EXDATE)[;:]/i.test(line.trim())) throw invalid(`recurrence: "${line}" is not an RRULE, RDATE or EXDATE line`);
      let p: Prop;
      try {
        p = ICAL.Property.fromString(line.trim());
      } catch (e) {
        throw invalid(`recurrence: "${line}" does not parse: ${(e as Error).message}`);
      }
      ev.addProperty(p);
    }
  }
  if (has('attendees')) {
    ev.removeAllProperties('attendee');
    const PS = Object.fromEntries(Object.entries(PARTSTAT).map(([k, v]) => [v, k]));
    const RL = Object.fromEntries(Object.entries(ROLE).map(([k, v]) => [v, k]));
    for (const a of input.attendees!) {
      if (!a?.email) throw invalid('every attendee needs an email');
      const params: Record<string, string> = {};
      if (a.name) params.cn = a.name;
      if (a.status && PS[a.status]) params.partstat = PS[a.status];
      if (a.role && RL[a.role]) params.role = RL[a.role];
      ev.addProperty(prop(['attendee', params, 'cal-address', `mailto:${a.email}`]));
    }
  }
  const s = cal.time(ev.getFirstProperty('dtstart'));
  if (!s) throw invalid('an event needs a start');
  const e = cal.time(ev.getFirstProperty('dtend'));
  if (e) {
    if ('date' in s !== 'date' in e) throw invalid('start and end are both dates or both times');
    if (cal.instant(e) < cal.instant(s)) throw invalid('the end is before the start');
  }
}

/** VTIMEZONEs for every TZID named (from the tz library), none that nothing names, all before the events. */
function fixTimezones(vcal: Comp) {
  const used = new Set<string>();
  for (const c of vcal.getAllSubcomponents()) if (c.name !== 'vtimezone') tzidsOf(c, used);
  const subs = [...vcal.getAllSubcomponents()];
  const have = new Map<string, Comp>();
  for (const v of subs.filter((c) => c.name === 'vtimezone')) {
    const id = v.getFirstPropertyValue('tzid');
    if (typeof id === 'string' && used.has(id) && !have.has(id)) have.set(id, v);
  }
  for (const id of used) {
    if (have.has(id)) continue;
    const text = vtimezoneText(id);
    if (!text) continue;
    const v = parseComponent(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${text}\r\nEND:VCALENDAR`).getFirstSubcomponent('vtimezone');
    if (v) have.set(id, v);
  }
  vcal.removeAllSubcomponents();
  for (const v of have.values()) vcal.addSubcomponent(v);
  for (const c of subs) if (c.name !== 'vtimezone') vcal.addSubcomponent(c);
}

function bump(ev: Comp, now: number) {
  const seq = Number(ev.getFirstPropertyValue('sequence'));
  ev.removeAllProperties('sequence');
  ev.addProperty(prop(['sequence', {}, 'integer', Number.isFinite(seq) ? seq + 1 : 1]));
  setText(ev, 'dtstamp', stamp(now), 'date-time');
  setText(ev, 'last-modified', stamp(now), 'date-time');
}

export type Target = { kind: 'new' } | { kind: 'master' } | { kind: 'instance'; key: string };

/**
 * A resource with an app's change made: a new event, its master, or one instance (made an override if it is not one
 * yet). `ics` replaces what it targets (a new resource is the text as it is). The text and the series' uid.
 */
export function writeEvent(base: Cal | null, target: Target, input: CalEventInput, now = Date.now()): { text: string; uid: string } {
  if (target.kind === 'new') {
    if (input.ics) {
      const c = Cal.parse(input.ics);
      const s = seriesOf(c);
      if (s.length !== 1) throw invalid(`ics holds ${s.length} events; one is expected`);
      if (s[0].uid.startsWith('no-uid-')) throw invalid('the event in ics has no UID');
      return { text: c.comp.toString(), uid: s[0].uid };
    }
    const uid = input.uid ?? crypto.randomUUID();
    const vcal = new ICAL.Component(['vcalendar', [], []]);
    vcal.addPropertyWithValue('version', '2.0');
    vcal.addPropertyWithValue('prodid', PRODID);
    const ev = new ICAL.Component('vevent');
    ev.addProperty(prop(['uid', {}, 'text', uid]));
    ev.addProperty(prop(['dtstamp', {}, 'date-time', stamp(now)]));
    ev.addProperty(prop(['created', {}, 'date-time', stamp(now)]));
    vcal.addSubcomponent(ev);
    const cal = new Cal(vcal);
    applyFields(cal, ev, input, false);
    fixTimezones(vcal);
    return { text: vcal.toString(), uid };
  }
  if (!base) throw new StatusError('no such event', 404);
  const vcal = base.comp;
  const series = seriesOf(base);
  const s = series[0];
  if (!s) throw new StatusError('no such event', 404);
  if (input.uid && input.uid !== s.uid) throw invalid("an event's uid cannot change");

  if (target.kind === 'master') {
    if (input.ics) {
      const c = Cal.parse(input.ics);
      const evs = c.comp.getAllSubcomponents('vevent');
      if (!evs.length) throw invalid('ics holds no event');
      for (const e of evs) if (e.getFirstPropertyValue('uid') !== s.uid) throw invalid("ics is another event (its UID differs); an event's uid cannot change");
      const newMaster = evs.find((e) => !e.hasProperty('recurrence-id'));
      if (newMaster && s.master) vcal.removeSubcomponent(s.master);
      for (const o of evs.filter((e) => e.hasProperty('recurrence-id'))) {
        const k = c.key(c.time(o.getFirstProperty('recurrence-id'))!);
        const old = s.overrides.find((x) => base.key(base.time(x.getFirstProperty('recurrence-id'))!) === k);
        if (old) vcal.removeSubcomponent(old);
      }
      for (const v of c.comp.getAllSubcomponents('vtimezone')) if (!base.vtz.has(String(v.getFirstPropertyValue('tzid')))) vcal.addSubcomponent(cloneComp(v));
      for (const e of evs) vcal.addSubcomponent(cloneComp(e));
      fixTimezones(vcal);
      return { text: vcal.toString(), uid: s.uid };
    }
    if (!s.master) throw new StatusError('this event is only changed instances of a series whose master is not here; change them one by one', 404);
    applyFields(base, s.master, input, false);
    bump(s.master, now);
    fixTimezones(vcal);
    return { text: vcal.toString(), uid: s.uid };
  }

  // One instance.
  let ov = s.overrides.find((o) => base.key(base.time(o.getFirstProperty('recurrence-id'))!) === target.key);
  if (!ov) {
    if (!s.master) throw new StatusError('no such instance', 404);
    const occ = findStart(base, s.master, target.key);
    if (!occ) throw new StatusError(`no instance ${target.key} in this series`, 404);
    ov = cloneComp(s.master);
    for (const n of ['rrule', 'rdate', 'exdate', 'exrule', 'dtstart', 'dtend', 'recurrence-id']) ov.removeAllProperties(n);
    const st0 = base.time(s.master.getFirstProperty('dtstart'))!;
    const hadDuration = s.master.hasProperty('duration');
    ov.addProperty(tvProp('recurrence-id', occ.start));
    ov.addProperty(tvProp('dtstart', occ.start));
    if (!hadDuration) ov.addProperty(tvProp('dtend', occ.end ?? endFor(base, occ.start, durationOf(base, s.master, st0))));
    vcal.addSubcomponent(ov);
  }
  if (input.ics) {
    const c = Cal.parse(input.ics);
    const e = c.comp.getFirstSubcomponent('vevent');
    if (!e) throw invalid('ics holds no event');
    const repl = cloneComp(e);
    repl.removeAllProperties('recurrence-id');
    repl.addProperty(cloneProp(ov.getFirstProperty('recurrence-id')!));
    repl.removeAllProperties('uid');
    repl.addProperty(prop(['uid', {}, 'text', s.uid]));
    for (const v of c.comp.getAllSubcomponents('vtimezone')) if (!base.vtz.has(String(v.getFirstPropertyValue('tzid')))) vcal.addSubcomponent(cloneComp(v));
    vcal.removeSubcomponent(ov);
    vcal.addSubcomponent(repl);
    fixTimezones(vcal);
    return { text: vcal.toString(), uid: s.uid };
  }
  applyFields(base, ov, input, true);
  bump(ov, now);
  fixTimezones(vcal);
  return { text: vcal.toString(), uid: s.uid };
}

const cloneProp = (p: Prop) => new ICAL.Property(structuredClone(p.jCal) as any);

/** The start of a master's instance with this key, if the series has one (excluded ones do not count). */
function findStart(cal: Cal, m: Comp, key: string): { start: TimeVal; end?: TimeVal } | null {
  const start0 = cal.time(m.getFirstProperty('dtstart'));
  if (!start0) return null;
  const target = keyInstant(cal, key);
  if (target === null) return null;
  const ex = new Set<string>();
  for (const p of m.getAllProperties('exdate')) for (const e of cal.times(p)) ex.add(cal.key(e.start));
  for (const occ of starts(cal, m, start0, target + 2 * 86_400_000)) if (cal.key(occ.start) === key && !ex.has(key)) return occ;
  return null;
}

function keyInstant(cal: Cal, key: string): number | null {
  let m = key.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return cal.instant({ date: `${m[1]}-${m[2]}-${m[3]}` });
  m = key.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const w = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  return m[7] ? wallMs(w) : toInstant(FLOATING, w, cal.floatingAs);
}

/**
 * A resource with one instance deleted: its override (if any) gone and an EXDATE on the master. Null when nothing is
 * left of the resource (delete it whole).
 */
export function deleteInstance(base: Cal, key: string, now = Date.now()): string | null {
  const s = seriesOf(base)[0];
  if (!s) throw new StatusError('no such event', 404);
  const ov = s.overrides.find((o) => base.key(base.time(o.getFirstProperty('recurrence-id'))!) === key);
  let rid: TimeVal | null = ov ? base.time(ov.getFirstProperty('recurrence-id')) : null;
  if (s.master) {
    if (!rid) rid = findStart(base, s.master, key)?.start ?? null;
    if (!rid) throw new StatusError(`no instance ${key} in this series`, 404);
    const st0 = base.time(s.master.getFirstProperty('dtstart'))!;
    // EXDATE in the master's own form, so it matches its instances.
    const ex: TimeVal = 'date' in st0 ? { date: 'date' in rid ? rid.date : dateStr(rid.wall) } : 'date' in rid ? rid : { wall: wallAt(st0.zone, base.instant(rid)), zone: st0.zone };
    s.master.addProperty(tvProp('exdate', ex));
    bump(s.master, now);
  } else if (!ov) throw new StatusError(`no instance ${key} in this series`, 404);
  if (ov) base.comp.removeSubcomponent(ov);
  if (!base.comp.getAllSubcomponents('vevent').length) return null;
  fixTimezones(base.comp);
  return base.comp.toString();
}

/** Split an event id into the series' id and the instance key. */
export function splitId(id: string): { series: string; key: string | null } {
  const i = id.lastIndexOf('#');
  return i > 0 ? { series: id.slice(0, i), key: id.slice(i + 1) } : { series: id, key: null };
}

/** The calendar-wide zone from a CalDAV calendar-timezone or a feed's X-WR-TIMEZONE, if it is an IANA one. */
export function calendarZone(tz: string | null | undefined): Zone {
  if (!tz) return UTC;
  if (tz.includes('BEGIN:VTIMEZONE')) {
    try {
      const v = parseComponent(tz.includes('BEGIN:VCALENDAR') ? tz : `BEGIN:VCALENDAR\r\n${tz}\r\nEND:VCALENDAR`).getFirstSubcomponent('vtimezone');
      const id = v?.getFirstPropertyValue('tzid');
      if (typeof id === 'string') return zoneFor(id, new Map([[id, v!]])) ?? UTC;
    } catch {}
    return UTC;
  }
  const n = ianaName(tz.trim());
  return n ? (n === 'UTC' ? UTC : { kind: 'iana', name: n }) : UTC;
}

/** The IANA name of a calendar-wide zone, for Calendar.timeZone. */
export const zoneName = (z: Zone): string | null => (z.kind === 'iana' ? z.name : z.kind === 'utc' ? 'UTC' : null);
