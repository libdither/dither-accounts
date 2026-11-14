/**
 * dither-chat Discord adapter (one process per account).
 *
 * Spawns and supervises the sandbox (Xvfb + real Chromium + our extension +
 * x11vnc), runs the loopback WebSocket server the extension connects to, and maps
 * the raw Discord objects the in-page hook forwards into protocol facts for the
 * hub. Commands from the hub are run back through the client's own code paths,
 * paced like a human.
 *
 * Started by the hub supervisor with DITHER_* env; see protocol/adapter-client.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHub } from '@dither-chat/protocol/client';
import type * as P from '@dither-chat/protocol';
import { createGroupProblem, STICKER_PAGE_PACKS } from '@dither-chat/protocol';
import { stickerPageOf, voiceOut } from './media.ts';
import type { BridgeUp, HookCommand, PageState, RawAbout, RawAddRecipients, RawCreateGroupDM, RawChannel, RawEmoji, RawFriend, RawGuild, RawInvite, RawJoin, RawPerson, RawProfile, RawStickerPage, RawUser } from './discord-types.ts';
import { addCapabilities, addCommand, answerCommand, answerOutcome, friendOutcome, invitePreview, isRelationshipEvent, isRequestEvent, joinOutcome, personPreview, RELATIONSHIP_EVENTS, relationshipEvents, relationshipsEvent, removeCommand, removeOutcome, requestsEvent, resolveCommand, snapshotRelationships, snapshotRequests } from './add.ts';
import { aboutSeenMembers, aboutUsers, addPlan, configurePlan, mapAbout, NOT_GROUP, withChange, withRecipients } from './about.ts';
import { mapMentionables, mentionablesCommand, mentionCapabilities, type RawMentionables } from './mentionables.ts';
import { checkBio, mapProfile, profileUsers } from './profile.ts';
import { bansOutcome, clearPlan, moderatePlan, withModeration } from './moderation.ts';
import { PICTURE_MAX, PICTURE_TYPES } from '@dither-chat/protocol';
import { addedFacts, changedFacts, messageEvents, newState, openedDirect, routeChannel, seenMembers, translateDispatch, translateSnapshot, userFacts } from './ingest.ts';
import { BACKFILL_FILE, BackfillMemory } from './backfill.ts';
import { duePins, PIN_HOLD_MS } from './changes.ts';
import { CHANNEL_TYPE, customEmoji, DISCORD_EPOCH, guildIconUrl, mapUser, refreshable } from './map.ts';
import { BridgeServer, PaceQueue } from './server.ts';
import { annotate, hookPhases, phase, sinceStart, traced } from './trace.ts';
import { vncSocketPath } from '@dither-accounts/browser';
import { Sandbox, pickDisplay } from './sandbox.ts';
import { callCapabilities, callEvents, CALL_EVENTS, newCallMemory } from './calls.ts';
import { SERVER_DISPATCHES, ServerOps, serverCapabilities, serverDispatch } from './servers.ts';
import { pollCapabilities, PollOps } from './polls.ts';
import { oldestOf, searchCommand, searchOutcome, walkCommand, walkOutcome, type RawSearch, type RawWalk } from './search.ts';
import { nativeScheduledOutcome, savedListOutcome, SENDING_DISPATCHES, sendingCapabilities, sendingDispatch, sendingHookCommand } from './sending.ts';
import { contactNote, moreThanBio, noteFact, presenceCommand, presenceOf, profileCommand, selfCapabilities, selfEvents, sessionsOf, type RawSelfState, type RawSelfUp, type RawSession } from './self.ts';
import { forumFact as mapForum, ThreadOps, threadCapabilities, threadDispatch, THREAD_DISPATCHES, withThreads } from './threads.ts';
import { attentionCapabilities, attentionDispatch, attentionSnapshot, markReadManyHookCommand, markUnreadHookCommand, mentionEvents, MentionsPacer, messageAnswerOutcome, messageRequestChannel, muteHookCommand, muteOutcome, newAttention, withMessageRequests, type RawMuted } from './attention.ts';
import { commandsOutcome, interactCapabilities, interactCapability, interactDispatch, interactHookCommand, INTERACT_DISPATCHES, type RawCommands } from './interact.ts';

const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'threads', 'media', 'liveView', 'sendMedia', 'openDirect', 'calls', 'forward', 'about', 'configure', 'profile', 'editProfile', 'members', 'search', 'walkMembers', 'listThreads', 'moderate', 'setPicture', 'sendStickers', 'sendVoice'];
const VERSION = '0.1.0';
const WIDTH = 1280;
const HEIGHT = 800;

const hub = linkHub({ onCommand: commandTraced, onConnect, onShutdown });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

interface RawReactionContext {
  canReact: boolean;
  reason?: string;
  existingOnly?: boolean;
  nitro: boolean;
  custom: { guild: RawGuild; here: boolean; emoji: RawEmoji[] }[];
}

// -------------------------------------------------------------------- state
const { display } = pickDisplay(hub.accountId, hub.config);
/** The live view's Unix socket (the sandbox's x11vnc listens there and on no port); the manager carries it. */
const vncSocket = vncSocketPath(hub.accountDir);
const adapterPort = Number(hub.config.adapterPort ?? process.env.DITHER_ADAPTER_WS_PORT ?? 8700 + display);
const startUrl: string = hub.config.startUrl ?? 'https://discord.com/app';

const st = newState();
/** Calls going on in DMs and group DMs, as the hook last said (calls.ts). */
const callMem = newCallMemory();
/** Message requests, mutes as told, mentions told (attention.ts). */
const att = newAttention();
let selfUser: RawUser | undefined;
let lastPage: PageState = 'loading';
let lastFinders: Record<string, boolean> = {};
let gotFinders = false;
let snapshotReceived = false;
/** The sandbox started (display, browser, VNC), or why it did not. */
let sandboxUp = false;
let sandboxError: string | null = null;

/** resolve, join, connect, requests, relationships, disconnect, addMembers, createGroup: only those whose client modules the hook found (add.ts addCapabilities). */
let addCaps: P.Capability[] = [];

let status: P.AccountStatus = 'connecting';
let attention: Omit<P.Attention, 'since'> | null = null;

function pushStatus(extra: Partial<Extract<P.AdapterEvent, { t: 'status' }>> = {}) {
  hub.emit({
    t: 'status',
    status,
    attention,
    liveView: { vncSocket, width: WIDTH, height: HEIGHT },
    ...(selfUser ? { self: mapUser(selfUser, { isSelf: true }) } : {}),
    details: sessionDetails(),
    layers: sessionLayers(),
    ...extra,
  });
}

/**
 * What this account rests on, outermost first (status.layers): the display, the browser on it, our extension in the
 * browser, the hooks it finds in Discord's client, the first snapshot (signed in), and online. Only what the adapter
 * already knows; the first layer not ok is where it stops.
 */
function sessionLayers(): P.StatusLayer[] {
  const hooks = Object.values(lastFinders);
  const resolved = `${hooks.filter(Boolean).length} of ${hooks.length} resolve`;
  const broken = ['Dispatcher', 'ChannelStore', 'MessageActions'].filter((k) => !lastFinders[k]);
  // A sandbox that did not start: Chromium's own failures are the browser's, the rest (Xvfb, x11vnc) the display's.
  const browserFailed = !!sandboxError && /chromium/i.test(sandboxError);
  const pageNote: Partial<Record<PageState, string>> = {
    login: 'Discord shows its sign-in page: sign in in the live view',
    captcha: 'a captcha is on screen: solve it in the live view',
    verify: 'Discord wants to verify this login: open the live view',
  };
  return [
    sandboxUp
      ? { name: 'display', state: 'ok', note: `Xvfb :${display}, live view ready` }
      : sandboxError && !browserFailed
        ? { name: 'display', state: 'failed', note: sandboxError }
        : browserFailed
          ? { name: 'display', state: 'off', note: 'not started' }
          : { name: 'display', state: 'waiting', note: `starting Xvfb on :${display}` },
    sandboxUp
      ? sandbox?.browserAlive
        ? { name: 'browser', state: 'ok', note: 'Chromium is running' }
        : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' }
      : browserFailed
        ? { name: 'browser', state: 'failed', note: sandboxError! }
        : { name: 'browser', state: 'waiting', note: 'not started yet' },
    bridge.connected ? { name: 'extension', state: 'ok', note: `attached on port ${adapterPort}` } : { name: 'extension', state: 'waiting', note: 'not attached yet' },
    !gotFinders
      ? { name: 'hooks', state: 'waiting', note: 'not reported yet' }
      : broken.length && lastPage === 'app'
        ? { name: 'hooks', state: 'failed', note: `${resolved}; not ${broken.join(', ')}` }
        : broken.length
          ? { name: 'hooks', state: 'waiting', note: `${resolved} so far` }
          : { name: 'hooks', state: 'ok', note: resolved },
    snapshotReceived
      ? { name: 'first snapshot', state: 'ok', note: `${st.guilds.size} servers, ${st.known.size} conversations` }
      : lastPage === 'crashed'
        ? { name: 'first snapshot', state: 'failed', note: 'the Discord page failed to load; it reloads' }
        : { name: 'first snapshot', state: 'waiting', note: pageNote[lastPage] ?? 'not yet' },
    status === 'online'
      ? { name: 'online', state: 'ok' }
      : { name: 'online', state: status === 'error' ? 'failed' : 'waiting', note: attention?.message ?? status },
  ];
}

/** What the account page lists about this session: where the sandbox runs and how far the client got. */
function sessionDetails(): Record<string, string | number | boolean | null> {
  const hooks = Object.values(lastFinders);
  return {
    display: `:${display}`,
    'extension port': adapterPort,
    browser: sandbox?.browserAlive ? 'running' : 'not running',
    extension: bridge.connected ? 'attached' : 'not attached',
    page: lastPage,
    hooks: gotFinders ? `${hooks.filter(Boolean).length} of ${hooks.length} resolve` : 'not reported yet',
    'first snapshot': snapshotReceived,
    start: startUrl,
  };
}

function setStatus(s: P.AccountStatus, att: Omit<P.Attention, 'since'> | null) {
  status = s;
  attention = att;
  pushStatus();
}

// --------------------------------------------------------------- bridge server
/** A loopback-only token for the extension<->adapter socket (distinct from the hub token). */
function deriveBridgeToken(): string {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(`${hub.accountId}:bridge:${process.env.DITHER_ADAPTER_TOKEN ?? ''}`).digest()).toString('base64url').slice(0, 32);
}
const bridgeToken: string = hub.config.__bridgeToken ?? deriveBridgeToken();

const bridge = new BridgeServer({
  port: adapterPort,
  token: bridgeToken,
  onMessage: handleBridge,
  onConnect: () => {
    log('info', 'sandbox extension attached');
    pushStatus();
  },
  onDisconnect: () => {
    log('info', 'sandbox extension detached');
    pushStatus();
  },
  log,
});

const pace = new PaceQueue({ minGapMs: 1200, jitterMs: 600, log: (m, d) => log('debug', m, d) });
const historyPace = new PaceQueue({ minGapMs: 1500, jitterMs: 1500, log: (m, d) => log('debug', m, d) });
// Adding has its own queues, so a join waiting on Discord holds up neither sends nor lookups.
const lookPace = new PaceQueue({ minGapMs: 1500, jitterMs: 1000, log: (m, d) => log('debug', m, d) });
const addPace = new PaceQueue({ minGapMs: 2500, jitterMs: 1500, log: (m, d) => log('debug', m, d) });

/** events, rsvp, leave, gates, inviteLinks, nick: only those whose client modules the hook found (servers.ts serverCapabilities). */
let serverCaps: P.Capability[] = [];
/** Scheduled events, leaving, invite links, nicknames and what a server asks on joining (servers.ts). */
const servers = new ServerOps({
  bridge,
  pace,
  lookPace,
  emit: (ev) => hub.emit(ev),
  users: (users) => {
    for (const ev of userFacts(users, st)) hub.emit(ev);
  },
  caps: () => serverCaps,
  log,
});

/** Threads, forum posts, publishing, group DMs: only those whose client modules the hook found (threads.ts threadCapabilities). */
let threadCaps: P.Capability[] = [];
/** Every capability now, each once ('leave' comes from servers and threads alike). */
const allCaps = (): P.Capability[] => [...new Set([...CAPABILITIES, ...addCaps, ...serverCaps, ...threadCaps])];
/** Following threads, starting threads and posts, archiving, publishing, running a group DM (threads.ts). */
const threadOps = new ThreadOps({
  bridge,
  pace,
  emit: (ev) => hub.emit(ev),
  channel: (c) => routeChannel(c, st),
  message: (m) => messageEvents(m as any, st, false),
  users: (users) => {
    for (const ev of userFacts(users, st)) hub.emit(ev);
  },
  caps: allCaps,
  about: async (target) => aboutOf(target),
  rawAbout: readAbout,
  nonce: () => randomNonce(),
  log,
});

/** hello again when the modules found change what this account can do with threads. */
function updateThreadCapabilities() {
  const next = threadCapabilities(lastFinders);
  if (next.join() === threadCaps.join()) return;
  threadCaps = next;
  log('info', 'thread capabilities', { capabilities: next });
  hub.emit({ t: 'hello', network: 'discord', version: VERSION, capabilities: allCaps() });
}

/** The About, with what servers, threads and pins add to it. */
async function aboutOf(target: P.AboutTarget): Promise<P.About> {
  const raw = await readAbout(target);
  return servers.about(target, await withPins(withThreads(withModeration(raw, mapAbout(raw)), raw, allCaps()), target, raw));
}

let sandbox: Sandbox | null = null;

// ---------------------------------------------------------------------- boot
async function boot() {
  bridge.start();
  const wsUrl = `ws://127.0.0.1:${bridge.port}/`;
  sandbox = new Sandbox({
    accountDir: hub.accountDir,
    display,
    width: WIDTH,
    height: HEIGHT,
    wsUrl,
    token: bridgeToken,
    startUrl,
    noSandbox: !!hub.config.noSandbox || process.env.DITHER_CHROMIUM_NO_SANDBOX === '1',
    lab: hub.config.lab === true && process.env.DITHER_LAB === '1',
    log,
  });

  // Report the live view immediately so the "Needs you" card can open it.
  setStatus('connecting', null);

  try {
    await sandbox.start();
    sandboxUp = true;
  } catch (e: any) {
    log('error', 'sandbox failed to start', String(e?.message ?? e));
    sandboxError = String(e?.message ?? e).slice(0, 300);
    setStatus('error', { kind: 'unknown', message: `Sandbox failed: ${String(e?.message ?? e)}`, liveView: false });
    return;
  }
  pushStatus();

  const secret = hub.secret<{ token?: string; email?: string; password?: string }>();
  if (secret.token || secret.password) {
    // Auto-login is intentionally not wired up in this build; the user logs in
    // once through the live view and the persistent profile keeps the session.
    log('info', 'secret.json present, but auto-login is not enabled; log in via the live view once');
  }

  // Watchdog: if Chromium dies, surface it; the hub supervisor will restart us.
  const watch = setInterval(() => {
    if (sandbox && !sandbox.browserAlive) {
      clearInterval(watch);
      log('warn', 'chromium exited; adapter will exit for a supervised restart');
      void shutdownAndExit(1);
    }
  }, 5000);
}

// ------------------------------------------------------------- bridge handling
function handleBridge(msg: BridgeUp) {
  switch (msg.t) {
    case 'ready':
      log('info', 'extension service worker ready');
      break;
    case 'log':
      hub.log(msg.level, `[hook] ${msg.msg}`, msg.data);
      break;
    case 'finders':
      lastFinders = msg.results;
      gotFinders = true;
      log('info', 'finder results', { results: msg.results, detail: msg.detail });
      evaluateHealth();
      updateAddCapabilities();
      updateServerCapabilities();
      updateThreadCapabilities();
      break;
    case 'page':
      lastPage = msg.state;
      onPageState(msg.state);
      break;
    case 'connection':
      log('info', `discord gateway ${msg.open ? 'open' : 'closed'}`);
      break;
    case 'snapshot':
      ingestSnapshot(msg.data);
      void servers.syncEvents();
      break;
    case 'identities':
      for (const u of msg.users) hub.emit({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
      break;
    case 'dispatch':
      // Calls ringing you and voice channels (calls.ts) first: they are the hook's own events, not the gateway's.
      if (CALL_EVENTS.has(msg.event)) {
        emitFacts(callEvents(msg.event, msg.data, callMem, st.selfId));
        break;
      }
      // An interaction's outcome and a form a bot opened (interact.ts): the hook's own events.
      if (INTERACT_DISPATCHES.has(msg.event)) {
        const { users, events } = interactDispatch(msg.event, msg.data);
        for (const ev of userFacts(users, st)) hub.emit(ev);
        for (const ev of events) hub.emit(ev);
        break;
      }
      // This account's own thread membership, and posts the client's own views loaded (threads.ts).
      if (THREAD_DISPATCHES.has(msg.event)) {
        emitFacts(threadDispatch(msg.event, msg.data, { channel: (c) => routeChannel(c, st), message: (m) => messageEvents(m as any, st, false) }));
        break;
      }
      // Saved messages and reminders (sending.ts).
      if (SENDING_DISPATCHES.has(msg.event)) {
        for (const ev of sendingDispatch(msg.event, msg.data, st)) hub.emit(ev);
        break;
      }
      if (SERVER_DISPATCHES.has(msg.event)) {
        for (const ev of serverDispatch(msg.event, msg.data)) hub.emit(ev);
        break;
      }
      // A server just joined brings its events with it.
      if (msg.event === 'GUILD_CREATE' && msg.data?.guild?.id) void servers.syncEvents(msg.data.guild.id);
      emitFacts(RELATIONSHIP_EVENTS.has(msg.event) ? relationshipEvents(msg.event, msg.data, st) : translateDispatch(msg.event, msg.data, st));
      emitFacts(attentionDispatch(msg.event, msg.data, st, att, (why) => mentions.want(why)));
      tellHeldPins();
      break;
    case 'loginIssue':
      onLoginIssue(msg);
      break;
    case 'self':
      onSelf(msg);
      break;
    case 'call':
      for (const u of msg.users ?? []) hub.emit({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
      hub.emit({
        t: 'call',
        call: msg.call,
        ...(msg.signal !== undefined ? { signal: msg.signal } : {}),
        ...(msg.state ? { state: { conversation: msg.state.channelId, participants: msg.state.participants, ...(msg.state.stage ? { stage: msg.state.stage } : {}) } } : {}),
        ...(msg.ended ? { ended: msg.ended } : {}),
        ...(msg.effect ? { effect: msg.effect } : {}),
      });
      break;
  }
}

let pinTimer: ReturnType<typeof setTimeout> | null = null;

/** A pin waits a moment for the message saying who pinned it; told without that once the wait is over. */
function tellHeldPins() {
  if (pinTimer || !st.changes.held.size) return;
  pinTimer = setTimeout(() => {
    pinTimer = null;
    for (const ev of duePins(st.changes, Date.now())) hub.emit(ev);
    tellHeldPins();
  }, PIN_HOLD_MS + 100);
}

/** Why the last sign-in failed, in words, for the account card. The page itself just starts over. */
let loginNote: string | null = null;

function onLoginIssue(i: Extract<BridgeUp, { t: 'loginIssue' }>) {
  log('warn', `sign-in: ${i.route} answered ${i.status}${i.captcha ? ` captcha ${i.captcha}` : ''}${i.message ? `: ${i.message}` : ''}`);
  if (i.route.includes('remote-auth') && /ticket/i.test(i.message ?? '')) {
    loginNote = "Discord's QR ticket ran out while the captcha was open, so the page started over. Sign in with email and password instead: there is no ticket to run out, and you can paste into the live view.";
  } else if (i.captcha === 'invalid-response') {
    loginNote = 'Discord rejected the captcha answer and asked for another. Open the live view to finish it.';
  } else return;
  if (lastPage === 'login') onPageState('login');
}

function onPageState(state: PageState) {
  if (state === 'captcha') setStatus('attention', { kind: 'captcha', message: 'A captcha is on screen. Open the live view to solve it.', liveView: true });
  else if (state === 'verify') setStatus('attention', { kind: 'verify', message: 'Discord wants to verify this login. Open the live view.', liveView: true });
  else if (state === 'login') setStatus('attention', { kind: 'login', message: loginNote ?? 'Not logged in. Open the live view and sign in.', liveView: true });
  else if (state === 'crashed') setStatus('attention', { kind: 'unknown', message: 'The Discord page failed to load and is reloading. Open the live view if it stays stuck.', liveView: true });
  else if (state === 'app') {
    if (gotFinders && evaluateHealth()) return;
    // Logged in; wait for the snapshot before claiming 'online'.
    if (snapshotReceived) setStatus('online', null);
    else if (status !== 'online') setStatus('connecting', null);
  }
}

/** If we are logged in but core modules did not resolve, the client changed on us. Returns true if broken. */
function evaluateHealth(): boolean {
  if (lastPage !== 'app') return false;
  const critical = ['Dispatcher', 'ChannelStore', 'MessageActions'];
  const broken = critical.filter((k) => !lastFinders[k]);
  if (broken.length) {
    setStatus('attention', { kind: 'selector_broken', message: `Discord changed; these hooks no longer resolve: ${broken.join(', ')}`, detail: lastFinders, liveView: true });
    return true;
  }
  // A later report (modules from a lazy chunk) can clear an earlier failure.
  if (attention?.kind === 'selector_broken') setStatus(snapshotReceived ? 'online' : 'connecting', null);
  return false;
}

// ------------------------------------------------------------------- snapshot
function ingestSnapshot(data: Parameters<typeof translateSnapshot>[0]) {
  snapshotReceived = true;
  if (data.self) selfUser = data.self;
  const { events, backfillTargets, newest } = translateSnapshot(data, st);
  for (const ev of events) hub.emit(ev);
  // Message requests and spam DMs, and where mutes start from (attention.ts); then recent mentions, soon.
  emitFacts(attentionSnapshot(data, st, att));
  mentions.want('snapshot');
  // The friend requests waiting, after the identities of who asked: the whole list, once the hook says it is. Then the
  // friends, blocks and requests sent, after everyone's identity, at the same moment.
  emitFacts(snapshotRequests(data, st));
  emitFacts(snapshotRelationships(data, st));
  setStatus('online', null);
  log('info', 'snapshot ingested', { guilds: st.guilds.size, conversations: st.known.size, friends: st.friends.size });
  void startupBackfill(backfillTargets, newest);
}

const backfilled = new Set<string>();
/** What earlier starts fetched (backfill.ts), in the account's directory. */
let backfillMemory: BackfillMemory | null = null;

/**
 * Fetch only recent messages for the given channels (DMs + unread mentions); everything else loads lazily. Every
 * reconnect re-sends the snapshot, so each channel only once per process; and a channel fetched by an earlier start
 * whose newest message has not changed since (`newest`, from the snapshot) is skipped (backfill.ts).
 */
async function startupBackfill(targets: string[], newest: Record<string, string>) {
  backfillMemory ??= new BackfillMemory(join(hub.accountDir, BACKFILL_FILE));
  const memory = backfillMemory;
  const fresh = targets.filter((id) => !backfilled.has(id) && memory.fresh(id, newest[id]));
  for (const id of fresh) backfilled.add(id);
  const todo = targets.filter((id) => !backfilled.has(id)).slice(0, 40);
  for (const id of todo) backfilled.add(id);
  for (const channelId of todo) {
    try {
      await historyPace.run('backfill', async () => {
        const res = await bridge.request<{ messages: any[] }>({ kind: 'history', channelId, limit: 20 }, 30_000);
        for (const raw of res.messages ?? []) for (const ev of messageEvents(raw, st, false)) hub.emit(ev);
        memory.record(channelId, (res.messages ?? []).map((m) => m?.id).filter((id): id is string => typeof id === 'string'), newest[channelId]);
      });
    } catch (e) {
      log('debug', 'backfill failed', { channelId, error: String(e) });
    }
  }
  if (todo.length || fresh.length) log('info', 'startup backfill complete', { channels: todo.length, unchanged: fresh.length });
}

// ------------------------------------------------------------- hub -> adapter
/** A command the manager sent with its traceparent is a span of its own, sent up when done (trace.ts). */
function commandTraced(cmd: P.AdapterCommand): Promise<unknown> {
  return traced(cmd.t, (cmd as { trace?: unknown }).trace, (r) => hub.log('info', 'trace', r), () => onCommand(cmd));
}

async function onCommand(cmd: P.AdapterCommand): Promise<unknown> {
  switch (cmd.t) {
    case 'send': {
      const nonce = randomNonce();
      // A recording sent as Discord's voice message: one Ogg Opus file, named as the client names its own.
      const voice = voiceOut(cmd.attachments);
      const files = cmd.attachments?.map((f) => ({ name: voice ? 'voice-message.ogg' : f.name, mime: f.mime, size: f.size, base64: readFileSync(f.path).toString('base64') }));
      if (cmd.sticker && !/^\d{5,25}$/.test(cmd.sticker)) throw new Error('That is not a Discord sticker');
      const hc: HookCommand = {
        kind: 'send',
        channelId: cmd.conversation,
        content: cmd.body,
        replyTo: cmd.replyTo,
        nonce,
        ...(files?.length ? { files } : {}),
        ...(cmd.sticker ? { stickerIds: [cmd.sticker] } : {}),
        ...(voice ? { voice } : {}),
        ...(cmd.silent ? { silent: true } : {}),
        ...(cmd.replyTo && cmd.mentionReplied === false ? { mentionReplied: false } : {}),
      };
      const r = await pace.run('send', () => bridge.request<{ nativeId: string | null }>(hc, files?.length ? 170_000 : 30_000));
      return { nativeId: r?.nativeId ?? null };
    }
    case 'forward': {
      const hc: HookCommand = { kind: 'forward', channelId: cmd.conversation, source: { channelId: cmd.source.conversation, messageId: cmd.source.message }, note: cmd.note, nonce: randomNonce() };
      const r = await pace.run('send', () => bridge.request<{ nativeId: string | null }>(hc, 30_000));
      return { nativeId: r?.nativeId ?? null };
    }
    case 'openDirect': {
      if (cmd.peer === st.selfId) throw new Error('that is this account');
      const r = await pace.run('openDirect', () => bridge.request<{ channelId: string; existed: boolean; channel?: RawChannel | null }>({ kind: 'openDirect', userId: cmd.peer }, 30_000));
      for (const ev of openedDirect(cmd.peer, r, st)) hub.emit(ev);
      return { conversation: r.channelId, existed: r.existed } satisfies P.OpenDirectResult;
    }
    case 'history': {
      const beforeId = cmd.beforeTs ? tsToSnowflake(cmd.beforeTs) : undefined;
      const r = await historyPace.run('history', () => bridge.request<{ messages: any[] }>({ kind: 'history', channelId: cmd.conversation, limit: cmd.limit, beforeId }, 45_000));
      const messages = r?.messages ?? [];
      for (const raw of messages) for (const ev of messageEvents(raw, st, false)) hub.emit(ev);
      const oldest = oldestOf(messages);
      return { count: messages.length, done: messages.length < cmd.limit, ...(oldest !== undefined ? { oldest } : {}) } satisfies P.HistoryResult;
    }
    case 'search': {
      // Discord's search is rate-limited hard: on the history pace, never two at once. Facts first, then the reply.
      const hc = searchCommand(cmd);
      const raw = await historyPace.run('search', () => bridge.request<RawSearch>(hc, 45_000));
      const { events, result } = searchOutcome(raw ?? {}, cmd, st);
      for (const ev of events) hub.emit(ev);
      if (result.retryAfterMs) log('info', 'search: Discord is still indexing this place', { retryAfterMs: result.retryAfterMs });
      return result;
    }
    case 'threads': {
      // A channel's threads for an index job, archived ones too: facts for each, then how many and whether more.
      if (cmd.mine && !threadCaps.includes('myThreads')) throw new Error("Listing your private threads isn't available: the hook did not find Discord's REST client (Discord changed?)");
      const r = await historyPace.run('threads', () => bridge.request<{ threads: RawChannel[]; more: boolean; indexing?: number | null; messages?: any[] }>({ kind: 'threads', channelId: cmd.conversation, archived: cmd.archived, offset: cmd.offset, ...(cmd.mine ? { mine: true } : {}) }, 45_000));
      // 202: Discord is still indexing this channel's threads; the hub asks the same again after the wait.
      if (r && r.indexing !== undefined) return { count: 0, more: false, retryAfterMs: Number(r.indexing) > 0 ? Math.ceil(Number(r.indexing) * 1000) : 5000 } satisfies P.ThreadsResult;
      const list = (r?.threads ?? []).filter((c) => c?.id);
      for (const c of list) for (const ev of routeChannel(c, st)) hub.emit(ev);
      // Each thread's first and latest message, as the page brought them (a forum's post previews).
      for (const raw of r?.messages ?? []) for (const ev of messageEvents(raw, st, false)) hub.emit(ev);
      return { count: list.length, more: !!r?.more, ids: list.map((c) => c.id) } satisfies P.ThreadsResult;
    }
    case 'walkMembers': {
      // One gateway member query (the hub widens the prefix); about one a second is plenty.
      const raw = await pace.run('walkMembers', () => bridge.request<RawWalk>(walkCommand(cmd), 20_000));
      const { events, result } = walkOutcome(raw ?? { guildId: cmd.space, members: [] }, cmd, st);
      for (const ev of events) hub.emit(ev);
      return result;
    }
    case 'mentionables': {
      // From the client's stores, and for letters typed in a server the member search its own @ list makes: not paced,
      // as typing is not (the hub keeps answers a minute). Nothing is emitted (mentionables.ts).
      const raw = await bridge.request<RawMentionables>(mentionablesCommand(cmd), 10_000);
      return mapMentionables(raw, cmd.query, cmd.limit);
    }
    case 'markRead':
      return pace.run('markRead', () => bridge.request({ kind: 'markRead', channelId: cmd.conversation, messageId: cmd.upTo }, 20_000));
    case 'typing':
      // Not paced: it must not wait behind reads, and the client throttles it itself.
      return bridge.request({ kind: 'typing', channelId: cmd.conversation, ...(cmd.stop ? { stop: true } : {}) }, 10_000);
    case 'react': {
      const burst = cmd.style === 'super';
      await pace.run('react', () => bridge.request({ kind: 'react', channelId: cmd.conversation, messageId: cmd.message, emoji: cmd.key, remove: cmd.remove, burst }, 20_000));
      // Discord pushes nothing for server channels that are not open in the client, so say it ourselves.
      hub.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: st.selfId, key: cmd.key, ...(cmd.remove ? { remove: true } : {}), ...(burst ? { style: 'super' as const } : {}), ...(cmd.emoji ? { emoji: cmd.emoji } : {}) });
      return {};
    }
    case 'reactors': {
      const res = await historyPace.run('reactors', () => bridge.request<{ users: RawUser[] }>({ kind: 'reactors', channelId: cmd.conversation, messageId: cmd.message, emoji: cmd.key, burst: cmd.style === 'super' }, 20_000));
      for (const ev of userFacts(res.users ?? [], st)) hub.emit(ev);
      return { authors: (res.users ?? []).map((u) => u.id) };
    }
    case 'stickers': {
      const offset = Math.max(0, Number(cmd.cursor ?? 0) || 0);
      const r = await bridge.request<RawStickerPage>({ kind: 'stickers', channelId: cmd.conversation, offset, limit: STICKER_PAGE_PACKS }, 15_000);
      return stickerPageOf(r);
    }
    case 'reactionContext': {
      const r = await bridge.request<RawReactionContext>({ kind: 'reactionContext', channelId: cmd.conversation }, 10_000);
      return {
        canReact: r.canReact,
        reason: r.reason,
        existingOnly: r.existingOnly,
        custom: r.custom.map((g) => ({ id: g.guild.id, name: g.guild.name, icon: guildIconUrl(g.guild), emoji: g.emoji.map((e) => customEmoji(e)!) })),
        super: r.nitro ? { available: true } : { available: false, reason: 'Super reactions need Discord Nitro.' },
        // Manage Messages here: others' messages and reactions (moderation.ts).
        ...((r as { manageMessages?: boolean }).manageMessages === true ? { moderation: { delete: true, reactions: true } } : {}),
      } satisfies P.ReactionContext;
    }
    case 'about':
      return aboutOf(cmd.target);
    case 'pollVote':
      return polls.vote(cmd);
    case 'pollCreate':
      return polls.create(cmd);
    case 'pollEnd':
      return polls.end(cmd);
    case 'configure': {
      // Pins (polls.ts): the pin button's request, where the About's rules say this account may.
      if (cmd.change.key === 'pin') {
        await polls.pin(cmd.target, cmd.change, cmd.target.kind === 'conversation' ? pinRight(await readAbout(cmd.target)) : undefined);
        return aboutOf(cmd.target);
      }
      // A server's invite links (servers.ts): checked against its About, then the client's own invite actions.
      if (cmd.change.key === 'invite' && serverCaps.includes('inviteLinks')) return servers.invite(cmd.target, cmd.change, async () => servers.about(cmd.target, mapAbout(await readAbout(cmd.target))));
      // Refused here, before any request, unless the client's stores say this account may.
      const plan = configurePlan(await readAbout(cmd.target), cmd.change, cmd.change.key === 'avatar' ? pictureDataUri(cmd.change.value) : undefined);
      const r = await pace.run('configure', () => bridge.request<{ channel?: RawChannel | null; guild?: RawGuild | null }>({ kind: 'configure', ...plan }, 20_000));
      for (const ev of changedFacts(r ?? {}, st)) hub.emit(ev);
      const after = await readAbout(cmd.target);
      return servers.about(cmd.target, withThreads(withChange(withModeration(after, mapAbout(after)), cmd.change), after, allCaps()));
    }
    case 'moderate': {
      // Checked against the About from the same read, then again in the hook against the client's own checks.
      const raw = await readAbout(cmd.target);
      const plan = moderatePlan(raw, withModeration(raw, mapAbout(raw)), cmd.action);
      const r = await pace.run('moderate', () => bridge.request<{ ok?: boolean }>(plan, 30_000));
      if (!r?.ok) throw new Error('Discord did not say it was done');
      return aboutOf(cmd.target);
    }
    case 'bans': {
      const raw = await readAbout(cmd.target);
      if (!raw.guild) throw new Error('Only a server has a Bans list.');
      const { users, result } = bansOutcome(await historyPace.run('bans', () => bridge.request<any>({ kind: 'bans', guildId: raw.guild!.id }, 30_000)));
      for (const ev of userFacts(users, st)) hub.emit(ev);
      return result;
    }
    case 'clearReactions': {
      await pace.run('clearReactions', () => bridge.request(clearPlan(cmd.conversation, cmd.message, cmd), 20_000));
      // Discord pushes nothing for channels not open in the client, so say it ourselves.
      if (cmd.who) hub.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: cmd.who, key: cmd.key!, remove: true });
      else hub.emit({ t: 'reactionsCleared', conversation: cmd.conversation, message: cmd.message, ...(cmd.key ? { key: cmd.key } : {}) });
      return {};
    }
    case 'scheduledEvents':
      return servers.scheduledEvents(cmd.space);
    case 'rsvp':
      return servers.rsvp(cmd);
    case 'leave':
      // A group DM or a DM (threads.ts); a server (servers.ts).
      return cmd.target.kind === 'conversation' ? threadOps.leaveConversation(cmd) : servers.leave(cmd);
    case 'followThread':
      return threadOps.follow(cmd);
    case 'threadNotify':
      return threadOps.notify(cmd);
    case 'threadState':
      return threadOps.state(cmd);
    case 'createThread':
      return threadOps.createThread(cmd);
    case 'createPost': {
      const raw = await readAbout({ kind: 'conversation', nativeId: cmd.conversation });
      return threadOps.createPost(cmd, raw.channel ? (mapForum(raw.channel) ?? null) : null);
    }
    case 'crosspost':
      return threadOps.crosspost(cmd);
    case 'removeMember':
    case 'setOwner':
      return threadOps.member(cmd);
    case 'setPicture':
      return threadOps.picture(cmd);
    case 'gate':
      return servers.gate(cmd.space);
    case 'answerGate':
      return servers.answerGate(cmd.space, cmd.answer);
    case 'setNick':
      return servers.setNick(cmd.space, cmd.nick, async () => servers.about({ kind: 'space', nativeId: cmd.space }, mapAbout(await readAbout({ kind: 'space', nativeId: cmd.space }))));
    case 'addMembers':
      return addMembers(cmd.target, cmd.people);
    case 'createGroup':
      return createGroup(cmd.name, cmd.people);
    case 'profile': {
      // The client's own profile fetch, as a click on them runs it; identity facts for everyone it names first.
      const raw = await historyPace.run('profile', () => bridge.request<RawProfile>({ kind: 'profile', userId: cmd.who }, 30_000));
      if (raw.error) log('info', 'profile fetch failed; answering with what the client still had', { error: raw.error });
      for (const ev of userFacts(profileUsers(raw), st)) hub.emit(ev);
      // Your note on them, as the network keeps it (contactNotes): the hub joins it with yours (self.ts).
      const note = addCaps.includes('contactNotes') ? noteFact(raw, cmd.who) : null;
      if (note) hub.emit(note);
      return mapProfile(raw, cmd.who);
    }
    case 'setProfile': {
      // Your name, picture, pronouns or banner too: the self path (self.ts), which also takes the bio.
      if (moreThanBio(cmd.change)) return setProfileMore(cmd.change);
      // Checked here before any request; then the client's own save, and your profile as it now stands.
      const bio = checkBio(cmd.change.bio);
      const raw = await pace.run('setProfile', () => bridge.request<RawProfile>({ kind: 'setProfile', bio }, 30_000));
      if (raw.error) log('info', 'bio saved, but reading the profile back failed', { error: raw.error });
      for (const ev of userFacts(profileUsers(raw), st)) hub.emit(ev);
      return mapProfile(raw, raw.selfId ?? st.selfId);
    }
    case 'edit':
      return pace.run('edit', () => bridge.request({ kind: 'edit', channelId: cmd.conversation, messageId: cmd.message, content: cmd.body }, 20_000));
    case 'redact':
      // Someone else's, as a moderator: the hook checks Manage Messages first.
      if (cmd.moderator) return pace.run('redact', () => bridge.request({ kind: 'modRedact', channelId: cmd.conversation, messageId: cmd.message }, 20_000));
      return pace.run('redact', () => bridge.request({ kind: 'redact', channelId: cmd.conversation, messageId: cmd.message }, 20_000));
    case 'fetchMedia':
      return fetchMedia(cmd.url);
    case 'call': {
      const { t: _t, id: _id, conversation, ...rest } = cmd as P.AdapterCommand & { t: 'call'; conversation?: string };
      const hc = { kind: 'call', ...rest, ...(conversation ? { channelId: conversation } : {}) } as HookCommand;
      return bridge.request(hc, cmd.op === 'join' ? 40_000 : 15_000);
    }
    case 'declineCall':
      // Not paced: a ring waits for nobody. The client's own Decline.
      if (!addCaps.includes('declineCall')) throw new Error("Declining isn't available: the hook did not find Discord's call module (Discord changed?)");
      return bridge.request({ kind: 'declineCall', channelId: cmd.conversation }, 15_000);
    case 'resolve':
      return resolveRef(cmd.ref);
    case 'add':
      return addRef(cmd.ref, cmd.action, cmd.confirm === true);
    case 'answer':
      return answerRequest(cmd.request, cmd.answer, cmd.confirm === true);
    case 'remove':
      return removeRelationship(cmd.identity, cmd.relationship);
    case 'lab':
      if (process.env.DITHER_LAB !== '1') throw new Error('not a lab hub');
      return bridge.request({ ...cmd.lab, kind: 'lab' } as HookCommand, cmd.timeout ?? 30_000);
    case 'action':
      return handleAction(cmd.action, cmd.args);
    case 'block':
    case 'ignore':
    case 'setContact':
    case 'setPresence':
    case 'sessions':
      return selfCommand(cmd);
    case 'mute':
    case 'markUnread':
    case 'markReadMany':
      return attentionCommand(cmd);
    case 'appCommands':
    case 'appAutocomplete':
    case 'interact':
      return interactCommand(cmd);
    case 'suppressEmbeds':
    case 'save':
    case 'savedList':
    case 'nativeScheduled':
    case 'cancelScheduled':
      return sendingCommand(cmd);
    default:
      throw new Error(`unsupported command ${(cmd as any).t}`);
  }
}

// ------------------------------------------------------------------ sending extras
// Previews off, saved messages and reminders, Discord's own scheduled messages (sending.ts; dither-chat's
// docs/sending.md). Each is the owner's click on the hub, run once through the client's own modules.
async function sendingCommand(cmd: P.SendCommand): Promise<unknown> {
  const caps = sendingCapabilities(lastFinders);
  const need = cmd.t === 'suppressEmbeds' ? 'suppressEmbeds' : cmd.t === 'nativeScheduled' || cmd.t === 'cancelScheduled' ? 'nativeScheduled' : 'savedMessages';
  if (!caps.includes(need)) throw new Error("That isn't available: the hook did not find Discord's own module for it (Discord changed?)");
  const hc = sendingHookCommand(cmd);
  switch (cmd.t) {
    case 'savedList': {
      const raw = await historyPace.run('savedList', () => bridge.request<any>(hc, 30_000));
      const { events, result } = savedListOutcome(raw, st);
      for (const ev of events) hub.emit(ev);
      return result;
    }
    case 'nativeScheduled':
      return nativeScheduledOutcome(await historyPace.run('nativeScheduled', () => bridge.request<any>(hc, 30_000)));
    case 'save': {
      const raw = await pace.run('save', () => bridge.request<any>(hc, 20_000));
      const out = sendingDispatch('SAVED_MESSAGE_CREATE', { saved: raw && raw.message_id ? [raw] : [] }, st);
      for (const ev of out) if (ev.t !== 'saved') hub.emit(ev);
      const saved = out.find((ev): ev is Extract<P.AdapterEvent, { t: 'saved' }> => ev.t === 'saved');
      return cmd.remove ? {} : (saved?.saved[0] ?? {});
    }
    default:
      return pace.run(cmd.t, () => bridge.request(hc, 20_000));
  }
}

// ------------------------------------------------------------------ adding
// Joining from invites, adding friends, answering friend requests, ending relationships (add.ts; dither-chat's
// docs/add.md). Each comes from the owner's click on the hub and runs once: nothing retries it, and nothing confirms
// for the owner (a confirm goes along only on the command they send again with it). Facts first, then the reply.

/** The events of a fact batch, leaving out request and relationship events while the account does not say it has them. */
function emitFacts(events: P.AdapterEvent[]) {
  const requests = addCaps.includes('requests');
  const relationships = addCaps.includes('relationships');
  for (const ev of events) {
    if (!requests && isRequestEvent(ev)) continue;
    if (!relationships && isRelationshipEvent(ev)) continue;
    hub.emit(withMessageRequests(ev, att));
  }
}

function needCapability(cap: P.Capability, what: string) {
  if (!addCaps.includes(cap)) throw new Error(`${what} isn't available: the hook did not find Discord's own module for it (Discord changed?)`);
}

/** hello again when the modules found change what this account can do; the request and relationship lists once they come in. */
function updateAddCapabilities() {
  // With the call, attention, self, sending, poll, pin and bots-and-apps capabilities, from the same finders (calls.ts, attention.ts, self.ts, sending.ts, polls.ts, interact.ts).
  const next = [...addCapabilities(lastFinders), ...callCapabilities(lastFinders), ...attentionCapabilities(lastFinders), ...selfCapabilities(lastFinders), ...sendingCapabilities(lastFinders), ...pollCapabilities(lastFinders), ...interactCapabilities(lastFinders), ...mentionCapabilities(lastFinders)];
  if (next.join() === addCaps.join()) return;
  const gained = next.filter((c) => !addCaps.includes(c));
  addCaps = next;
  log('info', 'adding capabilities', { capabilities: next });
  hub.emit({ t: 'hello', network: 'discord', version: VERSION, capabilities: allCaps() });
  if (gained.includes('requests')) emitFacts(requestsEvent(st));
  if (gained.includes('relationships')) emitFacts(relationshipsEvent(st));
}

/** hello again when the modules found change what this account can do with servers; their events once they can be read. */
function updateServerCapabilities() {
  const next = serverCapabilities(lastFinders);
  if (next.join() === serverCaps.join()) return;
  const gained = next.filter((c) => !serverCaps.includes(c));
  serverCaps = next;
  log('info', 'server capabilities', { capabilities: next });
  hub.emit({ t: 'hello', network: 'discord', version: VERSION, capabilities: allCaps() });
  if (gained.includes('events') && snapshotReceived) void servers.syncEvents();
}

/** Polls voted in, made and ended, and pins (polls.ts). */
const polls = new PollOps({
  bridge,
  pace,
  lookPace,
  emit: (ev) => hub.emit(ev),
  messages: (raw) => {
    for (const m of raw) for (const ev of messageEvents(m, st, false)) hub.emit(ev);
  },
  selfId: () => st.selfId || null,
  caps: () => addCaps,
  nonce: () => randomNonce(),
});

/** Who may pin here, as the About's rules say it: anyone in a DM or group, else Pin Messages (or Manage Messages). */
function pinRight(raw: RawAbout): P.AboutPinned {
  const c = raw.channel;
  const direct = c?.type === CHANNEL_TYPE.DM || c?.type === CHANNEL_TYPE.GROUP_DM;
  const can = direct || raw.can?.pinMessages === true || raw.can?.manageMessages === true;
  return { messages: [], canEdit: can, ...(can ? {} : { reason: 'You need the Pin Messages permission here' }) };
}

/** A channel's pinned list as Discord has it, read when its About is opened (polls.ts). */
async function withPins(about: P.About, target: P.AboutTarget, raw: RawAbout): Promise<P.About> {
  if (target.kind !== 'conversation' || !raw.channel || raw.channel.type === CHANNEL_TYPE.CATEGORY) return about;
  const right = pinRight(raw);
  try {
    const p = await polls.pinned(target.nativeId, right.canEdit, right.reason);
    return p ? { ...about, pinned: p } : about;
  } catch (e) {
    log('info', 'reading the pinned messages failed; the About goes without them', String(e));
    return about;
  }
}

async function resolveRef(ref: P.AddRef): Promise<P.AddPreview> {
  needCapability('resolve', 'Looking things up');
  const hc = resolveCommand(ref);
  if (hc.kind === 'inviteResolve') {
    needCapability('join', 'Looking up invites');
    const raw = await lookPace.run('resolve', () => bridge.request<RawInvite>(hc, 25_000));
    const { events, preview } = invitePreview(raw, st);
    emitFacts(events);
    return preview;
  }
  // From the client's stores alone: no request, so no pace.
  const raw = await bridge.request<RawPerson>(hc, 10_000);
  const { events, preview } = personPreview(raw, ref.kind === 'person' ? ref.handle : '', st);
  emitFacts(events);
  return preview;
}

async function addRef(ref: P.AddRef, action: Exclude<P.AddAction, 'message'>, confirm: boolean): Promise<P.AddResult> {
  const hc = addCommand(ref, action, confirm);
  if (hc.kind === 'inviteAccept') {
    needCapability(hc.friend ? 'connect' : 'join', hc.friend ? 'Adding friends' : 'Joining');
    needCapability('join', 'Accepting invites');
    const raw = await addPace.run('join', () => bridge.request<RawJoin>(hc, 85_000));
    const { events, result } = joinOutcome(raw, st);
    emitFacts(events);
    log('info', `add: ${hc.friend ? 'friend invite' : 'join'} ${result.check ? `wants a ${result.check} check` : 'done'}`);
    return result;
  }
  needCapability('connect', 'Adding friends');
  const raw = await addPace.run('friend', () => bridge.request<RawFriend>(hc, 50_000));
  const { events, result } = friendOutcome(raw, st, hc.kind === 'friendAdd' ? hc.userId : undefined);
  emitFacts(events);
  log('info', `add: friend request ${outcomeNote(result, result.relationship ?? '')}${confirm ? ' (confirmed by the owner)' : ''}`);
  return result;
}

/** What a log line says of an outcome: a check, Discord wanting a confirm, or what was done. */
const outcomeNote = (r: P.AddResult, done: string) => (r.check ? `wants a ${r.check} check` : r.confirm !== undefined ? 'wants the owner to confirm; nothing done' : done);

async function answerRequest(request: string, answer: P.RequestAnswer, confirm: boolean): Promise<P.AddResult> {
  if (messageRequestChannel(request)) return answerMessageRequest(messageRequestChannel(request)!, answer);
  needCapability('requests', 'Answering friend requests');
  const hc = answerCommand(request, answer, confirm);
  if (hc.kind !== 'friendAnswer') throw new Error('That request is not waiting any more');
  const raw = await addPace.run('answer', () => bridge.request<RawFriend>(hc, 50_000));
  const { events, result } = answerOutcome(raw, hc.userId, st);
  emitFacts(events);
  log('info', `answer: friend request ${outcomeNote(result, answer)}${hc.confirm ? ' (confirmed by the owner)' : ''}`);
  return result;
}

/** Unfriend, cancel a request sent, or unblock; refused when it is not what the owner saw any more. */
async function removeRelationship(identity: string, relationship: P.PersonRelationship): Promise<P.AddResult> {
  const hc = removeCommand(identity, relationship);
  needCapability('disconnect', 'Removing friends, requests and blocks');
  if (identity === st.selfId) throw new Error('That is this account');
  const raw = await addPace.run('remove', () => bridge.request<RawFriend>(hc, 50_000));
  const { events, result } = removeOutcome(raw, identity, st);
  emitFacts(events);
  log('info', `remove: ${relationship} ${outcomeNote(result, `now ${result.relationship}`)}`);
  return result;
}

/**
 * Friends added to a group DM: refused here, before any request, unless a fresh read says it is a group with room for
 * them all; then the hook's PUTs, one person at a time, on the write pace. The people added and the group with them,
 * then the About read again.
 */
async function addMembers(target: P.AboutTarget, people: string[]): Promise<P.AddMembersResult> {
  needCapability('addMembers', 'Adding people to groups');
  if (target.kind !== 'conversation') throw new Error(NOT_GROUP);
  const plan = addPlan(await readAbout(target), people);
  const r = await pace.run('addMembers', () => bridge.request<RawAddRecipients>({ kind: 'addRecipients', ...plan }, 115_000));
  const added = r.added ?? [];
  const failed = r.failed ?? [];
  for (const ev of addedFacts(plan.channelId, r, st)) hub.emit(ev);
  log('info', `addMembers: ${added.length} added, ${failed.length} refused`, failed.length ? { refused: failed.map((f) => f.reason) } : undefined);
  const about = mapAbout(withRecipients(await readAbout(target), r.users ?? []));
  return { added, ...(failed.length ? { failed } : {}), about };
}

/**
 * A new group DM with friends: checked here against GROUP_RULES before anything is asked of the client, then the
 * hook's ensurePrivateChannel on the write pace, sent once (no answer is an error, never a second group). The people
 * in it and the group with them, then the answer.
 */
async function createGroup(name: string | undefined, people: string[]): Promise<P.CreateGroupResult> {
  needCapability('createGroup', 'Making group DMs');
  const ids = [...new Set((Array.isArray(people) ? people : []).map(String))].filter((id) => id !== st.selfId);
  const title = typeof name === 'string' ? name.trim() : '';
  const problem = createGroupProblem('discord', title || undefined, ids.length);
  if (problem) throw new Error(problem);
  annotate({ people: ids.length, named: !!title });
  const r = await pace.run('createGroup', async () => {
    const sentAt = sinceStart();
    const out = await bridge.request<RawCreateGroupDM & { phases?: unknown }>({ kind: 'createGroupDM', userIds: ids, ...(title ? { name: title } : {}) }, 80_000);
    hookPhases(out.phases, sentAt);
    phase('hook answered');
    return out;
  });
  const added = r.added ?? [];
  const failed = r.failed ?? [];
  const notes = r.notes ?? [];
  for (const ev of addedFacts(r.channelId, r, st)) hub.emit(ev);
  log('info', `createGroup: ${added.length} in, ${failed.length} refused`, failed.length ? { refused: failed.map((f) => f.reason) } : undefined);
  return { conversation: r.channelId, added, ...(failed.length ? { failed } : {}), ...(notes.length ? { notes } : {}) };
}

/** Settings, members and permissions from the client's stores (no request), with identity facts for the people named first. */
/** The About from one read, with what this account may do to the members (moderation.ts). */
async function moderatedAbout(target: P.AboutTarget): Promise<P.About> {
  const raw = await readAbout(target);
  return withModeration(raw, mapAbout(raw));
}

/** A new server icon: the hub's file (a file:// URL in its upload spool) as the data URI Discord takes. */
function pictureDataUri(url: unknown): string {
  if (typeof url !== 'string' || !url.startsWith('file://')) throw new Error('which picture?');
  const bytes = readFileSync(decodeURIComponent(new URL(url).pathname));
  if (bytes.length > PICTURE_MAX) throw new Error(`A picture is at most ${PICTURE_MAX / 1024 / 1024} MB`);
  const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (!PICTURE_TYPES.includes(mime)) throw new Error('A picture is a PNG, JPEG, GIF or WebP image');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function readAbout(target: P.AboutTarget): Promise<RawAbout> {
  const raw = await bridge.request<RawAbout>({ kind: 'about', target: target.kind, id: target.nativeId }, 15_000);
  for (const ev of userFacts(aboutUsers(raw), st)) hub.emit(ev);
  // The members it had loaded anyway, passively: the hub keeps them only with its adversarial members setting.
  const seen = aboutSeenMembers(raw);
  if (seen) for (const ev of seenMembers(seen.guildId, seen.members, st, { total: seen.total })) hub.emit(ev);
  return raw;
}

// ------------------------------------------------------------------ the account itself
// Notices, presence, folders and whom you ignore, as the hook reads them (self.ts; dither-chat's docs/account-self.md),
// and block, ignore, notes, presence, sessions and your profile beyond the bio, each from the owner's click.

/** The last of each the account said, for a hub that connects again. */
const selfSaid = new Map<string, P.AdapterEvent>();
let selfAge: number | null = null;
let selfStateRaw: RawSelfUp | null = null;

function onSelf(msg: RawSelfUp) {
  if (msg.part === 'notices') {
    selfAge = typeof msg.data?.age === 'number' ? msg.data.age : null;
    // The age check is a line of the privacy facts: those again when it changed.
    if (selfStateRaw) for (const ev of selfEvents(selfStateRaw, selfAge)) say(ev);
  }
  if (msg.part === 'state') selfStateRaw = msg;
  const caps = new Set(addCaps);
  for (const ev of selfEvents(msg, selfAge)) if (ev.t !== 'ignored' || caps.has('ignore')) say(ev);
  if (msg.part === 'notices' && msg.data?.requiredAction) log('warn', `Discord wants this account to: ${msg.data.requiredAction}`);
}

function say(ev: P.AdapterEvent) {
  selfSaid.set(ev.t, ev);
  hub.emit(ev);
}

async function selfCommand(cmd: Extract<P.AdapterCommand, { t: 'block' | 'ignore' | 'setContact' | 'setPresence' | 'sessions' }>): Promise<unknown> {
  if (cmd.t === 'block') {
    // The shared block command (dither-chat people.ts): a person only, as Discord blocks no groups.
    needCapability('block', 'Blocking');
    if (cmd.target.kind !== 'identity') throw new Error('Discord blocks people, not groups: leave the group instead');
    const who = cmd.target.nativeId;
    if (who === st.selfId) throw new Error('That is this account');
    if (cmd.unblock) {
      const raw = await addPace.run('unblock', () => bridge.request<RawFriend>({ kind: 'friendRemove', userId: who, type: 2 }, 50_000));
      const { events, result } = removeOutcome(raw, who, st);
      emitFacts(events);
      if (result.check) throw new Error('Discord wants a check first: do it in the live view');
      log('info', `unblock: now ${result.relationship}`);
      return { blocked: result.relationship === 'blocked' };
    }
    const raw = await addPace.run('block', () => bridge.request<RawFriend>({ kind: 'selfBlock', userId: who }, 50_000));
    const { events, result } = friendOutcome(raw, st, who);
    emitFacts(events);
    if (result.check) throw new Error('Discord wants a check first: do it in the live view');
    log('info', `block: ${outcomeNote(result, result.relationship ?? '')}`);
    return { blocked: result.relationship === 'blocked' };
  }
  if (cmd.t === 'ignore') {
    needCapability('ignore', 'Ignoring people');
    if (cmd.identity === st.selfId) throw new Error('That is this account');
    const r = await addPace.run('ignore', () => bridge.request<{ ignored?: boolean }>({ kind: 'selfIgnore', userId: cmd.identity, ignored: !!cmd.ignored }, 30_000));
    return { ignored: typeof r?.ignored === 'boolean' ? r.ignored : !!cmd.ignored };
  }
  if (cmd.t === 'setContact') {
    // Your note on someone (contactNotes, as Signal's). Discord's nickname for a friend is left alone: dither neither
    // reads nor writes it (the owner's choice, dither-chat docs/chats.md).
    needCapability('contactNotes', 'Notes');
    if (cmd.note === undefined) return {};
    const note = contactNote(cmd.note);
    const r = await pace.run('setNote', () => bridge.request<{ note?: string }>({ kind: 'selfNote', userId: cmd.who, note }, 20_000));
    hub.emit({ t: 'identity', identity: { nativeId: cmd.who, note: typeof r?.note === 'string' ? r.note : note } });
    return {};
  }
  if (cmd.t === 'setPresence') {
    needCapability('setPresence', 'Setting your status');
    const hc = presenceCommand(cmd.change);
    const raw = await pace.run('setPresence', () => bridge.request<RawSelfState | null>(hc, 20_000));
    if (raw) onSelf({ t: 'self', part: 'state', data: raw });
    return presenceOf(raw);
  }
  needCapability('sessions', 'Listing where you are signed in');
  return sessionsOf(await lookPace.run('sessions', () => bridge.request<{ sessions: RawSession[] }>({ kind: 'selfSessions' }, 20_000)));
}

/** Your profile beyond the bio: checked here, the pictures read from the hub's spool, then the client's own saves. */
async function setProfileMore(change: P.ProfileChange): Promise<P.PersonAbout> {
  // What the profile's `editable` lists (profile.ts); the hub refuses anything else before it gets here.
  const hc = profileCommand(change, (path) => readFileSync(path).toString('base64'));
  const raw = await pace.run('setProfile', () => bridge.request<RawProfile>(hc, 60_000));
  if (raw.error) log('info', 'profile saved, but reading it back failed', { error: raw.error });
  for (const ev of userFacts(profileUsers(raw), st)) hub.emit(ev);
  return mapProfile(raw, raw.selfId ?? st.selfId);
}

async function handleAction(action: string, args: unknown): Promise<unknown> {
  if (action === 'refreshUrls') {
    // Attachment links are signed for about a day. The client asks Discord to sign old ones again when it shows
    // them; the hub asks the same, a batch at a time, to keep their files (args: { urls }, result: { refreshed }).
    const urls = refreshable((args as { urls?: unknown } | null)?.urls);
    if (!urls.length) return { refreshed: [] };
    const r = await historyPace.run('refreshUrls', () => bridge.request<{ refreshed: { original: string; refreshed: string }[] }>({ kind: 'refreshUrls', urls }, 30_000));
    return { refreshed: (r?.refreshed ?? []).filter((x) => x && typeof x.original === 'string' && typeof x.refreshed === 'string') };
  }
  if (action === 'guildFolders') {
    // Your server folders and their order, as the client keeps them (read from its stores: no request to Discord).
    return bridge.request({ kind: 'guildFolders' }, 10_000);
  }
  if (action === 'resync') {
    log('info', 'resync requested; reloading is manual via the live view for now');
    return { note: 'reload the tab in the live view to resync' };
  }
  return { note: `no such action: ${action}` };
}

/** cdn.discordapp.com URLs are public but signed/expiring; fetch them in-process. */
async function fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
  if (!/^https:\/\/([a-z0-9-]+\.)?discordapp\.(com|net)\//i.test(url)) {
    // Only resolve Discord CDN media here; anything else the hub fetches directly.
    throw new Error('refusing to fetch non-Discord media');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`cdn fetch failed: ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  return { mime, base64: buf.toString('base64') };
}

function tsToSnowflake(ms: number): string {
  const v = (BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n;
  return (v < 0n ? 0n : v).toString();
}

function randomNonce(): string {
  // Discord nonces are snowflake-ish strings; any unique string works for dedupe.
  return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | BigInt(Math.floor(Math.random() * 4194304)));
}

// --------------------------------------------------------------- attention
// Mentions found late, mutes on Discord, unread by hand, many read at once, message requests (attention.ts; dither-chat's
// docs/research/discord-gaps.md, "Mentions, inbox, notifications").

/**
 * Recent mentions, at a person's pace: after a snapshot (a start or a reconnect) and when the notification center says
 * something came, one request for all of them, never more often than every few minutes, and on the history pace.
 */
const mentions = new MentionsPacer(async (reasons) => {
  if (!addCaps.includes('mentions') || !bridge.connected) return;
  try {
    const r = await historyPace.run('mentions', () => bridge.request<{ via: string; messages?: any[]; channels?: RawChannel[] }>({ kind: 'recentMentions', limit: 25 }, 30_000));
    // Through the client's own action, its answer comes as LOAD_RECENT_MENTIONS_SUCCESS (attentionDispatch); through REST, here.
    if (r?.via === 'rest') emitFacts(mentionEvents(r.messages ?? [], r.channels ?? [], st, att));
    log('debug', 'recent mentions asked', { reasons, via: r?.via });
  } catch (e) {
    log('info', 'recent mentions failed', { reasons, error: String(e) });
  }
});

async function attentionCommand(cmd: Extract<P.AdapterCommand, { t: 'mute' | 'markUnread' | 'markReadMany' }>): Promise<unknown> {
  switch (cmd.t) {
    case 'mute': {
      needCapability('mute', 'Muting on Discord');
      const raw = await pace.run('mute', () => bridge.request<RawMuted>(muteHookCommand(cmd), 20_000));
      const { events, mute } = muteOutcome(raw, cmd.target, st, att);
      emitFacts(events);
      log('info', `mute: ${cmd.target.kind} ${cmd.muted ? (cmd.until ? 'muted for a while' : 'muted') : 'unmuted'}`);
      return mute;
    }
    case 'markUnread':
      needCapability('markUnread', 'Marking unread on Discord');
      await pace.run('markUnread', () => bridge.request(markUnreadHookCommand(cmd.conversation, cmd.from), 20_000));
      return {};
    case 'markReadMany': {
      needCapability('markReadMany', 'Marking many read on Discord');
      const hc = markReadManyHookCommand(cmd.items);
      return pace.run('markReadMany', () => bridge.request<{ marked: number }>(hc, 30_000));
    }
  }
}

/** A message request or spam DM answered with the client's own buttons; then it is gone, and an accepted one opens. */
async function answerMessageRequest(channelId: string, answer: P.RequestAnswer): Promise<P.AddResult> {
  needCapability('requests', 'Answering message requests');
  await addPace.run('answer', () => bridge.request({ kind: 'messageRequestAnswer', channelId, answer }, 50_000));
  const { events, result } = messageAnswerOutcome(channelId, answer, att);
  emitFacts(events);
  log('info', `answer: message request ${answer}`);
  return result;
}

// ----------------------------------------------------------------- lifecycle
function onConnect() {
  hub.emit({ t: 'hello', network: 'discord', version: VERSION, capabilities: allCaps() });
  pushStatus();
  // The hub keeps its lists until a `requests` or `relationships` comes; after a reconnect, ours are the whole lists again.
  emitFacts(requestsEvent(st));
  emitFacts(relationshipsEvent(st));
  // What the account said of itself, again: the hub keeps it, but one that lost it has it back.
  for (const ev of selfSaid.values()) hub.emit(ev);
}

async function onShutdown() {
  await cleanup();
}

async function cleanup() {
  try {
    bridge.stop();
  } catch {}
  try {
    await sandbox?.stop();
  } catch {}
}

async function shutdownAndExit(code: number) {
  await cleanup();
  process.exit(code);
}

process.on('SIGTERM', () => void shutdownAndExit(0));
process.on('SIGINT', () => void shutdownAndExit(0));

boot().catch((e) => {
  log('error', 'adapter boot failed', String(e?.message ?? e));
  void shutdownAndExit(1);
});

// ------------------------------------------------------------- bots and apps
// A bot's buttons and selects, its slash commands and apps' message commands, and the forms it opens (interact.ts;
// dither-chat's docs/apps.md). Not paced: each is one click of the owner's, which goes when it is made, and none is
// retried. The command list comes from the client's own index, which loads once per place.

async function interactCommand(cmd: Extract<P.AdapterCommand, { t: 'appCommands' | 'appAutocomplete' | 'interact' }>): Promise<unknown> {
  switch (cmd.t) {
    case 'appCommands': {
      const kind = cmd.kind ?? 'chat';
      needCapability(kind === 'chat' ? 'interactCommands' : 'interactContext', kind === 'chat' ? 'Slash commands' : 'Apps');
      if (kind === 'user') throw new Error('User commands are not built yet');
      const raw = await bridge.request<RawCommands>({ kind: 'ixCommands', channelId: cmd.conversation, commandKind: kind }, 20_000);
      const { users, result } = commandsOutcome(raw ?? { commands: [], apps: [] });
      for (const ev of userFacts(users, st)) hub.emit(ev);
      return result;
    }
    case 'appAutocomplete':
      needCapability('interactCommands', 'Suggestions');
      return bridge.request<P.AppAutocompleteResult>({ kind: 'ixSuggest', channelId: cmd.conversation, commandId: cmd.command, app: cmd.app, options: cmd.options ?? [], focused: cmd.focused, query: cmd.query }, 15_000);
    case 'interact': {
      needCapability(interactCapability(cmd.interaction), cmd.interaction?.kind === 'modal' ? 'Sending forms' : cmd.interaction?.kind === 'component' ? 'Pressing buttons' : 'Running commands');
      const r = await bridge.request<P.InteractResult>(interactHookCommand(cmd), 30_000);
      log('info', `interact: ${cmd.interaction.kind} sent`, { nonce: r?.nonce });
      return { nonce: String(r?.nonce ?? '') } satisfies P.InteractResult;
    }
  }
}
