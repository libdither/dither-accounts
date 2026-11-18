/**
 * When a silent page's tab is reloaded. Two unanswered requests in a row ask for a reload (main.ts); this says whether
 * one is made now:
 *
 * - Backing off: after a reload, the next one waits RELOAD_FIRST_GAP_MS, then twice that after each further one that
 *   brought no answer, up to RELOAD_MAX_GAP_MS between them. An answer from the page starts it over. (Seen live: a
 *   Calendar tab reloaded about 17 times, every 30 s or so, while it never came back; each reload only set it loading
 *   again.)
 * - A tab still loading is not reloaded (reloading only starts it over), up to LOADING_DEFERS times in a row; a tab
 *   that has been loading through that many silences is stuck there, and is reloaded.
 */
export const RELOAD_FIRST_GAP_MS = 60_000;
export const RELOAD_MAX_GAP_MS = 10 * 60_000;
export const LOADING_DEFERS = 3;

export type ReloadDecision = { go: true } | { go: false; why: string };

export class ReloadPolicy {
  /** Reloads since the page last answered. */
  streak = 0;
  /** No reload before this. */
  nextAt = 0;
  /** Reloads put off in a row because the tab was loading. */
  deferred = 0;

  /** `firstGapMs`: RELOAD_FIRST_GAP_MS but in tests. */
  constructor(readonly firstGapMs = RELOAD_FIRST_GAP_MS) {}

  /** The gap after the `n`th reload in a row. */
  gap(n: number): number {
    return Math.min(this.firstGapMs * 2 ** Math.max(0, n - 1), RELOAD_MAX_GAP_MS);
  }

  /** Whether to reload now; `loading`: the tab is loading as Chromium sees it (null when the worker did not say). */
  decide(now: number, loading: boolean | null): ReloadDecision {
    if (now < this.nextAt) return { go: false, why: `backing off after ${this.streak} reload${this.streak === 1 ? '' : 's'} that brought no answer, until ${new Date(this.nextAt).toISOString().slice(11, 19)} UTC` };
    if (loading === false) this.deferred = 0;
    if (loading && this.deferred < LOADING_DEFERS) {
      this.deferred++;
      return { go: false, why: 'its tab is still loading' };
    }
    return { go: true };
  }

  /** A reload was made now. */
  reloaded(now: number) {
    this.streak++;
    this.deferred = 0;
    this.nextAt = now + this.gap(this.streak);
  }

  /** The page answered: the next silence may reload at once. */
  answered() {
    this.streak = 0;
    this.nextAt = 0;
    this.deferred = 0;
  }
}
