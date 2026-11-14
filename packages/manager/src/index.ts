/** The manager as a library: main.ts runs it, tests make one on a temp dir and port. */
import { join, resolve } from 'node:path';
import { Approvers } from './approvers.ts';
import { errorBlocks, ErrorLog } from './errors.ts';
import { Store } from './db.ts';
import { Http } from './http.ts';
import { type Kind, loadKinds } from './kinds.ts';
import { type NoticeTimes, Notices, NOTICES_KIND, noticesKind } from './notices.ts';
import { providers as factories, type Provider } from './providers/index.ts';
import { Router } from './router.ts';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { procAlive, procStat } from './procs.ts';
import { acquireManagerLock, chooseLaunch, type CodeRestarts, type Launch, releaseManagerLock, Supervisor } from './supervisor.ts';
import { NdjsonFile, setTraceSink, StallWatch } from './trace.ts';

export interface ManagerOpts {
  dataDir: string;
  port: number;
  hostname?: string;
  /** This repo: extractors/ is read from here. */
  repoRoot?: string;
  webDist?: string;
  publicUrl?: string;
  /** Kinds to use instead of extractors/ (tests). */
  kinds?: Map<string, Kind>;
  /** Start the enabled accounts' extractors. Default true. */
  startAccounts?: boolean;
  /** Tests only: the page and its API answer without a login. Never set by main.ts. */
  openPage?: boolean;
  /** Tests only: an approver's push endpoint may be plain http on this machine (a fake push server). */
  approverPushHttp?: boolean;
  /** Tests only: how long an approver request waits for its device (3 minutes). */
  approverRequestMs?: number;
  /**
   * Write every call's span (and the extractors' spans under them) to <data>/traces/manager.trace.ndjson, and every
   * hold of the event loop of 200 ms or more to <data>/traces/event-loop-stalls.ndjson (trace.ts). main.ts sets it.
   */
  trace?: boolean;
  /**
   * Write the manager's errors (its uncaught exceptions and rejections, extractors that crash) to
   * <data>/traces/errors.ndjson (errors.ts), the file the bugwatch extractor reads. main.ts sets it.
   */
  errors?: boolean;
  /** Tests only: the manager's notices' hold times, debounce and sweep (notices.ts NOTICE_TIMES). */
  noticeTimes?: Partial<NoticeTimes>;
  /**
   * How extractors are started (supervisor.ts Launch, docs/supervisor.md): `scope` and `detached` ones outlive the
   * manager when it stops with `leaveExtractors`, and the next manager adopts them. Default `child`; main.ts `auto`.
   */
  launch?: Launch | 'auto';
  /** Tests only: the fingerprint of a kind's code (default: fingerprint.ts over the repo). */
  fingerprint?: (kind: Kind) => string;
  /** Tests only: the pause between restarts of adopted extractors whose code changed (20 s). */
  restartPauseMs?: number;
  /** Tests only: how long an adopted extractor has to connect (60 s). */
  adoptConnectMs?: number;
  /** Tests only: what a `scope` launch goes through instead of systemd-run. */
  systemdRun?: string;
  /** Tests only: how long a surviving extractor waits for a manager before it ends itself (1800 s). */
  managerGoneExitS?: number;
}

/** What a manager that goes on a restart leaves the next one (docs/supervisor.md "Handing over"). */
export const HANDOVER = 'handover.json';
/** A handover older than this is not trusted: the extractors it speaks of have moved on (or the restart failed). */
const HANDOVER_MAX_AGE_MS = 5 * 60_000;
interface Handover {
  v: 1;
  writer: 'dither-accounts';
  /** The manager that wrote it: its pid and start (procs.ts), its release, its data directory. */
  pid: number;
  start: string | null;
  release: string;
  dataDir: string;
  at: string;
  /** Extractors that said they hold their events from then on: nothing of theirs was lost. */
  holding: string[];
  held: Record<string, { frames: { account: string; data: string }[]; dropped: Record<string, number> }>;
}

export interface Manager {
  store: Store;
  router: Router;
  sup: Supervisor;
  http: Http;
  approvers: Approvers;
  notices: Notices;
  /** The error file, when `errors` is on (main.ts installs the process handlers on it). */
  errors: ErrorLog | null;
  kinds: Map<string, Kind>;
  providers: Provider[];
  url: string;
  /** The systemd user service this manager is the main process of, or null (procs.ts ownService). */
  service: string | null;
  /**
   * Stops the manager. With `leaveExtractors`, extractors that can outlive it are left running for the next manager
   * to adopt (main.ts on SIGTERM: a restart keeps every session); without it every extractor stops.
   */
  stop(o?: { leaveExtractors?: boolean }): Promise<void>;
}

export async function createManager(o: ManagerOpts): Promise<Manager> {
  const repoRoot = o.repoRoot ?? resolve(import.meta.dir, '../../..');
  if (!existsSync(o.dataDir)) mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  // One manager per data directory: a second would adopt (and stop) the first one's extractors.
  const other = acquireManagerLock(o.dataDir);
  if (other) throw new Error(other);
  const traceFile = o.trace ? new NdjsonFile(join(o.dataDir, 'traces/manager.trace.ndjson')) : null;
  const stallFile = o.trace ? new NdjsonFile(join(o.dataDir, 'traces/event-loop-stalls.ndjson'), { maxBytes: 2 * 1024 * 1024, keep: 3 }) : null;
  if (traceFile) setTraceSink(traceFile.push);
  const errors = o.errors ? new ErrorLog(join(o.dataDir, 'traces/errors.ndjson'), { root: repoRoot }) : null;
  const stalls = stallFile ? new StallWatch({ record: stallFile.push }).begin() : null;
  // The extractors' kinds, and the manager's own notices (notices.ts), which no extractor runs.
  const kinds = new Map(o.kinds ?? (await loadKinds(repoRoot)));
  kinds.set(NOTICES_KIND, noticesKind());
  const store = new Store(join(o.dataDir, 'accounts.sqlite'));
  let router!: Router;
  let http!: Http;
  let notices: Notices | undefined;
  const publicUrl = (o.publicUrl ?? `http://localhost:${o.port}`).replace(/\/$/, '');
  const approvers = new Approvers(store, { dataDir: o.dataDir, publicUrl, pushHttp: o.approverPushHttp === true, requestMs: o.approverRequestMs, onChange: () => router?.accountsChanged(), count: (account, op, outcome) => router?.count('approver', account, op, outcome), onNoDevice: (account, rpId, op) => notices?.noDevice(account, rpId, op) });
  const launch = chooseLaunch(o.launch ?? 'child');
  let handoverNow: Handover | null = null;
  const resumedOnce = new Set<string>();
  const sup = new Supervisor(store, kinds, {
    extractorUrl: () => `ws://127.0.0.1:${http.server.port}/extractor`,
    repoRoot,
    dataDir: o.dataDir,
    launch: launch.launch,
    fingerprint: o.fingerprint,
    restartPauseMs: o.restartPauseMs,
    adoptConnectMs: o.adoptConnectMs,
    systemdRun: o.systemdRun,
    managerGoneExitS: o.managerGoneExitS,
    onEvent: (id, ev) => {
      router.event(id, ev);
      if (ev.t === 'status') notices?.poke();
    },
    onChange: () => {
      router?.accountsChanged();
      notices?.poke();
    },
    onCrash: (id) => notices?.crashed(id),
    // An extractor that crashed: its last error and frames from its stderr, never its other output.
    onFailedExit: (id, kind, exit) => {
      const block = errorBlocks(exit.stderr, repoRoot).at(-1);
      const extra = { kind, account: id, code: exit.code, signal: exit.signal };
      const where = `extractor ${kind}`;
      if (block) errors?.record({ source: 'uncaught', where, name: block.name, message: block.message, stack: block.frames, extra });
      else errors?.record({ source: 'uncaught', where, name: 'Exit', message: exit.signal ? `ended by signal ${exit.signal}` : `exited with code ${exit.code}`, extra });
    },
    onExit: (id) => router?.processGone(id),
    // An adopted extractor back after a handover that did not name it: a gap only if it says it did not hold its events.
    // Only its first return counts: a later blip of its socket, with this manager up all along, loses nothing.
    onResumed: (id, held) => {
      if (resumedOnce.has(id)) return;
      resumedOnce.add(id);
      if (!held && handoverNow && !handoverNow.holding?.includes(id)) router.markGap(id);
    },
    // The approver's questions, for kinds that hold passkeys; the manager names the account itself.
    onAsk: async (id, what, input) => {
      const a = store.account(id);
      if (!a || !kinds.get(a.kind)?.passkeys) throw new Error('this account holds no passkeys');
      if (what === 'approver.request') return approvers.request(a, input);
      throw new Error(`the manager answers no "${what}"`);
    },
  });
  // An app that hears of a gap restarts the account: that start must not trust what the extractor kept (DITHER_RESYNC).
  router = new Router(store, kinds, sup, { dataDir: o.dataDir, onGap: (id) => sup.markResync(id) });
  // Links to an account's page only when the page has an address of its own (localhost is not one a phone can open).
  const pageUrl = /^https?:\/\/(localhost|127\.[\d.]+|\[::1\])(:\d+)?$/.test(publicUrl) ? null : publicUrl;
  notices = new Notices(store, router, sup, { dataDir: o.dataDir, publicUrl: pageUrl, times: o.noticeTimes });
  notices.start();
  const providers = factories.map((f) => f({ store, router, sup, kinds, dataDir: o.dataDir, publicUrl }));
  http = new Http(store, kinds, sup, router, providers, {
    dataDir: o.dataDir,
    port: o.port,
    hostname: o.hostname ?? '127.0.0.1',
    webDist: o.webDist ?? join(repoRoot, 'packages/manager/web/dist'),
    publicUrl,
    startedAt: Date.now(),
    openPage: o.openPage === true,
  }, approvers);
  // What the manager before handed over (a restart): its held events first, before anything new comes.
  const handover = takeHandover(o.dataDir);
  if (handover) router.restoreHeld(handover.held ?? {});
  handoverNow = handover;
  http.notices = notices;
  http.codeRestarts = () => sup.codeRestarts();
  http.start();
  if (o.startAccounts !== false) {
    sup.startAll();
    // An adopted extractor whose events the manager before may have lost: apps hear of a gap and start it over.
    // Without a handover (the manager before crashed) that is every adopted one; with one, an extractor that says on
    // its return that it did not hold its events (onResumed).
    if (!handover) for (const id of sup.adopted()) router.markGap(id);
  }
  return {
    store,
    router,
    sup,
    http,
    approvers,
    notices,
    errors,
    kinds,
    providers,
    url: `http://127.0.0.1:${http.server.port}`,
    service: launch.unit,
    async stop(so = {}) {
      for (const p of providers) p.stop?.();
      notices!.stop();
      const { holding } = await sup.stopAll({ leave: so.leaveExtractors === true });
      // What apps have not had yet: sent now, and what waits for absent ones goes to the next manager.
      router.flushNow();
      if (so.leaveExtractors) writeHandover(o.dataDir, { v: 1, writer: 'dither-accounts', pid: process.pid, start: procStat(process.pid)?.start ?? null, release: realOr(repoRoot), dataDir: realOr(o.dataDir), at: new Date().toISOString(), holding, held: router.heldForHandover() });
      releaseManagerLock(o.dataDir);
      approvers.stop();
      router.stop();
      http.stop();
      store.db.close();
      stalls?.stop();
      if (traceFile) setTraceSink(null);
      traceFile?.close();
      stallFile?.close();
      errors?.close();
    },
  };
}

function writeHandover(dataDir: string, h: Handover) {
  const p = join(dataDir, HANDOVER);
  try {
    writeFileSync(`${p}.tmp`, JSON.stringify(h), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  } catch (e) {
    console.error(`could not write ${HANDOVER}: ${(e as Error).message}`);
  }
}

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The handover an earlier manager left, read once (it holds message events, so it does not stay on disk; nor does a
 * half-written one). Only one written by a manager of this data directory, by this user, a few minutes ago at most,
 * whose writer has ended; anything else is set aside as if there were none (apps then hear of gaps).
 */
function takeHandover(dataDir: string): Handover | null {
  const p = join(dataDir, HANDOVER);
  const drop = (f: string) => {
    try {
      unlinkSync(f);
    } catch {}
  };
  drop(`${p}.tmp`);
  if (!existsSync(p)) return null;
  try {
    const st = statSync(p);
    const h = JSON.parse(readFileSync(p, 'utf8')) as Handover;
    const why =
      st.uid !== process.getuid?.()
        ? 'not written by this user'
        : h?.v !== 1 || h.writer !== 'dither-accounts'
          ? 'not a handover'
          : h.dataDir !== realOr(dataDir)
            ? 'from another data directory'
            : !(Date.now() - Date.parse(h.at) < HANDOVER_MAX_AGE_MS)
              ? `older than ${HANDOVER_MAX_AGE_MS / 60_000} minutes`
              : typeof h.pid === 'number' && h.pid !== process.pid && procAlive(h.pid, h.start ?? undefined)
                ? 'its writer still runs'
                : null;
    if (why) {
      console.error(`${HANDOVER} set aside: ${why}`);
      return null;
    }
    return h;
  } catch (e) {
    console.error(`${HANDOVER} set aside: ${(e as Error).message}`);
    return null;
  } finally {
    drop(p);
  }
}

export type { CodeRestarts };
export type { Kind, Manifest } from './kinds.ts';
export { kindOf, loadKinds } from './kinds.ts';
export { acquireLock, releaseLock, LOCK, type Launch } from './supervisor.ts';
