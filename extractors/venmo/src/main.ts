/**
 * The venmo extractor (docs/venmo.md): Venmo's statement CSVs, byte for byte what dither-finance's connectors/venmo.py
 * wrote into data/raw/venmo, as `statements` files. A sandboxed browser (statements-common/tabs.ts: Xvfb, an ordinary
 * Chromium with the account's profile and an extension, x11vnc for the live view; no CDP, no automation) where you
 * sign in by hand; the extension opens /statement in a background tab, reads Venmo's profileId from the page's URL
 * (none: signed out, the pull skips) and makes the request Venmo's own "Download CSV" makes, from that page.
 *
 * Venmo ends a session after ~30 idle minutes, so a pull starts by itself right after you sign in in the live view
 * (when the last one that found you signed in is over 12 hours old); the daily pull skips quietly when signed out.
 *
 * state.json (venmo.ts VenmoState) replaces venmo.py's re-reading of data/raw/venmo: seeded once by seed.ts.
 * Config: { pullAt?, jitterMinutes?, schedule?, nagAfterDays? (7), autoPullHours? (12), testOrigin?, paceScale?,
 * noSandbox? }. Logs ranges, counts and statuses: never an amount, a balance, a name or a note.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { sha256hex, StatementsRunner, writeWhole } from '@dither-accounts/statements-common';
import { BrowserHost, sleep } from '@dither-accounts/statements-common/tabs';
import { pageKind, type PageKind, signedInLayer, state as statusOf } from './status.ts';
import { activity, pullStatements, statementBytes, type VenmoState } from './venmo.ts';

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'venmo', version: '1', interfaces: ['statements'], startedAt: STARTED, capabilities: ['liveView'] });
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
const appOrigin = testOrigin ?? 'https://account.venmo.com';
const scale = Math.max(0, Math.min(1, Number(cfg.paceScale ?? 1)));
const nagAfterDays = Math.max(1, Number(cfg.nagAfterDays) || 7);
const autoPullMs = Math.max(0, Number(cfg.autoPullHours ?? 12)) * 3600_000;
/** On the app this long before a sign-in counts (it may still redirect to sign-in). */
const SETTLE_MS = 4000;
/** One automatic pull per this long at most, even when the page and Venmo disagree about being signed in. */
const AUTO_RETRY_MS = 10 * 60_000;

// -------------------------------------------------------------------- state
const stateFile = join(link.accountDir, 'state.json');
function loadState(): VenmoState {
  try {
    if (existsSync(stateFile)) {
      const s = JSON.parse(readFileSync(stateFile, 'utf8'));
      return { ranges: s.ranges && typeof s.ranges === 'object' ? s.ranges : {}, ...s };
    }
  } catch (e) {
    log('warn', 'state.json is unreadable; starting from nothing (the next pull backfills)', String((e as Error).message));
  }
  return { ranges: {} };
}
const saveState = (s: VenmoState) => writeWhole(stateFile, JSON.stringify(s, null, 1));
let st = loadState();

/** Tabs this extractor opened (its /statement tab): not you signing in. */
const ownTabs = new Set<number>();
let kind: PageKind = 'none';
let page: string | null = null;
let appSince = 0;
/** Evidence about the session: the last time it was seen signed in, and signed out. */
let lastIn = 0;
let lastOut = 0;
let lastAuto = 0;
let runnerStarted = false;

const host = new BrowserHost({
  link,
  extensionSrc: join(import.meta.dir, 'extension'),
  startUrl: `${appOrigin}/`,
  testOrigin,
  onTabs,
  onChange: () => {
    if (host.attached && !runnerStarted) {
      runnerStarted = true;
      runner.start();
    }
    status();
  },
});

function signedIn() {
  return lastIn > lastOut && Date.now() - lastIn < 30 * 60_000;
}

function onTabs() {
  const theirs = host.tabs.filter((t) => !ownTabs.has(t.id));
  const active = theirs.find((t) => t.active) ?? theirs[0] ?? null;
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

/** On the app for SETTLE_MS: you signed in (or were). Pull now unless one found you signed in within 12 hours. */
function tick() {
  const now = Date.now();
  if (kind === 'app' && appSince && now - appSince >= SETTLE_MS) {
    if (lastIn < appSince) {
      lastIn = now;
      log('info', 'Venmo is open in the live view');
      status();
    }
    const last = st.lastSignedInPull ?? 0;
    if (host.attached && !runner.pulling && now - last > autoPullMs && now - lastAuto > AUTO_RETRY_MS) {
      lastAuto = now;
      const r = runner.refresh({}, 'sign-in');
      log('info', r.started ? 'signed in: pulling now' : `signed in, but no pull: ${r.reason}`);
    }
  }
  status();
}

// --------------------------------------------------------------------- pull
async function pull(opts: { since?: number; full?: boolean }): Promise<{ saved: number; skipped?: 'signed-out' | 'unchanged' }> {
  if (!host.attached) throw new Error('the sandbox browser is not up');
  const tab = await host.open(`${appOrigin}/statement`, { timeout: 45_000 });
  ownTabs.add(tab.tabId);
  try {
    // venmo.py read the URL 3 s after the page loaded; Venmo's app puts the profileId in it by then. (Tests pace
    // faster, and then look again until those 3 s are up.)
    const t0 = Date.now();
    await sleep(3000 * scale);
    let pid = '';
    for (;;) {
      const info = await host.get(tab.tabId);
      try {
        pid = new URL(info.url).searchParams.get('profileId') ?? '';
      } catch {}
      if (pid || Date.now() - t0 >= 3000) break;
      await sleep(250);
    }
    if (!pid) {
      lastOut = Date.now();
      log('info', 'skipped: signed out of Venmo');
      return { saved: 0, skipped: 'signed-out' };
    }
    lastIn = Date.now();
    const fetchRange = async (r: { start: string; end: string }) => {
      const res = await host.exec<[number, string]>(tab.tabId, 'statement', [r.start, r.end, pid], 'MAIN', 120_000);
      if (!Array.isArray(res) || typeof res[0] !== 'number' || typeof res[1] !== 'string') throw new Error(`statement ${r.start}..${r.end}: no answer from the page`);
      return res;
    };
    const r = await pullStatements(st, opts, {
      fetch: fetchRange,
      save: (name, bytes, rg) => {
        const from = new Date(`${rg.start}T00:00:00`).getTime();
        const to = new Date(`${rg.end}T00:00:00`).getTime() + 24 * 3600_000;
        runner.spool.add(name, 'venmo', bytes, { coverage: { from, to }, mime: 'text/csv' });
        saveState(st);
      },
      sleep: async (ms) => void (await sleep(ms * scale)),
      now: () => new Date(),
      log: (m) => log('info', m),
    });
    // Seeded: fetch one closed range dither-finance already has and compare the bytes (once; nothing is saved).
    if (st.check) {
      try {
        const c = st.check;
        const [start, end] = c.range.split('_');
        await sleep(1500 * scale);
        const [status, body] = await fetchRange({ start, end });
        const bytes = statementBytes(status, body, { start, end });
        const text = new TextDecoder().decode(bytes);
        const sha = sha256hex(bytes);
        st.checked = {
          range: c.range,
          at: Date.now(),
          same: sha === c.sha256,
          oldSha16: c.sha256.slice(0, 16),
          newSha16: sha.slice(0, 16),
          oldRows: c.rows,
          newRows: activity(text),
          oldSize: c.size,
          newSize: bytes.length,
        };
        st.check = null;
        log(st.checked.same ? 'info' : 'warn', `seed check: ${c.range} ${st.checked.same ? 'is byte for byte the file dither-finance has' : 'differs from the file dither-finance has'}`, {
          oldSha16: st.checked.oldSha16,
          newSha16: st.checked.newSha16,
          rows: [st.checked.oldRows, st.checked.newRows],
        });
      } catch (e) {
        log('warn', 'seed check failed; it is tried again on the next pull', String((e as Error).message).slice(0, 200));
      }
    }
    st.lastSignedInPull = Date.now();
    saveState(st);
    log('info', `${r.saved} statement file(s) saved (${r.requests} request(s))`);
    return { saved: r.saved, ...(r.saved ? {} : { skipped: 'unchanged' as const }) };
  } finally {
    ownTabs.delete(tab.tabId);
    await host.close(tab.tabId).catch(() => {});
  }
}

const runner = new StatementsRunner({
  link,
  pull: (o) => pull({ since: Number.isInteger(o.since) ? o.since : undefined, full: !!o.full }),
  accounts: () => [{ id: 'venmo', name: 'Venmo', institution: 'Venmo', currency: 'USD', kind: 'payments' }],
  blocked: () => (host.attached ? null : 'the sandbox browser is not up yet'),
  onChange: () => status(),
});

// ------------------------------------------------------------------- status
let lastSent = '';
function status(force = false) {
  const base = host.baseState();
  const v = { signedIn: signedIn(), lastSignedInPull: st.lastSignedInPull ?? null, nagAfterDays, now: Date.now(), page, kind };
  const s = base ?? statusOf(v);
  const details = {
    display: host.liveView ? `:${host.display}` : null,
    page,
    pageKind: kind,
    extensionAttached: host.attached,
    signedIn: v.signedIn,
    lastSignedInPull: st.lastSignedInPull ? new Date(st.lastSignedInPull).toISOString() : null,
    rangesKnown: Object.keys(st.ranges).length,
    backfilled: !!st.backfilled,
    seedCheck: st.check ? `pending: ${st.check.range}` : st.checked ? `${st.checked.range}: ${st.checked.same ? 'same bytes' : 'different bytes'} (rows ${st.checked.oldRows} → ${st.checked.newRows})` : null,
    ...runner.details(),
  };
  const layers = [...host.layers(), signedInLayer(v), runner.pullLayer()];
  if (runner.st.needs && !base && s.status === 'online') Object.assign(s, { status: 'attention', attention: { kind: runner.st.needs.kind, message: runner.st.needs.message, liveView: true } });
  const ev = { t: 'status', status: s.status, attention: s.attention, liveView: host.liveView, details, layers };
  const j = JSON.stringify(ev);
  if (j === lastSent && !force) return;
  lastSent = j;
  link.emit(ev);
}

async function onCommand(cmd: Command): Promise<unknown> {
  const r = runner.handle(cmd);
  if (r !== undefined) return r;
  throw new StatusError(`venmo has no operation "${cmd.t}"`, 400);
}

host.start().then(
  (ok) => {
    if (ok) setInterval(tick, 2000);
  },
  (e) => {
    log('error', 'boot failed', String((e as Error)?.message ?? e));
    void host.stop().then(() => process.exit(1));
  },
);
