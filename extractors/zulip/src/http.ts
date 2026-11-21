/**
 * A Zulip server's REST API (https://zulip.com/api/), with HTTP basic auth as `email:api_key`. Parameters go as
 * form fields, objects and arrays JSON-encoded inside them, as the API asks; answers are `{ result, msg, code, … }`.
 *
 * Rate limits: every answer's X-RateLimit-Remaining and X-RateLimit-Reset are kept; below a small reserve a request
 * waits for the reset, and a 429 is waited out as its Retry-After (or `retry-after` in the body) says, once.
 *
 * The key only ever goes to the server's own origin: paths are joined to it, never followed from an answer (an upload
 * link is checked to be on the server before it is fetched with the key).
 */

export type Failure = 'auth' | 'forbidden' | 'missing' | 'rate' | 'network' | 'http' | 'queue';

export class ZulipError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly failure: Failure,
    /** Zulip's own error code: BAD_EVENT_QUEUE_ID, RATE_LIMIT_HIT, UNAUTHORIZED, STREAM_DOES_NOT_EXIST … */
    readonly code: string | null = null,
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

export type Params = Record<string, unknown>;

export interface Credentials {
  email: string;
  apiKey: string;
}

/** Keep this many requests in hand: below it, wait for the window's reset. */
const RESERVE = 2;
const TIMEOUT_MS = 60_000;

/** The server's origin from what the owner typed: `chat.example.org`, `https://chat.example.org/`, a realm URL. */
export function baseOf(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Form-encodes parameters the way Zulip reads them: strings as they are, everything else as JSON. */
export function formOf(params: Params | undefined): URLSearchParams {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    f.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return f;
}

export class Zulip {
  /** Requests wait until then (ms since the epoch): the server said its window is spent. */
  private waitUntil = 0;
  /** Until a 429 says the window is over: everything waits, the event poll too. */
  private blockedUntil = 0;
  remaining: number | null = null;
  /** Requests made, for the account page. */
  requests = 0;

  constructor(
    readonly base: string,
    private creds: () => Credentials | null,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get host(): string {
    return new URL(this.base).host;
  }

  private auth(c: Credentials) {
    return `Basic ${Buffer.from(`${c.email}:${c.apiKey}`).toString('base64')}`;
  }

  async call<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, params?: Params, opts: { anonymous?: boolean; timeoutMs?: number; form?: FormData; retried?: boolean } = {}): Promise<T> {
    const c = this.creds();
    if (!opts.anonymous && !c) throw new ZulipError('not signed in', 401, 'auth');
    // The event queue's long poll goes on through a low budget (Zulip's event server does not count it against the
    // limit): only a 429 holds it. Everything else keeps the reserve.
    const events = method === 'GET' && path === '/events';
    const wait = (events ? this.blockedUntil : Math.max(this.waitUntil, this.blockedUntil)) - Date.now();
    if (wait > 0) await Bun.sleep(Math.min(wait, 60_000));
    let url = `${this.base}/api/v1${path}`;
    const headers: Record<string, string> = { 'User-Agent': 'dither-accounts' };
    if (!opts.anonymous && c) headers.Authorization = this.auth(c);
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (method === 'GET' || method === 'DELETE') {
      const q = formOf(params).toString();
      if (q) url += `?${q}`;
    } else {
      body = formOf(params);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (e) {
      throw new ZulipError(`no answer from ${this.host}: ${(e as Error).message}`, 0, 'network');
    }
    this.limits(res.headers);
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.ok && json?.result !== 'error') return json as T;
    const code: string | null = typeof json?.code === 'string' ? json.code : null;
    const msg: string = typeof json?.msg === 'string' && json.msg ? json.msg : `HTTP ${res.status}`;
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after') ?? json?.['retry-after']);
      const retryAt = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 10_000);
      this.blockedUntil = Math.max(this.blockedUntil, retryAt);
      if (!opts.retried && retryAt - Date.now() <= 60_000) return this.call<T>(method, path, params, { ...opts, retried: true });
      throw new ZulipError(msg, 429, 'rate', code, retryAt);
    }
    if (code === 'BAD_EVENT_QUEUE_ID') throw new ZulipError(msg, res.status, 'queue', code);
    const failure: Failure = res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'missing' : 'http';
    throw new ZulipError(msg, res.status, failure, code);
  }

  get<T = any>(path: string, params?: Params, opts?: { timeoutMs?: number; anonymous?: boolean }) {
    return this.call<T>('GET', path, params, opts);
  }
  post<T = any>(path: string, params?: Params, opts?: { timeoutMs?: number; anonymous?: boolean }) {
    return this.call<T>('POST', path, params, opts);
  }
  patch<T = any>(path: string, params?: Params) {
    return this.call<T>('PATCH', path, params);
  }
  del<T = any>(path: string, params?: Params) {
    return this.call<T>('DELETE', path, params);
  }

  /** POST /user_uploads: the file's `url` on the server (`/user_uploads/…`). */
  async upload(name: string, bytes: Blob): Promise<{ url: string; filename?: string }> {
    const form = new FormData();
    form.append('file', bytes, name);
    return this.call('POST', '/user_uploads', undefined, { form, timeoutMs: 300_000 });
  }

  /** Fetches a file on the server with the key (an upload, an avatar served by the server). Refuses any other origin. */
  async fetchFile(pathOrUrl: string): Promise<Response> {
    const u = new URL(pathOrUrl, this.base);
    if (u.origin !== this.base) throw new ZulipError(`not on ${this.host}`, 400, 'http');
    const c = this.creds();
    const res = await this.fetchImpl(u.toString(), {
      headers: { 'User-Agent': 'dither-accounts', ...(c ? { Authorization: this.auth(c) } : {}) },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new ZulipError(`HTTP ${res.status} for a file`, res.status, res.status === 404 ? 'missing' : res.status === 401 ? 'auth' : 'http');
    return res;
  }

  private limits(h: Headers) {
    const rem = Number(h.get('x-ratelimit-remaining'));
    const reset = Number(h.get('x-ratelimit-reset'));
    if (Number.isFinite(rem) && h.has('x-ratelimit-remaining')) {
      this.remaining = rem;
      if (rem < RESERVE && Number.isFinite(reset) && reset > 0) this.waitUntil = Math.max(this.waitUntil, reset * 1000);
    }
  }
}
