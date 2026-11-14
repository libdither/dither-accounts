/**
 * The CLIProxyAPI hub (docs/claude.md): Claude subscriptions pooled for Claude Code on every machine, the setup
 * described in https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af. The hub itself runs outside this
 * manager (run it yourself; it listens on 127.0.0.1:8317 by default); this provider signs it in to each Claude account
 * and keeps it so.
 *
 * Signing a Claude account in (a link job), with no hands:
 *   1. the account's `claude` extractor asks claude.ai to email a sign-in link (claude.signin.start), unless it is
 *      signed in already;
 *   2. the link is read from the mail account here that has that address (mail.search, then mail.get), and opened in
 *      the sandbox (claude.signin.finish);
 *   3. the hub makes an OAuth request (GET /v0/management/anthropic-auth-url), the extractor approves it on claude.ai
 *      and hands back the localhost callback URL (claude.authorize), which goes to the hub (POST oauth-callback); the
 *      hub redeems the code (PKCE) and keeps the token in its own auth dir. The token never passes through here.
 *
 * A watchdog looks at the hub every few minutes: an account whose sign-in the hub can no longer renew (next_action
 * sign_in, or a refresh refused) is linked again by itself, at most once every 6 hours; and each credential's priority
 * is set so the account whose weekly limit resets soonest is used first (what a fork of the hub adds), from the
 * anthropic-ratelimit-unified-7d-reset the hub saw last.
 *
 * Kept: <data>/providers/cliproxy.json (0600) { url, managementKey }, set by PUT /api/providers/cliproxy/hub (`cli.ts
 * cliproxy connect [keys.env]` reads the hub's keys.env for it; with no file given it tries
 * ~/.local/share/cliproxyapi/keys.env), or else the keys.env that $DITHER_CLIPROXY_KEYS names. The manager itself
 * tries no default path: a test's manager must not find a real hub. The account's config gets { email, mailAccount?,
 * authFile? }. Never logged: the link, the authorize URL, the callback, a key.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, newToken, type Row } from '../db.ts';
import { CallFailure } from '../router.ts';
import { accountDir } from '../supervisor.ts';
import type { Provider, ProviderContext, ProviderFactory } from './index.ts';

export const KIND = 'claude';
const RELINK_EVERY = 6 * 3600_000;
const JOB_KEEP = 24 * 3600_000;

export interface Hub {
  url: string;
  managementKey: string;
}

export type Step = 'starting' | 'signing-in' | 'waiting-for-mail' | 'opening-link' | 'authorizing' | 'exchanging' | 'done' | 'needs-you' | 'error';
export interface Job {
  id: string;
  account: string;
  email: string;
  step: Step;
  error: string | null;
  /** The live view has what stopped it. */
  liveView: boolean;
  auto: boolean;
  startedAt: number;
  updatedAt: number;
  authFile: string | null;
}

export interface HubFile {
  name: string;
  provider: string;
  email: string | null;
  disabled: boolean;
  status: string | null;
  needsSignIn: boolean;
  refreshError: string | null;
  priority: number | null;
  weeklyResetAt: number | null;
}

// ------------------------------------------------------------------ pure parts (test/cliproxy.test.ts)

/** CLIPROXY_URL / CLIPROXY_MANAGEMENT_KEY from the hub's keys.env. */
export function hubFromEnvFile(text: string): Hub | null {
  const v: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) v[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return v.CLIPROXY_MANAGEMENT_KEY ? { url: (v.CLIPROXY_URL || 'http://127.0.0.1:8317').replace(/\/$/, ''), managementKey: v.CLIPROXY_MANAGEMENT_KEY } : null;
}

/** The sign-in link in one of claude.ai's "Your secure link to Claude is here" mails. */
export function magicLinkIn(text: string | null, html: string | null, base = 'https://claude.ai'): string | null {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}/magic-link#[A-Za-z0-9_\\-.~%:=+/]+`);
  for (const s of [html?.replaceAll('&amp;', '&') ?? '', text ?? '']) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

const num = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** When the weekly limit resets, from the hub's quota signals (unix seconds, ms, or a date), or null. */
export function weeklyReset(signals: unknown): number | null {
  if (!signals || typeof signals !== 'object') return null;
  for (const [k, v] of Object.entries(signals as Record<string, unknown>)) {
    if (!/7d/i.test(k) || !/reset/i.test(k) || /after/i.test(k)) continue;
    const n = num(v);
    if (n !== null) return n < 1e12 ? n * 1000 : n;
    const d = typeof v === 'string' ? Date.parse(v) : Number.NaN;
    if (Number.isFinite(d)) return d;
  }
  return null;
}

/** An auth-files entry, as far as this provider needs it. */
export function hubFile(e: Record<string, any>): HubFile {
  const re = e.refresh_error && typeof e.refresh_error === 'object' ? e.refresh_error : null;
  return {
    name: String(e.name ?? e.id ?? ''),
    provider: String(e.provider ?? e.type ?? '').toLowerCase(),
    email: typeof e.email === 'string' ? e.email : typeof e.account === 'string' && e.account.includes('@') ? e.account : null,
    disabled: !!e.disabled,
    status: typeof e.status === 'string' ? e.status : null,
    needsSignIn: e.next_action === 'sign_in',
    refreshError: re ? [re.code, re.http_status, re.message].filter((x) => x !== undefined && x !== null && x !== '').join(' ').slice(0, 200) : null,
    priority: num(e.priority ?? e.attributes?.priority),
    weeklyResetAt: weeklyReset(e.quota?.signals),
  };
}

const isClaude = (f: HubFile) => f.provider === 'claude' || f.provider === 'anthropic';

/** The hub can no longer renew this sign-in by itself. */
export const needsRelink = (f: HubFile) => f.needsSignIn || /\b(400|401|invalid_grant|unauthorized)\b/i.test(f.refreshError ?? '');

/**
 * Priorities for soonest-reset-first: the enabled Claude credentials with a known weekly reset, soonest first, get
 * descending priorities (n … 1). One whose reset is not known yet (no response seen since the hub started) ranks with
 * the soonest, so it gets traffic and its reset becomes known. Disabled ones get 0. Ties take turns (round-robin), and a
 * session stays on its account (session-affinity).
 */
export function soonestResetPriorities(files: HubFile[]): Map<string, number> {
  const on = files.filter((f) => isClaude(f) && !f.disabled);
  const known = on.filter((f) => f.weeklyResetAt !== null).sort((a, b) => a.weeklyResetAt! - b.weeklyResetAt!);
  const out = new Map<string, number>();
  for (const f of files) if (isClaude(f)) out.set(f.name, 0);
  known.forEach((f, i) => out.set(f.name, known.length - i));
  for (const f of on) if (f.weeklyResetAt === null) out.set(f.name, known.length);
  return out;
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the provider

class CliproxyProvider implements Provider {
  readonly name = 'cliproxy';
  private jobs = new Map<string, Job>();
  private running = new Map<string, Promise<void>>();
  private lastAuto = new Map<string, number>();
  private usedMail = new Set<string>();
  private setPriorities = new Map<string, number>();
  private files: HubFile[] = [];
  private hubError: string | null = null;
  private watchedAt = 0;
  private timer: Timer | undefined;
  private first: Timer | undefined;
  private readonly path: string;

  constructor(private ctx: ProviderContext) {
    const dir = join(ctx.dataDir, 'providers');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'cliproxy.json');
    const every = Number(process.env.DITHER_CLIPROXY_WATCH_MS) || 5 * 60_000;
    // The first look waits for the accounts to start.
    this.timer = setInterval(() => void this.watch(), every);
    this.first = setTimeout(() => void this.watch(), Math.min(every, 60_000));
    this.timer.unref?.();
    this.first.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.first);
  }

  hub(): Hub | null {
    try {
      if (existsSync(this.path)) {
        const h = JSON.parse(readFileSync(this.path, 'utf8'));
        if (h?.url && h?.managementKey) return { url: String(h.url).replace(/\/$/, ''), managementKey: String(h.managementKey) };
      }
    } catch {}
    const env = process.env.DITHER_CLIPROXY_KEYS;
    try {
      return env && existsSync(env) ? hubFromEnvFile(readFileSync(env, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  private setHub(h: Hub) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const h = this.hub();
    if (!h) throw new Error('no hub: set one with PUT /api/providers/cliproxy/hub (or set DITHER_CLIPROXY_KEYS to the hub\'s keys.env)');
    const r = await fetch(`${h.url}/v0/management${path}`, {
      method,
      headers: { authorization: `Bearer ${h.managementKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(`hub ${method} ${path.split('?')[0]}: ${r.status} ${typeof j.error === 'string' ? j.error.slice(0, 200) : ''}`.trim());
    return j as T;
  }

  async hubFiles(): Promise<HubFile[]> {
    const j = await this.api<{ files?: Record<string, any>[] }>('GET', '/auth-files');
    return (j.files ?? []).map(hubFile).filter((f) => f.name);
  }

  private claudeAccounts(): Row[] {
    return this.ctx.store.all('SELECT * FROM account WHERE kind = ? ORDER BY created_at', KIND);
  }
  private config(a: Row): Record<string, any> {
    try {
      return JSON.parse(a.config || '{}');
    } catch {
      return {};
    }
  }
  private setConfig(id: string, patch: Record<string, unknown>) {
    const a = this.ctx.store.account(id);
    if (!a) return;
    this.ctx.store.run('UPDATE account SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...this.config(a), ...patch }), Date.now(), id);
  }

  /** The mail account here that has this address: its status or what it was seen as names it. */
  mailAccountFor(email: string, pinned?: string | null): Row | null {
    const mailKinds = [...this.ctx.kinds.values()].filter((k) => k.interfaces.includes('mail')).map((k) => k.kind);
    const rows = this.ctx.store.all('SELECT * FROM account WHERE enabled = 1').filter((a) => mailKinds.includes(a.kind));
    if (pinned) return rows.find((a) => a.id === pinned) ?? null;
    const needle = email.trim().toLowerCase();
    return rows.find((a) => `${JSON.stringify(this.ctx.router.lastEvent(a.id, 'status') ?? {})} ${a.seen_as ?? ''} ${a.label ?? ''}`.toLowerCase().includes(needle)) ?? null;
  }

  status() {
    const h = this.hub();
    return {
      hub: h ? { url: h.url } : null,
      hubError: this.hubError,
      watchedAt: this.watchedAt || null,
      accounts: this.claudeAccounts().map((a) => {
        const c = this.config(a);
        const f = this.files.find((x) => (c.authFile && x.name === c.authFile) || (isClaude(x) && sameEmail(x.email, c.email))) ?? null;
        const job = [...this.jobs.values()].filter((j) => j.account === a.id).sort((x, y) => y.startedAt - x.startedAt)[0] ?? null;
        return { id: a.id, label: a.label, email: c.email ?? null, mailAccount: c.mailAccount ?? null, authFile: f, job };
      }),
      otherFiles: this.files.filter((f) => !this.claudeAccounts().some((a) => sameEmail(this.config(a).email, f.email))),
    };
  }

  // ------------------------------------------------------------ jobs
  /** Make the `claude` account for an email (or find it), and start linking it. */
  addClaude(email: string, mailAccount: string | null): Job {
    let a = this.claudeAccounts().find((x) => sameEmail(this.config(x).email, email)) ?? null;
    if (!a) {
      const id = newId('acc');
      const now = Date.now();
      this.ctx.store.run(
        'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
        id,
        KIND,
        `Claude ${email}`.slice(0, 200),
        JSON.stringify({ email, ...(mailAccount ? { mailAccount } : {}) }),
        newToken(),
        accountDir(this.ctx.dataDir, id),
        now,
        now,
      );
      this.ctx.sup.start(id);
      this.ctx.router.accountsChanged();
      a = this.ctx.store.account(id)!;
    } else if (mailAccount) this.setConfig(a.id, { mailAccount });
    return this.link(a.id, false);
  }

  link(accountId: string, auto: boolean): Job {
    const a = this.ctx.store.account(accountId);
    if (!a || a.kind !== KIND) throw new Error('no such Claude account');
    const running = [...this.jobs.values()].find((j) => j.account === accountId && !['done', 'needs-you', 'error'].includes(j.step));
    if (running) return running;
    const now = Date.now();
    for (const [k, j] of this.jobs) if (now - j.updatedAt > JOB_KEEP) this.jobs.delete(k);
    const job: Job = { id: newId('job'), account: accountId, email: this.config(a).email ?? '', step: 'starting', error: null, liveView: false, auto, startedAt: now, updatedAt: now, authFile: null };
    this.jobs.set(job.id, job);
    const p = this.run(job).finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return job;
  }

  job(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  private set(job: Job, step: Step, error: string | null = null) {
    job.step = step;
    job.error = error;
    job.updatedAt = Date.now();
    console.log(`[cliproxy] ${job.id} ${job.account}: ${step}${error ? `: ${error}` : ''}`);
  }

  /** An op on an account, retried while its extractor is still starting. */
  private async call<T>(account: string, op: string, input: Record<string, unknown> = {}, waitMs = 120_000): Promise<T> {
    const end = Date.now() + waitMs;
    for (;;) {
      try {
        return (await this.ctx.router.callAsPage(account, op, input)) as T;
      } catch (e) {
        const code = e instanceof CallFailure ? e.error.code : null;
        if ((code === 'offline' || code === 'starting') && Date.now() < end) {
          await sleep(3000);
          continue;
        }
        throw e;
      }
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      if (!this.hub()) throw new Error('no hub configured');
      const a = this.ctx.store.account(job.account)!;
      const cfg = this.config(a);
      if (!cfg.email) throw new Error('the Claude account has no email');

      this.set(job, 'signing-in');
      const sess = await this.call<{ signedIn: boolean | null; email: string | null }>(job.account, 'claude.session');
      if (!(sess.signedIn && sameEmail(sess.email, cfg.email))) {
        const mail = this.mailAccountFor(cfg.email, cfg.mailAccount);
        if (!mail) throw new Error(`no mail account here has ${cfg.email}; add it, or pass mailAccount`);
        const start = await this.call<{ already: boolean; requestedAt: number | null }>(job.account, 'claude.signin.start');
        if (!start.already) {
          this.set(job, 'waiting-for-mail');
          const link = await this.awaitLink(mail.id, start.requestedAt ?? Date.now());
          this.set(job, 'opening-link');
          await this.call(job.account, 'claude.signin.finish', { link });
        }
      }

      this.set(job, 'authorizing');
      const auth = await this.api<{ url?: string; state?: string }>('GET', '/anthropic-auth-url');
      if (!auth.url || !auth.state) throw new Error('the hub gave no authorize URL');
      const { callbackUrl } = await this.call<{ callbackUrl: string }>(job.account, 'claude.authorize', { url: auth.url });

      this.set(job, 'exchanging');
      await this.api('POST', '/oauth-callback', { provider: 'anthropic', redirect_url: callbackUrl });
      const end = Date.now() + 90_000;
      for (;;) {
        const s = await this.api<{ status?: string; error?: string }>('GET', `/get-auth-status?state=${encodeURIComponent(auth.state)}`);
        if (s.status === 'ok') break;
        if (s.status === 'error') throw new Error(`the hub could not redeem the sign-in: ${s.error ?? 'error'}`);
        if (Date.now() > end) throw new Error('the hub did not finish the sign-in in 90 s');
        await sleep(1000);
      }
      const files = await this.hubFiles().catch(() => [] as HubFile[]);
      this.files = files.length ? files : this.files;
      const f = files.find((x) => isClaude(x) && sameEmail(x.email, cfg.email)) ?? null;
      job.authFile = f?.name ?? null;
      if (f) this.setConfig(job.account, { authFile: f.name });
      this.set(job, 'done');
    } catch (e) {
      const code = e instanceof CallFailure ? e.error.code : null;
      if (code === 'needs-you') {
        job.liveView = true;
        this.set(job, 'needs-you', e instanceof Error ? e.message : String(e));
      } else this.set(job, 'error', (e instanceof Error ? e.message : String(e)).slice(0, 500));
    }
  }

  /** The sign-in link claude.ai mailed after `since`, from the mail account (up to 4 minutes). */
  private async awaitLink(mailAccount: string, since: number): Promise<string> {
    const end = Date.now() + 4 * 60_000;
    while (Date.now() < end) {
      const r = await this.call<{ messages: { id: string; from: { email: string }[]; subject: string; date: number; receivedAt: number }[] }>(mailAccount, 'mail.search', {
        query: 'secure link to Claude',
        limit: 5,
      }).catch(() => ({ messages: [] }));
      const fresh = r.messages
        .filter((m) => !this.usedMail.has(m.id))
        .filter((m) => Math.max(m.receivedAt || 0, m.date || 0) >= since - 60_000)
        .filter((m) => m.from.some((f) => /@mail\.anthropic\.com$/i.test(f.email) || /@anthropic\.com$/i.test(f.email)))
        .sort((a, b) => (b.receivedAt || b.date) - (a.receivedAt || a.date));
      for (const m of fresh) {
        const full = await this.call<{ text: string | null; html: string | null }>(mailAccount, 'mail.get', { id: m.id }).catch(() => null);
        const link = full ? magicLinkIn(full.text, full.html) : null;
        this.usedMail.add(m.id);
        if (link) return link;
      }
      await sleep(4000);
    }
    throw new Error('no sign-in link arrived in 4 minutes');
  }

  // ------------------------------------------------------------ watchdog
  async watch(): Promise<void> {
    if (!this.hub()) return;
    let files: HubFile[];
    try {
      files = await this.hubFiles();
      this.hubError = null;
    } catch (e) {
      this.hubError = String((e as Error).message ?? e).slice(0, 300);
      return;
    }
    this.files = files;
    this.watchedAt = Date.now();
    for (const a of this.claudeAccounts()) {
      if (!a.enabled) continue;
      const c = this.config(a);
      const f = files.find((x) => (c.authFile && x.name === c.authFile) || (isClaude(x) && sameEmail(x.email, c.email)));
      if (!f || !needsRelink(f) || f.disabled) continue;
      if (Date.now() - (this.lastAuto.get(a.id) ?? 0) < RELINK_EVERY) continue;
      this.lastAuto.set(a.id, Date.now());
      console.log(`[cliproxy] ${a.id}: the hub can no longer renew its sign-in (${f.needsSignIn ? 'sign_in' : f.refreshError}); linking it again`);
      this.link(a.id, true);
    }
    for (const [name, p] of soonestResetPriorities(files)) {
      const had = files.find((f) => f.name === name)?.priority ?? 0;
      if ((this.setPriorities.get(name) ?? had) === p && had === p) continue;
      try {
        await this.api('PATCH', '/auth-files/fields', { name, priority: p });
        this.setPriorities.set(name, p);
      } catch (e) {
        this.hubError = `priority for ${name}: ${String((e as Error).message ?? e).slice(0, 200)}`;
      }
    }
  }

  // ------------------------------------------------------------ routes
  routes = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (!path.startsWith('/api/providers/cliproxy')) return null;
    const method = req.method;
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    const body = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>;
    let m: RegExpMatchArray | null;

    if (path === '/api/providers/cliproxy' && method === 'GET') {
      if (url.searchParams.get('fresh') === '1') await this.watch();
      return json(this.status());
    }
    if (path === '/api/providers/cliproxy/hub' && method === 'PUT') {
      const b = await body();
      const u = typeof b.url === 'string' ? b.url.trim() : '';
      const k = typeof b.managementKey === 'string' ? b.managementKey.trim() : '';
      if (!/^https?:\/\/[^\s]+$/.test(u) || !k || k.length > 300) return bad('a hub url and its management key are needed');
      this.setHub({ url: u.replace(/\/$/, ''), managementKey: k });
      await this.watch();
      return json(this.status());
    }
    if (path === '/api/providers/cliproxy/claude' && method === 'POST') {
      const b = await body();
      const email = typeof b.email === 'string' ? b.email.trim() : '';
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return bad('an email is needed');
      const mailAccount = typeof b.mailAccount === 'string' && b.mailAccount ? b.mailAccount : null;
      if (mailAccount && !this.mailAccountFor(email, mailAccount)) return bad('no such mail account', 404);
      if (!this.hub()) return bad('no hub configured', 409);
      return json({ job: this.addClaude(email, mailAccount) });
    }
    if ((m = path.match(/^\/api\/providers\/cliproxy\/jobs\/([\w-]+)$/)) && method === 'GET') {
      const j = this.job(m[1]);
      return j ? json({ job: j }) : bad('no such job', 404);
    }
    if ((m = path.match(/^\/api\/providers\/cliproxy\/claude\/([\w-]+)\/(relink|enable|disable)$/)) && method === 'POST') {
      const a = this.ctx.store.account(m[1]);
      if (!a || a.kind !== KIND) return bad('no such Claude account', 404);
      if (m[2] === 'relink') return json({ job: this.link(a.id, false) });
      const f = await this.fileFor(a);
      if (!f) return bad('the hub has no sign-in for this account', 404);
      await this.api('PATCH', '/auth-files/status', { name: f.name, disabled: m[2] === 'disable' });
      await this.watch();
      return json(this.status());
    }
    if ((m = path.match(/^\/api\/providers\/cliproxy\/claude\/([\w-]+)$/)) && method === 'DELETE') {
      const a = this.ctx.store.account(m[1]);
      if (!a || a.kind !== KIND) return bad('no such Claude account', 404);
      const f = await this.fileFor(a);
      if (f) await this.api('DELETE', `/auth-files?name=${encodeURIComponent(f.name)}`);
      this.setConfig(a.id, { authFile: null });
      await this.watch();
      return json(this.status());
    }
    return bad('no such cliproxy route', 404);
  };

  private async fileFor(a: Row): Promise<HubFile | null> {
    const c = this.config(a);
    const files = await this.hubFiles();
    this.files = files;
    return files.find((x) => (c.authFile && x.name === c.authFile) || (isClaude(x) && sameEmail(x.email, c.email))) ?? null;
  }
}

export const cliproxyProvider: ProviderFactory = (ctx) => new CliproxyProvider(ctx);
