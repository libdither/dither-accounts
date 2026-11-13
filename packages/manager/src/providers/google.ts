/**
 * Google sign-in: an OAuth web-application client with PKCE (moved here from dither-calendar). Each Google account you
 * connect becomes an account of kind `google-api`, whose extractor (extractors/google-api) holds its token and answers
 * the interfaces its scopes allow. Apps never see the token; they ask for `google.calendar` and you approve. (Kind
 * `google` is the other way in: a browser you sign in to once, extractors/google; docs/google.md.)
 *
 * Kept, all mode 0600, never in the registry, never in a response, never in a log:
 *   <data>/providers/google.json             { clientId, clientSecret }
 *   <data>/accounts/<id>/secret.json         { clientId, clientSecret, refreshToken, accessToken, expiresAt, email, sub, scopes }
 * The account's config (which the page shows) has only { email, sub, scopes }, scopes by short name.
 *
 * Scopes are asked per account and only grow (include_granted_scopes): `calendar` now; another short name in SCOPES
 * (Gmail later) is asked with /oauth/google/start?account=<id>&scopes=calendar,gmail.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, newToken, type Row } from '../db.ts';
import { accountDir, releaseLock, writeSecret } from '../supervisor.ts';
import type { Provider, ProviderContext, ProviderFactory } from './index.ts';

/** Short names for the scopes accounts may be asked for. */
export const SCOPES: Record<string, string> = {
  calendar: 'https://www.googleapis.com/auth/calendar',
};
const BASE_SCOPES = ['openid', 'email'];
/** The kind of the accounts this makes (extractors/google-api). */
export const KIND = 'google-api';
/** How long a consent screen may stay open before its state is forgotten. */
const STATE_TTL = 10 * 60_000;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleSecret extends GoogleClient {
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number;
  email: string | null;
  sub: string | null;
  /** Granted scopes, as Google lists them. */
  scopes: string[];
}

export interface GoogleProviderStatus {
  configured: boolean;
  redirectUri: string;
  accounts: { id: string; email: string | null; scopes: string[] }[];
  error: string | null;
}

/** Endpoints, overridable by env (tests point them at a fake Google). Read per use, so a test may set them late. */
export const endpoints = () => ({
  oauthUrl: process.env.DITHER_GOOGLE_OAUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: process.env.DITHER_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  revokeUrl: process.env.DITHER_GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
});

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');

function writeJson0600(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
  } catch {
    return null;
  }
}

/** The email and subject in an id_token. It came straight from Google's token endpoint over TLS, so it is not verified again. */
export function idToken(t: unknown): { email: string | null; sub: string | null } {
  if (typeof t !== 'string') return { email: null, sub: null };
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return { email: typeof p.email === 'string' ? p.email : null, sub: typeof p.sub === 'string' ? p.sub : null };
  } catch {
    return { email: null, sub: null };
  }
}

/** Short names of the scopes Google granted. */
export function shortScopes(granted: string[]): string[] {
  return Object.entries(SCOPES)
    .filter(([, url]) => granted.includes(url))
    .map(([k]) => k);
}

class GoogleProvider implements Provider {
  readonly name = 'google';
  private states = new Map<string, { verifier: string; at: number; account: string | null; scopes: string[] }>();
  private error: string | null = null;
  private readonly clientPath: string;
  private readonly redirectUri: string;

  constructor(private ctx: ProviderContext) {
    const dir = join(ctx.dataDir, 'providers');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.clientPath = join(dir, 'google.json');
    this.redirectUri = `${ctx.publicUrl}/oauth/google/callback`;
  }

  client(): GoogleClient | null {
    const c = readJson<GoogleClient>(this.clientPath);
    return c?.clientId && c?.clientSecret ? c : null;
  }

  private googleAccounts(): Row[] {
    return this.ctx.store.all('SELECT * FROM account WHERE kind = ? ORDER BY created_at', KIND);
  }

  status(): GoogleProviderStatus {
    return {
      configured: !!this.client(),
      redirectUri: this.redirectUri,
      accounts: this.googleAccounts().map((a) => {
        const c = JSON.parse(a.config || '{}');
        return { id: a.id, email: c.email ?? null, scopes: Array.isArray(c.scopes) ? c.scopes : [] };
      }),
      error: this.error,
    };
  }

  private setClient(c: GoogleClient) {
    const old = this.client();
    writeJson0600(this.clientPath, c);
    // The same client with a new secret: accounts keep working once they have it. A different client's tokens are
    // no good with this one; those accounts show "connect again" when their next refresh is refused.
    if (old?.clientId === c.clientId && old.clientSecret !== c.clientSecret) {
      for (const a of this.googleAccounts()) {
        const s = readJson<GoogleSecret>(join(a.dir, 'secret.json'));
        if (s?.clientId !== c.clientId) continue;
        writeSecret(a, { ...s, clientSecret: c.clientSecret });
        void this.ctx.sup.restart(a.id);
      }
    }
    this.error = null;
  }

  private consentUrl(account: string | null, scopes: string[]): string {
    const c = this.client();
    if (!c) throw new Error('not_configured');
    const now = Date.now();
    for (const [k, v] of this.states) if (now - v.at > STATE_TTL) this.states.delete(k);
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    this.states.set(state, { verifier, at: now, account, scopes });
    const u = new URL(endpoints().oauthUrl);
    const p = u.searchParams;
    p.set('client_id', c.clientId);
    p.set('redirect_uri', this.redirectUri);
    p.set('response_type', 'code');
    p.set('scope', [...scopes.map((s) => SCOPES[s]), ...BASE_SCOPES].join(' '));
    p.set('access_type', 'offline');
    p.set('prompt', 'consent');
    p.set('include_granted_scopes', 'true');
    p.set('state', state);
    p.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    p.set('code_challenge_method', 'S256');
    if (account) {
      const email = JSON.parse(this.ctx.store.account(account)?.config || '{}').email;
      if (email) p.set('login_hint', email);
    }
    return u.toString();
  }

  /** The callback: trade the code for tokens, then make or update the account. Returns its id. */
  private async finish(code: string, state: string): Promise<string> {
    const s = this.states.get(state);
    this.states.delete(state);
    if (!s || Date.now() - s.at > STATE_TTL) throw new Error('bad_state');
    const c = this.client();
    if (!c) throw new Error('not_configured');
    const res = await fetch(endpoints().tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: this.redirectUri, code_verifier: s.verifier }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const out = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(typeof out.error === 'string' ? out.error : `http_${res.status}`);

    const who = idToken(out.id_token);
    const st = this.ctx.store;
    // The same Google account connected before (or the one being re-consented): update it.
    const existing =
      (s.account ? st.account(s.account) : null) ??
      this.googleAccounts().find((a) => {
        const cfg = JSON.parse(a.config || '{}');
        return (who.sub && cfg.sub === who.sub) || (!who.sub && who.email && cfg.email === who.email);
      }) ??
      null;
    const prev = existing ? readJson<GoogleSecret>(join(existing.dir, 'secret.json')) : null;
    // With prompt=consent Google sends a refresh token every time; without, only the first time.
    const refreshToken = out.refresh_token ?? prev?.refreshToken;
    if (!refreshToken) throw new Error('no_refresh_token');
    const granted = typeof out.scope === 'string' ? out.scope.split(/\s+/).filter(Boolean) : (prev?.scopes ?? []);
    const secret: GoogleSecret = {
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      refreshToken,
      accessToken: out.access_token ?? null,
      expiresAt: Date.now() + (Number(out.expires_in) || 3600) * 1000,
      email: who.email ?? prev?.email ?? null,
      sub: who.sub ?? prev?.sub ?? null,
      scopes: granted,
    };
    const config = JSON.stringify({ email: secret.email, sub: secret.sub, scopes: shortScopes(granted) });
    const label = (secret.email ?? 'Google').slice(0, 200);
    const now = Date.now();

    if (existing) {
      writeSecret(existing, secret);
      st.run('UPDATE account SET label = ?, config = ?, enabled = 1, updated_at = ? WHERE id = ?', label, config, now, existing.id);
      await this.ctx.sup.restart(existing.id);
      this.ctx.router.accountsChanged();
      return existing.id;
    }
    const id = newId('acc');
    const dir = accountDir(this.ctx.dataDir, id);
    st.run(
      'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
      id,
      KIND,
      label,
      config,
      newToken(),
      dir,
      now,
      now,
    );
    writeSecret(st.account(id)!, secret);
    this.ctx.sup.start(id);
    this.ctx.router.accountsChanged();
    return id;
  }

  /** Revoke at Google (best effort), stop the extractor, forget the account and its directory (it held only the token). */
  private async disconnect(a: Row) {
    const s = readJson<GoogleSecret>(join(a.dir, 'secret.json'));
    await this.ctx.sup.stop(a.id);
    releaseLock(a.dir);
    this.ctx.store.run('DELETE FROM account WHERE id = ?', a.id);
    rmSync(a.dir, { recursive: true, force: true });
    this.ctx.router.accountsChanged();
    if (s?.refreshToken)
      await fetch(endpoints().revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refreshToken }).toString(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
  }

  routes = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    const method = req.method;
    const back = (q = '') => new Response(null, { status: 302, headers: { location: `/#/accounts${q}`, 'cache-control': 'no-store' } });
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    let m: RegExpMatchArray | null;

    if (path === '/api/providers/google' && method === 'GET') return Response.json(this.status());
    if (path === '/api/providers/google/client' && method === 'PUT') {
      const b = (await req.json().catch(() => ({}))) as { clientId?: unknown; clientSecret?: unknown };
      const id = typeof b.clientId === 'string' ? b.clientId.trim() : '';
      const secret = typeof b.clientSecret === 'string' ? b.clientSecret.trim() : '';
      if (!id || !secret || id.length > 300 || secret.length > 300 || /\s/.test(id + secret)) return bad('a client id and secret are needed');
      this.setClient({ clientId: id, clientSecret: secret });
      return Response.json(this.status());
    }
    if (path === '/oauth/google/start' && method === 'GET') {
      const account = url.searchParams.get('account');
      const acc = account ? this.ctx.store.account(account) : null;
      if (account && acc?.kind !== KIND) return back(`?google_error=${encodeURIComponent('no such Google account')}`);
      const asked = (url.searchParams.get('scopes') ?? 'calendar').split(',').filter((x) => SCOPES[x]);
      const had = acc ? (JSON.parse(acc.config || '{}').scopes ?? []) : [];
      const scopes = [...new Set([...had, ...(asked.length ? asked : ['calendar'])])].filter((x) => SCOPES[x]);
      try {
        return new Response(null, { status: 302, headers: { location: this.consentUrl(acc?.id ?? null, scopes), 'cache-control': 'no-store' } });
      } catch (e) {
        return back(`?google_error=${encodeURIComponent((e as Error).message)}`);
      }
    }
    if (path === '/oauth/google/callback' && method === 'GET') {
      const err = url.searchParams.get('error');
      if (err) return back(`?google_error=${encodeURIComponent(err.slice(0, 100))}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return back('?google_error=missing_code');
      try {
        await this.finish(code, state);
      } catch (e) {
        const reason = String((e as Error)?.message ?? e).slice(0, 100);
        this.error = `Google sign-in failed: ${reason}`;
        return back(`?google_error=${encodeURIComponent(reason)}`);
      }
      this.error = null;
      return back();
    }
    if ((m = path.match(/^\/api\/providers\/google\/accounts\/([\w-]+)$/)) && method === 'DELETE') {
      const a = this.ctx.store.account(m[1]);
      if (!a || a.kind !== KIND) return bad('no such Google account', 404);
      await this.disconnect(a);
      return Response.json(this.status());
    }
    return null;
  };
}

export const googleProvider: ProviderFactory = (ctx) => new GoogleProvider(ctx);
