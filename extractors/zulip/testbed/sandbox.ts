/**
 * A real Zulip server in rootless podman, seeded with invented people and traffic, for testing the
 * zulip extractor. See README.md.
 *
 *   bun extractors/zulip/testbed/sandbox.ts up     write compose files + secrets if missing, start, wait, create the org, seed
 *   bun extractors/zulip/testbed/sandbox.ts seed   (re)run the seeding; existing users, channels and topics are kept
 *   bun extractors/zulip/testbed/sandbox.ts down   stop the containers (data kept)
 *   bun extractors/zulip/testbed/sandbox.ts reset  remove this project's containers and volumes, and the seeded state files
 *   bun extractors/zulip/testbed/sandbox.ts env    print shell exports for tests
 *
 * Options: --dir <state dir> (default ${XDG_CACHE_HOME:-~/.cache}/dither-zulip-sandbox), --port <n> (8591),
 * --project <podman-compose project> (zulipsandbox). Port and project are remembered in <dir>/sandbox.json.
 *
 * Writes <dir>/ca.crt (the server's self-signed certificate) and <dir>/creds.json (every account's
 * password and API key, channel and group ids, and the ids of notable seeded messages).
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { png } from '../../matrix/testbed/png.ts';

// ---------- options and state dir ----------

const argv = process.argv.slice(2);
const command = argv[0];
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
const DIR = resolve(expandHome(flag('dir') ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dither-zulip-sandbox')));
const SANDBOX_FILE = join(DIR, 'sandbox.json');
const saved: { port?: number; project?: string } = existsSync(SANDBOX_FILE) ? JSON.parse(readFileSync(SANDBOX_FILE, 'utf8')) : {};
const PORT = Number(flag('port') ?? saved.port ?? 8591);
const PROJECT = flag('project') ?? saved.project ?? 'zulipsandbox';
const HOST = `zulip.localhost:${PORT}`;
const URL_BASE = `https://${HOST}`;
const SECRETS = join(DIR, 'secrets');
const CA_FILE = join(DIR, 'ca.crt');
const CREDS_FILE = join(DIR, 'creds.json');
const TEMPLATES = import.meta.dir;
const COMPOSE = ['-p', PROJECT, '-f', 'compose.yaml', '-f', 'compose.override.yaml'];
const ZULIP = `${PROJECT}_zulip_1`;
const VOLUMES = ['zulip', 'postgresql-14', 'rabbitmq', 'redis'];
const MANAGE = '/home/zulip/deployments/current/manage.py';
const SECRET_NAMES: Record<string, number> = {
  postgres_password: 32,
  memcached_password: 32,
  rabbitmq_password: 32,
  redis_password: 32,
  secret_key: 64,
  email_password: 16,
  userpass: 16, // the owner's (quinn's) login password; not mounted into any container
};

const log = (...a: unknown[]) => console.error('[zulip-sandbox]', ...a);
function die(msg: string): never {
  log(msg);
  process.exit(1);
}

// ---------- podman ----------

function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; quiet?: boolean; check?: boolean } = {}): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    env: { ...process.env, ZULIP_SANDBOX_PORT: String(PORT) },
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const res = { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
  if (!opts.quiet && res.err.trim()) process.stderr.write(res.err);
  if (opts.check !== false && res.code !== 0) die(`${cmd} ${args.join(' ')} failed (${res.code}): ${res.err.trim().slice(-800)}`);
  return res;
}
const compose = (...args: string[]) => run('podman-compose', [...COMPOSE, ...args], { cwd: DIR });

/** Containers of this project, with the directory podman-compose was run from. */
function projectContainers(): { name: string; running: boolean; dir: string }[] {
  const r = run('podman', ['ps', '-a', '--filter', `label=io.podman.compose.project=${PROJECT}`, '--format', '{{.Names}}\t{{.State}}\t{{index .Labels "com.docker.compose.project.working_dir"}}'], { quiet: true });
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, state, dir] = l.split('\t');
      return { name, running: state === 'running', dir: resolve(dir) };
    });
}

/** Refuse to act on a project started from another directory: that is someone else's sandbox. */
function guardProject() {
  for (const c of projectContainers()) {
    if (c.dir !== DIR) die(`project "${PROJECT}" (${c.name}) belongs to ${c.dir}, not ${DIR}; pass that --dir or another --project`);
  }
}

function zulipRunning(): boolean {
  return projectContainers().some((c) => c.name === ZULIP && c.running);
}

/** Runs manage.py in the zulip container; a password goes through a temporary file, never argv. */
function manage(args: string[], passwordFile?: string): string {
  const tmp = `/tmp/sandbox-pw-${randomBytes(6).toString('hex')}`;
  if (passwordFile !== undefined) run('podman', ['exec', '-i', '-u', 'zulip', ZULIP, 'sh', '-c', `umask 077; cat > ${tmp}`], { input: passwordFile });
  try {
    return run('podman', ['exec', '-u', 'zulip', ZULIP, MANAGE, ...args.map((a) => (a === '@PASSWORD_FILE@' ? tmp : a))]).out;
  } finally {
    if (passwordFile !== undefined) run('podman', ['exec', '-u', 'zulip', ZULIP, 'rm', '-f', tmp], { check: false, quiet: true });
  }
}

// ---------- files ----------

function writeFiles() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  for (const f of ['compose.yaml', 'compose.override.yaml']) {
    if (!existsSync(join(DIR, f))) writeFileSync(join(DIR, f), readFileSync(join(TEMPLATES, f)));
  }
  if (!existsSync(join(DIR, '.env'))) writeFileSync(join(DIR, '.env'), `ZULIP_SANDBOX_PORT=${PORT}\n`);
  // Podman mounts file secrets owned by root with their own mode, and memcached's user must read
  // them: so 0644 files in a 0700 directory.
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  chmodSync(SECRETS, 0o700);
  for (const [name, len] of Object.entries(SECRET_NAMES)) {
    const p = join(SECRETS, name);
    if (!existsSync(p)) writeFileSync(p, randomBytes(len).toString('base64url').slice(0, len), { mode: 0o644 }); // no trailing newline
  }
  writeFileSync(SANDBOX_FILE, JSON.stringify({ port: PORT, project: PROJECT }, null, 2) + '\n');
}
const secret = (name: string) => readFileSync(join(SECRETS, name), 'utf8').trim();

// ---------- HTTP ----------

let CA: string | undefined = existsSync(CA_FILE) ? readFileSync(CA_FILE, 'utf8') : undefined;

async function waitHealthy(timeoutMs = 8 * 60_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      // Before ca.crt exists we cannot verify the self-signed certificate; this probe sends nothing secret.
      const r = await fetch(`${URL_BASE}/api/v1/server_settings`, { tls: { rejectUnauthorized: false } } as RequestInit);
      if (r.status === 200) return log(`server up after ${Math.round((Date.now() - start) / 1000)} s`);
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await Bun.sleep(3000);
  }
  die(`server not healthy after ${timeoutMs / 1000} s (${last}); logs: journalctl --user CONTAINER_NAME=${ZULIP} -o cat`);
}

function writeCa() {
  CA = run('podman', ['exec', ZULIP, 'cat', '/etc/ssl/certs/zulip.combined-chain.crt']).out;
  writeFileSync(CA_FILE, CA);
}

type Params = Record<string, unknown>;
/** Zulip takes form parameters; anything that is not a string is sent as JSON. */
function form(params: Params): URLSearchParams {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) f.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return f;
}

interface Who {
  email: string;
  apiKey: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    where: string,
  ) {
    super(`${where}: HTTP ${status} ${body?.code ?? ''} ${body?.msg ?? JSON.stringify(body).slice(0, 300)}`);
  }
}

async function api(who: Who | null, method: string, path: string, params: Params = {}, body?: FormData): Promise<any> {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = 'Basic ' + Buffer.from(`${who.email}:${who.apiKey}`).toString('base64');
  let url = `${URL_BASE}/api/v1${path}`;
  let payload: BodyInit | undefined = body;
  if (!body) {
    if (method === 'GET' || method === 'DELETE') {
      const q = form(params).toString();
      if (q) url += `?${q}`;
    } else payload = form(params);
  }
  for (;;) {
    const r = await fetch(url, { method, headers, body: payload, tls: { ca: CA } } as RequestInit);
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) {
      // Zulip allows 200 API requests a minute per user; wait as long as it says.
      const wait = Number(r.headers.get('retry-after') ?? j['retry-after'] ?? 5);
      log(`rate limited on ${path}; waiting ${wait} s`);
      await Bun.sleep(Math.ceil(wait * 1000) + 250);
      continue;
    }
    if (!r.ok || j.result !== 'success') throw new ApiError(r.status, j, `${method} ${path}`);
    return j;
  }
}

// ---------- the realm ----------

function realmExists(): boolean {
  return manage(['list_realms'])
    .split('\n')
    .some((l) => /^\d+\s+''\s/.test(l));
}

function ensureRealm() {
  if (realmExists()) return;
  log('creating the organization "Sandbox Org" (owner quinn@example.com)');
  manage(['create_realm', '--string-id', '', '--password-file', '@PASSWORD_FILE@', '--automated', 'Sandbox Org', 'quinn@example.com', 'Quinn Park'], secret('userpass'));
}

// ---------- seed data ----------

type UserKey = 'quinn' | 'ann' | 'bob' | 'cara' | 'dave';
const PEOPLE: Record<UserKey, { email: string; name: string; role: number }> = {
  quinn: { email: 'quinn@example.com', name: 'Quinn Park', role: 100 }, // owner; the account under test
  ann: { email: 'ann@example.com', name: 'Ann Lee', role: 200 }, // administrator
  bob: { email: 'bob@example.com', name: 'Bob Kim', role: 400 }, // member
  cara: { email: 'cara@example.com', name: 'Cara Diaz', role: 400 }, // member
  dave: { email: 'dave@example.com', name: 'Dave Moss', role: 600 }, // guest
};
const USER_KEYS = Object.keys(PEOPLE) as UserKey[];

interface UserCreds {
  email: string;
  password: string;
  apiKey: string;
  userId: number;
}
interface Creds {
  url: string;
  realm: string;
  users: Record<UserKey, UserCreds> & { bot: { email: string; apiKey: string; userId: number } };
  channels: Record<string, number>;
  groups: Record<string, number>;
  messages: Record<string, number>;
  scheduledMessageId?: number;
  reminderId?: number;
}

/** Passwords other than the owner's are derived from the sandbox's secret key: stable across runs. */
function password(key: UserKey): string {
  if (key === 'quinn') return secret('userpass');
  return 'sb-' + createHash('sha256').update(`${secret('secret_key')}:user:${key}`).digest('base64url').slice(0, 20);
}

function readCreds(): Partial<Creds> {
  if (!existsSync(CREDS_FILE)) return {};
  try {
    const c = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
    return c.url === URL_BASE ? c : {};
  } catch {
    return {};
  }
}

async function apiKeyFor(key: UserKey, prev?: UserCreds): Promise<{ apiKey: string; userId: number }> {
  if (prev?.apiKey) {
    try {
      const me = await api({ email: PEOPLE[key].email, apiKey: prev.apiKey }, 'GET', '/users/me');
      return { apiKey: prev.apiKey, userId: me.user_id };
    } catch {
      /* stale key: fetch a new one */
    }
  }
  const r = await api(null, 'POST', '/fetch_api_key', { username: PEOPLE[key].email, password: password(key) });
  return { apiKey: r.api_key, userId: r.user_id };
}

/** One tiny PNG, coloured per use. */
function picture(rgb: [number, number, number], size = 48): Uint8Array<ArrayBuffer> {
  return new Uint8Array(png(size, size, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? rgb : [250, 250, 250])));
}

async function upload(who: Who, filename: string, data: Uint8Array<ArrayBuffer> | string, type: string): Promise<string> {
  const fd = new FormData();
  fd.append('filename', new File([data], filename, { type }));
  const r = await api(who, 'POST', '/user_uploads', {}, fd);
  return r.url as string; // "/user_uploads/<realm id>/<2 chars>/<random>/<filename>"
}

/** encodeHashComponent from the web app (web/src/internal_url.ts). */
function hashComponent(s: string): string {
  const rep: Record<string, string> = { '%': '.', '!': '.21', "'": '.27', '(': '.28', ')': '.29', '*': '.2A', '.': '.2E' };
  return encodeURIComponent(s).replace(/[%!'()*.]/g, (m) => rep[m]);
}
function nearLink(channelId: number, channel: string, topic: string, messageId: number): string {
  return `${URL_BASE}/#narrow/channel/${channelId}-${hashComponent(channel.replace(/ /g, '-'))}/topic/${hashComponent(topic)}/near/${messageId}`;
}

async function seed() {
  const prev = readCreds();
  const creds: Creds = {
    url: URL_BASE,
    realm: 'Sandbox Org',
    users: {} as Creds['users'],
    channels: {},
    groups: {},
    messages: { ...(prev.messages ?? {}) },
    scheduledMessageId: prev.scheduledMessageId,
    reminderId: prev.reminderId,
  };
  const save = () => writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });

  // --- users ---
  const q = await apiKeyFor('quinn', prev.users?.quinn);
  creds.users.quinn = { email: PEOPLE.quinn.email, password: password('quinn'), ...q };
  const quinn: Who = { email: PEOPLE.quinn.email, apiKey: q.apiKey };
  const listUsers = async () => (await api(quinn, 'GET', '/users')).members as any[];
  let members = await listUsers();
  for (const key of USER_KEYS) {
    if (key === 'quinn') continue;
    const p = PEOPLE[key];
    if (!members.some((m) => m.delivery_email === p.email)) {
      log(`creating ${p.name}`);
      manage(['create_user', '-r', '', '--password-file', '@PASSWORD_FILE@', p.email, p.name], password(key));
    }
  }
  members = await listUsers();
  const byEmail = (email: string) => members.find((m) => m.delivery_email === email);
  for (const key of USER_KEYS) {
    const m = byEmail(PEOPLE[key].email);
    if (key !== 'quinn' && m.role !== PEOPLE[key].role) await api(quinn, 'PATCH', `/users/${m.user_id}`, { role: PEOPLE[key].role });
    if (key !== 'quinn') creds.users[key] = { email: PEOPLE[key].email, password: password(key), ...(await apiKeyFor(key, prev.users?.[key])) };
  }
  const who = (k: UserKey): Who => ({ email: creds.users[k].email, apiKey: creds.users[k].apiKey });
  const id = (k: UserKey) => creds.users[k].userId;
  const [ann, bob, cara, dave] = (['ann', 'bob', 'cara', 'dave'] as const).map(who);

  // --- the bot ---
  let bots = (await api(quinn, 'GET', '/bots')).bots as any[];
  let echo = bots.find((b) => b.full_name === 'Echo Bot');
  if (!echo) {
    log('creating Echo Bot');
    await api(quinn, 'POST', '/bots', { full_name: 'Echo Bot', short_name: 'echo', bot_type: 1 });
    bots = (await api(quinn, 'GET', '/bots')).bots;
    echo = bots.find((b) => b.full_name === 'Echo Bot');
  }
  // GET /bots has no user id; the bot's own key finds it.
  const botMe = await api({ email: echo.username, apiKey: echo.api_key }, 'GET', '/users/me');
  creds.users.bot = { email: echo.username, apiKey: echo.api_key, userId: botMe.user_id };
  const bot: Who = { email: echo.username, apiKey: echo.api_key };
  save();

  // --- profile fields, status ---
  let fields = (await api(quinn, 'GET', '/realm/profile_fields')).custom_fields as any[];
  for (const [name, field_type, hint] of [
    ['Pronouns', 1, 'What pronouns should people use for you?'],
    ['About', 2, 'A few words about yourself'],
  ] as const) {
    if (!fields.some((f) => f.name === name)) await api(quinn, 'POST', '/realm/profile_fields', { name, field_type, hint });
  }
  fields = (await api(quinn, 'GET', '/realm/profile_fields')).custom_fields;
  const fieldId = (name: string) => fields.find((f) => f.name === name).id;
  await api(ann, 'PATCH', '/users/me/profile_data', {
    data: [
      { id: fieldId('Pronouns'), value: 'she/her' },
      { id: fieldId('About'), value: 'Design lead. Ask me about **colors** and type.' },
    ],
  });
  await api(ann, 'POST', '/users/me/status', { status_text: 'Out until Monday', emoji_name: 'palm_tree', emoji_code: '1f334', reaction_type: 'unicode_emoji' });

  // --- groups ---
  const groups = (await api(quinn, 'GET', '/user_groups')).user_groups as any[];
  const adminsGroup = groups.find((g) => g.name === 'role:administrators' && g.is_system_group).id as number;
  let designers = groups.find((g) => g.name === 'designers');
  if (!designers) {
    const r = await api(quinn, 'POST', '/user_groups/create', { name: 'designers', description: 'People who design things', members: [id('ann'), id('bob')] });
    designers = { id: r.group_id };
  }
  creds.groups.designers = designers.id;
  creds.groups['role:administrators'] = adminsGroup;

  // --- channel folder and channels ---
  const folders = (await api(quinn, 'GET', '/channel_folders')).channel_folders as any[];
  let work = folders.find((f) => f.name === 'Work');
  if (!work) {
    const r = await api(quinn, 'POST', '/channel_folders/create', { name: 'Work', description: 'Channels for work' });
    work = { id: r.channel_folder_id };
  }
  const listChannels = async () => (await api(quinn, 'GET', '/streams', { include_all: true, exclude_archived: false })).streams as any[];
  let channels = await listChannels();
  const everyone = [id('quinn'), id('ann'), id('bob'), id('cara'), id('dave')];
  const channelSpecs: { name: string; description: string; subscribers: number[]; extra?: Params }[] = [
    { name: 'design', description: 'Colors, type and layout for the **new site**.', subscribers: [id('quinn'), id('ann'), id('bob')], extra: { folder_id: work.id } },
    { name: 'ops-private', description: 'Deploys and incidents.', subscribers: [id('quinn'), id('ann')], extra: { invite_only: true, folder_id: work.id } },
    { name: 'announce', description: 'Only administrators post here.', subscribers: everyone, extra: { can_send_message_group: adminsGroup } },
    { name: 'archive-me', description: 'An old channel, archived.', subscribers: [id('quinn'), id('ann')] },
    { name: 'random', description: 'Anything goes.', subscribers: [id('ann'), id('bob'), id('cara')] },
  ];
  for (const c of channelSpecs) {
    if (channels.some((s) => s.name === c.name)) continue;
    log(`creating #${c.name}`);
    await api(quinn, 'POST', '/channels/create', { name: c.name, description: c.description, subscribers: c.subscribers, announce: false, ...c.extra });
  }
  channels = await listChannels();
  for (const s of channels) creds.channels[s.name] = s.stream_id;
  const ch = (name: string) => creds.channels[name];
  // general: everyone; the realm creates it.
  await api(quinn, 'POST', '/users/me/subscriptions', { subscriptions: [{ name: 'general' }], principals: everyone, send_new_subscription_messages: false });
  // Make sure quinn is not in #random (the creator may be subscribed by default).
  const mySubs = (await api(quinn, 'GET', '/users/me/subscriptions')).subscriptions as any[];
  if (mySubs.some((s) => s.name === 'random')) await api(quinn, 'DELETE', '/users/me/subscriptions', { subscriptions: ['random'] });
  save();

  // --- custom emoji ---
  const emoji = (await api(quinn, 'GET', '/realm/emoji')).emoji as Record<string, any>;
  if (!Object.values(emoji).some((e) => e.name === 'partyparrot' && !e.deactivated)) {
    const fd = new FormData();
    fd.append('file', new File([picture([60, 200, 90], 64)], 'partyparrot.png', { type: 'image/png' }));
    await api(quinn, 'POST', '/realm/emoji/partyparrot', {}, fd);
  }

  // --- messages ---
  const send = async (from: Who, to: { channel: string; topic: string } | { dm: number[] }, content: string): Promise<number> => {
    const params = 'channel' in to ? { type: 'stream', to: ch(to.channel), topic: to.topic, content } : { type: 'direct', to: to.dm, content };
    return (await api(from, 'POST', '/messages', params)).id;
  };
  const react = (from: Who, messageId: number, emoji_name: string, extra: Params = {}) => api(from, 'POST', `/messages/${messageId}/reactions`, { emoji_name, ...extra });
  /** Whether any message matches the narrow, as `as` sees it (the guard that keeps seeding idempotent). */
  const exists = async (as: Who, narrow: unknown[]) =>
    ((await api(as, 'GET', '/messages', { anchor: 'newest', num_before: 1, num_after: 0, narrow, allow_empty_topic_name: true })).messages as any[]).length > 0;
  const topicNarrow = (channel: string, topic: string) => [
    { operator: 'channel', operand: ch(channel) },
    { operator: 'topic', operand: topic },
  ];
  const step = async (name: string, guard: () => Promise<boolean>, body: () => Promise<void>) => {
    if (await guard()) return log(`skip ${name}: already there`);
    log(`seed ${name}`);
    await body();
    save();
  };
  const M = creds.messages;

  await step('general > formatting', () => exists(ann, topicNarrow('general', 'formatting')), async () => {
    const T = { channel: 'general', topic: 'formatting' };
    M.plain = await send(ann, T, 'Hello all, this topic shows how messages are formatted.');
    M.emphasis = await send(bob, T, 'Some **bold**, some *italic* and some ~~struck out~~ text.');
    M.code = await send(cara, T, 'Inline `npm test`, and a block:\n```ts\nconst greeting = (name: string) => `hi ${name}`;\n```');
    M.quote = await send(ann, T, '> Simplicity is prerequisite for reliability.\n\nA quote, and my reply under it.');
    M.spoiler = await send(bob, T, '```spoiler The ending\nThe lighthouse keeper did it.\n```');
    M.math = await send(cara, T, 'Pythagoras: $$a^2 + b^2 = c^2$$');
    M.link = await send(ann, T, 'The style guide is [on the docs site](https://example.com/docs/style).');
    M.emoji = await send(bob, T, 'Good morning :smile: :coffee:');
    M.time = await send(cara, T, 'The review is at <time:2026-12-01T15:00:00Z>.');
  });

  await step('general > mentions', () => exists(ann, topicNarrow('general', 'mentions')), async () => {
    const T = { channel: 'general', topic: 'mentions' };
    M.mention = await send(ann, T, '@**Quinn Park** could you look at the budget sheet today?');
    M.silentMention = await send(bob, T, 'Thanks to @_**Ann Lee** for the notes.');
    M.wildcardAll = await send(ann, T, '@**all** the office is closed on Friday.');
    M.wildcardTopic = await send(bob, T, '@**topic** I moved the sync to Thursday.');
    M.groupMention = await send(cara, T, '@*designers* can someone review the new icons?');
    M.channelLink = await send(cara, T, 'The palette is in #**design>colors**.');
    const quoted = 'Notes from the meeting are in the shared folder.';
    M.quoted = await send(ann, T, quoted);
    M.quoteReply = await send(quinn, T, `@_**Ann Lee|${id('ann')}** [said](${nearLink(ch('general'), 'general', 'mentions', M.quoted)}):\n\`\`\`quote\n${quoted}\n\`\`\`\nThanks, I read them.`);
    M.alertWord = await send(bob, T, 'I will deploy the new build tonight.');
  });

  await step('general > files', () => exists(ann, topicNarrow('general', 'files')), async () => {
    const T = { channel: 'general', topic: 'files' };
    const pic = await upload(ann, 'pic.png', picture([220, 90, 60]), 'image/png');
    M.image = await send(ann, T, `Here is the sketch: [pic.png](${pic})`);
    const txt = await upload(bob, 'notes.txt', 'Shopping list\n- paper\n- pens\n', 'text/plain');
    M.file = await send(bob, T, `And the notes: [notes.txt](${txt})`);
  });

  await step('general > widgets', () => exists(ann, topicNarrow('general', 'widgets')), async () => {
    const T = { channel: 'general', topic: 'widgets' };
    M.poll = await send(ann, T, '/poll Lunch?\nTacos\nPizza');
    M.todo = await send(ann, T, '/todo Launch\nWrite docs\nShip');
    // What the web app sends (web/src/poll_data.ts, todo_data.ts). Poll option keys are
    // "<sender>,<idx>" and "todo" task keys "<idx>,<sender>", with sender "canned" for the
    // options and tasks written in the message itself.
    await api(bob, 'POST', '/submessage', { message_id: M.poll, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,0', vote: 1 }) });
    await api(cara, 'POST', '/submessage', { message_id: M.poll, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: 'canned,1', vote: 1 }) });
    await api(bob, 'POST', '/submessage', { message_id: M.todo, msg_type: 'widget', content: JSON.stringify({ type: 'strike', key: '0,canned' }) });
  });

  await step('general > history', () => exists(ann, topicNarrow('general', 'history')), async () => {
    const T = { channel: 'general', topic: 'history' };
    const authors = [ann, bob, cara];
    let first = 0;
    let last = 0;
    for (let i = 1; i <= 120; i++) {
      last = await send(authors[i % 3], T, `History message ${i} of 120.`);
      if (i === 1) first = last;
    }
    M.historyFirst = first;
    M.historyLast = last;
  });

  await step('general > (general chat)', () => exists(ann, topicNarrow('general', '')), async () => {
    M.emptyTopic = await send(cara, { channel: 'general', topic: '' }, 'Anyone up for lunch? (in "general chat", the empty topic)');
  });

  await step('general > chit-chat (muted by quinn)', () => exists(ann, topicNarrow('general', 'chit-chat')), async () => {
    const T = { channel: 'general', topic: 'chit-chat' };
    M.mutedTopic = await send(cara, T, 'Did anyone watch the match last night?');
    await send(bob, T, 'Only the second half.');
    await api(quinn, 'POST', '/user_topics', { stream_id: ch('general'), topic: 'chit-chat', visibility_policy: 1 });
  });

  await step('design > colors', () => exists(ann, topicNarrow('design', 'colors')), async () => {
    const T = { channel: 'design', topic: 'colors' };
    M.reacted = await send(ann, T, 'Proposal: teal as the main color, coral for highlights.');
    await react(bob, M.reacted, 'thumbs_up');
    await react(quinn, M.reacted, 'thumbs_up');
    await react(quinn, M.reacted, 'heart');
    await react(bob, M.reacted, 'zulip', { emoji_code: 'zulip', reaction_type: 'zulip_extra_emoji' });
    await react(ann, M.reacted, 'partyparrot');
    M.starred = await send(bob, T, 'Contrast check: teal on white passes AA.');
    await api(quinn, 'POST', '/messages/flags', { messages: [M.starred], op: 'add', flag: 'starred' });
    await send(quinn, T, 'Looks good to me.');
  });

  await step('design > mockups', () => exists(ann, topicNarrow('design', 'mockups')), async () => {
    const T = { channel: 'design', topic: 'mockups' };
    await send(quinn, T, '@*designers* the mockups for the landing page are ready.');
    await send(ann, T, 'On it.');
  });

  // An edited message whose topic is then renamed: "logo draft" becomes "logo".
  await step('design > logo (edited, renamed)', () => exists(ann, topicNarrow('design', 'logo')), async () => {
    const T = { channel: 'design', topic: 'logo draft' };
    M.edited = await send(quinn, T, 'Logo v1 is up.');
    await send(ann, T, 'The mark feels a bit heavy.');
    await api(quinn, 'PATCH', `/messages/${M.edited}`, { content: 'Logo v2 is up, with a lighter mark.' });
    await api(quinn, 'PATCH', `/messages/${M.edited}`, { topic: 'logo', propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: true });
  });

  await step('design > launch checklist (resolved)', () => exists(ann, topicNarrow('design', '✔ launch checklist')), async () => {
    const T = { channel: 'design', topic: 'launch checklist' };
    M.resolvedFirst = await send(ann, T, 'Fonts licensed?');
    await send(bob, T, 'Yes, done last week.');
    // Resolving is a topic rename to "✔ <topic>" (the web app adds "✔ ").
    await api(quinn, 'PATCH', `/messages/${M.resolvedFirst}`, { topic: '✔ launch checklist', propagate_mode: 'change_all' });
  });

  await step('design > typos (one deleted)', () => exists(ann, topicNarrow('design', 'typos')), async () => {
    const T = { channel: 'design', topic: 'typos' };
    await send(bob, T, 'Found a typo on the pricing page.');
    const gone = await send(bob, T, 'This message will be deleted.');
    await send(ann, T, 'Fixed, thanks.');
    await api(quinn, 'DELETE', `/messages/${gone}`);
    M.deleted = gone;
  });

  await step('ops-private', () => exists(ann, topicNarrow('ops-private', 'deploys')), async () => {
    await send(ann, { channel: 'ops-private', topic: 'deploys' }, 'Staging is green, ready when you are.');
    await send(quinn, { channel: 'ops-private', topic: 'deploys' }, 'Shipping after lunch.');
    M.followed = await send(ann, { channel: 'ops-private', topic: 'incident' }, 'The queue is backing up again.');
    await send(ann, { channel: 'ops-private', topic: 'incident' }, 'Restarted the worker; watching it.');
    await api(quinn, 'POST', '/user_topics', { stream_id: ch('ops-private'), topic: 'incident', visibility_policy: 3 });
  });

  await step('announce', () => exists(ann, topicNarrow('announce', 'news')), async () => {
    M.announce = await send(ann, { channel: 'announce', topic: 'news' }, 'The new handbook is out.');
    await api(quinn, 'POST', '/users/me/subscriptions/properties', { subscription_data: [{ stream_id: ch('announce'), property: 'is_muted', value: true }] });
  });

  await step('random (quinn not subscribed)', () => exists(ann, topicNarrow('random', 'cats')), async () => {
    await send(ann, { channel: 'random', topic: 'cats' }, 'My cat learned to open doors.');
    await send(bob, { channel: 'random', topic: 'cats' }, 'Mine only opens the fridge.');
  });

  await step('archive-me (archived)', () => exists(ann, topicNarrow('archive-me', 'old stuff')), async () => {
    await send(ann, { channel: 'archive-me', topic: 'old stuff' }, 'Nothing new here.');
    await api(quinn, 'DELETE', `/streams/${ch('archive-me')}`);
  });

  await step('dm ann-quinn', () => exists(quinn, [{ operator: 'dm', operand: [id('ann')] }]), async () => {
    const to = { dm: [id('quinn')] };
    const read: number[] = [];
    read.push(await send(ann, to, 'Hi Quinn, are you free for a call tomorrow?'));
    read.push(await send(ann, to, 'Thirty minutes is enough.'));
    await send(quinn, { dm: [id('ann')] }, 'Sure, 10:00 works.');
    M.dmUnread = await send(ann, to, 'Great, I will send an invite.');
    await send(ann, to, 'Also: can you review my draft?');
    M.dmRead = read[0];
    await api(quinn, 'POST', '/messages/flags', { messages: read, op: 'add', flag: 'read' });
  });

  await step('group dm quinn-ann-bob', () => exists(quinn, [{ operator: 'dm', operand: [id('ann'), id('bob')] }]), async () => {
    M.groupDm = await send(bob, { dm: [id('quinn'), id('ann')] }, 'Planning the team dinner here.');
    await send(ann, { dm: [id('quinn'), id('bob')] }, 'Thursday?');
    await send(quinn, { dm: [id('ann'), id('bob')] }, 'Thursday works.');
  });

  await step('self dm', () => exists(quinn, [{ operator: 'dm', operand: [id('quinn')] }]), async () => {
    M.selfDm = await send(quinn, { dm: [id('quinn')] }, 'Note to self: renew the domain before March.');
  });

  await step('bot dm', () => exists(quinn, [{ operator: 'dm', operand: [creds.users.bot.userId] }]), async () => {
    M.botDm = await send(bot, { dm: [id('quinn')] }, 'Echo: build 42 finished.');
  });

  // --- quinn's settings ---
  await api(quinn, 'POST', '/users/me/alert_words', { alert_words: ['deploy'] });
  const scheduled = (await api(quinn, 'GET', '/scheduled_messages')).scheduled_messages as any[];
  if (!scheduled.length) {
    const r = await api(quinn, 'POST', '/scheduled_messages', {
      type: 'stream',
      to: ch('design'),
      topic: 'colors',
      content: 'Reminder: final colors are due today.',
      scheduled_delivery_timestamp: Math.floor(Date.now() / 1000) + 86400,
    });
    creds.scheduledMessageId = r.scheduled_message_id;
  } else creds.scheduledMessageId = scheduled[0].scheduled_message_id;
  const reminders = (await api(quinn, 'GET', '/reminders')).reminders as any[];
  if (!reminders.length && M.dmUnread) {
    const r = await api(quinn, 'POST', '/reminders', { message_id: M.dmUnread, scheduled_delivery_timestamp: Math.floor(Date.now() / 1000) + 86400, note: 'Reply to Ann' });
    creds.reminderId = r.reminder_id;
  } else if (reminders.length) creds.reminderId = reminders[0].reminder_id;

  // --- unread state: everything read except the mentions, files, widgets, colors topics and the latest DMs ---
  for (const [channel, topic] of [
    ['general', 'formatting'],
    ['general', 'history'],
    ['general', ''],
    ['design', 'mockups'],
    ['design', '✔ launch checklist'],
  ] as const) {
    await api(quinn, 'POST', '/messages/flags/narrow', {
      anchor: 'oldest',
      num_before: 0,
      num_after: 1000,
      narrow: topicNarrow(channel, topic),
      op: 'add',
      flag: 'read',
      allow_empty_topic_name: true,
    });
  }
  save();
  const unread = await api(quinn, 'POST', '/register', { fetch_event_types: ['message', 'update_message_flags'], apply_markdown: false });
  const counts = unread.unread_msgs;
  log(`seeded: ${Object.keys(creds.channels).length} channels; quinn has ${counts.count} unread (${counts.streams.length} topics, ${counts.pms.length} DM senders, ${counts.huddles.length} group DMs, ${counts.mentions.length} mentions)`);
  await api(quinn, 'DELETE', '/events', { queue_id: unread.queue_id }).catch(() => {});
  log(`credentials in ${CREDS_FILE}`);
}

// ---------- commands ----------

function printEnv() {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  console.log(`export ZULIP_SANDBOX_URL=${q(URL_BASE)}`);
  console.log(`export NODE_EXTRA_CA_CERTS=${q(CA_FILE)}`);
  console.log(`export ZULIP_SANDBOX_CREDS=${q(CREDS_FILE)}`);
}

async function main() {
  switch (command) {
    case 'up': {
      writeFiles();
      guardProject();
      if (!zulipRunning()) {
        log(`starting project ${PROJECT} in ${DIR} on ${URL_BASE} (first boot takes a few minutes)`);
        compose('up', '-d');
      }
      await waitHealthy();
      writeCa();
      ensureRealm();
      await seed();
      printEnv();
      break;
    }
    case 'seed': {
      guardProject();
      if (!zulipRunning()) die(`not running; use: bun ${import.meta.path} up --dir ${DIR}`);
      await waitHealthy(60_000);
      writeCa();
      ensureRealm();
      await seed();
      break;
    }
    case 'down': {
      guardProject();
      if (!existsSync(join(DIR, 'compose.yaml'))) die(`no compose.yaml in ${DIR}`);
      compose('stop');
      break;
    }
    case 'reset': {
      guardProject();
      if (existsSync(join(DIR, 'compose.yaml'))) compose('down', '-v');
      // Remove what down left behind, only this project's named volumes.
      const vols = run('podman', ['volume', 'ls', '--format', '{{.Name}}'], { quiet: true }).out.split('\n');
      for (const v of VOLUMES.map((v) => `${PROJECT}_${v}`)) if (vols.includes(v)) run('podman', ['volume', 'rm', v]);
      for (const f of [CA_FILE, CREDS_FILE]) rmSync(f, { force: true });
      log(`removed project ${PROJECT}'s containers and volumes; compose files and secrets stay in ${DIR}`);
      break;
    }
    case 'env':
      printEnv();
      break;
    default:
      die('usage: sandbox.ts <up|seed|down|reset|env> [--dir <state dir>] [--port 8591] [--project zulipsandbox]');
  }
}

await main();
