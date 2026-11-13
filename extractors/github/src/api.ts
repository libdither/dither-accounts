/**
 * GitHub's REST API with one token. Every answer's rate-limit headers (X-RateLimit-*) are kept; a primary limit
 * (remaining 0) is waited out until its reset and a secondary one for as long as Retry-After says (at least a minute,
 * and longer each time, when it says nothing), with no request sent meanwhile. Conditional requests (If-Modified-Since,
 * If-None-Match) come back 304, which GitHub does not count. The token's scopes come from X-OAuth-Scopes. A failure is
 * a GitHubError carrying GitHub's status (429 for a rate limit, so an app knows to come back later).
 *
 * The token only ever goes to the API's own origin: an absolute URL (a subject's, a Link header's) on any other host is
 * refused.
 */
import { StatusError } from '@dither-accounts/link';

export type Failure =
  /** 401: the token is not (or no longer) good. */
  | 'auth'
  /** 403 that is not a rate limit: a missing scope, a fine-grained token, SAML, an IP allow list. */
  | 'forbidden'
  | 'rate'
  /** No HTTP answer at all: DNS, refused, timed out. */
  | 'network'
  | 'http';

export class GitHubError extends StatusError {
  constructor(
    message: string,
    status: number,
    readonly failure: Failure,
    /** For a rate limit: when to try again (ms since the epoch). */
    readonly retryAt: number | null = null,
    /** X-Accepted-OAuth-Scopes, when GitHub said which scopes would have done. */
    readonly accepted: string | null = null,
  ) {
    super(message, status);
  }
}

export interface Rate {
  limit: number | null;
  remaining: number | null;
  /** ms since the epoch */
  resetAt: number | null;
  resource: string | null;
}

export interface Answer<T = any> {
  status: number;
  body: T;
  headers: Headers;
  /** The Link header's rel="next", if there is one. */
  next: string | null;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface ReqOpts {
  query?: Query;
  body?: unknown;
  /** A Last-Modified from before: GitHub answers 304 (free) when nothing changed. */
  ifModifiedSince?: string | null;
  /** An ETag from before, likewise. */
  etag?: string | null;
  /** Retries after a 5xx or no answer, with growing waits. */
  retries?: number;
  timeoutMs?: number;
}

/** A Link header's targets by rel: <https://…?page=2>; rel="next", <…>; rel="last". */
export function parseLink(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (m) for (const rel of m[2].trim().split(/\s+/)) out[rel] = m[1];
  }
  return out;
}

/** X-OAuth-Scopes as a list; null when the header is not there (a fine-grained or GitHub App token). */
export function parseScopes(h: string | null): string[] | null {
  if (h === null) return null;
  return h
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * When a refused request may be tried again, if it was refused for a rate limit (GitHub's rules): Retry-After when it
 * is there; the reset time when no requests remain; otherwise, for a 429 or a 403 that says "rate limit", at least
 * `minMs`, doubling with each one in a row (`streak`). null: not a rate limit.
 */
export function rateLimitRetryAt(status: number, headers: Headers, message: string, now = Date.now(), streak = 0, minMs = 60_000): number | null {
  if (status !== 403 && status !== 429) return null;
  const ra = headers.get('retry-after');
  if (ra !== null && ra.trim() !== '') {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return now + Math.max(1, s) * 1000;
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(d, now + 1000);
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0 ? Math.max(reset * 1000, now + 1000) : now + minMs;
  }
  if (status === 429 || /rate limit/i.test(message)) return now + minMs * 2 ** Math.min(streak, 4);
  return null;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class GitHub {
  rate: Rate = { limit: null, remaining: null, resetAt: null, resource: null };
  /** No request goes out before this (a rate limit). */
  limitedUntil = 0;
  /** Whether the last request got an HTTP answer (null before the first), and what went wrong when it did not. */
  reached: boolean | null = null;
  networkError: string | null = null;
  /** Requests sent, and how many came back 304. */
  sent = 0;
  notModified = 0;
  private secondaryStreak = 0;
  readonly base: string;
  readonly origin: string;

  constructor(
    base: string,
    private token: () => string | null,
    private opts: { secondaryMs?: number; backoffMs?: number; userAgent?: string } = {},
  ) {
    this.base = base.replace(/\/+$/, '');
    this.origin = new URL(this.base).origin;
  }

  /** The API's host, for the status layers: api.github.com, or an Enterprise server's. */
  get host(): string {
    return new URL(this.base).host;
  }

  /** Whether a request we could do without (resolving a subject) fits: not limited, and well inside what remains. */
  canSpare(n = 1): boolean {
    if (Date.now() < this.limitedUntil) return false;
    if (this.rate.remaining === null) return true;
    const reserve = Math.max(50, Math.round((this.rate.limit ?? 5000) * 0.1));
    return this.rate.remaining - n >= reserve;
  }

  url(pathOrUrl: string, query?: Query): URL {
    const u = /^https?:\/\//i.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(this.base + pathOrUrl);
    if (u.origin !== this.origin) throw new GitHubError(`refused to send the token to ${u.origin} (the API is ${this.origin})`, 400, 'http');
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u;
  }

  async req<T = any>(method: string, pathOrUrl: string, opts: ReqOpts = {}): Promise<Answer<T>> {
    const u = this.url(pathOrUrl, opts.query);
    const token = this.token();
    if (!token) throw new GitHubError('no GitHub token', 401, 'auth');
    for (let attempt = 0; ; attempt++) {
      if (Date.now() < this.limitedUntil) throw new GitHubError(`GitHub's rate limit: try again after ${iso(this.limitedUntil)}`, 429, 'rate', this.limitedUntil);
      let res: Response;
      try {
        this.sent++;
        res = await fetch(u, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': this.opts.userAgent ?? 'dither-accounts-github',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(opts.ifModifiedSince ? { 'if-modified-since': opts.ifModifiedSince } : {}),
            ...(opts.etag ? { 'if-none-match': opts.etag } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch (e: any) {
        this.reached = false;
        this.networkError = `${u.host}: ${e?.name === 'TimeoutError' ? 'no answer in time' : String(e?.code ?? e?.message ?? e)}`;
        if (attempt < (opts.retries ?? 0)) {
          await Bun.sleep((this.opts.backoffMs ?? 500) * 2 ** attempt);
          continue;
        }
        throw new GitHubError(`cannot reach ${this.networkError}`, 503, 'network');
      }
      this.reached = true;
      this.networkError = null;
      this.keepRate(res.headers);
      if (res.status === 304) {
        this.notModified++;
        return { status: 304, body: null as T, headers: res.headers, next: null };
      }
      const text = await res.text();
      let body: any = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          if (res.ok) throw new GitHubError(`${u.host} did not answer as GitHub's API does (not JSON); is ${this.base} the API's URL?`, 502, 'http');
        }
      }
      if (res.ok) {
        this.secondaryStreak = 0;
        return { status: res.status, body: body as T, headers: res.headers, next: parseLink(res.headers.get('link')).next ?? null };
      }
      const message = typeof body?.message === 'string' ? body.message : `GitHub answered ${res.status}`;
      if (res.status === 401) throw new GitHubError(message, 401, 'auth');
      const retryAt = rateLimitRetryAt(res.status, res.headers, message, Date.now(), this.secondaryStreak, this.opts.secondaryMs ?? 60_000);
      if (retryAt !== null) {
        if (res.headers.get('x-ratelimit-remaining') !== '0') this.secondaryStreak++;
        this.limitedUntil = Math.max(this.limitedUntil, retryAt);
        throw new GitHubError(`GitHub's rate limit (${message}): try again after ${iso(this.limitedUntil)}`, 429, 'rate', this.limitedUntil);
      }
      if (res.status === 403) throw new GitHubError(message, 403, 'forbidden', null, res.headers.get('x-accepted-oauth-scopes'));
      if (res.status >= 500 && attempt < (opts.retries ?? 0)) {
        await Bun.sleep((this.opts.backoffMs ?? 500) * 2 ** attempt);
        continue;
      }
      throw new GitHubError(message, res.status, 'http');
    }
  }

  private keepRate(h: Headers) {
    const n = (k: string) => {
      const v = h.get(k);
      return v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    };
    const limit = n('x-ratelimit-limit');
    if (limit === null) return;
    const reset = n('x-ratelimit-reset');
    this.rate = { limit, remaining: n('x-ratelimit-remaining'), resetAt: reset === null ? null : reset * 1000, resource: h.get('x-ratelimit-resource') };
  }
}
