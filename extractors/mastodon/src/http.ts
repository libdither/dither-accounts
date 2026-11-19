/**
 * One server's HTTP API with a bearer token: Mastodon's REST API, and Lemmy's (extractors/lemmy imports it). Every answer's rate-limit
 * headers (X-RateLimit-Remaining, X-RateLimit-Reset) are kept: when the server says almost nothing is left, requests
 * wait for its reset instead of spending the rest, and a 429 is waited out as Retry-After or the reset says. A failure
 * is an ApiError carrying the server's status, so a refused command reaches the app as a "no", not a crash.
 *
 * The token only ever goes to the server's own origin: paths are joined to it, never followed from an answer.
 */

export type Failure =
  /** 401: the token is not (or no longer) good. */
  | 'auth'
  | 'forbidden'
  | 'missing'
  | 'rate'
  /** No HTTP answer at all: DNS, refused, timed out. */
  | 'network'
  | 'http';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly failure: Failure,
    /** For a rate limit: when to try again (ms since the epoch). */
    readonly retryAt: number | null = null,
    /** The server's own error code or words, as it sent them (`{ error }`). */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export interface ReqOpts {
  query?: Query;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as multipart (a file upload). */
  form?: FormData;
  /** Mastodon's Idempotency-Key: the same key twice makes one post. */
  idempotencyKey?: string;
  /** Without the token (signed out). */
  anonymous?: boolean;
  timeoutMs?: number;
}

export interface Answer<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A Link header's targets by rel: <https://…?max_id=2>; rel="next", <…>; rel="prev". */
export function parseLink(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (m) for (const rel of m[2].trim().split(/\s+/)) out[rel] = m[1];
  }
  return out;
}

/** One query parameter of a URL, or null. */
export function queryParam(url: string | undefined, key: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}

/** Keep this many requests in hand: below it, wait for the window's reset. */
const RESERVE = 3;

export class Api {
  /** Requests are refused (rate) until then, ms since the epoch. */
  limitedUntil = 0;
  remaining: number | null = null;
  resetAt: number | null = null;
  requests = 0;

  constructor(
    readonly base: string,
    private readonly token: () => string | null,
    private readonly userAgent = 'dither-accounts',
  ) {}

  get host(): string {
    return new URL(this.base).host;
  }

  url(path: string, query?: Query): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async req<T = any>(method: string, path: string, o: ReqOpts = {}): Promise<Answer<T>> {
    const now = Date.now();
    if (this.limitedUntil > now) throw new ApiError(`${this.host} asks to wait until ${new Date(this.limitedUntil).toISOString()} (rate limit)`, 429, 'rate', this.limitedUntil);
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    const token = o.anonymous ? null : this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
    let body: BodyInit | undefined;
    if (o.form) body = o.form;
    else if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    }
    let r: Response;
    this.requests++;
    try {
      r = await fetch(this.url(path, o.query), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new ApiError(`no answer from ${this.host}: ${(e as Error).message}`, 503, 'network');
    }
    this.readRate(r.headers);
    const text = await r.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (r.ok) return { status: r.status, body: parsed as T, headers: r.headers };
    const said = typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.message === 'string' ? parsed.message : null;
    const words = said ?? (text && text.length < 200 && !text.trimStart().startsWith('<') ? text.trim() : `HTTP ${r.status}`);
    if (r.status === 429) {
      const after = Number(r.headers.get('retry-after'));
      const at = Number.isFinite(after) && after > 0 ? Date.now() + after * 1000 : this.resetAt && this.resetAt > Date.now() ? this.resetAt : Date.now() + 60_000;
      this.limitedUntil = at;
      throw new ApiError(`${this.host} is rate limiting: ${words}`, 429, 'rate', at, said);
    }
    const failure: Failure = r.status === 401 ? 'auth' : r.status === 403 ? 'forbidden' : r.status === 404 ? 'missing' : 'http';
    // A 3xx is not followed (the token stays on this origin); say so plainly.
    const status = r.status >= 300 && r.status < 400 ? 502 : r.status;
    throw new ApiError(words, status, failure, null, said);
  }

  private readRate(h: Headers) {
    const rem = h.get('x-ratelimit-remaining');
    const reset = h.get('x-ratelimit-reset');
    if (rem === null) return;
    this.remaining = Number(rem);
    // Mastodon sends an ISO time; others a number of seconds (or an epoch).
    let at: number | null = null;
    if (reset) {
      const n = Number(reset);
      at = Number.isFinite(n) ? (n > 1e9 ? n * 1000 : Date.now() + n * 1000) : Date.parse(reset);
    }
    this.resetAt = at !== null && Number.isFinite(at) ? at : null;
    if (Number.isFinite(this.remaining) && this.remaining <= RESERVE && this.resetAt && this.resetAt > Date.now()) this.limitedUntil = this.resetAt;
  }
}

/** `mastodon.example`, `https://mastodon.example/` → `https://mastodon.example`. */
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
