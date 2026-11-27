/**
 * One rule for replacing a channel while calls go over it: an extractor's socket to the manager, the process behind
 * it, a page whose tab is reloaded. Before this, each of those decided by itself what happened to a call caught in the
 * change, and each fix was a wait of its own (github.com/libdither/dither-accounts/issues/100).
 *
 * A Handover holds the channel's current side and its generation, a number bumped each time a new side opens. Calls
 * go through `run`, and the rule is:
 *
 * 1. Up: a call runs on the current side at once.
 * 2. Opening (`opening()`: a replacement is under way, or the first side is starting): a new call waits for the new
 *    side, in the order it came. When the new side opens (`open(side)`), the waiting calls run on it.
 * 3. A call the old side already has stays there and finishes there (`drain` waits for those). Opening a new side
 *    does not touch them. Where two sides can live at once (a socket, a port), open the new one before the old one is
 *    closed; where they cannot (one process per account, one tab), call `opening()` first, drain, then close the old.
 * 4. A call that waited and was never sent is refused with a HandoverError of code `retry` (503): when its own
 *    deadline comes first, when the opening runs past its time, or when the channel goes `down`. It reached no side,
 *    so it is safe to send again. (One that waited to be run again after a cut is refused `unsure` instead.)
 * 5. A call whose side was lost under it (`cut()`: the process ended, the page unloaded) after it was sent is run
 *    again on the next side if the caller said it is `repeatable` (a read, a write that is the same done twice), at
 *    most REPEAT_MAX times and within its deadline. Otherwise it is refused with code `unsure` (504): it may or may not
 *    have happened.
 *
 * Every call settles exactly once: an answer from a side that was already cut is dropped. The block has no timer of
 * its own but each call's deadline and each opening's `ms`; the sites name theirs, with the reason and what happens
 * when it runs out.
 */

/** `retry`: never sent, safe to send again. `unsure`: sent, and its side was lost before it answered. */
export type HandoverCode = 'retry' | 'unsure';

export class HandoverError extends Error {
  readonly status: 503 | 504;
  constructor(
    message: string,
    readonly code: HandoverCode,
    /** The generation the call was on (sent), or would have gone to (waiting). */
    readonly generation: number,
  ) {
    super(message);
    this.status = code === 'retry' ? 503 : 504;
  }
}

/**
 * A call cut from its side is run again on the next one at most this often. Once is enough for a side that was
 * replaced; a call that keeps losing its side may be what ends it (a read that crashes the page), and is refused.
 */
export const REPEAT_MAX = 1;

export type HandoverState = 'up' | 'opening' | 'down';

export interface RunOpts {
  /** When the call's time is up (ms since the epoch, as `now`). A call still waiting then is refused `retry`. */
  deadline: number;
  /** Safe to run twice: run again on the next side if its side is cut under it. Default false. */
  repeatable?: boolean;
}

/** What a call's function gets besides the side: the side's generation, and a signal that fires when it is cut. */
export interface Attempt {
  generation: number;
  signal: AbortSignal;
  /** 0 the first time, 1 when it is run again after a cut. */
  repeat: number;
}

interface Call<S> {
  fn: (side: S, a: Attempt) => Promise<unknown>;
  deadline: number;
  repeatable: boolean;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  settled: boolean;
  repeats: number;
  /** The current attempt, while on a side. */
  on?: { generation: number; ctrl: AbortController; token: object };
  /** Its deadline, while it waits. */
  timer?: ReturnType<typeof setTimeout>;
}

export interface HandoverOpts {
  /** What the channel is, for messages: "the extractor's connection", "the Calendar page". */
  name: string;
  now?: () => number;
}

export class Handover<S> {
  private cur: S | null = null;
  private gen = 0;
  private st: HandoverState = 'down';
  private why = 'not open yet';
  private waiting: Call<S>[] = [];
  private running = new Set<Call<S>>();
  private late?: ReturnType<typeof setTimeout>;
  private drains = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly opts: HandoverOpts) {
    this.now = opts.now ?? Date.now;
  }

  get state(): HandoverState {
    return this.st;
  }
  /** The current side's number: 0 before the first opens, then one more for each side. */
  get generation(): number {
    return this.gen;
  }
  /** The current side, while up. */
  get side(): S | null {
    return this.st === 'up' ? this.cur : null;
  }
  /** Why it is opening or down. */
  get reason(): string | null {
    return this.st === 'up' ? null : this.why;
  }
  /** Calls on a side now, not yet answered. */
  get inFlight(): number {
    return this.running.size;
  }
  /** Calls waiting for a side. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Run `fn` on the current side, or on the next one if a replacement is under way (see the header). */
  run<R>(fn: (side: S, a: Attempt) => Promise<R>, o: RunOpts): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const c: Call<S> = { fn, deadline: o.deadline, repeatable: !!o.repeatable, resolve: resolve as (v: unknown) => void, reject, settled: false, repeats: 0 };
      if (this.st === 'up') this.start(c);
      else if (this.st === 'opening') this.wait(c);
      else this.refuse(c, `${this.opts.name} is down (${this.why}), so this was not sent`);
    });
  }

  /**
   * A new side is coming: calls from now on wait for it. Calls already on the old side are not touched. `ms`: how long
   * the opening may take; past it `late` runs, which by default takes the channel down (`down`), refusing what waits.
   * A site whose calls should go to the old side after all passes a `late` that calls `open` with it. Called again
   * while opening, it gives the opening its new reason and time.
   */
  opening(why: string, o: { ms?: number; late?: () => void } = {}) {
    this.st = 'opening';
    this.why = why;
    clearTimeout(this.late);
    this.late = undefined;
    if (o.ms !== undefined) {
      const ms = o.ms;
      this.late = setTimeout(() => {
        this.late = undefined;
        if (this.st !== 'opening') return;
        if (o.late) o.late();
        else this.down(`${why}, and it was not back within ${Math.round(ms / 1000)} s`);
      }, ms);
    }
  }

  /** The new side is up: it becomes the current one (a new generation), and what waited runs on it, in order. */
  open(side: S) {
    clearTimeout(this.late);
    this.late = undefined;
    this.cur = side;
    this.gen++;
    this.st = 'up';
    this.why = '';
    const q = this.waiting;
    this.waiting = [];
    for (const c of q) {
      clearTimeout(c.timer);
      c.timer = undefined;
      if (this.now() >= c.deadline) this.refuse(c, `${this.opts.name} opened again after this call's time was up, so it was not sent`);
      else this.start(c);
    }
  }

  /** No side, and none coming: what waits is refused `retry`, as is every call until a side opens. */
  down(why: string) {
    clearTimeout(this.late);
    this.late = undefined;
    this.st = 'down';
    this.why = why;
    this.cur = null;
    const q = this.waiting;
    this.waiting = [];
    for (const c of q) this.refuse(c, `${this.opts.name} went down while this call waited for it (${why}), so it was not sent`);
  }

  /**
   * The calls on sides up to `through` (default: the current one) lost their side: each repeatable one waits for the
   * next side (or runs on it now, if it is already up), the rest are refused `unsure`. Their answers, if any still
   * come, are dropped. Says how many were cut.
   */
  cut(why: string, through = this.gen): number {
    let n = 0;
    for (const c of [...this.running]) {
      if (!c.on || c.on.generation > through) continue;
      n++;
      this.running.delete(c);
      const g = c.on.generation;
      c.on.ctrl.abort(new Error(why));
      c.on = undefined;
      // Run again only where a side is up or coming: a channel that is down would refuse it at once.
      if (c.repeatable && c.repeats < REPEAT_MAX && this.now() < c.deadline && (this.st === 'opening' || (this.st === 'up' && this.gen > through))) {
        c.repeats++;
        if (this.st === 'up') this.start(c);
        else this.wait(c);
      } else {
        this.settle(c, false, new HandoverError(`${this.opts.name} was lost while it had this call (${why}): it may or may not have happened, and it was not sent again`, 'unsure', g));
      }
    }
    this.drained();
    return n;
  }

  /**
   * Until no call is on a side (they answered, failed or were cut), or `ms`, or `signal` (the site is closing): true if
   * they all finished.
   */
  drain(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.running.size) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.drains.delete(check);
        signal?.removeEventListener('abort', stop);
        resolve(ok);
      };
      const check = () => {
        if (!this.running.size) done(true);
      };
      const stop = () => done(false);
      const timer = setTimeout(stop, ms);
      signal?.addEventListener('abort', stop);
      this.drains.add(check);
    });
  }

  private start(c: Call<S>) {
    const ctrl = new AbortController();
    const token = {};
    c.on = { generation: this.gen, ctrl, token };
    this.running.add(c);
    let p: Promise<unknown>;
    try {
      p = c.fn(this.cur as S, { generation: this.gen, signal: ctrl.signal, repeat: c.repeats });
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (v) => c.on?.token === token && this.finish(c, true, v),
      (e) => c.on?.token === token && this.finish(c, false, e),
    );
  }

  private finish(c: Call<S>, ok: boolean, v: unknown) {
    this.running.delete(c);
    c.on = undefined;
    this.settle(c, ok, v);
    this.drained();
  }

  private wait(c: Call<S>) {
    this.waiting.push(c);
    c.timer = setTimeout(() => {
      const i = this.waiting.indexOf(c);
      if (i < 0) return;
      this.waiting.splice(i, 1);
      this.refuse(c, `${this.opts.name} was not back within this call's time (${this.why}), so it was not sent`);
    }, Math.max(0, c.deadline - this.now()));
  }

  /** Not sent this time: `retry`, unless it was sent before, on a side since cut (then it may have happened). */
  private refuse(c: Call<S>, message: string) {
    const sent = c.repeats > 0;
    this.settle(c, false, new HandoverError(sent ? `${message}; it was sent once before, to a side lost while it had it, so it may or may not have happened` : message, sent ? 'unsure' : 'retry', this.st === 'up' ? this.gen : this.gen + 1));
  }

  private settle(c: Call<S>, ok: boolean, v: unknown) {
    if (c.settled) return;
    c.settled = true;
    clearTimeout(c.timer);
    if (ok) c.resolve(v);
    else c.reject(v);
  }

  private drained() {
    if (this.running.size) return;
    for (const d of [...this.drains]) d();
  }
}
