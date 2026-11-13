/**
 * The proton extractor: one Proton Mail account signed in to a real browser (packages/browser: Xvfb, an ordinary
 * Chromium with a persistent profile and our extension, x11vnc for the live view), answering `mail` from inside the
 * signed-in Mail page. You sign in once in the live view, with "Keep me signed in"; the profile keeps the session.
 *
 * Calls are Proton's own API (https://mail.proton.me/api/…), made by the page's hook with the page's cookies, the
 * headers the web app itself sends (copied from its own calls) and x-pm-uid from its persisted session. Bodies and
 * attachments are decrypted here (pgp.ts): the key password comes out of the app's persisted session (session.ts)
 * with the ClientKey the API gives, opens the user keys, and they open the address keys. Keys and the key password
 * live in this process's memory only. When that unlock fails (the saved session's format moved, the ClientKey call
 * changed), they are opened in the page instead: the hook decrypts through the app's own crypto proxy with the app's
 * own keys, and only the plaintext asked for comes out. Sending is the page's too: the hook sends the safe subset of
 * what Proton's composer sends, with the app's API caller, crypto proxy and keys (send.ts). docs/proton.md has the
 * whole design and where each fact came from.
 *
 * Config: { testOrigin?, noSandbox?, pollSeconds?, modulesGraceSeconds? }. Keeps events.json (the last event id it
 * announced) in the account directory. Logs ids, counts, module names and statuses: never message contents, addresses,
 * keys, cookies or tokens.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { type ApiAnswer, type ApiRequest, ProtonApi, ProtonError } from './api.ts';
import { arrivals, ProtonMail, SYSTEM, stateOf, touched } from './mail.ts';
import { type Decryptor, KeyError, localDecryptor, type ProtonAddress, type ProtonUser, type Unlocked, unlockKeys } from './pgp.ts';
import { checkOutgoing, MAX_RECIPIENTS, SEND_CAP, type SendingAddress, send, sendingAddresses } from './send.ts';
import { openSessionBlob } from './session.ts';

const WIDTH = 1280;
const HEIGHT = 800;
const SIGN_IN_HOSTS = new Set(['account.proton.me', 'verify.proton.me']);
/** The extension should be talking to us this soon after the browser starts. */
const ATTACH_MS = 30_000;
/** At most this many new inbox messages are announced after a restart (as the imap kind). */
const CATCH_UP = 20;
const EVENT_PAGES = 50;
/**
 * The hook's names for what it finds in the app (extension/hook.js FINDERS): what the page-side unlock and sending
 * stand on. Proton's composer send functions are not among them: the hook sends the safe subset itself.
 */
const CORE_MODULES = ['CryptoProxy', 'AppApi', 'Store', 'AddressKeysByUsage'] as const;
const MODULE_NAMES: readonly string[] = CORE_MODULES;

interface Session {
  page: string;
  localID: number | null;
  signedIn: boolean | null;
  persistent: boolean | null;
  payloadVersion: number | null;
  sessions: number;
  appCalls: number;
  appLastStatus: number | null;
  appRefreshes: number;
  appVersion: string | null;
  appHeaders: string[];
  uidMatches: boolean | null;
}
type Up =
  | { t: 'ready' }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { t: 'tabs'; tabs: { id: number; url: string; active: boolean; hook: boolean }[] }
  | { t: 'hook'; page: string }
  | { t: 'modules'; found: Record<string, boolean>; runtimes?: number; factories?: number; ran?: number }
  | ({ t: 'session' } & Session);
type Down = ({ kind: 'api' } & ApiRequest) | { kind: 'storage' } | { kind: 'pagekeys' } | { kind: 'decrypt'; armored?: string; keyPackets?: string; data?: string; addressID?: string } | ({ kind: 'send' } & Record<string, unknown>);
/** What the hook found in the app's modules: names and found or not, nothing else. */
interface Modules {
  found: Record<string, boolean>;
  runtimes: number;
  factories: number;
  ran: number;
  since: number;
}
type Attention = { kind: string; message: string; liveView: boolean };
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

const link = linkManager({ onConnect, onCommand, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);

const cfg = link.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const mailOrigin = testOrigin ?? 'https://mail.proton.me';
const pollMs = Math.max(1, Number(cfg.pollSeconds) || 30) * 1000;
/** How long the page may take to load the modules the hook looks for before a missing one is a failure. */
const MODULES_GRACE_MS = Math.max(1, Number(cfg.modulesGraceSeconds) || 90) * 1000;
const STARTED = Date.now();

// -------------------------------------------------------------------- state
const eventsPath = join(link.accountDir, 'events.json');
let display = 0;
let liveView: { vncSocket: string; width: number; height: number } | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tab: string | null = null;
let hookTabs = 0;
let session: Session | null = null;
let signedInOnce = false;
/** A call answered 401 even after the page had its chance to refresh: Proton signed this browser out. */
let signedOut = false;
let unlocked: Unlocked | null = null;
/** What opens messages now: keys opened here (session) or the page's crypto proxy (page). */
let decryptor: Decryptor | null = null;
let unlocking: Promise<Decryptor> | null = null;
let keyError: string | null = null;
/** Why the saved-session unlock failed, when the page's crypto proxy stands in for it. */
let sessionUnlockError: string | null = null;
let pageKeys: { addresses: number; withKeys: number; keys: number } | null = null;
let modules: Modules | null = null;
let sends = 0;
let self: { email: string; displayName?: string; addresses: { email: string; name: string | null }[] } | null = null;
/** The addresses it sends as, with their ids (self.addresses without them). */
let senders: SendingAddress[] | null = null;
let watchId: string | null = readKept().eventId ?? null;
let watch: { at: number; error: string | null } | null = null;
let polling = false;
let pollTimer: Timer | undefined;
let soonTimer: Timer | undefined;
const timers: Timer[] = [];

function readKept(): { eventId?: string } {
  try {
    return existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : {};
  } catch {
    return {};
  }
}

const bridgeToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
const bridge = new BridgeServer<Up, Down>({
  token: bridgeToken,
  onMessage: onBridge,
  onConnect: () => status(),
  onDisconnect: () => {
    hookTabs = 0;
    session = null;
    modules = null;
    status();
  },
  log,
});

const transport = async (req: ApiRequest): Promise<ApiAnswer> => {
  if (!bridge.connected) throw new StatusError('the sandbox browser is not attached', 503);
  try {
    return await bridge.request<ApiAnswer>({ kind: 'api', ...req }, req.binary ? 180_000 : 90_000);
  } catch (e) {
    throw new StatusError(String((e as Error).message ?? e).slice(0, 200), 503);
  }
};
const api = new ProtonApi(transport, log);
api.onAnswer = (st) => {
  if (st === 401 && !signedOut) {
    signedOut = true;
    log('warn', 'Proton answered 401 after the page had its chance to refresh: signed out');
  } else if (st !== 401 && signedOut && st < 500) signedOut = false;
  status();
};
const keys = {
  get: () => (decryptor ? Promise.resolve(decryptor) : unlock()),
  again: () => unlock(true),
};

/** Bridge failures (no page, no answer) are 503; anything else the page said means its keys did not open it. */
function pageCall<T>(cmd: Down, timeoutMs: number): Promise<T> {
  if (!bridge.connected) return Promise.reject(new StatusError('the sandbox browser is not attached', 503));
  return bridge.request<T>(cmd, timeoutMs).catch((e) => {
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    if (/^(hook timed out|extension not connected|extractor shutting down|Proton Mail is not open|the Mail page went away)/.test(msg)) throw new StatusError(msg, 503);
    throw new Error(msg);
  });
}
const b64 = (r: unknown): Uint8Array => {
  const v = (r as { base64?: unknown })?.base64;
  if (typeof v !== 'string') throw new Error('the page answered without the plaintext');
  return Uint8Array.from(Buffer.from(v, 'base64'));
};
/** The page's crypto proxy with the app's own keys: nothing about the keys leaves the page. */
const pageDecryptor: Decryptor = {
  path: 'page',
  body: async (armored, addressID) => b64(await pageCall({ kind: 'decrypt', armored, ...(addressID ? { addressID } : {}) }, 90_000)),
  attachment: async (keyPackets, data, addressID) => b64(await pageCall({ kind: 'decrypt', keyPackets, data: Buffer.from(data).toString('base64'), ...(addressID ? { addressID } : {}) }, 180_000)),
};
const modulesFound = (names: readonly string[]) => !!modules && names.every((n) => modules!.found[n]);
const modulesMissing = (names: readonly string[]) => names.filter((n) => !modules?.found[n]);
const mail = new ProtonMail(api, keys, log);

// ------------------------------------------------------------------- status
const LOGIN: Attention = { kind: 'login', message: 'Sign in to Proton in the live view (tick "Keep me signed in")', liveView: true };
const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};
const onMail = (u: string | null) => !!u && u.startsWith(`${mailOrigin}/`);
const current = () => (hookTabs ? session : null);
const onSignIn = () => SIGN_IN_HOSTS.has(hostOf(tab) ?? '');

function state(): { status: string; attention: Attention | null } {
  const att = (a: Attention) => ({ status: 'attention', attention: a });
  if (sandboxError) return { status: 'error', attention: { kind: 'unknown', message: `The sandbox failed to start: ${sandboxError}`, liveView: false } };
  if (!liveView) return { status: 'connecting', attention: null };
  if (!bridge.connected) {
    if (Date.now() - startedAt > ATTACH_MS) return att({ kind: 'unknown', message: 'The sandbox extension did not attach; open the live view to see the browser', liveView: true });
    return { status: 'connecting', attention: null };
  }
  if (onSignIn()) return att(LOGIN);
  const s = current();
  if (s && s.signedIn === false) return att(LOGIN);
  if (!s) {
    if (tab && !onMail(tab)) return signedInOnce ? att({ kind: 'unknown', message: `Proton Mail is not open in the sandbox (it is on ${hostOf(tab) ?? tab}); open the live view and go back to it`, liveView: true }) : att(LOGIN);
    return { status: 'connecting', attention: null };
  }
  if (!s.signedIn) return { status: 'connecting', attention: null };
  if (signedOut) return att({ kind: 'login', message: 'Proton signed this browser out; sign in again in the live view (tick "Keep me signed in")', liveView: true });
  if (keyError) return att({ kind: 'keys', message: `Signed in, but your keys did not open: ${keyError}`, liveView: false });
  if (!decryptor) return { status: 'connecting', attention: null };
  return { status: 'online', attention: null };
}

function details(): Record<string, string | number | boolean | null> {
  const s = current();
  const c = unlocked?.counts;
  return {
    summaryHeaders: false,
    // One id per message in every mailbox it is in (Proton's message id), and mail.send's limits (mail.ts header).
    idPerMessage: true,
    sendCap: SEND_CAP,
    maxRecipients: MAX_RECIPIENTS,
    email: self?.email ?? null,
    display: liveView ? `:${display}` : null,
    page: tab,
    extensionAttached: bridge.connected,
    mailPage: hookTabs > 0,
    signedIn: s ? s.signedIn : null,
    localID: s?.localID ?? null,
    keptSignedIn: s?.persistent ?? null,
    sessionPayload: s?.payloadVersion ?? null,
    sessionsInBrowser: s?.sessions ?? null,
    appVersion: s?.appVersion ?? null,
    pageHeaders: s?.appHeaders?.length ? s.appHeaders.join(' ') : null,
    pageCalls: s?.appCalls ?? null,
    pageLastStatus: s?.appLastStatus ?? null,
    pageRefreshes: s?.appRefreshes ?? null,
    uidMatchesPage: s?.uidMatches ?? null,
    userKeys: c ? `${c.userOpened} of ${c.userKeys}` : null,
    addresses: c?.addresses ?? pageKeys?.addresses ?? null,
    addressKeys: c ? `${c.addressOpened} of ${c.addressKeys}` : null,
    unlockPath: decryptor?.path ?? null,
    sessionUnlockError,
    pageKeys: pageKeys ? `${pageKeys.keys} keys on ${pageKeys.withKeys} of ${pageKeys.addresses} addresses` : null,
    modules: modules ? MODULE_NAMES.filter((n) => modules!.found[n]).join(' ') || 'none' : null,
    modulesMissing: modules ? MODULE_NAMES.filter((n) => !modules!.found[n]).join(' ') || null : null,
    webpack: modules ? `${modules.runtimes} runtime${modules.runtimes === 1 ? '' : 's'}, ${modules.factories} modules, ${modules.ran} ran` : null,
    sendPath: modules ? (modulesFound(CORE_MODULES) ? 'found' : `missing ${modulesMissing(CORE_MODULES).join(' ')}`) : null,
    sent: sends,
    lastCallAt: api.stats.lastAt ? new Date(api.stats.lastAt).toISOString() : null,
    lastCallStatus: api.stats.lastStatus,
    lastError: api.stats.lastError,
    calls: api.stats.calls,
    events: watch ? (watch.error ? `failed: ${watch.error}` : `read ${new Date(watch.at).toISOString()}`) : null,
    pollSeconds: pollMs / 1000,
    ...sending(),
  };
}

/** status.details.canSend and sendNote: signed in, and what sending needs found in the page (the send path layer). */
function sending(): { canSend: boolean; sendNote: string | null } {
  const s = current();
  if (signedOut || onSignIn() || s?.signedIn === false) return { canSend: false, sendNote: 'Mail cannot be sent: Proton is not signed in. Sign in in the live view.' };
  if (!s?.signedIn) return { canSend: false, sendNote: 'Sending is not checked yet: Proton Mail is still loading in the sandbox browser.' };
  const path = moduleLayers(s)[1];
  if (path.state === 'ok') return { canSend: true, sendNote: null };
  if (path.state === 'waiting') return { canSend: false, sendNote: 'Sending is not checked yet: the Mail page is still loading the parts of it that sending uses.' };
  return {
    canSend: false,
    sendNote: `Mail cannot be sent from this account: parts of Proton's Mail page that sending uses were not found (${modulesMissing(CORE_MODULES).join(', ')}), so sending is refused. Reading, marking, moving and trash still work.`,
  };
}

/** What the account rests on, outermost first: display, browser, extension, signed in, keys unlocked, Proton API. */
function layers(): Layer[] {
  const s = current();
  const browserFailed = !!sandboxError && /chromium/i.test(sandboxError);
  const screen: Layer = liveView
    ? { name: 'display', state: 'ok', note: `Xvfb :${display}, live view ready` }
    : sandboxError && !browserFailed
      ? { name: 'display', state: 'failed', note: sandboxError }
      : browserFailed
        ? { name: 'display', state: 'off', note: 'not started' }
        : { name: 'display', state: 'waiting', note: 'starting Xvfb' };
  const browser: Layer = liveView
    ? sandbox?.browserAlive
      ? { name: 'browser', state: 'ok', note: tab ? `Chromium, on ${hostOf(tab) ?? tab}` : 'Chromium is running' }
      : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' }
    : browserFailed
      ? { name: 'browser', state: 'failed', note: sandboxError! }
      : { name: 'browser', state: 'waiting', note: 'not started yet' };
  const extension: Layer = bridge.connected
    ? { name: 'extension', state: 'ok', note: hookTabs ? 'attached, in the Mail page' : 'attached' }
    : liveView && startedAt && Date.now() - startedAt > ATTACH_MS
      ? { name: 'extension', state: 'failed', note: `did not attach within ${ATTACH_MS / 1000} s` }
      : { name: 'extension', state: 'waiting', note: 'not attached yet' };
  const kept = s?.persistent === false ? '; not kept: sign in again with "Keep me signed in", or a restart signs it out' : '';
  const signedIn: Layer =
    s?.signedIn && signedOut
      ? { name: 'signed in', state: 'failed', note: 'Proton signed this browser out; sign in again in the live view' }
      : s?.signedIn
        ? { name: 'signed in', state: 'ok', note: `${self?.email ?? `session ${s.localID}`}${kept}` }
        : !bridge.connected
          ? { name: 'signed in', state: 'waiting', note: 'waits for the extension' }
          : onSignIn() || s?.signedIn === false || (tab && !onMail(tab) && !signedInOnce)
            ? { name: 'signed in', state: 'waiting', note: 'sign in to Proton in the live view' }
            : tab && !onMail(tab)
              ? { name: 'signed in', state: 'waiting', note: `Proton Mail is not open (the tab is on ${hostOf(tab) ?? tab})` }
              : { name: 'signed in', state: 'waiting', note: 'Proton Mail is loading' };
  const c = unlocked?.counts;
  const keysLayer: Layer =
    decryptor?.path === 'session' && c
      ? { name: 'keys unlocked', state: 'ok', note: `${c.addressOpened} of ${c.addressKeys} address keys on ${c.addresses} address${c.addresses === 1 ? '' : 'es'}, from the saved session` }
      : decryptor?.path === 'page'
        ? { name: 'keys unlocked', state: 'ok', note: `through the page's crypto proxy (${pageKeys ? `${pageKeys.keys} keys on ${pageKeys.withKeys} of ${pageKeys.addresses} addresses` : "the app's keys"}); the saved-session unlock failed: ${sessionUnlockError ?? '?'}` }
        : keyError
      ? { name: 'keys unlocked', state: 'failed', note: keyError }
      : unlocking
        ? { name: 'keys unlocked', state: 'waiting', note: 'opening the session and the keys' }
        : { name: 'keys unlocked', state: 'waiting', note: s?.signedIn ? 'not tried yet' : 'waits for the sign-in' };
  const st = api.stats;
  const failedLast = st.lastStatus !== null && (st.lastStatus < 200 || st.lastStatus >= 300) && st.lastAt > st.lastOkAt;
  const apiLayer: Layer =
    st.lastOkAt && !failedLast
      ? { name: 'Proton API', state: 'ok', note: `answered ${st.lastStatus}, ${new Date(st.lastAt).toISOString().slice(0, 16).replace('T', ' ')} UTC${watch?.error ? `; events: ${watch.error}` : watch ? '; following events' : ''}` }
      : failedLast && st.lastStatus! >= 500
        ? { name: 'Proton API', state: 'failed', note: st.lastError ?? `answered ${st.lastStatus}` }
        : failedLast
          ? { name: 'Proton API', state: st.lastStatus === 401 ? 'failed' : 'waiting', note: st.lastError ?? `answered ${st.lastStatus}` }
          : { name: 'Proton API', state: 'waiting', note: s?.signedIn ? 'no call yet' : 'waits for the sign-in' };
  return [screen, browser, extension, signedIn, keysLayer, apiLayer, ...moduleLayers(s)];
}

/** The app's modules the hook found (what the page-side unlock needs), then the send path, which needs the same. */
function moduleLayers(s: Session | null): Layer[] {
  const list = (names: string[]) => names.join(', ');
  if (!s?.signedIn || !modules) {
    const note = !bridge.connected ? 'waits for the extension' : s?.signedIn ? 'the hook has not reported yet' : 'waits for the Mail page';
    return [
      { name: 'app modules', state: 'waiting', note },
      { name: 'send path', state: 'waiting', note },
    ];
  }
  const late = Date.now() - modules.since > MODULES_GRACE_MS;
  const coreMissing = modulesMissing(CORE_MODULES);
  const core: Layer = !coreMissing.length
    ? { name: 'app modules', state: 'ok', note: `found ${list([...CORE_MODULES])}` }
    : late
      ? { name: 'app modules', state: 'failed', note: `not found: ${list(coreMissing)}; sending and the page-side unlock need them${modules.runtimes ? '' : ' (the hook never reached the app\'s webpack)'}` }
      : { name: 'app modules', state: 'waiting', note: `looking; not found yet: ${list(coreMissing)}` };
  const sendPath: Layer = !coreMissing.length
    ? { name: 'send path', state: 'ok', note: `the page's API caller, store, crypto proxy and address keys found; mail.send sends to Proton users and to outside addresses without a key, and refuses the rest${sends ? ` (${sends} sent)` : ''}` }
    : late
      ? { name: 'send path', state: 'failed', note: `not found in the page: ${list(coreMissing)}; mail.send refuses (see docs/proton.md, "Sending")` }
      : { name: 'send path', state: 'waiting', note: `looking; not found yet: ${list(coreMissing)}` };
  return [core, sendPath];
}

let lastSent = '';
function status(force = false) {
  const st = state();
  const ev = { t: 'status', status: st.status, attention: st.attention, liveView, ...(self ? { self } : {}), details: details(), layers: layers() };
  const s = JSON.stringify(ev);
  if (s === lastSent && !force) return;
  lastSent = s;
  link.emit(ev);
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
      log('debug', 'mail page hook up', { page: msg.page });
      break;
    case 'modules': {
      // Names we know and found or not; counts. Nothing else is kept from it.
      const found: Record<string, boolean> = {};
      for (const n of MODULE_NAMES) found[n] = msg.found?.[n] === true;
      const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
      const was = modules;
      const now = MODULE_NAMES.filter((n) => found[n]);
      // Fewer found than before: a new page (a reload); its modules get their time to load again.
      const since = was && now.length >= MODULE_NAMES.filter((n) => was.found[n]).length ? was.since : Date.now();
      modules = { found, runtimes: int(msg.runtimes), factories: int(msg.factories), ran: int(msg.ran), since };
      if (!was || now.length !== MODULE_NAMES.filter((n) => was.found[n]).length) log('info', `modules: found ${now.join(' ') || 'nothing yet'}`, { missing: MODULE_NAMES.filter((n) => !found[n]), runtimes: modules.runtimes, factories: modules.factories });
      // The page's keys may be what the unlock was waiting for.
      if (!decryptor && !unlocking && keyError && sessionUnlockError && modulesFound(CORE_MODULES)) {
        keyError = null;
        void unlock().catch(() => {});
      }
      break;
    }
    case 'session': {
      const { t: _t, ...s } = msg;
      const was = session?.signedIn;
      session = { ...s, appHeaders: Array.isArray(s.appHeaders) ? s.appHeaders.slice(0, 40).map(String) : [], appVersion: typeof s.appVersion === 'string' ? s.appVersion.slice(0, 80) : null };
      if (session.signedIn !== was) log('info', `mail page: ${session.signedIn ? 'signed in' : session.signedIn === false ? 'not signed in' : 'loading'}`, { localID: session.localID, persistent: session.persistent, payloadVersion: session.payloadVersion });
      if (session.signedIn) {
        signedInOnce = true;
        if (was !== true) {
          // A (new) sign-in: whatever stopped the last one is worth trying again.
          signedOut = false;
          keyError = null;
        }
        if (!decryptor && !unlocking && !keyError) void unlock().catch(() => {});
      } else if (session.signedIn === false) {
        unlocked = null;
        decryptor = null;
        pageKeys = null;
        keyError = null;
        sessionUnlockError = null;
        self = null;
        senders = null;
      }
      break;
    }
  }
  status();
}

// ------------------------------------------------------------------- unlock
/** The account and its addresses, as the app reads them when it starts. */
async function account(): Promise<{ User: ProtonUser; addresses: ProtonAddress[] }> {
  const { User } = await api.call<{ User?: ProtonUser }>({ method: 'GET', path: 'core/v4/users' });
  if (!User) throw new KeyError('Proton gave no user');
  const addresses: ProtonAddress[] = [];
  for (let page = 0; page < 20; page++) {
    const r = await api.call<{ Addresses?: ProtonAddress[]; Total?: number }>({ method: 'GET', path: 'core/v4/addresses', query: { Page: page, PageSize: 50 } });
    addresses.push(...(r.Addresses ?? []));
    if (!r.Addresses?.length || addresses.length >= (r.Total ?? 0)) break;
  }
  return { User, addresses };
}

function setSelf(User: ProtonUser, addresses: ProtonAddress[]) {
  const enabled = addresses.filter((a) => (a.Status ?? 1) === 1).sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
  const primary = enabled[0] ?? addresses[0];
  const name = User.DisplayName || primary?.DisplayName || User.Name || null;
  senders = sendingAddresses(addresses);
  const list = senders.map(({ email, name }) => ({ email, name }));
  self = primary ? { email: primary.Email, ...(name ? { displayName: name } : {}), addresses: list } : User.Email ? { email: User.Email, addresses: list } : null;
}

/** The sending addresses, read now if the unlock has not read them yet. */
async function sendingNow(): Promise<SendingAddress[]> {
  if (!senders) {
    const { User, addresses } = await account();
    setSelf(User, addresses);
    status();
  }
  return senders ?? [];
}

/**
 * The first way in: the key password out of the persisted session, then the keys, opened here. GET
 * auth/v4/sessions/local/key gives the ClientKey, which opens `ps-<localID>`'s blob; core/v4/users and core/v4/addresses
 * give the locked keys. A KeyError says this way is closed (the format moved, the call changed, the password does not
 * open the keys); anything else (the page away, Proton busy, signed out) is passed on as it is.
 */
async function sessionUnlock(): Promise<{ got: Unlocked; User: ProtonUser; addresses: ProtonAddress[] }> {
  const st = await bridge.request<{ UserID: string; blob: string; payloadVersion: number; persistent: boolean; offline: boolean }>({ kind: 'storage' }, 30_000).catch((e) => {
    throw new StatusError(String((e as Error).message ?? e), 503);
  });
  if (!st || typeof st !== 'object') throw new KeyError('the page gave no persisted session');
  if (typeof st.blob !== 'string' || !st.blob) throw new KeyError('the session keeps no key password (a session without one, as a sub-user or VPN-only session has)');
  let ClientKey: string | undefined;
  try {
    ({ ClientKey } = await api.call<{ ClientKey?: string }>({ method: 'GET', path: 'auth/v4/sessions/local/key' }));
  } catch (e) {
    // Refused outright (not signed out, not busy, not a human check): the call is not what it was.
    if (e instanceof ProtonError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) throw new KeyError(`Proton refused the ClientKey call (${e.status}${e.code !== null ? ` code ${e.code}` : ''})`);
    throw e;
  }
  if (typeof ClientKey !== 'string' || !ClientKey) throw new KeyError('Proton gave no ClientKey for this session');
  let keyPassword: string;
  try {
    keyPassword = (await openSessionBlob(st.blob, ClientKey, Number(st.payloadVersion))).keyPassword;
  } catch (e) {
    throw new KeyError(String((e as Error).message ?? e));
  }
  const { User, addresses } = await account();
  if (st.UserID && User.ID !== st.UserID) throw new KeyError('the session belongs to another user than the one signed in');
  const got = await unlockKeys(User, addresses, keyPassword);
  keyPassword = '';
  return { got, User, addresses };
}

/**
 * The second way in, when the first is closed: the page's own crypto proxy with the app's own keys (the hook's
 * `pagekeys` and `decrypt`). The keys never leave the page; this side only learns counts, and the plaintext of what it
 * asks to decrypt.
 */
async function pageUnlock(): Promise<{ addresses: number; withKeys: number; keys: number }> {
  // The page may still be loading its modules: give it its time.
  const until = Date.now() + MODULES_GRACE_MS;
  while (!modulesFound(CORE_MODULES) && bridge.connected && Date.now() < until && (!modules || Date.now() - modules.since < MODULES_GRACE_MS)) await Bun.sleep(500);
  if (!modulesFound(CORE_MODULES)) throw new KeyError(`the page's modules for decrypting there were not found (${modulesMissing(CORE_MODULES).join(', ')})`);
  const r = await pageCall<{ addresses?: unknown; withKeys?: unknown; keys?: unknown }>({ kind: 'pagekeys' }, 60_000).catch((e) => {
    if (e instanceof StatusError) throw e;
    throw new KeyError(`the app's keys did not open in the page: ${String((e as Error).message ?? e).slice(0, 160)}`);
  });
  const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
  const counts = { addresses: int(r?.addresses), withKeys: int(r?.withKeys), keys: int(r?.keys) };
  if (counts.addresses === null || counts.withKeys === null || !counts.keys) throw new KeyError('the page answered without its keys');
  return counts as { addresses: number; withKeys: number; keys: number };
}

function unlock(force = false): Promise<Decryptor> {
  if (unlocking) return unlocking;
  if (decryptor && !force) return Promise.resolve(decryptor);
  unlocking = (async () => {
    try {
      try {
        const { got, User, addresses } = await sessionUnlock();
        setSelf(User, addresses);
        unlocked = got;
        pageKeys = null;
        sessionUnlockError = null;
        decryptor = localDecryptor(got);
        log('info', 'keys unlocked from the saved session', got.counts);
      } catch (e) {
        if (!(e instanceof KeyError)) throw e;
        const why = e.message.slice(0, 200);
        if (sessionUnlockError !== why) log('warn', "the saved-session unlock failed; trying the page's crypto proxy", why);
        sessionUnlockError = why;
        try {
          pageKeys = await pageUnlock();
        } catch (pe) {
          if (pe instanceof KeyError) throw new KeyError(`${why}; and ${pe.message}`);
          throw pe;
        }
        const { User, addresses } = await account();
        setSelf(User, addresses);
        unlocked = null;
        decryptor = pageDecryptor;
        log('info', "keys unlocked through the page's crypto proxy", pageKeys);
      }
      keyError = null;
      schedulePoll(0);
      return decryptor!;
    } catch (e) {
      if (e instanceof KeyError) {
        keyError = e.message.slice(0, 300);
        log('warn', 'keys did not unlock', keyError);
      } else log('warn', 'could not unlock yet', String((e as Error).message ?? e).slice(0, 200));
      throw e instanceof StatusError ? e : new StatusError(`your keys did not open: ${String((e as Error).message ?? e).slice(0, 200)}`, 422);
    } finally {
      unlocking = null;
      status();
    }
  })();
  status();
  return unlocking;
}

// ------------------------------------------------------------------- events
function schedulePoll(ms: number) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void poll().finally(() => schedulePoll(pollMs)), ms);
}
/** After our own writes: read the events they made soon, so mail.changed goes out at once. */
function pollSoon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => void poll(), 300);
}

/**
 * Follow Proton's event loop (core/v5/events, as the web app): mail.changed for each mailbox the events touch, with
 * the new state, and mail.arrived for new mail in the inbox. Where it got to is kept in events.json, so a restart
 * announces what came meanwhile. A refresh (or an id Proton forgot) restarts from the latest event and says every
 * mailbox changed, so apps ask, get 410 and list again.
 */
async function poll(): Promise<void> {
  if (polling || !bridge.connected || !current()?.signedIn || signedOut) return;
  polling = true;
  try {
    await mail.labelSets();
    let from = watchId;
    if (!from) {
      from = await mail.latestEvent();
      saveWatch(from);
      watch = { at: Date.now(), error: null };
      return;
    }
    let id = from;
    let refreshed = false;
    let relock = false;
    let relabel = false;
    const boxes = new Set<string>();
    const arrived: ReturnType<typeof arrivals> = [];
    for (let page = 0; page < EVENT_PAGES; page++) {
      let ev;
      try {
        ev = await mail.eventPage(id, 'Timer');
      } catch (e) {
        if (e instanceof StatusError && e.status === 410) {
          log('info', 'events: Proton asks for a refresh; starting from the latest event');
          refreshed = true;
          id = await mail.latestEvent();
          break;
        }
        throw e;
      }
      for (const b of touched(ev)) boxes.add(b);
      arrived.push(...arrivals(ev));
      if (ev.Addresses?.length || ev.User) relock = true;
      if (ev.Labels?.length) relabel = true;
      id = ev.EventID;
      if (!ev.More) break;
    }
    const sets = await mail.labelSets(relabel);
    const isBox = (b: string) => SYSTEM.some((s) => s.id === b) || sets.folders.has(b);
    const changedBoxes = refreshed ? [...SYSTEM.map((s) => s.id), ...sets.folders.keys()] : [...boxes].filter(isBox);
    if (id !== from || refreshed) {
      for (const b of changedBoxes) link.emit({ t: 'mail.changed', mailboxId: b, state: stateOf(id) });
      for (const m of arrived.slice(-CATCH_UP)) link.emit({ t: 'mail.arrived', message: mail.summary(m, '0') });
      if (changedBoxes.length || arrived.length) log('info', `events: ${changedBoxes.length} mailbox${changedBoxes.length === 1 ? '' : 'es'} changed, ${arrived.length} arrived`);
      saveWatch(id);
    }
    watch = { at: Date.now(), error: null };
    if (relock && decryptor) {
      log('info', 'events: addresses or user changed; unlocking the keys again');
      void unlock(true).catch(() => {});
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 160);
    watch = { at: Date.now(), error: msg };
    log('warn', 'events: could not read', msg);
  } finally {
    polling = false;
    status();
  }
}

function saveWatch(id: string) {
  watchId = id;
  try {
    writeFileSync(eventsPath, JSON.stringify({ eventId: id }), { mode: 0o600 });
  } catch {}
}

// -------------------------------------------------------------------- calls
function ready() {
  if (!bridge.connected) throw new StatusError('the sandbox browser is not attached yet', 503);
  const s = current();
  if (onSignIn() || s?.signedIn === false) throw new StatusError('Proton is not signed in; sign in in the live view', 401);
  if (!s) throw new StatusError('Proton Mail is not open in the sandbox', 503);
  if (!s.signedIn) throw new StatusError('Proton Mail is still loading', 503);
}

async function onCommand(cmd: Command): Promise<unknown> {
  ready();
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (cmd.t) {
    case 'mail.mailboxes':
      return mail.mailboxes();
    case 'mail.list':
      return mail.list({ mailboxId: String(cmd.mailboxId), limit: cmd.limit as number | undefined, before: str(cmd.before), since: cmd.since as number | undefined });
    case 'mail.get':
      return mail.get(String(cmd.id));
    case 'mail.attachment':
      return mail.attachment(String(cmd.id), String(cmd.attachmentId));
    case 'mail.search':
      return mail.search({ query: String(cmd.query ?? ''), mailboxId: str(cmd.mailboxId), limit: cmd.limit as number | undefined });
    case 'mail.changes':
      return mail.changes({ mailboxId: String(cmd.mailboxId), state: str(cmd.state), limit: cmd.limit as number | undefined });
    case 'mail.flag': {
      const r = await mail.flag(cmd as any);
      pollSoon();
      return r;
    }
    case 'mail.move': {
      const r = await mail.move(cmd as any);
      pollSoon();
      return r;
    }
    case 'mail.trash': {
      const r = await mail.trash(cmd as any);
      pollSoon();
      return r;
    }
    case 'mail.send': {
      const { t: _t, id: _id, ...input } = cmd;
      const m = checkOutgoing(input as any, link.accountDir);
      const r = await send(m, { api, page: (c, ms) => pageCall({ kind: 'send', ...c } as Down, ms), addresses: sendingNow, log });
      sends++;
      pollSoon();
      status();
      return r;
    }
    default:
      throw new StatusError(`proton has no operation "${cmd.t}"`, 400);
  }
}

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake Proton's origin too. */
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
      accountDir: link.accountDir,
      display: free.display,
      width: WIDTH,
      height: HEIGHT,
      extensionSrc: join(import.meta.dir, 'extension'),
      config: { wsUrl: bridge.wsUrl, token: bridgeToken, testOrigin },
      prepareExtension: testOrigin ? addTestOrigin : undefined,
      startUrl: `${mailOrigin}/`,
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
  timers.push(setTimeout(() => status(), ATTACH_MS + 500));
  timers.push(
    setInterval(() => {
      if (sandbox && !sandbox.browserAlive) {
        log('warn', 'chromium exited; exiting for a supervised restart');
        void cleanup().then(() => process.exit(1));
      }
    }, 5000),
  );
  schedulePoll(pollMs);
}

// ---------------------------------------------------------------- lifecycle
function onConnect() {
  link.emit({ t: 'hello', network: 'proton', version: '1', interfaces: ['mail'], startedAt: STARTED, capabilities: ['liveView'] });
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(pollTimer);
    clearTimeout(soonTimer);
    unlocked = null;
    decryptor = null;
    try {
      bridge.stop();
    } catch {}
    try {
      await sandbox?.stop();
    } catch {}
  })();
  return cleaning;
}

boot().catch((e) => {
  log('error', 'boot failed', String(e?.message ?? e));
  void cleanup().then(() => process.exit(1));
});
