/**
 * Threads made into Notifications, fetching what a thread does not say only when it is worth it: an issue's, pull
 * request's or release's state, author and link (once per change of the thread, revalidated with its ETag so an
 * unchanged one is a free 304), and the latest comment's author and text (once: a comment's author does not change).
 * Each call has a budget of fetches, and none is made when the rate limit is low, the repository is private and the
 * token has no repo scope, or GitHub already said the thing is gone; what is not fetched is linked from its URL alone.
 * Kept in memory only, never on disk.
 */
import type { Notification } from '@dither-accounts/interfaces';
import { type GitHub, GitHubError } from './api.ts';
import { type CommentInfo, commentInfo, FETCHED, hasComment, type SubjectInfo, subjectInfo, type Thread, toNotification } from './map.ts';

class Lru<K, V> {
  private m = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
  get size() {
    return this.m.size;
  }
}

export interface Budget {
  n: number;
}

const GONE_MS = 3_600_000;

export class Resolver {
  private subjects = new Lru<string, { etag: string | null; info: SubjectInfo; at: number }>(2000);
  private comments = new Lru<string, CommentInfo>(2000);
  /** URLs GitHub answered 404/403/410 for, until when not to ask again. */
  private gone = new Lru<string, number>(2000);
  fetched = 0;
  revalidated = 0;

  constructor(
    private gh: GitHub,
    /** The token has the repo scope (private repositories' subjects are readable). */
    private repoScope: () => boolean,
  ) {}

  async resolve(t: Thread, budget: Budget): Promise<Notification> {
    const [subject, comment] = await Promise.all([this.subject(t, budget), this.comment(t, budget)]);
    return toNotification(t, { subject, comment });
  }

  /** Several, at most `concurrency` requests at a time, in their order. */
  async all(threads: Thread[], budget: Budget, concurrency = 4): Promise<Notification[]> {
    const out: Notification[] = new Array(threads.length);
    let i = 0;
    const worker = async () => {
      while (i < threads.length) {
        const k = i++;
        out[k] = await this.resolve(threads[k], budget);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, threads.length) }, worker));
    return out;
  }

  private may(t: Thread, url: string, budget: Budget): boolean {
    if (budget.n <= 0) return false;
    if (t.repository?.private && !this.repoScope()) return false;
    const g = this.gone.get(url);
    if (g && g > Date.now()) return false;
    return this.gh.canSpare();
  }

  private async subject(t: Thread, budget: Budget): Promise<SubjectInfo | null> {
    const url = t.subject.url;
    if (!url || !FETCHED.has(t.subject.type)) return null;
    const at = Date.parse(t.updated_at) || 0;
    const c = this.subjects.get(url);
    if (c && c.at >= at) return c.info;
    if (!this.may(t, url, budget)) return c?.info ?? null;
    budget.n--;
    try {
      const r = await this.gh.req('GET', url, { etag: c?.etag ?? null, timeoutMs: 10_000 });
      if (r.status === 304 && c) {
        this.revalidated++;
        c.at = at;
        return c.info;
      }
      this.fetched++;
      const info = subjectInfo(t.subject.type, r.body);
      this.subjects.set(url, { etag: r.headers.get('etag'), info, at });
      return info;
    } catch (e) {
      this.miss(url, e);
      return c?.info ?? null;
    }
  }

  private async comment(t: Thread, budget: Budget): Promise<CommentInfo | null> {
    if (!hasComment(t)) return null;
    const url = t.subject.latest_comment_url!;
    const c = this.comments.get(url);
    if (c) return c;
    if (!this.may(t, url, budget)) return null;
    budget.n--;
    try {
      const r = await this.gh.req('GET', url, { timeoutMs: 10_000 });
      this.fetched++;
      const info = commentInfo(r.body);
      this.comments.set(url, info);
      return info;
    } catch (e) {
      this.miss(url, e);
      return null;
    }
  }

  private miss(url: string, e: unknown) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 410 || e.failure === 'forbidden')) this.gone.set(url, Date.now() + GONE_MS);
  }
}
