/**
 * The page's login (auth.ts): locked with no password, the password set by the CLI from a file or stdin (never argv)
 * and kept as an argon2id hash, a login form a password manager fills, session cookies that slide and end, revoking
 * them, failed logins backing off, writes held to the page's own origin, the CLI's token, and apps and extractors
 * going on with their own tokens and no login.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register, self } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { ABSOLUTE_MS, Auth, Backoff, CLI_HEADER, CLI_TOKEN_FILE, LOGIN_FILE, safeNext, setPassword, SLIDING_MS } from '../packages/manager/src/auth.ts';

const PW = 'correct horse battery staple';
const CLI = join(import.meta.dir, '../packages/manager/src/cli.ts');
let m: Manager;
let dir: string;
let origin: string;
const clients: AccountsClient[] = [];

const until = async (f: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const get = (path: string, headers: Record<string, string> = {}) => fetch(m.url + path, { headers, redirect: 'manual' });
const send = (path: string, method: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(m.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
async function login(password = PW, headers: Record<string, string> = {}, user = 'admin'): Promise<Response> {
  return fetch(`${m.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0', ...headers },
    body: new URLSearchParams({ username: user, password, next: '/#/accounts' }),
  });
}
const cookieFrom = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const cli = (args: string[], stdin?: string) => {
  const p = Bun.spawnSync(['bun', CLI, ...args, '--data', dir, '--url', m.url], { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-auth-'));
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Accounts</title><div id="app"></div>');
  m = await createManager({ dataDir: dir, port: 0, webDist: dist });
  origin = m.url;
});
afterAll(async () => {
  for (const c of clients) c.close();
  await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('with no password the page stays locked and says how to set one', async () => {
  const page = await get('/');
  expect(page.status).toBe(303);
  expect(page.headers.get('location')).toBe('/login?next=%2F');
  const form = await get('/login');
  expect(form.status).toBe(503);
  const html = await form.text();
  expect(html).toContain('cli.ts set-password');
  expect(html).not.toContain('<form');
  expect((await get('/api/state')).status).toBe(401);
  // Without a login: up, and counts of restarts for changed code (the deployer waits for them), nothing else.
  expect(await (await get('/api/health')).json()).toEqual({ ok: true, codeRestarts: { queued: 0, active: false, restarted: 0, online: 0, crashed: 0 } });
  expect((await login()).status).toBe(503);
});

test('the CLI sets the password from a file or stdin, never from argv, as an argon2id hash only', async () => {
  const argv = cli(['set-password', PW]);
  expect(argv.code).toBe(1);
  expect(argv.out).toContain('never the command line');
  expect(cli(['set-password'], 'short\n').code).toBe(1);

  const f = join(dir, 'pw.txt');
  writeFileSync(f, `${PW}\n`, { mode: 0o600 });
  const r = cli(['set-password', '--file', f]);
  expect(r.out).toContain('password set');
  expect(r.code).toBe(0);
  const file = join(dir, LOGIN_FILE);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain(PW);
  expect(JSON.parse(text)).toMatchObject({ user: 'admin', hash: expect.stringMatching(/^\$argon2id\$/) });
  expect(await Bun.password.verify(PW, JSON.parse(text).hash)).toBe(true);
  // Three starts of the CLI and two argon2id runs: past bun's 5 s on a busy machine or runner.
}, 30_000);

test('the login form is one a password manager fills', async () => {
  const r = await get('/login?next=%2F');
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const html = await r.text();
  expect(html).toMatch(/<form method="post" action="\/login">/);
  expect(html).toContain('autocomplete="username"');
  expect(html).toContain('autocomplete="current-password"');
  expect(html).toContain('type="password"');
});

let cookie = '';
test('a login gives an HttpOnly SameSite=Lax cookie that opens the page and its API', async () => {
  const bad = await login('wrong password!!');
  expect(bad.status).toBe(401);
  expect(bad.headers.get('set-cookie')).toBeNull();
  expect((await login(PW, {}, 'root')).status).toBe(401);

  const r = await login();
  expect(r.status).toBe(303);
  expect(r.headers.get('location')).toBe('/#/accounts');
  const set = r.headers.get('set-cookie')!;
  expect(set).toMatch(/^dacc_session=[\w-]{40,};/);
  expect(set).toContain('HttpOnly');
  expect(set).toContain('SameSite=Lax');
  expect(set).toContain('Path=/');
  expect(set).toMatch(/Max-Age=7776000/);
  expect(set).not.toContain('Secure'); // plain http on localhost
  cookie = cookieFrom(r);

  expect((await get('/api/state', { cookie })).status).toBe(200);
  const page = await get('/', { cookie });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<div id="app">');
  // Signed in, /login goes on to the page.
  expect((await get('/login?next=%2F%23%2Fapps', { cookie })).headers.get('location')).toBe('/#/apps');
  // The token is only kept hashed.
  const db = new Database(join(dir, 'accounts.sqlite'), { readonly: true });
  const rows = db.query('SELECT token_hash FROM session').all() as { token_hash: string }[];
  db.close();
  expect(rows.length).toBe(1);
  expect(rows[0].token_hash).not.toBe(cookie.split('=')[1]);
});

test('over https (through the proxy) the cookie is Secure', async () => {
  const r = await login(PW, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9' });
  expect(r.status).toBe(303);
  expect(r.headers.get('set-cookie')).toContain('; Secure');
  const c = cookieFrom(r);
  const list = (await (await get('/api/sessions', { cookie: c })).json()) as any;
  const mine = list.sessions.find((s: any) => s.current);
  expect(mine).toMatchObject({ ip: '100.64.0.9', userAgent: expect.stringContaining('Firefox') });
  expect((await send(`/api/sessions/${mine.id}`, 'DELETE', { cookie: c, origin })).status).toBe(200);
  expect((await get('/api/state', { cookie: c })).status).toBe(401);
});

test('everything the page uses needs the login', async () => {
  for (const p of ['/api/state', '/api/interfaces', '/api/matrix', '/api/audit', '/api/sessions', '/api/accounts/x', '/api/providers/google']) expect((await get(p)).status).toBe(401);
  expect((await send('/api/accounts', 'POST', { origin }, { kind: 'fake' })).status).toBe(401);
  expect((await send('/api/requests/req_x/approve', 'POST', { origin })).status).toBe(401);
  expect((await send('/api/grants', 'POST', { origin }, {})).status).toBe(401);
  expect((await get('/assets/x.js')).status).toBe(303);
  expect((await get('/oauth/google/start')).status).toBe(303);
  expect((await get('/api/state', { cookie: 'dacc_session=nope' })).status).toBe(401);
  // The live view socket too.
  const ws = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', origin };
  expect((await get('/api/liveview/acc_x', ws)).status).toBe(401);
  expect((await get('/api/liveview/acc_x', { ...ws, cookie, origin: 'https://evil.example' })).status).toBe(403);
  expect((await get('/api/liveview/acc_x', { ...ws, cookie })).status).toBe(404); // in, but no such live view
});

test("a signed-in browser's writes must come from the page's own origin", async () => {
  expect((await send('/api/accounts/acc_x/restart', 'POST', { cookie })).status).toBe(403);
  expect((await send('/api/accounts/acc_x/restart', 'POST', { cookie, origin: 'https://evil.example' })).status).toBe(403);
  expect((await send('/api/accounts/acc_x/restart', 'POST', { cookie, origin: 'null' })).status).toBe(403);
  expect((await send('/api/accounts/acc_x/restart', 'POST', { cookie, referer: `${origin}/#/accounts` })).status).toBe(404);
  expect((await send('/api/accounts/acc_x/restart', 'POST', { cookie, origin })).status).toBe(404);
  // A login and a logout from another site are refused too.
  expect((await login(PW, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await send('/logout', 'POST', { cookie, origin: 'https://evil.example' })).status).toBe(403);
});

test("apps and extractors go on with their own tokens; an app's request still waits for the signed-in page", async () => {
  const app = await register(m.url, { name: 'auth-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'read' }] });
  expect((await self(m.url, app.app, app.token)).id).toBe(app.app);
  const c = new AccountsClient({ url: m.url, app: app.app, token: app.token });
  clients.push(c);
  await until(() => c.connected, 5000, 'the app connected');
  // Approving is the page's: not without the login, not from the app's token.
  expect((await send(`/api/requests/${app.requests[0].id}/approve`, 'POST', { origin })).status).toBe(401);
  expect((await send(`/api/requests/${app.requests[0].id}/approve`, 'POST', { authorization: `Bearer ${app.token}` })).status).toBe(401);
  for (const r of app.requests) expect((await send(`/api/requests/${r.id}/approve`, 'POST', { cookie, origin }, {})).status).toBe(200);
  const made = await c.admin({ do: 'create', kind: 'fake', label: 'Behind the login' });
  const id = (made as any).id as string;
  // Its extractor came in on its own token, and the app's calls reach it.
  await until(() => c.accounts.some((a) => a.id === id && a.online), 10_000, 'the extractor online');
  expect(await c.call(testEcho, id, 'echo', { text: 'still here' })).toEqual({ text: 'still here' });
});

test('the CLI uses its token from the data dir, from this machine and not from a browser', async () => {
  const token = readFileSync(join(dir, CLI_TOKEN_FILE), 'utf8').trim();
  expect(statSync(join(dir, CLI_TOKEN_FILE)).mode & 0o777).toBe(0o600);
  expect((await get('/api/state', { [CLI_HEADER]: token })).status).toBe(200);
  expect((await send('/api/accounts/acc_x/restart', 'POST', { [CLI_HEADER]: token })).status).toBe(404);
  expect((await get('/api/state', { [CLI_HEADER]: token, origin })).status).toBe(401);
  expect((await get('/api/state', { [CLI_HEADER]: token, 'x-forwarded-for': '100.64.0.9' })).status).toBe(401);
  expect((await get('/api/state', { [CLI_HEADER]: 'nope' })).status).toBe(401);
  const r = cli(['accounts']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('Behind the login');
  expect(cli(['sessions']).out).toContain('ses_');
});

test('sessions are listed and revoked; logging out ends this one', async () => {
  const other = cookieFrom(await login());
  const list = (await (await get('/api/sessions', { cookie })).json()) as any;
  expect(list.sessions.length).toBe(2);
  expect(list.sessions.filter((s: any) => s.current).length).toBe(1);
  const s0 = list.sessions[0];
  expect(s0.expiresAt - s0.lastUsed).toBe(SLIDING_MS);
  // All but this one.
  expect(((await (await send('/api/sessions?others=1', 'DELETE', { cookie, origin })).json()) as any).revoked).toBe(1);
  expect((await get('/api/state', { cookie: other })).status).toBe(401);
  expect((await get('/api/state', { cookie })).status).toBe(200);
  // Logging out.
  const out = await send('/logout', 'POST', { cookie, origin });
  expect(out.status).toBe(303);
  expect(out.headers.get('location')).toBe('/login');
  expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await get('/api/state', { cookie })).status).toBe(401);
  cookie = cookieFrom(await login());
});

test('setting the password again signs every browser out', async () => {
  expect((await get('/api/state', { cookie })).status).toBe(200);
  const r = cli(['set-password'], 'another long password\n');
  expect(r.code).toBe(0);
  expect((await get('/api/state', { cookie })).status).toBe(401);
  expect((await login(PW)).status).toBe(401);
  expect((await login('another long password')).status).toBe(303);
});

test('failed logins back off per address', async () => {
  const from = { 'x-forwarded-for': '100.64.7.7' };
  for (let i = 0; i < 5; i++) expect((await login('nope nope nope', from)).status).toBe(401);
  const locked = await login('another long password', from);
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(await locked.text()).toContain('Too many tries');
  // Another address is not held back.
  expect((await login('another long password', { 'x-forwarded-for': '100.64.7.8' })).status).toBe(303);
});

test('the backoff doubles and is capped', () => {
  const b = new Backoff(3, 60_000);
  for (let i = 0; i < 2; i++) b.fail('a', 0);
  expect(b.wait('a', 0)).toBe(0);
  b.fail('a', 0);
  expect(b.wait('a', 0)).toBe(1000);
  b.fail('a', 0);
  expect(b.wait('a', 0)).toBe(2000);
  for (let i = 0; i < 20; i++) b.fail('a', 0);
  expect(b.wait('a', 0)).toBe(60_000);
  b.ok('a');
  expect(b.wait('a', 0)).toBe(0);
});

test('a session slides 90 days from its last use and ends a year after its login', async () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-auth-unit-'));
  try {
    const db = new Database(':memory:');
    let now = 1_000_000;
    const auth = new Auth(db, d, () => now);
    await setPassword(d, db, PW, 0);
    const r = await auth.login('admin', PW, '100.64.0.1', 'ua');
    if (!r.ok) throw new Error(r.error);
    // Used every 80 days, it lasts.
    for (let i = 0; i < 4; i++) {
      now += 80 * 86_400_000;
      expect(auth.session(r.token, '100.64.0.1')).not.toBeNull();
    }
    // A year after its login it ends however much it is used.
    now = 1_000_000 + ABSOLUTE_MS + 1;
    expect(auth.session(r.token, '100.64.0.1')).toBeNull();
    // Unused for over 90 days, another ends.
    now = 5_000_000_000_000;
    await setPassword(d, db, PW, now);
    const r2 = await auth.login('admin', PW, '100.64.0.1', 'ua');
    if (!r2.ok) throw new Error(r2.error);
    now += 2 * 86_400_000;
    expect(auth.session(r2.token, '100.64.0.1')?.refresh).toBe(Math.floor(SLIDING_MS / 1000));
    now += SLIDING_MS + 1;
    expect(auth.session(r2.token, '100.64.0.1')).toBeNull();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('after a login it goes back only to a path on this site', () => {
  expect(safeNext('/#/accounts/acc_1')).toBe('/#/accounts/acc_1');
  expect(safeNext('//evil.example/')).toBe('/');
  expect(safeNext('/\\evil.example')).toBe('/');
  expect(safeNext('https://evil.example')).toBe('/');
  expect(safeNext('/login?next=/')).toBe('/');
  expect(safeNext('/x\r\nset-cookie: a')).toBe('/');
  expect(safeNext(null)).toBe('/');
});

test("the proxy's forwarded address and scheme are taken from this machine's own addresses, not others'", async () => {
  const { isThisMachine, clientIp } = await import('../packages/manager/src/http.ts');
  const { networkInterfaces } = await import('node:os');
  const mine = Object.values(networkInterfaces()).flatMap((l) => l ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address;
  const req = new Request('http://x/', { headers: { 'x-forwarded-for': '100.64.0.9' } });
  expect(clientIp(req, '127.0.0.1')).toBe('100.64.0.9');
  if (mine) expect(clientIp(req, mine)).toBe('100.64.0.9');
  expect(isThisMachine('100.127.255.254')).toBe(false);
  expect(clientIp(req, '100.127.255.254')).toBe('100.127.255.254');
});
