/**
 * `google.calendar`: Google Calendar API v3, the calls a two-way sync needs. Resources are Google's own JSON
 * (https://developers.google.com/calendar/api/v3/reference), passed through. A failed call carries Google's HTTP
 * status in CallError.status: 410 means a sync token is stale (start over), 404/410 on a delete means already gone.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

const resource = s.typed<Record<string, any>>('a Google resource');
const page = s.object({ items: s.array(resource, 100_000), nextPageToken: s.optional(s.string), nextSyncToken: s.optional(s.string) });
const id = s.string;

export const googleCalendar = iface({
  name: 'google.calendar',
  version: 1,
  describe: 'Google Calendar: your calendars and their events.',
  levels: {
    read: 'See your Google calendars and their events',
    write: 'Create, change and delete events and calendars in your Google Calendar',
  },
  ops: {
    'calendar.calendarList.list': op('read', 'Your calendars', s.object({ pageToken: s.optional(s.string), maxResults: s.optional(s.integer), syncToken: s.optional(s.string) }), page),
    'calendar.calendarList.patch': op('write', "Change how a calendar shows (colour, shown)", s.object({ calendarId: id, colorRgbFormat: s.optional(s.boolean), body: resource }), resource),
    'calendar.calendars.insert': op('write', 'Make a calendar', s.object({ body: resource }), resource),
    'calendar.events.list': op(
      'read',
      "A calendar's events, a page at a time; with syncToken, only what changed",
      s.object({
        calendarId: id,
        syncToken: s.optional(s.string),
        pageToken: s.optional(s.string),
        maxResults: s.optional(s.integer),
        singleEvents: s.optional(s.boolean),
        showDeleted: s.optional(s.boolean),
        timeMin: s.optional(s.string),
        timeMax: s.optional(s.string),
      }),
      page,
      120_000,
    ),
    'calendar.events.insert': op('write', 'Create an event', s.object({ calendarId: id, body: resource }), resource),
    'calendar.events.patch': op('write', 'Change an event (or one instance of a series)', s.object({ calendarId: id, eventId: id, body: resource }), resource),
    'calendar.events.delete': op('write', 'Delete an event', s.object({ calendarId: id, eventId: id }), s.object({})),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
  },
});
