/**
 * The x extractor: one X account's direct messages, from the real x.com web client signed in in a sandboxed browser
 * (packages/browser: Xvfb, an ordinary Chromium with a persistent profile and our extension, x11vnc for the live view),
 * answering the `chat` interface. You sign in once in the live view (and enter your XChat PIN there if X asks for it
 * on this browser); the profile keeps the session.
 *
 * The page's hook (src/extension/hook.js) finds the client's own chat objects (docs/x.md): it forwards the inbox and
 * the open conversation's messages as whitelisted copies, and runs commands as the UI's own events. This side checks
 * every object again (validate.ts), works out what changed (ingest.ts), maps it to facts (map.ts), paces commands
 * like a person (pace.ts) and reports the account's status from the hook's self-test (status.ts).
 *
 * Around the chat, the same page is x.com's own client (responsive-web), and the feed section below reads its
 * notifications into one read-only conversation (variant 'feed'), announces the profiles of the people in them, and
 * answers `profile` with a person's recent posts and `post` with one post's thread, all through the page's own
 * endpoints (feed.ts, docs/x.md). It also answers on X when asked: `postAct` (like, repost, and back), `publish` (a
 * post, reply or quote) and `postReactors` (who liked or reposted a post), through the same client's own calls.
 *
 * Config: { testOrigin?, noSandbox?, hookGraceMs?, feedFirstMs?, feedEveryMs? (tests) }. Keeps x-state.json (the
 * newest sequence number announced per conversation; the feed's cursor, newest time and recent message ids) and,
 * when asked or when a hook goes missing, diagnostics.json (shapes only) in the account directory. Logs ids, counts,
 * hook and Kotlin class names and statuses: never message text, people's names or handles, cookies, tokens or the PIN.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import { ADD_MEMBERS_MAX, aboutChangeProblem, composeState, createGroupProblem, POST_ACTS, POST_RULES } from '@dither-chat/protocol';
import { aboutOf, directFact, groupFact, ingestRequests, requestFact, Requests } from './gaps.ts';
import { ingestInbox, ingestMessages, XState } from './ingest.ts';
import { FeedTracker, FIRST_READ_MS, FIRST_READ_PAGES, type FeedKept, parseNotifications, parseProfileUser, parsePublished, parseReactors, parseTweetDetail, parseUserTweets, personAbout } from './feed.ts';
import { conversationFact, identityFact, parseMediaRef, peerOf, shapeOf, toPlain } from './map.ts';
import { Pace } from './pace.ts';
import type { Down, FeedHookName, FeedReply, HookName, OutFile, PageState, PersonRef, PostActReply, PostReply, ProfileReply, PublishReply, ReactorsReply, SelfTest, Up } from './raw.ts';
import { FEED_HOOK_NAMES } from './raw.ts';
import { capabilitiesOf, compute, CORE, type Facts, type FeedFacts, HOOK_GRACE_MS } from './status.ts';
import * as V from './validate.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** A fresh account looks at this many of its newest conversations; later only at ones with something new. */
const FIRST_LOOK = 10;
const CATCH_UP = 30;

const hub = linkHub({ onCommand: onCommandCounted, onConnect, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

const cfg = hub.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const origin = testOrigin ?? 'https://x.com';
/** How long hooks may take to appear on the chat page before a missing one counts as broken (tests shorten it). */
const graceMs = Number(cfg.hookGraceMs) > 0 ? Number(cfg.hookGraceMs) : HOOK_GRACE_MS;
const STATE_FILE = join(hub.accountDir, 'x-state.json');
const DIAG_FILE = join(hub.accountDir, 'diagnostics.json');

// -------------------------------------------------------------------- state
function readKept(): { seen?: Record<string, string>; feed?: FeedKept } {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}
const st = new XState(readKept().seen);
const firstRun = st.seen.size === 0;
const drops = new V.Drops();
let display: number | null = null;
/** The live view's Unix socket, once the sandbox is up. */
let vncSocket: string | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tab: string | null = null;
let hookTabs = 0;
let page: Facts['page'] = null;
let selfTest: SelfTest | null = null;
let inboxFacts: Facts['inbox'] = null;
let openCount = 0;
let lastCommand: Facts['lastCommand'] = null;
let diagnosticsAt: number | null = null;
let onlineSince = 0;
let sentCaps = '';
const timers: Timer[] = [];
const backfilling = new Set<string>();

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
});

/** Writes: a person's pace. Opening conversations to read (catching up, history, media): slower. */
const pace = new Pace(1200, 900);
const readPace = new Pace(2500, 3500);

// ------------------------------------------------------------------- status
function facts(): Facts {
  return {
    now: Date.now(),
    sandbox: { started: !!sandbox && !sandboxError && display !== null && startedAt > 0, error: sandboxError, browserAlive: !!sandbox?.browserAlive, display, liveView: vncSocket !== null, startedAt },
    extensionAttached: bridge.connected,
    hookTabs,
    tab,
    page,
    selfTest,
    self: st.selfId ? { id: st.selfId, handle: st.selfUser?.screenName ?? null, via: selfTest?.hooks.self.via ?? null } : null,
    inbox: inboxFacts,
    open: openCount,
    dropped: mergedDrops().summary(),
    droppedTotal: mergedDrops().total,
    lastCommand,
    diagnosticsAt,
    graceMs,
    feed: feedFacts(),
  };
}
/** Drops counted here and in the page, together. */
function mergedDrops(): V.Drops {
  const d = new V.Drops();
  for (const [k, v] of drops.counts) d.counts.set(k, v);
  for (const [k, v] of Object.entries(selfTest?.counts.dropped ?? {})) d.counts.set(`page.${k}`, (d.counts.get(`page.${k}`) ?? 0) + v);
  return d;
}

let lastSent = '';
function status(force = false) {
  const c = compute(facts());
  if (c.status === 'online' && !onlineSince) {
    onlineSince = Date.now();
    // Once, after it first works: the shapes of what it found, for the record (docs/x.md, the second round).
    timers.push(setTimeout(() => void diagnose('first online').catch(() => {}), 20_000));
    feedOnline();
  }
  const caps = JSON.stringify(c.capabilities);
  if (caps !== sentCaps && selfTest) {
    sentCaps = caps;
    hub.emit({ t: 'hello', network: 'x', version: '1', capabilities: c.capabilities });
  }
  const self = st.selfId ? identityFact(st.selfUser ?? { id: st.selfId, screenName: null, displayName: null, avatarUrl: null }, st.selfId) : undefined;
  const ev: P.AdapterEvent = {
    t: 'status',
    status: c.status,
    attention: c.attention,
    liveView: vncSocket !== null ? { vncSocket, width: WIDTH, height: HEIGHT } : null,
    ...(self ? { self } : {}),
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
      const active = msg.tabs.find((t) => t.active) ?? msg.tabs[0];
      const was = tab;
      tab = active?.url ?? null;
      hookTabs = msg.tabs.filter((t) => t.hook).length;
      if (tab !== was) log('info', `tab on ${tab ?? 'nothing'}`);
      break;
    }
    case 'hook':
      log('info', `hook ${msg.version} up`);
      break;
    case 'selftest':
      onSelfTest(V.selfTest(msg));
      break;
    case 'page': {
      const state = (['login', 'verify', 'pin', 'chat', 'other'] as PageState[]).includes(msg.state) ? msg.state : 'other';
      const path = typeof msg.path === 'string' ? msg.path.slice(0, 200) : '';
      const pinMode = typeof msg.pinMode === 'string' && /^[\w-]{1,30}$/.test(msg.pinMode) ? msg.pinMode : null;
      if (page?.state !== state) log('info', `page: ${state}${pinMode ? ` (${pinMode})` : ''}`);
      page = { state, path, pinMode, since: page?.state === state ? page.since : Date.now() };
      if (state === 'chat') drainSyncs();
      break;
    }
    case 'self':
      if (typeof msg.id === 'string' && /^\d{1,24}$/.test(msg.id) && msg.id !== st.selfId) {
        st.selfId = msg.id;
        log('info', `signed in as user ${msg.id}`);
      }
      break;
    case 'inbox':
      onInbox(msg);
      break;
    case 'messages':
      onMessages(msg);
      break;
    case 'requests':
      onRequests(msg);
      break;
    case 'closed':
      break;
  }
  status();
}

function onSelfTest(t: SelfTest | null) {
  if (!t) return;
  const before = selfTest;
  selfTest = t;
  const changed = (Object.keys(t.hooks) as HookName[]).filter((n) => before?.hooks[n]?.ok !== t.hooks[n].ok || before?.hooks[n]?.via !== t.hooks[n].via);
  if (changed.length) log('info', 'self-test', { found: changed.filter((n) => t.hooks[n].ok).map((n) => `${n}:${t.hooks[n].via}`), missing: changed.filter((n) => !t.hooks[n].ok) });
  openCount = t.counts.conversationsOpen;
  feedHooksChanged(before, t);
  // Something core still missing on the chat page after the grace period: keep the shapes for whoever fixes it.
  const coreMissing = CORE.filter((n) => !t.hooks[n].ok);
  if (coreMissing.length && page?.state === 'chat' && Date.now() - page.since > graceMs) void diagnose(`missing ${coreMissing.join(',')}`).catch(() => {});
}

function onInbox(msg: unknown) {
  const ib = V.inbox(msg, drops, testOrigin);
  if (!ib) return;
  const { events, newer } = ingestInbox(st, ib);
  for (const ev of events) hub.emit(ev);
  const cs = ib.conversations;
  inboxFacts = {
    conversations: cs.length,
    legacy: cs.filter((c) => c.legacy === true).length,
    xchat: cs.filter((c) => c.legacy === false).length,
    groups: cs.filter((c) => c.group === true).length,
    loading: ib.loading,
    failed: ib.failed,
    keysChecked: ib.keysChecked,
  };
  if (!ib.loading) queueSyncs(newer, cs);
}

function onMessages(msg: unknown) {
  const raw = V.messages(msg, drops, testOrigin);
  if (!raw) return;
  const events = ingestMessages(st, raw, { backfill: backfilling.has(raw.conv) });
  for (const ev of events) hub.emit(ev);
  keepSoon();
}

let keepTimer: Timer | undefined;
function keepSoon() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    try {
      writeFileSync(STATE_FILE, keptJson(), { mode: 0o600 });
    } catch {}
  }, 3000);
}

// --------------------------------------------------------- catching up
// Conversations with something newer than what was announced are opened (quietly, so nothing is marked read) and
// read, one at a time at a reading pace: what a person scrolling their inbox would do.
const syncQueue: string[] = [];
let looked = false;
/** Look at the newest conversations whatever was seen: a fresh account, or after a resync. */
let lookAll = firstRun;
function queueSyncs(newer: string[], all: { id: string; lastTs: number | null }[]) {
  let ids = newer;
  if (!looked) {
    looked = true;
    const byTime = [...all].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0)).map((c) => c.id);
    ids = lookAll ? byTime.slice(0, FIRST_LOOK) : byTime.filter((id) => newer.includes(id)).slice(0, CATCH_UP);
    lookAll = false;
  }
  for (const id of ids) if (!syncQueue.includes(id)) syncQueue.push(id);
  drainSyncs();
}
let draining = false;
async function drainSyncs() {
  if (draining) return;
  draining = true;
  try {
    while (syncQueue.length && bridge.connected && page?.state === 'chat' && selfTest && CORE.every((n) => selfTest!.hooks[n].ok)) {
      const conv = syncQueue.shift()!;
      try {
        await readPace.run(() => bridge.request({ kind: 'sync', conv }, 90_000));
      } catch (e) {
        log('info', 'catching up on a conversation failed', { conv, error: String((e as Error).message).slice(0, 160) });
      }
    }
  } finally {
    draining = false;
  }
}

// --------------------------------------------------------------- commands
function need(hook: HookName, what: string) {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page && page.state !== 'chat') throw new Error(page.state === 'pin' ? 'X wants your XChat PIN first (live view)' : page.state === 'login' ? 'X is not signed in (live view)' : 'X is not on its chat page');
  if (!selfTest?.hooks[hook]?.ok) throw new Error(`cannot ${what}: X changed and the page's ${hook} hook was not found`);
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
    if (/X changed/.test(error)) void diagnose(`${kind} failed`).catch(() => {});
    throw e;
  } finally {
    status();
  }
}

async function onCommand(cmd: P.AdapterCommand): Promise<unknown> {
  const gap = await onGapCommand(cmd);
  if (gap !== NOT_MINE) return gap;
  switch (cmd.t) {
    case 'send': {
      need('send', 'send');
      const text = toPlain(cmd.body ?? '', (id) => st.handleOf(id)).trim();
      const files: OutFile[] = (cmd.attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, base64: readFileSync(a.path).toString('base64') }));
      if (!text && !files.length) throw new Error('nothing to send');
      if (cmd.replyTo) need('reply', 'reply');
      const r = await run('send', () => pace.run(() => bridge.request<{ nativeId: string | null }>({ kind: 'send', conv: cmd.conversation, text, ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}), ...(files.length ? { files } : {}) }, files.length ? 240_000 : 90_000)));
      return { nativeId: r?.nativeId ?? null };
    }
    case 'history': {
      // The feed and the posts the hub logs (feed:<id>, posts:<id>) are no chat on X: never look for one in the page.
      if (/^(feed|posts)(:|$)/.test(cmd.conversation)) return { count: 0, done: true };
      need('history', 'load history');
      backfilling.add(cmd.conversation);
      try {
        const r = await run('history', () => readPace.run(() => bridge.request<{ count: number; more: boolean }>({ kind: 'history', conv: cmd.conversation, limit: cmd.limit, ...(cmd.beforeTs ? { beforeTs: cmd.beforeTs } : {}) }, 240_000)));
        return { count: r?.count ?? 0, done: !r?.more };
      } finally {
        // The messages arrive just before the reply; give them a moment before later ones count as live.
        timers.push(setTimeout(() => backfilling.delete(cmd.conversation), 3000));
      }
    }
    case 'markRead':
      need('read', 'mark read');
      await run('markRead', () => pace.run(() => bridge.request({ kind: 'markRead', conv: cmd.conversation, message: cmd.upTo }, 90_000)));
      return {};
    case 'react':
      need('reactions', 'react');
      if (cmd.style === 'super') throw new Error('X has no super reactions');
      await run('react', () => pace.run(() => bridge.request({ kind: 'react', conv: cmd.conversation, message: cmd.message, emoji: cmd.key, ...(cmd.remove ? { remove: true } : {}) }, 90_000)));
      return {};
    case 'reactionContext': {
      const ok = !!selfTest?.hooks.reactions.ok;
      return { canReact: ok, ...(ok ? {} : { reason: "This account cannot react: X changed and the page's reaction hook was not found." }), custom: [] } satisfies P.ReactionContext;
    }
    case 'edit': {
      need('edit', 'edit');
      const text = toPlain(cmd.body, (id) => st.handleOf(id)).trim();
      if (!text) throw new Error('an edit cannot be empty');
      await run('edit', () => pace.run(() => bridge.request({ kind: 'edit', conv: cmd.conversation, message: cmd.message, text }, 90_000)));
      return {};
    }
    case 'redact':
      need('unsend', 'unsend');
      await run('unsend', () => pace.run(() => bridge.request({ kind: 'unsend', conv: cmd.conversation, message: cmd.message }, 90_000)));
      return {};
    case 'fetchMedia': {
      const ref = parseMediaRef(cmd.url);
      if (!ref) throw new Error('not an X media reference');
      if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
      return run('media', () => readPace.run(() => bridge.request<{ mime: string; base64: string }>({ kind: 'media', ...ref }, 120_000)));
    }
    case 'profile':
      return profile(cmd.who);
    case 'post':
      return post(cmd.post, cmd.cursor);
    case 'postAct':
      return postAct(cmd.post, cmd.act);
    case 'publish':
      return publish(cmd.text, cmd.replyTo, cmd.quote);
    case 'postReactors':
      return postReactors(cmd.post, cmd.kind, cmd.cursor);
    case 'action':
      return action(cmd.action);
    default:
      throw new Error(`x does not support ${cmd.t}`);
  }
}

async function action(name: string): Promise<unknown> {
  if (name === 'diagnose') return diagnose('asked');
  if (name === 'selftest') {
    if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
    const t = V.selfTest(await bridge.request({ kind: 'selftest' }, 20_000));
    onSelfTest(t);
    status();
    return t;
  }
  if (name === 'resync') {
    // Everything announced again: the conversations and people now, the newest conversations' messages as they are read.
    st.forget();
    feed.forget();
    looked = false;
    lookAll = true;
    if (bridge.connected) await bridge.request({ kind: 'inbox' }, 20_000).catch(() => null);
    return { note: `conversations announced again; the newest ${FIRST_LOOK} are read again` };
  }
  return { note: `no such action: ${name} (diagnose, selftest, resync)` };
}

/** The page's diagnostics (shapes, names, counts; never values) into diagnostics.json, at most once a minute. */
let lastDiagnose = 0;
async function diagnose(why: string): Promise<unknown> {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (why !== 'asked' && Date.now() - lastDiagnose < 10 * 60_000) return null;
  lastDiagnose = Date.now();
  const d = await bridge.request<Record<string, unknown>>({ kind: 'diagnose' }, 30_000);
  const out = { at: new Date().toISOString(), why, extractor: { dropped: Object.fromEntries(drops.counts), conversations: st.convs.size, capabilities: capabilitiesOf(selfTest), feed: { items: feed.items, people: feed.abouts, dropped: Object.fromEntries(feedDrops.counts), lastFetch: feedLastFetch, lastError: feedLastError } }, page: d };
  writeFileSync(DIAG_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  diagnosticsAt = Date.now();
  log('info', `diagnostics saved (${why}): shapes only, in diagnostics.json`);
  status();
  return out;
}

// ---------------------------------------------------------------- the feed
// X's notifications (likes, reposts, replies, mentions, quotes, follows) as one read-only conversation, read like a
// person checking the tab: the first time 30-60 s after the account goes online, then every 4-8 minutes, only while
// it is online and no command is running. A fresh account reads back two pages or seven days at most; after that only
// what is newer than the Top cursor kept in x-state.json. Nothing is ever marked seen on X. The people in it are
// announced (personAbout) at most once a day each, and `profile` reads someone's profile and recent posts on request.
const span = (v: unknown, lo: number, hi: number): [number, number] => (Number(v) > 0 ? [Number(v), Number(v)] : [lo, hi]);
const FEED_FIRST = span(cfg.feedFirstMs, 30_000, 60_000);
const FEED_EVERY = span(cfg.feedEveryMs, 4 * 60_000, 8 * 60_000);
const FEED_BUSY = Number(cfg.feedEveryMs) > 0 ? FEED_EVERY : ([20_000, 40_000] as [number, number]);
const FEED_COUNT = 40;
const feed = new FeedTracker(readKept().feed);
const feedDrops = new V.Drops();
let feedTimer: Timer | undefined;
let feedNextAt: number | null = null;
let feedStarted = false;
let feedLastFetch: number | null = null;
let feedLastError: string | null = null;
/** Commands running now (the feed waits for them). */
let busy = 0;

function feedFacts(): FeedFacts {
  return { items: feed.items, people: feed.abouts, lastFetch: feedLastFetch, lastError: feedLastError, nextAt: feedNextAt, dropped: feedDrops.summary(3) };
}
function keptJson(): string {
  return JSON.stringify({ seen: st.seenObject(), feed: feed.kept() });
}

async function onCommandCounted(cmd: P.AdapterCommand): Promise<unknown> {
  busy++;
  try {
    return await onCommand(cmd);
  } finally {
    busy--;
  }
}

function feedHooksChanged(before: SelfTest | null, t: SelfTest) {
  const changed = FEED_HOOK_NAMES.filter((n) => before?.feed?.[n]?.ok !== t.feed?.[n]?.ok || before?.feed?.[n]?.via !== t.feed?.[n]?.via);
  if (changed.length) log('info', 'self-test (feed)', { found: changed.filter((n) => t.feed?.[n]?.ok).map((n) => `${n}:${t.feed?.[n]?.via}`), missing: changed.filter((n) => !t.feed?.[n]?.ok).map((n) => `${n}${t.feed?.[n]?.via === 'pending' ? ':pending' : ''}`) });
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
  if (!bridge.connected || compute(facts()).status !== 'online') return scheduleFeed(FEED_EVERY);
  if (busy || draining || syncQueue.length) return scheduleFeed(FEED_BUSY);
  try {
    const n = await readFeed();
    feedLastFetch = Date.now();
    feedLastError = null;
    log('info', `feed read: ${n.items} new, ${n.pages} page(s)`);
  } catch (e) {
    feedLastError = String((e as Error).message ?? e).slice(0, 160);
    log('warn', 'feed read failed', { error: feedLastError });
    if (/X changed/.test(feedLastError)) void diagnose('feed read failed').catch(() => {});
  }
  scheduleFeed(FEED_EVERY);
  status();
}

async function feedPage(cursor: string | null) {
  const r = await readPace.run(() => bridge.request<FeedReply>({ kind: 'feed', count: FEED_COUNT, ...(cursor ? { cursor } : {}) }, 120_000));
  return parseNotifications(r?.timeline, st.selfId, feedDrops, testOrigin);
}

/** One look at the notifications: what is new since the Top cursor, or on a fresh account up to two pages back. */
async function readFeed(): Promise<{ items: number; pages: number }> {
  const now = Date.now();
  const fresh = feed.fresh;
  const before = feed.items;
  const emitAll = (evs: P.AdapterEvent[]) => {
    for (const ev of evs) hub.emit(ev);
  };
  let page = await feedPage(fresh ? null : feed.top);
  if (fresh) page.entries = page.entries.filter((e) => e.ts > now - FIRST_READ_MS);
  emitAll(feed.page(page, { selfId: st.selfId, now, backfill: fresh }));
  let pages = 1;
  // A fresh account: back as a person scrolls, a little at a time, two pages or seven days at most.
  while (fresh && page.bottom && pages < FIRST_READ_PAGES && page.oldest !== null && page.oldest > now - FIRST_READ_MS) {
    await Bun.sleep(2500 + Math.floor(Math.random() * 3500));
    page = await feedPage(page.bottom);
    pages++;
    page.entries = page.entries.filter((e) => e.ts > now - FIRST_READ_MS);
    emitAll(feed.page(page, { selfId: st.selfId, now, backfill: true, older: true }));
  }
  keepSoon();
  return { items: feed.items - before, pages };
}

/** Someone's profile as X shows it, with their recent posts: only when asked (someone opened it), never on a timer. */
async function profile(who: string): Promise<P.PersonAbout> {
  if (!/^\d{1,25}$/.test(who)) throw new Error('not an X user id');
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page?.state === 'login') throw new Error('X is not signed in (live view)');
  if (!selfTest?.feed?.profiles?.ok) throw new Error("cannot read profiles: X changed and the page's profiles hook was not found");
  const r = await run('profile', () => readPace.run(() => bridge.request<ProfileReply>({ kind: 'profile', user: who }, 120_000)));
  const u = parseProfileUser(r?.user, feedDrops, testOrigin);
  if (!u || u.id !== who) throw new Error('X did not give this profile');
  const { posts, users } = parseUserTweets(r?.tweets, feedDrops, testOrigin);
  users.set(u.id, u);
  for (const ev of feed.identities(users.values(), st.selfId)) hub.emit(ev);
  return { ...personAbout(u), ...(posts.length ? { posts } : {}) };
}

/**
 * One post's thread as its page on X shows it (TweetDetail): what it answers, the post, and its replies; `cursor` for
 * more replies. Only when asked (someone opened the post), paced as any read; nothing is liked, viewed or marked.
 */
async function post(id: string, cursor?: string): Promise<P.PostThread> {
  if (typeof id !== 'string' || !/^\d{1,25}$/.test(id)) throw new Error('not an X post id');
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2000)) throw new Error('not an X cursor');
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page?.state === 'login') throw new Error('X is not signed in (live view)');
  if (!selfTest?.feed?.posts?.ok) throw new Error("cannot read posts: X changed and the page's posts hook was not found");
  const r = await run('post', () => readPace.run(() => bridge.request<PostReply>({ kind: 'post', post: id, ...(cursor ? { cursor } : {}) }, 120_000)));
  const { thread, users } = parseTweetDetail(r?.detail, id, feedDrops, testOrigin, !!cursor);
  for (const ev of feed.identities(users.values(), st.selfId)) hub.emit(ev);
  return thread;
}

// ------------------------------------------------------------ answering on X
// Like, repost, post and who liked (docs/x.md "Answering on X"): each the one call X's own button or composer makes,
// made once, when the command comes. Writes go at a person's pace (the DMs' `pace`), are never retried (a failed one
// fails with X's words), and a post X has made is never answered as failed.
const POST_ID = /^\d{1,25}$/;
function feedNeed(hook: FeedHookName, what: string) {
  if (!bridge.connected) throw new Error('the sandbox browser is not attached yet');
  if (page?.state === 'login') throw new Error('X is not signed in (live view)');
  const h = selfTest?.feed?.[hook];
  if (!h?.ok && h?.via !== 'pending') throw new Error(`cannot ${what}: X changed and the page's ${hook} hook was not found`);
}

/** Like, unlike, repost or unrepost a post. Answers how it stands after: `{ liked }` or `{ reposted }`. */
async function postAct(id: string, act: P.PostAct): Promise<P.PostViewer> {
  if (typeof id !== 'string' || !POST_ID.test(id)) throw new Error('not an X post id');
  if (!POST_ACTS.includes(act)) throw new Error(`not a post action: ${String(act)}`);
  feedNeed('actions', act);
  const r = await run(`postAct.${act}`, () => pace.run(() => bridge.request<PostActReply>({ kind: 'postAct', post: id, act }, 60_000)));
  return act === 'like' || act === 'unlike' ? { liked: r?.liked ?? act === 'like' } : { reposted: r?.reposted ?? act === 'repost' };
}

/**
 * A post (neither), a reply (`replyTo`) or a quote (`quote`), as X's composer sends it. Checked against X's rules
 * (compose.ts POST_RULES, as the hub checks it). Identity facts for the post's people first, then the post.
 */
async function publish(text: string, replyTo?: string, quote?: string): Promise<P.PostFact> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to post');
  const c = composeState(text, POST_RULES.x!);
  if (!c.sendable) throw new Error(`too long for X: ${c.length} of ${POST_RULES.x!.maxLength}`);
  if (replyTo !== undefined && (typeof replyTo !== 'string' || !POST_ID.test(replyTo))) throw new Error('not an X post id to reply to');
  if (quote !== undefined && (typeof quote !== 'string' || !POST_ID.test(quote))) throw new Error('not an X post id to quote');
  feedNeed('actions', 'post');
  if (quote) feedNeed('posts', 'quote');
  const r = await run('publish', () => pace.run(() => bridge.request<PublishReply>({ kind: 'publish', text, ...(replyTo ? { replyTo } : {}), ...(quote ? { quote } : {}) }, 120_000)));
  const made = parsePublished(r, text, { id: st.selfId, handle: st.selfUser?.screenName ?? null }, feedDrops, testOrigin);
  // X answered without saying which post it made: it may have been made. Never "failed": that would invite a second.
  if (!made) throw new Error('X did not say which post it made: look on X before posting again');
  for (const ev of feed.identities(made.users.values(), st.selfId)) hub.emit(ev);
  return made.post;
}

/** Who liked (`kind` like) or reposted a post, a page; identity facts for them first. Only a post's author sees its likes. */
async function postReactors(id: string, kind: 'like' | 'repost', cursor?: string): Promise<P.ReactorsPage> {
  if (typeof id !== 'string' || !POST_ID.test(id)) throw new Error('not an X post id');
  if (kind !== 'like' && kind !== 'repost') throw new Error('not likes or reposts');
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2000)) throw new Error('not an X cursor');
  feedNeed('reactors', kind === 'like' ? 'read who liked a post' : 'read who reposted a post');
  const r = await run('postReactors', () => readPace.run(() => bridge.request<ReactorsReply>({ kind: 'reactors', post: id, of: kind, ...(cursor ? { cursor } : {}) }, 120_000)));
  const { page: reactors, users } = parseReactors(r?.timeline, feedDrops, testOrigin);
  for (const ev of feed.identities(users.values(), st.selfId)) hub.emit(ev);
  return reactors;
}

// ------------------------------------------- requests, new chats, groups, typing, forwarding (gaps.ts)
// Each as X's own screens do it, in the page (docs/x.md "Requests, new chats and groups"). A message request's
// conversation is read like any other (quietly, nothing marked read); the hub keeps it quiet until it is accepted.
const requests = new Requests();

function onRequests(msg: unknown) {
  const raw = V.requests(msg, drops, testOrigin);
  if (!raw) return;
  const { events, newer } = ingestRequests(st, requests, raw);
  for (const ev of events) hub.emit(ev);
  for (const id of newer) if (!syncQueue.includes(id)) syncQueue.push(id);
  if (newer.length) void drainSyncs();
}

/** A handle the account has seen for someone (X's search takes a handle, not an id). */
function handleOf(id: string): string | null {
  const h = st.handleOf(id);
  if (h) return h;
  for (const c of requests.raw.values()) for (const u of c.users) if (u.id === id && u.screenName) return u.screenName;
  // Anyone announced to the hub: the identity fact it was told (a request answered since, a member seen once).
  try {
    const f = st.users.get(id);
    const h = f ? (JSON.parse(f) as P.IdentityFact).handle : undefined;
    if (h) return h;
  } catch {}
  return null;
}
/** The id behind a handle the account has seen. */
function idOfHandle(handle: string): string | null {
  const h = handle.replace(/^@/, '').toLowerCase();
  if (st.selfUser?.screenName?.toLowerCase() === h) return st.selfUser.id;
  for (const c of [...st.convs.values()].map((x) => x.raw).concat([...requests.raw.values()])) for (const u of c.users) if (u.screenName?.toLowerCase() === h) return u.id;
  return null;
}
/** The one-to-one this account has with someone already: in the inbox, or waiting as their request. */
function directWith(peer: string): string | null {
  for (const { raw } of st.convs.values()) if (shapeOf(raw, st.selfId) === 'direct' && peerOf(raw, st.selfId) === peer) return raw.id;
  return null;
}
function people(ids: string[]): { refs: PersonRef[]; failed: { id: string; reason: string }[] } {
  const refs: PersonRef[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const id of [...new Set(ids.map(String))]) {
    const handle = handleOf(id);
    if (handle) refs.push({ id, handle });
    else failed.push({ id, reason: "X finds people by their handle, and this account has not seen theirs" });
  }
  return { refs, failed };
}
async function aboutNow(conv: string): Promise<P.About> {
  const raw = V.about(await bridge.request({ kind: 'about', conv }, 20_000), drops, testOrigin);
  if (!raw) throw new Error('X changed: the conversation’s settings could not be read');
  for (const u of raw.users) hub.emit({ t: 'identity', identity: identityFact(u, st.selfId) });
  return aboutOf(raw, st.selfId);
}
const isGroup = (conv: string) => {
  const c = st.convs.get(conv);
  return c ? shapeOf(c.raw, st.selfId) === 'group' : /^g/.test(conv);
};
/** Wait (briefly) for the inbox to say what a change did, then the About as it now stands. */
async function aboutAfter(conv: string, done: (a: P.About) => boolean): Promise<P.About> {
  let a = await aboutNow(conv);
  for (let i = 0; i < 10 && !done(a); i++) {
    await Bun.sleep(500);
    a = await aboutNow(conv);
  }
  return a;
}
const lastTyping = new Map<string, number>();

async function onGapCommand(cmd: P.AdapterCommand): Promise<unknown> {
  switch (cmd.t) {
    case 'answer': {
      need('answer', 'answer requests');
      const conv = cmd.request;
      if (!requests.has(conv)) {
        for (const ev of requests.gone(conv)) hub.emit(ev);
        throw new Error('That request is not waiting any more');
      }
      const c = requests.raw.get(conv)!;
      const f = requestFact(c, st.selfId);
      if (!f.answers.includes(cmd.answer)) throw new Error(cmd.answer === 'accept' ? 'X cannot accept this request from here' : `X answers a group request only with Accept, not ${cmd.answer}`);
      await run('answer', () => pace.run(() => bridge.request({ kind: 'answer', conv, answer: cmd.answer }, 55_000)));
      for (const ev of requests.gone(conv)) hub.emit(ev);
      if (cmd.answer === 'accept') return { conversation: conv, ...(f.from ? { identity: f.from } : {}) } satisfies P.AddResult;
      // Deleted or blocked, X takes the conversation away; a new message from them is a new request.
      hub.emit({ t: 'leave', kind: 'conversation', nativeId: conv });
      st.convs.delete(conv);
      if (cmd.answer === 'decline') return {} satisfies P.AddResult;
      return { ...(f.from ? { identity: f.from, relationship: 'blocked' as const } : {}), notes: ['Blocked on X: they can no longer message you'] } satisfies P.AddResult;
    }
    case 'openDirect': {
      need('openDirect', 'open a conversation');
      if (!st.selfId) throw new Error('who this account is is not known yet');
      const given = String(cmd.peer).trim();
      const peer = /^\d{1,24}$/.test(given) ? given : idOfHandle(given);
      const handle = peer ? handleOf(peer) : given.replace(/^@/, '');
      if (!peer && !/^\w{1,15}$/.test(handle ?? '')) throw new Error('not an X user id or handle');
      const existing = peer ? directWith(peer) : null;
      if (existing) return { conversation: existing, existed: true } satisfies P.OpenDirectResult;
      if (peer === st.selfId) throw new Error('X has no chat with yourself to open from here');
      const r = await run('openDirect', () => pace.run(() => bridge.request<{ conv: string; peer?: string | null; via: string }>({ kind: 'openDirect', peer: peer ?? '', handle }, 25_000)));
      if (!r?.conv || !/^[\w:.\-=+/]{1,128}$/.test(r.conv)) throw new Error('X did not open a conversation');
      const other = peer ?? (typeof r.peer === 'string' && /^\d{1,24}$/.test(r.peer) ? r.peer : null) ?? r.conv.split(':').find((x) => x !== st.selfId) ?? '';
      if (!peer && handle) hub.emit({ t: 'identity', identity: identityFact({ id: other, screenName: handle, displayName: null, avatarUrl: null }, st.selfId) });
      if (directWith(other)) return { conversation: directWith(other)!, existed: true } satisfies P.OpenDirectResult;
      hub.emit({ t: 'conversation', conversation: directFact(r.conv, st.selfId, other) });
      return { conversation: r.conv, existed: false, startsAtFirstSend: true } satisfies P.OpenDirectResult;
    }
    case 'createGroup': {
      need('createGroup', 'make groups');
      const name = cmd.name?.trim() || undefined;
      const problem = createGroupProblem('x', name, cmd.people.length);
      if (problem) throw new Error(problem);
      const { refs, failed } = people(cmd.people);
      if (!refs.length) throw new Error(failed[0]?.reason ?? 'Nobody to put in the group');
      const r = await run('createGroup', () => pace.run(() => bridge.request<{ conv: string; added: string[]; failed: { id: string; reason: string }[]; notes: string[] }>({ kind: 'createGroup', people: refs, ...(name ? { name } : {}) }, 115_000)));
      const conv = String(r?.conv ?? '');
      if (!/^[\w:.\-=+/]{1,128}$/.test(conv)) throw new Error('X did not make the group');
      const added = (r.added ?? []).filter((id) => refs.some((p) => p.id === id));
      hub.emit({ t: 'conversation', conversation: groupFact(conv, st.selfId, added, name) });
      const allFailed = [...failed, ...(r.failed ?? [])];
      return { conversation: conv, added, ...(allFailed.length ? { failed: allFailed } : {}), ...(r.notes?.length ? { notes: r.notes } : {}) } satisfies P.CreateGroupResult;
    }
    case 'addMembers': {
      need('addMembers', 'add people');
      if (cmd.target.kind !== 'conversation' || !isGroup(cmd.target.nativeId)) throw new Error('X adds people to groups only');
      if (!Array.isArray(cmd.people) || !cmd.people.length) throw new Error('Nobody to add');
      if (cmd.people.length > ADD_MEMBERS_MAX) throw new Error(`At most ${ADD_MEMBERS_MAX} people at a time`);
      const conv = cmd.target.nativeId;
      const before = await aboutNow(conv);
      if (before.adding && !before.adding.can) throw new Error(before.adding.reason ?? 'X does not let you add people here');
      const { refs, failed } = people(cmd.people);
      const r = refs.length ? await run('addMembers', () => pace.run(() => bridge.request<{ added: string[]; failed: { id: string; reason: string }[] }>({ kind: 'addMembers', conv, people: refs }, 115_000))) : { added: [], failed: [] };
      const added = (r.added ?? []).filter((id) => refs.some((p) => p.id === id));
      const about = await aboutAfter(conv, (a) => added.every((id) => a.members?.list.some((m) => m.id === id)));
      const c = st.convs.get(conv);
      if (c && added.length) {
        c.participants = [...new Set([...c.participants, ...added])];
        hub.emit({ t: 'conversation', conversation: conversationFact(c.raw, st.selfId, c.participants) });
      }
      const allFailed = [...failed, ...(r.failed ?? [])];
      return { added, ...(allFailed.length ? { failed: allFailed } : {}), about } satisfies P.AddMembersResult;
    }
    case 'about': {
      need('inbox', 'read settings');
      if (cmd.target.kind !== 'conversation') throw new Error('X has no spaces');
      return run('about', () => aboutNow(cmd.target.nativeId));
    }
    case 'configure': {
      need('groupInfo', 'change settings');
      if (cmd.target.kind !== 'conversation') throw new Error('X has no spaces');
      const conv = cmd.target.nativeId;
      const ch = cmd.change;
      if (ch.key === 'avatar') throw new Error('Changing the group picture from here is not built yet: change it on X');
      if (ch.key !== 'name' && ch.key !== 'topic') throw new Error(`X has no ${ch.key} setting to change from here`);
      const problem = aboutChangeProblem('x', 'conversation', ch);
      if (problem) throw new Error(problem);
      const now = await aboutNow(conv);
      const field = now.fields[ch.key];
      if (!field) throw new Error(`X has no ${ch.key} setting here`);
      if (!field.canEdit) throw new Error(field.reason ?? 'X does not let you change that here');
      const value = String(ch.value);
      await run('configure', () => pace.run(() => bridge.request({ kind: 'editGroup', conv, ...(ch.key === 'name' ? { title: value } : { description: value }) }, 55_000)));
      return aboutAfter(conv, (a) => a.fields[ch.key]?.value === value);
    }
    case 'typing': {
      // Best effort, at a typist's pace: one indicator per conversation every few seconds, nothing for a stop (X has
      // none) and never in a request (the hub sends none there either).
      if (cmd.stop || !selfTest?.hooks.typing.ok || !bridge.connected || page?.state !== 'chat' || requests.has(cmd.conversation)) return {};
      const at = lastTyping.get(cmd.conversation) ?? 0;
      if (Date.now() - at < 6000) return {};
      lastTyping.set(cmd.conversation, Date.now());
      void bridge.request({ kind: 'typing', conv: cmd.conversation }, 30_000).catch(() => {});
      return {};
    }
    case 'forward': {
      need('forward', 'forward');
      const to = cmd.conversation;
      const target = st.convs.get(to);
      const peer = target && shapeOf(target.raw, st.selfId) !== 'group' ? peerOf(target.raw, st.selfId) : null;
      const query = target ? (shapeOf(target.raw, st.selfId) === 'group' ? target.raw.title : peer ? handleOf(peer) : null) : null;
      const note = cmd.note ? toPlain(cmd.note, (id) => st.handleOf(id)).trim() : '';
      try {
        await run('forward', () =>
          pace.run(() => bridge.request({ kind: 'forward', conv: cmd.source.conversation, message: cmd.source.message, to, ...(peer ? { peer } : {}), ...(query ? { query } : {}), ...(note ? { note } : {}) }, 55_000)),
        );
      } catch (e) {
        const why = String((e as Error).message ?? e);
        // What X's own dialog does not offer: the hub sends the content again itself.
        if (/does not offer/.test(why)) return { fallback: why };
        throw e;
      }
      return {};
    }
    default:
      return NOT_MINE;
  }
}
const NOT_MINE = Symbol('not a gap command');

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake X's origin too. */
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
      startUrl: `${origin}/i/chat`,
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
  sentCaps = JSON.stringify(capabilitiesOf(selfTest));
  hub.emit({ t: 'hello', network: 'x', version: '1', capabilities: capabilitiesOf(selfTest) });
  status(true);
  // The hub keeps its requests until a list comes: the whole list again, once the page has said it.
  for (const ev of requests.all(st)) hub.emit(ev);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(keepTimer);
    clearTimeout(feedTimer);
    try {
      writeFileSync(STATE_FILE, keptJson(), { mode: 0o600 });
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
