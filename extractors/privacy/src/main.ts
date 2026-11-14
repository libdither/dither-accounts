/**
 * The privacy extractor: one Privacy.com account in a sandboxed browser (packages/browser: Xvfb, an ordinary Chromium
 * with a persistent profile and this kind's extension, x11vnc for the live view; no CDP, no automation), whose
 * extension carries its own passkey for privacy.com (docs/privacy.md).
 *
 * You sign in once in the live view, then add a passkey in Privacy's settings: the page's navigator.credentials.create
 * reaches this process (hook.js → content.js → sw.js → the token-gated loopback bridge, with the caller's origin as
 * Chromium reports it), and the authenticator (packages/passkey, top frames only) makes the key pair, keeps it in the account's
 * secret.json (mode 600) and answers with "none" attestation. Later sign-ins with it are answered the same way, the
 * counter saved before each assertion goes out. The private key never enters the browser.
 *
 * Statements (docs/statements.md): dither-finance's privacy/pcom.py `pull`, ported (pcom.ts). Privacy's sessions are
 * short, so before each pull the account signs itself in when it finds itself signed out (not at start: a session
 * nothing pulls with ends within minutes, and every restart would ask Privacy again): it
 * loads the app, clicks the sign-in page's passkey button (as you would) and the authenticator answers; a few tries
 * with backoff. Anything only you can give (a code, a captcha, a password) stops it: the account holds every pull
 * until the live view shows Privacy signed in again. A passkey on a paired phone that the phone refuses stops it too,
 * with no more tries (packages/passkey signin.ts: denied waits for a pull you start, unanswered for the next scheduled
 * pull). Then it loads /transactions, where the app makes its own
 * transactions request; the page hook keeps that request's URL and headers (in the page) and pages it as pcom.py did,
 * from the page, and the file is pcom.py's privacy-<stamp>.json byte for byte.
 *
 * Config: { testOrigin?, noSandbox?, pullAt?, jitterMinutes?, schedule?, signInOnStart? (false: sign in at start
 * too, when signed out), paceScale? (tests) }.
 * secret.json: { passkeys: StoredCredential[] }. state.json: pcom.ts PrivacyState (seeded once by seed.ts). Logs ids'
 * first 8 characters, counts, page paths and statuses: never a key, a full credential id, a user handle, a challenge,
 * a counter, a header or an amount.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type { PrivacySession } from '@dither-accounts/interfaces';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { NeedsYou, type PullOutcome, StatementsRunner, type Why, writeWhole } from '@dither-accounts/statements-common';
import { ALG_NAMES, approverVia, Authenticator, PasskeySignIn, refusalNote, respond, secretStore, type Trigger, type Try as SignInTry, type WebauthnUp } from '@dither-accounts/passkey';
import { compareWithSeed, parseQsl, type PrivacyState, privacyFile, pullTransactions } from './pcom.ts';
import { challengeOf, details, layers, type PageKind, pageKind, type PageState, SETTLE_MS, state, statementsBlocked, type View } from './status.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** The extension should be talking to us this soon after the browser starts. */
const ATTACH_MS = 30_000;
/** A sign-in that used the passkey must reach the app within this long to count as checked. */
const CHECK_WINDOW_MS = 3 * 60_000;

type Up =
  | { t: 'ready' }
  | { t: 'reply'; id: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { t: 'tabs'; tabs: { id: number; url: string; active: boolean; loading?: boolean; hook: boolean }[] }
  | { t: 'hook'; page: string }
  | WebauthnUp;
type Down =
  | { kind: 'webauthn.answer'; sid: string; ok: boolean; result?: unknown; error?: string; code?: string }
  | { kind: 'tab.go'; url: string }
  | { kind: 'page.state' | 'page.passkey' | 'txn.request' }
  | { kind: 'txn.get'; url: string };

const link = linkManager({ onConnect, onCommand, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);

const cfg = link.config;
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const appOrigin = testOrigin ?? 'https://app.privacy.com';
/** The relying party domains the passkey answers for: privacy.com (and, in tests, the fake's host). */
const DOMAINS = testOrigin ? ['privacy.com', new URL(testOrigin).hostname] : ['privacy.com'];
const STARTED = Date.now();
/** Tests pace faster (0..1): the sign-in's backoff and waits. */
const scale = Math.max(0.01, Math.min(1, Number(cfg.paceScale ?? 1) || 1));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Automatic sign-in: the waits before each try (so at most three tries). */
const BACKOFF_MS = [0, 20_000, 60_000];
/** The sign-in page is up this long before its passkey button is clicked; a click with no answer is repeated after. */
const HYDRATE_MS = 3000;
const RECLICK_MS = 10_000;

// -------------------------------------------------------------------- state
// secret.json's passkeys, written whole (tmp + fsync + rename, mode 600), the rest of the file kept. Top frames only.
// A passkey on a paired phone (docs/approver.md) goes there through the manager.
const auth = new Authenticator(secretStore(link), DOMAINS, Date.now, 'top', undefined, approverVia(link));


let display: number | null = null;
let liveView: { vncSocket: string; width: number; height: number } | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tab: string | null = null;
let kind: PageKind = 'none';
/** Since when the tab has been on the app (not a sign-in page), uninterrupted; 0 when it is not. */
let appSince = 0;
let signedIn = false;
/** The last assertion handed out while not signed in: if the app follows, the passkey works. */
let pendingCheck: { id: string; at: number } | null = null;
let lastRefusal: string | null = null;
const counts = { creations: 0, assertions: 0, refusals: 0 };
/** When a privacy.com page's hook last said it was up (a page that loaded). */
let lastHookAt = 0;

// state.json (pcom.ts PrivacyState): the seed, the last pull, a hold. No amounts, no secrets.
const stateFile = join(link.accountDir, 'state.json');
function loadState(): PrivacyState {
  try {
    if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (e) {
    log('warn', 'state.json is unreadable; starting from nothing', String((e as Error).message).slice(0, 200));
  }
  return {};
}
let st = loadState();
const saveState = () => writeWhole(stateFile, JSON.stringify(st, null, 1));

/** Signing in by itself: the tries, and what a paired phone's refusal stops (kept in state.json). */
const signin = new PasskeySignIn({
  site: 'Privacy',
  backoff: BACKOFF_MS.map((ms) => ms * scale),
  sleep,
  load: () => st.approval ?? null,
  save: (r) => {
    st.approval = r;
    saveState();
  },
  log,
  needsYou: (message, kind) => new NeedsYou(message, kind),
  onChange: () => status(),
});
/** Why a paired phone is asked (docs/approver.md): the line its prompt shows. */
auth.reasonFor = (op) => (op === 'create' ? 'Add a passkey (in the live view)' : signin.reason());
const timers: Timer[] = [];
let settleTimer: Timer | undefined;

const bridgeToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
const bridge = new BridgeServer<Up, Down>({
  token: bridgeToken,
  onMessage: (m) => void onBridge(m),
  onConnect: () => status(),
  onDisconnect: () => status(),
  log,
});

// ------------------------------------------------------------------- status
function view(): View {
  return {
    sandboxError,
    display: liveView ? display : null,
    liveView: !!liveView,
    browserAlive: !!sandbox?.browserAlive,
    attached: bridge.connected,
    attachOverdue: !!liveView && !!startedAt && Date.now() - startedAt > ATTACH_MS,
    page: tab,
    kind,
    signedIn,
    passkey: auth.summary(),
    lastRefusal,
    auto: { signingIn: signin.signingIn, hold: st.hold ?? null, failed: signin.failed, lastOkAt: signin.lastOkAt, approval: signin.refusal },
  };
}

let lastSent = '';
function status(force = false) {
  const v = view();
  const s = state(v);
  const d = {
    ...details(v, counts),
    autoSignInsThisRun: signin.tries,
    approval: signin.refusal ? refusalNote(signin.refusal) : null,
    lastPullTransactions: stState().lastPull?.transactions ?? null,
    seedFile: stState().seed?.file ?? null,
    seedCheck: (() => {
      const c = stState().checked;
      return c ? `${c.same} same, ${c.changed} changed, ${c.added} new, ${c.gone} gone; transactionFilter ${c.transactionFilterSame ? 'same' : 'different'}` : stState().seed ? 'pending: the first pull' : null;
    })(),
    ...statements.details(),
  };
  const ev = { t: 'status', status: s.status, attention: s.attention, liveView, details: d, layers: [...layers(v), statements.pullLayer()] };
  const j = JSON.stringify(ev);
  if (j === lastSent && !force) return;
  lastSent = j;
  link.emit(ev);
}

const pathOf = (u: string | null) => {
  try {
    return u ? new URL(u).pathname : null;
  } catch {
    return null;
  }
};

/** Signed in once the app has stayed on a page that is not a sign-in page for SETTLE_MS. */
function settle() {
  const now = Date.now();
  const was = signedIn;
  // A passkey answer handled after the tab already reported the app (its save is slow) zeroes appSince; the tab then
  // stays where it is and reports nothing new, so the app page starts its settling again here.
  if (kind === 'app' && !appSince) appSince = now;
  signedIn = !!appSince && now - appSince >= SETTLE_MS && bridge.connected;
  if (signedIn && !was) {
    log('info', 'signed in to Privacy', { page: pathOf(tab) });
    signin.signedIn();
    if (st.hold) {
      log('info', `Privacy is signed in again: the hold (${st.hold.what}) is lifted`);
      st.hold = null;
      saveState();
    }
    if (pendingCheck && now - pendingCheck.at <= CHECK_WINDOW_MS + SETTLE_MS) {
      const id = pendingCheck.id;
      pendingCheck = null;
      void auth.markVerified(id).then(
        () => {
          log('info', 'a sign-in with the passkey went through', { credential: `${id.slice(0, 8)}…` });
          status();
        },
        (e) => log('warn', 'could not record the passkey check', String((e as Error)?.message ?? e).slice(0, 200)),
      );
    }
  }
  if (!signedIn && was) log('info', 'no longer signed in', { page: kind === 'other' ? null : pathOf(tab) });
  if (pendingCheck && now - pendingCheck.at > CHECK_WINDOW_MS + SETTLE_MS) pendingCheck = null;
  status();
}

// ------------------------------------------------------------------- bridge
async function onBridge(msg: Up) {
  switch (msg.t) {
    case 'ready':
      log('info', 'extension service worker ready');
      break;
    case 'log':
      log(['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'debug', `[hook] ${String(msg.msg).slice(0, 200)}`);
      break;
    case 'hook':
      lastHookAt = Date.now();
      log('debug', 'privacy.com page hook up', { page: typeof msg.page === 'string' ? msg.page.slice(0, 200) : null });
      break;
    case 'tabs': {
      const tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      const active = tabs.find((t) => t.active) ?? tabs[0];
      const was = tab;
      tab = typeof active?.url === 'string' && active.url ? active.url.slice(0, 300) : null;
      kind = pageKind(tab, appOrigin);
      if (kind === 'app') appSince ||= Date.now();
      else appSince = 0;
      if (tab !== was) log('info', `tab on ${tab ?? 'nothing'}`);
      settle();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_MS + 100);
      break;
    }
    case 'webauthn':
      await onWebauthn(msg);
      break;
  }
}

async function onWebauthn(m: WebauthnUp) {
  const where = typeof m.page === 'string' && m.page ? m.page.slice(0, 200) : null;
  const r = await respond(auth, m);
  if (r.made) {
    counts.creations++;
    log('info', 'passkey created and stored', { credential: `${r.made.id.slice(0, 8)}…`, algorithm: ALG_NAMES[r.made.publicKeyAlgorithm], page: where });
  } else if (r.none) {
    log('info', 'a passkey sign-in asked for a credential this browser does not hold: left to the browser', { page: where });
  } else if (r.used) {
    counts.assertions++;
    // A sign-in with it (not a re-check inside the app): from a sign-in page, as Chromium reports the caller's
    // page, or while not signed in. The tab reports can lag a fast sign-out and sign-in, so the caller's page
    // also says the app was left: the sign-in that follows has to settle again, and then counts.
    const from = pageKind(m.page, appOrigin);
    if (from === 'signin' || from === 'site' || !signedIn) {
      pendingCheck = { id: r.used.id, at: Date.now() };
      if (from !== 'app') {
        appSince = 0;
        signedIn = false;
      }
    }
    log('info', 'passkey sign-in answered', { credential: `${r.used.id.slice(0, 8)}…`, page: where });
  } else {
    const err = r.refused;
    counts.refusals++;
    lastRefusal = `${m.op === 'create' ? 'create' : 'get'}: ${err.message}`.slice(0, 200);
    log('warn', 'passkey request refused', { op: m.op, code: err.code, reason: err.message.slice(0, 200), origin: typeof m.origin === 'string' ? m.origin.slice(0, 100) : null });
    // The phone said no while this was signing in by itself: that sign-in stops (signin.ts).
    signin.note(err);
  }
  try {
    await bridge.request({ kind: 'webauthn.answer', sid: String(m.sid), ...r.answer }, 10_000);
  } catch (e) {
    log('warn', 'the passkey answer did not reach the page', String((e as Error)?.message ?? e).slice(0, 200));
  }
  status();
}

// ----------------------------------------------------------------- commands
function session(): PrivacySession {
  const p = auth.summary();
  const n = p.newest;
  return {
    signedIn,
    page: tab,
    passkey: {
      enrolled: p.enrolled,
      count: p.count,
      credentialIdPrefix: n?.idPrefix ?? null,
      algorithm: n?.algorithm ?? null,
      rpId: n?.rpId ?? null,
      createdAt: n?.createdAt ?? null,
      lastUsedAt: n?.lastUsedAt ?? null,
      signInCheckedAt: n?.verifiedAt ?? null,
    },
  };
}

async function onCommand(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'privacy.session':
      return session();
    default: {
      const r = statements.handle(cmd);
      if (r !== undefined) return r;
    }
  }
  throw new StatusError(`unknown op ${cmd.t}`, 400);
}

// ------------------------------------------------------------ the page, through the extension
const stState = () => st;
const until = async (f: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await sleep(250);
  }
  return f();
};
/** A command for the privacy.com page (hook.js); retried while the page is between loads. */
async function page<T>(cmd: Down, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await bridge.request<T>(cmd, Math.max(1000, Math.min(ms, end - Date.now())));
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (Date.now() >= end || !/not open|went away|disconnected|not connected|timed out/i.test(m)) throw e;
      await sleep(400);
    }
  }
}
const pageState = () => page<PageState>({ kind: 'page.state' }).catch(() => null);
/** Load a page in the account's tab and wait for its hook (a page that loaded after this call). */
async function goTo(path: string): Promise<boolean> {
  const t0 = Date.now();
  await bridge.request({ kind: 'tab.go', url: `${appOrigin}${path}` }, 15_000);
  return until(() => lastHookAt > t0, 30_000);
}

/** One try (packages/passkey signin.ts): a hold is what Privacy asks of you. */
type Try = SignInTry<{ what: string; message: string }>;

/** One try: the app; if it lands on the sign-in page, the passkey button; then the app settled, or why not. */
async function signInOnce(): Promise<Try> {
  if (kind !== 'signin') {
    // The app goes to its home when signed in, and to /login when not.
    if (!(await goTo('/'))) return { ok: false, reason: 'the app did not load' };
  }
  let ps: PageState | null = null;
  const ready = await (async () => {
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      if (signedIn) return true;
      if (kind === 'signin') {
        ps = await pageState();
        if (ps && (challengeOf(ps, false) || ps.passkeyButton)) return true;
      }
      await sleep(500);
    }
    return false;
  })();
  if (signedIn) return { ok: true };
  if (!ready || !ps) return { ok: false, reason: kind === 'signin' ? "Privacy's sign-in page shows no passkey option" : 'the app did not settle on a page' };
  const pre = challengeOf(ps, false);
  if (pre) return { ok: false, reason: pre.what, hold: pre };
  // Privacy's sign-in page is prerendered: its button shows before the app has hydrated it, and a click then does
  // nothing. So the page has been up a few seconds first, and a click that brings no passkey request is repeated.
  await until(() => Date.now() - lastHookAt >= HYDRATE_MS * scale, HYDRATE_MS);
  const before = counts.assertions;
  const end = Date.now() + 45_000;
  let clicks = 0;
  let lastClick = 0;
  log('info', 'signing in with the passkey', { page: pathOf(tab) });
  while (Date.now() < end) {
    if (signedIn) return { ok: true };
    // The paired phone refused: no click again (each would ask it once more).
    if (signin.stopped) return { ok: false, reason: 'the approver refused' };
    if (counts.assertions === before && clicks < 3 && Date.now() - lastClick >= RECLICK_MS * scale && kind === 'signin') {
      const clicked = await page<{ clicked: boolean }>({ kind: 'page.passkey' }).catch(() => ({ clicked: false }));
      if (!clicked.clicked && !clicks) return { ok: false, reason: 'the passkey button could not be clicked' };
      if (clicked.clicked) clicks++;
      lastClick = Date.now();
    }
    if (counts.assertions > before && kind === 'signin') {
      const now = await pageState();
      const c = now && challengeOf(now, true);
      if (c) return { ok: false, reason: c.what, hold: c };
    }
    await sleep(500);
  }
  return { ok: false, reason: counts.assertions > before ? 'Privacy did not finish the sign-in after the passkey answered' : 'Privacy did not ask for the passkey' };
}

/** Sign in with the passkey when signed out: a few tries with backoff; a question only you can answer holds, and a
 * refusal from a paired phone stops the tries (signin.ts). */
async function signIn(trigger: Trigger): Promise<void> {
  if (signedIn) return;
  const blocked = statementsBlocked({ attached: bridge.connected, passkey: auth.summary(), hold: st.hold ?? null });
  if (blocked) throw new NeedsYou(blocked);
  await signin.run<{ what: string; message: string }>(trigger, () => signInOnce(), {
    done: () => signedIn,
    hold: (c) => {
      st.hold = { ...c, since: Date.now() };
      saveState();
      log('warn', `Privacy asks for ${c.what}: holding pulls until it is signed in again in the live view`, { page: pathOf(tab) });
      return new NeedsYou(c.message);
    },
    failed: (last) => `Signing in to Privacy with the passkey did not work (${last}): sign in in the live view, choosing the passkey option.`,
  });
}
let signingIn: Promise<void> | null = null;
function ensureSignedIn(trigger: Trigger): Promise<void> {
  if (signedIn) return Promise.resolve();
  signingIn ??= signIn(trigger).finally(() => {
    signingIn = null;
  });
  return signingIn;
}

/** /transactions, where the app makes its own transactions request: its URL, or null when signed out on the way. */
async function transactionsPage(): Promise<string | null> {
  if (!(await goTo('/transactions'))) throw new Error('the transactions page did not load');
  const end = Date.now() + 60_000; // pcom.py waited 60 s for the app's request
  while (Date.now() < end) {
    await sleep(500);
    if (kind === 'signin') return null;
    const r = await page<{ url: string } | null>({ kind: 'txn.request' }).catch(() => null);
    if (r?.url) return r.url;
  }
  throw new Error('the app never requested its transactions list');
}

async function pull(why: Why): Promise<PullOutcome> {
  await ensureSignedIn(why);
  let captured = await transactionsPage();
  if (!captured) {
    // The session ended between the sign-in and the page: once more.
    await until(() => !signedIn, SETTLE_MS);
    await ensureSignedIn(why);
    captured = await transactionsPage();
    if (!captured) throw new Error('Privacy signed out while loading the transactions page');
  }
  // The app's request should look like one enroll recorded (data/privacy_discovery.json, seeded): names only.
  const names = [...parseQsl(new URL(captured).search.replace(/^\?/, '')).keys()];
  const known = st.discovery?.queryNames ?? [];
  if (known.length && !known.some((q) => q.join('&') === names.join('&'))) log('warn', "the app's transactions request has query names enroll never saw", { names });
  const p = await pullTransactions(captured, {
    get: async (url) => {
      const r = await page<[number, string]>({ kind: 'txn.get', url }, 120_000);
      if (!Array.isArray(r) || typeof r[0] !== 'number' || typeof r[1] !== 'string') throw new Error('no answer from the page');
      return r;
    },
    log: (m) => log('info', m),
  });
  const now = new Date();
  const f = privacyFile(p, now);
  statements.spool.add(f.name, '', f.text, { mime: 'application/json', pulledAt: now.getTime() });
  st.lastPull = { at: now.getTime(), file: f.name, transactions: p.transactions.length, requests: p.requests, passes: p.passes };
  if (st.seed && !st.checked) {
    st.checked = compareWithSeed(st.seed, p, f.name, now.getTime());
    const c = st.checked;
    log('info', `against dither-finance's ${st.seed.file}: ${c.same} same, ${c.changed} changed, ${c.added} new, ${c.gone} gone`);
  }
  saveState();
  log('info', `${p.transactions.length} transaction(s) in ${f.name} (${p.requests} request(s), ${p.passes} pass(es))`);
  return { saved: 1 };
}

const statements = new StatementsRunner({
  link,
  pull: (_o, why) => pull(why),
  accounts: () => [{ id: 'privacy', name: 'Privacy.com', institution: 'Privacy.com', currency: 'USD', kind: 'card' }],
  blocked: () => statementsBlocked({ attached: bridge.connected, passkey: auth.summary(), hold: st.hold ?? null }),
  onChange: () => status(),
});

// ---------------------------------------------------------------- lifecycle
/** Tests only: let the extension's scripts and permissions cover the fake Privacy's origin too. */
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
      config: { wsUrl: bridge.wsUrl, token: bridgeToken },
      prepareExtension: testOrigin ? addTestOrigin : undefined,
      startUrl: `${appOrigin}/`,
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
  timers.push(setInterval(() => settle(), 5_000));
  // The daily pull starts once the extension is up (a missed one is caught up now, and signs in itself). Signing in
  // at start with no pull after it is only for signInOnStart: Privacy ends a session nothing uses within minutes.
  void until(() => bridge.connected, 60_000).then(async (up) => {
    if (!up) return;
    statements.start();
    await until(() => signedIn || kind === 'signin', 30_000 * Math.max(scale, 0.2));
    if (signedIn || kind !== 'signin' || statements.pulling) return;
    const b = statementsBlocked({ attached: bridge.connected, passkey: auth.summary(), hold: st.hold ?? null });
    if (b) return;
    if (cfg.signInOnStart !== true) return void log('info', 'no sign-in at start: each pull signs in by itself');
    // A refusal from the phone stands: the start asks nothing (the attention says what does).
    if (signin.blocked('start')) return void log('info', 'no sign-in at start: the last approval on the phone was not given');
    await ensureSignedIn('start').catch((e) => log('warn', 'automatic sign-in at start did not go through', String((e as Error)?.message ?? e).slice(0, 200)));
  });
  timers.push(
    setInterval(() => {
      if (sandbox && !sandbox.browserAlive) {
        log('warn', 'chromium exited; exiting for a supervised restart');
        void cleanup().then(() => process.exit(1));
      }
    }, 5000),
  );
}

function onConnect() {
  link.emit({ t: 'hello', network: 'privacy', version: '1', interfaces: ['privacy.session', 'statements'], startedAt: STARTED, capabilities: ['liveView'] });
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    statements.stop();
    for (const t of timers) clearTimeout(t);
    clearTimeout(settleTimer);
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
