/**
 * dither-calendar beside the hub (docs/calendar.md). The wire between the two: dither-calendar defines the same types,
 * with the same names, in its shared/types.ts. Change one side only together with the other.
 *
 *   Hub /calendar/*                        -> the calendar, proxied (hub calendar.ts)
 *   Calendar POST /api/calendar/notify     ReminderNotice -> ReminderResult   (loopback, no Origin)
 *   Hub holds the calendar's GET /api/stream and asks GET /api/chat/plans?since=<ms> -> CalendarPlans
 *   Chat web POST /calendar/api/proposals/:id/accept|dismiss {} -> the calendar's ProposalView
 */

/** One reminder for one occurrence. Title, time and place only: never a description or message text. */
export interface ReminderNotice {
  /** Stable and unique per (occurrence, start, lead); the hub drops a repeat id (it is the retry key). */
  id: string; // `${eventKey}|${startAt ?? startDate}|${minutes}`
  eventKey: string; // EventView.key
  title: string; // event title, ≤ 200 chars, "(No title)" if empty
  allDay: boolean;
  startAt: number | null;
  endAt: number | null;
  startDate: string | null; // YYYY-MM-DD
  timeZone: string; // the calendar Settings zone the text below was written in
  location: string | null; // ≤ 200 chars
  /** Written by the calendar: "in 10 min · 14:00–14:30", "tomorrow · all day". The hub never formats times. */
  when: string;
  minutesBefore: number;
  /** Sent after its time (a restart, or the event was moved closer). */
  late: boolean;
  /** Calendar hash to open, e.g. "#/day/2026-11-14". */
  open: string;
  /** Video link (hangoutLink, conferenceData video entry point, or a URL location), or null. */
  meetingUrl: string | null;
}

export type ReminderResult = { ok: true; duplicate?: true; tier: 'push' | 'quiet'; devices: number; accepted: number } | { ok: false; error: string };

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
