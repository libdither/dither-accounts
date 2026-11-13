/**
 * The page's login: one user, a password kept only as an argon2id hash, and long-lived sessions.
 *
 * - The password: <data>/login.json (0600) holds `{ user, hash, setAt }`, written by `cli.ts set-password` (from stdin
 *   or a file, never argv). With none, the page stays locked and the login page says how to set one. Setting it
 *   revokes every session.
 * - Sessions: an opaque random token in an HttpOnly, SameSite=Lax cookie (Secure when the page is served over https),
 *   kept here only as its sha256 with when it was made and last used, the browser's user agent and IP. It slides:
 *   90 days from its last use, never more than a year from its login. The page lists and revokes them.
 * - Failed logins back off per IP (and, far looser, overall): a few free, then a doubling wait up to 15 minutes.
 * - The CLI on this machine uses <data>/cli.token (0600, new each start) in `x-dither-accounts-cli`, from loopback
 *   and not through the proxy, so it needs no browser session.
 *
 * Apps and extractors never come here: their sockets and endpoints have their own tokens (http.ts).
 */
import type { Database } from 'bun:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionInfo } from './api-types.ts';
import { hashToken, newId, newToken } from './db.ts';

export const USER = 'admin';
export const COOKIE = 'dacc_session';
export const CLI_HEADER = 'x-dither-accounts-cli';
export const LOGIN_FILE = 'login.json';
export const CLI_TOKEN_FILE = 'cli.token';
const DAY = 86_400_000;
/** A session ends this long after its last use… */
export const SLIDING_MS = 90 * DAY;
/** …and never later than this after its login. */
export const ABSOLUTE_MS = 365 * DAY;
/** last_used is written at most this often; the cookie's Max-Age is renewed at most once a day. */
const TOUCH_MS = 60_000;
const REFRESH_MS = DAY;
export const MIN_PASSWORD = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  -- sha256 of the cookie's token: the token itself is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT,
  last_ip    TEXT
);
`;
export const ensureSessionTable = (db: Database) => db.exec(SCHEMA);

export interface PasswordFile {
  user: string;
  hash: string;
  setAt: number;
}

export function readPassword(dataDir: string): PasswordFile | null {
  try {
    const p = JSON.parse(readFileSync(join(dataDir, LOGIN_FILE), 'utf8')) as PasswordFile;
    return p && typeof p.hash === 'string' && p.hash.startsWith('$argon2id$') && typeof p.setAt === 'number' ? p : null;
  } catch {
    return null;
  }
}

/** The password's hash to <data>/login.json (0600, replaced whole), and every session revoked. */
export async function setPassword(dataDir: string, db: Database, password: string, now = Date.now()): Promise<void> {
  if (password.length < MIN_PASSWORD) throw new Error(`a password of at least ${MIN_PASSWORD} characters, please`);
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
  const file = join(dataDir, LOGIN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ user: USER, hash, setAt: now } satisfies PasswordFile)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  ensureSessionTable(db);
  db.query('DELETE FROM session').run();
}

/** Waits that double after a few free failures, per key. */
export class Backoff {
  private m = new Map<string, { fails: number; last: number; until: number }>();
  constructor(
    private free: number,
    private maxMs = 15 * 60_000,
  ) {}
  /** How long `key` must still wait, in ms (0: it may try). */
  wait(key: string, now: number): number {
    const e = this.m.get(key);
    return e ? Math.max(0, e.until - now) : 0;
  }
  fail(key: string, now: number) {
    if (this.m.size > 10_000) for (const [k, e] of this.m) if (now - e.last > DAY) this.m.delete(k);
    const e = this.m.get(key) ?? { fails: 0, last: now, until: 0 };
    if (now - e.last > DAY) e.fails = 0;
    e.fails++;
    e.last = now;
    if (e.fails >= this.free) e.until = now + Math.min(this.maxMs, 1000 * 2 ** (e.fails - this.free));
    this.m.set(key, e);
  }
  ok(key: string) {
    this.m.delete(key);
  }
}

export type LoginResult = { ok: true; token: string; maxAge: number } | { ok: false; status: 401 | 429 | 503; retryAfter?: number; error: string };

export class Auth {
  readonly cliToken: string;
  private cliHash: Buffer;
  private perIp = new Backoff(5);
  private overall = new Backoff(50);
  private pw: { key: string; file: PasswordFile | null } | null = null;

  constructor(
    private db: Database,
    private dataDir: string,
    private now: () => number = Date.now,
  ) {
    ensureSessionTable(db);
    this.cliToken = newToken();
    this.cliHash = Buffer.from(hashToken(this.cliToken), 'hex');
    const f = join(dataDir, CLI_TOKEN_FILE);
    writeFileSync(`${f}.tmp`, `${this.cliToken}\n`, { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }

  /** The password file, read again when it changes. */
  password(): PasswordFile | null {
    const file = join(this.dataDir, LOGIN_FILE);
    let key = 'none';
    if (existsSync(file)) {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    }
    if (this.pw?.key !== key) this.pw = { key, file: key === 'none' ? null : readPassword(this.dataDir) };
    return this.pw.file;
  }

  isCli(token: string | null): boolean {
    if (!token) return false;
    const h = Buffer.from(hashToken(token.trim()), 'hex');
    return h.length === this.cliHash.length && timingSafeEqual(h, this.cliHash);
  }

  async login(user: string, password: string, ip: string, userAgent: string | null): Promise<LoginResult> {
    const now = this.now();
    const wait = Math.max(this.perIp.wait(ip, now), this.overall.wait('*', now));
    if (wait > 0) return { ok: false, status: 429, retryAfter: Math.ceil(wait / 1000), error: `Too many tries. Wait ${Math.ceil(wait / 1000)} s.` };
    const pw = this.password();
    if (!pw) return { ok: false, status: 503, error: 'No password is set yet.' };
    const good = (await Bun.password.verify(password.slice(0, 1024), pw.hash).catch(() => false)) && user.trim() === pw.user;
    if (!good) {
      this.perIp.fail(ip, now);
      this.overall.fail('*', now);
      return { ok: false, status: 401, error: 'That username and password do not match.' };
    }
    this.perIp.ok(ip);
    this.sweep();
    const token = newToken();
    this.db
      .query('INSERT INTO session (id, token_hash, created_at, last_used, user_agent, ip, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('ses'), hashToken(token), now, now, userAgent?.slice(0, 300) ?? null, ip || null, ip || null);
    return { ok: true, token, maxAge: Math.floor(SLIDING_MS / 1000) };
  }

  private expiresAt(r: { created_at: number; last_used: number }) {
    return Math.min(r.last_used + SLIDING_MS, r.created_at + ABSOLUTE_MS);
  }
  private alive(r: { created_at: number; last_used: number }, now: number) {
    const pw = this.password();
    return !!pw && r.created_at >= pw.setAt && this.expiresAt(r) > now;
  }

  /**
   * The session a cookie's token names, if it is still good: its last use is noted (at most once a minute), and
   * `refresh` gives the cookie's new Max-Age when it is due to be sent again (at most once a day).
   */
  session(token: string | null, ip: string): { id: string; refresh: number | null } | null {
    if (!token || token.length > 200) return null;
    const r = this.db.query('SELECT * FROM session WHERE token_hash = ?').get(hashToken(token)) as { id: string; created_at: number; last_used: number; last_ip: string | null } | null;
    if (!r) return null;
    const now = this.now();
    if (!this.alive(r, now)) {
      this.db.query('DELETE FROM session WHERE id = ?').run(r.id);
      return null;
    }
    let refresh: number | null = null;
    if (now - r.last_used >= TOUCH_MS || (ip && ip !== r.last_ip)) {
      this.db.query('UPDATE session SET last_used = ?, last_ip = ? WHERE id = ?').run(now, ip || r.last_ip, r.id);
      if (now - r.last_used >= REFRESH_MS) refresh = Math.floor((this.expiresAt({ created_at: r.created_at, last_used: now }) - now) / 1000);
    }
    return { id: r.id, refresh };
  }

  /** Ended sessions go. */
  sweep() {
    const now = this.now();
    const pw = this.password();
    this.db.query('DELETE FROM session WHERE last_used < ? OR created_at < ? OR created_at < ?').run(now - SLIDING_MS, now - ABSOLUTE_MS, pw?.setAt ?? Number.MAX_SAFE_INTEGER);
  }

  list(current: string | null): SessionInfo[] {
    this.sweep();
    return (this.db.query('SELECT * FROM session ORDER BY last_used DESC').all() as any[]).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      lastUsed: r.last_used,
      expiresAt: this.expiresAt(r),
      userAgent: r.user_agent,
      ip: r.ip,
      lastIp: r.last_ip,
      current: r.id === current,
    }));
  }

  revoke(id: string): boolean {
    return this.db.query('DELETE FROM session WHERE id = ?').run(id).changes > 0;
  }
  revokeAll(except: string | null = null): number {
    return this.db.query('DELETE FROM session WHERE id != ?').run(except ?? '').changes;
  }
}

// ---------------------------------------------------------------- the HTTP side's helpers

export function cookieOf(req: Request, name = COOKIE): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * A browser write's origin is this page's own: its Origin (or, without one, its Referer) names the host it was sent
 * to. A write with neither is refused; tools without a browser use the CLI token, not a cookie.
 */
export function fromOwnPage(req: Request): boolean {
  const host = req.headers.get('host');
  const from = req.headers.get('origin') ?? req.headers.get('referer');
  if (!host || !from || from === 'null') return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
}

/** Where to go after logging in: a path on this site, nothing else. */
export function safeNext(v: string | null | undefined): string {
  return typeof v === 'string' && /^\/(?![/\\])[^\r\n]{0,2000}$/.test(v) && !v.startsWith('/login') ? v : '/';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The login page: a plain form a password manager fills (username, current-password), or how to set a password. */
export function loginPage(o: { next: string; error?: string; noPassword?: boolean }): string {
  const body = o.noPassword
    ? `<h1>Set a password first</h1>
<p>The page stays locked until the manager has a password. On this machine, run</p>
<pre>bun packages/manager/src/cli.ts set-password --file &lt;file&gt;</pre>
<p>with the password in that file (or on stdin), then reload.</p>`
    : `<h1>Sign in</h1>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(o.next)}">
<label for="u">Username</label>
<input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${USER}" required>
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>
</form>
<script>var n=document.querySelector('[name=next]');if(n&&location.hash&&n.value.indexOf('#')<0)n.value+=location.hash;</script>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accounts: sign in</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#ddddd8;--accent:#2d5bd7;--err:#b3261e}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--card:#20201f;--fg:#ececea;--muted:#a0a09a;--line:#353533;--accent:#7d9cff;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 16px}label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:0 0 8px}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font-size:13px}p{margin:0 0 10px}
</style></head><body><main>${body}</main></body></html>`;
}
