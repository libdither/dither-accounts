/**
 * The luma extractor: one Luma account, from luma.com in a sandboxed browser (packages/browser: Xvfb, an ordinary
 * Chromium with a persistent profile and our extension, x11vnc for the live view), answering the `chat` interface for
 * dither-chat (docs/luma.md). You sign in once in the live view (the emailed code, or whatever Luma shows); the
 * profile keeps the session. Explore works before that: Luma's discover pages answer anyone.
 *
 * The page's hook (src/extension/hook.js) makes the web app's own calls to api.luma.com with its session, each as the
 * app makes it for the same click. This side paces them like a person (pace.ts: one read at a time, seconds apart; a
 * 429 or a Cloudflare check holds every read back), checks and maps what comes back (map.ts), and:
 *   - answers `home` (explore: the city's discover listing, or Luma's own pick when no city is set; following: your
 *     events, upcoming then past), `post` (an event's page, with the guest list a signed-in guest is shown when the
 *     host shows it) and `profile` (someone's profile, socials as links, the events they host);
 *   - reads your notifications every few minutes into one read-only conversation (nativeId 'feed', variant 'feed');
 *   - keeps one conversation per event you are in (`event:<id>`), its host's blasts as messages (`extra.blast`);
 *   - syncs Luma's chats (event chats, direct, group) as the chat page does on load, and sends, reacts and marks read;
 *   - RSVPs (`action` 'rsvp', manage) with the event page's one-click Register or its Not going, nothing else.
 * Nothing it does marks a notification seen.
 *
 * Config: { city?, testOrigin?, noSandbox?, feedFirstMs?, feedEveryMs?, chatEveryMs?, eventsEveryMs?, backoffScale?
 * (tests) }. Keeps luma-state.json (newest times, recent message ids, the chat's sync cursors) in the account
 * directory. Logs ids, counts and statuses: never an event's words, people's names, or cookies.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox, SignInAsker, signInConfig } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';
import { EVENT_RSVP_CHOICES } from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import * as M from './map.ts';
import { Backoff, Pace } from './pace.ts';
import { CAPABILITIES, compute, type Facts, type PageState } from './status.ts';
import { CATCH_UP_PAGES, FIRST_READ_MS, FIRST_READ_PAGES, type Kept, Tracker } from './tracker.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** Luma's chat composer has no stated limit; this keeps a paste from going out by mistake. */
export const MAX_TEXT = 4000;

const hub = linkHub({ onCommand: onCommandCounted, onConnect, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

const cfg = hub.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const origin = testOrigin ?? M.SITE;
const city: string | null = typeof cfg.city === 'string' && cfg.city.trim() ? cfg.city.trim().slice(0, 80) : null;
const STATE_FILE = join(hub.accountDir, 'luma-state.json');

function readKept(): Kept {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

const drops = new M.Drops();
const ctx = M.newCtx(drops, testOrigin);
const track = new Tracker(readKept());
/** Chat conversations as Luma described them: their type and the event they belong to. */
const chats = new Map<string, M.ChatConv>();
/** Events read lately: what an RSVP and the event conversations need. */
const events = new Map<string, { known: M.EventKnown; hosts: string[]; at: number }>();
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
const READS = ['bootstrap', 'place', 'discover', 'event', 'profile', 'profileEvents', 'myEvents', 'notifications', 'blasts', 'guests', 'calendarUrls', 'convSync', 'msgSync', 'conversation', 'messages', 'media', 'self'];
const bridge = new BridgeServer<Up, Down>({
  token: bridgeToken,
  onMessage: onBridge,
  onConnect: () => status(),
  onDisconnect: () => status(),
  log,
  silence: { name: 'luma.com', tab: true, page: true },
  // Reads the page has not said it has after 3 s are sent again; never a message, a reaction, a read mark or an RSVP.
  resend: { kinds: READS },
});

/** "Continue with Google" on luma.com, answered by a Google account here (docs/signin-relay.md). */
const signIns = new SignInAsker({ bridge, ask: (what, input, ms) => hub.ask(what, input, ms), log, onChange: () => status() });
/** Tests: the origin standing for each sign-in provider (only with a test origin of Luma's own). */
const testSignInOrigins: Record<string, string> = testOrigin && cfg.testSignInOrigins && typeof cfg.testSignInOrigins === 'object' ? cfg.testSignInOrigins : {};

const fast = Number(cfg.feedEveryMs) > 0;
/** Writes a little apart; reads (paging, opening an event) slower, one at a time. */
const writePace = fast ? new Pace(50, 50) : new Pace(1200, 900);
const readPace = fast ? new Pace(50, 50) : new Pace(2000, 2500);
const backoff = new Backoff(Number(cfg.backoffScale) > 0 ? Number(cfg.backoffScale) : 1);

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
    backoff: backoff.state(),
    feed: { items: track.items, lastFetch: feedLastFetch, lastError: feedLastError, nextAt: feedNextAt, dropped: drops.summary(3) },
    chats: { conversations: chats.size, messages: chatMessages, lastFetch: chatLastFetch, lastError: chatLastError },
    city,
    lastCommand,
  };
}

let lastSent = '';
function status(force = false) {
  const c = compute(facts());
  if (c.status === 'online' && !onlineSince) {
    onlineSince = Date.now();
    loopsOnline();
  }
  if (c.status !== 'online') onlineSince = 0;
  const me = self ? ctx.users.get(self.id) : undefined;
  const selfFact = me ? M.identityFact(me, me.id) : self ? { nativeId: self.id, isSelf: true } : undefined;
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
  if (signIns.onMessage(msg)) return status();
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
  const state: PageState = (['loading', 'login', 'ready', 'challenge'] as const).includes(msg.state) ? msg.state : 'loading';
  const path = typeof msg.path === 'string' ? msg.path.slice(0, 200) : '';
  if (page?.state !== state) log('info', `page: ${state}`);
  page = { state, path, since: page?.state === state ? page.since : Date.now() };
  if (state === 'ready' && msg.self) {
    const u = M.userOf(msg.self, ctx);
    if (u && u.id !== self?.id) log('info', `signed in as ${u.id}`);
    if (u) self = { id: u.id, username: u.username };
  } else if (state === 'login') {
    self = null;
  }
}

/** Saved within 3 s of a change: a write already waiting takes the later changes too (busy loops never put it off). */
function keepSoon() {
  keepTimer ??= setTimeout(keepNow, 3000);
}
function keepNow() {
  clearTimeout(keepTimer);
  keepTimer = undefined;
  try {
    writeFileSync(STATE_FILE, JSON.stringify(track.kept()), { mode: 0o600 });
  } catch {}
}
let keepTimer: Timer | undefined;

// ------------------------------------------------------------------- calls
const iso = (ms: number) => new Date(ms).toISOString().slice(11, 19);
function held() {
  if (backoff.holding()) throw new Error(backoff.why === 'challenge' ? 'Luma is showing a Cloudflare check: clear it in the live view' : `Luma asked to slow down (429): reads wait until ${iso(backoff.until)} UTC`);
}
async function through<T>(pace: Pace, cmd: Down, ms: number): Promise<T> {
  held();
  return pace.run(async () => {
    held();
    try {
      const r = await bridge.request<T>(cmd, ms);
      if (backoff.why) {
        backoff.ok();
        status();
      }
      return r;
    } catch (e) {
      const k = backoff.failed(String((e as Error).message ?? e));
      if (k) {
        log('warn', k === '429' ? `Luma said 429: holding reads until ${iso(backoff.until)}` : 'Luma showed a Cloudflare check: holding reads; the account asks to clear it');
        status();
      }
      throw e;
    }
  });
}
const read = <T>(cmd: Down, ms = 90_000) => through<T>(readPace, cmd, ms);
const write = <T>(cmd: Down, ms = 60_000) => through<T>(writePace, cmd, ms);

function need(signedIn: boolean) {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page?.state === 'challenge') throw new Error('Luma is showing a Cloudflare check: clear it in the live view');
  if (!page || page.state === 'loading') throw new Error('luma.com has not loaded yet');
  if (signedIn && page.state !== 'ready') throw new Error('Luma is not signed in (live view)');
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

/** Identity facts for everyone answers named since, before the facts that name them. */
function people(): P.AdapterEvent[] {
  return track.identities(ctx.users.values(), self?.id ?? null);
}
function emit(list: P.AdapterEvent[]) {
  for (const ev of list) hub.emit(ev);
}

// ------------------------------------------------------------------- the loops
const span = (v: unknown, lo: number, hi: number): [number, number] => (Number(v) > 0 ? [Number(v), Number(v)] : [lo, hi]);
const pick = ([lo, hi]: [number, number]) => lo + Math.floor(Math.random() * (hi - lo + 1));
const FEED_FIRST = span(cfg.feedFirstMs, 30_000, 60_000);
const FEED_EVERY = span(cfg.feedEveryMs, 4 * 60_000, 8 * 60_000);
const CHAT_EVERY = span(cfg.chatEveryMs, 60_000, 120_000);
const EVENTS_EVERY = span(cfg.eventsEveryMs, 20 * 60_000, 40 * 60_000);
let feedTimer: Timer | undefined;
let chatTimer: Timer | undefined;
let eventsTimer: Timer | undefined;
let feedNextAt: number | null = null;
let feedLastFetch: number | null = null;
let feedLastError: string | null = null;
let chatLastFetch: number | null = null;
let chatLastError: string | null = null;
let chatMessages = 0;
let started = false;
let busy = 0;

function loopsOnline() {
  if (started) return;
  started = true;
  const first = pick(FEED_FIRST);
  feedNextAt = Date.now() + first;
  feedTimer = setTimeout(() => void feedTick(), first);
  chatTimer = setTimeout(() => void chatTick(), first + pick([2000, 6000]));
  eventsTimer = setTimeout(() => void eventsTick(), first + pick([8000, 15000]));
}
const online = () => bridge.connected && compute(facts()).status === 'online';
/** A loop's next turn: later when Luma said to wait, a little later when the hub is asking things. */
function again(f: () => void, every: [number, number]): Timer {
  const wait = backoff.holding() ? backoff.until - Date.now() + pick([5000, 30000]) : busy ? pick([20_000, 40_000]) : pick(every);
  return setTimeout(f, Math.max(1000, wait));
}

async function feedTick() {
  feedNextAt = null;
  if (online() && !backoff.holding() && !busy) {
    try {
      const n = await readNotifications();
      feedLastFetch = Date.now();
      feedLastError = null;
      log('info', `notifications read: ${n.items} items, ${n.pages} page(s)`);
    } catch (e) {
      feedLastError = String((e as Error).message ?? e).slice(0, 160);
      log('warn', 'notifications read failed', { error: feedLastError });
    }
  }
  feedTimer = again(() => void feedTick(), FEED_EVERY);
  status();
}

/** The notifications' first page, and further back while every one on a page is new; a fresh account a fortnight. */
async function readNotifications(): Promise<{ items: number; pages: number }> {
  const now = Date.now();
  const fresh = track.fresh('feed');
  let cursor: string | null = null;
  let pages = 0;
  let items = 0;
  for (;;) {
    const r = await read<unknown>({ kind: 'notifications', ...(cursor ? { cursor } : {}) });
    pages++;
    const pg = M.parseNotifications(r, ctx);
    const entries = fresh ? pg.entries.filter((e) => e.ts > now - FIRST_READ_MS) : pg.entries;
    const allNew = entries.length > 0 && entries.every((e) => !track.has(e.nativeId));
    emit(people());
    emit(track.stubs(entries.map((e) => e.actor)));
    emit(track.feed(entries, { now, backfill: fresh || pages > 1 }));
    items += entries.length;
    const oldest = Math.min(...pg.entries.map((e) => e.ts));
    const goOn = pg.more && (fresh ? pages < FIRST_READ_PAGES && oldest > now - FIRST_READ_MS : pages < CATCH_UP_PAGES && allNew);
    if (!goOn) break;
    cursor = pg.more;
  }
  keepSoon();
  return { items, pages };
}

/** At most this many sync pages a turn; the rest next turn. */
const SYNC_PAGES = 10;
async function chatTick() {
  if (online() && !backoff.holding() && !busy) {
    try {
      const n = await syncChats();
      chatLastFetch = Date.now();
      chatLastError = null;
      if (n.conversations || n.messages) log('info', `chats synced: ${n.conversations} conversations, ${n.messages} messages`);
    } catch (e) {
      chatLastError = String((e as Error).message ?? e).slice(0, 160);
      log('warn', 'chat sync failed', { error: chatLastError });
    }
  }
  chatTimer = again(() => void chatTick(), CHAT_EVERY);
  status();
}

const eventOfChat = (conv: string) => chats.get(conv)?.event ?? null;
/** The chat page's own sync on load: conversations since the last cursor, then messages since theirs. */
async function syncChats(): Promise<{ conversations: number; messages: number }> {
  const now = Date.now();
  let convs = 0;
  let msgs = 0;
  for (let i = 0; i < SYNC_PAGES; i++) {
    const pg = M.syncPage(await read<unknown>({ kind: 'convSync', ...(track.convCursor ? { cursor: track.convCursor } : {}) }));
    for (const raw of pg.entries) {
      const r = raw as any;
      if (r?.type === 'removed' && typeof r.api_id === 'string') {
        if (chats.delete(r.api_id)) emit([{ t: 'leave', kind: 'conversation', nativeId: r.api_id }]);
        continue;
      }
      const c = M.chatConversation(raw, self?.id ?? null, ctx);
      if (!c) continue;
      chats.set(c.conv.id, c.conv);
      emit(people());
      emit(track.conversation(c.fact));
      convs++;
    }
    if (pg.next) track.convCursor = pg.next;
    if (!pg.more || !pg.next) break;
  }
  const first = !track.msgCursor;
  for (let i = 0; i < SYNC_PAGES; i++) {
    const pg = M.syncPage(await read<unknown>({ kind: 'msgSync', ...(track.msgCursor ? { cursor: track.msgCursor } : {}), first: !track.msgCursor }));
    const list: P.MessageFact[] = [];
    for (const raw of pg.entries) {
      const m = M.chatMessage(raw, self?.id ?? null, ctx, eventOfChat);
      if (!m) continue;
      if ('deleted' in m) {
        emit([{ t: 'delete', ...m.deleted }]);
        continue;
      }
      if (!chats.has(m.conversation)) await learnChat(m.conversation);
      list.push(m);
    }
    emit(people());
    emit(track.stubs(list.map((m) => m.author)));
    emit(track.messages('chat', list, { now, backfill: first }));
    msgs += list.length;
    chatMessages += list.length;
    if (pg.next) track.msgCursor = pg.next;
    if (!pg.more || !pg.next) break;
  }
  keepSoon();
  return { conversations: convs, messages: msgs };
}
/** A message in a chat the conversations' sync did not bring (one made since): its conversation first. */
async function learnChat(id: string) {
  try {
    const c = M.chatConversation(await read<unknown>({ kind: 'conversation', id }), self?.id ?? null, ctx);
    if (!c) return;
    chats.set(c.conv.id, c.conv);
    emit(people());
    emit(track.conversation(c.fact));
  } catch {}
}

/** Blasts of at most this many events a turn, the soonest first. */
const BLAST_EVENTS = 5;
async function eventsTick() {
  if (online() && !backoff.holding() && !busy) {
    try {
      const n = await readMyEvents();
      if (n) log('info', `event conversations: ${n} read`);
    } catch (e) {
      log('warn', 'events read failed', { error: String((e as Error).message ?? e).slice(0, 160) });
    }
  }
  eventsTimer = again(() => void eventsTick(), EVENTS_EVERY);
}
/** Your upcoming events: a conversation each, with its host's blasts. */
async function readMyEvents(): Promise<number> {
  const now = Date.now();
  const pg = M.eventsPage(await read<unknown>({ kind: 'myEvents', period: 'future' }), ctx);
  emit(people());
  let n = 0;
  for (const { post, known } of pg.posts) {
    remember(post, known);
    if (!known.inIt) continue;
    emit(track.conversation(M.eventConversation(post.id, known, post.event!.hosts)));
    if (n >= BLAST_EVENTS) continue;
    n++;
    const fresh = !track.ids.has(`seen-event:${post.id}`);
    const list = M.blastMessages(await read<unknown>({ kind: 'blasts', id: post.id }), post.id, post.event!.hosts[0] ?? null, ctx);
    emit(people());
    emit(track.stubs(list.map((m) => m.author)));
    emit(track.messages('blasts', list, { now, backfill: fresh }));
    track.ids.add(`seen-event:${post.id}`);
  }
  keepSoon();
  return n;
}
function remember(post: P.PostFact, known: M.EventKnown) {
  events.set(post.id, { known, hosts: post.event?.hosts ?? [], at: Date.now() });
  if (events.size > 500) events.delete(events.keys().next().value!);
}

// --------------------------------------------------------------- commands
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
      return thread(cmd.post);
    case 'profile':
      return profile(cmd.who);
    case 'history':
      return history(cmd.conversation, cmd.cursor);
    case 'send':
      return send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments);
    case 'markRead':
      return markRead(cmd.conversation);
    case 'react':
      return react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove);
    case 'fetchMedia': {
      if (!M.mediaUrl(cmd.url, testOrigin)) throw new Error('not a Luma picture');
      if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
      return run('media', () => read<{ mime: string; base64: string }>({ kind: 'media', url: cmd.url }, 120_000));
    }
    case 'action':
      if (cmd.action === 'rsvp') return rsvp(cmd.args);
      if (cmd.action === 'resync') {
        track.forget();
        return { note: 'conversations and people are announced again at the next read' };
      }
      return { note: `no such action: ${cmd.action} (rsvp, resync)` };
    default:
      throw new Error(`luma does not support ${cmd.t}`);
  }
}

const CURSOR = /^[\w\-.:=+/%]{1,2000}$/;
function checkCursor(c: unknown): string | undefined {
  if (c === undefined || c === null || c === '') return undefined;
  if (typeof c !== 'string' || !CURSOR.test(c)) throw new Error('not a Luma cursor');
  return c;
}

/** The city's place on Luma (its slug, else Luma's own pick for this viewer), kept six hours. */
let placeKept: { place: M.Place; at: number } | null = null;
async function place(): Promise<M.Place> {
  if (placeKept && Date.now() - placeKept.at < 6 * 3600_000) return placeKept.place;
  const slug = M.citySlug(city);
  let p: M.Place | null;
  if (slug) {
    p = M.placeOfUrl(await read<unknown>({ kind: 'place', slug }));
    if (!p) throw new Error(`Luma has no city called "${city}": set the account's city to one of the places on luma.com/discover (its slug, like the end of luma.com/<city>)`);
  } else {
    p = M.placeOfBootstrap(await read<unknown>({ kind: 'bootstrap' }));
    if (!p) throw new Error('Luma did not pick a city: set the account’s city');
  }
  placeKept = { place: p, at: Date.now() };
  return p;
}

/**
 * Explore (the city's discover listing, signed in or not) or Your events (signed in: upcoming, then past). Cursors:
 * Luma's own for Explore; `f:<cursor>` and `p:<cursor>` for upcoming and past.
 */
async function home(which: P.HomeFeed, cursor?: string): Promise<P.HomePage> {
  const c = checkCursor(cursor);
  if (which === 'explore') {
    need(false);
    return run('home.explore', async () => {
      const pl = await place();
      const pg = M.eventsPage(await read<unknown>({ kind: 'discover', place: pl.id, ...(c ? { cursor: c } : {}) }), ctx);
      emit(people());
      const items: P.HomeItem[] = pg.posts.map(({ post, known }) => {
        remember(post, known);
        return { post, ...(pl.featured.includes(post.id) && pl.name ? { reason: { text: `Featured in ${pl.name}`, kind: 'topic' as const } } : {}) };
      });
      return { items, more: pg.more, top: null };
    });
  }
  if (which !== 'following') throw new Error('Luma has Explore and Your events (following), no For you');
  need(true);
  const past = c?.startsWith('p:') ?? false;
  const luma = c ? c.slice(2) || undefined : undefined;
  if (c && !/^[fp]:/.test(c)) throw new Error('not a Luma cursor');
  return run('home.following', async () => {
    const pg = M.eventsPage(await read<unknown>({ kind: 'myEvents', period: past ? 'past' : 'future', ...(luma ? { cursor: luma } : {}) }), ctx);
    emit(people());
    const items: P.HomeItem[] = [];
    for (const { post, known } of pg.posts) {
      remember(post, known);
      if (known.rsvp === 'declined' && !known.hosting) continue; // as Home hides them
      if (known.inIt) emit(track.conversation(M.eventConversation(post.id, known, post.event!.hosts)));
      items.push({ post, ...(known.hosting ? { reason: { text: 'Hosting', kind: 'other' as const } } : known.rsvp === 'invited' ? { reason: { text: 'Invited', kind: 'other' as const } } : {}) });
    }
    return { items, more: pg.more ? `${past ? 'p' : 'f'}:${pg.more}` : past ? null : 'p:', top: null };
  });
}

/** An .ics address among the event's calendar links (`/event/get-calendar-urls` targets). */
function icsOf(v: unknown): string | undefined {
  const found: string[] = [];
  const walk = (x: unknown, d: number) => {
    if (d > 4) return;
    if (typeof x === 'string') {
      if (/^(webcal|https):\/\/[^\s]+(\.ics\b|\/ics\/get\?)/.test(x)) found.push(x.replace(/^webcal:/, 'https:'));
    } else if (x && typeof x === 'object') for (const v of Object.values(x)) walk(v, d + 1);
  };
  walk(v, 0);
  return found[0];
}

/**
 * An event's page: its details, hosts, and who is going as the site shows this viewer. Signed in as a guest Luma has
 * let in (or a host), and only when the host shows the list, the guest list's first page as the site's dialog shows it.
 * Luma has no comments: no replies.
 */
async function thread(id: string): Promise<P.PostThread> {
  if (!M.isEventId(id)) throw new Error('not a Luma event id (evt-…)');
  need(false);
  return run('post', async () => {
    const raw = await read<any>({ kind: 'event', id });
    const first = M.eventPost(raw, M.newCtx(new M.Drops()));
    if (!first) throw new Error('Luma did not give this event');
    const k = first.known;
    let guestList: { ids: string[]; complete: boolean } | undefined;
    let ics: string | undefined;
    if (page?.state === 'ready' && (k.rsvp === 'going' || k.hosting)) {
      if (k.showGuests) {
        const g = M.guestListPage(await read<unknown>({ kind: 'guests', id, ticketKey: raw?.guest_data?.ticket_key ?? undefined }), ctx);
        guestList = { ids: g.ids, complete: !g.more };
      }
      ics = icsOf(await read<unknown>({ kind: 'calendarUrls', id, proxyKey: raw?.guest_data?.proxy_key ?? undefined }).catch(() => null));
    }
    const got = M.eventPost(raw, ctx, { guestList, ics })!;
    remember(got.post, got.known);
    emit(people());
    if (got.known.inIt) emit(track.conversation(M.eventConversation(id, got.known, got.post.event!.hosts)));
    return { focal: got.post, ancestors: [], replies: [], more: null };
  });
}

/** Someone's profile: who they are, their socials, and the events they host. Only when asked. */
async function profile(who: string): Promise<P.PersonAbout> {
  if (!M.isUserId(who)) throw new Error('not a Luma user id (usr-…)');
  need(false);
  return run('profile', async () => {
    const r = await read<any>({ kind: 'profile', id: who });
    const u = M.userOf(r?.user, ctx);
    if (!u || u.id !== who) throw new Error('Luma did not give this profile');
    let posts: P.PostFact[] = [];
    try {
      const ev = await read<any>({ kind: 'profileEvents', id: who });
      const list = [...(Array.isArray(ev?.events_hosting) ? ev.events_hosting : []), ...(Array.isArray(ev?.events_past) ? ev.events_past : [])];
      posts = list
        .map((x) => M.eventPost(x, ctx))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => x.post)
        .slice(0, 20);
    } catch (e) {
      log('debug', 'profile events not read', { error: String((e as Error).message ?? e).slice(0, 120) });
    }
    emit(people());
    const about = M.personAbout(ctx.users.get(who)!, posts);
    emit([{ t: 'personAbout', who, about, ts: Date.now() }]);
    return about;
  });
}

function refuseEventWrite(conv: string, what: string): never {
  if (conv === M.FEED_CONV) throw new Error(`Luma's notifications are read-only: nothing to ${what} there`);
  throw new Error(`Luma has no comments on an event: only its host's blasts are there, so there is nothing to ${what}`);
}
const isChat = (conv: string) => conv !== M.FEED_CONV && !conv.startsWith('event:') && M.isLumaId(conv);

/** Older messages: a chat's (as its page scrolls back), an event's blasts (all at once), nothing for the feed. */
async function history(conv: string, cursor?: string): Promise<P.HistoryResult> {
  if (conv === M.FEED_CONV) return { count: 0, done: true };
  need(true);
  const now = Date.now();
  if (conv.startsWith('event:')) {
    const id = conv.slice(6);
    if (!M.isEventId(id)) throw new Error('not a Luma event conversation');
    return run('history.blasts', async () => {
      const list = M.blastMessages(await read<unknown>({ kind: 'blasts', id }), id, events.get(id)?.hosts[0] ?? null, ctx);
      emit(people());
      emit(track.stubs(list.map((m) => m.author)));
      emit(track.messages('blasts', list, { now, backfill: true }));
      return { count: list.length, done: true, ...(list.length ? { oldest: list[0]!.ts } : {}) };
    });
  }
  if (!isChat(conv)) throw new Error('not a Luma conversation');
  const c = checkCursor(cursor);
  return run('history.chat', async () => {
    const pg = M.syncPage(await read<unknown>({ kind: 'messages', id: conv, ...(c ? { cursor: c } : {}) }));
    const list: P.MessageFact[] = [];
    for (const raw of pg.entries) {
      const m = M.chatMessage(raw, self?.id ?? null, ctx, eventOfChat);
      if (m && !('deleted' in m)) list.push(m);
    }
    emit(people());
    emit(track.stubs(list.map((m) => m.author)));
    emit(track.messages('history', list, { now, backfill: true }));
    const oldest = list.length ? Math.min(...list.map((m) => m.ts)) : undefined;
    return { count: list.length, done: !pg.more || !pg.next, ...(oldest !== undefined ? { oldest } : {}), ...(pg.more && pg.next ? { next: pg.next } : {}) };
  });
}

async function send(conv: string, body: string, replyTo?: string, attachments?: P.OutgoingAttachment[]): Promise<{ nativeId?: string }> {
  if (!isChat(conv)) refuseEventWrite(conv, 'send');
  if (attachments?.length) throw new Error('pictures are not sent to Luma from here yet: words only');
  if (typeof body !== 'string' || !body.trim()) throw new Error('nothing to send');
  if (body.length > MAX_TEXT) throw new Error(`too long to send from here: ${body.length} of ${MAX_TEXT} characters`);
  if (replyTo !== undefined && !M.isLumaId(replyTo)) throw new Error('not a Luma message to reply to');
  need(true);
  const r = await run('send', () => write<any>({ kind: 'send', id: conv, text: body, ...(replyTo ? { replyTo } : {}) }));
  const sent = (Array.isArray(r?.messages) ? r.messages : [r?.message]).map((m: unknown) => M.chatMessage(m, self?.id ?? null, ctx, eventOfChat)).filter((m: any): m is P.MessageFact => !!m && !('deleted' in m));
  emit(people());
  emit(track.messages('chat', sent, { now: Date.now(), backfill: true }));
  return sent[0] ? { nativeId: sent[0].nativeId } : {};
}

async function markRead(conv: string): Promise<unknown> {
  // Notifications are never marked seen from here; an event's blasts have nothing to mark.
  if (!isChat(conv)) return {};
  need(true);
  await run('markRead', () => write({ kind: 'markRead', id: conv }));
  return {};
}

async function react(conv: string, message: string, key: string, remove: boolean): Promise<unknown> {
  if (!isChat(conv)) refuseEventWrite(conv, 'react to');
  if (!M.isLumaId(message)) throw new Error('not a Luma message');
  need(true);
  await run(remove ? 'unreact' : 'react', () => write({ kind: 'react', message, key, remove }));
  emit([{ t: 'reaction', conversation: conv, message, author: self!.id, key, ...(remove ? { remove: true } : {}), ts: Date.now() }]);
  return {};
}

/**
 * RSVP from the event card (manage: the host and guests see it). Going: the event page's one-click Register, only for
 * a free event with one kind of ticket and no questions (else the live view); the waitlist when Luma offers only that.
 * Not going: its decline, with your note. Luma has no Maybe or Interested. Replies with the event as it now stands.
 */
async function rsvp(args: unknown): Promise<P.PostFact> {
  const a = (args && typeof args === 'object' ? args : {}) as Partial<P.EventRsvpArgs>;
  if (!M.isEventId(a.eventId)) throw new Error('not a Luma event id (evt-…)');
  if (!a.status || !EVENT_RSVP_CHOICES.includes(a.status)) throw new Error(`not an RSVP: ${EVENT_RSVP_CHOICES.join(', ')}`);
  if (a.status === 'maybe' || a.status === 'interested') throw new Error('Luma has no Maybe or Interested: only Going (register) and Not going');
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 1000)) throw new Error('a note is words, at most 1000 characters');
  const id = a.eventId;
  need(true);
  return run(`rsvp.${a.status}`, async () => {
    const raw = await read<any>({ kind: 'event', id });
    const now = M.eventPost(raw, ctx);
    if (!now) throw new Error('Luma did not give this event');
    const k = now.known;
    if (a.status === 'going') {
      if (k.rsvp === 'going' || k.rsvp === 'pending' || k.rsvp === 'waitlist') return now.post;
      if (k.oneClick) throw new Error(`Luma wants its registration form for this event (${k.oneClick}): register in the live view`);
      const soldOut = raw?.ticket_info?.is_sold_out === true || raw?.sold_out === true;
      if (soldOut && raw?.waitlist_active !== true) throw new Error('This event is sold out and has no waitlist');
      const r = await write<any>({ kind: 'register', id, ...(k.ticketType ? { ticketType: k.ticketType.id } : {}), ...(soldOut ? { waitlist: true } : {}), ...(raw?.event_invite?.api_id ? { invite: raw.event_invite.api_id } : {}) }, 90_000);
      if (r && typeof r.status === 'string' && r.status !== 'success') throw new Error(`Luma did not register you (${r.status.slice(0, 40)}): look on Luma before trying again`);
    } else {
      if (k.rsvp === 'declined') return now.post;
      if (k.rsvp === null && !raw?.event_invite) throw new Error('You have not registered for this event: nothing to decline');
      await write({ kind: 'decline', id, ...(a.note ? { note: a.note } : {}), ...(raw?.event_invite?.secret_key ? { invite: raw.event_invite.secret_key } : {}) }, 90_000);
    }
    const after = M.eventPost(await read<any>({ kind: 'event', id }), ctx);
    if (!after) throw new Error('Luma did not give the event back: look on Luma');
    remember(after.post, after.known);
    emit(people());
    if (after.known.inIt) emit(track.conversation(M.eventConversation(id, after.known, after.post.event!.hosts)));
    return after.post;
  });
}

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake Luma's origin too. */
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
      config: { wsUrl: bridge.wsUrl, token: bridgeToken, testOrigin, signIn: signInConfig(testSignInOrigins) },
      prepareExtension: testOrigin ? addTestOrigin : undefined,
      // Home: where you sign in from, and a page that marks nothing seen while the account sits there.
      startUrl: `${origin}/home`,
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
  hub.emit({ t: 'hello', network: 'luma', version: '1', capabilities: CAPABILITIES });
  track.forget();
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(keepTimer);
    clearTimeout(feedTimer);
    clearTimeout(chatTimer);
    clearTimeout(eventsTimer);
    keepNow();
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
