/**
 * A small Matrix Client-Server API client over fetch.
 *
 * Only the access token is sent, and only as an Authorization header to the
 * configured homeserver (never in URLs, never logged).
 */

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
    readonly error: string,
    readonly data: Record<string, any> = {},
  ) {
    super(`${errcode}: ${error} (HTTP ${status})`);
  }

  /** The access token is gone or was never valid: a human has to log in again. */
  get isAuth(): boolean {
    return this.status === 401 || this.errcode === 'M_UNKNOWN_TOKEN' || this.errcode === 'M_MISSING_TOKEN';
  }

  get isRateLimit(): boolean {
    return this.status === 429 || this.errcode === 'M_LIMIT_EXCEEDED';
  }

  get retryAfterMs(): number | null {
    if (typeof this.data.retry_after_ms === 'number') return this.data.retry_after_ms;
    const h = Number(this.data._retryAfterHeader);
    return Number.isFinite(h) && h > 0 ? h * 1000 : null;
  }
}

export interface RequestOpts {
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body, or raw bytes with `contentType`. */
  body?: unknown;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Send the access token (default true). */
  auth?: boolean;
  /** Retries for rate limits, 5xx and network errors on idempotent requests (default 3). */
  retries?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const idempotent = (method: string) => method === 'GET' || method === 'PUT' || method === 'DELETE';

export const enc = encodeURIComponent;

export function isAbortError(e: unknown): boolean {
  const name = (e as any)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export class MatrixClient {
  accessToken: string | null = null;
  private txnCounter = 0;
  private readonly txnPrefix = `dc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  constructor(readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  url(path: string, query?: RequestOpts['query']): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Unique per adapter process; the homeserver scopes transaction ids to the device. */
  txnId(): string {
    return `${this.txnPrefix}.${++this.txnCounter}`;
  }

  async request<T = any>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.raw(method, path, opts);
        const text = await res.text();
        let data: any = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = { error: text.slice(0, 300) };
          }
        }
        if (!res.ok) {
          throw new MatrixError(res.status, data.errcode ?? `HTTP_${res.status}`, data.error ?? res.statusText, {
            ...data,
            _retryAfterHeader: res.headers.get('retry-after'),
          });
        }
        return data as T;
      } catch (e) {
        if (attempt >= retries || opts.signal?.aborted) throw e;
        if (e instanceof MatrixError) {
          if (e.isRateLimit) {
            await sleep(Math.min(e.retryAfterMs ?? 1000 * 2 ** attempt, 60_000));
            continue;
          }
          if (e.status >= 500 && idempotent(method)) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw e;
        }
        if (idempotent(method)) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw e;
      }
    }
  }

  /** The bare fetch: callers that need bytes (media) read the Response themselves. */
  async raw(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (opts.contentType) {
        headers['content-type'] = opts.contentType;
        body = opts.body as BodyInit;
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
    }
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 30_000)];
    if (opts.signal) signals.push(opts.signal);
    return fetch(this.url(path, opts.query), { method, headers, body, signal: AbortSignal.any(signals), redirect: 'follow' });
  }
}
