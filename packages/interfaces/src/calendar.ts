/**
 * `calendar`: calendars and their events, the same to an app whether CalDAV, a read-only .ics feed or a provider's
 * own API is behind it. (`google.calendar` passes Google's own JSON through; this one is the common shape.)
 *
 * - Ids are the extractor's own and stable. `uid` is the iCalendar UID, the same in every copy of the event; one
 *   instance of a recurring series that was changed is its own event with the series' uid and a `recurrenceId`.
 * - Times: an all-day event has `{ date: 'YYYY-MM-DD' }` with an exclusive end; any other has an RFC 3339
 *   `dateTime` and the IANA `timeZone` it was made in (null: floating, or UTC when the dateTime ends in Z).
 * - Keeping up: `cal.events` answers a `syncToken`; `cal.changes` with it answers what changed since. A failed call
 *   with CallError.status 410 means the token is stale: list the calendar again. A write with `ifMatch` that lost to
 *   someone else's change fails with status 412.
 * - Read-only calendars (an .ics feed, a shared calendar you may only see) refuse writes with status 403.
 * - `removed` may name ids the app never had (an instance changed and changed back before it looked): ignore those.
 * - A calendar that appears or goes also comes as `cal.changed` with its id: list `cal.calendars` again.
 * - Tasks (VTODO) are not in this version: `components` says a calendar holds them, but `cal.events` returns events.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface Calendar {
  id: string;
  name: string;
  /** #RRGGBB, when the server has one. */
  color: string | null;
  description: string | null;
  timeZone: string | null;
  readOnly: boolean;
  /** What it holds: events, tasks (VTODO), or both. */
  components: ('event' | 'task')[];
}

export type CalTime = { date: string } | { dateTime: string; timeZone: string | null };

export interface CalPerson {
  email: string;
  name: string | null;
}

export interface CalAttendee extends CalPerson {
  status: 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated' | null;
  role: 'chair' | 'required' | 'optional' | 'non-participant' | null;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  uid: string;
  /** Set on one changed (or cancelled) instance of a series: the start it replaces. */
  recurrenceId: CalTime | null;
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start: CalTime;
  end: CalTime;
  status: 'confirmed' | 'tentative' | 'cancelled' | null;
  /** transparent: does not count as busy. */
  transparency: 'opaque' | 'transparent' | null;
  /** RRULE, RDATE and EXDATE lines, on the series itself; empty on an expanded instance and on a changed one. */
  recurrence: string[];
  organizer: CalPerson | null;
  attendees: CalAttendee[];
  updated: number | null;
  /** For ifMatch on cal.put and cal.delete. */
  etag: string | null;
  /** The event's iCalendar text as the server has it (VEVENT with its VTIMEZONEs), for anything the fields leave out. */
  ics: string | null;
}

/** A new or changed event: the fields, or `ics` (a VCALENDAR with one event), used as it is. */
export interface CalEventInput {
  uid?: string;
  title?: string;
  start?: CalTime;
  end?: CalTime;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  transparency?: 'opaque' | 'transparent';
  recurrence?: string[];
  attendees?: CalAttendee[];
  ics?: string;
}

export const calendar = iface({
  name: 'calendar',
  version: 1,
  describe: 'Calendars and their events, from CalDAV, .ics feeds and the like.',
  levels: {
    read: 'See your calendars and their events',
    write: 'Create, change and delete events in your calendars',
  },
  ops: {
    'cal.calendars': op('read', 'Your calendars', s.object({}), s.typed<{ calendars: Calendar[] }>(), 60_000),
    'cal.events': op(
      'read',
      "A calendar's events, a page at a time; with expand (and from and to), a series as its instances in that window",
      s.object({ calendarId: s.string, from: s.optional(s.string), to: s.optional(s.string), expand: s.optional(s.boolean), pageToken: s.optional(s.string) }),
      s.typed<{ events: CalEvent[]; next: string | null; syncToken: string | null }>(),
      120_000,
    ),
    'cal.changes': op(
      'read',
      'What changed in a calendar since a sync token',
      s.object({ calendarId: s.string, syncToken: s.string }),
      s.typed<{ changed: CalEvent[]; removed: string[]; syncToken: string; more: boolean }>(),
      120_000,
    ),
    'cal.put': op(
      'write',
      'Create an event (no id) or change one',
      s.object({ calendarId: s.string, id: s.optional(s.string), event: s.typed<CalEventInput>('an event'), ifMatch: s.optional(s.string) }),
      s.typed<CalEvent>(),
      60_000,
    ),
    'cal.delete': op('write', 'Delete an event', s.object({ calendarId: s.string, id: s.string, ifMatch: s.optional(s.string) }), s.object({}), 60_000),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'cal.changed': ev('Something changed in a calendar: call cal.changes with your last sync token', s.typed<{ calendarId: string }>()),
  },
});
