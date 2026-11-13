/**
 * The github extractor: one GitHub account's notifications through the REST API, with a classic personal access token
 * (secret.json `token`; config `apiUrl` for GitHub Enterprise Server), answering `notifications` (docs/github.md).
 *
 *   token → GET /user (who, and the token's scopes) → poll GET /notifications as GitHub asks: no sooner than
 *   X-Poll-Interval, with If-Modified-Since (a 304 costs nothing), the whole unread list now and then to notice what
 *   was read elsewhere → notify.new / notify.read
 *
 * Where it is (ids and times) is in state.json, so a restart announces only what changed meanwhile. A changed token in
 * secret.json is picked up without a restart. It logs ids, counts and statuses, never the token or what a notification
 * says.
 */
import { join } from 'node:path';
import type { Notification } from '@dither-accounts/interfaces';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { GitHub, GitHubError } from './api.ts';
import { fromPageToken, pageToken, type Thread } from './map.ts';
import { Resolver } from './resolve.ts';
import { CLASSIC, scopeVerdict, tokenType } from './scopes.ts';
import { applyUnread, loadState, markRead, prune, saveState, unreadIds } from './state.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** How often the whole unread list is read, to notice threads read elsewhere (a 304 cannot say). */
const RECONCILE_MS = num('DITHER_GITHUB_RECONCILE_MS', 300_000);
/** How often secret.json is looked at for a new token. */
const SECRET_CHECK_MS = num('DITHER_GITHUB_SECRET_CHECK_MS', 5_000);
/** A token without the scopes is checked again this often (scopes can be added to a classic token on GitHub). */
const RECHECK_MS = num('DITHER_GITHUB_RECHECK_MS', 60_000);
/** Waits after failures (no answer, 5xx): this, doubling, up to five minutes. */
const BACKOFF_MS = num('DITHER_GITHUB_BACKOFF_MS', 5_000);
/** A secondary rate limit that names no wait: at least this (GitHub says a minute). */
const SECONDARY_MS = num('DITHER_GITHUB_SECONDARY_MS', 60_000);
const MAX_PAGES = 20;
const PER_PAGE = 50;
/** Subject and comment fetches per poll, and per notify.list page. */
const POLL_FETCHES = 30;
const LIST_FETCHES = 20;

type Phase = 'starting' | 'no-token' | 'unreachable' | 'bad-token' | 'no-scope' | 'running';
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

const config = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}') as { apiUrl?: string };
const base = (typeof config.apiUrl === 'string' && config.apiUrl.trim() ? config.apiUrl.trim() : 'https://api.github.com').replace(/\/+$/, '');

let phase: Phase = 'starting';
/** What is wrong, in words for the attention and the layers. */
let problem: string | null = null;
let token: string | null = null;
let user: { id: number; login: string; name: string | null; avatar_url: string | null; html_url: string | null } | null = null;
/** The token's scopes (undefined: not asked yet; null: GitHub reported none, as for fine-grained tokens). */
let scopes: string[] | null | undefined;
let pollInterval = 60_000;
let lastPollAt: number | null = null;
let polls = 0;
/** A poll that failed and will be tried again, and why. */
let pollProblem: string | null = null;
let pollFailures = 0;
/** Each new token (or a recheck) starts a new generation; timers and requests of an old one stop. */
let gen = 0;
let timer: Timer | undefined;
let settle: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
/** Threads marked read here, and when: a poll that started before that does not count them unread. */
const markedAt = new Map<string, number>();
let markedAllAt = 0;
let markedAllBefore = 0;

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'github', version: '1', capabilities: [] });
    status(true);
  },
  onCommand: (cmd) => run(cmd),
  onShutdown: () => save(),
});

const statePath = join(link.accountDir, 'state.json');
const st = loadState(statePath, (m) => link.log('warn', m));
const gh = new GitHub(base, () => token, { secondaryMs: SECONDARY_MS, backoffMs: Math.min(BACKOFF_MS, 2_000) });
const resolver = new Resolver(gh, () => scopes !== undefined && verdict().repo);

function save() {
  try {
    prune(st);
    saveState(statePath, st);
  } catch (e) {
    link.log('error', `could not write state.json: ${(e as Error).message}`);
  }
}

const readToken = () => {
  const t = link.secret<{ token?: unknown }>().token;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
};

const verdict = () => scopeVerdict(token, scopes ?? null, Math.round(RECHECK_MS / 1000));

// ------------------------------------------------------------------ driving

function later(ms: number, f: () => void) {
  clearTimeout(timer);
  timer = setTimeout(f, Math.max(0, ms));
}

function setPhase(p: Phase, why: string | null = null) {
  phase = p;
  problem = why;
  if (p !== 'starting') settle.resolve();
  status();
}

/** Start over with the token secret.json has now. */
function begin() {
  const my = ++gen;
  clearTimeout(timer);
  settle = Promise.withResolvers<void>();
  token = readToken();
  user = null;
  scopes = undefined;
  pollProblem = null;
  pollFailures = 0;
  gh.limitedUntil = 0;
  if (!token) return setPhase('no-token', 'No GitHub token in this account. ' + CLASSIC + ', and add the account again with it.');
  setPhase('starting');
  void check(my);
}

async function check(my: number) {
  try {
    const r = await gh.req('GET', '/user', { retries: 1 });
    if (my !== gen) return;
    user = r.body;
    scopes = r.headers.has('x-oauth-scopes') ? (r.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;
    const v = verdict();
    link.log('info', `token checked: ${user?.login}, ${tokenType(token)} token, scopes ${scopes === null ? '(none reported)' : scopes.join(', ') || '(none)'}`);
    if (!v.ok) {
      setPhase('no-scope', v.message);
      later(RECHECK_MS, () => void check(my));
      return;
    }
    setPhase('running');
    void tick(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as GitHubError;
    if (err.failure === 'auth') {
      link.log('warn', `GitHub refused the token: ${err.message}`);
      return setPhase('bad-token', `GitHub refused the token (${err.message}): it was revoked, expired or mistyped. ${CLASSIC}, and replace this account's token with it.`);
    }
    if (err.failure === 'rate') {
      setPhase('starting');
      later((err.retryAt ?? Date.now() + 60_000) - Date.now(), () => void check(my));
      return status();
    }
    pollFailures++;
    const wait = backoff();
    if (err.failure === 'network') setPhase('unreachable', err.message);
    else if (err.failure === 'forbidden') setPhase('bad-token', `GitHub refused the token for your profile (${err.message}).`);
    else setPhase('unreachable', err.status === 404 && base !== 'https://api.github.com' ? `${base}/user answered 404: is that the API's URL? GitHub Enterprise's is https://<host>/api/v3` : `GitHub answered ${err.status}: ${err.message}`);
    link.log('warn', `token check failed (${err.status}): ${err.message}; again in ${Math.round(wait / 1000)} s`);
    if (err.failure !== 'forbidden') later(wait, () => void check(my));
  }
}

const backoff = () => Math.min(300_000, BACKOFF_MS * 2 ** Math.max(0, pollFailures - 1));

async function tick(my: number) {
  if (my !== gen || phase !== 'running') return;
  let wait = pollInterval;
  try {
    await poll(my);
    if (my !== gen) return;
    pollProblem = null;
    pollFailures = 0;
    wait = pollInterval;
  } catch (e) {
    if (my !== gen) return;
    const err = e as GitHubError;
    if (err.failure === 'auth') {
      link.log('warn', `GitHub refused the token while polling: ${err.message}`);
      return setPhase('bad-token', `GitHub refused the token (${err.message}): it was revoked, expired or mistyped. ${CLASSIC}, and replace this account's token with it.`);
    }
    if (err.failure === 'forbidden') {
      link.log('warn', `GitHub refused the notifications: ${err.message}`);
      const type = tokenType(token);
      const why =
        type === 'fine-grained' || type === 'github app'
          ? verdict().message ?? err.message
          : `GitHub refused to list the notifications (${err.message})${err.accepted ? `; it takes a token with ${err.accepted}` : ''}. ${CLASSIC}, and replace this account's token with it.`;
      setPhase('no-scope', why);
      later(RECHECK_MS, () => void check(my));
      return;
    }
    if (err.failure === 'rate') {
      wait = (err.retryAt ?? Date.now() + 60_000) - Date.now();
      pollProblem = err.message;
      link.log('warn', `rate limited; polling again in ${Math.round(wait / 1000)} s`);
    } else {
      pollFailures++;
      wait = backoff();
      pollProblem = `${err.message}; trying again in ${Math.round(wait / 1000)} s`;
      link.log('warn', `poll failed (${err.status}): ${err.message}`);
    }
  }
  status();
  later(wait, () => void tick(my));
}

/**
 * One look at the unread list. Page one goes with If-Modified-Since unless it is time for a whole look; further pages
 * are read while they may hold something newer than what was seen (or all of them, for a whole look). Only a complete
 * list says what was read elsewhere. Nothing is kept from a poll that failed halfway, so the next one asks again.
 */
async function poll(my: number) {
  const started = Date.now();
  const whole = !st.baselineAt || started - st.lastReconcileAt >= RECONCILE_MS;
  const first = await gh.req<Thread[]>('GET', '/notifications', { query: { per_page: PER_PAGE }, ifModifiedSince: whole ? null : st.lastModified });
  polls++;
  lastPollAt = Date.now();
  const iv = Number(first.headers.get('x-poll-interval'));
  if (Number.isFinite(iv) && iv > 0) pollInterval = Math.min(3_600_000, Math.max(1_000, iv * 1000));
  if (first.status === 304) return;

  const byId = new Map<string, Thread>();
  const add = (page: unknown) => {
    for (const t of Array.isArray(page) ? (page as Thread[]) : []) if (t && t.id !== undefined) byId.set(String(t.id), { ...t, id: String(t.id) });
  };
  add(first.body);
  let next = first.next;
  let pages = 1;
  const since = st.newest;
  while (next && pages < MAX_PAGES) {
    if (!whole) {
      const page = [...byId.values()];
      const last = page[page.length - 1];
      if (last && (Date.parse(last.updated_at) || 0) < since) break;
    }
    const r = await gh.req<Thread[]>('GET', next);
    if (my !== gen) return;
    add(r.body);
    next = r.next;
    pages++;
  }
  if (my !== gen) return;
  const complete = !next;

  // Threads marked read here after this poll began are read, whatever the list said.
  const unread = [...byId.values()].filter((t) => t.unread !== false && !((markedAt.get(t.id) ?? 0) > started) && !(markedAllAt > started && (Date.parse(t.updated_at) || 0) <= markedAllBefore));
  const baseline = !st.baselineAt;
  const { news, reads } = applyUnread(
    st,
    unread.map((t) => ({ id: t.id, updatedAt: Date.parse(t.updated_at) || 0 })),
    complete,
  );
  st.lastModified = first.headers.get('last-modified') ?? st.lastModified;
  if (whole) st.lastReconcileAt = started;
  if (baseline) st.baselineAt = started;
  save();
  for (const [id, at] of markedAt) if (at < started - 600_000) markedAt.delete(id);
  link.log('info', `poll: ${pages} page${pages === 1 ? '' : 's'}${complete ? '' : ' (not all)'}, ${unread.length} unread${baseline ? ', the first look (not announced)' : `, ${news.length} new, ${reads.length} read elsewhere`}`);
  if (baseline) return;
  if (reads.length) link.emit({ t: 'notify.read', ids: reads });
  if (news.length) {
    const threads = news.map((id) => byId.get(id)!).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    const out = await resolver.all(threads, { n: POLL_FETCHES });
    if (my !== gen) return;
    for (const notification of out) link.emit({ t: 'notify.new', notification });
  }
}

// ------------------------------------------------------------------ operations

const THREAD_ID = /^\d{1,20}$/;
const isoSecond = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function ready() {
  if (phase === 'starting') await Promise.race([settle.promise, Bun.sleep(15_000)]);
  if (phase === 'running') return;
  if (phase === 'starting') throw new StatusError('GitHub has not answered yet', 503);
  throw new StatusError(problem ?? 'GitHub is not connected', phase === 'no-scope' ? 403 : phase === 'unreachable' ? 503 : 401);
}

function threadId(v: unknown): string {
  const id = String(v ?? '');
  if (!THREAD_ID.test(id)) throw new StatusError(`"${id}" is not a GitHub notification id`, 400);
  return id;
}

function readHere(ids: string[], at = Date.now()) {
  for (const id of ids) markedAt.set(id, at);
  const was = markRead(st, ids);
  save();
  if (ids.length) link.emit({ t: 'notify.read', ids });
  return was;
}

async function run(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'notify.list': {
      await ready();
      let r;
      if (typeof cmd.pageToken === 'string' && cmd.pageToken) {
        const q = fromPageToken(cmd.pageToken);
        if (!q) throw new StatusError('that page token is not one notify.list gave', 400);
        r = await gh.req<Thread[]>('GET', `/notifications?${q}`, { retries: 2 });
      } else {
        const limit = Math.min(PER_PAGE, Math.max(1, Math.floor(Number(cmd.limit ?? PER_PAGE)) || PER_PAGE));
        const since = typeof cmd.since === 'number' && Number.isFinite(cmd.since) ? isoSecond(cmd.since) : undefined;
        r = await gh.req<Thread[]>('GET', '/notifications', { query: { all: cmd.unreadOnly ? undefined : 'true', since, per_page: limit }, retries: 2 });
      }
      const threads = (Array.isArray(r.body) ? r.body : []).map((t) => ({ ...t, id: String(t.id) }));
      const notifications: Notification[] = await resolver.all(threads, { n: LIST_FETCHES });
      return { notifications, next: r.next ? pageToken(r.next) : null };
    }
    case 'notify.markRead': {
      await ready();
      const ids = [...new Set((Array.isArray(cmd.ids) ? cmd.ids : []).map(threadId))];
      const done: string[] = [];
      const failed: { id: string; e: GitHubError }[] = [];
      let i = 0;
      const worker = async () => {
        while (i < ids.length) {
          const id = ids[i++];
          try {
            await gh.req('PATCH', `/notifications/threads/${id}`, { retries: 2 });
            done.push(id);
          } catch (e) {
            failed.push({ id, e: e as GitHubError });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      readHere(done);
      link.log('info', `markRead: ${done.length} of ${ids.length}`);
      if (failed.length) {
        const f = failed[0];
        throw new StatusError(`${failed.length} of ${ids.length} not marked read (${f.id}: ${f.e.message})`, typeof f.e.status === 'number' ? f.e.status : 502);
      }
      return {};
    }
    case 'notify.markAllRead': {
      await ready();
      const before = typeof cmd.before === 'number' && Number.isFinite(cmd.before) ? Math.floor(cmd.before / 1000) * 1000 : undefined;
      // Without a time GitHub uses its own now, so this machine's clock does not matter.
      await gh.req('PUT', '/notifications', { body: before === undefined ? { read: true } : { last_read_at: isoSecond(before), read: true }, retries: 2 });
      const now = Date.now();
      markedAllAt = now;
      markedAllBefore = before ?? Number.MAX_SAFE_INTEGER;
      const ids = unreadIds(st, before);
      readHere(ids, now);
      link.log('info', `markAllRead${before === undefined ? '' : ` before ${isoSecond(before)}`}: ${ids.length} known unread`);
      return {};
    }
    case 'notify.mute': {
      await ready();
      // The manager sends a command's input with its own reply id as `id` on top (packages/manager supervisor.ts), so
      // an input `id` does not arrive: `thread` stands in for it until that is fixed (docs/github.md).
      if (cmd.thread === undefined && !THREAD_ID.test(String(cmd.id ?? '')))
        throw new StatusError("the thread id did not arrive: the manager put its own call id in this op's `id` field; send the thread id as `thread` too", 400);
      const id = threadId(cmd.thread ?? cmd.id);
      await gh.req('PUT', `/notifications/threads/${id}/subscription`, { body: { ignored: true }, retries: 2 });
      link.log('info', `muted thread ${id}`);
      return {};
    }
    default:
      throw new StatusError(`github has no operation "${cmd.t}"`, 400);
  }
}

// ------------------------------------------------------------------ status

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

function attention() {
  if (phase === 'no-token' || phase === 'bad-token' || phase === 'no-scope') return { kind: 'login', message: problem ?? 'GitHub needs a token' };
  return null;
}

function statusWord(): string {
  if (phase === 'running') return gh.reached === false ? 'offline' : 'online';
  if (phase === 'unreachable') return 'offline';
  if (phase === 'starting') return 'connecting';
  return 'attention';
}

function details(): Record<string, string | number | boolean | null> {
  const v = scopes === undefined ? null : verdict();
  return {
    login: user?.login ?? null,
    api: base,
    tokenType: tokenType(token),
    scopes: scopes === undefined ? null : scopes === null ? '(none reported)' : scopes.join(', ') || '(none)',
    privateSubjects: v ? v.repo : null,
    pollIntervalS: Math.round(pollInterval / 1000),
    lastPollAt: iso(lastPollAt),
    polls,
    notModified: gh.notModified,
    lastChangeAt: st.lastModified && !Number.isNaN(Date.parse(st.lastModified)) ? iso(Date.parse(st.lastModified)) : null,
    unread: unreadIds(st).length,
    tracked: Object.keys(st.seen).length,
    rateRemaining: gh.rate.remaining,
    rateLimit: gh.rate.limit,
    rateResetAt: iso(gh.rate.resetAt),
    limitedUntil: gh.limitedUntil > Date.now() ? iso(gh.limitedUntil) : null,
    subjectsFetched: resolver.fetched,
  };
}

function layers(): Layer[] {
  const host = gh.host;
  const api: Layer =
    gh.reached === null
      ? { name: host, state: 'waiting', note: phase === 'no-token' ? 'waits for a token' : 'not asked yet' }
      : gh.reached
        ? { name: host, state: 'ok', note: base }
        : { name: host, state: 'failed', note: gh.networkError ?? problem ?? 'no answer' };
  const tokenLayer: Layer =
    phase === 'no-token'
      ? { name: 'token valid', state: 'failed', note: 'no token in secret.json' }
      : phase === 'bad-token'
        ? { name: 'token valid', state: 'failed', note: problem?.split(': it was')[0] ?? 'refused' }
        : user
          ? { name: 'token valid', state: 'ok', note: `${tokenType(token)} token of ${user.login}` }
          : { name: 'token valid', state: 'waiting', note: phase === 'unreachable' ? `waits for ${host}` : 'checking' };
  const v = user && scopes !== undefined ? verdict() : null;
  const scopeLayer: Layer =
    phase === 'no-scope'
      ? { name: 'scopes', state: 'failed', note: v && !v.ok ? v.note : (problem ?? 'GitHub refused the notifications') }
      : v
        ? { name: 'scopes', state: 'ok', note: v.note }
        : { name: 'scopes', state: 'waiting', note: 'waits for the token' };
  const limited = gh.limitedUntil > Date.now();
  const pollLayer: Layer =
    phase !== 'running'
      ? { name: 'polling', state: 'waiting', note: phase === 'no-scope' ? 'waits for the scopes' : 'waits for the token' }
      : limited
        ? { name: 'polling', state: 'waiting', note: `rate limited until ${iso(gh.limitedUntil)}` }
        : pollProblem
          ? { name: 'polling', state: 'waiting', note: pollProblem }
          : lastPollAt
            ? { name: 'polling', state: 'ok', note: `every ${Math.round(pollInterval / 1000)} s, ${unreadIds(st).length} unread` }
            : { name: 'polling', state: 'waiting', note: 'the first poll' };
  return [api, tokenLayer, scopeLayer, pollLayer];
}

/** Details that change with every poll, which alone do not make a new status worth sending. */
const VOLATILE = ['lastPollAt', 'polls', 'notModified', 'rateRemaining', 'rateResetAt'];
let lastKey = '';
let lastSentAt = 0;
function status(force = false) {
  const d = details();
  const self = user ? { nativeId: String(user.id), handle: user.login, displayName: user.name || user.login, ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}) } : undefined;
  const ev = { t: 'status', status: statusWord(), attention: attention(), ...(self ? { self } : {}), details: d, layers: layers() };
  const key = JSON.stringify({ ...ev, details: Object.fromEntries(Object.entries(d).filter(([k]) => !VOLATILE.includes(k))) });
  if (!force && key === lastKey && Date.now() - lastSentAt < 600_000) return;
  lastKey = key;
  lastSentAt = Date.now();
  link.emit(ev);
}

// ------------------------------------------------------------------ start

setInterval(() => {
  const t = readToken();
  if (t !== token) {
    link.log('info', t ? 'the token in secret.json changed; checking it' : 'the token is gone from secret.json');
    begin();
  }
}, SECRET_CHECK_MS);
begin();
