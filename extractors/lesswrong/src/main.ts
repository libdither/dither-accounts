/**
 * The lesswrong extractor: one LessWrong account (or another ForumMagnum forum's: the EA Forum, the Alignment Forum)
 * through the site's own GraphQL API, answering `chat` with posts and comments only (docs/lesswrong.md).
 *
 *   config { site?, username? }, secret.json { password? (from the add form, until the site answers), token? } →
 *   the `login` mutation with the username or email and password → the login token kept in secret.json, the password
 *   removed → `currentUser` (who) → the notifications conversation (variant 'feed'), read every 4-8 minutes; home
 *   (posts by people you subscribe to; the frontpage's feed), threads, profiles and answering only when asked.
 *   An account that signs in with Google or GitHub pastes the site's `loginToken` cookie as the token instead.
 *
 * Nothing is marked read or viewed on the site (queries.ts lists what it never calls). It logs operation names, ids,
 * counts and statuses, never the password, the token or what a post says.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { linkHub, RefusalError } from '@dither-chat/protocol/client';
import { baseOf, Gql, GqlError } from './gql.ts';
import {
  ancestorsIn,
  chainsOf,
  commentOf,
  type Ctx,
  type Docs,
  docsToFetch,
  feedConversation,
  feedConvId,
  feedEntryOf,
  homeItemOf,
  identityOf,
  isLike,
  parseKey,
  personAbout,
  postOf,
  siteName,
} from './map.ts';
import * as Q from './queries.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** Notifications are read every 4-8 minutes; DITHER_LESSWRONG_POLL_MS makes it a fixed wait (tests). */
const POLL_FIXED = num('DITHER_LESSWRONG_POLL_MS', 0);
const pollWait = () => POLL_FIXED || 240_000 + Math.random() * 240_000;
/** Waits after failures (no answer, 5xx): this, doubling, up to ten minutes. */
const BACKOFF_MS = num('DITHER_LESSWRONG_BACKOFF_MS', 5_000);
/** A notification younger than this when it is first heard counts as live (it may alert). */
const LIVE_MS = 15 * 60_000;
const PAGE = 30;
/** At most this many pages of notifications in one read (a long time offline). */
const MAX_PAGES = 5;
/** A post's comments a page; a comment thread's at most. */
const COMMENTS_PAGE = 300;
/** PostsBySubscribedAuthors takes a limit only: pages are longer asks, up to this. */
const SUBSCRIBED_MAX = 300;
const CAPABILITIES: P.Capability[] = ['history', 'profile', 'posts', 'postActions', 'publish', 'home', 'unpublish'];

type Phase = 'starting' | 'signin' | 'unreachable' | 'online';
interface Secret {
  /** Only from the add form or a relogin, and only until the site has answered a sign-in with it. */
  password?: string;
  token?: string;
}

const config = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}') as { site?: unknown; username?: unknown };
const site = baseOf(config.site) ?? 'https://www.lesswrong.com';
const username = typeof config.username === 'string' ? config.username.trim() : '';
const name = siteName(site);
const SIGN_IN_AGAIN = username ? 'type your password' : `paste a new login token (the loginToken cookie of ${new URL(site).host})`;

let phase: Phase = 'starting';
let problem: string | null = null;
let token: string | null = null;
let me: any = null;
/** The frontpage feed's settings as you saved them on the site (its resolverSettings), sent with incognito mode on. */
let feedSettings: Record<string, unknown> = {};
const ctx: Ctx = { site, self: null };
let gen = 0;
let timer: Timer | undefined;
let failures = 0;
let polls = 0;
let lastPollAt: number | null = null;

const link = linkHub({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'lesswrong', version: '1', capabilities: CAPABILITIES });
    status();
    if (phase === 'online') link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
  },
  onCommand: (cmd) => command(cmd),
  onShutdown: () => save(),
});
const api = new Gql(site, () => token);

// ---------------------------------------------------------------- state

const statePath = join(link.accountDir, 'state.json');
interface State {
  /** The newest notification heard (its createdAt), and the ids heard at that moment; null before the first read. */
  newest: string | null;
  newestIds: string[];
  started: boolean;
}
const st: State = (() => {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return { newest: typeof s.newest === 'string' ? s.newest : null, newestIds: Array.isArray(s.newestIds) ? s.newestIds.map(String) : [], started: !!s.started };
  } catch {
    return { newest: null, newestIds: [], started: false };
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
  const host = api.host;
  const layers: P.StatusLayer[] = [
    { name: host, state: phase === 'unreachable' ? 'failed' : phase === 'starting' && !me ? 'waiting' : 'ok', ...(phase === 'unreachable' && problem ? { note: problem } : {}) },
    { name: 'signed in', state: phase === 'online' ? 'ok' : phase === 'signin' ? 'failed' : 'waiting', ...(phase === 'signin' && problem ? { note: problem } : me?.slug ? { note: `as ${me.slug}` } : {}) },
    { name: 'notifications', state: phase !== 'online' ? 'waiting' : failures ? 'failed' : polls ? 'ok' : 'waiting', ...(lastPollAt ? { note: `read ${new Date(lastPollAt).toISOString()}` } : {}) },
  ];
  const attention: Omit<P.Attention, 'since'> | null = phase === 'signin' ? { kind: 'login', message: problem ?? `Sign in to ${name} again: ${SIGN_IN_AGAIN}.` } : null;
  link.emit({
    t: 'status',
    status: phase === 'online' ? 'online' : phase === 'signin' ? 'attention' : phase === 'unreachable' ? 'error' : 'connecting',
    attention,
    ...(me ? { self: identityOf(me, ctx) } : {}),
    details: { site: host, polls, lastPollAt },
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
  const s = readSecret();
  token = typeof s.token === 'string' && s.token.trim() ? s.token.trim() : null;
  setPhase('starting');
  if (token) return void check(my);
  if (username && s.password) return void login(my, s.password);
  setPhase('signin', username ? `No password for ${username}: type it to sign in.` : `This account has neither a username and password nor a login token: ${SIGN_IN_AGAIN}.`);
}

/** Sign in with the password; the site's token is kept, the password dropped once the site has answered. */
async function login(my: number, password: string, asked = false) {
  try {
    const r = await api.request<{ login: { token: string | null } | null }>('Login', Q.LOGIN, { username, password }, { anonymous: true, write: true });
    if (my !== gen) return;
    const got = r?.login?.token;
    if (typeof got !== 'string' || !got) throw new GqlError(`${name} gave no session`, 502, 'http');
    token = got;
    saveSecret({ token, password: undefined });
    link.log('info', `signed in to ${api.host}`);
    await check(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as GqlError;
    if (err.failure === 'refused' || err.failure === 'auth') {
      // The site said no: the password is not kept, right or wrong.
      saveSecret({ password: undefined });
      link.log('warn', 'sign-in refused');
      const words = /invalid login|incorrect password/i.test(err.message) ? `${name} refused the username or password` : `${name} refused the sign-in: ${err.message}`;
      setPhase('signin', `${words}. Type it again.`);
      if (asked) throw new RefusalError(words, 400);
      return;
    }
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `sign-in failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    // Kept until the site answers, so it can try again by itself.
    saveSecret({ password });
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void login(my, password));
    if (asked) throw new RefusalError(err.message, err.status);
  }
}

/** The token is good when the site names who it is for. */
async function check(my: number) {
  try {
    const r = await api.request('Me', Q.ME);
    if (my !== gen) return;
    const u = r?.currentUser;
    if (!u?._id) return endSession(my);
    me = u;
    ctx.self = String(u._id);
    const saved = u.ultraFeedSettings?.resolverSettings;
    feedSettings = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    failures = 0;
    link.log('info', 'signed in');
    setPhase('online');
    link.emit({ t: 'identity', identity: identityOf(u, ctx) });
    link.emit({ t: 'conversation', conversation: feedConversation(ctx.self) });
    void tick(my);
  } catch (e) {
    if (my !== gen) return;
    const err = e as GqlError;
    failures++;
    setPhase('unreachable', err.message);
    link.log('warn', `session check failed (${err.status}); again in ${Math.round(backoff() / 1000)} s`);
    later(err.retryAt ? err.retryAt - Date.now() : backoff(), () => void check(my));
  }
}

/** The site stopped taking the token. The password is not kept, so it asks for it (or a new token). */
function endSession(my: number) {
  if (my !== gen) return;
  link.log('info', 'the site no longer takes the session');
  clearTimeout(timer);
  token = null;
  me = null;
  saveSecret({ token: undefined });
  setPhase('signin', `${name} no longer takes this account's sign-in: ${SIGN_IN_AGAIN}.`);
}

// ---------------------------------------------------------------- notifications

async function tick(my: number) {
  if (my !== gen || phase !== 'online') return;
  let wait = pollWait();
  try {
    await poll();
    failures = 0;
  } catch (e) {
    if (my !== gen) return;
    const err = e as GqlError;
    if (err.failure === 'auth') return endSession(my);
    failures++;
    wait = err.retryAt ? Math.max(err.retryAt - Date.now(), wait) : Math.max(backoff(), wait);
    link.log('warn', `notifications failed (${err.status}); again in ${Math.round(wait / 1000)} s`);
  }
  if (my !== gen) return;
  status();
  later(wait, () => void tick(my));
}

async function notifications(offset: number, limit = PAGE): Promise<any[]> {
  const r = await api.request('Notifications', Q.NOTIFICATIONS, { userId: ctx.self, limit, offset });
  // Signed out, the site answers with nobody's notifications rather than an error.
  if (!r?.currentUser?._id) throw new GqlError(`${name} no longer takes this account's sign-in`, 401, 'auth');
  return Array.isArray(r?.notifications?.results) ? r.notifications.results : [];
}

/** The posts and comments a list of notifications is about, in one request. */
async function docsFor(list: any[]): Promise<Docs> {
  const { postIds, commentIds } = docsToFetch(list);
  const docs: Docs = { posts: new Map(), comments: new Map() };
  if (!postIds.length && !commentIds.length) return docs;
  const r = await api.request('Docs', Q.DOCS, { postIds, commentIds, postLimit: Math.max(1, postIds.length), commentLimit: Math.max(1, commentIds.length) });
  for (const p of r?.posts?.results ?? []) if (p?._id) docs.posts.set(String(p._id), p);
  for (const c of r?.comments?.results ?? []) if (c?._id) docs.comments.set(String(c._id), c);
  return docs;
}

/** Announce these (oldest first): their posts and comments first asked for, one request. */
async function emitAll(list: any[], live: boolean): Promise<number[]> {
  const docs = await docsFor(list);
  const out: number[] = [];
  for (const n of list) {
    const e = feedEntryOf(n, docs, ctx);
    if (!e) continue;
    for (const p of e.people) link.emit({ t: 'identity', identity: p });
    link.emit({ t: 'message', message: e.message, live: live && Date.now() - e.message.ts < LIVE_MS });
    out.push(e.message.ts);
  }
  return out;
}

const at = (n: any) => String(n?.createdAt ?? '');
const isNew = (n: any) => !st.newest || at(n) > st.newest || (at(n) === st.newest && !st.newestIds.includes(String(n._id)));

/** Notifications since the newest heard, oldest first; a fresh account reads its last page quietly (live: false). */
async function poll() {
  if (!st.started) {
    const list = await notifications(0);
    await emitAll([...list].reverse(), false);
    remember(list);
    st.started = true;
  } else {
    const fresh: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = await notifications(page * PAGE);
      const newer = list.filter(isNew);
      fresh.push(...newer);
      if (newer.length < list.length || list.length < PAGE) break;
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
/** The newest of these as the mark the next read reads after. */
function remember(list: any[]) {
  const top = list.reduce<string | null>((m, n) => (at(n) > (m ?? '') ? at(n) : m), null);
  if (!top || (st.newest && top < st.newest)) return;
  const ids = list.filter((n) => at(n) === top).map((n) => String(n._id));
  st.newestIds = top === st.newest ? [...new Set([...st.newestIds, ...ids])] : ids;
  st.newest = top;
}

// ---------------------------------------------------------------- commands

const emitPeople = (people: Map<string, P.IdentityFact>) => {
  for (const p of people.values()) link.emit({ t: 'identity', identity: p });
};

function key(post: string) {
  const k = parseKey(post);
  if (!k) throw new RefusalError(`That is not a ${name} post or comment id (p-<id> or c-<id>)`, 404);
  return k;
}

/** A GqlError as the refusal an app reads: the site's status and words. */
async function ask<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof GqlError) {
      if (e.failure === 'auth') endSession(gen);
      throw new RefusalError(e.failure === 'missing' ? `${name} has no such post, comment or person` : e.message, e.status);
    }
    throw e;
  }
}

async function command(cmd: P.AdapterCommand): Promise<unknown> {
  if (cmd.t === 'action') return action(cmd.action, cmd.args);
  if (phase !== 'online') throw new RefusalError(phase === 'signin' ? `Not signed in to ${name} yet` : `${name} is not reachable just now`, 503);
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
      throw new RefusalError(`A ${name} account does not do ${cmd.t}`, 400);
  }
}

async function action(what: string, args: unknown) {
  const a = (args ?? {}) as { password?: unknown; token?: unknown };
  switch (what) {
    case 'relogin': {
      // The page's password box: a password when the account has a username, else a login token pasted into it.
      const typed = typeof a.password === 'string' ? a.password : '';
      const pasted = typeof a.token === 'string' ? a.token.trim() : !username ? typed.trim() : '';
      if (!pasted && !typed) throw new RefusalError(username ? 'Type the password' : 'Paste a login token', 400);
      if (pasted && !/^[A-Za-z0-9_-]{16,200}$/.test(pasted)) throw new RefusalError(`That is not a login token: paste the value of the loginToken cookie of ${new URL(site).host}`, 400);
      const my = ++gen;
      clearTimeout(timer);
      me = null;
      setPhase('starting');
      if (pasted) {
        token = pasted;
        saveSecret({ token, password: undefined });
        await check(my);
      } else {
        token = null;
        saveSecret({ token: undefined });
        await login(my, typed, true);
      }
      if (phase === 'signin') throw new RefusalError(problem ?? 'It did not sign in', 400);
      return { signedIn: phase === 'online' };
    }
    case 'poll':
      if (phase !== 'online') throw new RefusalError('Not signed in yet', 503);
      await ask(() => poll());
      status();
      return { newest: st.newest };
    default:
      throw new RefusalError(`No action ${what} here (relogin, poll)`, 400);
  }
}

/** Older notifications, a page at a time by offset (`next`). */
async function history(conversation: string, limit: number, cursor?: string): Promise<P.HistoryResult> {
  if (conversation !== feedConvId(ctx.self)) throw new RefusalError('Only the notifications have history here', 404);
  const offset = Math.max(0, Number(cursor) || 0);
  const want = Math.max(1, Math.min(50, limit || PAGE));
  const list = await notifications(offset, want);
  let count = 0;
  let oldest: number | undefined;
  for (const ts of await emitAll(list, false)) {
    count++;
    oldest = oldest === undefined ? ts : Math.min(oldest, ts);
  }
  const done = list.length < want;
  return { count, done, ...(oldest !== undefined ? { oldest } : {}), ...(done ? {} : { next: String(offset + list.length) }) };
}

async function home(feed: P.HomeFeed, cursor?: string, count?: number): Promise<P.HomePage> {
  const limit = Math.max(1, Math.min(40, count ?? 20));
  const people = new Map<string, P.IdentityFact>();
  if (feed === 'following') {
    // A limit and no offset: ask for what was shown and the next page, and keep the next page.
    const shown = cursor?.startsWith('n:') ? Math.max(0, Number(cursor.slice(2)) || 0) : 0;
    const want = Math.min(SUBSCRIBED_MAX, shown + limit);
    const r = await api.request('Subscribed', Q.SUBSCRIBED, { limit: want });
    const list: any[] = Array.isArray(r?.PostsBySubscribedAuthors?.results) ? r.PostsBySubscribedAuthors.results : [];
    const items = list.slice(shown).map((p) => ({ post: postOf(p, ctx, people) }));
    emitPeople(people);
    const more = list.length >= want && want < SUBSCRIBED_MAX ? `n:${want}` : null;
    return { items, more, top: null };
  }
  // The frontpage's feed. A session id of our own ties its pages together, as the site's does.
  const m = cursor?.match(/^u:([A-Za-z0-9-]{1,64}):(\d+)$/);
  const sessionId = m ? m[1]! : crypto.randomUUID();
  const offset = m ? Number(m[2]) : 0;
  const settings = JSON.stringify({ ...feedSettings, incognitoMode: true });
  const r = await api.request('UltraFeed', Q.ULTRAFEED, { limit, offset, sessionId, settings });
  const results: any[] = Array.isArray(r?.UltraFeed?.results) ? r.UltraFeed.results : [];
  const items = results.map((e) => homeItemOf(e, ctx, people)).filter((i): i is P.HomeItem => !!i);
  emitPeople(people);
  const end = Number(r?.UltraFeed?.endOffset);
  return { items, more: results.length && Number.isFinite(end) && end > offset ? `u:${sessionId}:${end}` : null, top: null };
}

async function getComment(id: string): Promise<any> {
  const r = await api.request('Comment', Q.COMMENT_ONE, { commentId: id });
  const c = r?.comment?.result;
  if (!c) throw new GqlError(`${name} has no such comment`, 404, 'missing');
  return c;
}

async function thread(post: string, cursor?: string): Promise<P.PostThread> {
  const k = key(post);
  const people = new Map<string, P.IdentityFact>();
  if (k.kind === 'post') {
    const offset = Math.max(0, Number(cursor) || 0);
    const r = await api.request('Post', Q.POST, { postId: k.id, withPost: !cursor, limit: COMMENTS_PAGE, offset });
    const p = r?.post?.result;
    if (!cursor && !p) throw new GqlError(`${name} has no such post`, 404, 'missing');
    const list: any[] = Array.isArray(r?.comments?.results) ? r.comments.results : [];
    const focal = p ? postOf(p, ctx, people, { article: true }) : undefined;
    const replies = chainsOf(list, { kind: 'post' }, (c) => commentOf(c, ctx, people));
    emitPeople(people);
    return { ...(focal ? { focal } : {}), ancestors: [], replies, more: list.length >= COMMENTS_PAGE ? String(offset + list.length) : null };
  }
  // A comment: the post and the comments above it, then everything under it. Its thread comes whole.
  if (cursor) return { ancestors: [], replies: [], more: null };
  const c = await getComment(k.id);
  const top = String(c.topLevelCommentId ?? c._id);
  const t = await api.request('CommentThread', Q.COMMENT_THREAD, { topLevelCommentId: top, limit: COMMENTS_PAGE });
  const list: any[] = Array.isArray(t?.comments?.results) ? t.comments.results : [];
  const focal = commentOf(c, ctx, people);
  const ancestors: P.PostFact[] = [];
  // A quick take's post is only its author's shortform page: it is not shown above.
  if (c.post?._id && !c.post.shortform) ancestors.push(postOf(c.post, ctx, people));
  for (const a of ancestorsIn(list, c)) ancestors.push(commentOf(a, ctx, people));
  const replies = chainsOf(list, { kind: 'comment', id: String(c._id) }, (x) => commentOf(x, ctx, people));
  emitPeople(people);
  return { focal, ancestors, replies, more: null };
}

async function postAct(post: string, act: P.PostAct): Promise<P.PostViewer> {
  if (act === 'repost' || act === 'unrepost') throw new RefusalError(`${name} has no reposts`, 400);
  if (act !== 'like' && act !== 'unlike') throw new RefusalError(`No such act: ${act}`, 400);
  const k = key(post);
  // Your vote as it is now: its agreement and reactions go back with the new karma vote, as the site's buttons send them.
  const r = k.kind === 'post' ? await api.request('PostVote', Q.POST_VOTE, { id: k.id }) : await api.request('CommentVote', Q.COMMENT_VOTE, { id: k.id });
  const doc = k.kind === 'post' ? r?.post?.result : r?.comment?.result;
  if (!doc) throw new GqlError(`${name} has no such ${k.kind}`, 404, 'missing');
  const liked = isLike(doc.currentUserVote);
  // Already so: nothing to send. Taking back a downvote is not an unlike: only an upvote is undone.
  if ((act === 'like') === liked) return { liked };
  const voteType = act === 'like' ? 'smallUpvote' : 'neutral';
  const variables = { documentId: k.id, voteType, extendedVote: doc.currentUserExtendedVote ?? null };
  const v = k.kind === 'post' ? await api.request('VotePost', Q.VOTE_POST, variables, { write: true }) : await api.request('VoteComment', Q.VOTE_COMMENT, variables, { write: true });
  const after = (k.kind === 'post' ? v?.performVotePost : v?.performVoteComment)?.document;
  link.log('info', `voted ${voteType} on ${post}`);
  return { liked: after && 'currentUserVote' in after ? isLike(after.currentUserVote) : act === 'like' };
}

/** Publishes already made, by the command's id: the same command twice makes one comment. */
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
  if (!cmd.replyTo || cmd.title || cmd.place) throw new RefusalError(`A new ${name} post is written on the site: from here, comment on a post or answer a comment`, 400);
  if (cmd.quote) throw new RefusalError(`${name} has no quote posts`, 400);
  if (cmd.media?.length) throw new RefusalError(`Pictures are not posted from here on ${name}`, 400);
  if (cmd.replies && cmd.replies !== 'everyone') throw new RefusalError(`${name} has no limit on who may reply`, 400);
  if (cmd.warning) throw new RefusalError(`${name} has no content warnings`, 400);
  if (!cmd.text.trim()) throw new RefusalError('There is nothing to post', 400);
  const k = key(cmd.replyTo);
  let postId = k.id;
  let parentCommentId: string | undefined;
  if (k.kind === 'comment') {
    const c = await getComment(k.id);
    postId = String(c.postId ?? c.post?._id ?? '');
    if (!postId) throw new RefusalError('That comment is on no post (a wiki page?): answer it on the site', 400);
    parentCommentId = k.id;
  }
  const data = { postId, ...(parentCommentId ? { parentCommentId } : {}), contents: { originalContents: { type: 'markdown', data: cmd.text } } };
  const r = await api.request('NewComment', Q.NEW_COMMENT, { data }, { write: true });
  const c = r?.createComment?.data;
  if (!c?._id) throw new RefusalError(`${name} did not say it made the comment`, 502);
  const people = new Map<string, P.IdentityFact>();
  const out = commentOf(c, ctx, people);
  emitPeople(people);
  link.log('info', `commented ${out.id}`);
  return out;
}

async function unpublish(post: string): Promise<{ deleted: true }> {
  const k = key(post);
  if (k.kind === 'post') throw new RefusalError(`A ${name} post is deleted on the site (move it back to drafts there)`, 400);
  let c: any;
  try {
    c = await getComment(k.id);
  } catch (e) {
    if (e instanceof GqlError && e.failure === 'missing') return { deleted: true };
    throw e;
  }
  if (c.deleted) return { deleted: true };
  if (String(c.userId ?? c.user?._id ?? '') !== ctx.self) throw new RefusalError('That comment is not yours', 403);
  if ((Number(c.directChildrenCount) || 0) > 0) throw new RefusalError(`That comment has replies: ${name} lets you retract it on the site instead`, 409);
  await api.request('DeleteComment', Q.DELETE_COMMENT, { commentId: k.id }, { write: true });
  link.log('info', `deleted ${post}`);
  return { deleted: true };
}

async function profile(who: string): Promise<P.PersonAbout> {
  let id = who.trim().replace(/^@/, '');
  // A user _id as the hub knows them; otherwise a slug, as a link or a handle names them.
  if (!/^[A-Za-z0-9]{17}$/.test(id)) {
    const r = await api.request('UserBySlug', Q.USER_BY_SLUG, { slug: id });
    if (!r?.GetUserBySlug?._id) throw new RefusalError(`${name} has nobody called ${id}`, 404);
    id = String(r.GetUserBySlug._id);
  }
  const r = await api.request('Profile', Q.PROFILE, { userId: id, limit: 10 });
  const u = r?.user?.result;
  if (!u) throw new RefusalError(`${name} has no such person`, 404);
  const people = new Map<string, P.IdentityFact>();
  const ident = identityOf(u, ctx);
  people.set(ident.nativeId, ident);
  const posts = [...(r.posts?.results ?? []).map((p: any) => postOf(p, ctx, people)), ...(r.comments?.results ?? []).map((c: any) => commentOf(c, ctx, people))]
    .sort((a: P.PostFact, b: P.PostFact) => b.ts - a.ts)
    .slice(0, 20);
  emitPeople(people);
  return { ...personAbout(u, ctx), posts };
}

process.on('unhandledRejection', (e) => link.log('error', `unhandled rejection: ${String((e as any)?.stack ?? e)}`));
begin();
