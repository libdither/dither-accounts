/**
 * One ForumMagnum site's GraphQL endpoint (LessWrong's https://www.lesswrong.com/graphql, the EA Forum's, the
 * Alignment Forum's), at a person's pace: requests go one at a time, a read 1-2.5 s after the request before it and a
 * write 0.6-1.2 s after (DITHER_LESSWRONG_PACE_MS scales both; tests set it near 0). The session is the site's login
 * token, sent as the `loginToken` header the site's own Apollo client sends, and only to the site's own origin: the
 * path is fixed, redirects are not followed.
 *
 * Every request is a named operation (`operationName`), so a log line or a fake server names what was asked. A
 * failure is a GqlError carrying what kind of failure it was: a refused command reaches the app as a "no", not a crash.
 */

export type Failure =
  /** The site says the session is not signed in ("Not logged in"). */
  | 'auth'
  /** No such post, comment or person (ForumMagnum's app.missing_document). */
  | 'missing'
  | 'rate'
  /** No HTTP answer at all: DNS, refused, timed out. */
  | 'network'
  /** An HTTP failure (5xx, a 4xx without GraphQL errors). */
  | 'http'
  /** The site answered with a GraphQL error in words: a refused password, a vote it does not allow. */
  | 'refused';

export class GqlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly failure: Failure,
    /** For a rate limit: when to try again (ms since the epoch). */
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

export interface GqlOpts {
  /** A write (a vote, a comment, a delete): paced as one. */
  write?: boolean;
  /** Without the token (signing in). */
  anonymous?: boolean;
  timeoutMs?: number;
}

/** Read at each request, so a test can set it after loading this file. */
function paceScale(): number {
  const v = Number(process.env.DITHER_LESSWRONG_PACE_MS);
  return Number.isFinite(v) && v >= 0 && process.env.DITHER_LESSWRONG_PACE_MS !== '' ? v : 1000;
}

/** The site's words for a GraphQL error, as a failure. */
function failureOf(message: string): { failure: Failure; status: number } {
  if (/missing_document|no such document/i.test(message)) return { failure: 'missing', status: 404 };
  if (/not logged in|must be logged in/i.test(message)) return { failure: 'auth', status: 401 };
  if (/rate limit|too many|wait \d+/i.test(message)) return { failure: 'refused', status: 429 };
  return { failure: 'refused', status: 400 };
}

export class Gql {
  limitedUntil = 0;
  requests = 0;
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly base: string,
    private readonly token: () => string | null,
    private readonly userAgent = 'dither-accounts',
  ) {}

  get host(): string {
    return new URL(this.base).host;
  }

  /** One operation's `data`; any GraphQL error throws (the first one's words). */
  request<T = any>(operationName: string, query: string, variables: Record<string, unknown> = {}, o: GqlOpts = {}): Promise<T> {
    const run = this.queue.then(
      () => this.send<T>(operationName, query, variables, o),
      () => this.send<T>(operationName, query, variables, o),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  private async send<T>(operationName: string, query: string, variables: Record<string, unknown>, o: GqlOpts): Promise<T> {
    const gap = paceScale() * (o.write ? 0.6 + 0.6 * Math.random() : 1 + 1.5 * Math.random());
    const wait = this.last + gap - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    if (this.limitedUntil > Date.now()) throw new GqlError(`${this.host} asks to wait until ${new Date(this.limitedUntil).toISOString()} (rate limit)`, 429, 'rate', this.limitedUntil);
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': this.userAgent };
    const token = o.anonymous ? null : this.token();
    if (token) headers.logintoken = token;
    let r: Response;
    this.requests++;
    try {
      r = await fetch(`${this.base}/graphql`, { method: 'POST', headers, body: JSON.stringify({ operationName, query, variables }), redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new GqlError(`no answer from ${this.host}: ${(e as Error).message}`, 503, 'network');
    } finally {
      this.last = Date.now();
    }
    const text = await r.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (r.status === 429) {
      const after = Number(r.headers.get('retry-after'));
      const at = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 60_000);
      this.limitedUntil = at;
      throw new GqlError(`${this.host} is rate limiting`, 429, 'rate', at);
    }
    const errors: any[] = Array.isArray(parsed?.errors) ? parsed.errors : [];
    if (errors.length) {
      // The first error's words, without the server's stack.
      const message = String(errors[0]?.message ?? 'the site refused it').slice(0, 300);
      const { failure, status } = failureOf(message);
      throw new GqlError(message, status, failure);
    }
    if (!r.ok || !parsed || typeof parsed !== 'object' || !('data' in parsed)) {
      // A 3xx is not followed (the token stays on this origin); say so plainly.
      const status = r.status >= 300 && r.status < 400 ? 502 : r.ok ? 502 : r.status;
      throw new GqlError(`${this.host} answered ${r.status}${r.ok ? ' without data' : ''}`, status, 'http');
    }
    return parsed.data as T;
  }
}

/** `lesswrong.com`, `https://www.lesswrong.com/` → `https://www.lesswrong.com`; null when it is no address. */
export function baseOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
