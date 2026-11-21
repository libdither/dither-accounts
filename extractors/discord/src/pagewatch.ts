/**
 * When to reload the Discord tab. The extension's worker can be attached while the page in its tab never starts (seen
 * after a restart under load: Chromium's network service crashed while the page loaded, the worker came up, and the
 * hook never ran), or after the page stops answering. Commands then went to a worker with no page and each one timed
 * out, for as long as the extractor ran. A person would reload the tab; this says when.
 *
 * - A page that has not spoken PAGE_START_MS after the worker attached (or after the last reload) is reloaded.
 * - A page that leaves SILENT_LIMIT requests in a row unanswered (timed out, or refused for having no page) with no
 *   word from it between is reloaded.
 * Each reload with no word since doubles the wait before the next, up to MAX_WAIT_MS; a word from the page resets it.
 */

export const PAGE_START_MS = 120_000;
export const SILENT_LIMIT = 3;
export const MAX_WAIT_MS = 15 * 60_000;

export class PageWatch {
  private attachedNow = false;
  /** Since when a page is awaited (attach or reload) and not yet heard; null once it spoke. */
  private waitingSince: number | null = null;
  private silent = 0;
  private reloads = 0;
  private lastReloadAt = 0;

  constructor(private now: () => number = Date.now) {}

  /** The worker attached: wait for its page. */
  attached() {
    this.attachedNow = true;
    this.waitingSince ??= this.now();
  }

  /** The worker went away: nothing to reload through until it is back. */
  detached() {
    this.attachedNow = false;
  }

  /** The page said something (a frame from the hook, or its answer to a command). */
  heard() {
    this.waitingSince = null;
    this.silent = 0;
    this.reloads = 0;
  }

  /** A command to the page went unanswered, or the worker said no page is open. */
  unanswered() {
    this.silent++;
  }

  private get wait(): number {
    return Math.min(PAGE_START_MS * 2 ** this.reloads, MAX_WAIT_MS);
  }

  /** Why the tab should be reloaded now, or null. */
  due(): string | null {
    if (!this.attachedNow) return null;
    const now = this.now();
    if (this.waitingSince !== null && now - this.waitingSince >= this.wait) {
      return `the Discord page has not spoken in ${Math.round((now - this.waitingSince) / 1000)} s`;
    }
    if (this.silent >= SILENT_LIMIT && now - this.lastReloadAt >= this.wait) {
      return `the Discord page did not answer ${this.silent} requests in a row`;
    }
    return null;
  }

  /** A reload was asked for: wait for the page again, longer if the last one brought nothing. */
  reloaded() {
    const now = this.now();
    this.waitingSince = now;
    this.lastReloadAt = now;
    this.silent = 0;
    this.reloads++;
  }
}
