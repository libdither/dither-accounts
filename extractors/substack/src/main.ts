/**
 * The substack extractor: one Substack account's reading, from substack.com signed in in a sandboxed browser
 * (packages/browser: Xvfb, an ordinary Chromium with a persistent profile and our extension, x11vnc for the live view),
 * answering the `chat` interface for dither-chat's Feed page (docs/substack.md). You sign in once in the live view; the
 * profile keeps the session.
 *
 * The page's hook (src/extension/hook.js) makes the reader's own /api/v1 calls with its session, each as the reader
 * makes it for the same click. This side paces them like a person, checks and maps what comes back (map.ts), and:
 *   - reads the Activity list every few minutes into one read-only conversation (nativeId 'feed', variant 'feed'):
 *     likes, restacks, replies, comments, mentions and new subscribers as FeedItem messages (tracker.ts);
 *   - answers `home` (following: the Inbox; foryou: Notes' For you tab), `post` (a post's or a note's thread),
 *     `profile` (a person's profile with their notes and posts), `postAct` (the heart; Restack), `publish` (a note, a
 *     reply to one, a comment on a post) and `unpublish` (a note or comment of yours), each only when asked.
 * Nothing it does marks anything seen on Substack.
 *
 * Config: { testOrigin?, noSandbox?, feedFirstMs?, feedEveryMs? (tests) }. Keeps substack-state.json (the feed's
 * newest time and recent message ids) in the account directory. Logs ids, counts and statuses: never a post's words,
 * people's names or handles, or cookies.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';
import { POST_ACTS } from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import * as M from './map.ts';
import { CAPABILITIES, compute, type Facts, type PageState } from './status.ts';
import { CATCH_UP_PAGES, FIRST_READ_MS, FIRST_READ_PAGES, FeedTracker, type FeedKept } from './tracker.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** Longest note or comment sent from here; Substack's own limit is not documented. */
export const MAX_TEXT = 10_000;

const hub = linkHub({ onCommand: onCommandCounted, onConnect, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

const cfg = hub.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const origin = testOrigin ?? M.SITE;
const STATE_FILE = join(hub.accountDir, 'substack-state.json');

function readKept(): { feed?: FeedKept } {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

const drops = new M.Drops();
/** What every answer taught: people, publications, posts, where comments sit. */
const ctx = M.newCtx(drops, testOrigin);
const feed = new FeedTracker(readKept().feed);
let display: number | null = null;
let vncSocket: string | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tab: string | null = null;
let page: Facts['page'] = null;
let self: Facts['self'] = null;
let hookVersion: number | null = null;
let lastCommand: Facts['lastCommand'] = null;
let onlineSince = 0;
const timers: Timer[] = [];

const bridgeToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
type Up = { t: string; [k: string]: any };
type Down = { kind: string; [k: string]: unknown };
const bridge = new BridgeServer<Up, Down>({
  token: bridgeToken,
  onMessage: onBridge,
  onConnect: () => status(),
  onDisconnect: () => status(),
  log,
  silence: { name: 'substack.com', tab: true, page: true },
  // Reads the page has not said it has after 3 s are sent again; never a like, a restack, a note or a delete.
  resend: { kinds: ['activity', 'inbox', 'notes', 'note', 'noteReplies', 'post', 'postReplies', 'profile', 'profileFeed', 'media', 'self'] },
});

/** A person's pace: writes a little apart, reads (paging, opening threads) a little slower. */
class Pace {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly min: number,
    private readonly jitter: number,
  ) {}
  run<T>(f: () => Promise<T>): Promise<T> {
    const r = this.chain.then(async () => {
      const wait = this.last + this.min + Math.floor(Math.random() * this.jitter) - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      try {
        return await f();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = r.catch(() => {});
    return r;
  }
}
const fast = Number(cfg.feedEveryMs) > 0;
const pace = fast ? new Pace(50, 50) : new Pace(1200, 900);
const readPace = fast ? new Pace(50, 50) : new Pace(1500, 2500);

// ------------------------------------------------------------------- status
function facts(): Facts {
  return {
    now: Date.now(),
    sandbox: { started: !!sandbox && !sandboxError && display !== null && startedAt > 0, error: sandboxError, browserAlive: !!sandbox?.browserAlive, display, liveView: vncSocket !== null, startedAt },
    extensionAttached: bridge.connected,
    tab,
    page,
    self,
    hookVersion,
    feed: { items: feed.items, lastFetch: feedLastFetch, lastError: feedLastError, nextAt: feedNextAt, dropped: drops.summary(3) },
    lastCommand,
  };
}

let lastSent = '';
function status(force = false) {
  const c = compute(facts());
  if (c.status === 'online' && !onlineSince) {
    onlineSince = Date.now();
    feedOnline();
  }
  if (c.status !== 'online') onlineSince = 0;
  const me = self ? ctx.users.get(self.id) : undefined;
  const selfFact = self ? M.identityFact(me ?? { id: self.id, name: null, handle: self.handle, photo: null, bio: null }, self.id) : undefined;
  const ev: P.AdapterEvent = {
    t: 'status',
    status: c.status,
    attention: c.attention,
    liveView: vncSocket !== null ? { vncSocket, width: WIDTH, height: HEIGHT } : null,
    ...(selfFact ? { self: selfFact } : {}),
    details: c.details,
    layers: c.layers,
  };
  const s = JSON.stringify(ev);
  if (s === lastSent && !force) return;
  lastSent = s;
  hub.emit(ev);
}

// ------------------------------------------------------------------- bridge
function onBridge(msg: Up) {
  switch (msg.t) {
    case 'ready':
      log('info', 'extension service worker ready');
      break;
    case 'log':
      log(['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'debug', `[hook] ${String(msg.msg).slice(0, 200)}`);
      break;
    case 'tabs': {
      const list = Array.isArray(msg.tabs) ? msg.tabs : [];
      const active = list.find((t: any) => t.active) ?? list[0];
      const was = tab;
      tab = typeof active?.url === 'string' ? active.url.slice(0, 200) : null;
      if (tab !== was) log('info', `tab on ${tab ?? 'nothing'}`);
      break;
    }
    case 'hook':
      hookVersion = typeof msg.version === 'number' ? msg.version : null;
      log('info', `hook ${hookVersion} up`);
      break;
    case 'page':
      onPage(msg);
      break;
  }
  status();
}

function onPage(msg: Up) {
  const state: PageState = (['loading', 'login', 'ready'] as const).includes(msg.state) ? msg.state : 'loading';
  const path = typeof msg.path === 'string' ? msg.path.slice(0, 200) : '';
  if (page?.state !== state) log('info', `page: ${state}`);
  page = { state, path, since: page?.state === state ? page.since : Date.now() };
  if (state === 'ready' && msg.self) {
    const u = M.userOf(msg.self, ctx);
    if (u && u.id !== self?.id) log('info', `signed in as user ${u.id}`);
    if (u) self = { id: u.id, handle: u.handle };
  } else if (state === 'login') {
    self = null;
  }
}

function keepSoon() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    try {
      writeFileSync(STATE_FILE, JSON.stringify({ feed: feed.kept() }), { mode: 0o600 });
    } catch {}
  }, 3000);
}
let keepTimer: Timer | undefined;

// ------------------------------------------------------------------ the feed
const span = (v: unknown, lo: number, hi: number): [number, number] => (Number(v) > 0 ? [Number(v), Number(v)] : [lo, hi]);
const FEED_FIRST = span(cfg.feedFirstMs, 30_000, 60_000);
const FEED_EVERY = span(cfg.feedEveryMs, 4 * 60_000, 8 * 60_000);
const FEED_BUSY: [number, number] = fast ? FEED_EVERY : [20_000, 40_000];
let feedTimer: Timer | undefined;
let feedNextAt: number | null = null;
let feedStarted = false;
let feedLastFetch: number | null = null;
let feedLastError: string | null = null;
let busy = 0;

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
async function feedTick() {
  feedNextAt = null;
  if (!bridge.connected || compute(facts()).status !== 'online') return scheduleFeed(FEED_EVERY);
  if (busy) return scheduleFeed(FEED_BUSY);
  try {
    const n = await readActivity();
    feedLastFetch = Date.now();
    feedLastError = null;
    log('info', `activity read: ${n.items} items, ${n.pages} page(s)`);
  } catch (e) {
    feedLastError = String((e as Error).message ?? e).slice(0, 160);
    log('warn', 'activity read failed', { error: feedLastError });
  }
  scheduleFeed(FEED_EVERY);
  status();
}

/** Identity facts for everyone a set of facts names, before them. */
function people(): P.AdapterEvent[] {
  return feed.identities(ctx.users.values(), self?.id ?? null);
}

/**
 * One look at the Activity list: its first page, and further back while every item on a page is new (to meet what
 * was announced), or on a fresh account up to a week and two pages back.
 */
async function readActivity(): Promise<{ items: number; pages: number }> {
  const now = Date.now();
  const fresh = feed.fresh;
  let after: string | undefined;
  let pages = 0;
  let items = 0;
  for (;;) {
    const r = await readPace.run(() => bridge.request<unknown>({ kind: 'activity', ...(after ? { after } : {}) }, 90_000));
    pages++;
    const pg = M.parseActivity(r, self?.id ?? null, ctx);
    const entries = fresh ? pg.entries.filter((e) => e.ts > now - FIRST_READ_MS) : pg.entries;
    const allNew = entries.length > 0 && entries.every((e) => !feed.has(e.nativeId));
    for (const ev of people()) hub.emit(ev);
    for (const ev of feed.stubs(entries.map((e) => e.actor))) hub.emit(ev);
    for (const ev of feed.messages(entries, { now, backfill: fresh || pages > 1 })) hub.emit(ev);
    items += entries.length;
    const back = pg.more && pg.oldest;
    const goOn = fresh ? pages < FIRST_READ_PAGES && back && Date.parse(pg.oldest!) > now - FIRST_READ_MS : pages < CATCH_UP_PAGES && back && allNew;
    if (!goOn) break;
    after = new Date(Date.parse(pg.oldest!) - 1).toISOString();
  }
  keepSoon();
  return { items, pages };
}

// --------------------------------------------------------------- commands
function need() {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page?.state === 'login') throw new Error('Substack is not signed in (live view)');
  if (page?.state !== 'ready') throw new Error('substack.com has not loaded yet');
}

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
const read = <T>(cmd: Down, ms = 90_000) => readPace.run(() => bridge.request<T>(cmd, ms));
const write = <T>(cmd: Down, ms = 60_000) => pace.run(() => bridge.request<T>(cmd, ms));

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
    case 'history':
      // The feed and the posts the hub logs are no chat on Substack.
      return { count: 0, done: true };
    case 'markRead':
      // Never marked on Substack: the Activity bell stays as it was.
      return {};
    case 'fetchMedia': {
      if (!M.mediaUrl(cmd.url, testOrigin)) throw new Error('not a Substack picture');
      if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
      return run('media', () => read<{ mime: string; base64: string }>({ kind: 'media', url: cmd.url }, 120_000));
    }
    case 'home':
      return home(cmd.feed, cmd.cursor);
    case 'post':
      return thread(cmd.post, cmd.cursor);
    case 'profile':
      return profile(cmd.who);
    case 'postAct':
      return postAct(cmd.post, cmd.act);
    case 'publish':
      return publish(cmd.text, cmd.replyTo, cmd.quote, cmd.media);
    case 'unpublish':
      return unpublish(cmd.post);
    case 'action':
      if (cmd.action === 'resync') {
        feed.forget();
        return { note: 'the feed and its people are announced again at the next read' };
      }
      return { note: `no such action: ${cmd.action} (resync)` };
    default:
      throw new Error(`substack does not support ${cmd.t}`);
  }
}

const CURSOR = /^[\w\-.:=+/%]{1,2000}$/;
function checkCursor(c: unknown): string | undefined {
  if (c === undefined) return undefined;
  if (typeof c !== 'string' || !CURSOR.test(c)) throw new Error('not a Substack cursor');
  return c;
}

/** Inbox (following) or Notes (foryou), a page; only when asked, nothing marked seen. */
async function home(which: P.HomeFeed, cursor?: string): Promise<P.HomePage> {
  if (which !== 'following' && which !== 'foryou') throw new Error('not a home timeline: following or foryou');
  const c = checkCursor(cursor);
  need();
  const r = await run('home', () => read<unknown>({ kind: which === 'following' ? 'inbox' : 'notes', ...(c ? { cursor: c } : {}) }));
  const got = which === 'following' ? M.parseInbox(r, ctx) : M.parseNotes(r, ctx);
  for (const ev of people()) hub.emit(ev);
  const named = got.items.flatMap((i) => [i.post.author, i.reason?.who].filter((x): x is string => !!x));
  for (const ev of feed.stubs(named)) hub.emit(ev);
  return got;
}

/** The publication of a post, from what was read, else from its page. */
async function pubOfPost(postId: string): Promise<string> {
  const known = M.sid(ctx.posts.get(postId)?.publication_id);
  if (known) return known;
  const r = await read<unknown>({ kind: 'post', id: postId });
  M.parsePostPage(r, ctx);
  const pub = M.sid(ctx.posts.get(postId)?.publication_id);
  if (!pub) throw new Error('Substack did not say whose post it is');
  return pub;
}
/** Where a note or comment sits (its post and publication), from what was read, else from its page. */
async function placeOf(commentId: string): Promise<M.CommentPlace> {
  const known = ctx.places.get(commentId);
  if (known) return known;
  M.parseNotePage(await read<unknown>({ kind: 'note', id: commentId }), ctx);
  const got = ctx.places.get(commentId);
  if (!got) throw new Error('Substack did not give this note');
  return got;
}

/**
 * A post's or note's thread as its page shows it: what it answers, the post, and its comments as reply chains;
 * `cursor` for more comments. Only when asked; nothing liked, viewed or marked.
 */
async function thread(key: string, cursor?: string): Promise<P.PostThread> {
  const k = M.parseKey(key);
  if (!k) throw new Error('not a Substack post id (p-… or c-…)');
  const c = checkCursor(cursor);
  need();
  return run('post', async () => {
    let focal: P.PostFact | null = null;
    let ancestors: P.PostFact[] = [];
    let replies: { replies: P.PostFact[][]; more: string | null };
    if (k.on === 'post') {
      if (!c) focal = M.parsePostPage(await read<unknown>({ kind: 'post', id: k.id }), ctx);
      const pub = await pubOfPost(k.id);
      replies = M.parseBranches(await read<unknown>({ kind: 'postReplies', id: k.id, pub, ...(c ? { cursor: c } : {}) }), ctx);
    } else {
      if (!c) ({ focal, ancestors } = M.parseNotePage(await read<unknown>({ kind: 'note', id: k.id }), ctx));
      replies = M.parseBranches(await read<unknown>({ kind: 'noteReplies', id: k.id, ...(c ? { cursor: c } : {}) }), ctx);
    }
    if (!c && !focal) throw new Error('Substack did not give this post');
    for (const ev of people()) hub.emit(ev);
    return { ...(focal ? { focal } : {}), ancestors, replies: replies.replies, more: replies.more };
  });
}

/** Someone's profile with their recent notes and posts: only when asked (someone opened it). */
async function profile(who: string): Promise<P.PersonAbout> {
  if (typeof who !== 'string' || !/^\d{1,15}$/.test(who)) throw new Error('not a Substack user id');
  need();
  return run('profile', async () => {
    const items = await read<unknown>({ kind: 'profileFeed', id: who });
    const posts = M.parseProfileFeed(items, who, ctx);
    const handle = ctx.users.get(who)?.handle;
    let about: P.PersonAbout;
    if (handle) {
      const u = M.parseProfile(await read<unknown>({ kind: 'profile', handle }), ctx);
      if (!u || u.id !== who) throw new Error('Substack did not give this profile');
      about = M.personAbout(u, posts);
    } else {
      // No handle known: what their feed says of them.
      const u = ctx.users.get(who);
      about = { ...(u?.name ? { displayName: u.name } : {}), ...(u?.photo ? { avatar: u.photo } : {}), links: [{ label: 'Substack', value: u?.name ?? who, url: M.profileUrl({ id: who, handle: null }) }], ...(posts.length ? { posts } : {}) };
    }
    for (const ev of people()) hub.emit(ev);
    return about;
  });
}

/** The heart, or Restack, and their undo. Answers how it stands after. */
async function postAct(key: string, act: P.PostAct): Promise<P.PostViewer> {
  const k = M.parseKey(key);
  if (!k) throw new Error('not a Substack post id (p-… or c-…)');
  if (!POST_ACTS.includes(act)) throw new Error(`not a post action: ${String(act)}`);
  need();
  const remove = act === 'unlike' || act === 'unrepost';
  if (act === 'like' || act === 'unlike') {
    const pub = k.on === 'comment' ? (await placeOf(k.id)).pub : undefined;
    await run(`postAct.${act}`, () => write({ kind: 'react', on: k.on, id: k.id, ...(k.on === 'comment' ? { pub } : {}), remove }));
    return { liked: !remove };
  }
  await run(`postAct.${act}`, () => write({ kind: 'restack', ...(k.on === 'post' ? { post: k.id } : { comment: k.id }), remove }));
  return { reposted: !remove };
}

/**
 * A note (neither), a reply to a note or comment, or a comment on a post (`replyTo`), as the note composer sends it.
 * Pictures and quoting are not offered from here.
 */
async function publish(text: string, replyTo?: string, quote?: string, media?: P.OutgoingAttachment[]): Promise<P.PostFact> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to post');
  if (text.length > MAX_TEXT) throw new Error(`too long to post from here: ${text.length} of ${MAX_TEXT} characters`);
  if (quote !== undefined) throw new Error('quoting (Restack with a note) is not offered from here yet');
  if (Array.isArray(media) && media.length) throw new Error('pictures on a note are not offered from here yet');
  const to = replyTo !== undefined ? M.parseKey(replyTo) : null;
  if (replyTo !== undefined && !to) throw new Error('not a Substack post id to reply to');
  need();
  let r: unknown;
  if (!to) {
    r = await run('publish', () => write<unknown>({ kind: 'note_publish', text }, 90_000));
  } else if (to.on === 'post') {
    const pub = await pubOfPost(to.id);
    r = await run('publish', () => write<unknown>({ kind: 'comment_publish', post: to.id, pub, text }, 90_000));
  } else {
    const place = await placeOf(to.id);
    r = await run('publish', () =>
      write<unknown>(place.post && place.pub ? { kind: 'comment_publish', post: place.post, pub: place.pub, parent: to.id, text } : { kind: 'note_publish', parent: to.id, text }, 90_000),
    );
  }
  const made = M.parsePublished(r, ctx);
  if (!made) throw new Error('Substack did not say what it made: look on Substack before posting again');
  for (const ev of people()) hub.emit(ev);
  return made;
}

/** Delete a note or comment of yours, as its menu's Delete does. One Substack says is gone already counts as deleted. */
async function unpublish(key: string): Promise<{ deleted: true }> {
  const k = M.parseKey(key);
  if (!k || k.on !== 'comment') throw new Error('only a note or comment of yours can be deleted from here');
  need();
  const place = await placeOf(k.id).catch(() => ({ post: null, pub: null }));
  try {
    await run('unpublish', () => write({ kind: 'remove', id: k.id, ...(place.pub ? { pub: place.pub } : {}) }));
  } catch (e) {
    if (/answered 404/.test(String((e as Error).message))) return { deleted: true };
    throw e;
  }
  ctx.places.delete(k.id);
  return { deleted: true };
}

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake Substack's origin too. */
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
      // Settings: a page that shows no feed, so the reader itself marks nothing seen while the account sits there.
      startUrl: `${origin}/settings`,
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
  hub.emit({ t: 'hello', network: 'substack', version: '1', capabilities: CAPABILITIES });
  feed.forget();
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(keepTimer);
    clearTimeout(feedTimer);
    try {
      writeFileSync(STATE_FILE, JSON.stringify({ feed: feed.kept() }), { mode: 0o600 });
    } catch {}
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
