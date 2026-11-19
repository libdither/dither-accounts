/**
 * The lemmy extractor: one Lemmy account through its instance's HTTP API (v3, Lemmy 0.19), answering `chat` with
 * posts only (docs/lemmy.md).
 *
 *   config { instance, username }, secret.json { password, totp?, jwt? } → POST /api/v3/user/login (with a TOTP code
 *   when two-factor is on) → the session (`jwt`) kept in secret.json, signed in again with the password when the
 *   instance stops taking it → GET /api/v3/site (who) → the notifications conversation (variant 'feed'): comment
 *   replies and mentions, polled every minute; home (Subscribed by New, All by Hot), threads, profiles and answering
 *   only when asked.
 *
 * Votes are not named by Lemmy (only their counts), so the feed has no likes. Nothing is marked read on the instance.
 * It logs ids, counts and statuses, never the password, the session or what a comment says.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { linkHub, RefusalError } from '@dither-chat/protocol/client';
import { Api, ApiError, baseOf } from '@dither-accounts/extractor-mastodon/http';
import { chainsOf, commentOf, type Ctx, feedConversation, feedConvId, feedEntryOf, identityOf, parseKey, pathIds, personAbout, personId, postOf, totp, totpSecret } from './map.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const POLL_MS = num('DITHER_LEMMY_POLL_MS', 60_000);
const BACKOFF_MS = num('DITHER_LEMMY_BACKOFF_MS', 5_000);
const LIVE_MS = 15 * 60_000;
const PAGE = 50;
/** Comments this deep under what is asked for come in one read. */
const MAX_DEPTH = 8;
const CAPABILITIES: P.Capability[] = ['history', 'profile', 'posts', 'postActions', 'publish', 'home', 'unpublish'];

type Phase = 'starting' | 'signin' | 'code' | 'unreachable' | 'online';
interface Secret {
  password?: string;
  totp?: string;
  jwt?: string;
}

const config = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}') as { instance?: unknown; username?: unknown };
const base = baseOf(config.instance);
const username = typeof config.username === 'string' ? config.username.trim().replace(/^@/, '') : '';

let phase: Phase = 'starting';
let problem: string | null = null;
let jwt: string | null = null;
let me: any = null;
const ctx: Ctx = { host: base ? new URL(base).host : '', base: base ?? '', self: null };
let gen = 0;
let timer: Timer | undefined;
let failures = 0;
let polls = 0;
let lastPollAt: number | null = null;

const link = linkHub({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'lemmy', version: '1', capabilities: CAPABILITIES });
    status();
    if (phase === 'online') link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
  },
  onCommand: (cmd) => command(cmd),
  onShutdown: () => save(),
});
const api = new Api(base ?? 'https://invalid', () => jwt);

// ---------------------------------------------------------------- state

const statePath = join(link.accountDir, 'state.json');
interface State {
  /** The newest comment reply and person mention heard, by their own ids; null before the first read. */
  reply: number | null;
  mention: number | null;
  started: boolean;
}
const st: State = (() => {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return { reply: Number(s.reply) || null, mention: Number(s.mention) || null, started: !!s.started };
  } catch {
    return { reply: null, mention: null, started: false };
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
  const host = ctx.host || 'the instance';
  const layers: P.StatusLayer[] = [
    { name: host, state: phase === 'unreachable' ? 'failed' : phase === 'starting' && !me ? 'waiting' : 'ok', ...(phase === 'unreachable' && problem ? { note: problem } : {}) },
    { name: 'signed in', state: phase === 'online' ? 'ok' : phase === 'signin' || phase === 'code' ? 'failed' : 'waiting', ...((phase === 'signin' || phase === 'code') && problem ? { note: problem } : me ? { note: `@${ctx.self}` } : {}) },
    { name: 'notifications', state: phase !== 'online' ? 'waiting' : failures ? 'failed' : polls ? 'ok' : 'waiting', ...(lastPollAt ? { note: `read ${new Date(lastPollAt).toISOString()}` } : {}) },
  ];
  const attention: Omit<P.Attention, 'since'> | null =
    phase === 'signin'
      ? { kind: 'login', message: problem ?? `Sign in to ${host} again: type your password.` }
      : phase === 'code'
        ? { kind: 'verify', message: problem ?? `${host} wants your two-factor code.`, detail: { code: { length: 6 } } }
        : null;
  link.emit({
    t: 'status',
    status: phase === 'online' ? 'online' : phase === 'signin' || phase === 'code' ? 'attention' : phase === 'unreachable' ? 'error' : 'connecting',
    attention,
    ...(me ? { self: identityOf(me, ctx) } : {}),
    details: { instance: host, polls, lastPollAt },
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
  if (!base || !username) return setPhase('signin', 'This account has no instance or username. Add it again with both.');
  const s = readSecret();
  jwt = typeof s.jwt === 'string' && s.jwt ? s.jwt : null;
  setPhase('starting');
  void (jwt ? check(my) : login(my));
}

/** Errors Lemmy names for a sign-in, in words. */
const LOGIN_WORDS: Record<string, string> = {
  incorrect_login: 'refused the username or password',
  email_not_verified: 'wants your email address verified first (look for its email)',
  registration_application_is_pending: 'has not approved your registration yet',
  registration_denied: 'denied your registration',
  deleted: 'says this account was deleted',
  site_ban: 'has banned this account',
  incorrect_totp_token: 'did not take the two-factor code',
  missing_totp_token: 'wants a two-factor code',
};

/** Sign in with the password (and a TOTP code: given now, or made from the secret). */
async function login(my: number, code?: string) {
  const s = readSecret();
  if (!s.password) return setPhase('signin', `No password for ${username} on ${ctx.host}: type it to sign in.`);
  const secret = totpSecret(s.totp);
  const once = !secret && typeof s.totp === 'string' && /^\d{6}$/.test(s.totp.trim()) ? s.totp.trim() : undefined;
  const totp2fa = code ?? (secret ? totp(secret) : once);
  try {
    const r = await api.req('POST', '/api/v3/user/login', { json: { username_or_email: username, password: s.password, ...(totp2fa ? { totp_2fa_token: totp2fa } : {}) }, anonymous: true });
    if (my !== gen) return;
    // A code typed once is used once.
    if (once) saveSecret({ totp: undefined });
    if (typeof r.body?.jwt !== 'string' || !r.body.jwt) {
      const why = r.body?.verify_email_sent ? LOGIN_WORDS.email_not_verified : r.body?.registration_created ? LOGIN_WORDS.registration_application_is_pending : 'gave no session';
      return setPhase('signin', `${ctx.host} ${why}.`);
    }
    jwt = r.body.jwt;
    saveSecret({ jwt: jwt! });
    link.log('info', `signed in to ${ctx.host}`);
    await check(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as ApiError;
    const said = err.code ?? '';
    if (said === 'missing_totp_token' || (said === 'incorrect_totp_token' && !secret)) {
      if (once) saveSecret({ totp: undefined });
      if (code) throw new RefusalError(`${ctx.host} ${LOGIN_WORDS.incorrect_totp_token}`, 400);
      return setPhase('code', `${ctx.host} ${LOGIN_WORDS[said]}: type the code from your authenticator app.`);
    }
    if (LOGIN_WORDS[said]) {
      link.log('warn', `sign-in refused: ${said}`);
      if (code) throw new RefusalError(`${ctx.host} ${LOGIN_WORDS[said]}`, 400);
      return setPhase('signin', `${ctx.host} ${LOGIN_WORDS[said]}.`);
    }
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `sign-in failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    if (code) throw new RefusalError(err.message, err.status);
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void login(my));
  }
}

/** The session is good when the site names who it is for. */
async function check(my: number) {
  try {
    const r = await api.req('GET', '/api/v3/site');
    if (my !== gen) return;
    const person = r.body?.my_user?.local_user_view?.person;
    if (!person) throw new ApiError('the session is not taken', 401, 'auth');
    me = person;
    ctx.self = personId(person, ctx);
    failures = 0;
    link.log('info', `signed in as ${ctx.self}`);
    setPhase('online');
    link.emit({ t: 'identity', identity: identityOf(person, ctx) });
    link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
    void tick(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as ApiError;
    if (err.failure === 'auth' || err.code === 'not_logged_in' || err.code === 'incorrect_login') return relogin(my);
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `session check failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void check(my));
  }
}

/** The instance stopped taking the session: forget it and sign in again with the password. */
function relogin(my: number) {
  link.log('info', 'the session ended; signing in again');
  jwt = null;
  me = null;
  saveSecret({ jwt: undefined });
  setPhase('starting');
  void login(my);
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
    if (err.failure === 'auth' || err.code === 'not_logged_in') return relogin(my);
    failures++;
    wait = err.retryAt ? Math.max(err.retryAt - Date.now(), POLL_MS) : Math.max(backoff(), POLL_MS);
    link.log('warn', `notifications failed (${err.status}); again in ${Math.round(wait / 1000)} s`);
  }
  if (my !== gen) return;
  status();
  later(wait, () => void tick(my));
}

function emitEntry(v: any, type: 'reply' | 'mention', live: boolean): number | null {
  const e = feedEntryOf(v, type, ctx);
  if (!e) return null;
  for (const p of e.people) link.emit({ t: 'identity', identity: p });
  link.emit({ t: 'message', message: e.message, live: live && Date.now() - e.message.ts < LIVE_MS });
  return e.message.ts;
}

const replyId = (v: any) => Number(v?.comment_reply?.id) || 0;
const mentionId = (v: any) => Number(v?.person_mention?.id) || 0;

/** Replies and mentions newer than the newest heard (each by its own id), oldest first. */
async function poll() {
  const [r, m] = await Promise.all([
    api.req('GET', '/api/v3/user/replies', { query: { sort: 'New', page: 1, limit: PAGE, unread_only: false } }),
    api.req('GET', '/api/v3/user/mention', { query: { sort: 'New', page: 1, limit: PAGE, unread_only: false } }),
  ]);
  const replies: any[] = Array.isArray(r.body?.replies) ? r.body.replies : [];
  const mentions: any[] = Array.isArray(m.body?.mentions) ? m.body.mentions : [];
  const fresh = !st.started;
  const newR = replies.filter((v) => replyId(v) > (st.reply ?? 0));
  const newM = mentions.filter((v) => mentionId(v) > (st.mention ?? 0));
  const all = [...newR.map((v) => ({ v, type: 'reply' as const })), ...newM.map((v) => ({ v, type: 'mention' as const }))].sort((a, b) => postTs(a.v) - postTs(b.v));
  for (const { v, type } of all) emitEntry(v, type, !fresh);
  st.reply = Math.max(st.reply ?? 0, ...replies.map(replyId)) || st.reply;
  st.mention = Math.max(st.mention ?? 0, ...mentions.map(mentionId)) || st.mention;
  st.started = true;
  polls++;
  lastPollAt = Date.now();
  save();
}
const postTs = (v: any) => Date.parse(v?.comment?.published ?? '') || 0;

// ---------------------------------------------------------------- commands

const emitPeople = (people: Map<string, P.IdentityFact>) => {
  for (const p of people.values()) link.emit({ t: 'identity', identity: p });
};

function key(post: string) {
  const k = parseKey(post, ctx);
  if (!k) throw new RefusalError(`That is not a post or comment ${ctx.host} gave this account`, 404);
  return k;
}

async function ask<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.failure === 'auth' || e.code === 'not_logged_in') relogin(gen);
      const missing = e.failure === 'missing' || /couldnt_find|not_found/.test(e.code ?? '');
      throw new RefusalError(missing ? `${ctx.host} has no such post, comment or person` : e.message, missing ? 404 : e.status);
    }
    throw e;
  }
}

async function command(cmd: P.AdapterCommand): Promise<unknown> {
  if (cmd.t === 'action') return action(cmd.action, cmd.args);
  if (phase !== 'online') throw new RefusalError(phase === 'signin' || phase === 'code' ? `Not signed in to ${ctx.host || 'the instance'} yet` : `${ctx.host || 'The instance'} is not reachable just now`, 503);
  switch (cmd.t) {
    case 'history':
      return ask(() => history(cmd.conversation, cmd.limit, cmd.cursor));
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
    case 'profile':
      return ask(() => profile(cmd.who));
    default:
      throw new RefusalError(`A Lemmy account does not do ${cmd.t}`, 400);
  }
}

async function action(name: string, args: unknown) {
  const a = (args ?? {}) as { password?: unknown; code?: unknown };
  switch (name) {
    case 'relogin': {
      if (typeof a.password !== 'string' || !a.password) throw new RefusalError('Type the password', 400);
      saveSecret({ password: a.password, jwt: undefined });
      jwt = null;
      const my = ++gen;
      clearTimeout(timer);
      setPhase('starting');
      await login(my);
      if (phase === 'signin') throw new RefusalError(problem ?? 'It did not sign in', 400);
      return { signedIn: phase === 'online', needsCode: phase === 'code' };
    }
    case 'signIn': {
      const code = typeof a.code === 'string' ? a.code.replace(/\D/g, '') : '';
      if (code.length !== 6) throw new RefusalError('Type the 6-digit code from your authenticator app', 400);
      const my = ++gen;
      clearTimeout(timer);
      await login(my, code);
      return { signedIn: phase === 'online' };
    }
    case 'poll':
      if (phase !== 'online') throw new RefusalError('Not signed in yet', 503);
      await ask(() => poll());
      status();
      return { reply: st.reply, mention: st.mention };
    default:
      throw new RefusalError(`No action ${name} here (relogin, signIn, poll)`, 400);
  }
}

/** Older replies and mentions, a page of each (`next` the page number). */
async function history(conversation: string, limit: number, cursor?: string): Promise<P.HistoryResult> {
  if (conversation !== feedConvId(ctx.self)) throw new RefusalError('Only the notifications have history here', 404);
  const page = Math.max(1, Number(cursor) || 1);
  const want = Math.max(1, Math.min(PAGE, limit || PAGE));
  const [r, m] = await Promise.all([
    api.req('GET', '/api/v3/user/replies', { query: { sort: 'New', page, limit: want, unread_only: false } }),
    api.req('GET', '/api/v3/user/mention', { query: { sort: 'New', page, limit: want, unread_only: false } }),
  ]);
  const replies: any[] = Array.isArray(r.body?.replies) ? r.body.replies : [];
  const mentions: any[] = Array.isArray(m.body?.mentions) ? m.body.mentions : [];
  let count = 0;
  let oldest: number | undefined;
  for (const [list, type] of [
    [replies, 'reply'],
    [mentions, 'mention'],
  ] as const)
    for (const v of list) {
      const ts = emitEntry(v, type, false);
      if (ts !== null) {
        count++;
        oldest = oldest === undefined ? ts : Math.min(oldest, ts);
      }
    }
  const done = replies.length < want && mentions.length < want;
  return { count, done, ...(oldest !== undefined ? { oldest } : {}), ...(done ? {} : { next: String(page + 1) }) };
}

async function home(feed: P.HomeFeed, cursor?: string, count?: number): Promise<P.HomePage> {
  const limit = Math.max(1, Math.min(40, count ?? 20));
  const query: Record<string, string | number> = feed === 'foryou' ? { type_: 'All', sort: 'Hot', limit } : { type_: 'Subscribed', sort: 'New', limit };
  if (cursor?.startsWith('pc:')) query.page_cursor = cursor.slice(3);
  const page = cursor?.startsWith('page:') ? Number(cursor.slice(5)) || 1 : 1;
  if (!cursor?.startsWith('pc:')) query.page = page;
  const r = await api.req('GET', '/api/v3/post/list', { query });
  const list: any[] = Array.isArray(r.body?.posts) ? r.body.posts : [];
  const people = new Map<string, P.IdentityFact>();
  const items = list.map((v) => ({ post: postOf(v, ctx, people) }));
  emitPeople(people);
  // 0.19 pages by cursor; older instances by page number.
  const more = !list.length ? null : typeof r.body?.next_page === 'string' && r.body.next_page ? `pc:${r.body.next_page}` : `page:${page + 1}`;
  return { items, more, top: null };
}

async function getPost(id: number) {
  return (await api.req('GET', '/api/v3/post', { query: { id } })).body?.post_view;
}
async function getComment(id: number) {
  return (await api.req('GET', '/api/v3/comment', { query: { id } })).body?.comment_view;
}

async function thread(post: string, cursor?: string): Promise<P.PostThread> {
  const k = key(post);
  const people = new Map<string, P.IdentityFact>();
  const page = Math.max(1, Number(cursor) || 1);
  if (k.kind === 'post') {
    const [pv, comments] = await Promise.all([
      cursor ? Promise.resolve(null) : getPost(k.id),
      api.req('GET', '/api/v3/comment/list', { query: { post_id: k.id, max_depth: MAX_DEPTH, sort: 'Hot', type_: 'All', limit: PAGE, page } }),
    ]);
    const list: any[] = Array.isArray(comments.body?.comments) ? comments.body.comments : [];
    const focal = pv ? postOf(pv, ctx, people) : undefined;
    const replies = chainsOf(list, { kind: 'post' }, (v) => commentOf(v, ctx, people));
    // With max_depth, the limit counts top-level comments.
    const tops = list.filter((v) => pathIds(v?.comment?.path).length === 1).length;
    emitPeople(people);
    return { ...(focal ? { focal } : {}), ancestors: [], replies, more: tops >= PAGE ? String(page + 1) : null };
  }
  const cv = cursor ? null : await getComment(k.id);
  const ancestors: P.PostFact[] = [];
  let focal: P.PostFact | undefined;
  if (cv) {
    focal = commentOf(cv, ctx, people);
    const pv = await getPost(cv.comment.post_id);
    if (pv) ancestors.push(postOf(pv, ctx, people));
    // The comments above it, the top first; at most ten.
    const above = pathIds(cv.comment.path).slice(0, -1).slice(-10);
    const views = await Promise.all(above.map((id) => getComment(id).catch(() => null)));
    for (const v of views) if (v) ancestors.push(commentOf(v, ctx, people));
  }
  const r = await api.req('GET', '/api/v3/comment/list', { query: { parent_id: k.id, max_depth: MAX_DEPTH, sort: 'Hot', type_: 'All', limit: PAGE, page } });
  const list: any[] = Array.isArray(r.body?.comments) ? r.body.comments : [];
  const replies = chainsOf(list, { kind: 'comment', id: k.id }, (v) => commentOf(v, ctx, people));
  emitPeople(people);
  return { ...(focal ? { focal } : {}), ancestors, replies, more: list.length >= PAGE ? String(page + 1) : null };
}

async function postAct(post: string, act: P.PostAct): Promise<P.PostViewer> {
  if (act === 'repost' || act === 'unrepost') throw new RefusalError('Lemmy has no reposts', 400);
  const k = key(post);
  const score = act === 'like' ? 1 : 0;
  const r = k.kind === 'post' ? await api.req('POST', '/api/v3/post/like', { json: { post_id: k.id, score } }) : await api.req('POST', '/api/v3/comment/like', { json: { comment_id: k.id, score } });
  const view = r.body?.post_view ?? r.body?.comment_view;
  return { liked: view ? view.my_vote === 1 : score === 1 };
}

/** `!name@host` (or `name@host`, `name`) as the community's id on this instance. */
async function communityOf(place: string): Promise<number> {
  const m = place.trim().match(/^!?([^@\s]+)(?:@([^\s]+))?$/);
  if (!m) throw new RefusalError(`${place} is not a community's address (!name@instance)`, 400);
  const name = !m[2] || m[2] === ctx.host ? m[1] : `${m[1]}@${m[2]}`;
  const r = await api.req('GET', '/api/v3/community', { query: { name } });
  const id = r.body?.community_view?.community?.id;
  if (typeof id !== 'number') throw new RefusalError(`${ctx.host} does not know ${place}`, 404);
  return id;
}

async function publish(cmd: Extract<P.AdapterCommand, { t: 'publish' }>): Promise<P.PostFact> {
  if (cmd.quote) throw new RefusalError('Lemmy has no quote posts', 400);
  if (cmd.media?.length) throw new RefusalError('Pictures are not posted from here on Lemmy', 400);
  if (cmd.replies && cmd.replies !== 'everyone') throw new RefusalError('Lemmy has no limit on who may reply', 400);
  if (cmd.warning) throw new RefusalError('Lemmy has no content warnings', 400);
  const people = new Map<string, P.IdentityFact>();
  if (cmd.replyTo) {
    if (!cmd.text.trim()) throw new RefusalError('There is nothing to post', 400);
    const k = key(cmd.replyTo);
    let postId = k.id;
    let parent: number | undefined;
    if (k.kind === 'comment') {
      const cv = await getComment(k.id);
      if (!cv) throw new RefusalError(`${ctx.host} has no such comment`, 404);
      postId = cv.comment.post_id;
      parent = k.id;
    }
    const r = await api.req('POST', '/api/v3/comment', { json: { content: cmd.text, post_id: postId, ...(parent ? { parent_id: parent } : {}) } });
    const made = commentOf(r.body?.comment_view, ctx, people);
    emitPeople(people);
    link.log('info', `commented ${made.id}`);
    return made;
  }
  const title = cmd.title?.trim();
  if (!title) throw new RefusalError('A Lemmy post needs a title', 400);
  if (!cmd.place) throw new RefusalError('A Lemmy post needs a community to go to (!name@instance)', 400);
  if ([...title].length > 200) throw new RefusalError('A Lemmy title is at most 200 characters', 400);
  const community = await communityOf(cmd.place);
  const r = await api.req('POST', '/api/v3/post', { json: { name: title, community_id: community, ...(cmd.text.trim() ? { body: cmd.text } : {}) } });
  const made = postOf(r.body?.post_view, ctx, people);
  emitPeople(people);
  link.log('info', `posted ${made.id}`);
  return made;
}

async function unpublish(post: string): Promise<{ deleted: true }> {
  const k = key(post);
  try {
    if (k.kind === 'post') await api.req('POST', '/api/v3/post/delete', { json: { post_id: k.id, deleted: true } });
    else await api.req('POST', '/api/v3/comment/delete', { json: { comment_id: k.id, deleted: true } });
  } catch (e) {
    if (!(e instanceof ApiError && (e.failure === 'missing' || /couldnt_find|not_found/.test(e.code ?? '')))) throw e;
  }
  return { deleted: true };
}

async function profile(who: string): Promise<P.PersonAbout> {
  const at = who.replace(/^@/, '');
  const i = at.lastIndexOf('@');
  const name = i > 0 && at.slice(i + 1) === ctx.host ? at.slice(0, i) : at;
  const r = await api.req('GET', '/api/v3/user', { query: { username: name, sort: 'New', limit: 20, page: 1 } });
  const view = r.body?.person_view;
  if (!view?.person) throw new RefusalError(`${ctx.host} cannot find @${at}`, 404);
  const people = new Map<string, P.IdentityFact>();
  const ident = identityOf(view.person, ctx);
  people.set(ident.nativeId, ident);
  const posts = [...(r.body.posts ?? []).map((v: any) => postOf(v, ctx, people)), ...(r.body.comments ?? []).map((v: any) => commentOf(v, ctx, people))]
    .sort((a: P.PostFact, b: P.PostFact) => b.ts - a.ts)
    .slice(0, 20);
  emitPeople(people);
  const about = personAbout(view, ctx);
  const mods = Array.isArray(r.body.moderates) ? r.body.moderates.map((m: any) => m?.community?.name).filter(Boolean) : [];
  if (mods.length) about.facts = [...(about.facts ?? []), { label: 'Moderates', value: mods.slice(0, 10).join(', ') }];
  return { ...about, posts };
}

process.on('unhandledRejection', (e) => link.log('error', `unhandled rejection: ${String((e as any)?.stack ?? e)}`));
begin();
