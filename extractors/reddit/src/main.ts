/**
 * The reddit extractor: one Reddit account's front page, inbox and comment threads, from old.reddit.com signed in in
 * a sandboxed browser (packages/browser: Xvfb, an ordinary Chromium with a persistent profile and our extension, x11vnc
 * for the live view), answering the `chat` interface as posts and a feed (docs/reddit.md). You sign in once in the live
 * view; the profile keeps the session.
 *
 * Reddit's API wants an approved app now, so nothing here uses it as an app: the page's hook (src/extension/hook.js)
 * makes old reddit's own requests from inside the signed-in page, with its cookies and its modhash. This side builds
 * them, paces them like a person (pace.ts), maps the answers (map.ts) and keeps what it told the hub (feed.ts):
 *   - the inbox (`/message/inbox.json?mark=false`, never marked read) as one read-only conversation, variant 'feed':
 *     the first look 30-60 s after it goes online, then every 4-8 minutes, only while nothing else runs;
 *   - `home` (front page New or Best), `post` (a post's or comment's thread, and more comments), `profile`, only when
 *     asked;
 *   - `postAct` (upvote, clear the vote), `publish` (a comment, or a text post with a title in a subreddit) and
 *     `unpublish` (delete your own), once each, when asked.
 *
 * Config: { testOrigin?, noSandbox?, feedFirstMs?, feedEveryMs?, paceMs? (tests: the gap between requests), subsChunk?
 * (tests: subscriptions in one `/r/a+b/new.json`) }. Keeps reddit-state.json (the inbox's newest time and recent ids)
 * in the account directory. Logs paths' shapes, counts and statuses: never post or message text,
 * people's names, cookies or the modhash.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import { composeState, POST_RULES } from '@dither-chat/protocol';
import { FeedTracker, type FeedKept, FIRST_READ_MS } from './feed.ts';
import {
  ctxOf,
  Drops,
  FULLNAME,
  fullname,
  HOME_COUNT,
  HOME_COUNT_MAX,
  infoThing,
  mergeNewest,
  ownPicture,
  type More,
  MORECHILDREN_MAX,
  moresOfChildren,
  parseCommented,
  parseHome,
  parseInbox,
  parseMoreChildren,
  parseMoreCursor,
  parseOverview,
  parsePost,
  parseSubmitted,
  parseSubscriptions,
  parseSubsCursor,
  parseThread,
  parseUser,
  personAbout,
  SUBS_CHUNK,
  SUBS_CURSOR,
  SUBS_MAX,
  subsChunks,
  subredditOf,
  USERNAME,
  writeErrors,
} from './map.ts';
import { Pace } from './pace.ts';
import { capabilitiesOf, compute, type Facts, type FeedFacts, PAGE_STATES, type PageState } from './status.ts';

const WIDTH = 1280;
/** Reddit's limits on what it takes: a comment, a text post's body. */
const COMMENT_MAX = 10_000;
const SELF_POST_MAX = 40_000;
const HEIGHT = 800;
const NETWORK: P.Network = 'reddit';

type Up =
  | { t: 'ready' }
  | { t: 'log'; level: string; msg: string }
  | { t: 'tabs'; tabs: { id: number; url: string; active: boolean; hook: boolean }[] }
  | { t: 'hook'; page: string }
  | { t: 'page'; state: string; path: string; user: string | null; modhash: boolean; old: boolean };
type Down = { kind: 'get'; path: string } | { kind: 'post'; path: string; form: Record<string, string> } | { kind: 'go' } | { kind: 'page.state' };

const hub = linkHub({ onCommand: onCommandCounted, onConnect, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

const cfg = hub.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const origin = testOrigin ?? 'https://old.reddit.com';
const STATE_FILE = join(hub.accountDir, 'reddit-state.json');

function readKept(): { feed?: FeedKept } {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

let display: number | null = null;
let vncSocket: string | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tab: string | null = null;
let hookTabs = 0;
let page: Facts['page'] = null;
let lastCommand: Facts['lastCommand'] = null;
let sentCaps = '';
const timers: Timer[] = [];
const drops = new Drops();

const bridgeToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
const bridge = new BridgeServer<Up, Down>({
  token: bridgeToken,
  onMessage: onBridge,
  onConnect: () => status(),
  onDisconnect: () => {
    hookTabs = 0;
    status();
  },
  log,
  silence: { name: 'reddit.com', tab: true, page: true },
  // Reads the page has not said it has after 3 s are sent again (the page takes an id once); never a write.
  resend: { kinds: ['get', 'page.state'] },
});

/** Writes at a person's pace; reads (a page of the front page, a thread, a profile, the inbox) slower. */
const fast = Number(cfg.paceMs) > 0 ? Number(cfg.paceMs) : 0;
const pace = fast ? new Pace(fast, 0) : new Pace(1200, 900);
const readPace = fast ? new Pace(fast, 0) : new Pace(2500, 3500);

// ------------------------------------------------------------------- status
function facts(): Facts {
  return {
    now: Date.now(),
    sandbox: { started: !!sandbox && !sandboxError && display !== null && startedAt > 0, error: sandboxError, browserAlive: !!sandbox?.browserAlive, display, startedAt },
    extensionAttached: bridge.connected,
    hookTabs,
    tab,
    page,
    lastCommand,
    feed: feedFacts(),
  };
}

let lastSent = '';
let onlineSince = 0;
function status(force = false) {
  const c = compute(facts());
  if (c.status === 'online' && !onlineSince) {
    onlineSince = Date.now();
    feedOnline();
  }
  const caps = JSON.stringify(c.capabilities);
  if (caps !== sentCaps) {
    sentCaps = caps;
    hub.emit({ t: 'hello', network: NETWORK, version: '1', capabilities: c.capabilities });
  }
  const self = page?.user ? feed.identities([page.user], page.user, selfAvatars())[0] : undefined;
  if (self) hub.emit(self);
  if (c.status === 'online') selfSoon();
  const ev: P.AdapterEvent = {
    t: 'status',
    status: c.status,
    attention: c.attention,
    liveView: vncSocket !== null ? { vncSocket, width: WIDTH, height: HEIGHT } : null,
    ...(page?.user ? { self: { nativeId: page.user, handle: page.user, displayName: `u/${page.user}`, ...(selfPic?.user === page.user && selfPic.url ? { avatarUrl: selfPic.url } : {}), isSelf: true } } : {}),
    details: c.details,
    layers: c.layers,
  };
  const s = JSON.stringify(ev);
  if (s === lastSent && !force) return;
  lastSent = s;
  hub.emit(ev);
}

// ------------------------------------------------------------------- bridge
let goneAt = 0;
let goTimer: Timer | undefined;
function onBridge(msg: Up) {
  switch (msg.t) {
    case 'ready':
      log('info', 'extension service worker ready');
      break;
    case 'log':
      log(['debug', 'info', 'warn', 'error'].includes(msg.level) ? (msg.level as 'debug') : 'debug', `[hook] ${String(msg.msg).slice(0, 200)}`);
      break;
    case 'tabs': {
      const active = msg.tabs.find((t) => t.active) ?? msg.tabs[0];
      const was = tab;
      tab = active?.url ?? null;
      hookTabs = msg.tabs.filter((t) => t.hook).length;
      if (tab !== was) log('info', `tab on ${tab ? (() => { try { return new URL(tab).hostname; } catch { return tab; } })() : 'nothing'}`);
      break;
    }
    case 'hook':
      log('info', 'hook up');
      break;
    case 'page':
      onPage(msg);
      break;
  }
  status();
}

function onPage(msg: Extract<Up, { t: 'page' }>) {
  const state: PageState = PAGE_STATES.includes(msg.state as PageState) ? (msg.state as PageState) : 'other';
  const user = typeof msg.user === 'string' && USERNAME.test(msg.user) ? msg.user : null;
  const path = typeof msg.path === 'string' ? msg.path.slice(0, 200) : '';
  if (page?.state !== state) log('info', `page: ${state}`);
  if (user && page?.user !== user) log('info', 'signed in');
  page = { state, path, user, modhash: msg.modhash === true, old: msg.old === true, since: page?.state === state ? page.since : Date.now() };
  // Signed in on Reddit's new site (where its sign-in leaves you): back to old.reddit.com, once in a while at most.
  clearTimeout(goTimer);
  if (state === 'other' && !page.old) {
    goTimer = setTimeout(() => {
      if (page?.state !== 'other' || page.old || Date.now() - goneAt < 120_000 || !bridge.connected) return;
      goneAt = Date.now();
      log('info', 'not on old.reddit.com: going there');
      bridge.request({ kind: 'go' }, 15_000).catch(() => {});
    }, 5000);
  }
}

// --------------------------------------------------------------- requests
function need(what: string, write = false) {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page?.state === 'login') throw new Error('Reddit is not signed in (live view)');
  if (page?.state === 'verify') throw new Error('Reddit wants a check in the live view');
  if (page?.state !== 'ready') throw new Error(`cannot ${what}: the browser is not on old.reddit.com signed in`);
  if (write && !page.modhash) throw new Error(`cannot ${what}: the page has no modhash (Reddit changed?)`);
}
const get = <T = unknown>(path: string) => readPace.run(() => bridge.request<T>({ kind: 'get', path }, 90_000));
const post = <T = unknown>(path: string, form: Record<string, string>, gap = pace) => gap.run(() => bridge.request<T>({ kind: 'post', path, form }, 90_000));

async function run<T>(kind: string, f: () => Promise<T>): Promise<T> {
  try {
    const r = await f();
    lastCommand = { kind, ok: true, at: Date.now() };
    return r;
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 200);
    lastCommand = { kind, ok: false, at: Date.now(), error };
    log('warn', `${kind} failed`, { error });
    throw e;
  } finally {
    status();
  }
}

/** Identity facts for everyone a read named, before its answer (your own with your picture). */
function announce(people: Iterable<string>, avatars?: Map<string, string>) {
  const all = selfAvatars(avatars);
  for (const ev of feed.identities(people, page?.user ?? null, all)) hub.emit(ev);
}

// ------------------------------------------------------------ your picture
// Your own picture, as your profile shows it (`/user/<you>/about.json`, the read a profile makes): once after the
// account is online, again when the signed-in user changes, and 10 minutes after a failed read. Reddit's default snoo
// is no picture of yours (map.ts ownPicture).
let selfPic: { user: string; url: string | null } | null = null;
let selfTimer: Timer | undefined;
let selfFailedAt = 0;
function selfAvatars(avatars?: Map<string, string>): Map<string, string> | undefined {
  if (!selfPic?.url || selfPic.user !== page?.user) return avatars;
  const all = new Map(avatars);
  all.set(selfPic.user, selfPic.url);
  return all;
}
function selfSoon() {
  const user = page?.user;
  if (!user || selfPic?.user === user || selfTimer || Date.now() - selfFailedAt < 10 * 60_000) return;
  selfTimer = setTimeout(() => void readSelf(user), fast ? 0 : 5000 + Math.floor(Math.random() * 10_000));
}
async function readSelf(user: string) {
  try {
    if (page?.user !== user || page.state !== 'ready') return;
    const u = parseUser(await get(`/user/${user}/about.json?raw_json=1`), ctxOf(drops, testOrigin));
    if (!u || u.name.toLowerCase() !== user.toLowerCase()) throw new Error('Reddit did not give your profile');
    selfPic = { user, url: ownPicture(u) };
    log('info', selfPic.url ? 'your picture read' : 'you have no picture of your own');
  } catch (e) {
    selfFailedAt = Date.now();
    log('info', 'your picture could not be read', { error: String((e as Error).message ?? e).slice(0, 120) });
  } finally {
    selfTimer = undefined;
    status();
  }
}

// --------------------------------------------------------------- commands
let busy = 0;
async function onCommandCounted(cmd: P.AdapterCommand): Promise<unknown> {
  busy++;
  try {
    return await onCommand(cmd);
  } finally {
    busy--;
  }
}

async function onCommand(cmd: P.AdapterCommand): Promise<unknown> {
  switch (cmd.t) {
    case 'home':
      return home(cmd.feed, cmd.cursor, cmd.count);
    case 'post':
      return thread(cmd.post, cmd.cursor);
    case 'postAct':
      return postAct(cmd.post, cmd.act);
    case 'publish':
      return publish(cmd);
    case 'unpublish':
      return unpublish(cmd.post);
    case 'profile':
      return profile(cmd.who);
    case 'action':
      if (cmd.action === 'resync') {
        feed.forgetAll();
        void feedTick(true);
        return { ok: true };
      }
      throw new Error(`no action ${cmd.action}`);
    default:
      throw new Error(`not supported by the reddit kind: ${cmd.t}`);
  }
}

/**
 * One page of the front page: Following is your subscriptions sorted New, For you is Reddit's Best. Following asks the
 * front page's New (`/new.json`) first; when Reddit refuses that (403), it is built from the subscriptions instead
 * (followingFromSubs), and `/new.json` is not asked again for six hours.
 */
async function home(which: P.HomeFeed, cursor?: string, count?: number): Promise<P.HomePage> {
  if (which !== 'following' && which !== 'foryou') throw new Error('not a home timeline: following or foryou');
  if (cursor !== undefined && (typeof cursor !== 'string' || !(FULLNAME.test(cursor) || (which === 'following' && SUBS_CURSOR.test(cursor))))) throw new Error('not a Reddit cursor');
  const asked = Number(count ?? HOME_COUNT);
  const n = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), HOME_COUNT_MAX) : HOME_COUNT;
  need('read the front page');
  const ctx = ctxOf(drops, testOrigin);
  let got: P.HomePage;
  if (which === 'following' && (cursor ? SUBS_CURSOR.test(cursor) : Date.now() - newRefusedAt < NEW_REFUSED_MS)) {
    got = await run('home', () => followingFromSubs(cursor, n, ctx));
  } else {
    const path = `/${which === 'following' ? 'new' : 'best'}.json?raw_json=1&limit=${n}${cursor ? `&after=${cursor}` : ''}`;
    got = await run('home', async () => {
      try {
        return parseHome(await get(path), ctx);
      } catch (e) {
        // Only the first page falls back: a `t3_` cursor came from /new.json, which answered then.
        if (which !== 'following' || cursor || !/^Reddit answered 403\b/.test(String((e as Error).message))) throw e;
        newRefusedAt = Date.now();
        log('info', 'home: Reddit refused the front page sorted New; reading it from the subscriptions');
        return followingFromSubs(undefined, n, ctx);
      }
    });
  }
  for (const it of got.items) if (it.post.root) linkOf.set(it.post.id, it.post.id.slice(3));
  announce(ctx.people);
  return got;
}

/** When /new.json was last refused, and for how long the subscriptions are read instead. */
let newRefusedAt = 0;
const NEW_REFUSED_MS = 6 * 3600_000;
/** Your subscriptions, read at most every 30 minutes. */
let subs: { user: string; at: number; names: string[] } | null = null;
const SUBS_TTL_MS = 30 * 60_000;
const subsChunk = Number(cfg.subsChunk) > 0 ? Math.floor(Number(cfg.subsChunk)) : SUBS_CHUNK;

async function subscriptions(): Promise<string[]> {
  const user = page?.user ?? '';
  if (subs && subs.user === user && Date.now() - subs.at < SUBS_TTL_MS) return subs.names;
  const names: string[] = [];
  let after: string | null = null;
  do {
    const r = parseSubscriptions(await get(`/subreddits/mine/subscriber.json?raw_json=1&limit=100${after ? `&after=${after}` : ''}`), ctxOf(drops, testOrigin));
    names.push(...r.names);
    after = r.after;
  } while (after && names.length < SUBS_MAX);
  subs = { user, at: Date.now(), names: names.slice(0, SUBS_MAX) };
  log('info', `home: ${subs.names.length} subscriptions`);
  return subs.names;
}

/**
 * Following from the subscriptions: each group's `/r/a+b+c/new.json` from where the cursor left it, merged newest first
 * (map.ts mergeNewest). A cursor from before the subscriptions changed in number of groups starts again from the top.
 */
async function followingFromSubs(cursor: string | undefined, n: number, ctx: ReturnType<typeof ctxOf>): Promise<P.HomePage> {
  const now = Date.now();
  const groups = subsChunks((await subscriptions()).filter((name) => !(now - (refusedSubs.get(name) ?? -Infinity) < NEW_REFUSED_MS)), subsChunk);
  if (!groups.length) return { items: [], more: null, top: null };
  const places = (cursor && parseSubsCursor(cursor, groups.length)) || groups.map(() => '0');
  const pages: ({ items: P.HomeItem[]; more: string | null } | null)[] = [];
  for (let i = 0; i < groups.length; i++) {
    const at = places[i]!;
    if (at === 'x') {
      pages.push(null);
      continue;
    }
    let listing: unknown;
    try {
      listing = await get(`/r/${groups[i]!.join('+')}/new.json?raw_json=1&limit=${n}${at !== '0' ? `&after=${at}` : ''}`);
    } catch (e) {
      // Reddit refuses a whole group when it refuses one subreddit in it: find those, leave them out, start again.
      if (!refused(e)) throw e;
      const bad = await findRefused(groups[i]!);
      if (bad === null) throw new Error(`Reddit answered 403 to New for every subscription tried (${groups[i]!.length} in the group)`);
      if (!bad.length) throw e;
      const at = Date.now();
      for (const name of bad) refusedSubs.set(name, at);
      log('info', `home: Reddit refuses New in ${bad.length} subscription(s), left out for six hours: ${bad.join(', ')}`);
      return followingFromSubs(undefined, n, ctx);
    }
    pages.push(parseHome(listing, ctx));
  }
  return mergeNewest(pages, places, n);
}

/** Subscriptions whose New Reddit refuses (private, quarantined, banned...), and when: left out for six hours. */
const refusedSubs = new Map<string, number>();
const refused = (e: unknown) => /^Reddit answered 403\b/.test(String((e as Error)?.message ?? e));
/** At most this many reads to find the refused ones in a group; more means Reddit refuses New itself. */
const PROBES_MAX = 32;

/**
 * The names in a refused group that Reddit refuses, found by asking for each half's newest post and halving the
 * refused ones; null when that takes more than PROBES_MAX reads. Empty when no part is refused on its own.
 */
async function findRefused(names: string[]): Promise<string[] | null> {
  const bad: string[] = [];
  let probes = 0;
  const visit = async (part: string[]): Promise<boolean> => {
    if (part.length === 1) {
      bad.push(part[0]!);
      return true;
    }
    for (const half of [part.slice(0, part.length >> 1), part.slice(part.length >> 1)]) {
      if (++probes > PROBES_MAX) return false;
      try {
        await get(`/r/${half.join('+')}/new.json?raw_json=1&limit=1`);
      } catch (e) {
        if (!refused(e)) throw e;
        if (!(await visit(half))) return false;
      }
    }
    return true;
  };
  return (await visit(names)) ? bad : null;
}

/** Which post each comment seen is under (so a comment's thread needs no lookup), and the `more`s seen, by link. */
const linkOf = new Map<string, string>();
const mores = new Map<string, More>();
const remember = <K, V>(m: Map<K, V>, k: K, v: V, max = 5000) => {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value!);
};

/**
 * A post's or a comment's thread, as their pages show them; `cursor` (a `more` from an earlier answer) for more
 * comments, as "load more comments" asks (/api/morechildren). Only when asked; nothing is voted or marked.
 */
async function thread(id: string, cursor?: string): Promise<P.PostThread> {
  const fn = fullname(id);
  if (!fn || !(fn.startsWith('t3_') || fn.startsWith('t1_'))) throw new Error('not a Reddit post or comment id');
  need('read a thread');
  const ctx = ctxOf(drops, testOrigin);
  if (cursor !== undefined) {
    const c = parseMoreCursor(cursor);
    if (!c) throw new Error('not a Reddit cursor');
    let m = mores.get(`${c.link}.${c.more}`);
    if (!m) {
      // Not seen since a restart: the post's page names it again (a `more` under a comment deeper down is read from
      // that comment's thread instead).
      const r = await run('post', () => get(`/comments/${c.link}.json?raw_json=1&sort=confidence`));
      const t = parseThread(r, `t3_${c.link}`, ctx);
      for (const [k, v] of t?.mores ?? []) remember(mores, `${c.link}.${k}`, v);
      m = mores.get(`${c.link}.${c.more}`);
      if (!m) throw new Error('Reddit no longer lists those comments: open the thread again');
    }
    const ids = m.children.slice(c.offset, c.offset + MORECHILDREN_MAX);
    if (!ids.length) return { ancestors: [], replies: [], more: null };
    const restAfter = c.offset + MORECHILDREN_MAX < m.children.length ? c.offset + MORECHILDREN_MAX : null;
    const r = await run('post', () => post('/api/morechildren', { api_type: 'json', link_id: `t3_${c.link}`, children: ids.join(','), sort: 'confidence', limit_children: 'false' }, readPace));
    for (const v of moresOfChildren(r, ctx)) remember(mores, `${c.link}.${v.id}`, v);
    const out = parseMoreChildren(r, c, restAfter, ctx);
    for (const chain of out.replies) for (const p of chain) remember(linkOf, p.id, c.link);
    announce(ctx.people);
    return out;
  }
  let link = fn.startsWith('t3_') ? fn.slice(3) : linkOf.get(fn);
  if (!link) {
    // A comment met only by id: which post it is under, as its permalink would say.
    const info = await run('post', () => get(`/api/info.json?id=${fn}&raw_json=1`));
    const t = infoThing(info, fn, ctx);
    const l = fullname(t?.data.link_id, 't3');
    if (!l) throw new Error('Reddit did not find that comment');
    link = l.slice(3);
  }
  const path = fn.startsWith('t3_') ? `/comments/${link}.json?raw_json=1&sort=confidence` : `/comments/${link}/_/${fn.slice(3)}.json?raw_json=1&sort=confidence&context=8`;
  const r = await run('post', () => get(path));
  const parsed = parseThread(r, fn, ctx);
  if (!parsed) throw new Error('Reddit did not give this thread');
  for (const [k, v] of parsed.mores) remember(mores, `${link}.${k}`, v);
  const th = parsed.thread;
  for (const p of [...(th.focal ? [th.focal] : []), ...th.ancestors, ...th.replies.flat()]) if (p.id.startsWith('t1_')) remember(linkOf, p.id, link);
  announce(ctx.people);
  return th;
}

/** Upvote (like) or clear your vote (unlike), as the arrows do: /api/vote with dir 1 or 0. */
async function postAct(id: string, act: P.PostAct): Promise<P.PostViewer> {
  const fn = fullname(id);
  if (!fn || !(fn.startsWith('t3_') || fn.startsWith('t1_'))) throw new Error('not a Reddit post or comment id');
  if (act !== 'like' && act !== 'unlike') throw new Error('Reddit has no reposts');
  need('vote', true);
  const r = await run(`postAct.${act}`, () => post('/api/vote', { id: fn, dir: act === 'like' ? '1' : '0' }));
  const errors = writeErrors(r);
  if (errors) throw new Error(`Reddit said: ${errors}`);
  return { liked: act === 'like' };
}

/**
 * A comment (`replyTo` a post or comment) or a new text post (`title` and `place`, the subreddit), as old reddit's
 * comment box and submit page send them, once. Checked against Reddit's rules (compose.ts POST_RULES) first.
 */
async function publish(cmd: Extract<P.AdapterCommand, { t: 'publish' }>): Promise<P.PostFact> {
  const { text, replyTo, quote, replies, media } = cmd;
  const body = typeof text === 'string' ? text : '';
  // A title-only post is fine; a comment needs words.
  if (!body.trim() && (replyTo !== undefined || !cmd.title)) throw new Error('nothing to post');
  if (quote !== undefined) throw new Error('Reddit has no quoting from here (crossposts are not made here)');
  if (replies !== undefined) throw new Error('Reddit has no choice of who can reply');
  if (cmd.warning !== undefined) throw new Error('Reddit has no content warning: mark a post NSFW or spoiler on Reddit');
  if (Array.isArray(media) && media.length) throw new Error('pictures and video are not posted to Reddit from here');
  if (replyTo !== undefined && (cmd.title !== undefined || cmd.place !== undefined)) throw new Error('a Reddit comment has no title or subreddit');
  // Reddit's own limits: 10,000 characters in a comment, 40,000 in a text post's body.
  const limit = replyTo !== undefined ? COMMENT_MAX : SELF_POST_MAX;
  const rules = POST_RULES.reddit;
  if (rules && body.trim()) {
    const c = composeState(body, { ...rules, maxLength: limit });
    if (!c.sendable) throw new Error(`too long for Reddit: ${c.length} of ${limit}`);
  }
  const ctx = ctxOf(drops, testOrigin);
  if (replyTo !== undefined) {
    const parent = fullname(replyTo);
    if (!parent || !(parent.startsWith('t3_') || parent.startsWith('t1_'))) throw new Error('not a Reddit post or comment id to reply to');
    need('comment', true);
    const r = await run('publish', () => post('/api/comment', { api_type: 'json', thing_id: parent, text: body }));
    const made = parseCommented(r, ctx);
    // Reddit answered without the comment: it may have been made. Never "failed": that would invite a second.
    if (!made) throw new Error('Reddit did not say which comment it made: look on Reddit before commenting again');
    if (made.root) remember(linkOf, made.id, made.root.slice(3));
    announce(ctx.people);
    return made;
  }
  const title = typeof cmd.title === 'string' ? cmd.title.trim() : '';
  if (!title) throw new Error('a new Reddit post needs a title');
  if ([...title].length > 300) throw new Error('a Reddit title is at most 300 characters');
  const sr = subredditOf(cmd.place);
  if (!sr) throw new Error('a new Reddit post needs a subreddit to go in');
  need('post', true);
  const r = await run('publish', () => post('/api/submit', { api_type: 'json', kind: 'self', sr, title, text: body, sendreplies: 'true' }));
  const made = parseSubmitted(r);
  if (!made) throw new Error('Reddit did not say which post it made: look on Reddit before posting again');
  // Read back as its page would show it; if that fails, what was sent stands for it.
  try {
    const info = await get(`/api/info.json?id=${made.id}&raw_json=1`);
    const t = infoThing(info, made.id, ctx);
    const p = t ? parsePost(t.data, ctx) : null;
    if (p) {
      announce(ctx.people);
      return p;
    }
  } catch {}
  const self = page?.user ?? undefined;
  return { id: made.id, url: made.url, ts: Date.now(), ...(self ? { author: self } : {}), text: body, title, place: { id: `r/${sr.toLowerCase()}`, name: `r/${sr}`, url: `https://www.reddit.com/r/${sr}/` }, root: made.id };
}

/** Delete a post or comment of yours, as its delete link does (/api/del). Reddit answers the same for one already gone. */
async function unpublish(id: string): Promise<{ deleted: true }> {
  const fn = fullname(id);
  if (!fn || !(fn.startsWith('t3_') || fn.startsWith('t1_'))) throw new Error('not a Reddit post or comment id');
  need('delete', true);
  const r = await run('unpublish', () => post('/api/del', { id: fn }));
  const errors = writeErrors(r);
  if (errors) throw new Error(`Reddit said: ${errors}`);
  return { deleted: true };
}

/** Someone's profile as their page shows it: karma, cake day, and their recent posts and comments. Only when asked. */
async function profile(who: string): Promise<P.PersonAbout> {
  if (typeof who !== 'string' || !USERNAME.test(who)) throw new Error('not a Reddit username');
  need('read a profile');
  const ctx = ctxOf(drops, testOrigin);
  const about = await run('profile', () => get(`/user/${who}/about.json?raw_json=1`));
  const u = parseUser(about, ctx);
  if (!u) throw new Error('Reddit did not give this profile');
  let posts: P.PostFact[] = [];
  try {
    posts = parseOverview(await get(`/user/${u.name}/overview.json?raw_json=1&limit=25`), ctx);
  } catch (e) {
    log('info', 'profile: the posts could not be read', { error: String((e as Error).message).slice(0, 120) });
  }
  ctx.people.add(u.name);
  announce(ctx.people, u.avatar ? new Map([[u.name, u.avatar]]) : undefined);
  return personAbout(u, posts);
}

// ---------------------------------------------------------------- the inbox
// The inbox as one read-only conversation, read like a person glancing at it: the first time 30-60 s after the account
// goes online, then every 4-8 minutes, only while it is online and nothing else runs. One page (25) each time; a fresh
// account takes what is under seven days old. `mark=false`: nothing is ever marked read on Reddit.
const span = (v: unknown, lo: number, hi: number): [number, number] => (Number(v) > 0 ? [Number(v), Number(v)] : [lo, hi]);
const FEED_FIRST = span(cfg.feedFirstMs, 30_000, 60_000);
const FEED_EVERY = span(cfg.feedEveryMs, 4 * 60_000, 8 * 60_000);
const FEED_BUSY = Number(cfg.feedEveryMs) > 0 ? FEED_EVERY : ([20_000, 40_000] as [number, number]);
const feed = new FeedTracker(readKept().feed);
let feedTimer: Timer | undefined;
let feedNextAt: number | null = null;
let feedStarted = false;
let feedLastFetch: number | null = null;
let feedLastError: string | null = null;

function feedFacts(): FeedFacts {
  return { items: feed.items, lastFetch: feedLastFetch, lastError: feedLastError, nextAt: feedNextAt, dropped: drops.summary(3) };
}
function scheduleFeed([lo, hi]: [number, number]) {
  clearTimeout(feedTimer);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  feedNextAt = Date.now() + ms;
  feedTimer = setTimeout(() => void feedTick(), ms);
}
function feedOnline() {
  if (feedStarted) return;
  feedStarted = true;
  scheduleFeed(FEED_FIRST);
}
let reading = false;
async function feedTick(now = false) {
  feedNextAt = null;
  if (reading) return;
  if (!bridge.connected || compute(facts()).status !== 'online') return scheduleFeed(FEED_EVERY);
  if (busy && !now) return scheduleFeed(FEED_BUSY);
  reading = true;
  try {
    const n = await readInbox();
    feedLastFetch = Date.now();
    feedLastError = null;
    log('info', `inbox read: ${n} new`);
  } catch (e) {
    feedLastError = String((e as Error).message ?? e).slice(0, 160);
    log('warn', 'inbox read failed', { error: feedLastError });
  } finally {
    reading = false;
  }
  scheduleFeed(FEED_EVERY);
  status();
}

async function readInbox(): Promise<number> {
  const now = Date.now();
  const fresh = feed.fresh;
  const r = await get('/message/inbox.json?mark=false&raw_json=1&limit=25');
  const ctx = ctxOf(drops, testOrigin);
  const got = parseInbox(r, ctx);
  const entries = fresh ? got.entries.filter((e) => e.ts > now - FIRST_READ_MS) : got.entries;
  const before = feed.items;
  for (const ev of feed.page(entries, { self: page?.user ?? null, now, backfill: fresh })) hub.emit(ev);
  keepSoon();
  return feed.items - before;
}

let keepTimer: Timer | undefined;
function keepSoon() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(keep, 3000);
}
function keep() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ feed: feed.kept() }), { mode: 0o600 });
  } catch {}
}

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake Reddit's origin too. */
function addTestOrigin(dir: string) {
  const path = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const pattern = `${testOrigin}/*`;
  m.host_permissions = [...(m.host_permissions ?? []), pattern];
  for (const cs of m.content_scripts ?? []) cs.matches = [...cs.matches, pattern];
  writeFileSync(path, JSON.stringify(m, null, 2));
}

async function boot() {
  bridge.start();
  status();
  const tried: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let free: { display: number };
    try {
      free = await pickFreeDisplay(undefined, tried);
    } catch (e) {
      sandboxError = String((e as Error).message ?? e);
      break;
    }
    tried.push(free.display);
    display = free.display;
    sandbox = new Sandbox({
      accountDir: hub.accountDir,
      display: free.display,
      width: WIDTH,
      height: HEIGHT,
      extensionSrc: join(import.meta.dir, 'extension'),
      config: { wsUrl: bridge.wsUrl, token: bridgeToken, testOrigin },
      prepareExtension: testOrigin ? addTestOrigin : undefined,
      startUrl: `${origin}/`,
      noSandbox: !!cfg.noSandbox || process.env.DITHER_CHROMIUM_NO_SANDBOX === '1',
      log,
    });
    try {
      await sandbox.start();
      startedAt = Date.now();
      vncSocket = sandbox.vncSocket;
      sandboxError = null;
      break;
    } catch (e) {
      sandboxError = String((e as Error).message ?? e).slice(0, 300);
      log('warn', `sandbox on :${free.display} failed`, sandboxError);
      await sandbox.stop();
      sandbox = null;
      display = null;
    }
  }
  status();
  if (!sandbox) return;
  timers.push(setInterval(() => bridge.ping(), 20_000));
  timers.push(setInterval(() => status(), 15_000));
  timers.push(
    setInterval(() => {
      if (sandbox && !sandbox.browserAlive) {
        log('warn', 'chromium exited; exiting for a supervised restart');
        void cleanup().then(() => process.exit(1));
      }
    }, 5000),
  );
}

// ---------------------------------------------------------------- lifecycle
function onConnect() {
  const caps = capabilitiesOf(page);
  sentCaps = JSON.stringify(caps);
  hub.emit({ t: 'hello', network: NETWORK, version: '1', capabilities: caps });
  // The hub (re)connected: the conversation and people are said again with the next events.
  feed.forget();
  for (const ev of feed.conversation()) hub.emit(ev);
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(keepTimer);
    clearTimeout(feedTimer);
    clearTimeout(goTimer);
    clearTimeout(selfTimer);
    keep();
    try {
      bridge.stop();
    } catch {}
    try {
      await sandbox?.stop();
    } catch {}
  })();
  return cleaning;
}

process.on('SIGTERM', () => void cleanup().then(() => process.exit(0)));
process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));

boot().catch((e) => {
  log('error', 'boot failed', String(e?.message ?? e));
  void cleanup().then(() => process.exit(1));
});
