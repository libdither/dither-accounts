/**
 * The messenger and instagram extractors (extractors/messenger, extractors/instagram call run() with their site):
 * one account signed in to the real web app in a sandboxed browser (packages/browser: Xvfb, an ordinary Chromium with
 * a persistent profile and our extension, x11vnc for the live view), answering dither-chat's `chat` interface from
 * inside the page. You sign in once in the live view; two-factor and Meta's checks are yours to pass.
 *
 * The hook (src/extension/hook.js) reads the client's own stores (Messenger's LightSpeed database, Instagram's Relay
 * store), forwards what changes, and runs commands through the client's own code. This side checks what it gets
 * (raw.ts), maps it to chat facts (map.ts), paces commands like a person, and reports which of the hook's points were
 * found as status layers and details. docs/messenger.md has the design and how to read the status.
 *
 * Config: { site?: 'messenger' | 'facebook' (Messenger only), noSandbox?, testOrigin? (tests) }. Keeps learned.json
 * (the shapes of the client's own task requests, names and small constants only) in the account directory. Logs ids,
 * counts, module names and statuses: never message text, people's names, cookies or tokens.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import { type Ev, Mapper, parseMediaUrl } from './map.ts';
import { PaceQueue, typingTime } from './pace.ts';
import type { SelfIds } from './raw.ts';
import { SITES, type SiteId } from './sites.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** The extension should be talking to us this soon after the browser starts. */
const ATTACH_MS = 30_000;
/** A hook the app needs, still missing this long after a signed-in page with its modules: the app changed. */
const GRACE_MS = Number(process.env.DITHER_META_GRACE_MS) || 90_000;
const VERSION = '0.1.0';

type Hook = { ok: boolean; via: string | null; need: 'core' | 'optional' };
type Up =
  | { t: 'ready' }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { t: 'tabs'; tabs: { id: number; url: string; active: boolean; hook: boolean }[] }
  | { t: 'hook'; page: string }
  | { t: 'page'; signedIn: boolean | null; path: string; revision: string | null; backend: 'ls' | 'slide' | null; ready: boolean }
  | { t: 'hooks'; backend: 'ls' | 'slide' | null; results: Record<string, Hook>; modules: { defined: number; ran: number }; names: string; records: string; dropped: Record<string, number> }
  | { t: 'snapshot'; backend: 'ls' | 'slide'; self: SelfIds; dropped?: Record<string, number>; [k: string]: unknown }
  | { t: 'rows'; changes: unknown[] }
  | { t: 'records'; messages: unknown[]; threads: unknown[]; users: unknown[]; deleted: unknown[] }
  | { t: 'typing'; thread: string | null; threadIg: string; sender: string | null; senderIg: string; on: boolean; ttl: number | null }
  | { t: 'trace'; items: { kind: string; name: string; keys: string[]; n: number; at: number }[] }
  | { t: 'learned'; key: string; shape: { kind: string; label: string; usable: boolean; [k: string]: unknown } };
type Down = { kind: string; [k: string]: unknown };
type Layer = P.StatusLayer;

export async function run(siteId: SiteId) {
  const site = SITES[siteId];
  const hub = linkHub({ onCommand, onConnect, onShutdown: () => cleanup() });
  const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);
  const cfg = hub.config as Record<string, unknown>;
  const testOrigin = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
  const origins = testOrigin ? [...site.origins, testOrigin] : site.origins;
  const startUrl = testOrigin ? `${testOrigin}${siteId === 'instagram' ? '/direct/inbox/' : '/'}` : site.start(cfg);
  const STARTED = Date.now();

  // ------------------------------------------------------------------ state
  let mapper = new Mapper(site.network);
  const learnedPath = join(hub.accountDir, 'learned.json');
  let learned: Record<string, unknown> = readJson(learnedPath) ?? {};
  let display = 0;
  let liveView: { vncSocket: string; width: number; height: number } | null = null;
  let sandbox: Sandbox | null = null;
  let sandboxError: string | null = null;
  let startedAt = 0;
  let tab: string | null = null;
  let hookTabs = 0;
  let page: Extract<Up, { t: 'page' }> | null = null;
  let signedInOnce = false;
  let appSince = 0;
  let hooks: Record<string, Hook> = {};
  let hookInfo: { modules: { defined: number; ran: number }; names: string; records: string } | null = null;
  let hookDropped: Record<string, number> = {};
  let backend: 'ls' | 'slide' | null = null;
  let self: SelfIds | null = null;
  let snapshot: { at: number; conversations: number; messages: number } | null = null;
  const traced = new Map<string, { kind: string; name: string; keys: string[]; n: number }>();
  let last: { op: string; at: number; ok: boolean; error?: string } | null = null;
  let sentCaps = '';
  const timers: Timer[] = [];

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
  const pace = new PaceQueue({ minGapMs: 1500, jitterMs: 1500, log: (m, d) => log('debug', m, d) });
  const historyPace = new PaceQueue({ minGapMs: 3000, jitterMs: 3000, log: (m, d) => log('debug', m, d) });
  const typingSent = new Map<string, number>();

  function readJson(path: string): Record<string, unknown> | null {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    } catch {
      return null;
    }
  }
  function emitAll(evs: Ev[]) {
    for (const e of evs) hub.emit(e);
  }

  // ----------------------------------------------------------------- status
  const hostOf = (u: string | null) => {
    try {
      return u ? new URL(u).hostname : null;
    } catch {
      return null;
    }
  };
  const pathOf = (u: string | null) => {
    try {
      return u ? new URL(u).pathname : '';
    } catch {
      return '';
    }
  };
  const onSite = (u: string | null) => !!u && origins.some((o) => u === o || u.startsWith(`${o}/`));
  const onSignIn = () => onSite(tab) && site.signIn.test(pathOf(tab));
  const onCheck = () => onSite(tab) && site.check.test(pathOf(tab));
  const core = () => Object.entries(hooks).filter(([, h]) => h.need === 'core');
  const missingCore = () => core().filter(([, h]) => !h.ok).map(([id]) => id);
  const signedIn = () => !!(hookTabs && page?.signedIn);
  const broken = () => signedIn() && appSince > 0 && Date.now() - appSince > GRACE_MS && (missingCore().length > 0 || !backend);
  const has = (id: string) => !!hooks[id]?.ok;
  const b = () => (backend === 'ls' ? 'ls' : 'slide');

  type Att = { kind: P.Attention['kind']; message: string; liveView: boolean };
  function state(): { status: P.AccountStatus; attention: Att | null } {
    const att = (a: Att) => ({ status: 'attention' as const, attention: a });
    if (sandboxError) return { status: 'error', attention: { kind: 'unknown', message: `The sandbox failed to start: ${sandboxError}`, liveView: false } };
    if (!liveView) return { status: 'connecting', attention: null };
    if (!bridge.connected) {
      if (Date.now() - startedAt > ATTACH_MS) return att({ kind: 'unknown', message: 'The sandbox extension did not attach; open the live view to see the browser', liveView: true });
      return { status: 'connecting', attention: null };
    }
    if (onCheck()) return att({ kind: 'verify', message: `${site.name} asks for a check in the live view (a code, a confirmation); it is yours to pass`, liveView: true });
    if (onSignIn() || (hookTabs && page?.signedIn === false)) return att({ kind: 'login', message: `Sign in to ${site.name} in the live view`, liveView: true });
    if (tab && !onSite(tab)) {
      return signedInOnce
        ? att({ kind: 'unknown', message: `${site.name} is not open in the sandbox (it is on ${hostOf(tab) ?? 'another page'}); open the live view and go back to it`, liveView: true })
        : att({ kind: 'login', message: `Sign in to ${site.name} in the live view`, liveView: true });
    }
    if (broken()) {
      const what = missingCore().length ? missingCore().join(', ') : 'its mailbox (neither LightSpeed nor the Slide store)';
      return att({ kind: 'selector_broken', message: `${site.name}'s web app changed: ${what} not found. Reading stops here until the hook is updated; the live view still works`, liveView: true });
    }
    if (!signedIn() || !snapshot) return { status: 'connecting', attention: null };
    return { status: 'online', attention: null };
  }

  const dropTotal = () => Object.values(hookDropped).reduce((a, n) => a + n, 0) + Object.values(mapper.drops).reduce((a, n) => a + n, 0);
  function details(): Record<string, string | number | boolean | null> {
    const d: Record<string, string | number | boolean | null> = {
      site: siteId === 'messenger' && cfg.site === 'facebook' ? 'facebook.com/messages' : siteId,
      display: liveView ? `:${display}` : null,
      page: tab,
      extensionAttached: bridge.connected,
      appPage: hookTabs > 0,
      signedIn: hookTabs ? (page?.signedIn ?? null) : null,
      backend,
      bundleRevision: page?.revision ?? null,
      modules: hookInfo ? `${hookInfo.modules.defined} defined, ${hookInfo.modules.ran} ran` : null,
      moduleNames: hookInfo?.names ?? null,
      moduleRecords: hookInfo?.records ?? null,
      hooksFound: Object.keys(hooks).length ? `${Object.values(hooks).filter((h) => h.ok).length} of ${Object.keys(hooks).length}` : null,
      chats: mapper.counts.conversations,
      people: mapper.counts.identities,
      messages: mapper.counts.messages,
      dropped: dropTotal(),
      traced: traced.size,
      learned: Object.keys(learned).sort().join(' ') || null,
      lastCommand: last ? `${last.op} ${last.ok ? 'ok' : 'failed'} ${new Date(last.at).toISOString().slice(11, 19)}` : null,
      lastError: last && !last.ok ? (last.error ?? null) : null,
    };
    for (const [id, h] of Object.entries(hooks)) d[`hook.${id}`] = h.ok ? h.via : 'missing';
    for (const [k, n] of Object.entries(hookDropped)) if (n) d[`dropped.page.${k}`] = n;
    for (const [k, n] of Object.entries(mapper.drops)) if (n) d[`dropped.${k}`] = n;
    return d;
  }

  /** What the account rests on, outermost first. */
  function layers(): Layer[] {
    const browserFailed = !!sandboxError && /chromium/i.test(sandboxError);
    const out: Layer[] = [];
    out.push(
      liveView
        ? { name: 'display', state: 'ok', note: `Xvfb :${display}, live view ready` }
        : sandboxError && !browserFailed
          ? { name: 'display', state: 'failed', note: sandboxError }
          : browserFailed
            ? { name: 'display', state: 'off', note: 'not started' }
            : { name: 'display', state: 'waiting', note: 'starting Xvfb' },
    );
    out.push(
      liveView
        ? sandbox?.browserAlive
          ? { name: 'browser', state: 'ok', note: tab ? `Chromium, on ${hostOf(tab) ?? tab}` : 'Chromium is running' }
          : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' }
        : browserFailed
          ? { name: 'browser', state: 'failed', note: sandboxError! }
          : { name: 'browser', state: 'waiting', note: 'not started yet' },
    );
    out.push(
      bridge.connected
        ? { name: 'extension', state: 'ok', note: hookTabs ? `attached, in the ${site.name} page` : 'attached' }
        : liveView && startedAt && Date.now() - startedAt > ATTACH_MS
          ? { name: 'extension', state: 'failed', note: `did not attach within ${ATTACH_MS / 1000} s` }
          : { name: 'extension', state: 'waiting', note: 'not attached yet' },
    );
    out.push(
      signedIn()
        ? { name: 'signed in', state: 'ok', note: self ? `as ${self.id}` : 'signed in' }
        : !bridge.connected
          ? { name: 'signed in', state: 'waiting', note: 'waits for the extension' }
          : onCheck()
            ? { name: 'signed in', state: 'waiting', note: `${site.name} asks for a check in the live view` }
            : onSignIn() || (hookTabs && page?.signedIn === false) || (tab && !onSite(tab) && !signedInOnce)
              ? { name: 'signed in', state: 'waiting', note: `sign in to ${site.name} in the live view` }
              : tab && !onSite(tab)
                ? { name: 'signed in', state: 'waiting', note: `${site.name} is not open (the tab is on ${hostOf(tab) ?? tab})` }
                : { name: 'signed in', state: 'waiting', note: `${site.name} is loading` },
    );
    const late = signedIn() && appSince && Date.now() - appSince > GRACE_MS;
    const mods = hooks.modules;
    out.push(
      mods?.ok && hooks.session?.ok
        ? { name: 'client modules', state: 'ok', note: `${hookInfo?.modules.defined ?? 0} modules (records via ${hookInfo?.records ?? '?'}, names via ${hookInfo?.names ?? '?'})${page?.revision ? `, revision ${page.revision}` : ''}` }
        : late
          ? { name: 'client modules', state: 'failed', note: `missing: ${['modules', 'session'].filter((k) => !hooks[k]?.ok).join(', ')}` }
          : { name: 'client modules', state: 'waiting', note: signedIn() ? 'looking for them' : 'waits for the sign-in' },
    );
    const dataIds = backend === 'ls' ? ['ls.db', 'ls.read'] : backend === 'slide' ? ['slide.env', 'slide.read'] : [];
    const dataMissing = dataIds.filter((k) => !hooks[k]?.ok);
    out.push(
      backend && !dataMissing.length
        ? { name: 'mailbox', state: 'ok', note: backend === 'ls' ? `LightSpeed database via ${hooks['ls.db']!.via}, read via ${hooks['ls.read']!.via}` : `Relay store via ${hooks['slide.env']!.via}` }
        : late
          ? { name: 'mailbox', state: 'failed', note: backend ? `missing: ${dataMissing.join(', ')}` : 'neither the LightSpeed database nor the Slide store was found' }
          : { name: 'mailbox', state: 'waiting', note: signedIn() ? 'looking for it' : 'waits for the sign-in' },
    );
    const ch = backend ? hooks[`${b()}.changes`] : undefined;
    out.push(
      ch?.ok
        ? { name: 'live updates', state: 'ok', note: /poll|Commit|Processor/.test(ch.via ?? '') ? `via ${ch.via} (degraded: the client's change feed was not found)` : `via ${ch.via}` }
        : late && backend
          ? { name: 'live updates', state: 'failed', note: 'no way to hear changes was found' }
          : { name: 'live updates', state: 'waiting', note: 'not hooked yet' },
    );
    const dropped = dropTotal();
    out.push(
      snapshot
        ? { name: 'first snapshot', state: 'ok', note: `${snapshot.conversations} chats, ${snapshot.messages} messages${dropped ? `; ${dropped} dropped (see details)` : ''}` }
        : { name: 'first snapshot', state: 'waiting', note: signedIn() ? 'reading the mailbox' : 'waits for the sign-in' },
    );
    if (backend && snapshot) {
      const ops: [string, string][] =
        backend === 'ls'
          ? [['send', 'ls.send'], ['reply', 'ls.reply'], ['react', 'ls.react'], ['edit', 'ls.edit'], ['unsend', 'ls.unsend'], ['mark read', 'ls.markRead']]
          : [['send', 'slide.send'], ['react', 'slide.react'], ['edit', 'slide.edit'], ['unsend', 'slide.unsend'], ['mark read', 'slide.markRead'], ['typing', 'slide.typingOut']];
      const parts = ops.map(([n, id]) => `${n} ${hooks[id]?.ok ? `via ${hooks[id]!.via}` : '—'}`);
      out.push(has(`${b()}.send`) ? { name: 'sending', state: 'ok', note: parts.join('; ') } : { name: 'sending', state: 'failed', note: `read-only: no way to send was found. ${parts.join('; ')}` });
    } else out.push({ name: 'sending', state: 'waiting', note: 'after the first snapshot' });
    return out;
  }

  function capabilities(): P.Capability[] {
    const c: P.Capability[] = ['liveView', 'media', 'history'];
    if (!backend) return c;
    const p = b();
    if (has(`${p}.send`)) c.push('send');
    if (has(`${p}.react`)) c.push('react');
    if (has(`${p}.edit`)) c.push('edit');
    if (has(`${p}.unsend`)) c.push('redact');
    if (has(`${p}.markRead`)) c.push('markRead');
    if (p === 'slide' && has('slide.typingOut')) c.push('typing');
    if (p === 'ls') c.push('e2ee');
    return c;
  }
  function hello(force = false) {
    const caps = capabilities();
    const k = caps.join(',');
    if (k === sentCaps && !force) return;
    sentCaps = k;
    hub.emit({ t: 'hello', network: site.network, version: VERSION, capabilities: caps });
  }

  let lastSent = '';
  function status(force = false) {
    const st = state();
    const ev: P.AdapterEvent = {
      t: 'status',
      status: st.status,
      attention: st.attention,
      liveView,
      ...(self && signedIn() ? { self: { nativeId: self.id, isSelf: true } } : {}),
      details: details(),
      layers: layers(),
    };
    const s = JSON.stringify(ev);
    if (s === lastSent && !force) return;
    lastSent = s;
    hub.emit(ev);
    hello();
  }

  // ----------------------------------------------------------------- bridge
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
        // A page (re)loaded: hand it what was learned of the client's own tasks.
        void bridge.request({ kind: 'settings', settings: { site: siteId, learned } }, 10_000).catch(() => {});
        break;
      case 'page': {
        const was = page?.signedIn;
        page = msg;
        if (msg.signedIn) {
          signedInOnce = true;
          if (!appSince) appSince = Date.now();
        } else appSince = 0;
        if (msg.signedIn !== was) log('info', `${site.name} page: ${msg.signedIn ? 'signed in' : msg.signedIn === false ? 'not signed in' : 'loading'}`, { revision: msg.revision });
        break;
      }
      case 'hooks': {
        const before = JSON.stringify(hooks);
        hooks = msg.results && typeof msg.results === 'object' ? msg.results : {};
        hookInfo = { modules: msg.modules, names: msg.names, records: msg.records };
        hookDropped = msg.dropped && typeof msg.dropped === 'object' ? msg.dropped : {};
        if (msg.backend && msg.backend !== backend) {
          backend = msg.backend;
          log('info', `mailbox: ${backend === 'ls' ? 'LightSpeed database' : 'Slide store'}`);
        }
        if (JSON.stringify(hooks) !== before) {
          const found = Object.entries(hooks).filter(([, h]) => h.ok).map(([k, h]) => `${k}=${h.via}`);
          const missing = Object.entries(hooks).filter(([, h]) => !h.ok).map(([k]) => k);
          log('info', `hooks: ${found.length} found${missing.length ? `, missing ${missing.join(' ')}` : ''}`, { found });
        }
        break;
      }
      case 'snapshot': {
        backend = msg.backend;
        self = msg.self && typeof msg.self.id === 'string' ? msg.self : null;
        if (!self) {
          log('warn', 'snapshot without a self id; dropped');
          break;
        }
        if (msg.dropped && typeof msg.dropped === 'object') hookDropped = msg.dropped;
        const evs = backend === 'ls' ? mapper.lsSnapshot(msg, self) : mapper.slideSnapshot(msg, self);
        emitAll(evs);
        snapshot = { at: Date.now(), conversations: mapper.counts.conversations, messages: mapper.counts.messages };
        log('info', `snapshot: ${snapshot.conversations} chats, ${snapshot.messages} messages, ${mapper.counts.identities} people`, { dropped: dropTotal() });
        break;
      }
      case 'rows':
        emitAll(mapper.lsChanges(msg.changes));
        break;
      case 'records':
        emitAll(mapper.slideRecords(msg));
        break;
      case 'typing':
        emitAll(mapper.slideTyping(msg));
        break;
      case 'trace':
        for (const it of Array.isArray(msg.items) ? msg.items : []) {
          if (!it || typeof it.kind !== 'string' || typeof it.name !== 'string') continue;
          const k = `${it.kind} ${it.name}`;
          if (!traced.has(k)) log('info', `client ran ${it.kind} ${it.name}`, { keys: Array.isArray(it.keys) ? it.keys.slice(0, 20) : [] });
          traced.set(k, { kind: it.kind, name: it.name, keys: Array.isArray(it.keys) ? it.keys.slice(0, 40).map(String) : [], n: Number(it.n) || 0 });
        }
        break;
      case 'learned':
        if (msg.shape && typeof msg.key === 'string' && typeof msg.shape.label === 'string') {
          learned = { ...learned, [msg.key]: msg.shape };
          try {
            writeFileSync(learnedPath, JSON.stringify(learned, null, 2), { mode: 0o600 });
          } catch {}
          log('info', `learned the client's own ${msg.shape.kind} task (label ${msg.shape.label})${msg.shape.usable ? '' : ', not usable: a field we cannot fill'}`);
        }
        break;
    }
    status();
  }

  // ---------------------------------------------------------------- commands
  function ready() {
    if (!bridge.connected) throw Object.assign(new Error('the sandbox browser is not attached yet'), { status: 503 });
    if (!signedIn()) throw Object.assign(new Error(`${site.name} is not signed in; sign in in the live view`), { status: 401 });
    if (!snapshot || !backend) throw Object.assign(new Error(`${site.name} is still loading`), { status: 503 });
  }
  async function request<T = any>(cmd: Down, ms: number): Promise<T> {
    return bridge.request<T>(cmd, ms);
  }
  async function tracked<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      last = { op, at: Date.now(), ok: true };
      return r;
    } catch (e) {
      last = { op, at: Date.now(), ok: false, error: String((e as Error).message ?? e).slice(0, 160) };
      log('warn', `${op} failed`, last.error);
      throw e;
    } finally {
      status();
    }
  }
  /** Our own message as the mapper finally said it (the server's copy, not the client's optimistic one). */
  async function ownSaid(conversation: string, since: number, otid: string | undefined, ms: number): Promise<string | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = mapper.ownSaid.find((o) => o.conversation === conversation && (otid ? o.otid === otid : o.ts >= since - 3000));
      if (hit) return hit.id;
      await Bun.sleep(150);
    }
    return null;
  }
  function needs(cap: P.Capability) {
    if (!capabilities().includes(cap)) throw Object.assign(new Error(`${site.name}: ${cap} is not available here (its hook was not found; see the account's layers)`), { status: 501 });
  }

  async function onCommand(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send': {
        ready();
        needs('send');
        if (cmd.attachments?.length) throw Object.assign(new Error(`sending files to ${site.name} is not hooked yet`), { status: 501 });
        const since = Date.now();
        return tracked('send', async () => {
          const r = await pace.run('send', () => request<{ nativeId: string | null; otid?: string; via?: string }>({ kind: 'send', thread: cmd.conversation, text: cmd.body, ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}) }, 60_000), typingTime(cmd.body));
          let id = r?.nativeId ?? null;
          if (backend === 'ls') id = (await ownSaid(cmd.conversation, since, r?.otid, 8000)) ?? id;
          return { nativeId: id };
        });
      }
      case 'history': {
        ready();
        return tracked('history', async () => {
          const r = await historyPace.run('history', () => request<Record<string, unknown>>({ kind: 'history', thread: cmd.conversation, beforeTs: cmd.beforeTs, limit: Math.max(1, Math.min(cmd.limit, 100)) }, 90_000));
          const { events, count } = backend === 'ls' ? mapper.lsHistory(r) : mapper.slideHistory(r);
          emitAll(events);
          return { count, done: !!r?.done };
        });
      }
      case 'markRead': {
        ready();
        needs('markRead');
        const known = mapper.knownMessage(cmd.upTo);
        return tracked('markRead', () => pace.run('markRead', () => request({ kind: 'markRead', thread: cmd.conversation, upTo: cmd.upTo, upToTs: known?.ts }, 30_000)));
      }
      case 'typing': {
        ready();
        needs('typing');
        // Not paced (it must not wait behind other commands), but no more often than the client itself sends it.
        const k = cmd.conversation;
        if (!cmd.stop && Date.now() - (typingSent.get(k) ?? 0) < 5000) return {};
        typingSent.set(k, cmd.stop ? 0 : Date.now());
        await request({ kind: 'typing', thread: cmd.conversation, on: !cmd.stop }, 15_000);
        return {};
      }
      case 'react': {
        ready();
        needs('react');
        return tracked('react', () => pace.run('react', () => request({ kind: 'react', thread: cmd.conversation, message: cmd.message, emoji: cmd.key, remove: !!cmd.remove }, 30_000)));
      }
      case 'reactionContext':
        return { canReact: capabilities().includes('react'), ...(capabilities().includes('react') ? {} : { reason: 'Reacting is not hooked for this account yet.' }), custom: [] } satisfies P.ReactionContext;
      case 'edit': {
        ready();
        needs('edit');
        return tracked('edit', () => pace.run('edit', () => request({ kind: 'edit', thread: cmd.conversation, message: cmd.message, text: cmd.body }, 30_000), typingTime(cmd.body)));
      }
      case 'redact': {
        ready();
        needs('redact');
        return tracked('unsend', () => pace.run('unsend', () => request({ kind: 'unsend', thread: cmd.conversation, message: cmd.message }, 30_000)));
      }
      case 'fetchMedia':
        return media(cmd.url);
      case 'action':
        return action(cmd.action, cmd.args);
      default:
        throw Object.assign(new Error(`${site.name} has no command ${(cmd as { t: string }).t}`), { status: 400 });
    }
  }

  /** An attachment's bytes: the page names the current link (or gives bytes it holds), the extension fetches it. */
  async function media(url: string): Promise<{ mime: string; base64: string }> {
    const loc = parseMediaUrl(url);
    if (!loc) throw Object.assign(new Error('not a media link of this account'), { status: 400 });
    if (!bridge.connected) throw Object.assign(new Error('the sandbox browser is not attached'), { status: 503 });
    const r = loc.k === 'url' ? { url: loc.u } : await request<{ url?: string; mime?: string; base64?: string }>({ kind: 'media', locator: loc }, 30_000);
    if (r?.base64) return { mime: r.mime ?? 'application/octet-stream', base64: r.base64 };
    if (!r?.url) throw Object.assign(new Error('no link for that attachment'), { status: 404 });
    return request<{ mime: string; base64: string }>({ kind: 'mediaFetch', url: r.url }, 120_000);
  }

  async function action(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case 'survey':
        // Shapes, module names and counts for the round against the real pages: never a value.
        if (!bridge.connected) throw Object.assign(new Error('the sandbox browser is not attached'), { status: 503 });
        return { ...(await request<Record<string, unknown>>({ kind: 'survey' }, 60_000)), extractor: { drops: mapper.drops, counts: mapper.counts, traced: [...traced.values()], learned: Object.keys(learned) } };
      case 'resync': {
        // Everything said again, from a fresh start (an app that came late, a hub that lost its copy).
        ready();
        const r = await request<Record<string, unknown> & { self: SelfIds }>({ kind: 'snapshot' }, 120_000);
        mapper = new Mapper(site.network);
        const evs = backend === 'ls' ? mapper.lsSnapshot(r, r.self) : mapper.slideSnapshot(r, r.self);
        emitAll(evs);
        return { events: evs.length };
      }
      case 'forgetLearned':
        learned = {};
        try {
          writeFileSync(learnedPath, '{}', { mode: 0o600 });
        } catch {}
        return { ok: true };
      default:
        throw Object.assign(new Error(`unknown action ${name}${args ? '' : ''}`), { status: 400 });
    }
  }

  // ------------------------------------------------------------------- boot
  /** The extension runs on this site's origins only (and the fake's, in tests). */
  function prepareExtension(dir: string) {
    const path = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(path, 'utf8'));
    const patterns = origins.map((o) => `${o}/*`);
    for (const cs of m.content_scripts ?? []) cs.matches = patterns;
    if (testOrigin) m.host_permissions = [...(m.host_permissions ?? []), `${testOrigin}/*`];
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
        config: { wsUrl: bridge.wsUrl, token: bridgeToken, testOrigin, site: siteId, learned },
        prepareExtension,
        startUrl,
        noSandbox: !!cfg.noSandbox || process.env.DITHER_CHROMIUM_NO_SANDBOX === '1',
        log,
      });
      try {
        await sandbox.start();
        startedAt = Date.now();
        liveView = { vncSocket: sandbox.vncSocket, width: WIDTH, height: HEIGHT };
        sandboxError = null;
        break;
      } catch (e) {
        sandboxError = String((e as Error).message ?? e).slice(0, 300);
        log('warn', `sandbox on :${free.display} failed`, sandboxError);
        await sandbox.stop();
        sandbox = null;
      }
    }
    status();
    if (!sandbox) return;
    timers.push(setInterval(() => bridge.ping(), 20_000));
    timers.push(setInterval(() => status(), 5000));
    timers.push(setInterval(() => emitAll(mapper.settle()), 1000));
    timers.push(
      setInterval(() => {
        if (sandbox && !sandbox.browserAlive) {
          log('warn', 'chromium exited; exiting for a supervised restart');
          void cleanup().then(() => process.exit(1));
        }
      }, 5000),
    );
  }

  // -------------------------------------------------------------- lifecycle
  function onConnect() {
    hello(true);
    status(true);
  }
  let cleaning: Promise<void> | null = null;
  function cleanup(): Promise<void> {
    cleaning ??= (async () => {
      for (const t of timers) clearInterval(t);
      try {
        bridge.stop();
      } catch {}
      try {
        await sandbox?.stop();
      } catch {}
    })();
    return cleaning;
  }

  log('info', `${site.name} extractor ${VERSION} starting`, { started: STARTED });
  boot().catch((e) => {
    log('error', 'boot failed', String(e?.message ?? e));
    void cleanup().then(() => process.exit(1));
  });
}
