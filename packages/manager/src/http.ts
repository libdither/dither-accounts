/**
 * The manager's HTTP side.
 *
 * - /extractor and /consumer: WebSockets for extractors and apps, from this machine only (apps run beside it).
 * - POST /api/apps/register: an app introduces itself and asks for access, from this machine only and never from a
 *   browser. Its token comes back once; it asks for more with that token (POST /api/apps/:id/requests).
 * - POST /api/accounts/import and /api/accounts/forget: the operator's tool (cli.ts) only, from this machine, with its
 *   token (auth.ts cli.token), since they add or drop accounts without the page's approval.
 * - POST /approver/pair and GET /approver/ws: the approver app on your phone (docs/approver.md), outside the login on
 *   purpose (a one-time code, then the device's own key, are the authority), never from a browser (no Origin).
 * - Everything else is the manager's page and its API, for this machine and the tailnet (a proxy such as Caddy
 *   puts it at your own name), behind a login (auth.ts): the page, its /api/*, /oauth/* and the live view socket
 *   need a session cookie (or, from the CLI on this machine, its token), and a browser's writes must come from the
 *   page's own origin. /login, /logout and /api/health (just `ok`) are the only ways in without one.
 */
import type { Server, ServerWebSocket, Socket } from 'bun';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { consent, type Level, LEVELS } from '@dither-accounts/spec';
import { IFACES } from '@dither-accounts/interfaces';
import TYPES from '@dither-accounts/interfaces/types';
import { ALG_NAMES, validCredentials } from '@dither-accounts/passkey';
import type { AccessRequest, AccountDetail, AccountInfo, AccountPasskeys, AddField, AppInfo, ApproversState, GrantMatrix, ManagerState, MatrixCell, PageCallResult, StatusLayer } from './api-types.ts';
import type { Approvers, ApproverSocketData } from './approvers.ts';
import { Auth, CLI_HEADER, cookieOf, fromOwnPage, loginPage, safeNext, sessionCookie } from './auth.ts';
import { hashToken, newId, newToken, type Row, type Store } from './db.ts';
import { listDir, LOG, logTail, ownDir } from './files.ts';
import type { Kind } from './kinds.ts';
import type { Provider } from './providers/index.ts';
import { CallFailure, type ConsumerSocketData, type Router } from './router.ts';
import { accountDir, type ExtractorSocketData, LOCK, type Supervisor, writeSecret } from './supervisor.ts';

/** The page's live view: a browser WebSocket carried to the account's VNC, a Unix socket on this machine. */
type LiveViewData = { kind: 'liveview'; accountId: string; socket: string; vnc?: Socket<unknown>; queue: Uint8Array[]; closed?: boolean };
type WsData = ConsumerSocketData | ExtractorSocketData | LiveViewData | ApproverSocketData;

/**
 * Whether a live view's socket is one to connect to: a Unix socket owned by this user (the extractor's x11vnc made it
 * in the account's 0700 directory). Anything else (gone, a file, someone else's socket) is not.
 */
function ownSocket(path: string): boolean {
  try {
    const st = lstatSync(path);
    const uid = process.getuid?.();
    return st.isSocket() && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
}

/** Config keys whose values the page never shows. */
const CREDENTIAL = /token|secret|password|passwd|cookie|auth|key|session/i;
function mask(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => mask(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, CREDENTIAL.test(k) && x !== null && x !== '' ? '••••' : mask(x, depth + 1)]));
}
const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

const v4 = (ip: string) => ip.replace(/^::ffff:/, '');
export const isLoopback = (ip: string) => ip === '::1' || v4(ip).startsWith('127.');
export function isTailnet(ip: string) {
  const m = v4(ip).match(/^(\d+)\.(\d+)\./);
  if (m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127) return true;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === req.headers.get('host') || o.hostname === 'localhost' || o.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

const json = (x: unknown, status = 200) => Response.json(x, { status });
const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
const body = async <T>(req: Request) => (await req.json().catch(() => ({}))) as T;

/**
 * An add form's answers, split by its fields (Manifest.add.fields): config keys the kind does not name are passed on
 * (tests and kinds without fields send their own config), secret ones never land in the config. A string says what is
 * wrong.
 */
export function addForm(fields: AddField[], config: unknown, secret: unknown): { config: Record<string, unknown>; secret: Record<string, string> | null } | string {
  const c: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {};
  const given: Record<string, unknown> = secret && typeof secret === 'object' && !Array.isArray(secret) ? (secret as Record<string, unknown>) : {};
  const sec: Record<string, string> = {};
  for (const f of fields) {
    const raw = f.secret ? given[f.key] : c[f.key];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (f.secret) delete c[f.key];
    if (!v) {
      if (f.secret) continue;
      if (f.default !== undefined) c[f.key] = f.default;
      else if (!f.optional) return `${f.label} is needed`;
      else delete c[f.key];
      continue;
    }
    if (f.pattern && !new RegExp(f.pattern).test(v)) return `${f.label}: ${f.hint ?? 'that does not look right'}`;
    if (f.secret) sec[f.key] = v;
    else c[f.key] = v;
  }
  for (const f of fields) if (f.secret && !f.optional && !sec[f.key]) return `${f.label} is needed`;
  return { config: c, secret: Object.keys(sec).length ? sec : null };
}

/** Who an account is signed in as, from its status's `self` (a chat identity, or a Google `{ email }`). */
function selfOf(v: unknown): AccountInfo['self'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  const name = str(o.displayName) ?? str(o.name) ?? str(o.handle) ?? str(o.email);
  const detail = [str(o.handle), str(o.email)].find((x) => x && x !== name) ?? null;
  const avatar = str(o.avatarUrl) ?? str(o.avatar);
  return name || detail ? { name, detail, avatar: avatar && /^https:\/\//.test(avatar) ? avatar : null } : null;
}

const LAYER_STATES = new Set<StatusLayer['state']>(['ok', 'waiting', 'failed', 'off']);
/** An account's dependency chain from its status's `layers`, as far as it is well formed; null when there is none. */
export function layersOf(v: unknown): StatusLayer[] | null {
  if (!Array.isArray(v)) return null;
  const out: StatusLayer[] = [];
  for (const l of v.slice(0, 24)) {
    if (!l || typeof l !== 'object') continue;
    const { name, state, note } = l as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || !LAYER_STATES.has(state as StatusLayer['state'])) continue;
    out.push({ name: name.trim().slice(0, 60), state: state as StatusLayer['state'], ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 400) } : {}) });
  }
  return out.length ? out : null;
}

/** The last `days` UTC days, oldest first, today last. */
export function lastDays(days: number, now = Date.now()): string[] {
  return Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export interface HttpOpts {
  dataDir: string;
  port: number;
  hostname: string;
  webDist: string;
  publicUrl: string;
  startedAt: number;
  /** Tests only: the page and its API answer without a login. */
  openPage?: boolean;
}

let own: { at: number; ips: Set<string> } | null = null;
/** An address of this machine: loopback, or one of its interfaces' (a proxy here may reach us from the tailnet address). */
export function isThisMachine(ip: string): boolean {
  if (isLoopback(ip)) return true;
  if (!own || Date.now() - own.at > 60_000) own = { at: Date.now(), ips: new Set(Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address.toLowerCase()))) };
  return own.ips.has(v4(ip).toLowerCase());
}
/** Who sent a request: the peer, or, from the proxy on this machine (Caddy), the address it forwarded for. */
export function clientIp(req: Request, peer: string): string {
  const fwd = isThisMachine(peer) ? req.headers.get('x-forwarded-for') : null;
  return fwd?.split(',').pop()?.trim() || peer;
}
/** Served over https: directly, or through the proxy on this machine. */
const overHttps = (req: Request, url: URL, peer: string) => url.protocol === 'https:' || (isThisMachine(peer) && req.headers.get('x-forwarded-proto') === 'https');

export class Http {
  server!: Server<WsData>;
  readonly auth: Auth;

  constructor(
    private store: Store,
    private kinds: Map<string, Kind>,
    private sup: Supervisor,
    private router: Router,
    private providers: Provider[],
    private opts: HttpOpts,
    private approvers: Approvers,
  ) {
    this.auth = new Auth(store.db, opts.dataDir);
  }

  private get dataDir() {
    return this.opts.dataDir;
  }

  start() {
    const self = this;
    this.server = Bun.serve<WsData, never>({
      port: this.opts.port,
      hostname: this.opts.hostname,
      idleTimeout: 120,
      fetch: async (req, server) => {
        const ip = server.requestIP(req)?.address ?? '';
        try {
          return await this.route(req, server, ip);
        } catch (e) {
          console.error('request failed', req.method, new URL(req.url).pathname, e);
          return bad(String((e as Error)?.message ?? e), 500);
        }
      },
      websocket: {
        maxPayloadLength: 64 * 1024 * 1024,
        open(ws) {
          if (ws.data.kind === 'extractor') self.sup.attach(ws as any);
          else if (ws.data.kind === 'approver') self.approvers.open(ws as ServerWebSocket<ApproverSocketData>);
          else if (ws.data.kind === 'liveview') self.openLiveView(ws as ServerWebSocket<LiveViewData>);
          else self.router.open(ws as any);
        },
        message(ws, msg) {
          const d = ws.data;
          if (d.kind === 'extractor') self.sup.receive(ws as any, msg as any);
          else if (d.kind === 'approver') void self.approvers.message(ws as ServerWebSocket<ApproverSocketData>, msg as string | Buffer);
          else if (d.kind === 'liveview') {
            const buf = typeof msg === 'string' ? new TextEncoder().encode(msg) : new Uint8Array(msg);
            if (d.vnc) d.vnc.write(buf);
            else d.queue.push(buf);
          } else void self.router.message(ws as any, msg as any);
        },
        close(ws) {
          const d = ws.data;
          if (d.kind === 'extractor') self.sup.detach(ws as any);
          else if (d.kind === 'approver') self.approvers.close(ws as ServerWebSocket<ApproverSocketData>);
          else if (d.kind === 'liveview') {
            d.closed = true;
            d.vnc?.end();
          } else self.router.close(ws as any);
        },
      },
    });
  }

  stop() {
    this.server?.stop(true);
  }

  private openLiveView(ws: ServerWebSocket<LiveViewData>) {
    const d = ws.data;
    if (!ownSocket(d.socket)) return void ws.close(1011, 'the live view is not listening');
    Bun.connect({
      unix: d.socket,
      socket: {
        open(sock) {
          if (d.closed) return void sock.end();
          d.vnc = sock;
          for (const b of d.queue) sock.write(b);
          d.queue = [];
        },
        data(_sock, data) {
          ws.sendBinary(data);
        },
        close() {
          if (!d.closed) ws.close(1000, 'the live view ended');
        },
        error() {
          if (!d.closed) ws.close(1011, 'the live view failed');
        },
      },
    }).catch(() => ws.close(1011, 'the live view is not listening'));
  }

  private async route(req: Request, server: Server<WsData>, ip: string): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const s = this.store;
    let m: RegExpMatchArray | null;

    // From this machine only.
    if (path === '/extractor' || path === '/consumer' || path.startsWith('/consumer/') || path === '/api/apps/register' || path === '/api/accounts/import' || path === '/api/accounts/forget' || /^\/api\/apps\/[\w-]+\/(requests|self)$/.test(path)) {
      if (!isLoopback(ip)) return new Response('this machine only', { status: 403 });
      if (req.headers.get('origin')) return new Response('not from a browser', { status: 403 });
      // Adding or dropping accounts skips the page's approval, so it takes the CLI's token: not any process here.
      if ((path === '/api/accounts/import' || path === '/api/accounts/forget') && !this.auth.isCli(req.headers.get(CLI_HEADER))) return new Response('this needs the CLI token (cli.ts sends it)', { status: 401 });
      if (path === '/extractor') {
        const id = this.sup.authorize(url.searchParams.get('account'), url.searchParams.get('token'));
        if (!id) return new Response('bad extractor token', { status: 401 });
        return server.upgrade(req, { data: { kind: 'extractor', accountId: id } }) ? undefined : bad('upgrade failed');
      }
      const token = url.searchParams.get('token') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (path === '/consumer') {
        const app = token ? s.appByToken(token) : null;
        if (!app || (url.searchParams.get('app') && url.searchParams.get('app') !== app.id)) return new Response('bad app token', { status: 401 });
        return server.upgrade(req, { data: { kind: 'consumer', appId: app.id } }) ? undefined : bad('upgrade failed');
      }
      // An account's live view for an app that manages it (spec liveViewPath): the raw VNC stream, both ways. An app
      // carries it on to its own page (dither-chat's live view); the manager's page has its own, below.
      if ((m = path.match(/^\/consumer\/liveview\/([\w-]+)$/))) {
        const app = token ? s.appByToken(token) : null;
        if (!app) return new Response('bad app token', { status: 401 });
        const a = s.account(m[1]);
        if (!a || !this.router.manages(app.id, a.kind)) return new Response('this app does not manage that account', { status: 403 });
        const lv = this.router.liveView(a.id);
        if (!lv) return new Response('no live view for this account', { status: 404 });
        const proto = req.headers.get('sec-websocket-protocol');
        const headers = proto?.split(',').map((x) => x.trim()).includes('binary') ? { 'Sec-WebSocket-Protocol': 'binary' } : undefined;
        return server.upgrade(req, { data: { kind: 'liveview', accountId: a.id, socket: lv.vncSocket, queue: [] } satisfies LiveViewData, headers }) ? undefined : bad('upgrade failed');
      }
      // Accounts whose session already lives somewhere (dither-chat's .data/accounts/<id>), registered in place: the
      // operator's tool (cli.ts import-dither-chat), from this machine and never a browser.
      if (path === '/api/accounts/import' && req.method === 'POST') {
        const b = await body<{ accounts?: { id: string; kind: string; label: string; config?: unknown; enabled?: boolean; dir: string }[] }>(req);
        const out: { id: string; started: boolean }[] = [];
        for (const a of Array.isArray(b.accounts) ? b.accounts : []) {
          if (!a || typeof a.id !== 'string' || !/^[\w-]{4,64}$/.test(a.id)) return bad('each account needs an id');
          if (!this.kinds.has(a.kind) || this.kinds.get(a.kind)!.builtin) return bad(`no extractor for kind "${a.kind}"`);
          if (s.account(a.id)) return bad(`account ${a.id} is already here`, 409);
          if (typeof a.dir !== 'string' || !a.dir.startsWith('/') || !existsSync(a.dir)) return bad(`${a.id}: its directory ${a.dir} does not exist`);
        }
        for (const a of b.accounts ?? []) {
          const now = Date.now();
          s.run(
            'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            a.id,
            a.kind,
            String(a.label ?? a.kind).slice(0, 200),
            typeof a.config === 'string' ? a.config : JSON.stringify(a.config ?? {}),
            newToken(),
            a.dir,
            a.enabled === false ? 0 : 1,
            'import',
            now,
            now,
          );
          if (a.enabled !== false) this.sup.start(a.id);
          out.push({ id: a.id, started: a.enabled !== false });
        }
        this.router.accountsChanged();
        return json({ imported: out });
      }
      // Hand an account back (the per-account rollback): its extractor stops and its registry entry goes; its directory
      // stays, so the app that had it (dither-chat's hub) can run it again.
      if (path === '/api/accounts/forget' && req.method === 'POST') {
        const b = await body<{ id?: string }>(req);
        const a = b.id ? s.account(b.id) : null;
        if (!a) return bad('no such account', 404);
        if (this.router.inProcess.has(a.id)) return bad(`${a.label} is part of the manager`, 409);
        await this.router.remove(a, false);
        return json({ forgotten: a.id, dir: a.dir });
      }
      if (path === '/api/apps/register' && req.method === 'POST') {
        const b = await body<{ name?: string; describe?: string; requests?: AccessRequest[] }>(req);
        if (typeof b.name !== 'string' || !/^[\w .-]{1,64}$/.test(b.name)) return bad('an app needs a name (letters, digits, space, dot, dash)');
        const id = newId('app');
        const t = newToken();
        s.run('INSERT INTO app (id, name, describe, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, b.name, typeof b.describe === 'string' ? b.describe.slice(0, 500) : null, hashToken(t), Date.now());
        const made = this.addRequests(id, b.requests);
        if (typeof made === 'string') {
          s.run('DELETE FROM app WHERE id = ?', id);
          return bad(made);
        }
        return json({ app: id, token: t, requests: made });
      }
      if ((m = path.match(/^\/api\/apps\/([\w-]+)\/(requests|self)$/))) {
        const app = token ? s.appByToken(token) : null;
        if (!app || app.id !== m[1]) return new Response('bad app token', { status: 401 });
        if (m[2] === 'self') return json(this.appInfo(app));
        if (req.method !== 'POST') return bad('POST requests', 405);
        const made = this.addRequests(app.id, (await body<{ requests?: AccessRequest[] }>(req)).requests);
        return typeof made === 'string' ? bad(made) : json({ requests: made });
      }
    }

    if (!isLoopback(ip) && !isTailnet(ip)) return new Response('tailnet only', { status: 403 });
    if (path === '/api/health') return json({ ok: true });

    // The approver app (docs/approver.md): pairing with a one-time code, and its link, authenticated by its own key.
    // Not behind the login, and not for browsers: a request with an Origin is refused.
    if (path === '/approver/pair' || path === '/approver/ws') {
      if (req.headers.get('origin')) return new Response('not from a browser', { status: 403 });
      if (path === '/approver/ws') {
        if (req.method !== 'GET') return bad('GET (a WebSocket)', 405);
        const data: ApproverSocketData = { kind: 'approver', nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), lastHeard: Date.now() };
        return server.upgrade(req, { data }) ? undefined : bad('a WebSocket upgrade is needed', 426);
      }
      if (req.method !== 'POST') return bad('POST { code, name, publicKey }', 405);
      if (Number(req.headers.get('content-length') ?? 0) > 4096) return bad('too big', 413);
      const text = await req.text();
      if (text.length > 4096) return bad('too big', 413);
      let b: unknown = null;
      try {
        b = JSON.parse(text);
      } catch {}
      const r = await this.approvers.pair(b);
      if ('error' in r) console.log(`approver pairing refused from ${clientIp(req, ip)}: ${r.status}`);
      return 'error' in r ? bad(r.error, r.status) : json(r);
    }

    // The login (auth.ts). Everything after it needs a session, or the CLI's token from this machine.
    const who = clientIp(req, ip);
    const https = overHttps(req, url, ip);
    if (path === '/login' || path === '/logout') return this.loginRoute(req, url, who, https);
    const viaCli = isLoopback(ip) && !req.headers.get('x-forwarded-for') && !req.headers.get('origin') && this.auth.isCli(req.headers.get(CLI_HEADER));
    const session = viaCli || this.opts.openPage ? null : this.auth.session(cookieOf(req), who);
    if (!viaCli && !session && !this.opts.openPage) {
      if (path.startsWith('/api/')) return Response.json({ error: 'sign in first', login: '/login' }, { status: 401 });
      return new Response(null, { status: 303, headers: { location: `/login?next=${encodeURIComponent(path + url.search)}`, 'cache-control': 'no-store' } });
    }
    // A browser's writes come from this page (SameSite=Lax keeps the cookie off other sites' writes; this is the second lock).
    if (!viaCli && req.method !== 'GET' && req.method !== 'HEAD' && !(this.opts.openPage ? sameOrigin(req) : fromOwnPage(req))) return bad('cross-site request refused', 403);
    const res = await this.pageRoute(req, server, url, session?.id ?? null);
    if (res && session?.refresh) {
      try {
        res.headers.append('set-cookie', sessionCookie(cookieOf(req)!, session.refresh, https));
      } catch {}
    }
    return res;
  }

  /** GET /login (the form, or how to set a password), POST /login (a session cookie), POST /logout. */
  private async loginRoute(req: Request, url: URL, who: string, https: boolean): Promise<Response> {
    const html = (page: string, status = 200, headers: Record<string, string> = {}) =>
      new Response(page, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...headers } });
    const back = (to: string, cookie?: string) => new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } });
    if (url.pathname === '/logout') {
      if (req.method !== 'POST') return bad('POST to log out', 405);
      if (!fromOwnPage(req)) return bad('cross-site request refused', 403);
      const s = this.auth.session(cookieOf(req), who);
      if (s) this.auth.revoke(s.id);
      return back('/login', sessionCookie('', 0, https));
    }
    const noPassword = !this.auth.password();
    if (req.method === 'GET') {
      if (!noPassword && this.auth.session(cookieOf(req), who)) return back(safeNext(url.searchParams.get('next')));
      return html(loginPage({ next: safeNext(url.searchParams.get('next')), noPassword }), noPassword ? 503 : 200);
    }
    if (req.method !== 'POST') return bad('GET or POST', 405);
    if (!fromOwnPage(req)) return bad('cross-site request refused', 403);
    const form = await req.formData().catch(() => null);
    const field = (k: string) => {
      const v = form?.get(k);
      return typeof v === 'string' ? v : '';
    };
    const next = safeNext(field('next'));
    const r = await this.auth.login(field('username'), field('password'), who, req.headers.get('user-agent'));
    if (r.ok) {
      console.log(`login from ${who}`);
      return back(next, sessionCookie(r.token, r.maxAge, https));
    }
    if (r.status !== 503) console.log(`login refused from ${who}: ${r.status}`);
    return html(loginPage({ next, error: r.error, noPassword: r.status === 503 }), r.status, r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {});
  }

  /** The page's API and files, for a signed-in browser (or the CLI). `current` is the browser's session. */
  private async pageRoute(req: Request, server: Server<WsData>, url: URL, current: string | null): Promise<Response | undefined> {
    const path = url.pathname;
    const s = this.store;
    let m: RegExpMatchArray | null;

    for (const p of this.providers) {
      const r = await p.routes(req, url);
      if (r) return r;
    }

    // The page's sessions: listed, revoked one by one, or all but this one.
    if (path === '/api/sessions' && req.method === 'GET') return json({ sessions: this.auth.list(current) });
    if (path === '/api/sessions' && req.method === 'DELETE') return json({ revoked: this.auth.revokeAll(url.searchParams.get('others') === '1' ? current : null) });
    if ((m = path.match(/^\/api\/sessions\/([\w-]+)$/)) && req.method === 'DELETE') return this.auth.revoke(m[1]) ? json({ revoked: 1 }) : bad('no such session', 404);
    if (path === '/api/state' && req.method === 'GET') return json(this.state());
    if (path === '/api/interfaces' && req.method === 'GET') return json({ types: TYPES });

    // The approver: paired phones, a new pairing code, forgetting one, and the recent requests (docs/approver.md).
    if (path === '/api/approvers' && req.method === 'GET') return json(await this.approversState());
    if (path === '/api/approvers/pair' && req.method === 'POST') return json(this.approvers.newPairing());
    if ((m = path.match(/^\/api\/approvers\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (!this.approvers.remove(m[1])) return bad('no such device', 404);
      return json(await this.approversState());
    }
    if (path === '/api/matrix' && req.method === 'GET') return json(this.matrix(Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7))));

    // The live view: a browser's own socket (so its origin must be ours), carried to the account's VNC socket here.
    if ((m = path.match(/^\/api\/liveview\/([\w-]+)$/))) {
      if (!(this.opts.openPage ? sameOrigin(req) : fromOwnPage(req))) return new Response('cross-site socket refused', { status: 403 });
      const lv = s.account(m[1]) ? this.router.liveView(m[1]) : null;
      if (!lv) return new Response('no live view for this account', { status: 404 });
      const proto = req.headers.get('sec-websocket-protocol');
      const headers = proto?.split(',').map((x) => x.trim()).includes('binary') ? { 'Sec-WebSocket-Protocol': 'binary' } : undefined;
      if (server.upgrade(req, { data: { kind: 'liveview', accountId: m[1], socket: lv.vncSocket, queue: [] } satisfies LiveViewData, headers })) return undefined;
      return bad('upgrade failed');
    }

    // Add an account of a kind the page can add (Manifest.add): its form's fields go to its config, or to secret.json
    // when they are secret; it starts and asks for whatever else it needs through its status (a QR code, a sign-in in
    // the live view).
    if (path === '/api/accounts' && req.method === 'POST') {
      const b = await body<{ kind?: string; label?: string; config?: Record<string, unknown>; secret?: Record<string, unknown> }>(req);
      const kind = b.kind ? this.kinds.get(b.kind) : undefined;
      if (!kind) return bad(`no extractor for kind "${b.kind}"`);
      if (!kind.add) return bad(`${kind.name} accounts are added by the app that manages them`);
      const form = addForm(kind.add.fields ?? [], b.config, b.secret);
      if (typeof form === 'string') return bad(form);
      const id = newId('acc');
      const now = Date.now();
      s.run(
        'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
        id,
        kind.kind,
        (typeof b.label === 'string' && b.label.trim() ? b.label.trim() : kind.name).slice(0, 200),
        JSON.stringify(form.config),
        newToken(),
        accountDir(this.dataDir, id),
        now,
        now,
      );
      if (form.secret) writeSecret(s.account(id)!, form.secret);
      this.sup.start(id);
      this.router.accountsChanged();
      return json({ id, state: this.state() });
    }

    if ((m = path.match(/^\/api\/requests\/([\w-]+)\/(approve|deny)$/)) && req.method === 'POST') {
      const r = s.one('SELECT * FROM request WHERE id = ?', m[1]);
      if (!r) return bad('no such request', 404);
      if (r.state !== 'pending') return bad(`already ${r.state}`, 409);
      if (m[2] === 'deny') {
        s.run(`UPDATE request SET state = 'denied', decided_at = ? WHERE id = ?`, Date.now(), r.id);
        return json(this.state());
      }
      // You may narrow what was asked: a lower level, fewer accounts, dry run.
      const b = await body<{ level?: Level; accounts?: '*' | string[]; dryRun?: boolean }>(req);
      const level = b.level && LEVELS.includes(b.level) && LEVELS.indexOf(b.level) <= LEVELS.indexOf(r.level) ? b.level : r.level;
      const accounts = b.accounts === '*' || Array.isArray(b.accounts) ? b.accounts : JSON.parse(r.accounts);
      s.addGrant({ app_id: r.app_id, interface: r.interface, accounts, kinds: r.kinds ? JSON.parse(r.kinds) : null, level, dry_run: !!b.dryRun });
      s.run(`UPDATE request SET state = 'approved', decided_at = ? WHERE id = ?`, Date.now(), r.id);
      this.router.watch(r.app_id);
      this.router.accountsChanged();
      return json(this.state());
    }
    // A grant made directly (cli.ts grant), without a request.
    if (path === '/api/grants' && req.method === 'POST') {
      const b = await body<{ app?: string; interface?: string; level?: Level; accounts?: '*' | string[]; kinds?: string[] | null; dryRun?: boolean }>(req);
      if (!b.app || !s.app(b.app)) return bad('no such app', 404);
      if (!b.interface || (b.interface !== 'accounts' && !IFACES[b.interface])) return bad(`no interface "${b.interface}"`);
      if (!b.level || !LEVELS.includes(b.level)) return bad(`level is one of ${LEVELS.join(', ')}`);
      const id = s.addGrant({ app_id: b.app, interface: b.interface, level: b.level, accounts: b.accounts === '*' || Array.isArray(b.accounts) ? b.accounts : '*', kinds: Array.isArray(b.kinds) ? b.kinds : null, dry_run: !!b.dryRun });
      this.router.watch(b.app);
      this.router.accountsChanged();
      return json({ id });
    }
    if ((m = path.match(/^\/api\/grants\/([\w-]+)$/))) {
      const g = s.one('SELECT * FROM grant_ WHERE id = ?', m[1]);
      if (!g) return bad('no such grant', 404);
      if (req.method === 'DELETE') s.run('DELETE FROM grant_ WHERE id = ?', g.id);
      else if (req.method === 'PATCH') {
        const b = await body<{ level?: Level; accounts?: '*' | string[]; dryRun?: boolean }>(req);
        if (b.level && LEVELS.includes(b.level)) s.run('UPDATE grant_ SET level = ? WHERE id = ?', b.level, g.id);
        if (b.accounts === '*' || Array.isArray(b.accounts)) s.run('UPDATE grant_ SET accounts = ? WHERE id = ?', JSON.stringify(b.accounts), g.id);
        if (typeof b.dryRun === 'boolean') s.run('UPDATE grant_ SET dry_run = ? WHERE id = ?', b.dryRun ? 1 : 0, g.id);
      } else return bad('PATCH or DELETE', 405);
      this.router.accountsChanged();
      return json(this.state());
    }
    if ((m = path.match(/^\/api\/apps\/([\w-]+)$/)) && req.method === 'DELETE') {
      s.run('DELETE FROM app WHERE id = ?', m[1]);
      this.router.accountsChanged();
      return json(this.state());
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)(?:\/(restart|log|files|call|secret))?$/))) {
      const a = s.account(m[1]);
      if (!a) return bad('no such account', 404);
      // The manager's own notices (notices.ts) are not a process: nothing to restart, disable, sign in or remove.
      if (this.router.inProcess.has(a.id) && (m[2] === 'secret' || m[2] === 'restart' || (!m[2] && req.method === 'DELETE'))) return bad(`${a.label} is part of the manager`, 409);
      // Replace a sign-in (a token, an app password): the kind's secret add-form fields, merged over secret.json (the
      // session's other keys stay), then the extractor restarts on it. Nothing secret is answered back.
      if (m[2] === 'secret' && req.method === 'POST') {
        const kind = this.kinds.get(a.kind);
        const fields = (kind?.add?.fields ?? []).filter((f) => f.secret);
        if (!fields.length) return bad(`${kind?.name ?? a.kind} accounts have no sign-in to replace here`);
        const b = await body<{ secret?: Record<string, unknown> }>(req);
        const given = b.secret && typeof b.secret === 'object' && !Array.isArray(b.secret) ? b.secret : {};
        const next: Record<string, string> = {};
        for (const f of fields) {
          const v = typeof given[f.key] === 'string' ? (given[f.key] as string).trim() : '';
          if (!v) continue;
          if (f.pattern && !new RegExp(f.pattern).test(v)) return bad(`${f.label}: ${f.hint ?? 'that does not look right'}`);
          next[f.key] = v;
        }
        if (!Object.keys(next).length) return bad(`nothing to replace: give ${fields.map((f) => f.label).join(' or ')}`);
        let old: Record<string, unknown> = {};
        try {
          const o = JSON.parse(readFileSync(join(a.dir, 'secret.json'), 'utf8'));
          if (o && typeof o === 'object' && !Array.isArray(o)) old = o;
        } catch {}
        writeSecret(a, { ...old, ...next });
        if (a.enabled) await this.sup.restart(a.id);
        return json({ replaced: Object.keys(next) });
      }
      if (m[2] === 'restart' && req.method === 'POST') {
        await this.sup.restart(a.id);
        return json(this.state());
      }
      if (!m[2] && req.method === 'GET') return json(this.detail(a));
      if (m[2] === 'log' && req.method === 'GET') return json({ path: join(a.dir, LOG), ...logTail(a.dir, url.searchParams.get('lines')) });
      if (m[2] === 'files' && req.method === 'GET') return json(listDir(a.dir));
      if (m[2] === 'call' && req.method === 'POST') {
        const b = await body<{ op?: string; input?: Record<string, unknown>; dryRun?: boolean }>(req);
        if (typeof b.op !== 'string') return bad('which op?');
        const t0 = performance.now();
        let out: PageCallResult;
        try {
          out = { ok: true, result: await this.router.callAsPage(a.id, b.op, b.input ?? {}, !!b.dryRun), ms: 0 };
        } catch (e) {
          out = { ok: false, error: e instanceof CallFailure ? e.error : { code: 'failed', message: String((e as Error)?.message ?? e) }, ms: 0 };
        }
        out.ms = Math.round(performance.now() - t0);
        return json(out);
      }
      // The registry entry goes and the extractor stops; the session's directory stays (as with cli.ts forget), unless
      // ?purge=1 and the manager made it.
      if (!m[2] && req.method === 'DELETE') {
        const r = await this.router.remove(a, url.searchParams.get('purge') === '1');
        return json({ ...r, state: this.state() });
      }
      if (req.method === 'PATCH') {
        const b = await body<{ enabled?: boolean; label?: string; passkeyDevice?: string | null }>(req);
        if (this.router.inProcess.has(a.id) && b.enabled !== undefined) return bad(`${a.label} is part of the manager`, 409);
        // Where new passkeys are made (docs/approver.md): a paired device, or null for here (secret.json). The running
        // extractor gets the new config at once (its link's config is live), so it need not restart.
        if (b.passkeyDevice !== undefined) {
          if (!this.kinds.get(a.kind)?.passkeys) return bad(`${a.kind} accounts hold no passkeys`);
          if (b.passkeyDevice !== null && !this.approvers.device(b.passkeyDevice)) return bad('no such device', 404);
          const cfg = parse<Record<string, unknown>>(a.config, {});
          if (b.passkeyDevice === null) delete cfg.passkeyDevice;
          else cfg.passkeyDevice = b.passkeyDevice;
          s.run('UPDATE account SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(cfg), Date.now(), a.id);
          this.sup.sendConfig(a.id);
        }
        // An empty name clears the nickname: the page names it by who it is signed in as again (its kind's name is
        // what the registry keeps then, as for an account added without one).
        if (typeof b.label === 'string') s.run('UPDATE account SET label = ?, updated_at = ? WHERE id = ?', (b.label.trim() || (this.kinds.get(a.kind)?.name ?? a.kind)).slice(0, 200), Date.now(), a.id);
        if (typeof b.enabled === 'boolean') {
          s.run('UPDATE account SET enabled = ?, updated_at = ? WHERE id = ?', b.enabled ? 1 : 0, Date.now(), a.id);
          if (b.enabled) this.sup.start(a.id);
          else await this.sup.stop(a.id);
        }
        this.router.accountsChanged();
        return json(this.state());
      }
    }
    if (path === '/api/audit' && req.method === 'GET') {
      this.router.flushAudit();
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const rows = s.all('SELECT * FROM audit WHERE day >= ? ORDER BY day DESC, n DESC', since);
      return json({ rows: rows.map((r) => ({ day: r.day, app: r.app_id, account: r.account, op: r.op, outcome: r.outcome, n: r.n, lastAt: r.last_at })) });
    }
    if (path === '/api/audit' && req.method === 'DELETE') {
      this.router.flushAudit();
      s.run('DELETE FROM audit');
      return json({ ok: true });
    }
    if (path.startsWith('/api/')) return bad('no such endpoint', 404);
    return this.static(path);
  }

  /** Requests an app filed; a string says what was wrong. */
  private addRequests(appId: string, reqs: AccessRequest[] | undefined): string | { id: string }[] {
    const out: { id: string }[] = [];
    for (const r of Array.isArray(reqs) ? reqs.slice(0, 50) : []) {
      if (r.interface !== 'accounts' && !IFACES[r.interface]) return `no interface "${r.interface}"`;
      if (!LEVELS.includes(r.level)) return `level is one of ${LEVELS.join(', ')}`;
      if (r.interface === 'accounts' && r.level !== 'manage') return 'accounts is asked for at manage';
      const accounts = r.accounts === undefined || r.accounts === '*' ? '*' : Array.isArray(r.accounts) ? r.accounts.filter((x) => typeof x === 'string') : '*';
      const kinds = Array.isArray(r.kinds) ? r.kinds.filter((x) => typeof x === 'string') : null;
      const id = newId('req');
      this.store.run(
        'INSERT INTO request (id, app_id, interface, level, accounts, kinds, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        appId,
        r.interface,
        r.level,
        JSON.stringify(accounts),
        kinds ? JSON.stringify(kinds) : null,
        typeof r.reason === 'string' ? r.reason.slice(0, 500) : null,
        Date.now(),
      );
      out.push({ id });
    }
    return out;
  }

  private consentFor(iface: string, level: Level, kinds: string[] | null): string[] {
    if (iface === 'accounts') return [`Add, change, start and stop ${kinds?.length ? kinds.join(', ') : 'any'} accounts`];
    return IFACES[iface] ? consent(IFACES[iface], level) : [];
  }

  appInfo(a: Row): AppInfo {
    const s = this.store;
    return {
      id: a.id,
      name: a.name,
      describe: a.describe,
      connected: this.router.connected(a.id),
      lastSeen: a.last_seen,
      grants: s.grants(a.id).map((g) => ({ id: g.id, interface: g.interface, level: g.level, accounts: g.accounts, kinds: g.kinds, dryRun: g.dry_run, consent: this.consentFor(g.interface, g.level, g.kinds), createdAt: g.created_at })),
      requests: s.all('SELECT * FROM request WHERE app_id = ? ORDER BY created_at DESC LIMIT 50', a.id).map((r) => {
        const kinds = r.kinds ? JSON.parse(r.kinds) : null;
        return { id: r.id, interface: r.interface, level: r.level, accounts: JSON.parse(r.accounts), kinds, reason: r.reason, state: r.state, consent: this.consentFor(r.interface, r.level, kinds), createdAt: r.created_at };
      }),
    };
  }

  accountInfo(a: Row): AccountInfo {
    const st = this.sup.state(a.id);
    return {
      id: a.id,
      kind: a.kind,
      label: a.label,
      enabled: !!a.enabled,
      running: st.running,
      online: st.online,
      error: st.error,
      status: this.statusOf(a.id),
      self: selfOf(this.router.lastEvent(a.id, 'status')?.self),
      seenAs: selfOf(parse<unknown>(a.seen_as, null)),
      liveView: !!this.router.liveView(a.id),
      builtin: this.router.inProcess.has(a.id),
      layers: layersOf(this.router.lastEvent(a.id, 'status')?.layers),
      interfaces: this.kinds.get(a.kind)?.interfaces ?? [],
      dir: a.dir,
      ownDir: ownDir(this.dataDir, a.id, a.dir),
      createdBy: a.created_by,
      createdAt: a.created_at,
    };
  }

  detail(a: Row): AccountDetail {
    const s = this.store;
    const lock = parse<{ pid?: number; owner?: string; at?: string } | null>(existsSync(join(a.dir, LOCK)) ? readFileSync(join(a.dir, LOCK), 'utf8') : null, null);
    const secretPath = join(a.dir, 'secret.json');
    const secret = existsSync(secretPath) ? parse<Record<string, unknown>>(readFileSync(secretPath, 'utf8'), {}) : null;
    const access: AccountDetail['access'] = [];
    for (const app of s.all('SELECT * FROM app ORDER BY created_at')) {
      for (const g of s.grants(app.id)) {
        if (g.interface === 'accounts') {
          // The manager's own accounts are managed by no app (router.ts accountsFor, admin).
          if (g.level === 'manage' && (!g.kinds || g.kinds.includes(a.kind)) && !this.router.inProcess.has(a.id)) access.push({ grant: g.id, app: app.id, appName: app.name, interface: 'accounts', level: g.level, dryRun: g.dry_run });
          continue;
        }
        if (!(this.kinds.get(a.kind)?.interfaces ?? []).includes(g.interface)) continue;
        if (g.accounts !== '*' && !g.accounts.includes(a.id)) continue;
        if (g.kinds && !g.kinds.includes(a.kind)) continue;
        access.push({ grant: g.id, app: app.id, appName: app.name, interface: g.interface, level: g.level, dryRun: g.dry_run });
      }
    }
    this.router.flushAudit();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const activity = s.all('SELECT * FROM audit WHERE account = ? AND day >= ? ORDER BY day DESC, n DESC', a.id, since).map((r) => ({ day: r.day, app: r.app_id, account: r.account, op: r.op, outcome: r.outcome, n: r.n, lastAt: r.last_at }));
    return {
      account: this.accountInfo(a),
      config: mask(parse<Record<string, unknown>>(a.config, {})) as Record<string, unknown>,
      secret: { present: !!secret, keys: secret && typeof secret === 'object' ? Object.keys(secret) : [] },
      process: { ...this.sup.details(a.id), lock: lock?.pid ? { pid: lock.pid, owner: lock.owner ?? '?', at: lock.at ?? null } : null },
      hello: this.router.lastEvent(a.id, 'hello'),
      status: this.router.lastEvent(a.id, 'status'),
      layers: layersOf(this.router.lastEvent(a.id, 'status')?.layers),
      access,
      activity,
      passkeys: this.kinds.get(a.kind)?.passkeys ? this.passkeysOf(a, secret) : null,
      updatedAt: a.updated_at,
    };
  }

  /** Its extractor's last status; while an approver request waits for it, the attention says so. */
  private statusOf(id: string): Record<string, unknown> | null {
    const st = this.router.lastStatus(id);
    const w = this.approvers.waitingFor(id);
    if (!w) return st;
    return { ...(st ?? {}), status: 'attention', attention: { kind: 'approval', message: `Waiting for your approval on ${w.name}` } };
  }

  /** secret.json's passkeys, without their keys: where each lives, and where new ones go. */
  private passkeysOf(a: Row, secret: Record<string, unknown> | null): AccountPasskeys {
    const device = parse<Record<string, unknown>>(a.config, {}).passkeyDevice;
    return {
      device: typeof device === 'string' ? device : null,
      list: validCredentials(secret?.passkeys).map((c) => ({ idPrefix: c.id.slice(0, 8), rpId: c.rpId, algorithm: ALG_NAMES[c.alg] ?? String(c.alg), device: c.device ?? null, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null, verifiedAt: c.verifiedAt ?? null })),
    };
  }

  private async approversState(): Promise<ApproversState> {
    return { devices: await this.approvers.list(), approvals: this.approvers.approvals(100) };
  }

  /**
   * The Apps page's grant matrix: for every app and account, the level it holds on each of the account's interfaces,
   * whether it runs it or dry-runs it, and its calls there per day (all of them, and those that failed or were denied).
   */
  matrix(days = 7): GrantMatrix {
    const s = this.store;
    const dayList = lastDays(days);
    const index = new Map(dayList.map((d, i) => [d, i]));
    this.router.flushAudit();
    const calls = new Map<string, { n: number; bad: number }[]>();
    // A dry run is counted twice (as dry, and as ok by the audit handler around it): its ok row counts it once.
    for (const r of s.all(`SELECT day, app_id, account, outcome, SUM(n) AS n FROM audit WHERE day >= ? AND outcome != 'dry' GROUP BY day, app_id, account, outcome`, dayList[0])) {
      const i = index.get(r.day);
      if (i === undefined) continue;
      const k = `${r.app_id}|${r.account}`;
      const series = calls.get(k) ?? calls.set(k, dayList.map(() => ({ n: 0, bad: 0 }))).get(k)!;
      series[i].n += r.n;
      if (r.outcome === 'error' || r.outcome === 'denied') series[i].bad += r.n;
    }
    const cells: MatrixCell[] = [];
    const accounts = s.accounts();
    for (const app of s.all('SELECT id FROM app ORDER BY created_at')) {
      const grants = s.grants(app.id);
      for (const a of accounts) {
        const per: Record<string, Level> = {};
        let dryRun = false;
        for (const i of this.kinds.get(a.kind)?.interfaces ?? []) {
          const g = this.router.grantFor(app.id, a, i, grants);
          if (!g) continue;
          per[i] = g.level;
          dryRun ||= g.dryRun;
        }
        const manages = !this.router.inProcess.has(a.id) && this.router.manages(app.id, a.kind, grants);
        const series = calls.get(`${app.id}|${a.id}`);
        if (!Object.keys(per).length && !manages && !series) continue;
        cells.push({ app: app.id, account: a.id, grants: per, manages, dryRun, calls: series ?? dayList.map(() => ({ n: 0, bad: 0 })) });
      }
    }
    return { days: dayList, cells };
  }

  state(): ManagerState {
    const s = this.store;
    const accounts: AccountInfo[] = s.accounts().map((a) => this.accountInfo(a));
    return {
      startedAt: this.opts.startedAt,
      publicUrl: this.opts.publicUrl,
      kinds: [...this.kinds.values()].map((k) => ({ kind: k.kind, name: k.name, interfaces: k.interfaces, add: k.add ?? null, passkeys: !!k.passkeys })),
      interfaces: Object.values(IFACES).map((i) => ({
        name: i.name,
        version: i.version,
        describe: i.describe,
        levels: i.levels,
        ops: Object.entries(i.ops).map(([name, o]) => ({ name, level: o.level, describe: o.describe })),
        events: Object.entries(i.events).map(([name, e]) => ({ name, describe: e.describe })),
      })),
      accounts,
      apps: s.all('SELECT * FROM app ORDER BY created_at').map((a) => this.appInfo(a)),
      providers: Object.fromEntries(this.providers.map((p) => [p.name, p.status()])),
    };
  }

  private static(path: string): Response {
    const root = resolve(this.opts.webDist);
    const file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root)) return new Response('no', { status: 403 });
    const isFile = existsSync(file) && statSync(file).isFile();
    const target = isFile ? file : join(root, 'index.html');
    if (!existsSync(target)) return new Response('the page is not built: bun run web:build', { status: 503 });
    return new Response(Bun.file(target), { headers: { 'cache-control': isFile && /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache' } });
  }
}
