/**
 * The mastodon extractor: one Mastodon account through its server's REST API, answering `chat` with posts only
 * (docs/mastodon.md). No browser and no streaming: plain requests, paced.
 *
 *   sign-in: a pasted access token (secret.json `token`), or out-of-band OAuth: the extractor registers an app on the
 *   server (POST /api/v1/apps, kept in secret.json `app`), shows the owner a "Sign in on <server>" link in its
 *   attention, and swaps the code they paste back (the `signIn` action) for a token (POST /oauth/token).
 *   → GET /api/v1/accounts/verify_credentials → the notifications conversation (variant 'feed'), polled every minute
 *   with min_id; the home timeline, trends, threads, profiles and answering only when asked.
 *
 * Nothing is marked read on the server. It logs ids, counts and statuses, never the token or what a post says.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { linkHub, RefusalError } from '@dither-chat/protocol/client';
import { Api, ApiError, baseOf, parseLink, queryParam } from './http.ts';
import { acctOf, chainsOf, type Ctx, feedConversation, feedConvId, feedEntryOf, identityOf, localIdOf, personAbout, postOf, statusLength } from './map.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** How often notifications are asked for. */
const POLL_MS = num('DITHER_MASTODON_POLL_MS', 60_000);
/** Waits after failures (no answer, 5xx): this, doubling, up to ten minutes. */
const BACKOFF_MS = num('DITHER_MASTODON_BACKOFF_MS', 5_000);
/** How long an uploaded picture or video may take to be processed. */
const MEDIA_WAIT_MS = num('DITHER_MASTODON_MEDIA_WAIT_MS', 60_000);
/** A notification younger than this when it is first heard counts as live (it may alert). */
const LIVE_MS = 15 * 60_000;
const PAGE = 40;
/** At most this many pages of notifications in one poll (a long time offline). */
const MAX_PAGES = 10;
const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const SCOPES = 'read write follow';
const CAPABILITIES: P.Capability[] = ['history', 'profile', 'posts', 'postActions', 'publish', 'postReactors', 'home', 'unpublish', 'postMedia'];

type Phase = 'starting' | 'signin' | 'unreachable' | 'online';
interface Secret {
  token?: string;
  /** The app registered on the server, for this base URL. */
  app?: { base: string; clientId: string; clientSecret: string };
}

const base = baseOf((JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}') as { instance?: unknown }).instance);

let phase: Phase = 'starting';
let problem: string | null = null;
let token: string | null = null;
let me: any = null;
const ctx: Ctx = { host: base ? new URL(base).host : '', domain: base ? new URL(base).host : '', self: null };
/** The server's limits for a status: characters, what a link counts as, pictures. */
let limits = { chars: 500, url: 23, media: 4 };
let signInUrl: string | null = null;
let gen = 0;
let timer: Timer | undefined;
let failures = 0;
let polls = 0;
let lastPollAt: number | null = null;

const link = linkHub({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'mastodon', version: '1', capabilities: CAPABILITIES });
    status();
    if (phase === 'online') link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
  },
  onCommand: (cmd) => command(cmd),
  onShutdown: () => save(),
});

const api = new Api(base ?? 'https://invalid', () => token);

// ---------------------------------------------------------------- state

const statePath = join(link.accountDir, 'state.json');
interface State {
  /** The newest notification heard, by id; null before the first read. */
  newest: string | null;
  started: boolean;
}
const st: State = (() => {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return { newest: typeof s.newest === 'string' ? s.newest : null, started: !!s.started };
  } catch {
    return { newest: null, started: false };
  }
})();
function save() {
  try {
    writeFileSync(statePath, JSON.stringify(st), { mode: 0o600 });
  } catch (e) {
    link.log('error', `could not write state.json: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- status

function status() {
  const host = ctx.host || 'the server';
  const layers: P.StatusLayer[] = [
    { name: host, state: phase === 'unreachable' ? 'failed' : phase === 'starting' && !me ? 'waiting' : 'ok', ...(phase === 'unreachable' && problem ? { note: problem } : {}) },
    { name: 'signed in', state: phase === 'online' ? 'ok' : phase === 'signin' ? 'failed' : 'waiting', ...(phase === 'signin' && problem ? { note: problem } : me ? { note: `@${ctx.self}` } : {}) },
    { name: 'notifications', state: phase !== 'online' ? 'waiting' : failures ? 'failed' : polls ? 'ok' : 'waiting', ...(lastPollAt ? { note: `read ${new Date(lastPollAt).toISOString()}` } : {}) },
  ];
  const attention: Omit<P.Attention, 'since'> | null =
    phase === 'signin'
      ? {
          kind: 'login',
          message: problem ?? `Sign in on ${host}: open the link, approve, and paste the code it shows.`,
          ...(signInUrl ? { detail: { signIn: { url: signInUrl, host, action: 'signIn' } satisfies P.SignInCheck } } : {}),
        }
      : null;
  link.emit({
    t: 'status',
    status: phase === 'online' ? 'online' : phase === 'signin' ? 'attention' : phase === 'unreachable' ? 'error' : 'connecting',
    attention,
    ...(me ? { self: identityOf(me, ctx) } : {}),
    details: { instance: host, polls, lastPollAt, ...(api.remaining !== null ? { rateRemaining: api.remaining } : {}) },
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

function begin() {
  const my = ++gen;
  clearTimeout(timer);
  me = null;
  failures = 0;
  if (!base) return setPhase('signin', 'This account has no server address. Add it again with your server, like https://mastodon.example.');
  const s = readSecret();
  token = typeof s.token === 'string' && s.token.trim() ? s.token.trim() : null;
  if (!token) return void offerSignIn(my);
  setPhase('starting');
  void check(my);
}

/** Register the app if this server has none from us yet, and show the sign-in link. */
async function offerSignIn(my: number, why: string | null = null) {
  try {
    let app = readSecret().app;
    if (!app || app.base !== base) {
      const r = await api.req('POST', '/api/v1/apps', { json: { client_name: 'dither-accounts', redirect_uris: OOB, scopes: SCOPES }, anonymous: true });
      if (my !== gen) return;
      if (!r.body?.client_id || !r.body?.client_secret) throw new ApiError(`${ctx.host} did not register the app`, 502, 'http');
      app = { base: base!, clientId: String(r.body.client_id), clientSecret: String(r.body.client_secret) };
      saveSecret({ app });
      link.log('info', `registered an app on ${ctx.host}`);
    }
    signInUrl = api.url('/oauth/authorize', { client_id: app.clientId, scope: SCOPES, redirect_uri: OOB, response_type: 'code' });
    setPhase('signin', why);
  } catch (e) {
    if (my !== gen) return;
    const err = e as ApiError;
    failures++;
    setPhase('unreachable', `Could not register with ${ctx.host}: ${err.message}`);
    link.log('warn', `app registration failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    later(backoff(), () => void offerSignIn(my, why));
  }
}

/** The code the owner pasted: swapped for a token; a pasted access token works here too. */
async function signIn(args: unknown) {
  const code = typeof (args as { code?: unknown })?.code === 'string' ? (args as { code: string }).code.trim() : '';
  if (!code) throw new RefusalError('Paste the code your server showed after you approved.', 400);
  if (!base) throw new RefusalError('This account has no server address.', 400);
  const app = readSecret().app;
  let got: string | null = null;
  let refusal = '';
  if (app && app.base === base) {
    try {
      const r = await api.req('POST', '/oauth/token', { json: { grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: OOB, scope: SCOPES }, anonymous: true });
      if (typeof r.body?.access_token === 'string') got = r.body.access_token;
    } catch (e) {
      const err = e as ApiError;
      if (err.failure === 'network' || err.failure === 'rate') throw new RefusalError(err.message, err.status);
      refusal = err.message;
    }
  }
  if (!got) {
    // Not a code this app can swap: an access token pasted instead?
    const probe = new Api(base, () => code);
    try {
      await probe.req('GET', '/api/v1/accounts/verify_credentials');
      got = code;
    } catch {
      throw new RefusalError(`${ctx.host} did not take that code${refusal ? ` (${refusal})` : ''}: it is used once and expires; sign in again for a new one.`, 400);
    }
  }
  saveSecret({ token: got });
  link.log('info', `signed in on ${ctx.host}`);
  begin();
  return { signedIn: true };
}

async function check(my: number) {
  try {
    const r = await api.req('GET', '/api/v1/accounts/verify_credentials');
    if (my !== gen) return;
    await readInstance();
    if (my !== gen) return;
    me = r.body;
    ctx.self = acctOf(me, ctx);
    failures = 0;
    link.log('info', `signed in as ${ctx.self}`);
    setPhase('online');
    link.emit({ t: 'identity', identity: identityOf(me, ctx) });
    link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
    void tick(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as ApiError;
    if (err.failure === 'auth' || err.failure === 'forbidden') {
      link.log('warn', `${ctx.host} refused the token (${err.status})`);
      token = null;
      saveSecret({ token: undefined });
      return void offerSignIn(my, `${ctx.host} no longer takes this account's sign-in (${err.message}). Sign in again: open the link, approve, and paste the code.`);
    }
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `sign-in check failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void check(my));
  }
}

/** The server's own domain and its limits for a status (v2, else v1). */
async function readInstance() {
  let i: any = null;
  try {
    i = (await api.req('GET', '/api/v2/instance')).body;
  } catch {
    try {
      i = (await api.req('GET', '/api/v1/instance')).body;
    } catch {
      return;
    }
  }
  const domain = i?.domain ?? (typeof i?.uri === 'string' ? i.uri.replace(/^https?:\/\//, '') : null);
  if (typeof domain === 'string' && domain) ctx.domain = domain;
  const s = i?.configuration?.statuses;
  limits = {
    chars: Number(s?.max_characters) || Number(i?.max_toot_chars) || 500,
    url: Number(s?.characters_reserved_per_url) || 23,
    media: Number(s?.max_media_attachments) || 4,
  };
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
    const err = e as ApiError;
    if (err.failure === 'auth') return void check(my);
    failures++;
    wait = err.retryAt ? Math.max(err.retryAt - Date.now(), POLL_MS) : Math.max(backoff(), POLL_MS);
    link.log('warn', `notifications failed (${err.status}); again in ${Math.round(wait / 1000)} s`);
  }
  if (my !== gen) return;
  status();
  later(wait, () => void tick(my));
}

function emitEntry(n: any, live: boolean): number | null {
  const e = feedEntryOf(n, ctx);
  if (!e) return null;
  for (const p of e.people) link.emit({ t: 'identity', identity: p });
  link.emit({ t: 'message', message: e.message, live: live && Date.now() - e.message.ts < LIVE_MS });
  return e.message.ts;
}

/** Notifications since the newest heard, oldest first; a fresh account reads its last page as backfill. */
async function poll() {
  if (!st.started) {
    const r = await api.req('GET', '/api/v1/notifications', { query: { limit: PAGE } });
    const list: any[] = Array.isArray(r.body) ? r.body : [];
    for (const n of [...list].reverse()) emitEntry(n, false);
    st.newest = list[0]?.id ? String(list[0].id) : null;
    st.started = true;
  } else {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await api.req('GET', '/api/v1/notifications', { query: { limit: PAGE, ...(st.newest ? { min_id: st.newest } : {}) } });
      const list: any[] = Array.isArray(r.body) ? r.body : [];
      if (!list.length) break;
      for (const n of [...list].reverse()) emitEntry(n, true);
      st.newest = String(list[0].id);
      if (list.length < PAGE || !st.newest) break;
    }
  }
  polls++;
  lastPollAt = Date.now();
  save();
}

// ---------------------------------------------------------------- commands

const emitPeople = (people: Map<string, P.IdentityFact>) => {
  for (const p of people.values()) link.emit({ t: 'identity', identity: p });
};

function local(post: string): string {
  const id = localIdOf(post, ctx);
  if (!id) throw new RefusalError(`That post is not one ${ctx.host} gave this account`, 404);
  return id;
}

/** An ApiError as the refusal an app reads: the server's status and words. */
async function ask<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.failure === 'auth') void check(gen);
      throw new RefusalError(e.failure === 'missing' ? `${ctx.host} has no such post or person` : e.message, e.status);
    }
    throw e;
  }
}

async function command(cmd: P.AdapterCommand): Promise<unknown> {
  if (cmd.t === 'action') return action(cmd.action, cmd.args);
  if (phase !== 'online') throw new RefusalError(phase === 'signin' ? `Not signed in on ${ctx.host || 'the server'} yet` : `${ctx.host || 'The server'} is not reachable just now`, 503);
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
      throw new RefusalError(`A Mastodon account does not do ${cmd.t}`, 400);
  }
}

async function action(name: string, args: unknown) {
  switch (name) {
    case 'signIn':
      return signIn(args);
    case 'startSignIn':
    case 'relogin': {
      saveSecret({ token: undefined });
      token = null;
      const my = ++gen;
      clearTimeout(timer);
      me = null;
      await offerSignIn(my);
      return { signInUrl };
    }
    case 'poll':
      if (phase !== 'online') throw new RefusalError('Not signed in yet', 503);
      await ask(() => poll());
      status();
      return { newest: st.newest };
    default:
      throw new RefusalError(`No action ${name} here (signIn, startSignIn, poll)`, 400);
  }
}

/** Older notifications, by the last page's `next` (a notification id), or the newest page. */
async function history(conversation: string, limit: number, cursor?: string, beforeTs?: number): Promise<P.HistoryResult> {
  if (conversation !== feedConvId(ctx.self)) throw new RefusalError('Only the notifications have history here', 404);
  let max = cursor ?? null;
  let count = 0;
  let oldest: number | undefined;
  const want = Math.max(1, Math.min(PAGE, limit || PAGE));
  for (let page = 0; page < 5; page++) {
    const r = await api.req('GET', '/api/v1/notifications', { query: { limit: want, ...(max ? { max_id: max } : {}) } });
    const list: any[] = Array.isArray(r.body) ? r.body : [];
    if (!list.length) return { count, done: true, ...(oldest ? { oldest } : {}) };
    max = String(list[list.length - 1].id);
    // Without a cursor, a time: skip pages newer than it.
    const older = !cursor && beforeTs ? list.filter((n) => Date.parse(n.created_at) < beforeTs) : list;
    for (const n of older) {
      const ts = emitEntry(n, false);
      if (ts !== null) {
        count++;
        oldest = oldest === undefined ? ts : Math.min(oldest, ts);
      }
    }
    if (older.length || cursor) return { count, done: list.length < want, ...(oldest ? { oldest } : {}), next: max };
  }
  return { count, done: false, next: max! };
}

async function home(feed: P.HomeFeed, cursor?: string, count?: number): Promise<P.HomePage> {
  const limit = Math.max(1, Math.min(40, count ?? 20));
  const people = new Map<string, P.IdentityFact>();
  if (feed === 'foryou') {
    const offset = cursor?.startsWith('off:') ? Number(cursor.slice(4)) || 0 : 0;
    const r = await api.req('GET', '/api/v1/trends/statuses', { query: { limit, offset } });
    const list: any[] = Array.isArray(r.body) ? r.body : [];
    const items = list.map((s) => ({ post: postOf(s, ctx, people), reason: { text: `Trending on ${ctx.domain}`, kind: 'topic' as const } }));
    emitPeople(people);
    return { items, more: list.length ? `off:${offset + list.length}` : null, top: null };
  }
  const query: Record<string, string | number> = { limit };
  if (cursor?.startsWith('max:')) query.max_id = cursor.slice(4);
  else if (cursor?.startsWith('min:')) query.min_id = cursor.slice(4);
  const r = await api.req('GET', '/api/v1/timelines/home', { query });
  const list: any[] = Array.isArray(r.body) ? r.body : [];
  const items = list.map((s) => ({ post: postOf(s, ctx, people) }));
  emitPeople(people);
  return {
    items,
    more: list.length ? `max:${list[list.length - 1].id}` : cursor?.startsWith('min:') ? null : null,
    top: list.length ? `min:${list[0].id}` : cursor?.startsWith('min:') ? cursor : null,
  };
}

async function thread(post: string, cursor?: string): Promise<P.PostThread> {
  const id = local(post);
  // Mastodon gives the whole context at once: there is never a next page.
  if (cursor) return { ancestors: [], replies: [], more: null };
  const [s, c] = await Promise.all([api.req('GET', `/api/v1/statuses/${id}`), api.req('GET', `/api/v1/statuses/${id}/context`)]);
  const people = new Map<string, P.IdentityFact>();
  const focal = postOf(s.body, ctx, people);
  const ancestors = (Array.isArray(c.body?.ancestors) ? c.body.ancestors : []).map((a: any) => postOf(a, ctx, people));
  const replies = chainsOf(id, Array.isArray(c.body?.descendants) ? c.body.descendants : [], (d) => postOf(d, ctx, people));
  emitPeople(people);
  return { focal, ancestors, replies, more: null };
}

async function postAct(post: string, act: P.PostAct): Promise<P.PostViewer> {
  const id = local(post);
  const path = { like: 'favourite', unlike: 'unfavourite', repost: 'reblog', unrepost: 'unreblog' }[act];
  if (!path) throw new RefusalError(`No such act: ${act}`, 400);
  const r = await api.req('POST', `/api/v1/statuses/${id}/${path}`);
  // A boost answers with the boost; its `reblog` is the post.
  const s = act === 'repost' && r.body?.reblog ? r.body.reblog : r.body;
  return { liked: !!s?.favourited, reposted: act === 'repost' ? true : act === 'unrepost' ? false : !!s?.reblogged };
}

async function upload(file: P.OutgoingAttachment): Promise<string> {
  const form = new FormData();
  form.append('file', Bun.file(file.path, { type: file.mime }), file.name);
  const r = await api.req('POST', '/api/v2/media', { form, timeoutMs: 120_000 });
  const id = String(r.body?.id ?? '');
  if (!id) throw new RefusalError(`${ctx.host} did not take ${file.name}`, 502);
  if (r.status !== 202 && r.body?.url) return id;
  // 202: still being processed; ready when it has a url.
  const end = Date.now() + MEDIA_WAIT_MS;
  while (Date.now() < end) {
    await Bun.sleep(1_000);
    // 206 while it is processed, 200 with its url when done.
    const m = await api.req('GET', `/api/v1/media/${id}`);
    if (m.body?.url) return id;
  }
  throw new RefusalError(`${ctx.host} is still processing ${file.name}; try again in a minute`, 504);
}

async function publish(cmd: Extract<P.AdapterCommand, { t: 'publish' }>): Promise<P.PostFact> {
  if (cmd.replies && cmd.replies !== 'everyone') throw new RefusalError('Mastodon has no limit on who may reply', 400);
  if (cmd.title) throw new RefusalError('Mastodon posts have no title', 400);
  if (cmd.place) throw new RefusalError('Mastodon posts go to your profile, not a place', 400);
  const media = cmd.media ?? [];
  if (media.length > limits.media) throw new RefusalError(`${ctx.host} takes at most ${limits.media} pictures or videos on a post`, 400);
  if (!cmd.text.trim() && !media.length) throw new RefusalError('There is nothing to post', 400);
  let text = cmd.text;
  let visibility: string | undefined;
  let quoteId: string | undefined;
  if (cmd.replyTo) {
    const parent = (await api.req('GET', `/api/v1/statuses/${local(cmd.replyTo)}`)).body;
    // As Mastodon's own composer does: the reply names whom it answers (else they are not told), and it is no more
    // public than what it answers.
    const who = acctOf(parent?.account, ctx);
    if (who && who !== ctx.self && !new RegExp(`(^|\\s)@${reEscape(who)}\\b|(^|\\s)@${reEscape(who.split('@')[0])}(\\s|$)`, 'i').test(text)) text = `@${who} ${text}`;
    if (parent?.visibility === 'private' || parent?.visibility === 'direct') visibility = parent.visibility;
  }
  if (cmd.quote) {
    const q = (await api.req('GET', `/api/v1/statuses/${local(cmd.quote)}`)).body;
    if (q?.quote_approval && typeof q.quote_approval === 'object') {
      if (q.quote_approval.current_user === 'denied') throw new RefusalError('Its author does not let you quote this post', 403);
      quoteId = String(q.id);
    } else if (q?.url || q?.uri) {
      // A server without quote posts: the post's link at the end, as people quoted before.
      text = `${text.trimEnd()}\n\n${q.url ?? q.uri}`;
    }
  }
  const length = statusLength(text, limits.url) + (cmd.warning ? statusLength(cmd.warning, limits.url) : 0);
  if (length > limits.chars) throw new RefusalError(`That is ${length} characters; ${ctx.host} takes ${limits.chars}`, 400);
  const mediaIds: string[] = [];
  for (const f of media) mediaIds.push(await upload(f));
  const r = await api.req('POST', '/api/v1/statuses', {
    json: {
      status: text,
      ...(cmd.replyTo ? { in_reply_to_id: local(cmd.replyTo) } : {}),
      ...(cmd.warning ? { spoiler_text: cmd.warning, sensitive: true } : {}),
      ...(mediaIds.length ? { media_ids: mediaIds } : {}),
      ...(visibility ? { visibility } : {}),
      ...(quoteId ? { quoted_status_id: quoteId } : {}),
    },
    idempotencyKey: `dither-${cmd.id}`,
  });
  const people = new Map<string, P.IdentityFact>();
  const made = postOf(r.body, ctx, people);
  emitPeople(people);
  link.log('info', `posted ${made.id}${cmd.replyTo ? ' as a reply' : ''}`);
  return made;
}
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function unpublish(post: string): Promise<{ deleted: true }> {
  try {
    await api.req('DELETE', `/api/v1/statuses/${local(post)}`);
  } catch (e) {
    if (!(e instanceof ApiError && e.failure === 'missing')) throw e;
  }
  return { deleted: true };
}

async function reactors(post: string, kind: 'like' | 'repost', cursor?: string): Promise<P.ReactorsPage> {
  const r = await api.req('GET', `/api/v1/statuses/${local(post)}/${kind === 'like' ? 'favourited_by' : 'reblogged_by'}`, { query: { limit: 40, ...(cursor ? { max_id: cursor } : {}) } });
  const list: any[] = Array.isArray(r.body) ? r.body : [];
  const who: P.ReactorsPage['who'] = [];
  for (const a of list) {
    const i = identityOf(a, ctx);
    link.emit({ t: 'identity', identity: i });
    who.push({ id: i.nativeId, ...(typeof a.followers_count === 'number' ? { followers: a.followers_count } : {}) });
  }
  const next = queryParam(parseLink(r.headers.get('link')).next, 'max_id');
  return { who, more: list.length && next ? next : null };
}

async function profile(who: string): Promise<P.PersonAbout> {
  const at = who.replace(/^@/, '');
  const [user, domain] = [at.slice(0, at.lastIndexOf('@')), at.slice(at.lastIndexOf('@') + 1)];
  let a: any;
  try {
    a = (await api.req('GET', '/api/v1/accounts/lookup', { query: { acct: domain === ctx.domain && user ? user : at } })).body;
  } catch (e) {
    if (!(e instanceof ApiError && e.failure === 'missing')) throw e;
    // Someone the server has not heard of yet: asked by address, it fetches them.
    const s = (await api.req('GET', '/api/v2/search', { query: { q: `@${at}`, type: 'accounts', resolve: true, limit: 1 } })).body;
    a = s?.accounts?.[0];
    if (!a) throw new RefusalError(`${ctx.host} cannot find @${at}`, 404);
  }
  const [rel, pinned, recent] = await Promise.all([
    acctOf(a, ctx) === ctx.self ? Promise.resolve(null) : api.req('GET', '/api/v1/accounts/relationships', { query: { 'id[]': [String(a.id)] } }).then((r) => r.body?.[0] ?? null, () => null),
    api.req('GET', `/api/v1/accounts/${a.id}/statuses`, { query: { pinned: true, limit: 5 } }).then((r) => (Array.isArray(r.body) ? r.body : []), () => []),
    api.req('GET', `/api/v1/accounts/${a.id}/statuses`, { query: { limit: 20 } }).then((r) => (Array.isArray(r.body) ? r.body : []), () => []),
  ]);
  const people = new Map<string, P.IdentityFact>();
  const ident = identityOf(a, ctx);
  people.set(ident.nativeId, ident);
  const pins = pinned.map((s: any) => ({ ...postOf(s, ctx, people), pinned: true }));
  const pinnedIds = new Set(pins.map((p: P.PostFact) => p.id));
  const posts = [...pins, ...recent.map((s: any) => postOf(s, ctx, people)).filter((p: P.PostFact) => !pinnedIds.has(p.id))].slice(0, 20);
  emitPeople(people);
  return { ...personAbout(a, ctx, rel), posts };
}

process.on('unhandledRejection', (e) => link.log('error', `unhandled rejection: ${String((e as any)?.stack ?? e)}`));
begin();
