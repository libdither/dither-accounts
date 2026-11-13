/**
 * The schwab extractor (docs/schwab.md): Schwab's own exports (History, brokerage and bank, and Realized Gain/Loss, as
 * CSV) as `statements` files for dither-finance, in place of the pages you printed to PDF and uploaded. A sandboxed
 * browser (statements-common/tabs.ts: Xvfb, an ordinary Chromium with the account's profile and an extension, x11vnc
 * for the live view; no CDP, no automation) where you sign in by hand: password, then Schwab's code or approval,
 * which nothing here answers (it shows as the attention `verify`).
 *
 * A pull drives one background tab, paced 2–5 s between steps (`paceScale` in tests): History, then for each account
 * its picker, the date range, Search and Export (page.js presses the page's own controls); then Realized Gain/Loss the
 * same way. Chromium saves what Export sends in `<account>/downloads`; this reads it, checks it is the export asked
 * for (its header, the account in its name, rows inside the range), and spools it under dither-finance's name
 * (schwab.ts fileName). A file you save in the live view yourself (an export, or a page printed to PDF) is picked up
 * the same way within seconds, so the live view is also the way to hand over anything a pull cannot get.
 *
 * The extension also carries this account's own passkey for schwab.com (docs/schwab.md, docs/passkeys.md): you sign
 * in once by hand, add a passkey in Schwab's security settings (the page's navigator.credentials.create reaches this
 * process: hook.js → content.js → sw.js → the bridge, with the frame's origin and the frames above it as Chromium
 * reports them; packages/passkey makes the key, keeps it in secret.json and answers), and log out and in with it once.
 * From then on, before each pull (and once at start) the account signs itself in when it finds Schwab signed out: it
 * clicks the sign-in page's passkey option, in whichever schwab.com frame shows it, and the authenticator answers; three
 * tries. Anything only you can give (a code, an approval, a captcha) stops it: every pull waits until the live view
 * shows Schwab signed in again. A passkey on a paired phone that the phone refuses stops it too, with no more tries
 * (packages/passkey signin.ts: denied waits for a pull you start, unanswered for the next scheduled pull).
 *
 * Without a checked passkey, a pull starts by itself right after you sign in (when the last one that found you signed
 * in is over 12 hours old), and a pull that finds Schwab signed out skips quietly.
 *
 * Config: { pullAt?, jitterMinutes?, schedule?, autoPullHours? (12), since? (backfill's first year; default last year),
 * signInOnStart? (true), testOrigin?, testFrameOrigin? (the fake's sign-in widget), paceScale?, noSandbox? }.
 * secret.json: { passkeys }. Logs pages, masks, layouts, ranges and row counts: never an amount, a balance, a
 * description, a key, a full credential id, a user handle or a challenge.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { ALG_NAMES, approverVia, Authenticator, PasskeySignIn, refusalNote, respond, secretStore, type Trigger, type Try as SignInTry, type WebauthnUp } from '@dither-accounts/passkey';
import { NeedsYou, sha256hex, StatementsRunner, type Why, writeWhole } from '@dither-accounts/statements-common';
import { BrowserHost, sleep } from '@dither-accounts/statements-common/tabs';
import {
  type AutoSignIn,
  autoFailedMessage,
  CHALLENGE_MESSAGE,
  challengeOf,
  fileName,
  type Hold,
  holdMessage,
  historyRanges,
  isPdf,
  keptTo,
  type Layout,
  pageKind,
  type PageKind,
  passkeyDetails,
  passkeyLayers,
  printName,
  type Range,
  realizedRanges,
  recognize,
  remember,
  type SchwabState,
  signedInLayer,
  state as statusOf,
  shownRange,
  us,
  type View,
} from './schwab.ts';

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'schwab', version: '1', interfaces: ['statements'], startedAt: STARTED, capabilities: ['liveView'] });
    status(true);
  },
  onCommand,
  onShutdown: () => {
    runner.stop();
    void host.stop();
  },
});
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);
const cfg = link.config;
const STARTED = Date.now();
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const appOrigin = testOrigin ?? 'https://client.schwab.com';
/** Tests: the fake's sign-in widget, on another origin of the fake site (as sws-gateway*.schwab.com is Schwab's). */
const testFrameOrigin: string | null = testOrigin && typeof cfg.testFrameOrigin === 'string' && cfg.testFrameOrigin ? cfg.testFrameOrigin.replace(/\/$/, '') : null;
const START_URL = `${appOrigin}/clientapps/accounts/summary/`;
/** The relying party domains the passkey answers for: schwab.com (and, in tests, the fake's host). */
const DOMAINS = testOrigin ? ['schwab.com', new URL(testOrigin).hostname] : ['schwab.com'];
const HISTORY = `${appOrigin}/app/accounts/history/#/`;
const REALIZED = `${appOrigin}/app/accounts/realizedgainloss/#/`;
const scale = Math.max(0, Math.min(1, Number(cfg.paceScale ?? 1)));
const autoPullMs = Math.max(0, Number(cfg.autoPullHours ?? 12)) * 3600_000;
const defaultSince = Number.isInteger(Number(cfg.since)) && Number(cfg.since) > 2000 ? Number(cfg.since) : new Date().getFullYear() - 1;
/** On the app this long before a sign-in counts. */
const SETTLE_MS = 4000;
const AUTO_RETRY_MS = 10 * 60_000;
const pace = () => sleep(Math.round((2000 + Math.random() * 3000) * scale));
/** Automatic sign-in: the waits before each try (so at most three tries). */
const BACKOFF_MS = [0, 20_000, 60_000];
/** The sign-in page is up this long before its passkey option is clicked; a click with no answer is repeated after. */
const HYDRATE_MS = 3000;
const RECLICK_MS = 10_000;
/** A sign-in that used the passkey must reach the app within this long to count as checked. */
const CHECK_WINDOW_MS = 3 * 60_000;

// -------------------------------------------------------------------- state
const stateFile = join(link.accountDir, 'state.json');
function loadState(): SchwabState {
  const empty: SchwabState = { accounts: {}, seen: {}, backfilled: {} };
  try {
    if (existsSync(stateFile)) return { ...empty, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
  } catch (e) {
    log('warn', 'state.json is unreadable; starting from nothing', String((e as Error).message));
  }
  return empty;
}
const saveState = () => writeWhole(stateFile, JSON.stringify(st, null, 1));
const st = loadState();

// ----------------------------------------------------------------- the passkey
// secret.json's passkeys, written whole (tmp + fsync + rename, mode 600). Frames on schwab.com all the way up only.
// Schwab asks for rpId www.schwab.com on client.schwab.com, which WebAuthn allows when www.schwab.com lists
// client.schwab.com in its /.well-known/webauthn (related origin requests). The extension fetches that list, as
// Chromium would, and a list that came back is kept for an hour.
const relatedCache = new Map<string, { at: number; origins: readonly string[] }>();
async function relatedOrigins(rpId: string): Promise<readonly string[]> {
  const hit = relatedCache.get(rpId);
  if (hit && Date.now() - hit.at < 3600_000) return hit.origins;
  const r = (await host.bridge.request({ kind: 'webauthn.related', rpId }, 15_000)) as { status?: number; origins?: unknown } | null;
  const origins = Array.isArray(r?.origins) ? r.origins.map(String) : [];
  log('info', `related origins for ${rpId}`, { status: r?.status ?? null, origins: origins.length });
  if (origins.length) relatedCache.set(rpId, { at: Date.now(), origins });
  return origins;
}
// A passkey on a paired phone (docs/approver.md) goes there through the manager.
const auth = new Authenticator(secretStore(link), DOMAINS, Date.now, 'same-site', relatedOrigins, approverVia(link));

/** Signing in by itself: the tries, and what a paired phone's refusal stops (kept in state.json). */
const signin = new PasskeySignIn({
  site: 'Schwab',
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
const counts = { creations: 0, assertions: 0, refusals: 0 };
let lastRefusal: string | null = null;
/** The last assertion handed out while not signed in: if the app follows, the passkey works. */
let pendingCheck: { id: string; at: number } | null = null;
/** When a schwab.com frame's hook last said it was up (a frame that loaded). */
let lastHookAt = 0;
const passkeyReady = () => !!auth.summary().newest?.verifiedAt;

// ------------------------------------------------------------- downloads
/** Where Chromium saves what a page downloads (its profile's preference, set before every start). */
const DOWNLOADS = join(link.accountDir, 'downloads');
mkdirSync(DOWNLOADS, { recursive: true, mode: 0o700 });
function downloadPrefs() {
  const path = join(link.accountDir, 'profile', 'Default', 'Preferences');
  let prefs: Record<string, any> = {};
  try {
    if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  prefs.download = { ...prefs.download, default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true };
  prefs.savefile = { ...prefs.savefile, default_directory: DOWNLOADS };
  // Several exports in a row from one page: no "download multiple files?" prompt.
  prefs.profile = { ...prefs.profile, default_content_setting_values: { ...prefs.profile?.default_content_setting_values, automatic_downloads: 1 } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs));
}
const settled = (n: string) => !n.startsWith('.') && !/\.(crdownload|part|tmp)$/i.test(n) && !n.startsWith('Unconfirmed ');
const downloads = () => {
  try {
    return readdirSync(DOWNLOADS).filter((n) => settled(n) && statSync(join(DOWNLOADS, n)).isFile());
  } catch {
    return [];
  }
};

/** A new file in Downloads (not one of `before`), once its size holds still. */
async function nextDownload(before: Set<string>, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  let last = '';
  let size = -1;
  while (Date.now() < end) {
    const n = downloads().find((x) => !before.has(x));
    if (n) {
      const s = statSync(join(DOWNLOADS, n)).size;
      if (n === last && s === size && s > 0) return n;
      last = n;
      size = s;
    }
    await sleep(400);
  }
  return null;
}

/** Hand a file over: spool it under dither-finance's name (same bytes as one already handed over: skipped). */
function handOver(name: string, bytes: Uint8Array, opts: { coverage?: Range | null; mime?: string }): boolean {
  const sha = sha256hex(bytes);
  if (st.seen[sha]) return false;
  const coverage = opts.coverage ? { from: new Date(`${opts.coverage.from}T00:00:00`).getTime(), to: new Date(`${opts.coverage.to}T00:00:00`).getTime() + 24 * 3600_000 } : undefined;
  runner.spool.add(name, 'schwab', bytes, { ...(coverage ? { coverage } : {}), ...(opts.mime ? { mime: opts.mime } : {}) });
  remember(st, sha, name);
  saveState();
  return true;
}
function noteAccount(mask: string, layout: Layout, label?: string) {
  const a = (st.accounts[mask] ??= { label: label ?? `…${mask}`, history: false, realized: false });
  if (label) a.label = label;
  if (layout === 'realized') a.realized = true;
  else a.history = true;
  a.kind = layout === 'bank' ? 'checking' : 'brokerage';
}

/** A file you saved in the live view: an export (named from its content) or a printed page; others stay put. */
const ignored = new Set<string>();
function pickUp(n: string) {
  const path = join(DOWNLOADS, n);
  const bytes = readFileSync(path);
  const r = recognize(bytes, n);
  let name: string | null = null;
  if (r && r.mask) {
    name = fileName(r.layout, r.mask, r.ext, Date.now());
    noteAccount(r.mask, r.layout);
  } else if (isPdf(bytes)) name = printName(Date.now());
  if (!name) {
    if (!ignored.has(n)) log('warn', `a download that is not a Schwab export with its account in it stays in downloads/ (${n.replace(/\d{3,}/g, '#')})`);
    ignored.add(n);
    return;
  }
  const saved = handOver(name, bytes, { coverage: r?.span ? { from: r.span[0], to: r.span[1] } : null, mime: isPdf(bytes) ? 'application/pdf' : undefined });
  rmSync(path, { force: true });
  log('info', saved ? `picked up a file saved in the live view: ${r ? `${r.layout} …${r.mask}, ${r.rows} row(s)` : 'a printed page (PDF)'}` : 'a file saved in the live view was already handed over');
}
let sizes = new Map<string, number>();
function scanDownloads() {
  if (runner.pulling) return;
  const now = new Map<string, number>();
  for (const n of downloads()) {
    if (ignored.has(n)) continue;
    const s = statSync(join(DOWNLOADS, n)).size;
    now.set(n, s);
    if (sizes.get(n) === s && s > 0) {
      try {
        pickUp(n);
      } catch (e) {
        log('warn', 'a saved file could not be handed over', String((e as Error).message).slice(0, 200));
        ignored.add(n);
      }
    }
  }
  sizes = now;
}

// -------------------------------------------------------------------- the live view
/** Tabs this extractor opened: not you signing in. */
const ownTabs = new Set<number>();
/** Tabs this closed: the tab list may still report one (as the active tab, after an export) for a moment. */
const closedTabs = new Set<number>();
let kind: PageKind = 'none';
let page: string | null = null;
let appSince = 0;
let lastIn = 0;
let lastOut = 0;
let lastAuto = 0;
let challenge = false;
let runnerStarted = false;

const host = new BrowserHost({
  link,
  extensionSrc: join(import.meta.dir, 'extension'),
  startUrl: START_URL,
  testOrigin,
  testOrigins: testFrameOrigin ? [testFrameOrigin] : [],
  passkeys: true,
  onMessage: (m) => void onExtension(m),
  onTabs,
  onChange: () => {
    if (host.attached && !runnerStarted) {
      runnerStarted = true;
      runner.start();
    }
    status();
  },
});

const signedIn = () => lastIn > lastOut && Date.now() - lastIn < 30 * 60_000;
/** The account's tab has stayed on the app (not a sign-in page) for SETTLE_MS. */
const settledOnApp = () => kind === 'app' && !!appSince && Date.now() - appSince >= SETTLE_MS;
const userTab = () => {
  const theirs = host.tabs.filter((t) => !ownTabs.has(t.id) && !closedTabs.has(t.id));
  return theirs.find((t) => t.active) ?? theirs[0] ?? null;
};

function onTabs() {
  const active = userTab();
  const was = page;
  page = active?.url || null;
  kind = pageKind(page, appOrigin);
  if (kind === 'app') appSince ||= Date.now();
  else {
    appSince = 0;
    if (kind === 'signin') lastOut = Date.now();
  }
  if (page !== was) log('info', `tab on ${page ?? 'nothing'}`);
}

interface Probe {
  /** A code field, or words asking for a code or an approval. */
  challenge: boolean;
  /** A code field itself (on a signed-in page only this counts: its words could be about anything). */
  otp: boolean;
  password: boolean;
  accounts: { mask: string; label: string; selected: boolean }[];
  exportable: boolean;
  loading: boolean;
  found: boolean;
  title: string;
}
/** The probe in every frame: Schwab signs in (and asks for its code) in a frame from sws-gateway*.schwab.com. The top
 * frame says where the page is; any frame may hold the password or the code. */
async function probeAll(tabId: number): Promise<Probe | null> {
  const all = await host.execAll<Probe | null>(tabId, 'probe', [], 'ISOLATED', 10_000);
  const top = all.find((f) => f.frameId === 0)?.result;
  if (!top) return null;
  const some = (k: 'challenge' | 'otp' | 'password') => all.some((f) => !!f.result?.[k]);
  return { ...top, challenge: some('challenge'), otp: some('otp'), password: some('password') };
}
let looking = false;
/** Read the page you are on (never what you typed): is Schwab asking for a code? */
async function look() {
  const t = userTab();
  if (looking || !host.attached || !t || (kind !== 'signin' && kind !== 'app' && kind !== 'site')) {
    if (challenge && kind !== 'signin') {
      challenge = false;
      status();
    }
    return;
  }
  looking = true;
  try {
    const p = await probeAll(t.id);
    const c = kind === 'app' ? !!p?.otp : !!p?.challenge;
    if (c !== challenge) {
      challenge = c;
      log(c ? 'warn' : 'info', c ? 'Schwab is asking for a code or an approval: waiting for you in the live view' : 'the code page is gone');
      status();
    }
  } catch {
  } finally {
    looking = false;
  }
}

/** Schwab was seen signed in: a hold lifts, and a passkey sign-in just before it is known to work. */
function signedInSeen(now: number) {
  signin.signedIn();
  if (st.hold) {
    log('info', `Schwab is signed in again: the hold (${st.hold.what}) is lifted`);
    st.hold = null;
    saveState();
    // The pull that was held goes now.
    if (host.attached && !runner.pulling) {
      const r = runner.refresh({}, 'sign-in');
      log('info', r.started ? 'pulling now, as the hold kept waiting' : `no pull after the hold: ${r.reason}`);
    }
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
  if (pendingCheck && now - pendingCheck.at > CHECK_WINDOW_MS + SETTLE_MS) pendingCheck = null;
}

/** On the app for SETTLE_MS: you signed in. Pull now unless one found you signed in within 12 hours. */
function tick() {
  const now = Date.now();
  if (pendingCheck && now - pendingCheck.at > CHECK_WINDOW_MS + SETTLE_MS) pendingCheck = null;
  if (kind === 'app' && appSince && now - appSince >= SETTLE_MS) {
    if (lastIn < appSince) {
      lastIn = now;
      challenge = false;
      log('info', 'Schwab is open in the live view');
      signedInSeen(now);
      status();
    }
    const last = st.lastSignedInPull ?? 0;
    if (host.attached && !runner.pulling && now - last > autoPullMs && now - lastAuto > AUTO_RETRY_MS) {
      lastAuto = now;
      const r = runner.refresh({}, 'sign-in');
      log('info', r.started ? 'signed in: pulling now' : `signed in, but no pull: ${r.reason}`);
    }
  }
  void look();
  scanDownloads();
  status();
}

// --------------------------------------------------------------------- pull
class SignedOut extends Error {}

/** Wait for the page to be ready to export: accounts in its picker, Export, not loading. Signed out: SignedOut. */
async function ready(tabId: number, what: string, ms = 45_000): Promise<Probe> {
  const end = Date.now() + ms;
  let p: Probe | null = null;
  while (Date.now() < end) {
    const info = await host.get(tabId);
    const k = pageKind(info.url, appOrigin);
    try {
      p = await probeAll(tabId);
    } catch {
      p = null;
    }
    if (k === 'app' ? p?.otp : p?.challenge) throw new NeedsYou(CHALLENGE_MESSAGE, 'verify');
    if (k === 'signin' || (p?.password && k !== 'app')) throw new SignedOut();
    if (k === 'app' && p && p.accounts.length && p.exportable && !p.loading) return p;
    await sleep(700);
  }
  const controls = await host.exec<string[]>(tabId, 'describe', [], 'ISOLATED', 10_000).catch(() => []);
  log('warn', `${what}: no account picker or Export found`, { title: p?.title, accounts: p?.accounts.length ?? null, exportable: p?.exportable ?? null, loading: p?.loading ?? null, controls });
  throw new Error(`${what}: no account picker or Export on the page (has Schwab's page changed?). Export by hand in the live view meanwhile: files saved there are picked up`);
}

/** After a range or account change: wait for the page to settle (not loading, a result line). */
async function settle(tabId: number) {
  const end = Date.now() + 30_000;
  await sleep(800 * Math.max(scale, 0.25));
  while (Date.now() < end) {
    const p = await probeAll(tabId).catch(() => null);
    if (p?.otp) throw new NeedsYou(CHALLENGE_MESSAGE, 'verify');
    if (p && !p.loading && p.exportable) return;
    await sleep(500);
  }
}

/** One export: the account, the range, Search, Export; the file it sends, checked and handed over. */
async function exportOne(tabId: number, mask: string, want: Layout | 'history', range: Range): Promise<{ saved: boolean; rows: number }> {
  // In the front while it exports: Schwab's pages are Stencil web components that draw on animation frames, which
  // Chromium pauses in a background tab, so a background tab's Export dialog never shows (seen live 2026-11-10: "no
  // file arrived"). Signing in stays in the account's own tab; closing this one at the end brings that one back.
  await host.activate(tabId).catch((e) => log('debug', `bringing the export tab to the front: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
  const sel = await host.exec<{ ok: boolean; how: string }>(tabId, 'selectAccount', [mask], 'ISOLATED', 20_000);
  if (!sel?.ok) throw new Error(`could not pick …${mask} (${sel?.how ?? 'no answer'})`);
  await settle(tabId);
  await pace();
  const rg = await host.exec<{ ok: boolean; how: string; seen?: string[]; openers?: string[] }>(tabId, 'setRange', [us(range.from), us(range.to)], 'ISOLATED', 20_000);
  if (!rg?.ok) log('warn', `setRange found no date fields`, { how: rg?.how, inputs: rg?.seen ?? null, openers: rg?.openers ?? null });
  if (!rg?.ok) log('warn', 'the page\'s date controls', await host.exec<unknown>(tabId, 'dateOutline', [], 'ISOLATED', 10_000).catch((e) => String(e)));
  if (!rg?.ok) {
    // The page's own range (History shows the last 6 months by default): good enough when it covers the one wanted.
    const shown = shownRange((await host.exec<string>(tabId, 'shown', [], 'ISOLATED', 10_000).catch(() => '')) ?? '');
    if (!shown || shown.from > range.from || shown.to < range.to) throw new Error(`could not set the range ${range.from}..${range.to} (${rg?.how ?? 'no answer'}; the page shows ${shown ? `${shown.from}..${shown.to}` : 'no range'})`);
    log('info', `…${mask}: the date picker could not be set; the page's own ${shown.from}..${shown.to} covers ${range.from}..${range.to}`);
    range = shown;
  }
  await settle(tabId);
  await pace();
  const before = new Set(downloads());
  const ex = await host.exec<{ ok: boolean; how: string }>(tabId, 'exportNow', [], 'ISOLATED', 20_000);
  if (!ex?.ok) throw new Error(`Export on …${mask}: ${ex?.how ?? 'no answer'}`);
  const n = await nextDownload(before, 60_000 * Math.max(scale, 0.25));
  if (!n) throw new Error(`Export on …${mask} (${ex.how}): no file arrived in a minute`);
  const path = join(DOWNLOADS, n);
  const bytes = readFileSync(path);
  const r = recognize(bytes, n);
  const ok = r && (want === 'history' ? r.layout !== 'realized' : r.layout === want);
  if (!r || !ok) {
    renameSync(path, join(DOWNLOADS, `.unexpected-${Date.now()}`));
    throw new Error(`Export on …${mask} sent ${r ? `a ${r.layout} file` : 'a file that is not a Schwab export'}, not ${want}`);
  }
  if (r.mask && r.mask !== mask) {
    renameSync(path, join(DOWNLOADS, `.unexpected-${Date.now()}`));
    throw new Error(`Export sent …${r.mask}'s file while …${mask} was picked`);
  }
  const kept = keptTo(r, range);
  if (!kept) log('warn', `…${mask} ${r.layout}: rows outside ${range.from}..${range.to}; named without the range`);
  noteAccount(mask, r.layout);
  const saved = handOver(fileName(r.layout, mask, r.ext, Date.now(), kept ? range : null), bytes, { coverage: kept ? range : r.span ? { from: r.span[0], to: r.span[1] } : null });
  rmSync(path, { force: true });
  log('info', `…${mask} ${r.layout} ${range.from}..${range.to}: ${r.rows} row(s)${saved ? '' : ', the same bytes as a file already handed over'}`);
  return { saved, rows: r.rows };
}

/** Every account the page lists, each over its ranges (a backfill stops after two empty years in a row). */
async function exportAll(tabId: number, p: Probe, page: 'history' | 'realized', opts: { full?: boolean; since?: number }): Promise<number> {
  let saved = 0;
  const today = new Date();
  for (const a of [...p.accounts].sort((x, y) => x.mask.localeCompare(y.mask))) {
    const key = `${page}:${a.mask}`;
    const back = opts.full || opts.since !== undefined || !st.backfilled[key] ? { since: opts.since ?? defaultSince } : null;
    const ranges = page === 'history' ? historyRanges(today, back) : realizedRanges(today, back);
    let empty = 0;
    for (const [i, range] of ranges.entries()) {
      const r = await exportOne(tabId, a.mask, page === 'history' ? 'history' : 'realized', range);
      if (r.saved) saved++;
      empty = r.rows ? 0 : empty + 1;
      if (back && i > 0 && empty >= 2) {
        log('info', `…${a.mask} ${page}: two empty years in a row; the backfill stops at ${range.from.slice(0, 4)}`);
        break;
      }
      await pace();
    }
    if (back) {
      st.backfilled[key] = true;
      saveState();
    }
    if (st.accounts[a.mask]) st.accounts[a.mask].label = a.label;
  }
  return saved;
}

async function pull(opts: { since?: number; full?: boolean }, why: Why): Promise<{ saved: number; skipped?: 'signed-out' | 'unchanged' }> {
  if (!host.attached) throw new Error('the sandbox browser is not up');
  downloadPrefs(); // in case the profile was reset since the start
  // With a checked passkey, signed out is not a reason to skip: sign in first.
  if (passkeyReady()) await ensureSignedIn(why);
  const tab = await host.open(HISTORY, { timeout: 60_000 });
  ownTabs.add(tab.tabId);
  let saved = 0;
  try {
    let p: Probe;
    try {
      p = await ready(tab.tabId, 'History');
    } catch (e) {
      if (!(e instanceof SignedOut)) throw e;
      lastOut = Date.now();
      if (!passkeyReady()) {
        log('info', 'skipped: signed out of Schwab');
        return { saved: 0, skipped: 'signed-out' };
      }
      // The session ended though the account's tab still shows the app: sign in again, once.
      log('info', 'History found Schwab signed out: signing in with the passkey');
      await ensureSignedIn(why, true);
      await host.go(tab.tabId, HISTORY, 60_000);
      try {
        p = await ready(tab.tabId, 'History');
      } catch (e2) {
        if (e2 instanceof SignedOut) throw new Error('Schwab signed out again while loading History');
        throw e2;
      }
    }
    lastIn = Date.now();
    signedInSeen(lastIn);
    log('info', `History lists ${p.accounts.length} account(s): ${p.accounts.map((a) => `…${a.mask}`).join(', ')}`);
    saved += await exportAll(tab.tabId, p, 'history', opts);
    await pace();
    // Realized Gain/Loss where Schwab's own navigation links it (its address is not a guess), else the usual one.
    const found = await host.exec<{ text: string; url: string }[]>(tab.tabId, 'links', ['realized|gain ?/ ?loss'], 'ISOLATED', 10_000).catch(() => []);
    if (!found?.length) {
      // For the log: where the page's account links go, to find what Schwab calls the page now.
      const all = await host.exec<{ text: string; url: string }[]>(tab.tabId, 'links', ['.'], 'ISOLATED', 10_000).catch(() => []);
      log('info', 'links on History', (all ?? []).filter((l) => l.url.startsWith(appOrigin)).map((l) => `${l.text.slice(0, 30)} → ${new URL(l.url).pathname}${new URL(l.url).hash}`));
    }
    const own = (found ?? []).find((l) => l.url.startsWith(appOrigin) && /realized/i.test(l.text)) ?? (found ?? []).find((l) => l.url.startsWith(appOrigin));
    log('info', `Realized Gain/Loss links on History: ${(found ?? []).map((l) => `${l.text} → ${new URL(l.url).pathname}${new URL(l.url).hash}`).join('; ') || 'none'}`);
    await host.go(tab.tabId, own?.url ?? REALIZED, 60_000);
    const q = await ready(tab.tabId, 'Realized Gain/Loss');
    saved += await exportAll(tab.tabId, q, 'realized', opts);
    st.lastSignedInPull = Date.now();
    saveState();
    log('info', `${saved} file(s) handed over`);
    return { saved, ...(saved ? {} : { skipped: 'unchanged' as const }) };
  } catch (e) {
    if (saved) log('warn', `the pull stopped after ${saved} file(s); they are kept`);
    throw e;
  } finally {
    closedTabs.add(tab.tabId);
    ownTabs.delete(tab.tabId);
    await host.close(tab.tabId).catch(() => {});
    // The account's own tab back in the front (the export tab was, while it exported): sign-ins and the live view are there.
    const mine = userTab();
    if (mine) await host.activate(mine.id).catch(() => {});
  }
}

const runner = new StatementsRunner({
  link,
  pull: (o, why) => pull({ since: Number.isInteger(o.since) ? o.since : undefined, full: !!o.full }, why),
  accounts: () =>
    Object.entries(st.accounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mask, a]) => ({ id: `schwab-${mask}`, name: a.label, institution: 'Charles Schwab', currency: 'USD', kind: (a.kind === 'checking' ? 'bank' : a.kind === 'brokerage' || a.realized ? 'brokerage' : 'unknown') as 'bank' | 'brokerage' | 'unknown' })),
  blocked: () => blockedNow(),
  onChange: () => status(),
});

// ------------------------------------------------------------------- status
function view(): View {
  const auto: AutoSignIn = { signingIn: signin.signingIn, hold: st.hold ?? null, failed: signin.failed, lastOkAt: signin.lastOkAt, approval: signin.refusal };
  return { signedIn: signedIn(), challenge, lastSignedInPull: st.lastSignedInPull ?? null, now: Date.now(), passkey: auth.summary(), auto, lastRefusal };
}

let lastSent = '';
function status(force = false) {
  const base = host.baseState();
  const v = view();
  const s = base ?? statusOf(v);
  const details = {
    display: host.liveView ? `:${host.display}` : null,
    page,
    pageKind: kind,
    extensionAttached: host.attached,
    signedIn: v.signedIn,
    challenge,
    ...passkeyDetails(v),
    passkeysMadeThisRun: counts.creations,
    signInsThisRun: counts.assertions,
    refusedThisRun: counts.refusals,
    autoSignInsThisRun: signin.tries,
    approval: signin.refusal ? refusalNote(signin.refusal) : null,
    accounts: Object.keys(st.accounts).map((m) => `…${m}`),
    lastSignedInPull: st.lastSignedInPull ? new Date(st.lastSignedInPull).toISOString() : null,
    backfilled: Object.keys(st.backfilled).filter((k) => st.backfilled[k]),
    downloadsWaiting: downloads().filter((n) => !ignored.has(n)).length,
    downloadsIgnored: ignored.size,
    ...runner.details(),
  };
  const layers = [...host.layers(), signedInLayer(v), ...passkeyLayers(v), runner.pullLayer()];
  // A pull's "sign in" or "answer the code" is over once Schwab is signed in.
  const stale = v.signedIn && (runner.st.needs?.kind === 'login' || runner.st.needs?.kind === 'verify');
  if (runner.st.needs && !stale && !base && s.status === 'online') Object.assign(s, { status: 'attention', attention: { kind: runner.st.needs.kind, message: runner.st.needs.message, liveView: true } });
  const ev = { t: 'status', status: s.status, attention: s.attention, liveView: host.liveView, details, layers };
  const j = JSON.stringify(ev);
  if (j === lastSent && !force) return;
  lastSent = j;
  link.emit(ev);
}

// ------------------------------------------------------------ the passkey, from the page
async function onExtension(m: { t: string; [k: string]: unknown }) {
  if (m.t === 'hook') lastHookAt = Date.now();
  else if (m.t === 'log') log('debug', `[hook] ${String(m.msg).slice(0, 200)}`);
  else if (m.t === 'webauthn') await onWebauthn(m as unknown as WebauthnUp);
}

async function onWebauthn(m: WebauthnUp) {
  const where = typeof m.page === 'string' && m.page ? m.page.slice(0, 200) : null;
  const frame = m.top ? 'top frame' : 'a frame';
  const r = await respond(auth, m);
  if (r.made) {
    counts.creations++;
    log('info', 'passkey created and stored', { credential: `${r.made.id.slice(0, 8)}…`, algorithm: ALG_NAMES[r.made.publicKeyAlgorithm], page: where, frame });
  } else if (r.none) {
    log('info', 'a passkey sign-in asked for a credential this browser does not hold: left to the browser', { page: where, frame });
  } else if (r.used) {
    counts.assertions++;
    // A sign-in with it (not a re-check inside the app): from a sign-in page, as Chromium reports the tab's page, or
    // while not signed in. The app that follows has to settle again, and then the passkey counts as checked.
    const from = pageKind(typeof m.topPage === 'string' ? m.topPage : null, appOrigin);
    if (from !== 'app' || !signedIn()) {
      pendingCheck = { id: r.used.id, at: Date.now() };
      if (from !== 'app') lastOut = Date.now();
    }
    log('info', 'passkey sign-in answered', { credential: `${r.used.id.slice(0, 8)}…`, page: where, frame });
  } else {
    const err = r.refused;
    counts.refusals++;
    lastRefusal = `${m.op === 'create' ? 'create' : 'get'}: ${err.message}`.slice(0, 200);
    log('warn', 'passkey request refused', { op: m.op, code: err.code, reason: err.message.slice(0, 200), origin: typeof m.origin === 'string' ? m.origin.slice(0, 100) : null, frame });
    // The phone said no while this was signing in by itself: that sign-in stops (signin.ts).
    signin.note(err);
  }
  try {
    await host.bridge.request({ kind: 'webauthn.answer', sid: String(m.sid), ...r.answer }, 10_000);
  } catch (e) {
    log('warn', 'the passkey answer did not reach the page', String((e as Error)?.message ?? e).slice(0, 200));
  }
  status();
}

// ------------------------------------------------------------ signing in by itself
/** Why a pull cannot start now, or null. */
function blockedNow(): string | null {
  if (!host.attached) return 'the sandbox browser is not up yet';
  if (passkeyReady() && st.hold) return `Schwab is waiting for you in the live view: ${st.hold.message}`;
  return null;
}

const until = async (f: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await sleep(250);
  }
  return f();
};

/** The frames of a tab that show Schwab's passkey option, and whether any shows a captcha (page.js `passkey`). */
async function passkeyFrames(tabId: number): Promise<{ frames: number[]; captcha: boolean }> {
  const all = await host.execAll<{ passkey: boolean; captcha: boolean } | null>(tabId, 'passkey', [false], 'ISOLATED', 10_000).catch(() => []);
  return { frames: all.filter((f) => !!f.result?.passkey).map((f) => f.frameId), captcha: all.some((f) => !!f.result?.captcha) };
}
/** What on the sign-in page only you can give (a code or an approval, a captcha), or null. */
async function askedOf(tabId: number, afterPasskey: boolean): Promise<Hold['what'] | null> {
  const p = await probeAll(tabId).catch(() => null);
  const pk = await passkeyFrames(tabId);
  return challengeOf({ otp: !!p?.otp, challenge: !!p?.challenge, captcha: pk.captcha }, afterPasskey);
}

/** One try (packages/passkey signin.ts): a hold is what Schwab asks of you. */
type Try = SignInTry<Hold['what']>;

/** One try, in the account's tab: the summary; if it lands on the sign-in page, the passkey option; then the app settled. */
async function signInOnce(force: boolean): Promise<Try> {
  const t = userTab();
  if (!t) return { ok: false, reason: 'the browser has no tab' };
  if (kind !== 'signin' || force) {
    // The summary goes to the app when signed in, and to the sign-in page when not. Settling starts again from here.
    appSince = 0;
    await host.go(t.id, START_URL, 60_000).catch((e) => log('debug', `loading the summary: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
  }
  let frames: number[] = [];
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    if (settledOnApp()) return { ok: true };
    if (kind === 'signin') {
      const asked = await askedOf(t.id, false);
      if (asked) return { ok: false, reason: asked, hold: asked };
      frames = (await passkeyFrames(t.id)).frames;
      if (frames.length) break;
    }
    await sleep(500);
  }
  if (settledOnApp()) return { ok: true };
  if (!frames.length) return { ok: false, reason: kind === 'signin' ? "Schwab's sign-in page shows no passkey option" : 'Schwab did not settle on a page' };
  // The sign-in widget may show its button before its script has hydrated it, and a click then does nothing. So the
  // page's frames have been up a few seconds first, and a click that brings no passkey request is repeated.
  await until(() => Date.now() - lastHookAt >= HYDRATE_MS * scale, HYDRATE_MS);
  const before = counts.assertions;
  const stop = Date.now() + 45_000;
  let clicks = 0;
  let lastClick = 0;
  log('info', 'signing in with the passkey', { page: page ? pathOf(page) : null });
  while (Date.now() < stop) {
    if (settledOnApp()) return { ok: true };
    // The paired phone refused: no click again (each would ask it once more).
    if (signin.stopped) return { ok: false, reason: 'the approver refused' };
    if (counts.assertions === before && clicks < 3 && Date.now() - lastClick >= RECLICK_MS * scale && kind === 'signin') {
      const fid = (await passkeyFrames(t.id)).frames[0];
      const r = fid === undefined ? { clicked: false } : await host.execIn<{ clicked: boolean }>(t.id, fid, 'passkey', [true], 'ISOLATED', 10_000).catch(() => ({ clicked: false }));
      if (!r?.clicked && !clicks) return { ok: false, reason: 'the passkey option could not be clicked' };
      if (r?.clicked) {
        clicks++;
        log('debug', `clicked the passkey option (${fid === 0 ? 'top frame' : 'a frame'}, click ${clicks})`);
      }
      lastClick = Date.now();
    }
    if (counts.assertions > before && kind === 'signin') {
      const asked = await askedOf(t.id, true);
      if (asked) return { ok: false, reason: asked, hold: asked };
    }
    await sleep(500);
  }
  return { ok: false, reason: counts.assertions > before ? 'Schwab did not finish the sign-in after the passkey answered' : 'Schwab did not ask for the passkey' };
}
const pathOf = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return null;
  }
};

/** Sign in with the passkey: at most three tries with backoff; a question only you can answer holds every pull, and a
 * refusal from a paired phone stops the tries (signin.ts). */
async function signIn(trigger: Trigger, force: boolean): Promise<void> {
  if (!force && settledOnApp()) return;
  const blocked = blockedNow();
  if (blocked) throw new NeedsYou(blocked, 'login');
  await signin.run<Hold['what']>(trigger, (i) => signInOnce(force && !i), {
    done: settledOnApp,
    hold: (what) => {
      st.hold = { what, message: holdMessage(what), since: Date.now() };
      saveState();
      log('warn', `Schwab asks for ${what === 'code' ? 'a code or an approval' : 'a captcha'}: holding pulls until it is signed in again in the live view`);
      return new NeedsYou(st.hold.message, 'login');
    },
    failed: autoFailedMessage,
  });
}
let signingIn: Promise<void> | null = null;
function ensureSignedIn(trigger: Trigger, force = false): Promise<void> {
  if (!force && settledOnApp() && signedIn()) return Promise.resolve();
  signingIn ??= signIn(trigger, force).finally(() => {
    signingIn = null;
  });
  return signingIn;
}

async function onCommand(cmd: Command): Promise<unknown> {
  const r = runner.handle(cmd);
  if (r !== undefined) return r;
  throw new StatusError(`schwab has no operation "${cmd.t}"`, 400);
}

downloadPrefs();
host.start().then(
  (ok) => {
    if (!ok) return;
    setInterval(tick, 2000);
    // At start, sign in once with the passkey if Schwab is signed out.
    if (cfg.signInOnStart === false) return;
    void until(() => host.attached, 60_000).then(async (up) => {
      if (!up) return;
      await until(() => settledOnApp() || kind === 'signin', 30_000 * Math.max(scale, 0.2));
      if (settledOnApp() || kind !== 'signin' || runner.pulling || !passkeyReady() || blockedNow()) return;
      // A refusal from the phone stands: the start asks nothing (the attention says what does).
      if (signin.blocked('start')) return void log('info', 'no sign-in at start: the last approval on the phone was not given');
      await ensureSignedIn('start').catch((e) => log('warn', 'automatic sign-in at start did not go through', String((e as Error)?.message ?? e).slice(0, 200)));
    });
  },
  (e) => {
    log('error', 'boot failed', String((e as Error)?.message ?? e));
    void host.stop().then(() => process.exit(1));
  },
);
