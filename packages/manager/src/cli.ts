/**
 * The operator's tool, from this machine.
 *
 *   bun packages/manager/src/cli.ts accounts
 *   bun packages/manager/src/cli.ts apps
 *   bun packages/manager/src/cli.ts approve <request> [--level read|write|manage] [--dry-run]
 *   bun packages/manager/src/cli.ts grant <app> <interface> <level> [--accounts a,b] [--kinds k,l] [--dry-run]
 *   bun packages/manager/src/cli.ts import-dither-chat --hub-data <dir> (--accounts id,id | --all) [--dry-run]
 *   bun packages/manager/src/cli.ts forget <account>      stop it and drop it from the registry; its directory stays
 *   bun packages/manager/src/cli.ts export-to-dither-chat <account> --hub-data <dir>
 *   bun packages/manager/src/cli.ts set-password [--file <file>]   the page's password, from the file or stdin (never argv)
 *   bun packages/manager/src/cli.ts sessions                       the page's signed-in browsers
 *   bun packages/manager/src/cli.ts revoke-sessions                sign every browser out
 *
 * It talks to the running manager (--url, else $DITHER_ACCOUNTS_URL, else http://127.0.0.1:8486) with the token the
 * manager leaves in <data>/cli.token. When none answers it reads and writes the registry directly: changes then take
 * effect when the manager starts. <data> is --data, else $DITHER_ACCOUNTS_DATA, else ~/.local/share/dither-accounts
 * when it exists, else .data.
 *
 * set-password stores only an argon2id hash (<data>/login.json, 0600) and signs every browser out. A password in a
 * file is read whole (one trailing newline dropped); on a terminal it is asked twice, not echoed.
 *
 * import-dither-chat registers dither-chat's accounts here IN PLACE: same id, kind = the hub's adapter, the session
 * directory <hub-data>/accounts/<id> as it is, a fresh extractor token. It reads the hub's database read-only and
 * never touches the hub. Stop the account in the hub first (or the whole hub): an account a live process runs is
 * refused, and the manager will not start it while one does.
 *
 * export-to-dither-chat is the way back for a chat account the manager made (in <data>/accounts/<id>): it stops the
 * extractor, copies the account's directory to <hub-data>/accounts/<id> (not extractor.lock), checks the copy file by
 * file, and forgets the account here without deleting its directory. The hub then runs it itself from the copy. It
 * refuses an account that is not a chat kind, one imported in place (`forget` hands those back), and a target that
 * already exists.
 */
import { Database } from 'bun:sqlite';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { CLI_HEADER, CLI_TOKEN_FILE, ensureSessionTable, LOGIN_FILE, MIN_PASSWORD, setPassword } from './auth.ts';
import { newToken, Store } from './db.ts';
import { ownDir } from './files.ts';
import { accountProcesses, LOCK } from './supervisor.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--dry-run', '--all'].includes(argv[i - 1])));
const [cmd, ...rest] = positional;
const root = resolve(import.meta.dir, '../../..');
const url = (opt('url') ?? process.env.DITHER_ACCOUNTS_URL ?? 'http://127.0.0.1:8486').replace(/\/$/, '');
const shared = join(homedir(), '.local/share/dither-accounts');
const dataDir = resolve(opt('data') ?? process.env.DITHER_ACCOUNTS_DATA ?? (existsSync(join(shared, 'accounts.sqlite')) ? shared : join(root, '.data')));
/** The running manager's token for this tool (auth.ts), when it left one here. */
const cliHeaders = (): Record<string, string> => {
  try {
    return { [CLI_HEADER]: readFileSync(join(dataDir, CLI_TOKEN_FILE), 'utf8').trim() };
  } catch {
    return {};
  }
};

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

async function live(): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...cliHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) die(`${method} ${path}: the manager at ${url} did not take this tool's token from ${join(dataDir, CLI_TOKEN_FILE)} (another data dir? pass --data)`);
  if (!r.ok) die(`${method} ${path}: ${r.status} ${(j as any).error ?? ''}`);
  return j;
}
function store(): Store {
  if (!existsSync(join(dataDir, 'accounts.sqlite'))) die(`no manager registry at ${dataDir} and no manager at ${url}`);
  return new Store(join(dataDir, 'accounts.sqlite'));
}
const list = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

async function main() {
  const up = await live();
  switch (cmd) {
    case 'accounts': {
      const rows = up ? (await call('GET', '/api/state')).accounts : store().accounts().map((a) => ({ ...a, enabled: !!a.enabled, running: false, online: false, error: null }));
      for (const a of rows) console.log(`${a.id}  ${a.kind.padEnd(9)} ${String(a.label).padEnd(16)} ${a.enabled ? (a.online ? 'online' : a.running ? 'running' : a.error ? `not running: ${a.error}` : 'stopped') : 'disabled'}  ${a.dir}`);
      if (!up) console.log(`(the manager is not running; read from ${dataDir})`);
      return;
    }
    case 'apps': {
      if (!up) die(`the manager is not running at ${url}`);
      for (const a of (await call('GET', '/api/state')).apps) {
        console.log(`${a.id}  ${a.name}${a.connected ? '  (connected)' : ''}`);
        for (const g of a.grants) console.log(`  grant   ${g.id}  ${g.interface} ${g.level}  accounts=${JSON.stringify(g.accounts)}${g.kinds ? ` kinds=${g.kinds.join(',')}` : ''}${g.dryRun ? ' dry-run' : ''}`);
        for (const r of a.requests.filter((r: any) => r.state === 'pending')) console.log(`  request ${r.id}  ${r.interface} ${r.level}  accounts=${JSON.stringify(r.accounts)}${r.kinds ? ` kinds=${r.kinds.join(',')}` : ''}  — ${r.consent.join('; ')}`);
      }
      return;
    }
    case 'approve': {
      const [id] = rest;
      if (!id) die('approve <request> [--level L] [--dry-run]');
      if (!up) die(`the manager is not running at ${url}`);
      await call('POST', `/api/requests/${id}/approve`, { ...(opt('level') ? { level: opt('level') } : {}), dryRun: flag('dry-run') });
      console.log(`approved ${id}`);
      return;
    }
    case 'grant': {
      const [app, iface, level] = rest;
      if (!app || !iface || !level) die('grant <app> <interface> <level> [--accounts a,b] [--kinds k,l] [--dry-run]');
      const body = { app, interface: iface, level, accounts: list(opt('accounts')) ?? '*', kinds: list(opt('kinds')) ?? null, dryRun: flag('dry-run') };
      if (up) console.log(`grant ${(await call('POST', '/api/grants', body)).id}`);
      else {
        const s = store();
        if (!s.app(app)) die(`no app ${app}`);
        console.log(`grant ${s.addGrant({ app_id: app, interface: iface, level: level as any, accounts: body.accounts as any, kinds: body.kinds, dry_run: body.dryRun })} (takes effect when the manager starts)`);
      }
      return;
    }
    case 'import-dither-chat':
      return importDitherChat(up);
    case 'export-to-dither-chat':
      return exportToDitherChat(up);
    case 'forget': {
      const [id] = rest;
      if (!id) die('forget <account>');
      if (up) {
        const r = await call('POST', '/api/accounts/forget', { id });
        console.log(`forgot ${r.forgotten}; its directory stays at ${r.dir}`);
      } else {
        const s = store();
        if (!s.account(id)) die(`no account ${id}`);
        s.run('DELETE FROM account WHERE id = ?', id);
        console.log(`forgot ${id} (the manager is not running)`);
      }
      return;
    }
    case 'set-password':
      return setPasswordCmd();
    case 'sessions': {
      const rows = up ? (await call('GET', '/api/sessions')).sessions : sessionDb().query('SELECT id, created_at AS createdAt, last_used AS lastUsed, user_agent AS userAgent, ip, last_ip AS lastIp FROM session ORDER BY last_used DESC').all();
      for (const x of rows as any[]) console.log(`${x.id}  since ${new Date(x.createdAt).toISOString().slice(0, 16)}  last ${new Date(x.lastUsed).toISOString().slice(0, 16)}  ${x.lastIp ?? x.ip ?? '?'}  ${String(x.userAgent ?? '').slice(0, 60)}`);
      if (!(rows as any[]).length) console.log('no sessions');
      return;
    }
    case 'revoke-sessions': {
      const n = up ? (await call('DELETE', '/api/sessions')).revoked : sessionDb().query('DELETE FROM session').run().changes;
      console.log(`revoked ${n} session${n === 1 ? '' : 's'}`);
      return;
    }
    case 'cliproxy':
      return cliproxy(up);
    default:
      die(
        'usage: cli.ts accounts | apps | approve <request> | grant <app> <interface> <level> | import-dither-chat --hub-data <dir> (--accounts id,id | --all) [--dry-run] | forget <account> | export-to-dither-chat <account> --hub-data <dir> | set-password [--file <file>] | sessions | revoke-sessions | cliproxy (status | connect [keys.env] | add-claude <email> [--mail <account>] | relink|enable|disable|remove <account>)',
      );
  }
}

function sessionDb(): Database {
  if (!existsSync(join(dataDir, 'accounts.sqlite'))) die(`no manager registry at ${dataDir} (pass --data)`);
  const db = new Database(join(dataDir, 'accounts.sqlite'));
  ensureSessionTable(db);
  return db;
}

/** A line from a terminal without echoing it. */
async function askHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' });
  try {
    for await (const line of console) return line;
    return '';
  } finally {
    Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' });
    process.stderr.write('\n');
  }
}

async function setPasswordCmd() {
  if (rest.length) die('set-password takes the password from --file <file> or stdin, never the command line');
  if (!existsSync(dataDir)) die(`no data directory ${dataDir} (pass --data)`);
  const file = opt('file');
  let pw: string;
  if (file) pw = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  else if (process.stdin.isTTY) {
    pw = await askHidden('New password for the page: ');
    if ((await askHidden('Again: ')) !== pw) die('the two do not match');
  } else pw = (await Bun.stdin.text()).replace(/\r?\n$/, '');
  if (pw.length < MIN_PASSWORD) die(`a password of at least ${MIN_PASSWORD} characters, please`);
  const db = new Database(join(dataDir, 'accounts.sqlite'), { create: true });
  await setPassword(dataDir, db, pw);
  db.close();
  console.log(`password set in ${join(dataDir, LOGIN_FILE)} (argon2id, 0600); every browser is signed out. Sign in as "admin".`);
}

async function importDitherChat(up: boolean) {
  const hubData = opt('hub-data');
  if (!hubData) die('--hub-data <dither-chat data dir> is needed');
  const dbPath = join(resolve(hubData!), 'hub.sqlite');
  if (!existsSync(dbPath)) die(`no hub database at ${dbPath}`);
  const want = list(opt('accounts'));
  if (!want && !flag('all')) die('name the accounts (--accounts id,id) or say --all');
  const hub = new Database(dbPath, { readonly: true });
  const rows = hub.query('SELECT id, adapter, label, config, enabled, demo FROM account ORDER BY position, created_at').all() as any[];
  hub.close();
  const present = new Set<string>(up ? (await call('GET', '/api/state')).accounts.map((a: any) => a.id) : existsSync(join(dataDir, 'accounts.sqlite')) ? store().accounts().map((a) => a.id) : []);
  const picked = want ? want.map((id) => rows.find((r) => r.id === id) ?? die(`the hub has no account ${id}`)) : rows;
  const out: { id: string; kind: string; label: string; config: string; enabled: boolean; dir: string }[] = [];
  for (const r of picked) {
    const why =
      r.demo || r.adapter === 'demo'
        ? 'a demo account'
        : present.has(r.id)
          ? 'already in the manager'
          : !existsSync(join(resolve(hubData!), 'accounts', r.id))
            ? 'it has no session directory'
            : accountProcesses(r.id).length
              ? `pid ${accountProcesses(r.id).join(', ')} runs it now: stop it in the hub first`
              : null;
    if (why) {
      console.log(`skip   ${r.id}  ${r.adapter} ${r.label}: ${why}`);
      if (want) process.exitCode = 1;
      continue;
    }
    out.push({ id: r.id, kind: r.adapter, label: r.label, config: r.config, enabled: !!r.enabled, dir: join(resolve(hubData!), 'accounts', r.id) });
    console.log(`${flag('dry-run') ? 'would import' : 'import'} ${r.id}  ${r.adapter} ${r.label}  ${r.enabled ? 'enabled' : 'disabled'}  dir=${join(resolve(hubData!), 'accounts', r.id)}`);
  }
  if (flag('dry-run') || !out.length) return;
  if (up) {
    const res = await call('POST', '/api/accounts/import', { accounts: out });
    for (const x of res.imported) console.log(`  ${x.id}: ${x.started ? 'started by the manager' : 'registered (disabled)'}`);
  } else {
    const s = store();
    const now = Date.now();
    for (const a of out)
      s.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', a.id, a.kind, a.label, a.config, newToken(), a.dir, a.enabled ? 1 : 0, 'import', now, now);
    console.log(`  registered in ${dataDir}; the manager starts them when it starts`);
  }
}

/**
 * The CLIProxyAPI hub's provider (docs/claude.md): `connect` hands it the hub's URL and management key from the hub's
 * keys.env (the file given, else the default path it tries, ~/.local/share/cliproxyapi/keys.env); `add-claude` makes a
 * Claude account for an email and signs the hub in to it, following the job until it is done (the sign-in link comes
 * from the mail account with that address); `relink` does it again; `enable`/`disable` take its sign-in in or out of the hub's rotation; `remove`
 * drops the hub's sign-in (the browser stays signed in).
 */
async function cliproxy(up: boolean) {
  if (!up) die(`the manager is not running at ${url}`);
  const [sub, arg] = rest;
  const show = (st: any) => {
    console.log(`hub: ${st.hub ? st.hub.url : 'none (cli.ts cliproxy connect)'}${st.hubError ? `  error: ${st.hubError}` : ''}`);
    for (const a of st.accounts) {
      const f = a.authFile;
      const hub = f ? `${f.disabled ? 'disabled' : f.status || 'in'}${f.needsSignIn ? ', needs sign-in' : ''}${f.refreshError ? `, refresh: ${f.refreshError}` : ''}${f.priority ? `, priority ${f.priority}` : ''}${f.weeklyResetAt ? `, weekly reset ${new Date(f.weeklyResetAt).toISOString()}` : ''}` : 'not signed in';
      console.log(`${a.id}  ${String(a.email).padEnd(32)} hub: ${hub}${a.job ? `  last job ${a.job.id}: ${a.job.step}${a.job.error ? ` (${a.job.error})` : ''}` : ''}`);
    }
    for (const f of st.otherFiles ?? []) console.log(`(hub only) ${f.name}  ${f.provider} ${f.email ?? ''}${f.disabled ? ' disabled' : ''}`);
  };
  const follow = async (job: any) => {
    let last = '';
    for (;;) {
      const line = `${job.step}${job.error ? `: ${job.error}` : ''}`;
      if (line !== last) console.log(`${job.id}  ${line}`);
      last = line;
      if (['done', 'needs-you', 'error'].includes(job.step)) {
        if (job.step === 'needs-you') console.log('  open the account\'s live view on the page, answer what it shows, then: cli.ts cliproxy relink ' + job.account);
        if (job.step !== 'done') process.exitCode = 1;
        return;
      }
      await Bun.sleep(1500);
      job = (await call('GET', `/api/providers/cliproxy/jobs/${job.id}`)).job;
    }
  };
  switch (sub) {
    case undefined:
    case 'status':
      return show(await call('GET', '/api/providers/cliproxy?fresh=1'));
    case 'connect': {
      const file = arg ?? join(homedir(), '.local/share/cliproxyapi/keys.env');
      const v: Record<string, string> = {};
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
        if (m) v[m[1]] = m[2].trim();
      }
      if (!v.CLIPROXY_MANAGEMENT_KEY) die(`${file} has no CLIPROXY_MANAGEMENT_KEY`);
      return show(await call('PUT', '/api/providers/cliproxy/hub', { url: v.CLIPROXY_URL || 'http://127.0.0.1:8317', managementKey: v.CLIPROXY_MANAGEMENT_KEY }));
    }
    case 'add-claude': {
      if (!arg) die('cliproxy add-claude <email> [--mail <mail account>]');
      return follow((await call('POST', '/api/providers/cliproxy/claude', { email: arg, ...(opt('mail') ? { mailAccount: opt('mail') } : {}) })).job);
    }
    case 'relink':
      if (!arg) die('cliproxy relink <claude account>');
      return follow((await call('POST', `/api/providers/cliproxy/claude/${arg}/relink`)).job);
    case 'enable':
    case 'disable':
      if (!arg) die(`cliproxy ${sub} <claude account>`);
      return show(await call('POST', `/api/providers/cliproxy/claude/${arg}/${sub}`));
    case 'remove':
      if (!arg) die('cliproxy remove <claude account>');
      return show(await call('DELETE', `/api/providers/cliproxy/claude/${arg}`));
    default:
      die('cliproxy (status | connect [keys.env] | add-claude <email> [--mail <account>] | relink|enable|disable|remove <account>)');
  }
}

/** The interfaces a kind implements, from its manifest in extractors/ (one that does not load is passed over). */
async function kindInterfaces(kind: string): Promise<string[]> {
  const dir = join(root, 'extractors');
  for (const d of existsSync(dir) ? readdirSync(dir) : []) {
    const file = join(dir, d, 'manifest.ts');
    if (!existsSync(file)) continue;
    try {
      const m = (await import(file)).default as { kind: string; interfaces: string[] };
      if (m.kind === kind) return m.interfaces;
    } catch {}
  }
  return [];
}

/** Every entry under a directory by its path relative to it: type, size, mode, and a hash of each file's bytes. */
function tree(root: string, skip: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (skip(rel)) continue;
      const st = lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out.set(rel, `link ${readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.set(rel, `dir ${mode}`);
        walk(p);
      } else if (st.isFile()) out.set(rel, `file ${mode} ${st.size} ${new Bun.CryptoHasher('sha256').update(readFileSync(p)).digest('hex')}`);
      else out.set(rel, 'other');
    }
  };
  walk(root);
  return out;
}

/** What differs between two trees, at most a few lines of it. */
function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) out.push(`${k}: ${v.split(' ').slice(0, 3).join(' ')} → ${b.get(k)?.split(' ').slice(0, 3).join(' ') ?? 'missing'}`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k}: not in the original`);
  return out.slice(0, 8);
}

async function exportToDitherChat(up: boolean) {
  const [id] = rest;
  const hubData = opt('hub-data');
  if (!id || !hubData) die('export-to-dither-chat <account> --hub-data <dither-chat data dir>');
  const hub = resolve(hubData!);
  if (!existsSync(hub) || !statSync(hub).isDirectory()) die(`no dither-chat data directory at ${hub}`);
  const target = join(hub, 'accounts', id);
  if (existsSync(target)) die(`${target} already exists: the hub has a directory for ${id}, so nothing is copied over it`);

  // The account as the manager knows it: its kind's interfaces, its directory, and whether the manager made it.
  let acc: { kind: string; label: string; dir: string; enabled: boolean; interfaces: string[]; ownDir: boolean };
  if (up) {
    const r = await fetch(`${url}/api/accounts/${encodeURIComponent(id)}`, { headers: cliHeaders() });
    if (r.status === 404) die(`the manager has no account ${id}`);
    if (!r.ok) die(`GET /api/accounts/${id}: ${r.status}`);
    acc = ((await r.json()) as any).account;
  } else {
    const row = store().account(id) ?? die(`no account ${id} in ${dataDir}`);
    acc = { kind: row.kind, label: row.label, dir: row.dir, enabled: !!row.enabled, interfaces: await kindInterfaces(row.kind), ownDir: ownDir(dataDir, id, row.dir) };
  }
  if (!acc.interfaces.includes('chat')) die(`${id} is a ${acc.kind} account, not a chat one: dither-chat's hub cannot run it`);
  if (!acc.ownDir) die(`${id} was imported in place (${acc.dir}): the manager did not make its directory, so \`forget ${id}\` hands it back without a copy`);
  if (!existsSync(acc.dir)) die(`its directory ${acc.dir} does not exist`);

  // 1. Stop its extractor (disabled, so nothing starts it again while the copy is made).
  if (up && acc.enabled) {
    await call('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { enabled: false });
    console.log(`stopped ${id} (${acc.kind} ${acc.label})`);
  }
  const restore = async (why: string): Promise<never> => {
    if (up && acc.enabled) await call('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { enabled: true }).catch(() => {});
    return die(`${why}${up && acc.enabled ? `; ${id} is enabled again in the manager` : ''}`);
  };
  for (let i = 0; accountProcesses(id).length; i++) {
    if (i >= 50) await restore(`pid ${accountProcesses(id).join(', ')} still runs ${id}`);
    await Bun.sleep(100);
  }

  // 2. Copy it beside the target, check it, then move it into place.
  const staging = join(hub, 'accounts', `.${id}.export`);
  mkdirSync(join(hub, 'accounts'), { recursive: true, mode: 0o700 });
  rmSync(staging, { recursive: true, force: true });
  const skip = (rel: string) => rel === LOCK;
  try {
    cpSync(acc.dir, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: (src) => !skip(relative(acc.dir, src)) });
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    await restore(`copying ${acc.dir} failed: ${(e as Error).message}`);
  }
  const want = tree(acc.dir, skip);
  const got = tree(staging, () => false);
  const diff = differences(want, got);
  if (diff.length) {
    rmSync(staging, { recursive: true, force: true });
    await restore(`the copy does not match its original:\n  ${diff.join('\n  ')}`);
  }
  if (existsSync(target)) {
    rmSync(staging, { recursive: true, force: true });
    await restore(`${target} appeared while copying`);
  }
  renameSync(staging, target);
  console.log(`copied ${acc.dir} to ${target}: ${want.size} entries, checked`);

  // 3. Forget it here, keeping its directory: the hub runs it from the copy.
  if (up) await call('POST', '/api/accounts/forget', { id });
  else store().run('DELETE FROM account WHERE id = ?', id);
  console.log(`forgot ${id} in the manager; its old directory stays at ${acc.dir} (delete it once the hub runs the account)`);
  try {
    const db = new Database(join(hub, 'hub.sqlite'), { readonly: true });
    const known = db.query('SELECT id FROM account WHERE id = ?').get(id);
    db.close();
    if (!known) console.log(`note: the hub's database has no account ${id}, so it will not run it until it does`);
  } catch {
    console.log(`note: could not read the hub's database at ${join(hub, 'hub.sqlite')}`);
  }
}

await main();
