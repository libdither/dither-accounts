/**
 * The bluesky extractor: one Bluesky account through the AT Protocol's HTTP API (XRPC), answering `chat` with posts
 * only (docs/bluesky.md). No browser, no firehose: plain requests to the account's own PDS, paced.
 *
 *   config { handle, service? }, secret.json { password (an app password), session? } → the handle resolved to its DID
 *   (com.atproto.identity.resolveHandle on the entryway), the DID to its document (PLC directory, or did:web's
 *   /.well-known/did.json) and the document to the PDS → com.atproto.server.createSession there (with the emailed code
 *   when the server asks for one) → the session (accessJwt, refreshJwt) kept in secret.json, refreshed with
 *   refreshSession when it expires, signed in again with the app password when that fails → the notifications
 *   conversation (variant 'feed'), polled every minute; timelines, threads, profiles and answering only when asked.
 *
 * The PDS answers app.bsky.* reads itself, through its app view. Nothing is marked seen on the server. It logs ids,
 * counts and statuses, never the password, the tokens or what a post says.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { linkHub, RefusalError } from '@dither-chat/protocol/client';
import {
  type Ctx,
  feedConversation,
  feedConvId,
  feedEntryOf,
  findFacets,
  graphemes,
  homeItemOf,
  identityOf,
  type Known,
  parseUri,
  pdsOf,
  personAbout,
  POST,
  postOf,
  threadOf,
  uriOfPost,
  urisToFetch,
} from './map.ts';
import { baseOf, EXPIRED, type Params, Xrpc, XrpcError } from './xrpc.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** How often notifications are asked for. */
const POLL_MS = num('DITHER_BLUESKY_POLL_MS', 60_000);
/** Waits after failures (no answer, 5xx): this, doubling, up to ten minutes. */
const BACKOFF_MS = num('DITHER_BLUESKY_BACKOFF_MS', 5_000);
/** Where did:plc documents are read. */
const PLC = baseOf(process.env.DITHER_BLUESKY_PLC) ?? 'https://plc.directory';
/** The For you timeline: Bluesky's Discover feed generator. */
const DISCOVER = process.env.DITHER_BLUESKY_DISCOVER || 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
/** Where a post opens. */
const WEB = baseOf(process.env.DITHER_BLUESKY_WEB) ?? 'https://bsky.app';
/** A notification younger than this when it is first heard counts as live (it may alert). */
const LIVE_MS = 15 * 60_000;
const PAGE = 40;
/** At most this many pages of notifications in one poll (a long time offline). */
const MAX_PAGES = 10;
/** Bluesky's limits for a post: graphemes, pictures, bytes a picture. */
const LIMITS = { chars: 300, images: 4, imageBytes: 1_000_000 };
const CAPABILITIES: P.Capability[] = ['history', 'profile', 'posts', 'postActions', 'publish', 'postReactors', 'home', 'unpublish', 'postMedia'];

type Phase = 'starting' | 'signin' | 'code' | 'unreachable' | 'online';
interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** The PDS the session is for. */
  pds: string;
}
interface Secret {
  password?: string;
  session?: Session;
}

const config = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}') as { handle?: unknown; service?: unknown };
const identifier = typeof config.handle === 'string' ? config.handle.trim().replace(/^@/, '') : '';
const entryway = baseOf(config.service) ?? 'https://bsky.social';

let phase: Phase = 'starting';
let problem: string | null = null;
let session: Session | null = null;
let me: any = null;
const ctx: Ctx = { self: null, web: WEB };
let gen = 0;
let timer: Timer | undefined;
let failures = 0;
let polls = 0;
let lastPollAt: number | null = null;

const link = linkHub({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'bluesky', version: '1', capabilities: CAPABILITIES });
    status();
    if (phase === 'online') link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
  },
  onCommand: (cmd) => command(cmd),
  onShutdown: () => save(),
});

/** The account's PDS, with the session's access token. Its base moves to the PDS once known. */
const api = new Xrpc(entryway, () => session?.accessJwt ?? null);
/** Anonymous lookups (a handle, a DID document) go to their own hosts, never with the token. */
const anon = (base: string) => new Xrpc(base, () => null);

// ---------------------------------------------------------------- state

const statePath = join(link.accountDir, 'state.json');
interface State {
  /** The newest notification heard (its indexedAt), and the URIs heard at that moment; null before the first read. */
  newest: string | null;
  newestUris: string[];
  started: boolean;
}
const st: State = (() => {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return { newest: typeof s.newest === 'string' ? s.newest : null, newestUris: Array.isArray(s.newestUris) ? s.newestUris.map(String) : [], started: !!s.started };
  } catch {
    return { newest: null, newestUris: [], started: false };
  }
})();
function save() {
  try {
    writeFileSync(statePath, JSON.stringify(st), { mode: 0o600 });
  } catch (e) {
    link.log('error', `could not write state.json: ${(e as Error).message}`);
  }
}

/** Each post's cid and your like and repost of it, as last seen: to like or repost without asking first. */
const known = new Map<string, Known>();
const seen = (uri: string, k: Known) => {
  known.delete(uri);
  known.set(uri, k);
  if (known.size > 5000) known.delete(known.keys().next().value!);
};

// ---------------------------------------------------------------- status

function status() {
  const host = session ? new URL(session.pds).host : new URL(entryway).host;
  const layers: P.StatusLayer[] = [
    { name: host, state: phase === 'unreachable' ? 'failed' : phase === 'starting' && !me ? 'waiting' : 'ok', ...(phase === 'unreachable' && problem ? { note: problem } : {}) },
    { name: 'signed in', state: phase === 'online' ? 'ok' : phase === 'signin' || phase === 'code' ? 'failed' : 'waiting', ...((phase === 'signin' || phase === 'code') && problem ? { note: problem } : session ? { note: `@${session.handle}` } : {}) },
    { name: 'notifications', state: phase !== 'online' ? 'waiting' : failures ? 'failed' : polls ? 'ok' : 'waiting', ...(lastPollAt ? { note: `read ${new Date(lastPollAt).toISOString()}` } : {}) },
  ];
  const attention: Omit<P.Attention, 'since'> | null =
    phase === 'signin'
      ? { kind: 'login', message: problem ?? `Sign in to Bluesky again: type an app password for @${identifier}.` }
      : phase === 'code'
        ? { kind: 'verify', message: problem ?? 'Bluesky emailed you a sign-in code: type it here.', detail: { code: { type: 'text', length: 11 } } }
        : null;
  link.emit({
    t: 'status',
    status: phase === 'online' ? 'online' : phase === 'signin' || phase === 'code' ? 'attention' : phase === 'unreachable' ? 'error' : 'connecting',
    attention,
    ...(me ? { self: identityOf(me, ctx) } : {}),
    details: { pds: host, polls, lastPollAt, ...(api.remaining !== null ? { rateRemaining: api.remaining } : {}) },
    layers,
  });
}

function setPhase(p: Phase, why: string | null = null) {
  phase = p;
  problem = why;
  status();
}
function later(ms: number, f: () => void) {
  clearTimeout(timer);
  timer = setTimeout(f, Math.max(0, ms));
}
const backoff = () => Math.min(600_000, BACKOFF_MS * 2 ** Math.max(0, failures - 1));

// ---------------------------------------------------------------- signing in

const readSecret = () => link.secret<Secret>();
function saveSecret(patch: Partial<Secret>) {
  const next: Secret = { ...readSecret(), ...patch };
  for (const k of Object.keys(next) as (keyof Secret)[]) if (next[k] === undefined) delete next[k];
  link.saveSecret(next);
}
function useSession(s: Session | null) {
  session = s;
  if (s) api.base = s.pds;
  saveSecret({ session: s ?? undefined });
}

function begin() {
  const my = ++gen;
  clearTimeout(timer);
  me = null;
  failures = 0;
  if (!identifier) return setPhase('signin', 'This account has no handle. Add it again with your handle, like alice.bsky.social.');
  const s = readSecret().session;
  session = s && typeof s.accessJwt === 'string' && typeof s.refreshJwt === 'string' && typeof s.pds === 'string' ? s : null;
  if (session) api.base = session.pds;
  setPhase('starting');
  void (session ? check(my) : login(my));
}

/** An http PDS only beside an http entryway (a test or a local network), never from a DID document alone. */
const allowed = (url: string) => url.startsWith('https://') || entryway.startsWith('http://');

/** Where the account lives: the handle's DID, its document, the PDS it names. An email signs in at the entryway. */
async function resolvePds(): Promise<string> {
  if (identifier.includes('@')) return entryway;
  const did = identifier.startsWith('did:') ? identifier : String((await anon(entryway).query('com.atproto.identity.resolveHandle', { handle: identifier })).did ?? '');
  let doc: any;
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) doc = await fetchJson(`${PLC}/${did}`);
  else if (/^did:web:[A-Za-z0-9.%-]+$/.test(did)) doc = await fetchJson(`https://${decodeURIComponent(did.slice(8))}/.well-known/did.json`);
  else throw new XrpcError(`@${identifier} has no DID Bluesky knows`, 400, 'missing', 'HandleNotFound');
  const pds = pdsOf(doc);
  if (!pds || !allowed(pds)) throw new XrpcError(`${did} names no personal data server`, 502, 'http');
  return pds;
}
async function fetchJson(url: string): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new XrpcError(`no answer from ${new URL(url).host}: ${(e as Error).message}`, 503, 'network');
  }
  if (r.status === 404) throw new XrpcError(`${new URL(url).host} has no DID document for @${identifier}`, 404, 'missing');
  if (!r.ok) throw new XrpcError(`${new URL(url).host} answered ${r.status}`, r.status, 'http');
  return r.json();
}

/** Errors Bluesky names for a sign-in, in words. */
const LOGIN_WORDS: Record<string, string> = {
  AuthenticationRequired: 'Bluesky refused the handle or app password',
  AccountTakedown: 'Bluesky has taken this account down',
  HandleNotFound: `Bluesky has no account @${identifier}`,
  InvalidRequest: 'Bluesky did not take that sign-in',
};

/** Sign in with the app password (and the emailed code, when the server asked for one). */
async function login(my: number, code?: string) {
  const s = readSecret();
  if (!s.password) return setPhase('signin', `No app password for @${identifier}: type one to sign in.`);
  try {
    const pds = await resolvePds();
    if (my !== gen) return;
    const r = await anon(pds).procedure('com.atproto.server.createSession', { identifier, password: s.password, ...(code ? { authFactorToken: code } : {}) });
    if (my !== gen) return;
    if (typeof r?.accessJwt !== 'string' || typeof r?.refreshJwt !== 'string' || typeof r?.did !== 'string') throw new XrpcError('Bluesky gave no session', 502, 'http');
    // Signed in at the entryway (by email): the session works on the account's own PDS too, which the document names.
    const home = pdsOf(r.didDoc);
    useSession({ did: r.did, handle: String(r.handle ?? identifier), accessJwt: r.accessJwt, refreshJwt: r.refreshJwt, pds: home && allowed(home) ? home : pds });
    link.log('info', `signed in on ${new URL(session!.pds).host}`);
    await check(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as XrpcError;
    if (err.code === 'AuthFactorTokenRequired') {
      if (code) throw new RefusalError('Bluesky did not take that code', 400);
      return setPhase('code', 'Bluesky emailed you a sign-in code: type it here.');
    }
    if (err.failure === 'auth' || (err.code && LOGIN_WORDS[err.code]) || err.failure === 'missing') {
      const words = (err.code && LOGIN_WORDS[err.code]) || err.message;
      link.log('warn', `sign-in refused: ${err.code ?? err.status}`);
      if (code) throw new RefusalError(words, 400);
      return setPhase('signin', `${words}. Type an app password (Settings → Privacy and security → App passwords).`);
    }
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `sign-in failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    if (code) throw new RefusalError(err.message, err.status);
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void login(my));
  }
}

let refreshing: Promise<boolean> | null = null;
/** A new access token from the refresh token; false when the server takes neither any more. */
function refresh(): Promise<boolean> {
  if (!session) return Promise.resolve(false);
  refreshing ??= (async () => {
    const s = session!;
    try {
      const r = await api.procedure('com.atproto.server.refreshSession', undefined, { bearer: s.refreshJwt });
      if (typeof r?.accessJwt !== 'string' || typeof r?.refreshJwt !== 'string') return false;
      useSession({ ...s, accessJwt: r.accessJwt, refreshJwt: r.refreshJwt, handle: String(r.handle ?? s.handle) });
      link.log('info', 'refreshed the session');
      return true;
    } catch (e) {
      const err = e as XrpcError;
      if (err.failure === 'auth' || err.status === 400) return false;
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** The session ended for good: forget it and sign in again with the app password. */
function relogin(my: number) {
  link.log('info', 'the session ended; signing in again');
  useSession(null);
  me = null;
  setPhase('starting');
  void login(my);
}

/** One request; an expired access token is refreshed once and the request made again. */
async function x<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof XrpcError && e.failure === 'auth' && (e.code === null || EXPIRED.has(e.code)))) throw e;
    if (!(await refresh())) throw e;
    return f();
  }
}
const q = <T = any>(nsid: string, params?: Params) => x(() => api.query<T>(nsid, params));
const proc = <T = any>(nsid: string, body?: unknown) => x(() => api.procedure<T>(nsid, body));

async function check(my: number) {
  try {
    const s = await q('com.atproto.server.getSession');
    if (my !== gen) return;
    if (s?.active === false) {
      setPhase('signin', `Bluesky says this account is ${s.status ?? 'not active'}.`);
      return;
    }
    ctx.self = String(s.did);
    me = await q('app.bsky.actor.getProfile', { actor: ctx.self }).catch(() => ({ did: s.did, handle: s.handle }));
    if (my !== gen) return;
    failures = 0;
    link.log('info', 'signed in');
    setPhase('online');
    link.emit({ t: 'identity', identity: identityOf(me, ctx) });
    link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
    void tick(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as XrpcError;
    if (err.failure === 'auth') return relogin(my);
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `session check failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void check(my));
  }
}

// ---------------------------------------------------------------- notifications

async function tick(my: number) {
  if (my !== gen || phase !== 'online') return;
  let wait = POLL_MS;
  try {
    await poll();
    failures = 0;
  } catch (e) {
    if (my !== gen) return;
    const err = e as XrpcError;
    if (err.failure === 'auth') return relogin(my);
    failures++;
    wait = err.retryAt ? Math.max(err.retryAt - Date.now(), POLL_MS) : Math.max(backoff(), POLL_MS);
    link.log('warn', `notifications failed (${err.status}); again in ${Math.round(wait / 1000)} s`);
  }
  if (my !== gen) return;
  status();
  later(wait, () => void tick(my));
}

/** Post views by URI, 25 at a time (getPosts' limit). */
async function views(uris: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < uris.length; i += 25) {
    const r = await q('app.bsky.feed.getPosts', { uris: uris.slice(i, i + 25) });
    for (const p of Array.isArray(r?.posts) ? r.posts : []) out.set(String(p.uri), p);
  }
  return out;
}

async function emitAll(list: any[], live: boolean): Promise<number[]> {
  const posts = await views(urisToFetch(list));
  const out: number[] = [];
  for (const n of list) {
    const e = feedEntryOf(n, posts, ctx, seen);
    if (!e) continue;
    for (const p of e.people) link.emit({ t: 'identity', identity: p });
    link.emit({ t: 'message', message: e.message, live: live && Date.now() - e.message.ts < LIVE_MS });
    out.push(e.message.ts);
  }
  return out;
}

const at = (n: any) => String(n?.indexedAt ?? '');

/** Notifications since the newest heard, oldest first; a fresh account reads its last page as backfill. */
async function poll() {
  if (!st.started) {
    const r = await q('app.bsky.notification.listNotifications', { limit: PAGE });
    const list: any[] = Array.isArray(r?.notifications) ? r.notifications : [];
    await emitAll([...list].reverse(), false);
    remember(list);
    st.started = true;
  } else {
    const fresh: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await q('app.bsky.notification.listNotifications', { limit: PAGE, ...(cursor ? { cursor } : {}) });
      const list: any[] = Array.isArray(r?.notifications) ? r.notifications : [];
      const newer = list.filter((n) => !st.newest || at(n) > st.newest || (at(n) === st.newest && !st.newestUris.includes(String(n.uri))));
      fresh.push(...newer);
      cursor = typeof r?.cursor === 'string' ? r.cursor : undefined;
      if (newer.length < list.length || !cursor || !list.length) break;
    }
    if (fresh.length) {
      await emitAll([...fresh].reverse(), true);
      remember(fresh);
    }
  }
  polls++;
  lastPollAt = Date.now();
  save();
}
/** The newest of these (newest first) as the mark the next poll reads after. */
function remember(list: any[]) {
  const top = list.reduce<string | null>((m, n) => (at(n) > (m ?? '') ? at(n) : m), null);
  if (!top || (st.newest && top < st.newest)) return;
  const uris = list.filter((n) => at(n) === top).map((n) => String(n.uri));
  st.newestUris = top === st.newest ? [...new Set([...st.newestUris, ...uris])] : uris;
  st.newest = top;
}

// ---------------------------------------------------------------- commands

const emitPeople = (people: Map<string, P.IdentityFact>) => {
  for (const p of people.values()) link.emit({ t: 'identity', identity: p });
};

function uri(post: string): string {
  const u = uriOfPost(post);
  if (!u) throw new RefusalError('That is not a Bluesky post id (<did>~<rkey>)', 404);
  return u;
}

/** An XrpcError as the refusal an app reads: the server's status and words. */
async function ask<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof XrpcError) {
      if (e.failure === 'auth') relogin(gen);
      throw new RefusalError(e.failure === 'missing' ? 'Bluesky has no such post or person' : e.message, e.failure === 'missing' ? 404 : e.status);
    }
    throw e;
  }
}

async function command(cmd: P.AdapterCommand): Promise<unknown> {
  if (cmd.t === 'action') return action(cmd.action, cmd.args);
  if (phase !== 'online') throw new RefusalError(phase === 'signin' || phase === 'code' ? 'Not signed in to Bluesky yet' : 'Bluesky is not reachable just now', 503);
  switch (cmd.t) {
    case 'history':
      return ask(() => history(cmd.conversation, cmd.limit, cmd.cursor, cmd.beforeTs));
    case 'home':
      return ask(() => home(cmd.feed, cmd.cursor, cmd.count));
    case 'post':
      return ask(() => thread(cmd.post, cmd.cursor));
    case 'postAct':
      return ask(() => postAct(cmd.post, cmd.act));
    case 'publish':
      return ask(() => publish(cmd));
    case 'unpublish':
      return ask(() => unpublish(cmd.post));
    case 'postReactors':
      return ask(() => reactors(cmd.post, cmd.kind, cmd.cursor));
    case 'profile':
      return ask(() => profile(cmd.who));
    default:
      throw new RefusalError(`A Bluesky account does not do ${cmd.t}`, 400);
  }
}

async function action(name: string, args: unknown) {
  const a = (args ?? {}) as { password?: unknown; code?: unknown };
  switch (name) {
    case 'relogin': {
      if (a.password !== undefined && (typeof a.password !== 'string' || !a.password.trim())) throw new RefusalError('Type an app password', 400);
      if (typeof a.password === 'string') saveSecret({ password: a.password.trim() });
      const my = ++gen;
      clearTimeout(timer);
      useSession(null);
      me = null;
      setPhase('starting');
      await login(my);
      if (phase === 'signin') throw new RefusalError(problem ?? 'It did not sign in', 400);
      return { signedIn: phase === 'online', needsCode: phase === 'code' };
    }
    case 'signIn': {
      const code = typeof a.code === 'string' ? a.code.trim().toUpperCase() : '';
      if (!/^[A-Z0-9]{5}-?[A-Z0-9]{5}$/.test(code)) throw new RefusalError('Type the code from the email Bluesky sent, like ABCDE-12345', 400);
      const my = ++gen;
      clearTimeout(timer);
      await login(my, code.includes('-') ? code : `${code.slice(0, 5)}-${code.slice(5)}`);
      return { signedIn: phase === 'online' };
    }
    case 'poll':
      if (phase !== 'online') throw new RefusalError('Not signed in yet', 503);
      await ask(() => poll());
      status();
      return { newest: st.newest };
    default:
      throw new RefusalError(`No action ${name} here (relogin, signIn, poll)`, 400);
  }
}

/** Older notifications, by the last page's `next` (Bluesky's cursor), or the newest page. */
async function history(conversation: string, limit: number, cursor?: string, beforeTs?: number): Promise<P.HistoryResult> {
  if (conversation !== feedConvId(ctx.self)) throw new RefusalError('Only the notifications have history here', 404);
  let next = cursor ?? null;
  let count = 0;
  let oldest: number | undefined;
  const want = Math.max(1, Math.min(PAGE, limit || PAGE));
  for (let page = 0; page < 5; page++) {
    const r = await q('app.bsky.notification.listNotifications', { limit: want, ...(next ? { cursor: next } : {}) });
    const list: any[] = Array.isArray(r?.notifications) ? r.notifications : [];
    next = typeof r?.cursor === 'string' && list.length ? r.cursor : null;
    if (!list.length) return { count, done: true, ...(oldest ? { oldest } : {}) };
    // Without a cursor, a time: skip pages newer than it.
    const older = !cursor && beforeTs ? list.filter((n) => Date.parse(at(n)) < beforeTs) : list;
    for (const ts of await emitAll(older, false)) {
      count++;
      oldest = oldest === undefined ? ts : Math.min(oldest, ts);
    }
    if (older.length || cursor || !next) return { count, done: !next || list.length < want, ...(oldest ? { oldest } : {}), ...(next ? { next } : {}) };
  }
  return { count, done: false, ...(next ? { next } : {}) };
}

async function home(feed: P.HomeFeed, cursor?: string, count?: number): Promise<P.HomePage> {
  const limit = Math.max(1, Math.min(100, count ?? 20));
  const people = new Map<string, P.IdentityFact>();
  const r = feed === 'foryou' ? await q('app.bsky.feed.getFeed', { feed: DISCOVER, limit, ...(cursor ? { cursor } : {}) }) : await q('app.bsky.feed.getTimeline', { limit, ...(cursor ? { cursor } : {}) });
  const list: any[] = Array.isArray(r?.feed) ? r.feed : [];
  const items = list
    .filter((i) => i?.post?.uri)
    .map((i) => {
      const item = homeItemOf(i, ctx, people, seen);
      return feed === 'foryou' && !item.reason ? { ...item, reason: { text: 'Discover', kind: 'topic' as const } } : item;
    });
  emitPeople(people);
  // Bluesky's timelines page only backwards: no cursor for what came since.
  return { items, more: list.length && typeof r?.cursor === 'string' ? r.cursor : null, top: null };
}

async function thread(post: string, cursor?: string): Promise<P.PostThread> {
  const u = uri(post);
  // The thread comes whole (as deep as asked): there is never a next page.
  if (cursor) return { ancestors: [], replies: [], more: null };
  const r = await q('app.bsky.feed.getPostThread', { uri: u, depth: 10, parentHeight: 80 });
  const t = r?.thread;
  if (!t || !String(t.$type ?? '').endsWith('#threadViewPost')) throw new XrpcError(String(t?.$type ?? '').endsWith('#blockedPost') ? 'That post is blocked' : 'Bluesky has no such post', 404, 'missing');
  const people = new Map<string, P.IdentityFact>();
  const out = threadOf(t, ctx, people, seen);
  emitPeople(people);
  return out;
}

/** A post's cid and your like and repost: as last seen, or asked for. */
async function knownOf(u: string, fresh = false): Promise<Known> {
  if (!fresh && known.has(u)) return known.get(u)!;
  const p = (await views([u])).get(u);
  if (!p) throw new XrpcError('Bluesky has no such post', 404, 'missing');
  const people = new Map<string, P.IdentityFact>();
  postOf(p, ctx, people, seen);
  return known.get(u)!;
}

const now = () => new Date().toISOString();
const createRecord = (collection: string, record: Record<string, unknown>, rkey?: string) => proc<{ uri: string; cid: string }>('com.atproto.repo.createRecord', { repo: ctx.self, collection, record: { $type: collection, ...record }, ...(rkey ? { rkey } : {}) });
async function deleteRecord(recordUri: string) {
  const p = parseUri(recordUri);
  if (!p || p.did !== ctx.self) return;
  try {
    await proc('com.atproto.repo.deleteRecord', { repo: ctx.self, collection: p.collection, rkey: p.rkey });
  } catch (e) {
    if (!(e instanceof XrpcError && e.failure === 'missing')) throw e;
  }
}

async function postAct(post: string, act: P.PostAct): Promise<P.PostViewer> {
  const u = uri(post);
  if (!['like', 'unlike', 'repost', 'unrepost'].includes(act)) throw new RefusalError(`No such act: ${act}`, 400);
  // Undoing needs the record to delete: ask when it is not known.
  let k = await knownOf(u, (act === 'unlike' && !known.get(u)?.like) || (act === 'unrepost' && !known.get(u)?.repost));
  const subject = { uri: u, cid: k.cid };
  if (act === 'like' && !k.like) k = { ...k, like: (await createRecord('app.bsky.feed.like', { subject, createdAt: now() })).uri };
  else if (act === 'repost' && !k.repost) k = { ...k, repost: (await createRecord('app.bsky.feed.repost', { subject, createdAt: now() })).uri };
  else if (act === 'unlike' && k.like) {
    await deleteRecord(k.like);
    k = { ...k, like: undefined };
  } else if (act === 'unrepost' && k.repost) {
    await deleteRecord(k.repost);
    k = { ...k, repost: undefined };
  }
  seen(u, k);
  return { liked: !!k.like, reposted: !!k.repost };
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function upload(file: P.OutgoingAttachment): Promise<unknown> {
  const data = Bun.file(file.path, { type: file.mime });
  if (data.size > LIMITS.imageBytes) throw new RefusalError(`${file.name} is ${Math.round(data.size / 1000)} kB; Bluesky takes pictures up to ${LIMITS.imageBytes / 1000} kB`, 413);
  const r = await x(() => api.procedure('com.atproto.repo.uploadBlob', undefined, { bytes: { data, type: file.mime }, timeoutMs: 120_000 }));
  if (!r?.blob) throw new RefusalError(`Bluesky did not take ${file.name}`, 502);
  return r.blob;
}

/** Facets for links, @handles (resolved to DIDs; one that resolves to nobody stays words) and #tags. */
async function facetsOf(text: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const f of findFacets(text)) {
    let feature: Record<string, unknown> | null = null;
    if (f.kind === 'link') feature = { $type: 'app.bsky.richtext.facet#link', uri: f.value };
    else if (f.kind === 'tag') feature = { $type: 'app.bsky.richtext.facet#tag', tag: f.value };
    else {
      const did = await api
        .query('com.atproto.identity.resolveHandle', { handle: f.value })
        .then((r) => (typeof r?.did === 'string' ? r.did : null))
        .catch(() => null);
      if (did) feature = { $type: 'app.bsky.richtext.facet#mention', did };
    }
    if (feature) out.push({ index: { byteStart: f.start, byteEnd: f.end }, features: [feature] });
  }
  return out;
}

/** Publishes already made, by the command's id: the same command twice makes one post. */
const made = new Map<string, Promise<P.PostFact>>();

function publish(cmd: Extract<P.AdapterCommand, { t: 'publish' }>): Promise<P.PostFact> {
  const was = made.get(cmd.id);
  if (was) return was;
  const p = publishOnce(cmd);
  made.set(cmd.id, p);
  p.catch(() => made.delete(cmd.id));
  if (made.size > 200) made.delete(made.keys().next().value!);
  return p;
}

async function publishOnce(cmd: Extract<P.AdapterCommand, { t: 'publish' }>): Promise<P.PostFact> {
  if (cmd.title) throw new RefusalError('Bluesky posts have no title', 400);
  if (cmd.place) throw new RefusalError('Bluesky posts go to your profile, not a place', 400);
  if (cmd.warning) throw new RefusalError('Bluesky has no content warnings you write yourself (only labels)', 400);
  if (cmd.replies && cmd.replies !== 'everyone' && cmd.replyTo) throw new RefusalError('Who may reply is set on a new post, not on a reply', 400);
  if (cmd.replies === 'verified') throw new RefusalError('Bluesky cannot limit replies to verified accounts', 400);
  const media = cmd.media ?? [];
  if (media.some((m) => !IMAGE_TYPES.has(m.mime))) throw new RefusalError('Only pictures (JPEG, PNG, WebP, GIF) go on a Bluesky post from here: no videos yet', 400);
  if (media.length > LIMITS.images) throw new RefusalError(`Bluesky takes at most ${LIMITS.images} pictures on a post`, 400);
  if (!cmd.text.trim() && !media.length && !cmd.quote) throw new RefusalError('There is nothing to post', 400);
  const length = graphemes(cmd.text);
  if (length > LIMITS.chars) throw new RefusalError(`That is ${length} characters; Bluesky takes ${LIMITS.chars}`, 400);

  const record: Record<string, unknown> = { text: cmd.text, createdAt: now() };
  let parentAuthor: string | undefined;
  if (cmd.replyTo) {
    const pu = uri(cmd.replyTo);
    const parent = (await views([pu])).get(pu);
    if (!parent) throw new XrpcError('Bluesky has no such post', 404, 'missing');
    if (parent.viewer?.replyDisabled) throw new RefusalError('Its author does not let you reply to this post', 403);
    const root = parent.record?.reply?.root?.uri && parent.record.reply.root.cid ? parent.record.reply.root : { uri: parent.uri, cid: parent.cid };
    record.reply = { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid } };
    parentAuthor = parent.author?.did;
  }
  let quote: { uri: string; cid: string } | null = null;
  if (cmd.quote) {
    const qu = uri(cmd.quote);
    const qv = (await views([qu])).get(qu);
    if (!qv) throw new XrpcError('Bluesky has no such post', 404, 'missing');
    if (qv.viewer?.embeddingDisabled) throw new RefusalError('Its author does not let you quote this post', 403);
    quote = { uri: qv.uri, cid: qv.cid };
  }
  const facets = await facetsOf(cmd.text);
  if (facets.length) record.facets = facets;
  const images: unknown[] = [];
  for (const f of media) images.push({ image: await upload(f), alt: '' });
  const imagesEmbed = images.length ? { $type: 'app.bsky.embed.images', images } : null;
  if (quote && imagesEmbed) record.embed = { $type: 'app.bsky.embed.recordWithMedia', record: { $type: 'app.bsky.embed.record', record: quote }, media: imagesEmbed };
  else if (quote) record.embed = { $type: 'app.bsky.embed.record', record: quote };
  else if (imagesEmbed) record.embed = imagesEmbed;

  const r = await createRecord(POST, record);
  if (cmd.replies && cmd.replies !== 'everyone') {
    const rkey = parseUri(r.uri)!.rkey;
    const allow = [{ $type: cmd.replies === 'following' ? 'app.bsky.feed.threadgate#followingRule' : 'app.bsky.feed.threadgate#mentionRule' }];
    await createRecord('app.bsky.feed.threadgate', { post: r.uri, allow, createdAt: now() }, rkey);
  }
  link.log('info', `posted ${parseUri(r.uri)?.rkey}${cmd.replyTo ? ' as a reply' : ''}`);
  const people = new Map<string, P.IdentityFact>();
  // The app view may not have it yet: then the post as written.
  const view = (await views([r.uri]).catch(() => new Map<string, any>())).get(r.uri);
  const post = postOf(view ?? { uri: r.uri, cid: r.cid, author: me, record: { $type: POST, ...record }, indexedAt: record.createdAt }, ctx, people, seen, 0, parentAuthor);
  if (!view && quote) post.quoteOf = { id: cmd.quote!, url: '', ts: 0, text: '', author: parseUri(quote.uri)?.did };
  if (!view && cmd.replies && cmd.replies !== 'everyone') post.replies = cmd.replies;
  emitPeople(people);
  return post;
}

async function unpublish(post: string): Promise<{ deleted: true }> {
  const p = parseUri(uri(post))!;
  if (p.did !== ctx.self) throw new RefusalError('That post is not yours', 403);
  await deleteRecord(`at://${p.did}/${POST}/${p.rkey}`);
  // Its reply gate, if it had one, goes with it.
  await deleteRecord(`at://${p.did}/app.bsky.feed.threadgate/${p.rkey}`).catch(() => {});
  known.delete(`at://${p.did}/${POST}/${p.rkey}`);
  return { deleted: true };
}

async function reactors(post: string, kind: 'like' | 'repost', cursor?: string): Promise<P.ReactorsPage> {
  const u = uri(post);
  const r = kind === 'like' ? await q('app.bsky.feed.getLikes', { uri: u, limit: 50, ...(cursor ? { cursor } : {}) }) : await q('app.bsky.feed.getRepostedBy', { uri: u, limit: 50, ...(cursor ? { cursor } : {}) });
  const list: any[] = kind === 'like' ? (Array.isArray(r?.likes) ? r.likes.map((l: any) => l?.actor) : []) : Array.isArray(r?.repostedBy) ? r.repostedBy : [];
  const who: P.ReactorsPage['who'] = [];
  for (const a of list) {
    if (!a?.did) continue;
    const i = identityOf(a, ctx);
    link.emit({ t: 'identity', identity: i });
    who.push({ id: i.nativeId, ...(a.viewer?.following ? { following: true } : {}), ...(a.viewer?.followedBy ? { followsYou: true } : {}), ...(a.verification?.verifiedStatus === 'valid' ? { verified: true } : {}) });
  }
  return { who, more: list.length && typeof r?.cursor === 'string' ? r.cursor : null };
}

async function profile(who: string): Promise<P.PersonAbout> {
  const actor = who.replace(/^@/, '');
  const a = await q('app.bsky.actor.getProfile', { actor });
  const feed = await q('app.bsky.feed.getAuthorFeed', { actor: a.did, limit: 20, filter: 'posts_and_author_threads', includePins: true }).catch(() => ({ feed: [] }));
  const people = new Map<string, P.IdentityFact>();
  const ident = identityOf(a, ctx);
  people.set(ident.nativeId, ident);
  const posts = (Array.isArray(feed?.feed) ? feed.feed : [])
    .filter((i: any) => i?.post?.uri)
    .map((i: any) => homeItemOf(i, ctx, people, seen).post)
    .slice(0, 20);
  emitPeople(people);
  return { ...personAbout(a), ...(a.did === ctx.self ? { relationship: undefined, followsYou: undefined } : {}), posts };
}

process.on('unhandledRejection', (e) => link.log('error', `unhandled rejection: ${String((e as any)?.stack ?? e)}`));
begin();
