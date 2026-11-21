/**
 * The first seconds after the extractor starts (a deploy restarts it): the browser comes up, the extension attaches
 * and Discord's client loads its first snapshot, a few seconds in all. A command the hub sends in that window (a
 * markRead as the owner reads a channel) would fail at once with "extension not connected" or a hook that found no
 * stores. Instead it waits here until the client is up, or the window ends, and then runs as it would have.
 *
 * `open()` ends the wait for everyone: the first snapshot, or a page that will not load by itself (a sign-in page, a
 * captcha), where waiting longer would not help. After the window a command never waits: an extension lost later is
 * the account's status, not a startup.
 */
export class StartupGate {
  private opened = false;
  private waiters = new Set<() => void>();

  constructor(
    private readonly until: number,
    private readonly now: () => number = Date.now,
  ) {}

  get isOpen(): boolean {
    return this.opened || this.now() >= this.until;
  }

  /** Resolves when the gate opens or the window ends, with how long it waited (0: it did not). */
  wait(): Promise<number> {
    if (this.isOpen) return Promise.resolve(0);
    const t0 = this.now();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(Math.max(0, this.now() - t0));
      };
      const timer = setTimeout(done, Math.max(0, this.until - t0));
      this.waiters.add(done);
    });
  }

  open() {
    this.opened = true;
    for (const w of [...this.waiters]) w();
  }
}
