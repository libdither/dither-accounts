/**
 * The claude extractor (docs/claude.md): claude.ai in a sandboxed browser (statements-common/tabs.ts: Xvfb, an
 * ordinary Chromium with the account's profile and an extension, x11vnc for the live view; no CDP, no automation),
 * driven one step at a time by the manager's `cliproxy` provider through the `claude` interface:
 *
 *   claude.signin.start   type the account's email into claude.ai's sign-in form, so it emails a sign-in link
 *   claude.signin.finish  open that link (the provider read it from the account's mailbox) and wait to be signed in
 *   claude.authorize      open CLIProxyAPI's OAuth authorize URL, press Authorize, and hand back the localhost
 *                         callback URL claude.ai redirects to (nothing listens there; the provider posts it to the hub)
 *
 * Everything happens in the tab you see in the live view. A check only you can answer (Cloudflare's) stops the step
 * with `needs-you` and holds the account in attention until the live view shows it gone. Config: { email, testOrigin?,
 * noSandbox? }. Logs steps and page paths: never the link, a URL's query, the callback or a cookie.
 */
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { BrowserHost, sleep } from '@dither-accounts/statements-common/tabs';
import { join } from 'node:path';
import { authorizeTarget, isCallback, magicLinkOk, NEEDS_YOU, sameEmail, signedInLayer, state as statusOf } from './flow.ts';

interface Probe {
  path: string;
  title: string;
  challenge: boolean;
  emailField: boolean;
  checkEmail: boolean;
  authorize: boolean;
  buttons: string[];
}
interface Who {
  signedIn: boolean | null;
  email: string | null;
  tiers: string[];
  status: number;
}

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'claude', version: '1', interfaces: ['claude'], startedAt: STARTED, capabilities: ['liveView'] });
    status(true);
  },
  onCommand,
  onShutdown: () => void host.stop(),
});
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);
const cfg = link.config;
const STARTED = Date.now();
const testOrigin: string | null = typeof cfg.testOrigin === 'string' && cfg.testOrigin ? cfg.testOrigin.replace(/\/$/, '') : null;
const BASE = testOrigin ?? 'https://claude.ai';
const expectedEmail: string | null = typeof cfg.email === 'string' && cfg.email.trim() ? cfg.email.trim() : null;

let signedIn: boolean | null = null;
let email: string | null = null;
let tiers: string[] = [];
let hold: { message: string; since: number } | null = null;
let page: string | null = null;
let busy: string | null = null;
let lookTimer: Timer | undefined;

const host = new BrowserHost({
  link,
  extensionSrc: join(import.meta.dir, 'extension'),
  startUrl: `${BASE}/`,
  testOrigin,
  onTabs: () => {
    page = host.activeTab?.url || null;
    clearTimeout(lookTimer);
    lookTimer = setTimeout(() => void look(), 2500);
  },
  onChange: () => status(),
});

const onClaude = (url: string | null) => {
  try {
    return !!url && new URL(url).origin === BASE;
  } catch {
    return false;
  }
};

/** The tab the steps work in: the one you see in the live view (a new one if there is none). */
async function workTab(): Promise<number> {
  const a = host.activeTab;
  if (a) return a.id;
  return (await host.open(`${BASE}/`, { active: true })).tabId;
}

const probe = (tab: number) => host.exec<Probe>(tab, 'probe', [], 'ISOLATED', 15_000).catch(() => null);
const who = (tab: number) => host.exec<Who>(tab, 'whoami', [], 'ISOLATED', 20_000).catch(() => null);

function learn(w: Who | null) {
  if (!w || w.signedIn === null) return;
  signedIn = w.signedIn;
  email = w.signedIn ? w.email : null;
  tiers = w.signedIn ? w.tiers : [];
}

/** Look at the tab you see: who is signed in, and is a held step's check gone? */
async function look() {
  const a = host.activeTab;
  if (!host.attached || !a || !onClaude(a.url) || a.loading || busy) return;
  const p = await probe(a.id);
  if (p && hold && !p.challenge) {
    log('info', 'the live view shows claude.ai past the check; steps go on');
    hold = null;
  }
  if (p && !p.challenge) learn(await who(a.id));
  status();
}

function needsYou(): never {
  hold = { message: NEEDS_YOU, since: Date.now() };
  status();
  throw new StatusError(NEEDS_YOU, 409, 'needs-you');
}

/** One step at a time, so look() and two calls never press buttons in the same tab at once. */
async function step<T>(name: string, f: () => Promise<T>): Promise<T> {
  if (!host.attached) throw new StatusError('the sandbox browser is not up yet', 503, 'starting');
  if (busy) throw new StatusError(`busy: ${busy}`, 409, 'busy');
  busy = name;
  status();
  try {
    return await f();
  } finally {
    busy = null;
    status();
  }
}

/** Wait until `done` says yes (or a check shows), looking every `every` ms. */
async function until<T>(tab: number, ms: number, every: number, done: (p: Probe | null) => Promise<T | null>): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = onClaude((await host.get(tab).catch(() => null))?.url ?? null) ? await probe(tab) : null;
    if (p?.challenge) needsYou();
    const r = await done(p);
    if (r !== null) return r;
    await sleep(every);
  }
  return null;
}

async function survey(tab: number) {
  return host.exec<unknown>(tab, 'survey', [], 'ISOLATED', 15_000).catch(() => null);
}

async function signinStart() {
  if (!expectedEmail) throw new StatusError('this account has no email in its config', 400, 'no-email');
  return step('signing in', async () => {
    const tab = await workTab();
    await host.activate(tab).catch(() => {});
    await host.go(tab, `${BASE}/login`, 60_000);
    const w = await who(tab);
    learn(w);
    if (w?.signedIn) {
      if (!sameEmail(w.email, expectedEmail)) throw new StatusError(`claude.ai is signed in as another account (${w.email}); sign out in the live view`, 409, 'wrong-account');
      log('info', 'signin.start: signed in already');
      return { already: true, email: w.email, requestedAt: null };
    }
    const form = await until(tab, 30_000, 1000, async (p) => (p?.emailField ? p : null));
    if (!form) throw new StatusError(`claude.ai's sign-in page has no email field (${JSON.stringify(await survey(tab))})`, 409, 'no-form');
    const r = await host.exec<{ ok: boolean; why?: string }>(tab, 'enterEmail', [expectedEmail], 'ISOLATED', 15_000);
    if (!r?.ok) throw new StatusError(`could not send the email form: ${r?.why ?? 'no answer'}`, 409, 'no-form');
    const requestedAt = Date.now();
    const sent = await until(tab, 30_000, 1000, async (p) => (p && (p.checkEmail || (!p.emailField && p.path !== '/login')) ? p : null));
    if (!sent) throw new StatusError(`claude.ai did not say it sent the link (${JSON.stringify(await survey(tab))})`, 409, 'no-form');
    log('info', `signin.start: link requested (page ${sent.path})`);
    return { already: false, email: null, requestedAt };
  });
}

async function signinFinish(raw: unknown) {
  const l = typeof raw === 'string' ? raw.trim() : '';
  if (!magicLinkOk(l, BASE)) throw new StatusError(`not a ${BASE}/magic-link#… link`, 400, 'bad-link');
  return step('opening the sign-in link', async () => {
    const tab = await workTab();
    await host.activate(tab).catch(() => {});
    await host.go(tab, l, 60_000);
    let pressed = false;
    const w = await until(tab, 45_000, 1500, async (p) => {
      const x = await who(tab);
      if (x?.signedIn) return x;
      // A "continue" on the link's page, pressed once (not a check: those stop the step above).
      if (!pressed && p?.path === '/magic-link' && p.buttons.some((b) => /^(continue|sign in|log in|verify)/i.test(b))) {
        pressed = true;
        await host.exec(tab, 'press', ['^(continue|sign in|log in|verify)'], 'ISOLATED', 10_000).catch(() => null);
      }
      return null;
    });
    if (!w) throw new StatusError(`the sign-in link did not sign claude.ai in (${JSON.stringify(await survey(tab))})`, 409, 'no-form');
    learn(w);
    if (!sameEmail(w.email, expectedEmail)) throw new StatusError(`claude.ai signed in as another account (${w.email})`, 409, 'wrong-account');
    log('info', 'signin.finish: signed in');
    return { email: w.email };
  });
}

async function authorize(raw: unknown) {
  const u = typeof raw === 'string' ? raw.trim() : '';
  const t = authorizeTarget(u, BASE);
  if ('why' in t) throw new StatusError(`not an authorize URL to take: ${t.why}`, 400, 'bad-url');
  return step('approving a sign-in', async () => {
    const tab = await workTab();
    await host.activate(tab).catch(() => {});
    if (!onClaude((await host.get(tab)).url)) await host.go(tab, `${BASE}/`, 60_000);
    const w = await who(tab);
    learn(w);
    if (!w?.signedIn) throw new StatusError('claude.ai is not signed in here; sign in first (claude.signin.start)', 409, 'signed-out');
    if (!sameEmail(w.email, expectedEmail)) throw new StatusError(`claude.ai is signed in as another account (${w.email})`, 409, 'wrong-account');
    await host.go(tab, u, 60_000).catch(() => null);
    let pressed = 0;
    const cb = await until(tab, 60_000, 700, async (p) => {
      const now = (await host.get(tab).catch(() => null))?.url ?? '';
      if (isCallback(now, t.redirect)) return now;
      if (p?.path === '/login') throw new StatusError('claude.ai asked to sign in again', 409, 'signed-out');
      if (p?.authorize && pressed < 2) {
        pressed++;
        await host.exec(tab, 'press', ['^(authorize|allow|approve)$'], 'ISOLATED', 10_000).catch(() => null);
      }
      return null;
    });
    if (!cb) throw new StatusError(`claude.ai did not redirect back (${JSON.stringify(await survey(tab))})`, 409, 'no-form');
    log('info', `authorize: approved${pressed ? '' : ' (no consent page shown)'}`);
    // Back to claude.ai, off the error page the callback left (nothing listens there).
    void host.go(tab, `${BASE}/`, 60_000).catch(() => {});
    return { callbackUrl: cb };
  });
}

async function session() {
  const a = host.activeTab;
  if (host.attached && a && onClaude(a.url) && !busy) learn(await who(a.id));
  return { signedIn, email, expectedEmail, page, tiers };
}

// ------------------------------------------------------------------- status
let lastSent = '';
function status(force = false) {
  const v = { signedIn, email, expectedEmail, hold };
  const s = host.baseState() ?? statusOf(v);
  const details = {
    display: host.liveView ? `:${host.display}` : null,
    page,
    extensionAttached: host.attached,
    signedIn,
    email,
    expectedEmail,
    tiers,
    busy,
    held: hold ? `since ${new Date(hold.since).toISOString()}` : null,
  };
  const layers = [...host.layers(), signedInLayer(v)];
  const ev = { t: 'status', status: s.status, attention: s.attention, liveView: host.liveView, details, layers };
  const j = JSON.stringify(ev);
  if (j === lastSent && !force) return;
  lastSent = j;
  link.emit(ev);
}

async function onCommand(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'claude.session':
      return session();
    case 'claude.survey': {
      const a = host.activeTab;
      if (!host.attached || !a) throw new StatusError('the sandbox browser is not up yet', 503, 'starting');
      return survey(a.id);
    }
    case 'claude.signin.start':
      return signinStart();
    case 'claude.signin.finish':
      return signinFinish(cmd.link);
    case 'claude.authorize':
      return authorize(cmd.url);
  }
  throw new StatusError(`claude has no operation "${cmd.t}"`, 400);
}

host.start().then(
  (ok) => {
    if (ok) setInterval(() => void look(), 5 * 60_000);
  },
  (e) => {
    log('error', 'boot failed', String((e as Error)?.message ?? e));
    void host.stop().then(() => process.exit(1));
  },
);
