/**
 * A caller's memory of failed reads (docs/manager.md, "A failed read is remembered"), so that a caller that asks again
 * on every poll, watch or page open does not ask the manager again for an answer it already has. Pure: no I/O, a clock
 * passed in. The client uses it (packages/client, `remember`); an extractor's own background polls can too.
 *
 * Keyed by the call: account, op, and the input's identity (its JSON with keys sorted). Each key keeps the last
 * failure, its kind (FailureKind) and how many failed in a row, and when it may be asked again:
 *
 * - `transient`: after a back-off, 5 s doubling to 5 min, and never before the failure's `retryAfterMs`;
 * - `bug`, or no kind (nobody knows): the same, 1 min doubling to 30 min. It will not mend by waiting, but a deploy or
 *   a restart can mend it;
 * - `expected`: kept until something relevant changes, and at most 10 min (a change the caller cannot see).
 *
 * Until then a repeat is answered from memory (`check`) and counted as asked again while remembered, not sent, so the
 * manager's trace and bugwatch count distinct asks, not the caller's loop. What invalidates an entry (`forget`): a
 * success of the same call; the account's state changing (online, running, enabled, its grants: the client watches its
 * accounts); a write the caller made to the account (it may change what the read answers); the caller saying so (a
 * person asked to refresh). A different input is a different key: a new sync token is asked at once.
 *
 * Bounded: at most `max` keys (500), the oldest failure dropped first.
 */
import { type CallError, type FailureKind, failureKindOf, retryAfterOf } from './index.ts';

export interface MemoryOpts {
  /** Keys kept at most (500). */
  max?: number;
  /** A transient failure's first wait and the most it grows to, ms (5 s, 5 min). */
  transientMs?: [number, number];
  /** A bug's (or a failure of no known kind) first wait and the most it grows to, ms (1 min, 30 min). */
  bugMs?: [number, number];
  /** How long an expected failure is kept at most, ms (10 min). */
  expectedMs?: number;
  now?: () => number;
}

export interface Remembered {
  account: string;
  op: string;
  error: CallError;
  kind: FailureKind | undefined;
  /** When it failed last. */
  at: number;
  /** When the call may be sent again. */
  dueAt: number;
  /** Failures in a row (sent and failed), since the last success or forget. */
  failures: number;
  /** Times it was asked again while remembered, since it last failed. */
  repeats: number;
}

export const MEMORY_DEFAULTS = { max: 500, transientMs: [5_000, 300_000] as [number, number], bugMs: [60_000, 1_800_000] as [number, number], expectedMs: 600_000 };

/** The input's identity: its JSON with object keys sorted, so `{a, b}` and `{b, a}` are one call. */
export function inputKey(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(norm(v ?? {})) ?? '';
}

export class FailureMemory {
  private entries = new Map<string, Remembered>();
  /** Asked again while remembered, of entries since forgotten or sent again: kept for `stats`. */
  private repeatsDone = 0;
  private o: Required<Omit<MemoryOpts, 'now'>> & { now: () => number };

  constructor(o: MemoryOpts = {}) {
    this.o = { ...MEMORY_DEFAULTS, ...o, now: o.now ?? Date.now };
  }

  key(account: string, op: string, input: unknown): string {
    return `${account}\0${op}\0${inputKey(input)}`;
  }

  /**
   * A call about to be sent: its remembered failure when it is not due yet (then the caller answers with it and does
   * not send; counted as a repeat), else null. A due entry stays, so that another failure backs off further; its
   * repeats come back in `take` to go out with the call.
   */
  check(key: string): Remembered | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.o.now() >= e.dueAt) return null;
    e.repeats++;
    return e;
  }

  /** How long until a remembered call may be sent again, ms (0 when due). */
  dueInMs(e: Remembered): number {
    return Math.max(0, e.dueAt - this.o.now());
  }

  /** The repeats since this call last went out, to be sent with it (the manager puts them on the call's span); then 0. */
  take(key: string): number {
    const e = this.entries.get(key);
    if (!e || !e.repeats) return 0;
    const n = e.repeats;
    this.repeatsDone += n;
    e.repeats = 0;
    return n;
  }

  /** The call failed with this answer from the manager: remember it, backing off further when it failed before. */
  failed(key: string, account: string, op: string, error: CallError) {
    const now = this.o.now();
    const kind = failureKindOf(error);
    const was = this.entries.get(key);
    const failures = (was?.failures ?? 0) + 1;
    let wait: number;
    if (kind === 'expected') wait = this.o.expectedMs;
    else {
      const [first, most] = kind === 'transient' ? this.o.transientMs : this.o.bugMs;
      wait = Math.min(most, first * 2 ** Math.min(30, failures - 1));
    }
    wait = Math.max(wait, retryAfterOf(error.retryAfterMs) ?? 0);
    this.entries.delete(key);
    this.entries.set(key, { account, op, error, kind, at: now, dueAt: now + wait, failures, repeats: was?.repeats ?? 0 });
    while (this.entries.size > this.o.max) this.drop(this.entries.keys().next().value!);
  }

  /** The call answered: nothing to remember. */
  succeeded(key: string) {
    this.drop(key);
  }

  /** Forget an account's failures (all, or one op's), or every account's: something relevant changed. */
  forget(account?: string, op?: string) {
    for (const [k, e] of this.entries) if ((account === undefined || e.account === account) && (op === undefined || e.op === op)) this.drop(k);
  }

  private drop(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.repeatsDone += e.repeats;
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** How many calls are remembered, and how many repeats it answered (of those still remembered, and in all). */
  stats(): { remembered: number; repeats: number; repeatsWaiting: number } {
    let waiting = 0;
    for (const e of this.entries.values()) waiting += e.repeats;
    return { remembered: this.entries.size, repeats: this.repeatsDone + waiting, repeatsWaiting: waiting };
  }
}
