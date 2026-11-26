/**
 * Reading like a person, and stopping when Luma says to. Luma sits behind Cloudflare and rate-limits; its terms allow
 * only its own interfaces. So every read goes through one queue a person's gap apart (`Pace`), and a 429 or a
 * Cloudflare check holds every read back (`Backoff`): a 429 for 1 minute, doubling with each one in a row up to 30
 * minutes; a check for 10 minutes at a time, while the account asks you to clear it in the live view. Nothing is
 * retried by itself during a hold: a read asked for then fails at once with when to ask again.
 */

/** Commands one at a time, at least `minGapMs` plus up to `jitterMs` after the last one ended. */
export class Pace {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEnd = 0;
  constructor(
    private readonly minGapMs: number,
    private readonly jitterMs: number,
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

export const RATE_FIRST_MS = 60_000;
export const RATE_MAX_MS = 30 * 60_000;
export const CHALLENGE_MS = 10 * 60_000;

/** What a failed call's words say: Luma's 429, or a Cloudflare check (the hook's words: hook.js `call`). */
export function failureKind(message: string): '429' | 'challenge' | null {
  if (/answered 429\b/.test(message)) return '429';
  if (/Cloudflare check|\(challenge\)/.test(message)) return 'challenge';
  return null;
}

export class Backoff {
  private streak = 0;
  until = 0;
  why: '429' | 'challenge' | null = null;
  constructor(private readonly scale = 1) {}

  /** Held back now? */
  holding(now = Date.now()): boolean {
    return this.until > now;
  }
  /** A call failed: hold back if it was a 429 or a check. Returns the kind. */
  failed(message: string, now = Date.now()): '429' | 'challenge' | null {
    const k = failureKind(message);
    if (!k) return null;
    this.why = k;
    if (k === '429') {
      this.until = now + Math.min(RATE_MAX_MS, RATE_FIRST_MS * 2 ** this.streak) * this.scale;
      this.streak++;
    } else {
      this.until = now + CHALLENGE_MS * this.scale;
    }
    return k;
  }
  /** A call went through: the streak and any check are over. */
  ok() {
    this.streak = 0;
    this.why = null;
    this.until = 0;
  }
  state(): { until: number; why: '429' | 'challenge' } | null {
    return this.why ? { until: this.until, why: this.why } : null;
  }
}
