/**
 * The AT Protocol's HTTP API (XRPC) on one host, with a bearer token: queries are GET /xrpc/<nsid>?params, procedures
 * POST /xrpc/<nsid> with JSON (or raw bytes for uploadBlob). Every answer's rate-limit headers (RateLimit-Remaining,
 * RateLimit-Reset in epoch seconds) are kept: when the server says almost nothing is left, requests wait for its reset
 * instead of spending the rest, and a 429 is waited out as Retry-After or the reset says. A failure is an XrpcError
 * carrying the server's status and its `error` name (ExpiredToken, AuthFactorTokenRequired…), so a refused command
 * reaches the app as a "no", not a crash.
 *
 * The token only ever goes to this client's own origin: paths are joined to it, redirects are not followed.
 */

export type Failure =
  /** 401 (or an expired or invalid token): the session is not (or no longer) good. */
  | 'auth'
  | 'forbidden'
  | 'missing'
  | 'rate'
  /** No HTTP answer at all: DNS, refused, timed out. */
  | 'network'
  | 'http';

export class XrpcError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly failure: Failure,
    /** The server's `error` name, as it sent it (ExpiredToken, RecordNotFound, AuthFactorTokenRequired…). */
    readonly code: string | null = null,
    /** For a rate limit: when to try again (ms since the epoch). */
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

export type Params = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export interface CallOpts {
  /** The bearer to send instead of the session's (refreshSession takes the refresh token). */
  bearer?: string | null;
  /** Without any token (createSession, resolving a handle). */
  anonymous?: boolean;
  /** Raw bytes for a procedure (uploadBlob), with their type. */
  bytes?: { data: Blob | Uint8Array; type: string };
  timeoutMs?: number;
}

/** Keep this many requests in hand: below it, wait for the window's reset. */
const RESERVE = 3;

/** Errors that mean the session's access token is no longer taken (refresh it). */
export const EXPIRED = new Set(['ExpiredToken', 'InvalidToken']);

export class Xrpc {
  limitedUntil = 0;
  remaining: number | null = null;
  resetAt: number | null = null;
  requests = 0;

  constructor(
    public base: string,
    private readonly token: () => string | null,
    private readonly userAgent = 'dither-accounts',
  ) {}

  get host(): string {
    return new URL(this.base).host;
  }

  url(nsid: string, params?: Params): string {
    const u = new URL(`${this.base}/xrpc/${nsid}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  query<T = any>(nsid: string, params?: Params, o: CallOpts = {}): Promise<T> {
    return this.call<T>('GET', nsid, params, undefined, o);
  }

  procedure<T = any>(nsid: string, body?: unknown, o: CallOpts = {}): Promise<T> {
    return this.call<T>('POST', nsid, undefined, body, o);
  }

  private async call<T>(method: string, nsid: string, params: Params | undefined, json: unknown, o: CallOpts): Promise<T> {
    if (this.limitedUntil > Date.now()) throw new XrpcError(`${this.host} asks to wait until ${new Date(this.limitedUntil).toISOString()} (rate limit)`, 429, 'rate', 'RateLimitExceeded', this.limitedUntil);
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    const token = o.anonymous ? null : o.bearer !== undefined ? o.bearer : this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (o.bytes) {
      headers['content-type'] = o.bytes.type;
      body = o.bytes.data as BodyInit;
    } else if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let r: Response;
    this.requests++;
    try {
      r = await fetch(this.url(nsid, params), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new XrpcError(`no answer from ${this.host}: ${(e as Error).message}`, 503, 'network');
    }
    this.readRate(r.headers);
    const text = await r.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (r.ok) return parsed as T;
    const code = typeof parsed?.error === 'string' ? parsed.error : null;
    const said = typeof parsed?.message === 'string' && parsed.message ? parsed.message : code;
    const words = said ?? (text && text.length < 200 && !text.trimStart().startsWith('<') ? text.trim() : `HTTP ${r.status}`);
    if (r.status === 429) {
      const after = Number(r.headers.get('retry-after'));
      const at = Number.isFinite(after) && after > 0 ? Date.now() + after * 1000 : this.resetAt && this.resetAt > Date.now() ? this.resetAt : Date.now() + 60_000;
      this.limitedUntil = at;
      throw new XrpcError(`${this.host} is rate limiting: ${words}`, 429, 'rate', code, at);
    }
    const failure: Failure =
      r.status === 401 || (code && EXPIRED.has(code)) ? 'auth' : r.status === 403 ? 'forbidden' : r.status === 404 || code === 'RecordNotFound' || code === 'NotFound' ? 'missing' : 'http';
    // A 3xx is not followed (the token stays on this origin); say so plainly.
    const status = r.status >= 300 && r.status < 400 ? 502 : r.status;
    throw new XrpcError(words, status, failure, code);
  }

  private readRate(h: Headers) {
    const rem = h.get('ratelimit-remaining');
    if (rem === null) return;
    this.remaining = Number(rem);
    const reset = Number(h.get('ratelimit-reset'));
    // Epoch seconds (Bluesky's PDS); a small number is seconds from now.
    const at = Number.isFinite(reset) && reset > 0 ? (reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000) : null;
    this.resetAt = at;
    if (Number.isFinite(this.remaining) && this.remaining <= RESERVE && at && at > Date.now()) this.limitedUntil = at;
  }
}

/** `bsky.social`, `https://pds.example/` → `https://pds.example`; null when it is no address. */
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
