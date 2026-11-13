/**
 * Commands one at a time with a person's gaps between them: at least `minGapMs` plus up to `jitterMs` after the last
 * one ended. The page has one open conversation, so its commands never overlap anyway; this keeps them from coming
 * faster than a hand would.
 */
export class Pace {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEnd = 0;
  constructor(
    private minGapMs: number,
    private jitterMs: number,
  ) {}

  run<T>(f: () => Promise<T>): Promise<T> {
    const go = async () => {
      const wait = this.lastEnd + this.minGapMs + Math.floor(Math.random() * this.jitterMs) - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      try {
        return await f();
      } finally {
        this.lastEnd = Date.now();
      }
    };
    const p = this.tail.then(go, go);
    this.tail = p.catch(() => {});
    return p;
  }
}
