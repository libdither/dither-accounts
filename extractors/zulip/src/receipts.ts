/**
 * Read receipts for your own messages in direct and group DMs.
 *
 * Zulip keeps who has read a message (`GET /messages/{id}/read_receipts`, Zulip 6.0+, where the organization has
 * read receipts on) but sends no event when someone reads one. So the newest message you sent in each DM is asked
 * about a few times after you sent it (RECHECK_MS from when it was sent), and again soon after someone there writes or
 * starts typing, which they seldom do without having read it. Each person is said once (`receipt`, state `read`), at
 * the time it was learned: Zulip does not say when they read it. A DM is let go once everyone in it has read the
 * message; after the last timed check only someone writing or typing there asks again.
 *
 * Channels are left out: a topic's readers can be hundreds, and asking would spend the request budget on them.
 * At most PER_MINUTE asks a minute, well inside Zulip's 200 requests.
 */

/** When the newest message you sent is asked about, after it was sent. */
export const RECHECK_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
/** Asks a minute, at most. */
export const PER_MINUTE = 20;
/** Someone writing or typing asks again, at most this often for one DM. */
const NUDGE_GAP_MS = 20_000;
/** How soon after someone writes or types it asks (they may still be reading). */
const NUDGE_DELAY_MS = 3_000;
/** A message you sent longer ago than this is not watched at start. */
export const START_WINDOW_MS = 24 * 60 * 60_000;
const TICK_MS = 2_000;

export interface ReceiptHost {
  /** Whether the organization has read receipts on and the server has the endpoint. */
  enabled(): boolean;
  /** Who has read this message (user ids), as Zulip says. */
  ask(id: number): Promise<number[]>;
  /** One person read it. */
  read(conv: string, id: number, who: number, ts: number): void;
  log(msg: string): void;
}

interface Watched {
  id: number;
  conv: string;
  /** The others in the DM: who may read it. */
  others: Set<number>;
  /** Who has been said to have read it. */
  seen: Set<number>;
  sentAt: number;
  /** The next timed check (an index into the steps), or steps.length when there are none left. */
  step: number;
  /** When it is next asked about (Infinity: only when someone writes or types). */
  next: number;
  nudgedAt: number;
}

export class Receipts {
  private byConv = new Map<string, Watched>();
  private asked: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private h: ReceiptHost,
    private opts: { steps?: number[]; perMinute?: number; now?: () => number; tickMs?: number } = {},
  ) {}

  private get steps() {
    return this.opts.steps ?? RECHECK_MS;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * You sent a message in a DM (or, at start, it is the newest there): it becomes the one watched in that DM.
   * `askNow`: ask at once as well (at start, where whoever read it meanwhile is not known).
   */
  sent(conv: string, id: number, others: number[], sentAt: number, askNow = false) {
    if (!this.h.enabled() || !others.length) return;
    const cur = this.byConv.get(conv);
    if (cur && cur.id > id) return;
    const w: Watched = { id, conv, others: new Set(others), seen: new Set(), sentAt, step: 0, next: Infinity, nudgedAt: 0 };
    this.plan(w, this.now());
    if (askNow) w.next = this.now();
    this.byConv.set(conv, w);
    this.arm();
  }

  /** Someone wrote or started typing in a DM: if they have not read your message there yet, it is asked about soon. */
  nudge(conv: string, who: number) {
    const w = this.byConv.get(conv);
    if (!w || !w.others.has(who) || w.seen.has(who)) return;
    const now = this.now();
    if (now - w.nudgedAt < NUDGE_GAP_MS) return;
    w.nudgedAt = now;
    w.next = Math.min(w.next, now + NUDGE_DELAY_MS);
    this.arm();
  }

  /** The DM is gone (left, deleted) or the message was: nothing more to ask. */
  forget(conv: string, id?: number) {
    const w = this.byConv.get(conv);
    if (w && (id === undefined || w.id === id)) this.byConv.delete(conv);
  }

  /** Watched DMs, for tests and the adapter's details. */
  get size() {
    return this.byConv.size;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.byConv.clear();
  }

  /** The next timed check after `now`: past ones (a message from before start) are skipped. */
  private plan(w: Watched, now: number) {
    while (w.step < this.steps.length && w.sentAt + this.steps[w.step]! <= now) w.step++;
    w.next = w.step < this.steps.length ? w.sentAt + this.steps[w.step]! : Infinity;
  }

  private arm() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Asks about every DM that is due, within the budget. Exported for tests. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      this.asked = this.asked.filter((t) => now - t < 60_000);
      const due = [...this.byConv.values()].filter((w) => w.next <= now).sort((a, b) => a.next - b.next);
      for (const w of due) {
        if (this.asked.length >= (this.opts.perMinute ?? PER_MINUTE)) break;
        if (!this.h.enabled()) break;
        this.asked.push(now);
        let readers: number[];
        try {
          readers = await this.h.ask(w.id);
        } catch (e) {
          this.h.log(`zulip: read receipts for a message: ${(e as Error).message}`);
          w.next = this.now() + 60_000;
          continue;
        }
        // Replaced by a newer message, or let go, while it was asked about.
        if (this.byConv.get(w.conv) !== w) continue;
        for (const u of readers)
          if (w.others.has(u) && !w.seen.has(u)) {
            w.seen.add(u);
            this.h.read(w.conv, w.id, u, this.now());
          }
        if (w.seen.size >= w.others.size) {
          this.byConv.delete(w.conv);
          continue;
        }
        this.plan(w, this.now());
      }
      if (!this.byConv.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    } finally {
      this.busy = false;
    }
  }
}
