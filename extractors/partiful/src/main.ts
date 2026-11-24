/**
 * The partiful extractor: one Partiful account, from partiful.com in a sandboxed browser (packages/browser: Xvfb, an
 * ordinary Chromium with a persistent profile and our extension, x11vnc for the live view), answering the `chat`
 * interface for dither-chat (docs/partiful.md). You sign in once in the live view, with the code Partiful texts you;
 * the profile keeps the session. Explore works before that.
 *
 * The page's hook (src/extension/hook.js) makes the app's own calls with its session. This side paces them like a
 * person, checks and maps what comes back (map.ts), and:
 *   - answers `home`: `explore` (the city's listing, signed in or not) and `following` (your events, upcoming then
 *     past); `post` (an event with its hosts, the guests the site shows, and its comments); `profile`;
 *   - keeps the chats: `feed` (notifications, read-only), `event:<id>` for each event you are in (comments, host
 *     blasts, the photo album), and `chat:<id>` for Partiful's chats (Stream), reading them every few minutes;
 *   - writes when asked: a comment, a chat message, a reaction, a chat's read mark, and the `rsvp` action (manage).
 * It never marks notifications read, never solves a check for people, and never reads a hidden guest list.
 *
 * Config: { city?, testOrigin?, noSandbox?, feedFirstMs?, feedEveryMs? (tests) }. Keeps partiful-state.json (ids and
 * times of what it announced) in the account directory. Logs ids, counts and statuses: never words, names or tokens.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, displayName, type FreeDisplay, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';
import { EVENT_RSVP_CHOICES } from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import * as M from './map.ts';
import { CAPABILITIES, compute, type Facts, type PageState } from './status.ts';

const WIDTH = 1280;
const HEIGHT = 800;
export const MAX_TEXT = 5000;

const hub = linkHub({ onCommand: onCommandCounted, onConnect, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

const cfg = hub.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const origin = testOrigin ?? M.SITE;
const city = M.citySlug(cfg.city);
if (typeof cfg.city === 'string' && cfg.city.trim() && !city) log('warn', 'the city setting is not a Partiful place slug; using the default listing');
const STATE_FILE = join(hub.accountDir, 'partiful-state.json');

interface Kept {
  newestNotice?: number;
  ids?: string[];
  /** Per conversation, the newest message time announced. */
  convs?: Record<string, number>;
}
function readKept(): Kept {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}
const kept = readKept();

const drops = new M.Drops();
const ctx = M.newCtx(drops, testOrigin);
let display: FreeDisplay | null = null;
let vncSocket: string | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tab: string | null = null;
let page: Facts['page'] = null;
let hookVersion: number | null = null;
let lastCommand: Facts['lastCommand'] = null;
let blocked: Facts['blocked'] = null;
let streamSelf: string | null = null;
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
  silence: { name: 'partiful.com', tab: true, page: true },
  // Reads the page has not said it has after 3 s are sent again; never a write.
  resend: { kinds: ['explore', 'event', 'guests', 'mutualGuests', 'comments', 'hostMessages', 'album', 'myEvents', 'notifications', 'users', 'chatSelf', 'chats', 'chat', 'media', 'self'] },
});

/** A person's pace: writes a little apart, reads (paging, opening events) a little slower. */
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
/** After a 429, nothing is read for this long, then twice that after another, up to an hour. */
let slowFor = fast ? 2_000 : 10 * 60_000;

// ------------------------------------------------------------------- status
function facts(): Facts {
  return {
    now: Date.now(),
    sandbox: { started: !!sandbox && !sandboxError && display !== null && startedAt > 0, error: sandboxError, browserAlive: !!sandbox?.browserAlive, display, liveView: vncSocket !== null, startedAt },
    extensionAttached: bridge.connected,
    tab,
    page,
    self: ctx.selfId ? { id: ctx.selfId } : null,
    hookVersion,
    blocked,
    feed: { items: noticeCount, lastFetch: feedLastFetch, lastError: feedLastError, nextAt: feedNextAt, dropped: drops.summary(3) },
    lastCommand,
  };
}

let lastSent = '';
let onlineSince = 0;
function status(force = false) {
  const c = compute(facts());
  if (page?.state === 'ready' && !onlineSince) {
    onlineSince = Date.now();
    feedOnline();
  }
  if (page?.state !== 'ready') onlineSince = 0;
  const me = ctx.selfId ? ctx.users.get(ctx.selfId) : undefined;
  const selfFact = ctx.selfId ? M.identityFact(me ?? { id: ctx.selfId, name: null, photo: null, bio: null, socials: {} }, ctx.selfId) : undefined;
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
  if (state === 'ready' && M.isId(msg.self?.id)) {
    if (msg.self.id !== ctx.selfId) log('info', `signed in as user ${msg.self.id}`);
    ctx.selfId = msg.self.id;
    if (!ctx.users.has(msg.self.id) && typeof msg.self.name === 'string') ctx.users.set(msg.self.id, { id: msg.self.id, name: msg.self.name.slice(0, 200), photo: null, bio: null, socials: {} });
  } else if (state === 'login') {
    ctx.selfId = null;
    streamSelf = null;
  }
}

// ------------------------------------------------------------- announcing
/** What the hub has been told, so each read gives only what is new. */
const announced = new Set<string>((Array.isArray(kept.ids) ? kept.ids : []).filter((x): x is string => typeof x === 'string').slice(-3000));
const convNewest = new Map<string, number>(Object.entries(kept.convs ?? {}).filter(([, v]) => typeof v === 'number'));
const peopleSent = new Map<string, string>();
const convSent = new Map<string, string>();
let noticeNewest = typeof kept.newestNotice === 'number' ? kept.newestNotice : 0;
let noticeCount = 0;
const LIVE_MS = 15 * 60_000;

function keepSoon() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(writeKept, 3000);
}
let keepTimer: Timer | undefined;
function writeKept() {
  try {
    while (announced.size > 3000) announced.delete(announced.values().next().value!);
    writeFileSync(STATE_FILE, JSON.stringify({ newestNotice: noticeNewest, ids: [...announced], convs: Object.fromEntries(convNewest) } satisfies Kept), { mode: 0o600 });
  } catch {}
}

/** Identity facts for everyone the answers so far named, when new or changed. */
function people() {
  for (const u of ctx.users.values()) {
    const fact = M.identityFact(u, ctx.selfId);
    const fp = JSON.stringify(fact);
    if (peopleSent.get(u.id) === fp) continue;
    peopleSent.set(u.id, fp);
    hub.emit({ t: 'identity', identity: fact });
  }
}
/** Bare identities for ids no answer described (a comment's author, a host the card only names by id). */
function stubs(ids: Iterable<string>) {
  for (const id of ids) {
    if (peopleSent.has(id)) continue;
    if (id === M.PARTIFUL_ACTOR) {
      peopleSent.set(id, 'partiful');
      hub.emit({ t: 'identity', identity: M.partifulIdentity() });
    } else if (M.isId(id) || /^stream:[\w@.-]{1,128}$/.test(id)) {
      peopleSent.set(id, 'stub');
      hub.emit({ t: 'identity', identity: { nativeId: id } });
    }
  }
}
function conversation(c: P.ConversationFact) {
  const fp = JSON.stringify(c);
  if (convSent.get(c.nativeId) === fp) return;
  convSent.set(c.nativeId, fp);
  hub.emit({ t: 'conversation', conversation: c });
}
/**
 * Messages of one conversation, oldest first, people first. Live (they may notify) only when newer than the newest
 * announced there, under 15 minutes old, not seen before, and not on the first read of the conversation.
 */
function messages(conv: string, list: P.MessageFact[], backfill: boolean) {
  people();
  stubs(list.flatMap((m) => [m.author, ...(m.reactions ?? []).flatMap((r) => r.authors)]));
  const before = convNewest.get(conv);
  const now = Date.now();
  for (const m of [...list].sort((a, b) => a.ts - b.ts)) {
    const live = !backfill && before !== undefined && m.ts > before && now - m.ts < LIVE_MS && !announced.has(`${conv}|${m.nativeId}`);
    announced.add(`${conv}|${m.nativeId}`);
    hub.emit({ t: 'message', message: m, live });
    if (m.ts > (convNewest.get(conv) ?? 0)) convNewest.set(conv, m.ts);
  }
  if (!convNewest.has(conv)) convNewest.set(conv, 0);
  keepSoon();
}

// ------------------------------------------------------------------ reading
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
let rotate = 0;

class Slowed extends Error {}
/** A read through the page, paced; a 429 slows every read down, a check for people stops them until it is cleared. */
async function read<T>(cmd: Down, ms = 90_000): Promise<T> {
  if (blocked?.kind === 'slow' && blocked.until && blocked.until > Date.now()) throw new Slowed(`Partiful asked us to slow down; reading again after ${new Date(blocked.until).toISOString().slice(11, 19)}`);
  try {
    const r = await readPace.run(() => bridge.request<T>(cmd, ms));
    if (blocked) {
      blocked = null;
      slowFor = fast ? 2_000 : 10 * 60_000;
      status();
    }
    return r;
  } catch (e) {
    noteBlock(e);
    throw e;
  }
}
const write = <T>(cmd: Down, ms = 60_000) =>
  pace.run(() => bridge.request<T>(cmd, ms)).catch((e) => {
    noteBlock(e);
    throw e;
  });
function noteBlock(e: unknown) {
  const m = String((e as Error)?.message ?? e);
  if (/answered 429/.test(m)) {
    blocked = { kind: 'slow', at: Date.now(), until: Date.now() + slowFor };
    slowFor = Math.min(slowFor * 2, 60 * 60_000);
    log('warn', 'Partiful answered 429: slowing down');
    status();
  } else if (/check for people/.test(m)) {
    blocked = { kind: 'check', at: Date.now() };
    log('warn', 'Partiful showed a check for people');
    status();
  }
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
async function feedTick() {
  feedNextAt = null;
  if (!bridge.connected || page?.state !== 'ready') return scheduleFeed(FEED_EVERY);
  if (busy) return scheduleFeed(FEED_BUSY);
  try {
    const n = await readNotifications();
    feedLastFetch = Date.now();
    feedLastError = null;
    const ev = await readMyEvents();
    const ch = await readChats().catch((e) => {
      log('warn', 'chats read failed', { error: String((e as Error).message).slice(0, 160) });
      return 0;
    });
    const cm = await readUpcomingComments(ev);
    log('info', `read: ${n} notifications, ${ev.length} events, ${ch} chats, ${cm} comments`);
  } catch (e) {
    feedLastError = String((e as Error).message ?? e).slice(0, 160);
    log('warn', 'periodic read failed', { error: feedLastError });
  }
  scheduleFeed(FEED_EVERY);
  status();
}

/** Notifications, newest page; a fresh account's first read announces nothing as new. */
async function readNotifications(): Promise<number> {
  const r = await read<{ data: unknown }>({ kind: 'notifications' });
  const pg = M.parseNotifications(r.data, ctx);
  const fresh = !noticeNewest;
  const now = Date.now();
  people();
  stubs(pg.entries.map((e) => e.actor));
  conversation(M.feedConversation());
  for (const e of [...pg.entries].sort((a, b) => a.ts - b.ts)) {
    if (announced.has(`feed|${e.nativeId}`) && e.ts <= noticeNewest) continue;
    const live = !fresh && e.ts > noticeNewest && now - e.ts < LIVE_MS && !announced.has(`feed|${e.nativeId}`);
    announced.add(`feed|${e.nativeId}`);
    noticeCount++;
    hub.emit({ t: 'message', message: M.feedMessage(e), live });
    if (e.ts > noticeNewest) noticeNewest = e.ts;
  }
  if (!noticeNewest) noticeNewest = now;
  keepSoon();
  return pg.entries.length;
}

let myEvents: P.PostFact[] = [];
/** Your events: kept for `following`, and each one you are in becomes its conversation. */
async function readMyEvents(): Promise<P.PostFact[]> {
  const r = await read<{ data: unknown }>({ kind: 'myEvents' });
  myEvents = M.parseMyEvents(r.data, ctx);
  people();
  stubs(myEvents.flatMap((p) => p.event!.hosts));
  for (const p of myEvents.slice(0, 60)) {
    if (!p.event?.conversation) continue;
    const k = ctx.events.get(p.id);
    if (k) conversation(M.eventConversation(k));
  }
  return myEvents;
}

/** Partiful's chats (Stream): the list with each chat's latest messages, new ones announced. */
async function readChats(): Promise<number> {
  const r = await read<{ channels?: unknown[] }>({ kind: 'chats' });
  if (!streamSelf) streamSelf = (await read<{ user: string }>({ kind: 'chatSelf' })).user;
  let n = 0;
  for (const ch of Array.isArray(r?.channels) ? r.channels : []) {
    const got = M.streamConversation(ch, streamSelf, ctx);
    if (!got) continue;
    n++;
    people();
    stubs(got.conv.participants ?? []);
    conversation(got.conv);
    const fresh = !convNewest.has(got.conv.nativeId);
    messages(got.conv.nativeId, got.messages.filter((m) => !announced.has(`${got.conv.nativeId}|${m.nativeId}`)), fresh);
  }
  return n;
}

/** The comments under the next two upcoming events you are in, in turn, so a new one reaches the chat. */
async function readUpcomingComments(events: P.PostFact[]): Promise<number> {
  const now = Date.now();
  const up = events.filter((p) => p.event?.conversation && (p.event.end ?? p.event.start + 6 * 3600_000) > now - 24 * 3600_000);
  if (!up.length) return 0;
  let n = 0;
  for (let i = 0; i < Math.min(2, up.length); i++) {
    const p = up[(rotate + i) % up.length]!;
    const conv = M.eventConv(p.id);
    const list = await activity(p.id);
    const fresh = !convNewest.has(conv);
    const neu = list.filter((m) => !announced.has(`${conv}|${m.nativeId}`));
    messages(conv, neu, fresh);
    n += neu.length;
  }
  rotate += 2;
  return n;
}

/** An event's Activity: comments, host messages and album posts, as messages, oldest first. */
async function activity(eventId: string): Promise<P.MessageFact[]> {
  const album = await read<{ data: any }>({ kind: 'album', id: eventId }).catch(() => ({ data: null }));
  const items = (Array.isArray(album.data) ? album.data : Array.isArray(album.data?.media) ? album.data.media : []).map((x: unknown) => M.mediaItemOf(x, ctx)).filter(Boolean) as NonNullable<ReturnType<typeof M.mediaItemOf>>[];
  const c = await read<{ data: any }>({ kind: 'comments', id: eventId });
  const h = await read<{ data: any }>({ kind: 'hostMessages', id: eventId }).catch(() => ({ data: null }));
  const out: P.MessageFact[] = [];
  for (const x of Array.isArray(c.data?.comments) ? c.data.comments : []) {
    const m = M.commentMessage(x, eventId, ctx);
    if (m) out.push(m);
  }
  for (const x of Array.isArray(h.data?.hostMessages) ? h.data.hostMessages : []) {
    const m = M.hostMessage(x, eventId, ctx);
    if (m) out.push(m);
  }
  // Album posts a comment already shows stay with the comment.
  const inComments = new Set(out.flatMap((m) => (m.attachments ?? []).map((a) => a.nativeId)));
  for (const it of items) {
    if (inComments.has(it.id)) continue;
    const m = M.albumMessage(it, eventId);
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// --------------------------------------------------------------- commands
function need(signedIn = true) {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (!page || page.state === 'loading') throw new Error('partiful.com has not loaded yet');
  if (signedIn && page.state !== 'ready') throw new Error('Partiful is not signed in (live view)');
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
      return home(cmd.feed, cmd.cursor);
    case 'post':
      return thread(cmd.post, cmd.cursor);
    case 'profile':
      return profile(cmd.who);
    case 'history':
      return history(cmd.conversation, cmd.beforeTs, cmd.limit, cmd.cursor);
    case 'send':
      return send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments);
    case 'react':
      return react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove);
    case 'markRead':
      return markRead(cmd.conversation, cmd.upTo);
    case 'fetchMedia': {
      if (!M.mediaUrl(cmd.url, testOrigin)) throw new Error('not a Partiful picture');
      if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
      return run('media', () => read<{ mime: string; base64: string }>({ kind: 'media', url: cmd.url }, 120_000));
    }
    case 'action':
      if (cmd.action === 'rsvp') return rsvp(cmd.args);
      if (cmd.action === 'resync') {
        peopleSent.clear();
        convSent.clear();
        return { note: 'people and conversations are announced again at the next read' };
      }
      return { note: `no such action: ${cmd.action} (rsvp, resync)` };
    default:
      throw new Error(`partiful does not support ${cmd.t}`);
  }
}

/** The explore listing, read whole on a first page and paged from that copy; kept a few minutes. */
let exploreCache: { at: number; items: M.ExploreItem[] } | null = null;
async function home(which: P.HomeFeed, cursor?: string, count?: number): Promise<P.HomePage> {
  void count;
  if (which === 'explore') {
    need(false);
    return run('home.explore', async () => {
      if (!cursor || !exploreCache || Date.now() - exploreCache.at > 10 * 60_000) {
        if (cursor && !/^o\d{1,5}$/.test(cursor)) throw new Error('not a Partiful explore cursor');
        const r = await read<unknown>({ kind: 'explore', ...(city ? { city } : {}) });
        exploreCache = { at: Date.now(), items: M.parseExplore(r, ctx) };
      }
      const pg = M.pageOf(exploreCache.items, cursor);
      people();
      stubs(pg.items.flatMap((i) => i.post.event!.hosts));
      return { items: pg.items, more: pg.more, top: null };
    });
  }
  if (which === 'following') {
    need(true);
    return run('home.following', async () => {
      if (!cursor || !myEvents.length) await readMyEvents();
      const pg = M.pageOf(
        myEvents.map((post) => ({ post })),
        cursor,
      );
      people();
      stubs(pg.items.flatMap((i) => i.post.event!.hosts));
      return { items: pg.items, more: pg.more, top: null };
    });
  }
  throw new Error('Partiful has no For you: ask for explore (the city) or following (your events)');
}

/**
 * An event's page: the event with its hosts and, only where the host shows the list, the guests the site shows (and
 * your mutuals among them, signed in); its comments as replies.
 */
async function thread(postId: string, cursor?: string): Promise<P.PostThread> {
  if (!M.isId(postId)) throw new Error('not a Partiful event id');
  if (cursor !== undefined) return { ancestors: [], replies: [], more: null };
  need(false);
  return run('post', async () => {
    const r = await read<{ data: any }>({ kind: 'event', id: postId });
    const ev = r.data?.event;
    if (!ev || ev.id !== postId) throw new Error('Partiful did not give this event');
    if (r.data?.passwordRequired) throw new Error('this Partiful event needs its password');
    const known = ctx.events.get(postId);
    let guests: string[] | undefined;
    let all = false;
    if (M.listShown(ev)) {
      const pages: unknown[] = [];
      let next: string | undefined;
      // The guest list as its page pages it, at most 4 pages of 500.
      for (let i = 0; i < 4; i++) {
        const g = await read<{ data: unknown; paging: { nextCursor?: string | null } | null }>({ kind: 'guests', id: postId, ...(next ? { cursor: next } : {}) });
        pages.push(g.data);
        next = g.paging?.nextCursor ?? undefined;
        if (!next) break;
      }
      all = !next;
      guests = M.guestsOf(ev, pages, ctx);
      if (page?.state === 'ready') {
        const mu = await read<{ data: unknown }>({ kind: 'mutualGuests', id: postId }).catch(() => ({ data: null }));
        for (const id of M.mutualsOf(ev, mu.data, ctx)) if (!guests.includes(id)) guests.push(id);
      }
    }
    // Hosts by name: the page's own getUsers for those it named only by id.
    const owners = (Array.isArray(ev.ownerIds) ? ev.ownerIds : []).filter((x: unknown) => M.isId(x) && !ctx.users.get(x as string)?.name);
    if (owners.length && ev.showHostList !== false) {
      const u = await read<{ data: unknown }>({ kind: 'users', ids: owners.slice(0, 20) }).catch(() => ({ data: [] }));
      for (const x of Array.isArray(u.data) ? u.data : []) M.userOf(x, ctx);
    }
    const msgs = await activity(postId);
    const focal = M.eventPost(ev, ctx, { ...(guests ? { guests, allGuests: all } : {}), status: known?.status ?? null, comments: msgs.filter((m) => m.nativeId.startsWith('c:')).length });
    if (!focal) throw new Error('Partiful gave an event this cannot read');
    people();
    stubs([...focal.event!.hosts, ...msgs.map((m) => m.author)]);
    const comments = msgs.filter((m) => m.nativeId.startsWith('c:'));
    const tops = comments.filter((m) => !m.replyTo);
    const replies = tops.map((t) => [M.commentPost(t, postId), ...comments.filter((m) => m.replyTo === t.nativeId).map((m) => M.commentPost(m, postId))]);
    return { focal, ancestors: [], replies, more: null };
  });
}

/** Someone's Partiful profile: name, picture, bio, socials, how many parties they hosted and went to. */
async function profile(who: string): Promise<P.PersonAbout> {
  if (!M.isId(who)) throw new Error('not a Partiful user id');
  need(false);
  return run('profile', async () => {
    const r = await read<{ data: unknown }>({ kind: 'users', ids: [who] });
    const u = (Array.isArray(r.data) ? r.data : []).map((x) => M.userOf(x, ctx)).find((x) => x?.id === who);
    if (!u) throw new Error('Partiful did not give this profile');
    people();
    const about = M.personAbout(u);
    hub.emit({ t: 'personAbout', who, about, ts: Date.now() });
    return about;
  });
}

const CHAT_ID = /^[\w!-]{1,128}$/;
function convOf(conversation: string): { on: 'feed' } | { on: 'event'; id: string } | { on: 'chat'; id: string } {
  if (conversation === M.FEED_CONV) return { on: 'feed' };
  if (conversation.startsWith('event:') && M.isId(conversation.slice(6))) return { on: 'event', id: conversation.slice(6) };
  if (conversation.startsWith('chat:') && CHAT_ID.test(conversation.slice(5))) return { on: 'chat', id: conversation.slice(5) };
  throw new Error('not a Partiful conversation');
}

async function history(conversation: string, beforeTs?: number, limit = 50, cursor?: string): Promise<P.HistoryResult> {
  const c = convOf(conversation);
  if (c.on === 'feed') return { count: 0, done: true };
  need(true);
  if (c.on === 'event') {
    // The Activity feed comes whole: one page, everything before `beforeTs`.
    return run('history.event', async () => {
      const k = ctx.events.get(c.id);
      if (k) conversation_(M.eventConversation(k));
      const list = (await activity(c.id)).filter((m) => beforeTs === undefined || m.ts < beforeTs);
      messages(conversation, list, true);
      return { count: list.length, done: true, ...(list[0] ? { oldest: list[0].ts } : {}) };
    });
  }
  return run('history.chat', async () => {
    const before = cursor ?? undefined;
    if (before !== undefined && !/^[\w-]{1,128}$/.test(before)) throw new Error('not a Partiful chat cursor');
    if (!streamSelf) streamSelf = (await read<{ user: string }>({ kind: 'chatSelf' })).user;
    const r = await read<unknown>({ kind: 'chat', id: c.id, limit: Math.min(Math.max(limit, 1), 100), ...(before ? { before } : {}) });
    const got = M.streamConversation(r, streamSelf, ctx);
    if (!got) throw new Error('Partiful did not give this chat');
    conversation_(got.conv);
    const list = got.messages.filter((m) => beforeTs === undefined || m.ts < beforeTs);
    messages(conversation, list, true);
    const oldest = list[0];
    return { count: list.length, done: got.messages.length < Math.min(Math.max(limit, 1), 100), ...(oldest ? { oldest: oldest.ts, next: oldest.nativeId.slice(2) } : {}) };
  });
}
const conversation_ = conversation;

async function send(conversation: string, body: string, replyTo?: string, attachments?: P.OutgoingAttachment[]): Promise<{ nativeId?: string }> {
  const c = convOf(conversation);
  if (c.on === 'feed') throw new Error('notifications are read-only');
  if (Array.isArray(attachments) && attachments.length) throw new Error('pictures are not sent from here: add them to the album on Partiful');
  if (typeof body !== 'string' || !body.trim()) throw new Error('nothing to send');
  if (body.length > MAX_TEXT) throw new Error(`too long to send from here: ${body.length} of ${MAX_TEXT} characters`);
  need(true);
  if (c.on === 'event') {
    const to = replyTo === undefined ? undefined : replyTo.startsWith('c:') && M.isCommentId(replyTo.slice(2)) ? replyTo.slice(2) : null;
    if (to === null) throw new Error('only a comment can be answered in an event');
    const r = await run('send.comment', () => write<{ data: any }>({ kind: 'comment', event: c.id, text: body, ...(to ? { replyTo: to } : {}) }, 90_000));
    const m = M.commentMessage(r.data?.comment ?? r.data, c.id, ctx);
    if (m) messages(conversation, [m], true);
    return m ? { nativeId: m.nativeId } : {};
  }
  const quoted = replyTo === undefined ? undefined : replyTo.startsWith('s:') ? replyTo.slice(2) : null;
  if (quoted === null) throw new Error('not a Partiful chat message to answer');
  const r = await run('send.chat', () => write<{ message?: unknown }>({ kind: 'chatSend', id: c.id, text: body, ...(quoted ? { replyTo: quoted } : {}) }, 90_000));
  const m = M.streamMessage(r?.message, conversation, ctx);
  if (m) messages(conversation, [m], true);
  return m ? { nativeId: m.nativeId } : {};
}

async function react(conversation: string, message: string, key: string, remove: boolean): Promise<Record<string, never>> {
  const c = convOf(conversation);
  if (c.on === 'feed') throw new Error('notifications are read-only');
  if (typeof key !== 'string' || !key || key.length > 32) throw new Error('not a reaction');
  need(true);
  if (c.on === 'event') {
    const id = message.slice(2);
    if (message.startsWith('c:') && M.isCommentId(id)) await run('react.comment', () => write({ kind: 'commentReaction', event: c.id, comment: id, emoji: key, remove }));
    else if (message.startsWith('h:') && M.isCommentId(id)) await run('react.blast', () => write({ kind: 'hostMessageReaction', event: c.id, message: id, emoji: key, remove }));
    else throw new Error('only comments and host messages take reactions on Partiful');
  } else {
    if (!message.startsWith('s:')) throw new Error('not a Partiful chat message');
    await run('react.chat', () => write({ kind: 'chatReact', message: message.slice(2), type: M.streamType(key), remove }));
  }
  if (ctx.selfId) hub.emit({ t: 'reaction', conversation, message, author: ctx.selfId, key, ...(remove ? { remove: true } : {}), ts: Date.now() });
  return {};
}

/** A chat's read mark, as opening it in the app sets it. Events and notifications are never marked. */
async function markRead(conversation: string, upTo: string): Promise<Record<string, never>> {
  void upTo;
  const c = convOf(conversation);
  if (c.on !== 'chat') return {};
  need(true);
  await run('markRead', () => write({ kind: 'chatRead', id: c.id }));
  return {};
}

/** The `rsvp` action (manage: the host and guests see it): as the event page's RSVP buttons send it. */
async function rsvp(args: unknown): Promise<P.PostFact | Record<string, never>> {
  const a = (args && typeof args === 'object' ? args : {}) as Partial<P.EventRsvpArgs>;
  if (!M.isId(a.eventId)) throw new Error('rsvp needs eventId, a Partiful event id');
  if (!EVENT_RSVP_CHOICES.includes(a.status as P.EventRsvpChoice)) throw new Error(`rsvp status is one of ${EVENT_RSVP_CHOICES.join(', ')}`);
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 500)) throw new Error('an RSVP note is at most 500 characters');
  need(true);
  const eventId = a.eventId;
  const status_ = M.RSVP_STATUS[a.status as P.EventRsvpChoice];
  return run('rsvp', async () => {
    const r = await write<{ data: any }>({ kind: 'rsvp', event: eventId, status: status_, ...(a.note ? { note: a.note } : {}) }, 90_000);
    const now = typeof r.data?.status === 'string' ? r.data.status : status_;
    const ev = await read<{ data: any }>({ kind: 'event', id: eventId }).catch(() => null);
    const k = ctx.events.get(eventId);
    if (k) k.status = now;
    const post = ev?.data?.event ? M.eventPost(ev.data.event, ctx, { status: now }) : null;
    if (post?.event?.conversation) {
      const kk = ctx.events.get(eventId);
      if (kk) conversation(M.eventConversation(kk));
    }
    people();
    return post ?? {};
  });
}

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake Partiful's origin too. */
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
    let free: FreeDisplay;
    try {
      free = await pickFreeDisplay(undefined, tried);
    } catch (e) {
      sandboxError = String((e as Error).message ?? e);
      break;
    }
    if (free.display !== null) tried.push(free.display);
    display = free;
    sandbox = new Sandbox({
      accountDir: hub.accountDir,
      display: free,
      width: WIDTH,
      height: HEIGHT,
      extensionSrc: join(import.meta.dir, 'extension'),
      config: { wsUrl: bridge.wsUrl, token: bridgeToken, testOrigin },
      prepareExtension: testOrigin ? addTestOrigin : undefined,
      // Explore: a page that marks nothing read, and works signed out too.
      startUrl: `${origin}/explore`,
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
      log('warn', `sandbox on ${displayName(free)} failed`, sandboxError);
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
  hub.emit({ t: 'hello', network: 'partiful', version: '1', capabilities: CAPABILITIES });
  peopleSent.clear();
  convSent.clear();
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(keepTimer);
    clearTimeout(feedTimer);
    writeKept();
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

