/**
 * Google's REST API with one account's token: refreshed within a minute of expiry or after a 401 (once), and a 429,
 * 5xx or rate-limit 403 retried with growing waits (honouring Retry-After). A failure carries Google's HTTP status.
 */
import { StatusError } from '@dither-accounts/link';

export interface Secret {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number;
  email: string | null;
  sub: string | null;
  scopes: string[];
}

/** The grant is gone (revoked, expired, client changed): only signing in again helps. */
export class SignInNeeded extends Error {}

const EARLY = 60_000;
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
type Query = Record<string, string | number | boolean | undefined | null>;

export class Rest {
  private refreshing: Promise<string> | null = null;
  private readonly api = (process.env.DITHER_GOOGLE_API ?? 'https://www.googleapis.com').replace(/\/$/, '');
  private readonly tokenUrl = process.env.DITHER_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
  private readonly backoff = Number(process.env.DITHER_GOOGLE_BACKOFF_MS) || 500;
  private readonly retries = 4;

  constructor(
    private read: () => Secret,
    private save: (s: Secret) => void,
  ) {}

  async token(force = false): Promise<string> {
    const s = this.read();
    if (!s.refreshToken) throw new SignInNeeded('no Google sign-in for this account');
    if (!force && s.accessToken && s.expiresAt - EARLY > Date.now()) return s.accessToken;
    this.refreshing ??= this.refresh(s).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(s: Secret): Promise<string> {
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId, client_secret: s.clientSecret }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const out = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      if (out.error === 'invalid_grant') throw new SignInNeeded('Google sign-in expired; connect it again on the accounts page');
      if (out.error === 'invalid_client') throw new SignInNeeded('Google refused the client id or secret; check them on the accounts page');
      throw new StatusError(`Google token refresh failed: ${out.error ?? res.status}`, res.status);
    }
    if (!out.access_token) throw new StatusError('Google sent no access token', 502);
    this.save({ ...this.read(), accessToken: out.access_token, expiresAt: Date.now() + (Number(out.expires_in) || 3600) * 1000, refreshToken: out.refresh_token ?? s.refreshToken });
    return out.access_token;
  }

  async req<T = any>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const u = new URL(this.api + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      const res = await fetch(u, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        if (res.status === 204) return {} as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const err = (await res.json().catch(() => ({}))) as any;
      const reason: string | null = err?.error?.errors?.[0]?.reason ?? err?.error?.status ?? null;
      const message: string = err?.error?.message ?? `Google answered ${res.status}`;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.token(true);
        attempt--;
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && !!reason && RATE_REASONS.has(reason));
      if (retryable && attempt < this.retries) {
        const after = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : this.backoff * 2 ** attempt * (1 + Math.random() * 0.25);
        await Bun.sleep(Math.min(wait, 60_000));
        continue;
      }
      throw new StatusError(message, res.status);
    }
  }
}
