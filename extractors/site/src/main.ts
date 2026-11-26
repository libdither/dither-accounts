/**
 * The general site kind (docs/site.md): one website, by its address, in a sandboxed browser (statements-common/tabs.ts:
 * Xvfb, an ordinary Chromium with the account's profile and an extension, x11vnc for the live view; no CDP, no
 * automation). It knows nothing of the site: you sign in in the live view, or with an account you already have here
 * when the site's "Continue with Google" sends a tab to Google (packages/browser SignInAsker, docs/signin-relay.md),
 * and an app you approve reads and clicks in it through the `browser` interface (statements-common/browser-ops.ts).
 *
 * The extension may reach the site's host and its subdomains (`https://*.<host>/*`), and nothing else: a page that
 * leaves the site can't be read, and the browser interface opens nothing outside it.
 *
 * Config: { url (https), testOrigin?, testSignInOrigins?, noSandbox? } (testOrigin: tests only, an http loopback site).
 * Logs the site's host and what happened: never a page's address past its path, its text, or what was typed.
 */
import { join } from 'node:path';
import { SignInAsker, signInConfig } from '@dither-accounts/browser';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { BrowserOps } from '@dither-accounts/statements-common/browser-ops';
import { BrowserHost } from '@dither-accounts/statements-common/tabs';

const STARTED = Date.now();
const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'site', version: '1', interfaces: ['browser'], startedAt: STARTED, capabilities: ['liveView'] });
    status(true);
  },
  onCommand,
  onShutdown: () => {
    browserOps.stop();
    void host.stop();
  },
});
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => link.log(level, msg, data);
const cfg = link.config;

const originOf = (v: unknown): string | null => {
  try {
    return new URL(String(v ?? '')).origin;
  } catch {
    return null;
  }
};
const testOrigin = originOf(cfg.testOrigin);
/** The page it opens: an https address, or (tests) one on the test origin. */
const start: string | null = (() => {
  try {
    const u = new URL(String(cfg.url ?? ''));
    return u.protocol === 'https:' || (!!testOrigin && u.origin === testOrigin) ? u.toString() : null;
  } catch {
    return null;
  }
})();
const site = start ? new URL(start) : null;

/** What the extension may reach: the site's host (without www) and its subdomains; the test origin as it is. */
export function sitePatterns(u: URL): string[] {
  if (u.protocol !== 'https:') return [`${u.origin}/*`];
  const host = u.hostname.replace(/^www\./, '');
  return [`https://${host}/*`, `https://*.${host}/*`];
}

const testSignInOrigins: Record<string, string> =
  testOrigin && cfg.testSignInOrigins && typeof cfg.testSignInOrigins === 'object'
    ? Object.fromEntries(Object.entries(cfg.testSignInOrigins as Record<string, unknown>).flatMap(([k, v]) => (originOf(v) ? [[k, originOf(v)!]] : [])))
    : {};

const host = new BrowserHost({
  link,
  name: site?.hostname ?? 'site',
  extensionSrc: join(import.meta.dir, 'extension'),
  startUrl: start ?? 'about:blank',
  origins: site ? sitePatterns(site) : [],
  testOrigin,
  signIn: signInConfig(testSignInOrigins),
  onTabs: () => status(),
  onChange: () => status(),
  onMessage: (m) => {
    if (signIns.onMessage(m)) status();
  },
});

/** "Continue with Google" on the site: the chooser, and the manager's relay to the account you pick. */
const signIns = new SignInAsker({ bridge: host.bridge, ask: (what, input, ms) => link.ask(what, input, ms), log, onChange: () => status() });

/** The `browser` interface (docs/browser.md): its own tabs on the site, one call at a time. */
const browserOps = new BrowserOps({ host, log, busy: () => null });

// ------------------------------------------------------------------- status
let lastSent = '';
function status(force = false) {
  const base = host.baseState();
  const s = !site
    ? { status: 'error', attention: { kind: 'unknown', message: 'This account has no https address to open: set its Address', liveView: false } }
    : (base ?? { status: 'online', attention: null });
  const pending = signIns.pending;
  const page = host.activeTab?.url ?? null;
  const layers = [
    ...host.layers(),
    { name: 'site', state: site ? 'ok' : 'failed', note: site ? site.hostname : 'no address' },
    ...(pending ? [{ name: 'sign-in', state: 'waiting', note: 'a sign-in with another account here is under way (its chooser is in the live view)' }] : []),
  ];
  const details = {
    display: host.liveView ? `:${host.display}` : null,
    site: site?.origin ?? null,
    page,
    extensionAttached: host.attached,
    signInSince: pending ? new Date(pending).toISOString() : null,
    appTabs: browserOps.inUse(),
  };
  const ev = { t: 'status', status: s.status, attention: s.attention, liveView: host.liveView, details, layers };
  const j = JSON.stringify(ev);
  if (host.attached) link.sleep({ busy: pending ? 'a sign-in' : browserOps.inUse(), wakeAt: null });
  if (j === lastSent && !force) return;
  lastSent = j;
  link.emit(ev);
}

async function onCommand(cmd: Command): Promise<unknown> {
  const b = browserOps.handle(cmd);
  if (b) return b;
  throw new StatusError(`site has no operation "${cmd.t}"`, 400);
}

if (!site) {
  log('error', 'no https address in the config (url): nothing to open');
  status(true);
} else {
  log('info', `opening ${site.hostname}`);
  host.start().then(
    (ok) => {
      if (!ok) status(true);
    },
    (e) => {
      log('error', 'boot failed', String((e as Error)?.message ?? e));
      void host.stop().then(() => process.exit(1));
    },
  );
}
