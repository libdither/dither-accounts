/**
 * The calendar code the dav and ics extractors share (extractors/dav/src/ical.ts, tz.ts): times and zones,
 * recurrence expansion across changes of offset, EXDATE, RDATE, overrides, all-day dates, VTIMEZONEs that are not
 * IANA names, and writing events back.
 */
import { expect, test } from 'bun:test';
import type { CalTime } from '@dither-accounts/interfaces';
import { Cal, calTime, deleteInstance, eventFrom, expandEvents, instances, seriesEvents, seriesOf, writeEvent } from '../extractors/dav/src/ical.ts';
import { toInstant } from '../extractors/dav/src/tz.ts';

const cal = (...lines: string[]) => Cal.parse(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n'));
const ctx = { calendarId: 'c', id: 'r.ics', etag: '"1"' };
const dt = (t: CalTime) => ('dateTime' in t ? t.dateTime : t.date);
const W = (from: string, to: string) => [Date.parse(from), Date.parse(to)] as const;
const LA_TZ = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Los_Angeles',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

test('a weekly 09:00 in Los Angeles stays 09:00 across the change to daylight time', () => {
  const c = cal(...LA_TZ, 'BEGIN:VEVENT', 'UID:w1', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=America/Los_Angeles:20260223T090000', 'DTEND;TZID=America/Los_Angeles:20260223T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Standup', 'END:VEVENT');
  const [s] = seriesOf(c);
  const evs = expandEvents(c, s, ctx, ...W('2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z'));
  expect(evs.map((e) => e.start)).toEqual([
    { dateTime: '2026-02-23T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    { dateTime: '2026-03-02T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    { dateTime: '2026-03-09T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
    { dateTime: '2026-03-16T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
  ]);
  expect(evs[2].end).toEqual({ dateTime: '2026-03-09T10:00:00-07:00', timeZone: 'America/Los_Angeles' });
  expect(evs[2].id).toBe('r.ics#20260309T160000Z');
  expect(evs[2].recurrenceId).toEqual({ dateTime: '2026-03-09T09:00:00-07:00', timeZone: 'America/Los_Angeles' });
  expect(evs.every((e) => e.title === 'Standup' && e.uid === 'w1' && e.recurrence.length === 0)).toBe(true);
  // Without expand: the master, with its rule.
  const [m] = seriesEvents(c, s, ctx);
  expect(m).toMatchObject({ id: 'r.ics', recurrenceId: null, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'], etag: '"1"' });
  expect(m.ics).toContain('BEGIN:VTIMEZONE');
});

test('Berlin across the end of summer time: EXDATE, an override moved, a cancelled one, UNTIL in UTC', () => {
  const c = cal(
    'BEGIN:VEVENT',
    'UID:b1',
    'DTSTART;TZID=Europe/Berlin:20261022T080000',
    'DURATION:PT30M',
    'RRULE:FREQ=DAILY;UNTIL=20261028T070000Z',
    'EXDATE;TZID=Europe/Berlin:20261024T080000',
    'SUMMARY:Daily',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b1',
    'RECURRENCE-ID;TZID=Europe/Berlin:20261026T080000',
    'DTSTART;TZID=Europe/Berlin:20261026T120000',
    'DTEND;TZID=Europe/Berlin:20261026T130000',
    'SUMMARY:Daily (moved)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b1',
    'RECURRENCE-ID:20261027T070000Z',
    'DTSTART:20261027T070000Z',
    'STATUS:CANCELLED',
    'END:VEVENT',
  );
  const [s] = seriesOf(c);
  const evs = expandEvents(c, s, ctx, ...W('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'));
  // No TZID VTIMEZONE in the file: the IANA name is enough. UNTIL 07:00Z is 08:00 CET on the 28th: included.
  expect(evs.map((e) => [dt(e.start), e.title])).toEqual([
    ['2026-10-22T08:00:00+02:00', 'Daily'],
    ['2026-10-23T08:00:00+02:00', 'Daily'],
    ['2026-10-25T08:00:00+01:00', 'Daily'],
    ['2026-10-26T12:00:00+01:00', 'Daily (moved)'],
    ['2026-10-28T08:00:00+01:00', 'Daily'],
  ]);
  expect(dt(evs[2].end)).toBe('2026-10-25T08:30:00+01:00');
  expect(evs[3].id).toBe('r.ics#20261026T070000Z');
  // Listed without expand: master and both overrides, the cancelled one says so.
  const all = seriesEvents(c, s, ctx);
  expect(all.map((e) => [e.id, e.status])).toEqual([
    ['r.ics', null],
    ['r.ics#20261026T070000Z', null],
    ['r.ics#20261027T070000Z', 'cancelled'],
  ]);
  expect(all[0].recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261028T070000Z', 'EXDATE;TZID=Europe/Berlin:20261024T080000']);
});

test('an override moved into the window from after it, and one moved out of it', () => {
  const c = cal(
    'BEGIN:VEVENT',
    'UID:m1',
    'DTSTART:20260601T100000Z',
    'DTEND:20260601T110000Z',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:m1',
    'RECURRENCE-ID:20260629T100000Z',
    'DTSTART:20260603T100000Z',
    'DTEND:20260603T110000Z',
    'SUMMARY:early',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:m1',
    'RECURRENCE-ID:20260608T100000Z',
    'DTSTART:20260720T100000Z',
    'DTEND:20260720T110000Z',
    'END:VEVENT',
  );
  const [s] = seriesOf(c);
  const got = instances(c, s, ...W('2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z')).map((i) => [c.key(i.rid), calTime(i.start)]);
  expect(got).toEqual([
    ['20260601T100000Z', { dateTime: '2026-06-01T10:00:00Z', timeZone: null }],
    ['20260629T100000Z', { dateTime: '2026-06-03T10:00:00Z', timeZone: null }],
  ]);
});

test('all-day: exclusive ends, EXDATE by date, RDATE, a window that only overlaps the last day', () => {
  const c = cal('BEGIN:VEVENT', 'UID:a1', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260107', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;VALUE=DATE:20260112', 'RDATE;VALUE=DATE:20260125', 'SUMMARY:Trip', 'END:VEVENT');
  const [s] = seriesOf(c);
  const evs = expandEvents(c, s, ctx, ...W('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
  expect(evs.map((e) => [e.start, e.end])).toEqual([
    [{ date: '2026-01-05' }, { date: '2026-01-07' }],
    [{ date: '2026-01-19' }, { date: '2026-01-21' }],
    [{ date: '2026-01-25' }, { date: '2026-01-27' }],
  ]);
  expect(evs[0].id).toBe('r.ics#20260105');
  // The 6th is the last day of the first instance; the 7th is not in it.
  expect(instances(c, s, ...W('2026-01-06T12:00:00Z', '2026-01-07T00:00:00Z')).length).toBe(1);
  expect(instances(c, s, ...W('2026-01-07T00:00:00Z', '2026-01-08T00:00:00Z')).length).toBe(0);
  // A single all-day event without DTEND lasts its one day.
  const one = cal('BEGIN:VEVENT', 'UID:a2', 'DTSTART;VALUE=DATE:20260301', 'END:VEVENT');
  expect(eventFrom(one, seriesOf(one)[0].master!, ctx).end).toEqual({ date: '2026-03-02' });
});

test('a VTIMEZONE that is no IANA name, a Windows name, a mozilla.org one, and floating times', () => {
  const custom = cal(
    'BEGIN:VTIMEZONE',
    'TZID:My Office Time',
    ...LA_TZ.slice(2, -1),
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:c1',
    'DTSTART;TZID=My Office Time:20260309T090000',
    'DTEND;TZID=My Office Time:20260309T093000',
    'END:VEVENT',
  );
  const ev = eventFrom(custom, seriesOf(custom)[0].master!, ctx);
  // Converted with the VTIMEZONE itself; no IANA name to give.
  expect(ev.start).toEqual({ dateTime: '2026-03-09T09:00:00-07:00', timeZone: null });
  const win = cal('BEGIN:VTIMEZONE', 'TZID:Pacific Standard Time', ...LA_TZ.slice(2, -1), 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:c2', 'DTSTART;TZID=Pacific Standard Time:20260301T090000', 'END:VEVENT');
  expect(eventFrom(win, seriesOf(win)[0].master!, ctx).start).toEqual({ dateTime: '2026-03-01T09:00:00-08:00', timeZone: 'America/Los_Angeles' });
  const moz = cal('BEGIN:VEVENT', 'UID:c3', 'DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20260701T090000', 'END:VEVENT');
  expect(eventFrom(moz, seriesOf(moz)[0].master!, ctx).start).toEqual({ dateTime: '2026-07-01T09:00:00-04:00', timeZone: 'America/New_York' });
  const fl = cal('BEGIN:VEVENT', 'UID:c4', 'DTSTART:20260701T090000', 'DTEND:20260701T100000', 'END:VEVENT');
  expect(eventFrom(fl, seriesOf(fl)[0].master!, ctx)).toMatchObject({ start: { dateTime: '2026-07-01T09:00:00', timeZone: null }, end: { dateTime: '2026-07-01T10:00:00', timeZone: null } });
});

test("a time the change to daylight time skips is read with the offset before it; a repeated one is the first", () => {
  const la = { kind: 'iana', name: 'America/Los_Angeles' } as const;
  expect(new Date(toInstant(la, { y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 })).toISOString()).toBe('2026-03-08T10:30:00.000Z');
  expect(new Date(toInstant(la, { y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 })).toISOString()).toBe('2026-11-01T08:30:00.000Z');
  // A daily 02:30 series: on the 8th it is at 03:30 daylight time, then 02:30 again.
  const c = cal('BEGIN:VEVENT', 'UID:g1', 'DTSTART;TZID=America/Los_Angeles:20260307T023000', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT');
  const evs = expandEvents(c, seriesOf(c)[0], ctx, ...W('2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z'));
  expect(evs.map((e) => new Date(dt(e.start)!).toISOString())).toEqual(['2026-03-07T10:30:00.000Z', '2026-03-08T10:30:00.000Z', '2026-03-09T09:30:00.000Z']);
});

test('DURATION in days is wall-clock days across a change of offset; RDATE periods keep their own length', () => {
  const c = cal('BEGIN:VEVENT', 'UID:d1', 'DTSTART;TZID=America/New_York:20260307T200000', 'DURATION:P1D', 'RDATE;VALUE=PERIOD:20260320T150000Z/PT2H', 'END:VEVENT');
  const evs = expandEvents(c, seriesOf(c)[0], ctx, ...W('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'));
  expect(evs.map((e) => [dt(e.start), dt(e.end)])).toEqual([
    ['2026-03-07T20:00:00-05:00', '2026-03-08T20:00:00-04:00'],
    ['2026-03-20T15:00:00Z', '2026-03-20T17:00:00Z'],
  ]);
});

test('writing: a new event in a zone gets its VTIMEZONE, and reads back as written', () => {
  const { text, uid } = writeEvent(null, { kind: 'new' }, {
    uid: 'new-1',
    title: 'Planning; with, commas',
    start: { dateTime: '2026-03-10T09:00:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-03-10T10:00:00+01:00', timeZone: 'Europe/Berlin' },
    description: 'line one\nline two',
    location: 'Room 1',
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10'],
    attendees: [{ email: 'bob@example.com', name: 'Bob', status: 'accepted', role: 'required' }],
    transparency: 'opaque',
    status: 'confirmed',
  });
  expect(uid).toBe('new-1');
  expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin');
  expect(text).toContain('DTSTART;TZID=Europe/Berlin:20260310T090000');
  const c = Cal.parse(text);
  const [e] = seriesEvents(c, seriesOf(c)[0], ctx);
  expect(e).toMatchObject({
    uid: 'new-1',
    title: 'Planning; with, commas',
    description: 'line one\nline two',
    start: { dateTime: '2026-03-10T09:00:00+01:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-03-10T10:00:00+01:00', timeZone: 'Europe/Berlin' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10'],
    attendees: [{ email: 'bob@example.com', name: 'Bob', status: 'accepted', role: 'required' }],
    status: 'confirmed',
    transparency: 'opaque',
  });
  // UTC and floating, and bad input.
  expect(writeEvent(null, { kind: 'new' }, { start: { dateTime: '2026-03-10T09:00:00-08:00', timeZone: null } }).text).toContain('DTSTART:20260310T170000Z');
  expect(writeEvent(null, { kind: 'new' }, { start: { date: '2026-03-10' }, end: { date: '2026-03-11' } }).text).toContain('DTSTART;VALUE=DATE:20260310');
  expect(() => writeEvent(null, { kind: 'new' }, { title: 'no start' })).toThrow('an event needs a start');
  expect(() => writeEvent(null, { kind: 'new' }, { start: { dateTime: '2026-03-10T09:00:00', timeZone: 'Mars/Olympus' } })).toThrow('unknown time zone');
  expect(() => writeEvent(null, { kind: 'new' }, { start: { date: '2026-03-10' }, end: { date: '2026-03-09' } })).toThrow('before the start');
});

test('writing: changing one instance makes an override; deleting one adds an EXDATE; moving the start moves the end', () => {
  const base = writeEvent(null, { kind: 'new' }, { uid: 's1', title: 'Series', start: { dateTime: '2026-03-02T09:00:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-03-02T09:30:00', timeZone: 'America/Los_Angeles' }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'] }).text;
  const changed = writeEvent(Cal.parse(base), { kind: 'instance', key: '20260309T160000Z' }, { title: 'Series (later)', start: { dateTime: '2026-03-09T11:00:00', timeZone: 'America/Los_Angeles' } }).text;
  let c = Cal.parse(changed);
  let s = seriesOf(c)[0];
  expect(s.overrides.length).toBe(1);
  const evs = expandEvents(c, s, ctx, ...W('2026-03-01T00:00:00Z', '2026-04-15T00:00:00Z'));
  expect(evs.map((e) => [e.id, dt(e.start), dt(e.end), e.title])).toEqual([
    ['r.ics#20260302T170000Z', '2026-03-02T09:00:00-08:00', '2026-03-02T09:30:00-08:00', 'Series'],
    ['r.ics#20260309T160000Z', '2026-03-09T11:00:00-07:00', '2026-03-09T11:30:00-07:00', 'Series (later)'],
    ['r.ics#20260316T160000Z', '2026-03-16T09:00:00-07:00', '2026-03-16T09:30:00-07:00', 'Series'],
    ['r.ics#20260323T160000Z', '2026-03-23T09:00:00-07:00', '2026-03-23T09:30:00-07:00', 'Series'],
    ['r.ics#20260330T160000Z', '2026-03-30T09:00:00-07:00', '2026-03-30T09:30:00-07:00', 'Series'],
  ]);
  // Delete the changed one and a plain one.
  let t = deleteInstance(c, '20260309T160000Z')!;
  t = deleteInstance(Cal.parse(t), '20260323T160000Z')!;
  c = Cal.parse(t);
  s = seriesOf(c)[0];
  expect(s.overrides.length).toBe(0);
  expect(expandEvents(c, s, ctx, ...W('2026-03-01T00:00:00Z', '2026-04-15T00:00:00Z')).map((e) => e.id)).toEqual(['r.ics#20260302T170000Z', 'r.ics#20260316T160000Z', 'r.ics#20260330T160000Z']);
  expect(seriesEvents(c, s, ctx)[0].recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=America/Los_Angeles:20260309T090000', 'EXDATE;TZID=America/Los_Angeles:20260323T090000']);
  expect(() => deleteInstance(c, '20260310T160000Z')).toThrow('no instance');
  // The master moved by a day keeps its half hour; its sequence goes up.
  const moved = Cal.parse(writeEvent(c, { kind: 'master' }, { start: { dateTime: '2026-03-03T09:00:00', timeZone: 'America/Los_Angeles' } }).text);
  const m = seriesOf(moved)[0].master!;
  expect(eventFrom(moved, m, ctx).end).toEqual({ dateTime: '2026-03-03T09:30:00-08:00', timeZone: 'America/Los_Angeles' });
  expect(Number(m.getFirstPropertyValue('sequence'))).toBe(3); // two EXDATEs, then this
  expect(() => writeEvent(c, { kind: 'master' }, { uid: 'other' })).toThrow('uid cannot change');
});
