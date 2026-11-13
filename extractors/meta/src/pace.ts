/**
 * Commands at a person's pace: one at a time, a gap of minGapMs plus up to jitterMs between them, and more before a
 * longer text (the time it would take to type, capped). A refusal that says to wait (retryAfter, in seconds) holds
 * everything after it until then.
 */
export class PaceQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private penaltyUntil = 0;

  constructor(
    private opts: { minGapMs: number; jitterMs: number; log?: (m: string, d?: unknown) => void; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number },
  ) {}

  run<T>(label: string, fn: () => Promise<T>, extraDelayMs = 0): Promise<T> {
    const sleep = this.opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    const now = this.opts.now ?? Date.now;
    const random = this.opts.random ?? Math.random;
    const task = this.chain.then(async () => {
      const base = this.opts.minGapMs + random() * this.opts.jitterMs + extraDelayMs;
      const wait = Math.max(this.last + base - now(), this.penaltyUntil - now(), 0);
      if (wait > 0) await sleep(wait);
      this.last = now();
      try {
        return await fn();
      } catch (e: any) {
        const retry = Number(e?.retry_after ?? e?.retryAfter);
        if (retry > 0) {
          this.penaltyUntil = now() + retry * 1000 + 500;
          this.opts.log?.(`asked to wait on ${label}`, { retryAfterMs: retry * 1000 });
        }
        throw e;
      }
    });
    this.chain = task.catch(() => undefined);
    return task as Promise<T>;
  }
}

/** How long a person takes to type this much, roughly, capped at four seconds. */
export const typingTime = (text: string) => Math.min(4000, Math.round(text.length * 30));
