/**
 * extractors/discord as one process of it runs, minus the sandbox: its real in-page hook (src/extension/hook.js) in a
 * replica of the Discord web client whose REST module, message actions and gateway are a fake Discord's
 * (fake-discord.ts), and the extractor's own code on the other side of the bridge: hook commands made from the hub's
 * commands as main.ts makes them, pins through PollOps (polls.ts), and each dispatch the hook forwards turned into
 * facts by translateDispatch (ingest.ts), held pins told by duePins (changes.ts), as main.ts does.
 *
 * main.ts itself cannot run here (it starts a sandbox and links to a hub at import); `command()` below mirrors its
 * onCommand for the commands the parity suite sends (send, edit, redact, react, configure's pin), and `onUp` its
 * handleBridge for snapshots and dispatches. Keep them in step with it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { markerName, stampMarkers } from '../../packages/browser/src/markers.ts';
import { duePins, PIN_HOLD_MS } from '../../extractors/discord/src/changes.ts';
import type { BridgeUp, HookCommand } from '../../extractors/discord/src/discord-types.ts';
import { messageEvents, newState, translateDispatch, translateSnapshot } from '../../extractors/discord/src/ingest.ts';
import { voiceOut } from '../../extractors/discord/src/media.ts';
import { pollCapabilities, PollOps } from '../../extractors/discord/src/polls.ts';
import type { FakeDiscord, FakeUser, GatewayDispatch } from './fake-discord.ts';

const HOOK_SRC = join(import.meta.dir, '../../extractors/discord/src/extension/hook.js');
const KEY = 'discord-parity-marker-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');

export interface DiscordExtractorOptions {
  fake: FakeDiscord;
  /** The account: a user (not a bot) of the fake. */
  self: FakeUser;
  /** Every event the extractor emits, in order. */
  emit: (ev: P.AdapterEvent) => void;
  /** A test's hook into the dispatches the hook forwards: return false to drop one (a regression check). */
  filter?: (event: string, data: any) => boolean;
}

/** The client's gateway handler: a gateway dispatch as the Flux action the client's stores and the hook hear. */
function fluxOf(g: GatewayDispatch): Record<string, unknown> | null {
  const d = g.d;
  switch (g.t) {
    case 'MESSAGE_CREATE':
      return { type: g.t, guildId: d.guild_id, channelId: d.channel_id, message: d, optimistic: false, isPushNotification: false };
    case 'MESSAGE_UPDATE':
      return { type: g.t, guildId: d.guild_id, message: d };
    case 'MESSAGE_DELETE':
      return { type: g.t, guildId: d.guild_id, id: d.id, channelId: d.channel_id };
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
      return { type: g.t, channelId: d.channel_id, messageId: d.message_id, userId: d.user_id, emoji: d.emoji, optimistic: false, colors: d.burst_colors ?? [], messageAuthorId: d.message_author_id, reactionType: d.type ?? 0, burst: !!d.burst };
    case 'CHANNEL_PINS_UPDATE':
      return { type: g.t, guildId: d.guild_id, channelId: d.channel_id, lastPinTimestamp: d.last_pin_timestamp };
  }
  return null;
}

export function startDiscordExtractor(o: DiscordExtractorOptions) {
  const { fake, self } = o;
  const base = `${fake.origin}/api/v9`;

  // ------------------------------------------------------------ the client replica
  const handlers = new Map<string, ((a: any) => void)[]>();
  const interceptors: ((a: any) => boolean)[] = [];
  /** The client's MessageStore: what it heard, raw. */
  const held = new Map<string, any>();
  const dispatcher = {
    dispatch(a: any) {
      for (const i of interceptors) if (i(a)) return Promise.resolve();
      if ((a.type === 'MESSAGE_CREATE' && !a.optimistic) || a.type === 'MESSAGE_UPDATE') held.set(a.message.id, { ...held.get(a.message.id), ...a.message });
      if (a.type === 'MESSAGE_DELETE') held.delete(a.id);
      for (const fn of handlers.get(a.type) ?? []) fn(a);
      return Promise.resolve();
    },
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, (handlers.get(ev) ?? []).filter((f) => f !== fn)),
    addInterceptor: (fn: (a: any) => boolean) => void interceptors.push(fn),
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, addChangeListener() {}, removeChangeListener() {}, ...extra });
  const channel = { id: fake.channelId, type: 0, guild_id: fake.guildId, name: 'parity', position: 0 };
  /** The client's REST helper: rejects with { status, body } on an error, as the client's does. */
  const call = async (method: string, o: { url: string; query?: Record<string, unknown>; body?: unknown }) => {
    const q = o.query ? `?${new URLSearchParams(Object.entries(o.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}` : '';
    const res = await fetch(`${base}${o.url}${q}`, { method, headers: { authorization: self.token, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
    return { ok: true, status: res.status, body };
  };
  const rest = { get: (x: any) => call('GET', x), post: (x: any) => call('POST', x), put: (x: any) => call('PUT', x), patch: (x: any) => call('PATCH', x), del: (x: any) => call('DELETE', x) };
  let optimistic = 0;
  const messageActions = {
    // The client's own send: an optimistic echo under a temporary id, the request, then the gateway's message.
    async sendMessage(channelId: string, msg: { content: string }, _wait: boolean, opts: { nonce?: string; messageReference?: { channel_id: string; message_id: string } } = {}) {
      dispatcher.dispatch({ type: 'MESSAGE_CREATE', channelId, optimistic: true, message: { id: opts.nonce ?? `tmp${optimistic++}`, channel_id: channelId, author: { id: self.id, username: self.username }, content: msg.content, timestamp: new Date().toISOString(), type: opts.messageReference ? 19 : 0, state: 'SENDING' } });
      return call('POST', { url: `/channels/${channelId}/messages`, body: { content: msg.content, nonce: opts.nonce, tts: false, flags: 0, ...(opts.messageReference ? { message_reference: opts.messageReference } : {}) } });
    },
    editMessage(channelId: string, messageId: string, msg: { content: string }) {
      void call('PATCH', { url: `/channels/${channelId}/messages/${messageId}`, body: { content: msg.content } }).catch(() => {});
    },
    deleteMessage(channelId: string, messageId: string) {
      void call('DELETE', { url: `/channels/${channelId}/messages/${messageId}` }).catch(() => {});
    },
  };
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: self.id, username: self.username, globalName: self.global_name ?? null }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => (id === channel.id ? channel : null), getMutablePrivateChannels: () => ({}) });
    e.D = store('GuildStore', { getGuilds: () => ({ [fake.guildId]: { id: fake.guildId, name: 'Parity Test Server' } }), getGuild: (id: string) => (id === fake.guildId ? { id, name: 'Parity Test Server' } : null) });
    e.E = rest;
    e.F = messageActions;
    e.G = store('MessageStore', { getMessage: (_c: string, id: string) => held.get(id) ?? null });
  };

  // ------------------------------------------------------------ the page and the hook
  const timers: (() => void)[] = [];
  const replies = new Map<string, (m: any) => void>();
  const events = new EventTarget();
  const st = newState();
  let finders: Record<string, boolean> = {};
  let snapshotted: () => void = () => {};
  const snapshot = new Promise<void>((r) => (snapshotted = r));
  let pinTimer: Timer | null = null;
  const emit = o.emit;

  function tellHeldPins() {
    if (pinTimer || !st.changes.held.size) return;
    pinTimer = setTimeout(() => {
      pinTimer = null;
      for (const ev of duePins(st.changes, Date.now())) emit(ev);
      tellHeldPins();
    }, PIN_HOLD_MS);
  }

  /** main.ts's handleBridge, for what the parity suite needs. */
  function onUp(msg: BridgeUp | { t: 'reply'; id: string }) {
    switch (msg.t) {
      case 'reply':
        replies.get(msg.id)?.(msg);
        break;
      case 'finders':
        finders = msg.results;
        break;
      case 'snapshot':
        for (const ev of translateSnapshot(msg.data, st).events) emit(ev);
        snapshotted();
        break;
      case 'dispatch':
        if (o.filter && !o.filter(msg.event, msg.data)) break;
        for (const ev of translateDispatch(msg.event, msg.data, st)) emit(ev);
        tellHeldPins();
        break;
    }
  }
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else onUp(e.detail);
  });
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => events.addEventListener(type, fn),
    removeEventListener: (type: string, fn: (e: any) => void) => events.removeEventListener(type, fn),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
  };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: `https://discord.com/channels/${fake.guildId}/${channel.id}`, pathname: `/channels/${fake.guildId}/${channel.id}`, reload() {} };
  const session = { getItem: () => null, setItem() {} };
  const hook = stampMarkers(readFileSync(HOOK_SRC, 'utf8'), KEY);
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', hook)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => void timers.push(fn), () => 0);
  const cache: Record<string, { exports: any }> = {};
  const req: any = (id: string) => cache[id]!.exports;
  req.c = cache;
  (win.webpackChunkdiscord_app = win.webpackChunkdiscord_app || []).push = function (chunk: any) {
    const [, mods, run] = chunk;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, req);
    }
    if (run) run(req);
  };
  win.webpackChunkdiscord_app.push([['700'], { client: modules }]);
  // The hook's first look for its modules (it queued it at start): the core ones are there, so it subscribes.
  timers.splice(0).forEach((fn) => fn());

  // The gateway, as the client's own socket would hand it to the dispatcher.
  const off = fake.gateway(self.id, (g) => {
    const a = fluxOf(g);
    if (a) dispatcher.dispatch(a);
  });

  // ------------------------------------------------------------ the extractor's side
  let seq = 0;
  const bridge = {
    request<T>(cmd: HookCommand | { kind: string; [k: string]: unknown }, _timeoutMs: number): Promise<T> {
      const id = `c${seq++}`;
      return new Promise<T>((resolve, reject) => {
        replies.set(id, (m) => {
          replies.delete(id);
          if (m.ok) resolve(m.result as T);
          else reject(new Error(String(m.error ?? 'the hook failed')));
        });
        events.dispatchEvent(new CustomEvent(DOWN, { detail: { t: 'cmd', id, cmd } }));
      });
    },
  };
  const pace = { run: <T>(_label: string, fn: () => Promise<T>) => fn() };
  const polls = new PollOps({
    bridge,
    pace,
    lookPace: pace,
    emit,
    messages: (raw) => {
      for (const m of raw) for (const ev of messageEvents(m as any, st, false)) emit(ev);
    },
    selfId: () => st.selfId || null,
    caps: () => pollCapabilities(finders),
    nonce: () => String(Date.now()),
  });
  let nonce = 0;

  /** main.ts's onCommand, for the commands the parity suite sends. */
  async function command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send': {
        const voice = voiceOut(cmd.attachments);
        const files = cmd.attachments?.map((f) => ({ name: voice ? 'voice-message.ogg' : f.name, mime: f.mime, size: f.size, base64: readFileSync(f.path).toString('base64') }));
        const hc = { kind: 'send', channelId: cmd.conversation, content: cmd.body, replyTo: cmd.replyTo, nonce: `${Date.now()}${nonce++}`, ...(files?.length ? { files } : {}) };
        const r = await pace.run('send', () => bridge.request<{ nativeId: string | null }>(hc, 30_000));
        return { nativeId: r?.nativeId ?? null };
      }
      case 'edit':
        return pace.run('edit', () => bridge.request({ kind: 'edit', channelId: cmd.conversation, messageId: cmd.message, content: cmd.body }, 20_000));
      case 'redact':
        return pace.run('redact', () => bridge.request({ kind: 'redact', channelId: cmd.conversation, messageId: cmd.message }, 20_000));
      case 'react': {
        await pace.run('react', () => bridge.request({ kind: 'react', channelId: cmd.conversation, messageId: cmd.message, emoji: cmd.key, remove: cmd.remove, burst: false }, 20_000));
        emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: st.selfId, key: cmd.key, ...(cmd.remove ? { remove: true } : {}) });
        return {};
      }
      case 'configure':
        if (cmd.change.key !== 'pin') throw new Error(`configure ${cmd.change.key}: not in the parity suite`);
        // main.ts reads the channel's About for the pin right first; the fake's channel lets this account pin.
        await polls.pin(cmd.target, cmd.change, undefined);
        return {};
    }
    throw new Error(`${cmd.t}: not in the parity suite`);
  }

  return {
    st,
    command,
    /** Resolves once the client has said who it is (CONNECTION_OPEN, then the hook's snapshot). */
    async ready() {
      dispatcher.dispatch({ type: 'CONNECTION_OPEN', user: { id: self.id }, guilds: [], privateChannels: [] });
      await snapshot;
    },
    stop() {
      off();
      if (pinTimer) clearTimeout(pinTimer);
    },
  };
}
