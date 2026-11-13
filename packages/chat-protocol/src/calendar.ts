/**
 * dither-calendar beside the hub (docs/calendar.md): a calendar service the hub reaches through an account of kind
 * `calendar`, whose one setting is the service's address. The wire between the two; dither-calendar defines the types
 * it needs, with the same names, in its shared/types.ts. Change one side only together with the other.
 *
 *   Hub dials  <url>/api/chat-adapter      WebSocket, the adapter protocol (adapter.ts), the hub's commands one way
 *                                          and the service's events the other: the calendar's own chats
 *   Hub /calendar/*                        -> <url>/*, proxied (hub calendar.ts)
 *   Hub holds <url>/api/stream and asks GET <url>/api/chat/plans?since=<ms> -> CalendarPlans
 *   Chat web POST /calendar/api/proposals/:id/accept|dismiss {} -> the calendar's ProposalView
 *
 * Reminders are messages in the calendar's chat, marked with `extra.reminder` (CalendarReminderRef): triage makes them
 * alerts (docs/calendar.md "Reminders").
 */

/** Where a calendar account looks when it is given no address: dither-calendar on this machine. */
export const CALENDAR_URL_DEFAULT = 'http://127.0.0.1:8470';

/** A calendar account's config (account.config): the service's address, http(s), no trailing slash. */
export interface CalendarAccountConfig {
  url: string;
}

/** The service's address from a config, or null when it is not an http(s) URL. */
export function calendarAccountUrl(config: unknown): string | null {
  const url = (config as Partial<CalendarAccountConfig> | null)?.url;
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * `extra.reminder` on a message: this message is a reminder of an event, for you. Triage makes it an alert (held quiet
 * in quiet hours, and left out of their summary), and device rules on its network keep it off a device. Title, time and
 * place are in the body; never a description or anything from a chat.
 */
export interface CalendarReminderRef {
  /** Stable per (occurrence, start, lead): `${eventKey}|${startAt ?? startDate}|${minutes}`. */
  id: string;
  eventKey: string;
  /** Calendar hash to open, e.g. "#/day/2026-11-14". */
  open: string;
  meetingUrl: string | null;
  /** Sent after its time (a restart, or the event moved closer). */
  late: boolean;
}

/** A message's reminder, from its extra (stored as JSON or already parsed), or null. */
export function reminderOf(extra: unknown): CalendarReminderRef | null {
  let x = extra;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  const r = (x as { reminder?: Partial<CalendarReminderRef> } | null)?.reminder;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.eventKey !== 'string' || typeof r.open !== 'string') return null;
  return { id: r.id, eventKey: r.eventKey, open: r.open, meetingUrl: typeof r.meetingUrl === 'string' ? r.meetingUrl : null, late: r.late === true };
}

/** A plan a chat made, as the calendar sees it (its proposal, and the event it became). */
export interface CalendarPlanView {
  id: string; // proposal id
  conversationId: string;
  /** The message that named the time (proposal.origin_message_id, else message_id): the chip goes under it. */
  messageId: string;
  /** The newest message when the plan was last read (ProposalView.messageId). */
  lastMessageId: string;
  title: string;
  location: string | null;
  allDay: boolean;
  startAt: number | null;
  endAt: number | null;
  startDate: string | null;
  endDate: string | null;
  timeZone: string;
  state: 'suggested' | 'added' | 'dismissed' | 'cancelled';
  change: 'moved' | 'cancelled' | null;
  verdict: 'auto' | 'suggest';
  /** The calendar event while it is on the calendar, with its time as it stands now. */
  event: {
    id: string;
    title: string;
    allDay: boolean;
    startAt: number | null;
    endAt: number | null;
    startDate: string | null;
    endDate: string | null;
    location: string | null;
    calendarName: string;
    color: string;
  } | null;
  /** Calendar hash where it shows: "#/day/2026-11-14" (the chats page "#/chats" while suggested). */
  open: string;
  updatedAt: number;
}

/** The calendar's GET /api/chat/plans?since=<ms>&conversationId=<id>: newest first, at most 1000. */
export interface CalendarPlans {
  now: number;
  /** Proposals waiting for you, as the calendar's State.waiting. */
  waiting: number;
  plans: CalendarPlanView[];
}

/** In the bootstrap of a hub with a calendar (absent without one). */
export interface CalendarLinkView {
  path: '/calendar/';
  reachable: boolean;
  waiting: number;
}

/** The hub's GET /api/plans, from its cache. Includes dismissed plans, so a client can drop them. 404 when the calendar is off. */
export interface PlansView {
  plans: CalendarPlanView[];
  reachable: boolean;
  waiting: number;
}

/** What a notification about a reminder carries (the notify event, the push), to open the calendar there. */
export interface CalendarNotifyRef {
  open: string;
  eventKey: string;
  reminderId: string;
  meetingUrl: string | null;
}

/** The answer to accept and dismiss (the calendar's ProposalView): the fields the chip reads. */
export interface CalendarProposalAnswer {
  id: string;
  state: CalendarPlanView['state'];
  change: CalendarPlanView['change'];
  title: string;
  allDay: boolean;
  startAt: number | null;
  endAt: number | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  updatedAt: number;
}

/**
 * A network's scheduled event (a Discord server's), as dither-calendar may read it: the hub's
 * GET /api/calendar/network-events?since=<ms> (loopback, like the rest of its API; docs/servers.md). Times as a plan's.
 * Not read by dither-calendar yet: shaped for it, and to be added on its side together with this.
 */
export interface NetworkEventEntry {
  /** The hub's event id: stable across edits. */
  key: string;
  network: string;
  title: string; // <= 200 chars, "(No title)" if empty
  description: string | null;
  location: string | null; // "Voice channel · Server", or the place outside, <= 200 chars
  allDay: false;
  startAt: number;
  endAt: number | null;
  timeZone: 'UTC';
  /** RFC 5545 RRULE body ("FREQ=WEEKLY;BYDAY=TU"), or null for once. */
  rrule: string | null;
  /** Occurrences called off: their original starts (EXDATE). */
  exdates: number[];
  /** Occurrences moved: original start (RECURRENCE-ID) to the new time. */
  moved: { original: number; startAt: number; endAt: number | null }[];
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  /** You said Interested (null: not known). */
  interested: boolean | null;
  /** The space's name. */
  place: string;
  spaceId: string;
  /** Opens it in the network's own app. */
  open: string | null;
  updatedAt: number;
}

/** GET /api/calendar/network-events?since=<ms>: the events changed since then (0: all), soonest first. */
export interface NetworkEvents {
  now: number;
  events: NetworkEventEntry[];
}
