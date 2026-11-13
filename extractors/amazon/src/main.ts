/**
 * The amazon extractor (docs/amazon.md): your Amazon order history, byte for byte the amazon-<stamp>.json files
 * dither-finance's connectors/amazon.py wrote into data/raw/amazon, as `statements` files. A sandboxed browser
 * (statements-common/tabs.ts: Xvfb, an ordinary Chromium with the account's profile and an extension, x11vnc for the
 * live view; no CDP, no automation) where Amazon stays signed in. A pull drives one background tab at amazon.py's
 * pace (3–6 s between list pages, 4–8 s between detail pages, at most 25 details a run): Your Orders by year, then
 * order details, read by the extension (page.js) and parsed here (amazon.ts).
 *
 * When Amazon asks for the password again, the stored one (secret.json: email, password, optional totpSecret; handed
 * to the page one field at a time) answers, as amazon_auth.py did. A captcha, a robot check, the "I am human"
 * checkpoint or a code by text stops the pull: what it read so far is written, as amazon.py did, the tab is brought
 * forward in the live view, and the account holds every pull (an attention) until the live view shows it cleared.
 *
 * state.json (amazon.ts AmazonState) replaces amazon.py's re-reading of data/raw/amazon: seeded once by seed.ts.
 * Config: { pullAt?, jitterMinutes?, schedule?, details? (25), testOrigin?, paceScale?, noSandbox? }. Logs counts,
 * years, pages and statuses: never an order id in full, an item, a name, an amount or the password.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { NeedsYou, StatementsRunner, writeWhole } from '@dither-accounts/statements-common';
import { BrowserHost, pause, sleep } from '@dither-accounts/statements-common/tabs';
import { type AmazonState, fileBody, learn, NeedsYouHere, pullOrders, type RawDetails, type RawList, stampUtc } from './amazon.ts';
import { type Cred, ensure, NEEDS, type Probe } from './auth.ts';
import { signedInLayer, state as statusOf } from './status.ts';

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'amazon', version: '1', interfaces: ['statements'], startedAt: STARTED, capabilities: ['liveView'] });
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
const BASE = testOrigin ?? 'https://www.amazon.com';
const scale = Math.max(0, Math.min(1, Number(cfg.paceScale ?? 1)));
const maxDetails = Math.max(0, Math.min(100, Number.isFinite(Number(cfg.details)) ? Number(cfg.details) : 25));
const cred = () => link.secret<Cred>();

// -------------------------------------------------------------------- state
const stateFile = join(link.accountDir, 'state.json');
function loadState(): AmazonState {
  try {
    if (existsSync(stateFile)) {
      const s = JSON.parse(readFileSync(stateFile, 'utf8'));
      return { ...s, orders: s.orders && typeof s.orders === 'object' ? s.orders : {} };
    }
  } catch (e) {
    log('warn', 'state.json is unreadable; starting from nothing (the next pull backfills)', String((e as Error).message));
  }
  return { orders: {} };
}
const saveState = () => writeWhole(stateFile, JSON.stringify(st));
const st = loadState();

let crawlTab: number | null = null;
let navSignedIn: boolean | null = null;
let page: string | null = null;
let runnerStarted = false;
let probeTimer: Timer | undefined;

const host = new BrowserHost({
  link,
  extensionSrc: join(import.meta.dir, 'extension'),
  startUrl: `${BASE}/`,
  testOrigin,
  onTabs: () => {
    const a = host.activeTab;
    page = a?.url || null;
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => void look(), 2500);
  },
  onChange: () => {
    if (host.attached && !runnerStarted) {
      runnerStarted = true;
      runner.start();
    }
    status();
  },
});

const onAmazon = (url: string | null) => {
  try {
    return !!url && new URL(url).origin === BASE;
  } catch {
    return false;
  }
};

/** Look at the tab you see: is Amazon's header signed in, and is a held pull's challenge gone? */
async function look() {
  const a = host.activeTab;
  if (!host.attached || !a || !onAmazon(a.url) || a.loading || runner.pulling) return;
  let p: Probe | null = null;
  try {
    p = await host.exec<Probe>(a.id, 'probe', [], 'ISOLATED', 15_000);
  } catch {
    return;
  }
  if (!p) return;
  if (p.signedIn !== null) navSignedIn = p.signedIn;
  if (st.hold) {
    const clear = !p.url.includes('/ap/') && !p.url.includes('/checkpoint/') && !p.captcha && !p.robot && !p.human && (st.hold.kind !== 'login' || p.signedIn !== false);
    if (clear) {
      log('info', 'the live view shows Amazon past what stopped the pull; pulls go on');
      st.hold = null;
      saveState();
    }
  }
  status();
}

// --------------------------------------------------------------------- pull
async function pull(opts: { full?: boolean; details?: number }): Promise<{ saved: number; skipped?: 'unchanged' }> {
  if (!host.attached) throw new Error('the sandbox browser is not up');
  const tab = (await host.open('about:blank')).tabId;
  crawlTab = tab;
  let keep = false;
  const probe = async (): Promise<Probe | null> => {
    try {
      return await host.exec<Probe>(tab, 'probe', [], 'ISOLATED', 20_000);
    } catch {
      return null;
    }
  };
  const visit = async (target: string) => {
    await host.go(tab, target, 60_000);
    await ensure({
      url: async () => (await host.get(tab)).url,
      probe,
      step: (s, v) => host.exec(tab, 'signInStep', [s, v], 'ISOLATED', 20_000),
      sleep: (ms) => sleep(ms * Math.max(scale, 0.25)),
      cred,
      log: (m) => log('info', m),
    });
    const url = (await host.get(tab)).url;
    const p = (await probe()) ?? (await sleep(1000).then(probe));
    if (url.includes('/checkpoint/') || p?.human) throw new NeedsYouHere(NEEDS.human, 'human');
    // Beyond amazon.py, which read such a page as "no orders": Amazon's robot check stops the pull too.
    if (p?.robot || (p?.captcha && !url.includes('/ap/'))) throw new NeedsYouHere(NEEDS.robot, 'captcha');
    await sleep(1500 * scale);
  };
  try {
    const r = await pullOrders(st, { backfill: !!opts.full, details: Number.isInteger(opts.details) ? opts.details : maxDetails }, {
      base: BASE,
      visit,
      list: (n) => host.exec<RawList>(tab, 'orderList', [n], 'ISOLATED', 30_000),
      details: () => host.exec<RawDetails>(tab, 'orderDetails', [], 'ISOLATED', 30_000),
      pause: (lo, hi) => pause(lo * scale, hi * scale),
      now: () => new Date(),
      log: (m) => log('info', m),
    });
    let saved = 0;
    if (r.orders.size) {
      const stamp = stampUtc(new Date());
      runner.spool.add(`amazon-${stamp}.json`, 'amazon', fileBody(stamp, r.orders), { mime: 'application/json' });
      learn(st, r.orders.entries().map(([, o]) => o));
      saved = 1;
      log('info', `${r.orders.size} order(s) written`);
    }
    if (r.needs) {
      st.hold = { kind: r.needs.kind, message: r.needs.message, since: Date.now() };
      keep = true;
      saveState();
      log('warn', `stopped: ${r.needs.message}`);
      await host.activate(tab).catch(() => {});
      throw new NeedsYou(r.needs.message, r.needs.kind);
    }
    saveState();
    return saved ? { saved } : { saved, skipped: 'unchanged' };
  } finally {
    crawlTab = null;
    if (!keep) await host.close(tab).catch(() => {});
  }
}

const runner = new StatementsRunner({
  link,
  pull: (o) => pull({ full: !!o.full, details: o.details }),
  accounts: () => [{ id: 'amazon', name: 'Amazon orders', institution: 'Amazon', currency: 'USD', kind: 'orders' }],
  blocked: () => {
    if (!host.attached) return 'the sandbox browser is not up yet';
    if (st.hold) return `Amazon is waiting for you in the live view: ${st.hold.message}`;
    return null;
  },
  onChange: () => status(),
});

// ------------------------------------------------------------------- status
let lastSent = '';
function status(force = false) {
  const base = host.baseState();
  const v = { hold: st.hold ?? null, navSignedIn, hasPassword: !!cred().password, page };
  const s = base ?? statusOf(v);
  const known = Object.values(st.orders);
  const details = {
    display: host.liveView ? `:${host.display}` : null,
    page,
    extensionAttached: host.attached,
    signedIn: navSignedIn,
    passwordStored: v.hasPassword,
    authenticatorStored: !!cred().totpSecret,
    ordersKnown: known.length,
    ordersWithDetails: known.filter((o) => o.details).length,
    backfilled: !!st.backfilled,
    held: st.hold ? `${st.hold.kind} since ${new Date(st.hold.since).toISOString()}` : null,
    crawling: crawlTab !== null,
    ...runner.details(),
  };
  const layers = [...host.layers(), signedInLayer(v), runner.pullLayer()];
  const ev = { t: 'status', status: s.status, attention: s.attention, liveView: host.liveView, details, layers };
  const j = JSON.stringify(ev);
  if (j === lastSent && !force) return;
  lastSent = j;
  link.emit(ev);
}

async function onCommand(cmd: Command): Promise<unknown> {
  const r = runner.handle(cmd);
  if (r !== undefined) return r;
  throw new StatusError(`amazon has no operation "${cmd.t}"`, 400);
}

host.start().then(
  (ok) => {
    if (ok) setInterval(() => void look(), 20_000);
  },
  (e) => {
    log('error', 'boot failed', String((e as Error)?.message ?? e));
    void host.stop().then(() => process.exit(1));
  },
);
