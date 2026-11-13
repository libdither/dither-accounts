/**
 * Polls and pins (docs/polls.md): one model of a poll for every network, how its votes come in, and the commands to
 * vote, make one and end one early; and the pin durations a network offers.
 *
 * A poll is structured data on its message: MessageFact.extra.poll (PollFact), as the network said it when the message
 * came. Votes after that come as `pollUpdate` events: the counts as the network now says them (Discord), or one
 * voter's whole vote (Signal, whose apps show who voted for what to every member; the hub keeps the latest of each
 * voter's votes by its number, as Signal's apps do). Who voted is kept only where the network's own client shows it
 * to every member: Discord shows voters only on a click that asks for them, so no Discord voter is ever asked for.
 *
 * All additive: an adapter says what it has with a capability, and the hub and the web offer it only then.
 */
import type { Network } from './ontology.ts';

export type PollCapability =
  /** Reads polls: extra.poll on messages and `pollUpdate` events as votes come. */
  | 'polls'
  /** Votes in a poll, and takes a vote back (the `pollVote` command). */
  | 'pollVote'
  /** Makes a poll (the `pollCreate` command), as POLL_RULES says for its network. */
  | 'pollCreate'
  /** Ends a poll you made before its time (the `pollEnd` command). */
  | 'pollEnd'
  /** Pins and unpins messages (`configure` with a `pin` change), where the About's `pinned.canEdit` says it may. */
  | 'pin';

export interface PollOptionFact {
  /** The network's id for it (Discord's answer id; Signal's index as a string). */
  id: string;
  text: string;
  /** A Unicode emoji, or a custom one as body Markdown (`<:name:id>`). */
  emoji?: string;
}

/** A poll as its message carries it: MessageFact.extra.poll. */
export interface PollFact {
  question: string;
  options: PollOptionFact[];
  /** More than one option may be chosen. */
  multi?: boolean;
  /** When voting closes by itself (ms epoch); absent: it stays open until its author ends it. */
  expires?: number;
  /** Closed: by its time, or ended early by its author. */
  ended?: boolean;
  /** Votes per option id, as the network said them; absent when it said none. */
  counts?: Record<string, number>;
  /** How many people voted, when the network says. */
  voters?: number;
  /** The options this account voted for. */
  mine?: string[];
}

/** One voter's whole vote: the options they hold now ([] took it back). `seq`: Signal's vote count; the highest wins. */
export interface PollVoteFact {
  voter: string;
  options: string[];
  seq: number;
  ts?: number;
}

/**
 * The `pollUpdate` event (capability 'polls'). Every part is optional and says only what changed:
 * - counts: votes per option as the network now says them, replacing what the hub had (mine and voters with them);
 * - add: votes to add (or, negative, take away) per option, when the network says only that one changed;
 * - mine alone (no counts, no add): your own vote changed to these options, and the hub moves the counts by the
 *   difference (a vote you just made, before the network counts it);
 * - vote: one voter's whole vote (Signal), tallied by the hub;
 * - ended: the poll closed.
 */
export interface PollUpdate {
  conversation: string;
  message: string;
  counts?: Record<string, number>;
  add?: Record<string, number>;
  voters?: number;
  mine?: string[];
  vote?: PollVoteFact;
  ended?: boolean;
  ts?: number;
}

/** A poll to make. `hours`: how long it stays open, one of POLL_RULES' choices, where the network has them. */
export interface PollDraft {
  question: string;
  options: string[];
  multi: boolean;
  hours?: number;
}

export type PollCommand =
  /**
   * Vote in a poll, replacing your vote; [] takes it back (capability 'pollVote'). `seq`: your last vote's number on
   * this poll as the hub saw it (Signal), so the next one is higher. Refused in a message request. reply.result: {}.
   */
  | { t: 'pollVote'; id: string; conversation: string; message: string; options: string[]; seq?: number }
  /** Make a poll (capability 'pollCreate'), checked against pollDraftProblem. reply.result: { nativeId?: string }. */
  | { t: 'pollCreate'; id: string; conversation: string; poll: PollDraft }
  /** End a poll you made before its time (capability 'pollEnd'). reply.result: {}. */
  | { t: 'pollEnd'; id: string; conversation: string; message: string };

export interface PollRules {
  minOptions: number;
  maxOptions: number;
  questionMax: number;
  optionMax: number;
  /** How long a poll may stay open, in hours, as the network's own client offers; absent: it has no timer. */
  hours?: number[];
  defaultHours?: number;
}

/** What each network lets a poll be. Networks without polls are absent. */
export const POLL_RULES: Partial<Record<Network, PollRules>> = {
  discord: { minOptions: 2, maxOptions: 10, questionMax: 300, optionMax: 55, hours: [1, 4, 8, 24, 72, 168], defaultHours: 24 },
  signal: { minOptions: 2, maxOptions: 10, questionMax: 200, optionMax: 150 },
};

/** Why this poll cannot be made on this network, or null. */
export function pollDraftProblem(network: Network, d: PollDraft): string | null {
  const r = POLL_RULES[network];
  if (!r) return 'This network has no polls';
  if (!d || typeof d.question !== 'string' || !d.question.trim()) return 'A poll needs a question';
  if ([...d.question.trim()].length > r.questionMax) return `A question is at most ${r.questionMax} characters here`;
  if (!Array.isArray(d.options)) return 'A poll needs options';
  const opts = d.options.map((o) => (typeof o === 'string' ? o.trim() : ''));
  if (opts.some((o) => !o)) return 'An option is empty';
  if (opts.length < Math.max(2, r.minOptions)) return 'A poll needs at least 2 options';
  if (opts.length > r.maxOptions) return `A poll has at most ${r.maxOptions} options`;
  if (opts.some((o) => [...o].length > r.optionMax)) return `An option is at most ${r.optionMax} characters here`;
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return 'Two options say the same';
  if (typeof d.multi !== 'boolean') return 'single or multiple choice?';
  if (d.hours !== undefined && !r.hours?.includes(d.hours)) return r.hours ? 'Not one of the durations this network offers' : 'Polls here have no timer';
  return null;
}

/** "1 hour", "3 days", "1 week". */
export function pollHoursLabel(h: number): string {
  if (h % 168 === 0) return `${h / 168} week${h === 168 ? '' : 's'}`;
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * How long a pin lasts, in seconds (null: until unpinned), as each network's own client offers it; the first is its
 * default. Networks whose pins have no timer are absent. The `pin` change's `seconds` is one of these.
 */
export const PIN_DURATIONS: Partial<Record<Network, (number | null)[]>> = {
  signal: [24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null],
};

// ---------------------------------------------------------------- views (MessageView.poll)

export interface PollOptionView extends PollOptionFact {
  count: number;
  /** You voted for it. */
  mine: boolean;
  /** Who voted for it, by hub identity id: only where the network shows voters to every member (Signal). */
  voters?: string[];
}

export interface PollView {
  question: string;
  options: PollOptionView[];
  multi: boolean;
  expires: number | null;
  ended: boolean;
  /** People who voted, when known; else null (the web then shows the votes' sum). */
  voters: number | null;
  /** Whether any counts are known at all (a poll heard of before its first count says so). */
  counted: boolean;
  /** Your last vote's number on this poll, for the next `pollVote` (Signal). */
  seq?: number;
}

/** A vote's options as the network's choice rule allows: one at most unless `multi`, each an option of the poll. */
export function pollVoteProblem(poll: Pick<PollView, 'options' | 'multi' | 'ended'>, options: string[]): string | null {
  if (poll.ended) return 'This poll has ended';
  if (!Array.isArray(options) || options.some((o) => typeof o !== 'string')) return 'which options?';
  if (new Set(options).size !== options.length) return 'An option is chosen twice';
  if (!poll.multi && options.length > 1) return 'This poll takes one choice';
  const ids = new Set(poll.options.map((o) => o.id));
  if (options.some((o) => !ids.has(o))) return 'Not an option of this poll';
  return null;
}
