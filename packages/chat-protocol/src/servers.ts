/**
 * Servers: what a community has beyond its channels (docs/servers.md). Its scheduled events and your answer to them,
 * leaving it, its invite links, and what it asks of you on joining (rules to agree to, an application, onboarding).
 *
 * Adapter side: the facts and commands below, each behind its own capability (adapter.ts): 'events', 'rsvp', 'leave',
 * 'gates', 'inviteLinks', 'nick'. Hub side: the views at the end, from GET /api/spaces/:id/events and friends.
 */
import type { MediaUrl } from './adapter.ts';
import type { Network } from './ontology.ts';

// ---------------------------------------------------------------- scheduled events

/** scheduled: not started; active: on now; completed: over; cancelled: called off. */
export type EventStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

/** Where it happens: one of the server's voice or stage channels, or a place outside it (words, often a link). */
export type EventPlace = { kind: 'voice' | 'stage'; conversation: string } | { kind: 'external'; location: string };

/** One occurrence of a repeating event that differs from the rule: moved, or called off. */
export interface EventException {
  /** The network's id for the change (Discord: a snowflake of the occurrence's original start). */
  nativeId: string;
  /** ms epoch: when this occurrence would have started by the rule (the calendar's RECURRENCE-ID). */
  original: number;
  /** Moved to, when moved. */
  start?: number;
  end?: number;
  cancelled?: boolean;
  /** This account's own answer to this occurrence, when it differs from the series'. */
  youInterested?: boolean;
}

export interface ScheduledEventFact {
  nativeId: string;
  /** The space (a Discord guild) it belongs to. */
  space: string;
  name: string;
  description?: string;
  /** ms epoch. For a repeating event, its first occurrence (or the next, as the network keeps it). */
  start: number;
  end?: number;
  status: EventStatus;
  place?: EventPlace;
  /** Its cover picture. */
  imageUrl?: MediaUrl;
  /** How many said they are interested, when the network said. */
  interested?: number;
  /** This account said it is interested (the series). Absent: not known yet. */
  youInterested?: boolean;
  /** Native identity id of who made it (its identity fact comes first). */
  creator?: string;
  /** RFC 5545 rule without the "RRULE:" prefix ("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU"); absent: once. Times are UTC. */
  rrule?: string;
  exceptions?: EventException[];
}

/** The `scheduledEvents` command's reply: the space's events as the network has them now, counts and answers included. */
export interface ScheduledEventsResult {
  events: ScheduledEventFact[];
}

// ---------------------------------------------------------------- leaving

/** Leaving a conversation or space, as this account may (About.leaving). */
export interface AboutLeaving {
  can: boolean;
  /** Why not ("You own this server: give it to someone else in Discord first"), in words. */
  reason?: string;
  /** What happens, worth a line in the confirm ("You own this group: Discord makes someone else its owner"). */
  warning?: string;
  /** The network can leave without telling the others (Discord group DMs). */
  silent?: boolean;
  /**
   * You are its only admin and others are in it: the network wants someone made admin as you leave (Signal's
   * `quitGroup --admin`). The app asks whom, from its members, before leaving.
   */
  needsAdmin?: boolean;
  /** This device can also forget the group's data as it leaves (Signal's `--delete`), on a confirm of its own. */
  canForget?: boolean;
}

/** What `leave` answers. The adapter has emitted the leave event first. */
export interface LeaveResult {
  left: boolean;
}

// ---------------------------------------------------------------- invite links

/** One invite link, as the network lists it. */
export interface InviteLinkFact {
  code: string;
  url: string;
  /** Native conversation id it leads to. */
  conversation?: string;
  /** Native identity id of who made it. */
  inviter?: string;
  uses?: number;
  /** 0: no limit. */
  maxUses?: number;
  /** ms epoch; absent: never. */
  expiresAt?: number;
  /** Members who join with it are removed when they go offline, unless given a role (Discord). */
  temporary?: boolean;
  /** This account may turn it off. */
  canRevoke?: boolean;
}

/** The choices the network's own invite dialog offers, and its defaults (Discord: 7 days, no limit). */
export interface InviteOptions {
  /** Seconds; 0: never. */
  maxAge: number[];
  /** 0: no limit. */
  maxUses: number[];
  defaults: { maxAge: number; maxUses: number };
}

/** Discord's own invite dialog: expire after 30 minutes to never, 1 to 100 uses or no limit. */
export const DISCORD_INVITE_OPTIONS: InviteOptions = {
  maxAge: [1800, 3600, 6 * 3600, 12 * 3600, 86400, 7 * 86400, 0],
  maxUses: [0, 1, 5, 10, 25, 50, 100],
  defaults: { maxAge: 7 * 86400, maxUses: 0 },
};

/** "7 days", "Never", "No limit", "1 use". */
export const inviteAgeLabel = (s: number) => (!s ? 'Never' : s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : `${Math.round(s / 60)} minutes`);
export const inviteUsesLabel = (n: number) => (!n ? 'No limit' : `${n} use${n === 1 ? '' : 's'}`);

// ---------------------------------------------------------------- nickname

/** Discord's limit on a server nickname. */
export const NICK_MAX = 32;

/** What is wrong with a nickname before anything is sent; null when it may go ('' clears it). */
export function nickProblem(nick: unknown, max = NICK_MAX): string | null {
  if (typeof nick !== 'string') return 'A nickname is text';
  if ([...nick.trim()].length > max) return `A nickname is at most ${max} characters`;
  return null;
}

// ---------------------------------------------------------------- gates

/** A question an application asks (Discord's membership screening form). */
export interface GateQuestion {
  /** Its place in the form, as a string ("0", "1", ...). */
  id: string;
  kind: 'text' | 'paragraph' | 'choice';
  label: string;
  description?: string;
  required: boolean;
  choices?: string[];
}

/** One onboarding question: pick channels or roles. */
export interface GatePrompt {
  id: string;
  title: string;
  /** Only one option may be picked. */
  single: boolean;
  required: boolean;
  options: { id: string; title: string; description?: string; emoji?: string }[];
}

/**
 * What a space asks of you before (or right after) you are in, one step at a time:
 * - rules: agree to its rules (Discord's membership screening). The owner reads them and clicks; never answered for them.
 * - apply: answer its questions; a moderator then lets you in or not (Discord's join requests).
 * - onboarding: pick what you want to see (channels, roles), as its onboarding asks.
 */
export interface SpaceGate {
  space: string;
  kind: 'rules' | 'apply' | 'onboarding';
  description?: string;
  /** rules (and an application that has them too): the rules, one per line, as written. */
  rules?: string[];
  questions?: GateQuestion[];
  prompts?: GatePrompt[];
  /** apply: where the application stands. open: not sent yet. */
  status?: 'open' | 'submitted' | 'approved' | 'rejected';
  /** rejected: the moderator's reason, when they gave one. */
  reason?: string;
  /** The form's version, sent back with the answer (Discord). */
  version?: string;
}

/** The owner's answer to a gate. agree: they read and agree to the rules. answers: by question id. picks: option ids. */
export interface GateAnswer {
  kind: SpaceGate['kind'];
  agree?: boolean;
  answers?: Record<string, string | number>;
  picks?: string[];
}

/** What `answerGate` answers. */
export interface GateResult {
  /** The gate is passed (rules, onboarding), or the application is in (apply: see status). */
  done: boolean;
  status?: SpaceGate['status'];
  /** What it asks next, when it asks more (onboarding after the rules). */
  next?: SpaceGate | null;
}

/** What is wrong with an answer before anything is sent, in words; null when it may go. */
export function gateAnswerProblem(gate: SpaceGate, a: GateAnswer): string | null {
  if (!a || a.kind !== gate.kind) return 'That answers another question: look again';
  if (gate.kind === 'rules' && a.agree !== true) return 'Agreeing to the rules is yours to do: tick that you agree';
  if (gate.kind === 'apply') {
    if (gate.rules?.length && a.agree !== true) return 'Agreeing to the rules is yours to do: tick that you agree';
    for (const q of gate.questions ?? []) {
      const v = a.answers?.[q.id];
      const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
      if (q.required && empty) return `Answer "${q.label}"`;
      if (!empty && q.kind === 'choice' && !(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < (q.choices?.length ?? 0))) return `Pick one of the answers to "${q.label}"`;
      if (!empty && q.kind !== 'choice' && typeof v !== 'string') return `"${q.label}" wants words`;
    }
  }
  if (gate.kind === 'onboarding') {
    const picks = new Set(a.picks ?? []);
    for (const p of gate.prompts ?? []) {
      const mine = p.options.filter((o) => picks.has(o.id)).length;
      if (p.required && !mine) return `Pick something for "${p.title}"`;
      if (p.single && mine > 1) return `Pick only one for "${p.title}"`;
    }
    const known = new Set((gate.prompts ?? []).flatMap((p) => p.options.map((o) => o.id)));
    if ([...picks].some((x) => !known.has(x))) return 'That is not one of the choices: look again';
  }
  return null;
}

// ---------------------------------------------------------------- hub views

/** A scheduled event, in hub ids. */
export interface ScheduledEventView {
  /** hubId('evt', network, nativeId) */
  id: string;
  nativeId: string;
  network: Network;
  spaceId: string;
  name: string;
  description: string | null;
  start: number;
  end: number | null;
  status: EventStatus;
  place: { kind: 'voice' | 'stage'; conversationId: string } | { kind: 'external'; location: string } | null;
  /** The hub's URL for its picture. */
  image: string | null;
  interested: number | null;
  youInterested: boolean | null;
  creatorId: string | null;
  rrule: string | null;
  exceptions: EventException[];
  /** The account whose view this is (each says its own interest). */
  accountId: string;
  /** Opens it in the network's own app. */
  url: string | null;
  updatedAt: number;
}

/** GET /api/spaces/:id/events: newest first among those still to come, then the rest. */
export interface SpaceEventsView {
  events: ScheduledEventView[];
  /** The account whose view this is can say Interested here. */
  canRsvp: boolean;
  accountId: string | null;
  /** Why the list may be old (the account is not connected), when it may. */
  stale?: string;
}

/** GET/POST /api/spaces/:id/gate and /api/spaces/:id/gate: what it asks, in hub terms. */
export interface SpaceGateView {
  gate: SpaceGate | null;
  accountId: string | null;
  /** The account cannot answer from here (no 'gates'): open the live view instead. */
  reason?: string;
}

/** POST /api/(spaces|conversations)/:id/leave { accountId?, silent? } */
export interface LeaveRequest {
  accountId?: string;
  silent?: boolean;
  /** Who becomes admin as you leave (AboutLeaving.needsAdmin): hub identity ids. */
  admins?: string[];
  /** Also forget the group's data on this device (AboutLeaving.canForget), confirmed on its own. */
  forget?: boolean;
}
