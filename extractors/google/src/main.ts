/**
 * The google extractor: one Google account signed in to a real browser (packages/browser: Xvfb, an ordinary Chromium
 * with a persistent profile and our extension, x11vnc for the live view), answering `google.calendar` from inside the
 * signed-in Calendar page. You sign in once in the live view; the profile keeps the session. extractors/google-api is
 * the other way in, with your own OAuth client (docs/google.md).
 *
 * Calls are Google Calendar API v3 at <apiBase>/calendar/v3/…?key=<key>, made by the page's hook with the page's
 * cookies and a SAPISIDHASH Authorization, as Google's own web apps call its APIs. The key is found by probing (keys
 * the page itself uses first) and kept in state.json.
 *
 * Besides the Calendar tab, the same browser has a Gmail tab (mail.google.com/mail/u/<authuser>/), unless the config
 * says `mail: false`. Each page is a role ('calendar', 'gmail'): the extension's service worker sends each command to
 * its role's page only, and each role has its own queue here, so one page's trouble never holds up the other's calls.
 * A page that leaves two requests in a row unanswered (25 s each) has its tab reloaded, that tab alone. The Gmail tab
 * answers `mail`, read-only, over Gmail's own web protocol (src/gmail/: list and search, thread fetch, sync, and the
 * original from Gmail's download route; each answer checked against the layout Gmail was seen to use, the 'Gmail
 * protocol' layer), and, each asked for with a file, a content-free self-check of it, a diagnostic (gmailApiProbe) and
 * the learn run's guarded steering (runLearn: a view or an operators-only search, a read thread opened, back, the
 * recorded traffic shapes collected). Mail calls with `background: true` (an app's archive) go in a background lane of
 * their own, paced, budgeted and stopped on any sign of a block ('Gmail background' layer); and an unread guard
 * refuses unread messages if reading one was ever seen to mark it read. docs/google.md.
 *
 * Config: { authuser?, mail?, gmailPollSeconds?, apiBase?, gmailApiBase?, testOrigin?, testMailOrigin?, noSandbox? }.
 *
 * Logs ids and statuses, never cookies, keys, tokens, event contents or mail. Nothing here changes mail.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import type { OutgoingMail } from '@dither-accounts/interfaces';
import { GmailMail, type PageKind, stateOf, type SyncAnswer, type Transport } from './gmail/mail.ts';
import { DECIMAL_ID } from './gmail/protocol.ts';
import { checkOutgoing, MAX_RECIPIENTS, SEND_CAP } from './gmail/send.ts';
import { selfCheck } from './gmail/selfcheck.ts';
import { checkLearnScript, describeStep, type LearnStep } from './learn.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** Google's own key for embedded public calendars: the last one tried. */
const EMBED_KEY = 'AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXxs';
const SIGN_IN_HOST = 'accounts.google.com';
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const RETRIES = 4;
const BACKOFF = Number(process.env.DITHER_GOOGLE_BACKOFF_MS) || 500;
/** After the page says it is signed in, wait this long for its own requests (and their keys) before probing. */
const PROBE_SETTLE_MS = 1500;
/** The extension should be talking to us this soon after the browser starts. */
const ATTACH_MS = 30_000;
/**
 * A page request's answer comes within this, or the call fails saying which page did not answer: under the manager's
 * 30 s for an op, so the caller hears this account's own sentence first.
 */
const PAGE_ANSWER_MS = 25_000;
/** This many unanswered requests in a row to one page, and its tab is reloaded. */
const SILENT_LIMIT = 2;
/** The service worker's own commands (open or reload a tab) answer within this. */
const TAB_COMMAND_MS = 10_000;
/** The Gmail API probe: asked for by this file in the account's directory, answered in the other. */
const PROBE_REQUEST = 'probe-gmail.request';
const PROBE_RESULT = 'probe-gmail.json';
const PROBE_POLL_MS = 3000;
/** A learn run: asked for by this script in the account's directory; `collect` writes the shapes to the other. */
const LEARN_REQUEST = 'gmail-learn.json';
const LEARN_SHAPES = 'gmail-shapes.json';
/** The Gmail self-check: asked for by this file, answered in the other (counts, booleans and types only). */
const SELFCHECK_REQUEST = 'gmail-selfcheck.request';
const SELFCHECK_RESULT = 'gmail-selfcheck.json';
/** Where the mail watch got to (Gmail's sync point and when), so a restart announces what came meanwhile. */
const WATCH_FILE = 'gmail-watch.json';
/** What reading Gmail has done that must outlive a restart: bytes downloaded in the last 24 h, and the unread guard. */
const READS_FILE = 'gmail-reads.json';
/** A message download may take this long (up to 50 MB); handed over in pieces of this size. */
const RAW_ANSWER_MS = 90_000;
const RAW_PIECE = 4 * 1024 * 1024;

type Role = 'calendar' | 'gmail';
type KeySource = 'calendar-request' | 'gmail-request' | 'page-request' | 'page-html' | 'embed';
/** 'u': the hashes end in _u, as the page's own do when it uses them. */
type AuthStyle = 'plain' | 'u';
interface Winner {
  key: string;
  source: KeySource;
  auth: AuthStyle;
}
interface Endpoint {
  host: string;
  path: string;
  keyed: boolean;
  auth: { schemes: string[]; u: boolean } | null;
}
interface Gfetch {
  kind: 'gfetch';
  /** Which page makes the call (the service worker routes by it); set by pageRequest. */
  page?: Role;
  method: string;
  url: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  auth: AuthStyle;
}
/** A learn run's steering of the Gmail page (the hook checks a nav again, and opens read rows only). */
type GmailCmd = { page?: Role } & (
  | { kind: 'gmail.nav'; hash: string }
  | { kind: 'gmail.openRead'; index: number }
  | { kind: 'gmail.back' }
  | { kind: 'gmail.shapes' }
  // Reading mail (src/gmail/): what the page's own sync calls showed, one call made as the page makes them, a message's original.
  | { kind: 'gmail.syncInfo' }
  | { kind: 'gmail.sync'; endpoint: 'bv' | 'fd' | 's'; body: unknown }
  | { kind: 'gmail.raw'; hex: string; max: number }
  | { kind: 'gmail.rawChunk'; token: string; offset: number; length: number }
  | { kind: 'gmail.rawDrop'; token: string }
  // Writing (src/gmail/write.ts): one of the page's own kinds of write, and an attachment's upload in pieces.
  | { kind: 'gmail.write'; body: unknown }
  | { kind: 'gmail.uploadChunk'; token?: string; base64: string }
  | { kind: 'gmail.upload'; token: string; size: number; name: string; mime: string; meta: string }
);
type PageCmd = Gfetch | GmailCmd;
/** What gmail.shapes answers: per method and path template, a count and up to 6 samples of shapes (no values). */
interface ShapeEntry {
  method: string;
  template: string;
  count: number;
  samples: unknown[];
}
/** The service worker's own: open the role's tab if it has none, or send it back to `url` (`fresh`: a new tab). */
interface TabCmd {
  kind: 'tab.open' | 'tab.reload';
  page: Role;
  url: string;
  tabId: number | null;
  fresh?: boolean;
  active?: boolean;
}
interface GResponse {
  status: number;
  json?: any;
  text?: string;
  retryAfter?: string | null;
}
interface TabInfo {
  id: number;
  url: string;
  active: boolean;
  hook: boolean;
  role?: Role | null;
  current?: boolean;
}
/** `role`: which page said it (the service worker puts it on every frame from a page). */
type Up =
  | { t: 'ready' }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: unknown; role?: Role | null }
  | { t: 'tabs'; tabs: TabInfo[] }
  | { t: 'hook'; page: string; role?: Role | null }
  | { t: 'session'; signedIn: boolean; email: string | null; name?: string | null; role?: Role | null }
  | { t: 'seen'; endpoints: Endpoint[]; keys: { key: string; source: KeySource }[]; role?: Role | null };
type Attention = { kind: string; message: string; liveView: boolean };
/** One link of the account's dependency chain (status.layers, as in chat-protocol's StatusLayer). */
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

const link = linkManager({ onConnect, onCommand, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);

const cfg = link.config;
const authuser = String(cfg.authuser ?? 0);
const origin = (v: unknown) => (typeof v === 'string' && v ? v.replace(/\/$/, '') : null);
const testOrigin = origin(cfg.testOrigin);
const testMailOrigin = origin(cfg.testMailOrigin);
const calendarOrigin = testOrigin ?? 'https://calendar.google.com';
/** In tests, Gmail is wherever testMailOrigin says, and there is none without it: a test never opens the real one. */
const mailOrigin = testMailOrigin ?? (testOrigin ? null : 'https://mail.google.com');
const mailOn = cfg.mail !== false && !!mailOrigin;
/** How often the mail watch asks Gmail what changed (0: never); it starts with the first mail call. */
const pollMs = Math.max(0, Number(cfg.gmailPollSeconds ?? 60) || 0) * 1000;
const apiBase = String(cfg.apiBase ?? 'https://clients6.google.com').replace(/\/$/, '');
const gmailApiBase = String(cfg.gmailApiBase ?? 'https://gmail.googleapis.com').replace(/\/$/, '');
const startUrl = `${calendarOrigin}/calendar/u/${encodeURIComponent(authuser)}/r`;
const mailStartUrl = mailOrigin ? `${mailOrigin}/mail/u/${encodeURIComponent(authuser)}/` : null;

// --------------------------------------------------------------- the lanes
/**
 * A page's own queue: at most `max` of its requests in flight, sent at least `gapMs` apart. Each page has one, so a
 * slow or dead page fills only its own.
 */
class Lane {
  private inFlight = 0;
  private waiting: { go: () => void; timer: Timer }[] = [];
  private nextAt = 0;
  constructor(
    readonly max: number,
    readonly gapMs: number,
  ) {}

  /** A slot, once one is free and the gap has passed; false if the deadline came first (then no slot is held). */
  async take(deadline: number): Promise<boolean> {
    if (this.inFlight < this.max && !this.waiting.length) this.inFlight++;
    else {
      const got = await new Promise<boolean>((resolve) => {
        const w = {
          go: () => resolve(true),
          timer: setTimeout(() => {
            this.waiting.splice(this.waiting.indexOf(w), 1);
            resolve(false);
          }, deadline - Date.now()),
        };
        this.waiting.push(w);
      });
      if (!got) return false;
    }
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    if (at > now) await Bun.sleep(at - now);
    return true;
  }

  /** The slot goes to the next one waiting, or back. */
  give() {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.go();
    } else this.inFlight--;
  }
}

/** One of the browser's pages, a role: its tab, what its hook says, its lane and how well it answers. */
interface Page {
  role: Role;
  /** "the Calendar page did not answer". */
  name: string;
  startUrl: string | null;
  tabId: number | null;
  /** Its tab's origin and path. */
  url: string | null;
  /** Its tabs with our hook in them. */
  hooked: number;
  /** What its hook last said; it counts only while a tab has the hook. */
  session: { signedIn: boolean; email: string | null; name?: string | null } | null;
  endpoints: Endpoint[];
  keys: { key: string; source: KeySource }[];
  lane: Lane;
  /** Requests in a row it did not answer. */
  silent: number;
  /** Bumped by each reload: an older request's silence is the old page's, and no longer counts. */
  generation: number;
  answeredAt: number;
  /** When its hook last said it is up. */
  hookAt: number;
  reloading: boolean;
  reloads: number;
  lastReload: { at: number; how: string | null; error?: string } | null;
  openError: string | null;
}
const newPage = (role: Role, name: string, url: string | null, lane: Lane): Page => ({
  role,
  name,
  startUrl: url,
  tabId: null,
  url: null,
  hooked: 0,
  session: null,
  endpoints: [],
  keys: [],
  lane,
  silent: 0,
  generation: 0,
  answeredAt: 0,
  hookAt: 0,
  reloading: false,
  reloads: 0,
  lastReload: null,
  openError: null,
});
const pages: Record<Role, Page> = {
  calendar: newPage('calendar', 'Calendar', startUrl, new Lane(8, 0)),
  gmail: newPage('gmail', 'Gmail', mailOn ? mailStartUrl : null, new Lane(4, 100)),
};
const cal = pages.calendar;
const gm = pages.gmail;
const roleOf = (m: { role?: unknown }): Role => (m.role === 'gmail' ? 'gmail' : 'calendar');

// -------------------------------------------------------------------- state
const statePath = join(link.accountDir, 'state.json');
let kept: Partial<Winner> = readKept();
let display = 0;
let liveView: { vncSocket: string; width: number; height: number } | null = null;
let sandbox: Sandbox | null = null;
let sandboxError: string | null = null;
let startedAt = 0;
let tabs: TabInfo[] = [];
let signedInOnce = false;
let verified: Winner | null = null;
let probe: { at: number; ok: boolean; status: number | null; statuses: number[] } | null = null;
let probing: Promise<Winner | null> | null = null;
let probeTimer: Timer | undefined;
/** The Calendar page was reloaded: once it is back and signed in, one call shows whether it answers again. */
let recheck = false;
let gmailProbe: { at: number; accepted: boolean | null; summary: string } | null = null;
let gmailProbing = false;
let gmailLearn: { at: number; summary: string } | null = null;
let learning = false;
let gmailSelfCheck: { at: number; summary: string } | null = null;
let selfChecking = false;
const timers: Timer[] = [];

function readKept(): Partial<Winner> {
  try {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  } catch {
    return {};
  }
}

const bridgeToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
const bridge = new BridgeServer<Up, PageCmd | TabCmd>({
  token: bridgeToken,
  onMessage: onBridge,
  onConnect: () => {
    status();
    void openGmailTab();
  },
  onDisconnect: () => {
    for (const p of [cal, gm]) {
      p.hooked = 0;
      p.session = null;
    }
    status();
  },
  log,
});

// ------------------------------------------------------------------- status
const LOGIN: Attention = { kind: 'login', message: 'Sign in to Google in the live view', liveView: true };
const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};
const onCalendar = (u: string | null) => !!u && u.startsWith(`${calendarOrigin}/`);
const onMail = (u: string | null) => !!u && !!mailOrigin && u.startsWith(`${mailOrigin}/`);
const tab = () => cal.url;
const current = () => (cal.hooked ? cal.session : null);
const hhmm = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

function state(): { status: string; attention: Attention | null } {
  const att = (a: Attention) => ({ status: 'attention', attention: a });
  if (sandboxError) return { status: 'error', attention: { kind: 'unknown', message: `The sandbox failed to start: ${sandboxError}`, liveView: false } };
  if (!liveView) return { status: 'connecting', attention: null };
  if (!bridge.connected) {
    if (Date.now() - startedAt > ATTACH_MS) return att({ kind: 'unknown', message: 'The sandbox extension did not attach; open the live view to see the browser', liveView: true });
    return { status: 'connecting', attention: null };
  }
  const s = current();
  const t = tab();
  if (hostOf(t) === SIGN_IN_HOST) return att(LOGIN);
  if (s && !s.signedIn) return att(LOGIN);
  if (!s) {
    // Signed out, calendar.google.com may send you elsewhere (a product page); after a sign-in, it is a detour.
    if (t && !onCalendar(t)) return signedInOnce ? att({ kind: 'unknown', message: `Google Calendar is not open in the sandbox (it is on ${t}); open the live view and go back to it`, liveView: true }) : att(LOGIN);
    return { status: 'connecting', attention: null };
  }
  if (verified) return { status: 'online', attention: null };
  if (probe && !probe.ok && !probing) return att({ kind: 'api_refused', message: `Signed in, but Google refused the Calendar API with every key it was tried with (${probe.statuses.join(', ')})`, liveView: false });
  return { status: 'connecting', attention: null };
}

/** Which tabs the browser has, by role, with no address but a host where our hook is not. */
function tabsSummary(): string | null {
  if (!tabs.length) return null;
  const parts: string[] = [];
  let others = 0;
  for (const t of tabs) {
    const role = t.id === cal.tabId ? 'calendar' : t.id === gm.tabId ? 'gmail' : t.role;
    if (!role) others++;
    else parts.push(`${role} (${t.hook ? 'hook up' : `on ${hostOf(t.url) ?? 'nothing yet'}`})`);
  }
  if (others) parts.push(`${others} other${others > 1 ? 's' : ''}`);
  return parts.join(', ');
}

function details(): Record<string, string | number | boolean | null | string[]> {
  const shapes = [...new Set(cal.endpoints.filter((e) => e.auth).map((e) => `${e.auth!.schemes.join('+')}${e.auth!.u ? ' _u' : ''}`))];
  const s = current();
  const g = gm.hooked ? gm.session : null;
  return {
    // What the account is to a mail client (dither-chat's hub): Gmail, on a Workspace domain too.
    provider: 'Gmail',
    email: s?.email ?? null,
    authuser,
    display: liveView ? `:${display}` : null,
    page: tab(),
    extensionAttached: bridge.connected,
    calendarPage: cal.hooked > 0,
    signedIn: s ? s.signedIn : null,
    keySource: verified?.source ?? null,
    authStyle: verified?.auth ?? null,
    lastProbeAt: probe ? new Date(probe.at).toISOString() : null,
    lastProbeStatus: probe?.status ?? null,
    endpointsSeen: cal.endpoints.length,
    pageAuth: shapes.length ? shapes.join(', ') : null,
    tabs: tabsSummary(),
    mail: mailOn,
    gmailTab: gm.url,
    gmailPage: gm.hooked > 0,
    gmailSignedIn: g ? g.signedIn : null,
    calendarReloads: cal.reloads,
    gmailReloads: gm.reloads,
    gmailProbeAt: gmailProbe ? new Date(gmailProbe.at).toISOString() : null,
    gmailProbe: gmailProbe?.summary ?? null,
    gmailLearnAt: gmailLearn ? new Date(gmailLearn.at).toISOString() : null,
    gmailLearn: gmailLearn?.summary ?? null,
    // What the account is to a mail client (packages/interfaces/src/mail.ts): Gmail read through its page.
    idPerMessage: true,
    summaryHeaders: false,
    ...(mailOn ? { raw: 'original', searchIds: true, backgroundLane: true } : {}),
    // The background lane's stop (challenge, signedOut, quota) while it lasts; the unread guard; which bv layout answered.
    backgroundStopped: gmail ? gmail.background().stopped : null,
    readsMarkRead: gmail ? gmail.readsMarkRead : false,
    bvLayout: gmail?.evidence.bvLayout ?? null,
    // Writing: label changes and sending, as the page makes them (src/gmail/write.ts). Spam is not written.
    writes: mailOn ? ['seen', 'flagged', 'move', 'trash'] : [],
    canSend: sendNote() === null,
    sendNote: sendNote(),
    ...(mailOn ? { sendCap: SEND_CAP, maxRecipients: MAX_RECIPIENTS } : {}),
    gmailWatch: !mailOn ? null : !pollMs ? 'off' : !watchOn ? 'starts with the first mail call' : watchInfo.error ? `failed at ${hhmm(watchInfo.at)}: ${watchInfo.error}` : watchInfo.at ? `looked at ${hhmm(watchInfo.at)}` : 'starting',
    gmailSelfCheckAt: gmailSelfCheck ? new Date(gmailSelfCheck.at).toISOString() : null,
    gmailSelfCheck: gmailSelfCheck?.summary ?? null,
  };
}

/** Why mail.send cannot send now, in a sentence for a person; null when it can (the Gmail page up, signed in, as itself). */
function sendNote(): string | null {
  if (!mailOn) return 'This account reads no mail (mail: false in its config)';
  const s = gm.hooked ? gm.session : null;
  if (!bridge.connected || !s) return 'Gmail is not open in the sandbox yet';
  if (!s.signedIn) return 'Google is not signed in; sign in in the live view';
  if (!s.email) return "Gmail has not shown which address it is signed in as yet";
  return null;
}

/** What is wrong with how a page answers, if anything: a reload under way or failed, silence, a reload not yet answered. */
function trouble(p: Page): { note: string; failed: boolean } | null {
  // Calendar's reloaded page shows it answers with a call (recheck); Gmail makes no call of its own, so its hook coming
  // back up is its answer.
  const back = p.role === 'gmail' && !!p.lastReload && p.hookAt > p.lastReload.at;
  const unanswered = !!p.lastReload && p.answeredAt < p.lastReload.at && !back;
  if (p.reloading) return { note: `reloading the ${p.name} page: it did not answer ${SILENT_LIMIT} requests in a row`, failed: false };
  if (unanswered && p.lastReload?.error) return { note: `the ${p.name} page stopped answering, and its tab could not be reloaded (${p.lastReload.error})`, failed: true };
  if (p.silent > 0) return { note: `the ${p.name} page did not answer the last ${p.silent > 1 ? `${p.silent} requests` : 'request'} in ${PAGE_ANSWER_MS / 1000} s`, failed: false };
  if (unanswered) return { note: `the ${p.name} page stopped answering; its tab was reloaded at ${hhmm(p.lastReload!.at)}, waiting for an answer`, failed: false };
  return null;
}

/** The Gmail tab: ok when its hook is up and signed in, waiting while it loads, failed with a reason. */
function gmailLayer(): Layer {
  const name = 'Gmail page';
  if (!mailOn) return { name, state: 'off', note: cfg.mail === false ? 'mail: false in the config' : 'no Gmail origin to open in this setup' };
  if (!bridge.connected) return { name, state: 'waiting', note: 'waits for the extension' };
  const bad = trouble(gm);
  if (gm.reloading || bad?.failed) return { name, state: bad!.failed ? 'failed' : 'waiting', note: bad!.note };
  if (!gm.url) return gm.openError ? { name, state: 'failed', note: `the Gmail tab could not be opened (${gm.openError})` } : { name, state: 'waiting', note: 'opening the Gmail tab' };
  const s = gm.hooked ? gm.session : null;
  if (hostOf(gm.url) === SIGN_IN_HOST || (s && !s.signedIn)) return { name, state: 'waiting', note: 'sign in to Google in the live view' };
  if (!onMail(gm.url)) return signedInOnce ? { name, state: 'failed', note: `the Gmail tab is on ${hostOf(gm.url) ?? gm.url}, not Gmail` } : { name, state: 'waiting', note: 'sign in to Google in the live view' };
  if (!s) return { name, state: 'waiting', note: 'Gmail is loading' };
  if (bad) return { name, state: 'waiting', note: bad.note };
  return { name, state: 'ok', note: `hook up, signed in${gm.reloads ? `; reloaded ${gm.reloads}× (last at ${hhmm(gm.lastReload!.at)})` : ''}` };
}

/**
 * What the account rests on, outermost first (status.layers): the display, the browser on it, our extension in the
 * browser, the Google sign-in, an API key that works, and the Calendar API answering with it. From what the details
 * already say; the first layer not ok is where it stops. Then the Gmail page, which Calendar does not rest on.
 */
function layers(): Layer[] {
  const s = current();
  const t = tab();
  // A sandbox that did not start: Chromium's own failures are the browser's, the rest (no free display, Xvfb) the display's.
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
      ? { name: 'browser', state: 'ok', note: t ? `Chromium, on ${hostOf(t) ?? t}` : 'Chromium is running' }
      : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' }
    : browserFailed
      ? { name: 'browser', state: 'failed', note: sandboxError! }
      : { name: 'browser', state: 'waiting', note: 'not started yet' };
  const extension: Layer = bridge.connected
    ? { name: 'extension', state: 'ok', note: cal.hooked ? 'attached, in the Calendar page' : 'attached' }
    : liveView && startedAt && Date.now() - startedAt > ATTACH_MS
      ? { name: 'extension', state: 'failed', note: `did not attach within ${ATTACH_MS / 1000} s` }
      : { name: 'extension', state: 'waiting', note: 'not attached yet' };
  const signedIn: Layer = s?.signedIn
    ? { name: 'signed in', state: 'ok', note: s.email ?? undefined }
    : !bridge.connected
      ? { name: 'signed in', state: 'waiting', note: 'waits for the extension' }
      : (s && !s.signedIn) || hostOf(t) === SIGN_IN_HOST || (t && !onCalendar(t) && !signedInOnce)
        ? { name: 'signed in', state: 'waiting', note: 'sign in to Google in the live view' }
        : t && !onCalendar(t)
          ? { name: 'signed in', state: 'waiting', note: `Google Calendar is not open (the tab is on ${hostOf(t) ?? t})` }
          : { name: 'signed in', state: 'waiting', note: 'Google Calendar is loading' };
  const key: Layer = verified
    ? { name: 'API key', state: 'ok', note: `from ${verified.source}${verified.auth === 'u' ? ', _u hash' : ''}` }
    : probing
      ? { name: 'API key', state: 'waiting', note: 'trying keys' }
      : probe && !probe.ok
        ? { name: 'API key', state: 'failed', note: `every key was refused (${probe.statuses.join(', ')})` }
        : { name: 'API key', state: 'waiting', note: s?.signedIn ? 'not tried yet' : 'waits for the sign-in' };
  const bad = trouble(cal);
  const calendar: Layer =
    verified && probe?.ok
      ? bad
        ? { name: 'Calendar API', state: bad.failed ? 'failed' : 'waiting', note: bad.note }
        : { name: 'Calendar API', state: 'ok', note: `answered ${probe.status}, ${new Date(probe.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` }
      : { name: 'Calendar API', state: 'waiting', note: probe && !probe.ok ? `waits for a key (it answered ${probe.status ?? 'nothing'})` : 'waits for a key' };
  const protocol: Layer = gmail ? gmail.layer() : { name: 'Gmail protocol', state: 'off', note: 'no Gmail tab' };
  const background: Layer = gmail ? gmail.backgroundLayer() : { name: 'Gmail background', state: 'off', note: 'no Gmail tab' };
  return [screen, browser, extension, signedIn, key, calendar, gmailLayer(), protocol, background];
}

let lastSent = '';
function status(force = false) {
  const st = state();
  const email = current()?.email;
  const g = gm.hooked ? gm.session : null;
  const name = g?.email && g.email === email ? (g.name ?? null) : null;
  const ev = { t: 'status', status: st.status, attention: st.attention, liveView, ...(email ? { self: { email, ...(mailOn ? { addresses: [{ email, name }] } : {}) } } : {}), details: details(), layers: layers() };
  const s = JSON.stringify(ev);
  if (s === lastSent && !force) return;
  lastSent = s;
  link.emit(ev);
}

// ------------------------------------------------------------------- bridge
/** Each role's tab from the worker's list: its current page's, one with its hook, the one it had; Calendar's, else the active one. */
function noteTabs(list: TabInfo[]) {
  tabs = list;
  for (const p of [cal, gm]) {
    const mine = list.filter((t) => t.role === p.role);
    const other = p.role === 'calendar' ? gm.tabId : cal.tabId;
    let pick: TabInfo | undefined = mine.find((t) => t.current) ?? mine.find((t) => t.hook) ?? mine.find((t) => t.id === p.tabId) ?? list.find((t) => t.id === p.tabId && !t.role) ?? mine[0];
    // Calendar's tab is the browser's first: before its hook ever ran (sent straight to the sign-in page), the active one.
    if (!pick && p.role === 'calendar') pick = list.find((t) => t.active && t.id !== other && t.role !== 'gmail') ?? list.find((t) => t.id !== other && t.role !== 'gmail');
    const was = p.url;
    p.tabId = pick?.id ?? null;
    p.url = pick?.url ?? null;
    p.hooked = mine.filter((t) => t.hook).length;
    if (p.url !== was) log('info', `${p.role} tab on ${p.url ?? 'nothing'}`);
  }
}

function onBridge(msg: Up) {
  switch (msg.t) {
    case 'ready':
      log('info', 'extension service worker ready');
      break;
    case 'log':
      log(['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'debug', `[hook${msg.role === 'gmail' ? ' gmail' : ''}] ${String(msg.msg).slice(0, 200)}`);
      break;
    case 'tabs':
      noteTabs(Array.isArray(msg.tabs) ? msg.tabs : []);
      break;
    case 'hook':
      pages[roleOf(msg)].hookAt = Date.now();
      log('debug', `${roleOf(msg)} page hook up`, { page: msg.page });
      break;
    case 'session': {
      const p = pages[roleOf(msg)];
      const was = p.session?.signedIn;
      p.session = { signedIn: !!msg.signedIn, email: typeof msg.email === 'string' ? msg.email.slice(0, 200) : null, name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.slice(0, 200) : null };
      if (p.session.signedIn !== was) log('info', `${p.role} page: ${p.session.signedIn ? 'signed in' : 'not signed in'}`);
      if (p.role === 'gmail') gmail?.notePage(p.session.signedIn);
      if (p.role !== 'calendar') break;
      if (p.session.signedIn) {
        signedInOnce = true;
        if (!verified || recheck) scheduleProbe();
      } else verified = null;
      break;
    }
    case 'seen': {
      const p = pages[roleOf(msg)];
      p.endpoints = Array.isArray(msg.endpoints) ? msg.endpoints.slice(0, 300) : [];
      const before = new Set(p.keys.map((k) => `${k.source}:${k.key}`));
      p.keys = (Array.isArray(msg.keys) ? msg.keys : []).filter((k) => /^AIza[0-9A-Za-z_-]{35}$/.test(k.key));
      // A key we had not tried yet, after every key failed: try again.
      if (p.role === 'calendar' && p.keys.some((k) => !before.has(`${k.source}:${k.key}`)) && probe && !probe.ok && !verified) scheduleProbe();
      break;
    }
  }
  status();
}

// -------------------------------------------------------------------- tabs
/** The Gmail tab, opened in the background next to Calendar's, unless it is there already. */
async function openGmailTab(attempt = 0) {
  if (!mailOn || !gm.startUrl || !bridge.connected || cleaning) return;
  try {
    const r = await bridge.request<{ tabId: number; how: string }>({ kind: 'tab.open', page: 'gmail', url: gm.startUrl, tabId: gm.tabId }, TAB_COMMAND_MS);
    gm.tabId = r.tabId;
    gm.openError = null;
    log('info', r.how === 'open' ? 'the Gmail tab is open' : 'opened the Gmail tab');
  } catch (e) {
    gm.openError = String((e as Error).message ?? e).slice(0, 200);
    log('warn', 'could not open the Gmail tab', gm.openError);
    if (attempt < 4) timers.push(setTimeout(() => void openGmailTab(attempt + 1), 5000));
  }
  status();
}

/**
 * A page that stopped answering (2026-11-10: one account's Calendar page went quiet and every call timed out for an
 * hour, its status still all ok) has its tab reloaded, that tab alone: sent back to its start page by the service
 * worker, or, when the last reload did not bring it back, a new tab opened and the old one closed. The other page,
 * and the browser, are left as they are; a dead Chromium is another matter (boot: a supervised restart).
 */
async function reloadPage(p: Page) {
  if (p.reloading || !p.startUrl || cleaning) return;
  const fresh = !!p.lastReload && p.answeredAt < p.lastReload.at;
  const n = p.silent;
  p.reloading = true;
  p.generation++;
  p.silent = 0;
  p.reloads++;
  p.lastReload = { at: Date.now(), how: null };
  if (p.role === 'calendar') recheck = true;
  log('warn', `the ${p.name} page did not answer ${n} requests in a row; ${fresh ? 'opening its tab anew' : 'reloading its tab'}, and only that one`);
  status();
  try {
    const r = await bridge.request<{ tabId: number; how: string }>(
      { kind: 'tab.reload', page: p.role, url: p.startUrl, tabId: p.tabId, fresh, active: p.role === 'calendar' },
      TAB_COMMAND_MS,
    );
    p.tabId = r.tabId;
    p.lastReload.how = r.how;
    log('info', `the ${p.name} tab was ${r.how === 'navigated' ? 'sent back to its start page' : r.how}`);
  } catch (e) {
    p.lastReload.error = String((e as Error).message ?? e).slice(0, 200);
    log('warn', `the ${p.name} tab could not be reloaded`, p.lastReload.error);
  } finally {
    p.reloading = false;
    status();
  }
}

// -------------------------------------------------------------------- calls
/**
 * A request to one page, through its own lane. It is answered within PAGE_ANSWER_MS (time in the lane included) or
 * fails saying which page did not answer. Two unanswered in a row reload that page's tab.
 */
async function pageRequest<T>(role: Role, cmd: PageCmd, answerMs = PAGE_ANSWER_MS): Promise<T> {
  const p = pages[role];
  if (!bridge.connected) throw new StatusError('the sandbox browser is not attached', 503);
  const silence = () => new StatusError(`the ${p.name} page did not answer in ${answerMs / 1000} s`, 503);
  const deadline = Date.now() + answerMs;
  if (!(await p.lane.take(deadline))) throw silence();
  const generation = p.generation;
  const sentAt = Date.now();
  try {
    const r = await bridge.request<T>({ ...cmd, page: role }, Math.max(1, deadline - sentAt));
    answered(p);
    return r;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (!msg.startsWith('hook timed out')) {
      answered(p, false);
      throw new StatusError(msg, 503);
    }
    // One cut short by its wait in the lane is not the page's silence; one sent to a page since reloaded is the old page's.
    if (generation === p.generation && deadline - sentAt >= answerMs / 2) unanswered(p);
    throw silence();
  } finally {
    p.lane.give();
  }
}

/** An answer (or a refusal, which is the page or the worker answering too): the silence is over. */
function answered(p: Page, fromPage = true) {
  const was = p.silent;
  p.silent = 0;
  if (fromPage) p.answeredAt = Date.now();
  if (was) status();
}

function unanswered(p: Page) {
  p.silent++;
  log('warn', `the ${p.name} page did not answer in ${PAGE_ANSWER_MS / 1000} s (${p.silent} in a row)`);
  status();
  if (p.silent >= SILENT_LIMIT) void reloadPage(p);
}

const gfetch = (cmd: Gfetch) => pageRequest<GResponse>('calendar', cmd);

// -------------------------------------------------------------------- probe
function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => void runProbe().catch(() => {}), PROBE_SETTLE_MS);
}

/** Keys to try, best first: the one that worked last time, keys the page's own Calendar calls use, the rest, the embed key. */
function candidates(): { key: string; source: KeySource }[] {
  const out: { key: string; source: KeySource }[] = [];
  const add = (key: string | undefined, source: KeySource | undefined) => {
    if (key && source && !out.some((c) => c.key === key)) out.push({ key, source });
  };
  add(kept.key, kept.source);
  for (const k of cal.keys) if (k.source === 'calendar-request') add(k.key, k.source);
  for (const k of cal.keys) add(k.key, k.source);
  add(EMBED_KEY, 'embed');
  return out;
}

function runProbe(): Promise<Winner | null> {
  probing ??= doProbe().finally(() => {
    probing = null;
    status();
  });
  return probing;
}

/** Why Google refused a call, from its error JSON: the status, the reason and the message, never anything else. */
function refusal(r: GResponse): string {
  const e = r.json?.error;
  if (!e) return r.text ? `not JSON: ${String(r.text).replace(/\s+/g, ' ').slice(0, 120)}` : 'no body';
  const reason = e.errors?.[0]?.reason ?? e.details?.find((d: any) => d?.reason)?.reason ?? null;
  return [e.status, reason, typeof e.message === 'string' ? e.message.slice(0, 200) : null].filter(Boolean).join(': ');
}

async function doProbe(): Promise<Winner | null> {
  clearTimeout(probeTimer);
  recheck = false;
  log('debug', 'the page calls', cal.endpoints.map((e) => `${e.host}${e.path}${e.keyed ? ' key' : ''}${e.auth ? ` [${e.auth.schemes.join('+')}${e.auth.u ? ' _u' : ''}]` : ''}`));
  const pageUsesU = cal.endpoints.some((e) => e.auth?.u);
  const styles: AuthStyle[] = !pageUsesU ? ['plain'] : kept.auth === 'plain' ? ['plain', 'u'] : ['u', 'plain'];
  const statuses: number[] = [];
  for (const c of candidates()) {
    for (const auth of styles) {
      let r: GResponse;
      try {
        r = await gfetch({ kind: 'gfetch', method: 'GET', url: `${apiBase}/calendar/v3/users/me/calendarList`, query: { maxResults: 1, key: c.key }, auth });
      } catch (e) {
        log('warn', 'probe could not reach the page', String((e as Error).message ?? e).slice(0, 200));
        // Not an answer about the key: the next sign-in the page says (a reloaded page's) asks again.
        if (cal.lastReload) recheck = true;
        return null;
      }
      statuses.push(r.status);
      log('info', `probe: key from ${c.source}, ${auth} hash: ${r.status}${r.status === 200 ? '' : ` (${refusal(r)})`}`);
      if (r.status === 200) {
        verified = { key: c.key, source: c.source, auth };
        probe = { at: Date.now(), ok: true, status: 200, statuses };
        if (kept.key !== c.key || kept.auth !== auth) {
          kept = verified;
          writeFileSync(statePath, JSON.stringify(kept, null, 2), { mode: 0o600 });
        }
        return verified;
      }
    }
  }
  verified = null;
  probe = { at: Date.now(), ok: false, status: statuses.at(-1) ?? null, statuses };
  log('warn', 'every key was refused', { statuses });
  return null;
}

// --------------------------------------------------------------- gmail probe
type ProbeRow = {
  endpoint: 'profile' | 'labels';
  key: 'none' | KeySource;
  auth: AuthStyle;
  status: number | null;
  googleStatus?: string;
  reason?: string;
  message?: string;
  error?: string;
  fields?: string[];
  labels?: number | null;
};

/** Google's error message, cut short, with anything like a key or an address taken out. */
const scrub = (s: unknown) =>
  String(s)
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '<key>')
    .replace(/[^\s()<>"',;:]+@[^\s()<>"',;:]+/g, '<address>')
    .replace(/\s+/g, ' ')
    .slice(0, 160);

/** Keys the Gmail page carries, its own API calls' first: at most two, with where they came from. */
function gmailKeys(): { key: string; source: KeySource }[] {
  const order: KeySource[] = ['gmail-request', 'page-request', 'page-html'];
  return [...gm.keys].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source)).slice(0, 2);
}

/**
 * One question, kept as a diagnostic: does the public Gmail API v1 take the Gmail page's first-party auth (its cookies
 * and a SAPISIDHASH made with https://mail.google.com, the page's own origin)? From the Gmail tab, GETs users/me/profile
 * and users/me/labels with no key and with each key the page carries, each with the plain and the _u hash. Read-only.
 * Keeps only statuses, Google's error status, reason and message (cut short), and for a 200 the profile's field names
 * and the number of labels: never a value, an address, a label's name or a key.
 */
async function gmailApiProbe() {
  const s = gm.hooked ? gm.session : null;
  const keys = gmailKeys();
  const out = {
    at: new Date().toISOString(),
    question: "Does the Gmail API v1 take the Gmail page's first-party auth (SAPISIDHASH made with the page's origin)?",
    origin: mailOrigin,
    api: gmailApiBase,
    page: { tab: !!gm.url, hook: gm.hooked > 0, signedIn: s ? s.signedIn : null, keys: keys.map((k) => k.source) },
    accepted: null as boolean | null,
    acceptedWith: [] as { endpoint: string; key: string; auth: AuthStyle }[],
    results: [] as ProbeRow[],
    error: null as string | null,
  };
  if (!mailOn) return { ...out, error: 'this account has no Gmail tab' };
  if (!s) return { ...out, error: 'the Gmail page is not up (no hook in it)' };
  if (!s.signedIn) return { ...out, error: 'the Gmail page is not signed in' };
  const tries: { source: 'none' | KeySource; key: string | null }[] = [{ source: 'none', key: null }, ...keys];
  let timeouts = 0;
  run: for (const [endpoint, path] of [
    ['profile', '/gmail/v1/users/me/profile'],
    ['labels', '/gmail/v1/users/me/labels'],
  ] as const) {
    for (const k of tries) {
      for (const auth of ['plain', 'u'] as const) {
        const row: ProbeRow = { endpoint, key: k.source, auth, status: null };
        out.results.push(row);
        let r: GResponse;
        try {
          r = await pageRequest<GResponse>('gmail', { kind: 'gfetch', method: 'GET', url: gmailApiBase + path, query: k.key ? { key: k.key } : {}, auth });
        } catch (e) {
          row.error = scrub((e as Error).message ?? e);
          if (/did not answer/.test(row.error) && ++timeouts >= SILENT_LIMIT) {
            out.error = 'the Gmail page stopped answering; the probe stopped there';
            break run;
          }
          continue;
        }
        timeouts = 0;
        row.status = r.status;
        if (r.status === 200) {
          if (endpoint === 'profile') row.fields = Object.keys(r.json ?? {}).filter((f) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(f)).sort().slice(0, 20);
          else row.labels = Array.isArray(r.json?.labels) ? r.json.labels.length : null;
          out.acceptedWith.push({ endpoint, key: k.source, auth });
          continue;
        }
        const e = r.json?.error;
        if (!e) row.message = r.text !== undefined ? 'not JSON' : 'no body';
        else {
          if (typeof e.status === 'string') row.googleStatus = scrub(e.status).slice(0, 60);
          const reason = e.errors?.[0]?.reason ?? e.details?.find((d: any) => d?.reason)?.reason;
          if (typeof reason === 'string') row.reason = scrub(reason).slice(0, 60);
          if (typeof e.message === 'string') row.message = scrub(e.message);
        }
      }
    }
  }
  out.accepted = out.results.some((r) => r.status !== null) ? out.acceptedWith.length > 0 : null;
  return out;
}

/** probe-gmail.request in the account's directory: taken (deleted), the probe run, its answer in probe-gmail.json. */
function checkProbeRequest() {
  const asked = join(link.accountDir, PROBE_REQUEST);
  if (gmailProbing || !existsSync(asked)) return;
  rmSync(asked, { force: true });
  gmailProbing = true;
  log('info', `gmail probe: asked for (${PROBE_REQUEST})`);
  void gmailApiProbe()
    .then((r) => {
      const path = join(link.accountDir, PROBE_RESULT);
      writeFileSync(`${path}.tmp`, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      for (const row of r.results)
        log('info', `gmail probe: ${row.endpoint}, key ${row.key}, ${row.auth} hash: ${row.status ?? 'no answer'}${[row.googleStatus, row.reason, row.message, row.error].filter(Boolean).map((x) => ` ${x}`).join('')}${row.fields ? ` fields ${row.fields.join(',')}` : ''}${row.labels !== undefined ? ` labels ${row.labels}` : ''}`);
      const summary =
        r.error && !r.results.length
          ? r.error
          : r.accepted
            ? `accepted (${r.acceptedWith.map((a) => `${a.endpoint} key ${a.key} ${a.auth}`).join('; ')})`
            : `${r.accepted === false ? 'refused' : 'no answer'} (${r.results.map((x) => x.status ?? '-').join(', ')})${r.error ? `; ${r.error}` : ''}`;
      gmailProbe = { at: Date.now(), accepted: r.accepted, summary };
      log('info', `gmail probe: ${summary}; written to ${PROBE_RESULT}`);
    })
    .catch((e) => log('warn', 'gmail probe failed', String((e as Error).message ?? e).slice(0, 200)))
    .finally(() => {
      gmailProbing = false;
      status();
    });
}

// -------------------------------------------------------- learning Gmail's protocol
/**
 * gmail-learn.json in the account's directory: taken (deleted), checked as a whole (learn.ts: at most 12 steps, 5
 * openRead, waits of 1 to 20 s, navs to a few views or an operators-only search), then run step by step in the Gmail
 * tab. A bad script is refused, logged, and nothing of it runs. A file not yet JSON that changed in the last 2 s is
 * still being written: it waits for the next look.
 */
function checkLearnRequest() {
  const asked = join(link.accountDir, LEARN_REQUEST);
  if (learning || !existsSync(asked)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(asked, 'utf8'));
  } catch {
    try {
      if (Date.now() - statSync(asked).mtimeMs < 2000) return;
    } catch {}
    raw = undefined;
  }
  rmSync(asked, { force: true });
  const checked = raw === undefined ? { error: 'the script is not JSON' } : checkLearnScript(raw);
  if ('error' in checked) {
    log('warn', `gmail learn: refused, nothing ran: ${checked.error}`);
    gmailLearn = { at: Date.now(), summary: `refused: ${checked.error}` };
    status();
    return;
  }
  learning = true;
  void runLearn(checked.steps)
    .then((summary) => {
      gmailLearn = { at: Date.now(), summary };
      log('info', `gmail learn: ${summary}`);
    })
    .catch((e) => log('warn', 'gmail learn failed', String((e as Error).message ?? e).slice(0, 200)))
    .finally(() => {
      learning = false;
      status();
    });
}

/**
 * The steps, one after the other, in the Gmail tab. A failed step (the page refused it, or did not answer) stops the
 * run. `back` only goes back over what this run did (a nav that changed the address, a thread it opened), so it never
 * leaves Gmail. Logs each step by its kind, never a search's words.
 */
async function runLearn(steps: LearnStep[]): Promise<string> {
  const s = gm.hooked ? gm.session : null;
  if (!mailOn || !s?.signedIn) return `did not run: ${!mailOn ? 'this account has no Gmail tab' : !s ? 'the Gmail page is not up' : 'the Gmail page is not signed in'}`;
  log('info', `gmail learn: running ${steps.length} steps`);
  let depth = 0;
  let opened = 0;
  let collected: number | null = null;
  for (const [i, step] of steps.entries()) {
    const n = `step ${i + 1} (${describeStep(step)})`;
    try {
      if ('wait' in step) await Bun.sleep(step.wait * 1000);
      else if ('nav' in step) {
        const r = await pageRequest<{ changed?: boolean }>('gmail', { kind: 'gmail.nav', hash: step.nav });
        if (r?.changed) depth++;
        log('info', `gmail learn: ${n}: ${r?.changed ? 'done' : 'already there'}`);
      } else if ('openRead' in step) {
        const r = await pageRequest<{ opened?: boolean; reason?: string }>('gmail', { kind: 'gmail.openRead', index: step.openRead });
        if (r?.opened) {
          depth++;
          opened++;
        }
        log('info', `gmail learn: ${n}: ${r?.opened ? 'opened' : `not opened (${String(r?.reason ?? 'no reason').slice(0, 160)})`}`);
      } else if ('back' in step) {
        if (depth <= 0) {
          log('info', `gmail learn: ${n}: skipped, nothing of this run to go back over`);
          continue;
        }
        await pageRequest('gmail', { kind: 'gmail.back' });
        depth--;
        log('info', `gmail learn: ${n}: done`);
      } else collected = await collectShapes();
    } catch (e) {
      const why = String((e as Error).message ?? e).slice(0, 200);
      log('warn', `gmail learn: ${n} failed, the run stops there: ${why}`);
      return `stopped at step ${i + 1} of ${steps.length} (${why}); opened ${opened} read thread${opened === 1 ? '' : 's'}`;
    }
  }
  return `ran ${steps.length} steps; opened ${opened} read thread${opened === 1 ? '' : 's'}${collected !== null ? `; collected ${collected} templates` : ''}`;
}

/** collect: everything the Gmail page recorded so far, sorted by template, in gmail-shapes.json; a one-line summary in the log. */
async function collectShapes(): Promise<number> {
  const r = await pageRequest<{ templates?: ShapeEntry[]; dropped?: number }>('gmail', { kind: 'gmail.shapes' });
  // Only what reads as a template (the hook's, with ids and numbers out): a method, a path of plain segments.
  const templates = (Array.isArray(r?.templates) ? r.templates : [])
    .filter((t) => t && /^[A-Z]{1,10}$/.test(String(t.method)) && /^\/[\w.{}/-]{0,400}$/.test(String(t.template)) && Number.isInteger(t.count) && Array.isArray(t.samples))
    .slice(0, 300)
    .map((t) => ({ method: t.method, template: t.template, count: t.count, samples: t.samples.slice(0, 6) }))
    .sort((a, b) => (a.template < b.template ? -1 : a.template > b.template ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
  const path = join(link.accountDir, LEARN_SHAPES);
  const out = { at: new Date().toISOString(), templates, dropped: Number.isInteger(r?.dropped) ? r.dropped : 0 };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  const listed = templates.slice(0, 40).map((t) => `${t.method} ${t.template} ×${t.count}`);
  log('info', `gmail learn: collected ${templates.length} templates${listed.length ? `: ${listed.join(', ')}${templates.length > listed.length ? `, +${templates.length - listed.length} more` : ''}` : ''}; written to ${LEARN_SHAPES}`);
  return templates.length;
}

// ------------------------------------------------------------------- gmail mail
/** What the hook said a non-mail answer reads as: only its two words pass. */
const pageKindOf = (v: unknown): PageKind | null => (v === 'signin' || v === 'challenge' ? v : null);

/**
 * A write's failure in the page, as what it says of Gmail: 503 only when nothing can have reached Gmail (the browser
 * not attached); a page that did not answer in time may have made it (504); the hook refusing the body, or not knowing
 * the command (an older extension), is ours (500), and trying again will not help.
 */
function writeError(e: unknown): StatusError {
  const err = e as StatusError;
  const msg = String(err?.message ?? e);
  if (/not attached/.test(msg)) return err instanceof StatusError ? err : new StatusError(msg, 503);
  if (/did not answer/.test(msg)) return new StatusError(`${msg}; the change may have been made`, 504);
  return new StatusError(`the Gmail page would not make it (${msg.slice(0, 160)})`, 500);
}

/** The Gmail tab, as GmailMail needs it: every call through the hook in that page (docs/google.md, "Gmail mail"). */
const gmailTransport: Transport = {
  async info() {
    const r = await pageRequest<{ sync?: unknown; headers?: unknown; ik?: unknown; history?: unknown }>('gmail', { kind: 'gmail.syncInfo' });
    return { sync: r?.sync === true, headers: Number(r?.headers) || 0, ik: r?.ik === true, history: typeof r?.history === 'string' && /^\d{1,15}$/.test(r.history) ? r.history : null };
  },
  async sync(endpoint, body) {
    const r = await pageRequest<SyncAnswer>('gmail', { kind: 'gmail.sync', endpoint, body });
    return { ...r, page: pageKindOf(r?.page) };
  },
  async raw(hex, max) {
    const r = await pageRequest<{ status?: number; token?: string; size?: number; tooBig?: number; type?: string | null; error?: string; page?: unknown }>('gmail', { kind: 'gmail.raw', hex, max }, RAW_ANSWER_MS);
    const status = typeof r?.status === 'number' ? r.status : 0;
    if (typeof r?.token !== 'string') return { status, tooBig: typeof r?.tooBig === 'number' ? r.tooBig : undefined, type: r?.type ?? null, error: r?.error, page: pageKindOf(r?.page) };
    const size = Number(r.size);
    try {
      if (!Number.isInteger(size) || size < 0 || size > max) return { status, tooBig: size };
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < size; offset += RAW_PIECE) {
        const c = await pageRequest<{ base64?: string }>('gmail', { kind: 'gmail.rawChunk', token: r.token, offset, length: RAW_PIECE });
        pieces.push(Buffer.from(String(c?.base64 ?? ''), 'base64'));
      }
      const bytes = Buffer.concat(pieces);
      if (bytes.length !== size) return { status: 0, error: 'the download came over short' };
      return { status, bytes, type: r.type ?? null };
    } finally {
      void pageRequest('gmail', { kind: 'gmail.rawDrop', token: r.token }).catch(() => {});
    }
  },
  async write(body) {
    try {
      const r = await pageRequest<SyncAnswer>('gmail', { kind: 'gmail.write', body });
      return { ...r, page: pageKindOf(r?.page) };
    } catch (e) {
      throw writeError(e);
    }
  },
  async upload(file, meta) {
    let token: string | undefined;
    for (let at = 0; at < file.bytes.length || at === 0; at += RAW_PIECE) {
      const c = await pageRequest<{ token?: string }>('gmail', { kind: 'gmail.uploadChunk', token, base64: file.bytes.subarray(at, at + RAW_PIECE).toString('base64') });
      token = typeof c?.token === 'string' ? c.token : undefined;
      if (!token) return { status: 0, error: 'the page did not take the file' };
      if (!file.bytes.length) break;
    }
    const r = await pageRequest<{ status?: number; token?: unknown; error?: string; page?: unknown }>('gmail', { kind: 'gmail.upload', token: token!, size: file.bytes.length, name: file.name, mime: file.mime, meta }, RAW_ANSWER_MS).catch((e) => {
      throw writeError(e);
    });
    return { status: typeof r?.status === 'number' ? r.status : 0, token: typeof r?.token === 'string' ? r.token : undefined, error: r?.error, page: pageKindOf(r?.page) };
  },
};
const gmail = mailOn ? new GmailMail(gmailTransport, { log, onChange: () => status(), stateFile: join(link.accountDir, READS_FILE) }) : null;

/** The Gmail tab is up and signed in, or the reason it is not. */
function gmailReady(): GmailMail {
  if (!gmail) throw new StatusError(cfg.mail === false ? 'this account reads no mail (mail: false in its config)' : 'this account has no Gmail tab', 501);
  if (!bridge.connected) throw new StatusError('the sandbox browser is not attached yet', 503);
  const s = gm.hooked ? gm.session : null;
  if (!s) throw new StatusError('Gmail is not open in the sandbox yet', 503);
  if (!s.signedIn) throw new StatusError('Google is not signed in; sign in in the live view', 401);
  return gmail;
}

/** The message an op names: its `id` (decimal, Gmail's), or `message` as the imap kind also takes it. */
function messageArg(cmd: Command): string {
  if (typeof cmd.id === 'string' && DECIMAL_ID.test(cmd.id)) return cmd.id;
  if (typeof cmd.message === 'string') return cmd.message;
  return String(cmd.id ?? '');
}

/**
 * A mail op, once the Gmail tab is ready. A background one (`background: true`) is refused first while the background
 * lane is stopped (503 'paused'), a signed-out page included, rather than with the page's own reasons.
 */
/**
 * Each mail op's own time (the interface's timeoutMs) less this margin is all a background call may take, waits in the
 * lane included: past it, 503 'backoff' under the manager's timeout (the work may finish later; its answer is dropped).
 */
const BACKGROUND_MARGIN_MS = 8_000;
const OP_MS: Record<string, number> = { 'mail.list': 60_000, 'mail.get': 60_000, 'mail.attachment': 120_000, 'mail.raw': 120_000, 'mail.search': 120_000 };

async function mailOp<T>(f: (g: GmailMail) => Promise<T>, background?: unknown, op?: string): Promise<T> {
  if (background === true && gmail) {
    const s = gm.hooked ? gm.session : null;
    if (s && !s.signedIn) gmail.notePage(false);
    gmail.admit(true);
  }
  const g = gmailReady();
  startWatch();
  if (background !== true || !op || !OP_MS[op]) return f(g);
  const within = OP_MS[op]! - BACKGROUND_MARGIN_MS;
  let timer: Timer | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StatusError(`Gmail background reading could not finish this call within ${Math.round(within / 1000)} s; try again later`, 503, 'backoff')), within);
  });
  try {
    return await Promise.race([f(g), late]);
  } finally {
    clearTimeout(timer);
  }
}

// The watch: s from where it got to, every gmailPollSeconds, once a mail call was made: mail.changed for each mailbox
// the changed threads' messages are in, mail.arrived for new mail in the inbox. It waits while the page does not
// answer, is reloaded, or runs a learn run, the probe or the self-check.
let watch: { history: string; at: number; guess?: boolean } | null = readWatch();
let watchOn = false;
let watching = false;
let watchInfo: { at: number; error: string | null } = { at: 0, error: null };

function readWatch(): { history: string; at: number; guess?: boolean } | null {
  try {
    const w = JSON.parse(readFileSync(join(link.accountDir, WATCH_FILE), 'utf8'));
    return typeof w?.history === 'string' && /^\d{1,15}$/.test(w.history) && Number.isInteger(w.at) ? { history: w.history, at: w.at, ...(w.guess === true ? { guess: true } : {}) } : null;
  } catch {
    return null;
  }
}
/** `guess`: the sync point came from a list answer (bv's json[18][0]), not from Gmail's sync. */
function saveWatch(w: { history: string; at: number; guess?: boolean }) {
  watch = w;
  try {
    writeFileSync(join(link.accountDir, WATCH_FILE), JSON.stringify(w), { mode: 0o600 });
  } catch {}
}

function startWatch() {
  if (watchOn || !pollMs || !gmail || cleaning) return;
  watchOn = true;
  timers.push(setInterval(() => void pollMail(), pollMs));
  void pollMail();
  status();
}

async function pollMail() {
  if (watching || !gmail || cleaning) return;
  const s = gm.hooked ? gm.session : null;
  if (!bridge.connected || !s?.signedIn || gm.reloading || gm.silent > 0 || trouble(gm) || learning || gmailProbing || selfChecking) return;
  watching = true;
  try {
    if (!watch) {
      const p = await gmail.pointInfo();
      saveWatch({ history: p.history, at: Date.now(), ...(p.guess ? { guess: true } : {}) });
      log('info', `gmail watch: started from the current sync point${p.guess ? " (a list answer's)" : ''}`);
    } else {
      const r = await gmail.poll(watch);
      const state = stateOf(r.history, r.at);
      for (const b of r.mailboxes) link.emit({ t: 'mail.changed', mailboxId: b, state });
      for (const m of r.arrived) link.emit({ t: 'mail.arrived', message: m });
      if (r.mailboxes.length || r.arrived.length) log('info', `gmail watch: ${r.mailboxes.length} mailbox${r.mailboxes.length === 1 ? '' : 'es'} changed, ${r.arrived.length} arrived`);
      // Gmail's sync answered: its point is one (a list answer's, once taken, is confirmed).
      if (r.history !== watch.history || r.mailboxes.length || watch.guess) saveWatch({ history: r.history, at: r.at });
    }
    watchInfo = { at: Date.now(), error: null };
  } catch (e) {
    watchInfo = { at: Date.now(), error: String((e as Error).message ?? e).slice(0, 160) };
    log('warn', 'gmail watch: could not look', watchInfo.error);
    // A list answer's number that Gmail's sync did not take: start again from a sync point that is one.
    if (watch?.guess && gmail.bvPointRefused) {
      watch = null;
      rmSync(join(link.accountDir, WATCH_FILE), { force: true });
    }
  } finally {
    watching = false;
    status();
  }
}

/**
 * gmail-selfcheck.request in the account's directory: taken (deleted), the self-check run on the live page
 * (selfcheck.ts), its report in gmail-selfcheck.json (0600): counts, booleans and types only.
 */
function checkSelfCheckRequest() {
  const asked = join(link.accountDir, SELFCHECK_REQUEST);
  if (selfChecking || !existsSync(asked)) return;
  rmSync(asked, { force: true });
  const path = join(link.accountDir, SELFCHECK_RESULT);
  const write = (r: unknown) => {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  let g: GmailMail;
  try {
    g = gmailReady();
  } catch (e) {
    const why = String((e as Error).message ?? e).slice(0, 160);
    write({ at: new Date().toISOString(), ok: false, error: why });
    gmailSelfCheck = { at: Date.now(), summary: `did not run: ${why}` };
    log('info', `gmail self-check: did not run: ${why}`);
    status();
    return;
  }
  selfChecking = true;
  log('info', `gmail self-check: asked for (${SELFCHECK_REQUEST})`);
  void selfCheck(g, () => gmailTransport.info())
    .then((r) => {
      write(r);
      // The shapes of answers that failed their fingerprint (no values), beside the report, to fix the layout from.
      const shapes: Record<string, unknown> = Object.fromEntries(Object.entries(g.fp).filter(([, f]) => f.firstShape !== undefined).map(([e, f]) => [e, { reason: f.first, shape: f.firstShape }]));
      if (g.notYetGmailShape !== undefined) shapes.msgA = { reason: 'a message whose id is msg-a, skipped', shape: g.notYetGmailShape };
      if (Object.keys(shapes).length) {
        const sp = join(link.accountDir, 'gmail-mismatch-shapes.json');
        writeFileSync(`${sp}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), shapes }, null, 2)}\n`, { mode: 0o600 });
        renameSync(`${sp}.tmp`, sp);
      }
      const n = (x: unknown) => (typeof x === 'number' ? x : '-');
      const summary = `${r.ok ? 'ok' : 'not ok'}: ${n((r.mailboxes as { count?: number }).count)} mailboxes, inbox ${n((r.inbox as { listed?: number }).listed)}, all mail ${n((r.allMail as { listed?: number }).listed)}, ids ${n((r.searchIds as { ids?: number }).ids)}, message ${r.message.found ? 'read' : 'none found'}; ${r.ms} ms`;
      gmailSelfCheck = { at: Date.now(), summary };
      log('info', `gmail self-check: ${summary}; written to ${SELFCHECK_RESULT}`);
    })
    .catch((e) => log('warn', 'gmail self-check failed', String((e as Error).message ?? e).slice(0, 200)))
    .finally(() => {
      selfChecking = false;
      status();
    });
}

// ---------------------------------------------------------------- calendar
async function ready(): Promise<Winner> {
  if (!bridge.connected) throw new StatusError('the sandbox browser is not attached yet', 503);
  const s = current();
  if (!s) throw new StatusError('Google Calendar is not open in the sandbox', 503);
  if (!s.signedIn) throw new StatusError('Google is not signed in; sign in in the live view', 401);
  if (verified) return verified;
  const w = await runProbe();
  if (!w) throw new StatusError(`Google refused the Calendar API with every key (${probe?.statuses.join(', ') ?? 'no answer'})`, probe?.status ?? 503);
  return w;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** One Calendar API call, retried like rest.ts; on a 401/403, the key is probed again once. */
async function api(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<any> {
  let w = await ready();
  let reprobed = false;
  const query: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) query[k] = v;
  for (let attempt = 0; ; attempt++) {
    const r = await gfetch({ kind: 'gfetch', method, url: apiBase + path, query: { ...query, key: w.key }, body: opts.body, auth: w.auth });
    if (r.status >= 200 && r.status < 300) return r.status === 204 ? {} : (r.json ?? {});
    const reason: string | null = r.json?.error?.errors?.[0]?.reason ?? r.json?.error?.status ?? null;
    const message: string = r.json?.error?.message ?? `Google answered ${r.status}`;
    const rateLimited = r.status === 429 || (r.status === 403 && !!reason && RATE_REASONS.has(reason));
    if ((r.status === 401 || r.status === 403) && !rateLimited && !reprobed) {
      reprobed = true;
      log('info', `${method} ${path.split('/').slice(0, 4).join('/')}: ${r.status}; probing keys again`);
      const again = await runProbe();
      if (!again) throw new StatusError(message, r.status);
      w = again;
      attempt--;
      continue;
    }
    if ((rateLimited || r.status >= 500) && attempt < RETRIES) {
      const after = Number(r.retryAfter);
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF * 2 ** attempt * (1 + Math.random() * 0.25);
      await Bun.sleep(Math.min(wait, 60_000));
      continue;
    }
    throw new StatusError(message, r.status);
  }
}

const enc = encodeURIComponent;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const page = (p: any) => ({ items: p.items ?? [], ...(p.nextPageToken ? { nextPageToken: p.nextPageToken } : {}), ...(p.nextSyncToken ? { nextSyncToken: p.nextSyncToken } : {}) });

async function onCommand(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'calendar.calendarList.list':
      return page(await api('GET', '/calendar/v3/users/me/calendarList', { query: { pageToken: str(cmd.pageToken), maxResults: cmd.maxResults as number | undefined, syncToken: str(cmd.syncToken) } }));
    case 'calendar.calendarList.patch':
      return api('PATCH', `/calendar/v3/users/me/calendarList/${enc(String(cmd.calendarId))}`, { query: { colorRgbFormat: cmd.colorRgbFormat as boolean | undefined }, body: cmd.body });
    case 'calendar.calendars.insert':
      return api('POST', '/calendar/v3/calendars', { body: cmd.body });
    case 'calendar.events.list': {
      const query = {
        syncToken: str(cmd.syncToken),
        pageToken: str(cmd.pageToken),
        maxResults: cmd.maxResults as number | undefined,
        singleEvents: cmd.singleEvents as boolean | undefined,
        showDeleted: cmd.showDeleted as boolean | undefined,
        timeMin: str(cmd.timeMin),
        timeMax: str(cmd.timeMax),
      };
      return page(await api('GET', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events`, { query }));
    }
    case 'calendar.events.insert':
      return api('POST', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events`, { body: cmd.body });
    case 'calendar.events.patch':
      return api('PATCH', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events/${enc(String(cmd.eventId))}`, { body: cmd.body });
    case 'calendar.events.delete':
      await api('DELETE', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events/${enc(String(cmd.eventId))}`);
      return {};
    case 'mail.mailboxes':
      return mailOp((g) => g.mailboxes());
    case 'mail.list':
      return mailOp((g) => g.list({ mailboxId: cmd.mailboxId, limit: cmd.limit, before: cmd.before, since: cmd.since, background: cmd.background }), cmd.background, 'mail.list');
    case 'mail.get':
      return mailOp((g) => g.get({ id: messageArg(cmd), background: cmd.background }), cmd.background, 'mail.get');
    case 'mail.attachment':
      return mailOp((g) => g.attachment({ id: messageArg(cmd), attachmentId: cmd.attachmentId, background: cmd.background }), cmd.background, 'mail.attachment');
    case 'mail.raw':
      return mailOp((g) => g.raw({ id: messageArg(cmd), background: cmd.background }), cmd.background, 'mail.raw');
    case 'mail.search':
      return mailOp((g) => g.search({ query: cmd.query, mailboxId: cmd.mailboxId, limit: cmd.limit, idsOnly: cmd.idsOnly, cursor: cmd.cursor, background: cmd.background }), cmd.background, 'mail.search');
    case 'mail.changes':
      return mailOp((g) => g.changes({ mailboxId: cmd.mailboxId, state: cmd.state }));
    case 'mail.flag':
      return mailOp((g) => g.flag({ ids: cmd.ids, threadIds: cmd.threadIds, seen: cmd.seen, flagged: cmd.flagged, answered: cmd.answered }));
    case 'mail.move':
      return mailOp((g) => g.move({ ids: cmd.ids, threadIds: cmd.threadIds, mailboxId: cmd.mailboxId }));
    case 'mail.trash':
      return mailOp((g) => g.trash({ ids: cmd.ids, threadIds: cmd.threadIds }));
    case 'mail.send': {
      const m = checkOutgoing(cmd as unknown as OutgoingMail, link.accountDir);
      return mailOp((g) => {
        const s = gm.hooked ? gm.session : null;
        if (!s?.email) throw new StatusError("Gmail has not shown which address it is signed in as yet; try again in a moment", 503, 'unavailable');
        return g.send(m, { email: s.email, name: s.name ?? null });
      });
    }
    default:
      throw new Error(`google has no operation "${cmd.t}"`);
  }
}

// --------------------------------------------------------------------- boot
/** Tests only: let the extension's scripts and permissions cover the fake Google's origins too. */
function addTestOrigins(dir: string) {
  const path = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const patterns = [...new Set([testOrigin, testMailOrigin].filter(Boolean).map((o) => `${o}/*`))];
  m.host_permissions = [...(m.host_permissions ?? []), ...patterns];
  for (const cs of m.content_scripts ?? []) cs.matches = [...cs.matches, ...patterns];
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
      config: { wsUrl: bridge.wsUrl, token: bridgeToken, authuser, testOrigin, testMailOrigin },
      prepareExtension: testOrigin || testMailOrigin ? addTestOrigins : undefined,
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

  // Keep the service worker awake, notice an extension that never attached, and exit for a supervised restart if
  // Chromium dies. A page that stops answering is reloaded on its own (reloadPage), not the whole browser.
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
  timers.push(setInterval(checkProbeRequest, PROBE_POLL_MS));
  timers.push(setInterval(checkLearnRequest, PROBE_POLL_MS));
  timers.push(setInterval(checkSelfCheckRequest, PROBE_POLL_MS));
}

// ---------------------------------------------------------------- lifecycle
function onConnect() {
  link.emit({ t: 'hello', network: 'google', version: '1', capabilities: ['liveView'] });
  status(true);
}

let cleaning: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    for (const t of timers) clearTimeout(t);
    clearTimeout(probeTimer);
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
