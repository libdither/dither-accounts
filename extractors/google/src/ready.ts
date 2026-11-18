/**
 * Waiting for a page to be ready, instead of refusing at once. At start, an op can come before the Gmail page is
 * open, signed in and has made its first sync call (each of which the extractor hears from the page); it waits for
 * that, up to a bound, and only then refuses. `changed()` is called whenever something a check reads may have changed
 * (every frame from the extension, a connect or a disconnect): there is no polling.
 */
export class Readiness {
  private waiting = new Set<() => void>();

  /**
   * Resolves with null as soon as `check()` is null (ready), or with its last answer (why not) once `ms` has passed.
   * An answer that waiting will not change (signed out) is `final`, and comes back at once.
   */
  until<R>(check: () => R | null, ms: number, final: (r: R) => boolean = () => false): Promise<R | null> {
    const now = check();
    if (now === null || final(now) || ms <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const look = () => {
        const r = check();
        if (r === null || final(r)) finish(r);
      };
      const finish = (r: R | null) => {
        clearTimeout(timer);
        this.waiting.delete(look);
        resolve(r);
      };
      const timer = setTimeout(() => finish(check()), ms);
      this.waiting.add(look);
    });
  }

  /** Something a check reads may have changed: each waiter looks again. */
  changed() {
    for (const look of [...this.waiting]) look();
  }

  /** How many are waiting (tests). */
  get size(): number {
    return this.waiting.size;
  }
}
