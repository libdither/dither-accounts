/** Growing delays between retries of a request that failed on the network, and a sleep that a working connection cuts short. */
export class Backoff {
  failures = 0;
  private wakers = new Set<() => void>();

  constructor(private readonly steps: readonly number[] = [1000, 2000, 4000, 8000, 15_000]) {}

  /** Count a failure; the delay before the next try. */
  fail(): number {
    const delay = this.steps[Math.min(this.failures, this.steps.length - 1)];
    this.failures++;
    return delay;
  }

  reset() {
    this.failures = 0;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  /** End every sleep now: the connection works again. */
  wake() {
    for (const w of [...this.wakers]) w();
  }
}

interface Item<T> {
  value: T;
  /** What it belongs to (a verification flow): items of a flow that is over are dropped. */
  key: string;
  /** A cancel is still worth delivering after its flow is over, for a while. */
  cancel: boolean;
  queuedAt: number;
  tries: number;
  tried: (sent: boolean) => void;
}

export interface OutboxOptions<T> {
  send: (value: T) => Promise<void>;
  /** Still worth sending? Asked before each try. */
  wanted: (item: { key: string; cancel: boolean; age: number }) => boolean;
  backoff?: Backoff;
  /** The queue changed: something went out, failed, or was dropped. */
  onChange?: () => void;
  log?: (level: 'debug' | 'info' | 'warn', msg: string) => void;
}

/**
 * Messages that must arrive, in the order given, over a connection that may drop: one at a time,
 * each retried with backoff until it goes out or is no longer wanted. Later ones wait behind it.
 */
export class Outbox<T> {
  private items: Item<T>[] = [];
  private pumping: Promise<void> | null = null;
  private stopped = false;
  readonly backoff: Backoff;

  constructor(private readonly opts: OutboxOptions<T>) {
    this.backoff = opts.backoff ?? new Backoff();
  }

  /** Queue it. Settles after its first try: true if it went out then (false: it is being retried, or was dropped). */
  push(value: T, key: string, cancel = false): Promise<boolean> {
    const tried = new Promise<boolean>((resolve) => this.items.push({ value, key, cancel, queuedAt: Date.now(), tries: 0, tried: resolve }));
    void this.pump();
    return tried;
  }

  pending(key?: string): number {
    return key === undefined ? this.items.length : this.items.filter((i) => i.key === key).length;
  }

  /** The connection works again: retry now rather than after the backoff. */
  wake() {
    this.backoff.wake();
  }

  stop() {
    this.stopped = true;
    this.backoff.wake();
  }

  /** Resolves when the queue is empty (or stopped). */
  idle(): Promise<void> {
    return this.pumping ?? Promise.resolve();
  }

  private pump(): Promise<void> {
    this.pumping ??= (async () => {
      while (this.items.length && !this.stopped) {
        const item = this.items[0];
        if (!this.opts.wanted({ key: item.key, cancel: item.cancel, age: Date.now() - item.queuedAt })) {
          this.items.shift();
          item.tried(false);
          this.opts.log?.('debug', `dropped an unsent message of ${item.key}, which is over`);
          this.opts.onChange?.();
          continue;
        }
        try {
          await this.opts.send(item.value);
          this.items.shift();
          item.tried(true);
          if (item.tries) {
            this.opts.log?.('info', `a message went through after ${item.tries} failed ${item.tries === 1 ? 'try' : 'tries'}`);
            this.opts.onChange?.();
          }
          this.backoff.reset();
        } catch (e: any) {
          item.tries++;
          item.tried(false);
          const delay = this.backoff.fail();
          if (item.tries === 1) {
            this.opts.log?.('warn', `could not send a message (${e?.message ?? e}); retrying until it goes through`);
            this.opts.onChange?.();
          }
          await this.backoff.sleep(delay);
        }
      }
    })().finally(() => (this.pumping = null));
    return this.pumping;
  }
}
