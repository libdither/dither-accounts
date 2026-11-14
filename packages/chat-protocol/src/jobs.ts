/**
 * Index jobs and network search (docs/indexing.md).
 *
 * An index job fetches a place whole through your accounts: every channel's history back to its start, its
 * members, or both, for one server, a folder of servers, or one conversation. Jobs are paced per account, carry on
 * after a restart, and may repeat, when a run after the first fetches only what is new since.
 *
 * Network search asks the networks' own search (Discord's, Matrix's) for what the hub has not stored, a few places
 * at a time in the order jev ranks them, and keeps what it finds.
 */
import type { IdentityView, SearchHit } from './api.ts';
import type { Network } from './ontology.ts';

export type JobTargetKind = 'space' | 'folder' | 'conversation';
export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'failed';

/** POST /api/jobs */
export interface JobSpec {
  target: { kind: JobTargetKind; id: string };
  /** Every channel and thread back to its start. */
  history: boolean;
  /** The member list, walked by name. */
  members: boolean;
  /** Run again this long after a run ends; null or absent: once. */
  repeatHours?: number | null;
  /** Higher goes first when two jobs want the same account. */
  priority?: JobPriority;
}

export type JobPriority = 'low' | 'normal' | 'high';
export const JOB_PRIORITIES: JobPriority[] = ['low', 'normal', 'high'];
/** What the job page offers for repeating, in hours. */
export const JOB_REPEATS: { hours: number | null; label: string }[] = [
  { hours: null, label: 'Once' },
  { hours: 24, label: 'Daily' },
  { hours: 168, label: 'Weekly' },
];

export interface JobView {
  id: string;
  target: { kind: JobTargetKind; id: string; name: string; network: Network | null };
  history: boolean;
  members: boolean;
  priority: JobPriority;
  repeatHours: number | null;
  state: JobState;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** A repeating job's next run, while it waits. */
  nextRunAt: number | null;
  /** Conversations to page and spaces to walk, in this run. */
  tasks: number;
  done: number;
  failed: number;
  pages: number;
  /** Messages the hub did not have before. */
  fetched: number;
  /** Members listed by the walk. */
  membersListed: number;
  /** What it is on now: a conversation's or space's name. */
  current: string | null;
  /** Places it could not reach: no account of yours with the capability, or none online. */
  skipped: number;
  error: string | null;
  /**
   * Waiting on the reading pace (docs/indexing.md "Reading pace") rather than working: out of the account's hours,
   * its messages for the day read, or a break between sessions. Null while it reads.
   */
  resting?: { until: number; why: 'hours' | 'cap' | 'break' } | null;
}

/** One place a network search asks, in the order it asks them. */
export interface NetSearchPlace {
  /** 'all': everything one account sees, where the network searches that in one request (Matrix). */
  kind: 'space' | 'conversation' | 'all';
  id: string;
  name: string;
  network: Network;
  accountId: string;
  /** jev's P(yes) that the place talks about the query; null when jev was not asked or did not answer. */
  score: number | null;
  state: 'queued' | 'searching' | 'done' | 'failed';
  /** What the network says matches there in all. */
  total: number | null;
  /** Hits brought back so far. */
  found: number;
  /** Of those, messages the hub did not have. */
  fresh: number;
  error: string | null;
}

/** POST /api/search/network starts one; GET /api/search/network/:id follows it. */
export interface NetSearchView {
  id: string;
  query: string;
  running: boolean;
  /** How the places were put in order. */
  ranked: 'jev' | 'keyword' | 'local';
  places: NetSearchPlace[];
  /** Places that could be asked but are not yet: POST …/more asks the next few. */
  left: number;
  /** Newest first, each once. */
  hits: SearchHit[];
  identities: IdentityView[];
  /** Why nothing can be asked: no account with network search, or none online. */
  note: string | null;
}
