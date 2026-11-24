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
 * refuses unread messages if reading one was ever seen to mark it read. `mail.contacts` asks what Gmail's compose To
 * field would suggest (src/gmail/contacts.ts), in a small lane of its own beside the Gmail page's, so keystrokes never
 * wait behind mail and mail never waits behind them. docs/google.md.
 *
 * Config: { authuser?, mail?, gmailPollSeconds?, gmailCanaryHours?, apiBase?, gmailApiBase?, testOrigin?, testMailOrigin?,
 * peopleApiBase?, testFetchMs?, noSandbox? } (peopleApiBase: tests only, and only one of the test origins; testFetchMs:
 * tests only, how long the hook gives a Gmail call before it cuts it off, with a test Gmail origin only).
 *
 * Logs ids and statuses, never cookies, keys, tokens, event contents or mail. Nothing here changes mail.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, diagnoseSilence, displayName, displayNote, type FreeDisplay, pickFreeDisplay, type Reached, Sandbox } from '@dither-accounts/browser';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { Handover, HandoverError } from '@dither-accounts/spec/handover';
import type { OutgoingMail } from '@dither-accounts/interfaces';
import { type ContactsAnswer, GmailContacts } from './gmail/contacts.ts';
import { GmailMail, type PageKind, stateOf, type SyncAnswer, type Transport } from './gmail/mail.ts';
import { DECIMAL_ID } from './gmail/protocol.ts';
import { checkOutgoing, gmailMayHaveSent, gmailSendOnce, MAX_RECIPIENTS, SEND_CAP } from './gmail/send.ts';
import { selfCheck } from './gmail/selfcheck.ts';
import { type CanaryRun, runCanary } from './gmail/canary.ts';
import { OP_MARGIN_MS, opMs, outsideOp, remainingMs, withDeadline } from './deadline.ts';
import { checkLearnScript, describeStep, type LearnStep } from './learn.ts';
import { Readiness } from './ready.ts';
import { ReloadPolicy } from './reload.ts';
import { RESEND_KINDS, resendable } from './resend.ts';

const WIDTH = 1280;
const HEIGHT = 800;
/** Google's own key for embedded public calendars: the last one tried. */
const EMBED_KEY = 'AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXxs';
const SIGN_IN_HOST = 'accounts.google.com';
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const RETRIES = 4;
const BACKOFF = Number(process.env.DITHER_GOOGLE_BACKOFF_MS) || 500;
/** Tests only: the first gap between reloads of a silent page (reload.ts; 0 reloads again at once). */
const RELOAD_GAP = process.env.DITHER_GOOGLE_RELOAD_GAP_MS !== undefined ? Number(process.env.DITHER_GOOGLE_RELOAD_GAP_MS) : undefined;
/** After the page says it is signed in, wait this long for its own requests (and their keys) before probing. */
const PROBE_SETTLE_MS = 1500;
/** The extension should be talking to us this soon after the browser starts. */
const ATTACH_MS = 30_000;
/**
 * A page request's answer comes within this, or the call fails saying which page did not answer. It is cut to what is
 * left of the op's own time (deadline.ts: the interface's timeoutMs for the op, or the manager's 30 s where it names
 * none, less a margin), so the caller hears this account's own sentence before the manager's timeout, even when an op
 * makes several page requests.
 */
const PAGE_ANSWER_MS = 25_000;
/** A request given less than this was cut short by its op's time: its silence is not counted against the page. */
const SILENCE_COUNTS_MS = PAGE_ANSWER_MS / 2;
/** At start, an op waits up to this (within its own time) for the page to be up, signed in and synced before refusing. */
const READY_WAIT_MS = 10_000;
/** Page requests that may take longer than an op has left (a download, an upload): not silence once the page has them. */
const LONG_KINDS = new Set(['gmail.raw', 'gmail.upload']);
/** tab.state, asked before a reload, answers within this. */
const TAB_STATE_MS = 5_000;
/**
 * A request made while its page's tab is being reloaded waits up to this (within its own time) for the new page's
 * hook, rather than going to the old page, which drops it as it unloads ("Failed to fetch"). A page's hook is up a
 * second or two after its load. Past it, requests are sent to the tab as it is: a reload that never brings the hook
 * back still shows up as silence, and leads to the next reload.
 */
const RELOAD_SETTLE_MS = 15_000;
/** This many unanswered requests in a row to one page, and its tab is reloaded. */
const SILENT_LIMIT = 2;
/** The service worker's own commands (open or reload a tab) answer within this. */
const TAB_COMMAND_MS = 10_000;
/** The Gmail API probe: asked for by this file in the account's directory, answered in the other. */
const PROBE_REQUEST = 'probe-gmail.request';
const PROBE_RESULT = 'probe-gmail.json';
const PROBE_POLL_MS = 3000;
/** The probe waits up to this for the Gmail page to say which keys it carries. */
const PROBE_KEYS_MS = 5000;
/** A learn run: asked for by this script in the account's directory; `collect` writes the shapes to the other. */
const LEARN_REQUEST = 'gmail-learn.json';
const LEARN_SHAPES = 'gmail-shapes.json';
/** The Gmail self-check: asked for by this file, answered in the other (counts, booleans and types only). */
const SELFCHECK_REQUEST = 'gmail-selfcheck.request';
const SELFCHECK_RESULT = 'gmail-selfcheck.json';
/** The canary (src/gmail/canary.ts): its last run and the answers' shapes, in the account's directory. */
const CANARY_FILE = 'gmail-canary.json';
/** It runs once the Gmail page has been ready this long after a start, then once a day. */
const CANARY_SETTLE_MS = 2 * 60_000;
/** Where the mail watch got to (Gmail's sync point and when), so a restart announces what came meanwhile. */
const WATCH_FILE = 'gmail-watch.json';
/** What reading Gmail has done that must outlive a restart: bytes downloaded in the last 24 h, and the unread guard. */
const READS_FILE = 'gmail-reads.json';
/** A message download may take this long (up to 50 MB); handed over in pieces of this size. */
const RAW_ANSWER_MS = 90_000;
const RAW_PIECE = 4 * 1024 * 1024;
/** A suggestions call is answered within this (the hook gives Google 6 s), under the op's 10 s. */
const CONTACTS_ANSWER_MS = 8_000;

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
  // Suggesting people (src/gmail/contacts.ts): the To field's autocomplete call.
  | { kind: 'gmail.contacts'; body: unknown[] }
);
/** The hook's own state, asked for (no network) when its page stops answering. */
type PageStateCmd = { kind: 'page.state'; page?: Role };
type PageCmd = Gfetch | GmailCmd | PageStateCmd;
/** What gmail.shapes answers: per method and path template, a count and up to 6 samples of shapes (no values). */
interface ShapeEntry {
  method: string;
  template: string;
  count: number;
  samples: unknown[];
}
/** The service worker's own: open the role's tab if it has none, or send it back to `url` (`fresh`: a new tab). */
interface TabCmd {
  kind: 'tab.open' | 'tab.reload' | 'tab.state';
  page: Role;
  url?: string;
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
  | { t: 'seen'; endpoints: Endpoint[]; keys: { key: string; source: KeySource }[]; role?: Role | null }
  /** The page made its first sync call of its own (its headers known): mail calls can be made. */
  | { t: 'synced'; role?: Role | null };
type Attention = { kind: string; message: string; liveView: boolean };
/** One link of the account's dependency chain (status.layers, as in chat-protocol's StatusLayer). */
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string; interface?: string };
/** A layer only one of the account's interfaces rests on (StatusLayer.interface). */
const only = (iface: 'mail' | 'google.calendar', l: Layer): Layer => ({ ...l, interface: iface });

const link = linkManager({ onConnect, onCommand, onShutdown: () => cleanup() });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);

const cfg = link.config;
const authuser = String(cfg.authuser ?? 0);
const origin = (v: unknown) => (typeof v === 'string' && v ? v.replace(/\/$/, '') : null);
const testOrigin = origin(cfg.testOrigin);
const testMailOrigin = origin(cfg.testMailOrigin);
/** Tests only: where the hook sends suggestion calls (it takes it only when it is one of the test origins). */
const peopleApiBase = origin(cfg.peopleApiBase);
const calendarOrigin = testOrigin ?? 'https://calendar.google.com';
/** In tests, Gmail is wherever testMailOrigin says, and there is none without it: a test never opens the real one. */
const mailOrigin = testMailOrigin ?? (testOrigin ? null : 'https://mail.google.com');
const mailOn = cfg.mail !== false && !!mailOrigin;
/** How often the mail watch asks Gmail what changed (0: never); it starts with the first mail call. */
const pollMs = Math.max(0, Number(cfg.gmailPollSeconds ?? 60) || 0) * 1000;
/** How often the canary runs (0: never); off by default in tests (a test Gmail origin), which turn it on by setting it. */
const canaryMs = Math.max(0, Number(cfg.gmailCanaryHours ?? (testMailOrigin ? 0 : 24)) || 0) * 3600_000;
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
  /**
   * The page as a channel that a reload replaces (packages/spec handover.ts): requests wait while its tab is being
   * reloaded, and those the old page had when it was reloaded run again on the new one (reads and label changes) or
   * fail 'unsure'.
   */
  line: Handover<null>;
  answeredAt: number;
  /** When its hook last said it is up. */
  hookAt: number;
  reloading: boolean;
  reloads: number;
  lastReload: { at: number; how: string | null; error?: string } | null;
  /** When its tab may be reloaded (reload.ts), and the last reason it was not, logged once. */
  reload: ReloadPolicy;
  reloadHeld: string | null;
  openError: string | null;
  /** Its hook said the page made a sync call of its own (Gmail): mail calls can be made. */
  synced: boolean;
}
const upLine = (name: string) => {
  const h = new Handover<null>({ name });
  h.open(null);
  return h;
};
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
  line: upLine(`the ${name} page`),
  answeredAt: 0,
  hookAt: 0,
  reloading: false,
  reloads: 0,
  lastReload: null,
  reload: new ReloadPolicy(RELOAD_GAP),
  reloadHeld: null,
  openError: null,
  synced: false,
});
const pages: Record<Role, Page> = {
  calendar: newPage('calendar', 'Calendar', startUrl, new Lane(8, 0)),
  gmail: newPage('gmail', 'Gmail', mailOn ? mailStartUrl : null, new Lane(4, 100)),
};
/** The Gmail page's suggestion calls (mail.contacts): a lane of their own, so they neither wait for nor slow mail. */
const contactsLane = new Lane(2, 0);
const cal = pages.calendar;
const gm = pages.gmail;
const roleOf = (m: { role?: unknown }): Role => (m.role === 'gmail' ? 'gmail' : 'calendar');

// -------------------------------------------------------------------- state
const statePath = join(link.accountDir, 'state.json');
let kept: Partial<Winner> = readKept();
let display: FreeDisplay | null = null;
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
let canary: { readySince: number | null; last: CanaryRun | null; lastAt: number } = { readySince: null, last: null, lastAt: 0 };
const timers: Timer[] = [];

function readKept(): Partial<Winner> {
  try {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  } catch {
    return {};
  }
}

const bridgeToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
/** Ops waiting for a page to be ready (gmailReady, ready): they look again on every frame. */
const readiness = new Readiness();
const bridge = new BridgeServer<Up, PageCmd | TabCmd>({
  token: bridgeToken,
  onMessage: (m) => {
    onBridge(m);
    readiness.changed();
  },
  onConnect: () => {
    status();
    readiness.changed();
    void openGmailTab();
  },
  onDisconnect: () => {
    for (const p of [cal, gm]) {
      p.hooked = 0;
      p.session = null;
      p.synced = false;
    }
    status();
    readiness.changed();
  },
  // A read or label change its page has not said it has after 3 s is sent again (the page takes an id once): a command
  // lost on the way costs seconds, not PAGE_ANSWER_MS. Never a send or anything else others see (RESEND_KINDS).
  resend: { kinds: RESEND_KINDS, when: (c) => resendable(c as { kind: string; method?: unknown; body?: unknown }) },
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
    display: liveView ? displayName(display) : null,
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
    // Suggesting people as Gmail's To field does (mail.contacts): now, or why not.
    contacts: contactsNote() === null,
    contactsNote: contactsNote(),
    gmailWatch: !mailOn ? null : !pollMs ? 'off' : !watchOn ? 'starts with the first mail call' : watchInfo.error ? `failed at ${hhmm(watchInfo.at)}: ${watchInfo.error}` : watchInfo.at ? `looked at ${hhmm(watchInfo.at)}` : 'starting',
    gmailSelfCheckAt: gmailSelfCheck ? new Date(gmailSelfCheck.at).toISOString() : null,
    gmailSelfCheck: gmailSelfCheck?.summary ?? null,
    gmailCanaryAt: canary.last?.at ?? null,
    gmailCanary: canary.last?.summary ?? null,
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

/** Why mail.contacts cannot answer now (the page, or the call itself failing of late), in a sentence; null when it can. */
function contactsNote(): string | null {
  return contactsUnavailable() ?? contacts?.troubled() ?? null;
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
 * already say; the first layer not ok is where it stops. Then the Gmail page, which Calendar does not rest on. The key
 * and the Calendar API are Calendar's alone, and the Gmail layers mail's (`interface`), so an app reading mail is not
 * told it stops at Calendar.
 */
function layers(): Layer[] {
  const s = current();
  const t = tab();
  // A sandbox that did not start: Chromium's own failures are the browser's, the rest (no free display, Xvfb) the display's.
  const browserFailed = !!sandboxError && /chromium/i.test(sandboxError);
  const screen: Layer = liveView
    ? { name: 'display', state: 'ok', note: `${displayNote(display)}, live view ready` }
    : sandboxError && !browserFailed
      ? { name: 'display', state: 'failed', note: sandboxError }
      : browserFailed
        ? { name: 'display', state: 'off', note: 'not started' }
        : { name: 'display', state: 'waiting', note: 'starting the display' };
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
  const c = canary.last;
  const canaryLayer: Layer = !gmail || !canaryMs ? { name: 'Gmail canary', state: 'off', note: canaryMs ? 'no Gmail tab' : 'gmailCanaryHours is 0' } : !c ? { name: 'Gmail canary', state: 'waiting', note: 'not run yet' } : canaryTrouble() ? { name: 'Gmail canary', state: 'failed', note: `Gmail changed how it answers (${c.changes.length ? c.changes.map((x) => x.endpoint).join(', ') : c.problems[0]}); mail reads what it still can, and ${CANARY_FILE} in the account's directory says where` } : { name: 'Gmail canary', state: 'ok', note: c.summary };
  const background: Layer = gmail ? gmail.backgroundLayer() : { name: 'Gmail background', state: 'off', note: 'no Gmail tab' };
  return [screen, browser, extension, signedIn, only('google.calendar', key), only('google.calendar', calendar), only('mail', gmailLayer()), only('mail', protocol), only('mail', background), only('mail', canaryLayer)];
}

let lastSent = '';
function status(force = false) {
  const st = state();
  const email = current()?.email;
  const g = gm.hooked ? gm.session : null;
  const name = g?.email && g.email === email ? (g.name ?? null) : null;
  // `changed`: the canary saw Gmail's answers change or fail (src/gmail/canary.ts), until a run is clean again. The
  // manager announces it (a `changed` notice) without the account needing you: Calendar stays as it is.
  const ev = { t: 'status', status: st.status, attention: st.attention, changed: canaryTrouble(), liveView, ...(email ? { self: { email, ...(mailOn ? { addresses: [{ email, name }] } : {}) } } : {}), details: details(), layers: layers() };
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
      // A page coming up (or its pipe again): it says `synced` again right after, if it has.
      pages[roleOf(msg)].synced = false;
      pages[roleOf(msg)].hookAt = Date.now();
      log('debug', `${roleOf(msg)} page hook up`, { page: msg.page });
      settled(pages[roleOf(msg)]);
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
    case 'synced':
      if (!pages[roleOf(msg)].synced) log('info', `${roleOf(msg)} page: made its first sync call`);
      pages[roleOf(msg)].synced = true;
      break;
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
 * and the browser, are left as they are; a dead Chromium is another matter (boot: a supervised restart). Not while
 * the tab is still loading, and backing off while reloads bring no answer (reload.ts).
 */
const deciding = new Set<Role>();
async function reloadPage(p: Page) {
  if (p.reloading || deciding.has(p.role) || !p.startUrl || cleaning) return;
  deciding.add(p.role);
  let d;
  try {
    d = p.reload.decide(Date.now(), await tabLoading(p));
  } finally {
    deciding.delete(p.role);
  }
  if (!d.go) {
    if (d.why !== p.reloadHeld) log('info', `the ${p.name} page did not answer ${p.silent} requests in a row; not reloading its tab yet: ${d.why}`);
    p.reloadHeld = d.why;
    return;
  }
  if (p.reloading || cleaning) return;
  p.reloadHeld = null;
  p.reload.reloaded(Date.now());
  const fresh = !!p.lastReload && p.answeredAt < p.lastReload.at;
  const n = p.silent;
  p.reloading = true;
  p.generation++;
  p.silent = 0;
  p.reloads++;
  p.lastReload = { at: Date.now(), how: null };
  // 2026-11-18: calls made between a reload's order and the old page unloading reached the old page, whose fetch the
  // unload cut ("Failed to fetch", a 503). Requests now wait for the new page; past RELOAD_SETTLE_MS they go to the
  // tab as it is. What the old page has is lost with it: reads run again on the new page, the rest fail 'unsure'.
  p.line.opening('its tab is being reloaded', { ms: RELOAD_SETTLE_MS, late: () => p.line.open(null) });
  p.line.cut('its tab was reloaded');
  if (p.role === 'calendar') recheck = true;
  // A reloaded Gmail page may answer what it did not: no request stays held for failing alike before (mail.ts REPEAT).
  if (p.role === 'gmail') gmail?.clearHolds();
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
    settled(p);
    status();
    readiness.changed();
  }
}

/** The page's hook is up again since its reload (or the reload failed, and the tab is as it was): requests go to it. */
function settled(p: Page) {
  if (p.reloading || p.line.state !== 'opening') return;
  const r = p.lastReload;
  if (!r || r.error || p.hookAt > r.at) p.line.open(null);
}

/** Whether the page's tab is loading as Chromium sees it (the worker's tab.state), or null when it did not say. */
async function tabLoading(p: Page): Promise<boolean | null> {
  if (!bridge.connected) return null;
  try {
    const r = await bridge.request<{ status?: unknown }>({ kind: 'tab.state', page: p.role, tabId: p.tabId }, TAB_STATE_MS, { diagnose: false });
    return r?.status === 'loading' ? true : r?.status === 'complete' ? false : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- calls
/**
 * A request to one page, through its own lane. It is answered within `answerMs` (PAGE_ANSWER_MS by default), and
 * never later than its op's own time allows (deadline.ts), or fails saying which page did not answer. A wait for a
 * free place in the page's lane that runs out says so instead (503 'unavailable': nothing was sent). Two unanswered in
 * a row ask for that page's tab to be reloaded.
 */
async function pageRequest<T>(role: Role, cmd: PageCmd, answerMs = PAGE_ANSWER_MS, lane = pages[role].lane): Promise<T> {
  const p = pages[role];
  if (!bridge.connected) throw new StatusError('the sandbox browser is not attached', 503, 'unavailable', { kind: 'transient' });
  const ms = Math.min(answerMs, remainingMs(answerMs));
  const silence = () => new StatusError(`the ${p.name} page did not answer in ${Math.max(1, Math.round(ms / 1000))} s`, 503);
  if (ms <= 0) throw new StatusError(`the ${p.name} page did not answer within this call's time (none of it was left for this request)`, 503);
  const deadline = Date.now() + ms;
  if (!(await lane.take(deadline))) throw new StatusError(`the ${p.name} page is busy: ${lane.max} of its requests ahead of this one did not finish within ${Math.max(1, Math.round(ms / 1000))} s, so this one was not sent`, 503, 'unavailable');
  try {
    // The page's tab may be being reloaded: then the request waits for the new page (Page.line).
    return await p.line.run(() => toPage<T>(p, role, cmd, deadline, silence), { deadline, repeatable: resendable(cmd) });
  } catch (e) {
    if (!(e instanceof HandoverError)) throw e;
    if (e.code === 'retry') throw new StatusError(`the ${p.name} page is being reloaded, and the new page was not up within this request's time, so it was not sent`, 503, 'retry');
    throw new StatusError(`the ${p.name} page was reloaded while it had this request: it may or may not have happened, and it was not sent again`, 504, 'unsure');
  } finally {
    lane.give();
  }
}

/** One request to the page as it is now, answered within `deadline`; its silence counts against the page. */
async function toPage<T>(p: Page, role: Role, cmd: PageCmd, deadline: number, silence: () => StatusError): Promise<T> {
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
    // One cut short (by its wait in the lane, or its op's time) is not the page's silence; one sent to a page since
    // reloaded is the old page's; nor a download or upload the page said it has: it is working on it (the hook cuts
    // Gmail off at 80 s, which may be past what the op had left, as mail.get's 60 s).
    const given = deadline - sentAt;
    const reached = (e as { reached?: Reached }).reached ?? 'none';
    const working = reached === 'page' && LONG_KINDS.has(cmd.kind);
    if (generation === p.generation && given >= SILENCE_COUNTS_MS && !working) unanswered(p, cmd, reached, given);
    throw silence();
  }
}

/** An answer (or a refusal, which is the page or the worker answering too): the silence is over. */
function answered(p: Page, fromPage = true) {
  const was = p.silent;
  p.silent = 0;
  if (fromPage) {
    p.answeredAt = Date.now();
    p.reload.answered();
    p.reloadHeld = null;
  }
  if (was) status();
}

function unanswered(p: Page, cmd: PageCmd, reached: Reached, given: number) {
  p.silent++;
  log('warn', `the ${p.name} page did not answer in ${Math.round(given / 1000)} s (${p.silent} in a row)`);
  status();
  // What the page and its tab were doing, logged before a reload changes it.
  void diagnose(p, cmd, reached).finally(() => {
    if (p.silent >= SILENT_LIMIT) void reloadPage(p);
  });
}

/**
 * One line on a page that did not answer (packages/browser's silence.ts): how far the request got (the page's port,
 * the page itself), what Chromium says of the tab, and what the hook says when asked without the network (its
 * visibility, lifecycle events, counts of uncaught errors, the commands it still has open). Names of steps, paths and
 * counts only, nothing from the page.
 */
function diagnose(p: Page, cmd: PageCmd, reached: Reached) {
  return diagnoseSilence(bridge, {
    name: p.name,
    request: cmd.kind,
    reached,
    log,
    tab: { kind: 'tab.state', page: p.role, tabId: p.tabId },
    page: { kind: 'page.state', page: p.role },
    lastAnswerAt: p.answeredAt || null,
    extra: { hookUpAgoS: p.hookAt ? Math.round((Date.now() - p.hookAt) / 1000) : null },
  });
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
  // Shared by every call that comes meanwhile, and outliving the first: not under its time.
  probing ??= outsideOp(() => doProbe()).finally(() => {
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
  // A page that has just come up (a reload) says which keys it carries a moment after it says it is signed in: wait
  // for that, briefly, rather than try without them.
  if (gm.hooked && gm.session?.signedIn) await readiness.until(() => (gm.keys.length ? null : 'no keys yet'), PROBE_KEYS_MS);
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
  if (err instanceof StatusError && err.callCode === 'unavailable') return err;
  if (/not attached/.test(msg)) return err instanceof StatusError ? err : new StatusError(msg, 503, 'unavailable');
  if (/did not answer/.test(msg)) return new StatusError(`${msg}; the change may have been made`, 504);
  return new StatusError(`the Gmail page would not make it (${msg.slice(0, 160)})`, 500);
}

/** The Gmail tab, as GmailMail needs it: every call through the hook in that page (docs/google.md, "Gmail mail"). */
/** The hook's second try at a download that failed before any answer (RawNetwork.then), if it said one. */
function rawThen(v: unknown): { then?: 'redirect' | 'network' | 'timeout' | number } {
  if (v === 'redirect' || v === 'network' || v === 'timeout') return { then: v };
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000) return { then: v };
  return {};
}
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
    const r = await pageRequest<{ status?: number; token?: string; size?: number; tooBig?: number; type?: string | null; error?: string; page?: unknown; stage?: unknown; ms?: unknown; got?: unknown; online?: unknown; then?: unknown }>('gmail', { kind: 'gmail.raw', hex, max }, RAW_ANSWER_MS);
    const status = typeof r?.status === 'number' ? r.status : 0;
    if (r?.error === 'network') return { status: 0, error: 'network', net: { stage: r.stage === 'body' ? 'body' : 'headers', ms: Number(r.ms) || 0, got: Number(r.got) || 0, online: typeof r.online === 'boolean' ? r.online : null, ...rawThen(r.then) } };
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
    let r: SyncAnswer;
    try {
      r = await pageRequest<SyncAnswer>('gmail', { kind: 'gmail.write', body });
    } catch (e) {
      throw writeError(e);
    }
    // The hook cut Gmail off (it gives a call 20 s): the change may have been made all the same.
    if (r?.status === 0 && r.error === 'timeout') throw new StatusError("Gmail did not answer the page's change in time; the change may have been made", 504);
    return { ...r, page: pageKindOf(r?.page) };
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

/**
 * Why the Gmail page cannot suggest people now (then mail.contacts is 503 'unavailable' and details.contacts false),
 * or null: the browser not attached, the page not open or not on Gmail (a sign-in or challenge page), signed out,
 * being reloaded or failed to reload, or Google's verification seen on mail calls (the background lane's stop).
 */
function contactsUnavailable(): string | null {
  if (!mailOn) return 'this account reads no mail';
  if (!bridge.connected) return 'the sandbox browser is not attached yet';
  const s = gm.hooked ? gm.session : null;
  if (hostOf(gm.url) === SIGN_IN_HOST || (s && !s.signedIn)) return 'Google is not signed in; sign in in the live view';
  if (!s || !onMail(gm.url)) return 'Gmail is not open in the sandbox';
  if (gm.reloading) return 'the Gmail page is being reloaded';
  const bad = trouble(gm);
  if (bad?.failed) return bad.note;
  if (gmail?.background().stopped === 'challenge') return 'Google showed the Gmail page a verification page; open the live view';
  return null;
}

/** The To field's suggestion call, through the hook, in the suggestions' own lane; what went wrong as the op says it. */
async function contactsTransport(body: unknown[]): Promise<ContactsAnswer> {
  let r: { status?: unknown; json?: unknown; error?: unknown; page?: unknown; code?: unknown };
  try {
    r = await pageRequest('gmail', { kind: 'gmail.contacts', body }, CONTACTS_ANSWER_MS, contactsLane);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/did not answer/.test(msg)) throw new StatusError(msg, 504);
    // The hook refusing the body, or not knowing the command (an older extension): ours, and trying again will not help.
    if (/^gmail\.contacts: refused|^no command/.test(msg)) throw new StatusError(`the Gmail page would not make it (${msg.slice(0, 160)})`, 500);
    throw new StatusError(msg, 503, 'unavailable');
  }
  return {
    status: typeof r?.status === 'number' ? r.status : 0,
    ...(r?.json !== undefined ? { json: r.json } : {}),
    ...(typeof r?.error === 'string' ? { error: r.error } : {}),
    page: pageKindOf(r?.page),
    code: typeof r?.code === 'number' ? r.code : null,
  };
}
const contacts = mailOn ? new GmailContacts(contactsTransport, { log, ready: contactsUnavailable, onChange: () => status() }) : null;

/** Why the Gmail tab cannot take a mail call now, or null: not attached, not open, signed out, not synced yet. */
function gmailNotReady(): StatusError | null {
  if (!gmail) return new StatusError(cfg.mail === false ? 'this account reads no mail (mail: false in its config)' : 'this account has no Gmail tab', 501);
  if (!bridge.connected) return new StatusError('the sandbox browser is not attached yet', 503, 'unavailable', { kind: 'transient' });
  const s = gm.hooked ? gm.session : null;
  if (!s) return new StatusError('Gmail is not open in the sandbox yet', 503, 'unavailable', { kind: 'transient' });
  if (!s.signedIn) return new StatusError('Google is not signed in; sign in in the live view', 401, undefined, { kind: 'expected' });
  if (!gm.synced) return new StatusError('the Gmail page has not made a sync call of its own yet, so the headers it sends are not known; try again in a moment', 503, 'unavailable', { kind: 'transient' });
  return null;
}
/** Only a 503 passes by waiting (a page still coming up); 401 and 501 do not. */
const passes = (e: StatusError) => e.status === 503;

/**
 * The Gmail tab up, signed in and synced, waited for up to READY_WAIT_MS (within the op's own time): at start, an op
 * that comes before the page made its first sync call waits for it rather than failing. Then the reason it is not,
 * 503 'unavailable' while it is still coming up.
 */
async function gmailReady(): Promise<GmailMail> {
  const no = await readiness.until(gmailNotReady, Math.min(READY_WAIT_MS, remainingMs(READY_WAIT_MS)), (e) => !passes(e));
  if (no) throw no;
  return gmail!;
}

/** The same, without waiting, and without the sync: the self-check (which reports what it finds). */
function gmailReadyNow(): GmailMail {
  const no = gmailNotReady();
  if (no && !(no.callCode === 'unavailable' && gm.hooked && !gm.synced && bridge.connected)) throw no;
  return gmail!;
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

async function mailOp<T>(f: (g: GmailMail) => Promise<T>, background?: unknown, op?: string): Promise<T> {
  if (background === true && gmail) {
    const s = gm.hooked ? gm.session : null;
    if (s && !s.signedIn) gmail.notePage(false);
    gmail.admit(true);
  }
  // A background call's time counts from when it came, its wait for the page included.
  const end = Date.now() + (op ? opMs(op) : 0) - BACKGROUND_MARGIN_MS;
  const g = await gmailReady();
  startWatch();
  if (background !== true || !op) return f(g);
  const within = Math.max(0, end - Date.now());
  let timer: Timer | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StatusError(`Gmail background reading could not finish this call within ${Math.round((opMs(op) - BACKGROUND_MARGIN_MS) / 1000)} s; try again later`, 503, 'backoff')), within);
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
  // Started by the first mail op, it outlives it: not under that op's time.
  outsideOp(() => {
    timers.push(setInterval(() => void pollMail(), pollMs));
    void pollMail();
  });
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
      if (r.mailboxes.length || r.arrived.length) log('info', `gmail watch: ${r.mailboxes.length} mailbox${r.mailboxes.length === 1 ? '' : 'es'} changed, ${r.arrived.length} arrived${r.skipped.length ? `, ${r.skipped.length} left out (mail.changes names them)` : ''}`);
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
    g = gmailReadyNow();
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

/** The canary's last run found a layout refused, records left out, or the answers' shapes changed. */
function canaryTrouble(): boolean {
  const c = canary.last;
  return !!c && (c.problems.length > 0 || c.changes.length > 0);
}

/**
 * The canary (src/gmail/canary.ts): once the Gmail page has been ready CANARY_SETTLE_MS after a start, then every
 * gmailCanaryHours, the self-check without reading a message, its answers' shapes compared with the last run's. Waits
 * as the watch does (a reload, silence, a learn run, the probe, the self-check). Looks without waiting (it runs on a
 * timer): ready, synced included, or not this time.
 */
function checkCanary() {
  if (!gmail || !canaryMs || selfChecking || learning || gmailProbing || cleaning) return;
  if (gmailNotReady()) {
    canary.readySince = null;
    return;
  }
  const g = gmail;
  if (gm.reloading || gm.silent > 0 || trouble(gm)) return;
  const now = Date.now();
  canary.readySince ??= now;
  if (now - canary.readySince < CANARY_SETTLE_MS || (canary.lastAt && now - canary.lastAt < canaryMs)) return;
  selfChecking = true;
  canary.lastAt = now;
  void runCanary(g, () => gmailTransport.info(), join(link.accountDir, CANARY_FILE))
    .then((r) => {
      canary.last = r;
      // Not through for a passing reason (the page busy, a 5xx): again in an hour rather than a day.
      if (!r.ok && !r.problems.length) canary.lastAt = now - canaryMs + Math.min(canaryMs, 3600_000);
      log(r.ok && !r.changes.length ? 'info' : 'warn', `gmail canary: ${r.summary}${r.problems.length ? `; ${r.problems.join('; ')}` : ''}`);
    })
    .catch((e) => log('warn', 'gmail canary failed', String((e as Error).message ?? e).slice(0, 200)))
    .finally(() => {
      selfChecking = false;
      status();
    });
}

// ---------------------------------------------------------------- calendar
/** Why the Calendar page cannot take a call now, or null. */
function calendarNotReady(): StatusError | null {
  if (!bridge.connected) return new StatusError('the sandbox browser is not attached yet', 503, 'unavailable', { kind: 'transient' });
  const s = current();
  if (!s) return new StatusError('Google Calendar is not open in the sandbox', 503, 'unavailable', { kind: 'transient' });
  if (!s.signedIn) return new StatusError('Google is not signed in; sign in in the live view', 401, undefined, { kind: 'expected' });
  return null;
}

/** The Calendar page up and signed in (waited for at start, as gmailReady), and a key that works. */
async function ready(): Promise<Winner> {
  const no = await readiness.until(calendarNotReady, Math.min(READY_WAIT_MS, remainingMs(READY_WAIT_MS)), (e) => !passes(e));
  if (no) throw no;
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

/** Each op under its own time (deadline.ts): every page request it makes is cut to what is left of it. */
function onCommand(cmd: Command): Promise<unknown> {
  return withDeadline(opMs(cmd.t) - OP_MARGIN_MS, () => runOp(cmd));
}

async function runOp(cmd: Command): Promise<unknown> {
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
      const send = () =>
        mailOp((g) => {
          const s = gm.hooked ? gm.session : null;
          if (!s?.email) throw new StatusError("Gmail has not shown which address it is signed in as yet; try again in a moment", 503, 'unavailable');
          return g.send(m, { email: s.email, name: s.name ?? null });
        });
      return gmailSendOnce(link.accountDir).run(cmd.idempotencyKey, send, { unknown: gmailMayHaveSent });
    }
    case 'mail.contacts':
      // Not through mailOp: no watch started, no queue behind mail or background reading (src/gmail/contacts.ts).
      if (!contacts) throw new StatusError(cfg.mail === false ? 'this account reads no mail (mail: false in its config)' : 'this account has no Gmail tab', 501);
      return contacts.suggest({ query: cmd.query, limit: cmd.limit });
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
      accountDir: link.accountDir,
      display: free,
      width: WIDTH,
      height: HEIGHT,
      extensionSrc: join(import.meta.dir, 'extension'),
      config: { wsUrl: bridge.wsUrl, token: bridgeToken, authuser, testOrigin, testMailOrigin, peopleApiBase, fetchMs: testMailOrigin ? Number(cfg.testFetchMs) || null : null },
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
      log('warn', `sandbox on ${displayName(free)} failed`, sandboxError);
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
  timers.push(setInterval(checkCanary, PROBE_POLL_MS));
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
